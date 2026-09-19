/**
 * 负例插件：`apply()` 内**同步死循环**（评审复评 R24，比出口④ 更严重）。
 *
 * ## 为什么它比「`run()` 被拖住」更狠
 * 探针的看门狗与信号处理器都是**事件循环**上的回调。插件在 `apply()` 里同步占满事件循环后：
 * 看门狗**不触发**、信号处理器**不执行**；而探针为出口③ 装了 `SIGTERM`/`SIGINT` 处理器
 * ⇒ Node 的**默认终止行为被禁用** ⇒ 宿主 `execFileSync(timeout)` 的 SIGTERM **杀不掉**探针。
 * 实测（timeoutMs=5000）：SIGTERM 形态耗时 **30.3s**；`while(true)` 形态**永久挂死**（吃满 CI 额度）。
 *
 * ## 期望行为（v0.1.9d 收口后）
 * 宿主改用 `killSignal: 'SIGKILL'` 二次终止 ⇒ 在 `timeoutMs` 附近**收口**（实测 5011ms）；
 * 探针来不及写结构化结果（**不可捕获**），但相位信标已打出 ⇒ 装配器按信标归因：
 * `plugin.abnormal_termination`（插件侧）、`hostFatal[]` **为空**、`runCompleted = false`。
 *
 * ## 循环时长刻意取 **3s**（不是 30s）
 * 3s 已足够让 `timeoutMs=1000` 的回归断言成立，又不吃满 CI 额度；断言见
 * `tests/gate_plugin_side.sh`（`elapsed < timeoutMs × 3` + `probeExit.signal === 'SIGKILL'`）。
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
  // 仅这一行是「缺陷」：同步占满事件循环（真实形态：超长同步计算 / 同步 IO / 死循环）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { /* busy loop：看门狗与信号处理器都排不上 */ }
}
