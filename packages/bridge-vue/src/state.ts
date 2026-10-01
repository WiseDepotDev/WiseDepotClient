import { getCurrentScope, inject, onScopeDispose, reactive } from 'vue';
import type { Bridge, ConnectionState } from '@wise/bridge-client';
import { BRIDGE_KEY } from './keys.js';

/** 桥连接状态的只读快照。 */
export interface BridgeSnapshot {
  readonly state: ConnectionState;
  readonly kind: 'ws' | 'mock';
  readonly platform: string;
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  /** 能力判定。**不要**判 `platform === 'desktop'`（架构不变式 2）。 */
  supports(capability: string): boolean;
  /** 已登录会话是否失效由桥经事件通知；这里只给连接状态。 */
}

/**
 * 订阅连接状态，**并隔离订阅者异常**。
 *
 * 为什么要包一层 try/catch：传输层的 fan-out 是"逐个调用处理器"，
 * 任何一个处理器抛错都会让**后面的订阅者收不到这次状态变化** ——
 * 表现是"某个屏永远停在骨架屏，别的屏正常"，极难定位。
 * 这里保证我们自己注册的处理器不会把别人带崩。
 *
 * 返回取消订阅函数。
 */
export function subscribeBridgeState(
  bridge: Bridge,
  handler: (state: ConnectionState) => void,
): () => void {
  return bridge.onStateChange((state) => {
    try {
      handler(state);
    } catch (e) {
      console.error('[bridge-vue] 连接状态订阅者抛错（已隔离，不影响其他订阅者）', e);
    }
  });
}

/**
 * 连接状态的可订阅快照（组件内使用；组件卸载自动退订）。
 *
 * 存在的理由：React 时代到处在读 `bridge.state` 这种**一次性 getter**，
 * 于是"状态变了但界面不知道"成为一类反复出现的 bug。
 * 这里把"读一次"换成"订阅"。
 */
export function useBridgeState(bridge: Bridge): BridgeSnapshot {
  const snapshot = reactive({
    state: bridge.state,
    kind: bridge.kind,
    platform: bridge.platform,
    hostVersion: bridge.hostVersion,
    capabilities: bridge.capabilities,
  });

  const off = subscribeBridgeState(bridge, (state) => {
    snapshot.state = state;
  });
  if (getCurrentScope()) {
    onScopeDispose(off);
  }

  return {
    get state() {
      return snapshot.state;
    },
    get kind() {
      return snapshot.kind;
    },
    get platform() {
      return snapshot.platform;
    },
    get hostVersion() {
      return snapshot.hostVersion;
    },
    get capabilities() {
      return snapshot.capabilities;
    },
    supports: (capability) => snapshot.capabilities.includes(capability),
  };
}

/** 注入桥实例；缺失时给出**能照着修**的错误，而不是 undefined 传播出去。 */
export function useBridge(): Bridge {
  const bridge = inject(BRIDGE_KEY, null);
  if (!bridge) {
    throw new Error(
      '找不到桥实例：应用入口必须 `provideBridge(app, bridge)`，或在 `useBridgeStore().attach(bridge, origin)` 之后再使用桥。',
    );
  }
  return bridge;
}
