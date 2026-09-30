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
import { DOMAINS, SCAN_TARGET_METHOD, destinationOf, findLeafByMethod, screenKey, type DomainId, type NavLeaf } from './navigation.js';
import type { ScreenParams } from '@wise/features';

/**
 * 推入栈里的一层：一个屏 + 它的参数。
 *
 * `leaf` 只是个"壳能显示标题、能派发到屏"的最小载体 —— 推入的屏不在 `DOMAINS` 里，
 * 它的 id/label 由 `DESTINATIONS` 给。
 */
interface Crumb {
  readonly leaf: NavLeaf;
  readonly params?: ScreenParams | undefined;
}

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
  const root = DOMAINS.find((d) => d.id === domain) ?? DOMAINS[0]!;
  const [leaf, setLeaf] = useState<NavLeaf>(root.children[0]!);
  /**
   * 推入栈：屏请求去的"下一层"（详情类）。
   *
   * 空栈 = 在导航叶子上；非空 = 在推入的屏上，`top` 是当前那一屏。
   * 用栈而不是单个 state，是为了支持"详情里再进一层"，
   * 并且**底栏切换域/叶子会清空栈** —— 那是"回到根"，不是"再进一层"。
   */
  const [stack, setStack] = useState<readonly Crumb[]>([]);
  const top = stack.length > 0 ? stack[stack.length - 1]! : undefined;
  const shown = top ?? { leaf, params: undefined as ScreenParams | undefined };

  const switchDomain = (id: DomainId): void => {
    const next = DOMAINS.find((d) => d.id === id);
    if (!next) {
      return;
    }
    setDomain(id);
    setLeaf(next.children[0]!);
    setStack([]);
  };

  const goRoot = (next: NavLeaf, nextDomain?: DomainId): void => {
    if (nextDomain !== undefined) {
      setDomain(nextDomain);
    }
    setLeaf(next);
    setStack([]);
  };

  /** 屏请求导航：能推到下一层就推，推不了（未知目的地）就忽略并留日志。 */
  const onNavigate = useCallback((to: { method: string; params?: ScreenParams | undefined }) => {
    const dest = destinationOf(to.method);
    if (!dest) {
      // 不静默：屏请求了一个壳不认识的目的地，是接线漏了，而不是"用户点了没反应"
      console.warn(`[shell] 收到未知的导航目标：${to.method}`);
      return;
    }
    setStack((prev) => [...prev, { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: to.params }]);
  }, []);

  /**
   * 扫码枪扫到东西 → 推入标签详情并带上编码。
   *
   * 好处是**用户不用再手输一遍**：现场扫一下就该看到这个标签是什么。
   * 编码通过 `params` 交给屏（屏签名里的 `screenParams`）。
   *
   * 注意扫码是**推入一层**（不是切到某个导航叶子）：扫完按返回应该回到原来那一屏，
   * 而不是把用户丢到"库存"域里。
   */
  const onScan = useCallback((code: string) => {
    const target = findLeafByMethod(SCAN_TARGET_METHOD);
    // 扫码的落点既可能是导航叶子（保留了叶子就该切过去），也可能是推入的屏
    if (target && !destinationOf(SCAN_TARGET_METHOD)) {
      setDomain(target.domain);
      setLeaf(target.leaf);
      setStack([]);
      return;
    }
    const dest = destinationOf(SCAN_TARGET_METHOD);
    if (!dest) {
      return;
    }
    setStack((prev) => [
      ...prev,
      { leaf: { id: dest.method, label: dest.label, primaryMethod: dest.method }, params: { code } },
    ]);
  }, []);

  // 只在宿主**声明了**这项能力时才监听：能力表是"宿主真的具备什么"的唯一说法。
  useScanGun({ enabled: bridge.supports(Capability.SCAN_GUN_KEYBOARD), onScan });

  return (
    <div className="w-root w-root--stack">
      <AppBar
        title={top ? top.leaf.label : root.label}
        /*
         * 栈非空时给一根**返回**键，替代扫码入口。
         *
         * 位置复用 AppBar 的 actions 而不是新加一条返回栏：手机上多一条横向栏
         * 就少一行内容高度，而返回是"当前这一层"的属性，放在标题旁边最省。
         */
        actions={
          top ? (
            <Button ariaLabel="返回" onClick={() => setStack((prev) => prev.slice(0, -1))}>
              返回
            </Button>
          ) : bridge.supports(Capability.SCAN_CAMERA) ? (
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
            {/*
              推入的屏（详情）**不画域内 TabStrip**：那一行表达的是"在哪个域的哪一页"，
              而推入的屏不属于任何一页 —— 保留它只会让用户以为还能横向切到别处。
            */}
            {top === undefined && root.children.length > 1 ? (
              <TabStrip>
                {root.children.map((c) => (
                  <TabStripItem key={c.id} label={c.label} active={c.id === leaf.id} onClick={() => goRoot(c)} />
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
            <PageBody
              key={screenKey(shown.leaf.id, shown.params)}
              bridge={bridge}
              leaf={shown.leaf}
              params={shown.params}
              onNavigate={onNavigate}
            />
          </Page>
        </Content>
      </div>

      {top === undefined && leaf.primaryMethod === 'auth.login' ? (
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
