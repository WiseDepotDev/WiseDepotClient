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
#
# 这里原先写着 `-keep resourcefiles META-INF/io.netty.versions.properties` —— 两处都错：
#   · `-keep` 后面只接类声明，`resourcefiles` 会被当成类名 → `Expected interface|class|enum`；
#   · 改成 `-keepresourcefiles` 又被 R8 拒绝（那是 **ProGuard** 的指令，R8 不支持）。
#
# 结论：**这条规则本来就不该存在** —— R8 不会剥掉 JAR 里的非 class 资源，
# 重复项的冲突由 `packaging.resources.pickFirsts` 处理。
# 与其写一条不生效的规则假装"已经保护了"，不如不写，并去 APK 里验证文件确实在（见 §验证）。
# 之所以一直没暴露：release 构建从来没跑过（只跑 debug 不经过 R8）。

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
