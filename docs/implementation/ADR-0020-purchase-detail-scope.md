# ADR-0020：采购链详情与辅助读接口同一道门、逐单范围判定

日期：2026-10-23。收口 ADR-0017「边界」：ADR-0017 之后 `GET /requisitions/:id`、`/invoices/:id`、`/settlements/:id`、`/payments/:id`、`/chain/actions`、`/catalog`、`/price`、`POST /price-preview`、`/invoices-available-lines`、`/settlement-preview`、`/payment-plan`、`/orders/:id/closes` 仍只 `requireAuth`，任何登录账号（含 dealer / store）凭单号即可读到别的组织的单据。状态：开发实现，尚非产品上线验收。

## 决定

- 详情 / 动作 / 预览类接口共用 ADR-0017 的 `readGate`（内部主体 → 采购读权限 → 挂组织范围）。
- 单据详情取单前调用 `lib/purchase.js` 的 `assertPurchaseDocInScope(db, docType, id, orgScope)`：与 `purchaseScopeSql` 同一判据（PRQ / PI / PST / PAY 按 `org_id`，PO / GR 经 `warehouses.org_id`；NULL 对受限范围不可见、对全局范围可见）。**范围外与不存在同形**：同一句话的 404，不泄漏存在性（与 K3 判据一致）。覆盖 `/requisitions|invoices|settlements|payments/:id`、`/chain/actions`、`/orders/:id/closes`，以及 `POST /price-preview` 带 `order_id` 时。
- `/catalog`、`/price` 是主数据：要求采购读权限（`masterReadGate`），**不**按组织过滤。
- 无单据入参的预览 / 计划类接口按调用者范围聚合：`/settlement-preview` 的入库经仓的组织、发票按 `org_id`；`/payment-plan` 只列、只核销范围内的结算单（全局范围沿用 `planAllocation`，受限范围对过滤后的清单做同口径 FIFO）；`/invoices-available-lines` 的入库按仓的组织收口，已开票量保持全量（它是订单行的事实，不随调用者缩水）。空范围 ⇒ 200 + 零 / 空。
- `/orders/:id/closes` 会刷新关闭标记，范围判定放在刷新之前，越权调用不产生任何写。

## 契约变化

上述接口新增 403（及详情类 404）响应并在 summary 写明；OpenAPI 1.33.0 → 1.34.0，`src/types/api-routes.ts` 重新生成。外部主体（dealer / store）与无采购读权限的角色（sales）由 200 变为 403 —— 这是收口的直接后果。

## 边界

写接口门不变。Codex 独立审计指出的两点留作已知后续：`POST /payments` 的自动核销（`planAllocation`）与 `POST /settlements` 的来源选择（`buildSettlement`）仍按供应商全量，与受限账号看到的预览可能不一致。它们属写路径（W12 同文件、另立 ADR），本批只收口读；预览只是不泄漏范围外数据，并不承诺与跨组织落单结果相等。

`routes/purchase.js` 的订单 / 收货 / 退货详情另批。

## 验证入口

`node --test tests/purchase-chain-detail-scope.test.mjs`：外部主体 / sales 403、未登录 401；admin 全可读、未知 id 404；org-A 仓管读 A 200、读 B / NULL 404 且与不存在同形；主数据不分组织；预览 / 计划按范围聚合（SQL 直算对账）；无组织受限账号全部 404 / 零值。Mac mini Node 22 本地验证，不等于目标平台验收。
