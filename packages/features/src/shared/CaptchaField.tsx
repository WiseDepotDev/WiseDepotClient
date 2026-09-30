import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input } from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { humanize } from './api.js';

/**
 * 验证码：hook + 展示组件（从登录屏抽出来的可复用件）。
 *
 * 抽出来的理由：验证码在**两处**要用 —— 登录，以及批量绑定/删除这类危险操作
 * （后端对它们要求 captcha，`/api/tag/batch-bind-with-captcha` 就是为此存在的）。
 * 两处各写一套必然漂移：一个支持刷新一个不支持、一个失败后换图一个不换。
 *
 * 三条已经踩过的经验固化在这里：
 * 1. **失败后必须换一张**：验证码是一次性的，不换会让用户反复提交已作废的那张
 *    （表现为"密码明明对却一直失败"）；
 * 2. 图是后端给的 `data:image/png;base64`，直接渲染，桥不做转换；
 * 3. 加载失败要**显式说出来**，不能静默留个空框（旧版 `CaptchaInput` 就是静默隐藏的）。
 */

interface CaptchaPayload {
  readonly captchaId?: string;
  readonly captchaImage?: string;
}

export interface CaptchaState {
  readonly captchaId: string;
  readonly code: string;
  readonly image: string | undefined;
  readonly error: string | undefined;
  setCode: (code: string) => void;
  refresh: () => void;
  /** 服务端拒绝后调用：换一张并清空输入，避免用户重复提交作废的那张。 */
  refreshAfterFailure: () => void;
}

export function useCaptcha(bridge: Bridge): CaptchaState {
  const [payload, setPayload] = useState<CaptchaPayload | undefined>(undefined);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    setError(undefined);
    setCode('');
    bridge
      .call<CaptchaPayload>('captcha.generate', { type: 'math' })
      .then((p) => setPayload(p ?? {}))
      .catch((e: unknown) => {
        setPayload(undefined);
        setError(humanize(e as never));
      });
  }, [bridge]);

  useEffect(() => refresh(), [refresh]);

  return {
    captchaId: payload?.captchaId ?? '',
    code,
    image: payload?.captchaImage,
    error,
    setCode,
    refresh,
    refreshAfterFailure: refresh,
  };
}

/** 验证码输入区（图 + 换一张 + 输入框）。受控：状态由调用方的 [useCaptcha] 持有。 */
export function CaptchaRow({
  state,
  label = '验证码',
}: {
  state: CaptchaState;
  label?: string;
}): React.ReactElement {
  return (
    <Field label={label} error={state.error}>
      <div className="w-captcha">
        {state.image ? (
          <img className="w-captcha__image" src={state.image} alt="验证码" />
        ) : (
          <div className="w-captcha__image" />
        )}
        <Button ariaLabel="换一张" onClick={state.refresh}>
          换一张
        </Button>
        <Input value={state.code} onChange={state.setCode} placeholder="验证码" mono />
      </div>
    </Field>
  );
}
