// :bridge:capability —— 设备能力**端口**（接口 + DTO），不含任何平台实现。
//
// 端口与适配器（STD-ARCH-05）：本模块只声明"能做什么"，
// 桌面实现在 :bridge:host-desktop，Android 实现在 :apps:mobile:shell。
// Web 侧看到的差异只表现为 capabilities 列表的不同（架构不变式 2）。

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":bridge:protocol"))
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
