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
 * 商品管理（inventory/product）。
 *
 * 列表 + 新增 + 删除（二次确认）。这是 inventory 域里"标准 CRUD 屏"的样板 ——
 * 仓库管理、用户管理等照它写，差别只在字段。
 *
 * 三条：
 * 1. **删除必须二次确认**（ui-spec §3.1）—— 用 ConfirmDialog，不用 window.confirm
 *    （后者阻塞渲染线程，在 WebView 里会打断与桥的连接）；
 * 2. 写操作后**重取列表**而不是本地拼接：服务端可能补默认值/编号，本地猜会与真值漂移；
 * 3. 空态说人话，并直接告诉用户下一步能做什么。
 */

interface ProductRow {
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly model?: string;
  readonly unit?: string;
  readonly createTime?: string;
}

const PAGE_SIZE = 20;

export function ProductListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ productName: '', productCode: '', model: '', unit: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<ProductRow | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'product.list', {
    page,
    size: PAGE_SIZE,
  });

  const all = asList<ProductRow>(data);
  const total = asTotal(data);
  const rows = applied
    ? all.filter((r) =>
        `${r.productName ?? ''}${r.productCode ?? ''}${r.model ?? ''}`.toLowerCase().includes(applied.toLowerCase()),
      )
    : all;
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;

  const submitCreate = async (): Promise<void> => {
    if (!form.productName.trim() || !form.productCode.trim()) {
      setActionError('商品名称与编码不能为空');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('product.create', { ...form, productName: form.productName.trim(), productCode: form.productCode.trim() });
      setCreating(false);
      setForm({ productName: '', productCode: '', model: '', unit: '' });
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
    if (!target?.productId) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('product.delete', { productId: target.productId });
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
        title="商品管理"
        subtitle={total !== undefined ? `共 ${total} 个商品` : '维护商品主数据'}
        actions={
          <>
            <Button ariaLabel="刷新" onClick={reload}>
              刷新
            </Button>
            <Button variant="primary" ariaLabel="新增商品" onClick={() => setCreating((v) => !v)}>
              {creating ? '收起' : '新增'}
            </Button>
          </>
        }
      />

      {creating ? (
        <Section title="新增商品">
          <Card>
            <Stack>
              <Field label="商品名称 *">
                <Input value={form.productName} onChange={(v) => setForm((f) => ({ ...f, productName: v }))} placeholder="请输入商品名称" />
              </Field>
              <Field label="商品编码 *">
                <Input value={form.productCode} onChange={(v) => setForm((f) => ({ ...f, productCode: v }))} placeholder="请输入编码" mono />
              </Field>
              <Field label="规格型号">
                <Input value={form.model} onChange={(v) => setForm((f) => ({ ...f, model: v }))} placeholder="选填" />
              </Field>
              <Field label="计量单位">
                <Input value={form.unit} onChange={(v) => setForm((f) => ({ ...f, unit: v }))} placeholder="如：件 / 箱 / 个" />
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
        placeholder="商品名 / 编码 / 型号"
      />

      <Section title={`商品列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied
                ? '没有匹配的商品，试试换个关键词。'
                : '还没有商品。点击右上角「新增」录入第一个商品，之后就可以给商品入库并绑定标签。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => (
                  <DataRow
                    key={r.productId ?? r.productCode}
                    id={r.productCode}
                    main={r.productName ?? '未命名商品'}
                    sub={
                      <>
                        {r.model ? <span>{r.model} · </span> : null}
                        <span>{r.unit ?? '—'}</span>
                      </>
                    }
                    trailing={
                      <Button ariaLabel={`删除 ${r.productName ?? ''}`} onClick={() => setPendingDelete(r)}>
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
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </Toolbar>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        title="删除商品"
        danger
        confirmLabel="删除"
        message={
          <>
            确定要删除 <Mono>{pendingDelete?.productName ?? ''}</Mono> 吗？
            该商品下的库存与标签关联会一并失效，此操作不可撤销。
          </>
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(undefined)}
      />
    </Stack>
  );
}
