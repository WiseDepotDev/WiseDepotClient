/**
 * 键击组装器 —— 扫码枪识别的**纯逻辑核心**。
 *
 * ## 为什么独立成一个不依赖 DOM 的类
 *
 * 判定规则是这段功能里唯一容易出错、而且**出错时不容易被发现**的部分：
 * 漏判 = 扫码没反应（现场会当作"枪坏了"）；误判 = 人打字时突然弹出一个扫码结果。
 * 把它和 `document.addEventListener` 分开，才能用确定性用例把边界钉死
 * （见 `tools/check/check-scan.mjs`），而不是靠"在真机上多扫几次看看"。
 *
 * ## 键盘式扫码枪是什么
 *
 * 它就是一只**键盘**：把条码逐字符"打"出来，字符间隔通常在 1–5ms，
 * 末尾追加一个 Enter（有的会配成 Tab）。所以识别依据只有两条：
 *
 *   1. **相邻字符的间隔**都要短于 `maxGapMs`；
 *   2. 结束时收到终止符，且这一段长度达到 `minLength`。
 *
 * 人打字为什么不会被误判：`maxGapMs` 默认 50ms，等于**每秒 20 个字符**、
 * 持续 8 个字符以上不间断 —— 这是专业速录的水平，仓库里敲编号不会到这个速度。
 * 反过来，扫码枪的 1–5ms 离阈值有十倍余量，现场也不会漏判。
 *
 * ## 一个刻意的取舍：不吞按键
 *
 * 扫到的字符**照常落进当前获得焦点的输入框**（本类不碰默认行为）。
 * 因为现场最常见的用法正是"扫进某个输入框"，如果这里把字符吃掉，
 * 输入框就永远收不到内容了。需要"只扫码、不进输入框"的场景由调用方
 * 自己处理（聚焦到别处），而不是让识别器替它做决定。
 */

export interface ScanAssemblerOptions {
    /** 少于这个长度不算扫码（默认 4）。 */
    readonly minLength?: number;
    /**
     * 相邻字符允许的最大间隔（毫秒，默认 50）。
     * 超过它就从**当前字符重新开始**一段，而不是把两段接起来。
     */
    readonly maxGapMs?: number;
    /** 结束符（默认 Enter 与 Tab）。 */
    readonly terminators?: readonly string[];
    /** 缓冲上限（默认 128）：超过就丢弃重来，防止异常输入把内存撑住。 */
    readonly maxLength?: number;
}

export type ScanStep =
    /** 攒够了一次扫码。 */
    | { readonly kind: 'scan'; readonly code: string }
    /** 还在攒，尚未成码。 */
    | { readonly kind: 'accumulating'; readonly buffer: string }
    /** 这一段被丢弃了（间隔过长、或终止但太短）。 */
    | { readonly kind: 'discarded' }
    /** 与扫码无关的键（Shift、方向键、组合键……），缓冲保持不变。 */
    | { readonly kind: 'ignored' };

const DEFAULTS = {
    minLength: 4,
    maxGapMs: 50,
    terminators: ['Enter', 'Tab'] as readonly string[],
    maxLength: 128,
};

export class ScanAssembler {
    private readonly minLength: number;
    private readonly maxGapMs: number;
    private readonly terminators: readonly string[];
    private readonly maxLength: number;

    private buffer = '';
    private lastAt = Number.NEGATIVE_INFINITY;
    /**
     * 本段是否已因超长而作废。
     *
     * 为什么要这个标志：超长时只清空缓冲是不够的 —— 后面的字符会重新攒成一段，
     * 于是**被截断的条码尾部**会以"一个短码"的形式通过校验被当成有效扫码提交。
     * 这个用例正是 `check-scan` 抓出来的（40 个字符 + maxLength=16 时识别出了 `XXXXXX`）。
     *
     * 作废要持续到**本段结束**（遇到终止符），但**下一个间隔之后必须能重新开始** ——
     * 否则一次异常输入会把之后所有扫码都吃掉。所以清除它的地方有两处：
     * 终止符（通过 reset）与间隔重启。
     */
    private overflowed = false;

    constructor(options: ScanAssemblerOptions = {}) {
        this.minLength = options.minLength ?? DEFAULTS.minLength;
        this.maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
        this.terminators = options.terminators ?? DEFAULTS.terminators;
        this.maxLength = options.maxLength ?? DEFAULTS.maxLength;
    }

    /** 当前尚未成码的缓冲（调试与测试用）。 */
    get pending(): string {
        return this.buffer;
    }

    /** 手动清空（例如失焦时）。 */
    reset(): void {
        this.buffer = '';
        this.lastAt = Number.NEGATIVE_INFINITY;
        this.overflowed = false;
    }

    /**
     * 送入一次按键。
     *
     * @param key `KeyboardEvent.key`（单字符键就是那个字符本身）
     * @param at  事件时间戳（毫秒，用同一个时钟源即可，例如 `performance.now()`）
     */
    push(key: string, at: number): ScanStep {
        if (this.terminators.includes(key)) {
            const code = this.buffer;
            const poisoned = this.overflowed;
            this.reset();
            return !poisoned && code.length >= this.minLength
                ? { kind: 'scan', code }
                : { kind: 'discarded' };
        }

        // 组合键与非字符键（Shift / ArrowLeft / F5 / 中文输入法的 "Process" 等）不参与组码
        if (key.length !== 1) {
            return { kind: 'ignored' };
        }

        // 间隔过长 → 从当前字符重新开始一段。人打字每一步都会走到这里，
        // 所以缓冲永远攒不到 minLength，也就永远不会被误判成扫码。
        // **注意这一步要放在溢出判断之前**：新的一段必须能从不作废的状态开始。
        if (at - this.lastAt > this.maxGapMs) {
            this.buffer = key;
            this.lastAt = at;
            this.overflowed = false;
            return { kind: 'accumulating', buffer: this.buffer };
        }

        if (this.overflowed) {
            // 本段已作废：剩下的字符直接丢，但要继续推进时钟，
            // 否则下一个人为停顿会被误判成"新的一段"。
            this.lastAt = at;
            return { kind: 'discarded' };
        }

        this.buffer += key;
        this.lastAt = at;

        if (this.buffer.length > this.maxLength) {
            this.buffer = '';
            this.overflowed = true;
            return { kind: 'discarded' };
        }
        return { kind: 'accumulating', buffer: this.buffer };
    }
}
