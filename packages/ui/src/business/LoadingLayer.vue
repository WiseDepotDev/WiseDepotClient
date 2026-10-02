<script setup lang="ts">
/**
 * 详情加载遮罩：**选中项换了一条、数据还没回来**时盖住整块详情。
 *
 * ## 为什么要有它
 *
 * 现场反馈：宽档主从里点一行，右栏如果还留着上一条的内容，看着就像"点了没反应"；
 * 更糟的是请求卡在"刚从后台回来"那一瞬间时，右栏能长时间停在旧内容上 ——
 * 用户没法区分"没点上"、"取数中"和"坏了"。盖一层转圈，至少把"正在取这一条"说明白。
 *
 * ## 三条刻意的边界
 *
 * 1. **只在"这一条还没有任何数据"时盖**：传进来的 `loading` 语义已经是
 *    "首次取数、无数据可显示"（见 `useResource` 的 `loading`）。
 *    每 5 秒一次的后台刷新**不盖** —— 否则右栏每 5 秒闪一次，
 *    比"内容晚半秒"难受得多（那是 stale-while-revalidate 的刻意取舍）。
 * 2. 盖的是**面板自身的盒子**：宽档它就是右栏那一栏，手机档它就是整屏详情，
 *    所以同一个组件在两个断点都对，不需要各写一套。
 * 3. `role="status"` + `aria-busy`：读屏用户也能听到"正在加载"；
 *    `prefers-reduced-motion` 下转圈停下，但**遮罩still在** —— 不能退化成"没反应"。
 */
withDefaults(
  defineProps<{
    readonly show: boolean;
    readonly text?: string | undefined;
  }>(),
  { text: '正在加载…' },
);
</script>

<template>
  <Transition name="w-loading-fade">
    <div v-if="show" class="w-loading-layer" role="status" aria-busy="true">
      <span class="w-loading-layer__spinner" aria-hidden="true" />
      <span class="w-loading-layer__text">{{ text }}</span>
    </div>
  </Transition>
</template>
