import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeError, shouldRefetchOnOpen, type Bridge } from '@wise/bridge-client';

export interface CallState<T> {
  readonly loading: boolean;
  readonly data: T | undefined;
  readonly error: BridgeError | undefined;
  readonly reload: () => void;
}

export interface CallOptions {
  /**
   * 为 `false` 时不发请求，直接停在"空且不加载"的静止态。
   *
   * 为什么不能用 `params === undefined` 来代替这个开关：`dashboard.summary`
   * 这类方法**本来就无参**，用 `undefined` 表示"别发"会把它们一起误伤。
   * "无参"与"还没准备好参数"是两件事，必须分开表达。
   */
  readonly enabled?: boolean | undefined;
}

/**
 * 最小可用的取数 hook（W4 会被 TanStack Query 取代）。
 *
 * 现在就用它而不是裸 `useEffect + fetch`，是为了把三件事固定下来：
 * 1. 失败**结构化**（拿到的是 `BridgeError.code`，不是字符串）；
 * 2. 卸载后不再 setState（避免 React 19 的告警与真实竞态）；
 * 3. 依赖变化时重取，且只依赖 `method`/`paramsKey`，不依赖对象引用。
 */
export function useBridgeCall<T>(
  bridge: Bridge,
  method: string,
  params?: unknown,
  options?: CallOptions,
): CallState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<BridgeError>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const paramsKey = JSON.stringify(params ?? null);
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    let alive = true;

    // 未就绪时不发请求：带缺参的请求到后端必然 400，
    // 白白占一次网络往返，还会在日志里制造"这个屏一直在报错"的假象。
    if (!enabled) {
      setLoading(false);
      setError(undefined);
      return () => {
        alive = false;
      };
    }

    setLoading(true);
    setError(undefined);

    /*
     * 记下"这次调用发出去时连接是不是 open"。
     *
     * 断开时发出的调用绑着一条已不存在的连接（传输层的 `failPending` 根本没见过它，
     * 因为它在发送前就失败了），它只能等满 15s 的超时 —— 连接恢复时应当直接作废重来。
     * 而恢复后重取的那一次是在 open 状态下发出的，不会再触发下一次：**每次断线最多重取一次**，
     * 连接抖动不会把界面放大成永久骨架屏。
     */
    startedWhileDisconnectedRef.current = bridge.state !== 'open';

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

  /**
   * 连接恢复后**自动重取一次**。
   *
   * 为什么需要：应用刚起来时第一个请求可能赶上建连还没完成（TCP 连接慢、首次握手、
   * 现场网络抖），表现为"一直转加载 / 转完是错误，切走再切回来才好"。
   * 用户不该为此手动切页面：连接一旦恢复，这一屏自己把数据取回来。
   *
   * **"还在等"也要重取**——只救已经失败的屏是不够的：连接断掉时正在飞的请求
   * 已经注定失败，却要等满 15s 才 reject；连接 1 秒就恢复了，屏幕还得空转十几秒，
   * 用户看到的仍然是"卡加载"。判据与理由见 `shouldRefetchOnOpen`。
   */
  const failedRef = useRef(false);
  failedRef.current = error !== undefined;
  const startedWhileDisconnectedRef = useRef(false);
  useEffect(
    () =>
      bridge.onStateChange((s) => {
        if (
          shouldRefetchOnOpen(s, {
            failed: failedRef.current,
            startedWhileDisconnected: startedWhileDisconnectedRef.current,
          })
        ) {
          setNonce((n) => n + 1);
        }
      }),
    [bridge],
  );

  // `loading` 用**派生值**而不是内部 state：内部 state 的初值是 true，
  // 而 effect 在首帧之后才跑（服务端渲染里根本不跑），于是 `enabled: false` 的屏
  // 首帧会画出一块永远不落地的骨架。派生值把"没在取数"这件事在首帧就说清楚。
  return { loading: enabled && loading, data, error, reload };
}
