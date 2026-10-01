<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { DOMAINS, type NavLeaf } from '@wise/layouts';
import { useBridgeStore, useSessionStore } from '@wise/stores';
import { PageHeader, SectionBlock, StatusChip, type StatusTone } from '@wise/ui';

/**
 * 应用中心（登录后的首页）。
 *
 * ## 它是什么，以及为什么长这样
 *
 * 这里是**所有功能的唯一入口**：每个一级功能一行，点进去就是一个子页面。
 * 分组与条目**直接来自信息架构**（`@wise/layouts` 的 `DOMAINS`），不手抄清单 ——
 * 手抄的清单一定会漂移，而漂移的方向永远是"中心里写着的功能其实点不到"。
 * 因此：加一个导航叶子，应用中心自动多一行；删掉一个，它也自动消失。
 *
 * **只列一级功能（导航叶子）**：像"告警详情""巡检结果详情"这类页面需要带参数
 * （哪一条？），只能从各自列表点进去 —— 把它们列在这里只会得到一堆点不开的入口。
 * 界面上明确写出这句话，而不是让用户去猜为什么"详情"不在列表里。
 *
 * 之前这里是个占位页（"功能上线中…各业务页面正在陆续上线"，四个域各挂一个"上线中"）。
 * 那些话在 29 屏全部迁完之后就是**过期信息**：明明能用的功能，界面上却说没上线。
 */
const bridge = useBridgeStore();
const session = useSessionStore();
const router = useRouter();

/**
 * 每个功能的**一句话说明**：说清"进去能干什么"。
 * 缺省退回域名（宁可少说，也不要编一句用户看不懂的）。
 */
const LEAF_NOTES: Readonly<Record<string, string>> = {
  'dashboard.summary': '库存总量、今日告警、巡检进度与设备在线的实时汇总',
  'alert.list': '处理告警：确认、忽略，并查看每一步的处理记录',
  'inventory.list': '按商品名查库存（跨页），按编码/货位筛本页，可锁定与解锁',
  'product.list': '商品主数据：新增、编辑、删除',
  'tag.list': '标签的绑定与解绑；批量操作需要验证码',
  'stockOrder.list': '出入库单的提交、撤回与审核；单内可增删明细',
  'warehouse.list': '仓库主数据：新增、编辑、删除',
  'inspection.planList': '排巡检计划：执行设备、定时表达式、启用或停用',
  'inspection.taskPage': '巡检任务的进度与结果入口；可开始、结束、改进度',
  'inspection.taskCreate': '按计划建一条巡检任务',
  'inspection.resultCreate': '把这次盘点的数量记到任务上（异常件数自动推导）',
  'inspection.manualRecord': '把漏扫的标签补录进已完成的巡检任务',
  'device.list': '设备在线、离线、故障与只读运行参数',
  'message.list': '设备告警、审批结果与任务提醒；标已读、清空',
  'user.list': '账号与基础资料：建号、重置密码、删除（需要验证码）',
  'profile.get': '账号信息、联系方式与安全设置',
};

/** 分组：域 → 它的一级功能。顺序就是侧栏顺序，不另排。 */
const groups = computed(() =>
  DOMAINS.map((domain) => ({
    id: domain.id,
    label: domain.label,
    leaves: domain.children.map((leaf: NavLeaf) => ({
      method: leaf.primaryMethod,
      label: leaf.label,
      path: leaf.path,
      note: LEAF_NOTES[leaf.primaryMethod] ?? `${domain.label}域的功能`,
    })),
  })),
);

const totalLeaves = computed(() => groups.value.reduce((n, g) => n + g.leaves.length, 0));

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

function open(path: string): void {
  void router.push(path);
}
</script>

<template>
  <main class="w-home">
    <PageHeader title="应用中心" :note="`共 ${totalLeaves} 个功能 · 按域分组`">
      <template #actions>
        <StatusChip :text="connectionText" :tone="connectionTone" />
      </template>
    </PageHeader>

    <p class="w-home__account">
      <span v-if="session.username">当前账号：{{ session.username }}</span>
      <span v-else>已登录</span>
      <span class="w-home__account-sep">·</span>
      <span>详情、结果明细这类页面需要先选一条记录，从各自列表点进去。</span>
    </p>

    <SectionBlock v-for="group in groups" :key="group.id" :title="group.label">
      <ul class="w-home__grid">
        <li v-for="leaf in group.leaves" :key="leaf.method">
          <button type="button" class="w-home__entry" @click="open(leaf.path)">
            <span class="w-home__entry-name">{{ leaf.label }}</span>
            <span class="w-home__entry-note">{{ leaf.note }}</span>
          </button>
        </li>
      </ul>
    </SectionBlock>
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

.w-home__account {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-home__account-sep {
  margin: 0 var(--w-space-inline-gap);
}

/*
 * 功能入口：宽屏并排、窄屏一行一个。
 * `auto-fill + minmax(card-min-width, 1fr)`：手机上一列、桌面两列，不用写断点。
 */
.w-home__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--w-size-card-min-width), 1fr));
  gap: var(--w-space-row-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}

.w-home__entry {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  width: 100%;
  min-height: var(--w-space-touch-target-min);
  padding: var(--w-space-card-padding-compact);
  text-align: left;
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.w-home__entry:active {
  background: var(--w-color-surface-alt);
  border-color: var(--w-color-primary);
}

.w-home__entry-name {
  font-size: var(--w-type-section-title-size);
  line-height: var(--w-type-section-title-line);
  font-weight: var(--w-type-section-title-weight);
  color: var(--w-color-on-surface);
}

.w-home__entry-note {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}
</style>
