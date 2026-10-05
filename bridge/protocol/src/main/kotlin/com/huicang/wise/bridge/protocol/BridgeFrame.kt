package com.huicang.wise.bridge.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * 逻辑帧（协议 v4）。
 *
 * ## 与 v3 的差别：帧头搬到了线上
 *
 * v3 把版本与判别字段写在 JSON 正文里（`{"v":3,"type":"req","id":"…"}`），
 * 于是"线格式"这件事同时存在于**正文结构**和**解析代码**两处。
 * v4 把 `ver` / `kind` / `id` 全部收进 12 字节二进制帧头（见 [BridgeWire]），
 * 正文只描述语义，模型里也就**不再有**版本与判别字段 —— 线格式只有一处定义。
 *
 * ## 为什么不是 `@Serializable` 了
 *
 * v3 的 `sealed class` 靠 kotlinx.serialization 的多态判别（`classDiscriminator = "type"`）
 * 来完成编解码。判别字段已经搬进帧头，多态序列化就不再需要；
 * 而 [BinFrame] 装的是不透明字节，本来也不该走 JSON。因此这一层退化成普通的密封类，
 * 只有正文 DTO（[ReqBody] 等）才是 `@Serializable`。
 */
sealed class BridgeFrame

/** 请求：Web 发起一个方法调用。 */
data class ReqFrame(
    val id: String,
    val method: String,
    val params: JsonElement? = null,
    val meta: ReqMeta? = null,
) : BridgeFrame()

/** 成功响应：`data` 就是后端 `payload.data`，已由桥解析完毕。 */
data class ResFrame(
    val id: String,
    val data: JsonElement? = null,
    val meta: ResMeta? = null,
) : BridgeFrame()

/**
 * 失败响应。
 *
 * v3 里成功帧还带一个 `ok: true` 字段；v4 **删掉它**：成功与否已经由帧头的 `kind` 表达，
 * 两个地方各存一份"这次成功了吗"必然会写出互相矛盾的数据（同 `id` 只放帧头一个道理）。
 */
data class ErrFrame(
    val id: String,
    val error: BridgeError,
) : BridgeFrame()

/** 事件推送（扫码、NFC、离线队列变化、上传进度…）。事件没有请求 id。 */
data class EvtFrame(
    val topic: String,
    val data: JsonElement? = null,
) : BridgeFrame()

/**
 * 二进制对象/分片（v4 数据面）。**不透明字节**，不进 JSON、不做 base64。
 *
 * `final = true` 表示本 id 的最后一片；同一个 id 的多条 [BinFrame] 按到达顺序拼接
 * （WebSocket 保证消息有序，所以协议里**不需要**序号或窗口协商）。
 */
class BinFrame(
    val id: String,
    val body: ByteArray,
    val final: Boolean = true,
) : BridgeFrame()

/**
 * 握手 hello（v5）：**唯一允许明文的帧**，方向固定"壳 → 客户端"，一条连接最多一条。
 *
 * 只承载服务端这次的**临时公钥**（hex 的未压缩点）。它**不是协议协商** ——
 * 版本与上限仍然只由 `__bridge.json` 与帧头表达（"协商只有一个 owner"这条纪律不破），
 * 这里交换的只是密钥材料（见 `docs/protocol.md` 的 v5 加密层）。
 */
data class HelloFrame(
    /** 服务端临时公钥：`0x04‖X(32)‖Y(32)` 的 hex（130 字符）。 */
    val publicKeyHex: String,
) : BridgeFrame()

/** 帧头里的关联 id；事件帧与 hello 帧没有 id（编码时写 0 长度）。 */
internal val BridgeFrame.wireId: String
    get() =
        when (this) {
            is ReqFrame -> id
            is ResFrame -> id
            is ErrFrame -> id
            is BinFrame -> id
            is EvtFrame -> ""
            is HelloFrame -> ""
        }

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
 * 全仓唯一的 JSON 配置。
 *
 * `encodeDefaults = true` 仍然必要：正文 DTO 里的 `cache = "miss"` 这类**默认值就是语义**，
 * 省掉它就等于丢了信息（v3 的注释把它写成"版本协商的依据"，那条理由随帧头搬走了，纪律留下）。
 */
object BridgeCodec {
    val json: Json =
        Json {
            encodeDefaults = true
            ignoreUnknownKeys = true
            explicitNulls = false
        }
}
