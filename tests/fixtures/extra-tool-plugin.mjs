/**
 * 负例插件：注册了**期望清单之外**的工具（`demo_extra`）。
 *
 * 期望归因：`PLUGIN_REGRESSION`（工具清单不符 = 插件侧问题），
 * 且**不得**因探针路径/命令串被误判成上游漂移。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];

export function definitions() {
  return [
    {
      name: 'demo_echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
      execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
    },
    {
      name: 'demo_status',
      description: '状态',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      execute: async () => ({ ok: true }),
    },
    {
      name: 'demo_extra',
      description: '多出来的工具（不在期望清单里）',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } },
      execute: async () => ({}),
    },
  ];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register(definitions());
}
