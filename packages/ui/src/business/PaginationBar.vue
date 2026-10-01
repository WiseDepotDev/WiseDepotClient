<script setup lang="ts">
import { computed } from 'vue';
import { ElButton, ElPagination } from 'element-plus';
import { useViewport } from '../composables/useViewport';

/**
 * 分页条。
 *
 * 桌面出完整页码（操作员会跳页找单子），手机出"加载更多"（拇指够不到页码，且
 * 触控目标太小）。两者都用同一份 `page/pageSize/total`，只是呈现不同。
 *
 * 文案给出**范围语义**（共 N 条 · 第 x/y 页）而不是只给页码：
 * 现场常见的问题是"我到底还有没有下一页"。
 */
const props = defineProps<{
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly mode?: 'auto' | 'pager' | 'more' | undefined;
  readonly loading?: boolean | undefined;
}>();

const emit = defineEmits<{ (e: 'update:page', page: number): void }>();

const { isCompact } = useViewport();
const asMore = computed(() => props.mode === 'more' || ((props.mode ?? 'auto') === 'auto' && isCompact.value));
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))));
const hasMore = computed(() => props.page < pageCount.value);

/**
 * 分页器属性整块给。
 *
 * 为什么不逐个写：在 `packages/*` 里 `vue-tsc` 解析不到 EP 的 `buildProps` 结果类型，
 * `size="large"` 这类字面量会被当成"属性定义对象"校验而报错（同写在 apps/web 里是好的）。
 * v-bind 整块绕开单属性校验，运行期一样。
 */
const pagerProps = computed<any>(() => ({
  currentPage: props.page,
  pageSize: props.pageSize,
  total: props.total,
  disabled: props.loading === true,
  size: 'large',
  background: true,
  layout: 'prev, pager, next',
}));
</script>

<template>
  <div class="w-pagination">
    <span class="w-pagination__range">共 {{ total }} 条 · 第 {{ page }}/{{ pageCount }} 页</span>

    <ElButton
      v-if="asMore"
      size="large"
      :disabled="!hasMore || loading"
      :loading="loading"
      @click="emit('update:page', page + 1)"
    >
      {{ hasMore ? '加载更多' : '没有更多了' }}
    </ElButton>

    <ElPagination v-else v-bind="pagerProps" @current-change="(p: number) => emit('update:page', p)" />
  </div>
</template>

<style scoped>
.w-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--w-space-group-gap);
  flex-wrap: wrap;
  padding: var(--w-space-inline-gap) 0;
}

.w-pagination__range {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  font-variant-numeric: tabular-nums;
}
</style>
