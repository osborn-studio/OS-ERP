# ADR-0046：主数据下拉仓库项、采购订单读与 QC 聚合按仓库组织范围收口

日期：2026-10-23。收口 AA4 审计留下的剩余只读入口（roadmap-v7 AB1）。状态：开发实现，尚非产品上线验收。

## 问题

ADR-0038 / 0042 把库存域、采购动作与 QC 处置按 `warehouses.org_id` 收口后，还有四类只读入口只过功能权限、不看数据范围：

- `GET /api/master/options` 的 `warehouses` / `warehouses_all` 向任一内部账号返回全部启用仓，范围外仓名、编码、类型都能枚举；
- `GET /api/purchase/orders` 列表与 `GET /api/purchase/orders/:id` 详情只有 `PO_READ_PERMS`；同一服务的订单写入口与收货 / 退货读口早已用 `assertPurchaseDocInScope`，读口成了旁路；
- `GET /api/qc/overview`、`GET /api/qc/audit`（报检 / 检验 / 处置聚合）与 `GET /api/purchase/inspections/overview`（采购质检聚合）对全库计数与金额聚合，并在审计结果里回显范围外单据的 id / 单号；
- `check-route-authz` 的登记表需要复核，确认没有"拿 requireAuth 当闸门"的存量。

## 决定

- **判据唯一化**：全部复用既有谓词，不新写 SQL 口径——仓库按 `stockScopeSql(orgScope, '', 'id')`，采购订单按 `purchaseScopeSql(orgScope,'po').wh` 与详情的 `assertPurchaseDocInScope(db,'PO',…)`，QC 聚合按 `stockScopeSql(orgScope,'')`（`warehouse_id`，与 `listRequests / listInspections / listHandlings` 同源）。全局范围谓词恒为 `1=1`，行为与此前逐字相同；`dealer` / `none` / 空集合 ⇒ `1=0`（空范围不许变成全库）。
- **`/master/options`**：路由加 `attachOrgScope`；`warehouses`（排除隔离仓后的候选）与 `warehouses_all`（筛选面）都加范围谓词。**只裁仓库项**，品牌 / 品类 / 门店 / 供应商 / 经销商 / 平台 / SKU / 套装不变（它们不是仓库组织范围的对象，范围口径另议，见边界）。
- **采购订单**：列表把 `scope.wh` 放进 `WHERE`，`COUNT(*)` 与行用同一 `conds`（分页 `total` 与列表一致）；详情先 `assertPurchaseDocInScope`，范围外与不存在同形 404 `DOC_NOT_FOUND`（路由由 `wrap` 改为 `guard` 以翻译 `PurchaseError`）。
- **QC 聚合**：`qcOverview(db, {orgScope})` / `auditQc(db, {orgScope})` 经 `scopedQcTables(orgScope)` 取表源——全局用原表名，受限换成"只含范围内仓"的子查询（检验 / 报检 / 处置按自身 `warehouse_id`，报检行随其报检单）；`pending_source` 复用已有的 `pendingSources({orgScope})`。采购质检 `inspectionOverview(db,{orgScope})`：质检单按自身仓，判退退货单按其仓，`waiting_receipts` 复用 `pendingReceipts({orgScope})`。
- **范围值内联**：QC 子查询在一次聚合里出现十余次，范围 id 经 `stockScopeSql` 已是 `Number()` 且 `isFinite` 的整数，内联进 SQL 文本，避免重复绑定；任何用户输入都不进入 SQL 文本。
- **`check-route-authz`**：复核结果为"待处理（`pending`）0 条"，低于目标 ≤ 20，本批无需关闭 / 新登记；`/master/options` 所在 `master` 路由器整体挂 `requireInternal`，守卫早已判 GATED。73 条已登记例外（60 条 AUTH_ONLY、13 条 NO_AUTH）全部带理由（公开端点 / 自身 / 元数据 / 处理器内范围），本批不改登记表；本 ADR 涉及的路由未新增任何例外。

## 契约变化

- `GET /api/master/options`：受限范围的账号 `warehouses` / `warehouses_all` 只含本范围内仓（可能为空数组）；全局范围（admin / 全局数据范围）不变。
- `GET /api/purchase/orders`：受限范围只返回范围内仓的订单（`total` 同步）；`GET /api/purchase/orders/:id` 范围外 404（原 200）。
- `GET /api/qc/overview`、`/api/qc/audit`、`/api/purchase/inspections/overview`：受限范围只聚合范围内仓的数据；空范围概览全 0、审计全空。
- 响应字段与 OpenAPI 无变化（`npm run gen:api` 无差异）。

## 守卫与矩阵

`tests/inventory-scope.test.mjs` 新增 AB1 用例（4 个子测试）：`master/options`（A 组织账号只见本组织仓、admin 仍全局、无组织账号两个仓库数组为空、供应商等其他项与 admin 一致）；采购订单列表 / 详情（A 只见 A、`total` 与列表一致、无组织为 0、范围外详情与不存在同形 404、admin 全局）；QC 概览与审计（B 仓插入"抽样 > 报检、判定与数字相反"的破损报检行，admin 能在审计里看到，A 的审计不含且计数等于 A 仓单据数，无组织全 0）；采购质检概览（按到货仓分流）。新用例先于实现编写，旧实现下四个子测试全红。

## 边界（诚实写明）

- `master/options` 的门店 / 经销商 / 供应商 / SKU 等项仍是全量（它们没有仓库组织归属；门店 / 经销商归属范围另有 ADR-0026 / 0027 管辖）。`GET /api/master/overview` 的全库计数（含仓库数）同样未动，不在 AB1 范围。
- QC 聚合用子查询替换表名；大库下 `qc_*` 表按 `warehouse_id` 的谓词是否走索引未做 EXPLAIN 评估（未纳入 `explain-audit` 语句表；列表接口同一谓词早已在用）。
- 受限范围的 `dealer` / `none` 外部主体本来被 `requireInternal` / 权限表挡在这些路由之外，这里只是第二道防线。
- 校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。

## Codex 审计

（见提交后的补记。）

## 验证入口

`node --test --test-concurrency=1 --test-name-pattern=AB1 tests/inventory-scope.test.mjs`；`node scripts/check-route-authz.mjs`。
