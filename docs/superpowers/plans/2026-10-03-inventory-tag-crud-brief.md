# 简报：库存与标签主数据 CRUD（bridge → 真后端语义）

> 读者前提：你**没有**本次调研的上下文。这份文档自成一体，只依赖仓库里的文件。
> 调研方式：纯只读，逐行读 `WiseDeoptServer` 源码 + 契约生成物 + 桥实现 + 归档区；**没有跑过真后端**。
> 凡"源码里看出来的"和"我推出来的"都分开写，推出来的集中在最后一节。

## 0. 本简报覆盖的方法与权威来源

| 方法 id | HTTP | 真后端入口 |
| --- | --- | --- |
| `inventory.create` | POST | `WiseDeoptServer/wise-deopt-api/src/main/java/com/huicang/wise/api/controller/InventoryController.java:164` |
| `inventory.update` | PUT | 同上 `:211` |
| `inventory.delete` | DELETE | 同上 `:194` |
| `tag.create` | POST | `.../controller/TagController.java:50` |
| `tag.update` | PUT | 同上 `:59` |
| `tag.delete` | DELETE | 同上 `:69` |
| `tag.bind` | POST | 同上 `:136` |
| `tag.unbind` | POST | 同上 `:146` |
| `tag.batchBind` | POST | 同上 `:154` |
| `tag.batchBindWithCaptcha` | POST | 同上 `:165` |
| `tag.batchUnbind` | POST | 同上 `:174` |
| `tag.batchQuery` | POST | 同上 `:198` |

服务层：`WiseDeoptServer/wise-deopt-application/src/main/java/com/huicang/wise/application/inventory/InventoryApplicationService.java`、`.../application/tag/TagApplicationService.java`。
契约：`WiseDepotClient/packages/contract/src/generated/bridgeContract.ts`；覆盖表：`WiseDepotClient/tools/gen/bridge-overlay.json`。

---

## 1. 全局前提（不读这一节，下面每条都会看错）

### 1.1 请求体必须是"统一信封"，且 `payload.data` 只能是 JSON 对象

- `GlobalRequestAdvice.java:87-99`：
  ```java
  // 决策 3：只支持最新形状。没有统一信封的请求体一律拒绝，不再走过渡期兼容分支。
  if (!headerNode.isObject() || !payloadNode.isObject()) {
      throw new HttpMessageNotReadableException(
              "请求体缺少统一信封（header/payload）：请按 STD-CONTRACT-01 封装后再请求", originalMessage);
  }
  JsonNode dataNode = payloadNode.path("data");
  if (dataNode.isMissingNode() || dataNode.isNull()) {
      this.body = new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8));
  } else {
      this.body = new ByteArrayInputStream(dataNode.toString().getBytes(StandardCharsets.UTF_8));
  }
  ```
  控制器拿到的就是 `payload.data`，业务代码见不到信封。
- 桥侧封信封：`WiseDepotClient/bridge/backend/src/main/kotlin/com/huicang/wise/bridge/backend/Envelope.kt:40-52`
  ```kotlin
  fun wrap(packetType: String, requestId: String, data: JsonObject, nowMillis: Long): String {
      ...
      put("data", data)
  ```
  **签名写死 `JsonObject`** —— 桥永远没法把 `payload.data` 做成裸数组。这条直接决定了 §10 / §12 里 `tag.batchUnbind` / `tag.batchQuery` 的命运。
- 桥的调度侧也确认参数只能是对象：`BridgeDispatcher.kt:79` `params = params as? JsonObject`。

### 1.2 响应形状：`header` + `payload`，业务字段在 `payload` 里

`GlobalResponseAdvice.java:97-112` 把控制器的 `ApiResponse` 整体塞进 `Packet.payload`：

```java
PacketHeader header = new PacketHeader();
header.setRequestId(requestId);
header.setPacketType(packetTypeCode);
header.setTimestamp(timestamp);
Packet<Object> packet = new Packet<>(header, body);
```

所以线上真实形状是 **`{"header":{...},"payload":{"code","message","data","errorCode"}}`**。
`payload.data` 才是 §4/§9 里说的"返回体"。

- `ApiResponse.java:38-59`：`code` / `message` / `data` / `errorCode`（`httpStatus` 标了 `@JsonIgnore`）。
- `ApiResponse.java:89-91`：成功 = `ApiResponse.SUCCESS`，即 `code = "RES-0000"`。
- `ErrorCode.java:18`：`SUCCESS("RES-0000", "处理成功", 200)`。

### 1.3 业务错误走 **HTTP 200**，不是 4xx

`GlobalExceptionHandler.java:62-72`：

```java
@ExceptionHandler(BusinessException.class)
@ResponseStatus(HttpStatus.OK)
public ApiResponse<Void> handleBusinessException(...) {
    return ApiResponse.failure(ex.getErrorCode(), ex.getMessage());
}
```

服务层那句 `throw new BusinessException(ErrorCode.PARAM_ERROR, "条形码已存在")` 落到界面上是 **HTTP 200 + `payload.code = "VAL-0001"`**。
桥认这个：`OkHttpBackend.kt:108-120` 先看 HTTP 是否成功，再用 `unwrapped.code == Envelope.SUCCESS_CODE`（`RES-0000`）判成功，否则返回 Failed。**所以"HTTP 200"绝不等于"成功"，实现者不要只看状态码。**

常用码（`ErrorCode.java`）：

| 枚举 | code | message | 注释 |
| --- | --- | --- | --- |
| `SUCCESS` | `RES-0000` | 处理成功 | `:18` |
| `PARAM_ERROR` | `VAL-0001` | 请求参数不合法 | `:20` |
| `NOT_FOUND` | `RES-0004` | 资源不存在 | `:21` |
| `SYSTEM_ERROR` | `SYS-0001` | 系统内部错误，请稍后重试 | `:30` |
| `VAL_REQUEST_BODY_INVALID` | `VAL-REQUEST-1001` | 请求体解析失败 | `:52` |
| `VAL_PARAM_AUTH_CAPTCHA_ID_EMPTY` | `VAL-PARAM-AUTH-1009` | captchaId字段为空 | `:67` |
| `VAL_PARAM_AUTH_CAPTCHA_CODE_EMPTY` | `VAL-PARAM-AUTH-1010` | captchaCode字段为空 | `:68` |

> 注意：`VAL-PARAM-AUTH-1009/1010` 枚举上标的是 422，但它们是 `BusinessException`，被 `@ResponseStatus(HttpStatus.OK)` 罩住 → 实际仍是 **HTTP 200**。

### 1.4 `paramStyle` / `keepPathParamsInBody` 到底改了什么

桥实现 `OkHttpBackend.kt:54-89`：

```kotlin
val rest = PathTemplate.remaining(call.pathTemplate, call.params)
val wantsBody = call.httpMethod.uppercase() in setOf("POST", "PUT", "PATCH")
// 契约标了 QUERY 的方法：参数拼 query、**不发信封 body**。
val hasBody = wantsBody && call.paramStyle == ParamStyle.BODY
...
if (!hasBody) { for ((k, v) in rest) { ... urlBuilder.addQueryParameter(k, v.content) ... } }
...
hasBody && call.keepPathParamsInBody -> Envelope.wrap(..., call.params ?: JsonObject(...))
hasBody                        -> Envelope.wrap(..., rest)
wantsBody                      -> EMPTY_JSON_BODY   // "{}"，POST/PUT/PATCH 占位
else                           -> null
```

| 取值 | 含义 |
| --- | --- |
| `paramStyle: 'query'` | 路径参数之外**剩下的参数全部进 query string**，并且**不发信封 body**；若 HTTP 动词必须带 body，才发一个 `{}` 占位（`:154` `EMPTY_JSON_BODY = "{}"`）。这是给 `@RequestParam` 端点用的。 |
| `paramStyle: 'body'` | 参数封装进信封 `payload.data`；**路径参数默认被剔除**（`PathTemplate.remaining`）。 |
| `keepPathParamsInBody: true` | 路径参数**额外保留**在 `payload.data` 里。用于"DTP 里把路径参数又声明一次并加 `@NotNull`"的端点。 |

本简报覆盖的 12 条方法，**`keepPathParamsInBody` 全部是 `false`**，且后端也没有把路径参数写进 DTO —— 所以**没有 `VAL-0001` 形状的路径参数坑**（对照 `inspection.manualRecord` 才有，见 `bridge-overlay.json:296`）。

### 1.5 验证码总开关

`CaptchaApplicationService.java:44-45` 注入 `@Value("${wise.captcha.required:true}")`，`:61-77`：

```java
public void enforceCaptcha(String captchaId, String captchaCode) throws BusinessException {
    if (!captchaRequired) {
        log.warn("验证码校验已被配置关闭(wise.captcha.required=false)，当前请求跳过验证码校验");
        return;
    }
    if (captchaId == null || captchaId.isBlank()) {
        throw new BusinessException(
                ErrorCode.VAL_PARAM_AUTH_CAPTCHA_ID_EMPTY,
                ErrorCode.VAL_PARAM_AUTH_CAPTCHA_ID_EMPTY.getMessage());
    }
    if (captchaCode == null || captchaCode.isBlank()) {
        throw new BusinessException(
                ErrorCode.VAL_PARAM_AUTH_CAPTCHA_CODE_EMPTY,
                ErrorCode.VAL_PARAM_AUTH_CAPTCHA_CODE_EMPTY.getMessage());
    }
    verifyCaptcha(toVerifyRequest(captchaId, captchaCode));
}
```

`wise.captcha.required=false` 时**静默跳过**（只打一行 warn），此时 §10 与 §11 完全等价。
`verifyCaptcha`（同文件 `:106-124`）另有两句原话：`"验证码已过期或不存在"`（`:119`）、`"验证码错误"`（`:123`），码都是 `PARAM_ERROR`。

---

## 2. `inventory.create`（POST /api/inventories）

合同行：`bridgeContract.ts:108`
```ts
{ id: 'inventory.create', domain: 'inventory', httpMethod: 'POST', path: '/api/inventories', packetType: 'INVENTORY_CREATE', curated: true, paramStyle: 'body', keepPathParamsInBody: false },
```

### 参数

| 参数 | 位置 | 必填 | 默认 | 证据 |
| --- | --- | --- | --- | --- |
| （无路径参数） | — | — | — | `InventoryController.java:164` |
| 整个 body | `@RequestBody`（信封 `payload.data`） | 必填 | — | `:166-167` `@Parameter(...required = true) @Valid @RequestBody InventoryCreateRequest request` |
| `warehouseId` | body 字段 | 否（但见坑 A） | 无 | `InventoryCreateRequest.java:15` |
| `productId` | body 字段 | 是（服务层判） | 无 | `:20` |
| `quantity` | body 字段 | 是（服务层判） | 无 | `:25` |

`InventoryCreateRequest.java:10-49` 整个类**一个校验注解都没有**，`@Valid` 在这里是空转。

### 校验（全部在服务层，原话）

`InventoryApplicationService.java:244-253`
```java
public InventoryDTO createInventory(InventoryCreateRequest request) throws BusinessException {
    if (request.getProductId() == null) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "产品ID不能为空");
    }
    if (request.getQuantity() == null) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "库存数量不能为空");
    }
    if (productRepository.findById(request.getProductId()).isEmpty()) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "产品不存在");
    }
```
没有 `quantity >= 0` 校验 → **负数照收**（DB 是 `int unsigned`，MySQL 严格模式下会报错 → 500；非严格模式会被夹到 0）。

### 语义坑

**坑 A（最严重）：`warehouseId` 被完全忽略，字段根本没写进去。**

`InventoryApplicationService.java:254-259`
```java
Inventory entity = new Inventory();
entity.setProductId(request.getProductId());
entity.setQuantity(request.getQuantity());
entity.setLockedQuantity(0);
entity.setUpdateTime(LocalDateTime.now());
Inventory saved = inventoryRepository.save(entity);
```
传了 `warehouseId` 也**没有 `entity.setWarehouseId(...)`**。而 `inventory.warehouse_id` 在两份 schema 里都是 `NOT NULL`：
- `tools/sql/wise_depot.sql:268` `` `warehouse_id` bigint unsigned NOT NULL COMMENT '仓库id', ``
- `tools/p205-schema-snapshot.sql:170` `warehouse_id bigint not null,`

→ 实际结果是**插入失败 → HTTP 500 + `SYS-0001`（兜底 handler）**，不是"创建成功但没仓库"。`@Operation` 摘要还写着"产品不存在返回404"（`:162`），一个字没提仓库。

**坑 B：没有任何去重检查，重复创建不是幂等。**
`inventory` 上有唯一键 `` UNIQUE KEY `uk_warehouse_product` (`warehouse_id`,`product_id`) ``（`tools/sql/wise_depot.sql:274`），但服务层没有 `findByWarehouseIdAndProductId` 预检 —— `InventoryRepository.java:30` 定义了这个查询方法却没人用。撞唯一键就是 500，不是 400 文案。

**坑 C：`lockedQuantity` 强制归 0**（`:257`），入参没有对应字段，想建"已有锁定量的库存"做不到。

### 返回体

`payload.data` = 一个 `InventoryDTO` 对象。字段见 `InventoryDTO.java:12-77`。
但 `toInventoryDTO`（`InventoryApplicationService.java:575-605`）**只 set 了 6 个字段**：

```java
dto.setInventoryId(inventory.getInventoryId());
dto.setProductId(inventory.getProductId());
dto.setWarehouseId(inventory.getWarehouseId());
dto.setQuantity(inventory.getQuantity());
...
dto.setProductName(product.getName());
dto.setProductCode(product.getCode());
dto.setProductSpecification(product.getModel());
...
dto.setWarehouseName(warehouseOpt.get().getWarehouseName());
```

**永远是 null 的字段**：`lockedQuantity`、`updateTime`、`lastCheckTime`、`productType`、`productUnit`。
即：DTO 里有、但读不到 —— 界面要显示"锁定数量/最后更新时间"，这条路径给不出来。

### 证据汇总
`InventoryController.java:164-169`；`InventoryCreateRequest.java:10-49`；`InventoryApplicationService.java:242-263`、`:575-605`；`bridgeContract.ts:108`。

---

## 3. `inventory.update`（PUT /api/inventories/{inventoryId}）

合同行：`bridgeContract.ts:122` → `paramStyle: 'body'`，`keepPathParamsInBody: false`。

### 参数

| 参数 | 位置 | 必填 | 默认 |
| --- | --- | --- | --- |
| `inventoryId` | path | 必填 | — |
| `quantity` | body | 否 | 无（`null` = 保留） |
| `warehouseId` | body | 否 | 无（`null` = 保留） |

`InventoryController.java:211-219`
```java
@PutMapping("/{inventoryId}")
public ApiResponse<InventoryDTO> updateInventory(
        @Parameter(description = "库存明细ID", required = true) @PathVariable("inventoryId")
                Long inventoryId,
        @Parameter(description = "库存更新请求", required = true) @Valid @RequestBody
                InventoryUpdateRequest request) {
```

`InventoryUpdateRequest.java:10-37` **只有 `quantity` 与 `warehouseId` 两个字段**，无注解。
**`productId` 不在更新入参里** —— 库存明细一旦建错产品，这条接口改不了。

### 校验

`InventoryApplicationService.java:275-290`
```java
Inventory entity =
        inventoryRepository
                .findById(inventoryId)
                .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "库存明细不存在"));

if (request.getQuantity() != null) {
    entity.setQuantity(request.getQuantity());
}
if (request.getWarehouseId() != null) {
    if (!warehouseRepository.existsById(request.getWarehouseId())) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "仓库不存在");
    }
    entity.setWarehouseId(request.getWarehouseId());
}
```

### 语义坑

- **数字字段是 `!= null` 就写**：`quantity = 0` 是**写入 0**（清空库存），不是"没传"。
- `quantity` 为 `null` / 字段缺失 = **保留原值**。想清空必须显式传 `0`。
- **传 `""` 直接 400**：Jackson 无法把空串绑到 `Integer`/`Long` → `HttpMessageNotReadableException` → `GlobalExceptionHandler.java:188-195` → `VAL-REQUEST-1001`「请求体解析失败」。**"空白串"这一套在纯数字 DTO 上不存在**，别把 `product.update` 的 `isBlank` 语义套过来。
- `warehouseId` 无效 → `RES-0004`「仓库不存在」，**但 HTTP 200**。
- 改 `warehouseId` 可能撞唯一键 `uk_warehouse_product` → 500。
- `productId` 无法修改（字段不存在）。

### 返回体
同 §2：`InventoryDTO`，`lockedQuantity` / `updateTime` / `productType` / `productUnit` / `lastCheckTime` 恒为 `null`。

### 对比参照（仓库既有纪律）
- `inventory.update` 的"数字 null = 保留"与 `WarehouseListView.vue:18-19` 描述的 `warehouse.update`「`!= null` 就写」是**同一族**：
  > `WarehouseApplicationService#updateWarehouse` 四个字段都是 **`!= null` 就写**：也就是说传空串是**清空**，而不是"保留原值"（商品那边 `productName/productCode/unit` 用的是 `isBlank` 语义）。
- 与 `ProductListView.vue:18`「空白 = 保留原值」是**相反**的一族。**库存走的是 `!= null` 就写这一族。**

---

## 4. `inventory.delete`（DELETE /api/inventories/{inventoryId}）

合同行：`bridgeContract.ts:109` → `paramStyle: 'query'`，`keepPathParamsInBody: false`。
路径 `/api/inventories/{inventoryId}` 里唯一的参数是路径参数，`PathTemplate.remaining` 之后 `rest` 为空 → query 里没有东西，body 走 `EMPTY_JSON_BODY` `"{}"`（`OkHttpBackend.kt:87`）。控制器没有 `@RequestBody`，不受影响。

### 参数
| 参数 | 位置 | 必填 |
| --- | --- | --- |
| `inventoryId` | path | 必填（`InventoryController.java:194-197`） |

### 校验 / 语义
`InventoryApplicationService.java:323-331`
```java
public void deleteInventory(Long inventoryId) throws BusinessException {
    Inventory entity =
            inventoryRepository
                    .findById(inventoryId)
                    .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "库存明细不存在"));
    inventoryRepository.delete(entity);
```
- 硬删除，**没有软删、没有幂等**：第二次删同一 id → `RES-0004`「库存明细不存在」。
- 没做"有锁定库存就不许删"之类的状态检查（`lockedQuantity` 多少都能删）。

### 返回体
`InventoryController.java:195-199`
```java
inventoryApplicationService.deleteInventory(inventoryId);
return ApiResponse.success(null);
```
→ **`payload.data` 是 `null`**（不是 `{}`，也不是空数组）。桥 `Envelope.unwrap` 会给出 `data = JsonNull`。

---

## 5. `tag.create`（POST /api/tag）

合同行：`bridgeContract.ts:187` → `paramStyle: 'body'`。
后端：`TagController.java:49-55` `@PostMapping`（类级 `@RequestMapping("/api/tag")`，见 `:39`）。

### 参数
`ProductTagCreateRequest.java:9-19`（**无任何校验注解**）
```java
private Long productId;
private String barcode;
private String nfcUid;
private String rfid;
private Short status;
```

| 参数 | 位置 | 必填 | 默认 |
| --- | --- | --- | --- |
| `productId` | body | 否 | 不写 → 标签不绑任何产品 |
| `barcode` / `nfcUid` / `rfid` | body | 三个至少一个非空白 | 空白 → 存 `null` |
| `status` | body | 否 | **0** |

### 校验（服务层原话）

`TagApplicationService.java:53-77`
```java
boolean hasBarcode = request.getBarcode() != null && !request.getBarcode().isBlank();
boolean hasNfc = request.getNfcUid() != null && !request.getNfcUid().isBlank();
boolean hasRfid = request.getRfid() != null && !request.getRfid().isBlank();

if (!hasBarcode && !hasNfc && !hasRfid) {
    throw new BusinessException(ErrorCode.PARAM_ERROR, "条形码、NFC标识、RFID标识至少需填写一项");
}

if (hasBarcode && tagRepository.existsByBarcode(request.getBarcode())) {
    throw new BusinessException(ErrorCode.PARAM_ERROR, "条形码已存在");
}

if (hasRfid && tagRepository.existsByRfid(request.getRfid())) {
    throw new BusinessException(ErrorCode.PARAM_ERROR, "RFID标识已存在");
}

if (hasNfc && tagRepository.existsByNfcUid(request.getNfcUid())) {
    throw new BusinessException(ErrorCode.PARAM_ERROR, "NFC标识已存在");
}

if (request.getProductId() != null) {
    if (productRepository.findById(request.getProductId()).isEmpty()) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "产品不存在");
    }
}
```

唯一性是**全库级**（`TagRepository.java:91/99/107` 的 `existsByBarcode` / `existsByRfid` / `existsByNfcUid` 都只有单参数，没有 `productId` 维度），DB 侧同样是三列各自唯一：`tools/sql/wise_depot.sql:435-437`
```sql
  UNIQUE KEY `uk_barcode` (`barcode`),
  UNIQUE KEY `uk_nfc_uid` (`nfc_uid`),
  UNIQUE KEY `uk_rfid` (`rfid`),
```

### 语义坑

**坑 D：空白串 = 存 `null`（不是保留、不是报错）。**
`TagApplicationService.java:83-94`
```java
entity.setBarcode(
        request.getBarcode() != null && !request.getBarcode().isBlank()
                ? request.getBarcode()
                : null);
```
三个标识字段都是这个写法。但唯一性检查发生在**此前**（`:61-71`），`isBlank` 的不参与检查 —— 所以"传一片空格"能稳定把该列清成 `null`。

**坑 E：`status` 默认为 0，且完全不做范围校验。**
`TagApplicationService.java:95`
```java
entity.setStatus(request.getStatus() != null ? request.getStatus() : 0);
```
`ProductTag.java:35-37` 声明 `/** 标签状态：0：未入库 1：已入库 2：已出库 */`。传 `status: 7` 或 `-1` 一律照写（DB `tinyint unsigned`，负数会炸 500）。

**坑 F：带 `productId` 建标签 ≠ 已绑定。**  `:80-82` 只 `setProductId`，`status` 仍走默认 0。于是会出现「`productId` 有值、`status = 0`」这种自相矛盾的标签 —— 全仓用 `status === 1` 判"已绑定"（见 `WiseDepotClient/apps/web/src/views/inventory/TagListView.vue:89`），这种标签在界面上会显示"未绑定"却挂着商品。

**坑 G：`createBy` 硬编码为 1。**  `TagApplicationService.java:96` `entity.setCreateBy(1L);` —— 不取登录用户。`product_tag.create_by` 有外键到 `user_core`（`tools/sql/wise_depot.sql:443`），若 `user_id = 1` 不存在则 500。

### 返回体
`toProductTagDTO`（`TagApplicationService.java:438-458`）：
```java
dto.setTagId(entity.getTagId());
dto.setProductId(entity.getProductId());
dto.setBarcode(entity.getBarcode());
dto.setNfcUid(entity.getNfcUid());
dto.setRfid(entity.getRfid());
dto.setStatus(entity.getStatus());
dto.setCreateBy(entity.getCreateBy());
dto.setCreateTime(entity.getCreateTime());
dto.setUpdateTime(entity.getUpdateTime());

if (entity.getProductId() != null) {
    Product product = productRepository.findById(entity.getProductId()).orElse(null);
    if (product != null) {
        dto.setProductName(product.getName());
    }
}
```
**`productCode` 永远不被 set** —— `ProductTagDTO.java:34` 有这个字段，但 12 条 tag 接口的返回里它**永远是 `null`**。列表页（`TagListView.vue:61`）想拿"商品编码"得自己再查 `product.list`。

---

## 6. `tag.update`（PUT /api/tag/{tagId}）

合同行：`bridgeContract.ts:193` → `paramStyle: 'body'`，`keepPathParamsInBody: false`。

### 参数
`TagController.java:59-65`
```java
@PutMapping("/{tagId}")
public ApiResponse<ProductTagDTO> updateTag(
        @Parameter(description = "标签ID", required = true) @PathVariable("tagId") Long tagId,
        @Parameter(description = "标签更新请求", required = true) @Valid @RequestBody
                ProductTagUpdateRequest request) {
```
`ProductTagUpdateRequest.java:10-20`（**无注解**）：`productId`、`status`(Short)、`barcode`、`nfcUid`、`rfid`。

### 校验与语义（逐字段）

`TagApplicationService.java:115-161`
```java
ProductTag entity =
        tagRepository
                .findById(tagId)
                .orElseThrow(() -> new BusinessException(ErrorCode.NOT_FOUND, "标签不存在"));

if (request.getProductId() != null) {
    if (productRepository.findById(request.getProductId()).isEmpty()) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "产品不存在");
    }
    entity.setProductId(request.getProductId());
}

if (request.getStatus() != null) {
    entity.setStatus(request.getStatus());
}

if (request.getBarcode() != null) {
    if (!request.getBarcode().isBlank()
            && !request.getBarcode().equals(entity.getBarcode())
            && tagRepository.existsByBarcode(request.getBarcode())) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "条形码已存在");
    }
    entity.setBarcode(request.getBarcode().isBlank() ? null : request.getBarcode());
}
```
`nfcUid`（`:140-147`）、`rfid`（`:149-156`）与 `barcode` 同构，错误文案分别是 `"NFC标识已存在"` / `"RFID标识已存在"`。

| 字段 | `null`（或字段缺失） | `""` / 纯空白 | 有值 |
| --- | --- | --- | --- |
| `productId` | 保留原值 | **400**（Jackson 绑不上 `Long`，`VAL-REQUEST-1001`） | 校验存在性后写入 |
| `status` | 保留原值 | **400**（绑不上 `Short`） | 直接写入，**无范围校验** |
| `barcode` / `nfcUid` / `rfid` | 保留原值 | **清成 `null`** | 与当前值不同才查重，重复 → `VAL-0001` |

**坑 H：空白串在这里 = 清空，与"保留"是相反的两族。**
`entity.setBarcode(request.getBarcode().isBlank() ? null : request.getBarcode());` —— 这一行的语义**和 `product.update` 的 `isBlank`=保留相反，和 `warehouse.update` 的 `!= null` 就写同族**。界面若把输入框 `trim()` 完直接传，用户删空条码就会真的清库。

**坑 I：可以直接改 `productId` 而不动 `status`，两边会失配。**
`:120-129` 两段互不耦合。改 `productId` 不会把 `status` 调成 1；反过来也能把 `status` 设成 1 而 `productId` 仍是 `null`。只有 `tag.bind`（§8）和 `tag.batchBind`（§10）会强制 `status=1`。

**坑 J：无法通过这条接口解绑。**  `productId` 传 `null` = 保留，传 `0` 会走"产品不存在"校验。要解绑只能用 `tag.unbind` / `tag.batchUnbind`。

**坑 K：写操作不失效 tag 缓存。**
`getTag` 带缓存：`TagApplicationService.java:185-186`
```java
@Cacheable(prefix = "tag", key = "#tagId", timeout = 1800)
public ProductTagDTO getTag(Long tagId) throws BusinessException {
```
`getTagByCode` 同样（`:201-202`，`prefix = "tag:code"`，1800 秒）。
而 **`updateTag` / `deleteTag` / `bindTag` / `unbindTag` 上没有任何 `@CacheEvict`**（该文件的 import 里只有 `Cacheable`，见 `:10`；全文件搜不到 `CacheEvict`）。→ 改完标签后，`tag.detail` 最长 30 分钟仍返回旧值。这是"点了保存但详情没变"的成因。

### 返回体
同 §5：`ProductTagDTO`，`productCode` 恒 `null`。

---

## 7. `tag.delete`（DELETE /api/tag/{tagId}）

合同行：`bridgeContract.ts:188` → `paramStyle: 'query'`（无剩余参数，body 为 `"{}"` 占位）。

### 参数 / 校验
`TagController.java:69-74` → `TagApplicationService.java:171-176`
```java
public void deleteTag(Long tagId) throws BusinessException {
    if (!tagRepository.existsById(tagId)) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "标签不存在");
    }
    tagRepository.deleteById(tagId);
}
```

**坑 L：只查"存在"，不查"被引用"，被引用时是 500 不是 400。**
`product_tag.tag_id` 被两张表外键引用：
- `tools/sql/wise_depot.sql:174` `CONSTRAINT `inspection_detail_ibfk_2` FOREIGN KEY (`tag_id`) REFERENCES `product_tag` (`tag_id`)`
- `tools/sql/wise_depot.sql:577` `CONSTRAINT `stock_order_item_ibfk_2` FOREIGN KEY (`tag_id`) REFERENCES `product_tag` (`tag_id`)`

删一个已经出现在巡检明细或出入库单里的标签 → `DataIntegrityViolationException` → 落到兜底 `@ExceptionHandler(Exception.class)`（`GlobalExceptionHandler.java:316-317`）→ **HTTP 500 + `SYS-0001`「系统内部错误，请稍后重试」**。界面上只会看到"系统错误"，看不出是"这个标签在用"。

**坑 M：同样是硬删除 + 无幂等**（第二次 → `RES-0004`「标签不存在」）。
**坑 N：`getTag` 的缓存不失效**（同坑 K）→ 删完 `tag.detail` 还能读到幽灵数据。

### 返回体
`return ApiResponse.success(null);`（`TagController.java:73`）→ **`payload.data` 为 `null`**。

---

## 8. `tag.bind`（POST /api/tag/{tagId}/bind）

合同行：`bridgeContract.ts:184` → **`paramStyle: 'query'`**，`keepPathParamsInBody: false`。
`bridge-overlay.json:284` 专门解释了原因：
```json
"tag.bind": "POST /api/tag/{tagId}/bind —— @RequestParam(\"productId\")"
```

### 参数
`TagController.java:136-142`
```java
@PostMapping("/{tagId}/bind")
public ApiResponse<ProductTagDTO> bindTag(
        @Parameter(description = "标签ID", required = true) @PathVariable("tagId") Long tagId,
        @Parameter(description = "产品ID", required = true) @RequestParam("productId")
                Long productId) {
    return ApiResponse.success(tagApplicationService.bindTag(tagId, productId));
}
```

| 参数 | 位置 | 必填 | 默认 |
| --- | --- | --- | --- |
| `tagId` | **path** | 必填 | — |
| `productId` | **query string**（不是 body！） | **必填**，无默认 | — |

**产品 id 从哪来**：就是调用方自己传的 query 参数 `productId`；后端不接受"从标签身上推导"，也不接受 body。
漏传 → `MissingServletRequestParameterException` → `GlobalExceptionHandler.java:220-225` → **400 + `VAL-0001`「缺少必需的请求参数: productId」**。

### 语义

`TagApplicationService.java:286-304`
```java
public ProductTagDTO bindTag(Long tagId, Long productId) throws BusinessException {
    if (!tagRepository.existsById(tagId)) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "标签不存在");
    }

    if (productRepository.findById(productId).isEmpty()) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "产品不存在");
    }

    int updated = tagRepository.bindProduct(tagId, productId);
    if (updated == 0) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "绑定失败");
    }
    ...
```

`TagRepository.java:191-193`
```java
@Modifying
@Query("UPDATE ProductTag t SET t.productId = :productId, t.status = 1 WHERE t.tagId = :tagId")
int bindProduct(@Param("tagId") Long tagId, @Param("productId") Long productId);
```

**坑 O：绑定会强行把 `status` 覆写成 1。**  这是服务端的硬编码，不是"保持原状态"。一个 `status = 2`（已出库）的标签被 bind 后变成 `1`（已入库），旧状态丢失、不可恢复。
**坑 P：重复绑同一产品 = 幂等成功**（UPDATE 匹配到行，affected > 0）；但**把一个已绑在 A 产品的标签绑到 B 产品不会报错**，而是静默改嫁（旧绑定关系无任何提示、无审计）。
**坑 Q：`productId` 走 query**。实现者若按"body 传参"接，会得到 400「缺少必需的请求参数: productId」，且界面上看着像"点了没反应"。

### 返回体
绑定后的 `ProductTagDTO`（`productId` / `status = 1` / `productName`；`productCode` 仍为 `null`）。

---

## 9. `tag.unbind`（POST /api/tag/{tagId}/unbind）

合同行：`bridgeContract.ts:192` → `paramStyle: 'body'`，`keepPathParamsInBody: false`。

### 参数
`TagController.java:146-150` —— **只有路径参数 `tagId`，没有 `@RequestParam`，没有 `@RequestBody`**。
（`paramStyle: 'body'` 只是契约的默认归类；`rest` 为空对象，桥发 `{"header":...,"payload":{"code":"RES-0000","message":"请求","data":{}}}`，后端不解析 body，无害。）

**解绑需要什么**：只需要 `tagId`。不需要 `productId`，也不需要验证码。

### 语义
`TagApplicationService.java:315-329`
```java
public ProductTagDTO unbindTag(Long tagId) throws BusinessException {
    if (!tagRepository.existsById(tagId)) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "标签不存在");
    }

    int updated = tagRepository.unbindProduct(tagId);
    if (updated == 0) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "解绑失败");
    }
```
`TagRepository.java:170-172`
```java
@Modifying
@Query("UPDATE ProductTag t SET t.productId = NULL, t.status = 0 WHERE t.tagId = :tagId")
int unbindProduct(@Param("tagId") Long tagId);
```

**坑 R：解绑把 `status` 打回 0（未入库），不是"只清绑定"。**  附带后果：被解绑前是 `2`（已出库）的状态也一并丢失。

**坑 S（高风险，见 §14）：`SET product_id = NULL` 要求该列可空，但两份 schema 说法不一致。**
- `tools/sql/wise_depot.sql:426` `` `product_id` bigint unsigned NOT NULL COMMENT '产品id', ``
- `tools/p205-schema-snapshot.sql:265` `product_id bigint,`

而补丁脚本 `tools/sql/fix_product_tag_nullable.sql:8-14` **只把 `barcode` / `nfc_uid` / `rfid` 改成 NULL，没动 `product_id`**：
```sql
ALTER TABLE product_tag MODIFY COLUMN barcode varchar(100) NULL COMMENT '条形码';
ALTER TABLE product_tag MODIFY COLUMN nfc_uid varchar(100) NULL COMMENT 'NFC标识';
ALTER TABLE product_tag MODIFY COLUMN rfid varchar(100) NULL COMMENT 'RFID标识';
```
→ 如果线上的库是按 `wise_depot.sql` 建的（补丁脚本的存在说明它就是这么建的），**`tag.unbind` 与 `tag.batchUnbind` 都会因为 NOT NULL 约束直接 500**。我无法验证线上实际 DDL，见 §14。

**坑 T：`updated == 0` 判定不可靠。**  JPA `@Modifying` 返回的是 UPDATE 影响行数；MySQL Connector/J 默认 `useAffectedRows=false`，返回的是"匹配行数"，所以重复解绑仍是 `1`（成功）。但若 JDBC URL 显式开了 `useAffectedRows=true`，对"本来就没绑定"的标签这一 UPDATE 是 no-op → 返回 0 → 抛 `VAL-0001`「解绑失败」。**同一个操作在不同连接参数下语义不同**（见 §14）。

**坑 U：解绑不清 `productName` —— 因为它是 DTO 派生字段。**  `productId` 为 `null` 后 `toProductTagDTO` 不会再查产品，`productName` 自然为 `null`（`TagApplicationService.java:450-455`）。

**坑 V：`getTag` 缓存不失效**（同坑 K）。

### 返回体
解绑后的 `ProductTagDTO`：`productId = null`、`status = 0`、`productName = null`、`productCode = null`。

---

## 10. `tag.batchBind`（POST /api/tag/batch-bind）

合同行：`bridgeContract.ts:180` → `paramStyle: 'body'`。

### 参数
`TagController.java:152-159`
```java
@PostMapping("/batch-bind")
public ApiResponse<BatchBindResult> batchBindTags(
        @Parameter(description = "批量绑定请求", required = true) @Valid @RequestBody
                ProductTagBatchBindRequest request) {
```
`ProductTagBatchBindRequest.java:11-15`（**无注解**）：`productId`(Long)、`tagIds`(List&lt;Long&gt;)。

### 校验 / 语义
`TagApplicationService.java:340-363`
```java
public BatchBindResult batchBindTags(ProductTagBatchBindRequest request)
        throws BusinessException {
    if (request.getProductId() == null) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "产品ID不能为空");
    }

    if (request.getTagIds() == null || request.getTagIds().isEmpty()) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "标签ID列表不能为空");
    }

    if (productRepository.findById(request.getProductId()).isEmpty()) {
        throw new BusinessException(ErrorCode.NOT_FOUND, "产品不存在");
    }

    int updated = tagRepository.batchBindProducts(request.getTagIds(), request.getProductId());

    BatchBindResult result = new BatchBindResult();
    result.setProductId(request.getProductId());
    result.setTotalCount(request.getTagIds().size());
    result.setSuccessCount(updated);
    result.setFailedCount(request.getTagIds().size() - updated);

    return result;
}
```
`TagRepository.java:202-205`：`UPDATE ProductTag t SET t.productId = :productId, t.status = 1 WHERE t.tagId IN :tagIds`。

**坑 W：不存在的 `tagId` 不报错，静默计入 `failedCount`。**  全流程没有 `tagRepository.existsById` 逐个预检。传 100 个 id、其中 60 个不存在 → HTTP 200 + `successCount=40`、`failedCount=60`，不告诉你是哪 60 个。
**坑 X：`totalCount` 按入参长度算，含重复 id。**  `tagIds = [7,7]` → `totalCount=2`、`successCount=1`（SQL 只匹配一行）、`failedCount=1` —— 数字自洽但具有误导性。
**坑 Y：`successCount` 是 SQL 影响行数，不是"业务成功数"** —— 已绑在同一产品上的标签也会被计入成功。
**坑 Z（重点）：这条接口不需要验证码。**  它是 §11 的"绕过通道"，见下。

### 返回体
`payload.data` = `BatchBindResult` 对象（`BatchBindResult.java:11-17`）：`productId` / `totalCount` / `successCount` / `failedCount`。

---

## 11. `tag.batchBindWithCaptcha`（POST /api/tag/batch-bind-with-captcha）

合同行：`bridgeContract.ts:181` → **同一个 `packetType: 'TAG_BATCH_BIND'`**、`paramStyle: 'body'`。

### 参数
`TagController.java:165-169` → `@Valid @RequestBody ProductTagBatchBindRequestWithCaptcha`。
`ProductTagBatchBindRequestWithCaptcha.java:6-12`
```java
@Data
public class ProductTagBatchBindRequestWithCaptcha {
    private Long productId;
    private List<Long> tagIds;
    private String captchaId;
    private String captchaCode;
}
```
`@Data` 是 Lombok；注意**类上同样没有任何校验注解**，`@Valid` 空转。`captchaId` / `captchaCode` 的"必填"完全靠 §1.5 的 `enforceCaptcha` 兜。

### **`tag.batchBind` 与 `tag.batchBindWithCaptcha` 的区别到底是什么**

区别只有两点，别的**完全一样**：

`TagApplicationService.java:365-376`
```java
@Transactional
public BatchBindResult batchBindTagsWithCaptcha(ProductTagBatchBindRequestWithCaptcha request)
        throws BusinessException {
    // 验证码为必填项：防止绕过验证码直接批量绑定标签
    captchaApplicationService.enforceCaptcha(request.getCaptchaId(), request.getCaptchaCode());

    ProductTagBatchBindRequest bindRequest = new ProductTagBatchBindRequest();
    bindRequest.setProductId(request.getProductId());
    bindRequest.setTagIds(request.getTagIds());

    return batchBindTags(bindRequest);
}
```

1. **多两个入参**：`captchaId` / `captchaCode`（都在 body 里）。
2. **多一道前置校验**：`enforceCaptcha`，且是**硬性**的（缺失/空白即抛异常，不再是"不传就跳过"）。

之后就是直接复用 `batchBindTags` —— **§10 的坑 W / X / Y 全部原样继承**，`BatchBindResult` 也一模一样。
另外：`wise.captcha.required=false` 时 `enforceCaptcha` 直接 `return`（`CaptchaApplicationService.java:62-65`），**这条接口就退化成 `tag.batchBind`**。

### 验证码参数的校验位置与文案
| 情况 | 抛出位置 | 码 | 文案 | 线上 HTTP |
| --- | --- | --- | --- | --- |
| `captchaId` 缺失/空白 | `CaptchaApplicationService.java:66-70` | `VAL-PARAM-AUTH-1009` | `captchaId字段为空` | **200** |
| `captchaCode` 缺失/空白 | `:71-75` | `VAL-PARAM-AUTH-1010` | `captchaCode字段为空` | **200** |
| redis 里查不到（过期） | `:118-120` | `VAL-0001` | `验证码已过期或不存在` | **200** |
| 对不上（忽略大小写） | `:122-123` | `VAL-0001` | `验证码错误` | **200** |

> `verifyCaptcha` 用 `storedCode.equalsIgnoreCase(...)`（`:122`）→ **验证码大小写不敏感**。且**校验通过后不从 redis 删除**（该文件里没有 delete 调用）→ 同一张验证码在同一有效期内**可重复使用**。这是"一次性"假设之外的坑。

### 返回体
与 `tag.batchBind` 完全相同：`BatchBindResult`。

---

## 12. `tag.batchUnbind`（POST /api/tag/batch-unbind）

合同行：`bridgeContract.ts:183` → `paramStyle: 'body'`。

### 参数 —— 注意这里是**裸数组**
`TagController.java:172-179`
```java
@Operation(summary = "批量解绑标签", description = "批量解绑标签与产品的关联。成功返回200；参数错误返回400；服务器异常返回500。")
@ApiPacketType(PacketType.TAG_BATCH_UNBIND)
@PostMapping("/batch-unbind")
public ApiResponse<BatchUnbindResult> batchUnbindTags(
        @Parameter(description = "标签ID列表", required = true) @Valid @RequestBody
                List<Long> tagIds) {
    return ApiResponse.success(tagApplicationService.batchUnbindTags(tagIds));
}
```
**请求体不是对象，是 `List<Long>`** —— `payload.data` 必须是一个**裸 JSON 数组** `[1,2,3]`。

### **坑 AA（结构性，最值得先确认）：桥按名字接会必然 400。**
- 桥参数恒为 `JsonObject`：`BridgeDispatcher.kt:79` `params = params as? JsonObject`。
- 信封只能是对象：`Envelope.kt:40` `data: JsonObject`。
- 于是 `bridge.call('tag.batchUnbind', { tagIds })` 生成的 `payload.data` 是 **`{"tagIds":[1,2]}`**，而控制器要 `List<Long>`。
- 服务端解包逻辑：`GlobalRequestAdvice.java:92-99` 取出 `payload.data` 原文交给 Jackson → `{"tagIds":[...]}` 绑到 `List<Long>` → `MismatchedInputException` → `HttpMessageNotReadableException` → `GlobalExceptionHandler.java:188-195` → **HTTP 400 + `VAL-REQUEST-1001`「请求体解析失败」**。

这条不是我跑出来的，是从三处源码推出来的（见 §14）。**落地前请用真后端打一发确认。**

### 校验 / 语义
`TagApplicationService.java:384-398`
```java
public BatchUnbindResult batchUnbindTags(List<Long> tagIds) {
    if (tagIds == null || tagIds.isEmpty()) {
        throw new BusinessException(ErrorCode.PARAM_ERROR, "标签ID列表不能为空");
    }

    int updated = tagRepository.batchUnbindProducts(tagIds);

    BatchUnbindResult result = new BatchUnbindResult();
    result.setTotalCount(tagIds.size());
    result.setSuccessCount(updated);
    result.setFailedCount(tagIds.size() - updated);

    return result;
}
```
`batchUnbindProducts` = `UPDATE ProductTag t SET t.productId = NULL, t.status = 0 WHERE t.tagId IN :tagIds`（`TagRepository.java:180-182`）。

- **不需要验证码**，只要 `tagIds` 非空。
- **不检查 tag 是否存在**（同坑 W）：不存在的 id 静默进 `failedCount`。
- **`status` 一律打回 0**（同坑 R），已出库状态丢失。
- **`product_id = NULL` 的 NOT NULL 风险**同坑 S。
- `[]` 空数组 → `VAL-0001`「标签ID列表不能为空」（HTTP 200）。
- `null` / 无 body 字段 → 契约上是"请求体解析失败"（400）。

### 返回体
`BatchUnbindResult`（`BatchUnbindResult.java:9-16`）：`totalCount` / `successCount` / `failedCount`。**注意它没有 `productId`**，和 `BatchBindResult` 不同形状。

---

## 13. `tag.batchQuery`（POST /api/tag/batch-query）

合同行：`bridgeContract.ts:182` → `paramStyle: 'body'`，`packetType: 'TAG_LIST'`。

### 参数 —— 同样是**裸数组**，而且元素是字符串
`TagController.java:196-203`
```java
@Operation(summary = "批量查询标签", description = "根据标签编码列表批量查询标签信息。成功返回200；服务器异常返回500。")
@ApiPacketType(PacketType.TAG_LIST)
@PostMapping("/batch-query")
public ApiResponse<List<ProductTagDTO>> batchGetTags(
        @Parameter(description = "标签编码列表", required = true) @Valid @RequestBody
                List<String> tagCodes) {
    return ApiResponse.success(tagApplicationService.batchGetTags(tagCodes));
}
```
`payload.data` 必须是裸字符串数组 `["A001","A002"]` → **坑 AA 完全同样适用**。

### 语义

`TagApplicationService.java:427-436`
```java
/**
 * 方法功能描述：批量查询标签
 *
 * @param barcodes 条形码列表
 * @return 标签列表
 */
public List<ProductTagDTO> batchGetTags(List<String> barcodes) {
    List<ProductTag> entities = tagRepository.findByBarcodeIn(barcodes);
    return entities.stream().map(this::toProductTagDTO).collect(Collectors.toList());
}
```
`TagRepository.java:161-162`：`@Query("SELECT t FROM ProductTag t WHERE t.barcode IN :barcodes")`。

**坑 BB：名字叫"标签编码"，实现只按 `barcode` 匹配。**  传 `nfcUid` 或 `rfid` 一律查不到（`where t.barcode in ...`），也不报错，只是"少了几条"。方法参数在服务层被直接改名成 `barcodes`（`:430-434`），说明作者知道，但接口描述没改。

**坑 CC：没有空列表/空值校验。**  传 `[]` → `IN ()` → 返回空数组（200）；传 `[null]` → 行为未定义（见 §14）。这是 §10–§12 里**唯一**没有 `isEmpty` 守卫的批量接口。

**坑 DD：按 barcode 查，所以"只登记了 RFID 的标签"永远批量查不到** —— 而 `tag.create` 明确允许三个标识只填一个（`TagApplicationService.java:57-59`）。两个接口的口径互相打架。

### 返回体
`payload.data` = **裸数组** `List<ProductTagDTO>`（不是 `{total, rows}` 分页对象）。每个元素的 `productCode` 仍是 `null`（同 §5）。

---

## 14. 旧客户端（React / Android）怎么用的，以及旧版的**已知的错**

### 14.1 「旧 React 版」在工作区里**已经不存在**

- 删除记录：`WiseDepotClient/docs/superpowers/plans/2026-10-02-v0-v1-executable-plan.md:837` 标题即 `## V6 执行记录 · 删除 React 版（2026-10-02）`。
- 回滚点与恢复命令同文件 `:861`：
  > 恢复方式：`git checkout v0-react-freeze -- packages/features packages/shells packages/patterns apps/web/src/App.tsx apps/web/src/main.tsx`。
- 我实际验证：`packages/features` 目录在磁盘上不存在（`glob` 报 `os error 2`），全仓无 `*.tsx`；`git tag -l` 只有 `v0-react-freeze`。

→ 要看旧 React 版，只能从 tag 取：`git -C WiseDepotClient show v0-react-freeze:<path>`。相关屏（该 tag 下的清单）：
`packages/features/src/inventory/TagListScreen.tsx`、`TagDetailScreen.tsx`、`InventoryListScreen.tsx`、`InventoryDetailScreen.tsx`、`ProductListScreen.tsx`、`WarehouseListScreen.tsx`。

**旧 React 版对这 12 条方法的覆盖情况（我逐个 grep 过）：**

| 方法 | React 版是否用过 |
| --- | --- |
| `tag.batchBindWithCaptcha` | ✅ `TagListScreen.tsx:130` |
| `tag.batchUnbind` | ✅ `TagListScreen.tsx:137` |
| `tag.list` / `tag.detail` / `tag.byCode` | ✅（只读屏） |
| `inventory.create` / `inventory.update` / `inventory.delete` | ❌ 从未调用 |
| `tag.create` / `tag.update` / `tag.delete` / `tag.bind` / `tag.unbind` / `tag.batchBind` / `tag.batchQuery` | ❌ 从未调用 |

**旧 React 版的具体写法（`TagListScreen.tsx:79-82、116-138`，从 tag 取出）：**
```tsx
const { loading, data, error, reload } = useBridgeCall<unknown>(bridge, 'tag.list', {
  page,
  size: PAGE_SIZE,
});
...
    if (batch === 'bind' && (!productId.trim() || !captcha.code.trim())) {
      setActionError('批量绑定需要商品编号与验证码');
      return;
    }
...
      if (batch === 'bind') {
        await bridge.call('tag.batchBindWithCaptcha', {
          tagIds,
          productId: Number(productId),
          captchaId: captcha.captchaId,
          captchaCode: captcha.code.trim(),
        });
      } else {
        await bridge.call('tag.batchUnbind', { tagIds });
      }
```

**旧 React 版的错：**
1. **`tag.list` 传 `size`，后端读 `pageSize`** —— 见 §15 坑 EE；`page * PAGE_SIZE` 的分页推算因此全错（`:93` `hasMore = total !== undefined ? page * PAGE_SIZE < total : ...`）。
2. **`tag.batchUnbind` 传 `{ tagIds }`** —— 正是坑 AA：信封 `payload.data` 是对象，后端要裸数组。
3. 「验证码缺失就退回旧接口」这一族行为**不在 React 里**（React 是"缺验证码就本地拦下、根本不发请求"，`:122-125`），但在**旧 Android 版里有**，见下。

> **给 Vue 移植者的对照**：现在的 `TagListView.vue:135-142` 与 React `:130-137` 逐字同构（含 1 和 2 两个错），`TagListView.vue:51` 也仍是 `size: PAGE_SIZE`。**Vue 版把旧版的错原样继承了下来。**

### 14.2 旧 Android 版（归档区，`.archive/wise-depot-android-refactor/`）

`README` 明确这是**唯一的归档对象**（`.archive/ARCHIVE.md:11-13`）：旧 Android APP，Kotlin + Retrofit，不是 React。

| 文件 | 用途 |
| --- | --- |
| `.archive/wise-depot-android-refactor/feature/inventory/src/main/java/com/huicang/wise/inventory/TagApiService.kt` | 标签 Retrofit 接口 |
| `.../inventory/InventoryApiService.kt` | 库存 Retrofit 接口 |
| `.../inventory/TagModels.kt` | 请求/响应模型 |
| `.../inventory/usecase/BindTagsToProductUseCase.kt` | 批量绑定用例 |

**旧 Android 版的已知的错（逐条带证据）：**

1. **缺验证码就静默退回"无验证码"接口 —— 验证码形同虚设。**
   `BindTagsToProductUseCase.kt:47-54`
   ```kotlin
   val result =
       if (captchaId != null && captchaCode.isNotBlank()) {
           repository.batchBindTagsWithCaptcha(
               BatchBindTagsRequestWithCaptcha(command.productId, tagIds, captchaId, captchaCode),
           )
       } else {
           repository.batchBindTags(BatchBindTagsRequest(command.productId, tagIds))
       }
   ```
   注释还把它写成"与登录一致的历史约定"（同文件 `:20-21`）。这正是服务端 `CaptchaApplicationService.java:54-55` 那段注释点名的同类缺陷：
   > 修复前登录等入口使用 `if (captchaId != null && captchaCode != null)` 判断，攻击者只要不传这两个字段即可完全跳过验证码校验。
   **新实现必须走 `tag.batchBindWithCaptcha` 并强制验证码，绝不能有"缺了就走另一条"的兜底。**

2. **`size` 当 `pageSize` 用。**  `TagApiService.kt:107-112`
   ```kotlin
   @GET("api/tag")
   suspend fun getTags(
       @Query("page") page: Int? = null,
       @Query("size") size: Int? = null,
       @Query("search") search: String? = null,
   ): Response<BaseResponse<TagPageResponse>>
   ```
   后端读的是 `pageSize`（`TagController.java:112`），`size` 被忽略 → 永远 10 条/页。（`InventoryApiService.kt:46-52` 反而写对了 `@Query("pageSize")`。）

3. **两个不存在的端点。**  `TagApiService.kt:83-97` 声明了
   ```kotlin
   @GET("api/tag/nfc/{nfcUid}")   ...
   @GET("api/tag/barcode/{barcode}") ...
   ```
   而 `TagController` 里**没有** `/nfc/**` 也没有 `/barcode/**`，只有一个 `@GetMapping("/code/{tagCode}")`（`TagController.java:88`，且内部只按 `barcode` 查，`:202-206` `findByBarcode`）。→ 必 404（`RES-REQUEST-1001`）。契约里对应的正确方法是 `tag.byCode` → `/api/tag/code/{tagCode}`（`bridgeContract.ts:185`）。

4. **批量绑定/带验证码绑定的响应类型写错。**  `TagApiService.kt:37-51` 都声明成 `Response<BaseResponse<List<TagInfo>>>`，真后端返回的是 `BatchBindResult` 对象（`TagController.java:155` / `:166`）。模型对不上，`totalCount/successCount/failedCount` 一个都读不到（旧 UI 因此在批量绑定后只能"刷新列表"糊过去）。

5. **`tagId` 混进更新 body、`status` 写成 `String`。**  `TagModels.kt:202-232`
   ```kotlin
   data class UpdateTagRequest(
       @SerializedName("tagId") val tagId: Long,
       @SerializedName("productId") val productId: Long?,
       ...
       @SerializedName("status") val status: String?,
   )
   ```
   后端 `ProductTagUpdateRequest` 没有 `tagId` 字段（多了就被 Jackson 静默忽略，无害），但 `status` 是 `Short`（`ProductTagUpdateRequest.java:14`）。Jackson 默认允许"数字字符串→Short"的强制转换，所以**未必报错**，但这个类型声明本身就是错的信号 —— 不要照抄。

6. **`productId` 被当成必填。**  `TagModels.kt:122-127` `CreateTagRequest.productId: Long`（非空），而后端 `productId` 可选（`TagApplicationService.java:73-77`）。旧版因此无法创建"暂不绑定商品"的待入库标签。

7. **旧 Android 版没有实现** `tag.bind` / `tag.unbind` / `tag.batchUnbind` / `tag.batchQuery` / `inventory.create` / `inventory.update` / `inventory.delete` / `tag.delete`（`TagApiService.kt:120-123` 只有 `deleteTag`；`InventoryApiService.kt` 有 `createInventory` / `updateInventory` / `deleteInventory` 的声明，但我没去核实调用点）。**这些方法在两端旧客户端里都没有可直接照抄的正确写法**，只能以本简报的真后端语义为准。

---

## 15. 实现者必须避开的坑

（按"照名字接就会做错"排序；前 4 条是本批方法**独有**的，后几条是跨方法/跨屏的共性坑。）

1. **`inventory.create` 的 `warehouseId` 是死参数** —— 后端 `InventoryApplicationService.java:254-258` 从不 `setWarehouseId`，而 DB 该列 `NOT NULL`（`tools/sql/wise_depot.sql:268`）→ 传了也 500。别在界面上把它做成"选填"。
2. **`tag.bind` 的 `productId` 在 query string，不在 body** —— `TagController.java:139` `@RequestParam("productId")`，契约 `paramStyle: 'query'`；按 body 传必得 400「缺少必需的请求参数: productId」。
3. **`tag.batchUnbind` / `tag.batchQuery` 要的是裸 JSON 数组，桥发的是对象** —— `TagController.java:177`/`:201` 是 `List<Long>` / `List<String>`，而 `Envelope.kt:40` 只接受 `JsonObject`、`BridgeDispatcher.kt:79` 只传 `JsonObject` → `{"tagIds":[...]}` 必然 `VAL-REQUEST-1001`（400）。**落地前先用真后端验证这条。**
4. **`tag.batchBind` 不需要验证码，它是 `tag.batchBindWithCaptcha` 的绕过通道** —— 任何"缺验证码就退回 `tag.batchBind`"的兜底都等于没做验证码（旧 Android 版就是这么错的，见 §14.2 第 1 条）。
5. **`tag.update` 的字符串字段：空白串 = 清空**（`TagApplicationService.java:137` `isBlank() ? null : ...`），不是"保留原值"。界面若把输入框 `trim()` 后原样提交，用户删空条码就真的清了库。**与 `product.update` 的 `isBlank`=保留相反，与 `warehouse.update` 的 `!= null` 就写同族。**
6. **`tag.update` 的 `productId = null` 是"保留"，`barcode = null` 也是"保留"** —— 想解绑只能用 `tag.unbind`/`tag.batchUnbind`，想清条码只能传空串。两种"清空"手法不一样。
7. **`inventory.update` 的数字字段没有"空白串"语义，传 `""` 直接 400**（`VAL-REQUEST-1001`）；`quantity: 0` 是**真的把库存改成 0**，不是"没传"。
8. **`tag.bind` / `tag.batchBind` 会强行把 `status` 覆写成 1**（`TagRepository.java:192`/`:204`），`tag.unbind` / `tag.batchUnbind` 会打回 0（`:171`/`:181`）。已出库（2）状态不可逆地丢失。
9. **`tag.create` 带 `productId` 建出来的标签 `status` 仍是 0**（`TagApplicationService.java:80-95`）→ "有商品但显示未绑定"。要"已绑定"必须再调一次 `tag.bind`，或显式传 `status: 1`。
10. **`tag.update` 能单独改 `status` 或单独改 `productId`，两者会失配** —— 没有联动校验，可以造出"未绑定但已入库"或"已绑定但未入库"的标签。
11. **`tag.delete` / `inventory.delete` 成功时 `payload.data` 是 `null`**（`TagController.java:73`、`InventoryController.java:199` 的 `success(null)`），不是 `{}`。别拿"拿到对象"当成功判据。
12. **删标签可能 500** —— `product_tag.tag_id` 被 `inspection_detail`（`tools/sql/wise_depot.sql:174`）和 `stock_order_item`（`:577`）外键引用，`deleteTag` 只查存在性（`TagApplicationService.java:172`），撞外键就是 `SYS-0001`。
13. **`tag.unbind` / `tag.batchUnbind` 依赖 `product_tag.product_id` 可空** —— 而 `tools/sql/wise_depot.sql:426` 写的是 `NOT NULL`，`tools/sql/fix_product_tag_nullable.sql` 又只改了三个标识列。线上若按该 DDL 建库，这两条接口直接 500。
14. **批量绑定的 `failedCount` 不告诉你哪几个失败** —— 不存在的 tagId 静默计入（`TagApplicationService.java:354-360`），全程没有逐个 `existsById`。
15. **`totalCount` 是入参长度（含重复 id），`successCount` 是 SQL 影响行数** —— 重复 id 会让三个数字互相矛盾（`TagApplicationService.java:358-360`）。
16. **`tag.batchQuery` 只按 `barcode` 匹配** —— `TagRepository.java:161` `WHERE t.barcode IN :barcodes`。传 nfcUid / rfid 静默查不到；而 `tag.create` 允许只登记 RFID/NFC，两个接口口径互相打架。
17. **`tag.batchQuery` 是唯一没有空列表守卫的批量接口** —— `[]` 返回空数组，其余批量接口 `[]` 都是 `VAL-0001`。
18. **所有 tag 写操作都不失效 tag 缓存** —— `getTag` 带 `@Cacheable(prefix="tag", timeout=1800)`（`TagApplicationService.java:185-186`），`updateTag`/`deleteTag`/`bindTag`/`unbindTag` 上**没有** `@CacheEvict` → 改/删后 `tag.detail` 最长 30 分钟返回旧值。
19. **`ProductTagDTO.productCode` 永远是 `null`** —— `toProductTagDTO` 只 set `productName`（`TagApplicationService.java:450-455`），`ProductTagDTO.java:34` 的 `productCode` 从没被赋值。列表页要商品编码得另取 `product.list`。
20. **`InventoryDTO` 有一半字段永远是 `null`** —— `toInventoryDTO` 不 set `lockedQuantity` / `updateTime` / `lastCheckTime` / `productType` / `productUnit`（`InventoryApplicationService.java:575-605`）。"锁定库存""最后更新"这类显示做不出来。
21. **业务错误是 HTTP 200**（`GlobalExceptionHandler.java:62-63`）—— 只看 `response.ok` 会把「条形码已存在」「标签不存在」都当成功。桥是看 `payload.code === "RES-0000"`（`OkHttpBackend.kt:109`），实现者不要绕开桥自己判。
22. **`tag.create` / `tag.update` / `tag.batchBind*` 的 `@Valid` 全是空转** —— DTO 上一个校验注解都没有（`ProductTagCreateRequest.java`、`ProductTagUpdateRequest.java`、`ProductTagBatchBindRequestWithCaptcha.java`），所有校验都在服务层。
23. **`status` 没有任何取值范围校验** —— `tag.create` / `tag.update` 都直接写（`TagApplicationService.java:95`/`:128`）。`ProductTag.java:35` 的 `0/1/2` 只是注释，不是约束。
24. **坑 EE（跨屏，本批方法之外）**：`tag.list` / `inventory.list` 后端读的是 **`pageSize`**（`TagController.java:112`、`InventoryController.java:149`），而 `TagListView.vue:51` / `InventoryListView.vue:57` / `ProductListView.vue:50` / `WarehouseListView.vue:48` 全都在传 **`size`** → 被静默忽略，永远 10 条/页。React 版（`TagListScreen.tsx:81`）与旧 Android（`TagApiService.kt:110`）同样错。这不是本批 12 条方法的问题，但同一批屏一定会撞上。

---

## 16. 仍不确定的事实（不猜，如实列出）

1. **`tag.batchUnbind` / `tag.batchQuery` 是否真的 400，我没有实机验证。**
   结论来自三处源码的交叉推断：`Envelope.kt:40`（`data: JsonObject`）、`BridgeDispatcher.kt:79`（`params as? JsonObject`）、`TagController.java:177`/`:201`（`List<Long>` / `List<String>`）与 `GlobalRequestAdvice.java:92-99`（原样把 `payload.data` 交给 Jackson）。**没有任何测试或文档记录过这条路径跑通**；`mock-domains.ts:738-750` 的 `tag.batchUnbind` 假实现返回 `{}`，与真后端形状也不一致，不能当证据。请先打一发真请求确认，再决定是改契约（比如给这两条加一个新的 body 形状）还是在桥侧特判。

2. **线上 `product_tag.product_id` 到底是 `NOT NULL` 还是可空，两份 schema 自相矛盾。**
   `tools/sql/wise_depot.sql:426` 为 `NOT NULL`；`tools/p205-schema-snapshot.sql:265` 为可空（Hibernate 从 `ProductTag` 实体生成，实体上确实没有 `@NotNull`，`ProductTag.java:21`）。补丁脚本 `tools/sql/fix_product_tag_nullable.sql` 证明了"曾因 NOT NULL 出过事"，但它**没动 `product_id`**。这直接决定 `tag.unbind` / `tag.batchUnbind` 是能用还是必 500。**我没连数据库，无法判定。**

3. **`unbindProduct` 的 `updated == 0` 分支可不可达，取决于 JDBC 参数。**
   `TagApplicationService.java:320-323` 用返回行数判失败。MySQL Connector/J 默认 `useAffectedRows=false`（返回匹配行数）时，"解绑一个本来就没绑定的标签"仍返回 1；若 URL 显式开了 `useAffectedRows=true`，则返回 0 → 抛 `VAL-0001`「解绑失败」。**我没找到本仓的 JDBC URL / `application*.yml` 配置来确认。** 建议实现者把"重复解绑"当成"可能成功也可能报错"，别据此判定业务状态。

4. **`tag.batchQuery` 传 `[null]` 或 `[]` 的实际行为未确认。**
   `TagApplicationService.java:433-435` 对 `barcodes` 没有空/null 守卫；JPA 把 `IN ()` 翻译成什么、`[null]` 是否抛异常，取决于 Hibernate 版本与方言。我**没有跑**，只能确认"源码里没有守卫"。

5. **`wise.captcha.required` 在部署环境里实际是 true 还是 false，我查不到。**
   默认值走 `${wise.captcha.required:true}`（`CaptchaApplicationService.java:44`），但我没有找到任何 `application.yml` / 环境变量覆盖的证据（本次未展开搜索 `WiseDeoptServer` 的配置文件）。若是 `false`，§10 与 §11 完全等价、验证码整条链路失效。

6. **`product_tag.create_by` 硬编码的 `1L` 是否真的对应一个存在的 `user_core.user_id`，我没查。**
   `TagApplicationService.java:96` 写死 1；`tools/sql/wise_depot.sql:443` 有外键 `product_tag_ibfk_2 ... REFERENCES user_core (user_id)`。若 1 号用户不存在，`tag.create` 必 500。我没读种子数据。

7. **旧 Android 版 `InventoryApiService` 的 `createInventory` / `updateInventory` / `deleteInventory` 有没有真实调用点，我没核实。**
   我只读了接口声明（`.archive/.../InventoryApiService.kt:25-44`），没去 grep 调用方；因此不能断言"旧版库存 CRUD 有已知的错"。

8. **旧 React 版对 `inventory.create` / `inventory.update` / `inventory.delete` / `tag.create` / `tag.update` / `tag.delete` / `tag.bind` / `tag.unbind` / `tag.batchBind` / `tag.batchQuery` 的调用情况，我是在 `v0-react-freeze` 的 `packages/features/src/inventory/*.tsx` 三个文件里 grep 出来的。**
   方法：对 `InventoryListScreen.tsx` / `InventoryDetailScreen.tsx` / `WarehouseListScreen.tsx` 搜 `inventory\.(create|update|delete)` 等模式，全为 0 命中。**如果还有别的屏（比如 `stockOrderState.ts`、或其他域的组件）也调用过这些方法，我的断言就不完整** —— 我没有遍历该 tag 下的全部 `.tsx`。
