/**
 * 协议 v5 线格式：二进制消息 + 12 字节定长帧头 + **加密封装**。
 *
 * 与 Kotlin 侧 `bridge/protocol/.../BridgeWire.kt` **逐字节对应** —— 两份实现必须一起改。
 * 这里刻意不做任何"体面的抽象"（不生成、不装插件）：帧头只有 12 字节，
 * 一份 200 行的编解码比任何一层间接都更好读，也更好对着规格核对。
 *
 * ```
 * 外层（线上）
 * 偏移 长度 字段
 *  0    2  magic 'W','B'；认不出直接拒，不猜
 *  2    1  ver = 5
 *  3    1  kind 1=req 2=res 3=err 4=evt 5=hello 0x10=bin
 *  4    1  flags bit0 FINAL；bit1 ENC（1=密文；只有 hello 可以是 0）；未知位必须报错
 *  5    1  hdrExt 恒 0；非 0 必须报错
 *  6    2  idLen 小端 u16（明文：解密失败时还要能回一条带 id 的错误）
 *  8    4  bodyLen 小端 u32 = 内层整帧长度 + 28（nonce+tag）
 * 12  idLen id   UTF-8（明文）
 *    bodyLen nonce(12) ‖ 密文 ‖ tag(16)；AAD = 外层 12 字节头 ‖ id
 *
 * 内层（AEAD 保护，**逐字节等于一条 v4 消息**）
 * 同样的 12 字节头（flags 的 ENC 位为 0）+ id + 正文
 * ```
 *
 * 加解密本身在 `seal.ts`（WebCrypto）与 Kotlin `BridgeCrypto`；本文件只负责
 * **把一条内层消息包成外层消息、再拆回来**，以及内外一致性检查。
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
import { SEAL_BODY_OVERHEAD_BYTES, type Bytes, type SealSession } from './seal.js';

/** 定长头长度。 */
export const WIRE_HEADER_BYTES = 12;

const MAGIC_W = 0x57;
const MAGIC_B = 0x42;

/** bit0：本条消息的最后一片。 */
export const WIRE_FLAG_FINAL = 0x01;

/**
 * bit1：正文是密文（v5）。
 *
 * **只有 `hello` 帧可以是 0**；其余任何帧收到 ENC=0 都是"两端不是一版"，
 * 由传输层回 `BRIDGE_WIRE_MODE` 后断开（不是静默按明文解析）。
 */
export const WIRE_FLAG_ENC = 0x02;

/** 本版本认识的 flags 位。 */
const WIRE_KNOWN_FLAGS = WIRE_FLAG_FINAL | WIRE_FLAG_ENC;

/** id 上限（帧头里是 2 字节字段，协议只承诺短 id）。 */
export const WIRE_MAX_ID_BYTES = 255;

/**
 * 封装给一条内层消息加上的**最坏**开销：外层头 12 + 最大 id 255 + nonce 12 + tag 16（=295）。
 *
 * 算术只写这一处：结构硬上限必须走 [sealedHardLimitFor]，各自手抄一遍的表现是
 * "大图偶尔发不出去"，很难查。
 */
export const WIRE_SEALED_OVERHEAD_BYTES = WIRE_HEADER_BYTES + WIRE_MAX_ID_BYTES + SEAL_BODY_OVERHEAD_BYTES;

/** 帧头上的 kind。 */
export const WireKind = {
  REQ: 0x01,
  RES: 0x02,
  ERR: 0x03,
  EVT: 0x04,
  /** 握手 hello（v5）：唯一允许明文的帧，方向固定"壳 → 客户端"。 */
  HELLO: 0x05,
  BIN: 0x10,
} as const;

/** 结构上限：控制面 1MiB、数据面 8MiB（与 Kotlin `BridgeWire` 同值）。 */
export const WIRE_HARD_CONTROL_BYTES = 256 * 1024 * 4;
export const WIRE_HARD_BIN_BYTES = 8 * 1024 * 1024;

/**
 * 这条 kind 的**外层（含封装）**结构上限：内层上限 + 295。
 *
 * 两个上限用途不同：内层上限判"被封装的东西有多大"，这个判"外层整条消息有多大"
 * （`WireReader` 的等价物与传输层的单帧上限用它）。
 */
export function sealedHardLimitFor(kind: number): number {
  const base = kind === WireKind.BIN ? WIRE_HARD_BIN_BYTES : WIRE_HARD_CONTROL_BYTES;
  return base + WIRE_SEALED_OVERHEAD_BYTES;
}

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

/** 编码一帧（**明文**；加密帧由 [sealFrame] 产出）。 */
export function encodeFrame(frame: BridgeFrame): Bytes {
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
    case 'hello':
      kind = WireKind.HELLO;
      id = '';
      body = encoder.encode(JSON.stringify({ k: frame.publicKeyHex }));
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

/**
 * 解码一帧（**明文/内层**帧）；结构不合法抛 [WireDecodeError]。
 *
 * 密文帧要先过 [openFrame] 拿到内层字节，再走这里 —— 所以这一层对 ENC 位是**拒**的。
 */
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
  if (
    kind !== WireKind.REQ &&
    kind !== WireKind.RES &&
    kind !== WireKind.ERR &&
    kind !== WireKind.EVT &&
    kind !== WireKind.HELLO &&
    kind !== WireKind.BIN
  ) {
    throw new WireDecodeError('BAD_KIND', id);
  }
  const flags = bytes[4]!;
  if ((flags & ~WIRE_KNOWN_FLAGS) !== 0) {
    throw new WireDecodeError('BAD_FLAGS', id);
  }
  if ((flags & WIRE_FLAG_ENC) !== 0) {
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
    case WireKind.HELLO:
      // hello 的 idLen 必须是 0（它没有请求可关联）
      if (id !== '') {
        throw new WireDecodeError('BAD_BODY', id);
      }
      return { type: 'hello', publicKeyHex: String(parsed.k ?? '') };
    default:
      return {
        type: 'evt',
        topic: String(parsed.topic ?? ''),
        ...(parsed.data === undefined ? {} : { data: parsed.data }),
      } as BridgeFrame;
  }
}

/** 帧头里带的关联 id（事件帧与 hello 帧没有 id，编码时写 0 长度）。 */
export function frameId(frame: BridgeFrame): string {
  return frame.type === 'evt' || frame.type === 'hello' ? '' : frame.id;
}

// ---------------------------------------------------------------- v5 加密封装

/**
 * 把一条**完整的内层消息**封装成外层密文消息。
 *
 * 外层头明文（`kind` 让接收端在解密前就能选限额；`id` 让解密失败时还能回一条带 id 的错误），
 * AAD 就是"外层 12 字节头 ‖ id" —— 帧头被篡改一定表现为 tag 失败。
 * 长度关系：`外层 bodyLen = 内层整帧长度 + 28`。
 */
export async function sealFrame(inner: Bytes, session: SealSession): Promise<Bytes> {
  if (inner.length < WIRE_HEADER_BYTES) {
    throw new WireDecodeError('TRUNCATED');
  }
  const kind = inner[3]!;
  if (kind === WireKind.HELLO) {
    throw new WireDecodeError('BAD_KIND', headerId(inner));
  }
  if ((inner[4]! & WIRE_FLAG_ENC) !== 0) {
    throw new WireDecodeError('BAD_FLAGS', headerId(inner));
  }
  const innerView = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  const idLen = innerView.getUint16(6, true);
  if (inner.length !== WIRE_HEADER_BYTES + idLen + innerView.getUint32(8, true)) {
    throw new WireDecodeError('BAD_LENGTH', headerId(inner));
  }

  const bodyLen = inner.length + SEAL_BODY_OVERHEAD_BYTES;
  const outer = new Uint8Array(WIRE_HEADER_BYTES + idLen + bodyLen);
  const view = new DataView(outer.buffer);
  outer[0] = MAGIC_W;
  outer[1] = MAGIC_B;
  outer[2] = BRIDGE_PROTOCOL_VERSION;
  outer[3] = kind;
  outer[4] = WIRE_FLAG_FINAL | WIRE_FLAG_ENC;
  outer[5] = 0;
  writeU16(view, 6, idLen);
  writeU32(view, 8, bodyLen);
  outer.set(inner.subarray(WIRE_HEADER_BYTES, WIRE_HEADER_BYTES + idLen), WIRE_HEADER_BYTES);

  const aad = outer.slice(0, WIRE_HEADER_BYTES + idLen);
  const sealed = await session.seal(inner, aad);
  outer.set(sealed, WIRE_HEADER_BYTES + idLen);
  return outer;
}

/**
 * 打开一条外层密文消息，返回**内层完整消息**。
 *
 * 判定：外层结构、tag 与序号（走 [SealSession]）、内外一致性（kind / id 必须相同 ——
 * 这是"外层头是明文"的代价，必须自己补上）。任何一项不对都抛 [WireDecodeError] 或
 * `SealError`，调用方据此断开（不是猜一猜继续）。
 */
export async function openFrame(outer: Bytes, session: SealSession): Promise<Bytes> {
  if (outer.length < WIRE_HEADER_BYTES) {
    throw new WireDecodeError('TRUNCATED');
  }
  if (outer[0] !== MAGIC_W || outer[1] !== MAGIC_B) {
    throw new WireDecodeError('BAD_MAGIC');
  }
  if (outer[2] !== BRIDGE_PROTOCOL_VERSION) {
    throw new WireDecodeError('BAD_VERSION', headerId(outer));
  }
  const kind = outer[3]!;
  if (kind === WireKind.HELLO || !Number.isInteger(kind)) {
    throw new WireDecodeError('BAD_KIND', headerId(outer));
  }
  const flags = outer[4]!;
  if ((flags & ~WIRE_KNOWN_FLAGS) !== 0) {
    throw new WireDecodeError('BAD_FLAGS', headerId(outer));
  }
  if ((flags & WIRE_FLAG_ENC) === 0) {
    throw new WireDecodeError('BAD_FLAGS', headerId(outer));
  }
  if (outer[5] !== 0) {
    throw new WireDecodeError('BAD_EXT', headerId(outer));
  }
  const view = new DataView(outer.buffer, outer.byteOffset, outer.byteLength);
  const idLen = view.getUint16(6, true);
  const bodyLen = view.getUint32(8, true);
  if (idLen > WIRE_MAX_ID_BYTES || outer.length !== WIRE_HEADER_BYTES + idLen + bodyLen) {
    throw new WireDecodeError('BAD_LENGTH', headerId(outer));
  }

  const aad = outer.slice(0, WIRE_HEADER_BYTES + idLen);
  const inner = await session.open(outer.slice(WIRE_HEADER_BYTES + idLen), aad);

  if (inner.length < WIRE_HEADER_BYTES || inner[3] !== kind) {
    throw new WireDecodeError('BAD_KIND', headerId(inner));
  }
  const innerView = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  if (innerView.getUint16(6, true) !== idLen) {
    throw new WireDecodeError('BAD_LENGTH', headerId(inner));
  }
  for (let i = 0; i < idLen; i += 1) {
    if (inner[WIRE_HEADER_BYTES + i] !== outer[WIRE_HEADER_BYTES + i]) {
      throw new WireDecodeError('BAD_LENGTH', headerId(inner));
    }
  }
  return inner;
}

/**
 * 这条消息是不是密文帧（v5 里除 hello 之外都必须成立）。
 *
 * 给传输层用：先便宜地判一下，再把"收到明文的非 hello 帧"回成 `BRIDGE_WIRE_MODE`
 * （两端不是一版），而不是扔进解密里变成 tag 失败。
 */
export function isEncrypted(bytes: Uint8Array): boolean {
  return (
    bytes.length >= WIRE_HEADER_BYTES &&
    bytes[0] === MAGIC_W &&
    bytes[1] === MAGIC_B &&
    (bytes[4]! & WIRE_FLAG_ENC) !== 0
  );
}

/** hello 帧是不是"合法的明文 hello"（kind / ENC / idLen 三项）。 */
export function isHelloFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length >= WIRE_HEADER_BYTES &&
    bytes[0] === MAGIC_W &&
    bytes[1] === MAGIC_B &&
    bytes[3] === WireKind.HELLO &&
    (bytes[4]! & WIRE_FLAG_ENC) === 0 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true) === 0
  );
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
