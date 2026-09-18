/**
 * 负例插件：**插件侧异步抛错**（评审 🔴-D 异步活口的原始复现）。
 *
 * 与 `plugin-side-throw-plugin.mjs` 的分工：
 * - 那两份是「同步读插件侧数据时抛错」（在探针 `try` 内可被护栏接住）；
 * - 本份的异常发生在 `apply()` **返回之后**（微任务 / 未处理 Promise 拒绝），
 *   探针的同步 `try/catch` 完全看不见它 —— 异常逃到 Node 进程级，
 *   探针既不输出结构化结果也不归属 → 装配器只能记「探针未输出结构化结果」→ `hostFatal[]` 非空
 *   → 判 `UPSTREAM_DRIFT`/AMBER（插件 bug 甩给上游）。
 *
 * 期望行为（本 PR 收口后）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）；
 * - `hostFatal[]` **必须为空**（插件侧错误永远不进判据字段）；
 * - 失败项为插件侧 check（`plugin.unexpected_exception`）；
 * - 探针**照常输出** `__DSH_PROBE__`（`checks` 不丢）。
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
  // 插件侧异步错误：`apply` 已正常返回，探针同步 try/catch 看不见它。
  // 逃到进程级后必须被探针的进程级钩子接住并落**插件侧** check（绝不进 hostFatal[]）。
  queueMicrotask(() => { throw new Error('插件异步抛错：apply 返回后微任务里炸（async-throw-plugin）'); });
}
