# ADR-0017：采购链读接口与待办同一道门、同一份组织范围

日期：2026-10-23。收口 ADR-0015「边界」第一条：`/api/purchase/chain/overview`、`/chain/flow`、后段四张单的列表接口仍只 `requireAuth`。状态：开发实现，尚非产品上线验收。

## 决定

`server/routes/purchase-chain.js` 的全部读接口 —— `GET /chain/overview`、`/chain/flow`、`/chain/todos`、`/requisitions`、`/invoices`、`/settlements`、`/payments`、`/payables` —— 共用一个 `readGate = [requireAuth, requireInternal, requirePerm(...PO_READ_PERMS), attachOrgScope]`（dealer / store 403；无采购读权限的角色如 `sales` 403；未登录 401）。

范围判据只有一份：`lib/purchase.js` 导出的 `purchaseScopeSql(orgScope, alias)`，由 ADR-0015 的私有 `orgScopeSql` 改成公用并返回完整谓词（`1=1` 全库 / `1=0` + `empty` 空范围 / `org_id IN (…)` 与 `warehouse_id IN (SELECT id FROM warehouses WHERE org_id IN (…))`）。待办、看板、四张单列表、应付台账都调它：

- 请购 / 发票 / 结算 / 付款按自身 `org_id`；采购订单与采购退货没有组织列，经 `warehouses.org_id`。
- 归属为 NULL 的单据对 `org` / `subtree` 范围不可见，对 `all`（admin、`data_scope=all`）可见。
- `dealer` / `none` / 无组织归属的受限账号：**200 + 空列表 / 零总览**，不是 403（页面要分得开"没数据"与"没资格"）。
- 看板的每一块（五张单计数与金额、供应商榜、应付榜、30 日趋势）与列表接口的 `summary` 合计都按**同一个集合**算；"列表按范围、合计按全库"是最隐蔽的泄漏形状，本 ADR 把它堵掉。
- `/chain/flow` 不含单据数据，但与工作台其余两块同一道门：外部主体不该拿到内部流程节点与权限点清单。

`listRequisitions(db, q)` 新增可选 `q.orgScope`，`purchaseOverview(db, { orgScope })` 新增可选参数；不传即全库（lib 内部 / 脚本 / 通知摘要 013 的口径不变）。

## 前端

工作台 / 请购 / 发票 / 结算 / 付款 / 应付页都走 `useFetch`，403 落在 `error` 状态、页面不崩；这些菜单本就只对 `exec / supply / stock / money` 角色族可见，而内置 `boss / scm / purchase / warehouse / finance / viewer` 都持 `purchase.order.view`，菜单可见即能进门。不改前端代码。

## 契约变化

七个读接口新增 403 响应并在 summary 里写明门与范围；OpenAPI 版本 1.32.0 → 1.33.0，`src/types/api-routes.ts` 重新生成。

## 行为变化

与 ADR-0015 同族：内置 `purchase` / `warehouse` 角色默认 `subtree` 范围，演示账号无组织归属 ⇒ 升级后这些账号的采购工作台看板、四张单列表为空，需管理员挂组织或设 `data_scope=all`。这是收口的直接后果，不是回归。

## 边界

- 详情接口（`/requisitions/:id` 等）、`/chain/actions`、`/catalog`、`/price*`、`/invoices-available-lines`、`/settlement-preview`、`/payment-plan`、`/orders/:id/closes` 仍只 `requireAuth`，未在本批处理（按行判断归属需要 `assertCanRead` 一类的逐行判据，另立 ADR）。
- 写接口的权限门不变。

## 验证入口

`node --test tests/purchase-chain-scope.test.mjs`（test 运行时、临时数据目录、随机回环端口）：七个接口对 store / dealer / sales 403、未登录 401；admin 全库含 NULL 行、总览 total 等于 SQL 直数；`org` 范围的仓管只见 A 组织四张单与订单、三张列表 `summary` 与总览每一块等于按 A 直算、应付台账同口径；`subtree` 范围见 A 不见 B 与 NULL，同角色 `all` 范围见 NULL；无组织的受限账号四张列表空、总览零、应付空。另需通过 `tests/authz-followups.test.mjs`（ADR-0015 不回归）、`npm run test:focused`、`npx tsc --noEmit`、`node scripts/check-file-header.mjs`、`node scripts/check-api-contract.mjs`，以及全新演示目录上的 `scripts/test-purchase.mjs cosmetic`、`scripts/verify-purchase-chain.mjs cosmetic`。Mac mini Node 22 本地验证，不等于目标平台验收。
