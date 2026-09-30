import { useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import {
  AppBar,
  Chip,
  Content,
  DataList,
  DataRow,
  Dot,
  MasterDetail,
  Mono,
  NavItem,
  Page,
  PageHeader,
  Sidebar,
  Stack,
  type WindowSize,
} from '@wise/patterns';
import { BridgeStatusChip } from './BridgeStatusChip.js';
import { PageBody } from './PageBody.js';
import { DOMAINS, type DomainId, type NavLeaf } from './navigation.js';

/**
 * 桌面外壳（Medium / Expanded，≥600px，见 docs/ui-spec.md §2）。
 *
 * 与移动外壳的差别只有布局：侧栏展开全部页、内容列超宽居中、列表页走**主从双栏**。
 * 数据、方法、四态、控件全部共用同一套 patterns —— 这是"两套 UI 不是两套代码"的落点。
 */
export function DesktopShell({
  bridge,
  origin,
  size,
}: {
  bridge: Bridge;
  origin: string;
  size: WindowSize;
}): React.ReactElement {
  const [domain, setDomain] = useState<DomainId>('overview');
  const [leaf, setLeaf] = useState<NavLeaf>(DOMAINS[0]!.children[0]!);

  const master = (
    <DataList>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <DataRow
          key={i}
          id={`#${String(i).padStart(4, '0')}`}
          main="占位行"
          sub={leaf.primaryMethod}
          trailing={<Dot tone={i % 3 === 0 ? 'warn' : 'ok'} />}
          active={i === 1}
          onSelect={() => undefined}
        />
      ))}
    </DataList>
  );

  return (
    <div className="w-root">
      <Sidebar
        brand={
          <span>
            WiseDepot <Mono>慧仓智控</Mono>
          </span>
        }
      >
        {DOMAINS.map((d) => (
          <div key={d.id} className="w-navgroup">
            <NavItem
              label={d.label}
              active={d.id === domain && !d.children.some((c) => c.id === leaf.id)}
              onClick={() => {
                setDomain(d.id);
                setLeaf(d.children[0]!);
              }}
            />
            {d.id === domain
              ? d.children.map((c) => (
                  <NavItem key={c.id} label={c.label} child active={c.id === leaf.id} onClick={() => setLeaf(c)} />
                ))
              : null}
          </div>
        ))}
      </Sidebar>

      <div className="w-main">
        <AppBar
          title={leaf.label}
          actions={<Chip tone="neutral">{`${bridge.capabilities.length} 项能力`}</Chip>}
          status={<BridgeStatusChip bridge={bridge} origin={origin} />}
        />
        <MasterDetail
          master={master}
          detail={
            <Content size={size}>
              <Page>
                <PageHeader title={leaf.label} subtitle={leaf.primaryMethod} />
                <Stack>
                  <PageBody bridge={bridge} leaf={leaf} />
                </Stack>
              </Page>
            </Content>
          }
        />
      </div>
    </div>
  );
}
