<script setup lang="ts">
import { ElButton, ElInput } from 'element-plus';
import { errorTextOf } from '@wise/ui';
import type { CaptchaState } from './useCaptcha.js';

/**
 * 验证码行：图片 + 换一张 + 输入框。
 *
 * 组件只负责**画**，状态由 `useCaptcha()` 持有 —— 于是"失败后必须换一张"这类规则
 * 只有一个落点，不会每个用到验证码的屏各写一遍。
 */
const props = defineProps<{
  readonly state: CaptchaState;
  /** 输入框占位（默认"验证码"）。 */
  readonly placeholder?: string | undefined;
}>();
</script>

<template>
  <div class="w-captcha">
    <img
      v-if="props.state.captcha.value?.captchaImage"
      class="w-captcha__img"
      :src="props.state.captcha.value.captchaImage"
      alt="验证码"
    />
    <div v-else class="w-captcha__img w-captcha__img--empty" aria-hidden="true" />
    <ElButton size="large" text :loading="props.state.loading.value" @click="props.state.refresh()">
      换一张
    </ElButton>
    <ElInput
      v-model="props.state.code.value"
      size="large"
      class="w-captcha__input"
      :placeholder="placeholder ?? '验证码'"
      autocomplete="off"
    />
    <span v-if="props.state.error.value" class="w-captcha__error" role="alert">
      {{ errorTextOf(props.state.error.value, '验证码加载失败') }}
    </span>
  </div>
</template>

<style scoped>
.w-captcha {
  display: flex;
  align-items: center;
  gap: var(--w-space-inline-gap);
  flex-wrap: wrap;
  width: 100%;
}

.w-captcha__img {
  width: var(--w-size-captcha-width);
  height: var(--w-density-control-height);
  border-radius: var(--w-radius-control);
  border: 1px solid var(--w-color-outline);
  object-fit: cover;
  background: var(--w-color-surface-alt);
}

.w-captcha__img--empty {
  display: block;
}

.w-captcha__input {
  flex: 1;
  min-width: var(--w-size-card-min-width);
}

.w-captcha__error {
  flex-basis: 100%;
  color: var(--w-state-danger-text);
  font-size: var(--w-type-body-small-size);
}
</style>
