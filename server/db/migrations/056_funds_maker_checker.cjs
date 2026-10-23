'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/056_funds_maker_checker.cjs ｜ 收付款的证据与二人复核列 + 复核权限点（ADR-0018）
 * ============================================================================
 * 【为什么】审阅报告 F10：系统没有真实支付网关，收款 / 付款是后台人工登记的。人工登记要站得住，
 *   必须有两样东西：**证据**（银行流水号 / 凭证号）和**第二个人**（发起人之外的复核）。
 *   本迁移只补"落点"：
 *     · `receipts` / `purchase_payments` 各加 `evidence_ref` / `evidence_note`（证据）
 *       与 `review_*`（复核状态、发起人、复核人、时间、意见）；
 *     · 权限点 `finance.funds.review`（资金收付复核），默认授予 admin / finance 两个内置角色。
 *   单据内核的状态机（008 的 doc_states / doc_actions）**不改**：008 已执行、受校验和保护（ADR-0009），
 *   且"待复核"不是一个有业务后果的流转 —— 它只是"确认动作被挂起"。所以用独立的 `review_status` 列承载，
 *   内核 `status` 在待复核期间保持原状（收款单 draft / 付款单 approved），钱与额度一分不动。
 * 【ADR-0007 口径】`verify()` 只查列与权限字典是否存在，**不**查角色授权集合 —— 管理员削减授权是策略，
 *   不是损坏，正常重启不得重授。
 * 【编号】055 已被 Agent Token 吊销原因占用，本迁移用 056；运行器按文件名排序，不要求连续。
 * ============================================================================
 */
const { addColumn, hasColumn, tableExists } = require('./_helpers.cjs')

module.exports.name = '收付款证据与二人复核（evidence_* / review_* 列 + finance.funds.review 权限点）'

const TABLES = ['receipts', 'purchase_payments']

/** 两张表同一组列：证据两列 + 复核七列（列名与 `lib/funds-review.js` 的读写点同一份） */
const COLUMNS = [
  ['evidence_ref', 'TEXT'],
  ['evidence_note', 'TEXT'],
  ['review_status', 'TEXT'], // NULL 未发起 / pending_review 待复核 / approved 复核通过 / rejected 复核驳回
  ['review_maker_id', 'INTEGER'],
  ['review_maker_name', 'TEXT'],
  ['review_requested_at', 'TEXT'],
  ['review_checker_id', 'INTEGER'],
  ['review_checker_name', 'TEXT'],
  ['review_decided_at', 'TEXT'],
  ['review_comment', 'TEXT']
]

const PERM = ['finance.funds.review', '资金收付复核（收款确认 / 付款执行的第二人批准）', 'finance', 'action', 5210]
const ROLE_GRANTS = ['admin', 'finance']

module.exports.up = (db) => {
  for (const table of TABLES) {
    for (const [column, decl] of COLUMNS) addColumn(db, table, column, decl)
  }
  if (tableExists(db, 'permissions')) {
    db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    ).run(...PERM)
    if (tableExists(db, 'role_permissions')) {
      const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const role of ROLE_GRANTS) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        ins.run(role, PERM[0])
      }
    }
  }
}

module.exports.verify = (db) => {
  for (const table of TABLES) {
    for (const [column] of COLUMNS) if (!hasColumn(db, table, column)) return false
  }
  if (tableExists(db, 'permissions') && !db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])) return false
  // 角色授权集合是管理员策略（ADR-0007），不在这里重判。
  return true
}
