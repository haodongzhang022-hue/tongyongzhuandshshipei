/** 隔离宿主装配器导出面。 @module dsh-adapt-hub/harness */
export { HUB_ROOT, loadChannels, pinsToSpecs, channelFingerprint, runHostProbe, pruneHostCache, interpretProbeStdout, reportedChannelOf } from './host.mjs';
export { collectContract, pushHostFatal, CONTRACT_PROBES, CONTRACT_PROBE_NAMES, HOST_FATAL_PREFIX, HOST_FATAL_FIELD, probeReportTag, probeResultLine, PROBE_RESULT_MARKER } from './contract.mjs';
