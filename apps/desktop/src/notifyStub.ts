import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 系统通知这一片的**假后端**（桌面通知自检与 `bench:desktop` 共用这一份）。
 *
 * ## 为什么是共享模块而不是各写一份
 *
 * 它一开始只是在 `main.ts` 里内联的一小段，`bench:desktop` 那边又抄了一份 ——
 * 于是"假后端少了哪个接口"这件事有两个地方要说。第一次踩坑就是它：
 * 点通知跳到**消息详情屏**时，详情屏会调 `message.detail`，而内联那段只实现了
 * 轮询要的三个接口，于是界面显示 `操作未完成（NOT-FOUND）` ——
 * 看起来像"深链坏了"，其实是假后端不完整。现在只有一份，缺哪个接口一眼能看见。
 *
 * ## 三条纪律
 *
 * 1. **回真信封**：`{"payload":{"code":"RES-0000","data":…}}`（见 `backend/Envelope.kt`）。
 *    不照真形状回，验的就是"我们能不能骗过桥的解析"，而不是桥本身。
 * 2. **三个接口的返回形状各不相同**（这是最容易写错的地方，所以照抄真后端）：
 *    `user.current` 是对象且用户 id 叫 `userId`；`message.unreadCount` 是**裸数字**；
 *    `message.list` 是**裸数组**（0 基分页）。
 * 3. **未实现的路径回一个显眼的错**（`STUB-NOT-IMPLEMENTED`，而不是默默 200 空对象）：
 *    假后端的价值在于"缺什么会当场炸出来"，静默成功会让上层拿到一堆 undefined。
 */

export interface StubMessage {
  id: string;
  title: string;
  content: string;
  type: string;
  priority: number;
  createTime: string;
  receiverName: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export interface NotifyStub {
  readonly url: string;
  /** 改未读数（可选一起换"最新一条"）。 */
  readonly setUnread: (n: number, latest?: StubMessage) => void;
  /** 到目前为止各接口被调了几次（断言"轮询真的在跑"要用）。 */
  readonly calls: { user: number; count: number; list: number; detail: number; markRead: number; challenge: number; verify: number };
  readonly close: () => Promise<void>;
  /** 已标记已读的 id（详情屏进入即标已读，这条能证明那个副作用的往返是通的）。 */
  readonly readIds: Set<string>;
  /** 最后一次 `human.verify` 的请求体（自检据此断言"证据真的到了服务端"）。 */
  readonly lastHumanVerify: { current?: Record<string, unknown> };
}

export interface NotifyStubOptions {
  /** 消息 id 前缀（`<prefix>-MSG-1`）：不同的自检各自断言自己的 id，不要互相干扰。 */
  readonly idPrefix?: string;
}

/**
 * 起一个假后端（监听 `127.0.0.1` 的随机端口）。
 *
 * 实现的接口（**按这个顺序匹配**，`unread-count` 与 `{id}` 前缀相同，顺序错了就撞车）：
 *   `GET  /api/users/current`              → `{userId}`
 *   `GET  /api/messages/unread-count`      → 裸数字
 *   `GET  /api/messages`                   → 裸数组（`page`/`size` 走 query）
 *   `GET  /api/messages/{messageId}`       → 消息对象（**详情屏要的**）
 *   `PUT  /api/messages/{messageId}/read`  → 标已读（详情屏进入即调，失败被它静默）
 */
export async function startNotifyStub(options: NotifyStubOptions = {}): Promise<NotifyStub> {
  const prefix = options.idPrefix ?? 'SMOKE';
  const calls = { user: 0, count: 0, list: 0, detail: 0, markRead: 0, challenge: 0, verify: 0 };
  const readIds = new Set<string>();
  const lastHumanVerify: { current?: Record<string, unknown> } = {};
  let unread = 0;
  let latest: StubMessage = {
    id: `${prefix}-MSG-1`,
    title: '设备异常',
    content: '读头 3 已离线',
    type: 'ALERT',
    priority: 1,
    createTime: '2026-10-07T10:00:00',
    receiverName: '当前账号',
    relatedEntityType: 'DEVICE',
    relatedEntityId: 'READER-3',
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    /** 读请求体（`human.verify` 要断言"证据真的到了"，所以必须真读）。 */
    const readBody = (done: (body: Record<string, unknown>) => void): void => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        try {
          done(raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>));
        } catch {
          done({});
        }
      });
    };
    const json = (data: unknown): void => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // 回显链路标识：真后端会这么做，桥也一直带着它
        'REQUEST-ID': String(req.headers['request-id'] ?? 'notify-stub'),
      });
      res.end(JSON.stringify({ payload: { code: 'RES-0000', message: 'OK', data } }));
    };
    /** 未实现的路径：**显眼地失败**，不要静默 200 空对象。 */
    const notImplemented = (): void => {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          payload: {
            code: 'STUB-NOT-IMPLEMENTED',
            message: `假后端没有实现这个路径：${req.method ?? ''} ${url.pathname}`,
          },
        }),
      );
    };

    if (url.pathname === '/api/users/current') {
      calls.user += 1;
      json({ userId: 7 });
      return;
    }
    if (url.pathname === '/api/messages/unread-count') {
      calls.count += 1;
      // 裸数字（信封的 data 就是一个 JsonPrimitive）
      json(unread);
      return;
    }
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      calls.list += 1;
      // 裸数组 + 0 基分页
      json(unread > 0 ? [latest] : []);
      return;
    }
    if (url.pathname === '/api/human/challenge' && req.method === 'POST') {
      calls.challenge += 1;
      readBody(() => {
        // 难度给 0：自检不该为了验链路去算几百万次哈希（服务端的 PoW 由它自己的单测覆盖）
        json({ challengeId: `stub-ch-${calls.challenge}`, action: 'verify', difficultyBits: 0, expiresIn: 120 });
      });
      return;
    }
    if (url.pathname === '/api/human/verify' && req.method === 'POST') {
      calls.verify += 1;
      readBody((body) => {
        /*
         * 记**解出来的参数**而不是信封原文。
         *
         * 桥发出去的是信封（`{header, payload:{code,message,data}}`，见 `backend/Envelope.kt`），
         * 而自检要断言的是"参数里有什么"。我第一版直接记了原文，于是断言拿到的是
         * `header, payload` 两个键 —— 看起来像"桥什么都没发"，其实是假后端记错了层。
         */
        const unwrapped = (body as { payload?: { data?: Record<string, unknown> } }).payload?.data;
        lastHumanVerify.current = unwrapped ?? body;
        json({ humanToken: `stub-token-${calls.verify}`, expiresIn: 120 });
      });
      return;
    }
    if (url.pathname.startsWith('/api/messages/') && url.pathname.endsWith('/read')) {
      calls.markRead += 1;
      const id = decodeURIComponent(url.pathname.slice('/api/messages/'.length, -'/read'.length));
      readIds.add(id);
      json(true);
      return;
    }
    if (url.pathname.startsWith('/api/messages/') && req.method === 'GET') {
      calls.detail += 1;
      const id = decodeURIComponent(url.pathname.slice('/api/messages/'.length));
      if (id !== latest.id && !readIds.has(id)) {
        // 真后端对不存在的消息也是这个口径（页面会渲染成"这条消息已经不在了"）
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ payload: { code: 'RES-4040', message: '消息不存在' } }));
        return;
      }
      json({ ...latest, isRead: readIds.has(id), readTime: readIds.has(id) ? '2026-10-07T10:05:00' : null });
      return;
    }
    notImplemented();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    setUnread: (n, next) => {
      unread = n;
      if (next) {
        latest = next;
      }
    },
    calls,
    readIds,
    lastHumanVerify,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 第二条假消息（静默档：`SYSTEM` + `priority = 0`），两个自检都用它验"静默"。 */
export function silentStubMessage(prefix = 'SMOKE'): StubMessage {
  return {
    id: `${prefix}-MSG-2`,
    title: '系统维护通知',
    content: '今晚 23:00 例行维护',
    type: 'SYSTEM',
    priority: 0,
    createTime: '2026-10-07T11:00:00',
    receiverName: '当前账号',
  };
}
