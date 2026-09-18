/**
 * 负例插件：后台任务占死事件循环（评审 🔴-D′ 的第四条路径）。
 *
 * 形态来源：插件在 `apply()` 里排的同步重活（大 JSON 解析 / 加密 / 同步 IO）跑飞——
 * 事件循环被**同步**占死，任何定时器（含探针看门狗）都排不上。
 *
 * 与另三份的分工：本份是**唯一**一份「探针内处理器还在、但都没机会跑」的形态，
 * 用来验证看门狗窗口的**边界语义**（显式声明，不越权承诺）：
 * - 占死时长**短于**看门狗窗口 → 看门狗在事件循环空出后如期收尾（本夹具取 12s > 10s 窗口）；
 * - 占死时长**超过**看门狗窗口 → 只能等外层 `execFileSync` 超时（`timeoutMs`，默认 600s），
 *   之后由**带外**侧信道相位归因（仍判插件侧、`hostFatal` 为空、`checks` 非空）——
 *   这是「探针内一切都没机会跑」时唯一可行的口径，本夹具注释如实声明。
 *
 * 期望行为：`PLUGIN_REGRESSION` / RED / `hostFatal[]` 为空 / 失败项
 * `plugin.async_uncaught_exception`（微任务抛错先被接住，随后看门狗收尾）/ `checks` 非空。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 占死事件循环的时长（毫秒）——取略大于看门狗窗口（10s），验证「占死结束后看门狗仍如期收尾」。 */
const BUSY_MS = 12_000;

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

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这两行是「缺陷」：微任务抛错（会被兜底接住）+ 同步占死事件循环（看门狗排不上）
  queueMicrotask(() => {
    throw new Error('plugin background task bug（事件循环被占死前抛出的异步异常）');
  });
  setTimeout(() => {
    const end = Date.now() + BUSY_MS;
    while (Date.now() < end) { /* 同步占死：真实形态是跑飞的同步重活 */ }
  }, 5);
}
