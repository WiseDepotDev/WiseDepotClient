import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopShell, MobileShell } from '@wise/shells';
import { AlertListScreen, DashboardScreen, LoginScreen } from '@wise/features';
import type { Bridge } from '@wise/bridge-client';

/**
 * 外壳渲染检查的入口（由 tools/check/check-shell-render.mjs 用 esbuild 打包后执行）。
 *
 * 为什么要有它：W1 的交付物是"两套空壳"，而空壳最容易出的问题恰恰是**渲染期崩溃**
 * （未定义的令牌变量本身不会崩，但组件里少判一个 undefined 就会）。
 * 在没有浏览器驱动的前提下，用 React 的服务端渲染把两套外壳真跑一遍，
 * 是"能渲染"最便宜的客观证据。
 */

/** 假桥：实现 Bridge 接口，不依赖 window（SSR 环境里没有 window）。 */
function fakeBridge(capabilities: readonly string[]): Bridge {
  return {
    kind: 'ws',
    platform: 'desktop',
    hostVersion: '1.0.0-test',
    capabilities,
    state: 'open',
    supports: (c: string) => capabilities.includes(c),
    call: <T,>() => Promise.resolve({} as T),
    subscribe: () => () => undefined,
    onStateChange: () => () => undefined,
    close: () => undefined,
  };
}

interface Case {
  readonly name: string;
  readonly render: () => string;
  /** 必须在输出里出现（结构断言，不是像素断言）。 */
  readonly expect: readonly string[];
}

const cases: readonly Case[] = [
  {
    name: 'MobileShell（紧凑档外壳）',
    render: () =>
      renderToStaticMarkup(
        <MobileShell bridge={fakeBridge(['scan.camera', 'nfc.read'])} origin="test" size="compact" />,
      ),
    expect: ['w-root--stack', 'w-appbar', 'w-tabbar', 'w-pageheader', '概览', '库存', '现场', '我的', '扫码', 'w-mono'],
  },
  {
    name: 'MobileShell 无扫码能力（能力表驱动，不是平台字符串）',
    render: () => renderToStaticMarkup(<MobileShell bridge={fakeBridge(['nfc.read'])} origin="test" size="compact" />),
    expect: ['w-root--stack'],
  },
  {
    name: 'DesktopShell（扩展档外壳，主从双栏）',
    render: () =>
      renderToStaticMarkup(
        <DesktopShell bridge={fakeBridge(['window.control', 'print.system'])} origin="test" size="expanded" />,
      ),
    expect: ['w-sidebar', 'w-navitem', 'w-master-detail', 'w-content--expanded', 'w-datarow', '2 项能力'],
  },
  {
    name: 'LoginScreen（登录屏，W3-b）',
    render: () => renderToStaticMarkup(<LoginScreen bridge={fakeBridge([])} onSignedIn={() => undefined} />),
    expect: ['w-auth', 'w-auth__card', '账号', '密码', '验证码', 'w-captcha', '换一张', '登录'],
  },
  // W5：overview 域的两个屏。SSR 阶段数据未回来，因此断言的是**结构**
  // （页头 + 四态宿主的加载态）而不是数据 —— 数据由真后端冒烟覆盖。
  {
    name: 'DashboardScreen（看板，W5）',
    render: () => renderToStaticMarkup(<DashboardScreen bridge={fakeBridge([])} />),
    expect: ['看板', 'w-pageheader', 'w-skeleton', '当前任务', '未处理告警'],
  },
  {
    name: 'AlertListScreen（告警中心，W5）',
    render: () => renderToStaticMarkup(<AlertListScreen bridge={fakeBridge([])} />),
    expect: ['告警中心', 'w-pageheader', 'w-skeleton', '只看未处理', '告警列表'],
  },
];

let failures = 0;
for (const c of cases) {
  let html = '';
  try {
    html = c.render();
  } catch (e) {
    console.error(`✗ ${c.name} 渲染抛异常：${(e as Error).message}`);
    failures += 1;
    continue;
  }
  const missing = c.expect.filter((token) => !html.includes(token));
  if (missing.length > 0) {
    console.error(`✗ ${c.name} 输出缺少结构标记：${missing.join(', ')}`);
    failures += 1;
    continue;
  }
  console.log(`  ✓ ${c.name}（${html.length} 字节）`);
}

// 反向断言：无扫码能力时不应画出扫码入口。
// 注意断言的是 **aria-label** 而不是"扫码"这个词——页内的事件流标题里也有"扫码"，
// 用裸词匹配会得到假阳性（旧仓 B0 的度量脚本就踩过同款坑，见《APP-UI优化计划》§一 口径更正）。
const noScan = cases[1]!.render();
if (noScan.includes('aria-label="扫码"')) {
  console.error('✗ 无 scan.camera 能力时仍然渲染了扫码入口');
  failures += 1;
}

if (failures > 0) {
  console.error(`check-shell-render: ${failures} 个用例失败`);
  process.exit(1);
}
console.log('check-shell-render OK: 两套外壳均可渲染，能力表驱动生效');
