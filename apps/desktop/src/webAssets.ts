import fs from 'node:fs';
import path from 'node:path';

/**
 * Web 产物的静态服务解析（**纯函数，不依赖 Electron**）。
 *
 * 之所以单独抽出来：这里有唯一一处真正要防的东西——**路径穿越**
 * （`app://wise/../../etc/passwd` 这类）。放在纯函数里就能被单测穷举，
 * 而不是"靠 Electron 的 protocol.handle 应该会拦住吧"。
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export interface ResolvedAsset {
  readonly absolutePath: string;
  readonly contentType: string;
  readonly size: number;
}

/** `/` 或空路径 → `index.html`；其余按原样，但去掉查询串与前导斜杠。 */
export function normalizeAssetPath(urlPath: string): string {
  const withoutQuery = urlPath.split('?')[0]!.split('#')[0]!;
  const trimmed = withoutQuery.replace(/^\/+/, '');
  return trimmed === '' ? 'index.html' : trimmed;
}

/**
 * 把 URL 路径解析成 `root` 目录下的真实文件。
 *
 * @returns 命中且是普通文件时返回；否则 null（调用方回 404）
 */
export function resolveWebAsset(root: string, urlPath: string): ResolvedAsset | null {
  const rel = normalizeAssetPath(urlPath);
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, rel);

  // 穿越防线：解析后的绝对路径必须仍在 root 之内。
  // 用 `+ path.sep` 而不是裸 startsWith，否则 `/tmp/web-evil` 会被判成 `/tmp/web` 的子路径。
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) {
    return null;
  }
  if (rel.includes('\0')) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  const ext = path.extname(candidate).toLowerCase();
  return {
    absolutePath: candidate,
    contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
    size: stat.size,
  };
}

/**
 * 桥引导的响应体构造。
 *
 * 与手机壳的 `MainActivity.bootstrapResponse()` 是同一份契约的两个实现：
 * 桥未就绪时回 **503**（Web 侧把它当"宿主尚未就绪"，见 packages/bridge-client/src/bootstrap.ts），
 * 而不是 404 或空 200 —— 那会把"还没起来"和"起不来"混成一种表现。
 */
export function bootstrapResponse(
  handshake: { port: number; token: string; ver: string; platform: string; capabilities: string } | null,
): { status: number; body: string; contentType: string } {
  if (!handshake) {
    return { status: 503, body: '', contentType: 'application/json; charset=utf-8' };
  }
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({
      port: handshake.port,
      token: handshake.token,
      platform: handshake.platform,
      ver: handshake.ver,
      protocol: 3,
      capabilities: handshake.capabilities ? handshake.capabilities.split(',').filter(Boolean) : [],
    }),
  };
}
