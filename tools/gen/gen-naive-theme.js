#!/usr/bin/env node
/**
 * 从 `packages/tokens/src/theme.json` 生成两份产物（Vue 重写用）：
 *
 *   1. `packages/tokens/src/generated/theme.v2.css` —— `:root { --w-* }`，给自写样式用
 *   2. `apps/web/src/theme/naive.ts`              —— Naive UI 的 `GlobalThemeOverrides`
 *
 * ## 为什么不改 tools/gen/gen-tokens.js
 * 那份生成器是为**旧 Compose 主题基线**服务的，还有 `--check` 与归档对照的门禁在跑。
 * Vue 重写要换基线（设计稿 §6.1），但 React 版还在树上、且需要一个可回滚点。
 * 所以这里**新增**一条生成链，等 React 版退役（V6）再把两条合成一条。
 *
 * ## 为什么 naivte 主题生成到 apps/web 而不是 packages/tokens
 * `GlobalThemeOverrides` 来自 naive-ui；`@wise/tokens` 不该依赖 UI 库。
 * apps/web 已经是 naive-ui 的直接依赖方，生成到那里类型自然可解析。
 * （设计稿 §3.2 的目录树里本来就把 `src/theme/naive.ts` 放在 apps/web。）
 *
 * ## 用法
 *   node tools/gen/gen-naive-theme.js           生成
 *   node tools/gen/gen-naive-theme.js --check   只校验生成物与 theme.json 一致
 *
 * naive-ui 的 `*Inverted` 键是 Spike A 实测发现的必需项（见 docs/superpowers/plans/2026-10-02-v1-spikes.md）：
 * `NLayoutSider inverted` / `NMenu inverted` 会绕过普通主题键，不写这批键则深青侧栏根本不生效。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const themePath = resolve(root, 'packages/tokens/src/theme.json');
const cssPath = resolve(root, 'packages/tokens/src/generated/theme.v2.css');
const elPath = resolve(root, 'packages/tokens/src/generated/theme.el.css');
/** 历史产物：早期用 naive-ui 时的主题覆盖，现已改用 Element Plus，不再生成。 */
const naivePath = resolve(root, 'apps/web/src/theme/naive.ts');

const check = process.argv.includes('--check');
const theme = JSON.parse(readFileSync(themePath, 'utf8'));

/** camelCase → kebab-case，用于 CSS 变量名。 */
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const must = (cond, msg) => {
  if (!cond) {
    console.error(`theme.json 校验失败：${msg}`);
    process.exit(1);
  }
};

// ---- 基本校验：取值必须是 hex / 数字 / 字符串；嵌套结构单独校验 ----
const isHex = (v) => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
for (const [group, entries] of Object.entries(theme)) {
  if (group.startsWith('$')) continue;
  if (typeof entries !== 'object' || entries === null) continue;
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && typeof value === 'object') continue; // type.* 这类嵌套结构下面单独校验
    must(
      typeof value === 'number' || typeof value === 'string',
      `${group}.${key} 必须是数字或字符串（实际 ${typeof value}）`,
    );
  }
}
for (const group of ['color', 'nav', 'brand', 'state']) {
  must(theme[group], `缺少 ${group} 组`);
  for (const [k, v] of Object.entries(theme[group])) {
    if (k.startsWith('$')) continue;
    must(isHex(v), `${group}.${k} 必须是 #RRGGBB`);
  }
}
for (const group of ['space', 'radius', 'size', 'motion', 'breakpoint', 'density']) {
  must(theme[group], `缺少 ${group} 组`);
  for (const [k, v] of Object.entries(theme[group])) must(typeof v === 'number', `${group}.${k} 必须是数字`);
}
for (const [k, v] of Object.entries(theme.type)) {
  must(typeof v.size === 'number' && typeof v.lineHeight === 'number', `type.${k} 需要 size/lineHeight 数字`);
}

// ---- 1. CSS 变量 ----
const cssLines = [];
const emitVar = (name, value, unit = '') => cssLines.push(`  --w-${name}: ${value}${unit};`);
for (const [k, v] of Object.entries(theme.color)) emitVar(`color-${kebab(k)}`, v);
for (const [k, v] of Object.entries(theme.nav)) {
  if (!k.startsWith('$')) emitVar(`nav-${kebab(k)}`, v);
}
for (const [k, v] of Object.entries(theme.brand)) {
  if (!k.startsWith('$')) emitVar(`brand-${kebab(k)}`, v);
}
for (const [k, v] of Object.entries(theme.state)) emitVar(`state-${kebab(k)}`, v);
for (const [k, v] of Object.entries(theme.space)) emitVar(`space-${kebab(k)}`, v, 'px');
for (const [k, v] of Object.entries(theme.radius)) emitVar(`radius-${kebab(k)}`, v, 'px');
for (const [k, v] of Object.entries(theme.size)) emitVar(`size-${kebab(k)}`, v, 'px');
for (const [k, v] of Object.entries(theme.motion)) emitVar(`motion-${kebab(k)}`, v, 'ms');
for (const [k, v] of Object.entries(theme.breakpoint)) emitVar(`breakpoint-${kebab(k)}`, v, 'px');
for (const [k, v] of Object.entries(theme.density)) emitVar(`density-${kebab(k)}`, v, 'px');
for (const [k, v] of Object.entries(theme.type)) {
  emitVar(`type-${kebab(k)}-size`, v.size, 'px');
  emitVar(`type-${kebab(k)}-line`, v.lineHeight, 'px');
  emitVar(`type-${kebab(k)}-weight`, v.weight);
}
emitVar('font-family', theme.font.family);
emitVar('font-mono', theme.font.monoFamily);

const css = `/*
 * 由 tools/gen/gen-naive-theme.js 从 packages/tokens/src/theme.json 生成 —— 不要手改。
 * 取值来自参考图逐像素统计，见设计稿 §6.1。
 */
:root {
${cssLines.join('\n')}
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --w-motion-fast: 0ms;
    --w-motion-normal: 0ms;
  }
}
`;

// ---- 2. Naive themeOverrides ----
const c = theme.color;
const n = theme.nav;
const b = theme.brand;
const s = theme.state;
const r = theme.radius;
const d = theme.density;

// ---- 1b. Element Plus 主题桥（饿了么组件） ----
/**
 * Element Plus 用一套 `--el-*` CSS 变量做主题。
 * 这里把 theme.json 映射过去 —— **不写死任何颜色**，与 `--w-*` 同源。
 *
 * 为什么 `light-3/5/7/8/9` 要自己算：EP 的悬停/禁用/浅底都取这几档，
 * 不覆盖就会漏出 EP 默认蓝的浅色变体（和 Naive 时代"漏 40 处默认色"是同一类问题）。
 * 公式与 EP 一致：`light-N = mix(白, 主色, N/10)`，`dark-2 = mix(黑, 主色, 20%)`。
 */
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
/** EP 的 mix：`mix(a, b, ratio)` = a*(1-ratio) + b*ratio。 */
const mix = (hex, base, ratio) => {
  const a = toRgb(hex);
  const b = toRgb(base);
  return toHex(a.map((v, i) => v * (1 - ratio) + (b[i] ?? 0) * ratio));
};
const WHITE = '#FFFFFF';
const BLACK = '#000000';
/**
 * EP 的浅色档：`light-N = mix(白, 主色, N*10%)`（N 越大越接近白）。
 *
 * 第一版把比例写成 `1 - n/10`，结果 light-3 比 light-9 还深 —— 悬停态与浅底全部反了。
 * 这类错误不会报错、只会"看起来怪"，所以顺手在 `check:theme` 里加了一条单调性断言。
 */
const light = (hex, n) => mix(hex, WHITE, n / 10);

const elLines = [];
const el = (name, value) => elLines.push(`  --el-${name}: ${value};`);
const semantic = (name, value, fillHex) => {
  el(`color-${name}`, value);
  el(`color-${name}-light-3`, light(value, 3));
  el(`color-${name}-light-5`, light(value, 5));
  el(`color-${name}-light-7`, light(value, 7));
  el(`color-${name}-light-8`, light(value, 8));
  el(`color-${name}-light-9`, fillHex);
  el(`color-${name}-dark-2`, mix(value, BLACK, 0.2));
};

semantic('primary', c.primary, c.primarySoft);
semantic('success', s.successText, s.successFill);
semantic('warning', s.warningText, s.warningFill);
semantic('danger', s.dangerText, s.dangerFill);
semantic('error', s.dangerText, s.dangerFill);
semantic('info', s.neutralText, s.neutralFill);

el('text-color-primary', c.onSurface);
el('text-color-regular', c.onSurfaceVariant);
el('text-color-secondary', c.onSurfaceMuted);
el('text-color-placeholder', c.onSurfaceMuted);
el('text-color-disabled', c.onSurfaceMuted);

el('border-color', c.outline);
el('border-color-light', c.outlineSubtle);
el('border-color-lighter', c.outlineSubtle);
el('border-color-extra-light', c.outlineSubtle);

el('bg-color', c.surface);
el('bg-color-page', c.bg);
el('bg-color-overlay', c.surface);
el('fill-color', c.surfaceAlt);
el('fill-color-light', c.surfaceAlt);
el('fill-color-lighter', c.bg);
el('fill-color-extra-light', c.bg);
el('fill-color-blank', c.surface);

el('border-radius-base', `${r.control}px`);
el('border-radius-small', `${r.chip}px`);
el('border-radius-round', `${r.pill}px`);
el('font-family', theme.font.family);
el('font-size-base', `${theme.type.body.size}px`);
el('font-size-small', `${theme.type.bodySmall.size}px`);
el('font-size-large', `${theme.type.body.size}px`);
// 触控目标：EP 默认 medium 是 32px、large 是 40px，都低于现场要求的 48px
el('component-size-large', `${d.controlHeight}px`);
el('component-size', `${d.controlHeightSm}px`);
el('component-size-small', `${d.controlHeightXs}px`);

const elCss = `/*
 * 由 tools/gen/gen-naive-theme.js 从 packages/tokens/src/theme.json 生成 —— 不要手改。
 * Element Plus 主题桥：把 --w-* 语义令牌映射到 --el-* 变量。
 * 少了哪一档，EP 就会在那个位置漏出默认蓝 —— 门禁 check:el-theme 盯的就是这件事。
 */
:root {
${elLines.join('\n')}
}
`;

// ---- 2. Naive themeOverrides（历史产物，Vue 重写早期用过；现改用 Element Plus） ----
const overrides = {
  common: {
    primaryColor: c.primary,
    primaryColorHover: c.primaryHover,
    primaryColorPressed: c.primaryPressed,
    primaryColorSuppl: c.primaryHover,
    infoColor: s.infoText,
    infoColorHover: s.infoText,
    successColor: s.successText,
    successColorHover: s.successText,
    warningColor: s.warningText,
    warningColorHover: s.warningText,
    errorColor: s.dangerText,
    errorColorHover: s.dangerText,
    textColorBase: c.onSurface,
    textColor1: c.onSurface,
    textColor2: c.onSurface,
    textColor3: c.onSurfaceMuted,
    placeholderColor: c.onSurfaceMuted,
    borderColor: c.outline,
    dividerColor: c.outlineSubtle,
    bodyColor: c.bg,
    cardColor: c.surface,
    modalColor: c.surface,
    popoverColor: c.surface,
    tableColor: c.surface,
    tableHeaderColor: c.surfaceAlt,
    hoverColor: c.surfaceAlt,
    borderRadius: `${r.control}px`,
    borderRadiusSmall: `${r.chip}px`,
    fontFamily: theme.font.family,
    fontFamilyMono: theme.font.monoFamily,
    fontSize: `${theme.type.body.size}px`,
    fontSizeMedium: `${theme.type.body.size}px`,
    heightLarge: `${d.controlHeight}px`,
    heightMedium: `${d.controlHeightSm}px`,
    heightSmall: `${d.controlHeightXs}px`,
  },
  Button: {
    borderRadiusLarge: `${r.control}px`,
    textColorPrimary: c.onPrimary,
    fontWeight: '500',
  },
  Card: {
    borderRadius: `${r.card}px`,
    color: c.surface,
    borderColor: c.outline,
    paddingMedium: `${theme.space.cardPadding}px`,
    titleFontSizeMedium: `${theme.type.sectionTitle.size}px`,
    titleFontWeight: `${theme.type.sectionTitle.weight}`,
  },
  DataTable: {
    thColor: c.surfaceAlt,
    thTextColor: c.onSurfaceMuted,
    thFontWeight: '500',
    tdColor: c.surface,
    tdColorHover: c.surfaceAlt,
    tdColorStriped: c.surfaceAlt,
    tdTextColor: c.onSurface,
    borderColor: c.outlineSubtle,
    borderRadius: `${r.card}px`,
    thPaddingMedium: '10px 12px',
    tdPaddingMedium: '10px 12px',
  },
  Menu: {
    color: 'transparent',
    borderRadius: `${r.control}px`,
    itemHeight: `${d.controlHeightSm}px`,
    groupTextColor: n.groupLabel,
    itemTextColor: n.fgMuted,
    itemTextColorHover: n.fg,
    itemTextColorActive: n.fg,
    itemIconColor: n.fgMuted,
    itemIconColorHover: n.fg,
    itemIconColorActive: n.fg,
    arrowColor: n.fgMuted,
    itemColorHover: n.itemHoverBg,
    itemColorActive: n.itemActiveBg,
    itemColorActiveHover: n.itemActiveBg,
    // Spike A：inverted 变体绕过上面这批键，必须单独给一遍。
    // 语义是"**深色品牌面**上的菜单"（登录/浮层一类），所以这里指 brand 而不是 nav。
    itemTextColorInverted: b.fgMuted,
    itemTextColorHoverInverted: b.fg,
    itemTextColorActiveInverted: b.fg,
    itemTextColorChildActiveInverted: b.fg,
    itemTextColorChildActiveHoverInverted: b.fg,
    itemIconColorInverted: b.fgMuted,
    itemIconColorHoverInverted: b.fg,
    itemIconColorActiveInverted: b.fg,
    itemIconColorChildActiveInverted: b.fg,
    arrowColorInverted: b.fgMuted,
    groupTextColorInverted: b.fgMuted,
    itemColorHoverInverted: b.bg,
    itemColorActiveInverted: b.bg,
    itemColorActiveHoverInverted: b.bg,
  },
  Layout: {
    color: c.bg,
    // 白色简约：侧栏与内容同底，靠 1px 描边分层
    siderColor: n.bg,
    siderBorderColor: n.border,
    // "inverted = 深色品牌面"
    colorInverted: b.bg,
    siderColorInverted: b.bg,
    siderBorderColorInverted: b.bg,
    siderToggleButtonColorInverted: b.bg,
    siderToggleBarColorInverted: b.fgMuted,
    siderToggleBarColorHoverInverted: b.fg,
  },
  Tag: {
    borderRadius: `${r.chip}px`,
    heightMedium: '28px',
    heightLarge: '32px',
  },
  Tabs: {
    tabTextColorActiveLine: c.primary,
    barColor: c.primary,
    tabTextColorHoverLine: c.primaryHover,
    tabFontWeightActive: '500',
  },
  Input: {
    color: c.surface,
    colorFocus: c.surface,
    border: `1px solid ${c.outline}`,
    borderHover: `1px solid ${c.primaryHover}`,
    borderFocus: `1px solid ${c.primary}`,
    boxShadowFocus: `0 0 0 2px ${c.primarySoft}`,
    borderRadius: `${r.control}px`,
    placeholderColor: c.onSurfaceMuted,
  },
  InternalSelection: {
    border: `1px solid ${c.outline}`,
    borderHover: `1px solid ${c.primaryHover}`,
    borderFocus: `1px solid ${c.primary}`,
    borderActive: `1px solid ${c.primary}`,
    boxShadowFocus: `0 0 0 2px ${c.primarySoft}`,
    boxShadowActive: `0 0 0 2px ${c.primarySoft}`,
    borderRadius: `${r.control}px`,
  },
  Dialog: {
    borderRadius: `${r.card}px`,
    color: c.surface,
    titleTextColor: c.onSurface,
    textColor: c.onSurfaceVariant,
  },
  Drawer: {
    color: c.surface,
    borderRadius: `${r.card}px`,
  },
  Form: {
    labelTextColor: c.onSurfaceVariant,
    labelFontWeight: '500',
    feedbackTextColor: s.dangerText,
    asteriskColor: s.dangerText,
  },
  Pagination: {
    itemColorActive: c.primary,
    itemColorActiveHover: c.primaryHover,
    itemTextColorActive: c.onPrimary,
    itemTextColorActiveHover: c.onPrimary,
    itemBorderRadius: `${r.control}px`,
  },
  Skeleton: {
    color: c.surfaceSunken,
    colorEnd: c.bg,
    borderRadius: `${r.control}px`,
  },
  Empty: {
    iconColor: c.onSurfaceMuted,
    textColor: c.onSurfaceMuted,
  },
  Timeline: {
    lineColor: c.outline,
    contentTextColor: c.onSurface,
    titleTextColor: c.onSurface,
  },
  Descriptions: {
    thColor: c.surfaceAlt,
    tdColor: c.surface,
    borderColor: c.outlineSubtle,
    borderRadius: `${r.card}px`,
  },
  Badge: {
    color: s.dangerText,
    fontSize: '11px',
  },
  Tooltip: {
    color: b.bg,
    textColor: b.fg,
    borderRadius: `${r.control}px`,
  },
  Popover: {
    color: c.surface,
    textColor: c.onSurface,
    borderRadius: `${r.card}px`,
    borderColor: c.outline,
  },
  Switch: { railColorActive: c.primary },
  Checkbox: { colorChecked: c.primary, borderChecked: `1px solid ${c.primary}` },
  Radio: { color: c.primary, buttonColorActive: c.primary },
  Divider: { color: c.outlineSubtle },
  Progress: { fillColor: c.primary },
  Alert: { borderRadius: `${r.card}px` },
};

const naiveTs = `/*
 * 由 tools/gen/gen-naive-theme.js 从 packages/tokens/src/theme.json 生成 —— 不要手改。
 * 运行：pnpm gen:naive
 *
 * 纪律：本文件里出现的每个颜色都来自 theme.json；禁止在这里手写 hex。
 * \`*Inverted\` 键是 Spike A 实测必需项（NLayoutSider / NMenu 的 inverted 变体会绕过普通键）。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

export const naiveThemeOverrides: GlobalThemeOverrides = ${JSON.stringify(overrides, null, 2)};
`;

// ---- 写出 / 校验 ----
mkdirSync(dirname(cssPath), { recursive: true });
mkdirSync(dirname(elPath), { recursive: true });

const outputs = [
  { path: cssPath, content: css, label: 'packages/tokens/src/generated/theme.v2.css' },
  { path: elPath, content: elCss, label: 'packages/tokens/src/generated/theme.el.css' },
];

if (check) {
  let drift = 0;
  for (const out of outputs) {
    const current = existsSync(out.path) ? readFileSync(out.path, 'utf8') : '';
    if (current !== out.content) {
      console.error(`生成物与 theme.json 不一致：${out.label}`);
      drift += 1;
    }
  }
  if (drift > 0) process.exit(1);
  console.log('check:tokens-v2 OK（2 份生成物与 theme.json 一致）');
} else {
  for (const out of outputs) {
    writeFileSync(out.path, out.content, 'utf8');
    console.log(`写出 ${out.label}`);
  }
}
