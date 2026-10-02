# 桌面端相机扫码（B1）实施 brief

> 这份 brief 是**动手前的稳定器**：先把契约、平台分工、UI 状态机与验收标准钉死，
> 再开第一个分片。体例沿用 `field-inspection-port-brief.md` / `permission-port-brief.md`。
> 相机扫码分批：**B1 桌面 → B2 手机 CameraX → B3 手机 NFC**。本文只覆盖 B1。

## 0. 目标与非目标

**目标**：桌面端（Electron）能"选摄像头 → 取景 → 识别条码 → 出结果卡"，并把这套能力按
`scan.camera` 能力位暴露给 Web；识别不出/被拒/无设备时给出**明确状态**，不留"点了没反应"。

**非目标**（明确不做，避免范围膨胀）：
- 手机端取景与识别（**B2**；手机必须走 CameraX，不许走 WebView `getUserMedia`）；
- NFC（**B3**）；
- 连续多码并发识别、识别模型自训练、离线模型下发；
- 改动 `scan.gun.keyboard`（键盘式扫码枪）这条路——它已经能用，本片不要碰。

## 1. 现状（都有出处）

| 事实 | 出处 |
| --- | --- |
| 手机上 `scan.camera` 被**主动撤销**，原因写明"本机 WebView 打开相机会崩溃" | `apps/mobile/shell/.../MainActivity.kt:203` |
| 无摄像头设备不声明 `scan.camera`（能力声明即承诺） | `apps/mobile/shell/.../ShellApplication.kt:20-30` |
| Web 侧取景与条码识别**尚未落地**；能力为真也不该先摆入口 | `docs/superpowers/plans/2026-10-02-v0-v1-executable-plan.md:371` |
| 相机入口"只在 `bridge.supports('scan.camera')` 为真时出现"；扫到结果在顶部弹**结果卡** | `docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:374,417` |
| 键盘扫码枪那条路已可用，且有门禁 | `tools/check/check-scan.mjs` |
| 能力表里已有 `scan.camera` / `nfc.read`，但**没有**"选哪一个摄像头" | `BridgeCapabilities.kt` / `packages/bridge-client/src/types.ts` |

## 2. 契约（本片新增，一次写清）

**能力位（新增一个，桌面专属）**

| id | 含义 | 谁声明 |
| --- | --- | --- |
| `scan.camera` | 具备相机取景 + 条码识别能力 | 桌面（本片）／手机（**B2 之后**） |
| `scan.camera.select` | **可枚举并选择摄像头**（多摄像头才有意义） | 桌面独占；手机不声明 |

> 为什么把"能选摄像头"单列一个能力位：手机上通常只有一枚（或由系统决定），
> UI 若照桌面那样画一个"选择摄像头"下拉，在没有选择权的设备上就是死入口 ——
> 这违反"能力声明即承诺"（`BridgeCapabilities.common` 的注释里已经为同类错误留过教训）。

**本机方法（不走后端、不进契约表）**

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `camera.list` | — | `{cameras:[{id,label,isDefault}], selectedId}` | 桌面枚举；`label` 空时 UI 显示"摄像头 N" |
| `camera.select` | `{id}` | `{selectedId}` | 持久化在**壳**里（`app.getPath('userData')`），不是 localStorage |
| `scan.start` | `{mode:'barcode'\|'qr'}` | `{state:'starting'}` | 幂等：重复调用返回当前状态而不是报错 |
| `scan.stop` | — | `{state:'stopped'}` | 幂等；窗口失焦/关闭时必须自动停 |

**事件（沿用 + 新增一个）**

| topic | 载荷 | 说明 |
| --- | --- | --- |
| `scan.code`（沿用） | `{code, symbology, at}` | 识别成功；**与键盘扫码枪共用同一 topic**，UI 只消费结果 |
| `scan.state`（新增） | `{state, reason?}` | `starting`/`running`/`stopped`/`error`，用于取景层与错误提示 |

**错误码（桥自己的，新增三个）**

| 码 | 含义 | UI 该说什么 |
| --- | --- | --- |
| `BRIDGE_CAMERA_UNAVAILABLE` | 没有可用摄像头 / 设备被占用后仍拿不到 | "没有可用的摄像头" |
| `BRIDGE_CAMERA_DENIED` | 用户或系统拒绝了相机权限 | "相机权限被拒绝，请在系统设置里允许" |
| `BRIDGE_CAMERA_BUSY` | 设备被其它程序独占 | "摄像头正被其它程序占用" |

> 三个码都必须配 `messageKey`（文案不下发，仍走既有"谁展示谁拥有"的口径）。

## 3. 平台分工（本片只做桌面）

| 层 | 做什么 | 为什么在这层 |
| --- | --- | --- |
| Electron 主进程 | 枚举设备、持久化选择、权限请求处理、窗口失焦时停流 | 只有主进程知道用户选了哪一枚；也是唯一能安全落盘的地方 |
| 渲染进程（Web 产物） | `getUserMedia({video:{deviceId}})` 取景 + 识别 + 画取景框与结果卡 | 取景必须在能看到画面的进程里；识别优先用 Chromium 内置 `BarcodeDetector` |
| 桥（Kotlin） | 只做**本机方法转发**与事件广播，不认识"摄像头" | 保持"桥是通道不是业务"的边界 |

**识别的选型与回退**：优先 `window.BarcodeDetector`（Chromium 内置、零依赖、支持 `code_128`/`ean_13`/`qr_code` 等）；
`typeof BarcodeDetector === 'undefined'` 时回退 ZXing-wasm（**只在回退路径**才引入依赖，避免为一个可能用不到的能力给主包增重）。
判定必须落在**能力位**上，不许写"平台是 electron 所以……"。

## 4. UI 状态机（能力声明即承诺）

```
不支持（无 scan.camera 能力）      → 不画入口（一个字都不出现）
支持但未开始                       → 画"扫码"按钮
camera.list 返回 0 枚              → 按钮禁用 + 提示"没有可用的摄像头"
start 中（starting）               → 取景层 + "正在启动相机…"
running                            → 取景画面 + 遮罩框 + "取消"
error(denied/unavailable/busy)     → 取景层内显示**对应中文**与"重试 / 换一个摄像头"（仅当支持 select）
识别成功                           → 顶部结果卡（条码 → 商品/库存摘要，数据来自 tag.byCode）
```

三条纪律：① 入口只由能力位决定；② 每个错误态都要有**出路**（重试/换摄像头/关闭），不许出现死状态；
③ 停流必须发生在"关闭取景层、窗口失焦、切页"三处（`scan.start` 与 `scan.stop` 成对）。

## 5. 分片（每片都能独立过门禁、独立验收）

| 片 | 内容 | 验收 |
| --- | --- | --- |
| **S1 契约与能力位** | 新增 `scan.camera.select`；把 4 个本机方法登记进本机方法表；新增 3 个错误码与 `scan.state` 事件；同步 TS 侧 `Capability`/`BridgeErrorCode`；生成物重跑 | `pnpm check`（含 `check:contract`）全绿；契约表里能看到 4 个新方法 |
| **S2 枚举与选择** | Electron 主进程：`camera.list`/`camera.select` + 落盘；`scan.camera.select` 能力位声明 | 手工：两端点返回正确；重启应用后选择仍生效（落盘不在 localStorage） |
| **S3 取景与识别** | 渲染进程取景 + `BarcodeDetector` 回退 ZXing-wasm；`scan.start/stop`；`evt scan.state` | 真机：对着条码能出 `evt scan.code`；关窗/失焦后 `getUserMedia` 流已停（`track.readyState === 'ended'`） |
| **S4 结果卡与错误态** | 顶部结果卡（`tag.byCode` 摘要）+ 四种错误态文案 + "换摄像头"入口（仅当支持 `scan.camera.select`） | `check:scan` 扩展：**无能力时不画入口**、有错误时文案与出路齐备 |
| **S5 门禁与真机走查** | `check-sc an` 补断言；桌面自检 `pnpm desktop:smoke` 增一条"无摄像头时能力位不声明"；文档 | `pnpm check`(28) + `check:web`(302) + `desktop:smoke`(6/6) 全绿；真机走查记录进 `docs/` |

## 6. 要动的文件（预估）

| 文件 | 改动 |
| --- | --- |
| `bridge/protocol/.../BridgeCapabilities.kt` | 加 `SCAN_CAMERA_SELECT` |
| `bridge/capability/...`（本机方法实现处） | 4 个本机方法；不碰后端 |
| `bridge/server/.../BridgeErrorCodes`（在 `BridgeProtocol.kt`） | 加 3 个相机错误码 |
| `packages/bridge-client/src/types.ts` | `Capability` / `BridgeErrorCode` 同步 |
| `packages/contract/src/generated/bridgeContract.ts` | 生成物重跑（本机方法不进契约表，用 `tools/gen` 的**本机方法**清单） |
| `apps/desktop/src/main.ts` + 新模块（如 `camera.ts`） | 枚举/选择/落盘/权限/失焦停流 |
| `apps/web/src/views/...`（扫码入口与新组件） | 取景层、结果卡、错误态 |
| `tools/check/check-scan.mjs` | 扩断言（能力位驱动 + 错误态出路） |

## 7. 风险与诚实边界

1. **权限模型**：Electron 里 `getUserMedia` 的授权走 `session.setPermissionRequestHandler`，**不弹系统框**——
   必须显式实现，否则表现为"点了没反应"（本项目已吃过一次同类：WebView 开相机直接崩）。
2. **`BarcodeDetector` 可用性**：Chromium 有，但**不保证**在这台机器上可用（部分构建缺 codec）；
   所以"回退 ZXing-wasm"是**必须实现**的路径，不是可选优化。
3. **多摄像头同名**：`label` 可能为空（未授权时 Chromium 不给名字），UI 要有"摄像头 N"的兜底。
4. **本片不动手机**：手机侧 `scan.camera` 仍**不声明**（`MainActivity.kt:203` 的撤销保持），
   直到 B2 用 CameraX 真正实现——**不许**为了让界面好看而提前声明。

## 8. S1b 实做前的设计更正（2026-10-05，落码时发现，先改本文）

> 体例同《基线记录》里的**更正不静默改写**：下面的结论与 §2/§3 冲突，以本节为准，
> 但**不删**上面两节 —— 保留它们才能看出"当初为什么以为需要 4 个桥方法"。

### 8.1 更正一：`camera.list` / `camera.select` **不做成桥方法**

**依据（决定性）**：Electron **主进程没有 `mediaDevices`**；摄像头枚举只能发生在**渲染进程**里
（`navigator.mediaDevices.enumerateDevices()`），而且 `label` 只在**拿到权限后**才非空。
换句话说：桥（Kotlin 宿主）与 Electron 主进程**都看不到**设备列表 —— 让它们转发，
等于插入一个"中间商"，真正干活的一步仍在 Web 里。

**处置**：
- 删除 `camera.list` / `camera.select` 两个方法（**不登记进本机方法表**）；
- 枚举与选择**全部在 Web 侧**：`enumerateDevices()` → 下拉（`label` 为空时显示"摄像头 N"，
  见 §7.3）→ `getUserMedia({video:{deviceId}})`；
- **选择的持久化**：放 Web 侧 `localStorage`（键 `wise.scan.cameraId`）。
  原 §2 说"存壳里、不放 localStorage"，理由是"壳要预开流"——但**流本来就是 Web 开的**，
  所以那条理由不成立；为它引入一个桥方法（还要跨进程落盘）属于 YAGNI。
- `scan.camera.select` 能力位**保留**：它表达的是"这台设备上有多枚可选摄像头"这一事实，
  由**壳**在声明能力时判断（桌面：枚举数 > 1 时才加，见 8.3），与"谁来枚举"无关。

### 8.2 更正二：`scan.start` / `scan.stop` 也**不做成桥方法**

取景流由 Web 持有，那么"开始/停止"就是 Web 自己的状态机（挂载取景层时 `getUserMedia`、
卸载/失焦/切页时 `track.stop()`）。加桥方法只会把**同一个状态**分到两个进程里，
反而更容易出现"壳以为在跑、Web 以为停了"的不一致——这正是**双所有者**。

**保留的契约**（§2 其余部分不变）：
- 事件 `evt scan.code`（与键盘扫码枪共用同一 topic）：识别成功时由 **Web** 发出还是由壳发出？
  → **由 Web 发出**（识别在渲染进程）；`.kiro/specs/dynamic-island-barcode-scanner` 的结果卡
  只消费 topic，不关心来源，所以这不影响它。
- 事件 `evt scan.state`：同上，Web 侧内部状态，**不跨桥**（跨桥的只有最终结果）。
- 三个相机错误码（`CAMERA_UNAVAILABLE` / `CAMERA_DENIED` / `CAMERA_BUSY`）：**保留**，
  但改由 **Web 侧**在 `getUserMedia` 失败的 `DOMException.name` 上映射
  （`NotFoundError`→UNAVAILABLE、`NotAllowedError`→DENIED、`NotReadableError`/`TrackStartError`→BUSY）。

### 8.3 更正三：壳这一片只剩**两件小事**（且必须最后做）

1. **Electron 主进程**：`session.setPermissionRequestHandler` —— 允许 `media` 权限并**记录决定**。
   不实现它，`getUserMedia` 在打包后的应用里会**静默失败**（表现为"点了没反应"，本项目已吃过同类）。
2. **声明 `scan.camera`**：由壳在能力表里加（桌面的能力表由 Kotlin 宿主打印、经 `handshake` 传给
   `webAssets.ts`，所以改的是宿主启动参数，不是 Web 代码）。
   **时机**：必须在 Web 侧取景与识别**真的能用**之后才加 —— 能力声明即承诺，
   提前声明就是给用户画一个点了没反应的入口（§7.4 同一条纪律）。

### 8.4 更正后的 S1b / S2 切片（替代 §5 的 S1/S2）

| 片 | 内容 | 是否碰桥契约 |
| --- | --- | --- |
| **S1a（已完成，`32cb2bb`）** | `scan.camera.select` 能力位 + 3 个相机错误码（Kotlin/TS 同步） | 是（纯新增常量） |
| **S1b（本片，更正后）** | **什么都不登记**：只需把"不做 4 个桥方法"的结论写进 brief（本节） | 否 |
| **S2a** | Web：`enumerateDevices` + 选择持久化 + 空 `label` 兜底 | 否 |
| **S2b** | Web：取景层 + `BarcodeDetector`（回退 ZXing-wasm）+ 错误码映射 + 结果卡 | 否 |
| **S2c** | Electron 主进程：权限处理器；**验证通过后**才在宿主能力表加 `scan.camera` | 否 |

**代价对比**：更正后本片零代码、S2 全在 Web 侧（可被 `check:scan` 直接覆盖），
而原方案要新增 4 个跨进程方法 + 两处落盘 + 一套"谁持有流"的协商 —— 后者才是真正的复杂度来源。

### 8.5 落码进度（2026-10-05 追加，**不改写**上面的切片表）

| 片 | 提交 | 结论 |
| --- | --- | --- |
| S1a | `32cb2bb` | `scan.camera.select` 能力位 + 3 个相机错误码（Kotlin/TS 同步） |
| S1b | `353a6c2` | 推翻"4 个相机桥方法"的设计（更正写进本文 §8） |
| S2a | `c4f99d6` | 枚举与选择（`scan-camera.ts`，零依赖可测）+ 门禁 19 项 |
| S2b | `7f41a9e` | 取景会话与错误映射（`scan-stream.ts`）+ 门禁 26 项 |
| S2b2 | `a0157d6` | 引擎选择与结果归一化（`scan-decode.ts`）+ 门禁 23 项 |
| S2b3 | `a2ba756` | 取景层落地（`CameraScanPanel.vue` + `scan-engines.ts` + `scan-zxing.ts`）+ 门禁 43 项 |

**S2b3 的两条实测补充**（§7.2 没写到的）：

1. **自动播放**：`<video>` 必须 `muted`，否则 Chromium 拒绝自动播放，取景层停在第一帧
   而状态已经是 `running` —— 又是一个"说自己在跑"的死状态。
2. **回退的字节从哪来**：zxing-wasm **默认从 jsDelivr CDN 拉 wasm**（不是随包走）。
   装在现场机器上的应用断网是常态，留着默认值等于"回退路径只在有网时存在"。
   所以 S2b3 用 Vite 的 `?url` 把 `zxing_reader.wasm` 打包成本地 asset 并覆盖 `locateFile`。
   → **教训**：只写"要回退"不够，还要写"回退的那 953KB 从哪来"。

**还差 S2c（两件，缺一不可）**：

1. Electron 主进程加 `session.setPermissionRequestHandler`（允许 `media` 并记录决定）——
   不实现它，打包后的应用里 `getUserMedia` 会静默失败，**真机走查根本走不到那一步**；
2. 真机走查（对着条码出 `evt scan.code`、关窗/失焦后 `track.readyState === 'ended'`）通过后，
   再在宿主能力表加 `scan.camera`（`apps/desktop/src/bridgeProcess.ts` 的 `--capabilities`）。

**在 2 完成之前，桌面看不到扫码入口** —— 这是有意的（能力声明即承诺），
不是漏接线：`check:render` 的两条用例正分别钉住"有能力就画"与"没能力一个字都不出现"。

### 8.6 S2c 落码与三条实测（2026-10-05，`check:desktop-camera` 25 项）

**做的两件事**（brief §8.3 的那两件）：

1. **权限处理器**（`apps/desktop/src/main.ts` 的 `registerPermissionHandlers`）：只放行
   `app://wise` 的 `media`；请求处理器与同步检查处理器**同源判据**；每次请求留一行 `[perm]` 日志
   并进流水账。**真机自检已验**：`pnpm desktop:smoke` 真开一次流 —— 枚举 → `getUserMedia` →
   track `live` → 停流 `ended`，并断言权限处理器**真的被调用过**（15 项通过 / 1 项跳过）。
2. **能力声明**：`apps/desktop/src/bridgeProcess.ts` 的 `--capabilities` 加了
   `scan.camera,scan.camera.select`。

**两条更正**（§8.1 / §5 里做不到的部分，以本节为准）：

- §8.1 写"`scan.camera.select` 由壳在声明时判断（桌面：枚举数 > 1 时才加）"——**做不到**：
  Electron 主进程**没有 `mediaDevices`**，枚举只能在渲染进程里做。
  所以能力位表达"这个宿主能枚举并选择"，而"这台机器有没有得选"由**界面**按
  `cameras.length > 1` 把关（单摄像头机器上不会出现只有一项的下拉）。
- §5 的"无摄像头时能力位不声明"在桌面**不可实现**（同上：宿主看不到设备）。
  于是"没有摄像头"由取景层的**明确文案 + 出路**承担（"没有可用的摄像头" + 重试/关闭），
  而不是靠不声明 —— 能说清原因的失败，不是死入口。

**三条实测**（都是第一次跑真机自检就抓到的，全部来自 `pnpm desktop:smoke`）：

1. **`app:` 不是 URL 标准里的 special scheme**：主进程里
   `new URL('app://wise/index.html').origin` 返回的是**字符串 `'null'`**（Chromium 里才是
   `app://wise`）。第一版权限处理器拿它判 origin，于是把请求全拒了 ——
   表现正是"点了没反应"。判据改成整串比较（`isOurOrigin`），门禁里有回归护栏。
2. **`MediaStreamTrack.readyState` 只有 `live` / `ended`**，没有 `running`：
   写成 `running` 的断言会把"真的取到画面"误判成失败。
3. **Windows 上 Chromium 没有 `BarcodeDetector`**（Shape Detection 的条码识别只在
   macOS / Android / ChromeOS 提供）→ **现场机器上真正干活的是 ZXing 回退路径**。
   §7.2 说"回退必须实现"是设计判断，到这一步变成了实测事实：它不是以防万一，是主路径。
   所以自检里单独钉住它的两件事 —— wasm 的字节随包发出（953,527 B，`app://` 可读）、
   模块可加载且导出 `readBarcodes` / `prepareZXingModule`。

**还剩唯一一步人工**：拿一张实物条码走查（相机拍不出条码这件事，自动化替代不了）。
排障入口已写进 `docs/troubleshooting.md` 第七节（`[perm]` 那一行是第一现场）。



