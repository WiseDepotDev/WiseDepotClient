/**
 * 页面侧的**环境与交互证据**（人机验证用）。
 *
 * ## 分工
 *
 * 只有壳看得见的事实（是不是发布包、有没有挂调试器）由壳提供（`HumanVerifyPort`）；
 * 页面能看见的是另外三类：**自动化特征**、**渲染一致性**、**真人交互**。
 * 桥把两边合并后交给服务端。
 *
 * ## 它是什么、不是什么
 *
 * 全部字段都**可以被伪造**（`navigator.webdriver` 是脚本自己设的，轨迹也可以录下来重放）。
 * 服务端可以完全不采信 —— 放行判据只能是"服务端票据 + 风险规则 + 计算量证明"。
 * 它只用于让服务端把难度调高、以及审计。
 *
 * ## 为什么要采"交互统计量"而不是轨迹原文
 *
 * 轨迹原文能看出人的习惯动作，属于隐私。这里只上传三个统计量：
 * 采样点数、按下到抬起的时长、两次采样之间的最大跳变（脚本式瞬移的特征）。
 */

export interface PageEvidence {
  /** `navigator.webdriver`：自动化框架的默认标志。 */
  readonly webdriver?: boolean;
  /** 无头浏览器特征（UA 里的 Headless、或缺 Chromium 的 `window.chrome`）。 */
  readonly headless?: boolean;
  /** 采样点数（**越少越可疑**：`element.click()` 一个 pointer 事件都不产生）。 */
  readonly gestureSamples?: number;
  /** 按下到抬起的毫秒数。 */
  readonly gestureDurationMs?: number;
  /** 相邻采样的最大跳变（像素）——瞬移式"移动"的判据。 */
  readonly maxJumpPx?: number;
}

/**
 * 采集"当前页面环境"的证据。
 *
 * 读不到的字段**不写**（而不是写 `false`）：服务端拿"不知道"和拿"干净"是两件事，
 * 把它说成干净等于帮攻击者。
 */
export function collectPageEvidence(): PageEvidence {
  const evidence: Record<string, boolean> = {};
  try {
    if (typeof navigator !== 'undefined' && 'webdriver' in navigator) {
      evidence.webdriver = navigator.webdriver === true;
    }
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const chrome = (globalThis as { chrome?: unknown }).chrome;
    evidence.headless = /Headless/i.test(ua) || (chrome === undefined && /Chrome\//.test(ua));
  } catch {
    // 读不到就什么都不写（见上面那段）
  }
  return evidence;
}

/**
 * 指针/触摸轨迹的**统计量**采集器。
 *
 * 挂在 `window` 上而不是按钮上：用户点到按钮之前的那段移动同样是证据，
 * 而"一次瞬移直接落在按钮上"恰恰是要被看见的那种。
 */
export class GestureTracker {
  private samples = 0;

  private firstAt = 0;

  private lastAt = 0;

  private lastX = 0;

  private lastY = 0;

  private maxJump = 0;

  private listening = false;

  private readonly onMove = (event: PointerEvent): void => this.record(event.clientX, event.clientY);

  start(): void {
    if (this.listening || typeof window === 'undefined') {
      return;
    }
    this.listening = true;
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerdown', this.onMove, { passive: true });
  }

  stop(): void {
    if (!this.listening || typeof window === 'undefined') {
      return;
    }
    this.listening = false;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerdown', this.onMove);
  }

  /** 取当前统计量（**不重置**：整个会话累积，点一次按钮只读一次）。 */
  snapshot(): Required<Pick<PageEvidence, 'gestureSamples' | 'gestureDurationMs' | 'maxJumpPx'>> {
    return {
      gestureSamples: this.samples,
      gestureDurationMs: this.samples === 0 ? 0 : Math.max(0, this.lastAt - this.firstAt),
      maxJumpPx: Math.round(this.maxJump),
    };
  }

  /** 用户点了"重试"、或换了一条消息要重新验证时清空（否则上一轮的轨迹会替这一轮作证）。 */
  reset(): void {
    this.samples = 0;
    this.firstAt = 0;
    this.lastAt = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.maxJump = 0;
  }

  private record(x: number, y: number): void {
    const now = Date.now();
    if (this.samples > 0) {
      const jump = Math.hypot(x - this.lastX, y - this.lastY);
      if (jump > this.maxJump) {
        this.maxJump = jump;
      }
    } else {
      this.firstAt = now;
    }
    this.lastAt = now;
    this.lastX = x;
    this.lastY = y;
    this.samples += 1;
  }
}

/** 全应用共用一个（轨迹本来就是"这个会话里用户怎么动的"）。 */
export const gestureTracker = new GestureTracker();

/** 页面证据 + 交互统计量，合成桥要的那一份。 */
export function collectHumanEvidence(): PageEvidence {
  return { ...collectPageEvidence(), ...gestureTracker.snapshot() };
}
