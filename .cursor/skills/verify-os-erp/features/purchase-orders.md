# 采购订单 → 收货入库

采购管理 / 采购订单 (`/purchase/orders`) creates a draft PO, moves it through 提交 → 审批, and 收货 posts a purchase receipt that increases stock and writes an inventory transaction. Page: `src/pages/purchase/Orders.tsx`; API: `server/routes/purchase.js`.

## Sub-features

- 新建采购订单 modal: 供应商, 收货仓库, 结算方式, 下单日期, 期望到货日, 备注, line grid (商品 SKU select, 数量, 单价, 税率%) → 保存草稿 → toast 采购订单已创建.
- Row actions by status: 草稿 → 提交 (confirm dialog) → 审批 (confirm dialog) → 收货; 取消 while open.
- 收货 modal → 确认收货入库 → toast 收货完成，库存已入库; PO status `received`.
- Side effects: `purchase_receipts` (`PR…`), `inventory_stocks` qty up, `inventory_transactions` `PUR_IN` row.

## How to get to it (user POV)

Sidebar 采购管理 → 采购订单 → 新建采购订单 → choose supplier and warehouse, pick a SKU in the first line, set quantity → 保存草稿. In the first table row click 提交, then 审批, then 收货 → 确认收货入库.

## Driving it with verify-os-erp.sh

Preconditions: `demo` mode (needs suppliers, warehouses, SKUs); the newest PO is the first table row (`ORDER BY po.id DESC`).

```bash
$V ui purchase-receive .cursor/skills/verify-os-erp/journeys/purchase-receive.json
$V db po-row cosmetic "SELECT id,doc_no,status,total_qty,total_amount FROM purchase_orders WHERE remark LIKE '%$RUN_ID%'"
$V db po-in  cosmetic "SELECT t.doc_type,t.doc_no,t.direction,t.qty,t.balance_qty FROM inventory_transactions t WHERE t.doc_type='PUR_IN' AND t.doc_no IN (SELECT r.doc_no FROM purchase_receipts r JOIN purchase_orders po ON po.id=r.order_id WHERE po.remark LIKE '%$RUN_ID%')"
```

Pass = journey PASS, PO `status=received` with the journey quantity, and one `PUR_IN` row with the same quantity.

## Gotchas

- The modal opens with one empty line already; clicking 添加一行 adds a second empty line and 保存草稿 then refuses with a short-lived toast 请完整填写明细行.
- The line SKU select and quantity input have no label; the journey uses `selectIn`/`fillIn` scoped to `table`.
- 提交 and 审批 open `window.confirm`; the harness auto-accepts and logs the text in `steps.log`.
- Do not wait on the generic toast 操作成功 between actions — it lingers; wait for the next row button instead.
- Approval rules (`approval` module) can change who may 审批; the demo admin can approve everything.
