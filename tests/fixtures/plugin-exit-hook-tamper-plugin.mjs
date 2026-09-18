/**
 * 负例插件：**只摘掉出口③ 的 `exit` 钩子，其余一切健康**（批 1.5 第 8 项 / R23 同族的可证伪夹具）。
 *
 * ## 为什么单独一份夹具（与 `plugin-host-tamper-poc-plugin` 的分工）
 * `plugin-host-tamper-poc-plugin` 摘钩子**紧接着** `process.exit(0)`——探针**来不及**跑收尾自检，
 * 那条只能靠相位信标归因（`plugin.abnormal_termination`），**测不出**「摘钩子」这件事本身。
 * 本夹具把变量**单独隔离**：插件只调 `process.removeAllListeners('exit')`，不退出、不伪造、
 * 不抛错——探针正常跑完并走收尾自检。
 *
 * ## 历史缺陷（本夹具要钉住的行为）
 * `wrapProcessDefenseApis()` 原先只记账 `uncaughtException` / `unhandledRejection`，**`'exit'` 不在台账**；
 * `checkProcessDefense()` 的身份检查也只遍历那两个事件 ⇒ **「出口③ 钩子被单方摘除」不可判定**。
 * 实测（收口前）：干净插件 + `removeAllListeners('exit')` → **不判** `plugin.process_defense_tampered`
 * （判红只是因为其它 fail 兜住）⇒ 插件可以**悄悄**拿掉「提前退出」这条出口的记账能力。
 *
 * ## 期望行为（批 1.5 收口后）
 * - 探针收尾**身份检查**命中（我们的 `defenseHandlers.exit` 已不在 `process.listeners('exit')` 里）
 *   ⇒ 判插件侧 check `plugin.process_defense_tampered`；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（**绝不放行**）、`hostFatal[]` **必须为空**；
 * - 完成位仍为 `true`（探针**确实跑完了**——它只是**不知道**自己的出口钩子被摘了）。
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
  // 仅这一行是「缺陷」：摘掉出口③（进程提前退出）的记账钩子。不退出、不抛错、不伪造
  // ——把「钩子被单方摘除」这个变量**单独**隔离出来（否则测的是别的出口）。
  process.removeAllListeners('exit');
}
