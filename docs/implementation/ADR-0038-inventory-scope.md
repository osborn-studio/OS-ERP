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
- 本批不覆盖：质检处置自动生成的调拨（`lib/qc.js` 内部调用）、MCP 库存工具、`/api/master/warehouses` 主数据、`purchase.js` 的收货单 / 退货单读写路由、门店 POS 库存。需另批。（其中质检处置、仓库主数据、收货 / 退货路由、POS 门店库存已由下方「补充（AA4）」收口；MCP 库存工具见 ADR-0042。）
- `stats.byWarehouse` 只列范围内的仓。

## 验证入口

`node --test tests/inventory-scope.test.mjs`：A 组织账号读不到 B / 无归属仓的库存、流水、台账、报表、序列号、调拨（两端皆外）、盘点、组装；调拨读任一端、写两端；调整 / 盘点 / 组装 / 调拨目标越界 403 且流水不增；范围外单据 404 且行不变并与不存在同形；无组织账号读空写 403；dealer 403；采购订单状态 / 收货范围外 404 无写、范围内通过、admin 全局。Mac mini Node 22 本地验证，不等于目标平台验收。

## 补充（AA4，2026-10-23）：质检处置 / 仓库主数据 / 收货单与退货单 / POS 门店库存

沿用同一判据（`stockScopeSql` / `assertWarehouseInScope` / `purchaseScopeSql.wh`），范围只在路由入口落地，lib 内部调用不传 `orgScope` 时口径不变。

1. **质检处置（`lib/qc2.js` + `routes/qc2.js`）**：`createHandling` / `confirmHandling` / `cancelHandling` / `getHandling` / `listHandlings` 接受可选 `orgScope`，路由 `/api/qc/handlings*` 用 `attachOrgScope` 传入。处置单（及其检验单）的源仓在范围外 ⇒ 与不存在同形 404（`QC2_NOT_FOUND`），先于任何状态判断，不出库不建调拨；让步 / 返工自动生成的调拨在建单前用 `assertTransferTargetsInScope` 校验源仓与隔离仓**两端**，越界 403 `TARGET_OUT_OF_SCOPE` 且整笔不动。隔离仓选择：受限范围优先取范围内的隔离仓（同类型多仓时不再固定取最小 id 的别组织仓），范围内没有则落到 403；全局范围仍取最小 id，行为不变。处置单、检验单（`/api/qc/inspections*` 列表 / 详情，含内嵌处置单）同样按源仓裁剪。让步 / 返工会改写 sku+批次级（跨仓）的 `inventory_batches.qc_status`：受限账号处置时，该批次在范围外仓仍有库存 ⇒ 403 `TARGET_OUT_OF_SCOPE`，不得借此改变别组织货的可售状态。
   - 模块 07 旧质检（`routes/qc.js`，`purchase_inspections`）：判退会经 `createPurchaseReturn` 出库，所以列表 / 详情 / 提交 / 关闭 / 作废按到货仓取单（范围外 404、先于写），建单与到货单装填按 `assertPurchaseDocInScope('GR')`，待检列表按到货仓裁剪。
2. **仓库主数据（`routes/warehouses.js`、`routes/master.js` 货位）**：`GET /api/master/warehouses`（列表含 `all=1`、详情）按 `warehouses.org_id` 裁剪，范围外详情与不存在同形 404，org 为 NULL 的仓与无组织账号读为空。新建 / 修改 / 停用 / 删除拒绝三条写路由追加 `requireGlobalData`：仅全局数据范围可写（受限账号改仓库的 `org_id` / 状态 / 类型会改写别组织的库存可见性）；受限账号 403 `GLOBAL_DATA_FORBIDDEN`，库不变。`GET /api/master/locations` 随仓裁剪，`POST /api/master/locations` 目标仓需在范围内（403）。
3. **采购收货单 / 退货单（`routes/purchase.js`）**：`GR` 沿用 `assertPurchaseDocInScope`，新增 `PRT`（`purchase_returns`，经 `warehouse_id`）；收货单列表 / 详情 / 关闭、退货单列表 / 作废 / 完成按范围，范围外 404 且不推进状态。`POST /returns` 在任何库存写入前 `assertWarehouseInScope(退货仓)`（不存在的仓对受限范围同为 403）。`GET /orders/:id/receive-suggest` 同样先判订单范围（404）。
4. **POS 门店库存（`routes/pos.js`，仅库存读）**：`storeCtx` 新增 `whs` = 绑定门店的**全部启用仓**；`GET /pos/stocks` 与 `GET /pos/products` 的 `store_stock` 汇总它们（此前只取第一个启用仓，多仓门店会漏算）。范围由账号绑定的门店决定；账号另带组织范围（org / subtree 且有具体组织）时再叠加仓库归属组织（门店下挂了别组织仓则读不到它）；无组织的门店账号仍只看门店绑定；未绑门店的非 admin 账号 403 不变；写路径沿用 `wh`（首个启用仓）。本批不动作废 / 交班结算门禁（AA9）。

### 仍未覆盖

- `GET /api/master/options` 的 `warehouses` / `warehouses_all` 下拉候选仍返回全部启用仓的 id / 名称 / 编码 / 类型（供各业务页选择，改动会影响经销商 / 门店下拉，另批评估）。
- `GET /api/purchase/orders`（列表 / 详情）仍只有权限闸；采购订单的范围读见 ADR-0017/0020 的采购链路由，`purchase.js` 内同名读接口待另批核对。
- 质检报检单（QCR）、`/api/qc/pending`、`/api/qc/overview|audit` 汇总以及 qc2 检验单提交 / 关闭 / 作废（无库存后果）不按仓裁剪。
- POS 写路径（收银出库、盘点）仍用门店首个启用仓 `wh`，不叠加组织范围（AA9 另改该文件的门禁）。

### 验证入口

`node --test tests/inventory-scope.test.mjs` 追加 `AA4` 用例：A 组织账号处置 B 仓单据 404（同形、库存与单据不变）、让步调拨在范围内无隔离仓时 403 无调拨、范围内有隔离仓时优先选它、admin 仍选全局最小 id；仓库主数据读裁剪与受限账号三条写 403、货位读写；收货单 / 退货单读与动作 404、退货建单目标仓 403；POS 多仓门店库存只含本店启用仓、跨店不串。遗留脚本 `test-qc2` / `test-warehouse-master` / `test-purchase` / `test-pos2` 在新建 demo 目录上全绿。
