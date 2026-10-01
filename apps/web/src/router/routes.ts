import type { RouteRecordRaw } from 'vue-router';
import { DESTINATIONS, DOMAINS } from '@wise/layouts';
import { screenFor } from '../views/registry.js';

/**
 * 占位屏**也是懒加载的**：V4 之前所有未迁入的页都落到它，
 * 静态引入会把它（以及 @wise/ui 的动作坞）塞进首屏 chunk，白白吃掉预算。
 */
const PlaceholderView = (): Promise<unknown> => import('../views/PlaceholderView.vue');

/**
 * 路由表**由信息架构生成**，不手写。
 *
 * 这样"导航里有的目的地，路由里一定有"是**结构性**成立的，而不是靠人记得同步；
 * 反过来，导航模型里不存在的方法也进不来（`check:navigation` 会再核一遍路径冲突）。
 *
 * 两个必须在构建期定死的点：
 *
 * 1. **叶子必须排在目的地之前**。`/inventory/stock-orders/new`（叶子）与
 *    `/inventory/stock-orders/:orderId`（目的地）在语义上都匹配前者；
 *    顺序反了，用户点"新建出入库单"会打开"单据详情"。这一条由 smoke 里的
 *    行为断言钉住（不是靠注释）。
 * 2. **壳是懒加载的**。`AppFrame` 走 `() => import()`：登录页不需要背
 *    NMenu / NDrawer 这些只有进了主界面才用得到的东西（Spike C 的体积教训）。
 */

/** 去掉前导 `/`：作为父路由 `/` 的子路由时必须是相对路径。 */
const relative = (path: string): string => path.replace(/^\//, '');

const leafRoutes: RouteRecordRaw[] = DOMAINS.flatMap((domain) =>
  domain.children.map((leaf) => ({
    path: relative(leaf.path),
    name: leaf.primaryMethod,
    component: screenFor(leaf.primaryMethod) ?? PlaceholderView,
    meta: { title: leaf.label, domain: domain.id, method: leaf.primaryMethod },
  })),
);

const destinationRoutes: RouteRecordRaw[] = DESTINATIONS.map((dest) => ({
  path: relative(dest.path),
  name: dest.method,
  component: screenFor(dest.method) ?? PlaceholderView,
  meta: { title: dest.label, method: dest.method, detail: true },
}));

export const shellRoutes: RouteRecordRaw = {
  path: '/',
  component: () => import('@wise/layouts').then((m) => m.AppFrame),
  children: [
    {
      path: '',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
      meta: { title: '概览' },
    },
    ...leafRoutes,
    ...destinationRoutes,
  ],
};

export const standaloneRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'auth.login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/change-password',
    name: 'auth.password',
    component: () => import('../views/PlaceholderView.vue'),
    meta: { title: '修改密码', note: '管理员要求你先修改密码后才能继续使用。' },
  },
  // 组件预览：**只在开发态注册**（生产构建里这段被静态替换掉）
  ...(import.meta.env.DEV
    ? [
        {
          path: '/preview',
          name: 'preview',
          component: () => import('../views/PreviewView.vue'),
          meta: { public: true, always: true, title: '组件预览' },
        } satisfies RouteRecordRaw,
      ]
    : []),
];

export const appRoutes: RouteRecordRaw[] = [
  shellRoutes,
  ...standaloneRoutes,
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
];
