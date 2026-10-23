# ADR-0038：库存域与采购订单状态/收货路由按组织范围收口

日期：2026-10-23。收口 ADR-0031「边界」登记的采购订单状态/收货缺口（Codex 复审 `purchase.js:214/236`，Y1 审计），以及 `routes/inventory.js` 全部库存读写仍只有「内部主体」闸门、不按仓库所属组织过滤的问题。状态：开发实现，尚非产品上线验收。

## 现状（修前）

- `POST /api/purchase/orders/:id/status|receive`：`requireRole` 后直接动作，持有权限的受限账号凭订单号即可推进别的组织的订单或对其收货入库。
- `/api/inventory/*`（库存、流水、台账、预警、统计、序列号、可用量、库龄、呆滞、ABC、调拨、盘点、组装）：`requireInternal` 之后返回全库；调整 / 调拨 / 盘点 / 组装可对任意仓写。

## 决定

1. **一处判据**：`server/lib/stock.js` 的 `stockScopeSql(orgScope, alias, column='warehouse_id')`，键为 `warehouses.org_id`。不传或 `all` ⇒ `1=1`；`dealer` / `none` / 空集合 ⇒ `1=0`；仓库 `org_id` 为 NULL 对受限范围不可见。同文件还有 `warehouseInScope` / `assertWarehouseInScope`（写目标，403 `TARGET_OUT_OF_SCOPE`）/ `assertStockDocInScope`（按仓取单，范围外与不存在同形 404）。`lib/transfer.js` 增 `transferScopeSql` / `assertTransferTargetsInScope` / `assertTransferInScope`。lib 的出入库引擎函数不变，范围只在路由层落地（lib 内部与质检处置等调用口径不变）。
2. **库存读**：`router.use` 增 `attachOrgScope`；`/stocks`、`/transactions`、`/ledger`、`/availability`、`/aging`、`/sluggish`、`/stats`、`/serials`、`/alerts` 以仓范围过滤；`/stocks/by-sku`、`/abc`、`/alerts.belowSafe` 把谓词放在对 `inventory_stocks` 的 LEFT JOIN 的 ON 里，商品行保留、只汇总范围内的仓。序列号无仓（已出库离仓）对受限范围不可见，追溯同形 404。
3. **调拨**：读 —— 调出或调入任一端在范围内即可见（列表 / 详情）；写 —— 两端都必须在范围内：建单目标越界 403（先于建单）；既有单据一端越界时 ship / receive / submit / cancel 为 403 且不动；两端皆外与不存在同形 404。
4. **盘点 / 组装 / 调整**：新建与调整的目标仓越界 403（不存在的仓对受限范围同样 403，不泄漏存在性；全局范围保持原 400）；既有单据按其仓取单，范围外 404 且不写。
5. **采购订单**：`/orders/:id/status|receive` 在 `attachOrgScope` 后、任何领域调用之前 `assertPurchaseDocInScope(db,'PO',id,orgScope)`（ADR-0020 同一判据），范围外 404 且无写。顺序为「范围 → 权限」，与 ADR-0031 的动作路由不同：这两条路由的权限边在领域服务内，先判范围可避免用权限错误探测别组织订单。
6. 全局范围（admin / `all`）与 store / dealer 外部角色行为不变（外部角色仍在 `requireInternal` 403）。无组织的内部账号读为空、写 403。

## 契约变化

受限账号对范围外单据 / 仓：读列表变空、详情 404、写目标 403。全局范围无变化。路由集合与权限链未变，`scripts/check-route-authz.mjs` 无新增或删除登记（这些路由本就 GATED）。OpenAPI 仅响应说明未变。

## 边界

- 范围键只有仓库归属；库存行的货主 `owner_org_id` 不参与。
- 本批不覆盖：质检处置自动生成的调拨（`lib/qc.js` 内部调用）、MCP 库存工具、`/api/master/warehouses` 主数据、`purchase.js` 的收货单 / 退货单读写路由、门店 POS 库存。需另批。
- `stats.byWarehouse` 只列范围内的仓。

## 验证入口

`node --test tests/inventory-scope.test.mjs`：A 组织账号读不到 B / 无归属仓的库存、流水、台账、报表、序列号、调拨（两端皆外）、盘点、组装；调拨读任一端、写两端；调整 / 盘点 / 组装 / 调拨目标越界 403 且流水不增；范围外单据 404 且行不变并与不存在同形；无组织账号读空写 403；dealer 403；采购订单状态 / 收货范围外 404 无写、范围内通过、admin 全局。Mac mini Node 22 本地验证，不等于目标平台验收。
