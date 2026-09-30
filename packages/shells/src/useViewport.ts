import { useEffect, useState } from 'react';
import { windowSizeOf, type WindowSize } from '@wise/tokens';

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly size: WindowSize;
}

function read(): Viewport {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const height = typeof window === 'undefined' ? 900 : window.innerHeight;
  return { width, height, size: windowSizeOf(width) };
}

/**
 * 视口尺寸 → 三档窗口尺寸（Compact / Medium / Expanded）。
 *
 * 断点来自 `@wise/tokens`（由旧仓 `WindowSize.kt` 的 600 / 840 导出），
 * 不在这里再写一遍数字——两处各写一遍就是漂移的开始。
 */
export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(read);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    let frame = 0;
    const onResize = (): void => {
      // 滚动/resize 高频，压到下一帧再算尺寸，避免布局抖动
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setVp(read());
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  return vp;
}
