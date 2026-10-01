import type { InjectionKey, App } from 'vue';
import type { Bridge } from '@wise/bridge-client';

/**
 * 桥实例的注入键。
 *
 * 桥在 `createBridge()` 之后**身份不再变化**（换端口是宿主重启 → 页面重载，
 * 传输层内部自己重连），所以这里注入的是实例本身，不是 ref。
 * 会变的是**连接状态**，那一条走 `subscribeBridgeState` / Pinia 的桥 store。
 */
export const BRIDGE_KEY: InjectionKey<Bridge> = Symbol('wise.bridge');

export function provideBridge(app: App, bridge: Bridge): void {
  app.provide(BRIDGE_KEY, bridge);
}
