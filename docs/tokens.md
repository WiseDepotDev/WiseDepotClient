# 设计令牌（Design Tokens）

> 生成器：`tools/gen/gen-tokens.js`；门禁：`pnpm check:tokens` + `pnpm check:css`。
> 生成物：`packages/tokens/src/generated/{tokens.json,tokens.css,tokens.ts}`（**禁止手改**）。

## 1. 为什么是"导出"而不是"重写"

旧仓 `core/ui/theme/*` 已经过一次完整治理（P3-22/B1 建令牌层、P3-12 收口硬编码色），
取值本身是有依据的——状态色文字变体的 WCAG 对比度读数就写在注释里
（`StatusGreenText` 浅色 5.13、`StatusYellowText` 4.81 ……）。
Web 侧如果手抄一份，第一周就会漂移。所以这里是**一次性导出 + 此后以 tokens.json 为准**。

## 2. 导出范围

| 来源（归档区 `.archive/.../core/ui/theme/`） | 导出为 | 数量 |
| --- | --- | --- |
| `Color.kt`（`md_theme_light_*` / `md_theme_dark_*`） | `--w-color-*`（亮/暗各一套） | 27 槽位 |
| `Color.kt` + `WiseDColors.kt`（状态语义色） | `--w-state-*`（随主题） | 8 |
| `Color.kt`（`Status*` 实体色 / 容器色） | `--w-fill-*`（只作底，不当文字色） | 13 |
| `Color.kt`（`AccentCoral` / `AccentTeal`） | `--w-accent-*` | 2 |
| `Dimens.kt` | `--w-dp-N` | 30 |
| `Spacing.kt` | `--w-space-*` | 11 |
| `Shape.kt` | `--w-radius-*` | 5 |
| `Elevations.kt` | `--w-elevation-*` | 3 |
| `Motion.kt` | `--w-motion-*` | 2 |
| `Type.kt` | `--w-type-*-size/line/tracking/weight` | 12 档 |
| `Color.kt`（`IOSSystem*` 等旧 iOS 命名色） | **只写进 tokens.json 的 `legacy` 字段** | 19 |

`legacy` 那 19 个**不生成 CSS 变量**：旧仓的纪律是"业务层禁止直接引用 `IOSSystem*`"，
Web 侧没有理由把它们重新变成可用 API；留档只是为了让色值来源可追溯。

## 3. 单位换算

Compose 的 `dp` 是密度无关像素，Web 里等价物就是 px 的默认缩放，因此 **`1dp` → `1px`**，
生成时不做任何倍率换算。字号同理（`sp` → `px`），字重用 `FontWeight.X` → 数字（SemiBold → 600）。

## 4. 主题切换

```css
:root { --w-color-primary: #2F6BFF; /* 亮色 */ }
[data-theme='dark'] { --w-color-primary: #0A84FF; }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { /* … */ } }
```

优先级：**显式 `data-theme` > 系统偏好**。JS 侧因此不需要知道当前主题——
颜色一律给 `var(--w-…)` 引用（`packages/tokens/src/index.ts` 的 `color` 对象就是这个用法）。

需要**绝对值**的场合（canvas 绘图、打印、单测断言）用 `rawColor`，它同时给出亮/暗两组。

## 5. 纪律（可被机器检查）

1. 业务 CSS **不得出现 hex 或字面量尺寸**，只允许 `0` / `1px` / `2px` 三档边框微调；
2. 不得引用未定义的令牌名（拼错一个字母，页面只会"悄悄变难看"）；
3. 业务 TS/TSX 不得重新定义颜色常量。

前两条由 `tools/check/check-css-vars.js` 强制（`pnpm check:css`），第三条在评审里看。
这条思路直接沿用旧仓的令牌棘轮：**把"审美问题"变成"门禁问题"**，才不会随人而变。

## 6. 什么时候需要改生成器

- 新增令牌来源：改 `tools/gen/gen-tokens.js` 的解析段；
- 旧仓主题改了取值：**不要**直接改生成物，改归档区的 `.kt` 再重跑（保持"唯一来源"成立）；
- 需要新语义名（如 `--w-space-action-bar-height` 之外的布局常量）：先加进旧仓的 `Dimens`/`Spacing` 语义，
  再重跑生成器 —— 不要在 Web 侧新造数值，那会让两端的视觉开始分叉。
