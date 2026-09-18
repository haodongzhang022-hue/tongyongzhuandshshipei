/**
 * 契约指纹采集（上游漂移侦测的基线来源）。
 *
 * ## 为什么单独成模块
 * 采集要在**真实宿主**上真的调用 `tools.register()` 才能拿到上游措辞；
 * 而「注册了就必须卸载」是本模块最容易写错、也最容易把归因带跑的地方
 * （残留的探测工具会污染被测插件的工具清单 → 假失败 → 责任甩给插件）。
 * 因此把采集逻辑抽成**可离线单测**的纯函数：探针（真宿主）与离线单测
 * （假 `tools`）共用同一份实现，回归防线才不会只存在于真宿主 E2E 里。
 *
 * ## 纪律
 * - 每次探测 `register()` 成功后**立即 dispose**（`finally` 保证，抛错也卸）；
 * - 采集结果只反映上游**措辞**，不保留任何宿主副作用。
 *
 * @module dsh-adapt-hub/harness/contract
 */

import { writeSync } from 'node:fs';

/**
 * 三条契约探测（字段名与 `watch/upstream.mjs` 的 `CONTRACT_FIELDS` 对齐）。
 *
 * @type {{field: string, accepted: string, definition: () => object}[]}
 */
export const CONTRACT_PROBES = [
  {
    field: 'reservedName',
    accepted: 'ACCEPTED(unexpected)',
    definition: () => ({
      name: 'run_code',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      execute: async () => ({}),
    }),
  },
  {
    field: 'schemaSubset',
    accepted: 'ACCEPTED(unexpected)',
    definition: () => ({
      name: 'probe_bad_schema',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { a: { type: 'json' } } }, render: () => [] },
      execute: async () => ({}),
    }),
  },
  {
    field: 'outputShape',
    accepted: 'render-optional',
    definition: () => ({
      name: 'probe_no_render',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } },
      execute: async () => ({}),
    }),
  },
];

/**
 * 归因判据表（**唯一事实源**，探针与 `verify/runner` 共用）。
 *
 * 为什么要放在这里：探针（临时目录里跑）与执行器（仓库里跑）必须用**同一份**名单，
 * 否则一侧新增 check 而另一侧忘了登记，就会退化成「未知失败 → 不归因」甚至误判。
 * 放在被拷进临时目录的 `contract.mjs` 里，两侧 import 同一份。
 */

/**
 * 宿主/环境侧致命信号的**日志前缀**（探针与装配器拼人类可读 `errors[]` 时使用）。
 *
 * ⚠️ 纪律（评审 🔴-C）：此前缀**只许用于人读日志，绝不可作为归因判据的文本扫描目标**。
 * 判据只读结构化字段 {@link HOST_FATAL_FIELD}——否则插件侧错误文本或文件路径里恰好出现
 * `fatal(host)` 字面量，插件 bug 又会被翻案成「上游漂移」（与原 🔴-B 同族）。
 */
export const HOST_FATAL_PREFIX = 'fatal(host)';

/**
 * 宿主/环境侧致命信号的**结构化字段名**（探针 → 装配器 → 执行器 三段同名传递）。
 *
 * 归因判据 1 只读这个字段：`(probe.hostFatal ?? []).length > 0` → `UPSTREAM_DRIFT`。
 * 插件侧错误**永远**不进该字段（插件侧一律落 check）。
 */
export const HOST_FATAL_FIELD = 'hostFatal';

/**
 * 探针执行**相位**（🔴-D：探针兜底写入端的归属判据）。
 *
 * 探针分两段跑，两段的「异常归属」完全不同：
 * - `host-assembly`：宿主包 import / Context 装配 / 契约指纹采集 —— 失败是**宿主/环境侧**；
 * - `plugin-integration`：插件 import / apply / definitions / dispatch / 生命周期 —— 失败是**插件侧**。
 *
 * 历史缺陷（评审三轮 🔴-D）：顶层 catch 不看相位，一律 `pushHostFatal()`，
 * 于是「读插件侧数据时抛出的插件 bug」（未初始化字段 / 抛错 getter）被写进判据字段
 * `hostFatal[]` → 判 `UPSTREAM_DRIFT`/AMBER，把插件 bug 甩给上游，
 * 并盖掉同一次运行里已失败的插件侧 check。
 *
 * @type {{HOST_ASSEMBLY: string, PLUGIN_INTEGRATION: string}}
 */
export const PROBE_PHASE = {
  HOST_ASSEMBLY: 'host-assembly',
  PLUGIN_INTEGRATION: 'plugin-integration',
};

/**
 * 「探针自身未预期异常」在**插件集成相位**的落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 为什么需要它：插件集成相位里有些异常发生在 `run()` 的 try/catch 之外（读插件侧数据：
 * `tools.schemas()` / `definitions.map()`），逃到顶层 catch 时**没有**对应 check，
 * 若照旧落 `hostFatal[]` 就等于「插件 bug 报成上游漂移」。故给它们一个插件侧 check 名。
 */
export const PLUGIN_PROBE_EXCEPTION_CHECK = 'plugin.unexpected_exception';

/**
 * 探针结构化结果的**行标记**（探针唯一写出点与装配器读取端共用，防两侧字面量漂移）。
 *
 * 装配器 `host.mjs` 按行首匹配它取结构化结果；探针 `probe-template.mjs` 只经
 * {@link emitProbeResult} 写出——**写出点只有一处**，否则「谁在什么时机写出」又会分裂。
 */
export const PROBE_MARKER = '__DSH_PROBE__';

/**
 * 探针**进程边界逃逸**的种类（本族缺陷的收敛判据，评审 §二）。
 *
 * 探针进程逃到「无归属路由」的出口只有 **3 个**：
 * 1. `run()` 内的同步 `try/catch` —— 已闭合（各段各自护栏 + 顶层按相位兜底）；
 * 2. **异步异常**（`queueMicrotask` 抛错 / 未处理 Promise 拒绝）—— 本轮收口；
 * 3. **进程级 `exit`**（插件在 `apply()` 里 `process.exit()`）—— 本轮收口。
 *
 * ①②③ 都收敛到 {@link recordProbeException} 这**同一个归属路由**后，进程边界即穷举完毕。
 *
 * @type {{UNCAUGHT_EXCEPTION: string, UNHANDLED_REJECTION: string, PROCESS_EXIT: string}}
 */
export const PROCESS_ESCAPE = {
  UNCAUGHT_EXCEPTION: 'uncaught-exception',
  UNHANDLED_REJECTION: 'unhandled-rejection',
  PROCESS_EXIT: 'process-exit',
  // 第 4 个出口（本轮实测发现，评审 §二 枚举 ①②③ 之外的补充）：
  // 探针**挂住**（插件 `apply` 永不 resolve / 死循环 / 持有活动句柄）→ 装配器 `execFileSync` timeout。
  // 关键实测事实（两条，缺一就收不了口）：
  // - timeout 用 SIGTERM 终止子进程，而 **SIGTERM 默认终止不触发 `process.on('exit')`**；
  // - 且 `execFileSync`/`spawnSync` 在 timeout 路径下**丢弃**子进程被杀后写出的 stdout
  //   （实测：handler 里 `writeSync(1, …)` 的内容拿不到）→ 信号钩子单独不够用。
  // 故收口方式 = 探针**自持看门狗**（早于宿主 timeout 触发，在探针还活着时用正常 emit 单点写出）。
  TIMEOUT: 'timeout',
  // 外部信号终止（SIGTERM / SIGINT）：看门狗之外的兜底（如外部手动 kill、宿主 timeout 早于看门狗）。
  SIGNAL: 'signal',
};

/**
 * 「探针在跑完之前就退出」在**插件集成相位**的落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 与 {@link PLUGIN_PROBE_EXCEPTION_CHECK} 分开命名，是为了让报告里能一眼看出
 * 「是插件抛了异常」还是「插件把探针进程结束了」——两者的排障动作不同。
 * 两者**同属插件侧**（都写进 check，绝不进 `hostFatal[]`）。
 */
export const PLUGIN_PROBE_EXIT_CHECK = 'plugin.early_exit';

/**
 * 探针异常归属路由（**唯一事实源**，探针顶层 catch 与离线回归共用）。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @returns {{side: 'host'|'plugin', field?: string, check?: string}} 归属：宿主侧写字段 / 插件侧写 check
 *
 * 保守取向：**未知相位按插件侧处理**（绝不写 `hostFatal[]`）。
 * 宁可让人多看一眼插件侧失败，也不让一个未确认的信号去开「上游漂移」这道门
 * （那道门直接决定放行/改中台，代价更大）。
 */
export function probeFailureRoute(phase, escapeKind) {
  if (phase === PROBE_PHASE.HOST_ASSEMBLY) return { side: 'host', field: HOST_FATAL_FIELD };
  // 插件集成相位：按**逃逸种类**选落点 check 名（两者同属插件侧，都绝不进 hostFatal[]）。
  // - 异步/同步未预期异常 → `plugin.unexpected_exception`
  // - 探针在跑完之前退出（插件 `process.exit`）→ `plugin.early_exit`
  // 「探针没跑完」（进程 exit / 挂住超时 / 被信号终止）落 `plugin.early_exit`；
  // 其余未预期异常落 `plugin.unexpected_exception`。两者同属插件侧。
  const earlyExit = escapeKind === PROCESS_ESCAPE.PROCESS_EXIT
    || escapeKind === PROCESS_ESCAPE.SIGNAL
    || escapeKind === PROCESS_ESCAPE.TIMEOUT;
  const check = earlyExit ? PLUGIN_PROBE_EXIT_CHECK : PLUGIN_PROBE_EXCEPTION_CHECK;
  return { side: 'plugin', check };
}

/**
 * 记录「探针未预期异常」——**按相位**决定落点（🔴-D 的核心修复，探针与离线回归共用）。
 *
 * 收敛成一个函数的原因：`hostFatal[]` 是判据唯一事实字段，它的**写入端**必须只有一处可写错。
 * 此前顶层 catch 直接调 `pushHostFatal()`，而插件侧异常也会逃到那里 → 插件 bug 被写成宿主信号。
 *
 * @param {{checks: object[], errors: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 异常摘要（`brief()` 产物，含 stack）。仅进**人读日志**或**插件侧 check 的 detail**，
 *   **不得**进入 `hostFatal[]`（判据字段只收宿主/环境侧信号）
 * @param {string} [escapeKind] 逃逸种类，见 {@link PROCESS_ESCAPE}（默认 = 未预期异常）
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
export function recordProbeException(target, phase, detail, escapeKind) {
  const route = probeFailureRoute(phase, escapeKind);
  // 相位落进结构化结果：报告里看得见「异常发生在哪一段」，排障不必猜。
  target.phase = phase;
  if (route.side === 'host') {
    return { side: 'host', line: pushHostFatal(target, `探针未预期异常：${detail}`) };
  }
  // 插件集成相位：落**插件侧 check**（名字已登记进 PLUGIN_SIDE_CHECKS，否则归因退化成 UNKNOWN）。
  // 绝不写 hostFatal[]——那是「上游漂移」这道门的唯一钥匙。
  const text = String(detail).slice(0, 600);
  target.checks.push({ name: route.check, status: 'fail', detail: text });
  const line = `${route.check}: 探针未预期异常（${phase} 相位，插件侧数据读取出错）：${text}`;
  if (!Array.isArray(target.errors)) target.errors = [];
  target.errors.push(line);
  return { side: 'plugin', line };
}

/**
 * 记录一条宿主/环境侧致命信号：**同时**写结构化字段（判据唯一依据）与人读日志行。
 *
 * 存在的意义：把「谁写信号、谁读信号」收敛成一个函数，避免有人再往
 * `errors` 里塞关键词、再由判据去扫文本（那正是 🔴-B / 🔴-C 的失效机制）。
 *
 * @param {{errors: string[], hostFatal?: string[]}} target 探针 `out` 或装配器 `result`
 * @param {string} detail 宿主/环境侧失败原因（**不得**拼入插件侧 stack）
 * @returns {string} 写入 `errors` 的日志行
 */
export function pushHostFatal(target, detail) {
  const text = String(detail);
  if (!Array.isArray(target.hostFatal)) target.hostFatal = [];
  // 🟢：两个字段都归一——只给了 hostFatal 的调用方（或外部传入的畸形对象）不得在此抛 TypeError，
  // 否则「记录一条宿主侧信号」本身会炸成未归因异常（写入端最不该有的失败模式）。
  if (!Array.isArray(target.errors)) target.errors = [];
  target.hostFatal.push(text);
  const line = `${HOST_FATAL_PREFIX}: ${text}`;
  target.errors.push(line);
  return line;
}

/**
 * 探针**完成位**字段名（防止「没跑完」被报成「通过」的假绿，评审 §二 ⚠️）。
 *
 * 语义：**只有 `run()` 正常返回后**才置真。任何「提前退出」（插件 `process.exit`）或
 * 未预期异常都不会置真 → {@link finalizeProbeResult} 必判 `ok=false`。
 *
 * 为什么必须有它：若只在 `process.on('exit')` 里补 emit 而不带完成位，
 * 插件 `process.exit(0)` 会得到 **GREEN 且 checks 只剩前几项**的**假绿**——
 * 比 AMBER（至少是红的、有人看）更危险：把「没跑完」报成「通过」。
 */
export const PROBE_COMPLETION_FIELD = 'runCompleted';

/** 探针「被哪种进程边界逃逸打断」的字段名（进结构化结果，供报告与断言）。 */
export const PROBE_ESCAPE_FIELD = 'escapedBy';

/** 探针「提前退出」的实况字段名（保留真实退出码，防钩子吞掉 `exit(1)` 语义）。 */
export const PROBE_ESCAPE_CODE_FIELD = 'escapeCode';

/**
 * 收口探针判决：**完成位 + 无错误** 才判 `ok`（唯一事实源，探针与离线回归共用）。
 *
 * @param {{errors: string[], ok?: boolean, [PROBE_COMPLETION_FIELD]?: boolean}} out 探针结果
 * @returns {object} 同一个 `out`（就地更新 `ok`）
 */
export function finalizeProbeResult(out) {
  const completed = out?.[PROBE_COMPLETION_FIELD] === true;
  const errors = Array.isArray(out?.errors) ? out.errors : [];
  out.ok = completed && errors.length === 0;
  return out;
}

/**
 * 序列化探针结构化结果（单行 `PROBE_MARKER + JSON`）。**纯函数**，离线可测。
 *
 * @param {object} out 探针结果
 * @returns {string} 单行文本（含换行）
 */
export function serializeProbeResult(out) {
  return `${PROBE_MARKER}${JSON.stringify(out)}\n`;
}

/**
 * 写出探针结构化结果——**探针的唯一写出点**。
 *
 * 为什么收敛成一处：写出时机（正常结束 / 异步逃逸 / 进程 exit 兜底）有三条路径，
 * 若各自 `process.stdout.write`，就会出现「谁先写、写什么状态」的分裂（本族缺陷同族）。
 *
 * 写出方式：默认 `writeSync(1, ...)`——`process.exit()` 前用 `process.stdout.write`
 * 写**大 payload**（checks 全量）有被截断的风险，截断 = 装配器读不到 → 误判宿主侧。
 *
 * @param {object} out 探针结果
 * @param {{write:(chunk:string)=>unknown}} [sink] 写出目标（离线测试注入假 sink；默认同步写 fd 1）
 * @returns {string} 写出的整行
 */
export function emitProbeResult(out, sink) {
  const line = serializeProbeResult(out);
  if (sink && typeof sink.write === 'function') {
    sink.write(line);
    return line;
  }
  try {
    writeSync(1, line);
  } catch {
    // 极端情况（非阻塞 stdout / 非主线程）退化为流写出：宁可异步，也不静默丢结果。
    process.stdout.write(line);
  }
  return line;
}

/**
 * 探针**进程边界守卫**（异步活口 + 进程 exit 出口的收口，评审 §二方案①）。
 *
 * 探针进程逃到「无归属路由」的出口只有 3 个，①②③ 全部收敛到本守卫：
 * 1. `run()` 内同步 `try/catch`（已闭合，不归本守卫管）；
 * 2. **异步异常**（`queueMicrotask` 抛错 / 未处理 Promise 拒绝）→ `uncaughtException` / `unhandledRejection`；
 * 3. **进程级 exit**（插件 `apply()` 里 `process.exit()`）→ `exit`。
 *
 * 三条铁律（缺一即退化成更坏的东西）：
 * - **完成位**：任何逃逸路径都不置真 → `ok` 必为 `false`（防假绿）；
 * - **同一归属路由**：一律经 {@link recordProbeException} 按相位落点（插件集成相位绝不进 `hostFatal[]`）；
 * - **照常输出结构化结果**：逃逸时仍 emit 全量 `out`（`checks` 不丢），不是「悄悄死掉」。
 *
 * @param {object} options 选项
 * @param {object} options.out 探针结果对象（就地更新）
 * @param {{write:(chunk:string)=>unknown}} [options.sink] 写出目标（离线测试注入）
 * @param {(code:number)=>unknown} [options.exit] 退出函数（离线测试注入；默认 `process.exit`）
 * @returns {{state:{emitted:boolean}, emit:Function, recordEscape:Function, install:Function}}
 */
export function createProbeBoundary(options) {
  const out = options.out;
  const sink = options.sink;
  const exit = options.exit ?? ((code) => { process.exitCode = code; process.exit(code); });
  // 看门狗阈值（毫秒）：**必须早于**宿主 `execFileSync` 的 timeout——否则宿主先杀进程，
  // 而 timeout 路径下子进程的 stdout 会被丢弃（实测）→ 又回到「探针无归属地死掉」。
  // 默认 0 = 不装（离线单测与无超时场景）。
  const watchdogMs = Number(options.timeoutMs ?? 0);
  const state = { emitted: false, watchdog: null };

  /** 写出结果（幂等：只写一次，避免多条 marker 让装配器取到半成品）。 */
  const emit = () => {
    if (state.emitted) return false;
    state.emitted = true;
    finalizeProbeResult(out);
    emitProbeResult(out, sink);
    return true;
  };

  /**
   * 记录一次进程边界逃逸，并立刻收口（写结果 + 以失败码退出）。
   *
   * @param {string} kind 见 {@link PROCESS_ESCAPE}
   * @param {string} detail 人类可读摘要（含 stack，仅进日志/插件侧 check detail）
   * @param {number|null} [code] 进程退出码实况（仅 `process-exit` 有）
   */
  const recordEscape = (kind, detail, code = null) => {
    // 已完成（正常收口或已逃逸收口）：迟到的异步错误**不得翻案**——否则一次
    // 正常通过的验收会被收尾后飞来的 reject 改写成失败（归因噪声）。
    if (state.emitted) return { kind, skipped: true };
    const phase = out.phase ?? PROBE_PHASE.HOST_ASSEMBLY;
    out[PROBE_ESCAPE_FIELD] = kind;
    if (kind === PROCESS_ESCAPE.PROCESS_EXIT || kind === PROCESS_ESCAPE.SIGNAL || kind === PROCESS_ESCAPE.TIMEOUT) out[PROBE_ESCAPE_CODE_FIELD] = code;
    recordProbeException(out, phase, detail, kind);
    // 逃逸 = 探针没跑完：完成位不置真（它只在 run() 正常返回后置真），故 ok 必为 false。
    emit();
    // [MEDIUM] 钩子不得吞掉失败语义：逃逸路径一律显式退出码 1
    // （真实退出码已保留在 PROBE_ESCAPE_CODE_FIELD，排障不丢实况）。
    exit(1);
    return { kind, phase, code };
  };

  /**
   * 装上进程级钩子（真实探针调用；离线回归可用假 process 测）。
   *
   * @param {object} [target] 默认 `process`
   * @returns {Function} 卸载函数（离线测试用；真实探针不需要卸）
   */
  /**
   * 装自持看门狗：**早于宿主 timeout** 触发，在探针仍活着时经同一 emit 单点写出结果。
   *
   * 为什么必须有它（第 4 个出口）：插件 `apply` 挂住且持有活动句柄时，事件循环不空 →
   * 进程不会自然退出（`exit` 钩子不触发）；宿主 `execFileSync` timeout 用 SIGTERM 杀进程，
   * 而 timeout 路径**丢弃**被杀后写出的 stdout → 探针输出拿不到 → 装配器只能记宿主侧致命 →
   * 插件把探针挂住却判 `UPSTREAM_DRIFT`/AMBER（同一失效族）。
   *
   * @param {number} [ms] 阈值；默认取构造时的 `options.timeoutMs`
   * @returns {boolean} 是否装上
   */
  const armWatchdog = (ms = watchdogMs) => {
    if (!(ms > 0) || state.watchdog) return false;
    state.watchdog = setTimeout(() => {
      recordEscape(PROCESS_ESCAPE.TIMEOUT, `探针在跑完之前超时挂住（${ms}ms 内未收尾）——插件可能挂住了探针`, ms);
    }, ms);
    return true;
  };

  const install = (target = process) => {
    const onUncaught = (error) => { recordEscape(PROCESS_ESCAPE.UNCAUGHT_EXCEPTION, briefError(error)); };
    const onRejection = (reason) => { recordEscape(PROCESS_ESCAPE.UNHANDLED_REJECTION, briefError(reason)); };
    const onExit = (code) => {
      // 正常路径已 emit（`emitted` 为真）→ 不重复写、不改判、不动退出码。
      if (state.emitted) return;
      recordEscape(PROCESS_ESCAPE.PROCESS_EXIT, `探针在跑完之前退出（exit code=${code}）`, code);
    };
    // 第 4 个出口：被信号终止（装配器 timeout → SIGTERM）。**实测**：SIGTERM 默认终止
    // **不会**触发 `exit` 钩子，故必须显式接——否则探针挂住时仍会「无归属地死掉」→
    // 装配器只能记宿主侧致命 → 判 AMBER（插件把探针挂住却甩给上游）。
    const onSignal = (signal) => {
      if (state.emitted) return;
      recordEscape(PROCESS_ESCAPE.SIGNAL, `探针在跑完之前被信号终止（${signal}）——插件可能挂住了探针`, null);
    };
    const onSigterm = () => onSignal('SIGTERM');
    const onSigint = () => onSignal('SIGINT');
    target.on('uncaughtException', onUncaught);
    target.on('unhandledRejection', onRejection);
    target.on('exit', onExit);
    target.on('SIGTERM', onSigterm);
    target.on('SIGINT', onSigint);
    armWatchdog();
    return () => {
      if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
      target.removeListener?.('uncaughtException', onUncaught);
      target.removeListener?.('unhandledRejection', onRejection);
      target.removeListener?.('exit', onExit);
      target.removeListener?.('SIGTERM', onSigterm);
      target.removeListener?.('SIGINT', onSigint);
    };
  };

  return { state, emit, recordEscape, install, armWatchdog };
}

/** 异常摘要（`brief()` 的共享实现：探针与守卫用同一份措辞，防两侧漂移）。 */
function briefError(error, limit = 1200) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, limit);
}

/** 宿主/环境侧检查项（失败即判上游漂移：宿主未就绪 / 版本线不可判定 / 契约探测未卸载）。 */
export const HOST_SIDE_CHECKS = ['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed'];

/** 中台自身契约检查项（失败是否算上游漂移，取决于契约基线是否漂移）。 */
export const CONTRACT_SIDE_CHECKS = ['guard.reserved_name', 'compat.schema_flatten'];

/**
 * 插件侧**硬证据**检查项：失败即插件违反宿主硬约束，判 `PLUGIN_REGRESSION`，
 * **优先于任何漂移相关性**（漂移窗口内也必须成立，见评审 🔴-C）。
 *
 * 纪律：**精确 check 名，不做前缀通配**。
 * - `guard.reserved_rejected`：插件声明了 DSH 保留名（插件侧违规，与上游契约无关）；
 * - `guard.reserved_name` **不在**此列：它是中台自检（hub 自身护栏坏了），
 *   不是插件违规；把它算进硬证据会过度修正（评审 🟡-1）。
 *
 * 反例（为什么必须优先）：上游若放宽保留名校验（`reservedName` 漂移），
 * `guard.reserved_rejected` 仍会 fail——若让漂移相关性先判，插件侧硬违规会被
 * 吞成 `UPSTREAM_DRIFT`/AMBER，责任被甩给上游（历史缺陷 🔴-C）。
 *
 * @type {readonly string[]}
 */
export const PLUGIN_HARD_EVIDENCE = ['guard.reserved_rejected'];

/** 插件侧检查项（失败即判插件回归；归因优先级低于宿主侧与插件侧硬证据）。 */
export const PLUGIN_SIDE_CHECKS = [
  'plugin.loaded',
  'plugin.apply_ok',
  'plugin.definitions_ok',
  'registry.exact',
  'dispatch.execute_ok',
  'dispatch.render_projected',
  'dispatch.echo_payload',
  'dispatch.abort_semantics',
  'lifecycle.disposer_count',
  'lifecycle.registered',
  'lifecycle.dispose',
  'guard.reserved_rejected',
  // 🔴-D：插件集成相位里逃到顶层 catch 的未预期异常（读插件侧数据时插件代码抛错）
  'plugin.unexpected_exception',
  // 异步活口收口：插件集成相位里「探针跑完之前就退出」（插件 apply 里 process.exit）
  'plugin.early_exit',
];

/** 探测工具名（用于残留自检；这三个名字不得出现在被测插件可见的工具清单里）。 */
export const CONTRACT_PROBE_NAMES = ['run_code', 'probe_bad_schema', 'probe_no_render'];

/**
 * 采集契约指纹。
 *
 * @param {{ register: (definition: object) => unknown, schemas?: () => {name:string}[] }} tools 宿主 `ctx.tools`
 * @returns {{contract: Record<string,string>, probes: {field:string,accepted:boolean,disposed:boolean}[], residue: string[]}}
 *   - `contract`：字段 → 上游措辞（被接受时记 `ACCEPTED(unexpected)` / `render-optional`）；
 *   - `probes`：每个探测的接受/卸载实况（排障与单测用）；
 *   - `residue`：采集后仍在宿主工具清单里的探测工具名（**正常必须为空**）。
 */
export function collectContract(tools) {
  const contract = {};
  const probes = [];

  for (const probe of CONTRACT_PROBES) {
    let disposer;
    let accepted = false;
    let disposed = false;
    try {
      disposer = tools.register(probe.definition());
      accepted = true;
      contract[probe.field] = probe.accepted;
    } catch (error) {
      contract[probe.field] = String(error?.message ?? error);
    } finally {
      // 关键：上游若「接受」了探测定义，注册就真的生效了——必须立即卸载，
      // 否则残留工具会污染被测插件的工具清单（历史上正是这条把插件误判成回归）。
      if (typeof disposer === 'function') {
        try { disposer(); disposed = true; } catch { disposed = false; }
      }
      probes.push({ field: probe.field, accepted, disposed });
    }
  }

  let residue = [];
  if (typeof tools?.schemas === 'function') {
    try {
      residue = tools
        .schemas()
        .map((schema) => schema?.name)
        .filter((name) => CONTRACT_PROBE_NAMES.includes(name));
    } catch {
      residue = [];
    }
  }

  return { contract, probes, residue };
}
