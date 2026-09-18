/**
 * DSH 适配中台（dsh-adapt-hub）公共导出面。
 *
 * 一句话定位：把「每个插件都要重复做一遍的 DSH 适配」固化成**一处能力**——
 * 版本线探测 / 契约兼容层 / 双通道（稳定版 + 开发版）验收 / 上游变更侦测。
 *
 * 使用（插件侧，零 @deepseek-ai 依赖）：
 * ```js
 * // my-plugin/index.mjs
 * import { createAdapter } from '@dongdongxiaozu/dsh-adapt-hub/adapter';
 * // 或从根导出面取：import { createAdapter } from '@dongdongxiaozu/dsh-adapt-hub';
 * export const inject = ['tools'];
 * export function apply(ctx) {
 *   const adapter = createAdapter(ctx, { prefix: 'myplugin' });
 *   adapter.register([ { name:'myplugin_echo', ... } ]);
 * }
 * ```
 *
 * @module dsh-adapt-hub
 */

export { detectHostFlavor, adaptByFlavor, HostProfile } from './detect/flavor.mjs';
export { normalizeSchema, collectSchemaViolations, assertSupportedSchema } from './compat/schema.mjs';
export {
  RESERVED_TOOL_NAMES,
  assertNotReserved,
  defaultRender,
  normalizeToolDefinition,
  wrapExecute,
  registerTools,
} from './compat/tool.mjs';
export { loadChannels, pinsToSpecs, channelFingerprint, runHostProbe, pruneHostCache, HUB_ROOT } from './harness/host.mjs';
export { verifyChannel, verifyAll, summarize, attributeFailure, attributionDetail, resolvePlugin } from './verify/runner.mjs';
export { collectContract, CONTRACT_PROBES, CONTRACT_PROBE_NAMES } from './harness/contract.mjs';
export { watchUpstream, fetchDistTags, contractSnapshot, diffContracts } from './watch/upstream.mjs';
export { buildSecondary, toMarkdown } from './report/secondary.mjs';
export { createAdapter } from './adapter.mjs';
export { VERSION } from './version.mjs';
