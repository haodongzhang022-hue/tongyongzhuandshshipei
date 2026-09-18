/**
 * 负例插件：后台任务 `process.exit(0)`（评审 🔴-D′ 的第二条路径）。
 *
 * 形态来源：插件在 `apply()` 里排的「守卫 / 自检 / 预取」任务里，发现致命条件后
 * 直接 `process.exit()`——作者以为「进程退出 = 验收失败 = 报告会说明原因」，
 * 实际是**把整份验收报告一起带走**。
 *
 * 关键性质：`process.exit()` 让探针**当场消失**，探针内的
 * `uncaughtException` / `unhandledRejection` 兜底与看门狗**都来不及跑**
 * ——探针内任何处理器都救不了自己。
 *
 * 历史缺陷：装配器看到「探针未输出结构化结果」→ 无条件 `pushHostFatal()`
 * → `UPSTREAM_DRIFT`/AMBER 且 `checks = 0`（插件 bug 被甩给上游）。
 *
 * 期望行为（修复后，靠**带外**侧信道相位归因）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`；
 * - `hostFatal[]` **必须为空**；
 * - 失败项是装配器侧插件 check `plugin.probe_aborted`（已登记 `PLUGIN_SIDE_CHECKS`）；
 * - `checks` 非空（17 项按规范顺序标 `skip` + 1 条 fail）——报告形态与「探针正常跑完但全挂」一致；
 * - `probePhase = plugin-integration`（侧信道相位，探针死后依然可读）。
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
  // 仅这一行是「缺陷」：后台任务里直接退出进程（真实形态：自检发现致命条件后自杀）
  setTimeout(() => process.exit(0), 5);
}
