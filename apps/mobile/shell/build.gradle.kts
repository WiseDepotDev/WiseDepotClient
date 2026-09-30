// :apps:mobile:shell —— 手机壳（Android）。
//
// 职责只有四件：WebView 宿主、进程内启动同一份 Netty 桥、平台能力适配、__bridge.json 引导。
// 不复用旧 App 的任何模块（旧版已冻结在 .archive/，见 docs/legacy.md）。
//
// 用 `-Pwise.skipAndroid` 可在纯 JVM 流水线中跳过本模块（见 settings.gradle.kts）。

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.huicang.wise.client.shell"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.huicang.wise.client"
        minSdk = libs.versions.minSdk.get().toInt()   // R3：维持 25
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Netty 在 minSdk 25 上会引到 Java 8+ 并发 API，必须开脱糖
        isCoreLibraryDesugaringEnabled = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    packaging {
        resources {
            // Netty 靠它做版本探测；R8 阶段另有 keep 规则，这里先保证不被打包剥离
            pickFirsts += setOf("META-INF/io.netty.versions.properties", "META-INF/INDEX.LIST")
        }
    }
}

dependencies {
    implementation(project(":bridge:protocol"))
    implementation(project(":bridge:backend"))
    implementation(project(":bridge:capability"))
    implementation(project(":bridge:server"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.core)

    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.3")

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}
