// :bridge:backend —— 后端访问层（统一信封 + 令牌 + 缓存 + 重试）。
//
// 用 OkHttp：它是**同时存在于 JVM 与 Android** 的库，因此这一层的一份代码两端都能跑，
// 不需要为桌面/手机写两套 HTTP 客户端（这是"单份桥"能成立的关键选型之一）。
// W2 实现；W0 只固定依赖方向与依赖集。

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(project(":bridge:protocol"))
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
