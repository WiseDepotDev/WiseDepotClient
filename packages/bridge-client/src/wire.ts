/**
 * 协议 v4 线格式：二进制消息 + 12 字节定长帧头。
 *
 * 与 Kotlin 侧 `bridge/protocol/.../BridgeWire.kt` **逐字节对应** —— 两份实现必须一起改。
 * 这里刻意不做任何"体面的抽象"（不生成、不装插件）：帧头只有 12 字节，
 * 一份 200 行的编解码比任何一层间接都更好读，也更好对着规格核对。
 *
 * ```
 * 偏移 长度 字段
 *  0    2  magic 'W','B'；认不出直接拒，不猜
 *  2    1  ver = 4
 *  3    1  kind 1=req 2=res 3=err 4=evt 0x10=bin
 *  4    1  flags bit0 FINAL；未知位必须报错
 *  5    1  hdrExt 恒 0；非 0 必须报错
 *  6    2  idLen 小端 u16
 *  8    4  bodyLen 小端 u32
 * 12  idLen id   UTF-8；控制帧正文 UTF-8 JSON，bin 正文不透明字节
 * ```
 *
 * ## 为什么内存模型里仍然保留 `type`
 *
 * 判别字段在**线上**由帧头承担，但内存里留一个 `type` 让 `switch (frame.type)` 保持可读；
 * 它由解码器按 kind 填，**不参与序列化** —— 于是"线格式变了"不会把调用点全部震一遍。
 */
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeErrorPayload,
  type BridgeFrame,
  type ReqFrame,
  type ResFrame,
} from './types.js';

/** 定长头长度。 */
export const WIRE_HEADER_BYTES = 12;

const MAGIC_W = 0x57;
const MAGIC_B = 0x42;

/** bit0：本条消息的最后一片。 */
export const WIRE_FLAG_FINAL = 0x01;

/** id 上限（帧头里是 2 字节字段，协议只承诺短 id）。 */
export const WIRE_MAX_ID_BYTES = 255;

/** 帧头上的 kind。 */
export const WireKind = {
  REQ: 0x01,
  RES: 0x02,
  ERR: 0x03,
  EVT: 0x04,
  BIN: 0x10,
} as const;

/** 结构解码失败的原因（与 Kotlin `WireFault` 同名同义）。 */
export type WireFault =
  | 'BAD_MAGIC'
  | 'BAD_VERSION'
  | 'BAD_KIND'
  | 'BAD_FLAGS'
  | 'BAD_EXT'
  | 'BAD_LENGTH'
  | 'TOO_LARGE'
  | 'TRUNCATED'
  | 'BAD_BODY';

/** 解不出来的入站消息。**不静默丢弃**：调用方要么回错误、要么记日志。 */
export class WireDecodeError extends Error {
  readonly fault: WireFault;
  /** 尽力从帧头抠出的关联 id（抠不到为空串）。 */
  readonly id: string;

  constructor(fault: WireFault, id = '') {
    super(`桥协议帧结构不合法：${fault}`);
    this.name = 'WireDecodeError';
    this.fault = fault;
    this.id = id;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 去掉 `undefined` 与 `null` 的字段：Kotlin 侧是 `explicitNulls = false`，两边形状要一致。 */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** 编码一帧。 */
export function encodeFrame(frame: BridgeFrame): Uint8Array {
  let kind: number;
  let id: string;
  let flags = WIRE_FLAG_FINAL;
  let body: Uint8Array;

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
      body = encoder.encode(JSON.stringify({ error: compact(frame.error as unknown as Record<string, unknown>) }));
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
      flags = frame.final ? WIRE_FLAG_FINAL : 0;
      break;
  }

  const idBytes = encoder.encode(id);
  const out = new Uint8Array(WIRE_HEADER_BYTES + idBytes.length + body.length);
  const view = new DataView(out.buffer);
  out[0] = MAGIC_W;
  out[1] = MAGIC_B;
  out[2] = BRIDGE_PROTOCOL_VERSION;
  out[3] = kind;
  out[4] = flags;
  out[5] = 0;
  writeU16(view, 6, idBytes.length);
  writeU32(view, 8, body.length);
  out.set(idBytes, WIRE_HEADER_BYTES);
  out.set(body, WIRE_HEADER_BYTES + idBytes.length);
  return out;
}

/** 尽力从帧头抠 id —— 帧坏了也要能回一条对得上号的错误。 */
export function headerId(bytes: Uint8Array): string {
  if (bytes.length < WIRE_HEADER_BYTES) {
    return '';
  }
  if (bytes[0] !== MAGIC_W || bytes[1] !== MAGIC_B) {
    return '';
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(6, true);
  if (idLen <= 0 || idLen > WIRE_MAX_ID_BYTES || bytes.length < WIRE_HEADER_BYTES + idLen) {
    return '';
  }
  return decoder.decode(bytes.subarray(WIRE_HEADER_BYTES, WIRE_HEADER_BYTES + idLen));
}

/** 解码一帧；结构不合法抛 [WireDecodeError]。 */
export function decodeFrame(bytes: Uint8Array): BridgeFrame {
  if (bytes.length < WIRE_HEADER_BYTES) {
    throw new WireDecodeError('TRUNCATED');
  }
  if (bytes[0] !== MAGIC_W || bytes[1] !== MAGIC_B) {
    throw new WireDecodeError('BAD_MAGIC');
  }
  const id = headerId(bytes);
  if (bytes[2] !== BRIDGE_PROTOCOL_VERSION) {
    throw new WireDecodeError('BAD_VERSION', id);
  }
  const kind = bytes[3]!;
  if (kind !== WireKind.REQ && kind !== WireKind.RES && kind !== WireKind.ERR && kind !== WireKind.EVT && kind !== WireKind.BIN) {
    throw new WireDecodeError('BAD_KIND', id);
  }
  const flags = bytes[4]!;
  if ((flags & ~WIRE_FLAG_FINAL) !== 0) {
    throw new WireDecodeError('BAD_FLAGS', id);
  }
  if (bytes[5] !== 0) {
    throw new WireDecodeError('BAD_EXT', id);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(6, true);
  const bodyLen = view.getUint32(8, true);
  if (idLen > WIRE_MAX_ID_BYTES || bytes.length !== WIRE_HEADER_BYTES + idLen + bodyLen) {
    throw new WireDecodeError('BAD_LENGTH', id);
  }
  const body = bytes.subarray(WIRE_HEADER_BYTES + idLen);
  if (kind === WireKind.BIN) {
    // 数据面：本批没有任何方法使用它，解出来只是为了"不崩"
    return { type: 'bin', id, body, final: (flags & WIRE_FLAG_FINAL) !== 0 };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoder.decode(body)) as Record<string, unknown>;
  } catch {
    throw new WireDecodeError('BAD_BODY', id);
  }
  switch (kind) {
    case WireKind.REQ:
      return {
        type: 'req',
        id,
        method: String(parsed.method ?? ''),
        ...(parsed.params === undefined ? {} : { params: parsed.params }),
        ...(parsed.meta === undefined ? {} : { meta: parsed.meta as ReqFrame['meta'] }),
      } as ReqFrame;
    case WireKind.RES:
      return {
        type: 'res',
        id,
        ...(parsed.data === undefined ? {} : { data: parsed.data }),
        ...(parsed.meta === undefined ? {} : { meta: parsed.meta as ResFrame['meta'] }),
      } as ResFrame;
    case WireKind.ERR:
      return { type: 'err', id, error: parsed.error as BridgeErrorPayload } as BridgeFrame;
    default:
      return {
        type: 'evt',
        topic: String(parsed.topic ?? ''),
        ...(parsed.data === undefined ? {} : { data: parsed.data }),
      } as BridgeFrame;
  }
}

/** 帧头里带的关联 id（事件帧没有 id，编码时写 0 长度）。 */
export function frameId(frame: BridgeFrame): string {
  return frame.type === 'evt' ? '' : frame.id;
}

/**
 * 正文的字节数（**策略上限按正文算**，不是整条消息）。
 *
 * 让调用方各自"整条消息减帧头减 id"迟早会算错（UTF-8 下 id 的字节数≠字符数），
 * 所以这里从帧头里读权威值。
 */
export function bodyLength(bytes: Uint8Array): number {
  if (bytes.length < WIRE_HEADER_BYTES) {
    return bytes.length;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(8, true);
}
