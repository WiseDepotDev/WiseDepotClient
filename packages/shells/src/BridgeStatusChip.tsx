import { useSyncExternalStore } from 'react';
import type { Bridge } from '@wise/bridge-client';
import type { ConnectionState } from '@wise/bridge-client';

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  closed: '已断开',
};

function tone(kind: Bridge['kind'], state: ConnectionState): 'ok' | 'warn' | 'bad' {
  if (kind === 'mock') {
    return 'warn';
  }
  if (state === 'open') {
    return 'ok';
  }
  return state === 'closed' ? 'bad' : 'warn';
}

/**
 * 桥连接状态。
 *
 * **默认只在"不正常"的时候出现**（用户反馈："已连接 mobile" 放在标题栏，业务用户看不懂 ——
 * 是设备？网络？还是什么模式？）。
 *
 * 规则来自一条通用的界面原则：**正常状态不需要常驻告知**。
 * 连接正常时它什么也不画；异常时画一条明确的提示；想看细节的人去"我的 → 关于"里看。
 */
export function BridgeStatusChip({
  bridge,
  origin,
  /** 桌面端调试/诊断场景可以强制常驻显示。缺省 false = 只在异常时出现。 */
  alwaysShow = false,
}: {
  bridge: Bridge;
  origin: string;
  alwaysShow?: boolean;
}): React.ReactElement | null {
  const state = useSyncExternalStore(
    bridge.onStateChange.bind(bridge),
    () => bridge.state,
    () => bridge.state,
  );
  const isMock = bridge.kind === 'mock';
  const healthy = !isMock && state === 'open';

  if (healthy && !alwaysShow) {
    return null;
  }

  // 异常时给**业务语言**，不给内部术语。"mock" 只在开发态出现（页面里本来就有开发标记）
  const label = isMock ? '开发态假数据' : state === 'open' ? '连接正常' : STATE_LABEL[state];

  return (
    <span className={tone(bridge.kind, state) === 'warn' ? 'w-chip w-chip--warn' : 'w-chip'} title={origin}>
      <span className={`w-dot w-dot--${tone(bridge.kind, state)}`} />
      {label}
    </span>
  );
}
