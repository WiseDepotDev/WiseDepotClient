<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElButton, ElIcon, useZIndex } from 'element-plus';
import { Postcard } from '@element-plus/icons-vue';
import { BRIDGE_EVENT_NFC_STATE, BRIDGE_EVENT_NFC_TAG, LocalMethod } from '@wise/bridge-client';
import { useBridgeStore } from '@wise/stores';

/**
 * NFC 读卡（B3/S4）—— brief §4 那张状态机的落点。
 *
 * ```
 * 无 nfc.read 能力（或 unsupported）  → **一个像素都不画**（连"未开启"都不画）
 * 有硬件但未开启                      → 「NFC 未开启」+「去开启」（调 nfc.openSettings）
 * 有硬件且已开启、无标签              → 「请将标签靠近手机背部」（就绪态，不是错误）
 * 读到标签                            → 标签信息卡（id / tech）+「继续读下一张」
 * ```
 *
 * ## 三条纪律（都在代码里，不靠记性）
 *
 * 1. **入口只由能力位决定**：`bridge.supports('nfc.read')` 为假时整段不渲染，
 *    既不判平台字符串、也不去问"是不是手机"。手机壳目前**刻意不声明**它
 *    （`ShellBridge.NFC_READ_VERIFIED`：读到标签还没在真机上验过），
 *    所以现在这套界面在真机上也不会出现 —— 这正是"能力声明即承诺"要的效果。
 * 2. **两种状态两种出路**：`off` 有出路（去系统设置里开）；`unsupported` **没有**出路
 *    （只能换设备），所以它不画任何入口 —— 画一个点了没反应的按钮比不画更糟。
 * 3. **读到之后不停读**：NFC 是"贴一下就扫"，壳在 `onResume`～`onPause` 期间一直开着
 *    reader mode（见 `MainActivity`）；这里只消费事件，**不提供"开始/停止"**
 *    （那会变成双所有者：壳以为在扫、Web 以为停了）。
 *
 * ## 为什么"去开启"要如实回报
 *
 * 本机方法 `nfc.openSettings` 返回 `{opened:boolean}`。打不开系统设置页时（少数 ROM 上
 * 没有那个 Activity）如果假装成功，用户看到的就是"点了没反应"；这里如实改口说
 * "请手动到系统设置里开启"。这与相机取景层"每个错误态都有出路"是同一条规格。
 */

const bridge = useBridgeStore();

/** 入口唯一判据：能力位（不是平台、不是断点）。 */
const canRead = computed(() => bridge.supports('nfc.read'));

/**
 * 三态 + 未知。
 *
 * 初值是 `ready` 而不是 `unknown`：**能力位在 = 壳已经承诺过它能读**，
 * 而 `nfc.state` 只在 `onResume` 时会来一条（切后台再回来才有新的）。
 * 用 `unknown` 开场会让用户先看到一句含糊的"状态未知"，而那条事件其实已经在路上了。
 */
type Phase = 'ready' | 'off' | 'unsupported';
const phase = ref<Phase>('ready');

interface NfcTag {
  readonly id: string;
  readonly tech: string;
  readonly at: number;
}
const tag = ref<NfcTag | null>(null);
/** 「去开启」的如实回报：打不开时给出手动出路，而不是让按钮看起来生效了。 */
const openFailed = ref(false);
/** 就绪提示被收起（只作用于这一次打开：标签事件会重新显示它）。 */
const hintHidden = ref(false);

const { nextZIndex } = useZIndex();
const layerZ = ref(nextZIndex());

function readField(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * `nfc.state` → 界面状态。
 *
 * 未知取值**不改状态**：宁可停在"就绪"，也不要因为将来多了一个新字段就把界面清空
 * （壳与 Web 不可能永远同版本，而降级要往"还能用"的方向降）。
 */
function onState(payload: unknown): void {
  const state = readField(payload, 'state');
  if (state === 'off') {
    phase.value = 'off';
    return;
  }
  if (state === 'unsupported') {
    phase.value = 'unsupported';
    return;
  }
  if (state === 'on') {
    phase.value = 'ready';
  }
}

/** `nfc.tag` → 标签卡。`at` 只用于展示"这是刚发生的一次"，不参与排序。 */
function onTag(payload: unknown): void {
  const id = readField(payload, 'id');
  if (id === null || id === '') {
    // 没有 id 的 tag 事件是坏数据：显示一张空白卡片比不显示更糟
    return;
  }
  const at = (payload as Record<string, unknown> | null)?.['at'];
  tag.value = {
    id,
    tech: readField(payload, 'tech') ?? 'Unknown',
    at: typeof at === 'number' ? at : Date.now(),
  };
  hintHidden.value = false;
  // 卡片要盖在可能已经打开的弹层之上（与结果卡、取景层同一个坑）
  layerZ.value = nextZIndex();
}

let offState: (() => void) | null = null;
let offTag: (() => void) | null = null;

onMounted(() => {
  // 订阅要放在能力判定**之内**：没有这条能力时收不到任何事件，也就没必要挂监听
  if (!canRead.value) {
    return;
  }
  offState = bridge.subscribe(BRIDGE_EVENT_NFC_STATE, onState);
  offTag = bridge.subscribe(BRIDGE_EVENT_NFC_TAG, onTag);
});

onBeforeUnmount(() => {
  offState?.();
  offTag?.();
  offState = null;
  offTag = null;
});

/**
 * 「去开启」：跳系统 NFC 设置页。
 *
 * 调用本机方法而不是自己想办法：Web 侧打不开系统设置（`LocalMethod.NFC_OPEN_SETTINGS`
 * 是宿主唯一能做这件事的地方）。
 */
async function openSettings(): Promise<void> {
  openFailed.value = false;
  try {
    const result = await bridge.call<{ opened?: boolean }>(LocalMethod.NFC_OPEN_SETTINGS);
    openFailed.value = result?.opened !== true;
  } catch (e) {
    // 方法不存在（旧壳）/ 本机失败：都如实说"没打开"，并给手动出路
    console.warn('[nfc] 调用 nfc.openSettings 失败', e);
    openFailed.value = true;
  }
}

function dismissTag(): void {
  tag.value = null;
}
</script>

<template>
  <!--
    没有能力位（或这台机器没有硬件）→ 整段不存在。
    `unsupported` 也在这一支里：那条路没有出路，画入口只会让人白点。
  -->
  <div v-if="canRead && phase !== 'unsupported'" class="w-nfc">
    <!-- 标签信息卡：**只显示壳真的给了的东西**（id / tech），不编业务含义 -->
    <div v-if="tag !== null" class="w-nfc__card" :style="{ zIndex: layerZ }" role="status">
      <ElIcon class="w-nfc__icon"><Postcard /></ElIcon>
      <div class="w-nfc__body">
        <span class="w-nfc__label">已读到标签</span>
        <span class="w-nfc__id">{{ tag.id }}</span>
        <span class="w-nfc__tech">{{ tag.tech }}</span>
      </div>
      <ElButton size="small" text @click="dismissTag()">继续读下一张</ElButton>
    </div>

    <!-- 未开启：状态 + **出路**（去开启） -->
    <div v-else-if="phase === 'off'" class="w-nfc__strip w-nfc__strip--off">
      <span class="w-nfc__label">NFC 未开启</span>
      <ElButton size="small" text @click="openSettings()">去开启</ElButton>
      <span v-if="openFailed" class="w-nfc__note">没能打开系统设置，请手动到系统设置里开启 NFC</span>
    </div>

    <!-- 就绪态（不是错误）：告诉用户怎么用 -->
    <div v-else-if="!hintHidden" class="w-nfc__strip">
      <ElIcon class="w-nfc__icon"><Postcard /></ElIcon>
      <span class="w-nfc__label">请将标签靠近手机背部</span>
      <ElButton size="small" text @click="hintHidden = true">收起</ElButton>
    </div>
  </div>
</template>
