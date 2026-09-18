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
  const attribution = probe.ok
    ? 'PASS'
    : attributeFailure(probe, channel, options.channel, { contractDrift });
  return {
    channel: options.channel,
    label: channel.label,
    line: channel.line,
    intent: channel.intent,
    ok: probe.ok,
    attribution,
    profile: probe.profile,
    contract: probe.contract,
    contractDrift,
    checks: probe.checks,
    errors: probe.errors,
    install: probe.install,
    cacheHit: probe.cacheHit,
    durationMs: probe.durationMs,
    riskNote: channel.riskNote,
  };
}

/**
 * 失败归因：区分「上游漂移」与「插件回归」。
 *
 * 判据（保守，宁可报 UPSTREAM_DRIFT 让人确认，也不静默归为插件 bug）：
 * 1. 安装阶段失败（钉版包缺失 / peer 解析失败）→ `UPSTREAM_DRIFT`（上游包结构变了）；
 * 2. 宿主未就绪 / 版本线探测为 unknown / 探针 fatal → `UPSTREAM_DRIFT`；
 * 3. **契约指纹与基线不一致**（保留名措辞 / schema 子集校验措辞 / output 形状）→ `UPSTREAM_DRIFT`；
 * 4. 契约采集本身失败（本次指纹为空）→ `UPSTREAM_DRIFT`（无法判定上游，宁可让人确认）；
 * 5. 其余（工具清单不符 / dispatch 失败 / 取消语义失败 / 卸载残留）→ `PLUGIN_REGRESSION`。
 *
 * 注：第 3 条按**真实 check 名**（`guard.reserved_name` / `compat.schema_flatten` /
 * `contract.*`）与基线 diff 判定，不再使用不存在的 check 名（旧版 `register.count`
 * 是死判据）。
 *
 * @param {object} probe 探针结果
 * @param {object} channel 通道定义
 * @param {string} channelName 通道名
 * @param {{contractDrift?: {changed:boolean, items:object[], newBaseline:boolean}}} [evidence] 附加证据
 * @returns {'UPSTREAM_DRIFT'|'PLUGIN_REGRESSION'|'ENV_ERROR'}
 */
export function attributeFailure(probe, channel, channelName, evidence = {}) {
  const errors = probe.errors.join('\n');
  if (/离线模式下缺少宿主依赖缓存|npm|ETARGET|notarget|ERESOLVE|装配失败/.test(errors)) return 'UPSTREAM_DRIFT';
  if (/host\.tools_ready|fatal:/.test(errors)) return 'UPSTREAM_DRIFT';
  if (probe.profile && probe.profile.flavor === 'unknown') return 'UPSTREAM_DRIFT';
  if (/detect\.flavor_known/.test(errors)) return 'UPSTREAM_DRIFT';
  // 契约指纹漂移：仅当**漂移字段与失败点相关**时判上游漂移（不把插件 bug 甩给上游）
  const drift = evidence.contractDrift;
  if (drift?.changed && drift.items?.length > 0) {
    const fields = new Set(drift.items.map((item) => item.field));
    const failedNames = new Set((probe.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name));
    const related =
      (fields.has('reservedName') && (failedNames.has('guard.reserved_name') || failedNames.has('guard.reserved_rejected')))
      || (fields.has('schemaSubset') && failedNames.has('compat.schema_flatten'))
      || (fields.has('configProjection') && failedNames.has('detect.flavor_known'))
      || (fields.has('outputShape') && [...failedNames].some((n) => n.startsWith('dispatch.')));
    if (related) return 'UPSTREAM_DRIFT';
  }
  // 契约相关 check 失败，且**没有可用基线**（首次采集）→ 无法判定上游是否变了，保守判漂移（让人确认）；
  // 有基线且基线一致 → 上游契约没变，责任在插件侧（继续往下判）。
  const contractChecksFailed = /guard\.reserved_name|compat\.schema_flatten/.test(errors);
  const noUsableBaseline = !drift || drift.newBaseline === true;
  if (contractChecksFailed && noUsableBaseline) return 'UPSTREAM_DRIFT';
  if (/plugin\.loaded|registry\.exact|dispatch\.|lifecycle\./.test(errors)) return 'PLUGIN_REGRESSION';
  return 'PLUGIN_REGRESSION';
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
