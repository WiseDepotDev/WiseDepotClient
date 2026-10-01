import { computed, type ComputedRef } from 'vue';
import { useResource } from './resource.js';
import { useSessionStore } from './session.js';

/**
 * `GET /api/users/current` ⇒ `user.current` 的响应。
 *
 * 字段来自 **2026-10-01 对真后端实测**（此前 AppFrame 里那句"发布前需要拿真后端核一次响应字段"
 * 的欠账就是在这里还的）：
 * `{userId, username, nickname, avatar, email, enabled, nfcId, createdAt, updatedAt, role}`。
 */
export interface CurrentUser {
  readonly userId?: number;
  readonly username?: string;
  readonly nickname?: string;
  readonly role?: string;
}

/**
 * 角色码 → 业务叫法。**这是全仓唯一一份**（此前有三份拷贝：账号块、用户管理、个人设置）。
 *
 * ## 为什么写这两个词，以及为什么不再自己发明第三个
 *
 * 服务端**只下发角色码，不下发中文名**（`UserDTO.role` = `RoleDTO.roleCode`，
 * 见 `UserApplicationService#toUserDTO`：`dto.setRole(roles.get(0).getRoleCode())`），
 * 而码只有两个取值（`RoleMapper`）：`ADMIN` / `USER`。
 *
 * 关键事实：**`USER` 是有损的** —— 服务端种子角色有三个（`DataInitializer`：
 * `1 管理员` / `2 操作员` / `3 访客`），但 `RoleMapper` 把「操作员」和「访客」**都压成 `USER`**。
 * 所以一个 `role === 'USER'` 的账号，真实角色可能是操作员、也可能是访客，**客户端无从分辨**。
 *
 * 因此这里不给 `USER` 编一个具体职务（写「访客」会把操作员说成访客；写「操作员」会把访客说成操作员），
 * 只给一个**不会指错**的中性说法。要问"这个人到底是操作员还是访客"，
 * 得读 `user.roles`（`RoleDTO.name`，服务端下发的原名）——用户详情屏就是这么做的。
 *
 * 认不出的码**原样显示**：它是服务端下发的数据，不是我们的文案。
 * 没有角色（`null`/`undefined`/空串）返回 `null`，由调用方按自己的语境给空态措辞
 * （账号块说「职位未登记」、用户管理说「未指派角色」）—— 事实是同一个，措辞可以不同。
 */
export function roleLabel(role: string | null | undefined): string | null {
  switch (role) {
    case 'ADMIN':
      return '管理员';
    case 'USER':
      return '普通用户';
    case null:
    case undefined:
    case '':
      return null;
    default:
      return role;
  }
}

export interface CurrentAccount {
  readonly user: ComputedRef<CurrentUser | undefined>;
  readonly loading: ComputedRef<boolean>;
  readonly displayName: ComputedRef<string>;
  readonly roleText: ComputedRef<string>;
  readonly reload: () => void;
}

/**
 * 「当前账号是谁」的**唯一出处**（侧栏左下角与首页账号行都读这里）。
 *
 * ## 为什么要单独有一个出处
 *
 * 同一个概念原先有两个实现（`AppFrame` 自己算一份、`HomeView` 只看 `session.username`），
 * 于是同一台机器上两处会写出**不一样的名字** —— 重复的属主迟早漂移。
 *
 * ## 为什么不能只看 `session.username`
 *
 * 桥里的 `username` 是**进程内字段**（登录响应经过时写一次），**不随令牌一起持久化**
 * （持久化的只有令牌，见 `bridge/.../SessionManager.kt`：`authenticated` 由令牌推导，
 * `username` 不在里面）。所以冷启动恢复登录态之后：`authenticated == true` 而 `username == null`，
 * 界面上就只剩一句"已登录"——**人明明认得自己是谁，界面却说不出名字**。
 *
 * 真值只能问服务端：`user.current` 在恢复态下同样可用（实测返回 `admin / 系统管理员 / ADMIN`）。
 * `session.username` 保留为**登录后那一瞬**的同步兜底（取数还没回来时先显示对的人）。
 * 两个消费者调用本函数只会发**一次**请求（`useResource` 按 `方法 + 参数` 合并缓存）。
 */
export function useCurrentAccount(): CurrentAccount {
  const session = useSessionStore();
  const { data, loading, error, reload } = useResource<CurrentUser>('user.current');

  const displayName = computed(
    () =>
      data.value?.nickname ??
      data.value?.username ??
      session.username ??
      // 兜底也不说谎：已登录就说已登录，别写成"未登录"（恢复态下这曾经是会闪的一帧错话）
      (session.authenticated ? '已登录' : '未登录'),
  );

  /**
   * 四个分支各自说的是真话：
   * 拿到了 → 按服务端的码翻译；还在取 → 读取中；取失败 → 取不到；
   * 取到了却没有这个字段 → 未登记。**"取不到"和"未登记"是两件事**，不能合并成一句。
   */
  const roleText = computed(() => {
    if (data.value !== undefined) {
      return roleLabel(data.value.role) ?? '职位未登记';
    }
    if (loading.value) {
      return '读取中';
    }
    return error.value !== undefined ? '职位未取到' : '职位未登记';
  });

  return { user: data, loading, displayName, roleText, reload };
}
