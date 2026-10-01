import { reactive, ref } from 'vue';
import { defineStore } from 'pinia';

/** 每屏需要跨断点/跨返回保留的视图状态。 */
export interface ViewState {
  page: number;
  filters: Record<string, string>;
  scrollTop: number;
}

function newViewState(): ViewState {
  return { page: 1, filters: {}, scrollTop: 0 };
}

/**
 * 导航/视图状态 store。
 *
 * 只存"刷新后可以丢、但切来切去不能丢"的东西：**筛选、页码、滚动位置**。
 * （路由与参数在 URL 里；未提交的表单留在组件内并由离开守卫拦截。）
 *
 * 为什么单独成 store：桌面与手机是**同一份**状态、两套布局。
 * 断点切换时如果导航状态在两个壳里各存一份，就会出现
 * "手机筛了 A 区，插上显示器变成全量"这种现场很难复现的问题。
 */
export const useNavStore = defineStore('wise.nav', () => {
  const domain = ref<string>('overview');
  const leaf = ref<string>('dashboard.summary');
  /** 推入的屏（详情）栈；空数组表示当前在域的根页。 */
  const stack = ref<readonly { method: string; params: Record<string, string> }[]>([]);

  const views = reactive(new Map<string, ViewState>());

  /**
   * 取某屏的视图状态（**返回的一定是响应式代理**）。
   *
   * 缓存未命中时**不能把刚 new 出来的原始对象直接返回**：`reactive(new Map())` 只在 `get`
   * 时把值包成代理，`set` 进去的是原对象。返回原对象意味着调用方拿到一个**没有依赖追踪**的
   * 普通对象 —— 往 `view.page` 上写值不会让任何 `computed`/`watch` 失效。
   *
   * 真实后果（审查时实测出来的）：列表屏冷启动后**首次进入时翻页完全没反应**
   * （点第 2 页，页码与数据都不动）；离开再回来才好，因为第二次 `get` 才拿到代理 ——
   * 一种"刷新一下就好了"的 bug，最难查。`resource.ts` 的 `ensure()` 犯过同一个错，
   * 修法是同一个：**写完再 `get` 一次**。
   */
  function viewStateOf(id: string): ViewState {
    const existing = views.get(id);
    if (existing) {
      return existing;
    }
    views.set(id, newViewState());
    return views.get(id) as ViewState;
  }

  function setDomain(next: string): void {
    domain.value = next;
    stack.value = [];
  }

  function setLeaf(next: string): void {
    leaf.value = next;
  }

  function push(method: string, params: Record<string, string> = {}): void {
    stack.value = [...stack.value, { method, params }];
  }

  function pop(): void {
    stack.value = stack.value.slice(0, Math.max(0, stack.value.length - 1));
  }

  function clearStack(): void {
    stack.value = [];
  }

  function rememberScroll(id: string, top: number): void {
    viewStateOf(id).scrollTop = top;
  }

  return {
    domain,
    leaf,
    stack,
    views,
    viewStateOf,
    setDomain,
    setLeaf,
    push,
    pop,
    clearStack,
    rememberScroll,
  };
});
