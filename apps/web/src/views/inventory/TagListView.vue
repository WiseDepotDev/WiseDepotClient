<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElCheckbox, ElDialog, ElOption, ElSelect } from 'element-plus';
import { asList, asTotal, humanize, useMutation, useNavStore, useResource, useResourceCacheStore } from '@wise/stores';
import { PageHeader, PaginationBar, ResponsiveDataView, SectionBlock, StateHost, StatusChip, type ColumnDef } from '@wise/ui';import CaptchaField from '../../components/CaptchaField.vue';
import { useCaptcha } from '../../components/useCaptcha';

/**
 * 标签管理（`tag.list` + 批量绑定 / 批量解绑）。
 *
 * ## 三条业务约束
 *
 * 1. **批量绑定必须带验证码**（服务端 `tag.batchBindWithCaptcha` 的入参就有
 *    `captchaId`/`captchaCode`）—— 这是"影响多件物料"的破坏性操作，验证码是确认动作。
 *    绑定失败后**必须换一张**：验证码一次性，不换会让用户对着作废的图反复提交。
 * 2. **批量解绑不需要验证码**，但仍走二次确认（同样是多件物料）。
 * 3. **选中态由本屏自己持有**（不用表格的内置 selection）：批处理成功后要能干净地清空，
 *    把状态交给表格会出现"操作完了勾还在"。
 */
interface TagRow {
  readonly tagId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly productName?: string;
  readonly productCode?: string;
}

interface ProductRow {
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
}

const PAGE_SIZE = 20;
const OPTION_PAGE_SIZE = 50;

const router = useRouter();
const nav = useNavStore();
const cache = useResourceCacheStore();
const view = nav.viewStateOf('tag.list');

const selected = ref<number[]>([]);
const batch = ref<'bind' | 'unbind' | undefined>(undefined);
const productId = ref('');
const actionError = ref<string | undefined>(undefined);
const captcha = useCaptcha();

// **`pageSize`，不是 `size`**：`TagController:112` 只认 `pageSize`（发 `size` 被静默忽略 →
// 永远 10 条/页）。真后端实测见 `tools/bench/inventory-tag-probe.mjs`。
const params = computed(() => ({ page: view.page, pageSize: PAGE_SIZE }));
const { data, loading, error, reload } = useResource<unknown>('tag.list', params);
const rows = computed(() => asList<TagRow>(data.value));
const total = computed(() => asTotal(data.value));

/** 绑定目标商品：拿第一页做选项（与建单屏同一手法：少量选项不做异步搜索）。 */
const products = useResource<unknown>('product.list', { page: 1, pageSize: OPTION_PAGE_SIZE });
const productOptions = computed(() =>
  asList<ProductRow>(products.data.value)
    .filter((p): p is ProductRow & { productId: number } => typeof p.productId === 'number')
    .map((p) => ({ value: String(p.productId), label: `${p.productName ?? '未命名'}（${p.productCode ?? '—'}）` })),
);

const bindMutation = useMutation('tag.batchBindWithCaptcha');
const unbindMutation = useMutation('tag.batchUnbind');
const busy = computed(() => bindMutation.pending.value || unbindMutation.pending.value);

/**
 * Element Plus 的属性整块给、放宽成 `any`（见 StockOrderCreateView 里的同一说明）：
 * `ElSelect` / `ElOption` / `ElCheckbox` 这批组件的 `buildProps` 类型在 `vue-tsc` 下解析不出来。
 */
function optionProps(opt: { value: string; label: string }): any {
  return { label: opt.label, value: opt.value };
}
const selectProps: any = { size: 'large', placeholder: '选择要绑定的商品', class: 'w-inv-field' };
const checkboxProps: any = { size: 'large' };

const columns: readonly ColumnDef<TagRow>[] = [
  { key: 'barcode', title: '条码', type: 'mono', width: 160, compact: 'primary' },
  { key: 'productName', title: '绑定商品', compact: 'secondary', value: (r) => r.productName ?? '未绑定' },
  { key: 'rfid', title: 'RFID', type: 'mono', width: 150 },
  { key: 'nfcUid', title: 'NFC', type: 'mono', width: 130 },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => (r.status === 1 ? '已绑定' : '未绑定'),
    tone: (r) => (r.status === 1 ? 'success' : 'neutral'),
  },
];

function toggle(tagId: number | undefined, checked: boolean): void {
  if (tagId === undefined) {
    return;
  }
  const set = new Set(selected.value);
  if (checked) {
    set.add(tagId);
  } else {
    set.delete(tagId);
  }
  selected.value = [...set];
}

function openBatch(kind: 'bind' | 'unbind'): void {
  actionError.value = undefined;
  productId.value = '';
  batch.value = kind;
  if (kind === 'bind') {
    void captcha.refresh();
  }
}

async function confirmBatch(): Promise<void> {
  const kind = batch.value;
  const tagIds = selected.value;
  if (kind === undefined || tagIds.length === 0) {
    batch.value = undefined;
    return;
  }
  actionError.value = undefined;
  try {
    if (kind === 'bind') {
      const pid = Number(productId.value);
      if (!Number.isFinite(pid) || pid <= 0) {
        actionError.value = '请先选择要绑定的商品。';
        return;
      }
      if (captcha.code.value.trim() === '') {
        actionError.value = '请填写验证码：批量绑定会影响多件物料，必须确认。';
        return;
      }
      await bindMutation.run({
        tagIds,
        productId: pid,
        captchaId: captcha.captcha.value?.captchaId ?? '',
        captchaCode: captcha.code.value.trim(),
      });
    } else {
      await unbindMutation.run({ tagIds });
    }
    selected.value = [];
    batch.value = undefined;
    cache.invalidate('tag');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
    // 危险操作的验证码是一次性的：失败就换一张，不让用户对着作废的图重试
    if (kind === 'bind') {
      captcha.refreshAfterFailure();
    }
  }
}

onMounted(() => {
  void products.reload();
});

function openDetail(row: TagRow): void {
  if (row.tagId !== undefined) {
    void router.push({ name: 'tag.detail', params: { tagId: String(row.tagId) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="标签管理" :note="total !== undefined ? `共 ${total} 个标签` : '条码 / RFID / NFC 标签'">
      <template #actions>
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
        <ElButton size="large" :disabled="selected.length === 0" @click="openBatch('unbind')">
          批量解绑（{{ selected.length }}）
        </ElButton>
        <ElButton size="large" type="primary" :disabled="selected.length === 0" @click="openBatch('bind')">
          批量绑定（{{ selected.length }}）
        </ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError && batch === undefined" class="w-inv-error" role="alert">{{ actionError }}</p>

    <SectionBlock :title="`标签列表${selected.length > 0 ? ` · 已选 ${selected.length} 项` : ''}`">
      <StateHost
        :loading="loading"
        :error="error"
        :error-text="error ? humanize(error) : undefined"
        :empty="rows.length === 0"
        empty-text="还没有标签。入库后系统会为每件物料生成标签。"
        skeleton="list"
        @retry="reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: TagRow) => String(r.tagId ?? r.barcode ?? '')"
          clickable
          @row-click="openDetail"
        >
          <template #lead="{ row }">
            <ElCheckbox
              v-bind="checkboxProps"
              :model-value="row.tagId !== undefined && selected.includes(row.tagId)"
              @update:model-value="(v: unknown) => toggle(row.tagId, v === true)"
            />
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

    <ElDialog
      :model-value="batch !== undefined"
      :title="batch === 'bind' ? '批量绑定标签' : '批量解绑标签'"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) batch = undefined; }"
    >
      <p class="w-inv-hint">将对已选中的 {{ selected.length }} 个标签执行此操作，操作前请再核对一次。</p>

      <template v-if="batch === 'bind'">
        <ElSelect v-model="productId" v-bind="selectProps">
          <ElOption v-for="opt in productOptions" :key="opt.value" v-bind="optionProps(opt)" />
        </ElSelect>
        <CaptchaField :state="captcha" />
      </template>

      <p v-if="actionError" class="w-inv-error" role="alert">{{ actionError }}</p>

      <template #footer>
        <ElButton size="large" :disabled="busy" @click="batch = undefined">取消</ElButton>
        <ElButton
          size="large"
          :type="batch === 'unbind' ? 'danger' : 'primary'"
          :loading="busy"
          :disabled="busy"
          @click="confirmBatch"
        >
          {{ batch === 'bind' ? '确认绑定' : '确认解绑' }}
        </ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
.w-inv-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-inv-field {
  width: 100%;
  margin-bottom: var(--w-space-inline-gap);
}

.w-inv-error {
  margin: var(--w-space-inline-gap) 0 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
