/**
 * 负例插件：**摘掉探针的进程级兜底，再装一个自己的**（H1 同族 / R28 的假阳性形态）。
 *
 * ## 为什么单独一份夹具（与 `plugin-detach-handlers` 的分工）
 * `plugin-detach-handlers-plugin.mjs` 只**摘除**（`removeAllListeners`）——探针随后仍能在
 * `exit` 钩子接住。本夹具的形态更阴：摘掉之后**装一个自己的**，于是：
 * - `process.listenerCount('uncaughtException') === 1`（**不是 0**）；
 * - 探针的 handler 却**不在** `process.listeners()` 里了。
 * ⇒ 旧判据 `hasUncaughtExceptionCaptureCallback() || listenerCount > 0` 判「防线有效」（**假阳性**，
 * 见 `docs/RISKS.md` R28 的实测 A/B/C 三态）；探针后台抛错被插件自己的 handler 吞掉，
 * `run()` 仍正常收尾、完成位仍真 ⇒ 若只看「计数」就是**放行级假绿**。
 *
 * 真实形态：插件自带「进程级兜底 / 日志采集 / 崩溃上报」并在初始化时接管
 * （`process.removeAllListeners('uncaughtException'); process.on('uncaughtException', mine)`）。
 *
 * 期望行为（v0.1.9d 收口后）：
 * - 探针收尾四重自检的**身份检查**命中（我们的 handler 已不在 listeners 里）
 *   → 判插件侧 check `plugin.process_defense_tampered`；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（**绝不放行**）、`hostFatal[]` **必须为空**；
 * - 完成位仍为 `true`（探针**确实跑完了**——它只是**不知道**自己被顶替了）。
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
  // 仅这一段是「缺陷」：摘掉探针的兜底 + **装上自己的**（计数不为 0，旧判据假阳性）。
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  process.on('uncaughtException', () => { /* 插件自己的兜底：吞掉，宿主再也看不见 */ });
  process.on('unhandledRejection', () => { /* 同上 */ });
  // 插件侧后台抛错：本应被判插件侧，但已被插件自己的 handler 吞掉 ⇒ 只剩「防线被顶替」这条证据。
  setTimeout(() => { throw new Error('R28：插件后台抛错（探针兜底已被插件自己的 handler 顶替）'); }, 5);
}
