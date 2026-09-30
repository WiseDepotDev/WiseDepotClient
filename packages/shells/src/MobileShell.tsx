import { useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { Capability } from '@wise/bridge-client';
import { BridgeStatusChip } from './BridgeStatusChip.js';
import { PageBody } from './PageBody.js';
import { DOMAINS, type DomainId, type NavLeaf } from './navigation.js';

/**
 * 移动外壳（Compact，<600dp）。
 *
 * 与桌面外壳的差别**只有布局与交互习惯**：底栏四域、单列、全屏页、大触控目标、
 * 扫码入口常驻顶栏。数据、方法、状态容器全部共用（架构不变式 2）。
 */
export function MobileShell({ bridge, origin }: { bridge: Bridge; origin: string }): React.ReactElement {
  const [domain, setDomain] = useState<DomainId>('overview');
  const current = DOMAINS.find((d) => d.id === domain) ?? DOMAINS[0]!;
  const [leaf, setLeaf] = useState<NavLeaf>(current.children[0]!);

  const switchDomain = (id: DomainId): void => {
    const next = DOMAINS.find((d) => d.id === id);
    if (!next) {
      return;
    }
    setDomain(id);
    setLeaf(next.children[0]!);
  };

  return (
    <div className="w-root w-mobile">
      <header className="w-topbar">
        <span className="w-topbar__title">{leaf.label}</span>
        <span className="w-topbar__spacer" />
        {bridge.supports(Capability.SCAN_CAMERA) ? (
          <button type="button" className="w-btn w-btn--primary" aria-label="扫码">
            扫码
          </button>
        ) : null}
        <BridgeStatusChip bridge={bridge} origin={origin} />
      </header>

      <main className="w-mobile__content">
        {current.children.length > 1 ? (
          <nav className="w-topbar" style={{ paddingLeft: 0, paddingRight: 0, borderBottom: 'none', gap: 'var(--w-space-inline-gap)', flexWrap: 'wrap' }}>
            {current.children.map((c) => (
              <button
                key={c.id}
                type="button"
                className="w-btn"
                aria-current={c.id === leaf.id}
                onClick={() => setLeaf(c)}
              >
                {c.label}
              </button>
            ))}
          </nav>
        ) : null}
        <PageBody bridge={bridge} leaf={leaf} />
      </main>

      <nav className="w-tabbar" aria-label="一级导航">
        {DOMAINS.map((d) => (
          <button
            key={d.id}
            type="button"
            className="w-tabbar__item"
            aria-current={d.id === domain}
            onClick={() => switchDomain(d.id)}
          >
            <span aria-hidden="true">●</span>
            {d.short}
          </button>
        ))}
      </nav>
    </div>
  );
}
