<script setup lang="ts">
/** 区块：小标题 + 内容。卡片**不嵌套**，需要分组就用它 + 分隔线。 */
defineProps<{ readonly title?: string | undefined }>();
</script>

<template>
  <section class="w-section">
    <h2 v-if="title" class="w-section__title">{{ title }}</h2>
    <slot />
  </section>
</template>
