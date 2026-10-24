# ADR-0042：OMS 写路由与 MCP 库存工具按组织范围收口

日期：2026-10-23。收口 ADR-0039「边界」留下的 OMS 写路由（发货回传 / 完成 / 退款 / 库存推送），以及 ADR-0038「边界」留下的 MCP 库存工具（Y4 / Z1 审计遗留）。状态：开发实现，尚非产品上线验收。

## 现状（修前）

- `POST /api/oms/orders/:id/ship|complete|refund` 与 `POST /api/oms/stock-push` 只有 `requireInternal` + 角色：持有销售 / 仓库角色的受限账号凭线上订单号即可对他组织平台的订单发货出库、完成、退款释放占用；库存推送对全部平台推送，且「可售库存」合计是全库口径。
- MCP 库存读工具（`inventory.query_stock` / `list_batches` / `list_transactions` / `stock_alert`）只按库存行的**货主** `owner_org_id` 过滤：货主是本组织、货却放在他组织仓 / 无组织仓里时，HTTP `/api/inventory/*` 对该账号不可见，MCP 却能读到。
- MCP 库存写工具与 `get_cost` / `pick_suggestion` 用本文件私有的 `assertWarehouseInScope`（仓库 `org_id` ∈ 令牌范围）。`org_id` 为 NULL 的仓库在 `assertOrgInScope(null)` 处被**放行**，与 ADR-0038「无组织仓对受限范围不可见」不一致。

## 决定

### OMS 写路由

1. **判据不新增**：沿用 ADR-0034 / 0039 的「平台绑定组织 = 平台履约仓所属组织」（`omsOrderScopeSql` / `omsPlatformScopeSql`，`server/lib/sales-order.js`），仓库侧用 ADR-0038 的 `assertWarehouseInScope` / `stockScopeSql`（`server/lib/stock.js`）。
2. `ship` / `complete` / `refund` 增 `attachOrgScope`，经 `loadOmsOrderForWrite`：先按 `omsOrderScopeSql` 取单，**范围外与不存在同形**（同一句 404「线上订单不存在」，先于状态校验与任何写）；`ship` / `refund` 再检查关联销售订单的出货仓：平台在范围内、销售订单的仓却在他组织（或无组织）⇒ 403 `TARGET_OUT_OF_SCOPE`，仍先于任何写。`complete` 是纯状态推进，只判订单范围。
3. `stock-push`：`attachOrgScope`；只推范围内平台；请求指定的 `platform_id` 在范围外与不存在同形 404「平台不存在」；`total_available` 只累计范围内的仓（`stockScopeSql`），全局范围口径不变；受限范围下无可推平台仍是原 400「没有开启库存同步的平台」。
4. 生产环境对 OMS 的 503 能力闸门（`agent_access` / 能力开关）不变，本 ADR 不触碰；范围判定只发生在能力闸门之后。
5. `sync` / `convert` / `convert-batch` 已在 ADR-0034 收口，不变。

### MCP 库存工具

1. 读工具（`inventory.query_stock` / `list_batches` / `list_transactions` / `stock_alert`）把 `orgFilter`（货主）改为 `invFilter`：货主过滤 **叠加** `stockScopeSql(ctx.scope)`（仓库组织范围）。取交集是刻意的更严口径：不放宽 A03 的货主边界，同时与 HTTP 对「仓库组织」的判据一致。`list_batches` 的批次可见性（EXISTS 库存行）同样叠加仓库范围。
2. 写工具与 `get_cost` / `pick_suggestion`（均经私有 `assertWarehouseInScope`）在原有判定之后增加 `warehouseInScope(db, id, ctx.scope)`（ADR-0038 同一函数）：无组织仓、他组织仓对受限范围一律 `ORG_OUT_OF_SCOPE`（403）；不存在的仓仍是 `WAREHOUSE_NOT_FOUND`（404）。`inventory.transfer` / `ownership_transfer` 的两端各判一次。
3. `ctx.scope` 即令牌范围 ∩ 所有者**当前**范围（ADR-0011 `effectiveScope`），因此所有者缩范围 / 停用 / 失权对库存工具即时生效；写工具的幂等缓存回放已有 `scopeCovers` 重判（Z8），不变。
4. 空范围（`none` / 空集合）读为空、写 403；全局范围（`all`）行为不变，可达无组织仓。

## 契约变化

- OpenAPI 仅更新 `/api/oms/orders/{id}/ship|refund|complete` 与 `/api/oms/stock-push` 的说明并补 403 / 404 响应；**未递增 OpenAPI 版本号**（避免与同批并行工作流的版本号冲突，由集成时统一递增）。
- 受限账号：他组织平台的订单写入由 200 变为 404（销售订单仓越界为 403），库存推送只含本范围平台与仓。全局范围与外部角色（路由器级 `requireInternal` 403）不变。
- MCP：受限令牌读到「货主命中但仓库在范围外 / 无组织」的库存 / 流水 / 批次 / 预警行的情形消失；对无组织仓的写 / `get_cost` / `pick_suggestion` 由放行变为 `ORG_OUT_OF_SCOPE`。

## 守卫与矩阵

- `scripts/check-route-authz.mjs`：路由集合与权限链未变（只在链中插入 `attachOrgScope`），无新增 gap / pending。
- `tests/mcp-tool-matrix.test.mjs` 新增「状态 6（AA2）」：所有者范围 = 仓库 A 所在组织（非空），夹具含他组织仓与无组织仓里货主为本组织的库存；四个读工具不得出现外仓批次；`get_cost` / `pick_suggestion` / `stock_in` / `stock_out` / `adjust` / `transfer`（两个方向）/ `ownership_transfer` 对他组织仓与无组织仓必须 `ORG_OUT_OF_SCOPE` 且业务表零写。原三态（停用 / 失权 / 范围排除）与 Z2 / Y6 / Z8 各态不变。该状态在旧 `tools.js` 下为红（已复核）。
- `tests/oms-scope.test.mjs` 增 OMS 写路由用例：范围外与不存在逐字同形 404 且不改状态、不写同步日志；销售订单仓越界 403 且零写；范围内与全局放行；库存推送平台集合、范围外平台 404、库存合计按范围。`tests/inventory-scope.test.mjs` 增 MCP 库存工具用例（读 / 写 / 无组织仓 / 全局 / 空范围）。

## 边界（诚实写明）

- 本批只改库存 / 库存推送工具。`master.get_product_360`（各仓库存分布与近期流水）、`report.dashboard_kpi`（库存金额）、`order.trace_document`（按单号附带流水）仍只按货主 / 归属推断过滤，未叠加仓库组织范围；前两者留待后续批次，`order.trace_document` 属 AA1。
- MCP 读工具取「货主 ∩ 仓库组织」，比 HTTP（仅仓库组织）更严：货主是他组织、货放在本组织仓里的行，HTTP 可见而 MCP 不可见（沿用 A03 的货主边界，未放宽）。
- 库存推送的「可售库存」仍是账户范围内全部仓的合计，而不是平台履约仓的库存（修前口径亦如此），只是不再包含范围外的仓。
- `stock_alert.below_safe` 仍是货主 + 仓库范围下的跨仓合计；低库存口径统一属 AA5。
- 平台绑定组织是推导而非独立配置（同 ADR-0034）。MCP 在生产被 `agent_access` 门禁 503；Mac mini Node 22 本地验证，不等于目标平台验收。

## 验证入口

`node --test --test-concurrency=1 tests/oms-scope.test.mjs tests/inventory-scope.test.mjs tests/mcp-tool-matrix.test.mjs`；同时 `tests/mcp-doc-perms.test.mjs`、`tests/quote-scope.test.mjs` 保持绿；遗留脚本 `node scripts/check-mcp-coverage.mjs cosmetic`、`node scripts/test-mcp.mjs`、`node scripts/test-stock-v2.mjs cosmetic`。
