/**
 * 负例插件：**同步占死事件循环且永不退出**（评审 🔴-1 的原始复现形态）。
 *
 * 与 `plugin-busy-loop-plugin` 的区别：那份占死 12s 后**放开**（看门狗有机会收尾），
 * 本份**永不放开**——事件循环被同步占死后，探针的看门狗 / 信号处理器**都没有机会执行**：
 * - 看门狗是 `setTimeout` 回调（排在事件循环上）⇒ 不触发；
 * - 探针为出口③装的 `SIGTERM`/`SIGINT` 处理器同样是事件循环回调 ⇒ 不可达；
 *   且**监听器存在即替换 Node 默认终止行为** ⇒ 只发 SIGTERM 的 `execFileSync` **杀不掉**探针。
 *
 * 用途（🔴-1 回归，见 `tests/test_offline.sh` [17]）：验证宿主侧
 * `execFileSync(..., killSignal:'SIGKILL')` 让 `timeoutMs` 重新成为**有界**承诺。
 * SIGKILL **不可捕获**，探针的信号处理器拦不住它 ⇒ 约 `timeoutMs` 后有界返回。
 *
 * ⚠️ 本夹具**只**用于「有界性」断言，**不进** `.cnb.yml` 闸门（否则每轮 CI 白等一个 timeout）。
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
  // 排一个宏任务**永久**占死事件循环（真实形态：跑飞的同步重活 / 死循环）。
  // 排在 setTimeout 里是为了让 apply() 先返回（与「apply 内直接死循环」同族，
  // 但能覆盖「run() 已进入后续 await」的形态）。
  setTimeout(() => {
    // eslint-disable-next-line no-constant-condition
    while (true) { /* 同步占死：看门狗与信号处理器都排不上 */ }
  }, 5);
}
