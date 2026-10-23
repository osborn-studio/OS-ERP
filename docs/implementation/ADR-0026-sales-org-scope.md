# ADR-0026：销售域读写按内部账号组织范围收口

日期：2026-10-23。收口 ADR-0021 登记的 `sales.js` 缺口：`GET /orders`、`/orders/:id`、`/deliveries`、`/deliveries/:id`、`/returns`、`/stats` 的 `scopeFilter` / `assertCanRead` 只按经销商 / 门店绑定（`scopePairs`）过滤，`data_scope=org|subtree` 的内部账号可以读到其他组织的订单、发货单、退货单与统计；写路由（改单、确认、取消、发货、完成、回款、签收、退货）同样只看角色。状态：开发实现，尚非产品上线验收。

## 决定

- **一处判据**，在 `server/lib/sales-order.js`，与采购侧 `purchaseScopeSql` / `assertPurchaseDocInScope`（ADR-0017 / 0020）同一形状：
  - `salesScopeSql(orgScope, kind, alias)` → `{ sql, params, empty }`。不传或 `all` ⇒ `1=1`；`dealer` / `none` / 空集合 ⇒ `1=0`（空范围不许变成全库）。
  - `assertSalesDocInScope(db, kind, id, orgScope)`：取单并判范围，范围外与不存在同形（同一句 404，不泄漏存在性）。
  - `assertSalesTargetInScope(db, { warehouseId, storeId }, orgScope)`：写路径目标校验，不通过 ⇒ 403。
- **归属推导**（`sales_orders` 没有 `org_id` 列）：订单的参与方是出货仓 `warehouses.org_id` 与门店 `stores.org_id`，**任一在范围内即可见**；两者都为 NULL 对受限范围不可见、对全局范围可见。经销商是客户而不是本方组织，不参与。
  - 为什么用「任一」而不是「仓优先」：门店订单由门店仓出货，而演示数据里门店仓的组织（如 6）是门店组织（5）的子节点；`org` 范围的门店组织账号若只认仓会看不到自己门店的订单。反过来，某组织的仓替别家门店出货，该仓组织也要能看到自己发出去的货。
  - 发货单经所属订单（不看发货单自己的仓：发货单的仓可以与订单仓不同）。退货单有来源订单时经订单；无单退货用自己的 `warehouse_id` / `store_id`。
- **读**：订单 / 发货单 / 退货单列表（含 `total`）与 `/stats` 的全部查询块（渠道、趋势、商品榜、经销商榜、门店榜、待发货数、合计）用同一谓词，由路由内一个 `readScope` 把「主体绑定」与「组织范围」拼成同一段 SQL。详情 / 发货单详情取单后判范围，范围外 404。
- **写**：改单、确认、取消、发货、完成、回款、发货单签收、退货完成，取单后先判范围（范围外 404，早于状态校验，因此不泄漏「存在但状态不对」），再做业务。目标校验（403，且零写入）：建单的出货仓与门店、改草稿时的新仓、发货时的发货仓、建退货时的入库仓与门店；建退货有来源订单时来源订单范围外 404。写比读严：目标涉及的仓与门店必须**都**在范围内（NULL 不通过）。
- `cancelOrder` 是 HTTP / MCP 共用实现，范围判定放在 HTTP 路由、调用它之前，不往共用实现里掺调用者范围。
- **外部主体不变**：`dealer` / `store` 角色继续只走 `scopeFilter` / `assertCanRead`（403 文案不变），不叠加组织谓词；他们不能写（写路由需要 sales / warehouse / admin 角色）。
- 中间件：销售路由统一 `requireAuth + attachOrgScope`。`check-route-authz` 的 `sales.js` 登记由「缺口 / pending」改为 `handler-scope` 并写明两层范围，待办 `unassigned` 减 6。

## 契约变化

OpenAPI 1.34.0 → 1.35.0（`src/types/api-routes.ts` 重新生成）：上述接口 summary 写明范围口径，并新增 403（目标仓 / 门店不在范围内）与 404（组织范围外）响应。内部受限账号读 / 写他组织单据由 200 变 404；其余账号行为不变。

## 边界（诚实写明）

- `quote.js`（`/api/sales/quotes*`）与订货中心（ADR-0027 / X3）、MCP 的 `sales.*` 工具、OMS 同步入口不在本 ADR 内；`lib/returns.js` 只被读取，未改。
- `POST /orders` 未指定仓时仍取全库的默认总仓；受限账号若不填 `warehouse_id` 而默认仓不在其范围内会得到 403，需显式选仓。
- 经销商按钮级可见性、前端对 404 的提示未改。
- 门店订单「任一参与方可见」意味着跨组织出货时两边都可读；这是有意的，若需要单一归属应另立 ADR 并给订单加 `org_id` 列。

## 验证入口

`node --test tests/sales-scope.test.mjs`：admin / `data_scope=all` 全局视图含 NULL 归属；org A / org B / 门店组织 / 父组织 subtree 的订单、发货单、退货单精确集合；无组织账号全空且统计为零；列表 total 与 `/stats` 对 SQL 直算（JOIN 写法）；详情范围外与不存在同形；范围外写动作 404 且行状态不变；范围内写仍通过；目标仓 / 门店越界 403 且零写入；门店 / 经销商绑定账号视图不变。Mac mini Node 22 本地验证，不等于目标平台验收。
