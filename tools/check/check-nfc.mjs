#!/usr/bin/env node
/*
 * check-nfc.mjs —— 手机 NFC（B3/S3+S4）门禁。
 *
 * 这一片的东西几乎全是**"写了但没生效"型**的失败，构建、类型检查、编译全都是绿的：
 *   · 方法 id / 错误码 / 事件 topic 两边拼得不一样 → Web 调用变成 `BRIDGE_METHOD_UNKNOWN`
 *     （看起来像"桥没实现"），或者界面永远收不到事件；
 *   · 本机方法没进分发表 → 同上；进了表却没实现 → `BRIDGE_INTERNAL`（更糟）；
 *   · 能力位提前声明 → 给用户画出"贴了没反应"的入口（brief §7.2）；
 *   · 入口不看能力位 → 在**没有 NFC 的机器**上也画出来；
 *   · 忘了 `onPause` 停 reader → 持着 reader mode 与别的 NFC 应用抢（不崩，只是别人读不到）；
 *   · 单测没启用 JUnit Platform → `testDebugUnitTest` 绿而一个用例都没跑（S2a 实测踩到）。
 *
 * 真机那一步（读到标签 / 关 NFC 看「去开启」/ 切后台别的应用能接管）**本文件验不了**，
 * 它只能钉住"代码结构与判据"。见 brief §8 记账里那条未完成的验收。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const SHELL = 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell';

const protocolKt = read('bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/BridgeProtocol.kt');
const localMethodsKt = read('bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/BridgeLocalMethods.kt');
const stateKt = read(`${SHELL}/NfcReaderState.kt`);
const readerKt = read(`${SHELL}/NfcReader.kt`);
const localKt = read(`${SHELL}/NfcLocalMethods.kt`);
const shellBridgeKt = read(`${SHELL}/ShellBridge.kt`);
const shellAppKt = read(`${SHELL}/ShellApplication.kt`);
const mainActivityKt = read(`${SHELL}/MainActivity.kt`);
const manifestXml = read('apps/mobile/shell/src/main/AndroidManifest.xml');
const shellGradle = read('apps/mobile/shell/build.gradle.kts');
const shellTestKt = read('apps/mobile/shell/src/test/kotlin/com/huicang/wise/client/shell/NfcReaderStateTest.kt');
const typesTs = read('packages/bridge-client/src/types.ts');
const nfcVue = read('packages/layouts/src/NfcStatus.vue');
const nfcStateTs = read('packages/layouts/src/nfc-state.ts');
const appFrameVue = read('packages/layouts/src/AppFrame.vue');
const pkgJson = read('package.json');
const devScript = read('scripts/nfc-device-check.ps1');

const grab = (source, re) => re.exec(source)?.[1] ?? null;

console.log('--- 1. 线上契约串：Kotlin 与 TS 必须逐字一致 ---');
const ktUnsupported = grab(protocolKt, /NFC_UNSUPPORTED:\s*String\s*=\s*"([^"]+)"/);
const ktDisabled = grab(protocolKt, /NFC_DISABLED:\s*String\s*=\s*"([^"]+)"/);
const tsUnsupported = grab(typesTs, /NFC_UNSUPPORTED:\s*'([^']+)'/);
const tsDisabled = grab(typesTs, /NFC_DISABLED:\s*'([^']+)'/);
check('Kotlin 里有 NFC 两个错误码', ktUnsupported !== null && ktDisabled !== null);
check(
  '两个错误码在 Kotlin 与 TS 里逐字一致（合成一个码会让界面说不出"去哪开"）',
  ktUnsupported === tsUnsupported && ktDisabled === tsDisabled && ktUnsupported !== ktDisabled,
  `kotlin=${ktUnsupported}/${ktDisabled} ts=${tsUnsupported}/${tsDisabled}`,
);
check(
  '两个码没有合成一个（出路不同：UNSUPPORTED 只能换设备，DISABLED 能去开启）',
  ktUnsupported !== ktDisabled,
);

const ktTag = grab(stateKt, /EVENT_TAG:\s*String\s*=\s*"([^"]+)"/);
const ktState = grab(stateKt, /EVENT_STATE:\s*String\s*=\s*"([^"]+)"/);
const tsTag = grab(typesTs, /BRIDGE_EVENT_NFC_TAG\s*=\s*'([^']+)'/);
const tsState = grab(typesTs, /BRIDGE_EVENT_NFC_STATE\s*=\s*'([^']+)'/);
check('Kotlin 与 TS 的 NFC 事件 topic 逐字一致', ktTag === tsTag && ktState === tsState, `kotlin=${ktTag}/${ktState} ts=${tsTag}/${tsState}`);

const ktLocal = grab(localMethodsKt, /NFC_OPEN_SETTINGS:\s*String\s*=\s*"([^"]+)"/);
const tsLocal = grab(typesTs, /NFC_OPEN_SETTINGS:\s*'([^']+)'/);
check('本机方法 id 在 Kotlin 与 TS 里逐字一致', ktLocal !== null && ktLocal === tsLocal, `kotlin=${ktLocal} ts=${tsLocal}`);

console.log('--- 2. 本机方法表：登记了、而且真的接进分发表 ---');
check('协议层有本机方法表（BridgeLocalMethods），不是散在宿主里的字符串', /object BridgeLocalMethods/.test(localMethodsKt));
check(
  '壳侧的本机方法表实现 LocalMethodPort',
  /class NfcLocalMethods\s*:\s*LocalMethodPort/.test(localKt),
);
check(
  'methodIds 从协议常量取（硬编码字符串 = 两处各写一份，迟早漂移）',
  /methodIds[^\n]*BridgeLocalMethods\.NFC_OPEN_SETTINGS/.test(localKt),
);
check(
  '壳把方法表传进了桥的配置（不传 = 白名单里没有它，调用回 METHOD_UNKNOWN）',
  /local\s*=\s*NfcLocalMethods\(\)/.test(shellBridgeKt),
);
check(
  '`nfc.openSettings` 返回的是真实结果（{opened:…} 由 reader 报回，不假装成功）',
  /put\(\s*"opened"\s*,\s*JsonPrimitive\(NfcReaderHost\.openSettings\(\)\)\s*\)/.test(localKt),
);
check(
  '**没有**把 start/stop 做成桥方法（双所有者：壳以为在扫、Web 以为停了）',
  !/'nfc\.start'/.test(localKt) && !/"nfc\.start"/.test(localKt) && !/NFC_START/.test(localMethodsKt),
);

console.log('--- 3. 能力声明：先实现、后声明（没有真机证据就不画入口）---');
check(
  'Manifest 声明了 NFC 硬件但 required=false（否则没有 NFC 的设备装不上）',
  /<uses-feature[\s\S]{0,200}?android:name="android\.hardware\.nfc"[\s\S]{0,200}?android:required="false"/.test(manifestXml),
);
check(
  '声明 `nfc.read` 需要**两个**条件同时成立：有硬件 && 真机已验证',
  /if\s*\(hasNfc\s*&&\s*NFC_READ_VERIFIED\)/.test(shellBridgeKt),
);
const verified = grab(shellBridgeKt, /const val NFC_READ_VERIFIED:\s*Boolean\s*=\s*(true|false)/);
check(
  'NFC_READ_VERIFIED 当前是 false —— 读到标签还没在真机上验过，提前声明就是画一个贴了没反应的入口',
  verified === 'false',
  `当前值 ${verified}：翻转时请在同一提交里带上真机证据、并同步本断言与 brief §8 记账`,
);
check(
  '"有没有硬件"用的是适配器判据（resolveAdapter），而不是只有 hasSystemFeature',
  /NfcReader\.resolveAdapter\(this\)\s*!=\s*null/.test(shellAppKt),
);
check(
  '适配器判据只有一份（NfcReader 里那份分版本逻辑，ShellApplication 复用）',
  /internal fun resolveAdapter/.test(readerKt),
);

console.log('--- 4. 生命周期接线：前台开、后台关 ---');
check('onResume 里 start()（"自动使用"的落点）', /override fun onResume\(\)[\s\S]{0,200}?nfcReader\?\.start\(\)/.test(mainActivityKt));
check(
  'onPause 里 stop()（不停 = 持着 reader mode 与别的 NFC 应用抢）',
  /override fun onPause\(\)[\s\S]{0,200}?nfcReader\?\.stop\(\)/.test(mainActivityKt),
);
check(
  'onDestroy 摘掉单例里的 reader 引用（否则把已销毁的 Activity 漏在单例里）',
  /override fun onDestroy\(\)[\s\S]{0,300}?NfcReaderHost\.attach\(null\)/.test(mainActivityKt),
);
check(
  '事件经桥广播（ShellBridge.emit）——不是自己造第二条通路',
  /ShellBridge\.emit\(NfcReaderState\.EVENT_TAG/.test(mainActivityKt) &&
    /ShellBridge\.emit\(NfcReaderState\.EVENT_STATE/.test(mainActivityKt),
);
check(
  '桥真的会把事件广播给连接（ShellBridge.emit → server.emit）',
  /fun emit\([\s\S]{0,400}?server\?\.emit\(topic, data\)/.test(shellBridgeKt),
);
check(
  '页面加载完成时补报一次 NFC 状态（桥没起来时 `nfc.state` 会被丢弃 → 界面停在错误的"就绪"）',
  /private fun warmUpNfc\(\)/.test(mainActivityKt) && /onLoaded\(\)/.test(mainActivityKt),
);
check(
  '补报只在前台做（页面加载完时 Activity 可能已经 pause）',
  /private fun warmUpNfc\(\)[\s\S]{0,200}?if \(nfcForeground\)/.test(mainActivityKt),
);

console.log('--- 4b. 系统开关被拨动：通知栏那枚开关不会 pause Activity ---');
check(
  '收了 ACTION_ADAPTER_STATE_CHANGED（不收 = 界面一直说"就绪"，而 NFC 已经关了）',
  /NfcAdapter\.ACTION_ADAPTER_STATE_CHANGED/.test(mainActivityKt),
);
check(
  '用 ContextCompat.registerReceiver + RECEIVER_NOT_EXPORTED（targetSdk 34 起必须显式声明导出性）',
  /ContextCompat\.registerReceiver\([\s\S]{0,300}?ContextCompat\.RECEIVER_NOT_EXPORTED/.test(mainActivityKt),
);
check(
  'onResume 挂、onPause 摘（成对；挂着不放会在 Activity 销毁后继续收广播）',
  /override fun onResume\(\)[\s\S]{0,300}?registerNfcAdapterListener\(\)/.test(mainActivityKt) &&
    /override fun onPause\(\)[\s\S]{0,300}?unregisterNfcAdapterListener\(\)/.test(mainActivityKt),
);
check(
  '判据走可单测的那一层（actionAfterAdapterChange），不在 Activity 里再写一遍 if',
  /NfcReaderState\.actionAfterAdapterChange\(reader\.availability\)/.test(mainActivityKt),
);
check(
  '关闭时**先 stop 再 start**（只 start 的话 reading 还立着，NFC 再打开时不会重新注册 reader mode）',
  /STOP_THEN_REPORT -> \{[\s\S]{0,120}?reader\.stop\(\)[\s\S]{0,60}?reader\.start\(\)/.test(mainActivityKt),
);
check(
  '单测覆盖这两个分支（RECONNECT / STOP_THEN_REPORT）',
  /actionAfterAdapterChange\(NfcAvailability\.READY\)/.test(shellTestKt) &&
    /actionAfterAdapterChange\(NfcAvailability\.DISABLED\)/.test(shellTestKt),
);

console.log('--- 5. 去抖：不做不会崩，只会刷屏（所以最容易被漏）---');
check('去抖窗口是 1.5 秒（DEFAULT_WINDOW_MS）', /DEFAULT_WINDOW_MS:\s*Long\s*=\s*1_500/.test(stateKt));
check('reader 的回调接了去抖（shouldReport → debouncer）', /debouncer\.shouldReport\(id, nowMs\)/.test(readerKt));
check(
  '切后台会清去抖状态（"停十分钟再贴同一张"不该被当成连击）',
  /fun stop\(\)[\s\S]{0,200}?debouncer\.reset\(\)/.test(readerKt),
);
check(
  '回调切回主线程（binder 线程上碰桥状态是另一种 bug）',
  /mainHandler\.post\s*\{/.test(readerKt),
);

console.log('--- 6. Web 侧：入口只由能力位决定，两态两文案 ---');
check('入口判据是能力位 nfc.read（不是平台字符串）', /NFC_CAPABILITY\s*=\s*'nfc\.read'/.test(nfcStateTs) && /supports\(NFC_CAPABILITY\)/.test(nfcVue));
check(
  '渲染与否交给判定层（shouldRenderNfc）——不是模板里各写一份 if',
  /shouldRenderNfc\(canRead\.value, phase\.value\)/.test(nfcVue) && /v-if="visible"/.test(nfcVue),
);
check('「NFC 未开启」与「请将标签靠近手机背部」是两句不同的话（出路不同）', /NFC 未开启/.test(nfcVue) && /请将标签靠近手机背部/.test(nfcVue));
check('「去开启」真的调本机方法（用常量，不写字面量）', /bridge\.call<\{ opened\?: boolean \}>\(NFC_OPEN_SETTINGS\)/.test(nfcVue));
check(
  '打不开系统设置时如实改口（只有明确的 opened:true 才算成功，判定在 nfc-state.ts）',
  /openSettingsSucceeded\(result\)/.test(nfcVue) && /readField\(result, 'opened'\) === true/.test(nfcStateTs),
);
check(
  '订阅用的是判定层的常量（与壳的 topic 同源）',
  /bridge\.subscribe\(NFC_EVENT_STATE/.test(nfcVue) && /bridge\.subscribe\(NFC_EVENT_TAG/.test(nfcVue),
);
check('外壳只挂一份 NfcStatus（两处各挂一份 = 同一个事件画两张卡）', (appFrameVue.match(/<NfcStatus/g) ?? []).length === 1);
check('且挂在 `.w-main` 的流内（挂到 shell 末尾会变成侧栏旁边的一列）', /<NfcStatus \/>[\s\S]*?唯一的内容实例/.test(appFrameVue));

console.log('--- 7. 单测是真的在跑（S2a 踩过"绿着但没执行"）---');
check('Android 模块启用了 JUnit Platform（缺它则 JUnit5 用例被静默跳过）', /tasks\.withType<Test>\(\)[\s\S]{0,200}?useJUnitPlatform\(\)/.test(shellGradle) || /useJUnitPlatform\(\)/.test(shellGradle));
const testCount = (shellTestKt.match(/@Test/g) ?? []).length;
check(
  'NfcReaderStateTest 的用例数 > 0（门禁自己也别静默通过）',
  testCount > 0,
  `找到 ${testCount} 个 @Test`,
);
check(
  '单测覆盖"没有硬件但开关是 on"这个坑（判成 DISABLED 会给出开不了的「去开启」）',
  /decide\(adapterPresent = false, adapterEnabled = true\)/.test(shellTestKt),
);
check(
  '单测覆盖去抖的窗口边界（正好一个窗口后算新的一次）',
  /shouldReport\("aa", 1_500\)/.test(shellTestKt),
);
check(
  '单测覆盖本机方法：没登记的方法必须抛错（不许本机这一段自己放行）',
  /assertFailsWith<IllegalArgumentException>/.test(shellTestKt),
);

console.log(
  `  · 真机那一步（本文件验不了）：读到标签 / 关 NFC 看「去开启」/ 切后台别的应用能接管 —— 见 brief §8 记账`,
);

console.log('--- 8. 真的跑一遍四态判定（esbuild + node 执行真模块，不是源文本断言）---');
/*
 * 为什么值得单独一节：第 6 节那些断言只能证明"模板里写了哪几个词"，
 * 证明不了"收到 `{state:1}` 或 `null` 时会怎样"。而这一片最容易错、又不会报错的正是
 * **没有配对的输入**（壳多一个取值 / 事件被打包成别的形状）—— 那时的正确行为是
 * "保持原状、不要清空界面"。做法与相机那一套一致（`check-scan-camera.mjs` 同款）。
 */
const nfcStateJs = transformSync(nfcStateTs, { loader: 'ts', format: 'esm' }).code;
const st = await import(`data:text/javascript;base64,${Buffer.from(nfcStateJs).toString('base64')}`);

check(
  '判定层的三个契约串与 TS 常量逐字一致（这里是字面量，一旦漂移两边都看不出）',
  st.NFC_EVENT_TAG === tsTag && st.NFC_EVENT_STATE === tsState && st.NFC_OPEN_SETTINGS === tsLocal,
  `模块=${st.NFC_EVENT_TAG}/${st.NFC_EVENT_STATE}/${st.NFC_OPEN_SETTINGS} ts=${tsTag}/${tsState}/${tsLocal}`,
);
check(
  '能力位的字符串也与 TS `Capability` 一致',
  grab(typesTs, /NFC_READ:\s*'([^']+)'/) === st.NFC_CAPABILITY,
  `${st.NFC_CAPABILITY}`,
);

// —— 入口判据：无能力 / unsupported 一律不画 ——
check('没有能力 → 不画（哪怕状态是就绪）', st.shouldRenderNfc(false, 'ready') === false);
check('没有能力 + 未开启 → 也不画（不是"改画一条未开启提示"）', st.shouldRenderNfc(false, 'off') === false);
check('有能力但壳报 unsupported → 不画（那条路没有出路）', st.shouldRenderNfc(true, 'unsupported') === false);
check('有能力 + 就绪 → 画', st.shouldRenderNfc(true, 'ready') === true);
check('有能力 + 未开启 → 画（要给出「去开启」这条出路）', st.shouldRenderNfc(true, 'off') === true);

// —— 状态映射：三种取值 + 认不出来的保持原状 ——
check('on → 就绪（壳自己的用词是 on，不是 ready）', st.nfcPhaseOf({ state: 'on' }) === 'ready');
check('off → 未开启', st.nfcPhaseOf({ state: 'off' }) === 'off');
check('unsupported → 无硬件', st.nfcPhaseOf({ state: 'unsupported' }) === 'unsupported');
check(
  '认不出来的取值回 null（调用方据此保持原状，而不是清空或假装就绪）',
  st.nfcPhaseOf({ state: 'sleeping' }) === null &&
    st.nfcPhaseOf({ state: 1 }) === null &&
    st.nfcPhaseOf({}) === null &&
    st.nfcPhaseOf(null) === null &&
    st.nfcPhaseOf('off') === null,
);
check(
  '未知取值不改变当前状态（"壳比 Web 新"时界面要还能用）',
  st.nextNfcPhase('off', { state: 'sleeping' }) === 'off' && st.nextNfcPhase('ready', null) === 'ready',
);
check(
  '已知取值照常切换（就绪 ⇄ 未开启都要动）',
  st.nextNfcPhase('ready', { state: 'off' }) === 'off' && st.nextNfcPhase('off', { state: 'on' }) === 'ready',
);

// —— 标签载荷 ——
const tagOk = st.nfcTagOf({ id: '04a1b2c3', tech: 'NfcA', at: 1_731_000_000_000 });
check('完整载荷 → id/tech/at 原样', tagOk.id === '04a1b2c3' && tagOk.tech === 'NfcA' && tagOk.at === 1_731_000_000_000);
const tagNoTech = st.nfcTagOf({ id: 'aa' });
check('缺 tech → Unknown（与壳侧的兜底一致），缺 at 用当前时间', tagNoTech.tech === 'Unknown' && typeof tagNoTech.at === 'number' && tagNoTech.at > 0);
check('没有 id / 空 id / 不是对象 → 不画空卡片', st.nfcTagOf({}) === null && st.nfcTagOf({ id: '' }) === null && st.nfcTagOf(null) === null);

// —— 「去开启」的返回值判定 ——
check('opened:true 才算打开成功', st.openSettingsSucceeded({ opened: true }) === true);
check(
  '其余一律算没打开（false / 缺字段 / 类型不对 / 老壳没有这个方法）',
  st.openSettingsSucceeded({ opened: false }) === false &&
    st.openSettingsSucceeded({}) === false &&
    st.openSettingsSucceeded({ opened: 'true' }) === false &&
    st.openSettingsSucceeded(undefined) === false &&
    st.openSettingsSucceeded(null) === false,
);

console.log('--- 9. 真机走查脚本：跳过不等于通过，判定只认 ASCII 锚点 ---');
const anchors = ['readerMode=on', 'readerMode=off', 'readerMode=skipped state=', 'adapterChanged state=', 'tagRead id='];
check(
  '判定只用 ASCII 锚点（日志里的中文措辞或控制台编码变了，也不会"看起来跑过了"）',
  anchors.every((a) => devScript.includes(a)),
  anchors.filter((a) => !devScript.includes(a)).join(', '),
);
check(
  '这些锚点壳里真的打了（脚本与代码同源：改日志名就会红）',
  /readerMode=on/.test(readerKt) &&
    /readerMode=off/.test(readerKt) &&
    /readerMode=skipped state=/.test(readerKt) &&
    /tagRead id=/.test(mainActivityKt) &&
    /adapterChanged state=/.test(mainActivityKt),
);
check(
  '跳过 ≠ 通过：没设备 / 没贴卡 → exit 2，只有三项都真验到才 exit 0',
  /exit 2/.test(devScript) && /exit 0/.test(devScript) && /跳过不等于通过/.test(devScript),
);
check(
  '贴卡那一步是**跳过**而不是失败（脚本替不了人贴卡，硬判失败只会逼人忽略它）',
  /Check-Skip '贴卡能读到'/.test(devScript),
);
check(
  '没 adb / 没设备时立刻收工，不构建、不安装（否则会白跑几分钟 Gradle）',
  /\$devices\.Count -eq 0[\s\S]{0,600}?exit 2/.test(devScript),
);
const checkChain = grab(pkgJson, /"check":\s*"([^"]+)"/) ?? '';
check(
  'package.json 有 smoke:nfc-device，且**不在** pnpm check 链里（没有手机的人不该天天红）',
  /"smoke:nfc-device"/.test(pkgJson) && checkChain !== '' && !checkChain.includes('smoke:nfc-device'),
);
check(
  '脚本里写清了"验证通过才翻 NFC_READ_VERIFIED"，以及要带机型/系统/卡型',
  /NFC_READ_VERIFIED/.test(devScript) && /机型/.test(devScript),
);
/*
 * **UTF-8 BOM 是硬要求**：`pnpm smoke:nfc-device` 走 `powershell -File`（Windows PowerShell 5.1），
 * 它按**当前 ANSI 代码页**读取没有 BOM 的 .ps1 —— 中文被当成 GBK 之后字节会串位，
 * 连字符串的收尾引号都可能被吞掉，报出来的是"某一行少个引号"这种与真因毫不相干的错。
 * 这条断言就是这么发现的（先写文件、后补 BOM，一次 edit 又把 BOM 弄掉了）。
 */
const devScriptBytes = readFileSync(path.join(ROOT, 'scripts/nfc-device-check.ps1'));
check(
  '走查脚本带 UTF-8 BOM（否则 powershell 5.1 按 ANSI 读，中文串位后连解析都过不去）',
  devScriptBytes[0] === 0xef && devScriptBytes[1] === 0xbb && devScriptBytes[2] === 0xbf,
  `前三个字节 ${[...devScriptBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`,
);

const total = pass + fail;
if (fail > 0) {
  console.error(`check-nfc FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-nfc OK: ${total} 项（契约串逐字一致 / 本机方法表 / 先实现后声明 / 生命周期 / 去抖 / Web 四态 / 单测真跑）`);
