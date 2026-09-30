# 真后端冒烟记录（W3 收尾）

> 脚本：`node tools/bench/real-smoke.mjs [--user operator|admin] [--backend URL]`
> 目标后端：`http://127.0.0.1:18080`（本机 docker 栈之上的真实 WiseDeoptServer）

## 0. 为什么现在能自动化

登录要过验证码，而验证码是给人看的图 —— 原先它是"必须人工"的那一步。
本机后端把验证码存在**自己的 Redis**里（键名 `captcha:<captchaId>`），
因此测试可以从那里读答案。

> **这不是绕过漏洞，是测试基础设施**：它只用于本机开发栈上的自动回归。
> 生产环境不该有这条路径；脚本本身也不硬编码任何口令——
> Redis 口令与账号口令都从 `deploy/.env.local` 读（STD-SEC-01 零硬编码）。

## 1. 实测结果

两个账号各跑一遍，**均 11/11 通过**。

| 用例 | operator | admin |
| --- | --- | --- |
| `bridge.session` 未登录 | ✓ | ✓ |
| `captcha.generate` 返回真验证码（`data:image/png;base64`，约 1.3–1.5KB） | ✓ | ✓ |
| 从后端自己的 Redis 取到答案 | ✓ | ✓ |
| **`auth.login` 真登录成功** | ✓ `operator` | ✓ `admin` |
| **登录响应不含令牌** | ✓ | ✓ |
| 登录后 `bridge.session.authenticated = true` | ✓ | ✓ |
| `dashboard.summary` 返回真看板数据 | ✓ 库存 0 / 告警 0 / 在线 0 | ✓ 同 |
| `inventory.list` 分页真数据（路径/查询串拆分对真后端成立） | ✓ total=0 | ✓ total=0 |
| `user.list` | ✓ **被拒 `AUTH-0005`**（operator 无用户管理权限） | ✓ **2 个账号：operator, admin** |
| 登出后会话清空 | ✓ | ✓ |
| **全程 9 帧无令牌泄漏** | ✓ | ✓ |

### 三个值得单独记的结论

1. **`user.list` 被拒是正向证据，不是失败。** 桥只做转发，权限判定仍然完全由后端的
   `@RequiresPermission` 负责 —— 这条用例证明了**授权链在桥的路径上没有被绕过**。
   想看非空数据就换 `--user admin`。
2. **空库也能验出"形状对"，但验不出"值对"。** `dashboard`/`inventory` 在本地空库上返回 0，
   因此补了 `user.list`（账号由 `DataInitializer` 播种，必有数据）来验证真值。
3. **登录响应里的 `accessToken`/`refreshToken` 位置是 `null` 而不是缺字段**——
   形状稳定，前端不需要处理"有没有这个 key"。

## 2. 真机（Android）冒烟：**未完成，原因明确**

| 项 | 结果 |
| --- | --- |
| `adb devices` | 空 |
| WSA 进程 | 在跑（`WsaService` + `WsaClient` + `vmwp`） |
| `adb connect 127.0.0.1:58526` | **连接被拒**（`58526` 未监听） |

WSA 的 adb 桥没开（需要在 WSA 设置里启用开发者/无线调试，CLI 无法代劳）。
因此**"装到真机跑起来"这一条仍未验证**，命令如下，开启后即可执行：

```powershell
# 1. 打开 WSA 设置 → 开发者 → 开启"无线调试"，记下端口（默认 58526）
adb connect 127.0.0.1:58526
adb devices                                    # 应看到 device
# 2. 装壳（壳里已经带着当前 Web 产物）
adb install -r apps\mobile\shell\build\outputs\apk\debug\shell-debug.apk
# 3. 起桥 + 看日志（ShellApplication 在进程内启动桥）
adb logcat -s WiseShell:* chromium:*
# 4. 或接真机：adb reverse 不需要（桥在本机回环），直接把 BASE_URL 指到业务机即可
```

## 3. 已经验到的替代证据（在无设备情况下能拿到的最强证据）

`mobile-spike` 与 APK 内容检查：

| 项 | 实测 |
| --- | --- |
| APK 编译 | BUILD SUCCESSFUL |
| **Netty 最小集 dex 增量** | **1.23MB**（门禁 ≤1.5MB） |
| APK 内含当前 Web 产物 | ✓ `assets/web/index.html` + `index-Dv9HOiKH.js`(24KB) + `index-DbIAxajp.css`(17KB) + `vendor-react.js`(223KB) |
| dex 文件 | 8 个（classes.dex 10.2MB + classes2–8） |
| **`__bridge.json` 没有被烘进包** | ✓（它是宿主动态生成的，烘进去反而说明实现错了） |

> 也就是说：**"装了什么"已经查清，欠的只是"在 Android 上跑起来"这一步。**

## 4. 复现命令

```powershell
# 静态门禁（不需要 Gradle）
pnpm check

# 桥的验收（需要先 gradlew :bridge:host-desktop:installDist）
pnpm bench            # 真 spawn JVM：鉴权 / 白名单 / 限流 / 往返性能
pnpm bench:w3         # 假后端：令牌截留 / 自动续期重放（确定性边界）
node tools/bench/real-smoke.mjs            # 真后端：operator 视角
node tools/bench/real-smoke.mjs --user admin  # 真后端：admin 视角（非空数据）

# 桌面与移动
pnpm bench:desktop    # 子进程生命周期 + 路径穿越防线
pnpm bench:mobile     # APK 与 Netty dex 门禁（无设备时明确标记"未测量"）
```
