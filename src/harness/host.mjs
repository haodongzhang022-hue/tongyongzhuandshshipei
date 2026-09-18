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

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  PLUGIN_ABNORMAL_TERMINATION_CHECK,
  PLUGIN_PROBE_FORGED_RESULT_CHECK,
  PLUGIN_PROTOCOL_INJECTION_CHECK,
  PROBE_NONCE_ENV_ARG_PREFIX,
  PROBE_PHASE,
  PROBE_PHASE_BEACON_PREFIX,
  PROBE_RESULT_MARKER,
  createProbeNonce,
  probeResultPrefix,
  pushHostFatal,
} from './contract.mjs';
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
 * 探针子进程的执行参数（**唯一事实源**）。
 *
 * 抽出来的理由：`killSignal`（R24）与结果通道 fd3（R26）都是**安全相关**的固定取值，
 * 散落在 `spawnSync(...)` 调用点上就没人守得住（改一行即静默失效，而失效的后果是
 * 「CI 挂死」或「放行级假绿」）。抽成函数后离线单测可直接断言这两个不变量。
 *
 * @param {{hubRoot:string, pluginPath:string, expectedTools:string[], timeoutMs:number,
 *   nonce?:{envName:string, value:string}|null}} options 选项
 * @returns {import('node:child_process').SpawnSyncOptionsWithStringEncoding} spawnSync 选项
 */
export function probeSpawnOptions(options) {
  const { hubRoot, pluginPath, expectedTools, timeoutMs, nonce = null } = options;
  return {
    // 探针与其依赖同目录（probe.mjs / contract.mjs 由本模块拷入）
    cwd: undefined,
    encoding: 'utf8',
    timeout: timeoutMs,
    // R24：不可捕获、不可屏蔽的二次终止。默认 SIGTERM 会被探针自己的出口③ 处理器吞掉
    // （Node 默认终止行为被禁用）⇒ 插件同步死循环时宿主杀不掉探针（实测 30.3s / 永久挂死）。
    killSignal: 'SIGKILL',
    // R26：[stdin, stdout, stderr, fd3]；fd3 = 结构化结果专用通道（探针 `writeSync(3, ...)`）。
    // 于是「stdout 里出现结果行」本身就是篡改证据（通道隔离）。
    stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
    // nonce 带外通道（侧信道）：名字经 argv 传、值经 env 传（名字也随机 ⇒ 插件不能靠猜名字拿到它）。
    ...(nonce ? { env: { ...process.env, [nonce.envName]: nonce.value } } : {}),
    args: ['probe.mjs', hubRoot, pluginPath, JSON.stringify(expectedTools),
      ...(nonce ? [`${PROBE_NONCE_ENV_ARG_PREFIX}${nonce.envName}`] : [])],
  };
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
          // 同 R24：npm 也可能挂住（网络半死 / 子进程不响应 SIGTERM）⇒ 超时后 SIGKILL 兜底，
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

    // R24（复评）：`execFileSync` 的 timeout 走 `killSignal`（默认 SIGTERM），而探针为出口③
    // 装了 `SIGTERM` 处理器 ⇒ Node 的默认终止行为被**禁用** ⇒ 插件 `apply()` 同步死循环时
    // 宿主**杀不掉**探针（实测：timeout=5000 却耗时 30.3s；`while(true)` 形态永久挂死，吃满 CI 额度）。
    // 修法（一行）：`killSignal: 'SIGKILL'`——不可捕获、不可屏蔽（实测 5011ms 收口，零回归）。
    // ⚠️ 代价（**显式声明**，见 `docs/RISKS.md` R24）：超时路径**失去优雅报告**——探针没机会写
    //    结构化结果，只剩相位信标归因（`plugin.abnormal_termination`，插件侧、`hostFatal=0`）。
    //    正常路径不受影响：探针自己的 `RUN_WATCHDOG_MS`（20s）先于 `timeoutMs`（600s）触发。
    //
    // R26（复评）**两条防线并集**（互相独立、都要）：
    // - **nonce 带外通道**（侧信道）：宿主随机 nonce + 随机环境变量名，名字经 argv 传、值经 env 传，
    //   探针输出带 nonce 前缀 ⇒ 插件伪造裸 marker 被识别为**伪造**（`plugin.probe_result_forged`）；
    // - **结果通道隔离**：结构化结果走 **fd3**，stdout 只留日志 ⇒「stdout 里出现结果行」本身
    //   就是篡改证据（`plugin.protocol_injection`）；`spawnSync` 才拿得到 fd3。
    const nonce = createProbeNonce(randomBytes);
    result.probeNonceEnvName = nonce.envName; // 排障用（值本身**不**落盘，避免泄漏进报告）

    let stdout = '';
    let resultFd = '';
    try {
      const probeOptions = probeSpawnOptions({ hubRoot, pluginPath, expectedTools, timeoutMs, nonce });
      const probeRun = spawnSync('node', probeOptions.args, { ...probeOptions, cwd: workDir });
      stdout = `${probeRun.stdout ?? ''}`;
      resultFd = `${probeRun.output?.[3] ?? ''}`;
      // 超时（`ETIMEDOUT`）时 `spawnSync` **不抛异常**：它把实况放在 `error` / `signal` 上。
      // 与旧 `execFileSync` 路径保持同一形状（`probeExit` + 一条 errors 日志），供断言与排障。
      if (probeRun.error || probeRun.signal) {
        result.probeExit = { status: probeRun.status ?? null, signal: probeRun.signal ?? null };
        result.errors.push(`探针非零退出（status=${probeRun.status ?? 'null'}${probeRun.signal ? `, signal=${probeRun.signal}` : ''}${probeRun.error?.code ? `, error=${probeRun.error.code}` : ''}）`);
      }
    } catch (error) {
      stdout = `${error.stdout ?? ''}`;
      // 注意：措辞里**不得**回显命令行与路径（历史缺陷：路径含 npm 时被归因判据误命中，
      // 把插件 bug 报成上游漂移）。归因只看探针的结构化错误，这里只记退出实况。
      result.probeExit = { status: error.status ?? null, signal: error.signal ?? null };
      result.errors.push(`探针非零退出（status=${error.status ?? 'null'}${error.signal ? `, signal=${error.signal}` : ''}）`);
    }

    interpretProbeStdout(result, stdout, { resultFd, nonce: nonce.value });
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
 * 收集文本里的**结构化结果行**（`__DSH_PROBE__<json>`），返回全部命中（按出现顺序）。
 *
 * 为什么返回**全部**而不是第一条（R26）：旧实现用 `find(startsWith(...))` 取第一条，插件只要在
 * `apply()` 里先写一条伪造结果就能抢到首位、让真报告被忽略（实测三种形态均判 GREEN 放行）。
 * 「条数」本身是**结构不变量**：正常探针一次运行恒为 1 条（8 份夹具实测），≥2 条即篡改铁证。
 *
 * ⚠️ 命名纪律：相位信标 `__DSH_PROBE_PHASE__` 第 13 个字符是 `P`，而结果标记要求 `_`
 * ⇒ 本函数**不会**误命中信标行（由 `tests/test_attribution.mjs` [9.9f] 断言）。
 *
 * @param {string} text 待扫描文本（stdout 或结果通道 fd3）
 * @returns {string[]} 命中的结果行（原样，含前缀）
 */
export function collectProbeResultLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('__DSH_PROBE__'));
}

/**
 * 把探针的 stdout **解释**进 `result`（纯函数，装配器与离线回归共用同一份）。
 *
 * 抽出来的理由：这段逻辑是本中台最容易「静默判错」的地方（判据字段 `hostFatal[]` 的写入端），
 * 而它原先只被真宿主 E2E 覆盖（慢、要网）。抽成纯函数后，离线回归可以用**真实探针输出**
 * （含 SIGKILL 这类不可捕获终止的产物）直接断言归因，不必等 CI 装宿主。
 *
 * 情形（**协议注入防线最优先**）：
 * ## R26 两条防线（**并集**，互相独立）
 * **A · 结构不变量**：正常探针一次运行**恒为 1 条**结果行（实测 8 份夹具全为 1）
 *   ⇒ 结果行 **≥2 条**即铁证是篡改（无需知道谁写的）。
 * **B · 通道隔离**：结构化结果**只**认 fd3 ⇒「stdout 里出现结果行」本身即篡改证据。
 * **C · nonce 带外通道**（侧信道）：传入 `options.nonce` 时**只有**带该 nonce 前缀的行才算报告；
 *   出现裸 `__DSH_PROBE__` / nonce 不匹配的行 ⇒ 判**伪造**（{@link PLUGIN_PROBE_FORGED_RESULT_CHECK}），
 *   且**不得**把它当作报告（否则插件 `write('__DSH_PROBE__{绿卡}')` 就能自我发绿卡）。
 *   不传 `nonce`（离线单测 / 手工调用）时退化为「认裸 marker」的历史行为。
 *
 * 归因顺序（**协议注入防线最优先**）：
 * 0. **结果通道被篡改** → 落插件侧 check `plugin.protocol_injection`、`runCompleted=false`、
 *    `ok=false`、`hostFatal[]` 为空。**不再**采信任何一条（`find(first)` 只作末位兼容）。
 * 1. 有结构化结果 → 原样透传 `checks` / `hostFatal` / `phase` / `runCompleted`；
 *    `ok` 必须**同时**要求「跑完」（完成位）与「无失败」（🔴 必修-1）；带 nonce 时，
 *    伪造证据（裸 marker 行）在报告解析后追加为 fail check（本轮不可信 ⇒ `ok` 必为 false）。
 * 2. 无结构化结果 + **有相位信标** → 不可捕获终止（SIGKILL / OOM）发生在**插件集成**相位
 *    → 落插件侧 check `plugin.abnormal_termination`，`hostFatal[]` 保持为空（不甩锅上游）。
 * 3. 无结构化结果 + 无信标 → 终止在宿主装配段 → `hostFatal[]`（真上游信号，不丢）。
 *
 * @param {object} result 装配器结果对象（就地写入）
 * @param {string} stdout 探针 stdout（**只应含日志**；出现结果行即篡改证据）
 * @param {string|{resultFd?:string, nonce?:string|null}} [channelOrOptions] 结果通道（fd3 文本）
 *   或选项对象 `{ resultFd, nonce }`；两种写法都支持（旧 2 参调用与 3 参字符串调用行为不变）
 * @returns {object} 同一个 result（便于链式使用）
 */
export function interpretProbeStdout(result, stdout, channelOrOptions = '') {
  const options = typeof channelOrOptions === 'object' && channelOrOptions !== null ? channelOrOptions : { resultFd: channelOrOptions };
  const resultFd = options.resultFd ?? '';
  const nonce = options.nonce ?? null;
  const text = String(stdout ?? '');
  const channelText = String(resultFd ?? '');
  const expectedPrefix = nonce ? probeResultPrefix(nonce) : PROBE_RESULT_MARKER;
  const channelMarkers = collectProbeResultLines(channelText);
  const stdoutMarkers = collectProbeResultLines(text);
  // 结果行分两类（R26 的**两条独立证据链**）：
  // - **匹配 nonce 前缀**的 = 像探针写的（进通道/条数结构判定）；
  // - **不匹配**（裸 marker / 别的 nonce）= **冒用探针输出协议** ⇒ 伪造证据（{@link PLUGIN_PROBE_FORGED_RESULT_CHECK}）。
  const matchingOnChannel = channelMarkers.filter((line) => line.startsWith(expectedPrefix));
  const matchingOnStdout = stdoutMarkers.filter((line) => line.startsWith(expectedPrefix));
  const forgedMarkers = nonce
    ? [...channelMarkers, ...stdoutMarkers].filter((line) => !line.startsWith(expectedPrefix))
    : [];
  // 通道隔离（R26 修法 B）：结构化结果**只**认 fd3。fd3 不可用（离线回归台 / 直接跑探针 /
  // 老装配器）时回退 stdout——此时 2 参调用行为与 v0.1.9c 完全一致（旧断言不破）。
  const isolated = channelText.trim().length > 0;
  const markers = isolated ? matchingOnChannel : matchingOnStdout;
  const marker = markers.length > 0 ? markers[0] : null;
  // ---- R26 协议注入防线（放行级假绿）----
  // **结构不变量**：正常探针一次运行**恒为 1 条**结果行。≥2 条即铁证是篡改（无需知道谁写的）；
  // 通道隔离生效后，「stdout 里出现结果行」同样是铁证（探针的结果**只**走 fd3）。
  // ⚠️ 与「nonce 不匹配」（伪造）的分工：本项是**结构级**异常（条数 / 通道），一旦成立就
  // **无法判断哪一条是真报告** ⇒ 硬判篡改、丢弃全部结果；nonce 不匹配则是**软**证据——
  // 真报告（带 nonce）仍可解析，故在报告解析后**追加** fail check（保住真缺陷的可读性）。
  const injectionEvidence = [];
  if (markers.length > 1) injectionEvidence.push(`结果通道出现 ${markers.length} 条结果行（正常恒为 1 条）`);
  if (isolated && matchingOnStdout.length > 0) {
    injectionEvidence.push(`结果走独立通道，但 stdout 里也出现 ${matchingOnStdout.length} 条结果行（探针只写结果通道）`);
  }
  if (injectionEvidence.length > 0) {
    result.runCompleted = false;
    result.checks = [];
    result.errors = [];
    result.hostFatal = [];
    result.checks.push({
      name: PLUGIN_PROTOCOL_INJECTION_CHECK,
      status: 'fail',
      detail: `探针结果通道被插件注入/篡改（${injectionEvidence.join('；')}）——真报告可能被伪造结果顶替，本轮结果不可信`,
    });
    result.errors.push(`${PLUGIN_PROTOCOL_INJECTION_CHECK}: 结果通道被插件篡改（${injectionEvidence.join('；')}）`);
    // 末位兼容（契约要求）：多 marker 时**先判篡改**，不再用 `find(first)` 采信任何一条。
    result.phase = PROBE_PHASE.PLUGIN_INTEGRATION;
    result.ok = false;
    return result;
  }
  // nonce 不匹配 ⇒ 伪造证据（**先收集**，解析出报告后再落 check——否则会被 `result.checks = payload.checks` 覆盖）。
  const forgedEvidence = forgedMarkers.length > 0
    ? {
      name: PLUGIN_PROBE_FORGED_RESULT_CHECK,
      status: 'fail',
      detail: `结果通道出现 ${forgedMarkers.length} 行无 nonce / nonce 不匹配的结构化结果（伪造探针报告）：${forgedMarkers[0].slice(0, 200)}`,
    }
    : null;
  if (forgedEvidence) {
    // 探针与插件**共用输出面**，插件可自造绿卡或甩锅上游（见 docs/RISKS.md R26）。
    // 只落 errors（人读日志）与下面的 check：**绝不**据此把 result.ok 判真。
    result.errors.push(`${PLUGIN_PROBE_FORGED_RESULT_CHECK}: 检测到伪造的结构化结果行（共 ${forgedMarkers.length} 行，本轮报告不可信）`);
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
  // nonce 伪造证据**在报告解析之后**落 check（payload.checks 已就位）：
  // 本轮报告不可信 ⇒ `result.ok` 必为 false（errors 非空），且报告里看得见伪造项。
  if (forgedEvidence) result.checks.push(forgedEvidence);
  result.ok = result.runCompleted && payload.ok === true && result.errors.length === 0;
  return result;
}
