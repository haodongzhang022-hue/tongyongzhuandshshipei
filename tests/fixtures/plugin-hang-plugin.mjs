/**
 * 负例插件：**`apply()` 挂住不返回**（评审 🔴 必修-3 的原始复现：`run()` 被拖住）。
 *
 * 关键性质：既**没有异常**、也**没有 `process.exit`**——只是 `apply()` 返回一个
 * **永不 resolve** 的 Promise（真实形态：等一个永不到来的握手 / 死锁 / 忘了 resolve）。
 * 于是探针的 `await plugin.apply(...)` 永不返回，`run()` 永不返回。
 *
 * 历史缺陷（本夹具要复现的）：
 *   1. 旧看门狗只在「已记录过异步异常」时才安装 ⇒ 本形态下**根本没装**；
 *   2. 就算装了，旧实现紧跟 `watchdog.unref?.()` ⇒ 事件循环里没有其它 handle 时
 *      进程直接走 exit 路径，看门狗**永不触发**；
 *   ⇒ CI 干等到外层超时（600s）→ 装配器判「探针未输出结构化结果」→ `UPSTREAM_DRIFT`/AMBER。
 *
 * 期望行为（修复后）：
 * - 探针的**无条件**看门狗（`RUN_WATCHDOG_MS`）到点强制收尾；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）、`hostFatal[]` **必须为空**；
 * - 失败项是插件侧 check `plugin.run_incomplete`；`runCompleted = false`；
 * - 已跑完的 check 全部保留（`apply()` 之前/之中的检查），未跑到的标 `skip`。
 *
 * 回归加速：宿主侧可用 `DSH_PROBE_RUN_WATCHDOG_MS` **缩短**看门狗窗口（只许缩短，见探针注释）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  // 真实 render（评审 🟡-5：`render: () => []` 会让 dispatch.render_projected / echo_payload
  // 额外失败，噪声掩盖「失败点精确留在对应出口」的自述）。走中台默认投影 `defaultRender`。
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [healthy];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这一行是「缺陷」：等一个永不到来的信号（死锁 / 忘了 resolve）
  return new Promise(() => { /* never resolves */ });
}
