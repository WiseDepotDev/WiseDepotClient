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
 * 桥状态条。
 *
 * **必须**把 `mock` 明确画出来：开发态的假桥如果看起来和真桥一样，
 * 就会变成"假通过"的来源（W1 的 mock 纪律第 3 条）。
 */
export function BridgeStatusChip({ bridge, origin }: { bridge: Bridge; origin: string }): React.ReactElement {
  const label = bridge.kind === 'mock' ? '开发态 mock' : STATE_LABEL[bridge.state];
  return (
    <span className={bridge.kind === 'mock' ? 'w-chip w-chip--warn' : 'w-chip'} title={origin}>
      <span className={`w-dot w-dot--${tone(bridge.kind, bridge.state)}`} />
      {label}
      <span className="w-mono">{bridge.platform}</span>
    </span>
  );
}
