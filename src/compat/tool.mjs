/**
 * 宿主无关的**工具契约**与注册适配器。
 *
 * ## 契约（插件作者只写这一份）
 * ```js
 * {
 *   name: 'demo_echo',                  // 不得命中宿主保留名
 *   description: '回显',
 *   parameters: { type:'object', properties:{ text:{type:'string'} } },  // 宽松 schema 可
 *   output: {
 *     schema: { type:'object', properties:{ text:{type:'string'} } },   // 宽松 schema 可
 *     render: (args, value) => [{ type:'text', text: value.text }],     // 可省略，自动兜底
 *   },
 *   execute: async (args, exec) => ({ text: 'ok' }),                    // exec.signal 由适配器统一守
 * }
 * ```
 *
 * ## 适配器承担的三件事（= 三条实测硬约束）
 * | 宿主硬约束（三线实测一致） | 适配器处置 |
 * |---|---|
 * | `run_code` 为保留工具名，`register()` 直接抛错 | 注册前 {@link assertNotReserved} 显式失败并指明是 prefix 冲突 |
 * | `output.schema` 受强制 JSON Schema 子集校验 | {@link normalizeSchema} 压平 + 注册前自检 |
 * | `execute(args, exec)` 必须尊重 `exec.signal` | 统一在入口 `throwIfAborted()`，已中止不触达工具体 |
 * | `output` 必须声明 `{ schema, render }`（三线一致） | 缺 `render` 自动兜底为文本投影 |
 *
 * @module dsh-adapt-hub/compat/tool
 */

import { assertSupportedSchema, collectSchemaViolations, normalizeSchema } from './schema.mjs';

/** DSH 保留工具名：任何插件都不得注册或遮蔽（新旧版措辞不同、语义一致）。 */
export const RESERVED_TOOL_NAMES = ['run_code'];

/**
 * 注册前保留名护栏——把冲突报成「你的 prefix 选得不对」，
 * 而不是让用户去看宿主内部错误。
 *
 * @param {string} name 待注册工具名
 * @returns {string} 原样返回 name
 */
export function assertNotReserved(name) {
  if (RESERVED_TOOL_NAMES.includes(name)) {
    throw new Error(
      `工具名 "${name}" 是 DSH 保留名（用于 ${name === 'run_code' ? 'PTC/Code Mode 呈现通道' : '宿主内置'}），` +
        `插件不得注册或遮蔽；请调整 prefix 或工具名。`,
    );
  }
  return name;
}

/**
 * 缺省文本投影（宿主三线均要求 `output.render` 存在）。
 *
 * @param {unknown} _args
 * @param {unknown} value canonical value
 * @returns {{type:string,text:string}[]}
 */
export function defaultRender(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return [{ type: 'text', text }];
}

/**
 * 把作者侧宽松定义规范化为宿主可注册定义。
 *
 * @param {object} definition 作者侧工具定义
 * @param {{ prefix?: string, label?: string }} [options] 适配选项
 * @returns {{ name: string, description: string, parameters: object, output: { schema: object, render: Function }, execute: Function, issues: string[] }}
 */
export function normalizeToolDefinition(definition, options = {}) {
  const issues = [];
  if (!definition || typeof definition !== 'object') throw new TypeError('工具定义必须是对象');
  const { name, description, parameters, output, execute } = definition;

  if (typeof name !== 'string' || name.length === 0) throw new TypeError('工具定义缺少 name');
  assertNotReserved(name);
  if (typeof execute !== 'function') throw new TypeError(`工具 "${name}" 缺少 execute 函数`);

  const normalizedParameters = normalizeSchema(parameters ?? { type: 'object', properties: {} });
  const rawOutputSchema = output?.schema ?? { type: 'object', properties: {} };
  const normalizedOutputSchema = normalizeSchema(rawOutputSchema);

  const violations = collectSchemaViolations(normalizedOutputSchema);
  if (violations.length > 0) issues.push(...violations.map((v) => `${name}: ${v}`));
  assertSupportedSchema(normalizedOutputSchema, `${name}.output.schema`);

  const render = typeof output?.render === 'function' ? output.render : defaultRender;

  return {
    name,
    description: description ?? '',
    parameters: normalizedParameters,
    output: { schema: normalizedOutputSchema, render },
    execute: wrapExecute(name, execute),
    issues,
  };
}

/**
 * 包装 `execute`，统一尊重 `exec.signal`（三线一致要求）。
 *
 * 注意：宿主在**分发前**已中止时会自己短路；本包装覆盖「工具体启动后到结果
 * 物化前」的取消窗口，与宿主语义对齐且不重复消费信号。
 *
 * @param {string} name 工具名（错误措辞用）
 * @param {Function} execute 作者侧实现
 * @returns {Function} 包装后的实现
 */
export function wrapExecute(name, execute) {
  return async function adaptedExecute(args, exec) {
    if (exec && typeof exec.signal?.throwIfAborted === 'function') exec.signal.throwIfAborted();
    else if (exec?.signal?.aborted) {
      const error = new Error(`工具 "${name}" 的调用在分发前已被取消`);
      error.name = 'AbortError';
      throw error;
    }
    return await execute(args, exec);
  };
}

/**
 * 把一组工具定义注册到宿主 `ctx.tools`。
 *
 * 与宿主版本无关：只使用三线共有的契约（`register(definition)` 返回 disposer、
 * `inject = ['tools']`、`tools.schemas()` 可枚举）。
 *
 * @param {{ tools: object, effect?: Function }} ctx 宿主上下文（最小面：仅需 `tools`）
 * @param {object[]} definitions 作者侧工具定义数组
 * @param {{ prefix?: string, profile?: import('../detect/flavor.mjs').HostProfile }} [options]
 * @returns {{ registered: string[], disposers: Function[], issues: string[], reservedRejected: string[] }}
 *   注意：`reservedRejected` 中的每一项**同时**会以 `reserved_name_conflict: ...`
 *   形式进入 `issues`——保留名冲突绝不静默丢弃（本仓纪律「不吞异常」）。
 */
export function registerTools(ctx, definitions, options = {}) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('宿主未提供 ctx.tools（ToolRuntime）；请在 inject 声明 ["tools"] 后调用');
  }
  const registered = [];
  const disposers = [];
  const issues = [];
  const reservedRejected = [];

  for (const definition of definitions) {
    try {
      assertNotReserved(definition?.name);
    } catch (error) {
      // 不吞异常：保留名冲突必须显式上报（进 issues + 触发 onIssues + 进 toJSON）
      const conflict = `${definition?.name}: ${error.message}`;
      reservedRejected.push(conflict);
      issues.push(`reserved_name_conflict: ${conflict}`);
      continue;
    }
    const normalized = normalizeToolDefinition(definition, options);
    issues.push(...normalized.issues);
    const disposer = tools.register({
      name: normalized.name,
      description: normalized.description,
      parameters: normalized.parameters,
      output: normalized.output,
      execute: normalized.execute,
    });
    if (typeof disposer === 'function') disposers.push(disposer);
    registered.push(normalized.name);
  }

  return { registered, disposers, issues, reservedRejected };
}
