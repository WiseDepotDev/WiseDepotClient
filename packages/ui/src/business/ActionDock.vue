<script setup lang="ts">
/**
 * 动作坞：页面主/次操作。
 *
 * 存在的理由是**修掉旧实现的真实缺陷**：旧 `BottomActionBar` 是全局 `fixed`，
 * 会遮挡手机底栏、还会跨到桌面侧栏上（findings.md 已记录）。
 * 这里手机端用 `sticky` + 底栏高度 + `env(safe-area-inset-bottom)`，
 * 桌面端回到静态布局（动作在页头，不再吸底）。
 */
</script>

<template>
  <div class="w-actiondock">
    <slot />
  </div>
</template>
