/**
 * 负例插件：`apply(ctx)` 抛错（插件侧初始化失败）。
 *
 * 期望归因：`PLUGIN_REGRESSION`（历史缺陷：曾被统一写成 `fatal:` → 误判上游漂移）。
 */
export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

export function definitions() {
  return [
    {
      name: 'demo_echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
      execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
    },
  ];
}

export function apply() {
  throw new Error('插件自身初始化失败：缺少必需配置');
}
