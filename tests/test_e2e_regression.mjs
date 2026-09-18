/**
 * 端到端归因回归（**真宿主**；评审 🔴-A / 🔴-B 的原始复现场景）。
 *
 * 与 `tests/test_attribution.mjs` 的分工：
 * - 离线那份用**假 tools** 覆盖判据与采集逻辑（快、无网、每次都跑）；
 * - 本文件用**真宿主**覆盖同一失效面（慢、需缓存/网络，CI 上跑）。
 *
 * 场景：
 * 1. **上游取消保留名**（打补丁的真宿主：`register({name:'run_code'})` 不再抛错）
 *    → 期望 `GREEN`（插件健康）且 `contractDrift` 如实记录 `reservedName` 变化；
 *    历史缺陷下这里会因契约探测残留 `run_code` 而报 `registry.exact` 假失败。
 * 2. **插件 `apply()` 抛错** → 期望 `PLUGIN_REGRESSION`（历史缺陷：报成 `UPSTREAM_DRIFT`）。
 * 3. **插件语法错误** → 期望 `PLUGIN_REGRESSION`。
 * 4. **插件未导出 `apply`** → 期望 `PLUGIN_REGRESSION`。
 * 5. **插件多注册工具** → 期望 `PLUGIN_REGRESSION`（且路径含 `npm` 也照样判插件）。
 * 6. **漂移窗口 + 插件声明保留名**（🔴-C 之一：漂移相关性吞掉插件侧硬违规）→ 仍须
 *    `PLUGIN_REGRESSION`，且同窗口内的健康插件仍须 `PASS`（反向护栏不被打穿）。
 * 7. **🔴-C 之二（判据扫自由文本）**：插件文件所在**目录名含 `fatal(host)`** → 期望
 *    `PLUGIN_REGRESSION`（判据只读结构化 `hostFatal[]`，不扫插件侧 stack/路径文本）。
 * 8. **真宿主侧致命信号**（离线缺缓存）→ 期望 `UPSTREAM_DRIFT` 且 `hostFatal` 非空
 *    （收窄判据不得丢掉真漂移）。
 * 9. **🔴-D（插件侧异常不得进判据字段）**：插件写错代码（未初始化类字段 / 抛错 getter）时，
 *    探针读插件侧数据（`tools.schemas()` / `definitions.map()`）会抛错——该异常必须落**插件侧 check**，
 *    归因 `PLUGIN_REGRESSION`/RED，且 `hostFatal[]` **必须为空**（历史缺陷：落进 `hostFatal[]` →
 *    误判 `UPSTREAM_DRIFT`/AMBER，把插件 bug 甩给上游并盖掉插件侧已失败的 check）。
 * 9b. **🔴-D 同族活口（插件侧*异步*异常）**：插件在 `apply()` 里排后台任务（`queueMicrotask` 抛错 /
 *    `Promise.reject` 无人处理）——异常**不在** `run()` 调用栈上，顶层 `catch` 接不到。
 *    历史缺陷：探针在写出 `__DSH_PROBE__` 前被 Node 杀掉 → 装配器看到「探针未输出结构化结果」
 *    → 无条件 `pushHostFatal()` → `UPSTREAM_DRIFT`/AMBER，且 `checks` 从 17 掉到 **0**（整份报告消失）。
 *    现在必须：`PLUGIN_REGRESSION`/RED、`hostFatal = []`、失败项 `plugin.async_uncaught_exception`、
 *    `checks` 非空且已跑完的检查全在（报告不丢）、`probePhase = plugin-integration`。
 * 9c. **🔴 必修-2/3（进程 exit 出口 / `run()` 被拖住）**：插件在 `apply()` 里调 `process.exit(0)`，
 *    或返回一个**永不 resolve** 的 Promise——前者不抛异常（`catch` 与 `uncaughtException` 都接不到），
 *    后者既无异常也无退出。历史缺陷：探针在写出结构化结果前消失 → `UPSTREAM_DRIFT`/AMBER + `checks` 归零；
 *    更糟的是「顺手加个 exit 钩子但**不带完成位**」→ 剩余检查是 `skip` 不是 `fail` → **假绿**。
 *    现在必须：`PLUGIN_REGRESSION`/RED、`hostFatal = []`、失败项 `plugin.early_exit` /
 *    `plugin.run_incomplete`、`runCompleted = false`（**未跑完绝不给 ok**）、已跑完的 pass 项保留。
 * 9d. **不可捕获终止（SIGKILL）**：探针来不及写报告，装配器按**相位信标**归因 →
 *    `plugin.abnormal_termination`（插件侧）/ `hostFatal = []`；无信标则仍走 `hostFatal[]`（真漂移不丢）。
 *
 * 用法：`node tests/test_e2e_regression.mjs [--cache-dir <dir>] [--channel stable]`
 * 退出码：0 = 全绿；1 = 有失败；2 = 环境不具备（无宿主缓存且未联网）→ 显式跳过，不假装通过。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelFingerprint, loadChannels, runHostProbe } from '../src/harness/host.mjs';
// P2-8：插件侧 check 名单**从唯一事实源 import**（此前硬编码 12 项，表一改测试就不设防）
import { PLUGIN_SIDE_CHECKS } from '../src/harness/contract.mjs';
import { attributeFailure } from '../src/verify/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const CHANNEL = argOf('--channel', 'stable');
const SOURCE_CACHE = argOf('--cache-dir', path.join(tmpdir(), 'dsh-adapt-host-cache'));

let pass = 0;
let fail = 0;
const ok = (name, detail = '') => { console.log(`  ✅ ${name}${detail ? ` (${detail})` : ''}`); pass += 1; };
const bad = (name, detail = '') => { console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`); fail += 1; };
const eq = (name, expected, actual) => {
  if (expected === actual) ok(name, String(actual));
  else bad(name, `期望 ${expected} / 实得 ${actual}`);
};

console.log('▶ 端到端归因回归（tests/test_e2e_regression.mjs，真宿主）');

// ---- 0. 准备宿主缓存（没有就跳过，绝不假装通过） ----
const registry = loadChannels(ROOT);
const channel = registry.channels[CHANNEL];
if (!channel) {
  console.error(`  ❌ 未知通道：${CHANNEL}`);
  process.exit(1);
}
const fingerprint = channelFingerprint(channel);
const sourceEntry = path.join(SOURCE_CACHE, `${CHANNEL}-${fingerprint}`);
const sourceModules = path.join(sourceEntry, 'node_modules');
if (!existsSync(sourceModules)) {
  // 自愈：缓存缺失时先联网跑一次验收把它装出来（CI 上前面阶段的 verify 通常已建立缓存）
  console.log(`  ℹ️ 无宿主缓存（${sourceEntry}）：先联网跑一次验收建立缓存…`);
  try {
    execFileSync('node', [path.join(ROOT, 'src', 'cli.mjs'), 'verify', '--channel', CHANNEL, '--plugin', path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'), '--tools', 'demo_echo,demo_status'], {
      cwd: ROOT, stdio: 'ignore', timeout: 900_000,
    });
  } catch { /* 装不上就走下面的显式跳过 */ }
}
if (!existsSync(sourceModules)) {
  console.log(`  ⏭️ 仍无宿主缓存（${sourceEntry}）：离线环境无法跑真宿主回归`);
  console.log('  （跳过不算通过，退出码 2；CI 上由 tests/test_hub.sh / 前置 verify 建立缓存）');
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), 'dsh-e2e-'));
let scratchSeq = 0;

/**
 * 每次验收都用**全新仓库副本**：验收会按「通道 ok 才写」的规则更新契约基线，
 * 而本用例故意制造漂移（打补丁宿主）——副本既隔离了交付仓库的
 * `registry/contract-snapshots`，也避免「上一次成功运行改写基线」污染下一次归因断言。
 *
 * @param {string} [name] 副本目录名（默认自增；用于需要可读路径的场景，如路径含 npm）
 * @returns {string} 副本仓库根
 */
function makeScratch(name) {
  const root = path.join(work, name ?? `hub-${scratchSeq += 1}`);
  cpSync(ROOT, root, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return root;
}
const patchedTmp = path.join(work, 'patched-tmp');
const patchedCache = path.join(patchedTmp, 'dsh-adapt-host-cache');
const patchedEntry = path.join(patchedCache, `${CHANNEL}-${fingerprint}`);
mkdirSync(patchedCache, { recursive: true });
cpSync(path.join(SOURCE_CACHE, `${CHANNEL}-${fingerprint}`), patchedEntry, { recursive: true });

/** 打补丁：模拟「上游取消保留名拒绝」（本中台最需要侦测的那类漂移）。 */
function patchOutReservedNameRejection() {
  const targets = [
    path.join(patchedEntry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    path.join(patchedEntry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'index.js'),
  ];
  let patched = 0;
  for (const file of targets) {
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(/if \(name === "run_code"\) throw new Error\(`[^`]*`\);/g, 'if (false) throw new Error("patched: reserved name check disabled");')
      .replace(/if \(name === RUN_CODE_NAME\) \{\s*throw new Error\(`[^`]*`\);\s*\}/g, 'if (false) { throw new Error("patched: reserved name check disabled"); }');
    if (after !== before) { writeFileSync(file, after); patched += 1; }
  }
  return patched;
}

/** 跑一次真宿主验收，返回报告里的第一个通道。 */
function verify(pluginPath, tools, { tmp = SOURCE_CACHE, channelName = CHANNEL, offline = false, scratch = makeScratch() } = {}) {
  const out = path.join(work, `out-${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync('node', [path.join(scratch, 'src', 'cli.mjs'), 'verify', '--channel', channelName, '--plugin', pluginPath, '--tools', tools, '--json', out, ...(offline ? ['--offline'] : [])], {
      cwd: scratch,
      // 出口④（run() 被拖住）的回归加速：宿主侧**缩短**看门狗窗口（探针只许缩短、不许延长）。
      // 不设的话该夹具要等默认 20s——慢，但**不会**假绿（那才是要害）。
      env: { ...process.env, TMPDIR: tmp, DSH_PROBE_RUN_WATCHDOG_MS: process.env.DSH_PROBE_RUN_WATCHDOG_MS ?? '5000' },
      encoding: 'utf8',
      timeout: 600_000,
    });
  } catch { /* 非零退出是预期路径之一；报告仍会落盘 */ }
  if (!existsSync(out)) throw new Error(`验收未产出报告（plugin=${pluginPath}）`);
  const full = JSON.parse(readFileSync(out, 'utf8'));
  // 通道报告 + 顶层 summary：闸门断言要 verdict（评审要求「C 的用例必须断言 attribution 与 verdict」）
  return { ...full.channels[0], summary: full.summary };
}

try {
  // ---- 1. 上游取消保留名（打补丁宿主）→ GREEN 且契约漂移如实记录 ----
  console.log('  [1] 上游取消保留名（打补丁真宿主）→ 期望 GREEN，不误判插件');
  const patchedFiles = patchOutReservedNameRejection();
  if (patchedFiles === 0) {
    bad('打补丁生效（模拟上游取消保留名）', '未匹配到 dsh-tools 的保留名拒绝语句（上游措辞变了？请更新本用例）');
  } else {
    ok('打补丁生效（模拟上游取消保留名）', `${patchedFiles} 个文件`);
    const report = verify(path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'), 'demo_echo,demo_status', { tmp: patchedTmp });
    eq('上游接受 run_code 时健康插件仍 GREEN', 'PASS', report.attribution);
    eq('上游接受 run_code 时 verdict=GREEN', 'GREEN', report.summary?.verdict);
    eq('上游接受 run_code 时无失败项（契约探测无残留）', 0, (report.checks ?? []).filter((c) => c.status === 'fail').length);
    eq('契约探测卸载 check 通过', 'pass', (report.checks ?? []).find((c) => c.name === 'contract.probe_disposed')?.status);
    eq('漂移如实记录 reservedName（不静默）', 'ACCEPTED(unexpected)', report.contract?.reservedName);
    eq('漂移项含 reservedName', true, (report.contractDrift?.items ?? []).some((item) => item.field === 'reservedName'));
    eq('契约探测无残留工具', 0, (report.probes ?? []).filter((p) => p.accepted && !p.disposed).length);
  }

  // ---- 2-5. 插件侧失败必须判 PLUGIN_REGRESSION ----
  console.log('  [2] 插件侧失败归因（历史缺陷：曾被误报为上游漂移）');
  const pluginCases = [
    ['插件 apply 抛错 → PLUGIN_REGRESSION', 'apply-throws-plugin.mjs', 'demo_echo', 'plugin.apply_ok'],
    ['插件语法错误 → PLUGIN_REGRESSION', 'syntax-error-plugin.mjs', 'demo_echo', 'plugin.loaded'],
    ['插件未导出 apply → PLUGIN_REGRESSION', 'no-apply-plugin.mjs', 'demo_echo', 'plugin.loaded'],
    ['插件多注册工具 → PLUGIN_REGRESSION', 'extra-tool-plugin.mjs', 'demo_echo,demo_status', 'registry.exact'],
  ];
  for (const [label, fixture, tools, failedCheck] of pluginCases) {
    const report = verify(path.join(ROOT, 'tests/fixtures', fixture), tools);
    eq(label, 'PLUGIN_REGRESSION', report.attribution);
    eq(`${label}（失败项含 ${failedCheck}）`, true, (report.checks ?? []).some((c) => c.name === failedCheck && c.status === 'fail'));
    // 失败项必须**全部**在插件侧表内（前置失败只把后续检查标 skip，不制造噪音失败）
    const pluginSide = new Set(PLUGIN_SIDE_CHECKS);
    const failed = (report.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name);
    eq(`${label}（失败项全在插件侧，名单取自 PLUGIN_SIDE_CHECKS）`, true, failed.every((name) => pluginSide.has(name)));
    // 前置失败（import / apply）必须把后续检查标 skip（报告里看得见「哪些没验」）；
    // 「多注册工具」这类后置失败则全部检查都真的跑完了，不应有 skip。
    const preconditionFailed = failedCheck === 'plugin.loaded' || failedCheck === 'plugin.apply_ok';
    const skipped = (report.checks ?? []).filter((c) => c.status === 'skip').length;
    eq(`${label}（skip 语义：前置失败标 skip / 后置失败不标）`, preconditionFailed ? true : 0, preconditionFailed ? skipped > 0 : skipped);
  }

  // ---- 6. 同场景但仓库路径含 `npm`：不得翻案（🔴-B 原始复现） ----
  console.log('  [3] 🔴-B 原始复现：仓库路径含 `npm` 时仍判插件');
  // 仓库副本目录名含 npm（模拟 CI 上的 /home/runner/.npm/... 路径）
  const npmPathRoot = makeScratch('npm-path-hub');
  const npmReport = verify(path.join(npmPathRoot, 'tests/fixtures/extra-tool-plugin.mjs'), 'demo_echo,demo_status', { scratch: npmPathRoot });
  eq('hub 路径含 npm + 插件多余工具 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION', npmReport.attribution);
  eq('错误串不再回显命令行/路径（判据无从误命中）', false, (npmReport.errors ?? []).some((e) => e.includes('Command failed')));
  eq('插件侧失败 check 仍在报告里', true, (npmReport.checks ?? []).some((c) => c.name === 'registry.exact' && c.status === 'fail'));

  // ---- 7. 负例护栏（保留名）仍被拦下且归因为插件侧 ----
  console.log('  [4] 负例插件（声明保留名）仍被拦下');
  const broken = verify(path.join(ROOT, 'tests/fixtures/broken-plugin.mjs'), 'broken_ok');
  eq('声明保留名 → PLUGIN_REGRESSION（基线一致时）', 'PLUGIN_REGRESSION', broken.attribution);
  eq('声明保留名 → verdict=RED（不放行）', 'RED', broken.summary?.verdict);
  eq('失败项为 guard.reserved_rejected', true, (broken.checks ?? []).some((c) => c.name === 'guard.reserved_rejected' && c.status === 'fail'));
  // ---- 8. 🔴-C 原始复现：漂移窗口内插件侧硬违规不得被吞成上游漂移 ----
  // 上游放宽保留名校验（= reservedName 漂移）时，插件声明保留名仍必须判 PLUGIN_REGRESSION；
  // 历史缺陷：漂移相关性判据把 guard.reserved_rejected 一起算作「相关」→ 误判 UPSTREAM_DRIFT/AMBER。
  console.log('  [5] 🔴-C 原始复现：漂移窗口 + 插件声明保留名 → 仍须 PLUGIN_REGRESSION');
  if (patchedFiles === 0) {
    console.log('  ⏭️ 打补丁未生效，跳过 🔴-C 漂移窗口用例（不假装通过）');
  } else {
    const driftBroken = verify(path.join(ROOT, 'tests/fixtures/broken-plugin.mjs'), 'broken_ok', { tmp: patchedTmp });
    eq('漂移窗口 + 声明保留名 → PLUGIN_REGRESSION（不被漂移吞掉）', 'PLUGIN_REGRESSION', driftBroken.attribution);
    // 评审要求：🔴-C 用例必须**同时断言 attribution 与 verdict**（只看 attribution 会漏掉闸门层）
    eq('漂移窗口 + 声明保留名 → verdict=RED（不是 AMBER 放行）', 'RED', driftBroken.summary?.verdict);
    eq('漂移确实存在（reservedName 变了）', true, (driftBroken.contractDrift?.items ?? []).some((item) => item.field === 'reservedName'));
    eq('失败项仍是 guard.reserved_rejected（无噪音失败）', 'guard.reserved_rejected',
      (driftBroken.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name).join(','));
    eq('归因理由链指向插件侧硬证据', true, (driftBroken.attributionReasons ?? []).some((reason) => reason.includes('guard.reserved_rejected')));
    eq('判决不是 AMBER（责任未被甩给上游）', true, driftBroken.attribution !== 'UPSTREAM_DRIFT');
    // 反向护栏：同一漂移窗口内，健康插件仍须 PASS（🔴-A 场景不得被打穿）
    const driftHealthy = verify(path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'), 'demo_echo,demo_status', { tmp: patchedTmp });
    eq('反向护栏：漂移窗口 + 健康插件 → 仍 PASS', 'PASS', driftHealthy.attribution);
  }
  // ---- 9. 🔴-C 之二：插件所在目录名含 fatal(host) 不得翻案（真宿主；判据不扫自由文本） ----
  console.log('  [6] 🔴-C：路径含 fatal(host) 的插件失败 → 必须判插件');
  const fatalDir = path.join(work, 'fatal(host)-dir');
  mkdirSync(fatalDir, { recursive: true });
  const fatalPlugin = path.join(fatalDir, 'apply-throws.mjs');
  cpSync(path.join(ROOT, 'tests/fixtures/apply-throws-plugin.mjs'), fatalPlugin);
  const fatalReport = verify(fatalPlugin, 'demo_echo');
  eq('🔴-C：插件目录含 fatal(host) + apply 抛错 → PLUGIN_REGRESSION', 'PLUGIN_REGRESSION', fatalReport.attribution);
  eq('🔴-C：插件侧 stack 里确实带 fatal(host) 字面量（证明用例有效）', true,
    (fatalReport.errors ?? []).some((e) => e.includes('fatal(host)-dir')));
  eq('🔴-C：结构化 hostFatal 为空（插件侧失败不落宿主字段）', 0, (fatalReport.hostFatal ?? []).length);

  // ---- 10. 真宿主侧致命信号仍判漂移（收窄判据不得丢掉真漂移） ----
  console.log('  [7] 真宿主侧致命信号（离线缺缓存）→ UPSTREAM_DRIFT');
  const emptyTmp = path.join(work, 'empty-tmp');
  mkdirSync(emptyTmp, { recursive: true });
  const offlineReport = verify(path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'), 'demo_echo,demo_status', { tmp: emptyTmp, offline: true });
  eq('离线缺缓存（真宿主）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT', offlineReport.attribution);
  eq('离线缺缓存：结构化 hostFatal 非空（判据只读该字段）', true, (offlineReport.hostFatal ?? []).length > 0);
  eq('离线缺缓存：理由链指向 hostFatal 字段', true, (offlineReport.attributionReasons ?? []).some((r) => r.includes('hostFatal')));
  // ---- 11. 🔴-D：插件侧异常（未初始化字段 / 抛错 getter）不得进 hostFatal[] ----
  console.log('  [8] 🔴-D：插件写错代码 → 必须判插件且 hostFatal 为空');
  for (const [label, fixture, failedCheck] of [
    ['插件 definitions 抛错 getter → PLUGIN_REGRESSION', 'plugin-side-throw-plugin.mjs', 'guard.reserved_rejected'],
    ['插件注册项 getter 抛错 → PLUGIN_REGRESSION', 'plugin-registry-throw-plugin.mjs', 'registry.exact'],
  ]) {
    const report = verify(path.join(ROOT, 'tests/fixtures', fixture), 'demo_echo');
    eq(`${label}（归因）`, 'PLUGIN_REGRESSION', report.attribution);
    eq(`${label}（verdict=RED，不放行）`, 'RED', report.summary?.verdict);
    // 核心不变量（🔴-D，v0.1.9b 口径收窄）：**在探针进程内防线未被插件干预的前提下**，插件侧错误不进 hostFatal[]
    // （绝对口径「永不进」已被评审复评 H1 推翻：见 docs/RISKS.md R22/R23）
    eq(`${label}（hostFatal 为空——插件侧错误不进判据字段）`, 0, (report.hostFatal ?? []).length);
    // 失败项必须是插件侧 check（不得是宿主侧）
    const failed = (report.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name);
    const hostSide = new Set(['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed']);
    eq(`${label}（失败项无宿主侧 check）`, 0, failed.filter((n) => hostSide.has(n)).length);
    eq(`${label}（失败项含 ${failedCheck}）`, true, failed.includes(failedCheck));
    // 不变量守卫：hostFatal[] 里不得出现插件侧 stack（夹具路径 / at 帧）
    const fatalText = (report.hostFatal ?? []).join('\n');
    eq(`${label}（hostFatal 不含夹具路径）`, false, fatalText.includes(fixture));
    eq(`${label}（hostFatal 不含 stack 帧 'at '）`, false, /\n\s*at /.test(fatalText));
    // 插件侧 stack 仍应保留在**日志**里（可排障，只是不参与判据）
    eq(`${label}（插件侧 stack 保留在 errors 日志中）`, true, (report.errors ?? []).some((e) => e.includes(fixture)));
    // 相位随报告透出（排障看得见异常归属依据）
    eq(`${label}（probePhase=plugin-integration）`, 'plugin-integration', report.probePhase);
  }

  // ---- 11b. 🔴-D 同族活口：插件侧**异步**异常（后台任务抛错 / 预取 promise 拒绝） ----
  console.log('  [8b] 🔴-D 异步活口：插件后台任务抛错 → 必须判插件、hostFatal 为空、报告不丢');
  for (const [label, fixture] of [
    ['后台微任务抛错（uncaughtException）', 'plugin-async-throw-plugin.mjs'],
    ['预取 promise 拒绝（unhandledRejection）', 'plugin-async-reject-plugin.mjs'],
  ]) {
    const report = verify(path.join(ROOT, 'tests/fixtures', fixture), 'demo_echo');
    eq(`${label}（归因）`, 'PLUGIN_REGRESSION', report.attribution);
    eq(`${label}（verdict=RED，不放行）`, 'RED', report.summary?.verdict);
    // 核心不变量（🔴-D，v0.1.9b 口径收窄）：**在探针进程内防线未被插件干预的前提下**，插件侧错误不进 hostFatal[]
    eq(`${label}（hostFatal 为空——插件侧错误不进判据字段）`, 0, (report.hostFatal ?? []).length);
    // 报告完整性：旧缺陷下 checks 归零（整份报告消失）——这是本条活口比同步版更狠的地方
    const checks = report.checks ?? [];
    eq(`${label}（checks 非空——整份报告不得消失）`, true, checks.length > 0);
    eq(`${label}（已跑完的 pass 项全部保留，不只是失败项）`, true, checks.filter((c) => c.status === 'pass').length >= 10);
    eq(`${label}（失败项含 plugin.async_uncaught_exception）`, true,
      checks.some((c) => c.name === 'plugin.async_uncaught_exception' && c.status === 'fail'));
    // 失败项必须全在插件侧表内（不得出现宿主侧 check 失败 → 否则归因会被判据 1 抢走）
    const pluginSide = new Set(PLUGIN_SIDE_CHECKS);
    const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq(`${label}（失败项全在插件侧，名单取自 PLUGIN_SIDE_CHECKS）`, true, failed.every((name) => pluginSide.has(name)));
    eq(`${label}（无宿主侧 check 失败）`, 0,
      failed.filter((n) => ['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed'].includes(n)).length);
    // 不变量守卫：hostFatal[] 里不得出现插件侧 stack（夹具路径 / at 帧）
    const fatalText = (report.hostFatal ?? []).join('\n');
    eq(`${label}（hostFatal 不含夹具路径）`, false, fatalText.includes(fixture));
    eq(`${label}（hostFatal 不含 stack 帧 'at '）`, false, /\n\s*at /.test(fatalText));
    // 插件侧 stack 仍应保留在**日志**里（可排障，只是不参与判据）
    eq(`${label}（插件侧 stack 保留在 errors 日志中）`, true, (report.errors ?? []).some((e) => e.includes(fixture)));
    // 相位随报告透出（异常归属依据）
    eq(`${label}（probePhase=plugin-integration）`, 'plugin-integration', report.probePhase);
    // 确定性：同一夹具连跑两次，checks 形态一致（防「报告随抛错时机变化」）
    const again = verify(path.join(ROOT, 'tests/fixtures', fixture), 'demo_echo');
    eq(`${label}（重跑结论一致：同一归因）`, report.attribution, again.attribution);
    eq(`${label}（重跑报告形态一致：pass 数相同）`,
      checks.filter((c) => c.status === 'pass').length, (again.checks ?? []).filter((c) => c.status === 'pass').length);
  }

  // ---- 11c. 🔴 必修-2/3：进程 exit 出口 / run() 被拖住 / 不可捕获终止（真宿主） ----
  // 为什么必须真宿主也跑：离线回归台用的是**假宿主**（只模拟探针用到的那点宿主面），
  // 而「插件在真 ToolRuntime 装配下 process.exit」与「真宿主下挂住」的时序可能不同。
  // 放行判据（总师 §三⑤）：异步路径 + 进程 exit 路径均 `hostFatal=[]`，且健康插件仍 17/17。
  console.log('  [8c] 🔴 必修-2/3：四条出口在真宿主下均判插件、hostFatal 为空、未跑完不得假绿');
  for (const [label, fixture, expectedCheck, expectedCompleted, expectsPass] of [
    ['进程 exit（apply 内 process.exit(0)）', 'plugin-exit-plugin.mjs', 'plugin.early_exit', false, true],
    ['run() 被拖住（apply 返回永不 resolve 的 Promise）', 'plugin-hang-plugin.mjs', 'plugin.run_incomplete', false, true],
    ['不可捕获终止（SIGKILL）', 'plugin-sigkill-plugin.mjs', 'plugin.abnormal_termination', false, false],
  ]) {
    const report = verify(path.join(ROOT, 'tests/fixtures', fixture), 'demo_echo');
    const checks = report.checks ?? [];
    const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq(`${label}（归因）`, 'PLUGIN_REGRESSION', report.attribution);
    eq(`${label}（verdict=RED，不放行）`, 'RED', report.summary?.verdict);
    // 核心不变量（🔴-D，v0.1.9b 口径收窄）：**在探针进程内防线未被插件干预的前提下**，插件侧错误不进 hostFatal[]
    eq(`${label}（hostFatal 为空——插件侧错误不进判据字段）`, 0, (report.hostFatal ?? []).length);
    eq(`${label}（失败项含 ${expectedCheck}）`, true, failed.includes(expectedCheck));
    // 完成位（🔴 必修-1）：未跑完的运行**不得**判通过（假绿比 AMBER 更危险）
    eq(`${label}（完成位 runCompleted=${expectedCompleted}）`, expectedCompleted, report.runCompleted);
    eq(`${label}（未跑完不得判 GREEN/PASS）`, true, report.attribution !== 'PASS' && report.summary?.verdict !== 'GREEN');
    // 失败项必须全在插件侧表内（不得出现宿主侧 check 失败 → 否则归因会被判据 1 抢走）
    const pluginSide = new Set(PLUGIN_SIDE_CHECKS);
    eq(`${label}（失败项全在插件侧，名单取自 PLUGIN_SIDE_CHECKS）`, true, failed.every((name) => pluginSide.has(name)));
    // 报告完整性：**可捕获**出口必须保留已跑完的检查（历史缺陷下 checks 归零 = 整份报告消失）
    eq(`${label}（已跑完的 pass 项保留——报告不丢）`, expectsPass, checks.some((c) => c.status === 'pass'));
    // 不变量守卫：hostFatal[] 里不得出现插件侧 stack（夹具路径 / at 帧）
    const fatalText = (report.hostFatal ?? []).join('\n');
    eq(`${label}（hostFatal 不含夹具路径）`, false, fatalText.includes(fixture));
    eq(`${label}（hostFatal 不含 stack 帧 'at '）`, false, /\n\s*at /.test(fatalText));
  }
  // 出口③ 的**假绿**反证（评审 🔴 必修-1 点名的实验）：同一夹具在「带完成位」的实现下必须 RED；
  // 不带完成位时它会变 GREEN/checks=6 —— 这正是「用一个 HIGH 换一个 MEDIUM」的机制，
  // 故这里额外断言「失败项存在」（不带完成位时失败项是 0 条，只有 skip）。
  {
    const exitReport = verify(path.join(ROOT, 'tests/fixtures', 'plugin-exit-plugin.mjs'), 'demo_echo');
    const exitChecks = exitReport.checks ?? [];
    eq('🔴 假绿反证：进程 exit 夹具**确实**产生了失败项（不是「只有 skip」的假绿形态）', true,
      exitChecks.some((c) => c.status === 'fail'));
    eq('🔴 假绿反证：进程 exit 夹具的 skip 项 > 0（未跑到的检查被如实标注，不是凭空消失）', true,
      exitChecks.some((c) => c.status === 'skip'));
  }

  // ---- 11d. v0.1.9d 新增：R28 防线被顶替 / R26 协议注入（真宿主） ----
  // 为什么必须真宿主也跑：这两条的判据分别在**探针收尾自检**（R28）与**装配器解释输出**（R26）里，
  // 而离线回归台用的是假宿主 + 同一个装配器实现——真宿主能覆盖「真 ToolRuntime 装配下的时机差异」
  // （例如插件依赖在 import 期就动了 process 监听器）。两条都是**放行级假绿**，必须双跑。
  console.log('  [8d] v0.1.9d：R28 防线被顶替 / R26 协议注入（真宿主，放行级假绿收口）');
  for (const [label, fixture, expectedCheck, expectedCompleted] of [
    ['R28 防线被顶替（摘掉探针兜底 + 装自己的）', 'plugin-defense-tamper-plugin.mjs', 'plugin.process_defense_tampered', true],
    ['R26 协议注入（伪造 17 项全绿 + 真缺陷 + 压回退出码）', 'plugin-protocol-injection-plugin.mjs', 'plugin.protocol_injection', false],
  ]) {
    const report = verify(path.join(ROOT, 'tests/fixtures', fixture), 'demo_echo');
    const checks = report.checks ?? [];
    const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
    eq(`${label}（归因）`, 'PLUGIN_REGRESSION', report.attribution);
    eq(`${label}（verdict=RED，**绝不放行**）`, 'RED', report.summary?.verdict);
    eq(`${label}（失败项含 ${expectedCheck}）`, true, failed.includes(expectedCheck));
    eq(`${label}（hostFatal 为空——插件侧错误不进判据字段）`, 0, (report.hostFatal ?? []).length);
    eq(`${label}（完成位 runCompleted=${expectedCompleted}）`, expectedCompleted, report.runCompleted);
    eq(`${label}（ok 不得为真——假绿防线）`, false, report.ok === true);
    // R26 的关键性质：伪造的 17 项**不得**进入报告（否则报告在说谎）
    if (expectedCheck === 'plugin.protocol_injection') {
      eq(`${label}（伪造的 17 项未进入报告：checks 只有篡改证据这一条）`, 1, checks.length);
      eq(`${label}（篡改后不采信任何一条结果 ⇒ 不得判 PASS）`, true, report.attribution !== 'PASS');
    }
    // R28 的关键性质：探针**确实跑完了**（它只是不知道防线被顶替）⇒ 完成位仍真、pass 项保留
    if (expectedCheck === 'plugin.process_defense_tampered') {
      eq(`${label}（探针确实跑完 ⇒ 已跑完的 pass 项保留）`, true, checks.some((c) => c.status === 'pass'));
    }
    // 不变量守卫：hostFatal[] 里不得出现插件侧 stack
    const fatalText = (report.hostFatal ?? []).join('\n');
    eq(`${label}（hostFatal 不含夹具路径）`, false, fatalText.includes(fixture));
  }

  // ---- 11e. R24：同步死循环 → 宿主**二次终止**（真宿主 + 有界 timeout） ----
  // 为什么单列（评审复评 R24）：默认 `timeoutMs=600s` 下 3s 同步循环会正常跑完（那本身不是缺陷），
  // 本形态只在**有界 timeout** 下成立 ⇒ 用 `runHostProbe({ timeoutMs: 1000 })` 直接断言：
  // 收口时间、`probeExit.signal`、归因落点、`hostFatal` 为空。
  console.log('  [8e] R24：同步死循环（宿主二次终止 SIGKILL + 相位信标归因，真宿主）');
  {
    const registry = loadChannels(ROOT);
    const started = Date.now();
    const probe = runHostProbe({
      channelName: CHANNEL,
      channel: registry.channels[CHANNEL],
      pluginPath: path.join(ROOT, 'tests/fixtures', 'plugin-sync-loop-plugin.mjs'),
      expectedTools: ['demo_echo'],
      hubRoot: ROOT,
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - started;
    const failed = (probe.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name);
    eq('R24（真宿主）：probeExit.signal = SIGKILL（SIGTERM 会被探针出口③ 处理器吞掉）', 'SIGKILL', probe.probeExit?.signal ?? null);
    eq('R24（真宿主）：收口时间 < timeoutMs × 3（不得挂死 / 不得吃满额度）', true, elapsed < 1000 * 3);
    eq('R24（真宿主）：落插件侧 plugin.abnormal_termination（相位信标）', true,
      failed.includes('plugin.abnormal_termination'));
    eq('R24（真宿主）：hostFatal 为空（有信标 ⇒ 不甩锅上游）', 0, (probe.hostFatal ?? []).length);
    eq('R24（真宿主）：完成位 false（未跑完不得判通过）', false, probe.runCompleted);
    eq('R24（真宿主）：归因 PLUGIN_REGRESSION', 'PLUGIN_REGRESSION',
      attributeFailure(probe, registry.channels[CHANNEL], CHANNEL));
    // 反向护栏：同一 timeoutMs 下健康插件仍 17/17（防「把 timeout 调小」式过度修正）
    const healthy = runHostProbe({
      channelName: CHANNEL,
      channel: registry.channels[CHANNEL],
      pluginPath: path.join(ROOT, 'tests/fixtures', 'demo-plugin.mjs'),
      expectedTools: ['demo_echo', 'demo_status'],
      hubRoot: ROOT,
      timeoutMs: 1000,
    });
    eq('R24 反向护栏（真宿主）：同一 timeoutMs 下健康插件仍 17/17 全绿', 17,
      (healthy.checks ?? []).filter((c) => c.status === 'pass').length);
    eq('R24 反向护栏（真宿主）：健康插件 hostFatal 为空 + 跑完', '0|true',
      `${(healthy.hostFatal ?? []).length}|${healthy.runCompleted}`);
  }

  // ---- 12. 🔴-D 反向护栏：宿主装配相位异常仍须判漂移 ----
  console.log('  [9] 🔴-D 反向：宿主侧异常仍判漂移（收窄写入端不丢真漂移）');
  {
    const offline = verify(path.join(ROOT, 'tests/fixtures/demo-plugin.mjs'), 'demo_echo,demo_status', { tmp: path.join(work, 'empty-tmp-2'), offline: true });
    eq('离线缺缓存（宿主装配相位）→ UPSTREAM_DRIFT', 'UPSTREAM_DRIFT', offline.attribution);
    eq('离线缺缓存 → hostFatal 非空（宿主侧信号照写）', true, (offline.hostFatal ?? []).length > 0);
    eq('离线缺缓存 → probePhase=host-assembly（未进插件集成段）', 'host-assembly', offline.probePhase);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 交付仓库必须保持干净（本用例不得留下契约基线漂移）


console.log();
console.log(`▶ 端到端归因回归结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
