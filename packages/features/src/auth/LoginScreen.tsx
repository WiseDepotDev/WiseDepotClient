import { useCallback, useEffect, useState } from 'react';
import { BridgeError, type Bridge } from '@wise/bridge-client';
import { Button, Card, Field, Input, Stack } from '@wise/patterns';

/**
 * 登录屏（W3-b）。
 *
 * 它只通过桥做三件事，其余什么都不碰：
 *   1. `captcha.generate` —— 后端返回的就是 `data:image/png;base64,…`，可直接塞进 `<img>`；
 *   2. `auth.login` —— **响应里不会再有令牌**（桥已截留，见 docs/w3-session.md）；
 *   3. 成功后由上层用 `bridge.session` 重新判定，前端不自己记"已登录"。
 *
 * 错误文案在这里映射（桥只给码与 messageKey）——延续"谁展示谁拥有"。
 */

interface CaptchaPayload {
  readonly captchaId?: string;
  readonly captchaImage?: string;
  readonly expireTime?: string;
}

export function LoginScreen({ bridge, onSignedIn }: { bridge: Bridge; onSignedIn: () => void }): React.ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [captcha, setCaptcha] = useState<CaptchaPayload | undefined>(undefined);
  const [captchaError, setCaptchaError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadCaptcha = useCallback(async () => {
    setCaptchaError(undefined);
    try {
      const payload = await bridge.call<CaptchaPayload>('captcha.generate', { type: 'math' });
      setCaptcha(payload ?? {});
      setCaptchaCode('');
    } catch (e) {
      setCaptcha(undefined);
      setCaptchaError(textOf(e, '验证码加载失败'));
    }
  }, [bridge]);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  const canSubmit = username.trim() !== '' && password !== '' && captchaCode.trim() !== '' && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await bridge.call('auth.login', {
        username: username.trim(),
        password,
        captchaId: captcha?.captchaId ?? '',
        captchaCode: captchaCode.trim(),
      });
      onSignedIn();
    } catch (e) {
      setError(textOf(e, '登录失败'));
      // 验证码是一次性的：失败后必须换一张，否则用户会反复提交同一个已作废的验证码
      await loadCaptcha();
    } finally {
      setSubmitting(false);
    }
  }, [bridge, canSubmit, captcha, captchaCode, loadCaptcha, onSignedIn, password, username]);

  return (
    <div className="w-auth">
      <div className="w-auth__card">
        <div className="w-auth__brand">慧仓智控 · WiseDepot</div>
        <Card>
          <Stack>
            <Field label="账号">
              <Input value={username} onChange={setUsername} placeholder="请输入账号" />
            </Field>
            <Field label="密码">
              <Input value={password} onChange={setPassword} type="password" placeholder="请输入密码" />
            </Field>
            <Field label="验证码" error={captchaError}>
              <div className="w-captcha">
                {captcha?.captchaImage ? (
                  <img className="w-captcha__image" src={captcha.captchaImage} alt="验证码" />
                ) : (
                  <div className="w-captcha__image" />
                )}
                <Button ariaLabel="换一张" onClick={() => void loadCaptcha()}>
                  换一张
                </Button>
                <Input value={captchaCode} onChange={setCaptchaCode} placeholder="验证码" mono />
              </div>
            </Field>

            {error ? (
              <div className="w-state w-state--error">
                <span>{error}</span>
              </div>
            ) : null}

            <Button variant="primary" block disabled={!canSubmit} onClick={() => void submit()}>
              {submitting ? '登录中…' : '登录'}
            </Button>
          </Stack>
        </Card>
        <div className="w-state">
          <span>登录凭证由本机桥保管，不会出现在页面里。</span>
        </div>
      </div>
    </div>
  );
}

/** 桥只给码与 messageKey，文案在 Web 侧映射（旧仓「谁展示谁拥有」的口径）。 */
function textOf(e: unknown, fallback: string): string {
  if (e instanceof BridgeError) {
    if (e.messageKey === 'bridge.backendUnreachable') {
      return '后端不可达，请检查网络或服务状态';
    }
    if (e.messageKey === 'error_session_expired') {
      return '登录已过期，请重新登录';
    }
    return `${fallback}（${e.code}）`;
  }
  return fallback;
}
