/**
 * 契约**分段基线**（按周期分片 + 顺序链式合并）。
 *
 * ## 为什么需要它（用户口径的直接落地）
 * 旧语义：`verify` **每次运行都把结果合并写进** `registry/contract-snapshots/latest.json`。
 * 三个通道 x 每天多次运行 ⇒ 基线被「最新一次运行」顶掉，且**历史被覆盖**：
 * 上游连续发 alpha 时，`v1→v2→v3` 的累积偏移被**静默吸收**（基线自己一直在动，diff 永远只比"上一次运行"）。
 *
 * 新语义（本模块）：
 * 1. **基线不每步更新**：push / PR 只**读**基线做对比，**写**基线只发生在**结算点**；
 * 2. **一天一个基线**：默认按「结算日」切片（`settleHour` 默认 10 点 ⇒ 每天 10:00 结算一次）；
 * 3. **更频繁一点**：可切到以**上游版本**为周期（每个版本首发 = 一个周期，建立**独自**基线）；
 * 4. **同周期多个候选 → 取相对早的那个**（`first-wins`）：后跑的候选不覆盖先前基线，
 *    防「跑得越多、基线越偏」；
 * 5. **不自合并到主线**：每个周期写**独立分片** `segments/<periodKey>.json`，互不覆盖；
 * 6. **顺序链式合并**：`latest` 是**派生**结果——把分片按周期**早→晚依次合并**（后周期覆盖
 *    前周期同名通道），「连起来」才是最新版；**不是**「全部取最新再合成」。
 *
 * ## 显式边界（不越权承诺）
 * - 本模块只管**契约指纹基线的周期切片与链式推进**；探针判据、归因判据一概不碰。
 * - 分片是**纯数据**：`first-wins` 只影响「哪一条候选成为该周期基线」，**不影响**任何归因结论。
 *
 * @module dsh-adapt-hub/watch/baseline
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HUB_ROOT } from '../harness/host.mjs';
import { isUsableContract, mergeContracts } from './upstream.mjs';

/** 分片目录（相对 hub 根）。 */
export const SEGMENT_DIR = 'registry/contract-snapshots/segments';

/** 支持的分片模式（`day` = 一天一个基线；`release` = 每个版本一个基线）。 */
export const SEGMENT_MODES = ['day', 'release'];

/** 默认结算时刻（小时，0-23）。10 点：用户点名「早晨 10 点结算一天」。 */
export const DEFAULT_SETTLE_HOUR = 10;

/** 默认时区偏移（分钟，+480 = UTC+8）。 */
export const DEFAULT_TZ_OFFSET_MINUTES = 480;

/**
 * 把时间戳换算到「结算周期键」。
 *
 * 语义：**结算点 = 每天 `settleHour:00`（本地时区）**。一个周期 = `[D settleHour, D+1 settleHour)`，
 * 周期键 = **该周期结算点的日期**（`YYYY-MM-DD`）。
 *
 * 为什么用「结算点日期」而不是「周期起始日期」命名：人看的是**哪一次结算**产出了这份基线
 * （用户口径「早晨 10 点结算一天」⇒ 键就是那次结算的日期），而不是「这个周期从哪天开始」。
 *
 * - `settleHour` **之前**的运行：当天还没结算 ⇒ 归入**当天**的结算（`03-02 09:30` → `2026-03-02`）；
 * - `settleHour` **之后（含）**的运行：当天已结算 ⇒ 归入**次日**的结算（`03-02 10:30` → `2026-03-03`）。
 *
 * @param {Date|string|number} [at] 时间点（默认 now）
 * @param {{settleHour?:number, tzOffsetMinutes?:number}} [options] 选项
 * @returns {string} 周期键 `YYYY-MM-DD`（= 结算点日期）
 */
export function periodKeyForDay(at = new Date(), options = {}) {
  const settleHour = options.settleHour ?? DEFAULT_SETTLE_HOUR;
  const tz = options.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const ms = (at instanceof Date ? at.getTime() : new Date(at).getTime());
  // 平移到「本地时间」，找到「下一个不早于 now 的结算点」= 结算点的日期即周期键
  const local = new Date(ms + tz * 60_000);
  // 结算点集合 = { k*86400000 + settleHour*3600000 }（本地时间）；周期键 = **不早于** now 的最近结算点日期。
  const S = settleHour * 3_600_000;
  const localMs = local.getTime();
  let settlementMs = Math.floor((localMs - S) / 86_400_000) * 86_400_000 + S;
  // 恰在结算点上的运行归**下一**周期（该结算点已经结过了）
  if (settlementMs <= localMs) settlementMs += 86_400_000;
  return new Date(settlementMs).toISOString().slice(0, 10);
}

/**
 * 计算周期键。
 *
 * @param {object} options 选项
 * @param {'day'|'release'} [options.mode] 分片模式（默认 `day`）
 * @param {Date|string|number} [options.at] 时间点
 * @param {number} [options.settleHour] 结算小时
 * @param {number} [options.tzOffsetMinutes] 时区偏移（分钟）
 * @param {string} [options.release] 版本标识（`mode='release'` 时必需）
 * @returns {string} 周期键
 * @throws {Error} 模式未知 / release 模式缺版本标识时
 */
export function periodKey(options = {}) {
  const mode = options.mode ?? 'day';
  if (mode === 'day') return periodKeyForDay(options.at ?? new Date(), options);
  if (mode === 'release') {
    if (typeof options.release !== 'string' || options.release.length === 0) {
      throw new Error('release 模式必须提供 release 标识（如 dsh-tools@0.1.6-alpha.2）');
    }
    // 版本标识直接进文件名：只保留安全字符，避免路径穿越
    return `rel-${options.release.replace(/[^A-Za-z0-9._@-]/g, '_')}`;
  }
  throw new Error(`未知分片模式：${mode}（可选：${SEGMENT_MODES.join('|')}）`);
}

/**
 * 分片存储（读写 `segments/<periodKey>.json`）。
 *
 * @param {{hubRoot?:string}} [options] 选项
 * @returns {{dir:string, list:()=>string[], load:(key:string)=>object|null, save:(key:string, patch:object)=>object}}
 */
export function segmentStore(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const dir = path.join(hubRoot, SEGMENT_DIR);
  const fileOf = (key) => path.join(dir, `${key}.json`);
  return {
    dir,
    list: () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : []),
    load: (key) => (existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')) : null),
    save: (key, patch) => {
      const previous = existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')) : null;
      const next = { ...(previous ?? {}), ...patch, periodKey: key };
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileOf(key), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    },
  };
}

/**
 * 结算一个周期：把「本次运行的候选」并入该周期分片，**同周期取最早的候选**（`first-wins`）。
 *
 * 语义（对应需求）：
 * - 同周期内**首个**有效候选成为该周期基线 → `baseline`；
 * - 之后的候选**不覆盖**基线，只记入 `candidates[]`（可见、可审计），并计入 `ignored`；
 * - 候选**必须**是「验收通过的通道」（`ok === true` 且契约有效）——沿用旧语义的防自毁口径。
 *
 * @param {object} options 选项
 * @param {object} options.store {@link segmentStore} 的返回值
 * @param {string} options.key 周期键
 * @param {{channels?:object[], at?:Date|string|number, source?:string}} options.run 本次运行
 * @param {boolean} [options.dryRun] 只计算不落盘
 * @returns {{key:string, baseline:object, ignored:string[], written:boolean, candidates:object[], firstRunAt:string|null}}
 */
export function settleSegment(options) {
  const { store, key } = options;
  const at = new Date(options.run?.at ?? new Date()).toISOString();
  const accepted = {};
  const skipped = [];
  for (const channel of options.run?.channels ?? []) {
    if (channel?.ok === true && isUsableContract(channel.contract)) accepted[channel.channel] = channel.contract;
    else skipped.push(channel?.channel ?? 'unknown');
  }

  const previous = store.load(key);
  const hadBaseline = isUsableContract(previous?.baseline) && Object.keys(previous.baseline).length > 0;
  // **取最早**：已有基线就不再改写（后跑的不覆盖先跑的）
  const baseline = hadBaseline ? previous.baseline : accepted;
  const ignored = hadBaseline ? Object.keys(accepted) : [];
  // 候选台账**幂等**：同一时刻 + 同一来源 + 同一纳入集合的候选不重复追加
  // （否则「结算重跑一次」就多一条候选 ⇒ 文件被无意义改写）。
  const candidate = { at, source: options.run?.source ?? null, accepted: Object.keys(accepted), ignored };
  // 幂等键只取「运行身份」（时刻 + 来源）：`ignored` 依赖「此前是否已有基线」，
  // 把它算进幂等键会导致「同一份报告重跑一次」被当成新候选（实测踩到）。
  const runKey = (c) => `${c?.at ?? ''}|${c?.source ?? ''}`;
  const seen = new Set((previous?.candidates ?? []).map(runKey));
  const candidates = seen.has(runKey(candidate)) ? [...previous.candidates] : [...(previous?.candidates ?? []), candidate];

  const record = {
    mode: options.run?.mode ?? 'day',
    // 显式排序键：链式合并按它推进（不依赖 periodKey 字典序，见 segmentOrderAt）
    orderAt: options.run?.orderAt ?? previous?.orderAt ?? at,
    firstRunAt: previous?.firstRunAt ?? (Object.keys(accepted).length > 0 ? at : null),
    settledAt: at,
    baseline,
    skipped,
    ignored,
    candidates,
  };
  // 无实质变化则不落盘（避免「什么都没变却改写文件」⇒ CI 脏工作区 / 无意义 diff）。
  // 「实质变化」= 该周期基线变了，或候选台账变长（新候选进来）。
  const previousCandidates = (previous?.candidates ?? []).length;
  const materiallyChanged = !hadBaseline || candidates.length !== previousCandidates
    || JSON.stringify(baseline) !== JSON.stringify(previous?.baseline ?? {});
  const written = options.dryRun ? false : (materiallyChanged ? (store.save(key, record), true) : false);
  return { key, baseline, ignored, written, materiallyChanged, candidates: record.candidates, firstRunAt: record.firstRunAt };
}

/**
 * 分片的排序键（**早 → 晚**）。
 *
 * 为什么不能只用 `periodKey` 字典序：迁移分片键是 `migrated-<date>`，字典序排在
 * 日期键（`2026-...`）**之后** ⇒ 遗留基线会被错误地当成「最新」压在链尾（实测踩到）。
 * 所以排序以**显式时间**为准（`orderAt` → `settledAt` → `firstRunAt`），
 * 并把 `mode === 'migrated'` **固定在最前**（遗留基线天然早于所有分片）。
 *
 * @param {object} segment 分片
 * @returns {number} 排序用时间戳
 */
export function segmentOrderAt(segment) {
  if (segment?.mode === 'migrated') return -Infinity;
  const raw = segment?.orderAt ?? segment?.settledAt ?? segment?.firstRunAt ?? null;
  const ms = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : Infinity;
}

/**
 * 顺序链式合并：把分片按周期**早 → 晚**依次合并成「连起来的最新版」。
 *
 * 关键差别（用户口径）：**不是**「全部取最新再合成」，而是**沿链推进**——
 * 后周期只覆盖它自己声明过的通道，前周期未被覆盖的通道**原样保留**。
 *
 * @param {object[]} segments 分片数组（`{periodKey, baseline}`）
 * @returns {{contracts:object, chain:string[], perChannel:object}} 合并结果 + 链 + 每个通道的来源周期
 */
export function composeChain(segments) {
  const ordered = [...(segments ?? [])]
    .filter((s) => isUsableContract(s?.baseline))
    .sort((a, b) => segmentOrderAt(a) - segmentOrderAt(b) || String(a.periodKey).localeCompare(String(b.periodKey)));
  let contracts = {};
  const perChannel = {};
  const chain = [];
  for (const segment of ordered) {
    contracts = mergeContracts(contracts, segment.baseline);
    for (const channel of Object.keys(segment.baseline)) perChannel[channel] = segment.periodKey;
    chain.push(segment.periodKey);
  }
  return { contracts, chain, perChannel };
}

/**
 * 解析当前基线（沿链派生）。
 *
 * 这是**唯一**允许被称为「当前基线」的取值来源：`latest.json` 若有内容，仅作为
 * **尚未切片的历史遗留**参与链尾（见 `migrate`），不再是「每次运行改写的那份」。
 *
 * @param {{hubRoot?:string, includeLegacyLatest?:boolean}} [options] 选项
 * @returns {{contracts:object, chain:string[], perChannel:object, segments:object[], legacyLatest:object|null}}
 */
export function resolveBaseline(options = {}) {
  const store = segmentStore({ hubRoot: options.hubRoot ?? HUB_ROOT });
  const segments = store.list().map((key) => ({ periodKey: key, ...store.load(key) }));
  const composed = composeChain(segments);
  let legacyLatest = null;
  if (options.includeLegacyLatest !== false) {
    const legacy = legacySnapshot({ hubRoot: options.hubRoot ?? HUB_ROOT }).load();
    if (legacy && isUsableContract(legacy.contracts) && Object.keys(legacy.contracts).length > 0) {
      // 历史遗留按「更早」处理：先合遗留，再合分片链（分片优先，防倒退）
      legacyLatest = legacy.contracts;
      const contracts = mergeContracts(legacy.contracts, composed.contracts);
      for (const channel of Object.keys(composed.contracts)) composed.perChannel[channel] = composed.perChannel[channel];
      return { contracts, chain: composed.chain, perChannel: composed.perChannel, segments, legacyLatest };
    }
  }
  return { ...composed, segments, legacyLatest };
}

/**
 * 旧的单文件快照（`latest.json`）读写 —— **保留为历史遗留读取面**。
 *
 * ⚠️ 语义已收窄：**不再**由 `verify` 每次运行写入（那正是「基线不每步更新」要消掉的形态）。
 * 现仅用于：① 读取历史遗留基线（迁移期）；② 显式 `--legacy-latest` 兼容路径。
 *
 * @param {{hubRoot?:string}} [options] 选项
 * @returns {{path:string, load:()=>object|null, save:(contracts:object)=>object}}
 */
export function legacySnapshot(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const dir = path.join(hubRoot, 'registry', 'contract-snapshots');
  const file = path.join(dir, 'latest.json');
  return {
    path: file,
    load: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    save: (contracts) => {
      const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      const merged = mergeContracts(previous?.contracts ?? {}, contracts);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify({ capturedAt: new Date().toISOString(), legacy: true, contracts: merged }, null, 2)}\n`);
      return merged;
    },
  };
}

/**
 * 把历史遗留 `latest.json` **一次性**迁成周期分片（迁移期用，幂等）。
 *
 * 迁移语义：遗留基线按「`migratedAt` 之前的最后一个周期」处理 ⇒ 分片链上它**排在最前**，
 * 之后的分片会顺序覆盖它（正是「从前面合并到后面」）。
 *
 * @param {{hubRoot?:string, migrateKey?:string}} [options] 选项
 * @returns {{migrated:boolean, key:string|null, channels:string[], reason?:string}}
 */
export function migrateLegacyLatest(options = {}) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const legacy = legacySnapshot({ hubRoot }).load();
  if (!legacy || !isUsableContract(legacy.contracts) || Object.keys(legacy.contracts).length === 0) {
    return { migrated: false, key: null, channels: [], reason: '无历史遗留基线（或为空）' };
  }
  const key = options.migrateKey ?? `migrated-${String(legacy.capturedAt ?? 'unknown').slice(0, 10)}`;
  const store = segmentStore({ hubRoot });
  if (store.load(key)) return { migrated: false, key, channels: Object.keys(legacy.contracts), reason: '该分片已存在（幂等）' };
  store.save(key, {
    mode: 'migrated',
    orderAt: legacy.capturedAt ?? null,
    firstRunAt: legacy.capturedAt ?? null,
    settledAt: legacy.capturedAt ?? null,
    baseline: legacy.contracts,
    skipped: [],
    ignored: [],
    candidates: [],
  });
  return { migrated: true, key, channels: Object.keys(legacy.contracts) };
}
