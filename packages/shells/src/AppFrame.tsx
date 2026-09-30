import type { Bridge } from '@wise/bridge-client';
import { DesktopShell } from './DesktopShell.js';
import { MobileShell } from './MobileShell.js';
import { useViewport } from './useViewport.js';

/**
 * 外壳选择器：**唯一**决定"现在是手机形态还是桌面形态"的地方。
 *
 * 判据是**视口宽度**（三档断点，来自旧仓 WindowSize.kt 的 600 / 840），
 * 不是 `platform === 'mobile'`——桌面窗口缩到 375px 时也该变成手机形态，
 * 那是同一个布局问题，该用同一个判据（架构不变式 2 的推论）。
 */
export function AppFrame({ bridge, origin }: { bridge: Bridge; origin: string }): React.ReactElement {
  const viewport = useViewport();
  return viewport.size === 'compact' ? (
    <MobileShell bridge={bridge} origin={origin} />
  ) : (
    <DesktopShell bridge={bridge} origin={origin} />
  );
}
