<script setup lang="ts">
import Mono from '../primitives/Mono.vue';
import StatusChip from '../primitives/StatusChip.vue';
import type { KeyValueItem } from '../types';

/**
 * 详情字段面板。
 *
 * 规则：**只展示 DTO 里真实存在的字段**。取值为空的行直接不画 ——
 * 摆一行"安全库存：—"会让操作员以为这个字段是 0、或者系统丢了数据。
 */
defineProps<{ readonly items: readonly KeyValueItem[] }>();
</script>

<template>
  <dl class="w-kv">
    <template v-for="item in items" :key="item.key">
      <template v-if="item.value !== null && item.value !== undefined && item.value !== ''">
        <dt class="w-kv__label">{{ item.label }}</dt>
        <dd class="w-kv__value">
          <StatusChip v-if="item.tone" :text="item.value" :tone="item.tone" />
          <Mono v-else-if="item.mono" :text="item.value" />
          <template v-else>{{ item.value }}</template>
        </dd>
      </template>
    </template>
  </dl>
</template>
