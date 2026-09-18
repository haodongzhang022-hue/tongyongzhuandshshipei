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
  check('host.tools_ready', Boolean(tools), 'ctx.tools 未就绪（宿主未装配 ToolRuntime）');
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
  check('plugin.loaded', typeof plugin.apply === 'function', '插件未导出 apply(ctx)');
  if (typeof plugin.apply !== 'function') throw new Error('插件未导出 apply(ctx)');
  await plugin.apply(pluginCtx);

  const actual = tools.schemas().map((s) => s.name).filter((n) => !n.startsWith('probe_')).sort();
  const want = [...expectedTools].sort();
  check('registry.exact', JSON.stringify(actual) === JSON.stringify(want), `期望 ${want.join(',')} / 实得 ${actual.join(',')}`);

  // ---- 4. 真实 dispatch：execute → output.schema 校验 → render 投影 ----
  const echoName = want.find((n) => n.endsWith('echo')) ?? want[0];
  const echo = await tools.execute({ callId: 'probe-echo', name: echoName, arguments: { text: 'hello' }, signal: new AbortController().signal });
  check('dispatch.execute_ok', echo.isError !== true, JSON.stringify(echo.content)?.slice(0, 200));
  check('dispatch.render_projected', Array.isArray(echo.content) && echo.content.length > 0 && typeof echo.content[0]?.text === 'string', JSON.stringify(echo.content)?.slice(0, 200));
  check('dispatch.echo_payload', Array.isArray(echo.content) && String(echo.content[0]?.text ?? '').includes('echo: hello'), JSON.stringify(echo.content)?.slice(0, 200));

  // ---- 5. 取消语义（宿主三线一致要求） ----
  const aborter = new AbortController();
  aborter.abort();
  const cancelled = await tools.execute({ callId: 'probe-abort', name: echoName, arguments: { text: 'x' }, signal: aborter.signal });
  check('dispatch.abort_semantics', cancelled.isError === true, `已中止的调用仍返回成功：${JSON.stringify(cancelled.content)?.slice(0, 160)}`);

  // ---- 6. 保留名护栏（插件侧显式失败，而非炸在宿主里） ----
  check('guard.reserved_name', (() => { try { hub.assertNotReserved('run_code'); return false; } catch { return true; } })(), '插件侧未拒绝 DSH 保留名 run_code');

  // ---- 7. schema 压平（作者侧宽松写法必须被压平而非原样透传） ----
  const flattened = hub.normalizeSchema({ type: 'object', properties: { a: { type: 'json' } } });
  check('compat.schema_flatten', hub.collectSchemaViolations(flattened).length === 0, JSON.stringify(flattened));

  // ---- 8. 生命周期：disposer 语义（独立 Context，宿主拒绝同层重名注册） ----
  const definitions = typeof plugin.definitions === "function" ? plugin.definitions({ profile: profile.toJSON() }) : plugin.definitions;
  if (Array.isArray(definitions) && definitions.length > 0) {
    const ctx2 = new Context();
    ctx2.plugin(SystemPrompt, {});
    ctx2.plugin(ToolRuntime, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tools2 = ctx2.get("tools");
    const lifecycle = hub.registerTools({ tools: tools2, effect: (fn, label) => ctx2.effect(fn, label) }, definitions, { profile });
    check("lifecycle.disposer_count", lifecycle.disposers.length === definitions.length, lifecycle.disposers.length + "/" + definitions.length);
    const before = tools2.schemas().map((s) => s.name).sort();
    check("lifecycle.registered", JSON.stringify(before) === JSON.stringify([...expectedTools].sort()), before.join(","));
    lifecycle.disposers.forEach((dispose) => dispose());
    const after = tools2.schemas().map((s) => s.name);
    check("lifecycle.dispose", after.length === 0, "卸载后仍残留：" + after.join(","));
  } else {
    check("lifecycle.disposer_count", false, "插件未导出 definitions 数组，无法验证生命周期");
  }

  out.ok = out.errors.length === 0;
} catch (error) {
  out.errors.push(`fatal: ${String(error?.stack ?? error).slice(0, 1200)}`);
  out.ok = false;
}

process.stdout.write(`__DSH_PROBE__${JSON.stringify(out)}\n`);
process.exit(out.ok ? 0 : 1);
