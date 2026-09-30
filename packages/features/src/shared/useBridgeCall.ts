import { useCallback, useEffect, useState } from 'react';
import { BridgeError, type Bridge } from '@wise/bridge-client';

export interface CallState<T> {
  readonly loading: boolean;
  readonly data: T | undefined;
  readonly error: BridgeError | undefined;
  readonly reload: () => void;
}

/**
 * 最小可用的取数 hook（W4 会被 TanStack Query 取代）。
 *
 * 现在就用它而不是裸 `useEffect + fetch`，是为了把三件事固定下来：
 * 1. 失败**结构化**（拿到的是 `BridgeError.code`，不是字符串）；
 * 2. 卸载后不再 setState（避免 React 19 的告警与真实竞态）；
 * 3. 依赖变化时重取，且只依赖 `method`/`paramsKey`，不依赖对象引用。
 */
export function useBridgeCall<T>(bridge: Bridge, method: string, params?: unknown): CallState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<BridgeError>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const paramsKey = JSON.stringify(params ?? null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);

    bridge
      .call<T>(method, params)
      .then((value) => {
        if (alive) {
          setData(value);
        }
      })
      .catch((e: unknown) => {
        if (!alive) {
          return;
        }
        setError(e instanceof BridgeError ? e : new BridgeError({ code: 'BRIDGE_INTERNAL', details: String(e) }));
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });

    return () => {
      alive = false;
    };
    // params 用序列化后的 key 参与依赖，避免每次渲染都重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, method, paramsKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { loading, data, error, reload };
}
