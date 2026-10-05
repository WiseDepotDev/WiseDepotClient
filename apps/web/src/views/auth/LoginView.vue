<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton, ElForm, ElFormItem, ElInput } from 'element-plus';
import { useSessionStore } from '@wise/stores';
import { errorTextOf } from '@wise/ui';
import HumanVerifyField from '../../components/HumanVerifyField.vue';
import { useHumanVerify } from '../../components/useHumanVerify.js';

/**
 * 登录屏 —— **纯展示 + 表单**。
 *
 * 它自己不碰桥：登录、会话判定全在 `useSessionStore` 里（由 `check:store` 静态保证）；
 * 人机验证走 `useHumanVerify`（它调的是桥的**内建方法** `bridge.humanVerify`，
 * 票据留在桥里，页面拿不到也不需要知道）。
 *
 * 三条不变量：
 *   1. 登录前必须**先过验证**（点按钮完成，零输入；图形验证码已整体删除）；
 *   2. `auth.login` 的响应里**不会再有令牌**（桥已截留，见 docs/w3-session.md）；
 *   3. 登录态只认 `bridge.session`，前端不自己记布尔。
 */
const session = useSessionStore();
const router = useRouter();
const humanVerify = useHumanVerify();

const username = ref('');
const password = ref('');

const canSubmit = computed(() => username.value.trim() !== '' && password.value !== '' && !session.signingIn);

const signInMessage = computed(() => (session.signInError ? errorTextOf(session.signInError, '登录失败') : undefined));

/**
 * 会话过期后被踢回登录屏时，**必须说明为什么**。
 *
 * 不说的话，用户看到的就是"我正在填单子，忽然跳回登录页了" —— 第一反应是系统坏了或自己点错了。
 * 判据用会话里的 `expired`（桥给的），不是前端自己猜的布尔。
 */
const expiredNotice = computed(() =>
  session.expired ? '登录已过期，请重新登录。刚才那一步没有提交，重新登录后可以再来一次。' : undefined,
);

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  /*
   * 顺序不能换：**先人机验证，再登录**。
   *
   * 反过来的话，服务端会先拒掉这次登录（没有票据），然后用户还得再点一次验证 ——
   * 一次操作变成两次，而且第一次的失败信息完全没意义。
   *
   * 验证没过就直接返回：不发那个注定被拒的登录请求（省一次往返，也省一条误导性的错误）。
   */
  const verified = await humanVerify.verify('LOGIN', username.value.trim());
  if (!verified.ok) {
    return;
  }
  const ok = await session.signIn({
    username: username.value.trim(),
    password: password.value,
  });
  if (ok) {
    await router.replace({ name: 'home' });
    return;
  }
  // 登录失败（密码错/账号锁定）⇒ 票据已经用掉了，下一次必须重新验证
  humanVerify.reset();
}
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
      <!-- 被踢回来时先说清原因，再让人填表 -->
      <p v-if="expiredNotice" class="w-login__expired" role="status">{{ expiredNotice }}</p>
      <ElForm label-position="top" @submit.prevent>
        <ElFormItem label="账号">
          <ElInput v-model="username" size="large" placeholder="请输入账号" autocomplete="username" />
        </ElFormItem>
        <ElFormItem label="密码">
          <ElInput v-model="password" size="large" type="password" show-password placeholder="请输入密码" autocomplete="current-password" />
        </ElFormItem>
        <ElFormItem label="人机验证">
          <!--
            替代图形验证码：**零输入**。点一下由桥去完成"本地环境证据 + 服务端票据"，
            页面既不渲染图片，也不持有票据（票据在桥里）。
          -->
          <HumanVerifyField :state="humanVerify" purpose="LOGIN" :username="username.trim()" />
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
/* 会话过期提示：用警告色而不是错误色 —— 过期不是用户做错了什么 */
.w-login__expired {
  margin: 0 0 var(--w-space-group-gap);
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-warning-text);
  background: var(--w-state-warning-fill);
  color: var(--w-state-warning-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}
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
