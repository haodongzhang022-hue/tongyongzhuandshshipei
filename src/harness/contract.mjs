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
 * 探针异常归属路由（**唯一事实源**，探针顶层 catch 与离线回归共用）。
 *
 * 返回值**只给归属与落点**：宿主侧 → `hostFatal[]`（唯一落点由 {@link pushHostFatal} 决定，
 * 此处不再回传字段名——回传会让人以为存在「第二处落点」，评审 🟢 已点名）；插件侧 → check 名。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @returns {{side: 'host'} | {side: 'plugin', check: string}} 归属：宿主侧写 hostFatal[] / 插件侧写 check
 *
 * 保守取向：**未知相位按插件侧处理**（绝不写 `hostFatal[]`）。
 * 宁可让人多看一眼插件侧失败，也不让一个未确认的信号去开「上游漂移」这道门
 * （那道门直接决定放行/改中台，代价更大）。
 */
export function probeFailureRoute(phase) {
  return phase === PROBE_PHASE.HOST_ASSEMBLY
    ? { side: 'host' }
    : { side: 'plugin', check: PLUGIN_PROBE_EXCEPTION_CHECK };
}

/**
 * 探针「异步异常」的插件侧落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 与 {@link PLUGIN_PROBE_EXCEPTION_CHECK} 的分工：那个收的是**同步**异常
 * （`run()` 调用栈上，逃到顶层 `catch`）；本名收的是**进程级异步异常**
 * （`uncaughtException` / `unhandledRejection`）——插件在 `apply()` 里排的后台任务
 * / 事件回调 / 预取 promise 抛错，**根本不在** `run()` 的调用栈上，
 * 顶层 `catch` 永远接不到（评审 🔴-D 同族活口）。
 *
 * 为什么要给独立名字而不是复用：两条路径的排障动作不同（一个查插件数据读取、
 * 一个查插件后台任务），报告里必须能一眼分清。
 */
export const PLUGIN_ASYNC_EXCEPTION_CHECK = 'plugin.async_uncaught_exception';

/**
 * 进程级异常归属路由（**唯一事实源**，探针的进程级兜底与离线回归共用）。
 *
 * 语义与 {@link probeFailureRoute} **完全一致**（按相位、未知相位保守判插件侧），
 * 唯一区别是落点 check 名不同（异步异常有独立名字，便于排障定位）。
 *
 * 为什么需要单独一层：`probeFailureRoute()` 的落点名描述的是「探针自身未预期异常」，
 * 而进程级异步异常的主体是**插件的后台任务**——两者混用会让报告撒谎
 * （人看到 `plugin.unexpected_exception` 会去查插件数据读取，实际要查后台任务）。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @returns {{side: 'host'|'plugin', check?: string}} 归属：宿主侧 → hostFatal[]；插件侧 → check
 */
export function probeAsyncFailureRoute(phase) {
  return probeFailureRoute(phase).side === 'host'
    ? { side: 'host' }
    : { side: 'plugin', check: PLUGIN_ASYNC_EXCEPTION_CHECK };
}

/**
 * 记录「进程级异步异常」（`uncaughtException` / `unhandledRejection`）——**按相位**决定落点。
 *
 * 与 {@link recordProbeException} 同一纪律：`hostFatal[]` 是判据唯一事实字段，
 * 插件侧的异步异常**绝不**进该字段。未知相位保守判插件侧。
 *
 * 额外保证（🔴-D 同族活口的要害）：本函数**不抛异常**——它运行在
 * `uncaughtException` 处理器里，任何抛出都会让探针在写出 `__DSH_PROBE__` 之前再次崩掉，
 * 于是整份报告消失、`checks` 从 17 掉到 0（比「盖掉一条 check」更彻底）。
 * 故内部对 `target` 做全部归一，并吞掉自身异常（记一条日志行）。
 *
 * @param {{checks?: object[], errors?: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 异常摘要（含 stack）——仅进人读日志 / 插件侧 check 的 detail
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
export function recordProbeAsyncException(target, phase, detail) {
  try {
    const route = probeAsyncFailureRoute(phase);
    target.phase = phase;
    const text = String(detail).slice(0, 600);
    if (!Array.isArray(target.checks)) target.checks = [];
    if (!Array.isArray(target.errors)) target.errors = [];
    if (route.side === 'host') {
      return { side: 'host', line: pushHostFatal(target, `探针进程级异步异常：${text}`) };
    }
    target.checks.push({ name: route.check, status: 'fail', detail: text });
    const line = `${route.check}: 插件后台任务未捕获异常（${phase} 相位，插件侧异步错误）：${text}`;
    target.errors.push(line);
    return { side: 'plugin', line };
  } catch (error) {
    // 兜底里的兜底：记录失败**不得**升级成第二次崩溃（否则报告整份消失）。
    try {
      if (!Array.isArray(target.errors)) target.errors = [];
      target.errors.push(`recordProbeAsyncException 自身失败（已吞掉，不影响报告输出）：${String(error?.message ?? error)}`);
    } catch { /* 连 errors 都写不进去时，静默——绝不能在这里抛 */ }
    return { side: 'plugin', line: '' };
  }
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
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
export function recordProbeException(target, phase, detail) {
  const route = probeFailureRoute(phase);
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
  // 🔴-D 同族活口：插件后台任务（apply 里排的微任务/定时器/promise）的未捕获异常——
  // 不在 run() 调用栈上，顶层 catch 接不到，由探针的进程级兜底按相位归到这里。
  'plugin.async_uncaught_exception',
];

/**
 * 探针的**条件触发检查项**：仅在异常路径出现，**不计入 17 项**（文档口径见
 * `docs/ADAPTER_GUIDE.md`「另有 1 项条件检查」/ `docs/INDEX.md`）。
 *
 * 为什么单独成表：`PROBE_CHECK_ORDER` 与「条件项」必须能互相推出，
 * 否则「17 项」的口径会随新增条件项悄悄变成 18 项而无人发现。
 */
export const CONDITIONAL_PROBE_CHECKS = [PLUGIN_PROBE_EXCEPTION_CHECK, PLUGIN_ASYNC_EXCEPTION_CHECK];

/**
 * 探针 17 项检查的**规范输出顺序**（= `docs/INDEX.md` 的 `#` 序号列口径）。
 *
 * 用途：进程级兜底（`uncaughtException` / `unhandledRejection`）中断验收时，
 * 把「尚未跑到的检查」按**同一顺序**标 `skip`——报告里看得见「哪些没验」，
 * 且顺序与正常报告一致（人比对两次运行不必重排）。
 *
 * 与探针源码的关系：探针 `check('...')` 的调用顺序是**行为上的**事实源，
 * 本表是**声明上的**事实源；两者由 `tests/test_attribution.mjs` [9.8] 断言相等（不一致即红）。
 * 与三张 check 表的关系：本表 ∪ {@link CONDITIONAL_PROBE_CHECKS} == 三表并集（同由 [9.8] 断言）。
 *
 * @type {readonly string[]}
 */
export const PROBE_CHECK_ORDER = [
  'host.tools_ready',
  'detect.flavor_known',
  'contract.probe_disposed',
  'guard.reserved_name',
  'compat.schema_flatten',
  'plugin.loaded',
  'plugin.apply_ok',
  'registry.exact',
  'dispatch.execute_ok',
  'dispatch.render_projected',
  'dispatch.echo_payload',
  'dispatch.abort_semantics',
  'plugin.definitions_ok',
  'lifecycle.disposer_count',
  'lifecycle.registered',
  'lifecycle.dispose',
  'guard.reserved_rejected',
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
