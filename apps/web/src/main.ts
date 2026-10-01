import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { useBridgeStore, useSessionStore } from '@wise/stores';

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
 *   └ 成功 → attach 桥 → 等 session 首次结算 → router.isReady → 挂载
 * ```
 *
 * 为什么 **先等会话结算再挂载**：如果挂载后才读会话，会话门会先放行（还在 loading），
 * 等它结算出"未登录"时路由已经不跳了 —— 用户会停在首页空壳上，而不是登录屏。
 * 把等待放在挂载之前，路由守卫拿到的永远是**已结算**的会话。
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
  app.use(router);

  const bridgeStore = useBridgeStore(pinia);
  bridgeStore.attach(result.bridge, result.origin);
  // 起实时健康探测：顶栏的"Bridge · 正常 · 11ms"每 10 秒自己刷新，
  // 且探测失败会把状态打成"异常"（不会因为上次成功而继续显示正常）
  bridgeStore.startProbe();

  const session = useSessionStore(pinia);
  await session.init();

  await router.isReady();
  app.mount('#app');
}

void start();
