/**
 * 协议 v5 的加密原语（WebCrypto 版）。
 *
 * 与 `bridge/protocol/src/main/kotlin/.../BridgeCrypto.kt`、`tools/lib/bridge-wire.mjs`
 * **逐位同口径**：临时 ECDH（P-256）→ HMAC-SHA256 域分隔 KDF → AES-256-GCM。
 * 三份实现对同一组 `bridge-crypto-vectors.json` 必须产出同一份密文，
 * 由 `tools/check/check-bridge-crypto-vectors.mjs` 钉住（与 `check-protocol-version` 同体例）。
 *
 * ## 为什么这里只用 WebCrypto
 *
 * 这一份代码跑在**两个壳的渲染进程**里（桌面 `app://`、手机 `https://appassets.androidplatform.net`），
 * 两边都被登记为安全上下文，所以 `crypto.subtle` 可用（见 `apps/desktop/src/main.ts` 的
 * `registerSchemesAsPrivileged` 注释）。**不可用就明确报错、不静默退回明文** ——
 * "看起来连上了但没有保密"比连不上更糟。
 *
 * ## 本文件不含线格式
 *
 * 帧头/外层封装在 `wire.ts`（S2）。这里只做"明文 ↔ 密文"的字节变换，
 * 因此同一个函数既服务控制面也服务 `bin` 数据面（**只有一条加解密路径**）。
 *
 * 见 `docs/superpowers/plans/2026-10-06-bridge-ws-encryption-v5.md`。
 */

/** AEAD tag 长度（GCM 固定 128 位）。 */
export const SEAL_TAG_BYTES = 16;

/** nonce 长度（GCM 标准 96 位）。 */
export const SEAL_NONCE_BYTES = 12;

/** 对称密钥长度（AES-256）。 */
export const SEAL_KEY_BYTES = 32;

/**
 * psk 的最小长度（不是"必须等于 32"）。
 *
 * psk 是**引导文件里 psk/token 的 ASCII 字节**（base64url 的 32 字节 ⇒ 43 个字符）；
 * HMAC 的密钥可以是任意长度（RFC 2104），这里只拦"明显不是密钥"的输入。
 * 与 Kotlin 侧 `MIN_PSK_BYTES` 同值。
 */
export const SEAL_MIN_PSK_BYTES = 16;

/** 未压缩点编码长度：`0x04 ‖ X(32) ‖ Y(32)`。 */
export const SEAL_PUBLIC_KEY_BYTES = 65;

/** ECDH 共享秘密长度（P-256 的 X 坐标）。 */
export const SEAL_SHARED_BYTES = 32;

/**
 * 一条**密文正文**相对明文的开销：nonce 12 + tag 16。
 *
 * nonce 随正文上线（与 Kotlin 侧同一个理由：不要求"写序 == 序号自增序"这条跨线程不变式）。
 */
export const SEAL_BODY_OVERHEAD_BYTES = SEAL_NONCE_BYTES + SEAL_TAG_BYTES;

export const DIR_CLIENT_TO_SERVER = 0x01;
export const DIR_SERVER_TO_CLIENT = 0x02;

/** 允许的序号跳跃上限（防重放）：与 Kotlin 侧 `MAX_SEQ_GAP` 同值。 */
export const MAX_SEQ_GAP = 4096;

/**
 * 本模块接受的字节类型。
 *
 * 为什么要起个名字：TS 5.7 之后 `Uint8Array` 带了一个 buffer 类型参数，而 WebCrypto 的
 * `BufferSource` 要求 **ArrayBuffer 支撑**的视图（`SharedArrayBuffer` 不算）。
 * 起名一次，好过在每个签名上撒一遍泛型 —— 也避免"某个参数漏写、只在调用处才报错"。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const KDF_LABEL = 'wd-bridge/v5/kdf';
const LABEL_CLIENT_SIDE = 'c';
const LABEL_SERVER_SIDE = 's';
const LABEL_C2S = 'wd-bridge/v5/c2s';
const LABEL_S2C = 'wd-bridge/v5/s2c';

/**
 * 加密层的失败。
 *
 * 单开一个类型而不是复用 `Error`：调用方要区分"密文不可信 ⇒ 断开这条连接"
 * 与"参数写错了 ⇒ 本端 bug"。前者是对端/中间人造成的，后者是我们自己的。
 */
export class SealError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SealError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new SealError('本环境没有 crypto.subtle（不是安全上下文）—— 桥的加密层无法工作');
  }
  return c.subtle;
}

// ---------------------------------------------------------------- 编解码

const HEX_DIGITS = '0123456789abcdef';

/** 字节 → 小写 hex。用于公钥上线与测试向量（**不用于密钥日志**）。 */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    // `charAt` 而不是下标：下标在 `noUncheckedIndexedAccess` 下是 `string | undefined`
    out += HEX_DIGITS.charAt(b >>> 4) + HEX_DIGITS.charAt(b & 0x0f);
  }
  return out;
}

/** 小写/大写 hex → 字节。非法输入抛 [SealError]（不返回 null：调用方必须处理）。 */
export function fromHex(text: string): Bytes {
  if (text.length % 2 !== 0) {
    throw new SealError(`hex 长度必须是偶数：${text.length}`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (hexDigit(text[i * 2] as string) << 4) | hexDigit(text[i * 2 + 1] as string);
  }
  return out;
}

function hexDigit(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  throw new SealError(`非法 hex 字符：${c}`);
}

function ascii(text: string): Bytes {
  return new Uint8Array(new TextEncoder().encode(text));
}

function concat(parts: readonly Bytes[]): Bytes {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * nonce：`dir(1) ‖ seq(8，大端) ‖ 0x00 0x00 0x00`。
 *
 * 布局必须与 Kotlin 侧逐字节一致 —— 不一致的表现是"本地全绿、真机全挂"，
 * 而且没有任何可读的错误。
 */
export function nonceOf(direction: number, seq: number): Bytes {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new SealError(`序号必须是安全整数：${seq}`);
  }
  const out = new Uint8Array(SEAL_NONCE_BYTES);
  out[0] = direction;
  for (let i = 0; i < 8; i += 1) {
    out[1 + i] = (seq / 2 ** (8 * (7 - i))) & 0xff;
  }
  return out;
}

/** 从上线字节里读序号（前 12 字节是 nonce）。方向不符即抛错。 */
export function seqOf(direction: number, sealed: Uint8Array): number {
  if (sealed.length < SEAL_BODY_OVERHEAD_BYTES) {
    throw new SealError(`密文正文太短：${sealed.length}`);
  }
  if (sealed[0] !== direction) {
    throw new SealError(`方向字节不符：期望 ${direction} 实得 ${sealed[0]}`);
  }
  let seq = 0;
  for (let i = 0; i < 8; i += 1) {
    seq = seq * 256 + (sealed[1 + i] as number);
  }
  if (!Number.isSafeInteger(seq)) {
    throw new SealError(`序号超出安全整数范围：${seq}`);
  }
  return seq;
}

// ---------------------------------------------------------------- ECDH

export interface EphemeralKey {
  /** 未压缩点 `0x04 ‖ X ‖ Y`，上线用 hex。 */
  readonly publicKey: Bytes;
  readonly privateKey: CryptoKey;
}

export interface SessionKeys {
  /** 连接密钥（只用于派生下面两个，不直接加密）。 */
  readonly connection: Bytes;
  readonly clientToServer: Bytes;
  readonly serverToClient: Bytes;
}

/**
 * 生成一次性 P-256 密钥对。**每次建连**调用一次 —— 这就是前向保密的来源。
 *
 * `extractable: true` 是**必需**的：WebCrypto 不允许导出 `extractable=false` 的密钥，
 * 而我们要把公钥（raw，65 字节）挂到握手 URL 上。
 * 私钥**永远不导出**（它只活在 CryptoKey 里），这一点由本文件的 API 形状保证：
 * 没有任何函数返回私钥字节。
 */
export async function generateEphemeral(): Promise<EphemeralKey> {
  const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  if (raw.length !== SEAL_PUBLIC_KEY_BYTES) {
    throw new SealError(`公钥长度异常：${raw.length}`);
  }
  return { publicKey: raw, privateKey: pair.privateKey };
}

/** 校验未压缩点编码；点是否真在曲线上由 WebCrypto 的 importKey 判定（不合法的点会抛）。 */
export function isPublicKeyShape(raw: Uint8Array): boolean {
  return raw.length === SEAL_PUBLIC_KEY_BYTES && raw[0] === 0x04;
}

/** `Z`：ECDH 共享秘密（P-256 的 X 坐标，32 字节）。 */
export async function sharedSecret(privateKey: CryptoKey, peerPublicKey: Bytes): Promise<Bytes> {
  if (!isPublicKeyShape(peerPublicKey)) {
    throw new SealError('对端公钥不是合法的 P-256 未压缩点');
  }
  let peer: CryptoKey;
  try {
    peer = await subtle().importKey('raw', peerPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch (e) {
    throw new SealError('对端公钥不在 P-256 上', { cause: e });
  }
  const bits = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, SEAL_SHARED_BYTES * 8);
  const z = new Uint8Array(bits);
  if (z.length !== SEAL_SHARED_BYTES) {
    throw new SealError(`ECDH 共享秘密长度异常：${z.length}`);
  }
  return z;
}

// ---------------------------------------------------------------- KDF

/**
 * ```text
 * K_conn = HMAC-SHA256(psk, "wd-bridge/v5/kdf" ‖ "c" ‖ clientPub ‖ "s" ‖ serverPub ‖ Z)
 * K_c2s  = HMAC-SHA256(K_conn, "wd-bridge/v5/c2s")
 * K_s2c  = HMAC-SHA256(K_conn, "wd-bridge/v5/s2c")
 * ```
 *
 * psk 是 HMAC 的**密钥**、Z 是数据 ⇒ ① 没有 psk 的一方连密钥都算不出来（认证）；
 * ② 事后泄露 psk 也解不开历史会话（前向保密）。
 */
export async function sessionKeys(
  psk: Bytes,
  clientPublicKey: Bytes,
  serverPublicKey: Bytes,
  shared: Bytes,
): Promise<SessionKeys> {
  if (psk.length < SEAL_MIN_PSK_BYTES) throw new SealError(`psk 至少 ${SEAL_MIN_PSK_BYTES} 字节，实得 ${psk.length}`);
  if (!isPublicKeyShape(clientPublicKey)) throw new SealError('clientPub 必须是 65 字节未压缩点');
  if (!isPublicKeyShape(serverPublicKey)) throw new SealError('serverPub 必须是 65 字节未压缩点');
  if (shared.length !== SEAL_SHARED_BYTES) throw new SealError(`Z 必须是 ${SEAL_SHARED_BYTES} 字节`);

  const transcript = concat([
    ascii(KDF_LABEL),
    ascii(LABEL_CLIENT_SIDE),
    clientPublicKey,
    ascii(LABEL_SERVER_SIDE),
    serverPublicKey,
    shared,
  ]);
  const connection = await hmac(psk, transcript);
  return {
    connection,
    clientToServer: await hmac(connection, ascii(LABEL_C2S)),
    serverToClient: await hmac(connection, ascii(LABEL_S2C)),
  };
}

async function hmac(key: Bytes, message: Bytes): Promise<Bytes> {
  const imported = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', imported, message));
}

// ---------------------------------------------------------------- AEAD

async function aesKey(key: Bytes, usages: KeyUsage[]): Promise<CryptoKey> {
  if (key.length !== SEAL_KEY_BYTES) throw new SealError(`密钥必须是 ${SEAL_KEY_BYTES} 字节`);
  return await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, usages);
}

/** 加密：`nonce(12) ‖ 密文 ‖ tag(16)`（WebCrypto 与 JCE 都把 tag 追加在末尾）。 */
export async function seal(
  key: Bytes,
  direction: number,
  seq: number,
  plaintext: Bytes,
  aad: Bytes,
): Promise<Bytes> {
  const nonce = nonceOf(direction, seq);
  const cryptoKey = await aesKey(key, ['encrypt']);
  const body = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, cryptoKey, plaintext),
  );
  return concat([nonce, body]);
}

/** 解密：tag 失败 / 长度不对 / 方向不符都抛 [SealError]。 */
export async function open(
  key: Bytes,
  direction: number,
  sealed: Bytes,
  aad: Bytes,
): Promise<Bytes> {
  const seq = seqOf(direction, sealed);
  const cryptoKey = await aesKey(key, ['decrypt']);
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: nonceOf(direction, seq), additionalData: aad, tagLength: 128 },
      cryptoKey,
      sealed.subarray(SEAL_NONCE_BYTES),
    );
    return new Uint8Array(plain);
  } catch (e) {
    throw new SealError('密文校验失败（tag 不符或已损坏）', { cause: e });
  }
}

// ---------------------------------------------------------------- 会话

export type SealRole = 'client' | 'server';

/**
 * 一条连接的加密会话：三把密钥 + 两个方向的序号水位。
 *
 * 生命周期与连接一致（`transport.ts` 每次重连各一个），**不复用、不跨连接** ——
 * 跨连接复用会重用 `(key, nonce)`，那是 GCM 的致命用法。
 */
export class SealSession {
  private outboundSeq = 0;
  private inboundSeq = 0;

  constructor(
    private readonly keys: SessionKeys,
    private readonly role: SealRole,
  ) {}

  get outboundDirection(): number {
    return this.role === 'client' ? DIR_CLIENT_TO_SERVER : DIR_SERVER_TO_CLIENT;
  }

  get outboundKey(): Bytes {
    return this.role === 'client' ? this.keys.clientToServer : this.keys.serverToClient;
  }

  get inboundKey(): Bytes {
    return this.role === 'client' ? this.keys.serverToClient : this.keys.clientToServer;
  }

  get sentSeq(): number {
    return this.outboundSeq;
  }

  get receivedSeq(): number {
    return this.inboundSeq;
  }

  async seal(plaintext: Bytes, aad: Bytes): Promise<Bytes> {
    this.outboundSeq += 1;
    return await seal(this.outboundKey, this.outboundDirection, this.outboundSeq, plaintext, aad);
  }

  /**
   * 解密并做防重放：方向字节必须是对端方向，序号必须**严格单调递增**且有界。
   * 重放（序号已消费）与跳号过大都在这里被拒 —— 这是"帧不可重放"的唯一落点。
   */
  async open(sealed: Bytes, aad: Bytes): Promise<Bytes> {
    const peerDirection = this.role === 'client' ? DIR_SERVER_TO_CLIENT : DIR_CLIENT_TO_SERVER;
    const seq = seqOf(peerDirection, sealed);
    if (seq <= this.inboundSeq) {
      throw new SealError(`序号回退/重放：已收到 ${this.inboundSeq}，又收到 ${seq}`);
    }
    if (seq - this.inboundSeq > MAX_SEQ_GAP) {
      throw new SealError(`序号跳跃过大：${this.inboundSeq} → ${seq}`);
    }
    const plaintext = await open(this.inboundKey, peerDirection, sealed, aad);
    this.inboundSeq = seq;
    return plaintext;
  }
}
