// AUTO-GENERATED FROM .archive/.../core/ui/theme/*.kt — DO NOT EDIT
// 生成器：WiseDepotClient/tools/gen/gen-tokens.js
//
// 颜色一律给出 CSS 变量引用（var(--w-…)）——亮/暗切换由 CSS 层负责，JS 不需要知道主题。
// 数值型令牌（间距/圆角/字号）同时给出 px 数字，供 canvas、打印、虚拟滚动计算使用。

export const TOKEN_SOURCE = 'WiseDepotApp/wise-depot-android-refactor/core/ui/src/main/java/com/huicang/wise/ui/theme';

/** 令牌对应的 CSS 变量名（需要动态拼变量时用）。 */
export const CSS_VAR = {
  color: {
    background: '--w-color-background',
    error: '--w-color-error',
    errorContainer: '--w-color-error-container',
    inverseOnSurface: '--w-color-inverse-on-surface',
    inversePrimary: '--w-color-inverse-primary',
    inverseSurface: '--w-color-inverse-surface',
    onBackground: '--w-color-on-background',
    onError: '--w-color-on-error',
    onErrorContainer: '--w-color-on-error-container',
    onPrimary: '--w-color-on-primary',
    onPrimaryContainer: '--w-color-on-primary-container',
    onSecondary: '--w-color-on-secondary',
    onSecondaryContainer: '--w-color-on-secondary-container',
    onSurface: '--w-color-on-surface',
    onSurfaceVariant: '--w-color-on-surface-variant',
    onTertiary: '--w-color-on-tertiary',
    onTertiaryContainer: '--w-color-on-tertiary-container',
    outline: '--w-color-outline',
    primary: '--w-color-primary',
    primaryContainer: '--w-color-primary-container',
    secondary: '--w-color-secondary',
    secondaryContainer: '--w-color-secondary-container',
    surface: '--w-color-surface',
    surfaceTint: '--w-color-surface-tint',
    surfaceVariant: '--w-color-surface-variant',
    tertiary: '--w-color-tertiary',
    tertiaryContainer: '--w-color-tertiary-container',
  },
  state: {
    groupedBackground: '--w-state-grouped-background',
    separatorSubtle: '--w-state-separator-subtle',
    separatorStrong: '--w-state-separator-strong',
    statusGreenText: '--w-state-status-green-text',
    statusOrangeText: '--w-state-status-orange-text',
    statusYellowText: '--w-state-status-yellow-text',
    statusBlueText: '--w-state-status-blue-text',
    statusRedText: '--w-state-status-red-text',
  },
  fill: {
    StatusGreen: '--w-fill-status-green',
    StatusRed: '--w-fill-status-red',
    StatusOrange: '--w-fill-status-orange',
    StatusAmber: '--w-fill-status-amber',
    StatusYellow: '--w-fill-status-yellow',
    StatusBlue: '--w-fill-status-blue',
    InfoContainerBlue: '--w-fill-info-container-blue',
    ErrorContainer: '--w-fill-error-container',
    NeutralGray: '--w-fill-neutral-gray',
  },
} as const;

/** 颜色令牌的 var() 引用。用法：`style={{ color: color.state.dangerText }}`。 */
export const color = {
  scheme: {
    background: 'var(--w-color-background)',
    error: 'var(--w-color-error)',
    errorContainer: 'var(--w-color-error-container)',
    inverseOnSurface: 'var(--w-color-inverse-on-surface)',
    inversePrimary: 'var(--w-color-inverse-primary)',
    inverseSurface: 'var(--w-color-inverse-surface)',
    onBackground: 'var(--w-color-on-background)',
    onError: 'var(--w-color-on-error)',
    onErrorContainer: 'var(--w-color-on-error-container)',
    onPrimary: 'var(--w-color-on-primary)',
    onPrimaryContainer: 'var(--w-color-on-primary-container)',
    onSecondary: 'var(--w-color-on-secondary)',
    onSecondaryContainer: 'var(--w-color-on-secondary-container)',
    onSurface: 'var(--w-color-on-surface)',
    onSurfaceVariant: 'var(--w-color-on-surface-variant)',
    onTertiary: 'var(--w-color-on-tertiary)',
    onTertiaryContainer: 'var(--w-color-on-tertiary-container)',
    outline: 'var(--w-color-outline)',
    primary: 'var(--w-color-primary)',
    primaryContainer: 'var(--w-color-primary-container)',
    secondary: 'var(--w-color-secondary)',
    secondaryContainer: 'var(--w-color-secondary-container)',
    surface: 'var(--w-color-surface)',
    surfaceTint: 'var(--w-color-surface-tint)',
    surfaceVariant: 'var(--w-color-surface-variant)',
    tertiary: 'var(--w-color-tertiary)',
    tertiaryContainer: 'var(--w-color-tertiary-container)',
  },
  state: {
    groupedBackground: 'var(--w-state-grouped-background)',
    separatorSubtle: 'var(--w-state-separator-subtle)',
    separatorStrong: 'var(--w-state-separator-strong)',
    statusGreenText: 'var(--w-state-status-green-text)',
    statusOrangeText: 'var(--w-state-status-orange-text)',
    statusYellowText: 'var(--w-state-status-yellow-text)',
    statusBlueText: 'var(--w-state-status-blue-text)',
    statusRedText: 'var(--w-state-status-red-text)',
  },
  fill: {
    StatusGreen: 'var(--w-fill-status-green)',
    StatusRed: 'var(--w-fill-status-red)',
    StatusOrange: 'var(--w-fill-status-orange)',
    StatusAmber: 'var(--w-fill-status-amber)',
    StatusYellow: 'var(--w-fill-status-yellow)',
    StatusBlue: 'var(--w-fill-status-blue)',
    InfoContainerBlue: 'var(--w-fill-info-container-blue)',
    ErrorContainer: 'var(--w-fill-error-container)',
    NeutralGray: 'var(--w-fill-neutral-gray)',
  },
  accent: {
    AccentCoral: 'var(--w-accent-accent-coral)',
    AccentTeal: 'var(--w-accent-accent-teal)',
  },
} as const;

export const space = {
  "ScreenHorizontal": 16,
  "ScreenVertical": 16,
  "SectionGap": 24,
  "GroupGap": 16,
  "RowGap": 12,
  "InlineGap": 8,
  "CardPadding": 16,
  "CardPaddingCompact": 12,
  "ListItemVertical": 12,
  "ActionBarHeight": 56,
  "TouchTargetMin": 48
} as const;

export const radius = {
  "extraSmall": 6,
  "small": 12,
  "medium": 16,
  "large": 20,
  "extraLarge": 28
} as const;

export const elevation = {
  "List": 0,
  "Card": 1,
  "Overlay": 6
} as const;

export const motion = {
  FAST: 150,
  NORMAL: 200,
} as const;

export const type = {
  displayLarge: { fontSize: 34, lineHeight: 41, letterSpacing: 0.37, fontWeight: 700 },
  displayMedium: { fontSize: 28, lineHeight: 34, letterSpacing: 0.36, fontWeight: 700 },
  displaySmall: { fontSize: 22, lineHeight: 28, letterSpacing: 0.35, fontWeight: 700 },
  headlineLarge: { fontSize: 20, lineHeight: 25, letterSpacing: 0.38, fontWeight: 600 },
  headlineMedium: { fontSize: 17, lineHeight: 22, letterSpacing: -0.41, fontWeight: 600 },
  headlineSmall: { fontSize: 15, lineHeight: 20, letterSpacing: -0.24, fontWeight: 600 },
  bodyLarge: { fontSize: 17, lineHeight: 22, letterSpacing: -0.41, fontWeight: 400 },
  bodyMedium: { fontSize: 15, lineHeight: 20, letterSpacing: -0.24, fontWeight: 400 },
  bodySmall: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08, fontWeight: 400 },
  labelLarge: { fontSize: 15, lineHeight: 20, letterSpacing: -0.24, fontWeight: 500 },
  labelMedium: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08, fontWeight: 500 },
  labelSmall: { fontSize: 11, lineHeight: 13, letterSpacing: 0.06, fontWeight: 500 },
} as const;

export const breakpoint = { compactMax: 599, mediumMax: 839, contentMaxWidth: 720, touchTargetMin: 48 } as const;

/** 亮色绝对值（canvas / 打印 / 单测用；常规组件请用 var() 引用）。 */
export const rawColor = {
  scheme: {
    background: '#F5F7FB',
    error: '#D92D20',
    errorContainer: '#FEE4E2',
    inverseOnSurface: '#F1F5F9',
    inversePrimary: '#B2C8FF',
    inverseSurface: '#1D2939',
    onBackground: '#101828',
    onError: '#FFFFFF',
    onErrorContainer: '#7A271A',
    onPrimary: '#FFFFFF',
    onPrimaryContainer: '#133A8F',
    onSecondary: '#FFFFFF',
    onSecondaryContainer: '#3B2E86',
    onSurface: '#101828',
    onSurfaceVariant: '#667085',
    onTertiary: '#FFFFFF',
    onTertiaryContainer: '#7A2E0E',
    outline: '#E4E7EC',
    primary: '#2F6BFF',
    primaryContainer: '#E4ECFF',
    secondary: '#7A5AF8',
    secondaryContainer: '#EDE9FE',
    surface: '#FFFFFF',
    surfaceTint: '#2F6BFF',
    surfaceVariant: '#EEF1F6',
    tertiary: '#F79009',
    tertiaryContainer: '#FEF0C7',
  },
  darkScheme: {
    background: '#000000',
    error: '#FF453A',
    errorContainer: '#93000A',
    inverseOnSurface: '#1A1C1E',
    inversePrimary: '#0061A4',
    inverseSurface: '#E2E2E6',
    onBackground: '#FFFFFF',
    onError: '#690005',
    onErrorContainer: '#FFDAD6',
    onPrimary: '#003258',
    onPrimaryContainer: '#D1E4FF',
    onSecondary: '#253140',
    onSecondaryContainer: '#D7E3F7',
    onSurface: '#FFFFFF',
    onSurfaceVariant: '#C3C7CF',
    onTertiary: '#3B2948',
    onTertiaryContainer: '#F2DAFF',
    outline: '#8E8E93',
    primary: '#0A84FF',
    primaryContainer: '#00497D',
    secondary: '#5E5CE6',
    secondaryContainer: '#3B4858',
    surface: '#1C1C1E',
    surfaceTint: '#0A84FF',
    surfaceVariant: '#2C2C2E',
    tertiary: '#FF9F0A',
    tertiaryContainer: '#523F5F',
  },
  stateText: {
    groupedBackground: '#F9F9F9',
    separatorSubtle: '#E5E5EA',
    separatorStrong: '#D1D1D6',
    statusGreenText: '#2E7D32',
    statusOrangeText: '#BF360C',
    statusYellowText: '#8D6E00',
    statusBlueText: '#1565C0',
    statusRedText: '#C62828',
  },
  darkStateText: {
    groupedBackground: '#000000',
    separatorSubtle: '#2C2C2E',
    separatorStrong: '#8E8E93',
    statusGreenText: '#4CAF50',
    statusOrangeText: '#FF9800',
    statusYellowText: '#FFC107',
    statusBlueText: '#2196F3',
    statusRedText: '#F44336',
  },
} as const;
