#!/usr/bin/env node
/**
 * check-timeout-budget.mjs —— 超时预算链的**跨语言**回归护栏。
 *
 * ## 为什么需要它
 *
 * 第三轮用户复报的形状不是"卡加载"，而是**一个没有原因的客户端超时**：
 * `BRIDGE_BACKEND_UNREACHABLE` + `bridge.timeout`（界面文案"请求超时，可重试"）。
 *
 * 根因是超时层级反了：
 *
 *     后端读超时 20s   >   Web 侧调用总预算 15s
 *
 * 外层比内层短，于是**永远轮不到后端先失败** —— OkHttp 还在等，
 * 页面已经自己超时了。后果不只是慢：桥侧那条**带原因的日志一行都不会打**
 * （因为 OkHttp 还没抛，catch 就到不了），真正的失败原因（连接被拒 / 读超时 / DNS）
 * 全部丢失，用户看到的是"超时"，排障看到的是空白。
 *
 * 正确形态是一条严格递增的链，内层永远先说话：
 *
 *     后端建连 5s  <  后端读写 8s  <  后端整次调用 10s  <  Web 侧调用 15s
 *
 * ## 为什么必须跨语言对账
 *
 * 这几个数分居两份源码：Kotlin（`OkHttpBackend.kt`）与 TypeScript（`transport.ts`）。
 * 单看任何一边都是"合理"的 —— 出事的那一版每一边单看都没毛病，是**关系**错了。
 * 所以这里不测某一边的取值范围，只测**关系**：只改一边就会红。
 *
 * 用法：node tools/check/check-timeout-budget.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');

const KOTLIN = path.join(
    CLIENT_ROOT,
    'bridge',
    'backend',
    'src',
    'main',
    'kotlin',
    'com',
    'huicang',
    'wise',
    'bridge',
    'backend',
    'OkHttpBackend.kt',
);
const TS = path.join(CLIENT_ROOT, 'packages', 'bridge-client', 'src', 'transport.ts');

let failures = 0;
let total = 0;

/**
 * `detail` 是**失败原因**，`info` 是**通过时的实测值** —— 两者故意分开。
 *
 * 原先只有一个 `detail` 且通过时也照打，于是绿行里出现了
 * `✓ ... MILLISECONDS ... —— 找不到 TimeUnit.MILLISECONDS`：一条通过用例
 * 读起来像在报故障。绿行不值得信的时候，整份输出就没人看了。
 */
function check(name, passed, detail, info) {
    total += 1;
    if (passed) {
        console.log(`  ✓ ${name}${info ? ` —— ${info}` : ''}`);
        return;
    }
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    failures += 1;
}

/** 从源码里取一个 `NAME = <数字>` 形式的常量；取不到返回 null（并让用例失败）。 */
function num(source, name, label) {
    // 允许 `_` 千分位与 `L`/`L` 后缀（Kotlin Long 字面量）
    const re = new RegExp(`${name}\\s*(?::\\s*Long\\s*)?=\\s*([0-9_]+)L?\\b`);
    const m = re.exec(source);
    if (!m) {
        check(`${label} 里能找到 ${name}`, false, '常量不存在或写法变了');
        return null;
    }
    return Number(m[1].replace(/_/g, ''));
}

const kotlin = readFileSync(KOTLIN, 'utf8');
const ts = readFileSync(TS, 'utf8');

// ---------------------------------------------------------------- 取数

const CONNECT = num(kotlin, 'CONNECT_TIMEOUT_MS', 'OkHttpBackend.kt');
const IO = num(kotlin, 'IO_TIMEOUT_MS', 'OkHttpBackend.kt');
const CALL = num(kotlin, 'CALL_TIMEOUT_MS', 'OkHttpBackend.kt');
const BRIDGE = num(ts, 'BRIDGE_CALL_TIMEOUT_MS', 'transport.ts');

if (CONNECT === null || IO === null || CALL === null || BRIDGE === null) {
    console.error('check-timeout-budget: 常量解析失败，无法继续');
    process.exit(1);
}

console.log(
    `  预算链：后端建连 ${CONNECT}ms → 后端读写 ${IO}ms → 后端整次调用 ${CALL}ms → Web 调用 ${BRIDGE}ms`,
);

// ---------------------------------------------------------------- 1. 单调递增

check('后端建连 < 后端读写（内层最小）', CONNECT < IO, '内层反了：读超时小于建连超时', `${CONNECT} < ${IO}`);
check('后端读写 < 后端整次调用', IO <= CALL, '读写超时比整次调用还大', `${IO} <= ${CALL}`);
check(
    '后端整次调用 < Web 侧调用总预算（**外层必须最宽**）',
    CALL < BRIDGE,
    '外层预算没有包住后端',
    `${CALL} < ${BRIDGE}`,
);
check('Web 侧调用预算 > 后端建连超时', BRIDGE > CONNECT, '外层比内层还紧', `${BRIDGE} > ${CONNECT}`);

// ---------------------------------------------------------------- 2. 余量

/*
 * 余量不是"差不多就行"：外层那 15s 用在**桥自己卡住**上，所以它和后端整次预算之间
 * 必须留出足够的时间让桥把错误帧封装回去。小于 3s 时二者会在同一量级上互相抢，
 * 表现就是"有时看到真正的原因，有时只看到超时" —— 最难查的那种。
 */
const MARGIN_MIN = 3_000;
check(
    `外层次预算与后端整次调用之间余量 >= ${MARGIN_MIN}ms`,
    BRIDGE - CALL >= MARGIN_MIN,
    `余量只有 ${BRIDGE - CALL}ms：桥来不及把错误帧封装回去`,
    `余量 ${BRIDGE - CALL}ms`,
);

// ---------------------------------------------------------------- 3. 配置真的用上了

/*
 * **常量存在 ≠ 配置生效** —— 这正是旧值能躲过 review 的原因：
 * 旧版有 connect/read/write 三个数，看起来"配了超时"，
 * 但缺的是 `callTimeout`（OkHttp 里唯一覆盖"整次调用"的那一项）。
 * 所以这里断言装配代码里**确实调用了**这四个 builder 方法。
 */
for (const [method, name] of [
    ['connectTimeout', 'CONNECT'],
    ['readTimeout', 'IO'],
    ['writeTimeout', 'IO'],
    ['callTimeout', 'CALL'],
]) {
    const re = new RegExp(`\\.${method}\\(\\s*(?:${
        name === 'CONNECT' ? 'CONNECT_TIMEOUT_MS|connectMs' : name === 'IO' ? 'IO_TIMEOUT_MS|ioMs|writeMs' : 'CALL_TIMEOUT_MS|callMs'
    })\\b`);
    check(`OkHttp 装配调用了 .${method}(...)`, re.test(kotlin), `没有 .${method}(...) 调用`);
}

check(
    'OkHttp 超时单位是 MILLISECONDS（不是秒，避免又一次量级错误）',
    /TimeUnit\.MILLISECONDS/.test(kotlin),
    '找不到 TimeUnit.MILLISECONDS',
);

check(
    'TS 的 DEFAULTS 用的是 BRIDGE_CALL_TIMEOUT_MS（不是又写了一遍字面量）',
    /callTimeoutMs:\s*BRIDGE_CALL_TIMEOUT_MS/.test(ts),
    'DEFAULTS.callTimeoutMs 没有引用命名常量',
);

// ---------------------------------------------------------------- 4. 反向断言：旧值必须不复存在

/*
 * 钉住"读超时曾经比 Web 预算还大"这个具体形态。
 * 只断言关系是对的还不够 —— 如果将来有人把 Web 预算提到 30s 来"兼容"一个 20s 读超时，
 * 关系依然成立，但那是在用更大的等待掩盖慢后端。这里直接挡住那个方向。
 */
check(
    '后端读超时不再 >= Web 侧总预算（挡住"把外层预算调大来兼容慢后端"）',
    IO < BRIDGE,
    '读超时已经顶到外层预算：这是在用更大的等待掩盖慢后端',
    `${IO} < ${BRIDGE}`,
);

if (failures > 0) {
    console.error(`check-timeout-budget: ${failures}/${total} 个用例失败`);
    process.exit(1);
}
console.log(
    `check-timeout-budget OK: ${total} 个用例（内层先失败 / 外层次最宽 / 余量足够 / 配置真的用上）`,
);
