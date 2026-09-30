/**
 * @wise/contract —— 桥方法契约的**唯一出口**。
 *
 * `src/generated/bridgeContract.ts` 由 `tools/gen/gen-bridge-contract.js` 生成，
 * 与服务端控制器注解同源（STD-CONTRACT-03）。这个 index 只做转出与少量**纯类型**便利工具，
 * 不允许在这里手写任何方法 id —— 手写即漂移。
 */

export {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_DOMAINS,
  BRIDGE_HTTP_METHODS,
  BRIDGE_METHODS,
  BRIDGE_METHOD_IDS,
  BRIDGE_METHOD_BY_ID,
  BRIDGE_EXCLUDED_IDS,
} from './generated/bridgeContract.js';

export type {
  BridgeDomain,
  BridgeHttpMethod,
  BridgeMethod,
  BridgeMethodId,
} from './generated/bridgeContract.js';

import { BRIDGE_METHODS, BRIDGE_METHOD_BY_ID } from './generated/bridgeContract.js';
import type { BridgeDomain, BridgeMethod, BridgeMethodId } from './generated/bridgeContract.js';

/** 某一级域下的全部方法。 */
export function methodsOfDomain(domain: BridgeDomain): readonly BridgeMethod[] {
  return BRIDGE_METHODS.filter((m) => m.domain === domain);
}

/**
 * 断言式查表：调用点使用字面量 id 时先过这里，
 * 这样"方法名拼错"在读代码时就暴露，而不是等运行时收到 BRIDGE_METHOD_UNKNOWN。
 */
export function method(id: BridgeMethodId): BridgeMethod {
  return BRIDGE_METHOD_BY_ID[id];
}

/** 方法总数的自检常量，供文档与冒烟脚本对齐。 */
export const BRIDGE_METHOD_COUNT = BRIDGE_METHODS.length;
