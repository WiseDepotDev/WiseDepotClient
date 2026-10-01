<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, humanize, useMutation, useResource, type BridgeErrorLike } from '@wise/stores';
import { ActionDock, Mono, PageHeader, SectionBlock, StateHost, StatusChip } from '@wise/ui';

/**
 * 新建巡检任务 —— 现场域巡检的「写」入口：任务从哪来。
 * 语义逐条对齐 `packages/features/src/field/InspectionTaskCreateScreen.tsx`。
 *
 * 三条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **三个关联项做成「填序号 + 下方列出可选值」，不做成下拉框**：现场手上有编号时直接敲数字，
 *    不确定就看下面的列表（列表里给的是仓库名 / 设备名 / 计划名，不是裸编号）。
 *    **填了但解析不出来时给字段级错误并禁止提交** —— 静默当 0 发出去，
 *    会让现场在事后对账时才发现里程记错了，比当场报错贵得多。
 * 2. **选填就是选填**：三个序号与目标里程都留得空，留空时**不把这一项放进请求**，
 *    而不是放 `null` / `0` —— 后端要区分"没填"与"填了 0"。
 * 3. **选项取数失败不阻断表单**：三块可选值各自独立三态，失败只影响自己那一块
 *    （React 版的 `ListStateHost` 就是按块接错误，这里用 `StateHost` 保持同一粒度）。
 *
 * 一处**有意偏离 React 版**（真后端源码为准，见 `InspectionApplicationService`）：
 * **仓库是硬要求** —— 服务层有「仓库ID不能为空」与「仓库不存在」两处判断，
 * 而设备、计划、目标里程在 DTO 上没有任何校验注解。React 版把仓库也标成"选填"，
 * 于是用户不选仓库时必被后台拒绝；这里在界面上拦住并说明原因，字段标签仍与 React 版一致。
 */
interface PlanRow {
  readonly planId?: number;
  readonly planName?: string;
}

interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
}

interface DeviceRow {
  readonly deviceId?: number;
  readonly deviceName?: string;
  readonly deviceCode?: string;
}

/** 选项统一形状：界面上只认「序号 + 可读名称 + 业务编号」三件事。 */
interface OptionRow {
  readonly id: number;
  readonly name: string;
  readonly code: string;
}

function planOptions(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const plan of asList<PlanRow>(value)) {
    if (plan.planId === undefined) {
      continue;
    }
    // 没有名称时也要能选：给出"巡检计划 3"这样的可读兜底，不把裸编号丢给操作员
    rows.push({ id: plan.planId, name: plan.planName ?? `巡检计划 ${plan.planId}`, code: '' });
  }
  return rows;
}

function warehouseOptions(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const warehouse of asList<WarehouseRow>(value)) {
    if (warehouse.warehouseId === undefined) {
      continue;
    }
    rows.push({
      id: warehouse.warehouseId,
      name: warehouse.warehouseName ?? `仓库 ${warehouse.warehouseId}`,
      code: warehouse.warehouseCode ?? '',
    });
  }
  return rows;
}

function deviceOptions(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const device of asList<DeviceRow>(value)) {
    if (device.deviceId === undefined) {
      continue;
    }
    rows.push({
      id: device.deviceId,
      name: device.deviceName ?? `设备 ${device.deviceId}`,
      code: device.deviceCode ?? '',
    });
  }
  return rows;
}

/**
 * 序号解析结果。
 *
 * 写成全必填字段而不是「可选属性」：本项目开着 `exactOptionalPropertyTypes`，
 * 让某个分支显式返回 `undefined` 给可选属性会直接编不过；全必填在取值侧也少一层兜底。
 */
interface IdParse {
  readonly kind: 'empty' | 'ok' | 'invalid';
  readonly id: number | undefined;
}

/** 序号解析：空 = 没选（合法），正整数 = 选好了，其余都是"填错了"。 */
function parseId(raw: string): IdParse {
  const text = raw.trim();
  if (text === '') {
    return { kind: 'empty', id: undefined };
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid', id: undefined };
  }
  return { kind: 'ok', id: parsed };
}

function idOf(raw: string): number | undefined {
  return parseId(raw).id;
}

function idErrorText(raw: string, label: string): string | undefined {
  return parseId(raw).kind === 'invalid' ? `${label}要填大于 0 的整数，例如 12` : undefined;
}

/** 目标里程：空 = 不设目标（合法），其余必须是大于 0 的数字。 */
function parseDistance(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function distanceErrorText(raw: string): string | undefined {
  const text = raw.trim();
  return text !== '' && parseDistance(text) === undefined ? '目标里程要填大于 0 的数字，例如 120.5' : undefined;
}

interface CreatedTask {
  readonly taskId: number | undefined;
  readonly taskCode: string | undefined;
}

/**
 * 从创建任务的返回里读出"刚建的是哪一个"。
 *
 * 字段名做兜底（`taskId` / `id`、`taskCode` / `code`）是**刻意**的：这一屏的全部价值
 * 就是给出新任务的编号，返回形状一旦不同就白建了；读不出来时宁可少显示，也不猜。
 */
function createdTaskOf(value: unknown): CreatedTask | undefined {
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record['data'] ?? record['result'];
  const source =
    nested !== undefined && nested !== null && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : record;
  const rawId = source['taskId'] ?? source['id'];
  const rawCode = source['taskCode'] ?? source['code'];
  const taskId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
  const taskCode = typeof rawCode === 'string' && rawCode.trim() !== '' ? rawCode : undefined;
  return taskId === undefined && taskCode === undefined ? undefined : { taskId, taskCode };
}

const router = useRouter();

const planQuery = ref('');
const warehouseQuery = ref('');
const deviceQuery = ref('');
const distanceQuery = ref('');
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);
const created = ref<CreatedTask | undefined>(undefined);

const createMutation = useMutation<unknown>('inspection.taskCreate');
const busy = computed(() => createMutation.pending.value);

// 三个选项列表都常驻取数（没有前置条件），失败只影响当前这一块，不阻断整屏
const plans = useResource<unknown>('inspection.planList', {});
// `warehouse.list` 服务端**不分页**（`WarehouseController:34` 只接 keyword，返回全量 List），
// 所以既不传 page/size，也不需要 OPTION_PAGE_SIZE —— 传了会被静默忽略，只会让人以为它在起作用。
const warehouses = useResource<unknown>('warehouse.list');
const devices = useResource<unknown>('device.list', {});

const planRows = computed(() => planOptions(plans.data.value));
const warehouseRows = computed(() => warehouseOptions(warehouses.data.value));
const deviceRows = computed(() => deviceOptions(devices.data.value));

const planId = computed(() => idOf(planQuery.value));
const warehouseId = computed(() => idOf(warehouseQuery.value));
const deviceId = computed(() => idOf(deviceQuery.value));
const targetDistance = computed(() => parseDistance(distanceQuery.value));

const planError = computed(() => idErrorText(planQuery.value, '巡检计划序号'));
const warehouseError = computed(() => idErrorText(warehouseQuery.value, '仓库序号'));
const deviceError = computed(() => idErrorText(deviceQuery.value, '设备序号'));
const distanceError = computed(() => distanceErrorText(distanceQuery.value));

/**
 * 仓库为空也拦下来：服务端对空仓库报「仓库ID不能为空」、对不存在的仓库报「仓库不存在」，
 * 与其让用户提交后被拒，不如在按钮上方就把原因说清楚。
 *
 * **所以这一项的标签写「（必填）」**（模板里 `执行仓库序号（必填）`）：标签若照旧写「（选填）」，
 * 而界面又不让留空提交，屏幕上就自相矛盾了 —— 同一类问题就是本轮修掉的「开始执行发错值」：
 * 界面在跟服务端唱反调。其余三项服务端 DTO 上没有任何校验注解，标签才保持「（选填）」。
 */
const missingWarehouse = computed(() => warehouseId.value === undefined);

const formError = computed(
  () => planError.value ?? warehouseError.value ?? deviceError.value ?? distanceError.value,
);

const selectedCount = computed(
  () => [planId.value, warehouseId.value, deviceId.value].filter((id) => id !== undefined).length,
);

const canSubmit = computed(() => !busy.value && formError.value === undefined && !missingWarehouse.value);

/** 选中的那一条按序号回找：列表里没有它（或被筛掉了）时给"名称未登记"，不猜名字。 */
function planName(): string {
  return planRows.value.find((option) => option.id === planId.value)?.name ?? '名称未登记';
}

function warehouseName(): string {
  return warehouseRows.value.find((option) => option.id === warehouseId.value)?.name ?? '名称未登记';
}

function deviceName(): string {
  return deviceRows.value.find((option) => option.id === deviceId.value)?.name ?? '名称未登记';
}

const planSelection = computed(() => (planId.value === undefined ? '未选择' : planName()));
const warehouseSelection = computed(() => (warehouseId.value === undefined ? '未选择' : warehouseName()));
const deviceSelection = computed(() => (deviceId.value === undefined ? '未选择' : deviceName()));

function reloadOptions(): void {
  plans.reload();
  warehouses.reload();
  devices.reload();
}

/**
 * 选项行的下拉：数字说明操作员已经知道编号，此时**不拿这个数字去筛列表** ——
 * 否则他正要选的那一条会被自己筛掉；填的是文字时按名称 + 业务编号筛。
 */
function visibleOptions(rows: readonly OptionRow[], query: string): readonly OptionRow[] {
  const text = query.trim();
  if (text === '' || idOf(text) !== undefined) {
    return rows;
  }
  const keyword = text.toLowerCase();
  return rows.filter((option) => `${option.name}${option.code}`.toLowerCase().includes(keyword));
}

/**
 * 点列表里的某一条 = 把它的序号写进上方的输入框（输入框与列表共用同一个来源）。
 *
 * 三个关联项各给一个具名函数、而不是传 `Ref`：模板里 `planQuery` 已经被自动解包成
 * `string`，把 `Ref` 当参数类型只会在 `vue-tsc` 下报"string 不能赋给 Ref<string>"。
 */
function usePlan(id: number): void {
  planQuery.value = String(id);
}

function useWarehouse(id: number): void {
  warehouseQuery.value = String(id);
}

function useDevice(id: number): void {
  deviceQuery.value = String(id);
}

async function submit(): Promise<void> {
  if (formError.value !== undefined) {
    actionError.value = '还有填写不正确的地方，请先按字段下方的提示改正，再创建任务。';
    return;
  }
  if (missingWarehouse.value) {
    actionError.value = '还没有指定仓库。巡检任务必须落在某个仓库上，请填仓库序号或在下面的列表里点选一个。';
    return;
  }
  actionError.value = undefined;
  notice.value = undefined;
  try {
    /*
     * 只把真的填了的项放进请求：留空 = 不指定，不是 0。
     * `planId` / `deviceId` / `targetDistance` 在服务端 DTO 上没有校验注解，
     * 所以它们可以不发；仓库已经在上面拦过了。
     */
    const params: Record<string, number> = {};
    const plan = planId.value;
    const warehouse = warehouseId.value;
    const device = deviceId.value;
    const distance = targetDistance.value;
    if (plan !== undefined) {
      params['planId'] = plan;
    }
    if (warehouse !== undefined) {
      params['warehouseId'] = warehouse;
    }
    if (device !== undefined) {
      params['deviceId'] = device;
    }
    if (distance !== undefined) {
      params['targetDistance'] = distance;
    }
    const value = await createMutation.run(params);
    created.value = createdTaskOf(value);
    notice.value = '任务已创建。接下来到「巡检任务」里把任务开起来，现场就能按它盘点了。';
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

function goCreatedDetail(): void {
  const id = created.value?.taskId;
  if (id !== undefined) {
    void router.push({ name: 'inspection.taskDetail', params: { taskId: String(id) } });
  }
}

/**
 * Element Plus 的属性整块给、且放宽成 `any`。
 *
 * `ElInput` 的 props 类型在 `vue-tsc` 下解不开，逐属性写会被当成"属性定义对象"校验而报错。
 * 运行期完全一样 —— 这是**类型层绕行**，不是行为差异（同 `@wise/ui` 的 FilterBar 等）。
 */
function fieldProps(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="新建巡检任务" note="指定巡检计划、执行仓库与设备后创建任务；不指定的项目留空即可">
      <template #actions>
        <ElButton size="large" :disabled="busy" @click="reloadOptions">刷新可选值</ElButton>
      </template>
    </PageHeader>

    <p v-if="actionError" class="w-inspection-create__error" role="alert">{{ actionError }}</p>

    <SectionBlock v-if="notice" title="创建结果">
      <div class="w-inspection-create__card">
        <p class="w-inspection-create__notice" role="status">{{ notice }}</p>
        <dl class="w-inspection-create__result">
          <dt class="w-inspection-create__result-label">新任务序号</dt>
          <dd class="w-inspection-create__result-value">
            <Mono
              :text="created?.taskId !== undefined ? String(created.taskId) : '后台没有回传，请到「巡检任务」列表里查看'"
            />
          </dd>
          <dt class="w-inspection-create__result-label">任务号</dt>
          <dd class="w-inspection-create__result-value">
            <Mono :text="created?.taskCode ?? '后台没有回传，以列表里的任务号为准'" />
          </dd>
        </dl>
        <p class="w-inspection-create__hint">
          {{
            created?.taskId === undefined
              ? '任务已经建好，但这次没有拿到任务序号。到「巡检任务」列表刷新一次即可看到它。'
              : '记下这个序号：开始盘点、上传数据、事后补录都要用它。'
          }}
        </p>
        <ElButton v-if="created?.taskId !== undefined" size="large" type="primary" @click="goCreatedDetail">
          查看该任务
        </ElButton>
      </div>
    </SectionBlock>

    <SectionBlock title="任务信息">
      <div class="w-inspection-create__stack">
        <div class="w-inspection-create__card">
          <p class="w-inspection-create__label">巡检计划序号（选填）</p>
          <ElInput
            v-model="planQuery"
            v-bind="fieldProps({ size: 'large', clearable: true, placeholder: '计划序号，如：3', class: 'w-inspection-create__id-input' })"
          />
          <p v-if="planError" class="w-inspection-create__field-error" role="alert">{{ planError }}</p>
          <div class="w-inspection-create__row">
            <StatusChip :text="`已选：${planSelection}`" :tone="planId !== undefined ? 'success' : 'neutral'" />
            <ElButton size="large" :disabled="planQuery === ''" @click="planQuery = ''">清除</ElButton>
          </div>
          <StateHost
            :loading="plans.loading.value"
            :error="plans.error.value ?? null"
            :error-text="plans.error.value ? humanize(plans.error.value) : undefined"
            :empty="visibleOptions(planRows, planQuery).length === 0"
            empty-text="还没有可选的巡检计划。可以留空直接创建任务，或请管理员先建立巡检计划。"
            skeleton="list"
            @retry="plans.reload"
          >
            <div class="w-inspection-create__options">
              <div
                v-for="option in visibleOptions(planRows, planQuery)"
                :key="option.id"
                class="w-inspection-create__option"
                :class="{ 'w-inspection-create__option--active': planId === option.id }"
              >
                <span class="w-inspection-create__option-name">{{ option.name }}</span>
                <span class="w-inspection-create__option-code">{{ option.code !== '' ? option.code : `序号 ${option.id}` }}</span>
                <StatusChip v-if="planId === option.id" text="已选" tone="success" />
                <ElButton v-else size="large" @click="usePlan(option.id)">选它</ElButton>
              </div>
            </div>
          </StateHost>
          <p class="w-inspection-create__hint">
            选填。输入计划名称里的字可以筛选下面的列表；不选计划也能创建任务。
          </p>
        </div>

        <div class="w-inspection-create__card">
          <p class="w-inspection-create__label">执行仓库序号（必填）</p>
          <ElInput
            v-model="warehouseQuery"
            v-bind="fieldProps({ size: 'large', clearable: true, placeholder: '仓库序号，如：1', class: 'w-inspection-create__id-input' })"
          />
          <p v-if="warehouseError" class="w-inspection-create__field-error" role="alert">{{ warehouseError }}</p>
          <div class="w-inspection-create__row">
            <StatusChip
              :text="`已选：${warehouseSelection}`"
              :tone="warehouseId !== undefined ? 'success' : 'neutral'"
            />
            <ElButton size="large" :disabled="warehouseQuery === ''" @click="warehouseQuery = ''">清除</ElButton>
          </div>
          <StateHost
            :loading="warehouses.loading.value"
            :error="warehouses.error.value ?? null"
            :error-text="warehouses.error.value ? humanize(warehouses.error.value) : undefined"
            :empty="visibleOptions(warehouseRows, warehouseQuery).length === 0"
            empty-text="还没有可选的仓库。请先到「仓库管理」建一个仓库，或请管理员为你开通仓库权限。"
            skeleton="list"
            @retry="warehouses.reload"
          >
            <div class="w-inspection-create__options">
              <div
                v-for="option in visibleOptions(warehouseRows, warehouseQuery)"
                :key="option.id"
                class="w-inspection-create__option"
                :class="{ 'w-inspection-create__option--active': warehouseId === option.id }"
              >
                <span class="w-inspection-create__option-name">{{ option.name }}</span>
                <span class="w-inspection-create__option-code">{{ option.code !== '' ? option.code : `序号 ${option.id}` }}</span>
                <StatusChip v-if="warehouseId === option.id" text="已选" tone="success" />
                <ElButton v-else size="large" @click="useWarehouse(option.id)">选它</ElButton>
              </div>
            </div>
          </StateHost>
          <p class="w-inspection-create__hint">
            仓库是必须指定的：任务要落在某个仓库上才能盘点。填仓库序号，或直接点下面列表里的仓库。
          </p>
        </div>

        <div class="w-inspection-create__card">
          <p class="w-inspection-create__label">执行设备序号（选填）</p>
          <ElInput
            v-model="deviceQuery"
            v-bind="fieldProps({ size: 'large', clearable: true, placeholder: '设备序号，如：12', class: 'w-inspection-create__id-input' })"
          />
          <p v-if="deviceError" class="w-inspection-create__field-error" role="alert">{{ deviceError }}</p>
          <div class="w-inspection-create__row">
            <StatusChip :text="`已选：${deviceSelection}`" :tone="deviceId !== undefined ? 'success' : 'neutral'" />
            <ElButton size="large" :disabled="deviceQuery === ''" @click="deviceQuery = ''">清除</ElButton>
          </div>
          <StateHost
            :loading="devices.loading.value"
            :error="devices.error.value ?? null"
            :error-text="devices.error.value ? humanize(devices.error.value) : undefined"
            :empty="visibleOptions(deviceRows, deviceQuery).length === 0"
            empty-text="还没有可选的设备。可以留空直接创建任务，或先到「设备管理」登记一台设备。"
            skeleton="list"
            @retry="devices.reload"
          >
            <div class="w-inspection-create__options">
              <div
                v-for="option in visibleOptions(deviceRows, deviceQuery)"
                :key="option.id"
                class="w-inspection-create__option"
                :class="{ 'w-inspection-create__option--active': deviceId === option.id }"
              >
                <span class="w-inspection-create__option-name">{{ option.name }}</span>
                <span class="w-inspection-create__option-code">{{ option.code !== '' ? option.code : `序号 ${option.id}` }}</span>
                <StatusChip v-if="deviceId === option.id" text="已选" tone="success" />
                <ElButton v-else size="large" @click="useDevice(option.id)">选它</ElButton>
              </div>
            </div>
          </StateHost>
          <p class="w-inspection-create__hint">
            选填。输入设备名称里的字可以筛选下面的列表；不选设备就按不指定设备创建。
          </p>
        </div>

        <div class="w-inspection-create__card">
          <p class="w-inspection-create__label">目标里程（米，选填）</p>
          <ElInput
            v-model="distanceQuery"
            v-bind="fieldProps({ size: 'large', clearable: true, placeholder: '如：120.5', class: 'w-inspection-create__id-input' })"
          />
          <p v-if="distanceError" class="w-inspection-create__field-error" role="alert">{{ distanceError }}</p>
          <p class="w-inspection-create__hint">只填数字，单位是米（可以带小数）。不填表示这个任务不设目标里程。</p>
        </div>
      </div>
    </SectionBlock>

    <!-- 主操作钉在底部：表单滚多长都不用找它 -->
    <ActionDock>
      <span class="w-inspection-create__hint">{{ `已选 ${selectedCount}/3 项` }}</span>
      <!-- 按钮为什么灰着，就写在按钮旁边：现场不会去猜一个点不动的按钮 -->
      <span v-if="missingWarehouse" class="w-inspection-create__hint">
        还缺仓库：任务必须落在某个仓库上，填仓库序号或点选一个仓库后才能创建。
      </span>
      <ElButton size="large" type="primary" :loading="busy" :disabled="!canSubmit" @click="submit">
        {{ busy ? '创建中…' : '创建任务' }}
      </ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
.w-inspection-create__stack {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
}

.w-inspection-create__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inspection-create__label {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-label-medium-size);
  font-weight: var(--w-type-label-medium-weight);
}

/* 序号与机器编号一律等宽：0/O、1/l 在普通字体里会误读 */
.w-inspection-create__id-input {
  width: 100%;
  font-family: var(--w-font-mono);
}

.w-inspection-create__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-top: var(--w-space-inline-gap);
}

.w-inspection-create__options {
  display: flex;
  flex-direction: column;
}

.w-inspection-create__option {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  min-height: var(--w-space-touch-target-min);
  padding: var(--w-space-list-item-v) 0;
  border-bottom: 1px solid var(--w-color-outline-subtle);
}

.w-inspection-create__option--active {
  background: var(--w-color-primary-soft);
}

.w-inspection-create__option-name {
  flex: 1 1 auto;
  min-width: var(--w-size-card-min-width);
  color: var(--w-color-on-surface);
}

.w-inspection-create__option-code {
  color: var(--w-color-on-surface-muted);
  font-family: var(--w-font-mono);
  font-size: var(--w-type-mono-size);
}

.w-inspection-create__hint {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-create__field-error {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-create__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-create__notice {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface);
  font-size: var(--w-type-body-size);
}

.w-inspection-create__result {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--w-space-inline-gap) var(--w-space-group-gap);
  margin: 0;
}

.w-inspection-create__result-label {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-create__result-value {
  margin: 0;
  color: var(--w-color-on-surface);
}
</style>
