#!/usr/bin/env node
/**
 * bench-human-verify.mjs —— bench 侧过"人机验证"的两条路。
 *
 * ## 为什么 bench 需要它
 *
 * 图形验证码删掉之后，"先拿验证码、再去 Redis 读答案、最后随登录发出去"这套 bench 惯用手法
 * 整个失效了（端点没了、答案也不在 Redis 里了）。新流程是：
 *
 *   申请挑战 → 本机密钥签名 + 算计算量证明 → 换一次性票据 → 再拿票据去登录 / 批绑 / 删用户
 *
 * bench 必须**真的走一遍**，否则它验证的就不是真链路。有两条路：
 *
 *   · [attachEvidenceResponder] + [obtainHumanToken] —— 经**真桥**（宿主进程）走。
 *     桥会通过 stdin 问壳要"本地环境证据"，这里扮演壳作答；签名与计算量证明由桥自己做。
 *     这是最贴近真实桌面端的一条路。
 *   · [httpHumanToken] —— 不经桥，直接打 HTTP（`/api/human/challenge` + `/api/human/verify`）。
 *     给那些**故意**绕开桥的探针用（要看原始 HTTP 行为）。密钥与计算量证明由本文件实现。
 *
 * ## 这里的证据是**测试基础设施**的证据
 *
 * `BENCH_EVIDENCE` 声称"已打包、没挂调试器、采样足够"。这是诚实的：bench 进程确实不是
 * 被调试的浏览器。但它**不是**放行判据 —— 判定在服务端（票据 + 风险规则 + 计算量证明）。
 *
 * 自检：`node tools/lib/bench-human-verify.mjs --self-check`
 * 用**独立实现**验一遍自己算出的计算量证明与签名（不然"能过"可能只是两边一起错）。
 */

import crypto from 'node:crypto';
import process from 'node:process';

/** bench 扮演的"壳"所报的环境事实（形状与 `DesktopEvidenceChannel` 的回包一致）。 */
export const BENCH_EVIDENCE = Object.freeze({
    version: 1,
    platform: 'desktop',
    shellPackaged: true,
    debugAttached: false,
    webdriver: false,
    headless: false,
    gestureSamples: 12,
    gestureDurationMs: 180,
    localScore: 0.9,
});

export const POW_INSUFFICIENT_CODE = 'AUTH-HUMAN-1007';
export const ACTION_COOLDOWN = 'cooldown';
export const MAX_COOLDOWN_MS = 10_000;

// ---------------------------------------------------------------- 桥侧（真桥）

/**
 * 扮演"壳"：桥在 stdout 写 `{"type":"evidence-request","id":…}`，这里在 stdin 回同 id。
 *
 * 桥侧超时（1.5s）之内答不上就按**空证据**继续 —— 那条路 bench 也允许，但"壳不答"会让
 * 服务端看到的证据少一半，所以正常路径都应该答上。
 *
 * @returns 解绑函数（bench 收尾时调用）。
 */
export function attachEvidenceResponder(child, { evidence = BENCH_EVIDENCE, onRequest } = {}) {
    let buf = '';
    const onData = (chunk) => {
        buf += chunk.toString();
        let index;
        while ((index = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, index).trim();
            buf = buf.slice(index + 1);
            if (!line.startsWith('{')) continue;
            let json;
            try {
                json = JSON.parse(line);
            } catch {
                continue; // 半行/坏行：桥自己也会忽略，这里不必吵
            }
            if (json?.type !== 'evidence-request' || !json.id) continue;
            onRequest?.(json);
            const data = typeof evidence === 'function' ? evidence(json) : evidence;
            child.stdin.write(`${JSON.stringify({ v: 1, id: json.id, data })}\n`);
        }
    };
    child.stdout.on('data', onData);
    return () => child.stdout.off('data', onData);
}

/**
 * 经桥拿一张票据（`bridge.humanVerify`）。
 *
 * **票据不会回到这里**：它在桥里，由桥在真正要用的那次调用（`auth.login` 等）注入。
 * 所以拿到 `ok === true` 之后，bench 只要正常调业务方法即可 —— 这本身就是一条断言。
 *
 * @param call 各 bench 自己的 `call(ws, id, method, params)`。
 */
export async function obtainHumanToken(ws, call, { purpose = 'LOGIN', username, id = 'hv-1' } = {}) {
    const params = username ? { purpose, username } : { purpose };
    const answer = await call(ws, id, 'bridge.humanVerify', params);
    const frame = answer?.frame;
    const ok = frame?.type === 'res' && frame.data?.ok === true;
    return {
        ok,
        reason: ok ? '' : (frame?.data?.message ?? frame?.message ?? JSON.stringify(frame ?? answer)),
    };
}

// ---------------------------------------------------------------- HTTP 侧（绕过桥）

/** 未压缩点（04 ‖ X ‖ Y，65 字节）—— 与 `DeviceKeyStore` / 服务端同一口径。 */
export function newDeviceKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
    ]);
    return {
        privateKey,
        publicKeyHex: point.toString('hex'),
        // 指纹 = 公钥的 SHA-256 前 32 个 hex 字符（服务端会重算并比对，写死一个常量必然失败）
        keyId: crypto.createHash('sha256').update(point).digest('hex').slice(0, 32),
    };
}

export function leadingZeroBits(bytes) {
    let bits = 0;
    for (const byte of bytes) {
        if (byte === 0) {
            bits += 8;
            continue;
        }
        return bits + (Math.clz32(byte) - 24);
    }
    return bits;
}

export function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest();
}

/** 签名原文：**只在这里拼一次**（三端不一致的表现是"签名永远验不过"）。 */
export function signedText(challengeId, purpose, nonce, keyId) {
    return `${challengeId}|${purpose}|${nonce ?? ''}|${keyId}`;
}

/** 找一个满足 `bits` 个前导零 bit 的 nonce；算不完返回 `null`（如实上报，服务端会降档）。 */
export function solveProofOfWork(challengeId, bits, keyId, budgetMs = 2_000) {
    if (bits <= 0) return '0';
    const deadline = Date.now() + budgetMs;
    for (let counter = 0; Date.now() < deadline; counter += 1) {
        const nonce = counter.toString(36);
        if (leadingZeroBits(sha256(`${challengeId}|${nonce}|${keyId}`)) >= bits) {
            return nonce;
        }
    }
    return null;
}

export function sign(privateKey, text) {
    // JCA 的 `SHA256withECDSA` 要的是 DER 编码（Node 默认就是 der）
    return crypto.sign('sha256', Buffer.from(text, 'utf8'), privateKey).toString('base64');
}

function envelope(data, packetType = 'UNKNOWN') {
    return {
        header: { request_id: `bench-${Date.now()}`, packet_type: packetType, timestamp: Date.now() },
        payload: { code: 'RES-0000', message: '请求', data },
    };
}

/**
 * 直接打 HTTP 拿票据：挑战 → 计算量证明 → 签名 → 提交；服务端说"没算完"时按它的降档再试一次。
 *
 * @returns `{humanToken, deviceKeyId, publicKeyHex}`；失败抛错（把原始应答带上，便于定位）。
 */
export async function httpHumanToken(
    baseUrl,
    {
        purpose = 'LOGIN',
        username,
        evidence = BENCH_EVIDENCE,
        platform = 'desktop',
        clientVersion = '1.0.0-bench',
        powBudgetMs = 2_000,
        fetcher = globalThis.fetch,
    } = {},
) {
    const base = baseUrl.replace(/\/$/, '');
    const keys = newDeviceKey();

    const post = async (path, data) => {
        const response = await fetcher(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope(data)),
        });
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            /* 保留 text */
        }
        return { status: response.status, code: json?.payload?.errorCode ?? json?.payload?.code ?? null, data: json?.payload?.data, text };
    };

    const askChallenge = async () => {
        const body = { purpose, platform, clientVersion, evidence };
        if (username) body.username = username;
        const response = await post('/api/human/challenge', body);
        if (!response.data?.challengeId) {
            throw new Error(`申请人机验证挑战失败：HTTP ${response.status} code=${response.code ?? '-'} ${response.text}`);
        }
        return response.data;
    };

    let challenge = await askChallenge();
    if (challenge.action === ACTION_COOLDOWN) {
        const wait = Math.min(challenge.retryAfterMs ?? 0, MAX_COOLDOWN_MS);
        await new Promise((resolve) => setTimeout(resolve, wait));
        challenge = await askChallenge();
    }

    const submit = async (current) => {
        const nonce = solveProofOfWork(current.challengeId, current.difficultyBits ?? 0, keys.keyId, powBudgetMs);
        const response = await post('/api/human/verify', {
            challengeId: current.challengeId,
            purpose,
            evidence,
            powNonce: nonce,
            deviceKeyId: keys.keyId,
            devicePublicKey: keys.publicKeyHex,
            signature: sign(keys.privateKey, signedText(current.challengeId, purpose, nonce, keys.keyId)),
            clientTime: Date.now(),
        });
        return { response, nonce };
    };

    let { response, nonce } = await submit(challenge);
    if (!response.data?.humanToken && response.code === POW_INSUFFICIENT_CODE && nonce === null) {
        // 服务端已给同一个 IP 记了降档（R8）：**必须**再申请一次挑战，否则那个标记永远用不掉
        challenge = await askChallenge();
        ({ response, nonce } = await submit(challenge));
    }
    if (!response.data?.humanToken) {
        throw new Error(
            `人机验证未通过：HTTP ${response.status} code=${response.code ?? '-'} 难度=${challenge.difficultyBits} 未算完=${nonce === null} ${response.text}`,
        );
    }
    return { humanToken: response.data.humanToken, deviceKeyId: keys.keyId, publicKeyHex: keys.publicKeyHex };
}

// ---------------------------------------------------------------- 自检

/**
 * 用**独立实现**验自己：公钥长度/指纹、计算量证明真的达标、签名能被另一条路径验过。
 * 返回断言列表（全 true 才算自检通过）。
 */
export function selfCheck() {
    const keys = newDeviceKey();
    const challengeId = 'ch-self';
    const purpose = 'LOGIN';

    const point = Buffer.from(keys.publicKeyHex, 'hex');
    const keyIdOk = keys.keyId === crypto.createHash('sha256').update(point).digest('hex').slice(0, 32);

    const nonce = solveProofOfWork(challengeId, 12, keys.keyId, 5_000);
    const powOk = nonce !== null && leadingZeroBits(sha256(`${challengeId}|${nonce}|${keys.keyId}`)) >= 12;

    const text = signedText(challengeId, purpose, nonce, keys.keyId);
    const signature = sign(keys.privateKey, text);
    // 独立验证：从**公钥点**重建 JCA 公钥，而不是复用签名时那把私钥
    const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(point.subarray(1, 33)).toString('base64url'), y: Buffer.from(point.subarray(33, 65)).toString('base64url') };
    const rebuilt = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signatureOk = crypto.verify('sha256', Buffer.from(text, 'utf8'), rebuilt, Buffer.from(signature, 'base64'));
    const tamperedOk = !crypto.verify('sha256', Buffer.from(`${text}x`, 'utf8'), rebuilt, Buffer.from(signature, 'base64'));

    const nullNonceText = signedText(challengeId, purpose, null, keys.keyId);
    const nullNonceOk = nullNonceText === `${challengeId}|${purpose}||${keys.keyId}`;

    return [
        { name: '公钥是 65 字节未压缩点', ok: point.length === 65 && point[0] === 0x04 },
        { name: '指纹 = 公钥 SHA-256 前 32 hex', ok: keyIdOk },
        { name: '计算量证明真的满足 12 位前导零', ok: powOk },
        { name: '签名能被独立重建的公钥验证', ok: signatureOk },
        { name: '改动签名原文就验不过', ok: tamperedOk },
        { name: '算不完时签名原文里的 nonce 是空串（与服务端同一拼法）', ok: nullNonceOk },
    ];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
    if (process.argv.includes('--self-check')) {
        const results = selfCheck();
        for (const item of results) {
            console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}`);
        }
        const failed = results.filter((item) => !item.ok).length;
        console.log(`bench-human-verify 自检：${results.length - failed}/${results.length} 通过`);
        process.exit(failed === 0 ? 0 : 1);
    }
}
