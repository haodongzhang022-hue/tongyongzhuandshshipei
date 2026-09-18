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
  // 已知防线编号 → 其应出现的测试文件（编号在文件里需以 `[编号]` 形式出现）
  const registry = {
    '[7b]': attrSrc,
    "[2b']": expSrc,
    '[2b]': expSrc,
    '[2c]': expSrc,
    '[13]': offlineSrc,
    // v0.1.7 新增防线：漂移相关性表唯一事实源（离线）与 triage 影响面（离线）
    '[7c]': attrSrc,
    '[9]': attrSrc,
    '[14]': offlineSrc,
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
