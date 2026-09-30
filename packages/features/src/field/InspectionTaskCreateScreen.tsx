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

/**
 * 新建巡检任务（field/inspection 的"写"入口）。
 *
 * 这一屏补的是现场域此前缺的那件事：**任务从哪来** —— 之前只有看，任务只能由后台下。
 *
 * 四条刻意的选择：
 * 1. **关联项做成"输入序号 + 下方列出可选值"，而不是下拉框**：`@wise/patterns` 里没有
 *    `Select`，而在屏里新造一个控件会把外观与触控尺寸的纪律从组件层漏出来；
 *    写作「输入编号 + 列表点选」反而更贴合现场 —— 手上有编号就直接敲数字，
 *    不确定就看下面的列表（列表里给的是仓库名 / 设备名 / 计划名，不是裸编号）。
 * 2. **提交按钮钉在底部**（`BottomActionBar`）：ui-spec §2 的硬规则，表单屏不允许
 *    "滚到底找按钮"。
 * 3. **选填就是选填**：三个序号与目标里程都留得空，留空时**不把这一项放进请求**，
 *    而不是放 `null` / `0` —— 后端要区分"没填"与"填了 0"。
 * 4. **填了但解析不出来时给字段级错误并禁止提交**：静默当 0 发出去，会让现场在
 *    事后对账时才发现里程记错了，比当场报错贵得多。
 */

interface PlanRow {
  readonly planId?: number;
  readonly planName?: string;
}

interface WarehouseRow {
  readonly warehouseId?: number;
  readonly warehouseName?: string;
  readonly warehouseCode?: string;
}

interface DeviceRow {
  readonly deviceId?: number;
  readonly deviceName?: string;
  readonly deviceCode?: string;
}

/** 选项统一形状：界面上只认「序号 + 可读名称 + 业务编号」三件事。 */
interface OptionRow {
  readonly id: number;
  readonly name: string;
  readonly code: string | undefined;
}

/** 选项一次取回的量：现场的计划 / 仓库 / 设备都是几十条量级，够用且不用翻页。 */
const OPTION_PAGE_SIZE = 50;

function planOptionRows(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const plan of asList<PlanRow>(value)) {
    if (plan.planId === undefined) {
      continue;
    }
    // 没有名称时也要能选：给出"巡检计划 3"这样的可读兜底，不把裸编号丢给操作员
    rows.push({ id: plan.planId, name: plan.planName ?? `巡检计划 ${plan.planId}`, code: undefined });
  }
  return rows;
}

function warehouseOptionRows(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const warehouse of asList<WarehouseRow>(value)) {
    if (warehouse.warehouseId === undefined) {
      continue;
    }
    rows.push({
      id: warehouse.warehouseId,
      name: warehouse.warehouseName ?? `仓库 ${warehouse.warehouseId}`,
      code: warehouse.warehouseCode,
    });
  }
  return rows;
}

function deviceOptionRows(value: unknown): readonly OptionRow[] {
  const rows: OptionRow[] = [];
  for (const device of asList<DeviceRow>(value)) {
    if (device.deviceId === undefined) {
      continue;
    }
    rows.push({
      id: device.deviceId,
      name: device.deviceName ?? `设备 ${device.deviceId}`,
      code: device.deviceCode,
    });
  }
  return rows;
}

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

/** 目标里程：空 = 不设目标（合法），其余必须是大于 0 的数字。 */
function parseDistance(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function distanceErrorText(raw: string): string | undefined {
  const text = raw.trim();
  return text !== '' && parseDistance(text) === undefined
    ? '目标里程要填大于 0 的数字，例如 120.5'
    : undefined;
}

interface CreatedTask {
  readonly taskId: number | undefined;
  readonly taskCode: string | undefined;
}

/**
 * 从创建任务的返回里读出"刚建的是哪一个"。
 *
 * 字段名做兜底（`taskId` / `id`、`taskCode` / `code`）是**刻意**的：这一屏的全部价值
 * 就是给出新任务的编号，返回形状一旦不同就白建了；读不出来时宁可少显示，也不猜。
 */
function createdTaskOf(value: unknown): CreatedTask | undefined {
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record['data'] ?? record['result'];
  const source =
    nested !== undefined && nested !== null && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : record;
  const rawId = source['taskId'] ?? source['id'];
  const rawCode = source['taskCode'] ?? source['code'];
  const taskId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
  const taskCode = typeof rawCode === 'string' && rawCode.trim() !== '' ? rawCode : undefined;
  return taskId === undefined && taskCode === undefined ? undefined : { taskId, taskCode };
}

/**
 * 一个关联项的选择器：上面输入序号，下面列出可选值（整行可点，触摸目标由行高保证）。
 *
 * 为什么输入框与列表**共用一个来源**：输入的是数字时说明操作员已经知道编号，
 * 此时不拿这个数字去筛列表 —— 否则他正要选的那一条会被自己筛掉；
 * 输入的是文字时按名称 / 业务编号筛。规则由控件自己承担，屏上不用重复。
 */
function OptionPicker({
  label,
  placeholder,
  hint,
  clearLabel,
  query,
  onQueryChange,
  selectedId,
  options,
  loading,
  fieldError,
  callError,
  onRetry,
  emptyText,
}: {
  label: string;
  placeholder: string;
  hint: string;
  clearLabel: string;
  query: string;
  onQueryChange: (value: string) => void;
  selectedId: number | undefined;
  options: readonly OptionRow[];
  loading: boolean;
  fieldError: string | undefined;
  callError: { code: string; text: string } | undefined;
  onRetry: () => void;
  emptyText: string;
}): React.ReactElement {
  const text = query.trim();
  const keyword = idOf(text) !== undefined ? '' : text.toLowerCase();
  const rows =
    keyword === ''
      ? options
      : options.filter((option) => `${option.name}${option.code ?? ''}`.toLowerCase().includes(keyword));
  const selected = selectedId === undefined ? undefined : options.find((option) => option.id === selectedId);

  return (
    <Card>
      <Stack>
        <Field label={label} error={fieldError}>
          <Input value={query} onChange={onQueryChange} placeholder={placeholder} mono ariaLabel={label} />
        </Field>
        <Toolbar>
          <Chip tone={selected ? 'ok' : 'neutral'}>
            <Dot tone={selected ? 'ok' : 'idle'} />
            {selected ? `已选：${selected.name}` : '未选择'}
          </Chip>
          <Button ariaLabel={clearLabel} disabled={query === ''} onClick={() => onQueryChange('')}>
            清除
          </Button>
        </Toolbar>
        <ListStateHost
          loading={loading}
          error={callError}
          items={rows}
          emptyText={emptyText}
          onRetry={onRetry}
        >
          {(items) => (
            <DataList>
              {items.map((option) => (
                <DataRow
                  key={option.id}
                  id={option.code ?? `序号 ${option.id}`}
                  main={option.name}
                  sub={<span className="w-mono">{`序号 ${option.id}`}</span>}
                  trailing={
                    selectedId === option.id ? (
                      <Chip tone="ok">
                        <Dot tone="ok" />
                        已选
                      </Chip>
                    ) : null
                  }
                  active={selectedId === option.id}
                  onSelect={() => onQueryChange(String(option.id))}
                />
              ))}
            </DataList>
          )}
        </ListStateHost>
        <span className="w-muted">{hint}</span>
      </Stack>
    </Card>
  );
}

export function InspectionTaskCreateScreen({
  bridge,
  onOpenTask,
}: {
  bridge: Bridge;
  /** 传了才渲染「查看该任务」：路由是外围的事，屏不该假定自己能跳转。 */
  onOpenTask?: ((taskId: number) => void) | undefined;
}): React.ReactElement {
  const [planQuery, setPlanQuery] = useState('');
  const [warehouseQuery, setWarehouseQuery] = useState('');
  const [deviceQuery, setDeviceQuery] = useState('');
  const [distanceQuery, setDistanceQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedTask | undefined>(undefined);

  // 三个选项列表都常驻取数（没有前置条件），失败只影响当前这一块，不阻断整屏
  const planCall = useBridgeCall<unknown>(bridge, 'inspection.planList', {});
  const warehouseCall = useBridgeCall<unknown>(bridge, 'warehouse.list', { page: 1, size: OPTION_PAGE_SIZE });
  const deviceCall = useBridgeCall<unknown>(bridge, 'device.list', {});

  const planId = idOf(planQuery);
  const warehouseId = idOf(warehouseQuery);
  const deviceId = idOf(deviceQuery);
  const targetDistance = parseDistance(distanceQuery);

  const planError = idErrorText(planQuery, '巡检计划序号');
  const warehouseError = idErrorText(warehouseQuery, '仓库序号');
  const deviceError = idErrorText(deviceQuery, '设备序号');
  const distanceError = distanceErrorText(distanceQuery);
  const formError = planError ?? warehouseError ?? deviceError ?? distanceError;

  const reloadOptions = (): void => {
    planCall.reload();
    warehouseCall.reload();
    deviceCall.reload();
  };

  const openCreated = (): void => {
    const taskId = created?.taskId;
    if (taskId === undefined || onOpenTask === undefined) {
      return;
    }
    onOpenTask(taskId);
  };

  const submit = async (): Promise<void> => {
    if (formError !== undefined) {
      setActionError('还有填写不正确的地方，请先按字段下方的提示改正，再创建任务。');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      // 只把真的填了的项放进请求：留空 = 不指定，不是 0
      const params: Record<string, number> = {};
      if (planId !== undefined) {
        params['planId'] = planId;
      }
      if (warehouseId !== undefined) {
        params['warehouseId'] = warehouseId;
      }
      if (deviceId !== undefined) {
        params['deviceId'] = deviceId;
      }
      if (targetDistance !== undefined) {
        params['targetDistance'] = targetDistance;
      }
      const value = await bridge.call<unknown>('inspection.taskCreate', params);
      setCreated(createdTaskOf(value));
      setNotice('任务已创建。接下来到「巡检任务」里把任务开起来，现场就能按它盘点了。');
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="新建巡检任务"
        subtitle="指定巡检计划、执行仓库与设备后创建任务；不指定的项目留空即可"
        actions={
          <Button ariaLabel="刷新可选值" disabled={busy} onClick={reloadOptions}>
            刷新可选值
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
              k="新任务序号"
              v={
                <Mono>
                  {created?.taskId !== undefined ? String(created.taskId) : '后台没有回传，请到「巡检任务」列表里查看'}
                </Mono>
              }
            />
            <KeyValue
              k="任务号"
              v={<Mono>{created?.taskCode ?? '后台没有回传，以列表里的任务号为准'}</Mono>}
            />
            <span className="w-muted">
              {created?.taskId === undefined
                ? '任务已经建好，但这次没有拿到任务序号。到「巡检任务」列表刷新一次即可看到它。'
                : '记下这个序号：开始盘点、上传数据、事后补录都要用它。'}
            </span>
            {onOpenTask !== undefined && created?.taskId !== undefined ? (
              <Toolbar>
                <Button variant="primary" ariaLabel="查看刚创建的任务" onClick={openCreated}>
                  查看该任务
                </Button>
              </Toolbar>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Section title="任务信息">
        <Stack>
          <OptionPicker
            label="巡检计划序号（选填）"
            placeholder="计划序号，如：3"
            hint="选填。输入计划名称里的字可以筛选下面的列表；不选计划也能创建任务。"
            clearLabel="清除已选巡检计划"
            query={planQuery}
            onQueryChange={setPlanQuery}
            selectedId={planId}
            options={planOptionRows(planCall.data)}
            loading={planCall.loading}
            fieldError={planError}
            callError={planCall.error ? { code: planCall.error.code, text: humanize(planCall.error) } : undefined}
            onRetry={planCall.reload}
            emptyText="还没有可选的巡检计划。可以留空直接创建任务，或请管理员先建立巡检计划。"
          />

          <OptionPicker
            label="执行仓库序号（选填）"
            placeholder="仓库序号，如：1"
            hint="选填。输入仓库名称里的字可以筛选下面的列表；不选仓库就按不指定仓库创建。"
            clearLabel="清除已选仓库"
            query={warehouseQuery}
            onQueryChange={setWarehouseQuery}
            selectedId={warehouseId}
            options={warehouseOptionRows(warehouseCall.data)}
            loading={warehouseCall.loading}
            fieldError={warehouseError}
            callError={
              warehouseCall.error ? { code: warehouseCall.error.code, text: humanize(warehouseCall.error) } : undefined
            }
            onRetry={warehouseCall.reload}
            emptyText="还没有可选的仓库。可以留空直接创建任务，或先到「仓库管理」建一个仓库。"
          />

          <OptionPicker
            label="执行设备序号（选填）"
            placeholder="设备序号，如：12"
            hint="选填。输入设备名称里的字可以筛选下面的列表；不选设备就按不指定设备创建。"
            clearLabel="清除已选设备"
            query={deviceQuery}
            onQueryChange={setDeviceQuery}
            selectedId={deviceId}
            options={deviceOptionRows(deviceCall.data)}
            loading={deviceCall.loading}
            fieldError={deviceError}
            callError={deviceCall.error ? { code: deviceCall.error.code, text: humanize(deviceCall.error) } : undefined}
            onRetry={deviceCall.reload}
            emptyText="还没有可选的设备。可以留空直接创建任务，或先到「设备管理」登记一台设备。"
          />

          <Card>
            <Stack>
              <Field label="目标里程（米，选填）" error={distanceError}>
                <Input
                  value={distanceQuery}
                  onChange={setDistanceQuery}
                  placeholder="如：120.5"
                  mono
                  ariaLabel="目标里程（米，选填）"
                />
              </Field>
              <span className="w-muted">只填数字，单位是米（可以带小数）。不填表示这个任务不设目标里程。</span>
            </Stack>
          </Card>
        </Stack>
      </Section>

      {/* 主操作钉在底部：表单滚多长都不用找它 */}
      <BottomActionBar>
        <span className="w-muted w-mono">
          {`已选 ${[planId, warehouseId, deviceId].filter((id) => id !== undefined).length}/3 项`}
        </span>
        <Button
          variant="primary"
          block
          ariaLabel="创建巡检任务"
          disabled={busy || formError !== undefined}
          onClick={() => void submit()}
        >
          {busy ? '创建中…' : '创建任务'}
        </Button>
      </BottomActionBar>
    </Stack>
  );
}
