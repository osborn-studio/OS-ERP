# ADR-0024：供应商付款释放台账，作废按台账逐笔逆向

日期：2026-10-23。对应 roadmap-v2 W12；与 ADR-0013（收款侧）对称，与 ADR-0018（待复核不得作废）联动。

## 审计结论

付款侧的已付额由 `syncSettlePaid` 按 `SUM(purchase_payment_items)`（仅 approved/paid 的付款单）**重算**，所以作废后余额在数值上大体能回到付款前——但并不对称：

1. 没有"生效那一刻冲了多少"的记录：作废只能靠重算，**掩盖**漂移，无法发现"恢复多于释放"，也无法拒绝错位到别的供应商的行。
2. `void` 路径不是事务：`applyTransition` 先把单据置 `voided`，随后才逐张重算结算单；中途失败会留下"已作废、已付额未掉"。
3. 待复核（ADR-0018）只在路由层 `assertNotPending` 拦截，库函数 `transitionPayment('void')` 自身不拦。

## 决定

- 迁移 `057_payment_release_ledger.cjs`：`payment_release_ledger`（payment_id、item_id、supplier_id、settle_id、amount、paid_before、paid_after、reversed_at、reversal_ref）。
- 付款单 `submit`（用友口径：审核即核销，应付在此刻冲减）后，按明细逐张结算单写行（幂等）。`pay` 只改状态，不改金额，不加行。
- `void` 与状态流转、重算、台账写入**同一事务**：先 `assertNotPending`，再 `reversePaymentRelease` 校验后逆向（行供应商 = 付款单供应商 = 结算单供应商；未逆向；恢复额 ≤ 结算单当前已付额），置 `reversed_at`；单据置 voided 并重算后，用台账期望值与重算值互验，不一致回滚。
- 迁移前已生效、没有台账行的付款单：退回重算口径，流转备注标 `legacy`（与 ADR-0013 同一原则：如实暴露，不猜）。
- 状态机不变：`paid` 为终态，只有 `draft` / `approved` 可作废（`PAY_VOID_BREAKS_SETTLEMENT` 对已结清结算单的保护保留）。
- `seed.js` 的 `KEEP_TABLES` 登记新表。

## 错误码（均 HTTP 409，`PurchaseError` / `FundsError`）

| 码 | 含义 |
|---|---|
| `PAY_RELEASE_ALREADY_REVERSED` | 台账行已逆向，拒绝重复恢复（正常重复作废先被 `TRANSITION_NOT_ALLOWED` 拒绝） |
| `PAY_REVERSAL_SUBJECT_MISMATCH` | 行的供应商或结算单属于别的供应商 |
| `PAY_REVERSAL_EXCEEDS_RELEASED` | 恢复额超过结算单当前已付额 |
| `PAY_REVERSAL_DRIFT` | 逆向后重算值与台账期望值不一致，整体回滚 |
| `FUNDS_REVIEW_PENDING` | 付款单待第二人复核，不能作废（库函数层） |
| `TRANSITION_NOT_ALLOWED` | 终态 / 已作废再作废 |

## 验证

`tests/payment-reversal.test.mjs`（13 项）：行与前后值数值断言；作废后已付额 / 未付余额回到付款前绝对值；草稿作废无行；重复作废；跨供应商（行、结算单两种）；超额；漂移；故障注入（触发器）整体回滚含 `doc_events`；待复核拒绝；legacy；pay 不加行。

## 边界

- 台账记录的是结算单维度的冲减，不涉及采购订单 `paid_amount` 之外的新口径（订单统计仍由 `refreshOrderStats` 重算）。
- 迁移前的付款单无法逐笔核对，只能按重算口径恢复。
