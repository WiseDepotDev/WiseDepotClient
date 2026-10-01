#!/usr/bin/env node
/**
 * check-nav-state.mjs —— 「翻页没反应」这类**响应式丢代理**缺陷的回归护栏。
 *
 * ## 抓的是什么
 *
 * `useNavStore().viewStateOf(id)` 存的是页码 / 筛选 / 滚动位置 —— 屏幕把这几个字段
 * 直接写进去，再让 `computed`/`watch` 去驱动 `useResource` 的参数。
 * 只要 `viewStateOf` 在**缓存未命中的那一次**返回了**原始对象**（而不是 reactive 代理），
 * 这个写入就不会触发任何依赖更新，表现是**冷启动首次进入时点页码完全没反应**，
 * 而"离开再回来"又好了（第二次 get 才拿到代理）—— 一种"刷新一下就好了"的 bug。
 *
 * 这就是审查真实复现出来的缺陷（`nav.ts` 的 `viewStateOf` 与 `resource.ts` 的 `ensure()`
 * 是同一个错法）。这里不测实现细节，只钉一条不变量：
 * **拿到的状态一定是可响应的，而且写进去就是同一份状态。**
 *
 * 用法：node tools/check/check-nav-state.mjs
 */

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 从 apps/web 解析 vue / pinia（工作区里这两个依赖装在那儿）。 */
const RESOLVE_DIR = path.join(CLIENT_ROOT, 'apps', 'web');
/**
 * 被测模块。可用 `WISE_NAV_TS=<别的文件>` 覆盖 —— 用来做**变异验证**：
 * 把老实现（`return created;`）拷一份跑一遍，这条护栏必须变红，
 * 否则它只是一段"总是通过"的仪式。
 */
const NAV_TS = process.env['WISE_NAV_TS'] ?? path.join(CLIENT_ROOT, 'packages', 'stores', 'src', 'nav.ts');
const NAV_IMPORT = path.relative(RESOLVE_DIR, NAV_TS).replace(/\\/g, '/');

const outDir = mkdtempSync(path.join(tmpdir(), 'wise-nav-state-'));
const outFile = path.join(outDir, 'nav-state.cjs');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
    if (ok) {
        passed += 1;
        console.log(`  ✓ ${name}`);
        return;
    }
    failures.push(`${name}${detail === '' ? '' : ` —— ${detail}`}`);
    console.error(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}`);
}

try {
    await build({
        stdin: {
            contents: `
                export { useNavStore } from '${NAV_IMPORT}';
                export { computed, reactive, watchEffect } from 'vue';
                export { createPinia, setActivePinia } from 'pinia';
            `,
            resolveDir: RESOLVE_DIR,
            loader: 'ts',
            sourcefile: 'nav-state-entry.ts',
        },
        outfile: outFile,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        logLevel: 'warning',
    });

    const mod = await import(pathToFileURL(outFile).href);
    const { useNavStore, computed, watchEffect, createPinia, setActivePinia } = mod;
    if (typeof useNavStore !== 'function' || typeof computed !== 'function') {
        console.error('✗ 打出来的模块缺 useNavStore / computed');
        process.exit(1);
    }

    setActivePinia(createPinia());
    const store = useNavStore();

    // ---- 1. 首次取（缓存未命中）拿到的必须是响应式的 ----
    const first = store.viewStateOf('inspection.taskPage');
    const page = computed(() => first.page);
    check('首次取到的 viewState 初始页码是 1', page.value === 1, `page=${page.value}`);

    first.page = 2;
    check(
        '首次取到的 viewState 写入真的会触发依赖更新（冷启动翻页的命门）',
        page.value === 2,
        `写 2 之后 computed 还是 ${page.value} —— 说明拿到的是原始对象，不是 reactive 代理`,
    );

    // ---- 2. 就是同一份状态：第二次取要拿到同一个代理，且写进去要能看见 ----
    const second = store.viewStateOf('inspection.taskPage');
    check('第二次取到的是同一个代理（不是又造一份）', second === first);
    check('写进 store 里的值能读到', store.views.get('inspection.taskPage')?.page === 2, `page=${store.views.get('inspection.taskPage')?.page}`);

    // ---- 3. 更贴近真实用法：params 从 view 派生 + watch 重跑（useResource 的写法） ----
    let refetches = 0;
    const params = computed(() => ({ page: first.page, pageSize: 20 }));
    watchEffect(() => {
        void params.value;
        refetches += 1;
    });
    const before = refetches;
    first.page = 3;
    await Promise.resolve();
    check(
        'view.page 变化会让派生出的请求参数重算（useResource 会跟着重新取数）',
        refetches > before && params.value.page === 3,
        `refetches ${before} → ${refetches}，params.page=${params.value.page}`,
    );

    // ---- 4. 嵌套字段（筛选）也要是深响应的 ----
    let filterRuns = 0;
    const filterValue = computed(() => first.filters['status'] ?? '');
    watchEffect(() => {
        void filterValue.value;
        filterRuns += 1;
    });
    const filterBefore = filterRuns;
    first.filters['status'] = 'RUNNING';
    await Promise.resolve();
    check('filters 是深响应（改一个筛选键也会触发）', filterRuns > filterBefore && filterValue.value === 'RUNNING');

    // ---- 5. 不同屏的状态互相不串 ----
    const other = store.viewStateOf('stockOrder.list');
    check('不同屏各有一份状态', other !== first && other.page === 1 && first.page === 3, `other.page=${other.page}`);

    // ---- 6. rememberScroll 走的是同一条路（它内部就是 viewStateOf） ----
    store.rememberScroll('inspection.taskPage', 480);
    check('rememberScroll 写回的滚动位置能被同一份状态看到', first.scrollTop === 480, `scrollTop=${first.scrollTop}`);
} catch (error) {
    console.error(`✗ 护栏执行失败：${error?.stack ?? error}`);
    process.exit(1);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`check-nav-state: ${failures.length}/${passed + failures.length} 个用例失败`);
    process.exit(1);
}
console.log(`check-nav-state OK: ${passed} 个用例（首次取即响应式 / 同一份状态 / 派生参数会重算 / 深响应 / 各屏隔离）`);
