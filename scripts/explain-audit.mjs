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
 *          [--snapshot plans.json | --compare plans.json]   (AG3：写出 / 比较计划指纹；--compare 同时跑"非测试代码不得执行统计收集语句"的源码扫描)
 *          [--analyze-scan]   (只跑上述源码扫描，不需要数据库 / GML_DATA_DIR)
 *          [--scale small|large] [--large-dir /abs/dir] [--small-snapshot plans.json]   (AH3：--scale large 在大合成库上跑同一套流程；大库现造（scripts/lib/explain-large.mjs）或用 --large-dir 复用
 *            夜间工作流里 synth-pipeline 留下的库；--snapshot --scale large 同时写 scale / dataset / differences，differences 由与 --small-snapshot（缺省为已提交的小库快照）的差异生成)
 *          [--fill-oms N] [--large-min t=n,…]   (--large-dir 的库没有 OMS 订单时：在它的隔离副本里补灌 N 个再比较（原库只读）；--scale large 要求 OMS 订单 / 流水 / SKU 达到最低门槛，--large-min 只供测试调低)
 *          [--compare small.json --compare-large large.json [--large-dir d]]   (小库、大库各比一次，再做两份快照的互查)
 *          [--compare small.json --cross-check large.json]   (小库比一次 + 两份快照互查，不需要大库——ci.yml 用这个)
 *   退出码：0 无违规；1 有违规；2 用法/安全拒绝（未显式给 GML_DATA_DIR、指向仓库 data/、输出落在仓库 data/ 内）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { buildWhere, orderOf, countSql, exportSql, AUDIT_COUNT_CAP } from '../server/lib/audit-view.js'
import { omsStatsByPlatformStmt, omsStatsTrendStmt, omsStatsTotalStmt, omsStatsTopSkusStmt, aiPlatformAnalysisStmt } from '../server/lib/oms-sql.js'
import { omsPlatformScopeSql, omsOrderScopeSql } from '../server/lib/sales-order.js'
import { fingerprintsFromAudit, buildSnapshot, compareSnapshot, diffSnapshots, crossCheckSnapshots } from './lib/explain-plan-guard.mjs'
import { LARGE_PROFILE, buildLargeDb, resolveLargeDir, datasetRows, largeShortfalls, copyAndFillOms, LARGE_MINIMUM } from './lib/explain-large.mjs'
import { scanTree } from './lib/analyze-scan.mjs'
import { onlineWindow, trendSalesSql, trendPurchaseSql, trendOnlineSql, topProductsSql, topBrandsSql, topDealersSql, topStoresSql, INVENTORY_DIST_AGG_SQL, channelOfflineSql, channelOnlineSql, RECENT_SQL } from '../server/lib/dashboard-sql.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_VERSION = 1
export const DEFAULT_THRESHOLD = 200

// 每条：id（唯一）、mirrors（镜像的 lib/路由）、bench（对应 bench-api 端点，可空）、sql、params
// SQL 与镜像处逐字一致；动态拼接的 WHERE 用"无过滤"的最常见形态，带过滤的形态单独声明。
/**
 * AA6 审计日志查看器（server/routes/meta.js GET /audit-logs、/audit-logs/export.csv）：SQL 文本由 server/lib/audit-view.js 的
 * buildWhere / orderOf / countSql / exportSql 生成——与路由是**同一份**，不是人工镜像，改过滤条件不会让这里漂移。
 * 每种过滤形态 × {列表页, 封顶计数, 导出后续批}；这些语句在没有迁移 065 时对 audit_logs 裸 SCAN（audit_logs 在 GROWTH_TABLES 里，不看行数）。
 */
function auditStatementsFor() {
  // 第三项 expectIndex：该形态**必须**走的索引（导出后续批在缺索引时会退化成 rowid 区间扫描 + 排序，EXPLAIN 里不是 SCAN，要显式断言）
  const shapes = [
    ['all', {}, null],
    ['module', { module: 'sales', from: '2026-10-01', to: '2026-10-31' }, 'idx_audit_module_created'],
    ['user', { user: '12', from: '2026-10-01' }, 'idx_audit_user_created'],
    ['entity', { entity: 'sales_orders', entity_id: '101' }, 'idx_audit_entity'],
    ['entity_only', { entity: 'sales_orders' }, null],
    ['module_keyword', { module: 'sales', keyword: 'ab' }, 'idx_audit_module_created'],
    ['keyword', { keyword: 'ab' }, null],
    // AB3：≥3 字符的关键词在有 FTS5 的构建上走 audit_logs_fts（迁移 067）；*_nofts 是没有 FTS5 的构建上的 LIKE 回退（豁免见 ALLOW）
    ['keyword_fts', { keyword: 'abc' }, null, { fts: true }],
    ['module_keyword_fts', { module: 'sales', keyword: 'abc' }, 'idx_audit_module_created', { fts: true }],
    ['keyword_nofts', { keyword: 'abc' }, null, { fts: false }],
    ['module_action', { module: 'sales', action: 'CREATE' }, 'idx_audit_module_created']
  ]
  const out = []
  for (const [name, f, expectIndex, bw = {}] of shapes) {
    const { where, args } = buildWhere(f, bw)
    const order = orderOf(f)
    const mirrors = 'server/routes/meta.js GET /audit-logs (server/lib/audit-view.js)'
    const needsTable = bw.fts ? 'audit_logs_fts' : undefined
    out.push({ id: `audit.list_${name}`, needsTable, mirrors, bench: null, expectIndex, params: [...args, 50, 0], sql: `SELECT * FROM audit_logs ${where} ORDER BY ${order.sql} LIMIT ? OFFSET ?` })
    out.push({ id: `audit.count_${name}`, needsTable, mirrors, bench: null, expectIndex, params: [...args, AUDIT_COUNT_CAP + 1], sql: countSql(where) })
    const ex = exportSql(where, order)
    out.push({ id: `audit.export_${name}`, needsTable, mirrors: 'server/routes/meta.js GET /audit-logs/export.csv (exportChunks)', bench: null, expectIndex,
      params: [...args, 1000000, ...(order.byTime ? ['2026-10-02 00:00:00', 7] : [7]), 1000], sql: ex.next })
  }
  return out
}

/** AE3：登记 oms-sql.js 的语句（全局 + 受限范围两种形态）。每条 { sql, params } 与路由同形。AF3：九条全部声明 idx_oms_order_time 的带约束 SEARCH，且没有任何 ALLOW 豁免。 */
function omsStatsAudit() {
  const out = []
  // AF3：全部九条都必须是 idx_oms_order_time 的带约束 SEARCH（AE3 时平台驱动 / 受限范围 / 明细驱动三类只守"无裸 SCAN"，现已改写 + 迁移 074 补齐）。
  // topSkus 另靠迁移 074 的 idx_oms_items_order：缺了它计划退化为 SCAN oms_order_items / 自动索引，在没有豁免的情况下直接违规
  const reg = (id, mirrors, st) => out.push({ id, mirrors, bench: null, expectIndex: 'idx_oms_order_time', expectSearch: true, sql: st.sql, params: st.params })
  const g = { ps: omsPlatformScopeSql({ scope: 'all' }, 'pf'), os: omsOrderScopeSql({ scope: 'all' }, 'o'), os0: omsOrderScopeSql({ scope: 'all' }, 'oms_orders') }
  const r = { ps: omsPlatformScopeSql({ orgIds: [1] }, 'pf'), os: omsOrderScopeSql({ orgIds: [1] }, 'o'), os0: omsOrderScopeSql({ orgIds: [1] }, 'oms_orders') }
  const M = 'server/routes/oms.js GET /stats (server/lib/oms-sql.js '
  reg('oms.stats_by_platform', `${M}omsStatsByPlatformStmt)`, omsStatsByPlatformStmt(30, g.ps))
  reg('oms.stats_by_platform_scoped', `${M}omsStatsByPlatformStmt, 受限组织范围)`, omsStatsByPlatformStmt(30, r.ps))
  reg('oms.stats_trend', `${M}omsStatsTrendStmt)`, omsStatsTrendStmt(30, g.os0))
  reg('oms.stats_trend_scoped', `${M}omsStatsTrendStmt, 受限组织范围)`, omsStatsTrendStmt(30, r.os0))
  reg('oms.stats_total', `${M}omsStatsTotalStmt)`, omsStatsTotalStmt(30, g.os0))
  reg('oms.stats_total_scoped', `${M}omsStatsTotalStmt, 受限组织范围)`, omsStatsTotalStmt(30, r.os0))
  reg('oms.stats_top_skus', `${M}omsStatsTopSkusStmt)`, omsStatsTopSkusStmt(30, g.os))
  reg('oms.stats_top_skus_scoped', `${M}omsStatsTopSkusStmt, 受限组织范围)`, omsStatsTopSkusStmt(30, r.os))
  reg('ai.platform_analysis', 'server/routes/ai.js POST /query#channel_compare (server/lib/oms-sql.js aiPlatformAnalysisStmt)', aiPlatformAnalysisStmt(30))
  return out
}

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
    sql: 'SELECT COALESCE(SUM(qty_on_hand),0) qty, COALESCE(SUM(qty_on_hand*cost_price),0) amount FROM inventory_stocks' },
  // AA5：COUNT(DISTINCT sku_id) 从上面的整表求和里拆出来，走 idx_stock_sku 覆盖索引（去重计数不再建临时 B 树、不扫宽表）
  { id: 'dash.stock_sku_count', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: 'SELECT COUNT(*) skus FROM (SELECT DISTINCT sku_id FROM inventory_stocks WHERE sku_id IS NOT NULL)' },
  { id: 'dash.todo_counts', mirrors: 'server/routes/dashboard.js summary', bench: 'dashboard_summary',
    sql: "SELECT (SELECT COUNT(*) FROM sales_orders WHERE status='confirmed') AS pending_delivery, (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('submitted','approved')) AS pending_receipt, (SELECT COUNT(*) FROM oms_orders WHERE status='pending') AS oms_pending, (SELECT COUNT(*) FROM inventory_stocks st WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date <> '' AND st.expire_date <= date('now','localtime','+90 day')) AS expiring, (SELECT COUNT(*) FROM dealers WHERE status='active' AND credit_limit>0 AND credit_used*1.0/credit_limit>=0.8) AS credit_alert" },
  // Z3：below_safe 计数与 Top 10 改走 server/lib/stock.js 的预聚合口径
  { id: 'dash.below_safe_count', mirrors: 'server/lib/stock.js countBelowSafe (server/routes/dashboard.js summary)', bench: 'dashboard_summary',
    sql: "SELECT COUNT(*) c FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0 AND COALESCE((SELECT SUM(st.qty_on_hand) FROM inventory_stocks st WHERE st.sku_id = sk.id),0) < sk.safe_stock" },
  { id: 'dash.stock_alerts', mirrors: 'server/lib/stock.js listBelowSafe (server/routes/dashboard.js stockAlerts)', bench: 'dashboard_summary', params: [10],
    sql: "SELECT x.sku_id, x.sku_code, x.sku_name, p.name AS product_name, x.safe_stock, x.q qty_on_hand, x.safe_stock - x.q shortage FROM (SELECT sk.id AS sku_id, sk.product_id, sk.sku_code, sk.name AS sku_name, sk.safe_stock, COALESCE((SELECT SUM(st.qty_on_hand) FROM inventory_stocks st WHERE st.sku_id = sk.id),0) q FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0) x JOIN products p ON p.id = x.product_id WHERE x.q < x.safe_stock ORDER BY shortage DESC, x.sku_id LIMIT ?" },
  // AD3：trend 三条的 SQL 文本直接取自 server/lib/dashboard-sql.js（路由执行的同一份，不再是人工镜像）；窗口取 /trend 默认 30 天。
  // online 声明 expectIndex（迁移 070 的 idx_oms_order_time）：缺索引时退化成整表 SCAN，由守卫报红。
  { id: 'dash.trend_sales', mirrors: 'server/routes/dashboard.js GET /trend (server/lib/dashboard-sql.js trendSalesSql)', bench: null, expectIndex: 'idx_so_order_date', expectSearch: true, sql: trendSalesSql(30) },
  { id: 'dash.trend_purchase', mirrors: 'server/routes/dashboard.js GET /trend (server/lib/dashboard-sql.js trendPurchaseSql)', bench: null, expectIndex: 'idx_po_order_date', expectSearch: true, sql: trendPurchaseSql(30) },
  { id: 'dash.trend_online', mirrors: 'server/routes/dashboard.js GET /trend (server/lib/dashboard-sql.js trendOnlineSql)', bench: null, expectIndex: 'idx_oms_order_time', expectSearch: true, params: onlineWindow(30), sql: trendOnlineSql() },
  // AC4：以下语句的 SQL 文本**直接取自** server/lib/dashboard-sql.js（路由 server/routes/dashboard.js 执行的就是这一份），不是人工镜像；
  // 窗口取各接口的默认值（/top 30 天、/channel 90 天）。AB2 的 /top 改成 CROSS JOIN 固定"先取窗口内订单再取明细"，所以声明 expectIndex。
  { id: 'dash.top_products', mirrors: 'server/routes/dashboard.js GET /top (server/lib/dashboard-sql.js topProductsSql)', bench: null, expectIndex: 'idx_so_order_date', sql: topProductsSql(30) },
  { id: 'dash.top_brands', mirrors: 'server/routes/dashboard.js GET /top (server/lib/dashboard-sql.js topBrandsSql)', bench: null, expectIndex: 'idx_so_order_date', sql: topBrandsSql(30) },
  { id: 'dash.top_dealers', mirrors: 'server/routes/dashboard.js GET /top (server/lib/dashboard-sql.js topDealersSql)', bench: null, expectIndex: 'idx_so_order_date', sql: topDealersSql(30) },
  { id: 'dash.top_stores', mirrors: 'server/routes/dashboard.js GET /top (server/lib/dashboard-sql.js topStoresSql)', bench: null, expectIndex: 'idx_so_order_date', sql: topStoresSql(30) },
  { id: 'dash.inventory_dist_agg', mirrors: 'server/routes/dashboard.js GET /inventory-dist (server/lib/dashboard-sql.js INVENTORY_DIST_AGG_SQL)', bench: null, sql: INVENTORY_DIST_AGG_SQL },
  { id: 'dash.channel_offline', mirrors: 'server/routes/dashboard.js GET /channel (server/lib/dashboard-sql.js channelOfflineSql)', bench: null, expectIndex: 'idx_so_order_date', sql: channelOfflineSql(90) },
  { id: 'dash.channel_online', mirrors: 'server/routes/dashboard.js GET /channel (server/lib/dashboard-sql.js channelOnlineSql)', bench: null, expectIndex: 'idx_oms_order_time', expectSearch: true, params: onlineWindow(90), sql: channelOnlineSql() },
  // AE3：OMS /stats 与 AI 平台分析的 SQL 取自 server/lib/oms-sql.js（路由执行的同一份）；窗口取 /stats 默认 30 天，全局范围（1=1）。
  // 受限组织范围另登记 *_scoped：范围谓词是 platform_id IN (子查询)，计划形态不同，也要守住 SEARCH idx_oms_order_time。
  ...omsStatsAudit(),
  { id: 'dash.recent_sales', mirrors: 'server/routes/dashboard.js GET /recent (server/lib/dashboard-sql.js RECENT_SQL.salesOrders)', bench: null, sql: RECENT_SQL.salesOrders },
  { id: 'dash.recent_purchase', mirrors: 'server/routes/dashboard.js GET /recent (server/lib/dashboard-sql.js RECENT_SQL.purchaseOrders)', bench: null, sql: RECENT_SQL.purchaseOrders },
  { id: 'dash.recent_oms', mirrors: 'server/routes/dashboard.js GET /recent (server/lib/dashboard-sql.js RECENT_SQL.omsOrders)', bench: null, sql: RECENT_SQL.omsOrders },
  { id: 'dash.recent_txn', mirrors: 'server/routes/dashboard.js GET /recent (server/lib/dashboard-sql.js RECENT_SQL.transactions)', bench: null, sql: RECENT_SQL.transactions },

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
  { id: 'stock.query_page', mirrors: 'server/routes/inventory.js GET /stocks (首页，无游标)', bench: 'stock_query', params: [51],
    sql: 'SELECT st.id, st.warehouse_id, st.sku_id, st.batch_no, st.produce_date, st.expire_date, st.entry_date, st.location, st.qty_on_hand, st.qty_reserved, (st.qty_on_hand - st.qty_reserved) AS qty_available, st.cost_price, (st.qty_on_hand * st.cost_price) AS amount, st.updated_at, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, sk.safe_stock, sk.serial_managed, p.name AS product_name, p.spu_code, p.unit, b.name AS brand_name, c.name AS category_name, w.name AS warehouse_name, w.type AS warehouse_type FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN products p ON p.id = sk.product_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 ORDER BY st.id LIMIT ?' },
  { id: 'stock.query_after', mirrors: 'server/routes/inventory.js GET /stocks?after_id=', bench: 'stock_query', params: [1000, 51],
    sql: 'SELECT st.id, st.qty_on_hand, sk.sku_code, w.name AS warehouse_name FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 AND st.id > ? ORDER BY st.id LIMIT ?' },
  { id: 'stock.query_total', mirrors: 'server/routes/inventory.js GET /stocks (total/summary，仅首页)', bench: 'stock_query',
    sql: 'SELECT COUNT(*) c, COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount FROM inventory_stocks st WHERE st.qty_on_hand <> 0' },
  { id: 'stock.query_by_sku', mirrors: 'server/routes/inventory.js GET /stocks?sku_id=', bench: 'stock_query', params: [1, 51],
    sql: 'SELECT st.id, st.qty_on_hand, sk.sku_code, w.name AS warehouse_name FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 AND st.sku_id = ? ORDER BY st.id LIMIT ?' },
  { id: 'stock.query_by_warehouse', mirrors: 'server/routes/inventory.js GET /stocks?warehouse_id=', bench: 'stock_query', params: [1, 51],
    sql: 'SELECT st.id, st.qty_on_hand, sk.sku_code, w.name AS warehouse_name FROM inventory_stocks st JOIN product_skus sk ON sk.id = st.sku_id JOIN warehouses w ON w.id = st.warehouse_id WHERE st.qty_on_hand <> 0 AND st.warehouse_id = ? ORDER BY st.id LIMIT ?' },
  { id: 'stock.expiring', mirrors: 'server/routes/inventory.js GET /alerts (临期)', bench: null,
    sql: "SELECT st.id, st.batch_no, st.expire_date, st.qty_on_hand, st.warehouse_id, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name, CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id WHERE st.qty_on_hand > 0 AND st.expire_date IS NOT NULL AND st.expire_date <> '' AND st.expire_date <= date('now','localtime','+180 day') ORDER BY st.expire_date LIMIT 100" },
  { id: 'stock.below_safe', mirrors: 'server/lib/stock.js listBelowSafe (server/routes/inventory.js GET /alerts)', bench: null, params: [50],
    sql: "SELECT x.sku_id, x.sku_code, x.sku_name, p.name AS product_name, x.safe_stock, x.q qty_on_hand, x.safe_stock - x.q shortage FROM (SELECT sk.id AS sku_id, sk.product_id, sk.sku_code, sk.name AS sku_name, sk.safe_stock, COALESCE((SELECT SUM(st.qty_on_hand) FROM inventory_stocks st WHERE st.sku_id = sk.id),0) q FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0) x JOIN products p ON p.id = x.product_id WHERE x.q < x.safe_stock ORDER BY shortage DESC, x.sku_id LIMIT ?" },
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

  ...auditStatementsFor(),

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
  'ar_documents', 'receipts', 'receipt_allocations', 'doc_events', 'doc_actions',
  'audit_logs'
])

const PAGE_REASON = '按主键倒序取最新一页（ORDER BY id DESC LIMIT n）：沿 rowid 反向扫描，取够 n 行即停，计划里没有排序临时表；不是全表读（无过滤条件，上界即 n 行）'
const PAGE_VOIDED_REASON = '按主键倒序取最新一页并过滤 status<>\'voided\'：沿 rowid 反向扫描，通常取够 n 行即停、无排序临时表；但若尾部有大段已作废单据会多读（否定式谓词无法建索引），读量上界是整表，属已知残余'
const AGG_REASON = '整表聚合且谓词是否定式/无谓词（status <> / NOT IN / 全量 SUM），几乎所有行都参与，索引无法缩小读取范围'
export const ALLOW = [
  { statement: 'po.list_page', table: 'purchase_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'po.receipt_list', table: 'purchase_receipts', noSort: true, reason: PAGE_REASON },
  { statement: 'po.invoice_list', table: 'purchase_invoices', noSort: true, reason: PAGE_VOIDED_REASON },
  { statement: 'po.settlement_list', table: 'purchase_settlements', noSort: true, reason: PAGE_VOIDED_REASON },
  { statement: 'po.payment_list', table: 'purchase_payments', noSort: true, reason: PAGE_VOIDED_REASON },
  { statement: 'ar.receipts_page', table: 'receipts', noSort: true, reason: PAGE_REASON },
  { statement: 'sales.list_page', table: 'sales_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'oc.orders_page', table: 'oc_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'stock.txn_page', table: 'inventory_transactions', noSort: true, reason: PAGE_REASON },
  { statement: 'audit.list_all', table: 'audit_logs', noSort: true, reason: PAGE_REASON },
  { statement: 'audit.count_keyword_nofts', table: 'audit_logs', reason: '没有 FTS5 的 SQLite 构建上迁移 067 是空操作，关键词回退到 LIKE \'%x%\' 子串匹配：无索引可用，LIMIT 10001 只在命中多时早停（AB3 回退路径，见 capacity-baseline）' },
  { statement: 'audit.list_keyword_nofts', table: 'audit_logs', noSort: true, reason: '同 audit.count_keyword_nofts：无 FTS5 构建的 LIKE 回退；按 id 倒序取够一页即停，命中稀少时读量上界是整表' },
  { statement: 'audit.count_keyword', table: 'audit_logs', reason: '关键词是 LIKE \'%x%\' 子串匹配（action/entity/user_name），没有可用索引；LIMIT 10001 只在命中多时早停，命中稀少时仍读全表——已知残余，靠最少 2 字符与组合 module/user 过滤收敛' },
  { statement: 'audit.list_entity_only', table: 'audit_logs', noSort: true, reason: '仅按 entity 类型（几十种、每种命中很多行）：用 `+entity` 屏蔽 idx_audit_entity，避免对全部命中行临时排序；沿 rowid 倒扫凑够一页即停。命中稀少的类型会读到整表——已知残余（见 capacity-baseline AA6）' },
  { statement: 'audit.list_keyword', table: 'audit_logs', noSort: true, reason: '同 audit.count_keyword（2 字关键词 trigram 无法匹配，FTS 不适用）：子串匹配无法建索引；按 id 倒序取够一页即停，命中稀少时读量上界是整表' },
  // AC4：/recent 四条都是"按主键倒序取最新 8 条"，无过滤条件，上界即 8 行
  { statement: 'dash.recent_sales', table: 'sales_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'dash.recent_purchase', table: 'purchase_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'dash.recent_oms', table: 'oms_orders', noSort: true, reason: PAGE_REASON },
  { statement: 'dash.recent_txn', table: 'inventory_transactions', noSort: true, reason: PAGE_REASON },
  // AF3：oms.stats_top_skus(_scoped) 的豁免已移除——迁移 074 补 idx_oms_items_order 后，订单窗口驱动、按订单号取明细，不再整表 SCAN oms_order_items（ADR-0044 补充 5）
  // AD3：/channel 线上渠道的豁免已移除——谓词改成 order_time >= ?，走 idx_oms_order_time（迁移 070），由 expectIndex 守卫
  { statement: 'dash.sales_unpaid', table: 'sales_orders', reason: AGG_REASON },
  { statement: 'dash.stock_total', table: 'inventory_stocks', reason: '整表聚合（SUM 全库存），没有谓词；索引只能做覆盖扫描，不改变量级；AA5 起由看板 30 s 缓存吸收重复读取' },
  { statement: 'rpt.stock_value', table: 'inventory_stocks', reason: '整表聚合库存金额，没有谓词' },
  { statement: 'rpt.ar_open', table: 'ar_documents', reason: AGG_REASON },
  { statement: 'rpt.ap_open', table: 'purchase_settlements', reason: AGG_REASON },
  { statement: 'stock.query_page', table: 'inventory_stocks', noSort: true, reason: '首页无游标：沿 rowid 升序取够 pageSize+1 行即停（ORDER BY st.id LIMIT n，计划里无排序临时表）；qty_on_hand<>0 极少过滤，所以读量约等于 n 行；若头部有大段零库存行会多读，属已知残余' },
  { statement: 'stock.query_total', table: 'inventory_stocks', reason: 'total/summary 是满足条件的全部库存行上的 COUNT/SUM，本质整表聚合；Z3 起只在首页（无 after_id）执行一次，翻页不再付这个代价' }
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

/** EXPLAIN QUERY PLAN 行（id / parent / detail）→ 每行的嵌套深度（给 AG3 计划指纹用） */
function planDepths(rows) {
  const depth = new Map([[0, -1]])
  return rows.map(r => { const d = (depth.get(r.parent) ?? -1) + 1; depth.set(r.id, d); return d })
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
    // 语句依赖的可选表不存在（如没有 FTS5 的构建上迁移 067 是空操作）：不审计、不报错，在结果里标 skipped；回退路径由 *_nofts 语句覆盖
    if (s.needsTable && !tables.has(s.needsTable)) { out.push({ id: s.id, mirrors: s.mirrors, bench: s.bench ?? null, plan: [], scans: [], skipped: `缺少 ${s.needsTable}` }); continue }
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
    // AF3：计划里 `MATERIALIZE w` / `CO-ROUTINE w` 声明的名字是派生表（子查询 / CTE）的物化结果，不是可建索引的真实表；
    // 在它上面自建的自动索引没有"补真实索引"这个解法（它的内容就是每次查询现算的聚合），这里不算缺索引。
    // 产生它的那次读取（派生表内部对真实表的 SEARCH / SCAN）仍是计划里的独立行，照常被上面的规则判定。
    const derived = new Set(plan.map(d => /^(?:MATERIALIZE|CO-ROUTINE) (\S+)/.exec(d)?.[1]).filter(Boolean))
    // SQLite 在运行时为连接临时造的"自动索引"= 它认为这里缺索引；每次查询都重建一遍
    for (const detail of plan) {
      const m = /^SEARCH (\S+) USING AUTOMATIC (?:PARTIAL )?(?:COVERING )?INDEX/.exec(detail)
      // 同名保护（Codex 审计）：别名若在 SQL 里同时是某真实表的别名（如另一分支的 `LEFT JOIN fact w`），就不能因为别处有 `MATERIALIZE w` 而放过
      if (!m || (derived.has(m[1]) && !tables.has(aliases.get(m[1]) ?? ''))) continue
      const table = aliases.get(m[1]) ?? m[1]
      const hit = allow.find(a => a.statement === s.id && a.table === table)
      const entry = { detail, table, kind: 'automatic_index', rows: tables.has(table) ? rowsOf(table) : null }
      if (hit) { entry.status = 'allowed'; entry.reason = hit.reason; used.add(hit) } else { entry.status = 'violation'; violations.push({ statement: s.id, table, rows: entry.rows, detail, reason: 'SQLite 运行时自建自动索引：缺真实索引' }) }
      scans.push(entry)
    }
    // 语句声明了必须走的索引（expectIndex）：计划里没有它就是违规（缺索引时的退化形态不一定是裸 SCAN，如 rowid 区间扫描 + 临时排序）
    if (s.expectIndex && !plan.some(d => d.includes(s.expectIndex))) {
      const table = [...aliasMap(s.sql).values()][0] ?? '?'
      violations.push({ statement: s.id, table, detail: plan.join(' | '), reason: `计划未使用声明的索引 ${s.expectIndex}` })
    }
    // expectSearch（AD3，Codex 审计）：除了"用了这个索引"，还必须是带范围 / 等值约束的 SEARCH（`SEARCH … USING [COVERING] INDEX <idx> (col>?)`），
    // 而不是对该索引的整条 SCAN——否则去掉区间谓词后计划退化成"覆盖索引全扫"，expectIndex 仍然绿
    // Codex 审计：另一处不相干的 SEARCH 不能替主聚合"担保"——计划里只要还有对该索引的整条 SCAN（`SCAN x USING [COVERING] INDEX <idx>`），就不算满足
    const fullIndexScan = s.expectSearch && s.expectIndex && plan.some(d => d.startsWith('SCAN ') && d.includes(` INDEX ${s.expectIndex}`))
    if (s.expectSearch && s.expectIndex && plan.some(d => d.includes(s.expectIndex)) &&
        (fullIndexScan || !plan.some(d => d.startsWith('SEARCH ') && d.includes(` INDEX ${s.expectIndex} (`)))) {
      const table = [...aliasMap(s.sql).values()][0] ?? '?'
      violations.push({ statement: s.id, table, detail: plan.join(' | '), reason: `计划用了 ${s.expectIndex} 但不是带约束的 SEARCH，或同一索引另有整条索引扫描（索引全扫，区间谓词失效）` })
    }
    out.push({ id: s.id, mirrors: s.mirrors, bench: s.bench ?? null, plan, depths: planDepths(rows), scans })
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

/** 快照由哪条命令生成（CI 用同一形状复现；写进快照，也写在 docs/operations/query-planner.md） */
export const SNAPSHOT_GENERATOR = 'node scripts/synth-data.mjs (default small profile: 60 skus / 600 txns / 120 docs, seed 20261023) with GML_RUNTIME_MODE=production, then node scripts/explain-audit.mjs --snapshot docs/implementation/explain-plans.json'

function runAnalyzeScan() {
  const r = scanTree(ROOT)
  for (const h of r.hits) console.error(`  ✗ ${h.file}:${h.line} 非测试代码执行了统计收集语句（${h.rule}）；应用不得改变查询规划器的前提，见 docs/operations/query-planner.md`)
  for (const a of r.staleAllow) console.error(`  ✗ 过期的统计语句扫描豁免: ${a.file}`)
  console.log(`explain-audit: 统计语句源码扫描 ${r.filesScanned} 个文件, 命中 ${r.hits.length}`)
  if (!r.ok) refuse(`源码里有 ${r.hits.length} 处统计语句 / ${r.staleAllow.length} 条过期豁免`, 1)
}

/** 大库快照的生成命令（写进快照；与 docs/operations/query-planner.md 2e 一致） */
export const LARGE_SNAPSHOT_GENERATOR = `node scripts/explain-audit.mjs --snapshot docs/implementation/explain-plans.large.json --scale large (builds the AH3 large profile: ${LARGE_PROFILE.skus} SKU / ${LARGE_PROFILE.docs} docs / ${LARGE_PROFILE.txns} txns via scripts/synth-data.mjs with GML_RUNTIME_MODE=production, seed ${LARGE_PROFILE.seed}, plus ${LARGE_PROFILE.oms_orders} OMS orders in a ${LARGE_PROFILE.oms_span_days}-day dense window; or reuses --large-dir)`
const DEFAULT_SMALL_SNAPSHOT = path.join(ROOT, 'docs/implementation/explain-plans.json')

const readSnapshot = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { refuse(`快照无法解析: ${e.message}`) }
}

/**
 * 对一个库跑完整个流程：审计 → 可选 --out → 可选 --snapshot → 可选 --compare。
 * job：{ scale, file, label, outFile, snapshotFile, compareFile, smallSnapshotFile, reused }
 */
function runJob(job, o) {
  const { scale, file, label } = job
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get()?.id ?? null
    const result = auditStatements(db, STATEMENTS, { threshold: o.threshold })
    const report = {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      scope_notice: scale === 'large'
        ? 'Large synthetic database (AH3): audit of the declared statements with row-count thresholds applied to realistic table sizes. Still synthetic data on a development host, not a production-scale or target-host plan check.'
        : 'Fixture-scale audit of the declared statements on a demo/test database copy. Not a production-scale plan check.',
      scale,
      db: path.basename(file), latest_migration: applied, threshold: o.threshold,
      statements_checked: result.statements.length, violations: result.violations, unused_allow: result.unusedAllow, statements: result.statements
    }
    if (job.outFile) fs.writeFileSync(job.outFile, JSON.stringify(report, null, 2) + '\n')
    const scans = result.statements.flatMap(s => s.scans)
    console.log(`explain-audit${label}: ${result.statements.length} 条语句, 迁移 ${applied}, 阈值 ${o.threshold} 行; 裸 SCAN ${scans.filter(s => s.kind === 'table').length} (违规 ${result.violations.length}, 豁免 ${scans.filter(s => s.status === 'allowed').length}, 小表 ${scans.filter(s => s.status === 'below_threshold').length}), 索引全扫 ${scans.filter(s => s.kind === 'index').length}${job.outFile ? ` -> ${job.outFile}` : ''}`)
    for (const v of result.violations) console.error(`  ✗ ${label.trim() || 'small'} ${v.statement}: ${v.detail} (${v.table}${v.rows != null ? `, ${v.rows} 行` : ''})`)
    for (const a of result.unusedAllow) console.error(`  ✗ 过期豁免（计划里已没有这处 SCAN，请删掉）: ${a.statement} × ${a.table}`)
    if (!result.ok) refuse(`${label.trim() || '小库'}：${result.violations.length} 处违规, ${result.unusedAllow.length} 条过期豁免`, 1)
    const fingerprints = fingerprintsFromAudit(result.statements)
    const sqliteVersion = db.prepare('select sqlite_version() v').get().v
    const hasStat1 = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get()
    const tableRows = datasetRows(db)
    if (scale === 'large') {
      // Codex 审计（AH3）：空 OMS 表上的"大库"比较会是绿灯却什么都没证明——数据集不够大就拒绝（退出码 2）
      const short = largeShortfalls(tableRows, o.largeMinimum)
      if (short.length) refuse(`这个库不够"大"（${short.join('；')}）；用 --large-dir 指向大库，或加 --fill-oms N 在隔离副本里补灌 OMS 订单`)
    }
    let needExplanation = []
    if (job.snapshotFile) {
      if (hasStat1) refuse(`${label.trim() || '小库'}里存在 sqlite_stat1（执行过统计收集），统计信息会改变计划，不能固化成快照`)
      // 违规状态不得固化为基线（上面 refuse 已保证 result.ok）
      let extra = {}
      if (scale === 'large') {
        const small = readSnapshot(job.smallSnapshotFile)
        let previous = []
        try { previous = JSON.parse(fs.readFileSync(job.snapshotFile, 'utf8')).differences ?? [] } catch { /* 首次生成 */ }
        const draft = buildSnapshot({ fingerprints, latestMigration: applied, sqliteVersion, generator: LARGE_SNAPSHOT_GENERATOR })
        const differences = diffSnapshots(small, draft, previous)
        needExplanation = differences.filter(d => !d.explanation)
        extra = { scale: 'large', dataset: { profile: job.reused ? 'reused (--large-dir)' : { ...LARGE_PROFILE }, table_rows: tableRows }, differences }
      }
      const snap = buildSnapshot({ fingerprints, latestMigration: applied, sqliteVersion, generator: scale === 'large' ? LARGE_SNAPSHOT_GENERATOR : SNAPSHOT_GENERATOR, extra })
      fs.writeFileSync(job.snapshotFile, JSON.stringify(snap, null, 2) + '\n')
      console.log(`explain-audit${label}: 计划指纹快照 ${Object.keys(snap.statements).length} 条 -> ${job.snapshotFile}`)
      for (const d of needExplanation) console.error(`  ✗ 大库与小库计划不同的语句需要写一句说明（differences[].explanation，再抄进 docs/operations/query-planner.md 2e）: ${d.statement} (${d.small_hash} -> ${d.large_hash})`)
    }
    let cmpOk = true
    if (job.compareFile) {
      const snap = readSnapshot(job.compareFile)
      if ((snap.scale ?? 'small') !== scale) refuse(`快照 scale 是 ${snap.scale ?? 'small'}，本次比较的是 ${scale}（小库快照用 --scale small，大库快照用 --scale large）`)
      let cmp
      try { cmp = compareSnapshot(snap, { fingerprints, latestMigration: applied, sqliteVersion, hasStat1 }) } catch (e) { refuse(`计划快照比较失败: ${e.message}`) }
      for (const n of cmp.notes) console.log(`  note${label}: ${n}`)
      for (const d of cmp.drifts) {
        if (d.whitelisted) { console.log(`  ~ 计划漂移已列入白名单${label}: ${d.statement} (${d.kind}, ${d.afterHash})`); continue }
        console.error(`  ✗ 计划漂移 ${d.statement} (${d.kind}${label}) ${d.beforeHash ?? '-'} -> ${d.afterHash}${d.note ? `  ${d.note}` : ''}`)
        for (const l of d.before) console.error(`      - ${l}`)
        for (const l of d.after) console.error(`      + ${l}`)
      }
      for (const w of cmp.staleWhitelist) console.error(`  ✗ 过期白名单条目（该语句没有漂移，请删掉）${label}: ${w.statement}`)
      const drifted = cmp.drifts.filter(d => !d.whitelisted).length
      console.log(`explain-audit${label}: 计划指纹比较 ${Object.keys(fingerprints).length} 条, 漂移 ${drifted} (白名单 ${cmp.drifts.length - drifted}), 过期白名单 ${cmp.staleWhitelist.length}`)
      cmpOk = cmp.ok
      job.failMessage = `${label.trim() || '小库'}：计划漂移 ${drifted} 处, 过期白名单 ${cmp.staleWhitelist.length} 条；有意为之请重取快照（--snapshot）或在快照 whitelist 里写 accepted_hash + 理由`
    }
    return { result, ok: cmpOk && needExplanation.length === 0, failMessage: needExplanation.length ? `${needExplanation.length} 条差异缺说明` : job.failMessage }
  } finally { db.close() }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = { industry: 'cosmetic', threshold: DEFAULT_THRESHOLD, out: null, snapshot: null, compare: null, scanOnly: false, scale: 'small', largeDir: null, compareLarge: null, crossCheck: null, smallSnapshot: null, fillOms: null, largeMin: null }
  const map = { '--industry': 'industry', '--threshold': 'threshold', '--out': 'out', '--snapshot': 'snapshot', '--compare': 'compare', '--scale': 'scale', '--large-dir': 'largeDir', '--compare-large': 'compareLarge', '--cross-check': 'crossCheck', '--small-snapshot': 'smallSnapshot', '--fill-oms': 'fillOms', '--large-min': 'largeMin' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--analyze-scan') { o.scanOnly = true; continue }
    const k = map[argv[i]]
    if (!k || argv[i + 1] === undefined) refuse(`未知或缺值参数 ${argv[i]}`)
    o[k] = argv[++i]
  }
  if (o.snapshot && o.compare) refuse('--snapshot 与 --compare 不能同时使用')
  if (o.scanOnly) { runAnalyzeScan(); return { ok: true } }
  if (!['small', 'large'].includes(o.scale)) refuse('--scale 只接受 small / large')
  if (o.largeDir && o.scale !== 'large' && !o.compareLarge) refuse('--large-dir 只与 --scale large 或 --compare-large 一起使用')
  if ((o.compareLarge || o.crossCheck) && !o.compare) refuse('--compare-large / --cross-check 需要同时给 --compare <小库快照>')
  if ((o.compareLarge || o.crossCheck) && o.scale !== 'small') refuse('--compare-large / --cross-check 与 --scale large 不能同时使用（--scale large 单独比较大库）')
  if (o.compareLarge && o.crossCheck) refuse('--compare-large 已包含互查；不要同时给 --cross-check')
  if (o.smallSnapshot && !(o.scale === 'large' && o.snapshot)) refuse('--small-snapshot 只与 --scale large --snapshot 一起使用')
  if (o.fillOms !== null) {
    o.fillOms = Number(o.fillOms)
    if (!Number.isInteger(o.fillOms) || o.fillOms < 1) refuse('--fill-oms 必须是正整数')
  }
  o.largeMinimum = {}
  if (o.largeMin !== null) { // 仅供测试用小库演练：table=n[,table=n]
    for (const part of String(o.largeMin).split(',')) {
      const m = /^([a-z_]+)=(\d+)$/.exec(part)
      if (!m || !(m[1] in LARGE_MINIMUM)) refuse(`--large-min 形如 oms_orders=100,inventory_transactions=0（可用表：${Object.keys(LARGE_MINIMUM).join(' / ')}）`)
      o.largeMinimum[m[1]] = Number(m[2])
    }
  }
  if (o.fillOms !== null && !o.largeDir) refuse('--fill-oms 只与 --large-dir 一起使用（在它的隔离副本里补灌；现造的大库已含 OMS 订单）')
  if (o.fillOms !== null && o.snapshot) refuse('--fill-oms 不用于 --snapshot（快照应取自完整的大库）')
  o.threshold = Number(o.threshold)
  if (!Number.isInteger(o.threshold) || o.threshold < 1) refuse('threshold 必须是正整数')
  if (!/^[a-z]+$/.test(o.industry)) refuse('industry 非法')
  const checkOut = (p) => {
    const f = path.resolve(p)
    if (withinRepoData(path.dirname(f)) || withinRepoData(f)) refuse('输出文件不得位于仓库 data/ 内')
    try { if (fs.lstatSync(f).isSymbolicLink()) refuse('输出文件是符号链接') } catch (e) { if (e.exitCode) throw e }
    return f
  }
  const outFile = o.out ? checkOut(o.out) : null
  const snapshotFile = o.snapshot ? checkOut(o.snapshot) : null
  const compareFile = o.compare ? path.resolve(o.compare) : null
  if (compareFile && !fs.existsSync(compareFile)) refuse(`找不到快照 ${compareFile}`)
  const compareLargeFile = o.compareLarge ? path.resolve(o.compareLarge) : null
  if (compareLargeFile && !fs.existsSync(compareLargeFile)) refuse(`找不到快照 ${compareLargeFile}`)
  const crossCheckFile = o.crossCheck ? path.resolve(o.crossCheck) : null
  if (crossCheckFile && !fs.existsSync(crossCheckFile)) refuse(`找不到快照 ${crossCheckFile}`)
  const smallSnapshotFile = path.resolve(o.smallSnapshot ?? DEFAULT_SMALL_SNAPSHOT)
  if (o.scale === 'large' && snapshotFile && !fs.existsSync(smallSnapshotFile)) refuse(`找不到小库快照 ${smallSnapshotFile}（--small-snapshot）`)

  const cleanups = []
  /** 大库：--large-dir 复用，否则现造（造完在 finally 里删） */
  const largeDb = async () => {
    if (o.largeDir) {
      let file
      try { file = resolveLargeDir(o.largeDir, o.industry) } catch (e) { refuse(e.message) }
      if (o.fillOms) {
        const copy = await copyAndFillOms(file, { rows: o.fillOms, log: (m) => console.log(`explain-audit: ${m}`) })
        cleanups.push(copy.cleanup)
        return { file: copy.file, reused: true }
      }
      return { file, reused: true }
    }
    if (o.industry !== 'cosmetic') refuse('现造大库只支持 cosmetic（其它行业请用 --large-dir 复用）')
    const built = buildLargeDb({ log: (m) => console.log(`explain-audit: ${m}`) })
    cleanups.push(built.cleanup)
    return { file: built.file, reused: false }
  }
  try {
    const jobs = []
    if (o.scale === 'small') {
      if (!env.GML_DATA_DIR || !path.isAbsolute(env.GML_DATA_DIR)) refuse('必须显式设置绝对路径 GML_DATA_DIR（隔离的种子库副本）')
      if (withinRepoData(env.GML_DATA_DIR)) refuse('GML_DATA_DIR 位于仓库 data/ 之内；请使用独立副本')
      const file = path.join(env.GML_DATA_DIR, `gml_${o.industry}.db`)
      if (!fs.existsSync(file)) refuse(`找不到种子库 ${file}`)
      if (fs.lstatSync(file).isSymbolicLink()) refuse('库文件是符号链接')
      jobs.push({ scale: 'small', file, label: '', outFile, snapshotFile, compareFile })
    } else {
      const big = await largeDb()
      jobs.push({ scale: 'large', file: big.file, reused: big.reused, label: ' (大库)', outFile, snapshotFile, compareFile, smallSnapshotFile })
    }
    if (compareLargeFile) {
      const big = await largeDb()
      jobs.push({ scale: 'large', file: big.file, reused: big.reused, label: ' (大库)', compareFile: compareLargeFile })
    }
    let first = null
    const failures = []
    for (const job of jobs) {
      const r = runJob(job, o)
      first ??= r.result
      if (!r.ok) failures.push(r.failMessage)
    }
    // 两份快照互查（纯文件）：--compare 的小库快照 vs 大库快照
    const otherFile = compareLargeFile || crossCheckFile
    if (otherFile) {
      const small = readSnapshot(compareFile)
      const large = readSnapshot(otherFile)
      let x
      try { x = crossCheckSnapshots(small, large) } catch (e) { refuse(`快照互查失败: ${e.message}`) }
      if ((large.scale ?? 'small') !== 'large') x.problems.push('--compare-large / --cross-check 的文件不是大库快照（scale 应为 large）')
      for (const p of x.problems) console.error(`  ✗ 快照互查: ${p}`)
      console.log(`explain-audit: 小库 / 大库快照互查, 计划不同的语句 ${x.differing.length} (已登记 ${(large.differences ?? []).length}), 问题 ${x.problems.length}`)
      if (x.problems.length) failures.push(`两份快照不一致 ${x.problems.length} 处`)
    }
    if (compareFile || compareLargeFile) runAnalyzeScan()
    if (failures.length) refuse(failures.join('；'), 1)
    return first
  } finally { for (const c of cleanups) c() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { if (!e.exitCode) console.error(e); else if (e.exitCode === 2) console.error(`explain-audit: ${e.message}`); process.exit(e.exitCode ?? 1) })
}
