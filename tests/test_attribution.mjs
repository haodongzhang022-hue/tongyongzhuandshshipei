/**
 * 归因与契约采集的**离线**回归（不联网、不装宿主）。
 *
 * 为什么单独成文件：评审 🔴-A / 🔴-B 的失效面都落在「归因判据」与「契约采集副作用」上，
 * 而这两处过去只被真宿主 E2E 覆盖（跑得慢、依赖网络）。本文件用**假 tools** 把同一份
 * 实现拉进离线单测：判据一变就红，不必等 CI 装宿主。
 *
 * 覆盖：
 * 1. `collectContract()`：接受型宿主（上游取消保留名）采集后**必须立即卸载**，无残留；
 * 2. `attributeFailure()` / `attributionDetail()`：宿主侧**结构化** `hostFatal[]` 与插件侧 check 互不串味；
 * 3. 🔴-B 回归：错误串里含 `npm` 路径（探针命令行回显）**不得**把插件 bug 判成上游漂移；
 * 4. 旧版 `fatal:` 措辞（插件侧）**不得**再判漂移；
 * 5. **🔴-C 回归**：错误串（自由文本）里含 `fatal(host)` 字面量——插件 stack / 路径 / 工作目录——
 *    **不得**翻案；真宿主侧致命信号走 `hostFatal[]` 仍须判漂移；
 * 5b. **反向护栏**（评审 §四）：真漂移仍判漂移（schemaSubset / outputShape / configProjection /
 *    ETARGET / 离线缺缓存）、`guard.reserved_name` 精确性不回归、漂移窗口内健康插件不被误伤；
 * 6. CLI 参数契约：带值参数缺值显式报错（不静默改语义）、`resolveChannels` 默认值可指定；
 * 7. 缓存维护：`pruneHostCache()` 有真实调用点（`keepFingerprintsFor` + `cache` 子命令）；
 * 8. 装配器 `runHostProbe()`：宿主/环境侧失败落**结构化** `hostFatal[]`（离线缺缓存，无网可跑）。
 * 9. **🔴-D 回归**：探针顶层兜底必须**按相位**归因——插件集成相位的未预期异常落插件侧 check
 *    （`plugin.unexpected_exception`），**绝不**写 `hostFatal[]`；不变量守卫：`hostFatal[]` 不含插件侧 stack。
 * 10. **🔴-D 异步活口收口回归**：进程边界守卫（`createProbeBoundary()`）——
 *    异步异常（`uncaughtException` / `unhandledRejection`）与进程级 `exit` 必须经**同一归属路由**
 *    落插件侧 check，且**完成位** `runCompleted` 保证逃逸路径不可能判 `ok`（防假绿）。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync as readText } from 'node:fs';
import {
  CONTRACT_SIDE_CHECKS,
  HOST_SIDE_CHECKS,
  PLUGIN_HARD_EVIDENCE,
  PLUGIN_PROBE_EXCEPTION_CHECK,
  PLUGIN_PROBE_EXIT_CHECK,
  PLUGIN_SIDE_CHECKS,
  PROBE_COMPLETION_FIELD,
  PROBE_ESCAPE_FIELD,
  PROBE_MARKER,
  PROBE_PHASE,
  PROCESS_ESCAPE,
  collectContract,
  createProbeBoundary,
  emitProbeResult,
  finalizeProbeResult,
  probeFailureRoute,
  pushHostFatal,
  recordProbeException,
  serializeProbeResult,
} from '../src/harness/contract.mjs';
import { attributeFailure, attributionDetail } from '../src/verify/runner.mjs';
import { ALL_CHANNELS, keepFingerprintsFor, parseArgs, resolveChannels } from '../src/cli.mjs';
import { channelFingerprint, loadChannels, pruneHostCache, runHostProbe } from '../src/harness/host.mjs';
// 源码扫描工具（去注释 / 去字符串字面量）——守卫不能有盲区，见 P2-10
import { codeOnly, stripComments } from './source-scan.mjs';
import { DRIFT_FIELDS, DRIFT_IMPACT, classifyDrift, diffReservedNames, triageUpstream } from '../src/triage/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (name, detail = '') => { console.log(`  ✅ ${name}${detail ? ` (${detail})` : ''}`); pass += 1; };
const bad = (name, detail = '') => { console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`); fail += 1; };
const eq = (name, expected, actual) => {
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  if (e === a) ok(name, a);
  else bad(name, `期望 ${e} / 实得 ${a}`);
};

const channel = { label: '开发版通道', line: '0.1.6' };
const failCheck = (name) => ({ name, status: 'fail', detail: 'x' });
const probeOf = (errors, checks = [], extra = {}) => ({ errors, checks, hostFatal: [], profile: { flavor: 'modern' }, contract: {}, ...extra });
/** 宿主/环境侧信号：**结构化字段 + 人读日志**同时给（判据只许读前者）。 */
const probeHostFatal = (detail, checks = []) => probeOf([`fatal(host): ${detail}`], checks, { hostFatal: [detail] });

console.log('▶ 归因与契约采集离线回归（tests/test_attribution.mjs）');

// ---- 1. 契约采集：接受型宿主必须立即卸载（🔴-A 根因） ----
console.log('  [1] collectContract 采集后立即卸载（🔴-A 根因）');
{
  const registered = [];
  const accepting = {
    register(definition) {
      registered.push(definition.name);
      return () => { const i = registered.indexOf(definition.name); if (i >= 0) registered.splice(i, 1); };
    },
    schemas: () => registered.map((name) => ({ name })),
  };
  const collected = collectContract(accepting);
  eq('接受型宿主：保留名被记 ACCEPTED(unexpected)（漂移如实上报）', 'ACCEPTED(unexpected)', collected.contract.reservedName);
  eq('接受型宿主：采集后宿主无残留工具', [], registered);
  eq('接受型宿主：residue 为空（探针据此判 contract.probe_disposed 通过）', [], collected.residue);
  eq('接受型宿主：所有被接受的探测均产出并调用 disposer', true, collected.probes.filter((p) => p.accepted).every((p) => p.disposed));

  const rejecting = {
    reg: [],
    register(definition) {
      if (definition.name === 'run_code') throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport');
      this.reg.push(definition.name);
      return () => { const i = this.reg.indexOf(definition.name); if (i >= 0) this.reg.splice(i, 1); };
    },
    schemas() { return this.reg.map((name) => ({ name })); },
  };
  const rejected = collectContract(rejecting);
  eq('拒绝型宿主：保留名措辞原样入指纹', true, String(rejected.contract.reservedName).includes('reserved'));
  eq('拒绝型宿主：无任何注册残留', [], rejecting.reg);
  eq('拒绝型宿主：无 disposer 也不报残留', [], rejected.residue);
}

// ---- 2. 归因：宿主侧 / 插件侧互不串味 ----
console.log('  [2] 归因判据（宿主侧结构化 hostFatal[] vs 插件侧 check）');
eq('宿主安装失败（npm ETARGET，hostFatal[]）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeHostFatal('宿主依赖安装失败（npm）：npm ERR! code ETARGET'), channel, 'dev'));
eq('离线缺缓存（hostFatal[]）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeHostFatal('离线模式下缺少宿主依赖缓存（先联网跑一次或去掉 --offline）'), channel, 'dev'));
eq('宿主未就绪 → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure({ errors: ['host.tools_ready: ctx.tools 未就绪'], checks: [failCheck('host.tools_ready')], profile: { flavor: 'unknown' } }, channel, 'dev'));
eq('契约探测未卸载（宿主 register 语义变了）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['contract.probe_disposed: 契约探测残留 run_code'], [failCheck('contract.probe_disposed')]), channel, 'dev'));
eq('宿主侧致命错误**只认结构化字段**：仅有日志文本、无 hostFatal[] → 不判漂移', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['fatal(host): 只是日志里出现过这个词'], [failCheck('registry.exact')]), channel, 'dev'));
eq('工具清单不符 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['registry.exact: 期望 a / 实得 b'], [failCheck('registry.exact')]), channel, 'dev'));
eq('dispatch 失败 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['dispatch.execute_ok: Error'], [failCheck('dispatch.execute_ok')]), channel, 'dev'));
eq('无失败 check（探针被外力打断）→ UNKNOWN（不猜、不甩锅）', 'UNKNOWN',
  attributeFailure(probeOf(['探针非零退出（status=null）']), channel, 'dev'));

// ---- 3. 🔴-B 回归：路径含 npm / 插件侧 fatal: 措辞不得翻案 ----
console.log('  [3] 🔴-B 回归（裸关键词误判）');
eq('🔴-B：错误串含 /home/runner/.npm/ 路径 + 插件侧失败 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(
    ['plugin.apply_ok: 插件 apply(ctx) 抛错（插件侧初始化失败）：Error: 配置缺失 | at file:///home/runner/.npm/_npx/abc/node_modules/probe.mjs:1:1'],
    [failCheck('plugin.apply_ok')],
  ), channel, 'dev'));
eq('🔴-B：插件语法错误（旧措辞裸 fatal:）→ PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['plugin.loaded: 插件 import 失败（语法/依赖错误）：SyntaxError: Unexpected identifier | fatal: 旧措辞不得翻案'], [failCheck('plugin.loaded')]), channel, 'dev'));
eq('🔴-B：插件 apply 抛错 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['plugin.apply_ok: 插件 apply(ctx) 抛错'], [failCheck('plugin.apply_ok')]), channel, 'dev'));
eq('🔴-B：插件未导出 apply → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['plugin.loaded: 插件未导出 apply(ctx)'], [failCheck('plugin.loaded')]), channel, 'dev'));
eq('🔴-B：真宿主侧信号（hostFatal[]）仍判漂移（收窄判据不得丢掉真漂移）', 'UPSTREAM_DRIFT',
  attributeFailure(probeHostFatal('宿主装配失败：Cannot find package @deepseek-ai/dsh-tools'), channel, 'dev'));

// ---- 3.1 🔴-C：判据不得扫自由文本（fatal(host) 字面量出现在插件侧文本/路径） ----
console.log('  [3.1] 🔴-C 回归（自由文本含 fatal(host) 不得翻案）');
eq('🔴-C：插件 stack 路径含 /tmp/fatal(host)-dir/ → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(
    ['plugin.apply_ok: 插件 apply(ctx) 抛错（插件侧初始化失败）：Error: 缺少必需配置 | at Module.apply (file:///tmp/fatal(host)-dir/apply-throws.mjs:3:33)'],
    [failCheck('plugin.apply_ok')],
  ), channel, 'dev'));
eq('🔴-C：插件错误文本含 fatal(host) 字面量 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(
    ['plugin.loaded: 插件 import 失败（语法/依赖错误）：SyntaxError | 插件自述：fatal(host) is my favourite string'],
    [failCheck('plugin.loaded')],
  ), channel, 'dev'));
eq('🔴-C：CI 工作目录含 fatal(host)（hub 路径）→ PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(
    ['registry.exact: 期望 a / 实得 b | 探针工作目录 /home/runner/fatal(host)-hub'],
    [failCheck('registry.exact')],
  ), channel, 'dev'));
eq('🔴-C：宿主侧日志行同时存在时，仍以结构化字段为准（有 hostFatal[] → 漂移）', 'UPSTREAM_DRIFT',
  attributeFailure(probeHostFatal('宿主依赖安装失败（npm）', [failCheck('plugin.apply_ok')]), channel, 'dev'));

// ---- 4. 契约漂移相关性 ----
console.log('  [4] 契约漂移与失败点相关性');
eq('漂移字段与失败 check 相关 → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['guard.reserved_name: tool name "run_code" is reserved'], [failCheck('guard.reserved_name')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));
eq('漂移字段与失败 check 无关 → PLUGIN_REGRESSION（不把插件 bug 甩给上游）', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['registry.exact: 期望 a / 实得 b'], [failCheck('registry.exact')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'outputShape' }] } }));
eq('契约 check 失败且无可用基线 → 保守判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['compat.schema_flatten: unsupported ...'], [failCheck('compat.schema_flatten')]), channel, 'dev',
    { contractDrift: { changed: false, newBaseline: true } }));
eq('契约 check 失败但基线一致 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['guard.reserved_name: 插件声明了保留名'], [failCheck('guard.reserved_name')]), channel, 'dev',
    { contractDrift: { changed: false, newBaseline: false, items: [] } }));
// P2-6：上游取消保留名 + 插件自己声明保留名 → **不得**甩给上游（guard.reserved_rejected 不入相关性表）
eq('P2-6：reservedName 漂移 + 插件声明保留名 → PLUGIN_REGRESSION（不甩锅上游）', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['guard.reserved_rejected: 插件声明了 DSH 保留名 run_code'], [failCheck('guard.reserved_rejected')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));
eq('P2-6：reservedName 漂移 + 中台护栏自身失效（guard.reserved_name）→ 仍判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['guard.reserved_name: 插件侧未拒绝 run_code'], [failCheck('guard.reserved_name')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));
{
  const detail = attributionDetail(probeOf(['registry.exact: x'], [failCheck('registry.exact')]), channel, 'dev');
  eq('归因带可审计理由链', true, detail.reasons.length > 0 && detail.reasons[0].includes('registry.exact'));
  eq('旧版死判据不再出现', 'no-dead-criteria',
    /register\.count|register\.no_issues/.test(attributeFailure.toString()) ? 'dead-criteria-present' : 'no-dead-criteria');
}

// ---- 4b. 插件侧硬证据优先于漂移相关性（评审 🔴-C） ----
console.log('  [4b] 插件侧硬证据优先于漂移相关性（🔴-C）');
eq('硬证据清单精确到 guard.reserved_rejected（不含 guard.* 通配）', JSON.stringify(['guard.reserved_rejected']), JSON.stringify(PLUGIN_HARD_EVIDENCE));
eq('漂移窗口 + 插件声明保留名 → PLUGIN_REGRESSION（不被吞成漂移）', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['guard.reserved_rejected: 插件声明了 DSH 保留名 run_code'], [failCheck('guard.reserved_rejected')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));
{
  const detail = attributionDetail(probeOf(['guard.reserved_rejected: 插件声明了 DSH 保留名 run_code'], [failCheck('guard.reserved_rejected')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } });
  eq('硬证据理由链可审计（指明与漂移无关）', true, detail.reasons.some((reason) => reason.includes('guard.reserved_rejected') && reason.includes('漂移')));
}
// 反向护栏：中台自检 guard.reserved_name + 漂移 → 仍判漂移（不得过度修正）
eq('反向护栏：漂移窗口 + guard.reserved_name fail → 仍 UPSTREAM_DRIFT（中台自检，不算插件违规）', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['guard.reserved_name: tool name "run_code" is reserved'], [failCheck('guard.reserved_name')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));
// 反向护栏：同一漂移窗口内的插件侧业务失败仍判插件
eq('反向护栏：漂移窗口 + registry.exact fail → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
  attributeFailure(probeOf(['registry.exact: 期望 a / 实得 b'], [failCheck('registry.exact')]), channel, 'dev',
    { contractDrift: { changed: true, items: [{ field: 'reservedName' }] } }));

// ---- 4c. 反向护栏（评审 §四 5 例：收窄判据不得丢真漂移、不得过度修正） ----
console.log('  [4c] 反向护栏（§四：真漂移仍判漂移 / 精确性不回归）');
{
  const drift = (field) => ({ contractDrift: { changed: true, items: [{ field }], newBaseline: false } });
  eq('§四-1 schemaSubset 漂移 + compat.schema_flatten fail → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure(probeOf(['compat.schema_flatten: unsupported ...'], [failCheck('compat.schema_flatten')]), channel, 'dev', drift('schemaSubset')));
  eq('§四-2 outputShape 漂移 + dispatch.render_projected fail → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure(probeOf(['dispatch.render_projected: output.render 未产出 text 块'], [failCheck('dispatch.render_projected')]), channel, 'dev', drift('outputShape')));
  eq('§四-3 configProjection 漂移 + detect.flavor_known fail → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure(probeOf(['detect.flavor_known: unknown'], [failCheck('detect.flavor_known')]), channel, 'dev', drift('configProjection')));
  eq('§四-4 真 npm 装包失败（ETARGET，hostFatal[]）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure(probeHostFatal('宿主依赖安装失败（npm）：npm ERR! code ETARGET'), channel, 'dev'));
  eq('§四-5 离线缺缓存（hostFatal[]）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure(probeHostFatal('离线模式下缺少宿主依赖缓存'), channel, 'dev'));
  eq('§四-6 漂移窗口 + 健康插件（无失败项）→ 不进归因、不被 guard.* 误伤', 'UNKNOWN',
    attributeFailure(probeOf([], []), channel, 'dev', drift('reservedName')));
  eq('§四-7 guard.reserved_name fail + 漂移 → UPSTREAM_DRIFT（精确性未被过度修正）', 'UPSTREAM_DRIFT',
    attributeFailure(probeOf(['guard.reserved_name: tool name "run_code" is reserved'], [failCheck('guard.reserved_name')]), channel, 'dev', drift('reservedName')));
  eq('§四-7b guard.reserved_name 与 guard.reserved_rejected 未合并（各自独立判据）', true,
    attributeFailure(probeOf(['guard.reserved_name: reserved'], [failCheck('guard.reserved_name')]), channel, 'dev', drift('reservedName')) === 'UPSTREAM_DRIFT'
    && attributeFailure(probeOf(['guard.reserved_rejected: 声明保留名'], [failCheck('guard.reserved_rejected')]), channel, 'dev', drift('reservedName')) === 'PLUGIN_REGRESSION');
}

// ---- 5. CLI 参数契约（P2-1 / P2-2） ----
console.log('  [5] CLI 参数契约');
const throwsWith = (argv, pattern) => {
  try { parseArgs(argv); return 'no-throw'; } catch (error) { return pattern.test(error.message) ? 'ok' : `wrong-message:${error.message}`; }
};
eq('--channel 缺值 → 显式报错（不再静默跑三通道）', 'ok', throwsWith(['verify', '--channel'], /缺少取值/));
eq('--json 缺值 → 显式报错（不再静默不写文件）', 'ok', throwsWith(['verify', '--json'], /缺少取值/));
eq('--plugin 缺值 → 显式报错（不再在深处 TypeError）', 'ok', throwsWith(['verify', '--plugin'], /缺少取值/));
eq('--key=value 空值仍可用（显式给出空串不算缺值）', '', parseArgs(['verify', '--channel=']).channel);
eq('resolveChannels(undefined) 默认三通道', ALL_CHANNELS, resolveChannels(undefined));
eq('resolveChannels(undefined, [stable,dev]) 支持自定义默认（report 用）', ['stable', 'dev'], resolveChannels(undefined, ['stable', 'dev']));
eq('resolveChannels(legacy) 可用（report --channel legacy 不再被忽略）', ['legacy'], resolveChannels('legacy'));
eq('resolveChannels 未知默认值显式报错', 'ok', (() => { try { resolveChannels(undefined, ['nope']); return 'no-throw'; } catch (error) { return /未知通道/.test(error.message) ? 'ok' : `wrong:${error.message}`; } })());

// ---- 6. 缓存维护（P2-3：pruneHostCache 有真实调用点） ----
console.log('  [6] 缓存维护');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cache-'));
  try {
    mkdirSync(path.join(dir, 'stable-aaaaaaaaaaaa'), { recursive: true });
    mkdirSync(path.join(dir, 'dev-bbbbbbbbbbbb'), { recursive: true });
    const result = pruneHostCache({ cacheDir: dir, keepFingerprints: ['stable-aaaaaaaaaaaa'] });
    eq('保留当前指纹，清理历史残留', ['stable-aaaaaaaaaaaa'], readdirSync(dir));
    eq('清理项被如实上报', ['dev-bbbbbbbbbbbb'], result.removed);
    const registry = loadChannels(ROOT);
    eq('keepFingerprintsFor 与 registry 指纹同构', [`stable-${channelFingerprint(registry.channels.stable)}`], keepFingerprintsFor(registry).slice(0, 1));
    // 关键：保留的是「registry 全部通道」，不是「本次验收的通道」——否则
    // verify --channel stable --prune-cache 会顺手删掉 dev/legacy 缓存（下次白装一遍）
    eq('keepFingerprintsFor 默认覆盖全部通道（与本次验收通道无关）', 3, keepFingerprintsFor(registry).length);
    eq('keepFingerprintsFor 不接收 report（避免按本次通道裁剪）', 3, keepFingerprintsFor().length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 7. 判据表完备性（防「新增 check 未登记 → 归因退化成 UNKNOWN」） ----
console.log('  [7] 判据表完备性');
{
  const probeSource = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  const declared = [...probeSource.matchAll(/check\(\s*'([^']+)'/g)].map((m) => m[1]);
  const known = new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS]);
  const unregistered = [...new Set(declared)].filter((name) => !known.has(name));
  eq('探针声明的每个 check 都在归因表内（否则会退化成 UNKNOWN）', [], unregistered);
  eq('判据表无重复项', new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS]).size,
    HOST_SIDE_CHECKS.length + CONTRACT_SIDE_CHECKS.length + PLUGIN_SIDE_CHECKS.length);
  eq('宿主侧与插件侧 check 名不重叠', 0,
    HOST_SIDE_CHECKS.filter((name) => PLUGIN_SIDE_CHECKS.includes(name)).length);
  const runnerSource = readText(path.join(ROOT, 'src/verify/runner.mjs'), 'utf8');
  const runnerCode = runnerSource.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  eq('归因不再使用裸 npm / 裸 fatal: 判据', 'no-bare-keywords',
    /\/npm\||\|npm\||fatal:/.test(runnerCode) ? 'bare-keywords-present' : 'no-bare-keywords');
  // 🔴-C 守卫：判据代码里**不得**出现对 errors 自由文本的读取（含 HOST_FATAL_PREFIX 文本扫描）
  eq('🔴-C：归因代码不读 errors 自由文本', 'no-free-text-criteria',
    /errors\.(includes|match|test)|errors\.join|HOST_FATAL_PREFIX\)/.test(runnerCode) ? 'free-text-criteria-present' : 'no-free-text-criteria');
  eq('🔴-C：判据只读结构化字段 hostFatal', 'reads-structured-field',
    runnerCode.includes('HOST_FATAL_FIELD') ? 'reads-structured-field' : 'field-not-read');
  eq('归因返回值不再声明 ENV_ERROR', 'no-env-error',
    /ENV_ERROR/.test(runnerSource.split('@returns')[1]?.slice(0, 200) ?? '') ? 'env-error-declared' : 'no-env-error');
}

// ---- 7b. 文档判据表守卫：ARCHITECTURE §4.2 ③ 必须与唯一事实源口径一致 ----
// 为什么单独守：ARCHITECTURE.md 是归因契约的权威文档；它若回退到已删除的旧口径
// （「错误串含 fatal(host)」自由文本判据），后人照表改实现就是 🔴-C 原样复发。
// 过去 tests/ 对 ARCHITECTURE.md 的引用数 = 0（无防线），本节补上。
console.log('  [7b] ARCHITECTURE 归因判据表与唯一事实源一致（文档即防线）');
{
  const arch = readText(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const start = arch.indexOf('③ 归因契约');
  const end = start === -1 ? -1 : arch.indexOf('**④', start);
  const section = start === -1 || end === -1 ? '' : arch.slice(start, end);
  eq('ARCHITECTURE §4.2 ③ 归因契约段落存在', true, section.length > 0);
  // 第 1 条判据：必须只认结构化字段，**不得**回退到「错误串含 fatal(host)」自由文本口径（P1）
  eq('判据表不再写「错误串含 fatal(host)」（P1 旧口径已删）', 'no-free-text-criterion',
    /错误串含\s*`?fatal\(host\)/.test(section) ? 'free-text-criterion-present' : 'no-free-text-criterion');
  eq('判据表第 1 条显式引用结构化字段 hostFatal[] / HOST_FATAL_FIELD', true,
    /hostFatal\[\]/.test(section) && /HOST_FATAL_FIELD/.test(section));
  eq('判据表写明 errors[] 不参与任何判据', true, /任何判据不读/.test(section));
  eq('判据表声明唯一事实源 = src/harness/contract.mjs', true, section.includes('src/harness/contract.mjs'));
  // 「四条纪律」必须整块存在（v0.1.5 曾自述有、实际没有 —— P2-2 的落地验收）
  const discStart = section.indexOf('四条纪律');
  const disc = discStart === -1 ? '' : section.slice(discStart);
  eq('判据表含「四条纪律」小节（P2-2 自述已落地）', true, disc.length > 0);
  const discItems = [...disc.matchAll(/^>\s*([1-4])\.\s/gm)].map((m) => m[1]);
  eq('四条纪律四条齐全（1/2/3/4）', ['1', '2', '3', '4'], discItems);
  eq('纪律①明写 errors[] 不参与判据', true, /errors\[\]/.test(disc) && /任何判据不读/.test(disc));
  eq('纪律②明写硬证据优先于漂移相关性', true, /硬证据/.test(disc) && /漂移相关性/.test(disc));
  // 与唯一事实源导出的名单一致（表一改 / 名一改，这里就红）
  const missingHard = PLUGIN_HARD_EVIDENCE.filter((name) => !section.includes(name));
  eq('判据表 2b 行覆盖 PLUGIN_HARD_EVIDENCE 全部条目', [], missingHard);
  const missingHost = HOST_SIDE_CHECKS.filter((name) => !section.includes(name));
  eq('判据表第 1 条覆盖 HOST_SIDE_CHECKS 全部条目', [], missingHost);

  // --- 结构/行序断言（复测 🟠P1-新：段落级 includes 守不住「行序」与「整行删除」） ---
  // 为什么必须按**行**抽、按**行序**判：上轮 11 条断言全是段落级 `includes`，
  // 把 2b 行整行删掉、或把 2b 行挪到第 4 条之后，段落文本里仍有 `guard.reserved_rejected`
  // （prose 提到）→ 断言空转、优先级被静默反转（= 🔴-C 语义反转）。
  const rows = section.split('\n').filter((line) => /^\|\s*(\*\*)?\d/.test(line));
  const rowKeys = rows.map((line) => {
    const m = /^\|\s*(\*\*)?([0-9]+[a-z]?)\1?\s*\|/.exec(line);
    return m ? m[2] : null;
  }).filter(Boolean);
  eq('判据表按优先级键抽到行（含 2b）', true, rowKeys.includes('1') && rowKeys.includes('2b') && rowKeys.includes('3'));
  // 🟠P1-新-1 行序：2b 必须排在第 3 条**之前**（硬证据优先于漂移相关性）
  const i2b = rowKeys.indexOf('2b');
  const i3 = rowKeys.indexOf('3');
  eq('🟠P1-新：判据表行序 2b 必须排在 3 之前（硬证据优先）', true, i2b !== -1 && i3 !== -1 && i2b < i3);
  // 🟠P1-新-2 行级完整性：`^| **2b** |` 行**自身**必须带 guard.reserved_rejected（不是段落里别处出现）
  const row2b = rows.find((line) => /^\|\s*\*\*2b\*\*\s*\|/.test(line)) ?? '';
  eq('🟠P1-新：2b 行存在且行内声明 guard.reserved_rejected', true,
    row2b.includes('guard.reserved_rejected') && row2b.includes('PLUGIN_REGRESSION'));
  // 第 1 条同理：行内必须覆盖 HOST_SIDE_CHECKS 全部条目（整行删除 / 迁走后即红）
  const row1 = rows.find((line) => /^\|\s*1\s*\|/.test(line)) ?? '';
  eq('🟠P1-新：第 1 条行内覆盖 HOST_SIDE_CHECKS 全部条目', [],
    HOST_SIDE_CHECKS.filter((name) => !row1.includes(name)));
  eq('🟠P1-新：第 1 条行内显式引用 hostFatal[] 与 HOST_FATAL_FIELD', true,
    row1.includes('hostFatal[]') && row1.includes('HOST_FATAL_FIELD'));
  // 第 1 条行内不得回退到自由文本口径
  eq('🟠P1-新：第 1 条行内不含「错误串含 fatal(host)」旧口径', 'no-free-text-criterion',
    /错误串含\s*`?fatal\(host\)/.test(row1) ? 'free-text-criterion-present' : 'no-free-text-criterion');

  // --- 定位断言（🟡P2-新：段落级 includes 被第二处同句命中即逃逸） ---
  const lineOf = (predicate) => section.split('\n').find(predicate) ?? '';
  // 口径句必须与判据表**同一段落**（表格上方紧随的那一行），并写全两件事：
  // ① 只读结构化字段与 check 名；② errors[] 任何判据不读。段落级 includes 会被
  // 别处的同句命中而逃逸，故这里**按行定位**断言。
  const secLines = section.split('\n');
  const tableIdx = secLines.findIndex((line) => /^\|\s*优先级\s*\|/.test(line));
  // 取表格上方**最近的非空行**作为口径行（允许中间空行，但必须紧邻表格、不得被别的段落顶替）
  const calibLine = tableIdx > 0 ? [...secLines.slice(0, tableIdx)].reverse().find((line) => line.trim() !== '') ?? '' : '';
  eq('🟡P2-新：判据表口径行（紧邻表头之上，定位断言）写明只读结构化字段与 check 名', true,
    calibLine.includes('只读结构化字段') && calibLine.includes('check 名'));
  eq('🟡P2-新：判据表口径行（定位断言）写明 errors[] 任何判据不读', true,
    calibLine.includes('errors[]') && calibLine.includes('任何判据不读'));
  const factLine = lineOf((line) => /唯一事实源/.test(line) && /src\/harness\/contract\.mjs/.test(line));
  eq('🟡P2-新：唯一事实源声明在**同一行**给出（定位断言，防删句逃逸）', true,
    factLine.includes('src/harness/contract.mjs') && factLine.includes('唯一事实源'));
  // 纪律条目正文可能跨行（`>` 续行），按条目聚合后再做**条内**断言，
  // 避免「段落里别处出现同句」把断言架空。
  const discText = {};
  {
    let cur = null;
    for (const raw of disc.split('\n')) {
      const m = /^>\s*([1-4])\.\s(.*)$/.exec(raw);
      if (m) { cur = m[1]; discText[cur] = m[2]; continue; }
      const cont = /^>\s?(.*)$/.exec(raw);
      if (cur && cont) discText[cur] += ' ' + cont[1];
    }
  }
  eq('纪律①（定位：该条行内）写明 errors[] 不参与判据', true,
    (discText['1'] ?? '').includes('errors[]') && (discText['1'] ?? '').includes('任何判据不读'));
  eq('纪律②（定位：该条行内）写明硬证据优先于漂移相关性', true,
    (discText['2'] ?? '').includes('PLUGIN_HARD_EVIDENCE') && /优先于/.test(discText['2'] ?? ''));
  // 🟠P1-新-2（v0.1.7）：纪律③ 断言曾写成 `(discText['3'] ?? '').includes('一一对应')`——
  // **单值 includes = 非定位断言**：它只问「这两字在不在」，删掉「必须…才判」的条件语义、
  // 或把「一一对应」换成同义改写，断言照样绿。现改为**成对**断言：
  // 「漂移字段」+「失败 check」+「一一对应」三者**同一纪律条目内**同时出现，且不得退回
  // 「有漂移即判」（= 把插件 bug 甩给上游的旧口径），并给出理由。
  const disc3 = discText['3'] ?? '';
  eq('🟠P1-新-2：纪律③ 条内同时写明「漂移字段」+「失败 check」+「一一对应」', true,
    disc3.includes('漂移字段') && disc3.includes('失败 check') && disc3.includes('一一对应'));
  eq('🟠P1-新-2：纪律③ 条内写明判定条件（才判上游漂移）与理由（不把插件 bug 甩给上游）', true,
    /才判上游漂移/.test(disc3) && /插件 bug|插件侧/.test(disc3));
  eq('🟠P1-新-2：纪律③ 条内不得退回「有漂移即判」旧口径', 'no-loosened-wording',
    /有漂移即判|漂移即判上游/.test(disc3) ? 'loosened-wording-present' : 'no-loosened-wording');
  eq('纪律④（定位：该条行内）写明唯一事实源 contract.mjs', true,
    (discText['4'] ?? '').includes('src/harness/contract.mjs') && (discText['4'] ?? '').includes('唯一事实源'));

  // 🟠P1-新-?（v0.1.7）：上轮 M06「删唯一事实源声明句」**逃逸**，根因是本段断言用的是
  // `lineOf(predicate)` = 段内**首个**匹配行，而纪律④（line 28）也含
  // 「唯一事实源」+ `src/harness/contract.mjs` → 删掉正文声明句后由纪律④**顶包**，断言照绿。
  // 修正：把「正文声明句」与「纪律④」两处**分开定位、分别断言**（按纪律小节作为分界，
  // 声明句必须落在纪律小节**之前**），另加「同句必须点名唯一事实源 = 唯一事实源文件」的语义断言。
  const factLines = section.split('\n').filter((line) => /唯一事实源/.test(line) && /src\/harness\/contract\.mjs/.test(line));
  // 纪律小节起点：由此把段内切成「表格/声明区」与「纪律区」，两区各自至少 1 条命中
  const discHeaderLine = section.split('\n').findIndex((line) => /四条纪律/.test(line));
  const before = discHeaderLine === -1 ? section.split('\n') : section.split('\n').slice(0, discHeaderLine);
  // 只取「本表声明块」的行：以「判据表**唯一事实源**有两处」为锚，往下到纪律小节。
  // （段内别处也有 '唯一事实源 + contract.mjs' —— 如 🔴-D「写入端纪律」里的「归属路由的唯一事实源」，
  //  那是**另一条口径**，不应被算进本表的声明块，否则计数断言会被它顶包/干扰。）
  const declStart = before.findIndex((line) => /唯一事实源\*\*有两处|唯一事实源.*有两处/.test(line));
  const declBlock = declStart === -1 ? before : before.slice(declStart);
  const declLines = declBlock.filter((line) => /唯一事实源/.test(line));
  eq('🟠P1-新-?：判据表**正文**（纪律小节之前）独立给出「唯一事实源」声明句', true, declLines.length > 0);
  // 🟠P1-新-?（v0.1.7 二轮）：**每处各占一行、逐行断言**。
  // 上一版把两个事实源写在**同一行**、用 `/共用|唯一事实源口径/` 做行级 includes——
  // 删掉前一半的「探针与执行器共用」后，**同一行后文字段**里的「共用」（影响面报告共用）顶包 → 逃逸。
  // 教训：一行承载两个事实时，行级 includes 永远守不住其中任意一个。现在两处必须各自成行。
  const declContract = declLines.filter((line) => line.includes('src/harness/contract.mjs'));
  const declTriage = declLines.filter((line) => line.includes('src/triage/index.mjs') || line.includes('DRIFT_IMPACT'));
  eq('🟠P1-新-?：check 名单唯一事实源独立成行（contract.mjs）', 1, declContract.length);
  eq('🟠P1-新-?：contract.mjs 那行写全「唯一事实源」+「探针与执行器共用」+ 防漂移理由', true,
    declContract.some((line) => line.includes('唯一事实源') && /探针与执行器共用/.test(line) && /防两侧漂移/.test(line)));
  eq('🟠P1-新-?：漂移相关性表唯一事实源独立成行（triage/index.mjs 的 DRIFT_IMPACT）', 1, declTriage.length);
  eq('🟠P1-新-?：triage 那行写全「漂移相关性表」+「DRIFT_IMPACT」+ 共用户（执行器与影响面报告）', true,
    declTriage.some((line) => /漂移相关性表/.test(line) && line.includes('DRIFT_IMPACT') && /执行器与影响面报告共用/.test(line)));
  // 两处必须落在**不同行**（同一条命中两处 = 单条顶包，删任一处仍绿）
  eq('🟠P1-新-?：两处唯一事实源落在不同行（防单条顶包）', true, declContract.length > 0 && declTriage.length > 0 && declContract[0] !== declTriage[0]);
  // 🟠P1-新-?（v0.1.7 三轮）：**总起句**必须存在且写明「两处 + 各管一半 + 缺一即红」。
  // 二轮把两个事实源拆成子项后，总起句（「有两处，各管一半（缺一即红）」）可被整行删除而
  // 两个子项仍在 → 断言照绿（「拆行」把守点从「一处」变成「三处」，总起句漏守）。
  // 教训：拆行是必要的，但**拆出来的每一层都要有人守**，否则只是把活口挪了个位置。
  eq('🟠P1-新-?：总起句写明「两处 / 各管一半 / 缺一即红」（防整行删除）', true,
    before.some((line) => /唯一事实源/.test(line) && /有两处/.test(line) && /各管一半/.test(line) && /缺一即红/.test(line)));
  eq('🟠P1-新-?：纪律④ 条内同样给出唯一事实源（两处独立，不互相顶包）', true,
    (discText['4'] ?? '').includes('src/harness/contract.mjs') && (discText['4'] ?? '').includes('唯一事实源'));
  // 声明句与纪律④ 必须在**不同行**（同一条命中两处 = 纪律④ 顶包，删声明句后仍绿）
  eq('🟠P1-新-?：声明句与纪律④ 是两条独立行（防单条顶包）', true, factLines.length >= 2);
  // 2b 行必须在 3 行之前的**文档理由**也要在（防「改了顺序、理由段说谎」）
  const whyLine = lineOf((line) => /2b 为什么必须在 3 之前/.test(line));
  eq('2b 行序理由段存在且写明「在 3 之前」', true, whyLine.length > 0);
}

// ---- 7c. 漂移相关性表：唯一事实源（v0.1.7） ----
// 为什么守：v0.1.6 前，漂移相关性在 `verify/runner.mjs` 里是 **4 条手写 `||`**，
// 与 ARCHITECTURE 文档表、triage 影响面表**三处各自维护**——新增契约字段时静默漏判
// （漏判 = 漂移相关性弱于实际 → 插件 bug 可能被甩给上游）。现在唯一事实源 = `DRIFT_IMPACT`。
console.log('  [7c] 漂移相关性表唯一事实源（runner 不再硬编码 / 硬证据不入表）');
{
  const runnerCode = readText(path.join(ROOT, 'src/verify/runner.mjs'), 'utf8');
  const triageCode = readText(path.join(ROOT, 'src/triage/index.mjs'), 'utf8');

  // 1. runner 必须 import 唯一事实源，且**不得**再出现字段名字面量硬编码
  eq('runner 从 triage 引入 DRIFT_IMPACT（唯一事实源）', true,
    /import \{[^}]*DRIFT_IMPACT[^}]*\} from '\.\.\/triage\/index\.mjs'/.test(runnerCode));
  const hardCoded = DRIFT_FIELDS.filter((field) => new RegExp(`fields\\.has\\('${field}'\\)`).test(runnerCode));
  eq('runner 判定式不再硬编码任何登记字段（改一处即全生效）', [], hardCoded);
  // 2. 旧的前缀通配（dispatch.）不得回退：它会把「新增 dispatch 类字段」误判成漂移相关
  eq('runner 判定式不使用 dispatch. 前缀通配（回退即红）', false,
    runnerCode.includes("startsWith('dispatch.')"));

  // 3. 硬证据（PLUGIN_HARD_EVIDENCE）永不入漂移相关性表（🔴-C 防复发）
  const hardInTable = Object.values(DRIFT_IMPACT).flatMap((v) => v.checks).filter((n) => PLUGIN_HARD_EVIDENCE.includes(n));
  eq('🔴-C 防复发：DRIFT_IMPACT 不含 PLUGIN_HARD_EVIDENCE 任何条目', [], hardInTable);

  // 4. 表内 check 名必须在唯一事实源的 check 名单里（不新造名字）
  const knownChecks = new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS,
    'host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed',
    'guard.reserved_name', 'compat.schema_flatten', 'guard.reserved_rejected',
    'plugin.loaded', 'plugin.apply_ok', 'plugin.definitions_ok', 'registry.exact',
    'dispatch.execute_ok', 'dispatch.render_projected', 'dispatch.echo_payload', 'dispatch.abort_semantics',
    'lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose']);
  const unknownChecks = Object.values(DRIFT_IMPACT).flatMap((v) => v.checks).filter((n) => !knownChecks.has(n));
  eq('DRIFT_IMPACT 内 check 名均属唯一事实源名单（不新造）', [], unknownChecks);

  // 5. 判据只读结构化字段的纪律，在本模块产出的 advice 里也被显式声明（不得回灌判据）
  eq('triage 声明「人类排障建议不得回灌进 verify 判据」', true,
    triageCode.includes('不得**回灌进') || triageCode.includes('不得回灌进'));
}

// ---- 9. triage 上游影响面（v0.1.7 新能力：从「有没有漂移」推到「漂移到哪 / 影响谁 / 改哪」） ----
console.log('  [9] triage 上游漂移自动归因（影响面 + 迁移建议）');
{
  // 9a. 保留名漂移：新出现的保留名必须被显式点名（插件必须改名）
  eq('diffReservedNames：新出现保留名被识别', ['run_script'],
    diffReservedNames('tool name "run_code" is reserved for X', 'tool name "run_script" is reserved for X').appeared);
  eq('diffReservedNames：措辞无引号时兜底识别', ['run_script'],
    diffReservedNames('run_code is reserved', 'run_script is reserved').appeared);

  // 9b. 四类已登记字段 → 影响面 / 责任方 / 中台文件 必须齐备
  for (const field of DRIFT_FIELDS) {
    const [item] = classifyDrift({ items: [{ channel: 'dev', field, before: 'a', after: 'b' }] });
    eq(`classifyDrift(${field})：known=true 且给出受影响检查`, true, item.known === true && item.checks.length > 0);
    eq(`classifyDrift(${field})：点名中台要改的文件且文件真实存在`, true,
      item.hubFiles.length > 0 && item.hubFiles.every((f) => existsSync(path.join(ROOT, f))));
    eq(`classifyDrift(${field})：给出一步动作`, true, typeof item.action === 'string' && item.action.length > 10);
  }

  // 9c. 未登记字段：**不猜**（known=false），且不得给出「改插件」的建议
  const [unknownField] = classifyDrift({ items: [{ channel: 'dev', field: 'brandNewField', before: 'a', after: 'b' }] });
  eq('未登记字段 → known=false（不猜）', false, unknownField.known);
  eq('未登记字段 → 不给中台文件（不瞎指）', [], unknownField.hubFiles);
  eq('未登记字段 → 插件影响为「未知，不得据此改插件」', true, unknownField.pluginImpact.includes('未知'));

  // 9d. 汇总：版本漂移 + 契约漂移 → hubFiles / plugins / advice 齐备
  const triage = triageUpstream({
    report: { drift: [{ channel: 'dev', pkg: '@deepseek-ai/dsh-tools', pinned: '0.1.6-alpha.2', latest: '0.1.6-alpha.3' }] },
    contractDrift: { changed: true, items: [{ channel: 'dev', field: 'reservedName', before: 'tool name "run_code" is reserved', after: 'tool name "run_script" is reserved' }] },
  });
  eq('triage.hasDrift（版本漂移也算）', true, triage.hasDrift);
  eq('triage 汇总出中台要改的文件', true, triage.hubFiles.length > 0);
  eq('triage 汇总出插件义务（新增保留名 → 必须改名）', true, triage.plugins.some((t) => t.includes('必须')));
  eq('triage 版本漂移给出三步动作（bump → verify → 定向修）', 3, triage.versions[0].step.length);
  eq('triage 建议里写明「advice 不得回灌判据」', true, triage.advice.some((a) => a.includes('不得') && a.includes('判据')));

  // 9e. 无漂移：hasDrift=false 且给「无需动作」
  const calm = triageUpstream({ report: { drift: [] }, contractDrift: { changed: false, items: [] } });
  eq('无漂移 → hasDrift=false', false, calm.hasDrift);
  eq('无漂移 → 建议「无需动作」', true, calm.advice.some((a) => a.includes('无需动作')));
}

// ---- 8. 装配器：宿主/环境侧失败必须落结构化字段（离线缺缓存路径，无网可跑） ----
console.log('  [8] 装配器结构化宿主信号（runHostProbe 离线缺缓存）');
{
  const registry = loadChannels(ROOT);
  const emptyCache = mkdtempSync(path.join(tmpdir(), 'dsh-empty-cache-'));
  try {
    const probe = runHostProbe({
      channelName: 'stable',
      channel: registry.channels.stable,
      pluginPath: path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'),
      expectedTools: [],
      hubRoot: ROOT,
      cacheDir: emptyCache,
      offline: true,
    });
    eq('离线缺缓存：结构化 hostFatal[] 非空（判据依据）', true, Array.isArray(probe.hostFatal) && probe.hostFatal.length > 0);
    eq('离线缺缓存：errors[] 仍带人读日志前缀 fatal(host)', true, (probe.errors ?? []).some((e) => e.startsWith('fatal(host):')));
    eq('离线缺缓存：归因 = UPSTREAM_DRIFT（只读结构化字段即可判定）', 'UPSTREAM_DRIFT',
      attributeFailure(probe, registry.channels.stable, 'stable'));
    // 反向证明：把结构化字段清空（只留日志文本）→ 不再判漂移，说明判据**没有**偷偷读 errors
    eq('离线缺缓存：清空 hostFatal 后判据不再命中（证明未读 errors 文本）', 'UNKNOWN',
      attributeFailure({ ...probe, hostFatal: [] }, registry.channels.stable, 'stable'));
  } finally {
    rmSync(emptyCache, { recursive: true, force: true });
  }
}

// ---- 9. 🔴-D：探针顶层兜底按相位归因（插件侧异常绝不进 hostFatal[]） ----
console.log('  [9] 🔴-D 回归（相位化兜底 + 不变量守卫）');
{
  // 9.1 相位路由：唯一事实源 contract.mjs 的 probeFailureRoute()
  eq('🔴-D：host-assembly 相位 → 宿主侧（写 hostFatal[]）', JSON.stringify({ side: 'host', field: 'hostFatal' }), JSON.stringify(probeFailureRoute(PROBE_PHASE.HOST_ASSEMBLY)));
  eq('🔴-D：plugin-integration 相位 → 插件侧 check（不写 hostFatal[]）', JSON.stringify({ side: 'plugin', check: 'plugin.unexpected_exception' }), JSON.stringify(probeFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION)));
  eq('🔴-D：未知相位保守判插件侧（绝不写判据字段）', 'plugin', probeFailureRoute('some-unknown-phase').side);
  eq('🔴-D：插件侧兜底 check 名已登记进 PLUGIN_SIDE_CHECKS', true, PLUGIN_SIDE_CHECKS.includes(PLUGIN_PROBE_EXCEPTION_CHECK));

  // 9.2 写入端：插件侧异常带插件 stack → 仍不得进 hostFatal[]（不变量守卫，运行时级）
  const pluginStack = "TypeError: Cannot read properties of undefined (reading 'name') |     at get name (file:///tmp/plugin-side-throw/plugin.mjs:5:33)";
  const pluginPhaseOut = { checks: [], errors: [], hostFatal: [] };
  const routed = recordProbeException(pluginPhaseOut, PROBE_PHASE.PLUGIN_INTEGRATION, pluginStack);
  eq('🔴-D：插件集成相位的未预期异常 → 落插件侧 check', PLUGIN_PROBE_EXCEPTION_CHECK, pluginPhaseOut.checks[0]?.name);
  eq('🔴-D：插件集成相位的未预期异常 → hostFatal[] 为空（不变量）', 0, pluginPhaseOut.hostFatal.length);
  eq('🔴-D：插件集成相位 → 归因 PLUGIN_REGRESSION（不是上游漂移）', 'PLUGIN_REGRESSION',
    attributeFailure({ ...pluginPhaseOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));
  eq('🔴-D：插件集成相位 → 理由链指出插件侧 check', true,
    attributionDetail({ ...pluginPhaseOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev').reasons.some((r) => r.includes(PLUGIN_PROBE_EXCEPTION_CHECK)));
  eq('🔴-D：写入端回执 side=plugin（可审计）', 'plugin', routed.side);

  // 9.3 反向护栏：宿主装配相位的异常**仍须**判漂移（收窄写入端不得丢掉真漂移）
  const hostPhaseOut = { checks: [], errors: [], hostFatal: [] };
  recordProbeException(hostPhaseOut, PROBE_PHASE.HOST_ASSEMBLY, 'Cannot find package @deepseek-ai/dsh-tools');
  eq('🔴-D 反向：host-assembly 相位 → hostFatal[] 非空', true, hostPhaseOut.hostFatal.length > 0);
  eq('🔴-D 反向：host-assembly 相位 → 仍判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure({ ...hostPhaseOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));

  // 9.4 不变量守卫（源码级）：探针顶层 catch **不得**无条件调 pushHostFatal()
  const probeSrc = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  eq('🔴-D：探针顶层兜底走 recordProbeException（按相位归因）', true, /catch[\s\S]{0,900}recordProbeException\(out, phase/.test(probeSrc));
  eq('🔴-D：探针声明了相位状态并随段落切换', true, /PROBE_PHASE\.HOST_ASSEMBLY/.test(probeSrc) && /PROBE_PHASE\.PLUGIN_INTEGRATION/.test(probeSrc));
  eq('🔴-D：读插件侧数据的两处（tools.schemas / definitions.map）均在 try 内', true,
    /try \{[\s\S]{0,300}tools\.schemas\(\)/.test(probeSrc) && /try \{[\s\S]{0,300}definitions\.map\(/.test(probeSrc));
  // 顶层 catch 体内**代码**不得出现裸 pushHostFatal。
  // 🟡-1（本轮建议）：守卫从 `stripComments` 升级为 `codeOnly` + **按标识符**判——
  // 旧写法两个盲区：① 同行含 `//` 的字符串会把该行截断（守卫看不见 pushHostFatal(）；
  // ② 别名 `const pf = pushHostFatal` 不命中字面量。codeOnly 去注释 + 去字符串**文本**后按标识符判。
  const catchStart = probeSrc.lastIndexOf('try {\n  await run();');
  eq('🔴-D：探针顶层 catch 段落可定位（守卫不得空转）', true, catchStart !== -1);
  const catchBody = codeOnly(probeSrc.slice(catchStart));
  eq('🔴-D：顶层 catch 体内无裸 pushHostFatal（按标识符判，注释/字符串/别名均不误判/不漏判）', false,
    /\bpushHostFatal\b/.test(catchBody));
  eq('🔴-D：顶层 catch 体走 recordProbeException（按相位路由）', true, /\brecordProbeException\b/.test(catchBody));
  // 守卫自证：三种「写回裸 pushHostFatal」的写法必须全部命中（含旧写法漏掉的同行注释字符串）
  for (const [label, sample] of Object.entries({
    直接调用: 'catch (e) { pushHostFatal(out, x); }',
    同行注释字符串: "catch (e) { const s = 'x // y'; pushHostFatal(out, s); }",
    别名调用: 'const pf = pushHostFatal; catch (e) { pf(out, x); }',
  })) {
    const hit = /\bpushHostFatal\b/.test(codeOnly(sample)) || /\bpf\b/.test(codeOnly(sample));
    eq(`🟡-1 守卫自证：${label} 写法被抓到`, true, hit);
  }
  eq('🟡-1 守卫自证：注释里写 pushHostFatal 不误报（codeOnly 后不在视野内）', false,
    /\bpushHostFatal\b/.test(codeOnly('// 这里不得调 pushHostFatal\nconst a = 1;')));

  // 9.4b 夹具自检：夹具必须真的复现「读插件侧数据时抛错」——否则离线/E2E 的断言会空转
  for (const fixture of ['plugin-side-throw-plugin.mjs', 'plugin-registry-throw-plugin.mjs']) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    eq(`🔴-D 夹具 ${fixture}：getter 派生自未初始化字段（真的会抛 TypeError）`, true,
      /get (name|parameters)\(\)[\s\S]{0,200}this\.config/.test(src));
    eq(`🔴-D 夹具 ${fixture}：夹具自述期望 hostFatal 为空（不变量写在夹具里）`, true, src.includes('hostFatal[]'));
  }

  // 9.5 写入端硬化：只给 hostFatal 的调用方不得抛 TypeError（🟢 评审建议）
  let pushThrew = 'no-throw';
  try { pushHostFatal({ hostFatal: [] }, 'x'); } catch { pushThrew = 'threw'; }
  eq('🟢：pushHostFatal 对缺失 errors 的目标不抛错（写入端最不该炸）', 'no-throw', pushThrew);

  // 9.6 判据读取端归一：hostFatal 非数组（字符串）不得被当成漂移信号
  eq('🟢：hostFatal 为字符串时不判漂移（Array.isArray 归一）', 'PLUGIN_REGRESSION',
    attributeFailure({ errors: [], checks: [failCheck('registry.exact')], hostFatal: 'fatal(host): 文本不是结构化信号', profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));
  eq('🟢：hostFatal 含空白项时不判漂移（过滤空串）', 'PLUGIN_REGRESSION',
    attributeFailure({ errors: [], checks: [failCheck('registry.exact')], hostFatal: ['   '], profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));

  // 9.7 理由链可读性：宿主侧信号与插件侧失败同时存在时如实说明
  const mixed = attributionDetail({ errors: ['fatal(host): x'], checks: [failCheck('plugin.apply_ok')], hostFatal: ['宿主装配失败'], profile: { flavor: 'modern' }, contract: {} }, channel, 'dev');
  eq('🟢：同时存在插件侧失败时理由链补一句（不影响判决）', true,
    mixed.attribution === 'UPSTREAM_DRIFT' && mixed.reasons.some((r) => r.includes('同时') && r.includes('plugin.apply_ok')));
}

// ---- 10. P2-10：判据源码守卫加固（别名绕过也拦得住，且不误报注释/文案） ----
console.log('  [10] P2-10 判据源码守卫加固（别名绕过也拦得住）');
{
  const runnerSrc = readText(path.join(ROOT, 'src/verify/runner.mjs'), 'utf8');
  const judgeSrc = runnerSrc.slice(runnerSrc.indexOf('export function attributionDetail'));
  // codeOnly：去注释 + 去字符串/模板字面量**文本**（保留 ${...} 插值里的代码）
  const judgeCode = codeOnly(judgeSrc);
  // stripComments：只去注释（保留字符串内容，用于「不得出现某字面量」类断言）
  const judgeNoComments = stripComments(judgeSrc);
  // P2-10 教训：原守卫只认 \`errors.\` 前缀，别名（const logLines = probe.errors）可绕过，
  // 且注释里写「不读 errors」反而误报。现在按**标识符**判（codeOnly 后注释与文案都不在视野内）。
  eq('P2-10：判据代码不引用 errors（含别名赋值，codeOnly 后判标识符）', 'no-errors-ref',
    /\berrors\b/.test(judgeCode) ? 'errors-referenced' : 'no-errors-ref');
  eq('P2-10：判据代码不含 fatal(host) 字面量（含字符串字面量，stripComments 后判）', 'no-literal',
    /fatal\(host\)/.test(judgeNoComments) ? 'literal-present' : 'no-literal');
  eq('P2-10：判据代码不引用日志前缀常量 HOST_FATAL_PREFIX', 'no-prefix-const',
    /HOST_FATAL_PREFIX/.test(judgeCode) ? 'prefix-referenced' : 'no-prefix-const');
  eq('P2-10：判据代码只读结构化字段 HOST_FATAL_FIELD', 'reads-field',
    /HOST_FATAL_FIELD/.test(judgeCode) ? 'reads-field' : 'field-not-read');

  // 守卫自身的有效性自证：把三种「写回文本扫描」的写法喂给守卫，必须全部命中
  const bypassSamples = {
    '直接扫描': "if (probe.errors.includes('fatal(host)')) return 'drift';",
    '别名扫描': "const logLines = probe.errors; if (logLines.join('|').includes('fatal(host)')) return 'drift';",
    '模板插值扫描': "reasons.push(`${probe.errors.join('|')}`);",
  };
  for (const [label, sample] of Object.entries(bypassSamples)) {
    eq(`P2-10 守卫自证：${label} 写法被抓到`, true, /\berrors\b/.test(codeOnly(sample)));
  }
  eq('P2-10 守卫自证：注释里写 errors 不误报（去掉注释后判）', false, /\berrors\b/.test(codeOnly("// 本判据不读 errors\nconst a = 1;")));
  eq('P2-10 守卫自证：文案里写 errors 不误报（模板文本被剔除）', false, /\berrors\b/.test(codeOnly('reasons.push(`请人工看原始 errors`)')));

  // 主防线仍是行为反证：把 errors 换成抛错 getter，判据不得炸、也不得改判
  const trapped = {};
  Object.defineProperty(trapped, 'errors', { get() { throw new Error('判据读了 errors 自由文本'); } });
  let trapResult = 'threw';
  try {
    trapResult = attributeFailure({ ...trapped, checks: [failCheck('registry.exact')], hostFatal: [], profile: { flavor: 'modern' }, contract: {} }, channel, 'dev');
  } catch { trapResult = 'threw'; }
  eq('P2-10：判据对 errors 抛错 getter 无感（行为级反证，主防线）', 'PLUGIN_REGRESSION', trapResult);

  // 判据不得读 errors：反向证明——只给 errors 文本、不给结构化字段，不判漂移
  eq('P2-10：仅 errors 文本含 fatal(host)、hostFatal 为空 → 不判漂移', 'PLUGIN_REGRESSION',
    attributeFailure(probeOf(['fatal(host): 文本不算结构化信号'], [failCheck('registry.exact')]), channel, 'dev'));
}
// ---- 11. 进程边界守卫（异步活口 + 进程级 exit 出口收口；评审 §二） ----
console.log('  [11] 进程边界守卫（异步异常 / 进程 exit 出口 → 同一归属路由）');
{
  // 11.1 逃逸种类 → 归属路由（唯一事实源 contract.mjs）
  eq('边界：插件集成相位 + 未预期异常 → plugin.unexpected_exception', PLUGIN_PROBE_EXCEPTION_CHECK,
    probeFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION).check);
  eq('边界：插件集成相位 + 进程 exit → plugin.early_exit（与异常分开命名，排障可区分）', PLUGIN_PROBE_EXIT_CHECK,
    probeFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PROCESS_ESCAPE.PROCESS_EXIT).check);
  eq('边界：插件集成相位 + 挂住超时 → plugin.early_exit（第 4 个出口）', PLUGIN_PROBE_EXIT_CHECK,
    probeFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PROCESS_ESCAPE.TIMEOUT).check);
  eq('边界：插件集成相位 + 外部信号 → plugin.early_exit', PLUGIN_PROBE_EXIT_CHECK,
    probeFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PROCESS_ESCAPE.SIGNAL).check);
  eq('边界：宿主装配相位 + 进程 exit → 仍写 hostFatal[]（相位优先，收窄不得丢掉宿主侧）', 'host',
    probeFailureRoute(PROBE_PHASE.HOST_ASSEMBLY, PROCESS_ESCAPE.PROCESS_EXIT).side);
  eq('边界：plugin.early_exit 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）', true,
    PLUGIN_SIDE_CHECKS.includes(PLUGIN_PROBE_EXIT_CHECK));

  // 11.2 完成位：**只有** run() 正常返回才置真 → 逃逸路径不可能判 ok（防 §二 的假绿）
  eq('边界：完成位缺失 → ok 必为 false（没跑完不得判通过）', false,
    finalizeProbeResult({ checks: [], errors: [], [PROBE_COMPLETION_FIELD]: false }).ok);
  eq('边界：完成位为真且无错误 → ok=true', true,
    finalizeProbeResult({ checks: [], errors: [], [PROBE_COMPLETION_FIELD]: true }).ok);
  eq('边界：完成位为真但有错误 → ok=false（错误优先）', false,
    finalizeProbeResult({ checks: [], errors: ['x'], [PROBE_COMPLETION_FIELD]: true }).ok);

  // 11.3 单一写出点：逃逸路径仍须输出**全量**结构化结果（checks 不丢），且只写一次
  const writes = [];
  const escapeOut = { checks: [failCheck('plugin.apply_ok')], errors: ['plugin.apply_ok: x'], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
  const boundary = createProbeBoundary({ out: escapeOut, sink: { write: (chunk) => writes.push(chunk) }, exit: () => {} });
  boundary.recordEscape(PROCESS_ESCAPE.UNCAUGHT_EXCEPTION, 'Error: 插件异步抛错 | at apply');
  eq('边界：逃逸路径照常输出结构化结果（单行 marker）', 1, writes.filter((w) => w.startsWith(PROBE_MARKER)).length);
  const payload = JSON.parse(writes[0].slice(PROBE_MARKER.length));
  eq('边界：逃逸路径的 checks 不丢（结构完整）', 2, payload.checks.length);
  eq('边界：逃逸路径完成位为 false（不可能判 ok）', false, payload.ok);
  eq('边界：逃逸路径落插件侧 check（不写 hostFatal[]）', PLUGIN_PROBE_EXCEPTION_CHECK, payload.checks.at(-1).name);
  eq('边界：逃逸路径 hostFatal[] 仍为空（插件侧错误永不进判据字段）', 0, payload.hostFatal.length);
  eq('边界：逃逸实况进结构化结果（escapedBy）', PROCESS_ESCAPE.UNCAUGHT_EXCEPTION, payload[PROBE_ESCAPE_FIELD]);
  eq('边界：逃逸相位如实记录', PROBE_PHASE.PLUGIN_INTEGRATION, payload.phase);
  eq('边界：归因判 PLUGIN_REGRESSION（不是上游漂移）', 'PLUGIN_REGRESSION',
    attributeFailure(payload, channel, 'dev'));
  // 幂等：第二条逃逸（迟到的 reject）不得重复写出、不得翻案
  boundary.recordEscape(PROCESS_ESCAPE.UNHANDLED_REJECTION, 'Error: 迟到的拒绝');
  eq('边界：写出幂等（迟到逃逸不重复 emit）', 1, writes.length);

  // 11.4 进程 exit 出口：真实退出码保留（防钩子吞掉 exit(1) 语义），退出码一律 1（不吞失败）
  const exitWrites = [];
  const exitCodes = [];
  const exitOut = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
  const exitBoundary = createProbeBoundary({ out: exitOut, sink: { write: (c) => exitWrites.push(c) }, exit: (code) => exitCodes.push(code) });
  exitBoundary.recordEscape(PROCESS_ESCAPE.PROCESS_EXIT, '探针在跑完之前退出（exit code=0）', 0);
  const exitPayload = JSON.parse(exitWrites[0].slice(PROBE_MARKER.length));
  eq('边界：进程 exit 逃逸落 plugin.early_exit', PLUGIN_PROBE_EXIT_CHECK, exitPayload.checks.at(-1).name);
  eq('边界：真实退出码保留在结构化结果（排障不丢实况）', 0, exitPayload.escapeCode);
  eq('边界：钩子以退出码 1 结束（不吞失败语义）', 1, exitCodes.at(-1));
  eq('边界：插件 process.exit(0) **不得**判 ok（防假绿）', false, exitPayload.ok);

  // 11.4b 第 4 个出口（挂住超时）：看门狗在**宿主 kill 之前**收口
  //      （SIGTERM 不触发 exit 钩子 + timeout 路径丢弃被杀后 stdout —— 两条实测事实）
  {
    const wdWrites = [];
    const wdOut = { checks: [failCheck('plugin.loaded')], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
    const wdBoundary = createProbeBoundary({ out: wdOut, sink: { write: (c) => wdWrites.push(c) }, exit: () => {}, timeoutMs: 30 });
    eq('边界：看门狗随 install() 装上（阈值 > 0 时）', true, wdBoundary.armWatchdog());
    await new Promise((r) => setTimeout(r, 120));
    const wdPayload = JSON.parse(wdWrites[0].slice(PROBE_MARKER.length));
    eq('边界：看门狗超时 → 落 plugin.early_exit（插件挂住不得甩给上游）', PLUGIN_PROBE_EXIT_CHECK, wdPayload.checks.at(-1).name);
    eq('边界：看门狗超时 → hostFatal[] 仍为空', 0, wdPayload.hostFatal.length);
    eq('边界：看门狗超时 → 逃逸实况=timeout', PROCESS_ESCAPE.TIMEOUT, wdPayload[PROBE_ESCAPE_FIELD]);
    eq('边界：看门狗超时 → 阈值记进 escapeCode（排障可读）', 30, wdPayload.escapeCode);
    eq('边界：看门狗超时 → ok=false（完成位未置真，不假绿）', false, wdPayload.ok);
    eq('边界：看门狗超时 → 归因 PLUGIN_REGRESSION', 'PLUGIN_REGRESSION', attributeFailure(wdPayload, channel, 'dev'));
    // 阈值缺省 0 = 不装（离线/无超时场景不引入定时器）
    const offBoundary = createProbeBoundary({ out: { checks: [], errors: [], hostFatal: [] }, sink: { write: () => {} }, exit: () => {} });
    eq('边界：阈值缺省 0 → 不装看门狗（无超时场景零副作用）', false, offBoundary.armWatchdog());
    // 正常收口后看门狗不得翻案（卸载即清定时器）
    const cleanOut = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
    const cleanWrites = [];
    const cleanBoundary = createProbeBoundary({ out: cleanOut, sink: { write: (c) => cleanWrites.push(c) }, exit: () => {}, timeoutMs: 30 });
    const uninstall2 = cleanBoundary.install({
      on: (e, fn) => { (cleanBoundary._h ??= {})[e] = fn; },
      removeListener: () => {},
    });
    cleanOut[PROBE_COMPLETION_FIELD] = true;
    cleanBoundary.emit();
    uninstall2();
    await new Promise((r) => setTimeout(r, 80));
    eq('边界：正常收口后看门狗不翻案（卸载即清定时器）', 1, cleanWrites.length);
  }

  // 11.5 装钩子/卸钩子：假 process 上真实装配（离线可测，不必起子进程）
  const handlers = {};
  const fakeProcess = {
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    removeListener(event, fn) { handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn); },
  };
  const fakeWrites = [];
  const fakeOut = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
  const fakeBoundary = createProbeBoundary({ out: fakeOut, sink: { write: (c) => fakeWrites.push(c) }, exit: () => {} });
  const uninstall = fakeBoundary.install(fakeProcess);
  eq('边界：装了五个进程级钩子（uncaughtException / unhandledRejection / exit / SIGTERM / SIGINT）', 5,
    ['uncaughtException', 'unhandledRejection', 'exit', 'SIGTERM', 'SIGINT'].filter((e) => (handlers[e] ?? []).length === 1).length);
  handlers.unhandledRejection[0](new Error('插件未处理拒绝'));
  eq('边界：unhandledRejection 钩子 → 插件侧 check', PLUGIN_PROBE_EXCEPTION_CHECK, fakeOut.checks.at(-1).name);
  eq('边界：unhandledRejection 钩子 → hostFatal[] 为空', 0, fakeOut.hostFatal.length);
  eq('边界：unhandledRejection 钩子 → 实况记 unhandled-rejection', PROCESS_ESCAPE.UNHANDLED_REJECTION, fakeOut[PROBE_ESCAPE_FIELD]);
  uninstall();
  // 信号钩子：SIGTERM 不触发 exit 钩子（实测）→ 必须显式接，否则挂住场景仍有活口。
  // 用**新**边界（逃逸幂等：已 emit 的边界会忽略后续逃逸，复用会误判）。
  {
    const sigHandlers = {};
    const sigOut = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };
    const sigBoundary = createProbeBoundary({ out: sigOut, sink: { write: () => {} }, exit: () => {} });
    sigBoundary.install({ on: (e, fn) => { sigHandlers[e] = fn; }, removeListener: () => {} });
    sigHandlers.SIGTERM('SIGTERM');
    eq('边界：SIGTERM 钩子 → 落 plugin.early_exit', PLUGIN_PROBE_EXIT_CHECK, sigOut.checks.at(-1).name);
    eq('边界：SIGTERM 钩子 → hostFatal[] 为空', 0, sigOut.hostFatal.length);
    eq('边界：SIGTERM 钩子 → 实况记 signal', PROCESS_ESCAPE.SIGNAL, sigOut[PROBE_ESCAPE_FIELD]);
    eq('边界：SIGTERM 钩子 → 归因 PLUGIN_REGRESSION', 'PLUGIN_REGRESSION', attributeFailure(sigOut, channel, 'dev'));
  }
  eq('边界：卸载后钩子摘干净（离线测试不留全局副作用）', 0,
    ['uncaughtException', 'unhandledRejection', 'exit', 'SIGTERM', 'SIGINT'].reduce((n, e) => n + (handlers[e] ?? []).length, 0));

  // 11.6 源码守卫：探针写出点必须唯一（不得再出现裸 process.stdout.write 结果行）
  const probeSrc2 = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  const probeCode = codeOnly(probeSrc2);
  // 按**标识符**判（codeOnly 后注释与字符串都不在视野内，别名也拦得住）：
  // 探针不得再出现裸 `process.stdout.write`（写出点必须唯一，经 emitProbeResult）。
  eq('边界：探针结果写出点唯一（无裸 process.stdout.write）', 'single-write',
    /process\.stdout\.write/.test(probeCode) ? 'raw-write' : 'single-write');
  eq('边界：探针装了进程边界守卫', 'installed',
    /createProbeBoundary\(/.test(probeCode) && /boundary\.install\(\)/.test(probeCode) ? 'installed' : 'missing');
  eq('边界：探针完成位只在 run() 返回后置真（逃逸路径到不了）', true,
    /await run\(\);[\s\S]{0,200}PROBE_COMPLETION_FIELD\] = true/.test(probeCode));
  eq('边界：探针不再自算 ok（交由 finalizeProbeResult 完成位判定）', false,
    /out\.ok = out\.errors\.length === 0/.test(probeCode));
  eq('边界：装配器按唯一事实源的 marker 取值（不硬编码字面量）', true,
    /startsWith\(PROBE_MARKER\)/.test(codeOnly(readText(path.join(ROOT, 'src/harness/host.mjs'), 'utf8'))));

  // 11.7 真子进程实测：本仓 `contract.mjs` 的守卫在**真 node 进程**里也成立
  //      （离线可跑：不需要宿主缓存，只验证「异步异常 / exit → 照常输出结构化结果」）
  const childScript = path.join(tmpdir(), `dsh-boundary-${process.pid}.mjs`);
  writeFileSync(childScript, [
    `import { createProbeBoundary, PROBE_MARKER, PROBE_COMPLETION_FIELD } from '${pathToFileURL(path.join(ROOT, 'src/harness/contract.mjs')).href}';`,
    `import { PROBE_PHASE } from '${pathToFileURL(path.join(ROOT, 'src/harness/contract.mjs')).href}';`,
    `const out = { checks: [{ name: 'plugin.apply_ok', status: 'pass', detail: '' }], errors: [], hostFatal: [], phase: PROBE_PHASE.PLUGIN_INTEGRATION, [PROBE_COMPLETION_FIELD]: false };`,
    `const boundary = createProbeBoundary({ out });`,
    `boundary.install();`,
    `queueMicrotask(() => { throw new Error('子进程异步抛错'); });`,
    `setTimeout(() => { out[PROBE_COMPLETION_FIELD] = true; boundary.emit(); process.exit(0); }, 300);`,
    '',
  ].join('\n'), 'utf8');
  try {
    const result = spawnSync(process.execPath, [childScript], { encoding: 'utf8', timeout: 20_000 });
    const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith(PROBE_MARKER));
    eq('边界（真子进程）：异步抛错仍输出结构化结果（不再「悄悄死掉」）', true, Boolean(line));
    const childPayload = line ? JSON.parse(line.slice(PROBE_MARKER.length)) : {};
    eq('边界（真子进程）：逃逸 → 插件侧 check', PLUGIN_PROBE_EXCEPTION_CHECK, childPayload.checks?.at(-1)?.name);
    eq('边界（真子进程）：逃逸 → hostFatal[] 为空', 0, (childPayload.hostFatal ?? []).length);
    eq('边界（真子进程）：逃逸 → ok=false（完成位未置真）', false, childPayload.ok);
    eq('边界（真子进程）：退出码非 0（失败语义不被吞）', true, result.status !== 0);
  } finally {
    rmSync(childScript, { force: true });
  }

  // 11.8 夹具自检：三份新夹具必须真的复现对应逃逸形态（否则 E2E 断言会空转）
  for (const [fixture, pattern, label] of [
    ['async-throw-plugin.mjs', /queueMicrotask\(/, '微任务抛错'],
    ['async-reject-plugin.mjs', /void Promise\.reject\(/, '未处理拒绝'],
    ['exit-in-apply-plugin.mjs', /process\.exit\(0\)/, '进程 exit'],
    ['hang-in-apply-plugin.mjs', /new Promise\(\(\) => \{\}\)/, '挂住超时（第 4 个出口）'],
  ]) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    eq(`边界夹具 ${fixture}：真的复现「${label}」`, true, pattern.test(src));
    eq(`边界夹具 ${fixture}：自述期望 hostFatal 为空`, true, src.includes('hostFatal[]'));
  }
}
console.log();
console.log(`▶ 归因与契约采集离线回归结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
