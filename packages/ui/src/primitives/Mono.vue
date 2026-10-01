<script setup lang="ts">
/**
 * 等宽文本：单号 / 条码 / RFID 一律用它，保证纵向对齐、避免 0/O 误读。
 * 组件化而不是让各屏自己加 class，是为了让"哪些是机器数据"这件事可被 grep。
 */
defineProps<{ readonly text?: string | undefined }>();
</script>

<template>
  <span class="w-mono"><slot>{{ text }}</slot></span>
</template>
