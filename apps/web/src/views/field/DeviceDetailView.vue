<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton } from 'element-plus';
import { humanize, shortTime, useResource } from '@wise/stores';
import { ActionDock, KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/**
 * 设备详情（`device.detail` / `device.byCode`）。
 *
 * ## 两条入口、同一屏
 *
 * 从设备管理点一行（`device.detail`，带 `deviceId`）与按编号查询
 * （`device.byCode`，带 `deviceCode`）只是取数方式不同，展示完全一致。
 *
 * ## 行走速度与四路电机微调是**只读**的
 *
 * 这四个参数用文本展示，**不做滑块**：服务端在本仓里没有对应的写接口，
 * 滑块会让操作员以为"拖一下就能调"—— 那是在暗示一个不存在的能力。
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

const route = useRoute();

const byCode = computed(() => route.name === 'device.byCode');
const routeCode = computed(() => {
  const raw = route.params.code;
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
});
const deviceId = computed<number | undefined>(() => {
  const raw = route.params.deviceId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});

const params = computed(() => {
  if (byCode.value) {
    // 接口参数名是 deviceCode，而路由段是 :code —— 这里做映射（写错就是"参数不完整"）
    return routeCode.value === '' ? undefined : { deviceCode: routeCode.value };
  }
  return deviceId.value === undefined ? undefined : { deviceId: deviceId.value };
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

/** 只读参数：**用文本而不是滑块**（见文件头说明）。 */
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
  <div class="w-page">
    <PageHeader
      :title="data?.deviceName ?? '设备详情'"
      :note="byCode ? `按编号查询：${routeCode || '—'}` : `设备 #${deviceId ?? '—'}`"
    >
      <template #actions>
        <StatusChip :text="statusText(data)" :tone="statusTone" />
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
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

    <ActionDock>
      <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
    </ActionDock>
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
