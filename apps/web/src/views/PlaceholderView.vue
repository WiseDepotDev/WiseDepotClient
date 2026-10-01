<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import { useSessionStore } from '@wise/stores';
import { ActionDock } from '@wise/ui';

/**
 * 占位屏（**业务语言**）。
 *
 * **业务用户永远不该看到技术术语** —— 用户实测反馈过：页面直接显示方法 id 与
 * "W5–W7 逐域迁入"这类开发文案，给人的感知是"系统没做完/坏了"。
 * 所以这里只有业务口径的说明与一个明确动作（`check:ui-web` 会拦字面量）。
 *
 * 标题与说明从路由 meta 取（逐域迁入后，这个屏会被真实屏替换掉）。
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const title = computed(() => route.meta.title ?? '功能');
const note = computed(() => route.meta.note ?? '该页面正在上线中。');

function back(): void {
  if (session.authenticated) {
    void router.replace({ name: 'home' });
  }
}
</script>

<template>
  <div class="w-page">
    <div class="w-card">
      <h1 class="w-placeholder__title">{{ title }}</h1>
      <p class="w-placeholder__note">{{ note }}</p>
      <p class="w-placeholder__note">该功能正在上线中，暂时无法使用。如需使用，请联系管理员了解上线时间。</p>
    </div>
    <ActionDock>
      <ElButton size="large" @click="back">返回首页</ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-placeholder__title {
  margin: 0 0 var(--w-space-inline-gap);
  font-size: var(--w-type-page-title-size);
  font-weight: var(--w-type-page-title-weight);
}

.w-placeholder__note {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>
