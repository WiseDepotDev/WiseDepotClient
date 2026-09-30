# UI 布局与视觉规范 v1

> 规范来源：旧仓已拍板的视觉方向「**工业仓储控制台**」——高对比、大触控、低动效、机器数据等宽
> （`docs/standards/APP-UI优化计划.md` §二 目标 1）。
> 取值来源：全部取自 `packages/tokens`（由归档的 Compose 主题导出），**本规范不新造任何数值**。
> 落地实现：`packages/patterns`；门禁：`pnpm check:css`（CSS 禁止 hex 与字面量尺寸）+ `pnpm check:ui`（TSX 禁止内联取值与开发黑话文案）。

---

## 0. 三条原则（所有具体规则都从这里推出来）

1. **操作员在货架间单手戴手套操作** → 触控目标 ≥48px、主操作 56px、不依赖悬停才能发现的功能。
2. **现场光线下看屏幕** → 高对比、少装饰、不用阴影表达层级（用 1px 描边 + 底色差）。
3. **数据是主角** → 排版层级服务于"快速找到那个数字/单号"，字号不追求大，追求**层级清楚**。

由这三条推出的一条硬规则：**同一个视觉意图只允许一种表达**。
"卡片"只有一种圆角与内边距，"列表行"只有一种高度与分隔线，"页面标题"只有一档字号。
需要例外的场合，先改这份规范，再改实现。

---

## 1. 栅格与间距

### 1.1 间距刻度（4 的倍数，取自 `--w-dp-*`）

| 用途 | 令牌 | 值 |
| --- | --- | --- |
| 页面左右内边距 | `--w-space-screen-horizontal` | 16px |
| 页面上下内边距 | `--w-space-screen-vertical` | 16px |
| 区块之间（表单区 ↔ 明细区） | `--w-space-section-gap` | 24px |
| 分组之间（同区块内的卡片/小节） | `--w-space-group-gap` | 16px |
| 行内元素之间（图标 ↔ 文字） | `--w-space-row-gap` | 12px |
| 紧密行内（标签 ↔ 徽标） | `--w-space-inline-gap` | 8px |
| 卡片内边距 | `--w-space-card-padding` | 16px |
| 卡片内边距（紧凑，两行列表项） | `--w-space-card-padding-compact` | 12px |
| 列表项上下内边距 | `--w-space-list-item-vertical` | 12px |
| 底部动作条 / 主按钮高度 | `--w-space-action-bar-height` | 56px |
| 最小触控目标 | `--w-space-touch-target-min` | 48px |

**禁止**：在组件里直接写 `12px`。要么用上表，要么用 `--w-dp-*` 并说明为什么它是一个"尺寸"而不是"间距"。

### 1.2 三档断点行为

断点值与旧仓 `WindowSize.kt` 同源：`--w-breakpoint-compact-max`(600) / `--w-breakpoint-medium-max`(840)。

| 档位 | 宽度 | 内容宽度 | 导航 | 列表 |
| --- | --- | --- | --- | --- |
| **Compact** | ≤599 | 100% − 32px | 底部 4 项 TabBar | 单列，全屏进详情 |
| **Medium** | 600–839 | 最大 `--w-content-max-width`(720) 居中 | 左侧 Sidebar(200) | 单列，保留返回 |
| **Expanded** | ≥840 | 最大 `calc(840 + 200)` = 1040 居中 | 左侧 Sidebar(200) | **主从双栏** |

> `1040` 不是新造的数值：它是"扩展档起点 840 + 侧栏 200"的组合，用 `calc()` 表达，
> 这样改侧栏宽度时内容宽度自动跟随。

### 1.3 纵向节奏

- 页面内所有直接子块之间的间距一律 `--w-space-group-gap`(16)，**不允许**用 margin 手写节奏；
- 区块之间用 `--w-space-section-gap`(24)；
- 页面第一个块与 header 之间用 `--w-space-screen-vertical`(16)。

---

## 2. 布局骨架

```
┌──────────────────────────────────────────────┐
│ AppBar（高 56）：标题 / 状态 / 主操作            │
├──────────┬───────────────────────────────────┤
│ Sidebar  │ Content（居中，最大宽见 1.2）        │
│ 200px    │  ┌─────────────────────────────┐  │
│ 仅 ≥600  │  │ PageHeader（可选）           │  │
│          │  ├─────────────────────────────┤  │
│          │  │ Section / MasterDetail       │  │
│          │  └─────────────────────────────┘  │
├──────────┴───────────────────────────────────┤
│ ActionBar（高 56，可选）或 TabBar（仅 Compact） │
└──────────────────────────────────────────────┘
```

| 骨架件 | 规则 |
| --- | --- |
| `AppBar` | 高 56；左侧标题用 `headlineSmall`；右侧动作按重要性从右往左排；状态芯片固定在最右 |
| `Sidebar` | 仅 ≥600 出现；宽 200；一级项高 40、二级项高 36；选中态用 `primary-container` + 左侧 2px 强调条 |
| `Content` | 左右 `screen-horizontal`；上下 `screen-vertical`；超宽居中（1.2 表） |
| `PageHeader` | 页面标题 `headlineSmall` + 副标题 `bodySmall`（`on-surface-variant`）+ 右侧操作；**与 AppBar 同时存在时 AppBar 只放全局动作**，避免两处都放标题 |
| `Section` | 标题 `labelMedium`（`on-surface-variant`）+ 内容；标题与内容间距 `inline-gap` |
| `MasterDetail` | 仅 Expanded；左栏 `minmax(200, 34%)`，右栏自适应；中缝 1px `outline` |
| `ActionBar` | 高 56，固定在内容底部（不随滚动）；主按钮占满宽或固定 200；**表单屏必须用它**，不允许"滚到底找按钮" |
| `TabBar` | 仅 Compact；高 56；4 项；选中用 `primary` 文字色，不加胶囊指示器 |

---

## 3. 组件规范

### 3.1 按钮

| 类型 | 高度 | 圆角 | 底色 | 文字 |
| --- | --- | --- | --- | --- |
| 主操作 | 56 (`action-bar-height`) | `radius-small`(12) | `color-primary` | `on-primary`，`labelLarge` |
| 次操作 | 48 (`touch-target-min`) | `radius-small` | `color-surface` | `on-surface`，`labelLarge` |
| 危险操作 | 48 | `radius-small` | `color-error` | `on-error` |
| 幽灵/图标 | 48×48 | `radius-small` | 透明 | `on-surface-variant` |

- 水平内边距 `card-padding-compact`(12)；同一行的按钮间距 `inline-gap`(8)；
- 禁用：`opacity .38`，不做额外的灰色令牌（少一个令牌就少一处不一致）；
- **危险操作必须二次确认**（`ConfirmDialog`），不允许"点一下就删"。

### 3.2 表单

- 输入框高 48；圆角 `radius-small`；边框 1px `outline`；聚焦时边框改 `primary`（不加阴影）；
- 字段上下间距 `group-gap`(16)；标签在上、`labelMedium`，错误行在输入框下方、`bodySmall` + `state-status-red-text`；
- 必填星号用 `state-status-red-text`，不用图形。

### 3.3 列表

- 行高 ≥48；上下 `list-item-vertical`(12)；分隔线 1px `state-separator-subtle`；**最后一行不画线**；
- 行内结构固定为：`主标识（等宽）` → `主文案` → `次要信息` → `状态芯片/操作`，主文案可截断，主标识不截断；
- 单号 / 条码 / RFID 一律 `w-mono`（等宽 + 表格数字），保证纵向对齐；
- 长列表必须虚拟滚动；`LazyColumn` 时代的"补 key"在这里等价于"渲染必须有稳定 key"。

### 3.4 卡片

- 圆角 `radius-medium`(16)；内边距 `card-padding`(16)；1px `outline` 描边 + `elevation-card`(1)；
- **不嵌套卡片**。需要分组就在卡片内用 `Section` + 分隔线；
- KPI 卡：数值 `displaySmall`(22) + 标签 `labelMedium`；数值用等宽数字防抖动。

### 3.5 四态（加载 / 空 / 错 / 内容）

同一个容器表达，不允许各屏自己写：

| 态 | 表达 |
| --- | --- |
| 加载 | 骨架屏（列表 → 行骨架 ×3；卡片 → 卡骨架 ×4），**不用转圈**（转圈无法传达"将出现什么"） |
| 空 | 一行说明文字（`on-surface-variant`）+ 可选主操作按钮 |
| 错 | 左侧 2px `state-status-red-text` 竖条 + 错误码（等宽）+ 人话说明 + 「重试」按钮 |
| 内容 | 正常渲染 |

四态必须**互斥且穷尽**：任何一个取数容器都要能画出这四种状态，缺一种就不算完成。

### 3.6 芯片 / 状态标记

- 高 28；圆角 `radius-small`；内边距 `inline-gap`(8)；
- 文字用 `--w-state-*`（对比度安全），**底色用 `--w-fill-*` 或容器色**——
  反过来用（拿 `fill` 当文字色）在浅色下会掉到 WCAG AA 以下，这正是旧仓 40/41 批修过 24 处的问题；
- 中性芯片：底 `surface-variant`，字 `on-surface-variant`。

---

## 4. 排版层级（12 档只用 7 档）

| 场景 | 令牌档 | 字号/行高 |
| --- | --- | --- |
| KPI 数值 | `displaySmall` | 22 / 28 |
| 页面标题 | `headlineSmall` | 15 / 20 |
| 卡片标题 | `labelLarge` | 15 / 20 |
| 正文 | `bodyMedium` | 15 / 20 |
| 次要说明 | `bodySmall` | 13 / 18 |
| 字段名 / 芯片 | `labelMedium` | 13 / 18 |
| 辅助标签 | `labelSmall` | 11 / 13 |

`displayLarge/Medium`、`headlineLarge/Medium`、`bodyLarge` 在这套界面里**不使用**——
留白给了"层级更清楚"，而不是"字更大"。需要强调时用**字重 + 颜色**，不跳档。

---

## 5. 色彩使用规则

| 想表达 | 用什么 | 禁止 |
| --- | --- | --- |
| 界面主色、底色、描边、文字 | `--w-color-*` | — |
| 文字/图标的状态语义（成功/警告/提醒/危险/信息） | `--w-state-*` | 用 `--w-fill-*` 当文字色 |
| 状态底色、徽章底、按钮填充 | `--w-fill-*` | 拿 `--w-fill-*` 当正文色 |
| 身份/装饰（角色徽章） | `--w-accent-*` | 混进状态色 |
| 旧 iOS 命名色 | 不存在于 CSS（只在 `tokens.json` 留档） | 引用 `IOSSystem*` |

---

## 6. 无障碍与可用性

- 触控目标 ≥48×48；相邻可点元素之间 ≥8px；
- 所有图标按钮必须有 `aria-label`；列表行合并语义（避免读屏逐个念单元格）；
- 对比度：正文 ≥4.5:1（`--w-state-*` 已经在旧仓按这个标准选过值，亮暗两侧都达标）；
- 键盘：桌面端 Tab 可达全部操作，回车触发、Esc 关闭弹层；列表支持 ↑↓ 移动选中；
- **不用悬停才能发现的功能**（现场是触摸屏为主）；悬停只做"轻微加深底色"这一种反馈。

---

## 7. 动效

- 只允许两个时长：`--w-motion-fast`(150ms) 用于状态切换（选中、展开），`--w-motion-normal`(200ms) 用于内容出现（骨架 → 内容）；
- 只允许 `opacity` 与 `background-color` 过渡；**不做位移/缩放/装饰动画**；
- 必须尊重 `prefers-reduced-motion: reduce`（关掉骨架动画与过渡）。

---

## 8. 反例清单（评审时逐条对照）

1. 组件里写 `#2F6BFF` 或 `12px` → 门禁直接拦（CSS 走 `pnpm check:css`，TSX 内联走 `pnpm check:ui`）；
2. 一屏里出现两种卡片圆角、两种列表行高；
3. 用阴影表达层级（列表项加 `box-shadow`）；
4. 卡片套卡片；
5. 表单屏把提交按钮放在滚动内容末尾；
6. 加载态用转圈而不是骨架；
7. 用 `--w-fill-*` 当文字色；
8. 新造一个不在 `tokens.json` 里的数值（要新数值 → 先改归档主题 → 重跑 `pnpm gen:tokens`）。

---

## 9. 规范 → 实现 映射

| 规范条目 | 实现 | 门禁 |
| --- | --- | --- |
| 1.1 / 1.3 间距 | `packages/patterns` 的 `Page`/`Section`/`Stack` | `check-css-vars` |
| 1.2 断点 | `packages/tokens` 的 `windowSizeOf` + `AppFrame` | 外壳渲染用例 |
| 2 骨架 | `packages/patterns` 的 `AppBar`/`Sidebar`/`Page`/`MasterDetail`/`ActionBar` | 外壳渲染用例 |
| 3.5 四态 | `packages/patterns` 的 `LoadingState`/`EmptyState`/`ErrorState`/`ListStateHost` | 渲染用例 |
| 4 排版 | `--w-type-*` | `check-css-vars` |
| 5 色彩 | `--w-color-*` / `--w-state-*` / `--w-fill-*` | `check-css-vars` + `check-ui-language`（TSX 内联） |
| 6 文案 | 业务语言、不出现方法 id / 里程碑编号 / 协议名 | `check-ui-language`（比对 167 个桥方法 id + 8 条黑话规则） |
| 7 动效 | `--w-motion-*` | 代码评审 |
