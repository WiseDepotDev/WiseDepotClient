package com.huicang.wise.client.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * **Android 系统通知**（通知栏）—— 桥的 `notify.message` 事件在这里变成一条通知。
 *
 * ## 为什么由壳弹，而不是页面
 *
 * 通知最该出现的时刻是"应用在后台"，那时 WebView 里的 JS 可能已经被系统冻结；
 * 而桥与壳在**同一个进程**里（见 [ShellBridge]），所以直接订阅 `server.onEvent` 就够了 ——
 * 不经过 WebView，也不依赖页面还活着。
 *
 * ## 两个渠道（用户可以在系统里分别关）
 *
 * | 渠道 | 用途 | 重要性 |
 * | --- | --- | --- |
 * | [CHANNEL_AUDIBLE] | `priority >= 1`：告警、巡检下发 | `IMPORTANCE_HIGH`（横幅 + 声音） |
 * | [CHANNEL_SILENT] | 其余（含未知类型） | `IMPORTANCE_DEFAULT`（只进通知栏） |
 *
 * 分成两个渠道而不是一个，是因为"重要消息要有声"这件事**必须让用户能分别关**：
 * 合成一个的话，用户嫌吵只能连重要的也一起关掉。
 *
 * ## 权限
 *
 * Android 13（API 33）起要 `POST_NOTIFICATIONS` 运行时权限。被拒时：
 *  · 这里**不发**通知（发了也不会显示）；
 *  · `ShellBridge` **撤回国能力声明** `notify.system`（"声明即承诺"）。
 */
object MessageNotifier {
    const val CHANNEL_AUDIBLE: String = "wise-message-alert"
    const val CHANNEL_SILENT: String = "wise-message"

    /** 通知栏里的分组：同一个应用的通知不互相顶掉。 */
    private const val GROUP_KEY = "wise.messages"

    /**
     * 深链前缀：与 Web 路由一致（`message.detail` → `/me/messages/:messageId`）。
     *
     * 壳只认"前缀 + 消息 id"，**不理解业务实体**（`relatedEntityType/Id` 由 Web 层决定要不要再跳）。
     * 三处一致由 `tools/check/check-notify.mjs` 对账。
     */
    const val MESSAGE_ROUTE_PREFIX: String = "/me/messages/"

    /**
     * 通知点击带进 Activity 的深链（例如 `/me/messages/123`）。
     *
     * 定义在这里而不是 `MainActivity`：它是**通知这条链**的契约（谁放进来、谁读），
     * 放在一起就不需要"两个文件各写一份"。
     */
    const val EXTRA_ROUTE: String = "route"

    /** 建渠道（幂等）。API 26 之前没有渠道概念，直接跳过。 */
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_AUDIBLE, "重要消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "告警与巡检任务下发等需要留意的消息"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_SILENT, "一般消息", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "系统公告与其它通知（不响铃）"
            },
        )
    }

    /** 通知权限是否已授予（API 33 之前恒 true）。 */
    fun permissionGranted(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * 弹一条消息通知。
     *
     * @return 真的弹了返回 `true`；因"没有权限 / 应用在前台 / 缺 id 或标题"而**故意不弹**返回 `false`
     *   （调用方据此打日志 —— "没弹"必须能解释）。
     */
    fun show(
        context: Context,
        id: String,
        title: String,
        body: String,
        audible: Boolean,
        foreground: Boolean,
    ): Boolean {
        if (id.isEmpty() || title.isEmpty()) {
            return false
        }
        // 前台不弹：用户正看着界面，界面自己会在 10 秒内刷新出这条消息
        if (foreground) {
            return false
        }
        if (!permissionGranted(context)) {
            return false
        }
        ensureChannels(context)

        val route = "$MESSAGE_ROUTE_PREFIX$id"
        val intent =
            Intent(context, MainActivity::class.java).apply {
                // 已经开着就复用它（`singleTask`），只把 route 带进去
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra(EXTRA_ROUTE, route)
            }
        val pending =
            PendingIntent.getActivity(
                context,
                // 每条消息一个 requestCode，否则后一条点击会复用前一条的 Intent
                route.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        val notification =
            NotificationCompat
                .Builder(context, if (audible) CHANNEL_AUDIBLE else CHANNEL_SILENT)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setGroup(GROUP_KEY)
                .setPriority(if (audible) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pending)
                .build()

        return runCatching {
            NotificationManagerCompat.from(context).notify(route.hashCode(), notification)
            true
        }.getOrElse {
            // 权限被系统临时收回、通知被限流…都可能在这里失败；不抛（通知失败不该影响桥）
            android.util.Log.w("WiseShell", "通知未能发出：${it.message}")
            false
        }
    }
}
