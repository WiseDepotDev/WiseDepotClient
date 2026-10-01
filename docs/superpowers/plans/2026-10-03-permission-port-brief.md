# 简报：permission.* 移植（bridge → 真后端语义）

> **性质**：只读调研产出。本次未修改任何生产代码。
> **权威事实来源**：`WiseDeoptServer/**`（Spring Boot / Java）。
> **契约生成物**：`WiseDepotClient/packages/contract/src/generated/bridgeContract.ts`、`WiseDepotClient/bridge/protocol/src/main/kotlin/com/huicang/wise/bridge/protocol/BridgeContract.kt`。
> **读者前提**：不需要读过本次调研的中间过程，本文自带全部证据（文件:行号 + 原文片段）。
> **调研范围**：契约第 137–143 行的 7 条 `permission.*`，以及"`packetType = UNKNOWN` 能不能调通"。

---

## 0. 一句话结论

| 问题 | 结论 |
| --- | --- |
| `packetType = UNKNOWN` 能不能调通？ | **能调通。** `packetType` 在桥侧、后端侧都**不参与任何分派或校验**，它只是信封 `header.packet_type` 的一个字符串值。 |
| `{id}` 是权限 id 还是 code？ | **权限主键 id（`permission_id`）**；权限编码走另一条 `/api/permissions/code/{code}`。 |
| `permission.list` 分页吗？ | **不分页**，返回**裸数组**，没有 `page`/`size`/`pageSize` 任何参数。 |
| `permission.tree` 有层级吗？ | **实际没有。** 生产路径下 `parentId` 恒为 `null`，`tree` 的输出与 `list` **等价**（详见 §4）。 |
| 写接口真能写吗？ | `permission.update` 可以；**`permission.create` 在真库上几乎必然 500**（`create_by`/`update_by` 是 `NOT NULL` 而服务层不写）；**`permission.delete` 对被角色引用的权限必然 500**（外键无级联）。详见 §7 / §9 与坑 2、3。 |
| 有额外鉴权吗？ | **没有。** 只需要登录态（Bearer），任何已登录用户都能建/改/删权限。详见 §12。 |
| 旧客户端接过吗？ | **没有。** 旧 React 版与旧 Android APP 都只"知道路由"，从未调用过 `permission.*`。注意：`.archive/` 里是**旧 Android APP（Kotlin）**，不是 React 归档。详见 §11。 |

---

## 1. 能不能调通（packetType = UNKNOWN 的后果）

### 裁决

> **`packetType = UNKNOWN` 不影响可调用性。7 条 `permission.*` 全部可被桥正常调用（能不能拿到业务成功另说——见坑 1/2）。**
> `UNKNOWN` 的唯一含义是：**该控制器方法上没有 `@ApiPacketType` 注解，生成器按约定回退成字面量 `"UNKNOWN"`**。它既不阻断路由，也不影响鉴权。

### 证据链

**① 生成器的 `UNKNOWN` 就是"没有注解"的回退值，不是一种特殊类型。**

`WiseDepotClient/tools/gen/gen-bridge-contract.js:131-132`

```js
            const pkt = /@ApiPacketType\s*\(\s*PacketType\.([A-Z0-9_]+)\s*\)/.exec(declSegment);
            const packetType = pkt ? pkt[1] : 'UNKNOWN';
```

`PermissionController` 整个文件没有 `@ApiPacketType`（见 `PermissionController.java:13-16` 的类注解只有 `@Tag`/`@RestController`/`@RequestMapping`），所以 7 条全部落到 `'UNKNOWN'`。

**② 桥的分派逻辑完全不看 `packetType`——只按方法 id 白名单查表。**

`WiseDepotClient/bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeDispatcher.kt:66-86`

```kotlin
        val entry =
            BridgeContract.find(method)
                ?: return BackendResult.Failed(
                    BridgeErrorCodes.METHOD_UNKNOWN,
                    "bridge.methodUnknown",
                    retryable = false,
                )

        val call =
            BackendCall(
                httpMethod = entry.httpMethod,
                pathTemplate = entry.path,
                packetType = entry.packetType,
                ...
```

`packetType` 只是被**搬运**进 `BackendCall`，没有任何 `when (entry.packetType)` 之类的分支。裁决点只有 `BridgeContract.find(method)`（白名单），与 `packetType` 无关。

**③ `packetType` 在桥后端只被写进信封头，不做判断。**

`WiseDepotClient/bridge/backend/src/main/kotlin/com/huicang/wise/bridge/backend/Envelope.kt:40-46`

```kotlin
    fun wrap(packetType: String, requestId: String, data: JsonObject, nowMillis: Long): String {
        val header =
            buildJsonObject {
                put("request_id", requestId)
                put("packet_type", packetType)
                put("timestamp", nowMillis)
            }
```

**④ 后端请求侧只要求"有 header/payload 两个对象"，**从不校验 `packet_type` 的取值**。**

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/handler/GlobalRequestAdvice.java:83-99`

```java
            JsonNode headerNode = rootNode.path("header");
            JsonNode payloadNode = rootNode.path("payload");

            // 决策 3：只支持最新形状。没有统一信封的请求体一律拒绝，不再走过渡期兼容分支。
            if (!headerNode.isObject() || !payloadNode.isObject()) {
                throw new HttpMessageNotReadableException(
                        "请求体缺少统一信封（header/payload）：请按 STD-CONTRACT-01 封装后再请求", originalMessage);
            }
```

`headerNode` 与 `payloadNode` 非空即放行，`packet_type` 甚至没有被读取。仓库里唯一做 `packet_type` 合法性判断的工具类 `ApiConsistencyValidator.isValidPacketType`（`WiseDeoptServer/wise-deopt-common/src/main/java/com/huicang/wise/common/validation/ApiConsistencyValidator.java:21-31`）**在生产代码里没有任何调用点**（全仓 grep 只命中它自己的定义）。

**⑤ `packet_type` 只在**响应**侧被"回填"，且缺失时本来就回落到 UNKNOWN。**

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/handler/GlobalResponseAdvice.java:138-156`

```java
    private String getPacketTypeCode(MethodParameter returnType) {
        Method method = returnType.getMethod();
        if (method == null) {
            return PacketType.UNKNOWN.getCode();
        }
        ...
                    return PacketType.UNKNOWN.getCode();
```

`WiseDeoptServer/wise-deopt-common/src/main/java/com/huicang/wise/common/protocol/PacketType.java:143`

```java
    UNKNOWN("0x0000", "未知类型"),
```

> ⚠️ 一个小口径差异，实现者要知道：契约里写的是**枚举常量名** `UNKNOWN`，而响应头里回填的是**枚举 code** `"0x0000"`。桥侧 `Envelope.unwrap` 根本不读 header（`Envelope.kt:71-81` 只取 `payload`），所以不影响任何行为。

**⑥ 历史旁证：旧 APP 早就用 `UNKNOWN` 打过真后端。**

旧 APP 的 `EnvelopeInterceptor` 就是用这张表定 `packet_type` 的：

`.archive/wise-depot-android-refactor/core/network/src/main/java/com/huicang/wise/network/interceptor/EnvelopeInterceptor.kt:82`

```kotlin
            val packetType = PacketTypeMap.resolve(request.method, request.url.encodedPath)
```

而旧表的 `permission.*` 行本身就是 `UNKNOWN`：

`.archive/wise-depot-android-refactor/core/network/src/main/java/com/huicang/wise/network/PacketTypeMap.kt:127-133`

```kotlin
            Entry("GET", "/api/permissions", packetType = "UNKNOWN"),
            Entry("POST", "/api/permissions", packetType = "UNKNOWN"),
            Entry("DELETE", "/api/permissions/{id}", packetType = "UNKNOWN"),
            Entry("GET", "/api/permissions/{id}", packetType = "UNKNOWN"),
            Entry("PUT", "/api/permissions/{id}", packetType = "UNKNOWN"),
            Entry("GET", "/api/permissions/code/{code}", packetType = "UNKNOWN"),
            Entry("GET", "/api/permissions/tree", packetType = "UNKNOWN"),
```

且生成的 `PacketTypeMap.kt:15-16` 明确写着这是 schema 约定：`/** 未登记路径的类型（schema：未知类型固定为 UNKNOWN）。 */  const val UNKNOWN: String = "UNKNOWN"`。

**⑦ 回归测试里直接在信封里发任意 `packet_type`，请求照样 200。**

`WiseDeoptServer/wise-deopt-api/src/test/java/com/huicang/wise/api/support/AbstractWebMvcSliceTest.java:122-138`

```java
    protected String envelope(Object payload) throws JsonProcessingException {
        ObjectMapper mapper = new ObjectMapper();
        ObjectNode header = mapper.createObjectNode();
        header.put("request_id", "it-" + UUID.randomUUID());
        header.put("packet_type", "TEST");
```

`"TEST"` 既不是枚举名也不是枚举 code，服务端全量 slice 测试都靠它通过——这从测试侧证明 `packet_type` 的值不被校验。

---

## 2. 七条共用的事实（先读这一节，后面各条不再重复）

### 2.1 路由与路径前缀

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/controller/PermissionController.java:13-16`

```java
@Tag(name = "权限管理接口")
@RestController
@RequestMapping("/api/permissions")
public class PermissionController {
```

### 2.2 参数去哪（`paramStyle`）

| 方法 | HTTP | 契约 `paramStyle` | 为什么 |
| --- | --- | --- | --- |
| `permission.list` / `tree` | GET | `query` | GET 天然 query；且**无参数** |
| `permission.detail` / `byCode` | GET | `query` | 路径参数 `{id}`/`{code}` 由 `PathTemplate.resolve` 替换，剩余参数拼 query |
| `permission.create` | POST | `body` | 服务端用 `@Valid @RequestBody` |
| `permission.update` | PUT | `body` | 同上 |
| `permission.delete` | DELETE | `query` | DELETE 无 body |

`paramStyle` 的来源规则见 `gen-bridge-contract.js:280` 与 `:298`：`const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);` + `paramStyle: BODY_METHODS.has(r.method) && !(id in queryIds) ? 'body' : 'query'`。
`tools/gen/bridge-overlay.json` 里 **`queryParams` / `bodyPathParams` 均无 `permission.*` 条目**（`bridge-overlay.json:265-297` 的清单只有 device/file/inspection/inventory/message/profile/tag），即：这 7 条没有 `@RequestParam`、没有"路径参数必须同时进 body"的坑。

路径参数只进 URL、不进 body：`WiseDepotClient/bridge/backend/src/main/kotlin/com/huicang/wise/bridge/backend/PathTemplate.kt:111-121`

```kotlin
    /** 去掉路径参数后剩下的参数（查询串或请求体用）。 */
    fun remaining(
        template: String,
        params: JsonObject?,
    ): JsonObject {
        ...
        return JsonObject(params.filterKeys { it !in pathNames })
```

### 2.3 响应信封与"成功"的判据

成功固定 `code = "RES-0000"`：

`WiseDeoptServer/wise-deopt-common/src/main/java/com/huicang/wise/common/api/ErrorCode.java:18`

```java
    SUCCESS("RES-0000", "处理成功", 200),
```

响应形状（`ApiResponse` 被 `GlobalResponseAdvice` 包成 `Packet`）：

`WiseDeoptServer/wise-deopt-common/src/main/java/com/huicang/wise/common/api/ApiResponse.java:12-17`

```java
 * {
 *   "header":  { "request_id": "...", "packet_type": "...", "timestamp": 0 },
 *   "payload": { "code": "RES-0000", "message": "处理成功", "data": {}, "errorCode": null }
 * }
```

**业务失败也走 HTTP 200**（只有 `code`/`errorCode` 变），这一点必须在实现时记住：

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/handler/GlobalExceptionHandler.java:62-72`

```java
    @ExceptionHandler(BusinessException.class)
    @ResponseStatus(HttpStatus.OK)
    public ApiResponse<Void> handleBusinessException(
            BusinessException ex, HttpServletRequest request) {
        ...
        return ApiResponse.failure(ex.getErrorCode(), ex.getMessage());
```

桥侧对"HTTP 200 但业务失败"是认的（读 `errorCode ?: code`，非 `RES-0000` 即失败）：

`WiseDepotClient/bridge/backend/src/main/kotlin/com/huicang/wise/bridge/backend/OkHttpBackend.kt:108-120`

```kotlin
                    val code = unwrapped.errorCode ?: unwrapped.code
                    if (unwrapped.code == Envelope.SUCCESS_CODE) {
                        BackendResult.Ok(unwrapped.data)
                    } else {
                        BackendResult.Failed(
                            code = code ?: BackendErrorCodes.INTERNAL,
```

### 2.4 鉴权

`/api/**` 全部走登录拦截器，`/api/permissions` **不在排除名单里**：

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/config/WebMvcConfiguration.java:36-56`

```java
        registry.addInterceptor(authenticationInterceptor)
                .addPathPatterns("/api/**") // 拦截所有API请求
                .excludePathPatterns(
                        "/api/auth/login",      // 排除登录接口
                        ...
```

无 Bearer 且无签名头 → `UNAUTHORIZED`：

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/interceptor/AuthenticationInterceptor.java:51-58`

```java
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            // 如果没有Token，检查是否有签名头（设备端请求）
            if (signatureHeader != null) {
                return true;
            }
            throw new BusinessException(ErrorCode.UNAUTHORIZED, "缺少有效的身份认证信息");
```

### 2.5 DTO 的 JSON 序列化会带上 null 字段

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/config/JacksonConfiguration.java:24-29`

```java
    public ObjectMapper objectMapper(Jackson2ObjectMapperBuilder builder) {
        ObjectMapper objectMapper = builder.createXmlMapper(false).build();
        objectMapper.configure(SerializationFeature.WRITE_NULL_MAP_VALUES, true);
        return objectMapper;
    }
```

没有配置 `NON_NULL`，因此 `parentId` / `parentName` / `children` / `description` / `createdAt` / `updatedAt` 即使为 `null` **也会出现**在 JSON 里（键存在、值为 `null`）。前端按 `key in obj` 判"字段是否存在"会踩坑，要按值判。

---

## 3. `## permission.list`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `GET /api/permissions` |
| 参数 | **无**（没有 `@RequestParam`、没有 `@RequestBody`、没有路径变量） |
| 分页 | **不分页**。既不是 `page`/`size`，也不是 `page`/`pageSize`——**这两个名字在本接口都不存在**，传了会被 Spring 当无关 query 参数忽略 |
| 返回体 | `payload.data` = **裸 JSON 数组**（`PermissionDTO[]`），不是分页对象；没有任何 `total`/`records`/`content`/`list` 包装 |
| 排序 | 无 `ORDER BY`（`findAll()`），顺序由数据库返回顺序决定 |
| 校验 | 无 |
| 鉴权 | 仅需登录（见 §2.4） |

**证据**

`WiseDepotServer/wise-deopt-api/src/main/java/com/huicang/wise/api/controller/PermissionController.java:24-28`

```java
    @Operation(summary = "获取所有权限", description = "返回系统中所有权限的列表")
    @GetMapping
    public ApiResponse<List<PermissionDTO>> getAllPermissions() {
        return ApiResponse.success(permissionApplicationService.getAllPermissions());
    }
```

方法签名**零参数**，返回类型 `List<PermissionDTO>` —— 分页对象在类型上就不可能存在。

`WiseDepotServer/wise-deopt-application/src/main/java/com/huicang/wise/application/permission/PermissionApplicationService.java:26-29`

```java
    public List<PermissionDTO> getAllPermissions() {
        List<Permission> permissions = permissionRepository.findAll();
        return permissions.stream().map(permissionMapper::toDTO).collect(Collectors.toList());
    }
```

`findAll()` = `JpaRepository.findAll()`（`PermissionRepository.java:16`：`public interface PermissionRepository extends JpaRepository<Permission, Long> {`），无分页、无排序。

> 附注：仓库内确实存在一个 `isValidPagination(int page, int pageSize)` 的通用校验工具（`ApiConsistencyValidator.java:129-131`），但它与 `permission.list` **无关**，不要据此推断该接口分页。

---

## 4. `## permission.tree`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `GET /api/permissions/tree` |
| 参数 | **无** |
| 分页 | 不分页，返回裸数组 |
| 返回体 | `payload.data` = `PermissionDTO[]`；元素可能带 `children` |
| **实际语义** | **在生产数据下等价于 `permission.list`**：所有节点都是根、`children` 恒为 `null`（详见下方推导） |
| 父子关系字段 | 靠 `parentId`（DTO 字段），**不是** `parentCode` 也不是嵌套在同级数组里 |
| 校验 | 无 |

**证据（路由与类型）**

`PermissionController.java:30-34`

```java
    @Operation(summary = "获取权限树", description = "返回权限的树形结构")
    @GetMapping("/tree")
    public ApiResponse<List<PermissionDTO>> getPermissionTree() {
        return ApiResponse.success(permissionApplicationService.getPermissionTree());
    }
```

**证据（树构建逻辑）**

`PermissionApplicationService.java:31-36` 与 `:94-109`

```java
    public List<PermissionDTO> getPermissionTree() {
        List<Permission> allPermissions = permissionRepository.findAll();
        List<PermissionDTO> allDTOs =
                allPermissions.stream().map(permissionMapper::toDTO).collect(Collectors.toList());
        return buildPermissionTree(allDTOs, null);
    }
```

```java
    private List<PermissionDTO> buildPermissionTree(
            List<PermissionDTO> allPermissions, Long parentId) {
        List<PermissionDTO> tree = new ArrayList<>();
        for (PermissionDTO permission : allPermissions) {
            if ((parentId == null && permission.getParentId() == null)
                    || (parentId != null && parentId.equals(permission.getParentId()))) {
                List<PermissionDTO> children =
                        buildPermissionTree(allPermissions, permission.getPermissionId());
                if (!children.isEmpty()) {
                    permission.setChildren(children);
                }
                tree.add(permission);
            }
        }
        return tree;
    }
```

**证据（`parentId` 永远填不上——这是 `tree ≡ list` 的根本原因）**

- 映射器**不设置** `parentId` / `parentName`：

`PermissionMapper.java:9-23`

```java
        PermissionDTO dto = new PermissionDTO();
        dto.setPermissionId(entity.getPermissionId());
        dto.setPermissionName(entity.getName());
        dto.setPermissionCode(entity.getCode());
        dto.setDescription(entity.getDescription());
        dto.setCreatedAt(entity.getCreateTime());
        dto.setUpdatedAt(entity.getUpdateTime());

        return dto;
```

- 实体**根本没有** `parentId` 字段：

`WiseDeoptServer/wise-deopt-domain/src/main/java/com/huicang/wise/domain/auth/Permission.java:15-45`（字段只有 `permissionId` / `name` / `code` / `description` / `createTime` / `createBy` / `updateTime` / `updateBy`）

- 数据库表**没有** `parent_id` 列：

`WiseDeoptServer/wise-deopt-infrastructure/src/main/resources/META-INF/orm.xml:179-215`（`<basic>` 只有 name / code / description / createTime / createBy / updateTime / updateBy）
`WiseDeoptServer/wise-deopt-infrastructure/target/p205-schema-snapshot.sql:234-244`

```sql
    create table permission (
        permission_id bigint not null auto_increment,
        code varchar(128) not null,
        create_by bigint not null,
        create_time datetime(6) not null,
        description varchar(255),
        name varchar(64) not null,
        update_by bigint not null,
        update_time datetime(6) not null,
        primary key (permission_id)
    ) engine=InnoDB;
```

- 全仓 grep `setParentName` 只命中 `PermissionDTO` 自己的定义（`PermissionDTO.java:61`），**没有任何调用点**；`setParentId` 在生产代码里也**没有任何调用点**（唯一调用在测试 `PermissionApplicationServiceTest.java:63`）。
- 服务端的单元测试把这条现状钉死了：

`WiseDepotServer/wise-deopt-application/src/test/java/com/huicang/wise/application/permission/PermissionApplicationServiceTest.java:50-58`

```java
    private Permission permission(Long id, Long parentId, String code) {
        Permission entity = new Permission();
        entity.setPermissionId(id);
        // 注：Permission 实体没有 parentId 字段，分层信息只存在于 DTO 侧
```

`PermissionApplicationServiceTest.java:336-343`

```java
    @Test
    @DisplayName("现状：Permission 实体没有 parentId setter —— 分层只可能来自 DTO 侧")
    void entityHasNoParentId() {
        assertThrows(
                NoSuchMethodException.class,
                () -> Permission.class.getDeclaredMethod("setParentId", Long.class),
```

**由上面推出的确定结论**：生产路径下 `mapper.toDTO` 产出的每个 DTO 的 `parentId` 都是 `null` → `buildPermissionTree(all, null)` 里"根"的条件对**所有**元素成立 → **全部成为根**；递归找子节点时 `parentId.equals(permission.getParentId())` 两边都比 `null`，恒为 `false` → **没有任何 children**。因此 `tree` 的响应体与 `list` **在内容与顺序上完全一致**，只是端点不同。

**另外两条服务端已知现状（其自带测试已声明"只记录、未修"）**：

`PermissionApplicationServiceTest.java:29-36`

```java
 * <p>本批钉住四点现状（只记录、未修）： ① 树构建**没有环检测**，且父节点不存在的"孤儿"节点会被**静默丢弃**（既不是根、也不挂到任何父下）； ② 叶子节点**不会被设置
 * children**（只有非空才 set），因此叶子处 <code>getChildren()</code> 为 null； ③ 类里有两个**恒返回 false 的私有桩方法**（<code>
 * hasChildren</code> / <code>hasCircularDependency</code>）**从未被调用**； ④ <code>updatePermission
 * </code> **不会改权限编码**（只改名称/描述），而创建时编码唯一性有校验。
```

`PermissionApplicationService.java:111-117` 就是那两个死桩：

```java
    private boolean hasChildren(Long parentId) {
        return false;
    }

    private boolean hasCircularDependency(Long currentId, Long newParentId) {
        return false;
    }
```

**对前端的直接后果**：`children` 在叶子处是 `null`（不是 `[]`）。对 `null` 直接 `.map()` / `.length` 会炸。

---

## 5. `## permission.detail`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `GET /api/permissions/{id}` |
| 路径参数 | `{id}`（**权限主键 id**，类型 `Long`，必填） |
| 查询参数 | 无 |
| 返回体 | `payload.data` = **单个 `PermissionDTO` 对象** |
| 校验 | 路径变量必须能转成 `Long`；否则 400 + `VAL-0001` |
| 失败 | 不存在 → `BusinessException(NOT_FOUND, "权限不存在")`，HTTP 200，`payload.code = "RES-0004"` |

**证据（`{id}` 就是主键 id，不是 code）**

`PermissionController.java:36-42`

```java
    @Operation(summary = "根据ID获取权限", description = "根据权限ID返回权限详情")
    @GetMapping("/{id}")
    public ApiResponse<PermissionDTO> getPermissionById(
            @Parameter(description = "权限ID", required = true)
            @PathVariable Long id) {
        return ApiResponse.success(permissionApplicationService.getPermissionById(id));
    }
```

三处独立佐证：① `@Parameter(description = "权限ID")`；② 类型是 `Long`（code 是 `String`）；③ 服务层直接 `findById`：

`PermissionApplicationService.java:38-43`

```java
    public PermissionDTO getPermissionById(Long id) {
        return permissionRepository
                .findById(id)
                .map(permissionMapper::toDTO)
                .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "权限不存在"));
    }
```

**证据（非数字 id → 400）**

`GlobalExceptionHandler.java:237-247`

```java
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResponse<Void> handleMethodArgumentTypeMismatchException(
            MethodArgumentTypeMismatchException ex, HttpServletRequest request) {
        ...
        return ApiResponse.failure(ErrorCode.PARAM_ERROR, "请求参数类型不合法: " + ex.getName());
```

`ErrorCode.java:20` → `PARAM_ERROR("VAL-0001", "请求参数不合法", 400)`。

**证据（NOT_FOUND 的业务码）**

`ErrorCode.java:21` → `NOT_FOUND("RES-0004", "资源不存在", 404)`。注意 `httpStatus` 字段被 `ApiResponse` 标了 `@JsonIgnore`（`ApiResponse.java:53-54`），而 `handleBusinessException` 固定 `@ResponseStatus(HttpStatus.OK)`，所以**线上是 HTTP 200 + `payload.code = "RES-0004"`**，不要按 404 判。

---

## 6. `## permission.byCode`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `GET /api/permissions/code/{code}` |
| 路径参数 | `{code}`（**权限编码字符串**，如 `user:view`，大小写敏感、原样比较） |
| 查询参数 | 无 |
| 返回体 | `payload.data` = 单个 `PermissionDTO` |
| 校验 | 无格式校验（任意字符串都会被拿去查库） |
| 失败 | 不存在 → `RES-0004`（HTTP 200） |

**证据**

`PermissionController.java:44-50`

```java
    @Operation(summary = "根据编码获取权限", description = "根据权限编码返回权限详情")
    @GetMapping("/code/{code}")
    public ApiResponse<PermissionDTO> getPermissionByCode(
            @Parameter(description = "权限编码", required = true)
            @PathVariable String code) {
        return ApiResponse.success(permissionApplicationService.getPermissionByCode(code));
    }
```

`PermissionApplicationService.java:45-50`

```java
    public PermissionDTO getPermissionByCode(String code) {
        return permissionRepository
                .findByCode(code)
                .map(permissionMapper::toDTO)
                .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "权限不存在"));
    }
```

`PermissionRepository.java:32` → `Optional<Permission> findByCode(String code);`

> 桥侧注意：`code` 含冒号（`user:view`）。`PathTemplate.encodePathSegment` 会把 `:` 百分号编码成 `%3A`（`PathTemplate.kt:92-109`，白名单只有 `a-z A-Z 0-9 - . _ ~`）。Spring 侧 `@PathVariable` 会解码回 `:`，因此**可以正常路由**；但 `/`、`?`、`#` 会被桥直接判为非法参数（`PathTemplate.kt:89-91`），所以编码里不能带斜杠。

---

## 7. `## permission.create`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `POST /api/permissions` |
| body | `CreatePermissionRequest`：`permissionName`（必填，≤100）、`permissionCode`（必填，≤100）、`parentId`（可选，**会被静默丢弃**）、`description`（可选，≤500） |
| 路径参数 | 无 |
| 返回体 | 成功时 `payload.data` = 新建的 `PermissionDTO` |
| 唯一性 | `permissionCode` 唯一；重复 → `VAL-CONFLICT-PERMISSION-1001`「权限编码已存在」 |
| 校验失败 | 400 + `VAL-0001`，`message` 形如 `请求参数校验失败: permissionCode: 权限编码不能为空` |
| **真库可用性** | ⚠️ **几乎必然 500**，见下方"致命点" |

**证据（签名与 body 绑定）**

`PermissionController.java:52-58`

```java
    @Operation(summary = "创建权限", description = "创建新的权限")
    @PostMapping
    public ApiResponse<PermissionDTO> createPermission(
            @Parameter(description = "权限信息", required = true)
            @Valid @RequestBody CreatePermissionRequest request) {
        return ApiResponse.success(permissionApplicationService.createPermission(request));
    }
```

**证据（字段与校验注解）**

`WiseDepotServer/wise-deopt-application/src/main/java/com/huicang/wise/application/permission/CreatePermissionRequest.java:6-15`

```java
public class CreatePermissionRequest {
    @NotBlank(message = "权限名称不能为空")
    @Size(max = 100, message = "权限名称长度不能超过100个字符")
    private String permissionName;
    @NotBlank(message = "权限编码不能为空")
    @Size(max = 100, message = "权限编码长度不能超过100个字符")
    private String permissionCode;
    private Long parentId;
    @Size(max = 500, message = "权限描述长度不能超过500个字符")
    private String description;
```

注意：`permissionName` 是 **JSON 字段名**；DTO 内部 Java 属性同名，**不是** `name`。`parentId` **没有** `@NotNull`（可选），但也没有任何作用（见下）。

**证据（唯一性与落库字段）**

`PermissionApplicationService.java:52-67`

```java
    @Transactional
    public PermissionDTO createPermission(CreatePermissionRequest request) {
        if (permissionRepository.findByCode(request.getPermissionCode()).isPresent()) {
            throw new BusinessException(ErrorCode.VAL_CONFLICT_PERMISSION_CODE_EXISTS, "权限编码已存在");
        }

        Permission permission = new Permission();
        permission.setName(request.getPermissionName());
        permission.setCode(request.getPermissionCode());
        permission.setDescription(request.getDescription());
        permission.setCreateTime(LocalDateTime.now());
        permission.setUpdateTime(LocalDateTime.now());

        Permission saved = permissionRepository.save(permission);
        return permissionMapper.toDTO(saved);
    }
```

`ErrorCode.java:82` → `VAL_CONFLICT_PERMISSION_CODE_EXISTS("VAL-CONFLICT-PERMISSION-1001", "权限编码已存在", 409);`，同样经 `handleBusinessException` 以 **HTTP 200** 返回。

**证据（`parentId` 被吞）**：`CreatePermissionRequest` 有 `parentId`（`:13`），但服务层**从未读它**（上引 `:58-63` 只 set 了 name/code/description/两个时间戳），实体也没有这个字段（`Permission.java:15-45`），表也没有这一列（`p205-schema-snapshot.sql:234-244`）。→ **传 `parentId` 不报错、也不生效。**

**致命点：`create_by` / `update_by` 是 `NOT NULL`，而服务层从不设置它们**

真实数据库 DDL（`tools/sql/wise_depot.sql`，从线上库导出的建表语句）：

`tools/sql/wise_depot.sql:384-401`

```sql
CREATE TABLE `permission` (
  `permission_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '权限id',
  `name` varchar(64) NOT NULL COMMENT '权限名称',
  `code` varchar(128) NOT NULL COMMENT '权限编码',
  `description` varchar(255) DEFAULT NULL COMMENT '权限描述',
  `create_time` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `create_by` bigint unsigned NOT NULL COMMENT '创建者id',
  `update_time` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  `update_by` bigint unsigned NOT NULL COMMENT '更新者id',
  PRIMARY KEY (`permission_id`),
  ...
  CONSTRAINT `permission_ibfk_1` FOREIGN KEY (`create_by`) REFERENCES `user_core` (`user_id`),
  CONSTRAINT `permission_ibfk_2` FOREIGN KEY (`update_by`) REFERENCES `user_core` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='权限表';
```

`create_by` / `update_by` **无 `DEFAULT`**，且 `Permission` **不继承 `BaseEntity`**（`Permission.java:15`：`public class Permission {`），所以 `BaseEntity` 的 `@PrePersist`（`WiseDeoptServer/wise-deopt-domain/src/main/java/com/huicang/wise/domain/entity/BaseEntity.java:24`）**不会**生效；`orm.xml` 里 `permission` 也没有 `<entity-listeners>`（`orm.xml:179-216`）。
→ INSERT 的两个列都是 `NULL` → MySQL 报 `Column 'create_by' cannot be null` → 该异常没有专用 handler，落入兜底：

`GlobalExceptionHandler.java:316-332`

```java
    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public ApiResponse<Void> handleException(Exception ex, HttpServletRequest request) {
        log.error("系统未知异常: uri={}", request.getRequestURI(), ex);
        ...
        return ApiResponse.failure(ErrorCode.SYSTEM_ERROR, "系统异常，请联系管理员");
```

`ErrorCode.java:30` → `SYSTEM_ERROR("SYS-0001", ...)`，HTTP 500。
**对照组（证明列确实要求非空）**：种子数据显式写了这两个字段 —— `DataInitializer.java:445-454`

```java
            Permission permission = new Permission();
            permission.setPermissionId(permissionId);
            permission.setName(name);
            permission.setCode(code);
            permission.setDescription(name);
            permission.setCreateTime(LocalDateTime.now());
            permission.setCreateBy(1L);
            permission.setUpdateTime(LocalDateTime.now());
            permission.setUpdateBy(1L);
            permissionRepository.save(permission);
```

> 结论：`permission.create` 的后端实现与真实表结构不兼容。**移植时应在 UI 上把它标为"后端不可用"，或先修后端**（本次任务只读，不修）。

---

## 8. `## permission.update`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `PUT /api/permissions/{id}` |
| 路径参数 | `{id}` = 权限主键 id（`Long`） |
| body | `UpdatePermissionRequest`：`permissionName`（**必填**，≤100）、`parentId`（可选、**无效**）、`description`（可选，≤500） |
| **不能改 code** | 请求 DTO 里**没有** `permissionCode` 字段，服务层也不改 code |
| 返回体 | 成功时 `payload.data` = 更新后的 `PermissionDTO` |
| 失败 | id 不存在 → `RES-0004`「权限不存在」（HTTP 200） |
| 真库可用性 | **可用**（`update_by` 从已加载的实体带出，非空；`update_time` 由服务层写入） |

**证据（签名）**

`PermissionController.java:60-68`

```java
    @Operation(summary = "更新权限", description = "更新指定ID的权限信息")
    @PutMapping("/{id}")
    public ApiResponse<PermissionDTO> updatePermission(
            @Parameter(description = "权限ID", required = true)
            @PathVariable Long id,
            @Parameter(description = "权限信息", required = true)
            @Valid @RequestBody UpdatePermissionRequest request) {
        return ApiResponse.success(permissionApplicationService.updatePermission(id, request));
    }
```

> 注意：`{id}` 与 body 是**两处独立来源**，body 里**不需要**再放 `id`（`UpdatePermissionRequest` 没有 id 字段，见下）。这 7 条里没有任何一条命中 `keepPathParamsInBody`（`bridge-overlay.json:287-297` 只有 `inspection.manualRecord`）。

**证据（字段与"不改 code"）**

`UpdatePermissionRequest.java:6-12`

```java
public class UpdatePermissionRequest {
    @NotBlank(message = "权限名称不能为空")
    @Size(max = 100, message = "权限名称长度不能超过100个字符")
    private String permissionName;
    private Long parentId;
    @Size(max = 500, message = "权限描述长度不能超过500个字符")
    private String description;
```

`PermissionApplicationService.java:69-82`

```java
    @Transactional
    public PermissionDTO updatePermission(Long id, UpdatePermissionRequest request) {
        Permission permission =
                permissionRepository
                        .findById(id)
                        .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "权限不存在"));

        permission.setName(request.getPermissionName());
        permission.setDescription(request.getDescription());
        permission.setUpdateTime(LocalDateTime.now());

        Permission updated = permissionRepository.save(permission);
        return permissionMapper.toDTO(updated);
    }
```

单元测试把这条现状钉死了：`PermissionApplicationServiceTest.java:242-258`

```java
    @Test
    @DisplayName("更新权限：只改名称/描述与更新时间，**编码不动**（现状）")
    ...
        assertEquals("user:read", entity.getCode(), "现状：更新请求里没有编码，也不会改编码");
```

**`parentId` 同样被吞**：`UpdatePermissionRequest.java:10` 有该字段，`PermissionApplicationService.java:76-78` 从未读它。

**`permissionName` 必填**：`@NotBlank` → 只想改描述也必须把名字带上，否则 400 + `VAL-0001`。

---

## 9. `## permission.delete`

| 项 | 值 |
| --- | --- |
| HTTP 路径 | `DELETE /api/permissions/{id}` |
| 路径参数 | `{id}` = 权限主键 id（`Long`） |
| 返回体 | 成功时 `payload.data` = **`null`**（不是 `{}`、不是 DTO） |
| 失败 | id 不存在 → `RES-0004`「权限不存在」（HTTP 200） |
| 子节点处理 | **没有子节点的概念**（实体/表均无 `parent_id`），所以既非级联也非拒绝——**不适用** |
| 角色引用处理 | **不检查、不级联，交给数据库外键拒绝** → 会被角色引用的权限删除必然 500 |
| 真库可用性 | 只对"没有任何角色引用"的权限可用 |

**证据（签名与返回体）**

`PermissionController.java:70-77`

```java
    @Operation(summary = "删除权限", description = "删除指定ID的权限")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> deletePermission(
            @Parameter(description = "权限ID", required = true)
            @PathVariable Long id) {
        permissionApplicationService.deletePermission(id);
        return ApiResponse.success(null);
    }
```

`ApiResponse.success(null)` → `payload.data = null`。桥侧把它原样吐出：

`WiseDepotClient/bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeCallHandler.kt:128`

```kotlin
            is BackendResult.Ok -> BridgeCodec.encode(ResFrame(id = id, data = outcome.data ?: JsonNull))
```

**证据（服务层只删一行，无任何引用检查）**

`PermissionApplicationService.java:84-92`

```java
    @Transactional
    public void deletePermission(Long id) {
        Permission permission =
                permissionRepository
                        .findById(id)
                        .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "权限不存在"));

        permissionRepository.delete(permission);
    }
```

**证据（外键没有 ON DELETE CASCADE，所以删除被引用的权限会撞外键）**

`tools/sql/wise_depot.sql:511-525`

```sql
CREATE TABLE `role_permission` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '关联id',
  `role_id` bigint unsigned NOT NULL COMMENT '角色id',
  `permission_id` bigint unsigned NOT NULL COMMENT '权限id',
  `create_time` datetime(3) NOT NULL COMMENT '创建时间',
  `create_by` bigint unsigned NOT NULL COMMENT '创建者id',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_permission` (`role_id`,`permission_id`),
  KEY `idx_role_id` (`role_id`),
  KEY `idx_permission_id` (`permission_id`),
  KEY `create_by` (`create_by`),
  CONSTRAINT `role_permission_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `role` (`role_id`),
  CONSTRAINT `role_permission_ibfk_2` FOREIGN KEY (`permission_id`) REFERENCES `permission` (`permission_id`),
  CONSTRAINT `role_permission_ibfk_3` FOREIGN KEY (`create_by`) REFERENCES `user_core` (`user_id`)
) ENGINE=InnoDB ...
```

→ 删除被 `role_permission` 引用的权限，MySQL 报 1451 → 兜底 500 + `SYS-0001`。
**而 4 条种子权限全部被角色 1 引用**：

`DataInitializer.java:244-248`（种子）与 `:273-277`（授权）

```java
            // 3. 初始化权限
            createPermissionIfNotExist(permissionRepository, 1L, "用户查看", "user:view");
            createPermissionIfNotExist(permissionRepository, 2L, "用户创建", "user:create");
            createPermissionIfNotExist(permissionRepository, 3L, "用户编辑", "user:edit");
            createPermissionIfNotExist(permissionRepository, 4L, "用户删除", "user:delete");
```

```java
            // 5. 关联角色和权限（管理员拥有所有权限）
            createRolePermissionIfNotExist(rolePermissionRepository, 1L, 1L);
            createRolePermissionIfNotExist(rolePermissionRepository, 1L, 2L);
            createRolePermissionIfNotExist(rolePermissionRepository, 1L, 3L);
            createRolePermissionIfNotExist(rolePermissionRepository, 1L, 4L);
```

> 即：**默认数据下 4 条权限一条都删不掉**（都是 500）。要删成功，只能删"新建后未被任何角色引用"的权限——而 `permission.create` 本身又是坏的（§7）。**因此 `permission.delete` 在默认环境里实际上不可用。**

**证据（本接口与"删除父节点/子节点"无关）**：实体无 `parentId`（`Permission.java:15-45`）、表无 `parent_id`（`p205-schema-snapshot.sql:234-244`、`tools/sql/wise_depot.sql:384-401`）。问题里"删除父节点时子节点怎么处理"这个前提在本后端**不成立**。

---

## 10. 权限码清单（如存在）

**存在，且只有 4 条**，来源是启动期播种器 `DataInitializer`（不是 SQL、不是枚举常量类）。

`WiseDeoptServer/wise-deopt-infrastructure/src/main/java/com/huicang/wise/infrastructure/bootstrap/DataInitializer.java:244-248`

```java
            // 3. 初始化权限
            createPermissionIfNotExist(permissionRepository, 1L, "用户查看", "user:view");
            createPermissionIfNotExist(permissionRepository, 2L, "用户创建", "user:create");
            createPermissionIfNotExist(permissionRepository, 3L, "用户编辑", "user:edit");
            createPermissionIfNotExist(permissionRepository, 4L, "用户删除", "user:delete");
```

| `permissionId` | `name` | `code` | `description`（= name，见下） |
| --- | --- | --- | --- |
| 1 | 用户查看 | `user:view` | 用户查看 |
| 2 | 用户创建 | `user:create` | 用户创建 |
| 3 | 用户编辑 | `user:edit` | 用户编辑 |
| 4 | 用户删除 | `user:delete` | 用户删除 |

`DataInitializer.java:439-457` 是写入器（`setDescription(name)` 说明描述就是名字本身；`setCreateBy(1L)`/`setUpdateBy(1L)` 说明这是绕过 §7 那个 `NOT NULL` 坑的**唯一**合法路径）：

```java
    private void createPermissionIfNotExist(
            PermissionRepository permissionRepository,
            Long permissionId,
            String name,
            String code) {
        if (permissionRepository.findById(permissionId).isEmpty()) {
```

**交叉印证之一：`@RequiresPermission` 里的字面量只用到这 4 个码**

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/controller/UserController.java:66,74,85,94,108,120`

```java
    @RequiresPermission("user:create")
    @RequiresPermission("user:edit")
    @RequiresPermission("user:view")
    @RequiresPermission("user:view")
    @RequiresPermission("user:delete")
    @RequiresPermission("user:delete")
```

全仓 grep `user:view|user:create|user:edit|user:delete` 只命中 `UserController.java` 的这 6 处 + 一份运行记录。**除 `UserController` 外没有任何控制器使用 `@RequiresPermission`**（全仓 grep `RequiresPermission` 命中：`UserController`、`AuthenticationInterceptor`、`PermissionAspect`、注解定义本身）。

**交叉印证之二：真机跑过一次的落库数量记录**

`docs/服务端本机运行验证记录.md:155`

```
| `permission` | 4 | user:view / create / edit / delete |
```

同名文件的 `:154` 显示 `role` 有 3 条（管理员 / 操作员 / 访客），与 `DataInitializer.java:240-242` 一致。

> **清单规模提示**：只有 4 个码、且只覆盖 `user:*`。仓库里**没有**权限码的枚举类、没有 `.sql` 种子文件（`tools/sql/wise_depot.sql` 只有建表语句，grep `INSERT INTO \`permission\`` 无命中）。若移植后的 UI 需要"权限码下拉/分类树"，不要凭空造第二套码——以 `DataInitializer` 这 4 条 + 后端实际出现的 `@RequiresPermission` 字面量为准。

---

## 11. 旧客户端接过 `permission.*` 吗？

### 裁决

> **没有。** 两代旧客户端都没有调用过 `permission.*`；它们只是"知道这些路由存在"（因为路由表是**从服务端控制器全量扫描生成**的，`/api/permissions/**` 必然在里面）。

### 11.1 先纠正一个前提：`.archive/` 里不是 React 客户端

`E:\code_space\WiseDepot\.archive\` 下只有两个目录 + 一个说明文件：

- `.archive/wise-depot-android-refactor/`（旧 **Android APP**，Kotlin/Compose）
- `.archive/_archived-manifests/`
- `.archive/ARCHIVE.md`

`.archive/ARCHIVE.md:1-5`

```markdown
# 归档清单：旧 Android APP（WiseDepotApp）

> 归档时间：W0 批（WiseDepotClient 仓库建立时）
> 归档原因：客户端整体重构为 `WiseDepotClient`（React Web UI + 单份 Kotlin/Netty 桥，桌面 Electron / 手机 Android 双宿主）。
```

全仓 glob `**/*.tsx`（排除 `node_modules`）**零命中**——即当前工作区里没有任何 React 源码。

**旧 React Web 版在 git 历史里，不在磁盘上。** 它被一个 tag 冻结：

- `WiseDepotClient/docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:26`（基线表）：`| Web 框架 | React 19 + @vitejs/plugin-react | apps/web/package.json |`
- 同文件 `:60`：`| **D8** | **原地重写 apps/web**；React 版在 V0 打 tag archive/react-web-final | 保留廉价回滚点，不做长期双栈并行 |`
- 但**实际打的 tag 名是 `v0-react-freeze`**（`git -C WiseDepotClient tag -l` 输出；提交 `032f518 V6：删除 React 版，门禁全部改指 Vue 侧（回滚点 tag v0-react-freeze）`）。文档与 tag 名不一致，属于文档漂移，按 tag 查即可。

### 11.2 旧 React 版：**未接过**

在 tag `v0-react-freeze` 上按整个 Web 代码面搜索：

```
git grep -in "permission" v0-react-freeze -- apps/web/src packages/features packages/stores packages/patterns packages/bridge-client
→ （无输出）
```

唯一命中 `permission.` 的地方是**生成物自身**（白名单表全量列举，与是否调用无关）：

```
v0-react-freeze:packages/contract/src/generated/bridgeContract.ts:137-143
  { id: 'permission.byCode', ... }, { id: 'permission.create', ... }, ... { id: 'permission.update', ... }
```

### 11.3 旧 Android APP：**未接过**

`.archive/wise-depot-android-refactor` 内 grep `/api/permissions|getPermissions|PermissionDto|PermissionRepository|permissionApi`，除生成的路由表外**零命中**：

`.archive/wise-depot-android-refactor/core/network/src/main/java/com/huicang/wise/network/PacketTypeMap.kt:127-133`（唯一的命中处，是路由→packet_type 映射表，不是调用点）

全目录内 `permission`（不分大小写）的另外 20 余处命中全部是 **Android 系统权限**（`AndroidManifest.xml` 的 `android.permission.CAMERA` 等、`accompanist-permissions` 依赖、`CameraScanScreen.kt` 的相机权限请求）——与业务权限管理无关。**旧 APP 没有权限管理屏**（`feature/user` 下只有 `UserManagementScreen.kt` / `ProfileScreen.kt`）。

### 11.4 `docs/feature-parity.md` 的记载

该文件**没有**给 `permission.*` 单独标注迁移状态；它只把 7 条按 packet_type 列进"桥方法分域总表"：

`WiseDepotClient/docs/feature-parity.md:196-202`

```
| `permission.byCode` | GET | `/api/permissions/code/{code}` | UNKNOWN |
| `permission.create` | POST | `/api/permissions` | UNKNOWN |
| `permission.delete` | DELETE | `/api/permissions/{id}` | UNKNOWN |
| `permission.detail` | GET | `/api/permissions/{id}` | UNKNOWN |
| `permission.list` | GET | `/api/permissions` | UNKNOWN |
| `permission.tree` | GET | `/api/permissions/tree` | UNKNOWN |
| `permission.update` | PUT | `/api/permissions/{id}` | UNKNOWN |
```

而"迁移状态"是**机械推导**的，不是人写的：

`feature-parity.md:3-5`

```markdown
> **本文件由 `tools/gen/gen-feature-parity.js` 生成，禁止手改。**
> 重跑：`pnpm gen:parity`；校验：`pnpm gen:parity --check`。
> 「迁移状态」**不是人回填的**：它由 `apps/web/src/views/registry.ts` 里已登记的桥方法机械推导。接一屏，状态自己变；没接，就一直显示缺口。
```

对照当前 Vue 版注册表 —— **没有一条 `permission.*`**：

`WiseDepotClient/apps/web/src/views/registry.ts:52-59`

```ts
  // ---- me ----
  'message.list': () => import('./me/MessageListView.vue'),
  'message.detail': () => import('./me/MessageDetailView.vue'),
  'user.list': () => import('./me/UserListView.vue'),
  // 用户详情与用户列表是**同一屏**（React `registry.tsx:139` 也是这么映射的）：明细是列表屏里的一个面板
  'user.detail': () => import('./me/UserListView.vue'),
  'profile.get': () => import('./me/ProfileView.vue'),
} as Readonly<Record<string, () => Promise<unknown>>>;
```

**"移植期零功能缺口"口径下的准确结论**：`permission.*` 在旧 React 版与旧 Android APP 中**都从未被调用**，所以移植它们**不构成"补齐旧功能"**——它们是**新功能（net-new）**，不是缺口。旧屏清单（`feature-parity.md:19-49` 的 29 个 `*Screen.kt`）里没有任何权限管理屏。

---

## 12. 后端对权限接口做了额外鉴权吗（例如只有 ADMIN 可写）？

### 裁决

> **没有。** 7 条 `permission.*` 只要求**登录**（有效 Bearer），**不要求任何角色或权限码**。任何已登录用户（包括只有"访客"角色的用户）都能创建、修改、删除权限。

### 证据 1：控制器/方法上没有任何权限注解

`PermissionController.java:13-79` 全文中 `@RequiresPermission` **零出现**（该文件 import 里也没有它）。对照 `UserController.java:66/74/85/94/108/120` 是有的 —— 说明这是"该加没加"，而不是"注解机制不生效"。

### 证据 2：注解检查确实会执行，只是这里没有注解可查

`WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/interceptor/AuthenticationInterceptor.java:71-83`

```java
        // 检查权限注解
        HandlerMethod handlerMethod = (HandlerMethod) handler;
        Method method = handlerMethod.getMethod();
        RequiresPermission requiresPermission = method.getAnnotation(RequiresPermission.class);

        // 如果方法上没有，检查类上是否有
        if (requiresPermission == null) {
            requiresPermission = handlerMethod.getBeanType().getAnnotation(RequiresPermission.class);
        }

        if (requiresPermission != null) {
            authApplicationService.checkPermission(username, requiresPermission.value());
        }
```

`requiresPermission == null` → **直接放行**。`PermissionController` 的方法与类都没有该注解 ⇒ 不检查。

### 证据 3：Spring Security 层面是"全放行"

`WiseDeoptServer/wise-deopt-infrastructure/src/main/java/com/huicang/wise/infrastructure/config/SecurityHeaderConfig.java:19-39`

```java
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http.cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .authorizeHttpRequests(
                        auth ->
                                auth.requestMatchers(
                                                "/swagger-ui/**",
                                                "/v3/api-docs/**",
                                                "/swagger-resources/**",
                                                "/webjars/**")
                                        .permitAll()
                                        .anyRequest()
                                        .permitAll())
```

`.anyRequest().permitAll()` —— Spring Security 不做任何 URL 级授权；真正的门是 `AuthenticationInterceptor`（只验登录）。

### 证据 4：仓库自己的 e2e 测试记录了"权限接口按普通用户放行"是已知现状

`WiseDeoptServer/wise-deopt-api/src/test/java/com/huicang/wise/api/security/ApiPrivilegeEscalationSecurityTest.java:237-243`

```java
    @Test
    void testAccessToPermissions() throws Exception {
        when(authApplicationService.validateToken(any())).thenReturn("user");

        mockMvc.perform(get("/api/permissions").header("Authorization", "Bearer user_token"))
                .andExpect(status().isOk());
    }
```

> ⚠️ 读这条测试要注意它自己的免责声明（`:34-37`）：

```java
// 说明：本用例断言的是鉴权/授权链路的失败行为，而 SecurityConfig 标注为 @Profile("prod")、
// 且 Spring Security 过滤器链在 @WebMvcTest 切片内为默认配置，无法复现该项目真实安全规则，
// 故归入 e2e 组（默认不执行，需真实环境：mvn test -Pe2e）。
```

它的 `@Tag("e2e")` 意味着默认 `mvn test` **不执行**。所以证据权重应以证据 1–3（生产代码）为准，本条只作旁证。

### 旁证（超管旁路）

`WiseDepotServer/wise-deopt-application/src/main/java/com/huicang/wise/application/permission/PermissionService.java:47-59`

```java
    private boolean isSuperAdmin(Long userId) {
        List<UserRole> userRoles = userRoleRepository.findByUserId(userId);
        for (UserRole userRole : userRoles) {
            Role role = roleRepository.findById(userRole.getRoleId()).orElse(null);
            if (role != null
                    && ("超级管理员".equals(role.getName())
                            || "管理员".equals(role.getName())
                            || "ADMIN".equalsIgnoreCase(role.getName()))) {
                return true;
            }
        }
        return false;
    }
```

`hasPermission` 里超管直接 `return true`（`:36-45`）。—— 与本 7 条接口无关（它们根本不查权限），但移植时勿把"权限体系"理解为"已在该接口生效"。

---

## 13. 实现者必须避开的坑

1. **别把 `packetType: 'UNKNOWN'` 当"不能用"**——它只是"控制器没有 `@ApiPacketType` 注解"，不参与任何分派/校验；7 条都能调通。
2. **`permission.create` 在真库上几乎必然 500（`SYS-0001`）**：`permission.create_by`/`update_by` 是 `NOT NULL`（+ 外键到 `user_core`），而服务层从不设置它们。UI 要么禁用，要么先修后端。
3. **`permission.delete` 对默认的 4 条权限必然 500**：`role_permission.permission_id` 有外键且**无** `ON DELETE CASCADE`，服务层也不检查引用。
4. **`permission.tree` 不是树**：生产数据下 `parentId` 恒 `null`，输出与 `permission.list` 等价（全为根、无 children）；后端实体和数据库都**没有** `parent_id`。不要据此做二级导航。
5. **`children` 在叶子处是 `null`，不是 `[]`**：直接 `.map()`/`.length` 会抛异常。
6. **`parentId` / `parentName` 永远是 `null`**（`permissionName` 才是名字）：`PermissionMapper` 与 `setParentName` 均无调用点。
7. **`{id}` 是主键 `permissionId`，不是 code**；按编码查必须走 `permission.byCode`（`/api/permissions/code/{code}`）。传非数字 id 得 400 + `VAL-0001`。
8. **`permission.update` 改不了 `code`**，且 `permissionName` 是 `@NotBlank`（只想改描述也要带上名字）。
9. **`parentId` 传了不生效也不报错**（create/update 都一样：字段存在、服务层不读、实体无此属性）。
10. **`permission.list` 不分页、返回裸数组**：不要传/读 `page`/`size`/`pageSize`/`total`/`records`，它们都不存在。
11. **业务失败是 HTTP 200**（`NOT_FOUND`、`VAL-CONFLICT-PERMISSION-1001` 都是 200 + `payload.errorCode`）：必须按 `payload.code !== 'RES-0000'` 判成败，不能按 HTTP 状态码。
12. **`permission.delete` 成功时 `payload.data` 是 `null`**（不是 `{}`、不是 DTO），前端别去做 `'permissionId' in data` 之类的判断。
13. **JSON 里 null 字段是"存在且为 null"**（Jackson 未启用 `NON_NULL`）：用 `value != null` 判空，别用 `'key' in obj`。
14. **`code` 里带 `:`（如 `user:view`）会被桥百分号编码为 `%3A`**，这是正常的；但含 `/`、`?`、`#` 的 code 会被桥直接判为参数非法（`BRIDGE_PARAMS_INVALID`）。
15. **未登录时后端会返回一个"非信封"的 400**（`RequestSignatureFilter`：`{"code":400,"message":"缺少必要的签名参数","data":null}`，`RequestSignatureFilter.java:52-61` + `:133-134`），桥侧会把它变成 `bridge.envelopeMalformed`（`OkHttpBackend.kt:101-107`）——别把这种报错误判成"权限接口坏了"，要先确认登录态。
16. **别把"移植 permission.\*"当成补历史缺口**：旧 React 版与旧 Android APP **都从未调用**过它们（§11），它是新功能，需要新的 UI 设计输入。

---

## 14. 仍不确定的事实（如实列出，未做推测性断言）

1. **`permission.create` / `permission.delete` 的 500 未在真实运行环境实测。** 本次是**只读代码调研**，未启动服务端、未连数据库。
   推断依据是 `tools/sql/wise_depot.sql:384-401`（导出的真库 DDL）+ `:510-525`（外键）与 `PermissionApplicationService.java:52-92` 的字段写入集合的**交集为空**。若线上库与这份 dump 不一致（例如列被手工改成可空、外键被删），结论会变。**未核实线上库当前 DDL。**
2. **`tools/sql/wise_depot.sql` 与生产库的同步时间未知**（文件本身没有导出时间戳/版本注释），也未核实当前运行实例用的是哪个库。
3. **`permission.create` 是否还有我未发现的 `create_by` 填充点。** 已检查：`Permission` 不继承 `BaseEntity`（`Permission.java:15`）、`orm.xml:179-216` 无 `<entity-listeners>`、全仓 grep `@PrePersist` 只命中 `BaseEntity.java:24`、全仓 grep `@EnableJpaAuditing|AuditingEntityListener` 零命中、grep `setCreateBy` 在权限链路上只命中 `DataInitializer.java:451`。**未排除**运行期通过原生 SQL / 触发器 / 其他 AOP 填充的可能（未做全量 AOP 切面清点）。
4. **Jackson 对"请求体里出现未知字段"的行为未在仓库中显式配置。** `JacksonConfiguration.java` 只设置了 `WRITE_NULL_MAP_VALUES`（那是序列化侧），没有 `FAIL_ON_UNKNOWN_PROPERTIES` 的显式设置；它注入的是 Spring Boot 的 `Jackson2ObjectMapperBuilder`，按 Spring Boot 默认应为 `false`（即未知字段被静默忽略）。
   **因此"`permission.update` 的 body 里多传一个 `permissionCode` 会怎样"（静默忽略 vs 400 `VAL-REQUEST-1001`）我无法确证**——只能说按 Spring Boot 默认为静默忽略。请勿据此写死。
5. **`permission.tree` 在"数据里真的存在父节点"时会不会不同，无从验证**：本后端没有任何写入 `parentId` 的路径（实体无字段、表无列），所以这个分支在生产上不可达；但**如果将来有人给表加 `parent_id` 列并手工插数据**，`Tree` 的算法会（按 `buildPermissionTree` 的逻辑）正确按 `parentId` 建树。这属于"当前不可达"而非"永远不可达"。
6. **`@PathVariable Long id` / `@PathVariable String code` 依赖编译期 `-parameters` 保留形参名**（注解未写显式名称）。当前服务端可运行（见 `docs/服务端本机运行验证记录.md`），说明构建确实保留了形参名；但**未核对 `pom.xml` 里对应的编译参数**，若有人改动构建配置，这两条路径变量会失效。
7. **`permission` 表在本机/线上当前的实际行数与内容未核实**；`docs/服务端本机运行验证记录.md:155` 记录为 4 行，但那是某一次运行的结果，且该文件自己声明"初始化日志称 5 条告警、实际落库 1 条"，说明播种结果与日志未必一致。

---

## 15. 关键文件索引（便于复核）

| 主题 | 文件 |
| --- | --- |
| 控制器（7 条路由的权威签名） | `WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/controller/PermissionController.java` |
| 应用服务（业务规则、异常原话） | `WiseDeoptServer/wise-deopt-application/src/main/java/com/huicang/wise/application/permission/PermissionApplicationService.java` |
| 请求体 DTO（校验注解） | `.../application/permission/CreatePermissionRequest.java`、`UpdatePermissionRequest.java` |
| 响应 DTO（字段清单） | `.../application/permission/PermissionDTO.java` |
| 实体 ↔ DTO 映射（决定 tree 语义） | `.../application/permission/PermissionMapper.java` |
| 领域实体（确认无 parentId） | `WiseDeoptServer/wise-deopt-domain/src/main/java/com/huicang/wise/domain/auth/Permission.java` |
| JPA 映射（确认无 parent_id 列） | `WiseDeoptServer/wise-deopt-infrastructure/src/main/resources/META-INF/orm.xml:179-216` |
| 真库 DDL / 外键 | `tools/sql/wise_depot.sql:384-401`、`:510-525` |
| 权限码种子 | `WiseDeoptServer/wise-deopt-infrastructure/src/main/java/com/huicang/wise/infrastructure/bootstrap/DataInitializer.java:244-248`、`:439-457` |
| 权限码使用点 | `.../api/controller/UserController.java:66,74,85,94,108,120` |
| 业务码取值 | `WiseDeoptServer/wise-deopt-common/src/main/java/com/huicang/wise/common/api/ErrorCode.java:18,20,21,30,82` |
| 信封解包（请求侧不校验 packet_type） | `.../api/handler/GlobalRequestAdvice.java:83-99` |
| 信封回填（响应侧 packet_type） | `.../api/handler/GlobalResponseAdvice.java:138-156` |
| 鉴权装配（全放行 + 登录拦截） | `.../infrastructure/config/SecurityHeaderConfig.java:19-39`、`.../api/config/WebMvcConfiguration.java:36-56` |
| 服务端现状固定的单测 | `WiseDepotServer/wise-deopt-application/src/test/java/com/huicang/wise/application/permission/PermissionApplicationServiceTest.java` |
| 契约生成器（UNKNOWN 的来源） | `WiseDepotClient/tools/gen/gen-bridge-contract.js:131-132` |
| 桥分派（不看 packetType） | `WiseDepotClient/bridge/server/src/main/kotlin/com/huicang/wise/bridge/server/BridgeDispatcher.kt:66-86` |
| 桥后端（信封打包） | `WiseDepotClient/bridge/backend/src/main/kotlin/com/huicang/wise/bridge/backend/Envelope.kt:40-57`、`OkHttpBackend.kt:108-120` |
| 迁移状态推导源 | `WiseDepotClient/apps/web/src/views/registry.ts`、`WiseDepotClient/docs/feature-parity.md:3-5,196-202` |
| 旧 Android APP（非 React） | `.archive/ARCHIVE.md`、`.archive/wise-depot-android-refactor/core/network/src/main/java/com/huicang/wise/network/PacketTypeMap.kt:127-133` |
| 旧 React 版（git tag `v0-react-freeze`） | `WiseDepotClient/docs/superpowers/specs/2026-10-02-vue3-dual-shell-rewrite-design.md:26,60` + `git grep ... v0-react-freeze` |
