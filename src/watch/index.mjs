/** 上游变更侦测导出面。 @module dsh-adapt-hub/watch */
export { fetchDistTags, watchUpstream, contractSnapshot, diffContracts } from './upstream.mjs';
export { classifyDrift, diffReservedNames, triageUpstream, toTriageMarkdown, DRIFT_IMPACT, DRIFT_FIELDS } from '../triage/index.mjs';
