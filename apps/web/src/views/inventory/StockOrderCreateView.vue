<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElForm, ElFormItem, ElInput, ElOption, ElRadioButton, ElRadioGroup, ElSelect } from 'element-plus';
import { asList, humanize, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, PageHeader, SectionBlock, StateHost } from '@wise/ui';

/**
 * 新建出入库单（`stockOrder.create`）。
 *
 * ## 为什么 `orderNo` 必须客户端给
 *
 * 服务端**不生成单号**（真后端实测：不给就报 `VAL-0001 单据编号不能为空`），
 * `createBy` 也必须带（否则不知道建单人）。旧版在列表页内联过一个只有
 * `{warehouseId, remark}` 的建单表单 —— 那个入口**永远是失败的**。
 *
 * 默认单号是 `IN-20260930-2235`（类型 + 日期 + 时分）：客户端不掌握"当天开到第几号"，
 * 硬凑流水号会在两人同时建单时撞车；日期+时分一眼能看出是哪批货，撞了也能当场改掉。
 *
 * **状态留空**（服务端默认待审批）、**明细留空**（逐条加明细在详情屏里做）——
 * 只发服务端真正需要的字段。
 */
type OrderTypeCode = 'IN' | 'OUT';

interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
}

interface CurrentUser {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
}

interface CreatedOrder {
  /** 两个字段都可能缺：接口返回的形状见过两种（`orderId`/`id`、`orderNo`/`orderCode`）。 */
  readonly orderId: number | undefined;
  readonly orderNo: string | undefined;
}

const ORDER_TYPES: readonly { value: OrderTypeCode; label: string; prefix: string }[] = [
  { value: 'IN', label: '入库', prefix: 'IN' },
  { value: 'OUT', label: '出库', prefix: 'OUT' },
];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function defaultOrderNo(type: OrderTypeCode, now: Date): string {
  const prefix = ORDER_TYPES.find((t) => t.value === type)?.prefix ?? 'IN';
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  return `${prefix}-${date}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

/** 详情接口返回的字段名做过兜底（`orderId`/`id`、`orderNo`/`orderCode`）—— 两种形状都见过。 */
function createdOrderOf(value: unknown): CreatedOrder | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const rawId = source['orderId'] ?? source['id'];
  const rawNo = source['orderNo'] ?? source['orderCode'];
  const orderId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
  const orderNo = typeof rawNo === 'string' && rawNo.trim() !== '' ? rawNo : undefined;
  return orderId === undefined && orderNo === undefined ? undefined : { orderId, orderNo };
}

const router = useRouter();
const cache = useResourceCacheStore();

const orderType = ref<OrderTypeCode>('IN');
const orderNo = ref(defaultOrderNo('IN', new Date()));
const orderNoTouched = ref(false);
const warehouseId = ref<string>('');
const remark = ref('');
const created = ref<CreatedOrder | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

// `warehouse.list` 服务端**不分页**（`WarehouseController:34` 只接 keyword，返回全量 List），
// 所以既不传 page/size，也不需要 OPTION_PAGE_SIZE —— 传了会被静默忽略，只会让人以为它在起作用。
const warehouses = useResource<unknown>('warehouse.list');
const users = useResource<unknown>('user.current');

const warehouseOptions = computed(() =>
  asList<WarehouseRow>(warehouses.data.value)
    .filter((w): w is WarehouseRow & { warehouseId: number } => typeof w.warehouseId === 'number')
    .map((w) => ({ value: String(w.warehouseId), label: `${w.warehouseName ?? '未命名'}（${w.warehouseCode ?? '—'}）` })),
);

const currentUser = computed(() => users.data.value as CurrentUser | undefined);
const currentUserId = computed(() => currentUser.value?.userId);
const canIdentifyUser = computed(() => typeof currentUserId.value === 'number' && Number.isFinite(currentUserId.value));

const createMutation = useMutation('stockOrder.create');
const busy = computed(() => createMutation.pending.value);

/**
 * Element Plus 的属性整块给、且放宽成 `any`。
 *
 * `ElSelect` / `ElOption` / `ElRadioButton` 这批组件的 `buildProps` 结果类型在
 * `vue-tsc` 下解析不出来，逐属性写 `size="large"` 会被当成"属性定义对象"校验而报错。
 * 运行期完全一样 —— 这是**类型层绕行**，不是行为差异。同类绕行见
 * `@wise/ui` 的 FilterBar / PaginationBar / ResponsiveDataView 与 `@wise/layouts` 的 AppFrame。
 */
const selectProps: any = { size: 'large', placeholder: '选择仓库', class: 'w-order-field' };
function optionProps(opt: { value: string; label: string }): any {
  return { label: opt.label, value: opt.value };
}
function radioProps(value: string): any {
  return { value };
}

// 用户没碰过单号时，切类型自动换前缀 —— 碰过就不动，避免把用户手输的单号覆盖掉
watch(orderType, (next) => {
  if (!orderNoTouched.value) {
    orderNo.value = defaultOrderNo(next, new Date());
  }
});

onMounted(() => {
  void warehouses.reload();
  void users.reload();
});

async function submit(): Promise<void> {
  if (!canIdentifyUser.value) {
    actionError.value = '还没有拿到当前登录的账号，无法记录建单人。界面会自动重试，或重新登录后再建单。';
    return;
  }
  if (orderNo.value.trim() === '') {
    actionError.value = '单号不能为空，请填写一个能认出来的单号。';
    return;
  }
  if (warehouseId.value === '') {
    actionError.value = '请先选择仓库。';
    return;
  }
  actionError.value = undefined;
  notice.value = undefined;
  try {
    const payload: Record<string, unknown> = {
      orderNo: orderNo.value.trim(),
      warehouseId: Number(warehouseId.value),
      orderType: orderType.value,
      createBy: currentUserId.value,
    };
    const trimmedRemark = remark.value.trim();
    if (trimmedRemark !== '') {
      payload['remark'] = trimmedRemark;
    }
    const value = await createMutation.run(payload);
    created.value = createdOrderOf(value);
    cache.invalidate('stockOrder');
    notice.value = '单据已建好，当前是待审批状态。接下来到单据里逐条登记明细，再提交审核。';
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

function goDetail(): void {
  const id = created.value?.orderId;
  if (id !== undefined) {
    void router.push({ name: 'stockOrder.detail', params: { orderId: String(id) } });
  }
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="新建出入库单" note="建单后到单据里逐条登记明细，再提交审核" />

    <p v-if="notice" class="w-order-notice" role="status">{{ notice }}</p>

    <SectionBlock title="单据信息">
      <div class="w-card">
        <ElForm label-position="top">
          <ElFormItem label="单据类型">
            <ElRadioGroup v-model="orderType" size="large">
              <ElRadioButton v-for="t in ORDER_TYPES" :key="t.value" v-bind="radioProps(t.value)">{{ t.label }}</ElRadioButton>
            </ElRadioGroup>
          </ElFormItem>

          <ElFormItem label="单号（必填，服务端不生成）">
            <ElInput
              v-model="orderNo"
              size="large"
              placeholder="例如：IN-20260930-2235"
              @update:model-value="() => (orderNoTouched = true)"
            />
          </ElFormItem>

          <ElFormItem label="仓库（必填）">
            <ElSelect v-model="warehouseId" v-bind="selectProps">
              <ElOption v-for="opt in warehouseOptions" :key="opt.value" v-bind="optionProps(opt)" />
            </ElSelect>
          </ElFormItem>

          <ElFormItem label="建单人">
            <ElInput
              :model-value="currentUser?.nickname ?? currentUser?.username ?? '未取到当前账号'"
              size="large"
              disabled
            />
          </ElFormItem>

          <ElFormItem label="备注">
            <ElInput v-model="remark" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="例如：到货批次 / 领用部门" />
          </ElFormItem>
        </ElForm>
        <p v-if="actionError" class="w-order-error" role="alert">{{ actionError }}</p>
        <p v-if="!canIdentifyUser" class="w-order-hint">
          建单人来自当前登录账号；取不到就无法建单（服务端要求带 `createBy`）。
        </p>
      </div>
    </SectionBlock>

    <ActionDock>
      <ElButton v-if="created?.orderId !== undefined" size="large" type="primary" @click="goDetail">
        去登记明细
      </ElButton>
      <ElButton size="large" type="primary" :loading="busy" :disabled="busy" @click="submit">建单</ElButton>
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

.w-order-field {
  width: 100%;
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

.w-order-error {
  margin: var(--w-space-inline-gap) 0 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-order-hint {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}
</style>
