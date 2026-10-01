# V0 / V1 可执行任务清单 —— Vue 3 重写

> 上游设计：[2026-10-02-vue3-dual-shell-rewrite-design.md](../specs/2026-10-02-vue3-dual-shell-rewrite-design.md)（v2 定稿）
> 范围：**只做 V0 冻结基线与 V1 内核脚手架**。V2 起的任务本文件不预写（避免过早细化）。
> 工作目录：`WiseDepotClient/`。所有命令在该目录下执行（PowerShell）。
> 硬边界：不改 `bridge/*` 的协议与行为、不改宿主进程模型；`apps/desktop`、`apps/mobile` 只允许改资源路径接线（V5 才做，V0/V1 一律不碰）。

---

## V0 冻结与基线

### Task V0-1 — 提交进行中的 phase-1 改动（前置条件，不属本次重写）

**为什么排第一**：工作区里**有两批**未提交改动，都不属本次重写，但都必须先落地：

| 批 | 涉及 | 处置 |
| --- | --- | --- |
| phase-1（桥安全修复） | `bridge/**`、`apps/desktop/src/**`、`apps/mobile/shell/**`、`packages/bridge-client/src/**` | 跑传输/会话门禁后提交 |
| 工业运营台 UI（**2026-10-01 那份计划**） | `packages/{features,patterns,shells}/**`、`tools/check/check-navigation.mjs`、`tools/check/shell-render-entry.tsx`、新增 `packages/shells/src/navigationState.tsx` | **先提交或 stash**：这批改的正是 Vue 重写要整体替换掉的 UI 层，留着会与 V4 迁移搅在一起 |

> 更正（2026-10-02）：设计稿 v1/v2 里写的"未提交改动只在 `bridge/*`"是**只看 `git status` 前 15 行得出的错误结论**。实际情况见上表。

- [ ] **Step 1** 确认改动范围与内容

  ```powershell
  git status --porcelain
  git diff --stat
  ```
  期望：**只有**上表两批文件，不出现 `apps/web/src/**`（前端入口还没动）。

- [ ] **Step 2** 跑一遍与这批改动相关的门禁

  ```powershell
  pnpm check:transport; pnpm check:timeout-budget; pnpm check:session; pnpm check:refetch
  .\gradlew.bat :bridge:protocol:test ":Pwise.skipAndroid"    # 注意引号
  ```
  期望：全绿。

- [ ] **Step 3** 提交（信息按仓库中文提交风格）

  ```powershell
  # 批次一：桥 phase-1
  git add bridge apps/desktop apps/mobile packages/bridge-client
  git commit -m "bridge phase-1：会话/传输/宿主安全修复落地"

  # 批次二：工业运营台 UI（若决定保留其成果）
  git add packages/features packages/patterns packages/shells tools/check
  git commit -m "工业运营台 UI：双壳导航与视觉令牌落地"
  ```
  若批次二直接作废（Vue 会整体重写 UI 层），改成 `git stash -u` 并记录 stash 名。

> 若 Step 2 有红：**停在这里**，V0 后续步骤与整个 V1 都不要开始。

---

### Task V0-2 — 冻结 React 版并打回滚 tag

- [ ] **Step 1** 记录基线证据到 `docs/superpowers/plans/2026-10-02-v0-baseline.md`

  需包含（每条都要有命令与输出）：
  ```powershell
  pnpm check            # 15 条门禁
  pnpm typecheck
  pnpm build            # 记录首屏 JS gzip 体积
  git rev-parse HEAD
  ```
  另需人工记录：25 屏截图（`apps/web/dist` 起 `pnpm dev` 后逐屏截）与 `packages/features/src/registry.tsx` 的 34 条接线方法清单。

- [ ] **Step 2** 打 tag

  ```powershell
  git tag -a archive/react-web-final -m "React 19 版 Web 层最终状态（Vue 重写回滚点）"
  git push origin archive/react-web-final
  ```

- [ ] **Step 3** 建工作分支

  ```powershell
  git switch -c feat/vue3-rewrite
  ```

**V0 完成判定**：`git status` 干净；tag 存在；基线文档有 4 条命令的真实输出。

---

## V1 内核脚手架

**目标**：两端能起来 → 真登录 → 进空壳。**不写任何业务屏**（业务屏是 V4）。

### Task V1-1 — 依赖与构建配置

**Files**：`apps/web/package.json`、`apps/web/vite.config.ts`、`apps/web/tsconfig.json`、`apps/web/index.html`

- [ ] **Step 1** 安装依赖（已在本轮提前执行，核对版本即可）

  ```powershell
  pnpm --filter @wise/web add vue vue-router pinia naive-ui
  pnpm --filter @wise/web add -D @vitejs/plugin-vue vue-tsc @vue/server-renderer @css-render/vue3-ssr
  pnpm --filter @wise/web list --depth 0
  ```
  期望：`vue` ≥3.5、`pinia` ≥2.2、`vue-router` ≥4.4、`naive-ui` ≥2.40、`vue-tsc` 可执行。

- [ ] **Step 2** `vite.config.ts` 同时挂两个插件（React 与 Vue 在 V1 共存，V6 才摘 React）

  要点：
  - `base: './'` **不变**；
  - **路由级懒加载是硬要求**（Spike C 实测：列表页 + 双壳 = 217KB gzip / 预算 250KB），每个域路由 `() => import()`；
  - `manualChunks`：`vendor-vue`（vue/vue-router/pinia）、`vendor-naive`（naive-ui/**）；`vendor-react` 保留至 V6；
  - 首屏 chunk **不得**包含 `NDataTable` / `NDatePicker`。

- [ ] **Step 3** `typecheck` 换成 `vue-tsc`

  ```jsonc
  // apps/web/package.json
  "typecheck": "vue-tsc --noEmit"
  ```
  `tsconfig.base.json` 的 `jsx: react-jsx` **暂不动**（React 文件还在，V6 再改 `preserve`）。

- [ ] **Step 4** `index.html` 的入口从 `/src/main.tsx` 改到 `/src/main.ts`

  React 的 `App.tsx` / `main.tsx` **保留在盘上**作参照，不再被引用；V6 删除。

- [ ] **Step 4** 验收（**预算按 Spike C 的新口径**）

  ```powershell
  pnpm typecheck
  pnpm build
  pnpm dev     # 浏览器打开，确认还是 React 旧界面（本步不改行为）
  ```
  期望：typecheck 0 error；build 成功；登录路由 gzip ≤150KB；任一懒加载路由 chunk ≤130KB；
  `pnpm dev` 仍渲染旧界面（第 4 步改入口后 main.ts 还不存在时会白屏，属预期）。

---

### Task V1-2 — 令牌三产物（`theme.json` → CSS / TS / Naive 主题）

**Files**：`packages/tokens/src/theme.json`（新建）、`tools/gen/gen-tokens.js`（改造）、`packages/tokens/src/generated/{tokens.css,tokens.ts,naiveTheme.ts}`（生成物）、`packages/tokens/src/index.ts`

- [ ] **Step 1** 以设计稿 §6.1 的取色表写 `theme.json`

  结构：`{ color: {...}, state: {...}, fill: {...}, nav: {...}, space: {...}, radius: {...}, motion: {...}, type: {...}, breakpoint: {...}, density: {...} }`。
  **每个值都要能追到设计稿 §6.1 的取样行**；新增值必须在设计稿里先加一行。

- [ ] **Step 2** 改造 `tools/gen/gen-tokens.js`

  同时产出三份：
  - `tokens.css`：`:root { --w-* }`（沿用现有命名）
  - `tokens.ts`：`color/space/radius/type/motion/breakpoint` 常量（沿用现有导出名，`packages/tokens/src/index.ts` 不用改 import）
  - `naiveTheme.ts`：`export const naiveThemeOverrides: GlobalThemeOverrides`，覆盖设计稿 §6.3 表格列出的 18 个组件键

- [ ] **Step 3** 改 `check:tokens` 语义

  从"与归档 Compose 主题逐值一致"改为"**生成物 ↔ `theme.json` 一致**"（`--check` 模式比对三份产物）。

- [ ] **Step 4** 验收

  ```powershell
  pnpm gen:tokens
  pnpm check:tokens
  pnpm check:css          # 仍需 0 hex / 0 字面量尺寸
  ```
  期望：三份产物生成；`check:tokens` 绿；`check:css` 绿。

> ⚠️ 本步会**改变现有界面的观感**（旧 React 界面吃同一套 CSS 变量）。这是预期的：V0 的 tag 是观感回滚点。

---

### Task V1-3 — `@wise/bridge-vue`（Vue 绑定层）

**Files**：`packages/bridge-vue/{package.json,tsconfig.json}`、`src/{index.ts,keys.ts,plugin.ts,useBridge.ts,useBridgeState.ts}`

- [ ] **Step 1** 建包，声明依赖：`vue`(peer)、`@wise/bridge-client`(workspace:*)

- [ ] **Step 2** `plugin.ts`：`createBridgePlugin({ allowMock })` —— 内部 `createBridge()`，`app.provide(BRIDGE_KEY, shallowRef<Bridge>)`，**启动失败不 resolve**（失败态由 `stores/bridge.ts` 表达）

- [ ] **Step 3** `useBridgeState.ts`：**订阅式**连接状态（替代现在读取一次性 getter）

  ```ts
  // 语义要求（来自设计稿 §4.2）
  // 1. onStateChange 订阅 → shallowRef 更新，组件卸载时取消订阅
  // 2. 单个订阅者抛异常不得阻断其他订阅者
  // 3. capabilities 以 ref 暴露，供 supports() 派生
  ```

- [ ] **Step 4** 冒烟验收（Vitest 还没引，先用 node 脚本）

  ```powershell
  node -e "import('@wise/bridge-vue').then(m=>console.log(Object.keys(m)))"
  ```
  期望：导出 `createBridgePlugin` / `useBridge` / `useBridgeState`（Node 直跑 ESM 需 tsx 或先 build，若不通过可临时用 `pnpm --filter @wise/web exec vite-node`，只要证明可 import 即可）。

---

### Task V1-4 — `@wise/stores`（Pinia，含资源层）

**Files**：`packages/stores/{package.json,tsconfig.json}`、`src/{index.ts,bridge.ts,session.ts,nav.ts,ui.ts,resource.ts}`

- [ ] **Step 1** `bridge.ts`：`kind/origin/state/capabilities/hostVersion` + `supports(cap)`

- [ ] **Step 2** `session.ts`：**判据只有 `bridge.session`**；订阅 `BRIDGE_EVENT_SESSION_EXPIRED` → reload；`loading/authenticated/username/passwordChangeRequired/expired`

- [ ] **Step 3** `resource.ts`：`createResourceStore` + `useResource(method)` + `useMutation(method)`，逐条实现设计稿 §4.2 的四条语义

  ```ts
  // 必须覆盖（每一条都对应现在 useBridgeCall 里踩过的坑）
  // 1. 结构化 BridgeError（不吞成字符串）
  // 2. onScopeDispose 后不落地
  // 3. shouldRefetchOnOpen → 每次断线最多重取一次
  // 4. enabled:false 与"本来就无参"分离
  ```

- [ ] **Step 4** `nav.ts`（当前域/叶子/推入栈/每屏 filters+page+scroll）、`ui.ts`（密度/Toast/Confirm 队列/离线横幅）

- [ ] **Step 5** 验收：写 4 个最小单测覆盖 resource 的四条语义（如"dispose 后不落地"用一个可控 deferred 断言）

---

### Task V1-5 — 启动状态机 + 登录屏 + 会话门

**Files**：`apps/web/src/{main.ts,boot.ts,App.vue}`、`apps/web/src/views/auth/LoginView.vue`、`apps/web/src/router/{routes.ts,guards.ts}`

- [ ] **Step 1** `boot.ts` 实现设计稿 §5.1 的五态：`booting / waitingHost / ready / bridgeFailed / mockDev`，失败态文案给"该怎么办"（架构细节只进 DEV 分支）

- [ ] **Step 2** `routes.ts` 只注册 `/login` + 一个占位首页；`guards.ts` 实现会话门（未登录 → `/login`；`passwordChangeRequired` → 改密页占位）

- [ ] **Step 3** `NConfigProvider` + `naiveThemeOverrides` + `NMessageProvider`/`NDialogProvider` 挂在 `App.vue` 顶层

- [ ] **Step 4** 验收：两端真登录

  ```powershell
  pnpm --filter @wise/web build
  pnpm desktop:smoke            # Electron：app://wise 起源 + 桥 ping + 登录屏
  .\gradlew.bat :apps:mobile:shell:assembleDebug ":Pwise.skipAndroid"   # 仅编译壳，真机走查留 V6
  ```
  期望：桌面能起、能读 `__bridge.json`、能真登录进占位首页；手机壳能编译出 APK。

---

### Task V1-6 — 门禁雏形（只加与 V1 相关的两条）

**Files**：`tools/check/check-no-react.mjs`、`tools/check/check-store.mjs`

- [ ] **Step 1** `check:no-react`：扫 `packages/{ui,layouts,views,stores,bridge-vue}` 与 `apps/web/src`，断言 0 处 `from 'react'` / `.tsx`（V1 阶段 `apps/web/src` 还有 `App.tsx` → 先只扫新建的 5 个包）

- [ ] **Step 2** `check:store`：AST 扫描 `.vue`，断言组件内 0 处 `bridge.call(`；断言 `packages/ui/**` 不 import `bridge-client` / `stores`

- [ ] **Step 3** 挂到根 `package.json` 的 `check` 脚本末尾

  ```powershell
  pnpm check:store; pnpm check:no-react
  ```

---

### Task V1-7 — 三个 Spike（**本轮已执行完毕**）

实测记录全文：[2026-10-02-v1-spikes.md](./2026-10-02-v1-spikes.md)；原始产物在 `apps/web/spike/results/*.json`；复现脚本在 `apps/web/spike/*.mjs`。

- [x] **Spike A（SSR 样式收集）** —— ✅ 可行
  `vite build --ssr` + `@css-render/vue3-ssr` 的 **`setup(app)`（单参数，不是数组）** 能收集 106,702 B 样式；
  **令牌值内联在元素 `style` 的 `--n-*` 上，不在 collect() 的 CSS 里**（门禁要两边查）；
  `inverted` 组件**绕过普通主题键**，深青侧栏必须写 `*Inverted` 键；
  只覆盖 primary 漏 **40 处**默认色 → 全覆盖 + `*Inverted` 后 **0 处**。

- [x] **Spike B（虚拟滚动）** —— ✅ 达标
  1000 行只渲染 **22 个 `tr`**；挂载 **20.6ms**；滚动帧 p50/p95 = **16.7/16.8ms**，>20ms 帧 **0/120**；
  行高实测 **49px**（48 + 1px 边框，密度令牌要按"含边框 48"实现）。

- [x] **Spike C（体积，本轮最重要的发现）** —— ⚠️ 方案已据此改预算
  base(vue+router+pinia) **33.1KB** · lean(登录集) **88.8KB** · +DataTable **+75.8KB** · +Select+DatePicker **+70.5KB** ·
  列表页 **204.7KB** · 列表页+双壳 **217KB**（预算 250KB）。
  → 预算改为"首屏路由 ≤150KB + 单路由 chunk ≤130KB"，**路由级懒加载成为硬要求**。

**V1 完成判定**：`pnpm typecheck` 绿；`pnpm build` 绿且 **登录路由 ≤150KB gzip / 单路由 chunk ≤130KB**；两端真登录成功；`check:store` / `check:no-react` / `check:tokens` / `check:css` 绿；三个 spike 的结论已被 V1-1/V2 吸收（`*Inverted` 键、懒加载、`setup(app)`、行高 48/49）。

---

## 不在本清单内（V2 起）

- V2：`@wise/ui` 包装件 + 业务件 + `/preview` + `check:naive` + `check:a11y`
- V3：`@wise/layouts` 双壳 + `useNavStore` 全量 + 扫码三分支
- V4：逐域迁移（概览 → 库存 → 现场 → 我的）
- V5：宿主资源路径接线
- V6：门禁全套 + Playwright + 出包 + 删 React

## 回滚

| 时机 | 手段 |
| --- | --- |
| V0 之后任意时刻 | `git switch main`（tag `archive/react-web-final`） |
| V1-2 之后观感变了但逻辑没变 | `git revert` 该提交（生成物 + 生成器一起回） |
| V1-5 之后登录通了但界面不对 | 保留 `bridge-vue`/`stores`，回滚 `apps/web/src` 单目录 |

---

## 执行记录（2026-10-02）

> 下面这张表是**实际做了什么**；上面的 Task 正文是**当时的计划细节**，两者不一致时以本表为准（差异逐条写明）。

| Task | 状态 | 实际结果 / 差异 |
| --- | --- | --- |
| V0-1 提交两批在途改动 | ⏸ **未做** | 提交/丢弃用户在做的工作不是我能替他决定的事。当时的工作区仍未提交，V1 的新增全部是**追加**（新包 + `apps/web/src` 新文件），未与那两批改动冲突 |
| V0-2 冻结 tag | ⏸ **未做** | 同上：树上还有未提交改动，此刻打 tag 会得到一个与工作区不一致的回滚点 |
| V1-1 依赖与构建 | ✅ | vue 3.5.43 / vue-router 5.3.1 / pinia 4.0.3 / naive-ui 2.45.3 / vue-tsc 3.3.11；`vite.config.ts` 双插件 + 只切 `vendor-vue`（**不做 vendor-naive**，理由写在配置注释里）；`typecheck` → `vue-tsc --noEmit`；`index.html` → `/src/main.ts`，保留 CSP 与静态启动态 |
| V1-2 令牌三产物 | ⚠️ **部分** | 已做：`packages/tokens/src/theme.json` + `tools/gen/gen-naive-theme.js` + 生成 `theme.v2.css`(66 令牌) 与 `apps/web/src/theme/naive.ts`（含 Spike A 发现的 `*Inverted` 键）。**未做**：把旧 `tokens.css` 换掉、改 `check:tokens` 语义 —— 旧 React 屏还在树上且没有 tag 回滚点，此刻换基线等于"无回滚地重绘旧界面"。改为两条基线**并存**，`check-css-vars` 取并集（旧 149 + 新 66 = 215） |
| V1-3 `@wise/bridge-vue` | ✅ | `provideBridge`/`useBridge`/`useBridgeState`/`subscribeBridgeState`（订阅者异常隔离） |
| V1-4 `@wise/stores` | ✅ | `useBridgeStore`（唯一持有桥实例）/ `useResourceCacheStore`+`useResource`+`useMutation`（四条语义齐全）/ `useSessionStore` / `useUiStore` / `useNavStore` |
| V1-5 启动状态机 + 登录 + 会话门 | ✅ | `boot.ts` 分子类错误文案；`main.ts` 顺序 = boot → attach → **等 session 结算** → `router.isReady` → mount（理由写在文件注释里）；hash 路由 + 会话门 + 强制改密门占位 |
| V1-6 门禁雏形 | ⚠️ **部分** | 已做：`check:naive-theme`（生成物 ↔ theme.json 一致，已进 `pnpm check`）、`check:web-smoke`、`check-css-vars` 支持双基线。**未做**：`check:no-react` / `check:store`（V1-6 原计划的两条）。等 `@wise/ui` 落地（V2）再一起做，否则现在没有可扫的 `ui` 包 |
| V1-7 三个 Spike | ✅ | 见 [2026-10-02-v1-spikes.md](./2026-10-02-v1-spikes.md) |

**额外做的（计划外，但缺了这条链就验不完）**：`packages/bridge-client/src/mock.ts` 补了 `captcha.generate` / `auth.login` / `bridge.session` 三个开发态夹具。原先 mock 里没有它们，纯浏览器 `pnpm dev` 会在登录屏上看到"验证码加载失败"，于是"登录屏对不对"只能在真宿主里验。补齐后开发态能走完**启动 → 登录 → 主框架**。这是开发态专用行为，真桥不受影响。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | `vue-tsc --noEmit` **exit 0**（严格档：`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax`） |
| 构建 | `pnpm build` | 成功，路由级分包生效 |
| **首屏预算** | 同上产物 | index 59.04 + vendor-vue 41.42 + LoginView 26.28 + CSS 2.41 + html 1.51 = **≈130.7KB gzip**（新门禁 ≤150KB ✅） |
| 分包 | 同上产物 | `HomeView` 4.27KB / `PlaceholderView` 0.62KB 独立 chunk；**DataTable 未进首屏**（尚无路由用到它） |
| **Web 冒烟** | `pnpm check:web-smoke` | **11/11 通过**：登录屏渲染、3 个输入框、验证码位、文案无桥方法 id、mock 横幅可见、登录按钮可用、登录后进主框架、显示真实会话账号 `admin`、"功能上线中"业务文案、hash 路由、无 JS 异常 |
| 全门禁 | `pnpm check` | **16/16 通过**（含新增 `check:naive-theme`；`check-css-vars` 令牌 215 个） |

**未验（属于后续批次，别当成已完成）**：真宿主（Electron / Android 壳）启动与真登录（V5）、`check:no-react` / `check:store`（V1-6 剩余）、`check:naive` / `check:budget` / `check:a11y`（V2/V6）。

---

## V2 执行记录（设计系统，2026-10-02）

| 交付物 | 内容 |
| --- | --- |
| `@wise/ui` | `Mono` / `StatusChip` / `PageHeader` / `SectionBlock` / `StateHost`（四态互斥穷尽）/ `ResponsiveDataView`（同一份列定义：桌面表格 / 手机卡片）/ `MetricGrid` / `KeyValuePanel` / `FilterBar`（搜索作用域必须标注）/ `PaginationBar` / `ActionDock` / `ConfirmDialog`（焦点圈闭 / Esc / 关闭后焦点归还）+ `useViewport` |
| `/preview` | 开发态组件预览页：三档密度、两种布局、四态、危险确认都在一页里可交互。**生产构建里路由不注册**（`import.meta.env.DEV` 静态替换），构建产物已验证无 `PreviewView` chunk |
| 门禁 | 新增 4 条：`check:naive`（颜色字面量 + **17 项必需覆盖键**）/ `check:store`（组件不许直连桥、`@wise/ui` 不许认数据层）/ `check:no-react`（React 遗留清单有界）/ `check:budget`（首屏 ≤150KB、单 chunk ≤130KB、首屏禁含 DataTable/DatePicker）；另加组合脚本 `check:web` |

**与 V2 计划的差异（都是有意收窄或改进，不是漏做）**

1. **不做 18 个 primitives 的薄包装**。Naive 的 `NButton`/`NInput` 直接用就行，包一层只在**有规则要钉住**的地方才值得（等宽、状态色、四态、动作坞）。薄包装 18 个文件除了增加维护面没有任何纪律收益。
2. **`DataTable` / `DataCardList` 合并进 `ResponsiveDataView`**。拆成三个组件会让"列定义 → 两种渲染"这条管线重复三遍，而它恰恰最需要唯一的一份。
3. **`AsyncEntityPicker` / `OperationTimeline` / `ScanEntry` 推迟到 V3/V4**：它们分别依赖真实实体方法、真实日志 DTO、扫码 store，现在做只能靠编。
4. **登录流程从组件搬进 `useSessionStore`**（计划外）。这是 `check:store` 逼出来的：它拦下了 `LoginView.vue` 里的 `bridge.call('auth.login')`。搬完之后"验证码一次性、失败必换一张"这条规则不再只活在某个组件的闭包里，别的入口能复用。门禁**没有被放宽**，是把代码改对了。

### V2 验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | `vue-tsc --noEmit` **exit 0** |
| 全门禁 | `pnpm check` | **19/19 通过**（新增 `check:naive` / `check:store` / `check:no-react`） |
| 构建 | `pnpm build` | 成功；首屏 **101.1KB gzip**（上限 150），5 个 chunk 全部 ≤130KB，首屏无 DataTable/DatePicker |
| 设计系统冒烟 | `pnpm check:web-smoke` | **21/21**：登录链路 11 项 + 预览页 10 项（4 张 KPI 卡、桌面表格 4 行、16 处等宽单元格、错误码露出、空态业务文案、切卡片模式 4 张卡 + 4 个状态芯片、危险确认弹窗打开与取消关闭） |
| 令牌 | `check-css-vars` | 3 个 CSS 文件、222 个令牌（旧基线 149 + 新基线 73），无未定义引用、无写死取值 |

**仍未验**：`check:a11y`（axe-core，V6）、SSR 渲染门禁（`check:render` 的 Vue 版）、真机走查、真宿主登录（V5）。

---

## V3 执行记录（双壳与导航，2026-10-02）

| 交付物 | 内容 |
| --- | --- |
| `@wise/layouts` | `navigation.ts`（**16 个导航叶子 + 10 个推入目的地**，路径/参数/短标签齐备）、`AppFrame.vue`（双 chrome + **唯一一份内容实例**）、`BridgeStatusChip`、`ScanResultCard`、`useScanGun`（Vue 版，复用 `@wise/scan/assembler`，故两端一套识别逻辑） |
| `@wise/stores` | `scan.ts`：扫码三分支路由（输入焦点 / 屏内消费者 / 兜底跳转）+ 结果卡状态。**store 不认识 router**，它只回答"这次扫码归谁"，跳转由外壳执行 |
| 路由 | 由信息架构**生成**（`DOMAINS.flatMap` + `DESTINATIONS.map`），叶子先于目的地 —— 静态段优先是结构性成立的，不是靠注释 |
| 门禁 | 新增第 20 条 `check:navigation-web`：叶子/目的地方法唯一 + 全在契约内 + 路径唯一 + `:param` 与 `paramKeys` 一致 + 展开顺序未被打乱 |
| 冒烟 | 扩到 **32 项**，新增第三阶段"双端外壳与导航" |

### 两处刻意的"不画"

1. **不画全局搜索框**（参考图顶栏有一个）。本仓没有全局搜索方法（`inventory.search` 只是库存域的服务端搜索）。画一个点了没反应的搜索框，现场会当成"应用坏了"——比不画更糟。
2. **不画相机扫码按钮**。Web 侧取景与条码识别是 V3-b，尚未落地。能力表里 `scan.camera` 为真也不该先摆入口。（键盘式扫码枪是另一回事：浏览器本来就能收键盘，所以它**真能用**，mock 里也补上了 `scan.gun.keyboard` 能力，开发态可完整验三分支。）

另外把 `⌘K` 命令面板推迟到 V4 —— 现在没有任何真实动作可供它执行。

### 与 V3 计划的差异

- **`DesktopShell` / `MobileShell` 合并进 `AppFrame`**。两个壳各持一个 `<RouterView>` 会在跨断点时**卸载重建**当前屏，未提交表单与选中行全丢。合并后只有一个内容实例，chrome 用 `v-if` 换 —— 这条约束由结构保证，不由纪律保证。
- **Android 物理返回键**：hash 路由下浏览器返回已可用；宿主侧把返回键转发给 WebView 属 V5（要改 `apps/mobile`，本次不碰）。
- **扫码结果卡只显示编码本身**（以及它去了哪一支）。商品名/库存摘要要等 `tag.byCode` 的 DTO 在 V4 接线后才能显示，现在编不出来。

### 一个自己踩的坑（记下来）

`check:navigation-web` 第一版用 `/DESTINATIONS[\s\S]*?= \[/` 提取目的地块，结果先匹配到了文件**顶部文档注释里的 "DESTINATIONS"**，把整份 `DOMAINS` 当成目的地，报了 33 个假问题。
教训：**门禁自己出错比不写更糟** —— 它会让人开始怀疑真实问题。已改为锚定 `export const DESTINATIONS`，并在注释里写明原因。

### V3 验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | exit 0 |
| 全门禁 | `pnpm check` | **20/20 通过** |
| 构建 | `pnpm build` | 成功；首屏 **103.3KB gzip**（8 个 chunk 全 ≤130KB）；**壳本身是懒加载 chunk（35.7KB）**，登录页不背 NMenu/NDrawer |
| 双端冒烟 | `pnpm check:web-smoke` | **32/32**，其中第三阶段 11 项：桌面三件套在位且无手机底栏、侧栏分组=运营/库存/现场/管理、**静态段优先**（`/stock-orders/new` 打开"新建出入库单"而不是"单据详情"）、参数段仍可达、切到 390px 后底栏出现/侧栏消失/情景头在/4 项、**断点切换不丢路由**、叶子 >4 的域改用抽屉入口、**扫码兜底分支跳到 `#/inventory/tags/code/ABCD1234`**、结果卡显示真实编码、无 JS 异常 |

**仍未验**：相机扫码（V3-b）、宿主返回键转发与真机（V5）、`check:a11y` / SSR 渲染门禁（V6）。

---

## V4 执行记录 · 第一域：概览（2026-10-02）

| 交付物 | 内容 |
| --- | --- |
| 屏 | `DashboardView.vue`（`dashboard.summary`）、`AlertListView.vue`（`alert.list`）、`AlertDetailView.vue`（`alert.detail` + `alert.logs` + `alert.ack` / `alert.status`） |
| 业务规则 | `views/overview/alertState.ts` —— 从 React 版 `AlertDetailScreen.tsx` **逐条搬过来**：状态三形状归一化（数字码 / 枚举名 / 中文）、等级与来源翻译、处理记录结果、以及**"动作能不能点 + 不能点的原因"** |
| 通用件 | `@wise/stores/dto.ts`（`asList` / `asTotal` / `humanize` / `shortTime`，与 React 版逐条对齐）；`StateHost` 增加 `errorText` 覆盖位；`ConfirmDialog` 正文改为默认插槽（支持"忽略原因"这类输入） |
| 门禁 | 第 21 条 `check:ui-web`（Vue 文案纪律：方法 id / 开发黑话 / 内联写死取值）；`check-navigation-web` 增加"已迁入的屏必须在可达集合里" |
| 冒烟 | 扩到 **54 项**，新增第四阶段 22 项 |

### 三条从 React 版继承、一条不敢省的业务规则

1. **动作按状态决定，不能做的把原因写在按钮旁边**：服务端 `acknowledgeAlert` 对非「未处理」的告警**没有任何副作用地直接返回**，而 `updateAlertStatus` 对状态流转**不做任何校验**（照请求里的数字写库）。"能不能点"只有界面说得清 —— 让操作员点一下才发现没反应，等于把服务端实现细节丢给用户。
2. **终态不提供"重新打开"**：服务端没这个能力，摆一个点了没用的按钮比没有按钮更糟。
3. **忽略必须写原因（≥2 字）**：原因会进处理记录；不说为什么，下一个翻记录的人只会看到一个没有解释的「已忽略」。

### 两个自己踩的坑（都记进注释了）

1. **`reactive(new Map())` 的 `ensure()` 不能在新建时直接返回原始对象**。`reactive` 只在 `get` 时把对象包成代理；新建时返回原始对象会让 `entry.data = …` 写在代理之外 —— 值变了、依赖没被通知、**界面不刷新**。现场表现极难查：首次进详情页正常，但"动作成功 → 失效 → 重取"之后**数据是新的、画面是旧的**。修法是写回 Map 后**再读一次**拿代理。
2. **mock 里 `method.startsWith('alert.')` 会把无状态的 `alert.list` 一起吞掉**，于是列表屏只剩错误态、页头显示"最近的告警事件"，看起来像业务 bug。改成只拦有状态的那四个方法。

### V4-概览域验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全门禁 | `pnpm check` | **21/21 通过**（exit 0；含新增 `check:ui-web`） |
| 类型 | `pnpm typecheck` | exit 0 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **104.8KB gzip**；18 个 chunk 全 ≤130KB；首屏无 DataTable/DatePicker |
| 双端冒烟 | `pnpm check:web-smoke` | **54/54**。第四阶段 22 项包括：4 个 KPI 全部来自真实字段（`1284 / 3 / 62% / 17`，**不是占位 0**，说明 DTO 字段名接对了）、当前任务显示真实任务号与进度（`PT-20260101-01`、`62%（74/120）`）、未处理告警 2 行、告警中心 3 行且页头给总数、点行进详情带序号、详情状态=未处理且「确认收到」可点、**忽略少于 2 字被拦下**并给出原话、确认动作弹二次确认、成功后给出可执行的下一步、**状态真的变成「处理中」**（失效—重取这条链通了）、不可点的按钮变灰**且原因写在旁边**、处理记录写入真实处理人、终态下三个动作全部不可点且三条原因都在、已结束的告警一进门就是不可操作状态 |

**仍未验**：其余三域（库存 / 现场 / 我的）共 22 个页面；相机扫码；真宿主；`check:a11y`；跨断点保留**未提交表单**（现在只保证了筛选/页码/路由，表单靠路由不重建来保，但还没有断言）。

---

## 界面修订 · 按用户反馈（2026-10-02）

用户三条明确要求，逐条落地并给出可验证证据：

### 1. 白色简约，侧栏不要绿的

- `theme.json` 的 `nav` 组**整组换成白色系**：`bg #FFFFFF`、选中块 `#E3F2F0`、悬停 `#F5F8F7`、正文 `#173344`、次要 `#5B6B70`、分组标签 `#8A9AA0`、描边 `#E9EEEE`。侧栏 = 白底 + 1px 右描边 + 浅主色选中块。
- **深青不再铺满侧栏**，只保留为"**品牌面**"：新增 `brand` 组（`bg #102E3E` / `fg #FFFFFF` / `fgMuted #B9CDD5`），用在登录页品牌区、手机扫码结果浮层、深色 tooltip。语义也重排了：`*Inverted` 主题键现在指向 **brand**（inverted 的含义就是"深色面上"），侧栏改用**非 inverted** 的普通 Menu 键。

### 2. 页面高度固定，只能换页

- `html/body/#app` 100% + `body { overflow: hidden }`；外壳是 flex 列，**只有 `.w-content` 是滚动容器**；手机的情景头、分段控件、底栏全部挪到滚动区**之外**（放里面会跟着列表滚走）。
- 两个坑，都写进注释了：
  1. `.w-shell { height: 100% }` 在"横幅 + 外壳"的 flex 列里等于"横幅 + 整屏"，总高超出视口 → 改成 `flex: 1 1 auto`；
  2. **`.w-app { height: 100% }` 解析成了 auto**：naive-ui 的 `NConfigProvider` 会渲染一层 `div.n-config-provider`（自动高度块级元素），于是 `.w-app` 被内容撑到 **1176px（视口才 900）**，表现为"整页还能滚一下"。改用 **`100dvh`** 绕开"祖先是 auto 高度"这个前提，也不依赖库的 DOM 结构。
- **判定方式也改了**：不用 `scrollHeight`（naive 的浮层会 teleport 到 body 末尾的容器里，把 `documentElement.scrollHeight` 撑大，用它做判据会一直红而体验其实是好的）。改成行为判定：滚窗口后 `scrollY` 必须仍是 0；再往 `.w-content` 塞一个 3000px 高块，验证它**真的**滚、而整页仍不动。

### 3. 右上角：搜索 + `Bridge 正常 · 18 ms`

- 搜索框做成了**页面跳转**：搜的是本地那张导航表（页名 / 域 / 方法 id），↑↓ 选择、回车跳转。输入框与结果区都明确写着"**只搜页面名称，不搜业务数据**" —— 本仓没有全局数据搜索方法，把两者混在一起会让用户把"搜不到"理解成"库里没有这条记录"，那是会误导排障的错误印象。
- Bridge 芯片：`Bridge · 正常 · 18ms`。**那个数字是实测的**：样本来自界面自己发出的真实后端调用，取最近 5 次的**中位数**，量的是"桥转发 + 后端往返"端到端耗时。三条纪律：
  1. 本地方法（`bridge.session`）**不计时** —— 它们不经网络，混进来只会把数字压到 1ms 以下，看上去像"网络很快"，其实什么都没测到；
  2. **没有样本时不显示数字**（不显示 0，也不编一个）；
  3. 开发态写 `Bridge · 假桥 · 122ms`，不冒充真宿主；tooltip 里说明数字来源。
  > 备注：`Bridge` 是技术词，与 `check:ui-web` 的"业务用户不该看到技术术语"精神有张力 —— 但这是用户明确点名的形态，以用户指令为准。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全门禁 | `pnpm check` | **21/21，exit 0，✗ 数 0** |
| 类型 | `pnpm typecheck` | exit 0 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **105.4KB gzip**；18 个 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **64/64**。新增 7 项：侧栏是白底（`rgb(255,255,255)`）、侧栏 1px 描边、**整页不可滚动（滚窗口后 `scrollY` 仍为 0）**、`body` 显式 `overflow:hidden`、**内容区是滚动容器（塞 3000px 高块后真的滚，整页仍不动）**、右上角搜索框存在、**Bridge 芯片显示实测耗时（`Bridge · 假桥 · 122ms`）**、搜索"告警"回车能跳到告警中心 |

---

## 界面修订 · 第二轮（换 UI 库 + 布局重排，2026-10-02）

用户这一轮的六条要求，逐条落地：

### 1. 换用「饿了么组件」= Element Plus 2.14.6

- **全量替换**：`@wise/ui`（8 个组件）、`@wise/layouts`（4 个）、`apps/web` 的 8 个视图，从 naive-ui 全部迁到 Element Plus；旧依赖从 `dependencies` 移到 `devDependencies`（只留给 `apps/web/spike` 的早期 SSR 实验）。
- **主题走 CSS 变量**：`theme.json` → 生成 `theme.el.css`（**70 个 `--el-*` 变量**），EP 的悬停/禁用/浅底都吃这套变量。`check:naive` 换成 `check:el-theme`：33 项必需覆盖键 + **浅色档单调性断言**（生成器第一版把 `light-3..9` 的比例写反了，悬停态与浅底全反，不报错只"看起来怪"——现在被断言钉住）。
- **按需引入**：`unplugin-element-plus` 给每个组件自动补它的 CSS，不引全量 `index.css`（那有 ~40KB gzip）。
- **体积反而降了**：首屏 **105.4KB → 85.4KB gzip**（EP 的登录页组件比 Naive 的轻），25 个 chunk 全 ≤130KB。
- **一处能力变化（如实记）**：EP 的表格**没有内置虚拟滚动**。本仓列表全是服务端分页（20 条/页），用不上；真出现单页上千行再引 `el-table-v2`，而不是在这一层硬塞。

### 2~5. 布局重排

```
┌──────────┬──────────────────────────────────────────────┐
│ 慧仓智控  │ 面包屑 库存/库存查询   [搜索页面]  [Bridge · 正常 · 18ms] │ ← 每个子页面之上
│ WISEDEPOT│                                              │
│（最左上角）├──────────────────────────────────────────────┤
│ 运营 ▾    │  .w-content —— 唯一滚动容器                   │
│  看板     │      <RouterView/>                           │
│ 库存 ▾    │                                              │
│  …（可滚）│                                              │
│ ─────────│                                              │
│ 头像 名字 │                                              │
│     职位 │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- **品牌在最左上角**：左列改成**整屏高**，品牌贴它的顶部；顶栏属于**右列**，所以"面包屑 / 搜索 / Bridge 状态"出现在每个子页面的上方，而不是横跨整个窗口。
- **侧栏可展开/收起**：`ElMenu` + `ElSubMenu`（按域分组）+ 右上角折叠按钮；**菜单区自己滚动**（`overflow-y:auto`），导航项再多也不会把账号块挤出屏幕。
- **账号从右上角移到左下角**：头像 + 姓名 + 职位，数据来自 `user.current`（见下方"待核"）。
- **右上角只剩搜索 + Bridge 状态**：`admin` 已从右上角移除。

### 6. 搜索用饿了么组件，而且**真的能用**

`ElAutocomplete`，数据源是本地那张导航表（页名 / 域 / 方法 id）。

一处必须补的坑：EP 的 autocomplete 在**没有高亮项**时按 Enter **什么都不做**（要先按 ↓ 选中）。对一个"跳页"输入框来说"打完字按回车"才是自然用法，所以补了 `@keydown.enter` → 跳第一个匹配；并与 EP 自己的 `select` 做了去重（`onSelect` 先清空 keyword，冒泡上来的 Enter 处理器因守卫直接返回）。冒烟里也据此把"输入 → 等过 300ms 防抖 → 回车"分成两步，否则"没反应"会是测试的错。

提示语写明"**只搜页面名称（不搜数据）**"：本仓没有全局数据搜索方法，混在一起会让人把"搜不到"理解成"库里没这条记录"。

### 关于"延迟要真实的"

那个数字**本来就是实测的**：取最近 5 次**后端请求**往返耗时的中位数（含本地桥转发）。
- 本地方法（`bridge.session`）不计时 —— 不经网络，混进来只会把数字压到 1ms 以下；
- 没有样本时不显示数字；
- 开发态写 `Bridge · 假桥 · 122ms`（mock 自身有 120ms 模拟往返），tooltip 说明来源。

### 两处要如实说的地方

1. **`vue-tsc` 在 `packages/*` 里解析不到 Element Plus 的 `buildProps` 结果类型**：同样的 `size="large"` 在 `apps/web` 里正常，在 `packages/ui`、`packages/layouts` 里会报 `Type 'string' is not assignable to '{ PropType<…>; __epPropKey: true }'`（尝试过 pnpm hoisting，未解决）。当前用 `v-bind="propsObject"`（返回类型 `any`）做**类型层绕行**，运行期行为完全一样；每个绕行处都写了注释说明原因。这是已知瑕疵，不是隐藏问题。
2. **`user.current` 是本次首次接线**：它在契约里是策展过的（`/api/users/current`、`USER_CURRENT`），且 mock 里有夹具，但**旧 React 版从未用过**（旧版只用了 `profile.get` + `user.list`）。发布前需要拿真后端核一次响应字段；取不到时全部退化到会话里的 username，绝不编一个职位。角色码只映射旧版验证过的 `ADMIN`/`USER`，认不出的码**原样显示**。

### 第二轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全门禁 | `pnpm check` | **21/21，exit 0**（`check:naive` → `check:el-theme`） |
| 类型 | `pnpm typecheck` | exit 0 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **85.4KB gzip**（EP 比 Naive 更省）；25 个 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **65/65**：白色简约 / 固定高度 / 顶栏右上角 7 项 + **搜索框写明"不搜数据"** + **输入"告警"过防抖后回车跳到告警中心** + 概览域 22 项 + 外壳与扫码 11 项 |

---

## V4 执行记录 · 第二域：库存（2026-10-02）

**9 屏**，是最大的一个域：

| 屏 | 桥方法 | 要点 |
| --- | --- | --- |
| 库存查询 | `inventory.list` | 关键词是**客户端筛选**（标注"筛选本页"）+ 库存偏低/已锁定两档筛选 |
| 库存详情 | `inventory.detail` + `lock`/`unlock` | 锁定是"预留"语义（可用量减少、总量不变）；**不提供直接改库存数**（库存只能走单据） |
| 商品管理 | `product.list` + `create`/`delete` | CRUD 样板；删除被库存引用的商品**显示服务端原话** |
| 仓库管理 | `warehouse.list` + `create`/`delete` | 注意删除端点入参是 **`id`** 不是 `warehouseId`（契约 `/api/warehouse/{id}`） |
| 标签管理 | `tag.list` + 批量绑定/解绑 | 批量绑定**必须验证码**；失败后自动换一张；选中态由本屏自己持有 |
| 标签详情 | `tag.detail` / `tag.byCode` | 两条入口同一屏（列表点进来 / 扫码落点） |
| 出入库单列表 | `stockOrder.list` | 字段是 `orderStatus`/`orderType`（**不是** `status`/`type`，那两个键后端从没填过） |
| 新建出入库单 | `stockOrder.create` | 单号客户端给（服务端不生成）；默认 `IN-YYYYMMDD-HHmm` |
| 单据详情 | `stockOrder.detail` + `submit`/`withdraw`/`audit` | 状态流转判据全部来自 `stockOrderState.ts`；**提交要求有明细** |

### 复用与新增

- **`stockOrderState.ts` 逐字节拷贝**过来（纯规则、无框架依赖）。新增门禁：`check:store` 里断言两份副本**逐字节一致** —— 已用"故意制造漂移 → 门禁变红 → 恢复 → 变绿"验证过它真的会拦。
- **`ResponsiveDataView` 增加 `#lead` / `#actions` 两个插槽**：前者放复选框（批量选择）、后者放行内操作（删除）。桌面出多一列、手机出卡片底部按钮，**同一份插槽**。没有用 `ElTable` 的内置 selection：那套选中态由表格自己持有，父组件清空时表格不一定跟着清（现场表现是"操作完了勾还在"）。
- **`useCaptcha` + `CaptchaField`**：验证码的第二个使用场景（批量绑定）。不复用登录那份 —— 验证码是一次性的，共享会让两边互相作废。
- **`mock-inventory.ts`：有状态的开发态 mock**。无状态假数据只能证明"页面画出来了"，证明不了流程；这份 mock 复刻了服务端的真实分支（单号必填、无明细不能提交、只有待审核能撤回/审核、仓库删除入参是 `id`、被引用的商品不能删），于是"新建→出现在列表→删除→状态流转"在开发态就能验。

### 两个开发态踩坑（都记进注释了）

1. **Vite 中途预打包依赖 → 整页 reload → 会话丢失**。路由是懒加载的，所以"跑到某个域时才发现新依赖"，Vite 会 reload；mock 桥的登录态在内存里，于是被踢回登录屏。冒烟里表现为"第四阶段之后所有断言都停在 `#/login`"，手动点只是"偶尔刷新一下"，很难联想到依赖预打包。处置：`optimizeDeps.include` + 冒烟里**先预热所有路由再整页重载**，另外每阶段开头都有一次显式会话兜底（触发时会打一条 `✓`，常亮就说明还有别的 reload 源）。
2. **Element Plus 关闭后的对话框节点仍留在 DOM 里**（用 `v-show` 藏）。于是 `document.querySelector('.el-dialog')` 会选中上一阶段遗留的**隐藏**弹窗，点它的"确定"什么都不会发生 —— 表现为"点了确认却什么都没发生"。处置：冒烟里按文案点按钮时**只点可见的**（`offsetParent !== null`），并优先从可见弹窗里找。

### V4-库存域验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全门禁 | `pnpm check` | **21/21，exit 0** |
| 类型 | `pnpm typecheck` | exit 0 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **88.5KB gzip**；**46 个 chunk** 全 ≤130KB（每屏一个懒加载 chunk，域越大分得越细） |
| 双端冒烟 | `pnpm check:web-smoke` | **93/93**。第八阶段 25 项包括：客户端筛选（关键词"液压"→1 行）、库存详情锁定（空数量被拦 → 填 5 → 回执"已锁定 5 件"）、新建商品后列表 +1、**删除被引用商品显示服务端原话**（`已有库存记录，不能删除`）、**删除仓库成功（入参名 `id` 正确）**、勾选 2 个标签 → 批量按钮显示选中数 → **绑定弹窗带验证码 → 未选商品被拦 → 选商品+填码 → 三行全变"已绑定"**、**没有明细的单据不能提交且写明原因**、待审核单据撤回/审核可点而提交不可点、**审核后进入终态四个动作全不可点**、默认单号 `IN-20261001-1432`、建单必填校验、建单成功给下一步 |

**仍未验**：现场域与「我的」域共 7 屏；`inventory.search`（服务端搜索）未接线；商品/仓库的**编辑**未接线（服务端有 `update`，未经验证不接）；桌面 Wide 档的"列表+详情同屏主从"未做（现在是点行跳详情页）—— 这三条都是**已知差异**，不是遗漏。

---

## 界面修订 · 第三轮（Bridge 状态要实时且真实，2026-10-02）

用户的两条要求：**耗时要是实时的**、**状态要真的（出了问题不能还显示正常）**。

### 1. 实时：周期探测，不靠"最后一次用户操作"

`bridgeStore` 起了一个 **10 秒一次**的探测：真的调一次后端（`user.current` ——
无参数、无副作用的 GET，壳里本来也要用它取账号，不是纯空转），量"桥转发 + 后端往返"的端到端耗时，
取最近 5 次的**中位数**。

- 用 `health.*` 不行：契约里那个端点列在 `BRIDGE_EXCLUDED_IDS`（桥不暴露它）。
- **本地方法不计时**（`bridge.session`）：不经网络，混进来会把数字压到 1ms 以下。
- 页面不在前台时**停掉**，回到前台补一次 —— 后台标签页没必要一直打后端。

### 2. 真实：判据是"传输层状态 + 最近一次探测"，失败是粘性的

`bridgeStore.health` 的判据顺序是有意的：

| 顺序 | 情况 | 显示 |
| --- | --- | --- |
| 1 | 传输层 `closed` | **已断开**（危险色）—— 不管上次探测成功与否 |
| 2 | `reconnecting` / `connecting` | 重连中 / 检测中（警告/中性） |
| 3 | 传输层通但**探测失败**（后端不可达 / 超时 / 连接断开 / 5xx） | **异常**（危险色）+ 错误码 |
| 4 | 探测成功 | 正常（+ 实测毫秒） |
| 5 | 还没探测过 | **检测中**，**不假装正常** |

关键的一条边界：**业务类拒绝不算服务异常**。`AUTH-*` / `VAL-*` / `RES-*` / 参数错误
都说明"请求走到后端并被处理了"，把它们算成红灯才是显示不真实。

失败是**粘性**的：只有下一次探测成功才回到正常，不会自己恢复。
顶部横幅与顶栏芯片**同源**（都读 `health`），所以出问题时两处一起说，并给出错误码与下一步。

### 3. 怎么证明"真的会变红"——开发态的故障开关

真后端没法按需挂掉，所以假桥加了一个开关：

```js
await window.__bridgeMock.setBackendDown(true)   // 之后所有后端调用都报「后端不可达」
await window.__bridgeMock.setBackendDown(false)  // 恢复
```

冒烟里据此断言：不动界面、不发任何请求，芯片会**自己在过一个探测周期后变成红色**，
横幅同时给出错误码与"该怎么办"，恢复开关后**自动回到正常（不需要刷新页面）**。
这条比"我以为它会变红"强得多。

### 第三轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全门禁 | `pnpm check` | **21/21，exit 0** |
| 类型 | `pnpm typecheck` | exit 0 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **89.7KB gzip**；**48 个 chunk** 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **104/104**，其中新增：**后端不可达时顶栏显示"异常"**（`Bridge · 本地服务探测失败`）、**横幅带错误码与下一步**、**异常态用危险色**（`w-chip--danger`）、**恢复后自动回到正常**（`Bridge · 假桥 · 126ms`） |

### 顺手做的第三域开头：设备（2 屏）

- `DeviceListView`（`device.list` + `device.statistics`）：统计是**辅助数据**，取不到只在一旁提示，
  绝不把整屏拖成错误态；状态**优先用服务端译好的 `deviceStatusName`**（在线/离线/故障），
  只有在它缺失时才退回数字码。
- `DeviceDetailView`（`device.detail` / `device.byCode`）：行走速度与四路电机微调**只读文本展示、
  不用滑块** —— 服务端没有对应写接口，滑块会暗示一个不存在的能力。
  注意接口参数名是 `deviceCode`，路由段是 `:code`，这里做了映射。
- 新增目的地 `device.byCode` → `/field/devices/code/:code`（与 `:deviceId` 段数不同，不会抢先匹配）。

**冒烟新增 6 项**：设备列表 3 台、页头在线数来自 `device.statistics`、三种状态说法（在线/离线/故障）、
只读运行参数 5 项（速度 + 四路微调）、**不用滑块**（`sliders=0`）、按编号直达、
查不到的设备**如实报错**（`没有找到编号 NOPE-999…`）。

> 顺带修掉一个真实缺陷：`<RouterView>` 之前没有 `:key`，同一屏换参数（详情页换 id/编码）时
> **组件被复用**，会出现"查 NOPE-999 却还显示上一条记录"。现在按 `route.fullPath` 强制重挂载。

**现场域已收口**（设备 2 屏 + 巡检 6 屏，见下节），**只剩「我的」域 4 屏**（消息列表/详情、用户管理/详情、个人设置）。

## V4 执行记录 · 现场域巡检（2026-10-02）

### 把"真后端到底认什么"读成了证据，而不是猜

巡检这条链路以前只有一份 bench（`tools/bench/real-inspection-write.mjs`），它断言的是
**"不是 HTTP-400"** —— 这种断言看着严，其实放过了一整类缺陷。这轮我把服务端源码读了一遍
（`WiseDeoptServer/.../InspectionController.java` + `InspectionApplicationService.java`），
拿到四条**会静默做错事**的规则，并把它们写进了假桥的护栏（新增门禁 `check:inspection-mock`，42 个用例）：

| # | 规则（服务端原文） | 不守它的后果 | 我们的处理 |
| --- | --- | --- | --- |
| 1 | `taskStatus` 只认 `IN_PROGRESS` / `COMPLETED`，`status` 初值 0(PENDING)，**没有 else、不抛错** | 传别的值 → 任务被**静默重置成"待执行"** | Vue 版发 `IN_PROGRESS`；假桥**照样复刻这个坑**，谁改回去 smoke 立刻红 |
| 2 | `manualRecord` 只允许对**已完成**任务补录（原话「只能对已完成的巡检任务进行补录」），且会**重算计数** | 补录后界面还显示旧数字；用户看到"成功"但数据不对 | 假桥按同口径拒绝/重算；界面补录成功后**必须重拉任务详情** |
| 3 | `createTask` 的 DTO **一个校验注解都没有**，真正卡住的是服务层「仓库ID不能为空」+「仓库不存在」 | 以为 planId 必填、warehouseId 可空 | 界面按 warehouseId 必填做校验 |
| 4 | `listTasksPage` 用 **`pageSize`（默认 10）**，没有 `size` 参数；`listResults` **支持 taskId 过滤且不分页** | 发 `size:20` 只回 10 条（静默翻页错乱）；结果列表在客户端瞎过滤 | 列表发 `pageSize`；结果列表把 `taskId` 交给服务端 |

### 顺手发现并修掉一个 React 版的真缺陷（缺陷 F1）

`InspectionTaskDetailScreen.tsx:182,425` 的「开始执行」发的是 **`status: 'RUNNING'`**，
而服务端只认 `IN_PROGRESS` —— 由于没有 else 分支，这个请求返回 200，
**实际效果是把任务从"进行中"打回"待执行"**。那条 bench 用的是同一个错值，
断言又只到"不是 HTTP-400"，所以它一直是绿的。

Vue 版发 `IN_PROGRESS`，**界面文案一个字不改**（现场人员看到的仍是「开始执行」/「任务已开始执行。」）；
React 版保持原样不动（它只是对照物），这条差异记在这里，等 React 版删除时自然消失。

### 另外两处"文档与代码不一致"的裁决

- 简报里我写的「分页参数 `size`」是错的（照抄了别的域），已按 §1 改成 `pageSize`；
  假桥的 `page()` 两个名字都认，但**真后端只认一个**。
- 简报里我写的「详情屏给 `inspection.resultDetail` 入口」也被我自己否掉了：
  为了知道 resultId 去拉一次结果列表是白花的请求，真后端本来就支持 `?taskId=` 过滤，
  结果详情由**结果列表点行**进入即可。

### 交付的 6 屏（现场域巡检）

| 屏 | 文件 | 行数 | 桥方法 |
| --- | --- | --- | --- |
| 巡检任务列表 | `InspectionTaskListView.vue` | 292 | `inspection.taskPage` |
| 巡检任务详情 | `InspectionTaskDetailView.vue` | 610 | `inspection.taskDetail` / `taskDiff` / `taskStatus` / `taskProgress` |
| 新建巡检 | `InspectionTaskCreateView.vue` | 639 | `inspection.taskCreate` + `planList` / `warehouse.list` / `device.list` |
| 巡检结果列表 | `InspectionResultListView.vue` | 643 | `inspection.resultList` / `resultDetail` / `resultConfirm` |
| 录入结果 | `InspectionResultCreateView.vue` | 671 | `inspection.resultCreate` + `taskDetail` |
| 手动补录 | `InspectionManualRecordView.vue` | 658 | `inspection.manualRecord` + `taskDetail` |

三处与 React 版的**有意差异**（都记在代码注释里，不是漏做）：
1. 「开始执行」发 `IN_PROGRESS`（React 发错的 `RUNNING`，见缺陷 F1）。
2. 任务序号校验收紧为整数（React 提示写"正整数"却放行 `12.5`）。
3. 结果列表的行内 danger「确认」折到工具栏「确认这条结果」：`ResponsiveDataView` 的 `#actions` 列固定 120px，
   塞 danger 会把"结果序号"挤掉；React 本身也有这条工具栏按钮，语义等价、操作次数 +1。

`inspection.resultDetail` 与结果列表是**同一个屏**（React `registry.tsx:126` 也是这么映射的），
差异明细只是列表屏里的一个面板，`/field/inspections/results/:resultId` 表示"进来就选中它"。

### 顺带修掉的两个共享层 / 开发态缺陷

**F2 —— 假桥返回内部对象，导致"写后重取"在开发态永远刷不动**（真机却是好的）
`MockTransport` 直接把 `DomainMock` 里**被就地改过的那一个对象**交出去，引用没变 ⇒
Vue 的 "新值 !== 旧值" 判据不成立 ⇒ 界面不刷新。实测现象：假桥里任务已经是 `status:1/IN_PROGRESS`，
界面芯片还写着"待开始"，而 `保存进度`/`结束任务` 因此全是灰的。
修法：`MockTransport.call` 统一按 **JSON 语义克隆**一次再返回（真桥的响应就是一次 JSON 反序列化）。
这类"只在开发态出现"的假红/假绿最费时间，所以修在传输层一个点上，而不是指望每个 mock 记得返回副本。

**F3 —— `viewStateOf` 首次返回原始对象，冷启动翻页完全没反应**（审查实测复现）
`packages/stores/src/nav.ts` 缓存未命中时 `return created`（原始对象）而不是 `views.get(id)`（代理），
`reactive(new Map())` 只在 `get` 时包装，于是屏里写 `view.page` 不触发任何依赖。
**同型错误在 `resource.ts` 的 `ensure()` 已经犯过一次**（那里的注释就是为这条写的），这是第二次。
修法一行：写完再 `get` 一次；**全仓 7 个列表屏一起好了**（不止巡检这一屏）。

### 新增两条门禁（都做过变异验证，不是"总是通过"的仪式）

| 门禁 | 用例数 | 钉住什么 | 变异验证 |
| --- | --- | --- | --- |
| `check:inspection-mock` | 42 | 假桥必须复刻服务端三条"不报错、只静默做错事"的规则（状态值 / 补录闸门与重算 / pageSize） | — |
| `check:nav-state` | 8 | 状态首次取到就必须是响应式的、且写入能被派生的请求参数看见 | 把老实现（`return created`）拷回来跑：**4/8 红**（正是那条响应式断言） |

### V4-现场域巡检验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **23 条全绿**（新增 `check:nav-state` / `check:inspection-mock`） |
| 类型 | `pnpm typecheck` | exit 0，**0 错误** |
| 构建 | `pnpm build` + `check:budget` | 首屏 **91.9KB gzip**；**55 个 chunk** 全 ≤130KB；首屏无 DataTable/DatePicker |
| 双端冒烟 | `pnpm check:web-smoke` | **146/146**（本域新增 42 条） |

冒烟里这几条是**行为证据**，不是"页面画出来了"：
- 「开始执行」之后任务**真的**变成"进行中"（F1 的回归护栏：值一旦改回 `RUNNING`，假桥会照抄服务端的静默重置，芯片就变回"待开始"）。
- 补录被服务端原话拒绝（「只能对已完成的巡检任务进行补录」）、并且**补录后已扫数按服务端重算**（不是界面自己加一）。
- 结果列表按 `taskId` 过滤走服务端参数、确认入账后待确认数归零。
- 录入结果时**异常件数由「实扫 − 正常」推导**（填 8/6 后界面显示"异常 2 件"）。

### 本域的两条遗留（如实标注，不当成已知事实）

1. **结果 DTO 的 `status` 取值口径未实测**：仓内服务端 `getResult` 硬编码 `"COMPLETED"`，
   而界面按 `PENDING`/`CONFIRMED` 两档筛（这是 React 的写法，Vue 版照抄）。要定稿需要一个**真结果样本**。
2. **WSA 上还没走完真实链路**：APK 已装、桥与后端都起来了，但登录需要真后端账号口令
   （`deploy/.env.local` 里有，环境变量里没有）。这一步要单独做，且**不能把口令打进对话**。

## V4 执行记录 · 第四域：「我的」（2026-10-02）

### 一个数字的差别：两个域的分页基数**不一样**

读服务端源码时发现同一批列表接口有两种分页口径，**写错一个数字就静默错一页**：

| 方法 | 基数 | 服务端原文 | 传错的后果 |
| --- | --- | --- | --- |
| `message.list` | **0 基** | `MessageApplicationService#queryMessages`：`int start = request.getPage() * request.getSize();` | 传 1 会**跳过第一页** |
| `user.list` | **1 基** | `UserApplicationService#listUsers`：`page < 1 → 1`，再 `PageRequest.of(page - 1, size)`（默认 size=10） | 传 0 会被当成第 1 页（看不出来，但语义已经错了） |

所以简报里把这两条分开放，并让 `check:me-mock` 的护栏把边界钉住：
`message.list(page=0)` 必须是最新的两条、`page=1` 必须是下一批；`user.list(page=0)` 必须等价于第 1 页。

### 这一域的形状差异（不是漏做）

- `message.detail` 与消息列表**不是**同一屏，但消息列表里也有一个就地展开的正文面板（React 就这样）。
- `user.detail` 与用户列表**是同一个屏**（React `registry.tsx:139`），用户详情是列表屏里的明细面板。
- `message.unreadCount` / `profile.settings` 虽然出现在 React 的屏映射里，但**不是可路由的目的地**，
  所以不登记进 `registry.ts`（登记了会被 `check:navigation-web` 判为"用户点不到"）。

### 假桥：`mock-me.ts`（有状态）+ 门禁 `check:me-mock`（72 个用例）

有状态的部分：标已读 → 未读数减一、全部已读 → 归零、清空 → **只清当前收件人的**（清错人就是越权删）、
新建用户 → 列表多一个、改资料/改偏好 → 再查一次是新值。校验文案**逐字取自服务端注解**
（`@NotBlank(message = "用户名不能为空")`、`@Size(max = 16, message = "昵称长度不能超过16个字符")` …），
界面不该自己编一套跟服务端对不上的说法。

**两处如实标注的 mock 局限**（写进注释，没有假装已验证）：
1. 真服务端会把验证码拿去校验会话；假桥没有会话，只做非空（与库存域 `tag.batchBindWithCaptcha` 同口径）
   → **"验证码填错会被拒"在开发态验不到**。
2. 真服务端校验旧密码（错误返回 400）；假桥的登录接受任意口令，它不知道当前口令是什么，
   硬编一个只会制造"我明明用这个登进来的却改不了密码" → **只做非空与长度，旧密码错误分支开发态验不到**。

### 交付的 4 屏（+ 顺手修掉的两个缺陷）

| 屏 | 文件 | 行数 | 桥方法 |
| --- | --- | --- | --- |
| 消息中心 | `MessageListView.vue` | 512 | `message.list` / `unreadCount` / `markRead` / `markAllRead` / `clear` + `user.current` |
| 消息详情 | `MessageDetailView.vue` | 219 | `message.detail`（进门自动标已读，失败静默） |
| 用户管理 | `UserListView.vue` | 863 | `user.list` / `detail` / `roles` / `create` / `deleteWithCaptcha` / `resetPassword` |
| 个人设置 | `ProfileView.vue` | 660 | `profile.get` / `settings` / `update` / `settingsUpdate` / `user.current` / `user.changePassword` |

**缺陷 F4 —— `enabled` 传成了当场求值的布尔（静默不取数）**
`UserListView` 里写成 `useResource('user.detail', params, { enabled: selected.value !== undefined })`。
`enabled` 在 setup 那一刻就被求值成 `false`，而资源层内部是 `toValue(options.enabled)` ——
拿到的是一个**常量**。于是点行之后 watch 确实因为 key 变了而触发，但 `if (on) load()` 里的 `on` 恒为 false，
**一次请求都不发**；界面不报错、不转圈，只稳定显示一句「资料暂时取不到」，
看起来完全像"后端没这条数据"。

定位它的过程本身值得记：先给假桥加了一个**记录调用的壳**，看到点行后 `__calls = []` ——
这一下就把"后端没数据 / 前端没发请求"分开了。全仓扫 `enabled:` 只有这一处是这么写的（其它屏都是
`hasTarget` / `hasId` / `hasReceiver` 这类 computed）。

**缺陷 F5 —— `cache.invalidate('user')` 会连 `user.current` 一起删掉（侧栏名字/职位会掉）**
审查发现的：`invalidate` 按**键前缀**删缓存，`'user'` 覆盖 `user.current` ——
而左侧栏账号区（`AppFrame.vue:108`）读的就是它，且资源层**不会因为 invalidate 自动重取**，
所以「用户管理」里点一次刷新，左下角的名字会掉回会话语义、职位会空掉，**刷新页面之前回不来**。
改成逐条点名 `user.list` / `user.detail` / `user.roles`（并显式 `reload()` 选中的明细），
既保住了"写完再看一眼是新值"，又不误伤侧栏。

### 新增门禁 `check:enabled-option`（F4 的静态护栏）

`enabled` 只能是 ref / computed / getter：布尔字面量或含比较、逻辑运算符的当场表达式一律报错，
报错信息里直接写清"它不会随依赖变化，资源会永远停在'不发请求'的状态（界面只显示空态，不报错也不转圈）"。
**做过变异验证**：临时造一个 `enabled: selected.value !== undefined` 的 .vue → 门禁红且指到具体行；
删掉 → 恢复绿（扫描 14 个含 `enabled` 的 .vue）。

### 「我的」域验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿**（本轮新增 `check:me-mock` 72 例、`check:enabled-option`） |
| 类型 | `pnpm typecheck` | exit 0，**0 错误** |
| 构建 | `pnpm build` + `check:budget` | 首屏 **94.8KB gzip**；**62 个 chunk** 全 ≤130KB；首屏无 DataTable/DatePicker |
| 双端冒烟 | `pnpm check:web-smoke` | **174/174**（本域新增 29 条） |

冒烟里这几条是行为证据：
- 「未读 N 条」必须**等于**列表里「未读」的行数，点一条未读后两者**同时**减一（防止数字是画上去的）。
- 建号之后列表真的多一行、页头总数同步变 7；删号要验证码，没填验证码时**删不掉并就地说明原因**。
- 点行之后**必须发出 `user.detail` + `user.roles` 两次请求**（F4 的回归护栏）。
- 列表刷新之后**侧栏账号区的名字/职位仍在**（F5 的回归护栏）。
- 三个写操作各自给出自己的反馈，改密码成功后清空三个输入框。

### 整栈里程碑：**可达屏全部迁完，占位屏归零**

`check:navigation-web` 现在报「已迁入屏 28 个」，且**不再打印"还有可达目的地没有对应屏"的提示** ——
也就是说 16 个导航叶子 + 12 个目的地全部有真屏，`PlaceholderView` 已经没有任何路由会落到它。
React 版的删除（V6）从"能不能删"变成了"什么时候删"的排期问题。

