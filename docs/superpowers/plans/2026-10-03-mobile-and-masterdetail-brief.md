# 简报：手机端第二遍整理 + 桌面主从视图（现状盘点）

> 只读调研，未改动任何生产代码。本文所有结论都带 `文件:行号`；截图取自
> `apps/web/.tmp-shots/*.png`（手机档 390×844@2x、桌面档 1440×900），文中标「实测」的
> 排布是直接看这些图得到的，标「推算」的是按 CSS 规则 + 控件数目推出来的。
>
> 调研范围：`apps/web/src/views/**`（30 个 `.vue`）、`packages/ui/src/**`、`packages/layouts/src/**`、
> `packages/tokens/src/generated/**`、`docs/ui-spec.md`、`apps/web/smoke/check-web-smoke.mjs`、`tools/check/*`。

## 0. 一页结论

**手机端第二遍，最该动的是三件事**（详见 §A 与 §4）：

1. **`ActionDock` 的 sticky 在内容高于视口时会盖住正文**，而且它和 `PageHeader` 里的「刷新」是同一个动作的两处入口
   —— 5 屏有重复按钮、3 屏有实测遮挡（`07-order-detail`、`09-inspection-detail`、`11-messages`）。
2. **工具区还没收干净**：`DeviceListView` / `InspectionTaskListView` / `InspectionResultListView` /
   `MessageListView` / `UserListView` 的 `.w-toolbar` 有 5–7 个控件，手机上是 2–3 行；`FilterBar` 的
   每个 `ElSelect` 在手机上独占整行（`06-stock-orders` 实测），所以「筛选」越多行越多。
3. **手机壳有两个恒真的条件**：`返回` 按钮的 `v-if` 永远成立、详情屏在 ≤4 项域里照样画分段控件
   —— 这两条同时违反 `docs/ui-spec.md` §1.2.1 第 3 条。

**主从视图最大的两个风险**（详见 §B5）：

1. **`<RouterView :key="route.fullPath">` 会强制整树重挂**（`AppFrame.vue:262`）：只要主从视图靠
   「换路由」实现右栏，左栏就会跟着重建，「点行不跳页」变成「点行整屏闪一下 + 页码/滚动全丢」。
2. **详情屏把「看哪一条」写成 setup 期的常量**（`route.params` → 局部 `ref`，8 个屏如此）。
   路由不动、只换右栏时，它们全部落进 `!hasTarget` 空态（"没有指定要查看的…请从列表点开"），
   所以右栏要么复用「已经是独立屏」的组件并额外接一个 prop，要么就是新写一套详情。

---

## A 手机端现状

### A1 筛选 / 工具区盘点

先说**机制**，因为"手机上排成几行"完全由这三条规则决定，屏本身没有任何响应式逻辑：

| 机制 | 位置 | 后果 |
| --- | --- | --- |
| `.w-toolbar` 是 `flex-wrap` 行 | `packages/ui/src/styles/ui.css:72-77` | 放不下就换行，不报错、不折叠 |
| 工具条里的输入/下拉/日期**基准宽 45% 并允许长** | `packages/ui/src/styles/ui.css:89-94` | 输入框与按钮能落在同一行；但**单独一行时会吃满整行** |
| `FilterBar` 的 select `min-width:140px`、搜索块 `min-width:260px` | `packages/ui/src/business/FilterBar.vue:97-114`（scoped，**无断点**） | 390px 宽下一个 select 独占一行（实测 `06-stock-orders`）；260px 的搜索块 + 作用域标注必然换行 |
| `.w-toolbar` 的父级 `.w-page` 有 16px 内边距 | `packages/ui/src/styles/ui.css:15-23` | 390px 屏可用宽度 ≈ 358px |

**没有一个屏 import `useViewport`**（`grep -r useViewport apps/web/src` 为空）—— 也就是说
「手机档」这件事在业务屏里完全不存在，工具区只有 CSS 一条兜底规则。

下表把 25 个注册表屏 + `HomeView` 逐个过一遍（「工具区」= 筛选/查找/翻页这类控件行，
**不含** `PageHeader` 的 `#actions`）：

| # | 屏（文件） | 工具区实现 | 控件清单（个数） | 手机排布 | ≥3 行候选 |
| --- | --- | --- | --- | --- | --- |
| 1 | `views/HomeView.vue` | 无 | 无（只有 PageHeader 状态芯片） | — | |
| 2 | `views/overview/DashboardView.vue` | 无 | 无 | — | |
| 3 | `views/overview/AlertListView.vue` | **`FilterBar`**（`:96`） | 状态 select；dirty 时 +清空筛选（1–2） | 1 行（实测 `03-alerts`） | |
| 4 | `views/overview/AlertDetailView.vue` | 无 | 无 | — | |
| 5 | `views/inventory/InventoryListView.vue` | **自写 `.w-toolbar`**（`:211`）+ **`FilterBar`**（`:225`） | 搜索输入 + 查找 + 作用域文本；库存状态 select；dirty 时 +清空筛选（5–6） | 2 行（实测 `04-inventory`） | △ |
| 6 | `views/inventory/InventoryDetailView.vue` | 无 | 无 | — | |
| 7 | `views/inventory/ProductListView.vue` | 无（动作在 PageHeader + 行内） | 无 | — | |
| 8 | `views/inventory/WarehouseListView.vue` | 无 | 无 | — | |
| 9 | `views/inventory/TagListView.vue` | 无（3 个动作全在 PageHeader `:171-179`） | 无 | — | |
| 10 | `views/inventory/TagDetailView.vue` | 无 | 无 | — | |
| 11 | `views/inventory/StockOrderListView.vue` | **`FilterBar`**（`:146`） | 单据状态 select（4 选项）；dirty 时 +清空筛选（1–2） | 1 行（实测 `06-stock-orders`） | |
| 12 | `views/inventory/StockOrderCreateView.vue` | 无（表单 + ActionDock） | 无 | — | |
| 13 | `views/inventory/StockOrderDetailView.vue` | **自写 `.w-toolbar`**（`:356`，明细维护） | 标签 ID 输入 + 添加明细 + 提示文本（3） | 2 行（实测 `07-order-detail`） | |
| 14 | `views/field/DeviceListView.vue` | **自写 `.w-toolbar`**（`:172`） | 搜索输入 + 查找 + 全部 + 在线 + 离线 +（dirty）清空筛选 + 作用域文本（6–7） | **2 行**（实测 `10-devices`）；筛选中变 3 行 | ✅ |
| 15 | `views/field/DeviceDetailView.vue` | 无 | 无 | — | |
| 16 | `views/field/InspectionPlanListView.vue` | 无 | 无 | — | |
| 17 | `views/field/InspectionTaskListView.vue` | **自写 `.w-toolbar`**（`:220`） | 搜索输入 + 查找 + 全部 + 进行中 + 已完成 +（dirty）清空筛选 + 作用域文本（6–7） | **2 行**（实测 `08-inspections`）；筛选中变 3 行 | ✅ |
| 18 | `views/field/InspectionTaskDetailView.vue` | 2 个自写 `.w-toolbar`（`:433` 查询、`:486` 差异过滤） | 任务序号标签 + 输入 + 查询（3）；只看有差异（1） | 各 1 行，但**同一屏两处** | △ |
| 19 | `views/field/InspectionTaskCreateView.vue` | 无（ActionDock only） | 无 | — | |
| 20 | `views/field/InspectionManualRecordView.vue` | **不用 `.w-toolbar`**，自写 `__row`（`:444`、`:485`、`:504`、`:529`） | 任务序号输入 + 查询；每行「删除该行」；行底「新增一行 + 清空全部」（3 处入口） | 每处 1 行，但**同屏三处操作区** | △ |
| 21 | `views/field/InspectionResultListView.vue` | 2 个自写 `.w-toolbar`（`:452` 筛选、`:531` 确认） | 搜索输入 + 查找 + 全部 + 待确认 + 已确认 +（dirty）清空筛选 + 作用域文本（6–7）；确认这条结果（1） | 筛选 2–3 行 + 确认 1 行 | ✅ |
| 22 | `views/field/InspectionResultCreateView.vue` | 无（ActionDock only） | 无 | — | |
| 23 | `views/me/MessageListView.vue` | 2 个自写 `.w-toolbar`（`:312` 筛选、`:382` 翻页） | 搜索输入 + 查找 + 未读 Tag +（cond）chip +（cond）清空筛选 + 作用域文本（4–6）；上一页 + 页码 chip + 下一页 + 本页条数（4） | 2 行（实测 `11-messages`，作用域文本独占一行） | ✅ |
| 24 | `views/me/MessageDetailView.vue` | 无 | 无 | — | |
| 25 | `views/me/UserListView.vue` | 3 个自写 `.w-toolbar`（`:524` 筛选、`:578` 翻页、`:635` 明细动作）+ 表单动作（`:512`） | 搜索输入 + 查找 +（cond）chip +（cond）清空筛选 + 作用域文本（3–5）；翻页 4；明细动作 3 | 筛选 2 行；明细动作 1 行 | ✅ |
| 26 | `views/me/ProfileView.vue` | 5 个自写 `.w-toolbar`（`:435`、`:450`、`:472`、`:508`、`:556`） | 每处 1–2 个按钮，**不是筛选条**，是"该区块的动作行" | 各 1 行 | △ |

- ✅ = 手机上 ≥3 行或 ≥5 个控件的**收进抽屉的候选**：`DeviceListView`、`InspectionTaskListView`、
  `InspectionResultListView`、`MessageListView`、`UserListView`（共 5 屏，覆盖"现场/我的"两个域的高频屏）。
- △ = 行数不算多，但**同一屏有多处工具区**，手机上表现为"一屏里三个按钮带"，属于"看起来乱"的另一半来源。
- 另有 `views/PreviewView.vue:110-140` 两处 `.w-toolbar` + 两处 `FilterBar`，但**只在 `import.meta.env.DEV`
  注册**（`apps/web/src/router/routes.ts:75-84`），不算生产面。
- 外壳自己也用了 `.w-toolbar`：`packages/layouts/src/AppFrame.vue:245` 把手机分段控件写成
  `<div class="w-toolbar w-segment">`——所以改 `.w-toolbar` 的规则会**同时**影响壳与屏，这是一条容易踩的耦合。

### A2 明细屏的操作坞

`ActionDock` 的模板只有一行 `<div class="w-actiondock"><slot /></div>`（`packages/ui/src/business/ActionDock.vue:12-16`），
全部行为在样式里：

| 断点 | 形态 | 证据 |
| --- | --- | --- |
| 手机（< 600px） | `position: sticky`，`bottom: calc(--w-space-tabbar-height + env(safe-area-inset-bottom))`，`z-index:10`，白底 + `border-top`，`justify-content:flex-end` | `packages/ui/src/styles/ui.css:377-389` |
| 桌面（≥ 600px） | `position: static`、`min-height:0`、无内边距/无边框/背景透明 —— 动作回到页头那一行 | `packages/ui/src/styles/ui.css:391-399` |

**它不是 fixed，是 sticky。** 这条在 `ui.css:372-376` 的注释里被当作优点写下来（"旧 `BottomActionBar` 全屏 fixed
会遮挡手机底栏"），但 sticky 自己有一个后果：**当页面内容高于视口时，dock 会停在视口底部并盖住它后面的正文。**
实测三张图都能看到：

- `07-order-detail.png`：dock 里的「刷新」压在「可以做的操作」区块上（区块标题在 dock 上方半截）。
- `09-inspection-detail.png`：dock 的三个按钮（开始执行 / 保存当前进度 / 结束任务）压在「物料差异」表格上，
  能看到 `物料名称（个）` 这一列被切掉，且 dock 只有 `--w-space-action-bar-height`(56) 高，**三个按钮已经挤成一行、宽度不够**。
- `11-messages.png`：dock 的「全部已读 / 清空消息」压在消息卡片上。

内容不高于视口时看不出问题（`05-contract-detail.png` 的「解锁/锁定」就正常贴在卡片下方）。

**被哪些屏用**（`grep ActionDock apps/web/src/views`，13 屏，另有 `PlaceholderView` 与 DEV-only 的 `PreviewView`）：

| 屏 | dock 内容 | 数量 | 与 `PageHeader` 重复？ | 与"条目维护区"重叠？ |
| --- | --- | --- | --- | --- |
| `overview/AlertDetailView.vue:270-272` | 刷新 | 1 | ✅ 与 `:181` 的「刷新」**同一个动作** | 否（但另有 `:227` 「可以做的操作」4 个按钮） |
| `inventory/InventoryDetailView.vue:175-178` | 解锁 / 锁定 | 2 | 否（页头是刷新） | 否 |
| `inventory/StockOrderDetailView.vue:405-407` | 刷新 | 1 | ✅ 与 `:313` 的「刷新」重复 | ✅ 同屏还有 `:356` 明细维护条（输入+添加明细）**和** `:374` 「可以做的操作」（提交/撤回/审核通过/驳回）= **三处操作入口** |
| `inventory/StockOrderCreateView.vue:221-226` | 去登记明细 / 建单 | 1–2 | 否 | 否 |
| `inventory/TagDetailView.vue:107-109` | 刷新 | 1 | ✅ 与 `:87` 重复 | 否 |
| `field/DeviceDetailView.vue:171-173` | 刷新 | 1 | ✅ 与 `:144` 重复 | 否 |
| `field/InspectionTaskDetailView.vue:500-519` | 开始执行 / 保存当前进度 / 结束任务 | **3** | 否 | ✅ 另有 `:493` 「结果与补录」2 个入口 + `:433` 查询工具条 + `:486` 差异过滤 = **四处** |
| `field/InspectionTaskCreateView.vue:514-523` | 创建任务（+2 段提示文本） | 1 | 否 | 否 |
| `field/InspectionResultCreateView.vue:545-565` | 提交结果（+最多 3 段提示文本） | 1 | 否 | 否 |
| `field/InspectionManualRecordView.vue:540-546` | 提交补录（+提示文本） | 1 | 否 | ✅ 同屏还有每行「删除该行」`:488` 与行底「新增一行 / 清空全部」`:529-532` = **三处** |
| `me/MessageDetailView.vue:220-222` | 刷新 | 1 | ✅ 与 `:188` 重复 | 否 |
| `me/MessageListView.vue:408-412` | 全部已读 / 清空消息 | 2 | 否（页头是刷新） | ✅ 另有 `:382` 翻页工具条 = **三处**（页头刷新 / 翻页 / 批量操作） |
| `views/PlaceholderView.vue:38-40` | 返回 | 1 | — | — |

**重复的「刷新」共 5 屏**（`AlertDetailView`、`TagDetailView`、`DeviceDetailView`、`MessageDetailView`、
`StockOrderDetailView`）—— 手机上一屏能同时看到页头右上角和 dock 里两个一模一样的「刷新」，
这正是 §A4 要收的"两处操作入口"。另外 `InspectionTaskDetailView` 与 `InspectionManualRecordView`
的 dock 里放的是**主操作**（提交/结束任务），这类屏的"重复"不是同一个按钮，而是**操作区总数过多**。

`ui-spec.md:116`（`ActionBar`）写的是"高 56，固定在内容底部（不随滚动）"，
而现在的实现是 sticky（跟滚动）；`docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:376`
也写"ActionDock 56（**主操作 ≤2**）" —— 而 `InspectionTaskDetailView` 是 3 个，已经超出当时的设计口径。

### A3 手机壳结构

`packages/layouts/src/AppFrame.vue` 一个组件两套 chrome，**由 JS 切、不是 CSS 切**：

```
<div class="w-shell" :class="isCompact ? 'w-shell--mobile' : 'w-shell--desktop'">   ← :171
  ├─ 桌面：<aside class="w-sidebar">（品牌/菜单/账号）                              ← :173-214
  ├─ 桌面：<header class="w-commandbar">（面包屑 + PageSearch + BridgeStatusChip） ← :218-230
  └─ <div class="w-main">
       ├─ 手机：<header class="w-contextheader">                                   ← :232-243
       │    返回(ElButton) + <h1>{{ domain.label }}</h1> + [页面](if !useSegmented) + BridgeStatusChip compact
       ├─ 手机：<div class="w-toolbar w-segment">（分段控件，if isCompact && useSegmented） ← :245-255
       │    每个叶子一个 ElButton，尺寸 large，active = type primary
       ├─ <main class="w-content">  ← **唯一滚动容器**，里面 <RouterView :key="route.fullPath"> ← :261-263
       ├─ 桌面：<footer class="w-statusbar">                                       ← :265-269
       └─ 手机：<nav class="w-tabbar">（4 项，grid 4 等分）                        ← :271-282
     <ElDrawer direction="btt" size="420px">（域内入口列表，v-model=mobileDrawerOpen） ← :285-293
     <ScanResultCard v-if="isCompact" />                                          ← :295
```

| 决策点 | 判据 | 用在哪 |
| --- | --- | --- |
| 两套 chrome | `useViewport().isCompact` = `matchMedia('(max-width: 599px)')` | `AppFrame.vue:52,171,173,218,232,265,271,295`（`packages/ui/src/composables/useViewport.ts:21`） |
| **`useSegmented`** | `domain.children.length <= 4`（注释：">4 项改用抽屉里的入口列表，**不做横向滚动**：现场手指找不到"） | `AppFrame.vue:106-107`；渲染条件 `isCompact && useSegmented`（`:245`） |
| **抽屉入口列表** | `!useSegmented`，即 `domain.children.length >= 5` | `AppFrame.vue:241` 画「页面」按钮，`:285` 是抽屉本体 |
| 实际落入哪一支 | overview=2 项 → 分段；me=3 项 → 分段；**inventory=6 项 → 抽屉；field=6 项 → 抽屉** | `packages/layouts/src/navigation.ts:39-133` |

三个从这次调研里看出来的**结构性问题**（都在 A4 展开）：

1. `:233` 的 `v-if="isDetail || domain.children.length > 0"` —— 每个域都至少有 2 个子项，
   所以第二个条件恒真，**「返回」在手机上是无条件渲染的**，即使在域根屏上（实测 `04-inventory`、
   `06-stock-orders`、`08-inspections`、`10-devices`、`11-messages`、`12-profile` 六张图都有「返回」）。
2. `:245` 的分段控件**没有 `!isDetail` 条件**：`alert.detail`（overview 域，2 项）与
   `message.detail` / `user.detail`（me 域，3 项）在手机上都会画出分段控件，而且
   `activeMethod` 由 `leafHit`（`:61,65`）算，详情路由的 `route.name` 不是叶子 → `activeMethod === ''`
   → **三个分段里没有一个高亮**。这直接违反 `docs/ui-spec.md:67` 的
   「推入的屏画返回键、不画域内 TabStrip」。
3. `goBack()`（`:121-130`）在非详情屏上会 `push(domain.children[0].path)` ——
   在「库存查询」「消息中心」这类**本身就是第一个子项**的屏上点「返回」什么都不发生；
   在「商品管理」上则跳到「库存查询」。同一个按钮在不同屏上语义不同。

壳顶显示的确实是**域名**而不是页名（`:240` `{{ domain.label }}`，`:234-239` 的注释解释了为什么），
屏名归各屏自己的 `PageHeader`（`packages/ui/src/primitives/PageHeader.vue:17`）—— 第一遍的这条口径是成立的。

### A4 手机专属 hack / media query 清单

**全仓只有 5 处 `@media`**（`grep -r "@media" apps packages`）：

| 位置 | 形态 | 在补什么 | 风险 |
| --- | --- | --- | --- |
| `packages/ui/src/styles/ui.css:344-355` | `@media (max-width:599px)` → `.w-kv` 栅格从 `minmax(96px,auto) 1fr` 收成 `auto minmax(0,1fr)`，字号降到 `body-small` | 桌面栅格在 390px 上把值挤到角落、7 行吃掉半屏 | 断点 599 与 `useViewport` 的 599 一致 ✅ |
| `packages/ui/src/styles/ui.css:391-399` | `@media (min-width:600px)` → `.w-actiondock` 回到 static | 手机要吸底、桌面要回到页头 | 与上一条**同源**；但 600 与 `useViewport` 的 `isCompact ≤599` 恰好互补 ✅ |
| `apps/web/src/views/auth/LoginView.vue:252-262` | `@media (max-width:840px)` → 登录页单列 | 登录页是独立布局，不受 `.w-page` 约束 | **断点 840 不在 tokens 里**（tokens 是 599/1023/1024/1440，见 `packages/tokens/src/generated/theme.v2.css:75-78`），是第三套数字 |
| `apps/web/src/styles/base.css:73-87` | `@media (min-width:1024px)` → 桌面细滚动条 | 触摸端不画滚动条 | 无 |
| `packages/ui/src/styles/ui.css:465` / `apps/web/src/styles/base.css:89` / `packages/tokens/src/generated/theme.v2.css:108` | `prefers-reduced-motion` | 无障碍 | `base.css:93-94` 的 `animation-duration:0ms !important` 是**全仓唯一的 `!important`**（`grep -r "!important"` 只有这 2 行 + `ui.css` 无） |

**不在 media query 里、但本质是手机 hack 的**：

| 位置 | 形态 | 在补什么 |
| --- | --- | --- |
| `packages/ui/src/styles/ui.css:89-94` | `.w-toolbar > .el-input/.el-select/.el-date-editor { flex: 1 1 45%; min-width: 0 }` | 第一遍的返工点（`docs/superpowers/plans/2026-10-02-v0-v1-executable-plan.md:1037`「工具区散成三行」）。注释 `ui.css:79-88` 明确写"基准宽度用百分比而不是 `--w-space-detail-column-width`，因为它 ≈360px 在 390px 手机上会把整行占满"——**这是"桌面正常、手机才需要"的规则，却没有断点**，桌面上同样生效（靠各屏自己的 `max-width` 收回） |
| `packages/ui/src/business/FilterBar.vue:97-114`（scoped，无断点） | `.w-filterbar__select{min-width:140px}`、`.w-filterbar__search{min-width:260px}`、`.w-filterbar__scope{white-space:nowrap}` | 保证桌面筛选条一行；手机上 140px 的 select 会因 flex-grow 独占整行（实测 `06-stock-orders`）、260px 的搜索块 + 不换行的作用域标注会被挤到边缘（实测 `04-inventory`，「筛选本页」贴着屏幕右缘） |
| 各屏 `.w-xxx__search{max-width: var(--w-space-detail-column-width)}`（`InventoryListView.vue:258`、`DeviceListView.vue:213`、`InspectionTaskListView.vue:276`、`InspectionResultListView.vue:578`、`MessageListView.vue:431`、`UserListView.vue:720`） | 桌面宽列 400px 上限 | 桌面观感；手机因为 45% 基准，`max-width` 不起作用 |
| `packages/ui/src/business/FilterBar.vue:90`、`InventoryListView.vue:222`、`DeviceListView.vue:186`、`InspectionTaskListView.vue:236`、`InspectionResultListView.vue:469,480`、`MessageListView.vue:332`、`UserListView.vue:538` | 作用域标注文本（「筛选本页」/「全局搜索」/「按任务过滤由服务端完成…」） | 诚实规则：搜索范围必须写明。但它在手机上要么独占一行、要么被挤到右缘（`11-messages` 截图里「关键字只筛本页」独占一行；`04-inventory` 里贴在右缘） |
| `packages/layouts/src/AppFrame.vue:233` | `v-if="isDetail \|\| domain.children.length > 0"` | 恒定成立（见 A3），**等于没写条件** |
| `packages/layouts/src/AppFrame.vue:245` | `v-if="isCompact && useSegmented"` | 详情屏也画分段且无高亮（见 A3） |
| `AppFrame.vue:285` `ElDrawer size="420px"`、`shell.css:259-267` `.w-tabbar`、`shell.css:290-303` `.w-scancard`、`ui.css:379` | `env(safe-area-inset-bottom/top)`、`100dvh`、`height:100vh` 兜底 | 安全区与移动端地址栏 |
| `packages/ui/src/business/ResponsiveDataView.vue:52`、`PaginationBar.vue:26` | `mode==='auto' && isCompact` → 手机出卡片 / 出「加载更多」 | 双端切换（见 B4）；**屏没有任何覆盖手段除了传 `mode`**，而全仓只有 DEV 的 `PreviewView.vue:125` 传过 |

**"桌面正常手机异常"的注释**（`grep` 找 `桌面.*手机|手机.*桌面|窄屏|mobile`）：

- `packages/ui/src/styles/ui.css:79-88`：「Element Plus 的 `.el-input` 默认 `width:100%`…手机上一屏的 1/4 就这么没了」+
  「第一版就是这么返工的」。
- `packages/ui/src/styles/ui.css:340-343`：「详情屏在手机上原本 7 行就吃掉半屏 —— 那是"看起来乱"的主要来源之一」。
- `packages/ui/src/styles/ui.css:157-163`：「那样每张卡片下方都浮着一个孤立的红色按钮…手机端实测截图就是这样」。
- `packages/ui/src/styles/ui.css:372-376`：「旧 `BottomActionBar` 是全局 fixed，会遮挡手机底栏、还会跨到桌面侧栏上」。
- `packages/layouts/src/styles/shell.css:5-9`：两端布局约定的唯一说明处；`shell.css:90-94`「菜单区自己滚动…防止超出屏幕」。
- `packages/ui/src/business/PaginationBar.vue:9-11`：「手机出"加载更多"（拇指够不到页码，且触控目标太小）」。
- `packages/ui/src/business/ResponsiveDataView.vue:174-181`：「放在按钮外面是硬要求…那样每张卡片下面吊着一个孤零零的红色「移除」…实测截图就是这么难看的」。
- `packages/ui/src/business/UserListView.vue:35-38`（`me/UserListView.vue`）：「卡片本身是纵向布局 + `flex-wrap`，窄屏下不会横向溢出」。

---

## B 主从视图落点

### B1 路由与屏的关系

| 环节 | 文件 | 事实 |
| --- | --- | --- |
| IA 唯一定义 | `packages/layouts/src/navigation.ts` | `DOMAINS`（4 域 / 19 个导航叶子）`:39-133`；`DESTINATIONS`（13 个推入屏）`:150-203` |
| 路由表**生成** | `apps/web/src/router/routes.ts:30-44` | `leafRoutes` = `DOMAINS.flatMap(...)`，`destinationRoutes` = `DESTINATIONS.map(...)`；**不手写** |
| 屏组件来源 | `apps/web/src/views/registry.ts:17-59` | `SCREEN_REGISTRY`：**桥方法 id → 屏组件**（29 个方法 id / 25 个不同文件；4 组是"一屏两入口"：`tag.detail`=`tag.byCode`、`device.detail`=`device.byCode`、`inspection.resultList`=`inspection.resultDetail`、`user.list`=`user.detail`） |
| `path` 写法 | `routes.ts:28-44` | `relative()` 去掉前导 `/`，作为父路由 `/` 的子路由；**静态段必须排在参数段之前**（`routes.ts:17-24` 与 `navigation.ts:142-145` 两处都写了，由 `check:navigation` + smoke 钉住） |
| 路由实例 | `apps/web/src/router/index.ts:38-41` | `createWebHashHistory()`，hash 模式是**硬约束**（理由在 `index.ts:5-20`：两个宿主的相对路径与 SPA 回退都不支持 history 模式） |
| 路由 name | `router/index.ts:17-20`、`routes.ts:33,42` | **`name` = 桥方法 id**（`dashboard.summary` / `tag.byCode` 这种）；`meta` 里带 `title/domain/method/detail` |
| `detail` 标记 | `routes.ts:43`、`router/index.ts:31-32` | 只有 `destinationRoutes` 有 `meta.detail = true`；壳用它算 `isDetail`（`AppFrame.vue:64`） |
| **`<RouterView>`** | `packages/layouts/src/AppFrame.vue:261-263` | **有 `:key="route.fullPath"`**，注释 `:257-260` 写明"同一屏换参数时必须重挂载…整树重挂是最省心的正确做法" |
| 第二个 `<RouterView>` | `apps/web/src/App.vue:85` | 顶层那一个（无 key）只负责 shell / standalone（登录页）切换 |

### B2 列表 + 详情成对的屏

**"点行跳页"的成对**（列表 → 详情是两个独立路由）：

| # | 列表路由 / 屏 | 详情路由 / 屏 | 详情屏的"看哪一条"**怎么来** | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `/overview/alerts` · `AlertListView.vue:81-85` | `/overview/alerts/:alertId` · `AlertDetailView.vue` | `route.params.alertId` → `AlertDetailView.vue:50-62` | |
| 2 | `/inventory/inventory` · `InventoryListView.vue:195-199` | `/inventory/inventory/:inventoryId` · `InventoryDetailView.vue` | `route.params.inventoryId` → `InventoryDetailView.vue:36-46` | |
| 3 | `/inventory/tags` · `TagListView.vue:161-165` | `/inventory/tags/:tagId` · `TagDetailView.vue` | `route.params.tagId` → `TagDetailView.vue:39` | 同屏还有 `tag.byCode`（`:35` 读 `route.params.code`） |
| 4 | `/inventory/stock-orders` · `StockOrderListView.vue:123-127` | `/inventory/stock-orders/:orderId` · `StockOrderDetailView.vue` | `route.params.orderId` → `StockOrderDetailView.vue:63-71` | |
| 5 | `/field/devices` · `DeviceListView.vue:153-157` | `/field/devices/:deviceId` · `DeviceDetailView.vue` | `route.params.deviceId` → `DeviceDetailView.vue:51` | 同屏还有 `device.byCode`（`:47` 读 `route.params.code`） |
| 6 | `/field/inspections` · `InspectionTaskListView.vue:195-200` | `/field/inspections/:taskId` · `InspectionTaskDetailView.vue` | `route.params.taskId` → `InspectionTaskDetailView.vue:95-106`（**转成局部 `ref` `selectedId`**） | 详情屏自己还有一个"任务序号"查询框（`:433-444`） |
| 7 | `/me/messages` · `MessageListView.vue` | `/me/messages/:messageId` · `MessageDetailView.vue` | `route.params.messageId` → `MessageDetailView.vue:119` | |
| 8 | `/me/users` · `UserListView.vue` | `/me/users/:userId` · **同一屏** `UserListView.vue`（`registry.ts:57`） | **屏内 `selected` ref**（`UserListView.vue:76`）+ `:590` 的「用户详情」区块 | 已经是"屏内主从"，只是纵向堆叠 |

**"推入但不成对"的**（依赖 query 或屏内状态，没有对应列表路由）：

| 路由 / 屏 | 参数来源 | 谁推它 |
| --- | --- | --- |
| `/field/inspections/results` · `InspectionResultListView.vue` | `route.query.taskId`（`:141`） | 任务详情 `InspectionTaskDetailView.vue:412-418`、提交结果后 |
| `/field/inspections/results/:resultId` · **同一屏**（`registry.ts:48`） | `route.params.resultId`（`:153`） | 屏内列表点行（`openResult`） |
| `/field/inspections/results/new?taskId=` · `InspectionResultCreateView.vue` | `route.query.taskId`（`:166`） | 任务详情 / 结果列表 |
| `/field/inspections/manual?taskId=` · `InspectionManualRecordView.vue` | `route.query.taskId`（`:108`） | 任务详情 `InspectionTaskDetailView.vue:417` |

**没有详情屏的列表**（点行不跳页，用弹窗或屏内表单）：`ProductListView`（ElDialog）、`WarehouseListView`（ElDialog）、
`InspectionPlanListView`（ElDialog）、`DashboardView`（只有未处理告警点行跳 `alert.detail`）、`HomeView`（跳叶子）。

**已经存在的"一屏内主从"先例（3 个，对 B 的实现最有参考价值）**：
`MessageListView.vue:390-405`（消息正文区块，`openedId` 选中）、
`UserListView.vue:590-641`（用户详情区块，`selected` 选中）、
`InspectionResultListView.vue:506-550`（结果明细区块，`route.params.resultId`/屏内选中）。
三者都是**竖向堆叠**（左栏在上、右栏在下），不是并排。

### B3 布局现状

| 项 | 值 / 位置 | 说明 |
| --- | --- | --- |
| `.w-content` | `packages/layouts/src/styles/shell.css:210-216` | `flex:1 1 auto; min-width:0; min-height:0; overflow-y:auto; **overflow-x:hidden**`。**没有 `max-width`** —— 宽度就是主列宽度（1440−232 侧栏 = 1208px）。`overflow-x:hidden` 意味着任何横向溢出会被**裁掉**，不是出滚动条 |
| `.w-page` | `packages/ui/src/styles/ui.css:15-23` | `display:flex; flex-direction:column; gap:section-gap; width:100%; **max-width: var(--w-space-content-max-width)**; margin:0 auto; padding: 16px` |
| `--w-space-content-max-width` | `packages/tokens/src/generated/theme.v2.css:61` | **1120px** |
| `--w-space-detail-column-width` | `theme.v2.css:60` | **400px**（被 6 个屏的搜索框 `max-width` + `shell.css:330` 的 `.w-pagesearch` 宽度引用；注释 `ui.css:85-86` 说"≈360px") |
| `--w-content-max-width`（旧基线，容易混淆） | `packages/tokens/src/generated/tokens.css:253` | **720px**，是旧 Compose/React 基线的同名令牌；`check:css` 取两条基线的并集（`tools/check/check-css-vars.js:12-17`），所以两个名字都能通过门禁 |
| 断点令牌 | `theme.v2.css:75-78` | `--w-breakpoint-compact-max:599` / `medium-max:1023` / `desktop-min:1024` / `wide-min:1440` |
| **现成的两栏组件** | **不存在** | `packages/` 下只有 `bridge-client / bridge-vue / contract / layouts / scan / stores / tokens / ui`，**没有 `patterns`**。`docs/ui-spec.md:115` 描述的 `MasterDetail`（"左栏 `minmax(200,34%)`，右栏自适应；中缝 1px `outline`"）属于 React 时代的 `packages/patterns`，`ui-spec.md:76-81` 自己注明"**当前无屏使用**…假数据比空栏更糟，已删除" |
| 最接近两栏的现成写法 | `DashboardView.vue:202-206` `.w-overview-grid{grid-template-columns: repeat(auto-fit, minmax(var(--w-size-card-min-width),1fr))}`；`HomeView.vue:206-213` `auto-fill + minmax(280px,1fr)` | 都是「卡片网格」，`auto-fit` 在 1120px 上会切出 5 列 / 3 列，**不是 34/66 的固定主从比例** |
| 桌面实测形态 | `.tmp-shots/13-app-center-desktop.png` | 1440 宽下侧栏 232 + 内容 1120 居中，右侧余量很小；两栏要在这个 1120 里切 |

### B4 `ResponsiveDataView` 的双端切换判据

| 环节 | 事实 | 证据 |
| --- | --- | --- |
| 判据 | `asCards = mode==='cards' \|\| (mode==='auto' && isCompact.value)`，`mode` 默认 `'auto'` | `packages/ui/src/business/ResponsiveDataView.vue:28,51-52` |
| `isCompact` 从哪来 | `useViewport()` → `matchMedia('(max-width: 599px)')` 的 `change` 事件 | `packages/ui/src/composables/useViewport.ts:21,29-39,50` |
| **谁决定** | **JS（`matchMedia`），不是 CSS 断点** —— 表格与卡片是两套 DOM，不是同 DOM 换样式 | `ResponsiveDataView.vue:118`（`w-datatable`）vs `:155`（`w-cardlist`） |
| 手机出什么 | `<ul class="w-cardlist">` + `<li class="w-cardrow">` + `<button class="w-card">`，列由 `ColumnDef.compact` 挑（`primary/secondary/chip`，缺省 `hidden`） | `ResponsiveDataView.vue:79-85,155-187`；`packages/ui/src/types.ts:22-43` |
| 桌面出什么 | `<div class="w-datatable">` + `ElTable` + `ElTableColumn`（`columnProps` 单独算，`width` 可选） | `ResponsiveDataView.vue:68-74,118-152` |
| 显式覆盖 | `mode` prop（`'auto' \| 'table' \| 'cards'`），只有 DEV 的 `PreviewView.vue:125` 用过 | `ResponsiveDataView.vue:28` |
| 同类判据还有 | `PaginationBar`：`asMore = mode==='more' \|\| (auto && isCompact)` → 手机「加载更多」，桌面 `ElPagination`（`PaginationBar.vue:19,25-26,63-73`） | 同 `useViewport` |
| SSR / 无 window | `useViewport` 退化为 `{isCompact:false, isDesktop:true}`（**桌面档**） | `useViewport.ts:25-27` |
| **可复用的"宽屏"判断** | `useViewport()` 返回 `isDesktop` = `matchMedia('(min-width: 1024px)')`，**全仓目前没有任何调用方**（`grep isDesktop` 只命中 `useViewport.ts` 本身与 `index.ts` 的 re-export） | `useViewport.ts:22,32,49` |
| 缺口 | **没有 `isWide`/`isMedium`**，而 `isCompact`(≤599) 与 `isDesktop`(≥1024) 之间留了 **600–1023 的空白带**：`v-if="isDesktop"` 会让平板/小笔记本落回"跳页"，`v-if="!isCompact"` 又会让 600–1023 走主从 | `useViewport.ts:21-22` |

### B5 风险点

按"会不会直接坏"排序，每条带证据。

| # | 风险 | 证据 | 严重度 |
| --- | --- | --- | --- |
| R1 | **`<RouterView :key="route.fullPath">` 强制整树重挂**：主从视图若靠"点行 → push 详情路由"实现，右栏换内容的同时**左栏也被销毁重建**（页码回 1、筛选还在 `useNavStore`、滚动位置丢），与「点行不跳页」的初衷相反 | `AppFrame.vue:257-263`；`packages/stores/src/nav.ts:5-9,31,75-77`（`scrollTop` 还存在 store 里，但没有屏调用 `rememberScroll`） | **blocker** |
| R2 | **详情屏把"看哪一条"写成 setup 期的常量**：8 个详情屏都在 setup 里读 `route.params` 并存成 `ref`/`computed` 后就再也不看路由；路由停在列表路由时 `params` 为空，全部落进 `!hasTarget` 空态 | `StockOrderDetailView.vue:63-75`、`AlertDetailView.vue:50-62`、`InventoryDetailView.vue:36-46`、`TagDetailView.vue:35-41`、`DeviceDetailView.vue:43-55`、`InspectionTaskDetailView.vue:95-115`、`MessageDetailView.vue:119-128`、`InspectionResultListView.vue:141-155` | **blocker** |
| R3 | **冒烟测试有"点行必须换 hash"的行为断言**：改主从即改行为，这条必然红 | `apps/web/smoke/check-web-smoke.mjs:731-737`（点行 → `waitFor(location.hash.includes('/overview/alerts/'))` + `check('点行进详情（路由参数带上序号）')`）；另 `:520-535`（`gotoAndTitle('#/inventory/stock-orders/12345')` 必须开"单据详情"）、`:561`（断点切换后 `hash === '#/inventory/inventory'`）、`:1104-1107`（直接跳 `#/inventory/inventory/101` 且页头标题是商品名） | 高 |
| R4 | **`check:render` 要求"每屏页头标题非空且等于期望值"**：SSR 用例是把**每个屏单独渲染**在 `path:'/'`（无参数）下，再用正则抓**第一个** `class="w-page-header__title"`。若主从视图把列表与详情同时画进 DOM，第一个标题会变成列表的（`EXPECTED_TITLES['inventory.detail']==='库存详情'`→实得「库存查询」），门禁失败 | `tools/check/check-vue-render.mjs:54-58,103-111`；`apps/web/ssr/render-entry.ts:62-89,121-130`（路由只给上下文、不挂屏） | 高 |
| R5 | **大量 smoke 断言用 `document.querySelector('.w-page-header__title')`（取第一个）**：同 R4，双栏并存时"现在这一屏的标题"不再唯一 | `check-web-smoke.mjs:523-525,715,1039,1105,1134` | 高 |
| R6 | **扫码兜底落点必须仍是 `tag.byCode` 路由**：扫码三分支的第三支由**壳**执行 `router.push({name: SCAN_TARGET_METHOD, params:{code}})`，冒烟直接断言 hash | `AppFrame.vue:142-152`；`packages/layouts/src/navigation.ts:205-206`；`check-web-smoke.mjs:584-589`（`hash === '#/inventory/tags/code/ABCD1234'`） | 高 |
| R7 | **`返回` 与 `isDetail` 的耦合**：`isDetail` 只由 `destinationOf(route.name)` 判定。若主从改用 `?id=`（路由名仍是列表叶子），手机「返回」就不再是"关掉右栏"，而会 `push(domain.children[0])`；桌面也失去详情语义 | `AppFrame.vue:62-64,121-130,233` | 中高 |
| R8 | **表格固定列宽之和 > 右栏宽度**：`ResponsiveDataView` 把 `ColumnDef.width` 直传 `ElTableColumn`，而 `.w-content` 是 `overflow-x:hidden`（**裁掉，不出滚动条**）。1120px 内切 34/66 → 右栏约 720px：`StockOrderListView` 固定宽合计 190+90+150+110+120+90+140 = **890px**，`InspectionTaskListView` 170+110+150+130+150+140+110 = **960px** —— 按桌面表格渲染会溢出被裁 | `ResponsiveDataView.vue:68-74,131-145`；`shell.css:210-216`；`StockOrderListView.vue:68-115`；`InspectionTaskListView.vue:117-140`；`theme.v2.css:60-61` | 高 |
| R9 | **"`.w-content` 是唯一滚动容器"这条红线**：两栏若各自 `overflow-y:auto`，就变成三个滚动容器（`.w-content` + 两栏），而冒烟用行为断言钉住这条（`.w-content` 的 `overflow-y === 'auto'` 且整页 `window.scrollY === 0`） | `apps/web/src/styles/base.css:5-13,28-36`；`shell.css:208-216`；`check-web-smoke.mjs:877-916` | 中高 |
| R10 | **`.w-page` 是每屏自己的容器**（`max-width:1120px; margin:0 auto`），没有 `--wide` 变体；两栏要么写在 `.w-page` 内部，要么给壳加一个"宽内容"模式（会牵到 26 个屏的容器类） | `ui.css:15-23`；`HomeView.vue:177-185` 也是同一份 `max-width` 拷贝 | 中 |
| R11 | **新增路由名会被 `check:navigation` 拦下**：门禁把 `apps/web/src/**` 里所有 `router.push({name:'x'})` 的字面量与「导航叶子 + DESTINATIONS」比对，未登记即失败；所以"列表+详情合成一个新 name"这条路要么改 `navigation.ts`，要么根本不用新 name | `tools/check/check-navigation.mjs:89-129`；`navigation.ts:230-238`（`canReach`/`allReachableMethods`） | 中 |
| R12 | **`check:budget` 的余量很薄**：任一 chunk ≤130KB gzip，实测"列表页增量 115.9KB"。把两栏组件放进 `@wise/ui` 会被 `AppFrame` 的 `@wise/ui` 依赖带进首屏依赖图（虽然 ESM 可摇树，但组件一旦被多个列表屏 import 就会进同一批 chunk） | `tools/check/check-budget.js:12-14,32-33,93-100`；`AppFrame.vue:7`（壳 import `@wise/ui`） | 中低 |
| R13 | **DEV 有路由名重复自检**：`router.getRoutes()` 同名会 `console.error`；用新 name 时别与既有 29 个方法 id 撞 | `apps/web/src/router/index.ts:44-56` | 低 |
| R14 | **`nav.stack` 是死代码**：主从需要的"选中的是哪一条"目前**没有任何 store 位**，`useNavStore` 只有 `page/filters/scrollTop` | `packages/stores/src/nav.ts:5-9,29,63-73`（`push/pop/clearStack` 无人调用，`grep` 全仓无命中） | 低（但说明"没有现成的选中态模型"） |
| R15 | **选中态样式会撞车**：`UserListView.vue:556`、`MessageListView.vue:361` 用 `__row--open` 描边表达"选中"；若主从再引入一套选中样式，会出现两套口径 | `UserListView.vue:552-569`；`MessageListView.vue:357-373` | 低 |

---

## 4 候选改造清单（按 收益/风险 排序）

排序原则：**收益大 + 风险小**在前。每条一句，末尾标触及的文件。

### ✅ 收益大、风险小（建议第二批直接做）

1. **去掉 5 屏 `ActionDock` 与 `PageHeader` 里重复的「刷新」**（同一个 `reload`），dock 里只留真正的"详情动作" ——
   `AlertDetailView.vue:181/270`、`TagDetailView.vue:87/107`、`DeviceDetailView.vue:144/171`、
   `MessageDetailView.vue:188/220`、`StockOrderDetailView.vue:313/405`。
   *触及：5 个屏文件。*
2. **修 `ActionDock` 在手机上盖住正文**（三张实测图）：最小改动是让 dock 不再 sticky（回到内容末尾 + 内容底部预留高度），
   或给 dock 一个"内容高度 = 0 时不吸底"的条件；同时 dock 内按钮超过 2 个时不允许横排（`09` 图三个按钮已经挤扁）。
   *触及：`packages/ui/src/styles/ui.css:370-399`、`packages/ui/src/business/ActionDock.vue`、
   （可能）`InspectionTaskDetailView.vue:500-519`。*
3. **修手机壳「返回」恒显**：`:233` 的 `v-if` 第二个条件恒真，改成只看 `isDetail`（或"详情 or 非域根"）。
   *触及：`packages/layouts/src/AppFrame.vue:233`。*
4. **详情屏不画分段控件**：`:245` 加 `!isDetail`，与 `docs/ui-spec.md:67` 对齐；顺带解决"无高亮分段"看起来像坏了。
   *触及：`packages/layouts/src/AppFrame.vue:245`、`docs/ui-spec.md`。*
5. **把 5–7 控件的工具区收进「筛选」抽屉**（`DeviceListView:172`、`InspectionTaskListView:220`、
   `InspectionResultListView:452`、`MessageListView:312`、`UserListView:524`）：手机上只留"搜索框 + 筛选按钮(带条件数)"，
   抽屉里放 `FilterBar`/分段/清空。这正好也把"作用域标注"从被挤到右缘/独占一行变成固定在抽屉里。
   *触及：上述 5 个屏 + `packages/ui/src/business/FilterBar.vue`（若要加"抽屉态"）+ `packages/ui/src/styles/ui.css`。*
6. **把"作用域标注文本"从 `.w-toolbar` 里挪到 `PageHeader` 的 `note` 或一个 `StatusChip`**：
   `04-inventory` 里「筛选本页」贴着屏幕右缘、`11-messages` 里它独占一行，都是同一段文字的不同畸形。
   *触及：`InventoryListView.vue:222`、`DeviceListView.vue:186`、`InspectionTaskListView.vue:236`、
   `InspectionResultListView.vue:469,480,548`、`MessageListView.vue:332`、`UserListView.vue:538`。*
7. **`InspectionTaskDetailView` 把 4 处操作区收到 2 处**：`结果与补录` 的 2 个入口（`:493-497`）本可以并进 dock 或页头，
   与 dock 的 3 个主操作合成一组；`查看某个任务`（`:433`）在**已经从列表进来**时是冗余的。
   *触及：`InspectionTaskDetailView.vue:431-519`。*
8. **`LoginView` 的 840 断点改成令牌断点**（599 或引入 840 到 `theme.json`）：现在全仓有三套断点数字（599/1024/840）。
   *触及：`apps/web/src/views/auth/LoginView.vue:252`、`packages/tokens/src/theme.json` + `tools/gen/gen-naive-theme.js`。*

### ⚠️ 收益大、风险中（要先定方案再动）

9. **给 `useViewport` 补一个 `isWide`/三档齐全的判据**（现在 600–1023 是空白带）：主从视图必须有一个明确的
   "从多宽开始并排"的判据，否则平板上会出现"表格 + 卡片"或"两栏挤成一栏"。
   *触及：`packages/ui/src/composables/useViewport.ts`、`packages/tokens/src/generated/theme.v2.css`（断点令牌已够用）。*
10. **详情屏支持"外部指定目标"的入参**：把 `route.params` 的解析抽成 `targetId` prop（路由参数作为缺省来源），
    这样右栏可以复用同一个组件。**这是主从视图的前置条件**，不做这一步 R2 无法绕开。
    *触及：8 个详情屏（见 R2 清单）+ 可能新增一个 `useRouteParam` composable。*
11. **两栏布局组件**（`MasterDetailPanel` 或者给 `.w-page` 加 `--wide` 变体）：断点 ≥1024 才并排，
    窄屏维持现在的跳页；左栏只放列表（**不放 `PageHeader`**，避免 R4/R5 的"两个页头标题"）。
    *触及：`packages/ui/src/business/`（新组件）+ `packages/ui/src/index.ts` + `packages/ui/src/styles/ui.css`。*
12. **把 `<RouterView>` 的 `:key` 从 `route.fullPath` 收紧**（例如只在"路由名变化"时重挂，或把"同屏换参数"的重挂
    下沉到屏内 `watch`）：这是 R1 的根，动它影响所有详情屏的"查 NOPE-999 还显示上一条"防呆（`AppFrame.vue:257-260` 记的原始缺陷）。
    *触及：`packages/layouts/src/AppFrame.vue:262` + 所有依赖重挂来刷新的详情屏。*
13. **冒烟测试补一条"桌面主从：点行不换 hash、右栏换内容"**，并把现有点行断言改成"宽屏不跳 / 窄屏跳"两分支：
    这是唯一能把 R3 从"改坏了没人知道"变成"改对了才算绿"的手段。
    *触及：`apps/web/smoke/check-web-smoke.mjs:731-737` 及同类断言。*

### 🚫 收益大但风险很高（需要先改口径/红线）

14. **让两栏各自滚动**：与"`.w-content` 是唯一滚动容器"的既定红线直接冲突（`base.css:5-13`、`check-web-smoke.mjs:877-916`）。
    要么改红线（用户明确要求过"页面高度固定，只能进行换页"），要么两栏共用一个滚动容器（右栏内容长了会带着左栏一起滚）。
    *触及：`apps/web/src/styles/base.css`、`packages/layouts/src/styles/shell.css:208-216`、冒烟断言。*
15. **把详情路由"吞掉"（并排时不再跳路由）**：会同时破坏扫码落点（R6）、冒烟 hash 断言（R3/R4/R5）、
    以及"详情页可被直接分享/直达"这条现有能力（`#/inventory/inventory/101` 是能直接打开的）。
    *触及：`packages/layouts/src/navigation.ts`、`apps/web/src/router/routes.ts`、`AppFrame.vue`、冒烟与 `check:render`。*

---

## 5 仍不确定的事实

1. **"29 屏"的计数口径没对齐**：`apps/web/src/views/**` 下是 **30 个 `.vue`**；`SCREEN_REGISTRY` 是
   **29 个方法 id / 25 个不同文件**（4 组"一屏两入口"）；再加不在注册表里的 `HomeView`（`routes.ts:50-55` 单独注册）、
   独立于壳的 `LoginView`、以及 `PlaceholderView`/`PreviewView`/`BootFailure` 三个非业务屏。
   我不知道"29 屏"指的是哪一套，报告里按"25 个注册表屏 + HomeView"来数。
2. **`--w-space-detail-column-width` 到底是 360 还是 400**：令牌值是 **400px**（`theme.v2.css:60`），
   但 `ui.css:85-86` 的注释写"≈360px"。这个差值是注释过期还是有意（360 是旧的视觉稿值）我没查出来。
   它会影响"右栏最小宽度够不够放搜索框"的判断。
3. **600–1023 这一档的真实使用场景**：仓库里只有 390×844（手机）与 1440×900（桌面）两套截图，
   WSA / Electron 窗口在 600–1023 之间的实际形态没有证据。所以"主从从多宽开始"目前只能靠
   `--w-breakpoint-desktop-min:1024` 这条令牌推断，**没有实测**。
4. **`ActionDock` 的 sticky 遮挡是否已在真机（WSA）上被用户看到**：我只有 `.tmp-shots` 里的
   浏览器视口截图（390×844@2x）三张能证明。安全区（`env(safe-area-inset-bottom)`）与安卓输入法
   弹出时的行为没有证据 —— `docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:376`
   提到"避让安全区与输入法"，但输入法这一条在本仓没有任何实现或测试。
5. **`.w-toolbar > .el-input{flex:1 1 45%}` 在桌面上是否真的无害**：桌面靠各屏自己的 `max-width`
   （400px）收回宽度，但 `README`/spec 里没有对这条做桌面实测；我只在 13-app-center-desktop.png
   上看过应用中心（没有工具条）。
6. **`useNavStore.stack` 是死代码还是"预备给路由返回栈"**：全仓无调用（`grep` 已确认），
   而 `docs/ui-spec.md:67-69` 的"推入栈"描述暗示它本该被用。它是不是 V3 遗留下来的空壳，我没有 git 证据。
7. **`docs/ui-spec.md` 与 tokens 的口径分叉范围**：`ui-spec.md:44` 写断点 600/840、`:49` 写 `--w-content-max-width(720)`、
   `:111` 写侧栏宽 200，而 tokens 是 599/1023/1024/1440、1120、232。我只逐条比对了这几处，
   没有把 `ui-spec.md` 248 行全部与实现对齐一遍（那本身是一份独立工作）。
8. **主从视图是否该覆盖"表单屏"**：`StockOrderCreateView` / `InspectionTaskCreateView` /
   `InspectionResultCreateView` / `InspectionManualRecordView` 在桌面宽屏下也是"左列表 + 右表单"的候选
   （`docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:321` 写的是"全部列表屏"），
   但这次任务只让调研"列表屏 + 详情屏"，所以这 4 屏我没有按主从候选逐条评估。
