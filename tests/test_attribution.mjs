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
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync as readText } from 'node:fs';
import { CONTRACT_SIDE_CHECKS, HOST_SIDE_CHECKS, PLUGIN_HARD_EVIDENCE, PLUGIN_SIDE_CHECKS, collectContract } from '../src/harness/contract.mjs';
import { attributeFailure, attributionDetail } from '../src/verify/runner.mjs';
import { ALL_CHANNELS, keepFingerprintsFor, parseArgs, resolveChannels } from '../src/cli.mjs';
import { channelFingerprint, loadChannels, pruneHostCache, runHostProbe } from '../src/harness/host.mjs';

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

console.log();
console.log(`▶ 归因与契约采集离线回归结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
