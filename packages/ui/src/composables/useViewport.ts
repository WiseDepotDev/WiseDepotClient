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
  /**
   * 足够宽到能并排放"列表 + 详情"两栏（≥1440）。
   *
   * 为什么不复用 `isDesktop`(≥1024)：1024 的窗口在侧栏展开后内容区只剩 ~780px，
   * 两栏各 390px —— 表格列的固定宽加起来就 750px，放进去只会把右栏挤出可视区
   * （`.w-content` 是 `overflow-x: hidden`，溢出会被**裁掉**而不是出滚动条）。
   * 1440 是 tokens 里已有的断点，不再新造一个数字。
   */
  readonly isWide: Ref<boolean>;
}

const COMPACT_QUERY = '(max-width: 599px)';
const DESKTOP_QUERY = '(min-width: 1024px)';
const WIDE_QUERY = '(min-width: 1440px)';

export function useViewport(): Viewport {
  /*
   * SSR / 无 window：退化为"窄"。
   *
   * `isWide` 特意退化成 false 而不是 true：SSR 渲染时若两栏并存，
   * 门禁抓的"第一个 `.w-page-header__title`"会变成列表屏的标题（详情面板在后），
   * 于是每屏该有的标题断言会在服务端渲染下失真。窄档只渲染列表，语义也更稳。
   */
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { isCompact: ref(false), isDesktop: ref(true), isWide: ref(false) };
  }

  const compactMq = window.matchMedia(COMPACT_QUERY);
  const desktopMq = window.matchMedia(DESKTOP_QUERY);
  const wideMq = window.matchMedia(WIDE_QUERY);
  const isCompact = ref(compactMq.matches);
  const isDesktop = ref(desktopMq.matches);
  const isWide = ref(wideMq.matches);

  const onCompact = (e: MediaQueryListEvent): void => {
    isCompact.value = e.matches;
  };
  const onDesktop = (e: MediaQueryListEvent): void => {
    isDesktop.value = e.matches;
  };
  const onWide = (e: MediaQueryListEvent): void => {
    isWide.value = e.matches;
  };

  compactMq.addEventListener('change', onCompact);
  desktopMq.addEventListener('change', onDesktop);
  wideMq.addEventListener('change', onWide);

  onScopeDispose(() => {
    compactMq.removeEventListener('change', onCompact);
    desktopMq.removeEventListener('change', onDesktop);
    wideMq.removeEventListener('change', onWide);
  });

  return { isCompact, isDesktop, isWide };
}
