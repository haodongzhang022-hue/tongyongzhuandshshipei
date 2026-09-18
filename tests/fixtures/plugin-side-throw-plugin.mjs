/**
 * 负例插件：**插件侧**未初始化类字段 / 抛错 getter（评审 🔴-D 的原始复现）。
 *
 * 这不是「刻意构造」的错误——它是插件作者最常见的写法错误之一：
 * 工具定义用类实例承载，`name` 由 getter 从**尚未初始化**的字段派生。
 *
 * 期望行为（🔴-D 修复后）：
 * - 归因 `PLUGIN_REGRESSION`（插件 bug，不是上游变了），`verdict = RED`（不放行）；
 * - `hostFatal[]` **必须为空**（插件侧错误永远不进判据字段——`contract.mjs` 的不变量）；
 * - 失败项必须是**插件侧 check**（`guard.reserved_rejected` / `registry.exact` /
 *   `plugin.unexpected_exception`），不得是宿主侧 check。
 *
 * 历史缺陷：探针读插件侧数据（`tools.schemas()` / `definitions.map()`）没有护栏，
 * 异常逃到顶层 catch 被 `pushHostFatal()` 写成宿主侧致命信号 → 判 `UPSTREAM_DRIFT`/AMBER，
 * 并把插件侧已失败的 check 整条盖掉（「上游变了，不是你的问题」）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 正常工具（保证 `apply()` 本身能成功，把失败点精确留在「读插件侧 definitions」上）。 */
const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  // 真实 render（默认投影）：`render: () => []` 会让 dispatch.render_projected / echo_payload
  // 额外失败，噪声掩盖「失败点精确留在『读插件侧数据』」的自述（评审 🟡-5）。
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

/**
 * 坏定义：`name` 由 getter 派生自**未初始化**字段。
 *
 * 探针第 11 段读 `definitions.map((d) => d?.name)` 时触发本 getter → 抛 `TypeError`。
 * 该异常是**插件侧**的，必须落插件侧 check（`guard.reserved_rejected`）。
 */
class UninitializedDefinition {
  /** 故意不初始化 `config`：读 `this.config.name` 抛 TypeError（插件侧 bug）。 */
  get name() {
    return this.config.name;
  }

  get description() {
    return '坏定义（未初始化字段）';
  }

  parameters = { type: 'object', properties: { text: { type: 'string' } } };

  // 真实 render（默认投影）：见上方说明（评审 🟡-5）。
  output = { schema: { type: 'object', properties: { text: { type: 'string' } } } };

  execute = async (args) => ({ text: `echo: ${args?.text ?? ''}` });
}

export function definitions() {
  return [healthy, new UninitializedDefinition()];
}

export function apply(ctx) {
  // 只注册健康工具 → `apply_ok` 通过；异常留到探针读 `definitions` 时抛出
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
}
