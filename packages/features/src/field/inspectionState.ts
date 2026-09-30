/**
 * 巡检任务状态归一化 —— **现场域里所有涉及任务状态的屏共用这一份**。
 *
 * 为什么要抽出来：这段判定（数字码 + 中文描述 + 英文枚举三种形状）原先在
 * 任务列表屏与任务详情屏各抄了一份，而两份都犯了同一个错 ——
 * `stateText` 无条件信任 `statusDesc`。服务端列表接口的 `statusDesc` 实测给的是
 * **`COMPLETED` 这样的枚举原文**，于是界面上直接出现大写英文；
 * 现场人员不认识 `COMPLETED`，只认识"做完了没有"。
 *
 * 抽成一份之后，口径只在一个地方定义：
 *   **先翻译已知枚举 → 再信任服务端给的中文描述 → 最后按数字码兜底。**
 *
 * 没有改成"永远不用 statusDesc"，因为服务端确实会给中文描述，那是更好的文案。
 */

export type TaskState = 'pending' | 'running' | 'done' | 'paused' | 'unknown';

/** 服务端可能出现在 `statusDesc` 或 `status` 里的枚举 token。 */
const STATE_BY_ENUM: Readonly<Record<string, TaskState>> = {
    PENDING: 'pending',
    WAITING: 'pending',
    CREATED: 'pending',
    RUNNING: 'running',
    IN_PROGRESS: 'running',
    PROCESSING: 'running',
    COMPLETED: 'done',
    FINISHED: 'done',
    DONE: 'done',
    PAUSED: 'paused',
    SUSPENDED: 'paused',
    ABORTED: 'paused',
    CANCELED: 'paused',
    CANCELLED: 'paused',
};

const STATE_TEXT: Readonly<Record<TaskState, string>> = {
    pending: '待开始',
    running: '进行中',
    done: '已完成',
    paused: '已暂停',
    unknown: '状态未上报',
};

/** 状态相关的字段子集（两个屏的行类型都满足它）。 */
export interface TaskStateFields {
    readonly status?: number | undefined;
    readonly statusDesc?: string | undefined;
}

/**
 * 服务端给的是"枚举原文"吗？是则返回规范化 token，否则 `undefined`。
 * 判据：去掉空白与连字符后是**全大写 ASCII 串**。
 */
export function enumToken(value: string): string | undefined {
    const t = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    return /^[A-Z][A-Z0-9_]*$/.test(t) ? t : undefined;
}

export function taskStateOf(task: TaskStateFields): TaskState {
    const desc = task.statusDesc ?? '';
    // 中文描述优先（服务端有时给的是"已完成"这种更好的文案）
    if (desc.includes('完成')) {
        return 'done';
    }
    if (desc.includes('进行') || desc.includes('执行中')) {
        return 'running';
    }
    if (desc.includes('暂停') || desc.includes('中止')) {
        return 'paused';
    }
    const token = enumToken(desc);
    if (token !== undefined && STATE_BY_ENUM[token] !== undefined) {
        return STATE_BY_ENUM[token] as TaskState;
    }
    switch (task.status) {
        case 0:
            return 'pending';
        case 1:
            return 'running';
        case 2:
            return 'done';
        case 3:
            return 'paused';
        default:
            return 'unknown';
    }
}

export function taskStateText(task: TaskStateFields): string {
    const desc = (task.statusDesc ?? '').trim();
    // 枚举原文不上界面；中文描述原样信任
    if (desc.length > 0 && enumToken(desc) === undefined) {
        return desc;
    }
    return STATE_TEXT[taskStateOf(task)];
}
