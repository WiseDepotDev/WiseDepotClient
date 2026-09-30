import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBridge, type Bridge } from '@wise/bridge-client';
import { AppFrame } from '@wise/shells';

import '@wise/tokens/tokens.css';
import '@wise/shells/shell.css';

interface Ready {
  readonly bridge: Bridge;
  readonly origin: string;
}

type BootState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly ready: Ready }
  | { readonly phase: 'failed'; readonly message: string };

/**
 * 启动序列：读引导 → 建桥 → 交外壳。
 *
 * 三条不允许妥协的地方：
 * 1. **引导失败不给"半可用"界面**：宿主没把桥拉起来就是架构错误，画出来比装作没事更容易查；
 * 2. **协议版本不匹配直接失败**（`ProtocolMismatchError`），不静默降级；
 * 3. **mock 只在 `import.meta.env.DEV` 下允许**，生产构建里这段分支不存在。
 */
function App(): React.ReactElement {
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
    return <div className="w-root" style={{ padding: 'var(--w-space-screen-vertical)' }}>正在连接本地桥…</div>;
  }

  if (state.phase === 'failed') {
    return (
      <div className="w-root" style={{ padding: 'var(--w-space-screen-vertical)', flexDirection: 'column' }}>
        <h1 className="w-topbar__title">本地桥不可用</h1>
        <div className="w-card w-error">{state.message}</div>
        <p className="w-muted">
          正常情况下宿主进程会提供 <span className="w-mono">/__bridge.json</span>。
          桌面与手机的宿主进程属 W2 交付；当前 W1 请在开发态运行（会自动回退到 mock）。
        </p>
      </div>
    );
  }

  return <AppFrame bridge={state.ready.bridge} origin={state.ready.origin} />;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
