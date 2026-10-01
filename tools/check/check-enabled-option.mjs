#!/usr/bin/env node
/**
 * check-enabled-option.mjs —— `enabled` 必须是**响应式**的，不能传当场求值的布尔表达式。
 *
 * ## 为什么值得一条门禁
 *
 * `useResource(method, params, { enabled: … })` 内部是 `toValue(options.enabled)`：
 * 传 `computed(() => x !== undefined)` 会随 x 变；传 `x !== undefined` 就是**一个常量 false/true**，
 * 之后再也不会变。
 *
 * 而这类错误的现场表现**极难判断**：
 *   · 不报错（`error` 为空）、不转圈（`loading` 为 false）；
 *   · 界面只是稳定显示一句空态文案（"资料暂时取不到"），看起来像后端没数据；
 *   · 也不会发任何请求 —— 拿抓包/日志去查会以为是网络或服务端的问题。
 *
 * 实测踩到一次：用户管理屏点行之后 `user.detail` / `user.roles` **一次请求都没发**，
 * 明细面板永远是空态（同一批其它屏都传的是 `hasTarget` / `hasId` 这类 computed，所以只有那一处坏）。
 *
 * 规则（只认**无歧义**的写法，避免误报）：
 *   · 允许：裸标识符（`hasTarget`，通常是 computed）、`computed(...)`、箭头函数 / getter（含 `=>`）、`options.enabled`。
 *   · 禁止：布尔字面量（`true` / `false`）、含比较或逻辑运算符的当场表达式
 *     （`x !== undefined`、`x && y`、`!x`、`typeof x === 'number'`）。
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
    } else if (entry.name.endsWith('.vue')) {
      out.push(full);
    }
  }
  return out;
}

/** 取 `enabled:` 之后那一段值（到同一层的逗号/右括号/换行为止）。 */
function valueAfter(text, index) {
  const rest = text.slice(index);
  let depth = 0;
  let out = '';
  for (const ch of rest) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      break;
    } else if ((ch === '\n' || ch === '\r') && depth === 0) {
      break;
    }
    out += ch;
  }
  return out.trim();
}

/** 这条 `enabled` 的值是不是"当场求值的布尔表达式"。 */
function isStaticBoolean(value) {
  if (value === '') {
    return false;
  }
  // 允许：getter / 箭头函数（自己就是响应式来源）
  if (value.includes('=>')) {
    return false;
  }
  // 允许：computed(...) 与裸标识符（通常是 computed ref）
  if (/^computed\s*\(/.test(value)) {
    return false;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    return false;
  }
  if (/^true$|^false$/.test(value)) {
    return true;
  }
  // 比较 / 逻辑 / typeof / 取反：都是"当场算出来的常量"
  return /[=!<>]==|!==|&&|\|\||^!|\btypeof\b/.test(value);
}

let problems = 0;
let scanned = 0;
const files = ROOTS.flatMap((root) => walk(root));

for (const file of files) {
  const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('enabled')) {
    continue;
  }
  scanned += 1;
  const re = /enabled\s*:/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const value = valueAfter(raw, match.index + match[0].length);
    if (!isStaticBoolean(value)) {
      continue;
    }
    const line = raw.slice(0, match.index).split('\n').length;
    console.error(
      `✗ ${rel}:${line} 的 enabled 是当场求值的布尔表达式（${value}）—— 它不会随依赖变化，` +
        `资源会永远停在"不发请求"的状态（界面只显示空态，不报错也不转圈）。请传 computed 或 getter。`,
    );
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`check-enabled-option: 扫描 ${scanned} 个含 enabled 的 .vue，发现 ${problems} 处问题。`);
  process.exit(1);
}
console.log(`check-enabled-option OK: 扫描 ${scanned} 个含 enabled 的 .vue，全部是响应式写法（ref / computed / getter）`);
