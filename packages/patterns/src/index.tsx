import type { CSSProperties, ReactNode } from 'react';
import { windowSizeOf, type WindowSize } from '@wise/tokens';

/**
 * `@wise/patterns` —— `docs/ui-spec.md` 的**唯一实现**。
 *
 * 为什么把布局件做成组件而不是"大家照着写"：
 * 旧仓 26 个屏各写一套 `Scaffold`+`TopAppBar`，结果返回键、标题层级、内边距逐屏漂移
 * （见《APP-UI优化计划》§一 实测）。规范写在文档里挡不住漂移，只有在**组件 API 里**
 * 挡得住——想改间距就得改组件，改组件就会影响所有屏，于是"统一"是默认结果而不是纪律要求。
 */

// ================================================================ 骨架件

export function AppBar({ title, actions, status }: { title: string; actions?: ReactNode; status?: ReactNode }): React.ReactElement {
  return (
    <header className="w-appbar">
      <span className="w-appbar__title">{title}</span>
      <span className="w-appbar__spacer" />
      {actions}
      {status}
    </header>
  );
}

export function Sidebar({ brand, children }: { brand: ReactNode; children: ReactNode }): React.ReactElement {
  return (
    <aside className="w-sidebar">
      <div className="w-sidebar__brand">{brand}</div>
      <nav aria-label="一级导航">{children}</nav>
    </aside>
  );
}

export function NavItem({
  label,
  active,
  child,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  child?: boolean;
  icon?: IconName;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={child ? 'w-navitem w-navitem--child' : 'w-navitem'}
      aria-current={active}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size={18} /> : null}
      {label}
    </button>
  );
}

export function TabBar({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <nav className="w-tabbar" aria-label="一级导航">
      {children}
    </nav>
  );
}

export function TabBarItem({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon?: IconName;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button type="button" className="w-tabbar__item" aria-current={active} onClick={onClick}>
      {icon ? <Icon name={icon} size={22} /> : null}
      {label}
    </button>
  );
}

/** 内容列：负责"超宽居中"与页面内边距，页面里不要再自己写 padding。 */
export function Content({ size, children }: { size: WindowSize; children: ReactNode }): React.ReactElement {
  const cls = size === 'expanded' ? 'w-content w-content--expanded' : 'w-content';
  return <div className={cls}>{children}</div>;
}

export function Page({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-page">{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <div className="w-pageheader">
      <div>
        <div className="w-pageheader__title">{title}</div>
        {subtitle ? <div className="w-pageheader__sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="w-pageheader__actions">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="w-section">
      {title ? <div className="w-section__title">{title}</div> : null}
      {children}
    </section>
  );
}

export function Stack({
  children,
  row,
  tight,
}: {
  children: ReactNode;
  row?: boolean;
  tight?: boolean;
}): React.ReactElement {
  const cls = ['w-stack', row ? 'w-stack--row' : '', tight ? 'w-stack--tight' : ''].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
}

export function Grid({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-grid">{children}</div>;
}

export function Card({
  children,
  flush,
  style,
}: {
  children: ReactNode;
  flush?: boolean;
  style?: CSSProperties;
}): React.ReactElement {
  return (
    <div className={flush ? 'w-card w-card--flush' : 'w-card'} style={style}>
      {children}
    </div>
  );
}

export function MasterDetail({ master, detail }: { master: ReactNode; detail: ReactNode }): React.ReactElement {
  return (
    <div className="w-master-detail">
      <div className="w-pane w-pane--master">{master}</div>
      <div className="w-pane">{detail}</div>
    </div>
  );
}

export function ActionBar({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-actionbar">{children}</div>;
}

/**
 * 危险操作的二次确认（ui-spec §3.1："不允许点一下就删"）。
 *
 * 用受控组件而不是 `window.confirm`：后者会**阻塞渲染线程**、样式不可控、
 * 在 WebView 里还会打断与桥的连接（弹窗期间事件循环被占住）。
 * 删除这类操作必须在应用自己的界面里确认，而不是交给宿主环境。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement | null {
  if (!open) {
    return null;
  }
  return (
    <div className="w-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-overlay__panel">
        <div className="w-pageheader__title">{title}</div>
        <div className="w-state">{message}</div>
        <div className="w-actionbar">
          <Button ariaLabel="取消" onClick={onCancel}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} ariaLabel={confirmLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-toolbar">{children}</div>;
}

/**
 * 横向可滚的二级切换条（移动端域内切换用）。
 *
 * 与 [Toolbar] 的区别：Toolbar 会换行（适合筛选条件），TabStrip **不换行**（适合一组平级功能）。
 * 用哪个取决于"这组东西多不多、能否被压缩"—— 5 个功能名在窄屏换行就会挤成一堆（用户实测反馈）。
 */
export function TabStrip({ children }: { children: ReactNode }): React.ReactElement {
  return <nav className="w-tabstrip">{children}</nav>;
}

/** TabStrip 里的一项。选中态用容器色 + 主色描边，与底栏的"只变色"刻意区分层级。 */
export function TabStripItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button type="button" className="w-btn" aria-current={active} onClick={onClick}>
      {label}
    </button>
  );
}

// ================================================================ 控件

export function Button({
  children,
  onClick,
  variant = 'default',
  block,
  disabled,
  type = 'button',
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  block?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  ariaLabel?: string;
}): React.ReactElement {
  const cls = ['w-btn', variant === 'default' ? '' : `w-btn--${variant}`, block ? 'w-btn--block' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  /** 显式带 `| undefined`：本仓开了 `exactOptionalPropertyTypes`，"转发一个可能没有的错误文案"才编译得过。 */
  error?: string | undefined;
  children: ReactNode;
}): React.ReactElement {
  return (
    <label className="w-field">
      <span className="w-field__label">{label}</span>
      {children}
      {error ? <span className="w-field__error">{error}</span> : null}
    </label>
  );
}

export function Input({
  value,
  onChange,
  onEnter,
  placeholder,
  type = 'text',
  mono,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 回车提交。扫码枪与实体键盘都靠它 —— 现场作业里"按一下回车"比"点一下按钮"快得多。 */
  onEnter?: (() => void) | undefined;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
  ariaLabel?: string | undefined;
}): React.ReactElement {
  return (
    <input
      className={mono ? 'w-input w-mono' : 'w-input'}
      type={type}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) {
          onEnter();
        }
      }}
    />
  );
}

/**
 * 搜索框 + 搜索按钮（ui-spec 组件库第 7 件）。
 *
 * 抽出来的理由与其它组件一样：不抽就会在每个列表屏出现"宽度各异的输入框 +
 * 位置不同的按钮 + 有的支持回车有的不支持"。回车支持在这里统一。
 */
export function SearchField({
  value,
  onChange,
  onSearch,
  placeholder = '搜索',
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}): React.ReactElement {
  return (
    <div className="w-search">
      <Input value={value} onChange={onChange} onEnter={onSearch} placeholder={placeholder} ariaLabel={placeholder} />
      <Button ariaLabel="搜索" onClick={onSearch}>
        搜索
      </Button>
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'danger';
}): React.ReactElement {
  return <span className={tone === 'neutral' ? 'w-chip' : `w-chip w-chip--${tone}`}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }): React.ReactElement {
  return <span className={`w-dot w-dot--${tone}`} />;
}

/**
 * 图标：内联 SVG，**不引图标库**。
 *
 * 为什么不用第三方图标库：整个产物预算只有 250KB(gzip)，而这里只需要 4 个 24×24 的实心路径。
 * 更重要的是"少一个会随版本改变外观的依赖"——现场工具的外观不该由别人的 minor 版本决定。
 *
 * 之前的底栏用的是 `●` 字符占位，那在真机上是真的难看（W3 用户反馈），因此补齐。
 */
const ICON_PATHS = {
  /** 看板（dashboard） */
  overview: 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z',
  /** 库存（box） */
  inventory:
    'M20 2H4c-1.1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-.9-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
  /** 我的（person） */
  me: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  /**
   * 现场（location pin）。
   *
   * 原来用的是"图层"图标 —— 抽象，业务用户看第一眼不知道是什么模块（用户反馈）。
   * 现场作业 = 到某个位置去巡检/看设备，定位图标的语义更直接。
   */
  field: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z',
  /** 扫码（qr） */
  scan: 'M3 5v4h2V5h4V3H5c-1.1 0-2 .9-2 2zm18 4V5c0-1.1-.9-2-2-2h-4v2h4v4h2zM5 15v4h4v2H5c-1.1 0-2-.9-2-2v-4h2zm16 4v-4h-2v4h-4v2h4c1.1 0 2-.9 2-2zM3 11h18v2H3z',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ================================================================ 数据

export function Mono({ children }: { children: ReactNode }): React.ReactElement {
  return <span className="w-mono">{children}</span>;
}

export function KpiCard({ value, label }: { value: ReactNode; label: string }): React.ReactElement {
  return (
    <Card>
      <div className="w-kpi__value">{value}</div>
      <div className="w-kpi__label">{label}</div>
    </Card>
  );
}

export function DataList({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-datalist">{children}</div>;
}

export function DataRow({
  id,
  main,
  sub,
  trailing,
  active,
  onSelect,
}: {
  /** 显式带 `| undefined`：行数据里这个字段常常是可选的（`exactOptionalPropertyTypes`）。 */
  id?: string | undefined;
  main: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  onSelect?: () => void;
}): React.ReactElement {
  const body = (
    <>
      {id ? <Mono>{id}</Mono> : null}
      <span className="w-datarow__main">
        <span>{main}</span>
        {sub ? <span className="w-datarow__sub"> {sub}</span> : null}
      </span>
      {trailing}
    </>
  );
  return onSelect ? (
    <button type="button" className="w-datarow" aria-current={active} onClick={onSelect}>
      {body}
    </button>
  ) : (
    <div className="w-datarow">{body}</div>
  );
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }): React.ReactElement {
  return (
    <div className="w-kv">
      <span className="w-kv__k">{k}</span>
      <span className="w-kv__v">{v}</span>
    </div>
  );
}

// ================================================================ 四态
// ui-spec §3.5：四态必须互斥且穷尽，用同一个容器表达，不允许各屏自己写。

export function LoadingState({ rows = 3 }: { rows?: number }): React.ReactElement {
  return (
    <div className="w-stack">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="w-skeleton" />
      ))}
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }): React.ReactElement {
  return (
    <div className="w-state">
      <span>{text}</span>
      {action}
    </div>
  );
}

export function ErrorState({
  code,
  text,
  onRetry,
}: {
  code: string;
  text: string;
  /** 显式带 `| undefined`：本仓开了 `exactOptionalPropertyTypes`，否则"转发一个可能不存在的回调"编译不过。 */
  onRetry?: (() => void) | undefined;
}): React.ReactElement {
  return (
    <div className="w-state w-state--error">
      <Mono>{code}</Mono>
      <span>{text}</span>
      {onRetry ? <Button onClick={onRetry}>重试</Button> : null}
    </div>
  );
}

/** 四态宿主：取数容器一律用它，保证"任意接口都能画出四种状态"。 */
export function ListStateHost<T>({
  loading,
  error,
  items,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean;
  error: { code: string; text: string } | undefined;
  items: readonly T[];
  emptyText: string;
  onRetry?: (() => void) | undefined;
  children: (items: readonly T[]) => ReactNode;
}): React.ReactElement {
  if (error) {
    return <ErrorState code={error.code} text={error.text} onRetry={onRetry} />;
  }
  if (loading) {
    return <LoadingState />;
  }
  if (items.length === 0) {
    return <EmptyState text={emptyText} />;
  }
  return <>{children(items)}</>;
}

/** 由视口宽度推导档位（断点与 ui-spec §1.2 同源）。 */
export { windowSizeOf };
export type { WindowSize };
