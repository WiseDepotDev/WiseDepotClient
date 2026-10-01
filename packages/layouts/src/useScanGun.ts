import { onScopeDispose, watch } from 'vue';
import { ScanAssembler, type ScanAssemblerOptions } from '@wise/scan/assembler';
import type { ScanConsumer } from '@wise/stores';

export interface UseScanGunOptions extends ScanAssemblerOptions {
  /** 识别到一次扫码时回调。 */
  readonly onScan: (code: string) => void;
  /**
   * 是否监听。宿主没声明 `scan.gun.keyboard` 能力时必须传 `false` ——
   * 能力表是"宿主真的具备什么"的唯一说法，界面不该绕过它自己猜。
   */
  readonly enabled: boolean;
  /** 监听目标，默认 `window`。 */
  readonly target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * 键盘式扫码枪监听（Vue 版，逻辑复用 `@wise/scan/assembler`）。
 *
 * 与 React 版逐条对齐的三条性质：
 *  1. **不吞按键**：不调用 `preventDefault` —— 扫到的字符照常落进焦点输入框
 *     （现场最常见用法就是"扫进某个输入框"，吃掉字符会让输入框永远收不到内容）；
 *  2. **组合键不参与**：Ctrl/Alt/Meta 是快捷方式，不是条码内容；
 *  3. **用事件自身的 `timeStamp`** 而不是 `Date.now()`：处理延迟不会把字符间隔算大，
 *     从而不会漏判（扫码枪是突发输入，漏一次就是一次"没反应"）。
 *
 * 用 `watch(..., { immediate: true })` 挂监听而不是 onMounted：`enabled` 由能力表决定，
 * 它可能在桥连上之后才变成 true。
 */
export function useScanGun(options: UseScanGunOptions): void {
  /*
   * 没有 window 时（SSR / 无头渲染）**直接不挂监听**，而不是抛异常。
   *
   * 为什么要有这条：屏与外壳会在"没有浏览器"的环境里被渲染一遍（`check:vue-render`），
   * 一上来读 `window` 会让整屏 setup 抛错、渲染直接失败 —— 而这条渲染门禁恰恰是
   * 用来抓"渲染期崩溃"的。同一个标准本仓已经用过：`useViewport` 在无 window 时退化为桌面档。
   * 真实运行环境里 `window` 一定在，所以这里只是**换一种失败方式**：不监听，而不是崩。
   */
  const host: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined =
    options.target ?? (typeof window === 'undefined' ? undefined : window);
  if (host === undefined) {
    return;
  }

  /**
   * 每次 `enabled` 变化都重建 assembler：它内部有"上一次按键时间"这类状态，
   * 复用一个跨越断连期的实例会拿旧时间戳去比对第一次按键，把一次扫码判成 `discarded`。
   */
  const stop = watch(
    () => options.enabled,
    (enabled) => {
      if (!enabled) {
        return undefined;
      }
      const assembler = new ScanAssembler(options);
      const onKeyDown = (event: Event): void => {
        const e = event as KeyboardEvent;
        if (e.ctrlKey || e.altKey || e.metaKey) {
          return;
        }
        const step = assembler.push(e.key, e.timeStamp);
        if (step.kind === 'scan') {
          options.onScan(step.code);
        }
      };
      host.addEventListener('keydown', onKeyDown, true);
      return () => host.removeEventListener('keydown', onKeyDown, true);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    stop();
  });
}

/** 让屏把"我来处理这次扫码"注册进来（连续扫码录入用）。 */
export interface ScanRegistry {
  register(consumer: ScanConsumer): () => void;
}

export type { ScanConsumer };
