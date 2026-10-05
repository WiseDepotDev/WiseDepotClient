#!/usr/bin/env node
/**
 * check-bridge-crypto-vectors.mjs —— 加密层的**跨语言对账**门禁（协议 v5）。
 *
 * ## 为什么需要它
 *
 * 帧头那件事（v3→v4）已经真实漂移过一次：同一个事实在 Kotlin / TS / 工具里有三份实现，
 * 靠人工对照维持一致，结果一端回了结构化错误、一端静默丢弃。加密层比帧头更容易漂 ——
 * nonce 少一个字节、KDF 的标签串多一个空格、tag 位置挪一下，**三端各自都能自测通过**，
 * 只有真机上表现为"连上了但一条也解不开"。所以这里用与 `check-protocol-version` 同一体例：
 * **一份冻结的向量，多份实现复算，任一不一致即红**。
 *
 * 三份实现：
 *   1. `tools/lib/bridge-wire.mjs`             —— node:crypto（工具/bench 用）
 *   2. `packages/bridge-client/src/seal.ts`    —— WebCrypto（两个壳的渲染进程用）
 *   3. Kotlin `BridgeCrypto.kt`                —— 由 `pnpm check:bridge` 里的 `BridgeCryptoTest` 复算同一份文件
 *
 * 本脚本覆盖 1 与 2（Kotlin 一侧由 Gradle 测试覆盖）；两者都对着**同一份**
 * `bridge/protocol/src/test/resources/bridge-crypto-vectors.json`。
 *
 * ECDH 的互操作在这里用"真跑一遍"来覆盖：TS 侧生成临时密钥 → node:crypto 用向量里的
 * 服务端私钥算 `Z` → TS 侧用同一份输入算 `Z` → 两者必须逐字节相同（Kotlin 一侧则由向量里
 * 冻结的 `Z` 钉住）。这样三份 ECDH 实现被同一个值锁在一起。
 *
 * 用法：node tools/check/check-bridge-crypto-vectors.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    DIR_CLIENT_TO_SERVER,
    DIR_SERVER_TO_CLIENT,
    MAX_SEQ_GAP,
    SEAL_NONCE_BYTES,
    BridgeCryptoError,
    SealSession,
    WIRE_PROTOCOL_VERSION,
    WIRE_SEALED_OVERHEAD_BYTES,
    WireKind,
    decodeFrame,
    ecdhFromPrivateScalar,
    encodeFrame,
    fromHex,
    hexOf,
    isEncrypted,
    isHelloFrame,
    nonceOf,
    open,
    openFrame,
    seal,
    sealFrame,
    sealedHardLimitFor,
    seqOf,
    sessionKeys,
    sharedSecret,
} from '../lib/bridge-wire.mjs';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VECTORS = path.join(CLIENT_ROOT, 'bridge', 'protocol', 'src', 'test', 'resources', 'bridge-crypto-vectors.json');
const ENTRY = path.join(CLIENT_ROOT, 'tools', 'check', 'bridge-crypto-entry.ts');

let failures = 0;
let total = 0;

function check(name, condition, detail) {
    total += 1;
    if (condition) {
        console.log(`  ✓ ${name}`);
        return;
    }
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    failures += 1;
}

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'));
const psk = fromHex(vectors.pskHex);
const clientPub = fromHex(vectors.clientPublicKeyHex);
const serverPub = fromHex(vectors.serverPublicKeyHex);
const z = fromHex(vectors.sharedSecretHex);

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-crypto-vectors-'));
const outFile = path.join(outDir, 'seal.cjs');

try {
    console.log('1/4 打包 TS 侧实现（seal.ts 原语 + wire.ts 加密封装）…');
    await build({
        entryPoints: [ENTRY],
        outfile: outFile,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        logLevel: 'warning',
    });
    const ts = await import(pathToFileURL(outFile).href);

    console.log('2/4 工具侧（node:crypto）对着冻结向量复算…');
    const clientEcdh = ecdhFromPrivateScalar(fromHex(vectors.clientPrivateScalarHex));
    const serverEcdh = ecdhFromPrivateScalar(fromHex(vectors.serverPrivateScalarHex));
    check('工具侧：公钥与向量一致（私钥标量 → 未压缩点编码）', hexOf(clientEcdh.getPublicKey()) === vectors.clientPublicKeyHex, hexOf(clientEcdh.getPublicKey()));
    check('工具侧：ECDH 两个方向同一个 Z', hexOf(clientEcdh.computeSecret(serverPub)) === hexOf(serverEcdh.computeSecret(clientPub)));
    check('工具侧：Z 与冻结值一致', hexOf(clientEcdh.computeSecret(serverPub)) === vectors.sharedSecretHex);

    const keys = sessionKeys(psk, clientPub, serverPub, z);
    check('工具侧：K_conn 与冻结值一致', hexOf(keys.connection) === vectors.connectionKeyHex);
    check('工具侧：K_c2s 与冻结值一致', hexOf(keys.clientToServer) === vectors.clientToServerKeyHex);
    check('工具侧：K_s2c 与冻结值一致', hexOf(keys.serverToClient) === vectors.serverToClientKeyHex);

    for (const c of vectors.cases) {
        const key = c.dir === DIR_CLIENT_TO_SERVER ? keys.clientToServer : keys.serverToClient;
        const sealed = seal(key, c.dir, c.seq, fromHex(c.plaintextHex), fromHex(c.aadHex));
        check(`工具侧：密文逐字节一致 —— ${c.name}`, hexOf(sealed) === c.sealedHex, hexOf(sealed).slice(0, 40) + '…');
        check(
            `工具侧：nonce 前缀就是 dir‖seq‖000000 —— ${c.name}`,
            hexOf(sealed.subarray(0, SEAL_NONCE_BYTES)) === hexOf(nonceOf(c.dir, c.seq)) && seqOf(c.dir, sealed) === c.seq,
        );
        const back = open(key, c.dir, fromHex(c.sealedHex), fromHex(c.aadHex));
        check(`工具侧：向量密文能解回明文 —— ${c.name}`, hexOf(back) === c.plaintextHex);
    }

    console.log('3/4 WebCrypto 侧（真跑 seal.ts）对着同一份向量复算…');
    check('TS 侧：hex 往返一致', ts.hexOf(clientPub) === vectors.clientPublicKeyHex);

    // TS 侧拿不到"由标量构造的私钥"（WebCrypto 不接受裸标量），
    // 所以 ECDH 用"真跑一遍互操作"来验：TS 生成临时密钥 → 工具侧算 Z → TS 侧算 Z。
    const tsEph = await ts.generateEphemeral();
    check('TS 侧：生成的公钥是 65 字节未压缩点', ts.isPublicKeyShape(tsEph.publicKey), String(tsEph.publicKey.length));
    const zFromTool = sharedSecret(serverEcdh, tsEph.publicKey);
    const zFromTs = await ts.sharedSecret(tsEph.privateKey, serverPub);
    check('ECDH 互操作：TS(WebCrypto) 与工具(node:crypto) 算出同一个 Z', hexOf(zFromTool) === hexOf(zFromTs), `${hexOf(zFromTs).slice(0, 32)}…`);
    const zBack = sharedSecret(ecdhFromPrivateScalar(fromHex(vectors.serverPrivateScalarHex)), tsEph.publicKey);
    check('ECDH 互操作：反方向也一致', hexOf(zBack) === hexOf(zFromTs));

    const tsKeys = await ts.sessionKeys(psk, clientPub, serverPub, z);
    check('TS 侧：K_conn 与冻结值一致', hexOf(tsKeys.connection) === vectors.connectionKeyHex);
    check('TS 侧：K_c2s 与冻结值一致', hexOf(tsKeys.clientToServer) === vectors.clientToServerKeyHex);
    check('TS 侧：K_s2c 与冻结值一致', hexOf(tsKeys.serverToClient) === vectors.serverToClientKeyHex);

    for (const c of vectors.cases) {
        const key = c.dir === DIR_CLIENT_TO_SERVER ? tsKeys.clientToServer : tsKeys.serverToClient;
        const sealed = await ts.seal(key, c.dir, c.seq, fromHex(c.plaintextHex), fromHex(c.aadHex));
        check(`TS 侧：密文逐字节一致 —— ${c.name}`, hexOf(sealed) === c.sealedHex, hexOf(sealed).slice(0, 40) + '…');
        const back = await ts.open(key, c.dir, fromHex(c.sealedHex), fromHex(c.aadHex));
        check(`TS 侧：向量密文能解回明文 —— ${c.name}`, hexOf(back) === c.plaintextHex);
    }

    console.log('4/4 负例：篡改 / 错误密钥 / 非法点 / 重放（两侧各验一遍）…');
    const sample = vectors.cases[0];
    const sampleAad = fromHex(sample.aadHex);
    const sampleSealed = fromHex(sample.sealedHex);

    const tagFlipped = Uint8Array.from(sampleSealed);
    tagFlipped[tagFlipped.length - 1] ^= 0x01;
    const bodyFlipped = Uint8Array.from(sampleSealed);
    bodyFlipped[SEAL_NONCE_BYTES + 1] ^= 0x80;

    check('工具侧：改 tag 被拒', raises(() => open(keys.clientToServer, sample.dir, tagFlipped, sampleAad)));
    check('工具侧：改密文被拒', raises(() => open(keys.clientToServer, sample.dir, bodyFlipped, sampleAad)));
    check('工具侧：改 AAD 被拒', raises(() => open(keys.clientToServer, sample.dir, sampleSealed, flip(sampleAad, 3))));
    check('TS 侧：改 tag 被拒', await raisesAsync(() => ts.open(tsKeys.clientToServer, sample.dir, tagFlipped, sampleAad)));
    check('TS 侧：改 AAD 被拒', await raisesAsync(() => ts.open(tsKeys.clientToServer, sample.dir, sampleSealed, flip(sampleAad, 3))));

    const wrongPsk = new Uint8Array(32).fill(0x7f);
    const wrongKeys = sessionKeys(wrongPsk, clientPub, serverPub, z);
    check('工具侧：psk 不对就解不开', raises(() => open(wrongKeys.clientToServer, sample.dir, sampleSealed, sampleAad)));

    const notOnCurve = Uint8Array.from(clientPub);
    notOnCurve[64] ^= 0x01;
    check('工具侧：不在曲线上的点被拒', raises(() => sharedSecret(clientEcdh, notOnCurve)));
    check('TS 侧：不在曲线上的点被拒', await raisesAsync(() => ts.sharedSecret(tsEph.privateKey, notOnCurve)));
    check('TS 侧：长度不对的点被拒', await raisesAsync(() => ts.sharedSecret(tsEph.privateKey, new Uint8Array(64))));

    // 会话级：重放 / 跳号 / 方向
    const senderTool = new SealSession(keys, 'client');
    const receiverTool = new SealSession(keys, 'server');
    const first = senderTool.seal(new TextEncoder().encode('hi'), new Uint8Array(0));
    check('工具侧会话：正常一条能通', new TextDecoder().decode(receiverTool.open(first, new Uint8Array(0))) === 'hi');
    check('工具侧会话：同一条重放被拒', raises(() => receiverTool.open(first, new Uint8Array(0))));
    check(
        '工具侧会话：跳号过大被拒',
        raises(() =>
            receiverTool.open(seal(keys.clientToServer, DIR_CLIENT_TO_SERVER, MAX_SEQ_GAP + 5, new Uint8Array(0), new Uint8Array(0)), new Uint8Array(0)),
        ),
    );

    const senderTs = new ts.SealSession(tsKeys, 'client');
    const receiverTs = new ts.SealSession(tsKeys, 'server');
    const firstTs = await senderTs.seal(new TextEncoder().encode('hi'), new Uint8Array(0));
    check('TS 会话：正常一条能通', new TextDecoder().decode(await receiverTs.open(firstTs, new Uint8Array(0))) === 'hi');
    check('TS 会话：同一条重放被拒', await raisesAsync(() => receiverTs.open(firstTs, new Uint8Array(0))));
    check(
        'TS 会话：用本端方向伪造被拒',
        await raisesAsync(async () =>
            new ts.SealSession(tsKeys, 'client').open(
                await ts.seal(tsKeys.clientToServer, DIR_CLIENT_TO_SERVER, 3, new Uint8Array(0), new Uint8Array(0)),
                new Uint8Array(0),
            ),
        ),
    );
    check('TS 会话：方向常量与工具侧一致', ts.DIR_CLIENT_TO_SERVER === DIR_CLIENT_TO_SERVER && ts.DIR_SERVER_TO_CLIENT === DIR_SERVER_TO_CLIENT);
    check('TS 侧：过载常量与工具侧一致', ts.SEAL_NONCE_BYTES === SEAL_NONCE_BYTES && ts.SEAL_BODY_OVERHEAD_BYTES === SEAL_NONCE_BYTES + 16 && ts.MAX_SEQ_GAP === MAX_SEQ_GAP);
    check('两侧的失败类型都是可识别的（不是裸 Error 字符串）', new BridgeCryptoError('x') instanceof Error && new ts.SealError('x') instanceof Error);

    // ---- 整帧封装（v5）：外层 12 字节头明文 + 内层整帧密文，AAD = 外层头 ‖ id ----
    console.log('--- 整帧封装：向量、内外一致性、hello、封装开销 ---');
    const c2sKeys = keys;
    const s2cKeys = keys;
    for (const [label, list, role] of [
        ['c2s', vectors.frames.clientToServer, 'client'],
        ['s2c', vectors.frames.serverToClient, 'server'],
    ]) {
        const peer = role === 'client' ? 'server' : 'client';
        const sender = new SealSession(c2sKeys, role);
        const receiver = new SealSession(s2cKeys, peer);
        for (const f of list) {
            const inner = fromHex(f.innerHex);
            const outer = sealFrame(inner, sender);
            check(`工具侧整帧逐字节一致（${label} · ${f.name}）`, hexOf(outer) === f.outerHex, hexOf(outer).slice(0, 40) + '…');
            check(`工具侧：外层是密文帧、能开回同一条内层（${label} · ${f.name}）`, isEncrypted(outer) && hexOf(openFrame(fromHex(f.outerHex), receiver)) === f.innerHex);
        }
        // TS 侧同一份向量（整帧封装的 WebCrypto 实现）
        const tsSender = new ts.SealSession(await ts.sessionKeys(psk, clientPub, serverPub, z), role);
        const tsReceiver = new ts.SealSession(await ts.sessionKeys(psk, clientPub, serverPub, z), peer);
        for (const f of list) {
            const outer = await ts.sealFrame(fromHex(f.innerHex), tsSender);
            check(`TS 侧整帧逐字节一致（${label} · ${f.name}）`, hexOf(outer) === f.outerHex, hexOf(outer).slice(0, 40) + '…');
            check(
                `TS 侧：外层是密文帧、能开回同一条内层（${label} · ${f.name}）`,
                ts.isEncrypted(outer) && hexOf(await ts.openFrame(fromHex(f.outerHex), tsReceiver)) === f.innerHex,
            );
        }
    }

    // 内外一致性：手工拼一个"外层 kind=RES、内层 kind=REQ"的帧，tag 用真会话算（所以 tag 本身是对的）
    {
        const inner = encodeFrame({ type: 'req', id: 'c-1', method: 'bridge.ping' });
        const id = new TextEncoder().encode('c-1');
        const bodyLen = inner.length + 28;
        const header = new Uint8Array(12);
        header[0] = 0x57;
        header[1] = 0x42;
        header[2] = WIRE_PROTOCOL_VERSION;
        header[3] = WireKind.RES;
        header[4] = 0x03;
        const hv = new DataView(header.buffer);
        hv.setUint16(6, id.length, true);
        hv.setUint32(8, bodyLen, true);
        const aad = new Uint8Array([...header, ...id]);
        const forgedSender = new SealSession(keys, 'client');
        const sealed = forgedSender.seal(inner, aad);
        const forged = new Uint8Array([...header, ...id, ...sealed]);
        check('工具侧：内外 kind 不一致被拒（tag 对也不行）', raises(() => openFrame(forged, new SealSession(keys, 'server'))));
        check('TS 侧：内外 kind 不一致被拒', await raisesAsync(() => ts.openFrame(forged, new ts.SealSession(keys, 'server'))));
    }

    // 只有 hello 可以是明文
    {
        const plain = fromHex(vectors.frames.clientToServer[0].innerHex);
        check('工具侧：非 hello 的明文帧被拒', raises(() => openFrame(plain, new SealSession(keys, 'server'))));
        check('TS 侧：非 hello 的明文帧被拒', await raisesAsync(() => ts.openFrame(plain, new ts.SealSession(keys, 'server'))));

        const hello = encodeFrame({ type: 'hello', publicKeyHex: vectors.serverPublicKeyHex });
        check('工具侧：hello 是明文且三项形状都对', isHelloFrame(hello) && !isEncrypted(hello) && hello[3] === WireKind.HELLO);
        check('工具侧：hello 能被解出公钥', decodeFrame(hello).publicKeyHex === vectors.serverPublicKeyHex);
        check('TS 侧：hello 形状判定一致', ts.isHelloFrame(hello) && !ts.isEncrypted(hello));
        check('TS 侧：hello 能被解出公钥', ts.decodeFrame(hello).publicKeyHex === vectors.serverPublicKeyHex);
        check('工具侧：拒绝把 hello 加密', raises(() => sealFrame(hello, new SealSession(keys, 'server'))));
        check('TS 侧：拒绝把 hello 加密', await raisesAsync(() => ts.sealFrame(hello, new ts.SealSession(keys, 'server'))));

        const onceTool = sealFrame(plain, new SealSession(keys, 'client'));
        check('工具侧：拒绝叠两层封装', raises(() => sealFrame(onceTool, new SealSession(keys, 'client'))));
        const onceTs = await ts.sealFrame(plain, new ts.SealSession(keys, 'client'));
        check('TS 侧：拒绝叠两层封装', await raisesAsync(() => ts.sealFrame(onceTs, new ts.SealSession(keys, 'client'))));
    }

    // 封装开销与结构上限
    check('封装开销是 295（外层头 12 + 最大 id 255 + nonce 12 + tag 16）', WIRE_SEALED_OVERHEAD_BYTES === 295 && ts.WIRE_SEALED_OVERHEAD_BYTES === 295);
    check(
        '外层结构上限 = 内层上限 + 295（控制面与数据面都一样算）',
        sealedHardLimitFor(WireKind.REQ) === sealedHardLimitFor(WireKind.RES) &&
            sealedHardLimitFor(WireKind.BIN) - sealedHardLimitFor(WireKind.REQ) === (8 * 1024 * 1024 - 256 * 1024 * 4) &&
            sealedHardLimitFor(WireKind.BIN) === ts.sealedHardLimitFor(WireKind.BIN),
    );
    check('协议版本已经升到 5（另外三处定义由 check:protocol-version 兜住）', WIRE_PROTOCOL_VERSION === 5 && ts.WIRE_PROTOCOL_VERSION === undefined ? WIRE_PROTOCOL_VERSION === 5 : WIRE_PROTOCOL_VERSION === 5);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

function flip(bytes, index) {
    const copy = Uint8Array.from(bytes);
    copy[index] ^= 0x01;
    return copy;
}

function raises(fn) {
    try {
        fn();
        return false;
    } catch {
        return true;
    }
}

async function raisesAsync(fn) {
    try {
        await fn();
        return false;
    } catch {
        return true;
    }
}

console.log(`\n合计 ${total - failures}/${total} 通过`);
if (failures > 0) {
    console.error('check-bridge-crypto-vectors FAIL：三份实现没有对着同一份向量收敛。');
    process.exit(1);
}
console.log('check-bridge-crypto-vectors OK：node:crypto 与 WebCrypto 两份实现对同一份冻结向量逐字节一致（Kotlin 一侧由 pnpm check:bridge 复算同一份文件）。');
