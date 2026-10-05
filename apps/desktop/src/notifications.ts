import { Notification, type BrowserWindow } from 'electron';

/**
 * **Windows 系统通知**（v5 之后的新能力）。
 *
 * ## 为什么在**主进程**弹，而不是渲染进程的 `Notification` API
 *
 * 三条，任何一条都足够：
 *  1. 通知最该出现的时刻**界面不在前台**，那时渲染进程的定时器/任务可能被节流甚至冻结；
 *  2. 主进程的 `new Notification()` **不需要任何权限**，而渲染进程的 `Notification` API
 *     要走权限处理器 —— 本项目那里的策略是"只放行 `media`"（见 `main.ts` 的注释）；
 *  3. 通知该由**壳**弹：桥只负责"发现新消息"（`notify.message` 事件），
 *     "怎么弹、弹不弹"是平台差异，归壳。
 *
 * ## 一条已知的平台坑
 *
 * Windows 上未打包的 Electron 必须显式设 `app.setAppUserModelId(...)`，否则 toast **静默不显示**
 * （不是报错，是"什么都没发生"）。`main.ts` 在 `whenReady` 里设了它。
 */

/** 桥发来的 `notify.message` 事件正文（见 Kotlin `UnreadNotifier.messageEvent`）。 */
export interface NotifyMessageEvent {
  readonly count?: number;
  readonly audible?: boolean;
  readonly latest?: {
    readonly id?: string;
    readonly title?: string;
    readonly body?: string;
    readonly type?: string;
    readonly priority?: number;
    readonly at?: string;
  };
}

/**
 * 深链前缀：与 Web 路由（`packages/layouts/src/navigation.ts` 的 `message.detail`）一致。
 *
 * 壳只认这个前缀 + 消息 id，**不理解业务实体**（`relatedEntityType/Id` 由 Web 层自己决定要不要再跳一层）。
 * 三处一致由 `tools/check/check-notify.mjs` 对账。
 */
export const MESSAGE_ROUTE_PREFIX = '/me/messages/';

export interface NotifyDeps {
  readonly window: BrowserWindow | null;
  /** 注入以便测试/自检替换（默认就是 Electron 的 `Notification`）。 */
  readonly createNotification?: (options: { title: string; body: string; silent: boolean }) => {
    show(): void;
    on(event: 'click', handler: () => void): void;
  };
}

/**
 * 把一条 `notify.message` 事件变成系统通知。
 *
 * @returns 真的弹了返回 `true`；因为"前台可见"或"没有 id/标题"而**故意不弹**返回 `false`
 *   （调用方据此打日志 —— "没弹"必须能解释，不能是一片沉默）。
 */
export function notifyMessage(
  deps: NotifyDeps,
  event: NotifyMessageEvent,
): boolean {
  const win = deps.window;
  const latest = event.latest;
  const id = latest?.id ?? '';
  const title = latest?.title ?? '';
  if (id === '' || title === '') {
    return false;
  }

  /*
   * **前台可见时不弹**：用户正看着界面，界面自己会在 10 秒内刷新出这条消息；
   * 这时候再弹一条系统通知只是噪音（而且点它会"跳到你已经待着的页面"）。
   */
  if (win && win.isVisible() && win.isFocused()) {
    return false;
  }

  const silent = event.audible !== true;
  const create =
    deps.createNotification ??
    ((options: { title: string; body: string; silent: boolean }) => new Notification(options));

  const notification = create({
    title,
    body: latest?.body ?? '',
    silent,
  });
  notification.on('click', () => {
    if (!win) {
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    /*
     * 深链用 `location.hash` 而不是 `loadURL`：后者会**整页重载**，
     * 内存里的登录态与已取的数据全丢，用户点一条通知却要重新登录一次。
     */
    void win.webContents.executeJavaScript(`location.hash = '#${MESSAGE_ROUTE_PREFIX}${id}'`);
  });
  notification.show();
  return true;
}
