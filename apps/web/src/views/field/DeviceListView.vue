<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { asList, humanize, shortTime, useResource } from '@wise/stores';
import { PageHeader, ResponsiveDataView, SectionBlock, StateHost, StatusChip, type ColumnDef } from '@wise/ui';

/**
 * 设备管理（`device.list` + `device.statistics`）。
 *
 * ## 两条约束
 *
 * 1. **设备总数不大（现场几十台），一次取回后本地筛选** —— 不做服务端分页，
 *    避免"点一下筛选取一次数"。所以筛选条上写的是"筛选本页"（其实就是全量）。
 * 2. **统计是辅助数据**：`device.statistics` 失败时列表仍然可用，统计条只显示"取不到"，
 *    绝不因为它把整屏拖成错误态（辅助数据不该有权让主内容不可用）。
 *
 * 状态判定**优先用服务端译好的 `deviceStatusName`**（"在线/离线/故障"），
 * 只有它缺失时才退回数字码 —— 码表含义会变，服务端的说法不会。
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
 * `?? ''`：**真后端对没填的字段回的是 `null` 而不是 `undefined`** ——
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

function onSearch(): void {
  applied.value = keyword.value.trim();
}

function resetFilters(): void {
  keyword.value = '';
  applied.value = '';
  filter.value = 'all';
}

function openDetail(row: DeviceRow): void {
  if (row.deviceId !== undefined) {
    void router.push({ name: 'device.detail', params: { deviceId: String(row.deviceId) } });
  }
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
        搜索框：**放大镜在框里 + 回车触发**，不再单摆一个「查找」按钮。
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
          :columns="columns"
          :rows="rows"
          :row-key="(r: DeviceRow) => String(r.deviceId ?? r.deviceCode ?? '')"
          clickable
          @row-click="openDetail"
        />
      </StateHost>
    </SectionBlock>
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
