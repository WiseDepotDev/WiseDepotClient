<script setup lang="ts">
import { ElButton, ElDialog } from 'element-plus';
import { watch } from 'vue';

/**
 * 危险/终态操作的二次确认。
 *
 * 三条可用性要求都实现在这里（因此 25 个屏不必各写一遍）：
 *  1. **焦点圈闭**：交给 `ElDialog`（内部用 focus-trap）；
 *  2. **Esc 关闭**：`close-on-press-escape` 默认开，走 cancel 语义而不是"什么都不发生"；
 *  3. **关闭后焦点回到打开它的那个元素**：自己记 `document.activeElement`。
 *     现场大量操作靠键盘/扫码枪，焦点丢了就等于"下一步输入跑到不知道哪里去了"。
 *
 * 正文用默认插槽而不是属性：有些确认框要带输入（例如"忽略原因"），属性塞不下。
 */
const props = defineProps<{
  readonly show: boolean;
  readonly title: string;
  readonly text?: string | undefined;
  readonly confirmText?: string | undefined;
  readonly cancelText?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly pending?: boolean | undefined;
}>();

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>();

let opener: HTMLElement | null = null;

watch(
  () => props.show,
  (show) => {
    if (show) {
      const active = document.activeElement;
      opener = active instanceof HTMLElement ? active : null;
      return;
    }
    opener?.focus();
    opener = null;
  },
);
</script>

<template>
  <ElDialog
    :model-value="show"
    :title="title"
    width="var(--w-size-dialog-max-width)"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    @update:model-value="(v: boolean) => { if (!v) emit('cancel'); }"
  >
    <p v-if="text" class="w-confirm__text">{{ text }}</p>
    <slot />

    <template #footer>
      <ElButton size="large" :disabled="pending" @click="emit('cancel')">{{ cancelText ?? '取消' }}</ElButton>
      <ElButton
        size="large"
        :type="danger ? 'danger' : 'primary'"
        :loading="pending"
        :disabled="pending"
        @click="emit('confirm')"
      >
        {{ confirmText ?? '确定' }}
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.w-confirm__text {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>
