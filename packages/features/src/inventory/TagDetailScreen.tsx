import { useEffect, useRef, useState } from 'react';
import {
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
  SearchField,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import type { ScreenParams } from '../registry.js';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, humanize, shortTime } from '../shared/api.js';

/**
 * 标签详情（inventory/tag 详情）—— "扫码枪扫一下 → 看看这个标签是什么"的落点。
 *
 * ## 一屏回答三个现场问题
 * 1. **这个标签是谁** —— 条码 / RFID / NFC 三个标识；
 * 2. **它绑着哪个商品** —— 绑定的商品名与商品编码；没绑就说"还没绑定商品"（而不是画一个空格子）；
 * 3. **它是什么时候进系统的** —— 登记时间与最近更新。
 *
 * ## 取数的两处刻意取舍
 * 1. **先按标签编码查，编码为空才按系统编号查。**
 *    扫码枪读出来的是**贴在货上的条码**，系统编号只有后台才有。因此"编码"是主入口，
 *    现场不需要先查一次表才能点进详情（与 `field/DeviceDetailScreen` 同一取舍）。
 * 2. **屏参数带来的码要自动查。**
 *    `screenParams.code` 有值时是**扫码进来的路径**：此时再让用户手输一遍同一个码，
 *    等于让扫码枪白扫一次。因此开机就按它取数，输入框里也回填同一个值（用户看得见"在查什么"）。
 *
 * ## 没有查询目标时一个请求都不发
 * 两个 `useBridgeCall` 都靠 `enabled` 关掉。否则每次进这一屏都会向真后端发两次
 * 注定失败的调用（缺 `tagCode` / `tagId`），日志里看着像"这个屏一直在报错"，
 * 现场则表现为一个永远转不完的骨架。
 *
 * ## 字段口径（不凭想象编字段）
 * 字段名取自 `inventory/TagListScreen`（同域的口径）与契约里的标签详情返回体
 * （`ProductTagDTO`：`tagId / productId / barcode / nfcUid / rfid / status / createBy /
 * createTime / updateTime / productName / productCode`）——两处一致，无自造字段。
 * `createBy` 不展示：它是后台账号序号，对仓库操作员没有意义。
 *
 * ## 服务端字段可能缺失
 * 所有字段一律可选 + 兜底文案。绑定的商品名 / 商品编码缺失时给的是**业务语言**
 * （"这个标签还没绑定商品"），绝不把空值原样画给用户。
 */

interface TagDetail {
  readonly tagId?: number;
  readonly productId?: number;
  readonly barcode?: string;
  readonly nfcUid?: string;
  readonly rfid?: string;
  readonly status?: number;
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly productName?: string;
  readonly productCode?: string;
}

/** `status === 1` 表示已绑定商品 —— 与 `inventory/TagListScreen` 的判定完全同源。 */
function isBound(tag: TagDetail): boolean {
  return tag.status === 1;
}

function hasDetail(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/**
 * 返回体归一化。
 *
 * 详情接口可能给裸对象，也可能给"只有一条的列表"（与设备详情同一处理）：
 * 两种形状都见过，归一化留在这一处，界面只面对一个 `TagDetail | undefined`。
 */
function detailOf(value: unknown): TagDetail | undefined {
  if (!hasDetail(value)) {
    return undefined;
  }
  const list = asList<TagDetail>(value);
  return list.length > 0 ? list[0] : (value as TagDetail);
}

/** 条码可能是一条空串（服务端把没登记的字段给成 `''`），空白一律按"没有"处理。 */
function textOr(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? raw : fallback;
}

export function TagDetailScreen({
  bridge,
  screenParams,
}: {
  bridge: Bridge;
  screenParams?: ScreenParams | undefined;
}): React.ReactElement {
  const paramCode = screenParams?.code;

  const [codeInput, setCodeInput] = useState(paramCode ?? '');
  const [idInput, setIdInput] = useState('');
  // 显式带 `| undefined`：本仓开了 `exactOptionalPropertyTypes`，
  // "把屏参数里的可选编码原样放进可选项"只有这样才能成立
  const [lookup, setLookup] = useState<{ code?: string | undefined; id?: number | undefined }>({
    code: paramCode,
  });
  const [lookupError, setLookupError] = useState<string | undefined>(undefined);

  const hasCode = Boolean(lookup.code);
  const hasId = lookup.id !== undefined;
  const hasTarget = hasCode || hasId;

  // `enabled`：没有查询目标时不发请求 —— 见文件头"没有查询目标时一个请求都不发"
  const byCode = useBridgeCall<unknown>(
    bridge,
    'tag.byCode',
    hasCode ? { tagCode: lookup.code } : undefined,
    { enabled: hasCode },
  );
  // 编码有值时不再用编号查：一个目标只对应一次请求，避免同一屏出现两个互相矛盾的结果
  const byId = useBridgeCall<unknown>(
    bridge,
    'tag.detail',
    hasId && !hasCode ? { tagId: lookup.id } : undefined,
    { enabled: hasId && !hasCode },
  );

  // 按编码查优先（现场贴的就是条码），没有编码才回落到系统编号
  const active = hasCode ? byCode : byId;

  /*
   * 屏参数换了要重新按新的码查（扫码枪连续扫两个标签就是这种情况）。
   * 两个守卫缺一不可：
   *   · `lastParamCode` —— 屏参数没变时不动，防止覆盖用户手输的编码；
   *   · `fromScan` —— 用户手输查询之后，屏参数里的旧码不再回抢焦点。
   */
  const lastParamCode = useRef(paramCode);
  const fromScan = useRef(paramCode !== undefined);
  useEffect(() => {
    if (paramCode === undefined || paramCode === lastParamCode.current) {
      return;
    }
    lastParamCode.current = paramCode;
    if (!fromScan.current) {
      return;
    }
    setCodeInput(paramCode);
    setLookupError(undefined);
    setLookup({ code: paramCode });
  }, [paramCode]);

  const detail = hasTarget ? detailOf(active.data) : undefined;
  const loading = hasTarget ? active.loading : false;
  // 没有目标时取数根本没发生，失败也就无从谈起 —— 此时该说"输入查询条件"，不该摆错误态
  const error = hasTarget && active.error ? { code: active.error.code, text: humanize(active.error) } : undefined;
  const reload = (): void => {
    active.reload();
  };

  const openByCode = (): void => {
    const code = codeInput.trim();
    if (!code) {
      setLookupError('请输入标签编码后再查询');
      return;
    }
    fromScan.current = true;
    setLookupError(undefined);
    setLookup({ code });
  };

  const openById = (): void => {
    const id = Number(idInput.trim());
    if (!Number.isFinite(id) || id <= 0) {
      setLookupError('请输入正确的标签序号（正整数）');
      return;
    }
    // 注意这里**故意丢掉编码**：编码留着就会优先按编码查，于是"按序号查"变成一句空话
    fromScan.current = false;
    setLookupError(undefined);
    setLookup({ id });
  };

  // 扫错了 / 输错了的出口：清空目标，回到"输入查询条件"的空态
  const clearLookup = (): void => {
    setCodeInput('');
    setLookupError(undefined);
    setLookup({});
  };

  const bound = detail !== undefined && isBound(detail);
  const productName = detail?.productName?.trim() ?? '';
  const productCode = detail?.productCode?.trim() ?? '';
  // 服务端可能只给了一半（有名字没编码），所以按"缺哪个补哪个"拼，不给半个句子
  const boundOneLine =
    productName && productCode
      ? `${productName}（编码 ${productCode}）`
      : productName || (productCode ? `编码 ${productCode}` : '已绑定商品（商品信息未登记）');

  const headerTitle = bound ? productName || '已绑定商品' : '标签详情';
  const headerSubtitle = hasCode
    ? bound
      ? `标签编码 ${lookup.code} · ${boundOneLine}`
      : `标签编码 ${lookup.code} · 这个标签还没绑定商品`
    : '扫码或输入标签编码，查看这个标签绑定的商品';

  return (
    <Stack>
      <PageHeader
        title={headerTitle}
        subtitle={headerSubtitle}
        actions={
          <Button variant="primary" ariaLabel="刷新标签详情" disabled={!hasTarget} onClick={reload}>
            刷新
          </Button>
        }
      />

      <Section title="查询标签">
        <Card>
          <Stack tight>
            <SearchField
              value={codeInput}
              onChange={setCodeInput}
              onSearch={openByCode}
              placeholder="标签编码（扫码枪扫出来的那一串）"
            />
            <Toolbar>
              <Field label="或者按标签序号查询">
                <Input value={idInput} onChange={setIdInput} onEnter={openById} placeholder="如：12" mono />
              </Field>
              <Button ariaLabel="按标签序号查询" onClick={openById}>
                查询
              </Button>
              {hasTarget ? (
                <Button ariaLabel="清空查询条件" onClick={clearLookup}>
                  重新扫描
                </Button>
              ) : null}
            </Toolbar>
            {lookupError ? (
              <div className="w-state w-state--error">
                <span>{lookupError}</span>
              </div>
            ) : null}
            {!hasTarget ? (
              <span className="w-muted">
                用扫码枪直接扫标签，或在上方输入标签编码；也可以按标签序号查询。标签编码是贴在货上的那一串字符。
              </span>
            ) : null}
          </Stack>
        </Card>
      </Section>

      <Section title="标签信息">
        <Card>
          <ListStateHost
            loading={loading}
            error={error}
            items={detail ? [detail] : []}
            emptyText={
              hasTarget
                ? '没有找到这个标签。请核对编码是否扫全（漏字符、多空格都会查不到），或联系管理员确认这个标签已在后台登记。'
                : '还没有查询目标。请在上方输入标签编码后点「查询」，或用扫码枪扫一个标签。'
            }
            onRetry={reload}
          >
            {(items) => {
              const d = items[0] ?? {};
              return (
                <Stack tight>
                  <Toolbar>
                    {isBound(d) ? (
                      <Chip tone="ok">
                        <Dot tone="ok" />
                        已绑定商品
                      </Chip>
                    ) : (
                      <Chip tone="neutral">
                        <Dot tone="idle" />
                        未绑定商品
                      </Chip>
                    )}
                    {d.tagId !== undefined ? <Mono>{`标签序号 ${d.tagId}`}</Mono> : null}
                  </Toolbar>
                  <KeyValue k="商品名称" v={boundOneLine} />
                  <KeyValue k="商品编码" v={<Mono>{productCode || '未绑定商品，暂无商品编码'}</Mono>} />
                </Stack>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title="标签信息（标识与登记）">
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error}
            items={detail ? [detail] : []}
            emptyText="查询到标签后，这里会显示它的条码、RFID、NFC 三个标识与登记时间。"
            onRetry={reload}
          >
            {(items) => {
              const d = items[0] ?? {};
              return (
                <DataList>
                  <DataRow
                    main="条码"
                    sub="贴在货上的那串字符，扫码枪读的就是它"
                    trailing={<Mono>{textOr(d.barcode, '未登记条码')}</Mono>}
                  />
                  <DataRow
                    main="RFID"
                    sub="无线射频标识，用于远距离批量读取"
                    trailing={<Mono>{textOr(d.rfid, '未登记 RFID')}</Mono>}
                  />
                  <DataRow
                    main="NFC"
                    sub="近场标识，用于贴近读取"
                    trailing={<Mono>{textOr(d.nfcUid, '未登记 NFC')}</Mono>}
                  />
                  <DataRow main="登记时间" sub="这个标签进入系统的时间" trailing={shortTime(d.createTime) || '未记录'} />
                  <DataRow main="最近更新" sub="标签信息最后一次变动的时间" trailing={shortTime(d.updateTime) || '暂无更新记录'} />
                </DataList>
              );
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <span className="w-muted">
          标签的绑定与解绑在「标签管理」里做。若这个标签绑错了商品，请到标签管理里重新绑定，不要改动实物标签。
        </span>
      </Toolbar>
    </Stack>
  );
}
