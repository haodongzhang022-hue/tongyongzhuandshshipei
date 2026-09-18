/**
 * 源码扫描工具（**测试专用**）：把源码降为「只含代码」的视图，供守卫断言使用。
 *
 * ## 为什么需要它（评审 P2-10 的教训）
 * 原先的守卫直接对源码跑正则 `/errors\.(includes|match|test)|errors\.join|HOST_FATAL_PREFIX\)/`，
 * 两个盲区：
 * 1. **别名可绕过**：`const logLines = probe.errors; logLines.join('|')` 不命中 `errors.` 前缀；
 * 2. **注释/文档会误报**：JSDoc 里写着「不读 errors」反而命中 `errors.`。
 *
 * 本模块提供两件事：
 * - {@link stripComments}：只去注释（保守，用于「不得出现某字面量」这类断言）；
 * - {@link codeOnly}：去注释 + 去字符串/模板字面量的**文本部分**（保留 `${...}` 插值里的代码）。
 *
 * 为什么保留插值：把文本扫描写回判据的最短路径恰恰是
 * ``reasons.push(`${errors.join('|')}`)``——若整段模板字面量都被当「文本」删掉，这个活口就漏检了。
 * 守卫本身不能有盲区（P2-10 的教训）。
 *
 * @module dsh-adapt-hub/tests/source-scan
 */

/**
 * 去掉 `//` 行注释与 `/* *\/` 块注释（保守实现：不区分字符串内的 `//`）。
 *
 * @param {string} source 源码
 * @returns {string} 去注释后的源码
 */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * 把源码降为「只含代码」：去注释、去字符串与模板字面量的文本部分（保留插值内代码）。
 *
 * @param {string} source 源码
 * @returns {string} 仅代码视图
 */
export function codeOnly(source) {
  const text = String(source);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' S ';
      continue;
    }
    if (ch === '`') {
      i += 1;
      let inner = '';
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            i += 1;
          }
          inner += ` ${text.slice(start, i - 1)} `;
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ` T${inner}T `;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
