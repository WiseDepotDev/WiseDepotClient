<script setup lang="ts">
import { computed } from 'vue';
import { ElIcon, ElInput } from 'element-plus';
import { Camera } from '@element-plus/icons-vue';
import { useBridgeStore, useScanStore } from '@wise/stores';

/**
 * 条形码输入框 + 相机图标（B1/S2b4）。
 *
 * ## 为什么入口必须在字段上
 *
 * 用户实测反馈："扫码应该放在条形码输入框后面"。他说得对，而且这不只是位置问题：
 * 顶栏那个全局入口扫完只能走"结果卡 + 跳标签详情"，而**真正要扫码的人正站在一个
 * 输入框前面**（新建标签、改标签、补录）—— 他要的是"这一下把码填进这个框"。
 * 把图标放在字段上，语义就唯一了：**扫到的码进这个输入框**，不跳页、不弹卡。
 *
 * ## 两条纪律
 *
 * 1. **没能力就不画图标**：`bridge.supports('scan.camera')` 为假时（手机、或没摄像头
 *    的机器撤回声明后）这里一个字都不出现 —— 与外壳入口同一条纪律。
 * 2. **结果是一次性的**：`openCamera(handler)` 登记接收方，取景层关掉即作废
 *    （见 `useScanStore.deliverCameraCode`）—— 否则第二次扫码会填进上一次的框。
 */
const props = defineProps<{
  readonly modelValue: string;
  readonly placeholder?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  /** 相机扫到了（在写进 v-model 之后发一次，供调用方做"扫完就查"这类动作）。 */
  (e: 'scanned', code: string): void;
}>();

const bridge = useBridgeStore();
const scan = useScanStore();

const canScan = computed(() => bridge.supports('scan.camera'));

function openCamera(): void {
  scan.openCamera((code) => {
    emit('update:modelValue', code);
    emit('scanned', code);
    // 返回 true = 这次扫码已消费：不许再走"跳标签详情"那条兜底
    return true;
  });
}

/**
 * Element Plus 的属性整块给（`packages/*` 里 `vue-tsc` 解析不到它 `buildProps` 的结果类型，
 * 单属性字面量会被当成"属性定义对象"来校验）。见 `FilterBar.vue` 的同一段说明。
 */
function inputProps(): any {
  return {
    modelValue: props.modelValue,
    size: 'large',
    placeholder: props.placeholder ?? '条形码',
  };
}
</script>

<template>
  <div class="w-scanfield">
    <ElInput v-bind="inputProps()" @update:model-value="(v: string) => emit('update:modelValue', v)">
      <!-- suffix 而不是"框后面再放一个按钮"：这样它**在输入框里面**，
           手指/鼠标的落点与"这个框"是一体的，也不会把窄栏挤成两行 -->
      <template v-if="canScan" #suffix>
        <button
          type="button"
          class="w-scanfield__camera"
          aria-label="用相机扫码"
          title="用相机扫码（扫到的码会填进这个输入框）"
          @click="openCamera"
        >
          <ElIcon><Camera /></ElIcon>
        </button>
      </template>
    </ElInput>
  </div>
</template>

<style scoped>
.w-scanfield {
  width: 100%;
}

/*
 * 图标按钮：**至少 32px 的落点**（鼠标还好，触屏上 16px 的图标本身点不中），
 * 并且不抢输入框的点击区域（只在右侧那一小块）。
 */
.w-scanfield__camera {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--w-radius-control);
  background: transparent;
  color: var(--w-color-on-surface-variant);
  cursor: pointer;
}

.w-scanfield__camera:hover {
  background: var(--w-color-surface-alt);
  color: var(--w-color-primary);
}

.w-scanfield__camera:focus-visible {
  outline: 2px solid var(--w-color-focus-ring);
  outline-offset: 2px;
}
</style>
