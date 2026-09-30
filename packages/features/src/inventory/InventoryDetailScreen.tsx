import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
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
import { asList, humanize, shortTime } from '../shared/api.js';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import type { ScreenParams } from '../registry.js';

/**
 * 库存详情（inventory 的单条库存记录页面）。
 *
 * 这一屏只做两件事，顺序就是页面顺序：
 * 1. **这条库存现在是什么** —— 商品、仓库、库位、库存数量、已锁定量、最近盘点时间；
 * 2. **把数量锁住或放开** —— 锁定 / 解锁各要一个数量，两步都先在前端把数量拦住。
 *
 * 四条刻意的选择：
 *
 * 1. **锁定情况是派生值，不是字段**：后端的库存实体没有"状态"这一列，
 *    `InventoryDTO` 上的 `lockedQuantity` 也从来没有被写入过（见文件末尾的服务端规则）。
 *    所以本屏的「已锁定 / 未锁定」只由**已锁定量**推出来；取不到就说未上报，
 *    绝不把"查不到"画成"正常" —— 那会让操作员以为这批货没被占用。
 *
 * 2. **数量先在前端拦**：服务端对超量的拒绝（"库存不足" / "锁定数量不足"）用的是
 *    `SYS-…` 级别的错误码，这句原文到不了界面（见文件末尾）。因此"能不能填"这件事
 *    必须在本地说清楚：非正整数、超出可锁定 / 可解锁范围，一律在点开弹窗之前就提示。
 *
 * 3. **两步都可逆，所以确认弹窗用普通确认按钮**：填错数量在「解锁」里填同样的数字就能还原，
 *    所以这里的确认不是危险红；红色留给真正不可撤销的动作（见「告警详情」的结束类动作）。
 *
 * 4. **不提供"改库存数量"**：本屏只有锁定与解锁。库存数量的增减属于出入库与盘点，
 *    在详情页随手改一个数字会把账实关系改坏，那不是这一屏该管的事。
 */

interface InventoryDetail {
  readonly inventoryId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly productCode?: string;
  readonly productSpecification?: string;
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly location?: string;
  readonly quantity?: number;
  readonly lockedQuantity?: number;
  readonly status?: number;
  readonly lastCheckTime?: string;
  readonly updateTime?: string;
}

type LockState = 'locked' | 'unlocked' | 'unknown';

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/** 详情接口可能直接给一条库存，也可能裹一层（两种形状都见过），这里都接住。 */
function detailOf(value: unknown): InventoryDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<InventoryDetail>(value);
  return list.length > 0 ? list[0] : (value as InventoryDetail);
}

function lockStateOf(inv: InventoryDetail | undefined): LockState {
  const locked = inv?.lockedQuantity;
  if (typeof locked !== 'number' || !Number.isFinite(locked)) {
    return 'unknown';
  }
  return locked > 0 ? 'locked' : 'unlocked';
}

function lockStateText(state: LockState): string {
  switch (state) {
    case 'locked':
      return '已锁定';
    case 'unlocked':
      return '未锁定';
    default:
      return '锁定情况未上报';
  }
}

function lockStateTone(state: LockState): 'neutral' | 'info' | 'ok' | 'warn' | 'danger' {
  switch (state) {
    case 'locked':
      return 'warn';
    case 'unlocked':
      return 'ok';
    default:
      return 'neutral';
  }
}

function lockStateDotTone(state: LockState): 'ok' | 'warn' | 'bad' | 'idle' {
  switch (state) {
    case 'locked':
      return 'warn';
    case 'unlocked':
      return 'ok';
    default:
      return 'idle';
  }
}

/** 可锁定数量 = 库存数量 − 已锁定量（服务端的判定口径）。两项缺一就算不出来。 */
function availableQuantity(inv: InventoryDetail | undefined): number | undefined {
  const total = inv?.quantity;
  const locked = inv?.lockedQuantity;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return undefined;
  }
  if (typeof locked !== 'number' || !Number.isFinite(locked)) {
    return undefined;
  }
  return Math.max(0, total - locked);
}

function quantityText(value: number | undefined, fallback: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function timeText(value: string | undefined, fallback: string): string {
  const t = shortTime(value);
  return t === '' ? fallback : t;
}

type QuantityCheck = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

/**
 * 数量的前端校验。
 *
 * **非正整数一律在这里就拦下**（不给服务端兜）：服务端对超量只回一句笼统的拒绝，
 * 而"必须是正整数"这件事本机就能判断，没必要让操作员等一次往返再看到一句看不懂的提示。
 * 已经知道可锁定 / 可解锁范围时，顺手把上限也一起说清楚 —— 这是能提前算出来的部分；
 * 算不出来（已锁定量未上报）就不猜，交给服务端判定。
 */
function checkQuantity(text: string, kind: 'lock' | 'unlock', inv: InventoryDetail | undefined): QuantityCheck {
  const action = kind === 'lock' ? '锁定' : '解锁';
  const raw = text.trim();
  if (raw === '') {
    return { ok: false, message: `请先填写要${action}的数量。` };
  }
  // 只认纯数字：`1.5` / `1e3` / `-2` / `5 件` 全部拦在这里，而不是靠服务端拒绝
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: `${action}数量要填正整数，例如 5。` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, message: '这个数量太大了，请核对后重新填写。' };
  }
  if (kind === 'lock') {
    const available = availableQuantity(inv);
    if (available !== undefined && value > available) {
      return {
        ok: false,
        message: `这一条最多能锁定 ${available} 件（现有 ${quantityText(inv?.quantity, '未知')} 件，其中已锁定 ${quantityText(inv?.lockedQuantity, '未知')} 件）。`,
      };
    }
  } else {
    const locked = inv?.lockedQuantity;
    if (typeof locked === 'number' && Number.isFinite(locked) && value > locked) {
      return { ok: false, message: `这一条最多能解锁 ${locked} 件（当前已锁定 ${locked} 件）。` };
    }
  }
  return { ok: true, value };
}

type PendingAction = { readonly kind: 'lock' | 'unlock'; readonly quantity: number };

export function InventoryDetailScreen({
  bridge,
  screenParams,
}: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}): React.ReactElement {
  // 屏参数是字符串袋 → 库存记录序号要自己转数字；转不出来就当"没有这个目标"，
  // 不发一个必然是错的请求（服务端只认数字序号）。
  const rawInventoryId = screenParams?.inventoryId;
  const parsedInventoryId = rawInventoryId === undefined ? Number.NaN : Number(rawInventoryId.trim());
  const inventoryId =
    Number.isFinite(parsedInventoryId) && parsedInventoryId > 0 ? parsedInventoryId : undefined;
  const hasTarget = inventoryId !== undefined;

  const [quantityInput, setQuantityInput] = useState('');
  const [quantityError, setQuantityError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingAction | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const params = inventoryId !== undefined ? { inventoryId } : undefined;

  // `enabled`：没有目标时不发请求 —— 缺参数的调用到服务端必然是错，
  // 白占一次往返，还会在日志里装成"这一屏一直在报错"。
  const detailCall = useBridgeCall<unknown>(bridge, 'inventory.detail', params, { enabled: hasTarget });

  const inv = detailOf(detailCall.data);
  const lockState = lockStateOf(inv);
  const available = availableQuantity(inv);

  // 结构上做不了的动作：数量为 0 就没得锁，没有锁定量就没得解 —— 禁用并写明原因
  const nothingToLock = available !== undefined && available <= 0;
  const nothingToUnlock = lockState === 'unlocked';
  const canLock = hasTarget && !busy && !nothingToLock;
  const canUnlock = hasTarget && !busy && !nothingToUnlock;

  const lockReason =
    lockState === 'unknown'
      ? '「已锁定量」还没有上报，能不能锁由后台判定：如提示未完成，请先核对库存数量。'
      : `可锁定数量为 0（现有 ${quantityText(inv?.quantity, '未知')} 件全部已被锁定），先解锁或补货后再锁。`;
  const unlockReason =
    lockState === 'unknown'
      ? '「已锁定量」还没有上报，能不能解锁由后台判定：如提示未完成，请先核对已锁定量。'
      : '这条库存当前没有锁定数量，没有可解锁的部分。';

  const closeDialog = (): void => {
    setPending(undefined);
  };

  const openDialog = (kind: 'lock' | 'unlock'): void => {
    const check = checkQuantity(quantityInput, kind, inv);
    if (!check.ok) {
      setQuantityError(check.message);
      setActionError(undefined);
      setNotice(undefined);
      return;
    }
    setQuantityError(undefined);
    setActionError(undefined);
    setNotice(undefined);
    setPending({ kind, quantity: check.value });
  };

  const runAction = async (): Promise<void> => {
    const action = pending;
    if (action === undefined || inventoryId === undefined) {
      closeDialog();
      return;
    }
    // 弹窗开着的时候输入框还能被改，所以发请求前再校验一次，避免发了与弹窗上不同的数量
    const check = checkQuantity(quantityInput, action.kind, inv);
    if (!check.ok || check.value !== action.quantity) {
      closeDialog();
      setQuantityError(check.ok ? '数量在确认前被改动过，请重新点一次。' : check.message);
      return;
    }

    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      // 数量由桥自动放进请求（服务端这两个方法只认查询参数），这里照常当普通参数传
      if (action.kind === 'lock') {
        await bridge.call('inventory.lock', { inventoryId, quantity: action.quantity });
        setNotice(`已锁定 ${action.quantity} 件，可锁定数量相应减少 ${action.quantity} 件。`);
      } else {
        await bridge.call('inventory.unlock', { inventoryId, quantity: action.quantity });
        setNotice(`已解锁 ${action.quantity} 件，这部分数量回到可用量。`);
      }
      closeDialog();
      detailCall.reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const actionText = pending?.kind === 'unlock' ? '解锁' : '锁定';

  return (
    <Stack>
      <PageHeader
        title={inv?.productName ?? '库存详情'}
        subtitle={
          inv
            ? `${inv.productCode ?? '编码未登记'} · ${inv.warehouseName ?? '仓库未登记'} · 数量 ${quantityText(inv.quantity, '未上报')}`
            : '查看一条库存的明细，并锁定或解锁指定数量'
        }
        actions={
          <Button variant="primary" ariaLabel="刷新库存详情" disabled={!hasTarget || busy} onClick={detailCall.reload}>
            刷新
          </Button>
        }
      />

      {quantityError ? (
        <div className="w-state w-state--error">
          <span>{quantityError}</span>
        </div>
      ) : null}

      {notice ? (
        <Card>
          <span>{notice}</span>
        </Card>
      ) : null}

      <Section title="库存信息">
        <Card>
          <ListStateHost
            loading={detailCall.loading}
            error={detailCall.error ? { code: detailCall.error.code, text: humanize(detailCall.error) } : undefined}
            items={inv ? [inv] : []}
            emptyText={
              hasTarget
                ? '没有找到这条库存记录。请回到「库存查询」重新点选一条，或联系管理员核对该记录是否已被删除。'
                : '没有收到要打开的库存记录。请回到「库存查询」列表，点一条库存进来查看详情。'
            }
            onRetry={detailCall.reload}
          >
            {(items) => {
              const d: InventoryDetail = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    <Chip tone={lockStateTone(lockState)}>
                      <Dot tone={lockStateDotTone(lockState)} />
                      {lockStateText(lockState)}
                    </Chip>
                    <span className="w-chip w-mono">{`库存 ${quantityText(d.quantity, '未上报')}`}</span>
                    <span className="w-chip w-mono">{`已锁定 ${quantityText(d.lockedQuantity, '未上报')}`}</span>
                  </Toolbar>
                  <KeyValue k="商品名称" v={d.productName ?? '未命名商品'} />
                  <KeyValue k="商品编码" v={<Mono>{d.productCode ?? '未登记'}</Mono>} />
                  <KeyValue k="商品规格" v={d.productSpecification ?? '未登记规格'} />
                  <KeyValue k="所属仓库" v={<Mono>{d.warehouseName ?? '未分配仓库'}</Mono>} />
                  <KeyValue
                    k="库位"
                    v={d.location ? <Mono>{d.location}</Mono> : '未分配库位'}
                  />
                  <KeyValue k="库存数量" v={quantityText(d.quantity, '未上报，请点右上角刷新')} />
                  <KeyValue
                    k="已锁定量"
                    v={quantityText(d.lockedQuantity, '暂未上报，可向管理员核对')}
                  />
                  <KeyValue k="可锁定数量" v={quantityText(available, '算不出来：需要先知道已锁定量')} />
                  <KeyValue k="锁定情况" v={lockStateText(lockState)} />
                  <KeyValue k="最近盘点" v={timeText(d.lastCheckTime, '还没有盘点记录')} />
                  <KeyValue k="最近更新" v={timeText(d.updateTime, '还没有更新记录')} />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title="锁定与解锁">
        <Card>
          <Stack>
            <Field label="数量" error={quantityError}>
              <Input
                value={quantityInput}
                onChange={setQuantityInput}
                placeholder="如：5"
                mono
                ariaLabel="要锁定或解锁的数量"
              />
            </Field>
            <Toolbar>
              <Button variant="primary" ariaLabel="锁定库存" disabled={!canLock} onClick={() => openDialog('lock')}>
                锁定
              </Button>
              <Button ariaLabel="解锁库存" disabled={!canUnlock} onClick={() => openDialog('unlock')}>
                解锁
              </Button>
            </Toolbar>
            {/* 不能做的动作把原因写在旁边：让操作员点了才知道不行，是把后台的判定丢给他 */}
            <Stack tight>
              <span className="w-muted">
                {nothingToLock
                  ? `锁定：暂时不能做 —— ${lockReason}`
                  : '锁定：把指定数量的库存标记为已占用。填正整数，最多不超过「可锁定数量」。'}
              </span>
              <span className="w-muted">
                {nothingToUnlock ? `解锁：暂时不能做 —— ${unlockReason}` : '解锁：把已锁定的数量放回可用量。填正整数，最多不超过「已锁定量」。'}
              </span>
              <span className="w-muted">
                两步都可以还原：填错数量时，在另一边填同一个数字即可回到原来的状态。
              </span>
              <span className="w-muted">
                提示未完成时，多半是可锁定或可解锁的数量对不上：请先按上方的「库存数量」与「已锁定量」核对，再重新填写。
              </span>
              {lockState === 'unknown' ? (
                <span className="w-muted">
                  「已锁定量」暂未上报时，本页算不出可锁定数量，锁定与解锁以后台记录为准；可点右上角刷新重新获取。
                </span>
              ) : null}
            </Stack>
          </Stack>
        </Card>
      </Section>

      <ConfirmDialog
        open={pending !== undefined}
        title={`${actionText}库存`}
        danger={false}
        confirmLabel={actionText}
        message={
          <Stack>
            <span>
              {pending?.kind === 'lock'
                ? '锁定后这部分数量会被记为「已锁定」，可锁定数量相应减少。填错了不要紧，在「解锁」里填同样的数量就能还原。'
                : '解锁后这部分数量回到可用量，可以被再次锁定或用于出库。'}
            </span>
            <span className="w-muted">
              {`${inv?.productName ?? '未命名商品'} · 库存编号 ${inventoryId ?? '未登记'} · 本次${actionText} ${pending?.quantity ?? 0} 件`}
            </span>
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
 * 服务端规则（照抄 `InventoryController` / `InventoryApplicationService`，改动要同步这里）：
 *
 * · 查询详情：`GET /api/inventories/{inventoryId}` —— "查询库存明细详情信息。成功返回200；
 *   库存不存在返回404"；实现里找不到时抛 `NOT_FOUND("库存明细不存在")`。
 * · 锁定：`POST /api/inventories/{inventoryId}/lock`，数量走 `@RequestParam("quantity")`
 *   （即查询参数，契约里标 `paramStyle: query`）—— 接口说明："锁定指定数量的库存。
 *   成功返回200；库存不足返回400；库存不存在返回404"。实现里的三条硬规则：
 *     1. 数量为空或 ≤ 0 → 拒绝，原话 "锁定数量必须大于0"；
 *     2. 库存记录不存在 → 拒绝，原话 "库存明细不存在"；
 *     3. `库存数量 − 已锁定量 < 请求数量` → 拒绝，原话 "库存不足"。
 *   通过后：已锁定量 += 请求数量，刷新该商品与总量的缓存，返回更新后的库存。
 * · 解锁：`POST /api/inventories/{inventoryId}/unlock`，同样 `@RequestParam("quantity")` ——
 *   接口说明："解锁指定数量的库存。成功返回200；锁定数量不足返回400；库存不存在返回404"。实现：
 *     1. 数量为空或 ≤ 0 → 拒绝，原话 "解锁数量必须大于0"；
 *     2. 库存记录不存在 → 拒绝，原话 "库存明细不存在"；
 *     3. `已锁定量 < 请求数量` → 拒绝，原话 "锁定数量不足"。
 *   通过后：已锁定量 -= 请求数量。两者都不改「库存数量」本身。
 * · 与接口说明的偏差（实测读代码得到，写在这里免得下次又按说明去猜）：
 *   上面两句超量拒绝用的是 `SYSTEM_ERROR`（`SYS-…`），而接口说明承诺的是 400；
 *   桥侧只把 `RES-` / `VAL-` / `AUTH-` / `BIZ-` 前缀的业务原文带到界面，
 *   所以这两条拒绝的原话**到不了用户眼前**。这就是"数量必须在前端先拦"的由来。
 * · 字段空缺（本屏的兜底文案都从这里来）：`InventoryDTO` 没有 `status`（库存实体也没有
 *   这一列），实体也没有货位；`toInventoryDTO` 只回 `inventoryId / productId / warehouseId /
 *   quantity / productName / productCode / productSpecification / warehouseName` ——
 *   `lockedQuantity`、`lastCheckTime`、`updateTime`、`productUnit`、`productType` 这几个
 *   DTO 字段**从来没有被写入过**（全仓没有一处 `dto.setLockedQuantity(...)`）。
 *   服务端自己也留了话："Inventory 实体没有 locationCode，且 DTO 也没有该字段，暂时忽略"。
 *   因此本屏的「库位」「已锁定量」「最近盘点 / 最近更新」在多数记录上会是兜底文案，
 *   「锁定情况」与「可锁定数量」都是从已锁定量推出来的派生值 —— 取不到就说未上报，不假装知道。
 */
