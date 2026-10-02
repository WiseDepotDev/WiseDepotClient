<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput, ElSwitch } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, ConfirmDialog, PageHeader, ResponsiveDataView, SectionBlock, StateHost, StatusChip, type ColumnDef } from '@wise/ui';

/**
 * 巡检计划（`inspection.planList` + `planCreate` / `planUpdate` / `planDelete`）。
 *
 * ## 为什么这一屏是必须的
 *
 * 「新建巡检」要选一个计划才能建任务，而计划原先**只能由服务端预先塞进去** ——
 * 经理在现场没法自己排一条计划。这一屏把 `inspection.plan*` 四个端点接上，
 * 现场就能自己建/改/停用计划，然后建任务。
 *
 * ## 服务端的真实规则（读 `InspectionApplicationService` 得来）
 *
 *  · 新建时**只校验名称唯一**（「巡检计划名称已存在」），建出来一律**启用**；
 *  · 更新是 `planName` / `deviceId` / `cronExpression` **`!= null` 才写**（传空串 = 清空该字段）；
 *  · `enabled` 对应服务端的 `status`（1 启用 / 0 停用），只有更新时能改；
 *  · 计划不存在 → 「巡检计划不存在」。
 *
 * 界面侧另外加了两条**自己的**口径（服务端没有，所以写在界面上而不是假装服务端会拦）：
 * 计划名称必填；定时表达式留空表示"手动触发"。
 */
interface PlanRow {
  readonly planId?: number;
  readonly planName?: string;
  readonly deviceId?: number;
  readonly cronExpression?: string;
  readonly enabled?: boolean;
  readonly createTime?: string;
  readonly updateTime?: string;
}

interface DeviceRow {
  readonly deviceId?: number;
  readonly deviceName?: string;
  readonly deviceCode?: string;
}

/*
 * **不传分页参数，也不画分页条**：`InspectionController:73` 的计划列表只接
 * `planType` / `enabled` / `warehouseId`，返回 `List<InspectionPlanDTO>`（全量）——
 * 服务端没有分页这回事。原先传的 `{page, size}` 会被静默忽略，而分页条点了两页数据一样，
 * 属于"不可用的按钮"（本仓硬纪律：不渲染）。
 */
const cache = useResourceCacheStore();

const dialogOpen = ref(false);
const editing = ref<PlanRow | undefined>(undefined);
const form = ref({ planName: '', deviceId: '', cronExpression: '', enabled: true });
const actionError = ref<string | undefined>(undefined);
const confirmTarget = ref<PlanRow | undefined>(undefined);

const { data, loading, error, reload } = useResource<unknown>('inspection.planList');
/** 设备名是**辅助数据**：取不到只退化成"设备 #N"，绝不把计划列表拖成错误态。 */
const devices = useResource<unknown>('device.list', {});

const rows = computed(() => asList<PlanRow>(data.value));
const total = computed(() => asTotal(data.value));

const createMutation = useMutation('inspection.planCreate');
const updateMutation = useMutation('inspection.planUpdate');
const deleteMutation = useMutation('inspection.planDelete');
const busy = computed(
  () => createMutation.pending.value || updateMutation.pending.value || deleteMutation.pending.value,
);
const dialogTitle = computed(() => (editing.value === undefined ? '新建巡检计划' : '编辑巡检计划'));

const deviceNames = computed(() => {
  const map = new Map<number, string>();
  for (const d of asList<DeviceRow>(devices.data.value)) {
    if (d.deviceId !== undefined) {
      map.set(d.deviceId, d.deviceName ?? d.deviceCode ?? `设备 #${d.deviceId}`);
    }
  }
  return map;
});

function deviceText(row: PlanRow): string {
  if (row.deviceId === undefined || row.deviceId === 0) {
    return '未指定设备';
  }
  return deviceNames.value.get(row.deviceId) ?? `设备 #${row.deviceId}`;
}

const columns: readonly ColumnDef<PlanRow>[] = [
  { key: 'planName', title: '计划名称', compact: 'primary', value: (r) => r.planName ?? '未命名计划' },
  { key: 'deviceId', title: '执行设备', width: 160, compact: 'secondary', value: (r) => deviceText(r) },
  {
    key: 'cronExpression',
    title: '定时表达式',
    type: 'mono',
    width: 160,
    value: (r) => (r.cronExpression !== undefined && r.cronExpression !== '' ? r.cronExpression : '手动触发'),
  },
  {
    key: 'enabled',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => (r.enabled === false ? '已停用' : '启用中'),
    tone: (r) => (r.enabled === false ? 'neutral' : 'success'),
  },
  { key: 'updateTime', title: '更新时间', type: 'mono', width: 140, value: (r) => shortTime(r.updateTime) },
];

function openCreate(): void {
  actionError.value = undefined;
  editing.value = undefined;
  form.value = { planName: '', deviceId: '', cronExpression: '', enabled: true };
  dialogOpen.value = true;
}

function openEdit(row: PlanRow): void {
  actionError.value = undefined;
  editing.value = row;
  form.value = {
    planName: row.planName ?? '',
    deviceId: row.deviceId === undefined ? '' : String(row.deviceId),
    cronExpression: row.cronExpression ?? '',
    enabled: row.enabled !== false,
  };
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogOpen.value = false;
  editing.value = undefined;
}

async function submit(): Promise<void> {
  const f = form.value;
  if (f.planName.trim() === '') {
    actionError.value = '计划名称必填：建任务时要靠它认出是哪条计划。';
    return;
  }
  const deviceText = f.deviceId.trim();
  if (deviceText !== '' && (!Number.isInteger(Number(deviceText)) || Number(deviceText) <= 0)) {
    actionError.value = '设备序号要填大于 0 的整数；不知道序号可以留空（表示手动选设备）。';
    return;
  }
  actionError.value = undefined;
  const target = editing.value;
  try {
    if (target === undefined || target.planId === undefined) {
      // 新建：服务端一律置为启用，所以这里不传 enabled（传了也不会被采纳）
      await createMutation.run({
        planName: f.planName.trim(),
        ...(deviceText === '' ? {} : { deviceId: Number(deviceText) }),
        cronExpression: f.cronExpression.trim(),
      });
    } else {
      await updateMutation.run({
        planId: target.planId,
        planName: f.planName.trim(),
        ...(deviceText === '' ? { deviceId: null } : { deviceId: Number(deviceText) }),
        cronExpression: f.cronExpression.trim(),
        enabled: f.enabled,
      });
    }
    closeDialog();
    cache.invalidate('inspection.plan');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

async function confirmDelete(): Promise<void> {
  const target = confirmTarget.value;
  confirmTarget.value = undefined;
  if (target?.planId === undefined) {
    return;
  }
  try {
    await deleteMutation.run({ planId: target.planId });
    cache.invalidate('inspection.plan');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="巡检计划" :note="total !== undefined ? `共 ${total} 条计划` : '排好盘点计划，现场才能建任务'">
      <template #actions>
        <!-- 桌面档留在页头；手机档移到底部动作条 -->
        <ElButton class="w-hide-compact" size="large" type="primary" @click="openCreate">新建计划</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && !dialogOpen" class="w-plan-error" role="alert">{{ actionError }}</p>

    <SectionBlock title="计划列表">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        empty-text="还没有巡检计划。先建一条（选好执行设备与触发时间），再去「巡检任务」里建任务。"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: PlanRow) => String(r.planId ?? r.planName ?? '')"
        >
          <template #actions="{ row }">
            <ElButton v-if="row.planId !== undefined" size="small" text @click="openEdit(row)">编辑</ElButton>
            <ElButton v-if="row.planId !== undefined" size="small" type="danger" text @click="confirmTarget = row">
              删除
            </ElButton>
          </template>
        </ResponsiveDataView>
      </StateHost>
    </SectionBlock>

    <ActionDock>
      <ElButton class="w-show-compact-only w-actiondock__block" size="large" type="primary" @click="openCreate">
        新建计划
      </ElButton>
    </ActionDock>

    <ElDialog
      :model-value="dialogOpen"
      :title="dialogTitle"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      @update:model-value="(v: boolean) => (v ? (dialogOpen = true) : closeDialog())"
    >
      <ElForm label-position="top">
        <ElFormItem label="计划名称（必填）">
          <ElInput v-model="form.planName" size="large" placeholder="例如：华东中心仓日常盘点" />
        </ElFormItem>
        <ElFormItem :label="editing === undefined ? '执行设备序号' : '执行设备序号（留空 = 保持原设备）'">
          <ElInput
            v-model="form.deviceId"
            size="large"
            :placeholder="editing === undefined ? '例如：3（留空表示建任务时再选设备）' : '留空表示不改动原来绑定的设备'"
          />
        </ElFormItem>
        <ElFormItem label="定时表达式">
          <ElInput v-model="form.cronExpression" size="large" placeholder="例如：0 0 8 * * ?（留空表示手动触发）" />
        </ElFormItem>
        <ElFormItem v-if="editing !== undefined" label="启用这条计划">
          <ElSwitch v-model="form.enabled" />
        </ElFormItem>
        <p v-else class="w-plan-hint">新建的计划默认是启用的（服务端就是这么定的）；要停用请建好后编辑。</p>
      </ElForm>
      <p v-if="actionError" class="w-plan-error" role="alert">{{ actionError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="closeDialog">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="submit">
          {{ editing === undefined ? '创建' : '保存' }}
        </ElButton>
      </template>
    </ElDialog>

    <ConfirmDialog
      :show="confirmTarget !== undefined"
      title="删除巡检计划"
      :text="`将删除计划「${confirmTarget?.planName ?? ''}」。已经由这条计划建出来的任务不受影响，之后不能再拿它建任务。`"
      confirm-text="删除"
      danger
      :pending="deleteMutation.pending.value"
      @confirm="confirmDelete"
      @cancel="confirmTarget = undefined"
    />
  </div>
</template>

<style scoped>
.w-plan-error {
  margin: 0 0 var(--w-space-group-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-plan-hint {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}
</style>
