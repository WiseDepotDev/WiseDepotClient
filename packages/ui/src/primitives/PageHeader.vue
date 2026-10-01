<script setup lang="ts">
/**
 * 页头：标题 + 真实上下文（数据来源 / 最后同步）+ 右侧动作。
 *
 * 与 AppBar 同时存在时，AppBar 只放全局动作 —— 两处都放标题是旧的返工点之一。
 */
defineProps<{
  readonly title: string;
  /** 副标题只承载**真实**上下文；没有就不传。 */
  readonly note?: string | undefined;
}>();
</script>

<template>
  <header class="w-page-header">
    <div class="w-page-header__titles">
      <h1 class="w-page-header__title">{{ title }}</h1>
      <p v-if="note" class="w-page-header__note">{{ note }}</p>
    </div>
    <div class="w-page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>
