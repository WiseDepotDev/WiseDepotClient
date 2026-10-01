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
    const trimmed = code.trim();
    if (trimmed === '') {
      return 'input';
    }
    if (isTextEntryFocused()) {
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

  const lastCode = computed(() => last.value?.code ?? '');

  return { last, lastCode, cardOpen, registerConsumer, routeScan, showCard, hideCard };
});
