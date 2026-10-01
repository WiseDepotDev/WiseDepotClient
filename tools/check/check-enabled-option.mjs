#!/usr/bin/env node
/**
 * check-enabled-option.mjs —— `useResource` 的 `enabled` 必须是**响应式**的。
 *
 * ## 为什么值得一条门禁
 *
 * `useResource(method, params, { enabled: … })` 内部是 `toValue(options.enabled)`：
 * 传 `computed(() => x !== undefined)` 会随 x 变；传 `x !== undefined` 就是**一个常量**，
 * 之后再也不会变。
 *
 * 而这类错误的现场表现**极难判断**：
 *   · 不报错（`error` 为空）、不转圈（`loading` 为 false）；
 *   · 界面只是稳定显示一句空态文案（"资料暂时取不到"），看起来像后端没数据；
 *   · 也不会发任何请求 —— 拿抓包/日志去查会以为是网络或服务端的问题。
 *
 * 实测踩到一次：用户管理屏点行之后 `user.detail` / `user.roles` **一次请求都没发**，
 * 明细面板永远是空态。
 *
 * ## 扫描范围必须精准（踩过一次误报）
 *
 * 只扫 **`useResource(...)` 调用实参里的 `enabled:`**，不是全文件的 `enabled:`。
 * 早先的版本扫全文，结果把 `openEdit` 里普通对象字面量的 `enabled: row.enabled !== false`
 * （一个表单初值，跟资源层毫无关系）判成了缺陷 —— **误报会让人把门禁关掉**，
 * 那比不写这条门禁更糟。
 *
 * 规则（只认无歧义的写法）：
 *   · 允许：裸标识符（`hasTarget`，通常是 computed）、`computed(...)`、箭头函数 / getter（含 `=>`）。
 *   · 禁止：布尔字面量、含比较或逻辑运算符的当场表达式（`x !== undefined`、`x && y`、`!x`、`typeof x === 'number'`）。
 *
 * 用法：node tools/check/check-enabled-option.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ROOTS = [path.join(CLIENT_ROOT, 'apps', 'web', 'src'), path.join(CLIENT_ROOT, 'packages')];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'target']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释与字符串字面量的内容（括号配对时不该被字符串里的括号带偏）。 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** 从 `(` 开始找到配对的 `)`，返回实参文本。 */
function argsOf(code, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(openIndex + 1, i);
      }
    }
  }
  return '';
}

/** 取 `enabled:` 之后那一段值（到同一层的逗号/右括号为止）。 */
function valueAfter(text, index) {
  let depth = 0;
  let out = '';
  for (const ch of text.slice(index)) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      break;
    }
    out += ch;
  }
  return out.trim();
}

/** 这条 `enabled` 的值是不是"当场求值的布尔表达式"。 */
function isStaticBoolean(value) {
  if (value === '' || value.includes('=>')) {
    return false;
  }
  if (/^computed\s*\(/.test(value)) {
    return false;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    return false;
  }
  if (/^true$|^false$/.test(value)) {
    return true;
  }
  return /[=!<>]==|!==|&&|\|\||^!|\btypeof\b/.test(value);
}

let problems = 0;
let scannedFiles = 0;
let scannedOptions = 0;
const files = ROOTS.flatMap((root) => walk(root));

for (const file of files) {
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('useResource')) {
    continue;
  }
  scannedFiles += 1;
  const code = codeOnly(raw);

  // 找出每一次 useResource(...) 的实参
  const callRe = /useResource\s*(?:<[^>]*>)?\s*\(/g;
  let call;
  while ((call = callRe.exec(code)) !== null) {
    const openIndex = code.indexOf('(', call.index);
    const args = argsOf(code, openIndex);
    const enabledRe = /enabled\s*:/g;
    let hit;
    while ((hit = enabledRe.exec(args)) !== null) {
      scannedOptions += 1;
      const value = valueAfter(args, hit.index + hit[0].length);
      if (!isStaticBoolean(value)) {
        continue;
      }
      const line = code.slice(0, call.index).split('\n').length;
      console.error(
        `✗ ${rel}:${line} 的 useResource enabled 是当场求值的布尔表达式（${value}）—— 它不会随依赖变化，` +
          `资源会永远停在"不发请求"的状态（界面只显示空态，不报错也不转圈）。请传 computed 或 getter。`,
      );
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`check-enabled-option: 扫描 ${scannedFiles} 个含 useResource 的文件（${scannedOptions} 处 enabled），发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(
  `check-enabled-option OK: 扫描 ${scannedFiles} 个含 useResource 的文件、${scannedOptions} 处 enabled，全部是响应式写法（ref / computed / getter）`,
);
