/**
 * DSH 工具 JSON Schema 子集：规范化 + 校验（宿主版本无关）。
 *
 * DSH 宿主对 `output.schema` 执行**强制子集校验**：不支持或位置错放的
 * keyword 会被**直接拒绝**（不是静默忽略）。已实测（stable 0.1.5-rc.2 /
 * dev 0.1.6-alpha.2 / legacy 0.1.1-rc.2 三条线行为一致）：
 *
 *   unsupported JSON schema: schema.properties.a.type must be one of
 *   object/array/string/number/integer/boolean/null
 *
 * 受支持子集（实测确认）：
 * - 单值 `type`：object / array / string / number / integer / boolean / null
 * - object：`properties` / `required`（**每项必须出现在 properties 中**）/ 布尔 `additionalProperties`
 * - array：`items`
 * - 标量：`enum` / `const`
 * - `oneOf`：至少两支，且与 `type` 互斥
 * - 注解：`description` / `title` / `default` / `examples`
 *
 * 本模块是「插件侧唯一事实源」：各插件只写自己业务 schema，由这里压平。
 *
 * @module dsh-adapt-hub/compat/schema
 */

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];
const KNOWN_TYPES = [...SCALAR_TYPES, 'object', 'array'];
const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

/** 判断是否为可下钻普通对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把宽松 schema 压平为受支持子集。
 *
 * 规则：
 * - 白名单 keyword，其余丢弃；
 * - `oneOf` 与 `type` 互斥（保留 `oneOf`，丢弃 `type`）；
 * - 有 `properties` 时，`required` 收敛为「同时在 properties 中」的名字；
 * - `additionalProperties` 显式为布尔；
 * - 数组 `items` 缺省为 `{}`（任意 JSON）。
 *
 * @param {unknown} raw 原始 schema（MCP / 作者侧宽松结构）
 * @returns {object} 受支持的 schema 节点；无法识别时返回 `{}`
 */
export function normalizeSchema(raw) {
  if (!isRecord(raw)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};

  for (const key of ANNOTATIONS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }

  if (Array.isArray(raw.oneOf) && raw.oneOf.length >= 2) {
    out.oneOf = raw.oneOf.map((node) => normalizeSchema(node));
    return out;
  }

  const type = typeof raw.type === 'string' && KNOWN_TYPES.includes(raw.type) ? raw.type : undefined;
  if (type) out.type = type;

  if (type === 'object' || isRecord(raw.properties)) {
    out.type = 'object';
    const props = isRecord(raw.properties) ? raw.properties : {};
    /** @type {Record<string, unknown>} */
    const normalized = {};
    for (const [name, node] of Object.entries(props)) normalized[name] = normalizeSchema(node);
    out.properties = normalized;
    const required = Array.isArray(raw.required) ? raw.required.filter((n) => typeof n === 'string' && n in normalized) : [];
    if (required.length > 0) out.required = required;
    out.additionalProperties = typeof raw.additionalProperties === 'boolean' ? raw.additionalProperties : false;
    return out;
  }

  if (type === 'array') {
    out.items = isRecord(raw.items) ? normalizeSchema(raw.items) : {};
    return out;
  }

  if (Array.isArray(raw.enum) && raw.enum.length > 0) out.enum = raw.enum;
  if (raw.const !== undefined) out.const = raw.const;
  return out;
}

/**
 * 校验 schema 是否落在宿主受支持子集内（与宿主同构，但只报违规、不抛）。
 *
 * @param {unknown} schema 待校验 schema
 * @param {string} [path] 诊断路径前缀
 * @returns {string[]} 违规清单（空数组 = 通过）
 */
export function collectSchemaViolations(schema, path = 'schema') {
  /** @type {string[]} */
  const violations = [];
  if (!isRecord(schema)) {
    violations.push(`${path} must be an object`);
    return violations;
  }

  const hasOneOf = Array.isArray(schema.oneOf);
  if (hasOneOf) {
    if (schema.oneOf.length < 2) violations.push(`${path}.oneOf must have at least two branches`);
    if (schema.type !== undefined) violations.push(`${path}.oneOf is mutually exclusive with ${path}.type`);
    schema.oneOf.forEach((node, i) => violations.push(...collectSchemaViolations(node, `${path}.oneOf[${i}]`)));
    return violations;
  }

  // 实测：宿主接受「无 type 的节点」（视为任意 JSON），但显式不支持的类型必须拒绝。
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !KNOWN_TYPES.includes(schema.type))) {
    violations.push(`${path}.type must be one of object/array/string/number/integer/boolean/null`);
  }

  if (schema.type === 'object') {
    if (!isRecord(schema.properties)) violations.push(`${path}.properties must be an object`);
    else {
      for (const [name, node] of Object.entries(schema.properties)) {
        violations.push(...collectSchemaViolations(node, `${path}.properties.${name}`));
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) violations.push(`${path}.required must be an array`);
        else {
          for (const name of schema.required) {
            if (!(name in schema.properties)) violations.push(`${path}.required entry "${name}" must appear in ${path}.properties`);
          }
        }
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be boolean`);
    }
  }

  if (schema.type === 'array' && schema.items !== undefined) {
    violations.push(...collectSchemaViolations(schema.items, `${path}.items`));
  }

  return violations;
}

/**
 * 断言 schema 合规；不合规即抛（注册前自检，避免「装上了但调用即炸」）。
 *
 * @param {unknown} schema 待校验 schema
 * @param {string} [label] 工具名 / 标签，用于错误措辞
 * @returns {object} 原样返回 schema
 */
export function assertSupportedSchema(schema, label = 'output.schema') {
  const violations = collectSchemaViolations(schema);
  if (violations.length > 0) {
    throw new Error(`unsupported JSON schema for ${label}: ${violations.join('; ')}`);
  }
  return schema;
}
