#!/usr/bin/env node
/**
 * check-me-mock.mjs —— 「我的」域假桥（消息 / 用户 / 个人资料）的回归护栏。
 *
 * ## 为什么值得单独写一条
 *
 * 这一域有两条**只差一个数字**的分页口径，而且都来自服务端源码：
 *   · 消息是 **0 基**（`MessageApplicationService#queryMessages`：`start = page * size`）
 *   · 用户是 **1 基**（`UserApplicationService#listUsers`：`page < 1 → 1`，再 `PageRequest.of(page - 1, size)`）
 * 把两者写成同一个，界面就会"第一页永远是空的 / 第 2 页重复第 1 页"，
 * 而且**不报错**。这条护栏把两边的边界都钉住。
 *
 * 另外三条同样是"不报错只做错事"的：
 *   · 标已读之后未读数要**减一**、全部已读要归零（否则"数字不动"在开发态永远看不出）；
 *   · `message.clear` 只能清**当前收件人**的（清错人就是越权删）；
 *   · 用户新建的校验文案要逐字等于服务端 `@NotBlank/@Size` 的注解文案（界面不该自己编一套）。
 *
 * 用 esbuild 打一次包再 import（本仓没有 ts 运行时，esbuild 已是依赖）。
 *
 * 用法：node tools/check/check-me-mock.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'mock-me.ts');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-me-mock-'));
const outFile = path.join(outDir, 'mock-me.cjs');

let passed = 0;
const failures = [];

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${what}${detail === '' ? '' : ` —— ${detail}`}`);
}

/** 调一次假桥；抛出来的 BridgeError 作为返回值，方便断言"拒绝了、以及理由"。 */
function call(mock, method, params) {
  try {
    return { ok: true, value: mock.call(method, params) };
  } catch (error) {
    return { ok: false, code: error?.code, details: String(error?.details ?? '') };
  }
}

const idsOf = (rows) => (Array.isArray(rows) ? rows.map((r) => r.id ?? r.userId) : []);

try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    outfile: outFile,
  });

  const mod = await import(pathToFileURL(outFile).href);
  const MeMock = mod.MeMock;
  if (typeof MeMock !== 'function') {
    console.error('✗ mock-me.ts 没有导出 MeMock');
    process.exit(1);
  }

  // ---- 1. 消息：按收件人过滤 + 0 基分页 ----
  {
    const mock = new MeMock();
    const mine = call(mock, 'message.list', { receiverId: 1, page: 0, size: 20 });
    check('收件人 1 有 5 条消息', Array.isArray(mine.value) && mine.value.length === 5, `len=${mine.value?.length}`);
    check('回的是裸数组（服务端返回 List<MessageDTO>）', Array.isArray(mine.value));

    const others = call(mock, 'message.list', { receiverId: 2, page: 0, size: 20 });
    check('换个人只看到自己的（按收件人过滤真的生效）', Array.isArray(others.value) && others.value.length === 1, `len=${others.value?.length}`);

    check(
      '按 createTime 倒序（最新的在最前）',
      mine.value[0]?.id === 'MSG-20260106-004',
      `first=${mine.value[0]?.id}`,
    );

    const p0 = call(mock, 'message.list', { receiverId: 1, page: 0, size: 2 });
    const p1 = call(mock, 'message.list', { receiverId: 1, page: 1, size: 2 });
    check('0 基分页：page=0 取到最新的两条', idsOf(p0.value).join(',') === 'MSG-20260106-004,MSG-20260106-003', idsOf(p0.value).join(','));
    check('0 基分页：page=1 与 page=0 不重复（传 1 才是第二页）', idsOf(p1.value).join(',') === 'MSG-20260106-002,MSG-20260105-002', idsOf(p1.value).join(','));

    const typed = call(mock, 'message.list', { receiverId: 1, page: 0, size: 20, type: 'SYSTEM' });
    check('按类型过滤可用', idsOf(typed.value).length === 2, idsOf(typed.value).join(','));
    const unreadOnly = call(mock, 'message.list', { receiverId: 1, page: 0, size: 20, isRead: false });
    check('按已读状态过滤可用', idsOf(unreadOnly.value).length === 3, idsOf(unreadOnly.value).join(','));
  }

  // ---- 2. 未读数：标已读要减、全部已读要归零 ----
  {
    const mock = new MeMock();
    check('初始未读 3 条', call(mock, 'message.unreadCount', { receiverId: 1 }).value === 3, `value=${call(mock, 'message.unreadCount', { receiverId: 1 }).value}`);
    check('别人的未读数互不影响', call(mock, 'message.unreadCount', { receiverId: 2 }).value === 1);

    const before = call(mock, 'message.detail', { messageId: 'MSG-20260106-004' }).value;
    check('这条本来是未读', before.isRead === false);
    const marked = call(mock, 'message.markRead', { messageId: 'MSG-20260106-004' });
    check('标已读回的是这条消息本身（服务端回 MessageDTO）', marked.ok && marked.value?.isRead === true);
    check('并且写上了 readTime', typeof marked.value?.readTime === 'string', `readTime=${marked.value?.readTime}`);
    check('未读数随之减一', call(mock, 'message.unreadCount', { receiverId: 1 }).value === 2);

    const again = call(mock, 'message.markRead', { messageId: 'MSG-20260106-004' });
    check('重复标已读不报错（幂等）', again.ok === true);

    call(mock, 'message.markAllRead', { receiverId: 1 });
    check('全部已读后未读数归零', call(mock, 'message.unreadCount', { receiverId: 1 }).value === 0);
    check('别人的未读数仍然不受影响', call(mock, 'message.unreadCount', { receiverId: 2 }).value === 1);

    const missingParam = call(mock, 'message.markAllRead', {});
    check('全部已读缺收件人 → VAL-0001', missingParam.ok === false && missingParam.code === 'VAL-0001', JSON.stringify(missingParam).slice(0, 120));
    const unreadMissing = call(mock, 'message.unreadCount', {});
    check('未读数缺收件人 → VAL-0001（服务端是 @RequestParam 必填）', unreadMissing.ok === false && unreadMissing.code === 'VAL-0001');
  }

  // ---- 3. 清空消息：只清自己的 ----
  {
    const mock = new MeMock();
    const missing = call(mock, 'message.clear', {});
    check('清空缺收件人 → VAL-0001', missing.ok === false && missing.code === 'VAL-0001');

    call(mock, 'message.clear', { receiverId: 1 });
    check('清空之后自己的列表为空', idsOf(call(mock, 'message.list', { receiverId: 1, page: 0, size: 20 }).value).length === 0);
    check(
      '**没有把别人的消息一起删掉**',
      idsOf(call(mock, 'message.list', { receiverId: 2, page: 0, size: 20 }).value).length === 1,
      idsOf(call(mock, 'message.list', { receiverId: 2, page: 0, size: 20 }).value).join(','),
    );
  }

  // ---- 4. 消息详情：id 是字符串，找不到要如实报错 ----
  {
    const mock = new MeMock();
    const found = call(mock, 'message.detail', { messageId: 'MSG-20260105-001' });
    check('按字符串 id 取到详情', found.ok && found.value?.id === 'MSG-20260105-001');
    const ghost = call(mock, 'message.detail', { messageId: 'MSG-NOPE' });
    check('取不到 → RES-0004 且原话带上 id', ghost.ok === false && ghost.code === 'RES-0004' && ghost.details.includes('MSG-NOPE'), JSON.stringify(ghost).slice(0, 140));
    const ghostRead = call(mock, 'message.markRead', { messageId: 'MSG-NOPE' });
    check('给不存在的消息标已读 → RES-0004', ghostRead.ok === false && ghostRead.code === 'RES-0004');
  }

  // ---- 5. 用户列表：1 基分页 ----
  {
    const mock = new MeMock();
    const p1 = call(mock, 'user.list', { page: 1, size: 2 });
    check('回的是 UserPageDTO 形状（total + items）', typeof p1.value?.total === 'number' && Array.isArray(p1.value?.items), JSON.stringify(p1.value).slice(0, 80));
    check('总数 6 位用户', p1.value.total === 6, `total=${p1.value.total}`);
    check('第 1 页 2 条', p1.value.items.length === 2, `len=${p1.value.items.length}`);

    const p2 = call(mock, 'user.list', { page: 2, size: 2 });
    check('第 2 页换了人', idsOf(p2.value.items).join(',') !== idsOf(p1.value.items).join(','), `${idsOf(p1.value.items)} vs ${idsOf(p2.value.items)}`);

    const zero = call(mock, 'user.list', { page: 0, size: 2 });
    check(
      '1 基分页：page=0 被当成第 1 页（服务端 `page < 1 → 1`）',
      idsOf(zero.value.items).join(',') === idsOf(p1.value.items).join(','),
      `${idsOf(zero.value.items)} vs ${idsOf(p1.value.items)}`,
    );

    const last = call(mock, 'user.list', { page: 3, size: 2 });
    check('最后一页只回剩下的 2 条', last.value.items.length === 2, `len=${last.value.items.length}`);
    const empty = call(mock, 'user.list', { page: 9, size: 2 });
    check('越界页回空数组（不是报错）', Array.isArray(empty.value.items) && empty.value.items.length === 0);
    check('默认每页 10 条（服务端 size 缺省是 10）', call(mock, 'user.list', {}).value.items.length === 6);
  }

  // ---- 6. 用户详情 / 角色 ----
  {
    const mock = new MeMock();
    const detail = call(mock, 'user.detail', { userId: 1 });
    check('用户详情含侧栏要读的字段（nickname/role）', detail.ok && detail.value?.nickname === '现场操作员' && detail.value?.role === 'USER', JSON.stringify(detail.value ?? {}).slice(0, 100));
    const ghost = call(mock, 'user.detail', { userId: 999 });
    check('用户不存在 → RES-0004「用户不存在」', ghost.ok === false && ghost.code === 'RES-0004' && ghost.details.includes('用户不存在'));

    const roles = call(mock, 'user.roles', { userId: 1 });
    check('用户的角色能读（RoleDTO 形状）', Array.isArray(roles.value) && roles.value.length === 2 && typeof roles.value[0]?.name === 'string', JSON.stringify(roles.value ?? []).slice(0, 100));
    check('没有角色的用户回空数组', Array.isArray(call(mock, 'user.roles', { userId: 5 }).value) && call(mock, 'user.roles', { userId: 5 }).value.length === 0);
  }

  // ---- 7. 新建用户：校验文案逐字来自服务端注解 ----
  {
    const mock = new MeMock();
    const cases = [
      [{ nickname: 'x', password: 'abcdef', email: 'a@b.c' }, '用户名不能为空'],
      [{ username: 'a'.repeat(33), nickname: 'x', password: 'abcdef', email: 'a@b.c' }, '用户名长度不能超过32个字符'],
      [{ username: 'brand-new', password: 'abcdef', email: 'a@b.c' }, '昵称不能为空'],
      [{ username: 'brand-new', nickname: '甲'.repeat(17), password: 'abcdef', email: 'a@b.c' }, '昵称长度不能超过16个字符'],
      [{ username: 'brand-new', nickname: '新同事', email: 'a@b.c' }, '密码不能为空'],
      [{ username: 'brand-new', nickname: '新同事', password: '12345', email: 'a@b.c' }, '密码长度必须在6-20个字符之间'],
      [{ username: 'brand-new', nickname: '新同事', password: 'abcdef' }, '邮箱不能为空'],
    ];
    for (const [params, expected] of cases) {
      const result = call(mock, 'user.create', params);
      check(`新建用户校验：${expected}`, result.ok === false && result.details === expected, `${result.details}`);
    }
    const dup = call(mock, 'user.create', { username: 'operator', nickname: '重名', password: 'abcdef', email: 'a@b.c' });
    check('用户名重复 → 拒绝', dup.ok === false && dup.details.includes('用户名已存在'), dup.details);

    const created = call(mock, 'user.create', { username: 'brand-new', nickname: '新同事', password: 'abcdef', email: 'a@b.c' });
    check('合法数据建号成功并回 userId', created.ok && typeof created.value?.userId === 'number', JSON.stringify(created).slice(0, 120));
    check('新用户默认可用', created.value?.enabled === true);
    const after = call(mock, 'user.list', { page: 1, size: 10 });
    check('列表总数变成 7', after.value.total === 7, `total=${after.value.total}`);
    check('新用户在最前面（按创建时间倒序）', idsOf(after.value.items)[0] === created.value.userId, idsOf(after.value.items).join(','));
  }

  // ---- 8. 删除用户（带验证码）/ 重置密码 ----
  {
    const mock = new MeMock();
    const noCaptcha = call(mock, 'user.deleteWithCaptcha', { userId: 5, captchaId: 'c1', captchaCode: '' });
    check('没填验证码 → VAL-0001', noCaptcha.ok === false && noCaptcha.code === 'VAL-0001', JSON.stringify(noCaptcha).slice(0, 120));
    check('被拒时用户还在', call(mock, 'user.detail', { userId: 5 }).ok === true);

    const deleted = call(mock, 'user.deleteWithCaptcha', { userId: 5, captchaId: 'c1', captchaCode: '13' });
    check('填了验证码就删掉', deleted.ok === true);
    check('删完之后查不到这个用户', call(mock, 'user.detail', { userId: 5 }).ok === false);
    check('列表总数变成 5', call(mock, 'user.list', { page: 1, size: 10 }).value.total === 5);
    check('删不存在的用户 → RES-0004', call(mock, 'user.deleteWithCaptcha', { userId: 5, captchaCode: '13' }).ok === false);

    const shortPw = call(mock, 'user.resetPassword', { userId: 1, oldPassword: 'x', newPassword: '123' });
    check('重置密码：新密码太短 → VAL-0001', shortPw.ok === false && shortPw.details.includes('6-20'), shortPw.details);
    const okPw = call(mock, 'user.resetPassword', { userId: 1, oldPassword: 'x', newPassword: 'abcdefgh' });
    check('重置密码：合法就通过', okPw.ok === true);
  }

  // ---- 9. 个人资料 / 偏好设置 / 改密码 ----
  {
    const mock = new MeMock();
    const initial = call(mock, 'profile.get');
    check('资料卡初始昵称', initial.value?.nickname === '现场操作员' && initial.value?.username === 'operator', JSON.stringify(initial.value ?? {}).slice(0, 100));

    const empty = call(mock, 'profile.update', { nickname: '  ', email: 'a@b.c' });
    check('昵称留空 → VAL-0001', empty.ok === false && empty.code === 'VAL-0001');
    const updated = call(mock, 'profile.update', { nickname: '张现场', email: 'zhang@wise.local' });
    check('改完资料回的是新值', updated.ok && updated.value?.nickname === '张现场' && updated.value?.email === 'zhang@wise.local');
    check('再查一次确实是新的（写生效了）', call(mock, 'profile.get').value?.nickname === '张现场');

    const settings = call(mock, 'profile.settings');
    check('偏好设置是 {userId, settings} 形状', typeof settings.value?.settings === 'object' && settings.value.settings !== null, JSON.stringify(settings.value ?? {}).slice(0, 100));
    check('样例设置非空（界面按 entries 通用渲染）', Object.keys(settings.value.settings).length >= 3);
    const saved = call(mock, 'profile.settingsUpdate', { settings: { 'ui.theme': 'dark' } });
    check('保存偏好设置回的是保存后的结果', saved.ok && saved.value?.settings['ui.theme'] === 'dark' && Object.keys(saved.value.settings).length === 1, JSON.stringify(saved.value ?? {}).slice(0, 100));
    check('再查一次确实是保存后的', call(mock, 'profile.settings').value?.settings['ui.theme'] === 'dark');
    const badSettings = call(mock, 'profile.settingsUpdate', { settings: 'nope' });
    check('偏好设置格式不对 → VAL-0001', badSettings.ok === false && badSettings.code === 'VAL-0001');

    const noOld = call(mock, 'user.changePassword', { oldPassword: '', newPassword: 'abcdefgh' });
    check('改密码：原密码为空 → VAL-0001', noOld.ok === false && noOld.code === 'VAL-0001');
    const short = call(mock, 'user.changePassword', { oldPassword: 'x', newPassword: '123' });
    check('改密码：新密码太短 → VAL-0001', short.ok === false && short.details.includes('6-20'), short.details);
    const okPw = call(mock, 'user.changePassword', { oldPassword: 'x', newPassword: 'abcdefgh' });
    check('改密码：合法就通过', okPw.ok === true);
  }

  // ---- 10. 不管不属于自己的方法（别把没实现的方法假装实现了） ----
  {
    const mock = new MeMock();
    check('user.current 有侧栏要读的字段', mock.call('user.current', {})?.userId === 1 && mock.call('user.current', {})?.role === 'USER');
    check('React 屏没用的写方法不归它管（交给别的 mock / 如实报未知）', mock.call('user.update', {}) === undefined && mock.call('profile.avatarUpload', {}) === undefined && mock.call('user.assignRoles', {}) === undefined);
    check('库存域的方法仍然不管', mock.call('inventory.list', {}) === undefined);
  }

  // ---- 11. 角色词表必须与服务端**产出的那两个码**一致 ----
  //
  // 服务端只产出 ADMIN / USER（`RoleMapper`：管理员→ADMIN，操作员/访客/其它→USER），
  // 而种子角色有三个名字（`DataInitializer`：1 管理员 / 2 操作员 / 3 访客）—— 也就是说 USER 是**有损**的。
  // 假桥若自己发明 OPERATOR / VIEWER，开发态显示的就是服务端永远不下发的词，
  // 到真机上换成另一个词，而这类偏差在开发态**看不出来**。这条护栏就是钉住它。
  {
    const mock = new MeMock();
    const SERVER_CODES = ['ADMIN', 'USER'];
    const users = mock.call('user.list', { page: 1, size: 50 }).items;
    const badUser = users.filter((u) => !SERVER_CODES.includes(String(u.role)));
    check(
      '假桥里的用户角色码只能是服务端会产出的 ADMIN / USER',
      users.length > 0 && badUser.length === 0,
      `非法=${badUser.map((u) => `${u.username}:${u.role}`).join(',')}`,
    );

    const roles = call(mock, 'user.roles', { userId: 1 }).value;
    const badRole = roles.filter((r) => !SERVER_CODES.includes(String(r.roleCode)));
    check(
      '角色目录的 roleCode 同样只能有 ADMIN / USER（两个中文角色名共用一个码是有意的）',
      roles.length > 0 && badRole.length === 0,
      `非法=${badRole.map((r) => `${r.name}:${r.roleCode}`).join(',')}`,
    );

    check(
      '同一用户的两个角色（操作员 / 访客）都落在 USER 上——这是服务端 RoleMapper 的有损压缩，不是假桥的错',
      roles.length === 2 &&
        roles.every((r) => r.roleCode === 'USER') &&
        roles.some((r) => r.name === '操作员') &&
        roles.some((r) => r.name === '访客'),
      JSON.stringify(roles),
    );
  }
} catch (error) {
  console.error(`✗ 护栏执行失败：${error?.stack ?? error}`);
  process.exit(1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f}`);
  }
  console.error(`check-me-mock: ${failures.length}/${passed + failures.length} 个用例失败`);
  process.exit(1);
}
console.log(`check-me-mock OK: ${passed} 个用例（0 基/1 基分页 / 未读数联动 / 清空不越权 / 校验文案逐字 / 写后可见）`);
