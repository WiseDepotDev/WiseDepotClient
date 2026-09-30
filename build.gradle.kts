// 根构建脚本：只登记插件 + 一处编译目标约定，不配置任何具体模块。
//
// 约定（沿用旧仓纪律）：模块脚本里不得出现版本号与编译参数 —— 版本走 gradle/libs.versions.toml，
// 编译目标走下面的 subprojects 块。这样"桥的字节码目标"只有一处定义，
// 不会出现"某个模块悄悄用了 Java 21 字节码，结果 Android 侧 D8 吃不下"这种事故。

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.android.application) apply false
}

// 为什么不用 jvmToolchain(17)：toolchain 需要本机存在 JDK 17 或配置 foojay 自动下载器，
// 两者都不是本项目的前提。这里改用"用当前 JDK 编译、产出 Java 17 字节码"，
// 效果对 Android 消费方等价，且不引入任何下载依赖。
subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
            compilerOptions {
                jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
            }
        }
        extensions.configure<JavaPluginExtension> {
            sourceCompatibility = JavaVersion.VERSION_17
            targetCompatibility = JavaVersion.VERSION_17
        }
    }
}
