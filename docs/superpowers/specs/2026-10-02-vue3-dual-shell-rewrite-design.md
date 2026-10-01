# WiseDepot Client —— Vue 3 + Naive UI 双端客户端重写方案（设计稿 v2 · 已定稿）

> v2 变更：Q1 已选 **Naive UI**；Q2 已定 **白色简约运营台**（按参考图取色）；Q3 **干净**（去装饰、去伪数据）。
> v1 的结构化结论（只换 Web 层、Pinia 唯一状态所有者、hash 路由、逐域迁移）**全部保留**，本稿替换 §6/§7 的视觉与组件层，并补充参考图到真实契约的映射与诚实边界。
> 上游：`2026-09-30-client-bridge-ui-restructure-design.md`（Bridge 安全修复、叶子/推入分层、"不虚构数据"三条继续有效）。

---

## 0. 一句话

**桥、宿主、协议、后端全部不动**；把 Web 层从 React 19 换成 **Vue 3 + Vite + TS + Pinia + Naive UI**，
丢弃现有全部界面，按参考图重做一套**白色简约 · 深青导航**的双端 UI，共用同一份业务逻辑与数据层。

```
Vue 3 + Naive UI Web 产物 ──WS(Netty)──► Kotlin 桥（零改动）──HTTPS──► WiseDeoptServer（零改动）
        ▲ 本次只改这一格        桌面 Electron（零改动） / 手机 Android :shell（零改动）
```

---

## 1. 现状基线（证据）

| 项 | 现状 | 出处 |
| --- | --- | --- |
| Web 框架 | React 19 + `@vitejs/plugin-react` | `apps/web/package.json` |
| 屏 | **25 屏**（24 业务 + 登录），注册表接线 **34 / 167** 条桥方法 | `packages/features/src/registry.tsx` |
| 复用层 | `tokens`、`contract`（167 方法生成物）、`bridge-client`（传输/会话/mock） | `packages/*` |
| 设计系统 | `packages/patterns`：~34 个 React 组件 + `patterns.css`(26KB) | `packages/patterns` |
| 设备能力 | `packages/scan`：两个 React hook + 纯逻辑 `assembler.ts` | `packages/scan` |
| 门禁 | 15 条 `pnpm check:*`（多为 TSX / React SSR 断言） | 根 `package.json` |
| 体积 | 首屏 JS 75.65 kB gzip，预算 250 kB | `README.md` §W1 |
| 进行中 | **两批未提交改动**：① `bridge/*`、`apps/desktop`、`apps/mobile` 的 phase-1 安全修复 ② `packages/{features,patterns,shells}` + `tools/check` 的工业运营台 UI | `git status`（详见 V0/V1 计划 V0-1） |

> README 的进度表把 W4–W7 标 ⏳，但四个域的 25 屏**代码已全部落地**。本方案以代码为准。

### 1.1 复用 / 重写判定

| 模块 | 处置 | 理由 |
| --- | --- | --- |
| `bridge/*`、`apps/desktop`、`apps/mobile/shell` | **零改动** | 与框架无关；且当前有未提交改动 |
| `packages/contract`、`packages/bridge-client` | **零改动** | 纯 TS，`Bridge` 接口与传输语义原样迁移 |
| `packages/tokens` | **改造**（生成源 → `theme.json`，新增 Naive 主题生成） | 视觉唯一出处 |
| `packages/patterns`、`shells`、`features` | **删除重写** | → `@wise/ui` / `@wise/layouts` / `@wise/views` |
| `packages/scan` | **半重写** | `assembler.ts` 直接搬，两个 hook 改 composable |
| `apps/web`、`tools/check/*` | **重写** | 入口/构建；8 条门禁重写 + 4 条新增 |

---

## 2. 决策清单（Decision log）

| # | 决策 | 理由 | 备注 |
| --- | --- | --- | --- |
| **D1** | 只替换 Web 层；协议 v3、帧字段、错误码、`__bridge.json`、宿主进程模型不动 | 架构不变式 1/2/3；`bridge/*` 正在 phase-1 修改，跨层改动会互相污染 | — |
| **D2** | Vue 3（锁 patch）+ `<script setup>` + TS strict（沿用 `tsconfig.base.json` 全档） | 沿用 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 等既有严格度 | — |
| **D3** | **Pinia 是客户端状态唯一所有者**；组件内禁止裸 `bridge.call` | 集中后才能做跨屏缓存、去重、返回不丢数据、重连重取 | `check:store` |
| **D4** | `vue-router` 4 + **hash history**，路由 id = 桥方法 id | 两端 `base:'./'` + 宿主按 web 目录映射路径；history 深链接会同时打碎相对资源与宿主 fallback | 改这条等于改宿主 |
| **D5** | **采用 Naive UI**（`naive-ui`）+ **themeOverrides 令牌桥**；业务层再包一层 `@wise/ui` | 用户指定；省掉自建 34 组件；Naive 组件齐全（DataTable 虚拟滚动 / Menu inverted / Form / Drawer / Dialog） | 代价见 §14 风险 R1–R4 |
| **D6** | 令牌基线 = **参考图取色**，单一出处 `packages/tokens/src/theme.json`，同时生成 `tokens.css` + `naiveTheme.ts` | UI 全部重做，旧 Compose 主题不再是约束；"一处定义 + 生成物一致"的纪律保留 | 见 §6.1 取色证据 |
| **D7** | 视觉方向：**白色简约运营台** —— 白底卡片、深青 `#102E3E` 导航、青绿主色 `#087C75`、语义色只用于状态芯片 | 用户指定"白色款 + 干净" | 见 §6 |
| **D8** | **原地重写 `apps/web`**；React 版在 V0 打 tag `archive/react-web-final` | 保留廉价回滚点，不做长期双栈并行 | — |
| **D9** | 包名：`@wise/ui`（Naive 包装 + 业务组件）、`@wise/layouts`、`@wise/views`、`@wise/stores`、`@wise/bridge-vue`、`@wise/scan` | 与旧包一一对应，便于迁移对照 | — |
| **D10** | 测试：Vitest + `@vue/test-utils` + `@vue/server-renderer`（渲染门禁）+ Playwright + axe-core | 与现有门禁意图一一对应 | — |
| **D11** | 只引三件第三方：`naive-ui`、`@tanstack/vue-virtual`（备用，若 NDataTable 虚拟滚动不够用）、`@floating-ui/vue`（仅自建浮层） | 控制体积与令牌泄漏 | 图标用自绘 SVG，不引 `@vicons`（体积） |
| **D12** | 不做 Nuxt / SSR / 暗色主题（保留切换位但本次只验收亮色） | 宿主是本地 WebView；暗色会让双端验收面翻倍 | — |

---

## 3. 目标架构

### 3.1 依赖方向（严格单向）

```
tokens ─┬─► tokens.css（CSS 变量）
        └─► naiveTheme.ts（Naive themeOverrides 生成物）
              │
              ▼
tokens ─► ui（Naive 包装 + 业务组件）─► layouts ─► views ─► apps/web 装配
                ▲                       ▲          ▲
                └────── bridge-vue ─────┴──────────┘
                             │
                     bridge-client ──WS──► Kotlin 桥
```

- **`ui` 不认识桥**：`@wise/ui` 不得 import `bridge-client` / `stores`（`check:store`）。
- **`views` 不直接用 Naive 的裸组件做业务壳**：可以 `import { NButton }` 之外的一切，但列表/表单/四态必须走 `@wise/ui` 的包装件，否则密度与语义会在 25 屏里散开。

### 3.2 目录树（目标态）

```
apps/web/
  index.html  vite.config.ts        # base:'./'、Vue、manualChunks(vendor-vue / vendor-naive / vendor-ui)
  src/
    main.ts boot.ts App.vue
    router/{routes.ts,guards.ts}
    theme/naive.ts                  # 引用 @wise/tokens 的生成物，做少量局部覆盖
packages/
  tokens/   src/theme.json + generated/{tokens.css,tokens.ts,naiveTheme.ts}
  contract/ bridge-client/          # 零改动
  bridge-vue/  {plugin,useBridge,useBridgeState,useResource,useMutation,keys}.ts
  stores/      {bridge,session,nav,ui,scan,resources/*}.ts
  ui/          primitives/**（Naive 包装） business/**（四态/ResponsiveDataView/配方） icons/**
  layouts/     {AppFrame,DesktopShell,MobileShell,CommandBar,ActionDock,StatusBanner}.vue
  views/       {auth,overview,inventory,field,me}/**
  scan/        {assembler.ts,useCameraScan.ts,useScanGun.ts}
tools/check/   （见 §10）
```

### 3.3 数据流

```
Vue 组件 ──(只读 store / dispatch action)──► Pinia resource store
                                                │ useResource(method, params)
                                                ▼
                                         bridge-client.call()
                                    cache key = `${method}#${paramsKey}`
                                    单飞 / 去重 / 重连最多重取一次 / 结构化 BridgeError
                                                ▼
                                          Kotlin 桥
```

---

## 4. 状态与数据层（Pinia）

### 4.1 store 清单

| store | 拥有 | 关键字段 |
| --- | --- | --- |
| `useBridgeStore` | 桥连接 | `kind('ws'\|'mock')`、`origin`、`state`、`capabilities`、`hostVersion`（**订阅式**，非一次性 getter） |
| `useSessionStore` | 会话 | `loading/authenticated/username/passwordChangeRequired/expired`；订阅 `session.expired` → reload |
| `useNavStore` | 导航与视图状态 | 当前域/叶子/推入栈、每屏 `{filters,page,scrollTop}`、扫码接收者 |
| `useUiStore` | 交互壳 | 密度档、Toast、Confirm 队列、离线横幅 |
| `useScanStore` | 扫码路由 | `pending` 队列、当前消费者、最近结果 |
| `resources/*` | 域资源缓存 | `Map<key,{data,loading,error,updatedAt,inflight}>` |

### 4.2 取数语义（把 `useBridgeCall` 踩过的坑逐条变成硬约束）

1. **失败结构化**：`BridgeError`（`code`/`messageKey`/`retryable`），UI 按 `code` 分支；
2. **作用域销毁后不落地**：`onScopeDispose` 作废回调；
3. **重连后最多重取一次**：沿用 `shouldRefetchOnOpen(state,{failed,startedWhileDisconnected})`；
4. **`enabled:false` 与"本来就无参"分离**（`dashboard.summary` 无参，不能被当成"没准备好"）。

### 4.3 mutation 规约

进行中禁止重复提交（store 单飞 + UI disabled）；失败保留输入给重试；成功后 `invalidate()` 相关列表键；**不做乐观更新**（后端有状态机，乐观回滚会误导操作员）；危险动作一律 `useUiStore.confirm()`。

### 4.4 禁止项

| 禁止 | 门禁 |
| --- | --- |
| `.vue` 内 `bridge.call(...)` | `check:store` |
| `@wise/ui` import `bridge-client` / `stores` | `check:store` |
| 屏自写四态分支而不走 `StateHost` | `check:render` |
| React 残留（`.tsx` / `react` 依赖） | `check:no-react` |
| themeOverrides / 组件内出现字面量色值 | `check:naive` |

---

## 5. 导航与路由

- **叶子**（列表/表单/看板）进侧栏/底栏；**推入的屏**（详情）不占导航项，只由列表点行或扫码进入（沿用已拍板分层）。
- 路由：`method → path`，hash 模式：

```ts
{ path: '/overview/dashboard',        name: 'dashboard.summary',   component: DashboardView }
{ path: '/overview/alerts',           name: 'alert.list',          component: AlertListView }
{ path: '/overview/alerts/:alertId',  name: 'alert.detail',        component: AlertDetailView }
{ path: '/inventory/inventory',       name: 'inventory.list',      component: InventoryListView }
{ path: '/inventory/tags/:code',      name: 'tag.byCode',          component: TagDetailView }
{ path: '/login',                     name: 'auth.login',          component: LoginView, meta: { public: true } }
```

- 路由表 ⊆ `DOMAINS ∪ DESTINATIONS`，由 `check:navigation` 在 CI 期拦下拼错/漏迁。
- 参数变化用 `<RouterView :key="route.fullPath" />` + **store 缓存键**（`method#paramsKey`），不再依赖整树重挂。
- 状态保存：路由+参数进 URL；筛选/页码进 `useNavStore`（sessionStorage 恢复）；未提交表单一律 `onBeforeRouteLeave` 拦截确认。

### 5.1 启动状态机（比现在更细，桥故障不伪装成登录页）

```
booting → waitingHost → ready ─┬─ authenticated
                              ├─ unauthenticated
                              ├─ expired
                              └─ passwordChangeRequired（强制改密门）
        ↘ bridgeFailed（宿主在、桥不可用）→ 重试 / 联系管理员
        ↘ mockDev（仅 DEV，界面常驻"开发态假桥"标记）
```

---

## 6. 视觉系统（白色简约 · 按参考图取色）

### 6.1 取色证据（对参考图 `image.png` 1655×1003 逐像素统计，非目测）

| 语义令牌 | 取值 | 取样来源（主色计数） |
| --- | --- | --- |
| `--w-nav-bg` | `#102E3E` | 侧栏底 ×5312 |
| `--w-nav-surface` | `#1F3E50` | 仓库选择卡 ×4642 |
| `--w-nav-item-active-bg` | `#1E4956` | 选中项 / 计数徽标 ×640 |
| `--w-nav-fg` | `#FFFFFF` | 选中项文字 |
| `--w-nav-fg-muted` | `#B9CDD5` | 未选中项 / 分组标签 ×563 |
| `--w-primary` | `#087C75` | 主按钮 ×1062 |
| `--w-primary-hover` | `#0A6E68` | 标志/深色态 ×43 |
| `--w-brand-mark` | `#6ED2C0` | 侧栏 Logo 方块 |
| `--w-color-bg` | `#F7F9F9` | 页面底 |
| `--w-color-surface` | `#FFFFFF` | 卡片 |
| `--w-color-surface-alt` | `#FAFBFB` | 表头 / 内嵌区 |
| `--w-color-outline` | `#DBE3E6` | 输入框描边 |
| `--w-color-on-surface` | `#173344` | 标题 / KPI 数值 |
| `--w-color-on-surface-variant` | `#84949C` | 次要文字 / 占位符 |
| `--w-state-success-fill/-text` | `#DFF3EF` / `#126961` | "正常"芯片 ×109 / ×19 |
| `--w-state-warning-fill/-text` | `#FFF0D8` / `#B8690B` | "待补货"芯片 ×138 / ×26 |
| `--w-state-danger-fill/-text` | `#FBE7E8` / `#B23A42` | "低库存"芯片 ×147 / ×17 |
| `--w-state-info-fill/-text` | `#FFF7E9` / `#845817` | 详情页提示框 ×4748 / ×144 |

纪律不变：业务代码**禁止 hex 与字面量尺寸**；`theme.json` 是唯一出处，`gen:tokens` 生成三份产物（`tokens.css` / `tokens.ts` / `naiveTheme.ts`），`check:tokens` 校验一致。

### 6.2 排版与密度（"干净"的落地规则）

- 字号只留 6 档：页面标题 20/1.4、区块标题 14/600、卡片标题 14/600、正文 14/1.6、次要 12/1.5、机器数据 13 等宽 `tabular-nums`；
- **不跳档强调**，用字重 + 颜色；
- 圆角只两种：卡片 12、控件 8（Naive `common.borderRadius` 统一注入）；
- 描边 1px `#DBE3E6`，**不用阴影表达层级**（阴影只给浮层：Modal / Drawer / Popover）；
- 卡片不嵌套；一屏内不出现两种列表行高；
- 动效只 150ms/200ms，只过渡 opacity 与 background-color，尊重 `prefers-reduced-motion`；
- 触控目标 ≥48px：Naive 默认 `heightMedium=34px` 太小 → 在 themeOverrides 里把 `common.heightLarge=48`、`heightMedium=40`，触摸场景（手机壳 + 桌面表格行操作）统一用 `size="large"` 或显式高度令牌。

### 6.3 Naive UI 接入方式（D5 的落地细节）

| 项 | 做法 |
| --- | --- |
| 主题注入 | 单点 `<NConfigProvider :theme-overrides="overrides">`，`overrides` 来自 `@wise/tokens/generated/naiveTheme`；**任何组件内不得再写颜色** |
| 暗色 | **不启用** `darkTheme`；保留切换位 |
| 覆盖范围（必须全覆盖，否则会漏出 Naive 默认色） | `common`（primary / borderRadius / 字体 / 三档高度）、`Menu`、`Layout`、`Card`、`DataTable`（表头底、行底、hover 底、边框、选中行）、`Button`、`Input` / `Select` / `DatePicker`、`Tag`、`Tabs`（下划线用 primary）、`Dialog` / `Drawer`（圆角与遮罩）、`Pagination`、`Form` / `FormItem`（label 色与必填星号）、`Skeleton` / `Empty` / `Result`、`Timeline`、`Descriptions`、`Badge`、`Tooltip` / `Popover` |
| **`*Inverted` 键（Spike A 实测新增）** | `NLayoutSider inverted` / `NMenu inverted` **绕过普通主题键**，用一组独立默认值（实测 sider `--n-color: rgb(0,20,40)`、菜单项字 `#BBB`、分组标签 `#AAA`）。深青侧栏必须写 `Layout.siderColorInverted` / `colorInverted` 与 `Menu.itemTextColorInverted` / `itemColorActiveInverted` / `groupTextColorInverted` … 否则**覆盖了也不生效** |
| 引入方式 | **显式按需 import**（不用 `unplugin-vue-components` 自动导入），便于 `manualChunks` 与体积核算 |
| **路由级懒加载（硬要求）** | Spike C 实测：列表页 + 双壳 = **217KB gzip**（预算 250KB）。首屏**不得**含 `NDataTable` / `NDatePicker`；每个域路由 `() => import()`，单路由 chunk ≤130KB gzip |
| 服务式 API | `useMessage` / `useDialog` 由 `NMessageProvider` / `NDialogProvider` 提供；确认框的"焦点圈闭 / Esc / 关闭后恢复焦点"列为**验收项**，不假设库自动满足 |
| SSR（渲染门禁） | `@vue/server-renderer` + `@css-render/vue3-ssr` 的 **`setup(app)`（单个 app，不是数组）**，走 `vite build --ssr` 再执行产物（Spike A 已验证可行）。注意：**令牌值内联在元素 `style` 上的 `--n-*` 变量里，不在 collect() 的静态 CSS 里**，门禁要两边都查 |
| 图标 | 自绘 SVG 单色图标集（`@wise/ui/icons`），不引 `@vicons` |

**Naive 组件 → 我们的包装件映射**

| Naive | `@wise/ui` 包装 | 加什么 |
| --- | --- | --- |
| `NButton` / `NIcon` | `WButton` / `WIconButton` | 主/次/危险/幽灵四型、`aria-label` 必填、48px 触摸档 |
| `NInput` / `NInputNumber` / `NSelect` / `NDatePicker` / `NSwitch` / `NCheckbox` / `NRadioGroup` | `WField` 系列 | 标签在上、必填星号、错误行、`inputmode` |
| `NForm` / `NFormItem` | `WForm` / `WFormRow` | 两栏分组（桌面）、单列（手机）、提交摘要槽 |
| `NDataTable` | `DataTable` | 虚拟滚动、行高令牌、等宽列渲染、行点击/选中、密度档 |
| `NMenu` (+ `inverted`) | 侧栏配方 | 分组标签、计数徽标、选中态 |
| `NTag` | `StatusChip` | **只用** `--w-state-*-fill/-text` 组合（禁止 fill 当文字色） |
| `NDialog` / `NDrawer` | `ConfirmActionDialog` | 危险操作二次确认、提交中禁用 |
| `NSkeleton` / `NEmpty` / `NResult` | `SkeletonList` / `SkeletonCard` / `EmptyState` / `ErrorState` | 统一四态；错误态 = 2px 红条 + **等宽错误码** + 人话 + 重试 |
| `NCard` | `WCard` / `Section` | 圆角 12、内边距 16、1px 描边、**不嵌套** |
| `NTabs` | `WTabStrip` | 域内分段切换（手机改显式分段控件，不做横向滚动） |
| `NPagination` | `PaginationBar` | 桌面页码 / 手机"加载更多" |
| `NTimeline` / `NDescriptions` | `OperationTimeline` / `KeyValuePanel` | 值等宽对齐 |

业务件（不属 Naive）：`StateHost`、`ResponsiveDataView`（**同一份数据 + 同一份列定义**：桌面出 `DataTable`，手机出 `DataCardList`）、`MasterDetailWorkspace`、`FilterBar`、`MetricGrid`（只渲染真实 KPI）、`AsyncEntityPicker`、`ScanEntry`、`ActionDock`、`StatusBanner`。

### 6.4 组件预览页

`pnpm dev` → `/preview`：全部包装件 × 三档密度 × 四态 × 亮色；每个组件带 axe 用例。**设计系统先于业务屏验收**，避免 25 屏各写一套。

---

## 7. 桌面端布局（对齐参考图）

### 7.1 断点

| 档 | 宽度 | 布局 |
| --- | --- | --- |
| Compact | < 600 | 走手机壳 |
| Medium | 600–1023 | 侧栏收 64px 图标栏；详情用右侧抽屉 |
| **Desktop** | 1024–1439 | 侧栏 232 + 内容（限宽 1120 居中） |
| **Wide** | ≥ 1440 | 侧栏 232 + 主列 1040 + **右侧详情列 400**（参考图形态） |

### 7.2 骨架（就是参考图的结构）

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ CommandBar 56  [面包屑 域/页]        [🔍 搜索物料、批次或库位]   [● Bridge · 正常 · 18ms]│
├────────────┬──────────────────────────────────────────────────────────────────┤
│ Sidebar    │ PageHeader  页标题 20/600        [最后同步 时间 · 数据来源]  [+ 主操作] │
│ 232        ├──────────────────────────────────────────────────────────────────┤
│ ▣ 慧仓智控  │ MetricGrid  ┌────────┐┌────────┐┌────────┐┌────────┐               │
│  WISEDEPOT │             │ 真实KPI││ 真实KPI││ 真实KPI││ 真实KPI│               │
│            │             └────────┘└────────┘└────────┘└────────┘               │
│ ┌仓库选择卡┐│ ┌────────────────────────────────────┐ ┌─────────────────────────┐ │
│ │当前仓库 ▾││ │ Card: 区块标题        [全部|筛选A|筛选B] │ │ Card: 详情标题        ⋯ │ │
│ └──────────┘│ │ FilterBar [类目▾][库区▾][状态▾][时间▾]  │ │ 概要（等宽值）           │ │
│ 运营        │ │ DataTable  主标识|库位|数量|状态|时间   │ │ 明细 KeyValuePanel      │ │
│  工作台     │ │  …（虚拟滚动，行高按密度档）           │ │ 提示条（真实规则文案）    │ │
│  库存中心 6 │ │                                        │ │ [次要动作] [主操作]      │ │
│  出入库单   │ ├────────────────────────────────────────┤ │                         │ │
│  巡检任务   │ │ PaginationBar  共 N 条 · 第 x/y 页      │ │                         │ │
│ 现场        │ └────────────────────────────────────────┘ └─────────────────────────┘ │
│  设备管理 3 │                                                                    │
│ 管理        │                                                                    │
│  系统设置   │                                                                    │
│ ┌用户卡────┐│                                                                    │
│ │陈主管 角色││                                                                    │
│ └──────────┘│                                                                    │
└────────────┴──────────────────────────────────────────────────────────────────┘
```

**结构要点**

1. 面包屑 + 搜索 + Bridge 状态在**顶栏一处**，页内不再重复标题；
2. 侧栏是**深青 `#102E3E`**，分组标签（运营/现场/管理）只做视觉分组，**可点项必须来自真实 IA**；
3. 内容区白卡在 `#F7F9F9` 底上，卡片 12 圆角 + 1px 描边；
4. 主操作（如"新建入库单"）在页头右侧，**不进导航**；
5. Wide 档右侧详情列：点行 → 详情同屏，不跳页（避免"看一眼详情就丢了列表"）；
6. 批量模式出现时页头换成批量工具栏（选中 N 项 / 全选 / 批量绑定 / 批量解绑 / 取消）。

### 7.3 页面范式

| 范式 | 屏 | 结构 |
| --- | --- | --- |
| 看板 | 概览 | MetricGrid（真实 KPI）+ 当前任务 + 未处理告警 |
| 工作台 | 告警中心 | 左列表（状态筛选）+ 右详情（日志 / 确认 / 状态处理 / 忽略原因） |
| 主从 | 全部列表屏 | FilterBar + DataTable + 右侧 DetailPanel + PaginationBar |
| 表单 | 新建/录入/补录/用户/资料/密码 | 两栏分组 + 提交摘要；**提交入口不随滚动** |
| 批量 | 标签 | 表格选择模式 + 批量工具栏 |

### 7.4 键盘

`⌘/Ctrl+K` 命令面板 · `/` 聚焦搜索 · `Esc` 关弹层或退批量 · `↑↓` 列表移动 · `Enter` 打开 · `Space` 选中 · `⌘/Ctrl+Enter` 提交。

### 7.5 ⚠️ 参考图的诚实边界（**硬规则**）

参考图是**视觉样稿**，其数据与导航**多数没有真实 DTO 支撑**。按已拍板约束"视觉样稿只定义布局/层级/色彩/交互，不自动增加业务能力"，逐条处置如下：

| 参考图元素 | 处置 | 依据 |
| --- | --- | --- |
| 侧栏"盘点任务""车辆管理""基础设置" | **不新增**；分别用真实目的地替换（见下表映射） | `DOMAINS` 只有四域 |
| "库存品类 1,284 · 较昨日 +18 个品类" | 数值用真实 KPI；**"较昨日 +18"删除**（无历史数据链路） | `dashboard.summary` 无同比字段 |
| "库存预警 18 · 其中 6 项需要补货" | 有真实字段则渲染，无则只渲染单一数值 | DTO 为准 |
| "待处理异常 6 · 2 项已超过 24 小时" | 同上；"超过 24 小时"需真实时间字段 | DTO 为准 |
| "安全库存 180 件" | 仅在 DTO 提供时渲染 | 无字段则不显示该行 |
| "预计 4 天后低于最低库存，建议补货 200 件" | **不做**（推算值，无链路） | 禁止虚构预测 |
| "查看流水""创建补单" | 换成真实动作（如锁定/解锁、新建单据） | 只有契约里存在且已验证的方法才接线 |
| "全部类目 / 库区 / 状态 / 更新时间"筛选 | 保留**客户端筛选**；标注"筛选本页"，除非方法支持服务端筛选 | 旧设计稿 §逐页布局规则 |
| 侧栏计数徽标（库存中心 6 / 设备巡检 3） | **仅在有真实计数 DTO 时渲染**，否则不画 | "假数据比空栏更糟"（W4 已付过学费） |
| 顶栏"18ms" | 连接状态可显示，但**延迟数字只在真实测量存在时**显示 | 旧设计稿明确要求 |

**参考图导航 → 真实 IA 映射**

| 参考图 | 真实目的地（`DOMAINS` 叶子） |
| --- | --- |
| 工作台 | 概览 › 看板（默认首屏） |
| —（新增位置） | 概览 › 告警中心 |
| 库存中心 | 库存 › 库存查询 |
| 出入库单 | 库存 › 出入库单 |
| 盘点任务 | 现场 › 巡检任务 |
| 设备巡检 / 车辆管理 | 现场 › 设备管理 |
| —（新增位置） | 库存 › 商品管理 / 标签管理 / 仓库管理；我的 › 消息 / 用户管理 / 个人设置 |
| 基础设置 | 我的 › 个人设置 + 用户管理 |

> 侧栏分组改名：**运营 / 库存 / 现场 / 管理**（管理 = 我的域），保留四域语义不新增目的地。

---

## 8. 手机端布局（白色简约同源）

### 8.1 骨架

```
┌─────────────────────────────┐
│ ContextHeader 56 + 安全区    │  白底 · 深青字 · 返回 / 标题 / 扫码(能力存在时) / 桥状态点
├─────────────────────────────┤
│ [域内分段控件]（叶子 >1 时） │  48，等高可点（**不横滚**）
├─────────────────────────────┤
│ 内容                         │  DataCardList / 表单 / 详情纵向信息组
│ （扫码结果卡：顶部浮层）      │  仅 scan.camera / scan.gun.* 存在时
├─────────────────────────────┤
│ ActionDock 56（主操作 ≤2）   │  sticky 在底栏之上，避让安全区与输入法
├─────────────────────────────┤
│ TabBar 56 + 安全区  4 项     │  概览 / 库存 / 现场 / 我的
└─────────────────────────────┘
```

**手机端用白底而非深青大块**（与桌面侧栏不同）：现场强光下大面积深色面板与环境的对比反而下降，且深色面板在户外更易反光刺眼 —— 沿用已拍板的"现场光线下看屏幕 → 高对比、少装饰"。深青只保留在两个地方：登录页品牌区、以及选中态/强调色。

### 8.2 遮挡修复（当前真实缺陷）

`findings.md` 已确认 `BottomActionBar` 全局 `fixed` 会遮挡手机底栏、并跨到桌面侧栏。Vue 版一次性修掉：

```css
.w-actiondock { position: sticky; bottom: calc(var(--w-tabbar-h) + env(safe-area-inset-bottom)); }
@media (min-width: 600px) { .w-actiondock { position: static; } }   /* 桌面进页头 */
```

输入法：监听 `visualViewport.resize` 写 `--w-vh`，动作坞与提交按钮跟随上移，**不遮输入框**。

### 8.3 页面范式

| 范式 | 屏 | 结构 |
| --- | --- | --- |
| 卡片列表 | 全部列表屏 | 主标识(等宽) / 主文案 / 次要信息 / 状态芯片；单列；点行压栈 |
| 详情压栈 | 详情屏 | 纵向信息组 + 底部动作坞 |
| 单任务表单 | 新建/录入/补录/资料 | 按任务顺序；数字字段 `inputmode`；提交固定动作坞 |
| 连续扫码录入 | 手动补录 | 页面内消费扫码事件，**不触发全局跳转** |
| 批量选择 | 标签 | 必须按钮显式进入选择模式（长按与滚动冲突） |

### 8.4 域内页面导航

叶子 > 1 时用分段控件；超过 4 项渲染"页面入口列表"（行高 56 + 图标 + 最近使用排序），**不做横向滚动 TabStrip**。

### 8.5 扫码路由（唯一出处 `useScanStore`）

```
扫码事件 → ① 有输入焦点？→ 填入该输入框
        → ② 当前屏注册了消费者？→ 交给屏（连续录入）
        → ③ 兜底 → 跳 tag.byCode（保留原 SCAN_TARGET_METHOD 语义）
```

相机入口只在 `bridge.supports('scan.camera')` 为真时出现；键盘扫码枪监听只在 `scan.gun.keyboard` 为真时挂；扫到结果在顶部弹**结果卡**（条码 → 商品/库存摘要，数据来自 `tag.byCode`），可下拉收起 —— 这是 `.kiro/specs/dynamic-island-barcode-scanner` 的 Web 侧落点，**不新增业务能力**。

---

## 9. 逐屏迁移矩阵（25 屏）

| # | 屏 | 主要桥方法 | 桌面形态 | 手机形态 | store |
| --- | --- | --- | --- | --- | --- |
| 1 | 登录 | `auth.login` `captcha.generate` | 白底居中卡 420 + 深青品牌区 | 全屏表单 + 数字键盘 | session |
| 2 | 看板 | `dashboard.summary` | MetricGrid + 当前任务 + 未处理告警 | 2×2 KPI + 列表 | overview |
| 3 | 告警中心 | `alert.list` | 工作台（左列表 + 右详情） | 卡片列表 → 压栈 | overview |
| 4 | 告警详情 | `alert.detail` | 右列（概要/日志/动作） | 详情压栈 + 动作坞 | overview |
| 5 | 库存查询 | `inventory.list` `inventory.search` | 主从（表格 + 详情列） | 卡片列表 → 压栈 | inventory |
| 6 | 库存详情 | `inventory.detail` | 详情列 + 锁定/解锁 | 纵向信息组 + 动作坞 | inventory |
| 7 | 商品管理 | `product.list` | 表格 + 新建抽屉 | 卡片列表 + 新建 | inventory |
| 8 | 仓库管理 | `warehouse.list` | 表格 + 新建抽屉 | 卡片列表 + 新建 | inventory |
| 9 | 标签管理 | `tag.list` | 表格 + 批量模式 | 卡片列表 + 选择模式 | inventory |
| 10 | 标签详情 | `tag.detail` `tag.byCode` | 详情列（扫码落点） | 详情压栈（扫码落点） | inventory |
| 11 | 出入库单 | `stockOrder.list` | 表格（状态筛选） | 卡片列表 | inventory |
| 12 | 新建单据 | `stockOrder.create` | 两栏表单 + 提交摘要 | 单任务表单 + 动作坞 | inventory |
| 13 | 单据详情 | `stockOrder.detail` | 详情列 + 提交/撤回/审核 | 详情压栈 + 动作坞 | inventory |
| 14 | 设备管理 | `device.list` | 统计条 + 表格 | 统计条 + 卡片列表 | field |
| 15 | 设备详情 | `device.detail` | 详情列（参数**只读**） | 纵向信息组（不用滑块暗示可调） | field |
| 16 | 巡检任务 | `inspection.taskPage` `taskList` | 表格（分页） | 卡片列表（加载更多） | field |
| 17 | 巡检任务详情 | `inspection.taskDetail` `taskStatus` `taskDiff` | 详情列 + 开始/保存进度/结束 | 详情压栈 + 动作坞 | field |
| 18 | 新建巡检 | `inspection.taskCreate` | 两栏表单 | 单任务表单 | field |
| 19 | 巡检结果 | `inspection.resultList` `resultDetail` `resultConfirm` | 表格 + 确认弹窗 | 卡片列表 + 确认 | field |
| 20 | 录入结果 | `inspection.resultCreate` | 分组表单 | 单任务表单 | field |
| 21 | 手动补录 | `inspection.manualRecord` | 多行 NFC 表格 + 连续扫码 | 连续扫码录入（不全局跳转） | field + scan |
| 22 | 消息 | `message.list` `unreadCount` | 列表 + 未读筛选 + 批量已读/清空 | 卡片列表 + 按钮 | me |
| 23 | 消息详情 | `message.detail` | 右列正文 + 标记已读 | 详情压栈 | me |
| 24 | 用户管理 | `user.list` `user.detail` | 表格 + 新建/重置密码/验证码删除 | 卡片列表 + 步骤表单 | me |
| 25 | 个人设置 | `profile.get` `profile.settings` | 两栏（资料/偏好/改密） | 纵向分组 + 动作坞 | me |

**不新增一屏、不新增一个业务字段**：列定义与卡片字段一律取自现有 DTO。

---

## 10. 门禁对应表（`tools/check/*`）

| 旧门禁 | 处置 | Vue 版实现 | 断言 |
| --- | --- | --- | --- |
| `check:contract` / `:legacy` | **保留** | 不变 | 生成物与控制器一致 |
| `check:parity` | **改路径** | 扫 `packages/views` | 25 屏 ↔ 方法对照 |
| `check:tokens` | **改语义** | 三份生成物 ↔ `theme.json`（含 `naiveTheme.ts`） | 令牌无漂移 |
| `check:css` | **扩展** | `.css/.scss/.vue`（含 `<style>` 块） | 0 hex、0 字面量尺寸 |
| — | **新增 `check:naive`** | 扫 `.vue` + `themeOverrides` + SSR/Preview 产出 | ① `themeOverrides` 内无字面量颜色 ② 覆盖键白名单（§6.3，含 `*Inverted`）③ **Naive 默认色（`#18a058`/`#36ad6a`/`#0c7a43`/`#f0a020`/`#d03050`）在产出里出现 0 次**（Spike A 实测：只覆盖 primary 会漏 40 处） |
| `check:ui` | **改写** | 扫 `.vue` 模板 + `<script setup>` | 0 方法 id 泄漏、0 开发黑话、0 内联取值 |
| `check:render` | **改写** | `@vue/server-renderer` 渲染两壳 + 全路由 | 结构断言 + 目的地全可达 |
| `check:navigation` | **改写** | 路由表 ⊆ `DOMAINS ∪ DESTINATIONS` | 拼错/漏迁 CI 期暴露 |
| `check:state` / `:scan` / `:stockorder` | **改写** | Vitest + `@vue/test-utils` | 四态流转 / 扫码三分支 / 单据状态机 |
| `check:transport` / `:timeout-budget` / `:session` / `:refetch` | **保留** | 不动（针对 `bridge-client`） | 传输语义不回归 |
| — | **新增 `check:store`** | AST 扫描 | 组件内无裸 `bridge.call`；`ui` 不 import `bridge/stores` |
| — | **新增 `check:no-react`** | 依赖 + 文件扫描 | 0 `react`/`react-dom`/`.tsx` |
| — | **新增 `check:budget`** | 读 `dist` | ① 登录/首屏路由 **≤150KB gzip**（Spike C 实测 88.8KB）② 任一懒加载路由 chunk **≤130KB gzip**（列表页实测增量 115.9KB）③ 首屏 chunk 内**不含** `NDataTable` / `NDatePicker` |
| — | **新增 `check:a11y`** | axe-core（Playwright 侧） | 严重无障碍问题 = 0 |
| `typecheck` | **改工具** | `vue-tsc --noEmit` | 严格档全过 |

---

## 11. 分阶段实施计划

| 阶段 | 内容 | 交付物 | 预估 |
| --- | --- | --- | --- |
| **V0 冻结基线** | React 版打 tag `archive/react-web-final`；记录 25 屏截图、34 条接线、体积、门禁绿基线；**先把 phase-1 的 `bridge/*` 改动提交完** | 基线证据 + tag | 1 |
| **V1 内核脚手架** | Vue/Vite/Router/Pinia/vue-tsc/Vitest 接入；`@wise/bridge-vue`（plugin/useBridge/useBridgeState/useResource/useMutation）；启动状态机 + 登录屏 + 会话门；`base:'./'` + hash 路由 + `manualChunks` | 两端能起来并真登录 | 3–5 |
| **V2 设计系统** | `theme.json`（§6.1 取色）+ 三份生成物 + Naive `themeOverrides` 全覆盖；`@wise/ui` 包装件（约 20）+ 业务件（12）；`/preview` 预览页；`check:css`/`check:tokens`/`check:naive`/`check:ui` 改造 | 预览页三档密度 + 四态全绿 | 5–7 |
| **V3 双壳与导航** | 路由表 + `useNavStore`（跨断点不丢状态）+ 返回栈（Android 物理返回键 / Electron 快捷键）；`DesktopShell`（CommandBar + 深青侧栏 + 状态栏）+ `MobileShell`（ContextHeader + 分段控件 + ActionDock + TabBar）；`useScanStore` 三分支 + 扫码结果卡 | `check:navigation` / `check:render` 全绿 | 5–7 |
| **V4 逐域迁移** | a 概览 4–6 · b 库存 7–9 · c 现场 8–11 · d 我的 5–7（逐域运行时开关默认关；桥调用与 mutation 逐条对照移植） | 每域：单测 + 双视口走查 + 真后端冒烟 | 24–33 |
| **V5 宿主接线** | Electron `webAssets` 指向新 dist；Android asset 同步与 `WebViewAssetLoader` 验证（**均不改桥托管逻辑**） | 两端 launch → 真登录 → 真数据 → 断连恢复 | 3–4 |
| **V6 门禁/出包** | 全套 `check:*` + 新增 4 条；Playwright 视口矩阵（320/360/390/412/599/600/839/840/1024/1280/1440）；体积/内存/帧时间；Windows `win-unpacked`/NSIS + Android APK/lint；删除 React 依赖与旧包 | 产物 + CI 记录 | 6–8 |

**合计 ≈ 47–65 人日**（选 Naive UI 相比 v1 自建 Kit 省约 3–5 人日，转投到 themeOverrides 全覆盖与密度适配）。

---

## 12. 验收标准（DoD）

| # | 标准 | 测量 |
| --- | --- | --- |
| 1 | 25 屏两端可达可用，**不新增屏、不新增业务字段/动作** | 逐屏走查 + `check:parity` |
| 2 | 桥协议、帧字段、错误码、`__bridge.json`、会话事件**零改动** | `check:contract` / `:legacy` 绿 |
| 3 | `bridge/*`、`apps/desktop`、`apps/mobile` diff **只有资源路径接线** | `git diff --stat` 评审 |
| 4 | 视觉与 §6.1 取色一致；**0 处 Naive 默认蓝/默认灰泄漏** | `check:naive` + 双视口截图比对 |
| 5 | 桌面：主从/表格/键盘全可达/三档密度；手机：任务流/动作坞不遮底栏与输入法/扫码三分支正确 | Playwright + 真机 |
| 6 | 断点切换与宿主重连**不丢**筛选/页码/返回栈 | 行为测试（旧设计稿第 9/10 条） |
| 7 | 四态互斥穷尽，任一取数容器都能画出加载/空/错/内容 | `check:render` 结构断言 |
| 8 | 触控目标 ≥48px、正文对比度 ≥4.5:1、焦点圈闭、Esc 生效、关闭后焦点恢复 | axe-core 严重问题 = 0 |
| 9 | 体积：① 登录/首屏路由 ≤150KB gzip ② 单路由 chunk ≤130KB gzip ③ 首屏不含 DataTable/DatePicker；TTI 桌面 ≤1.2s / 中端安卓 ≤2.5s | `check:budget`（Spike C 已给出基线）+ 真机 |
| 10 | 全门禁绿；Windows 与 Android 产物来自 fresh build | CI 记录 |

---

## 13. 不做（Out of scope）

- ❌ 不改桥/协议/后端/宿主进程模型与生命周期；
- ❌ **不实现参考图里没有数据链路的内容**：较昨日同比、预测补货、安全库存（无字段时）、盘点任务/车辆管理/基础设置等新导航项、虚构延迟数字；
- ❌ 不做趋势图 / 热力图 / 3D 仓库 / 设备遥控 / 轨迹地图 / 实时视频 / 环境传感器 / 库存直接改数；
- ❌ 不做二期候选接线（商品与仓库编辑、单标签绑定解绑、单据更新与明细增删、巡检计划 CRUD/PDF、用户编辑与角色授予、头像上传、报表、设备 CRUD、库存与告警统计）；
- ❌ 不做暗色主题、iOS、PWA、SSR/Nuxt、微前端；
- ❌ 不删除 Plain WebSocket transport、现场诊断脚本、`EventSink`、MockTransport、能力 id。

---

## 14. 风险与对策

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| R1 | **Naive 主题覆盖不全** → 默认色漏到界面，视觉"干净"破功 | 高 | **已量化**（Spike A）：只覆盖 primary 会漏 **40 处**（`#18a058`×5、`#36ad6a`×10、`#0c7a43`×6、`#f0a020`×9、`#d03050`×10）；全覆盖 + `*Inverted` 键后 **0 处**。对策：`check:naive` 白名单 + 产出默认色 0 次 + `/preview` 每组件有实例 |
| R2 | **体积**：Spike C 实测"列表页 + 双壳 = 217KB gzip / 预算 250KB"，且未含 Timeline/Descriptions/Skeleton/Dialog/Upload/Tabs | **高** | 对策：① 首屏禁含 DataTable/DatePicker ② 全部域路由 `() => import()` 懒加载 ③ `check:budget` 按"首屏 ≤150KB / 单路由 ≤130KB"卡 ④ 日期筛选优先用预设区间（近 7/30 天）以避免 date-fns ⑤ 若仍超，`NDataTable` 换 `@tanstack/vue-virtual` + 自绘表格（列定义不变） |
| R3 | Naive 默认控件高度 34px，**低于 48px 触控要求** | 中 | 已实测可解：`common.heightLarge` 注入 `48px` 后产出 `--n-height:48px`（Spike A 验证）；手机壳与表格行操作强制 `size="large"` |
| R4 | `NDataTable` 虚拟滚动表现 | 中 | **已关闭**（Spike B）：1000 行只渲染 **22 个 tr**，挂载 20.6ms，滚动帧 p50/p95 = 16.7/16.8ms，>20ms 帧 **0/120**。残留：行高实测 **49px**（48+1px 边框），密度令牌按"含边框 48"实现 |
| R5 | Naive SSR（渲染门禁）样式收集 | 中 | **已关闭**（Spike A）：`vite build --ssr` + `setup(app)` 可收集 106.7KB 样式。注意令牌在**内联 style** 上，门禁要 html+css 两边查 |
| R6 | 与进行中的 `bridge/*` phase-1 改动冲突 | 高 | V0 先提交完 phase-1；Vue 只碰 Web 层；评审以 `git diff --stat` 卡 |
| R7 | 迁移期新旧双栈漂移 | 中 | `tokens`/`contract`/`bridge-client` 三个包**新旧共用**，不做第二份 |
| R8 | Android WebView（API 25）内核兼容 | 中 | target 保持 `es2022`；真机（API 25/34）走查为 V6 门禁 |
| R9 | 操作员在迁移期看到半成品 | 低 | 逐域开关默认关；未迁移目的地用**业务语言**"功能上线中"占位（不留方法 id） |
| R10 | 参考图被当作需求清单 | 中 | §7.5 的映射表 + 复核清单进 V4 每域评审（每条字段都能追到 DTO） |

---

## 15. 回滚

| 层级 | 手段 |
| --- | --- |
| 整体 | tag `archive/react-web-final` → checkout 回 React 版（桥与宿主未动，无副作用） |
| 单域 | V4 每域运行时开关翻回关（仅迁移期有效） |
| 视觉 | `theme.json` 是唯一出处；改色/改密度 = 改一个文件 + `pnpm gen:tokens` |
| 宿主接线 | V5 只改资源路径常量，单提交 revert |

无数据迁移、无接口版本变更、无凭据格式变更。

---

## 附：与 v1 / 旧设计稿的差异摘要

| 项 | v1 / 旧稿 | 本稿（v2 定稿） |
| --- | --- | --- |
| 组件库 | 自建轻量 Kit | **Naive UI + themeOverrides 令牌桥**，业务层再包一层 |
| 视觉 | 工业运营台（沿用旧 Compose 色板） | **白色简约运营台**，色值来自参考图逐像素取样（§6.1） |
| 桌面结构 | 单列限宽居中，主从待定 | **对齐参考图**：顶栏搜索+Bridge 状态 / 深青分组侧栏 / KPI 四联 / 主卡+右侧详情列（Wide 档） |
| 手机主色 | 深色壳 | **白底**（现场可读性），深青仅用于品牌区与强调 |
| 参考图数据 | — | **§7.5 逐条映射与删除清单**（禁止把样稿当需求） |
| 门禁 | 15 条（TSX/React SSR） | 重写 8 条 + 新增 **5** 条（`check:naive` / `store` / `no-react` / `budget` / `a11y`） |
| 工期 | 53–73 人日 | **47–65 人日** |
