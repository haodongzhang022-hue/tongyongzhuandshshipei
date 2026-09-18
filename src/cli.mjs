#!/usr/bin/env node
/**
 * DSH 适配中台 CLI。
 *
 * 子命令：
 * - `detect`   探测本地宿主版本线（需宿主实例；无宿主时报 unknown，不报错）
 * - `matrix`   打印通道矩阵（稳定版 / 开发版 / 历史线）
 * - `verify`   双通道验收（`--channel stable|dev|legacy|all`）
 * - `watch`    上游变更侦测（dist-tag 漂移 + 契约指纹 diff）
 * - `report`   验收 + 二级信息输出（`--markdown` 出人类视图）
 *
 * @module dsh-adapt-hub/cli
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { HUB_ROOT, loadChannels } from './harness/host.mjs';
import { resolvePlugin, verifyAll, verifyChannel } from './verify/runner.mjs';
import { buildSecondary, toMarkdown } from './report/secondary.mjs';
import { contractSnapshot, diffContracts, watchUpstream } from './watch/upstream.mjs';
import { VERSION } from './version.mjs';

/** 解析 `--key value` / `--flag` 形式的参数。 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i += 1; }
      else args[key] = true;
    } else args._.push(token);
  }
  return args;
}

function usage() {
  return [
    `dsh-adapt-hub v${VERSION}`,
    '',
    '用法：',
    '  dsh-adapt matrix                                  # 通道矩阵',
    '  dsh-adapt verify --channel stable|dev|legacy|all   # 双通道验收',
    '        --plugin <path>  --tools a,b  [--offline] [--json <out>]',
    '  dsh-adapt watch  [--json <out>]                    # 上游变更侦测',
    '  dsh-adapt report --plugin <path> --tools a,b [--markdown]',
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
  const channel = args.channel ?? 'all';
  const channels = channel === 'all' ? ['stable', 'dev'] : [channel];
  const report = verifyAll({ pluginPath, expectedTools, channels, offline: Boolean(args.offline) });
  const secondary = buildSecondary(report);

  const snapshot = contractSnapshot({ hubRoot: HUB_ROOT });
  const previous = snapshot.load();
  const current = Object.fromEntries(report.channels.map((c) => [c.channel, c.contract]));
  const drift = diffContracts(previous, current);
  snapshot.save({ ...(previous?.contracts ?? {}), ...current });

  const output = { ...report, secondary, contractDrift: drift };
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
      evidence: '未提供本地宿主实例；本命令用于在已装配宿主的进程中探测。双通道探测请用 `verify`。',
      hint: 'DSH_HOST_MODULE=<path to module exporting ctx.tools> dsh-adapt detect',
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({ flavor: 'unknown', evidence: `已加载宿主模块 ${hostModule}，但 detect 需在宿主进程内调用 detectHostFlavor(ctx.tools)` }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'matrix') cmdMatrix();
  else if (command === 'verify') cmdVerify(args);
  else if (command === 'watch') await cmdWatch(args);
  else if (command === 'report') cmdReport(args);
  else if (command === 'detect') cmdDetect();
  else { console.log(usage()); process.exit(command ? 2 : 0); }
} catch (error) {
  console.error(`[dsh-adapt] 失败：${String(error?.stack ?? error)}`);
  process.exit(3);
}
