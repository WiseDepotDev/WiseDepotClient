/**
 * @wise/tokens —— 设计令牌的唯一出口。
 *
 * `src/generated/**` 由 `tools/gen/gen-tokens.js` 从归档的 Compose 主题
 * （`.archive/.../core/ui/theme/*.kt`）一次性导出，此后以 tokens.json 为准。
 *
 * 用法：
 * ```ts
 * import '@wise/tokens/tokens.css';          // 应用入口引一次，CSS 变量即全站可用
 * import { color, space, radius, type } from '@wise/tokens';
 *
 * <div style={{ color: color.state.dangerText, padding: space.CardPadding }} />
 * ```
 *
 * 纪律：
 * - **不要**在业务代码里写 hex 或字面量 px：旧仓用同一套纪律把 764 处 colorScheme / 709 处 Dimens 收敛住，
 *   Web 侧沿用（`tools/gen/gen-tokens.js --check` 是漂移门禁，值本身也只在这一处定义）。
 * - 旧 iOS 命名调色板（`IOSSystem*`）**只留档在 tokens.json 的 legacy 字段**，不生成 CSS 变量，
 *   业务层不允许直接引用。
 */

export {
  TOKEN_SOURCE,
  CSS_VAR,
  color,
  space,
  radius,
  elevation,
  motion,
  type,
  breakpoint,
  rawColor,
} from './generated/tokens.js';

import { breakpoint as bp } from './generated/tokens.js';

/** 三档窗口尺寸（沿用旧仓 core/ui/layout/WindowSize.kt 的 600 / 840 断点）。 */
export type WindowSize = 'compact' | 'medium' | 'expanded';

/** 由视口宽度判定档位；与破点常量同源，避免两处各写一遍。 */
export function windowSizeOf(width: number): WindowSize {
  if (width <= bp.compactMax) {
    return 'compact';
  }
  return width <= bp.mediumMax ? 'medium' : 'expanded';
}
