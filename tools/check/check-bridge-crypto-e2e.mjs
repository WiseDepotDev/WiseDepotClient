#!/usr/bin/env node
/*
 * check-bridge-crypto-e2e.mjs —— v5 加密桥的**端到端**门禁。
 *
 * ## 为什么非要有这一个（另外两条门禁已经在了）
 *
 *   · `pnpm check:crypto-vectors`（81 项）：三份 crypto 实现**算出来一样**。
 *     它证明的是"算法一致"，完全不管这些算法**被谁在什么时候调用**。
 *   · `pnpm bench` / `pnpm bench:desktop`：真 Kotlin 服务端 + 工具侧客户端。
 *     它证明的是"服务端与**工具**说得通"—— 而页面上跑的是**另一份 TS 实现**。
 *
 * 于是"页面这一份到底会不会握手、会不会把 hello 当成密文、会不会在重放时断开"
 * 就没人验了。这个门禁补的就是这一段：**真的 WebSocketTransport（esbuild 打出来的真 TS 代码）**
 * 对着一个真的 WebSocket 服务端跑。
 *
 * ## 为什么自己写 WS 服务端（而不是装一个 `ws`）
 *
 * 只有一百来行（握手 + 掩码 + 分片），换来的是**没有新依赖**、以及能精确控制每一帧 ——
 * 这个门禁要做的恰恰是"发一条坏帧看客户端怎么办"（重放、明文、超大），
 * 用现成库反而要绕着它的 API 走。附带好处：服务端这边**故意只用手写字节**，
 * 于是它与客户端那三份实现是独立的第三方。
 *
 * ## 覆盖的场景
 *
 * 正常路径：hello → 密文 req → 密文 res（带参数往返）→ 密文 evt 订阅 → 大 evt。
 * 失败路径（每一条都必须**明确失败**，不许"假装成功"）：
 *   · 错 psk（两端派生出的密钥不同）；   · 重放旧 res（序号回退）；   · 服务端发明文帧。
 * 边界：封装开销（+295）必须算进上限 —— 外层略超 `binMaxBytes` 的帧要**收下**。
 *
 * 用法：`node tools/check/check-bridge-crypto-e2e.mjs`
 */
import { createHash } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  SEAL_BODY_OVERHEAD_BYTES,
  SEAL_MIN_PSK_BYTES,
  SealSession,
  WIRE_HEADER_BYTES,
  WIRE_SEALED_OVERHEAD_BYTES,
  WireKind,
  decodeFrame,
  encodeFrame,
  generateEphemeral,
  headerId,
  hexOf,
  fromHex,
  isEncrypted,
  isHelloFrame,
  openFrame,
  sealFrame,
  sessionKeys,
  sharedSecret,
} from '../lib/bridge-wire.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ORIGIN = 'app://wise';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
}

// ---------------------------------------------------------------- 真客户端（页面那一份代码）

/**
 * 把**页面真正在跑的那份 TS** 打成 CJS 再 import。
 *
 * 为什么不用 `tools/lib/bridge-wire.mjs`：那个是"工具侧实现"。这个门禁存在的全部意义
 * 就是验**页面那一份**（`packages/bridge-client/src/transport.ts`）——
 * 用工具实现去验工具实现等于什么都没验。
 */
async function bundleRealTransport() {
  const outDir = mkdtempSync(path.join(tmpdir(), 'wise-crypto-e2e-'));
  const entry = path.join(outDir, 'entry.ts');
  const outFile = path.join(outDir, 'entry.cjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    entry,
    [
      `export { WebSocketTransport } from ${JSON.stringify(
        path.join(CLIENT_ROOT, 'packages/bridge-client/src/transport.js').replace(/\\/g, '/'),
      )};`,
      `export { BridgeErrorCode } from ${JSON.stringify(
        path.join(CLIENT_ROOT, 'packages/bridge-client/src/types.js').replace(/\\/g, '/'),
      )};`,
    ].join('\n'),
  );
  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    external: ['electron'],
  });
  const mod = await import(pathToFileURL(outFile).href);
  return { mod: mod.default ?? mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- 手写 WS 服务端

/** WebSocket 帧：服务端→客户端不掩码；客户端→服务端**必须**掩码（收到没掩码的直接断）。 */
function wsEncode(payload, opcode = 0x2) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * 解析客户端发来的字节流（已掩码）。返回 `{frames, rest}`。
 *
 * 只实现这个门禁会用到的东西：单帧 FIN 消息 + close/ping。遇到分片或未知 opcode 直接抛 ——
 * 那说明客户端的行为变了，值得当场知道，而不是被静默忽略。
 */
function wsDecode(buffer) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (buffer.length - cursor < 2) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (buffer.length - cursor < 8) break;
      len = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (!masked) {
      throw new Error('客户端没有掩码 —— WebSocket 规范要求客户端必须掩码');
    }
    if (buffer.length - cursor < 4 + len) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) {
      payload[i] = buffer[cursor + i] ^ mask[i % 4];
    }
    cursor += len;
    if (!fin) {
      throw new Error('收到了分片帧（本门禁的帧都很小，出现它说明客户端行为变了）');
    }
    frames.push({ opcode, payload });
    offset = cursor;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * 一个"够真的"加密桥服务端。
 *
 * @param psk 服务端认为的 psk。故意允许与客户端不一致（那是"错 psk"场景）。
 * @param mode 行为开关，见 `dispatch`。
 */
function createCryptoServer({ psk, mode = 'normal' }) {
  const stats = {
    upgrades: 0,
    rejectedUpgrades: 0,
    lastUpgradeUrl: '',
    lastOrigin: '',
    helloPublicKey: null,
    sawEncryptedClientFrame: false,
    sawPlaintextClientFrame: false,
    cryptoFailures: 0,
  };
  const sockets = new Set();

  const server = createHttpServer();
  server.on('upgrade', (req, socket) => {
    stats.upgrades += 1;
    stats.lastUpgradeUrl = req.url ?? '';
    stats.lastOrigin = String(req.headers.origin ?? '');

    const key = req.headers['sec-websocket-key'];
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const clientPubHex = url.searchParams.get('k') ?? '';
    const badKey = clientPubHex.length !== 130 || !/^[0-9a-f]+$/i.test(clientPubHex);
    /*
     * Origin 判据：**缺省允许**。
     *
     * 浏览器一定会带 `Origin: app://wise`，而 Node（undici）的 `WebSocket` **不带 Origin 头** ——
     * 这是本门禁少数几处"环境与真机不同"的地方，必须写出来而不是偷偷放宽：
     * 真服务端的 Origin 白名单由 Kotlin 侧测试与 `bench:desktop` 覆盖（那里会构造 Wrong origin）。
     * 这里把"带了但不是我们"的拒掉，只是顺手验一下这个假服务端自己没写反。
     */
    const origin = String(req.headers.origin ?? '');
    const originOk = origin === '' || origin === ORIGIN;
    if (url.pathname !== '/bridge' || !key || badKey || !originOk) {
      stats.rejectedUpgrades += 1;
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(`${key}${WS_GUID}`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    // ---- 密钥协商：服务端也生成**本次连接**的临时密钥对
    const clientPub = fromHex(clientPubHex);
    const eph = generateEphemeral();
    const z = sharedSecret(eph.ecdh, clientPub);
    const session = new SealSession(
      sessionKeys(Buffer.from(psk, 'utf8'), clientPub, eph.publicKey, z),
      'server',
    );
    stats.helloPublicKey = hexOf(eph.publicKey);

    const conn = {
      session,
      socket,
      sentSeq: 0,
      /** 发一条**密文**帧（走封装）。 */
      send(frame) {
        if (isHelloFrame(encodeFrame(frame))) {
          throw new Error('hello 不许封装');
        }
        const sealed = sealFrame(encodeFrame(frame), session);
        socket.write(wsEncode(sealed));
        return sealed;
      },
      /** 发一条**原始字节**（不封装）—— 只给"服务端发明文帧"这类坏场景用。 */
      sendRaw(bytes, opcode = 0x2) {
        socket.write(wsEncode(bytes, opcode));
      },
      /** 把**已经发出过的字节**原样再发一次（重放）。 */
      replay(bytes) {
        socket.write(wsEncode(bytes));
      },
      close() {
        socket.destroy();
      },
    };
    sockets.add(conn);

    // 第一条：明文 hello（**唯一**允许明文的帧）
    socket.write(wsEncode(encodeFrame({ type: 'hello', publicKeyHex: hexOf(eph.publicKey) })));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try {
        decoded = wsDecode(buffer);
      } catch (e) {
        stats.cryptoFailures += 1;
        socket.destroy();
        return;
      }
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (frame.opcode !== 0x2) {
          continue;
        }
        const bytes = Uint8Array.from(frame.payload);
        if (isHelloFrame(bytes)) {
          stats.sawPlaintextClientFrame = true;
          continue;
        }
        if (!isEncrypted(bytes)) {
          stats.sawPlaintextClientFrame = true;
          continue;
        }
        stats.sawEncryptedClientFrame = true;
        let inner;
        try {
          inner = openFrame(bytes, session);
        } catch {
          stats.cryptoFailures += 1;
          /*
           * `answer-anyway`：**解不开也照回一条**（用它自己那套密钥封装）。
           *
           * 这是"错 psk"场景的关键一步：两端 psk 不同 ⇒ 派生出的密钥不同。
           * 若服务端此刻直接断连，客户端看到的是"连接被断开"（BACKEND_UNREACHABLE），
           * 而**客户端自己的 tag 校验路径反而没被验到** —— 那正是错 psk 时页面要走的代码。
           * 所以这里故意回一条客户端解不开的帧，让客户端的失败路径暴露出来。
           */
          if (mode === 'answer-anyway') {
            try {
              conn.send({ type: 'res', id: headerId(bytes), data: { from: 'server-with-different-keys' } });
            } catch {
              socket.destroy();
            }
            continue;
          }
          socket.destroy();
          return;
        }
        let decodedInner;
        try {
          decodedInner = decodeFrame(inner);
        } catch {
          continue;
        }
        dispatch(conn, decodedInner, stats, mode);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(conn));
  });

  return {
    stats,
    /** 当前活着的连接（场景 5 要主动推一条帧，绕过 dispatch）。 */
    conns: sockets,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const conn of sockets) conn.close();
        server.close(() => resolve());
      }),
  };
}

/** 服务端的方法处理：只实现这个门禁需要的几条，**故意不与真契约耦合**。 */
function dispatch(conn, frame, stats, mode) {
  if (frame.type !== 'req') {
    return;
  }
  const { id, method, params } = frame;
  if (method === 'bridge.ping') {
    const sealed = conn.send({ type: 'res', id, data: { protocol: 5, platform: 'desktop', ver: '0.0.0-e2e' } });
    // 重放场景：把**同一条密文**再发一次 —— 客户端的序号水位必须拒绝它
    if (mode === 'replay') {
      conn.replay(sealed);
    }
    return;
  }
  if (mode === 'plaintext') {
    // 坏场景：服务端发一条**明文** res（v5 里除 hello 外都必须封装）
    conn.sendRaw(encodeFrame({ type: 'res', id, data: { sneaky: true } }));
    return;
  }
  if (method === 'demo.echo') {
    conn.send({ type: 'res', id, data: { echo: params ?? null } });
    return;
  }
  if (method === 'demo.subscribe') {
    conn.send({ type: 'res', id, data: { ok: true } });
    conn.send({ type: 'evt', topic: 'demo.tick', data: { n: 1 } });
    return;
  }
  if (method === 'demo.big') {
    // 大事件：正文 25 万字符（外层会明显超过 256KB 的明文上限，但没超过 +295 之后的硬上限）
    conn.send({ type: 'res', id, data: { ok: true } });
    conn.send({ type: 'evt', topic: 'demo.big', data: { blob: 'x'.repeat(250_000) } });
    return;
  }
  if (method === 'demo.bin') {
    conn.send({ type: 'res', id, data: { ok: true } });
    return;
  }
  conn.send({ type: 'err', id, error: { code: 'BRIDGE_METHOD_UNKNOWN', messageKey: 'bridge.methodUnknown' } });
}

// ---------------------------------------------------------------- 客户端

function bootstrapFor(port, psk) {
  return {
    host: '127.0.0.1',
    port,
    psk,
    platform: 'desktop',
    ver: '0.0.0-e2e',
    protocol: 5,
    capabilities: [],
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等到条件成立或超时（**超时返回 false = 失败**，不是"跳过"）。 */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(30);
  }
}

// ---------------------------------------------------------------- 场景

async function main() {
  const { mod, cleanup } = await bundleRealTransport();
  const { WebSocketTransport } = mod;
  const PSK = 'e2e-psk-0123456789abcdef'; // ≥ MIN_PSK_BYTES
  check(
    `自检自己用的 psk 满足最小长度（${SEAL_MIN_PSK_BYTES} 字节）`,
    Buffer.byteLength(PSK, 'utf8') >= SEAL_MIN_PSK_BYTES,
  );

  try {
    // ============================================================ 1. 正常路径
    console.log('--- 1. 正常路径：hello → 密文 req/res → 密文 evt ---');
    const srv = createCryptoServer({ psk: PSK });
    const port = await srv.listen();
    const client = new WebSocketTransport(bootstrapFor(port, PSK), {
      callTimeoutMs: 5000,
      connectTimeoutMs: 3000,
      maxAttempts: 0,
    });
    const states = [];
    client.onStateChange((s) => states.push(s));

    const ping = await client.call('bridge.ping');
    check('真 WebSocketTransport 能连上并完成 ping（密钥协商走通）', ping?.protocol === 5, JSON.stringify(ping));
    check('建连状态走过 connecting → open', states.includes('connecting') && states.includes('open'), states.join('→'));

    const url = srv.stats.lastUpgradeUrl;
    const k = new URL(url, 'http://127.0.0.1').searchParams.get('k') ?? '';
    check('升级 URL 只带 `?k=`（客户端临时公钥，130 个 hex）', /^[0-9a-f]{130}$/i.test(k), k.slice(0, 16) + '…');
    check(
      '升级 URL 里**没有凭据**（psk / token 都不上线）',
      !/psk/i.test(url) && !/token/i.test(url),
      url,
    );
    check(
      'Node 的 WebSocket 不带 Origin（浏览器会带 app://wise）—— 这是本门禁与真机的唯一差异',
      srv.stats.lastOrigin === '' || srv.stats.lastOrigin === ORIGIN,
      srv.stats.lastOrigin === '' ? '缺省（Node 行为）' : srv.stats.lastOrigin,
    );
    check('服务端发出的 hello 是明文（唯一允许明文的帧）', typeof srv.stats.helloPublicKey === 'string' && srv.stats.helloPublicKey.length === 130);
    check('客户端发来的第一条帧是**密文**（不是明文 hello 回礼）', srv.stats.sawEncryptedClientFrame && !srv.stats.sawPlaintextClientFrame);

    const echo = await client.call('demo.echo', { tag: 'TAG-0001', n: 7 });
    check(
      '带参数的 req/res 往返正确（密文路径上的业务数据没被改动）',
      echo?.echo?.tag === 'TAG-0001' && echo?.echo?.n === 7,
      JSON.stringify(echo),
    );

    const ticks = [];
    const off = client.subscribe('demo.tick', (data) => ticks.push(data));
    await client.call('demo.subscribe');
    check('密文 evt 能到达订阅者', await until(() => ticks.length >= 1), `ticks=${ticks.length}`);
    off();

    // 大事件：250KB 正文 → 外层约 250KB + 28，仍在硬上限内
    const big = [];
    client.subscribe('demo.big', (data) => big.push(data));
    await client.call('demo.big');
    const gotBig = await until(() => big.length >= 1, 8000);
    check('大事件（25 万字符）也能通过密文路径到达', gotBig && big[0]?.blob?.length === 250_000, `len=${big[0]?.blob?.length ?? 0}`);
    check('大事件之后连接仍然可用（不是"读坏了半截"）', (await client.call('bridge.ping'))?.protocol === 5);

    client.close();
    await srv.close();

    // ============================================================ 2. 错 psk
    console.log('--- 2. 错 psk：必须明确失败，不许"看起来连上了" ---');
    /*
     * 两端 psk 不同 ⇒ 派生出的密钥不同。客户端**在握手时看不出来**（hello 是明文、
     * 双方都算得出一个密钥），它只能等到第一条密文的 tag 校验失败才知道 ——
     * 所以这里让服务端"解不开也照回一条"，把客户端自己的失败路径逼出来。
     */
    const srvWrong = createCryptoServer({ psk: 'server-side-psk-!!!!!!!!', mode: 'answer-anyway' });
    const wrongPort = await srvWrong.listen();
    const wrongClient = new WebSocketTransport(bootstrapFor(wrongPort, PSK), {
      callTimeoutMs: 4000,
      connectTimeoutMs: 3000,
      maxAttempts: 0,
    });
    let wrongErr = null;
    try {
      await wrongClient.call('bridge.ping');
    } catch (e) {
      wrongErr = e;
    }
    check(
      '错 psk ⇒ 调用失败，错误码是 BRIDGE_CRYPTO_FAILED（客户端的 tag 校验走到了）',
      wrongErr !== null && wrongErr.code === 'BRIDGE_CRYPTO_FAILED',
      wrongErr === null ? '居然成功了' : `${wrongErr.code} / ${wrongErr.messageKey}`,
    );
    check(
      '错 psk 之后连接**不是** open（没有假装连上）',
      await until(() => wrongClient.state !== 'open', 3000),
      wrongClient.state,
    );
    wrongClient.close();
    await srvWrong.close();

    // ============================================================ 3. 重放旧 res
    console.log('--- 3. 重放旧帧：序号回退必须被拒 ---');
    const srvReplay = createCryptoServer({ psk: PSK, mode: 'replay' });
    const replayPort = await srvReplay.listen();
    const replayClient = new WebSocketTransport(bootstrapFor(replayPort, PSK), {
      callTimeoutMs: 3000,
      connectTimeoutMs: 3000,
      maxAttempts: 0,
    });
    // 服务端在这一条 ping 的答复之后会**原样重发**同一帧
    try {
      await replayClient.call('bridge.ping');
    } catch {
      // 第一次答复可能已经成功、也可能连带失败，两种都接受；关键是下面这条
    }
    const dropped = await until(() => replayClient.state !== 'open', 4000);
    check('重放导致连接被丢弃（state 不再 open）', dropped, replayClient.state);
    let replayErr = null;
    try {
      await replayClient.call('bridge.ping');
    } catch (e) {
      replayErr = e;
    }
    check('丢弃之后的下一次调用**不会**成功（没有继续用一条已污染的连接）', replayErr !== null, replayErr?.code ?? '成功了');
    replayClient.close();
    await srvReplay.close();

    // ============================================================ 4. 服务端发明文帧
    console.log('--- 4. 明文非 hello 帧：必须被拒 ---');
    const srvPlain = createCryptoServer({ psk: PSK, mode: 'plaintext' });
    const plainPort = await srvPlain.listen();
    const plainClient = new WebSocketTransport(bootstrapFor(plainPort, PSK), {
      callTimeoutMs: 3000,
      connectTimeoutMs: 3000,
      maxAttempts: 0,
    });
    let plainErr = null;
    try {
      await plainClient.call('demo.echo', { x: 1 });
    } catch (e) {
      plainErr = e;
    }
    const plainDropped = await until(() => plainClient.state !== 'open', 4000);
    check(
      '收到封装的非 hello 帧 ⇒ 断开（而不是把它当明文 JSON 解析）',
      plainErr !== null && plainDropped,
      `code=${plainErr?.code ?? '无'} state=${plainClient.state}`,
    );
    plainClient.close();
    await srvPlain.close();

    // ============================================================ 5. 封装开销必须算进上限
    console.log('--- 5. 边界：外层比明文多 28 字节，上限判定必须带上它 ---');
    const srvBin = createCryptoServer({ psk: PSK });
    const binPort = await srvBin.listen();
    /*
     * `binMaxBytes` 故意压到 1000：
     * 内层正文 1000 字节 ⇒ 外层 = 1000 + 28 + 12(头) + id ≈ 1040 **大于** binMaxBytes，
     * 但小于 binMaxBytes + 295。客户端若拿"外层长度"直接比 binMaxBytes 就会误关连接。
     */
    const binClient = new WebSocketTransport(bootstrapFor(binPort, PSK), {
      callTimeoutMs: 3000,
      connectTimeoutMs: 3000,
      maxAttempts: 0,
      limits: { textMaxBytes: 262144, binMaxBytes: 1000 },
    });
    await binClient.call('bridge.ping');
    const conn = [...srvBin.conns][0];
    check('（准备）拿到服务端连接以便主动发一条超大 bin', conn !== undefined);
    if (conn) {
      const body = new Uint8Array(1000);
      const sealedBin = conn.send({ type: 'bin', id: 'bin-1', body });
      check(
        '（准备）这条 bin 的外层确实 > binMaxBytes 且 ≤ binMaxBytes + 295',
        sealedBin.length > 1000 && sealedBin.length <= 1000 + WIRE_SEALED_OVERHEAD_BYTES,
        `outer=${sealedBin.length} 明文开销=${SEAL_BODY_OVERHEAD_BYTES}`,
      );
      await sleep(200);
      const stillOpen = binClient.state === 'open';
      check('外层略超 binMaxBytes 的帧被**收下**（+295 算进了上限）', stillOpen, `state=${binClient.state}`);
      check(
        '而且连接还能继续用（不是"默默半死"）',
        stillOpen && (await binClient.call('bridge.ping'))?.protocol === 5,
      );
    }
    binClient.close();
    await srvBin.close();

    // ============================================================ 6. 无 k 的升级必须被拒（服务端侧）
    console.log('--- 6. 服务端侧：`?k=` 缺失/不合法必须拒 ---');
    const srvReject = createCryptoServer({ psk: PSK });
    const rejectPort = await srvReject.listen();
    const rejected = await rawUpgrade(rejectPort, '/bridge');
    check('没有 `?k=` 的升级被拒（400）', rejected.startsWith('HTTP/1.1 400'), rejected.split('\r\n')[0]);
    const badPoint = await rawUpgrade(rejectPort, '/bridge?k=zz');
    check('`?k=` 不是合法 hex/长度 的升级被拒（400）', badPoint.startsWith('HTTP/1.1 400'), badPoint.split('\r\n')[0]);
    check('被拒的升级没有进到帧阶段（服务端计数一致）', srvReject.stats.rejectedUpgrades === 2, `rejected=${srvReject.stats.rejectedUpgrades}`);
    await srvReject.close();
  } finally {
    cleanup();
  }

  console.log('');
  if (fail > 0) {
    console.error(`check-bridge-crypto-e2e FAIL：${fail}/${pass + fail} 项未通过`);
    process.exit(1);
  }
  console.log(
    `check-bridge-crypto-e2e OK: ${pass} 项（真 WebSocketTransport × 手写 WS 服务端 / 正常路径 + 错 psk + 重放 + 明文 + 上限边界）`,
  );
}

/**
 * 用**裸 socket** 发一次 WebSocket 升级请求（不经过任何客户端实现）。
 *
 * 这里刻意不用 `WebSocketTransport`：要验的是**服务端**对坏 `?k=` 的处理，
 * 用真客户端反而构造不出坏输入（它自己就会生成合法公钥）。
 */
async function rawUpgrade(port, requestPath) {
  return await new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Origin: ${ORIGIN}\r\n\r\n`,
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      socket.destroy();
      resolve(data);
    });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 2000);
  });
}

void main().catch((e) => {
  console.error(`check-bridge-crypto-e2e 崩了：${e?.stack ?? e}`);
  process.exit(1);
});

// 供 ESLint 之类的工具看到这些"只用于阅读"的常量确实被引用了
void WIRE_HEADER_BYTES;
void WireKind;
