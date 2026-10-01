import { BridgeError, createBridge, ProtocolMismatchError, type Bridge } from '@wise/bridge-client';

/**
 * 启动：读引导 → 建桥。
 *
 * 三条不允许妥协的地方（沿用旧 `App.tsx` 的口径，换成 Vue 后依然成立）：
 *
 * 1. **引导失败不给"半可用"界面**：宿主没把桥拉起来就是架构错误，画出来比装作没事更容易查；
 * 2. **协议版本不匹配直接失败**，不静默降级；
 * 3. **登录态只认 `bridge.session`**，前端不自己记布尔 —— 否则刷新一次就与桥的真实状态脱节，
 *    表现为"看起来已登录、点什么都没反应"。
 */
export type BootResult =
  | { readonly phase: 'ready'; readonly bridge: Bridge; readonly origin: string }
  | { readonly phase: 'failed'; readonly message: string; readonly detail: string };

function describe(e: unknown): { message: string; detail: string } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof ProtocolMismatchError) {
    return { message: '应用与本地服务版本不一致，请更新后重试；若仍不行请联系管理员。', detail };
  }
  if (e instanceof BridgeError) {
    return { message: '本地服务未就绪，请完全退出应用后重新打开。', detail };
  }
  return { message: '应用未能启动，请完全退出后重新打开；若仍然如此，请联系管理员。', detail };
}

export async function boot(): Promise<BootResult> {
  try {
    // `allowMock` 只允许传 `import.meta.env.DEV`（见 bridge-client 的使用纪律）
    const { bridge, origin } = await createBridge({ allowMock: import.meta.env.DEV });
    return { phase: 'ready', bridge, origin };
  } catch (e) {
    const { message, detail } = describe(e);
    return { phase: 'failed', message, detail };
  }
}
