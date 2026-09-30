package com.huicang.wise.bridge.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * 四类帧（协议 v3）。
 *
 * ```
 * req  Web→壳    {"v":3,"type":"req","id":"7f3a-1","method":"inventory.list","params":{...}}
 * res  壳→Web    {"v":3,"type":"res","id":"7f3a-1","ok":true,"data":{...},"meta":{...}}
 * err  壳→Web    {"v":3,"type":"err","id":"7f3a-1","error":{"code":"RES-4010",...}}
 * evt  壳→Web    {"v":3,"type":"evt","topic":"scan.code","data":{...}}
 * ```
 *
 * `type` 就是 kotlinx.serialization 的多态判别字段（见 [BridgeCodec.json]），
 * 因此这个 sealed 层次是**唯一**的帧定义，不允许在别处再造一份解析。
 */
@Serializable
sealed class BridgeFrame {
    /** 协议版本，恒为 [BridgeProtocol.VERSION]。 */
    abstract val version: Int
}

/** 请求：Web 发起一个方法调用。 */
@Serializable
@SerialName("req")
data class ReqFrame(
    @SerialName("v") override val version: Int = BridgeProtocol.VERSION,
    val id: String,
    val method: String,
    val params: JsonElement? = null,
    val meta: ReqMeta? = null,
) : BridgeFrame()

/** 成功响应：`data` 就是后端 `payload.data`，已由桥解析完毕。 */
@Serializable
@SerialName("res")
data class ResFrame(
    @SerialName("v") override val version: Int = BridgeProtocol.VERSION,
    val id: String,
    val ok: Boolean = true,
    val data: JsonElement? = null,
    val meta: ResMeta? = null,
) : BridgeFrame()

/** 失败响应。 */
@Serializable
@SerialName("err")
data class ErrFrame(
    @SerialName("v") override val version: Int = BridgeProtocol.VERSION,
    val id: String,
    val error: BridgeError,
) : BridgeFrame()

/** 事件推送（扫码、NFC、离线队列变化、上传进度…）。 */
@Serializable
@SerialName("evt")
data class EvtFrame(
    @SerialName("v") override val version: Int = BridgeProtocol.VERSION,
    val topic: String,
    val data: JsonElement? = null,
) : BridgeFrame()

/** 请求侧附带上报（只用于日志与埋点，不参与业务判定）。 */
@Serializable
data class ReqMeta(
    /** 来源屏标识，如 `inventory/list`；用于把桥日志与 UI 动作对上。 */
    val screen: String? = null,
    /** 链路标识；桥把它透传为后端的 `REQUEST-ID`，与旧版信封口径一致。 */
    val requestId: String? = null,
)

/** 响应侧附带信息。 */
@Serializable
data class ResMeta(
    val ts: Long = 0,
    /** `hit` / `miss` —— 命中本地缓存时 UI 可以少画一次骨架屏。 */
    val cache: String? = null,
    val traceId: String? = null,
)

/**
 * 统一错误体。
 *
 * - `code`：桥错误码（[BridgeErrorCodes]）或**后端原样返回的** `RES-xxxx`；
 * - `messageKey`：给 Web 做 i18n 的键，**不下发文案**；
 * - `retryable`：UI 据此决定是否给"重试"按钮（网络类错误为 true）。
 */
@Serializable
data class BridgeError(
    val code: String,
    val messageKey: String? = null,
    val retryable: Boolean = false,
    val details: JsonElement? = null,
)

/**
 * 帧编解码的**唯一入口**。
 *
 * 参数为什么不放在构造函数默认值里靠调用方自觉：`encodeDefaults` 必须为 true，
 * 否则 `v` 这个字段在网络上是可选的——版本协商就失去依据。
 */
object BridgeCodec {
    /** 全仓唯一的 Json 实例（注释见 [BridgeCodec] 的类说明）。 */
    val json: Json =
        Json {
            classDiscriminator = "type"
            encodeDefaults = true
            ignoreUnknownKeys = true
            explicitNulls = false
        }

    /** 编码为文本帧。 */
    fun encode(frame: BridgeFrame): String = json.encodeToString(BridgeFrame.serializer(), frame)

    /** 解码文本帧；非法输入抛 kotlinx.serialization 异常，由调用方兜底成 [BridgeErrorCodes.INTERNAL]。 */
    fun decode(text: String): BridgeFrame = json.decodeFromString(BridgeFrame.serializer(), text)
}
