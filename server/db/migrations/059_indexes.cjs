'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/059_indexes.cjs ｜ 索引审计补缺：外键列、状态+日期组合、月度聚合表达式索引（roadmap-v3 X10）
 * ============================================================================
 * 【职责】补 `scripts/explain-audit.mjs` 在 W11 基线接口与采购/库存/应收主查询里发现的缺索引：
 *   子表外键列（order_id / receipt_id / delivery_id / order_item_id / source_id）、库存 sku_id 与 expire_date、
 *   流水 (doc_type, doc_id)、应收 due_date 排序，以及看板/经营报表按月聚合用的 `substr(date,1,7)` 表达式索引。
 *   每个索引服务哪条语句，记录在下面 INDEXES 的 `serves` 字段（同 explain-audit 的 STATEMENTS id）。
 *
 * 【为什么这样设计】
 *   · 只加**非 UNIQUE** 索引（`CREATE INDEX IF NOT EXISTS`）：不改变任何数据约束与语义，迁移可重复执行，
 *     不会因历史重复数据而失败。已执行迁移不改（ADR-0009 校验和），所以新开 059 而不是回改旧迁移。
 *   · 表达式索引只在查询里的表达式与索引表达式**逐字一致**时才被用到，所以 explain-audit 的语句与 lib 必须同步；
 *     lib 若改写成区间条件（date >= ? AND date < ?），这些表达式索引就可以删。
 *   · 写放大：每个索引让对应表的每次 INSERT/UPDATE 多维护一棵 B 树。inventory_transactions 是写最频繁的表，
 *     这里只加 2 个；其余多为单据头/行表。
 *   · 表或列在某行业库里不存在则跳过（verify 用同一判据），不会让迁移整体失败。
 *
 * 【改它要注意什么】INDEXES 是 up 与 verify 的唯一来源；改动后同步 explain-audit 的 STATEMENTS，
 *   并保持 tests/explain-audit.test.mjs 绿。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '索引审计补缺（外键列 / 状态+日期 / 月度聚合表达式索引）'

// needs：该索引依赖的真实列（表达式索引也列出底层列）；expr 为索引列表达式文本
const INDEXES = [
  // ---- 采购链子表外键 ----
  { name: 'idx_poi_order',        table: 'purchase_order_items',      cols: 'order_id',                    needs: ['order_id'],                 serves: 'po.list_page po.detail_items po.refresh_invoice_amount' },
  { name: 'idx_prc_order',        table: 'purchase_receipts',         cols: 'order_id',                    needs: ['order_id'],                 serves: 'po.detail_receipts po.refresh_settle_amount po.refresh_settles' },
  { name: 'idx_prc_status_date',  table: 'purchase_receipts',         cols: 'status, receipt_date',        needs: ['status', 'receipt_date'],   serves: 'po.settleable_receipts_not_settled' },
  { name: 'idx_prci_receipt',     table: 'purchase_receipt_items',    cols: 'receipt_id',                  needs: ['receipt_id'],               serves: 'po.receipt_list po.receipt_items' },
  { name: 'idx_pinvi_order_item', table: 'purchase_invoice_items',    cols: 'order_item_id',               needs: ['order_item_id'],            serves: 'po.refresh_invoice_amount' },
  { name: 'idx_psi_source',       table: 'purchase_settlement_items', cols: 'source_type, source_id',      needs: ['source_type', 'source_id'], serves: 'po.refresh_settle_amount po.settleable_receipts_not_settled' },
  // ---- 销售子表外键 ----
  { name: 'idx_soi_order',        table: 'sales_order_items',         cols: 'order_id',                    needs: ['order_id'],                 serves: 'sales.list_page sales.items' },
  { name: 'idx_sdel_order',       table: 'sales_deliveries',          cols: 'order_id',                    needs: ['order_id'],                 serves: 'sales.deliveries_by_order' },
  { name: 'idx_sdeli_delivery',   table: 'sales_delivery_items',      cols: 'delivery_id',                 needs: ['delivery_id'],              serves: 'sales.delivery_items' },
  // ---- 库存 ----
  { name: 'idx_stock_sku',        table: 'inventory_stocks',          cols: 'sku_id',                      needs: ['sku_id'],                   serves: 'stock.query_by_sku stock.below_safe dash.todo_counts' },
  { name: 'idx_stock_expire_date', table: 'inventory_stocks',         cols: 'expire_date',                 needs: ['expire_date'],              serves: 'stock.expiring dash.todo_counts' },
  { name: 'idx_it_doc_ref',       table: 'inventory_transactions',    cols: 'doc_type, doc_id',            needs: ['doc_type', 'doc_id'],       serves: 'stock.txn_by_doc' },
  // ---- 应收 ----
  { name: 'idx_ar_due_id',        table: 'ar_documents',              cols: 'due_date, id DESC',           needs: ['due_date'],                 serves: 'ar.docs_page' },
  // ---- 状态/日期 ----
  { name: 'idx_so_order_date',    table: 'sales_orders',              cols: 'order_date',                  needs: ['order_date'],               serves: 'dash.sales_today dash.trend_sales' },
  { name: 'idx_po_order_date',    table: 'purchase_orders',           cols: 'order_date',                  needs: ['order_date'],               serves: 'dash.trend_purchase' },
  // ---- 月度聚合：查询写 substr(col,1,7)=? ，只有表达式索引能被用上 ----
  { name: 'idx_so_month',         table: 'sales_orders',              cols: 'substr(order_date,1,7)',      needs: ['order_date'],               serves: 'dash.sales_month' },
  { name: 'idx_po_month',         table: 'purchase_orders',           cols: 'substr(order_date,1,7)',      needs: ['order_date'],               serves: 'dash.purchase_month' },
  { name: 'idx_oms_month',        table: 'oms_orders',                cols: 'substr(order_time,1,7)',      needs: ['order_time'],               serves: 'dash.oms_month' },
  { name: 'idx_sdel_month',       table: 'sales_deliveries',          cols: 'substr(delivery_date,1,7)',   needs: ['delivery_date'],            serves: 'rpt.sales_value' },
  { name: 'idx_prc_month',        table: 'purchase_receipts',         cols: 'substr(receipt_date,1,7)',    needs: ['receipt_date'],             serves: 'rpt.purchase_value' },
  { name: 'idx_it_type_month',    table: 'inventory_transactions',    cols: 'doc_type, substr(biz_date,1,7)', needs: ['doc_type', 'biz_date'],  serves: 'rpt.sales_cost' }
]
module.exports.INDEXES = INDEXES

const applicable = (db, ix) => tableExists(db, ix.table) && ix.needs.every((c) => hasColumn(db, ix.table, c))

module.exports.up = (db) => {
  for (const ix of INDEXES) {
    if (!applicable(db, ix)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.cols})`)
  }
}

module.exports.verify = (db) => INDEXES.every((ix) => !applicable(db, ix) || hasIndex(db, ix.name))
