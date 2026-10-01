import { useContext, useState } from 'react';
import type { Bridge } from '@wise/bridge-client';
import { Capability } from '@wise/bridge-client';
import { useScanGun } from '@wise/scan';
import {
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
import { CameraScanOverlay } from './CameraScanOverlay.js';
import { PageBody } from './PageBody.js';
import { DOMAINS, screenKey } from './navigation.js';
import { NavigationContext, ShellNavigationProvider, useShellNavigation } from './navigationState.js';

/**
 * 移动外壳（Compact，<600px，见 docs/ui-spec.md §2）。
 *
 * 结构固定为 AppBar / 内容 / TabBar 三段；页内标题走 `PageHeader`，不再自建顶栏。
 * 域内切换放 `Toolbar`（横向按钮组），避免和底栏的两级导航打架。
 */
type MobileShellProps = {
  bridge: Bridge;
  origin: string;
  size: WindowSize;
};

export function MobileShell(props: MobileShellProps): React.ReactElement {
  const navigation = useContext(NavigationContext);
  return navigation ? (
    <MobileShellContent {...props} />
  ) : (
    <ShellNavigationProvider>
      <MobileShellContent {...props} />
    </ShellNavigationProvider>
  );
}

function MobileShellContent({
  bridge,
  origin,
  size,
}: MobileShellProps): React.ReactElement {
  const { domain, root, leaf, top, shown, switchDomain, goRoot, onNavigate, onScan, pop } = useShellNavigation();

  /** 相机取景是否打开。关闭即释放摄像头（hook 的清理函数会停掉所有轨道）。 */
  const [scanning, setScanning] = useState(false);



  // 只在宿主**声明了**这项能力时才监听：能力表是"宿主真的具备什么"的唯一说法。
  useScanGun({ enabled: bridge.supports(Capability.SCAN_GUN_KEYBOARD), onScan });

  return (
    <div className="w-root w-root--stack w-root--industrial">
      <AppBar
        variant="industrial"
        title={top ? top.leaf.label : root.label}
        /*
         * 栈非空时给一根**返回**键，替代扫码入口。
         *
         * 位置复用 AppBar 的 actions 而不是新加一条返回栏：手机上多一条横向栏
         * 就少一行内容高度，而返回是"当前这一层"的属性，放在标题旁边最省。
         */
        actions={
          top ? (
            <Button ariaLabel="返回" onClick={pop}>
              返回
            </Button>
          ) : bridge.supports(Capability.SCAN_CAMERA) ? (
            /*
             * 相机扫码入口。**只在宿主声明了 SCAN_CAMERA 时出现** ——
             * 没有相机的设备不该看到一个点了没反应的按钮。
             */
            <Button variant="primary" ariaLabel="扫码" onClick={() => setScanning(true)}>
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

      {/*
        这里原先还有一条"登录"动作条，那是**重复的死控件**：登录屏自己有提交按钮
        （它才知道验证码填了没、能不能提交），壳再摆一个点了没反应的按钮只会误导用户。
        壳只负责"哪一屏"，屏内动作归屏。
      */}

      <TabBar variant="industrial">
        {DOMAINS.map((d) => (
          <TabBarItem key={d.id} label={d.short} icon={d.id} active={d.id === domain} onClick={() => switchDomain(d.id)} />
        ))}
      </TabBar>

      {scanning ? (
        <CameraScanOverlay
          onClose={() => setScanning(false)}
          onDetected={(code) => {
            // 先关取景再导航：相机多开一秒都是白耗电，而且用户马上要看的不是画面
            setScanning(false);
            onScan(code);
          }}
        />
      ) : null}
    </div>
  );
}
