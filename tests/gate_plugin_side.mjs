/**
 * 🔴-D / 🔴-D′ 闸门：**插件侧异常与插件侧中断**都不得进判据字段 `hostFatal[]`。
 *
 * 为什么单独成脚本（而不是继续写在 `.cnb.yml` 的 inline `node -e` 里）：
 * push 段与 PR 段原本各抄一份同样的断言（评审已点名「重复」是维护风险）——两处一旦漂移，
 * 其中一处会静默失效（闸门失效比没有闸门更危险：它给人「已守住」的错觉）。现在两段共用本脚本，
 * 夹具清单与断言口径只有**一处**。
 *
 * 覆盖两组形态：
 * - **探针活着**（同步读插件侧数据 / 插件后台任务异步抛错）→ 失败项是**探针侧** check
 *   （`plugin.unexpected_exception` / `plugin.async_uncaught_exception`），由探针自己的相位路由落点；
 * - **探针被杀**（`apply()` 永不 settle / `process.exit` / 摘掉进程级处理器 / 占死事件循环）
 *   → 探针内任何兜底都来不及跑，由**装配器**读**带外**侧信道相位归因，失败项是
 *   `plugin.probe_aborted`（评审 🔴-D′ 同族活口的第二轮）。
 *
 * 每组都断言（只看 attribution 不够：AMBER 漂移窗口下也可能 fail，闸门会静默失效）：
 * ① `attribution === PLUGIN_REGRESSION`；② `hostFatal` 长度为 0（核心不变量）；
 * ③ `verdict !== 'AMBER'`（责任未被甩给上游）；④ `checks` 非空且含 `pass`（报告没丢）；
 * ⑤ 失败项**全在** `PLUGIN_SIDE_CHECKS` 内（名单从唯一事实源 import，不硬编码）；
 * ⑥ 期望的失败项确实出现（按夹具形态逐项声明）。
 *
 * 用法：`node tests/gate_plugin_side.mjs [--channel stable] [--json-dir ./.ci]`
 * 退出码：0 = 全绿；1 = 闸门失败（**不放行**）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_SIDE_CHECKS, PROBE_CHECK_ORDER } from '../src/harness/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const CHANNEL = argOf('--channel', 'stable');
const JSON_DIR = path.resolve(ROOT, argOf('--json-dir', './.ci'));

/**
 * 夹具 → 期望失败项 → 形态分组。
 *
 * 纪律：**逐项声明期望失败项**，不用「有失败就行」这种模糊断言——否则夹具被改成
 * 另一种失败形态（如把 `render` 写坏）时闸门仍绿，等于防线空转。
 *
 * 形态分组（`probeAlive`）决定「报告完整性」的断言口径：
 * - `true`（探针活着）：探针自己写出结构化结果 → 必须含 `pass` 项（已跑完的检查保留下来）；
 * - `false`（探针被杀）：探针**来不及**输出任何 check → 装配器只知道「没跑到」，
 *   按规范顺序补 17 条 `skip` + 1 条 `plugin.probe_aborted`。此时**必然没有 pass 项**——
 *   这不是「报告丢失」（`checks` 非空、17 项一项不少），而是装配器**没有资格**替探针宣布结果。
 *   把这条口径写进断言，防后人误以为「没 pass = 报告坏了」而把防线改松。
 */
const FIXTURES = [
  // 探针活着：同步异常（读插件侧数据 → 落成对应插件侧 check；「探针自身未预期异常」
  // 只在异常逃到顶层 catch 时才出现，故这里按**实际失败点**逐项声明，不用兜底名）
  ['plugin-side-throw-plugin.mjs', 'guard.reserved_rejected', true],
  ['plugin-registry-throw-plugin.mjs', 'registry.exact', true],
  // 探针活着：异步异常（后台任务抛错 / 预取 promise 拒绝）
  ['plugin-async-throw-plugin.mjs', 'plugin.async_uncaught_exception', true],
  ['plugin-async-reject-plugin.mjs', 'plugin.async_uncaught_exception', true],
  // 🔴-D′ 探针被杀：探针内任何兜底都来不及跑，靠带外侧信道相位归因
  ['plugin-process-exit-plugin.mjs', 'plugin.probe_aborted', false],
  ['plugin-detach-handlers-plugin.mjs', 'plugin.probe_aborted', false],
  // 🔴-D′ 看门狗「能红」断言（行为级）：挂起 + 后台抛错 → 看门狗如期收尾，故失败项是
  // **探针侧** check；若有人把 `watchdog.unref()` 写回去 → 看门狗失效 → 失败项变成
  // `plugin.probe_aborted`（装配器兜底）→ 本断言红（与 [9.8g] 源码守卫互为行为级对偶）。
  ['plugin-hang-plugin.mjs', 'plugin.async_uncaught_exception', true],
  // 🔴-D′ 占死事件循环：微任务异常先被接住，占死结束后看门狗如期收尾
  ['plugin-busy-loop-plugin.mjs', 'plugin.async_uncaught_exception', true],
];

const pluginSide = new Set(PLUGIN_SIDE_CHECKS);
let pass = 0;
let fail = 0;
const ok = (name, detail = '') => { console.log(`  ✅ ${name}${detail ? ` (${detail})` : ''}`); pass += 1; };
const bad = (name, detail = '') => { console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`); fail += 1; };

mkdirSync(JSON_DIR, { recursive: true });
console.log(`▶ 🔴-D / 🔴-D′ 闸门（tests/gate_plugin_side.mjs，通道 ${CHANNEL}）`);

for (const [fixture, expectedFail, probeAlive] of FIXTURES) {
  const pluginPath = path.join(ROOT, 'tests', 'fixtures', fixture);
  const out = path.join(JSON_DIR, `verify-${fixture.replace(/\.mjs$/, '')}.json`);
  let exitedNonZero = false;
  try {
    execFileSync('node', [path.join(ROOT, 'src', 'cli.mjs'), 'verify', '--channel', CHANNEL,
      '--plugin', pluginPath, '--tools', 'demo_echo', '--json', out], { cwd: ROOT, stdio: 'ignore', timeout: 900_000 });
  } catch {
    exitedNonZero = true;
  }
  if (!exitedNonZero) { bad(`${fixture} 必须被拦下（不得判通过）`); continue; }

  const report = JSON.parse(readFileSync(out, 'utf8'));
  const channel = report.channels?.[0] ?? {};
  const checks = channel.checks ?? [];
  const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const problems = [];
  if (channel.attribution !== 'PLUGIN_REGRESSION') problems.push(`归因不是 PLUGIN_REGRESSION（实得 ${channel.attribution}）`);
  if ((channel.hostFatal ?? []).length !== 0) problems.push(`hostFatal 非空（插件侧错误写进了判据字段）：${JSON.stringify(channel.hostFatal)}`);
  if (report.summary?.verdict === 'AMBER') problems.push('判决为 AMBER（插件 bug 被甩给上游）');
  if (checks.length === 0) problems.push('checks 为空（报告整份消失——旧缺陷形态）');
  if (probeAlive && !checks.some((c) => c.status === 'pass')) problems.push('无 pass 项（已跑完的检查被丢弃）');
  if (!probeAlive && !checks.some((c) => c.status === 'skip')) problems.push('无 skip 项（探针被杀时装配器应把未验项标 skip，让「没验」可见）');
  // 报告完整性（比「checks 非空」更严）：**17 项一项都不能少**。探针被杀时装配器按规范
  // 顺序补 `skip`（而不是让它们凭空消失），故这里断言 17 项全在报告里（pass/fail/skip 均可）。
  // 为什么必须这么严：`checks.length === 0` 只是最狠的那一档；「掉几项」同样会让人
  // 分不清「没验」与「验过了」——报告形态必须与正常失败一致。
  const recorded = new Set(checks.map((c) => c.name));
  const missingFromOrder = PROBE_CHECK_ORDER.filter((name) => !recorded.has(name));
  if (missingFromOrder.length > 0) problems.push(`17 项报告缺项：${missingFromOrder.join(',')}`);
  if (!failed.includes(expectedFail)) problems.push(`期望失败项 ${expectedFail} 未出现（实得 ${failed.join(',') || '无'}）`);
  const offSide = failed.filter((name) => !pluginSide.has(name));
  if (offSide.length > 0) problems.push(`失败项不在 PLUGIN_SIDE_CHECKS 内：${offSide.join(',')}`);
  // 反向守卫：失败项里不得出现**宿主侧** check（出现即归因会被判据 1 抢走）
  const hostSide = failed.filter((name) => ['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed'].includes(name));
  if (hostSide.length > 0) problems.push(`出现宿主侧失败项：${hostSide.join(',')}`);
  // 不变量：hostFatal[] 里不得出现夹具路径 / stack 帧
  const fatalText = (channel.hostFatal ?? []).join('\n');
  if (fatalText.includes(fixture) || /\n\s*at /.test(fatalText)) problems.push('hostFatal 里出现插件侧 stack');

  if (problems.length > 0) bad(`${fixture}（期望失败项 ${expectedFail}）`, problems.join('；'));
  else ok(`${fixture}：PLUGIN_REGRESSION / hostFatal 为空 / 失败项 ${expectedFail} / checks=${checks.length} / verdict=${report.summary?.verdict}`);
}

console.log();
console.log(`▶ 闸门结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
