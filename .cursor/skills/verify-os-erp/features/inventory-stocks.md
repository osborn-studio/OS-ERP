# 库存查询 / 收发存台账

存货管理 / 库存查询 (`/inventory/stocks`) shows on-hand, reserved and available quantity per warehouse, SKU and batch; 收发存台账 (`/inventory/ledger`) lists every stock movement. Pages: `src/pages/inventory/Stocks.tsx`, `Ledger.tsx`; tables `inventory_stocks`, `inventory_transactions`.

## Sub-features

- 库存查询: keyword (placeholder `SKU 编码 / 商品名 / 批次号`), 全部仓库 filter, columns 现存量 / 占用量 / 可用量 / 安全库存 / 成本单价 / 库存金额.
- 收发存台账: movements with doc type (`PUR_IN`, `SAL_OUT`, …, dictionary `inv_txn_types`), direction and running balance.
- Related: 可用量报表, 存货核算与成本, 调拨, 盘点 (not mapped yet).

## How to get to it (user POV)

Sidebar 存货管理 → 库存查询, type a SKU code in the search box, pick a warehouse. Sidebar 存货管理 → 收发存台账 for the movement history.

## Driving it with verify-os-erp.sh

Preconditions: `demo` mode. Best used as the readback for a flow that moves stock (see purchase-orders.md). No dedicated journey yet — add one before claiming the UI is verified.

```bash
$V db stock cosmetic "SELECT warehouse_id,sku_id,batch_no,qty_on_hand,qty_reserved FROM inventory_stocks WHERE sku_id=<sku> AND warehouse_id=<wh>"
$V api stock-ui "$ADMIN_USER" GET "/api/inventory/stocks?keyword=<sku_code>"
```

## Gotchas

- 可用量 is computed (on hand − reserved), not stored; compare against the API, not a column.
- Stock rows are keyed by batch; a receipt without batch lands in `batch_no=''`.
- Status: only the DB readback after `purchase-receive` was exercised on the box; the stocks page UI itself is **not verified**.
