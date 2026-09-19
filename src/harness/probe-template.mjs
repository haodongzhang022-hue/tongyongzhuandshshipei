/**
 * 双通道验收探针（在隔离临时目录内执行，由**真实宿主运行时**装配）。
 *
 * 用法：`node probe.mjs <hubRoot> <pluginPath> <expectedToolsJson>`
 * 输出：单行 `__DSH_PROBE__<json>`（结构化结果）。
 *
 * 验收分两段：
 * - **集成路径**：调用被测插件自己的 `apply(ctx)`（真实入口 + 中台适配器），
 *   验证「装上就能用」；
 * - **生命周期路径**：用中台 `registerTools` 重注册并逐个卸载，验证 disposer 语义。
 *
 * ## 错误分级（归因的前提，见评审 🔴-A / 🔴-B / 🔴-D）
 * 探针的错误分两侧，措辞**必须可区分**，否则归因会被带跑：
 * - **宿主/环境侧**（装不上、宿主包 import 失败、ToolRuntime 未就绪、探针自身契约采集炸）
 *   → `pushHostFatal()`：结构化落 `hostFatal[]`（**归因判据只读它**）+ 人读日志 `fatal(host): ...`；
 * - **插件侧**（import 失败、未导出 `apply`、`apply` 抛错、`definitions` 抛错/不可读、
 *   工具清单不符/不可枚举、dispatch 失败、卸载残留、声明保留名）
 *   → 一律落成 **check 失败**（`plugin.*` / `registry.*` / `dispatch.*` / `lifecycle.*` /
 *   `guard.reserved_rejected`），归因判 `PLUGIN_REGRESSION`。
 *
 * ## 相位（🔴-D：写入端纪律）
 * 探针分两段跑，两段的**异常归属**不同，兜底按 `phase` 决定落点：
 * - `host-assembly`（第 1/3 段：宿主包 import、Context 装配、契约指纹采集）→ `hostFatal[]`；
 * - `plugin-integration`（第 5 段起：插件 import / apply / definitions / dispatch / 生命周期）
 *   → **插件侧 check**（`plugin.unexpected_exception`），**绝不**进 `hostFatal[]`。
 * 未知相位**保守判插件侧**（宁可让人多看一眼插件失败，也不让未确认的信号去开「上游漂移」的门）。
 * 归属路由的唯一事实源：`contract.mjs` 的 `PROBE_PHASE` / `probeFailureRoute()` / `recordProbeException()`
 * 与 `probeAsyncFailureRoute()` / `recordProbeAsyncException()`。
 * 读插件侧数据的两处（`tools.schemas()` / `definitions.map()`）另有独立护栏，异常落插件侧 check。
 *
 * ## 四条出口 + 完成位（🔴-D 同族活口，逐轮补齐）
 * 插件侧错误「逃出 `run()` 的调用栈」有四条出口，本文件必须**逐条闭合**——少一条，
 * 插件 bug 就会被装配器判成 `UPSTREAM_DRIFT`/AMBER（「上游变了，不是你的问题」），
 * 且 `checks` 从 17 掉到 0（整份报告消失）：
 *
 * | # | 出口 | 谁能接住 | 插件侧落点 check |
 * |---|---|---|---|
 * | ① | 同步异常（`run()` 调用栈上） | 顶层 `catch` | `plugin.unexpected_exception` |
 * | ② | 异步异常（`uncaughtException` / `unhandledRejection`） | 进程级处理器 | `plugin.async_uncaught_exception` |
 * | ③ | 进程 exit（插件调 `process.exit()` / 自杀式信号） | `process.on('exit')` + 信号处理器 | `plugin.early_exit` |
 * | ④ | `run()` 被拖住（挂住事件循环 / `apply()` 永不 resolve） | **无条件**看门狗 `RUN_WATCHDOG_MS` | `plugin.run_incomplete` |
 *
 * 四条出口的归属规则**只有一份**（`contract.mjs` 的 `probeFailureRoute()` /
 * `probeProcessFailureRoute()`）：插件侧落 check、不写 `hostFatal[]`
 * （**口径前提**：探针进程内防线未被插件干预——见 R22/R23/R28；防线被干预时由收尾自检判
 * `plugin.process_defense_tampered`，结果通道被注入时由装配器判 `plugin.protocol_injection`）。
 *
 * ### 完成位（`runCompleted`）——「已跑完」与「没跑完」必须可区分
 * `emit()` 的 `ok` 必须来自 `runCompleted && errors.length === 0`，而 `runCompleted`
 * **只在 `run()` 正常返回后**置真。为什么必须如此：出口 ③ 的兜底会在验收**中途**输出报告，
 * 此时「还没跑到」的检查一律是 `skip`（不是 `fail`）——若 `ok` 只看 `errors.length === 0`，
 * 一个 `apply()` 里立刻 `process.exit(0)` 的插件会拿到 **GREEN / PASS / checks=6 的假绿**
 * （比 AMBER 更危险：AMBER 至少不放行）。带上完成位后，同一夹具 → `RED`（不放行）。
 *
 * 三条纪律（都是「崩溃路径」上的经验，别再踩）：
 * 1. 兜底处理器**自身不得抛**（抛出 = 第二次崩溃 = 报告整份消失）；
 * 2. 结构化结果用 `writeSync` 输出（兜底后紧接着 `process.exit()`，异步 stdout 会被截断）；
 * 3. 记录后**不立即退出**——插件后台任务的抛错时机不确定（第几个 `await` 之后），
 *    立即退出会让「已跑完的检查」随时机变化 → 同一插件两次跑出不同 `checks`（报告不确定）。
 *    改为让 `run()` 跑完再统一收尾（报告形态与正常失败一致），由看门狗（出口 ④）兜住
 *    「`run()` 被拖住」。看门狗**不得 `unref()`**：那正是出口 ④ 曾经「装了却永不生效」的根因
 *    （事件循环无其它 handle 时进程直接走 exit 路径）。收尾路径由 `finish()` 显式 `clearTimeout`。
 *
 * ### 相位信标（`__DSH_PROBE_PHASE__`）
 * 进入 `plugin-integration` 相位时向 stdout 打一行信标。用途：闭合**不可捕获**终止
 * （`SIGKILL` / OOM / 原生 `abort`）的归因——那时探针来不及写结构化结果，装配器按
 * 「有没有信标」判断终止发生在哪一段：有信标 → 插件代码运行期间（落插件侧 check，
 * 与「未知相位保守判插件侧」同一取向）；无信标 → 宿主装配段（`hostFatal[]`）。
 * 历史缺陷（🔴-B）：插件侧错误曾被统一写成 `fatal: ...`，而 `runner` 用裸 `fatal:` 判上游漂移
 * → 插件写坏了却被告知「上游变了，不是你的问题」。
 * 历史缺陷（🔴-C）：改用 `fatal(host)` 前缀后判据仍在**扫自由文本**——插件文件路径/错误文本里
 * 恰好含该字面量即再次翻案。故判据改为只读 `hostFatal[]` 结构化字段，`errors` 退化为纯日志。
 *
 * ## 结果通道（R26：协议注入防线）
 * 结构化结果**优先**写独立通道 fd3（`writeSync(3, ...)`）；fd3 不可用（直接跑探针 / 老装配器）
 * 时回退 stdout。装配器据此把「stdout 里出现结果行」判为**篡改证据**（探针只写 fd3），
 * 并对「结果行 ≥2 条」直接判插件侧 check `plugin.protocol_injection`（**放行级假绿**防线）。
 *
 * ## 结果行的**凭据**（v0.2.5 / 🔴-R3′）
 * 结果行 = `__DSH_PROBE__<tag>:<正文>`，`tag = HMAC-SHA256(nonce, 正文)`（**不回显 nonce**）。
 * 为什么不是「回显 nonce 的前缀」：插件可把 fd3 **换成自己的文件** ⇒ 探针（不知情）把
 * **带 nonce 的真报告**写进**插件的文件** ⇒ 插件在 `exit` 钩子里读出 nonce 即可伪造（旧实现
 * 判 `GREEN` 放行）。**正文绑定**的标签**不可迁移**：读到真报告只能得到**真正文**的标签，
 * 换正文即验不过。宿主另按「报告**自称**走 fd3 而**实际** fd3 为空」判**通道重定向**
 * （判据 D，依据宿主侧观测 ⇒ 压退出码无效）。
 *
 * ## 进程内防线的**可判定性**（H1 / R22 / R28）
 * 「探针装了兜底」≠「兜底有效」。插件可（`apply()` 内）单方面：
 * `setUncaughtExceptionCaptureCallback()`（独占 API，设置后监听器**不再被调用**）、
 * `removeAllListeners('uncaughtException')`、或**用自己的回调顶替**我们的。
 * 故探针在**任何插件代码之前** wrap 这几个 API 记账（`wrapProcessDefenseApis()`），
 * 收尾时做**四重自检**（`checkProcessDefense()`）：① API 调用台账（wrap 记账）；
 * ② **身份检查**（我们的 handler 仍在 `process.listeners()` 里）；③ 独占 API 检测
 * （`hasUncaughtExceptionCaptureCallback()` **作为独立篡改信号**，不与计数做 `||`）；
 * ④ 行为级 canary（临时监听器 + 走 `process._fatalException` 的**真实派发路径**，
 * 能区分「监听器还在但不会被调用」；该内部入口不可用时本层自动跳过，不误报）。
 * ⚠️ **不得**用 `hasUncaughtExceptionCaptureCallback() || listenerCount > 0` 当判据（R28 已证假阳性：
 * 插件用自己的回调顶替后 `has=true, count=1`，该式仍判「防线有效」）。
 *
 * 该文件由 `src/harness/host.mjs` 复制进临时目录后执行；不要直接运行。
 */
import { readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK,
  PLUGIN_PROTOCOL_INJECTION_CHECK,
  RESULT_CHANNEL_FD3,
  RESULT_CHANNEL_STDOUT_DEGRADED,
  PLUGIN_SKIP_ON_PRECONDITION,
  PROBE_CHECK_ORDER,
  PROBE_PHASE,
  PROBE_PHASE_BEACON_PREFIX,
  PROBE_RESULT_MARKER,
  probeResultLine,
  collectContract,
  pushHostFatal,
  recordProbeAsyncException,
  recordProbeEarlyExit,
  recordProbeException,
  recordProbeRunIncomplete,
} from './contract.mjs';

// ---- 🔴 必修-4：**加载期捕获**可被插件猴子补丁的全局引用（探针只用捕获值） ----
// 为什么必须有：探针与插件**同进程**，插件在 `apply()` 里改 `JSON.stringify` 是**一行**的事，
// 而探针原先在写出报告时才取**全局** `JSON.stringify` ⇒ 序列化函数可被替换：
// 实测（夹具 `plugin-stringify-tamper-plugin`）把 `JSON.stringify` 换成「把 checks 全改 pass、
// errors/hostFatal 清空、ok/runCompleted 置真」后，子进程 `exit status=1`（探针自己判了失败），
// 但报告里 `ok=true / 17 项全 pass` ⇒ **失败被吞、绿卡被采信**（与 R26 的 nonce 反读**同族**：
// 同进程 + 共用输出面，只是换了个全局）。
//
// 纪律（三条）：
// 1. **在任何插件代码之前**捕获（本段位于文件顶部，早于 `import(pluginPath)` 与 `apply()`）；
// 2. 探针后续**只**用捕获值（`STRINGIFY(...)` / `PARSE(...)`），不再取全局；
// 3. 捕获是**引用级**的：猴子补丁改的是 `JSON.stringify` 这个属性，捕获值仍指向原实现。
//
// 边界（显式声明，不越权承诺）：本层挡的是「替换序列化函数」这一类；同进程同 uid 下插件仍可
// 篡改**其它**全局 / 直接读探针内存 ⇒ 根治仍需**进程级**隔离（见 `docs/REDO-PROPOSAL.md` 批 2）。
// 第二道防线见装配器的**退出码交叉**校验（`host.mjs` 的 interpretProbeStdout）。
const STRINGIFY = JSON.stringify;
const PARSE = JSON.parse;

const [hubRoot, pluginPath, expectedToolsJson] = process.argv.slice(2);
const expectedTools = PARSE(expectedToolsJson ?? '[]');

// ---- nonce 带外通道（侧信道收口；**经 stdin**，不经 env / argv） ----
// 宿主每次运行生成随机 nonce，作为**子进程 stdin 的字节流**传进来（见 host.mjs 的
// `probeSpawnOptions()` / `PROBE_NONCE_STDIN_CHANNEL`）。探针只认这个值：输出的结构化结果
// 结果行带**正文绑定**的认证标签（`HMAC(nonce, 正文)`，v0.2.5 起；此前回显 nonce 本身），
// 宿主用**自己已知的 nonce** 重算标签并逐字比对。这样「谁是探针」由宿主掌握的随机量判定，
// 而不是靠公开字面量 `__DSH_PROBE__`——插件伪造裸 marker 会被宿主识别为伪造。
//
// ⚠️ 为什么**不是** env / argv（实测依据，见 docs/RISKS.md R26）：本仓曾并行落地 env 通道
// （随机环境变量名经 argv 传、值经 env 传，探针读到后 `delete process.env[NAME]`）。
// **实测可被同进程插件反读**：`delete` 只改 Node 的环境视图，不改内核里的进程环境块
// ⇒ 插件从 **`/proc/self/environ`** 读回 nonce，进而伪造出**被采信**的结果行
// （实测 GREEN / PASS / 17 项）；argv 同理出现在 `ps` / `/proc/self/cmdline`。
// stdin 的字节流不在进程环境块、也不在 argv 里 ⇒ 上述两条读取面都不成立。
//
// 纪律：读完**立刻** `process.stdin.destroy()`（否则插件可从 fd 0 / `/dev/fd/0` 再读一遍——
// 实测 destroy 后读回空串）。缺失时 `nonce` 为 null → 输出仍用裸 marker（保持离线/手工调用可用），
// 但宿主侧会按「无 nonce ⇒ 不可信」处理（见 host.mjs 的 interpretProbeStdout）。
const nonceValue = (() => {
  try {
    const text = readFileSync(0, 'utf8');
    // 读完**立刻** close：否则插件（或它的依赖）可以从 fd 0 再把 nonce 读一遍。
    try { process.stdin.destroy?.(); } catch { /* 某些平台无 stdin 对象：忽略 */ }
    return text.trim() || null;
  } catch {
    return null;
  }
})();
// hostFatal：**结构化**的宿主/环境侧致命信号（归因判据唯一依据，见 🔴-C）。
// errors：人类可读日志（可含插件侧 stack/路径）——**不参与判据**。
const out = { checks: [], errors: [], hostFatal: [], profile: null, contract: {}, probes: [], phase: null, ok: false };
/**
 * 当前执行相位（🔴-D 的唯一事实源在 `contract.mjs` 的 {@link PROBE_PHASE}）。
 *
 * 顶层 catch 靠它决定异常归属：`host-assembly` → `hostFatal[]`；`plugin-integration`
 * → **插件侧 check**（绝不进 `hostFatal[]`）。默认取宿主装配相位（探针启动即装配宿主）。
 */
let phase = PROBE_PHASE.HOST_ASSEMBLY;
out.phase = phase;
const check = (name, ok, detail) => {
  out.checks.push({ name, status: ok ? 'pass' : 'fail', detail: detail === undefined ? '' : String(detail).slice(0, 600) });
  if (!ok) out.errors.push(`${name}: ${detail ?? ''}`);
};
/** 记录「因前置失败而无法验证」的检查项（不产生错误，避免制造噪音归因）。 */
const skip = (name, detail) => {
  out.checks.push({ name, status: 'skip', detail: detail === undefined ? '' : String(detail).slice(0, 600) });
};
/**
 * 前置失败时把「尚未验证」的检查项标 skip（报告里看得见「哪些没验」，而不是凭空消失）。
 *
 * 已记录的检查项（pass/fail）不重复标注——否则同一 check 会同时出现 fail 与 skip 两条。
 *
 * @param {string[]} names 待标注的检查项名
 * @param {string} reason 跳过原因（进报告，供人判断「没验」还是「验失败」）
 */
const skipAll = (names, reason) => {
  const recorded = new Set(out.checks.map((c) => c.name));
  for (const name of names) if (!recorded.has(name)) skip(name, reason);
};
const brief = (error, limit = 600) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, limit);
/**
 * 向 stdout 打一行**相位信标**（`__DSH_PROBE_PHASE__<phase>`）。
 *
 * 为什么需要它：探针被**不可捕获**终止（`SIGKILL` / OOM / 原生 `abort`）时来不及写结构化结果，
 * 装配器只看到「探针未输出结构化结果」。若没有信标，它只能无条件 `pushHostFatal()`
 * → 插件把自己 `kill -9` 也会被判「上游漂移」。信标把「终止发生在哪一段」变成**证据**：
 * 有信标 ⇒ 插件代码正在运行（落插件侧 check）；无信标 ⇒ 宿主装配段（`hostFatal[]`）。
 *
 * 纪律：`writeSync` + 全包 try（这是崩溃路径上的写操作，**不得**抛）。
 * 命名与结构化结果标记（`__DSH_PROBE__`）刻意错开：信标第 13 个字符是 `P`，
 * 而结果标记要求 `_`，故 `startsWith('__DSH_PROBE__')` 不会误命中信标（见 [9.9] 断言）。
 *
 * @param {string} name 相位名（见 {@link PROBE_PHASE}）
 * @returns {void}
 */
function beacon(name) {
  const line = `${PROBE_PHASE_BEACON_PREFIX}${name}\n`;
  try {
    writeSync(1, line);
  } catch {
    try { process.stdout.write(line); } catch { /* 崩溃路径上的兜底不得再崩 */ }
  }
}

/**
 * 结构化结果的**专用通道**（fd3）。
 *
 * 为什么需要（R26）：结果原先与日志共用 stdout，插件只要在 `apply()` 里先写一条伪造结果
 * 就能抢到「第一条」位置（装配器 `find(startsWith(...))`），真报告被忽略 ⇒ **GREEN 放行**。
 * 改走 fd3 后：① 探针结果不再与日志混流；② **stdout 里出现结果行本身就是篡改证据**。
 * fd3 不可用（直接跑探针 / 老装配器 / 无该 fd）时回退 stdout——此时装配器按 2 参调用解释
 * （与 v0.1.9c 行为一致，见 `host.mjs` 的 `interpretProbeStdout()`）。
 *
 * @type {number}
 */
const RESULT_FD = 3;
/**
 * **通道可用性的早期快照**（在任何插件代码运行之前探测一次）。
 *
 * 为什么需要两个时点（批 1.5，评审 🔴-R2 的归因要求）：末次探测若发现 fd3 不可用，
 * 有两种**完全不同**的原因，必须能区分：
 * - 早探测也失败 ⇒ **环境**本身没有 fd3（容器 / Windows / 直接跑探针）⇒ 降级是环境限制，
 *   结论不可信（不放行），归因宿主/环境侧；
 * - 早探测成功、末次失败 ⇒ 通道是**在插件代码运行期间**被关闭 / 替换的（插件 `closeSync(3)`）
 *   ⇒ 这是**插件侧篡改结果通道**，落插件侧 check `plugin.protocol_injection`。
 * 只探一次就无法区分这两者，降级就会变成「谁都能把防线关掉而不被发现」。
 */
const resultChannelAtStart = probeResultChannel();
/**
 * 结果通道**可用性预检**（批 1.5：降级必须**显式可见**，不得静默）。
 *
 * 为什么需要（评审 🔴-R2）：原先 `writeResult()` 的返回值被调用点**丢弃**，报告里**看不到**
 * 这次走的是 fd3 还是 stdout。而 `interpretProbeStdout()` 在「结果通道为空」时会**回落到
 * stdout**——于是「降级」等于**静默把防线关掉**：降级后 stdout 上的结果行不再构成篡改证据，
 * 实测（无 fd3 的离线台）伪造 + `SIGKILL` ⇒ `ok=true / runCompleted=true / hostFatal=0`（**放行**）。
 *
 * 修法：写报告**之前**先探测 fd3 是否可写（`writeSync(3, '')` 在 fd 未开时抛 `EINVAL`，实测），
 * 把结果落进 `out.resultChannel`（`'fd3'` / `'stdout-degraded'`）⇒ 报告与二级信息里**可见**；
 * 降级时额外记一条 errors 行 ⇒ `ok` 必为 false（装配器另置 `resultChannelDegraded`）。
 *
 * 纪律：本函数运行在收尾路径上，**不得抛**。
 *
 * @returns {'fd3'|'stdout-degraded'} 通道形态
 */
function probeResultChannel() {
  try {
    writeSync(RESULT_FD, '');
    return RESULT_CHANNEL_FD3;
  } catch {
    return RESULT_CHANNEL_STDOUT_DEGRADED;
  }
}
/**
 * 把结构化结果写到结果通道（**崩溃路径**：不得抛）。
 *
 * @param {string} payload 完整结果行（含 `__DSH_PROBE__` 前缀与换行）
 * @returns {'fd3'|'stdout'} 实际使用的通道（供排障；降级形态由 {@link probeResultChannel} 先判定）
 */
function writeResult(payload) {
  try {
    writeSync(RESULT_FD, payload);
    return 'fd3';
  } catch {
    try {
      writeSync(1, payload);
    } catch {
      try { process.stdout.write(payload); } catch { /* 静默：崩溃路径上的兜底不得再崩 */ }
    }
    return 'stdout';
  }
}

// ---- 进程内防线：wrap API + 收尾四重自检（H1 / R22 / R28）----
/**
 * 我们自己的两个进程级 handler（**身份检查**的锚点）。
 *
 * 为什么不能只数个数（R28 已证）：插件用自己的回调顶替后 `listenerCount` 仍为 1，
 * `hasUncaughtExceptionCaptureCallback()` 仍为 true ⇒「计数判据」恒判「防线有效」（假阳性）。
 * 只有**认出自己的 handler 还在不在**才能判「防线是否被替换」。
 */
const defenseHandlers = { uncaughtException: null, unhandledRejection: null, exit: null };
/** 插件对防线 API 的调用台账（wrap 后逐次记账；由 `apply()` 内的调用填充）。 */
const defenseApiCalls = [];
/**
 * 台账的**记账范围**：只记 `plugin-integration` 相位（= 插件代码运行期间）的调用。
 *
 * 为什么按相位过滤：宿主装配段（`import('@deepseek-ai/cordis')` 等）里若上游库内部动了
 * `process.removeListener('uncaughtException', ...)`，那不是**插件**的干预——记进来会
 * 把健康插件误判成篡改（**过度修正**，闸门有反向断言守这一点）。
 * 探针在插件集成相位**之前**就完成了 wrap，故插件（含其依赖，含 import 期顶层代码）的调用
 * 全部落在记账范围内。
 */
let defenseCanaryActive = false;
/**
 * 在**任何插件代码运行之前**包装「可被插件用来撤销/静音防线」的 API，记录调用台账。
 *
 * 包装的四个面（都是插件实际会用到的写法）：
 * - `process.setUncaughtExceptionCaptureCallback`（独占 API；设置后监听器**不再被调用**）；
 * - `process.removeAllListeners('uncaughtException' | 'unhandledRejection')`（直接撤销）；
 * - `process.removeListener` / `process.off`（精确摘除我们的 handler）。
 *
 * 纪律：wrap 自身**不得抛**（它跑在探针启动路径上），且**不改语义**（照常调用原实现并返回其返回值）
 * ——把「探针的诊断能力」变成「插件的运行障碍」是必须避免的（见 R22 的取舍）。
 *
 * @returns {void}
 */
function wrapProcessDefenseApis() {
  // 记账范围含 `'exit'`（R23 同族，批 1.5 第 8 项）：出口③ 的 `process.on('exit')` 钩子原先
  // **不在台账**里 ⇒「插件把出口钩子单方摘除」这件事**不可判定**（实测：干净插件 +
  // `removeAllListeners('exit')` → 不判 `plugin.process_defense_tampered`，只因其它 fail 兜住）。
  const targets = ['uncaughtException', 'unhandledRejection', 'exit'];
  const wrap = (name, describe) => {
    const original = process[name];
    if (typeof original !== 'function') return;
    try {
      process[name] = function wrapped(...args) {
        try {
          const note = describe(args);
          // 只记插件集成相位的调用；canary 自己的 removeListener 不记账（否则自检变成「插件干预」）
          if (note && !defenseCanaryActive && phase === PROBE_PHASE.PLUGIN_INTEGRATION) defenseApiCalls.push(note);
        } catch { /* 记账失败不得影响原语义 */ }
        return Reflect.apply(original, this, args);
      };
    } catch { /* 属性不可写（极少数运行时）：放弃记账，不影响其它判据 */ }
  };
  wrap('setUncaughtExceptionCaptureCallback', (args) => (typeof args[0] === 'function'
    ? 'setUncaughtExceptionCaptureCallback（独占 API：capture callback 存在时 uncaughtException 监听器被停用）'
    : null));
  wrap('removeAllListeners', (args) => (targets.includes(args[0]) ? `removeAllListeners('${args[0]}')` : null));
  wrap('removeListener', (args) => (targets.includes(args[0]) ? `removeListener('${args[0]}')` : null));
  wrap('off', (args) => (targets.includes(args[0]) ? `off('${args[0]}')` : null));
}

/**
 * canary 哨兵标记（**Symbol**，不可从外部伪造）。
 *
 * 为什么用 Symbol 而不是错误消息字符串：探针的两个进程级 handler 必须**忽略**自检哨兵
 * （否则自检本身会被记账成「插件后台抛错」）。若用消息字符串判断，插件只要抛一个同名消息的
 * 错误就能把自己的异步异常**静音**——那是「防线自身成为活口」。Symbol 不出现在任何导出面上，
 * 插件无法构造带该标记的错误。
 *
 * @type {symbol}
 */
const PROBE_CANARY = Symbol('dsh-probe-defense-canary');

/**
 * 判定一个错误是否探针自检哨兵（我们的 handler 据此**不记账**）。
 *
 * @param {unknown} error 待判定对象
 * @returns {boolean}
 */
function isProbeCanary(error) {
  return Boolean(error && typeof error === 'object' && error[PROBE_CANARY] === true);
}

/**
 * 行为级 canary：走**真实派发路径**验证「探针的 `uncaughtException` 监听器是否仍会被调用」。
 *
 * 为什么需要它（R28 的教训）：`listenerCount > 0` / `hasUncaughtExceptionCaptureCallback()`
 * 这类**内省**判据只能说明「状态像是对的」，说明不了「监听器**会不会**被调用」。
 * canary 挂一个探针自己的临时监听器，再触发一次**真实派发**，看它是否被调用。
 *
 * 派发入口的选择（两版实测对比，**这是本函数最容易写错的地方**）：
 * - `process.emit('uncaughtException', e)`：**不可用**——实测在存在 capture callback 时
 *   仍会调用监听器（Node 的 capture-callback 分支在**内部派发函数**里，不在 `emit` 里），
 *   故对「被静音」无判别力（假阴性）；
 * - `process._fatalException(e)`：Node 的**内部派发入口**（`emit` 之上的那一层），
 *   实测能正确区分（有监听器 → canary 被调用；有 capture callback → canary **不被**调用）。
 *
 * 风险与边界（显式声明，不越权承诺）：
 * 1. 依赖内部入口 ⇒ **不可用时本层自动跳过**（返回 null = 不误报，其余三层仍生效）；
 * 2. 派发会调用**其它已注册监听器**（可能含插件自己的）⇒ 故只在 ①②③ 均干净时运行
 *    （对已被判出篡改的插件不再触发其代码）；
 * 3. 只覆盖 `uncaughtException`（capture callback 影响的就是这条派发路径）。
 *
 * @returns {string|null} 命中的人读证据；null = 防线完好 / 本层不可用（跳过）
 */
function runDefenseCanary() {
  const fatal = process._fatalException;
  if (typeof fatal !== 'function') return null;
  const sentinel = Object.assign(new Error('probe defense canary'), { [PROBE_CANARY]: true });
  let fired = false;
  const canary = (error) => { if (error === sentinel) fired = true; };
  try {
    defenseCanaryActive = true;
    process.on('uncaughtException', canary);
    try {
      fatal.call(process, sentinel);
    } catch {
      // 派发实现差异（非 Node / 版本差异）：本层跳过，绝不据此判篡改（防误报）
      return null;
    }
    return fired
      ? null
      : 'canary：探针临时注册的 uncaughtException 监听器**未被调用**（真实派发路径被静音 / 拦截）';
  } catch {
    return null;
  } finally {
    try { process.removeListener('uncaughtException', canary); } catch { /* 收尾路径上不得抛 */ }
    defenseCanaryActive = false;
  }
}

/**
 * 收尾自检：探针的进程内防线**是否仍然有效**（四重判据，缺一即被绕过）。
 *
 * | # | 判据 | 挡住的形态 |
 * |---|---|---|
 * | ① | API 调用台账非空（wrap 记账） | 插件抢占 capture API / 摘监听器（真实形态：Sentry / APM / 日志库） |
 * | ② | **身份检查**：我们的 handler 仍在 `process.listeners(event)` 里 | 插件**用自己的回调顶替**我们的（计数判据在此**假阳性**，见 R28） |
 * | ③ | 独占 API 存在（`hasUncaughtExceptionCaptureCallback()`，**独立**篡改信号） | 插件（或其依赖）抢占 capture callback ⇒ 监听器**不再被调用**（Node 官方语义） |
 * | ④ | 行为级 canary（`runDefenseCanary()`，best-effort） | 「监听器还在但不会被调用」的形态（拦截真实派发路径） |
 *
 * ⚠️ 判据**不得**退化为 `hasUncaughtExceptionCaptureCallback() || listenerCount > 0`
 * （R28 实测：插件顶替后该式恒真 = 形同虚设）。由 `tests/test_attribution.mjs` [9.4e] 源码守卫。
 *
 * 纪律：本函数运行在收尾路径上，**不得抛**。
 *
 * @returns {string[]} 命中的人读证据（空数组 = 防线完好）
 */
function checkProcessDefense() {
  const tampered = [];
  try {
    if (defenseApiCalls.length > 0) tampered.push(...defenseApiCalls);
    for (const event of ['uncaughtException', 'unhandledRejection', 'exit']) {
      const handler = defenseHandlers[event];
      let present = false;
      try { present = typeof handler === 'function' && process.listeners(event).includes(handler); } catch { present = true; }
      if (!present) {
        // `exit` 是**出口③**（进程提前退出）的记账钩子：被摘除 ⇒ 插件在验收完成前 `process.exit()`
        // 这件事将不可见（R23 同族，批 1.5 第 8 项）。
        tampered.push(event === 'exit'
          ? '探针的 exit 钩子（出口③：进程提前退出的记账）已不在 process.listeners(\'exit\') 中（被插件摘除或顶替）'
          : `探针的 ${event} 兜底 handler 已不在 process.listeners('${event}') 中（被插件摘除或顶替）`);
      }
    }
    let capturePresent = false;
    try { capturePresent = typeof process.hasUncaughtExceptionCaptureCallback === 'function' && process.hasUncaughtExceptionCaptureCallback() === true; } catch { capturePresent = false; }
    if (capturePresent) tampered.push('setUncaughtExceptionCaptureCallback（独占 API 存在 ⇒ uncaughtException 监听器不再被调用）');
    // ④ 行为级 canary：只在 ①②③ 均干净时跑（不对已判出篡改的插件再触发其监听器代码）
    if (tampered.length === 0) {
      const canary = runDefenseCanary();
      if (canary) tampered.push(canary);
    }
  } catch { /* 收尾路径上不得抛 */ }
  return [...new Set(tampered)];
}

/**
 * 结构化结果**只输出一次**（正常收尾 / 进程级兜底 两条路径共用）。
 *
 * 为什么用 `writeSync` 而不是 `process.stdout.write`：兜底路径随后立即
 * `process.exit()`，而 pipe 上的 `process.stdout.write` 是**异步**的——
 * 未 flush 就退出会让报告被截断（「探针未输出结构化结果」再次出现，等于没修）。
 * 通道选择见 {@link writeResult}（R26：fd3 优先，stdout 仅作回退）。
 *
 * @returns {void}
 */
let emitted = false;
function emit() {
  if (emitted) return;
  emitted = true;
  // H1 / R22 / R28（**放行级假绿**）收尾自检：插件是否把探针的进程内防线单方面撤销 / 静音了？
  // 必须在**写出报告之前**判，否则 GREEN 会被写出去（比 AMBER 更危险：AMBER 至少不放行）。
  // 判据 = `checkProcessDefense()` 的**四重**自检（API 台账 + 身份检查 + 独占 API + 行为级 canary）。
  // ⚠️ 不得退回 `hasUncaughtExceptionCaptureCallback() || listenerCount > 0`：
  //    插件**用自己的回调顶替**我们的 handler 时，该式恒真（R28 实测假阳性 = 形同虚设）。
  // 只在 `plugin-integration` 相位判：宿主装配段探针自己还没装监听器/还没跑插件，判了会误报。
  // 纪律：本自检**不得抛**（运行在收尾路径上）。
  try {
    if (out.phase === PROBE_PHASE.PLUGIN_INTEGRATION) {
      const tampered = checkProcessDefense();
      if (tampered.length > 0 && !out.checks.some((check) => check.name === PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK)) {
        out.checks.push({
          name: PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK,
          status: 'fail',
          detail: `插件撤销/静音/顶替了探针的进程级防线（${tampered.join('；')}）——后台抛错将不可见，本轮结果不可信`,
        });
        out.errors.push(`${PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK}: 探针进程内防线被插件干预（${tampered.join('；')}）`);
      }
    }
  } catch { /* 收尾路径上不得再抛 */ }
  // 完成位落进结构化结果（排障与断言都看得见「这次到底跑完了没有」）。
  out.runCompleted = runCompleted;
  // 批 1.5（🔴-R2）：结果通道**可见化**——报告里看得见这次走的是 fd3 还是降级到 stdout。
  out.resultChannel = probeResultChannel();
  out.resultChannelAtStart = resultChannelAtStart;
  if (out.resultChannel === RESULT_CHANNEL_STDOUT_DEGRADED) {
    // **降级不得判 PASS**：fd3 不可用时 stdout 上的结果行**不再构成**篡改证据
    // （装配器在通道为空时回落到 stdout）⇒ 本轮结论不可信。
    const closedByPlugin = resultChannelAtStart === RESULT_CHANNEL_FD3;
    if (closedByPlugin && !out.checks.some((c) => c.name === PLUGIN_PROTOCOL_INJECTION_CHECK)) {
      // 早探测成功、末次失败 ⇒ 通道是**在插件代码运行期间**被关闭/替换的（插件侧篡改）。
      out.checks.push({
        name: PLUGIN_PROTOCOL_INJECTION_CHECK,
        status: 'fail',
        detail: '结果通道 fd3 在插件代码运行期间变为不可写（早探测可写、收尾不可写）——插件关闭/替换了探针的结果通道，本轮结果不可信',
      });
      out.errors.push(`${PLUGIN_PROTOCOL_INJECTION_CHECK}: 结果通道被插件关闭/替换（早探测可写 → 收尾不可写）`);
    } else if (!closedByPlugin) {
      // 环境本身没有 fd3 ⇒ 降级是**环境限制**（不是插件的错）⇒ 按宿主/环境侧信号落 `hostFatal[]`：
      // 归因 `UPSTREAM_DRIFT` / AMBER（**不放行**，人须确认），且 `hostFatal[]` 里看得见原因。
      // 这样「降级」既**显式可见**（resultChannel 字段 + hostFatal 原因），又**不静默通过**。
      pushHostFatal(out, `结果通道 fd3 在本环境不可用（早探测即失败）⇒ 结构化结果降级走 stdout（${RESULT_CHANNEL_STDOUT_DEGRADED}）：stdout 上的结果行不再具备篡改证据能力，本轮结论不可信（不放行，人须确认）`);
    }
  }
  // 🔴 必修-1：`ok` 必须**同时**要求「跑完」与「无失败」——否则出口 ③ 的中途报告会假绿
  // （`apply()` 里 process.exit(0) → 剩余检查是 skip 不是 fail → 只看 errors 就 GREEN）。
  out.ok = runCompleted && out.errors.length === 0;
  // 结果行 = 认证标签 + 正文（宿主用**自己已知的 nonce** 重算标签并逐字比对；无 nonce 时退化）。
  const body = STRINGIFY(out);
  const payload = `${probeResultLine(nonceValue, body)}\n`;
  // R26：结果走**专用通道**（fd3 优先），stdout 只留日志 ⇒「stdout 里出现结果行」= 篡改证据。
  writeResult(payload);
}

/** definitions 不可用时无法验证的检查项（第 9/10/11 段共用，避免两处清单各自漂移）。 */
const SKIP_AFTER_DEFINITIONS = ['lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose', 'guard.reserved_rejected'];
/**
 * 工具清单**不可枚举**时无法验证的检查项（🔴-D：第 6 段读 `tools.schemas()` 时插件侧数据抛错）。
 *
 * 🟢（评审 §四）：后 4 项与 `SKIP_AFTER_DEFINITIONS` 完全重合——**派生**而非复制，
 * 否则两处清单会各自漂移（新增一项时只改一处 → 另一条路径漏标 skip，报告里少一项）。
 */
const SKIP_AFTER_REGISTRY = [
  'dispatch.execute_ok',
  'dispatch.render_projected',
  'dispatch.echo_payload',
  'dispatch.abort_semantics',
  'plugin.definitions_ok',
  ...SKIP_AFTER_DEFINITIONS,
];
/**
 * 装配一个隔离宿主（新 Context + SystemPrompt + ToolRuntime），返回其 `ctx.tools`。
 *
 * 🟢：探针共 3 处需要「另起一个干净宿主」（生命周期路径 / 保留名冲突路径），
 * 样板曾逐处复制（含 `sleep(200)` 等宿主就绪等待）；抽成一个函数后只有一处可写错。
 *
 * @param {Function} Context cordis Context 构造器
 * @param {Function} SystemPrompt 系统提示插件
 * @param {Function} ToolRuntime 工具运行时插件
 * @returns {Promise<{ctx: object, tools: object}>} 新宿主与其 `ctx.tools`
 */
async function mountTools(Context, SystemPrompt, ToolRuntime) {
  const ctx = new Context();
  ctx.plugin(SystemPrompt, {});
  ctx.plugin(ToolRuntime, {});
  // 宿主插件是异步装配的，等一拍再取 ctx.tools（实测 200ms 足够；取不到即 check 失败，不静默）
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { ctx, tools: ctx.get('tools') };
}

async function run() {
  let ctx;
  let tools;
  let hub;
  // 宿主符号提升到函数作用域：生命周期路径（第 10 段）也要用同一个 Context/ToolRuntime
  let Context;
  let ToolRuntime;
  let SystemPrompt;

  // ---- 1. 宿主装配：此段任何失败都是**宿主/环境侧** → hostFatal[]（结构化）+ fatal(host) 日志 ----
  try {
    ({ Context } = await import('@deepseek-ai/cordis'));
    ({ default: ToolRuntime } = await import('@deepseek-ai/dsh-tools'));
    ({ default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt'));
    hub = await import(pathToFileURL(`${hubRoot}/src/index.mjs`).href);

    ctx = new Context();
    ctx.plugin(SystemPrompt, {});
    ctx.plugin(ToolRuntime, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    tools = ctx.get('tools');
  } catch (error) {
    pushHostFatal(out, brief(error, 1200));
    return;
  }

  check(
    'host.tools_ready',
    Boolean(tools),
    tools ? `ctx.tools 已就绪（${tools.constructor?.name ?? 'ToolRuntime'}）` : 'ctx.tools 未就绪（宿主未装配 ToolRuntime）',
  );
  if (!tools) return;

  // ---- 2. 版本线探测 ----
  const profile = hub.detectHostFlavor(tools);
  out.profile = profile.toJSON();
  check('detect.flavor_known', profile.flavor !== 'unknown', profile.evidence);
  out.contract.configProjection = profile.signals.configProjection;

  // ---- 3. 契约指纹采集（上游漂移侦测基线；采集后必须立即卸载） ----
  try {
    const collected = collectContract(tools);
    Object.assign(out.contract, collected.contract);
    out.probes = collected.probes;
    check(
      'contract.probe_disposed',
      collected.residue.length === 0,
      collected.residue.length === 0
        ? `契约探测已全部卸载（${collected.probes.length} 项，不留副作用）`
        : `契约探测残留 ${collected.residue.join(',')}（宿主未返回可用 disposer → 上游 register 语义变了；残留会污染插件工具清单）`,
    );
  } catch (error) {
    pushHostFatal(out, `契约指纹采集失败：${brief(error, 1000)}`);
    return;
  }

  // ---- 4. 中台自身护栏（与插件无关，宿主侧契约 check） ----
  const guardWorks = (() => { try { hub.assertNotReserved('run_code'); return false; } catch { return true; } })();
  check('guard.reserved_name', guardWorks, guardWorks ? '中台保留名护栏可用（run_code 被插件侧拒绝）' : '插件侧未拒绝 DSH 保留名 run_code');

  const flattened = hub.normalizeSchema({ type: 'object', properties: { a: { type: 'json' } } });
  const flattenOk = hub.collectSchemaViolations(flattened).length === 0;
  check('compat.schema_flatten', flattenOk, flattenOk ? `schema 压平后无违规：${STRINGIFY(flattened)}` : `schema 压平后仍有违规：${STRINGIFY(flattened)}`);

  // ---- 5. 集成路径：插件 import / apply（**插件侧**失败 → check，绝不 fatal） ----
  // 🔴-D：相位切到「插件集成」——此后逃到顶层 catch 的异常一律落**插件侧 check**，
  // 绝不写 hostFatal[]（否则插件 bug 会被判成上游漂移，并盖掉插件侧已失败的 check）。
  phase = PROBE_PHASE.PLUGIN_INTEGRATION;
  out.phase = phase;
  // 相位信标：装配器据此为「不可捕获终止」（SIGKILL / OOM）按证据归因（见文件头）。
  beacon(phase);
  let plugin = null;
  try {
    plugin = await import(pathToFileURL(pluginPath).href);
  } catch (error) {
    check('plugin.loaded', false, `插件 import 失败（语法/依赖错误）：${brief(error)}`);
    skipAll(PLUGIN_SKIP_ON_PRECONDITION, '插件 import 失败，无法执行验收');
    return;
  }
  const hasApply = typeof plugin.apply === 'function';
  check('plugin.loaded', hasApply, hasApply ? '插件导出 apply(ctx)' : `插件未导出 apply(ctx)（导出面：${Object.keys(plugin).join(',') || '空'}）`);
  if (!hasApply) {
    skipAll(PLUGIN_SKIP_ON_PRECONDITION, '插件未导出 apply(ctx)，无法执行验收');
    return;
  }

  try {
    await plugin.apply({ tools, effect: (fn, label) => ctx.effect(fn, label) });
    check('plugin.apply_ok', true, '插件 apply(ctx) 执行成功（工具已注册）');
  } catch (error) {
    check('plugin.apply_ok', false, `插件 apply(ctx) 抛错（插件侧初始化失败）：${brief(error)}`);
    skipAll(PLUGIN_SKIP_ON_PRECONDITION, '插件 apply(ctx) 未成功，后续检查无法验证');
    return;
  }

  // ---- 6. 工具清单精确匹配（🔴-D：读插件侧数据必须加护栏，异常落插件侧 check） ----
  const want = [...expectedTools].sort();
  let actual;
  try {
    actual = tools.schemas().map((s) => s.name).filter((n) => !n.startsWith('probe_')).sort();
  } catch (error) {
    // `tools.schemas()` 会调用插件注册项的 getter（插件侧数据）——插件写错（未初始化字段 /
    // 抛错 getter）时异常从这里抛出。它**不是**宿主问题，必须落插件侧 check。
    check('registry.exact', false, `工具清单不可枚举（插件侧注册项读取出错）：${brief(error)}`);
    skipAll(SKIP_AFTER_REGISTRY, '工具清单不可枚举');
    return;
  }
  const registryExact = STRINGIFY(actual) === STRINGIFY(want);
  check('registry.exact', registryExact, registryExact ? `工具清单精确匹配（${actual.join(',')}）` : `期望 ${want.join(',')} / 实得 ${actual.join(',')}`);

  // ---- 7. 真实 dispatch：execute → output.schema 校验 → render 投影 ----
  const echoName = want.find((n) => n.endsWith('echo'));
  const dispatchName = echoName ?? want[0];
  let dispatched;
  try {
    dispatched = await tools.execute({ callId: 'probe-echo', name: dispatchName, arguments: { text: 'hello' }, signal: new AbortController().signal });
  } catch (error) {
    check('dispatch.execute_ok', false, `dispatch 抛错（插件工具实现问题）：${brief(error)}`);
    skip('dispatch.render_projected', 'dispatch 未成功，跳过');
    skip('dispatch.echo_payload', 'dispatch 未成功，跳过');
    skip('dispatch.abort_semantics', 'dispatch 未成功，跳过');
    return;
  }
  const dispatchDetail = STRINGIFY(dispatched.content)?.slice(0, 200);
  check(
    'dispatch.execute_ok',
    dispatched.isError !== true,
    dispatched.isError !== true ? `dispatch 成功：${dispatchDetail}` : `dispatch 失败：${dispatchDetail}`,
  );
  const projected = Array.isArray(dispatched.content) && dispatched.content.length > 0 && typeof dispatched.content[0]?.text === 'string';
  check('dispatch.render_projected', projected, projected ? `output.render 投影正确：${dispatchDetail}` : `output.render 未产出 text 块：${dispatchDetail}`);
  if (echoName) {
    const echoed = Array.isArray(dispatched.content) && String(dispatched.content[0]?.text ?? '').includes('echo: hello');
    check('dispatch.echo_payload', echoed, echoed ? `业务返回值正确：${dispatchDetail}` : `业务返回值不符（期望含 "echo: hello"）：${dispatchDetail}`);
  } else {
    check('dispatch.echo_payload', true, `插件未声明 *echo 工具（${dispatchName}），跳过回显载荷断言`);
  }

  // ---- 8. 取消语义（宿主三线一致要求） ----
  const aborter = new AbortController();
  aborter.abort();
  let cancelled;
  try {
    cancelled = await tools.execute({ callId: 'probe-abort', name: dispatchName, arguments: { text: 'x' }, signal: aborter.signal });
  } catch (error) {
    check('dispatch.abort_semantics', false, `已中止调用未被宿主拒绝而是抛错：${brief(error)}`);
    return;
  }
  check(
    'dispatch.abort_semantics',
    cancelled.isError === true,
    cancelled.isError === true
      ? '取消语义生效（已中止调用被拒绝）'
      : `取消语义失效：已中止的调用仍返回成功：${STRINGIFY(cancelled.content)?.slice(0, 160)}`,
  );

  // ---- 9. 插件 definitions（**插件侧**失败 → check，绝不 fatal） ----
  let definitions;
  try {
    definitions = typeof plugin.definitions === 'function' ? plugin.definitions({ profile: profile.toJSON() }) : plugin.definitions;
  } catch (error) {
    check('plugin.definitions_ok', false, `插件 definitions() 抛错（插件侧错误）：${brief(error)}`);
    skipAll(SKIP_AFTER_DEFINITIONS, 'definitions 不可用');
    return;
  }
  const definitionsUsable = Array.isArray(definitions) && definitions.length > 0;
  check(
    'plugin.definitions_ok',
    definitionsUsable,
    definitionsUsable ? `插件导出 ${definitions.length} 个工具定义` : `插件未导出可用的 definitions 数组（typeof=${typeof definitions}）`,
  );
  if (!definitionsUsable) {
    skipAll(SKIP_AFTER_DEFINITIONS, '插件无可注册定义');
    return;
  }

  // ---- 10. 生命周期：disposer 语义（独立 Context，宿主拒绝同层重名注册） ----
  try {
    const { ctx: ctx2, tools: tools2 } = await mountTools(Context, SystemPrompt, ToolRuntime);
    const lifecycle = hub.registerTools({ tools: tools2, effect: (fn, label) => ctx2.effect(fn, label) }, definitions, { profile });
    // 被拒绝的保留名不产生 disposer；按「可注册定义数」计数（避免把冲突误算成漏注册）
    const expectedDisposers = definitions.length - lifecycle.reservedRejected.length;
    check('lifecycle.disposer_count', lifecycle.disposers.length === expectedDisposers, lifecycle.disposers.length === expectedDisposers ? lifecycle.disposers.length + '/' + expectedDisposers + '（全部可注册定义均产出 disposer）' : lifecycle.disposers.length + '/' + expectedDisposers + '（数量不符）');
    const before = tools2.schemas().map((s) => s.name).sort();
    const lifecycleRegistered = STRINGIFY(before) === STRINGIFY([...expectedTools].sort());
    check('lifecycle.registered', lifecycleRegistered, lifecycleRegistered ? `独立上下文注册成功（${before.join(',')}）` : `独立上下文注册不符：${before.join(',')}`);
    lifecycle.disposers.forEach((dispose) => dispose());
    const after = tools2.schemas().map((s) => s.name);
    check('lifecycle.dispose', after.length === 0, after.length === 0 ? '卸载后无残留' : '卸载后仍残留：' + after.join(','));
  } catch (error) {
    check('lifecycle.registered', false, `生命周期路径执行抛错（插件定义不可注册）：${brief(error)}`);
    // 报告完整性（本轮实测发现的**同族**漏洞）：`lifecycle.disposer_count` 的 `check()` 在抛错点
    // **之前**，异常打断后它既没 pass 也没 fail——报告里就少一项（17 → 16），人分不清
    // 「没验」与「验过了」。`skipAll` 只补未记录项，故不会与已记录的 fail/skip 重复。
    skipAll(['lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose'], '生命周期路径未完成（抛错），该项未验证');
  }

  // ---- 11. 保留名冲突：既不得静默丢弃，也不得被放行（插件须改名） ----
  // 🔴-D：读插件侧 definitions 必须加护栏——`d?.name` 会触发插件对象的 getter，
  // 插件写错时异常从这里逃逸（历史缺陷：逃到顶层 catch → hostFatal[] → 误判上游漂移）。
  let reservedInDefs;
  try {
    reservedInDefs = definitions.map((d) => d?.name).filter((n) => hub.RESERVED_TOOL_NAMES.includes(n));
  } catch (error) {
    check('guard.reserved_rejected', false, `插件 definitions 不可读取（插件侧 getter/字段错误）：${brief(error)}`);
    return;
  }
  if (reservedInDefs.length === 0) {
    check('guard.reserved_rejected', true, `插件未使用 DSH 保留名（${hub.RESERVED_TOOL_NAMES.join(',')}）`);
  } else {
    let reported = false;
    try {
      const { tools: tools3 } = await mountTools(Context, SystemPrompt, ToolRuntime);
      const guardResult = hub.registerTools({ tools: tools3 }, definitions, { profile });
      reported = guardResult.reservedRejected.length === reservedInDefs.length
        && guardResult.issues.some((issue) => issue.includes('reserved_name_conflict'));
    } catch (error) {
      reported = false;
      out.errors.push(`guard.reserved_rejected: 保留名冲突处置抛错：${brief(error)}`);
    }
    // 插件声明保留名 = 违反宿主硬约束 → 验收必须判失败（且失败原因是插件侧，不是静默丢弃）
    check(
      'guard.reserved_rejected',
      false,
      `插件声明了 DSH 保留名 ${reservedInDefs.join(',')}，中台已拒绝并上报（reported=${reported}），但插件须改名后重跑`,
    );
  }
}

/**
 * 把「尚未跑到的检查项」按**规范顺序**标 `skip`（🔴-D 异步活口的要害之一）。
 *
 * 为什么必须补：进程级兜底在验收中途退出时，报告里只有已跑完的 check——
 * 剩余项凭空消失，人无法区分「没验」与「验过了」。历史缺陷下更糟：`checks` 直接为空
 * （整份报告消失）。补上后报告形态与正常失败一致（fail + skip 并存）。
 *
 * @param {string} reason 跳过原因（进报告）
 * @returns {void}
 */
function skipPendingChecks(reason) {
  const recorded = new Set(out.checks.map((c) => c.name));
  for (const name of PROBE_CHECK_ORDER) {
    if (!recorded.has(name)) skip(name, reason);
  }
}

// ---- 进程级兜底（🔴-D 同族活口 / 🔴 必修-2 / 🔴 必修-3：四条出口） ----
// 为什么必须有：只有**同步**异常才在 run() 的调用栈上、才被上面的 try/catch 接住。
// 插件侧错误还有三条出口逃出调用栈，逐条都要接住（少一条 = 插件 bug 被判成上游漂移）：
//   ② 异步异常（uncaughtException / unhandledRejection）——后台任务 / 事件回调 / 预取 promise；
//   ③ 进程 exit（插件调 process.exit() 或自杀式信号）——run() 再也回不来；
//   ④ run() 被拖住（挂住事件循环 / apply() 返回永不 resolve 的 Promise）——既无异常也无退出。
// 处置：按**同一份相位路由**归因（plugin-integration → 插件侧 check，绝不写 hostFatal[]），
// 照常输出结构化结果（已跑完的 check 全部保留 + 未跑到的按序补 skip），再退出。
// 纪律：本组处理器**自身不得抛**——它们运行在崩溃路径上，抛出 = 第二次崩溃 = 报告整份消失。

/**
 * 收尾前的异步排空窗口（毫秒）——给「插件在 apply() 里排的后台任务」一次抛错的机会。
 *
 * 边界（显式声明）：只覆盖微任务与**已就绪**的宏任务；更晚的延迟抛错在探针退出后发生，
 * 不属本防线范围（探针是有限时长验收，不是运行时守护）。
 */
const ASYNC_DRAIN_MS = 50;

/**
 * **无条件**安装的 `run()` 看门狗窗口（毫秒）——出口 ④ 的唯一防线。
 *
 * 与旧实现（`ASYNC_WATCHDOG_MS`）的三处差别，都是「装了却永不生效」的根因：
 * 1. **无条件安装**：旧版只在 `onProcessLevelException()` 里装 ⇒「单纯挂住、没有任何异常」
 *    （`apply()` 返回永不 resolve 的 Promise）根本不装看门狗 → 进程干等到外层超时（600s）
 *    → 装配器判「探针未输出结构化结果」→ 同一个误判。现在探针启动即装。
 * 2. **不 `unref()`**：旧版紧跟 `watchdog.unref?.()` ⇒ 事件循环里没有其它 handle 时
 *    进程直接走 exit 路径，看门狗**永不触发**（正是「run() 被拖住」这个场景）。
 *    收尾由 `finish()` 显式 `clearTimeout`，不靠 unref 让进程自己走。
 * 3. **与完成位联动**：到点收尾时 `runCompleted` 仍为 false ⇒ `emit()` 的 `ok` 必为 false
 *    ⇒ 判决 RED（不放行），而不是靠「恰好有一条 fail check」。
 *
 * 取值：比外层超时（600s）小两个数量级，又远大于健康插件全程（实测 3.7–4.2s）与
 * `ASYNC_DRAIN_MS`，故对正常验收零影响。回归可用 `DSH_PROBE_RUN_WATCHDOG_MS` **缩短**（见下）。
 */
const RUN_WATCHDOG_DEFAULT_MS = 20_000;
/**
 * 看门狗窗口的实际取值：默认 20s；**宿主侧**（CI / 回归）可用环境变量
 * `DSH_PROBE_RUN_WATCHDOG_MS` **缩短**它——用于让「run() 被拖住」的回归不必干等 20s。
 *
 * 为什么这不是活口（三条一起成立才成立）：
 * 1. **只许缩短、不许延长**（`Math.min`）：缩短 = 更保守（健康插件会被判红，不会假绿）；
 * 2. **下限 1s**：防止极端取值把窗口压到比正常验收还短；
 * 3. **在任何插件代码运行之前读取**（本常量位于文件顶部，早于 `phase` 切换与插件 import）
 *    ⇒ 被测插件**无法**影响它。
 */
const RUN_WATCHDOG_MS = Math.min(
  RUN_WATCHDOG_DEFAULT_MS,
  Math.max(1_000, Number(process.env.DSH_PROBE_RUN_WATCHDOG_MS) || RUN_WATCHDOG_DEFAULT_MS),
);

/** 是否已记录「进程级逃逸」的第一条（后续异常/信号是崩溃后的连锁噪声，记下来只会淹没真因）。 */
let failureHandled = false;
/** 探针收尾进行中（finish() 已调用）——exit 钩子据此不重复记「提前退出」。 */
let finishing = false;
/**
 * **完成位**：`run()` 是否正常返回过。
 *
 * 只在 `run()` 正常返回后置真（见文件尾）。`emit()` 的 `ok` 必须同时要求它——
 * 否则出口 ③ 的中途报告会假绿（`apply()` 里 `process.exit(0)` → 剩余检查是 `skip` 不是 `fail`
 * → 只看 `errors.length` 就 GREEN，比 AMBER 更危险）。
 */
let runCompleted = false;
/** 看门狗句柄（收尾时 clear，避免它拖住进程 / 在收尾后再开一枪）。 */
let runWatchdog = null;

/**
 * 统一收尾：clear 看门狗 → 输出结构化结果（含完成位）→ 以退出码退出。
 *
 * 收尾路径**只有这一条**（正常收尾、看门狗到点、信号处理器都调它），
 * 保证「报告形态与正常失败一致」只有一处可写错。`exit` 钩子走的是 `emit()`（它不能调
 * `process.exit`，会死循环），故钩子里单独补 skip + emit + 改 `process.exitCode`。
 *
 * @param {number} code 退出码（0 = 全绿；1 = 有失败）
 * @returns {void}
 */
function finish(code) {
  if (finishing) return;
  finishing = true;
  if (runWatchdog) { clearTimeout(runWatchdog); runWatchdog = null; }
  emit();
  process.exit(code);
}

/**
 * 记录一次「进程级逃逸」（出口 ②③④ 共用入口）。
 *
 * 只记第一条（后续是连锁噪声）；记录后**不立即退出**——抛错/退出的时机不确定，
 * 立即退出会让「已跑完的检查」取决于时机 → 同一插件两次跑出不同 `checks`（报告不确定）。
 * 改为让 `run()` 跑完再统一收尾；若 `run()` 不返回，由**无条件看门狗**兜住（出口 ④）。
 * 这条「不立即退出」正是「报告确定性」与「不挂死」的折中，两侧各有一条防线。
 *
 * @param {(out: object, phase: string, detail: string) => unknown} record 归属记录函数（按出口分落点）
 * @param {string} label 人读标签（进 skip 原因）
 * @returns {void}
 */
function recordProcessEscape(record, label) {
  if (failureHandled) return;
  failureHandled = true;
  try {
    record(out, phase, label);
  } catch {
    // 兜底里的兜底：连归因都写不进去时，至少保证报告仍被输出（绝不在崩溃路径上抛）。
  }
}

// ---- 出口 ②：进程级异步异常 ----
// 先 wrap 防线 API（在任何插件代码之前，探针启动即装）→ 插件对 capture API / 监听器的任何
// 干预都会被**记账**；再挂我们自己的两个 handler 并**登记身份**（收尾身份检查的锚点，R28）。
wrapProcessDefenseApis();
defenseHandlers.uncaughtException = (error) => {
  // 探针自检哨兵**不记账**（否则 canary 自己会变成一条「插件后台抛错」）；Symbol 标记不可伪造。
  if (isProbeCanary(error)) return;
  recordProcessEscape(recordProbeAsyncException, `uncaughtException：${brief(error, 1200)}`);
};
defenseHandlers.unhandledRejection = (reason) => recordProcessEscape(recordProbeAsyncException, `unhandledRejection：${brief(reason, 1200)}`);
process.on('uncaughtException', defenseHandlers.uncaughtException);
process.on('unhandledRejection', defenseHandlers.unhandledRejection);

// ---- 出口 ③：进程 exit（插件调 process.exit() / 自杀式信号） ----
// 为什么必须有 exit 钩子：`process.exit()` **不抛异常**，上面所有 try/catch 与 uncaughtException
// 都接不到；旧探针于是在写出结构化结果前直接消失 → 装配器判「探针未输出结构化结果」
// → 无条件 pushHostFatal() → 插件 bug 判 UPSTREAM_DRIFT/AMBER，且 checks 归零。
// 钩子内必须用 writeSync（见 emit 的说明），且**不得**抛（崩溃路径）。
defenseHandlers.exit = (code) => {
  if (finishing) return; // 探针自己正在收尾（finish() 已输出过结果）：不重复记、不改退出码
  try {
    // 走到这里 = 进程**不是**由探针的 finish() 退出的（finish 会先置 finishing）⇒ 一律是
    // 插件侧提前终止（探针从不在自己收尾之外主动退出）。**不看完成位**：即使 run() 已返回，
    // 插件在排空窗口里 exit 也是缺陷（宿主进程不是插件可以随便杀的）。
    recordProcessEscape(recordProbeEarlyExit, `插件在探针自身收尾前退出（exit code=${code}，runCompleted=${runCompleted}）`);
    skipPendingChecks('探针因插件侧提前退出（process.exit / 自杀式信号）中断，该项未验证');
  } catch { /* 崩溃路径上不再抛 */ }
  // 无论哪种情形都必须**补输出**报告：`run()` 已跑完但插件在排空窗口里 exit 时，
  // 探针自己没机会走 finish()——不补输出就又变成「探针未输出结构化结果」（整份报告消失）。
  emit();
  // 退出码：报告判失败（含「没跑完」）时，插件 exit(0) 也不得让装配器把这次运行读成通过。
  // exit 钩子里只能改 process.exitCode，不能再次 process.exit（会死循环）。
  if (!out.ok) { try { process.exitCode = 1; } catch { /* 极端情形：静默，报告已输出 */ } }
};
// 具名登记（不是匿名箭头）：`checkProcessDefense()` 的**身份检查**靠它判断「出口③ 的钩子是否
// 仍挂在 `process.listeners('exit')` 里」（批 1.5 第 8 项：摘除出口钩子原先不可判定）。
process.on('exit', defenseHandlers.exit);
// 自杀式信号：默认行为直接终止进程，**不触发** exit 钩子的记账语义（来不及写报告），
// 故显式接住 → 记插件侧 check → 输出报告 → 以失败码退出。
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  try {
    process.on(signal, () => {
      try {
        recordProcessEscape(recordProbeEarlyExit, `进程在验收完成前收到 ${signal}（插件侧自杀式信号 / 被外部终止）`);
        skipPendingChecks(`探针因 ${signal} 中断，该项未验证`);
      } catch { /* 崩溃路径上不再抛 */ }
      finish(1);
    });
  } catch { /* 平台不支持该信号时静默跳过，不影响其它出口 */ }
}

// ---- 出口 ④：run() 被拖住（无条件看门狗） ----
// 装上后**不 unref**：unref 会让「事件循环里没有其它 handle」时看门狗永不触发——
// 而那正是本出口的场景（插件把事件循环占死 / 返回永不 resolve 的 Promise）。
// 收尾由 finish() 显式 clearTimeout；健康插件在 3.7–4.2s 内跑完，20s 窗口零影响。
runWatchdog = setTimeout(() => {
  try {
    recordProcessEscape(recordProbeRunIncomplete, `探针 run() 未在 ${RUN_WATCHDOG_MS}ms 内返回（插件挂住事件循环 / apply() 返回永不 resolve 的 Promise）`);
    skipPendingChecks(`探针 run() 未在 ${RUN_WATCHDOG_MS}ms 内返回（插件侧挂住），该项未验证`);
  } catch { /* 崩溃路径上不再抛 */ }
  finish(1);
}, RUN_WATCHDOG_MS);

// ---- 出口 ①：同步异常（run() 调用栈上） ----
let syncThrew = false;
try {
  await run();
  // 完成位：只有走到这里（run() 正常返回）才算「跑完」——中途被 exit / 看门狗打断时保持 false。
  runCompleted = true;
} catch (error) {
  // 兜底（同步路径）：探针自身未预期的异常。**按相位归因**（🔴-D），不猜：
  // - host-assembly：宿主包 import / Context 装配 / 契约采集阶段 → 宿主/环境侧 → hostFatal[];
  // - plugin-integration：读插件侧数据（tools.schemas() / definitions.map()）时插件代码抛错
  //   → **插件侧 check**（plugin.unexpected_exception），绝不进 hostFatal[]。
  // 历史缺陷：旧注释假定「插件侧错误在 run() 内已落成 check」——该前提不成立（有插件侧异常
  // 直接从插件数据读取处逃逸），故必须显式分相位，不能一律 pushHostFatal()。
  // 归属逻辑收敛在 contract.mjs 的 recordProbeException()（与离线回归共用同一份）。
  recordProbeException(out, phase, brief(error, 1200));
  syncThrew = true;
}

// 收尾前先给已排队的微任务/宏任务一次机会跑完：插件在 apply() 里排的后台任务若抛错，
// 会在这里被上面两个处理器接住（而不是在「报告已输出之后」变成一个无人认领的崩溃）。
//
// 窗口是**有限**的（显式声明边界，不越权承诺）：探针是「有限时长验收」，不是运行时守护。
// 延迟超过本窗口的后台抛错不在此防线范围（那时探针早已退出、进程已不存在）——
// 这与「探针跑完就退出」的语义一致，不是新活口。窗口取 50ms 的理由：
// ① 覆盖微任务（queueMicrotask / Promise）与已就绪的宏任务（setTimeout(0)）；
// ② 对正常验收的额外耗时无感（相对 200ms 的宿主就绪等待可忽略）。
await new Promise((resolve) => setTimeout(resolve, ASYNC_DRAIN_MS));

// 退出码：跑完 + 无失败 + 无逃逸 ⇒ 0；否则 1。**完成位参与判定**（未跑完绝不给 0）。
finish(runCompleted && !syncThrew && !failureHandled && out.errors.length === 0 ? 0 : 1);
