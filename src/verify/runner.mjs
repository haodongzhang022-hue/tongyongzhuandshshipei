/**
 * 双通道验收执行器。
 *
 * 语义（对应需求原话「一个对齐最新稳定版，一个对齐最新开发版」）：
 * - `stable` 通道：插件必须**在稳定线上通过**——失败 = 插件回归，必须修；
 * - `dev` 通道：插件在开发线上通过则提前拿到新版兼容；失败时**区分归因**：
 *   - 若失败点与「契约指纹」漂移相关 → 判为 `UPSTREAM_DRIFT`（上游变更，非插件 bug）；
 *   - 否则判为 `PLUGIN_REGRESSION`（插件自身问题）。
 *
 * 归因判定是本中台的核心价值：把「越不稳定越需要自动化」变成可执行的信号，
 * 而不是让人去逐仓翻日志。
 *
 * @module dsh-adapt-hub/verify/runner
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { HUB_ROOT, loadChannels, runHostProbe } from '../harness/host.mjs';
import { CONTRACT_SIDE_CHECKS, HOST_FATAL_FIELD, HOST_FATAL_PREFIX, HOST_SIDE_CHECKS, PLUGIN_HARD_EVIDENCE, PLUGIN_SIDE_CHECKS } from '../harness/contract.mjs';
import { channelContractDrift, contractSnapshot } from '../watch/upstream.mjs';

/**
 * 运行一个通道的验收。
 *
 * @param {object} options 选项
 * @param {'stable'|'dev'|'legacy'|string} options.channel 通道名
 * @param {string} options.pluginPath 被测插件路径
 * @param {string[]} options.expectedTools 期望工具清单
 * @param {string} [options.hubRoot] 仓库根
 * @param {boolean} [options.offline] 离线模式
 * @param {object|null} [options.previousContracts] 契约指纹基线（channel → contract）；用于漂移归因
 * @returns {object} 通道验收报告
 */
export function verifyChannel(options) {
  const hubRoot = options.hubRoot ?? HUB_ROOT;
  const registry = loadChannels(hubRoot);
  const channel = registry.channels[options.channel];
  if (!channel) {
    return { channel: options.channel, ok: false, attribution: 'CONFIG_ERROR', errors: [`未知通道：${options.channel}`], checks: [] };
  }

  const probe = runHostProbe({
    channelName: options.channel,
    channel,
    pluginPath: options.pluginPath,
    expectedTools: options.expectedTools ?? [],
    hubRoot,
    offline: options.offline ?? false,
  });

  // 契约漂移：把本次指纹与该通道基线对比（失败运行的 `{}` 不参与对比，防假信号）
  const contractDrift = channelContractDrift(options.previousContracts ?? null, options.channel, probe.contract);
  const detail = probe.ok
    ? { attribution: 'PASS', channel: options.channel, reasons: ['全部检查通过'] }
    : attributionDetail(probe, channel, options.channel, { contractDrift });
  const attribution = detail.attribution;
  return {
    channel: options.channel,
    label: channel.label,
    line: channel.line,
    intent: channel.intent,
    ok: probe.ok,
    attribution,
    attributionReasons: detail.reasons,
    profile: probe.profile,
    contract: probe.contract,
    probes: probe.probes,
    contractDrift,
    checks: probe.checks,
    errors: probe.errors,
    hostFatal: probe.hostFatal ?? [],
    probeExit: probe.probeExit ?? null,
    install: probe.install,
    cacheHit: probe.cacheHit,
    durationMs: probe.durationMs,
    riskNote: channel.riskNote,
  };
}

/**
 * 归因判据表（**结构化**，不用裸关键词）。
 *
 * 历史缺陷（评审 🔴-B）：判据曾是裸正则 `/npm|fatal:/`，而探针把插件侧错误也写成
 * `fatal: ...`、把命令行/路径写进错误串 → 路径里含 `npm` 就命中，插件 bug 被报成
 * 上游漂移。第一轮修复改为「宿主侧只认 `fatal(host)` 前缀」——**仍是扫自由文本**。
 *
 * 历史缺陷（评审 🔴-C）：插件文件路径 / 错误文本里出现 `fatal(host)` 字面量即再次翻案。
 * 现在判据**只读结构化字段**：宿主侧 = `probe.hostFatal[]`（探针/装配器显式落字段）+ 宿主侧
 * check 名；插件侧 = 插件侧 check 名。`errors[]` 仅作日志，**任何判据都不读它**。
 *
 * @module dsh-adapt-hub/verify/runner
 */

// 判据表由 `harness/contract.mjs` 提供（探针与执行器共用同一份，防两侧漂移）。
// HOST_FATAL_PREFIX 仅作日志前缀导出，**判据不得读它**（见下）。
export { HOST_FATAL_FIELD, HOST_FATAL_PREFIX, HOST_SIDE_CHECKS, CONTRACT_SIDE_CHECKS, PLUGIN_HARD_EVIDENCE, PLUGIN_SIDE_CHECKS };

/**
 * 失败归因（详细版）：区分「上游漂移」与「插件回归」，并给出可审计的理由链。
 *
 * 判据（按优先级）：
 * 1. **宿主/环境侧**：结构化字段 `probe.hostFatal[]` 非空，或失败项属 {@link HOST_SIDE_CHECKS}
 *    （宿主未就绪 / 版本线不可判定 / 契约探测未卸载）→ `UPSTREAM_DRIFT`。
 *    `errors[]` 是**人类可读日志**（含插件侧 stack / 文件路径），**不参与任何判据**；
 * 2. **版本线 unknown** → `UPSTREAM_DRIFT`；
 * 2b. **插件侧硬证据**（{@link PLUGIN_HARD_EVIDENCE}，如 `guard.reserved_rejected`）
 *    → `PLUGIN_REGRESSION`，**优先于任何漂移相关性**：插件违反宿主硬约束与上游契约是否
 *    漂移无关，漂移窗口内也必须判插件（评审 🔴-C；精确 check 名，不用 `guard.*` 通配）；
 * 3. **契约指纹与基线不一致且漂移字段与失败 check 相关** → `UPSTREAM_DRIFT`；
 * 4. **中台契约 check 失败且无可用基线**（首次采集，无法判定上游是否变了）→ 保守判 `UPSTREAM_DRIFT`；
 * 5. **插件侧 check 失败** → `PLUGIN_REGRESSION`；
 * 6. 有失败但无任何可识别 check（探针被外力打断等）→ `UNKNOWN`（不猜、不甩锅）。
 *
 * 注意：**没有** `ENV_ERROR` 返回点（历史 JSDoc 死声明，v0.1.2 移除）；环境/网络问题
 * 统一由宿主侧结构化信号（`hostFatal[]`，日志前缀 `fatal(host)`）表达，归因为
 * `UPSTREAM_DRIFT`，人按报告原因处理。
 *
 * @param {object} probe 探针结果
 * @param {object} channel 通道定义
 * @param {string} channelName 通道名（进理由链，供报告与排障定位）
 * @param {{contractDrift?: {changed:boolean, items:object[], newBaseline:boolean}}} [evidence] 附加证据
 * @returns {{attribution:'UPSTREAM_DRIFT'|'PLUGIN_REGRESSION'|'UNKNOWN', channel:string, reasons:string[]}}
 */
export function attributionDetail(probe, channel, channelName, evidence = {}) {
  // 注意：**不读 probe.errors**——它是人类可读日志（含插件侧 stack / 路径），读它就会重蹈 🔴-B / 🔴-C。
  const failedChecks = (probe?.checks ?? []).filter((check) => check.status === 'fail');
  const failedNames = new Set(failedChecks.map((check) => check.name));
  const label = channel?.label ?? channelName;
  const reasons = [];

  // 1. 宿主/环境侧：**只读结构化字段** hostFatal[]（绝不扫 errors 自由文本——插件侧 stack/路径
  //    里出现 `fatal(host)` 字面量就会翻案，评审 🔴-C），或失败项属宿主侧 check 名。
  const hostFatal = probe?.[HOST_FATAL_FIELD] ?? [];
  if (hostFatal.length > 0) {
    reasons.push(`[${channelName}] 探针报告宿主/环境侧致命错误（${hostFatal.length} 条，字段 ${HOST_FATAL_FIELD}）：${String(hostFatal[0]).slice(0, 200)}`);
  }
  for (const name of HOST_SIDE_CHECKS) {
    if (failedNames.has(name)) reasons.push(`[${channelName}] 宿主侧检查失败：${name}`);
  }
  // 2. 版本线不可判定
  if (probe?.profile && probe.profile.flavor === 'unknown') reasons.push(`[${channelName}] 版本线探测为 unknown（${probe.profile.evidence ?? ''}）`);
  if (reasons.length > 0) return { attribution: 'UPSTREAM_DRIFT', channel: channelName, reasons };

  // 2b. 插件侧硬证据：优先于漂移相关性（漂移窗口内插件违规仍判插件，评审 🔴-C）
  const hardEvidence = PLUGIN_HARD_EVIDENCE.filter((name) => failedNames.has(name));
  if (hardEvidence.length > 0) {
    return {
      attribution: 'PLUGIN_REGRESSION',
      channel: channelName,
      reasons: [`[${label}] 插件侧硬证据：${hardEvidence.join(',')}（违反宿主硬约束，与上游契约是否漂移无关 → 优先于漂移相关性）`],
    };
  }

  // 3. 契约指纹漂移：仅当**漂移字段与失败点相关**时判上游漂移（不把插件 bug 甩给上游）
  //    注意 `reservedName` 只对应中台自检 `guard.reserved_name`——插件侧的
  //    `guard.reserved_rejected` 已在 2b 拦下，不会被漂移吞掉。
  const drift = evidence.contractDrift;
  if (drift?.changed && drift.items?.length > 0) {
    const fields = new Set(drift.items.map((item) => item.field));
    const related =
      // P2-6：`guard.reserved_rejected` **不入表**（已由 2b 硬证据优先拦下）；`reservedName` 漂移
      // 只对应中台自检 `guard.reserved_name`——上游取消保留名 + 插件自己声明保留名时，
      // 判漂移等于把插件违规甩给上游。
      (fields.has('reservedName') && failedNames.has('guard.reserved_name'))
      || (fields.has('schemaSubset') && failedNames.has('compat.schema_flatten'))
      || (fields.has('configProjection') && failedNames.has('detect.flavor_known'))
      || (fields.has('outputShape') && [...failedNames].some((name) => name.startsWith('dispatch.')));
    if (related) {
      return {
        attribution: 'UPSTREAM_DRIFT',
        channel: channelName,
        reasons: [`[${channelName}] 契约指纹漂移（${[...fields].join(',')}）且漂移字段与失败项相关：${[...failedNames].join(',')}`],
      };
    }
  }

  // 4. 中台契约 check 失败，且**没有可用基线**（首次采集）→ 无法判定上游是否变了，保守判漂移（让人确认）
  const contractChecksFailed = CONTRACT_SIDE_CHECKS.some((name) => failedNames.has(name));
  const noUsableBaseline = !drift || drift.newBaseline === true;
  if (contractChecksFailed && noUsableBaseline) {
    return {
      attribution: 'UPSTREAM_DRIFT',
      channel: channelName,
      reasons: [`[${channelName}] 契约检查失败（${CONTRACT_SIDE_CHECKS.filter((n) => failedNames.has(n)).join(',')}）且无可用基线，保守判上游漂移`],
    };
  }

  // 5. 插件侧 / 中台契约层（上游契约与基线一致 → 不判漂移，不甩锅上游）
  const pluginFailed = PLUGIN_SIDE_CHECKS.filter((name) => failedNames.has(name));
  const compatFailed = CONTRACT_SIDE_CHECKS.filter((name) => failedNames.has(name));
  if (pluginFailed.length > 0 || compatFailed.length > 0) {
    const parts = [];
    if (pluginFailed.length > 0) parts.push(`插件侧检查失败：${pluginFailed.join(',')}`);
    if (compatFailed.length > 0) parts.push(`中台契约层检查失败：${compatFailed.join(',')}（上游契约与基线一致 → 不判漂移）`);
    return {
      attribution: 'PLUGIN_REGRESSION',
      channel: channelName,
      reasons: [`[${label}] ${parts.join('；')}（失败明细见 checks[].detail）`],
    };
  }

  // 6. 有失败但无失败 check / 无可识别 check → 不猜
  return {
    attribution: 'UNKNOWN',
    channel: channelName,
    reasons: [
      failedChecks.length === 0
        ? `[${channelName}] 验收失败但探针未给出失败 check（可能被外力中断），无法归因，需人工看原始 errors`
        : `[${channelName}] 失败项均不在已知归因表内（${[...failedNames].join(',')}），需人工判定`,
    ],
  };
}

/**
 * 失败归因（兼容入口，返回判决字符串）。
 *
 * 判据见 {@link attributionDetail}；理由链可从 `attributionDetail()` 取。
 *
 * @param {object} probe 探针结果
 * @param {object} channel 通道定义
 * @param {string} channelName 通道名
 * @param {{contractDrift?: object}} [evidence] 附加证据
 * @returns {'UPSTREAM_DRIFT'|'PLUGIN_REGRESSION'|'UNKNOWN'}
 */
export function attributeFailure(probe, channel, channelName, evidence = {}) {
  return attributionDetail(probe, channel, channelName, evidence).attribution;
}

/**
 * 运行全通道验收（默认 stable + dev；legacy 由 `--with-legacy` 显式启用）。
 *
 * @param {object} options 选项
 * @param {string[]} [options.channels] 通道列表
 * @param {string} options.pluginPath 被测插件
 * @param {string[]} options.expectedTools 期望工具清单
 * @param {string} [options.hubRoot] 仓库根
 * @param {boolean} [options.offline] 离线
 * @param {object|null} [options.previousContracts] 契约指纹基线（channel → contract）
 * @returns {{generatedAt:string, plugin:string, channels:object[], summary:object}}
 */
export function verifyAll(options) {
  const channels = options.channels ?? ['stable', 'dev'];
  const previousContracts = options.previousContracts !== undefined
    ? options.previousContracts
    : (contractSnapshot({ hubRoot: options.hubRoot ?? HUB_ROOT }).load()?.contracts ?? null);
  const reports = channels.map((channel) => verifyChannel({ ...options, previousContracts, channel }));
  return {
    generatedAt: new Date().toISOString(),
    plugin: options.pluginPath,
    channels: reports,
    summary: summarize(reports),
  };
}

/**
 * 汇总（供二级信息 / 看板消费）。
 *
 * @param {object[]} reports 通道报告
 * @returns {object}
 */
export function summarize(reports) {
  const total = reports.length;
  const passed = reports.filter((r) => r.ok).length;
  const drift = reports.filter((r) => r.attribution === 'UPSTREAM_DRIFT');
  const regression = reports.filter((r) => r.attribution === 'PLUGIN_REGRESSION');
  return {
    total,
    passed,
    failed: total - passed,
    upstreamDrift: drift.map((r) => r.channel),
    pluginRegression: regression.map((r) => r.channel),
    contractDrift: reports.filter((r) => r.contractDrift?.changed).map((r) => r.channel),
    unknown: reports.filter((r) => r.attribution === 'UNKNOWN').map((r) => r.channel),
    verdict: total > 0 && passed === total ? 'GREEN' : regression.length > 0 ? 'RED' : drift.length > 0 ? 'AMBER' : 'UNKNOWN',
  };
}

/**
 * 校验插件文件存在。
 *
 * @param {string} pluginPath 插件路径
 * @returns {string} 绝对路径
 */
export function resolvePlugin(pluginPath) {
  const abs = path.resolve(pluginPath);
  if (!existsSync(abs)) throw new Error(`被测插件不存在：${abs}`);
  return abs;
}
