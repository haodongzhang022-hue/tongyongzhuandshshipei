/**
 * 契约基线「分段 + 只读」守卫（v0.3.0，对应 issue 的「基线别跟每一步」）。
 *
 * ## 为什么需要它
 * 旧语义下 `verify` **每跑一次就改写基线**。这类缺陷**不会红**：跑一次、写一次，
 * 所有既有测试都照样全绿（因为断言只看「这次跑出来的检查项」）。而它的后果是**静默的**：
 * 基线自己一直在动 ⇒ 上游连续发版时的累积偏移被吸收 ⇒ 漂移侦测形同虚设。
 * 所以必须有**结构性守卫**：写基线这件事**只能发生在一个地方**（`settle`），
 * 且**不能**出现在 push / PR 段。
 *
 * ## 判据（都是**定位型**，不用「字串在不在」）
 * - **B1**：`src/cli.mjs` 的 `cmdVerify` 函数体内不得出现任何「写基线」调用
 *   （`snapshot.save(` / `planSnapshotUpdate(` / `legacySnapshot(...).save(` / `settleSegment(`）。
 *   用**括号配平**取 `cmdVerify` 函数体，避免「文件里别处有 settle 就算过」的假绿。
 * - **B2**：`src/cli.mjs` 的 `cmdSettle` 函数体**必须**调用 `settleSegment(`（唯一写入点必须真的存在）。
 * - **B3**：`.cnb.yml` 的 **push 段 / pull_request 段**内不得出现 `dsh-adapt settle` /
 *   `cli.mjs settle`；`crontab: 0 10 * * *` 段**必须**出现（一天一个基线的结算点）。
 * - **B4**：`verifyAll()` 的基线来源必须是 `resolveBaseline`（链式派生），不得回头读
 *   `contractSnapshot(...).load()`（那份文件旧语义下每次运行被改写）。
 * - **B5**：`--settle-hour` 默认 10（用户点名的「早晨 10 点」），且 `periodKey` 的结算语义
 *   经**真实时间点**验证（09:59 → 当日；10:00 → 次日）。
 *
 * ## 守卫自证（防断言恒真）
 * 每条判据都拿**变异后的源码**再跑一次，必须判否：
 * - B1 变异：在 `cmdVerify` 里插一行 `snapshot.save({})` → 必须命中；
 *   把 `settleSegment(` 挪到 `cmdVerify` **之外** → B1 不误报（反证「定位到函数体」非「全文找」）。
 * - B3 变异：往 push 段插一行 settle → 必须命中。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTLE_HOUR, periodKeyForDay } from '../src/watch/baseline.mjs';

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

console.log('▶ 契约基线「分段 + 只读」守卫（tests/test_baseline_guard.mjs）');

/** 取某个函数声明的**函数体**（括号配平；不依赖缩进或窗口长度）。 */
export function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const brace = source.indexOf('{', start + signature.length);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  return null;
}

/** 判断一段代码里是否「调用」了某个名字（调用 = 名字后紧跟 `(`；不做全文子串匹配）。 */
export function callsIn(body, name) {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(body ?? '');
}

const cliSrc = readFileSync(path.join(ROOT, 'src/cli.mjs'), 'utf8');
const runnerSrc = readFileSync(path.join(ROOT, 'src/verify/runner.mjs'), 'utf8');
const cnbSrc = readFileSync(path.join(ROOT, '.cnb.yml'), 'utf8');

// ---- B1. cmdVerify 不得写基线 ----
console.log('  [B1] cmdVerify 只读基线（不得出现任何写入调用）');
{
  const body = functionBody(cliSrc, 'function cmdVerify(');
  if (!body) bad('B1 定位 cmdVerify 函数体', '未找到 function cmdVerify(');
  else {
    const writers = ['planSnapshotUpdate', 'contractSnapshot'].filter((n) => callsIn(body, n));
    eq('B1 cmdVerify 不含写基线调用（planSnapshotUpdate / contractSnapshot）', [], writers);
    const saveCall = /\bsnapshot\s*\.\s*save\s*\(/.test(body);
    eq('B1 cmdVerify 不含 snapshot.save(', false, saveCall);
    eq('B1 cmdVerify 不含 settleSegment(', false, callsIn(body, 'settleSegment'));
    eq('B1 cmdVerify 读的是链式派生基线（resolveBaseline）', true, callsIn(body, 'resolveBaseline'));
  }
  // 守卫自证：插一行写入 → 必须命中；把写入挪到函数外 → 不得误报
  const injected = cliSrc.replace('function cmdVerify(args) {', 'function cmdVerify(args) {\n  snapshot.save({});');
  const injBody = functionBody(injected, 'function cmdVerify(');
  eq('🟡B1 守卫自证：函数体内插 snapshot.save( ⇒ 判据命中（非恒真）', true, /\bsnapshot\s*\.\s*save\s*\(/.test(injBody));
  // 反证「定位到函数体」而非「全文找」：文件里别处（cmdSettle）确实有 settleSegment(
  eq('🟡B1 反证：全文确认存在 settleSegment(（说明不是全文没写、而是写在了别处）', true, callsIn(cliSrc, 'settleSegment'));
}

// ---- B2. cmdSettle 必须是唯一写入点 ----
console.log('  [B2] cmdSettle 是唯一写基线的地方');
{
  const body = functionBody(cliSrc, 'function cmdSettle(');
  if (!body) bad('B2 定位 cmdSettle 函数体', '未找到 function cmdSettle(');
  else {
    eq('B2 cmdSettle 调用 settleSegment(', true, callsIn(body, 'settleSegment'));
    eq('B2 cmdSettle 不直接写 legacySnapshot(...).save(', false, /\blegacySnapshot\s*\([^)]*\)\s*\.\s*save\s*\(/.test(body));
  }
  // 文件级：写基线调用只允许出现在 cmdSettle 里（stats/tests 另计）
  const verifyBody = functionBody(cliSrc, 'function cmdVerify(') ?? '';
  const settleBody = functionBody(cliSrc, 'function cmdSettle(') ?? '';
  const total = [...cliSrc.matchAll(/\bsettleSegment\s*\(/g)].length;
  const inSettle = [...settleBody.matchAll(/\bsettleSegment\s*\(/g)].length;
  const inVerify = [...verifyBody.matchAll(/\bsettleSegment\s*\(/g)].length;
  eq('B2 settleSegment 调用全部落在 cmdSettle 内', total - inVerify, inSettle);
}

// ---- B3. .cnb.yml：push / PR 只读；crontab 10:00 结算 ----
console.log('  [B3] .cnb.yml 接线（push/PR 只读，10:00 crontab 结算）');
{
  const seg = (startRe, endRe) => {
    const s = cnbSrc.search(startRe);
    if (s === -1) return null;
    const rest = cnbSrc.slice(s);
    const e = rest.slice(1).search(endRe);
    return e === -1 ? rest : rest.slice(0, e + 1);
  };
  const pushSection = seg(/^  push:\s*$/m, /^  pull_request:\s*$/m);
  const prSection = seg(/^  pull_request:\s*$/m, /^  "crontab:/m);
  if (!pushSection || !prSection) bad('B3 定位 push / pull_request 段', `push=${Boolean(pushSection)} pr=${Boolean(prSection)}`);
  else {
    const writesPush = /cli\.mjs\s+settle|dsh-adapt\s+settle/.test(pushSection);
    const writesPr = /cli\.mjs\s+settle|dsh-adapt\s+settle/.test(prSection);
    eq('B3 push 段不得出现 settle（基线不跟每一步）', false, writesPush);
    eq('B3 pull_request 段不得出现 settle', false, writesPr);
  }
  const settleCron = /"crontab: 0 10 \* \* \*":/;
  eq('B3 存在每日 10:00 结算 crontab', true, settleCron.test(cnbSrc));
  const cronIdx = cnbSrc.search(settleCron);
  const cronBody = cronIdx === -1 ? '' : cnbSrc.slice(cronIdx, cnbSrc.indexOf('"crontab: 30 3', cronIdx) === -1 ? undefined : cnbSrc.indexOf('"crontab: 30 3', cronIdx));
  eq('B3 10:00 crontab 内调用 settle（唯一写入点在 CI 上落地）', true, /cli\.mjs\s+settle/.test(cronBody));
  // 守卫自证：往 push 段**内部**插一行 settle → 判据必须命中（防「断言恒假」）
  const pushStart = cnbSrc.search(/^  push:\s*$/m);
  const marker = cnbSrc.indexOf('\n', pushStart) + 1;
  const injected = `${cnbSrc.slice(0, marker)}    - name: evil\n      script: |\n        node src/cli.mjs settle --from x.json\n${cnbSrc.slice(marker)}`;
  const injPush = injected.slice(marker, injected.search(/^  pull_request:\s*$/m));
  eq('🟡B3 守卫自证：push 段插 settle ⇒ 判据命中（非恒真）', true, /cli\.mjs\s+settle/.test(injPush));
}

// ---- B4. verifyAll 基线来源 = 链式派生 ----
console.log('  [B4] verifyAll 的基线来源是 resolveBaseline（不是被改写的 latest.json）');
{
  const body = functionBody(runnerSrc, 'export function verifyAll(');
  if (!body) bad('B4 定位 verifyAll 函数体', '未找到 export function verifyAll(');
  else {
    eq('B4 verifyAll 读 resolveBaseline', true, callsIn(body, 'resolveBaseline'));
    eq('B4 verifyAll 不再读 contractSnapshot(...).load()', false, callsIn(body, 'contractSnapshot'));
  }
  eq('B4 src/verify/runner.mjs 已不 import contractSnapshot', false, /import\s*\{[^}]*\bcontractSnapshot\b[^}]*\}\s*from/.test(runnerSrc));
}

// ---- B5. 结算时刻语义（真实时间点验证） ----
console.log('  [B5] 结算语义（10:00 结算 ⇒ 周期键 = 结算点日期）');
{
  eq('B5 默认结算时刻 = 10 点', 10, DEFAULT_SETTLE_HOUR);
  // (day, h, m) 视为 UTC+8 本地时间 → 转 UTC
  const local = (day, h, m) => new Date(Date.UTC(2026, 2, day, h - 8, m));
  eq('B5 03-02 09:59（本地，未到结算点）→ 当日 2026-03-02', '2026-03-02', periodKeyForDay(local(2, 9, 59)));
  eq('B5 03-02 10:00（本地，恰结算）→ 次日 2026-03-03', '2026-03-03', periodKeyForDay(local(2, 10, 0)));
  eq('B5 03-02 23:59 → 次日 2026-03-03', '2026-03-03', periodKeyForDay(local(2, 23, 59)));
  eq('B5 03-03 00:01 → 次日 2026-03-03', '2026-03-03', periodKeyForDay(local(3, 0, 1)));
  eq('B5 03-03 09:59 → 次日 2026-03-03', '2026-03-03', periodKeyForDay(local(3, 9, 59)));
  eq('B5 03-03 10:00 → 2026-03-04', '2026-03-04', periodKeyForDay(local(3, 10, 0)));
  eq('B5 一天只有一个基线：03-02 10:00 ~ 03-03 09:59 全归 2026-03-03', 1,
    new Set([local(2, 10, 0), local(2, 18, 0), local(3, 0, 1), local(3, 9, 59)].map((d) => periodKeyForDay(d))).size);
  // 自证：改结算小时必须改变周期键（防「settleHour 没接上」的恒真）
  // 自证：同一天同一时刻，改 settleHour 后周期键**必须**变（防「settleHour 没接上」的恒真）
  eq('🟡B5 守卫自证：settleHour=0（零点结算）时 03-02 10:00 → 下一结算点 03-03', '2026-03-03',
    periodKeyForDay(local(2, 10, 0), { settleHour: 0 }));
  eq('🟡B5 守卫自证：settleHour=12（正午结算）时 03-02 10:00 → 当日 03-02（与 10 点口径不同）', '2026-03-02',
    periodKeyForDay(local(2, 10, 0), { settleHour: 12 }));
}

// ---- B6. 地铁视图是 advice 面：不得回灌归因判据 ----
console.log('  [B6] 地铁视图（composeMetro）不得参与归因判据（advice 面）');
{
  const triageSrc = readFileSync(path.join(ROOT, 'src/triage/index.mjs'), 'utf8');
  const baselineSrc = readFileSync(path.join(ROOT, 'src/watch/baseline.mjs'), 'utf8');
  // 归因判据的**唯一执行体**在 src/verify/runner.mjs（`attributionDetail`），不是 triage。
  // ⚠️ 旧写法把 `runnerSrc` 的函数体拿去比、只看了 triage 的调用名 —— `metro` 字样根本不在这两份
  // 里 ⇒ 断言**恒真**（评审指出）。现在改为：**定位真实函数体**（括号配平，文件正确）+ 全仓扫描消费方。
  const attrBody = functionBody(runnerSrc, 'export function attributionDetail(');
  eq('B6 定位 attributionDetail 函数体（防「定位失败 ⇒ 断言空转」）', true, typeof attrBody === 'string' && attrBody.length > 0);
  eq('B6 attributionDetail（verify/runner.mjs）不含 composeMetro(', false, callsIn(attrBody, 'composeMetro'));
  eq('B6 attributionDetail（verify/runner.mjs）不含 metro 相关读取', false, /\bmetro\b/i.test(attrBody));
  eq('B6 attributeFailure（归因出口）不含 metro 判据',
    false, /\bmetro\b/i.test(functionBody(runnerSrc, 'export function attributeFailure(') ?? ''));
  // 反向：确认 metro 能力**确实存在**且被 CLI 接入（防「没写 ⇒ 断言恒真」）
  eq('B6 反证：baseline.mjs 确实导出了 composeMetro（说明不是「没实现」）', true, /export function composeMetro\(/.test(baselineSrc));
  eq('B6 反证：CLI 确实把 metro 接入输出（describeMetro/renderMetro）', true, callsIn(cliSrc, 'describeMetro') && callsIn(cliSrc, 'renderMetro'));
  // 反向定位自证：故意把函数体换成含 metro 的原文 ⇒ 判据必须命中（证明上面两条不是恒真）
  // 自证：把「注入 metro 的」函数体喂给同一判据，必须**判否**（证明上面两条不是恒真）
  eq('🟡B6 守卫自证：注入 metro 的 attributionDetail 会被判否',
    true, /\bmetro\b/i.test(`${attrBody ?? ''}\nmetro;`));
  // triage（advice 面）也不得把 metro 当判据
  eq('B6 triage（advice 面）不含 composeMetro 判据', false, callsIn(triageSrc, 'composeMetro'));
  // 归因/探针模块（verify、detect、triage）内**不得**把 composeMetro 当判据
  eq('B6 归因/探针模块（verify、detect、triage）内**不得**出现 composeMetro 调用', false,
    ['src/verify/runner.mjs', 'src/detect/flavor.mjs', 'src/triage/index.mjs'].some((rel) => callsIn(readFileSync(path.join(ROOT, rel), 'utf8'), 'composeMetro')));
}

console.log(`\n发布面自检（基线守卫）：${pass} 项通过 / ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
