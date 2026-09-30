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
import { asList, humanize } from '../shared/api.js';
import type { Navigator } from '../registry.js';

/**
 * 新建出入库单（inventory/stockOrder 的"写"入口）。
 *
 * 这一屏补的是库存域缺的那件事：**单据从哪来**。此前列表屏里有个内联小表单，
 * 但它只够"随便建一张"——单号没人给、类型固定、建单人靠手输。
 *
 * 五条刻意的选择（前三条例外，其它都照抄巡检任务建单屏的结构）：
 * 1. **单号由界面预填一个可改的默认值**：服务端不生成单号（
 *    `createStockOrder` 第一件事就是校验单号非空白），所以"空着让后端补"这条路
 *    在服务端根本不成立。预填「入库-20260930-2235」这种一眼能读的编号，
 *    同时明确写着"可以改"——仓库自有编号规则时直接覆盖即可。
 * 2. **建单人必须自己拿得到，拿不到就不发请求**：服务端要求建单人非空，
 *    而且后续提交、审核都会把这个人当作经办人。取不到当前账号时，
 *    发一个注定被拒的请求只会让操作员看到一句与他无关的报错。
 * 3. **新建时不指定单据状态**：服务端对"没给状态"的默认值就是待审批，
 *    正是新建该有的状态；显式传一个状态反而给了把单子直接建成"已完成"的口子。
 * 4. **仓库做成"输入序号 + 下方列出可选值"**：`@wise/patterns` 里没有下拉框，
 *    在屏里新造一个控件会把外观与触控尺寸的纪律从组件层漏出来。
 *    仓库序号确定的直接敲数字，不确定的看下面的列表（列的是仓库名，不是裸编号）。
 * 5. **明细分录不在本屏**：明细要配标签，属另一条流程（见详情屏的说明）。
 *    「宁可少字段，也不要假字段」——摆一个填了不生效的明细框比不摆更糟。
 */

interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
}

/**
 * 选项行去掉 `undefined` 之后的形状。
 *
 * 为什么值得单独收一层：仓库编号是必填项，但返回里理论上可能缺；
 * 列表渲染时"编号一定在"这件事得**被代码证明一次**，
 * 之后每一行都能当它一定在来用，不必每处都写一遍可选判断。
 *
 * 写成「交叉类型」而不是新接口，是为了让这个收窄谓词本身能通过类型检查：
 * 谓词的返回类型必须是入参类型的子类型，重新声明一遍字段反而会不算数。
 */
type WarehouseOption = WarehouseRow & { readonly warehouseId: number };

interface CurrentUser {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
}

/** 选项一次取回的量：仓库是几十条量级，够用且不用翻页。 */
const OPTION_PAGE_SIZE = 50;

/** 单据类型：服务端只认这两个取值，别的字符串一律按入库处理。 */
type OrderType = 'IN' | 'OUT';

const ORDER_TYPES: readonly { readonly value: OrderType; readonly label: string; readonly prefix: string }[] = [
  { value: 'IN', label: '入库', prefix: 'IN' },
  { value: 'OUT', label: '出库', prefix: 'OUT' },
];

type IdParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok'; readonly id: number }
  | { readonly kind: 'invalid' };

/** 序号解析：空 = 没选（合法），正整数 = 选好了，其余都是"填错了"。 */
function parseId(raw: string): IdParse {
  const text = raw.trim();
  if (text === '') {
    return { kind: 'empty' };
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', id: parsed };
}

function idOf(raw: string): number | undefined {
  const parsed = parseId(raw);
  return parsed.kind === 'ok' ? parsed.id : undefined;
}

function idErrorText(raw: string, label: string): string | undefined {
  return parseId(raw).kind === 'invalid' ? `${label}要填大于 0 的整数，例如 12` : undefined;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 默认单号：`IN-20260930-2235`（类型 + 日期 + 时分）。
 *
 * 为什么带上时分而不是流水号：客户端不掌握当天已开到第几号，
 * 硬凑一个"当天第 n 号"会在两个人同时建单时撞车。日期+时分一眼能看出是哪批货，
 * 撞了也能当场看出来并改掉——比一个看似规范实则冲突的流水号诚实。
 */
function defaultOrderNo(type: OrderType, now: Date): string {
  const prefix = ORDER_TYPES.find((t) => t.value === type)?.prefix ?? 'IN';
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  return `${prefix}-${date}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

function warehouseOptionRows(value: unknown): readonly WarehouseOption[] {
  return asList<WarehouseRow>(value).filter(
    (warehouse): warehouse is WarehouseOption => warehouse.warehouseId !== undefined,
  );
}

interface CreatedOrder {
  readonly orderId: number | undefined;
  readonly orderNo: string | undefined;
}

/**
 * 从建单返回里读出"刚建的是哪一张"。
 *
 * 字段名做兜底（`orderId` / `id`、`orderNo` / `orderCode`）是**刻意**的：
 * 这一屏的全部价值就是给出新单据的单号，返回形状一旦不同就白建了；
 * 读不出来时宁可少显示，也不猜。
 */
function createdOrderOf(value: unknown): CreatedOrder | undefined {
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record['data'] ?? record['result'];
  const source =
    nested !== undefined && nested !== null && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : record;
  const rawId = source['orderId'] ?? source['id'];
  const rawNo = source['orderNo'] ?? source['orderCode'];
  const orderId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
  const orderNo = typeof rawNo === 'string' && rawNo.trim() !== '' ? rawNo : undefined;
  return orderId === undefined && orderNo === undefined ? undefined : { orderId, orderNo };
}

/**
 * 仓库选择器：上面输入序号，下面列出可选值（整行可点，触摸目标由行高保证）。
 *
 * 输入的是数字时说明操作员已经知道编号，此时不拿这个数字去筛列表 ——
 * 否则他正要选的那一条会被自己筛掉；输入的是文字时按名称 / 编码筛。
 */
function WarehousePicker({
  selectedId,
  options,
  loading,
  callError,
  onSelect,
  onRetry,
  disabled,
}: {
  selectedId: number | undefined;
  options: readonly WarehouseOption[];
  loading: boolean;
  callError: { code: string; text: string } | undefined;
  onSelect: (id: number) => void;
  onRetry: () => void;
  disabled: boolean;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const text = query.trim();
  const keyword = idOf(text) !== undefined ? '' : text.toLowerCase();
  const rows =
    keyword === ''
      ? options
      : options.filter((option) =>
          `${option.warehouseName ?? ''}${option.warehouseCode ?? ''}`.toLowerCase().includes(keyword),
        );
  const selected = selectedId === undefined ? undefined : options.find((o) => o.warehouseId === selectedId);
  const fieldError = idErrorText(query, '仓库序号');

  const choose = (id: number): void => {
    // 建单进行中不接受改选：行仍然是整行可点的（触摸目标不缩水），
    // 只是这一次点击不产生效果，避免在请求飞行途中换仓库。
    if (disabled) {
      return;
    }
    setQuery(String(id));
    onSelect(id);
  };

  return (
    <Card>
      <Stack>
        <Field label="目的仓库序号 *" error={fieldError}>
          <Input
            value={query}
            onChange={setQuery}
            placeholder="仓库序号，如：1"
            mono
            ariaLabel="目的仓库序号"
          />
        </Field>
        <Toolbar>
          <Chip tone={selected ? 'ok' : 'neutral'}>
            <Dot tone={selected ? 'ok' : 'idle'} />
            {selected
              ? `已选：${selected.warehouseName ?? `仓库 ${selected.warehouseId ?? ''}`}`
              : '尚未选择仓库'}
          </Chip>
          <Button ariaLabel="清除已选仓库" disabled={disabled || query === ''} onClick={() => setQuery('')}>
            清除
          </Button>
        </Toolbar>
        <ListStateHost
          loading={loading}
          error={callError}
          items={rows}
          emptyText="还没有可选的仓库。请先到「仓库管理」建一个仓库，再回来建单。"
          onRetry={onRetry}
        >
          {(items) => (
            <DataList>
              {items.map((option) => (
                <DataRow
                  key={option.warehouseId}
                  id={option.warehouseCode ?? `序号 ${option.warehouseId ?? ''}`}
                  main={option.warehouseName ?? `仓库 ${option.warehouseId ?? ''}`}
                  sub={<span className="w-mono">{`序号 ${option.warehouseId ?? '未登记'}`}</span>}
                  trailing={
                    selectedId === option.warehouseId ? (
                      <Chip tone="ok">
                        <Dot tone="ok" />
                        已选
                      </Chip>
                    ) : null
                  }
                  active={selectedId === option.warehouseId}
                  onSelect={() => choose(option.warehouseId)}
                />
              ))}
            </DataList>
          )}
        </ListStateHost>
        <span className="w-muted">
          货物要放进哪个仓库（出库则是从哪个仓库出货）。输入仓库名称里的字可以筛选下面的列表；也可以直接点列表里的仓库。
        </span>
      </Stack>
    </Card>
  );
}

export function StockOrderCreateScreen({
  bridge,
  onNavigate,
}: {
  bridge: Bridge;
  /** 传了才渲染「查看该单」：去下一层是外围的事，屏不该假定自己能跳转。 */
  onNavigate?: Navigator | undefined;
}): React.ReactElement {
  const [orderNo, setOrderNo] = useState(() => defaultOrderNo('IN', new Date()));
  const [orderNoTouched, setOrderNoTouched] = useState(false);
  const [orderType, setOrderType] = useState<OrderType>('IN');
  const [warehouseId, setWarehouseId] = useState<number | undefined>(undefined);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedOrder | undefined>(undefined);

  // 仓库选项与当前账号都常驻取数（没有前置条件），失败只影响当前这一块，不阻断整屏
  const warehouseCall = useBridgeCall<unknown>(bridge, 'warehouse.list', { page: 1, size: OPTION_PAGE_SIZE });
  const userCall = useBridgeCall<CurrentUser>(bridge, 'user.current');

  const currentUserId = userCall.data?.userId;
  const canIdentifyUser = typeof currentUserId === 'number' && Number.isFinite(currentUserId);

  // 序号填错由选择器自己报（错误挂在那个输入框下面），这里只汇总"能不能提交"
  const orderNoError = orderNo.trim() === '' ? '单号不能为空，请填写一个能认出来的单号' : undefined;
  const formError = orderNoError;

  const switchType = (next: OrderType): void => {
    setOrderType(next);
    // 单号前缀跟着类型走，但**只在用户没自己改过时**才覆盖：
    // 改过就说明他有自己的编号规则，替他把号码改回去比不改更糟。
    if (!orderNoTouched) {
      setOrderNo(defaultOrderNo(next, new Date()));
    }
  };

  const reloadOptions = (): void => {
    warehouseCall.reload();
    userCall.reload();
  };

  const openCreated = (): void => {
    const orderId = created?.orderId;
    if (orderId === undefined) {
      return;
    }
    onNavigate?.({ method: 'stockOrder.detail', params: { orderId: String(orderId) } });
  };

  const submit = async (): Promise<void> => {
    if (!canIdentifyUser) {
      setActionError('还没有拿到当前登录的账号，无法记录建单人。请点右上角「刷新」重试，或重新登录后再建单。');
      return;
    }
    if (formError !== undefined) {
      setActionError('还有填写不正确的地方，请先按字段下方的提示改正，再建单。');
      return;
    }
    if (warehouseId === undefined) {
      setActionError('请先选择目的仓库：可以在下方列表里点一个仓库，或直接输入仓库序号。');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      // 只把服务端要的字段发出去：单据状态留空（服务端默认待审批），
      // 明细留空（本屏不录明细，逐条加明细在详情屏里做）。
      const payload: Record<string, unknown> = {
        orderNo: orderNo.trim(),
        warehouseId,
        orderType,
        createBy: currentUserId,
      };
      const trimmedRemark = remark.trim();
      if (trimmedRemark !== '') {
        payload['remark'] = trimmedRemark;
      }
      const value = await bridge.call<unknown>('stockOrder.create', payload);
      setCreated(createdOrderOf(value));
      setNotice('单据已建好，当前是待审批状态。接下来到单据里逐条登记明细，再提交审核。');
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  const selectedWarehouse =
    warehouseId === undefined
      ? undefined
      : warehouseOptionRows(warehouseCall.data).find((w) => w.warehouseId === warehouseId);

  return (
    <Stack>
      <PageHeader
        title="新建出入库单"
        subtitle="选择入库或出库、填上目的仓库与单号，即可建单"
        actions={
          <Button ariaLabel="刷新仓库与账号" disabled={busy} onClick={reloadOptions}>
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
          <Stack tight>
            <span>{notice}</span>
            <KeyValue
              k="单号"
              v={
                <Mono>
                  {created?.orderNo ?? '后台没有回传，请到「出入库单」列表里按这个单号找'}
                </Mono>
              }
            />
            <KeyValue
              k="单据编号"
              v={
                <Mono>
                  {created?.orderId !== undefined
                    ? String(created.orderId)
                    : '后台没有回传，请到「出入库单」列表里查看'}
                </Mono>
              }
            />
            <span className="w-muted">
              {created?.orderId === undefined
                ? '单据已经建好，但这次没有拿到单据编号。到「出入库单」列表刷新一次即可看到它。'
                : '记下这个编号：加明细、提交审核都要用它。'}
            </span>
            {onNavigate !== undefined && created?.orderId !== undefined ? (
              <Toolbar>
                <Button variant="primary" ariaLabel="查看刚建的单据" onClick={openCreated}>
                  查看该单
                </Button>
              </Toolbar>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Section title="单据信息">
        <Stack>
          <Card>
            <Stack>
              <span>单据类型 *</span>
              <Toolbar>
                {ORDER_TYPES.map((type) => (
                  <Button
                    key={type.value}
                    variant={orderType === type.value ? 'primary' : 'default'}
                    ariaLabel={`选择${type.label}`}
                    disabled={busy}
                    onClick={() => switchType(type.value)}
                  >
                    {orderType === type.value ? `${type.label}（已选）` : type.label}
                  </Button>
                ))}
              </Toolbar>
              <span className="w-muted">
                入库 = 货进来，出库 = 货出去。审核通过后，入库会加库存、出库会减库存。
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack>
              <Field label="单号 *" error={orderNoError}>
                <Input
                  value={orderNo}
                  onChange={(v) => {
                    setOrderNo(v);
                    setOrderNoTouched(true);
                  }}
                  placeholder="如：IN-20260930-2235"
                  mono
                  ariaLabel="单号"
                />
              </Field>
              <span className="w-muted">
                已经按类型和日期预填了一个，「可以改」——仓库有自己的编号规则时直接改成你们的号码。单号不能留空，也不会由系统补。
              </span>
            </Stack>
          </Card>

          <WarehousePicker
            selectedId={warehouseId}
            options={warehouseOptionRows(warehouseCall.data)}
            loading={warehouseCall.loading}
            callError={
              warehouseCall.error
                ? { code: warehouseCall.error.code, text: humanize(warehouseCall.error) }
                : undefined
            }
            onSelect={setWarehouseId}
            onRetry={warehouseCall.reload}
            disabled={busy}
          />

          <Card>
            <Stack>
              <Field label="备注（选填）">
                <Input
                  value={remark}
                  onChange={setRemark}
                  placeholder="如：供应商送货单号、经办说明"
                  ariaLabel="备注（选填）"
                />
              </Field>
              <span className="w-muted">写点以后能对得上账的说明。留空也没问题。</span>
            </Stack>
          </Card>

          <Card>
            <ListStateHost
              loading={userCall.loading}
              error={userCall.error ? { code: userCall.error.code, text: humanize(userCall.error) } : undefined}
              items={canIdentifyUser ? [currentUserId] : []}
              emptyText="还没有拿到当前登录的账号，暂时不能建单。请点右上角「刷新」重试；如果一直这样，请重新登录。"
              onRetry={userCall.reload}
            >
              {() => (
                <Stack tight>
                  <KeyValue
                    k="建单人"
                    v={<Mono>{userCall.data?.username ?? userCall.data?.nickname ?? '当前登录账号'}</Mono>}
                  />
                  <span className="w-muted">
                    建单人按当前登录的账号自动记录，不需要手填。这个账号在提交和审核时都会作为经办人留下记录。
                  </span>
                </Stack>
              )}
            </ListStateHost>
          </Card>

          <div className="w-state">
            <span>
              明细（商品与数量）要对着实物上的标签逐条登记，安排在扫码登记那条路径上；本屏只负责把单据建出来，避免建单时被明细拖成一张长表。
            </span>
          </div>
        </Stack>
      </Section>

      {/* 主操作钉在底部：表单滚多长都不用找它 */}
      <BottomActionBar>
        <span className="w-muted w-mono">
          {selectedWarehouse
            ? `${orderType === 'IN' ? '入库' : '出库'} · ${selectedWarehouse.warehouseName ?? '已选仓库'}`
            : `${orderType === 'IN' ? '入库' : '出库'} · 尚未选择仓库`}
        </span>
        <Button
          variant="primary"
          block
          ariaLabel="创建出入库单"
          disabled={busy || formError !== undefined || !canIdentifyUser || warehouseId === undefined}
          onClick={() => void submit()}
        >
          {busy ? '建单中…' : '建单'}
        </Button>
      </BottomActionBar>
    </Stack>
  );
}
