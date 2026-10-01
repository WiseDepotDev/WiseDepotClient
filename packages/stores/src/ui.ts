import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

/** 桌面三档密度（手机壳固定用 standard）。 */
export type Density = 'compact' | 'standard' | 'relaxed';
export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

export interface ConfirmRequest {
  readonly id: number;
  readonly title: string;
  readonly text: string | undefined;
  readonly confirmText: string;
  readonly cancelText: string;
  readonly danger: boolean;
}

/**
 * 交互壳状态：密度、提示条、二次确认队列、离线横幅。
 *
 * 为什么二次确认要进 store 而不是各屏自己 drawer：危险操作在 25 屏里到处都是，
 * 每屏各写一遍就会出现"有的能 Esc、有的不能、有的关掉后焦点丢了"。
 * 这里只有一个确认宿主，**焦点圈闭 / Esc / 关闭后恢复焦点**只在一处保证。
 */
export const useUiStore = defineStore('wise.ui', () => {
  const density = ref<Density>('standard');
  const toasts = shallowRef<Toast[]>([]);
  const confirmRequest = shallowRef<ConfirmRequest | null>(null);
  /** 顶部横幅（桥断开 / 开发态假桥）。文案由组件按 code 映射。 */
  const banner = ref<string | null>(null);

  let seq = 0;
  const nextId = (): number => {
    seq += 1;
    return seq;
  };

  let resolveConfirm: ((ok: boolean) => void) | null = null;

  function pushToast(text: string, tone: ToastTone = 'info', ttlMs = 3200): number {
    const id = nextId();
    toasts.value = [...toasts.value, { id, text, tone }];
    if (ttlMs > 0) {
      window.setTimeout(() => dismissToast(id), ttlMs);
    }
    return id;
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function confirm(input: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
    // 前一个确认还没结算就被新请求顶掉时，先把它按"取消"结算，避免调用方永远挂起
    resolveConfirm?.(false);
    confirmRequest.value = { id: nextId(), ...input };
    return new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
  }

  function settleConfirm(ok: boolean): void {
    resolveConfirm?.(ok);
    resolveConfirm = null;
    confirmRequest.value = null;
  }

  function setDensity(next: Density): void {
    density.value = next;
  }

  return {
    density,
    toasts,
    confirmRequest,
    banner,
    pushToast,
    dismissToast,
    confirm,
    settleConfirm,
    setDensity,
  };
});
