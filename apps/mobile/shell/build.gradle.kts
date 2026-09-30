// :apps:mobile:shell —— 手机壳（Android）。
//
// 职责只有四件：WebView 宿主、进程内启动同一份 Netty 桥、平台能力适配、__bridge.json 引导。
// 不复用旧 App 的任何模块（旧版已冻结在 .archive/，见 docs/legacy.md）。
//
// 用 `-Pwise.skipAndroid` 可在纯 JVM 流水线中跳过本模块（见 settings.gradle.kts）。

// `signingConfigs` 里拿到的类型是 AGP **新 DSL** 的 `ApkSigningConfig`
// （不是 `SigningConfig`）—— 不显式 import 或写错类型都会 Unresolved / Type mismatch。
import com.android.build.api.dsl.ApkSigningConfig

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
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
        // 后端地址与旧 APP 同套路：写在经 gitignore 的 local.properties 里（键 BASE_URL），
        // 换环境不用改代码、也不用重新评审源码。
        buildConfigField("String", "WISE_BACKEND_URL", "\"${backendUrl()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Netty 在 minSdk 25 上会引到 Java 8+ 并发 API，必须开脱糖
        isCoreLibraryDesugaringEnabled = true
    }

    /**
     * release 签名。凭据全部来自 **gitignored 的 `local.properties`** ——
     * 密钥库与口令都不进仓库（`.gitignore` 里已有 `*.jks` / `*.keystore` / `local.properties`）。
     *
     * 需要四个键（用 `scripts/make-keystore.ps1` 一次性生成）：
     * ```
     * RELEASE_STORE_FILE=keystore/wise-release.jks
     * RELEASE_STORE_PASSWORD=…
     * RELEASE_KEY_ALIAS=wise-release
     * RELEASE_KEY_PASSWORD=…
     * ```
     *
     * 没配置就返回 null：构建照常，但 release 包**未签名**（装不上真机），
     * 所以这里要吵 —— 安静地产出一个不能用的包，比构建失败更糟。
     *
     * 注意：这个函数**必须写在 `android { }` 里**，因为 `signingConfigs` 只在这里可见
     * （放顶层会编译不过：Unresolved reference: signingConfigs）。
     */
    fun releaseSigning(): ApkSigningConfig? {
        val storeFile = prop("RELEASE_STORE_FILE")
        val storePassword = prop("RELEASE_STORE_PASSWORD")
        val keyAlias = prop("RELEASE_KEY_ALIAS")
        val keyPassword = prop("RELEASE_KEY_PASSWORD")
        val file = if (storeFile.isBlank()) null else rootProject.file(storeFile)

        if (file == null || !file.exists() || storePassword.isBlank() || keyAlias.isBlank() || keyPassword.isBlank()) {
            logger.warn(
                "[wise] release 未配置签名（缺 RELEASE_STORE_FILE / RELEASE_STORE_PASSWORD / " +
                    "RELEASE_KEY_ALIAS / RELEASE_KEY_PASSWORD）。assembleRelease 会产出**未签名**的 APK，" +
                    "装不上真机。先跑 scripts/make-keystore.ps1。",
            )
            return null
        }
        return signingConfigs.create("release") {
            this.storeFile = file
            this.storePassword = storePassword
            this.keyAlias = keyAlias
            this.keyPassword = keyPassword
            // v1 保留：minSdk 25 上仍可能有只认 v1 的旧设备；v2/v3 是新系统的默认要求
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            /*
             * 签名配置**只在凭据存在时**挂上；没有就保持未签名，并在配置阶段大声提醒。
             *
             * 为什么不给一个"默认调试签名"：那会产出一个看起来能装、实际不能发布、
             * 而且**换了机器就装不上**（签名不同）的包 —— 这种包最容易被误当成成品交付。
             */
            releaseSigning()?.let { signingConfig = it }
        }
    }

    packaging {
        resources {
            // Netty 靠它做版本探测；R8 阶段另有 keep 规则，这里先保证不被打包剥离
            pickFirsts += setOf("META-INF/io.netty.versions.properties", "META-INF/INDEX.LIST")
        }
    }
}

/** 读 local.properties 的 BASE_URL；缺省指向文档里登记的业务机。 */
fun backendUrl(): String {
    val props = rootProject.file("local.properties")
    if (props.exists()) {
        val line = props.readLines().firstOrNull { it.trim().startsWith("BASE_URL") }
        val value = line?.substringAfter('=')?.trim()
        if (!value.isNullOrBlank()) {
            return value.trimEnd('/') + "/"
        }
    }
    return "http://10.0.0.7:8080/"
}

/** 读 `local.properties` 的一个键（缺省空串）。 */
fun prop(key: String): String {
    val props = rootProject.file("local.properties")
    if (!props.exists()) {
        return ""
    }
    return props.readLines().firstOrNull { it.trim().startsWith(key) }?.substringAfter('=')?.trim().orEmpty()
}


// 把 Web 产物塞进 assets：壳只装"已构建好的那份产物"，不在这里跑 vite。
// 落点是 assets 根的 `web/`，于是 URL 是 `/assets/web/index.html`
// （WebViewAssetLoader 的 AssetsPathHandler 会剥掉前缀 `/assets/`）。
val syncWebAssets =
    tasks.register<Sync>("syncWebAssets") {
        from(layout.projectDirectory.dir("../../../apps/web/dist"))
        into(layout.buildDirectory.dir("webAssets/web"))
    }

android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("webAssets"))

tasks.named("preBuild") { dependsOn(syncWebAssets) }

// Android 模块不走根脚本的 subprojects 约定（那个只作用于 kotlin.jvm），
// 因此这里显式声明字节码目标，与桥模块的 Java 17 对齐。
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
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
