import { useEffect, useState } from 'react';
import { createBridge, type Bridge } from '@wise/bridge-client';
import { useSession, LoginScreen } from '@wise/features';
import { AppFrame } from '@wise/shells';

import '@wise/tokens/tokens.css';
import '@wise/patterns/patterns.css';

interface Ready {
  readonly bridge: Bridge;
  readonly origin: string;
}

type BootState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly ready: Ready }
  | { readonly phase: 'failed'; readonly message: string };

/**
 * 启动序列：读引导 → 建桥 → **按会话决定登录还是进主界面**。
 *
 * 三条不允许妥协的地方：
 * 1. **引导失败不给"半可用"界面**：宿主没把桥拉起来就是架构错误，画出来比装作没事更容易查；
 * 2. **协议版本不匹配直接失败**（`ProtocolMismatchError`），不静默降级；
 * 3. **登录态只认 `bridge.session`**，前端不自己记布尔——否则刷新一次就与桥的真实状态脱节，
 *    表现为"看起来已登录、点什么都没反应"。
 */
export function App(): React.ReactElement {
  const [state, setState] = useState<BootState>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    createBridge({ allowMock: import.meta.env.DEV })
      .then(({ bridge, origin }) => {
        if (alive) {
          setState({ phase: 'ready', ready: { bridge, origin } });
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setState({ phase: 'failed', message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="w-root w-root--stack">
        <div className="w-auth">
          <div className="w-auth__card">
            <div className="w-auth__brand">慧仓智控 · WiseDepot</div>
            <div className="w-state">
              <span>正在连接本地桥…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="w-root w-root--stack">
        <div className="w-auth">
          <div className="w-auth__card">
            <div className="w-auth__brand">本地桥不可用</div>
            <div className="w-state w-state--error">
              <span>{state.message}</span>
            </div>
            <div className="w-state">
              <span>
                正常情况下宿主进程会提供 /__bridge.json。桌面与手机的宿主进程属 W2 交付；
                开发态请用 pnpm dev（会自动回退到 mock 桥）。
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <Authed bridge={state.ready.bridge} origin={state.ready.origin} />;
}

/** 会话门：登录屏与主界面之间的**唯一**判定点。 */
function Authed({ bridge, origin }: Ready): React.ReactElement {
  const session = useSession(bridge);

  if (session.loading) {
    return (
      <div className="w-root w-root--stack">
        <div className="w-auth">
          <div className="w-auth__card">
            <div className="w-state">
              <span>正在读取会话…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!session.authenticated) {
    return (
      <div className="w-root w-root--stack">
        <LoginScreen bridge={bridge} onSignedIn={session.reload} />
      </div>
    );
  }

  return <AppFrame bridge={bridge} origin={origin} />;
}
