#!/usr/bin/env node
/**
 * check-navigation.mjs —— 导航可达性的静态门禁。
 *
 * ## 为什么需要它
 *
 * 屏请求导航时写的是一个**字符串方法 id**：
 *
 *     onNavigate?.({ method: 'tag.detail', params: { tagId } })
 *
 * 拼错一个字符（`tag.detial`）不会编译失败、不会抛异常 —— 外壳查不到这个目的地，
 * 只会打一行 console.warn，用户看到的是**点了没反应**。这是最难查的一类故障，
 * 所以必须在构建期把字面量全部对一遍。
 *
 * 同时校验导航叶子与目的地的 id 都在契约里存在（改契约后漏改导航也会被抓到）。
 *
 * ## 只报告、不失败的两类
 *
 *  · 目的地对应的屏**还没迁**（例如告警详情）—— 点了会看到"功能上线中"占位。
 *    这是诚实的状态而不是错误，所以只列出来，不判失败。
 *
 * 用法：node tools/check/check-navigation.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NAV_TS = path.join(CLIENT_ROOT, 'packages', 'shells', 'src', 'navigation.ts');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const REGISTRY_TS = path.join(CLIENT_ROOT, 'packages', 'features', 'src', 'registry.tsx');
const FEATURES_SRC = path.join(CLIENT_ROOT, 'packages', 'features', 'src');

let problems = 0;
const fail = (msg) => {
    console.error(`✗ ${msg}`);
    problems += 1;
};

const navText = fs.readFileSync(NAV_TS, 'utf8');

/** 导航叶子：`primaryMethod: '...'` */
const leafMethods = [...navText.matchAll(/primaryMethod:\s*'([^']+)'/g)].map((m) => m[1]);
/** 目的地：DESTINATIONS 数组里的 `{ method: '...', label: '...' }` */
const destBlock = /DESTINATIONS[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(navText)?.[1] ?? '';
const destMethods = [...destBlock.matchAll(/method:\s*'([^']+)'/g)].map((m) => m[1]);

function checkUnique(values, label) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value)) {
            fail(`${label} 存在重复项：${value}`);
        }
        seen.add(value);
    }
}

const contractText = fs.readFileSync(CONTRACT_TS, 'utf8');
const contractIds = new Set([...contractText.matchAll(/\{ id: '([^']+)', domain:/g)].map((m) => m[1]));

const registryText = fs.readFileSync(REGISTRY_TS, 'utf8');
const registryBody = registryText.slice(registryText.indexOf('const REGISTRY'));
const registered = new Set([...registryBody.matchAll(/^\s*'([^']+)':\s*[\w.]+,\s*$/gm)].map((m) => m[1]));

checkUnique(leafMethods, '导航叶子方法');
checkUnique(destMethods, '导航目的地方法');

// ---- 1. 导航叶子与目的地都必须在契约里 ----
for (const m of leafMethods) {
    if (!contractIds.has(m)) {
        fail(`导航叶子引用了契约里不存在的方法 id：${m}`);
    }
}
for (const m of destMethods) {
    if (!contractIds.has(m)) {
        fail(`DESTINATIONS 引用了契约里不存在的方法 id：${m}`);
    }
}

// ---- 2. 代码里所有 onNavigate 的字面量都必须可达 ----
const reachable = new Set([...leafMethods, ...destMethods]);
const codeFiles = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p);
        } else if (e.name.endsWith('.tsx')) {
            codeFiles.push(p);
        }
    }
})(FEATURES_SRC);

let navigateCalls = 0;
for (const file of codeFiles) {
    const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
        if (!line.includes('onNavigate')) {
            return;
        }
        for (const m of line.matchAll(/method:\s*'([^']+)'/g)) {
            navigateCalls += 1;
            if (!reachable.has(m[1])) {
                fail(
                    `${rel}:${i + 1} 导航目标「${m[1]}」既不是导航叶子也不在 DESTINATIONS 里 —— ` +
                        '用户会看到"点了没反应"（检查拼写，或把它加进 navigation.ts 的 DESTINATIONS）',
                );
            }
        }
    });
}

// ---- 3. 只报告：目的地还没迁（点了会看到"上线中"占位）----
const notMigrated = destMethods.filter((m) => !registered.has(m));

if (problems > 0) {
    console.error(
        `\ncheck-navigation: ${problems} 处问题（叶子 ${leafMethods.length} / 目的地 ${destMethods.length} / 代码里的导航调用 ${navigateCalls}）`,
    );
    process.exit(1);
}

console.log(
    `check-navigation OK: 叶子 ${leafMethods.length} 个、目的地 ${destMethods.length} 个、` +
        `代码里的导航调用 ${navigateCalls} 处，全部在契约与可达集合内`,
);
if (notMigrated.length > 0) {
    console.log(`  提示：以下目的地对应的屏尚未迁入，点进去会看到"功能上线中"占位（不是错误）：${notMigrated.join(' / ')}`);
}
