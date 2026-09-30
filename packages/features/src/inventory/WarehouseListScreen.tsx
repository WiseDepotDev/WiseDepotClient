import { useState } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataList,
  DataRow,
  Field,
  Input,
  Mono,
  PageHeader,
  SearchField,
  Section,
  Stack,
  Toolbar,
  ListStateHost,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize } from '../shared/api.js';

/**
 * 仓库管理（inventory/warehouse）。
 *
 * 这是 inventory 域里**第二个**标准 CRUD 屏（商品管理是第一个）。
 * 按"三次法则"这里先保持与商品管理同一结构、不抽象 ——
 * 等到第三个（用户管理）出现、模式真的稳定了再抽成通用组件，
 * 那时的抽象才有足够样本，不会抽歪。
 *
 * 与商品管理的差别只有字段：名称 / 编码 / 地址。
 */

interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
  readonly address?: string;
  readonly description?: string;
}

const PAGE_SIZE = 20;

export function WarehouseListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ warehouseName: '', warehouseCode: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<WarehouseRow | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'warehouse.list', {
    page,
    size: PAGE_SIZE,
  });

  const all = asList<WarehouseRow>(data);
  const total = asTotal(data);
  const rows = applied
    ? all.filter((r) =>
        `${r.warehouseName ?? ''}${r.warehouseCode ?? ''}${r.address ?? ''}`
          .toLowerCase()
          .includes(applied.toLowerCase()),
      )
    : all;

  const submitCreate = async (): Promise<void> => {
    if (!form.warehouseName.trim() || !form.warehouseCode.trim()) {
      setActionError('仓库名称与编码不能为空');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('warehouse.create', {
        warehouseName: form.warehouseName.trim(),
        warehouseCode: form.warehouseCode.trim(),
        address: form.address.trim(),
      });
      setCreating(false);
      setForm({ warehouseName: '', warehouseCode: '', address: '' });
      reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const target = pendingDelete;
    setPendingDelete(undefined);
    if (!target?.warehouseId) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      // 契约里这个端点的路径模板是 /api/warehouse/{id} —— 参数名就是 id，不是 warehouseId
      await bridge.call('warehouse.delete', { id: target.warehouseId });
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
        title="仓库管理"
        subtitle={total !== undefined ? `共 ${total} 个仓库` : '维护仓库与库区'}
        actions={
          <>
            <Button ariaLabel="刷新" onClick={reload}>
              刷新
            </Button>
            <Button variant="primary" ariaLabel="新增仓库" onClick={() => setCreating((v) => !v)}>
              {creating ? '收起' : '新增'}
            </Button>
          </>
        }
      />

      {creating ? (
        <Section title="新增仓库">
          <Card>
            <Stack>
              <Field label="仓库名称 *">
                <Input value={form.warehouseName} onChange={(v) => setForm((f) => ({ ...f, warehouseName: v }))} placeholder="如：立体库 A" />
              </Field>
              <Field label="仓库编码 *">
                <Input value={form.warehouseCode} onChange={(v) => setForm((f) => ({ ...f, warehouseCode: v }))} placeholder="如：WH-A" mono />
              </Field>
              <Field label="地址">
                <Input value={form.address} onChange={(v) => setForm((f) => ({ ...f, address: v }))} placeholder="选填" />
              </Field>
              {actionError ? (
                <div className="w-state w-state--error">
                  <span>{actionError}</span>
                </div>
              ) : null}
              <Toolbar>
                <Button ariaLabel="取消" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button variant="primary" ariaLabel="保存" disabled={busy} onClick={() => void submitCreate()}>
                  {busy ? '保存中…' : '保存'}
                </Button>
              </Toolbar>
            </Stack>
          </Card>
        </Section>
      ) : actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => {
          setApplied(keyword);
          setPage(1);
        }}
        placeholder="仓库名 / 编码 / 地址"
      />

      <Section title={`仓库列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied
                ? '没有匹配的仓库，试试换个关键词。'
                : '还没有仓库。点击右上角「新增」创建第一个仓库，之后才能把商品入库并分配货位。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.warehouseId ?? r.warehouseCode}
                    id={r.warehouseCode}
                    main={r.warehouseName ?? '未命名仓库'}
                    sub={r.address ?? '未填写地址'}
                    trailing={
                      <Button ariaLabel={`删除 ${r.warehouseName ?? ''}`} onClick={() => setPendingDelete(r)}>
                        删除
                      </Button>
                    }
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
        <Button ariaLabel="下一页" disabled={all.length < PAGE_SIZE || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </Toolbar>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        title="删除仓库"
        danger
        confirmLabel="删除"
        message={
          <>
            确定要删除 <Mono>{pendingDelete?.warehouseName ?? ''}</Mono> 吗？
            该仓库下的库存与货位记录会一并失效，此操作不可撤销。
          </>
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(undefined)}
      />
    </Stack>
  );
}
