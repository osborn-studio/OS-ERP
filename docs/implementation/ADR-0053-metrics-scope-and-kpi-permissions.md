# ADR-0053：指标接口按范围收口，`report.dashboard_kpi` 与 dealer summary 补功能权限（AD1）

日期：2026-10-24。收口 ADR-0050（AC1）Codex 审计留下的两条 open 项（roadmap-v9 AD1）。状态：开发实现，尚非产品上线验收。

## 问题

- `GET /api/metrics`、`/api/metrics/values`、`/api/metrics/catalog` 对受限角色（仓管 / 门店 / 经销商默认持有 `system:metrics:view`）返回全局 `stock_qty`、`purchase_amount*` 等；指标 `compute(db, p)` 没有范围形参。
- MCP `report.dashboard_kpi` 为 `perms: []`，所有者没有采购 / 库存 / 销售查看权限也能取到对应子项。
- `POST /api/demand/dealer/summary` 不要求采购查看权限就返回在途采购量。

## 决定

- **指标函数接受 `orgScope`**：`compute(db, { days, orgScope })`；不传 = 全局（`dashboard-perf`、`scripts/test-metrics.mjs` 等内部调用口径逐字不变）。`metricValues` / `metricCatalog` / `metricGroups` 透传。
- **范围判据各只有一份**：库存类（`stock_qty`、`available_qty`、`stock_amount`、`turnover_days`〔分子与出库流水都收窄〕、`below_safe`〔`countBelowSafe(db, orgScope)`〕、`expiring_qty`）走 `stockScopeSql`；采购订单类（`purchase_amount`、`purchase_amount_effective`、`closed_order_ratio`）走 `purchaseOrderScopeSql`。这些条目带 `scopeAware: true`（不进 `metric_defs` 指纹，定义视图不变）。空 / `none` / `dealer` 范围读 0，不回落到全局。
- **没有范围语义的指标**（销售、线上 OMS、`payable_open`、订货中心、POS、经销商信用、审批）：值仍是全局口径，但响应带 `scoped: false`。`/values` 增加并列的 `scoped: { key: bool }` 映射（`values` 保持 `{key: number}`，旧调用方不受影响）；`/catalog` 与 `/` 的每个条目增加 `scoped`。全局调用者所有指标 `scoped: true`。前端 `Metrics.tsx` 在 `scoped === false` 时于数值旁标"全局口径"（列表与详情），仅此一处小改。
- **取舍（诚实写明）**：全局指标对受限角色**仍返回全局数字**，只是被显式标注——这是 roadmap-v9 AD1 的约定（"返回 `scoped: false` 并由前端标注"），不是 fail-closed。若要对受限角色直接隐藏这些值，需另行决定（见"仍 open"）。
- **`report.dashboard_kpi`**：仍 `perms: []`（工具级闸门不变，矩阵的 `PERM_FREE_READS` 约定不变），handler 内按所有者此刻权限逐子项取舍，缺权限的子项**省略**（不是 403）：`stock_value` / `stock_rows` 需 `inventory.stock.view`；`pending_shipment_orders` 需 `sales.order.view`；`purchase_in_transit` 需 `PO_READ_PERMS` 任一；`currency`、`sku_count`（SKU 主数据计数，无组织归属）恒返回。无主令牌没有所有者可对照，保持原行为（全返回）。范围过滤沿用 ADR-0050。
- **`/dealer/summary`**：在 `requireRole(...HQ)` 之外加 `requirePerm(...PO_READ_PERMS)`（与采购订单读路由同一常量）；其余 ADR-0050 行为不变。

## 契约变化

- `/api/metrics`、`/values`、`/catalog`：受限账号的库存 / 采购类数值变为本范围内的数；新增 `scoped` 字段（附加；`npm run gen:api` 产物无变化）。
- MCP `report.dashboard_kpi`：对缺权限的所有者，响应少若干键。
- `POST /api/demand/dealer/summary`：缺 `PO_READ_PERMS` 的 HQ 角色由 200 变 403。

## 测试

先红后绿：`tests/inventory-scope.test.mjs` 的 AD1（5 个子测试：受限值等于范围内合计且全局不变；`scoped` 标记；空范围读 0；catalog 与字典一致；dealer summary 权限门）；`tests/mcp-tool-matrix.test.mjs` 的 AD1（经真实 `/mcp` 令牌，逐权限点撤销后子项被省略且不报错）。通用矩阵对 `report.dashboard_kpi` 的 `permission_removed` 格子仍为 `NO_PERM_POINT`（工具仍返回 ok，只是子项为空）。

## 仍 open / 边界

- 全局指标对受限角色仍返回全局数字（仅标注）；是否改为对受限角色隐藏或加 `requireGlobalData` 需要产品决定。
- 未做 EXPLAIN；受限范围下指标子查询多一层仓库子查询，大库成本未评估。
- `/metrics/stale`、`/defs` 只含定义，未改。
- 校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。
