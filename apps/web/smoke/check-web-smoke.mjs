/**
 * Web 冒烟（开发态 mock 桥）：启动 → 登录屏 → 真登录 → 进主框架。
 *
 * 为什么值得有这条：V1 的验收标准是"两端能起来并真登录"，而真实宿主
 * （Electron / Android 壳）在本机跑一次很贵。开发态 mock 桥能在**几秒内**
 * 把同一条链路（`_bridge.json` 缺席 → mock → `captcha.generate` → `auth.login` →
 * `bridge.session` 判定 → 路由守卫 → 主框架）验完，且不依赖任何真机。
 *
 * 它**不能**替代真宿主验证：mock 不覆盖 `__bridge.json`、WS 握手、令牌截留。
 * 那些在 V5（宿主接线）用 `pnpm desktop:smoke` 与真机走查覆盖。
 *
 * 跑法：node apps/web/smoke/check-web-smoke.mjs
 */
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep } from './lib/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const PORT = 5180;

const checks = [];
const check = (name, ok, extra = '') => {
  checks.push({ name, ok, extra });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`);
};

/**
 * 兜底：确认还在登录态。
 *
 * 为什么需要它：开发态里 Vite 可能在会话中途**整页 reload**（新依赖被预打包、或文件被改），
 * 内存里的会话随之丢掉，后面所有断言都会停在 `#/login` 上，看起来像"功能全坏了"。
 * 与其让测试给出误导性的红，不如在这里补一次登录并**显式记一条** ——
 * 如果这条经常触发，说明有别的 reload 源要查（`optimizeDeps.include` 已经堵掉了最常见的那种）。
 *
 * 定义放在文件靠前处：后面每个阶段开头都会调用它，而 `const` 有 TDZ。
 */
const ensureSignedIn = async () => {
  const hash = await cdp.evaluate('location.hash', { awaitPromise: false });
  if (hash !== '#/login') {
    return;
  }
  const inputs = await cdp.evaluate(
    `(() => {
       const root = document.querySelector('.w-login');
       if (!root) return 0;
       const els = [...root.querySelectorAll('input')];
       const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(els[0]), 'value').set;
       ['admin', 'admin123', '8+5'].forEach((v, i) => {
         if (!els[i]) return;
         setter.call(els[i], v);
         els[i].dispatchEvent(new Event('input', { bubbles: true }));
       });
       return els.length;
     })()`,
    { awaitPromise: false },
  );
  if (inputs >= 3) {
    await sleep(300);
    await cdp.evaluate(
      `(() => {
         const btn = [...document.querySelectorAll('.w-login button')].find((b) => b.innerText.trim().startsWith('登录'));
         btn?.click();
         return true;
       })()`,
      { awaitPromise: false },
    );
    await waitFor(`document.querySelector('.w-page') ? true : null`, 20_000, 300);
    check('会话中途丢失后能重新登录（开发态整页 reload 兜底）', true);
  }
};

const rowsNow = () =>
  cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, { awaitPromise: false });

/**
 * 等到列表真的渲染出 n 行再断言。
 *
 * 为什么不能直接数：`waitFor(title)` 只保证**页头**画出来了，数据还在路上
 * （懒加载 chunk + mock 的 ~120ms 模拟往返）。直接数会拿到 0，
 * 而界面上其实是骨架屏 —— 看起来像"数据没取到"，其实是测试没等。
 *
 * 定义放在文件靠前处：阶段 6 与阶段 8 都要用，而 `const` 有 TDZ。
 */
const waitRows = async (n, timeout = 15_000) => {
  await waitFor(
    `document.querySelectorAll('.el-table__body tbody tr.el-table__row').length === ${n} ? true : null`,
    timeout,
    200,
  );
  return rowsNow();
};

console.log('1/4 启动 vite dev server（mock 桥）…');
const server = await createServer({
  configFile: resolve(webRoot, 'vite.config.ts'),
  root: webRoot,
  logLevel: 'warn',
  // 显式绑 127.0.0.1：只写端口时 vite 可能绑到 ::1，而无头 Chrome 访问 127.0.0.1 会被拒
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
});
await server.listen();
console.log(`    dev server: ${server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${PORT}/`}`);

/*
 * **在浏览器连上之前，让 Vite 把所有屏模块转换完、依赖预打包完。**
 *
 * 为什么必须这么做：Vite 在"第一次遇到某个依赖"时才做预打包，并在完成后**整页 reload**。
 * 本仓路由是懒加载的，于是冷启动（清过 `node_modules/.vite`）时这个过程会被推到**断言跑到一半**：
 * 页面自己刷新 → 内存里的 mock 会话丢掉 → 后面所有断言都停在 `#/login`。
 *
 * 之前靠"用 hash 把每条路由走一遍"来预热，冷缓存下**压不住**：29 条路由 + 一堆 Element Plus 组件，
 * 350ms 的间隔走一趟走不完，补优化仍会在后面触发（实测：冷启动时 5/6 阶段之后连片失败）。
 * `server.warmupRequest()` 是 Vite 给这件事准备的正式入口：按 URL 预转换模块（含依赖扫描），
 * 不经过浏览器、不产生 reload。
 */
{
  const { readdirSync } = await import('node:fs');
  const viewsDir = resolve(webRoot, 'src', 'views');
  const modules = ['/src/main.ts', '/src/App.vue'];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}/${entry.name}`);
      } else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) {
        modules.push(`/src/views${prefix}/${entry.name}`);
      }
    }
  };
  walk(viewsDir, '');
  try {
    // `warmupRequest` 收的是**单个 url**（传数组会在内部炸 `url.replace is not a function`）
    for (const url of modules) {
      await server.warmupRequest(url);
    }
    console.log(`    已预热 ${modules.length} 个模块（避免跑到一半因依赖预打包整页 reload）`);
  } catch (e) {
    // 预热失败不该让整轮冒烟挂掉：后面还有逐条走路由的兜底预热
    console.log(`    ⚠ 模块预热失败（继续跑，可能首次会慢一些）：${e?.message ?? e}`);
  }
}

console.log('2/4 启动无头 Chrome 并连 CDP…');
const chrome = await launchChrome({ port: 9334 });
const cdp = await Cdp.connect(chrome.wsUrl);
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '未知');
});

const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
cdp.sessionId = sessionId;
await cdp.send('Runtime.enable');

const waitFor = async (expression, timeoutMs = 90_000, stepMs = 400) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression, { awaitPromise: false });
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
};

console.log('3/4 等登录屏渲染（首跑要等 vite 预打包 naive-ui）…');
const loginReady = await waitFor(
  `(() => {
     const root = document.querySelector('.w-login');
     if (!root) return null;
     const inputs = root.querySelectorAll('input');
     return { inputs: inputs.length, hasCaptcha: !!root.querySelector('.w-login__captcha-img'), text: root.innerText.slice(0, 200) };
   })()`,
);

console.log('\n=== Web 冒烟结果 ===');
if (!loginReady) {
  check('登录屏渲染', false, '超时');
  // 超时时把真实 DOM 打出来 —— 否则只会看到"没渲染"，看不出是启动屏、失败屏还是别的
  const dump = await cdp.evaluate(
    `({ hash: location.hash, text: document.body.innerText.slice(0, 400), html: document.body.innerHTML.slice(0, 600) })`,
    { awaitPromise: false },
  );
  console.log('  --- 超时现场 ---');
  console.log(`  hash: ${dump?.hash}`);
  console.log(`  text: ${String(dump?.text).replace(/\s+/g, ' ')}`);
  console.log(`  html: ${String(dump?.html).replace(/\s+/g, ' ')}`);
} else {
  check('登录屏渲染', true);
  check('账号/密码/验证码输入框存在（≥3）', loginReady.inputs >= 3, `inputs=${loginReady.inputs}`);
  check('验证码图片位存在', loginReady.hasCaptcha === true);
  check('文案为业务语言且无桥方法 id', !/\.(list|detail|create)\b/.test(loginReady.text));

  const bannerText = await cdp.evaluate(`(document.querySelector('.w-app__banner')?.innerText ?? '')`, { awaitPromise: false });
  check('开发态假桥横幅可见（mock 必须显式标注）', /假桥/.test(bannerText), bannerText);

  // 填表：Vue 的 v-model 监听 input 事件，直接改 value 不触发更新
  await cdp.evaluate(
    `(() => {
       const root = document.querySelector('.w-login');
       const inputs = [...root.querySelectorAll('input')];
       const setValue = (el, value) => {
         const proto = Object.getPrototypeOf(el);
         const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
         setter.call(el, value);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       setValue(inputs[0], 'admin');
       setValue(inputs[1], 'admin123');
       setValue(inputs[2], '8+5');
       return true;
     })()`,
    { awaitPromise: false },
  );
  await sleep(300);

  const clicked = await cdp.evaluate(
    `(() => {
       const btn = [...document.querySelectorAll('.w-login button')].find((b) => b.innerText.trim().startsWith('登录'));
       if (!btn || btn.disabled) return false;
       btn.click();
       return true;
     })()`,
    { awaitPromise: false },
  );
  check('登录按钮可点击（校验通过后不再禁用）', clicked === true);

  const home = await waitFor(`document.querySelector('.w-home') ? document.querySelector('.w-home').innerText.slice(0, 600) : null`, 20_000);
  check('登录后进入主框架（应用中心）', home !== null);
  if (home) {
    /*
     * 账号名：判据是"**首页与侧栏是同一个**"，不是写死某个字符串。
     *
     * 原先两处各算一份（侧栏读 `user.current`、首页只看 `session.username`），于是冷启动恢复
     * 登录态之后会出现"侧栏写着系统管理员、首页写着已登录" —— 同一个人两个说法。
     * 写死字符串只会把某一处的实现固化下来，"两处一致"才是要守的性质。
     */
    const homeAccount = await cdp.evaluate(
      `document.querySelector('.w-home__account')?.innerText.trim().replace(/\\s+/g, ' ') ?? ''`,
      { awaitPromise: false },
    );
    const sidebarName = await cdp.evaluate(
      `document.querySelector('.w-sidebar__account-name')?.innerText.trim() ?? ''`,
      { awaitPromise: false },
    );
    check(
      '首页账号行写出当前账号（退化成一句"已登录"就是丢了名字）',
      /^当前账号：.+/.test(homeAccount) && !/当前账号：已登录/.test(homeAccount),
      homeAccount.slice(0, 60),
    );
    check(
      '首页与侧栏的账号名来自同一个出处',
      sidebarName !== '' && homeAccount.includes(sidebarName),
      `home="${homeAccount.slice(0, 40)}" sidebar="${sidebarName}"`,
    );
    check(
      '应用中心按域分组（运营/库存/现场/管理）',
      ['运营', '库存', '现场', '管理'].every((d) => home.includes(d)),
      home.replace(/\s+/g, ' ').slice(0, 60),
    );
    check('首页不再是"上线中"占位（29 屏全迁完之后那句话已过期）', !/功能上线中/.test(home), home.replace(/\s+/g, ' ').slice(0, 60));
  }

  const hubEntries = await cdp.evaluate(`document.querySelectorAll('.w-home__entry').length`, { awaitPromise: false });
  // 17 = 当前导航叶子数（运营 2 / 库存 6 / 现场 5 / 管理 3 + 巡检计划与其它；加叶子时这条要跟着改）
  check('功能入口数量 = 导航叶子数（一级功能 17 个）', hubEntries === 17, `entries=${hubEntries}`);
  const hubFirst = await cdp.evaluate(`document.querySelector('.w-home__entry')?.innerText.trim() ?? ''`, {
    awaitPromise: false,
  });
  check('每个入口写着"进去能干什么"（不是只有标题）', hubFirst.split('\n').length >= 2, hubFirst.replace(/\n/g, ' / ').slice(0, 60));

  /*
   * 图标：**真的画出 SVG 了**才计数。
   *
   * 只断言"入口数量对"是拦不住图标写错的 —— 图标名拼错时那一格只是空着，
   * 数量、文案、点击全都没问题（而缺省退回 `Grid` 更让"少一个图标"看不出来）。
   */
  const hubIcons = await cdp.evaluate(
    `(() => {
       const entries = [...document.querySelectorAll('.w-home__entry')];
       return {
         total: entries.length,
         withIcon: entries.filter((e) => e.querySelector('.w-home__entry-icon svg')).length,
       };
     })()`,
    { awaitPromise: false },
  );
  check(
    '每个入口都画出了图标（不是只有名字）',
    hubIcons.total === 17 && hubIcons.withIcon === hubIcons.total,
    `withIcon=${hubIcons.withIcon}/${hubIcons.total}`,
  );

  /*
   * 应用中心是**唯一入口**：点不开就等于功能被藏起来了。
   * 所以这条要真点一次，确认路由与子页面标题都变了。
   */
  await cdp.evaluate(`document.querySelector('.w-home__entry')?.click()`, { awaitPromise: false });
  await sleep(900);
  const afterEntryClick = await cdp.evaluate(
    `({ hash: location.hash, title: document.querySelector('.w-page-header__title')?.innerText ?? '' })`,
    { awaitPromise: false },
  );
  check(
    '点入口真的进得了子页面',
    /^#\/(overview|inventory|field|me)\//.test(afterEntryClick.hash) && afterEntryClick.title !== '',
    `${afterEntryClick.hash} / ${afterEntryClick.title}`,
  );

  const url = await cdp.evaluate('location.hash', { awaitPromise: false });
  check('使用 hash 路由（宿主相对路径兼容）', typeof url === 'string' && url.startsWith('#/'), url);
}

/*
 * 第二阶段：组件预览页。
 *
 * 为什么冒烟要覆盖它：设计系统"写完了"和"渲染出来是对的"是两件事。
 * 这一页把四态、响应式数据视图、危险确认都摆在一起，只要它整页能渲染且交互有效，
 * 就说明 @wise/ui 的组件在真实浏览器里可用 —— 比单测更接近实际。
 */
console.log('\n4/4 组件预览页（设计系统冒烟）…');
await cdp.evaluate(`(location.hash = '#/preview')`, { awaitPromise: false });
/*
 * 等待条件必须是**预览页独有的东西**，不能是 `.w-page`。
 *
 * 踩过：`.w-page` 上一屏也有，而 `<RouterView :key>` 换屏的瞬间旧屏还在 DOM 里 ——
 * `waitFor('.w-page')` 会立刻命中旧屏，后面的断言跑在"旧屏 + 新屏加载中"的混合状态上，
 * 表现为表格只数到 2 行、错误码还没出现（实测就是这么红的，而且换一处无关改动就会波动）。
 */
const previewReady = await waitFor(`document.querySelectorAll('.w-metric').length === 4 ? true : null`, 30_000);

if (!previewReady) {
  check('预览页渲染', false, '超时');
} else {
  check('预览页渲染', true);

  const metrics = await cdp.evaluate(`document.querySelectorAll('.w-metric').length`, { awaitPromise: false });
  check('指标区渲染 4 张真实 KPI 卡', metrics === 4, `metrics=${metrics}`);

  // ElTable 的行不是同步落地的（要知道列宽才排版），所以断言前显式等一次
  await waitFor(
    `document.querySelectorAll('.w-datatable .el-table__body tbody tr.el-table__row').length === 4 ? true : null`,
    15_000,
    200,
  );
  const tableRows = await cdp.evaluate(
    `document.querySelectorAll('.w-datatable .el-table__body tbody tr.el-table__row').length`,
    { awaitPromise: false },
  );
  check('响应式数据视图 · 桌面出表格（4 行）', tableRows === 4, `rows=${tableRows}`);

  const cellsMono = await cdp.evaluate(`document.querySelectorAll('.w-datatable .w-mono').length`, { awaitPromise: false });
  check('机器数据走等宽（单号/库位/时间）', cellsMono > 0, `mono=${cellsMono}`);

  await waitFor(
    `document.querySelector('.w-error__code')?.innerText === 'BRIDGE_BACKEND_UNREACHABLE' ? true : null`,
    15_000,
    200,
  );
  const errorCode = await cdp.evaluate(
    `document.querySelector('.w-error__code')?.innerText ?? ''`,
    { awaitPromise: false },
  );
  check('错误态露出等宽错误码', errorCode === 'BRIDGE_BACKEND_UNREACHABLE', errorCode);

  const emptyText = await cdp.evaluate(`document.querySelector('.w-empty')?.innerText ?? ''`, { awaitPromise: false });
  check('空态给业务文案', /还没有入库记录/.test(emptyText), emptyText);

  // 切到卡片模式：同一份列定义，手机布局
  const switched = await cdp.evaluate(
    `(() => {
       const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '卡片');
       if (!btn) return false;
       btn.click();
       return true;
     })()`,
    { awaitPromise: false },
  );
  await sleep(300);
  const cards = await cdp.evaluate(`document.querySelectorAll('.w-cardlist .w-card').length`, { awaitPromise: false });
  check('切到卡片模式渲染 4 张卡片', switched === true && cards === 4, `cards=${cards}`);

  const chips = await cdp.evaluate(`document.querySelectorAll('.w-card .w-chip').length`, { awaitPromise: false });
  check('卡片带状态芯片（同一份列定义的 chip 槽位）', chips === 4, `chips=${chips}`);

  // 危险操作确认：打开 → 取消 → 关闭
  await cdp.evaluate(
    `(() => {
       const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('删除标签'));
       btn?.click();
       return true;
     })()`,
    { awaitPromise: false },
  );
  await sleep(400);
  const dialogTitle = await cdp.evaluate(`document.querySelector('.el-dialog__title')?.innerText ?? ''`, { awaitPromise: false });
  check('危险操作弹出二次确认', /确认删除/.test(dialogTitle), dialogTitle);

  await cdp.evaluate(
    `(() => {
       const btns = [...document.querySelectorAll('.el-dialog button')];
       const cancel = btns.find((b) => b.innerText.trim() === '取消');
       cancel?.click();
       return true;
     })()`,
    { awaitPromise: false },
  );
  await sleep(400);
  /*
   * Element Plus 的对话框关闭后**节点仍在 DOM 里**（用 `v-show` 藏遮罩层），
   * 所以判据不能是"节点消失"，而要看它是否可见。
   */
  const dialogGone = await cdp.evaluate(
    `(() => {
       const title = document.querySelector('.el-dialog__title');
       if (!title) return true;
       const overlay = title.closest('.el-overlay');
       if (!overlay) return true;
       return getComputedStyle(overlay).display === 'none';
     })()`,
    { awaitPromise: false },
  );
  check('取消后确认框关闭', dialogGone === true);
}

/*
 * 第三阶段：双端外壳与导航。
 *
 * 这一段的价值在于**只有真浏览器能验**的三件事：
 *  1. 路由匹配顺序（静态段必须排在参数段之前）—— 顺序错了用户点到的是详情而不是"新建"；
 *  2. 断点切换换的是壳、**不重建当前屏**（URL 与屏状态都还在）；
 *  3. 扫码三分支在真实事件流下走通（监听器不吞按键、兜底跳转正确）。
 */
console.log('\n5/6 双端外壳与导航…');

/*
 * 预热：把所有懒加载路由各走一遍。
 *
 * 为什么必须做：开发态下 Vite 会在**第一次遇到新依赖时**做依赖预打包并整页 reload，
 * 而路由是懒加载的 —— 于是"跑到一半页面自己刷新、会话丢了"。
 * 先走一遍把所有 chunk 与依赖都摸出来，后面就不会再被 reload 打断。
 * （`optimizeDeps.include` 只能覆盖已知的顶层依赖，覆盖不了按需 import 出来的子树。）
 *
 * **顺序很关键：必须先登录再预热。** 这段原先跑在 `ensureSignedIn()` **之前**，
 * 而没登录时每一次 `location.hash` 都会被会话闸门挡回 `#/login` —— 一个路由 chunk 都没加载，
 * 于是"预热"什么都没预热到：依赖要到后面某个阶段才被发现 → Vite 补优化 → 整页 reload → 会话丢，
 * 从那一阶段开始后面全红（实测：5/6 阶段中途掉回 `#/login`，后半段 34 条断言连片失败）。
 * 顺带把末尾那次 `location.reload()` 去掉：它的目的是"拿干净状态"，代价却是把会话再丢一次，
 * 而现在预热发生在登录之后，没必要付这个代价。
 */
await ensureSignedIn();
{
  const WARMUP = [
    '#/',
    '#/overview/dashboard',
    '#/overview/alerts',
    '#/inventory/inventory',
    '#/inventory/inventory/101',
    '#/inventory/products',
    '#/inventory/warehouses',
    '#/inventory/tags',
    '#/inventory/tags/code/TAG-0001',
    '#/inventory/stock-orders',
    '#/inventory/stock-orders/new',
    '#/inventory/stock-orders/8001',
    '#/field/devices',
    '#/field/inspection-plans',
    '#/field/inspections',
    '#/field/inspections/new',
    '#/field/inspections/results',
    '#/field/inspections/results/new',
    '#/field/inspections/manual',
    '#/field/inspections/501',
    '#/me/messages',
    '#/me/messages/MSG-20260106-004',
    '#/me/users',
    '#/me/users/1',
    '#/me/profile',
  ];
  for (const hash of WARMUP) {
    await cdp.evaluate(`(location.hash = '${hash}')`, { awaitPromise: false });
    await sleep(350);
  }
}
await cdp.evaluate(`(location.hash = '#/')`, { awaitPromise: false });
await sleep(600);

/*
 * 给假桥装一个"记录调用"的壳（幂等，后面各段都能用）。
 *
 * 为什么值得留着：有些缺陷**不报错也不转圈** —— 例如 `enabled` 被写成当场求值的常量，
 * 资源就永远不发请求，界面只稳定显示一句空态文案，看起来像"后端没数据"。
 * 有了这份调用记录，"该发的请求到底发没发"就能被断言抓住，而不是靠人盯界面。
 */
await cdp.evaluate(
  `(() => {
     const m = window.__bridgeMock;
     if (!m.__wrapped) {
       const orig = m.call.bind(m);
       m.__calls = [];
       m.call = (method, params) => {
         m.__calls.push(method + ':' + JSON.stringify(params ?? null));
         return orig(method, params);
       };
       m.__wrapped = true;
     }
     return true;
   })()`,
  { awaitPromise: false },
);
/** 清空调用记录（每段断言前先清，避免上一段的调用混进来）。 */
const clearCalls = () => cdp.evaluate(`(window.__bridgeMock.__calls.length = 0, true)`, { awaitPromise: false });
/** 读某一前缀的调用记录（用前先 `clearCalls()`）。返回 ` | ` 连接的纯文本 —— 不用 JSON.stringify：
 *  它会把内层引号转义成 `\"`，断言里就得跟着写转义，既难读又容易假红（踩过一次）。 */
const callsWithPrefix = (prefix) =>
  cdp.evaluate(
    `(window.__bridgeMock?.__calls ?? []).filter((c) => c.startsWith(${JSON.stringify(prefix)})).join(' | ')`,
    { awaitPromise: false },
  );

const desktop = await cdp.evaluate(
  `({
     commandbar: !!document.querySelector('.w-commandbar'),
     sidebar: !!document.querySelector('.w-sidebar'),
     statusbar: !!document.querySelector('.w-statusbar'),
     tabbar: !!document.querySelector('.w-tabbar'),
     groups: [...document.querySelectorAll('.w-sidebar .el-sub-menu__title')].map((n) => n.innerText.trim()).join('/'),
   })`,
  { awaitPromise: false },
);
check('桌面壳：CommandBar / Sidebar / StatusBar 都在', desktop.commandbar && desktop.sidebar && desktop.statusbar);
check('桌面壳：不出现手机底栏', desktop.tabbar === false);
check('侧栏分组取自真实域（运营/库存/现场/管理）', desktop.groups === '运营/库存/现场/管理', desktop.groups);

/** 走一个 hash 并等占位屏标题出现。 */
const gotoAndTitle = async (hash, timeout = 20_000) => {
  await cdp.evaluate(`(location.hash = '${hash}')`, { awaitPromise: false });
  // 真屏与占位屏的标题在不同的类上：迁入后这条断言不该失效
  await waitFor(`document.querySelector('.w-page-header__title, .w-placeholder__title') ? true : null`, timeout, 200);
  return cdp.evaluate(
    `(document.querySelector('.w-page-header__title') ?? document.querySelector('.w-placeholder__title'))?.innerText.trim() ?? ''`,
    { awaitPromise: false },
  );
};

// 路由匹配顺序：/new 是叶子，必须赢过 /:orderId
const newTitle = await gotoAndTitle('#/inventory/stock-orders/new');
check('静态段优先：/stock-orders/new 打开"新建出入库单"', newTitle === '新建出入库单', newTitle);

const detailTitle = await gotoAndTitle('#/inventory/stock-orders/12345');
check('参数段仍可达：/stock-orders/12345 打开"单据详情"（真屏已迁入，标题来自单据）', detailTitle.length > 0, detailTitle);

await cdp.evaluate(`(location.hash = '#/inventory/inventory')`, { awaitPromise: false });
await sleep(500);

// 断点切换：390px 宽的手机档
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await sleep(700);
const mobile = await cdp.evaluate(
  `({
     hash: location.hash,
     tabbar: !!document.querySelector('.w-tabbar'),
     tabItems: document.querySelectorAll('.w-tabbar__item').length,
     sidebar: !!document.querySelector('.w-sidebar'),
     contextheader: !!document.querySelector('.w-contextheader'),
     drawerButton: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '页面'),
   })`,
  { awaitPromise: false },
);
check('手机壳：底栏出现、侧栏消失、情景头在', mobile.tabbar && !mobile.sidebar && mobile.contextheader);
check('手机底栏 4 项', mobile.tabItems === 4, `items=${mobile.tabItems}`);
check('断点切换不丢当前路由', mobile.hash === '#/inventory/inventory', mobile.hash);
check('叶子 >4 的域改用抽屉入口（不做横向滚动）', mobile.drawerButton === true);

// 扫码三分支之③兜底：模拟扫码枪快速连打 + Enter
await cdp.evaluate(`(document.activeElement instanceof HTMLElement && document.activeElement.blur())`, {
  awaitPromise: false,
});
const scanned = await cdp.evaluate(
  `(() => {
     const code = 'ABCD1234';
     for (const ch of code) {
       window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
     }
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(800);
const scanResult = await cdp.evaluate(
  `({ hash: location.hash, card: !!document.querySelector('.w-scancard'), cardText: document.querySelector('.w-scancard__code')?.innerText ?? '' })`,
  { awaitPromise: false },
);
check(
  '扫码兜底分支：跳到标签详情并按编码寻址',
  scanned === true && scanResult.hash === '#/inventory/tags/code/ABCD1234',
  scanResult.hash,
);
check('扫码结果卡可见且显示真实编码', scanResult.card === true && scanResult.cardText === 'ABCD1234', scanResult.cardText);

await cdp.send('Emulation.clearDeviceMetricsOverride');

/*
 * 第四阶段：概览域（V4 的第一域）—— 真取数 + 真动作。
 *
 * 这一段验的是**只有联起来才能发现**的东西：
 *  · 真实 DTO 的字段名对不对（`inventoryTotal` 之类写错了只会显示 0）；
 *  · `alert.detail` 的"动作按状态决定能不能点"是不是真的通了（mock 会跟着改状态）；
 *  · 动作成功后"失效—重取—按钮变灰并写出原因"这条链有没有断。
 */
console.log('\n6/6 概览域（看板 / 告警中心 / 告警详情）…');
await ensureSignedIn();
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(400);

const text = (sel) => cdp.evaluate(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '')`, { awaitPromise: false });
/**
 * 按文案点按钮。
 *
 * 两条规矩，都是踩出来的：
 *  1. **弹窗里的按钮优先**：确认框的按钮文案（"确认收到"/"忽略"/"删除"）与页面上的
 *     动作按钮**同名**，只按文案找会永远点到页面上那个；
 *  2. **只点可见的**：Element Plus 关闭弹窗后**节点仍留在 DOM 里**（用 `v-show` 藏），
 *     上一阶段遗留的隐藏弹窗会被 `document.querySelector('.el-dialog')` 选中，
 *     于是"点了确定却什么都没发生"。用 `offsetParent === null` 过滤掉不可见的。
 */
const clickByText = (label) =>
  cdp.evaluate(
    `(() => {
       const want = ${JSON.stringify(label)};
       const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
       const pick = (root) => [...root.querySelectorAll('button')].find((x) => x.innerText.trim() === want && visible(x));
       const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find(visible);
       const btn = (dialog ? pick(dialog) : null) ?? pick(document);
       if (!btn || btn.disabled) return false;
       btn.click();
       return true;
     })()`,
    { awaitPromise: false },
  );

// ---- 看板：等 KPI 渲染完再断言 ----
await cdp.evaluate(`(location.hash = '#/overview/dashboard')`, { awaitPromise: false });
const dashReady = await waitFor(`document.querySelector('.w-metric') ? true : null`, 20_000, 200);
check('看板渲染', dashReady === true);

const kpis = await cdp.evaluate(
  `[...document.querySelectorAll('.w-metric')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`,
  { awaitPromise: false },
);
check('看板 4 个 KPI 全部来自真实字段', kpis.length === 4, kpis.join(' | '));
check('KPI 数值非占位 0（DTO 字段名接对了）', kpis.join(' ').includes('1,284') || kpis.join(' ').includes('1284'), kpis[0] ?? '');

const taskText = await cdp.evaluate(
  `[...document.querySelectorAll('.w-kv__value')].map((n) => n.innerText.trim()).join(' | ')`,
  { awaitPromise: false },
);
check('当前任务显示真实任务号与进度', /PT-20260101-01/.test(taskText) && /62%/.test(taskText), taskText);

const dashAlertRows = await cdp.evaluate(
  `document.querySelectorAll('.w-datatable .el-table__body tbody tr.el-table__row').length`,
  { awaitPromise: false },
);
check('未处理告警渲染 2 行', dashAlertRows === 2, `rows=${dashAlertRows}`);

/*
 * 空库态：0 必须自证"是真没有"而不是"界面没接上"。
 *
 * 这不是假设出来的边界，是现场现状：2026-10-01 直连真后端实测
 * `/api/inventories` total=0、`/api/device/statistics` 3 台全离线、
 * `/api/dashboard/summary` 四个 KPI 全 0（当天确实没有新告警）。
 * 假桥平时给的是有数据的那份，所以用 `emptyDashboard` 开关把另一份调出来 ——
 * 真后端没法按需清库。
 */
const setEmptyDashboard = (on) =>
  cdp.evaluate(`window.__bridgeMock?.emptyDashboard(${on === true}) ?? false`, { awaitPromise: false });
const clickRefresh = () =>
  cdp.evaluate(
    `(() => {
       const b = [...document.querySelectorAll('.w-page button')].find((n) => n.innerText.trim() === '刷新');
       if (!b) return false;
       b.click();
       return true;
     })()`,
    { awaitPromise: false },
  );
const dashNotes = () =>
  cdp.evaluate(
    `[...document.querySelectorAll('.w-metric__note')].map((n) => n.innerText.trim()).join(' | ')`,
    { awaitPromise: false },
  );

check('看板页头有刷新按钮（空库态要重取才生效）', (await clickRefresh()) === true);
await setEmptyDashboard(true);
await clickRefresh();
await waitFor(`document.querySelector('.w-metric__value')?.innerText.trim() === '0' ? true : null`, 20_000, 200);

const emptyNotes = await dashNotes();
check('空库：库存总量 0 说明"还没有数据"', /库存表还没有数据/.test(emptyNotes), emptyNotes);
check('空库：今日告警 0 说明"今天没有新告警"', /今天还没有新告警/.test(emptyNotes), emptyNotes);
check('空库：巡检进度 0 说明来由（没有进行中的任务）', /当前没有进行中的任务/.test(emptyNotes), emptyNotes);
check('空库：设备在线 0 说明"没有在线设备"', /当前没有在线设备/.test(emptyNotes), emptyNotes);
check(
  '空库：没有未处理告警时不摆假行',
  (await cdp.evaluate(
    `document.querySelectorAll('.w-datatable .el-table__body tbody tr.el-table__row').length`,
    { awaitPromise: false },
  )) === 0,
);
check('空库：当前任务区给出"没有进行中任务"', /当前没有进行中的巡检任务/.test(await text('.w-overview-muted')), await text('.w-overview-muted'));

// 切回去，别把空库态留给后面的阶段（后续几步还会回到看板做布局断言）
await setEmptyDashboard(false);
await clickRefresh();
await waitFor(`document.querySelector('.w-metric__value')?.innerText.trim() === '1284' ? true : null`, 20_000, 200);
check('切回有数据后不再显示空库提示', !/还没有数据/.test(await dashNotes()), await dashNotes());

// ---- 告警中心 ----
await cdp.evaluate(`(location.hash = '#/overview/alerts')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '告警中心' ? true : null`, 20_000, 200);
await waitRows(3);
const listRows = await cdp.evaluate(
  `document.querySelectorAll('.w-datatable .el-table__body tbody tr.el-table__row').length`,
  { awaitPromise: false },
);
check('告警中心列表 3 行', listRows === 3, `rows=${listRows}`);
check('页头给出真实总数', /共 3 条/.test(await text('.w-page-header__note')), await text('.w-page-header__note'));

const filterLabels = await cdp.evaluate(
  `[...document.querySelectorAll('.w-toolbar .el-select')].map((n) => n.innerText.trim()).join('/')`,
  { awaitPromise: false },
);
check('筛选条渲染（状态筛选，默认全部）', filterLabels.length > 0, filterLabels);

// ---- 告警详情：未处理那条 ----
await cdp.evaluate(
  `(() => { document.querySelector('.w-datatable .el-table__body tbody tr.el-table__row')?.click(); return true; })()`,
  { awaitPromise: false },
);
await waitFor(`location.hash.includes('/overview/alerts/') ? true : null`, 20_000, 200);
const detailHash = await cdp.evaluate(`location.hash`, { awaitPromise: false });
check('点行进详情（路由参数带上序号）', /#\/overview\/alerts\/\d+/.test(detailHash), detailHash);

// 等状态芯片脱离"未上报"再断言：详情数据比页头晚到一步
await waitFor(
  `document.querySelector('.w-page-header .w-chip')?.innerText.trim() !== '状态未上报' ? true : null`,
  15_000,
  200,
);
const stateChip = await text('.w-page-header .w-chip');
check('详情显示真实处理状态', stateChip === '未处理', stateChip);

const ackEnabled = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '确认收到');
     return b ? !b.disabled : null;
   })()`,
  { awaitPromise: false },
);
check('未处理的告警可以「确认收到」', ackEnabled === true);

// 忽略：原因不足 2 个字必须被拦下
await clickByText('忽略');
await sleep(400);
await cdp.evaluate(
  `(() => {
     const ta = document.querySelector('.el-dialog textarea');
     if (!ta) return false;
     const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
     setter.call(ta, 'x');
     ta.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(200);
await clickByText('忽略');
await sleep(400);
const shortReasonError = await text('.w-alert-error');
check(
  '忽略必须写清原因（少于 2 个字被拦下）',
  /至少 2 个字/.test(shortReasonError),
  shortReasonError.slice(0, 40),
);
await clickByText('取消');
await sleep(300);

// 确认收到 → 状态流转到「处理中」
await clickByText('确认收到');
await sleep(400);
check('确认动作弹二次确认', /确认收到这条告警/.test(await text('.el-dialog__title')), await text('.el-dialog__title'));
await clickByText('确认收到');
await waitFor(`document.querySelector('.w-alert-notice') ? true : null`, 20_000, 200);
const notice = await text('.w-alert-notice');
check('动作成功后给出可执行的下一步提示', /处理完记得/.test(notice), notice.slice(0, 40));

await sleep(600);
const afterAck = await text('.w-page-header .w-chip');
check('确认后状态真的变了（失效—重取这条链通了）', afterAck === '处理中', afterAck);

const ackReason = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '确认收到');
     const reason = [...document.querySelectorAll('.w-alert-reason')].map((n) => n.innerText.trim()).join(' | ');
     return { disabled: b ? b.disabled : null, reason };
   })()`,
  { awaitPromise: false },
);
check('不可点的动作按钮变灰', ackReason.disabled === true);
check('不能点的原因写在按钮旁边', /已经确认过了/.test(ackReason.reason), ackReason.reason.slice(0, 40));

const logAfterAck = await text('.w-log__who');
check('处理记录写入真实处理人', /现场操作员/.test(logAfterAck), logAfterAck);

// 处理完成 → 终态
await clickByText('处理完成');
await sleep(400);
await clickByText('处理完成');
await waitFor(`document.querySelector('.w-alert-notice') ? true : null`, 20_000, 200);
await sleep(600);
const finalState = await text('.w-page-header .w-chip');
check('处理完成后进入终态「已处理」', finalState === '已处理', finalState);

const finalActions = await cdp.evaluate(
  `(() => {
     const labels = ['确认收到', '处理完成', '忽略'];
     const states = labels.map((l) => {
       const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === l);
       return b ? b.disabled : null;
     });
     return { states, reasons: document.querySelectorAll('.w-alert-reason').length };
   })()`,
  { awaitPromise: false },
);
check('终态下三个动作都不可点', finalActions.states.every((s) => s === true), JSON.stringify(finalActions.states));
check('并且每个都写出了原因（不摆点了没反应的按钮）', finalActions.reasons === 3, `reasons=${finalActions.reasons}`);

// ---- 已结束的告警（9003）一进门就是终态 ----
await cdp.evaluate(`(location.hash = '#/overview/alerts/9003')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header .w-chip')?.innerText === '已处理' ? true : null`, 20_000, 200);
const closedState = await text('.w-page-header .w-chip');
check('已结束的告警一进门就是不可操作状态', closedState === '已处理', closedState);

/*
 * 第七阶段：本轮用户明确的界面要求 —— 白色简约 / 固定高度 / 右上角搜索 + Bridge 耗时。
 *
 * 这几条都是"看截图才知道"的东西，所以必须由 computed style 与真实布局来断言，
 * 而不是靠"我改了 CSS"。
 */
console.log('\n7/7 白色简约 + 固定高度 + 顶栏右上角…');
await ensureSignedIn();
await cdp.evaluate(`(location.hash = '#/overview/dashboard')`, { awaitPromise: false });
await sleep(800);

const layout = await cdp.evaluate(
  `(() => {
     const sidebar = document.querySelector('.w-sidebar');
     const content = document.querySelector('.w-content');
     const right = document.querySelector('.w-commandbar__right');
     return {
       sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
       sidebarBorder: sidebar ? getComputedStyle(sidebar).borderRightWidth : null,
       contentOverflowY: content ? getComputedStyle(content).overflowY : null,
       hasSearch: !!right?.querySelector('input'),
       searchPlaceholder: right?.querySelector('input')?.getAttribute('placeholder') ?? '',
       chipText: right?.querySelector('.w-chip')?.innerText.trim() ?? '',
     };
   })()`,
  { awaitPromise: false },
);
check('侧栏是白底（不是深绿）', layout.sidebarBg === 'rgb(255, 255, 255)', layout.sidebarBg ?? 'null');
check('侧栏用 1px 描边与内容分层', layout.sidebarBorder === '1px', layout.sidebarBorder ?? 'null');

/*
 * "页面高度固定"用**行为**判定，不用 scrollHeight 判定。
 *
 * 理由：naive-ui 的浮层（popover / tooltip / drawer）会 teleport 到 body 末尾的容器里，
 * 那些容器即使不可见也会把 `documentElement.scrollHeight` 撑大 —— 用它做判据会一直是红的，
 * 而用户实际体验（能不能把整页滚走）是好的。
 * 判据改成"滚一下窗口，滚动量必须还是 0"。
 */
const windowScroll = await cdp.evaluate(
  `(() => {
     window.scrollTo(0, 400);
     return { y: window.scrollY, bodyOverflow: getComputedStyle(document.body).overflowY };
   })()`,
  { awaitPromise: false },
);
check('整页不可滚动（页面高度固定，只能换页）', windowScroll.y === 0, `scrollY=${windowScroll.y}`);
check('body 显式 hidden，避免移动端地址栏把整页顶动', windowScroll.bodyOverflow === 'hidden', windowScroll.bodyOverflow);

/*
 * 内容区必须**能**滚（否则长列表会把顶栏底栏顶掉）。
 *
 * 做法：临时往 `.w-content` 里塞一个高块，验证它真的产生滚动，再撤掉。
 * 为什么不拿现成的页面试：现在还没有一屏的内容高于视口（概览域只有 3 条告警），
 * "内容不长所以不能滚"不能证明容器是滚动容器。
 */
const contentScroll = await cdp.evaluate(
  `(() => {
     const c = document.querySelector('.w-content');
     if (!c) return { ok: false, why: 'no .w-content' };
     const probe = document.createElement('div');
     probe.style.height = '3000px';
     c.appendChild(probe);
     const before = c.scrollTop;
     c.scrollTop = 200;
     const moved = c.scrollTop > before;
     const overflowY = getComputedStyle(c).overflowY;
     const docMoved = (() => { window.scrollTo(0, 400); return window.scrollY; })();
     probe.remove();
     c.scrollTop = before;
     return { ok: moved && overflowY === 'auto', moved, overflowY, docMoved };
   })()`,
  { awaitPromise: false },
);
check(
  '内容区是滚动容器（长内容时真的滚，整页仍不动）',
  contentScroll.ok === true && contentScroll.docMoved === 0,
  JSON.stringify(contentScroll),
);
await cdp.evaluate(`(location.hash = '#/overview/dashboard')`, { awaitPromise: false });
await sleep(400);

const hasSearch = await cdp.evaluate(
  `(() => {
     const right = document.querySelector('.w-commandbar__right');
     return {
       hasSearch: !!right?.querySelector('input'),
       searchPlaceholder: right?.querySelector('input')?.getAttribute('placeholder') ?? '',
       chipText: right?.querySelector('.w-chip')?.innerText.trim() ?? '',
     };
   })()`,
  { awaitPromise: false },
);
check('右上角有搜索框', hasSearch.hasSearch && /搜索页面/.test(hasSearch.searchPlaceholder), hasSearch.searchPlaceholder);
check(
  'Bridge 芯片显示实测往返耗时（Bridge · 状态 · Nms）',
  /Bridge · (正常|假桥) · \d+ms/.test(hasSearch.chipText),
  hasSearch.chipText,
);

/*
 * "实时"与"真实"这两条，只能用**制造故障**来验：
 *  · 实时：不动界面、不发任何请求，芯片也会自己刷新 —— 靠的是 store 里的周期探测；
 *  · 真实：把后端打挂之后，芯片必须变成"异常"，而不是继续显示"正常"。
 * 开发态的假桥提供了 `setBackendDown` 开关（真后端没法按需挂掉）。
 * 探测周期是 10 秒，所以每步要给它一个周期多一点的时间。
 */
const chipTextNow = () => cdp.evaluate(`document.querySelector('.w-commandbar__right .w-chip')?.innerText.trim() ?? ''`, { awaitPromise: false });
const setBackendDown = (down) =>
  cdp.evaluate(`window.__bridgeMock?.setBackendDown(${down === true}) ?? false`, { awaitPromise: false });

await setBackendDown(true);
const downText = await waitFor(
  `(() => {
     const t = document.querySelector('.w-commandbar__right .w-chip')?.innerText.trim() ?? '';
     return t.includes('探测失败') ? t : null;
   })()`,
  25_000,
  500,
);
check('后端不可达时顶栏显示"异常"（不会继续显示正常）', downText !== null, downText ?? await chipTextNow());

const bannerText = await cdp.evaluate(
  `document.querySelector('.w-app__banner')?.innerText ?? ''`,
  { awaitPromise: false },
);
check('顶部横幅同时反映故障并给出该怎么办', /探测失败|不可达|连接已断开/.test(bannerText), bannerText.slice(0, 50));

const toneWhileDown = await cdp.evaluate(
  `document.querySelector('.w-commandbar__right .w-chip')?.className ?? ''`,
  { awaitPromise: false },
);
check('异常态用的是危险色（不是正常色）', /w-chip--danger/.test(toneWhileDown), toneWhileDown);

await setBackendDown(false);
const recoveredText = await waitFor(
  `(() => {
     const t = document.querySelector('.w-commandbar__right .w-chip')?.innerText.trim() ?? '';
     return /Bridge · (正常|假桥) · \\d+ms/.test(t) ? t : null;
   })()`,
  25_000,
  500,
);
check('恢复后自动回到正常（不需要刷新页面）', recoveredText !== null, recoveredText ?? await chipTextNow());check('右上角有搜索框', layout.hasSearch && /搜索页面/.test(layout.searchPlaceholder), layout.searchPlaceholder);
check(
  'Bridge 芯片显示实测往返耗时（Bridge · 状态 · Nms）',
  /Bridge · (正常|假桥) · \d+ms/.test(layout.chipText),
  layout.chipText,
);

// 页面跳转搜索要真的能用（Element Plus 的 autocomplete：先输入，再回车）
const searchTyped = await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.w-commandbar__right input');
     if (!input) return false;
     const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
     setter.call(input, '告警');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
// EP 的 autocomplete 默认 300ms 防抖，输入与回车之间必须等，否则"没反应"是测试的错
await sleep(700);
await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.w-commandbar__right input');
     input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(700);
const afterSearch = await cdp.evaluate(
  `({ hash: location.hash, title: document.querySelector('.w-page-header__title')?.innerText ?? '' })`,
  { awaitPromise: false },
);
check(
  '搜索页面后回车能跳到该页',
  searchTyped === true && afterSearch.hash.includes('/overview/alerts'),
  `${afterSearch.hash} / ${afterSearch.title}`,
);

const dropdownHint = await cdp.evaluate(
  `document.querySelector('.w-commandbar__right input')?.getAttribute('placeholder') ?? ''`,
  { awaitPromise: false },
);
check('搜索框写明只搜页面名称', /不搜数据/.test(dropdownHint), dropdownHint);

/*
 * 第八阶段：库存域（V4 第二域）—— 真取数 + 真流程。
 *
 * 这一段验的是"只有状态会变的 mock 才验得到"的东西：
 * 客户端筛选、锁定/解锁、建单后进详情、单据状态机（提交要明细 / 撤回 / 审核）、
 * 以及一个很容易忘的参数名（`warehouse.delete` 的入参是 `id`）。
 */
console.log('\n8/8 库存域（库存 / 商品 / 仓库 / 标签 / 出入库单）…');
await ensureSignedIn();

// ---- 库存查询：服务端搜索（按商品名，跨页）+ 本页筛选的回退口径 ----
await cdp.evaluate(`(location.hash = '#/inventory/inventory')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '库存查询' ? true : null`, 20_000, 200);
await waitRows(3);
check('库存查询列表 3 行', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

// 没有关键词时仍然是"筛选本页"——服务端搜索只在有关键词时发生
const scopeLabel = await text('.w-inventory__scope');
check('没有关键词时标注"筛选本页"', scopeLabel === '筛选本页', scopeLabel);

/** 往库存搜索框写词并点「查找」。 */
const searchInventory = async (word) => {
  await cdp.evaluate(
    `(() => {
       const input = document.querySelector('.w-inventory__search input');
       const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
       setter.call(input, ${JSON.stringify(word)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    { awaitPromise: false },
  );
  await sleep(300);
  await clickByText('查找');
  await sleep(700);
};

await clearCalls();
await searchInventory('液压');
check('关键词筛选生效（液压 → 1 行）', (await rowsNow()) === 1, `rows=${await rowsNow()}`);

/*
 * 关键区别：这条查询必须**真的发给服务端**（`inventory.search`），而不是只筛当前页 ——
 * 只筛当前页时，落在第 2 页的那条商品永远搜不到，用户看到的是"搜不到"。
 */
const invCalls = await callsWithPrefix('inventory.');
check(
  '关键词走的是服务端搜索（带 keyword 与 type=LOCATION）',
  invCalls.includes('inventory.search') &&
    invCalls.includes('"keyword":"液压"') &&
    invCalls.includes('"type":"LOCATION"'),
  invCalls,
);
const serverScope = await text('.w-inventory__scope');
check('搜索口径写在界面上（服务端按商品名 · 跨页 N 条）', /服务端按商品名搜索「液压」· 跨页 1 条/.test(serverScope), serverScope);

/*
 * 口径边界：服务端**只按商品名匹配**（`findByNameContaining`，货位/编码/仓库都不认）。
 * 关键词是货位时必须回退到本页筛选，并把这件事写在界面上 —— 否则用户会以为"全库都没有"。
 */
await searchInventory('B-02-04');
const fallbackScope = await text('.w-inventory__scope');
check(
  '按货位搜：服务端不命中时回退本页，并把口径写清楚',
  /服务端没有商品名匹配/.test(fallbackScope) && (await rowsNow()) === 1,
  `${fallbackScope} rows=${await rowsNow()}`,
);

// 两头都没有 → 空态要给出可行动的下一步（"服务端只按商品名搜索"）
await searchInventory('不存在的商品');
check('搜不到时说明"服务端只按商品名搜索"', /服务端只按商品名搜索/.test(await text('.w-empty')), (await text('.w-empty')).slice(0, 40));

// 清空关键词 → 回到分页列表与"筛选本页"
await searchInventory('');
check('清空关键词后回到分页列表', (await rowsNow()) === 3 && (await text('.w-inventory__scope')) === '筛选本页', `rows=${await rowsNow()}`);

// ---- 库存详情：锁定流程（直接用有可用量的那条，避免受上一步筛选影响）----
await cdp.evaluate(`(location.hash = '#/inventory/inventory/101')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText.includes('工业级 RFID 标签') ? true : null`, 20_000, 200);
const inventoryDetailTitle = await text('.w-page-header__title');
check('库存详情按序号直达', /工业级 RFID 标签/.test(inventoryDetailTitle), inventoryDetailTitle);

/*
 * "这里为什么没有改数量的输入框"必须写在界面上。
 *
 * 2026-10-03 查实：库存只能由出入库单流转产生（`InOutApplicationService#processInventory`），
 * 而 `inventory.create` 在真后端上固定 400（实体 `@NotNull` + 服务层从不 setWarehouseId，
 * 见 `tools/bench/inventory-tag-probe.mjs`）。所以"改库存数"不是没做，是**不该做**——
 * 界面缺一个操作时用户会当成功能没做完，得把来由说出来。
 */
const inventoryHint = await text('.w-inv-hint');
check('库存详情说明"数量来自出入库单、这里不能直接改"', /出入库单/.test(inventoryHint) && /不能直接改/.test(inventoryHint), inventoryHint.slice(0, 60));

await clickByText('锁定');
await sleep(400);
await clickByText('确认锁定');
await sleep(300);
const lockError = await text('.w-inv-error');
check('锁定必须填数量（空数量被拦下）', /大于 0/.test(lockError), lockError.slice(0, 30));

await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.el-dialog input');
     const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
     setter.call(input, '5');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(200);
await clickByText('确认锁定');
await sleep(700);
const lockNotice = await text('.w-inv-notice');
check('锁定成功后给出明确回执', /已锁定 5 件/.test(lockNotice), lockNotice.slice(0, 40));

// ---- 商品管理：新建 + 引用校验 ----
await cdp.evaluate(`(location.hash = '#/inventory/products')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '商品管理' ? true : null`, 20_000, 200);
await waitRows(3);
check('商品列表 3 行', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

await clickByText('新增商品');
await sleep(400);
await clickByText('创建');
await sleep(300);
const createError = await text('.w-inv-error');
check('新建商品必填校验（名称/编码不能空）', /必填/.test(createError), createError.slice(0, 30));

const fillDialogInputs = (values) =>
  cdp.evaluate(
    `(() => {
       const inputs = [...document.querySelectorAll('.el-dialog input')];
       const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputs[0]), 'value').set;
       const values = ${JSON.stringify(values)};
       inputs.forEach((el, i) => {
         if (values[i] === undefined) return;
         setter.call(el, values[i]);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       });
       return inputs.length;
     })()`,
    { awaitPromise: false },
  );
await fillDialogInputs(['测试物料', 'TEST-001', 'T-1', '个']);
await sleep(200);
await clickByText('创建');
await sleep(800);
check('新建商品后列表多一条', (await rowsNow()) === 4, `rows=${await rowsNow()}`);

/*
 * ---- 编辑：预填当前值 → 只改型号 → 保存 ----
 *
 * 这条盯的是服务端那个**部分更新**语义的两个面：
 *   1. 表单必须预填（否则用户以为"只改型号"，实际把名称/编码一起清空了）；
 *   2. 保存要把当前值一起发回去（界面侧不允许留空），改完列表里名称不能被擦掉。
 */
await clearCalls();
const editOpened = await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '编辑');
     if (!btn) return false;
     btn.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
check('行内「编辑」能打开弹窗', editOpened === true);
const editDialog = await cdp.evaluate(
  `(() => {
     const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find((d) => d.offsetParent !== null);
     return {
       title: dialog?.querySelector('.el-dialog__title')?.innerText.trim() ?? '',
       values: [...(dialog?.querySelectorAll('input') ?? [])].map((i) => i.value),
     };
   })()`,
  { awaitPromise: false },
);
check('编辑弹窗标题是「编辑商品」', editDialog.title === '编辑商品', editDialog.title);
check(
  '表单**预填**了当前值（不是空白）',
  editDialog.values[0] === '测试物料' && editDialog.values[1] === 'TEST-001' && editDialog.values[2] === 'T-1',
  JSON.stringify(editDialog.values),
);

await fillDialogInputs(['测试物料', 'TEST-001', 'T-9', '个']);
await sleep(200);
await clickByText('保存');
await sleep(900);
const editCalls = await callsWithPrefix('product.update');
check(
  '保存真的调用了 product.update 并带上 productId',
  editCalls.includes('product.update') && editCalls.includes('"productId"'),
  editCalls,
);
const editedRowText = await text('.el-table__body tbody tr.el-table__row');
check(
  '列表显示新型号，且名称没被部分更新语义擦掉',
  /T-9/.test(editedRowText) && /测试物料/.test(editedRowText),
  editedRowText.slice(0, 60),
);

// 删除被库存引用的商品（mock 会抛 VAL-0002）→ 界面要把服务端原文显示出来
await cdp.evaluate(
  `(() => {
     // 刚新建的那条在最前面、还没有库存引用；被库存引用的在下面，取最后一行
     const rows = [...document.querySelectorAll('.el-table__body tbody tr.el-table__row')];
     const row = rows[rows.length - 1];
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除');
     btn?.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(400);
await clickByText('删除');
await sleep(600);
const deleteError = await cdp.evaluate(
  `({
     err: document.querySelector('.w-inv-error')?.innerText ?? '',
     dialogOpen: !!document.querySelector('.el-dialog__title'),
     rowCount: document.querySelectorAll('.el-table__body tbody tr.el-table__row').length,
   })`,
  { awaitPromise: false },
);
check(
  '删除被引用商品：显示服务端原话而不是"操作失败"',
  /已有库存记录/.test(deleteError.err),
  JSON.stringify(deleteError),
);

// ---- 仓库管理：编辑（`!= null` 就写语义）+ 删除的参数名是 id ----
await cdp.evaluate(`(location.hash = '#/inventory/warehouses')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '仓库管理' ? true : null`, 20_000, 200);
await waitRows(2);
check('仓库列表 2 行', (await rowsNow()) === 2, `rows=${await rowsNow()}`);

/*
 * ---- 编辑仓库：预填 → 改描述 → 保存 ----
 *
 * `warehouse.update` 的语义与商品**相反**（四个字段都是 `!= null` 就写，传空串是清空），
 * 所以这条既验"改了生效"，也验"没动过的字段还在"。
 */
await clearCalls();
const whEditOpened = await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '编辑');
     if (!btn) return false;
     btn.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
check('仓库行内「编辑」能打开弹窗', whEditOpened === true);
const whDialog = await cdp.evaluate(
  `(() => {
     const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find((d) => d.offsetParent !== null);
     return {
       title: dialog?.querySelector('.el-dialog__title')?.innerText.trim() ?? '',
       values: [...(dialog?.querySelectorAll('input') ?? [])].map((i) => i.value),
     };
   })()`,
  { awaitPromise: false },
);
check('编辑弹窗标题是「编辑仓库」', whDialog.title === '编辑仓库', whDialog.title);
check(
  '仓库表单预填了当前值（含 DTO 里的描述字段）',
  whDialog.values[0] === '华东中心仓' && whDialog.values[1] === 'EC-01' && whDialog.values[3] === '常温区，负责华东片区',
  JSON.stringify(whDialog.values),
);
await fillDialogInputs(['华东中心仓', 'EC-01', '上海市青浦区', '常温区·已复核']);
await sleep(200);
await clickByText('保存');
await sleep(900);
const whCalls = await callsWithPrefix('warehouse.update');
check('保存真的调用了 warehouse.update（路径参数名 id）', whCalls.includes('warehouse.update') && whCalls.includes('"id"'), whCalls);
const whRowText = await text('.el-table__body tbody tr.el-table__row');
check(
  '列表显示新描述，且名称/编码没被擦掉',
  /常温区·已复核/.test(whRowText) && /华东中心仓/.test(whRowText) && /EC-01/.test(whRowText),
  whRowText.slice(0, 60),
);

await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除');
     btn?.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(400);
await clickByText('删除');
await sleep(700);
check('删除仓库成功（入参名 id 正确）', (await rowsNow()) === 1, `rows=${await rowsNow()}`);

// ---- 标签管理：批量绑定要验证码 ----
await cdp.evaluate(`(location.hash = '#/inventory/tags')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '标签管理' ? true : null`, 20_000, 200);
const tagRows = await cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, {
  awaitPromise: false,
});
check('标签列表 3 行', tagRows === 3, `rows=${tagRows}`);

// 勾选第 2、3 行（未绑定的那两个）
const checked = await cdp.evaluate(
  `(() => {
     // 点 inner input：EP 的复选框把 click 绑在 input 上，点外层 div 不一定触发
     const boxes = [...document.querySelectorAll('.el-table__body .el-checkbox input')];
     boxes[1]?.click();
     boxes[2]?.click();
     return boxes.length;
   })()`,
  { awaitPromise: false },
);
await sleep(400);
const batchLabel = await cdp.evaluate(
  `([...document.querySelectorAll('button')].find((b) => b.innerText.includes('批量绑定'))?.innerText ?? '')`,
  { awaitPromise: false },
);
check('勾选后批量按钮显示选中数', /批量绑定（2）/.test(batchLabel), `${batchLabel} / boxes=${checked}`);

await clickByText('批量绑定（2）');
await sleep(600);
const captchaVisible = await cdp.evaluate(`!!document.querySelector('.el-dialog .w-captcha__input')`, {
  awaitPromise: false,
});
check('批量绑定弹窗带验证码', captchaVisible === true);
await clickByText('确认绑定');
await sleep(300);
const bindError = await text('.w-inv-error');
check('批量绑定必须先选商品', /请先选择要绑定的商品/.test(bindError), bindError.slice(0, 30));

// 选商品 + 填验证码 → 绑定成功
await cdp.evaluate(
  `(() => {
     const selection = document.querySelector('.el-dialog .el-select');
     selection?.querySelector('.el-select__wrapper')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
const picked = await cdp.evaluate(
  `(() => {
     const opt = document.querySelector('.el-select-dropdown__item');
     if (!opt) return false;
     opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.el-dialog .w-captcha__input input');
     const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
     setter.call(input, '1234');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(200);
await clickByText('确认绑定');
await sleep(900);
const boundChips = await cdp.evaluate(
  `[...document.querySelectorAll('.el-table__body .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check(
  '绑定成功后行状态变为已绑定',
  picked === true && boundChips.filter((c) => c === '已绑定').length === 3,
  `${boundChips.join('/')} picked=${picked}`,
);

// ---- 批量解绑：服务端那个"批量"接口**调不通**，界面必须逐条发 tag.unbind ----
await clearCalls();
await cdp.evaluate(
  `(() => {
     const boxes = [...document.querySelectorAll('.el-table__body .el-checkbox input')];
     boxes[1]?.click();
     boxes[2]?.click();
     return boxes.length;
   })()`,
  { awaitPromise: false },
);
await sleep(400);
await clickByText('批量解绑（2）');
await sleep(500);
await clickByText('确认解绑');
await sleep(1500);
const unbindCalls = await callsWithPrefix('tag.unbind');
const unbindCount = unbindCalls.split(' | ').filter((x) => x !== '').length;
const batchUnbindCalls = await callsWithPrefix('tag.batchUnbind');
check(
  '批量解绑逐条发 tag.unbind（服务端的 tag.batchUnbind 两种 body 都 400，真后端实测）',
  unbindCount === 2 && batchUnbindCalls === '',
  `tag.unbind×${unbindCount} / batchUnbind="${batchUnbindCalls}"`,
);
const unbindNotice = await text('.w-inv-notice');
check('批量解绑给出成功回执（做完没反应会让人重复点）', /已解绑 2 个标签/.test(unbindNotice), unbindNotice.slice(0, 30));

// ---- 新建标签：至少一个标识；空字段不传（传空串在服务端是"写进去"）----
const fillDialogInput = (title, index, value) =>
  cdp.evaluate(
    `(() => {
       const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
       const dlg = [...document.querySelectorAll('.el-dialog')].find(
         (d) => d.querySelector('.el-dialog__title')?.innerText.trim() === ${JSON.stringify(title)} && visible(d),
       );
       const input = dlg ? [...dlg.querySelectorAll('.el-input__inner')][${index}] : null;
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    { awaitPromise: false },
  );

await clearCalls();
await clickByText('新建标签');
await sleep(500);
await clickByText('创建标签');
await sleep(300);
check('新建标签要求至少填一个标识', /至少要填一个/.test(await text('.el-dialog .w-inv-error')), (await text('.el-dialog .w-inv-error')).slice(0, 40));
await fillDialogInput('新建标签', 0, 'SMOKE-TAG-1');
await sleep(200);
await clickByText('创建标签');
await sleep(1200);
const createCalls = await callsWithPrefix('tag.create');
check('新建标签真的调了 tag.create 且带上了条码', createCalls.includes('SMOKE-TAG-1'), createCalls.slice(0, 80));
check('新建标签给出回执', /标签已创建/.test(await text('.w-inv-notice')), (await text('.w-inv-notice')).slice(0, 40));

// ---- 标签详情：绑定 / 改标识 / 删除，**且不能用重取复核**（服务端 getTag 有缓存、写操作不失效它）----
await cdp.evaluate(`(location.hash = '#/inventory/tags')`, { awaitPromise: false });
await sleep(600);
await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return !!row;
   })()`,
  { awaitPromise: false },
);
await waitFor(`document.querySelector('.w-page-header__title') && location.hash.includes('/inventory/tags/') ? true : null`, 20_000, 200);
await sleep(600);

await clickByText('绑定商品');
await sleep(600);
await cdp.evaluate(
  `(() => {
     const wrapper = document.querySelector('.el-dialog .el-select__wrapper');
     wrapper?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return !!wrapper;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
await cdp.evaluate(
  `(() => {
     const opt = document.querySelector('.el-select-dropdown__item');
     opt?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return !!opt;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await clickByText('确认绑定');
await sleep(1200);
const bindNotice = await text('.w-tag-notice');
check('详情绑定给出回执', /已绑定/.test(bindNotice), bindNotice.slice(0, 40));
/*
 * 这条是本批的关键：服务端 `getTag` 带 `@Cacheable(1800)`，而 bind/unbind/update/delete
 * 都**没有** `@CacheEvict` —— 写成功后若 `reload()`，拿回来的是**旧值**，界面会一秒钟把刚写的抹回去。
 * 所以断言"状态立刻变了"，钉住"用写操作的响应更新显示"这个做法。
 */
const statusAfterBind = await text('.w-page-header .w-chip');
check('绑定后状态**立刻**变成已绑定（用写操作的响应，不等缓存过期）', /已绑定/.test(statusAfterBind), statusAfterBind);

await clickByText('改标识');
await sleep(600);
await fillDialogInput('修改标签标识', 0, 'SMOKE-BC-9');
await sleep(200);
await clickByText('保存');
await sleep(1200);
const kvAfterEdit = await text('.w-card');
check('改标识后立刻显示新条码（同理：不吃服务端那份旧缓存）', /SMOKE-BC-9/.test(kvAfterEdit), kvAfterEdit.replace(/\s+/g, ' ').slice(0, 70));

const beforeDelete = await cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, {
  awaitPromise: false,
});
await clickByText('删除标签');
await sleep(600);
const deleteClicked = await clickByText('确认删除');
await sleep(1500);
const afterDeleteHash = await cdp.evaluate('location.hash', { awaitPromise: false });
check('删除后回到标签列表（列表走的是另一条读路径，能看到真实结果）', deleteClicked === true && afterDeleteHash === '#/inventory/tags', `${deleteClicked} / ${afterDeleteHash} / before=${beforeDelete}`);

// ---- 出入库单：状态机 ----
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '出入库单' ? true : null`, 20_000, 200);
await waitRows(3);
check('单据列表 3 张', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

// 没有明细的那张（8003）：提交按钮不可点，且原因写着"还没有明细"
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders/8003')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText.includes('IN-20260103-0800') ? true : null`, 20_000, 200);
const noItemSubmit = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '提交');
     return { disabled: b ? b.disabled : null };
   })()`,
  { awaitPromise: false },
);
const reasons = await cdp.evaluate(
  `[...document.querySelectorAll('.w-order-reason')].map((n) => n.innerText.trim()).join(' | ')`,
  { awaitPromise: false },
);
check('没有明细的单据不能提交', noItemSubmit.disabled === true);
check('并且写明原因（需要先登记明细）', /还没有明细/.test(reasons), reasons.slice(0, 40));

/*
 * ---- 明细增删：规则模块里早就写好、界面之前没接的那条 ----
 *
 * `canEditItems`（只有待处理 / 已驳回可增删）与服务端 `addItem/removeItem` 的两道闸门逐字一致。
 * 这里在**待审批**的 8001 上验"能加能删"，在**待审核**的 8002 上验"没有入口且写明原因"。
 */
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders/8001')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText.includes('IN-20260101-0900') ? true : null`, 20_000, 200);
const itemsBefore = await cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, { awaitPromise: false });
const editToolbar = await cdp.evaluate(
  `({
     hasAdd: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '添加明细'),
     hasTagInput: !!document.querySelector('.w-order__tag input'),
   })`,
  { awaitPromise: false },
);
check('待审批单据有「添加明细」入口（规则允许）', editToolbar.hasAdd === true && editToolbar.hasTagInput === true, JSON.stringify(editToolbar));

await clearCalls();
await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.w-order__tag input');
     const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
     setter.call(input, '3');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await clickByText('添加明细');
await sleep(1000);
const itemAddCalls = await callsWithPrefix('stockOrder.addItem');
check(
  '添加真的调用了 stockOrder.addItem（只发 tagId，商品由标签带出）',
  itemAddCalls.includes('stockOrder.addItem') && itemAddCalls.includes('"tagId":3') && !itemAddCalls.includes('productName'),
  itemAddCalls,
);
const itemsAfterAdd = await cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, { awaitPromise: false });
check('明细真的多了一条', itemsAfterAdd === itemsBefore + 1, `${itemsBefore} → ${itemsAfterAdd}`);
const addNotice = await text('.w-order-notice');
check('添加后给出"商品按标签带出、项数加一"的说法', /明细已添加/.test(addNotice), addNotice.slice(0, 30));

// 移除刚才加的那条（tag 3 未绑定商品，行文本里就是"未绑定商品"）
await clearCalls();
const removeHit = await cdp.evaluate(
  `(() => {
     const rows = [...document.querySelectorAll('.el-table__body tbody tr.el-table__row')];
     // 别用 includes('3') 找行：数字 3 可能出现在数量/货位里，匹配到别的行就什么都不会发生（踩过一次）
     const row = rows.find((r) => r.innerText.includes('未绑定商品')) ?? rows[rows.length - 1];
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '移除');
     if (!btn) return false;
     btn.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(1000);
const removeCalls = await callsWithPrefix('stockOrder.removeItem');
check(
  '移除真的调用了 stockOrder.removeItem（按 tagId 精确移除）',
  removeHit === true && removeCalls.includes('stockOrder.removeItem') && removeCalls.includes('"tagId":3'),
  `${removeHit} / ${removeCalls}`,
);
const itemsAfterRemove = await cdp.evaluate(`document.querySelectorAll('.el-table__body tbody tr.el-table__row').length`, { awaitPromise: false });
check('移除后明细回到原来的条数（项数同步）', itemsAfterRemove === itemsBefore, `${itemsAfterAdd} → ${itemsAfterRemove}`);

// 待审核的那张（8002）：没有增删入口，并写明原因（服务端原话）
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders/8002')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText.includes('OUT-20260102-1000') ? true : null`, 20_000, 200);
const submittedEdit = await cdp.evaluate(
  `({
     hasAdd: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '添加明细'),
     hasRemove: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '移除'),
     reason: [...document.querySelectorAll('.w-order-reason')].map((n) => n.innerText.trim()).join(' | '),
   })`,
  { awaitPromise: false },
);
check('待审核单据没有增删入口（规则不允许）', submittedEdit.hasAdd === false && submittedEdit.hasRemove === false, JSON.stringify(submittedEdit).slice(0, 80));
check(
  '并且写明"只有待处理或已驳回可以增删明细"（与偶服务端同一句）',
  /只有待处理或已驳回的单据可以增删明细/.test(submittedEdit.reason),
  submittedEdit.reason.slice(0, 60),
);

// 待审核的那张（8002）：撤回 + 审核通过都可点；审核通过后全部不可点
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders/8002')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText.includes('OUT-20260102-1000') ? true : null`, 20_000, 200);
const submittedActions = await cdp.evaluate(
  `(() => {
     const pick = (label) => {
       const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === label);
       return b ? !b.disabled : null;
     };
     return { withdraw: pick('撤回'), approve: pick('审核通过'), submit: pick('提交') };
   })()`,
  { awaitPromise: false },
);
check('待审核：撤回与审核通过可点', submittedActions.withdraw === true && submittedActions.approve === true, JSON.stringify(submittedActions));
check('待审核：提交不可点（状态不对）', submittedActions.submit === false);

await clickByText('审核通过');
await sleep(400);
await clickByText('确定');
await sleep(900);
const auditedState = await text('.w-page-header .w-chip');
check('审核通过后状态变为已审批', auditedState === '已审批', auditedState);
const afterAudit = await cdp.evaluate(
  `(() => {
     const labels = ['提交', '撤回', '审核通过', '驳回'];
     return labels.map((l) => {
       const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === l);
       return b ? b.disabled : null;
     });
   })()`,
  { awaitPromise: false },
);
check('已审批是终态：四个动作全部不可点', afterAudit.every((d) => d === true), JSON.stringify(afterAudit));

// ---- 新建单据：默认单号 + 建单 ----
await cdp.evaluate(`(location.hash = '#/inventory/stock-orders/new')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '新建出入库单' ? true : null`, 20_000, 200);
/*
 * 只看内容区里的**文本框**：顶栏的「页面跳转」搜索也是一个 input，
 * 而单据类型那一行的 `ElRadioButton` 也会渲染出 `<input type="radio" value="IN">` ——
 * 直接取第一个 input 会拿到 `IN` 而不是单号（这条踩过）。
 */
const defaultNo = await cdp.evaluate(
  `[...document.querySelectorAll('.w-content input')]
     .map((el) => el.value)
     .find((v) => /^(IN|OUT)-\\d{8}-\\d{4}$/.test(v)) ?? ''`,
  { awaitPromise: false },
);
check('默认单号按"类型-日期-时分"生成', /^IN-\d{8}-\d{4}$/.test(defaultNo), defaultNo);

await clickByText('建单');
await sleep(300);
const createOrderError = await text('.w-order-error');
check('建单必填校验（先选仓库）', /请先选择仓库/.test(createOrderError), createOrderError.slice(0, 30));

await cdp.evaluate(
  `(() => {
     const selection = document.querySelector('.el-select');
     selection?.querySelector('.el-select__wrapper')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
await cdp.evaluate(
  `(() => {
     const opt = document.querySelector('.el-select-dropdown__item');
     opt?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await clickByText('建单');
await sleep(900);
const orderNotice = await text('.w-order-notice');
check('建单成功并给出下一步', /待审批状态/.test(orderNotice), orderNotice.slice(0, 40));

// ---- 设备（现场域，第三域的开始）：统计不阻断列表 + 只读参数 ----
await cdp.evaluate(`(location.hash = '#/field/devices')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '设备管理' ? true : null`, 20_000, 200);
await waitRows(3);
check('设备列表 3 台', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

const deviceNote = await text('.w-page-header__note');
check('页头给出真实在线数（来自 device.statistics）', /在线 1 台/.test(deviceNote), deviceNote);

const deviceChips = await cdp.evaluate(
  `[...document.querySelectorAll('.el-table__body .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check(
  '设备状态用的服务端译好的说法（在线/离线/故障）',
  ['在线', '离线', '故障'].every((t) => deviceChips.includes(t)),
  deviceChips.join('/'),
);

await cdp.evaluate(`(location.hash = '#/field/devices/1')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '搬运机器人 01' ? true : null`, 20_000, 200);
await waitFor(`document.querySelectorAll('.w-kv__value').length > 5 ? true : null`, 15_000, 200);
const kvText = await cdp.evaluate(
  `({
     values: [...document.querySelectorAll('.w-kv__value')].map((n) => n.innerText.trim()).join(' | '),
     sections: [...document.querySelectorAll('.w-section__title')].map((n) => n.innerText.trim()).join('/'),
     kvBlocks: document.querySelectorAll('.w-kv').length,
     paramCount: [...document.querySelectorAll('.w-kv__label')].map((n) => n.innerText.trim()).filter((t) => t.includes('电机微调') || t === '行走速度').length,
   })`,
  { awaitPromise: false },
);
check(
  '设备详情显示只读运行参数（速度 / 四路微调）',
  /60 厘米\/秒/.test(kvText.values) && kvText.paramCount === 5,
  JSON.stringify(kvText),
);
const sliderCount = await cdp.evaluate(`document.querySelectorAll('.el-slider').length`, { awaitPromise: false });
check('只读参数不用滑块（不暗示可调）', sliderCount === 0, `sliders=${sliderCount}`);

await cdp.evaluate(`(location.hash = '#/field/devices/code/BOT-001')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '搬运机器人 01' ? true : null`, 20_000, 200);
check('按设备编号查询可直达（参数名 deviceCode 接对了）', true);

await cdp.evaluate(`(location.hash = '#/field/devices/code/NOPE-999')`, { awaitPromise: false });
await sleep(1500);
const notFoundState = await cdp.evaluate(
  `({
     hash: location.hash,
     title: document.querySelector('.w-page-header__title')?.innerText ?? '',
     errCode: document.querySelector('.w-error__code')?.innerText ?? null,
     errText: document.querySelector('.w-error__text')?.innerText ?? null,
     empty: document.querySelector('.w-empty')?.innerText ?? null,
   })`,
  { awaitPromise: false },
);
check(
  '查不到的设备如实报错（不画空详情）',
  /没有找到编号/.test(notFoundState.errText ?? ''),
  JSON.stringify(notFoundState),
);

// ---- 巡检计划（现场域）：计划 CRUD —— 没有它，现场没法自己排计划 ----
await cdp.evaluate(`(location.hash = '#/field/inspection-plans')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '巡检计划' ? true : null`, 20_000, 200);
await waitRows(3);
check('巡检计划列表 3 条', (await rowsNow()) === 3, `rows=${await rowsNow()}`);
const planChips = await cdp.evaluate(
  `[...document.querySelectorAll('.el-table__body .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check('启用/停用两种状态都能显示', planChips.includes('启用中') && planChips.includes('已停用'), planChips.join('/'));
const planFirstRowText = await text('.el-table__body tbody tr.el-table__row');
const planTableText = await text('.el-table__body');
check(
  '执行设备解析成设备名（不是裸序号）',
  /读头 04/.test(planFirstRowText),
  planFirstRowText.slice(0, 60),
);
check(
  '定时表达式为空时说"手动触发"（不画一个空单元格）',
  /手动触发/.test(planTableText),
  planTableText.slice(0, 80),
);

await clearCalls();
await clickByText('新建计划');
await sleep(500);
await fillDialogInputs(['冒烟计划', '2', '0 0 7 * * ?']);
await sleep(200);
await clickByText('创建');
await sleep(1000);
const planCreateCalls = await callsWithPrefix('inspection.planCreate');
check('新建计划真的调用了 inspection.planCreate', planCreateCalls.includes('inspection.planCreate'), planCreateCalls);
check('新建后列表多一条', (await rowsNow()) === 4, `rows=${await rowsNow()}`);
const planFirstRow = await text('.el-table__body tbody tr.el-table__row');
check('新计划出现在首位，并显示执行设备', /冒烟计划/.test(planFirstRow) && /搬运机器人 02/.test(planFirstRow), planFirstRow.slice(0, 60));

await clearCalls();
const planEditOpened = await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '编辑');
     if (!btn) return false;
     btn.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(500);
check('计划行内「编辑」能打开弹窗', planEditOpened === true);
const planDialog = await cdp.evaluate(
  `(() => {
     const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find((d) => d.offsetParent !== null);
     return {
       title: dialog?.querySelector('.el-dialog__title')?.innerText.trim() ?? '',
       values: [...(dialog?.querySelectorAll('input') ?? [])].slice(0, 3).map((i) => i.value),
     };
   })()`,
  { awaitPromise: false },
);
check('编辑弹窗标题正确且预填当前值', planDialog.title === '编辑巡检计划' && planDialog.values[0] === '冒烟计划' && planDialog.values[2] === '0 0 7 * * ?', JSON.stringify(planDialog).slice(0, 120));
await fillDialogInputs(['冒烟计划', '2', '0 0 6 * * ?']);
await sleep(200);
await clickByText('保存');
await sleep(1000);
const planUpdateCalls = await callsWithPrefix('inspection.planUpdate');
check('保存真的调用了 inspection.planUpdate', planUpdateCalls.includes('inspection.planUpdate'), planUpdateCalls);
check('列表显示新的定时表达式', /0 0 6 \* \* \?/.test(await text('.el-table__body tbody tr.el-table__row')), (await text('.el-table__body tbody tr.el-table__row')).slice(0, 60));

await cdp.evaluate(
  `(() => {
     const row = document.querySelector('.el-table__body tbody tr.el-table__row');
     const btn = [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除');
     btn?.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(400);
await clickByText('删除');
await sleep(900);
check('删除计划后列表回到 3 条', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

// ---- 巡检任务（现场域）：状态归一化 + 「开始执行」真的把任务推进 ----
await cdp.evaluate(`(location.hash = '#/field/inspections')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '巡检任务' ? true : null`, 20_000, 200);
await waitRows(4);
check('巡检任务列表 4 个', (await rowsNow()) === 4, `rows=${await rowsNow()}`);

const taskNote = await text('.w-page-header__note');
check('页头给出总数（来自服务端 total）', /共 4 个任务/.test(taskNote), taskNote);

const taskChips = await cdp.evaluate(
  `[...document.querySelectorAll('.el-table__body .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check(
  '状态说人话：四种状态都译成中文',
  ['待开始', '进行中', '已完成', '已暂停'].every((t) => taskChips.includes(t)),
  taskChips.join('/'),
);
/*
 * 服务端列表 DTO 的 `statusDesc` 给的是 `IN_PROGRESS` / `COMPLETED` 这种枚举原文
 * （`InspectionApplicationService` 的映射），直接在界面上画出来就是"现场人员看不懂"。
 * 这条断言是那个真实返工的回归护栏。
 */
check(
  '界面不出现英文枚举原文',
  taskChips.every((c) => !/^[A-Z][A-Z0-9_]*$/.test(c)),
  taskChips.join('/'),
);

await clickByText('进行中');
await waitRows(1);
check('筛选「进行中」只剩 1 个', (await rowsNow()) === 1, `rows=${await rowsNow()}`);
await clickByText('全部');
await waitRows(4);
check('切回「全部」恢复 4 个', (await rowsNow()) === 4, `rows=${await rowsNow()}`);

// 详情：任务信息 + 物料差异（三种判定各一行）
await cdp.evaluate(`(location.hash = '#/field/inspections/501')`, { awaitPromise: false });
await waitFor(
  `document.querySelector('.w-page-header__title')?.innerText === '巡检任务 INS-20260106-01' ? true : null`,
  20_000,
  200,
);
const detailChips = await cdp.evaluate(
  `[...document.querySelectorAll('.w-inspection-detail__chips .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check('详情状态芯片显示「进行中」+ 进度', detailChips[0] === '进行中' && /已完成 45%/.test(detailChips[1] ?? ''), detailChips.join('/'));
check('有差异时额外出一个差异提示芯片', /项物料有差异/.test(detailChips.join('/')), detailChips.join('/'));

await waitFor(`document.querySelector('.w-section__title')?.innerText.includes('物料差异') ? true : null`, 15_000, 200);
await waitRows(4);
check('物料差异 4 项', (await rowsNow()) === 4, `rows=${await rowsNow()}`);
await clickByText('只看有差异的（3）');
await waitRows(3);
check('「只看有差异的」按判定口径筛掉账实相符那行', (await rowsNow()) === 3, `rows=${await rowsNow()}`);

const runningStartDisabled = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '开始执行');
     return b ? b.disabled : null;
   })()`,
  { awaitPromise: false },
);
check('进行中的任务不能再点「开始执行」', runningStartDisabled === true, `disabled=${runningStartDisabled}`);

/*
 * 这条是**缺陷 F1 的回归护栏**：React 版发的是 `RUNNING`，而服务端只认 `IN_PROGRESS`
 * （没有 else 分支、不报错），于是"开始执行"等于把任务静默打回待执行。
 * 假桥照抄了服务端这个行为，所以值一旦改回去，这里会看到芯片没变成"进行中"。
 */
await cdp.evaluate(`(location.hash = '#/field/inspections/502')`, { awaitPromise: false });
await waitFor(
  `document.querySelector('.w-page-header__title')?.innerText === '巡检任务 INS-20260106-02' ? true : null`,
  20_000,
  200,
);
const beforeStart = await cdp.evaluate(
  `document.querySelector('.w-inspection-detail__chips .w-chip')?.innerText.trim() ?? ''`,
  { awaitPromise: false },
);
check('待开始的任务一开始是「待开始」', beforeStart === '待开始', beforeStart);

await clickByText('开始执行');
await sleep(400);
await clickByText('开始执行');
await sleep(900);
const afterStart = await cdp.evaluate(
  `({
     chip: document.querySelector('.w-inspection-detail__chips .w-chip')?.innerText.trim() ?? '',
     notice: document.querySelector('.w-inspection-detail__notice')?.innerText.trim() ?? '',
   })`,
  { awaitPromise: false },
);
// 假桥里的状态与界面是否一致，由下面这条断言长期盯着
check('「开始执行」把任务真的推进成进行中（不是被静默重置）', afterStart.chip === '进行中', afterStart.chip);
check('并且给出下一步反馈', /任务已开始执行/.test(afterStart.notice), afterStart.notice);

await clickByText('保存当前进度');
await sleep(900);
const progressNotice = await text('.w-inspection-detail__notice');
check('保存进度有反馈（现场设备与后台会同步看到）', /进度已保存/.test(progressNotice), progressNotice.slice(0, 30));

await clickByText('结束任务');
await sleep(400);
await clickByText('结束任务');
await sleep(900);
const afterEnd = await cdp.evaluate(
  `({
     chip: document.querySelector('.w-inspection-detail__chips .w-chip')?.innerText.trim() ?? '',
     notice: document.querySelector('.w-inspection-detail__notice')?.innerText.trim() ?? '',
   })`,
  { awaitPromise: false },
);
check('「结束任务」把任务推进成已完成', afterEnd.chip === '已完成', afterEnd.chip);
check('结束后反馈进入汇总（差异明细待确认）', /正在汇总盘点结果/.test(afterEnd.notice), afterEnd.notice);

/*
 * 详情屏的「查看某个任务」：编号不是正整数时**本地就拒绝**（不必发一次注定查不到的请求）。
 * 这一条是有意收紧的，React 版会把 12.5 发出去、再拿到一句"任务不存在"。
 */
await cdp.evaluate(
  `(() => {
     const input = document.querySelector('.w-inspection-detail__id-input input');
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(input, '12.5');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await clickByText('查询');
await sleep(500);
const lookupError = await text('.w-inspection-detail__error');
check('任务序号不是正整数时就地报错（不发请求）', /请输入正确的任务序号/.test(lookupError), lookupError.slice(0, 30));

// ---- 新建巡检：仓库必填（服务端真的这么要求）+ 建完能直达详情 ----
await cdp.evaluate(`(location.hash = '#/field/inspections/new')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '新建巡检任务' ? true : null`, 20_000, 200);
const createGate = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '创建任务');
     return {
       disabled: b ? b.disabled : null,
       hints: [...document.querySelectorAll('.w-inspection-create__hint')].map((n) => n.innerText.trim()).join(' | '),
       labels: [...document.querySelectorAll('.w-inspection-create__label')].map((n) => n.innerText.trim()).join(' | '),
     };
   })()`,
  { awaitPromise: false },
);
check('没选仓库时不能创建（按钮灰着）', createGate.disabled === true, `disabled=${createGate.disabled}`);
check('并且就地写明缺什么（不让人去猜灰按钮）', /还缺仓库/.test(createGate.hints), createGate.hints.slice(0, 40));
/*
 * 标签说"选填"、服务端却说"仓库ID不能为空"，是同一类"界面跟服务端唱反调"的缺陷
 * （服务层原话：`InspectionApplicationService` 的「仓库ID不能为空」+「仓库不存在」）。
 */
check('仓库标签如实写「必填」', /执行仓库序号（必填）/.test(createGate.labels), createGate.labels);

const pickWarehouse = await cdp.evaluate(
  `(() => {
     const card = [...document.querySelectorAll('.w-inspection-create__card')].find((c) =>
       c.innerText.includes('执行仓库序号'),
     );
     const btn = card ? [...card.querySelectorAll('button')].find((b) => b.innerText.trim() === '选它') : null;
     if (!btn) return false;
     btn.click();
     return true;
   })()`,
  { awaitPromise: false },
);
check('能点选一个真实仓库', pickWarehouse === true);
await sleep(300);
await clickByText('创建任务');
await waitFor(`document.querySelector('.w-inspection-create__notice') ? true : null`, 15_000, 200);
const createdResult = await cdp.evaluate(
  `({
     notice: document.querySelector('.w-inspection-create__notice')?.innerText.trim() ?? '',
     values: [...document.querySelectorAll('.w-inspection-create__result-value')].map((n) => n.innerText.trim()),
   })`,
  { awaitPromise: false },
);
check('建单成功并给出下一步', /任务已创建/.test(createdResult.notice), createdResult.notice.slice(0, 30));
check('结果里带上新任务序号与任务号', createdResult.values.length === 2 && /^\d+$/.test(createdResult.values[0] ?? ''), createdResult.values.join('/'));

await clickByText('查看该任务');
await sleep(900);
const createdDetailTitle = await text('.w-page-header__title');
check('「查看该任务」直达新任务详情', /^巡检任务 /.test(createdDetailTitle), createdDetailTitle);

// ---- 手动补录：只对已完成任务开放；补录后计数由服务端重算 ----
await cdp.evaluate(`(location.hash = '#/field/inspections/manual?taskId=501')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '手动补录巡检明细' ? true : null`, 20_000, 200);
const blockedRecord = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '提交补录');
     return { disabled: b ? b.disabled : null, err: document.querySelector('.w-inspection-manual__error')?.innerText.trim() ?? '' };
   })()`,
  { awaitPromise: false },
);
check(
  '未完成的任务不给补录，并说明当前状态与出路',
  blockedRecord.disabled === true && /这个任务当前是「进行中」/.test(blockedRecord.err) && /请先把任务做完/.test(blockedRecord.err),
  blockedRecord.err.slice(0, 40),
);

await cdp.evaluate(`(location.hash = '#/field/inspections/manual?taskId=503')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '手动补录巡检明细' ? true : null`, 20_000, 200);
/*
 * 别用类名 `w-inspection-manual__id-input` 找这个输入框：**任务序号那个输入框用的是同一个类**
 * （`.w-inspection-manual__id-input` 在模板里出现在三处：任务序号 / 明细的 NFC 编号 / TID），
 * 按类名取第一个会往"任务序号"里打字，明细行永远是空的 —— 这条踩过一次了。
 * 这里按 placeholder 唯一定位。
 */
await cdp.evaluate(
  `(() => {
     const input = [...document.querySelectorAll('.w-content input')].find((i) =>
       (i.getAttribute('placeholder') ?? '').startsWith('扫码或手输'),
     );
     if (!input) return false;
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'E200-SMOKE-01');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(300);
await clickByText('提交补录');
await sleep(400);
await clickByText('确认补录');
await sleep(1000);
const recordNotice = await text('.w-inspection-manual__notice');
check('已完成的任务补录成功', /已把 1 条明细补录到任务 503/.test(recordNotice), recordNotice.slice(0, 40));

/*
 * 服务端补录后会**重算计数**（实测：补录一行后 `normalItems` 从 8 变 0），
 * 所以界面必须重新拉任务详情；如果只是本地加一，这里会看到"正常"还是旧值。
 */
await cdp.evaluate(`(location.hash = '#/field/inspections/503')`, { awaitPromise: false });
await waitFor(
  `document.querySelector('.w-page-header__title')?.innerText === '巡检任务 INS-20260105-04' ? true : null`,
  20_000,
  200,
);
await waitFor(`document.querySelectorAll('.w-kv__label').length >= 8 ? true : null`, 15_000, 200);
/*
 * `KeyValuePanel` 的 DOM 是**一个** `<dl class="w-kv">` 里排着多组 `<dt class="w-kv__label">`
 * + `<dd class="w-kv__value">` —— `.w-kv` 是面板不是行，按"每个 .w-kv 取第一个 label"会只拿到
 * 第一条并把整张表压成一个键（这条踩过一次）。这里按 dt/dd 的相邻关系配对。
 */
const kvAfterRecord = await cdp.evaluate(
  `(() => {
     const panel = document.querySelector('.w-kv');
     if (!panel) return {};
     const cells = [...panel.children];
     const out = {};
     cells.forEach((el, index) => {
       if (!el.classList.contains('w-kv__label')) return;
       const next = cells[index + 1];
       out[el.innerText.trim()] = next ? next.innerText.trim() : '';
     });
     return out;
   })()`,
  { awaitPromise: false },
);
check(
  '补录后已扫数按服务端重算（不是界面自己加一）',
  /已盘 1/.test(kvAfterRecord['盘点数量'] ?? ''),
  `盘点数量=${kvAfterRecord['盘点数量']}`,
);
check(
  '补录条目不计入「正常」（服务端重算口径）',
  /^0 \//.test(kvAfterRecord['正常 / 异常'] ?? ''),
  `正常/异常=${kvAfterRecord['正常 / 异常']}`,
);
check('补录不改任务状态（仍是已完成）', (await text('.w-inspection-detail__chips .w-chip')) === '已完成');

// ---- 巡检结果：按任务过滤走服务端参数 + 确认入账 ----
await cdp.evaluate(`(location.hash = '#/field/inspections/results')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '巡检结果' ? true : null`, 20_000, 200);
await waitRows(2);
const resultNote = await text('.w-page-header__note');
check('结果页头给出待确认条数', /共 2 条结果，待确认 1 条/.test(resultNote), resultNote);

const resultChips = await cdp.evaluate(
  `[...document.querySelectorAll('.el-table__body .w-chip')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check('未确认的结果排在前面（这一屏的工作就是清待办）', resultChips[0] === '待确认', resultChips.join('/'));
check('两种结果状态都用中文说（认不出的也归到"待确认"）', resultChips.includes('已确认'), resultChips.join('/'));

// 点行 = 选中并取明细；确认按钮在工具栏（React 也在工具栏，只是多一个行内按钮）
await cdp.evaluate(`document.querySelector('.el-table__body tbody tr.el-table__row')?.click()`, { awaitPromise: false });
await sleep(700);
const detailSection = await cdp.evaluate(
  `[...document.querySelectorAll('.w-section__title')].map((n) => n.innerText.trim()).join('/')`,
  { awaitPromise: false },
);
check('点行后出了「结果明细」面板', /结果明细/.test(detailSection), detailSection);

await clickByText('确认这条结果');
await sleep(400);
await clickByText('确认结果');
await sleep(1000);
const confirmNotice = await text('.w-inspection-result-list__notice');
check('确认入账后给出账实结论的说法', /结果已确认/.test(confirmNotice), confirmNotice.slice(0, 30));
const afterConfirmNote = await text('.w-page-header__note');
check('确认后待确认数归零', /待确认 0 条/.test(afterConfirmNote), afterConfirmNote);

// 按任务过滤：`taskId` 是**发给服务端的参数**（真后端 listResults 支持），不是本地过滤
await cdp.evaluate(`(location.hash = '#/field/inspections/results?taskId=503')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '巡检结果' ? true : null`, 20_000, 200);
await waitRows(1);
const taskFilterChip = await cdp.evaluate(
  `[...document.querySelectorAll('.w-chip')].map((n) => n.innerText.trim()).find((t) => t.startsWith('仅看任务')) ?? ''`,
  { awaitPromise: false },
);
check('结果列表能只看某个任务的结果', taskFilterChip === '仅看任务 #503', taskFilterChip);
await clickByText('看全部任务的结果');
await waitRows(2);
check('能清掉任务过滤回到全部', (await rowsNow()) === 2, `rows=${await rowsNow()}`);

// ---- 录入结果：异常件数由「实扫 − 正常」推导，不让操作员做算术 ----
const fillByPlaceholder = (placeholder, value) =>
  cdp.evaluate(
    `(() => {
       const input = [...document.querySelectorAll('.w-content input')].find(
         (i) => i.getAttribute('placeholder') === ${JSON.stringify(placeholder)},
       );
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    { awaitPromise: false },
  );

await cdp.evaluate(`(location.hash = '#/field/inspections/results/new?taskId=502')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '录入巡检结果' ? true : null`, 20_000, 200);
/** 这一屏的 `.w-inspection-result-create__hint` 有多处，断言时看全部（不看第一个碰上的）。 */
const resultHints = async () =>
  cdp.evaluate(
    `[...document.querySelectorAll('.w-inspection-result-create__hint')].map((n) => n.innerText.trim()).join(' | ')`,
    { awaitPromise: false },
  );
check('带 taskId 进来就直接认到那个任务', /计入任务 502/.test(await resultHints()), (await resultHints()).slice(0, 40));

const submitBlocked = await cdp.evaluate(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '提交结果');
     return b ? b.disabled : null;
   })()`,
  { awaitPromise: false },
);
check('数量没填齐时不能提交', submitBlocked === true, `disabled=${submitBlocked}`);

await fillByPlaceholder('如：200', '10');
await fillByPlaceholder('如：198', '8');
await fillByPlaceholder('如：190', '6');
await fillByPlaceholder('如：2', '1');
await fillByPlaceholder('如：0', '1');
await sleep(400);
const dockHint = await resultHints();
check('异常件数是推导出来的（实扫 8 − 正常 6 = 2）', /异常 2 件/.test(dockHint), dockHint.slice(0, 60));

await clickByText('提交结果');
await sleep(400);
await clickByText('确认入账');
await sleep(1000);
const recordResultNotice = await text('.w-inspection-result-create__notice');
check('录入结果成功后任务收口（数量与差异成为账实结论）', /巡检结果已记账/.test(recordResultNotice), recordResultNotice.slice(0, 30));

// ---- 消息中心：未读数与"已读/未读"必须联动（数字要真的动，不是画上去的）----
await cdp.evaluate(`(location.hash = '#/me/messages')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '消息中心' ? true : null`, 20_000, 200);
await waitFor(`document.querySelectorAll('.w-me-message-list__row').length > 0 ? true : null`, 15_000, 200);

const messageState = async () =>
  cdp.evaluate(
    `({
       rows: document.querySelectorAll('.w-me-message-list__row').length,
       unreadChips: [...document.querySelectorAll('.w-me-message-list__row .w-chip')].filter(
         (c) => c.innerText.trim() === '未读',
       ).length,
       tag: document.querySelector('.el-tag')?.innerText.trim() ?? '',
     })`,
    { awaitPromise: false },
  );
const unreadNumberIn = (tag) => {
  const m = /未读\s*(\d+)\s*条/.exec(tag);
  return m ? Number(m[1]) : 0;
};

const msgBefore0 = await messageState();
// 未读数是**另一个请求**：列表先到、未读数后到，读早了会拿到"读取中"（不是缺陷，是测试没等）
await waitFor(`/未读\\s*\\d+\\s*条|全部已读/.test(document.querySelector('.el-tag')?.innerText ?? '') ? true : null`, 15_000, 200);
const msgBefore = await messageState();
check('消息中心列出了 5 条消息', msgBefore.rows === 5, `rows=${msgBefore.rows}`);
check(
  '页头未读数与列表里"未读"的行数一致（不是各画各的）',
  unreadNumberIn(msgBefore.tag) === msgBefore.unreadChips,
  `tag=${msgBefore.tag} 未读行=${msgBefore.unreadChips}`,
);

const clickedUnread = await cdp.evaluate(
  `(() => {
     const row = [...document.querySelectorAll('.w-me-message-list__row')].find(
       (r) => r.querySelector('.w-chip')?.innerText.trim() === '未读',
     );
     const hit = row?.querySelector('.w-me-message-list__hit');
     if (!hit) return false;
     hit.click();
     return true;
   })()`,
  { awaitPromise: false },
);
await sleep(1000);
const msgAfterOne = await messageState();
check(
  '点一条未读：它变成已读，且未读数跟着减一',
  clickedUnread === true &&
    msgAfterOne.unreadChips === msgBefore.unreadChips - 1 &&
    unreadNumberIn(msgAfterOne.tag) === unreadNumberIn(msgBefore.tag) - 1,
  `${msgBefore.tag}(${msgBefore.unreadChips}) → ${msgAfterOne.tag}(${msgAfterOne.unreadChips})`,
);

await clickByText('全部已读');
await sleep(1000);
const msgAllRead = await messageState();
check('「全部已读」之后未读归零', msgAllRead.unreadChips === 0 && /全部已读/.test(msgAllRead.tag), `tag=${msgAllRead.tag} 未读行=${msgAllRead.unreadChips}`);

// 消息详情：一进门就把这条标已读（副作用失败要静默，不能挡住正文）
await cdp.evaluate(`(location.hash = '#/me/messages/MSG-20260105-001')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '消息详情' ? true : null`, 20_000, 200);
await waitFor(`document.querySelectorAll('.w-kv__label').length >= 6 ? true : null`, 15_000, 200);
const msgDetail = await cdp.evaluate(
  `(() => {
     const panel = document.querySelector('.w-kv');
     const cells = panel ? [...panel.children] : [];
     const out = {};
     cells.forEach((el, index) => {
       if (!el.classList.contains('w-kv__label')) return;
       const next = cells[index + 1];
       out[el.innerText.trim()] = next ? next.innerText.trim() : '';
     });
     return out;
   })()`,
  { awaitPromise: false },
);
check('消息详情显示标题与正文', /系统维护通知/.test(msgDetail['标题'] ?? ''), `标题=${msgDetail['标题']}`);
check('正文不是空的（真的读了服务端字段）', (msgDetail['正文'] ?? '').length > 10, `正文长度=${(msgDetail['正文'] ?? '').length}`);
check('关联对象缺失时有兜底说法（不画一行空白）', typeof msgDetail['关联对象'] === 'string' && msgDetail['关联对象'] !== '', `关联对象=${msgDetail['关联对象']}`);

// 清空消息：二次确认 + 只清当前收件人
await cdp.evaluate(`(location.hash = '#/me/messages')`, { awaitPromise: false });
await waitFor(`document.querySelectorAll('.w-me-message-list__row').length > 0 ? true : null`, 20_000, 200);
await clickByText('清空消息');
await sleep(400);
await clickByText('清空');
await sleep(1200);
const msgCleared = await messageState();
check('「清空消息」之后列表为空', msgCleared.rows === 0, `rows=${msgCleared.rows}`);
check('并且给出空态说法（不是一片空白）', (await text('.w-empty')).length > 4, (await text('.w-empty')).slice(0, 40));

// ---- 用户管理：1 基分页 + 建号 + 明细 + 重置密码 + 带验证码删除 ----
/** 按正则点按钮（弹窗优先、只点可见的），用于"文案可能微调"的主操作按钮。 */
const clickByLabel = (pattern) =>
  cdp.evaluate(
    `(() => {
       const re = new RegExp(${JSON.stringify(pattern)});
       const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
       const pick = (root) =>
         [...root.querySelectorAll('button')].find((b) => re.test(b.innerText.trim()) && visible(b));
       const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find(visible);
       const btn = (dialog ? pick(dialog) : null) ?? pick(document);
       if (!btn || btn.disabled) return false;
       btn.click();
       return true;
     })()`,
    { awaitPromise: false },
  );

/** 往指定 id 的输入框写值（走原生 setter + input 事件，Vue 才收得到）。 */
const setInputById = (id, value) =>
  cdp.evaluate(
    `(() => {
       const input = document.getElementById(${JSON.stringify(id)});
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    { awaitPromise: false },
  );

/** 在某个范围内按 placeholder 写值（范围默认内容区，弹窗里的要显式传 '.el-dialog'）。 */
const setInputByPlaceholder = (placeholder, value, scope = '.w-content') =>
  cdp.evaluate(
    `(() => {
       const input = [...document.querySelectorAll(${JSON.stringify(scope)} + ' input')].find(
         (i) => i.getAttribute('placeholder') === ${JSON.stringify(placeholder)},
       );
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    { awaitPromise: false },
  );

await cdp.evaluate(`(location.hash = '#/me/users')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '用户管理' ? true : null`, 20_000, 200);
await waitFor(`document.querySelectorAll('.w-me-user-list__row').length === 6 ? true : null`, 15_000, 200);
check('用户列表 6 位', (await cdp.evaluate(`document.querySelectorAll('.w-me-user-list__row').length`, { awaitPromise: false })) === 6);
check(
  '页头总数来自 UserPageDTO.total',
  /共 6 位用户/.test(await text('.w-page-header__note')),
  await text('.w-page-header__note'),
);

await clickByLabel('^新增$');
await sleep(500);
await clickByLabel('^保存$');
await sleep(700);
const createUserError = await text('.w-me-user-list__error');
check('建号必填校验（四个字段都要填）', /都要填写|至少 6 位/.test(createUserError), createUserError.slice(0, 40));

await setInputById('w-me-user-list-username', 'smoke-user');
await setInputById('w-me-user-list-nickname', '冒烟测试员');
await setInputById('w-me-user-list-password', 'abcdef');
await setInputById('w-me-user-list-email', 'smoke@wise.local');
await sleep(300);
await clickByLabel('^保存$');
await sleep(1400);
check(
  '建号之后列表真的多了一行（服务端写进去了）',
  (await cdp.evaluate(`document.querySelectorAll('.w-me-user-list__row').length`, { awaitPromise: false })) === 7,
);
check('新账号出现在首位（按创建时间倒序）', /smoke-user/.test(await text('.w-me-user-list__row')), (await text('.w-me-user-list__row')).slice(0, 40));
check('页头总数同步变成 7', /共 7 位用户/.test(await text('.w-page-header__note')), await text('.w-page-header__note'));

/*
 * 给假桥装一个"记录调用"的壳。
 *
 * 为什么值得留着：`useResource(..., { enabled: 某个当场求值的布尔表达式 })` 这类写法**不报错也不转圈** ——
 * 界面只稳定显示一句空态文案（"资料暂时取不到"），看起来像后端没数据，
 * 但真相是**一次请求都没发**。实测踩过一次（用户管理点行后 `user.detail`/`user.roles` 全没发）。
 * 有了这份调用记录，这类"静默不取数"就能被断言抓住，而不是靠人盯界面。
 */
await cdp.evaluate(
  `(() => {
     const m = window.__bridgeMock;
     if (!m.__wrapped) {
       const orig = m.call.bind(m);
       m.__calls = [];
       m.call = (method, params) => {
         m.__calls.push(method + ':' + JSON.stringify(params ?? null));
         return orig(method, params);
       };
       m.__wrapped = true;
     }
     m.__calls.length = 0;
     return true;
   })()`,
  { awaitPromise: false },
);
await cdp.evaluate(`document.querySelector('.w-me-user-list__row button')?.click()`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-me-user-list__kvlabel') ? true : null`, 15_000, 200);
const callsAfterRowClick = await cdp.evaluate(
  `JSON.stringify(window.__bridgeMock?.__calls ?? [])`,
  { awaitPromise: false },
);
check(
  '点行之后真的发出了详情与角色两次请求（enabled 没被写成常量）',
  /user\.detail/.test(callsAfterRowClick) && /user\.roles/.test(callsAfterRowClick),
  callsAfterRowClick,
);
const userDetailPairs = await cdp.evaluate(
  `(() => {
     const out = {};
     const labels = [...document.querySelectorAll('.w-me-user-list__kvlabel')];
     labels.forEach((dt) => {
       const dd = dt.nextElementSibling;
       out[dt.innerText.trim()] = dd ? dd.innerText.trim() : '';
     });
     return out;
   })()`,
  { awaitPromise: false },
);
check('明细显示刚建的账号与邮箱', userDetailPairs['账号'] === 'smoke-user' && /smoke@wise.local/.test(userDetailPairs['邮箱'] ?? ''), JSON.stringify(userDetailPairs));
check('没有角色时说清"谁来指派"（不是一片空白）', /还没有分配角色/.test(await text('.w-me-user-list__card')), (await text('.w-me-user-list__card')).slice(-40));

// 重置密码：不可逆地影响他人登录 → 二次确认
await clickByLabel('^重置密码$');
await sleep(500);
await setInputById('w-me-user-list-oldpw', 'whatever');
await setInputById('w-me-user-list-newpw', 'abcdefgh');
await setInputById('w-me-user-list-confirmpw', 'abcdefgh');
await sleep(300);
await clickByLabel('确认改密码');
await sleep(1200);
check(
  '重置密码后给出"当面告知"的说法',
  /密码已改好/.test(await text('.w-me-user-list__card')),
  (await text('.w-me-user-list__card')).slice(-30),
);

// 删除用户：没有验证码不许删（这条是真实的闸门，不是装饰）
await clickByLabel('^删除用户$');
await sleep(600);
const deleteBlocked = await cdp.evaluate(
  `(() => {
     const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find((d) => d.offsetParent !== null);
     return { hasCaptcha: !!dialog?.querySelector('.w-captcha'), text: dialog?.innerText ?? '' };
   })()`,
  { awaitPromise: false },
);
check('删除用户要验证码（弹窗里有验证码字段）', deleteBlocked.hasCaptcha === true, JSON.stringify(deleteBlocked).slice(0, 80));
const deletedWithoutCode = await clickByLabel('^删除$');
await sleep(800);
const deleteGate = await cdp.evaluate(
  `(() => {
     const dialog = [...document.querySelectorAll('.el-dialog')].reverse().find((d) => d.offsetParent !== null);
     return {
       stillOpen: !!dialog,
       err: dialog?.querySelector('.w-me-user-list__error')?.innerText.trim() ?? '',
       rows: document.querySelectorAll('.w-me-user-list__row').length,
     };
   })()`,
  { awaitPromise: false },
);
check(
  '没填验证码时不删除，并就地说明要填验证码',
  deleteGate.err.includes('验证码') && deleteGate.rows === 7,
  `clicked=${deletedWithoutCode} err=${deleteGate.err} rows=${deleteGate.rows}`,
);

await setInputByPlaceholder('验证码', '13', '.el-dialog');
await sleep(300);
await clickByLabel('^删除$');
await sleep(1400);
check(
  '填了验证码就删掉了，列表回到 6 位',
  (await cdp.evaluate(`document.querySelectorAll('.w-me-user-list__row').length`, { awaitPromise: false })) === 6,
);

/*
 * 侧栏账号区的回归护栏：`refresh()` 曾经用 `cache.invalidate('user')` 做失效，
 * 那个前缀会连 `user.current` 一起删掉 —— 而资源层不会因为失效自动重取，
 * 于是左下角的名字/职位会掉回会话语义并**一直回不来**。这条断言盯着它。
 */
await clickByLabel('^刷新$');
await sleep(1200);
const sidebarAccount = await cdp.evaluate(
  `({
     name: document.querySelector('.w-sidebar__account-name')?.innerText.trim() ?? '',
     role: document.querySelector('.w-sidebar__account-role')?.innerText.trim() ?? '',
   })`,
  { awaitPromise: false },
);
check('列表刷新不会把侧栏账号区的名字/职位弄丢', sidebarAccount.name === '现场操作员' && sidebarAccount.role !== '', JSON.stringify(sidebarAccount));

// ---- 个人资料：三块数据与三个写操作各自独立 ----
await cdp.evaluate(`(location.hash = '#/me/profile')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '个人资料' ? true : null`, 20_000, 200);
await waitFor(`document.querySelectorAll('.w-section__title').length >= 4 ? true : null`, 15_000, 200);
const profileSections = await cdp.evaluate(
  `[...document.querySelectorAll('.w-section__title')].map((n) => n.innerText.trim())`,
  { awaitPromise: false },
);
check('个人资料分区齐全（基本资料/登录账号/偏好设置/登录密码）', ['基本资料', '登录账号', '偏好设置', '登录密码'].every((t) => profileSections.includes(t)), profileSections.join('/'));

await clickByLabel('修改资料');
await sleep(500);
await setInputByPlaceholder('显示给同事看的名字', '张现场');
await setInputByPlaceholder('如：name@example.com', 'zhang@wise.local');
await sleep(300);
await clickByLabel('^保存$');
await sleep(1200);
const profileNoticeText = await cdp.evaluate(
  `[...document.querySelectorAll('.w-me-profile__muted, .w-me-profile__hint')].map((n) => n.innerText.trim()).join(' | ')`,
  { awaitPromise: false },
);
check('改资料成功并给出反馈', /资料已更新/.test(profileNoticeText), profileNoticeText.slice(0, 40));

await clickByLabel('修改偏好');
await sleep(500);
const prefFilled = await cdp.evaluate(
  `(() => {
     const input = [...document.querySelectorAll('.w-content input')].find((i) =>
       (i.getAttribute('placeholder') ?? '').includes('输入新的取值'),
     );
     if (!input) return false;
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'dark');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return true;
   })()`,
  { awaitPromise: false },
);
check('偏好项能编辑（每项都是一个可改的输入框）', prefFilled === true);
await clickByLabel('^保存$');
await sleep(1200);
const prefNoticeText = await cdp.evaluate(
  `[...document.querySelectorAll('.w-me-profile__muted, .w-me-profile__hint')].map((n) => n.innerText.trim()).join(' | ')`,
  { awaitPromise: false },
);
check('保存偏好设置后给的是"保存后的结果"', /偏好设置已保存/.test(prefNoticeText), prefNoticeText.slice(0, 40));

/*
 * 顺序要紧：主按钮上挂的是"**本地校验通过后**才弹确认框"（React 也是这个顺序）。
 * 先点按钮再填字段，会先吃到一句「请先填写当前正在用的密码」——那是测试的错，不是界面坏了。
 */
await setInputById('w-me-profile-oldpw', 'whatever');
await setInputById('w-me-profile-newpw', 'abcdefgh');
await setInputById('w-me-profile-confirmpw', 'abcdefgh');
await sleep(300);
await clickByLabel('修改登录密码');
await sleep(500);
const clickedPwConfirm = await clickByLabel('^确认修改$');
await sleep(1200);
const pwNoticeText = await cdp.evaluate(
  `[...document.querySelectorAll('.w-me-profile__muted, .w-me-profile__hint')].map((n) => n.innerText.trim()).join(' | ')`,
  { awaitPromise: false },
);
check('改密码成功并提示下次用新密码', /登录密码已更新/.test(pwNoticeText), pwNoticeText.slice(0, 40));

/*
 * ---- 会话过期：必须**自己**跳回登录屏，并说明原因 ----
 *
 * 这条盯的是"用户正停在某一屏上、会话在背后失效"这个场景：
 * 路由守卫只在导航时才跑，如果没人主动跳，界面会继续画上一份数据、后续操作一个个报错，
 * 用户看到的是"点哪都没反应"。
 *
 * 测试里**不做任何导航** —— 点完开关就等着，看它是不是自己回登录屏。
 * （`expireSession()` 是假桥的开发态开关：真宿主在令牌失效时推同样的事件 `session.expired`。）
 */
await cdp.evaluate(`(location.hash = '#/inventory/inventory')`, { awaitPromise: false });
await waitFor(`document.querySelector('.w-page-header__title')?.innerText === '库存查询' ? true : null`, 20_000, 200);
await cdp.evaluate(`(window.__bridgeMock.expireSession(), true)`, { awaitPromise: false });
const autoBackToLogin = await waitFor(`location.hash.includes('/login') ? true : null`, 15_000, 200);
check('会话过期后**自动**回到登录屏（不用用户点任何东西）', autoBackToLogin === true, `hash=${await cdp.evaluate(`location.hash`, { awaitPromise: false })}`);
const expiredTip = await text('.w-login__expired');
check(
  '登录屏说明"为什么被踢出来"（不是静默跳转）',
  /登录已过期/.test(expiredTip),
  expiredTip.slice(0, 40),
);
check('过期后历史里不留痕（用 replace 而不是 push）', await cdp.evaluate(`!history.state?.back?.includes?.('inventory')`, { awaitPromise: false }));

// 收尾：重新登录一次，证明过期只是"要求重新登录"，不是把账号锁死
await ensureSignedIn();
check('过期后能重新登录', await cdp.evaluate(`location.hash.includes('/login') === false`, { awaitPromise: false }));

check('页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\n合计 ${checks.length - failed.length}/${checks.length} 通过`);

cdp.close();
chrome.stop();
await server.close();
process.exit(failed.length === 0 ? 0 : 1);
