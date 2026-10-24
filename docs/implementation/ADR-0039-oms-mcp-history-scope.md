# ADR-0039：OMS 读接口与 MCP 单据历史工具按组织范围收口

日期：2026-10-23。收口 ADR-0034「边界」留下的两项：OMS 的**读**接口，以及 MCP 通用单据读工具里带流转留痕的 `doc.get`（Y4 审计遗留 ①、②）。状态：开发实现，尚非产品上线验收。

## 决定

### OMS 读接口

- **判据**：沿用 ADR-0034 的「平台绑定组织 = 平台履约仓 `platforms.warehouse_id` 所属组织 `warehouses.org_id`」。判据仍只在 `server/lib/sales-order.js` 一处：
  - `omsPlatformScopeSql(orgScope, alias)`：作用在 `platforms` 行；
  - `omsOrderScopeSql(orgScope, alias)`：作用在 `oms_orders` 行（经 `platform_id IN (范围内平台)`）。
  - 全局范围不加过滤；空 / `dealer` / `none` 范围 ⇒ `1=0`（空范围不会变成全库）；没有履约仓或履约仓没有组织的平台，其订单 / 日志对受限范围不可见、对全局范围可见（与 ADR-0034 的「未绑定」同口径）。
- **接入的读路由**（均加 `attachOrgScope`，外部角色仍被路由器级 `requireInternal` 以 403 拦在前面，行为不变）：
  - `GET /orders`：范围谓词作为第一个条件，`platform_id` 等过滤参数只能进一步收窄；`total`、`summary` 与列表同一 WHERE。
  - `GET /orders/:id`：范围外与不存在**同形**（同一句 404），不泄漏线上单存在性。
  - `GET /platforms`、`GET /sync-logs`、`GET /stats`（byPlatform / trend / total / topSkus 全部带范围）、`GET /qimen-message/:orderId`（含收件人信息，范围外 404）、`GET /qimen-stock-message/:platformId`（范围外 404）。
- OMS 写路由（发货回传 / 完成 / 退款 / 库存推送）不在本 ADR 内，见边界。

### MCP 单据历史工具

- 带流转留痕的读工具只有 `doc.get`（`doc_events` 仅在此读取）。它此前的范围判据是 `entityRowVisible`：按表上是否有 `org_id / store_id / dealer_id / warehouse_id` 列**推断**归属，且 `dealer_id` 命中即可见——持有某经销商范围的令牌能读到「经销商属本组织、出货仓与门店却属他组织」的销售订单及其留痕，而 HTTP 的 `salesScopeSql` 对同一张单判不可见。
- 改为 `docflow.docInScope({ db, user, orgScope: ctx.scope }, type.code, row.id)`，即 `DOC_SCOPE_RESOLVERS`（ADR-0032）——与 `/api/docflow/history` **同一份**判据：
  - `ctx.scope` 即令牌范围 ∩ 所有者**当前**范围（ADR-0011 `effectiveScope`）；
  - `store` 型解析器需要账号的 `store_id`，取自令牌所有者行（无主令牌为 null）；
  - 无组织归属的全局类型（AR / RCP / VOUCHER / RFD / CA / OM）与未登记类型对受限范围不可见（404，与不存在同形）；
  - Y6 的门店 / 经销商 / 订货主体绑定（`rowInBinding`）仍叠加，缺绑定仍是类型级 `TOKEN_OWNER_BINDING_REQUIRED`；
  - 留痕只在单据通过范围判定后才读。
- 范围外一律 `NOT_FOUND` 404（不报 403，避免确认「存在但不是你的」）。

## 契约变化

OpenAPI 1.36.0 → 1.37.0（`src/types/api-routes.ts` 重新生成）：OMS 平台 / 订单列表 / 详情 / 同步日志 / 统计 summary 写明范围口径，订单详情新增 404。受限账号读他组织平台的线上订单、日志、统计由 200 变为过滤或 404；全局范围与外部角色行为不变。MCP `doc.get` 对 SO / 报价 / 订货等类型：此前 `dealer_id` 推断可见的他组织单据现在 404；全局类型对受限令牌 404（此前凡有归属列的全局类型表也按列推断）。

## 守卫与矩阵

- `scripts/check-route-authz.mjs`：OMS 读路由链原本即为 `requireAuth` + 路由器级 `requireInternal`，分类不变；无新增 gap / pending。
- `tests/mcp-tool-matrix.test.mjs` 新增「状态 5（Z2）」：所有者数据范围为本组织，`doc.get` 读「经销商属本组织但仓属他组织」的 SO（NOT_FOUND、无留痕、零写）、本组织仓的 SO（放行并含留痕）、全局类型 OM（NOT_FOUND），写入 `history_scope_state` 并断言无 `LEAK`；原三态与 Y6 绑定态不变。该新状态在旧实现下为红（已用 `git checkout` 旧 `tools.js` 复核）。
- `tests/oms-scope.test.mjs`：OMS 各读路由精确集合（A / B / 父组织 subtree / 无组织 / 全局，含未绑定平台）、范围外与不存在响应体逐字相同、统计对 SQL 直算、外部角色 403；`doc.get` 三类单据的精确行为。

## 边界（诚实写明）

- **`doc.query`（同一文件的列表工具）与 `doc.list_types` 不在本工作流范围**：`doc.query` 仍用 `entityRowVisible` 的列推断，其「经销商推断放大」与 ADR-0034 遗留 ① 同形，应在后续工作流中同样改为 `docScopeOf` 下推 SQL（需处理 limit×3 取回再滤的行为）。`order.trace_document` 同理仍用推断（它返回单据与库存流水，不含 `doc_events`）。
- OMS 写路由（`ship` / `complete` / `refund` / `stock-push`）仍只有 `requireInternal` + 角色，未接范围判据；`oms_orders` 没有 `org_id` 列，归属靠 `platform → warehouse → org` 推出。
- `/stats` 的 `trend` / `total` 对每个请求做 `platform_id IN (子查询)`，大库下的性能未做 EXPLAIN 评估（未核对 `oms_orders.platform_id` 上的索引）。
- 平台绑定组织是推导而非独立配置（同 ADR-0034）。
- MCP 在生产被 `agent_access` 门禁 503；Mac mini Node 22 本地验证，不等于目标平台验收。

## 验证入口

`node --test tests/oms-scope.test.mjs tests/mcp-tool-matrix.test.mjs`；同时 `tests/quote-scope.test.mjs`、`tests/docflow-scope.test.mjs`、`tests/mcp-doc-perms.test.mjs` 保持绿。
