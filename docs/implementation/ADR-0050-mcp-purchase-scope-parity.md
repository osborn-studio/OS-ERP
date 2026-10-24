# ADR-0050：MCP 采购订单读工具与剩余聚合读口和 HTTP 范围对齐（AC1）

日期：2026-10-24。收口 ADR-0046（AB1）Codex 审计留下的 open 项（roadmap-v8 AC1）。状态：开发实现，尚非产品上线验收。

## 问题

- MCP `purchase.list_orders` 与 `report.dashboard_kpi` 的"在途采购"按「入库仓在范围内 **或** 目标门店在范围内」放行；HTTP `GET /api/purchase/orders` 与 `assertPurchaseDocInScope('PO')` 只按入库仓的组织。一张"仓在 B 组织、目标门店在 A 组织"的订单 HTTP 看不到、MCP 看得到。
- `POST /api/demand/dealer/summary` 接受范围外仓库 id，且在途采购不分仓；`GET /api/master/products(/:id)` 的 `stock_qty` 汇总全部仓；`GET /api/master/overview` 的仓库数是全库计数。

## 决定

- **单一谓词**：`server/lib/purchase.js` 新增 `purchaseOrderScopeSql(orgScope, alias)`，返回 `{ sql, params, empty }`，判据就是既有 `purchaseScopeSql(...).wh`（入库仓 `warehouses.org_id`；全局 `1=1`；`dealer` / `none` / 空集合 `1=0`；仓无组织对受限范围不可见）。HTTP 订单列表、`/stats`、`assertPurchaseDocInScope('PO')`、MCP 两个工具、dealer summary 在途汇总全部调它，不再各抄 SQL。
- **MCP**：两个工具改为 `purchaseOrderScopeSql(ctx.scope, 'po')`；不再经 `entityScopeClause` / `target_store_id`。fail-closed 方向有一点差异：有限范围但没有 `orgIds` 时，旧 MCP 口径视为不受限，现与 HTTP 一致视为空范围（真实令牌范围总带 `orgIds`，见 `tokenOrgScope`）。
- **写闸门同步（超出原文件清单的最小改动）**：`PURCHASE_DOC_SCOPE.PO` 去掉 `stores: ['target_store_id']`，使 MCP 订单写闸门（`purchase.advance_order` 等，逐行判断）与读侧、HTTP 同判据；否则"列表里看不到、却能推进"的旧形状会换个方向重现。其余单据类型不动。
- **dealer summary**：加 `attachOrgScope`；显式 `warehouse_id` 先 `assertWarehouseInScope`，范围外 / 不存在 ⇒ 403 `TARGET_OUT_OF_SCOPE`（`bizFail`，与其他写入口同码）；未传仓库时的默认中央仓只在范围内的仓里挑（`defaultCentralWarehouse(db, orgScope)`）；在途采购追加 `purchaseOrderScopeSql(…, 'o')`。同路由族的 `POST /dealer/summary/to-orders`（会往 `warehouse_id` 里建采购订单）同样先判仓库范围，先于任何写。
- **master**：`/products`、`/products/:id`（及商品新建 / 修改后回读）的 `stock_qty` 用 `stockScopeSql(req.orgScope,'st')` 只汇总范围内的仓；同源的 `/skus`、`/scan`（`stock_qty` / `available_qty`）、`/bundles` 的 `stock_qty` 一并收口（同一泄漏形状）。`/overview` 的 `warehouses` 计数加 `stockScopeSql(…, '', 'id')`。其余计数（商品 / SKU / 经销商 / 门店 / 供应商 / 平台）无仓库组织归属，不变。
- 全局范围谓词恒 `1=1`、行为与此前逐字相同。

## 契约变化

- 受限范围：MCP `purchase.list_orders` / `report.dashboard_kpi.purchase_in_transit` 不再因目标门店放行订单；dealer summary 范围外仓 403（原 200），在途只计范围内仓的订单；商品 / SKU / 组合装 / 扫码的库存数量只含范围内的仓；总览仓库数 = 范围内启用仓数。响应字段与 OpenAPI 无变化。

## 测试

`tests/inventory-scope.test.mjs` 新增 AC1（3 个子测试：同一谓词在 lib / HTTP / MCP 一致、dealer summary 403 与在途分仓、master 汇总与总览）；`tests/mcp-tool-matrix.test.mjs` 新增 AC1（经真实 `/mcp` 令牌调用，目标门店在范围内但仓在他组织的订单不可见，全局令牌不变）。两个测试先于实现编写，旧实现下均红。

## 边界（诚实写明）

- 未做 EXPLAIN；`stock_qty` 子查询多了仓库子查询，大库下商品列表成本未评估。
- `master/options` 门店 / 经销商 / 供应商等项、其余主数据计数仍全量（无仓库组织归属）。
- MCP `scopeEntityIds` / `entityScopeClause` 仍用于销售、请购等其他工具，其与 HTTP 的差异不在本 ADR 范围。
- 校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。

## Codex 审计

（见下，审计后补写。）

## 验证入口

`node --test --test-concurrency=1 --test-name-pattern=AC1 tests/inventory-scope.test.mjs tests/mcp-tool-matrix.test.mjs`
