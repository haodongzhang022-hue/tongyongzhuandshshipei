#!/usr/bin/env node
/**
 * DSH 适配中台 CLI。
 *
 * 子命令：
 * - `detect`   探测本地宿主版本线（需宿主实例；无宿主时报 unknown，不报错）
 * - `matrix`   打印通道矩阵（稳定版 / 开发版 / 历史线）
 * - `verify`   多通道验收（`--channel stable|dev|legacy|all`，`all` = 三通道全跑）
 * - `watch`    上游变更侦测（dist-tag 漂移 + 契约指纹 diff）
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
import {
  contractSnapshot,
  diffContracts,
  planSnapshotUpdate,
  watchUpstream,
} from './watch/upstream.mjs';
import { VERSION } from './version.mjs';

/** 所有可用通道（`all` 的展开结果，与 `.cnb.yml` / `.cnb/web_trigger.yml` 保持同一语义）。 */
export const ALL_CHANNELS = ['stable', 'dev', 'legacy'];

/** 已知布尔开关（其余 `--key value` 视为带值参数）。 */
const BOOLEAN_FLAGS = new Set(['offline', 'markdown', 'help', 'prune-cache']);

/** 已知带值参数（未知的 `--key` 显式报错，避免拼错参数被静默忽略）。 */
const VALUE_KEYS = new Set(['channel', 'plugin', 'tools', 'json']);

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
    '  dsh-adapt watch  [--json <out>]                      # 上游变更侦测',
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

  // 基线维护（防自毁）：只有验收通过的通道才更新基线；失败不覆盖、不产生假漂移。
  const snapshot = contractSnapshot({ hubRoot: HUB_ROOT });
  const plan = planSnapshotUpdate({ snapshot, report });
  const saved = plan.changed ? snapshot.save(plan.accepted) : { written: false, contracts: plan.merged };
  const drift = diffContracts(plan.previous, Object.fromEntries(
    report.channels.filter((c) => c.ok).map((c) => [c.channel, c.contract]),
  ));

  const output = {
    ...report,
    secondary,
    contractDrift: drift,
    cache,
    baseline: {
      updated: plan.accepted && Object.keys(plan.accepted).length > 0 ? Object.keys(plan.accepted) : [],
      skipped: plan.skipped,
      written: Boolean(saved.written),
      path: snapshot.path,
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

async function cmdWatch(args) {
  const report = await watchUpstream({ hubRoot: HUB_ROOT });
  if (typeof args.json === 'string') {
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(path.resolve(args.json), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.offline ? 2 : report.drift.length > 0 ? 1 : 0);
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
