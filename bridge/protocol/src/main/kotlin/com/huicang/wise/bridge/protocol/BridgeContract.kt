// AUTO-GENERATED FROM WiseDeoptServer/wise-deopt-api/**/controller/*.java — DO NOT EDIT
// 生成器：WiseDepotClient/tools/gen/gen-bridge-contract.js（--check 只校验不写入）
// 策展层：WiseDepotClient/tools/gen/bridge-overlay.json（命名空间 / 域 / 别名 / 隐藏项）
//
// 这份表就是桥的**方法白名单**：不在表里的 method 一律被拒（BRIDGE_METHOD_UNKNOWN）。
// 桥不做通用 HTTP 透传，否则一次 Web 侧 XSS 就等于拿到任意后端接口。
package com.huicang.wise.bridge.protocol

/**
 * 桥方法契约（协议 v3）。
 *
 * `id` 是 Web 侧调用时用的方法名；`httpMethod` + `path` 是壳侧转发到后端时用的路由；
 * `packetType` 是后端信封 `header.packet_type` 的取值（与旧 APP 的 PacketTypeMap 同源）。
 */
object BridgeContract {
    /** 本契约对应的协议版本。 */
    const val VERSION: Int = BridgeProtocol.VERSION

    /** UI 一级域（信息架构的四域 + 系统域）。 */
    enum class Domain {
        OVERVIEW,
        INVENTORY,
        FIELD,
        ME,
        SYSTEM,
    }

    /** 单条桥方法。 */
    data class Method(
        /** 方法 id，如 `inventory.list`。 */
        val id: String,
        /** 归属的一级域。 */
        val domain: Domain,
        /** 后端 HTTP 方法。 */
        val httpMethod: String,
        /** 后端路径模板（`{...}` 段为路径参数）。 */
        val path: String,
        /** 主 packet_type（同一端点多条时取无条件那条）。 */
        val packetType: String,
        /** 方法名是否来自人工策展（否则为机械派生）。 */
        val curated: Boolean,
    )

    /** 暴露给 Web 的方法共 167 条。 */
    val methods: List<Method> =
        listOf(
            Method("accessKey.auditLogs", Domain.ME, "GET", "/api/access-keys/{keyId}/audit-logs", "UNKNOWN", true),
            Method("accessKey.byUser", Domain.ME, "GET", "/api/access-keys/user/{userId}", "UNKNOWN", true),
            Method("accessKey.create", Domain.ME, "POST", "/api/access-keys/user/{userId}", "UNKNOWN", true),
            Method("accessKey.delete", Domain.ME, "DELETE", "/api/access-keys/{keyId}", "UNKNOWN", true),
            Method("accessKey.detail", Domain.ME, "GET", "/api/access-keys/{keyId}", "UNKNOWN", true),
            Method("accessKey.disable", Domain.ME, "PUT", "/api/access-keys/{keyId}/disable", "UNKNOWN", true),
            Method("accessKey.enable", Domain.ME, "PUT", "/api/access-keys/{keyId}/enable", "UNKNOWN", true),
            Method("alert.ack", Domain.OVERVIEW, "POST", "/api/alerts/{eventId}/ack", "ALERT_ACK", true),
            Method("alert.create", Domain.OVERVIEW, "POST", "/api/alerts", "ALERT_CREATE", true),
            Method("alert.detail", Domain.OVERVIEW, "GET", "/api/alerts/{eventId}", "UNKNOWN", true),
            Method("alert.list", Domain.OVERVIEW, "GET", "/api/alerts", "ALERT_LIST", true),
            Method("alert.logs", Domain.OVERVIEW, "GET", "/api/alerts/{eventId}/logs", "UNKNOWN", true),
            Method("alert.statistics", Domain.OVERVIEW, "GET", "/api/alerts/statistics", "UNKNOWN", true),
            Method("alert.status", Domain.OVERVIEW, "PUT", "/api/alerts/{eventId}/status", "UNKNOWN", true),
            Method("alertRule.deviceOffline", Domain.OVERVIEW, "POST", "/api/alert-rules/device-offline", "UNKNOWN", true),
            Method("alertRule.inventoryAbnormal", Domain.OVERVIEW, "POST", "/api/alert-rules/inventory-abnormal", "UNKNOWN", true),
            Method("alertRule.rfidVideoConsistency", Domain.OVERVIEW, "POST", "/api/alert-rules/rfid-video-consistency", "UNKNOWN", true),
            Method("alertRule.unauthorizedMove", Domain.OVERVIEW, "POST", "/api/alert-rules/unauthorized-move", "UNKNOWN", true),
            Method("auth.login", Domain.SYSTEM, "POST", "/api/auth/login", "AUTH_LOGIN", true),
            Method("auth.logout", Domain.SYSTEM, "POST", "/api/auth/logout", "AUTH_LOGOUT", true),
            Method("auth.nfcLogin", Domain.SYSTEM, "POST", "/api/auth/nfc-login", "AUTH_NFC_LOGIN", true),
            Method("auth.nfcPinLogin", Domain.SYSTEM, "POST", "/api/auth/nfc-pin-login", "AUTH_NFC_PIN_LOGIN", true),
            Method("captcha.generate", Domain.SYSTEM, "POST", "/api/captcha/generate", "UNKNOWN", true),
            Method("captcha.verify", Domain.SYSTEM, "POST", "/api/captcha/verify", "UNKNOWN", true),
            Method("dashboard.summary", Domain.OVERVIEW, "GET", "/api/dashboard/summary", "DASHBOARD_SUMMARY", true),
            Method("device.byCode", Domain.FIELD, "GET", "/api/device/code/{deviceCode}", "DEVICE_DETAIL", true),
            Method("device.config", Domain.FIELD, "GET", "/api/device/config", "DEVICE_CONFIG", true),
            Method("device.create", Domain.FIELD, "POST", "/api/device", "DEVICE_CREATE", true),
            Method("device.delete", Domain.FIELD, "DELETE", "/api/device/{deviceId}", "DEVICE_DELETE", true),
            Method("device.detail", Domain.FIELD, "GET", "/api/device/{deviceId}", "DEVICE_DETAIL", true),
            Method("device.heartbeat", Domain.FIELD, "POST", "/api/device/heartbeat", "DEVICE_HEARTBEAT", true),
            Method("device.list", Domain.FIELD, "GET", "/api/device", "DEVICE_LIST", true),
            Method("device.logUpload", Domain.FIELD, "POST", "/api/device/logs/upload", "DEVICE_LOG_UPLOAD", true),
            Method("device.statistics", Domain.FIELD, "GET", "/api/device/statistics", "DEVICE_STATISTICS", true),
            Method("device.update", Domain.FIELD, "PUT", "/api/device/{deviceId}", "DEVICE_UPDATE", true),
            Method("file.delete", Domain.SYSTEM, "DELETE", "/api/files/{fileId}", "UNKNOWN", true),
            Method("file.detail", Domain.SYSTEM, "GET", "/api/files/{fileId}", "UNKNOWN", true),
            Method("file.download", Domain.SYSTEM, "GET", "/api/files/{fileId}/download", "UNKNOWN", true),
            Method("file.list", Domain.SYSTEM, "GET", "/api/files", "UNKNOWN", true),
            Method("file.presignedUrl", Domain.SYSTEM, "GET", "/api/files/{fileId}/presigned-url", "UNKNOWN", true),
            Method("file.upload", Domain.SYSTEM, "POST", "/api/files/upload", "UNKNOWN", true),
            Method("i18n.languages", Domain.SYSTEM, "GET", "/api/i18n/languages", "UNKNOWN", true),
            Method("i18n.translate", Domain.SYSTEM, "GET", "/api/i18n/translate", "UNKNOWN", true),
            Method("i18n.translations", Domain.SYSTEM, "GET", "/api/i18n/translations", "UNKNOWN", true),
            Method("inspection.manualRecord", Domain.FIELD, "POST", "/api/inspection/task/{taskId}/manual-record", "UNKNOWN", true),
            Method("inspection.planCreate", Domain.FIELD, "POST", "/api/inspection/plan", "UNKNOWN", true),
            Method("inspection.planDelete", Domain.FIELD, "DELETE", "/api/inspection/plan/{planId}", "UNKNOWN", true),
            Method("inspection.planDetail", Domain.FIELD, "GET", "/api/inspection/plan/{planId}", "UNKNOWN", true),
            Method("inspection.planList", Domain.FIELD, "GET", "/api/inspection/plan", "UNKNOWN", true),
            Method("inspection.planUpdate", Domain.FIELD, "PUT", "/api/inspection/plan/{planId}", "UNKNOWN", true),
            Method("inspection.report", Domain.FIELD, "POST", "/api/inspection/report", "RFID_DATA_UPLOAD", true),
            Method("inspection.resultConfirm", Domain.FIELD, "POST", "/api/inspection/result/{resultId}/confirm", "UNKNOWN", true),
            Method("inspection.resultCreate", Domain.FIELD, "POST", "/api/inspection/result", "UNKNOWN", true),
            Method("inspection.resultDetail", Domain.FIELD, "GET", "/api/inspection/result/{resultId}", "UNKNOWN", true),
            Method("inspection.resultList", Domain.FIELD, "GET", "/api/inspection/result", "UNKNOWN", true),
            Method("inspection.resultPdf", Domain.FIELD, "GET", "/api/inspection/result/{resultId}/export/pdf", "UNKNOWN", true),
            Method("inspection.taskCreate", Domain.FIELD, "POST", "/api/inspection/task", "UNKNOWN", true),
            Method("inspection.taskDetail", Domain.FIELD, "GET", "/api/inspection/task/{taskId}", "UNKNOWN", true),
            Method("inspection.taskDiff", Domain.FIELD, "GET", "/api/inspection/task/{taskId}/diff", "UNKNOWN", true),
            Method("inspection.taskList", Domain.FIELD, "GET", "/api/inspection/task", "UNKNOWN", true),
            Method("inspection.taskPage", Domain.FIELD, "GET", "/api/inspection/task/page", "UNKNOWN", true),
            Method("inspection.taskProgress", Domain.FIELD, "PUT", "/api/inspection/task/{taskId}/progress", "UNKNOWN", true),
            Method("inspection.taskStatus", Domain.FIELD, "PUT", "/api/inspection/task/{taskId}/status", "UNKNOWN", true),
            Method("inventory.create", Domain.INVENTORY, "POST", "/api/inventories", "INVENTORY_CREATE", true),
            Method("inventory.delete", Domain.INVENTORY, "DELETE", "/api/inventories/{inventoryId}", "INVENTORY_DELETE", true),
            Method("inventory.detail", Domain.INVENTORY, "GET", "/api/inventories/{inventoryId}", "INVENTORY_DETAIL", true),
            Method("inventory.expiring", Domain.INVENTORY, "GET", "/api/inventories/alerts/expiring", "INVENTORY_EXPIRING", true),
            Method("inventory.list", Domain.INVENTORY, "GET", "/api/inventories", "INVENTORY_LIST", true),
            Method("inventory.listAll", Domain.INVENTORY, "GET", "/api/inventories/all", "INVENTORY_LIST_ALL", true),
            Method("inventory.lock", Domain.INVENTORY, "POST", "/api/inventories/{inventoryId}/lock", "INVENTORY_LOCK", true),
            Method("inventory.lowStock", Domain.INVENTORY, "GET", "/api/inventories/alerts/low-stock", "INVENTORY_LOW_STOCK", true),
            Method("inventory.search", Domain.INVENTORY, "GET", "/api/inventories/search", "INVENTORY_SEARCH", true),
            Method("inventory.statByCategory", Domain.INVENTORY, "GET", "/api/inventories/statistics/by-category", "INVENTORY_BY_CATEGORY", true),
            Method("inventory.statByLocation", Domain.INVENTORY, "GET", "/api/inventories/statistics/by-location", "INVENTORY_BY_LOCATION", true),
            Method("inventory.statByProduct", Domain.INVENTORY, "GET", "/api/inventories/statistics/product/{productId}", "INVENTORY_PRODUCT_STATISTICS", true),
            Method("inventory.statTotal", Domain.INVENTORY, "GET", "/api/inventories/statistics/total", "INVENTORY_TOTAL", true),
            Method("inventory.unlock", Domain.INVENTORY, "POST", "/api/inventories/{inventoryId}/unlock", "INVENTORY_UNLOCK", true),
            Method("inventory.update", Domain.INVENTORY, "PUT", "/api/inventories/{inventoryId}", "INVENTORY_UPDATE", true),
            Method("message.clear", Domain.ME, "DELETE", "/api/messages", "UNKNOWN", true),
            Method("message.create", Domain.ME, "POST", "/api/messages", "UNKNOWN", true),
            Method("message.delete", Domain.ME, "DELETE", "/api/messages/{messageId}", "UNKNOWN", true),
            Method("message.detail", Domain.ME, "GET", "/api/messages/{messageId}", "UNKNOWN", true),
            Method("message.list", Domain.ME, "GET", "/api/messages", "UNKNOWN", true),
            Method("message.markAllRead", Domain.ME, "PUT", "/api/messages/read-all", "UNKNOWN", true),
            Method("message.markRead", Domain.ME, "PUT", "/api/messages/{messageId}/read", "UNKNOWN", true),
            Method("message.unreadCount", Domain.ME, "GET", "/api/messages/unread-count", "UNKNOWN", true),
            Method("oss.fileCreate", Domain.SYSTEM, "POST", "/api/oss/files", "OSS_FILE_CREATE", true),
            Method("oss.presignedUrl", Domain.SYSTEM, "GET", "/api/oss/presigned-url", "OSS_PRESIGNED_URL", true),
            Method("password.change", Domain.ME, "POST", "/api/password/change", "UNKNOWN", true),
            Method("password.forgot", Domain.ME, "POST", "/api/password/forgot", "UNKNOWN", true),
            Method("password.reset", Domain.ME, "POST", "/api/password/reset", "UNKNOWN", true),
            Method("password.strength", Domain.ME, "GET", "/api/password/strength", "UNKNOWN", true),
            Method("permission.byCode", Domain.ME, "GET", "/api/permissions/code/{code}", "UNKNOWN", true),
            Method("permission.create", Domain.ME, "POST", "/api/permissions", "UNKNOWN", true),
            Method("permission.delete", Domain.ME, "DELETE", "/api/permissions/{id}", "UNKNOWN", true),
            Method("permission.detail", Domain.ME, "GET", "/api/permissions/{id}", "UNKNOWN", true),
            Method("permission.list", Domain.ME, "GET", "/api/permissions", "UNKNOWN", true),
            Method("permission.tree", Domain.ME, "GET", "/api/permissions/tree", "UNKNOWN", true),
            Method("permission.update", Domain.ME, "PUT", "/api/permissions/{id}", "UNKNOWN", true),
            Method("product.create", Domain.INVENTORY, "POST", "/api/inventories/products", "PRODUCT_CREATE", true),
            Method("product.delete", Domain.INVENTORY, "DELETE", "/api/inventories/products/{productId}", "PRODUCT_DELETE", true),
            Method("product.detail", Domain.INVENTORY, "GET", "/api/inventories/products/{productId}", "PRODUCT_DETAIL", true),
            Method("product.list", Domain.INVENTORY, "GET", "/api/inventories/products", "PRODUCT_LIST", true),
            Method("product.update", Domain.INVENTORY, "PUT", "/api/inventories/products/{productId}", "PRODUCT_UPDATE", true),
            Method("profile.avatarDelete", Domain.ME, "DELETE", "/api/profile/avatar", "USER_UPDATE", true),
            Method("profile.avatarImage", Domain.ME, "GET", "/api/profile/{userId}/avatar/image", "UNKNOWN", true),
            Method("profile.avatarUpload", Domain.ME, "POST", "/api/profile/avatar", "USER_UPDATE", true),
            Method("profile.get", Domain.ME, "GET", "/api/profile", "USER_CURRENT", true),
            Method("profile.settings", Domain.ME, "GET", "/api/profile/settings", "USER_CURRENT", true),
            Method("profile.settingsUpdate", Domain.ME, "PUT", "/api/profile/settings", "USER_UPDATE", true),
            Method("profile.update", Domain.ME, "PUT", "/api/profile", "USER_UPDATE", true),
            Method("report.create", Domain.SYSTEM, "POST", "/api/reports", "UNKNOWN", true),
            Method("report.detail", Domain.SYSTEM, "GET", "/api/reports/{taskId}", "UNKNOWN", true),
            Method("report.execute", Domain.SYSTEM, "POST", "/api/reports/{taskId}/execute", "UNKNOWN", true),
            Method("report.exports", Domain.SYSTEM, "GET", "/api/reports/{taskId}/exports", "UNKNOWN", true),
            Method("report.list", Domain.SYSTEM, "GET", "/api/reports", "UNKNOWN", true),
            Method("rfid.report", Domain.SYSTEM, "POST", "/rfid/report", "UNKNOWN", true),
            Method("role.assignPermissions", Domain.ME, "POST", "/api/roles/{roleId}/permissions", "UNKNOWN", true),
            Method("role.byName", Domain.ME, "GET", "/api/roles/name/{name}", "UNKNOWN", true),
            Method("role.create", Domain.ME, "POST", "/api/roles", "UNKNOWN", true),
            Method("role.delete", Domain.ME, "DELETE", "/api/roles/{id}", "UNKNOWN", true),
            Method("role.detail", Domain.ME, "GET", "/api/roles/{id}", "UNKNOWN", true),
            Method("role.list", Domain.ME, "GET", "/api/roles", "UNKNOWN", true),
            Method("role.permissions", Domain.ME, "GET", "/api/roles/{roleId}/permissions", "UNKNOWN", true),
            Method("role.update", Domain.ME, "PUT", "/api/roles/{id}", "UNKNOWN", true),
            Method("stockOrder.addItem", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/items", "UNKNOWN", true),
            Method("stockOrder.audit", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/audit", "UNKNOWN", true),
            Method("stockOrder.create", Domain.INVENTORY, "POST", "/api/stock-orders", "STOCK_ORDER_CREATE", true),
            Method("stockOrder.detail", Domain.INVENTORY, "GET", "/api/stock-orders/{orderId}", "STOCK_ORDER_DETAIL", true),
            Method("stockOrder.list", Domain.INVENTORY, "GET", "/api/stock-orders", "STOCK_ORDER_LIST", true),
            Method("stockOrder.removeItem", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/items/{tagId}/remove", "UNKNOWN", true),
            Method("stockOrder.submit", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/submit", "STOCK_ORDER_SUBMIT", true),
            Method("stockOrder.update", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/update", "UNKNOWN", true),
            Method("stockOrder.withdraw", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/withdraw", "UNKNOWN", true),
            Method("sync.data", Domain.SYSTEM, "POST", "/api/sync/data", "UNKNOWN", true),
            Method("tag.batchBind", Domain.INVENTORY, "POST", "/api/tag/batch-bind", "TAG_BATCH_BIND", true),
            Method("tag.batchBindWithCaptcha", Domain.INVENTORY, "POST", "/api/tag/batch-bind-with-captcha", "TAG_BATCH_BIND", true),
            Method("tag.batchQuery", Domain.INVENTORY, "POST", "/api/tag/batch-query", "TAG_LIST", true),
            Method("tag.batchUnbind", Domain.INVENTORY, "POST", "/api/tag/batch-unbind", "TAG_BATCH_UNBIND", true),
            Method("tag.bind", Domain.INVENTORY, "POST", "/api/tag/{tagId}/bind", "TAG_BIND", true),
            Method("tag.byCode", Domain.INVENTORY, "GET", "/api/tag/code/{tagCode}", "TAG_DETAIL", true),
            Method("tag.byProduct", Domain.INVENTORY, "GET", "/api/tag/product/{productId}", "TAG_LIST", true),
            Method("tag.create", Domain.INVENTORY, "POST", "/api/tag", "TAG_CREATE", true),
            Method("tag.delete", Domain.INVENTORY, "DELETE", "/api/tag/{tagId}", "TAG_DELETE", true),
            Method("tag.detail", Domain.INVENTORY, "GET", "/api/tag/{tagId}", "TAG_DETAIL", true),
            Method("tag.list", Domain.INVENTORY, "GET", "/api/tag", "TAG_LIST", true),
            Method("tag.search", Domain.INVENTORY, "GET", "/api/tag/search", "TAG_LIST", true),
            Method("tag.unbind", Domain.INVENTORY, "POST", "/api/tag/{tagId}/unbind", "TAG_UNBIND", true),
            Method("tag.update", Domain.INVENTORY, "PUT", "/api/tag/{tagId}", "TAG_UPDATE", true),
            Method("user.assignRoles", Domain.ME, "POST", "/api/users/{userId}/roles", "UNKNOWN", true),
            Method("user.changePassword", Domain.ME, "POST", "/api/users/current/password", "USER_CHANGE_PASSWORD", true),
            Method("user.clearRoles", Domain.ME, "DELETE", "/api/users/{userId}/roles", "UNKNOWN", true),
            Method("user.create", Domain.ME, "POST", "/api/users", "USER_CREATE", true),
            Method("user.current", Domain.ME, "GET", "/api/users/current", "USER_CURRENT", true),
            Method("user.delete", Domain.ME, "DELETE", "/api/users/{userId}", "USER_DELETE", true),
            Method("user.deleteWithCaptcha", Domain.ME, "POST", "/api/users/{userId}/delete-with-captcha", "USER_DELETE", true),
            Method("user.detail", Domain.ME, "GET", "/api/users/{userId}", "USER_DETAIL", true),
            Method("user.list", Domain.ME, "GET", "/api/users", "USER_LIST", true),
            Method("user.removeRole", Domain.ME, "DELETE", "/api/users/{userId}/roles/{roleId}", "UNKNOWN", true),
            Method("user.resetPassword", Domain.ME, "POST", "/api/users/{userId}/password", "USER_CHANGE_PASSWORD", true),
            Method("user.roles", Domain.ME, "GET", "/api/users/{userId}/roles", "UNKNOWN", true),
            Method("user.update", Domain.ME, "PUT", "/api/users/{userId}", "USER_UPDATE", true),
            Method("warehouse.create", Domain.INVENTORY, "POST", "/api/warehouse", "UNKNOWN", true),
            Method("warehouse.delete", Domain.INVENTORY, "DELETE", "/api/warehouse/{id}", "UNKNOWN", true),
            Method("warehouse.detail", Domain.INVENTORY, "GET", "/api/warehouse/{id}", "UNKNOWN", true),
            Method("warehouse.list", Domain.INVENTORY, "GET", "/api/warehouse", "UNKNOWN", true),
            Method("warehouse.update", Domain.INVENTORY, "PUT", "/api/warehouse/{id}", "UNKNOWN", true),
        )

    private val index: Map<String, Method> = methods.associateBy { it.id }

    /** 按方法 id 查表；未登记返回 null（调用方转成 BRIDGE_METHOD_UNKNOWN）。 */
    fun find(id: String): Method? = index[id]

    /** 某一级域下的全部方法。 */
    fun of(domain: Domain): List<Method> = methods.filter { it.domain == domain }

    /** 刻意不暴露给 Web 的路由（共 2 条），仅用于文档与一致性校验。 */
    val excluded: List<Method> =
        listOf(
            Method("auth.refreshToken", Domain.SYSTEM, "POST", "/api/auth/refresh-token", "UNKNOWN", false),
            Method("health.minio", Domain.SYSTEM, "GET", "/api/health/minio", "UNKNOWN", false),
        )
}
