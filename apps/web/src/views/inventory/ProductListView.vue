<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useMutation, useNavStore, useResource, useResourceCacheStore } from '@wise/stores';
import { ConfirmDialog, PageHeader, PaginationBar, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';

/**
 * 商品管理（`product.list` + `product.create` / `product.delete`）。
 *
 * 这是**标准 CRUD 屏的样板**（仓库管理、用户管理都照它写）：
 *  · 列表 + 分页 + 新建弹窗 + 删除二次确认；
 *  · 删除走 `ConfirmDialog`（危险操作必须二次确认）；
 *  · 写操作成功后 `invalidate` 列表缓存再重取，**不做乐观更新**（后端有约束，
 *    乐观回滚会让人以为"删掉了其实没有"）。
 *
 * 商品**编辑**不在本次范围（服务端有 `product.update`，但未经验证不接线）。
 */
interface ProductRow {
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly model?: string;
  readonly unit?: string;
  readonly createTime?: string;
}

const PAGE_SIZE = 20;

const nav = useNavStore();
const cache = useResourceCacheStore();
const view = nav.viewStateOf('product.list');

const creating = ref(false);
const form = ref({ productName: '', productCode: '', model: '', unit: '' });
const actionError = ref<string | undefined>(undefined);

const confirmTarget = ref<ProductRow | undefined>(undefined);

const params = computed(() => ({ page: view.page, size: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('product.list', params);
const rows = computed(() => asList<ProductRow>(data.value));
const total = computed(() => asTotal(data.value));

const createMutation = useMutation('product.create');
const deleteMutation = useMutation('product.delete');
const busy = computed(() => createMutation.pending.value || deleteMutation.pending.value);

const columns: readonly ColumnDef<ProductRow>[] = [
  { key: 'productName', title: '商品名称', compact: 'primary' },
  { key: 'productCode', title: '商品编码', type: 'mono', width: 150, compact: 'secondary' },
  { key: 'model', title: '型号', width: 140 },
  { key: 'unit', title: '单位', width: 90 },
  { key: 'createTime', title: '创建时间', type: 'mono', width: 140, value: (r) => shortTime(r.createTime) },
];

function openCreate(): void {
  actionError.value = undefined;
  form.value = { productName: '', productCode: '', model: '', unit: '' };
  creating.value = true;
}

async function submitCreate(): Promise<void> {
  const f = form.value;
  if (f.productName.trim() === '' || f.productCode.trim() === '') {
    actionError.value = '商品名称与编码必填：编码是操作员对单用的，不能空。';
    return;
  }
  actionError.value = undefined;
  try {
    await createMutation.run({
      productName: f.productName.trim(),
      productCode: f.productCode.trim(),
      model: f.model.trim(),
      unit: f.unit.trim(),
    });
    creating.value = false;
    cache.invalidate('product');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

async function confirmDelete(): Promise<void> {
  const target = confirmTarget.value;
  confirmTarget.value = undefined;
  if (target?.productId === undefined) {
    return;
  }
  try {
    await deleteMutation.run({ productId: target.productId });
    cache.invalidate('product');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="商品管理" :note="total !== undefined ? `共 ${total} 个商品` : '维护商品主数据'">
      <template #actions>
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" type="primary" @click="openCreate">新增商品</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && !creating" class="w-inv-error" role="alert">{{ actionError }}</p>

    <SectionBlock title="商品列表">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        empty-text="还没有商品。点右上角「新增商品」建立第一个，然后就能入库了。"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: ProductRow) => String(r.productId ?? r.productCode ?? '')"
        >
          <template #actions="{ row }">
            <ElButton
              v-if="row.productId !== undefined"
              size="small"
              type="danger"
              text
              @click="confirmTarget = row"
            >
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

    <ElDialog v-model="creating" title="新增商品" width="var(--w-size-dialog-max-width)" append-to-body>
      <ElForm label-position="top">
        <ElFormItem label="商品名称（必填）">
          <ElInput v-model="form.productName" size="large" placeholder="例如：工业级 RFID 标签" />
        </ElFormItem>
        <ElFormItem label="商品编码（必填）">
          <ElInput v-model="form.productCode" size="large" placeholder="例如：RFID-UHF-01" />
        </ElFormItem>
        <ElFormItem label="型号">
          <ElInput v-model="form.model" size="large" placeholder="例如：UHF-01" />
        </ElFormItem>
        <ElFormItem label="单位">
          <ElInput v-model="form.unit" size="large" placeholder="例如：个 / 箱 / 米" />
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
      title="删除商品"
      :text="`将删除商品「${confirmTarget?.productName ?? ''}」（${confirmTarget?.productCode ?? ''}）。已被库存或单据引用的商品可能删除失败，失败原因会原样显示。`"
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
