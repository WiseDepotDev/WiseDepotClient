# UI 布局与视觉规范 v1

> 规范来源：旧仓已拍板的视觉方向「**工业仓储控制台**」——高对比、大触控、低动效、机器数据等宽
> （`docs/standards/APP-UI优化计划.md` §二 目标 1）。
> 取值来源：全部取自 `packages/tokens`（由归档的 Compose 主题导出），**本规范不新造任何数值**。
> 落地实现：`apps/web` + `packages/ui`（Vue 3 版）；门禁：`pnpm check:css`（CSS 禁止 hex 与字面量尺寸）+ `pnpm check:ui-web`（.vue 文案禁止方法 id 与开发黑话）。

> **文档状态（2026-10-03 修订）**：本文档写于 React 时代，部分段落仍在引用已删除的路径
> （`packages/patterns`、`packages/shells`、`--w-dp-*`、`--w-content-max-width`）。
> **§1.2 与 §1.2.1 已按 Vue 版现状重写**，其余段落待逐段校准 —— 校准前请以代码与
> `docs/superpowers/plans/` 里的执行记录为准，不要照抄本文档的路径。

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

### 1.2 三档断点行为（2026-10-03 按 Vue 版现状重写）

断点与 `packages/tokens/src/theme.json` 同源：`useViewport()` 与 CSS 用的是同一份取值。

| 档位 | 宽度 | 手机/桌面壳 | 列表 |
| --- | --- | --- | --- |
| **Compact** | ≤599 | 顶栏 + 底栏（见下） | 单列卡片组，点行进详情（推入一层） |
| **Desktop** | ≥1024 | 左侧 Sidebar（品牌 + 域/叶子 + 账号） | 单列，内容居中限宽 `--w-space-content-max-width`(1120) |
| **Wide** | ≥1440 | 同 Desktop | **主从两栏**：左列表 + 右详情，点行**不换路由** |

**Compact 档的壳**（一行顶栏 + 一行底栏，中间全是内容）：

- **顶栏**（`.w-contextheader`）：左侧动作（详情屏=返回箭头、其它屏=回应用中心、首页=不显示）
  + **当前屏的名字** + 本域页面入口 + 刷新本页 + Bridge 延迟；动作全部是**图标按钮**并带 `aria-label`。
- **屏内页头**（`.w-page-header`）在窄档**只留业务动作、隐藏标题与说明** ——
  标题在顶栏那一行，屏内再写一遍就是同一句话占两行。
- **底栏**（`.w-tabbar`）：**图标 + 文字**，5 项 = 应用 + 四个域；「应用」在首页高亮、域一个都不亮。
- **域内分段**（`.w-segment`）：胶囊轨道 + 白色滑块，只在叶子屏出现（详情屏与首页都没有：
  前者算不出"当前项"、后者没有"当前域"）。
- **主操作固定在底部**（`.w-actiondock`，手机档 `position: fixed`，贴在底栏之上）：
  页头那个「新建 XX」在窄档会独占一行，而它是主操作，应该在拇指够得到的地方。
  底部留白由 `.w-page:has(.w-actiondock)` 提供。

**Wide 档的主从视图**：`packages/ui/src/business/MasterDetail.vue`。
判据用 `isWide`（≥1440）而不是 `isDesktop`（≥1024）—— 1024 的窗口在侧栏展开后内容区只剩约 780px，
两栏各 390px，而列表的固定列宽加起来能到 750px，塞进去只会被 `.w-content` 的
`overflow-x: hidden` 裁掉（不是出滚动条）。所以主从屏在宽档还要换一套**精简列**。

### 1.2.1 两级导航（2026-10-03 按 Vue 版现状重写）

导航分两层，**这是结构性约定，不是实现细节**：

| 层 | 是什么 | 在哪定义 | 用户怎么到 |
| --- | --- | --- | --- |
| **导航叶子** | 一级目的地：列表、表单、看板 | `packages/layouts/src/navigation.ts` 的 `DOMAINS` | 底栏 / 侧栏 / 应用中心 |
| **推入的屏** | 详情类目的地：依赖"看哪一个"才有意义 | 同文件的 `DESTINATIONS` | 只能被别的屏推进去（列表点一行、扫到一个码） |

规则：

1. **详情类屏不占导航项**。曾经把"标签详情""单据详情"都塞进导航叶子，
   结果库存域长出 8 个导航项、手机上要横滚才看全 —— 它们在信息架构里本来就该在下一层。
2. **路由表由信息架构生成**（`apps/web/src/router/routes.ts`），不手写：
   "导航里有的目的地，路由里一定有"因此是结构性成立的。屏组件在
   `apps/web/src/views/registry.ts` 里按**桥方法 id** 注册。
3. 屏内导航一律 `router.push({ name: <桥方法 id> })`；方法 id 必须是叶子或 `DESTINATIONS` 之一
   （拼错不会编译失败、只会"点了没反应"，所以由 `pnpm check:navigation` 静态拦下）。
4. **应用中心（`/`）是所有功能的唯一入口**，它不属于任何域：手机顶栏与底栏各有一个回它的入口，
   桌面是左上角品牌区。
5. **详情屏的"看哪一条"必须能从 prop 传入**（不是只读 `route.params`）——
   否则宽档主从的右栏换项时拿不到新 id（这就是面板化的原因，见 `InventoryDetailPanel` 等）。


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
| `MasterDetail` | 左栏 `minmax(200, 34%)`，右栏自适应；中缝 1px `outline`。**当前无屏使用**（见 §1.2 的说明）：壳没有 master 内容，摆假数据比空着更糟 |
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
