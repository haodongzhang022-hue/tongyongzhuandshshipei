/**
 * 负例插件：**把伪造报告标成「通道降级」⇒ 甩锅上游**（🔴-R3 §三 的原始复现，与
 * `plugin-channel-redirect-plugin` **同源**：都靠「宿主侧 fd3 为空 + 匹配 nonce 的 stdout 结果行」）。
 *
 * ## 形态（评审复评 §三）
 * 与「通道重定向」同一手法（`closeSync(3)` + `openSync(sink,'w')` 抢占 fd 号 3 ⇒ 探针的
 * `writeSync(3, …)` 写进插件的文件），差别只在**伪造报告的字段**：
 * - `resultChannel: 'stdout-degraded'`（自称「fd3 不可用 ⇒ 结果走 stdout」）；
 * - **删掉** `resultChannelAtStart`（否则装配器按「早探测可写 → 收尾不可写」直接判插件侧）；
 * - `hostFatal: ['上游契约变更：…']`（**甩锅上游**的载荷）。
 *
 * 收口前的实测后果：**`AMBER` / `UPSTREAM_DRIFT`**（把「插件关掉结果通道」讲成「环境没有 fd3」）
 * ——比 GREEN 好、但责任判错方向，且 AMBER 的语义是「人须确认上游」，属**甩锅**。
 *
 * ## 收口判据（🔴-R3 §三）
 * **真实降级必须由宿主侧观测到「fd3 不可用」**，不能只信探针自报：宿主本次运行**确实**把 fd3
 * 作为管道交给探针（`probeSpawnOptions().stdio[3] === 'pipe'`）却收到「写不进 fd3」的自报
 * ⇒ 与宿主侧观测**矛盾** ⇒ 判 `plugin.protocol_injection`（不放行、不甩锅）。
 *
 * ## 期望行为（收口后）
 * `plugin.protocol_injection` / `PLUGIN_REGRESSION` / `RED` / `hostFatal[]` **为空** /
 * `runCompleted=false`（报告整体不可信 ⇒ 不采信任何一条）。
 *
 * ⚠️ 口径（不越权承诺，见 `docs/RISKS.md` R31）：本夹具证明的是「**宿主侧可观测的**降级伪造」
 * 被收口；宿主**真的**没给 fd3 的环境（容器 / Windows / 直接跑探针）仍按**真降级**处理
 * （`hostFatal[]` → `UPSTREAM_DRIFT` / AMBER，人须确认），两者由 `resultChannelProvided` 区分。
 * 同进程同 uid 下插件仍可篡改其它全局 / 直接改退出码（**残留边界**，根治需进程隔离，
 * 见 `docs/REDO-PROPOSAL.md` 批 2）。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

/** 被重定向的「真报告」落点（文件名带 pid，避免并行用例互踩）。 */
const SINK = path.join(tmpdir(), `dsh-channel-degrade-sink-${process.pid}.txt`);

export function apply(ctx) {
  // ① 关掉探针的结果通道 + ② 用文件抢占 fd 号 3（探针的报告会写进这个文件 ⇒ 插件能合法读到 nonce）。
  // 内核把**最小可用 fd 号**给新开的文件 ⇒ 刚 close 掉 3 之后，这里必定拿到 3。
  // 仍加一层防御性重试（万一某依赖在 import 期又开了一个 fd）：拿到的号**必须**是 3，
  // 否则本夹具的形态不成立（探针会照常写进宿主 pipe）——那时会表现为「只有 registry.exact 失败」，
  // 闸门/回归的**完整失败项集合**断言会立刻红（不会静默放过）。
  try { closeSync(3); } catch { /* 无 fd3（离线直跑）时忽略 */ }
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fd = openSync(SINK, 'w');
      if (fd === 3) break;
      try { closeSync(fd); } catch { /* 忽略 */ }
    }
  } catch { /* 平台限制：忽略（形态不成立时本夹具自然失效） */ }
  // ③ 真实缺陷：多注册一个工具（`registry.exact` 应 fail）。
  createAdapter(ctx, { prefix: 'demo' }).register([healthy, { ...healthy, name: 'demo_extra' }]);
  // ④ exit 钩子：读回真报告 → 取 nonce → 向 stdout 写**自称降级 + 甩锅上游**的伪造报告。
  process.on('exit', () => {
    try {
      const text = readFileSync(SINK, 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('__DSH_PROBE__'));
      if (!line) return;
      const sep = line.indexOf(':', '__DSH_PROBE__'.length);
      const nonce = line.slice('__DSH_PROBE__'.length, sep);
      const real = JSON.parse(line.slice(sep + 1));
      const forged = {
        ...real,
        // 关键差别：自称**降级**（把「通道被我关掉」讲成「环境没有 fd3」）…
        resultChannel: 'stdout-degraded',
        // …并**删掉**早探测快照（否则装配器按「早探测可写 → 收尾不可写」直接判插件侧）。
        resultChannelAtStart: undefined,
        checks: (real.checks ?? []).map((c) => ({ ...c, status: 'pass' })),
        errors: [],
        // 甩锅上游：往**判据字段**里塞一条「上游变了」。
        hostFatal: ['上游契约变更（伪造）：dsh-tools 注册契约漂移'],
        ok: true,
        runCompleted: true,
      };
      writeSync(1, `__DSH_PROBE__${nonce}:${JSON.stringify(forged)}\n`);
      // 读回即删：本夹具是**一次性**的，别在 CI 临时目录里留文件。
      try { unlinkSync(SINK); } catch { /* 忽略 */ }
    } catch { /* 伪造失败也不阻断 */ }
    try { process.exitCode = 0; } catch { /* 忽略 */ }
  });
}
