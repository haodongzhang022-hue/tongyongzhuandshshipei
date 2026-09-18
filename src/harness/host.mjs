/**
 * 隔离宿主装配器：在**独立临时目录**安装指定通道的**真实 DSH 宿主**，
 * 用真 `ToolRuntime` 装配被测插件，跑验收探针。
 *
 * 关键设计：
 * - **真宿主、真运行时**：不接受「假 ctx 冒烟」当作适配通过（做了≠通过）；
 * - **通道隔离**：stable / dev / legacy 各自一个临时目录，互不污染；
 * - **可离线**：命中缓存目录时跳过 npm 安装（CI 无网场景 / 重复验收）；
 * - **不吞异常**：安装失败 / 探针失败均以非零退出码与结构化原因上报。
 *
 * @module dsh-adapt-hub/harness/host
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { PLUGIN_ABNORMAL_TERMINATION_CHECK, PLUGIN_PROBE_FORGED_RESULT_CHECK, PROBE_NONCE_ENV_ARG_PREFIX, PROBE_PHASE, PROBE_PHASE_BEACON_PREFIX, createProbeNonce, probeResultPrefix, pushHostFatal } from './contract.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件位于 <root>/src/harness/）。 */
export const HUB_ROOT = path.resolve(HERE, '..', '..');

/**
 * 读取通道钉版表。
 *
 * @param {string} [hubRoot] 仓库根
 * @returns {{schemaVersion:number, channels:Record<string, any>, trackedPackages:string[]}}
 */
export function loadChannels(hubRoot = HUB_ROOT) {
  return JSON.parse(readFileSync(path.join(hubRoot, 'registry', 'channels.json'), 'utf8'));
}

/**
 * 把钉版表展开为 npm 安装参数。
 *
 * @param {{pins: Record<string,string>}} channel 通道定义
 * @returns {string[]} `pkg@version` 列表
 */
export function pinsToSpecs(channel) {
  return Object.entries(channel.pins).map(([name, version]) => `${name}@${version}`);
}

/**
 * 计算通道安装指纹（用于缓存复用）。
 *
 * @param {object} channel 通道定义
 * @returns {string}
 */
export function channelFingerprint(channel) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(channel.pins));
  return hash.digest('hex').slice(0, 12);
}

/**
 * 清理宿主依赖缓存。
 *
 * 策略：默认**只保留当前钉版指纹**对应的缓存目录（其余为历史版本残留，白占磁盘）；
 * `keepAll` 为 true 时仅清理临时工作目录（不动缓存）。
 *
 * 真实调用点：CLI `dsh-adapt cache`（默认保留当前三通道钉版指纹）与
 * `dsh-adapt verify --prune-cache`（验收后顺手清理历史残留）。
 *
 * @param {{cacheDir?:string, keepFingerprints?:string[], keepAll?:boolean}} [options] 选项
 * @returns {{removed:string[], kept:string[]}} 清理结果
 */
export function pruneHostCache(options = {}) {
  const cacheDir = options.cacheDir ?? path.join(tmpdir(), 'dsh-adapt-host-cache');
  const keep = new Set(options.keepFingerprints ?? []);
  const removed = [];
  const kept = [];
  if (!existsSync(cacheDir)) return { removed, kept };
  for (const entry of readdirSync(cacheDir)) {
    if (options.keepAll || keep.size === 0 || keep.has(entry)) { kept.push(entry); continue; }
    rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return { removed, kept };
}

/**
 * 在临时目录装配真实宿主并跑探针。
 *
 * @param {object} options 选项
 * @param {string} options.channelName 通道名（stable / dev / legacy）
 * @param {object} options.channel 通道定义（来自 channels.json）
 * @param {string} options.pluginPath 被测插件文件绝对路径
 * @param {string[]} options.expectedTools 期望注册的工具名清单
 * @param {string} [options.hubRoot] 仓库根
 * @param {string} [options.cacheDir] 宿主依赖缓存根（默认 $TMPDIR/dsh-adapt-host-cache）
 * @param {boolean} [options.offline] 仅用缓存，缺失即失败
 * @param {number} [options.timeoutMs] 安装 / 探针超时
 * @returns {{channel:string, ok:boolean, profile:object|null, checks:object[], errors:string[], hostFatal:string[], contract:object, probes:object[], phase:string|null, probeExit:object|null, install:string, cacheHit:boolean, durationMs:number}}
 *
 * 缓存策略：命中时以**软链**挂载缓存 `node_modules`（不再全量复制）；
 * 历史残留用 {@link pruneHostCache} 清理（保留当前钉版指纹）。
 */
export function runHostProbe(options) {
  const {
    channelName,
    channel,
    pluginPath,
    expectedTools = [],
    hubRoot = HUB_ROOT,
    cacheDir = path.join(tmpdir(), 'dsh-adapt-host-cache'),
    offline = false,
    timeoutMs = 600_000,
  } = options;

  const started = Date.now();
  const fingerprint = channelFingerprint(channel);
  const cachePath = path.join(cacheDir, `${channelName}-${fingerprint}`);
  const workDir = path.join(tmpdir(), `dsh-adapt-${channelName}-${fingerprint}-${process.pid}`);
  const result = {
    channel: channelName,
    ok: false,
    profile: null,
    checks: [],
    // errors：人类可读日志；hostFatal：**结构化**宿主/环境侧致命信号（归因判据只读它，见 🔴-C）
    errors: [],
    hostFatal: [],
    contract: {},
    probes: [],
    // 探针是否**跑完**（探针结构化结果的 `runCompleted`；未输出结果时为 false）。
    // 用途：区分「跑完但失败」与「中途被打断」——后者即便某次输出里恰好没有 fail check，
    // 也绝不能当成通过（假绿比 AMBER 更危险，见 🔴 必修-1）。
    runCompleted: false,
    probeExit: null,
    // 探针执行相位（异常归属依据；见 contract.mjs 的 PROBE_PHASE）。
    // 装配器自身的失败（离线缺缓存 / npm 失败 / 装配异常）**都是宿主装配相位**——
    // 探针跑通后由探针回报的相位覆盖（那时才可能进入插件集成相位）。
    phase: PROBE_PHASE.HOST_ASSEMBLY,
    install: 'skipped',
    cacheHit: false,
    durationMs: 0,
  };

  try {
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: `dsh-adapt-${channelName}`, private: true, type: 'module' }, null, 2));

    const cacheReady = existsSync(path.join(cachePath, 'node_modules'));
    result.cacheHit = cacheReady;
    if (cacheReady) {
      result.install = `cache:${cachePath}`;
    } else if (offline) {
      result.install = 'offline-miss';
      pushHostFatal(result, '离线模式下缺少宿主依赖缓存（先联网跑一次或去掉 --offline）');
      return result;
    } else {
      try {
        execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...pinsToSpecs(channel)], {
          cwd: workDir,
          stdio: ['ignore', 'ignore', 'inherit'],
          timeout: timeoutMs,
          // 同 🔴-1：npm 也可能挂住（网络半死 / 子进程不响应 SIGTERM）⇒ 超时后 SIGKILL 兜底，
          // 让 `timeoutMs` 对**安装段**同样是有界承诺（不是只对探针段）。
          killSignal: 'SIGKILL',
        });
      } catch (error) {
        // 安装失败 = 宿主/环境侧（网络不可达 或 上游钉版消失）→ 显式措辞，供归因按**结构**判定
        result.install = 'npm-failed';
        pushHostFatal(result, `宿主依赖安装失败（npm）：${String(error?.message ?? error).slice(0, 300)}`);
        return result;
      }
      cpSync(path.join(workDir, 'node_modules'), path.join(cachePath, 'node_modules'), { recursive: true });
      result.install = 'npm-install';
    }

    if (!existsSync(path.join(workDir, 'node_modules'))) {
      // 缓存命中：软链而非全量复制（三通道三次全量 cpSync 是纯浪费；软链对 Node 解析透明）
      const cacheModules = path.join(cachePath, 'node_modules');
      const linkPath = path.join(workDir, 'node_modules');
      try {
        symlinkSync(cacheModules, linkPath, 'dir');
        result.install = result.install.startsWith('cache:') ? `${result.install} (symlink)` : result.install;
      } catch {
        cpSync(cacheModules, linkPath, { recursive: true });
      }
    }

    // 探针与其依赖一起拷入临时目录（probe-template.mjs 会 import './contract.mjs'）
    cpSync(path.join(hubRoot, 'src', 'harness', 'probe-template.mjs'), path.join(workDir, 'probe.mjs'));
    cpSync(path.join(hubRoot, 'src', 'harness', 'contract.mjs'), path.join(workDir, 'contract.mjs'));

    // 🆕 nonce 带外通道（侧信道收口，见 docs/RISKS.md R26）：
    // 宿主生成**随机** nonce 与**随机环境变量名**，名字经 argv 传、值经 env 传；
    // 探针输出的报告前缀带该 nonce，宿主只认带 nonce 的行 ⇒ 插件伪造裸 marker 会被判伪造。
    // 为什么名字也要随机：固定名等于没设防（插件照抄名字即可读出 nonce）。
    const nonce = createProbeNonce(randomBytes);
    result.probeNonceEnvName = nonce.envName; // 排障用（值本身**不**落盘，避免泄漏进报告）

    let stdout = '';
    try {
      stdout = execFileSync('node', ['probe.mjs', hubRoot, pluginPath, JSON.stringify(expectedTools), `${PROBE_NONCE_ENV_ARG_PREFIX}${nonce.envName}`], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, [nonce.envName]: nonce.value },
        // 🔴-1（本 PR 新引入的 CI 级回归）：`execFileSync` 的 `timeout` 默认只发一次 **SIGTERM**，
        // 而探针为出口③（进程 exit / 自杀式信号）装了 `SIGTERM` / `SIGINT` 处理器——
        // ① 监听器存在即**替换** Node 的默认终止行为（默认行为不再发生）；
        // ② 插件同步占死事件循环时，信号处理器**根本不可达**（事件循环不空出，回调排不上）。
        // 两条叠加 ⇒ 探针杀不死 ⇒ `execFileSync` 无限等待 ⇒ CI 挂到流水线上限
        // （实测：`while(true)` 插件 + `timeoutMs=5000` → 45s+ 仍未返回）。
        // 修法：`killSignal: 'SIGKILL'`——SIGKILL **不可捕获**，探针的信号处理器拦不住它，
        // 于是 `timeoutMs` 重新变成**有界**承诺（实测 5.07s 有界返回）。
        // 回归：`tests/test_offline.sh` [17]「占死事件循环 → 有界返回」（短 timeout，不进闸门吃额度）。
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      stdout = `${error.stdout ?? ''}`;
      // 注意：措辞里**不得**回显命令行与路径（历史缺陷：路径含 npm 时被归因判据误命中，
      // 把插件 bug 报成上游漂移）。归因只看探针的结构化错误，这里只记退出实况。
      result.probeExit = { status: error.status ?? null, signal: error.signal ?? null };
      result.errors.push(`探针非零退出（status=${error.status ?? 'null'}${error.signal ? `, signal=${error.signal}` : ''}）`);
    }

    interpretProbeStdout(result, stdout, { nonce: nonce.value });
    return result;
  } catch (error) {
    // 装配阶段兜底：一律宿主/环境侧（探针脚本未产出结构化结果前的失败不可能是插件造成）
    pushHostFatal(result, `宿主装配失败：${String(error?.message ?? error).slice(0, 500)}`);
    return result;
  } finally {
    result.durationMs = Date.now() - started;
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 把探针的 stdout **解释**进 `result`（纯函数，装配器与离线回归共用同一份）。
 *
 * 抽出来的理由：这段逻辑是本中台最容易「静默判错」的地方（判据字段 `hostFatal[]` 的写入端），
 * 而它原先只被真宿主 E2E 覆盖（慢、要网）。抽成纯函数后，离线回归可以用**真实探针输出**
 * （含 SIGKILL 这类不可捕获终止的产物）直接断言归因，不必等 CI 装宿主。
 *
 * 三种情形：
 * 1. 有结构化结果 → 原样透传 `checks` / `hostFatal` / `phase` / `runCompleted`；
 *    `ok` 必须**同时**要求「跑完」（完成位）与「无失败」（🔴 必修-1）。
 * 2. 无结构化结果 + **有相位信标** → 不可捕获终止（SIGKILL / OOM）发生在**插件集成**相位
 *    → 落插件侧 check `plugin.abnormal_termination`，`hostFatal[]` 保持为空（不甩锅上游）。
 * 3. 无结构化结果 + 无信标 → 终止在宿主装配段 → `hostFatal[]`（真上游信号，不丢）。
 *
 * ## 🆕 nonce 带外通道（侧信道 / 信任边界收口）
 * 传入 `options.nonce` 时，**只有**带该 nonce 前缀的行才算探针报告；
 * 出现裸 `__DSH_PROBE__`（无 nonce / nonce 不匹配）行 ⇒ 判定**伪造**：
 * 落插件侧 check {@link PLUGIN_PROBE_FORGED_RESULT_CHECK}，且**不得**把它当作报告
 * （否则插件 `process.stdout.write('__DSH_PROBE__{绿卡}')` 就能自我发绿卡）。
 * 不传 `nonce`（离线单测 / 手工调用）时退化为「认裸 marker」的历史行为。
 *
 * @param {object} result 装配器结果对象（就地写入）
 * @param {string} stdout 探针 stdout
 * @param {{nonce?: string|null}} [options] 选项：本次运行的 nonce（宿主生成、随机）
 * @returns {object} 同一个 result（便于链式使用）
 */
export function interpretProbeStdout(result, stdout, options = {}) {
  const text = String(stdout ?? '');
  const nonce = options.nonce ?? null;
  const lines = text.split('\n');
  // 带 nonce 时：报告行 = 带 nonce 前缀的那一行；其余以裸 marker 开头的行 = 伪造。
  const expectedPrefix = nonce ? probeResultPrefix(nonce) : '__DSH_PROBE__';
  const marker = lines.find((line) => line.startsWith(expectedPrefix));
  const forged = nonce
    ? lines.filter((line) => line.startsWith('__DSH_PROBE__') && !line.startsWith(expectedPrefix))
    : [];
  // 伪造证据（先收集，**解析出报告后再落 check**——否则会被 `result.checks = payload.checks` 覆盖）。
  const forgedEvidence = forged.length > 0
    ? {
      name: PLUGIN_PROBE_FORGED_RESULT_CHECK,
      status: 'fail',
      detail: `stdout 出现 ${forged.length} 行无 nonce / nonce 不匹配的结构化结果（伪造探针报告）：${forged[0].slice(0, 200)}`,
    }
    : null;
  if (forgedEvidence) {
    // 探针与插件**共用 stdout**，插件可自造绿卡或甩锅上游（见 docs/RISKS.md R26）。
    // 只落 errors（人读日志）与下面的 check：**绝不**据此把 result.ok 判真。
    result.errors.push(`${PLUGIN_PROBE_FORGED_RESULT_CHECK}: 检测到伪造的结构化结果行（共 ${forged.length} 行，本轮报告不可信）`);
  }
  if (!marker) {
    // 探针没写出结构化结果 = 它被**不可捕获**地终止了（SIGKILL / OOM / 原生 abort）
    // ——可捕获的四条出口（同步 / 异步 / 进程 exit / run() 被拖住）都由探针自己闭合，
    // 会照常输出结构化结果。这里只能用**相位信标**按证据归因，不得无条件甩给上游：
    //   有信标 ⇒ 终止发生在插件代码运行期间（`plugin-integration`）→ 落**插件侧 check**
    //            （与探针内部「未知相位保守判插件侧」同一取向：宁可让人多看插件一眼，
    //             也不让未确认的信号去开「上游漂移」这道门）；
    //   无信标 ⇒ 终止在宿主装配段 → 宿主/环境侧 → `hostFatal[]`（真上游信号，不丢）。
    // 探针没输出结构化结果 ⇒ 它**没跑完**（完成位显式置 false，不留给 undefined）：
    // 判据据此把这次运行排除在「通过」之外（🔴 必修-1 的假绿防线）。
    result.runCompleted = false;
    const beaconLine = text.split('\n').find((line) => line.startsWith(PROBE_PHASE_BEACON_PREFIX));
    const beaconPhase = beaconLine ? beaconLine.slice(PROBE_PHASE_BEACON_PREFIX.length).trim() : null;
    const tail = text.slice(-600);
    if (beaconPhase === PROBE_PHASE.PLUGIN_INTEGRATION) {
      result.phase = PROBE_PHASE.PLUGIN_INTEGRATION;
      result.checks.push({
        name: PLUGIN_ABNORMAL_TERMINATION_CHECK,
        status: 'fail',
        detail: `探针在插件集成相位被不可捕获终止（SIGKILL / OOM / 原生 abort；相位信标=${beaconPhase}）：${tail}`,
      });
      result.errors.push(`${PLUGIN_ABNORMAL_TERMINATION_CHECK}: 探针被不可捕获终止（有相位信标，落插件侧 check，不写 hostFatal[]）`);
    } else {
      pushHostFatal(result, `探针未输出结构化结果（探针自身崩溃 / 被宿主中断）：${tail}`);
    }
    return result;
  }
  let payload;
  try {
    payload = JSON.parse(marker.slice(expectedPrefix.length));
  } catch (error) {
    // 探针输出不可解析 = 探针自身（本仓文件）出问题 → 宿主侧，不甩锅插件
    pushHostFatal(result, `探针输出不可解析：${String(error?.message ?? error).slice(0, 200)}`);
    return result;
  }
  result.profile = payload.profile;
  result.checks = payload.checks ?? [];
  result.contract = payload.contract ?? {};
  result.probes = payload.probes ?? [];
  // 探针执行相位（host-assembly / plugin-integration）：异常归属的依据，透传给报告供排障。
  // 探针未回报时保留装配器判定（host-assembly），不退化成 null（否则排障看不到归属依据）。
  result.phase = payload.phase ?? result.phase;
  // 🟢 同样归一：errors 是日志（不参与判据），但非数组也不该被 spread 成逐字符噪声。
  if (Array.isArray(payload.errors)) result.errors.push(...payload.errors);
  // 探针侧的结构化宿主致命信号**原样透传**（执行器判据只读这一处，不再扫 errors 文本）。
  // 🟢 归一：只透传真正的数组元素——非数组（如畸形 payload 给字符串）不得被 spread 成逐字符噪声。
  if (Array.isArray(payload.hostFatal)) result.hostFatal.push(...payload.hostFatal);
  // 完成位**原样透传**（探针未给出时保持 false）：`ok` 必须同时要求「跑完」与「无失败」。
  result.runCompleted = payload.runCompleted === true;
  // 🆕 伪造证据**在报告解析之后**落 check（payload.checks 已就位）：
  // 本轮报告不可信 ⇒ `result.ok` 必为 false（errors 非空），且报告里看得见伪造项。
  if (forgedEvidence) result.checks.push(forgedEvidence);
  result.ok = result.runCompleted && payload.ok === true && result.errors.length === 0;
  return result;
}
