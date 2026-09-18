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
import { createHash } from 'node:crypto';
import { pushHostFatal } from './contract.mjs';
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
 * @returns {{channel:string, ok:boolean, profile:object|null, checks:object[], errors:string[], hostFatal:string[], contract:object, probes:object[], probeExit:object|null, install:string, cacheHit:boolean, durationMs:number}}
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
    probeExit: null,
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

    let stdout = '';
    try {
      stdout = execFileSync('node', ['probe.mjs', hubRoot, pluginPath, JSON.stringify(expectedTools)], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: timeoutMs,
      });
    } catch (error) {
      stdout = `${error.stdout ?? ''}`;
      // 注意：措辞里**不得**回显命令行与路径（历史缺陷：路径含 npm 时被归因判据误命中，
      // 把插件 bug 报成上游漂移）。归因只看探针的结构化错误，这里只记退出实况。
      result.probeExit = { status: error.status ?? null, signal: error.signal ?? null };
      result.errors.push(`探针非零退出（status=${error.status ?? 'null'}${error.signal ? `, signal=${error.signal}` : ''}）`);
    }

    const marker = stdout.split('\n').find((line) => line.startsWith('__DSH_PROBE__'));
    if (!marker) {
      pushHostFatal(result, `探针未输出结构化结果（探针自身崩溃 / 被宿主中断）：${stdout.slice(-600)}`);
      return result;
    }
    let payload;
    try {
      payload = JSON.parse(marker.slice('__DSH_PROBE__'.length));
    } catch (error) {
      // 探针输出不可解析 = 探针自身（本仓文件）出问题 → 宿主侧，不甩锅插件
      pushHostFatal(result, `探针输出不可解析：${String(error?.message ?? error).slice(0, 200)}`);
      return result;
    }
    result.profile = payload.profile;
    result.checks = payload.checks ?? [];
    result.contract = payload.contract ?? {};
    result.probes = payload.probes ?? [];
    result.errors.push(...(payload.errors ?? []));
    // 探针侧的结构化宿主致命信号**原样透传**（执行器判据只读这一处，不再扫 errors 文本）
    result.hostFatal.push(...(payload.hostFatal ?? []));
    result.ok = payload.ok === true && result.errors.length === 0;
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
