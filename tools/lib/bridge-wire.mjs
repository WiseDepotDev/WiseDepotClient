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

export const WIRE_HEADER_BYTES = 12;
export const WIRE_FLAG_FINAL = 0x01;
export const WIRE_MAX_ID_BYTES = 255;
export const WIRE_PROTOCOL_VERSION = 4;

export const WireKind = { REQ: 0x01, RES: 0x02, ERR: 0x03, EVT: 0x04, BIN: 0x10 };

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
  if ((flags & ~WIRE_FLAG_FINAL) !== 0) {
    throw new Error(`WIRE: BAD_FLAGS ${flags} id=${id}`);
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
