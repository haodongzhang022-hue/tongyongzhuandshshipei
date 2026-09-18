/**
 * 负例插件：**插件侧异步异常**（评审 🔴-D 同族活口的第二种形态：`unhandledRejection`）。
 *
 * 与 `plugin-async-throw-plugin.mjs` 的分工：
 * - 那份走 `uncaughtException`（同步抛出被排进微任务队列）；
 * - 本份走 `unhandledRejection`（promise 拒绝且无人 `.catch`）——**另一条代码路径**，
 *   探针需要**两个**处理器分别兜住（只兜一个 = 活口搬了个位置，正是本族历史教训）。
 *
 * 期望行为与那份一致：`PLUGIN_REGRESSION` / RED / `hostFatal[]` **必须为空** /
 * 失败项 `plugin.async_uncaught_exception` / `probePhase = plugin-integration`。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

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
  // 仅这一行是「缺陷」：插件侧预取 promise 拒绝且无人处理
  void Promise.reject(new Error('plugin prefetch rejected（插件预取 promise 拒绝，与宿主无关）'));
}
