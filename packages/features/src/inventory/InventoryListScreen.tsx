import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataList,
  DataRow,
  Dot,
  KeyValue,
  Mono,
  PageHeader,
  SearchField,
  Section,
  Stack,
  TabStrip,
  TabStripItem,
  Toolbar,
  ListStateHost,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize } from '../shared/api.js';
import type { Navigator } from '../registry.js';

/**
 * 库存查询（inventory/list）。
 *
 * 这是 W5 的**样板屏**：搜索 + 筛选 + 刷新 + 分页列表 + 业务化空态，一样不少。
 * 后面各域的列表屏照它写 —— 差别只在列与筛选项。
 *
 * 三条刻意的选择：
 * 1. **筛选在客户端做**（本轮）：先把列表拉回来再过滤，避免"改一个筛选打一次接口"。
 *    数据量上来后再换成服务端筛选（`inventory.search` 已经存在，换的时候只改取数那一行）。
 * 2. **空态说人话**：给业务用户看"暂无库存数据，请点击刷新，或前往商品管理新增商品"，
 *    而不是空白或开发提示（用户实测反馈过这一点）。
 * 3. **列表行首列是等宽单号**：操作员靠它对单，不能被截断。
 */

interface InventoryRow {
  readonly inventoryId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly quantity?: number;
  readonly warehouseName?: string;
  readonly location?: string;
  readonly status?: number;
  readonly updateTime?: string;
}

const PAGE_SIZE = 20;

type StockFilter = 'all' | 'low' | 'locked';

export function InventoryListScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'inventory.list', {
    page,
    size: PAGE_SIZE,
  });

  const all = asList<InventoryRow>(data);
  const total = asTotal(data);

  // 客户端筛选：关键词命中商品名/编码/货位，库存量按档过滤
  const rows = all.filter((r) => {
    if (applied) {
      const hay = `${r.productName ?? ''}${r.productCode ?? ''}${r.location ?? ''}`.toLowerCase();
      if (!hay.includes(applied.toLowerCase())) {
        return false;
      }
    }
    const q = r.quantity ?? 0;
    if (filter === 'low') {
      return q > 0 && q <= 10;
    }
    if (filter === 'locked') {
      return r.status === 1;
    }
    return true;
  });

  const selectedRow = rows.find((item) => item.inventoryId === selectedId) ?? rows[0];
  useEffect(() => {
    if (selectedId === undefined && selectedRow?.inventoryId !== undefined) {
      setSelectedId(selectedRow.inventoryId);
    }
  }, [selectedId, selectedRow?.inventoryId]);

  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;

  return (
    <Stack>
      <PageHeader
        title="库存查询"
        subtitle={total !== undefined ? `共 ${total} 条库存记录` : '按商品、编码或货位查找'}
        actions={
          <Button ariaLabel="刷新" onClick={reload}>
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
        placeholder="商品名 / 编码 / 货位"
      />

      <TabStrip>
        <TabStripItem label="全部" active={filter === 'all'} onClick={() => setFilter('all')} />
        <TabStripItem label="库存偏低" active={filter === 'low'} onClick={() => setFilter('low')} />
        <TabStripItem label="已锁定" active={filter === 'locked'} onClick={() => setFilter('locked')} />
      </TabStrip>

      <Section title={`库存列表${applied ? `（含「${applied}」）` : ''}`}>
        <div className="w-inventory-workspace">
          <Card flush>
            <ListStateHost
              loading={loading}
              error={error ? { code: error.code, text: humanize(error) } : undefined}
              items={rows}
              emptyText={
                applied || filter !== 'all'
                  ? '没有符合条件的库存记录，试试换个关键词或切回「全部」。'
                  : '暂无库存数据。请点击右上角刷新，或前往「商品管理」新增商品后再入库。'
              }
              onRetry={reload}
            >
              {(items) => (
                <DataList>
                    {items.map((r) => (
                      <DataRow
                        key={r.inventoryId ?? `${r.productCode}-${r.location}`}
                        id={r.productCode}
                        active={r.inventoryId !== undefined && r.inventoryId === selectedId}
                        {...(r.inventoryId === undefined
                          ? {}
                          : {
                              onSelect: () => {
                                setSelectedId(r.inventoryId);
                                // ui-language-ok: media query mirrors the compact shell breakpoint; CSS tokens are not available in JS.
                                if (typeof window !== 'undefined' && window.matchMedia('(max-width: 599px)').matches) {
                                  onNavigate?.({
                                    method: 'inventory.detail',
                                    params: { inventoryId: String(r.inventoryId) },
                                  });
                                }
                              },
                            })}
                        main={r.productName ?? '未命名商品'}
                        sub={
                          <>
                            {r.warehouseName ? <span>{r.warehouseName} · </span> : null}
                            <span className="w-mono">{r.location ?? '未分配货位'}</span>
                          </>
                        }
                        trailing={
                          <>
                            <Mono>{`×${r.quantity ?? 0}`}</Mono>
                            {r.status === 1 ? (
                              <Chip tone="warn">
                                <Dot tone="warn" />
                                已锁定
                              </Chip>
                            ) : (
                              <Chip tone="ok">
                                <Dot tone="ok" />
                                正常
                              </Chip>
                            )}
                          </>
                        }
                      />
                    ))}
                </DataList>
              )}
            </ListStateHost>
          </Card>
          <Card className="w-inventory-detail">
            {selectedRow ? (
                <>
                  <div className="w-inventory-detail__title">
                    <span>库存详情</span>
                    {selectedRow.status === 1 ? <Chip tone="warn">已锁定</Chip> : <Chip tone="ok">正常</Chip>}
                  </div>
                  <KeyValue k="商品" v={selectedRow.productName ?? '未命名商品'} />
                  <KeyValue k="编码" v={<Mono>{selectedRow.productCode ?? '—'}</Mono>} />
                  <KeyValue k="仓库" v={selectedRow.warehouseName ?? '—'} />
                  <KeyValue k="货位" v={<Mono>{selectedRow.location ?? '未分配货位'}</Mono>} />
                  <KeyValue k="数量" v={<Mono>{selectedRow.quantity ?? 0}</Mono>} />
                  <KeyValue k="更新时间" v={selectedRow.updateTime ?? '—'} />
                </>
              ) : (
                <span className="w-muted">选择一条库存记录查看详情</span>
              )}
          </Card>
        </div>
      </Section>

      {/* 分页用 Toolbar + Button：它是**动作**，不是"平级页签" —— 别拿 TabStrip 当按钮组用 */}
      <Toolbar>
        <Button ariaLabel="上一页" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          上一页
        </Button>
        <span className="w-chip w-mono">{`第 ${page} 页`}</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </Toolbar>
    </Stack>
  );
}
