import { BridgeError } from '@wise/bridge-client';

/**
 * 域内共用的取数小工具。
 *
 * 为什么需要 [asList]：后端的分页返回**不是统一的**——同一个项目里见过
 * `rows` / `content` / `items` / 裸数组四种形状（旧版各屏各自适配，于是每屏都要写一遍）。
 * 这里收敛成一处，形状变了也只改这里。
 */
export function asList<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) {
    return value as readonly T[];
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['rows', 'content', 'items', 'list', 'records']) {
      if (Array.isArray(o[key])) {
        return o[key] as readonly T[];
      }
    }
  }
  return [];
}

/** 从任意分页形状里取总数。 */
export function asTotal(value: unknown): number | undefined {
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['total', 'totalElements', 'count']) {
      if (typeof o[key] === 'number') {
        return o[key] as number;
      }
    }
  }
  return undefined;
}

/**
 * 错误码 → 人话。
 *
 * **文案在 Web 侧映射**，桥只给码与 messageKey（延续旧仓"谁展示谁拥有"）。
 * 桥自己的错误看 `messageKey`；后端业务错误看 `code` 前缀。
 *
 * 例外：有些业务拒绝**只有服务端知道原因**（实测 `VAL-0001`
 * "只能对已完成的巡检任务进行补录"）。桥会把这类原文放在 `details` 里
 * （已在桥侧按白名单前缀过滤并截断），映射不到时就用它 ——
 * 让用户看到「取数失败（VAL-0001）」等于什么都没说。
 */
export function humanize(error: BridgeError | undefined): string {
  if (!error) {
    return '';
  }
  switch (error.messageKey) {
    case 'bridge.backendUnreachable':
      return '后端不可达，请检查网络或服务状态';
    case 'bridge.timeout':
      return '请求超时，可重试';
    case 'bridge.reconnectGaveUp':
    case 'bridge.closed':
      return '与本地服务的连接已断开';
    case 'error_session_expired':
      return '登录已过期，请重新登录';
    case 'bridge.methodUnknown':
      return '该功能在当前版本尚未实现';
    case 'bridge.paramsMissingPathParam':
    case 'bridge.paramsInvalid':
      return '请求参数不完整，请检查填写内容';
    default:
      break;
  }
  if (error.code.startsWith('AUTH-')) {
    return '没有权限执行该操作';
  }
  if (error.code === 'HTTP-400') {
    return '请求被拒绝（可能缺少签名或参数）';
  }
  if (error.code === 'BRIDGE_BACKEND_UNREACHABLE') {
    return '后端不可达，请检查网络或服务状态';
  }
  if (typeof error.details === 'string' && error.details.trim().length > 0) {
    return error.details;
  }
  return `操作未完成（${error.code}）`;
}

/** `2026-01-01T09:12:00` → `01-01 09:12`。列表里的时间只用来排序与粗看，不需要秒。 */
export function shortTime(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}
