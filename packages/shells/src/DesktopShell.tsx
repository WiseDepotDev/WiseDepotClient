import type { Bridge } from '@wise/bridge-client';
import { useContext } from 'react';
import { Capability } from '@wise/bridge-client';
import { useScanGun } from '@wise/scan';
import {
  AppBar,
  Button,
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
import { DOMAINS, screenKey } from './navigation.js';
import { NavigationContext, ShellNavigationProvider, useShellNavigation } from './navigationState.js';

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
type DesktopShellProps = {
  bridge: Bridge;
  origin: string;
  size: WindowSize;
};

export function DesktopShell(props: DesktopShellProps): React.ReactElement {
  const navigation = useContext(NavigationContext);
  return navigation ? (
    <DesktopShellContent {...props} />
  ) : (
    <ShellNavigationProvider>
      <DesktopShellContent {...props} />
    </ShellNavigationProvider>
  );
}

function DesktopShellContent({
  bridge,
  origin,
  size,
}: DesktopShellProps): React.ReactElement {
  const { domain, leaf, top, shown, goRoot, onNavigate, onScan, pop } = useShellNavigation();

  const categoryOf = (id: typeof domain): string => (id === 'field' ? '现场' : id === 'me' ? '管理' : '运营');
  const sectionLabel = categoryOf(domain);

  useScanGun({ enabled: bridge.supports(Capability.SCAN_GUN_KEYBOARD), onScan });

  return (
    <div className="w-root w-root--industrial">
      <Sidebar
        variant="industrial"
        brand={
          <span className="w-sidebar__brand-lockup">
            <strong>慧仓智控</strong>
            <Mono>WiseDepot / OPS</Mono>
          </span>
        }
      >
        {DOMAINS.map((d, index) => (
          <div key={d.id} className="w-navgroup">
            {index === 0 || categoryOf(DOMAINS[index - 1]!.id) !== categoryOf(d.id) ? (
              <div className="w-navgroup__label">{categoryOf(d.id)}</div>
            ) : null}
            <NavItem
              label={d.label}
              icon={d.id}
              active={d.id === domain && !d.children.some((c) => c.id === leaf.id)}
              onClick={() => goRoot(d.children[0]!, d.id)}
            />
            {d.id === domain
              ? d.children.map((c) => (
                  <NavItem
                    key={c.id}
                    label={c.label}
                    child
                    active={c.id === leaf.id && top === undefined}
                    onClick={() => goRoot(c)}
                  />
                ))
              : null}
          </div>
        ))}
      </Sidebar>

      <div className="w-main">
        <AppBar
          variant="industrial"
          title={`${sectionLabel} / ${top ? top.leaf.label : leaf.label}`}
          actions={
            <>
              {top ? (
                <Button ariaLabel="返回" onClick={pop}>
                  返回
                </Button>
              ) : null}
            </>
          }
          status={<BridgeStatusChip bridge={bridge} origin={origin} alwaysShow />}
        />
        <div className="w-scroll">
          <Content size={size}>
            <Page>
              {/* 页头由屏自己画（它才知道该配什么副标题与操作），壳不重复 */}
              <Stack>
                {/* `key` 让"换目的地"或"扫到另一个码"时屏重新挂载（同组件复用会带着上一份 state） */}
                <PageBody
                  key={screenKey(shown.leaf.id, shown.params)}
                  bridge={bridge}
                  leaf={shown.leaf}
                  params={shown.params}
                  onNavigate={onNavigate}
                />
              </Stack>
            </Page>
          </Content>
        </div>
      </div>
    </div>
  );
}
