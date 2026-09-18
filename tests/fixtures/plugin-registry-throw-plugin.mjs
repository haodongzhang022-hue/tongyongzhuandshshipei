/**
 * 负例插件：**枚举工具清单**时插件侧数据抛错（评审 🔴-D 的第二条逃逸路径）。
 *
 * 与 `plugin-side-throw-plugin.mjs` 的分工：
 * - 那份坏在 `definitions()`（探针第 11 段读 `definitions.map((d) => d?.name)`）；
 * - 本份坏在**已注册进宿主**的定义（探针第 6 段 `tools.schemas()` 枚举时读 `parameters`）。
 *
 * 为什么用 `parameters` 的 getter：宿主 `register()` 只读 `definition.name` 与 `definition.output`，
 * **不读** `parameters`——所以注册能成功，而 `tools.schemas()` 投影时读 `parameters` 才抛错。
 * 这正是「插件自己写错、却只有探针读数据时才炸」的真实形态（不是刻意构造的调用顺序）。
 *
 * 期望行为：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`；
 * - `hostFatal[]` **必须为空**；
 * - 失败项是插件侧 check（`registry.exact`），后续检查标 `skip`（报告里看得见「没验」）。
 *
 * 历史缺陷：`tools.schemas()` 的异常逃到顶层 catch → `pushHostFatal()` → 误判 `UPSTREAM_DRIFT`。
 */
export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 注册进宿主的工具定义：`parameters` 由 getter 派生自未初始化字段（插件侧 bug）。 */
const definition = {
  name: 'demo_echo',
  description: '回显',
  /** 故意读未初始化字段：宿主 `register()` 不碰它，`tools.schemas()` 投影时才抛 TypeError。 */
  get parameters() {
    return this.config.properties;
  },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: () => [] },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [];
}

export function apply(ctx) {
  // 注册本身会成功（宿主只校验 name / output）——异常留到探针枚举工具清单时抛出
  ctx.tools.register(definition);
}
