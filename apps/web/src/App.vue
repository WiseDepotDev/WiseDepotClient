<script setup lang="ts">
import { computed } from 'vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useBridgeStore } from '@wise/stores';

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
