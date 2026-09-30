/**
 * 出入库单的类型与状态归一化 —— **库存域所有涉及出入库单的屏共用这一份**。
 *
 * ## 为什么必须抽出来
 *
 * 这段映射原先散在列表屏里，而且**两处都错了**，错法还很隐蔽：
 *
 *   1. 读的字段名是 `status`，而服务端返回的是 `orderStatus`
 *      （实测响应：`{"orderId":1,"orderType":1,"orderStatus":0,"orderTypeStr":"OUT",…}`，
 *      根本没有 `status` 这个键）→ 每一行的状态标签都在走兜底分支；
 *   2. 类型码映射反了：代码写 `1 → 入库`，而后端枚举是
 *      `INBOUND(0,"入库")` / `OUTBOUND(1,"出库")` —— 也就是**入库和出库显示反了**。
 *
 * 两处都不会被渲染用例发现（服务端渲染时没有数据），只能靠真后端回读。
 * 所以这里除了收敛成一份，还配了确定性用例（`tools/check/check-stockorder-state.mjs`）。
 *
 * ## 字段名以服务端为准（两套名字都存在，要按优先顺序取）
 *
 * | 信息 | 数字码字段 | 可读串字段 |
 * | --- | --- | --- |
 * | 类型 | `orderType` | `orderTypeStr` |
 * | 状态 | `orderStatus` | `orderStatusStr` |
 *
 * 注意 DTO 里还有 `type` / `status` 两个**从来没被填过**的字段（实测回读是 undefined）——
 * 名字很像，但取它们只会拿到空值。
 */

export type OrderType = 'inbound' | 'outbound' | 'unknown';

export type OrderStatus = 'pending' | 'submitted' | 'approved' | 'completed' | 'cancelled' | 'rejected' | 'unknown';

/** 后端 `StockOrderType`：INBOUND(0) / OUTBOUND(1)。 */
const TYPE_BY_CODE: Readonly<Record<number, OrderType>> = { 0: 'inbound', 1: 'outbound' };

/** 后端 `StockOrderStatus`：PENDING(0)/APPROVED(1)/COMPLETED(2)/CANCELLED(3)/SUBMITTED(4)/REJECTED(5)。 */
const STATUS_BY_CODE: Readonly<Record<number, OrderStatus>> = {
    0: 'pending',
    1: 'approved',
    2: 'completed',
    3: 'cancelled',
    4: 'submitted',
    5: 'rejected',
};

const TYPE_BY_TEXT: Readonly<Record<string, OrderType>> = {
    IN: 'inbound',
    INBOUND: 'inbound',
    入库: 'inbound',
    OUT: 'outbound',
    OUTBOUND: 'outbound',
    出库: 'outbound',
};

const STATUS_BY_TEXT: Readonly<Record<string, OrderStatus>> = {
    PENDING: 'pending',
    待审批: 'pending',
    SUBMITTED: 'submitted',
    待审核: 'submitted',
    APPROVED: 'approved',
    已审批: 'approved',
    /** 服务端 `convertOrderStatus` 把 PROCESSING 映射成 APPROVED，这里保持同一口径。 */
    PROCESSING: 'approved',
    COMPLETED: 'completed',
    已完成: 'completed',
    CANCELLED: 'cancelled',
    CANCELED: 'cancelled',
    已取消: 'cancelled',
    REJECTED: 'rejected',
    已驳回: 'rejected',
};

/** 先按数字码，再按文本（"1" 这种字符串也当数字码处理）。 */
function normalize(value: unknown): { code?: number; text?: string } {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { code: value };
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const t = value.trim();
        const asNumber = Number(t);
        return Number.isFinite(asNumber) ? { code: asNumber } : { text: t.toUpperCase() };
    }
    return {};
}

export interface OrderTypeFields {
    /** 数字码字段（服务端真实字段名）。 */
    readonly orderType?: unknown;
    /** 可读串字段（服务端真实字段名）。 */
    readonly orderTypeStr?: unknown;
}

export function orderTypeOf(row: OrderTypeFields | undefined): OrderType {
    // 可读串优先：它是服务端已经翻译好的，不会再出现"码表对不上"的问题
    const fromText = normalize(row?.orderTypeStr);
    if (fromText.text !== undefined && TYPE_BY_TEXT[fromText.text] !== undefined) {
        return TYPE_BY_TEXT[fromText.text] as OrderType;
    }
    const { code, text } = normalize(row?.orderType);
    if (code !== undefined && TYPE_BY_CODE[code] !== undefined) {
        return TYPE_BY_CODE[code] as OrderType;
    }
    if (text !== undefined && TYPE_BY_TEXT[text] !== undefined) {
        return TYPE_BY_TEXT[text] as OrderType;
    }
    return 'unknown';
}

export function orderTypeText(row: OrderTypeFields | undefined): string {
    switch (orderTypeOf(row)) {
        case 'inbound':
            return '入库';
        case 'outbound':
            return '出库';
        default:
            return '类型未登记';
    }
}

export interface OrderStatusFields {
    /** 数字码字段（服务端真实字段名）。 */
    readonly orderStatus?: unknown;
    /** 可读串字段（服务端真实字段名）。 */
    readonly orderStatusStr?: unknown;
}

export function orderStatusOf(row: OrderStatusFields | undefined): OrderStatus {
    const fromText = normalize(row?.orderStatusStr);
    if (fromText.text !== undefined && STATUS_BY_TEXT[fromText.text] !== undefined) {
        return STATUS_BY_TEXT[fromText.text] as OrderStatus;
    }
    const { code, text } = normalize(row?.orderStatus);
    if (code !== undefined && STATUS_BY_CODE[code] !== undefined) {
        return STATUS_BY_CODE[code] as OrderStatus;
    }
    if (text !== undefined && STATUS_BY_TEXT[text] !== undefined) {
        return STATUS_BY_TEXT[text] as OrderStatus;
    }
    return 'unknown';
}

export function orderStatusText(row: OrderStatusFields | undefined): string {
    switch (orderStatusOf(row)) {
        case 'pending':
            return '待审批';
        case 'submitted':
            return '待审核';
        case 'approved':
            return '已审批';
        case 'completed':
            return '已完成';
        case 'cancelled':
            return '已取消';
        case 'rejected':
            return '已驳回';
        default:
            return '状态未登记';
    }
}

/**
 * 状态流转：**当前状态允许做哪些动作**。
 *
 * 依据是服务端 `InOutApplicationService` 的实际分支（括号里是它的原话）：
 *   · `submit`：`非（PENDING|REJECTED）` 拒绝（"只有待处理或已驳回的单据可以提交"），
 *     且**必须先有明细**（"单据无明细，无法提交"，真后端实测到了这句）；成功后置 SUBMITTED(4)；
 *   · `withdraw`：`非 SUBMITTED` 拒绝（"只有待审核的单据可以撤回"）；成功后回 PENDING(0)；
 *   · `audit`：`非 SUBMITTED` 拒绝（"只有待审核的单据可以进行审核"），真后端实测到了这句。
 *
 * 注意 **APPROVED 与 SUBMITTED 不是一回事**：审批在提交之后，顺序是
 * 待审批 → 待审核 → 已审批。
 */
export function canSubmit(row: OrderStatusFields | undefined, itemCount: number | undefined): boolean {
    const s = orderStatusOf(row);
    return (s === 'pending' || s === 'rejected') && (itemCount ?? 0) > 0;
}

export function canAudit(row: OrderStatusFields | undefined): boolean {
    return orderStatusOf(row) === 'submitted';
}

/** 撤回只在**待审核**时可用（我一开始按"待审批也行"写，与服务端不符，已按实际分支纠正）。 */
export function canWithdraw(row: OrderStatusFields | undefined): boolean {
    return orderStatusOf(row) === 'submitted';
}

/** 明细的增删只在待审批 / 已驳回时可用（服务端："只有待处理或已驳回的单据可以添加明细/删除明细"）。 */
export function canEditItems(row: OrderStatusFields | undefined): boolean {
    const s = orderStatusOf(row);
    return s === 'pending' || s === 'rejected';
}
