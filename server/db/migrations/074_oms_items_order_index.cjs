'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/074_oms_items_order_index.cjs ｜ 线上订单明细按订单号索引（roadmap-v11 AF3，ADR-0044 补充 5）
 * ============================================================================
 * 【职责】`oms_order_items.oms_order_id` 一直没有索引：`/stats` 的热销 Top10 是 `oms_order_items JOIN oms_orders`，
 *   规划器只能整表 SCAN 明细表再按主键取订单（明细表随订单线性增长，AE3 里是书面豁免的"已知残余"）。
 *   本迁移补 `idx_oms_items_order(oms_order_id)`，让规划器改成"订单窗口（idx_oms_order_time 的区间 SEARCH）驱动 → 按订单号取明细"。
 *   外键 `ON DELETE CASCADE` 删订单时找明细行也走它（此前每删一笔订单扫一遍明细表）。依据、前后 EXPLAIN / 计时 / 写放大见 capacity-baseline 的 AF3 一节。
 *
 * 【索引】
 *   · idx_oms_items_order  oms_order_items(oms_order_id)：非 UNIQUE（一单多行）。
 *     为什么是单列而不是 (oms_order_id, title, qty, amount) 覆盖：基准里覆盖版与单列版的热销查询在噪声内持平，
 *     覆盖版把商品标题（真实数据里较长）整份复制进索引，写放大和体积都更大；单列索引每行只多一个整数键。
 *   另一个被评估并**否决**的方案是 oms_orders(platform_id, order_time, …)：见 ADR-0044 补充 5 与 capacity-baseline（受限范围语句改用 SQL 提示即可走时间索引，不值得给热写表再加一棵 B 树）。
 *
 * 【写放大（诚实边界）】每个订单行多维护一棵 B 树（键 = oms_order_id + rowid），实测见 capacity-baseline。已执行迁移不改（ADR-0009）。
 * 【迁移安全】只加非 UNIQUE 索引、IF NOT EXISTS、表或列缺失则跳过；同名但定义不对（手工建过）则删掉重建（名字归本迁移所有）。大库上 CREATE INDEX 持写锁，耗时见 capacity-baseline。
 * 【改它要注意什么】INDEXES 是 up 与 verify 的唯一来源；改动后同步 scripts/explain-audit.mjs（`oms.stats_top_skus*` 无豁免）并保持 tests/oms-sql.test.mjs 绿。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '线上订单明细按订单号索引（oms_order_items.oms_order_id）'

const INDEXES = [
  { name: 'idx_oms_items_order', table: 'oms_order_items', cols: 'oms_order_id', needs: ['oms_order_id'], serves: 'oms.stats_top_skus oms.stats_top_skus_scoped' }
]
module.exports.INDEXES = INDEXES

const applicable = (db, ix) => tableExists(db, ix.table) && ix.needs.every((c) => hasColumn(db, ix.table, c))

/** 同名索引的定义是否就是 INDEXES 里写的：所属表、有序键列、非 UNIQUE、非局部（同 070 的 Codex 审计结论） */
function definitionOk(db, ix) {
  const row = db.prepare(`PRAGMA index_list(${ix.table})`).all().find((r) => r.name === ix.name)
  if (!row || row.unique || row.partial) return false
  const keys = db.prepare(`PRAGMA index_xinfo(${ix.name})`).all().filter((c) => c.key).map((c) => c.name)
  return keys.join(',') === ix.cols.split(',').map((c) => c.trim()).join(',')
}

module.exports.up = (db) => {
  for (const ix of INDEXES) {
    if (!applicable(db, ix)) continue
    if (hasIndex(db, ix.name) && !definitionOk(db, ix)) db.exec(`DROP INDEX ${ix.name}`)
    db.exec(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.cols})`)
  }
}

module.exports.verify = (db) => INDEXES.every((ix) => !applicable(db, ix) || (hasIndex(db, ix.name) && definitionOk(db, ix)))
