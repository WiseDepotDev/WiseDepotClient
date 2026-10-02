<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton } from 'element-plus';
import { humanize, shortTime, useResource } from '@wise/stores';
import { KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/**
 * 设备详情面板（`device.detail` / `device.byCode`）。
 *
 * 从 `DeviceDetailView` 抽出来的 —— 它对外只差一个"看哪一台"的参数，
 * 于是能同时服务两种落点：
 *  · 独立路由屏（`DeviceDetailView` 把路由参数解析成 id 传进来）；
 *  · 桌面宽档的主从右栏（设备列表把选中的那一台传进来）。
 *
 * 为什么序号必须是 prop、不能自己读路由：主从右栏换选中项时路由并不改变，
 * 只读 `route.params.deviceId` 的组件拿不到新 id，右栏会一直显示第一次点开的那台。
 * 这与"详情屏把看哪一条写成 setup 期常量"是同一个坑的两种表现。
 *
 * ## 两条入口、同一屏
 *
 * `device.detail`（带 `deviceId`）与按编号查询 `device.byCode`（带 `code`）
 * 只是取数方式不同，展示完全一致。byCode 这一支仍然读路由参数：
 * "设备编号"不是本面板的 prop（主从右栏永远按 id 打开，用不到它），
 * 让薄壳去解析一个它本来就拿不到的东西，只会把两边都写坏。
 *
 * ## 行走速度与四路电机微调是只读的
 *
 * 这四个参数用文本展示，不做滑块：服务端在本仓里没有对应的写接口，
 * 滑块会让操作员以为"拖一下就能调" —— 那是在暗示一个不存在的能力。
 * 要改这些参数得走设备侧，不在客户端范围内。
 */
interface DeviceDetail {
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
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly moveSpeedCmS?: number;
  readonly motorTrimA?: number;
  readonly motorTrimB?: number;
  readonly motorTrimC?: number;
  readonly motorTrimD?: number;
}

/**
 * `inline` 表示这一份被当成主从右栏挂进来（要脱掉 `.w-page` 的居中限宽与左右内边距）。
 *
 * 判据只能由调用点显式传入，不能按「id 有值」推：独立路由屏的薄壳（`DeviceDetailView`，
 * 含手机档从列表点进详情、扫码深链）传的也是路由里解析出来的 id —— 按 id 判断会把那些
 * 独立详情屏的内边距与居中一起脱掉，内容贴到屏幕两边。
 */
const props = defineProps<{ readonly deviceId: number | undefined; readonly inline?: boolean | undefined }>();

const route = useRoute();

const byCode = computed(() => route.name === 'device.byCode');
const routeCode = computed(() => {
  const raw = route.params.code;
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
});

/**
 * 取数参数：byCode 入口按编号，其余按 prop 里的序号。
 *
 * 无论哪一支，取不到目标时都给 `undefined` —— `enabled` 会跟着变 false，
 * 不发一个必然是错的请求（空态由 StateHost 画）。
 */
const params = computed(() => {
  if (byCode.value) {
    // 接口参数名是 deviceCode，而路由段是 :code —— 这里做映射（写错就是"参数不完整"）
    return routeCode.value === '' ? undefined : { deviceCode: routeCode.value };
  }
  return props.deviceId === undefined ? undefined : { deviceId: props.deviceId };
});
const enabled = computed(() => params.value !== undefined);

const { data, loading, error, reload } = useResource<DeviceDetail>(
  byCode.value ? 'device.byCode' : 'device.detail',
  params,
  { enabled },
);

function numberText(value: number | undefined, unit: string): string | null {
  return value === undefined ? null : `${value}${unit}`;
}

/** `?? ''`：真后端对没填的字段回 `null`（不是 undefined），只判 undefined 会在 `.includes` 上炸。 */
function statusText(d: DeviceDetail | undefined): string {
  const name = d?.deviceStatusName ?? '';
  if (name !== '') {
    return name;
  }
  switch (d?.deviceStatus) {
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

const statusTone = computed(() => {
  const d = data.value;
  const name = d?.deviceStatusName ?? '';
  if (d?.deviceStatus === 2 || name.includes('故障')) {
    return 'danger' as const;
  }
  if (d?.deviceStatus === 1 || name.includes('在线')) {
    return 'success' as const;
  }
  return 'neutral' as const;
});

const infoItems = computed<KeyValueItem[]>(() => {
  const d = data.value;
  return [
    { key: 'code', label: '设备编号', value: d?.deviceCode ?? null, mono: true },
    { key: 'name', label: '设备名称', value: d?.deviceName ?? null },
    { key: 'type', label: '设备类型', value: d?.deviceTypeName ?? null },
    { key: 'ip', label: 'IP 地址', value: d?.ipAddress ?? null, mono: true },
    { key: 'status', label: '在线状态', value: statusText(d), tone: statusTone.value },
    { key: 'heartbeat', label: '最后心跳', value: shortTime(d?.lastHeartbeat) || null, mono: true },
    { key: 'update', label: '更新时间', value: shortTime(d?.updateTime) || null, mono: true },
    { key: 'remark', label: '备注', value: d?.remark ?? null },
  ];
});

/** 只读参数：用文本而不是滑块（见文件头说明）。 */
const paramItems = computed<KeyValueItem[]>(() => {
  const d = data.value;
  return [
    { key: 'speed', label: '行走速度', value: numberText(d?.moveSpeedCmS, ' 厘米/秒'), mono: true },
    { key: 'trimA', label: '电机微调 A', value: numberText(d?.motorTrimA, ''), mono: true },
    { key: 'trimB', label: '电机微调 B', value: numberText(d?.motorTrimB, ''), mono: true },
    { key: 'trimC', label: '电机微调 C', value: numberText(d?.motorTrimC, ''), mono: true },
    { key: 'trimD', label: '电机微调 D', value: numberText(d?.motorTrimD, ''), mono: true },
  ];
});
</script>

<template>
  <div class="w-page" :class="{ 'w-page--inline': props.inline === true }">
    <PageHeader
      :title="data?.deviceName ?? '设备详情'"
      :note="byCode ? `按编号查询：${routeCode || '—'}` : `设备 #${deviceId ?? '—'}`"
    >
      <template #actions>
        <StatusChip :text="statusText(data)" :tone="statusTone" />
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="!enabled"
      skeleton="detail"
      empty-text="没有指定要查看的设备；请从设备管理点开一台，或输入设备编号查询。"
      @retry="reload"
    >
      <SectionBlock title="设备信息">
        <div class="w-card">
          <KeyValuePanel :items="infoItems" />
        </div>
      </SectionBlock>

      <SectionBlock title="运行参数（只读）">
        <div class="w-card">
          <p class="w-device-hint">这些参数在客户端只能查看：调整要由设备侧完成。</p>
          <KeyValuePanel :items="paramItems" />
        </div>
      </SectionBlock>
    </StateHost>

  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-device-hint {
  margin: 0 0 var(--w-space-group-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}
</style>
