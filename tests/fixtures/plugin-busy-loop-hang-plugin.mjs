/**
 * 负例插件：**同步占死事件循环**，占死时长**大于**外层超时（R24 的**反向反证**专用夹具）。
 *
 * 与 `plugin-sync-loop-plugin` / `plugin-event-loop-hog-plugin` 的分工：
 * - `plugin-sync-loop-plugin`：占死 3s（**小于**默认 `timeoutMs`）⇒ 测「占死结束后照常收尾」；
 * - `plugin-event-loop-hog-plugin`：**永久**占死（`while(true)`）⇒ 测「宿主有界返回」
 *   （只发 SIGTERM 杀不死，必须 SIGKILL）；但永久占死在 SIGTERM 下会**永远挂住**，
 *   做不了「耗时 ≈ 占死时长」的**有界**反证；
 * - **本夹具**：**有界**占死（`BUSY_MS`，默认 60s，可用 `DSH_BUSY_LOOP_MS` 收窄）⇒ 供
 *   **反向反证**：「把宿主终止信号换回旧口径 SIGTERM，超时形同虚设（耗时随占死时长走）」。
 *   这是「为什么必须 SIGKILL」的**机器可检证据**，不是注释里的断言。
 *
 * 形态来源：插件在 `apply()` 里跑**同步**重活（大 JSON 解析 / 加密 / 同步 IO / 死循环）跑飞。
 *
 * 期望行为（生产口径，`killSignal: CHILD_KILL_SIGNAL`）：
 * - **有界返回**：耗时 ≈ 外层 `timeoutMs`（**不得**随插件占死时长增长）；
 * - 归因 `PLUGIN_REGRESSION` / `verdict = RED`（不放行）、`hostFatal[]` **必须为空**；
 * - 失败项 `plugin.abnormal_termination`（探针来不及写报告 ⇒ 装配器按**相位信标**归因，
 *   不甩锅上游）；`runCompleted = false`（未跑完不得判通过）。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

/** 占死事件循环的时长（毫秒）——取远大于外层超时；回归可用 `DSH_BUSY_LOOP_MS` 收窄。 */
const BUSY_MS = Number(process.env.DSH_BUSY_LOOP_MS || 60_000);

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
  // 仅这一段是「缺陷」：**同步**占死事件循环（真实形态：跑飞的同步重活）。
  // 注意：这里是**同步**循环（不是 setTimeout 里排的）——`apply()` 调用栈直接卡死，
  // 探针的看门狗与信号处理器**都排不上**（同一个事件循环）。
  const end = Date.now() + BUSY_MS;
  while (Date.now() < end) { /* 同步占死：事件循环上的一切（含探针看门狗）永不执行 */ }
}
