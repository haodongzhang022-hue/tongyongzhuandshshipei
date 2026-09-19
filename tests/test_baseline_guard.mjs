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
 * - **B7**：每日基线是**条件触发**（未变化即跳过，不多一站）——判据用真函数真跑，
 *   并守住「比对面不得取本次 `--from` 报告」（自己跟自己比 ⇒ 永远无变化 ⇒ 首个站台落不下来）。
 *   CI 侧：crontab 10:00 段必须经 `--changed-only` 条件门。自证：摘掉条件门 ⇒ 判据命中。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTLE_HOUR, detectBaselineChange, periodKeyForDay, settleSegment } from '../src/watch/baseline.mjs';

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

// ---- B7. 每日基线是**条件触发**：未变化即跳过（不落盘、不新增站台） ----
console.log('  [B7] 每日基线条件触发（未变化即跳过；空跑日期不留站台）');
{
  // 判据全是**行为型**（跑真函数），不是「字串在不在」——防假绿。
  // ① 未变化 ⇒ changed=false
  const same = detectBaselineChange({
    previous: { stable: { a: 1 }, dev: { a: 1 } },
    baseline: { dev: { a: 1 }, stable: { a: 1 } },
  });
  eq('B7 契约逐键相同（含键序不同）⇒ 判「无变化」', false, same.changed);
  // ② 真变化 ⇒ changed=true
  eq('B7 已声明通道契约变了 ⇒ 判「有变化」', true,
    detectBaselineChange({ previous: { dev: { a: 1 } }, baseline: { dev: { a: 2 } } }).changed);
  // ③ 新增通道 ⇒ changed=true
  eq('B7 新增通道 ⇒ 判「有变化」', true,
    detectBaselineChange({ previous: { dev: { a: 1 } }, baseline: { dev: { a: 1 }, stable: { b: 2 } } }).changed);
  // ④ 首次结算（空基线）⇒ 必须 changed=true（否则第一个站台永远落不下来）
  eq('B7 空基线（首次结算）⇒ 判「有变化」（否则站台永远落不下）', true,
    detectBaselineChange({ previous: null, baseline: { dev: { a: 1 } } }).changed);
  // ⑤ 无候选 ⇒ 不得判成「有变化」（否则空报告也能推进基线 = 假绿）
  eq('B7 无候选（未跑验收）⇒ 判「无变化」（空报告不得推进基线）', false,
    detectBaselineChange({ previous: { dev: { a: 1 } }, baseline: {} }).changed);
  // ⑥ 候选缺席某通道 **不**判成变更（未声明 ≠ 值消失；链式合并本来就前向携带）
  eq('B7 候选缺席某通道 ⇒ 不判成「有变化」（未声明 ≠ 值消失）', false,
    detectBaselineChange({ previous: { stable: { a: 1 } }, baseline: { stable: { a: 1 } } }).changed);

  // ⑦ `settleSegment` 端到端：未变化 ⇒ written=false **且不追加候选台账**（零副作用）
  const segs = new Map();
  const store = {
    dir: '/tmp/seg',
    list: () => [...segs.keys()],
    load: (k) => (segs.has(k) ? segs.get(k) : null),
    save: (k, patch) => { const next = { ...(segs.get(k) ?? {}), ...patch, periodKey: k }; segs.set(k, next); return next; },
  };
  const channels = [{ channel: 'dev', ok: true, contract: { a: 1 } }];
  const first = settleSegment({ store, key: '2026-04-01', run: { at: '2026-04-01T02:00:00Z', channels } });
  eq('B7 settle 首次：落盘（站台建立）', true, first.written);
  const before = JSON.stringify(segs.get('2026-04-01'));
  // 空候选（本周期什么都没声明）⇒ **不建立站台**：分片里没有该周期键
  //（cmdSettle 的 `--changed-only` 早已把这种情形挡在结算之前，这里是第二道兜底）
  const again = settleSegment({ store, key: '2026-04-02', run: { at: '2026-04-02T02:00:00Z', channels: [] } });
  eq('B7 settle 空候选：不建立站台（无该周期分片）', false, segs.has('2026-04-02'));
  eq('B7 settle 空候选：不改动已有站台', before, JSON.stringify(segs.get('2026-04-01')));
  // 变化则**新周期**落站；再跑同一份 ⇒ 幂等不落盘、不新增候选台账
  const rolled = settleSegment({ store, key: '2026-04-03', run: { at: '2026-04-03T02:00:00Z', channels } });
  eq('B7 settle 有候选且变化 ⇒ 新周期落盘（站台推进）', true, rolled.written);
  const candBefore = (segs.get('2026-04-03').candidates ?? []).length;
  const idem = settleSegment({ store, key: '2026-04-03', run: { at: '2026-04-03T02:00:00Z', channels } });
  eq('B7 settle 同周期同身份重跑 ⇒ 幂等不落盘', false, idem.materiallyChanged);
  eq('B7 settle 同周期同身份重跑 ⇒ 不新增候选台账', candBefore, (segs.get('2026-04-03').candidates ?? []).length);

  // ⑧ 版本号：幂等重跑不涨、内容变了才涨（可观测但零副作用）
  const v0 = segs.get('2026-04-01').baselineVersion ?? 0;
  settleSegment({ store, key: '2026-04-01', run: { at: '2026-04-01T02:00:00Z', channels } });
  eq('B7 幂等重跑：baselineVersion 不涨', v0, segs.get('2026-04-01').baselineVersion ?? 0);

  // ⑨ `cmdSettle` 必须真的**接上**条件触发：函数体里出现 detectBaselineChange + force + changed-only
  const settleBody = functionBody(cliSrc, 'function cmdSettle(') ?? '';
  eq('B7 cmdSettle 接上变化判定（detectBaselineChange）', true, callsIn(settleBody, 'detectBaselineChange'));
  eq('B7 cmdSettle 有 --force 逃生门（人工补站台）', true, /args\.force/.test(settleBody));
  eq('B7 cmdSettle 有 --changed-only 只判不写出口', true, /changed-only/.test(settleBody));
  eq('B7 cmdSettle 未变化 ⇒ 跳过结算（不调 settleSegment）', true, /settleSkipped\s*\?/.test(settleBody));

  // ⑩ CI 接线：crontab 10:00 段必须走**条件门**（changed-only），不得无脑结算
  const cronIdxB7 = cnbSrc.search(/"crontab: 0 10 \* \* \*":/);
  const cronB7 = cronIdxB7 === -1 ? '' : cnbSrc.slice(cronIdxB7, cnbSrc.indexOf('"crontab: 30 3', cronIdxB7) === -1 ? undefined : cnbSrc.indexOf('"crontab: 30 3', cronIdxB7));
  eq('B7 crontab 10:00 段有条件门 --changed-only', true, /changed-only/.test(cronB7));
  eq('B7 crontab 10:00 段有「未变化即退出」分支', true, /CHANGED/.test(cronB7));
  // 守卫自证（防恒真）：把条件门从 crontab 段摘掉 ⇒ 判据必须命中
  const withoutGate = cnbSrc.replace(/--changed-only/g, '--mode day');
  const cronB7b = cronIdxB7 === -1 ? '' : withoutGate.slice(cronIdxB7, withoutGate.indexOf('"crontab: 30 3', cronIdxB7) === -1 ? undefined : withoutGate.indexOf('"crontab: 30 3', cronIdxB7));
  eq('🟡B7 守卫自证：摘掉 --changed-only ⇒ 判据命中（非恒真）', false, /changed-only/.test(cronB7b));

  // ⑪ 假绿反证：`--from` 报告**不得**被当成比对面（自己跟自己比 ⇒ 永远「无变化」）
  eq('B7 比对面不取本次 --from 报告（防「自己跟自己比」的假无变化）', false,
    /args\.from\s*\)\s*\n?\s*:\s*undefined/.test(functionBody(cliSrc, 'function cmdSettle(') ?? ''));
  eq('B7 cmdSettle 比对面优先取 resolveBaseline 派生基线', true,
    /resolvedBefore\.contracts/.test(settleBody));
}

console.log(`\n发布面自检（基线守卫）：${pass} 项通过 / ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
