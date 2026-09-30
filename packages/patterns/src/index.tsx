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
  onClick,
}: {
  label: string;
  active: boolean;
  child?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={child ? 'w-navitem w-navitem--child' : 'w-navitem'}
      aria-current={active}
      onClick={onClick}
    >
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
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button type="button" className="w-tabbar__item" aria-current={active} onClick={onClick}>
      <span aria-hidden="true">●</span>
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

export function Toolbar({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="w-toolbar">{children}</div>;
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
  error?: string;
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
  placeholder,
  type = 'text',
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
}): React.ReactElement {
  return (
    <input
      className={mono ? 'w-input w-mono' : 'w-input'}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
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
  id?: string;
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
