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
  PLUGIN_EXIT_CODE_MISMATCH_CHECK,
  PLUGIN_PROBE_FORGED_RESULT_CHECK,
  PLUGIN_PROTOCOL_INJECTION_CHECK,
  PROBE_NONCE_STDIN_CHANNEL,
  RESULT_CHANNEL_FD3,
  RESULT_CHANNEL_STDOUT_DEGRADED,
  PROBE_PHASE,
  PROBE_PHASE_BEACON_PREFIX,
  PROBE_RESULT_MARKER,
  createProbeNonce,
  probeReportTag,
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
 * 宿主侧**子进程终止信号**（唯一事实源）：`probeSpawnOptions` / `npm install` 到点后用它终止子进程。
 *
 * ## 为什么必须是 `SIGKILL`（不是 Node 默认的 `SIGTERM`）
 * `execFileSync`/`spawnSync` 的 `timeout` 到点发的是 `killSignal`（默认 `SIGTERM`）。而**探针自己装了**
 * `SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT` 处理器（出口 ③：插件自杀式信号的归因）——
 * Node 语义：**一旦有监听器，默认终止行为即被替换**。于是「插件在 `apply()` 里同步占死
 * 事件循环」时：
 *   1. 看门狗 / 信号处理器都在**同一个事件循环**上 ⇒ 一个都跑不了（信号已入队但没人处理）；
 *   2. `SIGTERM` 被探针自己的处理器**吞掉**（处理器不可达 ≠ 信号无效）⇒ 探针不死；
 *   3. 宿主于是**等不到子进程退出** ⇒ CI 级**无界挂起**（`while(true)` 形态吃满 `CNB_PIPELINE_MAX_RUN_TIME`）。
 * `SIGKILL` **不可捕获、不可屏蔽** ⇒ 一定终止 ⇒ 有界返回（实测 5.07s → 3.01s）。
 *
 * ## 代价（显式声明，不静默）
 * 探针来不及写结构化结果 ⇒ 装配器按**相位信标**（`__DSH_PROBE_PHASE__`）归因：
 * 有信标（终止发生在插件代码运行期间）→ 插件侧 check `plugin.abnormal_termination`，
 * `hostFatal[]` 保持为空（**不甩锅上游**）；无信标 → `hostFatal[]`（真上游信号不丢）。
 * 这与「不可捕获终止」的既有口径一致，不是新活口。
 *
 * ## 残留（未越权承诺）
 * 1. 默认 `timeoutMs` 仍是 600s ⇒ `while(true)` 插件在 CI 上**有界但慢**（吃满 600s 才被杀）；
 *    是否缩短默认超时属**待拍板**项，见 `docs/RISKS.md` R24 / R27 残留①。
 * 2. 探针内的看门狗（出口 ④）仍依赖**被占满的事件循环**——它对本形态无效；
 *    根治方向是**结构性重做**（进程隔离 / 独立线程），见 `docs/REDO-PROPOSAL.md`。
 */
export const CHILD_KILL_SIGNAL = 'SIGKILL';

/**
 * 探针子进程的执行参数（**唯一事实源**）。
 *
 * 抽出来的理由：`killSignal`（R24）与结果通道 fd3（R26）都是**安全相关**的固定取值，
 * 散落在 `spawnSync(...)` 调用点上就没人守得住（改一行即静默失效，而失效的后果是
 * 「CI 挂死」或「放行级假绿」）。抽成函数后离线单测可直接断言这两个不变量。
 *
 * @param {{hubRoot:string, pluginPath:string, expectedTools:string[], timeoutMs:number,
 *   nonce?:{value:string}|null, killSignal?:string}} options 选项
 *   `killSignal` 仅用于**回归反证**（离线台传 `'SIGTERM'` 复现「超时被探针处理器吞掉 ⇒ 无界」的旧缺陷）；
 *   生产路径**不得**传它——默认值就是 {@link CHILD_KILL_SIGNAL}（源码守卫 [14] 钉住这一点）。
 * @returns {import('node:child_process').SpawnSyncOptionsWithStringEncoding} spawnSync 选项
 */
export function probeSpawnOptions(options) {
  const { hubRoot, pluginPath, expectedTools, timeoutMs, nonce = null, killSignal = CHILD_KILL_SIGNAL } = options;
  return {
    // 探针与其依赖同目录（probe.mjs / contract.mjs 由本模块拷入）
    cwd: undefined,
    encoding: 'utf8',
    timeout: timeoutMs,
    // R24：不可捕获、不可屏蔽的二次终止。默认 SIGTERM 会被探针自己的出口③ 处理器吞掉
    // （Node 默认终止行为被禁用）⇒ 插件同步死循环时宿主杀不掉探针（实测 30.3s / 永久挂死）。
    // 取值来自唯一事实源 CHILD_KILL_SIGNAL（离线台可覆写成 SIGTERM 做**反向反证**，见 [17]）。
    killSignal,
    // R26：[stdin, stdout, stderr, fd3]；fd3 = 结构化结果专用通道（探针 `writeSync(3, ...)`）。
    // 于是「stdout 里出现结果行」本身就是篡改证据（通道隔离）。
    // stdin = nonce 的**带外通道**（见 `PROBE_NONCE_STDIN_CHANNEL` 的实测依据：env 通道可被
    // `/proc/self/environ` 反读、argv 通道会出现在 `ps` 里，两者都能让插件伪造出被采信的结果行）。
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    ...(nonce ? { input: `${nonce.value}\n` } : { input: '' }),
    args: ['probe.mjs', hubRoot, pluginPath, JSON.stringify(expectedTools)],
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
    // 结果通道形态（批 1.5 / 🔴-R2：**降级必须显式可见**，不得静默）。
    // `resultChannel`：'fd3' | 'stdout-degraded'；`resultChannelDegraded`：降级 ⇒ **不得判 PASS**；
    // `resultChannelAtStart`：插件代码运行**之前**探测到的通道形态（用于区分
    // 「环境没有 fd3」与「插件把 fd3 关了」——两者归因完全不同）。
    resultChannel: null,
    resultChannelDegraded: false,
    resultChannelAtStart: null,
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
          // 让 `timeoutMs` 对**安装段**同样是有界承诺（不是只对探针段）。同一份唯一事实源常量。
          killSignal: CHILD_KILL_SIGNAL,
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
    // - **nonce 带外通道**（侧信道）：宿主随机 nonce 经 **stdin** 下发（不进 argv/env ⇒
    //   不落 `/proc/self/environ`、不出现在 `ps` 里）；探针输出**正文绑定**的逐行认证标签
    //   （`HMAC(nonce, 正文)`，v0.2.5 起）⇒ 插件伪造（裸 marker / 标签不符）被识别为
    //   **伪造**（`plugin.probe_result_forged`），且**读到真报告也伪造不出新正文**（R3′）；
    // - **结果通道隔离**：结构化结果走 **fd3**，stdout 只留日志 ⇒「stdout 里出现结果行」本身
    //   就是篡改证据（`plugin.protocol_injection`）；`spawnSync` 才拿得到 fd3。
    const nonce = createProbeNonce(randomBytes);
    // 排障用：只记通道形态（值本身**不**落盘，避免泄漏进报告）。
    result.probeNonceChannel = PROBE_NONCE_STDIN_CHANNEL;

    let stdout = '';
    let resultFd = '';
    try {
      const probeOptions = probeSpawnOptions({ hubRoot, pluginPath, expectedTools, timeoutMs, nonce });
      const probeRun = spawnSync('node', probeOptions.args, { ...probeOptions, cwd: workDir });
      stdout = `${probeRun.stdout ?? ''}`;
      resultFd = `${probeRun.output?.[3] ?? ''}`;
      // 超时（`ETIMEDOUT`）时 `spawnSync` **不抛异常**：它把实况放在 `error` / `signal` 上。
      // 与旧 `execFileSync` 路径保持同一形状（`probeExit` + 一条 errors 日志），供断言与排障。
      //
      // 🔴 必修-4（评审复评）：`probeExit` 必须**无条件**记录，不能只在 `error || signal` 时赋值。
      // 旧实现下「探针正常退出但退出码非 0」（= 探针自己判了失败）**根本不进报告** ⇒
      // 装配器**无法**做「退出码 ↔ 报告」交叉校验 ⇒ 插件猴子补丁 `JSON.stringify` 伪造绿卡时
      // 没有任何信号可对（实测：`exit status=1` 而报告 `ok=true`，全绿放行）。
      // 现在无条件落 `probeExit`（`status` / `signal`），交叉校验在 `interpretProbeStdout()`。
      result.probeExit = { status: probeRun.status ?? null, signal: probeRun.signal ?? null };
      if (probeRun.error || probeRun.signal || (probeRun.status !== null && probeRun.status !== 0)) {
        result.errors.push(`探针非零退出（status=${probeRun.status ?? 'null'}${probeRun.signal ? `, signal=${probeRun.signal}` : ''}${probeRun.error?.code ? `, error=${probeRun.error.code}` : ''}）`);
      }
    } catch (error) {
      stdout = `${error.stdout ?? ''}`;
      // 注意：措辞里**不得**回显命令行与路径（历史缺陷：路径含 npm 时被归因判据误命中，
      // 把插件 bug 报成上游漂移）。归因只看探针的结构化错误，这里只记退出实况。
      result.probeExit = { status: error.status ?? null, signal: error.signal ?? null };
      result.errors.push(`探针非零退出（status=${error.status ?? 'null'}${error.signal ? `, signal=${error.signal}` : ''}）`);
    }

    // `reportedChannel` 供判据 D（🔴-R3′）：宿主侧先按「报告自述的通道形态」快照一次。
    // ⚠️ 这里**必须**用 `JSON.parse` 而不是 `credentialOf`（结果行格式由上面统一解释）；
    // 探针报告自述字段取自 fd3/stdout 上的**报告正文**（解释内部再按标签校验）。
    interpretProbeStdout(result, stdout, { resultFd, nonce: nonce.value, reportedChannel: reportedChannelOf(resultFd, stdout, nonce.value) });
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
  // ⚠️ 用唯一事实源常量 `PROBE_RESULT_MARKER`，**不得**写裸字面量 `'__DSH_PROBE__'`：
  // 评审 🟡 点名——裸字面量在改名时**静默失配**（标记改了、这里没改 ⇒ 一条结果行都收不到 ⇒
  // 归因退化成「探针未输出结构化结果」，而源码守卫扫不到）。由离线 [9.11g] 源码守卫钉住。
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith(PROBE_RESULT_MARKER));
}

/**
 * 从结果行里读出探针**自述的通道形态**（`payload.resultChannel`），供判据 D（🔴-R3′）使用。
 *
 * 为什么单独一个函数、且在解释之前先取：判据 D 要回答「报告**自称**走哪条通道」，而这条
 * 自述必须与「宿主**实际**从 fd3 读到了什么」比对。若等到解释之后才取，结果可能已被
 * `checks` / `result` 归一覆盖（自述来自报告正文，不是 `result.resultChannel`）。
 *
 * ## 两档可信度（都只用来回答「报告**自称**走哪条通道」，**不用来采信报告**）
 * 1. **凭据有效**的行（标签与正文相符）⇒ 优先采用它的自述；
 * 2. 无有效行时，退化为对**任意**结果行正文的 best-effort 解析（**攻击者可控**）。
 *
 * 第 2 档为什么存在（🔴-R3′）：本实现的凭据是**正文绑定标签** ⇒ 插件用「从被重定向的真报告里
 * 读到的凭据」伪造时，那行凭据**无效**；若只认第 1 档，判据 D 会**漏判** R3′ 最核心的形态。
 * 放宽是安全的：第 2 档读到的只是「自称」，而判据 D 的**硬证据**是「宿主实际从 fd3 读到空」
 * （宿主侧观测，插件不可控）；且「自称 `stdout-degraded` 以规避 D」的插件仍会被判据 C
 * （凭据不可迁移）判出 ⇒ **不会放行**。
 *
 * 纪律：本函数**不得**因畸形输入抛错（它跑在装配路径上，抛错会把插件问题变成宿主问题）。
 * 读不到（无结果行 / 解析失败 / 无该字段）时返回 `null` ⇒ 判据 D **不触发**（保守，不制造假红）。
 *
 * @param {string} resultFd 宿主实际从 fd3 读到的文本
 * @param {string} stdout 探针 stdout
 * @param {string} nonce 宿主生成的 nonce
 * @returns {string|null} `'fd3'` / `'stdout-degraded'` / null
 */
export function reportedChannelOf(resultFd, stdout, nonce) {
  const claimOf = (line, requireCredential) => {
    try {
      const rest = line.slice(PROBE_RESULT_MARKER.length);
      const sep = rest.indexOf(':');
      if (sep <= 0) return null;
      const tag = rest.slice(0, sep);
      const body = rest.slice(sep + 1);
      if (requireCredential && probeReportTag(nonce, body) !== tag) return null;
      const parsed = JSON.parse(body);
      return typeof parsed?.resultChannel === 'string' ? parsed.resultChannel : null;
    } catch {
      return null;
    }
  };
  try {
    const channelText = String(resultFd ?? '');
    const isolated = channelText.trim().length > 0;
    const lines = isolated ? collectProbeResultLines(channelText) : collectProbeResultLines(String(stdout ?? ''));
    // 第 1 档：凭据有效的行
    for (const line of lines) {
      const claim = claimOf(line, true);
      if (claim !== null) return claim;
    }
    // 第 2 档：无有效行 ⇒ 退化为 best-effort（见 JSDoc 的「两档可信度」）
    for (const line of collectProbeResultLines(String(stdout ?? ''))) {
      const claim = claimOf(line, false);
      if (claim !== null) return claim;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 把探针的 stdout **解释**进 `result`（纯函数，装配器与离线回归共用同一份）。
 *
 * 抽出来的理由：这段逻辑是本中台最容易「静默判错」的地方（判据字段 `hostFatal[]` 的写入端），
 * 而它原先只被真宿主 E2E 覆盖（慢、要网）。抽成纯函数后，离线回归可以用**真实探针输出**
 * （含 SIGKILL 这类不可捕获终止的产物）直接断言归因，不必等 CI 装宿主。
 *
 * 情形（**协议注入防线最优先**）：
 * ## R26 防线（**并集**，互相独立）
 * **A · 结构不变量**：正常探针一次运行**恒为 1 条**结果行（实测 8 份夹具全为 1）
 *   ⇒ 结果行 **≥2 条**即铁证是篡改（无需知道谁写的）。
 * **B · 通道隔离**：结构化结果**只**认 fd3 ⇒「stdout 里出现结果行」本身即篡改证据。
 * **C · 逐行认证标签**（v0.2.5 起；原为「回显 nonce 的前缀」）：传入 `options.nonce` 时
 *   **只有**「正文与标签相符」的行才算报告（`HMAC(nonce, 正文)`，宿主用**自己已知的 nonce** 重算）。
 *   出现裸 `__DSH_PROBE__` / 标签不符的行 ⇒ 判**伪造**
 *   （{@link PLUGIN_PROBE_FORGED_RESULT_CHECK}），且**不得**把它当作报告。
 *   不传 `nonce`（离线单测 / 手工调用）时退化为「认裸 marker」的历史行为。
 * **D · 通道重定向判据**（🔴-R3′ 收口，v0.2.5）：`options.reportedChannel === 'fd3'`（探针报告
 *   **自称**结果走 fd3）而宿主**实际**从 fd3 读到的内容为空、却在 stdout 看到「正文与标签相符」的
 *   结果行 ⇒ 判 `plugin.protocol_injection`、**不采信任何一条**。依据是**宿主侧对 fd3 的实际观测**
 *   （不是报告自述）⇒ 插件压 `process.exitCode` / 关 fd3 / 把 fd3 换成自己的文件都无效。
 *   ⚠️ 为什么必须有它（评审实测 R3′）：插件把 fd3 换成**自己的文件** ⇒ 探针（不知情）把**真报告**
 *   写进插件的文件 ⇒ 插件在 `exit` 钩子里读出凭据 ⇒ 再伪造 ⇒ 旧实现判 **GREEN 放行**。
 *   ⇒ **nonce 保密性不是唯一防线**（该形态是探针**亲自**把凭据交给插件的）。
 *
 * 归因顺序（**协议注入防线最优先**）：
 * 0. **结果通道被篡改** → 落插件侧 check `plugin.protocol_injection`、`runCompleted=false`、
 *    `ok=false`、`hostFatal[]` 为空。**不再**采信任何一条（`find(first)` 只作末位兼容）。
 * 1. 有结构化结果 → 原样透传 `checks` / `hostFatal` / `phase` / `runCompleted`；
 *    `ok` 必须**同时**要求「跑完」（完成位）与「无失败」（🔴 必修-1）；带 nonce 时，
 *    伪造证据（标签不符的行）在报告解析后追加为 fail check（本轮不可信 ⇒ `ok` 必为 false）。
 * 2. 无结构化结果 + **有相位信标** → 不可捕获终止（SIGKILL / OOM）发生在**插件集成**相位
 *    → 落插件侧 check `plugin.abnormal_termination`，`hostFatal[]` 保持为空（不甩锅上游）。
 * 3. 无结构化结果 + 无信标 → 终止在宿主装配段 → `hostFatal[]`（真上游信号，不丢）。
 *
 * @param {object} result 装配器结果对象（就地写入）
 * @param {string} stdout 探针 stdout（**只应含日志**；出现结果行即篡改证据）
 * @param {string|{resultFd?:string, nonce?:string|null, reportedChannel?:string|null}} [channelOrOptions]
 *   结果通道（fd3 文本）或选项对象 `{ resultFd, nonce, reportedChannel }`；两种写法都支持
 *   （旧 2 参调用与 3 参字符串调用行为不变）。`reportedChannel` = 探针报告**自称**的通道形态
 *   （`'fd3'` / `'stdout-degraded'` / null）——判据 D 用它比对**宿主侧实际观测**。
 * @returns {object} 同一个 result（便于链式使用）
 */
export function interpretProbeStdout(result, stdout, channelOrOptions = '') {
  const options = typeof channelOrOptions === 'object' && channelOrOptions !== null ? channelOrOptions : { resultFd: channelOrOptions };
  const resultFd = options.resultFd ?? '';
  const nonce = options.nonce ?? null;
  const reportedChannel = options.reportedChannel ?? null;
  const text = String(stdout ?? '');
  const channelText = String(resultFd ?? '');
  const channelMarkers = collectProbeResultLines(channelText);
  const stdoutMarkers = collectProbeResultLines(text);
  // 结果行分两类（R26 的**两条独立证据链**）：
  // - **凭据有效**的（正文与标签相符）= 像探针写的（进通道/条数结构判定）；
  // - **无效**（裸 marker / 标签不符）= **冒用探针输出协议** ⇒ 伪造证据（{@link PLUGIN_PROBE_FORGED_RESULT_CHECK}）。
  //
  // 凭据（v0.2.5 起）= 逐行**认证标签** `HMAC(nonce, 正文)`，**不是**回显 nonce 的前缀。
  // 为什么改（🔴-R3′）：插件可把 fd3 换成自己的文件 ⇒ 探针把带 nonce 的真报告写进插件文件 ⇒
  // 插件读出 nonce 即可伪造（旧实现判 GREEN 放行）。正文绑定的标签**不可迁移**：
  // 读到真报告只得到真正文的标签，伪造正文需要 nonce（插件没有）。
  const credentialOf = (line) => {
    if (!nonce) return { ok: true, body: line.slice(PROBE_RESULT_MARKER.length) };
    const rest = line.slice(PROBE_RESULT_MARKER.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return { ok: false, body: '' };
    const tag = rest.slice(0, sep);
    const body = rest.slice(sep + 1);
    return { ok: tag === probeReportTag(nonce, body), body };
  };
  const matchingOnChannel = channelMarkers.filter((line) => credentialOf(line).ok);
  const matchingOnStdout = stdoutMarkers.filter((line) => credentialOf(line).ok);
  const forgedMarkers = nonce
    ? [...channelMarkers, ...stdoutMarkers].filter((line) => !credentialOf(line).ok)
    : [];
  // 通道隔离（R26 修法 B）：结构化结果**只**认 fd3。fd3 不可用（离线回归台 / 直接跑探针 /
  // 老装配器）时回退 stdout——此时 2 参调用行为与 v0.1.9c 完全一致（旧断言不破）。
  const isolated = channelText.trim().length > 0;
  const markers = isolated ? matchingOnChannel : matchingOnStdout;
  const marker = markers.length > 0 ? markers[0] : null;
  // ---- 判据 D（🔴-R3′）：通道**重定向**（报告自称走 fd3，宿主实际从 fd3 读到空） ----
  // 依据 = **宿主侧对 fd3 的实际观测**（`channelText` 为空）+ 报告**自述**（`reportedChannel`）
  // ——两者都不是插件可控的退出码 / 报告正文字节。该形态下探针的结果行**只**应出现在 fd3；
  // stdout 上出现**任何**结果行都说明「结果行不是从这个进程的 fd3 来的」⇒ 硬判篡改、
  // 不采信任何一条（`markers` 全部丢弃）。
  //
  // ⚠️ 与评审给的最小式（要求 stdout 行「匹配 nonce」）的**差别与理由**：在本实现的
  // **正文绑定标签**下，插件用「从被重定向的真报告里读到的凭据」伪造时，那行的凭据**本身无效**
  // （标签只对真正文有效）⇒ 若按「匹配 nonce」判，D 会**漏判** R3′ 最核心的那个形态。
  // 故这里放宽到「有**任何**结果行」——它仍然保守：健康路径下 stdout **零**结果行
  // （探针只写 fd3），且本判据已用 `reportedChannel === 'fd3'` 排除了「降级到 stdout」的合法形态。
  const channelRedirectEvidence = reportedChannel === RESULT_CHANNEL_FD3
    && !isolated
    && stdoutMarkers.length > 0;
  // ---- R26 协议注入防线（放行级假绿）----
  // **结构不变量**：正常探针一次运行**恒为 1 条**结果行。≥2 条即铁证是篡改（无需知道谁写的）；
  // 通道隔离生效后，「stdout 里出现结果行」同样是铁证（探针的结果**只**走 fd3）。
  // ⚠️ 与「凭据无效」（伪造）的分工：本项是**结构级**异常（条数 / 通道 / 通道重定向），
  // 一旦成立就**无法判断哪一条是真报告** ⇒ 硬判篡改、丢弃全部结果；凭据无效则是**软**证据——
  // 真报告（标签相符）仍可解析，故在报告解析后**追加** fail check（保住真缺陷的可读性）。
  const injectionEvidence = [];
  if (markers.length > 1) injectionEvidence.push(`结果通道出现 ${markers.length} 条结果行（正常恒为 1 条）`);
  if (isolated && matchingOnStdout.length > 0) {
    injectionEvidence.push(`结果走独立通道，但 stdout 里也出现 ${matchingOnStdout.length} 条结果行（探针只写结果通道）`);
  }
  if (channelRedirectEvidence) {
    injectionEvidence.push('报告自称走 fd3，但宿主实际从 fd3 读到空、而 stdout 出现结果行（通道被重定向：探针的真报告被写进了插件替换的文件）');
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
    // 只落 errors（人读日志）与 check：**绝不**据此把 result.ok 判真。
    result.errors.push(`${PLUGIN_PROBE_FORGED_RESULT_CHECK}: 检测到伪造的结构化结果行（共 ${forgedMarkers.length} 行，本轮报告不可信）`);
    // 🆕 批 1.5：**没有可采信报告**时（例如插件伪造后立刻 `process.exit(0)`，真报告根本没写出来）
    // 伪造证据也必须落进 `checks`——否则报告里只看得到「不可捕获终止」一条，
    // 「有人冒用了探针的输出协议」这条**独立证据链**就丢了（评审 §3 反例正是这个形态）。
    if (!marker) result.checks.push(forgedEvidence);
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
    payload = JSON.parse(credentialOf(marker).body);
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
  // 伪造证据（裸 marker / 标签不符）**在报告解析之后**落 check（payload.checks 已就位）：
  // 本轮报告不可信 ⇒ `result.ok` 必为 false（errors 非空），且报告里看得见伪造项。
  if (forgedEvidence) result.checks.push(forgedEvidence);
  // ---- 🔴 必修-4：退出码交叉校验（两个独立产物互相矛盾即篡改） ----
  // 为什么需要（与 nonce 防线**同族**）：nonce 挡的是「冒用探针的输出协议」，但探针与插件
  // **同进程**，插件还能改**序列化函数**本身（猴子补丁 `JSON.stringify`）把失败项改成 pass、
  // 把 `errors` / `hostFatal` 清空、把 `ok` 置真——那时 nonce 前缀**照样匹配**，报告是伪造的。
  // 本仓实测（夹具 `plugin-stringify-tamper-plugin`）：子进程 `exit status=1`（探针自己判了失败）
  // 而报告 `ok=true / 17 项全 pass` ⇒ 失败被吞、绿卡被采信。
  //
  // 判据的不对称性：**退出码**由探针内存算出（`finish()` 的 `runCompleted && !syncThrew &&
  // !failureHandled && errors.length === 0`，**不经序列化**）；**报告**是 `STRINGIFY(out)` 写出的字节。
  // 正常运行时两者必然一致（ok=true ⇒ 无失败 ⇒ 退出码 0）⇒ 矛盾即篡改证据。
  //
  // ⚠️ 边界（不越权承诺）：能同时篡改**退出码**（`process.exitCode` / 替换 `process.exit`）的插件
  // 仍可绕过本项——那属**进程级**对抗，根治需进程隔离（见 `docs/REDO-PROPOSAL.md` 批 2）。
  // 与探针侧「加载期捕获引用」是**两道并集**，不是单一不变量。
  // 无 `probeExit`（老装配器 / 离线合成输入 / 直接调用本函数）时**不判**（保守，不制造假红）。
  {
    const exit = result.probeExit ?? null;
    const exitAbnormal = Boolean(exit) && ((exit.status !== null && exit.status !== undefined && exit.status !== 0) || Boolean(exit.signal));
    if (payload.ok === true && exitAbnormal) {
      result.checks.push({
        name: PLUGIN_EXIT_CODE_MISMATCH_CHECK,
        status: 'fail',
        detail: `报告自称通过（ok=true）但探针进程退出异常（status=${exit.status ?? 'null'}${exit.signal ? `, signal=${exit.signal}` : ''}）——退出码由探针内存算出、不经序列化，报告字节可被插件替换 ⇒ 本轮报告被篡改，不可信`,
      });
      result.errors.push(`${PLUGIN_EXIT_CODE_MISMATCH_CHECK}: 报告自称通过但退出码非 0（退出码交叉校验失败，本轮结果不可信）`);
    }
  }

  // ---- 批 1.5（🔴-R2）：结果通道**可见化** + 降级**不得放行** ----
  // 探针在报告里回报 `resultChannel`（'fd3' | 'stdout-degraded'）。老探针 / 无该字段时按
  // 「结果通道是否真的用上了」推断（`isolated` = fd3 有内容）。
  // ⚠️ 命名：判据 D 的入参也叫 `reportedChannel`（宿主侧在解释**之前**取的同一字段），
  // 此处是「报告正文里读到的那一份」，供落 `result.resultChannel` —— 两者同源、不重复取值。
  const payloadChannel = typeof payload.resultChannel === 'string' ? payload.resultChannel : null;
  // 通道形态以**探针的报告为准**（`payload.resultChannel`）——它是唯一知道「fd3 是否可写」的一方。
  // 老探针 / 合成 payload 无该字段时**不**追溯判降级（保持向后兼容：2 参调用的历史行为不变）。
  result.resultChannel = payloadChannel ?? (isolated ? RESULT_CHANNEL_FD3 : null);
  result.resultChannelAtStart = typeof payload.resultChannelAtStart === 'string' ? payload.resultChannelAtStart : null;
  result.resultChannelDegraded = payloadChannel === RESULT_CHANNEL_STDOUT_DEGRADED;
  if (result.resultChannelDegraded) {
    // 降级 = 结构化结果走 stdout ⇒ 「stdout 上出现结果行」**不再**构成篡改证据（装配器已回落到
    // stdout）。故本轮结论**不可信**：必须能看见、且**不得**判 PASS。两种成因归因不同：
    // - 早探测**可写**、收尾不可写 ⇒ 通道是**在插件代码运行期间**被关闭/替换的 ⇒ 插件侧篡改；
    // - 早探测即失败 ⇒ **环境**本身没有 fd3（容器 / Windows / 直接跑探针）⇒ 宿主/环境侧信号，
    //   落 `hostFatal[]` ⇒ `UPSTREAM_DRIFT`（AMBER，人须确认）——**不是**通过。
    const closedByPlugin = result.resultChannelAtStart === RESULT_CHANNEL_FD3;
    if (closedByPlugin) {
      if (!result.checks.some((c) => c.name === PLUGIN_PROTOCOL_INJECTION_CHECK)) {
        result.checks.push({
          name: PLUGIN_PROTOCOL_INJECTION_CHECK,
          status: 'fail',
          detail: '结果通道 fd3 在插件代码运行期间变为不可写（早探测可写、收尾不可写）——插件关闭/替换了探针的结果通道，本轮结果不可信',
        });
      }
      result.errors.push(`${PLUGIN_PROTOCOL_INJECTION_CHECK}: 结果通道被插件关闭/替换（早探测可写 → 收尾不可写）`);
    } else if (!result.errors.some((line) => String(line).includes(RESULT_CHANNEL_STDOUT_DEGRADED))) {
      pushHostFatal(result, `结果通道 fd3 在本环境不可用（早探测即失败）⇒ 结构化结果降级走 stdout（${RESULT_CHANNEL_STDOUT_DEGRADED}）：stdout 上的结果行不再具备篡改证据能力，本轮结论不可信（不放行，人须确认）`);
    }
  }
  // 完成位 + **降级** + **退出码交叉**：任一不满足即不得判 PASS（假绿比 AMBER 更危险）。
  // 退出码交叉（🔴 必修-4）把矛盾写进 errors[]（见上），故这里的 errors.length 检查已覆盖它。
  result.ok = result.runCompleted && payload.ok === true && result.errors.length === 0 && !result.resultChannelDegraded;
  return result;
}
