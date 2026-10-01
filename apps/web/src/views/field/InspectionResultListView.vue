<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElButton, ElInput } from 'element-plus';
import { asList, humanize, shortTime, useMutation, useResource, type BridgeErrorLike } from '@wise/stores';
import {
  KeyValuePanel,
  ConfirmDialog,
  PageHeader,
  ResponsiveDataView,
  SectionBlock,
  StateHost,
  StatusChip,
  type ColumnDef,
  type KeyValueItem,
  type StatusTone,
} from '@wise/ui';

/**
 * 巡检结果列表 —— 盘点做完之后的落点：看每个任务盘出了什么，并把结果确认下来。
 * 语义逐条对齐 `packages/features/src/field/InspectionResultListScreen.tsx`。
 *
 * 四条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **按任务过滤是服务端的活**：真后端 `listResults(taskId, warehouseId, status)` 支持 `taskId`，
 *    而且**不分页**（返回 `List`，没有 page/pageSize）。所以带 `?taskId=` 进来时把 `taskId`
 *    **作为参数发给服务端**，绝不本地过滤 —— 本地过滤会在"结果条数超过一页"时静默地只筛掉手上这部分，
 *    现场看到的是"这个任务只有 2 条结果"，而它其实有 20 条。
 * 2. **确认是不可逆操作**：确认之后盘点差异就成为账实结论、可能触发库存调整，
 *    因此走 `ConfirmDialog` 二次确认，且确认框里把"哪个任务、差异多少"再说一遍，
 *    避免用户在列表里点错行。
 * 3. **未确认的结果默认排在前面**（服务端顺序之上再做一次稳定分组）：
 *    这一屏的主要工作就是"把没确认的确认掉"，让待办先露头。
 * 4. **没有选中结果时不拉详情**：详情接口要 resultId，空手调一次只会拿回一个必然是错的响应，
 *    还在日志里装成"这一屏一直报错"（`useResource` 的 `enabled` 就是为此存在）。
 *
 * 一条**不能当已知事实**的地方，见 `isConfirmed` 上方的注释：
 * 结果 `status` 的真实取值口径至今没有实测样本。
 */

interface ResultRow {
  readonly resultId?: number;
  readonly taskId?: number;
  readonly compareTime?: string;
  readonly totalItems?: number;
  readonly normalItems?: number;
  readonly missingItems?: number;
  readonly extraItems?: number;
  readonly createTime?: string;
  readonly progress?: number;
  readonly status?: string;
  readonly totalScanned?: number;
  readonly totalExpected?: number;
}

type ResultFilter = 'all' | 'pending' | 'confirmed';

/**
 * 这条结果算不算"已确认"。
 *
 * React 版按 `CONFIRMED` / `DONE` / `COMPLETED` / `已确认` 四档判，这里照抄 ——
 * 但**该取值口径需要一个真结果样本才能确认**：服务端 `getResult` 里 `status` 是硬编码的
 * `"COMPLETED"`，而结果列表屏的筛选却按 `PENDING` / `CONFIRMED` 两档写，两者对不上。
 * 所以这里只是把 React 的判定原样搬过来，**不是**"服务端确实会回这些值"的证据。
 */
function isConfirmed(result: ResultRow): boolean {
  const status = (result.status ?? '').toUpperCase();
  return status === 'CONFIRMED' || status === 'DONE' || status === 'COMPLETED' || status === '已确认';
}

/** 状态文案：认不出来的一律说"待确认"，不把英文枚举原文画到界面上。 */
function statusText(result: ResultRow): string {
  if (!result.status) {
    return '待确认';
  }
  if (isConfirmed(result)) {
    return '已确认';
  }
  const status = result.status.toUpperCase();
  if (status === 'PENDING') {
    return '待确认';
  }
  return result.status;
}

/** 芯片语气与"未确认=待办"的口径一致：确认过的绿、没确认的橙。 */
function statusTone(result: ResultRow): StatusTone {
  return isConfirmed(result) ? 'success' : 'warning';
}

/** 差异条数 = 盘亏 + 盘盈。真后端空字段回 `null`，所以要 `?? 0` 兜住。 */
function abnormalCount(result: ResultRow): number {
  return (result.missingItems ?? 0) + (result.extraItems ?? 0);
}

function hasContent(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

function resultOf(value: unknown): ResultRow | undefined {
  if (!hasContent(value)) {
    return undefined;
  }
  const first = asList<ResultRow>(value)[0];
  return first !== undefined ? first : (value as ResultRow);
}

/** 结果序号 → 正整数。转不出来就当"没有目标"，不发一个必然是错的请求。 */
function parseId(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 路由参数 → 正整数。
 *
 * 三个兜底缺一不可：`noUncheckedIndexedAccess` 下 `params['x']` 本来就是
 * `string | string[] | undefined`（重复参数会成数组），而**查询串**里还会出现 `null`
 * （`?taskId=` 这种"有键没值"的写法），所以先取第一个元素、再判类型、最后判正整数。
 * 任何一档过不了就返回 `undefined` —— 宁可不选中，也不拿一个必然是错的序号去请求。
 */
function idParam(value: string | readonly (string | null)[] | null | undefined): number | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? parseId(text) : undefined;
}

const route = useRoute();
const router = useRouter();

/**
 * 从任务详情推进来时带 `?taskId=`：直接按任务问服务端要结果，不用用户再敲一遍。
 *
 * 写成 `computed` 而不是启动时算一次的常量：路由**只换查询串**时组件实例会被复用，
 * 算一次就定死的值会停在旧任务上 —— 用户从任务 501 的结果跳到任务 502 的结果，
 * 屏上还是 501 的（"刷新一下就好了"的那类 bug）。
 */
const routeTaskId = computed<number | undefined>(() => idParam(route.query['taskId']));

/**
 * 带 `resultId` 进来就直接选中它并拉明细 —— 与 React 版的屏参数 `paramResultId` 同义。
 *
 * React 版**没有**独立的结果详情屏：`registry.tsx` 里 `inspection.resultDetail` 与
 * `inspection.resultList` 是**同一个** `InspectionResultListScreen`，「结果明细」只是这一屏里的一个面板，
 * `resultId` 唯一的作用就是"进来先选中哪一条"（`useState(paramResultId)`）。
 * 所以这里也只做"预选中"，不另开一屏。
 *
 * 同样是 `computed`：只换路径参数时组件会被复用，算一次就定死的值会停在旧结果上。
 */
const routeResultId = computed<number | undefined>(() => idParam(route.params['resultId']));

const keyword = ref('');
const applied = ref('');
const filter = ref<ResultFilter>('all');
/** 用户点过"看全部任务的结果"之后，即使 URL 里还带着 taskId 也不再把它显示成当前过滤条件。 */
const taskFilterCleared = ref(false);
/** 预选中的结果（同一批结果里直接换一条 = 改 `selectedId`，不动路由参数）。 */
const selectedId = ref<number | undefined>(routeResultId.value);
const pendingConfirm = ref<ResultRow | undefined>(undefined);
const actionError = ref<string | undefined>(undefined);
const notice = ref<string | undefined>(undefined);

/** 当前生效的任务过滤（服务端参数 + 筛选条展示的是同一个值）。 */
const taskParam = computed<number | undefined>(() => (taskFilterCleared.value ? undefined : routeTaskId.value));

/**
 * 服务端参数。`taskId` 只在真有值时才进参数表：`exactOptionalPropertyTypes` 下不能显式传
 * `undefined`，而"不发这个参数"与"发一个空 taskId"在服务端是两回事。
 */
const params = computed<Record<string, unknown>>(() =>
  taskParam.value === undefined ? {} : { taskId: taskParam.value },
);

const list = useResource<unknown>('inspection.resultList', params);
const all = computed(() => asList<ResultRow>(list.data.value));

/**
 * 换了任务过滤就必须丢掉已选中的结果：那一条属于上一个任务，
 * 留在下面会让"点确认"打到看不见的地方。
 *
 * 同时把"清除"标记收回来：地址栏换了新的 `?taskId=`，那就是用户这次的意图。
 */
watch(routeTaskId, () => {
  taskFilterCleared.value = false;
});
watch(taskParam, () => {
  selectedId.value = undefined;
  notice.value = undefined;
});

/**
 * 地址栏里的 `resultId` 变了 → 跟着换预选的那一条。
 *
 * `selectedId` 始终保持"最近一次意图"，两者一致时**不写回**：
 * 用户在面板里点了同一批结果中的另一条（只改 `selectedId`、不动路由）时，
 * 这里若无条件覆盖，点击就会被紧接着的 watch 抹掉。
 */
watch(routeResultId, (next) => {
  if (next !== selectedId.value) {
    selectedId.value = next;
    notice.value = undefined;
    actionError.value = undefined;
  }
});

/** 规则 4：没点过任何一条结果之前不发详情请求。 */
const hasDetailTarget = computed(() => selectedId.value !== undefined);
const detailParams = computed<Record<string, unknown>>(() =>
  selectedId.value === undefined ? {} : { resultId: selectedId.value },
);
const detail = useResource<unknown>('inspection.resultDetail', detailParams, { enabled: hasDetailTarget });

const pendingCount = computed(() => all.value.filter((row) => !isConfirmed(row)).length);

const rows = computed(() =>
  all.value
    .filter((row) => {
      if (filter.value === 'pending' && isConfirmed(row)) {
        return false;
      }
      if (filter.value === 'confirmed' && !isConfirmed(row)) {
        return false;
      }
      if (applied.value !== '') {
        /*
         * `?? ''` 是必需的：真后端对没填的字段回的是 `null` 而不是 `undefined`，
         * 直接拼串会得到 "null"，`.includes()` 也会在 null 上抛 TypeError。
         *
         * 这个关键字**只筛已经取回的这一批**（服务端没有关键字参数），所以工具条上标明"筛选本批"。
         * 它与上面的 `taskId` 不同：任务过滤是服务端做的，关键字过滤是本地做的。
         */
        const hay = `${row.taskId ?? ''}${row.resultId ?? ''}`;
        if (!hay.includes(applied.value)) {
          return false;
        }
      }
      return true;
    })
    // 未确认的排前面：这一屏的主要工作就是把待确认的结果处理掉
    // （`filter` 已经返回新数组，不必再 `slice()` 一份副本）
    .sort((a, b) => Number(isConfirmed(a)) - Number(isConfirmed(b))),
);

const shown = computed<ResultRow | undefined>(() => resultOf(detail.data.value));
const shownConfirmed = computed(() => shown.value !== undefined && isConfirmed(shown.value));
const shownAbnormal = computed(() => (shown.value === undefined ? 0 : abnormalCount(shown.value)));

const columns: readonly ColumnDef<ResultRow>[] = [
  {
    key: 'resultId',
    title: '结果序号',
    type: 'mono',
    width: 130,
    compact: 'primary',
    value: (r) => (r.resultId === undefined ? '结果序号未登记' : String(r.resultId)),
  },
  {
    key: 'taskId',
    title: '所属任务',
    type: 'mono',
    width: 120,
    compact: 'secondary',
    value: (r) => (r.taskId === undefined ? '未关联任务' : String(r.taskId)),
  },
  {
    key: 'compareTime',
    title: '比对时间',
    type: 'mono',
    width: 140,
    value: (r) => (r.compareTime ? shortTime(r.compareTime) : '比对时间未记录'),
  },
  {
    key: 'totalExpected',
    title: '应盘',
    type: 'mono',
    width: 90,
    align: 'right',
    value: (r) => String(r.totalExpected ?? r.totalItems ?? 0),
  },
  {
    key: 'totalScanned',
    title: '实扫',
    type: 'mono',
    width: 90,
    align: 'right',
    value: (r) => String(r.totalScanned ?? 0),
  },
  {
    key: 'abnormal',
    title: '差异',
    width: 150,
    value: (r) => `盘亏 ${r.missingItems ?? 0} / 盘盈 ${r.extraItems ?? 0}`,
  },
  {
    key: 'status',
    title: '状态',
    type: 'status',
    width: 110,
    compact: 'chip',
    value: (r) => statusText(r),
    tone: (r) => statusTone(r),
  },
];

/** 详情字段：只摆服务端真的回了值的项（`KeyValuePanel` 会跳过空值）。 */
const detailItems = computed<KeyValueItem[]>(() => {
  const row = shown.value;
  if (row === undefined) {
    return [];
  }
  return [
    { key: 'resultId', label: '结果序号', value: row.resultId === undefined ? '未登记' : String(row.resultId), mono: true },
    { key: 'taskId', label: '所属任务', value: row.taskId === undefined ? '未关联' : String(row.taskId), mono: true },
    { key: 'compareTime', label: '比对时间', value: row.compareTime ? shortTime(row.compareTime) : '未记录', mono: true },
    { key: 'createTime', label: '生成时间', value: row.createTime ? shortTime(row.createTime) : '未记录', mono: true },
    { key: 'totalExpected', label: '应盘数量', value: String(row.totalExpected ?? row.totalItems ?? 0), mono: true },
    { key: 'totalScanned', label: '实扫数量', value: String(row.totalScanned ?? 0), mono: true },
    { key: 'normalItems', label: '账实相符', value: String(row.normalItems ?? 0), mono: true },
    { key: 'missingItems', label: '盘亏（少了）', value: String(row.missingItems ?? 0), mono: true },
    { key: 'extraItems', label: '盘盈（多了）', value: String(row.extraItems ?? 0), mono: true },
    { key: 'status', label: '当前状态', value: statusText(row) },
  ];
});

const pageNote = computed(() =>
  all.value.length > 0 ? `共 ${all.value.length} 条结果，待确认 ${pendingCount.value} 条` : '每次盘点完成后生成的结果与差异',
);

const listTitle = computed(() => `结果列表${applied.value !== '' ? `（含「${applied.value}」）` : ''}`);

/** 空态要讲清"为什么空"：没数据 vs 被筛掉，是两件事、两条出路。 */
const listEmptyText = computed(() => {
  if (applied.value !== '' || filter.value !== 'all') {
    return '没有符合条件的结果，试试换个关键字，或切回「全部」。';
  }
  const taskId = taskParam.value;
  if (taskId !== undefined) {
    return `任务 ${taskId} 还没有巡检结果。看看是不是任务还没做完，或换一个任务再看。`;
  }
  return '还没有巡检结果。请先在「巡检任务」里完成一次盘点，盘点数据上传后这里会自动生成结果。';
});

/** 筛选条上的"仅看任务 #x"：它必须**在 `StateHost` 外面**，见模板里的说明。 */
const taskFilterVisible = computed(() => taskParam.value !== undefined);

const detailEmptyText = computed(() =>
  hasDetailTarget.value
    ? '没有找到这条结果。请刷新后重试，或回到列表重新点选一条。'
    : routeResultId.value === undefined
      ? '还没有选择结果。点上面任意一条结果，这里会显示它的盘点数量与差异构成。'
      : '不能识别要查看的结果序号（要填大于 0 的整数）。请从列表里点选一条结果。',
);

const confirmMutation = useMutation<unknown>('inspection.resultConfirm');
const busy = computed(() => confirmMutation.pending.value);

function onSearch(): void {
  applied.value = keyword.value.trim();
}

function setFilter(next: ResultFilter): void {
  filter.value = next;
}

/** 清关键字与状态筛选；任务过滤是服务端条件，由 `clearTaskFilter` 单独清。 */
function clearLocalFilters(): void {
  keyword.value = '';
  applied.value = '';
  filter.value = 'all';
}

/** 清掉任务过滤：同时把地址栏里的 `?taskId=` 去掉，否则刷新一次它又回来了。 */
function clearTaskFilter(): void {
  taskFilterCleared.value = true;
  void router.push({ name: 'inspection.resultList' });
}

/**
 * 点一行 = 把它的明细取回来（详情接口要 resultId）。
 *
 * 有意**不**在这里跳「结果详情」屏：那一屏要用它自己的 resultId 入口，
 * 而本屏的整屏价值是"把没确认的在原地确认掉" —— 点一下就被踹走，
 * 用户还得再找回来。结果序号在明细里可见，需要看详情屏时从那儿进。
 */
function openResult(row: ResultRow): void {
  selectedId.value = row.resultId;
  notice.value = undefined;
  actionError.value = undefined;
}

function askConfirm(row: ResultRow | undefined): void {
  actionError.value = undefined;
  pendingConfirm.value = row;
}

function cancelConfirm(): void {
  pendingConfirm.value = undefined;
}

/**
 * 确认入账。
 *
 * **不为它编造服务端规则**：真后端 `inspection.resultConfirm` 目前是**空实现**
 * （拿个 `Map` body 直接 `success()`，`resultId` 只做回显），所以"重复确认会被拒 / 已确认不能再点"
 * 这类说法在这里都没有依据。界面上只做二次确认 + 调用 + 刷新，
 * 「已确认的结果不再显示确认按钮」是**照 React 的行为写的展示口径**，不是服务端的约束。
 */
async function runConfirm(): Promise<void> {
  const target = pendingConfirm.value;
  pendingConfirm.value = undefined;
  if (target?.resultId === undefined) {
    actionError.value = '这条结果缺少序号，请刷新后重试';
    return;
  }
  actionError.value = undefined;
  notice.value = undefined;
  try {
    await confirmMutation.run({ resultId: target.resultId });
    notice.value = '结果已确认，盘点差异已作为账实结论记录。';
    // 确认会改变这条结果的展示状态，所以列表与详情都要重取（不做乐观更新）
    list.reload();
    if (hasDetailTarget.value) {
      detail.reload();
    }
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

/**
 * Element Plus 的属性整块给、且放宽成 `any`。
 *
 * `ElInput` 的 props 类型在 `vue-tsc` 下解不开，逐属性写会被当成"属性定义对象"校验而报错。
 * 运行期完全一样 —— 这是**类型层绕行**，不是行为差异。
 */
function anyProps(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="巡检结果" :note="pageNote">
      <template #actions>
        <ElButton size="large" :loading="list.loading.value" @click="list.reload">刷新</ElButton>
      </template>
    </PageHeader>

    <div class="w-toolbar">
      <ElInput
        v-model="keyword"
        v-bind="anyProps({ size: 'large', clearable: true, class: 'w-inspection-result-list__search', placeholder: '任务序号 / 结果序号' })"
        @keydown.enter="onSearch"
      />
      <ElButton size="large" type="primary" @click="onSearch">查找</ElButton>
      <ElButton size="large" :type="filter === 'all' ? 'primary' : 'default'" @click="setFilter('all')">全部</ElButton>
      <ElButton size="large" :type="filter === 'pending' ? 'primary' : 'default'" @click="setFilter('pending')">
        待确认
      </ElButton>
      <ElButton size="large" :type="filter === 'confirmed' ? 'primary' : 'default'" @click="setFilter('confirmed')">
        已确认
      </ElButton>
      <ElButton v-if="applied !== '' || filter !== 'all'" size="large" text @click="clearLocalFilters">
        清空筛选
      </ElButton>
      <span class="w-inspection-result-list__scope">关键字与状态筛选本批</span>
    </div>

    <!--
      任务过滤条在 `StateHost` **外面**：它是服务端过滤的唯一可见证据 + 唯一出口。
      放进内容槽就会被空态/错误态一起藏掉 —— 恰好是"这个任务没有结果"的时候，
      用户最需要看到"我现在只看了任务 501"并把它清掉。
    -->
    <div v-if="taskFilterVisible" class="w-inspection-result-list__taskfilter">
      <StatusChip :text="`仅看任务 #${taskParam}`" tone="info" />
      <ElButton size="large" text @click="clearTaskFilter">看全部任务的结果</ElButton>
      <span class="w-inspection-result-list__scope">按任务过滤由服务端完成，这里不会漏掉其它结果</span>
    </div>

    <p v-if="actionError" class="w-inspection-result-list__error" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="w-inspection-result-list__notice" role="status">{{ notice }}</p>

    <SectionBlock :title="listTitle">
      <StateHost
        :loading="list.loading.value"
        :error="list.error.value ?? null"
        :error-text="list.error.value ? humanize(list.error.value) : undefined"
        :empty="rows.length === 0"
        :empty-text="listEmptyText"
        skeleton="list"
        @retry="list.reload"
      >
        <ResponsiveDataView
          :columns="columns"
          :rows="rows"
          :row-key="(r: ResultRow) => String(r.resultId ?? `task-${r.taskId ?? ''}`)"
          clickable
          @row-click="openResult"
        />
      </StateHost>
    </SectionBlock>

    <SectionBlock title="结果明细">
      <div class="w-inspection-result-list__card">
        <StateHost
          :loading="detail.loading.value"
          :error="detail.error.value ?? null"
          :error-text="detail.error.value ? humanize(detail.error.value) : undefined"
          :empty="shown === undefined"
          :empty-text="detailEmptyText"
          skeleton="detail"
          @retry="detail.reload"
        >
          <div v-if="shown" class="w-inspection-result-list__chips">
            <StatusChip :text="statusText(shown)" :tone="statusTone(shown)" />
            <StatusChip :text="`已完成 ${shown.progress ?? 0}%`" tone="neutral" />
          </div>
          <KeyValuePanel :items="detailItems" />
          <p v-if="shown" class="w-inspection-result-list__hint">
            {{
              shownAbnormal > 0
                ? `这条结果有 ${shownAbnormal} 项差异，确认后会作为账实结论记录，请在确认前核对差异明细。`
                : '这条结果账实相符，可以直接确认。'
            }}
          </p>
        </StateHost>
      </div>
      <div class="w-toolbar">
        <!--
          确认按钮放在工具栏，与 React 的**行内 danger「确认」按钮**有意不同：
          `ResponsiveDataView` 的 `#actions` 列固定 120px，塞一个 danger 按钮会把首列
          （结果序号）挤到看不见；而 React 本身也有这条「确认这条结果」工具栏按钮，
          所以这里只保留工具栏这一个入口，语义等价（代价是操作次数 +1）。
        -->
        <ElButton
          size="large"
          type="danger"
          :disabled="shown === undefined || shownConfirmed || busy"
          :loading="busy"
          aria-label="确认选中的巡检结果"
          @click="askConfirm(shown)"
        >
          {{ busy ? '确认中…' : '确认这条结果' }}
        </ElButton>
        <span class="w-inspection-result-list__scope">先点上面的一条结果，再确认它</span>
      </div>
    </SectionBlock>

    <ConfirmDialog
      :show="pendingConfirm !== undefined"
      title="确认巡检结果"
      :danger="true"
      confirm-text="确认结果"
      :pending="busy"
      @confirm="runConfirm"
      @cancel="cancelConfirm"
    >
      <p class="w-inspection-result-list__confirm">
        {{
          `确认后，任务 ${pendingConfirm?.taskId ?? '未关联'} 的盘点差异将作为账实结论记录，并可能触发库存调整，此操作不可撤销。`
        }}
      </p>
      <p class="w-inspection-result-list__hint">
        {{
          `盘亏 ${pendingConfirm?.missingItems ?? 0} 项，盘盈 ${pendingConfirm?.extraItems ?? 0} 项，账实相符 ${pendingConfirm?.normalItems ?? 0} 项。`
        }}
      </p>
      <p v-if="actionError" class="w-inspection-result-list__error" role="alert">{{ actionError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-inspection-result-list__search {
  max-width: var(--w-space-detail-column-width);
}

/* 作用域标注必须常驻可见：它决定用户对"搜不到"的理解 */
.w-inspection-result-list__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}

.w-inspection-result-list__taskfilter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

.w-inspection-result-list__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-inspection-result-list__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
}

.w-inspection-result-list__hint {
  margin: var(--w-space-inline-gap) 0 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-inspection-result-list__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-inspection-result-list__notice {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-success-text);
  background: var(--w-state-success-fill);
  color: var(--w-state-success-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-size);
}

.w-inspection-result-list__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}
</style>
