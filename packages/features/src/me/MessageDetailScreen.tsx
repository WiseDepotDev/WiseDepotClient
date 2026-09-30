import { useEffect } from 'react';
import {
  Button,
  Card,
  Chip,
  KeyValue,
  ListStateHost,
  PageHeader,
  Section,
  Stack,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { humanize, shortTime } from '../shared/api.js';

/**
 * 消息详情（me/message）。
 *
 * 两个动作：
 *  1. 取详情并按键值对铺开（详情是"读一件事"，不是"扫一个列表"，因此用 KeyValue 而不是行）；
 *  2. **进入即标记已读** —— 用户既然点开了，这条消息在服务端就该算读过。
 *
 * 为什么"标记已读"失败要静默：它只是进入详情的一个副作用，正文已经从另一个取数拿到了。
 * 为一次副作用失败把整屏变成错误态，等于把用户要读的内容挡在错误提示后面 ——
 * 真正影响展示的失败由下面对详情本身的错误态负责。
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

/** 消息类型 → 业务叫法；认不出的类型按「通知」显示。 */
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

export function MessageDetailScreen({
  bridge,
  messageId,
}: {
  bridge: Bridge;
  /** 要看的那条消息；由外壳从消息列表带过来，没有就只能提示用户先选一条。 */
  messageId?: string | undefined;
}): React.ReactElement {
  const hasId = typeof messageId === 'string' && messageId !== '';

  const { loading, data, error, reload } = useBridgeCall<MessageDetail>(bridge, 'message.detail', {
    messageId,
  });

  useEffect(() => {
    if (!hasId) {
      return;
    }
    // 失败静默：见文件头注释 —— 标已读是副作用，不该挡住正文；用户下次再打开还会重试一次
    void bridge.call('message.markRead', { messageId }).catch(() => undefined);
  }, [bridge, hasId, messageId]);

  const detail = data && typeof data === 'object' ? data : undefined;

  return (
    <Stack>
      <PageHeader
        title="消息详情"
        subtitle="告警与通知的全文"
        actions={
          <Button ariaLabel="刷新" onClick={reload}>
            刷新
          </Button>
        }
      />

      <Section title="消息内容">
        <Card>
          <ListStateHost
            loading={loading}
            // 没有选中消息时，取数失败只是"还没有可看的东西"，按空态说，不摆错误码
            error={hasId && error ? { code: error.code, text: humanize(error) } : undefined}
            items={detail ? [detail] : []}
            emptyText={
              hasId
                ? '这条消息已经不在了。它可能已被清理；回到消息列表刷新一下就能看到最新的收件箱。'
                : '还没有选择消息。从消息列表点开任意一条，就能在这里看到它的全文。'
            }
            onRetry={reload}
          >
            {(items) => {
              const row = items[0];
              return row ? (
                <Stack>
                  <KeyValue k="标题" v={row.title ?? '（无标题）'} />
                  <KeyValue k="类型" v={<Chip tone="info">{typeLabel(row.type)}</Chip>} />
                  <KeyValue k="接收人" v={row.receiverName ?? '当前账号'} />
                  <KeyValue k="关联对象" v={relatedText(row)} />
                  <KeyValue k="收到时间" v={<span className="w-mono">{shortTime(row.createTime) || '时间未记录'}</span>} />
                  <KeyValue k="阅读情况" v={row.isRead === true ? `已读${readTimeText(row.readTime)}` : '未读'} />
                  <KeyValue k="正文" v={row.content ?? '这条消息没有正文内容。'} />
                </Stack>
              ) : null;
            }}
          </ListStateHost>
        </Card>
      </Section>
    </Stack>
  );
}

/** 已读时间拼接：服务端没给时间就只说"已读"，不渲染半个句子。 */
function readTimeText(readTime: string | undefined): string {
  const when = shortTime(readTime);
  return when ? `（${when}）` : '';
}
