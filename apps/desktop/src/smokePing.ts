/**
 * 桌面自检的 **ping 探针**（v5）。
 *
 * ## 为什么单独一个文件、还要预打包
 *
 * 自检脚本是 main.ts 里**注入到页面执行的字符串**（见 `runSmoke`），拿不到页面的模块图；
 * v5 之前它自带一份手搓的 v4 帧编解码（"第四份线实现"）。加密之后那样做等于再写一份
 * ECDH + AES-GCM —— 那是把"加密层只有三份实现"这条纪律作废。
 *
 * 所以：这里用**共享的** `seal.ts` / `wire.ts` 写探针，由 `scripts/desktop.ps1` 用 esbuild
 * 预打包成 `dist/smoke-ping.js`，main.ts 读那个文件、把 bundle 文本拼进注入脚本。
 * 于是自检与页面走的是同一套字节与同一套密钥调度 —— 它在真环境（app:// + CSP）里
 * 验的就是"产品真的能连上桥"。
 */

import { generateEphemeral, fromHex, hexOf, SealSession, sessionKeys, sharedSecret } from '../../../packages/bridge-client/src/seal.js';
import { decodeFrame, encodeFrame, isHelloFrame, openFrame, sealFrame } from '../../../packages/bridge-client/src/wire.js';

export interface SmokePingBoot {
  readonly port: number;
  /** v5：预共享密钥（从 `__bridge.json` 读，永不上线）。 */
  readonly psk: string;
}

export interface SmokePingResult {
  readonly type?: string;
  readonly data?: unknown;
  readonly error?: string;
}

/**
 * 连上桥 → 完成 v5 加密握手 → 发一条 `bridge.ping` → 返回结果。
 *
 * 失败一律返回 `{ error }`（不抛）：自检要把"哪一步失败"写进报告，
 * 抛出去只会变成一句看不出阶段的 `smoke failed`。
 */
export async function smokePing(boot: SmokePingBoot): Promise<SmokePingResult> {
  try {
    const ephemeral = await generateEphemeral();
    const url = `ws://127.0.0.1:${boot.port}/bridge?k=${hexOf(ephemeral.publicKey)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    const session = await new Promise<SealSession>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout（没等到 hello）')), 5000);
      socket.onmessage = (ev) => {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (!isHelloFrame(bytes)) {
          clearTimeout(timer);
          reject(new Error('握手第一条帧不是 hello'));
          return;
        }
        void (async () => {
          try {
            const hello = decodeFrame(bytes);
            if (hello.type !== 'hello') {
              throw new Error('hello 帧形状不对');
            }
            const serverPublicKey = fromHex(hello.publicKeyHex);
            const shared = await sharedSecret(ephemeral.privateKey, serverPublicKey);
            const keys = await sessionKeys(new TextEncoder().encode(boot.psk), ephemeral.publicKey, serverPublicKey, shared);
            clearTimeout(timer);
            resolve(new SealSession(keys, 'client'));
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        })();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      };
    });

    return await new Promise<SmokePingResult>((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'ws timeout（没有回复）' }), 5000);
      const inner = encodeFrame({ type: 'req', id: 'smoke-1', method: 'bridge.ping' });
      socket.onmessage = (ev) => {
        void (async () => {
          try {
            const frame = decodeFrame(await openFrame(new Uint8Array(ev.data as ArrayBuffer), session));
            if (frame.type === 'res' && frame.id === 'smoke-1') {
              clearTimeout(timer);
              resolve({ type: 'res', data: frame.data });
              socket.close();
            } else if (frame.type === 'err' && frame.id === 'smoke-1') {
              clearTimeout(timer);
              resolve({ type: 'err', data: frame.error });
              socket.close();
            }
          } catch (e) {
            // 解不出来的帧不参与断言（与 v4 时代的探针一致）
            void e;
          }
        })();
      };
      // 帧封装是异步的（WebCrypto），所以先 await 再发
      void (async () => {
        try {
          socket.send(await sealFrame(inner, session));
        } catch (e) {
          clearTimeout(timer);
          resolve({ error: `封装失败：${e instanceof Error ? e.message : String(e)}` });
        }
      })();
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
