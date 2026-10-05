import { computed, onMounted, ref, shallowRef, type Ref } from 'vue';
import { Capability, type BridgeError } from '@wise/bridge-client';
import { toBridgeError, useBridgeStore } from '@wise/stores';
import { collectHumanEvidence, gestureTracker } from './humanEvidence.js';

/**
 * 人机验证的状态机（替代图形验证码的 `useCaptcha`）。
 *
 * ## 它与 `useCaptcha` 的根本区别：**票据不进这里**
 *
 * 图形验证码时代，页面拿到 `captchaId` + 图片，把用户输入的码随登录一起发出去 —— 页面持有凭据。
 * 现在页面只调一次 `bridge.humanVerify`，**票据留在桥里**，由桥在业务调用（登录/批量绑定/删用户）
 * 时注入。页面即使被 XSS，也偷不到一张可用于删用户的票据。
 *
 * ## 为什么没有"冷却倒计时"
 *
 * 冷却（高风险时等 3 秒重试一次）由**桥**执行：它对服务端说"我再试一次"，
 * 对页面只说"还在验证中"。放在页面就会变成"谁在等"有两个所有者，而且页面一刷新就绕过了冷却。
 *
 * ## 为什么没有图形码兜底
 *
 * 图形验证码已被整体删除（用户决策）。壳不支持 `human.verify` 时**明确失败**并说明原因
 * （"请更新客户端"），不做"悄悄退化成别的验证方式"——半兼容的半可用状态比明确失败更难查。
 */

export type HumanVerifyState = 'idle' | 'running' | 'passed' | 'failed' | 'unsupported';

export interface HumanVerifyResult {
  readonly ok: boolean;
  readonly error?: BridgeError;
}

export interface HumanVerifyApi {
  readonly state: Ref<HumanVerifyState>;
  readonly error: Ref<BridgeError | undefined>;
  /** 点击后过了多久还在跑（超过 1.5s 界面要改口，别让用户以为卡死）。 */
  readonly slow: Ref<boolean>;
  readonly supported: Ref<boolean>;
  /** 主动验证；返回是否通过。 */
  readonly verify: (purpose: string, username?: string) => Promise<HumanVerifyResult>;
  /** 复位（换了一条消息要重新验证、或点了"重试"）。 */
  readonly reset: () => void;
}

/** 界面上的"慢"是从这里开始的：与桥侧的冷却预算（约 3 秒）对齐，不另写一个魔法数。 */
const SLOW_HINT_MS = 1_500;

export function useHumanVerify(): HumanVerifyApi {
  const bridge = useBridgeStore();
  const state = ref<HumanVerifyState>('idle');
  const error = shallowRef<BridgeError | undefined>(undefined);
  const slow = ref(false);
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const supported = computed(() => bridge.supports(Capability.HUMAN_VERIFY));

  onMounted(() => {
    // 轨迹从**进页面**就开始采：只采按钮那一刻等于放弃了"他是怎么走到按钮的"这条信息
    gestureTracker.start();
  });

  function clearSlow(): void {
    if (slowTimer !== null) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    slow.value = false;
  }

  async function verify(purpose: string, username?: string): Promise<HumanVerifyResult> {
    if (!supported.value) {
      state.value = 'unsupported';
      return { ok: false };
    }
    state.value = 'running';
    error.value = undefined;
    clearSlow();
    slowTimer = setTimeout(() => {
      slow.value = true;
    }, SLOW_HINT_MS);

    try {
      // 证据随请求带上（页面能看见的那半）。壳的那半由桥自己去要 —— 页面拿不到也不该拿到。
      const result = await bridge.call<{ ok?: boolean }>('bridge.humanVerify', {
        purpose,
        username,
        evidence: collectHumanEvidence(),
      });
      clearSlow();
      if (result?.ok === true) {
        state.value = 'passed';
        return { ok: true };
      }
      state.value = 'failed';
      return { ok: false };
    } catch (e) {
      clearSlow();
      error.value = toBridgeError(e);
      state.value = 'failed';
      return { ok: false, error: error.value };
    }
  }

  function reset(): void {
    clearSlow();
    state.value = 'idle';
    error.value = undefined;
    // 清掉上一轮的轨迹：否则"上一次成功验证"的轨迹会替这一次作证
    gestureTracker.reset();
  }

  return { state, error, slow, supported, verify, reset };
}
