<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElButton, ElIcon, useZIndex } from 'element-plus';
import { Postcard } from '@element-plus/icons-vue';
import { useBridgeStore } from '@wise/stores';
import {
  NFC_CAPABILITY,
  NFC_EVENT_STATE,
  NFC_EVENT_TAG,
  NFC_OPEN_SETTINGS,
  nextNfcPhase,
  nfcTagOf,
  openSettingsSucceeded,
  shouldRenderNfc,
  type NfcPhase,
  type NfcTag,
} from './nfc-state.js';

/**
 * NFC 读卡（B3/S4）—— brief §4 那张状态机的**渲染层**。
 *
 * ```
 * 无 nfc.read 能力（或 unsupported）  → **一个像素都不画**（连"未开启"都不画）
 * 有硬件但未开启                      → 「NFC 未开启」+「去开启」（调 nfc.openSettings）
 * 有硬件且已开启、无标签              → 「请将标签靠近手机背部」（就绪态，不是错误）
 * 读到标签                            → 标签信息卡（id / tech）+「继续读下一张」
 * ```
 *
 * ## 判定不在这里
 *
 * "收到哪个事件该显示什么"全部在 `nfc-state.ts`（零依赖、可被 `esbuild + node` 真跑一遍，
 * 见 `tools/check/check-nfc.mjs` 第 8 节）。本组件只做三件事：订阅、把状态喂给判定、
 * 把结果画出来 —— 于是"没有能力时不画入口""两种文案不同""未知取值保持原状"
 * 这些判据都有**可执行的**证据，而不是只能靠读模板。
 *
 * 三条纪律（判定层实现的，这里只再写一遍免得读者以为在别处）：
 * 1. **入口只由能力位决定**：不判平台字符串、不判断点。手机壳目前**刻意不声明** `nfc.read`
 *    （`ShellBridge.NFC_READ_VERIFIED`：读到标签还没在真机上验过），所以现在真机上
 *    这套界面也不会出现 —— 这正是"能力声明即承诺"要的效果。
 * 2. **两种状态两种出路**：`off` 有出路（去系统设置里开）；`unsupported` 没有，不画。
 * 3. **读到之后不停读**：NFC 是"贴一下就扫"，壳在 `onResume`～`onPause` 期间一直开着
 *    reader mode；这里只消费事件，**不提供"开始/停止"**（那是双所有者）。
 */

const bridge = useBridgeStore();

/** 入口唯一判据：能力位。 */
const canRead = computed(() => bridge.supports(NFC_CAPABILITY));

/**
 * 初值 `ready` 而不是"未知"：**能力位在 = 壳已经承诺过它能读**，
 * 而 `nfc.state` 要到 `onResume` / 页面加载完成时才来一条。用"未知"开场
 * 会让用户先看到一句含糊的话，而那条事件其实已经在路上了。
 */
const phase = ref<NfcPhase>('ready');
const tag = ref<NfcTag | null>(null);
/** 「去开启」的如实回报：打不开时给出手动出路，而不是让按钮看起来生效了。 */
const openFailed = ref(false);
/** 就绪提示被收起（只作用于这一次打开：标签事件会重新显示它）。 */
const hintHidden = ref(false);

/** 是否渲染（能力位 + 状态；`unsupported` 也在"不画"那一支，见 nfc-state.ts）。 */
const visible = computed(() => shouldRenderNfc(canRead.value, phase.value));

const { nextZIndex } = useZIndex();
const layerZ = ref(nextZIndex());

let offState: (() => void) | null = null;
let offTag: (() => void) | null = null;

onMounted(() => {
  // 订阅要放在能力判定**之内**：没有这条能力时收不到任何事件，也就没必要挂监听
  if (!canRead.value) {
    return;
  }
  offState = bridge.subscribe(NFC_EVENT_STATE, (payload) => {
    phase.value = nextNfcPhase(phase.value, payload);
  });
  offTag = bridge.subscribe(NFC_EVENT_TAG, (payload) => {
    const next = nfcTagOf(payload);
    if (next === null) {
      // 没有 id 的坏数据：不画空卡片（更不把上一张留在屏幕上冒充新的）
      console.warn('[nfc] 收到没有 id 的 nfc.tag，已忽略', payload);
      return;
    }
    tag.value = next;
    hintHidden.value = false;
    // 卡片要盖在可能已经打开的弹层之上（与结果卡、取景层同一个坑）
    layerZ.value = nextZIndex();
  });
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
 * 调用本机方法而不是自己想办法：Web 侧打不开系统设置（宿主是唯一能做这件事的地方）。
 * 返回值判定也在 `nfc-state.ts`（只有明确的 `opened: true` 才算成功）。
 */
async function openSettings(): Promise<void> {
  openFailed.value = false;
  try {
    const result = await bridge.call<{ opened?: boolean }>(NFC_OPEN_SETTINGS);
    openFailed.value = !openSettingsSucceeded(result);
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
  <!-- 没有能力位（或这台机器没有硬件）→ 整段不存在，连"未开启"都不画 -->
  <div v-if="visible" class="w-nfc">
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
