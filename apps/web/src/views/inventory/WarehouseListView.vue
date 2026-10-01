<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput } from 'element-plus';
import { asList, asTotal, humanize, useMutation, useNavStore, useResource, useResourceCacheStore } from '@wise/stores';
import { ConfirmDialog, PageHeader, PaginationBar, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';

/**
 * 仓库管理（`warehouse.list` + `warehouse.create` / `warehouse.delete`）。
 *
 * ## 一个必须记住的参数名差异
 *
 * 契约里删除端点的路径模板是 `/api/warehouse/{id}` —— 参数名就是 **`id`**，
 * 不是 `warehouseId`。传错名字桥会报"参数不完整"，而后端根本收不到请求。
 * 这类错误在真机上表现为"点了没反应"，所以这条留在注释里。
 *
 * 仓库**编辑**不在本次范围（服务端有 `warehouse.update`，未验证不接线）。
 */
interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
  readonly address?: string;
  readonly description?: string;
}

const PAGE_SIZE = 20;

const nav = useNavStore();
const cache = useResourceCacheStore();
const view = nav.viewStateOf('warehouse.list');

const creating = ref(false);
const form = ref({ warehouseName: '', warehouseCode: '', address: '' });
const actionError = ref<string | undefined>(undefined);
const confirmTarget = ref<WarehouseRow | undefined>(undefined);

const params = computed(() => ({ page: view.page, size: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('warehouse.list', params);
const rows = computed(() => asList<WarehouseRow>(data.value));
const total = computed(() => asTotal(data.value));

const createMutation = useMutation('warehouse.create');
const deleteMutation = useMutation('warehouse.delete');
const busy = computed(() => createMutation.pending.value || deleteMutation.pending.value);

const columns: readonly ColumnDef<WarehouseRow>[] = [
  { key: 'warehouseName', title: '仓库名称', compact: 'primary' },
  { key: 'warehouseCode', title: '仓库编码', type: 'mono', width: 150, compact: 'secondary' },
  { key: 'address', title: '地址' },
];

function openCreate(): void {
  actionError.value = undefined;
  form.value = { warehouseName: '', warehouseCode: '', address: '' };
  creating.value = true;
}

async function submitCreate(): Promise<void> {
  const f = form.value;
  if (f.warehouseName.trim() === '' || f.warehouseCode.trim() === '') {
    actionError.value = '仓库名称与编码必填：编码会印在货位号上，不能空。';
    return;
  }
  actionError.value = undefined;
  try {
    await createMutation.run({
      warehouseName: f.warehouseName.trim(),
      warehouseCode: f.warehouseCode.trim(),
      address: f.address.trim(),
    });
    creating.value = false;
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
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" type="primary" @click="openCreate">新增仓库</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && !creating" class="w-inv-error" role="alert">{{ actionError }}</p>

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
            <ElButton v-if="row.warehouseId !== undefined" size="small" type="danger" text @click="confirmTarget = row">
              删除
            </ElButton>
          </template>
        </ResponsiveDataView>
        <PaginationBar
          :page="view.page"
          :page-size="PAGE_SIZE"
          :total="total ?? rows.length"
          :loading="loading"
          @update:page="(p: number) => (view.page = p)"
        />
      </StateHost>
    </SectionBlock>

    <ElDialog v-model="creating" title="新增仓库" width="var(--w-size-dialog-max-width)" append-to-body>
      <ElForm label-position="top">
        <ElFormItem label="仓库名称（必填）">
          <ElInput v-model="form.warehouseName" size="large" placeholder="例如：华东中心仓" />
        </ElFormItem>
        <ElFormItem label="仓库编码（必填）">
          <ElInput v-model="form.warehouseCode" size="large" placeholder="例如：EC-01" />
        </ElFormItem>
        <ElFormItem label="地址">
          <ElInput v-model="form.address" size="large" placeholder="例如：上海市青浦区…" />
        </ElFormItem>
      </ElForm>
      <p v-if="actionError" class="w-inv-error" role="alert">{{ actionError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="creating = false">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="submitCreate">创建</ElButton>
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
