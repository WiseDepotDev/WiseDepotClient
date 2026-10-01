<script setup lang="ts">
import type { MetricItem } from '../types';

/**
 * 指标区。
 *
 * **只渲染传进来的真实 KPI**：这里没有"较昨日 +18%"、没有迷你趋势线、
 * 没有同比环比 —— 那些都需要历史数据链路，而本仓没有。
 * 想加一个指标，先把 DTO 拿出来。
 */
defineProps<{ readonly items: readonly MetricItem[] }>();
</script>

<template>
  <div class="w-metrics">
    <article v-for="item in items" :key="item.key" class="w-metric">
      <div>
        <div class="w-metric__label">{{ item.label }}</div>
        <div class="w-metric__value">{{ item.value }}</div>
        <div v-if="item.note" class="w-metric__note">{{ item.note }}</div>
      </div>
      <span class="w-metric__mark" :class="`w-chip--${item.tone ?? 'neutral'}`" aria-hidden="true" />
    </article>
  </div>
</template>
