/**
 * 上游漂移**自动归因**（watch 的「下一步」）。
 *
 * ## 为什么需要它
 * `watch` 只能回答「上游有没有发新版」（dist-tag 与钉版是否一致）。
 * 但中台的真实痛点是**发新版之后**：哪个通道漂了、漂在哪个契约字段、影响哪些检查、
 * 该改中台哪一处、插件要不要动——这些过去要靠人逐仓翻日志（正是本 Issue 要消灭的重复劳动）。
 *
 * 本模块把这三件事自动化：
 * 1. **语义分类**：契约字段漂移 → 受影响检查清单 → 责任方（上游 / 中台 / 插件）；
 * 2. **影响面**：受影响检查 → 归因后果（`UPSTREAM_DRIFT` / `PLUGIN_REGRESSION`）与放行结论；
 * 3. **迁移建议**：点名要改的**中台文件**（定向修，插件零改动）+ 本次新出现的保留名等硬约束。
 *
 * ## 与 verify 的分工（防「把人类归因混进机器判据」）
 * `verify` 的归因判据**只读结构化字段**（`hostFatal[]` + check 名），这是硬纪律；
 * 本模块输出的是**人类排障建议**（advice），**不得**回灌进 `attributionDetail()` 的判据。
 * 两者共用同一份表（`contract.mjs` 的 check 名单），但用途不同：一个判责任，一个排修法。
 *
 * @module dsh-adapt-hub/triage
 */

import { HOST_FATAL_FIELD, HOST_SIDE_CHECKS } from '../harness/contract.mjs';

/**
 * 漂移字段 → 影响面映射表（**唯一事实源**；`verify/runner.mjs` 的漂移相关性判据必须与本表一致）。
 *
 * 每个字段声明：
 * - `checks`：该字段漂移会直接影响的探针检查（与 `contract.mjs` 的 check 名一致，不新造名字）；
 * - `attribution`：这些检查失败时的归因后果（判据 3 的「一一对应」就是靠这张表落地的）；
 * - `owner`：修谁（`upstream` = 等上游/等新契约；`hub` = 改中台兼容层；`plugin` = 插件侧要动）；
 * - `hubFiles`：定向修应改的**中台文件**（点名文件，不留「去查代码」）；
 * - `action`：给看报告的人的**一步动作**（人话）。
 *
 * 纪律：本表**不得**把 `guard.reserved_rejected` 算进来——它是插件侧硬证据
 * （`PLUGIN_HARD_EVIDENCE`），与漂移无关；把它算作「漂移相关」就是把插件违规甩给上游
 * （历史缺陷 🔴-C）。漂移相关性只认中台自检与兼容层检查。
 *
 * @type {Readonly<Record<string, {checks: readonly string[], attribution: 'UPSTREAM_DRIFT'|'PLUGIN_REGRESSION', owner: 'upstream'|'hub'|'plugin', hubFiles: readonly string[], action: string}>>}
 */
export const DRIFT_IMPACT = Object.freeze({
  reservedName: {
    checks: ['guard.reserved_name'],
    attribution: 'UPSTREAM_DRIFT',
    owner: 'hub',
    hubFiles: ['src/compat/tool.mjs', 'src/harness/contract.mjs'],
    action: '上游放宽/收紧了保留名校验：中台保留名护栏（compat/tool.mjs）与契约探测（harness/contract.mjs）各改一处；插件零改动。',
  },
  schemaSubset: {
    checks: ['compat.schema_flatten'],
    attribution: 'UPSTREAM_DRIFT',
    owner: 'hub',
    hubFiles: ['src/compat/schema.mjs'],
    action: '上游 schema 子集白名单变了：只改 schema 压平器的白名单，插件无需改写法。',
  },
  configProjection: {
    checks: ['detect.flavor_known'],
    attribution: 'UPSTREAM_DRIFT',
    owner: 'hub',
    hubFiles: ['src/detect/flavor.mjs'],
    action: '上游 Config 投影形状变了：改版本线探测器指纹；探测失败按 unknown 走兼容路径，不阻断加载。',
  },
  outputShape: {
    checks: ['dispatch.execute_ok', 'dispatch.render_projected', 'dispatch.echo_payload', 'dispatch.abort_semantics'],
    attribution: 'UPSTREAM_DRIFT',
    owner: 'hub',
    hubFiles: ['src/compat/tool.mjs'],
    action: '上游 output 形状要求变了：改默认 render 兜底与 output 归一化，插件只写业务即可。',
  },
});

/** 漂移字段清单（与 `watch/upstream.mjs` 的 `CONTRACT_FIELDS` 同源口径）。 */
export const DRIFT_FIELDS = Object.freeze(Object.keys(DRIFT_IMPACT));

/**
 * 从两次契约指纹提取**新出现的保留名**（硬约束变更，插件侧最容易被这条打穿）。
 *
 * 为什么单列：保留名是**插件可直接踩**的硬约束。上游新增一个保留名时，
 * 所有「恰好用了该名字」的插件会在下一次验收里判 `PLUGIN_REGRESSION`
 * ——虽然责任在上游（新增约束），但插件必须改名。这条必须显式点名。
 *
 * @param {string|null|undefined} before 旧契约的 reservedName 措辞
 * @param {string|null|undefined} after 新契约的 reservedName 措辞
 * @returns {{appeared: string[], disappeared: string[]}} 新出现 / 消失的保留名
 */
export function diffReservedNames(before, after) {
  const namesOf = (text) => {
    if (typeof text !== 'string' || text.length === 0) return [];
    const found = [];
    for (const m of text.matchAll(/[`"']([A-Za-z_][A-Za-z0-9_]{2,})[`"']/g)) {
      const name = m[1];
      // 只认「保留名」语境：措辞里通常写 tool name "x" is reserved
      if (/reserved/i.test(text) && !found.includes(name)) found.push(name);
    }
    // 兜底：上游措辞可能是 `run_code is reserved`（无引号）
    if (found.length === 0) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]{2,})\s/i.exec(text);
      if (m) found.push(m[1]);
    }
    return found;
  };
  const a = namesOf(before);
  const b = namesOf(after);
  return { appeared: b.filter((n) => !a.includes(n)), disappeared: a.filter((n) => !b.includes(n)) };
}

/**
 * 把「通道的契约漂移项」归类为**可执行的影响面**。
 *
 * @param {object} options 选项
 * @param {object[]} [options.items] 漂移项（`{channel, field, before, after}`）
 * @param {string} [options.channel] 限定通道（不传则全部）
 * @returns {{field:string, before:unknown, after:unknown, checks:string[], attribution:string, owner:string, hubFiles:string[], action:string, pluginImpact:string, known:boolean}[]}
 */
export function classifyDrift(options = {}) {
  const items = (options.items ?? []).filter((item) => !options.channel || item.channel === options.channel);
  return items.map((item) => {
    const impact = DRIFT_IMPACT[item.field];
    if (!impact) {
      // 未登记字段：**不猜**（显式标 known=false，让人补表），而不是套一个默认结论
      return {
        field: item.field,
        before: item.before ?? null,
        after: item.after ?? null,
        checks: [],
        attribution: 'UNKNOWN',
        owner: 'unknown',
        hubFiles: [],
        action: `契约字段 ${item.field} 未在 triage 影响面表登记：请先补 src/triage/index.mjs 的 DRIFT_IMPACT，再决定改哪一处。`,
        pluginImpact: '未知（未登记字段，不得据此改插件）',
        known: false,
      };
    }
    const reserved = item.field === 'reservedName'
      ? diffReservedNames(item.before, item.after)
      : { appeared: [], disappeared: [] };
    let pluginImpact = '插件无需改动（中台兼容层吸收）';
    if (reserved.appeared.length > 0) {
      pluginImpact = `🔴 插件**必须**改名：上游新增保留名 ${reserved.appeared.join(', ')}（声明即判 PLUGIN_REGRESSION）`;
    } else if (impact.owner === 'plugin') {
      pluginImpact = '插件侧需要改动（见 action）';
    }
    return {
      field: item.field,
      before: item.before ?? null,
      after: item.after ?? null,
      checks: [...impact.checks],
      attribution: impact.attribution,
      owner: impact.owner,
      hubFiles: [...impact.hubFiles],
      action: impact.action,
      pluginImpact,
      known: true,
      ...(reserved.appeared.length > 0 || reserved.disappeared.length > 0 ? { reservedNames: reserved } : {}),
    };
  });
}

/**
 * 汇总一次 `watch` 的漂移影响面（给报告与 CI 用）。
 *
 * @param {object} options 选项
 * @param {object} options.report `watchUpstream()` 的报告（含 `drift` / `contract` 等可选字段）
 * @param {object|null} [options.previousContracts] 契约基线（用于契约字段 diff）
 * @param {object} [options.contractDrift] 已算好的契约漂移（优先用；不传则按基线现算）
 * @param {Function} [options.classify] 注入的分类器（单测用；默认 {@link classifyDrift}）
 * @returns {{hasDrift:boolean, versions:object[], contracts:object[], hubFiles:string[], plugins:string[], advice:string[], unknownFields:string[]}}
 */
export function triageUpstream(options) {
  const report = options.report ?? {};
  const classify = options.classify ?? classifyDrift;

  // ① 版本钉版漂移（可升级）
  const versions = (report.drift ?? []).map((item) => ({
    channel: item.channel,
    pkg: item.pkg,
    pinned: item.pinned,
    latest: item.latest,
    step: [
      `在 registry/channels.json 的 channels.${item.channel}.pins 把 ${item.pkg} 提到 ${item.latest}`,
      '跑 `dsh-adapt verify --channel ' + item.channel + ' ...`（真宿主）',
      '契约指纹有 diff 时按本报告的「中台改哪儿」定向修',
    ],
  }));

  // ② 契约字段漂移（影响面归类）
  const drift = options.contractDrift ?? { changed: false, items: [] };
  const contracts = classify({ items: drift.items ?? [] });

  // ③ 汇总要改的中台文件 / 受影响的插件义务 / 未知字段
  const hubFiles = [...new Set(contracts.flatMap((c) => c.hubFiles))].sort();
  const plugins = [...new Set(contracts.map((c) => c.pluginImpact).filter((t) => t.includes('必须') || t.includes('需要改动')))];
  const unknownFields = contracts.filter((c) => !c.known).map((c) => c.field);
  const advice = [];
  if (versions.length === 0 && contracts.length === 0) advice.push('上游无漂移：钉版与契约均与基线一致（无需动作）。');
  if (versions.length > 0) advice.push(`上游发新版 ${versions.length} 项：先 bump 钉版再真宿主验收（不要只改版本号就算适配完）。`);
  if (contracts.length > 0) advice.push(`契约漂移 ${contracts.length} 项：改中台 ${hubFiles.length} 个文件即可，插件零改动（除非命中新增保留名）。`);
  if (unknownFields.length > 0) advice.push(`⚠️ 未登记契约字段 ${unknownFields.join(', ')}：先补 triage 影响面表，**不要**据此改插件。`);
  advice.push(`人类排障建议（advice）**不得**回灌进 verify 的归因判据——判据只读 ${HOST_FATAL_FIELD} 与 check 名（含 ${HOST_SIDE_CHECKS.length} 项宿主侧 check）。`);

  return {
    hasDrift: versions.length > 0 || contracts.length > 0,
    versions,
    contracts,
    hubFiles,
    plugins,
    advice,
    unknownFields,
  };
}

/**
 * 把影响面渲染成人类可读 Markdown（供 `watch --markdown` / CI 评论使用）。
 *
 * @param {object} triage {@link triageUpstream} 的返回值
 * @returns {string} Markdown
 */
export function toTriageMarkdown(triage) {
  const lines = ['## 上游漂移影响面（自动归因）', ''];
  if (!triage.hasDrift) return `${lines.join('\n')}✅ 无漂移：钉版与契约均与基线一致。\n`;
  if (triage.versions.length > 0) {
    lines.push('| 通道 | 包 | 钉版 | 上游最新 |', '|---|---|---|---|');
    for (const v of triage.versions) lines.push(`| ${v.channel} | ${v.pkg} | ${v.pinned} | ${v.latest} |`);
    lines.push('');
  }
  if (triage.contracts.length > 0) {
    lines.push('| 契约字段 | 受影响检查 | 归因 | 责任方 | 中台要改的文件 |', '|---|---|---|---|---|');
    for (const c of triage.contracts) {
      lines.push(`| ${c.field} | ${c.checks.join(' / ') || '—'} | ${c.attribution} | ${c.owner} | ${c.hubFiles.map((f) => `\`${f}\``).join(' ') || '—'} |`);
    }
    lines.push('');
    for (const c of triage.contracts) {
      lines.push(`- **${c.field}**：${c.action}`);
      lines.push(`  - 插件影响：${c.pluginImpact}`);
    }
    lines.push('');
  }
  lines.push('### 建议动作');
  for (const a of triage.advice) lines.push(`- ${a}`);
  return `${lines.join('\n')}\n`;
}
