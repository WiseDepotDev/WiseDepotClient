# Netty on Android (R8/ProGuard) —— 见 docs/architecture.md §Netty 最小集
#
# 为什么需要这么多 -dontwarn：Android 上没有 java.lang.management，
# 且 Netty 大量使用反射/Unsafe 探测平台能力。R8 无法静态判定，必须显式放行；
# 若这里写少了，失败形态是**运行时** NoClassDefFoundError（比构建失败更难查）。

-dontwarn io.netty.**
-dontwarn org.jboss.marshalling.**
-dontwarn sun.misc.**
-dontwarn java.lang.management.**
-dontwarn javax.annotation.**

# Netty 的平台探测与内部工具类靠反射与静态初始化，必须整包保留
-keep class io.netty.util.internal.** { *; }
-keepnames class io.netty.** { *; }
-keepclassmembers class io.netty.** { *; }

# 版本探测资源（与 packaging.resources.pickFirsts 配套）
-keep resourcefiles META-INF/io.netty.versions.properties

# 桥协议：kotlinx.serialization 生成的序列化器
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.huicang.wise.bridge.** {
    *** Companion;
    <fields>;
}
-keepclasseswithmembers class com.huicang.wise.bridge.** {
    kotlinx.serialization.KSerializer serializer(...);
}
