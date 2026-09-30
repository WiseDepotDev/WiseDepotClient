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
import { CaptchaRow, useCaptcha } from '../shared/CaptchaField.js';

/**
 * 标签管理（inventory/tag）。
 *
 * 这一域里**唯一有批量操作**的屏，也是唯一要用验证码的业务屏：
 * 批量绑定/解绑在服务端被当作危险操作（`/api/tag/batch-bind-with-captcha`），
 * 因此它同时验证了两件基础设施 —— 多选 + 可复用验证码。
 *
 * 交互上刻意做成"选 → 批量动作 → 二次确认（含验证码）"三步，
 * 而不是每行一个按钮：操作员现场是**拿着扫码枪连续扫**，逐行点按钮根本不现实。
 */

interface TagRow {
  readonly tagId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly productName?: string;
  readonly productCode?: string;
}

const PAGE_SIZE = 20;

export function TagListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const [batch, setBatch] = useState<'bind' | 'unbind' | undefined>(undefined);
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const captcha = useCaptcha(bridge);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'tag.list', {
    page,
    size: PAGE_SIZE,
  });

  const all = asList<TagRow>(data);
  const total = asTotal(data);
  const rows = applied
    ? all.filter((r) =>
        `${r.barcode ?? ''}${r.rfid ?? ''}${r.nfcUid ?? ''}${r.productName ?? ''}`
          .toLowerCase()
          .includes(applied.toLowerCase()),
      )
    : all;
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;

  const toggle = (tagId: number | undefined): void => {
    if (tagId === undefined) {
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  const runBatch = async (): Promise<void> => {
    const tagIds = [...selected];
    if (tagIds.length === 0) {
      setActionError('请先选择要操作的标签');
      return;
    }
    if (batch === 'bind' && (!productId.trim() || !captcha.code.trim())) {
      setActionError('批量绑定需要商品编号与验证码');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      if (batch === 'bind') {
        await bridge.call('tag.batchBindWithCaptcha', {
          tagIds,
          productId: Number(productId),
          captchaId: captcha.captchaId,
          captchaCode: captcha.code.trim(),
        });
      } else {
        await bridge.call('tag.batchUnbind', { tagIds });
      }
      setSelected(new Set());
      setProductId('');
      setBatch(undefined);
      reload();
    } catch (e) {
      setActionError(humanize(e as never));
      // 危险操作的验证码是一次性的：失败就换一张，不让用户对着作废的图重试
      if (batch === 'bind') {
        captcha.refreshAfterFailure();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="标签管理"
        subtitle={total !== undefined ? `共 ${total} 个标签` : '条码 / RFID / NFC 标签'}
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
        placeholder="条码 / RFID / 商品名"
      />

      {actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      <Section title={`标签列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied
                ? '没有匹配的标签，试试换个关键词。'
                : '还没有标签。点击右上角刷新，或先在「商品管理」建好商品再批量生成标签。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((r) => {
                  const tagId = r.tagId;
                  const isSelected = tagId !== undefined && selected.has(tagId);
                  return (
                    <DataRow
                      key={tagId ?? r.barcode}
                      id={r.barcode ?? r.rfid}
                      main={
                        <>
                          {isSelected ? '☑ ' : '☐ '}
                          {r.productName ?? '未绑定商品'}
                        </>
                      }
                      sub={
                        <>
                          {r.rfid ? <span className="w-mono">{r.rfid}</span> : null}
                          {r.productCode ? <span className="w-muted"> · {r.productCode}</span> : null}
                        </>
                      }
                      trailing={
                        r.status === 1 ? (
                          <Chip tone="ok">
                            <Dot tone="ok" />
                            已绑定
                          </Chip>
                        ) : (
                          <Chip tone="neutral">
                            <Dot tone="idle" />
                            未绑定
                          </Chip>
                        )
                      }
                      active={isSelected}
                      onSelect={() => toggle(tagId)}
                    />
                  );
                })}
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

      {/* 批量动作钉在底部：现场是"扫一批 → 一次提交"，逐行点按钮不现实 */}
      <BottomActionBar>
        <span className="w-muted w-mono">{`已选 ${selected.size}`}</span>
        <Button ariaLabel="批量绑定" disabled={selected.size === 0} onClick={() => setBatch('bind')}>
          批量绑定
        </Button>
        <Button ariaLabel="批量解绑" disabled={selected.size === 0} onClick={() => setBatch('unbind')}>
          批量解绑
        </Button>
      </BottomActionBar>

      <ConfirmDialog
        open={batch !== undefined}
        title={batch === 'bind' ? '批量绑定标签' : '批量解绑标签'}
        danger={batch === 'unbind'}
        confirmLabel={batch === 'bind' ? '绑定' : '解绑'}
        message={
          <Stack>
            <span>
              将对 <Mono>{`${selected.size}`}</Mono> 个标签执行
              {batch === 'bind' ? '绑定' : '解绑'}，此操作不可撤销。
            </span>
            {batch === 'bind' ? (
              <>
                <Field label="目标商品编号 *">
                  <Input value={productId} onChange={setProductId} placeholder="如：1" mono />
                </Field>
                <CaptchaRow state={captcha} label="验证码 *" />
              </>
            ) : null}
            {actionError ? (
              <span className="w-state w-state--error">{actionError}</span>
            ) : null}
          </Stack>
        }
        onConfirm={() => void runBatch()}
        onCancel={() => {
          setBatch(undefined);
          setActionError(undefined);
        }}
      />
    </Stack>
  );
}
