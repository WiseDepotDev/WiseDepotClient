<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput } from 'element-plus';
import { asList, asTotal, humanize, shortTime, useMutation, useNavStore, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, ConfirmDialog, PageHeader, PaginationBar, ResponsiveDataView, SectionBlock, StateHost, type ColumnDef } from '@wise/ui';

/**
 * 商品管理（`product.list` + `product.create` / `product.update` / `product.delete`）。
 *
 * 这是**标准 CRUD 屏的样板**（仓库管理、用户管理都照它写）：
 *  · 列表 + 分页 + 一个弹窗（新增/编辑两态）+ 删除二次确认；
 *  · 删除走 `ConfirmDialog`（危险操作必须二次确认）；
 *  · 写操作成功后 `invalidate` 列表缓存再重取，**不做乐观更新**（后端有约束，
 *    乐观回滚会让人以为"改掉了其实没有"）。
 *
 * ## 关于 `product.update` 的一条要紧语义（读服务端源码得来）
 *
 * 它是**部分更新**，不是覆盖：`productName` / `productCode` / `unit` **空白 = 保留原值**；
 * 只有 `model` 是"不是 null 就写"（传空串等于清空型号）。
 *
 * 这对界面有两个后果，都体现在实现里：
 *  1. 表单是**预填**的 —— 用户看到的就是当前值，改哪个发哪个，不会被"空值保留"意外擦掉；
 *  2. 名称与编码在**界面侧仍然必填**（虽然服务端允许留空）。因为服务端留空 = 悄悄保留旧值，
 *     而用户清空输入框的意图显然是"改掉它" —— 与其让他的操作静默失效，不如当场说清并拦住。
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

/** 弹窗是否打开。 */
const dialogOpen = ref(false);
/** 正在编辑的那一行；`undefined` 表示"新增"。 */
const editing = ref<ProductRow | undefined>(undefined);
const form = ref({ productName: '', productCode: '', model: '', unit: '' });
const actionError = ref<string | undefined>(undefined);

const confirmTarget = ref<ProductRow | undefined>(undefined);

// **`pageSize`，不是 `size`**：商品分页走 `InventoryController`（`:149`），它只认 `pageSize`。
// 发 `size` 会被**静默忽略**、退回默认 10 条/页 —— 假桥原先两个名字都认，所以开发态看不出来。
// 真后端实测（`tools/bench/inventory-tag-probe.mjs`）：`?size=1` 回 7 条（全部）、`?pageSize=1` 回 1 条。
const params = computed(() => ({ page: view.page, pageSize: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('product.list', params);
const rows = computed(() => asList<ProductRow>(data.value));
const total = computed(() => asTotal(data.value));

const createMutation = useMutation('product.create');
const updateMutation = useMutation('product.update');
const deleteMutation = useMutation('product.delete');
const busy = computed(
  () => createMutation.pending.value || updateMutation.pending.value || deleteMutation.pending.value,
);
const dialogTitle = computed(() => (editing.value === undefined ? '新增商品' : '编辑商品'));

const columns: readonly ColumnDef<ProductRow>[] = [
  { key: 'productName', title: '商品名称', compact: 'primary' },
  { key: 'productCode', title: '商品编码', type: 'mono', width: 150, compact: 'secondary' },
  { key: 'model', title: '型号', width: 140 },
  { key: 'unit', title: '单位', width: 90 },
  { key: 'createTime', title: '创建时间', type: 'mono', width: 140, value: (r) => shortTime(r.createTime) },
];

function openCreate(): void {
  actionError.value = undefined;
  editing.value = undefined;
  form.value = { productName: '', productCode: '', model: '', unit: '' };
  dialogOpen.value = true;
}

/** 编辑：把当前值**预填**进表单 —— 用户改哪个发哪个，别的原样带回去。 */
function openEdit(row: ProductRow): void {
  actionError.value = undefined;
  editing.value = row;
  form.value = {
    productName: row.productName ?? '',
    productCode: row.productCode ?? '',
    model: row.model ?? '',
    unit: row.unit ?? '',
  };
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogOpen.value = false;
  editing.value = undefined;
}

async function submit(): Promise<void> {
  const f = form.value;
  if (f.productName.trim() === '' || f.productCode.trim() === '') {
    actionError.value = '商品名称与编码必填：编码是操作员对单用的，不能空。';
    return;
  }
  actionError.value = undefined;
  const payload = {
    productName: f.productName.trim(),
    productCode: f.productCode.trim(),
    model: f.model.trim(),
    unit: f.unit.trim(),
  };
  try {
    const target = editing.value;
    if (target?.productId === undefined) {
      await createMutation.run(payload);
    } else {
      await updateMutation.run({ productId: target.productId, ...payload });
    }
    closeDialog();
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
        <ElButton class="w-hide-compact" size="large" :loading="loading" @click="reload">刷新</ElButton>
        <!-- 桌面档留在页头；手机档移到底部动作条（见文件末尾的 ActionDock） -->
        <ElButton class="w-hide-compact" size="large" type="primary" @click="openCreate">新增商品</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && !dialogOpen" class="w-inv-error" role="alert">{{ actionError }}</p>

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
              text
              @click="openEdit(row)"
            >
              编辑
            </ElButton>
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

    <ActionDock>
      <ElButton class="w-show-compact-only w-actiondock__block" size="large" type="primary" @click="openCreate">
        新增商品
      </ElButton>
    </ActionDock>

    <ElDialog :model-value="dialogOpen" :title="dialogTitle" width="var(--w-size-dialog-max-width)" append-to-body @update:model-value="(v: boolean) => (v ? (dialogOpen = true) : closeDialog())">
      <ElForm label-position="top">
        <ElFormItem label="商品名称（必填）">
          <ElInput v-model="form.productName" size="large" placeholder="例如：工业级 RFID 标签" />
        </ElFormItem>
        <ElFormItem label="商品编码（必填）">
          <ElInput v-model="form.productCode" size="large" placeholder="例如：RFID-UHF-01" />
        </ElFormItem>
        <ElFormItem label="型号">
          <ElInput v-model="form.model" size="large" placeholder="例如：UHF-01（留空即清空型号）" />
        </ElFormItem>
        <ElFormItem label="单位">
          <ElInput v-model="form.unit" size="large" placeholder="例如：个 / 箱 / 米" />
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
