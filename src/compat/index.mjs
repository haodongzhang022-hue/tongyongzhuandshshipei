/** 契约兼容层导出面。 @module dsh-adapt-hub/compat */
export { normalizeSchema, collectSchemaViolations, assertSupportedSchema } from './schema.mjs';
export {
  RESERVED_TOOL_NAMES,
  assertNotReserved,
  defaultRender,
  normalizeToolDefinition,
  wrapExecute,
  registerTools,
} from './tool.mjs';
