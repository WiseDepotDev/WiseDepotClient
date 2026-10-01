<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton, ElDialog, ElInput } from 'element-plus';
import { humanize, shortTime, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';
import type { KeyValueItem } from '@wise/ui';

/**
 * 库存详情（`inventory.detail` + `inventory.lock` / `inventory.unlock`）。
 *
 * ## 两条业务约束
 *
 * 1. **不提供"直接改库存数"的入口**：库存只能通过出入库单流转（服务端是这么设计的）。
 *    这里给的锁定量是「预留」语义 —— 锁定让可用量减少、解锁让它回来，
 *    不会凭空改变库存总量。摆一个"改数量"的输入框等于绕过单据，是错的。
 * 2. **数量必须现填、不可预填**：锁定/解锁都要用户明确写一个数，
 *    预填一个"看起来合理"的数字最容易变成误操作。
 */
interface InventoryDetail {
  readonly inventoryId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly productSpecification?: string;
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly location?: string;
  readonly quantity?: number;
  readonly lockedQuantity?: number;
  readonly status?: number;
  readonly lastCheckTime?: string;
  readonly updateTime?: string;
}

const route = useRoute();
const cache = useResourceCacheStore();

const inventoryId = computed<number | undefined>(() => {
  const raw = route.params.inventoryId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
const hasTarget = computed(() => inventoryId.value !== undefined);
const params = computed(() => (inventoryId.value === undefined ? undefined : { inventoryId: inventoryId.value }));

const { data, loading, error, reload } = useResource<InventoryDetail>('inventory.detail', params, {
  enabled: hasTarget,
});

const kind = ref<'lock' | 'unlock' | undefined>(undefined);
const quantityText = ref('');
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

const lockMutation = useMutation('inventory.lock');
const unlockMutation = useMutation('inventory.unlock');
const busy = computed(() => lockMutation.pending.value || unlockMutation.pending.value);

const quantity = computed(() => {
  const parsed = Number(quantityText.value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});

const available = computed(() => Math.max(0, (data.value?.quantity ?? 0) - (data.value?.lockedQuantity ?? 0)));

const dialogTitle = computed(() =>
  kind.value === 'lock' ? '锁定一部分库存' : '解锁一部分库存',
);

const infoItems = computed<KeyValueItem[]>(() => {
  const d = data.value;
  return [
    { key: 'productCode', label: '商品编码', value: d?.productCode ?? null, mono: true },
    { key: 'productName', label: '商品名称', value: d?.productName ?? null },
    { key: 'spec', label: '规格', value: d?.productSpecification ?? null },
    { key: 'warehouse', label: '仓库', value: d?.warehouseName ?? null },
    { key: 'location', label: '货位', value: d?.location ?? null, mono: true },
    { key: 'quantity', label: '库存数量', value: d?.quantity === undefined ? null : String(d.quantity), mono: true },
    {
      key: 'locked',
      label: '已锁定',
      value: d?.lockedQuantity === undefined ? null : String(d.lockedQuantity),
      mono: true,
    },
    { key: 'available', label: '可用数量', value: String(available.value), mono: true },
    { key: 'check', label: '最近盘点', value: shortTime(d?.lastCheckTime) || null, mono: true },
    { key: 'update', label: '更新时间', value: shortTime(d?.updateTime) || null, mono: true },
  ];
});

function open(kindValue: 'lock' | 'unlock'): void {
  actionError.value = undefined;
  notice.value = undefined;
  quantityText.value = '';
  kind.value = kindValue;
}

function close(): void {
  kind.value = undefined;
  quantityText.value = '';
}

async function confirm(): Promise<void> {
  const id = inventoryId.value;
  const qty = quantity.value;
  const current = kind.value;
  if (id === undefined || current === undefined) {
    close();
    return;
  }
  if (qty === undefined || qty <= 0) {
    actionError.value = '请填写一个大于 0 的数量。';
    return;
  }
  if (current === 'lock' && qty > available.value) {
    actionError.value = `锁定数量不能超过可用量（当前可用 ${available.value} 件）。`;
    return;
  }
  actionError.value = undefined;
  try {
    if (current === 'lock') {
      await lockMutation.run({ inventoryId: id, quantity: qty });
      notice.value = `已锁定 ${qty} 件，可锁定数量相应减少 ${qty} 件。`;
    } else {
      await unlockMutation.run({ inventoryId: id, quantity: qty });
      notice.value = `已解锁 ${qty} 件，这部分数量回到可用量。`;
    }
    close();
    cache.invalidate('inventory');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader
      :title="data?.productName ?? '库存详情'"
      :note="`${data?.warehouseName ?? '仓库未登记'} · 货位 ${data?.location ?? '未登记'} · 库存 #${inventoryId ?? '—'}`"
    >
      <template #actions>
        <StatusChip
          :text="data?.status === 1 ? '已锁定' : '正常'"
          :tone="data?.status === 1 ? 'warning' : 'success'"
        />
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <p v-if="notice" class="w-inv-notice" role="status">{{ notice }}</p>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="!hasTarget"
      skeleton="detail"
      empty-text="没有指定要查看的库存记录；请从库存查询点开一条。"
      @retry="reload"
    >
      <SectionBlock title="库存信息">
        <div class="w-card">
          <KeyValuePanel :items="infoItems" />
          <!--
            把"为什么这里没有改数量的输入框"写出来。
            界面上缺一个操作，用户会当成功能没做完；说明来由才不会被误读成缺陷。
          -->
          <p class="w-inv-hint">
            库存数量由出入库单流转产生，这里不能直接改动。下面两个动作只调整「已锁定」的预留量：锁定让可用量减少、解锁让它回来，库存总量不变。
          </p>
        </div>
      </SectionBlock>
    </StateHost>

    <ActionDock>
      <ElButton size="large" :disabled="!hasTarget || busy" @click="open('unlock')">解锁</ElButton>
      <ElButton size="large" type="primary" :disabled="!hasTarget || busy" @click="open('lock')">锁定</ElButton>
    </ActionDock>

    <ElDialog
      :model-value="kind !== undefined"
      :title="dialogTitle"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) close(); }"
    >
      <p class="w-inv-hint">
        {{
          kind === 'lock'
            ? `锁定是「预留」：可用量减少、库存总量不变。当前可用 ${available} 件。`
            : `解锁把已锁定的数量放回可用量。当前已锁定 ${data?.lockedQuantity ?? 0} 件。`
        }}
      </p>
      <ElInput v-model="quantityText" size="large" placeholder="数量（必填，大于 0）" />
      <p v-if="actionError" class="w-inv-error" role="alert">{{ actionError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="close">取消</ElButton>
        <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="confirm">
          {{ kind === 'lock' ? '确认锁定' : '确认解锁' }}
        </ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
.w-card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inv-notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-inv-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inv-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
}
</style>
