# ADR-0013：收款释放的授信按台账逐笔逆向，不按总额猜

日期：2026-10-22。关联 backlog「开发过程中新增确认的授信阻塞」两条 P1（作废已确认收款 / 预收抵扣）；本条只解决**收款单触发的释放与其逆向**，不改变订单确认占用、订单取消释放的既有口径。

## 问题

正向路径（发票回款按 SI → SO 映射释放统一授信）已在 `tests/credit-settlement.test.mjs` 守住，但两条反向/旁路仍漏：

1. `voidReceipt` 恢复 AR 债务、只回补订货中心台账（按核销明细金额猜），统一授信 `credit_ledger` 一笔不动 —— 每作废一次就白送一笔额度；
2. `applyPrepay` 只释放订货中心台账，SO / SI 对应的统一授信滞留不放 —— 客户用预收抵了账，额度却不回来。

两处都没有"这张收款单释放了谁的多少"的记录：`credit_ledger.settle` 行不带收款单 id，一张收款单核销多张应收、多张应收映射到同一张 SO 时，事后无法从台账反推。按总额恢复必然在封顶（释放额 < 核销额）、部分核销、多票、多客户时算错。

## 决定

**释放时记归属，逆向时只读归属。**

- 迁移 `052_credit_release_ledger.cjs` 新建 `credit_release_ledger`：每一笔由收款单触发的释放一行 —— `receipt_id`、`ar_id`、`trigger`（confirm / prepay）、`ledger`（credit 统一授信 / oc 订货中心）、`account_id`、`customer_type/customer_id`（收款单往来对象）、`source_type/source_id/doc_no`（占用所在来源：SI 映射到其 SO；无来源应收记 RCP）、`amount`（**实际释放额**，已按来源剩余占用封顶）、`ledger_id`、`reversed_at`、`reversal_ref`。
- 新文件 `server/lib/credit-release.js` 是释放与逆向的**唯一实现**：
  - `releaseForReceipt`：确认收款与预收抵扣共用。SI → SO 映射（`creditSourceOfAr`，从 ar.js 迁入）、`credit.settle` 封顶、OC 走 `oc-credit.releaseByOrder`，每笔按台账函数回报的实际释放额记行。来源占用若挂在**另一客户账户**名下 → 409 `CREDIT_RELEASE_SUBJECT_MISMATCH`（原来静默空转）。
  - `reverseForReceipt`：作废时逐行恢复。行的客户必须等于收款单往来对象、等于信用账户主体 / 订货单客户，否则 409 `CREDIT_REVERSAL_SUBJECT_MISMATCH`；任一行已 `reversed_at` → 409 `CREDIT_RELEASE_ALREADY_REVERSED`；恢复额超过「来源历史占用 − 当前仍占用」→ 409 `CREDIT_REVERSAL_EXCEEDS_SOURCE`（`credit.reoccupy` 判据；拒绝不截平，与 A07 同一原则）。整段在 `voidReceipt` 的事务里，中途失败整体回滚。
- `credit.settle` 的返回补 `amount`（实际释放额）；新增 `credit.reoccupy`：写 `occupy` 行、沿用该来源最近占用行的 `due_date`（作废收款不能把逾期洗白）。不另立 change_type，快照逾期统计与界面类型字典不变。
- `ar.js` 的 `confirmReceipt` / `applyPrepay` / `voidReceipt` 不再直接写任何授信台账。文件头"作废不自动回收授信"的旧口径废止。
- `seed.js` 的 `TABLES` 登记新表（先于 `receipts` 清），`verify-seed` 第 16 节不变红。

## 接口变化（均为新增字段，不改既有字段）

- `POST /api/ar/receipts/:id/confirm` 响应增加 `credit_released: { entries, unified, oc, rows }`；
- `POST /api/ar/receipts/:id/void` 响应增加 `credit_reversal: { entries, unified, oc, rows, legacy }`；
- `POST /api/ar/prepay/apply` 响应增加 `credit_released`（同上形状）。
- 新错误码：`CREDIT_RELEASE_SUBJECT_MISMATCH`、`CREDIT_RELEASE_ALREADY_REVERSED`、`CREDIT_REVERSAL_SUBJECT_MISMATCH`、`CREDIT_REVERSAL_EXCEEDS_SOURCE`（均 409，`CreditError`）。重复作废仍先被既有 `RC_ALREADY_VOID` 拒绝。

## 验证

`tests/credit-reversal.test.mjs`（15 项，改动前全部失败）：部分核销作废回到收款前绝对值（占用、快照已用、AR 已收/状态、台账行 `reversed_at`/`reversal_ref`、余额零漂移、恢复行带 due_date）；多票多单只逆向自己的行；多客户互不影响；重复作废拒绝且不二次恢复；跨客户逆向拒绝且收款单仍 confirmed；中途触发器失败整体回滚（收款状态、AR、已恢复的前一笔、留痕数）；封顶释放按实际额记录与恢复；超来源可恢复额拒绝；确认收款释放他人占用拒绝；预收抵扣按来源释放、封顶、记 `trigger='prepay'`；预收抵扣后作废逐笔恢复；跨客户预收拒绝；`releaseCredit=false` 不记不恢复；OC 收款释放记行并按行恢复；迁移前收款单（无行）OC 退回旧口径并标 `legacy`。

`tests/credit-settlement.test.mjs`（正向修复）保持全绿。

## 边界与未做

- **迁移 052 之前已确认的收款单没有台账行**：作废时 OC 沿用旧口径（按核销明细回补）并在响应里标 `legacy: true`，统一授信**不恢复**。不做回填：`settle` 行不带收款单 id，任何回填都是猜。需要人工按 `credit.adjustCredit` 处理，并在界面提示。
- 预收抵扣没有独立的"撤销抵扣"动作；其逆向只有作废整张收款单一条路，本批按此覆盖。
- `sales_orders.credit_hold` 在回款释放时本来就不同步（`auditCredit.order_hold_diff` 的既有口径），本批不动。
- 并发：两张收款单同时作废同一来源的恢复由 SQLite 事务串行化，未做压测。
