<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElInput } from 'element-plus';
import type { BridgeErrorLike } from '@wise/stores';
import { humanize, roleLabel, shortTime, useMutation, useResource } from '@wise/stores';
import { ConfirmDialog, PageHeader, SectionBlock, StateHost } from '@wise/ui';

/**
 * 个人设置（`profile.get` 域）—— 一屏里三块取数、三个写操作。
 * 语义逐条对齐 `packages/features/src/me/ProfileScreen.tsx`（476 行）。
 *
 * ## 三条从 React 版带过来的决定（都对应踩过的坑，不是新设计）
 *
 * 1. **三块数据各自独立三态**：基本资料（`profile.get`）、登录账号（`user.current`）、
 *    偏好设置（`profile.settings`）各有一张卡、各自 loading / error / empty / 内容。
 *    把三份数据揉进一个状态机会让"某一项取不到"变成"整屏打不开"。
 * 2. **三个写操作各自有独立的错误与成功反馈**，绝不合并：
 *    · 改资料（`profile.update` → 「资料已更新。」）
 *    · 改偏好（`profile.settingsUpdate` → 「偏好设置已保存，下面显示的是保存后的结果。」）
 *    · 改登录密码（`user.changePassword` → 「登录密码已更新，下次登录请用新密码。」）
 *    合并之后，用户改完密码会看到一句来自"改昵称"的提示 —— 属于无法排查的误导。
 * 3. **改密码单独成区并二次确认**：它是本屏唯一会影响下次登录的动作，
 *    不能让它在表单里和"改昵称"长得一样（ui-spec §3.1 危险操作必须二次确认）。
 *
 * ## 两条刻意的取舍
 *
 *  · **偏好设置只允许改系统下发的项**，不给"新增一项"的入口 ——
 *    增量当前不落库，摆一个点了不生效的输入框比不摆更糟；
 *  · `profile.update` 只提交 `{ nickname, email }`：React 版就这两个字段
 *    （"姓名与邮箱都要填写"是**本屏自己的**约定，服务端对这两个字段没有必填注解）。
 *
 * 本屏不做的（服务端有、React 屏没用）：头像上传/删除/取图 —— 见简报非目标。
 */
interface ProfileData {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
  readonly email?: string;
  readonly gender?: number;
  readonly status?: number;
  readonly createTime?: string;
  readonly updateTime?: string;
}

interface CurrentUser {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly role?: string;
  readonly createdAt?: string;
}

interface SettingsData {
  readonly userId?: number;
  readonly settings?: Readonly<Record<string, string>>;
}

interface PasswordForm {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

/**
 * 偏好项的键 → 业务叫法；**没登记过的键原样显示**（它是服务端下发的数据，
 * 不是我们的文案，硬翻会翻错）。与 React 版逐字相同。
 */
const SETTING_LABELS: Readonly<Record<string, string>> = {
  nickname: '昵称',
  language: '界面语言',
  theme: '界面主题',
  notification: '消息提醒',
  sound: '提示音',
};

function settingLabel(key: string): string {
  return SETTING_LABELS[key] ?? key;
}

/** 性别码：只认 1/2（服务端的口径），其余一律"未填写"，不猜。 */
function genderLabel(gender: number | undefined): string {
  switch (gender) {
    case 1:
      return '男';
    case 2:
      return '女';
    default:
      return '未填写';
  }
}

/** 角色码 → 业务叫法。实现与账号块、用户管理共用一份（`@wise/stores` 的 `roleLabel`）。 */
function roleTextOf(role: string | null | undefined): string {
  return roleLabel(role) ?? '未指派角色';
}

/** 明细里那句"能不能登录"的说法：与 React 版逐字相同。 */
function loginText(enabled: boolean | undefined): string {
  if (enabled === true) {
    return '已启用，可登录';
  }
  if (enabled === false) {
    return '已停用，无法登录';
  }
  return '状态未知';
}

/**
 * 改密码的提交前校验：**消息文案就是用户看到的提示**，先把话想清楚再写代码。
 * 三条文案与 React 版逐字相同（顺序也一样：先"没填"、再"太短"、最后"不一致"）。
 */
function passwordProblem(form: PasswordForm): string | undefined {
  if (!form.oldPassword) {
    return '请先填写当前正在用的密码';
  }
  if (form.newPassword.length < 6) {
    return '新密码至少 6 位';
  }
  if (form.newPassword !== form.confirm) {
    return '两次输入的新密码不一致';
  }
  return undefined;
}

/* ------------------------------------------------- 基本资料：改昵称与邮箱 */

const editing = ref(false);
const form = ref({ nickname: '', email: '' });
const profileError = ref<string | undefined>(undefined);
const profileNotice = ref<string | undefined>(undefined);

/* ------------------------------------------------------- 偏好设置：改取值 */

/**
 * `undefined` = 只看不改；有值 = 正在改的草稿。
 *
 * 草稿是从 `profile.settings` 拿到的 map **派生**的（提交时也原样把整份 map 发回去），
 * 所以"只改一项"不会把其它项弄丢。
 */
const prefDraft = ref<Record<string, string> | undefined>(undefined);
const prefError = ref<string | undefined>(undefined);
const prefNotice = ref<string | undefined>(undefined);

/* ----------------------------------------------------------- 登录密码 */

const password = ref<PasswordForm>({ oldPassword: '', newPassword: '', confirm: '' });
const pwConfirming = ref(false);
const pwError = ref<string | undefined>(undefined);
const pwNotice = ref<string | undefined>(undefined);

/* --------------------------------------------------------------- 取数 */

const profile = useResource<ProfileData>('profile.get');
const me = useResource<CurrentUser>('user.current');
const settings = useResource<SettingsData>('profile.settings');

/** 服务端没给偏好项时给一份空表：`Object.entries` 不接受 undefined。 */
const settingsMap = computed<Readonly<Record<string, string>>>(() => settings.data.value?.settings ?? {});
const prefEntries = computed<readonly (readonly [string, string])[]>(() => Object.entries(settingsMap.value));
const draftEntries = computed<readonly (readonly [string, string])[]>(() =>
  prefDraft.value === undefined ? [] : Object.entries(prefDraft.value),
);

/**
 * 刷新：三块一起重来。
 *
 * 三块分别属于 `profile.*` 与 `user.*` 两个前缀，写操作的缓存失效各自覆盖得到，
 * 但"改完资料要不要把登录账号也重取"没有确定的答案 —— 这里照 React 版一起刷新，
 * 数据一致优先于省一次请求。
 */
function reloadAll(): void {
  profile.reload();
  me.reload();
  settings.reload();
}

/* ------------------------------------------------------------- 写操作 */

const profileMutation = useMutation<unknown>('profile.update');
const prefMutation = useMutation<unknown>('profile.settingsUpdate');
const pwMutation = useMutation<unknown>('user.changePassword');

/**
 * 提交资料修改：`{ nickname, email }`。
 * 成功后有专门的**成功话术**（不是"操作成功"），并把「资料已更新。」
 * 放回工具条上 —— 表单这时已经收起了，否则用户看不到自己刚做的事留下了什么。
 */
async function submitProfile(): Promise<void> {
  const f = form.value;
  if (!f.nickname.trim() || !f.email.trim()) {
    profileError.value = '姓名与邮箱都要填写';
    return;
  }
  profileError.value = undefined;
  profileNotice.value = undefined;
  try {
    await profileMutation.run({ nickname: f.nickname.trim(), email: f.email.trim() });
    editing.value = false;
    profileNotice.value = '资料已更新。';
    reloadAll();
  } catch (e) {
    profileError.value = humanize(e as BridgeErrorLike);
  }
}

function openEdit(): void {
  profileError.value = undefined;
  profileNotice.value = undefined;
  form.value = { nickname: profile.data.value?.nickname ?? '', email: profile.data.value?.email ?? '' };
  editing.value = true;
}

function cancelEdit(): void {
  profileError.value = undefined;
  editing.value = false;
}

/**
 * 保存偏好：把整份草稿（`Record<string, string>`）作为 `settings` 提交。
 * 草稿为 `undefined`（没在改）时什么也不做 —— 按钮本来就不在那条分支上，这里再兜一次。
 */
async function submitPrefs(): Promise<void> {
  const draft = prefDraft.value;
  if (draft === undefined) {
    return;
  }
  prefError.value = undefined;
  prefNotice.value = undefined;
  try {
    await prefMutation.run({ settings: draft });
    prefDraft.value = undefined;
    prefNotice.value = '偏好设置已保存，下面显示的是保存后的结果。';
    settings.reload();
  } catch (e) {
    prefError.value = humanize(e as BridgeErrorLike);
  }
}

/** 进入编辑：草稿必须是**当前一份**的拷贝，直接改 `settingsMap` 会把服务端数据也改掉。 */
function openPrefs(): void {
  prefError.value = undefined;
  prefNotice.value = undefined;
  prefDraft.value = { ...settingsMap.value };
}

/**
 * 草稿内单项改值。
 *
 * 不用 `v-model="prefDraft[key]"`：`prefDraft` 的类型带 `| undefined`
 * （`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 下索引写入会被拦），
 * 而这里本来就需要"没在改就什么也不做"这层兜底。
 */
function updatePref(key: string, value: string): void {
  const draft = prefDraft.value;
  if (draft === undefined) {
    return;
  }
  prefDraft.value = { ...draft, [key]: value };
}

function cancelPrefs(): void {
  prefError.value = undefined;
  prefDraft.value = undefined;
}

/**
 * 打开改密码的二次确认。
 *
 * 本地校验放在**打开之前**：不通过就连确认框都不弹，直接把话说在按钮下面 ——
 * 否则用户要先点一次"确认修改"才知道自己少填了东西。
 */
function askPasswordChange(): void {
  pwError.value = undefined;
  pwNotice.value = undefined;
  const problem = passwordProblem(password.value);
  if (problem) {
    pwError.value = problem;
    return;
  }
  pwConfirming.value = true;
}

/**
 * 改登录密码：`{ oldPassword, newPassword }`，**不带 userId**
 * （服务端走 `/api/users/current/password`，认的是当前登录态）。
 * 成功后清空三个输入框，避免密码留在屏幕上。
 */
async function submitPassword(): Promise<void> {
  const problem = passwordProblem(password.value);
  if (problem) {
    pwConfirming.value = false;
    pwError.value = problem;
    return;
  }
  pwError.value = undefined;
  pwNotice.value = undefined;
  try {
    await pwMutation.run({
      oldPassword: password.value.oldPassword,
      newPassword: password.value.newPassword,
    });
    pwConfirming.value = false;
    password.value = { oldPassword: '', newPassword: '', confirm: '' };
    pwNotice.value = '登录密码已更新，下次登录请用新密码。';
  } catch (e) {
    pwError.value = humanize(e as BridgeErrorLike);
  }
}

/**
 * Element Plus 的属性整块给、且放宽成 `any`。
 *
 * `ElInput` 这批组件的 `buildProps` 结果类型在 `vue-tsc` 下解不开，逐属性写会被当成
 * "属性定义对象"校验而报错。运行期完全一样 —— 这是**类型层绕行**，不是行为差异。
 */
function anyProps(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}
</script>

<template>
  <div class="w-page">
    <PageHeader title="个人资料" note="账号信息、联系方式与安全设置">
      <template #actions>
        <ElButton
          size="large"
          :loading="profile.loading.value || me.loading.value || settings.loading.value"
          @click="reloadAll"
        >
          刷新
        </ElButton>
      </template>
    </PageHeader>

    <!-- 基本资料：`profile.get` 一条取数、一张卡、一套三态 -->
    <SectionBlock title="基本资料">
      <div class="w-me-profile__card">
        <StateHost
          :loading="profile.loading.value"
          :error="profile.error.value ?? null"
          :error-text="profile.error.value ? humanize(profile.error.value) : undefined"
          :empty="profile.data.value === undefined"
          empty-text="资料暂时取不到。点右上角「刷新」再试一次；如果一直这样，请联系管理员。"
          skeleton="detail"
          @retry="profile.reload"
        >
          <dl class="w-me-profile__kv">
            <dt class="w-me-profile__kvlabel">账号</dt>
            <dd class="w-me-profile__kvvalue">
              <span class="w-mono">{{ profile.data.value?.username ?? '未记录' }}</span>
            </dd>
            <dt class="w-me-profile__kvlabel">姓名</dt>
            <dd class="w-me-profile__kvvalue">{{ profile.data.value?.nickname ?? '未填写' }}</dd>
            <dt class="w-me-profile__kvlabel">邮箱</dt>
            <dd class="w-me-profile__kvvalue">{{ profile.data.value?.email ?? '未填写' }}</dd>
            <dt class="w-me-profile__kvlabel">性别</dt>
            <dd class="w-me-profile__kvvalue">{{ genderLabel(profile.data.value?.gender) }}</dd>
            <dt class="w-me-profile__kvlabel">注册时间</dt>
            <dd class="w-me-profile__kvvalue">
              <span class="w-mono">{{ shortTime(profile.data.value?.createTime) || '时间未记录' }}</span>
            </dd>
            <dt class="w-me-profile__kvlabel">最近更新</dt>
            <dd class="w-me-profile__kvvalue">
              <span class="w-mono">{{ shortTime(profile.data.value?.updateTime) || '无记录' }}</span>
            </dd>
          </dl>
        </StateHost>
      </div>
    </SectionBlock>

    <!-- 登录账号：另一条取数（`user.current`），独立三态 -->
    <SectionBlock title="登录账号">
      <div class="w-me-profile__card">
        <StateHost
          :loading="me.loading.value"
          :error="me.error.value ?? null"
          :error-text="me.error.value ? humanize(me.error.value) : undefined"
          :empty="me.data.value === undefined"
          empty-text="登录信息暂时取不到。点右上角「刷新」再试一次。"
          skeleton="detail"
          @retry="me.reload"
        >
          <dl class="w-me-profile__kv">
            <dt class="w-me-profile__kvlabel">登录账号</dt>
            <dd class="w-me-profile__kvvalue">
              <span class="w-mono">{{ me.data.value?.username ?? '未记录' }}</span>
            </dd>
            <dt class="w-me-profile__kvlabel">角色</dt>
            <dd class="w-me-profile__kvvalue">{{ roleTextOf(me.data.value?.role) }}</dd>
            <dt class="w-me-profile__kvlabel">账号状态</dt>
            <dd class="w-me-profile__kvvalue">{{ loginText(me.data.value?.enabled) }}</dd>
            <dt class="w-me-profile__kvlabel">创建时间</dt>
            <dd class="w-me-profile__kvvalue">
              <span class="w-mono">{{ shortTime(me.data.value?.createdAt) || '时间未记录' }}</span>
            </dd>
          </dl>
        </StateHost>
      </div>
    </SectionBlock>

    <!-- 修改资料：就地展开（与 React 版一致），错误就地说、成功在工具条上说 -->
    <SectionBlock v-if="editing" title="修改资料">
      <div class="w-me-profile__card">
        <div class="w-me-profile__field">
          <label class="w-me-profile__label" for="w-me-profile-nickname">姓名 *</label>
          <ElInput
            id="w-me-profile-nickname"
            v-model="form.nickname"
            v-bind="anyProps({ size: 'large', placeholder: '显示给同事看的名字' })"
          />
        </div>
        <div class="w-me-profile__field">
          <label class="w-me-profile__label" for="w-me-profile-email">邮箱 *</label>
          <ElInput
            id="w-me-profile-email"
            v-model="form.email"
            v-bind="anyProps({ size: 'large', placeholder: '如：name@example.com' })"
          />
        </div>

        <p v-if="profileError" class="w-me-profile__error" role="alert">{{ profileError }}</p>

        <div class="w-toolbar">
          <ElButton size="large" @click="cancelEdit">取消</ElButton>
          <ElButton
            size="large"
            type="primary"
            :disabled="profileMutation.pending.value"
            :loading="profileMutation.pending.value"
            @click="submitProfile"
          >
            保存
          </ElButton>
        </div>
      </div>
    </SectionBlock>

    <div v-else class="w-toolbar">
      <ElButton size="large" @click="openEdit">修改资料</ElButton>
      <span v-if="profileNotice" class="w-me-profile__muted" role="status">{{ profileNotice }}</span>
    </div>

    <!-- 偏好设置：第三条取数（`profile.settings`），预览与编辑是同一条分支的两态 -->
    <SectionBlock title="偏好设置">
      <div class="w-me-profile__card">
        <!-- 正在改：每一项一个输入框，草稿是从服务端下发的那份 map 派生的 -->
        <template v-if="prefDraft !== undefined">
          <div v-for="[key, value] in draftEntries" :key="key" class="w-me-profile__field">
            <label class="w-me-profile__label" :for="`w-me-profile-pref-${key}`">{{ settingLabel(key) }}</label>
            <ElInput
              :id="`w-me-profile-pref-${key}`"
              :model-value="value"
              v-bind="anyProps({ size: 'large', placeholder: '输入新的取值' })"
              @update:model-value="(v: string) => updatePref(key, v)"
            />
          </div>

          <p v-if="prefError" class="w-me-profile__error" role="alert">{{ prefError }}</p>

          <div class="w-toolbar">
            <ElButton size="large" @click="cancelPrefs">取消</ElButton>
            <ElButton
              size="large"
              type="primary"
              :disabled="prefMutation.pending.value"
              :loading="prefMutation.pending.value"
              @click="submitPrefs"
            >
              保存
            </ElButton>
          </div>
        </template>

        <!-- 只看不改：逐项铺开 + 「修改偏好」入口 -->
        <template v-else>
          <StateHost
            :loading="settings.loading.value"
            :error="settings.error.value ?? null"
            :error-text="settings.error.value ? humanize(settings.error.value) : undefined"
            :empty="prefEntries.length === 0"
            empty-text="系统还没有给这个账号下发偏好项。需要调整时请联系管理员。"
            skeleton="card"
            @retry="settings.reload"
          >
            <dl class="w-me-profile__kv">
              <template v-for="[key, value] in prefEntries" :key="key">
                <dt class="w-me-profile__kvlabel">{{ settingLabel(key) }}</dt>
                <dd class="w-me-profile__kvvalue">{{ value }}</dd>
              </template>
            </dl>
          </StateHost>

          <p v-if="prefError" class="w-me-profile__error" role="alert">{{ prefError }}</p>
          <p v-if="prefNotice" class="w-me-profile__hint" role="status">{{ prefNotice }}</p>

          <div class="w-toolbar">
            <ElButton
              size="large"
              :disabled="prefEntries.length === 0"
              :loading="settings.loading.value"
              @click="openPrefs"
            >
              修改偏好
            </ElButton>
            <span class="w-me-profile__hint">只列出系统下发的项，改完保存即可生效。</span>
          </div>
        </template>
      </div>
    </SectionBlock>

    <!-- 登录密码：本屏唯一影响下次登录的动作，单独成区并二次确认 -->
    <SectionBlock title="登录密码">
      <div class="w-me-profile__card">
        <p class="w-me-profile__hint">改密码只影响本账号的登录。请把新密码记牢 —— 忘记后需要管理员协助重置。</p>

        <div class="w-me-profile__field">
          <label class="w-me-profile__label" for="w-me-profile-oldpw">当前密码 *</label>
          <ElInput
            id="w-me-profile-oldpw"
            v-model="password.oldPassword"
            v-bind="anyProps({ size: 'large', type: 'password', placeholder: '正在使用的密码' })"
          />
        </div>
        <div class="w-me-profile__field">
          <label class="w-me-profile__label" for="w-me-profile-newpw">新密码 *</label>
          <ElInput
            id="w-me-profile-newpw"
            v-model="password.newPassword"
            v-bind="anyProps({ size: 'large', type: 'password', placeholder: '至少 6 位' })"
          />
        </div>
        <div class="w-me-profile__field">
          <label class="w-me-profile__label" for="w-me-profile-confirmpw">再输一次新密码 *</label>
          <ElInput
            id="w-me-profile-confirmpw"
            v-model="password.confirm"
            v-bind="anyProps({ size: 'large', type: 'password', placeholder: '确认用' })"
          />
        </div>

        <p v-if="pwError" class="w-me-profile__error" role="alert">{{ pwError }}</p>
        <p v-if="pwNotice" class="w-me-profile__hint" role="status">{{ pwNotice }}</p>

        <div class="w-toolbar">
          <ElButton
            size="large"
            type="danger"
            :disabled="pwMutation.pending.value"
            :loading="pwMutation.pending.value"
            @click="askPasswordChange"
          >
            修改登录密码
          </ElButton>
        </div>
      </div>
    </SectionBlock>

    <ConfirmDialog
      :show="pwConfirming"
      title="修改登录密码"
      :danger="true"
      confirm-text="确认修改"
      :pending="pwMutation.pending.value"
      @confirm="submitPassword"
      @cancel="pwConfirming = false"
    >
      <p class="w-me-profile__confirm">确认把当前登录密码换成新的吗？换好之后请用新密码登录。</p>
      <p v-if="pwError" class="w-me-profile__error" role="alert">{{ pwError }}</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* 卡片：三块数据与三个表单共用同一形状，与同域其它屏同形 */
.w-me-profile__card {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

/*
 * 键值对用 grid 而不是纵向堆叠：标签列宽固定，值列**允许换行**
 * （邮箱、时间这类值在窄屏下必须能折行，否则整页会横向滚动）。
 */
.w-me-profile__kv {
  display: grid;
  grid-template-columns: var(--w-size-kv-label-width) 1fr;
  gap: var(--w-space-inline-gap);
  margin: 0;
}

.w-me-profile__kvlabel {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-me-profile__kvvalue {
  margin: 0;
  color: var(--w-color-on-surface);
  overflow-wrap: anywhere;
}

.w-me-profile__field {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  width: 100%;
}

.w-me-profile__label {
  font-size: var(--w-type-label-size);
  font-weight: var(--w-type-label-weight);
  color: var(--w-color-on-surface-variant);
}

.w-me-profile__muted {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-me-profile__hint {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-me-profile__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
}

.w-me-profile__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
