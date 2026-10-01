<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElInput } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import type { BridgeErrorLike } from '@wise/stores';
import { asList, asTotal, humanize, roleLabel, shortTime, useMutation, useResource, useResourceCacheStore } from '@wise/stores';
import { ActionDock, ConfirmDialog, PageHeader, SectionBlock, StateHost, StatusChip, type StatusTone } from '@wise/ui';
import CaptchaField from '../../components/CaptchaField.vue';
import { useCaptcha } from '../../components/useCaptcha';

/**
 * 用户管理（`user.list` 域）—— 一屏里同时是**列表**与**明细**。
 * 语义逐条对齐 `packages/features/src/me/UserListScreen.tsx`（534 行）。
 *
 * ## 五条从 React 版带过来的决定（都对应踩过的坑，不是新设计）
 *
 * 1. **分页在服务端是 1 基**：真后端 `UserApplicationService#listUsers` 里先
 *    `if (page == null || page < 1) page = 1;`，再 `PageRequest.of(page - 1, size)` ——
 *    所以界面上的"第 N 页"**原样发 `page: N`**，不要减 1。
 *    （消息中心是 0 基、要发 `page - 1`，两者口径不同，别顺手统一。）
 * 2. **明细与角色是另外两条取数**，只有选中了某一行才有用户编号：
 *    没选中就发请求只会换来一次没有意义的失败。所以明细块整块挂在
 *    `selected !== undefined` 之下，并且两条取数都带 `enabled` 兜底。
 * 3. **删除与重置密码都放在明细块里，不在行内塞小按钮**（React 也是这么放的）：
 *    行内小按钮在手机上点不中，而且这两个动作都该"先看清是谁，再动手"。
 * 4. **删除必须先有验证码**（`user.deleteWithCaptcha` 要 `captchaId` + `captchaCode`）——
 *    与标签批量绑定是同一套机制（同款 `CaptchaField` + `useCaptcha`）。
 *    验证码是**一次性**的：失败必须换一张，否则用户会对着作废的图反复提交。
 * 5. **建号表单里没有"角色"字段**：建号接口当前不接受角色，摆一个点了不生效的选项比不摆更糟。
 *    角色分配（授予/撤销）不在本次范围内，明细里只做**只读**展示。
 *
 * ## 两处刻意的取舍
 *
 *  · **关键字只筛已取回的这一页**（`user.list` 没有关键字参数），所以工具条上必须写清
 *    「筛选本页」，否则用户会把"这一页里没有"读成"整个系统里没有"；
 *  · 本屏用 `StateHost` + **自绘的用户卡片**，而不是 `ResponsiveDataView`：
 *    React 版的行尾是"已启用 / 已停用"芯片、并且在点行时切换选中态 ——
 *    自绘卡片让"选中"一处可见（描边变色），也避免表格把芯片挤成第三列文字。
 *    卡片本身是纵向布局 + `flex-wrap`，窄屏下不会横向溢出。
 */
interface UserRow {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly role?: string;
  readonly createdAt?: string;
}

interface RoleRow {
  readonly roleId?: number;
  readonly name?: string;
  readonly roleCode?: string;
}

interface CreateForm {
  username: string;
  nickname: string;
  password: string;
  email: string;
}

interface PasswordForm {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

const PAGE_SIZE = 20;

const cache = useResourceCacheStore();

const page = ref(1);
const keyword = ref('');
const applied = ref('');
const selected = ref<number | undefined>(undefined);

const creating = ref(false);
const form = ref<CreateForm>({ username: '', nickname: '', password: '', email: '' });

/**
 * 列表上的取数错误**不放进**这些字段：`StateHost` 已经把"这一页读不到"讲清楚了
 * （还带重试按钮）。这里只留"动作失败"的话，否则同一件事会有两处不同说法。
 */
const actionError = ref<string | undefined>(undefined);

/** 服务端对没填的字段可能回 `null`，字符串方法之前一律归一。 */
function textOf(value: string | null | undefined): string {
  return value ?? '';
}

/** 角色码 → 业务叫法。实现与账号块共用一份（`@wise/stores` 的 `roleLabel`）。 */
function roleTextOf(role: string | null | undefined): string {
  return roleLabel(role) ?? '未指派角色';
}

/** 账号状态芯片：三态（已启用 / 已停用 / 状态未知），语气与 React 版一致。 */
function statusChip(enabled: boolean | undefined): { text: string; tone: StatusTone } {
  if (enabled === true) {
    return { text: '已启用', tone: 'success' };
  }
  if (enabled === false) {
    return { text: '已停用', tone: 'neutral' };
  }
  return { text: '状态未知', tone: 'neutral' };
}

/** 明细里那句"能不能登录"的说法：与 React 版逐字相同，不是状态芯片的复述。 */
function loginText(enabled: boolean | undefined): string {
  if (enabled === true) {
    return '已启用，可登录';
  }
  if (enabled === false) {
    return '已停用，无法登录';
  }
  return '状态未知';
}

/** 用户序号缺失时用它做键与显示兜底（列表里总还有账号名）。 */
function rowKeyOf(row: UserRow): string {
  return String(row.userId ?? row.username ?? '');
}

function roleKeyOf(row: RoleRow): string {
  return String(row.roleId ?? row.name ?? row.roleCode ?? '');
}

/**
 * 列表参数：**1 基分页，直接发 `page`**（见文件头第 1 条）。
 * `size` 是用户列表唯一认的参数名（默认 10，这里每页 20）。
 */
const listParams = computed(() => ({ page: page.value, size: PAGE_SIZE }));
const list = useResource<unknown>('user.list', listParams);

const all = computed(() => asList<UserRow>(list.data.value));
const total = computed(() => asTotal(list.data.value));

/**
 * 本页可见行。关键字是**本地过滤**，口径照抄 React：
 * 账号 + 姓名 + 邮箱拼起来匹配，大小写不敏感。
 */
const rows = computed(() =>
  applied.value === ''
    ? all.value
    : all.value.filter((row) =>
        `${textOf(row.username)}${textOf(row.nickname)}${textOf(row.email)}`
          .toLowerCase()
          .includes(applied.value.toLowerCase()),
      ),
);

/**
 * 还有没有下一页。
 *
 * `user.list` 回的是 `UserPageDTO { total, items }`，所以优先用总数判断；
 * 拿不到总数（服务端变了形状）就退回"这一页是否满员"。
 * `all.length > 0` 那半句是必需的：空列表不该让"下一页"亮着。
 */
const hasMore = computed(() => {
  const t = total.value;
  return t !== undefined ? page.value * PAGE_SIZE < t : all.value.length > 0 && all.value.length === PAGE_SIZE;
});

const pageNote = computed(() =>
  total.value !== undefined ? `共 ${total.value} 位用户` : '维护账号与基础资料',
);
const listTitle = computed(() => `用户列表${applied.value !== '' ? `（含「${applied.value}」）` : ''}`);

/** 空态要讲清"为什么空"：还没有用户 vs 被关键字筛掉，是两件事、两条出路。 */
const emptyText = computed(() =>
  applied.value !== ''
    ? '没有匹配的用户，试试换个关键词。'
    : '还没有用户。点右上角「新增」创建第一个账号，之后再分配角色与权限。',
);

const createMutation = useMutation<unknown>('user.create');
const deleting = ref(false);
const resetting = ref(false);
const deleteMutation = useMutation<unknown>('user.deleteWithCaptcha');
const resetMutation = useMutation<unknown>('user.resetPassword');
const busy = computed(
  () => createMutation.pending.value || deleteMutation.pending.value || resetMutation.pending.value,
);

const password = ref<PasswordForm>({ oldPassword: '', newPassword: '', confirm: '' });

/**
 * 删除框里的验证码。
 *
 * `captchaId` 从 `captcha.captcha.value` 里取（服务端下发的那一张），
 * 空串表示"图还没拿到"—— 真后端会拿它去校验会话里那次验证码，
 * 所以**没拿到图就不该提交**（按钮旁与提交前后各挡一次）。
 */
const captcha = useCaptcha();

/* ------------------------------------------------------------------ 列表动作 */

function onSearch(): void {
  const next = keyword.value.trim();
  // 换关键字必须回第一页：留在第 3 页看新关键字的"空结果"是纯粹的自找困惑
  if (next !== applied.value) {
    page.value = 1;
  }
  applied.value = next;
}

function resetSearch(): void {
  keyword.value = '';
  applied.value = '';
  page.value = 1;
}

function goPage(next: number): void {
  page.value = Math.max(1, next);
  // 翻页时收起明细：那个人属于上一页，留在下面会让人以为它属于这一页
  selected.value = undefined;
}

/**
 * 刷新：列表变了，已选中的那位用户的明细与角色也该重来一次。
 *
 * 缓存失效是按**方法 id 前缀**删条目的，所以这里逐个点名本屏拥有的三类资源，
 * **绝不能写 `'user'`** —— 那个前缀会连 `user.current#…` 一起删掉，而左侧边栏的账号区
 * 读的正是它（`packages/layouts/src/AppFrame.vue`：名字与角色）。资源层**不会**因为
 * `invalidate` 就自动重取（只有 `[key, enabled]` 变化才会 `load()`），
 * 于是后果不是"数据不一致"，而是可见的功能退化：点一次「刷新」，左下角的名字会掉回
 * 会话里的名字、角色会空掉，而且不刷新页面就再也回不来。
 *
 * 明细两条不在这里 `reload()`：`cache.invalidate` 已经把它们的条目删掉，
 * 而 `useResource` 的 `activeKey` 没变就不会自己重取 —— 所以显式重取一次，
 * 顺序上先失效再 reload，拿到的必然是服务端的新值。
 */
function refresh(): void {
  cache.invalidate('user.list');
  cache.invalidate('user.detail');
  cache.invalidate('user.roles');
  list.reload();
  if (selected.value !== undefined) {
    detail.reload();
    roles.reload();
  }
}

function onRowSelect(row: UserRow): void {
  selected.value = row.userId;
}

/* ------------------------------------------------------------------ 新增用户 */

function toggleCreate(): void {
  actionError.value = undefined;
  if (creating.value) {
    creating.value = false;
    return;
  }
  form.value = { username: '', nickname: '', password: '', email: '' };
  creating.value = true;
}

function cancelCreate(): void {
  actionError.value = undefined;
  creating.value = false;
}

/**
 * 建号：四个字段都必填（服务端 `UserCreateRequest` 上是 `@NotBlank`）。
 * 本地只做"少一次白跑"的校验，**校验文案与 React 版逐字相同**；
 * 长度、重名这类只有服务端知道的拒绝，原样用人话显示（`humanize`）。
 */
async function submitCreate(): Promise<void> {
  const f = form.value;
  if (!f.username.trim() || !f.nickname.trim() || !f.password || !f.email.trim()) {
    actionError.value = '账号、姓名、初始密码与邮箱都要填写';
    return;
  }
  if (f.password.length < 6) {
    actionError.value = '初始密码至少 6 位';
    return;
  }
  actionError.value = undefined;
  try {
    await createMutation.run({
      username: f.username.trim(),
      nickname: f.nickname.trim(),
      password: f.password,
      email: f.email.trim(),
    });
    creating.value = false;
    form.value = { username: '', nickname: '', password: '', email: '' };
    // 新账号会插到列表最前面，所以回第一页才看得见它
    page.value = 1;
    applied.value = '';
    keyword.value = '';
    refresh();
  } catch (e) {
    actionError.value = humanize(e as BridgeErrorLike);
  }
}

/* ------------------------------------------------------------------ 明细动作 */

/**
 * 用户明细 + 角色。
 *
 * 参数表在没选中时为空、并同时用 `enabled` 兜底：`exactOptionalPropertyTypes` 下
 * 不能显式传 `userId: undefined`，而"不发这个参数"与"发一个空编号"在服务端是两回事。
 * 角色是**辅助数据**：它取不到只说"角色暂时读不到"，不把明细一起拖成错误态。
 */
const detailParams = computed<Record<string, unknown>>(() =>
  selected.value === undefined ? {} : { userId: selected.value },
);

/**
 * 选中了才有明细可看。
 *
 * **必须是 computed**：`useResource` 内部是 `toValue(options.enabled)` —— 传一个当场求值的
 * `selected.value !== undefined` 就是常量，setup 那一刻 `selected` 还是 `undefined`，
 * 于是它**永远**是 `false`：点行之后 watch 因缓存键变了而触发，`if (on) load()` 里的 `on`
 * 仍是 false → 一次请求都不发。这个 bug 不报错、不转圈，只显示一句"资料暂时取不到"，
 * 看起来像后端没数据。
 */
const hasSelection = computed(() => selected.value !== undefined);

const detail = useResource<UserRow>('user.detail', detailParams, { enabled: hasSelection });
const roles = useResource<unknown>('user.roles', detailParams, { enabled: hasSelection });

const detailUser = computed(() => detail.data.value);
const roleRows = computed(() => asList<RoleRow>(roles.data.value));

const detailItems = computed(() => {
  const u = detailUser.value;
  return [
    { key: 'username', label: '账号', value: u?.username ?? `编号 ${selected.value ?? ''}`, mono: true },
    { key: 'nickname', label: '姓名', value: u?.nickname ?? '未填写' },
    { key: 'email', label: '邮箱', value: u?.email ?? '未填写' },
    { key: 'role', label: '角色', value: roleTextOf(u?.role) },
    { key: 'enabled', label: '账号状态', value: loginText(u?.enabled) },
    { key: 'createdAt', label: '创建时间', value: shortTime(u?.createdAt) || '时间未记录', mono: true },
  ];
});

/** 明细块自己的反馈（两个动作各自一套，不合成一条）。 */
const deleteError = ref<string | undefined>(undefined);
const resetError = ref<string | undefined>(undefined);
const resetNotice = ref<string | undefined>(undefined);

function openReset(): void {
  deleteError.value = undefined;
  resetError.value = undefined;
  resetNotice.value = undefined;
  password.value = { oldPassword: '', newPassword: '', confirm: '' };
  resetting.value = true;
}

/**
 * 重置密码：先做本地校验（文案与 React 版逐字相同），再提交。
 * 成功文案也是逐字的 —— 它同时交代了"下一步该做什么"（当面告知）。
 */
async function submitReset(): Promise<void> {
  const userId = selected.value;
  const pw = password.value;
  if (userId === undefined || busy.value) {
    return;
  }
  if (!pw.oldPassword || !pw.newPassword) {
    resetError.value = '请填写这位用户现在的密码与要换成的密码';
    return;
  }
  if (pw.newPassword.length < 6) {
    resetError.value = '新密码至少 6 位';
    return;
  }
  if (pw.newPassword !== pw.confirm) {
    resetError.value = '两次输入的新密码不一致';
    return;
  }
  resetError.value = undefined;
  try {
    await resetMutation.run({ userId, oldPassword: pw.oldPassword, newPassword: pw.newPassword });
    resetting.value = false;
    password.value = { oldPassword: '', newPassword: '', confirm: '' };
    resetNotice.value = '密码已改好。请把新密码当面告知这位用户。';
  } catch (e) {
    resetError.value = humanize(e as BridgeErrorLike);
  }
}

function openDelete(): void {
  deleteError.value = undefined;
  resetError.value = undefined;
  resetNotice.value = undefined;
  // 每次打开都要一张**新**图：上一张可能已经被用过（验证码一次性）
  void captcha.refresh();
  deleting.value = true;
}

/**
 * 删除用户：`userId` 走路径、`captchaId` + `captchaCode` 进请求体。
 *
 * 三道闸门依次是：图没拿到 / 码没填 / 服务端拒绝。
 * 服务端拒绝之后**必须换一张图**（`refreshAfterFailure`）—— 见文件头第 4 条。
 */
async function confirmDelete(): Promise<void> {
  const userId = selected.value;
  if (userId === undefined || busy.value) {
    return;
  }
  if (captcha.captcha.value?.captchaId === undefined) {
    deleteError.value = '验证码还没取到，请稍等或点「换一张」重新获取。';
    return;
  }
  if (captcha.code.value.trim() === '') {
    deleteError.value = '请先填写验证码';
    return;
  }
  deleteError.value = undefined;
  try {
    await deleteMutation.run({
      userId,
      captchaId: captcha.captcha.value.captchaId,
      captchaCode: captcha.code.value.trim(),
    });
    deleting.value = false;
    // 先收起明细再刷新：那条明细已经属于一个不存在的用户，留着只会让它再取一次
    selected.value = undefined;
    refresh();
  } catch (e) {
    deleteError.value = humanize(e as BridgeErrorLike);
    captcha.refreshAfterFailure();
  }
}

function closeDetail(): void {
  selected.value = undefined;
  deleteError.value = undefined;
  resetError.value = undefined;
  resetNotice.value = undefined;
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
    <PageHeader title="用户管理" :note="pageNote">
      <template #actions>
        <ElButton class="w-hide-compact" size="large" :loading="list.loading.value" @click="refresh">刷新</ElButton>
        <!-- 桌面档留在页头；手机档移到底部动作条 -->
        <ElButton class="w-hide-compact" size="large" type="primary" @click="toggleCreate">{{ creating ? '收起' : '新增' }}</ElButton>
      </template>
    </PageHeader>

    <!-- 新增表单：与 React 版一致，就地展开而不是弹窗（现场看得见填写进度） -->
    <SectionBlock v-if="creating" title="新增用户">
      <div class="w-me-user-list__card">
        <div class="w-me-user-list__field">
          <label class="w-me-user-list__label" for="w-me-user-list-username">账号 *</label>
          <ElInput
            id="w-me-user-list-username"
            v-model="form.username"
            v-bind="anyProps({ size: 'large', placeholder: '登录用的账号' })"
          />
        </div>
        <div class="w-me-user-list__field">
          <label class="w-me-user-list__label" for="w-me-user-list-nickname">姓名 *</label>
          <ElInput
            id="w-me-user-list-nickname"
            v-model="form.nickname"
            v-bind="anyProps({ size: 'large', placeholder: '显示姓名，如：张三' })"
          />
        </div>
        <div class="w-me-user-list__field">
          <label class="w-me-user-list__label" for="w-me-user-list-password">初始密码 *</label>
          <ElInput
            id="w-me-user-list-password"
            v-model="form.password"
            v-bind="anyProps({ size: 'large', type: 'password', placeholder: '至少 6 位' })"
          />
        </div>
        <div class="w-me-user-list__field">
          <label class="w-me-user-list__label" for="w-me-user-list-email">邮箱 *</label>
          <ElInput
            id="w-me-user-list-email"
            v-model="form.email"
            v-bind="anyProps({ size: 'large', placeholder: '用于接收通知，如：name@example.com' })"
          />
        </div>

        <p v-if="actionError" class="w-me-user-list__error" role="alert">{{ actionError }}</p>
        <p class="w-me-user-list__hint">建好之后请把账号与初始密码告知使用者，并提醒对方尽快在“个人资料”里改掉。</p>

        <div class="w-toolbar">
          <ElButton size="large" @click="cancelCreate">取消</ElButton>
          <ElButton size="large" type="primary" :disabled="busy" :loading="createMutation.pending.value" @click="submitCreate">
            保存
          </ElButton>
        </div>
      </div>
    </SectionBlock>

    <!-- 收起表单后，动作失败的话还要有个落点（与 React 版同一处表达） -->
    <p v-else-if="actionError" class="w-me-user-list__error" role="alert">{{ actionError }}</p>

    <div class="w-toolbar">
      <ElInput
        v-model="keyword"
        v-bind="anyProps({
          size: 'large',
          clearable: true,
          prefixIcon: Search,
          class: 'w-me-user-list__search',
          placeholder: '账号 / 姓名 / 邮箱（回车搜索）',
        })"
        @keydown.enter="onSearch"
      />
      <StatusChip v-if="applied !== ''" :text="`只显示含「${applied}」的用户`" tone="info" />
      <button v-if="applied !== ''" type="button" class="w-chip-item" @click="resetSearch">清空筛选</button>
      <span class="w-me-user-list__scope">关键字只筛本页</span>
    </div>

    <SectionBlock :title="listTitle">
      <StateHost
        :loading="list.loading.value"
        :error="list.error.value ?? null"
        :error-text="list.error.value ? humanize(list.error.value) : undefined"
        :empty="rows.length === 0"
        :empty-text="emptyText"
        skeleton="list"
        @retry="refresh"
      >
        <ul class="w-me-user-list__list">
          <li
            v-for="row in rows"
            :key="rowKeyOf(row)"
            class="w-me-user-list__row"
            :class="{ 'w-me-user-list__row--open': row.userId !== undefined && row.userId === selected }"
          >
            <!-- 整行是一个按钮：现场戴手套点屏幕，行内的小图标按钮点不中 -->
            <button type="button" class="w-me-user-list__hit" @click="onRowSelect(row)">
              <span class="w-me-user-list__main">{{ row.nickname ?? '未填写姓名' }}</span>
              <span class="w-me-user-list__sub">
                <span class="w-mono">{{ textOf(row.username) || '账号未登记' }}</span>
                <span class="w-me-user-list__muted"> · {{ roleTextOf(row.role) }}</span>
                <span v-if="row.email" class="w-me-user-list__muted"> · {{ row.email }}</span>
                <span v-if="row.createdAt" class="w-mono"> · {{ shortTime(row.createdAt) || '时间未记录' }}</span>
              </span>
            </button>
            <StatusChip :text="statusChip(row.enabled).text" :tone="statusChip(row.enabled).tone" />
          </li>
        </ul>
      </StateHost>

      <!--
        分页条与"本页 N 位"在状态宿主**外面**（与 React 版一致）。
        放进去就会被三态一起藏掉：列表恰好空/错的时候，分页条是用户唯一还在的出口，
        藏了就只能靠「查找」回第 1 页 —— 该留的导航控件不该跟着内容消失。
      -->
      <div class="w-toolbar">
        <ElButton size="large" :disabled="page <= 1 || list.loading.value" @click="goPage(page - 1)">上一页</ElButton>
        <span class="w-chip w-mono">{{ `第 ${page} 页` }}</span>
        <ElButton size="large" :disabled="!hasMore || list.loading.value" @click="goPage(page + 1)">下一页</ElButton>
        <span class="w-me-user-list__muted">{{ `本页 ${rows.length} 位` }}</span>
      </div>
    </SectionBlock>

    <!--
      明细块：选中某一行之后才挂上，因此它自己的取数（详情 + 角色）也才发出去。
      里面两个动作都是不可逆或影响他人登录的，所以都要二次确认；删除还要验证码。
    -->
    <SectionBlock v-if="selected !== undefined" title="用户详情">
      <div class="w-me-user-list__card">
        <StateHost
          :loading="detail.loading.value"
          :error="detail.error.value ?? null"
          :error-text="detail.error.value ? humanize(detail.error.value) : undefined"
          :empty="detailUser === undefined"
          empty-text="这位用户的资料暂时取不到。返回列表刷新一次再点开。"
          skeleton="detail"
          @retry="detail.reload"
        >
          <dl class="w-me-user-list__kv">
            <template v-for="item in detailItems" :key="item.key">
              <dt class="w-me-user-list__kvlabel">{{ item.label }}</dt>
              <dd class="w-me-user-list__kvvalue">
                <span v-if="item.mono" class="w-mono">{{ item.value }}</span>
                <template v-else>{{ item.value }}</template>
              </dd>
            </template>
          </dl>
        </StateHost>

        <!--
          角色只读展示：授予/撤销角色属于权限管理，不在本次范围内，**故意不做入口**。
          它是辅助数据，取不到只说这一句，不把上面的明细一起拖成错误态。
        -->
        <StateHost
          :loading="roles.loading.value"
          :error="roles.error.value ?? null"
          :error-text="roles.error.value ? humanize(roles.error.value) : undefined"
          :empty="roleRows.length === 0"
          empty-text="这位用户还没有分配角色。角色由管理员在权限模块里指派。"
          skeleton="card"
          @retry="roles.reload"
        >
          <div class="w-me-user-list__rolechips">
            <StatusChip v-for="role in roleRows" :key="roleKeyOf(role)" :text="role.name ?? role.roleCode ?? '未命名角色'" tone="info" />
          </div>
        </StateHost>

        <p v-if="resetNotice" class="w-me-user-list__hint" role="status">{{ resetNotice }}</p>
        <p v-if="deleteError || resetError" class="w-me-user-list__error" role="alert">
          {{ deleteError ?? resetError }}
        </p>

        <div class="w-toolbar">
          <ElButton size="large" :disabled="busy" @click="openReset">重置密码</ElButton>
          <ElButton size="large" type="danger" :disabled="busy" @click="openDelete">删除用户</ElButton>
          <ElButton size="large" text @click="closeDetail">收起</ElButton>
        </div>
      </div>
    </SectionBlock>

    <p v-else class="w-me-user-list__hint">点某一位用户，可以查看资料、重置密码或删除账号。</p>

    <!-- 重置密码：不可逆地影响他人登录，所以二次确认 + 三个输入框 -->
    <ConfirmDialog
      :show="resetting"
      title="重置登录密码"
      :danger="true"
      confirm-text="确认改密码"
      :pending="resetMutation.pending.value"
      @confirm="submitReset"
      @cancel="resetting = false"
    >
      <p class="w-me-user-list__confirm">
        改密码前要先确认身份，所以需要这位用户此刻正在用的那个密码；如果他本人也记不清了，请让他先重置自己的密码再来操作。
      </p>
      <div class="w-me-user-list__field">
        <label class="w-me-user-list__label" for="w-me-user-list-oldpw">该用户当前的密码 *</label>
        <ElInput
          id="w-me-user-list-oldpw"
          v-model="password.oldPassword"
          v-bind="anyProps({ size: 'large', type: 'password', placeholder: '他现在的登录密码' })"
        />
      </div>
      <div class="w-me-user-list__field">
        <label class="w-me-user-list__label" for="w-me-user-list-newpw">要换成的密码 *</label>
        <ElInput
          id="w-me-user-list-newpw"
          v-model="password.newPassword"
          v-bind="anyProps({ size: 'large', type: 'password', placeholder: '至少 6 位' })"
        />
      </div>
      <div class="w-me-user-list__field">
        <label class="w-me-user-list__label" for="w-me-user-list-confirmpw">再输一次新密码 *</label>
        <ElInput
          id="w-me-user-list-confirmpw"
          v-model="password.confirm"
          v-bind="anyProps({ size: 'large', type: 'password', placeholder: '确认用' })"
        />
      </div>
      <p v-if="resetError" class="w-me-user-list__error" role="alert">{{ resetError }}</p>
    </ConfirmDialog>

    <!-- 删除用户：必须先有验证码（服务端把它当危险操作） -->
    <ConfirmDialog
      :show="deleting"
      title="删除用户"
      :danger="true"
      confirm-text="删除"
      :pending="deleteMutation.pending.value"
      @confirm="confirmDelete"
      @cancel="deleting = false"
    >
      <p class="w-me-user-list__confirm">
        将删除
        <span class="w-mono">{{ detailUser?.username ?? `编号 ${selected ?? ''}` }}</span>
        及其资料、角色与刷卡记录，删除后无法恢复。
      </p>
      <p class="w-me-user-list__hint">他之后将无法用这个账号登录，历史记录也会一并清理。</p>

      <CaptchaField :state="captcha" />

      <!-- 提交按钮禁用时，原因必须**写在按钮旁边**：只把按钮变灰等于什么都没说 -->
      <p class="w-me-user-list__hint">
        验证码是这次删除的确认动作：取不到图或没填码都提交不了，填错会换一张新的。
      </p>
      <p v-if="deleteError" class="w-me-user-list__error" role="alert">{{ deleteError }}</p>
    </ConfirmDialog>

    <ActionDock>
      <ElButton class="w-show-compact-only w-actiondock__block" size="large" type="primary" @click="toggleCreate">
        {{ creating ? '收起建号表单' : '新增账号' }}
      </ElButton>
    </ActionDock>
  </div>
</template>

<style scoped>
/* 卡片：明细 / 表单共用同一形状，与列表里的行卡片同形 */
.w-me-user-list__card {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-group-gap);
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding);
}

/* 作用域标注必须常驻可见：它决定用户对"搜不到"的理解 */
.w-me-user-list__scope {
  font-size: var(--w-type-body-small-size);
  color: var(--w-color-on-surface-muted);
  white-space: nowrap;
}

.w-me-user-list__search {
  max-width: var(--w-space-detail-column-width);
}

.w-me-user-list__list {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-row-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}

.w-me-user-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--w-space-inline-gap);
  background: var(--w-color-surface);
  border: 1px solid var(--w-color-outline);
  border-radius: var(--w-radius-card);
  padding: var(--w-space-card-padding-compact);
}

/* 选中态必须一处可见：它同时是"下面那块明细说的是谁"的唯一提示 */
.w-me-user-list__row--open {
  border-color: var(--w-color-primary);
}

/*
 * 行命中区：纵向排布 + 允许换行，窄屏下把副信息折到下一行，
 * 而不是把卡片撑出横向滚动（现场机器屏幕窄，横向滚动很难受）。
 */
.w-me-user-list__hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--w-space-inline-gap);
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.w-me-user-list__main {
  font-weight: var(--w-type-label-weight);
}

.w-me-user-list__sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
  font-size: var(--w-type-body-small-size);
  min-width: 0;
}

.w-me-user-list__muted {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

/* 明细的键值对：与 KeyValuePanel 同形，但这里要逐项控制等宽与兜底文案 */
.w-me-user-list__kv {
  display: grid;
  grid-template-columns: var(--w-size-kv-label-width) 1fr;
  gap: var(--w-space-inline-gap);
  margin: 0;
}

.w-me-user-list__kvlabel {
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
}

.w-me-user-list__kvvalue {
  margin: 0;
  color: var(--w-color-on-surface);
  overflow-wrap: anywhere;
}

.w-me-user-list__rolechips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--w-space-inline-gap);
}

.w-me-user-list__field {
  display: flex;
  flex-direction: column;
  gap: var(--w-space-inline-gap);
  margin-bottom: var(--w-space-group-gap);
  width: 100%;
}

.w-me-user-list__label {
  font-size: var(--w-type-label-size);
  font-weight: var(--w-type-label-weight);
  color: var(--w-color-on-surface-variant);
}

.w-me-user-list__hint {
  margin: 0;
  color: var(--w-color-on-surface-muted);
  font-size: var(--w-type-body-small-size);
  line-height: var(--w-type-body-small-line);
}

.w-me-user-list__confirm {
  margin: 0 0 var(--w-space-inline-gap);
  color: var(--w-color-on-surface-variant);
  font-size: var(--w-type-body-size);
  line-height: var(--w-type-body-line);
  overflow-wrap: anywhere;
}

.w-me-user-list__error {
  margin: 0;
  padding: var(--w-space-inline-gap) var(--w-space-card-padding-compact);
  border-left: 2px solid var(--w-state-danger-text);
  background: var(--w-state-danger-fill);
  color: var(--w-state-danger-text);
  border-radius: var(--w-radius-chip);
  font-size: var(--w-type-body-small-size);
}
</style>
