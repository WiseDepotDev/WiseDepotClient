/**
 * 协议 v4 的**工具侧**线格式实现（bench / check / smoke 共用）。
 *
 * ## 为什么要有这个文件
 *
 * v3 时每个工具都自己 `ws.send(JSON.stringify({v:3,type:'req',…}))`、
 * 自己 `JSON.parse(ev.data)` —— 11 份"我说 wire"的副本。v4 把线格式换成二进制帧头后，
 * 与其改 11 处形状各异的代码，不如把编解码收到这里一份：
 * **工具侧也只剩一份 wire 实现**（与 Kotlin `BridgeWire.kt`、TS `wire.ts` 逐字节对应）。
 *
 * ## 迁移一个工具要改三处（照着做即可）
 *
 * ```js
 * import { decodeFrame, encodeFrame, sendReq } from '../lib/bridge-wire.mjs';
 *
 * const ws = new WebSocket(url);
 * ws.binaryType = 'arraybuffer';                       // ① 否则拿到 Blob，读字节要 async
 * ws.onmessage = (ev) => {
 *   const frame = decodeFrame(new Uint8Array(ev.data)); // ② 原来的 JSON.parse 换成这一行
 *   if (frame.type === 'res') { … frame.data … }        //    断言形状不变：type/id/data/error/topic
 * };
 * sendReq(ws, id, 'bridge.ping');                      // ③ 原来的 ws.send(JSON.stringify(…))
 * ```
 *
 * 帧头布局与 Kotlin / TS 两份实现完全一致（12 字节定长，全小端）：
 * `magic('W','B') / ver=4 / kind / flags / hdrExt / idLen(u16) / bodyLen(u32) / id / body`
 */

import { createCipheriv, createDecipheriv, createECDH, createHmac } from 'node:crypto';

export const WIRE_HEADER_BYTES = 12;
export const WIRE_FLAG_FINAL = 0x01;
/** bit1：正文是密文（v5）。只有 hello 帧可以是 0。 */
export const WIRE_FLAG_ENC = 0x02;
const WIRE_KNOWN_FLAGS = WIRE_FLAG_FINAL | WIRE_FLAG_ENC;
export const WIRE_MAX_ID_BYTES = 255;
export const WIRE_PROTOCOL_VERSION = 5;

export const WireKind = { REQ: 0x01, RES: 0x02, ERR: 0x03, EVT: 0x04, HELLO: 0x05, BIN: 0x10 };

const MAGIC_W = 0x57;
const MAGIC_B = 0x42;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 去掉 `undefined`/`null` 字段，与 Kotlin 的 `explicitNulls = false` 对齐。 */
function compact(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

/** 逻辑帧 → 线上字节。`frame.type` 为 req/res/err/evt/bin。 */
export function encodeFrame(frame) {
  let kind;
  let id;
  let flags = WIRE_FLAG_FINAL;
  let body;
  switch (frame.type) {
    case 'req':
      kind = WireKind.REQ;
      id = frame.id;
      body = encoder.encode(JSON.stringify(compact({ method: frame.method, params: frame.params, meta: frame.meta })));
      break;
    case 'res':
      kind = WireKind.RES;
      id = frame.id;
      body = encoder.encode(JSON.stringify(compact({ data: frame.data, meta: frame.meta })));
      break;
    case 'err':
      kind = WireKind.ERR;
      id = frame.id;
      body = encoder.encode(JSON.stringify({ error: compact(frame.error ?? {}) }));
      break;
    case 'evt':
      kind = WireKind.EVT;
      id = '';
      body = encoder.encode(JSON.stringify(compact({ topic: frame.topic, data: frame.data })));
      break;
    case 'hello':
      kind = WireKind.HELLO;
      id = '';
      body = encoder.encode(JSON.stringify({ k: frame.publicKeyHex }));
      break;
    case 'bin':
      kind = WireKind.BIN;
      id = frame.id;
      body = frame.body;
      flags = frame.final === false ? 0 : WIRE_FLAG_FINAL;
      break;
    default:
      throw new Error(`未知帧类型：${String(frame.type)}`);
  }

  const idBytes = encoder.encode(id);
  const out = new Uint8Array(WIRE_HEADER_BYTES + idBytes.length + body.length);
  const view = new DataView(out.buffer);
  out[0] = MAGIC_W;
  out[1] = MAGIC_B;
  out[2] = WIRE_PROTOCOL_VERSION;
  out[3] = kind;
  out[4] = flags;
  out[5] = 0;
  view.setUint16(6, idBytes.length, true);
  view.setUint32(8, body.length, true);
  out.set(idBytes, WIRE_HEADER_BYTES);
  out.set(body, WIRE_HEADER_BYTES + idBytes.length);
  return out;
}

/** 尽力从帧头抠 id（帧坏了也要能对上号）。 */
export function headerId(bytes) {
  if (bytes.length < WIRE_HEADER_BYTES || bytes[0] !== MAGIC_W || bytes[1] !== MAGIC_B) {
    return '';
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(6, true);
  if (idLen <= 0 || idLen > WIRE_MAX_ID_BYTES || bytes.length < WIRE_HEADER_BYTES + idLen) {
    return '';
  }
  return decoder.decode(bytes.subarray(WIRE_HEADER_BYTES, WIRE_HEADER_BYTES + idLen));
}

/**
 * 线上字节 → 逻辑帧；结构不合法抛 `Error`（消息里带 fault 与尽力抠出的 id）。
 *
 * 返回形状刻意与 v3 的断言兼容：`{type,id,data,error,topic}` ——
 * 这是**工具的内存模型**，不是线格式；线格式只有这里与两份宿主实现共三份定义。
 */
export function decodeFrame(bytes) {
  if (bytes.length < WIRE_HEADER_BYTES) {
    throw new Error('WIRE: TRUNCATED');
  }
  if (bytes[0] !== MAGIC_W || bytes[1] !== MAGIC_B) {
    throw new Error(`WIRE: BAD_MAGIC（收到文本帧？v4 只走二进制）id=${headerId(bytes)}`);
  }
  const id = headerId(bytes);
  if (bytes[2] !== WIRE_PROTOCOL_VERSION) {
    throw new Error(`WIRE: BAD_VERSION 期望 ${WIRE_PROTOCOL_VERSION} 实得 ${bytes[2]} id=${id}`);
  }
  const kind = bytes[3];
  const flags = bytes[4];
  if ((flags & ~WIRE_KNOWN_FLAGS) !== 0) {
    throw new Error(`WIRE: BAD_FLAGS ${flags} id=${id}`);
  }
  // 这一层解的是明文/内层帧：ENC 位一律不允许（密文先过 openFrame）
  if ((flags & WIRE_FLAG_ENC) !== 0) {
    throw new Error(`WIRE: BAD_FLAGS ENC 位出现在明文帧上 id=${id}`);
  }
  if (bytes[5] !== 0) {
    throw new Error(`WIRE: BAD_EXT id=${id}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(6, true);
  const bodyLen = view.getUint32(8, true);
  if (idLen > WIRE_MAX_ID_BYTES || bytes.length !== WIRE_HEADER_BYTES + idLen + bodyLen) {
    throw new Error(`WIRE: BAD_LENGTH id=${id}`);
  }
  const body = bytes.subarray(WIRE_HEADER_BYTES + idLen);
  if (kind === WireKind.BIN) {
    return { type: 'bin', id, body, final: (flags & WIRE_FLAG_FINAL) !== 0 };
  }
  const parsed = JSON.parse(decoder.decode(body));
  switch (kind) {
    case WireKind.REQ:
      return { type: 'req', id, method: parsed.method, params: parsed.params, meta: parsed.meta };
    case WireKind.RES:
      return { type: 'res', id, data: parsed.data, meta: parsed.meta };
    case WireKind.ERR:
      return { type: 'err', id, error: parsed.error };
    case WireKind.EVT:
      return { type: 'evt', topic: parsed.topic, data: parsed.data };
    case WireKind.HELLO:
      // hello 的 idLen 必须是 0（它没有请求可关联）
      if (id !== '') {
        throw new Error(`WIRE: BAD_BODY hello 帧不该带 id id=${id}`);
      }
      return { type: 'hello', publicKeyHex: String(parsed.k ?? '') };
    default:
      throw new Error(`WIRE: BAD_KIND ${kind} id=${id}`);
  }
}

/** 发一条请求帧（**统一走这里**，别在工具里各自拼 JSON）。 */
export function sendReq(ws, id, method, params) {
  ws.send(encodeFrame({ type: 'req', id, method, ...(params === undefined ? {} : { params }) }));
}

/** 断言失败时把帧打成一行可读文本（等价于 v3 里那些 `JSON.stringify(frame)`）。 */
export function frameText(frame) {
  if (frame && frame.type === 'bin') {
    return `bin(id=${frame.id}, ${frame.body.length}B, final=${frame.final})`;
  }
  return JSON.stringify(frame);
}

// ================================================================ 加密层（v5）

/**
 * 协议 v5 的加密原语（工具侧，node:crypto）。
 *
 * 与 `BridgeCrypto.kt`、`packages/bridge-client/src/seal.ts` **逐位同口径**：
 * 临时 ECDH（P-256）→ HMAC-SHA256 域分隔 KDF → AES-256-GCM。
 * 三份实现对 `bridge/protocol/src/test/resources/bridge-crypto-vectors.json`
 * 必须产出同一份密文 —— 由 `tools/check/check-bridge-crypto-vectors.mjs` 钉住。
 *
 * 这里只放**原语**：帧头与外层封装是 S2/S3 的事（改 `WIRE_PROTOCOL_VERSION` 也在那时）。
 * 提前把原语放进来，是为了让"三端同向量"这条门禁在升版本之前就能跑起来。
 */

export const SEAL_TAG_BYTES = 16;
export const SEAL_NONCE_BYTES = 12;
export const SEAL_KEY_BYTES = 32;
/** psk 的最小长度（不是"必须等于 32"）：psk 是引导里 psk/token 的 ASCII 字节（43 个字符）。 */
export const SEAL_MIN_PSK_BYTES = 16;
export const SEAL_PUBLIC_KEY_BYTES = 65;
export const SEAL_SHARED_BYTES = 32;

/** 密文正文相对明文的开销：nonce 12 + tag 16（外层帧头 12 字节另算）。 */
export const SEAL_BODY_OVERHEAD_BYTES = SEAL_NONCE_BYTES + SEAL_TAG_BYTES;

export const DIR_CLIENT_TO_SERVER = 0x01;
export const DIR_SERVER_TO_CLIENT = 0x02;
export const MAX_SEQ_GAP = 4096;

const KDF_LABEL = 'wd-bridge/v5/kdf';
const LABEL_CLIENT_SIDE = 'c';
const LABEL_SERVER_SIDE = 's';
const LABEL_C2S = 'wd-bridge/v5/c2s';
const LABEL_S2C = 'wd-bridge/v5/s2c';

/** 加密层的失败：与"线格式不认识"分开（出路不同：这条连接不可信 vs 两端不是一版）。 */
export class BridgeCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeCryptoError';
  }
}

const HEX_DIGITS = '0123456789abcdef';

export function hexOf(bytes) {
  let out = '';
  for (const b of bytes) {
    out += HEX_DIGITS[b >>> 4] + HEX_DIGITS[b & 0x0f];
  }
  return out;
}

export function fromHex(text) {
  if (text.length % 2 !== 0) {
    throw new BridgeCryptoError(`hex 长度必须是偶数：${text.length}`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (hexDigit(text[i * 2]) << 4) | hexDigit(text[i * 2 + 1]);
  }
  return out;
}

function hexDigit(c) {
  const code = c.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  throw new BridgeCryptoError(`非法 hex 字符：${c}`);
}

/** nonce：`dir(1) ‖ seq(8，大端) ‖ 0x00 0x00 0x00`（布局必须与另两份实现逐字节一致）。 */
export function nonceOf(dir, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new BridgeCryptoError(`序号必须是安全整数：${seq}`);
  }
  const out = Buffer.alloc(SEAL_NONCE_BYTES);
  out[0] = dir;
  out.writeBigUInt64BE(BigInt(seq), 1);
  return out;
}

/** 从上线字节里读序号；方向不符即抛错。 */
export function seqOf(dir, sealed) {
  if (sealed.length < SEAL_BODY_OVERHEAD_BYTES) {
    throw new BridgeCryptoError(`密文正文太短：${sealed.length}`);
  }
  if (sealed[0] !== dir) {
    throw new BridgeCryptoError(`方向字节不符：期望 ${dir} 实得 ${sealed[0]}`);
  }
  const seq = Number(Buffer.from(sealed.subarray(1, 9)).readBigUInt64BE(0));
  if (!Number.isSafeInteger(seq)) {
    throw new BridgeCryptoError(`序号超出安全整数范围：${seq}`);
  }
  return seq;
}

/** 生成一次性 P-256 密钥对（**每次建连**一套 —— 前向保密的来源）。 */
export function generateEphemeral() {
  const ecdh = createECDH('prime256v1');
  const publicKey = Uint8Array.from(ecdh.generateKeys());
  return { ecdh, publicKey, privateScalar: Uint8Array.from(ecdh.getPrivateKey()) };
}

/** 用给定私钥标量重建 ECDH（测试向量用：向量里给的是标量，才能三端复算）。 */
export function ecdhFromPrivateScalar(scalar) {
  if (scalar.length !== 32) {
    throw new BridgeCryptoError(`P-256 私钥标量必须是 32 字节，实得 ${scalar.length}`);
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(scalar));
  return ecdh;
}

/** `Z`：ECDH 共享秘密（P-256 的 X 坐标，32 字节）。 */
export function sharedSecret(ecdh, peerPublicKey) {
  if (peerPublicKey.length !== SEAL_PUBLIC_KEY_BYTES || peerPublicKey[0] !== 0x04) {
    throw new BridgeCryptoError('对端公钥不是合法的 P-256 未压缩点');
  }
  const z = Uint8Array.from(ecdh.computeSecret(Buffer.from(peerPublicKey)));
  if (z.length !== SEAL_SHARED_BYTES) {
    throw new BridgeCryptoError(`ECDH 共享秘密长度异常：${z.length}`);
  }
  return z;
}

/**
 * ```text
 * K_conn = HMAC-SHA256(psk, "wd-bridge/v5/kdf" ‖ "c" ‖ clientPub ‖ "s" ‖ serverPub ‖ Z)
 * K_c2s  = HMAC-SHA256(K_conn, "wd-bridge/v5/c2s")
 * K_s2c  = HMAC-SHA256(K_conn, "wd-bridge/v5/s2c")
 * ```
 */
export function sessionKeys(psk, clientPub, serverPub, z) {
  if (psk.length < SEAL_MIN_PSK_BYTES) throw new BridgeCryptoError(`psk 至少 ${SEAL_MIN_PSK_BYTES} 字节，实得 ${psk.length}`);
  if (clientPub.length !== SEAL_PUBLIC_KEY_BYTES || clientPub[0] !== 0x04) {
    throw new BridgeCryptoError('clientPub 必须是 65 字节未压缩点');
  }
  if (serverPub.length !== SEAL_PUBLIC_KEY_BYTES || serverPub[0] !== 0x04) {
    throw new BridgeCryptoError('serverPub 必须是 65 字节未压缩点');
  }
  if (z.length !== SEAL_SHARED_BYTES) throw new BridgeCryptoError(`Z 必须是 ${SEAL_SHARED_BYTES} 字节`);

  const transcript = Buffer.concat([
    Buffer.from(KDF_LABEL, 'utf8'),
    Buffer.from(LABEL_CLIENT_SIDE, 'utf8'),
    Buffer.from(clientPub),
    Buffer.from(LABEL_SERVER_SIDE, 'utf8'),
    Buffer.from(serverPub),
    Buffer.from(z),
  ]);
  const connection = hmac(psk, transcript);
  return {
    connection,
    clientToServer: hmac(connection, Buffer.from(LABEL_C2S, 'utf8')),
    serverToClient: hmac(connection, Buffer.from(LABEL_S2C, 'utf8')),
  };
}

function hmac(key, message) {
  return Uint8Array.from(createHmac('sha256', Buffer.from(key)).update(message).digest());
}

/** 加密：`nonce(12) ‖ 密文 ‖ tag(16)`。 */
export function seal(key, dir, seq, plaintext, aad) {
  if (key.length !== SEAL_KEY_BYTES) throw new BridgeCryptoError(`密钥必须是 ${SEAL_KEY_BYTES} 字节`);
  const nonce = nonceOf(dir, seq);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
  if (aad.length > 0) {
    cipher.setAAD(Buffer.from(aad));
  }
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return Uint8Array.from(Buffer.concat([nonce, body]));
}

/** 解密：tag 失败 / 长度不对 / 方向不符都抛 [BridgeCryptoError]。 */
export function open(key, dir, sealed, aad) {
  if (key.length !== SEAL_KEY_BYTES) throw new BridgeCryptoError(`密钥必须是 ${SEAL_KEY_BYTES} 字节`);
  const seq = seqOf(dir, sealed);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonceOf(dir, seq)));
  if (aad.length > 0) {
    decipher.setAAD(Buffer.from(aad));
  }
  const tagStart = sealed.length - SEAL_TAG_BYTES;
  decipher.setAuthTag(Buffer.from(sealed.subarray(tagStart)));
  try {
    return Uint8Array.from(
      Buffer.concat([
        decipher.update(Buffer.from(sealed.subarray(SEAL_NONCE_BYTES, tagStart))),
        decipher.final(),
      ]),
    );
  } catch (e) {
    throw new BridgeCryptoError(`密文校验失败（tag 不符或已损坏）：${e.message}`);
  }
}

/**
 * 一条连接的加密会话：三把密钥 + 两个方向的序号水位。
 * 生命周期与连接一致（**不复用、不跨连接** —— 跨连接复用会重用 `(key, nonce)`）。
 */
export class SealSession {
  constructor(keys, role) {
    this.keys = keys;
    this.role = role;
    this.outboundSeq = 0;
    this.inboundSeq = 0;
  }

  get outboundDirection() {
    return this.role === 'client' ? DIR_CLIENT_TO_SERVER : DIR_SERVER_TO_CLIENT;
  }

  get outboundKey() {
    return this.role === 'client' ? this.keys.clientToServer : this.keys.serverToClient;
  }

  get inboundKey() {
    return this.role === 'client' ? this.keys.serverToClient : this.keys.clientToServer;
  }

  seal(plaintext, aad) {
    this.outboundSeq += 1;
    return seal(this.outboundKey, this.outboundDirection, this.outboundSeq, plaintext, aad);
  }

  /** 解密 + 防重放（方向必须是对端方向，序号严格单调递增且有界）。 */
  open(sealed, aad) {
    const peerDirection = this.role === 'client' ? DIR_SERVER_TO_CLIENT : DIR_CLIENT_TO_SERVER;
    const seq = seqOf(peerDirection, sealed);
    if (seq <= this.inboundSeq) {
      throw new BridgeCryptoError(`序号回退/重放：已收到 ${this.inboundSeq}，又收到 ${seq}`);
    }
    if (seq - this.inboundSeq > MAX_SEQ_GAP) {
      throw new BridgeCryptoError(`序号跳跃过大：${this.inboundSeq} → ${seq}`);
    }
    const plaintext = open(this.inboundKey, peerDirection, sealed, aad);
    this.inboundSeq = seq;
    return plaintext;
  }
}

// ================================================================ 加密封装（v5）

/**
 * 封装开销上限：外层头 12 + 最大 id 255 + nonce 12 + tag 16（=295）。
 * 算术只写这一处，结构硬上限必须走 [sealedHardLimitFor]。
 */
export const WIRE_SEALED_OVERHEAD_BYTES = WIRE_HEADER_BYTES + WIRE_MAX_ID_BYTES + SEAL_BODY_OVERHEAD_BYTES;

/** 结构上限（与 Kotlin `BridgeWire` 同值）：控制面 1MiB、数据面 8MiB。 */
export const WIRE_HARD_CONTROL_BYTES = 256 * 1024 * 4;
export const WIRE_HARD_BIN_BYTES = 8 * 1024 * 1024;

/** 这条 kind 的**外层（含封装）**结构上限：内层上限 + 295。 */
export function sealedHardLimitFor(kind) {
  const base = kind === WireKind.BIN ? WIRE_HARD_BIN_BYTES : WIRE_HARD_CONTROL_BYTES;
  return base + WIRE_SEALED_OVERHEAD_BYTES;
}

/**
 * 把一条**完整的内层消息**封装成外层密文消息。
 *
 * 外层头明文（kind 让接收端在解密前就能选限额；id 让解密失败时还能回一条带 id 的错误），
 * AAD = 外层 12 字节头 ‖ id —— 帧头被篡改一定表现为 tag 失败。
 */
export function sealFrame(inner, session) {
  if (inner.length < WIRE_HEADER_BYTES) {
    throw new BridgeCryptoError(`内层消息太短：${inner.length}`);
  }
  const kind = inner[3];
  if (!Number.isInteger(kind) || !Object.values(WireKind).includes(kind)) {
    throw new BridgeCryptoError(`内层 kind 未知：${kind}`);
  }
  if (kind === WireKind.HELLO) {
    throw new BridgeCryptoError('hello 帧不允许被加密');
  }
  if ((inner[4] & WIRE_FLAG_ENC) !== 0) {
    throw new BridgeCryptoError('内层消息本身不能是密文（会叠两层封装）');
  }
  const innerView = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  const idLen = innerView.getUint16(6, true);
  if (inner.length !== WIRE_HEADER_BYTES + idLen + innerView.getUint32(8, true)) {
    throw new BridgeCryptoError('内层消息长度不自洽');
  }

  const bodyLen = inner.length + SEAL_BODY_OVERHEAD_BYTES;
  const outer = new Uint8Array(WIRE_HEADER_BYTES + idLen + bodyLen);
  const view = new DataView(outer.buffer);
  outer[0] = MAGIC_W;
  outer[1] = MAGIC_B;
  outer[2] = WIRE_PROTOCOL_VERSION;
  outer[3] = kind;
  outer[4] = WIRE_FLAG_FINAL | WIRE_FLAG_ENC;
  outer[5] = 0;
  view.setUint16(6, idLen, true);
  view.setUint32(8, bodyLen, true);
  outer.set(inner.subarray(WIRE_HEADER_BYTES, WIRE_HEADER_BYTES + idLen), WIRE_HEADER_BYTES);

  const aad = outer.slice(0, WIRE_HEADER_BYTES + idLen);
  outer.set(session.seal(inner, aad), WIRE_HEADER_BYTES + idLen);
  return outer;
}

/**
 * 打开一条外层密文消息，返回**内层完整消息**。
 *
 * 判定：外层结构、tag 与序号（走 [SealSession]）、内外一致性（kind / id 必须相同 ——
 * 这是"外层头是明文"的代价）。任何一项不对都抛错，调用方据此断开（不是猜一猜继续）。
 */
export function openFrame(outer, session) {
  if (outer.length < WIRE_HEADER_BYTES) {
    throw new BridgeCryptoError(`外层消息太短：${outer.length}`);
  }
  if (outer[0] !== MAGIC_W || outer[1] !== MAGIC_B) {
    throw new BridgeCryptoError('外层 magic 不对');
  }
  if (outer[2] !== WIRE_PROTOCOL_VERSION) {
    throw new BridgeCryptoError(`外层版本不是 ${WIRE_PROTOCOL_VERSION}`);
  }
  const kind = outer[3];
  if (kind === WireKind.HELLO || !Object.values(WireKind).includes(kind)) {
    throw new BridgeCryptoError(`外层 kind 非法：${kind}`);
  }
  const flags = outer[4];
  if ((flags & ~WIRE_KNOWN_FLAGS) !== 0) {
    throw new BridgeCryptoError(`外层 flags 有未知位：${flags}`);
  }
  if ((flags & WIRE_FLAG_ENC) === 0) {
    throw new BridgeCryptoError('外层不是密文帧（ENC=0）');
  }
  if (outer[5] !== 0) {
    throw new BridgeCryptoError('外层 hdrExt 必须为 0');
  }
  const view = new DataView(outer.buffer, outer.byteOffset, outer.byteLength);
  const idLen = view.getUint16(6, true);
  const bodyLen = view.getUint32(8, true);
  if (idLen > WIRE_MAX_ID_BYTES || outer.length !== WIRE_HEADER_BYTES + idLen + bodyLen) {
    throw new BridgeCryptoError('外层长度不自洽');
  }

  const aad = outer.slice(0, WIRE_HEADER_BYTES + idLen);
  const inner = session.open(outer.slice(WIRE_HEADER_BYTES + idLen), aad);

  if (inner.length < WIRE_HEADER_BYTES || inner[3] !== kind) {
    throw new BridgeCryptoError('内外 kind 不一致');
  }
  const innerView = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  if (innerView.getUint16(6, true) !== idLen) {
    throw new BridgeCryptoError('内外 idLen 不一致');
  }
  for (let i = 0; i < idLen; i += 1) {
    if (inner[WIRE_HEADER_BYTES + i] !== outer[WIRE_HEADER_BYTES + i]) {
      throw new BridgeCryptoError('内外 id 不一致');
    }
  }
  return inner;
}

/** 这条消息是不是密文帧（v5 里除 hello 之外都必须成立）。 */
export function isEncrypted(bytes) {
  return bytes.length >= WIRE_HEADER_BYTES && bytes[0] === MAGIC_W && bytes[1] === MAGIC_B && (bytes[4] & WIRE_FLAG_ENC) !== 0;
}

/** hello 帧是不是"合法的明文 hello"（kind / ENC / idLen 三项）。 */
export function isHelloFrame(bytes) {
  if (bytes.length < WIRE_HEADER_BYTES || bytes[0] !== MAGIC_W || bytes[1] !== MAGIC_B) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes[3] === WireKind.HELLO && (bytes[4] & WIRE_FLAG_ENC) === 0 && view.getUint16(6, true) === 0;
}

// ================================================================ 工具侧客户端（v5）

/**
 * 连上桥并完成 **v5 加密握手**，返回一个"像 WebSocket"的句柄。
 *
 * ## 为什么要有它
 *
 * 加密之后，每个工具都要做同样四件事：生成临时密钥 → 挂 `?k=` → 等 hello → 收发时
 * seal/open。原先各工具里的三行连接代码（`new WebSocket` + `binaryType` + `decodeFrame`）
 * 如果各自改成加密版，就是**又一批各自实现的线上逻辑** —— 而"工具侧线格式只有一份"
 * 正是 `bridge-wire.mjs` 存在的理由。
 *
 * 句柄故意做成 WebSocket 的形状：
 *  · `send(bytes)` 内部封装（于是 `sendReq(handle, …)` 一个字都不用改）；
 *  · `addEventListener('message', cb)` 收到的是**已解密的逻辑帧**（`{ data: frame }`），
 *    工具里的 `decodeFrame(new Uint8Array(ev.data))` 直接删掉。
 *
 * @param url `ws://…/bridge`（v5 起 URL 上**没有任何凭据**；`k=` 由本函数补上）
 * @param psk 预共享密钥（来自宿主握手输出的 `psk`；**不在 URL 上**）
 */
export async function connectBridge(url, { psk, handshakeTimeoutMs = 5000 } = {}) {
  if (typeof psk !== 'string' || psk.length < SEAL_MIN_PSK_BYTES) {
    throw new BridgeCryptoError(`connectBridge 需要一个 psk（宿主握手输出里的 psk，≥${SEAL_MIN_PSK_BYTES} 字符）`);
  }
  const ecdh = generateEphemeral();
  const pskBytes = new TextEncoder().encode(psk);
  const target = `${url}${url.includes('?') ? '&' : '?'}k=${hexOf(ecdh.publicKey)}`;
  const ws = new WebSocket(target);
  ws.binaryType = 'arraybuffer';

  const session = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeCryptoError(`桥握手超时（${handshakeTimeoutMs}ms）：没等到 hello`)), handshakeTimeoutMs);
    const fail = (message) => {
      clearTimeout(timer);
      reject(new BridgeCryptoError(message));
    };
    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data);
      if (!isHelloFrame(bytes)) {
        fail('桥握手的第一条帧不是 hello');
        return;
      }
      try {
        const hello = decodeFrame(bytes);
        const serverPublicKey = fromHex(hello.publicKeyHex);
        const shared = sharedSecret(ecdh.ecdh, serverPublicKey);
        const keys = sessionKeys(psk, ecdh.publicKey, serverPublicKey, shared);
        clearTimeout(timer);
        resolve(new SealSession(keys, 'client'));
      } catch (e) {
        fail(`桥握手失败：${e.message}`);
      }
    };
    // 服务端在握手阶段关闭时只有 onclose（没有 onerror），不处理就会退化成"等到超时"
    ws.onclose = (ev) => fail(`ws 被服务端关闭 code=${ev.code} reason=${ev.reason || '(空)'}`);
    ws.onerror = () => fail('ws 连接错误');
  });

  const listeners = new Map();
  const emit = (type, event) => {
    for (const cb of listeners.get(type) ?? []) {
      cb(event);
    }
  };

  ws.onmessage = (ev) => {
    try {
      // 解封 + 解码都在这里做：工具拿到的是逻辑帧
      emit('message', { data: decodeFrame(openFrame(new Uint8Array(ev.data), session)) });
    } catch (e) {
      // 不静默：解密/解码失败在工具里必须看得见（否则只表现为"没有回复"）
      emit('error', { message: `桥帧解密/解码失败：${e.message}` });
    }
  };
  ws.onclose = (ev) => emit('close', ev);
  ws.onerror = () => emit('error', { message: 'ws 连接错误' });

  /*
   * **握手之后立刻说一句话**（一条 `bridge.ping`，回复按 id 丢弃）。
   *
   * 桥侧的预认证池有 1.5 秒截止：迟迟不说一句话的连接会被当成"占位"关掉。
   * 工具常常"连上之后先想一想再发请求"，所以这一句必须由 connectBridge 自己发 ——
   * 它与产品侧 `transport.ts` 的做法**逐字对应**（那边的原因注释更详细）。
   */
  ws.send(sealFrame(encodeFrame({ type: 'req', id: 'auth-1', method: 'bridge.ping' }), session));

  return {
    ws,
    session,
    /** 转发底层状态：工具里 `handle.readyState === WebSocket.OPEN` 这类断言照旧成立。 */
    get readyState() {
      return ws.readyState;
    },
    /** 与 WebSocket 同名同形：内部封装，`sendReq(handle, …)` 无需改动。 */
    send(bytes) {
      ws.send(sealFrame(bytes, session));
    },
    close() {
      ws.close();
    },
    addEventListener(type, cb) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
  };
}
