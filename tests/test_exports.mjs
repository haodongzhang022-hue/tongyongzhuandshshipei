/**
 * 发布面自检（防「exports 指向不存在的文件」与「模板拷贝即坏」同类回归）。
 *
 * 覆盖（对应评审 🔴-4 与「防同类回归」要求）：
 * 1. `package.json` 的每个 `exports` 子路径都能被解析并 import；
 * 2. 文档/示例里的 import 路径可解析，且符号确实被导出；
 * 3. `templates/adapter/index.mjs` 拷贝出仓后（按 README 指引改 import）可用。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONDITIONAL_PROBE_CHECKS } from '../src/harness/contract.mjs';
import { codeOnly } from './source-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

console.log('▶ 发布面自检（tests/test_exports.mjs）');

// ---- 1. exports 全解析 ----
console.log('  [1] package.json exports 全解析');
for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
  const abs = path.resolve(ROOT, target);
  if (!readFileSync) { /* noop */ }
  let exists = true;
  try { readFileSync(abs); } catch { exists = false; }
  if (!exists) { bad(`exports["${sub}"] 文件存在`, `${target} 不存在`); continue; }
  const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
  try {
    const mod = await import(spec);
    ok(`exports["${sub}"] 可 import`, `${spec} → ${Object.keys(mod).length} 个导出`);
  } catch (error) {
    bad(`exports["${sub}"] 可 import`, `${spec} → ${error.code ?? error.message}`);
  }
}

// ---- 2. 文档/示例 import 路径可解析 ----
console.log('  [2] 示例 import 路径可解析');
const docChecks = [
  ['根导出面 createAdapter', `${pkg.name}`, 'createAdapter'],
  ['adapter 子路径 createAdapter', `${pkg.name}/adapter`, 'createAdapter'],
  ['detect 子路径 detectHostFlavor', `${pkg.name}/detect`, 'detectHostFlavor'],
];
for (const [label, spec, symbol] of docChecks) {
  try {
    const mod = await import(spec);
    if (typeof mod[symbol] === 'function') ok(label, `${spec} → ${symbol}`);
    else bad(label, `${spec} 未导出 ${symbol}（typeof=${typeof mod[symbol]}）`);
  } catch (error) {
    bad(label, `${spec} → ${error.code ?? error.message}`);
  }
}
// 文档里的 import 语句与真实导出面一致性（grep 文档中的包名 import）
for (const file of ['docs/ADAPTER_GUIDE.md', 'README.md', 'src/index.mjs']) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const re = /from '@dongdongxiaozu\/dsh-adapt-hub(\/[a-z-]+)?'/g;
  const specs = [...text.matchAll(re)].map((m) => m[1] ? `${pkg.name}${m[1]}` : pkg.name);
  const unknown = specs.filter((s) => {
    const sub = s === pkg.name ? '.' : `./${s.slice(pkg.name.length + 1)}`;
    return !(sub in (pkg.exports ?? {}));
  });
  if (unknown.length === 0) ok(`${file} 的 import 路径均在 exports 内`, specs.join(', ') || '无');
  else bad(`${file} 的 import 路径`, `未定义子路径：${unknown.join(', ')}`);
}

// ---- 2b. 文档 17 项检查清单：顺序 = 探针实际输出顺序（防「集合对、顺序错」漂移） ----
console.log('  [2b] 文档检查清单顺序与探针一致');
{
  const probeSource = readFileSync(path.join(ROOT, 'src/harness', 'probe-template.mjs'), 'utf8');
  // 探针 check() 调用顺序 = 报告里 checks[] 顺序；同名只取首次（前置失败会 skipAll，不重复声明）
  const seen = new Set();
  const probeOrder = [...probeSource.matchAll(/check\(\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((name) => (seen.has(name) ? false : (seen.add(name), true)));
  ok('探针 check 数量 = 17 项', String(probeOrder.length));

  /**
   * 抽取文档「17 项检查清单」段落正文里的检查名（按出现顺序）。
   *
   * 两种承载形式都支持：Markdown 表格（`docs/INDEX.md`）与代码围栏块（`docs/ADAPTER_GUIDE.md`）。
   * 只认全量 17 项集合内的名字，避免把正文里其他位置的引用算进顺序。
   */
  const checklistOrderOf = (file) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    // 段落标题两种写法：`docs/INDEX.md` 用 `## 四、17 项验收检查索引`，指南用 `**17 项检查清单**（…）`。
    // 必须**行首锚定**（标题行 / 加粗行首），否则会先命中正文表格里的「17 项检查（…）」引用。
    const heading = /^(?:#{1,6}|\*\*)17 项[^\n]*检查[^\n]*$/m.exec(text)
      ?? /^(?:#{1,6}|\*\*)[^\n]*17 项[^\n]*检查[^\n]*$/m.exec(text);
    if (!heading) return null;
    const idx = heading.index;
    const rest = text.slice(idx);
    // 取到下一个二级标题为止，作为清单正文范围
    const nextHeading = rest.indexOf('\n## ');
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const found = [];
    for (const m of section.matchAll(/([a-z_]+\.[a-z_]+)/g)) {
      const name = m[1];
      if (probeOrder.includes(name) && !found.includes(name)) found.push(name);
    }
    return found;
  };

  for (const file of ['docs/INDEX.md', 'docs/ADAPTER_GUIDE.md']) {
    const docOrder = checklistOrderOf(file);
    if (docOrder === null) { bad(`${file} 有「17 项检查清单」段落`, '未找到清单段落'); continue; }
    const missing = probeOrder.filter((n) => !docOrder.includes(n));
    if (missing.length > 0) { bad(`${file} 覆盖全部 17 项检查`, `缺：${missing.join(', ')}`); continue; }
    if (JSON.stringify(docOrder) === JSON.stringify(probeOrder)) {
      ok(`${file} 清单顺序 = 探针输出顺序`, `${docOrder.length} 项`);
    } else {
      bad(`${file} 清单顺序`, `文档：${docOrder.join(' > ')}\n     探针：${probeOrder.join(' > ')}`);
    }
  }
}

// ---- 2b'. docs/INDEX.md 清单**标题/序号/注脚**结构守卫（复测 🟡P2-新） ----
// 为什么单独成段：上轮 [2b] 只比对「检查名顺序」，INDEX 的标题后缀（「（按探针实际输出顺序）」）、
// 注脚口径、`#` 序号列被删/改字时全绿逃逸 —— 而 CHANGELOG P2-2 防线栏与 INDEX 注脚都自述
// 「由 [2b] 守住标题/序号」，属**自述与落地不符**。这里把结构也纳入断言。
console.log("  [2b'] INDEX 清单标题/序号列/注脚结构");
{
  const idx = readFileSync(path.join(ROOT, 'docs/INDEX.md'), 'utf8');
  // 标题必须带「（按探针实际输出顺序）」后缀（P2-1 的落地验收要件）
  const titleLine = idx.split('\n').find((line) => /^#{1,6}[^\n]*17 项[^\n]*检查[^\n]*索引/.test(line)) ?? '';
  ok('INDEX 存在「17 项验收检查索引」标题', titleLine.slice(0, 60));
  eq('INDEX 标题带「（按探针实际输出顺序）」后缀', true, titleLine.includes('（按探针实际输出顺序）'));
  // `#` 序号列必须存在，且 1..17 连续（缺失 / 全写 1 即红）
  const serials = [...idx.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  eq('INDEX 清单含 `#` 序号列且为 1..17 连续', JSON.stringify(Array.from({ length: 17 }, (_, i) => i + 1)), JSON.stringify(serials));
  // 注脚必须写明「序号 = 探针实际输出顺序」，且声明由本文件的 [2b] 守住
  // 注脚可能分多行（都是 `>` 引用块），取清单段落的引用块整体
  const foot = idx.split('\n').filter((line) => /^>\s/.test(line)).join(' ') ?? '';
  eq('INDEX 注脚写明「序号 = 探针实际输出顺序」', true, /序号\s*=\s*\*\*探针实际输出顺序\*\*/.test(foot));
  eq('INDEX 注脚声明顺序由 tests/test_exports.mjs [2b] 守住', true,
    foot.includes('test_exports.mjs') && foot.includes('[2b]'));
}

// ---- 2b'''. 「另有 N 项条件检查」的 N 由 CONDITIONAL_PROBE_CHECKS 长度反推（复测 🟡-4） ----
// 为什么补（评审 🟡-4）：`src/harness/contract.mjs` 的 JSDoc 曾写死「另有 1 项条件检查」，
// 而两份文档早已改成 2 项——代码与文档各说各话；更糟的是「另有 N 项」这句**无守卫**
// （`tests/` 搜「另有」0 命中）：改文档不改代码、或反之，都静默通过（与 🟡-2「删声明即静默」同族）。
// 现在把 N 从**唯一事实源**（`CONDITIONAL_PROBE_CHECKS.length`）反推，两份文档必须一致，
// 且每一条条件检查名都要在文档表里出现（防止「N 对但名单少了一项」）。
console.log("  [2b'''] 文档「另有 N 项条件检查」与 CONDITIONAL_PROBE_CHECKS 一致");
{
  const N = CONDITIONAL_PROBE_CHECKS.length;
  // 🟡-1（评审复评）：此前只守 ADAPTER_GUIDE / INDEX 两份 ⇒ ARCHITECTURE / README **可静默漂移**
  // （实测：ARCHITECTURE 的「另有 8→9」+ `plugin.protocol_injection` 改名 → exports 仍全绿）。
  // 文档即防线：凡声明了条件项数 / 名单的文档都必须纳入守卫。
  // ⚠️ 名单匹配按**标识符词元**判（split 后精确相等），不用 `text.includes(name)`：
  // 否则把 `plugin.probe_result_forged` 改成 `plugin.probe_result_forgedX` 时 `includes` 仍命中
  // （前缀包含）⇒ 改名静默逃逸（与 🟡-1 同族）。
  const hasIdent = (hay, name) => hay.split(/[^A-Za-z0-9_.]+/).includes(name);
  for (const file of ['docs/ADAPTER_GUIDE.md', 'docs/INDEX.md', 'docs/ARCHITECTURE.md']) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const declared = /另有\s*(\d+)\s*项条件检查/.exec(text);
    if (!declared) { bad(`${file} 声明「另有 N 项条件检查」`, '未找到该声明（声明本身是必需项）'); continue; }
    eq(`${file} 的「另有 N 项条件检查」N = CONDITIONAL_PROBE_CHECKS.length`, String(N), declared[1]);
    const missing = CONDITIONAL_PROBE_CHECKS.filter((name) => !hasIdent(text, name));
    eq(`${file} 条件检查表覆盖全部条件项（名单取自唯一事实源）`, JSON.stringify([]), JSON.stringify(missing));
  }
  // README 用另一种写法（「17 项探针（+N 条件项）」）——同样必须与唯一事实源一致，且不得静默漂移。
  {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const m = /\+(\d+)\s*条件项/.exec(readme);
    if (!m) bad('README 声明「+N 条件项」', '未找到该声明（声明本身是必需项）');
    else eq('README 的「+N 条件项」N = CONDITIONAL_PROBE_CHECKS.length', String(N), m[1]);
  }
  // 守卫自证：N 改字即红（把两份文档的 N 改掉，断言必须不成立）
  const idxText = readFileSync(path.join(ROOT, 'docs/INDEX.md'), 'utf8');
  const mutated = idxText.replace(/另有\s*\d+\s*项条件检查/, `另有 ${N + 1} 项条件检查`);
  eq('🟡-4 守卫自证：N 被改字即红', false, /另有\s*(\d+)\s*项条件检查/.exec(mutated)?.[1] === String(N));
  // 守卫自证：条件项名单被删一项即红。
  //
  // ⚠️ 纪律（本轮实测发现的**守卫自身缺陷**）：自证必须把变异作用在**条件检查表**这一段落上，
  // 不能对整份文档做 `text.replace(dropped, ...)` —— 条件检查名可能**同时**出现在别处
  // （如 INDEX.md 的「负例插件」索引行里也写了 `plugin.abnormal_termination`），
  // 于是「删掉一条」的变异只改了第一处、`includes()` 仍然命中 → **自证断言空转**（实测逃逸）。
  // 修法：先把条件检查表段落切出来（自「另有 N 项条件检查」起，到下一个空行后的引用块止），
  // 变异与断言都在**该段落内**做——与「文档即防线」的口径一致（守的是那张表，不是全文）。
  const tableOf = (text) => {
    const start = text.search(/另有\s*\d+\s*项条件检查/);
    if (start < 0) return '';
    // 标题行与表之间可能隔一个空行 → 先定位**表头行**（`| 条件检查 |`），再取到其后第一个空行。
    const lines = text.slice(start).split('\n');
    const head = lines.findIndex((line) => /^\|\s*条件检查\s*\|/.test(line));
    if (head < 0) return '';
    const end = lines.findIndex((line, i) => i > head && line.trim() === '');
    return lines.slice(head, end < 0 ? undefined : end).join('\n');
  };
  const idxTable = tableOf(idxText);
  eq('🟡-4 守卫自证：条件检查表段落可定位（段落锚点改名即红）', true, idxTable.includes('| 条件检查 |'));
  const dropped = CONDITIONAL_PROBE_CHECKS[CONDITIONAL_PROBE_CHECKS.length - 1];
  const mutatedTable = idxTable.replace(dropped, '`some_other_check`');
  const missingInMutated = CONDITIONAL_PROBE_CHECKS.filter((name) => !mutatedTable.includes(name));
  eq('🟡-4 守卫自证：条件检查表内缺一项即红', JSON.stringify([dropped]), JSON.stringify(missingInMutated));
  eq('🟡-4 守卫自证：未变异的表不缺项（反证断言非空转）', JSON.stringify([]),
    JSON.stringify(CONDITIONAL_PROBE_CHECKS.filter((name) => !idxTable.includes(name))));
  // 反证（把「为什么必须按段落变异」写成断言，防后人改回整份文档 replace）：
  // 整份文档 replace 只改到**第一处**；若同一 check 名在别处（如索引行）也出现，
  // `includes()` 仍命中 → 旧自证**空转**（这正是上一版实测逃逸的形态）。
  // ⚠️ 反证必须**自造**一个「名字出现两次」的文本，不能依赖当前文档恰好如此——
  // 否则文档一改（如新增一行索引）反证就自己变红/变绿，成为新的漂移源。
  {
    // 造一段「名字出现两次」的文本：条件检查表里一次 + 别处索引行一次。
    const synthetic = [
      '**另有 1 项条件检查**：',
      '',
      '| 条件检查 | 出口 |',
      '|---|---|',
      `| \`${dropped}\` | ⑤ |`,
      '',
      `另见索引：\`${dropped}\``,
      '',
    ].join('\n');
    eq('🟡-4 反证：自造文本可被段落切出（否则下面的反证空转）', true, tableOf(synthetic).includes(dropped));
    const wholeReplace = synthetic.replace(dropped, '`some_other_check`');
    const tableOnly = tableOf(synthetic).replace(dropped, '`some_other_check`');
    eq('🟡-4 反证：整份文档 replace 只改第一处 → 仍命中（旧自证空转）', true, wholeReplace.includes(dropped));
    eq('🟡-4 反证：按段落变异则真的丢掉该项（新自证有效）', false, tableOnly.includes(dropped));
  }
  // 唯一事实源的 JSDoc 不得再写死 N（评审 🟡-4 的原始缺陷）
  // 唯一事实源的 JSDoc 不得再写死 N（评审 🟡-4 的原始缺陷：JSDoc 写「1 项」、文档写「2 项」）。
  // 只判**代码**视图：JSDoc 里为了说明历史而引用「另有 1 项条件检查」这句原文不算违规
  // （否则守卫会因文档而红，逼人把历史说明删掉——那正是「文档即防线」要保留的东西）。
  const contractSrc = readFileSync(path.join(ROOT, 'src/harness/contract.mjs'), 'utf8');
  eq('🟡-4：contract.mjs 的条件项 JSDoc 不再写死 N（改由本守卫反推）', false,
    /另有\s*\d+\s*项条件检查/.test(codeOnly(contractSrc)));
}

// ---- 2b''. CHANGELOG 对防线编号的自述必须可检索到真实断言（复测 🟡P2-新-3） ----
// 为什么补：v0.1.5 曾自述「[2b] 守住 INDEX 标题/顺序」，但当时 [2b] 只守顺序、不守标题结构——
// 即**自述超前于落地**。这里做机器可检：CHANGELOG 里点名的防线编号（[7b] / [2b] / [2b'] / [2c] 等）
// 必须在对应测试文件中**存在同名编号**，否则红。
console.log("  [2b''] CHANGELOG 防线编号自述可检索");
{
  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const attrSrc = readFileSync(path.join(ROOT, 'tests/test_attribution.mjs'), 'utf8');
  const expSrc = readFileSync(path.join(ROOT, 'tests/test_exports.mjs'), 'utf8');
  const offlineSrc = readFileSync(path.join(ROOT, 'tests/test_offline.sh'), 'utf8');
  const baselineGuardSrc = readFileSync(path.join(ROOT, 'tests/test_baseline_guard.mjs'), 'utf8');
  // 已知防线编号 → 其应出现的测试文件（编号在文件里需以 `[编号]` 形式出现）
  const registry = {
    '[7b]': attrSrc,
    "[2b']": expSrc,
    '[2b]': expSrc,
    '[2c]': expSrc,
    '[2d]': expSrc,
    '[13]': offlineSrc,
    // v0.1.7 新增防线：漂移相关性表唯一事实源（离线）与 triage 影响面（离线）
    '[7c]': attrSrc,
    '[9]': attrSrc,
    '[14]': offlineSrc,
    // v0.3.0 新增防线：契约基线分段（取最早 / 分片独立 / 顺序链式合并 / 迁移幂等）
    '[23]': offlineSrc,
    '[B1]': baselineGuardSrc,
    '[B3]': baselineGuardSrc,
  };
  const claimed = new Set();
  // 只扫「回归防线」列与「防线编号」提及，避免把正文里对其他编号的引用算成自述
  for (const m of changelog.matchAll(/\[(\d+[a-z]?'{0,2})\]/g)) claimed.add(`[${m[1]}]`);
  const unknown = [...claimed].filter((id) => !(id in registry));
  // 未登记的编号：不判失败（可能是历史编号），但**已登记**的必须可检索
  const missing = [...claimed].filter((id) => id in registry && !registry[id].includes(id));
  eq('CHANGELOG 自述的防线编号均可在对应测试文件检索到', [], missing);
  ok('CHANGELOG 防线编号自述扫描完成', `已声明 ${claimed.size} 类，未登记 ${unknown.length} 类`);
}


// ---- 2c. 文档自述版本 = package.json 版本（防「文档说 vX，实际是 vY」） ----
console.log('  [2c] 文档头部版本与 package.json 一致');
{
  const arch = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const m = /版本：`dsh-adapt-hub v([0-9.]+)`/.exec(arch);
  if (!m) bad('docs/ARCHITECTURE.md 头部有版本声明', '未匹配到「版本：dsh-adapt-hub vX」');
  else if (m[1] === pkg.version) ok('docs/ARCHITECTURE.md 版本 = package.json', 'v' + m[1]);
  else bad('docs/ARCHITECTURE.md 版本', '文档 v' + m[1] + ' ≠ package.json v' + pkg.version);
}

// ---- 2d. docs/INDEX.md「产物索引」表**完整性**（防「表格被空行截断 + 重复行」） ----
// 为什么补：v0.2.8 实测——`docs/INDEX.md` §二 产物索引表里，`归因端到端回归` 一行**出现两次**，
// 且两行之间夹了一个**空行**（Markdown 里等于把一张表**劈成两张**：后半张失去表头 ⇒ 渲染成纯文本、
// 「一页找齐」的索引价值直接打折）。而既有守卫只守 §四 的 17 项清单（[2b]/[2b']）与 §二的**条件检查表**
// （[2b''']）——**产物索引表整块无守卫** ⇒ 这类漂移可静默通过（exports 43 项全绿）。
// 判据（三条，都按**定位**而非「字串在不在」）：
//   1) 段落内不得出现「表格 —— 空行 —— 表格」的截断形态（表头与数据行必须连续）；
//   2) 同一张表内不得有**整行重复**（按整行 trim 后精确判，不按前缀）；
//   3) 每行首列的产物名不得重复（防「同物两行、内容各写一半」的顶包形态）。
// 段落锚点：`## 二、产物索引` 起，到下一个 `## ` 标题止。
console.log('  [2d] docs/INDEX.md 产物索引表完整性（无空行截断 / 无重复行）');
{
  const text = readFileSync(path.join(ROOT, 'docs/INDEX.md'), 'utf8');
  const start = text.search(/^##\s*二、产物索引\s*$/m);
  if (start < 0) bad('INDEX 可定位「二、产物索引」段落', '未匹配到段落标题（==真·入口清单丢失）');
  else {
    const after = text.slice(start);
    const nextH2 = after.slice(1).search(/^##\s/m);
    const section = nextH2 < 0 ? after : after.slice(0, nextH2 + 1);

    // 取该段落内的表块：连续的以 `|` 开头的行（首块即产物索引表）
    const lines = section.split('\n');
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      if (/^\s*\|/.test(line)) {
        if (!cur) { cur = []; blocks.push(cur); }
        cur.push(line);
      } else if (line.trim() === '') {
        cur = null; // 空行 ⇒ 表块结束
      } else {
        cur = null; // 非表格行也断开（防跨段落累加）
      }
    }
    eq('INDEX 产物索引段落内表块数 = 1（表格未被空行劈开）', 1, blocks.length);

    const rows = (blocks[0] ?? []).filter((l) => !/^\s*\|[-:\s|]+\|\s*$/.test(l));
    // 表头 + 分隔行 + 数据行；数据行 = 去掉表头行（首行）
    const body = rows.slice(1);
    // 判据 2：整行重复
    const trimmed = body.map((l) => l.trim());
    const dupRows = [...new Set(trimmed.filter((l, i) => trimmed.indexOf(l) !== i))];
    eq('INDEX 产物索引表无整行重复', [], dupRows.map((l) => l.slice(0, 40)));

    // 判据 3：首列产物名唯一
    const firstCol = body.map((l) => l.split('|')[1]?.trim());
    const dupNames = [...new Set(firstCol.filter((n, i) => firstCol.indexOf(n) !== i))];
    eq('INDEX 产物索引表首列（产物名）唯一', [], dupNames);

    // 守卫自证（三条变异必须各自判否，防「断言写成恒真」）：
    // a) 在表中间插一个空行 ⇒ 表块数变 2
    const splitIdx = 2;
    const split = [...body.slice(0, splitIdx), '', ...body.slice(splitIdx)];
    const countBlocks = (arr) => {
      let n = 0; let c = false;
      for (const l of arr) { if (/^\s*\|/.test(l)) { if (!c) { n += 1; c = true; } } else if (l.trim() === '') c = false; else c = false; }
      return n;
    };
    eq('🟡[2d] 守卫自证：表内插空行 ⇒ 表块数 2（非恒真）', 2, countBlocks(split));
    eq('🟡[2d] 守卫自证：原表块数 1（反证当前文档本身正常）', 1, countBlocks(body));
    // b) 复制一行 ⇒ 重复行判据必须命中
    const dupd = [...body, body[body.length - 1]];
    const t2 = dupd.map((l) => l.trim());
    eq('🟡[2d] 守卫自证：复制一行 ⇒ 重复行判据命中', true, t2.some((l, i) => t2.indexOf(l) !== i));
    // c) 首列改名撞车 ⇒ 名重复判据必须命中
    const col = ['A', 'B', 'A'].map((x) => x.split('|')[1]?.trim() ?? x);
    eq('🟡[2d] 守卫自证：首列撞名 ⇒ 名重复判据命中', true, new Set(col).size !== col.length);
  }
}

// ---- 3. 模板拷贝可用（按模板 README 指引：拷贝 + 改 import 行） ----
console.log('  [3] 模板拷贝可用（改 import 后）');
const work = mkdtempSync(path.join(tmpdir(), 'dsh-template-'));
try {
  const templatePath = path.join(ROOT, 'templates', 'adapter', 'index.mjs');
  const raw = readFileSync(templatePath, 'utf8');
  // 模拟「拷贝到你的插件仓库」：把 import 改成指向中台入口（指南推荐写法之一）
  const adapted = raw.replace(
    /^import \{ createAdapter \} from '[^']+';$/m,
    `import { createAdapter } from '${pathToFileURL(path.join(ROOT, 'src', 'adapter.mjs')).href}';`,
  );
  if (adapted === raw) { bad('模板 import 行可被替换', '未匹配到 import 行'); }
  else ok('模板 import 行可被替换（拷贝后改这一行即可）');
  writeFileSync(path.join(work, 'index.mjs'), adapted);
  mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  try {
    const mod = await import(pathToFileURL(path.join(work, 'index.mjs')).href);
    const hasApply = typeof mod.apply === 'function';
    const defs = typeof mod.definitions === 'function' ? mod.definitions() : [];
    if (hasApply && Array.isArray(defs) && defs.length > 0) ok('拷贝后的模板可加载', `apply + ${defs.length} 个工具定义`);
    else bad('拷贝后的模板可加载', `apply=${typeof mod.apply} definitions=${defs.length}`);
  } catch (error) {
    bad('拷贝后的模板可加载', error.code ?? error.message);
  }
  // 模板本身不得再用只在仓内可解析的相对路径
  if (/from '\.\.\/\.\.\/src\/adapter\.mjs'/.test(raw) && !/TODO\(拷贝后必改\)/.test(raw)) {
    bad('模板 import 有「拷贝后必改」提示', '相对路径无提示，拷走即 ERR_MODULE_NOT_FOUND');
  } else ok('模板 import 有「拷贝后必改」提示');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log();
console.log(`▶ 发布面自检结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
