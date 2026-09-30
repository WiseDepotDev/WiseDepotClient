import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 相机扫码（Web 侧）。
 *
 * ## 为什么能用零依赖实现
 *
 * 前提是页面处于**安全上下文**（壳已把页面切到 https，见 `MainActivity` 的 SHELL_ORIGIN），
 * 且 WSA/Android 的 WebView 里 **`BarcodeDetector` 是可用的**（实测 `typeof` 为 function）。
 * 于是取流用 `getUserMedia`、解码用系统自带的 `BarcodeDetector`，不必引第三方解码库。
 *
 * ## 与键盘式扫码枪的关系
 *
 * 两者是**同一个产品动作的两条输入路径**：都产出"一串编码"，都交给上层同一条导航
 * （扫到就推入标签详情）。所以这个 hook 只负责"从画面里读出一串码"，
 * 不做业务判断 —— 那是外壳的事。
 */

/** `BarcodeDetector` 还没进 TS 的标准库，这里只声明用到的那一小块。 */
interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<readonly DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: readonly string[] }) => BarcodeDetectorLike;

/** 仓库里见得到的码制。不列全：`BarcodeDetector` 支持哪些由设备决定，列了不支持的在部分机器上会直接抛错。 */
const FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix', 'itf'] as const;

/**
 * 告诉宿主"我要开相机了" / "这次开完了"。
 *
 * ## 为什么需要它
 *
 * 有些 WebView 一开相机就在**宿主自己的进程**里中止（实测 WSA），整个应用随之消失 ——
 * 连"渲染进程崩了"的回调都不会触发。宿主没法在崩溃后自救，只能**事先留一个标记**，
 * 崩了就等于标记没被清掉，下次启动就不再给页面相机权限（详见宿主的 `CameraSafety`）。
 *
 * ## 为什么"通了"不算数，只有"收起了"才算数
 *
 * 实测过：那台机器上取流成功、`play()` 成功、**画面也真的出帧了**，崩在之后。
 * 所以任何"进行中"的信号都不能用来清标记 —— 只有取景正常收起（扫到了 / 用户取消了）
 * 才说明这一次从开到关全程没出事。
 *
 * ## 为什么开之前必须 await
 *
 * 标记要在**相机真正打开之前**落盘。放在 getUserMedia 之后写是没意义的：
 * 进程可能已经没了。这个 fetch 是同源拦截、不出进程，代价是一次微任务往返。
 *
 * ## 为什么走同源 fetch 而不是桥
 *
 * 桥是业务通道（每个方法都对应契约里的一条），而这是宿主与页面之间的存活信号，
 * 与 `__bridge.json` 同一层级。桌面壳/开发服务器上没有这两个路径，404 无所谓 ——
 * 那种环境本来也不会因为相机崩进程，所以这里绝不让它失败影响扫码本身。
 */
async function reportCameraBegin(): Promise<void> {
  try {
    await fetch('/__camera-begin', { method: 'GET', cache: 'no-store' });
  } catch {
    // 刻意吞掉：宿主不认识这个路径时，"能不能扫码"不该受它影响
  }
}

function reportCameraDone(): void {
  void fetch('/__camera-done', { method: 'GET', cache: 'no-store' }).catch(() => undefined);
}

/**
 * 等到画面里**真的有帧**。
 *
 * 判据刻意不是"`getUserMedia` 返回了"：实测（WSA）取流是成功的、`play()` 也返回了，
 * 崩溃发生在**第一帧要渲染的时候**。所以"通不通"只能以"出没出画面"为准 ——
 * 拿承诺是否兑现当判据会把一个即将崩溃的尝试报成成功，面包屑就被提前清掉了。
 */
function waitForFrames(video: HTMLVideoElement, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    // readyState >= 2（HAVE_CURRENT_DATA）= 当前帧有数据可画
    const ready = (): boolean => video.videoWidth > 0 && video.readyState >= 2;
    if (ready()) {
      resolve(true);
      return;
    }
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('playing', check);
      video.removeEventListener('timeupdate', check);
    };
    function check(): void {
      if (ready()) {
        cleanup();
        resolve(true);
      }
    }
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    video.addEventListener('loadeddata', check);
    video.addEventListener('playing', check);
    video.addEventListener('timeupdate', check);
  });
}

export type CameraScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable' | 'failed';

export interface UseCameraScanOptions {
  /** 是否启用（打开覆盖层时为 true，关闭时立刻释放摄像头）。 */
  readonly active: boolean;
  /** 读到一串码时回调。**已经对同一次取流里的重复码做了去重**（每秒能读十几次同一张码）。 */
  readonly onDetected: (code: string) => void;
}

export interface CameraScanSession {
  readonly state: CameraScanState;
  /** 给 UI 看的一句话（业务语言，不含错误码与类名）。 */
  readonly message: string;
  /** 把流挂到这个 `<video>` 上。 */
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function useCameraScan({ active, onDetected }: UseCameraScanOptions): CameraScanSession {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CameraScanState>('idle');
  const [message, setMessage] = useState('');

  // 回调放 ref：它每次渲染都是新函数，进依赖会让取流反复重启
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    if (!active) {
      setState('idle');
      setMessage('');
      return;
    }

    const detectorCtor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (typeof detectorCtor !== 'function') {
      setState('unavailable');
      setMessage('这台设备的系统没有提供条码识别能力，请用扫码枪或手动输入编码。');
      return;
    }

    let stream: MediaStream | null = null;
    // 用 ReturnType 而不是 number：这一份代码同时跑在浏览器与 Node（门禁用例）里，
    // 两边的 setInterval 返回类型不同，写死 number 会在 Node 侧编译不过。
    let timer: ReturnType<typeof globalThis.setInterval> | undefined;
    let alive = true;
    /** 同一次取流里只报一次同一张码：对着一个码不动时，识别器每秒会命中十几次。 */
    let lastCode = '';

    const stop = (): void => {
      if (timer !== undefined) {
        globalThis.clearInterval(timer);
      }
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      // 取景收起 = 这次尝试有始有终（扫到了 or 用户取消了），宿主可以清掉"可能崩过"的标记。
      // 崩溃时走不到这里 —— 那正是这个标记的意义所在。
      reportCameraDone();
    };

    setState('starting');
    setMessage('正在打开相机…');

    void (async () => {
      try {
        // 先留标记再开相机，顺序不能反（见 reportCameraBegin 的说明）
        await reportCameraBegin();
        if (!alive) {
          stop();
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (!alive) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (!video) {
          stop();
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);

        // 等真的出画面再算"正在扫描"：只等取流成功的承诺会在黑屏上就显示"对准取景框"
        const live = await waitForFrames(video);
        if (!alive) {
          return;
        }
        if (!live) {
          setState('failed');
          setMessage('相机没有出画面。请重试；如果一直这样，请改用扫码枪。');
          return;
        }
        setState('scanning');
        setMessage('把条码对准取景框');

        const detector = new detectorCtor({ formats: [...FORMATS] });
        timer = globalThis.setInterval(() => {
          void detector
            .detect(video)
            .then((codes) => {
              const first = codes[0]?.rawValue?.trim();
              if (!alive || !first || first === lastCode) {
                return;
              }
              lastCode = first;
              onDetectedRef.current(first);
            })
            // 单帧识别失败是常态（画面糊、角度不对），不当成故障打断用户
            .catch(() => undefined);
        }, 250);
      } catch (e) {
        if (!alive) {
          return;
        }
        // 权限被拒与"没有摄像头"要给不同的话：前者用户能自己改，后者只能换设备
        const name = e instanceof Error ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setState('denied');
          setMessage('没有拿到相机权限。请在系统设置里允许本应用使用相机，然后重试。');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setState('unavailable');
          setMessage('这台设备没有可用的摄像头，请用扫码枪或手动输入编码。');
        } else {
          setState('failed');
          setMessage('相机启动失败，请重试，或改用扫码枪。');
        }
      }
    })();

    return () => {
      alive = false;
      stop();
    };
  }, [active]);

  const noop = useCallback(() => undefined, []);
  return { state, message, videoRef: videoRef as React.RefObject<HTMLVideoElement | null> };
}
