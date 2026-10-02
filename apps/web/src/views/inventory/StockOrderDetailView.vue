<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import StockOrderDetailPanel from './StockOrderDetailPanel.vue';

/**
 * 单据详情屏（`stockOrder.detail`）—— 薄壳。
 *
 * 内容全在 `StockOrderDetailPanel` 里：那一份既能当独立路由屏，
 * 也能在桌面宽档下当主从右栏（单据列表把选中的那一张传给它）。
 *
 * 这里只做一件事：把路由参数解析成正整数单号。
 * 解析失败（缺参、空串、非数字、0）一律给 `undefined` —— 面板据此进空态，
 * 而不是拿一个解析坏的值去请求（`Number('')` 是 0，不判就会去查 0 号单据）。
 */
const route = useRoute();

const orderId = computed<number | undefined>(() => {
  const raw = route.params.orderId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
</script>

<template>
  <StockOrderDetailPanel :order-id="orderId" />
</template>
