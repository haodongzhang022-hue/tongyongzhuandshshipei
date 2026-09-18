/**
 * 负例插件：`apply()` 返回**永不 settle** 的 promise + 后台任务抛错（评审 🔴-D′ 必修中的必修）。
 *
 * 这不是「刻意构造」——它是「插件在 `apply()` 里 await 一个永不 resolve 的初始化
 * （等外部服务 / 等一个漏了 resolve 的 promise）」+「后台任务写坏」的真实叠加形态。
 *
 * 关键性质：`await plugin.apply(...)` 永不返回，探针**挂住**；此时事件循环已空
 * （只剩一个挂起的 top-level await），Node 以「unsettled top-level await」直接退出
 * （退出码 **13**）。
 *
 * 历史缺陷（本夹具要复现的）：
 *   1. 看门狗定时器被 `unref()`——空事件循环下它**不算「有活儿」**，永不触发
 *      （注释里「看门狗兜住 run() 被拖住」这条声明，在它被写出来的那个场景里**不可达**）；
 *   2. 探针在写出 `__DSH_PROBE__` 之前被杀 → 装配器只看到「探针未输出结构化结果」
 *      → 无条件 `pushHostFatal()` → `UPSTREAM_DRIFT`/AMBER，`checks` 从 17 掉到 **0**；
 *   3. 插件侧 bug 被写成「上游变了，不是你的问题」。
 *
 * 期望行为（修复后）：
 * - 看门狗（保持 ref）在 `ASYNC_WATCHDOG_MS` 后**如期收尾**：输出结构化结果 + 退出码 1；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）；
 * - `hostFatal[]` **必须为空**（插件侧错误永远不进判据字段）；
 * - 失败项是**探针侧**插件 check `plugin.async_uncaught_exception`
 *   （**不是**装配器侧的 `plugin.probe_aborted`——后者出现即说明看门狗又失效了）；
 * - `checks` 非空（17 项按规范顺序标 `skip` + 1 条 fail），`probePhase = plugin-integration`。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 健康工具：保证 `apply()` 之前的步骤都正常，失败点精确落在「apply 挂住 + 后台抛错」上。 */
const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [healthy];
}

export async function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这两行是「缺陷」：后台任务抛错 + apply() 永不 settle（真实形态：漏了 resolve 的初始化）
  setTimeout(() => {
    throw new Error('plugin background task bug（插件后台任务抛错，与宿主无关）');
  }, 5);
  await new Promise(() => { /* 永不 settle：插件侧初始化卡死 */ });
}
