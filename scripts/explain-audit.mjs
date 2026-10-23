#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/explain-audit.mjs ｜ 索引审计：对声明的代表性语句跑 EXPLAIN QUERY PLAN，大表出现裸 SCAN 即报红（roadmap-v3 X10）
 * ============================================================================
 * 【职责】把"哪些热点查询在大表上全表扫描"变成可重复的检查。语句集中声明在下面的 STATEMENTS 表里，
 *   每条写明它镜像的 lib / 路由函数（改了那里的 SQL，要同步改这里）；脚本对**只读打开**的种子库逐条
 *   `EXPLAIN QUERY PLAN`，输出 JSON，并在"裸 SCAN <表>"且该表行数 ≥ 阈值、又不在 ALLOW 里时退出码 1。
 *
 * 【诚实边界】
 *   · 只审计 STATEMENTS 里声明的语句，不是全库；SQL 是对 lib 的**镜像**（人工同步），不是运行时抓取。
 *   · 行数阈值按"当前库"计：demo 种子库最大表约千行，阈值默认 200，所以它证明"在夹具规模下没有裸 SCAN"，
 *     不证明生产规模下的计划；换生产规模副本复跑才是证据。
 *   · `SCAN t USING [COVERING] INDEX` 是索引全扫（通常用于排序/聚合），只记录不报红；
 *     ALLOW 只豁免"某条语句 × 某张表"，且必须写理由；ALLOW 里指向不存在语句的条目会报错（防过期）。
 *   · 对 `?` 参数不绑真值（EXPLAIN 不执行），计划选择不依赖具体值。
 *
 * 【用法】GML_DATA_DIR=/abs/seeded-copy node scripts/explain-audit.mjs [--industry cosmetic]
 *          [--threshold 200] [--out file.json]
 *   退出码：0 无违规；1 有违规；2 用法/安全拒绝（未显式给 GML_DATA_DIR、指向仓库 data/、输出落在仓库 data/ 内）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_VERSION = 1
export const DEFAULT_THRESHOLD = 200

// 每条：id（唯一）、mirrors（镜像的 lib/路由）、bench（对应 bench-api 端点，可空）、sql、params
// SQL 与镜像处逐字一致；动态拼接的 WHERE 用"无过滤"的最常见形态，带过滤的形态单独声明。
export const STATEMENTS = [
  // ---- 看板 dashboard_summary（server/routes/dashboard.js） ----
  { id: 'dash.sales_today', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND order_date = date('now','localtime')" },
  { id: 'dash.sales_month', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(total_qty),0) qty FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')" },
  { id: 'dash.sales_unpaid', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COALESCE(SUM(receivable_amount - paid_amount),0) unpaid FROM sales_orders WHERE status NOT IN ('cancelled','draft')" },
  { id: 'dash.purchase_month', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COUNT(*) orders, COALESCE(SUM(total_amount),0) amount FROM purchase_orders WHERE status NOT IN ('cancelled') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')" },
  { id: 'dash.purchase_open', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COALESCE(SUM(total_amount),0) amount FROM purchase_orders WHERE status IN ('submitted','approved','received')" },
  { id: 'dash.oms_month', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending FROM oms_orders WHERE substr(order_time,1,7) = strftime('%Y-%m','now','localtime')" },
  { id: 'dash.stock_total', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: 'SELECT COALESCE(SUM(qty_on_hand),0) qty, COALESCE(SUM(qty_on_hand*cost_price),0) amount, COUNT(DISTINCT sku_id) skus FROM inventory_stocks' },
  { id: 'dash.todo_counts', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT (SELECT COUNT(*) FROM sales_orders WHERE status='confirmed') AS pending_delivery, (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('submitted','approved')) AS pending_receipt, (SELECT COUNT(*) FROM oms_orders WHERE status='pending') AS oms_pending, (SELECT COUNT(*) FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0 AND COALESCE((SELECT SUM(qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=sk.id),0) < sk.safe_stock) AS below_safe, (SELECT COUNT(*) FROM inventory_stocks st WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date <> '' AND st.expire_date <= date('now','localtime','+90 day')) AS expiring, (SELECT COUNT(*) FROM dealers WHERE status='active' AND credit_limit>0 AND credit_used*1.0/credit_limit>=0.8) AS credit_alert" },
  { id: 'dash.trend_sales', mirrors: 'server/routes/dashboard.js trend', bench: null,
    sql: "SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND order_date >= date('now','localtime','-30 day') GROUP BY order_date ORDER BY date" },
  { id: 'dash.trend_purchase', mirrors: 'server/routes/dashboard.js trend', bench: null,
    sql: "SELECT order_date AS date, COALESCE(SUM(total_amount),0) amount FROM purchase_orders WHERE status <> 'cancelled' AND order_date >= date('now','localtime','-30 day') GROUP BY order_date ORDER BY date" },

  // ---- 采购 purchase_order_list / purchase_order_detail（server/routes/purchase.js、server/lib/purchase.js） ----
  { id: 'po.list_page', mirrors: 'server/routes/purchase.js GET /orders', bench: 'purchase_order_list', params: [20, 0],
    sql: 'SELECT po.*, s.name AS supplier_name, s.code AS supplier_code, s.settle_type AS supplier_settle, w.name AS warehouse_name, (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = po.id) AS item_count FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN warehouses w ON w.id=po.warehouse_id ORDER BY po.id DESC LIMIT ? OFFSET ?' },
  { id: 'po.list_by_status', mirrors: 'server/routes/purchase.js GET /orders?status=', bench: 'purchase_order_list', params: ['approved', 20, 0],
    sql: 'SELECT po.*, s.name AS supplier_name, (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = po.id) AS item_count FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.status = ? ORDER BY po.id DESC LIMIT ? OFFSET ?' },
  { id: 'po.detail_items', mirrors: 'server/routes/purchase.js GET /orders/:id', bench: 'purchase_order_detail', params: [1],
    sql: 'SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, p.name AS product_name, p.spec AS product_spec, b.name AS brand_name FROM purchase_order_items i JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id WHERE i.order_id=? ORDER BY i.id' },
  { id: 'po.detail_receipts', mirrors: 'server/routes/purchase.js GET /orders/:id', bench: 'purchase_order_detail', params: [1],
    sql: 'SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id' },
  { id: 'po.receipt_list', mirrors: 'server/routes/purchase.js GET /receipts', bench: null, params: [20, 0],
    sql: 'SELECT pr.*, s.name AS supplier_name, w.name AS warehouse_name, po.doc_no AS order_no, (SELECT COUNT(*) FROM purchase_receipt_items i WHERE i.receipt_id=pr.id) AS item_count FROM purchase_receipts pr LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN warehouses w ON w.id=pr.warehouse_id LEFT JOIN purchase_orders po ON po.id=pr.order_id ORDER BY pr.id DESC LIMIT ? OFFSET ?' },
  { id: 'po.refresh_invoice_amount', mirrors: 'server/lib/purchase.js refreshOrderStats', bench: null, params: [1],
    sql: "SELECT COALESCE(SUM(ii.amount),0) s FROM purchase_invoice_items ii JOIN purchase_invoices i ON i.id = ii.invoice_id JOIN purchase_order_items oi ON oi.id = ii.order_item_id WHERE oi.order_id=? AND i.status NOT IN ('voided')" },
  { id: 'po.refresh_settle_amount', mirrors: 'server/lib/purchase.js refreshOrderStats', bench: null, params: [1],
    sql: "SELECT COALESCE(SUM(si.amount),0) s FROM purchase_settlement_items si JOIN purchase_settlements st ON st.id = si.settle_id JOIN purchase_receipts rc ON rc.id = si.source_id WHERE si.source_type='receipt' AND rc.order_id=? AND st.status NOT IN ('voided')" },
  { id: 'po.refresh_settles', mirrors: 'server/lib/purchase.js refreshOrderStats', bench: null, params: [1],
    sql: "SELECT DISTINCT st.id, st.doc_no, st.receipt_amount, st.paid_amount FROM purchase_settlements st JOIN purchase_settlement_items si ON si.settle_id = st.id AND si.source_type='receipt' JOIN purchase_receipts rc ON rc.id = si.source_id WHERE rc.order_id=? AND st.status NOT IN ('voided')" },
  { id: 'po.invoice_list', mirrors: 'server/routes/purchase-chain.js GET /invoices', bench: null, params: [50],
    sql: "SELECT i.*, s.code AS supplier_code, s.name AS supplier_name, (SELECT COUNT(*) FROM purchase_invoice_items x WHERE x.invoice_id=i.id) AS line_count FROM purchase_invoices i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE i.status<>'voided' AND 1=1 ORDER BY i.id DESC LIMIT ?" },
  { id: 'po.settlement_list', mirrors: 'server/routes/purchase-chain.js GET /settlements', bench: null, params: [50],
    sql: "SELECT st.*, s.code AS supplier_code, s.name AS supplier_name, (st.settle_amount - st.paid_amount) AS open_amount FROM purchase_settlements st LEFT JOIN suppliers s ON s.id=st.supplier_id WHERE st.status<>'voided' AND 1=1 ORDER BY st.id DESC LIMIT ?" },
  { id: 'po.payment_list', mirrors: 'server/routes/purchase-chain.js GET /payments', bench: null, params: [50],
    sql: "SELECT p.*, s.code AS supplier_code, s.name AS supplier_name, (p.amount - p.settled_amount) AS unallocated FROM purchase_payments p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.status<>'voided' AND 1=1 ORDER BY p.id DESC LIMIT ?" },
  { id: 'po.invoice_items', mirrors: 'server/lib/purchase.js getInvoice', bench: null, params: [1],
    sql: 'SELECT * FROM purchase_invoice_items WHERE invoice_id=?' },
  { id: 'po.settlement_items', mirrors: 'server/lib/purchase.js getSettlement', bench: null, params: [1],
    sql: 'SELECT * FROM purchase_settlement_items WHERE settle_id=?' },
  { id: 'po.payment_items', mirrors: 'server/lib/purchase.js getPayment / voidPayment', bench: null, params: [1],
    sql: 'SELECT * FROM purchase_payment_items WHERE payment_id=?' },
  { id: 'po.receipt_items', mirrors: 'server/lib/purchase.js receipt detail', bench: null, params: [1],
    sql: 'SELECT * FROM purchase_receipt_items WHERE receipt_id=?' },
  { id: 'po.settleable_receipts_not_settled', mirrors: 'server/lib/purchase.js settlement-preview (已结算入库单排除)', bench: null,
    sql: "SELECT r.* FROM purchase_receipts r WHERE r.status IN ('received','inspected','closed') AND r.id NOT IN (SELECT si.source_id FROM purchase_settlement_items si JOIN purchase_settlements st ON st.id = si.settle_id WHERE si.source_type='receipt' AND st.status <> 'voided') ORDER BY r.receipt_date" },
  { id: 'po.payment_release_by_settle', mirrors: 'server/lib/purchase.js payment release ledger', bench: null, params: [1],
    sql: 'SELECT * FROM payment_release_ledger WHERE settle_id=?' },

  // ---- 库存 stock_query（server/routes/inventory.js、server/lib/stock.js） ----
  { id: 'stock.query_page', mirrors: 'server/routes/inventory.js GET /stocks', bench: 'stock_query', params: [20, 0],
    sql: 'SELECT st.id, st.warehouse_id, st.sku_id, st.batch_no, st.produce_date, st.expire_date, st.entry_date, st.location, st.qty_on_hand, st.qty_reserved, (st.qty_on_hand - st.qty_reserved) AS qty_available, st.cost_price, (st.qty_on_hand * st.cost_price) AS amount, st.updated_at, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, sk.safe_stock, sk.serial_managed, p.name AS product_name, p.spu_code, p.unit, b.name AS brand_name, c.name AS category_name, w.name AS warehouse_name, w.type AS warehouse_type FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN products p ON p.id = sk.product_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 ORDER BY w.id, sk.sku_code, st.expire_date LIMIT ? OFFSET ?' },
  { id: 'stock.query_by_sku', mirrors: 'server/routes/inventory.js GET /stocks?sku_id=', bench: 'stock_query', params: [1, 20, 0],
    sql: 'SELECT st.id, st.qty_on_hand, sk.sku_code, w.name AS warehouse_name FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 AND st.sku_id = ? ORDER BY w.id, sk.sku_code, st.expire_date LIMIT ? OFFSET ?' },
  { id: 'stock.query_by_warehouse', mirrors: 'server/routes/inventory.js GET /stocks?warehouse_id=', bench: 'stock_query', params: [1, 20, 0],
    sql: 'SELECT st.id, st.qty_on_hand, sk.sku_code, w.name AS warehouse_name FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 AND st.warehouse_id = ? ORDER BY w.id, sk.sku_code, st.expire_date LIMIT ? OFFSET ?' },
  { id: 'stock.expiring', mirrors: 'server/routes/inventory.js GET /alerts (临期)', bench: null,
    sql: "SELECT st.id, st.batch_no, st.expire_date, st.qty_on_hand, st.warehouse_id, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name, CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id WHERE st.qty_on_hand > 0 AND st.expire_date IS NOT NULL AND st.expire_date <> '' AND st.expire_date <= date('now','localtime','+180 day') ORDER BY st.expire_date LIMIT 100" },
  { id: 'stock.below_safe', mirrors: 'server/routes/inventory.js GET /alerts (低于安全库存)', bench: null,
    sql: "SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock, COALESCE(SUM(st.qty_on_hand),0) qty_on_hand, sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0) shortage FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN inventory_stocks st ON st.sku_id=sk.id WHERE sk.status='active' AND sk.safe_stock > 0 GROUP BY sk.id HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock ORDER BY shortage DESC LIMIT 50" },
  { id: 'stock.txn_page', mirrors: 'server/routes/inventory.js GET /transactions', bench: null, params: [20, 0],
    sql: 'SELECT t.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name FROM inventory_transactions t JOIN product_skus sk ON sk.id=t.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN warehouses w ON w.id=t.warehouse_id ORDER BY t.id DESC LIMIT ? OFFSET ?' },
  { id: 'stock.txn_by_doc', mirrors: 'server/lib/qc2.js / mfg.js 按单据回查流水', bench: null, params: ['MO', 1],
    sql: "SELECT batch_no FROM inventory_transactions WHERE doc_type=? AND doc_id=? AND direction='in' AND batch_no IS NOT NULL AND batch_no<>'' ORDER BY id DESC LIMIT 1" },
  { id: 'stock.txn_by_wh_sku_batch', mirrors: 'server/lib/costing.js 按仓库/SKU/批次回溯', bench: null, params: [1, 1, 'B1'],
    sql: 'SELECT id, qty, amount FROM inventory_transactions WHERE warehouse_id=? AND sku_id=? AND batch_no=?' },
  { id: 'stock.batch_lookup', mirrors: 'server/lib/stock.js 批次状态', bench: null, params: [1, 'B1'],
    sql: 'SELECT status, qc_status FROM inventory_batches WHERE sku_id=? AND batch_no=?' },

  // ---- 应收 receivable_receipt_list（server/routes/ar.js、server/lib/ar.js） ----
  { id: 'ar.receipts_page', mirrors: 'server/routes/ar.js GET /receipts', bench: 'receivable_receipt_list', params: [20, 0],
    sql: 'SELECT * FROM receipts ORDER BY id DESC LIMIT ? OFFSET ?' },
  { id: 'ar.receipts_by_status', mirrors: 'server/routes/ar.js GET /overview', bench: null,
    sql: "SELECT COUNT(*) c, IFNULL(SUM(amount),0) amt FROM receipts WHERE status='confirmed'" },
  { id: 'ar.docs_page', mirrors: 'server/routes/ar.js GET /documents', bench: null, params: [20, 0],
    sql: 'SELECT * FROM ar_documents ORDER BY due_date, id DESC LIMIT ? OFFSET ?' },
  { id: 'ar.docs_open', mirrors: 'server/lib/ar.js overview / aging', bench: null,
    sql: "SELECT * FROM ar_documents WHERE status IN ('open','partial') ORDER BY due_date" },
  { id: 'ar.docs_overdue_sum', mirrors: 'server/lib/ar.js overview', bench: null,
    sql: "SELECT COUNT(*) c, IFNULL(SUM(amount - allocated_amount),0) amt FROM ar_documents WHERE status IN ('open','partial') AND due_date < date('now','localtime')" },
  { id: 'ar.docs_by_subject', mirrors: 'server/lib/ar.js statement', bench: null, params: ['dealer', 1],
    sql: "SELECT * FROM ar_documents WHERE subject_type=? AND subject_id=? AND status <> 'voided' ORDER BY due_date" },
  { id: 'ar.allocs_by_receipt', mirrors: 'server/lib/ar.js confirm/void receipt', bench: null, params: [1],
    sql: 'SELECT * FROM receipt_allocations WHERE receipt_id=?' },
  { id: 'ar.allocs_by_doc', mirrors: 'server/lib/ar.js 应收单已核销明细', bench: null, params: [1],
    sql: 'SELECT a.*, r.doc_no FROM receipt_allocations a JOIN receipts r ON r.id=a.receipt_id WHERE a.ar_id=?' },
  { id: 'ar.aging_view', mirrors: 'server/lib/ar.js aging detail (v_ar_aging_detail)', bench: null,
    sql: "SELECT * FROM v_ar_aging_detail WHERE status IN ('open','partial') ORDER BY overdue_days DESC, due_date, id" },

  // ---- 销售 / 订单中心 ----
  { id: 'sales.list_page', mirrors: 'server/routes/sales.js GET /orders', bench: null, params: [20, 0],
    sql: 'SELECT so.*, d.name AS dealer_name, d.code AS dealer_code, d.discount_rate AS dealer_discount, s.name AS store_name, p.name AS platform_name, p.type AS platform_type, w.name AS warehouse_name, (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id = so.id) AS item_count FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id LEFT JOIN platforms p ON p.id=so.platform_id LEFT JOIN warehouses w ON w.id=so.warehouse_id ORDER BY so.id DESC LIMIT ? OFFSET ?' },
  { id: 'sales.list_by_status_date', mirrors: 'server/routes/sales.js GET /orders?status=&date=', bench: null, params: ['confirmed', '2026-01-01', 20, 0],
    sql: 'SELECT so.*, d.name AS dealer_name FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id WHERE so.status = ? AND so.order_date >= ? ORDER BY so.id DESC LIMIT ? OFFSET ?' },
  { id: 'sales.list_by_dealer', mirrors: 'server/lib/sales-order.js 经销商订单', bench: null, params: [1, 20, 0],
    sql: 'SELECT so.* FROM sales_orders so WHERE so.dealer_id = ? ORDER BY so.id DESC LIMIT ? OFFSET ?' },
  { id: 'sales.items', mirrors: 'server/lib/sales-order.js getOrder', bench: null, params: [1],
    sql: 'SELECT * FROM sales_order_items WHERE order_id=?' },
  { id: 'sales.deliveries_by_order', mirrors: 'server/routes/sales.js GET /orders/:id', bench: null, params: [1],
    sql: 'SELECT * FROM sales_deliveries WHERE order_id=? ORDER BY id' },
  { id: 'sales.delivery_items', mirrors: 'server/routes/sales.js 发货明细', bench: null, params: [1],
    sql: 'SELECT * FROM sales_delivery_items WHERE delivery_id=?' },
  { id: 'oc.orders_page', mirrors: 'server/routes/order-center.js GET /orders', bench: 'order_center_overview', params: [20, 0],
    sql: "SELECT o.*, (SELECT COUNT(*) FROM oc_order_items i WHERE i.order_id=o.id) AS line_count, (SELECT COUNT(*) FROM oc_order_approvals a WHERE a.order_id=o.id AND a.decision='pending') AS pending_nodes FROM oc_orders o WHERE 1=1 ORDER BY o.id DESC LIMIT ? OFFSET ?" },
  { id: 'oc.overview_by_status', mirrors: 'server/routes/order-center.js GET /overview', bench: 'order_center_overview',
    sql: 'SELECT status, COUNT(*) c, ROUND(SUM(total_amount),2) amt FROM oc_orders GROUP BY status ORDER BY c DESC' },
  { id: 'oc.overview_credit_used', mirrors: 'server/routes/order-center.js GET /overview', bench: 'order_center_overview',
    sql: 'SELECT c.id, c.code, c.name, c.level, COALESCE(c.credit_limit, d.credit_limit, 0) AS limit_amount, COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0) AS used FROM oc_customers c LEFT JOIN dealers d ON d.id=c.source_id AND c.source_type=\'dealer\' WHERE c.settle_type<>\'prepay\' ORDER BY (CASE WHEN COALESCE(c.credit_limit,d.credit_limit,0)>0 THEN COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0) / COALESCE(c.credit_limit,d.credit_limit,1) ELSE 0 END) DESC LIMIT 10' },
  { id: 'oc.overview_pending_approval', mirrors: 'server/routes/order-center.js GET /overview', bench: 'order_center_overview',
    sql: "SELECT o.id, o.doc_no, o.customer_name, o.total_amount, o.approval_reason, o.order_date FROM oc_orders o WHERE o.need_approval=1 AND o.status IN ('submitted','approving') ORDER BY o.id DESC LIMIT 20" },

  // ---- 报表 report_operating（server/lib/report.js） ----
  { id: 'rpt.sales_value', mirrors: 'server/lib/report.js operating', bench: 'report_operating', params: ['2026-10'],
    sql: 'SELECT COALESCE(SUM(di.qty * di.price),0) v FROM sales_delivery_items di JOIN sales_deliveries d ON d.id = di.delivery_id WHERE substr(d.delivery_date,1,7) = ?' },
  { id: 'rpt.sales_cost', mirrors: 'server/lib/report.js operating', bench: 'report_operating', params: ['2026-10'],
    sql: "SELECT COALESCE(SUM(amount),0) v FROM inventory_transactions WHERE doc_type='SAL_OUT' AND substr(biz_date,1,7) = ?" },
  { id: 'rpt.purchase_value', mirrors: 'server/lib/report.js operating', bench: 'report_operating', params: ['2026-10'],
    sql: 'SELECT COALESCE(SUM(ri.qty * ri.price),0) v FROM purchase_receipt_items ri JOIN purchase_receipts r ON r.id = ri.receipt_id WHERE substr(r.receipt_date,1,7) = ?' },
  { id: 'rpt.stock_value', mirrors: 'server/lib/report.js operating', bench: 'report_operating',
    sql: 'SELECT COALESCE(SUM(qty_on_hand * cost_price),0) v FROM inventory_stocks' },
  { id: 'rpt.ar_open', mirrors: 'server/lib/report.js operating', bench: 'report_operating',
    sql: "SELECT COALESCE(SUM(amount - allocated_amount),0) v FROM ar_documents WHERE status <> 'voided'" },
  { id: 'rpt.ap_open', mirrors: 'server/lib/report.js operating', bench: 'report_operating',
    sql: "SELECT COALESCE(SUM(settle_amount - paid_amount),0) v FROM purchase_settlements WHERE status NOT IN ('voided','draft')" }
]

/**
 * ALLOW：豁免"某条语句 × 某张表"的裸 SCAN，必须写理由。
 * 这里只放"本质上就是整表聚合 / 无谓词可建索引"的情形，不放"懒得建索引"。
 */
/**
 * GROWTH_TABLES：随业务单调增长的单据/流水表。夹具库里它们可能只有几十行（低于行数阈值），
 * 但生产里会涨，所以这些表上的裸 SCAN 不看行数，一律按违规处理（除非 ALLOW）。
 * 字典/主数据小表（suppliers、warehouses、brands、categories、dealers、stores、platforms 等）不在此列，
 * 只受行数阈值约束。
 */
export const GROWTH_TABLES = new Set([
  'sales_orders', 'sales_order_items', 'sales_deliveries', 'sales_delivery_items', 'oms_orders', 'oms_order_items',
  'oc_orders', 'oc_order_items', 'oc_order_approvals', 'oc_credit_ledger',
  'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'purchase_receipt_items',
  'purchase_invoices', 'purchase_invoice_items', 'purchase_settlements', 'purchase_settlement_items',
  'purchase_payments', 'purchase_payment_items', 'payment_release_ledger', 'purchase_requisitions', 'purchase_requisition_items',
  'inventory_stocks', 'inventory_transactions', 'inventory_batches', 'stock_cost_ledger',
  'ar_documents', 'receipts', 'receipt_allocations', 'doc_events', 'doc_actions'
])

const PAGE_REASON = '按主键倒序取最新一页（ORDER BY id DESC LIMIT n）：沿 rowid 反向扫描，取够 n 行即停，计划里没有排序临时表；不是全表读'
const AGG_REASON = '整表聚合且谓词是否定式/无谓词（status <> / NOT IN / 全量 SUM），几乎所有行都参与，索引无法缩小读取范围'
export const ALLOW = [
  { statement: 'po.list_page', table: 'purchase_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'po.receipt_list', table: 'purchase_receipts', noSort: true, reason: PAGE_REASON },
  { statement: 'po.invoice_list', table: 'purchase_invoices', noSort: true, reason: PAGE_REASON },
  { statement: 'po.settlement_list', table: 'purchase_settlements', noSort: true, reason: PAGE_REASON },
  { statement: 'po.payment_list', table: 'purchase_payments', noSort: true, reason: PAGE_REASON },
  { statement: 'ar.receipts_page', table: 'receipts', noSort: true, reason: PAGE_REASON },
  { statement: 'sales.list_page', table: 'sales_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'oc.orders_page', table: 'oc_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'stock.txn_page', table: 'inventory_transactions', noSort: true, reason: PAGE_REASON },
  { statement: 'dash.sales_unpaid', table: 'sales_orders', reason: AGG_REASON },
  { statement: 'dash.stock_total', table: 'inventory_stocks', reason: '整表聚合（SUM / COUNT DISTINCT 全库存），没有谓词；索引只能做覆盖扫描，不改变量级' },
  { statement: 'rpt.stock_value', table: 'inventory_stocks', reason: '整表聚合库存金额，没有谓词' },
  { statement: 'rpt.ar_open', table: 'ar_documents', reason: AGG_REASON },
  { statement: 'rpt.ap_open', table: 'purchase_settlements', reason: AGG_REASON },
  { statement: 'stock.query_page', table: 'inventory_stocks', reason: '列表谓词 qty_on_hand <> 0 几乎不过滤，且 ORDER BY 跨 warehouses/product_skus 列，整批结果必须排序；单靠索引解决不了，需要分页游标/物化方案（已记为残余项，不在索引迁移范围）' }
]

const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
/** 从 SQL 里解析 FROM/JOIN 的 表 [AS] 别名 → 表名（EXPLAIN 的 SCAN 行用别名） */
export function aliasMap(sql) {
  const map = new Map()
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENT})(?:\\s+(?:AS\\s+)?(?!(?:LEFT|INNER|JOIN|ON|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|CROSS|SET|USING)\\b)(${IDENT}))?`, 'gi')
  let m
  while ((m = re.exec(sql))) { map.set(m[2] || m[1], m[1]); map.set(m[1], m[1]) }
  return map
}

/** 解析一行 EXPLAIN 明细：{ kind: 'table'|'index', name } 或 null（不是扫描行） */
export function parseScan(detail) {
  const m = /^SCAN (\S+)(?: AS (\S+))?(?: USING (.*))?$/.exec(detail.trim())
  if (!m) return null
  return { name: m[1], using: m[3] || null, kind: m[3] && /INDEX/.test(m[3]) ? 'index' : 'table' }
}

/**
 * 审计一组语句。db：better-sqlite3 句柄（只读即可）；statements：同 STATEMENTS 的形状；
 * opts：{ threshold, allow }。返回 { ok, threshold, statements:[{id,mirrors,bench,plan,scans}], violations }
 */
export function auditStatements(db, statements, { threshold = DEFAULT_THRESHOLD, allow = ALLOW, growth = GROWTH_TABLES } = {}) {
  for (const a of allow) {
    if (!a.reason || String(a.reason).trim().length < 4) throw new Error(`allow ${a.statement}/${a.table} 必须写理由 (reason)`)
    if (!statements.some(s => s.id === a.statement)) throw new Error(`allow 指向未知语句 ${a.statement}（过期条目，删掉它）`)
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
  const views = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(r => r.name))
  const countCache = new Map()
  const rowsOf = (t) => {
    if (!countCache.has(t)) countCache.set(t, db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c)
    return countCache.get(t)
  }
  const out = []
  const violations = []
  const used = new Set()
  for (const s of statements) {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...(s.params || []))
    const plan = rows.map(r => r.detail)
    const aliases = aliasMap(s.sql)
    const scans = []
    for (const detail of plan) {
      const sc = parseScan(detail)
      if (!sc) continue
      if (views.has(sc.name) || /^\(subquery|^CONSTANT/.test(sc.name)) continue // 视图/子查询的内部扫描行会单独出现
      const table = aliases.get(sc.name) ?? (tables.has(sc.name) ? sc.name : null)
      const entry = { detail, table: table ?? sc.name, kind: sc.kind, rows: table && tables.has(table) ? rowsOf(table) : null }
      if (sc.kind === 'index') entry.status = 'index_scan'
      else if (!table || !tables.has(table)) { entry.status = 'unresolved'; violations.push({ statement: s.id, table: sc.name, detail, reason: '无法把 SCAN 的别名解析到真实表' }) }
      else if (entry.rows < threshold && !growth.has(table)) entry.status = 'below_threshold'
      else {
        const hit = allow.find(a => a.statement === s.id && a.table === table)
        if (hit && hit.noSort && plan.some(d => /USE TEMP B-TREE FOR ORDER BY/.test(d))) { entry.status = 'violation'; violations.push({ statement: s.id, table, rows: entry.rows, detail, reason: '豁免的前提（无排序临时表）已不成立' }) }
        else if (hit) { entry.status = 'allowed'; entry.reason = hit.reason; used.add(hit) } else { entry.status = 'violation'; violations.push({ statement: s.id, table, rows: entry.rows, detail }) }
      }
      scans.push(entry)
    }
    // SQLite 在运行时为连接临时造的"自动索引"= 它认为这里缺索引；每次查询都重建一遍
    for (const detail of plan) {
      const m = /^SEARCH (\S+) USING AUTOMATIC (?:COVERING )?INDEX/.exec(detail)
      if (!m) continue
      const table = aliases.get(m[1]) ?? m[1]
      const hit = allow.find(a => a.statement === s.id && a.table === table)
      const entry = { detail, table, kind: 'automatic_index', rows: tables.has(table) ? rowsOf(table) : null }
      if (hit) { entry.status = 'allowed'; entry.reason = hit.reason; used.add(hit) } else { entry.status = 'violation'; violations.push({ statement: s.id, table, rows: entry.rows, detail, reason: 'SQLite 运行时自建自动索引：缺真实索引' }) }
      scans.push(entry)
    }
    out.push({ id: s.id, mirrors: s.mirrors, bench: s.bench ?? null, plan, scans })
  }
  const unusedAllow = allow.filter(a => !used.has(a))
  return { ok: violations.length === 0 && unusedAllow.length === 0, threshold, statements: out, violations, unusedAllow }
}

const phys = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
function withinRepoData(p) {
  const rel = path.relative(phys(path.resolve(ROOT, 'data')), phys(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function refuse(message, code = 2) { const e = new Error(message); e.exitCode = code; throw e }

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = { industry: 'cosmetic', threshold: DEFAULT_THRESHOLD, out: null }
  const map = { '--industry': 'industry', '--threshold': 'threshold', '--out': 'out' }
  for (let i = 0; i < argv.length; i++) {
    const k = map[argv[i]]
    if (!k || argv[i + 1] === undefined) refuse(`未知或缺值参数 ${argv[i]}`)
    o[k] = argv[++i]
  }
  o.threshold = Number(o.threshold)
  if (!Number.isInteger(o.threshold) || o.threshold < 1) refuse('threshold 必须是正整数')
  if (!/^[a-z]+$/.test(o.industry)) refuse('industry 非法')
  if (!env.GML_DATA_DIR || !path.isAbsolute(env.GML_DATA_DIR)) refuse('必须显式设置绝对路径 GML_DATA_DIR（隔离的种子库副本）')
  if (withinRepoData(env.GML_DATA_DIR)) refuse('GML_DATA_DIR 位于仓库 data/ 之内；请使用独立副本')
  const file = path.join(env.GML_DATA_DIR, `gml_${o.industry}.db`)
  if (!fs.existsSync(file)) refuse(`找不到种子库 ${file}`)
  if (fs.lstatSync(file).isSymbolicLink()) refuse('库文件是符号链接')
  const outFile = o.out ? path.resolve(o.out) : null
  if (outFile) {
    if (withinRepoData(path.dirname(outFile)) || withinRepoData(outFile)) refuse('输出文件不得位于仓库 data/ 内')
    try { if (fs.lstatSync(outFile).isSymbolicLink()) refuse('输出文件是符号链接') } catch (e) { if (e.exitCode) throw e }
  }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? null
    const result = auditStatements(db, STATEMENTS, { threshold: o.threshold })
    const report = {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      scope_notice: 'Fixture-scale audit of the declared statements on a demo/test database copy. Not a production-scale plan check.',
      db: path.basename(file), latest_migration: applied, threshold: o.threshold,
      statements_checked: result.statements.length, violations: result.violations, unused_allow: result.unusedAllow, statements: result.statements
    }
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
    const scans = result.statements.flatMap(s => s.scans)
    console.log(`explain-audit: ${result.statements.length} 条语句, 迁移 ${applied}, 阈值 ${o.threshold} 行; 裸 SCAN ${scans.filter(s => s.kind === 'table').length} (违规 ${result.violations.length}, 豁免 ${scans.filter(s => s.status === 'allowed').length}, 小表 ${scans.filter(s => s.status === 'below_threshold').length}), 索引全扫 ${scans.filter(s => s.kind === 'index').length}${outFile ? ` -> ${outFile}` : ''}`)
    for (const v of result.violations) console.error(`  ✗ ${v.statement}: ${v.detail} (${v.table}${v.rows != null ? `, ${v.rows} 行` : ''})`)
    for (const a of result.unusedAllow) console.error(`  ✗ 过期豁免（计划里已没有这处 SCAN，请删掉）: ${a.statement} × ${a.table}`)
    if (!result.ok) refuse(`${result.violations.length} 处违规, ${result.unusedAllow.length} 条过期豁免`, 1)
    return result
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { if (!e.exitCode) console.error(e); else if (e.exitCode === 2) console.error(`explain-audit: ${e.message}`); process.exit(e.exitCode ?? 1) })
}
