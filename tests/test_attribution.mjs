/**
 * 归因与契约采集的**离线**回归（不联网、不装宿主）。
 *
 * 为什么单独成文件：评审 🔴-A / 🔴-B 的失效面都落在「归因判据」与「契约采集副作用」上，
 * 而这两处过去只被真宿主 E2E 覆盖（跑得慢、依赖网络）。本文件用**假 tools** 把同一份
 * 实现拉进离线单测：判据一变就红，不必等 CI 装宿主。
 *
 * 覆盖：
 * 1. `collectContract()`：接受型宿主（上游取消保留名）采集后**必须立即卸载**，无残留；
 * 2. `attributeFailure()` / `attributionDetail()`：宿主侧 `fatal(host)` 与插件侧 check 互不串味；
 * 3. 🔴-B 回归：错误串里含 `npm` 路径（探针命令行回显）**不得**把插件 bug 判成上游漂移；
 * 4. 旧版 `fatal:` 措辞（插件侧）**不得**再判漂移；
 * 5. CLI 参数契约：带值参数缺值显式报错（不静默改语义）、`resolveChannels` 默认值可指定；
 * 6. 缓存维护：`pruneHostCache()` 有真实调用点（`keepFingerprintsFor` + `cache` 子命令）。
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
import { channelFingerprint, loadChannels, pruneHostCache } from '../src/harness/host.mjs';

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
const probeOf = (errors, checks = []) => ({ errors, checks, profile: { flavor: 'modern' }, contract: {} });

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
console.log('  [2] 归因判据（宿主侧 fatal(host) vs 插件侧 check）');
eq('宿主安装失败（npm ETARGET）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['fatal(host): 宿主依赖安装失败（npm）：npm ERR! code ETARGET']), channel, 'dev'));
eq('离线缺缓存 → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['fatal(host): 离线模式下缺少宿主依赖缓存（先联网跑一次或去掉 --offline）']), channel, 'dev'));
eq('宿主未就绪 → UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure({ errors: ['host.tools_ready: ctx.tools 未就绪'], checks: [failCheck('host.tools_ready')], profile: { flavor: 'unknown' } }, channel, 'dev'));
eq('契约探测未卸载（宿主 register 语义变了）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['contract.probe_disposed: 契约探测残留 run_code'], [failCheck('contract.probe_disposed')]), channel, 'dev'));
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
eq('🔴-B：宿主侧 fatal(host) 前缀仍判漂移（不能因收窄判据丢掉真漂移）', 'UPSTREAM_DRIFT',
  attributeFailure(probeOf(['fatal(host): 宿主装配失败：Cannot find package @deepseek-ai/dsh-tools']), channel, 'dev'));

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
  eq('归因不再使用裸 npm / 裸 fatal: 判据', 'no-bare-keywords',
    /\/npm\||\|npm\||fatal:/.test(runnerSource.replace(/\/\*[\s\S]*?\*\//g, '')) ? 'bare-keywords-present' : 'no-bare-keywords');
  eq('归因返回值不再声明 ENV_ERROR', 'no-env-error',
    /ENV_ERROR/.test(runnerSource.split('@returns')[1]?.slice(0, 200) ?? '') ? 'env-error-declared' : 'no-env-error');
}

console.log();
console.log(`▶ 归因与契约采集离线回归结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
