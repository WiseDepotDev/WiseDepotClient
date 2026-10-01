#!/usr/bin/env node
/**
 * check-session-expiry.mjs —— 「会话失效必须被如实上报」的回归。
 *
 * ## 为什么需要它
 *
 * 用户看到的是一条**误导性的**错误：
 *
 *     HTTP-400
 *     请求被拒绝（可能缺少签名或参数）
 *
 * 真因是"没登录"。链路是这样的：
 *
 *   1. 后端令牌过期 → 桥续期失败 → `session.markExpired()` → 清掉令牌；
 *   2. 界面**停在已登录的画面上**（`bridge.session` 只在挂载时被问过一次，
 *      没有任何推送告诉它会话没了）；
 *   3. 后续请求不再带 `Authorization`，而非白名单端点会先撞后端的签名过滤器
 *      （`RequestSignatureFilter`：只有带 `Bearer ` 才跳过签名校验），
 *      于是回一个"缺少必要的签名参数"的 400；
 *   4. 界面把这条 400 原样展示 → 用户和排障一起被指向"签名是不是配错了"。
 *
 * 这条故障的特征是**跨语言的三处必须同时存在**（少任何一处都不生效，而且都不报错）：
 *
 *   · Kotlin 定义事件主题；
 *   · 装配点把它接到广播上（**这就是当初缺的那一环** —— 通道早就有了，没人接）；
 *   · TS 用**同一个字符串**订阅，且 `useSession` 真的调用了 subscribe。
 *
 * 所以这里不做行为测试（那要起一个假后端 + 真的续期失败），只做**接线与串一致性**：
 * 这正是"静默失效"的那一类 —— 值错了不会崩，只会让界面永远不知道会话没了。
 *
 * 用法：node tools/check/check-session-expiry.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');

const SESSION_MANAGER = path.join(
    CLIENT_ROOT, 'bridge', 'server', 'src', 'main', 'kotlin', 'com', 'huicang', 'wise', 'bridge', 'server', 'SessionManager.kt',
);
const DISPATCHER = path.join(
    CLIENT_ROOT, 'bridge', 'server', 'src', 'main', 'kotlin', 'com', 'huicang', 'wise', 'bridge', 'server', 'BridgeDispatcher.kt',
);
const SERVER = path.join(
    CLIENT_ROOT, 'bridge', 'server', 'src', 'main', 'kotlin', 'com', 'huicang', 'wise', 'bridge', 'server', 'BridgeServer.kt',
);
const TS_TYPES = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'types.ts');
/*
 * V6：这两个"界面侧拥有者"改指 Vue 侧 ——
 *   · 会话订阅：`packages/stores/src/session.ts`（React 版那份已随 packages/features 删除）
 *   · 错误码转人话：`packages/stores/src/dto.ts` 的 `humanize`（"码 → 人话"的唯一拥有者）
 * 断言的内容一字未改：换的是**载体**，不是标准。
 */
const TS_SESSION = path.join(CLIENT_ROOT, 'packages', 'stores', 'src', 'session.ts');

let failures = 0;
let total = 0;

function check(name, passed, detail) {
    total += 1;
    if (passed) {
        console.log(`  ✓ ${name}`);
        return;
    }
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    failures += 1;
}

const kotlinTopic = readFileSync(SESSION_MANAGER, 'utf8');
const dispatcher = readFileSync(DISPATCHER, 'utf8');
const server = readFileSync(SERVER, 'utf8');
const tsTypes = readFileSync(TS_TYPES, 'utf8');
const tsSession = readFileSync(TS_SESSION, 'utf8');

// ---------------------------------------------------------------- 1. 两端的事件主题必须一致

const ktMatch = /EVENT_SESSION_EXPIRED\s*:\s*String\s*=\s*"([^"]+)"/.exec(kotlinTopic);
const tsMatch = /BRIDGE_EVENT_SESSION_EXPIRED\s*=\s*'([^']+)'/.exec(tsTypes);

check('Kotlin 定义了 EVENT_SESSION_EXPIRED', ktMatch !== null);
check('TS 定义了 BRIDGE_EVENT_SESSION_EXPIRED', tsMatch !== null);

if (ktMatch && tsMatch) {
    check(
        '两端的事件主题**是同一个字符串**（跨语言线上契约，改一边必红）',
        ktMatch[1] === tsMatch[1],
        `Kotlin="${ktMatch[1]}" / TS="${tsMatch[1]}"`,
    );
}

// ---------------------------------------------------------------- 2. 装配点真的接上了（当初缺的就是这一环）

check(
    'BridgeDispatcher 接受 onSessionExpired 并会调用它',
    /onSessionExpired\s*:\s*\(\)\s*->\s*Unit/.test(dispatcher) && /onSessionExpired\(\)/.test(dispatcher),
    '分发器没有通知出口，或收了却从不调用',
);

check(
    '会话失效时确实置位（markExpired 与通知在同一处）',
    /session\.markExpired\(\)\s*\n\s*onSessionExpired\(\)/.test(dispatcher),
    '置位了却不通知：界面永远不会知道会话已失效',
);

check(
    'BridgeServer 把 onSessionExpired 接到了事件广播上',
    /onSessionExpired\s*=\s*\{[^}]*emit\([^)]*EVENT_SESSION_EXPIRED[^)]*\)/.test(server),
    '通道早就有了（BridgeServer.emit），但没人接 —— 这正是当初的缺口',
);

// ---------------------------------------------------------------- 3. Web 侧真的订阅了

check(
    'useSession 订阅了会话失效事件并重新判定会话',
    new RegExp(`subscribe\\(\\s*BRIDGE_EVENT_SESSION_EXPIRED`).test(tsSession),
    '定义了常量却没人订阅：常量存在 ≠ 生效',
);

check(
    '订阅后走的是 reload（重新问 bridge.session，而不是自己推断登录态）',
    /*
     * 判据是"回调里真的调了 reload()"，**不是**"用了哪种写法"：
     * 表达式体 `() => reload()` 与块体 `() => { void reload(); }` 行为等价，
     * 而旧正则只认表达式体 —— 那是把"形式"当成了"责任"（V6 改指 Vue 侧时踩到，Vue 版用的正是块体）。
     */
    /subscribe\(\s*BRIDGE_EVENT_SESSION_EXPIRED[\s\S]{0,200}?\breload\(\)/.test(tsSession),
    '登录判定的唯一来源是 bridge.session，前端不该自己推断',
);

// ---------------------------------------------------------------- 4. 用户看到的话得是对的

/*
 * 上面扫的是"接线"，这一段扫的是"用户最终看到什么"。
 *
 * 之所以要单独一条：接线对了、码也对了，文案仍可能把用户引向错误方向 ——
 * 实测就是把 `HTTP-400` 解释成"签名/参数问题"，而真因是"没登录"。
 * 判据落在 `humanize` 这一处（错误码 → 人话的**唯一**拥有者），
 * 不去扫注释：注释里写清楚故障经过是**好事**，不该被门禁禁止。
 */
const HUMANIZE = path.join(CLIENT_ROOT, 'packages', 'stores', 'src', 'dto.ts');
const humanize = readFileSync(HUMANIZE, 'utf8');

check(
    'humanize 把 error_session_expired 映射成"重新登录"的指引',
    /case\s+'error_session_expired':\s*\n?\s*return\s+'[^']*登录[^']*'/.test(humanize),
    '会话失效必须给出可执行的下一步（重新登录），而不是一个码',
);

check(
    'humanize 不再把 HTTP-400 单独解释成"签名/参数"就了事',
    !/error\.code === 'HTTP-400'[\s\S]{0,120}?return '[^']*签名/.test(humanize),
    'HTTP-400 的文案若只提签名，会把"没登录"这种情况也引向签名排查',
);

if (failures > 0) {
    console.error(`check-session-expiry: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(`check-session-expiry OK: ${total} 个用例（主题串一致 / 装配点已接 / 界面真的订阅）`);
