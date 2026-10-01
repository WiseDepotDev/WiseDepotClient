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

## V6 执行记录 · 删除 React 版（2026-10-02）

```
Anti-Entropy Declaration:
- Deletion Class: code-retirement（内部代码 / 重复所有者）+ derived-state（陈旧打包产物）
- Old Path: packages/{features,shells,patterns}、apps/web/src/{App.tsx,main.tsx}、
            tools/check/{shell-render-entry.tsx,check-shell-render.mjs,check-ui-language.js}、
            apps/web/spike 脚手架、packages/scan 的两个 React hook、
            apps/web/dist 与 apps/desktop/release（未跟踪产物）
- Invalid Responsibility: 同一个 UI 存在**第二个所有者**（React 屏/外壳），且已无任何屏落在它上面
- Legitimate Capability Remaining: 无（两个纯规则模块的职责已由 apps/web 那份唯一承担）
- New Canonical Owner: apps/web/src/views/** + packages/{ui,layouts,stores,tokens,bridge-*}
- Expected Preserved Behavior: 28 屏、25→24 条门禁、174/173 条冒烟断言、桌面/手机两宿主
- Expected Retired Behavior: React 渲染路径、Naive 主题链、只扫 .tsx 的文案门禁
- External Boundary Touched: no（未改 bridge 协议、后端、手机壳）
- Source-of-Truth Data Risk: none
Retirement Decision:
- Path: delete-first
- Why: 纯内部退役；无外部契约、无持久化状态；且每个被删门禁的责任都已先交给新所有者
```

**先冻结，再删**：仓库里**一个 git tag 都没有**（计划里 V0-2 那条"打回滚 tag"实际从未执行），
所以第一步是把当时的工作区按客户端范围提交（`cd46199`）并打 `v0-react-freeze`；
`bridge/**`（你已有的改动）明确排除在外、保持工作区原样。
恢复方式：`git checkout v0-react-freeze -- packages/features packages/shells packages/patterns apps/web/src/App.tsx apps/web/src/main.tsx`。

### 门禁：一条条问"它的责任由谁接"，然后改指或退役

| 门禁 | 处置 | 为什么 |
| --- | --- | --- |
| `check:render` | **换成** `check-vue-render.mjs` | 原版用 `react-dom/server` 渲染 React 外壳。新版用 Vite `ssrLoadModule` 渲染 Vue 外壳 + **注册表里每一屏**（30 用例）—— 用例来自注册表本身，以后新增屏自动覆盖 |
| `check:state` / `check:stockorder` | 改指 `apps/web` 那份 | 两个纯规则模块的唯一所有者变了 |
| `check:parity` | 改指 Vue 注册表 | 数据源 `registry.tsx`→`views/registry.ts`，25 条映射 `.tsx`→`.vue`，`docs/feature-parity.md` 重生成 |
| `check:navigation` | 改指 Vue IA | 改读 `packages/layouts/src/navigation.ts`，并扫 `router.push({name})`（16 处）。**它独有的价值**（手写的导航目标拼错 → 点了没反应）`check:navigation-web` 看不到，所以是改指不是删 |
| `check:session` | 改指 `@wise/stores` | 会话订阅与 `humanize` 的新拥有者 |
| `check:store` 的副本漂移对 | **退役** | 副本没了。留着的话两侧少一边时循环会 `continue` —— 一条**永远绿的假门禁**，比没有更糟 |
| `check-no-react` | ALLOWED 清空 | 语义升级为"**0 React**"：任何 .tsx/.jsx、任何 react 依赖声明立刻红 |
| `check:ui`（只扫 .tsx） | 删除 | Vue 侧由 `check:ui-web` 承担 |

### 两个"删了之后才暴露"的真缺陷

1. **`useScanGun` 在 setup 里直接读 `window`** —— 新的 Vue 渲染门禁**第一次运行**就抓到它：
   SSR 下 `ReferenceError: window is not defined`，整屏 setup 崩。按 `useViewport` 已有的同款守卫修掉
   （无 window 时**不挂监听**，而不是抛异常）。
2. **冒烟的路由预热跑在登录之前**（它自己的注释写着"必须先预热 chunk"）：没登录时每次 `location.hash`
   都被会话闸门挡回 `#/login`，**一个 chunk 都没预热到** → 依赖到 5/6 阶段才被 Vite 发现 →
   补优化触发整页 reload → 会话丢掉 → 后半段 34 条断言连片失败。修法：预热挪到 `ensureSignedIn()` 之后，
   并去掉末尾那次只为"拿干净状态"的 `location.reload()`。

一个被删除脚本顺带暴露的**门禁自身缺陷**：`check-navigation` 的 `DESTINATIONS` 正则从**文件开头的注释**里
那第一次出现的 "DESTINATIONS" 开始匹配，一路吃到 `DOMAINS` 的 `= [` —— 于是"目的地表"抓成了叶子表，
13 处误报。锚点收紧为 `export const DESTINATIONS`。（误报把 13 处真实导航调用点列了出来，反而证明扫描是有效的。）

### V6 验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **24 条全绿**（少一条 `check:ui`，`check:render` 换实现） |
| 类型 | `pnpm typecheck` | exit 0，**0 错误** |
| 构建 | `pnpm build` + `check:budget` | 首屏 **94.8KB gzip**、62 chunk 全 ≤130KB，产物里**已无 `vendor-react`** |
| 双端冒烟 | `pnpm check:web-smoke` | **173/173** |
| 宿主边界 | `pnpm desktop:smoke` | **通过**：真 Electron + `app://wise` origin + 真桥子进程 + Vue 登录屏 |

删除规模：跟踪文件 68 个（外加忽略产物 `apps/web/dist`、`apps/desktop/release` 共 219 个文件）。

### 三处"看着像死代码、其实不是"的判断（都留了）

- **`PlaceholderView.vue` 没删**：它不只是"未迁移屏的兜底"，还是**未知 hash 的 404 落点**；
  而且 `screenFor(...) ?? PlaceholderView` 对未来"先加 IA、后加屏"的中间态是有用的护栏。
- **`apps/web/spike/results/*.json` 留了**：那是被 `v1-spikes.md` 直接引用的**证据数据**（不是代码），
  删掉就再也复核不了"当初为什么这么选"。同目录的脚手架代码（跑不起来的 Naive/React 探针）已删。
- **`spike/lib/cdp.mjs` 不是 spike 遗留**：它唯一的消费者是浏览器冒烟。已移到 `apps/web/smoke/lib/cdp.mjs`
  （第一次删过头导致冒烟直接起不来，属于典型的"删载体时没看消费者"）。

## V6 之后 · 收口两件事：移植期零功能缺口（有证据）+ 接上服务端搜索

### 一、"移植有没有漏掉功能"这个问题，用三方对账回答

做法：把**契约 167 条方法**、**React 版真实调用点**（源码从回滚点 tag 取）、**Vue 版真实调用点**三方对一遍，
只统计真实调用（先把注释剥掉），而不是凭印象列 TODO。

结论：**零功能缺口**。最后剩的 6 条差异全部可解释：

| 差异 | 真相 |
| --- | --- |
| `device.byCode` / `device.detail` / `tag.byCode` / `tag.detail` | 方法名由**路由决定**（`byCode ? 'device.byCode' : 'device.detail'`），静态扫描看不到 —— 不是没接 |
| `auth.login` / `captcha.generate` | V6 前就搬进了 **store 层**（`cache.mutate('auth.login')` / `cache.run('captcha.generate')`），屏里只管表单 |

这个过程本身踩了两次"口径不准"，都记下来：第一次把**注释里提到的方法**算成了调用点（多报 2 条），
第二次把泛型写成了必选、漏掉了 Vue 里 `useMutation('x')` 的写法（多报 20 条假缺口）。
**判据必须先校准再下结论** —— 否则一份"看起来很像证据"的清单会把结论带偏。

### 二、`inventory.search`（原先记的"待接服务端搜索"）—— 接之前先读服务端

读源码发现这个接口**和它的名字不一样**：
- 必填 `keyword` + `type`，`type` 只认 `PRODUCT` / `LOCATION`，**其它值回空数组**（不报错）；
- `PRODUCT` → 按**商品名**查商品，且硬截断前 100 条；
- `LOCATION` → 方法名叫 `searchInventoryByLocation`（像"按货位搜"），实现却是
  `productRepository.findByNameContaining(keyword)` 再取这些商品的库存行 ——
  **按商品名匹配的库存全量**，既不按货位、也不分区。

所以接法是"把它用在它真能做的事上"，而不是照名字接：
1. 有关键词时把查询**发给服务端**（`type=LOCATION`）→ 商品名命中时拿到**跨页**结果；
2. 服务端没命中（关键词是货位/编码/仓库）→ **回退到本页筛选**，并把口径写在界面上：
   「服务端没有商品名匹配；下面是本页含「x」的记录」；
3. 命中时标签写「服务端按商品名搜索「x」· 跨页 N 条」；空结果的空态写「服务端只按商品名搜索」；
4. **搜索失败不等于"没有结果"**：`StateHost` 的三态跟着当前生效的那一路走（三态绑错源就会出现"错的是 A、画的是 B"）。

新增门禁 `check:inventory-mock`（15 用例）钉住的正是"**假桥要和服务端一样笨**"：
按编码搜不到、按货位搜不到、`PRODUCT` 回的是商品而不是库存行、空词回空数组 ——
假桥若比服务端聪明，界面就会在开发态一切正常、到真机上搜不到东西。

> 顺带一个门禁有效性的实证：写这段时我自己把 `{ enabled: applied.value !== '' }` 写成了常量，
> **被上一轮刚加的 `check:enabled-option` 当场拦下**（同一个 F4 类错误）。这条护栏第一次实战就抓到了新代码。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿**（新增 `check:inventory-mock` 15 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **94.9KB gzip**、62 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **178/178**（新增 5 条：服务端搜索确实被请求 / 命中口径 / 未命中回退口径 / 空态说法 / 清空回列表） |

### 三、商品**编辑**（`product.update`）—— 又一次"先读服务端再动手"

`product.update` 是**部分更新**，不是覆盖（`InventoryApplicationService#updateProduct`）：
`productName` / `productCode` / `unit` **空白 = 保留原值**；只有 `model` 是"不是 null 就写"（传空串 = 清空型号）。

这对界面有两个后果，都落进了实现：
1. **表单必须预填**当前值 —— 否则用户以为"只改型号"，实际把名称/编码一起留空（服务端会静默保留旧值，
   表面上"成功了"，但用户的心智模型是错的）；
2. 名称与编码在**界面侧仍然必填**（虽然服务端允许留空）—— 服务端留空 = 悄悄保留旧值，
   而用户清空输入框的意图显然是"改掉它"；与其让操作静默失效，不如当场拦住并说清。

假桥按同一语义实现，`check:inventory-mock` 加 9 个用例钉住它：空值保留、空白串也算"没传"、
`model` 空串清空、改完**读回来**是新值、改名后旧名不再被搜索命中（数据只有一份）。
冒烟加 5 条：编辑弹窗标题 / 表单预填当前值 / 保存真的调用 `product.update` 且带 `productId` / 改完列表显示新值且名称没被擦掉。

### 本轮最终验收（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿**（`check:inventory-mock` 现 24 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **95.0KB gzip**、62 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **183/183** |
| 文档一致性 | `gen:parity` + `check:parity` | 商品屏的映射补上 `product.update` 后重生成、校验通过 |

### 四、仓库**编辑**（`warehouse.update`）—— 同款做法，但语义**相反**

`WarehouseApplicationService#updateWarehouse` 四个字段都是 **`!= null` 就写**：
也就是**传空串 = 清空**，而不是"保留原值"—— 与 `product.update`（`productName/Code/unit` 用 `isBlank`）**正相反**。

把两者写成同一套，界面上就会出现"清空地址没生效"或"只改名字却把地址擦了"这类**静默差异**。
所以：假桥分别实现两种语义，`check:inventory-mock` 里两边的用例**并排**放着（商品：空串保留；仓库：空串清空），
谁改成另一套都会红。顺带把 DTO 里本来就有、但界面一直没维护的 `description` 补进表单与列表（V6 前它是"只读字段"）。

冒烟加 5 条：编辑弹窗标题 / 预填（含描述）/ 保存真的调用 `warehouse.update` 且带 `id` / 列表显示新描述且名称编码没被擦掉 / 原有删除断言仍成立。

### 本轮最终验收（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿**（`check:inventory-mock` 现 31 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **95.2KB gzip**、62 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **188/188** |
| 文档一致性 | `gen:parity` + `check:parity` | 商品屏与仓库屏的映射都补上 update 后重生成、校验通过 |

## V6 之后 · 第三轮：登录态、手机端、应用中心与"看板的 0"（2026-10-02）

这一轮的四个提交（`761403f` / `8416eb9` / `2c1cb23` / `5a7daa1`）加上本轮第 5 件事一起记账。
共同点：**四条都是"真机上才看得见"的问题** —— 开发态（有数据的假桥 + 桌面宽度）全部是绿的。

### 一、登录态过期要自己回登录屏，且要能按需复现（`761403f`）

需求是"登录过期后自动回登录屏重新登录"。这条链路上有三件事只有**真过期**才看得见，缺一个都会做假：

1. 界面是否**自动**回登录屏（而不是等用户点一下才跳）；
2. 登录屏有没有说明**为什么**被踢出来（不然用户以为是系统坏了）；
3. 过期后 `bridge.session` 必须报"未登录"，否则界面会继续画上一份数据。

真机上"登录过期"通常要等令牌自然到期，没法按需复现 —— 所以加了一个开发态开关
`window.__bridgeMock.expireSession()` / `restoreSession()`，并推一条**真宿主会推的**同款事件
（`BRIDGE_EVENT_SESSION_EXPIRED`）。这是 `setBackendDown` 的同款思路：**"状态显示是真的"这条，
没有制造故障的开关就只能靠嘴说。**

落地：`App.vue` 里 `watch(session.authenticated)`，从"已登录 → 未登录"且当前路由不是
`meta.always` 时 `router.replace({name:'auth.login'})`；登录屏据此渲染 `.w-login__expired` 提示条。
门禁 `check:session-expiry` 改指 `packages/stores`（V6 后会话状态的属主在 store，不在屏里）。

### 二、手机端 UI 第一遍重排（`8416eb9`）

真机上暴露的问题不是"不好看"，而是**结构重复与散架**：

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| 页面上方出现两行几乎一样的标题 | 手机壳的 `ContextHeader` 显示 `pageTitle`，而每屏自己又有一个 `PageHeader` | 手机壳改显示 **`domain.label`（域）**，屏内标题归 `PageHeader` |
| 卡片与操作按钮挤成一列，一行一个字 | 卡片列表把操作区**嵌在**卡片按钮里 | `ResponsiveDataView` 改成 `<li class="w-cardrow">` 包住 `<button class="w-card">` + `.w-card__actions` 并列 |
| 工具区散成三行 | 输入/下拉/日期各自独占一行 | `.w-toolbar > .el-input/.el-select/.el-date-editor { flex: 1 1 45%; min-width: 0 }` |
| KV 面板左列宽窄不一，右侧被截 | 手机宽度下仍用桌面栅格 | `@media (max-width:599px)` 下 KV 收成 `auto minmax(0,1fr)` |
| 分页条在没有下一页时仍给一个按钮 | 没判 `hasMore` | `PaginationBar` 无下一页不出按钮；单页时区间文案收成「共 N 条」 |

### 三、"记住登录"在真机上不生效 —— 真缺陷，根因是**启动顺序**（`2c1cb23`）

现象：WSA 冷启动落在 `#/login`，而宿主日志明明写着「已从本机恢复登录态」，
且 `filesDir/bridge-session.enc`（436B）确实活着。**"凭据在"和"界面进了"是两件事。**

根因：`main.ts` 里 `app.use(router)` 会**立即触发首次导航**，而它排在 `await session.init()`
**之前** —— 路由守卫读到的 `authenticated` 还是初值 `false`，于是把用户判成未登录并打发到登录屏。
启动顺序固化为：

```
createApp → use(pinia) → attach(桥) → startProbe → await session.init() → use(router) → router.isReady() → mount
```

教训：**"先挂路由再等状态"这类顺序问题，在桌面上会因为状态结算快而看不出来，只在真机冷启动上暴露。**
验证方式是在 WSA 上冷启动截图（`wsa-06-persist-fixed.png`）。

### 四、首页改成「应用中心」（`5a7daa1`）

原来的首页是看板，而看板回答不了"我要的功能在哪"。改成**按域分组的应用中心**：
分组来自 `@wise/layouts` 的 `DOMAINS`，每个叶子挂一行 `LEAF_NOTES`（按 `primaryMethod` 索引），
点条目直接 `push(leaf.path)`。两点是刻意的：

- **不做九宫格**：九宫格只放得下图标，说不清"这屏要带参数才能进"；
- **入口不漂移**：条目由 `DOMAINS` 生成而不是手抄一份清单 —— 导航加一个叶子，首页自动多一个入口；
  需要带参数的页（详情类）在页面上如实说明"从列表点进来"。

### 五、看板的 4 个 0：直连真后端查清是"真没有"还是"没接对"（本轮）

现场打开看板看到 **库存总量 0 / 今日告警 0 / 巡检进度 0% / 设备在线 0** —— 四个 0。
这种画面有两种完全相反的成因，处置方式也相反：**库里真的没有**（去入数据）还是**字段没接对**（去改代码）。
所以没有改代码，先直连真后端把口径查清（登录走 `deploy/.env.local` 的 Redis 取验证码答案，不打印任何密钥）：

| 探针 | 真后端返回 | 结论 |
| --- | --- | --- |
| `GET /api/dashboard/summary` | `inventoryTotal:0, todayAlertCount:0, inspectionProgress:0, deviceOnlineCount:0`，但 `unprocessedAlerts` **非空**（1 条，2026-09-18） | 四个 KPI 都是 0，而告警列表有数据 → 不是"整屏没接到数据" |
| `GET /api/inventories?page=1&pageSize=5` | `total=0` | **库存表确实是空的** |
| `GET /api/inventories/statistics/total` | `0` | 同上（聚合与列表一致） |
| `GET /api/inventories/statistics/by-location` | `[]` | 同上 |
| `GET /api/inventories/alerts/low-stock` | `[]` | 同上 |
| `GET /api/device/statistics` | `totalDevices:3, onlineDevices:0, offlineDevices:3` | **3 台设备全部离线** → `deviceOnlineCount:0` 是对的 |
| `GET /api/inspection/task/page` | `total=7`，无 `status=1`（进行中）的任务 | 没有进行中任务 → `currentTask` 为空 |
| 当天日期 | 2026-10-01，最新告警 2026-09-18 | **当天确实没有新告警** |

**结论：客户端的字段映射与聚合没有缺陷，这四个 0 是真实数据。** 因此不做"把 0 变好看"的改动。

但"一屏 0"本身仍然是个真问题：**0 不能自证**。所以只改展示层（`DashboardView.vue` 的 `metrics`
加 `note`，数据全部来自本屏这一份 `dashboard.summary`，**不额外发请求、不改契约**）：

| KPI 为 0 时 | 副标题 |
| --- | --- |
| 库存总量 | 库存表还没有数据 |
| 今日告警（无未处理） | 今天还没有新告警 |
| 今日告警（有历史未处理） | 另有 N 条未处理告警 ← **不能和上一句合并**，否则会被读成"没有告警" |
| 巡检进度 | 当前没有进行中的任务 |
| 设备在线 | 当前没有在线设备 |

> 顺带记一条**服务端口径事实**（不改后端，只记下来）：`inspectionProgress` 读的是 Redis 键
> `inspection:progress`（`DashboardApplicationService:72`），由进行中的任务写入；没有进行中任务时它天然是 0。
> 所以"有 7 条历史任务、进度却是 0%"不是 bug。

假桥平时给的是有数据的那份（`inventoryTotal: 1284`），所以加了开发态开关
`window.__bridgeMock.emptyDashboard(true|false)` 把空库那一份调出来 —— 真后端没法按需清库。
冒烟新增 8 条，**先把有数据态断言完，再切空库断言副标题，然后切回来重取**（不能把空库态留给后面还会回看板的阶段）。

### 六、应用中心补图标 + 补一条漏掉的说明

入口从"文字列表"改成"图标 + 标题 + 一句话"：图标键取 **`primaryMethod`**（与 `LEAF_NOTES` 同源），
所以标签改名时图标不会跟着漂；图形只从 Element Plus 自带那套里挑（本仓不自造图标资产），
缺省退回 `Grid` —— 宁可图标普通，也不要空一块。

三处刻意的选择：

- **图标底盘 32px / 淡主色**（`--w-size-mark-size` + `--w-color-primary-soft`，就是侧栏"当前项"那一档）：
  整屏仍是白底白卡，彩色只出现在这 32px 里 —— 图标负责"扫一眼分辨"，面积不能抢内容。
- **入口最小宽度单独取 280px**（不是通用的 `--w-size-card-min-width` 200px）：这里的副标题是一整句说明，
  200px 下会折成三行，一行高度对不齐、看着像排版坏了。
- **补齐 `stockOrder.create` 的说明**：它是 17 个叶子里唯一没有 `LEAF_NOTES` 条目的，
  一直退到兜底文案「库存域的功能」——**兜底文案能跑不等于说得对**，一并补成「新建一张出入库单：选仓库、加明细，再提交审核」。

> 冒烟新增 1 条，且**只数真的画出了 `<svg>` 的入口**：只断言"入口数量对"拦不住图标写错 ——
> 图标名拼错时那一格只是空着，数量、文案、点击全都没问题，而缺省退回 `Grid` 让"少一个图标"更看不出来。
> 宽屏与手机两档都截图看过（3 列 / 1 列），不是只跑门禁。

### 七、冷启动恢复登录态之后，界面说不出"我是谁"

在 WSA 上冷启动看到应用中心写着 **「已登录」**（应该写账号名）。查下来是同一条病根的另一半：

| 事实 | 依据 |
| --- | --- |
| 桥的 `username` 是**进程内字段**，登录响应经过时写一次 | `bridge/server/.../SessionManager.kt:34,54` |
| 持久化的只有**令牌**，不含用户名 | 同上 `:43` `authenticated = tokens.accessToken() != null`；用户名不在持久化里 |
| 所以冷启动恢复后 `authenticated == true` 而 `username == null` | 真机现象：界面只剩一句"已登录" |
| 真值只能问服务端，且**恢复态下同样可用** | 实测 `GET /api/users/current` → `{"userId":1,"username":"admin","nickname":"系统管理员","role":"ADMIN"}` |

**同一个概念原先有两个属主**（重复，迟早漂移）：

- `AppFrame.vue` 自己算一份：`user.current.nickname → username → session.username → '未登录'`
- `HomeView.vue` 只看 `session.username`，没有就写"已登录"

于是同一台机器上会出现"侧栏写着系统管理员、首页写着已登录"。修法是**收成一个出处**：
新增 `@wise/stores` 的 `useCurrentAccount()`（姓名 + 职位 + 取数状态），两个消费者都读它；
`session.username` 降级为"登录后那一瞬"的同步兜底。顺带把兜底里那句 **'未登录' 改掉** ——
恢复态下用户**是**已登录的，这话曾经会闪一帧假的。

同时把 `AppFrame` 里那句欠账还了：注释写着「`user.current` 本次首次接线，**发布前需要拿真后端核一次响应字段**」——
现在核过了（上表第 4 行的实测响应），字段与代码一致。

> **不改桥**。把 `username` 一起持久化才是更彻底的做法，但那要动 `bridge/**`（协议与持久化状态，
> 且当前那份 Kotlin 是用户未提交的在制品）——按界线只做 Web 侧，把结论记在这里。

#### 顺带查实的一处**口径分歧**（本轮不改，只记账）

"角色码 → 业务叫法"在客户端有**三份**拷贝：`packages/stores/src/account.ts`、`me/UserListView.vue`、
`me/ProfileView.vue`（后两处注释里自己写着"与另一屏同一份口径"）。三份彼此一致（`ADMIN` → 管理员、
`USER` → 普通用户、认不出的原样显示），所以**客户端内部没有漂移**；但与服务端自己的映射不一致：

| 出处 | `USER` 的说法 |
| --- | --- |
| 服务端 `UserApplicationService#mapRoleCodeToName` | **访客** |
| 服务端 `RoleMapper#mapRoleNameToCode` | 操作员 / 访客 / 其它 → 都压成 `USER`（**有损**） |
| 客户端三处 | 普通用户 |

而且假桥里的角色码是 `OPERATOR` / `VIEWER` —— 服务端**只产出** `ADMIN` / `USER`（`RoleMapper` 全表），
于是开发态侧栏显示的是裸码 `OPERATOR`。这不是谎言（界面本来就规定"认不出的码原样显示"），
但**假桥教给界面的词表是服务端不会说的**。三份拷贝 + 词表分歧一起收口涉及两屏与 72 条 `check:me-mock`，
单独一轮做，本轮只留下这份证据。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿** |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **96.0KB gzip**、66 chunk 全 ≤130KB |
| 渲染门禁 | `pnpm check:render` | **31 用例全绿**（注册表每一屏都渲染得出且有页头标题） |
| 双端冒烟 | `pnpm check:web-smoke` | **227/227**（原 217 + 空库自证 8 条 + 图标 1 条 + 账号同源 1 条） |
| 真机 | WSA 冷启动 | 重打包 `assembleDebug` + `adb install -r` 后应用正常启动、桥连到真后端；<br>**"恢复态账号名"这一条没能在 WSA 上截到图**（WSA 前台被抢 + WebView 恢复滚动位置），<br>该性质由冒烟里的"首页账号名 == 侧栏账号名"两条断言守住 |

## V6 之后 · 第四轮：角色词表收口（2026-10-03）

### 一、先纠正上一轮自己记错的一条

上一轮我写「服务端自己的映射是 `USER` → 访客，客户端说'普通用户'与它不一致」——
**这条结论错了，是查得不彻底**。把 `mapRoleCodeToName` 的调用点读到底才发现：

```
UserApplicationService#updateRole(userId, roleCode)
  → String roleName = mapRoleCodeToName(roleCode);      // ADMIN→"管理员"，USER→"访客"
  → roleRepository.findByName(roleName)                 // 拿着这个名字去库里查角色
```

它是**写路径**（把客户端传来的码翻成数据库里的 `Role.name` 再去查），**不是显示口径**。
而服务端的**显示口径根本不下发中文名**：`UserDTO` 只有 `role` 一个字符串，
值是 `roles.get(0).getRoleCode()`（`toUserDTO`）—— 也就是只有 `ADMIN` / `USER` 两个码。
所以"客户端说'普通用户'与服务端口径不一致"这个前提不成立。**先下结论再去找证据，就会得到这种结论。**

### 二、把有损性摆到台面上：`USER` 到底是什么

| 事实 | 依据 |
| --- | --- |
| 种子角色是**三个中文名** | `DataInitializer:240-242` → `1 管理员 / 2 操作员 / 3 访客` |
| 但读出来的码只有**两个** | `RoleMapper#mapRoleNameToCode`：管理员→`ADMIN`；操作员 / 访客 / 其它 → `USER` |
| 写路径把 `USER` 落到**"访客"**角色 | `UserApplicationService#mapRoleCodeToName`：`USER` → `"访客"` |

所以 `role === 'USER'` 的账号，真实角色可能是操作员、也可能是访客，**客户端无从分辨**。
任何具体词都会指错一半：写"访客"会把操作员说成访客，写"操作员"会把访客说成操作员。

因此收口后的 `roleLabel` 保留中性说法 **"普通用户"**（不指错），并把这段有损性写进函数注释；
要看"这个人到底是操作员还是访客"，得读 `user.roles` 的 `RoleDTO.name`（服务端下发的原名）——
用户详情屏本来就是这么做的（角色 chips 直接显示 `role.name`）。

### 三、三份拷贝收成一份

`roleLabel` 原先在**三个文件**里各写一份（`stores/account.ts`、`me/UserListView.vue`、`me/ProfileView.vue`，
后两处注释还写着"与另一屏同一份口径"——**靠注释维持的一致不是一致**）。
现在只留 `@wise/stores` 里那一份，签名 `roleLabel(role): string | null`：

- 有角色 → `管理员` / `普通用户` / 认不出的码原样显示；
- 没有角色 → 返回 `null`，**空态措辞留给调用方**（账号块说「职位未登记」、用户管理说「未指派角色」）
  —— 事实是同一个，语境不同措辞可以不同，不该为统一措辞而让某一处读起来别扭。

### 四、假桥的词表也要对齐（否则开发态教的词是真机不会说的）

假桥原先的角色码是 **`OPERATOR` / `VIEWER`** —— 服务端**永远不会产出**这两个码。
后果是开发态侧栏显示裸码 `OPERATOR`，而真机显示"管理员/普通用户"：**同一屏两套词表，开发态看不出来**。

收口内容：

| 位置 | 改动 |
| --- | --- |
| `mock-me.ts` 用户表 6 条 | `OPERATOR` / `VIEWER` → `USER`（admin 仍是 `ADMIN`） |
| `mock-me.ts` 角色目录 | 与服务端种子**逐字一致**：`1 管理员 / 2 操作员 / 3 访客`，后两个 `roleCode` **都是 `USER`** |
| `mock-me.ts` `user.create` 默认角色 | `'VIEWER'` → `'USER'`（服务端 `RoleMapper` 对 null 也回 `USER`） |
| `mock.ts` 静态 `user.current` | `role: 'OPERATOR'` → `'USER'` |

新增 **3 条护栏**（`check:me-mock`，72 → 75 用例）钉住它，且第一条直接对着"假桥要比真后端老实"这件事：

1. 假桥里的用户角色码只能是 `ADMIN` / `USER`；
2. 角色目录的 `roleCode` 同样只能是这两个（**两个中文角色名共用一个码是有意的**）；
3. 同一用户的两个角色（操作员 / 访客）都落在 `USER` 上 —— 这是服务端 `RoleMapper` 的有损压缩，不是假桥的错。

> 护栏 3 的写法有点特别：它断言的不是"数据好看"，而是**"这份数据忠实于服务端的有损行为"**。
> 如果哪天有人把假桥改成"一个角色一个码"，这条会红 —— 那时应该改的是注释与判断，不是悄悄放过。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **25 条全绿**（`check:me-mock` 现 75 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **96.0KB gzip**、66 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **227/227**（侧栏账号区实测 `{"name":"现场操作员","role":"普通用户"}` —— 不再是裸码 `OPERATOR`） |

## V6 之后 · 第五轮：分页口径（2026-10-03）

### 一、先做探针，再动界面

为"库存 / 标签主数据 CRUD"这一批写了一份可复跑的真后端探针
（`tools/bench/inventory-tag-probe.mjs`，默认只读、`--write` 才写且用完即删）。
它一上来就把一件**读源码读不出来**的事钉死了：真后端的分页参数名**不是一个口径**。

| 桥方法 | 服务端参数名 | 证据 |
| --- | --- | --- |
| `alert.list` / `stockOrder.list` / `user.list` / `message.list` | `size` | `AlertController:83`、`InOutController:52`、`UserController:101`、`MessageQueryRequest` |
| `inventory.list` / `inventory.listAll` / `product.list` | **`pageSize`** | `InventoryController:149,246,276` |
| `tag.list` / `tag.byProduct` / `tag.search` | **`pageSize`** | `TagController:112,128,191` |
| `inspection.taskPage` | **`pageSize`** | `InspectionController:138` |
| `warehouse.list` / `device.list` / `inspection.planList` | **不接分页参数**（返回全量 List） | `WarehouseController:34`、`DeviceController:96`、`InspectionController:73` |

真后端实测（`GET /api/tag`）：

```
?size=1      → 7 条   ← 参数被静默忽略，退回默认 10 条/页（这里一共就 7 条）
?pageSize=1  → 1 条   ← 生效
```

**发错名字的后果是静默的**：不报错、不空白，只是"永远 10 条/页"。而 4 个屏
（`InventoryListView` / `ProductListView` / `TagListView` / `TagListView` 的商品选项）
一直在发 `size`。

### 二、假桥那句"两个名字都认"，和它引用的"实测"

假桥的 `page()` 原先**两个名字都认**，注释写着：

> 而 `inventory.list` / `user.list` 那两个是 `size`（`real-smoke.mjs` 实测发 `size` 就翻得动页）。

**这条结论是错的，而且"实测"实测的是假桥自己** —— 真后端只认 `pageSize`，`size` 被忽略。
假桥比服务端宽容，于是开发态翻得动页、真机永远 10 条。这正是本仓反复付学费的那类偏差
（`inventory.search` 那一轮也是"假桥不能比服务端聪明"）。

改法：`page(rows, params, paramName)` —— 参数名**由调用方按服务端事实显式给**
（`'size'` / `'pageSize'` / `null`），不再猜；`null` 的端点**全量返回、不自作主张截断**。

### 三、顺带发现两处"假分页条"（不可用按钮不得渲染）

`warehouse.list` 与 `inspection.planList` 服务端**不分页**，而这两屏各挂了一条 `PaginationBar`：
参数被忽略、数据也从来不切片，所以**第 2 页与第 1 页永远是同一批数据** —— 那是个点了没反应的装饰。

按本仓硬纪律（不可用的按钮不得渲染）整条去掉，条数改由页头说；`StockOrderCreateView` /
`InspectionTaskCreateView` 里传给 `warehouse.list` 的 `{page, size}` 也一并清掉
（传了被忽略，只会让下一个人以为它在起作用）。

### 四、新门禁 `check:page-params`

静态对照上面那张**服务端事实表**（带源码行号）与客户端实际传的参数名，48 个 `.vue` 全扫。

写它的过程本身踩了两个坑，都留在脚本注释里：

1. **按 `useResource` 调用点开窗口扫 → 只扫出 3 处**。因为这些屏的分页参数写在
   `const params = computed(() => ({...}))` 里再传进去，不在字面量里。改成**按文件判定**
   （一个屏只用一种口径），并对"一个文件混用两种"的情况**跳过并提示**而不是猜。
2. **负向断言会回溯**：第一版写 `size\s*:\s*(?!['"\`])`，`\s*` 先吃掉空格、断言失败，
   再退回只吃 0 个空格、断言就成功了 —— 于是 Element Plus 遍地的 `size: 'large'` 全部命中，
   `TagListView` 被误报。改成 `size\s*:(?!\s*['"\`])` 才对。
   **误报的门禁会被关掉，比没有更糟**，所以这条必须修干净才提交。

### 五、探针顺带钉死的三件后端事实（都影响界面怎么做）

| 发现 | 证据 | 对界面的影响 |
| --- | --- | --- |
| **`inventory.create` 在真后端上必然失败** | 实测 `HTTP 400 VAL-0001 请求参数校验失败: 仓库ID不能为空`（传了 warehouseId 也一样）；根因是实体 `Inventory.java:20` 的 `@NotNull` + `createInventory` 从不 `setWarehouseId` | 库存表空**不是"没人录"**，而是录入接口坏了 → 界面不提供"新建库存"（详见下一轮） |
| **tag 写操作不失效 `@Cacheable`** | 解绑后 `tag.detail` 仍回 `status=1 productId=7`（旧值），而 `tag.list` 已是 `status=0 productId=null`（真值）；`getTag` 带 `@Cacheable(timeout=1800)`，`update/delete/bind/unbind` 都没有 `@CacheEvict` | 标签详情屏"改完还是旧值"是**服务端缓存**，不是写失败 → 复核必须绕开 `tag.detail` |
| **`tag.batchUnbind` / `tag.batchQuery` 结构性不可达** | 两种 body 形态都 400：`{tagIds:[…]}` → `VAL-REQUEST-1001`；裸数组 `[8]` → 同样 `VAL-REQUEST-1001`（服务端签名是 `@RequestBody List<…>`，而被封校验要求信封对象） | 这两条方法在桥上调不通 → 界面不提供批量解绑/批量查询 |

### 六、冒烟里一处**测试脆弱性**（顺手修掉）

改完这批后冒烟开始出现 `响应式数据视图 · 桌面出表格（4 行） rows=2` 与"错误码没出现"，
而且**换一处无关改动就会波动**。根因不在产品，在断言：

> 组件预览页的等待条件是 `waitFor('.w-page')` —— 而 `.w-page` **上一屏也有**。
> `<RouterView :key>` 换屏的瞬间旧屏还在 DOM 里，于是 `waitFor` 立刻命中旧屏，
> 后面的断言跑在"旧屏 + 新屏加载中"的混合状态上。

改成等**预览页独有的东西**（4 张 KPI 卡），并在表格/错误码断言前各自显式等一次。
这不是"把红的调绿"：等待条件本来就该指向被测对象，指向一个到处都有的类名等于没等。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **26 条全绿**（新增 `check:page-params`） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **96.1KB gzip**、66 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **227/227** |
| 真后端探针 | `node tools/bench/inventory-tag-probe.mjs --write` | 16 项通过、1 项**如实失败**（`inventory.create` 不可用）；探针数据已删净 |

### 七、库存域的 create / update / delete：**先取证，再判定不提供**（不是没做）

这三条是清单里点名的，所以要给的是证据链，而不是态度。

**1. `inventory.create` 是做不到，不是不想做。** 2026-10-03 真后端实测：

```
不带 warehouseId  → HTTP 400 VAL-0001 请求参数校验失败: 仓库ID不能为空
带上 warehouseId  → HTTP 400 同样一句      ← 关键：传了也没用
```

根因：实体 `Inventory.java:20` 上有 `@NotNull(message = "仓库ID不能为空")`（JPA 的 bean validation 在
persist 时触发），而 `InventoryApplicationService#createInventory:254-259` **从不** `entity.setWarehouseId(...)`。
**这个接口无论传什么参数都建不出库存。**

> 这同时解开了上一轮那个谜：库存表 0 条**不是"没人录"，是录不进去**。
> 也印证了"先取证再下结论"——只看"用户没录数据"会把一个后端缺陷记成运营问题。

**2. 库存的唯一正规来源是出入库单。** 全仓 `inventoryRepository.save/delete` 只有两处来源：
`InOutApplicationService:360,379`（`processInventory`，单据流转）+ `InventoryApplicationService` 的
create/update/lock/unlock。

**3. 而"不提供直接改库存数"本屏早就写成了设计纪律**（`InventoryDetailView.vue:14-16` 原文）：

> 摆一个"改数量"的输入框等于绕过单据，是错的。

所以结论：库存域**只保留查询 + 锁定/解锁**，`create` / `update` / `delete` 都不进界面。
`inventory.delete` 同理 —— 删库存等于绕过单据造成账实不符，而且真后端是硬删、无软删、无幂等。

**但这一轮不是"什么都没做"**，交付的是"把路指对"：

| 改动 | 为什么 |
| --- | --- |
| 库存列表空态改指「出入库单」 | 原先写的是「前往「商品管理」新增商品后再入库」—— 商品管理里**没有"入库"这个动作**，用户去了会发现无路可走。库存的唯一来源是单据，文案必须指向那条路 |
| 库存详情加一句常驻说明 | 界面缺一个操作时用户会当成功能没做完：「库存数量由出入库单流转产生，这里不能直接改动。下面两个动作只调整「已锁定」的预留量…」 |
| 冒烟 +1 条 | 钉住上面那句说明真的渲染出来（**228/228**） |

> **真机上走不通的部分如实记下**：本机库里没有库存行（因为 create 坏了），所以
> 库存详情 / 锁定这一路**只在假桥下验证过** —— 真机路径要等库存真的产生出来才走得通。

## V6 之后 · 第六轮：标签域读写（2026-10-03）

### 一、批量解绑：服务端那条接口**调不通**，界面改成逐条

探针实测（`tools/bench/inventory-tag-probe.mjs`）：

```
POST /api/tag/batch-unbind  body {"tagIds":[8]}  → HTTP 400 VAL-REQUEST-1001 请求体解析失败
POST /api/tag/batch-unbind  body [8]             → HTTP 400 VAL-REQUEST-1001 请求体解析失败
```

服务端签名是 `@RequestBody List<Long>`（整个 body 就是数组），而网关的信封校验要求 body 是对象 ——
**两种形态都进不去**。而页面上的「批量解绑」按钮一直在渲染、点了必然失败。
假桥原先还能**正常**批量解绑，所以开发态一切正常、真机上怎么点都不成 ——
又是"假桥比服务端聪明"那一类（本仓已在 `inventory.search`、分页参数上各付过一次学费）。

改法：逐条调 `tag.unbind`，并如实汇总"成功几条 / 哪几条没成 + 原因"。
**必须串行，不能用 `Promise.all`**：资源层 `mutate()` 的单飞键是**方法名**
（`resource.ts` 的 `inflightMutations.get(method)`），并发发同一个方法会**共享同一个 promise** ——
一条请求的成败会被当成所有条的结果。串行还顺带做到"哪几条没成"说得清。

### 二、假桥的三处"如实复刻"

| 复刻 | 服务端事实 | 为什么必须复刻 |
| --- | --- | --- |
| `tag.batchUnbind` / `tag.batchQuery` **抛与真后端同一个错** | 两态都 `VAL-REQUEST-1001` | 假桥"帮它实现一遍"等于把一条走不通的路伪装成通的 |
| `tag.create` 带 `productId` 时 **`status` 仍是 0** | `TagApplicationService:80-95` 不按商品推导状态 | 界面因此不在新建表单里带商品；否则一建出来就是"有商品却未绑定" |
| `tag.update` 的**空白串 = 清空**、`null`/缺省 = 保留 | `isBlank() ? null : value`（与 `product.update` 的"空白=保留"**相反**） | 表单若不预填当前值，"清空输入框再保存"会**静默改库** |

### 三、标签详情：写操作成功后**不 reload**（这一条是本轮最贵的经验）

服务端 `getTag` 带 `@Cacheable(prefix="tag", timeout=1800)`，而 `updateTag` / `deleteTag` /
`bindTag` / `unbindTag` 上**都没有 `@CacheEvict`**。写完立刻重取会拿到**旧值**，
把刚写的东西在界面上一秒抹回去 —— 用户看到的是"操作没生效"。

真后端实测（同一条标签，解绑之后）：

```
GET /api/tag/{id}   → status=1 productId=7     ← 旧值（缓存）
GET /api/tag?…      → status=0 productId=null  ← 真值
```

所以详情屏用**写操作自己的响应**更新显示（服务端返回的就是改后的 DTO，是真值，不是乐观更新）。

> 这一步自己踩了一个坑：第一次只把 `items` 换成 `display`，页头的 `StatusChip` 还在读 `data` ——
> **冒烟当场抓出来**（「绑定后状态立刻变成已绑定」实测 `未绑定`）。这也说明那条断言写的正是要害。

### 四、界面新增 / 调整

- **标签列表**：新建标签（三个标识至少一个；**空字段不传**，不是传空串）、批量解绑改逐条、成功回执。
- **标签详情**：绑定商品（选商品）、解绑、改标识、删除标签（二次确认，并说明被巡检/单据引用时服务端会拒绝）。
  主操作按绑定状态**互斥**，符合既有的"主操作 ≤2"口径。
- 详情屏去掉重复的「刷新」（页头已有一个）—— 顺带修掉"同一个动作画了两遍"。

### 五、顺带修掉用户可见的 Markdown 星号（并加门禁）

`TagDetailView` 两个弹窗提示里抄进了注释用的 `**强调**`（HTML 里会**原样显示**成星号），
另外 `DeviceDetailView` 里**早就有一处**同样的（"这些参数在客户端**只能查看**"）。

补了一条门禁：`check-ui-language-web` 现在会拦文本节点里的 `**` ——
本仓注释与简报大量用 `**`，抄进文案非常容易漏（这一轮就漏了两次）。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **26 条全绿**（`check:inventory-mock` 42 → **54** 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **96.6KB gzip**、68 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **237/237**（新增 10 条，见下） |

新增的 10 条断言：批量解绑**逐条**发 `tag.unbind` 且**不发** `tag.batchUnbind` / 解绑成功回执 /
新建标签"至少一个标识"拦住 / 新建标签真的带上了条码 / 新建回执 /
详情绑定回执 / **绑定后状态立刻变**（钉住"不 reload"）/ **改标识后立刻显示新值**（同理）/ 删除后回列表。

## V6 之后 · 第七轮：权限管理（net-new，2026-10-03）

### 一、先确认这不是"移植缺口"

在回滚点 tag `v0-react-freeze` 上全代码面搜 `permission`：**无输出**（唯一命中的是生成物
`bridgeContract.ts` 自身）。旧 Android APP 同样零调用。所以这一族是**新做的**，
每条口径都对着真后端重新核过（`tools/bench/inventory-tag-probe.mjs`）。

### 二、三条实测事实，直接决定这一屏长什么样

| 事实 | 证据 | 界面的决定 |
| --- | --- | --- |
| `permission.list` 返回**裸数组、不分页** | `PermissionController` 的 list 没有 `page`/`size` 参数；实测 4 条 | **不画分页条** —— 画一条点了没反应的装饰违反"不可用的按钮不得渲染" |
| `permission.tree` 与 `list` **一模一样** | 实体与表都没有 `parentId`、`PermissionMapper` 也不填 ⇒ 四个节点全是根、`children` 是 `null`（实测 tree 4 个根 / children 非空 = false） | **不画树**：画出来是一排平行的根节点，那是把"没有层级"包装成"有层级"。界面上把这件事说出来 |
| `permission.create` 实测 **HTTP 500 `SYS-0001`** | `permission.create_by` / `update_by` 是 `NOT NULL` 且外键到 `user_core`，而 `PermissionApplicationService#createPermission` 从不设置它们 | **不提供"新建权限"**；`update` / `delete` 因未实测（delete 会撞 `role_permission` 外键，默认四条被角色引用着，拿它们去试等于修库）也**一个写入口都不提供** |

### 三、交付

- 新导航叶子**权限管理**（管理域，`/me/permissions`）→ 叶子 **17 → 18**、已迁入屏 **29 → 30**。
  首页应用中心**自动**多一个入口（含图标与一句话说明）—— 入口由 `DOMAINS` 生成，不手抄清单。
- 新屏 `PermissionListView`：清单（`permission.list`）+ 按编码查找（`permission.byCode`）
  + 点行取明细（`permission.detail`）。
- 假桥补 `permission.list` / `tree` / `detail` / `byCode`；**`permission.create` 复刻服务端 500**；
  `update` / `delete` **故意不实现**（没实测就不假装支持，由资源层如实报"未知方法"）。
  权限种子与服务端逐字一致（`user:view` / `user:create` / `user:edit` / `user:delete`）。

### 四、门禁与冒烟

- `check:me-mock` **75 → 84 用例**：裸数组 / 种子逐字 / tree 与 list 同形 / detail 与 byCode
  的命中与 404 / **create 复刻 500** / update 与 delete 不实现。
- `check:web-smoke` **237 → 243**：清单 4 行 / 本屏无分页条 / **对照屏确实有分页条**
  （证明上一条的选择器不是永远 0）/ 点行取到明细 / 按编码查找命中 / 不提供"新建权限"按钮。
- `docs/feature-parity.md` 重新生成（`gen:parity`）。

> 写"对照屏"那条断言时又踩了一次时序：库存屏的分页条在 `StateHost` **里面**，
> 骨架屏阶段不渲染 —— 第一版没等数据落地就查，拿到的 `missing` 是加载中的假象。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **26 条全绿**（`check:me-mock` 现 84 用例） |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 构建 | `pnpm build` + `check:budget` | 首屏 **97.0KB gzip**、69 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **243/243** |

## V6 之后 · 第八轮：手机端第二遍整理（2026-10-03）

### 一、手机壳的两处"恒真条件"（都是真机上才看得见的缺陷）

| 位置 | 原来的写法 | 后果 | 改成 |
| --- | --- | --- | --- |
| `AppFrame` 的情景头 | `v-if="isDetail \|\| domain.children.length > 0"` | 每个域都有 ≥2 个子项 ⇒ **第二个条件恒真** ⇒ 「返回」无条件渲染；而 `goBack()` 在非详情屏做的是"push 当前域的第一个叶子"（按钮名叫返回，做的是跳域首屏），已经在域首屏时**点了什么都不发生** | 条件如实表达"有没有上一屏可回"（`history.state.back` + 不在首页） |
| 分段控件 | `v-if="isCompact && useSegmented"` | **缺 `!isDetail`** ⇒ 概览域 / 管理域的详情屏照样画一排分段，而 `activeMethod` 由叶子算、详情路由取不到叶子 ⇒ **三个分段一个都不高亮** | 加 `&& !isDetail` |

顺带把 `goBack()` 的判据换掉：原来用 `window.history.length > 1`，在带登录页的 SPA 里**永远为真**，
等于把"有没有上一屏"恒定回答成"有"。现在读 vue-router 自己维护的 `history.state.back`。

### 二、动作坞**滚到底也压住内容** —— 实测确认，已修

R3 简报说"动作坞的 sticky 会盖住正文"。这句话是**中途遮挡**（浮动操作条的预期行为）
还是**滚到底也看不全**（真缺陷）？两者修法完全不同，所以先量了一次
（临时脚本读 `scrollTop / scrollHeight / clientHeight` + 最后一个内容块的 `getBoundingClientRect`）：

```
修复前（三个屏一致）：
  insp-detail-bottom   scrollTop 572 + clientHeight 697 = 1269 = scrollHeight   ← 确实滚到底了
  lastBlock.bottom 691  vs  dock.top 675                                        ← 被压 16px
  order-detail / message-bottom 同样被压同一段
```

**结论是真缺陷**（不是中途遮挡）：手机档给 `.w-page` 留出动作坞的高度
（`ui.css` 的 `@media (max-width: 599px)` + `:has(.w-actiondock)`）。复测：

```
修复后：lastBlock.bottom 635  vs  dock.top 659   ← 不再重叠
```

截图复核：巡检详情滚到底时「巡检结果列表」「手动补录」两个按钮**完整可见**。
这条已经写成冒烟断言（滚动到底后比较两者的 rect），所以它不会再被改回去。

### 三、去掉 4 屏重复的「刷新」

`AlertDetail` / `MessageDetail` / `DeviceDetail` / `StockOrderDetail` 的动作坞里各有一个「刷新」，
而页头**也有一个** —— 同一个动作画两遍。这 4 屏的动作坞里**只有**这一个按钮，
所以整条动作坞（含 import）一起去掉；页面刷新走页头那个。
（`TagDetail` 在上一批已经顺手去掉。）

### 四、**实测之后判定不做**的那件事：筛选入抽屉

R3 建议把手机端的筛选控件收进抽屉。我按它的指引去看了真实截图，结论相反：

| 屏 | 实际工具区 |
| --- | --- |
| 设备管理 | **2 行**：搜索 + 查找 + 全部 / 在线 + 离线 + 筛选本页 |
| 巡检任务 | **2 行**：搜索 + 查找 + 全部 / 进行中 + 已完成 + 筛选本页 |

第 2 行装的是**状态筛选**（在线/离线、进行中/已完成），是现场最高频的动作之一。
收进抽屉能把 2 行降到 1 行，代价是**每次筛选多一次点击**（开抽屉 → 选 → 关）。
"2 行"在这里是必要的信息密度，不是排版坏掉 —— 所以**不做**，只把这条判断与依据记下来。

> 这一条与前面几条的区别值得写清：前面是"行为错了"（点了没用 / 永久遮挡），
> 这一条是"观感可以更好但交互会变差"。**改与不改都要给依据**，不能因为"清单上写了要做"就动。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **26 条全绿** |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 双端冒烟 | `pnpm check:web-smoke` | **246/246**（新增 3 条手机档护栏） |

新增的 3 条：详情屏不画分段控件 / 详情屏有「返回」/ **滚到底时最后一个内容块不被动作坞遮住**
（实测数据 `{"lastBottom":635,"dockTop":659}`）。

## V6 之后 · 第九轮：桌面宽屏主从视图（2026-10-03）

### 一、为什么**不能**靠"点行换路由"来做右栏

`<RouterView :key="route.fullPath">`（当初为了修"查 NOPE-999 还显示上一条"）会**整树重挂**：
点行若走详情路由，左栏会被销毁重建 —— 页码回 1、滚动位置丢（`rememberScroll` 全仓没人调用），
表现是"点一行整屏闪一下"。

所以右栏靠**组件状态**（`selectedId`），路由不动。点行的行为按档位分岔：

| 档位 | 点行 |
| --- | --- |
| 宽档（≥1440） | 只改 `selectedId`，右栏就地换内容，**路由不动** |
| 窄档 / 手机 | 照旧 `push` 详情路由（并排两栏谁都看不清；而且按 hash 导航是深链 / 扫码 / 返回键的基础） |

### 二、详情屏必须能"按 id 渲染"，而不是"按路由参数渲染"

8 个详情屏原先都在 setup 期读一次 `route.params` 存成局部常量 —— 路由不动时 `params` 为空，
全部落进"请从列表点开"的空态。所以抽出了 `InventoryDetailPanel`：
**id 是 prop**，于是同一份实现既能当独立路由屏（薄壳从路由取 id），也能当主从右栏。

### 三、档位：给 `useViewport` 加了 `isWide`（≥1440）

不复用 `isDesktop`(≥1024)：1024 的窗口在侧栏展开后内容区只剩 ~780px，两栏各 390px ——
而库存列表的固定列宽加起来 750px，塞进去只会把右栏挤出可视区
（`.w-content` 是 `overflow-x: hidden`，溢出会被**裁掉**而不是出滚动条）。

顺带解决"两栏放不下"的第二件事：**主从用一套精简列**（商品 / 编码 / 货位 / 数量 / 状态），
去掉仓库与更新时间（占 280px）。窄档仍用完整列。

SSR 下 `isWide` 特意退化成 `false`：服务端渲染若两栏并存，门禁抓的"第一个页头标题"
会变成列表屏的（详情面板在后），每屏标题断言会在 SSR 下失真。

### 四、踩到的一个隐蔽坑（值得单列）

第一版两栏**静默退化成上下堆叠**：`grid-template-columns` 里写的是
`--w-size-detail-column-width`，而真名是 `--w-space-detail-column-width`（**space** 前缀）。
令牌名写错的后果不是"报错"，而是**整条声明作废、`display: grid` 仍生效** → 单列堆叠，
看起来像"主从根本没接上"。

`check:css-vars` 目前**只扫 3 个全局 CSS 文件**，管不到组件里的 scoped style —— 这是门禁盲区，
已写进注释；要覆盖它得单独做一轮（可能扫出既存问题）。

### 本轮验收证据（真跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 门禁 | `pnpm check` | **26 条全绿** |
| 类型 | `pnpm typecheck` | exit 0，0 错误 |
| 渲染门禁 | `pnpm check:render` | **32 用例全绿** |
| 构建 | `pnpm build` + `check:budget` | 首屏 **97.1KB gzip**、70 chunk 全 ≤130KB |
| 双端冒烟 | `pnpm check:web-smoke` | **250/250** |

新增 4 条断言：手机档卡片列表点得到（**防止下面那条假红**）/ 手机档点行仍按 hash 进详情 /
桌面宽档点行**不换路由** / 桌面宽档右栏就地出详情。
其中"卡片列表点得到"是写测试时踩出来的：窄档出的是卡片（`.w-cardrow > .w-card`）、
宽档出的是表格行，照抄选择器会什么都点不到，而断言拿到的是"hash 没变"，看着像功能坏了。




