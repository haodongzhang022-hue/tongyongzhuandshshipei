#!/usr/bin/env node
/**
 * DSH 适配中台 CLI。
 *
 * 子命令：
 * - `detect`   探测本地宿主版本线（需宿主实例；无宿主时报 unknown，不报错）
 * - `matrix`   打印通道矩阵（稳定版 / 开发版 / 历史线）
 * - `verify`   多通道验收（`--channel stable|dev|legacy|all`，`all` = 三通道全跑）
 * - `watch`    上游变更侦测（dist-tag 漂移 + 契约指纹 diff + **自动归因影响面**）；
 *              `--markdown` 出人类视图；`--json` 落盘（含 triage）
 * - `report`   验收 + 二级信息输出（`--markdown` 出人类视图；`--channel` 与 verify 同义）
 * - `cache`    宿主依赖缓存维护（默认保留当前三通道钉版指纹，其余历史残留清理）
 *
 * 契约（退出码即信号）：
 * - `verify` / `report`：0 = GREEN；1 = 有失败；2 = 参数/用法错误；3 = 运行时异常
 * - `watch` ：0 = 无漂移；1 = 有漂移；2 = 离线 / 参数错误
 *
 * @module dsh-adapt-hub/cli
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { HUB_ROOT, channelFingerprint, loadChannels, pruneHostCache } from './harness/host.mjs';
import { resolvePlugin, verifyAll, verifyChannel } from './verify/runner.mjs';
import { buildSecondary, toMarkdown } from './report/secondary.mjs';
import { diffContracts, watchUpstream } from './watch/upstream.mjs';
import {
  DEFAULT_SETTLE_HOUR,
  legacySnapshot,
  migrateLegacyLatest,
  periodKey,
  resolveBaseline,
  segmentStore,
  settleSegment,
} from './watch/baseline.mjs';
import { toTriageMarkdown, triageUpstream } from './triage/index.mjs';
import { VERSION } from './version.mjs';

/** 所有可用通道（`all` 的展开结果，与 `.cnb.yml` / `.cnb/web_trigger.yml` 保持同一语义）。 */
export const ALL_CHANNELS = ['stable', 'dev', 'legacy'];

/** 已知布尔开关（其余 `--key value` 视为带值参数）。 */
const BOOLEAN_FLAGS = new Set(['offline', 'markdown', 'help', 'prune-cache', 'dry-run', 'migrate']);

/** 已知带值参数（未知的 `--key` 显式报错，避免拼错参数被静默忽略）。 */
const VALUE_KEYS = new Set(['channel', 'plugin', 'tools', 'json', 'contract-from', 'from', 'mode', 'release', 'at', 'settle-hour']);

/**
 * 解析 `--key value` / `--key=value` / `--flag` 形式的参数。
 *
 * 对未知 token **显式报错**（而不是静默忽略）——静默忽略会悄悄改变语义，
 * 比报错更危险。
 *
 * @param {string[]} argv 参数列表
 * @returns {{_: string[]} & Record<string, string|boolean>} 解析结果
 * @throws {Error} 参数形式不合法时
 */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        if (!key) throw new Error(`参数形式不合法：${token}`);
        if (!VALUE_KEYS.has(key) && !BOOLEAN_FLAGS.has(key)) throw new Error(`未知参数：--${key}`);
        args[key] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      if (!BOOLEAN_FLAGS.has(key) && !VALUE_KEYS.has(key)) throw new Error(`未知参数：--${key}（已知：${[...VALUE_KEYS, ...BOOLEAN_FLAGS].join(', ')}）`);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
      // 带值参数缺值：**显式报错**（历史缺陷：`--channel` 缺值静默跑三通道并 exit 0，
      // `--json` 缺值静默不写文件，`--plugin` 缺值在更深处 TypeError——都改变了语义却没人知道）
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`参数 --${key} 缺少取值（用法：--${key} <value> 或 --${key}=<value>）`);
      }
      args[key] = next; i += 1;
    } else if (token.startsWith('-') && token.length > 1) {
      throw new Error(`未知参数：${token}（本 CLI 只支持 --key value / --key=value / --flag）`);
    } else args._.push(token);
  }
  return args;
}

/**
 * 把 `--channel` 取值展开为通道列表。
 *
 * `all` 与页面按钮（`.cnb/web_trigger.yml` 的「含历史线（+ legacy）」）**同义**：
 * stable + dev + legacy。
 *
 * @param {string|undefined} channel 通道参数
 * @param {string|string[]} [fallback] 未指定时的默认取值（verify = 'all' 三通道；report = ['stable','dev']）
 * @returns {string[]} 通道列表
 * @throws {Error} 通道名未知时
 */
export function resolveChannels(channel, fallback = 'all') {
  const registry = loadChannels(HUB_ROOT);
  const known = Object.keys(registry.channels);
  const value = channel ?? fallback;
  if (value === 'all') return [...ALL_CHANNELS];
  if (Array.isArray(value)) {
    const unknown = value.filter((name) => !known.includes(name));
    if (unknown.length > 0) throw new Error(`未知通道：${unknown.join(',')}（可选：${[...known, 'all'].join('|')}）`);
    return [...value];
  }
  if (!known.includes(value)) {
    throw new Error(`未知通道：${value}（可选：${[...known, 'all'].join('|')}）`);
  }
  return [value];
}

function usage() {
  return [
    `dsh-adapt-hub v${VERSION}`,
    '',
    '用法：',
    '  dsh-adapt matrix                                    # 通道矩阵',
    '  dsh-adapt verify --channel stable|dev|legacy|all     # 验收（all = stable+dev+legacy）',
    '        --plugin <path>  --tools a,b  [--offline] [--json <out>] [--markdown]',
    '  dsh-adapt watch  [--json <out>] [--markdown]         # 上游变更侦测 + 自动归因影响面',
    '  dsh-adapt settle --from <verify.json>                # ★ 结算周期基线（唯一写基线的地方）',
    '        [--mode day|release] [--release <版本标识>] [--at <ISO>] [--settle-hour 10] [--dry-run]',
    '  dsh-adapt baseline [--migrate] [--json <out>]        # 看当前基线链（+ 一次性迁移遗留 latest.json）',
    '  dsh-adapt report --plugin <path> --tools a,b [--channel stable|dev|legacy|all] [--markdown]',
    '  dsh-adapt cache  [--prune-cache]                     # 宿主依赖缓存维护（默认保留当前钉版指纹）',
    '',
    '退出码：verify/report 0=GREEN / 1=失败 / 2=用法错误 / 3=运行时异常；watch 0=无漂移 / 1=漂移 / 2=离线',
  ].join('\n');
}

function cmdMatrix() {
  const registry = loadChannels(HUB_ROOT);
  const rows = Object.entries(registry.channels).map(([name, channel]) => ({
    channel: name,
    label: channel.label,
    line: channel.line,
    npmTag: channel.npmTag,
    flavorExpected: channel.flavorExpected,
    pinnedTools: channel.pins['@deepseek-ai/dsh-tools'],
    intent: channel.intent,
  }));
  console.log(JSON.stringify({ schemaVersion: registry.schemaVersion, updatedAt: registry.updatedAt, channels: rows }, null, 2));
}

/**
 * 解析插件路径：**缺文件属用法错误**（exit 2），与「运行时异常」（exit 3）区分开。
 *
 * @param {string|undefined} plugin 插件路径参数
 * @returns {string} 绝对路径
 * @throws {Error} 带 `usageError` 标记（main 据此给 exit 2）
 */
function resolvePluginArg(plugin) {
  const target = plugin ?? path.join(HUB_ROOT, 'tests/fixtures/demo-plugin.mjs');
  try {
    return resolvePlugin(target);
  } catch (error) {
    const wrapped = new Error(String(error?.message ?? error));
    wrapped.usageError = true;
    throw wrapped;
  }
}

function cmdVerify(args) {
  const pluginPath = resolvePluginArg(args.plugin);
  const expectedTools = String(args.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const channels = resolveChannels(typeof args.channel === 'string' ? args.channel : undefined);
  const report = verifyAll({ pluginPath, expectedTools, channels, offline: Boolean(args.offline) });
  const secondary = buildSecondary(report);
  // 验收后顺手清理历史残留缓存（保留本次三通道钉版指纹）——pruneHostCache 的真实调用点
  const cache = args['prune-cache'] ? pruneHostCache({ keepFingerprints: keepFingerprintsFor() }) : null;

  // 基线**不在这里写**（本版核心改动）：`verify` 每跑一次就改写基线，会让基线自己一直在动
  // ⇒ 上游连续发版时 v1→v2→v3 的累积偏移被**静默吸收**。现在 `verify` 只**读**基线做对比，
  // 写基线只发生在 `settle`（结算）——一天一个基线（默认 10:00 结算）。
  const baseline = resolveBaseline({ hubRoot: HUB_ROOT });
  const drift = diffContracts(
    { contracts: baseline.contracts },
    Object.fromEntries(report.channels.filter((c) => c.ok).map((c) => [c.channel, c.contract])),
  );

  const output = {
    ...report,
    secondary,
    contractDrift: drift,
    cache,
    baseline: {
      // 只读快照：这次对比用的是哪条链、哪个通道取自哪个周期
      mode: 'read-only',
      note: 'verify 不写基线；写基线请用 `dsh-adapt settle`（一天一个基线）',
      chain: baseline.chain,
      perChannel: baseline.perChannel,
      channels: report.channels.filter((c) => c.ok).map((c) => c.channel),
    },
  };
  if (typeof args.json === 'string') {
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), `${JSON.stringify(output, null, 2)}\n`);
  }
  if (args.markdown) console.log(toMarkdown(secondary));
  else console.log(JSON.stringify(output, null, 2));

  process.exit(report.summary.verdict === 'GREEN' ? 0 : 1);
}

/**
 * 查看当前基线链（**只读**）；`--migrate` 把历史遗留 `latest.json` 一次性迁成分片。
 *
 * @param {object} args 已解析参数
 */
function cmdBaseline(args) {
  const migration = args.migrate ? migrateLegacyLatest({ hubRoot: HUB_ROOT }) : null;
  const resolved = resolveBaseline({ hubRoot: HUB_ROOT });
  const store = segmentStore({ hubRoot: HUB_ROOT });
  const output = {
    chain: resolved.chain,
    perChannel: resolved.perChannel,
    channels: Object.keys(resolved.contracts),
    segments: resolved.segments.map((seg) => ({
      periodKey: seg.periodKey,
      mode: seg.mode ?? null,
      orderAt: seg.orderAt ?? null,
      channels: Object.keys(seg.baseline ?? {}),
      candidates: (seg.candidates ?? []).length,
      ignored: seg.ignored ?? [],
    })),
    legacyLatestUsed: resolved.legacyLatest !== null,
    segmentDir: store.dir,
    ...(migration ? { migration } : {}),
  };
  if (typeof args.json === 'string') {
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), `${JSON.stringify(output, null, 2)}\n`);
  }
  if (args.markdown) {
    console.log([
      '## 契约基线链（早 → 晚顺序合并）',
      '',
      `- 链：${resolved.chain.join(' → ') || '（空）'}`,
      // 迁移后 latest.json 仍在磁盘上（作为历史存档），但**已不再参与链** ⇒ 不再告警
      resolved.legacyLatest && !resolved.chain.some((k) => k.startsWith('migrated-'))
        ? '- ⚠️ 仍在使用历史遗留 `latest.json`（跑一次 `baseline --migrate` 迁成周期分片）' : '',
      '',
      '| 周期 | 模式 | 通道 | 候选数 | 被忽略（取最早） |',
      '|---|---|---|---|---|',
      ...resolved.segments.map((seg) => `| ${seg.periodKey} | ${seg.mode ?? '—'} | ${Object.keys(seg.baseline ?? {}).join(', ') || '—'} | ${(seg.candidates ?? []).length} | ${(seg.ignored ?? []).join(', ') || '—'} |`),
    ].filter(Boolean).join('\n'));
  } else console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

/**
 * 结算一个周期的基线（**唯一写基线的地方**）。
 *
 * 语义（issue 口径）：
 * - 默认**一天一个基线**：周期键 = 当天结算点日期（`--settle-hour`，默认 10 点，UTC+8）；
 * - 可切 `--mode release`（`--release <版本标识>`）：**每个上游版本**建立**独自**基线；
 * - 同周期已有基线时**取相对早的那个**（后跑的不覆盖），被忽略的候选记入 `ignored[]`；
 * - 每周期写**独立分片** `registry/contract-snapshots/segments/<key>.json`，**不合并到主线**；
 * - `--dry-run` 只看会写什么，不落盘。
 *
 * 退出码：0 = 已结算（或幂等无变化）；2 = 用法错误；3 = 运行时异常。
 *
 * @param {object} args 已解析参数
 */
function cmdSettle(args) {
  const mode = typeof args.mode === 'string' ? args.mode : 'day';
  const at = typeof args.at === 'string' ? args.at : new Date();
  const key = periodKey({
    mode,
    at,
    release: typeof args.release === 'string' ? args.release : undefined,
    settleHour: typeof args['settle-hour'] === 'string' ? Number(args['settle-hour']) : DEFAULT_SETTLE_HOUR,
  });
  const store = segmentStore({ hubRoot: HUB_ROOT });
  const report = readVerificationReports(args);
  const settled = settleSegment({
    store,
    key,
    dryRun: Boolean(args['dry-run']),
    run: { at, mode, orderAt: at, source: args['from'] ?? null, channels: report.channels },
  });
  const resolved = resolveBaseline({ hubRoot: HUB_ROOT });
  const output = {
    periodKey: key,
    mode,
    dryRun: Boolean(args['dry-run']),
    written: settled.written,
    baselineChannels: Object.keys(settled.baseline ?? {}),
    ignored: settled.ignored,
    firstRunAt: settled.firstRunAt,
    candidates: settled.candidates.length,
    chain: resolved.chain,
    perChannel: resolved.perChannel,
    segmentDir: store.dir,
  };
  if (args.markdown) {
    console.log([
      `## 契约基线结算（${key}）`,
      '',
      `- 模式：${mode}｜链：${resolved.chain.join(' → ') || '（空）'}`,
      `- 本次纳入通道：${Object.keys(settled.baseline ?? {}).join(', ') || '（无有效候选）'}`,
      `- 同周期被忽略的候选（取最早）：${settled.ignored.join(', ') || '无'}`,
      `- 落盘：${settled.written && !args['dry-run'] ? '是' : '否（dry-run 或幂等）'}`,
      `- 分片目录：\`${store.dir}\``,
    ].join('\n'));
  } else console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

/**
 * 读取「本次运行的通道报告」。
 *
 * 结算的输入是**验收报告**（`verify --json` 的产物）而不是重新跑一遍真宿主——
 * 这样结算可以放在 push/PR 之外的时间点（每日 10:00），不必重跑验收。
 *
 * @param {object} args 已解析参数
 * @returns {{channels:object[]}} 通道报告
 */
function readVerificationReports(args) {
  const file = typeof args.from === 'string' ? args.from : null;
  if (!file) return { channels: [] };
  try {
    const report = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
    return { channels: report.channels ?? [] };
  } catch {
    return { channels: [] };
  }
}

async function cmdWatch(args) {
  const report = await watchUpstream({ hubRoot: HUB_ROOT });
  // 自动归因：把「有没有漂移」推到「漂移到哪、影响谁、中台改哪一处、插件要不要动」。
  // 契约漂移用**基线 vs 本次通道契约**对比；本次无验收采集时（纯 watch），仍可按基线 + 失败队列判定。
  const resolved = resolveBaseline({ hubRoot: HUB_ROOT });
  const baseline = Object.keys(resolved.contracts).length > 0 ? resolved.contracts : null;
  // watch 场景没有「本次通道契约」（未跑真宿主），故只对**已在通道报告中回传的契约**做 diff；
  // 若调用方通过 --contract-from 提供了验收报告，则一并纳入（CI 上 watch 与 verify 串联时用）。
  const currentContracts = readContractsFromReport(args['contract-from']);
  const contractDrift = currentContracts ? diffContracts(baseline, currentContracts) : { changed: false, items: [] };
  const triage = triageUpstream({ report, contractDrift });
  const output = { ...report, triage, contractDrift, baselineChain: { chain: resolved.chain, perChannel: resolved.perChannel } };
  if (typeof args.json === 'string') {
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), `${JSON.stringify(output, null, 2)}\n`);
  }
  if (args.markdown) console.log(toTriageMarkdown(triage));
  else console.log(JSON.stringify(output, null, 2));
  process.exit(report.offline ? 2 : triage.hasDrift ? 1 : 0);
}

/**
 * 从验收报告 JSON 里取「每个 ok 通道的契约指纹」（供 watch 做契约漂移 diff）。
 *
 * 为什么需要它：纯 `watch` 只查 dist-tag，拿不到**本次**真实宿主采到的契约；
 * CI 上通常先 `verify --json` 再 `watch`，这时把验收报告喂进来，watch 就能同时给出
 * 「版本漂移」与「契约漂移 + 影响面」，不必再跑一遍真宿主。
 *
 * @param {string|undefined} file 验收报告路径（`verify` 的 `--json` 产物）
 * @returns {object|null} channel → contract；不可用时返回 null（**不猜**）
 */
function readContractsFromReport(file) {
  if (typeof file !== 'string' || !existsSync(file)) return null;
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const contracts = {};
    for (const channel of report.channels ?? []) {
      if (channel?.channel && channel.contract && Object.keys(channel.contract).length > 0) {
        contracts[channel.channel] = channel.contract;
      }
    }
    return Object.keys(contracts).length > 0 ? contracts : null;
  } catch {
    return null;
  }
}

function cmdReport(args) {
  const pluginPath = resolvePluginArg(args.plugin);
  const expectedTools = String(args.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // 通道由 --channel 决定（与 verify 同一解析）；未指定时 report 的默认是 stable+dev
  // （历史缺陷：硬编码 ['stable','dev'] → `report --channel legacy` 被静默忽略）
  const channels = resolveChannels(typeof args.channel === 'string' ? args.channel : undefined, ['stable', 'dev']);
  const report = verifyAll({ pluginPath, expectedTools, channels, offline: Boolean(args.offline) });
  const secondary = buildSecondary(report);
  if (args.markdown) console.log(toMarkdown(secondary));
  else console.log(JSON.stringify(secondary, null, 2));
  process.exit(report.summary.verdict === 'GREEN' ? 0 : 1);
}

/**
 * 计算「当前钉版指纹」清单（供缓存清理保留）。
 *
 * **默认保留 registry 里全部通道的当前指纹**（不是「本次验收的通道」）：
 * 清理的目的是清历史残留版本，不是把没跑的通道缓存删掉——否则
 * `verify --channel stable --prune-cache` 会顺手删掉 dev/legacy 缓存，下次白装一遍。
 *
 * @param {object} [registry] 通道表（默认从 hubRoot 读）
 * @returns {string[]} 形如 `stable-<fingerprint>` 的缓存目录名
 */
export function keepFingerprintsFor(registry = loadChannels(HUB_ROOT)) {
  return Object.entries(registry.channels).map(([name, channel]) => `${name}-${channelFingerprint(channel)}`);
}

/**
 * 宿主依赖缓存维护。
 *
 * 默认：保留当前三通道钉版指纹对应的缓存，清理历史残留（只清缓存目录，不动工作目录）。
 * `--prune-cache` 语义同默认（显式写法，便于 CI 单独调用）。
 *
 * @param {object} _args 已解析参数（当前无额外开关，保留签名以便扩展）
 */
function cmdCache(_args) {
  const keep = keepFingerprintsFor();
  const result = pruneHostCache({ keepFingerprints: keep });
  console.log(JSON.stringify({ cacheDir: path.join(tmpdir(), 'dsh-adapt-host-cache'), keep, ...result }, null, 2));
}

function cmdDetect() {
  const hostModule = process.env.DSH_HOST_MODULE;
  if (!hostModule || !existsSync(hostModule)) {
    console.log(JSON.stringify({
      flavor: 'unknown',
      evidence: '未提供本地宿主实例；本命令用于在已装配宿主的进程中探测。多通道探测请用 `verify`。',
      hint: 'DSH_HOST_MODULE=<path to module exporting ctx.tools> dsh-adapt detect',
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({ flavor: 'unknown', evidence: `已加载宿主模块 ${hostModule}，但 detect 需在宿主进程内调用 detectHostFlavor(ctx.tools)` }, null, 2));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[dsh-adapt] 参数错误：${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  const command = args._[0];
  try {
    if (command === 'matrix') cmdMatrix();
    else if (command === 'verify') cmdVerify(args);
    else if (command === 'watch') await cmdWatch(args);
    else if (command === 'settle') cmdSettle(args);
    else if (command === 'baseline') cmdBaseline(args);
    else if (command === 'report') cmdReport(args);
    else if (command === 'cache') cmdCache(args);
    else if (command === 'detect') cmdDetect();
    else { console.log(usage()); process.exit(command ? 2 : 0); }
  } catch (error) {
    if (error?.usageError || /^未知通道|^参数 /.test(String(error?.message ?? ''))) {
      console.error(`[dsh-adapt] 参数错误：${error.message}`);
      console.error(usage());
      process.exit(2);
    }
    console.error(`[dsh-adapt] 失败：${String(error?.stack ?? error)}`);
    process.exit(3);
  }
}

// 仅在被直接执行时跑 CLI；被 import（如单测）时只导出纯函数，不产生副作用。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
