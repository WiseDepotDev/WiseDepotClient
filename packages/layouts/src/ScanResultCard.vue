<script setup lang="ts">
import { ElButton } from 'element-plus';
import { useScanStore } from '@wise/stores';

/**
 * 扫码结果卡（手机端顶部浮层）。
 *
 * **只显示真实数据**：卡片上出现的唯一内容是扫码枪/相机给出的那个编码本身
 * （以及它被路由到了哪一支）。商品名、库存数那类摘要要等 `tag.byCode` 的 DTO
 * 在后续批次接线之后才能显示 —— 现在编不出来，也不该编。
 *
 * 现场价值：操作员扫完立刻知道"这一下被系统收到了"，而不是对着一动不动的屏幕怀疑枪坏了。
 */
const scan = useScanStore();
</script>

<template>
  <div v-if="scan.cardOpen && scan.last" class="w-scancard" role="status">
    <span class="w-scancard__label">
      {{ scan.last.route === 'screen' ? '已交给当前页面' : '正在打开该编码的标签详情' }}
    </span>
    <span class="w-scancard__code">{{ scan.last.code }}</span>
    <div class="w-scancard__actions">
      <ElButton size="small" text @click="scan.hideCard()">收起</ElButton>
    </div>
  </div>
</template>
