package com.huicang.wise.bridge.capability

import kotlinx.serialization.json.JsonElement

/**
 * 平台端口（端口与适配器，STD-ARCH-05）。
 *
 * 桌面实现见 `:bridge:host-desktop`，手机实现见 `:apps:mobile:shell`。
 * **Web 侧的一切平台差异都从 [capabilities] 读**，而不是问"你是桌面还是手机"
 * （架构不变式 2）。[platform] 只用于日志与遥测，不允许出现在业务分支里。
 */
interface PlatformPort {
    /** `desktop` / `mobile`（取值见 `BridgeCapabilities.PLATFORM_*`）。 */
    val platform: String

    /** 宿主产品版本，进引导文件让 UI 能在"关于"里显示。 */
    val version: String

    /** 本平台实际具备的能力集（`BridgeCapabilities` 的 id）。 */
    val capabilities: Set<String>
}

/** 事件下沉：桥把本机事件（扫码/NFC/离线队列变化）推给 Web。 */
fun interface EventSink {
    fun emit(topic: String, data: JsonElement?)
}

/**
 * 本机事件源。桌面与手机各自实现（扫码枪、相机、NFC、离线队列……）。
 *
 * W2 只落骨架：`start` 里注册监听、`stop` 里解绑；W8 把真实设备接上。
 */
interface EventSourcePort {
    fun start(sink: EventSink)
    fun stop()
}

/**
 * 本机方法端口：处理**不经过后端**的桥方法（窗口控制、扫码、文件选择……）。
 *
 * 与后端方法的区别只在"谁来处理"：两者对 Web 是同一个方法空间，
 * 因此白名单必须同时覆盖两边（后端路由由生成器产出，本机的由注册表显式声明）。
 */
interface LocalMethodPort {
    /** 本机方法 id 集合（与后端方法 id 不重叠）。 */
    val methodIds: Set<String>

    /** 调用；未登记的方法不允许走到这里。 */
    suspend fun invoke(methodId: String, params: JsonElement?): JsonElement?
}
