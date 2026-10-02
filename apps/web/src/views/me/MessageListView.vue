<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ElButton, ElInput, ElTag } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { asList, asTotal, humanize, shortTime, useMutation, useResource } from '@wise/stores';
import { ActionDock, ConfirmDialog, MasterDetail, PageHeader, SectionBlock, StateHost, StatusChip, useViewport } from '@wise/ui';
import MessageDetailView from './MessageDetailView.vue';

/**
 * 消息中心（`message.list` 域）—— 与其他列表屏差一步**取数前置**：消息的每一个动作
 * （列表 / 未读数 / 全部已读 / 清空）都按**收件人**过滤，而收件人只能来自当前登录用户。
 * 语义逐条对齐 `packages/features/src/me/MessageListScreen.tsx`。
 *
 * 四条从 React 版带过来的决定（都对应踩过的坑，不是新设计）：
 *
 * 1. **先确认"这是谁的收件箱"，再挂收件箱主体**：`user.current` 还没回来时不发消息请求。
 *    发一个 `receiverId: undefined` 的请求会拿回**范围不明**的数据（真后端是
 *    `@RequestParam` 必填，直接报参数不完整），比先画骨架更糟 —— 骨架至少能让用户看出
 *    "这里将出现一个列表"（`useResource` 的 `enabled` 就是为这件事存在的）。
 * 2. **分页在服务端是 0 基**。真后端 `MessageApplicationService#queryMessages` 里是
 *    `int start = request.getPage() * request.getSize();` —— 界面对用户显示"第 N 页"，
 *    **发出请求前减 1**。（用户列表是 1 基，两者不一致，别顺手统一，那个在另一个屏。）
 * 3. **点击整行 = 选中它并标为已读**，正文就地展开，不必离开本屏就能读完；
 *    不在行内塞小图标按钮（现场戴手套点屏幕，行内小按钮点不中）。
 *    本屏因此用自绘的消息卡片而不是表格：React 版的行尾是"已读 / 未读"芯片，
 *    就地展开的选中态也要一处可见。
 * 4. **未读数是独立的一张卡**：它取不到只说"未读数量暂时读不到"，
 *    绝**不**因为辅助数据失败把整屏拖成错误态（收件箱本身可能完全正常）。
 *
 * 两条与 React 版不同的表达方式（仅为落实移植约束，语义不变）：
 *  · 「清空消息」用 `ConfirmDialog`（React 用的就是同名组件，这里是 Vue 版同款）；
 *  · 关键字**只筛已取回的这一页**（`message.list` 没有关键字参数），所以工具条上必须写清
 *    「筛选本页」，否则用户会把"这一页里没有"读成"整个收件箱里没有"。
 */

interface MessageRow {
  readonly id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly type?: string;
  readonly isRead?: boolean;
  readonly createTime?: string;
}

interface CurrentUser {
  readonly userId?: number;
}

const PAGE_SIZE = 20;

/**
 * 消息类型 → 业务叫法；认不出的类型按「通知」显示，不让英文枚举值漏到界面上。
 * **逐字copy** React 版，两屏共用同一份口径（详情屏也有一份同样的表）。
 */
function typeLabel(type: string | undefined): string {
  switch (type) {
    case 'ALERT':
      return '告警';
    case 'INSPECTION':
      return '巡检';
    case 'TASK':
      return '任务';
    case 'INVENTORY':
      return '库存';
    case 'APPROVAL':
      return '审批';
    case 'REMINDER':
      return '提醒';
    case 'SYSTEM':
      return '系统';
    default:
      return '通知';
  }
}

/**
 * 列表里只露正文开头（列表是"扫一眼"，整段正文在下方就地展开）。
 * `?? ''` 是必需的：真后端对没填的字段回的是 `null` 而不是 `undefined`。
 */
function excerpt(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine;
}

/** 服务端对没填的字段可能回 `null`，字符串方法之前一律归一。 */
function textOf(value: string | null | undefined): string {
  return value ?? '';
}

/** 未读数：服务端回的是裸数字，认不出就当"还没读到"。 */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 收件人：只有拿到一个有效的用户序号才算"知道这是谁的收件箱"。 */
function receiverIdOf(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const raw = (value as CurrentUser).userId;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

const keyword = ref('');
const applied = ref('');
const page = ref(1);
const openedId = ref<string | undefined>(undefined);

/*
 * 桌面宽档的主从：左列表 + 右详情。
 * 点行在宽档**不换路由**（`RouterView :key` 会整树重挂，左栏的页码与滚动位置都会丢），
 * 窄档也不换路由（这一屏本就是"点行就地展开"），只有"去详情页"那个链接仍然走路由。
 */
const { isWide } = useViewport();
const selectedId = ref<string | undefined>(undefined);

/** 收件人：消息的每一次调用都要它。 */
const me = useResource<unknown>('user.current');
const receiverId = computed(() => receiverIdOf(me.data.value));
const hasReceiver = computed(() => receiverId.value !== undefined);

/** 消息序号在服务端是**字符串**（`@PathVariable String messageId`），这里原样透传、不做数字转换。 */
function messageRouteId(row: MessageRow): string {
  return row.id ?? '';
}

/**
 * 列表参数。
 *
 * `receiverId` 只在拿得到时才进参数表 —— `exactOptionalPropertyTypes` 下不能显式传
 * `undefined`，而"不发这个参数"与"发一个空收件人"在服务端是两回事（后者直接报错）。
 * **0 基分页**：界面上是第 N 页，发出去的是 `N - 1`。
 */
const listParams = computed<Record<string, unknown>>(() => {
  const id = receiverId.value;
  if (id === undefined) {
    return {};
  }
  return { receiverId: id, page: page.value - 1, size: PAGE_SIZE };
});

/**
 * `enabled` 与参数表**同时**表达"收件人没准备好"是刻意的双保险：
 * 参数表为空是给类型系统的，`enabled` 是给用户的（不发范围不明的请求）。
 */
const list = useResource<unknown>('message.list', listParams, { enabled: hasReceiver });

/** 未读数：与列表分开取，它的失败只影响自己那一枚芯片。 */
const unread = useResource<unknown>('message.unreadCount', listParams, { enabled: hasReceiver });

const all = computed(() => asList<MessageRow>(list.data.value));
const total = computed(() => asTotal(list.data.value));
const unreadCount = computed(() => countOf(unread.data.value));

/**
 * 本页可见行。关键字是**本地过滤**（服务端没有关键字参数），口径照抄 React：
 * 标题 + 正文 + 类型叫法拼起来匹配，大小写不敏感。
 */
const rows = computed(() =>
  applied.value === ''
    ? all.value
    : all.value.filter((row) =>
        `${textOf(row.title)}${textOf(row.content)}${typeLabel(row.type)}`.toLowerCase().includes(applied.value.toLowerCase()),
      ),
);

/** 就地展开的那条：列表在筛选后可能已经不含它，所以从**筛选后的行**里找。 */
const opened = computed<MessageRow | undefined>(() => {
  const id = openedId.value;
  if (id === undefined) {
    return undefined;
  }
  return rows.value.find((row) => row.id !== undefined && row.id === id);
});

/**
 * 还有没有下一页。
 *
 * 真后端 `message.list` 返回的是**裸数组**（`List<MessageDTO>`），没有 `total` ——
 * 所以 `asTotal` 拿不到时用"这一页是否满员"判断（与 React 完全一致）。
 */
const hasMore = computed(() => {
  const t = total.value;
  return t !== undefined ? page.value * PAGE_SIZE < t : all.value.length === PAGE_SIZE;
});

const markReadMutation = useMutation<unknown>('message.markRead');
const markAllReadMutation = useMutation<unknown>('message.markAllRead');
const clearMutation = useMutation<unknown>('message.clear');
const busy = computed(() => markReadMutation.pending.value || markAllReadMutation.pending.value || clearMutation.pending.value);

const clearing = ref(false);
const actionError = ref<string | undefined>(undefined);

/** 全部已读 / 清空之后，列表与未读数都要重取。 */
function afterWrite(): void {
  list.reload();
  unread.reload();
}

/**
 * 整行点一下 = 选中它并标为已读（已读的不再打扰服务端）。
 *
 * 宽档走**主从**：右栏显示这条消息的完整详情，左栏不再就地展开 ——
 * 否则同一份正文会在左右两边各画一遍（这一屏本来就支持"点行就地展开"，
 * 那是窄档的表达方式；宽档有右栏就不需要展开这一层了）。
 */
function onRowClick(row: MessageRow): void {
  if (isWide.value) {
    if (row.id !== undefined) {
      selectedId.value = row.id;
    }
  } else {
    openedId.value = row.id;
  }
  void markRead(row);
}

async function markRead(row: MessageRow): Promise<void> {
  // 已读的不再打扰服务端；没有编号的行什么也做不了
  if (row.isRead === true || row.id === undefined) {
    return;
  }
  actionError.value = undefined;
  try {
    await markReadMutation.run({ messageId: row.id });
    afterWrite();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

async function markAllRead(): Promise<void> {
  const id = receiverId.value;
  // 收件人没准备好：按钮本来就是禁用的，这里再兜一次，绝不发一个没头没尾的请求
  if (id === undefined || busy.value) {
    return;
  }
  actionError.value = undefined;
  try {
    await markAllReadMutation.run({ receiverId: id });
    afterWrite();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

function askClear(): void {
  actionError.value = undefined;
  clearing.value = true;
}

function cancelClear(): void {
  clearing.value = false;
}

async function clearAll(): Promise<void> {
  const id = receiverId.value;
  if (id === undefined) {
    clearing.value = false;
    return;
  }
  actionError.value = undefined;
  try {
    await clearMutation.run({ receiverId: id });
    clearing.value = false;
    openedId.value = undefined;
    afterWrite();
  } catch (e) {
    actionError.value = humanize(e as never);
  }
}

function onSearch(): void {
  const next = keyword.value.trim();
  // 换关键字必须回第一页：留在第 3 页看新关键字的"空结果"是纯粹的自找困惑
  if (next !== applied.value) {
    page.value = 1;
  }
  applied.value = next;
}

function resetSearch(): void {
  keyword.value = '';
  applied.value = '';
  page.value = 1;
}

function goPage(next: number): void {
  page.value = Math.max(1, next);
  // 翻页时把展开的正文收起来：那一条属于上一页，留在下面会让人以为它属于这一页
  openedId.value = undefined;
}

/**
 * 刷新：`user.current` 也要重来一次。
 *
 * 缓存是按**方法 id 前缀**失效的，而 `user.*` 与 `message.*` 不同前缀 ——
 * 所以写操作之后收件人不会自己更新，这里显式刷新一次（身份变了就该重认收件箱）。
 */
function refresh(): void {
  me.reload();
  list.reload();
  unread.reload();
}

/** 未读芯片语气：有未读是警示色（warn 档），全读完了是安心的绿色（ok 档）。 */
function unreadChipType(): 'warning' | 'success' {
  return (unreadCount.value ?? 0) > 0 ? 'warning' : 'success';
}

const listTitle = computed(() => `消息列表${applied.value !== '' ? `（含「${applied.value}」）` : ''}`);
const pageNote = computed(() =>
  total.value !== undefined ? `共 ${total.value} 条消息` : '设备告警、审批结果与任务提醒',
);

/** 空态要讲清"为什么空"：没收到消息 vs 被关键字筛掉，是两件事、两条出路。 */
const emptyText = computed(() =>
  applied.value !== ''
    ? '没有匹配的消息，试试换个关键词。'
    : '还没有消息。设备告警、审批结果和任务提醒会送到这里，未读数量会显示在列表上方。',
);
</script>

<template>
  <div class="w-page">
    <PageHeader title="消息中心" :note="pageNote">
      <template #actions>
      </template>
    </PageHeader>

    <div class="w-toolbar">
      <ElInput
        v-model="keyword"
        size="large"
        clearable
        class="w-me-message-list__search"
        :prefix-icon="Search"
        placeholder="标题 / 正文关键词（回车搜索）"
        @keydown.enter="onSearch"
      />

      <!-- 未读数量芯片：它取不到只说自己读不到，不把整屏拖成错误态 -->
      <ElTag v-if="unread.error.value" size="large" type="info">未读数量暂时读不到</ElTag>
      <ElTag v-else-if="unreadCount === undefined" size="large" type="info">未读数量读取中</ElTag>
      <ElTag v-else size="large" :type="unreadChipType()">
        {{ (unreadCount ?? 0) > 0 ? `未读 ${unreadCount} 条` : '全部已读' }}
      </ElTag>

      <StatusChip v-if="applied !== ''" :text="`只显示含「${applied}」的消息`" tone="info" />
      <ElButton v-if="applied !== ''" size="large" text @click="resetSearch">清空筛选</ElButton>
      <span class="w-me-message-list__scope">关键字只筛本页</span>
    </div>

    <p v-if="actionError" class="w-me-message-list__error" role="alert">{{ actionError }}</p>

    <!--
      没有拿到收件人时**不发消息请求**，只画骨架（`useResource` 停在静止态）。
      这条提示放在 `StateHost` **外面**：它是"为什么这里是空的"的解释，
      进了内容槽就会被正在画的骨架一起藏掉。
    -->
    <p v-if="!hasReceiver && !me.loading.value" class="w-me-message-list__hint">
      还没有认出当前登录的账号，暂时读不到这个账号的收件箱。请重新登录后再进来（换账号之后这一屏会自动重认）。
    </p>

    <MasterDetail>
      <template #list>
    <SectionBlock :title="listTitle">
      <StateHost
        :loading="list.loading.value"
        :error="list.error.value ?? null"
        :error-text="list.error.value ? humanize(list.error.value) : undefined"
        :empty="hasReceiver && !list.loading.value && rows.length === 0"
        :empty-text="emptyText"
        skeleton="list"
        @retry="refresh"
      >
        <ul class="w-me-message-list__list">
          <li
            v-for="row in rows"
            :key="row.id ?? `${textOf(row.title)}-${textOf(row.createTime)}`"
            class="w-me-message-list__row"
            :class="{ 'w-me-message-list__row--open': openedId !== undefined && row.id === openedId }"
          >
            <!-- 整行是一个按钮：现场戴手套点屏幕，行内的小图标按钮点不中 -->
            <button type="button" class="w-me-message-list__hit" @click="onRowClick(row)">
              <span class="w-me-message-list__main">{{ row.title ?? '（无标题）' }}</span>
              <span class="w-me-message-list__sub">
                <span class="w-mono">{{ shortTime(row.createTime) || '时间未记录' }}</span>
                <span class="w-me-message-list__muted"> · {{ typeLabel(row.type) }}</span>
                <span v-if="row.content" class="w-me-message-list__muted"> · {{ excerpt(textOf(row.content)) }}</span>
              </span>
            </button>
            <StatusChip :text="row.isRead === true ? '已读' : '未读'" :tone="row.isRead === true ? 'neutral' : 'warning'" />
          </li>
        </ul>
      </StateHost>

      <!--
        分页条与"本页 N 条"在状态宿主**外面**（与 React 版一致）。
        放进去就会被三态一起藏掉：列表恰好空/错的时候，分页条是用户唯一还在的出口，
        藏了就只能靠「查找」回第 1 页 —— 该留的导航控件不该跟着内容消失。
      -->
      <div class="w-toolbar">
        <ElButton size="large" :disabled="page <= 1 || list.loading.value" @click="goPage(page - 1)">上一页</ElButton>
        <span class="w-chip w-mono">{{ `第 ${page} 页` }}</span>
        <ElButton size="large" :disabled="!hasMore || list.loading.value" @click="goPage(page + 1)">下一页</ElButton>
        <span class="w-me-message-list__muted">{{ `本页 ${all.length} 条` }}</span>
      </div>
    </SectionBlock>
      </template>
      <template #detail>
        <MessageDetailView v-if="selectedId !== undefined" :inline-id="selectedId" />
        <div v-else class="w-masterdetail__pick">从左边点一条消息，这里显示它的完整正文与处理动作。</div>
      </template>
    </MasterDetail>

    <SectionBlock v-if="opened && !isWide" title="消息正文">
      <div class="w-me-message-list__panel">
        <div class="w-me-message-list__panelhead">
          <span class="w-me-message-list__main">{{ opened.title ?? '（无标题）' }}</span>
          <StatusChip :text="opened.isRead === true ? '已读' : '未读'" :tone="opened.isRead === true ? 'neutral' : 'warning'" />
        </div>
        <span class="w-me-message-list__sub">
          <span class="w-mono">{{ shortTime(opened.createTime) || '时间未记录' }}</span>
          <span class="w-me-message-list__muted"> · {{ typeLabel(opened.type) }}</span>
        </span>
        <p class="w-me-message-list__body">{{ opened.content ?? '这条消息没有正文内容。' }}</p>
        <RouterLink class="w-me-message-list__link" :to="{ name: 'message.detail', params: { messageId: messageRouteId(opened) } }">
          在新页面看这条消息的全文
        </RouterLink>
      </div>
    </SectionBlock>

    <!-- 批量动作钉在底部：手机上一屏看完就能一次处理，不必回到顶栏找按钮 -->
    <ActionDock>
      <ElButton size="large" :disabled="busy || !hasReceiver" @click="markAllRead">全部已读</ElButton>
      <ElButton size="large" type="danger" :disabled="busy || !hasReceiver" @click="askClear">清空消息</ElButton>
      <span v-if="!hasReceiver" class="w-me-message-list__scope">先认出当前账号才能批量处理消息</span>
    </ActionDock>

    <ConfirmDialog
      :show="clearing"
      title="清空消息"
      :danger="true"
      confirm-text="清空"
      :pending="clearMutation.pending.value"
      @confirm="clearAll"
      @cancel="cancelClear"
    >
      <p class="w-me-message-list__confirm">将删除当前账号收到的全部消息，包括还没看的。删除后无法恢复。</p>
      <p class="w-me-message-list__hint">如果里面有还需要照着办的通知，请先记下内容再清空。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.w-me-message-list__search {
  max-width: var(--w-space-detail-column-width);
}

/* 作用域标注必须常驻可见：它决定用户对"搜不到"的理解 */
.w-me-message-list__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}

.w-me-message-list__list {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-row-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}

.w-me-message-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--w-space-inline-gap);
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding-compact);
}

/* 选中态必须一处可见：它同时是"这条在下面展开了"的唯一提示 */
.w-me-message-list__row--open {
  border-color: var(--w-color-primary);
}

.w-me-message-list__hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--w-space-inline-gap);
  flex: 1 1 auto;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.w-me-message-list__main {
  font-weight: var(--w-type-label-weight);
}

.w-me-message-list__sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  font-size: var(--w-type-body-small-size);
}

.w-me-message-list__muted {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

/* 就地展开的正文面板：与列表卡片同形，让"展开的是上面那一条"一眼可见 */
.w-me-message-list__panel {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-me-message-list__panelhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--w-space-inline-gap);
}

.w-me-message-list__body {
  margin: 0;
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}

.w-me-message-list__link {
  color: var(--w-color-primary);
  font-size: var(--w-type-body-small-size);
}

.w-me-message-list__hint {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-me-message-list__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}

.w-me-message-list__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
