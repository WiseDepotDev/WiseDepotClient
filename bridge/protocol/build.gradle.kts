// :bridge:protocol —— 桥协议层。
//
// 硬约束（见 docs/architecture.md §依赖方向）：
//   1. 不依赖 Netty、不依赖 Android、不依赖 OkHttp —— 只有 kotlinx.serialization。
//   2. 只允许使用 Android API 25+ 存在的 java.* API（禁 java.lang.management 等）；
//      CI 通过"bridge 变更必编译 Android 模块"把这条纪律变成门禁。
//   3. BridgeContract.kt 由 tools/gen/gen-bridge-contract.js 生成，禁止手改。

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.kotlinx.serialization.json)

    testImplementation(kotlin("test"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
