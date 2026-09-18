/**
 * 上游变更侦测（watch）。
 *
 * 中台的价值前提是「跟得上上游」。本模块做三件事：
 * 1. **解析最新版本**：按通道 dist-tag 从 npm registry 解析被追踪包的最新版本，
 *    与 `registry/channels.json` 的钉版对比 → 产出「可升级 / 已漂移」清单；
 * 2. **契约指纹漂移**：把最近一次验收采集到的契约指纹（保留名措辞、schema 子集
 *    错误措辞、output 形状）与当前基线快照对比 → 产出「契约是否变了」；
 * 3. **基线维护**：只有**验收通过的通道**才允许更新基线，失败运行绝不覆盖
 *    （否则「漂移侦测」会被自己的失败运行写坏，产出假信号）。
 *
 * 无网络时**不静默通过**：返回 `offline: true` 并如实上报（不吞异常）。
 *
 * @module dsh-adapt-hub/watch/upstream
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HUB_ROOT, loadChannels } from '../harness/host.mjs';

const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';

/** 参与漂移对比的契约指纹字段（与探针采集字段一致）。 */
export const CONTRACT_FIELDS = ['configProjection', 'reservedName', 'schemaSubset', 'outputShape'];

/** 判定一份契约指纹是否「有效」（失败运行的 `{}` 不算）。 */
export function isUsableContract(contract) {
  return Boolean(contract) && typeof contract === 'object' && Object.keys(contract).length > 0;
}

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
 * `save` 语义（防自毁）：
 * - **合并**写入（不整体覆盖）：只替换本次提供的通道，其余通道保留原基线；
 * - **空契约不写**：`{}` / 缺失字段视为「本次未采集到」，不得清空已有基线；
 * - **无变化不写盘**：避免 CI 每次 push 都改写 tracked 文件（脏工作区）。
 *
 * @param {{hubRoot?:string}} [options]
 * @returns {{path:string, load:()=>object|null, save:(contracts:object)=>{written:boolean,path:string,contracts:object}}}
 */
export function contractSnapshot(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const dir = path.join(hubRoot, 'registry', 'contract-snapshots');
  const file = path.join(dir, 'latest.json');
  return {
    path: file,
    load: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    save: (contracts) => {
      const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      const merged = mergeContracts(previous?.contracts ?? {}, contracts);
      const unchanged = previous && JSON.stringify(previous.contracts ?? {}) === JSON.stringify(merged);
      if (!unchanged) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ capturedAt: new Date().toISOString(), contracts: merged }, null, 2)}\n`);
      }
      return { written: !unchanged, path: file, contracts: merged };
    },
  };
}

/**
 * 合并契约指纹：只接受**有效**契约，其余保持原基线（不覆盖、不清空）。
 *
 * @param {object} [previous] 原基线（channel → contract）
 * @param {object} [incoming] 本次采集（channel → contract）
 * @returns {object} 合并结果
 */
export function mergeContracts(previous = {}, incoming = {}) {
  const merged = { ...(previous ?? {}) };
  for (const [channel, contract] of Object.entries(incoming ?? {})) {
    if (isUsableContract(contract)) merged[channel] = contract;
  }
  return merged;
}

/**
 * 规划基线更新：只有 `ok === true` 且契约有效的通道才允许写入。
 *
 * @param {{snapshot:{load:()=>object|null}, report:{channels:object[]}, onlyOk?:boolean}} options 选项
 * @returns {{previous:object|null, accepted:object, skipped:string[], merged:object, changed:boolean}}
 */
export function planSnapshotUpdate(options) {
  const onlyOk = options.onlyOk ?? true;
  const previous = options.snapshot.load();
  const prevContracts = previous?.contracts ?? {};
  const accepted = {};
  const skipped = [];

  for (const channel of options.report?.channels ?? []) {
    const usable = isUsableContract(channel?.contract);
    if (!usable || (onlyOk && channel.ok !== true)) {
      skipped.push(channel?.channel ?? 'unknown');
      continue;
    }
    accepted[channel.channel] = channel.contract;
  }

  const merged = mergeContracts(prevContracts, accepted);
  const changed = JSON.stringify(merged) !== JSON.stringify(prevContracts);
  return { previous, accepted, skipped, merged, changed };
}

/**
 * 对比两次契约指纹，产出漂移项。
 *
 * 防假信号：
 * - 本次契约缺失/为空（如通道验收失败）→ **不产生漂移项**；
 * - 该通道**无历史基线** → 记为 `newBaselines`（首次采集），不算漂移。
 *
 * @param {object|null} previous 上次快照
 * @param {object} current 本次指纹（channel → contract）
 * @returns {{changed:boolean, items:object[], newBaselines:string[]}}
 */
export function diffContracts(previous, current) {
  const items = [];
  const newBaselines = [];
  const prev = normalizePrevious(previous);
  if (!prev) return { changed: false, items: [], newBaselines: Object.keys(current ?? {}) };

  for (const [channel, contract] of Object.entries(current ?? {})) {
    if (!isUsableContract(contract)) continue;
    const before = prev.contracts?.[channel];
    if (!isUsableContract(before)) {
      newBaselines.push(channel);
      continue;
    }
    for (const field of CONTRACT_FIELDS) {
      const a = JSON.stringify(before[field] ?? null);
      const b = JSON.stringify(contract[field] ?? null);
      if (a !== b) items.push({ channel, field, before: before[field] ?? null, after: contract[field] ?? null });
    }
  }
  return { changed: items.length > 0, items, newBaselines };
}

/**
 * 归一化「上一次快照」：同时接受完整快照（`{contracts}`）与裸契约表（`{channel: contract}`）。
 *
 * @param {object|null|undefined} previous 上次快照或裸契约表
 * @returns {object|null} `{contracts}` 形态
 */
export function normalizePrevious(previous) {
  if (!previous || typeof previous !== 'object') return null;
  if (previous.contracts && typeof previous.contracts === 'object') return previous;
  return { contracts: previous };
}

/**
 * 单通道契约漂移（供失败归因使用）。
 *
 * @param {object|null} previous 上次快照（`{contracts}` 或裸契约表皆可）
 * @param {string} channel 通道名
 * @param {object} contract 本次契约指纹
 * @returns {{changed:boolean, items:object[], newBaseline:boolean}}
 */
export function channelContractDrift(previous, channel, contract) {
  const diff = diffContracts(normalizePrevious(previous), { [channel]: contract });
  return { changed: diff.changed, items: diff.items, newBaseline: diff.newBaselines.includes(channel) };
}
