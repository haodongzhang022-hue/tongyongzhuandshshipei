/** 上游变更侦测导出面。 @module dsh-adapt-hub/watch */
export { fetchDistTags, watchUpstream, contractSnapshot, diffContracts } from './upstream.mjs';
export {
  periodKey,
  periodKeyForDay,
  segmentStore,
  settleSegment,
  composeChain,
  resolveBaseline,
  segmentOrderAt,
  legacySnapshot,
  migrateLegacyLatest,
  SEGMENT_DIR,
  SEGMENT_MODES,
  DEFAULT_SETTLE_HOUR,
} from './baseline.mjs';
export { classifyDrift, diffReservedNames, triageUpstream, toTriageMarkdown, DRIFT_IMPACT, DRIFT_FIELDS } from '../triage/index.mjs';
