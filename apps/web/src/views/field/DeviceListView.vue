<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { asList, humanize, shortTime, useResource } from '@wise/stores';
import {
  MasterDetail,
  PageHeader,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  useViewport,
  type ColumnDef,
} from '@wise/ui';

import DeviceDetailPanel from './DeviceDetailPanel.vue';

/**
 * 设备管理（`device.list` + `device.statistics`）。
 *
 * ## 两条约束
 *
 * 1. 设备总数不大（现场几十台），一次取回后本地筛选 —— 不做服务端分页，
 *    避免"点一下筛选取一次数"。所以筛选条上写的是"筛选本页"（其实就是全量）。
 * 2. 统计是辅助数据：`device.statistics` 失败时列表仍然可用，统计条只显示"取不到"，
 *    绝不因为它把整屏拖成错误态（辅助数据不该有权让主内容不可用）。
 *
 * 状态判定优先用服务端译好的 `deviceStatusName`（"在线/离线/故障"），
 * 只有它缺失时才退回数字码 —— 码表含义会变，服务端的说法不会。
 *
 * ## 主从视图（2026-10-05 接上）
 *
 * 桌面宽档（≥1440）时左列表右详情并排；窄屏与手机维持"点行进详情路由"。
 */
interface DeviceRow {
  readonly deviceId?: number;
  readonly deviceCode?: string;
  readonly deviceName?: string;
  readonly deviceType?: number;
  readonly deviceTypeName?: string;
  readonly ipAddress?: string;
  readonly deviceStatus?: number;
  readonly deviceStatusName?: string;
  readonly lastHeartbeat?: string;
  readonly remark?: string;
}

type DeviceFilter = 'all' | 'online' | 'offline';

const router = useRouter();

const keyword = ref('');
const applied = ref('');
const filter = ref<DeviceFilter>('all');

const list = useResource<unknown>('device.list', {});
/** 统计不阻断：它的 loading/error 只影响统计条自己 */
const stats = useResource<unknown>('device.statistics', {});

const all = computed(() => asList<DeviceRow>(list.data.value));

/**
 * 状态判定。
 *
 * `?? ''`：真后端对没填的字段回的是 `null` 而不是 `undefined` ——
 * 只判 `!== undefined` 会让 `.includes()` 在 null 上抛 TypeError（真机实测才发现）。
 */
function statusNameOf(row: DeviceRow): string {
  return row.deviceStatusName ?? '';
}

function isOnline(row: DeviceRow): boolean {
  const name = statusNameOf(row);
  if (name !== '') {
    return name.includes('在线') && !name.includes('离线');
  }
  return row.deviceStatus === 1;
}

function statusText(row: DeviceRow): string {
  const name = statusNameOf(row);
  if (name !== '') {
    return name;
  }
  switch (row.deviceStatus) {
    case 1:
      return '在线';
    case 2:
      return '故障';
    case 0:
      return '离线';
    default:
      return '状态未上报';
  }
}

function statusTone(row: DeviceRow) {
  if (row.deviceStatus === 2 || statusNameOf(row).includes('故障')) {
    return 'danger' as const;
  }
  return isOnline(row) ? ('success' as const) : ('neutral' as const);
}

const rows = computed(() =>
  all.value.filter((r) => {
    if (filter.value === 'online' && !isOnline(r)) {
      return false;
    }
    if (filter.value === 'offline' && isOnline(r)) {
      return false;
    }
    if (applied.value !== '') {
      const hay = `${r.deviceName ?? ''}${r.deviceCode ?? ''}${r.ipAddress ?? ''}${r.remark ?? ''}`.toLowerCase();
      if (!hay.includes(applied.value.toLowerCase())) {
        return false;
      }
    }
    return true;
  }),
);

/** 统计条：优先用服务端统计，取不到就退回"列表里数出来的在线数"并标注来源。 */
const stat = computed(() => (stats.data.value ?? {}) as Record<string, unknown>);
const onlineFromServer = computed(() => {
  const s = stat.value;
  if (typeof s['onlineCount'] === 'number') {
    return s['onlineCount'] as number;
  }
  if (typeof s['onlineDevices'] === 'number') {
    return s['onlineDevices'] as number;
  }
  return undefined;
});
const onlineLocal = computed(() => all.value.filter(isOnline).length);
const onlineText = computed(() =>
  onlineFromServer.value === undefined ? `在线 ${onlineLocal.value} 台（按当前列表统计）` : `在线 ${onlineFromServer.value} 台`,
);

const columns: readonly ColumnDef<DeviceRow>[] = [
  { key: 'deviceCode', title: '设备编号', type: 'mono', width: 150, compact: 'primary', value: (r) => r.deviceCode ?? '' },
  { key: 'deviceName', title: '设备名称', compact: 'secondary' },
  { key: 'deviceTypeName', title: '类型', width: 110, value: (r) => r.deviceTypeName ?? '未登记' },
  { key: 'ipAddress', title: 'IP', type: 'mono', width: 140, value: (r) => r.ipAddress ?? '' },
  {
    key: 'deviceStatus',
    title: '状态',
    type: 'status',
    width: 100,
    compact: 'chip',
    value: (r) => statusText(r),
    tone: (r) => statusTone(r),
  },
  { key: 'lastHeartbeat', title: '最后心跳', type: 'mono', width: 140, value: (r) => shortTime(r.lastHeartbeat) },
  { key: 'remark', title: '备注' },
];

/*
 * ---------------------------------------------------------------- 主从视图
 *
 * 为什么宽档点行只改组件状态、不 push 详情路由：本仓 `<RouterView :key="route.fullPath">`
 * 会强制整树重挂 —— 走了详情路由，左栏会被销毁重建（搜索词、筛选档、滚动位置全丢），
 * 表现是"点一行整屏闪一下"。所以宽档点行只设 `selectedId`。
 *
 * 为什么窄档那条老路必须原样留着：手机上并排两个栏目谁都看不清，
 * 而且按 hash 导航是深链 / 扫码 / 返回键的基础。
 *
 * 为什么主从要另备一套列定义：主从左栏只有约 700px，而完整列定义的固定宽加起来
 * 已经超过 750px —— 硬塞会被 `.w-content` 的 `overflow-x: hidden` 裁掉
 * （不是出滚动条，是右半边直接没了）。所以主从只留"认设备"最要紧的几列。
 */
const { isWide } = useViewport();
const selectedId = ref<number | undefined>(undefined);

/** 主从版列定义：编号 / 名称 / 类型 / IP / 状态。最后心跳与备注留给完整视图。 */
const masterColumns: readonly ColumnDef<DeviceRow>[] = [
  { key: 'deviceCode', title: '编号', type: 'mono', width: 140, compact: 'primary', value: (r) => r.deviceCode ?? '' },
  { key: 'deviceName', title: '设备名称', compact: 'secondary' },
  { key: 'deviceTypeName', title: '类型', width: 100, value: (r) => r.deviceTypeName ?? '未登记' },
  { key: 'ipAddress', title: 'IP', type: 'mono', width: 130, value: (r) => r.ipAddress ?? '' },
  {
    key: 'deviceStatus',
    title: '状态',
    type: 'status',
    width: 90,
    compact: 'chip',
    value: (r) => statusText(r),
    tone: (r) => statusTone(r),
  },
];

const activeColumns = computed(() => (isWide.value ? masterColumns : columns));

function onSearch(): void {
  applied.value = keyword.value.trim();
}

function resetFilters(): void {
  keyword.value = '';
  applied.value = '';
  filter.value = 'all';
}

function openDetail(row: DeviceRow): void {
  if (row.deviceId === undefined) {
    return;
  }
  if (isWide.value) {
    selectedId.value = row.deviceId;
    return;
  }
  void router.push({ name: 'device.detail', params: { deviceId: String(row.deviceId) } });
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="设备管理" :note="`${all.length} 台设备 · ${onlineText}`">
      <template #actions>
        <ElButton class="w-hide-compact" size="large" :loading="list.loading.value" @click="list.reload">刷新</ElButton>
      </template>
    </PageHeader>

    <p v-if="stats.error.value" class="w-device-warn" role="status">
      统计信息暂时取不到（{{ humanize(stats.error.value) }}）。下面的列表仍然可用。
    </p>

    <div class="w-toolbar">
      <!--
        搜索框：放大镜在框里 + 回车触发，不再单摆一个「查找」按钮。
        原来那排是"框 + 查找 + 全部 + 在线 + 离线"五个方块，视觉上分不清哪个是搜索、哪个是筛选；
        现在是一行搜索 + 一行胶囊筛选。
      -->
      <ElInput
        v-model="keyword"
        size="large"
        clearable
        class="w-device__search"
        :prefix-icon="Search"
        placeholder="设备名称 / 编号 / IP / 备注"
        @keydown.enter="onSearch"
      />
      <div class="w-chips">
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'all' }" @click="filter = 'all'">
          全部
        </button>
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'online' }" @click="filter = 'online'">
          在线
        </button>
        <button type="button" class="w-chip-item" :class="{ 'w-chip-item--active': filter === 'offline' }" @click="filter = 'offline'">
          离线
        </button>
        <button v-if="applied !== '' || filter !== 'all'" type="button" class="w-chip-item" @click="resetFilters">清空筛选</button>
      </div>
      <span class="w-device__scope">筛选本页 · 搜索框回车</span>
    </div>

    <MasterDetail>
      <template #list>
        <SectionBlock :title="`设备列表${applied ? `（含「${applied}」）` : ''}`">
          <StateHost
            :loading="list.loading.value"
            :error="list.error.value"
            :error-text="list.error.value ? humanize(list.error.value) : undefined"
            :empty="rows.length === 0"
            empty-text="没有符合条件的设备。设备由管理员在服务端登记，客户端只做查看与巡检。"
            skeleton="list"
            @retry="list.reload"
          >
            <ResponsiveDataView
              :columns="activeColumns"
              :rows="rows"
              :row-key="(r: DeviceRow) => String(r.deviceId ?? r.deviceCode ?? '')"
              clickable
              @row-click="openDetail"
            />
          </StateHost>
        </SectionBlock>
      </template>
      <template #detail>
        <!--
          右栏：选中了才渲染面板（没选中时不发一个必然是空的请求）；
          未选中时给一句话说明怎么用，而不是留一片空白 ——
          空白会让人以为"右栏坏了"，而它其实只是在等一次点击。
        -->
        <DeviceDetailPanel v-if="selectedId !== undefined" inline :device-id="selectedId" />
        <div v-else class="w-device__pick">从左边点一台设备，这里显示它的明细。</div>
      </template>
    </MasterDetail>
  </div>
</template>

<style scoped>
.w-device__search {
  max-width: var(--w-space-detail-column-width);
}

.w-device__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
}

/* 主从右栏"还没选"时的提示：muted 小字 + 虚线框，明说它在等一次点击。 */
.w-device__pick {
  padding: var(--w-space-card-padding);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
  background: var(--w-color-surface-alt);
  border: 1px dashed var(--w-color-outline);
  border-radius: var(--w-radius-card);
}

.w-device-warn {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-warning-text);
  background: var(--w-state-warning-fill);
  color: var(--w-state-warning-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
