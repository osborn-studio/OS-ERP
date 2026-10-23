# ADR-0031：采购链动作路由与 MCP 采购工具的单据范围

日期：2026-10-23。收口 ADR-0020「边界」与 ADR-0021 登记的最后一批采购链缺口：读接口已按组织范围判定（ADR-0017 / 0020），写接口里「按单号动作」的那几条仍只验动作权限、不验单据归属，MCP 两个采购工具也没有把所有者范围交给 lib。状态：开发实现，尚非产品上线验收。

## 现状（修前）

- `POST /requisitions|invoices|settlements|payments/:id/:action`：`requireAuth` + 处理器内 `assertActionPermitted`（只按状态边判动作权限）。持有动作权限的受限账号凭单号即可审批 / 作废别的组织的单据。
- `POST /requisitions/:id/convert`、`POST /payments/:id/review`：`requirePerm` 但不判单据归属；`convert` 还允许 body 指定任意入库仓。
- `POST /orders/:id/receive-check`：只有 `requireAuth`。
- MCP `purchase.build_settlement` / `purchase.create_payment`：只校验目标 `org_id` 落在令牌范围内（`assertPurchaseWriteScope`），没有把范围传给 `buildSettlement` / `createPayment`（ADR-0028 已支持 `orgScope`），于是结算来源选择、FIFO 与手工核销仍按供应商全量。

## 决定

1. **动作路由统一的门 `actionGate`** = `requireAuth` → `requireInternal('采购单据')` → `attachOrgScope`，用于四条 `/:id/:action`、`/requisitions/:id/convert`、`/payments/:id/review`。外部主体（dealer / store）在动作权限之前就 403。
2. **单据范围判定紧跟动作权限、先于任何写**：`assertActionPermitted` 在 `assertEdgePermitted` 通过后调用 `assertPurchaseDocInScope(db, docType, id, req.orgScope)`（ADR-0020 的同一判据，PRQ / PI / PST / PAY 按 `org_id`，PO 经仓归属；NULL 对受限范围不可见）。范围外与不存在同形 404（`DOC_NOT_FOUND`），不产生任何写。顺序取「权限 → 范围」是为了不改既有契约（无动作权限的内部账号仍得 403 `PERM_DENIED`，`scripts/test-mcp-purchase.mjs` 的权限闸断言依赖它）；唯一能产生写的人群是持有动作权限者，他们够不到范围外单据。残留：无动作权限的内部账号对范围外**存在**的单据得 403、对不存在的得 404，这一差别在修前就有（`assertActionPermitted` 先取行），本批不扩大。
3. **`/requisitions/:id/convert`**：请购单必须在范围内；body 显式给出的 `warehouse_id` 必须在范围内（与 `purchaseScopeSql().wh` 同一谓词），否则 404 且不生成采购订单。不给仓时沿用请购单自带的仓。
4. **`/payments/:id/review`**（ADR-0018 的 `finance.funds.review`）：在 `requirePerm` 之后、`reviewFunds` 之前判范围；范围外 404，且不写复核记录（`requirePerm` 在前，与上同序）。「复核人不得是发起人」等 ADR-0018 规则不变。
5. **`/orders/:id/receive-check`**：改走 `readGate`（内部主体 + 采购读权限 + 范围），并对 PO 做范围判定。它虽不写库，但原来可对任意订单探测收货超量信息。
6. **MCP**：`purchase.build_settlement`、`purchase.create_payment` 把 `ctx.scope`（令牌自身范围 ∩ 所有者当前范围，`delegation.js` 的 `effectiveScope`）作为 `orgScope` 传入 `buildSettlement` / `createPayment`。结果：结算只取范围内的入库 / 发票 / 退货；付款 FIFO 只在范围内结算单上挑；手工核销指向范围外结算单 ⇒ `DOC_NOT_FOUND`（与不存在同形，写入前拒绝）。全局范围（`all`）行为不变。`tools.js` 只动这两个工具（roadmap v4 冲突提示）。

## 契约变化

上述接口新增 403（外部主体）与 404（范围外）响应并在 summary 写明；OpenAPI 1.35.0 → 1.36.0，`src/types/api-routes.ts` 重新生成。`receive-check` 对 sales 等无采购读权限的角色由 200 变 403。`scripts/check-route-authz.mjs` 删去此前登记的两组例外（收货核对的 `gap`、四条动作路由的 `handler-scope`），守卫现在对采购链无登记。

## 边界

- 动作权限码仍在处理器内按状态边判定（`assertEdgePermitted`），不是路由级 `requirePerm`；守卫看到的强闸门是 `requireInternal`。
- `POST /requisitions`、`/invoices`、`/settlements`、`/payments` 创建时的 `org_id` 取自 body 的校验不在本批（创建路径的归属由 ADR-0028 与 `assertPurchaseWriteScope` 分别覆盖 HTTP 结算 / 付款与 MCP）。
- `routes/purchase.js` 的订单 / 收货 / 退货动作路由另批。

## 验证入口

`node --test tests/purchase-action-scope.test.mjs`：受限账号对 B / NULL 组织的请购 / 发票 / 结算 / 付款动作、转单、复核、收货核对一律 404 且行不变，并与不存在同形；范围内 200、admin 全局；转单指定范围外仓 404 且不新增订单；外部主体 403 / 未登录 401 / 无组织账号 404；MCP 结算在 B 组织发票存在时对 A 令牌 `PST_NOTHING` 并且 B 发票未被挂结算，A 发票生成后金额只含 A；MCP 付款手工核销范围外结算 `DOC_NOT_FOUND`，FIFO 只落在 A 的结算单。Mac mini Node 22 本地验证，不等于目标平台验收。
