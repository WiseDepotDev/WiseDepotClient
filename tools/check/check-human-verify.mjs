#!/usr/bin/env node
/*
 * check-human-verify.mjs —— 人机验证的**跨仓静态门禁**（客户端 + 服务端）。
 *
 * ## 为什么需要它
 *
 * 这套机制替换掉的是图形验证码，而图形验证码当初的失败方式**不是崩**，是**静默失去边界**：
 *
 *   1. 服务端有两处 `if (captchaId != null && captchaCode != null)` —— 不传字段就能跳过校验；
 *   2. 同一个业务效果有**两条** HTTP 路径，守卫只挂在其中一条（`/batch-bind-with-captcha` 有守卫、
 *      无票的 `/batch-bind` 敞开）；
 *   3. 图形码从界面上消失了，但守卫仍然只在 Controller —— 前端"看不见"被当成了"过不去"。
 *
 * 这三条都不会让任何一条测试变红，所以必须**静态钉住**。本门禁钉的正是"当年怎么坏的"：
 *
 *   A. 三条效果入口（登录 / 批量绑定 / 删除用户）必须**在 Service 层**校验票据，且是方法的第一条语句；
 *   B. 校验必须**缺失即失败**（禁止 `if (humanToken != null) { 校验 }` 这个形状复活）；
 *   C. 同一业务效果**只能有一条 HTTP 路径**（无守卫的孪生端点不许回来）；
 *   D. 图形验证码在**生产代码**里必须彻底消失（历史注释与"断言其不存在"的检查除外，见 ALLOWED）；
 *   E. 两个壳：声明了 `human.verify` 就必须实现 `HumanVerifyPort`（"声明即承诺"）；
 *   F. 证据字段白名单，而且是**双向**的：页面只许报它看得见的事实（不许替壳声明 `shellPackaged`），
 *      服务端 DTO 里的每个字段也必须有生产者 —— 单向检查抓不到"页面采了、DTO 里没这个字段、
 *      Jackson 悄悄丢掉"这类洞（`maxJumpPx` 就是这么丢掉过一次）；
 *   G. 票据不许出现在页面上下文里（一次 XSS 就能把它挪用去删用户）。
 *
 * 用法：node tools/check/check-human-verify.mjs
 *        node tools/check/check-human-verify.mjs --selftest   # 见下
 * 退出码：0 = 全部通过；1 = 有违反（逐条打印违反项与位置）。
 *
 * ## --selftest：这条门禁**自己能不能红**
 *
 * "凡是门禁都要在它守的那个 bug 上变红" —— 否则它只是一段打印 OK 的代码。
 * `--selftest` 把当年那几种坏法**在内存里**逐一造出来（不动磁盘上的任何文件），
 * 断言每一种都能让对应的检查项报错。改动本文件后请跑一次。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 服务端仓就在客户端仓隔壁；可用 WISE_SERVER_ROOT 覆盖。读不到就是**红**（不是跳过）。 */
const SERVER = process.env.WISE_SERVER_ROOT || path.resolve(ROOT, '..', 'WiseDeoptServer');

/** 仅 `--selftest` 使用：内存里的"被弄坏的文件"。磁盘上永远不动。 */
const OVERRIDE_CLIENT = new Map();
const OVERRIDE_SERVER = new Map();

/**
 * 允许出现 `captcha` 字样的两个例外，各有理由（其余生产代码里出现一次就算违反）。
 *
 * 注意这里允许的是**文件**，不是"某一行"：放行理由必须足够窄，否则这条门禁会在
 * "只是注释提了一嘴"的掩护下漏掉真正的复活。
 */
const ALLOWED_CAPTCHA_FILES = new Map([
    [
        'tools/gen/bridge-overlay.json',
        'legacyIntentional：这份清单的用途就是**登记被删掉的端点**（含 /api/captcha/*），删掉它就没人知道当初删了什么',
    ],
    [
        'apps/web/smoke/check-web-smoke.mjs',
        '它断言的是"图形码**不在**界面上"（查 `.w-captcha` 应为 null）—— 这是反证，不是引用',
    ],
    [
        'tools/check/check-human-verify.mjs',
        '本门禁自身：它必须写出要扫的关键词和例外清单',
    ],
    [
        'wise-deopt-api/src/main/java/com/huicang/wise/api/aspect/WebLogAspect.java',
        '日志脱敏名单：它是**字段名通配**（含 captcha 就掩码），属于防御性的"多掩一个不亏"。把已删字段名从这里摘掉只会让脱敏变弱',
    ],
    [
        'wise-deopt-infrastructure/src/main/java/com/huicang/wise/infrastructure/filter/RequestLoggingFilter.java',
        '同上：请求体脱敏的字段名清单，保留 captchaCode 是防御性的',
    ],
]);

/** 生产代码的扫描范围（排掉构建产物与依赖）。 */
const CLIENT_SCAN_DIRS = [
    'apps/web/src',
    'apps/desktop/src',
    'apps/mobile/shell/src',
    'packages/bridge-client/src',
    'packages/stores/src',
    'packages/ui/src',
    'packages/tokens/src',
    'packages/contract/src',
    'bridge/backend/src/main',
    'bridge/capability/src/main',
    'bridge/protocol/src/main',
    'bridge/server/src/main',
    'bridge/host-desktop/src/main',
    'tools/bench',
    'tools/check',
    'tools/gen',
    'tools/lib',
];

const SCAN_EXT = new Set(['.ts', '.vue', '.kt', '.kts', '.mjs', '.js', '.json', '.java', '.css']);

const failures = [];
const notes = [];

function fail(check, detail) {
    failures.push({ check, detail });
}

function note(text) {
    notes.push(text);
}

function walk(dir) {
    const out = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', 'build', 'dist', 'bin', 'out', '.gradle', 'target'].includes(entry.name)) continue;
            out.push(...walk(full));
        } else if (SCAN_EXT.has(path.extname(entry.name))) {
            out.push(full);
        }
    }
    return out;
}

function readClient(rel) {
    if (OVERRIDE_CLIENT.has(rel)) return OVERRIDE_CLIENT.get(rel);
    return readFileSync(path.join(ROOT, rel), 'utf8');
}

function readServer(rel) {
    if (OVERRIDE_SERVER.has(rel)) return OVERRIDE_SERVER.get(rel);
    return readFileSync(path.join(SERVER, rel), 'utf8');
}

/** 绝对路径 → 内容（同样支持覆盖），供"全仓扫描"用。 */
function readAny(abs) {
    const serverRel = path.relative(SERVER, abs).replace(/\\/g, '/');
    if (!serverRel.startsWith('..')) return readServer(serverRel);
    return readClient(path.relative(ROOT, abs).replace(/\\/g, '/'));
}

function exists(dir) {
    try {
        statSync(dir);
        return true;
    } catch {
        return false;
    }
}

/** 注释行（Java/Kotlin/TS 的 `*` / `//`、shell 的 `#`、HTML 的 `<!--`）。 */
function isCommentLine(trimmed) {
    return (
        trimmed.startsWith('*') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('<!--')
    );
}

// ---------------------------------------------------------------- A + B：Service 层的一票否决

const SERVER_APP = 'wise-deopt-application/src/main/java/com/huicang/wise/application';

/**
 * 三条"会造成实际效果"的入口：每一条都必须带**对应用途**的票据。
 *
 * 用途写死在这里而不是"随便有个 enforce 就行"：跨用途注入过一次（拿登录票据去删用户）
 * 就是一次越权，而那是运行时才看得出来的事。
 */
const EFFECT_ENTRIES = [
    {
        name: 'auth.login → LOGIN',
        file: `${SERVER_APP}/auth/AuthApplicationService.java`,
        method: 'login',
        purpose: 'HumanPurpose.LOGIN',
    },
    {
        name: 'tag.batchBind → TAG_BATCH_BIND',
        file: `${SERVER_APP}/tag/TagApplicationService.java`,
        method: 'batchBindTags',
        purpose: 'HumanPurpose.TAG_BATCH_BIND',
    },
    {
        name: 'user.deleteWithVerify → USER_DELETE',
        file: `${SERVER_APP}/user/UserApplicationService.java`,
        method: 'deleteUserWithVerify',
        purpose: 'HumanPurpose.USER_DELETE',
    },
];

/** 方法里**第一条可执行语句**（跳过注释、空行与花括号）。 */
function firstStatementOf(text, method) {
    const lines = text.split('\n');
    const pattern = new RegExp(`\\b${method}\\s*\\(`);
    const sigIndex = lines.findIndex((line) => pattern.test(line) && !isCommentLine(line.trim()));
    if (sigIndex < 0) return null;
    let i = sigIndex;
    while (i < lines.length && !lines[i].includes('{')) i += 1;
    i += 1;
    for (; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed === '' || trimmed === '{' || trimmed === '}' || isCommentLine(trimmed)) continue;
        return { text: trimmed, line: i + 1 };
    }
    return null;
}

/**
 * 守卫之前允许出现的调用**只有纯输入校验**那几种。
 *
 * 为什么不直接要求"守卫必须是第一条语句"：`login` 在守卫之前先判"用户名/口令为空"并抛
 * `VAL_*` —— 那是**一个 HTTP 往返都不花**的纯形状检查，把它挪到守卫后面并不更安全，
 * 只会让"先拒畸形请求"这个习惯消失。
 *
 * 真正要禁的是"守卫之前已经碰过外部世界"：任何 mapper / cache / 远程调用出现在守卫前面，
 * 都意味着**没票据的请求已经在产生效果或消耗配额**了。
 */
const PURE_VALIDATION_CALLS = [
    /request\.get[A-Za-z]+\(\)/g,
    /isBlank\(\)/g,
    /BusinessException\(/g,
    /ErrorCode\.VAL_[A-Z_]+/g,
    /\.getMessage\(\)/g,
];

function foreignCallsBefore(text, method, marker) {
    const lines = text.split('\n');
    const pattern = new RegExp(`\\b${method}\\s*\\(`);
    const sigIndex = lines.findIndex((line) => pattern.test(line) && !isCommentLine(line.trim()));
    if (sigIndex < 0) return null;
    const markerIndex = lines.findIndex((line, index) => index > sigIndex && line.includes(marker));
    if (markerIndex < 0) return null;
    // 从签名的 `{` 之后开始算（签名本身当然含方法名，那不是"调用"）
    let bodyStart = sigIndex;
    while (bodyStart < markerIndex && !lines[bodyStart].includes('{')) bodyStart += 1;
    const region = lines
        .slice(bodyStart + 1, markerIndex)
        .filter((line) => !isCommentLine(line.trim()))
        .join('\n');
    let residue = region;
    for (const pattern of PURE_VALIDATION_CALLS) {
        residue = residue.replace(pattern, ' ');
    }
    const calls = [...residue.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map((m) => m[1]);
    // 剩下的花括号/关键字都会出现在 `if (…)` 里，`if`/`new` 不是调用
    return calls.filter((name) => !['if', 'new', 'while', 'for', 'switch', 'catch'].includes(name));
}

function checkEnforcement() {
    for (const entry of EFFECT_ENTRIES) {
        let text;
        try {
            text = readServer(entry.file);
        } catch (e) {
            fail('A', `${entry.name}：读不到 ${entry.file}（${e.message}）`);
            continue;
        }
        const first = firstStatementOf(text, entry.method);
        if (!first) {
            fail('A', `${entry.name}：在 ${entry.file} 里找不到方法 ${entry.method}(...) 的第一条语句`);
            continue;
        }
        if (!text.includes('enforce(')) {
            fail('A', `${entry.name}：${entry.file} 里没有 enforce() —— 没有守卫的效果入口就是"谁都能做"`);
            continue;
        }
        const foreign = foreignCallsBefore(text, entry.method, 'enforce(');
        if (foreign === null) {
            fail('A', `${entry.name}：在 ${entry.method} 里找不到 enforce() 调用`);
            continue;
        }
        if (foreign.length > 0) {
            fail(
                'A',
                `${entry.name}：守卫**之前**已经有对外调用了 —— ${foreign.map((c) => `${c}()`).join(' / ')}。\n` +
                    '     守卫前面只允许"判空并抛 VAL_*"这类不花 HTTP 往返的形状检查：' +
                    '任何 mapper / cache / 远程调用出现在它前面，都意味着没票据的请求已经在产生效果。',
            );
        }
        const enforceLine = text.split('\n').find((line) => line.includes('enforce(')) ?? '';
        if (!enforceLine.includes(entry.purpose)) {
            fail('A', `${entry.name}：校验的用途不对 —— 期望 ${entry.purpose}，实得 \`${enforceLine.trim()}\``);
        }
        const enforceCount = (text.match(/\.enforce\(/g) ?? []).length;
        if (enforceCount !== 1) {
            fail('A', `${entry.name}：${entry.file} 里出现了 ${enforceCount} 次 enforce()（期望 1 次）`);
        }
    }

    // B：缺失即失败 —— 禁止"没传就跳过"那个形状
    //
    // 正则刻意允许括号（`request.getHumanToken()` 里就有一对）：不能写成 `[^)]*`，
    // 那会被 getter 自己的 `)` 截断，于是"真造出这个 bug 时门禁反而不红"。
    const OPTIONAL_GUARD =
        /(?:if|while)\s*\(.*[hH]umanToken.*(!=\s*null|==\s*null|!=\s*undefined|==\s*undefined|!==\s*undefined)/;
    const OPTIONAL_PATHS = [
        ...EFFECT_ENTRIES.map((e) => e.file),
        'apps/web/src/components/useHumanVerify.ts',
        'apps/web/src/components/HumanVerifyField.vue',
        'apps/web/src/views/LoginView.vue',
    ];
    for (const rel of OPTIONAL_PATHS) {
        let text;
        try {
            text = rel.endsWith('.java') ? readServer(rel) : readClient(rel);
        } catch {
            continue;
        }
        text.split('\n').forEach((line, index) => {
            if (isCommentLine(line.trim())) return;
            if (OPTIONAL_GUARD.test(line)) {
                fail(
                    'B',
                    `${rel}:${index + 1} 出现了"没传就跳过"的形状：\`${line.trim()}\`\n` +
                        '     这正是当初图形验证码失守的写法（`if (captchaId != null && captchaCode != null)`）。',
                );
            }
        });
    }
}

// ---------------------------------------------------------------- C：一个效果，一条路径

function checkNoUnguardedTwins() {
    const API = 'wise-deopt-api/src/main/java/com/huicang/wise/api/controller';
    const user = readServer(`${API}/UserController.java`);
    if (/@DeleteMapping/.test(user)) {
        fail(
            'C',
            'UserController 又出现了 @DeleteMapping —— 删除用户只能有 POST /{userId}/delete 一条路径（那条 DELETE 曾是无守卫的孪生）',
        );
    }
    const deleteMappingCount = (user.match(/@PostMapping\("\/\{userId\}\/delete"\)/g) ?? []).length;
    if (deleteMappingCount !== 1) {
        fail('C', `UserController 的 POST /{userId}/delete 映射出现 ${deleteMappingCount} 次（期望 1 次）`);
    }

    const tag = readServer(`${API}/TagController.java`);
    const tagCode = tag
        .split('\n')
        .filter((line) => !isCommentLine(line.trim()))
        .join('\n');
    if (/with-captcha/.test(tagCode)) {
        fail('C', 'TagController 又出现了 with-captcha 路径：同一效果的第二条路径就是绕过守卫的那条');
    }
    const batchBindCount = (tagCode.match(/@PostMapping\("\/batch-bind"\)/g) ?? []).length;
    if (batchBindCount !== 1) {
        fail('C', `TagController 的 POST /batch-bind 映射出现 ${batchBindCount} 次（期望 1 次）`);
    }

    // 全仓再扫一遍"带守卫的孪生"命名习惯：`xxx-with-captcha` / `xxx-with-verify`
    // （只看映射注解那一行，注释里提"当初删过什么"不算违反）
    for (const file of walk(path.join(SERVER, API))) {
        const text = readAny(file);
        text.split('\n').forEach((line, index) => {
            if (isCommentLine(line.trim())) return;
            const match = /@(?:Post|Put|Delete|Get)Mapping\("([^"]*with-(?:captcha|verify)[^"]*)"\)/.exec(line);
            if (match) {
                fail(
                    'C',
                    `${path.relative(SERVER, file)}:${index + 1}：映射 "${match[1]}" 把"带守卫"写进了路径 —— ` +
                        '守卫属于业务效果本身，不属于某一条路径。',
                );
            }
        });
    }
}

// ---------------------------------------------------------------- D：图形验证码必须彻底消失

function checkCaptchaGone() {
    const scan = [
        ...CLIENT_SCAN_DIRS.flatMap((rel) => walk(path.join(ROOT, rel))),
        ...walk(path.join(SERVER, 'wise-deopt-common/src/main/java')),
        ...walk(path.join(SERVER, 'wise-deopt-domain/src/main/java')),
        ...walk(path.join(SERVER, 'wise-deopt-infrastructure/src/main/java')),
        ...walk(path.join(SERVER, `${SERVER_APP}`)),
        ...walk(path.join(SERVER, 'wise-deopt-api/src/main/java')),
    ];
    let hits = 0;
    for (const file of scan) {
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        const serverRel = path.relative(SERVER, file).replace(/\\/g, '/');
        const key = rel.startsWith('..') ? serverRel : rel;
        if (ALLOWED_CAPTCHA_FILES.has(key)) continue;
        const text = readAny(file);
        text.split('\n').forEach((line, index) => {
            if (isCommentLine(line.trim())) return;
            if (/captcha/i.test(line)) {
                hits += 1;
                fail('D', `${key}:${index + 1} 生产代码里仍有 captcha：\`${line.trim().slice(0, 120)}\``);
            }
        });
    }
    for (const [file, why] of ALLOWED_CAPTCHA_FILES) {
        note(`captcha 例外：${file} —— ${why}`);
    }
    if (hits === 0) note('生产代码里 captcha 出现 0 次（例外见上，均为"登记删除/反证不存在"）');
}

// ---------------------------------------------------------------- E：声明即承诺（两个壳）

function checkShells() {
    const SHIPS = [
        {
            name: '桌面壳',
            capability: 'apps/desktop/src/bridgeProcess.ts',
            capabilityPattern: /human\.verify'/,
            portWiring: 'bridge/host-desktop/src/main/kotlin/com/huicang/wise/bridge/host/desktop/Main.kt',
            portWiringPattern: /humanVerifyPort\s*=/,
            implementation: 'bridge/host-desktop/src/main/kotlin/com/huicang/wise/bridge/host/desktop/DesktopEvidenceChannel.kt',
            evidenceSource: 'apps/desktop/src/humanVerify.ts',
        },
        {
            name: '安卓壳',
            capability: 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/ShellBridge.kt',
            capabilityPattern: /BridgeCapabilities\.HUMAN_VERIFY/,
            portWiring: 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/ShellBridge.kt',
            portWiringPattern: /humanVerifyPort\s*=\s*AndroidEvidence\(/,
            implementation: 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/AndroidEvidence.kt',
            evidenceSource: 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/AndroidEvidence.kt',
        },
    ];
    for (const shell of SHIPS) {
        const read = (rel) => (rel.startsWith('apps/') || rel.startsWith('packages/') ? readClient(rel) : readClient(rel));
        const capabilityText = read(shell.capability);
        if (!shell.capabilityPattern.test(capabilityText)) {
            fail('E', `${shell.name}：没有声明 human.verify 能力（${shell.capability}）`);
        }
        const wiringText = read(shell.portWiring);
        if (!shell.portWiringPattern.test(wiringText)) {
            fail(
                'E',
                `${shell.name}：声明了 human.verify，但 ${shell.portWiring} 里没有把证据来源接上 —— ` +
                    '"声明即承诺"：声明了就会画出按钮，按钮点下去必须真有证据。',
            );
        }
        const implText = read(shell.implementation);
        if (!/HumanVerifyPort/.test(implText)) {
            fail('E', `${shell.name}：${shell.implementation} 没有实现 HumanVerifyPort`);
        }
        const evidenceText = read(shell.evidenceSource);
        for (const field of ['shellPackaged', 'debugAttached']) {
            if (!new RegExp(`\\b${field}\\b`).test(evidenceText)) {
                fail('E', `${shell.name}：${shell.evidenceSource} 没有上报壳侧事实 ${field}`);
            }
        }
    }
}

// ---------------------------------------------------------------- F：证据字段白名单（双向）

function checkEvidenceWhitelist() {
    let dto;
    try {
        dto = readServer(`${SERVER_APP}/human/HumanEvidence.java`);
    } catch (e) {
        fail('F', `读不到服务端 HumanEvidence（${e.message}）`);
        return;
    }
    const serverFields = new Set(
        [...dto.matchAll(/private\s+[A-Za-z<>.]+\s+([a-zA-Z]+)\s*;/g)].map((m) => m[1]),
    );

    const page = readClient('apps/web/src/components/humanEvidence.ts');
    const pageFields = new Set();
    for (const match of page.matchAll(/readonly\s+([a-zA-Z]+)\??:/g)) pageFields.add(match[1]);
    for (const match of page.matchAll(/evidence\.([a-zA-Z]+)\s*=/g)) pageFields.add(match[1]);
    for (const match of page.matchAll(/^\s{4}([a-zA-Z]+):/gm)) {
        // snapshot() 里直接返回的三个统计量
        if (['gestureSamples', 'gestureDurationMs', 'maxJumpPx'].includes(match[1])) pageFields.add(match[1]);
    }

    // F1：页面只许报"它看得见"的事实
    const SHELL_ONLY = ['shellPackaged', 'debugAttached'];
    for (const field of SHELL_ONLY) {
        if (pageFields.has(field)) {
            fail(
                'F',
                `页面证据里出现了 ${field} —— 那是**壳**才有的事实。页面能报它，就等于页面能替壳作证，` +
                    '而壳的证据正是"页面伪造不了"的那部分。',
            );
        }
    }
    // F2：页面报的字段，服务端必须真的收得到（Jackson 会悄悄丢掉 DTO 里没有的字段）
    for (const field of pageFields) {
        if (!serverFields.has(field)) {
            fail(
                'F',
                `页面在采 ${field}，但服务端 HumanEvidence 里没有这个字段 —— Jackson 会把它丢掉，` +
                    '于是"页面采了、服务端看不见"，而所有测试仍然全绿。',
            );
        }
    }
    // F3：服务端声明的字段必须都有生产者（不许有"声明但没人写"的字段）
    const CLIENT_ONLY = ['version', 'platform', 'clientVersion'];
    const producerText = [
        page,
        readClient('apps/desktop/src/humanVerify.ts'),
        readClient('apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/AndroidEvidence.kt'),
        readClient('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/HumanVerifyCollector.kt'),
    ].join('\n');
    for (const field of serverFields) {
        if (CLIENT_ONLY.includes(field)) continue;
        if (!new RegExp(`\\b${field}\\b`).test(producerText)) {
            fail('F', `服务端声明了 ${field}，但客户端没有任何地方上报它（"声明即承诺"的反面：声明了却没人写）`);
        }
    }

    // F4：页面证据不许引入外部 SDK（指纹库就是"本地环境验证"变成"指纹追踪"的那一步）
    const WEB_FILES = [
        'apps/web/src/components/humanEvidence.ts',
        'apps/web/src/components/useHumanVerify.ts',
        'apps/web/src/components/HumanVerifyField.vue',
    ];
    for (const rel of WEB_FILES) {
        const text = readClient(rel);
        for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
            const source = match[1];
            const internal =
                source.startsWith('.') ||
                source === 'vue' ||
                source === 'element-plus' ||
                source.startsWith('@element-plus/') ||
                source.startsWith('@wise/');
            if (!internal) {
                fail('F', `${rel} 引入了外部模块 '${source}' —— 人机验证的证据只许来自本仓与运行时自身`);
            }
        }
    }
}

// ---------------------------------------------------------------- G：票据不许进页面

function checkTicketNeverInPage() {
    const collector = readClient('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/HumanVerifyCollector.kt');
    if (!/HumanTokenHolder/.test(collector) || !/tokens\.put\(/.test(collector)) {
        fail('G', 'HumanVerifyCollector 里找不到"票据存进 HumanTokenHolder"的那一步 —— 票据必须有唯一持有者');
    }
    const dispatcher = readClient('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeDispatcher.kt');
    const start = dispatcher.indexOf('BridgeBuiltins.HUMAN_VERIFY ->');
    if (start < 0) {
        fail('G', 'BridgeDispatcher 里找不到 bridge.humanVerify 的内建分支');
    } else {
        const branch = dispatcher.slice(start, dispatcher.indexOf('\n            else ->', start));
        if (/humanToken/i.test(branch)) {
            fail('G', 'bridge.humanVerify 的应答里带上了 humanToken —— 票据一旦回给页面，一次 XSS 就能拿它去删用户');
        }
    }
    for (const rel of ['apps/web/src/components/useHumanVerify.ts', 'apps/web/src/components/HumanVerifyField.vue']) {
        const text = readClient(rel);
        if (/humanToken/.test(text.split('\n').filter((l) => !isCommentLine(l.trim())).join('\n'))) {
            fail('G', `${rel} 的代码里出现了 humanToken —— 页面不该知道票据的存在`);
        }
    }
    // 契约侧：人机验证两条，图形码零条
    const contract = readClient('packages/contract/src/generated/bridgeContract.ts');
    const humanCount = (contract.match(/id: 'human\./g) ?? []).length;
    if (humanCount !== 2) {
        fail('G', `契约里 human.* 方法有 ${humanCount} 条（期望 2 条：human.challenge / human.verify）`);
    }

    /*
     * 失败原因不许被折叠。
     *
     * 2026-10-05 实测：后端没部署新代码时 `/api/human/challenge` 回 400，
     * 而桥把**所有**失败都回成 `BRIDGE_BACKEND_UNREACHABLE` + "请再试一次" ——
     * 于是"去重新部署后端"这个唯一正确的动作被藏掉了，用户只会一直点重试。
     * 所以：调度器必须用收集器带出来的 `code`（服务端错误码优先），
     * 并且收集器必须真的区分"没拿到挑战 / 服务端拒绝"两类。
     */
    const humanCalls = (dispatcher.match(/collector\.obtain\(/g) ?? []).length;
    if (humanCalls !== 1) {
        fail('G', `BridgeDispatcher 里 collector.obtain( 出现 ${humanCalls} 次（期望 1 次）`);
    }
    if (!/outcome\.code/.test(dispatcher)) {
        fail(
            'G',
            'BridgeDispatcher 的人机验证分支没有使用 `outcome.code` —— 失败原因被折叠了。\n' +
                '     界面必须能区分「后端不是最新版（HTTP-400）」「服务端拒绝（AUTH-HUMAN-xxxx）」，' +
                '否则用户只会原地重试。',
        );
    }
    const collectorOutcome = readClient('bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/HumanVerifyCollector.kt');
    for (const key of ['KEY_CHALLENGE_FAILED', 'KEY_REJECTED']) {
        if (!collectorOutcome.includes(`const val ${key}`)) {
            fail('G', `HumanVerifyCollector 里缺少 ${key}：失败原因必须分类，不能只有一个"验证失败"`);
        }
    }
}

// ---------------------------------------------------------------- 主流程

/** 跑完全部检查，返回本次结果（不打印 —— `--selftest` 要靠它判定"红了没有"）。 */
function runAll() {
    failures.length = 0;
    notes.length = 0;
    checkEnforcement();
    checkNoUnguardedTwins();
    checkCaptchaGone();
    checkShells();
    checkEvidenceWhitelist();
    checkTicketNeverInPage();
    return { failures: [...failures], notes: [...notes] };
}

/**
 * `--selftest`：把当年那几种坏法在内存里逐个造出来，断言对应检查项**真的会红**。
 *
 * 每条 `apply` 都改 real 文件的内容（只是不落盘）。判定标准是"出现了期望的那一项失败"，
 * 而不是"随便红了一处" —— 否则一条只会全红的门禁也能骗过自检。
 */
const MUTATIONS = [
    {
        check: 'B',
        name: '守卫写成"没传就跳过"（当年图形码的写法）',
        target: 'server',
        file: `${SERVER_APP}/auth/AuthApplicationService.java`,
        apply: (text) =>
            text.replace(
                /humanVerifyApplicationService\.enforce\(request\.getHumanToken\(\), HumanPurpose\.LOGIN\);/,
                'if (request.getHumanToken() != null) {\n            humanVerifyApplicationService.enforce(request.getHumanToken(), HumanPurpose.LOGIN);\n        }',
            ),
    },
    {
        check: 'A',
        name: '守卫之前先碰了数据库（没票据的请求已经在产生效果）',
        target: 'server',
        file: `${SERVER_APP}/tag/TagApplicationService.java`,
        apply: (text) =>
            text.replace(
                /humanVerifyApplicationService\.enforce\(request\.getHumanToken\(\), HumanPurpose\.TAG_BATCH_BIND\);/,
                'tagMapper.countByCondition(null);\n        humanVerifyApplicationService.enforce(request.getHumanToken(), HumanPurpose.TAG_BATCH_BIND);',
            ),
    },
    {
        check: 'C',
        name: '无守卫的孪生端点回来了（DELETE /api/users/{id}）',
        target: 'server',
        file: 'wise-deopt-api/src/main/java/com/huicang/wise/api/controller/UserController.java',
        apply: (text) => `${text}\n// @DeleteMapping("/{userId}")\n@DeleteMapping("/{userId}")\npublic void deleteUser() {}\n`,
    },
    {
        check: 'E',
        name: '壳声明了 human.verify 却没实现（声明即承诺的反面）',
        target: 'client',
        file: 'apps/mobile/shell/src/main/kotlin/com/huicang/wise/client/shell/ShellBridge.kt',
        apply: (text) => text.replace('BridgeCapabilities.HUMAN_VERIFY,', ''),
    },
    {
        check: 'F',
        name: '页面采了 maxJumpPx，而服务端 DTO 里没有这个字段（Jackson 会悄悄丢掉）',
        target: 'server',
        file: `${SERVER_APP}/human/HumanEvidence.java`,
        apply: (text) => text.replace('private Integer maxJumpPx;', 'private Integer unusedField;'),
    },
    {
        check: 'G',
        name: '票据被回给了页面（一次 XSS 就能拿它去删用户）',
        target: 'client',
        file: 'bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeDispatcher.kt',
        apply: (text) =>
            text.replace(
                '"purpose" to JsonPrimitive(purpose),',
                '"purpose" to JsonPrimitive(purpose),\n                                "humanToken" to JsonPrimitive("leaked"),',
            ),
    },
    {
        check: 'G',
        name: '失败原因被折叠成「后端不可达 + 请再试一次」（2026-10-05 用户实际遇到的那次）',
        target: 'client',
        file: 'bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeDispatcher.kt',
        apply: (text) =>
            text.replace(
                'outcome.code ?: BridgeErrorCodes.BACKEND_UNREACHABLE,\n                        outcome.messageKey ?: HumanVerifyCollector.KEY_FAILED,',
                'BridgeErrorCodes.BACKEND_UNREACHABLE,\n                        "bridge.humanVerifyFailed",',
            ),
    },
];

function selfTest() {
    if (!exists(SERVER)) {
        console.error(`✗ 读不到服务端仓：${SERVER}`);
        process.exit(1);
    }
    let failed = 0;
    for (const mutation of MUTATIONS) {
        const map = mutation.target === 'server' ? OVERRIDE_SERVER : OVERRIDE_CLIENT;
        const before = map.has(mutation.file) ? map.get(mutation.file) : readFileSync(
            path.join(mutation.target === 'server' ? SERVER : ROOT, mutation.file),
            'utf8',
        );
        const mutated = mutation.apply(before);
        if (mutated === before) {
            console.log(`  ✗ [${mutation.check}] 造不出这种坏法：${mutation.name}\n      ${mutation.file} 的锚点没匹配上（文件改过？）`);
            failed += 1;
            continue;
        }
        map.set(mutation.file, mutated);
        const result = runAll();
        map.delete(mutation.file);
        const hit = result.failures.some((item) => item.check === mutation.check);
        if (hit) {
            console.log(`  ✓ [${mutation.check}] 变红 —— ${mutation.name}`);
        } else {
            console.log(
                `  ✗ [${mutation.check}] 没红 —— ${mutation.name}\n` +
                    `      ${mutation.file} 被弄坏后，检查项 ${mutation.check} 仍然通过：这条门禁守不住它。`,
            );
            failed += 1;
        }
    }
    console.log(`check-human-verify 自检：${MUTATIONS.length - failed}/${MUTATIONS.length} 种坏法都能被抓住`);
    process.exit(failed === 0 ? 0 : 1);
}

function main() {
    if (!exists(SERVER)) {
        console.error(
            `✗ 读不到服务端仓：${SERVER}\n` +
                '  本门禁要同时看客户端与服务端（守卫写在服务端）。\n' +
                '  跨仓时必须红，不许跳过 —— 跳过等于"这条纪律在 CI 上从未被执行过"。',
        );
        process.exit(1);
    }

    if (process.argv.includes('--selftest')) {
        selfTest();
        return;
    }

    const result = runAll();

    for (const text of result.notes) console.log(`  · ${text}`);
    if (result.failures.length > 0) {
        console.error(`\ncheck-human-verify FAIL：${result.failures.length} 项违反`);
        let lastCheck = '';
        for (const item of result.failures) {
            if (item.check !== lastCheck) {
                console.error(`\n[${item.check}]`);
                lastCheck = item.check;
            }
            console.error(`  ✗ ${item.detail}`);
        }
        process.exit(1);
    }
    console.log('check-human-verify OK：入口守卫 / 无孪生路径 / 图形码已删 / 两个壳声明即实现 / 证据白名单 / 票据不出桥');
}

main();
