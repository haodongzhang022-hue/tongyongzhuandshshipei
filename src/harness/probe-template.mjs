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
 * 该文件由 `src/harness/host.mjs` 复制进临时目录后执行；不要直接运行。
 */
import { pathToFileURL } from 'node:url';

const [hubRoot, pluginPath, expectedToolsJson] = process.argv.slice(2);
const expectedTools = JSON.parse(expectedToolsJson ?? '[]');

const out = { checks: [], errors: [], profile: null, contract: {}, ok: false };
const check = (name, ok, detail) => {
  out.checks.push({ name, status: ok ? 'pass' : 'fail', detail: detail === undefined ? '' : String(detail).slice(0, 600) });
  if (!ok) out.errors.push(`${name}: ${detail ?? ''}`);
};

try {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools');
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');

  const hub = await import(pathToFileURL(`${hubRoot}/src/index.mjs`).href);

  const ctx = new Context();
  ctx.plugin(SystemPrompt, {});
  ctx.plugin(ToolRuntime, {});
  await new Promise((resolve) => setTimeout(resolve, 200));

  const tools = ctx.get('tools');
  check(
    'host.tools_ready',
    Boolean(tools),
    tools ? `ctx.tools 已就绪（${tools.constructor?.name ?? 'ToolRuntime'}）` : 'ctx.tools 未就绪（宿主未装配 ToolRuntime）',
  );
  if (!tools) throw new Error('ctx.tools 未就绪');

  // ---- 1. 版本线探测 ----
  const profile = hub.detectHostFlavor(tools);
  out.profile = profile.toJSON();
  check('detect.flavor_known', profile.flavor !== 'unknown', profile.evidence);
  out.contract.configProjection = profile.signals.configProjection;

  // ---- 2. 契约指纹采集（上游漂移侦测基线） ----
  try {
    tools.register({
      name: 'run_code', description: 'probe', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] }, execute: async () => ({}),
    });
    out.contract.reservedName = 'ACCEPTED(unexpected)';
  } catch (error) { out.contract.reservedName = String(error?.message ?? error); }

  try {
    tools.register({
      name: 'probe_bad_schema', description: 'probe', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { a: { type: 'json' } } }, render: () => [] }, execute: async () => ({}),
    });
    out.contract.schemaSubset = 'ACCEPTED(unexpected)';
  } catch (error) { out.contract.schemaSubset = String(error?.message ?? error); }

  try {
    tools.register({
      name: 'probe_no_render', description: 'probe', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } }, execute: async () => ({}),
    });
    out.contract.outputShape = 'render-optional';
  } catch (error) { out.contract.outputShape = String(error?.message ?? error); }

  // ---- 3. 集成路径：调用插件自己的 apply（真实入口 + 中台适配器） ----
  const plugin = await import(pathToFileURL(pluginPath).href);
  const pluginCtx = { tools, effect: (fn, label) => ctx.effect(fn, label) };
  check('plugin.loaded', typeof plugin.apply === 'function', typeof plugin.apply === 'function' ? '插件导出 apply(ctx)' : '插件未导出 apply(ctx)');
  if (typeof plugin.apply !== 'function') throw new Error('插件未导出 apply(ctx)');
  await plugin.apply(pluginCtx);

  const actual = tools.schemas().map((s) => s.name).filter((n) => !n.startsWith('probe_')).sort();
  const want = [...expectedTools].sort();
  const registryExact = JSON.stringify(actual) === JSON.stringify(want);
  check('registry.exact', registryExact, registryExact ? `工具清单精确匹配（${actual.join(',')}）` : `期望 ${want.join(',')} / 实得 ${actual.join(',')}`);

  // ---- 4. 真实 dispatch：execute → output.schema 校验 → render 投影 ----
  const echoName = want.find((n) => n.endsWith('echo'));
  const dispatchName = echoName ?? want[0];
  const dispatched = await tools.execute({ callId: 'probe-echo', name: dispatchName, arguments: { text: 'hello' }, signal: new AbortController().signal });
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

  // ---- 5. 取消语义（宿主三线一致要求） ----
  const aborter = new AbortController();
  aborter.abort();
  const cancelled = await tools.execute({ callId: 'probe-abort', name: dispatchName, arguments: { text: 'x' }, signal: aborter.signal });
  check(
    'dispatch.abort_semantics',
    cancelled.isError === true,
    cancelled.isError === true
      ? '取消语义生效（已中止调用被拒绝）'
      : `取消语义失效：已中止的调用仍返回成功：${JSON.stringify(cancelled.content)?.slice(0, 160)}`,
  );

  // ---- 6. 保留名护栏（插件侧显式失败，而非炸在宿主里） ----
  const guardWorks = (() => { try { hub.assertNotReserved('run_code'); return false; } catch { return true; } })();
  check('guard.reserved_name', guardWorks, guardWorks ? '中台保留名护栏可用（run_code 被插件侧拒绝）' : '插件侧未拒绝 DSH 保留名 run_code');

  // ---- 7. schema 压平（作者侧宽松写法必须被压平而非原样透传） ----
  const flattened = hub.normalizeSchema({ type: 'object', properties: { a: { type: 'json' } } });
  const flattenOk = hub.collectSchemaViolations(flattened).length === 0;
  check('compat.schema_flatten', flattenOk, flattenOk ? `schema 压平后无违规：${JSON.stringify(flattened)}` : `schema 压平后仍有违规：${JSON.stringify(flattened)}`);

  // ---- 8. 生命周期：disposer 语义（独立 Context，宿主拒绝同层重名注册） ----
  const definitions = typeof plugin.definitions === "function" ? plugin.definitions({ profile: profile.toJSON() }) : plugin.definitions;
  if (Array.isArray(definitions) && definitions.length > 0) {
    const ctx2 = new Context();
    ctx2.plugin(SystemPrompt, {});
    ctx2.plugin(ToolRuntime, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tools2 = ctx2.get("tools");
    const lifecycle = hub.registerTools({ tools: tools2, effect: (fn, label) => ctx2.effect(fn, label) }, definitions, { profile });
    // 被拒绝的保留名不产生 disposer；按「可注册定义数」计数（避免把冲突误算成漏注册）
    const expectedDisposers = definitions.length - lifecycle.reservedRejected.length;
    check("lifecycle.disposer_count", lifecycle.disposers.length === expectedDisposers, lifecycle.disposers.length === expectedDisposers ? lifecycle.disposers.length + "/" + expectedDisposers + '（全部可注册定义均产出 disposer）' : lifecycle.disposers.length + "/" + expectedDisposers + '（数量不符）');
    const before = tools2.schemas().map((s) => s.name).sort();
    const lifecycleRegistered = JSON.stringify(before) === JSON.stringify([...expectedTools].sort());
    check("lifecycle.registered", lifecycleRegistered, lifecycleRegistered ? `独立上下文注册成功（${before.join(',')}）` : `独立上下文注册不符：${before.join(',')}`);
    lifecycle.disposers.forEach((dispose) => dispose());
    const after = tools2.schemas().map((s) => s.name);
    check("lifecycle.dispose", after.length === 0, after.length === 0 ? '卸载后无残留' : '卸载后仍残留：' + after.join(','));
  } else {
    check("lifecycle.disposer_count", false, "插件未导出 definitions 数组，无法验证生命周期");
  }

  // ---- 9. 保留名冲突：既不得静默丢弃，也不得被放行（插件须改名） ----
  const defsForGuard = typeof plugin.definitions === 'function'
    ? plugin.definitions({ profile: profile.toJSON() })
    : plugin.definitions;
  const reservedInDefs = Array.isArray(defsForGuard)
    ? defsForGuard.map((d) => d?.name).filter((n) => hub.RESERVED_TOOL_NAMES.includes(n))
    : [];
  if (reservedInDefs.length === 0) {
    check('guard.reserved_rejected', true, `插件未使用 DSH 保留名（${hub.RESERVED_TOOL_NAMES.join(',')}）`);
  } else {
    const ctx3 = new Context();
    ctx3.plugin(SystemPrompt, {});
    ctx3.plugin(ToolRuntime, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tools3 = ctx3.get('tools');
    const guardResult = hub.registerTools({ tools: tools3 }, defsForGuard, { profile });
    const reported = guardResult.reservedRejected.length === reservedInDefs.length
      && guardResult.issues.some((issue) => issue.includes('reserved_name_conflict'));
    // 插件声明保留名 = 违反宿主硬约束 → 验收必须判失败（且失败原因是插件侧，不是静默丢弃）
    check(
      'guard.reserved_rejected',
      false,
      `插件声明了 DSH 保留名 ${reservedInDefs.join(',')}，中台已拒绝并上报（reported=${reported}），但插件须改名后重跑`,
    );
  }

  out.ok = out.errors.length === 0;
} catch (error) {
  out.errors.push(`fatal: ${String(error?.stack ?? error).slice(0, 1200)}`);
  out.ok = false;
}

process.stdout.write(`__DSH_PROBE__${JSON.stringify(out)}\n`);
process.exit(out.ok ? 0 : 1);
