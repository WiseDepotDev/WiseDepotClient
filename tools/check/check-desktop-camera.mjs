#!/usr/bin/env node
/*
 * check-desktop-camera.mjs —— 桌面相机权限与能力声明的门禁（B1/S2c）。
 *
 * 这一片的所有东西都是**"写了但没生效"型**的失败：
 *   · 权限处理器没装 / 装晚了 → `getUserMedia` 静默失败，点扫码没反应；
 *   · 处理器放行得太宽（任何 permission、任何 origin）→ 本地应用变成
 *     任何被注入脚本都能开摄像头的东西；
 *   · 能力位里拼错一个字母 → 界面上入口永远不出现（而没有任何报错）；
 *   · 手机侧跟着桌面一起声明 → 画出点了没反应的入口（这正是 `MainActivity.kt:203`
 *     当初撤销它的原因）。
 *
 * 它们都不会构建失败，所以在这里静态钉住；**真机那一步**由 `pnpm desktop:smoke`
 * 真开一次流来验（本文件只管"代码结构与判据"）。
 */
import { readFileSync } from 'node:fs';
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
const mainTs = read('apps/desktop/src/main.ts');
const bridgeProcessTs = read('apps/desktop/src/bridgeProcess.ts');
const typesTs = read('packages/bridge-client/src/types.ts');
const panelVue = read('packages/layouts/src/CameraScanPanel.vue');
const mainActivityKt = read('apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/MainActivity.kt');
const hostMainKt = read('bridge/host-desktop/src/main/kotlin/com/huicang/wise/bridge/host/desktop/Main.kt');

console.log('--- 1. 权限处理器：必须装、只放行 media、只认本应用 origin ---');
check('装的是 setPermissionRequestHandler（getUserMedia 的那条路）', /setPermissionRequestHandler\(/.test(mainTs));
check('放行判据里有 permission === \'media\'（不是一律放行）', /permission === 'media'/.test(mainTs));
check(
  '两条处理器都要求本应用 origin（请求那条拿完整 URL、同步检查那条拿 origin）',
  /isOurOrigin\(asking\)/.test(mainTs) && /isOurOrigin\(requestingOrigin\)/.test(mainTs),
);
/*
 * **回归护栏（这一条来自 S2c 第一次跑自检就踩到的真 bug）**：
 * 原先用 `new URL(url).origin` 判 origin，而 `app:` 不是 URL 标准里的 special scheme，
 * 主进程（Node 的 URL 实现）会给它返回**字符串 `'null'`** → 相机永远打不开，
 * 而表现又是"点了没反应"。所以这里钉住：判据必须是那种不可能返回 'null' 的写法。
 */
check(
  'origin 判据不再走 `originOf(...)`（那个写法在 app:// 上会得到字符串 "null"）',
  !/\boriginOf\(/.test(mainTs),
);
check(
  '并把这条坑写进了注释（否则下一个人还会这么写）',
  /不是 URL 标准里的 special scheme/.test(mainTs) && /'null'/.test(mainTs),
);
check(
  '同步检查处理器也在（permissions.query 与开流前预检）',
  /setPermissionCheckHandler\(/.test(mainTs),
);
check(
  '同步检查与请求的判据同源（同一个 isOurOrigin，不会一个放行一个拒绝）',
  (mainTs.match(/isOurOrigin\(/g) ?? []).length >= 3,
  `isOurOrigin 出现 ${(mainTs.match(/isOurOrigin\(/g) ?? []).length} 次（定义 + 两处使用）`,
);
check(
  '记录决定：进流水账 + 打一行 [perm] 日志（排障要分清"我们拒了"还是"系统拒了"）',
  /permissionLog\.push\(/.test(mainTs) && /console\.log\(`\[perm\]/.test(mainTs),
);
check(
  '权限处理器在**建窗之前**装好（窗口一出来页面就可能请求）',
  (() => {
    const handler = mainTs.indexOf('registerPermissionHandlers();');
    const window = mainTs.indexOf('await createWindow();');
    return handler > 0 && window > 0 && handler < window;
  })(),
);
check('只放行 media 的注释写清了理由（不是靠读者猜）', /只放行 `media`/.test(mainTs));

console.log('--- 2. 能力声明：桌面声明、手机不声明、字符串不能拼错 ---');
/*
 * 允许 flag 与取值之间夹注释：那是合法 TS，而且**声明串常常需要一段"为什么现在才加"的解释**
 * （`scan.camera`、`notify.system` 都是这么加进来的）。门禁为它变红就是假红，
 * 而假红的下场是下一个人把解释删掉 —— 正好丢掉我们最想留的那句话。
 * 所以先去掉注释再要求"紧邻"。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const declared = /'--capabilities',\s*'([^']+)'/.exec(stripComments(bridgeProcessTs))?.[1] ?? '';
if (declared === '') {
  console.log('  ✗ 找不到 --capabilities 那一行 —— 门禁自己要能定位，不能静默通过');
  fail += 1;
} else {
  console.log(`  · 桌面声明：${declared}`);
}
const caps = declared === '' ? [] : declared.split(',').map((s) => s.trim()).filter((s) => s !== '');
check('桌面声明了 scan.camera（取景 + 识别已经落地并有门禁）', caps.includes('scan.camera'));
check('桌面声明了 scan.camera.select', caps.includes('scan.camera.select'));
check('每个声明的字符串都在 TS 的 Capability 常量里（拼错一个字母 = 入口永远不出现且没有报错）', caps.every((c) => typesTs.includes(`'${c}'`)), caps.filter((c) => !typesTs.includes(`'${c}'`)).join(', '));
check(
  '手机侧仍**主动撤销** scan.camera（不许为了让界面好看而提前声明）',
  /revokeCapability\(\s*BridgeCapabilities\.SCAN_CAMERA\s*,[^)]+\)/.test(mainActivityKt),
);
check(
  '桌面 Kotlin 宿主不自己猜相机能力（能力只从宿主参数来）',
  !/SCAN_CAMERA/.test(hostMainKt),
);
check(
  '单摄像头机器不画选择器（"有没有得选"只有渲染进程看得到）',
  /cameras\.length > 1/.test(panelVue),
);

console.log('--- 3. 真机那一步：自检里必须真开流，且"没设备"是跳过不是通过 ---');
check('自检真的调用了 getUserMedia', /navigator\.mediaDevices\.getUserMedia\(/.test(mainTs));
// `MediaStreamTrack.readyState` 只有 `live` / `ended`；写成 `running` 是记错了规范
check('断言 track 到过 live（真的取到画面）', /camera\.readyState === 'live'/.test(mainTs));
check(
  '注入的探针 URL 是绝对的（`import()` 在注入脚本里没有基准 URL）',
  /\$\{ORIGIN\}\/\$\{zxingChunk\}/.test(mainTs) && /\$\{ORIGIN\}\/\$\{zxingWasm\}/.test(mainTs),
);
check('断言停流后 track === ended（关层/失焦/切页三条路的终点）', /camera\.afterStop === 'ended'/.test(mainTs));
check(
  '断言权限处理器**真的被调用过**（不是"代码写了就算"）',
  /permissionLog\.some\(/.test(mainTs),
);
check(
  '没有摄像头 → 明确"跳过"，不计入通过（否则自检在没验过的机器上永远是绿的）',
  /const skipped: string\[\]/.test(mainTs) && /跳过：/.test(mainTs) && /no-device/.test(mainTs),
);
check(
  '摄像头被占用也算"跳过"并说明原因（环境冲突不该把自检染红）',
  /NotReadableError/.test(mainTs) && /被其它程序占用/.test(mainTs),
);
check('ZXing wasm 随包发出是一条断言（离线现场不能靠 CDN）', /findZxingWasm\(/.test(mainTs) && /zxing\.status === 200/.test(mainTs));
check(
  '回退模块的**可加载性与导出形状**也是一条断言（真机解码前的最后一环）',
  /findZxingReaderChunk\(/.test(mainTs) && /zxingApi\.readBarcodes === true/.test(mainTs) && /zxingApi\.prepare === true/.test(mainTs),
);

const total = pass + fail;
if (fail > 0) {
  console.error(`check-desktop-camera FAIL：${fail}/${total} 项未通过`);
  process.exit(1);
}
console.log(`check-desktop-camera OK: ${total} 项（权限判据 / 能力声明与拼写 / 手机不声明 / 真机自检的跳过口径）`);
