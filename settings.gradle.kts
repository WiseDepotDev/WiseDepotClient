// WiseDepotClient —— 慧仓智控新客户端（Web UI + 单份 Kotlin/Netty 桥）
//
// 单一 Gradle 根：桥模块（:bridge:*）与手机壳（:apps:mobile:shell）同处一棵树，
// 保证"同一份桥实现被两端复用"在**构建图**上成立，而不是口头约定。
// JS 侧（apps/web、apps/desktop、packages/*）由 pnpm workspace 管理，与本文件互不干涉。

pluginManagement {
    repositories {
        // 与旧仓一致：优先走腾讯云镜像，避免联网拉包失败
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        google()
        mavenCentral()
    }
}

rootProject.name = "WiseDepotClient"

// ---- 桥：唯一实现，桌面（jlink JVM 子进程）与手机（Android 进程内）共用 ----
// 依赖方向严格单向（STD-ARCH-02）：
//   protocol  ← backend / capability / server  ← host-desktop / apps:mobile:shell
// protocol 不含 Netty、不含 Android、不含网络，因此它是纯 JVM 单测与契约测试的靶子。
include(":bridge:protocol")
include(":bridge:backend")
include(":bridge:capability")
include(":bridge:server")
include(":bridge:host-desktop")

// ---- 手机壳：需要 Android SDK 与 AGP ----
// 纯 JVM 流水线（桥单测 / 契约一致性 / 性能基准）用 `-Pwise.skipAndroid` 跳过它，
// 这样"桥的正确性"不被 Android 工具链绑架（与 W2 的移动端传输 Spike 解耦）。
if (!providers.gradleProperty("wise.skipAndroid").isPresent) {
    include(":apps:mobile:shell")
}
