/**
 * 极简 CDP 客户端（零依赖）。
 *
 * 为什么不用 Playwright/Puppeteer：本机没装，而 Node 24 自带全局 WebSocket，
 * 直接连 Chrome 的 DevTools 协议只要几十行，spike 不值得为它拉一个浏览器驱动。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params ?? {});
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败：${String(e?.message ?? e)}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  on(method, cb) {
    const list = this.listeners.get(method) ?? [];
    list.push(cb);
    this.listeners.set(method, list);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面内异常：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 启动无头 Chrome（关掉后台节流，否则 rAF 测量没有意义）。 */
export async function launchChrome({ port = 9333 } = {}) {
  const exe = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'wd-spike-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('Chrome 调试端口未就绪');
  }
  return {
    exe,
    wsUrl,
    stop() {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 临时目录清不掉不影响结论 */
      }
    },
  };
}

export { sleep };
