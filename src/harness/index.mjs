/** 隔离宿主装配器导出面。 @module dsh-adapt-hub/harness */
export { HUB_ROOT, loadChannels, pinsToSpecs, channelFingerprint, runHostProbe, pruneHostCache } from './host.mjs';
export { collectContract, pushHostFatal, CONTRACT_PROBES, CONTRACT_PROBE_NAMES, HOST_FATAL_PREFIX, HOST_FATAL_FIELD } from './contract.mjs';
