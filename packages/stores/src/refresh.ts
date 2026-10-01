import { ref, type Ref } from 'vue';

/**
 * "刷新当前屏"的信号。
 *
 * ## 为什么要有它
 *
 * 手机上每屏页头都摆一个「刷新」按钮时，那**独占一行**（页头在窄屏只剩动作），
 * 而它做的事情永远是同一件：把这个屏用到的数据重取一遍。手机顶栏有一个全局刷新就够了 ——
 * 但顶栏（外壳）并不知道当前屏用了哪些 `useResource`，所以信号走这里：
 * 外壳 bump 一下，所有**活着的**资源自己重取。
 *
 * 不用 Pinia store：它没有任何状态要持久化或跨会话，就是一个模块级的计数器 ——
 * 用 store 反而会把"谁改了它"藏进 devtools 之外的地方。
 *
 * 用法（见 `resource.ts` 的 `useResource`）：订阅 tick，变了就 `cache.run(...)` 一次。
 * 只有**当前挂载中**的屏会订阅，所以不会把别的屏也一起重取。
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
