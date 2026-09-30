// 根构建脚本：只登记插件，不配置任何子模块。
// 约定（沿用旧仓纪律）：模块脚本里不得出现版本号与编译参数，一切走 gradle/libs.versions.toml
// 与 build-logic 约定插件；本仓库的约定插件在 :bridge:* 与 :apps:mobile:shell 各自的脚本里显式声明，
// 不引入额外 buildSrc 层（桥的模块数很少，约定插件的抽象成本高于收益）。

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.android.application) apply false
}
