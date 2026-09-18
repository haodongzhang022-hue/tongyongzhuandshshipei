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
