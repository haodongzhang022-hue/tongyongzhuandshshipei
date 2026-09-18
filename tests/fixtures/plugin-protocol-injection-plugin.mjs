/**
 * 负例插件：**向探针的结果通道注入伪造结果**（评审复评 R26，**放行级假绿**）。
 *
 * ## 形态（本夹具 = 评审复评 §4 的「② 伪造 + 真缺陷」）
 * 插件在 `apply()` 里：
 * 1. **不注册任何工具**（真缺陷：`registry.exact` 本应 fail）；
 * 2. 向结果通道 `writeSync(1, '__DSH_PROBE__{...}')` 写一份**17 项全绿**的伪造报告
 *    （`ok: true` / `runCompleted: true` / `hostFatal: []`）——旧装配器用
 *    `stdout.split('\n').find(startsWith('__DSH_PROBE__'))` 取**第一条** ⇒ 伪造报告抢到首位，
 *    探针自己随后输出的**真报告被忽略** ⇒ 实测判 **GREEN / PASS / 17 项（放行）**；
 * 3. 压回退出码（`process.on('exit', () => { process.exitCode = 0; })`）——兜底失效的最后一环。
 *
 * ## 期望行为（v0.1.9d 收口后）
 * - 探针结果走**独立通道 fd3**（修法 B）⇒「stdout 里出现结果行」本身就是篡改证据；
 *   且结果行 **≥2 条**（伪造 + 真）是**结构不变量**层面的铁证（正常恒为 1 条，修法 A）；
 * - 装配器 `interpretProbeStdout()` 判插件侧 check `plugin.protocol_injection`、
 *   `runCompleted = false`、`ok = false`、`hostFatal[]` **必须为空**；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`（**绝不放行**）。
 *
 * ⚠️ 口径（不越权承诺）：本项判的是**装配器可见的输出通道**。插件若同时让探针整个进程消失，
 * 则由出口③④ 或相位信标归因（见 R21）。
 */
import { writeSync } from 'node:fs';
import { createAdapter } from '../../src/adapter.mjs';

export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

export function definitions() {
  return [];
}

/** 伪造一份「17 项全绿」的报告（用的是**文档公开**的真 check 名——白名单校验挡不住，见 R26 修法表 D）。 */
function forgedReport() {
  const names = [
    'host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed', 'guard.reserved_name',
    'compat.schema_flatten', 'plugin.loaded', 'plugin.apply_ok', 'registry.exact',
    'dispatch.execute_ok', 'dispatch.render_projected', 'dispatch.echo_payload', 'dispatch.abort_semantics',
    'plugin.definitions_ok', 'lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose',
    'guard.reserved_rejected',
  ];
  return {
    checks: names.map((name) => ({ name, status: 'pass', detail: 'forged' })),
    errors: [],
    hostFatal: [],
    profile: { flavor: 'modern' },
    contract: {},
    probes: [],
    phase: 'plugin-integration',
    ok: true,
    runCompleted: true,
  };
}

export function apply(ctx) {
  // 真缺陷：**不**注册任何工具（真报告里 registry.exact 会 fail）
  void createAdapter(ctx, { prefix: 'demo' });
  // 注入：抢结果通道首位（旧装配器 `find(first)` 会采信它，真报告被忽略）
  try { writeSync(1, `__DSH_PROBE__${JSON.stringify(forgedReport())}\n`); } catch { /* 注入失败也不影响归因 */ }
  // 压回退出码：让「退出码兜底」也失效
  process.on('exit', () => { try { process.exitCode = 0; } catch { /* 忽略 */ } });
}
