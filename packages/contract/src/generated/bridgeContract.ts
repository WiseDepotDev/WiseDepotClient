// AUTO-GENERATED FROM WiseDeoptServer/wise-deopt-api/**/controller/*.java — DO NOT EDIT
// 生成器：WiseDepotClient/tools/gen/gen-bridge-contract.js（--check 只校验不写入）
//
// 这是 Web 侧看到的**全部**可调用方法。壳侧白名单与本表同源，
// 因此前端调用 BRIDGE_METHOD_BY_ID 里没有的 id 一定是 bug，而不是运行时惊喜。

export const BRIDGE_PROTOCOL_VERSION = 3 as const;

export const BRIDGE_DOMAINS = ['field', 'inventory', 'me', 'overview', 'system'] as const;
export type BridgeDomain = (typeof BRIDGE_DOMAINS)[number];

export const BRIDGE_HTTP_METHODS = ['DELETE', 'GET', 'POST', 'PUT'] as const;
export type BridgeHttpMethod = (typeof BRIDGE_HTTP_METHODS)[number];

export const BRIDGE_PARAM_STYLES = ['body', 'query'] as const;
export type BridgeParamStyle = (typeof BRIDGE_PARAM_STYLES)[number];

export interface BridgeMethod {
  /** 调用时使用的方法 id。 */
  readonly id: string;
  readonly domain: BridgeDomain;
  readonly httpMethod: BridgeHttpMethod;
  /** 后端路径模板，`{...}` 为路径参数。 */
  readonly path: string;
  readonly packetType: string;
  /** 方法名是否来自人工策展（否则机械派生）。 */
  readonly curated: boolean;
  /**
   * 剩余参数的去向：`body` = JSON 信封 body，`query` = URL query string。
   *
   * `query` 的方法**不发 body**。这一项存在的唯一原因是服务端有 10 个 POST/PUT 端点在用
   * `@RequestParam`（只认 query string），不登记就会永远 400。
   */
  readonly paramStyle: BridgeParamStyle;
  /**
   * 路径参数是否**同时**留在 JSON body 里。默认 false。
   * 为 true 的那几条是因为服务端 DTO 把路径参数又声明了一次并加了 @NotNull，
   * 而控制器里的 setXxx(pathParam) 在参数绑定之后才跑，救不了 @Valid。
   */
  readonly keepPathParamsInBody: boolean;
}

/** 暴露给 Web 的方法共 167 条。 */
export const BRIDGE_METHODS = [
  { id: 'accessKey.auditLogs', domain: 'me', httpMethod: 'GET', path: '/api/access-keys/{keyId}/audit-logs', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'accessKey.byUser', domain: 'me', httpMethod: 'GET', path: '/api/access-keys/user/{userId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'accessKey.create', domain: 'me', httpMethod: 'POST', path: '/api/access-keys/user/{userId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'accessKey.delete', domain: 'me', httpMethod: 'DELETE', path: '/api/access-keys/{keyId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'accessKey.detail', domain: 'me', httpMethod: 'GET', path: '/api/access-keys/{keyId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'accessKey.disable', domain: 'me', httpMethod: 'PUT', path: '/api/access-keys/{keyId}/disable', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'accessKey.enable', domain: 'me', httpMethod: 'PUT', path: '/api/access-keys/{keyId}/enable', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alert.ack', domain: 'overview', httpMethod: 'POST', path: '/api/alerts/{eventId}/ack', packetType: 'ALERT_ACK', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alert.create', domain: 'overview', httpMethod: 'POST', path: '/api/alerts', packetType: 'ALERT_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alert.detail', domain: 'overview', httpMethod: 'GET', path: '/api/alerts/{eventId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'alert.list', domain: 'overview', httpMethod: 'GET', path: '/api/alerts', packetType: 'ALERT_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'alert.logs', domain: 'overview', httpMethod: 'GET', path: '/api/alerts/{eventId}/logs', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'alert.statistics', domain: 'overview', httpMethod: 'GET', path: '/api/alerts/statistics', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'alert.status', domain: 'overview', httpMethod: 'PUT', path: '/api/alerts/{eventId}/status', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alertRule.deviceOffline', domain: 'overview', httpMethod: 'POST', path: '/api/alert-rules/device-offline', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alertRule.inventoryAbnormal', domain: 'overview', httpMethod: 'POST', path: '/api/alert-rules/inventory-abnormal', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alertRule.rfidVideoConsistency', domain: 'overview', httpMethod: 'POST', path: '/api/alert-rules/rfid-video-consistency', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'alertRule.unauthorizedMove', domain: 'overview', httpMethod: 'POST', path: '/api/alert-rules/unauthorized-move', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'auth.login', domain: 'system', httpMethod: 'POST', path: '/api/auth/login', packetType: 'AUTH_LOGIN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'auth.logout', domain: 'system', httpMethod: 'POST', path: '/api/auth/logout', packetType: 'AUTH_LOGOUT', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'auth.nfcLogin', domain: 'system', httpMethod: 'POST', path: '/api/auth/nfc-login', packetType: 'AUTH_NFC_LOGIN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'auth.nfcPinLogin', domain: 'system', httpMethod: 'POST', path: '/api/auth/nfc-pin-login', packetType: 'AUTH_NFC_PIN_LOGIN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'captcha.generate', domain: 'system', httpMethod: 'POST', path: '/api/captcha/generate', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'captcha.verify', domain: 'system', httpMethod: 'POST', path: '/api/captcha/verify', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'dashboard.summary', domain: 'overview', httpMethod: 'GET', path: '/api/dashboard/summary', packetType: 'DASHBOARD_SUMMARY', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.byCode', domain: 'field', httpMethod: 'GET', path: '/api/device/code/{deviceCode}', packetType: 'DEVICE_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.config', domain: 'field', httpMethod: 'GET', path: '/api/device/config', packetType: 'DEVICE_CONFIG', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.create', domain: 'field', httpMethod: 'POST', path: '/api/device', packetType: 'DEVICE_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'device.delete', domain: 'field', httpMethod: 'DELETE', path: '/api/device/{deviceId}', packetType: 'DEVICE_DELETE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.detail', domain: 'field', httpMethod: 'GET', path: '/api/device/{deviceId}', packetType: 'DEVICE_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.heartbeat', domain: 'field', httpMethod: 'POST', path: '/api/device/heartbeat', packetType: 'DEVICE_HEARTBEAT', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.list', domain: 'field', httpMethod: 'GET', path: '/api/device', packetType: 'DEVICE_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.logUpload', domain: 'field', httpMethod: 'POST', path: '/api/device/logs/upload', packetType: 'DEVICE_LOG_UPLOAD', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.statistics', domain: 'field', httpMethod: 'GET', path: '/api/device/statistics', packetType: 'DEVICE_STATISTICS', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'device.update', domain: 'field', httpMethod: 'PUT', path: '/api/device/{deviceId}', packetType: 'DEVICE_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'file.delete', domain: 'system', httpMethod: 'DELETE', path: '/api/files/{fileId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'file.detail', domain: 'system', httpMethod: 'GET', path: '/api/files/{fileId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'file.download', domain: 'system', httpMethod: 'GET', path: '/api/files/{fileId}/download', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'file.list', domain: 'system', httpMethod: 'GET', path: '/api/files', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'file.presignedUrl', domain: 'system', httpMethod: 'GET', path: '/api/files/{fileId}/presigned-url', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'file.upload', domain: 'system', httpMethod: 'POST', path: '/api/files/upload', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'i18n.languages', domain: 'system', httpMethod: 'GET', path: '/api/i18n/languages', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'i18n.translate', domain: 'system', httpMethod: 'GET', path: '/api/i18n/translate', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'i18n.translations', domain: 'system', httpMethod: 'GET', path: '/api/i18n/translations', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.manualRecord', domain: 'field', httpMethod: 'POST', path: '/api/inspection/task/{taskId}/manual-record', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: true },
  { id: 'inspection.planCreate', domain: 'field', httpMethod: 'POST', path: '/api/inspection/plan', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inspection.planDelete', domain: 'field', httpMethod: 'DELETE', path: '/api/inspection/plan/{planId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.planDetail', domain: 'field', httpMethod: 'GET', path: '/api/inspection/plan/{planId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.planList', domain: 'field', httpMethod: 'GET', path: '/api/inspection/plan', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.planUpdate', domain: 'field', httpMethod: 'PUT', path: '/api/inspection/plan/{planId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inspection.report', domain: 'field', httpMethod: 'POST', path: '/api/inspection/report', packetType: 'RFID_DATA_UPLOAD', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inspection.resultConfirm', domain: 'field', httpMethod: 'POST', path: '/api/inspection/result/{resultId}/confirm', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inspection.resultCreate', domain: 'field', httpMethod: 'POST', path: '/api/inspection/result', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.resultDetail', domain: 'field', httpMethod: 'GET', path: '/api/inspection/result/{resultId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.resultList', domain: 'field', httpMethod: 'GET', path: '/api/inspection/result', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.resultPdf', domain: 'field', httpMethod: 'GET', path: '/api/inspection/result/{resultId}/export/pdf', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskCreate', domain: 'field', httpMethod: 'POST', path: '/api/inspection/task', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inspection.taskDetail', domain: 'field', httpMethod: 'GET', path: '/api/inspection/task/{taskId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskDiff', domain: 'field', httpMethod: 'GET', path: '/api/inspection/task/{taskId}/diff', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskList', domain: 'field', httpMethod: 'GET', path: '/api/inspection/task', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskPage', domain: 'field', httpMethod: 'GET', path: '/api/inspection/task/page', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskProgress', domain: 'field', httpMethod: 'PUT', path: '/api/inspection/task/{taskId}/progress', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inspection.taskStatus', domain: 'field', httpMethod: 'PUT', path: '/api/inspection/task/{taskId}/status', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.create', domain: 'inventory', httpMethod: 'POST', path: '/api/inventories', packetType: 'INVENTORY_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'inventory.delete', domain: 'inventory', httpMethod: 'DELETE', path: '/api/inventories/{inventoryId}', packetType: 'INVENTORY_DELETE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.detail', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/{inventoryId}', packetType: 'INVENTORY_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.expiring', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/alerts/expiring', packetType: 'INVENTORY_EXPIRING', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.list', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories', packetType: 'INVENTORY_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.listAll', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/all', packetType: 'INVENTORY_LIST_ALL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.lock', domain: 'inventory', httpMethod: 'POST', path: '/api/inventories/{inventoryId}/lock', packetType: 'INVENTORY_LOCK', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.lowStock', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/alerts/low-stock', packetType: 'INVENTORY_LOW_STOCK', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.search', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/search', packetType: 'INVENTORY_SEARCH', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.statByCategory', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/statistics/by-category', packetType: 'INVENTORY_BY_CATEGORY', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.statByLocation', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/statistics/by-location', packetType: 'INVENTORY_BY_LOCATION', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.statByProduct', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/statistics/product/{productId}', packetType: 'INVENTORY_PRODUCT_STATISTICS', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.statTotal', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/statistics/total', packetType: 'INVENTORY_TOTAL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.unlock', domain: 'inventory', httpMethod: 'POST', path: '/api/inventories/{inventoryId}/unlock', packetType: 'INVENTORY_UNLOCK', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'inventory.update', domain: 'inventory', httpMethod: 'PUT', path: '/api/inventories/{inventoryId}', packetType: 'INVENTORY_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'message.clear', domain: 'me', httpMethod: 'DELETE', path: '/api/messages', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'message.create', domain: 'me', httpMethod: 'POST', path: '/api/messages', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'message.delete', domain: 'me', httpMethod: 'DELETE', path: '/api/messages/{messageId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'message.detail', domain: 'me', httpMethod: 'GET', path: '/api/messages/{messageId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'message.list', domain: 'me', httpMethod: 'GET', path: '/api/messages', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'message.markAllRead', domain: 'me', httpMethod: 'PUT', path: '/api/messages/read-all', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'message.markRead', domain: 'me', httpMethod: 'PUT', path: '/api/messages/{messageId}/read', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'message.unreadCount', domain: 'me', httpMethod: 'GET', path: '/api/messages/unread-count', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'oss.fileCreate', domain: 'system', httpMethod: 'POST', path: '/api/oss/files', packetType: 'OSS_FILE_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'oss.presignedUrl', domain: 'system', httpMethod: 'GET', path: '/api/oss/presigned-url', packetType: 'OSS_PRESIGNED_URL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'password.change', domain: 'me', httpMethod: 'POST', path: '/api/password/change', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'password.forgot', domain: 'me', httpMethod: 'POST', path: '/api/password/forgot', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'password.reset', domain: 'me', httpMethod: 'POST', path: '/api/password/reset', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'password.strength', domain: 'me', httpMethod: 'GET', path: '/api/password/strength', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.byCode', domain: 'me', httpMethod: 'GET', path: '/api/permissions/code/{code}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.create', domain: 'me', httpMethod: 'POST', path: '/api/permissions', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'permission.delete', domain: 'me', httpMethod: 'DELETE', path: '/api/permissions/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.detail', domain: 'me', httpMethod: 'GET', path: '/api/permissions/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.list', domain: 'me', httpMethod: 'GET', path: '/api/permissions', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.tree', domain: 'me', httpMethod: 'GET', path: '/api/permissions/tree', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'permission.update', domain: 'me', httpMethod: 'PUT', path: '/api/permissions/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'product.create', domain: 'inventory', httpMethod: 'POST', path: '/api/inventories/products', packetType: 'PRODUCT_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'product.delete', domain: 'inventory', httpMethod: 'DELETE', path: '/api/inventories/products/{productId}', packetType: 'PRODUCT_DELETE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'product.detail', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/products/{productId}', packetType: 'PRODUCT_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'product.list', domain: 'inventory', httpMethod: 'GET', path: '/api/inventories/products', packetType: 'PRODUCT_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'product.update', domain: 'inventory', httpMethod: 'PUT', path: '/api/inventories/products/{productId}', packetType: 'PRODUCT_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'profile.avatarDelete', domain: 'me', httpMethod: 'DELETE', path: '/api/profile/avatar', packetType: 'USER_UPDATE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'profile.avatarImage', domain: 'me', httpMethod: 'GET', path: '/api/profile/{userId}/avatar/image', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'profile.avatarUpload', domain: 'me', httpMethod: 'POST', path: '/api/profile/avatar', packetType: 'USER_UPDATE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'profile.get', domain: 'me', httpMethod: 'GET', path: '/api/profile', packetType: 'USER_CURRENT', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'profile.settings', domain: 'me', httpMethod: 'GET', path: '/api/profile/settings', packetType: 'USER_CURRENT', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'profile.settingsUpdate', domain: 'me', httpMethod: 'PUT', path: '/api/profile/settings', packetType: 'USER_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'profile.update', domain: 'me', httpMethod: 'PUT', path: '/api/profile', packetType: 'USER_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'report.create', domain: 'system', httpMethod: 'POST', path: '/api/reports', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'report.detail', domain: 'system', httpMethod: 'GET', path: '/api/reports/{taskId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'report.execute', domain: 'system', httpMethod: 'POST', path: '/api/reports/{taskId}/execute', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'report.exports', domain: 'system', httpMethod: 'GET', path: '/api/reports/{taskId}/exports', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'report.list', domain: 'system', httpMethod: 'GET', path: '/api/reports', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'rfid.report', domain: 'system', httpMethod: 'POST', path: '/rfid/report', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'role.assignPermissions', domain: 'me', httpMethod: 'POST', path: '/api/roles/{roleId}/permissions', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'role.byName', domain: 'me', httpMethod: 'GET', path: '/api/roles/name/{name}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'role.create', domain: 'me', httpMethod: 'POST', path: '/api/roles', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'role.delete', domain: 'me', httpMethod: 'DELETE', path: '/api/roles/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'role.detail', domain: 'me', httpMethod: 'GET', path: '/api/roles/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'role.list', domain: 'me', httpMethod: 'GET', path: '/api/roles', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'role.permissions', domain: 'me', httpMethod: 'GET', path: '/api/roles/{roleId}/permissions', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'role.update', domain: 'me', httpMethod: 'PUT', path: '/api/roles/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.addItem', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/items', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.audit', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/audit', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.create', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders', packetType: 'STOCK_ORDER_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.detail', domain: 'inventory', httpMethod: 'GET', path: '/api/stock-orders/{orderId}', packetType: 'STOCK_ORDER_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'stockOrder.list', domain: 'inventory', httpMethod: 'GET', path: '/api/stock-orders', packetType: 'STOCK_ORDER_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'stockOrder.removeItem', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/items/{tagId}/remove', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.submit', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/submit', packetType: 'STOCK_ORDER_SUBMIT', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.update', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/update', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'stockOrder.withdraw', domain: 'inventory', httpMethod: 'POST', path: '/api/stock-orders/{orderId}/withdraw', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'sync.data', domain: 'system', httpMethod: 'POST', path: '/api/sync/data', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.batchBind', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/batch-bind', packetType: 'TAG_BATCH_BIND', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.batchBindWithCaptcha', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/batch-bind-with-captcha', packetType: 'TAG_BATCH_BIND', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.batchQuery', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/batch-query', packetType: 'TAG_LIST', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.batchUnbind', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/batch-unbind', packetType: 'TAG_BATCH_UNBIND', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.bind', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/{tagId}/bind', packetType: 'TAG_BIND', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.byCode', domain: 'inventory', httpMethod: 'GET', path: '/api/tag/code/{tagCode}', packetType: 'TAG_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.byProduct', domain: 'inventory', httpMethod: 'GET', path: '/api/tag/product/{productId}', packetType: 'TAG_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.create', domain: 'inventory', httpMethod: 'POST', path: '/api/tag', packetType: 'TAG_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.delete', domain: 'inventory', httpMethod: 'DELETE', path: '/api/tag/{tagId}', packetType: 'TAG_DELETE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.detail', domain: 'inventory', httpMethod: 'GET', path: '/api/tag/{tagId}', packetType: 'TAG_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.list', domain: 'inventory', httpMethod: 'GET', path: '/api/tag', packetType: 'TAG_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.search', domain: 'inventory', httpMethod: 'GET', path: '/api/tag/search', packetType: 'TAG_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'tag.unbind', domain: 'inventory', httpMethod: 'POST', path: '/api/tag/{tagId}/unbind', packetType: 'TAG_UNBIND', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'tag.update', domain: 'inventory', httpMethod: 'PUT', path: '/api/tag/{tagId}', packetType: 'TAG_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.assignRoles', domain: 'me', httpMethod: 'POST', path: '/api/users/{userId}/roles', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.changePassword', domain: 'me', httpMethod: 'POST', path: '/api/users/current/password', packetType: 'USER_CHANGE_PASSWORD', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.clearRoles', domain: 'me', httpMethod: 'DELETE', path: '/api/users/{userId}/roles', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.create', domain: 'me', httpMethod: 'POST', path: '/api/users', packetType: 'USER_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.current', domain: 'me', httpMethod: 'GET', path: '/api/users/current', packetType: 'USER_CURRENT', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.delete', domain: 'me', httpMethod: 'DELETE', path: '/api/users/{userId}', packetType: 'USER_DELETE', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.deleteWithCaptcha', domain: 'me', httpMethod: 'POST', path: '/api/users/{userId}/delete-with-captcha', packetType: 'USER_DELETE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.detail', domain: 'me', httpMethod: 'GET', path: '/api/users/{userId}', packetType: 'USER_DETAIL', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.list', domain: 'me', httpMethod: 'GET', path: '/api/users', packetType: 'USER_LIST', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.removeRole', domain: 'me', httpMethod: 'DELETE', path: '/api/users/{userId}/roles/{roleId}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.resetPassword', domain: 'me', httpMethod: 'POST', path: '/api/users/{userId}/password', packetType: 'USER_CHANGE_PASSWORD', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'user.roles', domain: 'me', httpMethod: 'GET', path: '/api/users/{userId}/roles', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'user.update', domain: 'me', httpMethod: 'PUT', path: '/api/users/{userId}', packetType: 'USER_UPDATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'warehouse.create', domain: 'inventory', httpMethod: 'POST', path: '/api/warehouse', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
  { id: 'warehouse.delete', domain: 'inventory', httpMethod: 'DELETE', path: '/api/warehouse/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'warehouse.detail', domain: 'inventory', httpMethod: 'GET', path: '/api/warehouse/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'warehouse.list', domain: 'inventory', httpMethod: 'GET', path: '/api/warehouse', packetType: 'UNKNOWN', curated: true, paramStyle: 'query', keepPathParamsInBody: false },
  { id: 'warehouse.update', domain: 'inventory', httpMethod: 'PUT', path: '/api/warehouse/{id}', packetType: 'UNKNOWN', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
] as const satisfies readonly BridgeMethod[];

export type BridgeMethodId = (typeof BRIDGE_METHODS)[number]['id'];

export const BRIDGE_METHOD_IDS: readonly BridgeMethodId[] = BRIDGE_METHODS.map((m) => m.id);

export const BRIDGE_METHOD_BY_ID = Object.fromEntries(
  BRIDGE_METHODS.map((m) => [m.id, m]),
) as unknown as Readonly<Record<BridgeMethodId, BridgeMethod>>;

/** 刻意不暴露给 Web 的路由（共 2 条）。 */
export const BRIDGE_EXCLUDED_IDS: readonly string[] = ['auth.refreshToken', 'health.minio'];
