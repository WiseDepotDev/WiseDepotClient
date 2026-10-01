import { createRouter, createWebHashHistory } from 'vue-router';
import { useSessionStore } from '@wise/stores';
import { appRoutes } from './routes.js';

/**
 * 路由实例 + 会话门。
 *
 * ## 为什么必须是 hash 模式
 *
 * 产物用 `base: './'` 加载，两种宿主（`app://wise`、`https://appassets.androidplatform.net`）
 * 都只按 web 目录映射路径。history 模式下访问 `/inventory/tags/ABC`：
 *   · 相对资源（`./assets/…`）会按深路径解析 → 404；
 *   · 宿主需要"找不到就回 index.html"的路由回退，而两个宿主都没实现，
 *     改它们等于改宿主进程模型（违反"本次只换 Web 层"）。
 * hash 模式两个问题同时消失。
 *
 * ## 路由 name = 桥方法 id
 *
 * `dashboard.summary` / `tag.byCode` 这种。屏请求导航时给的是同一个 id，
 * 因此"屏想去的屏"与"路由表里的屏"是同一个命名空间，不会两边各起一套名字。
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 不需要登录即可访问（登录页、改密页）。 */
    readonly public?: boolean;
    /** 开发工具页：不受会话门约束。 */
    readonly always?: boolean;
    readonly title?: string;
    readonly domain?: string;
    readonly method?: string;
    /** 推入的屏（详情）：壳要画返回、不画域内导航。 */
    readonly detail?: boolean;
    /** 占位屏上的说明文案。 */
    readonly note?: string;
  }
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: appRoutes,
});

/** 开发态路由自检：名字重复会让"点了没反应"或"跳错屏"，且构建不会发现。 */
if (import.meta.env.DEV) {
  const seen = new Set<string>();
  for (const record of router.getRoutes()) {
    const name = String(record.name ?? '');
    if (name === '') {
      continue;
    }
    if (seen.has(name)) {
      console.error(`[router] 路由 name 重复：${name} —— 后注册的会覆盖前一个`);
    }
    seen.add(name);
  }
}

/**
 * 会话门。
 *
 * 判据只有 `bridge.session`（桥里的真值）—— 这里不推断、不缓存布尔。
 * 入口已经等 `session.init()` 结算后才 `isReady()`，所以守卫拿到的永远是已结算状态。
 */
router.beforeEach((to) => {
  const session = useSessionStore();

  // 开发工具页不受会话门约束（`always` 是它唯一的标记）
  if (to.meta.always === true) {
    return true;
  }
  if (to.meta.public === true) {
    return session.authenticated ? { name: 'home' } : true;
  }
  if (!session.authenticated) {
    return { name: 'auth.login' };
  }
  if (session.passwordChangeRequired && to.name !== 'auth.password') {
    return { name: 'auth.password' };
  }
  return true;
});
