<script setup lang="ts">
/**
 * 引导失败屏。
 *
 * 原则：**用户看到的必须是"该怎么办"，不是"哪里坏了"**。
 * 引导文件、宿主进程、mock 回退这些只对开发者有意义，因此只进 DEV 分支。
 */
const props = defineProps<{
  readonly message: string;
  readonly detail: string;
}>();

const dev = import.meta.env.DEV;

function retry(): void {
  window.location.reload();
}
</script>

<template>
  <main class="w-bootfail">
    <div class="w-bootfail__card">
      <div class="w-bootfail__brand">慧仓智控 · WiseDepot</div>
      <p class="w-bootfail__message" role="alert">{{ props.message }}</p>
      <button class="w-bootfail__retry" type="button" @click="retry">重新打开</button>
      <p v-if="dev" class="w-bootfail__dev">dev: {{ props.detail }}（开发态由 pnpm dev 提供宿主或回退到 mock）</p>
    </div>
  </main>
</template>

<style scoped>
.w-bootfail {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow-y: auto;
  padding: var(--w-space-screen-h);
  background: var(--w-color-bg);
}

.w-bootfail__card {
  width: 100%;
  max-width: 420px;
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-bootfail__brand {
  font-size: var(--w-type-section-title-size);
  font-weight: var(--w-type-section-title-weight);
  margin-bottom: var(--w-space-group-gap);
}

.w-bootfail__message {
  margin: 0 0 var(--w-space-group-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}

.w-bootfail__retry {
  min-height: var(--w-space-touch-target-min);
  width: 100%;
  border: none;
  border-radius: var(--w-radius-control);
  background: var(--w-color-primary);
  color: var(--w-color-on-primary);
  font-size: var(--w-type-body-size);
  cursor: pointer;
}

.w-bootfail__dev {
  margin: var(--w-space-group-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  word-break: break-all;
}
</style>
