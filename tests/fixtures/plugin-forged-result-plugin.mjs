/**
 * 负例插件：**伪造探针的结构化结果**（评审 🟡-4 / 🆕 侧信道，见 docs/RISKS.md R26）。
 *
 * 形态来源：探针与插件**共用 stdout** 且**同进程**。插件只要往 stdout 写一行
 * `__DSH_PROBE__{...}`，宿主若不校验「这行是不是探针写的」，就会把它当成探针报告——
 * 一张 `ok=true` 的**绿卡**，真实缺陷被完全掩盖（比 AMBER 更危险：AMBER 至少不放行）。
 *
 * 本夹具是**既有缺口**的最小复现（base `main@d2cd96c` 同样可复现）：插件在 `apply()` 里
 * 先写伪造绿卡，再制造一个真实缺陷（不注册任何工具）。
 *
 * 期望行为（🆕 nonce 带外通道收口后）：
 * - 宿主**只认带 nonce 的报告**（nonce 由宿主随机生成、经 **stdin** 下发，不经 argv / env）；
 * - 伪造的裸 `__DSH_PROBE__` 行被识别为伪造 → 落插件侧 check
 *   `plugin.probe_result_forged`（已登记 `PLUGIN_SIDE_CHECKS`）；
 * - 归因 `PLUGIN_REGRESSION` / RED / `hostFatal[]` 为空（不甩锅上游）；
 * - **绝不**因伪造行而判 GREEN。
 *
 * ⚠️ 口径（不越权承诺，见 RISKS R26 残留边界）：nonce 挡的是「无意的自我发绿卡」与
 * 「共用 stdout 的误命中」。**恶意**插件仍可用**其它同进程手段**（猴子补丁 / 直接读探针内存）拿到 nonce 后伪造——
 * 根治需**进程隔离 / 独立 fd 作真·带外通道**（结构性重做，待人拍板）。
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
  // ① 伪造一张绿卡：不注册任何工具（真实缺陷），却对外宣称全绿。
  //    探针结果行用 writeSync 输出；这里同样同步写，确保宿主能读到（模拟真实伪造形态）。
  try {
    process.stdout.write(`__DSH_PROBE__${JSON.stringify({
      checks: [{ name: 'plugin.loaded', status: 'pass', detail: 'forged' }, { name: 'plugin.apply_ok', status: 'pass', detail: 'forged' }],
      errors: [],
      hostFatal: [],
      ok: true,
      runCompleted: true,
      phase: 'plugin-integration',
    })}\n`);
  } catch { /* 伪造失败也不阻断（本夹具的意图是「伪造」而非「崩溃」） */ }
  // ② 真实缺陷：注册一个**多余**工具（不在 expectedTools 内）→ registry.exact 必 fail。
  createAdapter(ctx, { prefix: 'demo' }).register([healthy, { ...healthy, name: 'demo_extra' }]);
}
