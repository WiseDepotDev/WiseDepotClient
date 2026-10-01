#!/usr/bin/env node
/**
 * check-navigation.mjs —— 导航可达性的静态门禁（Vue 侧）。
 *
 * ## 为什么需要它
 *
 * 屏请求导航时写的是一个**字符串方法 id**：
 *
 *     router.push({ name: 'tag.detail', params: { code } })
 *
 * 拼错一个字符（`tag.detial`）不会编译失败 —— vue-router 只会 warn 并 reject，
 * 用户看到的是**点了没反应**。这是最难查的一类故障，所以在构建期把字面量全对一遍。
 *
 * ## V6 改了什么
 *
 * 它原先读的是 React 侧的 `packages/shells/src/navigation.ts` 与
 * `packages/features/src/**\/*.tsx` 里的 `onNavigate({ method })` 字面量。
 * React 版删掉后**改指同一套口径的 Vue 侧**（`packages/layouts/src/navigation.ts` 是唯一的 IA 出处，
 * 两条正则不用改；代码侧改成扫 `apps/web/src` 里的 `router.push({ name })`）。
 *
 * **为什么不直接删掉它**：`check:navigation-web` 只校验 IA 表本身（路径唯一、参数一致、静态段先于参数段、
 * 注册表可达），**它看不到"某个屏里手写的导航目标拼错了"**。这两条门禁守的不是同一件事。
 *
 * 用法：node tools/check/check-navigation.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 信息架构的唯一出处（Vue）。 */
const NAV_TS = path.join(CLIENT_ROOT, 'packages', 'layouts', 'src', 'navigation.ts');
const CONTRACT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const REGISTRY_TS = path.join(CLIENT_ROOT, 'apps', 'web', 'src', 'views', 'registry.ts');
/** 屏代码所在地：导航字面量从这里扫。 */
const WEB_SRC = path.join(CLIENT_ROOT, 'apps', 'web', 'src');

let problems = 0;
const fail = (msg) => {
    console.error(`✗ ${msg}`);
    problems += 1;
};

const navText = fs.readFileSync(NAV_TS, 'utf8');

/** 导航叶子：`primaryMethod: '...'` */
const leafMethods = [...navText.matchAll(/primaryMethod:\s*'([^']+)'/g)].map((m) => m[1]);
/** 目的地：DESTINATIONS 数组里的 `method: '...'` */
/*
 * 锚点必须是 `export const DESTINATIONS`：文件**开头的注释里也出现过 DESTINATIONS 这个词**，
 * 只写 /DESTINATIONS[\s\S]*?= *\[/ 会从注释一路匹配到 DOMAINS 的 `= [`，
 * 于是"目的地表"抓成了叶子表 → 所有目的地都被判成不可达（13 处误报，踩过一次）。
 */
const destBlock = /export const DESTINATIONS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(navText)?.[1] ?? '';
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
const registryBody = registryText.slice(registryText.indexOf('SCREEN_REGISTRY'));
const registered = new Set([...registryBody.matchAll(/^\s*'([^']+)':\s*\(\).*$/gm)].map((m) => m[1]));

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

// ---- 2. 代码里所有 router.push({ name }) 的字面量都必须可达 ----
const reachable = new Set([...leafMethods, ...destMethods]);
const codeFiles = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p);
        } else if (e.name.endsWith('.vue') || e.name.endsWith('.ts')) {
            codeFiles.push(p);
        }
    }
})(WEB_SRC);

let navigateCalls = 0;
for (const file of codeFiles) {
    const rel = path.relative(CLIENT_ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (!line.includes("name:")) {
            return;
        }
        /*
         * `router.push({ name: 'x' })` 常常是单行，但格式化成多行也合法 ——
         * 所以判据是"这一行或上一行里有 push("，而不是"这一行同时有 push 和 name"。
         */
        const prev = lines[i - 1] ?? '';
        if (!line.includes('push(') && !prev.includes('push(')) {
            return;
        }
        for (const m of line.matchAll(/name:\s*'([^']+)'/g)) {
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
