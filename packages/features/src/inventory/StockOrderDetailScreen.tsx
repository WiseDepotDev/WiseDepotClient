import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataList,
  DataRow,
  Dot,
  Field,
  Input,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, humanize, shortTime } from '../shared/api.js';
import type { ScreenParams } from '../registry.js';

/**
 * 出入库单详情（inventory/stockOrder 的单据页面）。
 *
 * 这一屏把"一张出入库单"讲完整：现在是什么状态 → 谁能对它做什么 → 做了会怎样。
 *
 * 四条刻意的选择：
 * 1. **动作跟着状态走，不能做的先把原因写在按钮旁边**：服务端对"当前状态能不能做这件事"
 *    有硬要求（见文件末尾的流转规则），让操作员点一下才知道不行是把服务端的校验
 *    原样丢给用户。禁用 + 一句原因，比点完弹出报错便宜得多。
 * 2. **提交、审核、撤回都走二次确认**：「提交」把单子送进审核队列、「审核」会真的
 *    加减库存且不可撤销、「撤回」会把已经送审的单子拉回来。三者都不是点一下就生效的操作。
 * 3. **驳回必须写原因**：服务端会把驳回原因写进单据备注，审批人说"不行"而不说为什么，
 *    建单的人只能靠猜。
 * 4. **明细分录不在本屏**：服务端加明细要的是**标签**（不是商品编号 + 数量），
 *    一条明细对应一枚已经贴到实物上的标签。本屏只做状态流转，
 *    整条"扫码上明细"的流程留给下一轮 —— 在这里摆半个明细录入框，
 *    只会让人以为扫了码就能加，实际加不进去。
 */

/** 状态码：与服务端的枚举一一对应。 */
type OrderStatus = 'pending' | 'approved' | 'completed' | 'cancelled' | 'submitted' | 'rejected' | 'unknown';

interface StockOrderDetail {
  readonly orderId?: number;
  readonly orderNo?: string;
  readonly orderCode?: string;
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly orderType?: number | string;
  readonly orderTypeStr?: string;
  readonly orderStatus?: number | string;
  readonly status?: number | string;
  readonly orderStatusStr?: string;
  readonly totalItems?: number;
  readonly remark?: string;
  readonly createTime?: string;
  readonly createdAt?: string;
  readonly updateTime?: string;
  readonly submitTime?: string;
  readonly createdByName?: string;
  readonly createByName?: string;
  readonly items?: readonly StockOrderItem[];
}

interface StockOrderItem {
  readonly tagId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly productSpecification?: string;
  readonly quantity?: number;
  readonly locationCode?: string;
}

/** 服务端给的状态名 → 状态码。取不到数字时用它兜底。 */
const STATUS_BY_NAME: Readonly<Record<string, OrderStatus>> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  SUBMITTED: 'submitted',
  REJECTED: 'rejected',
};

const STATUS_TEXT: Readonly<Record<OrderStatus, string>> = {
  pending: '待审批',
  approved: '已审批',
  completed: '已完成',
  cancelled: '已取消',
  submitted: '待审核',
  rejected: '已驳回',
  unknown: '状态未登记',
};

/**
 * 状态归一化：服务端在同一个字段上可能给数字码，也可能给枚举名（两种返回形状都见过），
 * 所以这里的口径是"能认出哪个用哪个"，认不出就如实说未登记，不猜一个最像的状态。
 */
function statusOf(order: StockOrderDetail): OrderStatus {
  const raw = order.orderStatus ?? order.status;
  if (typeof raw === 'number') {
    switch (raw) {
      case 0:
        return 'pending';
      case 1:
        return 'approved';
      case 2:
        return 'completed';
      case 3:
        return 'cancelled';
      case 4:
        return 'submitted';
      case 5:
        return 'rejected';
      default:
        return 'unknown';
    }
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') {
      return 'unknown';
    }
    const byNumber = Number(text);
    if (Number.isInteger(byNumber)) {
      return statusOf({ orderStatus: byNumber });
    }
    const byName = STATUS_BY_NAME[text.toUpperCase()];
    if (byName !== undefined) {
      return byName;
    }
  }
  const named = order.orderStatusStr;
  if (typeof named === 'string') {
    const text = named.trim();
    if (text === '') {
      return 'unknown';
    }
    return STATUS_BY_NAME[text.toUpperCase()] ?? 'unknown';
  }
  return 'unknown';
}

function statusText(order: StockOrderDetail): string {
  return STATUS_TEXT[statusOf(order)];
}

/**
 * 类型判读：`orderType` 可能是枚举名（IN / OUT），也可能是类型码（0 入库 / 1 出库）。
 * 服务端拿不准的取值一律按入库处理，这里跟着它的口径走，避免界面说的和服务端做的不是一件事。
 */
function typeOf(order: StockOrderDetail): 'IN' | 'OUT' {
  const named = order.orderTypeStr;
  if (typeof named === 'string' && named.trim().toUpperCase() === 'OUT') {
    return 'OUT';
  }
  const raw = order.orderType;
  if (typeof raw === 'string') {
    return raw.trim().toUpperCase() === 'OUT' ? 'OUT' : 'IN';
  }
  return raw === 1 ? 'OUT' : 'IN';
}

function typeText(order: StockOrderDetail): string {
  return typeOf(order) === 'OUT' ? '出库' : '入库';
}

function statusTone(status: OrderStatus): 'neutral' | 'info' | 'ok' | 'warn' | 'danger' {
  switch (status) {
    case 'submitted':
      return 'info';
    case 'approved':
    case 'completed':
      return 'ok';
    case 'rejected':
      return 'danger';
    case 'cancelled':
      return 'warn';
    default:
      return 'neutral';
  }
}

function dotTone(status: OrderStatus): 'ok' | 'warn' | 'bad' | 'idle' {
  switch (status) {
    case 'approved':
    case 'completed':
    case 'submitted':
      return 'ok';
    case 'rejected':
      return 'bad';
    case 'cancelled':
      return 'warn';
    default:
      return 'idle';
  }
}

function StatusChip({ order }: { order: StockOrderDetail }): React.ReactElement {
  const status = statusOf(order);
  return (
    <Chip tone={statusTone(status)}>
      <Dot tone={dotTone(status)} />
      {STATUS_TEXT[status]}
    </Chip>
  );
}

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口可能直接把单据给出来，也可能裹一层（两种形状都见过），这里都接住。 */
function detailOf(value: unknown): StockOrderDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<StockOrderDetail>(value);
  return list.length > 0 ? list[0] : (value as StockOrderDetail);
}

function orderNoOf(order: StockOrderDetail | undefined): string {
  return order?.orderNo ?? order?.orderCode ?? '未登记单号';
}

function timeText(value: string | undefined, fallback: string): string {
  const text = shortTime(value);
  return text === '' ? fallback : text;
}

/**
 * 一次待确认的动作。
 *
 * 为什么拆成"动作"而不是四个布尔：确认弹窗的标题、按钮文案、请求体、
 * 成功提示都跟着动作走，用同一个枚举驱动就不会出现"弹窗说的是提交、
 * 实际发的是审核"这种只会在生产环境被发现的不一致。
 */
type PendingAction =
  | { readonly kind: 'submit' }
  | { readonly kind: 'withdraw' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject' };

export function StockOrderDetailScreen({
  bridge,
  screenParams,
}: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}): React.ReactElement {
  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // 屏参数是字符串袋 → 单据编号要自己转数字；转不出来就停在"没选单据"，
  // 不发一个必然是错的请求（服务端只认数字编号）。
  const rawOrderId = screenParams?.orderId;
  const parsedOrderId = rawOrderId === undefined ? Number.NaN : Number(rawOrderId.trim());
  const hasTarget = Number.isInteger(parsedOrderId) && parsedOrderId > 0;

  const detailCall = useBridgeCall<unknown>(
    bridge,
    'stockOrder.detail',
    { orderId: parsedOrderId },
    { enabled: hasTarget },
  );

  const order = detailOf(detailCall.data);
  const status = order ? statusOf(order) : 'unknown';
  const items = order?.items ?? [];
  const itemCount = items.length > 0 ? items.length : (order?.totalItems ?? 0);

  const canSubmit = status === 'pending' || status === 'rejected';
  const canWithdraw = status === 'submitted';
  const canAudit = status === 'submitted';

  const submitReason = canSubmit
    ? undefined
    : `当前是「${order ? statusText(order) : '状态未登记'}」，只有待审批或已驳回的单据可以提交。`;
  const withdrawReason = canWithdraw ? undefined : '只有待审核的单据可以撤回。';
  const auditReason = canAudit ? undefined : '只有待审核的单据可以审核。';

  const closeDialog = (): void => {
    setPending(undefined);
    setRejectReason('');
  };

  const runAction = async (): Promise<void> => {
    const action = pending;
    if (action === undefined || !hasTarget) {
      closeDialog();
      return;
    }
    if (action.kind === 'reject' && rejectReason.trim().length < 2) {
      setActionError('请写清楚驳回的原因（至少 2 个字），建单的人要照着它改。');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      if (action.kind === 'submit') {
        await bridge.call('stockOrder.submit', { orderId: parsedOrderId });
        setNotice('单据已提交，等有审核权限的同事处理。在审核之前可以撤回。');
      } else if (action.kind === 'withdraw') {
        await bridge.call('stockOrder.withdraw', { orderId: parsedOrderId });
        setNotice('单据已撤回，回到待审批。可以继续调整明细，再重新提交。');
      } else {
        await bridge.call('stockOrder.audit', {
          orderId: parsedOrderId,
          approved: action.kind === 'approve',
          reason: action.kind === 'approve' ? '审核通过' : rejectReason.trim(),
        });
        setNotice(
          action.kind === 'approve'
            ? typeOf(order ?? {}) === 'OUT'
              ? '审核通过，已按明细扣减库存。这一步不能撤销。'
              : '审核通过，已按明细增加库存。这一步不能撤销。'
            : '已驳回，原因已写在单据备注里发给建单的人。',
        );
      }
      closeDialog();
      detailCall.reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const dialogTitle =
    pending === undefined
      ? ''
      : pending.kind === 'submit'
        ? '提交这张单据'
        : pending.kind === 'withdraw'
          ? '撤回这张单据'
          : pending.kind === 'approve'
            ? '审核通过这张单据'
            : '驳回这张单据';

  const dialogConfirmLabel =
    pending === undefined
      ? '确认'
      : pending.kind === 'submit'
        ? '提交'
        : pending.kind === 'withdraw'
          ? '撤回'
          : pending.kind === 'approve'
            ? '通过'
            : '驳回';

  return (
    <Stack>
      <PageHeader
        title={order ? `出入库单 ${orderNoOf(order)}` : '出入库单详情'}
        subtitle={
          order
            ? `${typeText(order)} · ${statusText(order)} · ${order.warehouseName ?? '仓库未登记'}`
            : '查看单据内容，并按当前状态推进流转'
        }
        actions={
          <Button
            variant="primary"
            ariaLabel="刷新单据"
            disabled={!hasTarget || busy}
            onClick={detailCall.reload}
          >
            刷新
          </Button>
        }
      />

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      {notice ? (
        <Card>
          <span>{notice}</span>
        </Card>
      ) : null}

      <Section title="单据信息">
        <Card>
          <ListStateHost
            loading={detailCall.loading}
            error={
              detailCall.error
                ? { code: detailCall.error.code, text: humanize(detailCall.error) }
                : undefined
            }
            items={order ? [order] : []}
            emptyText={
              hasTarget
                ? '没有找到这张单据。请回到「出入库单」列表点一张单子进来。'
                : '没有收到要打开的单据。请回到「出入库单」列表点一张单子进来。'
            }
            onRetry={detailCall.reload}
          >
            {(rows) => {
              const o = rows[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    <StatusChip order={o} />
                    <Chip tone="neutral">{typeText(o)}</Chip>
                    <span className="w-chip w-mono">{`明细 ${itemCount} 项`}</span>
                  </Toolbar>
                  <KeyValue k="单号" v={<Mono>{orderNoOf(o)}</Mono>} />
                  <KeyValue k="单据类型" v={typeText(o)} />
                  <KeyValue k="单据状态" v={statusText(o)} />
                  <KeyValue
                    k="目的仓库"
                    v={
                      o.warehouseName ? (
                        <Mono>{o.warehouseName}</Mono>
                      ) : (
                        '仓库未登记，可向管理员核对仓库是否已停用'
                      )
                    }
                  />
                  <KeyValue
                    k="建单人"
                    v={o.createdByName ?? o.createByName ?? '建单人未记录'}
                  />
                  <KeyValue k="创建时间" v={timeText(o.createTime ?? o.createdAt, '时间未记录')} />
                  <KeyValue k="更新时间" v={timeText(o.updateTime, '还没有更新过')} />
                  <KeyValue
                    k="提交时间"
                    v={o.submitTime ? timeText(o.submitTime, '时间未记录') : '还没有提交'}
                  />
                  <KeyValue k="备注" v={o.remark && o.remark.trim() !== '' ? o.remark : '没有备注'} />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title={`单据明细${itemCount > 0 ? `（${itemCount} 项）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={detailCall.loading}
            error={
              detailCall.error
                ? { code: detailCall.error.code, text: humanize(detailCall.error) }
                : undefined
            }
            items={items}
            emptyText="这张单据还没有登记明细。明细要对着实物上的标签逐条登记，登记完才能提交审核。"
            onRetry={detailCall.reload}
          >
            {(rows) => (
              <DataList>
                {rows.map((item) => (
                  <DataRow
                    key={item.tagId ?? `${item.productId ?? 'x'}-${item.locationCode ?? ''}`}
                    id={item.productCode ?? '商品编码未登记'}
                    main={item.productName ?? `商品 ${item.productId ?? '编号未登记'}`}
                    sub={
                      <>
                        {item.productSpecification ? <span>{item.productSpecification} · </span> : null}
                        <span className="w-mono">{`数量 ${item.quantity ?? 1}`}</span>
                        <span className="w-muted">{` · 库位 ${item.locationCode ?? '未指定'}`}</span>
                        <span className="w-muted">{` · 标签 ${item.tagId ?? '未绑定'}`}</span>
                      </>
                    }
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
        <div className="w-state">
          <span>
            明细的登记与删除要对着实物上的标签逐条做（一条明细对应一枚标签）。本屏负责单据的状态流转，扫码登记明细走另一条路径。
          </span>
        </div>
      </Section>

      <Section title="可以做的操作">
        <Card>
          <Stack>
            <Toolbar>
              <Button
                variant="primary"
                ariaLabel="提交单据"
                disabled={!hasTarget || busy || !canSubmit}
                onClick={() => {
                  setActionError(undefined);
                  setPending({ kind: 'submit' });
                }}
              >
                提交
              </Button>
              <Button
                variant="danger"
                ariaLabel="驳回单据"
                disabled={!hasTarget || busy || !canAudit}
                onClick={() => {
                  setActionError(undefined);
                  setRejectReason('');
                  setPending({ kind: 'reject' });
                }}
              >
                驳回
              </Button>
              <Button
                ariaLabel="审核通过单据"
                disabled={!hasTarget || busy || !canAudit}
                onClick={() => {
                  setActionError(undefined);
                  setPending({ kind: 'approve' });
                }}
              >
                审核通过
              </Button>
              <Button
                ariaLabel="撤回单据"
                disabled={!hasTarget || busy || !canWithdraw}
                onClick={() => {
                  setActionError(undefined);
                  setPending({ kind: 'withdraw' });
                }}
              >
                撤回
              </Button>
            </Toolbar>
            {/* 不能做的动作把原因写在旁边：让操作员点了才知道不行，是把服务端的校验原样丢给他 */}
            <Stack tight>
              <span className="w-muted">
                {canSubmit
                  ? '提交：把单据送进审核队列。提交前请先确认明细已经登记完整。'
                  : `提交：暂时不能做 —— ${submitReason ?? ''}`}
              </span>
              <span className="w-muted">
                {canAudit
                  ? '审核通过 / 驳回：审核通过会按明细实际加减库存，不能撤销；驳回请写明原因。'
                  : `审核通过 / 驳回：暂时不能做 —— ${auditReason ?? ''}`}
              </span>
              <span className="w-muted">
                {canWithdraw
                  ? '撤回：把已提交的单据拉回待审批，可以继续调整明细。'
                  : `撤回：暂时不能做 —— ${withdrawReason ?? ''}`}
              </span>
            </Stack>
          </Stack>
        </Card>
      </Section>

      <ConfirmDialog
        open={pending !== undefined}
        title={dialogTitle}
        danger={pending !== undefined && pending.kind !== 'submit'}
        confirmLabel={dialogConfirmLabel}
        message={
          <Stack>
            <span>
              {pending?.kind === 'submit'
                ? '提交后单据进入待审核，建单的人不能再改动明细。审核之前可以撤回。'
                : pending?.kind === 'withdraw'
                  ? '撤回后单据回到待审批，需要重新提交才会再次进入审核队列。'
                  : pending?.kind === 'approve'
                    ? `${typeText(order ?? {}) === 'OUT' ? '通过后会按明细扣减库存' : '通过后会按明细增加库存'}，并作为账实结果留下记录，不能撤销。`
                    : '驳回后单据回到可修改状态，原因会写进单据备注。'}
            </span>
            <span className="w-muted">
              {`单号 ${orderNoOf(order)} · ${order ? typeText(order) : '类型未登记'} · 明细 ${itemCount} 项`}
            </span>
            {pending?.kind === 'reject' ? (
              <Field label="驳回原因 *">
                <Input
                  value={rejectReason}
                  onChange={setRejectReason}
                  placeholder="如：数量与送货单不符，请核对后重新提交"
                  ariaLabel="驳回原因"
                />
              </Field>
            ) : null}
            {actionError ? <span className="w-state w-state--error">{actionError}</span> : null}
          </Stack>
        }
        onConfirm={() => void runAction()}
        onCancel={closeDialog}
      />
    </Stack>
  );
}

/**
 * 服务端流转规则（照抄 `InOutApplicationService`，改动要同步这里）：
 *
 * · 提交：当前必须是「待审批」或「已驳回」，且**单据要有明细** ——
 *   没有明细会被拒（"单据无明细，无法提交"）。
 * · 审核：当前必须是「待审核」。通过 = 按仓库与单据类型逐条加减库存，落到「已审批」；
 *   不通过 = 落到「已驳回」。原因会被写进单据备注。
 * · 撤回：当前必须是「待审核」，撤回后回到「待审批」。
 * · 加明细 / 删明细：当前必须是「待审批」或「已驳回」；加明细要的是**标签编号**，
 *   服务端先按标签查出商品，找不到标签就是"标签不存在"。
 * · 新建时不传状态，服务端默认给「待审批」（建单屏就是这么发的）。
 *
 * 状态码：0 待审批 / 1 已审批 / 2 已完成 / 3 已取消 / 4 待审核 / 5 已驳回。
 * 注意「已审批」与「待审核」不是同一个东西：审批发生在提交之后。
 */
