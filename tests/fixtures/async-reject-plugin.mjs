/**
 * 负例插件：**插件侧未处理 Promise 拒绝**（异步活口第二形态）。
 *
 * 与 `async-throw-plugin.mjs` 同族但走 `unhandledRejection` 通道：
 * Node 对未处理拒绝的默认行为随版本/参数变化（`--unhandled-rejections`），
 * 若只接 `uncaughtException` 就会在默认 `throw` 模式下漏掉这一形态。
 *
 * 期望行为：同 `async-throw-plugin.mjs`（`PLUGIN_REGRESSION`/RED、`hostFatal[]` 为空、
 * 失败项 `plugin.unexpected_exception`、结构化结果照常输出）。
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
  // 未处理的 Promise 拒绝：同样在 `apply` 返回之后才发生。
  void Promise.reject(new Error('插件未处理拒绝：apply 返回后 Promise 拒绝（async-reject-plugin）'));
}
