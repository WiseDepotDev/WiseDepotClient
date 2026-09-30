import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from './shared/useBridgeCall.js';

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

/**
 * ## 为什么走 `useBridgeCall` 而不是自己写一遍
 *
 * 这里原先是一份**手抄的取数逻辑**，抄漏了一样东西：连接恢复后的自动重取。
 * 后果在启动那一刻最明显 —— `bridge.session` 是进程里的**第一个**请求，
 * 最容易撞上"连接还没建好"：它一失败就被吞成"未登录"，用户明明有会话却被丢回登录屏；
 * 它要是一直不落地，用户就永远停在「正在读取会话…」上，**而那时还没有任何页面可切**，
 * 连"切走再切回来"这条自救路径都不存在。
 *
 * 取数的加载/错误/重试规则只该有**一个**拥有者（`useBridgeCall`）。
 * 这条屏不是特例，就不该有自己的副本。
 */
export function useSession(bridge: Bridge): Session {
  const { data, error, loading, reload } = useBridgeCall<SessionPayload>(bridge, 'bridge.session');

  // 拿不到会话只能按"未登录"处理 —— 与原语义一致：
  // 界面据此跳回登录，而不是继续点一堆必然失败的按钮。
  const state: SessionPayload | undefined = error ? { authenticated: false } : data;

  return {
    loading,
    authenticated: state?.authenticated ?? false,
    username: state?.username ?? null,
    passwordChangeRequired: state?.passwordChangeRequired ?? false,
    expired: state?.expired ?? false,
    reload,
  };
}
