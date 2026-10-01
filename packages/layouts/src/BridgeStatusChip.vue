<script setup lang="ts">
import { computed } from 'vue';
import { ElTooltip } from 'element-plus';
import { useBridgeStore } from '@wise/stores';
import { StatusChip } from '@wise/ui';
import type { StatusTone } from '@wise/ui';

/**
 * 桥状态芯片（顶栏右上角）。
 *
 * ## 主文案是**耗时**，不是"正常"
 *
 * 用户的要求：右上角把"正常"换成延迟，延迟不好使就显示"异常"。所以：
 *   · 探测成功且有耗时 → 直接显示 `18ms`（桌面档前面带个 `Bridge · ` 前缀）
 *   · 拿不到耗时（探测失败 / 没探测过 / 传输层断开）→ 显示**真实原因**（异常 / 检测中 / 已断开…）
 *
 * 这样做的道理：**"正常"是零信息量的**（正常的时候没人需要读它），
 * 而数字既是"活着"的证据，又能反映链路质量；反过来，数字不见了本身就说明有问题，
 * 这时才需要用文字说明出了什么事。
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
 *
 * 开发态假桥必须能自证身份（`假桥 124ms`）：数字是真的地方不可冒充，
 * 否则"开发态一切正常、真机上才知道"这类偏差会一直藏在这里。
 */
const props = withDefaults(
  defineProps<{
    /** 手机情景头里空间紧张：去掉 `Bridge · ` 前缀，只留数字/原因。 */
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
  const ms = bridge.latencyMs;
  const isMock = bridge.kind === 'mock';

  // 有耗时就说耗时 —— 这是主文案
  if (status === 'ok' && ms !== undefined) {
    const value = isMock ? `假桥 ${ms}ms` : `${ms}ms`;
    return props.compact ? value : `Bridge · ${value}`;
  }

  /*
   * 拿不到耗时 = "不好使"，这时才用文字。
   *
   * 用户的判断很直接：正常的时候显示延迟，不好使就显示"异常"。所以这里用**短词** ——
   * 完整原因（"与本地服务的连接已断开"/"本地服务探测失败"）与错误码留在 tooltip 里，
   * 手机顶栏放不下那样的整句。
   */
  const word =
    isMock && status === 'ok'
      ? '假桥'
      : status === 'down'
        ? '异常'
        : status === 'degraded'
          ? '重连中'
          : status === 'ok'
            ? '异常' // 探测说成功却没拿到耗时：那同样是"不好使"，不能显示一个没有数字的"正常"
            : '检测中';
  return props.compact ? word : `Bridge · ${word}`;
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
