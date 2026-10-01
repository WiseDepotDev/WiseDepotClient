<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput } from 'element-plus';
import { asList, asTotal, humanize, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ConfirmDialog, PageHeader, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';

/**
 * 仓库管理（`warehouse.list` + `warehouse.create` / `warehouse.update` / `warehouse.delete`）。
 *
 * ## 一个必须记住的参数名差异
 *
 * 契约里删除端点的路径模板是 `/api/warehouse/{id}` —— 参数名就是 **`id`**，
 * 不是 `warehouseId`。传错名字桥会报"参数不完整"，而后端根本收不到请求。
 * 这类错误在真机上表现为"点了没反应"，所以这条留在注释里。
 *
 * ## 更新语义与商品**不一样**（读服务端源码得来，别照抄商品屏）
 *
 * `WarehouseApplicationService#updateWarehouse` 四个字段都是 **`!= null` 就写**：
 * 也就是说传空串是**清空**，而不是"保留原值"（商品那边 `productName/productCode/unit` 用的是 `isBlank` 语义）。
 * 对界面的后果正好写进实现里：表单预填、用户清空哪个字段就真的清掉哪个 —— 所见即所得。
 * 仓库名称与编码在**界面侧仍然必填**（创建请求上它们是 `@NotNull`，而清掉编码会让货位号失去来源）。
 */
interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
  readonly address?: string;
  readonly description?: string;
}

const cache = useResourceCacheStore();

const dialogOpen = ref(false);
/** 正在编辑的那一行；`undefined` 表示"新增"。 */
const editing = ref<WarehouseRow | undefined>(undefined);
const form = ref({ warehouseName: '', warehouseCode: '', address: '', description: '' });
const actionError = ref<string | undefined>(undefined);
const confirmTarget = ref<WarehouseRow | undefined>(undefined);

/*
 * **不传分页参数，也不画分页条**：`WarehouseController:34` 的列表只接 `keyword`，
 * 返回的是 `List<WarehouseDTO>`（全量）—— 服务端根本没有分页这回事。
 *
 * 原先这里传了 `{page, size}` 并挂了一个 `PaginationBar`：参数被静默忽略、数据也从来不切片，
 * 于是那条分页条是个**点了没反应的装饰**（第 2 页和第 1 页是同一批数据）。
 * "不可用的按钮不得渲染"是本仓的硬纪律，所以整条去掉，条数改由页头说。
 */
const { data, loading, error, reload } = useResource<unknown>('warehouse.list');
const rows = computed(() => asList<WarehouseRow>(data.value));
const total = computed(() => asTotal(data.value));

const createMutation = useMutation('warehouse.create');
const updateMutation = useMutation('warehouse.update');
const deleteMutation = useMutation('warehouse.delete');
const busy = computed(
  () => createMutation.pending.value || updateMutation.pending.value || deleteMutation.pending.value,
);
const dialogTitle = computed(() => (editing.value === undefined ? '新增仓库' : '编辑仓库'));

const columns: readonly ColumnDef<WarehouseRow>[] = [
  { key: 'warehouseName', title: '仓库名称', compact: 'primary' },
  { key: 'warehouseCode', title: '仓库编码', type: 'mono', width: 140, compact: 'secondary' },
  {
    key: 'address',
    title: '地址',
    value: (r) => r.address ?? '',
  },
  {
    key: 'description',
    title: '描述',
    width: 160,
    value: (r) => r.description ?? '',
  },
];

function openCreate(): void {
  actionError.value = undefined;
  editing.value = undefined;
  form.value = { warehouseName: '', warehouseCode: '', address: '', description: '' };
  dialogOpen.value = true;
}

/** 编辑：预填当前值。用户清空哪个字段，保存后就真的清掉哪个（服务端是 `!= null` 就写）。 */
function openEdit(row: WarehouseRow): void {
  actionError.value = undefined;
  editing.value = row;
  form.value = {
    warehouseName: row.warehouseName ?? '',
    warehouseCode: row.warehouseCode ?? '',
    address: row.address ?? '',
    description: row.description ?? '',
  };
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogOpen.value = false;
  editing.value = undefined;
}

async function submit(): Promise<void> {
  const f = form.value;
  if (f.warehouseName.trim() === '' || f.warehouseCode.trim() === '') {
    actionError.value = '仓库名称与编码必填：编码会印在货位号上，不能空。';
    return;
  }
  actionError.value = undefined;
  const payload = {
    warehouseName: f.warehouseName.trim(),
    warehouseCode: f.warehouseCode.trim(),
    address: f.address.trim(),
    description: f.description.trim(),
  };
  try {
    const target = editing.value;
    if (target === undefined || target.warehouseId === undefined) {
      await createMutation.run(payload);
    } else {
      // 更新端点的路径参数名也是 `id`（与删除一致），不是 warehouseId
      await updateMutation.run({ id: target.warehouseId, ...payload });
    }
    closeDialog();
    cache.invalidate('warehouse');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

async function confirmDelete(): Promise<void> {
  const target = confirmTarget.value;
  confirmTarget.value = undefined;
  if (target?.warehouseId === undefined) {
    return;
  }
  try {
    // 参数名是 id，不是 warehouseId（见文件头注释）
    await deleteMutation.run({ id: target.warehouseId });
    cache.invalidate('warehouse');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="仓库管理" :note="total !== undefined ? `共 ${total} 个仓库` : '维护仓库主数据'">
      <template #actions>
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" type="primary" @click="openCreate">新增仓库</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && !dialogOpen" class="w-inv-error" role="alert">{{ actionError }}</p>

    <SectionBlock title="仓库列表">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        empty-text="还没有仓库。入库、巡检都要先有仓库，请点右上角新增一个。"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: WarehouseRow) => String(r.warehouseId ?? r.warehouseCode ?? '')"
        >
          <template #actions="{ row }">
            <ElButton v-if="row.warehouseId !== undefined" size="small" text @click="openEdit(row)">编辑</ElButton>
            <ElButton v-if="row.warehouseId !== undefined" size="small" type="danger" text @click="confirmTarget = row">
              删除
            </ElButton>
          </template>
        </ResponsiveDataView>
      </StateHost>
    </SectionBlock>

    <ElDialog :model-value="dialogOpen" :title="dialogTitle" width="var(--w-size-dialog-max-width)" append-to-body @update:model-value="(v: boolean) => (v ? (dialogOpen = true) : closeDialog())">
      <ElForm label-position="top">
        <ElFormItem label="仓库名称（必填）">
          <ElInput v-model="form.warehouseName" size="large" placeholder="例如：华东中心仓" />
        </ElFormItem>
        <ElFormItem label="仓库编码（必填）">
          <ElInput v-model="form.warehouseCode" size="large" placeholder="例如：EC-01" />
        </ElFormItem>
        <ElFormItem label="地址">
          <ElInput v-model="form.address" size="large" placeholder="例如：上海市青浦区…（留空即清空）" />
        </ElFormItem>
        <ElFormItem label="描述">
          <ElInput v-model="form.description" size="large" placeholder="例如：常温区，负责华东片区（留空即清空）" />
        </ElFormItem>
      </ElForm>
      <p v-if="actionError" class="w-inv-error" role="alert">{{ actionError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="closeDialog">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="submit">
          {{ editing === undefined ? '创建' : '保存' }}
        </ElButton>
      </template>
    </ElDialog>

    <ConfirmDialog
      :show="confirmTarget !== undefined"
      title="删除仓库"
      :text="`将删除仓库「${confirmTarget?.warehouseName ?? ''}」（${confirmTarget?.warehouseCode ?? ''}）。已被库存或单据引用的仓库可能删除失败，失败原因会原样显示。`"
      confirm-text="删除"
      danger
      :pending="deleteMutation.pending.value"
      @confirm="confirmDelete"
      @cancel="confirmTarget = undefined"
    />
  </div>
</template>

<style scoped>
.w-inv-error {
  margin: 0 0 var(--w-space-group-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
