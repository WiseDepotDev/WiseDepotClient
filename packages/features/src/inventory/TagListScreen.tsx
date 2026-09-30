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
import type { Navigator } from '../registry.js';

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

export function TagListScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  /**
   * 是否处于**批量选择模式**。
   *
   * 为什么需要这个开关：整行点击一次只能有一个属主，而这一屏对它有两个诉求 ——
   * 「点一行看看这个标签是什么」（导航）与「勾几行做批量绑定/解绑」（选择）。
   * 两者挤在同一次点击上时，批量动作会永远拿不到输入（按钮永久禁用）。
   *
   * 移动端的通行解法就是显式模式：不选时点行 = 进详情；点「选择」后点行 = 勾选，
   * 底部才出现批量动作条。这样两个能力都有明确入口，谁也不挡谁。
   */
  const [selecting, setSelecting] = useState(false);

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

  /**
   * 勾选一行（只在批量选择模式下被调用）。
   *
   * 注意：不在选择模式时，整行点击**归导航**（进标签详情）—— 一次点击只能有一个属主，
   * 这正是上面 `selecting` 开关存在的理由。
   */
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
        subtitle={
          selecting
            ? `已选 ${selected.size} 个 · 点行勾选`
            : total !== undefined
              ? `共 ${total} 个标签`
              : '条码 / RFID / NFC 标签'
        }
        actions={
          <>
            <Button
              ariaLabel={selecting ? '完成选择' : '批量选择'}
              variant={selecting ? 'primary' : 'default'}
              onClick={() => {
                setSelecting((v) => !v);
                // 退出选择模式就清空勾选：否则下次进来会看到上次残留的勾，
                // 而用户以为"我刚进来什么都没选"。
                setSelected(new Set());
              }}
            >
              {selecting ? '完成' : '选择'}
            </Button>
            <Button ariaLabel="刷新" onClick={reload}>
              刷新
            </Button>
          </>
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
                          {/* 勾选框只在选择模式出现：平时它是噪音，还会让人以为"点一下能选" */}
                          {selecting ? (isSelected ? '☑ ' : '☐ ') : null}
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
                      /*
                       * 整行点一下 = 去下一层看这个标签（返回由外壳负责）。
                       * 序号缺失的行点了什么都不做：没有目标就推不出详情，
                       * 推一个空目标过去只会让用户看到一个查不到东西的屏。
                       */
                      onSelect={() => {
                        if (tagId === undefined) {
                          return;
                        }
                        // 选择模式下点行 = 勾选；否则 = 进详情。一次点击只有一个属主，
                        // 由 `selecting` 决定它归谁（这就是那个开关存在的全部理由）。
                        if (selecting) {
                          toggle(tagId);
                          return;
                        }
                        onNavigate?.({ method: 'tag.detail', params: { tagId: String(tagId) } });
                      }}
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

      {/*
        批量动作条**只在选择模式出现**：常驻会一直摆着两个禁用按钮，
        看起来像"功能坏了"，也让用户以为行是可以勾的。
      */}
      {selecting ? (
        <BottomActionBar>
          <span className="w-muted w-mono">{`已选 ${selected.size}`}</span>
          <Button ariaLabel="批量绑定" disabled={selected.size === 0} onClick={() => setBatch('bind')}>
            批量绑定
          </Button>
          <Button ariaLabel="批量解绑" disabled={selected.size === 0} onClick={() => setBatch('unbind')}>
            批量解绑
          </Button>
        </BottomActionBar>
      ) : null}

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
