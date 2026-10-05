import { BridgeError } from './types.js';

/**
 * 「我的」域的**有状态** mock（消息 / 用户 / 个人资料，开发态专用）。
 *
 * ## 为什么它也要有状态
 *
 * 这一域的主线全是"写完再看一眼"：
 *   · 标了一条已读 → 未读数必须**减一**；全部已读 → 必须归零；清空 → 列表要空。
 *   · 新建用户 → 列表里要多一个；删除用户 → 要少一个；改完资料 → 资料卡要显示新值。
 * 如果 mock 恒返回同一份静态数据，这些分支在开发态**永远验不到**，
 * 而现场最怕的恰恰是"点了没反应/数字不动"。
 *
 * ## 两条被服务端源码钉死的口径（写错就静默错一页）
 *
 * 1. **消息分页是 0 基**：`MessageApplicationService#queryMessages` 里
 *    `int start = request.getPage() * request.getSize();` —— 传 1 会跳过第一页。
 * 2. **用户分页是 1 基**：`UserApplicationService#listUsers` 里
 *    `if (page == null || page < 1) page = 1;` 然后 `PageRequest.of(page - 1, size)`，默认 size=10。
 *
 * 两个域的中文错误文案逐字取自服务端 DTO 上的 `@NotBlank` / `@Size` 注解，
 * 免得界面自己编一套用户对不上的说法。
 */
interface MessageRow {
  id: string;
  title: string;
  content: string;
  type: string;
  receiverId: number;
  receiverName: string;
  relatedEntityType?: string | undefined;
  relatedEntityId?: string | undefined;
  isRead: boolean;
  readTime?: string | undefined;
  createTime: string;
  status: string;
  priority: number;
}

interface UserRow {
  userId: number;
  username: string;
  nickname: string;
  avatar: string;
  email: string;
  enabled: boolean;
  nfcId: string;
  createdAt: string;
  updatedAt: string;
  role: string;
}

interface RoleRow {
  roleId: number;
  name: string;
  roleCode: string;
  description: string;
}

/**
 * 权限行（`PermissionDTO`）。字段名取自真后端实测响应，**一个都不许改名**：
 * `{permissionId, permissionName, permissionCode, parentId, parentName, description, children, createdAt, updatedAt}`。
 * 其中 `parentId` / `parentName` / `children` 在真后端**永远是 null**（没有层级数据）。
 */
interface PermissionRow {
  permissionId: number;
  permissionName: string;
  permissionCode: string;
  parentId?: number | undefined;
  parentName?: string | undefined;
  description: string;
  children?: PermissionRow[] | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

interface ProfileRow {
  profileId: number;
  userId: number;
  username: string;
  nickname: string;
  email: string;
  gender: number;
  avatarFileId?: number | undefined;
  avatarUrl: string;
  status: number;
  createTime: string;
  updateTime: string;
}

const nowIso = (): string => new Date().toISOString();

/** 用户列表默认每页 10（服务端 `size == null || size < 1 → 10`）。 */
const DEFAULT_USER_PAGE_SIZE = 10;

export class MeMock {
  /**
   * 消息。**id 是字符串**（服务端 `@PathVariable String messageId`），
   * 两个收件人各有一份 —— 用来验"按收件人过滤"真的生效（换个人不该看到别人的消息）。
   */
  private readonly messages: MessageRow[] = [
    {
      id: 'MSG-20260106-004',
      title: '读头 04 心跳超时',
      content: '设备 READER-04 已连续 180 秒未上报心跳，请到现场确认供电与网线。处理完请在设备管理里更新状态。',
      type: 'ALERT',
      receiverId: 1,
      receiverName: '现场操作员',
      relatedEntityType: 'DEVICE',
      relatedEntityId: '3',
      isRead: false,
      createTime: '2026-01-06T10:02:00',
      status: 'SENT',
      priority: 2,
    },
    {
      id: 'MSG-20260106-003',
      title: '出入库单 IN-20260106-0900 待审核',
      content: '华东中心仓提交的单据已进入待审核状态，请核对明细后在单据详情里审批。',
      type: 'APPROVAL',
      receiverId: 1,
      receiverName: '现场操作员',
      relatedEntityType: 'STOCK_ORDER',
      relatedEntityId: '8001',
      isRead: false,
      createTime: '2026-01-06T09:12:00',
      status: 'SENT',
      priority: 1,
    },
    {
      id: 'MSG-20260106-002',
      title: '巡检任务 INS-20260106-01 已下发',
      content: '华东中心仓日常盘点任务已下发到读头 04，请按计划开始执行并及时上报进度。',
      type: 'TASK',
      receiverId: 1,
      receiverName: '现场操作员',
      relatedEntityType: 'INSPECTION_TASK',
      relatedEntityId: '501',
      isRead: false,
      createTime: '2026-01-06T08:35:00',
      status: 'SENT',
      priority: 1,
    },
    {
      id: 'MSG-20260105-002',
      title: '库存偏低提醒',
      content: '液压密封组件在华南备件仓的可用量已降到 8，低于安全库存，请安排补货。',
      type: 'SYSTEM',
      receiverId: 1,
      receiverName: '现场操作员',
      isRead: true,
      readTime: '2026-01-05T18:20:00',
      createTime: '2026-01-05T17:40:00',
      status: 'SENT',
      priority: 0,
    },
    {
      id: 'MSG-20260105-001',
      title: '系统维护通知',
      content: '本周日 02:00–04:00 服务端例行维护，期间盘点数据上传会失败，请提前同步。',
      type: 'SYSTEM',
      receiverId: 1,
      receiverName: '现场操作员',
      isRead: true,
      readTime: '2026-01-05T09:05:00',
      createTime: '2026-01-05T08:30:00',
      status: 'SENT',
      priority: 0,
    },
    {
      id: 'MSG-20260106-101',
      title: '盘点结果待确认',
      content: '任务 INS-20260105-04 的差异结果已生成，请确认入账。',
      type: 'TASK',
      receiverId: 2,
      receiverName: '仓管员',
      relatedEntityType: 'INSPECTION_RESULT',
      relatedEntityId: '9001',
      isRead: false,
      createTime: '2026-01-05T15:25:00',
      status: 'SENT',
      priority: 1,
    },
  ];

  /** 用户。6 条足够覆盖"正常 / 停用 / 无邮箱 / 多人"几种展示分支。 */
  private readonly users: UserRow[] = [
    {
      userId: 1,
      username: 'operator',
      nickname: '现场操作员',
      avatar: '',
      email: 'operator@wise.local',
      enabled: true,
      nfcId: '04A1B2C3',
      createdAt: '2026-01-01T09:00:00',
      updatedAt: '2026-01-06T09:00:00',
      role: 'USER',
    },
    {
      userId: 2,
      username: 'keeper',
      nickname: '仓管员',
      avatar: '',
      email: 'keeper@wise.local',
      enabled: true,
      nfcId: '04A1B2C4',
      createdAt: '2026-01-01T09:10:00',
      updatedAt: '2026-01-05T09:10:00',
      role: 'USER',
    },
    {
      userId: 3,
      username: 'admin',
      nickname: '系统管理员',
      avatar: '',
      email: 'admin@wise.local',
      enabled: true,
      nfcId: '',
      createdAt: '2026-01-01T08:00:00',
      updatedAt: '2026-01-06T08:00:00',
      role: 'ADMIN',
    },
    {
      userId: 4,
      username: 'dispatcher',
      nickname: '调度员',
      avatar: '',
      email: 'dispatch@wise.local',
      enabled: true,
      nfcId: '',
      createdAt: '2026-01-02T09:00:00',
      updatedAt: '2026-01-04T09:00:00',
      role: 'USER',
    },
    {
      userId: 5,
      username: 'viewer',
      nickname: '只读访客',
      avatar: '',
      email: '',
      enabled: true,
      nfcId: '',
      createdAt: '2026-01-03T09:00:00',
      updatedAt: '2026-01-03T09:00:00',
      role: 'USER',
    },
    {
      userId: 6,
      username: 'retired',
      nickname: '已停用账号',
      avatar: '',
      email: 'retired@wise.local',
      enabled: false,
      nfcId: '',
      createdAt: '2026-01-04T09:00:00',
      updatedAt: '2026-01-04T09:00:00',
      role: 'USER',
    },
  ];

  private readonly roleCatalog: RoleRow[] = [
    // 与服务端种子数据逐字一致（`DataInitializer#createRoleIfNotExist`：1 管理员 / 2 操作员 / 3 访客）。
    //
    // **roleCode 允许重复，这是忠实的**：服务端 `RoleMapper` 把「操作员」和「访客」**都压成 `USER`**，
    // 所以只存在 `ADMIN` / `USER` 两个码。假桥若自己发明 `OPERATOR` / `VIEWER`，
    // 开发态就会显示服务端永远不会下发的词，而真机上显示的是另一个 —— 这类"假桥比真后端聪明"的
    // 偏差在别处已经付过学费（见 `inventory.search` 那一轮）。
    { roleId: 1, name: '管理员', roleCode: 'ADMIN', description: '系统管理员，拥有所有权限' },
    { roleId: 2, name: '操作员', roleCode: 'USER', description: '普通操作员' },
    { roleId: 3, name: '访客', roleCode: 'USER', description: '访客' },
  ];

  /** userId → roleId[]。用户 1 与 3 各多一个角色，好让"角色列表"不是恒定一行。 */
  private readonly userRoles = new Map<number, number[]>([
    [1, [2, 3]],
    [2, [2]],
    [3, [1, 2]],
  ]);

  private profile: ProfileRow = {
    profileId: 1,
    userId: 1,
    username: 'operator',
    nickname: '现场操作员',
    email: 'operator@wise.local',
    gender: 0,
    avatarUrl: '',
    status: 1,
    createTime: '2026-01-01T09:00:00',
    updateTime: '2026-01-06T09:00:00',
  };

  /**
   * 偏好设置。服务端是 `Map<String,String>`（`UserSettingsDTO.settings`），界面按 `Object.entries` 通用渲染 ——
   * 所以这里给一组能同时覆盖"开关类"与"选择类"的样例键。
   * **注意**：真后端的键名没有实测过，别把这里的键当成业务约定。
   */
  private settings: Record<string, string> = {
    'ui.theme': 'light',
    'ui.density': 'comfortable',
    'list.pageSize': '20',
    'notify.alert': 'on',
    'notify.inspection': 'on',
  };

  private nextUserId = 100;

  private readonly findUser = (userId: number | undefined): UserRow | undefined =>
    this.users.find((u) => u.userId === userId);

  /**
   * 权限清单。**与服务端种子逐字一致**（`DataInitializer:245-248`：1 用户查看 user:view /
   * 2 用户创建 user:create / 3 用户编辑 user:edit / 4 用户删除 user:delete）。
   *
   * 真后端实测（2026-10-03）：`permission.list` 返回**裸数组、不分页**；
   * `permission.tree` 返回的东西与 list **一模一样**（实体与表都没有 `parentId`，
   * `PermissionMapper` 也不填它 ⇒ 四个节点全是根、`children` 是 `null`）。
   * 所以假桥也不许自己编出一棵树来 —— 界面据此不画树。
   */
  private readonly permissions: PermissionRow[] = [
    { permissionId: 1, permissionName: '用户查看', permissionCode: 'user:view', description: '用户查看' },
    { permissionId: 2, permissionName: '用户创建', permissionCode: 'user:create', description: '用户创建' },
    { permissionId: 3, permissionName: '用户编辑', permissionCode: 'user:edit', description: '用户编辑' },
    { permissionId: 4, permissionName: '用户删除', permissionCode: 'user:delete', description: '用户删除' },
  ];

  /** 返回 `undefined` 表示"这个方法不归我管"，交给别的 mock / FIXTURES。 */
  call<T>(method: string, params: unknown): T | undefined {
    const p = (params ?? {}) as Record<string, unknown>;
    const num = (key: string): number | undefined => {
      const value = p[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };
    const str = (key: string): string => String(p[key] ?? '').trim();

    switch (method) {
      // ---------------- 当前用户 ----------------
      case 'user.current': {
        // 形状必须**覆盖 FIXTURES 里那一份**（userId/username/nickname/role 都在），
        // 因为启动横幅、侧栏账号区、桥健康探测都读它。
        const me = this.findUser(1);
        return (me ?? this.users[0]) as T;
      }

      // ---------------- 权限（net-new：旧 React 版从未接过这一族） ----------------

      /**
       * 权限清单。真后端实测（2026-10-03）：
       *   · `permission.list` 返回**裸数组、不分页**（`PermissionController` 的 list 没有 page/size 参数）；
       *   · `permission.tree` 返回的东西与它**一模一样** —— 实体与表都没有 `parentId`、
       *     `PermissionMapper` 也不填它 ⇒ 四个节点全是根、`children` 是 `null`。
       * 所以假桥把两者放在**同一个 case** 里：界面据此不画树（画出来的树是假的层级）。
       */
      case 'permission.list':
      case 'permission.tree':
        return this.permissions.map((x) => ({
          ...x,
          parentId: null,
          parentName: null,
          children: null,
          createdAt: '2026-09-18T18:52:51.672049',
          updatedAt: '2026-09-18T18:52:51.672049',
        })) as T;

      case 'permission.detail': {
        const row = this.permissions.find((x) => x.permissionId === num('id'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '权限不存在' });
        }
        return { ...row, parentId: null, parentName: null, children: null } as T;
      }

      case 'permission.byCode': {
        const wanted = str('code');
        const row = this.permissions.find((x) => x.permissionCode === wanted);
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: `没有找到编码 ${wanted} 的权限` });
        }
        return { ...row, parentId: null, parentName: null, children: null } as T;
      }

      /**
       * **复刻服务端的 500，而不是"帮它实现一遍"**。
       *
       * `permission.create` 在真后端上必然失败：`permission.create_by` / `update_by` 是 `NOT NULL`
       * 且外键到 `user_core`，而 `PermissionApplicationService#createPermission` 从不设置它们
       * （`Permission` 不继承 `BaseEntity`、没有 `@PrePersist`；`orm.xml` 也没有 entity-listeners）。
       * 2026-10-03 实测：`POST /api/permissions` → `HTTP 500 SYS-0001 系统异常，请联系管理员`。
       * 假桥若让它成功，界面就会在开发态一切正常、真机上一建就 500。
       *
       * **`permission.update` / `permission.delete` 这里故意不实现**：它们没有实测过
       * （update 要拿真权限去改、delete 会撞 `role_permission` 外键 —— 默认那 4 条被角色引用着，
       * 拿它们去撞删除等于修库）。没实测就不假装支持：返回 undefined，由资源层如实报"未知方法"。
       * 界面上这三条都不提供入口。
       */
      case 'permission.create':
        throw new BridgeError({
          code: 'SYS-0001',
          messageKey: 'error.system',
          details: '服务端权限写入接口当前不可用',
        });

      // ---------------- 消息 ----------------
      case 'message.list': {
        const receiverId = num('receiverId');
        const type = str('type').toUpperCase();
        const isReadRaw = p['isRead'];
        // 0 基分页（服务端 `start = page * size`）
        const page = num('page') ?? 0;
        const size = num('size') ?? 10;
        const matched = this.messages
          .filter((m) => (receiverId === undefined ? true : m.receiverId === receiverId))
          .filter((m) => (type === '' ? true : m.type.toUpperCase() === type))
          .filter((m) => (typeof isReadRaw === 'boolean' ? m.isRead === isReadRaw : true))
          .sort((a, b) => b.createTime.localeCompare(a.createTime));
        const start = Math.max(0, page) * Math.max(1, size);
        // 服务端返回的是 `List<MessageDTO>`（裸数组），不是分页对象
        return matched.slice(start, start + Math.max(1, size)) as unknown as T;
      }
      case 'message.detail': {
        const messageId = str('messageId');
        const row = this.messages.find((m) => m.id === messageId);
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: `没有找到 id 为 ${messageId} 的消息` });
        }
        return row as T;
      }
      case 'message.markRead': {
        const messageId = str('messageId');
        const row = this.messages.find((m) => m.id === messageId);
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: `没有找到 id 为 ${messageId} 的消息` });
        }
        // 幂等：已读再标一次不该报错，也不该刷新 readTime
        if (!row.isRead) {
          row.isRead = true;
          row.readTime = nowIso();
        }
        // 服务端这个端点回的是 MessageDTO（不是空）
        return row as T;
      }
      case 'message.markAllRead': {
        const receiverId = num('receiverId');
        if (receiverId === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '收件人不能为空' });
        }
        for (const m of this.messages) {
          if (m.receiverId === receiverId && !m.isRead) {
            m.isRead = true;
            m.readTime = nowIso();
          }
        }
        return {} as T;
      }
      case 'message.clear': {
        const receiverId = num('receiverId');
        if (receiverId === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '收件人不能为空' });
        }
        // 只清这个收件人的 —— 别人的消息必须还在（不然"清空"就变成了越权删）
        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
          if (this.messages[i]?.receiverId === receiverId) {
            this.messages.splice(i, 1);
          }
        }
        return {} as T;
      }
      case 'message.unreadCount': {
        const receiverId = num('receiverId');
        if (receiverId === undefined) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '收件人不能为空' });
        }
        return this.messages.filter((m) => m.receiverId === receiverId && !m.isRead).length as unknown as T;
      }

      // ---------------- 用户 ----------------
      case 'user.list': {
        // 1 基分页（服务端 `if (page == null || page < 1) page = 1;`）
        const rawPage = num('page');
        const page = rawPage === undefined || rawPage < 1 ? 1 : rawPage;
        const rawSize = num('size');
        const size = rawSize === undefined || rawSize < 1 ? DEFAULT_USER_PAGE_SIZE : rawSize;
        const sorted = [...this.users].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const start = (page - 1) * size;
        // 服务端回的是 `UserPageDTO { total, items }`
        return { total: sorted.length, items: sorted.slice(start, start + size) } as unknown as T;
      }
      case 'user.detail': {
        const row = this.findUser(num('userId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '用户不存在' });
        }
        return row as T;
      }
      case 'user.roles': {
        const userId = num('userId');
        const roleIds = this.userRoles.get(userId ?? -1) ?? [];
        return this.roleCatalog.filter((r) => roleIds.includes(r.roleId)) as unknown as T;
      }
      case 'user.create': {
        const username = str('username');
        const nickname = str('nickname');
        const password = String(p['password'] ?? '');
        const email = str('email');
        /*
         * 校验与文案逐字取自服务端 `UserCreateRequest` 上的注解
         * （`@NotBlank(message = "用户名不能为空")`、`@Size(max = 32, …)` 等），
         * 免得界面自己编一套跟服务端对不上的说法。
         */
        if (username === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '用户名不能为空' });
        }
        if (username.length > 32) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '用户名长度不能超过32个字符' });
        }
        if (this.users.some((u) => u.username === username)) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '用户名已存在' });
        }
        if (nickname === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '昵称不能为空' });
        }
        if (nickname.length > 16) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '昵称长度不能超过16个字符' });
        }
        if (password === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '密码不能为空' });
        }
        if (password.length < 6 || password.length > 20) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '密码长度必须在6-20个字符之间' });
        }
        if (email === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '邮箱不能为空' });
        }
        if (email.length > 128) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '邮箱长度不能超过128个字符' });
        }
        const created: UserRow = {
          userId: this.nextUserId,
          username,
          nickname,
          avatar: '',
          email,
          enabled: true,
          nfcId: String(p['nfcId'] ?? ''),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          role: String(p['role'] ?? 'USER'),
        };
        this.nextUserId += 1;
        this.users.unshift(created);
        return created as T;
      }
      case 'user.resetPassword': {
        const row = this.findUser(num('userId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '用户不存在' });
        }
        const oldPassword = String(p['oldPassword'] ?? '');
        const newPassword = String(p['newPassword'] ?? '');
        if (oldPassword === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '原密码不能为空' });
        }
        if (newPassword.length < 6 || newPassword.length > 20) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '新密码长度必须在6-20个字符之间' });
        }
        row.updatedAt = nowIso();
        return {} as T;
      }
      case 'user.deleteWithVerify': {
        const row = this.findUser(num('userId'));
        if (!row) {
          throw new BridgeError({ code: 'RES-0004', messageKey: 'error.notFound', details: '用户不存在' });
        }
        /*
         * 人机验证票据由**桥**注入（页面不传），所以假桥这里没有可校验的东西。
         *
         * 真服务端会校验票据、缺失即拒 —— "没验证就删不掉"这条**在开发态验不到**。
         * 与库存域 `tag.batchBind` 同一口径；别把"假桥放行"读成"真后端也放行"。
         */
        const index = this.users.findIndex((u) => u.userId === row.userId);
        this.users.splice(index, 1);
        this.userRoles.delete(row.userId);
        return {} as T;
      }

      // ---------------- 个人资料 ----------------
      case 'profile.get':
        return { ...this.profile } as T;
      case 'profile.update': {
        const nickname = str('nickname');
        const email = str('email');
        if (nickname === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '昵称不能为空' });
        }
        this.profile = { ...this.profile, nickname, email, updateTime: nowIso() };
        return { ...this.profile } as T;
      }
      case 'profile.settings':
        return { userId: this.profile.userId, settings: { ...this.settings } } as T;
      case 'profile.settingsUpdate': {
        const incoming = p['settings'];
        if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '偏好设置格式不对' });
        }
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
          next[key] = String(value ?? '');
        }
        this.settings = next;
        return { userId: this.profile.userId, settings: { ...this.settings } } as T;
      }
      case 'user.changePassword': {
        const oldPassword = String(p['oldPassword'] ?? '');
        const newPassword = String(p['newPassword'] ?? '');
        if (oldPassword === '') {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '原密码不能为空' });
        }
        /*
         * **有意不校验"旧密码是否正确"**：假桥的登录接受任意口令（见 `auth.login`），
         * 它根本不知道当前口令是什么；硬编一个只会在开发态制造"我明明用这个登进来的却改不了密码"。
         * 真服务端会校验（旧密码错误返回 400），所以这条分支**在开发态验不到** —— 别当已验证。
         */
        if (newPassword.length < 6 || newPassword.length > 20) {
          throw new BridgeError({ code: 'VAL-0001', messageKey: 'error.validation', details: '新密码长度必须在6-20个字符之间' });
        }
        return {} as T;
      }

      default:
        return undefined;
    }
  }
}
