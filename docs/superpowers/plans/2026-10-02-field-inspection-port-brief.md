# 现场域「巡检」6 屏 Vue 移植 —— 实现简报（SubagentContextPacket）

> 这份文件是**实现者的全部上下文**。你不看聊天记录，只按这份简报 + 仓库里的现有文件干活。
> 项目根：`E:\code_space\WiseDepot\WiseDepotClient`

## 0. 任务与停止条件

把 React 版现场域巡检 6 屏，按 **Vue 3 `<script setup>` + TS strict + Element Plus** 重写进
`apps/web/src/views/field/`，行为、字段、文案、校验与 React 版**一一对应**。

- 停止条件：分到的文件写完，自检清单逐条打过勾，并报告 `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`。
- **不要**改注册表、路由、mock、检查脚本 —— 那些是协调者的活（见 §7 非目标）。

## 1. 必须先读的文件（不要猜，读原文）

| 用途 | 路径 |
| --- | --- |
| 业务逻辑 / 字段 / 文案 / 校验的**唯一真源** | `packages/features/src/field/Inspection*Screen.tsx`（你分到哪屏读哪屏） |
| 任务状态归一化（已移植，直接用） | `apps/web/src/views/field/inspectionState.ts` |
| Vue 列表屏范本 | `apps/web/src/views/field/DeviceListView.vue` |
| Vue 详情屏范本 | `apps/web/src/views/field/DeviceDetailView.vue` |
| Vue 表单/新建屏范本 | `apps/web/src/views/inventory/StockOrderCreateView.vue` |
| Vue 详情+动作屏范本 | `apps/web/src/views/inventory/StockOrderDetailView.vue` |
| Vue 列表屏范本（分页/筛选） | `apps/web/src/views/inventory/StockOrderListView.vue` |
| 共享组件源码（props/事件以源码为准） | `packages/ui/src/business/*.vue`、`packages/ui/src/primitives/*.vue` |
| 数据层 | `packages/stores/src/resource.ts`、`packages/stores/src/dto.ts` |

## 2. 路由（`router.push` 用 `name`，name 就是桥方法 id）

| 目标 | name | params / query |
| --- | --- | --- |
| 巡检任务详情 | `inspection.taskDetail` | `{ taskId: String(x) }` |
| 新建巡检 | `inspection.taskCreate` | 无 |
| 巡检结果列表 | `inspection.resultList` | 可选 `query: { taskId: String(x) }` |
| 巡检结果详情 | `inspection.resultDetail` | `{ resultId: String(x) }` |
| 录入结果 | `inspection.resultCreate` | 可选 `query: { taskId: String(x) }` |
| 手动补录 | `inspection.manualRecord` | 可选 `query: { taskId: String(x) }` |
| 设备详情 | `device.detail` | `{ deviceId: String(x) }` |

路由参数在视图里读：`const route = useRoute(); const taskId = String(route.params['taskId'] ?? '');`
（`noUncheckedIndexedAccess` 开着，取 `params['x']` 必须自己兜底）。query 同理 `route.query['taskId']`。

## 3. 数据层用法（照抄范本，不要自创）

```ts
import { asList, asTotal, humanize, shortTime, useResource, useMutation } from '@wise/stores';

const list = useResource<unknown>('inspection.taskPage', { page: 1, pageSize: 20 });
list.data.value / list.loading.value / list.error.value / list.reload() / list.invalidate()

const detail = useResource<unknown>('inspection.taskDetail', () => ({ taskId }), { enabled: taskId !== '' });
```

> **分页参数名不要抄别的屏**：`inspection.taskPage` 用 `page` + **`pageSize`**（默认只有 10！），
> 而 `inventory.list` 那一类用 `size`。详见 §9。发错参数名不会报错，只会静默只回 10 条。

- `useResource(method, params?, options?)`：`params` 传**函数**（响应式）；无参方法传 `{}` 或省略。
  参数还没准备好时用 `{ enabled: cond }`，**不要**用 `params === undefined` 表达"参数没准备好"。
- `useMutation<unknown>('inspection.taskStatus')` → `run(params)`，`pending` 是响应式。
- 写操作成功后要刷新页面数据：调 `list.reload()` / `detail.reload()`（`useMutation` 内部已按方法 id 前缀失效缓存）。
- `asList<T>(data)` 取列表数组；`asTotal(data)` 取总数；`humanize(error)` 把 `BridgeError` 转人话；`shortTime(s)` 时间短格式。

## 4. TS / Element Plus 的硬规矩（踩过的坑，别重踩）

1. **按需导入 EP 组件**：`import { ElButton, ElInput, ElSelect, ElOption } from 'element-plus';` 用到哪个导哪个。
2. **EP 泛型 props 在 vue-tsc 下会报 `buildProps` 类型不兼容**（本仓 `packages/ui`/`views` 都中招）。
   解决方式是本地写一个返回 `any` 的透传助手，用它 `v-bind`：
   ```ts
   /** EP 的 props 类型在 vue-tsc 下解不开，这里只做类型层透传，不改运行时行为。 */
   function anyProps(value: Record<string, unknown>): Record<string, unknown> { return value; }
   ```
   ```html
   <ElSelect v-bind="anyProps({ modelValue: warehouseId, placeholder: '请选择仓库', size: 'large' })" @change="onWarehouseChange">
     <ElOption v-for="w in warehouses" :key="String(w.warehouseId)" v-bind="anyProps({ label: w.warehouseName, value: w.warehouseId })" />
   </ElSelect>
   ```
   `ElPagination` / `ElTable` / `ElCheckbox` / `ElRadioButton` 同理。`ElButton` / `ElInput` / `ElTag` / `ElDescriptions` 一般可直接用。
3. **`exactOptionalPropertyTypes` 开着**：可选属性**不能**显式传 `undefined`。要传就用条件展开
   `...({ note: x } as const)` 或 `v-bind` 拼对象。可选 props 一律写 `:foo="cond ? v : undefined"` 会报错。
4. **`noUncheckedIndexedAccess` 开着**：`arr[0]`、`record['k']` 的类型都带 `| undefined`，必须兜底。
5. **真后端对空字段回的是 `null` 而不是 `undefined`**：任何字符串方法（`.trim()` `.includes()`）前
   一律 `(row.deviceName ?? '')`，禁止写 `row.x?.trim()` 之外的无保护调用；比较也要先归一。
6. **不要造假字段**：视图只读服务端 DTO 里真实存在的字段。字段名以 React 屏里的为准（例如任务的
   `statusDesc` 实测给的是枚举原文 `COMPLETED`，所以状态文案必须走 `taskStateText()`，不能直接显示 `statusDesc`）。

## 5. UI 硬规矩（有门禁，违反会被 `check:ui-web` / `check:store` 拦）

1. **业务用户永远看不到桥方法 id、字段名、`status`/`code` 之类开发词汇**。界面文案一律业务语言
   （"任务已开始执行。"、"没有符合条件的巡检任务。"）。
2. **`<script setup>` 里禁止直接 `bridge.call(...)`**（`check:store` 会拦）。数据一律走 `useResource` / `useMutation`；
   确需一次性调用（如"提交后拿返回值"）用 `useMutation(...).run(...)`，不要 import bridge store 自己调。
3. 页面结构固定：`<div class="w-page">` → `<PageHeader>` → 内容 → `<SectionBlock>`。
   `PageHeader` 有 `#actions` 插槽放刷新/主按钮。
4. 列表一律 `StateHost` 包 `ResponsiveDataView`：`StateHost` 负责 loading/error/empty 三态与重试，
   `ResponsiveDataView` 负责"桌面表格 / 手机卡片"两态（传 `columns` + `rows` + `row-key`，`:clickable` + `@row-click`）。
5. `columns: readonly ColumnDef<Row>[]`：`{ key, title, type?: 'mono'|'status'|'number', width?, compact?: 'primary'|'secondary'|'chip', value?: (r) => string, tone?: (r) => 'success'|'warning'|'danger'|'neutral' }`。
6. 空态文案要说清"为什么空、能做什么"，不要只写"暂无数据"。
7. 样式只用 token 变量（`var(--w-*)`），**禁止写死颜色/字号**；`<style scoped>` 类名用 `w-<屏名>__<部件>` 前缀。
8. 危险/不可逆操作走 `ConfirmDialog` 或 `ElMessageBox` 之外的既有组件；本仓范本用 `ConfirmDialog`（见 `StockOrderDetailView.vue`）。

## 6. 分到的屏（每个屏一份交付）

### A. `InspectionTaskListView.vue` ← `InspectionTaskListScreen.tsx`
- 方法：**只有列表 `inspection.taskPage`**（React 列表屏没有状态/进度动作，**不要加**）。
- 分页参数：`{ page, pageSize: 20 }` —— 只有 `pageSize` 是有效的（见 §7.1）。
- 字段：`taskId, taskCode, planName, taskTypeDesc, status, statusDesc, progress, totalItems, inspectedItems,
  normalItems, abnormalItems, missingItems, extraItems, warehouseName, deviceName, startTime, endTime, createTime`。
- 状态文案必须用 `taskStateText()` / `taskStateOf()`（来自 `./inspectionState`），chip 语气：
  done→success，running→warning，paused→neutral，pending→info，unknown→neutral。
- 点行进详情屏；"新建巡检"按钮进 `inspection.taskCreate`。

### B. `InspectionTaskDetailView.vue` ← `InspectionTaskDetailScreen.tsx`
- 方法：`inspection.taskDetail`、`inspection.taskDiff`（差异明细）、`inspection.taskStatus`（开始/结束）、
  `inspection.taskProgress`（保存进度）。
- 差异行 DTO：`{ productId, productName, productCode, expectedQuantity, scannedQuantity, difference, status }`；
  「只看异常」开关：`status` 为 `MISSING`/`EXTRA` 算异常，`NORMAL` 不算，其余按 `difference !== 0` 判。
- 进度保存要把值 clamp 到 0..100，并带上 `scannedCount: task.inspectedItems ?? 0`（React 没有进度输入控件，**不要自造**）。
- **`taskStatus` 的 `status` 值发 `IN_PROGRESS` / `COMPLETED`**（不是 `RUNNING`，见 §7.2），界面文案不变。
- 「结果与补录」入口只放两个链接，**不要为了找 resultId 去拉结果列表**：
  `inspection.resultList`（带 `taskId` query）、`inspection.manualRecord`（带 `taskId` query）。

### C. `InspectionTaskCreateView.vue` ← `InspectionTaskCreateScreen.tsx`
- 方法：`inspection.taskCreate`（params 只放有值的：`planId` / `warehouseId` / `deviceId` / `targetDistance`）、
  选项来源 `inspection.planList`、`warehouse.list`、`device.list`（用 `useResource`，失败不阻断表单）。
- **warehouseId 是硬要求**（服务层「仓库ID不能为空」「仓库不存在」），UI 必须提示；
  其余字段可空（服务端 DTO 上没有校验注解）。
- 成功后显示"已创建任务 #id"并给"查看任务详情"入口（`inspection.taskDetail`）。

### D. `InspectionResultListView.vue` ← `InspectionResultListScreen.tsx`
- 方法：`inspection.resultList`；行内到 `inspection.resultDetail`；`inspection.resultConfirm` 确认入账（要二次确认）。
- 字段：`resultId, taskId, compareTime, totalItems, normalItems, missingItems, extraItems, createTime,
  progress, status, totalScanned, totalExpected`（以 React 屏为准）。
- 路由带 `?taskId=` 时**把它作为参数发给服务端**（`listResults` 真的支持 taskId 过滤，见 §7.6），
  筛选条上显示"仅看任务 #x"并可清除；**不要本地过滤**。
- `status` 的取值口径未见实测（§7.8）：照 React 的用法写，并留注释，别当成已知事实。

### E. `InspectionResultCreateView.vue` ← `InspectionResultCreateScreen.tsx`
- 方法：`inspection.resultCreate`；提交参数 `{ taskId, totalItems, normalItems, abnormalItems, missingItems, extraItems }`
  （六个都是 query 参数，走 `useMutation` 即可，桥会按契约拼对位置）。
- 校验照抄 React：数字字段必须是非负整数；`abnormalItems` 是**推导值**（实扫 − 正常，服务端口径），
  照抄它的推导与报错文案（"实扫数量不能小于其中正常，请先核对这两个数。"）。
- 任务信息可刷新（`inspection.taskDetail`），参数从 query `taskId` 初始化。

### F. `InspectionManualRecordView.vue` ← `InspectionManualRecordScreen.tsx`
- 方法：`inspection.manualRecord`，提交体 `{ taskId, items }`，`items: { rfid, tid, remark }[]`
  （**taskId 必须在 body 里**，见 §7.4）。
- **服务端只允许对"已完成"的任务补录**：把「只能对已完成的巡检任务进行补录」这句原话展示给现场人员，
  并在任务未完成时给出可行动提示（先结束任务）；补录成功后**必须重新拉任务详情**（服务端会重算计数）。
- 支持增删行、行内校验（缺关键字段的行不允许提交）、重复项提示（照抄 React 的判重口径）。
- 提交成功给结果反馈与"回到任务详情"入口。

## 7. 真后端事实（**权威**，来自仓内服务端源码，别猜）

服务端源码就在本仓：`E:\code_space\WiseDepot\WiseDeoptServer\wise-deopt-api\src\main\java\com\huicang\wise\api\controller\InspectionController.java`
与 `WiseDeoptServer\wise-deopt-application\...\application\inspection\InspectionApplicationService.java`。以下是核对过的原文结论：

1. **`inspection.taskPage`**（`listTasksPage`）：参数 `planId/taskType/status/warehouseId/deviceId/page/**pageSize**`，
   `page` 默认 1、**`pageSize` 默认 10**。没有 `size` 参数 —— 发 `size:20` 只会拿到 10 条。
2. **`inspection.taskStatus`**：`@RequestParam("status")`，服务层**只认 `IN_PROGRESS` 与 `COMPLETED`**：
   ```java
   Short taskStatus = 0;                                  // 初值 = PENDING
   if ("IN_PROGRESS".equals(status)) { ... status = 1; task.setStartTime(now); }
   else if ("COMPLETED".equals(status)) { ... status = 2; task.setEndTime(now); task.setProgress(100); }
   ```
   **没有 else、不抛错**：传 `RUNNING` 之类会把任务**静默重置成"待执行"**。
   （React 版发的是 `RUNNING`，所以它的「开始执行」在真后端上等于打回待执行；Vue 版修成 `IN_PROGRESS`，界面文案不变。）
3. **`inspection.taskCreate`**：`@Valid @RequestBody InspectionTaskCreateRequest`，字段
   `planId / warehouseId / deviceId / targetDistance` **全都没有校验注解**；但服务层有
   `"仓库ID不能为空"` 与 `"仓库不存在"` 两处判断 → **warehouseId 是硬要求且必须真实存在**，其余可空。
4. **`inspection.manualRecord`**：body `ManualRecordRequest{ @NotNull taskId, List<ManualRecordItem> items }`，
   `items[].rfid` 也是 `@NotNull`（消息「NFC不能为空」）。**taskId 必须在 body 里**（契约里
   `keepPathParamsInBody: true`，只放路径会 VAL-0001）。
   服务层两道闸门：任务存在 → **任务必须已完成**，否则原话
   「只能对已完成的巡检任务进行补录」。补录会**触发服务端重算计数**（实测 `normalItems` 8 → 0），
   **所以补录成功后必须重新拉任务详情**，不能只弹个成功提示。
5. **`inspection.resultCreate`**：`@RequestParam` 六个计数 `taskId/totalItems/normalItems/abnormalItems/missingItems/extraItems`
   （必须走 query，契约里 `paramStyle: 'query'`）；服务层会把任务置为 `status=2`（已完成）并写回各计数。
6. **`inspection.resultList`**：`listResults(taskId, warehouseId, status)` —— **支持按任务过滤**，
   而且**不分页**（返回 `List`，没有 page/pageSize）。要找"某任务的盘点结果"就直接发 `{ taskId }`，不要本地过滤。
7. **`inspection.resultConfirm`**：`resultId` 走路径，body 是个 `Map`；服务层目前是**空实现**（直接 `success()`，
   `resultId` 只做回显）。所以**不要为它编造"重复确认会被拒"之类的服务端规则**。
8. **结果 DTO 的 `status` 取值口径未实测**：服务端 `getResult` 里硬编码 `"COMPLETED"`，
   而 React 结果列表屏按 `PENDING`/`CONFIRMED` 两档筛选 —— 两者对不上。移植时**照 React 的用法写**，
   但要在这里留一句注释说明"该取值需要一个真结果样本才能确认"，别把它写成已知事实。

## 8. 非目标（别做）

- 不改 `packages/features/**`（React 版留着做对照）、不改 `bridge/**`、不改后端、不改 `packages/layouts/**` 路由表。
- 不改 `apps/web/src/views/registry.ts`、`packages/bridge-client/src/mock-domains.ts`、`tools/check/**` —— 协调者统一接。
- 不引入新依赖、不新增全局样式、不动主题 token。
- 不新建桥方法、不加服务端没有的筛选参数。

## 9. 自检清单（在报告里逐条回答 ✅/❌ + 证据）

1. 每个 React 屏里的**字段、动作按钮、校验、错误文案、成功文案**都能在本屏找到对应（缺一不可解释）。
2. 没有任何裸 `bridge.call`；数据都走 `useResource` / `useMutation`。
3. 界面文案里没有方法 id（`inspection.` / `device.` 等）、没有英文枚举原文（`COMPLETED`、`RUNNING` 等）。
4. 所有 `null` 可能的字符串字段都做了 `?? ''` 保护。
5. `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` 不会报错（可选 props 没传 `undefined`，索引访问有兜底）。
6. `<style scoped>` 里没有字面量颜色/字号，全用 `var(--w-*)`。
7. 三态齐全：loading 有骨架、error 可重试、empty 有业务语言说明。
8. 报告里给出每个文件的**行数**与**你实现时不确定的点**（如有）。
