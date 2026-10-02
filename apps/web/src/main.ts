import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { useBridgeStore, useSessionStore, startAutoRefresh } from '@wise/stores';

import App from './App.vue';
import BootFailure from './views/BootFailure.vue';
import { boot } from './boot.js';
import { router } from './router/index.js';

import 'element-plus/theme-chalk/base.css';
import '@wise/tokens/theme.css';
// Element Plus 主题桥：必须在 element-plus 的 base.css 之后，才能覆盖默认的 --el-* 变量
import '@wise/tokens/theme.el.css';
import '@wise/ui/ui.css';
import '@wise/layouts/shell.css';
import './styles/base.css';

/**
 * 应用入口的启动顺序（**顺序本身是设计的一部分**）：
 *
 * ```
 * boot()（读 __bridge.json → 建桥）      ← 期间 index.html 里的静态"正在启动…"可见
 *   ├ 失败 → 挂 BootFailure（给"该怎么办"，架构细节只进 DEV）
 *   └ 成功 → attach 桥 → 等 session 首次结算 → use(router) → isReady → 挂载
 * ```
 *
 * **为什么 `app.use(router)` 必须排在 `await session.init()` 之后**（这条踩过，且症状极具误导性）：
 * `use(router)` 会**立刻发起首次导航**（vue-router 在 install 里 push 当前地址），
 * 而那时会话还没结算 —— 守卫拿到的是 `authenticated = false`，于是**即使本机令牌有效、
 * 宿主也真的恢复了登录态，用户还是会被送到登录屏**："记住登录"看起来完全没生效。
 * 之前的注释写着"挂载前等会话结算"，但真正触发导航的是 `use(router)` 而不是 `mount`，
 * 所以那句注释描述的意图并没有生效（真机实测：杀进程重开后落在 `#/login`，而宿主日志明确写着
 * 「已从本机恢复登录态」）。
 *
 * 把 `use(router)` 挪到会话结算之后，首次导航就发生在**已结算**的状态上：
 * 有令牌 → 直接进主界面；没令牌 / 已过期 → 进登录屏（若桥给了 `expired`，登录屏会说清原因）。
 */
const pinia = createPinia();

async function start(): Promise<void> {
  const result = await boot();

  if (result.phase === 'failed') {
    createApp(BootFailure, { message: result.message, detail: result.detail }).mount('#app');
    return;
  }

  const app = createApp(App);
  app.use(pinia);

  const bridgeStore = useBridgeStore(pinia);
  bridgeStore.attach(result.bridge, result.origin);
  // 起实时健康探测：顶栏的"Bridge · 11ms"每 10 秒自己刷新，
  // 且探测失败会把状态打成"异常"（不会因为上次成功而继续显示正常）
  bridgeStore.startProbe();

  /*
   * 起**自动刷新**：界面上已经没有任何手动刷新按钮，所有内容靠它保持最新 ——
   * 可见时每 15 秒一次，回到前台 / 重新聚焦 / 网络恢复各补一次。
   *
   * `onResume` 里先验活再让屏重取：半死的 WebSocket 不会回包，
   * 直接刷新会让每一屏都白等满调用超时 —— 那就是"后台挂久了回来右边内容卡住"。
   */
  startAutoRefresh({ onResume: () => bridgeStore.resumeAfterBackground() });

  // 先结算会话，再装路由（顺序见上面的注释：装路由 = 触发首次导航）
  const session = useSessionStore(pinia);
  await session.init();

  app.use(router);
  await router.isReady();
  app.mount('#app');
}

void start();
