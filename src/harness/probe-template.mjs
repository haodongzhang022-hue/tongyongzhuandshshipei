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
 * ## 两层兜底（🔴-D 同族活口：异步异常）
 * 只有**同步**异常才走 `run()` 的调用栈，能被顶层 `catch` 接住。插件在 `apply()` 里排的
 * 后台任务（`queueMicrotask` / `setTimeout` / 事件回调 / 预取 promise）抛错时，
 * 异常**不在** `run()` 的调用栈上 → 顶层 `catch` 永远接不到 → 探针在写出 `__DSH_PROBE__`
 * 之前就被 Node 杀掉 → 装配器看到「探针未输出结构化结果」→ 无条件 `pushHostFatal()`
 * → 插件 bug 被判 `UPSTREAM_DRIFT`/AMBER，且 `checks` 从 17 掉到 0（整份报告消失）。
 * 故补**进程级兜底**：`uncaughtException` / `unhandledRejection` → 按相位归因
 * （`plugin-integration` → 插件侧 check `plugin.async_uncaught_exception`，绝不写 `hostFatal[]`）
 * → **照常输出结构化结果**（已跑完的 check 全部保留）→ 再退出。
 *
 * 三条纪律（都是「崩溃路径」上的经验，别再踩）：
 * 1. 兜底处理器**自身不得抛**（抛出 = 第二次崩溃 = 报告整份消失）；
 * 2. 结构化结果用 `writeSync` 输出（兜底后紧接着 `process.exit()`，异步 stdout 会被截断）；
 * 3. 记录后**不立即退出**——插件后台任务的抛错时机不确定（第几个 `await` 之后），
 *    立即退出会让「已跑完的检查」随时机变化 → 同一插件两次跑出不同 `checks`（报告不确定）。
 *    改为让 `run()` 跑完再统一收尾（报告形态与正常失败一致），另设看门狗兜住「run() 被拖住」。
 * 历史缺陷（🔴-B）：插件侧错误曾被统一写成 `fatal: ...`，而 `runner` 用裸 `fatal:` 判上游漂移
 * → 插件写坏了却被告知「上游变了，不是你的问题」。
 * 历史缺陷（🔴-C）：改用 `fatal(host)` 前缀后判据仍在**扫自由文本**——插件文件路径/错误文本里
 * 恰好含该字面量即再次翻案。故判据改为只读 `hostFatal[]` 结构化字段，`errors` 退化为纯日志。
 *
 * 该文件由 `src/harness/host.mjs` 复制进临时目录后执行；不要直接运行。
 */
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_SIDE_CHECKS,
  PROBE_CHECK_ORDER,
  PROBE_PHASE,
  collectContract,
  pushHostFatal,
  recordProbeAsyncException,
  recordProbeException,
} from './contract.mjs';

const [hubRoot, pluginPath, expectedToolsJson] = process.argv.slice(2);
const expectedTools = JSON.parse(expectedToolsJson ?? '[]');

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
 * 结构化结果**只输出一次**（正常收尾 / 进程级兜底 两条路径共用）。
 *
 * 为什么用 `writeSync(1, ...)` 而不是 `process.stdout.write`：兜底路径随后立即
 * `process.exit()`，而 pipe 上的 `process.stdout.write` 是**异步**的——
 * 未 flush 就退出会让报告被截断（「探针未输出结构化结果」再次出现，等于没修）。
 *
 * @returns {void}
 */
let emitted = false;
function emit() {
  if (emitted) return;
  emitted = true;
  out.ok = out.errors.length === 0;
  const payload = `__DSH_PROBE__${JSON.stringify(out)}\n`;
  try {
    writeSync(1, payload);
  } catch {
    // 极端情形（stdout 已关闭 / 非 fd 环境）退化为异步写——聊胜于无，绝不在此抛。
    try { process.stdout.write(payload); } catch { /* 静默：崩溃路径上的兜底不得再崩 */ }
  }
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
  check('compat.schema_flatten', flattenOk, flattenOk ? `schema 压平后无违规：${JSON.stringify(flattened)}` : `schema 压平后仍有违规：${JSON.stringify(flattened)}`);

  // ---- 5. 集成路径：插件 import / apply（**插件侧**失败 → check，绝不 fatal） ----
  // 🔴-D：相位切到「插件集成」——此后逃到顶层 catch 的异常一律落**插件侧 check**，
  // 绝不写 hostFatal[]（否则插件 bug 会被判成上游漂移，并盖掉插件侧已失败的 check）。
  phase = PROBE_PHASE.PLUGIN_INTEGRATION;
  out.phase = phase;
  let plugin = null;
  try {
    plugin = await import(pathToFileURL(pluginPath).href);
  } catch (error) {
    check('plugin.loaded', false, `插件 import 失败（语法/依赖错误）：${brief(error)}`);
    skipAll(PLUGIN_SIDE_CHECKS, '插件 import 失败，无法执行验收');
    return;
  }
  const hasApply = typeof plugin.apply === 'function';
  check('plugin.loaded', hasApply, hasApply ? '插件导出 apply(ctx)' : `插件未导出 apply(ctx)（导出面：${Object.keys(plugin).join(',') || '空'}）`);
  if (!hasApply) {
    skipAll(PLUGIN_SIDE_CHECKS, '插件未导出 apply(ctx)，无法执行验收');
    return;
  }

  try {
    await plugin.apply({ tools, effect: (fn, label) => ctx.effect(fn, label) });
    check('plugin.apply_ok', true, '插件 apply(ctx) 执行成功（工具已注册）');
  } catch (error) {
    check('plugin.apply_ok', false, `插件 apply(ctx) 抛错（插件侧初始化失败）：${brief(error)}`);
    skipAll(PLUGIN_SIDE_CHECKS, '插件 apply(ctx) 未成功，后续检查无法验证');
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
  const registryExact = JSON.stringify(actual) === JSON.stringify(want);
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
  const dispatchDetail = JSON.stringify(dispatched.content)?.slice(0, 200);
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
      : `取消语义失效：已中止的调用仍返回成功：${JSON.stringify(cancelled.content)?.slice(0, 160)}`,
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
    const lifecycleRegistered = JSON.stringify(before) === JSON.stringify([...expectedTools].sort());
    check('lifecycle.registered', lifecycleRegistered, lifecycleRegistered ? `独立上下文注册成功（${before.join(',')}）` : `独立上下文注册不符：${before.join(',')}`);
    lifecycle.disposers.forEach((dispose) => dispose());
    const after = tools2.schemas().map((s) => s.name);
    check('lifecycle.dispose', after.length === 0, after.length === 0 ? '卸载后无残留' : '卸载后仍残留：' + after.join(','));
  } catch (error) {
    check('lifecycle.registered', false, `生命周期路径执行抛错（插件定义不可注册）：${brief(error)}`);
    skip('lifecycle.dispose', '生命周期路径未完成，跳过');
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

/**
 * 探针收尾：输出结构化结果并以退出码表达成败。
 *
 * @param {number} code 退出码（0 = 全绿；1 = 有失败）
 * @returns {void}
 */
function finish(code) {
  emit();
  process.exit(code);
}

// ---- 进程级兜底（🔴-D 同族活口：插件侧异步异常） ----
// 为什么必须有：只有**同步**异常才在 run() 的调用栈上、才被上面的 try/catch 接住。
// 插件在 apply() 里排的后台任务（queueMicrotask / setTimeout / 事件回调 / 预取 promise）
// 抛错时异常**不在**调用栈上 → 顶层 catch 接不到 → 探针在写出 __DSH_PROBE__ 之前被杀
// → 装配器看到「探针未输出结构化结果」→ 无条件 pushHostFatal() → 插件 bug 被判
// UPSTREAM_DRIFT/AMBER，且 checks 从 17 掉到 0（整份报告消失，比盖掉一条 check 更彻底）。
// 处置：按**同一份相位路由**归因（plugin-integration → 插件侧 check
// `plugin.async_uncaught_exception`，绝不写 hostFatal[]），照常输出结构化结果，再退出。
// 纪律：本处理器**自身不得抛**——它运行在崩溃路径上，抛出 = 第二次崩溃 = 报告整份消失。

/**
 * 收尾前的异步排空窗口（毫秒）——给「插件在 apply() 里排的后台任务」一次抛错的机会。
 *
 * 边界（显式声明）：只覆盖微任务与**已就绪**的宏任务；更晚的延迟抛错在探针退出后发生，
 * 不属本防线范围（探针是有限时长验收，不是运行时守护）。
 */
const ASYNC_DRAIN_MS = 50;

/**
 * 异步异常后的**看门狗**窗口（毫秒）：run() 若被插件异常拖住不返回，到此强制收尾。
 *
 * 为什么要它：记录异步异常后**不立即退出**（为了报告确定性），于是存在「run() 永不返回」
 * 的极端情形（插件后台任务把事件循环占死）。没有看门狗 = CI 干等直到外层超时（600s）。
 */
const ASYNC_WATCHDOG_MS = 10_000;

let asyncHandled = false;
function onProcessLevelException(kind, error) {
  if (asyncHandled) return; // 只记第一条：后续异常是崩溃后的连锁噪声，记下来只会淹没真因
  asyncHandled = true;
  try {
    const detail = `${kind}：${brief(error, 1200)}`;
    recordProbeAsyncException(out, phase, detail);
  } catch {
    // 兜底里的兜底：连归因都写不进去时，至少保证报告仍被输出（绝不在崩溃路径上抛）。
  }
  // 记录后**不立即退出**：插件后台任务的抛错时机不确定（微任务 / 宏任务 / 第几个 await 之后），
  // 立即退出会让「已跑完的检查」取决于时机 → 报告不确定（同一插件两次跑出不同 checks）。
  // 改为让 run() 跑完再统一收尾，报告形态与「正常失败」完全一致（17 项 + 1 条 fail）。
  // 代价：run() 若被插件异常拖住不返回，需要一个看门狗兜底（否则 CI 干等）。
  const watchdog = setTimeout(() => {
    try {
      skipPendingChecks(`探针因插件侧未捕获异步异常中断（${kind}），该项未验证`);
    } catch { /* 崩溃路径上不再抛 */ }
    finish(1);
  }, ASYNC_WATCHDOG_MS);
  // unref：run() 正常跑完时看门狗不该拖住进程（收尾走下面的 finish）。
  watchdog.unref?.();
}
process.on('uncaughtException', (error) => onProcessLevelException('uncaughtException', error));
process.on('unhandledRejection', (reason) => onProcessLevelException('unhandledRejection', reason));

try {
  await run();
} catch (error) {
  // 兜底（同步路径）：探针自身未预期的异常。**按相位归因**（🔴-D），不猜：
  // - host-assembly：宿主包 import / Context 装配 / 契约采集阶段 → 宿主/环境侧 → hostFatal[];
  // - plugin-integration：读插件侧数据（tools.schemas() / definitions.map()）时插件代码抛错
  //   → **插件侧 check**（plugin.unexpected_exception），绝不进 hostFatal[]。
  // 历史缺陷：旧注释假定「插件侧错误在 run() 内已落成 check」——该前提不成立（有插件侧异常
  // 直接从插件数据读取处逃逸），故必须显式分相位，不能一律 pushHostFatal()。
  // 归属逻辑收敛在 contract.mjs 的 recordProbeException()（与离线回归共用同一份）。
  recordProbeException(out, phase, brief(error, 1200));
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
if (asyncHandled) finish(1);

finish(out.errors.length === 0 ? 0 : 1);
