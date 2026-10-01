<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElForm, ElFormItem, ElInput } from 'element-plus';
import { useSessionStore } from '@wise/stores';
import { errorTextOf } from '@wise/ui';

/**
 * 登录屏 —— **纯展示 + 表单**。
 *
 * 它自己不碰桥：验证码、登录、会话判定全在 `useSessionStore` 里
 * （由 `check:store` 静态保证）。这样"验证码一次性、失败必换一张"
 * 这类流程规则只有一处实现，别的入口能直接复用。
 *
 * 三条不变量：
 *   1. `captchaImage` 是后端给的 `data:image/png;base64,…`，直接塞 `<img>`；
 *   2. `auth.login` 的响应里**不会再有令牌**（桥已截留，见 docs/w3-session.md）；
 *   3. 登录态只认 `bridge.session`，前端不自己记布尔。
 */
const session = useSessionStore();
const router = useRouter();

const username = ref('');
const password = ref('');
const captchaCode = ref('');

const canSubmit = computed(
  () => username.value.trim() !== '' && password.value !== '' && captchaCode.value.trim() !== '' && !session.signingIn,
);

const captchaMessage = computed(() =>
  session.captchaError ? errorTextOf(session.captchaError, '验证码加载失败') : undefined,
);
const signInMessage = computed(() => (session.signInError ? errorTextOf(session.signInError, '登录失败') : undefined));

/**
 * 验证码字段的错误态用整块 `v-bind`。
 *
 * Element Plus 的 `error` 属性不接受 `undefined`，而本项目开着
 * `exactOptionalPropertyTypes`，`:error="maybeUndefined"` 会被类型系统拦下。
 */
const captchaFieldProps = computed<Record<string, string>>(() =>
  captchaMessage.value === undefined ? {} : { error: captchaMessage.value },
);

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  const ok = await session.signIn({
    username: username.value.trim(),
    password: password.value,
    captchaCode: captchaCode.value.trim(),
  });
  captchaCode.value = '';
  if (ok) {
    await router.replace({ name: 'home' });
  }
}

onMounted(() => {
  void session.loadCaptcha();
});
</script>

<template>
  <main class="w-login">
    <section class="w-login__panel">
      <div class="w-login__brand">
        <span class="w-login__mark" aria-hidden="true">W</span>
        <div>
          <div class="w-login__name">慧仓智控</div>
          <div class="w-login__sub">WISEDEPOT 仓储作业平台</div>
        </div>
      </div>
      <p class="w-login__hint">请使用仓库账号登录。登录凭证由应用安全保存，不会显示在页面上。</p>
    </section>

    <section class="w-login__card">
      <h1 class="w-login__title">登录</h1>
      <ElForm label-position="top" @submit.prevent>
        <ElFormItem label="账号">
          <ElInput v-model="username" size="large" placeholder="请输入账号" autocomplete="username" />
        </ElFormItem>
        <ElFormItem label="密码">
          <ElInput v-model="password" size="large" type="password" show-password placeholder="请输入密码" autocomplete="current-password" />
        </ElFormItem>
        <ElFormItem label="验证码" v-bind="captchaFieldProps">
          <div class="w-login__captcha">
            <img
              v-if="session.captcha?.captchaImage"
              class="w-login__captcha-img"
              :src="session.captcha.captchaImage"
              alt="验证码"
            />
            <div v-else class="w-login__captcha-img w-login__captcha-img--empty" aria-hidden="true" />
            <ElButton size="large" text :disabled="session.signingIn" @click="session.loadCaptcha">换一张</ElButton>
            <ElInput v-model="captchaCode" size="large" class="w-login__captcha-input" placeholder="验证码" autocomplete="off" />
          </div>
        </ElFormItem>
      </ElForm>

      <p v-if="signInMessage" class="w-login__error" role="alert">{{ signInMessage }}</p>

      <ElButton
        type="primary"
        size="large"
        class="w-login__submit"
        :disabled="!canSubmit"
        :loading="session.signingIn"
        @click="submit"
      >
        {{ session.signingIn ? '登录中…' : '登录' }}
      </ElButton>
    </section>
  </main>
</template>

<style scoped>
.w-login {
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(320px, 400px);
  gap: var(--w-space-section-gap);
  align-items: center;
  justify-content: center;
  /* 固定高度 + 内部滚动：整页不滚，登录卡片在小屏上自己滚。
     用 flex 占剩余高度而不是 height:100%（横幅会占掉一行，见 shell.css 的说明） */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--w-space-section-gap);
}

.w-login__panel {
  background: var(--w-brand-bg);
  color: var(--w-brand-fg);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-section-gap);
}

.w-login__brand {
  display: flex;
  align-items: center;
  gap: var(--w-space-row-gap);
}

.w-login__mark {
  display: grid;
  place-items: center;
  width: var(--w-space-touch-target-min);
  height: var(--w-space-touch-target-min);
  border-radius: var(--w-radius-control);
  background: var(--w-color-brand-mark);
  color: var(--w-brand-bg);
  font-weight: 700;
}

.w-login__name {
  font-size: var(--w-type-page-title-size);
  font-weight: var(--w-type-page-title-weight);
}

.w-login__sub {
  font-size: var(--w-type-body-small-size);
  color: var(--w-brand-fg-muted);
  letter-spacing: 0.04em;
}

.w-login__hint {
  margin: var(--w-space-section-gap) 0 0;
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
  color: var(--w-brand-fg-muted);
}

.w-login__card {
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

.w-login__title {
  margin: 0 0 var(--w-space-group-gap);
  font-size: var(--w-type-page-title-size);
  line-height: var(--w-type-page-title-line);
  font-weight: var(--w-type-page-title-weight);
}

.w-login__captcha {
  display: flex;
  align-items: center;
  gap: var(--w-space-inline-gap);
  width: 100%;
}

.w-login__captcha-img {
  width: var(--w-size-captcha-width);
  height: var(--w-density-control-height);
  border-radius: var(--w-radius-control);
  border: 1px solid var(--w-color-outline);
  object-fit: cover;
  background: var(--w-color-surface-alt);
}

.w-login__captcha-img--empty {
  display: block;
}

.w-login__captcha-input {
  flex: 1;
}

.w-login__error {
  margin: 0 0 var(--w-space-group-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}

.w-login__submit {
  width: 100%;
}

/* 手机：单列，品牌区收成一条 */
@media (max-width: 840px) {
  .w-login {
    grid-template-columns: minmax(0, 420px);
    align-content: start;
    padding: var(--w-space-screen-h);
  }

  .w-login__panel {
    padding: var(--w-space-card-padding);
  }
}
</style>
