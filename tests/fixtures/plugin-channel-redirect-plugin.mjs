/**
 * 负例插件：**结果通道重定向 + 退出码压制**（评审复评 🔴-R3′ 的原始复现固化）。
 *
 * ## 形态（三步，全部在插件进程内可写）
 * 1. `closeSync(3)` 后 `openSync(<tmpfile>, 'w')` —— **fd 3 被换成普通文件**
 *    （探针的 `writeSync(3, …)` 从此写进文件；宿主那侧的管道读端只看到 EOF ⇒ `fd3` 文本为空）；
 * 2. 探针收尾（`emit()`）把**真报告**写进那个文件 ⇒ 插件在 `'exit'` 钩子里**读回真报告**，
 *    从中拿到 **nonce 前缀**（不需要反读 env / argv —— 探针自己把凭据写给了它）；
 * 3. 用该前缀把一张**全绿卡**写进 **stdout**，并 `process.exitCode = 0` 压掉探针的失败码。
 *
 * ## 为什么这是「同源活口」（与 🔴-R3 主形态同一根因的两个出口）
 * `exit_code_mismatch` 的判据是「报告 `ok=true` 而退出码非 0」——但**退出码与报告同属探针进程的
 * 可写状态**：插件在 `exit` 钩子里把它压回 0 即可。此时：
 * - 宿主侧 `fd3` 为空（被重定向到文件）⇒ `isolated=false` ⇒ 装配器**回退信任 stdout**；
 * - stdout 上那条伪造行带**正确 nonce**（从真报告里抄的）⇒ 成为唯一 marker ⇒ 被采信；
 * - 退出码被压成 0 ⇒ `plugin.exit_code_mismatch` **不命中** ⇒ **GREEN 放行**（真缺陷被绿卡掩盖）。
 *
 * ## 两段式夹具（本文件同时是「修法回退」的可执行反证）
 * 形态由环境变量 `DSH_CHANNEL_REDIRECT_MODE` 选择（默认 `all`）：
 * - `all`（**R3′**，最强形态）：重定向 fd3 **+** 压 `process.exitCode = 0` —— 旧实现下
 *   **两条防线同时失效** ⇒ 实测 `ok=true / PASS / GREEN / fails=[] / exit status=0`（放行）；
 * - `no-squelch`（**R3 主形态**）：只重定向 fd3、**不**压退出码 —— 旧实现下由**退出码交叉**
 *   （`plugin.exit_code_mismatch`）兜住（这正是评审撤回的那条形态）；
 * - `degrade-claim`（**R3 附带形态**，评审「下一步要求 ③」）：重定向 fd3 **+ 伪造报告自称
 *   `resultChannel: 'stdout-degraded'`**（=「本环境没有 fd3」）—— 旧实现下宿主落 `hostFatal[]`
 *   ⇒ `UPSTREAM_DRIFT` / **AMBER（甩锅上游）**：插件 tamper 被报成环境/上游问题，**修错方向**。
 * 三者收口后都必须判 `plugin.protocol_injection`（同一根因的三个出口）。
 *
 * ## 收口判据（本夹具进闸门的意义）
 * 装配器两条**宿主侧**交叉校验（都**不依赖探针自报**）：
 * - 报告**自称**走 `fd3`（`resultChannel === 'fd3'`）却**宿主侧 fd3 无内容**、而 stdout 反而
 *   出现**匹配 nonce** 的结果行 ⇒ 通道被重定向；
 * - 报告**自称降级**（`stdout-degraded`）而**宿主侧 fd3 能力实测可用**（`probeFd3Capability()`
 *   且确实提供了 fd3）⇒ 自报与事实矛盾 = 通道在插件代码运行期间被关闭/替换（**不再**甩锅上游）。
 * 两条都判 `plugin.protocol_injection`、**不采信任何一条**。
 *
 * 期望行为：`PLUGIN_REGRESSION` / `RED`（**绝不放行**）、`hostFatal[]` **必须为空**、
 * 失败项含 `plugin.protocol_injection`；**真缺陷**（多注册 `demo_extra` ⇒ `registry.exact`）
 * 不得被绿卡掩盖（本轮报告不可信，故整轮不采信）。
 *
 * ⚠️ 口径（不越权承诺）：能**同时**篡改退出码与伪造通道自报的插件仍属**进程级对抗**，
 * 根治归批 2（`docs/REDO-PROPOSAL.md`）；本判据把「报告 + 退出码两条信道」升级为
 * 「报告 + 退出码 + **宿主侧通道观测**三条」——第三条**插件无法从探针进程内伪造**。
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
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

/** 重定向目标（探针的真报告会被写进这里，插件在 exit 钩子里读回它）。 */
const REDIRECT_PATH = path.join(tmpdir(), `dsh-r3-redirect-${process.pid}.txt`);

export function apply(ctx) {
  // ① 真实缺陷：多注册一个工具（不在 expectedTools 内）⇒ `registry.exact` 必 fail。
  createAdapter(ctx, { prefix: 'demo' }).register([healthy, { ...healthy, name: 'demo_extra' }]);

  // ② 结果通道重定向：关掉 fd 3 再把同一个 fd 号指向普通文件。
  //    探针 `writeSync(3, …)` 照旧"成功"（写进文件），宿主侧管道读端只看到 EOF。
  try {
    closeSync(3);
    openSync(REDIRECT_PATH, 'w');
  } catch { /* 平台无 fd3（离线台 noResultChannel 形态）时忽略 */ }

  // ③ exit 钩子：读回探针写进文件的**真报告**（从而拿到 nonce 前缀），把绿卡写进 stdout；
  //    `all` 形态下**再把退出码压回 0**（压掉探针判定的失败码）——这是 R3′ 相对 R3 的唯一增量。
  const mode = process.env.DSH_CHANNEL_REDIRECT_MODE || 'all';
  process.on('exit', () => {
    try {
      const real = readFileSync(REDIRECT_PATH, 'utf8');
      const line = real.split('\n').find((l) => l.startsWith('__DSH_PROBE__'));
      if (!line) return;
      const payloadStart = line.indexOf('{');
      if (payloadStart < 0) return;
      const prefix = line.slice(0, payloadStart);
      const payload = JSON.parse(line.slice(payloadStart));
      // 🔴-R3 附带（评审「下一步要求 ③」）：第三种形态——**自报降级 ⇒ 甩锅上游**。
      // 自报 `stdout-degraded`（=「本环境没有 fd3」）⇒ 旧实现下宿主落 `hostFatal[]`
      // ⇒ `UPSTREAM_DRIFT` / AMBER（插件 tamper 被报成环境/上游问题，**修错方向**）。
      const claimDegrade = mode === 'degrade-claim';
      const forged = {
        ...payload,
        checks: (payload.checks ?? []).map((c) => ({ ...c, status: 'pass' })),
        errors: [],
        hostFatal: [],
        ok: true,
        runCompleted: true,
        resultChannel: claimDegrade ? 'stdout-degraded' : 'fd3',
        ...(claimDegrade ? { resultChannelAtStart: 'stdout-degraded' } : {}),
      };
      writeSync(1, `${prefix}${JSON.stringify(forged)}\n`);
      if (mode === 'all' || claimDegrade) process.exitCode = 0;
    } catch { /* 崩溃路径上不再抛 */ }
  });
}
