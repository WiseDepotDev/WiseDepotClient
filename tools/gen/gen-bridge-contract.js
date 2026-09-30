#!/usr/bin/env node
/**
 * gen-bridge-contract.js —— 从服务端控制器生成**桥方法契约**（W0）。
 *
 * 为什么要有它（STD-CONTRACT-03 契约单一来源）：
 *   Web UI 与原生壳之间唯一的契约是 WebSocket 方法表。如果让前端手抄 190+ 条
 *   "路径 → 方法名 → packet_type"，必然漂移；而"哪个接口用哪个 packet_type"
 *   只有服务端知道（控制器方法上的 `@ApiPacketType(PacketType.X)`）。
 *   因此方法表**服务端扫描生成**，一次产出两份制品：
 *     - Kotlin：bridge/protocol/.../BridgeContract.kt（壳侧白名单 + 路由表）
 *     - TS    ：packages/contract/src/generated/bridgeContract.ts（Web 侧类型 + 常量）
 *
 * 与旧仓 gen-packet-types.js 的关系：
 *   路由扫描规则**逐条沿用**（同一套 path 归一化与 conditional 判定），
 *   区别只在"出口"：旧版只产 Kotlin 的 packet_type 映射，本脚本产桥的方法契约。
 *
 * 用法：
 *   node tools/gen/gen-bridge-contract.js                     # 生成/覆盖两份制品
 *   node tools/gen/gen-bridge-contract.js --check             # 只校验（漂移即退出 1）
 *   node tools/gen/gen-bridge-contract.js --print             # 打印 Kotlin 制品到 stdout
 *   node tools/gen/gen-bridge-contract.js --report            # 只打印覆盖率统计
 *   node tools/gen/gen-bridge-contract.js --check \
 *        --verify-legacy <PacketTypeMap.kt>                   # 与旧仓生成物交叉校验
 *
 * 交叉校验为什么重要：它证明"新桥看到的路由集合"与"旧 APP 看到的路由集合"逐条一致，
 * 也就是证明重构没有在契约层偷偷丢接口或改 packet_type。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 路径

const GEN_DIR = __dirname;
const CLIENT_ROOT = path.resolve(GEN_DIR, '..', '..');
const WORKSPACE_ROOT = path.resolve(CLIENT_ROOT, '..');
const SERVER_ROOT = path.join(WORKSPACE_ROOT, 'WiseDeoptServer');
const CONTROLLER_DIR = path.join(
    SERVER_ROOT, 'wise-deopt-api', 'src', 'main', 'java', 'com', 'huicang', 'wise', 'api', 'controller');

const OUT_KOTLIN = path.join(
    CLIENT_ROOT, 'bridge', 'protocol', 'src', 'main', 'kotlin',
    'com', 'huicang', 'wise', 'bridge', 'protocol', 'BridgeContract.kt');
const OUT_TS = path.join(CLIENT_ROOT, 'packages', 'contract', 'src', 'generated', 'bridgeContract.ts');
const OVERLAY_FILE = path.join(GEN_DIR, 'bridge-overlay.json');

const ARGV = process.argv.slice(2);
const MODE = ARGV.includes('--check') ? 'check'
    : ARGV.includes('--print') ? 'print'
        : ARGV.includes('--report') ? 'report'
            : 'write';
const LEGACY_FILE = (() => {
    const i = ARGV.indexOf('--verify-legacy');
    return i >= 0 && ARGV[i + 1] ? path.resolve(process.cwd(), ARGV[i + 1]) : null;
})();

// ---------------------------------------------------------------- 控制器扫描
// （规则与 WiseDeoptServer/tools/gen/gen-packet-types.js 逐条一致）

/** 会被误当成路径的注解属性名 */
const NON_PATH_ATTR = /^(params|produces|consumes|headers|name)$/;

function stringsIn(fragment) {
    const out = [];
    const re = /"([^"]*)"/g;
    let m;
    while ((m = re.exec(fragment)) !== null) {
        out.push(m[1]);
    }
    return out;
}

/** 从注解括号内容里取路径 */
function extractPaths(argText) {
    const text = (argText || '').trim();
    if (!text) {
        return [];
    }
    const attr = /(?:^|[,(\s])(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(text);
    if (attr) {
        return stringsIn(attr[1]);
    }
    const firstAttr = text.search(/[A-Za-z_$][\w$]*\s*=/);
    const head = firstAttr >= 0 ? text.slice(0, firstAttr) : text;
    if (/^\s*(\{|")/.test(head)) {
        return stringsIn(head);
    }
    if (NON_PATH_ATTR.test(text.split('=')[0].trim())) {
        return [];
    }
    return [];
}

/** `{id:\\d+}` → `{id}`；去尾斜杠 */
function normalizePath(p) {
    let out = (p || '').replace(/\{([^}:]+)[^}]*\}/g, '{$1}');
    if (out.length > 1 && out.endsWith('/')) {
        out = out.slice(0, -1);
    }
    return out;
}

function joinPath(base, sub) {
    const b = base === '/' ? '' : base;
    const s = sub === '/' ? '' : sub;
    const joined = `${b}${s}`;
    const out = joined.startsWith('/') ? joined : `/${joined}`;
    return normalizePath(out);
}

/** 扫描控制器目录，产出 [{method, path, packetType, conditional}]（未合并） */
function collectRoutes() {
    const routes = [];
    const files = fs.readdirSync(CONTROLLER_DIR).filter((f) => f.endsWith('.java')).sort();

    for (const file of files) {
        const text = fs.readFileSync(path.join(CONTROLLER_DIR, file), 'utf8');
        const classMapping = /@RequestMapping\s*\(([\s\S]*?)\)/.exec(text);
        const bases = classMapping ? extractPaths(classMapping[1]) : [];
        const baseList = bases.length > 0 ? bases : [''];

        const re = /@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\(([\s\S]*?)\))?/g;
        let prevEnd = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const declSegment = text.slice(prevEnd, m.index);
            prevEnd = m.index + m[0].length;

            const pkt = /@ApiPacketType\s*\(\s*PacketType\.([A-Z0-9_]+)\s*\)/.exec(declSegment);
            const packetType = pkt ? pkt[1] : 'UNKNOWN';

            // 同一 method+path 的多条：带 params/headers/consumes/produces 条件的排在后面
            const conditional = /(?:^|[,(\s])(params|headers|consumes|produces)\s*=/.test(m[2] || '');

            const method = m[1].toUpperCase();
            const subs = m[2] === undefined ? [] : extractPaths(m[2]);
            const subList = subs.length > 0 ? subs : [''];

            // 方法签名里是否用了 @RequestParam（Spring 只从 query string / form body 取它）。
            // 从注解行往后扫到方法体的 `{` 为止；**不能**把注解行自己的 `{` 当结束符 ——
            // 路径模板 `/task/{taskId}/status` 里就有花括号，误判会漏掉全部带路径参数的端点。
            const tail = text.slice(m.index);
            const lines = tail.split('\n');
            let sig = '';
            for (let i = 0; i < Math.min(lines.length, 30); i += 1) {
                sig += lines[i] + '\n';
                if (i > 0 && (/^\s*\{/.test(lines[i]) || /;\s*$/.test(lines[i]))) {
                    break;
                }
            }
            const requestParams = [...sig.matchAll(/@RequestParam\b([^)]*)\)/g)].map((p) => {
                const named = /value\s*=\s*"([^"]+)"/.exec(p[1]) || /"([^"]+)"/.exec(p[1]);
                return named ? named[1] : '(取形参名)';
            });

            for (const base of baseList) {
                for (const sub of subList) {
                    routes.push({
                        method,
                        path: joinPath(base, sub),
                        packetType,
                        conditional,
                        requestParams: requestParams.length > 0 ? requestParams : undefined,
                    });
                }
            }
        }
    }
    return routes;
}

/** 合并同一 (method, path) 的多条记录：一个 HTTP 端点 = 一个桥方法 */
function mergeRoutes(routes) {
    const byKey = new Map();
    for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        const cur = byKey.get(key);
        if (!cur) {
            byKey.set(key, {
                method: r.method,
                path: r.path,
                // 无条件那条是主类型（与旧仓 resolve() 命中规则一致）
                packetType: r.conditional ? 'UNKNOWN' : r.packetType,
                primaryResolved: !r.conditional,
                packetTypes: new Set([r.packetType]),
                requestParams: r.requestParams,
            });
            continue;
        }
        cur.packetTypes.add(r.packetType);
        if (r.requestParams && !cur.requestParams) {
            cur.requestParams = r.requestParams;
        }
        if (!r.conditional && !cur.primaryResolved) {
            cur.packetType = r.packetType;
            cur.primaryResolved = true;
        }
    }
    // 兜底：整组都是条件分支时，取排序后的第一条当主类型（保证确定性）
    for (const r of byKey.values()) {
        if (!r.primaryResolved) {
            r.packetType = [...r.packetTypes].sort()[0];
        }
        delete r.primaryResolved;
        r.packetTypes = [...r.packetTypes].sort();
    }
    return [...byKey.values()].sort((a, b) => {
        const ka = `${a.path} ${a.method}`;
        const kb = `${b.path} ${b.method}`;
        return ka.localeCompare(kb);
    });
}

// ---------------------------------------------------------------- 命名

const VERB_BY_METHOD = { GET: 'list', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const isParam = (seg) => seg.startsWith('{') && seg.endsWith('}');

/** `stock-orders` → `stockOrders` */
function camel(seg) {
    const parts = seg.split(/[-_]/).filter(Boolean);
    if (parts.length === 0) {
        return seg;
    }
    return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** `inventoryId` → `InventoryId` */
function pascal(seg) {
    const c = camel(seg);
    return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * 机械派生的方法 id。
 *
 * 规则：`<namespace>.<字面段驼峰，点连接>.<byParam…>`
 *   /api/inventories                    GET  → inventory.list          （无字面段时按 HTTP 方法取动词）
 *   /api/inventories/{inventoryId}      GET  → inventory.byInventoryId
 *   /api/inventories/{inventoryId}/lock POST → inventory.lock.byInventoryId
 * 机械名保证"永不缺失"，人工策展（overlay.aliases）负责把它改好看。
 */
function mechanicalId(route, overlay) {
    const segs = route.path.split('/').filter(Boolean);
    const rest = segs[0] === 'api' ? segs.slice(1) : segs;
    const rawNs = rest[0] || 'root';
    const namespace = overlay.namespaces[rawNs] || camel(rawNs);

    const tail = rest.slice(1);
    const literals = tail.filter((s) => !isParam(s)).map(camel);
    const params = tail.filter(isParam).map((s) => `by${pascal(s.slice(1, -1))}`);

    if (literals.length === 0) {
        literals.push(VERB_BY_METHOD[route.method] || 'invoke');
    }
    return [namespace, ...literals, ...params].join('.');
}

function buildContract() {
    const overlay = JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8'));
    const hidden = new Set(overlay.hidden || []);
    // `queryParams` 的 `_comment` 是给人看的说明，不是方法 id
    const queryIds = Object.fromEntries(
        Object.entries(overlay.queryParams || {}).filter(([k]) => !k.startsWith('_')),
    );
    const all = mergeRoutes(collectRoutes());

    const exposed = [];
    const excluded = [];
    const ids = new Map();
    /** `METHOD path` → 方法 id（反向检查用；`ids` 是按 id 索引的）。 */
    const byRouteKey = new Map();

    /** 有 body 的 HTTP 方法；其余（GET/DELETE）的参数本来就只能走 query string。 */
    const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

    for (const r of all) {
        const key = `${r.method} ${r.path}`;
        const alias = overlay.aliases[key];
        const id = alias || mechanicalId(r, overlay);
        const rawNs = (r.path.split('/').filter(Boolean)[0] === 'api'
            ? r.path.split('/').filter(Boolean)[1]
            : r.path.split('/').filter(Boolean)[0]) || 'root';
        const entry = {
            id,
            domain: overlay.domains[rawNs] || 'system',
            httpMethod: r.method,
            path: r.path,
            packetType: r.packetType,
            packetTypes: r.packetTypes,
            curated: Boolean(alias),
            namespace: overlay.namespaces[rawNs] || camel(rawNs),
            paramStyle: BODY_METHODS.has(r.method) && !(id in queryIds) ? 'body' : 'query',
            queryReason: queryIds[id],
            /** 服务端这个方法用到的 @RequestParam 名（无则 undefined）。 */
            requestParams: r.requestParams,
        };

        if (ids.has(id)) {
            throw new Error(`方法 id 冲突：${id}\n  ${ids.get(id).httpMethod} ${ids.get(id).path}\n  ${key}\n` +
                '处置：在 tools/gen/bridge-overlay.json 的 aliases 里给其中一条显式命名。');
        }
        ids.set(id, entry);
        byRouteKey.set(key, id);

        if (hidden.has(key)) {
            excluded.push(entry);
        } else {
            exposed.push(entry);
        }
    }

    exposed.sort((a, b) => a.id.localeCompare(b.id));
    excluded.sort((a, b) => a.id.localeCompare(b.id));

    // 仍然登记的隐藏项必须在 all 里真实存在（防止 overlay 写错路径而悄悄失效）
    for (const key of hidden) {
        if (!all.some((r) => `${r.method} ${r.path}` === key)) {
            throw new Error(`overlay.hidden 里的 "${key}" 在服务端路由中不存在（拼写错误或接口已删）。`);
        }
    }

    // queryParams 同样不许写错：拼错一个 id 就只是"这条悄悄没生效"，
    // 而症状表现为"某个按钮点了没反应"—— 正是最难查的那种。所以宁可生成期直接失败。
    for (const [id, reason] of Object.entries(queryIds)) {
        const entry = ids.get(id);
        if (!entry) {
            throw new Error(`overlay.queryParams 里的 "${id}" 不是任何已登记的方法 id（拼写错误？）。`);
        }
        if (!BODY_METHODS.has(entry.httpMethod)) {
            throw new Error(
                `overlay.queryParams 里的 "${id}" 是 ${entry.httpMethod}，其参数本来就走 query string，无需登记。`);
        }
        if (!reason || typeof reason !== 'string') {
            throw new Error(`overlay.queryParams 里的 "${id}" 缺少原因说明（写出服务端为什么只认 query）。`);
        }
    }

    // 反向检查：服务端**有** @RequestParam 的 POST/PUT/PATCH 端点，必须全部登记。
    // 只做正向校验的话，服务端新加一个 @RequestParam 就会悄悄多一条永远 400 的接口，
    // 而症状只是"某个按钮点了没反应" —— 这类问题必须在这里就被拦下。
    const missed = [];
    for (const r of all) {
        if (!r.requestParams || !BODY_METHODS.has(r.method)) {
            continue;
        }
        const id = byRouteKey.get(`${r.method} ${r.path}`);
        if (id && !(id in queryIds)) {
            missed.push(`  · ${id}  (${r.method} ${r.path})  @RequestParam: ${r.requestParams.join(', ')}`);
        }
    }
    if (missed.length > 0) {
        throw new Error(
            `服务端有 ${missed.length} 个 POST/PUT/PATCH 端点用 @RequestParam 取值，但没登记在 ` +
            'overlay.queryParams 里。\n不登记它们会永远 400（@RequestParam 不认 JSON body），' +
            '而界面上只表现为「点了没反应」：\n' + missed.join('\n') +
            '\n处置：在 tools/gen/bridge-overlay.json 的 queryParams 里补上方法 id 与原因。');
    }
    // 别名表同理
    for (const key of Object.keys(overlay.aliases)) {
        if (!all.some((r) => `${r.method} ${r.path}` === key)) {
            throw new Error(`overlay.aliases 里的 "${key}" 在服务端路由中不存在（拼写错误或接口已删）。`);
        }
    }

    return { overlay, all, exposed, excluded };
}

// ---------------------------------------------------------------- 渲染 Kotlin

function renderKotlin(contract) {
    const { exposed, excluded } = contract;
    const lines = [];
    const push = (...xs) => lines.push(...xs);

    push('// AUTO-GENERATED FROM WiseDeoptServer/wise-deopt-api/**/controller/*.java — DO NOT EDIT');
    push('// 生成器：WiseDepotClient/tools/gen/gen-bridge-contract.js（--check 只校验不写入）');
    push('// 策展层：WiseDepotClient/tools/gen/bridge-overlay.json（命名空间 / 域 / 别名 / 隐藏项）');
    push('//');
    push('// 这份表就是桥的**方法白名单**：不在表里的 method 一律被拒（BRIDGE_METHOD_UNKNOWN）。');
    push('// 桥不做通用 HTTP 透传，否则一次 Web 侧 XSS 就等于拿到任意后端接口。');
    push('package com.huicang.wise.bridge.protocol');
    push('');
    push('/**');
    push(' * 桥方法契约（协议 v3）。');
    push(' *');
    push(' * `id` 是 Web 侧调用时用的方法名；`httpMethod` + `path` 是壳侧转发到后端时用的路由；');
    push(' * `packetType` 是后端信封 `header.packet_type` 的取值（与旧 APP 的 PacketTypeMap 同源）。');
    push(' */');
    push('object BridgeContract {');
    push('    /** 本契约对应的协议版本。 */');
    push('    const val VERSION: Int = BridgeProtocol.VERSION');
    push('');
    push('    /** UI 一级域（信息架构的四域 + 系统域）。 */');
    push('    enum class Domain {');
    push('        OVERVIEW,');
    push('        INVENTORY,');
    push('        FIELD,');
    push('        ME,');
    push('        SYSTEM,');
    push('    }');
    push('');
    push('    /** 参数去哪：JSON 信封 body，还是 URL query string。 */');
    push('    enum class ParamStyle {');
    push('        /** 参数进 JSON 信封 body（多数 POST/PUT/PATCH）。 */');
    push('        BODY,');
    push('        /** 参数拼进 URL query string（GET/DELETE，以及服务端用 @RequestParam 的 POST/PUT）。 */');
    push('        QUERY,');
    push('    }');
    push('');
    push('    /** 单条桥方法。 */');
    push('    data class Method(');
    push('        /** 方法 id，如 `inventory.list`。 */');
    push('        val id: String,');
    push('        /** 归属的一级域。 */');
    push('        val domain: Domain,');
    push('        /** 后端 HTTP 方法。 */');
    push('        val httpMethod: String,');
    push('        /** 后端路径模板（`{...}` 段为路径参数）。 */');
    push('        val path: String,');
    push('        /** 主 packet_type（同一端点多条时取无条件那条）。 */');
    push('        val packetType: String,');
    push('        /** 方法名是否来自人工策展（否则为机械派生）。 */');
    push('        val curated: Boolean,');
    push('        /** 剩余参数的去向。QUERY 的方法**不发 body**。 */');
    push('        val paramStyle: ParamStyle,');
    push('    )');
    push('');
    push(`    /** 暴露给 Web 的方法共 ${exposed.length} 条。 */`);
    push('    val methods: List<Method> =');
    push('        listOf(');
    for (const m of exposed) {
        push(`            Method("${m.id}", Domain.${m.domain.toUpperCase()}, "${m.httpMethod}", "${m.path}", "${m.packetType}", ${m.curated}, ParamStyle.${m.paramStyle.toUpperCase()}),`);
    }
    push('        )');
    push('');
    push('    private val index: Map<String, Method> = methods.associateBy { it.id }');
    push('');
    push('    /** 按方法 id 查表；未登记返回 null（调用方转成 BRIDGE_METHOD_UNKNOWN）。 */');
    push('    fun find(id: String): Method? = index[id]');
    push('');
    push('    /** 某一级域下的全部方法。 */');
    push('    fun of(domain: Domain): List<Method> = methods.filter { it.domain == domain }');
    push('');
    push(`    /** 刻意不暴露给 Web 的路由（共 ${excluded.length} 条），仅用于文档与一致性校验。 */`);
    if (excluded.length === 0) {
        push('    val excluded: List<Method> = emptyList()');
    } else {
        push('    val excluded: List<Method> =');
        push('        listOf(');
        for (const m of excluded) {
            push(`            Method("${m.id}", Domain.${m.domain.toUpperCase()}, "${m.httpMethod}", "${m.path}", "${m.packetType}", ${m.curated}, ParamStyle.${m.paramStyle.toUpperCase()}),`);
        }
        push('        )');
    }
    push('}');
    push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------- 渲染 TypeScript

function renderTs(contract) {
    const { exposed, excluded } = contract;
    const domains = [...new Set(exposed.map((m) => m.domain))].sort();
    const httpMethods = [...new Set(exposed.map((m) => m.httpMethod))].sort();
    const lines = [];
    const push = (...xs) => lines.push(...xs);

    push('// AUTO-GENERATED FROM WiseDeoptServer/wise-deopt-api/**/controller/*.java — DO NOT EDIT');
    push('// 生成器：WiseDepotClient/tools/gen/gen-bridge-contract.js（--check 只校验不写入）');
    push('//');
    push('// 这是 Web 侧看到的**全部**可调用方法。壳侧白名单与本表同源，');
    push('// 因此前端调用 BRIDGE_METHOD_BY_ID 里没有的 id 一定是 bug，而不是运行时惊喜。');
    push('');
    push('export const BRIDGE_PROTOCOL_VERSION = 3 as const;');
    push('');
    push(`export const BRIDGE_DOMAINS = [${domains.map((d) => `'${d}'`).join(', ')}] as const;`);
    push('export type BridgeDomain = (typeof BRIDGE_DOMAINS)[number];');
    push('');
    push('export const BRIDGE_HTTP_METHODS = [' + httpMethods.map((m) => `'${m}'`).join(', ') + '] as const;');
    push('export type BridgeHttpMethod = (typeof BRIDGE_HTTP_METHODS)[number];');
    push('');
    push('export const BRIDGE_PARAM_STYLES = [\'body\', \'query\'] as const;');
    push('export type BridgeParamStyle = (typeof BRIDGE_PARAM_STYLES)[number];');
    push('');
    push('export interface BridgeMethod {');
    push('  /** 调用时使用的方法 id。 */');
    push('  readonly id: string;');
    push('  readonly domain: BridgeDomain;');
    push('  readonly httpMethod: BridgeHttpMethod;');
    push('  /** 后端路径模板，`{...}` 为路径参数。 */');
    push('  readonly path: string;');
    push('  readonly packetType: string;');
    push('  /** 方法名是否来自人工策展（否则机械派生）。 */');
    push('  readonly curated: boolean;');
    push('  /**');
    push('   * 剩余参数的去向：`body` = JSON 信封 body，`query` = URL query string。');
    push('   *');
    push('   * `query` 的方法**不发 body**。这一项存在的唯一原因是服务端有 10 个 POST/PUT 端点在用');
    push('   * `@RequestParam`（只认 query string），不登记就会永远 400。');
    push('   */');
    push('  readonly paramStyle: BridgeParamStyle;');
    push('}');
    push('');
    push(`/** 暴露给 Web 的方法共 ${exposed.length} 条。 */`);
    push('export const BRIDGE_METHODS = [');
    for (const m of exposed) {
        push(`  { id: '${m.id}', domain: '${m.domain}', httpMethod: '${m.httpMethod}', path: '${m.path}', packetType: '${m.packetType}', curated: ${m.curated}, paramStyle: '${m.paramStyle}' },`);
    }
    push('] as const satisfies readonly BridgeMethod[];');
    push('');
    push('export type BridgeMethodId = (typeof BRIDGE_METHODS)[number][\'id\'];');
    push('');
    push('export const BRIDGE_METHOD_IDS: readonly BridgeMethodId[] = BRIDGE_METHODS.map((m) => m.id);');
    push('');
    push('export const BRIDGE_METHOD_BY_ID = Object.fromEntries(');
    push('  BRIDGE_METHODS.map((m) => [m.id, m]),');
    push(') as unknown as Readonly<Record<BridgeMethodId, BridgeMethod>>;');
    push('');
    push(`/** 刻意不暴露给 Web 的路由（共 ${excluded.length} 条）。 */`);
    push(`export const BRIDGE_EXCLUDED_IDS: readonly string[] = [${excluded.map((m) => `'${m.id}'`).join(', ')}];`);
    push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------- 旧仓交叉校验

function parseLegacy(file) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /Entry\("([A-Z]+)",\s*"([^"]+)",\s*packetType\s*=\s*"([A-Z0-9_]+)"\)/g;
    const out = new Map();
    let m;
    while ((m = re.exec(text)) !== null) {
        const key = `${m[1]} ${m[2]}`;
        if (!out.has(key)) {
            out.set(key, new Set());
        }
        out.get(key).add(m[3]);
    }
    return out;
}

function verifyLegacy(contract, legacyFile) {
    const legacy = parseLegacy(legacyFile);
    const mine = new Map();
    for (const r of contract.all) {
        mine.set(`${r.method} ${r.path}`, new Set(r.packetTypes));
    }

    const missing = [...legacy.keys()].filter((k) => !mine.has(k));
    const extra = [...mine.keys()].filter((k) => !legacy.has(k));
    const typeDiff = [];
    for (const [k, v] of legacy) {
        const m = mine.get(k);
        if (!m) {
            continue;
        }
        const a = [...v].sort().join(',');
        const b = [...m].sort().join(',');
        if (a !== b) {
            typeDiff.push(`${k}\n    旧：${a}\n    新：${b}`);
        }
    }

    console.log('--- 与旧仓 PacketTypeMap 交叉校验 ---');
    console.log(`  旧仓端点 ${legacy.size} 条 / 新桥端点 ${mine.size} 条`);
    if (missing.length) {
        console.error(`  ✗ 新桥缺失 ${missing.length} 条：\n    ${missing.join('\n    ')}`);
    }
    if (extra.length) {
        console.error(`  ✗ 新桥多出 ${extra.length} 条（旧 APP 没有的接口，需人工确认是否有意新增）：\n    ${extra.join('\n    ')}`);
    }
    if (typeDiff.length) {
        console.error(`  ✗ packet_type 不一致 ${typeDiff.length} 条：\n    ${typeDiff.join('\n    ')}`);
    }
    if (missing.length || typeDiff.length) {
        console.error('  → 契约交叉校验失败。');
        return false;
    }
    console.log(`  ✓ 端点集合一致${extra.length ? `（新增 ${extra.length} 条已列出）` : ''}，packet_type 逐条一致`);
    return true;
}

// ---------------------------------------------------------------- 主流程

function stats(contract) {
    const curated = contract.exposed.filter((m) => m.curated).length;
    const byDomain = {};
    for (const m of contract.exposed) {
        byDomain[m.domain] = (byDomain[m.domain] || 0) + 1;
    }
    return { curated, mechanical: contract.exposed.length - curated, byDomain };
}

function checkFile(file, content, label) {
    if (!fs.existsSync(file)) {
        console.error(`✗ 缺少生成物（${label}）：${path.relative(CLIENT_ROOT, file)}`);
        console.error('  处置：跑 `pnpm gen:contract`。');
        return false;
    }
    const current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (current !== content) {
        console.error(`✗ 生成物与控制器不一致（${label}）：${path.relative(CLIENT_ROOT, file)}`);
        console.error('  处置：跑 `pnpm gen:contract` 并提交生成物。');
        return false;
    }
    return true;
}

function main() {
    if (!fs.existsSync(CONTROLLER_DIR)) {
        console.error(`找不到服务端控制器目录：${CONTROLLER_DIR}`);
        process.exit(1);
    }

    const contract = buildContract();
    const kotlin = renderKotlin(contract);
    const ts = renderTs(contract);
    const s = stats(contract);

    if (MODE === 'print') {
        process.stdout.write(kotlin);
        return;
    }

    if (MODE === 'report') {
        console.log(`桥方法 ${contract.exposed.length} 条（策展 ${s.curated} / 机械 ${s.mechanical}），不暴露 ${contract.excluded.length} 条`);
        console.log('  按域：', JSON.stringify(s.byDomain));
        return;
    }

    if (MODE === 'check') {
        let ok = checkFile(OUT_KOTLIN, kotlin, 'Kotlin');
        ok = checkFile(OUT_TS, ts, 'TypeScript') && ok;
        if (ok) {
            console.log(`gen-bridge-contract OK: ${contract.exposed.length} 条方法（策展 ${s.curated} / 机械 ${s.mechanical}），不暴露 ${contract.excluded.length} 条`);
            console.log('  按域：', JSON.stringify(s.byDomain));
        }
        if (LEGACY_FILE) {
            if (!fs.existsSync(LEGACY_FILE)) {
                console.error(`✗ 找不到旧仓生成物：${LEGACY_FILE}`);
                process.exit(1);
            }
            ok = verifyLegacy(contract, LEGACY_FILE) && ok;
        }
        process.exit(ok ? 0 : 1);
    }

    fs.mkdirSync(path.dirname(OUT_KOTLIN), { recursive: true });
    fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
    fs.writeFileSync(OUT_KOTLIN, kotlin, 'utf8');
    fs.writeFileSync(OUT_TS, ts, 'utf8');

    console.log(`gen-bridge-contract: 已写入`);
    console.log(`  ${path.relative(CLIENT_ROOT, OUT_KOTLIN).replace(/\\/g, '/')}`);
    console.log(`  ${path.relative(CLIENT_ROOT, OUT_TS).replace(/\\/g, '/')}`);
    console.log(`  方法 ${contract.exposed.length} 条（策展 ${s.curated} / 机械 ${s.mechanical}），不暴露 ${contract.excluded.length} 条`);
    console.log('  按域：', JSON.stringify(s.byDomain));
}

main();
