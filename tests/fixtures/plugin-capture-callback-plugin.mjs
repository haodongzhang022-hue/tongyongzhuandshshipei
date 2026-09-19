/**
 * 负例插件：**插件抢占进程级异常捕获回调**（评审复评 H1 的原始复现：**放行级假绿**，
 * 风险行见 `docs/RISKS.md` R22 / R23）。
 *
 * Node 语义（H1 的机理）：`process.setUncaughtExceptionCaptureCallback(cb)` 一旦被设置，
 * `uncaughtException` **监听器不再被调用**（官方语义：capture callback 存在时监听器被停用）。
 * 于是探针出口②（进程级异步异常兜底）被**静音**：插件后台抛错完全不可见、`run()` 仍正常收尾、
 * 完成位仍为真 ⇒ 整轮判 **GREEN / PASS（放行）**。
 *
 * 真实形态：插件（或其依赖）引入 Sentry / APM / 错误上报 / 日志库，这些库初始化时会抢占该
 * **独占** API——**不是**刻意攻击，是普通工程实践。这比「判 AMBER」危险得多（AMBER 至少不放行）。
 *
 * 期望行为（H1 收口后）：
 * - 探针收尾自检 `process.hasUncaughtExceptionCaptureCallback()` + 监听器计数 → 判插件侧
 *   check `plugin.process_defense_tampered`；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（**绝不放行**）、`hostFatal[]` **必须为空**；
 * - 已跑完的检查全部保留（报告不丢）。
 *
 * ⚠️ 口径（不越权承诺）：本项**只能在探针还活着时**判。插件若让探针**整个进程**消失
 * （`SIGKILL` / `process.exit` / 挂住），本项同样来不及判——那时由出口③④ 或装配器按相位信标归因。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  // 真实 render（评审 🟡-5：`render: () => []` 会让 dispatch.render_projected / echo_payload
  // 额外失败，噪声掩盖「失败点精确留在抢占捕获回调」的自述）。走中台默认投影。
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [healthy];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // H1 的**一行**复现：抢占独占 API（真实形态：Sentry / 日志上报库）→ 探针的
  // `uncaughtException` 监听器被停用（Node 语义），进程级兜底静音。
  process.setUncaughtExceptionCaptureCallback((error) => { void error; });
  // 插件侧后台抛错：本应被探针兜住（判插件侧），但在 capture callback 下**不可见**。
  queueMicrotask(() => { throw new Error('H1：插件后台抛错（探针防线被 captureCallback 静音）'); });
}
