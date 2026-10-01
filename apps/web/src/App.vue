<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useBridgeStore, useSessionStore } from '@wise/stores';

/**
 * 应用根：Element Plus 的全局配置（中文文案）+ 状态横幅。
 *
 * 主题**不在组件里**注入：Element Plus 走 `--el-*` CSS 变量，
 * 由 `packages/tokens/src/generated/theme.el.css`（从 theme.json 生成）统一给出。
 * 组件里再出现任何颜色字面量都会被 `check:theme` 拦下。
 *
 * `zhCn` 上的 `as never`：Element Plus 的 locale 属性类型与本项目开的
 * `exactOptionalPropertyTypes` 不兼容（它的可选属性不接受 undefined），
 * 而这个值在运行时就是 EP 官方的中文语言包，没有别的可能。
 */
const locale = zhCn as never;
const bridge = useBridgeStore();
const session = useSessionStore();
const router = useRouter();
const route = useRoute();

/**
 * **会话失效时主动回登录屏**（不是等用户点一下才跳）。
 *
 * 为什么必须在这里做：路由守卫只在**导航发生时**才跑。用户正停在某一屏上，
 * 桥推来 `session.expired` → 会话 store 重新问 `bridge.session` → 判定为未登录，
 * 但**没有任何导航发生**，于是界面会继续显示上一份数据、后续操作一个个报错，
 * 用户完全不知道发生了什么（现场最常见的反馈是"点哪都没反应"）。
 *
 * 这里 watch 的是"已登录 → 未登录"这个**跳变**：
 *   · 只处理跳变，不在首帧就把人踢走（首帧未登录是正常情况，由路由守卫处理）；
 *   · 登录屏 / 改密屏（`meta.always`）不动，避免"已经在登录屏还被 replace 一次"的死循环；
 *   · 用 `replace` 而不是 `push`：过期不是用户的一次导航，不该在历史里留痕 ——
 *     否则他按返回键又会回到那个需要登录的页面，再被踢回来。
 */
watch(
  () => session.authenticated,
  (nowAuthenticated, wasAuthenticated) => {
    if (nowAuthenticated || wasAuthenticated !== true) {
      return;
    }
    if (route.meta.always === true) {
      return;
    }
    void router.replace({ name: 'auth.login' });
  },
);

/**
 * 横幅只表达**真实状态**。判据与顶栏芯片同源（`bridge.health`）：
 * 传输层断开、或探测失败（后端不可达 / 超时 / 5xx）都会出现在这里。
 *
 * 刻意不做的事：不显示"延迟 11ms"这类数字（那是顶栏芯片的事，且它是实测的）。
 */
const banner = computed<{ text: string; tone: 'info' | 'warning' | 'danger' } | null>(() => {
  const status = bridge.health.status;
  if (status === 'down') {
    return {
      text: `${bridge.health.reason}${bridge.health.code ? `（${bridge.health.code}）` : ''}。请检查网络或服务状态；界面上的数据可能已经过期。`,
      tone: 'danger',
    };
  }
  if (status === 'degraded') {
    return { text: `${bridge.health.reason}…`, tone: 'warning' };
  }
  if (status === 'unknown') {
    return { text: `${bridge.health.reason}…`, tone: 'info' };
  }
  if (bridge.kind === 'mock') {
    return { text: '开发态假桥（当前没有宿主进程，数据为示例数据）', tone: 'info' };
  }
  return null;
});
</script>

<template>
  <ElConfigProvider :locale="locale">
    <div class="w-app">
      <div v-if="banner" class="w-app__banner" :class="`w-app__banner--${banner.tone}`" role="status">
        {{ banner.text }}
      </div>
      <RouterView />
    </div>
  </ElConfigProvider>
</template>

<style scoped>
.w-app {
  /* 高度由 styles/base.css 统一给（100dvh）—— 那里也写了为什么不能用 height:100% */
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--w-color-bg);
  color: var(--w-color-on-surface);
}

.w-app__banner {
  flex: 0 0 auto;
  padding: var(--w-space-inline-gap) var(--w-space-screen-h);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
  border-bottom: 1px solid var(--w-color-outline-subtle);
}

.w-app__banner--info {
  background: var(--w-state-info-fill);
  color: var(--w-state-info-text);
}

.w-app__banner--warning {
  background: var(--w-state-warning-fill);
  color: var(--w-state-warning-text);
}

.w-app__banner--danger {
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
}
</style>
