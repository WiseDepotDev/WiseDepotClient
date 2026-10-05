<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';
import { errorTextOf } from '@wise/ui';
import type { HumanVerifyApi } from './useHumanVerify.js';

/**
 * 「点击完成验证」——**替代图形验证码的那个按钮**。
 *
 * ## 用户看到什么
 *
 * 未验证：一个按钮（`点击完成验证`）→ 点一下 → 「正在验证…」→ 「已通过」。
 * 慢的时候（>1.5 秒）改口成「网络较慢，请稍候」：桥侧可能正在冷却重试（高风险时等几秒再试一次），
 * 不解释的话用户会以为卡死了。
 *
 * ## 为什么页面里没有"输入框"
 *
 * 整个设计目标就是**不用人输入**：本地环境证据由壳与页面自动采集，服务端验证由票据完成。
 * 页面也不持有票据（票据在桥里，见 `useHumanVerify` 的注释）。
 *
 * ## 不支持时**明确说**
 *
 * 壳没声明 `human.verify`（旧客户端）时说清"请更新客户端"，不悄悄退回别的验证方式 ——
 * 图形验证码已整体删除，没有"别的路"可退。
 */
const props = defineProps<{
  readonly state: HumanVerifyApi;
  /** 验证用途：`LOGIN` / `TAG_BATCH_BIND` / `USER_DELETE`（与服务端 `HumanPurpose` 同名）。 */
  readonly purpose: string;
  /** 登录用途下的账号（服务端据此查失败次数）；其它用途不用传。 */
  readonly username?: string;
}>();

const label = computed(() => {
  switch (props.state.state.value) {
    case 'running':
      return props.state.slow.value ? '正在验证…（网络较慢，请稍候）' : '正在验证…';
    case 'passed':
      return '已通过验证';
    case 'failed':
      return '重新验证';
    default:
      return '点击完成验证';
  }
});

const tone = computed<'primary' | 'success' | 'danger'>(() => {
  switch (props.state.state.value) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'primary';
  }
});

const disabled = computed(() => props.state.state.value === 'running' || props.state.state.value === 'passed');

const hint = computed<{ text: string; tone: 'success' | 'danger' | 'warning' } | undefined>(() => {
  if (!props.state.supported.value) {
    return { text: '当前客户端不支持人机验证，请更新到最新版本。', tone: 'warning' };
  }
  switch (props.state.state.value) {
    case 'passed':
      return { text: '验证已通过，可以继续。', tone: 'success' };
    case 'failed':
      return {
        text: props.state.error.value
          ? errorTextOf(props.state.error.value, '验证未通过，请再试一次')
          : '验证未通过，请再试一次',
        tone: 'danger',
      };
    default:
      return undefined;
  }
});

function onClick(): void {
  void props.state.verify(props.purpose, props.username);
}
</script>

<template>
  <div class="w-human-verify">
    <ElButton
      size="large"
      :type="tone"
      :loading="state.state.value === 'running'"
      :disabled="disabled || !state.supported.value"
      data-testid="human-verify"
      @click="onClick"
    >
      {{ label }}
    </ElButton>
    <p v-if="hint" class="w-human-verify__hint" :class="`w-human-verify__hint--${hint.tone}`" role="status">
      {{ hint.text }}
    </p>
  </div>
</template>

<style scoped>
.w-human-verify {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  align-items: flex-start;
}

.w-human-verify__hint {
  margin: 0;
  color: var(--w-state-neutral-text);
  font-size: var(--w-font-size-caption);
}

.w-human-verify__hint--success {
  color: var(--w-state-success-text);
}

.w-human-verify__hint--danger {
  color: var(--w-state-danger-text);
}

.w-human-verify__hint--warning {
  color: var(--w-state-warning-text);
}
</style>
