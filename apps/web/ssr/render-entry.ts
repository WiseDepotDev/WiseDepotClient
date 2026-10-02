/**
 * Vue SSR 渲染检查的入口（由 `tools/check/check-vue-render.mjs` 用 Vite 的 `ssrLoadModule` 加载）。
 *
 * ## 它替代了什么
 *
 * V6 之前这条门禁测的是 **React 版**的外壳与 30 个屏（`tools/check/shell-render-entry.tsx`，
 * 用 `react-dom/server`）。React 版删掉之后，这条门禁的价值必须留下：
 * **在没有浏览器的前提下，客观证明"外壳与每一屏都渲染得出来"** ——
 * 渲染期崩溃（少判一个 undefined、模板里引用不存在的属性）是浏览器冒烟之外的另一种失败模式，
 * 而浏览器冒烟要跑几十秒、还要装 Chrome。
 *
 * ## 为什么不用 esbuild（React 版当初的做法）
 *
 * `.vue` 需要 SFC 编译，esbuild 单干不了；Spike A 当初的结论是"先 `vite build --ssr` 再执行"。
 * 这里走 Vite 的 `ssrLoadModule`：用的是**同一套解析器与同一份 vite.config**，
 * 样式导入由 Vite 兜住（SSR 下返回空模块），不必再维护一条构建产物的临时目录。
 *
 * ## 覆盖范围
 *
 * 1. **外壳**（`AppFrame`）：品牌、四域分组、命令栏、账号区 —— 断的是壳的结构标记。
 * 2. **注册表里的每一屏**（`SCREEN_REGISTRY` 的全部条目，28 个方法 id）：
 *    要求"渲染不抛异常 **且** 页头标题非空"。这一条能自动覆盖以后新增的屏，
 *    因为它读的是注册表本身，不是一份手抄的清单。
 *
 * 断的是**结构**不是数据：SSR 阶段 `useResource` 还没拿到数据（骨架/空态才是正确形态），
 * 数据的正确性由真后端与浏览器冒烟覆盖（`check:web-smoke`）。
 */
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useBridgeStore } from '@wise/stores';
import type { Bridge } from '@wise/bridge-client';
import { AppFrame } from '@wise/layouts';
import { SCREEN_REGISTRY } from '../src/views/registry.js';

/**
 * 假桥：实现 `Bridge` 接口且**不依赖 window**（SSR 里没有 window）。
 *
 * 能力表给全，是为了让"能力驱动的分支"走到**有**的那一侧 ——
 * 缺能力的分支（例如扫码枪不可用）在真机冒烟里覆盖。
 */
function fakeBridge(capabilities: readonly string[]): Bridge {
  return {
    kind: 'ws',
    platform: 'desktop',
    hostVersion: '1.0.0-ssr-check',
    capabilities,
    state: 'open',
    supports: (capability: string) => capabilities.includes(capability),
    call: <T,>() => Promise.resolve({} as T),
    subscribe: () => () => undefined,
    onStateChange: () => () => undefined,
    close: () => undefined,
  };
}

const CAPABILITIES = ['scan.gun.keyboard', 'scan.camera', 'nfc.read', 'window.control', 'print.system'];

/** 每屏的页头标题期望值。没有列到的屏只要求"标题非空"。 */
const EXPECTED_TITLES: Readonly<Record<string, string>> = {
  'dashboard.summary': '看板',
  'alert.list': '告警中心',
  'alert.detail': '告警详情',
  'inventory.list': '库存查询',
  'inventory.detail': '库存详情',
  'product.list': '商品管理',
  'warehouse.list': '仓库管理',
  'tag.list': '标签管理',
  'tag.detail': '标签详情',
  'stockOrder.list': '出入库单',
  'stockOrder.create': '新建出入库单',
  // 无参数进来时这一屏落的是「查询入口 + 空态」，标题就是「单据详情」
  // （带单号才是「出入库单详情 + 单号」——那是浏览器冒烟覆盖的形态）
  'stockOrder.detail': '单据详情',
  'device.list': '设备管理',
  'device.detail': '设备详情',
  'inspection.taskPage': '巡检任务',
  'inspection.taskDetail': '巡检任务详情',
  'inspection.taskCreate': '新建巡检任务',
  'inspection.resultList': '巡检结果',
  'inspection.resultCreate': '录入巡检结果',
  'inspection.manualRecord': '手动补录巡检明细',
  'message.list': '消息中心',
  'message.detail': '消息详情',
  'user.list': '用户管理',
  'profile.get': '个人资料',
};

export interface RenderCase {
  readonly name: string;
  readonly html: string;
  /** 期望出现在页头里的标题（`undefined` 表示只要求非空）。 */
  readonly expectedTitle: string | undefined;
  /** **必须出现**的结构标记（用于能力位驱动的分支）。 */
  readonly present?: readonly string[];
  /** **必须不出现**的结构标记（同上：证明"没这个能力就不画"）。 */
  readonly absent?: readonly string[];
}

/**
 * 渲染一个组件：每个用例都用**独立的 pinia + 独立的假桥**，
 * 免得前一个用例的缓存/状态把后一个用例"渲染成功"这件事变成假象。
 *
 * `capabilities` 可覆盖：能力位驱动的分支（相机扫码入口）要能**两边都渲染一次** ——
 * 只验"有入口"证明不了"没能力时不画入口"，而这一条正是本仓反复吃过的亏
 * （画出点了没反应的入口）。
 */
async function renderComponent(component: Component, capabilities: readonly string[] = CAPABILITIES): Promise<string> {
  const app = createSSRApp({ render: () => h(component) });
  const pinia = createPinia();
  app.use(pinia);
  setActivePinia(pinia);
  /*
   * Element Plus 在服务端渲染时**要求**这两个注入（否则每个用 id/z-index 的组件都会报警告：
   * `[IdInjection] Looks like you are using server rendering…`）。
   * 它们是"服务端生成稳定 id"的来源，跟数据无关，注入固定初值即可。
   */
  app.provide(ID_INJECTION_KEY, { prefix: 1000, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  useBridgeStore().attach(fakeBridge(capabilities), 'ssr-check');

  /*
   * 路由必须装上：屏里普遍用 `useRoute()` 取参数、`useRouter()` 做跳转。
   * 但**不把屏挂到路由上**（那是懒加载的、SSR 首帧还没解析完），而是直接渲染组件 ——
   * 路由只提供"当前路由对象"这个上下文。这样"无参数"的形态正是我们要断的那个首帧形态。
   */
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => h('div') } }],
  });
  app.use(router);
  await router.push('/');
  await router.isReady();

  return await renderToString(app);
}

/** 外壳 + 注册表里的每一屏。 */
export async function renderCases(): Promise<readonly RenderCase[]> {
  const cases: RenderCase[] = [];

  cases.push({
    name: 'AppFrame（桌面外壳）',
    html: await renderComponent(AppFrame as Component),
    expectedTitle: undefined,
    // 能力表给全（上面的 CAPABILITIES 里有 scan.camera）—— 入口必须真的画出来。
    // 用 `aria-label` 而不是可见文案：模板注释里也有"相机扫码"四个字（注释会被 SSR 输出）
    present: ['aria-label="相机扫码"'],
  });

  /*
   * 相机扫码入口的**反面**（B1/S2b3）。
   *
   * 这条用例存在的理由：入口是**能力位驱动**的 —— 有 `scan.camera` 才画。
   * 只渲染"有能力"那一面的话，"手机/无相机设备上多出一个点了没反应的按钮"这类回归
   * 只会在真机上被发现。这里把"没能力就一个字都不出现"变成构建期断言。
   */
  cases.push({
    name: 'AppFrame（无 scan.camera 能力）',
    html: await renderComponent(AppFrame as Component, ['scan.gun.keyboard']),
    expectedTitle: undefined,
    absent: ['aria-label="相机扫码"'],
  });

  for (const [method, loader] of Object.entries(SCREEN_REGISTRY)) {
    const loaded = (await loader()) as { default?: Component };
    if (loaded.default === undefined) {
      throw new Error(`注册表里的 ${method} 没有 default 导出（不是 SFC？）`);
    }
    cases.push({
      name: `${method}（${method}）`,
      html: await renderComponent(loaded.default),
      expectedTitle: EXPECTED_TITLES[method],
    });
  }

  return cases;
}
