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

