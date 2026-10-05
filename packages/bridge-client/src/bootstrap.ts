import { BOOTSTRAP_PATH, BRIDGE_PROTOCOL_VERSION, BridgeError, type BridgeBootstrap } from './types.js';

/** 引导结果。`absent` 是**正常**情况：纯浏览器里跑 `vite dev` 时没有宿主，应降级到 mock。 */
export type BootstrapResult =
  | { readonly kind: 'ready'; readonly bootstrap: BridgeBootstrap }
  | { readonly kind: 'absent'; readonly reason: string };

/** 协议版本不匹配。**不静默降级**：半兼容的半可用状态比明确失败更难查。 */
export class ProtocolMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`桥协议版本不匹配：客户端 ${expected} / 宿主 ${actual}`);
    this.name = 'ProtocolMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

function isBootstrap(value: unknown): value is BridgeBootstrap {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.port === 'number' &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    v.port <= 65535 &&
    typeof v.psk === 'string' &&
    v.psk.length >= 16 &&
    typeof v.platform === 'string' &&
    typeof v.ver === 'string' &&
    typeof v.protocol === 'number' &&
    Array.isArray(v.capabilities)
  );
}

/**
 * 读取**应用自身 origin** 上的 `__bridge.json`。
 *
 * 两端（桌面 `app://wise`、手机 `https://appassets.androidplatform.net`）走的是同一条路径，
 * 这是"Web 与原生之间只有一份引导契约"的落点（架构不变式 2）。
 */
export async function loadBootstrap(fetchImpl: typeof fetch = fetch): Promise<BootstrapResult> {
  let res: Response;
  try {
    res = await fetchImpl(BOOTSTRAP_PATH, { cache: 'no-store' });
  } catch (e) {
    return { kind: 'absent', reason: `引导请求失败：${(e as Error).message}` };
  }

  if (!res.ok) {
    // 宿主进程还没把桥拉起来时，宿主应回 503；这不是错误路径，而是"尚未就绪"
    return { kind: 'absent', reason: `宿主未提供引导（HTTP ${res.status}）` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'absent', reason: '引导内容不是合法 JSON' };
  }

  if (!isBootstrap(body)) {
    throw new BridgeError({ code: 'BRIDGE_INTERNAL', messageKey: 'bridge.bootstrapMalformed' });
  }
  if (body.protocol !== BRIDGE_PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(BRIDGE_PROTOCOL_VERSION, body.protocol);
  }
  return { kind: 'ready', bootstrap: body };
}
