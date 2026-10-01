# 「我的」域 4 屏 Vue 移植 —— 实现简报（SubagentContextPacket）

> 项目根：`E:\code_space\WiseDepot\WiseDepotClient`。你只看这份简报 + 仓库里的文件。
> **通用规矩（数据层用法、TS/Element Plus 硬规矩、UI 硬规矩、自检清单）沿用现场域的
> `docs/superpowers/plans/2026-10-02-field-inspection-port-brief.md` 的 §3 / §4 / §5 / §9** ——
> 先完整读它一遍，这份简报只补「我的」域特有的东西。

## 0. 任务与停止条件

把 React 版「我的」域 4 屏按 Vue 3 `<script setup>` + TS strict + Element Plus 重写进
`apps/web/src/views/me/`，字段、动作、校验、文案与 React 版一一对应。
停止条件：分到的文件写完 + 自检清单逐条打勾 + 报告 `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`。

## 1. 必须读的文件

| 用途 | 路径 |
| --- | --- |
| 业务逻辑/字段/文案的唯一真源 | `packages/features/src/me/MessageListScreen.tsx`、`MessageDetailScreen.tsx`、`UserListScreen.tsx`、`ProfileScreen.tsx` |
| 通用规矩 | `docs/superpowers/plans/2026-10-02-field-inspection-port-brief.md`（§3 §4 §5 §9） |
| 同域风格范本（刚落地的现场域） | `apps/web/src/views/field/InspectionTaskListView.vue`（列表）、`InspectionResultListView.vue`（列表+明细面板）、`InspectionResultCreateView.vue`（表单+推导） |
| 库存域的"列表+明细"范本 | `apps/web/src/views/inventory/StockOrderDetailView.vue` |
| 验证码字段（删除用户要用） | `apps/web/src/components/CaptchaField.vue`、`useCaptcha.ts`、`apps/web/src/views/inventory/TagListView.vue`（现有用法） |
| 共享组件源码 | `packages/ui/src/business/*.vue`、`packages/ui/src/primitives/*.vue` |

## 2. 路由（`router.push` 用 `name` = 桥方法 id）

| 目标 | name | params / query |
| --- | --- | --- |
| 消息详情 | `message.detail` | `{ messageId: String(x) }`（**消息 id 是字符串**，见 §7） |
| 用户详情 | `user.detail` | `{ userId: String(x) }` |
| 消息中心 | `message.list` | 无 |
| 用户管理 | `user.list` | 无 |
| 个人设置 | `profile.get` | 无 |
| 标签详情（扫码落点） | `tag.byCode` | `{ code }` |

`route.params['x']` 与 `route.query['x']` 都要按 `string | string[] | undefined` 兜底（`noUncheckedIndexedAccess`）。

## 3. 屏与交付

### A. `MessageListView.vue` ← `MessageListScreen.tsx`（367 行，**列表 + 明细面板**）
- 方法：`user.current`（拿 `userId` 当 `receiverId`）、`message.list`、`message.unreadCount`、
  `message.markRead`、`message.markAllRead`、`message.clear`。
- **`receiverId` 来自 `user.current.userId`**（React 就是这么拿的）：拿不到就停在"没有收件人"的静止态，
  **不要**发一个 `receiverId: undefined` 的请求。
- 列表参数：`{ receiverId, page: page - 1, size: PAGE_SIZE }` —— **消息的分页是从 0 开始的**（见 §7.2），
  React 传的就是 `page - 1`，别"顺手改成 page"。
- 未读数芯片：`message.unreadCount` 取不到就显示"未读数量暂时读不到"，**不要**因为辅助数据失败把整屏拖成错误态。
- 点行 = 选中并在下方「消息正文」面板显示正文（React 有这条内联明细）；另外提供进
  `message.detail` 的入口。写操作（标已读 / 全部已读 / 清空）成功后刷新列表与未读数。
- 「清空消息」走 `ConfirmDialog` 二次确认。

### B. `MessageDetailView.vue` ← `MessageDetailScreen.tsx`（161 行）
- 方法：`message.detail`（`{ messageId }`）+ **一进屏就自动 `message.markRead`**。
- 标已读**失败静默**（它是副作用，不该挡住正文）——React 明确这么写，照抄，并且**要写注释说明为什么**。
- 页面标题「消息详情」，note「告警与通知的全文」。

### C. `UserListView.vue` ← `UserListScreen.tsx`（534 行，**列表 + 明细面板 + 新增 + 删除 + 重置密码**）
- 方法：`user.list`、`user.create`、`user.detail`、`user.roles`、`user.deleteWithCaptcha`、`user.resetPassword`。
- 列表参数 `{ page, size: PAGE_SIZE }` —— **用户的分页是从 1 开始的**（与消息相反，见 §7.1/§7.2）。
- `user.create` 提交 `{ username, nickname, password, email }`（四个都必填：服务端 `@NotBlank`，
  username ≤32、nickname ≤16、password 6–20、email ≤128 —— 校验文案照 React 的写法）。
- 明细面板：`user.detail` + `user.roles`（角色是**辅助数据**，取不到只说"角色暂时读不到"）。
- 删除用户走 `user.deleteWithCaptcha`：`{ userId, captchaId, captchaCode }` **且必须先有验证码**
  （用 `CaptchaField.vue`，照 `TagListView.vue` 的用法）；验证码为空时按钮旁写明原因。
- 重置密码：`user.resetPassword` `{ userId, oldPassword, newPassword }`，成功文案
  「密码已改好。请把新密码当面告知这位用户。」（逐字）。

### D. `ProfileView.vue` ← `ProfileScreen.tsx`（476 行）
- 方法：`profile.get`、`user.current`、`profile.settings`、`profile.update`、`profile.settingsUpdate`、`user.changePassword`。
- 三块数据各自独立三态（React 就是三块）：基本资料（`profile.get` + `user.current`）、偏好设置（`profile.settings`）、登录密码（写操作）。
- `profile.update` 提交 `{ nickname, email }`；`profile.settingsUpdate` 提交 `{ settings: draft }`
  （`draft` 是 `Record<string, string>`，**从 `profile.settings` 拿到的 map 派生**）。
- `user.changePassword` 提交 `{ oldPassword, newPassword }`（无需 userId，服务端走 `/current/password`）；
  成功文案「登录密码已更新，下次登录请用新密码。」（逐字），并**清空三个输入框**。
- 三个写操作各自有独立的 notice/error 反馈，不要合成一个。

## 4. 非目标（别做）

- **不要实现**服务端存在但 React 屏没用的方法：`profile.avatarUpload`（multipart）、`profile.avatarDelete`、
  `profile.avatarImage`、`user.update`、`user.delete`、`user.assignRoles`、`user.clearRoles`、`user.removeRole`、
  `message.create`、`message.delete`。**移交不等于把这些一起做进来**。
- 不改 registry / 路由 / mock / check 脚本 / `packages/**` / React 版。
- 不引入新依赖、不新增全局样式、不动 token。
- 不跑 `pnpm build` / `pnpm typecheck` / 门禁，不 git add/commit（协调者统一跑）。

## 5. 真后端事实（**权威**，来自仓内服务端源码，别猜）

服务端在 `E:\code_space\WiseDepot\WiseDeoptServer\...\api\controller\{Message,User,Profile,UserRole}Controller.java`。

1. **`user.list` 分页 1 基**：`UserApplicationService#listUsers` 里 `if (page == null || page < 1) page = 1;`
   然后 `PageRequest.of(page - 1, size)`，默认 size=10。返回 **`UserPageDTO { total, items }`**。
2. **`message.list` 分页 0 基**：`MessageApplicationService#queryMessages` 里
   `int start = request.getPage() * request.getSize();` —— 传 1 会跳过第一页。React 传 `page - 1` 是对的。
   查询字段是 `{ receiverId, type, isRead, page, size }`（`MessageQueryRequest`），
   返回 **`List<MessageDTO>`（裸数组）**，不是分页对象。
3. **`message.unreadCount` / `message.markAllRead` / `message.clear` 的 `receiverId` 都是 `@RequestParam` 必填**；
   `message.detail` 的 `messageId` 是 **`@PathVariable String`**（消息 id 是字符串，不是数字）。
4. **DTO 字段**（只读这些，不要造字段）：
   - `MessageDTO`：`id, title, content, type, receiverId, receiverName, relatedEntityType, relatedEntityId, isRead, readTime, createTime, status, priority`
   - `UserDTO`：`userId, username, nickname, avatar, email, enabled, nfcId, createdAt, updatedAt, role`
   - `UserProfileDTO`：`profileId, userId, username, nickname, email, gender, avatarFileId, avatarUrl, status, createTime, updateTime`
   - `UserSettingsDTO`：`{ userId, settings: Map<String,String> }`
   - `UserCreateRequest`：`username`(@NotBlank,≤32) / `nickname`(@NotBlank,≤16) / `password`(@NotBlank,6–20) / `email`(@NotBlank,≤128) / `avatar`/`nfcId`/`pin`/`role`
   - `UserProfileUpdateRequest`：`nickname, email, gender, avatarFileId`
   - `UserSettingsUpdateRequest`：`settings: Map<String,String>`
   - `UserPasswordChangeRequest`：`oldPassword, newPassword`
   - `DeleteWithCaptchaRequest`：`id`（服务端用路径里的 userId 填）、`captchaId`、`captchaCode`
5. `profile.get` / `profile.settings` / `user.current` 在服务端都要 `Authorization` 头；**桥会自己带**，界面不用管。

## 6. 自检清单（报告里逐条 ✅/❌ + 证据）

沿用现场域简报 §9 的 8 条，另外加两条本域特有的：
9. **分页基数是分开对的**：消息屏传 `page - 1`、用户屏传 `page`（1 基），没有把两者写成同一个。
10. **`receiverId` 只在拿得到时发请求**（`user.current` 还没回来时不要发 `receiverId: undefined` 的请求）。
