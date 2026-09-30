# 旧客户端归档记录

> 完整清单与恢复步骤见 **`../.archive/ARCHIVE.md`**（本文件只记录"从新仓库怎么找回去"）。

## 位置

| 内容 | 路径（相对工作区根 `E:\code_space\WiseDepot`） |
| --- | --- |
| 旧 Android APP（含自身 `.git` + 工作区） | `.archive/wise-depot-android-refactor/` |
| 全量历史 bundle | `.archive/_archived-manifests/wise-depot-android-refactor.bundle` |
| 未提交改动补丁 + 未跟踪文件清单 | `.archive/_archived-manifests/worktree-vs-head.patch` |
| 归档说明 | `.archive/ARCHIVE.md` |

## 回滚点

| ref | commit |
| --- | --- |
| tag `archive/app-v1-final` | `697a1fd2baa710c5ff472296a0809683ad6de6c7` |
| branch `archive/app-v1` | 同上 |
| tag `baseline-20260227`（归档前已存在） | — |

## 三条必须知道的事实

1. **归档时工作区不干净**：41 个已跟踪文件被修改、15 个未跟踪文件（B2–B7 批的 UI 组件与布局源码）。
   这些改动**没有被提交**，因此上面的 tag **不含它们**；它们随目录整体搬移而保留，也另有 patch 备份。
2. **没有远端**：旧仓库未配置任何 remote，计划中的 `git push --tags` 无法执行。归档点只存在于本地磁盘与 bundle。
3. **旧工具链已断链**：`tools/wsa-deploy-app.ps1`、`tools/app-ui-metrics.ps1`、`deploy/check_apk_base_url.py`、
   `deploy/deploy_app.py` 以及 `WiseDeoptServer/tools/gen/gen-packet-types.js` 的 `OUT_FILE`
   都仍指向旧路径 `WiseDepotApp/wise-depot-android-refactor`（该目录已不存在）。
   其中 `gen-packet-types.js` 的 `OUT_FILE` **在归档前就已经是错的**（指向 `app/.../PacketTypeMap.kt`，
   而该文件在 P6 多模块重构后实际位于 `core/network/src/main/java/...`）——本仓库的
   `tools/gen/gen-bridge-contract.js` 接替了它，并用**交叉校验**固定了这件事：
   `pnpm check:contract:legacy` 会把新桥生成的路由集与归档区里那份 `PacketTypeMap.kt` 逐条比对。

## 从新仓库怎么用旧资产

```powershell
# 1. 契约交叉校验（就是上面那条；证明重构没在契约层丢接口）
cd WiseDepotClient
pnpm check:contract:legacy

# 2. 功能对照清单（旧 29 屏 / 19 路由 → 新四域 + 167 方法）
pnpm gen:parity
```

> 这两条是旧仓库对新仓库**唯一**的输入：一份契约证据 + 一份功能清单。
> 新仓库的构建图**不引用**旧仓库的任何产物（无 submodule、无 Gradle include、无拷贝源码），
> 这是"不受旧版影响"的硬保证。
