#!/usr/bin/env node
/**
 * check-vue-render.mjs —— Vue 侧的外壳与逐屏渲染门禁（**不需要浏览器**）。
 *
 * ## 它替代了什么，以及为什么保留
 *
 * V6 之前这条门禁是 React 版：`tools/check/shell-render-entry.tsx` + `react-dom/server`，
 * 用例是手抄的一张清单（外壳 + 30 个屏）。React 版删掉后，价值必须留下 ——
 * **渲染期崩溃**是浏览器冒烟之外的另一种失败模式：
 * 少了 undefined 判断、模板引用不存在的属性、组件 setup 抛异常，
 * 都会表现为"整屏白"，而这类问题在冒烟里要么要跑几十秒、要么因为路由没走到而漏掉。
 *
 * 现在的做法：
 *   · 用 Vite 的 `ssrLoadModule` 加载 `apps/web/ssr/render-entry.ts`（`.vue` 由 Vite 编译，
 *     与开发态**同一套解析器与同一份 vite.config**）；
 *   · 用例来自 **`SCREEN_REGISTRY` 本身**，不是手抄清单 —— 以后新增一屏自动被覆盖，
 *     少写一屏也不会"忘了加用例"；
 *   · 每条用例断言：**渲染不抛异常** + **页头标题存在且非空**（有期望值的再比一次文案）。
 *
 * 断的是结构不是数据：SSR 首帧本来就是骨架/空态，数据正确性归真后端与 `check:web-smoke`。
 *
 * 用法：node tools/check/check-vue-render.mjs
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const APP_ROOT = path.join(CLIENT_ROOT, 'apps', 'web');

/*
 * `vite` 只装在 `apps/web`（pnpm 隔离式 node_modules，根上没声明），
 * 所以从 `tools/` 直接 `import 'vite'` 会 ERR_MODULE_NOT_FOUND。
 * 这里按 apps/web 的解析结果**显式**引进来 —— 与本仓其它门禁（从根引 esbuild）同一个思路：
 * 门禁要用哪个包的依赖，就说清楚它是谁的依赖。
 */
const { createServer } = await import(
  pathToFileURL(path.join(APP_ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
);

let passed = 0;
const failures = [];

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${what}`);
    return;
  }
  failures.push(`${what}${detail === '' ? '' : ` —— ${detail}`}`);
  console.error(`  ✗ ${what}${detail === '' ? '' : ` —— ${detail}`}`);
}

/** 从渲染结果里取页头标题（Vue 版 PageHeader 的结构标记）。 */
function titleOf(html) {
  const m = /class="w-page-header__title"[^>]*>([^<]*)</.exec(html);
  return m ? m[1].trim() : '';
}

/**
 * 能力位驱动的"画 / 不画"断言（`present` / `absent`）。
 *
 * 只有渲染一次是不够的：一个"有没有能力都画出来"的入口在真机上表现为
 * "点了没反应"，而在只渲染有能力的形态时**永远不会被这条门禁发现**。
 * 所以每种能力形态各渲染一次，两边都断。
 */
function checkMarkers(item, html) {
  /*
   * **先去掉 HTML 注释**：Vue 的 SSR 会把模板里的 `<!-- … -->` 原样输出，
   * 而本仓的模板注释写得很详细（"相机扫码入口：只在宿主声明 … 时出现"）——
   * 直接对整份 HTML 做 includes 的话，注释里的字会让"没能力就不画"这条断言**永远失败**
   * （第一版就是这么写的，红的是断言而不是实现）。
   */
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const token of item.present ?? []) {
    check(`${item.name} 应出现「${token}」`, text.includes(token), '有该能力却没画出来');
  }
  for (const token of item.absent ?? []) {
    check(`${item.name} 不应出现「${token}」`, !text.includes(token), '没有该能力却画了出来（点了没反应的入口）');
  }
}

let server;
try {
  server = await createServer({
    root: APP_ROOT,
    configFile: path.join(APP_ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    /*
     * 这些包必须**由 Vite 处理**（而不是交给 Node 的 ESM loader）：
     *   · `element-plus` / `@element-plus/icons-vue`：它们带 `.css` 导入（unplugin 也会注入），
     *     交给 Node 就是 `Unknown file extension ".css"`；Vite 在 SSR 下会把样式当空模块。
     *   · `@wise/*`：工作区包是 `.ts` / `.vue` 源码，Node 直接加载不了。
     * 反过来 `vue` / `pinia` / `vue-router` 保持 external —— 它们是纯 JS，
     * 而且把 Vue 打进 bundle 会踩到 Spike A 记过的那个坑（CJS 版 Vue 里 `module is not defined`）。
     */
    ssr: {
      noExternal: [/^element-plus/, /^@element-plus\//, /^@wise\//],
    },
  });

  const mod = await server.ssrLoadModule('/ssr/render-entry.ts');
  if (typeof mod.renderCases !== 'function') {
    console.error('✗ render-entry.ts 没有导出 renderCases()');
    process.exit(1);
  }

  const cases = await mod.renderCases();
  check('渲染用例来自注册表（外壳 + 每一屏）', cases.length >= 25, `用例数=${cases.length}`);

  for (const item of cases) {
    const html = String(item.html ?? '');
    if (html.length < 80) {
      check(item.name, false, `渲染结果只有 ${html.length} 字节，像是空屏`);
      continue;
    }
    if (item.name.startsWith('AppFrame')) {
      // 外壳断的是壳自己的结构：品牌、四域分组、命令栏、账号区
      const shellMarkers = ['慧仓智控', 'WISEDEPOT', 'w-commandbar', 'w-sidebar', '运营', '库存', '现场', '管理'];
      const missing = shellMarkers.filter((token) => !html.includes(token));
      check(item.name, missing.length === 0, missing.length > 0 ? `缺结构标记：${missing.join(', ')}` : '');
      checkMarkers(item, html);
      continue;
    }
    const title = titleOf(html);
    if (title === '') {
      check(item.name, false, '页头标题为空（要么没渲染，要么标题没接上）');
      continue;
    }
    if (item.expectedTitle !== undefined && title !== item.expectedTitle) {
      check(item.name, false, `页头标题是「${title}」，期望「${item.expectedTitle}」`);
      continue;
    }
    check(item.name, true);
    checkMarkers(item, html);
  }
} catch (error) {
  console.error(`✗ 渲染门禁执行失败：${error?.stack ?? error}`);
  process.exit(1);
} finally {
  if (server) {
    await server.close();
  }
}

if (failures.length > 0) {
  console.error(`check-vue-render: ${failures.length}/${passed + failures.length} 个用例失败`);
  process.exit(1);
}
console.log(`check-vue-render OK: ${passed} 个用例（外壳结构 + 注册表里每一屏都渲染得出且有页头标题）`);
