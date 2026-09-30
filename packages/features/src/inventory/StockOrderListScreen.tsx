import { useState } from 'react';
import {
  BottomActionBar,
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  Field,
  Input,
  Mono,
  PageHeader,
  Section,
  Stack,
  Toolbar,
  ListStateHost,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize, shortTime } from '../shared/api.js';

/**
 * 出入库单（inventory/stockOrder）。
 *
 * 这一屏的建单入口用 [BottomActionBar] —— 规范里的硬规则：
 * **表单屏不允许"滚到底才看得到提交按钮"**（旧版建单屏 477 行就是这个毛病）。
 * 建单入口钉在底部，不随列表滚动。
 *
 * 建单表单保持"最小可用"：目的仓库 + 备注 + 明细后续再补（明细要配合标签扫码，
 * 属 `stockOrder.addItem`，随标签屏一起做）。**宁可少字段，也不要假字段**。
 */

type OrderStatus = 'draft' | 'submitted' | 'audited' | 'unknown';

interface StockOrderRow {
  readonly orderId?: number;
  readonly orderCode?: string;
  readonly orderType?: number;
  readonly status?: number;
  readonly warehouseName?: string;
  readonly createTime?: string;
  readonly createByName?: string;
  readonly itemCount?: number;
}

const PAGE_SIZE = 20;

/** 旧版 `StockOrderType`：1 入库 / 2 出库（与后端枚举一致，改动要同步契约）。 */
function orderTypeLabel(t: number | undefined): string {
  return t === 1 ? '入库' : t === 2 ? '出库' : '单据';
}

function statusOf(s: number | undefined): OrderStatus {
  switch (s) {
    case 0:
      return 'draft';
    case 1:
      return 'submitted';
    case 2:
      return 'audited';
    default:
      return 'unknown';
  }
}

function StatusChip({ status }: { status: number | undefined }): React.ReactElement {
  switch (statusOf(status)) {
    case 'draft':
      return (
        <Chip tone="neutral">
          <Dot tone="idle" />
          草稿
        </Chip>
      );
    case 'submitted':
      return (
        <Chip tone="info">
          <Dot tone="ok" />
          已提交
        </Chip>
      );
    case 'audited':
      return (
        <Chip tone="ok">
          <Dot tone="ok" />
          已审核
        </Chip>
      );
    default:
      return <Chip tone="neutral">未知</Chip>;
  }
}

export function StockOrderListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ warehouseId: '', remark: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'stockOrder.list', {
    page,
    size: PAGE_SIZE,
  });

  const rows = asList<StockOrderRow>(data);
  const total = asTotal(data);
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : rows.length === PAGE_SIZE;

  const submitCreate = async (): Promise<void> => {
    const warehouseId = Number(form.warehouseId);
    if (!Number.isFinite(warehouseId) || warehouseId <= 0) {
      setActionError('请填写有效的仓库编号');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('stockOrder.create', { warehouseId, remark: form.remark.trim() });
      setCreating(false);
      setForm({ warehouseId: '', remark: '' });
      setPage(1);
      reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="出入库单"
        subtitle={total !== undefined ? `共 ${total} 张单据` : '建单、提交与查询'}
        actions={
          <Button ariaLabel="刷新" onClick={reload}>
            刷新
          </Button>
        }
      />

      {creating ? (
        <Section title="新建单据">
          <Card>
            <Stack>
              <Field label="目的仓库编号 *">
                <Input
                  value={form.warehouseId}
                  onChange={(v) => setForm((f) => ({ ...f, warehouseId: v }))}
                  placeholder="如：1"
                  mono
                />
              </Field>
              <Field label="备注">
                <Input value={form.remark} onChange={(v) => setForm((f) => ({ ...f, remark: v }))} placeholder="选填" />
              </Field>
              {actionError ? (
                <div className="w-state w-state--error">
                  <span>{actionError}</span>
                </div>
              ) : null}
              <div className="w-state">
                <span>明细（商品与数量）在建单后逐条添加；标签扫码加明细随标签屏一起上线。</span>
              </div>
            </Stack>
          </Card>
        </Section>
      ) : actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      <Section title="单据列表">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText="还没有出入库单。点击下方「新建单据」开始建单。"
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.orderId ?? r.orderCode}
                    id={r.orderCode}
                    main={`${orderTypeLabel(r.orderType)}单`}
                    sub={
                      <>
                        {r.warehouseName ? <span>{r.warehouseName} · </span> : null}
                        <span className="w-mono">{shortTime(r.createTime)}</span>
                        {r.createByName ? <span className="w-muted"> · {r.createByName}</span> : null}
                        {typeof r.itemCount === 'number' ? <span className="w-muted"> · {r.itemCount} 项</span> : null}
                      </>
                    }
                    trailing={<StatusChip status={r.status} />}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <Button ariaLabel="上一页" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          上一页
        </Button>
        <span className="w-chip w-mono">{`第 ${page} 页`}</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </Toolbar>

      {/* 建单入口钉在底部：列表滚多长都不用找它 */}
      <BottomActionBar>
        <Monocaption>{`共 ${rows.length} 张`}</Monocaption>
        <Button variant="primary" block ariaLabel="新建单据" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起建单' : '新建单据'}
        </Button>
      </BottomActionBar>
    </Stack>
  );
}

/** 底部条左侧的计数说明（小号、次要色，不抢主按钮的注意力）。 */
function Monocaption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="w-muted w-mono">{children}</span>;
}
