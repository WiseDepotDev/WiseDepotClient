<script setup lang="ts">
import { computed } from 'vue';
import { ElTooltip } from 'element-plus';
import { useBridgeStore } from '@wise/stores';
import { StatusChip } from '@wise/ui';
import type { StatusTone } from '@wise/ui';

/**
 * 桥状态芯片（顶栏右上角）：`Bridge · 正常 · 11ms`。
 *
 * ## 两条"必须真实"的要求，以及它们各自的落点
 *
 * 1. **耗时是实时的**：`bridgeStore` 每 10 秒真的调一次后端（`user.current`），
 *    量的是"桥转发 + 后端往返"的端到端耗时，取最近 5 次的中位数。
 *    不是"最后一次用户操作留下的旧值" —— 页面放着不动，数字也会自己更新。
 *    本地方法（`bridge.session`）刻意不计时：不经网络，混进来只会把数字压到 1ms 以下。
 * 2. **状态是真状态**：判据来自 `bridgeStore.health`，它把**传输层状态**与
 *    **最近一次探测结果**合起来看：
 *      · 传输层断开/重连中 → 直接是"已断开/重连中"，不会因为上次探测成功而显示正常；
 *      · 传输层正常但探测失败 → "异常"，并把错误码一起显示；
 *      · 还没探测过 → "检测中"，**不假装正常**。
 *    失败是**粘性**的：只有下一次探测成功才回到正常。
 *
 * 业务类拒绝（`AUTH-*` / `VAL-*` / 参数错误）**不算服务异常** —— 那说明请求走到了后端
 * 并被处理，把它们算成红灯才是"显示不真实"。
 */
const props = withDefaults(
  defineProps<{
    /** 手机情景头里空间紧张：只显示状态词，耗时留在 tooltip 里。 */
    readonly compact?: boolean | undefined;
  }>(),
  { compact: false },
);

const bridge = useBridgeStore();

const tone = computed<StatusTone>(() => {
  switch (bridge.health.status) {
    case 'ok':
      return 'success';
    case 'down':
      return 'danger';
    case 'degraded':
      return 'warning';
    default:
      return 'neutral';
  }
});

const text = computed(() => {
  const status = bridge.health.status;
  // 开发态假桥不能冒充真宿主；但"异常"永远优先于"假桥" —— 出问题就得看得见
  const word =
    status === 'ok' && bridge.kind === 'mock' ? '假桥' : bridge.health.reason;

  if (props.compact) {
    return word;
  }
  const ms = bridge.latencyMs;
  if (status !== 'ok' || ms === undefined) {
    return `Bridge · ${word}`;
  }
  return `Bridge · ${word} · ${ms}ms`;
});

const tip = computed(() => {
  const parts: string[] = [];
  parts.push(`最近 5 次后端请求往返耗时的中位数（含本地桥转发）：${bridge.latencyMs ?? '—'}ms`);
  parts.push(`每 10 秒自动测一次，页面不在前台时会暂停`);
  if (bridge.health.code !== undefined) {
    parts.push(`最近一次失败的错误码：${bridge.health.code}`);
  }
  if (bridge.kind === 'mock') {
    parts.push('当前是开发态假桥：数字来自假桥自身的模拟往返');
  }
  return parts.join('；');
});
</script>

<template>
  <ElTooltip :content="tip" placement="bottom">
    <StatusChip :text="text" :tone="tone" />
  </ElTooltip>
</template>
