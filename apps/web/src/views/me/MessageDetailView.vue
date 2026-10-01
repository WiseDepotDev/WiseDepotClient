<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElButton } from 'element-plus';
import { humanize, shortTime, useMutation, useResource } from '@wise/stores';
import { ActionDock, KeyValuePanel, PageHeader, SectionBlock, StateHost, StatusChip, type KeyValueItem } from '@wise/ui';

/**
 * 消息详情（`message.detail` 域）。
 * 语义逐条对齐 `packages/features/src/me/MessageDetailScreen.tsx`。
 *
 * 两个动作：
 *  1. 取详情并按键值对铺开（详情是"读一件事"，不是"扫一个列表"，因此用 `KeyValuePanel` 而不是行）；
 *  2. **进入即标记已读** —— 用户既然点开了，这条消息在服务端就该算读过。
 *
 * ## 为什么"标记已读"失败要静默（照抄 React 版，别改成报错）
 *
 * 它只是进入详情的一个**副作用**：正文已经从另一个取数拿到了。
 * 为一次副作用失败把整屏变成错误态，等于把用户要读的内容挡在错误提示后面 ——
 * 真正影响展示的失败由下面对详情本身的错误态负责。
 * 而且这个副作用**幂等**：用户下次再打开还会重试一次，不需要在这里补一次失败提示。
 *
 * ## 消息序号是字符串
 *
 * 真后端 `MessageController` 是 `@PathVariable String messageId` ——
 * 路由参数**原样透传**，不做 `Number()` 转换（转了反而会把内容型的编号弄坏）。
 * 只有"有值"与"没值"的区分，没有"是不是数字"的区分。
 */

interface MessageDetail {
  readonly id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly type?: string;
  readonly receiverName?: string;
  readonly relatedEntityType?: string;
  readonly relatedEntityId?: string;
  readonly isRead?: boolean;
  readonly readTime?: string;
  readonly createTime?: string;
}

/** 消息类型 → 业务叫法；认不出的类型按「通知」显示，不让英文枚举值漏到界面上。 */
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

/** 关联对象类型 → 业务叫法；认不出的按「相关记录」说，不把英文枚举值甩给用户。 */
function relatedTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'INVENTORY':
      return '库存记录';
    case 'PRODUCT':
      return '商品';
    case 'DEVICE':
      return '设备';
    case 'INSPECTION':
      return '巡检任务';
    case 'STOCK_ORDER':
      return '出入库单';
    case 'ALERT':
      return '告警';
    default:
      return '相关记录';
  }
}

/** 关联对象：服务端可能只给类型或只给编号，缺什么就从后往前兜底。 */
function relatedText(row: MessageDetail): string {
  const id = row.relatedEntityId;
  const type = relatedTypeLabel(row.relatedEntityType);
  if (id) {
    return `${type} · ${id}`;
  }
  return row.relatedEntityType ? type : '未关联具体对象';
}

/** 已读时间拼接：服务端没给时间就只说"已读"，不渲染半个句子。 */
function readTimeText(readTime: string | undefined): string {
  const when = shortTime(readTime);
  return when ? `（${when}）` : '';
}

/** 详情数据：真后端没填的字段回 `null`，认不出形状就当没拿到。 */
function detailOf(value: unknown): MessageDetail | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return value as MessageDetail;
}

const route = useRoute();

/**
 * 路由参数 → 消息序号。
 *
 * `noUncheckedIndexedAccess` 下 `params['x']` 本来就是 `string | string[] | undefined`
 * （重复参数会成数组），所以先取第一个元素、再判类型。
 * 空串与缺失同义：宁可不请求，也不发一个 `messageId: ''` 的请求。
 */
const messageId = computed<string | undefined>(() => {
  const raw = route.params.messageId;
  const text = Array.isArray(raw) ? raw[0] : raw;
  return typeof text === 'string' && text !== '' ? text : undefined;
});
const hasId = computed(() => messageId.value !== undefined);

/**
 * 详情参数。
 *
 * **必须带路径参数**：契约里 `message.detail` 的 `messageId` 是路径段 ——
 * 桥会按契约把它拼进 URL（`paramStyle: 'query'` 指的是剩余参数走查询串）。
 */
const detailParams = computed<Record<string, unknown>>(() => {
  const id = messageId.value;
  return id === undefined ? {} : { messageId: id };
});

const detail = useResource<MessageDetail>('message.detail', detailParams, { enabled: hasId });
const message = computed(() => detailOf(detail.data.value));

const markReadMutation = useMutation<unknown>('message.markRead');

/**
 * 进入即标已读（`immediate` 管首帧，`watch` 管"在同一屏里换了一条消息"）。
 *
 * 失败静默：见文件头 —— 标已读是副作用，不该挡住正文；
 * 下次再打开还会重试一次。**不要**给它加错误提示或成功提示。
 */
watch(
  messageId,
  (id) => {
    if (id === undefined) {
      return;
    }
    void markReadMutation.run({ messageId: id }).catch(() => undefined);
  },
  { immediate: true },
);

/** 详情字段：与 React 版一一对应（七项，缺值用业务语言的兜底句，不留空行）。 */
const infoItems = computed<KeyValueItem[]>(() => {
  const row = message.value;
  return [
    { key: 'title', label: '标题', value: row?.title ?? '（无标题）' },
    { key: 'type', label: '类型', value: typeLabel(row?.type), tone: 'info' },
    { key: 'receiverName', label: '接收人', value: row?.receiverName ?? '当前账号' },
    { key: 'related', label: '关联对象', value: row === undefined ? '未关联具体对象' : relatedText(row) },
    { key: 'createTime', label: '收到时间', value: shortTime(row?.createTime) || '时间未记录', mono: true },
    {
      key: 'isRead',
      label: '阅读情况',
      value: row?.isRead === true ? `已读${readTimeText(row.readTime)}` : '未读',
    },
    { key: 'content', label: '正文', value: row?.content ?? '这条消息没有正文内容。' },
  ];
});

/** 空态要讲清"为什么空"：没带消息进来 vs 这条消息真的不在了，是两件事、两条出路。 */
const emptyText = computed(() =>
  hasId.value
    ? '这条消息已经不在了。它可能已被清理；回到消息列表刷新一下就能看到最新的收件箱。'
    : '还没有选择消息。从消息列表点开任意一条，就能在这里看到它的全文。',
);
</script>

<template>
  <div class="w-page">
    <PageHeader title="消息详情" note="告警与通知的全文">
      <template #actions>
        <ElButton size="large" :loading="detail.loading.value" @click="detail.reload">刷新</ElButton>
      </template>
    </PageHeader>

    <SectionBlock title="消息内容">
      <!--
        没有选中消息时，取数失败只是"还没有可看的东西"，按**空态**说、不摆错误码：
        所以 `error` 只在真有目标时才交给 `StateHost`（与 React 版一致）。
      -->
      <div class="w-me-message-detail__card">
        <StateHost
          :loading="detail.loading.value"
          :error="hasId ? (detail.error.value ?? null) : null"
          :error-text="detail.error.value ? humanize(detail.error.value) : undefined"
          :empty="message === undefined"
          :empty-text="emptyText"
          skeleton="detail"
          @retry="detail.reload"
        >
          <!-- 类型用芯片摆出来：它是"这条消息要不要立刻照着办"的第一眼判据 -->
          <div v-if="message" class="w-me-message-detail__chips">
            <StatusChip :text="typeLabel(message.type)" tone="info" />
            <StatusChip
              :text="message.isRead === true ? '已读' : '未读'"
              :tone="message.isRead === true ? 'neutral' : 'warning'"
            />
          </div>
          <KeyValuePanel :items="infoItems" />
        </StateHost>
      </div>
    </SectionBlock>

    <ActionDock>
      <ElButton size="large" :loading="detail.loading.value" @click="detail.reload">刷新</ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
.w-me-message-detail__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-me-message-detail__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
}
</style>
