import { useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { BridgeStatusChip } from './BridgeStatusChip.js';
import { PageBody } from './PageBody.js';
import { DOMAINS, type DomainId, type NavLeaf } from './navigation.js';

/**
 * 桌面外壳（Medium / Expanded，≥600dp）。
 *
 * 与移动外壳的差别（除布局外）：
 * - 左侧导航栏展开**域内的全部页**（手机是域内二级切换）；
 * - 列表页用**主从双栏**（左列表、右详情）——旧仓 B5 只对"设备"一条流程做了双栏，
 *   这里从架构上就把它做成默认形态；
 * - 顶栏带能力清单，方便在现场排查"这台机器到底有没有扫码枪"。
 */
export function DesktopShell({ bridge, origin }: { bridge: Bridge; origin: string }): React.ReactElement {
  const [domain, setDomain] = useState<DomainId>('overview');
  const [leaf, setLeaf] = useState<NavLeaf>(DOMAINS[0]!.children[0]!);

  return (
    <div className="w-root w-desktop">
      <aside className="w-sidebar">
        <div className="w-sidebar__brand">
          WiseDepot
          <span className="w-mono w-muted"> 慧仓智控</span>
        </div>
        <nav aria-label="一级导航">
          {DOMAINS.map((d) => (
            <div key={d.id} className="w-navgroup">
              <button
                type="button"
                className="w-navitem"
                aria-current={d.id === domain && d.children.some((c) => c.id === leaf.id)}
                onClick={() => {
                  setDomain(d.id);
                  setLeaf(d.children[0]!);
                }}
              >
                {d.label}
              </button>
              {d.id === domain
                ? d.children.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="w-navitem"
                      style={{ paddingLeft: 'var(--w-space-section-gap)' }}
                      aria-current={c.id === leaf.id}
                      onClick={() => setLeaf(c)}
                    >
                      {c.label}
                    </button>
                  ))
                : null}
            </div>
          ))}
        </nav>
      </aside>

      <div className="w-desktop__main">
        <header className="w-topbar">
          <span className="w-topbar__title">{leaf.label}</span>
          <span className="w-topbar__spacer" />
          <span className="w-chip w-mono">{bridge.capabilities.length} 项能力</span>
          <BridgeStatusChip bridge={bridge} origin={origin} />
        </header>

        <div className="w-split">
          <div className="w-split__pane w-split__pane--master">
            <div className="w-kpi__label">列表栏</div>
            <div className="w-mono w-muted">{leaf.primaryMethod}</div>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="w-listrow">
                <span className="w-dot w-dot--ok" />
                <span className="w-mono">#{String(i).padStart(4, '0')}</span>
                <span className="w-muted">占位行</span>
              </div>
            ))}
          </div>
          <div className="w-split__pane">
            <PageBody bridge={bridge} leaf={leaf} />
          </div>
        </div>
      </div>
    </div>
  );
}
