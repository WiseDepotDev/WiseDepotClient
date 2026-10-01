import { onScopeDispose, ref, type Ref } from 'vue';

/**
 * 视口判定（三档断点与 tokens 同源：compact ≤599 / medium ≤1023 / desktop ≥1024）。
 *
 * 为什么用 `matchMedia` 而不是监听 resize 自己算：
 *  · matchMedia 只在**跨过断点**时触发，不会因为拖动窗口而每帧回调；
 *  · 断点值与 CSS 用的是同一份来源（theme.json 生成），改一处两端同时改。
 *
 * SSR / 无 window 环境下退化为桌面档，避免服务端渲染时报错。
 *
 * 返回的是 **ref**（不是普通布尔）：组件里可能在 computed 中读取，
 * 用 getter 包一层会让类型退化成 boolean，`.value` 就取不到了。
 * 模板里用 `isCompact` 会被自动解包，脚本里用 `isCompact.value`。
 */
export interface Viewport {
  readonly isCompact: Ref<boolean>;
  readonly isDesktop: Ref<boolean>;
}

const COMPACT_QUERY = '(max-width: 599px)';
const DESKTOP_QUERY = '(min-width: 1024px)';

export function useViewport(): Viewport {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { isCompact: ref(false), isDesktop: ref(true) };
  }

  const compactMq = window.matchMedia(COMPACT_QUERY);
  const desktopMq = window.matchMedia(DESKTOP_QUERY);
  const isCompact = ref(compactMq.matches);
  const isDesktop = ref(desktopMq.matches);

  const onCompact = (e: MediaQueryListEvent): void => {
    isCompact.value = e.matches;
  };
  const onDesktop = (e: MediaQueryListEvent): void => {
    isDesktop.value = e.matches;
  };

  compactMq.addEventListener('change', onCompact);
  desktopMq.addEventListener('change', onDesktop);

  onScopeDispose(() => {
    compactMq.removeEventListener('change', onCompact);
    desktopMq.removeEventListener('change', onDesktop);
  });

  return { isCompact, isDesktop };
}
