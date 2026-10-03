# 手机 NFC（B3）实施 brief

> 体例同 `2026-10-05-desktop-camera-scan-brief.md`：先把契约、三态机、生命周期落点与验收钉死再落码。
> **相机（B1/B2）与 NFC（B3）改同一批手机壳文件**，所以本 brief 里专门有一节写边界（§5）。

## 0. 目标与非目标

**目标**：手机（Android 壳）**自动**使用 NFC —— 进入应用即开始读，读到标签推结果给 Web；
"NFC 没开启"与"这台机器没有 NFC"各自有**明确且不同**的界面表现，且都给得出下一步。

**非目标**：
- 写标签（NDEF 写入）、点对点（Beam）、卡模拟（HCE）——本片只做**读**；
- 桌面端 NFC（桌面没有这个能力，也不该声明）；
- 读到的标签做业务解释（那属于 Web 侧，本片只把 `{id, tech}` 交出去）。

## 1. 现状（都有出处）

| 事实 | 出处 |
| --- | --- |
| 手机壳的能力表**只有两项**：`storage.secure`、`scan.gun.keyboard` —— **没有 `nfc.read`** | `apps/mobile/shell/.../ShellApplication.kt` 的 `ANDROID_CAPABILITIES` |
| 那里明确写着"NFC 在 W8 接入，届时在这里逐个加，UI 自动跟着亮" | `apps/mobile/shell/.../ShellBridge.kt:18` |
| 手机侧连相机能力都是**按实际能不能做到**动态过滤的（拿不到 Keystore 就撤回 `storage.secure`） | 同文件 `ANDROID_CAPABILITIES` 的 KDoc |

⇒ **现在没有"声明了却做不到"的违规**，B3 的正确顺序是"先实现、后声明"。
这条纪律在 `BridgeCapabilities.common` 的注释里已经有前车之鉴（"常量声称有、实际没有"比不声明更糟）。

## 2. 契约（本片新增，**只加一个本机方法**）

**能力位**：`nfc.read`（已有常量，本片起**按硬件实际存在**声明）

**本机方法（只加一个，理由见下）**

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `nfc.openSettings` | — | `{opened:boolean}` | 跳到系统 NFC 设置页（`Settings.ACTION_NFC_SETTINGS`）。**只有壳能跳**，所以必须是本机方法 |

**为什么没有 `nfc.start` / `nfc.stop`**：与相机流同一条教训（相机 brief §8.2）——
"自动使用"意味着 reader mode 由壳在 `onResume` 开、`onPause` 关，
把它做成方法就是**双所有者**（壳以为在扫、Web 以为停了）。Web 只消费结果。

**事件**

| topic | 载荷 | 说明 |
| --- | --- | --- |
| `nfc.tag` | `{id, tech, at}` | 读到标签；`id` 是 hex 字符串，`tech` 是技术名（如 `NfcA`） |
| `nfc.state` | `{state, reason?}` | `off` / `on` / `unsupported`；用于界面在**没有标签时**也能说清状态 |

**错误码（新增两个）**

| 码 | 含义 | 界面该说什么 / 做什么 |
| --- | --- | --- |
| `BRIDGE_NFC_UNSUPPORTED` | 本机没有 NFC 硬件 | "这台设备没有 NFC"（且**不画入口**，见 §4） |
| `BRIDGE_NFC_DISABLED` | 有硬件但系统里关着 | "NFC 未开启" + **「去开启」**（调 `nfc.openSettings`） |

> 两个码分开：`UNSUPPORTED` 没有出路（只能换设备），`DISABLED` 有出路（去设置里点一下）。
> 合成一个码，界面就只能说一句"NFC 不可用"，用户不知道该干什么。

## 3. 平台落点（Android）

| 落点 | 做什么 | 为什么在这里 |
| --- | --- | --- |
| `AndroidManifest.xml` | `<uses-feature android:name="android.hardware.nfc" android:required="false" />` | 声明硬件但**不强制**（required=false），否则没有 NFC 的设备装不上 |
| `NfcReader.kt`（**新文件**） | 封装 `NfcAdapter` + `enableReaderMode` + `ReaderCallback` + 去抖 | 把 Android 细节挡在壳内部，`MainActivity` 只留两行接线（也把与相机会话的**文件冲突面**降到最低） |
| `MainActivity.onResume` | `nfcReader.start()` | "自动使用"的落点：回到前台就开始读，不需要用户点任何东西 |
| `MainActivity.onPause` | `nfcReader.stop()` | 离开前台必须关，否则持着 reader mode 会与其它 NFC 应用抢 |
| `ShellBridge` / `ShellApplication` | **能力表加 `nfc.read`**（仅当 `NfcAdapter != null`） | 能力声明即承诺：没有硬件就不声明 |

**三个 Android 细节（容易漏，逐条都是实测会踩的）**：

1. **用 `enableReaderMode` 而不是前台派发（`enableForegroundDispatch`）**：
   前者直接给原始标签、不经过系统的 NDEF 解析链 —— 后者表现为"读到了但要等几秒才回调"。
   建议 flags：`FLAG_READER_NFC_A or FLAG_READER_NFC_B or FLAG_READER_NFC_F or FLAG_READER_NFC_V`
   （按实际支持的协议取舍，**不要**加 `FLAG_READER_SKIP_NDEF_CHECK` 之后再依赖 NDEF 内容）。
2. **`ReaderCallback` 在 binder 线程上回调**：任何 UI/桥广播都要**切回主线程**
   （`Handler(Looper.getMainLooper())` 或壳自己的 dispatcher），否则会在非主线程碰桥的状态。
3. **同一张卡会连续回调**：必须**去抖**（同一个 `id` 在 ~1.5s 内只上报一次），
   否则界面会瞬间收到几十条 `nfc.tag`。去抖放在 `NfcReader` 里（有状态、可单测）。

## 4. UI 状态机（能力声明即承诺）

```
无 nfc.read 能力（或 unsupported）  → 不画任何 NFC 入口（连"未开启"都不画）
有硬件但未开启                      → 状态条：「NFC 未开启」+「去开启」按钮（调 nfc.openSettings）
有硬件且已开启、无标签              → 「请将标签靠近手机背部」（就绪态，不是错误）
读到标签                            → 标签信息卡（id / tech）+ 可继续读下一张
```

三条纪律：① 入口只由能力位决定；② `UNSUPPORTED` 与 `DISABLED` **两种文案与出路都不同**；
③ 读到之后**不停读**（NFC 是"贴一下就扫"，不该要用户重新点开始）。

## 5. 与相机会话（B2）的边界 —— **本片最容易出事的地方**

相机与 NFC **改的是同一批文件**：`MainActivity.kt`（生命周期）、`ShellApplication.kt` / `ShellBridge.kt`（能力表）、
`AndroidManifest.xml`（权限与 uses-feature）。两个会话并行改必然冲突。

**约定（必须选一条，且写进两个会话各自的说明里）**：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **A 串行（推荐）** | 相机落定后再开 NFC；同一会话接着做 | 单人/单会话推进时唯一稳的做法 |
| **B 并行分工** | NFC 只碰**新文件**（`NfcReader.kt` + `MainActivity` 的两行接线 + Manifest 一行），**能力表那一处由相机会话统一收口** | 两个会话确实要并行时 |

无论哪条：**`ANDROID_CAPABILITIES` 在同一时刻只能有一个会话在改**。

### 5.1 决定（2026-10-05，用户拍板）：走 **A 串行**

**触发条件**（满足后才开 B3 的 S2）：相机那个会话把 **B1 收口**，具体是"桌面端 S2c 完成"——
即 Electron 的 `session.setPermissionRequestHandler` 已实现、且 `scan.camera` **已经验过识别能用之后**
才在宿主能力表声明。理由很直接：`scan.camera` 与 `nfc.read` 最终要落进同一批能力表，
而"能力声明即承诺"这条纪律一旦被两处并发改动破坏，就会同时给两个功能画出点了没反应的入口。

**若相机会话延迟**：B3 仍可在**方案 B**下并行，但那时 `NfcReader.kt` 之外的一切
（`MainActivity` 的两行接线、Manifest、能力表）都要等相机会话统一收口后再合，
不要各改一半 —— 半个接线比没接线更难查。

## 6. 分片与验收

| 片 | 内容 | 验收 |
| --- | --- | --- |
| **S1 契约** | `nfc.openSettings` 登记进本机方法表；两个错误码；`nfc.tag` / `nfc.state` 事件常量；TS 侧同步 | `pnpm check`（含 `check:contract`）全绿；TS `typecheck` 通过 |
| **S2 NfcReader** | 新文件：`NfcAdapter` 三态判定 + `enableReaderMode` + 主线程跳转 + **去抖** | 纯逻辑部分（去抖与三态判定）用假 `NfcAdapter` 在 JVM 单测里跑（照相机三层"零依赖 + 注入"的体例） |
| **S3 生命周期接线** | `MainActivity.onResume/onPause`；Manifest `uses-feature` | 真机：进入应用能读到；切后台后 reader mode 已关（另一款 NFC 应用能接管） |
| **S4 能力与界面** | 能力表加 `nfc.read`（仅当有硬件）；Web 侧按 §4 四态渲染 + 「去开启」 | `check:scan*` 家族的体例加一条"无能力不画入口 + 两种文案不同"；真机走查：关掉系统 NFC 看是否出现「去开启」且按钮真的能跳到设置页 |

## 7. 风险与诚实边界

1. **真机依赖**：NFC 只能在真手机上验（WSA 的 NFC 不可用/不稳定）。本片**没有**真机证据就不算完成
   ——与"相机识别"同一条标准。
2. **`nfc.read` 的声明时机**：必须等**读到标签真的能走通**之后才加进 `ANDROID_CAPABILITIES`；
   提前声明就是给用户画一个点了没反应的入口（B1 里已经为此推翻过一次设计）。
3. **不做去抖的后果**是"界面刷屏"，而不是崩溃——所以它最容易被跳过；把它放进 S2 的**可单测**部分，
   就是为了不靠人去记得。
4. **读取频率与功耗**：`onResume` 即开会让 NFC 在前台常驻轮询。若实测功耗明显，
   退路是"进入现场域/标签屏时才开"——但那个判据属于 Web 侧（切页事件），
   届时要新增一个"通知壳开始/停止"的通道，**本片不做**（先按最简单的自动模式落地并实测）。

## 8. 记账（2026-10-05，S3 + S4 实做）

**做了什么**（对照 §6 的分片表）

| 片 | 落点 | 状态 |
| --- | --- | --- |
| S1 契约（收尾） | 新增 `BridgeLocalMethods`（本机方法表的 id 单一出处）+ TS `LocalMethod`；两个错误码与两个事件 topic 早在 `b40e0aa` 已落 | ✅ |
| S2 去抖与三态 | 原样复用 `bdadd37` / `05a1a91` 的两个文件；本轮只把"状态上报"改成**每次 `start` 都报**（就绪态也要报，见下） | ✅ |
| S3 生命周期接线 | `MainActivity.onResume/onPause` + `AndroidManifest` 的 `uses-feature android.hardware.nfc`（required=false，且**不加** `permission.NFC`：读卡不需要它） | 代码 ✅ / 真机 ❌（见下） |
| S4 能力与界面 | 本机方法表接进桥的分发（`local = NfcLocalMethods()`）+ `NfcStatus.vue` 四态 + `check:nfc`（38 项） | 界面已落；**能力位仍压着不声明** |
| S2a 遗留的门禁缺陷 | `useJUnitPlatform()` + `NfcReaderStateTest` 恢复 | ✅ 14 个用例**真的在跑** |

**证据**（都在本机跑过，不是"应该能过"）

- `gradlew -p . :bridge:protocol:test :apps:mobile:shell:testDebugUnitTest` → BUILD SUCCESSFUL；
  结果 XML 里 `NfcReaderStateTest` = `tests=14 failures=0 errors=0 skipped=0`
  （`:bridge:protocol` 的 `BridgeLocalMethodsTest` = 3）。**"测试真的在跑"这条靠这个 `tests=` 数字**，
  不靠构建绿 —— S2a 那次正是绿着但 `build/test-results` 是空的。
- `pnpm check:nfc` → 38 项全过（契约串逐字一致 / 本机方法表 / 先实现后声明 / 生命周期 / 去抖 / Web 四态 / 单测真跑）。
- `pnpm typecheck`、`pnpm check:css`（新增的 `.w-nfc*` 样式没有未定义令牌）通过。

**两处与 §3/§4 的取信口径不同，写在这里免得被当成漏做**

1. **`nfc.state` 每次 `start()` 都上报**（不只异常态）：界面可能是**刚重建**的
   （渲染进程崩溃后 WebView 重挂，而 Activity 从未 pause），那一条事件是它唯一能知道
   "NFC 现在是开着的"的途径 —— §4 的"就绪态"就靠它。
2. **reader 已经在 `onResume` 跑起来了，而对外声明还没开**：这是刻意的"先实现、后声明"。
   `NFC_READ_VERIFIED=false` 期间 Web 侧不订阅这两个事件（能力位为假时 `NfcStatus` 连监听都不挂），
   所以**用户可见行为为零**，只有 logcat 里那几行 `[nfc] …` —— 而 S3 的真机验收正是看它们。

**没做完的（诚实边界）**

1. **真机三步一条都没验**（本机没有真机，WSA 的 NFC 不可用）：
   ① 贴卡能读到（logcat `[nfc] 读到标签 id=… tech=…`）；
   ② 切后台后 reader mode 真的关了（另一款 NFC 应用能接管）；
   ③ 关掉系统 NFC 时界面出现「去开启」且按钮真能跳到设置页。
   → 因此 `ShellBridge.NFC_READ_VERIFIED` **保持 `false`**：`nfc.read` 不声明，界面上连入口都不出现（§4 第一行）。
2. `nfc.state` 只在 `onResume` 刷新：用户在应用里把 NFC 拨掉，要等"切后台再回来"界面才知道。
   本片**不做** `ACTION_ADAPTER_STATE_CHANGED` 监听 —— §3 的落点表里没有它，要做是下一片。
3. §0 的非目标不变：不读 NDEF 内容、不写卡、不点对点、不做卡模拟、不解释标签的业务含义。
4. §2 里 `UNSUPPORTED` 的那句"这台设备没有 NFC"**没有落点**：§4 要求这种情况不画任何入口，
   所以界面上不出现这句话（要说得留给"设备信息/关于"这类地方，不在这里画个死入口）。

**翻转 `NFC_READ_VERIFIED` 的操作（一次真机走查，三条全绿才翻）**

1. 把它改成 `true` —— **只改这一行**：能力位声明、事件、界面共用同一份判据；
2. `pnpm check:nfc` 里有一条断言是"当前还没验"这个**事实**的钉子，同一次提交里带着 logcat 证据一起更新；
3. 走查上面 ①②③，把结果追加到本节（哪台机器、什么系统版本、哪张卡）。

## 9. 追加（紧接着 S3/S4）：把"`nfc.state` 只在 `onResume` 刷新"这个缺口补掉

§8 的"没做完的 2"当时写成"要做是下一片"——紧接着就做了它，因为它的后果正是本 brief 最忌讳的那类：
**从通知栏拨 NFC 开关不会 pause Activity**，于是界面会一直说"请将标签靠近手机背部"，
而系统里 NFC 已经关了：用户贴卡没反应，且没有任何提示（一个"说自己在就绪"的死状态）。

落点：

- `MainActivity` 注册 `ACTION_ADAPTER_STATE_CHANGED`（`ContextCompat.registerReceiver` +
  `RECEIVER_NOT_EXPORTED`：我们只收**系统**这一条广播），`onResume` 挂、`onPause` 摘；
- 收到后**重新读适配器**再决定，不信广播 extras 里那份可能过期的快照；
- **关闭时必须先 `stop()` 再报状态**：只重新 `start()` 的话 `reading` 还立着 `true`，
  而系统那边已经丢掉了 reader mode —— 等 NFC 再打开，`start()` 会以为"已经在读"而**不再注册**，
  表现还是"贴卡没反应"（只是这次发生在打开之后，更难查）。
  这条判据提到 `NfcReaderState.actionAfterAdapterChange`（可 JVM 穷举），单测覆盖两个分支。

验证：`gradlew :apps:mobile:shell:testDebugUnitTest` → `NfcReaderStateTest` tests=15（+1）；
`pnpm check:nfc` 64 项。**§8 那三条真机走查仍然没做，未完成的口径不变。**

## 10. 同一批：把"四态"提成可执行的那一层（否则 S4 只有源文本证据）

§6 给 S4 的验收是"门禁加一条『无能力不画入口 + 两种文案不同』"——而**源文本断言只能证明
"模板里写了这几个词"**，证明不了"收到 `{state:1}` 或 `null` 时会怎样"。这一片最容易错、
又**不会报错**的恰恰是没有配对的输入：壳将来多一个状态取值、或者事件被打包成别的形状时，
正确行为是"保持原状、不要清空界面"。

因此把判定从组件里提出来，做法与相机那一套完全相同（`scan-camera.ts` / `scan-stream.ts`）：

- 新增 `packages/layouts/src/nfc-state.ts`（**零依赖**，所以门禁能用 `esbuild + node`
  把真模块执行一遍）：`shouldRenderNfc` / `nfcPhaseOf` / `nextNfcPhase` / `nfcTagOf` /
  `openSettingsSucceeded`，以及四个契约串字面量；
- `NfcStatus.vue` 只做订阅与渲染（`v-if="visible"`）；
- `check-nfc.mjs` 第 8 节真跑这个模块：入口判据 5 条、状态映射含"未知识别不出来时保持原状"、
  标签载荷 3 条、「去开启」返回值判定 2 条 —— "没有能力时一个像素都不画"这条从此有**可执行证据**。

**仍然没有任何运行期证据的部分**：组件在真浏览器里的渲染结果（DOM 长什么样、层级对不对）。
那需要把 `nfc.read` 注入一次 dev 会话（`pnpm dev` 的假桥**不声明**它 —— 浏览器真的读不了 NFC，
声明了就是撒谎），或者等真机走查。这一段不做，理由写在这里，免得下一个人以为它验过了。

## 11. §8 的三条走查有了可执行的形式：`pnpm smoke:nfc-device`

§8 的走查原先只是一段说明书 —— 而"说明书式的验收"最容易变成"看着像做过了"。
`scripts/nfc-device-check.ps1` 把它落成一次可复现的检查（做法与 `desktop.ps1 -Smoke` 同源）：

| 步骤 | 判据（logcat） |
| --- | --- |
| 进入应用能读到 | `readerMode=on` |
| 关掉系统 NFC | `adapterChanged state=DISABLED`（界面出现「去开启」） |
| 再打开 | `adapterChanged state=READY`（**重新注册**，不重开会表现为贴卡没反应） |
| 贴卡能读到 | `tagRead id=… tech=…`（要人真的贴卡） |
| 切后台 | `readerMode=off`（别的 NFC 应用能接管） |

三条口径刻意写死在这里，免得下一个人"顺手放宽"：

1. **跳过 ≠ 通过**。没 adb / 没插设备 / 这台机器没有 NFC / 没人贴卡 → 记**跳过**并
   **退出码 2**（`0` 只给"三项都真验到了"，`1` 是失败）。所以 `exit 0` 才是能写进交付的那份记录。
2. **判定只认 ASCII 锚点**（`readerMode=on` 这类）。壳里的日志行因此带上了这些锚点
   （`NfcReader` / `MainActivity`）—— 控制台编码或中文措辞变了也不会"看起来跑过了"，
   而且现场可以直接 `adb logcat -s WiseShell:I | findstr tagRead`。
3. **它不在 `pnpm check` 链里**：没有手机的人不该天天红（`check-nfc.mjs` 有一条断言钉住这件事）。

本机现在跑它得到的是 `通过 0 / 跳过 1 / 失败 0`、退出码 **2** ——
即"**未验**"，与 §8 的口径一致。

## 12. §10 末段"这一段不做"已被取代：四态在真浏览器里验过了

§10 最后一段当时写的是"组件在真浏览器里的渲染结果没有运行期证据…这一段不做"。
它现在被取代了 —— 不是靠"给假桥加上 `nfc.read`"（那才是撒谎：浏览器真的读不了 NFC），
而是加了一条**显式**的模拟通道：

- `createBridge` 的 **mock 分支**读 URL 上的 `?simulate=nfc.read`（`simulatedCapabilities`）：
  **只有显式写在 URL 上**才生效，默认的开发态与真机（未声明时）**表现完全一致**（一个像素都不多画）；
  真实宿主那条 return 在它之前，生产不可能因为一个查询串多出能力；
  而且"模拟了什么"会出现在引导来源串里（`已模拟能力 …`），界面上那行"开发态假桥"的横幅不会骗人。
- 假桥实现了 `nfc.openSettings` → `{opened: boolean}`（与真壳同形状），并给了
  `setNfcSettingsOpens(false)` 用来复现"打不开系统设置页"这条真机上只在少数 ROM 碰得到的分支。

`apps/web/smoke/check-web-smoke.mjs` 末尾新增一节（会重新加载页面，所以放最后），断言：

| 断言 | 说明 |
| --- | --- |
| 没有 `nfc.read` 能力 → 不画任何 NFC 入口 | **这就是当前要交付的配置**（能力位还压着） |
| 能力位在 → 状态条 + 「请将标签靠近手机背部」 | §4 的就绪态 |
| 壳报 `off` → 「NFC 未开启」+「去开启」，且就绪那句话消失 | 两种状态两句不同的话 |
| 点「去开启」→ 调用记录里真的出现 `nfc.openSettings` | 读 `__calls`；"画了个按钮"不算数 |
| 回报 `opened:false` → 界面如实改口 | "点了没反应"的反面 |
| `nfc.tag` → 卡片显示 `id` 与 `tech`；收起后回到状态条 | 只显示壳给的东西 |
| 没有 `id` 的 `nfc.tag` → 不画空卡片 | 坏数据不冒充新标签 |
| 壳报 `unsupported` → 整个入口消失 | 那条路没有出路 |
| 认不出来的 `state` 取值 → 界面保持原状 | 壳比 Web 新时不清空、也不假装就绪 |

`pnpm check:web` 因此从 309 项变成 **324 项**（全绿）。

**这仍然不是真机证据**：它验的是 Web 侧——渲染、两态文案、「去开启」真的调了那一条本机方法。
壳侧的 reader mode 起没起、系统设置页能不能跳、广播收不收得到，仍然只能在真机上验
（`pnpm smoke:nfc-device`，§11）。§8 的"没有真机证据就不算完成"口径不变。





