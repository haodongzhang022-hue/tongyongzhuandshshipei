/**
 * 负例插件：**插件侧提前退出进程**（评审 🔴 必修-2 的原始复现：进程 exit 出口）。
 *
 * 这不是「刻意构造」的怪癖——真实形态很常见：插件在 `apply()` 里做启动自检 / 参数校验，
 * 失败或成功时顺手 `process.exit(0)`（把宿主进程当成自己的 CLI 进程）。
 *
 * 关键性质：`process.exit()` **不抛异常**，所以探针的顶层 `catch` 与
 * `uncaughtException` 处理器**都接不到**它——`run()` 再也回不来。
 * 历史缺陷（本夹具要复现的）：
 *   1. 探针在写出 `__DSH_PROBE__` 之前就没了 → 装配器只看到「探针未输出结构化结果」
 *      → 无条件 `pushHostFatal()` → 判据 1 → `UPSTREAM_DRIFT`/AMBER（插件 bug 甩给上游）；
 *   2. `checks` 从 17 掉到 **0**（整份报告消失）。
 * 而「顺手加个 exit 钩子」若**不带完成位**，会走向另一个更危险的结局：
 *   `apply()` 里 `process.exit(0)` → 剩余检查是 `skip` 不是 `fail` → `errors.length === 0`
 *   → **GREEN / PASS / checks=6（假绿，比 AMBER 更危险）**。
 *
 * 期望行为（修复后）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）；
 * - `hostFatal[]` **必须为空**（插件侧错误不进判据字段——`contract.mjs` 的不变量，**前提：探针进程内防线未被插件干预**）；
 * - 失败项是插件侧 check `plugin.early_exit`（已登记 `PLUGIN_SIDE_CHECKS`）；
 * - 已跑完的 check **全部保留**（含 pass），未跑到的按规范顺序标 `skip`；
 * - `runCompleted = false`（完成位），`probePhase = plugin-integration`。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 健康工具：保证 `apply()` 前半段成功、工具清单精确匹配——把失败点精确留在「提前退出」上。 */
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
  // 仅这一行是「缺陷」：插件把宿主进程当成自己的 CLI 进程，验收途中直接退出（exit code 0）
  process.exit(0);
}
