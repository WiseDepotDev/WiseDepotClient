import { ref, type Ref } from 'vue';

/**
 * "刷新当前屏"的信号 —— 现在它由**自动刷新**驱动，界面上不再有手动刷新按钮。
 *
 * ## 为什么要有它
 *
 * 手机上每屏页头都摆一个「刷新」按钮时，那**独占一行**（页头在窄屏只剩动作），
 * 而它做的事情永远是同一件：把这个屏用到的数据重取一遍。手机顶栏有一个全局刷新就够了 ——
 * 但顶栏（外壳）并不知道当前屏用了哪些 `useResource`，所以信号走这里：
 * 外壳 bump 一下，所有**活着的**资源自己重取。
 *
 * ## 为什么现在改成全自动
 *
 * 用户的要求是"所有内容持续自动更新、不要手动刷新按钮"。所以：
 *  · 可见时每 `AUTO_REFRESH_INTERVAL_MS`（**5 秒**）自动 bump 一次（后台标签页不刷，省电省流量）；
 *  · **回到前台立刻补一次**，并且先验活（半死连接要在这一步被判死，见 `resume` 钩子）；
 *  · 窗口重新聚焦、网络恢复（`online`）也各补一次。
 *
 * 顺序上"先验活再 bump"很关键：半死的 WebSocket 不会回包，
 * 直接刷新会让每一屏都白等满调用超时，然后集体显示"异常" ——
 * 用户看到的就是"切回来之后右边内容卡住"。
 *
 * 不用 Pinia store：它没有任何状态要持久化或跨会话，就是一个模块级的计数器 ——
 * 用 store 反而会把"谁改了它"藏进 devtools 之外的地方。
 *
 * 用法（见 `resource.ts` 的 `useResource`）：订阅 tick，变了就 `cache.run(...)` 一次。
 * 只有**当前挂载中**的屏会订阅，所以不会把别的屏也一起重取；
 * 少数"不允许被后台覆盖"的资源可以 `useResource(..., { autoRefresh: false })` 退出。
 */
const tick = ref(0);

/** 外壳调用：让当前屏重取它用到的数据。 */
export function bumpRefresh(): void {
  tick.value += 1;
}

/** `useResource` 调用：拿到这个只读 tick 去 watch。 */
export function useRefreshTick(): Ref<number> {
  return tick;
}

/**
 * 自动刷新周期：**5 秒**（用户指定）。
 *
 * 代价要写清楚，别下次有人又"顺手调大"或"顺手调小"：
 *  · 每 5 秒，**当前挂载的那一屏**用到的每个资源各发一次请求（切了屏就只刷新屏，
 *    因为只有挂载中的屏会订阅 tick）；
 *  · 页面不可见时不刷（省电、也省后端）；回到前台/聚焦/联网各立刻补一次；
 *  · 后台请求**不会**把内容换成骨架屏（见 `UseResourceResult.loading` 的语义），
 *    所以这个频率下屏幕是"数字自己在变"，不是"每 5 秒闪一下"。
 */
export const AUTO_REFRESH_INTERVAL_MS = 5_000;

export interface AutoRefreshHooks {
  readonly intervalMs?: number | undefined;
  /**
   * 回到前台时**先**跑这个（验活 / 重连），跑完才 bump。
   * 由应用入口注入，好让这个模块继续只认识"信号"，不认识桥。
   */
  readonly onResume?: (() => Promise<void> | void) | undefined;
}

/**
 * 起自动刷新（幂等：重复调用会先停掉上一次）。返回停止函数。
 *
 * 直接操作 `document` / `window`，所以只在浏览器环境生效；
 * 没有 `document` 时返回一个空停止函数（SSR / 单测里调用不会炸）。
 */
export function startAutoRefresh(hooks: AutoRefreshHooks = {}): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => undefined;
  }
  const intervalMs = hooks.intervalMs ?? AUTO_REFRESH_INTERVAL_MS;

  const timer = window.setInterval(() => {
    // 后台标签页不刷：看不见的界面刷新只是在烧电
    if (document.visibilityState === 'visible') {
      bumpRefresh();
    }
  }, intervalMs);

  /** 回到前台：**先验活**（可能要把半死的连接丢掉重连），再让当前屏补一次。 */
  let resuming = false;
  const resume = (): void => {
    if (document.visibilityState !== 'visible' || resuming) {
      return;
    }
    /*
     * 合并同一次回到前台触发的多个事件：真机实测"切回来"会**同时**来
     * `visibilitychange` 与 `focus`（还有可能来 `online`），不去重的话
     * 验活与当前屏重取会各跑两遍 —— 白发的请求都是真的打到后端的。
     */
    resuming = true;
    void Promise.resolve(hooks.onResume?.()).finally(() => {
      resuming = false;
      bumpRefresh();
    });
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      resume();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  // 页面可能是在后台被打开的（首帧就不可见），那就不必立刻验活
  if (document.visibilityState === 'visible') {
    resume();
  }

  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
  };
}
