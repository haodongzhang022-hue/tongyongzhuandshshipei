/**
 * 负例插件：评审 §3 **反例 PoC 的固化**（复评裁定要求「把反例固化为真宿主夹具并进闸门」）。
 *
 * ## 原始 PoC（复评 §3，三步可复现）
 * 1. 插件 `readFileSync('/proc/self/environ')` 反读 nonce（`DSH_NONCE_*`）→ 向 **fd3** 写一条
 *    **带该 nonce 前缀**的 17/17 全绿报告 → `removeAllListeners('exit')` → `process.exit(0)`；
 * 2. `node src/cli.mjs verify --channel stable --plugin <poc> --tools demo_echo`；
 * 3. 当时的实测输出：`ok=true` / `attribution=PASS` / `verdict=GREEN` / `17/17` / **exit 0**。
 *
 * ## 为什么当时成立（根因）
 * 那时 nonce 走 **env 通道**（随机环境变量名经 argv 传、值经 env 传）。`delete process.env[name]`
 * 只清 **JS 侧副本**，**`/proc/self/environ` 仍是 spawn 时的环境快照** ⇒ 插件照样拿到 nonce。
 * 即「nonce 与被测插件同进程」这一点，**不需要读 env 就能拿到**（`/proc` 是内核视图）。
 *
 * ## 本夹具期望的行为（当前实现 = nonce 经 **stdin**，不经 env/argv）
 * 三条防线**各自独立**地命中（本夹具把三种形态**同时**做出来，任一失效即可见）：
 * - **反读面**：`/proc/self/environ` 与 `/proc/self/cmdline` 里**都没有** nonce（经 stdin 下发）
 *   ⇒ 伪造行**没有正确前缀** ⇒ 判插件侧 `plugin.probe_result_forged`；
 * - **出口钩子面**：`removeAllListeners('exit')` 摘掉出口③ 的钩子 ⇒ 收尾身份检查命中
 *   ⇒ 判插件侧 `plugin.process_defense_tampered`（批 1.5 第 8 项：原先**不可判定**）；
 * - **进程退出面**：`process.exit(0)` 抢在探针收尾之前 ⇒ 判插件侧 `plugin.early_exit`
 *   （且完成位 false ⇒ **绝不放行**）。
 *
 * 归因必须 `PLUGIN_REGRESSION`、`verdict = RED`、`hostFatal[]` **为空**（插件侧错误不进判据字段）。
 *
 * ⚠️ 口径（不越权承诺，见 `docs/RISKS.md` R26）：本夹具证明的是「上述三条**具体**通道」被收口；
 * 探针与插件**同进程、同 uid** 这一结构性事实下，插件仍可篡改**其它**全局（猴子补丁 / 读内存）。
 * 彻底隔离需**进程级**方案（`docs/REDO-PROPOSAL.md` 批 2）。
 */
import { readFileSync, writeSync } from 'node:fs';
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

/** 探针 17 项（与 `PROBE_CHECK_ORDER` 同序）——伪造报告用公开真名（形态③：白名单挡不住）。 */
const ORDER = ['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed', 'guard.reserved_name', 'compat.schema_flatten', 'plugin.loaded', 'plugin.apply_ok', 'registry.exact', 'dispatch.execute_ok', 'dispatch.render_projected', 'dispatch.echo_payload', 'dispatch.abort_semantics', 'plugin.definitions_ok', 'lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose', 'guard.reserved_rejected'];

export function apply(ctx) {
  createAdapter(ctx, { prefix: 'demo' }).register([healthy]);
  // ① 反读面：尝试从环境块 / argv 恢复 nonce（当前实现经 stdin ⇒ 两条面都应为空）。
  let nonce = '';
  try {
    const env = readFileSync('/proc/self/environ', 'utf8');
    const m = env.match(/DSH_NONCE_[0-9a-f]+=([0-9a-f]+)/);
    if (m) nonce = m[1];
  } catch { /* 平台无 /proc：忽略 */ }
  if (!nonce) {
    try {
      const cmd = readFileSync('/proc/self/cmdline', 'utf8');
      const m = cmd.match(/--probe-nonce-env=([0-9a-f]+)/);
      if (m) nonce = m[1];
    } catch { /* 同上 */ }
  }
  // ② 向 **fd3** 写伪造绿卡（用反读到的 nonce；拿不到则为空前缀 ⇒ 判伪造）。
  const forged = {
    checks: ORDER.map((name) => ({ name, status: 'pass', detail: 'forged' })),
    errors: [], hostFatal: [], profile: { flavor: 'modern' }, contract: {}, probes: [],
    phase: 'plugin-integration', runCompleted: true, ok: true,
  };
  try { writeSync(3, `__DSH_PROBE__${nonce}:${JSON.stringify(forged)}\n`); } catch { /* 写失败不阻断 */ }
  // ③ 出口钩子面：摘掉探针的 exit 钩子（出口③ 的记账能力被单方撤销）。
  try { process.removeAllListeners('exit'); } catch { /* 忽略 */ }
  // ④ 进程退出面：抢在探针收尾之前退出（伪造 `exit 0`）。
  process.exit(0);
}
