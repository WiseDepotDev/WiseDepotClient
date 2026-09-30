import { useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { Capability } from '@wise/bridge-client';
import {
  ActionBar,
  AppBar,
  Button,
  Content,
  Page,
  TabBar,
  TabBarItem,
  TabStrip,
  TabStripItem,
  type WindowSize,
} from '@wise/patterns';
import { BridgeStatusChip } from './BridgeStatusChip.js';
import { PageBody } from './PageBody.js';
import { DOMAINS, type DomainId, type NavLeaf } from './navigation.js';

/**
 * 移动外壳（Compact，<600px，见 docs/ui-spec.md §2）。
 *
 * 结构固定为 AppBar / 内容 / TabBar 三段；页内标题走 `PageHeader`，不再自建顶栏。
 * 域内切换放 `Toolbar`（横向按钮组），避免和底栏的两级导航打架。
 */
export function MobileShell({
  bridge,
  origin,
  size,
}: {
  bridge: Bridge;
  origin: string;
  size: WindowSize;
}): React.ReactElement {
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
    <div className="w-root w-root--stack">
      <AppBar
        title={current.label}
        actions={
          bridge.supports(Capability.SCAN_CAMERA) ? (
            <Button variant="primary" ariaLabel="扫码">
              扫码
            </Button>
          ) : null
        }
        status={<BridgeStatusChip bridge={bridge} origin={origin} />}
      />

      <div className="w-scroll">
        <Content size={size}>
          <Page>
            {current.children.length > 1 ? (
              <TabStrip>
                {current.children.map((c) => (
                  <TabStripItem key={c.id} label={c.label} active={c.id === leaf.id} onClick={() => setLeaf(c)} />
                ))}
              </TabStrip>
            ) : null}
            {/*
              这里原先还画一行 `PageHeader`，而每屏自己也会画一个 —— 于是一个标题出现两次。
              现在**由屏自己负责页头**（它才知道该配什么副标题与操作），壳不再重复。
            */}
            <PageBody bridge={bridge} leaf={leaf} />
          </Page>
        </Content>
      </div>

      {leaf.primaryMethod === 'auth.login' ? (
        <ActionBar>
          <Button variant="primary" block>
            登录
          </Button>
        </ActionBar>
      ) : null}

      <TabBar>
        {DOMAINS.map((d) => (
          <TabBarItem key={d.id} label={d.short} icon={d.id} active={d.id === domain} onClick={() => switchDomain(d.id)} />
        ))}
      </TabBar>
    </div>
  );
}
