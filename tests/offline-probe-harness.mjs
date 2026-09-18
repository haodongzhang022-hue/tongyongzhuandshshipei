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
import { fileURLToPath } from 'node:url';
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
 * 跑一次**离线**探针。
 *
 * @param {object} options 选项
 * @param {string} options.pluginPath 被测插件路径（绝对）
 * @param {string[]} [options.expectedTools] 期望工具清单
 * @param {number} [options.watchdogMs] 看门狗窗口（**只许缩短**，用于「run() 被拖住」的回归）
 * @param {number} [options.timeoutMs] 子进程超时（默认 30s）
 * @param {string} [options.killSignal] 超时后的终止信号（**仅回归反证用**：传 `'SIGTERM'` 复现旧缺陷；
 *   不传 = 生产口径，取自 `probeSpawnOptions` 的 `CHILD_KILL_SIGNAL`）
 * @returns {{result: object, attribution: string, reasons: string[], exit: {status:number|null, signal:string|null}}}
 *   `result` 是装配器结构（`checks` / `hostFatal` / `runCompleted` / `phase` / `ok`）
 */
export function runOfflineProbe(options) {
  const { pluginPath, expectedTools = [], watchdogMs, timeoutMs = 30_000, killSignal } = options;
  const startedAt = Date.now();
  const work = mkdtempSync(path.join(tmpdir(), 'dsh-offline-probe-'));
  try {
    // 1. 造假宿主
    for (const [name, source] of Object.entries(FAKE_HOST)) {
      const dir = path.join(work, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-fake', type: 'module', main: 'index.mjs', exports: { '.': './index.mjs' } }));
      writeFileSync(path.join(dir, 'index.mjs'), source);
    }
    // 2. 拷探针（与装配器同一份拷贝方式：probe.mjs + contract.mjs）
    cpSync(path.join(ROOT, 'src', 'harness', 'probe-template.mjs'), path.join(work, 'probe.mjs'));
    cpSync(path.join(ROOT, 'src', 'harness', 'contract.mjs'), path.join(work, 'contract.mjs'));

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
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, [nonce.envName]: nonce.value, ...(watchdogMs ? { DSH_PROBE_RUN_WATCHDOG_MS: String(watchdogMs) } : {}) },
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
    interpretProbeStdout(result, stdout, { resultFd, nonce: nonce.value });
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
