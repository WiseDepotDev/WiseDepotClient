<script setup lang="ts">
import { computed } from 'vue';
import { useBridgeStore, useSessionStore } from '@wise/stores';
import { StatusChip, type StatusTone } from '@wise/ui';

/**
 * 登录后的主框架占位（V1 的"空壳"）。
 *
 * ## 为什么是占位而不是先摆假看板
 *
 * 现场真机上已经付过一次学费：拿写死的行当内容充数，结果是**假数据比空栏更糟** ——
 * 操作员会照着假数据做判断。所以这里只画：
 *   · 真实的会话身份（来自 `bridge.session`）；
 *   · 真实的桥连接状态；
 *   · 四个域的上线状态（业务语言，不出现任何桥方法 id / 里程碑编号）。
 *
 * 各域页面在 V4 逐域迁入，迁一屏这里就少一句"上线中"。
 */
const bridge = useBridgeStore();
const session = useSessionStore();

const connectionText = computed(() => {
  switch (bridge.state) {
    case 'open':
      return '本地服务正常';
    case 'connecting':
    case 'idle':
      return '正在连接本地服务';
    case 'reconnecting':
      return '正在重连本地服务';
    case 'closed':
      return '本地服务已断开';
    default:
      return '未知';
  }
});

const connectionTone = computed<StatusTone>(() => (bridge.state === 'open' ? 'success' : 'warning'));

const domains = [
  { label: '概览', note: '看板与告警中心' },
  { label: '库存', note: '库存查询、商品、标签、出入库单、仓库' },
  { label: '现场', note: '巡检任务与设备管理' },
  { label: '管理', note: '消息、用户与个人设置' },
] as const;
</script>

<template>
  <main class="w-home">
    <header class="w-home__header">
      <div>
        <h1 class="w-home__title">慧仓智控 · 仓储作业平台</h1>
        <p class="w-home__sub">
          <span v-if="session.username">当前账号：{{ session.username }}</span>
          <span v-else>已登录</span>
        </p>
      </div>
      <div class="w-home__status">
        <StatusChip :text="connectionText" :tone="connectionTone" />
      </div>
    </header>

    <section class="w-home__notice">
      <h2 class="w-home__notice-title">功能上线中</h2>
      <p class="w-home__notice-text">
        客户端正在进行界面升级，主框架与登录已经可用，各业务页面正在陆续上线。如需使用尚未开放的页面，请联系管理员了解上线时间。
      </p>
    </section>

    <section class="w-home__grid">
      <article v-for="d in domains" :key="d.label" class="w-home__card">
        <h3 class="w-home__card-title">{{ d.label }}</h3>
        <p class="w-home__card-note">{{ d.note }}</p>
        <span class="w-home__card-badge">上线中</span>
      </article>
    </section>
  </main>
</template>

<style scoped>
.w-home {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-section-gap);
  width: 100%;
  max-width: var(--w-space-content-max-width);
  margin: 0 auto;
  padding: var(--w-space-screen-v) var(--w-space-screen-h);
}

.w-home__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--w-space-group-gap);
}

.w-home__title {
  margin: 0;
  font-size: var(--w-type-page-title-size);
  line-height: var(--w-type-page-title-line);
  font-weight: var(--w-type-page-title-weight);
}

.w-home__sub {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-home__notice {
  background: var(--w-state-info-fill);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-home__notice-title {
  margin: 0;
  font-size: var(--w-type-section-title-size);
  font-weight: var(--w-type-section-title-weight);
  color: var(--w-state-info-text);
}

.w-home__notice-text {
  margin: var(--w-space-inline-gap) 0 0;
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
  color: var(--w-state-info-text);
}

.w-home__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--w-space-group-gap);
}

.w-home__card {
  position: relative;
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-home__card-title {
  margin: 0;
  font-size: var(--w-type-section-title-size);
  font-weight: var(--w-type-section-title-weight);
}

.w-home__card-note {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-home__card-badge {
  display: inline-block;
  margin-top: var(--w-space-row-gap);
  padding: 2px var(--w-space-inline-gap);
  border-radius: var(--w-radius-chip);
  background: var(--w-state-neutral-fill);
  color: var(--w-state-neutral-text);
  font-size: var(--w-type-label-size);
}
</style>
