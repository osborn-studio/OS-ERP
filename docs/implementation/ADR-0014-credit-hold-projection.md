# ADR-0014：sales_orders.credit_hold 是授信台账的投影，只有一个写入者

日期：2026-10-22。关联 backlog「开发过程中新增确认的授信阻塞」末段记录的 `test-quote-credit.mjs` 两条既有失败（「信用自洽」「销售订单占用与台账零差异（差异 3 条）」）；ADR-0013 的边界一节曾明确"本批不动"。

## 问题

`sales_orders.credit_hold` 是单据视角的"本单还占着多少额度"。它原来有四个写入者（订单确认路由、`cancelOrder`、`quote-seed` 两处），而真正改变占用的三条路径 —— 收款核销（`credit.settle`）、预收抵扣（同 `settle`）、作废恢复（`credit.reoccupy`）—— 一个都不写它。台账自己是对的，投影却停在占用当天的数字。

固定证据（新鲜美妆库）：`quote-seed` 对 SO202610200003 占用 21614.58、核销 8645.83 并手写 hold 12968.75；随后 `ar-seed` 的 `confirmReceipt` 再释放 12968.75，台账净占用归零而 hold 仍是 12968.75。SO202610190002 经"确认 → 作废 → 再确认"后台账为 0、hold 3556.51；SO202610120004 被 `demo-seed` 的部分收款释放 1393.40、hold 未动。不是运行期才会踩到的路径：任何一张确认收款都会复现。

## 决定

**投影随台账走，写入点只有 `credit.js`。**

- `credit.js` 的 `writeLedger` 每写一行、来源为 `SO` 时，在**同一事务**里调用 `projectOrderHold`：`credit_hold = max(0, SUM(credit_ledger.amount) WHERE source_type='SO' AND source_id=?)`。占用、释放、核销、恢复、人工调整五类变动自然同步；台账行与投影同成败（触发器打断任一侧，另一侧回滚）。
- `projectOrderHold(db, {sourceType, sourceId})` 导出给"没有台账行可写、但投影需要归零"的唯一场景（`cancelOrder` 遇到无信用账户的旧数据）；`reprojectOrderHolds(db)` 给 seed 清台账后整库重算。调用方（`routes/sales.js` 确认、`sales-order.js` 取消、`quote-seed.js`）不再写 `credit_hold`，只保留 `credit_checked_at`。
- `reconcileOrderHolds(db)` 是**唯一对账判据**：按订单往来对象解析出的信用账户取 `openAmountOf`，与 `credit_hold` 比较，返回差异行。它故意不与投影共用 SQL（投影按来源合计所有账户，对账按主体账户），占用挂错客户账户时投影能对上、对账会响。覆盖 `hold > 0 且台账不等`（含台账为 0）与 `hold = 0 但台账仍有占用`两种错 —— 原 `auditCredit` 只查前者。`auditCredit.order_hold_diff` 改为直接取它的结果。
- `scripts/test-quote-credit.mjs` 增加一条显式 `reconcileOrderHolds` 断言；`scripts/verify-seed.mjs` 第 9 节（发票 / 应收自洽）增加同一断言 —— 投影漂移由整库重建自己发现，不只靠报价授信探针。

不需要迁移：没有新表新列。

## 接口变化

- `server/lib/credit.js` 新增导出 `projectOrderHold`、`reprojectOrderHolds`、`reconcileOrderHolds`；`auditCredit().order_hold_diff` 的行多了 `status` 字段，且会把"hold=0 但台账有占用"的订单也报出来（以前漏报）。
- `POST /api/sales/orders/:id/confirm` 响应不变；`cancelOrder` 的 `released_credit` 不变。
- HTTP 接口与错误码无变化。

## 验证

`tests/credit-hold-projection.test.mjs`（9 项，改动前因缺导出全部失败）：occupy 自动投影；确认收款只减对应订单；预收抵扣同口径、多次抵扣；作废回到收款前；部分 / 多票 / 多单 / 封顶释放投影封顶额；取消订单与手工释放归零；对账在投影被改、投影为 0 而台账有占用两种情况下报差；投影写失败回滚台账行、收款状态与释放台账；台账写失败投影不动。每步之后 `reconcileOrderHolds` 为空。

`tests/credit-settlement.test.mjs`、`tests/credit-reversal.test.mjs` 不改一字仍全绿。`test-quote-credit cosmetic/food`、`test-ar`、`test-oc`、`verify-seed all` 结果见提交说明。

## 边界与未做

- 投影按来源合计**所有**账户；一张订单的占用若被分到两个账户（跨客户错账），投影是两边之和，对账会在 `reconcileOrderHolds` 报差 —— 这是故意的，不在投影层兜。
- `oc_orders.credit_hold` 已由 `oc-credit.js` 自己维护（ADR-0013 之前就如此），本批不动。
- `scripts/test-guards.mjs` 的一处夹具直接改写 `credit_hold` 再复原，属测试自身的故障注入，不是业务写入者。
