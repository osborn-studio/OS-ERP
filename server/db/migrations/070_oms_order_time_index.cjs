'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/070_oms_order_time_index.cjs ｜ 线上订单下单时间索引（roadmap-v9 AD3，ADR-0044 补充 3）
 * ============================================================================
 * 【职责】看板 `/channel` 与 `/trend` 的线上分支原先写成 `date(order_time) >= date('now','localtime','-N day')`：对列套函数，
 *   没有任何索引能用（`idx_oms_status` 以 status 开头、`idx_oms_month` 建在 substr(order_time,1,7) 上），整表读取并随 OMS 订单量线性增长。
 *   本迁移补一棵以 order_time 起头的**覆盖**索引，配合 `server/lib/dashboard-sql.js` 里加上的区间谓词
 *   `order_time >= ?`（日期由 JS 按本地日期算出）使用。依据与前后 EXPLAIN / 计时 / 写放大见 docs/implementation/capacity-baseline.md 的 AD3 一节。
 *
 * 【索引】
 *   · idx_oms_order_time  oms_orders(order_time, status, platform_id, pay_amount)：非 UNIQUE。
 *     为什么不是单列 (order_time)：单列索引每命中一行都要回表取 status / platform_id / pay_amount（随机读），窗口覆盖的行占比一高就比整表顺序扫描**更慢**
 *     （合成 20 万行：窗口含约 1/4 的行时 trend 约 70 → 108 ms，数据全在窗口内时 115 → 197 ms，见 capacity-baseline AD3 一节）；
 *     把两条看板查询读的列放进索引后走 COVERING INDEX，不回表，各窗口都不比整表扫描慢。仍是 order_time 起头，`o.order_time >= ?` 类区间查询同样可用。
 *
 * 【写放大（诚实边界）】oms_orders 每笔平台订单 / H5 商城订单落一行，多维护一棵 B 树（索引项 = 四列 + rowid，比单列大）；
 *   对合成表的实测见 capacity-baseline。已执行迁移不改（ADR-0009）。
 * 【迁移安全】只加非 UNIQUE 索引、IF NOT EXISTS、表或列缺失则跳过。大库上 CREATE INDEX 持写锁，耗时见 capacity-baseline。
 * 【改它要注意什么】INDEXES 是 up 与 verify 的唯一来源；改动后同步 scripts/explain-audit.mjs 的 expectIndex 并保持 tests/dashboard-perf.test.mjs 绿。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '线上订单下单时间索引（oms_orders.order_time）'

const INDEXES = [
  { name: 'idx_oms_order_time', table: 'oms_orders', cols: 'order_time, status, platform_id, pay_amount', needs: ['order_time', 'status', 'platform_id', 'pay_amount'], serves: 'dash.channel_online dash.trend_online' }
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
