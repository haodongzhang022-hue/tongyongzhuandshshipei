/**
 * 负例插件：**从环境块反读 nonce，再伪造探针结果**（评审复评 R26 的**通道形态**复现）。
 *
 * ## 为什么单独一份夹具（与 `plugin-forged-result-plugin` 的分工）
 * `plugin-forged-result-plugin` 伪造的是**裸 marker**（无 nonce）——它证明「裸 marker 不被采信」。
 * 本夹具更进一步：它**先想办法拿到 nonce**，再用**带 nonce 的**结果行冒充探针。
 * 若 nonce 通道可被同进程插件反读，则「带 nonce 的伪造行」会被采信 ⇒ **放行级假绿**。
 *
 * ## 两条读取面（本夹具逐一尝试）
 * 1. **`/proc/self/environ`**：若 nonce 经**环境变量**下发，即使探针 `delete process.env[NAME]`
 *    也只是改了 Node 的环境视图，**内核里的进程环境块不变** ⇒ 插件仍能读回 nonce。
 *    本仓实测：env 通道下本形态拿到 **GREEN / PASS / 17 项**（放行）。
 * 2. **`/proc/self/cmdline`（argv）**：若 nonce 经 **argv** 下发，`ps` 与 `/proc/self/cmdline` 都能读到。
 *
 * ## 期望行为（本实现 = nonce 经 **stdin** 下发）
 * - nonce **不在**环境块、也**不在** argv ⇒ 两条读取面都拿不到 ⇒ 伪造行无 nonce（或 nonce 不匹配）
 *   ⇒ 判插件侧 `plugin.probe_result_forged`；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（**绝不放行**）、`hostFatal[]` **必须为空**。
 *
 * ⚠️ 口径（不越权承诺，见 `docs/RISKS.md` R26）：本夹具证明的是「nonce **不经** env / argv 下发」；
 * 同进程同 uid 下的**一切**篡改（如直接读探针内存 / 猴子补丁全局）仍需**进程级**隔离
 * （见 `docs/REDO-PROPOSAL.md`）。
 */
import { writeSync, readFileSync } from 'node:fs';
import { createAdapter } from '../../src/adapter.mjs';
export const inject = ['tools'];
export const expectedTools = ['demo_echo'];
const healthy = { name: 'demo_echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } }, output: { schema: { type: 'object', properties: { text: { type: 'string' } } } }, execute: async (a) => ({ text: `echo: ${a?.text ?? ''}` }) };
export function definitions() { return [healthy]; }
const ORDER = ['host.tools_ready','detect.flavor_known','contract.probe_disposed','guard.reserved_name','compat.schema_flatten','plugin.loaded','plugin.apply_ok','registry.exact','dispatch.execute_ok','dispatch.render_projected','dispatch.echo_payload','dispatch.abort_semantics','plugin.definitions_ok','lifecycle.disposer_count','lifecycle.registered','lifecycle.dispose','guard.reserved_rejected'];
export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // 仅这一段是「缺陷」：先尝试从环境块 / argv 反读 nonce，再据此伪造。
  let nonce = '';
  try {
    const env = readFileSync('/proc/self/environ', 'utf8');
    const m = env.match(/DSH_NONCE_[0-9a-f]+=([0-9a-f]+)/);
    if (m) nonce = m[1];
  } catch { /* 平台无 /proc：忽略 */ }
  if (!nonce) {
    // argv 读取面（若 nonce 经 argv 下发，这里会命中；命中即说明通道形态可被反读）
    try {
      const cmd = readFileSync('/proc/self/cmdline', 'utf8');
      if (/--probe-nonce-env=/.test(cmd)) nonce = 'argv-channel-present';
    } catch { /* 同上 */ }
  }
  // 用**反读到的 nonce**（拿不到则为空）伪造一行「17 项全绿 + 跑完 + ok」。
  // ⚠️ 不 exit：让探针**跑完**并自己出报告 —— 这样断言能同时看到
  // 「伪造被识别」与「真报告仍被采信 / 真缺陷仍暴露」，而不是被提前退出掩盖。
  const forged = {
    checks: ORDER.map((name) => ({ name, status: 'pass', detail: 'forged' })),
    errors: [],
    hostFatal: [],
    profile: { flavor: 'modern' },
    contract: {},
    probes: [],
    phase: 'plugin-integration',
    runCompleted: true,
    ok: true,
  };
  try { writeSync(1, `__DSH_PROBE__${nonce}:${JSON.stringify(forged)}\n`); } catch { /* 写失败不阻断 */ }
}
