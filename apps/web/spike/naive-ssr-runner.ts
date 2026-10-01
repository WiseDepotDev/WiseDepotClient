/**
 * Spike A 的 SSR 入口（被 `vite build --ssr` 打包成一个自包含的 .mjs 后由 node 执行）。
 *
 * 为什么走"先构建再执行"而不是 `server.ssrLoadModule`：
 * pnpm 的隔离式 node_modules 下，SSR module runner 对 naive-ui 的传递依赖
 * （`css-render` 等）会解析失败（ERR_MODULE_NOT_FOUND）。构建路径交给 Rollup，
 * 所有依赖被打进同一个 bundle，也就天然保证了 css-render 只有一份实例 —— 这正是 collect() 能工作的前提。
 */
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { setup } from '@css-render/vue3-ssr';
import {
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDialogProvider,
  NForm,
  NFormItem,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NPagination,
  NTag,
} from 'naive-ui';
import type { GlobalThemeOverrides } from 'naive-ui';
import {
  NAIVE_DEFAULT_HEXES,
  fullOverrides,
  fullOverridesWithInverted,
  partialOverrides,
} from './theme.spike';

interface Row {
  code: string;
  bin: string;
  status: string;
}

function buildApp(overrides: GlobalThemeOverrides) {
  const columns = [
    { title: '单号', key: 'code' },
    { title: '库位', key: 'bin' },
    { title: '状态', key: 'status' },
  ];
  const data: Row[] = [{ code: 'WD-0001', bin: 'A-01-08', status: '正常' }];

  return {
    render: () =>
      h(
        NConfigProvider,
        { themeOverrides: overrides },
        {
          default: () =>
            h(
              NLayout,
              { hasSider: true },
              {
                default: () => [
                  h(
                    NLayoutSider,
                    { width: 232, inverted: true },
                    {
                      default: () =>
                        h(NMenu, {
                          inverted: true,
                          options: [
                            { label: '工作台', key: 'dashboard' },
                            { label: '库存中心', key: 'inventory' },
                          ],
                        }),
                    },
                  ),
                  h(
                    NLayoutContent,
                    { contentStyle: { padding: '16px' } },
                    {
                      default: () => [
                        h(NDialogProvider, null, {
                          default: () =>
                            h(
                              NCard,
                              { title: '库存明细' },
                              {
                                default: () => [
                                  h(NDataTable, { columns, data, size: 'large' }),
                                  h(NPagination, { page: 1, pageCount: 12 }),
                                ],
                              },
                            ),
                        }),
                        h(NButton, { type: 'primary', size: 'large' }, { default: () => '新建入库单' }),
                        h(NTag, { type: 'success' }, { default: () => '正常' }),
                        h(NTag, { type: 'warning' }, { default: () => '待补货' }),
                        h(NTag, { type: 'error' }, { default: () => '低库存' }),
                        h(NForm, null, {
                          default: () => [
                            h(NFormItem, { label: '库位' }, {
                              default: () => h(NInput, { placeholder: '搜索库位' }),
                            }),
                          ],
                        }),
                      ],
                    },
                  ),
                ],
              },
            ),
        },
      ),
  };
}

function countHexes(text: string, hexes: readonly string[]) {
  const lower = text.toLowerCase();
  return hexes
    .map((h) => ({ hex: h, count: lower.split(h.toLowerCase()).length - 1 }))
    .filter((x) => x.count > 0);
}

async function once(label: string, overrides: GlobalThemeOverrides) {
  const app = createSSRApp(buildApp(overrides));
  // 注意：@css-render/vue3-ssr 的 setup() 收的是**单个 app**（不是数组）——
  // 传数组会在 setup 内部炸 `app.provide is not a function`。
  const { collect } = setup(app) as unknown as { collect: () => unknown };
  const html = await renderToString(app);
  const raw = collect();
  const css = Array.isArray(raw) ? (raw as unknown[]).join('\n') : String(raw);
  // Naive 的令牌值是**内联在元素 style 上**的 CSS 变量（--n-color 等），不在 collect() 的静态样式里；
  // 因此既要看 css 也要看 html，只查一边会得出"覆盖没生效"的错误结论。
  const both = `${css}\n${html}`;
  const leaked = countHexes(both, NAIVE_DEFAULT_HEXES);
  const lowerBoth = both.toLowerCase();
  const siderStyle = /class="n-layout-sider[^"]*"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? '(未匹配到)';
  const menuStyle = /class="n-menu[^"]*"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? '(未匹配到)';
  return {
    label,
    cssBytes: css.length,
    htmlBytes: html.length,
    collectWorks: css.length > 0,
    primaryTokenInCss: css.toLowerCase().includes('#087c75'),
    primaryTokenInHtml: html.toLowerCase().includes('#087c75'),
    primaryTokenApplied: lowerBoth.includes('#087c75'),
    menuNavBgApplied: lowerBoth.includes('#102e3e'),
    navMutedTextApplied: lowerBoth.includes('#b9cdd5'),
    heightLarge48Applied: /--n-height:\s*48px/.test(html),
    tableRendered: html.includes('单号') && html.includes('A-01-08'),
    menuRendered: html.includes('库存中心'),
    siderStyleVars: siderStyle.slice(0, 420),
    menuStyleVars: menuStyle.slice(0, 420),
    leakedNaiveDefaults: leaked,
    leakTotal: leaked.reduce((a, b) => a + b.count, 0),
  };
}

export async function runAll() {
  const partial = await once('partial（只覆盖 primary）', partialOverrides);
  const full = await once('full（覆盖设计稿 §6.3 的普通键）', fullOverrides);
  const withInverted = await once('full + *Inverted 键（修正）', fullOverridesWithInverted);
  return { generatedAt: new Date().toISOString(), partial, full, withInverted };
}
