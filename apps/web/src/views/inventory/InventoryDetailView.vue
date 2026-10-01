<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import InventoryDetailPanel from './InventoryDetailPanel.vue';

/**
 * 库存详情**屏**（`inventory.detail`）—— 薄壳。
 *
 * 内容全在 `InventoryDetailPanel` 里：那一份既能当独立路由屏，
 * 也能在桌面宽屏下当主从右栏（列表屏把选中的 id 传给它）。
 * 这里只做一件事：**把路由参数解析成 id**（路由参数是字符串袋，要转成正整数）。
 */
const route = useRoute();

const inventoryId = computed<number | undefined>(() => {
  const raw = route.params.inventoryId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
</script>

<template>
  <InventoryDetailPanel :inventory-id="inventoryId" />
</template>
