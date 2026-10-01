<script setup lang="ts">
import { ElButton } from 'element-plus';
import type { UiError } from '../types';
import { errorTextOf } from '../types';

/**
 * 四态宿主：**加载 / 空 / 错 / 内容**，互斥且穷尽。
 *
 * 为什么要有它：任何取数容器都必须能画出这四种状态，而让 25 个屏各写一遍的结果
 * 就是"有的屏转圈、有的屏空着、有的屏把错误吞掉"。这里把四态钉成一个组件，
 * 屏只负责"内容态长什么样"。
 *
 * 两条刻意的选择：
 *  · **加载态用骨架不用转圈**：转圈传达不了"将要出现什么"；
 *  · **错误态露出等宽错误码**：错误码是用户排障时唯一能念出来的证据。
 */
const props = withDefaults(
  defineProps<{
    readonly loading?: boolean | undefined;
    readonly error?: UiError | null | undefined;
    readonly empty?: boolean | undefined;
    /** 骨架形状：列表行 / 卡片 / 详情块。 */
    readonly skeleton?: 'list' | 'card' | 'detail' | undefined;
    readonly emptyText?: string | undefined;
    readonly retryText?: string | undefined;
    /**
     * 覆盖错误文案。
     *
     * 桥只给 `code` / `messageKey`，**文案在展示侧映射**（「谁展示谁拥有」）。
     * 数据层提供了更细的 `humanize()`，比这里的通用表更准；数据层给了就用它的。
     */
    readonly errorText?: string | undefined;
  }>(),
  {
    loading: false,
    error: null,
    empty: false,
    skeleton: 'list',
    emptyText: '没有符合条件的数据',
    retryText: '重试',
    errorText: undefined,
  },
);

const emit = defineEmits<{ (e: 'retry'): void }>();

/** 骨架行数按形状给：列表 5 行、卡片 4 张、详情 3 块。 */
const skeletonRows = props.skeleton === 'card' ? 4 : props.skeleton === 'detail' ? 3 : 5;
</script>

<template>
  <div class="w-state">
    <div v-if="loading" class="w-skeleton" role="status" aria-busy="true">
      <div v-for="i in skeletonRows" :key="i" class="w-skeleton__row" />
    </div>

    <div v-else-if="error" class="w-error" role="alert">
      <span class="w-error__text">{{ errorText ?? errorTextOf(error) }}</span>
      <span class="w-error__code">{{ error.code }}</span>
      <div>
        <ElButton size="large" @click="emit('retry')">{{ retryText }}</ElButton>
      </div>
    </div>

    <div v-else-if="empty" class="w-empty">
      <span>{{ emptyText }}</span>
      <slot name="empty-action" />
    </div>

    <slot v-else />
  </div>
</template>
