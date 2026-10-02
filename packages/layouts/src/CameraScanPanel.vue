<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { ElButton, ElIcon, ElOption, ElSelect } from 'element-plus';
import { Camera, Close } from '@element-plus/icons-vue';
import { useBridgeStore } from '@wise/stores';
import { errorTextOf } from '@wise/ui';
import {
  listCameras,
  readSelectedCameraId,
  resolveSelectedCamera,
  writeSelectedCameraId,
  type CameraOption,
} from './scan-camera.js';
import { detectOnce, type BarcodeDetectorLike } from './scan-decode.js';
import { openScanDecoder } from './scan-engines.js';
import { CameraSession, type CameraFailure } from './scan-stream.js';
import { loadZxingReader, nativeDetectorCtor } from './scan-zxing.js';

/**
 * 桌面相机取景层（B1/S2b3）。
 *
 * 这就是 brief §4 那张状态机的落点：
 *
 * ```
 * starting  → 取景层 + "正在启动相机…"
 * running   → 画面 + 遮罩框 + "取消"
 * error     → 对应中文 + 出路（重试 / 换一个摄像头 / 关闭）
 * 命中       → 停流、关层，把码交给外壳（顶部结果卡）
 * ```
 *
 * ## 三条纪律（都写在代码里，不靠记性）
 *
 * 1. **入口由能力位决定**：本组件不自问"是不是桌面"，`AppFrame` 只在
 *    `bridge.supports('scan.camera')` 为真时才挂它（手机侧那条能力是**主动撤销**的，
 *    见 `MainActivity.kt:203`）。
 * 2. **每个错误态都有出路**：见模板里的 重试（仅可重试）/ 换一个摄像头（仅当宿主声明
 *    `scan.camera.select`）/ 关闭。**没有死状态**。
 * 3. **停流发生在三处**：关闭取景层（卸载）、窗口失焦、页面切走（切页由外壳关层触发）。
 *    三处都走同一个 [finish]，且 `CameraSession.stop()` 幂等 ——
 *    摄像头指示灯"关了还亮"这件事在代码层面被堵死。
 *
 * ## 为什么"失焦"直接关层而不是暂停
 *
 * 暂停之后画面是黑的，而状态还是 running —— 那就是一个**说自己在跑但什么都没做**的死状态。
 * 关层至少是诚实的：用户切回来点一次"扫码"就能继续。
 */
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'code', code: string, symbology: string): void;
}>();

const bridge = useBridgeStore();

/** 多摄像头才有"换一个"可言；手机不声明这条能力（画出来就是死入口）。 */
const canSelect = computed(() => bridge.supports('scan.camera.select'));

type Phase = 'starting' | 'running' | 'error';

const phase = ref<Phase>('starting');
const failure = ref<CameraFailure | null>(null);
/** 宿主既没有内置识别器、回退引擎也加载不到 —— 与"相机打不开"是两回事，文案也不同。 */
const engineMissing = ref(false);
const cameras = ref<readonly CameraOption[]>([]);
const selectedId = ref<string | null>(null);

const videoEl = ref<HTMLVideoElement | null>(null);
const detector = shallowRef<BarcodeDetectorLike | null>(null);

/**
 * 取景会话**只有一个持有者**（见 scan-stream.ts 的说明）。
 * 组件只做"把它接到 `<video>` 上"和"在三个时机叫停"。
 */
const session = new CameraSession();

/** 取景循环的节奏。200ms 是"抬手就有反应"与"别把 CPU 吃满"之间的折中。 */
const FRAME_INTERVAL_MS = 200;
let frameTimer: ReturnType<typeof setInterval> | null = null;
/** 一次识别没回来之前不再发起第二次：否则慢机器上会堆一摞待解码的帧。 */
let detecting = false;

/**
 * 卸载标志。
 *
 * `begin()` 里**每个 `await` 之后都要看它一眼**：`getUserMedia` / 引擎加载都是异步的，
 * 而"关层"是同步的 —— 用户在"正在启动相机…"这一秒里点了取消，
 * 等请求回来时组件已经卸载了。不检查的话那条流**没有任何人持有**
 * （会话对象随组件一起被丢掉），摄像头指示灯会一直亮着。
 */
let disposed = false;

const message = computed(() => {
  if (engineMissing.value) {
    return '这台设备不支持扫码识别';
  }
  return failure.value === null ? '' : errorTextOf(failure.value, '相机无法启动');
});

function mediaDevices(): MediaDevices | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return navigator.mediaDevices ?? null;
}

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage;
}

function fail(next: CameraFailure): void {
  failure.value = next;
  phase.value = 'error';
}

// ---- 生命周期 ----

/**
 * 打开的完整流程：枚举 → 解析上次选择 → 造引擎 → 开流 → 起识别循环。
 *
 * 每一步失败都**说得出是哪一步**（没有设备 / 权限被拒 / 被占用 / 没有识别器），
 * 这也是为什么"点了没反应"在这个实现里不该出现。
 */
async function begin(): Promise<void> {
  phase.value = 'starting';
  failure.value = null;
  engineMissing.value = false;

  const media = mediaDevices();
  const options = await listCameras(media);
  if (disposed) {
    return;
  }
  cameras.value = options;
  if (options.length === 0) {
    // 空列表的成因可能是"真没有摄像头"，也可能是"浏览器不给列表"——
    // 两者对用户的下一步一样（去接一个 / 去查系统），所以同一句话、同一条出路。
    fail({ code: 'BRIDGE_CAMERA_UNAVAILABLE', messageKey: 'scan.cameraUnavailable', retryable: true });
    return;
  }

  const { camera, fellBack } = resolveSelectedCamera(options, readSelectedCameraId(storage()));
  if (camera === null) {
    fail({ code: 'BRIDGE_CAMERA_UNAVAILABLE', messageKey: 'scan.cameraUnavailable', retryable: true });
    return;
  }
  selectedId.value = camera.id;
  if (fellBack) {
    // 上次那台不在了：**回写**，免得每次打开都要重算一次回退
    writeSelectedCameraId(storage(), camera.id);
  }

  const engine = await openScanDecoder({ nativeCtor: nativeDetectorCtor(), loadZxing: loadZxingReader });
  if (disposed) {
    return;
  }
  if (engine.detector === null) {
    engineMissing.value = true;
    fail({ code: 'BRIDGE_CAMERA_UNAVAILABLE', messageKey: 'scan.cameraUnavailable', retryable: false });
    return;
  }
  detector.value = engine.detector;

  const started = await session.start(media, camera.id);
  if (disposed) {
    // 这条流是在"已经关层"之后才开出来的 —— 唯一能收掉它的人就是这里
    finish();
    return;
  }
  if (!started.ok) {
    fail(started.failure);
    return;
  }

  attachStream();
  phase.value = 'running';
  startLoop();
}

/** 把当前流接到 `<video>` 上。没有元素（SSR / 卸载中）时什么都不做。 */
function attachStream(): void {
  const el = videoEl.value;
  if (el === null) {
    return;
  }
  el.srcObject = session.mediaStream as MediaStream | null;
  // 自动播放可能被策略拒绝（这里已经 `muted`，正常不会）—— 拒绝只是画面不动，
  // 不该把整个开流流程判成失败，所以吞掉它
  void el.play().catch(() => undefined);
}

function startLoop(): void {
  stopLoop();
  frameTimer = setInterval(() => {
    void tick();
  }, FRAME_INTERVAL_MS);
}

function stopLoop(): void {
  if (frameTimer !== null) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

/** 一帧：识别到就收尾（停流 + 关层 + 把码交出去）。 */
async function tick(): Promise<void> {
  const el = videoEl.value;
  const engine = detector.value;
  if (detecting || el === null || engine === null) {
    return;
  }
  detecting = true;
  try {
    const hit = await detectOnce(engine, el);
    if (hit !== null) {
      finish();
      emit('code', hit.code, hit.symbology);
    }
  } finally {
    detecting = false;
  }
}

/**
 * **唯一的收尾路径**（三处停流时机 + 命中都走这里）。
 *
 * 幂等是刻意的：切页关层会连着"卸载"和"主动关"两条路进来，
 * 而 `CameraSession.stop()` 本来就允许多次调用。
 */
function finish(): void {
  stopLoop();
  session.stop();
  const el = videoEl.value;
  if (el !== null) {
    // 断开引用：不这么做的话元素上还挂着一条已停的流（DevTools 里看得见）
    el.srcObject = null;
  }
  detector.value = null;
}

function close(): void {
  finish();
  emit('close');
}

/**
 * 换一个摄像头：先停旧流再走一遍打开流程。
 *
 * 选择**立刻落盘**（不等这次开流成功）：用户的意思很明确，
 * 失败时下次打开用的应当是他刚选的那一枚。
 */
async function switchTo(id: string): Promise<void> {
  writeSelectedCameraId(storage(), id);
  finish();
  await begin();
}

/** 错误态的重试：`begin()` 会重新枚举（设备可能是刚插上的）。 */
async function retry(): Promise<void> {
  finish();
  await begin();
}

/**
 * 失焦 / 页面不可见 → 收尾关层。
 *
 * 为什么不留着取景：摄像头指示灯亮着而人在别的窗口，是**隐私问题**，
 * 不是体验问题（现场机器常常就摆在工位上）。
 */
function onBlur(): void {
  if (phase.value !== 'error') {
    close();
    return;
  }
  // 错误态没有流可停，但层也该收掉 —— 否则用户切回来看到的是一个卡住的错误框
  finish();
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    onBlur();
  }
}

onMounted(() => {
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  // `Esc` 也是"关掉取景层"的一种：层是自绘的，没有 EP dialog 的键盘处理，
  // 所以自己接一个（与 AppFrame 里收起结果卡同一个键）
  window.addEventListener('keydown', onKeyDown);
  void begin();
});

onBeforeUnmount(() => {
  // 先立标志再收尾：这样"刚巧在 await 里的那次 begin()"回来时会自己把流收掉
  disposed = true;
  window.removeEventListener('blur', onBlur);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('keydown', onKeyDown);
  // 关闭取景层 / 切页都从这里收尾 —— 与失焦同一条路径
  finish();
});

/** 给 `Esc` 的出口（见 onMounted 的说明）。 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close();
  }
}

/**
 * Element Plus 的属性整块给：`packages/*` 里 `vue-tsc` 解析不到它 `buildProps` 的结果类型
 * （同样的写法在 `apps/web` 里是好的），运行期行为完全一样。见 `FilterBar.vue` 的同一段说明。
 */
function buttonProps(): any {
  return { text: true, size: 'small' };
}

function selectProps(): any {
  return {
    modelValue: selectedId.value ?? '',
    size: 'small',
    placeholder: '换一个摄像头',
    'aria-label': '换一个摄像头',
  };
}

function optionProps(item: CameraOption): any {
  return { label: item.label, value: item.id };
}
</script>

<template>
  <div class="w-camera" role="dialog" aria-modal="true" aria-label="相机扫码">
    <div class="w-camera__stage">
      <!-- `muted` 是必须的：不静音时 Chromium 会拒绝自动播放，画面停在第一帧 -->
      <video ref="videoEl" class="w-camera__video" autoplay playsinline muted></video>
      <div v-if="phase === 'running'" class="w-camera__reticle" aria-hidden="true"></div>

      <p v-if="phase === 'starting'" class="w-camera__hint">正在启动相机…</p>

      <div v-else-if="phase === 'error'" class="w-camera__error">
        <ElIcon class="w-camera__erricon"><Camera /></ElIcon>
        <p class="w-camera__message">{{ message }}</p>
        <div class="w-camera__actions">
          <ElButton v-if="failure?.retryable" v-bind="buttonProps()" @click="retry">重试</ElButton>
          <!--
            只有**真的有多枚**可选摄像头才给这个出路（B1/S2c 更正）：
            宿主声明 `scan.camera.select` 说的是"这个宿主能枚举并选择"，
            而"这台机器上有没有得选"只有渲染进程看得到（主进程没有 mediaDevices）。
            单摄像头机器上画一个只有一项的下拉，就是点了没反应的死控件。
          -->
          <ElSelect
            v-if="canSelect && cameras.length > 1 && !engineMissing"
            v-bind="selectProps()"
            class="w-camera__picker"
            @update:model-value="(v: string) => switchTo(v)"
          >
            <ElOption v-for="item in cameras" :key="item.id" v-bind="optionProps(item)" />
          </ElSelect>
          <ElButton v-bind="buttonProps()" @click="close">关闭</ElButton>
        </div>
      </div>
    </div>

    <footer class="w-camera__bar">
      <span class="w-camera__tip">
        {{ phase === 'running' ? '把条码放进框里' : '相机不可用时请检查系统设置里的相机权限' }}
      </span>
      <!-- 取景中也能换：现场机器上"前一秒还在用、后一秒就黑屏"多半是另一枚摄像头更合适 -->
      <ElSelect
        v-if="canSelect && phase === 'running' && cameras.length > 1"
        v-bind="selectProps()"
        class="w-camera__picker"
        @update:model-value="(v: string) => switchTo(v)"
      >
        <ElOption v-for="item in cameras" :key="item.id" v-bind="optionProps(item)" />
      </ElSelect>
      <ElButton v-bind="buttonProps()" @click="close">
        <ElIcon><Close /></ElIcon>
        {{ phase === 'running' ? '取消' : '关闭' }}
      </ElButton>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 取景层是**自绘的全屏浮层**（不是 `ElDialog`）：
 * 它要盖住内容区与侧栏，而 EP 的 dialog 会带来自己的标题栏/页脚结构，
 * 那些结构在这里全是多余的（画面本身就是全部内容）。
 */
.w-camera {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--w-color-surface-sunken);
}

.w-camera__stage {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.w-camera__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--w-color-surface-sunken);
}

/* 取景框：只是视觉引导，不参与识别（识别看整帧） */
.w-camera__reticle {
  position: absolute;
  width: 60%;
  height: 40%;
  border: 2px solid var(--w-color-primary);
  border-radius: var(--w-radius-control);
  box-shadow: 0 0 0 100vmax var(--el-mask-color);
}

.w-camera__hint,
.w-camera__message {
  margin: 0;
  color: var(--w-color-on-surface);
  font-size: var(--w-type-body-size);
}

.w-camera__hint {
  position: absolute;
  color: var(--w-color-on-surface-variant);
}

.w-camera__error {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--w-space-row-gap);
  padding: var(--w-space-card-padding);
  background: var(--w-color-surface);
  border-radius: var(--w-radius-card);
}

.w-camera__erricon {
  font-size: var(--w-size-icon-size);
  color: var(--w-color-on-surface-muted);
}

.w-camera__actions {
  display: flex;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

.w-camera__picker {
  min-width: 160px;
}

.w-camera__bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--w-space-inline-gap);
  padding: var(--w-space-card-padding-compact) var(--w-space-screen-h);
  background: var(--w-color-surface);
  min-height: var(--w-space-touch-target-min);
}

.w-camera__tip {
  margin-right: auto;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}
</style>
