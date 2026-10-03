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
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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
const appFrameVue = read('packages/layouts/src/AppFrame.vue');

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
check('入口判据是能力位 nfc.read（不是平台字符串）', /supports\('nfc\.read'\)/.test(nfcVue));
check(
  '没有能力 / unsupported → 一个像素都不画',
  /v-if="canRead && phase !== 'unsupported'"/.test(nfcVue),
);
check('「NFC 未开启」与「请将标签靠近手机背部」是两句不同的话（出路不同）', /NFC 未开启/.test(nfcVue) && /请将标签靠近手机背部/.test(nfcVue));
check('「去开启」真的调本机方法（用常量，不写字面量）', /bridge\.call<\{ opened\?: boolean \}>\(LocalMethod\.NFC_OPEN_SETTINGS\)/.test(nfcVue));
check('打不开系统设置时如实改口（不假装成功）', /openFailed\.value\s*=\s*result\?\.opened !== true/.test(nfcVue));
check(
  '订阅用的是 TS 侧的事件常量（与壳的 topic 同源）',
  /bridge\.subscribe\(BRIDGE_EVENT_NFC_STATE/.test(nfcVue) && /bridge\.subscribe\(BRIDGE_EVENT_NFC_TAG/.test(nfcVue),
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

const total = pass + fail;
if (fail > 0) {
  console.error(`check-nfc FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-nfc OK: ${total} 项（契约串逐字一致 / 本机方法表 / 先实现后声明 / 生命周期 / 去抖 / Web 四态 / 单测真跑）`);
