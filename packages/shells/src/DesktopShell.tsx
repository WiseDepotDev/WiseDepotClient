import { useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import {
  AppBar,
  Chip,
  Content,
  Mono,
  NavItem,
  Page,
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
 * 与移动外壳的差别只有布局：侧栏展开全部页、内容列超宽居中。
 * 数据、方法、四态、控件全部共用同一套 patterns —— 这是"两套 UI 不是两套代码"的落点。
 *
 * **关于主从双栏**：W4 时这里有一个"主列表"，内容是 6 行写死的
 * `main="占位行" sub={leaf.primaryMethod}`。它在真机上被一眼看穿两件事：
 *   1. 是假数据（六行一模一样的「占位行」）；
 *   2. 把桥方法 id（`device.list`）直接印给了仓库操作员 —— 正是用户明确反馈过要不得的东西。
 * 现在 18 块屏都是真的，所以那份占位已删除。
 *
 * 真正的双栏要等**屏自己提供主列表内容**（列表屏的"左列"与"右列详情"是屏的业务语义，
 * 壳猜不出来）。在那之前，Expanded 与 Medium 一样走单列限宽居中 ——
 * 宁可少一个装饰性的空栏，也不要摆一块假数据。
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
              icon={d.id}
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
        <div className="w-scroll">
          <Content size={size}>
            <Page>
              {/* 页头由屏自己画（它才知道该配什么副标题与操作），壳不重复 */}
              <Stack>
                <PageBody bridge={bridge} leaf={leaf} />
              </Stack>
            </Page>
          </Content>
        </div>
      </div>
    </div>
  );
}
