/**
 * 负例插件：先摘掉进程级异常处理器再抛错（评审 🔴-D′ 的第三条路径）。
 *
 * 形态来源：插件自带「进程级兜底」或「日志采集」，初始化时先
 * `process.removeAllListeners('uncaughtException')` 再接管——一旦它自己写坏，
 * 宿主侧刚挂上的兜底也被一并摘掉。
 *
 * 关键性质：这是**针对性**摘除——探针的兜底只在它自己还挂着时有效。
 * 只要插件能改 `process` 上的监听器，探针内任何处理器都不是安全网。
 *
 * 历史缺陷：探针被 Node 默认行为杀掉 → 装配器「探针未输出结构化结果」→
 * 无条件 `pushHostFatal()` → `UPSTREAM_DRIFT`/AMBER 且 `checks = 0`。
 *
 * 期望行为（修复后，靠**带外**侧信道相位归因）：`PLUGIN_REGRESSION` / RED /
 * `hostFatal[]` 为空 / 失败项 `plugin.probe_aborted` / `checks` 非空 /
 * `probePhase = plugin-integration`。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

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
  // 仅这一段是「缺陷」：先摘掉进程级兜底，再抛错（真实形态：插件自带兜底/日志采集抢监听器）
  setTimeout(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    throw new Error('plugin background task bug（处理器已被插件摘除，探针兜底接不到）');
  }, 5);
}
