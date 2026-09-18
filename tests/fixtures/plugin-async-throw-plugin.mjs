/**
 * 负例插件：**插件侧异步异常**（评审 🔴-D 同族活口的原始复现，第一种形态：`uncaughtException`）。
 *
 * 这不是「刻意构造」的错误——它是插件作者最常见的缺陷形态之一：
 * 在 `apply()` 里排一个后台任务 / 事件回调 / 预取，回调抛错。
 *
 * 关键性质：该异常**不在** `run()` 的调用栈上，所以探针的顶层 `catch` **永远接不到**它。
 * 历史缺陷（本夹具要复现的）：
 *   1. 探针在写出 `__DSH_PROBE__` 之前被 Node 杀掉（默认 `uncaughtException` 行为）；
 *   2. 装配器只看到「探针未输出结构化结果」→ 无条件 `pushHostFatal()`
 *      → 判据 1 → `UPSTREAM_DRIFT`/AMBER（插件 bug 被甩给上游）；
 *   3. `checks` 从 17 掉到 **0**（整份报告消失，比「盖掉一条 check」更彻底）。
 *
 * 期望行为（修复后）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）；
 * - `hostFatal[]` **必须为空**（插件侧错误永远不进判据字段——`contract.mjs` 的不变量）；
 * - 失败项是插件侧 check `plugin.async_uncaught_exception`（已登记 `PLUGIN_SIDE_CHECKS`）；
 * - 已跑完的 check **全部保留**，未跑到的按规范顺序标 `skip`（报告形态与正常失败一致）；
 * - `probePhase = plugin-integration`（异常归属依据，可排障）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 健康工具：保证 `apply()` 本身成功、工具清单精确匹配——把失败点精确留在「后台任务抛错」上。 */
const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: () => [] },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [healthy];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这一行是「缺陷」：插件侧后台任务抛错（真实形态：异步预取 / 事件回调 / 定时器）
  queueMicrotask(() => {
    throw new Error('plugin background task bug（插件后台任务抛错，与宿主无关）');
  });
}
