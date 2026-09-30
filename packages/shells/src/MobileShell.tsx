import { useCallback, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { Capability } from '@wise/bridge-client';
import { useScanGun } from '@wise/scan';
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
import { DOMAINS, SCAN_TARGET_METHOD, findLeafByMethod, type DomainId, type NavLeaf } from './navigation.js';
import type { ScreenParams } from '@wise/features';

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
  const [params, setParams] = useState<ScreenParams | undefined>(undefined);

  const switchDomain = (id: DomainId): void => {
    const next = DOMAINS.find((d) => d.id === id);
    if (!next) {
      return;
    }
    setDomain(id);
    setLeaf(next.children[0]!);
    setParams(undefined);
  };

  /**
   * 扫码枪扫到东西 → 跳到标签详情并带上编码。
   *
   * 好处是**用户不用再手输一遍**：现场扫一下就该看到这个标签是什么。
   * 编码通过 `params` 交给屏（屏签名里的 `screenParams`）。
   */
  const onScan = useCallback((code: string) => {
    const target = findLeafByMethod(SCAN_TARGET_METHOD);
    if (!target) {
      return;
    }
    setDomain(target.domain);
    setLeaf(target.leaf);
    setParams({ code });
  }, []);

  // 只在宿主**声明了**这项能力时才监听：能力表是"宿主真的具备什么"的唯一说法。
  useScanGun({ enabled: bridge.supports(Capability.SCAN_GUN_KEYBOARD), onScan });

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
                  <TabStripItem
                    key={c.id}
                    label={c.label}
                    active={c.id === leaf.id}
                    onClick={() => {
                      setLeaf(c);
                      // 换目的地就丢掉上一屏的参数，否则"扫码 → 手点别的标签"会
                      // 把上一个编码带进新屏（详情屏会按旧编码再查一次）。
                      setParams(undefined);
                    }}
                  />
                ))}
              </TabStrip>
            ) : null}
            {/*
              这里原先还画一行 `PageHeader`，而每屏自己也会画一个 —— 于是同一个标题出现两次。
              现在**由屏自己负责页头**（它才知道该配什么副标题与操作），壳不再重复。
            */}
            {/*
              `key` 让"换目的地"或"扫到另一个码"时屏重新挂载：同一屏组件被复用时会带着
              上一份 state（查询结果、已选行），现场表现为"扫了新的码却还是旧内容"。
            */}
            <PageBody key={`${leaf.id}:${params?.code ?? ''}`} bridge={bridge} leaf={leaf} params={params} />
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
