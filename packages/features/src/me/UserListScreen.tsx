import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataList,
  DataRow,
  Dot,
  Field,
  Input,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  SearchField,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { asList, asTotal, humanize, shortTime } from '../shared/api.js';
import { CaptchaRow, useCaptcha } from '../shared/CaptchaField.js';

/**
 * 用户管理（me/user）。
 *
 * 一个列表屏 + 一块"点谁才出现"的用户详情：详情与角色是**另外两条取数**，
 * 只有选中了某一行才有用户编号，提前发请求只会换来一次没有意义的失败。
 *
 * 删除与重置密码都放在详情块里，不在行内塞小按钮 —— 手机上点不中，
 * 而且这两个动作都应该"先看清是谁，再动手"（ui-spec §3.1 危险操作必须二次确认）。
 * 删除还会再要一次验证码：服务端把它当危险操作，与标签批量绑定同一套机制。
 *
 * 建号表单里没有"角色"字段：建号接口当前不接受角色，摆一个点了不生效的选项比不摆更糟。
 * **角色分配（授予/撤销）不在本次范围内**，详情里只做只读展示。
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

const PAGE_SIZE = 20;

/** 角色码 → 业务叫法；认不出的码原样显示（它是服务端下发的数据，不是我们的文案）。 */
function roleLabel(role: string | undefined): string {
  switch (role) {
    case 'ADMIN':
      return '管理员';
    case 'USER':
      return '普通用户';
    case undefined:
      return '未指派角色';
    default:
      return role;
  }
}

function statusChip(enabled: boolean | undefined): React.ReactElement {
  if (enabled === true) {
    return (
      <Chip tone="ok">
        <Dot tone="ok" />
        已启用
      </Chip>
    );
  }
  if (enabled === false) {
    return (
      <Chip tone="neutral">
        <Dot tone="idle" />
        已停用
      </Chip>
    );
  }
  return <Chip tone="neutral">状态未知</Chip>;
}

export function UserListScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', nickname: '', password: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);

  const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'user.list', {
    page,
    size: PAGE_SIZE,
  });

  const all = asList<UserRow>(data);
  const total = asTotal(data);
  const rows = applied
    ? all.filter((r) =>
        `${r.username ?? ''}${r.nickname ?? ''}${r.email ?? ''}`.toLowerCase().includes(applied.toLowerCase()),
      )
    : all;
  const hasMore = total !== undefined ? page * PAGE_SIZE < total : all.length === PAGE_SIZE;

  const submitCreate = async (): Promise<void> => {
    if (!form.username.trim() || !form.nickname.trim() || !form.password || !form.email.trim()) {
      setActionError('账号、姓名、初始密码与邮箱都要填写');
      return;
    }
    if (form.password.length < 6) {
      setActionError('初始密码至少 6 位');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('user.create', {
        username: form.username.trim(),
        nickname: form.nickname.trim(),
        password: form.password,
        email: form.email.trim(),
      });
      setCreating(false);
      setForm({ username: '', nickname: '', password: '', email: '' });
      setPage(1);
      reload();
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="用户管理"
        subtitle={total !== undefined ? `共 ${total} 位用户` : '维护账号与基础资料'}
        actions={
          <>
            <Button ariaLabel="刷新" onClick={reload}>
              刷新
            </Button>
            <Button variant="primary" ariaLabel="新增用户" onClick={() => setCreating((v) => !v)}>
              {creating ? '收起' : '新增'}
            </Button>
          </>
        }
      />

      {creating ? (
        <Section title="新增用户">
          <Card>
            <Stack>
              <Field label="账号 *">
                <Input
                  value={form.username}
                  onChange={(v) => setForm((f) => ({ ...f, username: v }))}
                  placeholder="登录用的账号"
                  mono
                />
              </Field>
              <Field label="姓名 *">
                <Input
                  value={form.nickname}
                  onChange={(v) => setForm((f) => ({ ...f, nickname: v }))}
                  placeholder="显示姓名，如：张三"
                />
              </Field>
              <Field label="初始密码 *">
                <Input
                  value={form.password}
                  onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                  type="password"
                  placeholder="至少 6 位"
                />
              </Field>
              <Field label="邮箱 *">
                <Input
                  value={form.email}
                  onChange={(v) => setForm((f) => ({ ...f, email: v }))}
                  placeholder="用于接收通知，如：name@example.com"
                />
              </Field>
              {actionError ? (
                <div className="w-state w-state--error">
                  <span>{actionError}</span>
                </div>
              ) : null}
              <div className="w-state">
                <span>建好之后请把账号与初始密码告知使用者，并提醒对方尽快在“个人资料”里改掉。</span>
              </div>
              <Toolbar>
                <Button ariaLabel="取消" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button variant="primary" ariaLabel="保存" disabled={busy} onClick={() => void submitCreate()}>
                  {busy ? '保存中…' : '保存'}
                </Button>
              </Toolbar>
            </Stack>
          </Card>
        </Section>
      ) : actionError ? (
        <div className="w-state w-state--error">
          <span>{actionError}</span>
        </div>
      ) : null}

      <SearchField
        value={keyword}
        onChange={setKeyword}
        onSearch={() => {
          setApplied(keyword);
          setPage(1);
        }}
        placeholder="账号 / 姓名 / 邮箱"
      />

      <Section title={`用户列表${applied ? `（含「${applied}」）` : ''}`}>
        <Card flush>
          <ListStateHost
            loading={loading}
            error={error ? { code: error.code, text: humanize(error) } : undefined}
            items={rows}
            emptyText={
              applied
                ? '没有匹配的用户，试试换个关键词。'
                : '还没有用户。点右上角「新增」创建第一个账号，之后再分配角色与权限。'
            }
            onRetry={reload}
          >
            {(items) => (
              <DataList>
                {items.map((u) => (
                  <DataRow
                    key={u.userId ?? u.username}
                    id={u.username}
                    main={u.nickname ?? '未填写姓名'}
                    sub={
                      <>
                        <span className="w-muted">{roleLabel(u.role)}</span>
                        {u.email ? <span className="w-muted"> · {u.email}</span> : null}
                        {u.createdAt ? (
                          <span className="w-mono"> · {shortTime(u.createdAt) || '时间未记录'}</span>
                        ) : null}
                      </>
                    }
                    trailing={statusChip(u.enabled)}
                    active={u.userId !== undefined && u.userId === selected}
                    onSelect={() => setSelected(u.userId)}
                  />
                ))}
              </DataList>
            )}
          </ListStateHost>
        </Card>
      </Section>

      <Toolbar>
        <Button ariaLabel="上一页" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          上一页
        </Button>
        <span className="w-chip w-mono">{`第 ${page} 页`}</span>
        <Button ariaLabel="下一页" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
        <span className="w-muted w-mono">{`本页 ${all.length} 位`}</span>
      </Toolbar>

      {selected !== undefined ? (
        <UserDetailPanel
          key={selected}
          bridge={bridge}
          userId={selected}
          onClose={() => setSelected(undefined)}
          onDeleted={() => {
            setSelected(undefined);
            reload();
          }}
        />
      ) : (
        <div className="w-state">
          <span>点某一位用户，可以查看资料、重置密码或删除账号。</span>
        </div>
      )}
    </Stack>
  );
}

/**
 * 用户详情块：点中某一行之后才挂上，因此它自己的取数（详情 + 角色）也才发出去。
 *
 * 这里的两个动作都是不可逆或影响他人登录的，所以都要二次确认；
 * 删除还要验证码 —— 与标签批量绑定是同一套机制，失败后必须换一张图。
 */
function UserDetailPanel({
  bridge,
  userId,
  onClose,
  onDeleted,
}: {
  bridge: Bridge;
  userId: number;
  onClose: () => void;
  onDeleted: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const captcha = useCaptcha(bridge);

  const detail = useBridgeCall<UserRow>(bridge, 'user.detail', { userId });
  const roles = useBridgeCall<unknown>(bridge, 'user.roles', { userId });
  const roleRows = asList<RoleRow>(roles.data);

  const confirmDelete = async (): Promise<void> => {
    if (busy) {
      return;
    }
    if (!captcha.code.trim()) {
      setActionError('请先填写验证码');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('user.deleteWithCaptcha', {
        userId,
        captchaId: captcha.captchaId,
        captchaCode: captcha.code.trim(),
      });
      setDeleting(false);
      onDeleted();
    } catch (e) {
      setActionError(humanize(e as never));
      // 验证码是一次性的：失败就换一张，别让用户对着作废的图反复提交
      captcha.refreshAfterFailure();
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (): Promise<void> => {
    if (busy) {
      return;
    }
    if (!pw.oldPassword || !pw.newPassword) {
      setActionError('请填写这位用户现在的密码与要换成的密码');
      return;
    }
    if (pw.newPassword.length < 6) {
      setActionError('新密码至少 6 位');
      return;
    }
    if (pw.newPassword !== pw.confirm) {
      setActionError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await bridge.call('user.resetPassword', {
        userId,
        oldPassword: pw.oldPassword,
        newPassword: pw.newPassword,
      });
      setResetting(false);
      setPw({ oldPassword: '', newPassword: '', confirm: '' });
      setNotice('密码已改好。请把新密码当面告知这位用户。');
    } catch (e) {
      setActionError(humanize(e as never));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="用户详情">
      <Card>
        <Stack>
          <ListStateHost
            loading={detail.loading}
            error={detail.error ? { code: detail.error.code, text: humanize(detail.error) } : undefined}
            items={detail.data ? [detail.data] : []}
            emptyText="这位用户的资料暂时取不到。返回列表刷新一次再点开。"
            onRetry={detail.reload}
          >
            {(items) => {
              const u = items[0];
              return u ? (
                <Stack>
                  <KeyValue k="账号" v={<Mono>{u.username ?? `编号 ${u.userId ?? userId}`}</Mono>} />
                  <KeyValue k="姓名" v={u.nickname ?? '未填写'} />
                  <KeyValue k="邮箱" v={u.email ?? '未填写'} />
                  <KeyValue k="角色" v={roleLabel(u.role)} />
                  <KeyValue
                    k="账号状态"
                    v={u.enabled === true ? '已启用，可登录' : u.enabled === false ? '已停用，无法登录' : '状态未知'}
                  />
                  <KeyValue k="创建时间" v={<span className="w-mono">{shortTime(u.createdAt) || '时间未记录'}</span>} />
                </Stack>
              ) : null;
            }}
          </ListStateHost>

          {/* 角色只读展示：授予/撤销角色属于权限管理，不在本次范围内，故意不做入口 */}
          <ListStateHost
            loading={roles.loading}
            error={roles.error ? { code: roles.error.code, text: humanize(roles.error) } : undefined}
            items={roleRows}
            emptyText="这位用户还没有分配角色。角色由管理员在权限模块里指派。"
            onRetry={roles.reload}
          >
            {(items) => (
              <Stack row>
                {items.map((r) => (
                  <Chip key={r.roleId ?? r.name} tone="info">
                    {r.name ?? r.roleCode ?? '未命名角色'}
                  </Chip>
                ))}
              </Stack>
            )}
          </ListStateHost>

          {notice ? (
            <div className="w-state">
              <span>{notice}</span>
            </div>
          ) : null}

          {actionError ? (
            <div className="w-state w-state--error">
              <span>{actionError}</span>
            </div>
          ) : null}

          <Toolbar>
            <Button
              ariaLabel="重置密码"
              disabled={busy}
              onClick={() => {
                setActionError(undefined);
                setNotice(undefined);
                setPw({ oldPassword: '', newPassword: '', confirm: '' });
                setResetting(true);
              }}
            >
              重置密码
            </Button>
            <Button
              variant="danger"
              ariaLabel="删除用户"
              disabled={busy}
              onClick={() => {
                setActionError(undefined);
                setNotice(undefined);
                captcha.refresh();
                setDeleting(true);
              }}
            >
              删除用户
            </Button>
            <Button ariaLabel="收起详情" onClick={onClose}>
              收起
            </Button>
          </Toolbar>
        </Stack>
      </Card>

      <ConfirmDialog
        open={resetting}
        title="重置登录密码"
        danger
        confirmLabel="确认改密码"
        message={
          <Stack>
            <span>
              改密码前要先确认身份，所以需要这位用户此刻正在用的那个密码；如果他本人也记不清了，请让他先重置自己的密码再来操作。
            </span>
            <Field label="该用户当前的密码 *">
              <Input
                value={pw.oldPassword}
                onChange={(v) => setPw((p) => ({ ...p, oldPassword: v }))}
                type="password"
                placeholder="他现在的登录密码"
              />
            </Field>
            <Field label="要换成的密码 *">
              <Input
                value={pw.newPassword}
                onChange={(v) => setPw((p) => ({ ...p, newPassword: v }))}
                type="password"
                placeholder="至少 6 位"
              />
            </Field>
            <Field label="再输一次新密码 *">
              <Input
                value={pw.confirm}
                onChange={(v) => setPw((p) => ({ ...p, confirm: v }))}
                type="password"
                placeholder="确认用"
              />
            </Field>
            {actionError ? (
              <span className="w-state w-state--error">{actionError}</span>
            ) : null}
          </Stack>
        }
        onConfirm={() => void submitReset()}
        onCancel={() => setResetting(false)}
      />

      <ConfirmDialog
        open={deleting}
        title="删除用户"
        danger
        confirmLabel="删除"
        message={
          <Stack>
            <span>
              将删除 <Mono>{detail.data?.username ?? `编号 ${userId}`}</Mono> 及其资料、角色与刷卡记录，删除后无法恢复。
            </span>
            <span className="w-muted">他之后将无法用这个账号登录，历史记录也会一并清理。</span>
            <CaptchaRow state={captcha} label="验证码 *" />
            {actionError ? (
              <span className="w-state w-state--error">{actionError}</span>
            ) : null}
          </Stack>
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(false)}
      />
    </Section>
  );
}
