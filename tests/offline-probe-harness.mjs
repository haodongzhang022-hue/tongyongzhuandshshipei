/**
 * **离线**探针回归台（不联网、不装真宿主）：在临时目录里造一个**最小假宿主**，
 * 把 `src/harness/probe-template.mjs` 当真实探针跑起来（子进程），再用**装配器的真实实现**
 * （`interpretProbeStdout()`）解释它的输出。
 *
 * ## 为什么需要它（本文件的存在理由）
 * 探针的四条出口（同步 / 异步 / 进程 exit / `run()` 被拖住）此前**只**被真宿主 E2E 覆盖：
 * 慢、要网、CI 上才跑。而「进程 exit」与「run() 被拖住」这两条恰恰是**最容易写错**的地方
 * （历史缺陷：exit 出口既未闭合也未声明；看门狗只在记录过异步异常时才装、且被 `unref()` 掉）。
 * 把它们拉进离线回归后，判据一变/守卫一回退就立刻红，不必等 CI 装宿主。
 *
 * ## 假宿主的能力边界（显式声明，避免被当成「真宿主验收」）
 * - 它**只**模拟探针实际用到的那点宿主面：`Context` / `ctx.plugin` / `ctx.get('tools')` /
 *   `ctx.effect`，以及 `ctx.tools` 的 `register` / `schemas` / `execute`；
 * - 保留名 `run_code` 会抛错（措辞含 `PTC mode`，与真宿主同构，供版本线探测）；
 * - **不做**真实 schema 子集校验、不做真实 ToolRuntime 的并发/取消语义细节。
 * ⇒ 结论：**「假宿主通过」不等于「真宿主适配通过」**（那是 `verify` 的事，本文件不越权）。
 *   本文件只回答一个问题：**探针在四条出口上有没有把插件侧错误写成宿主侧信号**。
 *
 * @module dsh-adapt-hub/tests/offline-probe-harness
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { interpretProbeStdout, probeSpawnOptions } from '../src/harness/host.mjs';
import { PROBE_PHASE, createProbeNonce } from '../src/harness/contract.mjs';
import { attributeFailure, attributionDetail } from '../src/verify/runner.mjs';
import { loadChannels } from '../src/harness/host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 假宿主的三个包（探针 import 的符号面）。 */
const FAKE_HOST = {
  '@deepseek-ai/cordis': `
/** 最小 Context：只实现探针用到的 plugin / get / provide / effect。 */
export class Context {
  constructor() { this.services = new Map(); this.effects = []; }
  plugin(plugin, config) {
    const apply = typeof plugin === 'function' ? plugin : plugin?.apply;
    if (typeof apply === 'function') apply(this, config ?? {});
    return this;
  }
  provide(name, value) { this.services.set(name, value); }
  get(name) { return this.services.get(name); }
  effect(fn, label) { this.effects.push([fn, label]); }
}
export default { Context };
`,
  '@deepseek-ai/dsh-tools': `
/** 最小 ToolRuntime：register / schemas / execute 三条探针实际用到的面。 */
class FakeToolRuntime {
  constructor() { this.reg = new Map(); }
  static get Config() { return { toString: () => '{ mode?: "native" | "ptc" | "both", maxParallelSubCalls?: number }' }; }
  register(definition) {
    if (definition?.name === 'run_code') {
      // 与真宿主同构的拒绝措辞（探针的契约探测据此记指纹；版本线探测的兜底指纹也认它）
      throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed');
    }
    if (this.reg.has(definition.name)) throw new Error('tool "' + definition.name + '" is already registered');
    this.reg.set(definition.name, definition);
    return () => { this.reg.delete(definition.name); };
  }
  schemas() { return [...this.reg.values()].map((d) => ({ name: d.name })); }
  async execute({ name, arguments: args, signal }) {
    const definition = this.reg.get(name);
    if (!definition) return { isError: true, content: [{ type: 'text', text: 'unknown tool: ' + name }] };
    if (signal?.aborted) return { isError: true, content: [{ type: 'text', text: 'aborted' }] };
    const value = await definition.execute(args ?? {}, { signal });
    const render = typeof definition.output?.render === 'function' ? definition.output.render : null;
    return { isError: false, content: render ? render(args, value) : [{ type: 'text', text: JSON.stringify(value) }] };
  }
}
export default function ToolRuntime(ctx) { ctx.provide('tools', new FakeToolRuntime()); }
`,
  '@deepseek-ai/dsh-system-prompt': 'export default function SystemPrompt() { /* noop */ }\n',
};

/**
 * 造一个最小假宿主目录（三个包）并把探针 + 契约拷贝进去。
 *
 * 抽出来的理由：{@link runOfflineProbe} 与 {@link runOfflineProbeWithSources} 共用同一份
 * 「假宿主面 + 拷贝方式」，避免两处各自漂移（回归台与生产路径不同构 = 防线留在 CI 之外）。
 *
 * @param {string} work 工作目录
 * @param {string} [probeSource] 探针源码（缺省 = 仓库里的 `probe-template.mjs`）
 * @returns {void}
 */
function materializeWorkDir(work, probeSource) {
  for (const [name, source] of Object.entries(FAKE_HOST)) {
    const dir = path.join(work, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-fake', type: 'module', main: 'index.mjs', exports: { '.': './index.mjs' } }));
    writeFileSync(path.join(dir, 'index.mjs'), source);
  }
  if (typeof probeSource === 'string') writeFileSync(path.join(work, 'probe.mjs'), probeSource);
  else cpSync(path.join(ROOT, 'src', 'harness', 'probe-template.mjs'), path.join(work, 'probe.mjs'));
  cpSync(path.join(ROOT, 'src', 'harness', 'contract.mjs'), path.join(work, 'contract.mjs'));
}

/**
 * 跑一次离线探针，**允许替换探针 / 装配器的源码**（供「变异回退即红」的反证使用）。
 *
 * ## 为什么需要它（🔴 必修-4 的验收要件）
 * 评审对同族假绿的收口要求是「**回退即红**」——即：把修法改回去，闸门/回归必须**立刻**变红。
 * 只断言「修法在」是**源码守卫**（必要但不充分）：它证明不了「改回去真的会被抓到」。
 * 本函数把变异源码真的**跑起来**（探针源码写进临时目录；装配器源码拷进独立目录后
 * `import()` 同一份实现），于是「变异 ⇒ 行为变化」是可执行断言，而不是注释里的声称。
 *
 * 装配器侧为什么能替换：`host.mjs` 只 import `./contract.mjs` 与 node 内建 ⇒ 把两者拷进
 * 同一临时目录即可动态 import 变异版本（**不**改仓库文件、**不**污染其它用例）。
 *
 * @param {object} options 选项（同 {@link runOfflineProbe}，另加下面两项）
 * @param {string} [options.probeSource] 探针源码（变异版本；缺省 = 仓库实现）
 * @param {string} [options.hostSource] 装配器源码（变异版本；缺省 = 仓库实现）
 * @returns {Promise<{result: object, attribution: string, reasons: string[], exit: object}>} 同 {@link runOfflineProbe}
 */
export async function runOfflineProbeWithSources(options) {
  const { pluginPath, expectedTools = [], watchdogMs, timeoutMs = 30_000, probeSource, hostSource } = options;
  const startedAt = Date.now();
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-offline-probe-'));
  const hostDir = mkdtempSync(path.join(tmpdir(), 'dsh-offline-host-'));
  try {
    materializeWorkDir(work, probeSource);
    // 装配器：默认用仓库实现；给了 hostSource 就拷一份变异版（连带 contract.mjs）后动态 import。
    let host = { interpretProbeStdout, probeSpawnOptions };
    if (typeof hostSource === 'string') {
      writeFileSync(path.join(hostDir, 'host.mjs'), hostSource);
      cpSync(path.join(ROOT, 'src', 'harness', 'contract.mjs'), path.join(hostDir, 'contract.mjs'));
      host = await import(pathToFileURL(path.join(hostDir, 'host.mjs')).href);
    }
    const nonce = createProbeNonce(randomBytes);
    const probeOptions = host.probeSpawnOptions({ hubRoot: ROOT, pluginPath, expectedTools, timeoutMs, nonce });
    const probeRun = spawnSync('node', probeOptions.args, {
      ...probeOptions,
      cwd: work,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(watchdogMs ? { DSH_PROBE_RUN_WATCHDOG_MS: String(watchdogMs) } : {}) },
    });
    const result = {
      channel: 'stable', ok: false, profile: null, checks: [], errors: [], hostFatal: [],
      contract: {}, probes: [], runCompleted: false, probeExit: null, phase: PROBE_PHASE.HOST_ASSEMBLY,
      install: 'fake-host', cacheHit: false, durationMs: 0,
    };
    result.probeExit = { status: probeRun.status ?? null, signal: probeRun.signal ?? null };
    result.durationMs = Date.now() - startedAt;
    host.interpretProbeStdout(result, `${probeRun.stdout ?? ''}`, { resultFd: `${probeRun.output?.[3] ?? ''}`, nonce: nonce.value });
    const channel = loadChannels(ROOT).channels.stable;
    const detail = attributionDetail(result, channel, 'stable');
    return { result, attribution: detail.attribution, reasons: detail.reasons, exit: result.probeExit, stdout: `${probeRun.stdout ?? ''}`, resultFd: `${probeRun.output?.[3] ?? ''}`, stderr: `${probeRun.stderr ?? ''}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  }
}

/**
 * 跑一次**离线**探针。
 *
 * @param {object} options 选项
 * @param {string} options.pluginPath 被测插件路径（绝对）
 * @param {string[]} [options.expectedTools] 期望工具清单
 * @param {number} [options.watchdogMs] 看门狗窗口（**只许缩短**，用于「run() 被拖住」的回归）
 * @param {number} [options.timeoutMs] 子进程超时（默认 30s）
 * @param {string} [options.killSignal] 超时后的终止信号（**仅回归反证用**：传 `'SIGTERM'` 复现旧缺陷；
 *   不传 = 生产口径，取自 `probeSpawnOptions` 的 `CHILD_KILL_SIGNAL`）
 * @param {boolean} [options.noResultChannel] **不给探针 fd3**（`stdio[3]='ignore'`）——
 *   复现「结果通道不可用 ⇒ 降级到 stdout」（批 1.5 / 🔴-R2 的回归入口）
 * @param {boolean} [options.stdinUnreadable] **仅回归反证用**：把探针的 fd 0 设为 `'ignore'`
 *   （stdin 不可读），复现「无 nonce 路径」——旧缺陷（🔴-A）下探针会因 `PROBE_RESULT_MARKER`
 *   未 import 而 `ReferenceError` 硬崩、无结构化结果、被归因成 `UPSTREAM_DRIFT`（甩锅上游）。
 *   生产路径**不得**传它。
 * @returns {{result: object, attribution: string, reasons: string[], exit: {status:number|null, signal:string|null}}}
 *   `result` 是装配器结构（`checks` / `hostFatal` / `runCompleted` / `phase` / `ok` / `resultChannel`）
 */
export function runOfflineProbe(options) {
  const { pluginPath, expectedTools = [], watchdogMs, timeoutMs = 30_000, killSignal, noResultChannel = false, stdinUnreadable = false } = options;
  const startedAt = Date.now();
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-offline-probe-'));
  try {
    // 1+2. 造假宿主 + 拷探针（与装配器同一份拷贝方式：probe.mjs + contract.mjs）
    materializeWorkDir(work);

    // 3. 跑探针（子进程；非零退出是预期路径之一，stdout / 结果通道仍要拿回来）
    //
    // ⚠️ 这里**镜像生产路径**（`host.mjs` 的 `probeSpawnOptions()`）：`spawnSync` + nonce 带外通道
    // + 结果走 fd3（R26 两条防线）。若这里退回 `execFileSync` 只读 stdout、或自己拼 spawn 参数，
    // 本回归台就测不到「通道隔离 / nonce 协议拼装」这两层——回归台与生产路径不同构，
    // 等于把防线留在 CI 之外。
    const nonce = createProbeNonce(randomBytes);
    let stdout = '';
    let resultFd = '';
    let exit = { status: 0, signal: null };
    // killSignal 仅用于**反向反证**（[17]）：传 'SIGTERM' 复现「超时被探针处理器吞掉 ⇒ 无界」；
    // 不传即生产口径（probeSpawnOptions 的默认值 = CHILD_KILL_SIGNAL，唯一事实源）。
    const probeOptions = probeSpawnOptions({ hubRoot: ROOT, pluginPath, expectedTools, timeoutMs, nonce, ...(killSignal ? { killSignal } : {}) });
    const probeRun = spawnSync('node', probeOptions.args, {
      ...probeOptions,
      cwd: work,
      // 唯一与生产不同的一处：stderr 也接回（生产是 `inherit`，让 CI 日志看得见探针的原始报错）。
      // 回归台若 inherit，负例夹具的 stack 会直接打进测试输出、淹没断言结果。
      // 两个形态都是**回归专用**：`noResultChannel` 不给 fd3（复现通道降级）；
      // `stdinUnreadable` 把 fd 0 设 'ignore'（复现「stdin 不可读 ⇒ 无 nonce」路径）。
      stdio: [stdinUnreadable ? 'ignore' : 'pipe', 'pipe', 'pipe', noResultChannel ? 'ignore' : 'pipe'],
      // nonce 走 **stdin**（与生产路径同构：`probeSpawnOptions` 已给 `input`），
      // 这里只叠加看门狗窗口的环境变量（探针**只许缩短**，见其注释）。
      env: { ...process.env, ...(watchdogMs ? { DSH_PROBE_RUN_WATCHDOG_MS: String(watchdogMs) } : {}) },
      // stdinUnreadable：fd 0 为 'ignore'，不传 input（探针 readFileSync(0) 会抛 ⇒ nonceValue=null）
      ...(stdinUnreadable ? { input: undefined } : {}),
    });
    stdout = `${probeRun.stdout ?? ''}`;
    resultFd = `${probeRun.output?.[3] ?? ''}`;
    exit = { status: probeRun.status ?? null, signal: probeRun.signal ?? null };

    // 4. 用**装配器的真实实现**解释输出（与生产路径同一份，不是测试自造的解析）
    const result = {
      channel: 'stable', ok: false, profile: null, checks: [], errors: [], hostFatal: [],
      contract: {}, probes: [], runCompleted: false, probeExit: null, phase: PROBE_PHASE.HOST_ASSEMBLY,
      install: 'fake-host', cacheHit: false, durationMs: 0,
    };
    result.probeExit = exit;
    result.durationMs = Date.now() - startedAt;
    // stdinUnreadable：宿主侧同样按「无 nonce」解释（生产路径不会出现该形态，仅回归反证）
    interpretProbeStdout(result, stdout, { resultFd, nonce: stdinUnreadable ? null : nonce.value });
    const channel = loadChannels(ROOT).channels.stable;
    const detail = attributionDetail(result, channel, 'stable');
    return { result, attribution: detail.attribution, reasons: detail.reasons, exit, stdout, resultFd, stderr: `${probeRun.stderr ?? ''}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 便捷：只要归因字符串（等价于生产判据路径）。 */
export function attributeOfflineProbe(options) {
  const { result, attribution } = runOfflineProbe(options);
  return { result, attribution, attribute: () => attributeFailure(result, loadChannels(ROOT).channels.stable, 'stable') };
}
