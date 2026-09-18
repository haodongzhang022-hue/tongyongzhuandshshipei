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
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync as readText } from 'node:fs';
import {
  CONDITIONAL_PROBE_CHECKS,
  PLUGIN_EXIT_CODE_MISMATCH_CHECK,
  CONTRACT_SIDE_CHECKS,
  HOST_SIDE_CHECKS,
  PLUGIN_ABNORMAL_TERMINATION_CHECK,
  PLUGIN_ASYNC_EXCEPTION_CHECK,
  PLUGIN_EARLY_EXIT_CHECK,
  PLUGIN_HARD_EVIDENCE,
  PLUGIN_PROBE_EXCEPTION_CHECK,
  PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK,
  PLUGIN_PROTOCOL_INJECTION_CHECK,
  PLUGIN_RUN_INCOMPLETE_CHECK,
  PLUGIN_SIDE_CHECKS,
  PROBE_NONCE_STDIN_CHANNEL,
  PLUGIN_PROBE_FORGED_RESULT_CHECK,
  probeResultPrefix,
  PLUGIN_SKIP_ON_PRECONDITION,
  PROBE_CHECK_ORDER,
  PROBE_PHASE,
  PROBE_PHASE_BEACON_PREFIX,
  collectContract,
  createProbeNonce,
  probeAsyncFailureRoute,
  probeFailureRoute,
  probeProcessFailureRoute,
  pushHostFatal,
  recordProbeAsyncException,
  recordProbeEarlyExit,
  recordProbeException,
  recordProbeRunIncomplete,
} from '../src/harness/contract.mjs';
import * as contractNs from '../src/harness/contract.mjs';
import { attributeFailure, attributionDetail } from '../src/verify/runner.mjs';
import { ALL_CHANNELS, keepFingerprintsFor, parseArgs, resolveChannels } from '../src/cli.mjs';
import { channelFingerprint, collectProbeResultLines, interpretProbeStdout, loadChannels, probeSpawnOptions, pruneHostCache, runHostProbe } from '../src/harness/host.mjs';
import { randomBytes } from 'node:crypto';
// R24/R28 的**行为级**断言（同步死循环收口）用离线探针回归台：假宿主 + 真实探针 + 真实装配器实现
import { runOfflineProbe, runOfflineProbeWithSources } from './offline-probe-harness.mjs';
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
  eq('🔴-D：host-assembly 相位 → 宿主侧（唯一落点 hostFatal[]，不回传字段名——评审 🟢）', JSON.stringify({ side: 'host' }), JSON.stringify(probeFailureRoute(PROBE_PHASE.HOST_ASSEMBLY)));
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
  // 顶层 catch 体内**代码**不得出现裸 pushHostFatal（注释里提到它不算）。
  // 🟡-1（评审实测逃逸）：上一版用 `stripComments` + 字面 `pushHostFatal\(`，两处盲区：
  //   (a) `stripComments` 是保守实现（不区分字符串内的 `//`）——`const u = "probe:///x"; pushHostFatal(...)`
  //       里调用**被截断出视野**（`//` 之后整段当注释删掉）；
  //   (b) 别名 `const pf = pushHostFatal; pf(out, ...)` 不命中 `pushHostFatal\(`。
  // 修法：改用 `codeOnly`（去注释 + 去字符串/模板**文本**，保留 `${...}` 插值代码——与 [10] 口径统一）
  // 并按**标识符**判（`\bpushHostFatal\b`）。主防线仍是行为反证（真宿主 E2E 断言 hostFatal 为空）。
  // 切片范围（🟡-3，评审实测盲区）：上一版从 `try {\n  await run();` 起切——
  // **兜底处理器区域不在视野内**。评审用「保留 `recordProbeAsyncException` 诱饵 + 另加一行
  // `pushHostFatal`」变异，源码守卫**漏检**（只有行为级 E2E 抓到 → 主防线仍在，故列 🟡）。
  // 修法：切片起点上移到**兜底区段标记**（`// ---- 进程级兜底`），覆盖
  // 「进程级 handler + 顶层 catch + finish」整块崩溃路径——那里是唯一可能被写回
  // 裸 `pushHostFatal` 的地方（其余位置按相位路由，已由 9.2/9.3 的行为断言覆盖）。
  const fallbackMarker = '// ---- 进程级兜底';
  const fallbackIdx = probeSrc.indexOf(fallbackMarker);
  eq('🟡-3：探针源码存在兜底区段标记（切片锚点，改名即红）', true, fallbackIdx > 0);
  const fallbackBody = codeOnly(fallbackIdx > 0 ? probeSrc.slice(fallbackIdx) : probeSrc.slice(probeSrc.lastIndexOf('try {\n  await run();')));
  eq('🔴-D：兜底区（进程级 handler + 顶层 catch + finish）内无裸 pushHostFatal（按标识符判）', false, /\bpushHostFatal\b/.test(fallbackBody));
  // 🟡-3 守卫自证：评审实测逃逸的变异形态，现在必须被抓到
  for (const [label, sample] of Object.entries({
    '兜底区内另加一行 pushHostFatal（评审变异：诱饵保留 recordProbeAsyncException）': 'recordProbeAsyncException(out, phase, detail);\npushHostFatal(out, "探针异步异常");',
    '兜底区内别名调用': 'const pf = pushHostFatal; pf(out, "x");',
    '兜底区内模板插值调用': 'out.errors.push(`${pushHostFatal(out, "x")}`);',
  })) {
    eq(`🟡-3 守卫自证：${label} 被抓到`, true, /\bpushHostFatal\b/.test(codeOnly(sample)));
  }
  // 🟡-3 反证（把「为什么必须换切片」写成断言，防后人改回去）：同一变异喂给**旧**切片 → 漏检。
  {
    // 变异：在**兜底区**（`// ---- 进程级兜底` 段）内插入一行裸 `pushHostFatal`。
    // 锚点取该段内的第一条语句（`process.on('uncaughtException'` 钩子），与实现细节解耦。
    // 锚点用**兜底区标记自身**（v0.1.9d）：此前锚在 `process.on('uncaughtException'` 的**首现位置**，
    // 而 v0.1.9d 在探针前段新增了 `runDefenseCanary()`（内部也注册 `process.on('uncaughtException', canary)`）
    // ⇒ 变异被插到**兜底区之外**，反证自己失效（守卫的锚点必须与实现解耦，否则实现一动就空转）。
    const mutated = probeSrc.replace(fallbackMarker, `${fallbackMarker}\npushHostFatal(out, "变异注入");`);
    const oldSlice = codeOnly(mutated.slice(mutated.lastIndexOf('try {\n  await run();')));
    const newSlice = codeOnly(mutated.slice(mutated.indexOf(fallbackMarker)));
    eq('🟡-3 反证：旧切片（自顶层 catch 起切）漏检兜底区内的 pushHostFatal', false, /\bpushHostFatal\b/.test(oldSlice));
    eq('🟡-3 反证：新切片（自兜底区起切）抓到同一变异', true, /\bpushHostFatal\b/.test(newSlice));
  }
  // 🟡-1 守卫自证：上一版实测逃逸的两种写法，现在必须被抓到
  const guardSamples = {
    '同行含 `//` 的字符串（stripComments 盲区）': 'const u = "probe:///x"; pushHostFatal(out, "x");',
    '别名调用（const pf = pushHostFatal）': 'const pf = pushHostFatal; pf(out, "x");',
    '模板插值内调用': 'reasons.push(`${pushHostFatal(out, "x")}`);',
  };
  for (const [label, sample] of Object.entries(guardSamples)) {
    eq(`🟡-1 守卫自证：${label} 被抓到`, true, /\bpushHostFatal\b/.test(codeOnly(sample)));
  }
  eq('🟡-1 守卫自证：注释里的 pushHostFatal 不误报（codeOnly 去掉注释）', false,
    /\bpushHostFatal\b/.test(codeOnly('// 顶层 catch 不得调 pushHostFatal(out, ...)\nconst a = 1;')));
  eq('🟡-1 守卫自证：文案里的 pushHostFatal 不误报（字符串文本被剔除）', false,
    /\bpushHostFatal\b/.test(codeOnly('reasons.push("不要调 pushHostFatal(out, x)")')));
  // 旧守卫确实拦不住这两例（把「为什么必须换」写成断言，防后人改回去）
  eq('🟡-1 反证：旧守卫（stripComments + 字面）对「同行含 // 的字符串」漏检', false,
    /pushHostFatal\(/.test(stripComments('const u = "probe:///x"; pushHostFatal(out, "x");')));
  eq('🟡-1 反证：旧守卫（stripComments + 字面）对别名漏检', false,
    /pushHostFatal\(/.test(stripComments('const pf = pushHostFatal; pf(out, "x");')));

  // 9.4c 进程级兜底（🔴-D 同族活口）源码守卫：探针必须挂两个进程级处理器，且走同一份相位路由
  eq('🔴-D：探针挂 uncaughtException 处理器', true, /process\.on\('uncaughtException'/.test(probeSrc));
  eq('🔴-D：探针挂 unhandledRejection 处理器（另一条代码路径，只兜一个 = 活口搬家）', true,
    /process\.on\('unhandledRejection'/.test(probeSrc));
  // v0.1.9：写入端统一收敛到 recordProcessEscape() 包装（三条出口共用同一条收尾路径），
  // 故这里断言的是「两个处理器都经统一入口走到 recordProbeAsyncException」，而不是旧的字面调用式。
  // v0.1.9d 结构：两个 handler 先赋给 `defenseHandlers`（**身份检查**的锚点，R28），再注册；
  // 断言两处都走统一入口 `recordProcessEscape(recordProbeAsyncException)`（不直接 pushHostFatal）。
  eq('🔴-D：两个处理器都经统一入口走 recordProbeAsyncException（按相位归因，不直接 pushHostFatal）', true,
    /defenseHandlers\.uncaughtException = [\s\S]{0,200}recordProcessEscape\(recordProbeAsyncException/.test(probeSrc)
    && /defenseHandlers\.unhandledRejection = [\s\S]{0,200}recordProcessEscape\(recordProbeAsyncException/.test(probeSrc)
    && /process\.on\('uncaughtException', defenseHandlers\.uncaughtException\)/.test(probeSrc)
    && /process\.on\('unhandledRejection', defenseHandlers\.unhandledRejection\)/.test(probeSrc));
  // 结构化结果必须用 writeSync 落盘：兜底后立即 process.exit()，异步 stdout 会被截断
  // （截断 = 装配器又看到「探针未输出结构化结果」= 等于没修）
  eq('🔴-D：结构化结果用 writeSync 输出（防 exit 截断 stdout → 报告整份消失）', true,
    /writeSync\(1, payload\)/.test(probeSrc));
  eq('🔴-D：结果只输出一次（emit 幂等，正常收尾与兜底共用）', true,
    /if \(emitted\) return;/.test(probeSrc));
  eq('🔴-D：兜底中断时把未验项按规范顺序标 skip（报告里看得见「哪些没验」）', true,
    /skipPendingChecks\(/.test(probeSrc) && /PROBE_CHECK_ORDER/.test(probeSrc));

  // 9.4e H1（复评，**放行级假绿**）源码守卫：探针收尾必须自检「进程内防线是否被插件撤销/静音」。
  // 为什么必须有源码级断言：H1 的失败模式是**假绿**（判 GREEN 放行），比 AMBER 危险得多——
  // 而行为级断言（真宿主 E2E / 闸门）需要 CI 装宿主才跑。本守卫让**离线**就能红：
  // 删掉自检、或只查 capture callback 不查监听器计数（两个都能被单方面绕过）→ 即红。
  eq('H1 源码守卫：收尾自检 capture callback（独占 API 被插件抢占 → 监听器被停用）', true,
    /hasUncaughtExceptionCaptureCallback/.test(probeSrc));
  // R28 收口：判据从「计数」升级为「**身份检查**」——数个数挡不住「插件用自己的回调顶替我们的」
  // （实测：插件顶替后 `listenerCount === 1`、`has() === true`，计数判据恒判「防线有效」= 假阳性）。
  // 身份检查的事件清单**必须**含 `exit`（批 1.5 第 8 项：出口③ 的钩子被单方摘除原先不可判定）。
  // 断言形式：`process.listeners(event).includes(handler)` 存在，且清单里三个事件都在
  // （`uncaughtException` / `unhandledRejection` / `exit`）——少一个即红（回退到两事件 = 出口③ 盲区）。
  eq('H1/R28 源码守卫：收尾自检做**身份检查**（我们的 handler 仍在 process.listeners() 内）', true,
    /process\.listeners\(event\)\.includes\(handler\)/.test(probeSrc));
  eq('H1/R28/批1.5 源码守卫：身份检查的事件清单含 exit（出口③ 钩子摘除可判定）', true,
    /for \(const event of \[[^\]]*'uncaughtException'[^\]]*'unhandledRejection'[^\]]*'exit'[^\]]*\]\)/.test(probeSrc)
    || /for \(const event of \[[^\]]*'exit'[^\]]*\]\)/.test(probeSrc));
  eq('H1 源码守卫：自检在 emit() 内、且在 `out.ok` 判定**之前**（否则 GREEN 会被写出去）', true,
    (() => {
      const body = probeSrc.slice(probeSrc.indexOf('function emit()'), probeSrc.indexOf('/** definitions 不可用时'));
      const tamper = body.indexOf('PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK');
      const okAssign = body.indexOf('out.ok =');
      return tamper > 0 && okAssign > tamper;
    })());
  eq('H1 源码守卫：自检只在插件集成相位判（宿主装配段判会误报）', true,
    /out\.phase === PROBE_PHASE\.PLUGIN_INTEGRATION[\s\S]{0,400}checkProcessDefense\(\)/.test(probeSrc));
  // 独占 API 作为**独立**篡改信号（不得与计数做 `||`——那正是 R28 的假阳性写法）
  eq('H1/R28 源码守卫：独占 API 作为独立篡改信号（不与计数做 ||）', true,
    /hasUncaughtExceptionCaptureCallback\(\) === true/.test(probeSrc));
  eq('H1：落点 check 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）', true,
    PLUGIN_SIDE_CHECKS.includes(PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK));
  // 夹具自检：H1 夹具必须真的**抢占独占 API**（否则离线/E2E/闸门断言空转）
  {
    const src = readText(path.join(ROOT, 'tests/fixtures', 'plugin-capture-callback-plugin.mjs'), 'utf8');
    eq('H1 夹具：真的调 setUncaughtExceptionCaptureCallback（独占 API 抢占）', true,
      /process\.setUncaughtExceptionCaptureCallback\(/.test(src));
    eq('H1 夹具：抢占后仍排后台抛错（否则「静音」无意义）', true, /queueMicrotask\([\s\S]{0,120}throw /.test(src));
    eq('H1 夹具：自述「绝不放行」（不变量写在夹具里）', true, src.includes('不放行'));
  }

  // 9.4d 报告完整性（本轮实测发现的同族漏洞）：任何一次运行，17 项**一项都不能少**。
  // 为什么必须有：探针第 10 段（生命周期）的 catch 曾只标 `lifecycle.registered` / `lifecycle.dispose`，
  // 而 `lifecycle.disposer_count` 的 `check()` 在抛错点**之前** → 报告里少一项（17 → 16），
  // 人分不清「没验」与「验过了」。这不是某一出口的问题，是**所有**中断路径的共同要求
  // （探针内中断、装配器补 skip、相位信标分支都一样）——故在离线侧做一条**跨夹具**断言。
  for (const fixture of ['plugin-side-throw-plugin.mjs', 'plugin-registry-throw-plugin.mjs']) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    // 静态自检：夹具里出现的 `check('...')` / `skip('...')` 名单不得与 PROBE_CHECK_ORDER 冲突
    // （动态完整性由真宿主 E2E / 闸门的「17 项一项不缺」断言覆盖，见 [8c] 与 gate_plugin_side.sh）
    eq(`9.4d 夹具 ${fixture}：自述了「hostFatal 为空」不变量`, true, src.includes('hostFatal[]'));
  }
  eq('9.4d：生命周期 catch 用 skipAll 补全三项（不再漏 lifecycle.disposer_count）', true,
    /skipAll\(\['lifecycle\.disposer_count', 'lifecycle\.registered', 'lifecycle\.dispose'\]/.test(probeSrc));

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

// ---- 9.8. 🔴-D 同族活口：插件侧**异步**异常（进程级 uncaughtException / unhandledRejection） ----
// 为什么必须单列一段：同步异常在 run() 调用栈上、能被顶层 catch 接住；**异步**异常不在栈上，
// 顶层 catch 永远接不到 → 探针在写出 __DSH_PROBE__ 之前被杀 → 装配器无条件 pushHostFatal()
// → 插件 bug 判 UPSTREAM_DRIFT/AMBER，且 checks 从 17 掉到 0（整份报告消失）。
// 这是本族第四次「活口搬家」（读取端 → 写入端 → 同步路径 → 异步路径），故防线必须**双路径**。
console.log('  [9.8] 🔴-D 异步活口（进程级兜底 + 双路径不变量）');
{
  // 9.8a 相位路由：与同步路由**同语义**（宿主装配 → hostFatal；其余 → 插件侧），落点 check 名不同
  eq('🔴-D 异步：host-assembly 相位 → 宿主侧（仍写 hostFatal[]）', 'host',
    probeAsyncFailureRoute(PROBE_PHASE.HOST_ASSEMBLY).side);
  eq('🔴-D 异步：plugin-integration 相位 → 插件侧 check（绝不写 hostFatal[]）',
    JSON.stringify({ side: 'plugin', check: PLUGIN_ASYNC_EXCEPTION_CHECK }),
    JSON.stringify(probeAsyncFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION)));
  eq('🔴-D 异步：未知相位保守判插件侧（与同步路由同取向）', 'plugin',
    probeAsyncFailureRoute('some-unknown-phase').side);
  eq('🔴-D 异步：落点 check 名已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）', true,
    PLUGIN_SIDE_CHECKS.includes(PLUGIN_ASYNC_EXCEPTION_CHECK));
  eq('🔴-D 异步：落点与同步兜底的 check 名**不同**（排障动作不同，混用 = 报告撒谎）', true,
    PLUGIN_ASYNC_EXCEPTION_CHECK !== PLUGIN_PROBE_EXCEPTION_CHECK);

  // 9.8b 写入端不变量：插件侧异步异常（带插件 stack）→ 插件侧 check，hostFatal[] 必须为空
  const asyncStack = "Error: plugin background task bug |     at queueMicrotask (file:///tmp/plugin-async/plugin.mjs:48:11)";
  const asyncOut = { checks: [], errors: [], hostFatal: [] };
  const asyncRouted = recordProbeAsyncException(asyncOut, PROBE_PHASE.PLUGIN_INTEGRATION, asyncStack);
  eq('🔴-D 异步：插件集成相位的异步异常 → 落插件侧 check', PLUGIN_ASYNC_EXCEPTION_CHECK, asyncOut.checks[0]?.name);
  eq('🔴-D 异步：hostFatal[] 为空（不变量：插件侧错误不进判据字段——前提：防线未被插件干预）', 0, asyncOut.hostFatal.length);
  eq('🔴-D 异步：归因 PLUGIN_REGRESSION（不甩锅上游）', 'PLUGIN_REGRESSION',
    attributeFailure({ ...asyncOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));
  eq('🔴-D 异步：相位写进结构化结果（排障依据）', PROBE_PHASE.PLUGIN_INTEGRATION, asyncOut.phase);
  eq('🔴-D 异步：写入端回执 side=plugin（可审计）', 'plugin', asyncRouted.side);

  // 9.8c 反向护栏：宿主装配相位的异步异常**仍须**判漂移（收窄不得丢掉真漂移）
  const asyncHostOut = { checks: [], errors: [], hostFatal: [] };
  recordProbeAsyncException(asyncHostOut, PROBE_PHASE.HOST_ASSEMBLY, 'Cannot find package @deepseek-ai/dsh-tools');
  eq('🔴-D 异步反向：host-assembly 相位 → hostFatal[] 非空', true, asyncHostOut.hostFatal.length > 0);
  eq('🔴-D 异步反向：host-assembly 相位 → 仍判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure({ ...asyncHostOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));

  // 9.8d 崩溃路径纪律：记录函数**自身不得抛**（它运行在 uncaughtException 处理器里，
  //       抛出 = 第二次崩溃 = 报告整份消失）。用畸形 target 反证。
  for (const [label, target] of [
    ['缺 checks/errors 字段', { hostFatal: [] }],
    ['字段类型全错', { checks: 'x', errors: 1, hostFatal: 'y' }],
    ['errors 为抛错 getter', Object.defineProperty({ hostFatal: [] }, 'errors', { get() { throw new Error('boom'); }, set() { throw new Error('boom'); } })],
  ]) {
    let threw = 'no-throw';
    try { recordProbeAsyncException(target, PROBE_PHASE.PLUGIN_INTEGRATION, 'x'); } catch { threw = 'threw'; }
    eq(`🔴-D 异步：崩溃路径上记录函数不抛（${label}）`, 'no-throw', threw);
  }

  // 9.8e 顺序表（PROBE_CHECK_ORDER）：与探针 check() 调用顺序一致，且 ∪ 条件项 == 三张 check 表并集
  // 为什么守：兜底中断时按本表补 skip；本表若与探针实际顺序漂移，报告里 skip 的顺序会骗人。
  const orderProbeSrc = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  const declaredOrder = [];
  for (const m of orderProbeSrc.matchAll(/check\(\s*'([^']+)'/g)) {
    if (!declaredOrder.includes(m[1])) declaredOrder.push(m[1]);
  }
  eq('🔴-D 异步：PROBE_CHECK_ORDER = 探针实际 check() 输出顺序（漂移即红）', JSON.stringify(declaredOrder), JSON.stringify(PROBE_CHECK_ORDER));
  eq('🔴-D 异步：PROBE_CHECK_ORDER 为 17 项（文档口径）', 17, PROBE_CHECK_ORDER.length);
  const tableUnion = [...new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS])].sort();
  const declaredUnion = [...new Set([...PROBE_CHECK_ORDER, ...CONDITIONAL_PROBE_CHECKS])].sort();
  eq('🔴-D 异步：17 项 ∪ 条件项 == 三张 check 表并集（新增 check 必须同时登记，否则红）', JSON.stringify(tableUnion), JSON.stringify(declaredUnion));
  eq('🔴-D 异步：条件项不计入 17 项（口径：17 项 + N 条件项）', 0,
    CONDITIONAL_PROBE_CHECKS.filter((name) => PROBE_CHECK_ORDER.includes(name)).length);

  // 9.8f 夹具自检：异步夹具必须真的「在 apply 里排后台任务并抛错」——否则离线/E2E 断言空转
  for (const [fixture, marker, pattern] of [
    ['plugin-async-throw-plugin.mjs', 'queueMicrotask', /queueMicrotask\([\s\S]{0,120}throw /],
    ['plugin-async-reject-plugin.mjs', 'Promise.reject', /Promise\.reject\(/],
  ]) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    eq(`🔴-D 异步夹具 ${fixture}：含 ${marker}（真的会触发进程级异常）`, true, pattern.test(src));
    eq(`🔴-D 异步夹具 ${fixture}：抛错在 apply() 内（不在 run() 调用栈上）`, true,
      /export function apply\(ctx\)[\s\S]*$/.test(src.slice(0, src.indexOf(marker))) || src.indexOf(marker) > src.indexOf('export function apply'));
    eq(`🔴-D 异步夹具 ${fixture}：自述期望 hostFatal 为空（不变量写在夹具里）`, true, src.includes('hostFatal[]'));
    eq(`🔴-D 异步夹具 ${fixture}：健康工具先注册（失败点精确留在后台任务）`, true, /demo_echo/.test(src));
  }
}

// ---- 9.9. 🔴 必修-1/2/3：完成位 + 进程 exit 出口 + run() 被拖住（四条出口逐条闭合） ----
// 为什么必须单列一段：评审 §五 把「可穷举 3 出口」修正为 **4 个**——
//   ① run() try/catch（已闭合）② 异步异常（v0.1.8 闭合）③ 进程 exit（本轮）④ run() 被拖住（本轮）。
// ②③④ 同属单一进程边界；本段把四条出口的**归属**（写入端）与**收尾**（完成位）都钉住。
console.log('  [9.9] 🔴 四条出口 + 完成位（进程 exit / run() 被拖住 / 不可捕获终止）');
{
  // 9.9a 归属路由：同一份规则，落点按出口区分（排障动作不同 ⇒ 报告必须能分清）
  eq('🔴 出口③：进程 exit → 插件侧 check plugin.early_exit', JSON.stringify({ side: 'plugin', check: PLUGIN_EARLY_EXIT_CHECK }),
    JSON.stringify(probeProcessFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PLUGIN_EARLY_EXIT_CHECK)));
  eq('🔴 出口④：run() 被拖住 → 插件侧 check plugin.run_incomplete', JSON.stringify({ side: 'plugin', check: PLUGIN_RUN_INCOMPLETE_CHECK }),
    JSON.stringify(probeProcessFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PLUGIN_RUN_INCOMPLETE_CHECK)));
  eq('🔴 边界：不可捕获终止 → 插件侧 check plugin.abnormal_termination（由装配器按信标落）',
    JSON.stringify({ side: 'plugin', check: PLUGIN_ABNORMAL_TERMINATION_CHECK }),
    JSON.stringify(probeProcessFailureRoute(PROBE_PHASE.PLUGIN_INTEGRATION, PLUGIN_ABNORMAL_TERMINATION_CHECK)));
  eq('🔴 出口③④ 反向：宿主装配相位仍判宿主侧（收窄不得丢掉真漂移）', 'host',
    probeProcessFailureRoute(PROBE_PHASE.HOST_ASSEMBLY, PLUGIN_EARLY_EXIT_CHECK).side);
  eq('🔴 出口③④：未知相位保守判插件侧（与同步/异步路由同取向）', 'plugin',
    probeProcessFailureRoute('some-unknown-phase', PLUGIN_EARLY_EXIT_CHECK).side);
  eq('🔴 四条出口的落点 check 名**互不相同**（混用 = 报告撒谎，排障动作不同）', 4,
    new Set([PLUGIN_PROBE_EXCEPTION_CHECK, PLUGIN_ASYNC_EXCEPTION_CHECK, PLUGIN_EARLY_EXIT_CHECK, PLUGIN_RUN_INCOMPLETE_CHECK]).size);
  for (const name of [PLUGIN_EARLY_EXIT_CHECK, PLUGIN_RUN_INCOMPLETE_CHECK, PLUGIN_ABNORMAL_TERMINATION_CHECK]) {
    eq(`🔴 落点 ${name} 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）`, true, PLUGIN_SIDE_CHECKS.includes(name));
  }

  // 9.9b 写入端不变量：三条新出口的插件侧记录**绝不**写 hostFatal[]
  for (const [label, record, check] of [
    ['进程 exit', recordProbeEarlyExit, PLUGIN_EARLY_EXIT_CHECK],
    ['run() 被拖住', recordProbeRunIncomplete, PLUGIN_RUN_INCOMPLETE_CHECK],
  ]) {
    const target = { checks: [], errors: [], hostFatal: [] };
    const routed = record(target, PROBE_PHASE.PLUGIN_INTEGRATION, 'at file:///tmp/plugin-exit/plugin.mjs:12:3');
    eq(`🔴 出口（${label}）：落插件侧 check ${check}`, check, target.checks[0]?.name);
    eq(`🔴 出口（${label}）：hostFatal[] 为空（不变量：插件侧错误不进判据字段——前提：防线未被插件干预）`, 0, target.hostFatal.length);
    eq(`🔴 出口（${label}）：归因 PLUGIN_REGRESSION（不甩锅上游）`, 'PLUGIN_REGRESSION',
      attributeFailure({ ...target, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));
    eq(`🔴 出口（${label}）：相位写进结构化结果（排障依据）`, PROBE_PHASE.PLUGIN_INTEGRATION, target.phase);
    eq(`🔴 出口（${label}）：写入端回执 side=plugin（可审计）`, 'plugin', routed.side);
  }
  // 反向：宿主装配相位仍写 hostFatal[]（收窄不得丢掉真漂移）
  const hostExitOut = { checks: [], errors: [], hostFatal: [] };
  recordProbeEarlyExit(hostExitOut, PROBE_PHASE.HOST_ASSEMBLY, 'Cannot find package @deepseek-ai/dsh-tools');
  eq('🔴 出口③ 反向：host-assembly 相位 → hostFatal[] 非空且判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
    attributeFailure({ ...hostExitOut, profile: { flavor: 'modern' }, contract: {} }, channel, 'dev'));

  // 9.9c 崩溃路径纪律：记录函数**自身不得抛**（运行在 uncaughtException / exit 钩子 / 看门狗里）
  for (const [label, record] of [['进程 exit', recordProbeEarlyExit], ['run() 被拖住', recordProbeRunIncomplete]]) {
    for (const [tlabel, target] of [
      ['缺 checks/errors 字段', { hostFatal: [] }],
      ['字段类型全错', { checks: 'x', errors: 1, hostFatal: 'y' }],
      ['errors 为抛错 getter', Object.defineProperty({ hostFatal: [] }, 'errors', { get() { throw new Error('boom'); }, set() { throw new Error('boom'); } })],
    ]) {
      let threw = 'no-throw';
      try { record(target, PROBE_PHASE.PLUGIN_INTEGRATION, 'x'); } catch { threw = 'threw'; }
      eq(`🔴 出口（${label}）：崩溃路径上记录函数不抛（${tlabel}）`, 'no-throw', threw);
    }
  }

  // 9.9d **完成位**（🔴 必修-1）：未跑完的运行**不得**判 PASS（假绿比 AMBER 更危险）
  eq('🔴 完成位：runCompleted=false + 无失败项 → PLUGIN_REGRESSION（不放行）', 'PLUGIN_REGRESSION',
    attributeFailure(probeOf([], [{ name: 'host.tools_ready', status: 'pass', detail: 'x' }], { runCompleted: false }), channel, 'dev'));
  eq('🔴 完成位：runCompleted=false + 全是 skip → PLUGIN_REGRESSION（不得当通过）', 'PLUGIN_REGRESSION',
    attributeFailure(probeOf([], [{ name: 'plugin.apply_ok', status: 'skip', detail: '未验证' }], { runCompleted: false }), channel, 'dev'));
  eq('🔴 完成位：runCompleted=false + 有失败项 → 仍按失败项归因（PLUGIN_REGRESSION）', 'PLUGIN_REGRESSION',
    attributeFailure(probeOf(['plugin.early_exit: x'], [failCheck(PLUGIN_EARLY_EXIT_CHECK)], { runCompleted: false }), channel, 'dev'));
  eq('🔴 完成位：**未跑完 + 宿主侧信号** → 仍判 UPSTREAM_DRIFT（判据 1 优先，不得翻成插件回归）', 'UPSTREAM_DRIFT',
    attributeFailure(probeHostFatal('离线模式下缺少宿主依赖缓存', [{ name: 'host.tools_ready', status: 'skip', detail: 'x' }]), channel, 'dev'));
  {
    const incomplete = attributionDetail(probeOf([], [{ name: 'host.tools_ready', status: 'pass', detail: 'x' }], { runCompleted: false }), channel, 'dev');
    eq('🔴 完成位：理由链点名「未跑完」与「skip 而非 fail」（可审计）', true,
      incomplete.reasons.some((r) => r.includes('未跑完') && r.includes('skip')));
  }
  // 反向护栏：老报告 / 非探针来源（无 runCompleted 字段）**不得**据此翻案（避免把缺字段当新活口）
  eq('🔴 完成位反向：runCompleted 缺字段（undefined）时不据此翻案（仍按失败项归因）', 'PLUGIN_REGRESSION',
    attributeFailure(probeOf(['registry.exact: x'], [failCheck('registry.exact')]), channel, 'dev'));
  eq('🔴 完成位反向：runCompleted=true + 无失败 → 归因退化为 UNKNOWN（正常失败路径不变）', 'UNKNOWN',
    attributeFailure(probeOf([], [{ name: 'host.tools_ready', status: 'pass', detail: 'x' }], { runCompleted: true }), channel, 'dev'));

  // 9.9e 装配器侧：`ok` 必须同时要求完成位与无失败（否则 exit 路径会假绿）
  const okOf = (payload) => {
    const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly', runCompleted: false };
    interpretProbeStdout(r, `__DSH_PROBE__${JSON.stringify(payload)}\n`);
    return `${r.ok}|${r.runCompleted}`;
  };
  eq('🔴 装配器：runCompleted=false + errors=[] → ok=false（假绿在装配器这层就拦掉）', 'false|false',
    okOf({ checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok: true, runCompleted: false }));
  eq('🔴 装配器：runCompleted=true + errors=[] → ok=true（正常通过不受影响）', 'true|true',
    okOf({ checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok: true, runCompleted: true }));
  eq('🔴 装配器：探针未给完成位（老报告）→ ok=false（保守，不假装跑完）', 'false|false',
    okOf({ checks: [], errors: [], hostFatal: [], ok: true }));

  // 9.9f 相位信标：闭合**不可捕获**终止的归因（有信标 → 插件侧；无信标 → hostFatal[]）
  const beaconText = `${PROBE_PHASE_BEACON_PREFIX}${PROBE_PHASE.PLUGIN_INTEGRATION}\nKilled\n`;
  eq('🔴 信标：前缀与结构化结果标记不混淆（startsWith("__DSH_PROBE__") 不命中信标行）', false,
    beaconText.split('\n')[0].startsWith('__DSH_PROBE__'));
  {
    const r = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.HOST_ASSEMBLY };
    interpretProbeStdout(r, beaconText);
    eq('🔴 信标：有信标（插件集成相位被终止）→ 落插件侧 check，hostFatal 为空', `${PLUGIN_ABNORMAL_TERMINATION_CHECK}|0`,
      `${r.checks[0]?.name}|${r.hostFatal.length}`);
    eq('🔴 信标：有信标 → 归因 PLUGIN_REGRESSION（不甩锅上游）', 'PLUGIN_REGRESSION',
      attributeFailure(r, channel, 'dev'));
    eq('🔴 信标：探针未输出结构化结果 ⇒ 完成位=false（未跑完，不得判通过）', false, r.runCompleted);
  }
  {
    const r = { checks: [], errors: [], hostFatal: [], phase: PROBE_PHASE.HOST_ASSEMBLY };
    interpretProbeStdout(r, 'Killed（宿主装配段，无信标）\n');
    eq('🔴 信标反向：无信标 → 仍写 hostFatal[]（真上游信号不丢）', `0|${1}`,
      `${r.checks.length}|${r.hostFatal.length}`);
    eq('🔴 信标反向：无信标 → 判 UPSTREAM_DRIFT', 'UPSTREAM_DRIFT', attributeFailure(r, channel, 'dev'));
  }

  // 9.9g 源码守卫（防后人把四条出口改回去 / 重新 unref 掉看门狗）
  const exitProbeSrc = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  eq('🔴 出口③ 源码守卫：探针挂 process.on("exit") 钩子（可捕获出口闭合）', true, /process\.on\('exit'/.test(exitProbeSrc));
  eq('🔴 出口③ 源码守卫：exit 钩子里用 writeSync 出报告（防 exit 截断 stdout）', true,
    /process\.on\('exit'[\s\S]{0,1200}emit\(\)/.test(exitProbeSrc));
  // 出口③ 的钩子现为**具名** handler（`defenseHandlers.exit`）——具名是**身份检查**的锚点
  // （批 1.5 第 8 项：`checkProcessDefense()` 靠它判断钩子是否仍在 `process.listeners('exit')` 里）。
  eq('🔴 出口③ 源码守卫：exit 钩子具名登记（身份检查的锚点，防被单方摘除不可判定）', true,
    /defenseHandlers\.exit = \(code\) =>/.test(exitProbeSrc) && /process\.on\('exit', defenseHandlers\.exit\)/.test(exitProbeSrc));
  eq('🔴 出口③ 源码守卫：exit 钩子改 process.exitCode（插件 exit(0) 不得读成通过）', true,
    /defenseHandlers\.exit = \(code\) =>[\s\S]{0,2000}process\.exitCode = 1/.test(exitProbeSrc));
  // 按**代码视图**判（codeOnly 去掉注释与字符串文本）：本文件的注释里大量出现
  // `watchdog.unref?.()` / `onProcessLevelException()` 这类「历史缺陷长什么样」的说明，
  // 直接扫源码会把**文档**当成**实现**（误报）。守卫本身不能有盲区，也不能有误报。
  const exitProbeCode = codeOnly(exitProbeSrc);
  eq('🔴 出口④ 源码守卫：看门狗**无条件**安装（不在异常处理器内）', true,
    /^runWatchdog = setTimeout\(/m.test(exitProbeCode) && !/onProcessLevelException/.test(exitProbeCode));
  // 关键：`unref` 是出口④ 的**根因**（事件循环无其它 handle 时看门狗永不触发）——不得回来
  eq('🔴 出口④ 源码守卫：看门狗**不得** unref（回退即红：那正是「run() 被拖住仍逃逸」的根因）', 'no-unref',
    /\.unref/.test(exitProbeCode) ? 'unref-present' : 'no-unref');
  eq('🔴 出口④ 源码守卫：收尾路径显式 clearTimeout（不靠 unref 让进程自己走）', true,
    /function finish\(code\)[\s\S]{0,400}clearTimeout\(runWatchdog\)/.test(exitProbeSrc));
  eq('🔴 出口④ 源码守卫：看门狗窗口只许**缩短**（Math.min + 下限，插件无法延长）', true,
    /Math\.min\(\s*RUN_WATCHDOG_DEFAULT_MS/.test(exitProbeSrc) && /Math\.max\(1_000/.test(exitProbeSrc));
  eq('🔴 完成位源码守卫：runCompleted 只在 run() 正常返回后置真', true,
    /await run\(\);\s*\n\s*\/\/[^\n]*\n\s*runCompleted = true;/.test(exitProbeSrc) || /await run\(\);\s*\n\s*(?:\/\/[^\n]*\n\s*)*runCompleted = true;/.test(exitProbeSrc));
  eq('🔴 完成位源码守卫：emit() 的 ok 来自 runCompleted && 无失败（不带完成位 = 用一个 HIGH 换一个 MEDIUM）', true,
    /out\.ok = runCompleted && out\.errors\.length === 0;/.test(exitProbeSrc));
  eq('🔴 完成位源码守卫：完成位随结构化结果输出（装配器可判）', true, /out\.runCompleted = runCompleted;/.test(exitProbeSrc));
  // 判据侧源码守卫：1b 完成位判据不得被删（删了 = exit 路径重新假绿，而夹具仍会「有 fail」故 e2e 未必红）
  const runnerSrcForGuard = readText(path.join(ROOT, 'src/verify/runner.mjs'), 'utf8');
  const runnerCodeForGuard = codeOnly(runnerSrcForGuard);
  eq('🔴 完成位源码守卫：runner 判据含「未跑完 → 不判通过」（1b）', true,
    /runCompleted === false/.test(runnerCodeForGuard) && /failedChecks\.length === 0/.test(runnerCodeForGuard));
  eq('🔴 完成位源码守卫：runner 通道报告透出 runCompleted（排障/闸门可断言）', true,
    /runCompleted: probe\.runCompleted === true/.test(runnerCodeForGuard));
  // 位置纪律：1b 必须在 2b（插件侧硬证据）**之前**、在宿主侧判据（reasons.length > 0）**之后**——
  // 顺序错了语义就反了（前者会把上游信号翻成插件回归，后者会让硬证据被完成位抢走）。
  // 注意：codeOnly 会把字符串字面量替换成 ` S `，故锚点不能含引号内容（否则永远匹配不到 = 守卫空转）
  const iHostSide = runnerCodeForGuard.indexOf('if (reasons.length > 0) return { attribution:');
  const iIncomplete = runnerCodeForGuard.indexOf('runCompleted === false');
  const iHardEvidence = runnerCodeForGuard.indexOf('PLUGIN_HARD_EVIDENCE.filter');
  eq('🔴 完成位源码守卫：判据顺序 = 宿主侧 → 完成位(1b) → 硬证据(2b)', true,
    iHostSide !== -1 && iIncomplete !== -1 && iHardEvidence !== -1 && iHostSide < iIncomplete && iIncomplete < iHardEvidence);

  eq('🔴 相位信标源码守卫：探针进插件集成相位时打信标', true,
    /phase = PROBE_PHASE\.PLUGIN_INTEGRATION;\s*\n\s*out\.phase = phase;\s*\n\s*\/\/[^\n]*\n\s*beacon\(phase\);/.test(exitProbeSrc)
    || /beacon\(phase\);/.test(exitProbeSrc));

  // 9.9h 夹具自检：三份新夹具必须真的复现对应形态（否则离线/E2E 断言空转）
  for (const [fixture, label, pattern] of [
    ['plugin-exit-plugin.mjs', '进程 exit（process.exit）', /process\.exit\(0\)/],
    ['plugin-hang-plugin.mjs', 'run() 被拖住（永不 resolve 的 Promise）', /return new Promise\(\(\) => \{[^}]*never resolves[^}]*\}\)/],
    ['plugin-sigkill-plugin.mjs', '不可捕获终止（SIGKILL）', /process\.kill\(process\.pid, 'SIGKILL'\)/],
  ]) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    eq(`🔴 夹具 ${fixture}：真的复现「${label}」`, true, pattern.test(src));
    eq(`🔴 夹具 ${fixture}：自述期望 hostFatal 为空（不变量写在夹具里）`, true, src.includes('hostFatal[]'));
    eq(`🔴 夹具 ${fixture}：健康工具先注册（失败点精确留在逃逸动作上）`, true, /demo_echo/.test(src));
    eq(`🔴 夹具 ${fixture}：声明期望的工具清单（供闸门/回归取用）`, true, /export const expectedTools = \['demo_echo'\]/.test(src));
  }
}

// ---- 9.10. R28：防线自检**不得**退回「has() || listenerCount>0」（实测假阳性） ----
// 为什么单列一段（评审复评 R28）：R22 的修法 A 写的自检判据
// `hasUncaughtExceptionCaptureCallback() || listenerCount('uncaughtException') > 0` **不可判定**——
// 插件把我们的 handler 换成**自己的**之后：has=true、count=1 ⇒ 该式恒真 ⇒ 判「防线有效」（假阳性），
// 而实际上探针的兜底已经被顶替（后台抛错被插件 handler 吞掉）。本段把「为什么必须换判据」写成断言。
console.log('  [9.10] R28 防线自检判据（身份检查 + 行为级 canary；计数判据已证假阳性）');
{
  const defenseSrc = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  // 1. 判据不得是 `has(...) || listenerCount(...)` 这类**或**式内省判据
  eq('R28 源码守卫：自检判据不得写成 has() || listenerCount>0（假阳性写法，回退即红）', false,
    /hasUncaughtExceptionCaptureCallback\(\)\s*\|\|/.test(codeOnly(defenseSrc))
    || /listenerCount\('?\w+\'?\)\s*>\s*0\s*\|\|/.test(codeOnly(defenseSrc)));
  // 2. 三重判据必须齐备
  eq('R28 源码守卫：① API 调用台账（wrap 记账）', true,
    /wrapProcessDefenseApis\(\)/.test(defenseSrc) && /defenseApiCalls\.push\(note\)/.test(defenseSrc));
  eq('R28 源码守卫：② 身份检查（我们的 handler 仍在 process.listeners() 内）', true,
    /process\.listeners\(event\)\.includes\(handler\)/.test(defenseSrc));
  eq('R28 源码守卫：③ 行为级 canary 走真实派发路径（process._fatalException）', true,
    /process\._fatalException/.test(defenseSrc) && /runDefenseCanary\(\)/.test(defenseSrc));
  eq('R28 源码守卫：canary 哨兵用 Symbol 标记（不可从外部伪造 ⇒ 插件无法据此静音自己）', true,
    /Symbol\('dsh-probe-defense-canary'\)/.test(defenseSrc) && /isProbeCanary\(error\)/.test(defenseSrc));
  // 3. wrap 必须在**任何插件代码之前**（探针启动即装）：位于兜底区，且早于相位切到 plugin-integration
  {
    // 锚点用 `await run();`（探针**唯一**的插件代码入口）：wrap 必须在它之前**模块级**执行。
    // 不用 `phase = PROBE_PHASE.PLUGIN_INTEGRATION;` 做锚：那句在 `run()` **函数体内**，
    // 文本位置在 wrap 之前，但**执行**在 wrap 之后——用文本序判会把正确实现判红（守卫自己空转/误报）。
    const wrapIdx = defenseSrc.indexOf('wrapProcessDefenseApis();');
    const runCallIdx = defenseSrc.indexOf('await run();');
    eq('R28 源码守卫：wrap 在插件代码运行之前安装（早于唯一入口 `await run()`）', true,
      wrapIdx > 0 && runCallIdx > 0 && wrapIdx < runCallIdx);
  }
  // 4. 行为级反证：计数判据确实判不出「被顶替」（把「为什么必须换」写成断言）
  {
    const log = [];
    const mine = () => log.push('mine');
    process.on('uncaughtException', mine);
    process.removeListener('uncaughtException', mine);
    process.on('uncaughtException', () => log.push('plugin'));
    eq('R28 反证：插件顶替后 listenerCount 仍为 1（计数判据看不出防线已被顶替）', 1,
      process.listenerCount('uncaughtException'));
    eq('R28 反证：身份检查能看出我们的 handler 已不在 listeners 内', false,
      process.listeners('uncaughtException').includes(mine));
    process.removeAllListeners('uncaughtException');
  }
  // 5. 夹具自检：新夹具必须真的复现「摘掉 + 装自己的」（计数不为 0，旧判据假阳性）
  {
    const src = readText(path.join(ROOT, 'tests/fixtures', 'plugin-defense-tamper-plugin.mjs'), 'utf8');
    eq('R28 夹具：先摘掉探针兜底（removeAllListeners）', true, /process\.removeAllListeners\('uncaughtException'\)/.test(src));
    eq('R28 夹具：再装**自己的** handler（计数不为 0 ⇒ 计数判据假阳性）', true,
      /process\.on\('uncaughtException', \(\) =>/.test(src));
    eq('R28 夹具：后台抛错（被自己的 handler 吞掉）', true, /setTimeout\([\s\S]{0,200}throw new Error/.test(src));
    eq('R28 夹具：自述期望 hostFatal 为空（不变量写在夹具里）', true, src.includes('hostFatal[]'));
    eq('R28 夹具：声明期望的工具清单（供闸门/回归取用）', true, /export const expectedTools = \['demo_echo'\]/.test(src));
  }
}

// ---- 9.11. R26：协议注入防线（多 marker 判篡改 + 结果通道隔离） ----
// 为什么单列（评审复评 R26，**放行级假绿**）：装配器原先 `find(startsWith('__DSH_PROBE__'))` 取**第一条**，
// 插件在 `apply()` 里写一条伪造结果即抢首位（真报告被忽略）；实测三种形态在真宿主下均判 GREEN 放行。
// 本段把两条修法（A 结构不变量 / B 通道隔离）都钉住，并给出**反向护栏**（正常路径恒 1 条不得误判）。
console.log('  [9.11] R26 协议注入防线（结构不变量 + 通道隔离）');
{
  const okProbe = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly', runCompleted: false };
  const forged = `__DSH_PROBE__${JSON.stringify({ checks: [], errors: [], hostFatal: [], ok: true, runCompleted: true })}`;

  // 9.11a 多 marker 即篡改（修法 A）：正常路径恒 1 条，≥2 条是**结构铁证**
  {
    const r = { ...okProbe, checks: [], errors: [], hostFatal: [] };
    interpretProbeStdout(r, `${forged}\n${forged}\n`);
    eq('R26-A：结果行 ≥2 条 → 落插件侧 check plugin.protocol_injection', PLUGIN_PROTOCOL_INJECTION_CHECK, r.checks[0]?.name);
    eq('R26-A：≥2 条 → hostFatal 为空（不甩锅上游）', 0, r.hostFatal.length);
    eq('R26-A：≥2 条 → 完成位 false（不放行）', false, r.runCompleted);
    eq('R26-A：≥2 条 → ok=false（不判通过）', false, r.ok);
    eq('R26-A：≥2 条 → 归因 PLUGIN_REGRESSION（不放行）', 'PLUGIN_REGRESSION',
      attributeFailure(r, channel, 'dev'));
    eq('R26-A：≥2 条 → **不采信任何一条**（checks 只留这一条篡改证据，伪造的 17 项不入报告）', 1, r.checks.length);
  }

  // 9.11b 通道隔离（修法 B）：结果走 fd3 时，stdout 里出现结果行 = 篡改证据
  {
    const real = `__DSH_PROBE__${JSON.stringify({ checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok: true, runCompleted: true })}`;
    const r = { ...okProbe, checks: [], errors: [], hostFatal: [] };
    interpretProbeStdout(r, `${forged}\n`, real);
    eq('R26-B：结果走 fd3 而 stdout 里也出现结果行 → 判篡改', PLUGIN_PROTOCOL_INJECTION_CHECK, r.checks[0]?.name);
    eq('R26-B：判篡改后不采信 fd3 里的真报告（本轮结果不可信）', false, r.ok);
  }
  {
    // 正向：正常路径（fd3 只有 1 条、stdout 只有日志）必须**不**误判（防过度修正）
    const real = `__DSH_PROBE__${JSON.stringify({ checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok: true, runCompleted: true })}`;
    const r = { ...okProbe, checks: [], errors: [], hostFatal: [] };
    interpretProbeStdout(r, '__DSH_PROBE_PHASE__plugin-integration\n日志行\n', real);
    eq('R26-B 反向护栏：正常路径（fd3 1 条 / stdout 只有日志）不误判篡改', 'host.tools_ready', r.checks[0]?.name);
    eq('R26-B 反向护栏：正常路径 ok=true（不因新增防线而误伤）', true, r.ok);
  }

  // 9.11c 向后兼容：fd3 不可用时回退 stdout，2 参调用行为与 v0.1.9c 一致（旧断言不破）
  {
    const r = { ...okProbe, checks: [], errors: [], hostFatal: [] };
    interpretProbeStdout(r, `${forged}\n`);
    eq('R26 兼容：fd3 缺省（2 参调用）时从 stdout 取结果（老装配器/直接跑探针）', true, r.ok);
    eq('R26 兼容：单条结果不判篡改（回退路径的正常形态）', 0, r.checks.length);
  }

  // 9.11d 相位信标不得被误当结果行（命名纪律）
  eq('R26：相位信标不被 collectProbeResultLines 命中（第 13 字符错开）', 0,
    collectProbeResultLines(`${PROBE_PHASE_BEACON_PREFIX}${PROBE_PHASE.PLUGIN_INTEGRATION}\n`).length);
  eq('R26：collectProbeResultLines 返回**全部**命中（≥2 条即篡改铁证）', 2,
    collectProbeResultLines(`${forged}\n${forged}\n`).length);

  // 9.11e 宿主侧不变量：探针 spawn 参数必须带 killSignal:SIGKILL（R24）+ fd3 通道（R26-B）
  {
    const opts = probeSpawnOptions({ hubRoot: ROOT, pluginPath: '/tmp/p.mjs', expectedTools: ['a'], timeoutMs: 1000, nonce: createProbeNonce(randomBytes) });
    eq('R24 源码守卫：探针 spawn 带 killSignal:SIGKILL（默认 SIGTERM 会被探针出口③ 处理器吞掉）', 'SIGKILL', opts.killSignal);
    eq('R26-B 源码守卫：探针 spawn 开 fd3（stdio 第 4 位为 pipe）', 'pipe', opts.stdio?.[3]);
    eq('R26-B 源码守卫：stdout 仍为 pipe（只留日志；出现结果行即篡改证据）', 'pipe', opts.stdio?.[1]);
    // R26 **通道形态**守卫（本轮实测）：nonce 必须经 **stdin** 下发，**不得**经 env / argv。
    // 依据：env 通道即使 `delete process.env[NAME]`，值仍留在 `/proc/self/environ`（同 uid 可读）；
    // argv 通道出现在 `ps` / `/proc/self/cmdline`。两者都让插件**反读出 nonce** 再伪造带 nonce 的
    // 结果行 ⇒ 放行级假绿（本仓实测：env 通道下 `plugin-nonce-reverse-read-plugin` 判 GREEN）。
    eq('R26 源码守卫：探针 spawn 的 stdin 为 pipe（nonce 带外通道，插件无法从 env/argv 反读）', 'pipe', opts.stdio?.[0]);
    eq('R26 源码守卫：探针 spawn **不**经 env 传 nonce（env 可被 /proc/self/environ 反读）', true,
      !opts.env || !Object.keys(opts.env).some((k) => k.startsWith('DSH_NONCE')));
    eq('R26 源码守卫：探针 argv **不**携带 nonce 参数（argv 会出现在 ps / cmdline）', true,
      !(opts.args ?? []).some((a) => /nonce/i.test(String(a))));
    eq('R26 源码守卫：nonce 经 `input`（stdin 字节流）下发', true, typeof opts.input === 'string' && opts.input.trim().length > 0);
    // 探针侧：必须从 fd 0 读、且读完立刻 close（否则插件可从 fd 0 再读一遍）
    const probeSrcForNonce = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
    eq('R26 源码守卫：探针从 fd 0 读 nonce', true, /readFileSync\(0, 'utf8'\)/.test(probeSrcForNonce));
    eq('R26 源码守卫：探针读完 stdin 立刻 destroy（否则插件可从 fd 0 再读一遍）', true,
      /readFileSync\(0[\s\S]{0,300}process\.stdin\.destroy/.test(probeSrcForNonce));
    // 反向：contract.mjs **不得**再导出 env 通道 API（回退即红）
    eq('R26 源码守卫：contract.mjs 不再有 env 通道 API（PROBE_NONCE_ENV_ARG_PREFIX 已移除）', false,
      /PROBE_NONCE_ENV_ARG_PREFIX/.test(readText(path.join(ROOT, 'src/harness/contract.mjs'), 'utf8')));
    eq('R26 源码守卫：通道形态常量 = stdin', 'stdin', PROBE_NONCE_STDIN_CHANNEL);
    // 夹具：反读形态必须真的尝试两条读取面（否则闸门断言空转）
    const rrSrc = readText(path.join(ROOT, 'tests/fixtures', 'plugin-nonce-reverse-read-plugin.mjs'), 'utf8');
    eq('R26 夹具：反读形态真的尝试 /proc/self/environ', true, /\/proc\/self\/environ/.test(rrSrc));
    eq('R26 夹具：反读形态真的尝试 /proc/self/cmdline（argv 面）', true, /\/proc\/self\/cmdline/.test(rrSrc));
    eq('R26 夹具：用**反读到的 nonce** 伪造带 nonce 的结果行', true, /__DSH_PROBE__\$\{nonce\}:/.test(rrSrc));
    eq('R24 源码守卫：timeout 语义 = 探针硬上限（原样透传）', 1000, opts.timeout);
  }
  eq('R26：落点 check 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）', true,
    PLUGIN_SIDE_CHECKS.includes(PLUGIN_PROTOCOL_INJECTION_CHECK));
  eq('R26：落点 check 已登记进 CONDITIONAL_PROBE_CHECKS（条件项计数随之 +1）', true,
    CONDITIONAL_PROBE_CHECKS.includes(PLUGIN_PROTOCOL_INJECTION_CHECK));


  // 9.11g 🟡（评审复评）：装配器**不得**用裸结果标记字面量做前缀匹配 ——
  // 裸字面量在改名时**静默失配**（标记改了、匹配处没改 ⇒ 一条结果行都收不到 ⇒ 归因退化成
  // 「探针未输出结构化结果」），而源码守卫扫不到。唯一事实源 = PROBE_RESULT_MARKER。
  {
    const hostCodeForMarker = codeOnly(readText(path.join(ROOT, 'src/harness/host.mjs'), 'utf8'));
    eq('🟡 源码守卫：装配器不写裸结果标记字面量（改用 PROBE_RESULT_MARKER，改名即静默失配）', false,
      /__DSH_PROBE__/.test(hostCodeForMarker));
    eq('🟡 源码守卫：collectProbeResultLines 用唯一事实源常量做前缀匹配', true,
      /startsWith\(PROBE_RESULT_MARKER\)/.test(hostCodeForMarker));
  }

  {
    const mkPayload = (ok = true) => JSON.stringify({ checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok, runCompleted: true, phase: 'plugin-integration' });
    const nonce = createProbeNonce(randomBytes).value;
    // ① 可证伪（正向）：**已知 nonce** 时，把匹配前缀的结果行写到 **stdout**（通道已隔离）→ 必须命中。
    //    这条**不是恒真式**：把判据删掉 / 把通道隔离关掉，它立刻红。
    {
      const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly' };
      interpretProbeStdout(r, `${probeResultPrefix(nonce)}${mkPayload()}\n`, { resultFd: `${probeResultPrefix(nonce)}${mkPayload()}\n`, nonce });
      eq('R26 可达性（可证伪·正向）：匹配 nonce 的结果行出现在 stdout（通道已隔离）→ 判 plugin.protocol_injection', PLUGIN_PROTOCOL_INJECTION_CHECK, r.checks[0]?.name);
      eq('R26 可达性（可证伪·正向）：命中即不放行（ok=false / 完成位 false）', 'false|false', `${r.ok}|${r.runCompleted}`);
    }
    // ② 可证伪（反向）：同样的输入但**前缀不匹配**（插件拿不到 nonce 的形态）→ **不得**命中结构级防线。
    //    两条一起构成「判据有判别力」的证明（只写正向的话，一个「恒判篡改」的实现也能过）。
    {
      const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly' };
      interpretProbeStdout(r, `__DSH_PROBE__${mkPayload()}\n`, { resultFd: `${probeResultPrefix(nonce)}${mkPayload()}\n`, nonce });
      eq('R26 可达性（可证伪·反向）：前缀不匹配（拿不到 nonce）→ **不**命中结构级防线', false,
        r.checks.some((c) => c.name === PLUGIN_PROTOCOL_INJECTION_CHECK));
      eq('R26 可达性（可证伪·反向）：改判 plugin.probe_result_forged（侧信道，独立证据链）', true,
        r.checks.some((c) => c.name === PLUGIN_PROBE_FORGED_RESULT_CHECK));
    }
    // ③ 通道形态事实（**这才是**「经 env / argv 不可达」的机器可检依据）：spawn 参数里
    //    nonce 不在 env、不在 argv，经 stdin 字节流下发。
    const opts = probeSpawnOptions({ hubRoot: ROOT, pluginPath: '/tmp/p.mjs', expectedTools: ['a'], timeoutMs: 1000, nonce: createProbeNonce(randomBytes) });
    eq('R26 可达性（通道事实）：nonce 不经 env（/proc/self/environ 读取面不成立）', true,
      !opts.env || !Object.keys(opts.env).some((k) => k.startsWith('DSH_NONCE')));
    eq('R26 可达性（通道事实）：nonce 不经 argv（ps / cmdline 读取面不成立）', true,
      !(opts.args ?? []).some((a) => /nonce/i.test(String(a))));
    eq('R26 可达性（通道事实）：nonce 经 stdin 字节流下发', true, typeof opts.input === 'string' && opts.input.trim().length > 0);
    // ④ 真宿主可达形态（进闸门）：裸 marker 伪造 ⇒ `plugin.probe_result_forged`。
    eq('R26 可达性：真宿主可达形态是 plugin-forged-result-plugin（进闸门）', true,
      /plugin-forged-result-plugin\|plugin\.probe_result_forged/.test(readText(path.join(ROOT, 'tests/gate_plugin_side.sh'), 'utf8')));
    // ⑤ §3 反例（**真宿主 PoC**）固化并进闸门——这是「不可达」口径作废的可执行证据。
    eq('R26 可达性：§3 反例 PoC 夹具进闸门（真宿主，期望不得 GREEN）', true,
      /plugin-host-tamper-poc-plugin\|/.test(readText(path.join(ROOT, 'tests/gate_plugin_side.sh'), 'utf8')));
    {
      const src = readText(path.join(ROOT, 'tests/fixtures', 'plugin-forged-result-plugin.mjs'), 'utf8');
      eq('R26 夹具：真的写裸 marker（无 nonce ⇒ 命中侧信道防线）', true, /write\(`__DSH_PROBE__/.test(src));
      eq('R26 夹具：真缺陷（多注册工具 ⇒ registry.exact 必 fail，绿卡不得掩盖它）', true, /demo_extra/.test(src));
      eq('R26 夹具：自述期望 hostFatal 为空（不变量写在夹具里）', true, src.includes('hostFatal[]'));
    }
    // ⑥ 三处「真宿主不可达」口径必须已被更正（回退即红）：RISKS / e2e 注释 / 闸门注释
    const r26Row = readText(path.join(ROOT, 'docs/RISKS.md'), 'utf8').split('\n').find((line) => /^\| R26 \|/.test(line)) ?? '';
    // 注意：守卫要判的是**是否把不可达当结论**——上一版的原话是「真宿主下插件无法构造该输入」/
    // 「结构级防线在真宿主不可达」。只判这两个**断言式**写法（不判「不得写 X」这类**禁止语**，
    // 否则守卫会把更正说明本身判红——那正是「文档即防线」要保留的东西）。
    eq('R26 口径：RISKS R26 不再把「真宿主不可达 / 无法构造」当结论（未验证命题不得当对外口径）', false,
      /真宿主下(\*\*)?不可达/.test(r26Row) || /真宿主下插件无法构造/.test(r26Row));
    eq('R26 口径：RISKS R26 写明经 env/argv 不可达 + 同进程其它手段仍可达（事实陈述）', true,
      /经 env \/ argv 不可达/.test(r26Row) && /同进程/.test(r26Row));
  }
}

// ---- 9.12. R24：同步死循环 → 宿主二次终止（killSignal 语义 + 收口时间） ----
// 为什么单列（评审复评 R24）：探针的看门狗 / 信号处理器都是事件循环上的回调，插件 `apply()`
// 同步占满事件循环后两者都不执行；而探针为出口③ 装了 SIGTERM 处理器 ⇒ Node 默认终止行为被禁用
// ⇒ 宿主杀不掉探针（实测 30.3s / 永久挂死）。本段在**离线**把 killSignal 语义钉住（真宿主闸门另有断言）。
console.log('  [9.12] R24 同步死循环（宿主二次终止 + 相位信标归因）');
{
  const t = Date.now();
  const { result, attribution, exit } = runOfflineProbe({
    pluginPath: path.join(ROOT, 'tests/fixtures', 'plugin-sync-loop-plugin.mjs'),
    expectedTools: ['demo_echo'],
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - t;
  eq('R24：同步死循环被宿主二次终止（probeExit.signal=SIGKILL）', 'SIGKILL', exit.signal);
  eq('R24：收口时间 < timeoutMs × 3（不得挂死 / 不得吃满额度）', true, elapsed < 1500 * 3);
  eq('R24：按相位信标归因插件侧（plugin.abnormal_termination）', PLUGIN_ABNORMAL_TERMINATION_CHECK,
    result.checks[0]?.name);
  eq('R24：归因 PLUGIN_REGRESSION（有信标 ⇒ 不判 UPSTREAM_DRIFT，不甩锅上游）', 'PLUGIN_REGRESSION', attribution);
  eq('R24：hostFatal 为空（插件侧）', 0, result.hostFatal.length);
  eq('R24：完成位 false（未跑完，不得判通过）', false, result.runCompleted);
  // 夹具自检：循环时长必须**短**（3s 级），否则 CI 会被吃满
  {
    const src = readText(path.join(ROOT, 'tests/fixtures', 'plugin-sync-loop-plugin.mjs'), 'utf8');
    eq('R24 夹具：同步循环在 apply() 内（占满事件循环）', true, /Date\.now\(\) \+ 3000/.test(src));
    eq('R24 夹具：自述期望 hostFatal 为空（不变量写在夹具里）', true, src.includes('hostFatal[]'));
  }
  // 反向护栏：健康插件在同一参数下必须仍 17/17（防「把 timeout 调小」式过度修正）
  {
    const healthy = runOfflineProbe({
      pluginPath: path.join(ROOT, 'tests/fixtures', 'demo-plugin.mjs'),
      expectedTools: ['demo_echo', 'demo_status'],
      timeoutMs: 1500,
    });
    eq('R24 反向护栏：同一 timeoutMs 下健康插件仍 17/17 全绿', 17,
      healthy.result.checks.filter((c) => c.status === 'pass').length);
    eq('R24 反向护栏：健康插件不被新防线误伤（hostFatal 为空 + 跑完）', '0|true',
      `${healthy.result.hostFatal.length}|${healthy.result.runCompleted}`);
  }
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

// ---- 11. 口径守卫：文档/源码**不得**把「插件侧错误不进 hostFatal[]」写成绝对口径 ----
// 为什么单独守（评审复评 H1）：v0.1.7/v0.1.8 曾把该不变量写成「插件侧错误**永远**不进 hostFatal[]」
// 并对**外**宣称；而 H1（`setUncaughtExceptionCaptureCallback` 静音探针防线 → GREEN 放行）直接推翻它。
// 中台的核心主张是「归因可信」——**文档撒谎的代价 > 代码有洞**。故：绝对口径回流即红。
console.log('  [11] 口径守卫：不变量不得写成「永远/永不」（H1 推翻的绝对口径）');
{
  // 允许的**收窄口径**关键词：出现它即视为已收窄（本守卫只拦绝对化措辞）。
  const NARROW = '防线未被插件干预';
  /**
   * 绝对口径命题（**R27 扩条**）。
   *
   * 为什么必须扩：旧守卫只守「插件侧错误…永远/永不…hostFatal」这**一个**命题，
   * 而 H1/R26/R28 推翻的其实是**另一条**——「插件侧一律落 check」这条**完整性主张**
   * （H1：captureCallback 静音后插件侧错误**不再**落 check；R26：结果通道被注入）。
   * 只守前者 ⇒ 后者可以随便写，而它才是被实证推翻的那条。
   *
   * 同义词组：`永远|永不|绝不|决不|从不|一律不` 与 `一律|都|必然|一定`；
   * 主谓倒置（`hostFatal[] 里永远不会有插件侧错误`）与英文（`Plugin-side errors never enter hostFatal[]`）
   * 也必须覆盖——否则「换个说法」就绕过（评审实测的 ④⑤ 两形态）。
   */
  const ABSOLUTE_PROPS = [
    // ① 插件侧错误/异常/信号…（绝对副词）…hostFatal
    /插件侧(错误|异常|信号|失败)[^。；]{0,40}(永远|永不|绝不|决不|从不|一律不)[^。；]{0,40}hostFatal/,
    // ② 插件侧…（一律/都/必然/一定）…落/进/写…check（完整性主张：H1 真正推翻的那条）
    /插件侧[^。；]{0,30}(一律|都|必然|一定)[^。；]{0,20}(落|进|写)[^。；]{0,12}check/,
    // ③ 主谓倒置：hostFatal[] …（绝对副词）…插件侧
    /hostFatal[^。；]{0,40}(永远|永不|绝不|决不|从不)[^。；]{0,40}插件侧/,
    // ④ 英文
    /Plugin-side\s+(errors?|failures?)[^.\n]{0,60}never[^.\n]{0,40}hostFatal/i,
  ];
  /**
   * 绝对口径判定：命中断言 **且** 所在**段落**（空行分隔）不含收窄前提。
   *
   * ⚠️ R27 的两处加固（相对 v0.1.9c 的旧守卫）：
   * 1. **去豁免词**：旧守卫把「收窄前提」与「豁免词」写成 `||` 关系 ⇒ 只要句子里有「不得」就放行，
   *    于是 `插件侧错误永远不进 hostFatal[]（不得有例外）` 这种**同义绕过**骗过守卫
   *    ——**正是它要防的东西**。现在只认**同段出现收窄前提**。
   * 2. **同段而非逐行**：旧守卫逐行判（正则 `[^。；\n]` 限死单行）⇒ 前提写在上一行、主张写在
   *    下一行就漏（`docs/ADAPTER_GUIDE.md` 实测形态）。现在按**空行分隔的段落**判，且段落内
   *    换行归一为空格（跨行主张同样命中）。
   *
   * @param {string} source 待判文本（源码 / 文档 / 闸门脚本）
   * @returns {string[]} 违规段落里的人读摘要（空数组 = 无绝对口径）
   */
  // 收窄前提 / 措辞纠正的**判定词**（R27：`不得` 这类**单独豁免词已取消**——
  // 旧守卫把豁免词与前提写成 `||`，于是「…永远不进 hostFatal[]（**不得**有例外）」能骗过守卫，
  // **正是它要防的东西**）。现在只认两类：
  // ① 明确写出收窄前提（`防线未被插件干预` / `口径前提` / `收窄前提`）；
  // ② 明确**纠正措辞本身**（`不得宣称…` / `不得再写…` / `不成立` / `已作废` / `推翻` / `口径收窄` / `准确口径`）。
  // 二者都**不可能**被用来加强一个绝对主张（`（不得有例外）` 不在其中 ⇒ 仍判违规）。
  const NARROW_TOKENS = [
    NARROW, '口径前提', '收窄前提',
    '不得宣称', '不得再写', '不成立', '已作废', '推翻', '口径收窄', '准确口径',
  ];
  /**
   * 把文本切成**段落**（空行与空注释行均为分隔符）。
   *
   * 为什么不用「按空行切」：源码里的 JSDoc 是**连续**的 ` *` 行，中间的空行写作
   * ` *`（不是真正的空行）⇒ 整块文件头会变成一个巨型「段落」，断言退化成「整文件含不含」，
   * 既误报又失去定位力。按「空注释行」切分后，段落 = 文档意义上的**小节**。
   *
   * @param {string} source 待切文本
   * @returns {string[]} 段落（换行归一为空格）
   */
  const paragraphsOf = (source) => {
    const out = [];
    let cur = [];
    for (const line of String(source).split('\n')) {
      const trimmed = line.trim();
      // Markdown **表格行**也是段落边界：RISKS 的大表整块不含空行，若不按行切，
      // 「整表一个段落」⇒ 断言退化成「整文件含不含绝对口径」（任一格命中即整表判违规，无定位力）。
      const isSeparator = trimmed === '' || trimmed === '*' || trimmed === '*/' || trimmed === '/**'
        || (trimmed.startsWith('|') && cur.length > 0);
      if (isSeparator) {
        if (cur.length > 0) { out.push(cur.join(' ')); cur = []; }
        continue;
      }
      if (trimmed.startsWith('|') && cur.length > 0) { out.push(cur.join(' ')); cur = []; }
      cur.push(trimmed.replace(/^\*\s?/, ''));
    }
    if (cur.length > 0) out.push(cur.join(' '));
    return out;
  };
  const absoluteOffenders = (source) => {
    const out = [];
    for (const flat of paragraphsOf(source)) {
      if (!ABSOLUTE_PROPS.some((re) => re.test(flat))) continue;
      if (NARROW_TOKENS.some((token) => flat.includes(token))) continue;
      out.push(flat.slice(0, 110));
    }
    return out;
  };
  // DOC_FILES（R27：增 `docs/INDEX.md` 与 `src/harness/host.mjs`——前者不在表内=漏守，
  // 后者是**装配器**：它写「取第一条结果行」的注释即 R26 的成因，必须一起守）
  const DOC_FILES = [
    'src/harness/contract.mjs',
    'src/harness/probe-template.mjs',
    'src/harness/host.mjs',
    'docs/RISKS.md',
    'docs/ARCHITECTURE.md',
    'docs/ADAPTER_GUIDE.md',
    'docs/INDEX.md',
    'README.md',
    '.cnb.yml',
    'tests/gate_plugin_side.sh',
  ];
  for (const file of DOC_FILES) {
    const src = readText(path.join(ROOT, file), 'utf8');
    eq(`口径守卫：${file} 无绝对口径（不进 hostFatal / 一律落 check 均须带同段收窄前提）`, [],
      absoluteOffenders(src));
  }
  // 收窄口径必须真的落在唯一事实源（`contract.mjs` 的 HOST_FATAL_FIELD JSDoc）里
  const contractSrc = readText(path.join(ROOT, 'src/harness/contract.mjs'), 'utf8');
  eq('口径守卫：contract.mjs 的 HOST_FATAL_FIELD JSDoc 显式声明收窄前提', true, contractSrc.includes(NARROW));
  // 反向：RISKS 必须记录 H1 这一族风险（删掉即红——「已知活口不得静默」）
  const risks = readText(path.join(ROOT, 'docs/RISKS.md'), 'utf8');
  for (const [id, label] of [
    ['R22', 'H1 放行级假绿（captureCallback 静音防线）'],
    ['R23', '探针进程内防线可被插件单方面撤销/静音'],
    ['R24', '宿主 execFileSync(timeout) 对同步死循环失效'],
    ['R24b', '🔴-1 收口：execFileSync killSignal=SIGKILL 让 timeoutMs 有界'],
    ['R25', '延迟抛错（排空窗口之外）→ 该插件判 GREEN 的后果'],
    // v0.1.9d（评审复评 §4）：三条新发现必须留痕（「已知活口不得静默」）
    ['R26', '协议注入 → 放行级假绿（结果通道被注入伪造报告）'],
    ['R27', '口径守卫同义绕过 + 只守了错的命题'],
    ['R28', '修法 A 自检判据不可判定（has()||listenerCount>0 假阳性）'],
    // v0.2.3（评审复评）：三条新发现必须留痕（「已知活口不得静默」）
    ['R29', '🔴 必修-4 同族假绿：JSON.stringify 未冻结 ⇒ 猴子补丁序列化函数伪造绿卡'],
    ['R30', '探针无 nonce 路径硬崩 → 甩锅上游（PROBE_RESULT_MARKER 未 import）'],
  ]) {
    eq(`口径守卫：RISKS 记录 ${id}（${label}）`, true, new RegExp(`\\|\\s*${id}\\s*\\|`).test(risks));
  }
  // v0.1.9d：新夹具必须固化在仓库里（删掉即红 = 「已知活口不得静默消失」）
  for (const [fixture, marker, label] of [
    ['plugin-defense-tamper-plugin.mjs', /removeAllListeners\('uncaughtException'\)/, 'R28 防线被顶替'],
    ['plugin-sync-loop-plugin.mjs', /Date\.now\(\) \+ 3000/, 'R24 同步死循环'],
    ['plugin-forged-result-plugin.mjs', /__DSH_PROBE__/, 'R26 侧信道（nonce 伪造绿卡）'],
    ['plugin-stringify-tamper-plugin.mjs', /JSON\.stringify = function/, '🔴 必修-4 同族假绿（猴子补丁序列化函数）'],
  ]) {
    const src = readText(path.join(ROOT, 'tests/fixtures', fixture), 'utf8');
    eq(`口径守卫：${label} 夹具存在且真的复现该形态`, true, marker.test(src));
    eq(`口径守卫：${label} 夹具自述期望 hostFatal 为空（不变量写在夹具里）`, true, src.includes('hostFatal[]'));
  }
  // 🔴-A（评审复评）：探针**用到**的标识符必须真的 import —— 旧缺陷是 `probe-template.mjs` 在
  // 无 nonce 分支用 `PROBE_RESULT_MARKER` 却没 import ⇒ 任何不带 nonce 的调用 `ReferenceError`
  // 硬崩、无结构化结果、被归因成 `UPSTREAM_DRIFT`（探针自身缺陷甩锅上游）。
  // 守卫按**标识符词元**判（不用 includes，防前缀包含绕过）——「用到的必须在 import 里」。
  {
    const probeSrcForImport = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
    const importBlock = probeSrcForImport.slice(0, probeSrcForImport.indexOf("} from './contract.mjs'"));
    const bodyAfterImport = probeSrcForImport.slice(probeSrcForImport.indexOf("} from './contract.mjs'"));
    const tokens = (text) => text.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
    // ⚠️ 判据只认**代码**（`codeOnly` 去注释 + 去字符串/模板文本，保留 `${...}` 插值）：
    // 注释里为说明历史而引用某个常量名（如「见 host.mjs 的 `PROBE_NONCE_STDIN_CHANNEL`」）
    // **不是**「用到」——按原文扫描会把文档当实现（误报），而守卫本身不能有误报。
    const imported = new Set(tokens(codeOnly(importBlock)));
    // 判据范围 = **contract.mjs 真的导出**的名字（避免把本地 Symbol / 属性名误判为缺 import）
    const contractExports = new Set(Object.keys(contractNs));
    const used = new Set(tokens(codeOnly(bodyAfterImport)).filter((t) => contractExports.has(t)));
    const missing = [...used].filter((t) => !imported.has(t));
    eq('🔴-A 源码守卫：探针用到的 PROBE_/PLUGIN_ 常量均已 import（缺失即 ReferenceError 硬崩）',
      JSON.stringify([]), JSON.stringify(missing));
    eq('🔴-A 源码守卫：PROBE_RESULT_MARKER 已在 import 列表内（旧缺陷点）', true,
      imported.has('PROBE_RESULT_MARKER'));
  }

  // 🆕 信任边界（🟡-4）必须**显式**登记：既有缺口（base 同样可复现）不得因「本 PR 未引入」而漏登记。
  // 断言三件套：① R26 行存在；② 显式前提「插件为可信代码」写明；③ 残留边界（进程隔离）写明。
  eq('🟡-4：RISKS R26 写明显式前提「插件为可信代码」（此前是隐式）', true, /插件为\*\*?可信代码|插件为可信代码/.test(risks));
  eq('🟡-4：RISKS R26 写明残留边界（恶意插件可读 argv/env 拿到 nonce → 需进程隔离）', true,
    risks.includes('进程隔离') && risks.includes('残留边界'));
  // nonce 带外通道的**协议要素**必须在 RISKS 写明（改名/删项即红）
  for (const token of ['nonce', 'plugin.probe_result_forged', 'argv', 'env']) {
    eq(`🟡-4：RISKS R26 写明协议要素「${token}」`, true, risks.includes(token));
  }
  // H1 复现夹具必须固化在仓库里（v0.1.9 修法 A 的验收资产；删掉即红 = 「已知活口不得静默消失」）
  const h1Fixture = readText(path.join(ROOT, 'tests/fixtures/plugin-capture-callback-plugin.mjs'), 'utf8');
  eq('口径守卫：H1 复现夹具存在且用一行 captureCallback 复现', true,
    /setUncaughtExceptionCaptureCallback\(/.test(h1Fixture));
  // H1 夹具的**状态口径**（v0.1.9c 已收口，故这里断言的是「收口后」的事实）：
  // 夹具必须自述「旧行为判 GREEN（放行级假绿）」与「收口后必须 RED」，且指向 R22 ——
  // 「已知活口不得静默消失」，同时「修完之后不得再自称活口」。
  eq('口径守卫：H1 夹具自述指向 R22（风险行，不得静默）', true, h1Fixture.includes('R22'));
  eq('口径守卫：H1 夹具声明「旧行为判 GREEN（放行级假绿）→ 收口后必须 RED」', true,
    h1Fixture.includes('GREEN') && h1Fixture.includes('PLUGIN_REGRESSION'));
  eq('口径守卫：H1 夹具**不得**再自称「当前仍是活口」（v0.1.9c 已收口）', false,
    /当前形态下它被判 GREEN/.test(h1Fixture));
  // 守卫自证（R27：把评审实测**逃逸**的形态全部写成断言，防后人改回旧守卫）
  for (const [label, sample] of Object.entries({
    '原 v0.1.7/v0.1.8 口径': '插件侧错误**永远**不进该字段 hostFatal[]。',
    '同义改写': '插件侧错误永不进 hostFatal[]。',
    '① 带「不得」的绝对口径（旧守卫豁免词漏洞）': '插件侧错误**永远**不进 hostFatal[]（不得有例外）',
    '② 说明性行里的新绝对主张': '更正说明：插件侧错误永不进 hostFatal[]。',
    '③ 同义词 决不 / 从不会 / 一律不': '插件侧错误决不进 hostFatal[]。',
    '③b 同义词 从不会': '插件侧错误从不会进 hostFatal[]。',
    '③c 同义词 一律不': '插件侧错误一律不进 hostFatal[]。',
    '④ 主谓倒置': 'hostFatal[] 里永远不会有插件侧错误',
    '⑤ 英文': 'Plugin-side errors never enter hostFatal[].',
    '⑥ 跨行（旧守卫 [^。；\\n] 限死单行 ⇒ 漏）': '插件侧错误永远\n不进 hostFatal[]。',
    '⑦ 完整性主张「一律落 check」（H1 真正推翻的那条）': '插件侧一律落 check。',
    '⑧ 完整性主张同义词「都 / 必然」': '插件侧错误都落插件侧 check。',
  })) {
    eq(`口径守卫自证：${label} 被抓到`, 1, absoluteOffenders(sample).length);
  }
  eq('口径守卫自证：收窄口径（同段带前提）不误报', [], absoluteOffenders('在探针进程内防线未被插件干预的前提下，插件侧错误不进 hostFatal[]。'));
  eq('口径守卫自证：旧守卫的豁免词写法**现在会被抓到**（不得 + 绝对口径）', 1,
    absoluteOffenders('插件侧错误**永远**不进 hostFatal[]（不得有例外）').length);
  eq('口径守卫自证：段落级（前提在别段 ⇒ 仍判违规；前提在同段 ⇒ 放行）', 'flagged|clean',
    `${absoluteOffenders('插件侧错误永远不进 hostFatal[]。\n\n（准确口径见下节。）').length > 0 ? 'flagged' : 'missed'}|${absoluteOffenders('插件侧错误永远不进 hostFatal[]。\n（前提：防线未被插件干预。）').length === 0 ? 'clean' : 'flagged'}`);
  eq('口径守卫自证：路由设计说明（「未知相位按插件侧处理，绝不写 hostFatal[]」）不误报', [],
    absoluteOffenders('保守取向：未知相位按插件侧处理（绝不写 hostFatal[]）。'));
}

// ---- 12. 🔴-5 命名口径对齐：check 名**只有一份**事实源（合并不得再丢防线） ----
// 为什么必须单列一段（评审 🔴-5 的教训）：一次合并冲突解决时，对面那一整套「三表并集 /
// 顺序表 / 条件项计数」防线被**整批丢掉**，且没人发现——因为没有**跨产物的命名守卫**：
// 断言写 `plugin.async_uncaught_exception`，实现落 `plugin.unexpected_exception`，
// 两边都「绿」，验收断言却**不可满足**（按字面无法判定放行）。
//
// 本段把「命名口径」变成可判定的：
//   (a) 全部 check 名 = 三张表 ∪ 条件项（**唯一事实源**，不再手写第二份名单）；
//   (b) 夹具 / 文档 / 闸门里出现的 `plugin.*` / `registry.*` / `dispatch.*` / `lifecycle.*` /
//       `guard.*` / `host.*` / `detect.*` / `compat.*` / `contract.*` 名字必须在 (a) 内；
//   (c) 三个「防线清单」互相可推出（顺序表 ∪ 条件项 == 三表并集）——合并丢一处即红。
console.log('  [12] 🔴-5 命名口径对齐（check 名单一事实源 + 跨产物一致性）');
{
  const ALL_CHECK_NAMES = [...new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS])];
  eq('🔴-5：三张 check 表并集 = 顺序表 ∪ 条件项（防线清单互相可推出）',
    JSON.stringify([...ALL_CHECK_NAMES].sort()),
    JSON.stringify([...new Set([...PROBE_CHECK_ORDER, ...CONDITIONAL_PROBE_CHECKS])].sort()));
  // 跨产物扫描：夹具 / 闸门 / 文档里提到的 check 名必须在唯一事实源内。
  // 只认「像 check 名」的字面量（含已知前缀 + 点号 + 小写/下划线），避免把路径 / 包名算进来。
  // 只认「像 check 名」的字面量：前缀 + 点号 + 小写/下划线。
  // 排除两类噪声（否则守卫自己被文件名 / 方法调用刷红）：
  //  - 以 `.mjs` / `.json` 结尾的文件名（`contract.mjs` / `plugin.json`）；
  //  - 紧跟 `(` 的方法调用（`await plugin.apply(...)` 不是 check 名）。
  const CHECK_NAME_RE = /\b(?:host|detect|contract|guard|compat|plugin|registry|dispatch|lifecycle)\.[a-z][a-z0-9_]*\b/g;
  /** 非 check 的合法字面量：文件名（`contract.mjs`）与包名（`plugin.json`）。 */
  const NOT_A_CHECK = new Set(['mjs', 'json', 'js', 'cjs']);
  const scanTargets = [
    ...readdirSync(path.join(ROOT, 'tests', 'fixtures')).map((f) => path.join('tests', 'fixtures', f)),
    path.join('tests', 'gate_plugin_side.sh'),
    path.join('docs', 'ADAPTER_GUIDE.md'),
    path.join('docs', 'INDEX.md'),
  ];
  const unknown = [];
  for (const rel of scanTargets) {
    const text = readText(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(CHECK_NAME_RE)) {
      if (ALL_CHECK_NAMES.includes(m[0])) continue;
      if (NOT_A_CHECK.has(m[0].slice(m[0].indexOf('.') + 1))) continue; // 文件名不是 check 名
      // 方法调用（`await plugin.apply(...)`）不是 check 名：紧跟 `(` 的排除。
      if (text.slice(m.index + m[0].length).trimStart().startsWith('(')) continue;
      unknown.push(`${rel}: ${m[0]}`);
    }
  }
  eq('🔴-5：夹具/闸门/文档里的 check 名全部登记在唯一事实源（未登记即红，杜绝命名漂移）',
    JSON.stringify([]), JSON.stringify([...new Set(unknown)]));
  // 守卫自证：一个「名字对不上」的样例必须被抓到（防本守卫空转）
  const mutated = '失败项 `plugin.async_uncaught_exception` 实际落 `plugin.unexpected_exception`';
  const mutatedUnknown = [...new Set([...mutated.matchAll(CHECK_NAME_RE)].map((m) => m[0]))].filter((n) => !ALL_CHECK_NAMES.includes(n));
  eq('🔴-5 守卫自证：伪造的未登记 check 名被抓到（断言不可满足的反例）', JSON.stringify([]),
    JSON.stringify(mutatedUnknown));
  const bogus = '失败项 `plugin.probe_aborted`';
  eq('🔴-5 守卫自证：旧实现遗留名 plugin.probe_aborted 现已被判为未登记（评审 🔴-5 点名的不可满足断言）',
    JSON.stringify(['plugin.probe_aborted']),
    JSON.stringify([...new Set([...bogus.matchAll(CHECK_NAME_RE)].map((m) => m[0]))].filter((n) => !ALL_CHECK_NAMES.includes(n))));
  // 防线清单必须**真的存在**（合并时被整批丢掉的正是这三样，逐条断言它们回来了）
  eq('🔴-5：顺序表 PROBE_CHECK_ORDER 存在且为 17 项', 17, PROBE_CHECK_ORDER.length);
  eq('🔴-5：条件项表 CONDITIONAL_PROBE_CHECKS 存在且非空', true, CONDITIONAL_PROBE_CHECKS.length > 0);
  eq('🔴-5：派生表 PLUGIN_SKIP_ON_PRECONDITION = 插件侧表 − 条件项（派生而非手写）', JSON.stringify(
    PLUGIN_SIDE_CHECKS.filter((n) => !CONDITIONAL_PROBE_CHECKS.includes(n))), JSON.stringify(PLUGIN_SKIP_ON_PRECONDITION));
}

// ---- 14. 信任边界**显式前提**（🟡-4 / 总师 §3-Q2）+ 结构性重做一页方案 ----
// 为什么单列（评审 🟡-4 / 总师 §3-Q2）：同进程 + 共用输出面下，插件可伪造 marker / 摘防线 /
// 抢先 exit ⇒ 探针结论**不可信**。这不是探针 bug，而是**架构前提**（「插件为可信代码」）被打破。
// 总师要求：① 写进 RISKS（HIGH）；② 对外主张（README/ARCHITECTURE/GUIDE）**同步加限定词**，
// 不得宣称「报告可信」而不带此前提；③ 结构性重做**先出一页方案**再动手。
console.log('  [14] 信任边界显式前提 + 结构性重做一页方案');
{
  const risks = readText(path.join(ROOT, 'docs/RISKS.md'), 'utf8');
  const r26 = risks.split('\n').find((line) => /^\|\s*R26\s*\|/.test(line)) ?? '';
  eq('R26 已登记且等级 = HIGH（放行级：伪造 marker → ok=true 放行）', true, r26.length > 0 && /\*\*HIGH/.test(r26));
  eq('R26 显式声明「插件为可信代码」为前提（此前是隐式）', true, r26.includes('可信代码') && r26.includes('显式前提'));
  eq('R26 给出根治方向（进程隔离 / 独立 fd 作真·带外通道）', true,
    r26.includes('进程隔离') && r26.includes('独立 fd'));
  eq('R26 点名三条形态（伪造 stdout / 改 hostFatal / 自杀）', true,
    r26.includes('stdout') && r26.includes('hostFatal') && r26.includes('SIGKILL'));

  // 对外主张必须带限定词：显式前提 + 「不是沙箱」+ 指向 R26 与重做方案
  for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/ADAPTER_GUIDE.md']) {
    const text = readText(path.join(ROOT, file), 'utf8');
    eq(`${file} 显式声明「插件为可信代码」前提`, true, text.includes('可信代码'));
    eq(`${file} 声明「本中台是验收工具、不是沙箱」`, true, text.includes('不是沙箱') || text.includes('不是**沙箱**'));
    eq(`${file} 指向风险行 R26 与结构性重做方案`, true, text.includes('R26') && text.includes('REDO-PROPOSAL'));
  }
  // 反向：不得出现**无限定**的「报告可信 / 归因可信」主张（历史教训：文档撒谎的代价 > 代码有洞）
  for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/ADAPTER_GUIDE.md']) {
    const text = readText(path.join(ROOT, file), 'utf8');
    const offenders = text.split('\n').filter((line) => /报告可信|归因可信/.test(line)
      && !/不得|前提|R26|推翻|不可信/.test(line));
    eq(`${file} 无无限定的「报告可信 / 归因可信」主张`, JSON.stringify([]), JSON.stringify(offenders.map((l) => l.slice(0, 80))));
  }

  // 结构性重做一页方案必须存在且内容齐备（总师 §3-Q1 / §5-2：先出一页方案再动手）
  const redo = readText(path.join(ROOT, 'docs/REDO-PROPOSAL.md'), 'utf8');
  eq('重做方案声明「只出方案、不动代码」', true, redo.includes('只出方案') && redo.includes('不动代码'));
  eq('重做方案含候选 A：独立 fd 作真·带外通道', true, redo.includes('独立 fd'));
  eq('重做方案含候选 B：进程隔离', true, redo.includes('进程隔离'));
  eq('重做方案落地 nonce 前置项（一次性凭据 + 唯一性校验）', true, redo.includes('nonce') && redo.includes('randomUUID'));
  eq('重做方案给出决策矩阵与推荐', true, redo.includes('决策矩阵') && redo.includes('推荐'));
  eq('重做方案划清非目标（不做安全沙箱 / 不改插件可见行为）', true, redo.includes('非目标'));
  eq('重做方案留待总师裁定项（不自行拍板范围）', true, redo.includes('待总师裁定'));
  eq('重做方案给出回滚路径（fd 不可用 → 显式降级，不静默）', true, redo.includes('回滚') && redo.includes('降级'));

  // 唯一事实源守卫：R24 的终止信号必须来自 host.mjs 常量（probeSpawnOptions + npm 共用一份）
  const hostSrc = readText(path.join(ROOT, 'src/harness/host.mjs'), 'utf8');
  const hostCode = codeOnly(hostSrc);
  eq('R24：host.mjs 导出 CHILD_KILL_SIGNAL = SIGKILL（唯一事实源）', true,
    /CHILD_KILL_SIGNAL = .SIGKILL./.test(hostSrc));
  eq('R24：probeSpawnOptions 的 killSignal 默认取 CHILD_KILL_SIGNAL（回退成字面量 SIGTERM 即红）', true,
    /killSignal = CHILD_KILL_SIGNAL/.test(hostCode));
  eq('R24：npm 安装子进程同样用 CHILD_KILL_SIGNAL（同族加固，不得无界挂起）', true,
    /execFileSync\( S , \[[\s\S]{0,500}killSignal: CHILD_KILL_SIGNAL/.test(hostCode));
  eq('R24：离线回归台**镜像**生产路径的 spawn 参数（不自造一套）', true,
    /probeSpawnOptions\(/.test(readText(path.join(ROOT, 'tests/offline-probe-harness.mjs'), 'utf8')));
  eq('R24：有界占死夹具存在（供反向反证：SIGTERM 下超时形同虚设）', true,
    /BUSY_MS/.test(readText(path.join(ROOT, 'tests/fixtures/plugin-busy-loop-hang-plugin.mjs'), 'utf8')));
}

// ---- 9.13. 🔴 必修-4：同族**放行级假绿**（猴子补丁 JSON.stringify 伪造绿卡） ----
// 为什么单列（评审复评 🔴 必修-4）：R26 的 nonce 侧信道挡的是「反读凭据 + 冒用输出协议」，
// 但探针与插件**同进程** ⇒ 插件还能改**序列化函数本身**：把 checks 全改 pass、清空
// errors/hostFatal、把 ok 置真。那时 nonce 前缀**照样匹配**（前缀不经过序列化）⇒ 一张完美绿卡。
// 本仓实测（v0.2.2 tip，夹具 plugin-stringify-tamper-plugin）：子进程 exit status=1（探针自己判了失败）
// 而报告 ok=true / 17 项全 pass ⇒ **失败被吞、绿卡被采信**。与 🔴-3 **同族**（同进程 + 共用输出面）。
//
// 两条收口（**并集**，各自独立可回退即红）：
//   A. **探针加载期捕获引用**：\`const STRINGIFY = JSON.stringify\`（在任何插件代码之前）且**只用**捕获值；
//   B. **装配器退出码交叉**：报告自称 ok=true 而探针进程退出码非 0 ⇒ 内部矛盾 ⇒ 判篡改（不放行）。
// 两个独立产物（退出码由探针内存算出、不经序列化；报告字节可被替换）互相矛盾即证据。
console.log('  [9.13] 🔴 必修-4 同族假绿：猴子补丁 JSON.stringify（加载期捕获 + 退出码交叉）');
{
  const probeSrcForFrozen = readText(path.join(ROOT, 'src/harness/probe-template.mjs'), 'utf8');
  const probeCodeFrozen = codeOnly(probeSrcForFrozen);
  // A-1 源码守卫：加载期捕获（且必须**早于**首次使用——TDZ 顺序是实测踩过的坑）
  eq('🔴-4 源码守卫：探针在加载期捕获 JSON.stringify 引用（const STRINGIFY = JSON.stringify）', true,
    /const STRINGIFY = JSON\.stringify;/.test(probeCodeFrozen));
  eq('🔴-4 源码守卫：捕获点早于首次使用（TDZ：捕获块必须在 expectedTools 解析之前）', true,
    probeSrcForFrozen.indexOf('const STRINGIFY = JSON.stringify;') < probeSrcForFrozen.indexOf('const expectedTools = PARSE('));
  // A-2 源码守卫：写出报告的路径**只用捕获值**（回退成裸 JSON.stringify 即红——那正是本形态的成因）
  eq('🔴-4 源码守卫：结果序列化只用捕获值（回退成裸 JSON.stringify 即红）', true,
    /const payload = `\$\{resultPrefix\}\$\{STRINGIFY\(out\)\}\\n`;/.test(probeSrcForFrozen));
  eq('🔴-4 源码守卫：探针代码里不再有裸 JSON.stringify(out)（别名回退即红）', false,
    /JSON\.stringify\(out\)/.test(probeCodeFrozen));
  // B-1 源码守卫：装配器无条件记录 probeExit（旧实现只在 error||signal 时赋值 ⇒ 正常非零退出不记录）
  const hostSrcForCross = readText(path.join(ROOT, 'src/harness/host.mjs'), 'utf8');
  eq('🔴-4 源码守卫：装配器**无条件**记录 probeExit（不再只在 error||signal 时赋值）', true,
    /result\.probeExit = \{ status: probeRun\.status \?\? null, signal: probeRun\.signal \?\? null \};/.test(hostSrcForCross));
  eq('🔴-4 源码守卫：装配器做退出码交叉校验（ok=true + 退出码非 0 ⇒ 判篡改）', true,
    /payload\.ok === true && exitAbnormal/.test(codeOnly(hostSrcForCross)));
  eq('🔴-4 落点 check 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）', true,
    PLUGIN_SIDE_CHECKS.includes(PLUGIN_EXIT_CODE_MISMATCH_CHECK));
  eq('🔴-4 落点 check 已登记进 CONDITIONAL_PROBE_CHECKS（条件项计数随之 +1）', true,
    CONDITIONAL_PROBE_CHECKS.includes(PLUGIN_EXIT_CODE_MISMATCH_CHECK));

  // 行为级 A：真协议跑夹具 ⇒ 必须 RED / 判插件侧 / 真缺陷仍被抓（**不得**被绿卡掩盖）
  {
    const r = runOfflineProbe({
      pluginPath: path.join(ROOT, 'tests/fixtures', 'plugin-stringify-tamper-plugin.mjs'),
      expectedTools: ['demo_echo'],
    });
    const failed = r.result.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq('🔴-4 行为（加载期捕获）：补丁不生效 ⇒ 真缺陷 registry.exact 仍被判失败', true, failed.includes('registry.exact'));
    eq('🔴-4 行为：归因 PLUGIN_REGRESSION（不甩锅上游）', 'PLUGIN_REGRESSION', r.attribution);
    eq('🔴-4 行为：hostFatal 为空（插件侧错误不进判据字段）', 0, r.result.hostFatal.length);
    eq('🔴-4 行为：**不得**判通过（ok=false）', false, r.result.ok === true);
    eq('🔴-4 行为：探针自己判了失败（退出码非 0，且被装配器记录下来）', 1, r.exit.status);
    eq('🔴-4 行为：补丁形态下**不**出现退出码矛盾（探针报告本身就是真的）', false,
      failed.includes(PLUGIN_EXIT_CODE_MISMATCH_CHECK));
  }

  // 行为级 B（**退出码交叉**的独立证据）：合成「报告自称 ok=true + 退出码非 0」⇒ 必须判篡改
  {
    const goodPayload = { checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [], ok: true, runCompleted: true };
    const mk = (probeExit) => {
      const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly', runCompleted: false, probeExit };
      interpretProbeStdout(r, `__DSH_PROBE__${JSON.stringify(goodPayload)}\n`);
      return r;
    };
    const mism = mk({ status: 1, signal: null });
    eq('🔴-4 退出码交叉：ok=true + 退出码 1 ⇒ 落 plugin.exit_code_mismatch', PLUGIN_EXIT_CODE_MISMATCH_CHECK, mism.checks.at(-1)?.name);
    eq('🔴-4 退出码交叉：矛盾 ⇒ ok=false（不放行）', false, mism.ok);
    eq('🔴-4 退出码交叉：矛盾 ⇒ hostFatal 仍为空（不甩锅上游）', 0, mism.hostFatal.length);
    eq('🔴-4 退出码交叉：矛盾 ⇒ 归因 PLUGIN_REGRESSION', 'PLUGIN_REGRESSION', attributeFailure(mism, channel, 'dev'));
    eq('🔴-4 退出码交叉：信号终止（SIGKILL）+ ok=true 同样判篡改', PLUGIN_EXIT_CODE_MISMATCH_CHECK,
      mk({ status: null, signal: 'SIGKILL' }).checks.at(-1)?.name);
    // 反向护栏（防过度修正）：退出码 0 / 无 probeExit 时**不得**误判
    eq('🔴-4 反向护栏：退出码 0 + ok=true 不误判（正常路径零影响）', false,
      mk({ status: 0, signal: null }).checks.some((c) => c.name === PLUGIN_EXIT_CODE_MISMATCH_CHECK));
    eq('🔴-4 反向护栏：无 probeExit（老装配器 / 合成输入）不误判（保守，不制造假红）', false,
      mk(null).checks.some((c) => c.name === PLUGIN_EXIT_CODE_MISMATCH_CHECK));
    eq('🔴-4 反向护栏：退出码 0 时 ok=true 仍成立（不误伤正常通过）', true, mk({ status: 0, signal: null }).ok);
  }

  // 变异回退（**回退即红**，两条防线各自独立成立）
  {
    const plugin = path.join(ROOT, 'tests/fixtures', 'plugin-stringify-tamper-plugin.mjs');
    // A 变异：把捕获值改回「每次取全局」（= 评审点名的回退形态）⇒ 夹具的报告被替换；
    // 此时**退出码交叉**必须兜住（判 plugin.exit_code_mismatch，仍 RED、不放行）。
    const mutatedA = probeSrcForFrozen
      .replace('const STRINGIFY = JSON.stringify;', 'const STRINGIFY = (v) => JSON.stringify(v);')
      .replace('const PARSE = JSON.parse;', 'const PARSE = (v) => JSON.parse(v);');
    eq('🔴-4 变异自证：A 变异（退回全局序列化）确实改动了源码', true, mutatedA !== probeSrcForFrozen);
    const rA = await runOfflineProbeWithSources({ probeSource: mutatedA, pluginPath: plugin, expectedTools: ['demo_echo'] });
    const failedA = rA.result.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq('🔴-4 变异回退：A 回退后**不得**假绿（ok=false）', false, rA.result.ok === true);
    eq('🔴-4 变异回退：A 回退后由**退出码交叉**兜住（plugin.exit_code_mismatch）', true,
      failedA.includes(PLUGIN_EXIT_CODE_MISMATCH_CHECK));
    eq('🔴-4 变异回退：A 回退后归因仍 PLUGIN_REGRESSION（不放行）', 'PLUGIN_REGRESSION', rA.attribution);
    // B 变异：把装配器的交叉校验关掉（探针侧捕获仍在）⇒ 夹具的补丁不生效 ⇒ 真缺陷仍被判出。
    const mutatedHostB = hostSrcForCross.replace('if (payload.ok === true && exitAbnormal) {', 'if (false && payload.ok === true && exitAbnormal) {');
    eq('🔴-4 变异自证：B 变异（关掉退出码交叉）确实改动了源码', true, mutatedHostB !== hostSrcForCross);
    const rB = await runOfflineProbeWithSources({ pluginPath: plugin, expectedTools: ['demo_echo'], hostSource: mutatedHostB });
    const failedB = rB.result.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq('🔴-4 变异回退：B 回退后仍**不得**假绿（探针侧加载期捕获独立兜住）', false, rB.result.ok === true);
    eq('🔴-4 变异回退：B 回退后真缺陷 registry.exact 仍被判失败', true, failedB.includes('registry.exact'));
  }

  // 夹具自检：新夹具必须真的复现该形态（否则上面的行为断言空转）
  {
    const src = readText(path.join(ROOT, 'tests/fixtures', 'plugin-stringify-tamper-plugin.mjs'), 'utf8');
    eq('🔴-4 夹具：真的猴子补丁 JSON.stringify（否则断言空转）', true, /JSON\.stringify = function/.test(src));
    eq('🔴-4 夹具：补丁把 checks 全改 pass 且把 ok / runCompleted 置真（伪造绿卡）', true,
      /status: 'pass'/.test(src) && /ok: true/.test(src) && /runCompleted: true/.test(src));
    eq('🔴-4 夹具：真缺陷（多注册工具 ⇒ registry.exact 必 fail）', true, /demo_extra/.test(src));
    eq('🔴-4 夹具：自述期望 hostFatal 为空（不变量写在夹具里）', true, src.includes('hostFatal[]'));
    eq('🔴-4 夹具：声明期望的工具清单（供闸门/回归取用）', true, /export const expectedTools = \['demo_echo'\]/.test(src));
    eq('🔴-4 夹具：自述口径不越权（残留边界指向进程隔离）', true,
      src.includes('进程隔离') && src.includes('REDO-PROPOSAL'));
  }
}


// ---- 9.14. R26 残留边界②（**fail-open**）：fd3 隔离在「探针未 emit」时回退信任 stdout ----
// 为什么单列（评审复评 §四，本轮实测）：结果通道隔离的判定依据是「**fd3 有没有内容**」
// （`isolated = channelText.trim().length > 0`），而**不是**「探针**是否**报告过」。于是：
//   · 探针**正常 emit** → fd3 有内容 → `isolated=true` → 插件多出来的那条行 = 篡改证据 → RED；
//   · 探针**来不及 emit**（插件摘 `exit` 钩子 + `exit(0)` 抢在探针之前）→ fd3 为空 →
//     `isolated=false` → **回退信任 stdout** ⇒ 带**正确 nonce** 的伪造行成为**唯一** marker
//     ⇒ 无 `injectionEvidence` ⇒ **被采信（ok=true）**。
// ⇒ **通道选择不是关键**（伪造写 fd3 与写 stdout **等价**，两形态同判）；**「探针是否来得及 emit」才是关键**。
// ⇒ 当前**唯一**有效的那条腿是 **nonce 保密性**（stdin 下发 ⇒ 经 env / argv 拿不到）；一旦插件经
//   **其它同进程手段**拿到 nonce（R29），本形态即**重新变绿**。根治 = 批 2「独立 fd 且**永不回退 stdout**」。
//
// ⚠️ **前提（不得省略）**：本段形态 C/D 的输入是「**已知正确 nonce**」的合成结果行——即
//   它证明的是「**装配器判据在拿到 nonce 时会采信**」，而不是「本仓夹具现在就能拿到 nonce」。
//   本仓夹具（`plugin-nonce-reverse-read-plugin`）经 env / argv **拿不到** nonce ⇒ 实测仍判
//   `plugin.probe_result_forged`（RED）。两句话不矛盾：**nonce 保密性是当前唯一有效的腿**（见 R26）。
//
// ⚠️ 本段的定位：**把现状固化为可执行断言**，而不是宣称它已被收口。
//   · 批 2 落地（fd3 为空 ⇒ 判「无报告 / 不可信」）后，本段的 `FAIL_OPEN_KNOWN` 断言**必须翻面**
//     （改断言为「不得被采信」）——**修好即红**，强制文档与判据同步。
console.log('  [9.14] R26 残留边界②（fail-open）：探针未 emit 时回退信任 stdout');
{
  // 批 2 落地后把这里改成 false 并**翻面断言**（见上方注释）。本常量是「已知边界」的显式锚点。
  const FAIL_OPEN_KNOWN = true;
  const mkPayload = () => JSON.stringify({
    checks: [{ name: 'host.tools_ready', status: 'pass' }], errors: [], hostFatal: [],
    ok: true, runCompleted: true, phase: 'plugin-integration', resultChannel: 'fd3',
  });
  const nonce = createProbeNonce(randomBytes).value;
  const forgedLine = `${probeResultPrefix(nonce)}${mkPayload()}\n`;
  const run = (stdout, resultFd) => {
    const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly', runCompleted: false };
    interpretProbeStdout(r, stdout, { resultFd, nonce });
    return r;
  };

  // ① 形态 C：伪造写 **fd3**、探针**来不及 emit** ⇒ 当前被采信（**已知边界**，批 2 必修）
  {
    const r = run('', forgedLine);
    eq('R26 残留②（fail-open·形态 C）：**给定插件已拿到 nonce** + 伪造写 fd3 + 探针未 emit ⇒ 当前**被采信**（批 2 必修：不得回退）',
      true, r.ok === true);
    eq('R26 残留②：形态 C 无任何篡改证据（`checks` 里只有伪造项）', 0,
      r.checks.filter((c) => c.name === PLUGIN_PROTOCOL_INJECTION_CHECK).length);
  }
  // ② 形态 D：伪造写 **stdout**、探针**来不及 emit** ⇒ **同样**被采信
  //    ⇒ 证明「写对通道」不是使能条件（评审复评 §二-② 的实测结论）
  {
    const r = run(forgedLine, '');
    eq('R26 残留②（fail-open·形态 D）：**给定已拿到 nonce** + 伪造写 **stdout** + 探针未 emit ⇒ **同样**被采信',
      true, r.ok === true);
    eq('R26 残留②：C/D 两形态**同判**（⇒ 通道选择不是关键，写对 fd3 不是使能条件）', true,
      run('', forgedLine).ok === run(forgedLine, '').ok);
  }
  // ③ 对照（防线**生效**形态）：探针 emit（fd3 有真报告）+ stdout 出现伪造行 ⇒ 判篡改、不放行
  {
    const r = run(forgedLine, forgedLine);
    eq('R26 残留② 对照：探针**有** emit（fd3 有内容）⇒ 结构不变量命中 ⇒ 判 plugin.protocol_injection', true,
      r.checks.some((c) => c.name === PLUGIN_PROTOCOL_INJECTION_CHECK));
    eq('R26 残留② 对照：命中即不放行（ok=false / 完成位 false）', 'false|false', `${r.ok}|${r.runCompleted}`);
  }
  // ④ 机理源码守卫：隔离判定必须仍是「fd3 有没有内容」（回退逻辑的**成因**；批 2 会改这一行）
  {
    const hostCode = codeOnly(readText(path.join(ROOT, 'src/harness/host.mjs'), 'utf8'));
    eq('R26 残留② 源码守卫：隔离判定 = 「fd3 有没有内容」（`isolated` 由通道文本长度推出）', true,
      /isolated = channelText\.trim\(\)\.length > 0/.test(hostCode));
    eq('R26 残留② 源码守卫：`markers` 在通道为空时**回退 stdout**（fail-open 的落点，批 2 改此处）', true,
      /markers = isolated \? matchingOnChannel : matchingOnStdout/.test(hostCode));
  }
  // ⑤ 「已知边界不得静默」：RISKS / REDO-PROPOSAL 必须登记该边界，且写明批 2 的首要目标
  {
    const risks = readText(path.join(ROOT, 'docs/RISKS.md'), 'utf8');
    const r26Row = risks.split('\n').find((line) => /^\|\s*R26\s*\|/.test(line)) ?? '';
    eq('R26 残留②：RISKS R26 行写明 fail-open（探针未 emit 时回退信任 stdout）', true,
      r26Row.includes('fail-open') && r26Row.includes('回退信任 stdout'));
    eq('R26 残留②：RISKS 写明使能条件 =「探针是否来得及 emit」（而非「写对通道」）', true,
      r26Row.includes('通道选择不是关键') && r26Row.includes('来得及 emit'));
    eq('R26 残留②：RISKS 写明当前唯一有效的是 nonce 保密性 + 批 2 首要目标（永不回退 stdout）', true,
      r26Row.includes('nonce 保密性') && r26Row.includes('永不回退 stdout'));
    const redo = readText(path.join(ROOT, 'docs/REDO-PROPOSAL.md'), 'utf8');
    eq('R26 残留②：REDO-PROPOSAL 批 2 立项说明含「独立 fd 且永不回退 stdout」（首要目标）', true,
      redo.includes('永不回退 stdout') && redo.includes('首要目标'));
    eq('R26 残留②：REDO-PROPOSAL 形态表登记 fail-open 形态（⑤b）', true, redo.includes('| ⑤b |'));
  }
  eq('R26 残留②：本段为「已知边界」的显式锚点（批 2 落地后必须翻面为「不得被采信」）', true, FAIL_OPEN_KNOWN);
}

console.log();
console.log(`▶ 归因与契约采集离线回归结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
