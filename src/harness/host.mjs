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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
 * @returns {{channel:string, ok:boolean, profile:object|null, checks:object[], errors:string[], contract:object, install:string, cacheHit:boolean, durationMs:number}}
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
    errors: [],
    contract: {},
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
      result.errors.push(`离线模式下缺少宿主依赖缓存：${cachePath}`);
      return result;
    } else {
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...pinsToSpecs(channel)], {
        cwd: workDir,
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: timeoutMs,
      });
      cpSync(path.join(workDir, 'node_modules'), path.join(cachePath, 'node_modules'), { recursive: true });
      result.install = 'npm-install';
    }

    if (!existsSync(path.join(workDir, 'node_modules'))) {
      cpSync(path.join(cachePath, 'node_modules'), path.join(workDir, 'node_modules'), { recursive: true });
    }

    cpSync(path.join(hubRoot, 'src', 'harness', 'probe-template.mjs'), path.join(workDir, 'probe.mjs'));

    let stdout = '';
    try {
      stdout = execFileSync('node', ['probe.mjs', hubRoot, pluginPath, JSON.stringify(expectedTools)], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: timeoutMs,
      });
    } catch (error) {
      stdout = `${error.stdout ?? ''}`;
      result.errors.push(`探针非零退出：${String(error.message).slice(0, 300)}`);
    }

    const marker = stdout.split('\n').find((line) => line.startsWith('__DSH_PROBE__'));
    if (!marker) {
      result.errors.push(`探针未输出结构化结果：${stdout.slice(-600)}`);
      return result;
    }
    const payload = JSON.parse(marker.slice('__DSH_PROBE__'.length));
    result.profile = payload.profile;
    result.checks = payload.checks ?? [];
    result.contract = payload.contract ?? {};
    result.errors.push(...(payload.errors ?? []));
    result.ok = payload.ok === true && result.errors.length === 0;
    return result;
  } catch (error) {
    result.errors.push(`装配失败：${String(error?.message ?? error).slice(0, 500)}`);
    return result;
  } finally {
    result.durationMs = Date.now() - started;
    rmSync(workDir, { recursive: true, force: true });
  }
}
