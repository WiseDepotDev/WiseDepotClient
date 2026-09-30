import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopShell, MobileShell } from '@wise/shells';
import {
  AlertListScreen,
  DashboardScreen,
  DeviceDetailScreen,
  DeviceListScreen,
  InspectionResultListScreen,
  InspectionTaskCreateScreen,
  InspectionResultCreateScreen,
  InspectionManualRecordScreen,
  InspectionTaskDetailScreen,
  InspectionTaskListScreen,
  InventoryListScreen,
  LoginScreen,
  MessageDetailScreen,
  MessageListScreen,
  ProductListScreen,
  ProfileScreen,
  StockOrderListScreen,
  StockOrderCreateScreen,
  StockOrderDetailScreen,
  TagListScreen,
  TagDetailScreen,
  UserListScreen,
  WarehouseListScreen,
} from '@wise/features';
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
    expect: ['w-root--stack', 'w-appbar', 'w-tabstrip', 'w-tabbar', '看板', '概览', '库存', '现场', '我的', '扫码'],
  },
  {
    name: 'MobileShell 无扫码能力（能力表驱动，不是平台字符串）',
    render: () => renderToStaticMarkup(<MobileShell bridge={fakeBridge(['nfc.read'])} origin="test" size="compact" />),
    expect: ['w-root--stack'],
  },
  {
    name: 'DesktopShell（扩展档外壳，单列限宽居中）',
    render: () =>
      renderToStaticMarkup(
        <DesktopShell bridge={fakeBridge(['window.control', 'print.system'])} origin="test" size="expanded" />,
      ),
    // 断言里**不再有** w-master-detail / w-datarow：桌面端的主列表曾是写死的
    // `main="占位行" sub={leaf.primaryMethod}`，真机上会显示六行假数据 + 桥方法 id。
    // 已删除；真正的双栏要等屏自己提供主列表内容。
    expect: ['w-sidebar', 'w-navitem', 'w-content--expanded', '2 项能力', '看板'],
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
  {
    name: 'InventoryListScreen（库存查询，W5-inventory）',
    render: () => renderToStaticMarkup(<InventoryListScreen bridge={fakeBridge([])} />),
    expect: ['库存查询', 'w-pageheader', 'w-search', 'w-tabstrip', 'w-skeleton', '刷新', '库存列表'],
  },
  {
    name: 'ProductListScreen（商品管理，W5-inventory）',
    render: () => renderToStaticMarkup(<ProductListScreen bridge={fakeBridge([])} />),
    expect: ['商品管理', 'w-pageheader', 'w-search', 'w-skeleton', '新增', '商品列表'],
  },
  {
    name: 'WarehouseListScreen（仓库管理，W5-inventory）',
    render: () => renderToStaticMarkup(<WarehouseListScreen bridge={fakeBridge([])} />),
    expect: ['仓库管理', 'w-pageheader', 'w-search', 'w-skeleton', '新增', '仓库列表'],
  },
  {
    name: 'StockOrderListScreen（出入库单，W5-inventory）',
    render: () => renderToStaticMarkup(<StockOrderListScreen bridge={fakeBridge([])} />),
    expect: ['出入库单', 'w-pageheader', 'w-skeleton', 'w-bottombar', '单据列表'],
  },

  // W9：出入库单的建单与详情（原先是列表屏里的一个内联表单，那个入口永远失败）
  {
    name: 'StockOrderCreateScreen（新建出入库单，W9-inventory）',
    render: () => renderToStaticMarkup(<StockOrderCreateScreen bridge={fakeBridge([])} />),
    expect: ['新建出入库单', 'w-pageheader', 'w-bottombar'],
  },
  {
    name: 'StockOrderDetailScreen（出入库单详情，W9-inventory）',
    render: () => renderToStaticMarkup(<StockOrderDetailScreen bridge={fakeBridge([])} />),
    // 未传单据编号时不取数，落查询空态而不是骨架
    expect: ['出入库单详情', 'w-pageheader', 'w-state'],
  },
  {
    name: 'TagListScreen（标签管理，W5-inventory）',
    render: () => renderToStaticMarkup(<TagListScreen bridge={fakeBridge([])} />),
    // 默认态**没有**底部批量条：批量动作只在「选择」模式下出现
    // （行点击一次只能有一个属主，选择模式是让"进详情"和"勾选"各有入口的那个开关）。
    // 渲染用例点不了按钮，所以批量条那一段由真机验证覆盖。
    expect: ['标签管理', 'w-pageheader', 'w-search', 'w-skeleton', '选择', '标签列表'],
  },
  {
    // 可选 prop 的契约：传了 `onNavigate` 不崩（列表点进详情靠它）。
    // 不传的形态由上一条用例覆盖 —— 两种都要能渲染，因为屏在单独渲染时拿不到壳。
    name: 'TagListScreen 传 onNavigate（子导航句柄）也能渲染',
    render: () => renderToStaticMarkup(<TagListScreen bridge={fakeBridge([])} onNavigate={() => undefined} />),
    expect: ['标签管理', 'w-pageheader'],
  },

  // W9：扫码枪的落点。两种入口共屏：
  //   · 不带参数 → 查询入口 + 空态（**不该**是骨架：没目标时不取数）
  //   · 带 screenParams.code → 首帧就按这个码取数（扫码进来的路径）
  {
    name: 'TagDetailScreen（标签详情，无参数 → 查询入口）',
    render: () => renderToStaticMarkup(<TagDetailScreen bridge={fakeBridge([])} />),
    expect: ['标签详情', '查询标签', 'w-pageheader', 'w-search', 'w-state'],
  },
  {
    name: 'TagDetailScreen（带 screenParams.code → 首帧按码取数）',
    render: () =>
      renderToStaticMarkup(<TagDetailScreen bridge={fakeBridge([])} screenParams={{ code: 'TAG-PROBE-1' }} />),
    // 有目标时应当落到加载态（骨架），而不是查询空态
    expect: ['w-pageheader', 'w-skeleton'],
  },

  // W6：field 域（设备 / 巡检）。列表屏必须同时具备页头、搜索、四态宿主；
  // 详情屏没有搜索（详情不是可搜索的集合），因此只断言页头与四态宿主。
  {
    name: 'DeviceListScreen（设备管理，W6-field）',
    render: () => renderToStaticMarkup(<DeviceListScreen bridge={fakeBridge(['scan.camera'])} />),
    expect: ['设备管理', 'w-pageheader', 'w-search', 'w-skeleton'],
  },
  {
    name: 'DeviceDetailScreen（设备详情，W6-field）',
    render: () => renderToStaticMarkup(<DeviceDetailScreen bridge={fakeBridge([])} />),
    // 未传编号 → 屏上落的是"查询入口 + 空态"，**不该**是骨架：
    // 骨架表示"正在取数"，而这一屏在拿到目标之前根本不取数（useBridgeCall 的 enabled=false）。
    expect: ['设备详情', '按设备编号查询', 'w-pageheader', 'w-search', 'w-state'],
  },
  {
    name: 'InspectionTaskListScreen（巡检任务，W6-field）',
    render: () => renderToStaticMarkup(<InspectionTaskListScreen bridge={fakeBridge([])} />),
    expect: ['巡检任务', 'w-pageheader', 'w-search', 'w-skeleton'],
  },
  {
    name: 'InspectionTaskDetailScreen（巡检任务详情，W6-field）',
    render: () => renderToStaticMarkup(<InspectionTaskDetailScreen bridge={fakeBridge([])} />),
    // 同上：未传任务序号时不取数，落空态而不是骨架
    expect: ['巡检任务详情', '查看某个任务', 'w-pageheader', 'w-state'],
  },
  {
    name: 'InspectionResultListScreen（巡检结果，W6-field）',
    render: () => renderToStaticMarkup(<InspectionResultListScreen bridge={fakeBridge([])} />),
    expect: ['巡检结果', 'w-pageheader', 'w-search', 'w-skeleton'],
  },

  // W8：现场域的"写"入口（此前只有看没有录）。三屏都是表单屏，
  // 断言的共同点是：页头 + 底部动作条（ui-spec：表单屏不允许"滚到底找按钮"）。
  {
    name: 'InspectionTaskCreateScreen（新建巡检任务，W8-field）',
    render: () => renderToStaticMarkup(<InspectionTaskCreateScreen bridge={fakeBridge([])} />),
    expect: ['新建巡检任务', 'w-pageheader', 'w-bottombar'],
  },
  {
    name: 'InspectionResultCreateScreen（录入巡检结果，W8-field）',
    render: () => renderToStaticMarkup(<InspectionResultCreateScreen bridge={fakeBridge([])} />),
    expect: ['录入巡检结果', 'w-pageheader'],
  },
  {
    name: 'InspectionManualRecordScreen（手动补录，W8-field）',
    render: () => renderToStaticMarkup(<InspectionManualRecordScreen bridge={fakeBridge([])} />),
    expect: ['手动补录巡检明细', 'w-pageheader'],
  },

  // W7：me 域（消息 / 用户 / 个人资料）
  {
    name: 'MessageListScreen（消息中心，W7-me）',
    render: () => renderToStaticMarkup(<MessageListScreen bridge={fakeBridge([])} />),
    expect: ['w-pageheader', 'w-search', 'w-skeleton'],
  },
  {
    name: 'MessageDetailScreen（消息详情，W7-me）',
    render: () => renderToStaticMarkup(<MessageDetailScreen bridge={fakeBridge([])} />),
    expect: ['w-pageheader', 'w-skeleton'],
  },
  {
    name: 'UserListScreen（用户管理，W7-me）',
    render: () => renderToStaticMarkup(<UserListScreen bridge={fakeBridge([])} />),
    expect: ['w-pageheader', 'w-search', 'w-skeleton'],
  },
  {
    name: 'ProfileScreen（个人资料，W7-me）',
    render: () => renderToStaticMarkup(<ProfileScreen bridge={fakeBridge([])} />),
    expect: ['w-pageheader', 'w-skeleton'],
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
