import { useEffect, useRef } from 'react';
import { ScanAssembler, type ScanAssemblerOptions } from './assembler.js';

export interface UseScanGunOptions extends ScanAssemblerOptions {
    /** 识别到一次扫码时回调。 */
    readonly onScan: (code: string) => void;
    /**
     * 是否监听（默认 true）。宿主没声明 `scan.gun.keyboard` 能力时应传 `false` ——
     * 能力表是"宿主真的具备什么"的唯一说法，界面不该绕过它自己猜。
     */
    readonly enabled?: boolean;
    /** 监听目标，默认 `window`。 */
    readonly target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * 键盘式扫码枪监听。
 *
 * ## 一段实现、两端共用
 *
 * 扫码枪在两端都是**键盘**（USB HID 键盘模拟），所以识别逻辑放在 Web 层，
 * 手机壳与桌面壳一行原生代码都不需要 —— 这是"两套 UI 不是两套代码"的又一处落点。
 *
 * ## 不吞按键（重要）
 *
 * 这个 hook **不调用 `preventDefault`**。扫到的字符照常落进当前获得焦点的输入框：
 * 现场最常见的用法就是"扫进某个输入框"，吃掉字符会让输入框永远收不到内容。
 * 需要"只扫码不落输入框"的屏，自己把焦点移开，而不是让监听器替它决定。
 *
 * 终止符（Enter）同样不吞：扫进输入框后按下的那个 Enter，正好可以触发该输入框的
 * 回车动作（例如补录屏的"回车加一行"）—— 两件事都要发生，而不是二选一。
 *
 * ## 组合键不参与
 *
 * `Ctrl/Alt/Meta` 组合一律忽略：它们是快捷方式，不是条码内容。
 */
export function useScanGun(options: UseScanGunOptions): void {
    const { onScan, enabled = true, target } = options;

    // 回调放进 ref：它每次渲染都是新函数，直接进依赖会让监听器反复摘挂，
    // 而"摘挂的瞬间到来的按键"会丢 —— 扫码枪是突发输入，丢一次就是一次"没反应"。
    const onScanRef = useRef(onScan);
    onScanRef.current = onScan;

    const optionsRef = useRef<ScanAssemblerOptions>(options);
    optionsRef.current = options;

    useEffect(() => {
        if (!enabled) {
            return;
        }
        const host: Pick<Window, 'addEventListener' | 'removeEventListener'> = target ?? window;
        const assembler = new ScanAssembler(optionsRef.current);

        const onKeyDown = (event: Event): void => {
            const e = event as KeyboardEvent;
            if (e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }
            // 用事件自己的 timeStamp 而不是 Date.now()：它和事件的产生时刻同源，
            // 处理延迟（主线程忙）不会把间隔算大，从而不会漏判。
            const step = assembler.push(e.key, e.timeStamp);
            if (step.kind === 'scan') {
                onScanRef.current(step.code);
            }
        };

        host.addEventListener('keydown', onKeyDown, true);
        return () => host.removeEventListener('keydown', onKeyDown, true);
    }, [enabled, target]);
}
