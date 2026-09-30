import { useCallback, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { Capability } from '@wise/bridge-client';
import { useScanGun } from '@wise/scan';
import type { ScreenParams } from '@wise/features';
import {
  AppBar,
  Button,
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
import { DOMAINS, SCAN_TARGET_METHOD, destinationOf, findLeafByMethod, screenKey, type DomainId, type NavLeaf } from './navigation.js';

/** 推入栈里的一层（与移动外壳同构）。 */
interface Crumb {
  readonly leaf: NavLeaf;
  readonly params?: ScreenParams | undefined;
}

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
  /** 推入栈：屏请求去的下一层（详情类）。空栈 = 在导航叶子上。 */
  const [stack, setStack] = useState<readonly Crumb[]>([]);
  const top = stack.length > 0 ? stack[stack.length - 1]! : undefined;
  const shown = top ?? { leaf, params: undefined as ScreenParams | undefined };

  const goRoot = (next: NavLeaf, nextDomain?: DomainId): void => {
    if (nextDomain !== undefined) {
      setDomain(nextDomain);
    }
    setLeaf(next);
    setStack([]);
  };

  /** 屏请求导航：能推到下一层就推，推不了（未知目的地）就留日志而不是静默。 */
  const onNavigate = useCallback((to: { method: string; params?: ScreenParams | undefined }) => {
    const dest = destinationOf(to.method);
    if (!dest) {
      console.warn(`[shell] 收到未知的导航目标：${to.method}`);
      return;
    }
    setStack((prev) => [
      ...prev,
      { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: to.params },
    ]);
  }, []);

  /** 扫码枪扫到东西 → 推入标签详情并带上编码（与移动外壳同一套落点与语义）。 */
  const onScan = useCallback((code: string) => {
    const dest = destinationOf(SCAN_TARGET_METHOD);
    const target = findLeafByMethod(SCAN_TARGET_METHOD);
    if (target && !dest) {
      goRoot(target.leaf, target.domain);
      return;
    }
    if (!dest) {
      return;
    }
    setStack((prev) => [
      ...prev,
      { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: { code } },
    ]);
  }, []);

  useScanGun({ enabled: bridge.supports(Capability.SCAN_GUN_KEYBOARD), onScan });

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
          title={top ? top.leaf.label : leaf.label}
          actions={
            <>
              {top ? (
                <Button ariaLabel="返回" onClick={() => setStack((prev) => prev.slice(0, -1))}>
                  返回
                </Button>
              ) : null}
              <Chip tone="neutral">{`${bridge.capabilities.length} 项能力`}</Chip>
            </>
          }
          status={<BridgeStatusChip bridge={bridge} origin={origin} />}
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
