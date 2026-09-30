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

    /** 参数去哪：JSON 信封 body，还是 URL query string。 */
    enum class ParamStyle {
        /** 参数进 JSON 信封 body（多数 POST/PUT/PATCH）。 */
        BODY,
        /** 参数拼进 URL query string（GET/DELETE，以及服务端用 @RequestParam 的 POST/PUT）。 */
        QUERY,
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
        /** 剩余参数的去向。QUERY 的方法**不发 body**。 */
        val paramStyle: ParamStyle,
    )

    /** 暴露给 Web 的方法共 167 条。 */
    val methods: List<Method> =
        listOf(
            Method("accessKey.auditLogs", Domain.ME, "GET", "/api/access-keys/{keyId}/audit-logs", "UNKNOWN", true, ParamStyle.QUERY),
            Method("accessKey.byUser", Domain.ME, "GET", "/api/access-keys/user/{userId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("accessKey.create", Domain.ME, "POST", "/api/access-keys/user/{userId}", "UNKNOWN", true, ParamStyle.BODY),
            Method("accessKey.delete", Domain.ME, "DELETE", "/api/access-keys/{keyId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("accessKey.detail", Domain.ME, "GET", "/api/access-keys/{keyId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("accessKey.disable", Domain.ME, "PUT", "/api/access-keys/{keyId}/disable", "UNKNOWN", true, ParamStyle.BODY),
            Method("accessKey.enable", Domain.ME, "PUT", "/api/access-keys/{keyId}/enable", "UNKNOWN", true, ParamStyle.BODY),
            Method("alert.ack", Domain.OVERVIEW, "POST", "/api/alerts/{eventId}/ack", "ALERT_ACK", true, ParamStyle.BODY),
            Method("alert.create", Domain.OVERVIEW, "POST", "/api/alerts", "ALERT_CREATE", true, ParamStyle.BODY),
            Method("alert.detail", Domain.OVERVIEW, "GET", "/api/alerts/{eventId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("alert.list", Domain.OVERVIEW, "GET", "/api/alerts", "ALERT_LIST", true, ParamStyle.QUERY),
            Method("alert.logs", Domain.OVERVIEW, "GET", "/api/alerts/{eventId}/logs", "UNKNOWN", true, ParamStyle.QUERY),
            Method("alert.statistics", Domain.OVERVIEW, "GET", "/api/alerts/statistics", "UNKNOWN", true, ParamStyle.QUERY),
            Method("alert.status", Domain.OVERVIEW, "PUT", "/api/alerts/{eventId}/status", "UNKNOWN", true, ParamStyle.BODY),
            Method("alertRule.deviceOffline", Domain.OVERVIEW, "POST", "/api/alert-rules/device-offline", "UNKNOWN", true, ParamStyle.BODY),
            Method("alertRule.inventoryAbnormal", Domain.OVERVIEW, "POST", "/api/alert-rules/inventory-abnormal", "UNKNOWN", true, ParamStyle.BODY),
            Method("alertRule.rfidVideoConsistency", Domain.OVERVIEW, "POST", "/api/alert-rules/rfid-video-consistency", "UNKNOWN", true, ParamStyle.BODY),
            Method("alertRule.unauthorizedMove", Domain.OVERVIEW, "POST", "/api/alert-rules/unauthorized-move", "UNKNOWN", true, ParamStyle.BODY),
            Method("auth.login", Domain.SYSTEM, "POST", "/api/auth/login", "AUTH_LOGIN", true, ParamStyle.BODY),
            Method("auth.logout", Domain.SYSTEM, "POST", "/api/auth/logout", "AUTH_LOGOUT", true, ParamStyle.BODY),
            Method("auth.nfcLogin", Domain.SYSTEM, "POST", "/api/auth/nfc-login", "AUTH_NFC_LOGIN", true, ParamStyle.BODY),
            Method("auth.nfcPinLogin", Domain.SYSTEM, "POST", "/api/auth/nfc-pin-login", "AUTH_NFC_PIN_LOGIN", true, ParamStyle.BODY),
            Method("captcha.generate", Domain.SYSTEM, "POST", "/api/captcha/generate", "UNKNOWN", true, ParamStyle.BODY),
            Method("captcha.verify", Domain.SYSTEM, "POST", "/api/captcha/verify", "UNKNOWN", true, ParamStyle.BODY),
            Method("dashboard.summary", Domain.OVERVIEW, "GET", "/api/dashboard/summary", "DASHBOARD_SUMMARY", true, ParamStyle.QUERY),
            Method("device.byCode", Domain.FIELD, "GET", "/api/device/code/{deviceCode}", "DEVICE_DETAIL", true, ParamStyle.QUERY),
            Method("device.config", Domain.FIELD, "GET", "/api/device/config", "DEVICE_CONFIG", true, ParamStyle.QUERY),
            Method("device.create", Domain.FIELD, "POST", "/api/device", "DEVICE_CREATE", true, ParamStyle.BODY),
            Method("device.delete", Domain.FIELD, "DELETE", "/api/device/{deviceId}", "DEVICE_DELETE", true, ParamStyle.QUERY),
            Method("device.detail", Domain.FIELD, "GET", "/api/device/{deviceId}", "DEVICE_DETAIL", true, ParamStyle.QUERY),
            Method("device.heartbeat", Domain.FIELD, "POST", "/api/device/heartbeat", "DEVICE_HEARTBEAT", true, ParamStyle.QUERY),
            Method("device.list", Domain.FIELD, "GET", "/api/device", "DEVICE_LIST", true, ParamStyle.QUERY),
            Method("device.logUpload", Domain.FIELD, "POST", "/api/device/logs/upload", "DEVICE_LOG_UPLOAD", true, ParamStyle.QUERY),
            Method("device.statistics", Domain.FIELD, "GET", "/api/device/statistics", "DEVICE_STATISTICS", true, ParamStyle.QUERY),
            Method("device.update", Domain.FIELD, "PUT", "/api/device/{deviceId}", "DEVICE_UPDATE", true, ParamStyle.BODY),
            Method("file.delete", Domain.SYSTEM, "DELETE", "/api/files/{fileId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("file.detail", Domain.SYSTEM, "GET", "/api/files/{fileId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("file.download", Domain.SYSTEM, "GET", "/api/files/{fileId}/download", "UNKNOWN", true, ParamStyle.QUERY),
            Method("file.list", Domain.SYSTEM, "GET", "/api/files", "UNKNOWN", true, ParamStyle.QUERY),
            Method("file.presignedUrl", Domain.SYSTEM, "GET", "/api/files/{fileId}/presigned-url", "UNKNOWN", true, ParamStyle.QUERY),
            Method("file.upload", Domain.SYSTEM, "POST", "/api/files/upload", "UNKNOWN", true, ParamStyle.QUERY),
            Method("i18n.languages", Domain.SYSTEM, "GET", "/api/i18n/languages", "UNKNOWN", true, ParamStyle.QUERY),
            Method("i18n.translate", Domain.SYSTEM, "GET", "/api/i18n/translate", "UNKNOWN", true, ParamStyle.QUERY),
            Method("i18n.translations", Domain.SYSTEM, "GET", "/api/i18n/translations", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.manualRecord", Domain.FIELD, "POST", "/api/inspection/task/{taskId}/manual-record", "UNKNOWN", true, ParamStyle.BODY),
            Method("inspection.planCreate", Domain.FIELD, "POST", "/api/inspection/plan", "UNKNOWN", true, ParamStyle.BODY),
            Method("inspection.planDelete", Domain.FIELD, "DELETE", "/api/inspection/plan/{planId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.planDetail", Domain.FIELD, "GET", "/api/inspection/plan/{planId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.planList", Domain.FIELD, "GET", "/api/inspection/plan", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.planUpdate", Domain.FIELD, "PUT", "/api/inspection/plan/{planId}", "UNKNOWN", true, ParamStyle.BODY),
            Method("inspection.report", Domain.FIELD, "POST", "/api/inspection/report", "RFID_DATA_UPLOAD", true, ParamStyle.BODY),
            Method("inspection.resultConfirm", Domain.FIELD, "POST", "/api/inspection/result/{resultId}/confirm", "UNKNOWN", true, ParamStyle.BODY),
            Method("inspection.resultCreate", Domain.FIELD, "POST", "/api/inspection/result", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.resultDetail", Domain.FIELD, "GET", "/api/inspection/result/{resultId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.resultList", Domain.FIELD, "GET", "/api/inspection/result", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.resultPdf", Domain.FIELD, "GET", "/api/inspection/result/{resultId}/export/pdf", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskCreate", Domain.FIELD, "POST", "/api/inspection/task", "UNKNOWN", true, ParamStyle.BODY),
            Method("inspection.taskDetail", Domain.FIELD, "GET", "/api/inspection/task/{taskId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskDiff", Domain.FIELD, "GET", "/api/inspection/task/{taskId}/diff", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskList", Domain.FIELD, "GET", "/api/inspection/task", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskPage", Domain.FIELD, "GET", "/api/inspection/task/page", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskProgress", Domain.FIELD, "PUT", "/api/inspection/task/{taskId}/progress", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inspection.taskStatus", Domain.FIELD, "PUT", "/api/inspection/task/{taskId}/status", "UNKNOWN", true, ParamStyle.QUERY),
            Method("inventory.create", Domain.INVENTORY, "POST", "/api/inventories", "INVENTORY_CREATE", true, ParamStyle.BODY),
            Method("inventory.delete", Domain.INVENTORY, "DELETE", "/api/inventories/{inventoryId}", "INVENTORY_DELETE", true, ParamStyle.QUERY),
            Method("inventory.detail", Domain.INVENTORY, "GET", "/api/inventories/{inventoryId}", "INVENTORY_DETAIL", true, ParamStyle.QUERY),
            Method("inventory.expiring", Domain.INVENTORY, "GET", "/api/inventories/alerts/expiring", "INVENTORY_EXPIRING", true, ParamStyle.QUERY),
            Method("inventory.list", Domain.INVENTORY, "GET", "/api/inventories", "INVENTORY_LIST", true, ParamStyle.QUERY),
            Method("inventory.listAll", Domain.INVENTORY, "GET", "/api/inventories/all", "INVENTORY_LIST_ALL", true, ParamStyle.QUERY),
            Method("inventory.lock", Domain.INVENTORY, "POST", "/api/inventories/{inventoryId}/lock", "INVENTORY_LOCK", true, ParamStyle.QUERY),
            Method("inventory.lowStock", Domain.INVENTORY, "GET", "/api/inventories/alerts/low-stock", "INVENTORY_LOW_STOCK", true, ParamStyle.QUERY),
            Method("inventory.search", Domain.INVENTORY, "GET", "/api/inventories/search", "INVENTORY_SEARCH", true, ParamStyle.QUERY),
            Method("inventory.statByCategory", Domain.INVENTORY, "GET", "/api/inventories/statistics/by-category", "INVENTORY_BY_CATEGORY", true, ParamStyle.QUERY),
            Method("inventory.statByLocation", Domain.INVENTORY, "GET", "/api/inventories/statistics/by-location", "INVENTORY_BY_LOCATION", true, ParamStyle.QUERY),
            Method("inventory.statByProduct", Domain.INVENTORY, "GET", "/api/inventories/statistics/product/{productId}", "INVENTORY_PRODUCT_STATISTICS", true, ParamStyle.QUERY),
            Method("inventory.statTotal", Domain.INVENTORY, "GET", "/api/inventories/statistics/total", "INVENTORY_TOTAL", true, ParamStyle.QUERY),
            Method("inventory.unlock", Domain.INVENTORY, "POST", "/api/inventories/{inventoryId}/unlock", "INVENTORY_UNLOCK", true, ParamStyle.QUERY),
            Method("inventory.update", Domain.INVENTORY, "PUT", "/api/inventories/{inventoryId}", "INVENTORY_UPDATE", true, ParamStyle.BODY),
            Method("message.clear", Domain.ME, "DELETE", "/api/messages", "UNKNOWN", true, ParamStyle.QUERY),
            Method("message.create", Domain.ME, "POST", "/api/messages", "UNKNOWN", true, ParamStyle.BODY),
            Method("message.delete", Domain.ME, "DELETE", "/api/messages/{messageId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("message.detail", Domain.ME, "GET", "/api/messages/{messageId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("message.list", Domain.ME, "GET", "/api/messages", "UNKNOWN", true, ParamStyle.QUERY),
            Method("message.markAllRead", Domain.ME, "PUT", "/api/messages/read-all", "UNKNOWN", true, ParamStyle.QUERY),
            Method("message.markRead", Domain.ME, "PUT", "/api/messages/{messageId}/read", "UNKNOWN", true, ParamStyle.BODY),
            Method("message.unreadCount", Domain.ME, "GET", "/api/messages/unread-count", "UNKNOWN", true, ParamStyle.QUERY),
            Method("oss.fileCreate", Domain.SYSTEM, "POST", "/api/oss/files", "OSS_FILE_CREATE", true, ParamStyle.BODY),
            Method("oss.presignedUrl", Domain.SYSTEM, "GET", "/api/oss/presigned-url", "OSS_PRESIGNED_URL", true, ParamStyle.QUERY),
            Method("password.change", Domain.ME, "POST", "/api/password/change", "UNKNOWN", true, ParamStyle.BODY),
            Method("password.forgot", Domain.ME, "POST", "/api/password/forgot", "UNKNOWN", true, ParamStyle.BODY),
            Method("password.reset", Domain.ME, "POST", "/api/password/reset", "UNKNOWN", true, ParamStyle.BODY),
            Method("password.strength", Domain.ME, "GET", "/api/password/strength", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.byCode", Domain.ME, "GET", "/api/permissions/code/{code}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.create", Domain.ME, "POST", "/api/permissions", "UNKNOWN", true, ParamStyle.BODY),
            Method("permission.delete", Domain.ME, "DELETE", "/api/permissions/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.detail", Domain.ME, "GET", "/api/permissions/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.list", Domain.ME, "GET", "/api/permissions", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.tree", Domain.ME, "GET", "/api/permissions/tree", "UNKNOWN", true, ParamStyle.QUERY),
            Method("permission.update", Domain.ME, "PUT", "/api/permissions/{id}", "UNKNOWN", true, ParamStyle.BODY),
            Method("product.create", Domain.INVENTORY, "POST", "/api/inventories/products", "PRODUCT_CREATE", true, ParamStyle.BODY),
            Method("product.delete", Domain.INVENTORY, "DELETE", "/api/inventories/products/{productId}", "PRODUCT_DELETE", true, ParamStyle.QUERY),
            Method("product.detail", Domain.INVENTORY, "GET", "/api/inventories/products/{productId}", "PRODUCT_DETAIL", true, ParamStyle.QUERY),
            Method("product.list", Domain.INVENTORY, "GET", "/api/inventories/products", "PRODUCT_LIST", true, ParamStyle.QUERY),
            Method("product.update", Domain.INVENTORY, "PUT", "/api/inventories/products/{productId}", "PRODUCT_UPDATE", true, ParamStyle.BODY),
            Method("profile.avatarDelete", Domain.ME, "DELETE", "/api/profile/avatar", "USER_UPDATE", true, ParamStyle.QUERY),
            Method("profile.avatarImage", Domain.ME, "GET", "/api/profile/{userId}/avatar/image", "UNKNOWN", true, ParamStyle.QUERY),
            Method("profile.avatarUpload", Domain.ME, "POST", "/api/profile/avatar", "USER_UPDATE", true, ParamStyle.QUERY),
            Method("profile.get", Domain.ME, "GET", "/api/profile", "USER_CURRENT", true, ParamStyle.QUERY),
            Method("profile.settings", Domain.ME, "GET", "/api/profile/settings", "USER_CURRENT", true, ParamStyle.QUERY),
            Method("profile.settingsUpdate", Domain.ME, "PUT", "/api/profile/settings", "USER_UPDATE", true, ParamStyle.BODY),
            Method("profile.update", Domain.ME, "PUT", "/api/profile", "USER_UPDATE", true, ParamStyle.BODY),
            Method("report.create", Domain.SYSTEM, "POST", "/api/reports", "UNKNOWN", true, ParamStyle.BODY),
            Method("report.detail", Domain.SYSTEM, "GET", "/api/reports/{taskId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("report.execute", Domain.SYSTEM, "POST", "/api/reports/{taskId}/execute", "UNKNOWN", true, ParamStyle.BODY),
            Method("report.exports", Domain.SYSTEM, "GET", "/api/reports/{taskId}/exports", "UNKNOWN", true, ParamStyle.QUERY),
            Method("report.list", Domain.SYSTEM, "GET", "/api/reports", "UNKNOWN", true, ParamStyle.QUERY),
            Method("rfid.report", Domain.SYSTEM, "POST", "/rfid/report", "UNKNOWN", true, ParamStyle.BODY),
            Method("role.assignPermissions", Domain.ME, "POST", "/api/roles/{roleId}/permissions", "UNKNOWN", true, ParamStyle.BODY),
            Method("role.byName", Domain.ME, "GET", "/api/roles/name/{name}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("role.create", Domain.ME, "POST", "/api/roles", "UNKNOWN", true, ParamStyle.BODY),
            Method("role.delete", Domain.ME, "DELETE", "/api/roles/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("role.detail", Domain.ME, "GET", "/api/roles/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("role.list", Domain.ME, "GET", "/api/roles", "UNKNOWN", true, ParamStyle.QUERY),
            Method("role.permissions", Domain.ME, "GET", "/api/roles/{roleId}/permissions", "UNKNOWN", true, ParamStyle.QUERY),
            Method("role.update", Domain.ME, "PUT", "/api/roles/{id}", "UNKNOWN", true, ParamStyle.BODY),
            Method("stockOrder.addItem", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/items", "UNKNOWN", true, ParamStyle.BODY),
            Method("stockOrder.audit", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/audit", "UNKNOWN", true, ParamStyle.BODY),
            Method("stockOrder.create", Domain.INVENTORY, "POST", "/api/stock-orders", "STOCK_ORDER_CREATE", true, ParamStyle.BODY),
            Method("stockOrder.detail", Domain.INVENTORY, "GET", "/api/stock-orders/{orderId}", "STOCK_ORDER_DETAIL", true, ParamStyle.QUERY),
            Method("stockOrder.list", Domain.INVENTORY, "GET", "/api/stock-orders", "STOCK_ORDER_LIST", true, ParamStyle.QUERY),
            Method("stockOrder.removeItem", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/items/{tagId}/remove", "UNKNOWN", true, ParamStyle.BODY),
            Method("stockOrder.submit", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/submit", "STOCK_ORDER_SUBMIT", true, ParamStyle.BODY),
            Method("stockOrder.update", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/update", "UNKNOWN", true, ParamStyle.BODY),
            Method("stockOrder.withdraw", Domain.INVENTORY, "POST", "/api/stock-orders/{orderId}/withdraw", "UNKNOWN", true, ParamStyle.BODY),
            Method("sync.data", Domain.SYSTEM, "POST", "/api/sync/data", "UNKNOWN", true, ParamStyle.BODY),
            Method("tag.batchBind", Domain.INVENTORY, "POST", "/api/tag/batch-bind", "TAG_BATCH_BIND", true, ParamStyle.BODY),
            Method("tag.batchBindWithCaptcha", Domain.INVENTORY, "POST", "/api/tag/batch-bind-with-captcha", "TAG_BATCH_BIND", true, ParamStyle.BODY),
            Method("tag.batchQuery", Domain.INVENTORY, "POST", "/api/tag/batch-query", "TAG_LIST", true, ParamStyle.BODY),
            Method("tag.batchUnbind", Domain.INVENTORY, "POST", "/api/tag/batch-unbind", "TAG_BATCH_UNBIND", true, ParamStyle.BODY),
            Method("tag.bind", Domain.INVENTORY, "POST", "/api/tag/{tagId}/bind", "TAG_BIND", true, ParamStyle.QUERY),
            Method("tag.byCode", Domain.INVENTORY, "GET", "/api/tag/code/{tagCode}", "TAG_DETAIL", true, ParamStyle.QUERY),
            Method("tag.byProduct", Domain.INVENTORY, "GET", "/api/tag/product/{productId}", "TAG_LIST", true, ParamStyle.QUERY),
            Method("tag.create", Domain.INVENTORY, "POST", "/api/tag", "TAG_CREATE", true, ParamStyle.BODY),
            Method("tag.delete", Domain.INVENTORY, "DELETE", "/api/tag/{tagId}", "TAG_DELETE", true, ParamStyle.QUERY),
            Method("tag.detail", Domain.INVENTORY, "GET", "/api/tag/{tagId}", "TAG_DETAIL", true, ParamStyle.QUERY),
            Method("tag.list", Domain.INVENTORY, "GET", "/api/tag", "TAG_LIST", true, ParamStyle.QUERY),
            Method("tag.search", Domain.INVENTORY, "GET", "/api/tag/search", "TAG_LIST", true, ParamStyle.QUERY),
            Method("tag.unbind", Domain.INVENTORY, "POST", "/api/tag/{tagId}/unbind", "TAG_UNBIND", true, ParamStyle.BODY),
            Method("tag.update", Domain.INVENTORY, "PUT", "/api/tag/{tagId}", "TAG_UPDATE", true, ParamStyle.BODY),
            Method("user.assignRoles", Domain.ME, "POST", "/api/users/{userId}/roles", "UNKNOWN", true, ParamStyle.BODY),
            Method("user.changePassword", Domain.ME, "POST", "/api/users/current/password", "USER_CHANGE_PASSWORD", true, ParamStyle.BODY),
            Method("user.clearRoles", Domain.ME, "DELETE", "/api/users/{userId}/roles", "UNKNOWN", true, ParamStyle.QUERY),
            Method("user.create", Domain.ME, "POST", "/api/users", "USER_CREATE", true, ParamStyle.BODY),
            Method("user.current", Domain.ME, "GET", "/api/users/current", "USER_CURRENT", true, ParamStyle.QUERY),
            Method("user.delete", Domain.ME, "DELETE", "/api/users/{userId}", "USER_DELETE", true, ParamStyle.QUERY),
            Method("user.deleteWithCaptcha", Domain.ME, "POST", "/api/users/{userId}/delete-with-captcha", "USER_DELETE", true, ParamStyle.BODY),
            Method("user.detail", Domain.ME, "GET", "/api/users/{userId}", "USER_DETAIL", true, ParamStyle.QUERY),
            Method("user.list", Domain.ME, "GET", "/api/users", "USER_LIST", true, ParamStyle.QUERY),
            Method("user.removeRole", Domain.ME, "DELETE", "/api/users/{userId}/roles/{roleId}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("user.resetPassword", Domain.ME, "POST", "/api/users/{userId}/password", "USER_CHANGE_PASSWORD", true, ParamStyle.BODY),
            Method("user.roles", Domain.ME, "GET", "/api/users/{userId}/roles", "UNKNOWN", true, ParamStyle.QUERY),
            Method("user.update", Domain.ME, "PUT", "/api/users/{userId}", "USER_UPDATE", true, ParamStyle.BODY),
            Method("warehouse.create", Domain.INVENTORY, "POST", "/api/warehouse", "UNKNOWN", true, ParamStyle.BODY),
            Method("warehouse.delete", Domain.INVENTORY, "DELETE", "/api/warehouse/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("warehouse.detail", Domain.INVENTORY, "GET", "/api/warehouse/{id}", "UNKNOWN", true, ParamStyle.QUERY),
            Method("warehouse.list", Domain.INVENTORY, "GET", "/api/warehouse", "UNKNOWN", true, ParamStyle.QUERY),
            Method("warehouse.update", Domain.INVENTORY, "PUT", "/api/warehouse/{id}", "UNKNOWN", true, ParamStyle.BODY),
        )

    private val index: Map<String, Method> = methods.associateBy { it.id }

    /** 按方法 id 查表；未登记返回 null（调用方转成 BRIDGE_METHOD_UNKNOWN）。 */
    fun find(id: String): Method? = index[id]

    /** 某一级域下的全部方法。 */
    fun of(domain: Domain): List<Method> = methods.filter { it.domain == domain }

    /** 刻意不暴露给 Web 的路由（共 2 条），仅用于文档与一致性校验。 */
    val excluded: List<Method> =
        listOf(
            Method("auth.refreshToken", Domain.SYSTEM, "POST", "/api/auth/refresh-token", "UNKNOWN", false, ParamStyle.BODY),
            Method("health.minio", Domain.SYSTEM, "GET", "/api/health/minio", "UNKNOWN", false, ParamStyle.QUERY),
        )
}
