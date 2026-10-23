'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/061_hot_query_indexes.cjs ｜ 大库热点查询补索引：低库存预警、看板待办计数（roadmap-v5 Z3）
 * ============================================================================
 * 【职责】Y10 在合成 medium/large 库（2 万 SKU）上发现 3 处夹具规模下看不见的全表扫描：
 *   `dash.todo_counts` 扫 product_skus 与 dealers、`stock.below_safe` 扫 product_skus。本迁移补对应索引，
 *   explain-audit 的语句同步改写后这三处变为 SEARCH。
 *
 * 【索引与依据（EXPLAIN 见 docs/implementation/capacity-baseline.md Z3 一节）】
 *   · idx_sku_status_safe  product_skus(status, safe_stock)：谓词 status='active' AND safe_stock>0 变成范围搜索，不再扫全表。
 *   · idx_dealers_status_credit  dealers(status, credit_limit)：谓词 status='active' AND credit_limit>0。经销商表不大
 *     （千行级），收益是量级保证而不是毫秒；比值谓词 credit_used/credit_limit 本身无法建索引，仍在范围内逐行算。
 *   · idx_stock_sku_qty  inventory_stocks(sku_id, qty_on_hand)：覆盖索引。库存按 SKU 汇总（SUM(qty_on_hand) GROUP BY sku_id、
 *     相关子查询）只读索引、不回表。idx_stock_sku（059）是它的前缀，因 059 的 verify 仍要求其存在而保留。
 *
 * 【为什么这样设计】同 059：只加非 UNIQUE 索引、IF NOT EXISTS、表或列缺失则跳过；已执行迁移不改（ADR-0009）。
 *   写放大：inventory_stocks 多一棵 B 树（每次库存变动更新 qty_on_hand 时多维护一个索引项），product_skus/dealers 写入少。
 *
 * 【改它要注意什么】INDEXES 是 up 与 verify 的唯一来源；改动后同步 scripts/explain-audit.mjs 并保持 tests/hot-queries.test.mjs 绿。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '大库热点查询索引（低库存预警 / 看板待办计数）'

const INDEXES = [
  { name: 'idx_sku_status_safe',       table: 'product_skus',     cols: 'status, safe_stock',    needs: ['status', 'safe_stock'],      serves: 'dash.todo_counts stock.below_safe dash.stock_alerts' },
  { name: 'idx_dealers_status_credit', table: 'dealers',          cols: 'status, credit_limit',  needs: ['status', 'credit_limit'],    serves: 'dash.todo_counts' },
  { name: 'idx_stock_sku_qty',         table: 'inventory_stocks', cols: 'sku_id, qty_on_hand',   needs: ['sku_id', 'qty_on_hand'],     serves: 'dash.todo_counts stock.below_safe dash.stock_alerts' }
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
