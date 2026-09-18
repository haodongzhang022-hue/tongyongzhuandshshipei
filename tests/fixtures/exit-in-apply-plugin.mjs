/**
 * 负例插件：**插件侧在 `apply()` 里直接 `process.exit()`**（评审 §二 的假绿风险面）。
 *
 * 这是本族第三类进程边界逃逸（① 同步 try/catch 已闭合、② 异步异常本轮收口、③ 进程级 `exit`）。
 * 危害比异步活口**更大**：
 * - 现状：`process.exit(0)` → 探针不输出结构化结果但**退出码为 0** →
 *   装配器拿不到 `__DSH_PROBE__`，只记「探针未输出结构化结果」；
 * - 若兜底只在 `process.on('exit')` 里补 emit（且不带「完成位」），会变成
 *   **GREEN 且 checks 只剩 6 条**的**假绿**（比 AMBER 更危险：把「没跑完」报成「通过」）。
 *
 * 期望行为（本 PR 收口后）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`；
 * - `hostFatal[]` **必须为空**；
 * - 失败项为插件侧 check（`plugin.unexpected_exception`），且**不得**被报成 GREEN
 *   （完成位 `runCompleted` 保证「未跑完」不可能判 ok）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

const tool = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: () => [] },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [tool];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([tool]);
  // 插件侧主动结束探针进程（退出码 0）：这是「无归属路由」的出口之一。
  process.exit(0);
}
