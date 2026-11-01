# 商品档案 (product master)

主数据 / 商品档案 (`/master/products`) lists SPUs and creates or edits them; saving a new SPU auto-generates its first SKU (`<code>-01`) and writes an audit log row. Page: `src/pages/master/Products.tsx`; API: `server/routes/master.js` (`/api/master/products`).

## Sub-features

- List with 关键词搜索 + 查询, brand/category filters, pagination.
- 新增 modal: 商品名称, 品牌, 品类, 规格, 单位, 零售价, 经销价, 标准成本, 备注 → 保存 → toast 已新增.
- Auto SPU code (`SPU…`) and auto first SKU in `product_skus`.
- Audit trail in `audit_logs` (`action=CREATE`, `entity=products`, `detail`=product name).

## How to get to it (user POV)

Sidebar 主数据 → 商品档案 → 新增 → fill the form → 保存. Search the new name in 关键词搜索 and press 查询 to see exactly one row.

## Driving it with verify-os-erp.sh

Preconditions: `demo` mode (brands and categories must exist — the empty `production` DB has none and the journey fails at the 品牌 select).

```bash
$V launch demo
$V ui products-create .cursor/skills/verify-os-erp/journeys/products-create.json
$V api product-readback "$ADMIN_USER" GET "/api/master/products?keyword=验证商品-$RUN_ID"
$V db product-row  cosmetic "SELECT id,spu_code,name,spec,unit,price_retail,price_dealer,cost_std FROM products WHERE name='验证商品-$RUN_ID'"
$V db product-sku  cosmetic "SELECT s.sku_code FROM product_skus s JOIN products p ON p.id=s.product_id WHERE p.name='验证商品-$RUN_ID'"
$V db product-audit cosmetic "SELECT user_name,action,module,entity,entity_id,detail FROM audit_logs WHERE entity='products' AND detail='验证商品-$RUN_ID'"
```

Pass = journey PASS, API `total=1`, one `products` row, one `-01` SKU, a CREATE audit row whose `entity_id` is the product id.

## Gotchas

- The 新增 form shows `SKU` and `库存` inputs; they are computed list columns (`sku_count`, `stock_qty`), leave them empty.
- Brand/category selects are populated asynchronously; the journey selects by index 1 after the modal heading appears.
- `products.spu_code` is generated server-side; do not assert a fixed code, assert by `${RUN_ID}` name.
