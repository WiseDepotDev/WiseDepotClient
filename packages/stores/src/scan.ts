import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

/** 一次扫码最终交给了谁（三分支的落点）。 */
export type ScanRoute = 'input' | 'screen' | 'fallback';

export interface ScanEvent {
  readonly code: string;
  readonly at: number;
  readonly route: ScanRoute;
}

/** 屏注册的扫码消费者：返回 `true` 表示"这次扫码我消费了"。 */
export type ScanConsumer = (code: string) => boolean;

/**
 * 扫码路由 store。
 *
 * ## 三分支（唯一出处）
 *
 * ```
 * 扫码事件 → ① 当前有文本焦点？      → 交给输入框（不抢）
 *          → ② 当前屏注册了消费者？   → 交给屏（手动补录那种"连续扫码"）
 *          → ③ 兜底                  → 跳标签详情（SCAN_TARGET_METHOD）
 * ```
 *
 * ## 为什么分支 ① 是"不抢"而不是"抢过来再分发"
 *
 * 现场最常见的用法就是**扫进某个输入框**（搜索框、编码框）。扫码枪是 HID 键盘，
 * 字符本来就会落进焦点元素；监听器再去 preventDefault 反而会让输入框永远收不到内容。
 * 所以这里只是**判断并记录**，不拦截。
 *
 * ## 为什么 store 里不做导航
 *
 * 跳转要用 router，而 store 不该认识 router（否则测试要造一整套路由）。
 * 这里只回答"这次扫码该归谁"，跳转由外壳执行。
 */
export const useScanStore = defineStore('wise.scan', () => {
  const consumers = shallowRef<ScanConsumer[]>([]);
  const last = shallowRef<ScanEvent | null>(null);
  /** 结果卡是否可见（手机端顶部浮层）。 */
  const cardOpen = ref(false);

  function registerConsumer(consumer: ScanConsumer): () => void {
    consumers.value = [...consumers.value, consumer];
    return () => {
      consumers.value = consumers.value.filter((c) => c !== consumer);
    };
  }

  function isTextEntryFocused(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) {
      return false;
    }
    if (el.isContentEditable) {
      return true;
    }
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** 路由一次扫码。返回它去了哪一支；`fallback` 由调用方执行跳转。 */
  function routeScan(code: string): ScanRoute {
    return routeScanCore(code, true);
  }

  /**
   * 相机扫码的路由（B1/S2b4）。
   *
   * **唯一的差别：不看"当前有没有输入框在聚焦"。**
   *
   * 这条差别来自一次真实的"扫了没反应"：操作员正在条形码输入框里打字 → 点「扫码」→
   * 取景层打开 → 扫到码 → `routeScan` 走进"有人正在打字，交给输入框"那一支 ——
   * 而相机的结果**从来没经过键盘**，于是它既没进输入框、也不弹卡、也不跳页：
   * 一次成功的识别被静默丢弃。相机扫码是**明确意图**（人自己把取景层叫出来的），
   * 不存在"他在打字，别抢"这个前提。
   */
  function routeCameraScan(code: string): ScanRoute {
    return routeScanCore(code, false);
  }

  function routeScanCore(code: string, respectTextFocus: boolean): ScanRoute {
    const trimmed = code.trim();
    if (trimmed === '') {
      return 'input';
    }
    if (respectTextFocus && isTextEntryFocused()) {
      last.value = { code: trimmed, at: Date.now(), route: 'input' };
      return 'input';
    }
    for (const consumer of consumers.value) {
      try {
        if (consumer(trimmed)) {
          last.value = { code: trimmed, at: Date.now(), route: 'screen' };
          return 'screen';
        }
      } catch (e) {
        // 一个消费者抛错不该让整条扫码链路断掉（现场表现为"扫了没反应"）
        console.error('[scan] 屏内扫码消费者抛错（已跳过）', e);
      }
    }
    last.value = { code: trimmed, at: Date.now(), route: 'fallback' };
    return 'fallback';
  }

  function showCard(): void {
    cardOpen.value = true;
  }

  function hideCard(): void {
    cardOpen.value = false;
  }

  // ---- 相机取景层（B1/S2b4）----

  /**
   * 取景层是否打开。
   *
   * 放在 store 而不是外壳的局部 ref：入口现在有**两处**（条形码输入框后面的图标、
   * 顶栏的全局入口），而取景层只有一个。谁打开它、结果交给谁，只能有一个所有者 ——
   * 两处各持一个 `cameraOpen` 就会出现"点 A 打开了、点 B 关不掉"。
   */
  const cameraOpen = ref(false);
  /** 打开取景层时登记"这次扫到的码归谁"；`null` = 走兜底（结果卡 + 跳标签详情）。 */
  const cameraHandler = shallowRef<ScanConsumer | null>(null);

  /** 打开取景层。传 `handler` 表示"扫到的码给这个字段/页面"（它返回 true 即消费掉）。 */
  function openCamera(handler?: ScanConsumer): void {
    cameraHandler.value = handler ?? null;
    cameraOpen.value = true;
  }

  function closeCamera(): void {
    cameraOpen.value = false;
    cameraHandler.value = null;
  }

  /**
   * 把相机扫到的码交给登记方；**返回 false 表示没人接**（调用方据此走兜底路由）。
   *
   * 一进来就清掉登记与打开状态：交接是一次性的，留在那里会让下一次扫描又填进上一个字段
   * （"扫了两次，第一次的码填到了第二个框里"就是这么来的）。
   */
  function deliverCameraCode(code: string): boolean {
    const handler = cameraHandler.value;
    cameraOpen.value = false;
    cameraHandler.value = null;
    if (handler === null) {
      return false;
    }
    try {
      return handler(code.trim()) === true;
    } catch (e) {
      console.error('[scan] 相机扫码的接收方抛错', e);
      return false;
    }
  }

  const lastCode = computed(() => last.value?.code ?? '');

  return {
    last,
    lastCode,
    cardOpen,
    cameraOpen,
    registerConsumer,
    routeScan,
    routeCameraScan,
    showCard,
    hideCard,
    openCamera,
    closeCamera,
    deliverCameraCode,
  };
});
