import { useCallback, useEffect, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';

/**
 * 会话状态。
 *
 * 判据永远来自 `bridge.session`（桥内的真值），**不是**前端自己记一个 `loggedIn` 布尔——
 * 那样刷新一次页面就与桥的真实状态脱节，而"脱节"的表现是"看起来已登录、点什么都没反应"。
 */
export interface Session {
  readonly loading: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly passwordChangeRequired: boolean;
  /** 后端判定登录态失效；UI 据此跳回登录而不是继续点。 */
  readonly expired: boolean;
  readonly reload: () => void;
}

interface SessionPayload {
  readonly authenticated?: boolean;
  readonly username?: string | null;
  readonly passwordChangeRequired?: boolean;
  readonly expired?: boolean;
}

export function useSession(bridge: Bridge): Session {
  const [state, setState] = useState<SessionPayload | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    bridge
      .call<SessionPayload>('bridge.session')
      .then((payload) => {
        if (alive) {
          setState(payload ?? {});
        }
      })
      .catch(() => {
        if (alive) {
          setState({ authenticated: false });
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    loading,
    authenticated: state?.authenticated ?? false,
    username: state?.username ?? null,
    passwordChangeRequired: state?.passwordChangeRequired ?? false,
    expired: state?.expired ?? false,
    reload,
  };
}
