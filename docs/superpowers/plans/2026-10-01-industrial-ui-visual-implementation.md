# Industrial Client UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Client 的桌面和手机界面统一改造成参考图的工业运营台风格，同时保留“看板”为默认首屏并完整复用当前真实 Bridge 功能。

**Architecture:** 保留一份 React Web、DesktopShell/MobileShell 两个布局壳和一份 Kotlin Bridge。桌面采用深色分组侧栏、顶栏状态区、列表页表格/主从布局；手机采用同一视觉令牌、卡片列表、详情压栈和底部导航。所有页面继续通过现有 `PageBody`、`useBridgeCall`、导航目的地和 Bridge DTO 取数，不添加没有接口支撑的业务内容。

**Tech Stack:** React 19, TypeScript, Vite, Electron, Kotlin/Android WebView, 现有 `@wise/patterns` 设计令牌与 `@wise/bridge-client`。

## Global Constraints

- 默认首屏仍然是“看板”，库存总览是库存域页面。
- 只使用现有真实 Bridge 方法和 DTO；禁止虚构趋势、库存、设备遥控、视频或热力图数据。
- DesktopShell 与 MobileShell 共享导航状态，视口切换不得丢失详情参数、筛选或返回栈。
- 桌面目标宽度为 600px 以上，手机目标宽度为 600px 以下；不读取旧 `.archive/appui`。
- 所有新增颜色、间距、圆角和字体必须使用 `packages/patterns/src/patterns.css` 已有令牌。
- 每个任务结束运行对应检查；最终运行 Web、Bridge、Android lint 和 Windows smoke。

---

### Task 1: 工业运营台共享视觉令牌与 Electron 壳

**Files:**
- Modify: `packages/patterns/src/patterns.css`
- Modify: `packages/patterns/src/index.tsx`
- Modify: `apps/desktop/src/main.ts`
- Test: `tools/check/check-css-vars.js`, `tools/check/check-shell-render.mjs`

**Interfaces:**
- Consumes: existing CSS variables, `AppBar`, `Sidebar`, `NavItem`, `TabBar`, `BridgeStatusChip`.
- Produces: `.w-sidebar--industrial`, `.w-topbar--industrial`, `.w-sidebar__section`, `.w-warehouse-switcher`, and a menu-less Windows shell.

- [ ] **Step 1: Add semantic shell class hooks**

  Extend `Sidebar`, `AppBar`, and `TabBar` with optional `variant="industrial"` without changing their default callers. The rendered classes must append `w-sidebar--industrial`, `w-appbar--industrial`, and `w-tabbar--industrial` only when requested.

- [ ] **Step 2: Implement the industrial palette and density**

  Add token-based rules for a navy sidebar, teal active indicator, compact top bar, restrained borders, and touch-safe controls. Do not add literal colors; use existing `--w-color-*`, `--w-fill-*`, and spacing tokens.

- [ ] **Step 3: Remove the native Electron menu for the product window**

  Import `Menu` in `apps/desktop/src/main.ts` and call `Menu.setApplicationMenu(null)` after `app.whenReady()` before creating the window. Keep DevTools available through existing development behavior.

- [ ] **Step 4: Run shell and CSS gates**

  Run `pnpm check:css` and `pnpm check:render`; both must pass before proceeding.

### Task 2: Desktop industrial navigation shell

**Files:**
- Modify: `packages/shells/src/DesktopShell.tsx`
- Modify: `packages/shells/src/navigation.ts`
- Modify: `packages/shells/src/BridgeStatusChip.tsx`
- Test: `tools/check/check-navigation.mjs`, `tools/check/check-shell-render.mjs`

**Interfaces:**
- Consumes: `useShellNavigation`, `DOMAINS`, real capability list, `BridgeStatusChip`.
- Produces: grouped desktop navigation, current-domain context, and a compact top bar with real Bridge status.

- [ ] **Step 1: Add grouped section labels without inventing destinations**

  Render existing `DOMAINS` children under the current domain group. Use labels “运营”, “现场”, and “管理” only as visual section headings; every clickable destination must still come from `DOMAINS`.

- [ ] **Step 2: Add the current warehouse slot only when data exists**

  Do not display a fake warehouse name. If the current screen already supplies a warehouse name, show it in the contextual page header; otherwise omit the selector rather than adding a non-functional control.

- [ ] **Step 3: Replace the generic title bar**

  Render breadcrumb/context text from the active domain and leaf, keep back navigation for detail crumbs, and retain the live `BridgeStatusChip`. Remove the operator-facing capability-count chip from the main header.

- [ ] **Step 4: Verify all navigation destinations remain reachable**

  Run `pnpm check:navigation` and `pnpm check:render`.

### Task 3: Desktop dashboard and inventory main/detail layout

**Files:**
- Modify: `packages/features/src/overview/DashboardScreen.tsx`
- Modify: `packages/features/src/inventory/InventoryListScreen.tsx`
- Modify: `packages/patterns/src/index.tsx`
- Modify: `packages/patterns/src/patterns.css`
- Test: `tools/check/check-shell-render.mjs`, `tools/check/check-state.mjs` if affected

**Interfaces:**
- Consumes: `dashboard.summary`, `inventory.list`, `inventory.detail`, `Navigator`, existing `MasterDetail`.
- Produces: real KPI cards, operational queue, desktop inventory table with selected-row detail, and mobile-safe fallbacks.

- [ ] **Step 1: Add reusable KPI and table primitives**

  Add `MetricCard`, `DataTable`, and `DetailPanel` primitives that accept React content and do not own Bridge calls. Preserve `DataList` for compact mobile rendering.

- [ ] **Step 2: Restyle the dashboard using only `DashboardSummary` fields**

  Keep the four existing metrics (`inventoryTotal`, `todayAlertCount`, `inspectionProgress`, `deviceOnlineCount`), current task, and unprocessed alerts. Add no historical trend or fabricated delta values. Use the industrial card hierarchy and status colors from tokens.

- [ ] **Step 3: Convert inventory desktop view to table + detail panel**

  Keep `inventory.list` pagination and current client filters. Selecting a row must call the existing `onNavigate({ method: 'inventory.detail', params: ... })`; the detail panel is rendered only when a valid selected row/route parameter exists. Do not add inventory editing.

- [ ] **Step 4: Preserve mobile list semantics**

  At compact width, render the same rows as cards and push the existing inventory detail screen instead of squeezing the desktop table.

- [ ] **Step 5: Render-check dashboard and inventory**

  Run `pnpm check:render`, `pnpm check:ui`, `pnpm check:css`, and `pnpm typecheck`.

### Task 4: Mobile task-flow shell and business cards

**Files:**
- Modify: `packages/shells/src/MobileShell.tsx`
- Modify: `packages/patterns/src/patterns.css`
- Modify: `packages/features/src/overview/AlertListScreen.tsx`
- Modify: `packages/features/src/field/InspectionTaskListScreen.tsx`
- Test: `tools/check/check-shell-render.mjs`, `tools/check/check-inspection-state.mjs`

**Interfaces:**
- Consumes: `useShellNavigation`, existing `TabBar`, real alert and inspection DTOs.
- Produces: mobile top bar with compact Bridge state, 2x2 KPI-compatible spacing, card lists, sticky task actions that avoid the bottom TabBar.

- [ ] **Step 1: Apply the industrial mobile shell**

  Use the same navy/teal visual tokens as desktop, keep bottom navigation, and retain camera/keyboard scan entry only when capabilities are declared.

- [ ] **Step 2: Convert alert and inspection lists to operation cards**

  Keep pagination, status filters, detail navigation, and error/empty/loading states. Cards must expose title, identifier, time/progress, and existing status values without adding new backend fields.

- [ ] **Step 3: Guard fixed actions against tab bar and safe area**

  Use `ShellAwareActionDock`/existing `BottomActionBar` spacing so form actions remain visible above the mobile TabBar and IME.

- [ ] **Step 4: Run mobile-specific gates**

  Run `pnpm check:render`, `pnpm check:scan`, `pnpm check:stockorder`, `pnpm check:state`, and `pnpm typecheck`.

### Task 5: Cross-platform packaging and visual verification

**Files:**
- Modify: `apps/mobile/shell/build.gradle.kts` only if asset sync requires it
- Modify: `scripts/desktop.ps1` only if it does not rebuild the current Web assets
- Test: `pnpm build`, `:apps:mobile:shell:lintRelease`, `:apps:mobile:shell:assembleDebug`, `pnpm desktop:smoke`

**Interfaces:**
- Consumes: current Web dist, industrial shell, shared Bridge bootstrap.
- Produces: current Windows unpacked build and Android debug APK with the same Web visual.

- [ ] **Step 1: Build fresh Web assets**

  Run `pnpm build` and verify the generated hash in both `apps/web/dist/assets` and packaged resources.

- [ ] **Step 2: Run Windows smoke**

  Run `pnpm desktop:smoke -Rebuild` through `scripts/desktop.ps1`; require current `app://wise` origin, bridge ping, and login screen assertions.

- [ ] **Step 3: Build and lint Android**

  Run `.\\gradlew.bat :apps:mobile:shell:lintRelease :apps:mobile:shell:assembleDebug` and report the APK path. Install only when an actual `adb` device is present.

- [ ] **Step 4: Final regression gates**

  Run `pnpm typecheck`, `pnpm check:css`, `pnpm check:ui`, `pnpm check:render`, `pnpm check:navigation`, `pnpm check:transport`, and Bridge backend/server tests.
