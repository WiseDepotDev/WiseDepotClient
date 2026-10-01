import { ref, shallowRef, type Ref } from 'vue';
import { toBridgeError, useResourceCacheStore } from '@wise/stores';
import type { BridgeError } from '@wise/bridge-client';

export interface CaptchaPayload {
  readonly captchaId?: string;
  readonly captchaImage?: string;
  readonly expireTime?: string;
}

export interface CaptchaState {
  readonly captcha: Ref<CaptchaPayload | undefined>;
  readonly code: Ref<string>;
  readonly error: Ref<BridgeError | undefined>;
  readonly loading: Ref<boolean>;
  refresh(): Promise<void>;
  /** 危险操作失败后必须换一张：验证码是一次性的，不换就会让用户对着作废的图重试。 */
  refreshAfterFailure(): void;
}

/**
 * 验证码（登录之外的第二类使用场景：批量绑定、按验证码删除用户）。
 *
 * 为什么不复用 `useSessionStore` 里那份：那是**登录**的验证码，它的生命周期与登录流程绑定
 * （登录失败要换、成功后就没用了）。批量操作有自己的节奏，共享一份会让两边互相作废。
 *
 * 取数仍走资源缓存层（`cache.run` 只对**并发**去重，不缓存结果），
 * 所以这里每次 `refresh()` 都会真的向服务端要一张新图。
 */
export function useCaptcha(): CaptchaState {
  const cache = useResourceCacheStore();
  const captcha = shallowRef<CaptchaPayload | undefined>(undefined);
  const code = ref('');
  const error = shallowRef<BridgeError | undefined>(undefined);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = undefined;
    try {
      const value = await cache.run<CaptchaPayload>('captcha.generate', { type: 'math' });
      captcha.value = value ?? {};
      code.value = '';
    } catch (e) {
      captcha.value = undefined;
      error.value = toBridgeError(e);
    } finally {
      loading.value = false;
    }
  }

  function refreshAfterFailure(): void {
    void refresh();
  }

  return { captcha, code, error, loading, refresh, refreshAfterFailure };
}
