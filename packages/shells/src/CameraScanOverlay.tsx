import { useEffect } from 'react';
import { Button } from '@wise/patterns';
import { useCameraScan } from '@wise/scan';

export interface CameraScanOverlayProps {
  /** 读到一串码时回调。上层负责关掉覆盖层并走与扫码枪**同一条**导航落点。 */
  readonly onDetected: (code: string) => void;
  /** 用户主动关闭（取消 / Esc）。 */
  readonly onClose: () => void;
}

/**
 * 相机扫码覆盖层（手机壳用）。
 *
 * ## 为什么放在外壳而不是业务包里
 *
 * "打开相机扫一个码"是**外壳级动作**：它不属于任何一屏，落点也和扫码枪一样是
 * "推入标签详情"。放进 `@wise/scan` 会让那个包同时持有 hook 与 UI、还得多一条
 * 对 `@wise/patterns` 的依赖；放在外壳里，两个外壳都能用同一份。
 *
 * ## 只在宿主声明了能力时才可能被挂载
 *
 * 挂载与否由调用方按 `Capability.SCAN_CAMERA` 决定 —— 这台设备到底有没有相机，
 * 只有宿主知道（WSA 有、某些平板没有）。所以这里不自己探测设备、也不自己判断该不该出现。
 */
export function CameraScanOverlay({ onDetected, onClose }: CameraScanOverlayProps): React.ReactElement {
  const { state, message, videoRef } = useCameraScan({ active: true, onDetected });

  // Esc 关闭：桌面上调试/演示时不用去够鼠标。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const live = state === 'starting' || state === 'scanning';

  return (
    <div className="w-scan" role="dialog" aria-modal="true" aria-label="扫码">
      <div className="w-scan__viewport">
        {live ? <video ref={videoRef} className="w-scan__video" playsInline muted autoPlay /> : null}
        {state === 'scanning' ? <div className="w-scan__frame" aria-hidden="true" /> : null}
      </div>

      <div className="w-scan__foot">
        {/*
          取流中/取流失败都走同一个位置说一句话：用户关心的是"现在能不能扫"，
          而不是内部正在做哪一步。所以这里只显示一句业务语言，不显示状态枚举。
        */}
        <p className="w-scan__hint">{message}</p>
        <Button block onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
