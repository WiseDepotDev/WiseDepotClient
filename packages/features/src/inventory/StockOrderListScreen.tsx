import { useState } from 'react';
import {
  BottomActionBar,
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
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
import { orderStatusOf, orderStatusText, orderTypeText } from './stockOrderState.js';
import type { Navigator } from '../registry.js';

/**
 * 出入库单（inventory/stockOrder）。
 *
 * 这一屏**只负责列表**。建单已挪到专门的 `StockOrderCreateScreen`：
 * 这里原先有一个内联建单表单，它调 `stockOrder.create` 时只传了 `{warehouseId, remark}`，
 * 而服务端要求 `orderNo`（不生成，必须客户端给）与 `createBy` ——
 * 所以那个入口**永远是失败的**（真实错误 `VAL-0001 单据编号不能为空`）。
 * 建单这件事只能有一个属主，否则两边会各自漂移。
 *
 * 类型与状态的判定统一在 `./stockOrderState.js`（详情屏用同一份），
 * 那里的注释记着这一屏原本错在哪三处。
 */

interface StockOrderRow {
  readonly orderId?: number;
  readonly orderNo?: string;
  readonly orderType?: number;
  /**
   * 状态**数字码**。真实字段名是 `orderStatus`。
   *
   * 踩过的坑：这里原先写的是 `status`，而服务端返回的行里根本没有这个字段
   * （实测响应：`{"orderStatus":0,"orderType":1,"orderStatusStr":"PENDING",…}`）。
   * 于是每一行的状态标签都在走兜底分支 —— 而列表屏在服务端渲染时没有数据，
   * 渲染用例也抓不到，靠真后端回读才看见。
   */
  readonly orderStatus?: number;
  /** 状态的可读串（服务端也会给，优先用它，省一次映射）。 */
  readonly orderStatusStr?: string;
  readonly orderTypeStr?: string;
  readonly warehouseName?: string;
  readonly createTime?: string;
  readonly createdByName?: string;
  readonly createByName?: string;
  /** 明细条数：真实字段是 `totalItems`（原先写的 `itemCount` 服务端也没有）。 */
  readonly totalItems?: number;
}

const PAGE_SIZE = 20;

/**
 * 状态胶囊。色调按归一化后的状态取，文案来自共享模块 ——
 * 这里**不再自己维护一份码表**（原来那份是错的：0 被当成"草稿"，
 * 而真实枚举 `PENDING(0)` 是"待审批"）。
 */
function StatusChip({ row }: { row: StockOrderRow }): React.ReactElement {
  const tone = ((): 'ok' | 'info' | 'warn' | 'neutral' => {
    switch (orderStatusOf(row)) {
      case 'approved':
      case 'completed':
        return 'ok';
      case 'submitted':
        return 'info';
      case 'rejected':
        return 'warn';
      default:
        return 'neutral';
    }
  })();
  return <Chip tone={tone}>{orderStatusText(row)}</Chip>;
}

export function StockOrderListScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [page, setPage] = useState(1);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'stockOrder.list', {
    page,
    size: PAGE_SIZE,
  });

  const rows = asList<StockOrderRow>(data);
  const total = asTotal(data);
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : rows.length === PAGE_SIZE;

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

      {error ? (
        <div className="w-state w-state--error">
          <span>{humanize(error)}</span>
        </div>
      ) : null}

      <Section title="单据列表">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={undefined}
            items={rows}
            emptyText="还没有出入库单。到「新建出入库单」建第一张。"
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.orderId ?? r.orderNo}
                    id={r.orderNo}
                    main={`${orderTypeText(r)}单`}
                    sub={
                      <>
                        {r.warehouseName ? <span>{r.warehouseName} · </span> : null}
                        <span className="w-mono">{shortTime(r.createTime)}</span>
                        {createdBy(r) ? <span className="w-muted"> · {createdBy(r)}</span> : null}
                        {typeof r.totalItems === 'number' ? (
                          <span className="w-muted">{` · ${r.totalItems} 项`}</span>
                        ) : null}
                      </>
                    }
                    trailing={<StatusChip row={r} />}
                    /*
                     * 整行点一下 = 去下一层看这张单子（返回由外壳负责）。
                     * 没有单据编号的行点了什么都不做：详情屏只认数字编号，
                     * 推一个转不出编号的目标过去，用户看到的只会是一个空详情。
                     */
                    onSelect={() => {
                      if (r.orderId === undefined) {
                        return;
                      }
                      onNavigate?.({ method: 'stockOrder.detail', params: { orderId: String(r.orderId) } });
                    }}
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

      {/*
        这里原先有一个**内联的建单表单**，它调 `stockOrder.create` 时只传了
        `{warehouseId, remark}` —— 而服务端要求 `orderNo`（不生成）与 `createBy`，
        所以那个入口**永远是失败的**（真实错误：`VAL-0001 单据编号不能为空`）。
        现在建单有专门的屏（`StockOrderCreateScreen`），这里只留入口提示 ——
        "建单"这件事只能有一个属主，否则两边会各自漂移。
      */}
      <BottomActionBar>
        <Monocaption>{`共 ${rows.length} 张`}</Monocaption>
        <span className="w-muted">建单请到「新建出入库单」</span>
      </BottomActionBar>
    </Stack>
  );
}

/** 创建人：服务端给了可读名就用它，否则退回编号。 */
function createdBy(row: StockOrderRow): string | undefined {
  return row.createdByName ?? row.createByName;
}

/** 底部条左侧的计数说明（小号、次要色，不抢主按钮的注意力）。 */
function Monocaption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="w-muted w-mono">{children}</span>;
}
