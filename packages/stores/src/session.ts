import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { BRIDGE_EVENT_SESSION_EXPIRED, type BridgeError } from '@wise/bridge-client';
import { useBridgeStore } from './bridge.js';
import { useResourceCacheStore, toBridgeError } from './resource.js';

export interface SessionPayload {
  readonly authenticated?: boolean;
  readonly username?: string | null;
  readonly passwordChangeRequired?: boolean;
  readonly expired?: boolean;
}

export interface CaptchaPayload {
  readonly captchaId?: string;
  readonly captchaImage?: string;
  readonly expireTime?: string;
}

export interface SignInInput {
  readonly username: string;
  readonly password: string;
  readonly captchaCode: string;
}

/**
 * 会话 store。
 *
 * **判据永远来自 `bridge.session`（桥内的真值）**，不在前端记 `loggedIn` 布尔 ——
 * 那样刷新一次就与桥的真实状态脱节，表现是"看起来已登录、点什么都没反应"。
 *
 * 另外必须处理会话**失效**：失效发生在界面正停在已登录画面的时候，
 * 而 `bridge.session` 只在启动时被问过一次；没人重新问，界面就永远停在
 * "看起来已登录"上，此时桥里令牌已清，出站请求不再带 Authorization，
 * 后端会回一个**误导性的**「缺少必要的签名参数」400，和真因（没登录）完全无关。
 * 所以：桥推 `session.expired` → 重新问一次 → 会话门据此切回登录屏。
 *
 * ## 为什么登录与验证码也在这个 store 里
 *
 * 由 `check:store` 钉住的一条纪律：**组件不许直接调桥**。
 * 登录屏原先自己 `bridge.call('auth.login')`，于是"验证码一次性、失败必须换一张"
 * 这条规则只存在于那个组件的闭包里，别的入口（改密后重登、会话过期后重登）无法复用。
 * 放进 store 之后，屏只负责表单与展示，流程归一处。
 */
export const useSessionStore = defineStore('wise.session', () => {
  const bridge = useBridgeStore();
  const cache = useResourceCacheStore();

  const payload = shallowRef<SessionPayload | undefined>(undefined);
  const loading = ref(true);
  const failed = ref(false);
  let offExpired: (() => void) | null = null;

  // ---- 登录页状态 ----
  const captcha = shallowRef<CaptchaPayload | undefined>(undefined);
  /** 存**错误结构**而不是文案：文案映射属于展示侧（「谁展示谁拥有」）。 */
  const captchaError = shallowRef<BridgeError | undefined>(undefined);
  const signingIn = ref(false);
  const signInError = shallowRef<BridgeError | undefined>(undefined);

  async function reload(): Promise<void> {
    loading.value = true;
    try {
      const value = await cache.run<SessionPayload>('bridge.session');
      payload.value = value ?? {};
      failed.value = false;
    } catch {
      payload.value = { authenticated: false };
      failed.value = true;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 应用入口在 `bridge.attach` 之后调用一次：订阅失效事件 + 首次读取。
   *
   * **返回 Promise 是有意的**：入口要等它结算后再 `router.isReady()`，
   * 否则路由守卫会在"还在读会话"时放行，等结算出未登录时已经不跳转了。
   */
  async function init(): Promise<void> {
    if (!offExpired) {
      offExpired = bridge.subscribe(BRIDGE_EVENT_SESSION_EXPIRED, () => {
        void reload();
      });
    }
    await reload();
  }

  function dispose(): void {
    offExpired?.();
    offExpired = null;
  }

  /** 取一张新验证码。失败时把错误结构留在 store 里，由登录屏翻成人话。 */
  async function loadCaptcha(): Promise<void> {
    captchaError.value = undefined;
    try {
      const value = await cache.run<CaptchaPayload>('captcha.generate', { type: 'math' });
      captcha.value = value ?? {};
    } catch (e) {
      captcha.value = undefined;
      captchaError.value = toBridgeError(e);
    }
  }

  /**
   * 登录。
   *
   * 成功与否**不在这里下结论** —— 登录后重新问一次 `bridge.session`，
   * 由桥回答"现在是不是已登录"。前端自己把布尔翻成 true 就是"脱节"的来源。
   * 失败时**必须换一张验证码**（一次性凭证，不换会让用户反复提交已作废的码）。
   */
  async function signIn(input: SignInInput): Promise<boolean> {
    signingIn.value = true;
    signInError.value = undefined;
    try {
      await cache.mutate('auth.login', {
        username: input.username,
        password: input.password,
        captchaId: captcha.value?.captchaId ?? '',
        captchaCode: input.captchaCode,
      });
      await reload();
      return payload.value?.authenticated === true;
    } catch (e) {
      signInError.value = toBridgeError(e);
      await loadCaptcha();
      return false;
    } finally {
      signingIn.value = false;
    }
  }

  function clearSignInError(): void {
    signInError.value = undefined;
  }

  const authenticated = computed(() => payload.value?.authenticated ?? false);
  const username = computed(() => payload.value?.username ?? null);
  const passwordChangeRequired = computed(() => payload.value?.passwordChangeRequired ?? false);
  const expired = computed(() => payload.value?.expired ?? false);

  return {
    payload,
    loading,
    failed,
    authenticated,
    username,
    passwordChangeRequired,
    expired,
    captcha,
    captchaError,
    signingIn,
    signInError,
    init,
    reload,
    dispose,
    loadCaptcha,
    signIn,
    clearSignInError,
  };
});
