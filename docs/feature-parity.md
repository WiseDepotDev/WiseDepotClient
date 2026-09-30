# 功能对照清单（旧 APP → WiseDepotClient）

> **本文件由 `tools/gen/gen-feature-parity.js` 生成，禁止手改。**
> 重跑：`pnpm gen:parity`；校验：`pnpm gen:parity --check`。
> 「迁移状态」由 W5–W7 逐域推进时在验收记录里回填，本文件只固定"有哪些、归哪域"。

## 0. 口径与来源

| 项 | 数量 | 来源 |
| --- | --- | --- |
| 旧 APP 屏文件（*Screen.kt） | 29 | 归档区全量扫描 |
| 旧 APP 路由 id（AppRoute.kt） | 19 | 归档区 `AppRoute.kt` |
| 桥方法（暴露给 Web） | 167 | `packages/contract/src/generated/bridgeContract.ts` |

说明：旧路由 id 是 19 条扁平目的地，新架构按四域重设计（见 `docs/architecture.md` §信息架构），**不复用旧 NavFlags 语义**；因此下表是"功能归属"对照，不是"路由一一映射"。

## 1. 旧屏清单

| # | 屏文件 | 行数 | 新域 | 迁移状态 |
| --- | --- | --- | --- | --- |
| 1 | `feature/alert/src/main/java/com/huicang/wise/ui/alert/AlertDetailScreen.kt` | 211 | overview | 待迁（W5–W7） |
| 2 | `feature/alert/src/main/java/com/huicang/wise/ui/alert/AlertListScreen.kt` | 317 | overview | 待迁（W5–W7） |
| 3 | `core/ui/src/main/java/com/huicang/wise/ui/camera/CameraScanScreen.kt` | 255 | **待归类** | 待迁（W5–W7） |
| 4 | `feature/inspection/src/main/java/com/huicang/wise/ui/inspection/CreateInspectionTaskScreen.kt` | 306 | **待归类** | 待迁（W5–W7） |
| 5 | `feature/dashboard/src/main/java/com/huicang/wise/ui/dashboard/DashboardScreen.kt` | 116 | overview | 待迁（W5–W7） |
| 6 | `feature/device/src/main/java/com/huicang/wise/ui/device/DeviceDetailScreen.kt` | 251 | field | 待迁（W5–W7） |
| 7 | `feature/device/src/main/java/com/huicang/wise/ui/device/DeviceListScreen.kt` | 211 | field | 待迁（W5–W7） |
| 8 | `feature/inspection/src/main/java/com/huicang/wise/ui/inspection/InspectionDetailScreen.kt` | 402 | field | 待迁（W5–W7） |
| 9 | `feature/inspection/src/main/java/com/huicang/wise/ui/inspection/InspectionListScreen.kt` | 276 | field | 待迁（W5–W7） |
| 10 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/InventoryDetailScreen.kt` | 195 | inventory | 待迁（W5–W7） |
| 11 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/InventoryManagementScreen.kt` | 331 | inventory | 待迁（W5–W7） |
| 12 | `app/src/main/java/com/huicang/wise/ui/main/InventoryScreen.kt` | 234 | inventory | 待迁（W5–W7） |
| 13 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/InventorySearchScreen.kt` | 272 | inventory | 待迁（W5–W7） |
| 14 | `feature/auth/src/main/java/com/huicang/wise/ui/login/LoginScreen.kt` | 273 | system（登录不在一级域内） | 待迁（W5–W7） |
| 15 | `app/src/main/java/com/huicang/wise/ui/main/MainScreen.kt` | 277 | **待归类** | 待迁（W5–W7） |
| 16 | `feature/inspection/src/main/java/com/huicang/wise/ui/inspection/ManualRecordScreen.kt` | 267 | **待归类** | 待迁（W5–W7） |
| 17 | `feature/message/src/main/java/com/huicang/wise/ui/message/MessageDetailScreen.kt` | 337 | me | 待迁（W5–W7） |
| 18 | `feature/message/src/main/java/com/huicang/wise/ui/message/MessageListScreen.kt` | 396 | me | 待迁（W5–W7） |
| 19 | `feature/auth/src/main/java/com/huicang/wise/ui/nfc/NfcLoginScreen.kt` | 235 | system（登录不在一级域内） | 待迁（W5–W7） |
| 20 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/ProductManagementScreen.kt` | 355 | inventory | 待迁（W5–W7） |
| 21 | `feature/user/src/main/java/com/huicang/wise/ui/user/ProfileScreen.kt` | 363 | me | 待迁（W5–W7） |
| 22 | `core/ui/src/main/java/com/huicang/wise/ui/components/SkeletonScreen.kt` | 200 | **待归类** | 待迁（W5–W7） |
| 23 | `feature/stock/src/main/java/com/huicang/wise/ui/stock/StockOrderCreateScreen.kt` | 501 | inventory | 待迁（W5–W7） |
| 24 | `feature/stock/src/main/java/com/huicang/wise/ui/stock/StockOrderDetailScreen.kt` | 423 | inventory | 待迁（W5–W7） |
| 25 | `feature/stock/src/main/java/com/huicang/wise/ui/stock/StockOrderListScreen.kt` | 252 | inventory | 待迁（W5–W7） |
| 26 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/TagDetailScreen.kt` | 365 | inventory | 待迁（W5–W7） |
| 27 | `feature/inventory/src/main/java/com/huicang/wise/ui/inventory/TagManagementScreen.kt` | 441 | inventory | 待迁（W5–W7） |
| 28 | `feature/user/src/main/java/com/huicang/wise/ui/user/UserManagementScreen.kt` | 219 | me | 待迁（W5–W7） |
| 29 | `feature/warehouse/src/main/java/com/huicang/wise/ui/warehouse/WarehouseManagementScreen.kt` | 194 | field | 待迁（W5–W7） |

## 2. 旧路由目录（AppRoute.kt）

| # | 路由 id | 新域 | 迁移状态 |
| --- | --- | --- | --- |
| 1 | `alert/detail` | overview | 待迁（W5–W7） |
| 2 | `alert/list` | overview | 待迁（W5–W7） |
| 3 | `device/detail` | field | 待迁（W5–W7） |
| 4 | `device/list` | field | 待迁（W5–W7） |
| 5 | `inspection/create` | field | 待迁（W5–W7） |
| 6 | `inspection/detail` | field | 待迁（W5–W7） |
| 7 | `inspection/list` | field | 待迁（W5–W7） |
| 8 | `inventory/detail` | inventory | 待迁（W5–W7） |
| 9 | `inventory/management` | inventory | 待迁（W5–W7） |
| 10 | `inventory/product` | inventory | 待迁（W5–W7） |
| 11 | `inventory/search` | inventory | 待迁（W5–W7） |
| 12 | `inventory/tag` | inventory | 待迁（W5–W7） |
| 13 | `message/detail` | me | 待迁（W5–W7） |
| 14 | `message/list` | me | 待迁（W5–W7） |
| 15 | `stock/create` | inventory | 待迁（W5–W7） |
| 16 | `stock/detail` | inventory | 待迁（W5–W7） |
| 17 | `stock/list` | inventory | 待迁（W5–W7） |
| 18 | `user/management` | me | 待迁（W5–W7） |
| 19 | `warehouse/management` | field | 待迁（W5–W7） |

## 3. 桥方法按域分布

| 域 | 方法数 |
| --- | --- |
| field | 29 |
| inventory | 48 |
| me | 54 |
| overview | 12 |
| system | 24 |
| **合计** | **167** |

### 3.1 field

| 方法 id | HTTP | 路径 | packet_type |
| --- | --- | --- | --- |
| `device.byCode` | GET | `/api/device/code/{deviceCode}` | DEVICE_DETAIL |
| `device.config` | GET | `/api/device/config` | DEVICE_CONFIG |
| `device.create` | POST | `/api/device` | DEVICE_CREATE |
| `device.delete` | DELETE | `/api/device/{deviceId}` | DEVICE_DELETE |
| `device.detail` | GET | `/api/device/{deviceId}` | DEVICE_DETAIL |
| `device.heartbeat` | POST | `/api/device/heartbeat` | DEVICE_HEARTBEAT |
| `device.list` | GET | `/api/device` | DEVICE_LIST |
| `device.logUpload` | POST | `/api/device/logs/upload` | DEVICE_LOG_UPLOAD |
| `device.statistics` | GET | `/api/device/statistics` | DEVICE_STATISTICS |
| `device.update` | PUT | `/api/device/{deviceId}` | DEVICE_UPDATE |
| `inspection.manualRecord` | POST | `/api/inspection/task/{taskId}/manual-record` | UNKNOWN |
| `inspection.planCreate` | POST | `/api/inspection/plan` | UNKNOWN |
| `inspection.planDelete` | DELETE | `/api/inspection/plan/{planId}` | UNKNOWN |
| `inspection.planDetail` | GET | `/api/inspection/plan/{planId}` | UNKNOWN |
| `inspection.planList` | GET | `/api/inspection/plan` | UNKNOWN |
| `inspection.planUpdate` | PUT | `/api/inspection/plan/{planId}` | UNKNOWN |
| `inspection.report` | POST | `/api/inspection/report` | RFID_DATA_UPLOAD |
| `inspection.resultConfirm` | POST | `/api/inspection/result/{resultId}/confirm` | UNKNOWN |
| `inspection.resultCreate` | POST | `/api/inspection/result` | UNKNOWN |
| `inspection.resultDetail` | GET | `/api/inspection/result/{resultId}` | UNKNOWN |
| `inspection.resultList` | GET | `/api/inspection/result` | UNKNOWN |
| `inspection.resultPdf` | GET | `/api/inspection/result/{resultId}/export/pdf` | UNKNOWN |
| `inspection.taskCreate` | POST | `/api/inspection/task` | UNKNOWN |
| `inspection.taskDetail` | GET | `/api/inspection/task/{taskId}` | UNKNOWN |
| `inspection.taskDiff` | GET | `/api/inspection/task/{taskId}/diff` | UNKNOWN |
| `inspection.taskList` | GET | `/api/inspection/task` | UNKNOWN |
| `inspection.taskPage` | GET | `/api/inspection/task/page` | UNKNOWN |
| `inspection.taskProgress` | PUT | `/api/inspection/task/{taskId}/progress` | UNKNOWN |
| `inspection.taskStatus` | PUT | `/api/inspection/task/{taskId}/status` | UNKNOWN |

### 3.2 inventory

| 方法 id | HTTP | 路径 | packet_type |
| --- | --- | --- | --- |
| `inventory.create` | POST | `/api/inventories` | INVENTORY_CREATE |
| `inventory.delete` | DELETE | `/api/inventories/{inventoryId}` | INVENTORY_DELETE |
| `inventory.detail` | GET | `/api/inventories/{inventoryId}` | INVENTORY_DETAIL |
| `inventory.expiring` | GET | `/api/inventories/alerts/expiring` | INVENTORY_EXPIRING |
| `inventory.list` | GET | `/api/inventories` | INVENTORY_LIST |
| `inventory.listAll` | GET | `/api/inventories/all` | INVENTORY_LIST_ALL |
| `inventory.lock` | POST | `/api/inventories/{inventoryId}/lock` | INVENTORY_LOCK |
| `inventory.lowStock` | GET | `/api/inventories/alerts/low-stock` | INVENTORY_LOW_STOCK |
| `inventory.search` | GET | `/api/inventories/search` | INVENTORY_SEARCH |
| `inventory.statByCategory` | GET | `/api/inventories/statistics/by-category` | INVENTORY_BY_CATEGORY |
| `inventory.statByLocation` | GET | `/api/inventories/statistics/by-location` | INVENTORY_BY_LOCATION |
| `inventory.statByProduct` | GET | `/api/inventories/statistics/product/{productId}` | INVENTORY_PRODUCT_STATISTICS |
| `inventory.statTotal` | GET | `/api/inventories/statistics/total` | INVENTORY_TOTAL |
| `inventory.unlock` | POST | `/api/inventories/{inventoryId}/unlock` | INVENTORY_UNLOCK |
| `inventory.update` | PUT | `/api/inventories/{inventoryId}` | INVENTORY_UPDATE |
| `product.create` | POST | `/api/inventories/products` | PRODUCT_CREATE |
| `product.delete` | DELETE | `/api/inventories/products/{productId}` | PRODUCT_DELETE |
| `product.detail` | GET | `/api/inventories/products/{productId}` | PRODUCT_DETAIL |
| `product.list` | GET | `/api/inventories/products` | PRODUCT_LIST |
| `product.update` | PUT | `/api/inventories/products/{productId}` | PRODUCT_UPDATE |
| `stockOrder.addItem` | POST | `/api/stock-orders/{orderId}/items` | UNKNOWN |
| `stockOrder.audit` | POST | `/api/stock-orders/{orderId}/audit` | UNKNOWN |
| `stockOrder.create` | POST | `/api/stock-orders` | STOCK_ORDER_CREATE |
| `stockOrder.detail` | GET | `/api/stock-orders/{orderId}` | STOCK_ORDER_DETAIL |
| `stockOrder.list` | GET | `/api/stock-orders` | STOCK_ORDER_LIST |
| `stockOrder.removeItem` | POST | `/api/stock-orders/{orderId}/items/{tagId}/remove` | UNKNOWN |
| `stockOrder.submit` | POST | `/api/stock-orders/{orderId}/submit` | STOCK_ORDER_SUBMIT |
| `stockOrder.update` | POST | `/api/stock-orders/{orderId}/update` | UNKNOWN |
| `stockOrder.withdraw` | POST | `/api/stock-orders/{orderId}/withdraw` | UNKNOWN |
| `tag.batchBind` | POST | `/api/tag/batch-bind` | TAG_BATCH_BIND |
| `tag.batchBindWithCaptcha` | POST | `/api/tag/batch-bind-with-captcha` | TAG_BATCH_BIND |
| `tag.batchQuery` | POST | `/api/tag/batch-query` | TAG_LIST |
| `tag.batchUnbind` | POST | `/api/tag/batch-unbind` | TAG_BATCH_UNBIND |
| `tag.bind` | POST | `/api/tag/{tagId}/bind` | TAG_BIND |
| `tag.byCode` | GET | `/api/tag/code/{tagCode}` | TAG_DETAIL |
| `tag.byProduct` | GET | `/api/tag/product/{productId}` | TAG_LIST |
| `tag.create` | POST | `/api/tag` | TAG_CREATE |
| `tag.delete` | DELETE | `/api/tag/{tagId}` | TAG_DELETE |
| `tag.detail` | GET | `/api/tag/{tagId}` | TAG_DETAIL |
| `tag.list` | GET | `/api/tag` | TAG_LIST |
| `tag.search` | GET | `/api/tag/search` | TAG_LIST |
| `tag.unbind` | POST | `/api/tag/{tagId}/unbind` | TAG_UNBIND |
| `tag.update` | PUT | `/api/tag/{tagId}` | TAG_UPDATE |
| `warehouse.create` | POST | `/api/warehouse` | UNKNOWN |
| `warehouse.delete` | DELETE | `/api/warehouse/{id}` | UNKNOWN |
| `warehouse.detail` | GET | `/api/warehouse/{id}` | UNKNOWN |
| `warehouse.list` | GET | `/api/warehouse` | UNKNOWN |
| `warehouse.update` | PUT | `/api/warehouse/{id}` | UNKNOWN |

### 3.3 me

| 方法 id | HTTP | 路径 | packet_type |
| --- | --- | --- | --- |
| `accessKey.auditLogs` | GET | `/api/access-keys/{keyId}/audit-logs` | UNKNOWN |
| `accessKey.byUser` | GET | `/api/access-keys/user/{userId}` | UNKNOWN |
| `accessKey.create` | POST | `/api/access-keys/user/{userId}` | UNKNOWN |
| `accessKey.delete` | DELETE | `/api/access-keys/{keyId}` | UNKNOWN |
| `accessKey.detail` | GET | `/api/access-keys/{keyId}` | UNKNOWN |
| `accessKey.disable` | PUT | `/api/access-keys/{keyId}/disable` | UNKNOWN |
| `accessKey.enable` | PUT | `/api/access-keys/{keyId}/enable` | UNKNOWN |
| `message.clear` | DELETE | `/api/messages` | UNKNOWN |
| `message.create` | POST | `/api/messages` | UNKNOWN |
| `message.delete` | DELETE | `/api/messages/{messageId}` | UNKNOWN |
| `message.detail` | GET | `/api/messages/{messageId}` | UNKNOWN |
| `message.list` | GET | `/api/messages` | UNKNOWN |
| `message.markAllRead` | PUT | `/api/messages/read-all` | UNKNOWN |
| `message.markRead` | PUT | `/api/messages/{messageId}/read` | UNKNOWN |
| `message.unreadCount` | GET | `/api/messages/unread-count` | UNKNOWN |
| `password.change` | POST | `/api/password/change` | UNKNOWN |
| `password.forgot` | POST | `/api/password/forgot` | UNKNOWN |
| `password.reset` | POST | `/api/password/reset` | UNKNOWN |
| `password.strength` | GET | `/api/password/strength` | UNKNOWN |
| `permission.byCode` | GET | `/api/permissions/code/{code}` | UNKNOWN |
| `permission.create` | POST | `/api/permissions` | UNKNOWN |
| `permission.delete` | DELETE | `/api/permissions/{id}` | UNKNOWN |
| `permission.detail` | GET | `/api/permissions/{id}` | UNKNOWN |
| `permission.list` | GET | `/api/permissions` | UNKNOWN |
| `permission.tree` | GET | `/api/permissions/tree` | UNKNOWN |
| `permission.update` | PUT | `/api/permissions/{id}` | UNKNOWN |
| `profile.avatarDelete` | DELETE | `/api/profile/avatar` | USER_UPDATE |
| `profile.avatarImage` | GET | `/api/profile/{userId}/avatar/image` | UNKNOWN |
| `profile.avatarUpload` | POST | `/api/profile/avatar` | USER_UPDATE |
| `profile.get` | GET | `/api/profile` | USER_CURRENT |
| `profile.settings` | GET | `/api/profile/settings` | USER_CURRENT |
| `profile.settingsUpdate` | PUT | `/api/profile/settings` | USER_UPDATE |
| `profile.update` | PUT | `/api/profile` | USER_UPDATE |
| `role.assignPermissions` | POST | `/api/roles/{roleId}/permissions` | UNKNOWN |
| `role.byName` | GET | `/api/roles/name/{name}` | UNKNOWN |
| `role.create` | POST | `/api/roles` | UNKNOWN |
| `role.delete` | DELETE | `/api/roles/{id}` | UNKNOWN |
| `role.detail` | GET | `/api/roles/{id}` | UNKNOWN |
| `role.list` | GET | `/api/roles` | UNKNOWN |
| `role.permissions` | GET | `/api/roles/{roleId}/permissions` | UNKNOWN |
| `role.update` | PUT | `/api/roles/{id}` | UNKNOWN |
| `user.assignRoles` | POST | `/api/users/{userId}/roles` | UNKNOWN |
| `user.changePassword` | POST | `/api/users/current/password` | USER_CHANGE_PASSWORD |
| `user.clearRoles` | DELETE | `/api/users/{userId}/roles` | UNKNOWN |
| `user.create` | POST | `/api/users` | USER_CREATE |
| `user.current` | GET | `/api/users/current` | USER_CURRENT |
| `user.delete` | DELETE | `/api/users/{userId}` | USER_DELETE |
| `user.deleteWithCaptcha` | POST | `/api/users/{userId}/delete-with-captcha` | USER_DELETE |
| `user.detail` | GET | `/api/users/{userId}` | USER_DETAIL |
| `user.list` | GET | `/api/users` | USER_LIST |
| `user.removeRole` | DELETE | `/api/users/{userId}/roles/{roleId}` | UNKNOWN |
| `user.resetPassword` | POST | `/api/users/{userId}/password` | USER_CHANGE_PASSWORD |
| `user.roles` | GET | `/api/users/{userId}/roles` | UNKNOWN |
| `user.update` | PUT | `/api/users/{userId}` | USER_UPDATE |

### 3.4 overview

| 方法 id | HTTP | 路径 | packet_type |
| --- | --- | --- | --- |
| `alert.ack` | POST | `/api/alerts/{eventId}/ack` | ALERT_ACK |
| `alert.create` | POST | `/api/alerts` | ALERT_CREATE |
| `alert.detail` | GET | `/api/alerts/{eventId}` | UNKNOWN |
| `alert.list` | GET | `/api/alerts` | ALERT_LIST |
| `alert.logs` | GET | `/api/alerts/{eventId}/logs` | UNKNOWN |
| `alert.statistics` | GET | `/api/alerts/statistics` | UNKNOWN |
| `alert.status` | PUT | `/api/alerts/{eventId}/status` | UNKNOWN |
| `alertRule.deviceOffline` | POST | `/api/alert-rules/device-offline` | UNKNOWN |
| `alertRule.inventoryAbnormal` | POST | `/api/alert-rules/inventory-abnormal` | UNKNOWN |
| `alertRule.rfidVideoConsistency` | POST | `/api/alert-rules/rfid-video-consistency` | UNKNOWN |
| `alertRule.unauthorizedMove` | POST | `/api/alert-rules/unauthorized-move` | UNKNOWN |
| `dashboard.summary` | GET | `/api/dashboard/summary` | DASHBOARD_SUMMARY |

### 3.5 system

| 方法 id | HTTP | 路径 | packet_type |
| --- | --- | --- | --- |
| `auth.login` | POST | `/api/auth/login` | AUTH_LOGIN |
| `auth.logout` | POST | `/api/auth/logout` | AUTH_LOGOUT |
| `auth.nfcLogin` | POST | `/api/auth/nfc-login` | AUTH_NFC_LOGIN |
| `auth.nfcPinLogin` | POST | `/api/auth/nfc-pin-login` | AUTH_NFC_PIN_LOGIN |
| `captcha.generate` | POST | `/api/captcha/generate` | UNKNOWN |
| `captcha.verify` | POST | `/api/captcha/verify` | UNKNOWN |
| `file.delete` | DELETE | `/api/files/{fileId}` | UNKNOWN |
| `file.detail` | GET | `/api/files/{fileId}` | UNKNOWN |
| `file.download` | GET | `/api/files/{fileId}/download` | UNKNOWN |
| `file.list` | GET | `/api/files` | UNKNOWN |
| `file.presignedUrl` | GET | `/api/files/{fileId}/presigned-url` | UNKNOWN |
| `file.upload` | POST | `/api/files/upload` | UNKNOWN |
| `i18n.languages` | GET | `/api/i18n/languages` | UNKNOWN |
| `i18n.translate` | GET | `/api/i18n/translate` | UNKNOWN |
| `i18n.translations` | GET | `/api/i18n/translations` | UNKNOWN |
| `oss.fileCreate` | POST | `/api/oss/files` | OSS_FILE_CREATE |
| `oss.presignedUrl` | GET | `/api/oss/presigned-url` | OSS_PRESIGNED_URL |
| `report.create` | POST | `/api/reports` | UNKNOWN |
| `report.detail` | GET | `/api/reports/{taskId}` | UNKNOWN |
| `report.execute` | POST | `/api/reports/{taskId}/execute` | UNKNOWN |
| `report.exports` | GET | `/api/reports/{taskId}/exports` | UNKNOWN |
| `report.list` | GET | `/api/reports` | UNKNOWN |
| `rfid.report` | POST | `/rfid/report` | UNKNOWN |
| `sync.data` | POST | `/api/sync/data` | UNKNOWN |

## 4. 需要在桥侧特殊处理的端点

| 方法 | 原因 | 处置 |
| --- | --- | --- |
| `inspection.resultPdf` | 返回 PDF 字节流，不是 JSON | 桥取回后落盘并换发一次性 URL，走带外 HTTP 下载，不进 WS 帧 |
| `file.download` | 同上（文件流） | 同上 |
| `file.upload` / `oss.fileCreate` / `device.logUpload` | 请求体是 multipart，且可能很大 | 由壳侧组装 multipart；Web 只传本地文件句柄或分片句柄 |
| `captcha.generate` | 响应含验证码图片 | 由桥落成 data URL / blob URL，Web 不直接背 base64 字符串 |

## 5. 刻意不暴露的端点（白名单的减法）

| 方法 | 路径 | 原因 |
| --- | --- | --- |
| `auth.refreshToken` | `POST /api/auth/refresh-token` | 刷新令牌由桥内部完成；令牌不得进入 JS 上下文 |
| `health.minio` | `GET /api/health/minio` | 运维接口，客户端无用 |

> 减法记在 `tools/gen/bridge-overlay.json` 的 `hidden`，改动会出现在生成物的 `excluded` 列表里，删不掉也藏不住。
