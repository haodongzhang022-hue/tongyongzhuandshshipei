/**
 * 负例插件：**不可捕获终止**（`SIGKILL`，评审 🔴 必修-2 的边界情形）。
 *
 * 关键性质：`SIGKILL` **既不可捕获、也不触发** `exit` 钩子的记账语义——探针**来不及**
 * 写结构化结果（这是「不可捕获」的定义，不是漏修）。
 *
 * 那它凭什么还能正确归因？靠**相位信标**（`__DSH_PROBE_PHASE__`）：
 * 探针进入插件集成相位时打一行信标，装配器据此判断终止发生在哪一段——
 *   有信标 ⇒ 终止在插件代码运行期间 → 落插件侧 check `plugin.abnormal_termination`；
 *   无信标 ⇒ 终止在宿主装配段 → `hostFatal[]`（真上游信号，不丢）。
 * 历史缺陷：装配器**无条件** `pushHostFatal()`——插件把自己 `kill -9` 也会被判成
 * 「上游变了，不是你的问题」（甩锅上游 + 报告整份消失）。
 *
 * 期望行为（修复后）：
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（不放行）、`hostFatal[]` **必须为空**；
 * - 失败项是插件侧 check `plugin.abnormal_termination`；`runCompleted = false`；
 * - 探针**未**输出结构化结果（`checks` 只有装配器补的这一条）——这正是本夹具与
 *   `plugin-exit-plugin` 的分工：那条走**可捕获**出口（探针自己出报告），本条走**不可捕获**出口。
 */
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

const healthy = {
  name: 'demo_echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: () => [] },
  execute: async (args) => ({ text: `echo: ${args?.text ?? ''}` }),
};

export function definitions() {
  return [healthy];
}

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这一行是「缺陷」：不可捕获的自我终止（真实形态：native addon abort / 内存爆掉 / 被 OOM killer 收走）
  process.kill(process.pid, 'SIGKILL');
}
