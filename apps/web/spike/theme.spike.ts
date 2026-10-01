/**
 * Spike 专用 themeOverrides（**临时件**）。
 *
 * 真实生成物是 V2 的 `packages/tokens/src/generated/naiveTheme.ts`（由 theme.json 生成）。
 * 这里手写两份是为了量化 R1："覆盖不全时，Naive 的默认色会漏进产出多少处"。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

/** 取色来自设计稿 §6.1（对参考图逐像素统计）。 */
export const PALETTE = {
  primary: '#087C75',
  primaryHover: '#0A6E68',
  navBg: '#102E3E',
  navSurface: '#1F3E50',
  navActive: '#1E4956',
  navFg: '#FFFFFF',
  navFgMuted: '#B9CDD5',
  bg: '#F7F9F9',
  surface: '#FFFFFF',
  surfaceAlt: '#FAFBFB',
  outline: '#DBE3E6',
  onSurface: '#173344',
  onSurfaceVariant: '#84949C',
  successFill: '#DFF3EF',
  successText: '#126961',
  warningFill: '#FFF0D8',
  warningText: '#B8690B',
  dangerFill: '#FBE7E8',
  dangerText: '#B23A42',
  infoFill: '#FFF7E9',
  infoText: '#845817',
} as const;

/** 只覆盖 primary —— 用来暴露默认色泄漏（Spike A 第一趟）。 */
export const partialOverrides: GlobalThemeOverrides = {
  common: { primaryColor: PALETTE.primary },
};

/** 覆盖设计稿 §6.3 表格列出的组件键（Spike A 第二趟）。 */
export const fullOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: PALETTE.primary,
    primaryColorHover: PALETTE.primaryHover,
    primaryColorPressed: PALETTE.primaryHover,
    primaryColorSuppl: PALETTE.primaryHover,
    infoColor: PALETTE.successText,
    successColor: PALETTE.successText,
    warningColor: PALETTE.warningText,
    errorColor: PALETTE.dangerText,
    textColorBase: PALETTE.onSurface,
    textColor1: PALETTE.onSurface,
    textColor2: PALETTE.onSurface,
    textColor3: PALETTE.onSurfaceVariant,
    borderColor: PALETTE.outline,
    dividerColor: PALETTE.outline,
    bodyColor: PALETTE.bg,
    cardColor: PALETTE.surface,
    modalColor: PALETTE.surface,
    popoverColor: PALETTE.surface,
    tableColor: PALETTE.surface,
    tableHeaderColor: PALETTE.surfaceAlt,
    hoverColor: PALETTE.surfaceAlt,
    borderRadius: '8px',
    borderRadiusSmall: '8px',
    heightLarge: '48px',
    heightMedium: '40px',
    heightSmall: '32px',
    fontFamily:
      '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,-apple-system,sans-serif',
  },
  Button: { textColorPrimary: PALETTE.surface, borderRadiusLarge: '8px' },
  Card: { borderRadius: '12px', color: PALETTE.surface, borderColor: PALETTE.outline },
  DataTable: {
    thColor: PALETTE.surfaceAlt,
    tdColor: PALETTE.surface,
    tdColorHover: PALETTE.surfaceAlt,
    borderColor: PALETTE.outline,
    thTextColor: PALETTE.onSurfaceVariant,
    tdTextColor: PALETTE.onSurface,
    borderRadius: '12px',
  },
  Menu: {
    color: PALETTE.navBg,
    itemColorActive: PALETTE.navActive,
    itemColorActiveHover: PALETTE.navActive,
    itemColorHover: PALETTE.navSurface,
    itemTextColor: PALETTE.navFgMuted,
    itemTextColorActive: PALETTE.navFg,
    itemTextColorHover: PALETTE.navFg,
    itemIconColor: PALETTE.navFgMuted,
    itemIconColorActive: PALETTE.navFg,
    arrowColor: PALETTE.navFgMuted,
    groupTextColor: PALETTE.navFgMuted,
    borderRadius: '8px',
  },
  Layout: { color: PALETTE.bg, siderColor: PALETTE.navBg },
  Tag: { borderRadius: '6px', heightMedium: '28px', heightLarge: '32px' },
  Tabs: { tabTextColorActiveLine: PALETTE.primary, barColor: PALETTE.primary, tabColorSegment: PALETTE.surface },
  Input: { color: PALETTE.surface, border: `1px solid ${PALETTE.outline}`, borderHover: `1px solid ${PALETTE.primary}`, borderFocus: `1px solid ${PALETTE.primary}`, borderRadius: '8px' },
  Dialog: { borderRadius: '12px', color: PALETTE.surface, titleTextColor: PALETTE.onSurface },
  Drawer: { color: PALETTE.surface, borderRadius: '12px' },
  Form: { labelTextColor: PALETTE.onSurfaceVariant, feedbackTextColor: PALETTE.dangerText },
  Pagination: { itemColorActive: PALETTE.primary, itemTextColorActive: PALETTE.surface },
  Skeleton: { color: PALETTE.surfaceAlt, colorEnd: PALETTE.bg },
  Timeline: { lineColor: PALETTE.outline, contentTextColor: PALETTE.onSurface },
  Tooltip: { color: PALETTE.navBg, textColor: PALETTE.navFg, borderRadius: '8px' },
  Popover: { color: PALETTE.surface, textColor: PALETTE.onSurface, borderRadius: '12px' },
};

/** Naive UI 的默认色，用来数"漏出来多少处"。 */
export const NAIVE_DEFAULT_HEXES = [
  '#18a058', // primaryColor / successColor 默认
  '#36ad6a', // primaryColorHover 默认
  '#0c7a43', // primaryColorPressed 默认
  '#2080f0', // infoColor 默认
  '#f0a020', // warningColor 默认
  '#d03050', // errorColor 默认
] as const;

/**
 * 第三趟：补上 **`*Inverted` 键**。
 *
 * Spike A 实测发现：`NLayoutSider inverted` / `NMenu inverted` 会**绕过**普通主题键，
 * 改用一组独立的 inverted 默认值（sider 底 = `rgb(0, 20, 40)`、菜单项字 = `#BBB`、
 * 分组标签 = `#AAA`）。只覆盖 `Menu.itemTextColor` / `Layout.siderColor` 是不生效的。
 * 这就是"深青侧栏"能不能做成的关键，也是 `check:naive` 白名单必须点名的一批键。
 */
export const fullOverridesWithInverted: GlobalThemeOverrides = {
  ...fullOverrides,
  Layout: {
    ...fullOverrides.Layout,
    color: PALETTE.bg,
    siderColor: PALETTE.navBg,
    colorInverted: PALETTE.navBg,
    siderColorInverted: PALETTE.navBg,
    siderBorderColorInverted: PALETTE.navBg,
    siderToggleButtonColorInverted: PALETTE.navSurface,
  },
  Menu: {
    ...fullOverrides.Menu,
    color: 'transparent',
    itemTextColorInverted: PALETTE.navFgMuted,
    itemTextColorHoverInverted: PALETTE.navFg,
    itemTextColorActiveInverted: PALETTE.navFg,
    itemTextColorChildActiveInverted: PALETTE.navFg,
    itemTextColorChildActiveHoverInverted: PALETTE.navFg,
    itemIconColorInverted: PALETTE.navFgMuted,
    itemIconColorHoverInverted: PALETTE.navFg,
    itemIconColorActiveInverted: PALETTE.navFg,
    itemIconColorChildActiveInverted: PALETTE.navFg,
    arrowColorInverted: PALETTE.navFgMuted,
    groupTextColorInverted: PALETTE.navFgMuted,
    itemColorActiveInverted: PALETTE.navActive,
    itemColorActiveHoverInverted: PALETTE.navActive,
    itemColorHoverInverted: PALETTE.navSurface,
  },
};
