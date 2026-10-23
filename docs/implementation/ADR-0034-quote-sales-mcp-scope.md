# ADR-0034：报价、MCP 销售工具与 OMS 入口按组织范围收口

日期：2026-10-23。收口 ADR-0026「边界」里明确留下的三个入口：`/api/sales/quotes*`（报价）、MCP `sales.*` 工具、OMS 模拟同步 / 转单。此前它们各自用旧口径或根本没有范围：报价读写全库；MCP `sales.list_orders` 用另一套「门店 / 经销商 / 仓」映射；OMS 同步与转单把订单落到「任意电商仓 / 第一个仓」。状态：开发实现，尚非产品上线验收。

## 决定

- **一处判据，仍在 `server/lib/sales-order.js`**，不在新文件里再抄一份：
  - 订单类沿用 ADR-0026 的 `salesScopeSql` / `assertSalesDocInScope` / `assertSalesTargetInScope`，不改。
  - 新增 `quoteScopeSql(orgScope, alias)`、`assertQuoteInScope(db, id, orgScope)`、`assertQuoteTargetInScope(db, { warehouseId, storeId, customerId }, orgScope)`。
- **报价归属**（`sales_quotes` 没有 `org_id` 列）：出货仓 `warehouses.org_id`、门店 `stores.org_id`（与订单同一谓词，直接复用 `salesScopeSql`）+ 订货客户 `oc_customers.org_id`（下游客户继承上级，同 ADR-0027 `ocScope`）。经销商不参与（与 ADR-0026 同理：客户而非本方组织）。
  - **读**（列表、总数、概览计数 / 即将到期 / 待审批 / 已转单金额、详情）：任一参与方在范围内即可见；全部参与方为 NULL 的报价对受限范围不可见、对全局范围可见。空范围 / `dealer` / `none` / 缺 `req.orgScope` ⇒ `1=0`。
  - **详情与动作**（提交 / 审批 / 驳回 / 取消 / 复制 / 转单 / 作为改版来源）：范围外与不存在**同形**（同一句 404），早于状态校验，零写。
  - **写目标**（建单、复制、转单，因为会产生新单据，比读严）：给出的仓 / 门店 / 订货客户必须**都**在范围内（403，零写），且受限范围下**至少给出一个**——不许建出受限范围永远看不到的无主报价；`POST /quotes/price` 试算会回显指定仓的可供量，所以给了目标就同样校验（不强制必须给）。转单对已转过单的幂等返回也先判目标，且返回的订单须在**当前**范围内（订单仓 / 门店转单后被改走则按 404，不泄漏单号）。转成销售订单（`target=SO`，默认）时订单归属只来自仓与（门店类客户的）门店——订货客户不会写进销售订单——所以受限范围下 SO 目标必须由仓 / 门店落进范围，只有订货客户的报价转 SO 得 403（不造无主订单）；转订货单（`target=OC`）归订货客户，只判客户。
  - `POST /quotes/expire`（批量过期）只处理调用者范围内的报价。
  - 路由链统一 `requireAuth + attachOrgScope`；`lib/quote.js` 各函数新增可选 `orgScope`：`undefined` = 不加范围（系统内部调用），路由必须显式传（缺失按 none，fail-closed）。
- **MCP `sales.*`**：
  - `sales.list_orders` 改用 `salesScopeSql(ctx.scope, 'order', 'so')`，与 `GET /api/sales/orders` 是**同一个判据**（此前 MCP 用 `entityScopeClause` 的「门店 / 经销商 / 仓」映射，两个入口看到的订单集合不一致，且经销商归属会让别家订单变得可见）。`ctx.scope` 即令牌范围 ∩ 所有者**当前**范围（ADR-0011 `effectiveScope`）。
  - `sales.cancel_order` 把 `ctx.scope` 作为 `orgScope` 传给领域服务 `cancelOrder`，由它调用 `assertSalesDocInScope`，范围外 / 不存在同为 `ORDER_NOT_FOUND` 404，早于状态校验、零写（X5 的行为不变，只是判据换成共用的一处）。`orgScope` 在 `cancelOrder` 是**可选**：HTTP 路由仍在调用前判范围（ADR-0026 的做法不动），不会重复判。
  - `sales.*` 目前只有这两个工具；没有 MCP 建单写工具，所以「写入校验」落在 cancel 上。以后新增的 `sales.*` 写工具必须经 `assertSalesTargetInScope`，矩阵测试的 `scope_excluded` 状态会逼它登记。
- **OMS 入口**（`/api/oms/sync/:platformId`、`/orders/:id/convert`、`/orders/convert-batch`；`sync` 在生产被 `capabilities` 门禁 503，仅 test / demo 可用）：`platforms` 没有组织列，**平台绑定组织 = 其履约仓 `platforms.warehouse_id` 所属组织 `warehouses.org_id`**。
  - 平台没有履约仓、或履约仓没有组织 ⇒ **422 `PLATFORM_ORG_UNBOUND`，零写**（同步不再造出无归属的线上单；转单不再回落到「任意电商仓 / 第一个仓」）。
  - 调用者范围必须包含该履约仓 / 组织：同步 ⇒ 403；转单 ⇒ 404（与线上单不存在同形，且早于「已转单」之类状态提示）；批量转单逐单同样判，失败原因进 `failed`。
  - 销售订单的 `warehouse_id` 固定为平台绑定的履约仓，因此经 ADR-0026 的 `salesScopeSql` 即归属平台绑定组织。

## 契约变化

OpenAPI 1.35.0 → 1.36.0（`src/types/api-routes.ts` 重新生成）：报价各接口 summary 写明范围口径，新增 403 / 404；OMS 同步 / 转单 / 批量转单写明 `PLATFORM_ORG_UNBOUND` 422、403、404。内部受限账号读 / 写他组织报价由 200 变 404；`PLATFORM_ORG_UNBOUND` 对未绑定平台是新增的拒绝；全局范围账号对已绑定平台行为不变。

## 守卫与矩阵

- `scripts/check-route-authz.mjs`：`quote.js` 的 `POST /quotes/:id/action` handler-scope 登记改写，写明 ADR-0034 范围链与判据位置；没有新增 gap / pending 条目，`unassigned` 待办数不变（5）。
- `tests/mcp-tool-matrix.test.mjs`：`sales.cancel_order` / `sales.list_orders` 的三种所有者状态期望不变（`scope_excluded` 仍是拒绝 / 空集），但判据现在是共用的 `salesScopeSql`；矩阵断言通过即证明新口径不比旧口径松。

## 边界（诚实写明）

- **Codex 审计（静态，只读）遗留，不在本工作流文件范围内**：① 通用 MCP 工具 `doc.get` / `doc.query`（`server/mcp/tools.js` 的 doc 工具）仍按推断归属（含 `dealer_id`）判可见，持有该经销商范围的令牌可读到仅归他组织仓 / 门店的 SO / 报价——属于 doc 工具，由 Y6（MCP 文档读门禁）收口，Y4 只动 `sales.*`；② OMS 读接口（`/orders`、`/orders/:id`）见下一条。MCP 在生产被 `agent_access` 门禁 503。

- OMS 的**读**接口（`/orders`、`/orders/:id`、同步日志）与发货回传 / 退款 / 库存推送不在本 ADR 内，仍只有 `requireInternal` + 角色；`oms_orders` 没有 `org_id` 列，归属靠 `platform → warehouse → org` 推出，没有为此加列。
- 受限账号建「只有经销商、没有仓 / 门店 / 订货客户」的报价会 403，需显式选仓（与 ADR-0026 的 `POST /orders` 同一处理）。已存在的无主报价对受限范围不可见，真实数据应补全仓 / 门店 / 客户。
- 订货客户转订货单（`target=OC`）走 `createOrder`，由订货中心按客户选仓；本 ADR 只保证该客户在调用者范围内（ADR-0027 的订货单读写范围不变）。
- 平台绑定组织是「履约仓所属组织」的推导，不是独立配置；若要平台与履约仓分属不同组织，应另立 ADR 并给 `platforms` 加 `org_id` 列。
- 其他调用 `lib/quote.js` 的内部入口（如有）不传 `orgScope` 即不加范围，由调用方自己负责。

## 验证入口

`node --test tests/quote-scope.test.mjs`：报价列表精确集合（A / B / 门店 / 父组织 subtree / 无组织 / 全局）、概览计数对 SQL 直算、详情范围外与不存在同形、范围外动作 / 复制 / 转单 404 且零写、建单越界 403 / 无主 403 / 范围内 200、试算越界 403、转单混合参与方 403、批量过期只动范围内；MCP 两个工具的精确集合与 HTTP 一致、空范围不放大、范围外 cancel 404 且零写；OMS 同步 / 转单 / 批量转单的绑定与范围。同时 `node --test tests/sales-scope.test.mjs tests/mcp-tool-matrix.test.mjs` 保持绿。Mac mini Node 22 本地验证，不等于目标平台验收。
