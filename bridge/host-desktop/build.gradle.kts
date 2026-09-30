// :bridge:host-desktop —— 桌面侧桥宿主（独立 JVM 进程）。
//
// 由 Electron 主进程 spawn 启动；启动后：
//   1. 绑定 127.0.0.1 的临时端口（port=0）
//   2. 生成一次性握手 token，并**从 stdout 输出首行 JSON**
//   3. 开始服务，直到 stdin 收到 shutdown
//
// 为什么不用 shadow/fat-jar：`application` 插件的 installDist 已经产出
// `build/install/host-desktop/lib/*.jar`，jlink 运行时用 `-cp "lib/*"` 直接跑，
// 少一个第三方打包插件（依赖越少，离线构建越稳）。

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    application
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":bridge:protocol"))
    implementation(project(":bridge:backend"))
    implementation(project(":bridge:capability"))
    implementation(project(":bridge:server"))
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

application {
    mainClass.set("com.huicang.wise.bridge.host.desktop.MainKt")
    applicationName = "wise-bridge"
}

tasks.test {
    useJUnitPlatform()
}
