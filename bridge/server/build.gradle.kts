// :bridge:server —— Netty 传输层（握手 / 会话 / 方法分发 / 限流 / 背压）。
//
// 这是"手机与电脑均使用 Netty"的落点：同一份传输代码，
// 桌面由 :bridge:host-desktop 以独立 JVM 进程启动，手机由 :apps:mobile:shell 进程内启动。
// 传输在 TransportPort 之后，若移动端 Spike 不达标，只换手机侧实现，本模块与协议层不动。

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(project(":bridge:protocol"))
    implementation(project(":bridge:backend"))
    implementation(project(":bridge:capability"))

    // Netty 最小集：只为 WebSocket 握手 + 文本帧
    implementation(libs.netty.transport)
    implementation(libs.netty.handler)
    implementation(libs.netty.codec.http)

    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit.jupiter)
    // 端到端用真 socket + 一个假后端：`MockWebServer` 用来验"后端怎么答，桥就怎么判"
    // （会话续期、超时、错误码映射），不必起真的服务端。
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
