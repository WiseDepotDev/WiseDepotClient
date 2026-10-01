<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton, ElDialog, ElInput } from 'element-plus';
import { asList, humanize, shortTime, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, KeyValuePanel, PageHeader, ResponsiveDataView, SectionBlock, StateHost, StatusChip, type ColumnDef, type KeyValueItem } from '@wise/ui';
import { canAudit, canEditItems, canSubmit, canWithdraw, orderStatusOf, orderStatusText, orderTypeOf, orderTypeText } from './stockOrderState.js';

/**
 * 单据详情（`stockOrder.detail` + `submit` / `withdraw` / `audit`）。
 *
 * ## 状态流转的判据全部来自 `stockOrderState.ts`（服务端真实分支）
 *
 * ```
 * 待审批 ──提交(需有明细)──► 待审核 ──审核通过──► 已审批
 *   ▲                        │
 *   └──────撤回──────────────┘        已审批/已完成 是终态（不可再提交）
 * ```
 *
 * 三条与旧版不同的、**按服务端实际分支纠正过的**规则：
 *  1. **提交要求"有明细"**（真后端实测过 `单据无明细，无法提交`）——
 *     没有明细时按钮不可点，并把原因写在旁边；
 *  2. **撤回只在「待审核」可用**（旧版按"待审批也行"写，与服务端不符）；
 *  3. **审核通过/驳回也只有「待审核」可用**。
 *
 * 审核通过是**不可撤销**的（服务端会按明细增减库存），所以走二次确认；
 * 驳回要求写原因（会写进单据备注发回建单人）。
 */
interface StockOrderItem {
  readonly tagId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly productSpecification?: string;
  readonly quantity?: number;
  readonly locationCode?: string;
}

interface StockOrderDetail {
  readonly orderId?: number;
  readonly orderNo?: string;
  readonly orderCode?: string;
  readonly warehouseName?: string;
  readonly orderType?: number | string;
  readonly orderTypeStr?: string;
  readonly orderStatus?: number | string;
  readonly orderStatusStr?: string;
  readonly totalItems?: number;
  readonly remark?: string;
  readonly createTime?: string;
  readonly createdAt?: string;
  readonly submitTime?: string;
  readonly createdByName?: string;
  readonly createByName?: string;
  readonly items?: readonly StockOrderItem[];
}

type ActionKind = 'submit' | 'withdraw' | 'approve' | 'reject';

const route = useRoute();
const cache = useResourceCacheStore();

const orderId = computed<number | undefined>(() => {
  const raw = route.params.orderId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
});
const hasTarget = computed(() => orderId.value !== undefined);
const params = computed(() => (orderId.value === undefined ? undefined : { orderId: orderId.value }));

const { data, loading, error, reload } = useResource<StockOrderDetail>('stockOrder.detail', params, { enabled: hasTarget });

const order = computed(() => data.value);
const items = computed(() => asList<StockOrderItem>(order.value?.items));
const itemCount = computed(() => (items.value.length > 0 ? items.value.length : (order.value?.totalItems ?? 0)));
const status = computed(() => orderStatusOf(order.value));

const canDoSubmit = computed(() => canSubmit(order.value, itemCount.value));
const canDoWithdraw = computed(() => canWithdraw(order.value));
const canDoAudit = computed(() => canAudit(order.value));

const reason = computed(() => {
  switch (status.value) {
    case 'unknown':
      return '这张单据没有带状态信息，先刷新一次；如果一直没有，请联系管理员核对这张单据。';
    case 'approved':
    case 'completed':
      return `这张单据已经结束（${orderStatusText(order.value)}），不能再改动；如果要再出入库，请新建一张单。`;
    case 'cancelled':
      return '这张单据已取消，不能再提交或审核。';
    default:
      return undefined;
  }
});

const submitBlockedReason = computed(() => {
  if (reason.value !== undefined) {
    return reason.value;
  }
  if (itemCount.value === 0) {
    return '单据还没有明细，无法提交。请先逐条登记明细。';
  }
  return undefined;
});

const infoItems = computed<KeyValueItem[]>(() => {
  const o = order.value;
  return [
    { key: 'orderNo', label: '单号', value: o?.orderNo ?? o?.orderCode ?? null, mono: true },
    { key: 'type', label: '类型', value: orderTypeText(o) },
    { key: 'status', label: '状态', value: orderStatusText(o), tone: statusTone.value },
    { key: 'warehouse', label: '仓库', value: o?.warehouseName ?? null },
    { key: 'createBy', label: '建单人', value: o?.createdByName ?? o?.createByName ?? '未登记' },
    { key: 'createTime', label: '创建时间', value: shortTime(o?.createTime ?? o?.createdAt) || null, mono: true },
    { key: 'submitTime', label: '提交时间', value: shortTime(o?.submitTime) || null, mono: true },
    { key: 'items', label: '明细项数', value: String(itemCount.value), mono: true },
    { key: 'remark', label: '备注', value: o?.remark ?? null },
  ];
});

const statusTone = computed(() => {
  switch (status.value) {
    case 'completed':
      return 'success' as const;
    case 'approved':
      return 'info' as const;
    case 'submitted':
      return 'warning' as const;
    case 'rejected':
      return 'danger' as const;
    default:
      return 'neutral' as const;
  }
});

const itemColumns: readonly ColumnDef<StockOrderItem>[] = [
  { key: 'productCode', title: '商品编码', type: 'mono', width: 150, compact: 'primary', value: (r) => r.productCode ?? '' },
  { key: 'productName', title: '商品', compact: 'secondary' },
  { key: 'locationCode', title: '货位', type: 'mono', width: 110 },
  { key: 'quantity', title: '数量', type: 'mono', width: 90, align: 'right', value: (r) => String(r.quantity ?? 0) },
];

// ---- 动作 ----

const pending = ref<ActionKind | undefined>(undefined);
const rejectReason = ref('');
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

const submitMutation = useMutation('stockOrder.submit');
const withdrawMutation = useMutation('stockOrder.withdraw');
const auditMutation = useMutation('stockOrder.audit');
const addItemMutation = useMutation('stockOrder.addItem');
const removeItemMutation = useMutation('stockOrder.removeItem');
const busy = computed(
  () =>
    submitMutation.pending.value ||
    withdrawMutation.pending.value ||
    auditMutation.pending.value ||
    addItemMutation.pending.value ||
    removeItemMutation.pending.value,
);

/* ------------------------------------------------------------------ 明细增删
 *
 * 这条规则**早就在状态模块里写好了**（`canEditItems`：只有待处理 / 已驳回可增删），
 * 而且与服务端 `InOutApplicationService#addItem/removeItem` 的两道闸门逐字一致 ——
 * 之前只是界面没接，等于"规则存在、界面不存在"。这里把它接上，并用同一份判据做展示。
 */
const canDoEditItems = computed(() => canEditItems(order.value));
const tagInput = ref('');
const itemError = ref<string | undefined>(undefined);
const itemNotice = ref<string | undefined>(undefined);

/**
 * 添加明细：**只发 `tagId`**。
 *
 * 服务端只从标签取 `productId`（`detail.setProductId(tag.getProductId())`），
 * `productName` / `quantity` / `locationCode` 这些字段它根本不读 ——
 * 所以界面**不让用户填商品**：填了不会被采纳，反而让人以为"是我指定的商品"。
 * 每加一个标签，服务端把 `totalItems` 加一（一件实物 = 一条明细）。
 */
async function addItem(): Promise<void> {
  const id = orderId.value;
  if (id === undefined) {
    return;
  }
  itemError.value = undefined;
  itemNotice.value = undefined;
  const tagId = Number(tagInput.value.trim());
  if (!Number.isInteger(tagId) || tagId <= 0) {
    itemError.value = '标签 ID 要填大于 0 的整数：明细是按贴在实物上的标签逐件记的。';
    return;
  }
  try {
    await addItemMutation.run({ orderId: id, tagId });
    tagInput.value = '';
    itemNotice.value = '明细已添加：商品信息按标签的绑定关系自动带出，项数加一。';
    cache.invalidate('stockOrder');
    reload();
  } catch (e) {
    itemError.value = humanize(e as never);
  }
}

async function removeItem(tagId: number | undefined): Promise<void> {
  const id = orderId.value;
  if (id === undefined || tagId === undefined) {
    return;
  }
  itemError.value = undefined;
  itemNotice.value = undefined;
  try {
    await removeItemMutation.run({ orderId: id, tagId });
    itemNotice.value = '明细已移除，单据的明细项数同步减一。';
    cache.invalidate('stockOrder');
    reload();
  } catch (e) {
    itemError.value = humanize(e as never);
  }
}

const actionTitle = computed(() => {
  switch (pending.value) {
    case 'submit':
      return '提交这张单据';
    case 'withdraw':
      return '撤回这张单据';
    case 'approve':
      return '审核通过';
    case 'reject':
      return '驳回这张单据';
    default:
      return '';
  }
});

function open(kind: ActionKind): void {
  actionError.value = undefined;
  notice.value = undefined;
  rejectReason.value = '';
  pending.value = kind;
}

function close(): void {
  pending.value = undefined;
  rejectReason.value = '';
}

async function confirm(): Promise<void> {
  const kind = pending.value;
  const id = orderId.value;
  if (kind === undefined || id === undefined) {
    close();
    return;
  }
  if (kind === 'reject' && rejectReason.value.trim() === '') {
    actionError.value = '请写清驳回原因：它会写进备注发回建单人，只说"驳回"对方不知道要改什么。';
    return;
  }
  actionError.value = undefined;
  try {
    if (kind === 'submit') {
      await submitMutation.run({ orderId: id });
      notice.value = '单据已提交，等有审核权限的同事处理。在审核之前可以撤回。';
    } else if (kind === 'withdraw') {
      await withdrawMutation.run({ orderId: id });
      notice.value = '单据已撤回，回到待审批。可以继续调整明细，再重新提交。';
    } else {
      const approved = kind === 'approve';
      await auditMutation.run({
        orderId: id,
        approved,
        reason: approved ? '审核通过' : rejectReason.value.trim(),
      });
      notice.value = approved
        ? orderTypeOf(order.value) === 'outbound'
          ? '审核通过，已按明细扣减库存。这一步不能撤销。'
          : '审核通过，已按明细增加库存。这一步不能撤销。'
        : '已驳回，原因已写在单据备注里发给建单的人。';
    }
    close();
    cache.invalidate('stockOrder');
    reload();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

// 换一张单据（路由参数变）时必须清掉上一条的提示，否则会看到上一张单的结果
watch(orderId, () => {
  notice.value = undefined;
  actionError.value = undefined;
  itemNotice.value = undefined;
  itemError.value = undefined;
  tagInput.value = '';
  close();
});
</script>

<template>
  <div class="w-page">
    <PageHeader
      :title="order?.orderNo ?? order?.orderCode ?? '单据详情'"
      :note="`${orderTypeText(order)} · ${order?.warehouseName ?? '仓库未登记'} · 明细 ${itemCount} 项`"
    >
      <template #actions>
        <StatusChip :text="orderStatusText(order)" :tone="statusTone" />
        <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
      </template>
    </PageHeader>

    <p v-if="notice" class="w-order-notice" role="status">{{ notice }}</p>

    <StateHost
      :loading="loading"
      :error="error"
      :error-text="error ? humanize(error) : undefined"
      :empty="!hasTarget"
      skeleton="detail"
      empty-text="没有指定要查看的单据；请从出入库单列表点开一张。"
      @retry="reload"
    >
      <SectionBlock title="单据信息">
        <div class="w-card">
          <KeyValuePanel :items="infoItems" />
        </div>
      </SectionBlock>

      <SectionBlock :title="`单据明细${itemCount > 0 ? `（${itemCount} 项）` : ''}`">
        <StateHost :loading="false" :error="null" :empty="items.length === 0" empty-text="这张单据还没有明细。">
          <ResponsiveDataView
            :columns="itemColumns"
            :rows="items"
            :row-key="(r: StockOrderItem) => String(r.tagId ?? `${r.productCode}-${r.locationCode}`)"
          >
            <template #actions="{ row }">
              <ElButton
                v-if="canDoEditItems && row.tagId !== undefined"
                size="small"
                type="danger"
                text
                @click="removeItem(row.tagId)"
              >
                移除
              </ElButton>
            </template>
          </ResponsiveDataView>
        </StateHost>

        <!-- 明细维护：只在服务端允许的状态下出现；不允许时把原因说清楚（同一句服务端原话） -->
        <div v-if="canDoEditItems" class="w-toolbar">
          <ElInput
            v-model="tagInput"
            size="large"
            class="w-order__tag"
            placeholder="标签 ID（扫描或手输）"
            @keydown.enter="addItem"
          />
          <ElButton size="large" type="primary" :disabled="busy" @click="addItem">添加明细</ElButton>
          <span class="w-order-hint">商品信息按标签的绑定关系自动带出，不用手填。</span>
        </div>
        <p v-else class="w-order-reason">
          {{ `只有待处理或已驳回的单据可以增删明细；这张单据当前是「${orderStatusText(order)}」。` }}
        </p>
        <p v-if="itemError" class="w-order-error" role="alert">{{ itemError }}</p>
        <p v-if="itemNotice" class="w-order-notice" role="status">{{ itemNotice }}</p>
      </SectionBlock>

      <SectionBlock title="可以做的操作">
        <div class="w-order-actions">
          <div class="w-order-action">
            <ElButton
              size="large"
              type="primary"
              :disabled="!canDoSubmit || busy"
              :loading="submitMutation.pending.value"
              @click="open('submit')"
            >
              提交
            </ElButton>
            <span v-if="!canDoSubmit" class="w-order-reason">{{ submitBlockedReason }}</span>
          </div>

          <div class="w-order-action">
            <ElButton size="large" :disabled="!canDoWithdraw || busy" :loading="withdrawMutation.pending.value" @click="open('withdraw')">
              撤回
            </ElButton>
            <span v-if="!canDoWithdraw" class="w-order-reason">{{ reason ?? '只有待审核的单据可以撤回。' }}</span>
          </div>

          <div class="w-order-action">
            <ElButton size="large" type="primary" :disabled="!canDoAudit || busy" @click="open('approve')">审核通过</ElButton>
            <ElButton size="large" type="danger" :disabled="!canDoAudit || busy" @click="open('reject')">驳回</ElButton>
            <span v-if="!canDoAudit" class="w-order-reason">{{ reason ?? '只有待审核的单据可以审核。' }}</span>
          </div>
        </div>
      </SectionBlock>
    </StateHost>

    <ActionDock>
      <ElButton size="large" :loading="loading" @click="reload">刷新</ElButton>
    </ActionDock>

    <ElDialog
      :model-value="pending !== undefined"
      :title="actionTitle"
      width="var(--w-size-dialog-max-width)"
      append-to-body
      :close-on-click-modal="false"
      @update:model-value="(v: boolean) => { if (!v) close(); }"
    >
      <p class="w-order-hint">
        {{
          pending === 'approve'
            ? '审核通过会按明细增减库存，这一步不能撤销。'
            : pending === 'reject'
              ? '驳回原因会写进单据备注发回建单人。'
              : '确认后单据状态会立即变化。'
        }}
      </p>
      <ElInput
        v-if="pending === 'reject'"
        v-model="rejectReason"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 4 }"
        placeholder="例如：明细与实际到货不符，请核对后重提"
      />
      <p v-if="actionError" class="w-order-error" role="alert">{{ actionError }}</p>
      <template #footer>
        <ElButton size="large" :disabled="busy" @click="close">取消</ElButton>
        <ElButton
          size="large"
          :type="pending === 'reject' ? 'danger' : 'primary'"
          :loading="busy"
          :disabled="busy"
          @click="confirm"
        >
          确定
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

.w-order-notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-order-actions {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
}

.w-order-action {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

/* 不能点的原因写在按钮旁边：让操作员点一下才发现没反应，等于把服务端实现细节丢给用户 */
.w-order-reason {
  flex-basis: 100%;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-order-hint {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-order-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
}
</style>
