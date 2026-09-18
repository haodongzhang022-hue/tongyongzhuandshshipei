#!/usr/bin/env node
/**
 * DSH 适配中台 CLI。
 *
 * 子命令：
 * - `detect`   探测本地宿主版本线（需宿主实例；无宿主时报 unknown，不报错）
 * - `matrix`   打印通道矩阵（稳定版 / 开发版 / 历史线）
 * - `verify`   多通道验收（`--channel stable|dev|legacy|all`，`all` = 三通道全跑）
 * - `watch`    上游变更侦测（dist-tag 漂移 + 契约指纹 diff）
 * - `report`   验收 + 二级信息输出（`--markdown` 出人类视图）
 *
 * 契约（退出码即信号）：
 * - `verify`：0 = GREEN；1 = 有失败；2 = 参数/用法错误
 * - `watch` ：0 = 无漂移；1 = 有漂移；2 = 离线
 *
 * @module dsh-adapt-hub/cli
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_ROOT, loadChannels } from './harness/host.mjs';
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
const BOOLEAN_FLAGS = new Set(['offline', 'markdown', 'help']);

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
      if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
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
 * @returns {string[]} 通道列表
 * @throws {Error} 通道名未知时
 */
export function resolveChannels(channel) {
  const registry = loadChannels(HUB_ROOT);
  const known = Object.keys(registry.channels);
  const value = channel ?? 'all';
  if (value === 'all') return [...ALL_CHANNELS];
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
    '  dsh-adapt report --plugin <path> --tools a,b [--markdown]',
    '',
    '退出码：verify 0=GREEN / 1=失败 / 2=用法错误；watch 0=无漂移 / 1=漂移 / 2=离线',
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

function cmdVerify(args) {
  const pluginPath = resolvePlugin(args.plugin ?? path.join(HUB_ROOT, 'tests/fixtures/demo-plugin.mjs'));
  const expectedTools = String(args.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const channels = resolveChannels(typeof args.channel === 'string' ? args.channel : undefined);
  const report = verifyAll({ pluginPath, expectedTools, channels, offline: Boolean(args.offline) });
  const secondary = buildSecondary(report);

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
  const pluginPath = resolvePlugin(args.plugin ?? path.join(HUB_ROOT, 'tests/fixtures/demo-plugin.mjs'));
  const expectedTools = String(args.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const report = verifyAll({ pluginPath, expectedTools, channels: ['stable', 'dev'], offline: Boolean(args.offline) });
  const secondary = buildSecondary(report);
  if (args.markdown) console.log(toMarkdown(secondary));
  else console.log(JSON.stringify(secondary, null, 2));
  process.exit(report.summary.verdict === 'GREEN' ? 0 : 1);
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
    else if (command === 'detect') cmdDetect();
    else { console.log(usage()); process.exit(command ? 2 : 0); }
  } catch (error) {
    if (/^未知通道/.test(String(error?.message ?? ''))) {
      console.error(`[dsh-adapt] ${error.message}`);
      process.exit(2);
    }
    console.error(`[dsh-adapt] 失败：${String(error?.stack ?? error)}`);
    process.exit(3);
  }
}

// 仅在被直接执行时跑 CLI；被 import（如单测）时只导出纯函数，不产生副作用。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
