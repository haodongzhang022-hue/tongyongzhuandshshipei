/**
 * 负例插件：**插件抢占进程级异常捕获回调**（评审复评 H1 的原始复现）。
 *
 * ⚠️ **已知活口（v0.1.9 修法 A，见 `docs/RISKS.md` R22）**：本夹具在当前实现下
 * **不被拦下**（判 GREEN / 放行）——它存在的意义是把 H1 的复现形态**固化进仓库**，
 * 作为 v0.1.9 修法 A 的验收资产（修完后本夹具必须 → `PLUGIN_REGRESSION`/RED）。
 *
 * Node 语义（H1 的机理）：
 * `process.setUncaughtExceptionCaptureCallback()` 一旦设置，`uncaughtException`
 * **监听器不再被调用**（官方语义：capture callback 存在时监听器被停用）。
 * 于是探针的进程级兜底（出口②）被**静音**——插件侧后台抛错完全不可见，
 * `run()` 仍正常收尾 → 完成位置真 → 整轮判 **GREEN**。
 *
 * 真实形态：插件（或其依赖）引入 Sentry / APM / 错误上报 / 日志库，这些库会在
 * 初始化时抢占该独占 API——**不是**刻意攻击，是常见工程实践。
 *
 * 期望行为（**v0.1.9 修法 A 落地后**）：
 * - 探针**启动时抢占**该 API → 插件后设会自己抛 `ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET` → 归因插件侧；
 * - 或探针收尾自检 `process.hasUncaughtExceptionCaptureCallback() || listenerCount('uncaughtException') > 0`
 *   失效 → 判插件侧 check `plugin.process_defense_tampered`；
 * - 最终：归因 `PLUGIN_REGRESSION`、`verdict = RED`、`hostFatal[]` 为空、**不得** GREEN。
 *
 * 本夹具**不进 CI 闸门**（当前形态下它被判 GREEN，进闸门即红——那正是 H1 未修的证明；
 * v0.1.9 修法 A 落地后把它加进 `tests/gate_plugin_side.sh`）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo', 'demo_status'];

export function definitions() {
  return [
    {
      name: 'demo_echo',
      description: '回显输入文本（示例工具）',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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
      execute: async () => ({ flavor: 'modern', evidence: 'fixture' }),
    },
  ];
}

export function apply(ctx) {
  const adapter = createAdapter(ctx, { prefix: 'demo' });
  adapter.register(definitions());
  // H1 的**一行**复现：抢占独占 API（真实形态：Sentry / 日志上报库）→ 探针的
  // `uncaughtException` 监听器被停用（Node 语义），进程级兜底静音。
  process.setUncaughtExceptionCaptureCallback((error) => { void error; });
  // 插件侧后台抛错：本应被探针兜住（判插件侧），但在 captureCallback 下**不可见**。
  queueMicrotask(() => { throw new Error('H1：插件后台抛错（探针防线被 captureCallback 静音）'); });
}
