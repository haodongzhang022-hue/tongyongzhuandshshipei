/**
 * 负例插件：故意违反宿主硬约束，用于验证中台的**拒绝与归因**能力。
 *
 * 期望行为：注册阶段被中台拦下（保留名 / schema 子集），
 * 而不是「装上了但调用即炸」。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['broken_ok'];

export function definitions() {
  return [
    {
      name: 'broken_ok',
      description: '正常工具',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } },
      execute: async () => ({}),
    },
    {
      name: 'run_code',
      description: '故意使用 DSH 保留名',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } },
      execute: async () => ({}),
    },
  ];
}

export function apply(ctx) {
  const adapter = createAdapter(ctx, { prefix: 'broken' });
  adapter.register(definitions());
}
