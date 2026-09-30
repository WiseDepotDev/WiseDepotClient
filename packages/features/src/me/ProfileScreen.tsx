import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Field,
  Input,
  KeyValue,
  ListStateHost,
  Mono,
  PageHeader,
  Section,
  Stack,
  Toolbar,
} from '@wise/patterns';
import type { Bridge } from '@wise/bridge-client';
import { useBridgeCall } from '../shared/useBridgeCall.js';
import { humanize, shortTime } from '../shared/api.js';

/**
 * 个人资料（me/profile）。
 *
 * 一屏里三块取数：基本资料、登录账号、偏好设置。各自独立成卡、各自四态齐全 ——
 * 把三份数据揉进一个状态机会让"某一项取不到"变成"整屏打不开"。
 *
 * 改密码单独成区并二次确认：它是本屏唯一会影响下次登录的动作，
 * 不能让它在表单里和"改昵称"长得一样（ui-spec 3.1 危险操作必须二次确认）。
 * 偏好设置只允许改**系统下发的项**，不给"新增一项"的入口 ——
 * 增量当前不落库，摆一个点了不生效的输入框比不摆更糟。
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
  readonly oldPassword: string;
  readonly newPassword: string;
  readonly confirm: string;
}

/** 偏好项的键 → 业务叫法；没登记过的键原样显示（它是服务端下发的数据）。 */
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

type RoleText = string | undefined;

function roleLabel(role: RoleText): string {
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

/** 提交前的本地校验：消息文案就是用户看到的提示，先把话想清楚再写代码。 */
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

export function ProfileScreen({ bridge }: { bridge: Bridge }): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ nickname: '', email: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | undefined>(undefined);
  const [profileNotice, setProfileNotice] = useState<string | undefined>(undefined);

  const [prefDraft, setPrefDraft] = useState<Record<string, string> | undefined>(undefined);
  const [savingPref, setSavingPref] = useState(false);
  const [prefError, setPrefError] = useState<string | undefined>(undefined);
  const [prefNotice, setPrefNotice] = useState<string | undefined>(undefined);

  const [pwForm, setPwForm] = useState<PasswordForm>({ oldPassword: '', newPassword: '', confirm: '' });
  const [pwConfirming, setPwConfirming] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | undefined>(undefined);
  const [pwNotice, setPwNotice] = useState<string | undefined>(undefined);

  const profile = useBridgeCall<ProfileData>(bridge, 'profile.get');
  const me = useBridgeCall<CurrentUser>(bridge, 'user.current');
  const settings = useBridgeCall<SettingsData>(bridge, 'profile.settings');

  const settingsMap: Readonly<Record<string, string>> = settings.data?.settings ?? {};
  const prefEntries = Object.entries(settingsMap);

  const reloadAll = (): void => {
    profile.reload();
    me.reload();
    settings.reload();
  };

  const submitProfile = async (): Promise<void> => {
    if (!form.nickname.trim() || !form.email.trim()) {
      setProfileError('姓名与邮箱都要填写');
      return;
    }
    setSavingProfile(true);
    setProfileError(undefined);
    setProfileNotice(undefined);
    try {
      await bridge.call('profile.update', { nickname: form.nickname.trim(), email: form.email.trim() });
      setEditing(false);
      setProfileNotice('资料已更新。');
      reloadAll();
    } catch (e) {
      setProfileError(humanize(e as never));
    } finally {
      setSavingProfile(false);
    }
  };

  const submitPrefs = async (): Promise<void> => {
    const draft = prefDraft;
    if (!draft) {
      return;
    }
    setSavingPref(true);
    setPrefError(undefined);
    setPrefNotice(undefined);
    try {
      await bridge.call('profile.settingsUpdate', { settings: draft });
      setPrefDraft(undefined);
      setPrefNotice('偏好设置已保存，下面显示的是保存后的结果。');
      settings.reload();
    } catch (e) {
      setPrefError(humanize(e as never));
    } finally {
      setSavingPref(false);
    }
  };

  const submitPassword = async (): Promise<void> => {
    const problem = passwordProblem(pwForm);
    if (problem) {
      setPwConfirming(false);
      setPwError(problem);
      return;
    }
    setPwBusy(true);
    setPwError(undefined);
    setPwNotice(undefined);
    try {
      await bridge.call('user.changePassword', {
        oldPassword: pwForm.oldPassword,
        newPassword: pwForm.newPassword,
      });
      setPwConfirming(false);
      setPwForm({ oldPassword: '', newPassword: '', confirm: '' });
      setPwNotice('登录密码已更新，下次登录请用新密码。');
    } catch (e) {
      setPwError(humanize(e as never));
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="个人资料"
        subtitle="账号信息、联系方式与安全设置"
        actions={
          <Button ariaLabel="刷新" onClick={reloadAll}>
            刷新
          </Button>
        }
      />

      <Section title="基本资料">
        <Card>
          <ListStateHost
            loading={profile.loading}
            error={profile.error ? { code: profile.error.code, text: humanize(profile.error) } : undefined}
            items={profile.data ? [profile.data] : []}
            emptyText="资料暂时取不到。点右上角「刷新」再试一次；如果一直这样，请联系管理员。"
            onRetry={profile.reload}
          >
            {(items) => {
              const p = items[0];
              return p ? (
                <Stack>
                  <KeyValue k="账号" v={<Mono>{p.username ?? '未记录'}</Mono>} />
                  <KeyValue k="姓名" v={p.nickname ?? '未填写'} />
                  <KeyValue k="邮箱" v={p.email ?? '未填写'} />
                  <KeyValue k="性别" v={genderLabel(p.gender)} />
                  <KeyValue k="注册时间" v={<span className="w-mono">{shortTime(p.createTime) || '时间未记录'}</span>} />
                  <KeyValue k="最近更新" v={<span className="w-mono">{shortTime(p.updateTime) || '无记录'}</span>} />
                </Stack>
              ) : null;
            }}
          </ListStateHost>
        </Card>
      </Section>

      <Section title="登录账号">
        <Card>
          <ListStateHost
            loading={me.loading}
            error={me.error ? { code: me.error.code, text: humanize(me.error) } : undefined}
            items={me.data ? [me.data] : []}
            emptyText="登录信息暂时取不到。点右上角「刷新」再试一次。"
            onRetry={me.reload}
          >
            {(items) => {
              const u = items[0];
              return u ? (
                <Stack>
                  <KeyValue k="登录账号" v={<Mono>{u.username ?? '未记录'}</Mono>} />
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
        </Card>
      </Section>

      {editing ? (
        <Section title="修改资料">
          <Card>
            <Stack>
              <Field label="姓名 *">
                <Input
                  value={form.nickname}
                  onChange={(v) => setForm((f) => ({ ...f, nickname: v }))}
                  placeholder="显示给同事看的名字"
                />
              </Field>
              <Field label="邮箱 *">
                <Input
                  value={form.email}
                  onChange={(v) => setForm((f) => ({ ...f, email: v }))}
                  placeholder="如：name@example.com"
                />
              </Field>
              {profileError ? (
                <div className="w-state w-state--error">
                  <span>{profileError}</span>
                </div>
              ) : null}
              <Toolbar>
                <Button ariaLabel="取消" onClick={() => setEditing(false)}>
                  取消
                </Button>
                <Button variant="primary" ariaLabel="保存资料" disabled={savingProfile} onClick={() => void submitProfile()}>
                  {savingProfile ? '保存中…' : '保存'}
                </Button>
              </Toolbar>
            </Stack>
          </Card>
        </Section>
      ) : (
        <Toolbar>
          <Button
            ariaLabel="修改资料"
            onClick={() => {
              setProfileError(undefined);
              setProfileNotice(undefined);
              setForm({ nickname: profile.data?.nickname ?? '', email: profile.data?.email ?? '' });
              setEditing(true);
            }}
          >
            修改资料
          </Button>
          {profileNotice ? <span className="w-muted">{profileNotice}</span> : null}
        </Toolbar>
      )}

      <Section title="偏好设置">
        <Card>
          {prefDraft ? (
            <Stack>
              {Object.entries(prefDraft).map(([key, value]) => (
                <Field key={key} label={settingLabel(key)}>
                  <Input
                    value={value}
                    onChange={(v) => setPrefDraft((d) => (d ? { ...d, [key]: v } : d))}
                    placeholder="输入新的取值"
                  />
                </Field>
              ))}
              {prefError ? (
                <div className="w-state w-state--error">
                  <span>{prefError}</span>
                </div>
              ) : null}
              <Toolbar>
                <Button ariaLabel="取消修改偏好" onClick={() => setPrefDraft(undefined)}>
                  取消
                </Button>
                <Button variant="primary" ariaLabel="保存偏好" disabled={savingPref} onClick={() => void submitPrefs()}>
                  {savingPref ? '保存中…' : '保存'}
                </Button>
              </Toolbar>
            </Stack>
          ) : (
            <Stack>
              <ListStateHost
                loading={settings.loading}
                error={settings.error ? { code: settings.error.code, text: humanize(settings.error) } : undefined}
                items={prefEntries}
                emptyText="系统还没有给这个账号下发偏好项。需要调整时请联系管理员。"
                onRetry={settings.reload}
              >
                {(items) => (
                  <Stack>
                    {items.map(([key, value]) => (
                      <KeyValue key={key} k={settingLabel(key)} v={value} />
                    ))}
                  </Stack>
                )}
              </ListStateHost>
              {prefError ? (
                <div className="w-state w-state--error">
                  <span>{prefError}</span>
                </div>
              ) : null}
              {prefNotice ? (
                <div className="w-state">
                  <span>{prefNotice}</span>
                </div>
              ) : null}
              <Toolbar>
                <Button
                  ariaLabel="修改偏好设置"
                  disabled={prefEntries.length === 0}
                  onClick={() => {
                    setPrefError(undefined);
                    setPrefNotice(undefined);
                    setPrefDraft({ ...settingsMap });
                  }}
                >
                  修改偏好
                </Button>
                <span className="w-muted">只列出系统下发的项，改完保存即可生效。</span>
              </Toolbar>
            </Stack>
          )}
        </Card>
      </Section>

      <Section title="登录密码">
        <Card>
          <Stack>
            <div className="w-state">
              <span>改密码只影响本账号的登录。请把新密码记牢 —— 忘记后需要管理员协助重置。</span>
            </div>
            <Field label="当前密码 *">
              <Input
                value={pwForm.oldPassword}
                onChange={(v) => setPwForm((f) => ({ ...f, oldPassword: v }))}
                type="password"
                placeholder="正在使用的密码"
              />
            </Field>
            <Field label="新密码 *">
              <Input
                value={pwForm.newPassword}
                onChange={(v) => setPwForm((f) => ({ ...f, newPassword: v }))}
                type="password"
                placeholder="至少 6 位"
              />
            </Field>
            <Field label="再输一次新密码 *">
              <Input
                value={pwForm.confirm}
                onChange={(v) => setPwForm((f) => ({ ...f, confirm: v }))}
                type="password"
                placeholder="确认用"
              />
            </Field>
            {pwError ? (
              <div className="w-state w-state--error">
                <span>{pwError}</span>
              </div>
            ) : null}
            {pwNotice ? (
              <div className="w-state">
                <span>{pwNotice}</span>
              </div>
            ) : null}
            <Toolbar>
              <Button
                variant="danger"
                ariaLabel="修改登录密码"
                disabled={pwBusy}
                onClick={() => {
                  setPwError(undefined);
                  setPwNotice(undefined);
                  const problem = passwordProblem(pwForm);
                  if (problem) {
                    setPwError(problem);
                    return;
                  }
                  setPwConfirming(true);
                }}
              >
                修改登录密码
              </Button>
              {pwBusy ? <Chip tone="neutral">正在提交</Chip> : null}
            </Toolbar>
          </Stack>
        </Card>
      </Section>

      <ConfirmDialog
        open={pwConfirming}
        title="修改登录密码"
        danger
        confirmLabel="确认修改"
        message={
          <Stack>
            <span>确认把当前登录密码换成新的吗？换好之后请用新密码登录。</span>
            {pwError ? <span className="w-state w-state--error">{pwError}</span> : null}
          </Stack>
        }
        onConfirm={() => void submitPassword()}
        onCancel={() => setPwConfirming(false)}
      />
    </Stack>
  );
}
