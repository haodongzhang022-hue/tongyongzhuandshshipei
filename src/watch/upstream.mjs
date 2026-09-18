/**
 * 上游变更侦测（watch）。
 *
 * 中台的价值前提是「跟得上上游」。本模块做两件事：
 * 1. **解析最新版本**：按通道 dist-tag 从 npm registry 解析被追踪包的最新版本，
 *    与 `registry/channels.json` 的钉版对比 → 产出「可升级 / 已漂移」清单；
 * 2. **契约指纹漂移**：把最近一次验收采集到的契约指纹（保留名措辞、schema 子集
 *    错误措辞、output 形状）与当前基线快照对比 → 产出「契约是否变了」。
 *
 * 无网络时**不静默通过**：返回 `offline: true` 并如实上报（不吞异常）。
 *
 * @module dsh-adapt-hub/watch/upstream
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HUB_ROOT, loadChannels } from '../harness/host.mjs';

const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';

/**
 * 查询单个包的 dist-tags。
 *
 * @param {string} pkg 包名（含 scope）
 * @param {{timeoutMs?:number}} [options] 选项
 * @returns {Promise<Record<string,string>>} dist-tags
 */
export async function fetchDistTags(pkg, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(pkg)}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data['dist-tags'] ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 侦测上游版本漂移。
 *
 * @param {{hubRoot?:string, channels?:string[], timeoutMs?:number}} [options] 选项
 * @returns {Promise<object>} 侦测报告
 */
export async function watchUpstream(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const registry = loadChannels(hubRoot);
  const channels = options.channels ?? Object.keys(registry.channels).filter((name) => registry.channels[name].npmTag);
  const report = { generatedAt: new Date().toISOString(), offline: false, channels: {}, tracked: {}, drift: [] };

  for (const pkg of registry.trackedPackages) {
    try {
      report.tracked[pkg] = await fetchDistTags(pkg, options);
    } catch (error) {
      report.offline = true;
      report.tracked[pkg] = { error: String(error?.message ?? error) };
    }
  }

  for (const name of channels) {
    const channel = registry.channels[name];
    const tag = channel.npmTag;
    const toolTags = report.tracked['@deepseek-ai/dsh-tools'] ?? {};
    const latest = toolTags[tag];
    const pinned = channel.pins['@deepseek-ai/dsh-tools'];
    const entry = { label: channel.label, npmTag: tag, pinned, latest: latest ?? null, upToDate: latest === pinned };
    report.channels[name] = entry;
    if (latest && latest !== pinned) {
      report.drift.push({ channel: name, pkg: '@deepseek-ai/dsh-tools', pinned, latest, action: 'bump-pins-then-verify' });
    }
  }

  return report;
}

/**
 * 契约指纹快照读写（用于跨次验收对比）。
 *
 * @param {{hubRoot?:string}} [options]
 * @returns {{path:string, load:()=>object|null, save:(contracts:object)=>void}}
 */
export function contractSnapshot(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const dir = path.join(hubRoot, 'registry', 'contract-snapshots');
  const file = path.join(dir, 'latest.json');
  return {
    path: file,
    load: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    save: (contracts) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify({ capturedAt: new Date().toISOString(), contracts }, null, 2)}\n`);
    },
  };
}

/**
 * 对比两次契约指纹，产出漂移项。
 *
 * @param {object|null} previous 上次快照
 * @param {object} current 本次指纹（channel → contract）
 * @returns {{changed:boolean, items:object[]}}
 */
export function diffContracts(previous, current) {
  const items = [];
  if (!previous) return { changed: false, items: [{ channel: '*', field: 'baseline', note: '首次采集，无对比基线' }] };
  for (const [channel, contract] of Object.entries(current)) {
    const before = previous.contracts?.[channel] ?? {};
    for (const field of ['configProjection', 'reservedName', 'schemaSubset', 'outputShape']) {
      const a = JSON.stringify(before[field] ?? null);
      const b = JSON.stringify(contract[field] ?? null);
      if (a !== b) items.push({ channel, field, before: before[field] ?? null, after: contract[field] ?? null });
    }
  }
  return { changed: items.length > 0, items };
}
