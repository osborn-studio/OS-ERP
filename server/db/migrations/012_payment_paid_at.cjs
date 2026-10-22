'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/012_payment_paid_at.cjs ｜ 迁移：付款单实际付款时间 + 采购后段索引
 * ============================================================================
 * 【职责】迁移：付款单实际付款时间 + 采购后段索引
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 012 付款单「实际付款时间」+ 采购后段查询索引
//
// 背景（在 011 之上暴露出来的口径缺口）：
//   付款单状态机是 draft → approved → paid（→ voided）。
//   `approved` 是「审批通过、核销已生效」（用友口径：付款单审核即核销），
//   `paid` 是「出纳已把钱付出去」。两者金额口径相同，但**时间**不同 ——
//   财务对账要答的是「这笔钱哪天出的」，`approved_at` 答不了这个问题。
//   所以补一个 paid_at，只记实际付款执行时间。
//
// 为什么单独一个迁移而不是改 011：
//   011 已经在三库执行并记录了 schema_migrations，改已执行迁移的 DDL 不会重跑
//   （runner 只在结构自检失败时才 heal）。追加列必须走新迁移。
//
// 顺带补三个索引：应付账款看板与核销回写都是「按供应商 / 按结算单 / 按状态」查，
// 明细表会随付款单数量线性增长。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '付款单实际付款时间 + 采购后段索引'

const INDEXES = [
  // 核销回写：按结算单查明细（syncSettlePaid 每次都走这条）
  `CREATE INDEX IF NOT EXISTS idx_pay_items_settle ON purchase_payment_items (settle_id)`,
  // 应付看板：按供应商 + 状态筛未结清付款单
  `CREATE INDEX IF NOT EXISTS idx_payments_sup_status ON purchase_payments (supplier_id, status)`,
  // 可核销结算单：按供应商 + 状态 + 日期排序（planAllocation 的 FIFO 查询）
  `CREATE INDEX IF NOT EXISTS idx_settle_sup_status ON purchase_settlements (supplier_id, status, settle_date)`,
  // 结算明细 → 入库单反查订单（ordersOfSettlement）
  `CREATE INDEX IF NOT EXISTS idx_settle_items_source ON purchase_settlement_items (settle_id, source_type, source_id)`
]

module.exports.up = function up(db) {
  addColumn(db, 'purchase_payments', 'paid_at', 'TEXT')
  for (const sql of INDEXES) db.exec(sql)
  // 定义指纹：本迁移的「定义」就是索引清单（改了索引不违反任何结构不变量）
  stampDef(db, '012_payment_paid_at', { indexes: INDEXES, col: 'purchase_payments.paid_at' })
  return { columns: 1, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'purchase_payments')) return false
  if (!hasColumn(db, 'purchase_payments', 'paid_at')) return false
  for (const sql of INDEXES) {
    const m = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)
    if (m && !hasIndex(db, m[1])) return false
  }
  if (defStale(db, '012_payment_paid_at', { indexes: INDEXES, col: 'purchase_payments.paid_at' })) return false
  return true
}
