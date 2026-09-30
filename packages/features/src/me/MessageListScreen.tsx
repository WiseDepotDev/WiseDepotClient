import { useState } from 'react';
import {
  BottomActionBar,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataList,
  DataRow,
  Dot,
  ErrorState,
  ListStateHost,
  LoadingState,
  PageHeader,
  SearchField,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize, shortTime } from '../shared/api.js';

/**
 * 消息中心（me/message）。
 *
 * 与其他列表屏差一步取数：消息的每一个动作（列表 / 未读数 / 全部已读 / 清空）
 * 都按**收件人**过滤，而收件人只能来自当前登录用户。因此先取"我是谁"，
 * 拿到之后才挂上收件箱主体 —— 先发一次没有收件人的取数会拿回范围不明的数据，
 * 宁可先画骨架（骨架也能让用户看出"这里将出现一个列表"）。
 *
 * 交互上把"标记已读"放在**点击整行**上，不在行内塞小图标按钮：现场戴手套点屏幕，
 * 行内小按钮点不中（ui-spec §6）。点一行同时把正文就地展开，用户不必离开本屏就能读完。
 */

interface MessageRow {
  readonly id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly type?: string;
  readonly isRead?: boolean;
  readonly createTime?: string;
}

const PAGE_SIZE = 20;

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

/** 列表里只露正文开头（列表是"扫一眼"，整段正文在行下方就地展开）。 */
function excerpt(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine;
}

export function MessageListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [nonce, setNonce] = useState(0);

  // 收件人：消息的每一次调用都要它
  const me = useBridgeCall<{ userId?: number }>(bridge, 'user.current');
  const receiverId = typeof me.data?.userId === 'number' ? me.data.userId : undefined;

  const refresh = (): void => {
    setNonce((n) => n + 1);
    me.reload();
  };

  return (
    <Stack>
      <PageHeader
        title="消息中心"
        subtitle="设备告警、审批结果与任务提醒"
        actions={
          <Button ariaLabel="刷新" onClick={refresh}>
            刷新
          </Button>
        }
      />

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => {
          setApplied(keyword);
          setPage(1);
        }}
        placeholder="标题 / 正文关键词"
      />

      {me.error ? (
        <Section title="消息列表">
          <Card>
            <ErrorState code={me.error.code} text={humanize(me.error)} onRetry={me.reload} />
          </Card>
        </Section>
      ) : receiverId === undefined ? (
        // 还不知道"这是谁的收件箱"：先画骨架，不发范围不明的消息请求
        <Section title="消息列表">
          <Card flush>
            <LoadingState />
          </Card>
        </Section>
      ) : (
        // key 变化即重挂载：刷新与"读完/清空"后的重取都走同一条路，取数状态不散在两处
        <InboxBody
          key={nonce}
          bridge={bridge}
          receiverId={receiverId}
          page={page}
          applied={applied}
          onPageChange={setPage}
        />
      )}
    </Stack>
  );
}

/**
 * 收件箱主体：确认"这是谁的收件箱"之后才挂上（理由见文件头）。
 *
 * 分页参数在服务端是**从 0 起**（用户列表是 1 起，两者不一致），
 * 界面对用户始终显示"第 N 页"，发出请求前减 1。
 */
function InboxBody({
  bridge,
  receiverId,
  page,
  applied,
  onPageChange,
}: {
  bridge: Bridge;
  receiverId: number;
  page: number;
  applied: string;
  onPageChange: (page: number) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [clearing, setClearing] = useState(false);
  const [badgeNonce, setBadgeNonce] = useState(0);
  const [openedId, setOpenedId] = useState<string | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'message.list', {
    receiverId,
    page: page - 1,
    size: PAGE_SIZE,
  });

  const all = asList<MessageRow>(data);
  const total = asTotal(data);
  const rows = applied
    ? all.filter((r) =>
        `${r.title ?? ''}${r.content ?? ''}${typeLabel(r.type)}`.toLowerCase().includes(applied.toLowerCase()),
      )
    : all;
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;
  const opened = rows.find((r) => r.id !== undefined && r.id === openedId);

  /** 写操作之后：列表与未读数都要重取（未读数是独立的一张卡，用 key 让它重挂载）。 */
  const afterWrite = (): void => {
    setBadgeNonce((n) => n + 1);
    reload();
  };

  const markRead = async (row: MessageRow): Promise<void> => {
    // 已读的不再打扰服务端；没有编号的行什么也做不了
    if (row.isRead === true || row.id === undefined) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('message.markRead', { messageId: row.id });
      afterWrite();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('message.markAllRead', { receiverId });
      afterWrite();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('message.clear', { receiverId });
      setClearing(false);
      setOpenedId(undefined);
      afterWrite();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Toolbar>
        <UnreadBadge key={badgeNonce} bridge={bridge} receiverId={receiverId} />
        {applied ? <Chip tone="info">{`只显示含「${applied}」的消息`}</Chip> : null}
      </Toolbar>

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      <Section title={`消息列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied
                ? '没有匹配的消息，试试换个关键词。'
                : '还没有消息。设备告警、审批结果和任务提醒会送到这里，未读数量会显示在列表上方。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.id ?? `${r.title ?? ''}-${r.createTime ?? ''}`}
                    main={r.title ?? '（无标题）'}
                    sub={
                      <>
                        <span className="w-mono">{shortTime(r.createTime) || '时间未记录'}</span>
                        <span className="w-muted"> · {typeLabel(r.type)}</span>
                        {r.content ? <span className="w-muted"> · {excerpt(r.content)}</span> : null}
                      </>
                    }
                    trailing={
                      r.isRead === true ? (
                        <Chip tone="neutral">已读</Chip>
                      ) : (
                        <Chip tone="warn">
                          <Dot tone="warn" />
                          未读
                        </Chip>
                      )
                    }
                    active={r.id !== undefined && r.id === openedId}
                    onSelect={() => {
                      setOpenedId(r.id);
                      void markRead(r);
                    }}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      {opened ? (
        <Section title="消息正文">
          <Card>
            <Stack tight>
              <span>{opened.title ?? '（无标题）'}</span>
              <span className="w-muted w-mono">{`${typeLabel(opened.type)} · ${shortTime(opened.createTime) || '时间未记录'}`}</span>
              <span>{opened.content ?? '这条消息没有正文内容。'}</span>
            </Stack>
          </Card>
        </Section>
      ) : null}

      <Toolbar>
        <Button ariaLabel="上一页" disabled={page <= 1 || loading} onClick={() => onPageChange(Math.max(1, page - 1))}>
          上一页
        </Button>
        <span className="w-chip w-mono">{`第 ${page} 页`}</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => onPageChange(page + 1)}>
          下一页
        </Button>
        <span className="w-muted w-mono">{`本页 ${all.length} 条`}</span>
      </Toolbar>

      {/* 批量动作钉在底部：手机上一屏看完就能一次处理，不必回到顶栏找按钮 */}
      <BottomActionBar>
        <Button ariaLabel="全部标记为已读" disabled={busy} onClick={() => void markAllRead()}>
          全部已读
        </Button>
        <Button variant="danger" ariaLabel="清空消息" disabled={busy} onClick={() => setClearing(true)}>
          清空消息
        </Button>
      </BottomActionBar>

      <ConfirmDialog
        open={clearing}
        title="清空消息"
        danger
        confirmLabel="清空"
        message={
          <Stack>
            <span>将删除当前账号收到的全部消息，包括还没看的。删除后无法恢复。</span>
            <span className="w-muted">如果里面有还需要照着办的通知，请先记下内容再清空。</span>
          </Stack>
        }
        onConfirm={() => void clearAll()}
        onCancel={() => setClearing(false)}
      />
    </>
  );
}

/**
 * 未读数：列表、全部已读、清空都围绕它，因此单独取一次。
 * 取不到就明说"读不到"，不把空白或占位符渲染给用户。
 */
function UnreadBadge({
  bridge,
  receiverId,
}: {
  bridge: Bridge;
  receiverId: number;
}): React.ReactElement {
  const { loading, data, error } = useBridgeCall<number>(bridge, 'message.unreadCount', { receiverId });

  if (error) {
    return <Chip tone="neutral">未读数量暂时读不到</Chip>;
  }
  if (loading || typeof data !== 'number') {
    return <Chip tone="neutral">未读数量读取中</Chip>;
  }
  return data > 0 ? (
    <Chip tone="warn">
      <Dot tone="warn" />
      {`未读 ${data} 条`}
    </Chip>
  ) : (
    <Chip tone="ok">
      <Dot tone="ok" />
      全部已读
    </Chip>
  );
}
