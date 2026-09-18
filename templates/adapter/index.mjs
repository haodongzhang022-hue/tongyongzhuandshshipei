/**
 * 中台自测用的**示例插件**（同时是给插件作者的模板）。
 *
 * 注意本文件**不 import 任何 @deepseek-ai/* 符号**——这正是中台要达成的效果：
 * 插件产物与宿主版本解耦，上游换版不必改插件代码。
 */
import { createAdapter } from '../../src/adapter.mjs';

/** 声明只依赖宿主 tools 服务（新旧版语义一致）。 */
export const inject = ['tools'];

/** 供验收脚本读取的工具名清单。 */
export const expectedTools = ['demo_echo', 'demo_status'];

/**
 * 工具定义（纯业务，无宿主版本代码）。
 *
 * @param {{ profile?: {flavor?:string, evidence?:string} }} [options] 宿主画像（由中台探测后传入）
 * @returns {object[]}
 */
export function definitions(options = {}) {
  const profile = options.profile ?? { flavor: 'unknown', evidence: 'not-detected' };
  return [
    {
      name: 'demo_echo',
      description: '回显输入文本（示例工具）',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '待回显文本' } }, required: ['text'] },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
    },
    {
      name: 'demo_status',
      description: '返回适配中台探测到的宿主画像（示例工具）',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { flavor: { type: 'string' }, evidence: { type: 'string' } },
          required: ['flavor', 'evidence'],
        },
      },
      execute: async () => ({ flavor: String(profile.flavor ?? 'unknown'), evidence: String(profile.evidence ?? '') }),
    },
  ];
}

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx 宿主上下文
 */
export function apply(ctx) {
  const adapter = createAdapter(ctx, { prefix: 'demo' });
  adapter.register(definitions({ profile: adapter.profile.toJSON() }));
}
