'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/019_ar_receipt.cjs ｜ 迁移：应收与收款核销：应收单 / 收款单 / 核销明细
 * ============================================================================
 * 【职责】迁移：应收与收款核销：应收单 / 收款单 / 核销明细
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 019 应收与收款核销（模块 21 结算与对账中心 · 第一阶段）
//
// 现状的问题：销售侧的「钱」只有 sales_orders.paid_amount 一个数。
// 它回答不了三件事：
//   · 这笔钱抵的是哪张单？（多笔订单混在一起付，账对不上）
//   · 谁逾期了、逾期多久？（没有到期日，账龄算不出来）
//   · 客户对账单怎么出？（只能口头说「你还欠 XX 万」）
// 更糟的是：付款（模块 07）有付款单 + 核销明细 + 作废保护，收款只有一列数字，
// 两边不对称 —— 应付能追到每一笔，应收追不到。
//
// 本迁移建三张表，口径与模块 07 付款侧严格对称：
//   ar_documents        应收单：谁、因为哪张单、欠多少、什么时候到期
//   receipts            收款单：钱到账才生效（draft → confirmed），作废要回退核销
//   receipt_allocations 核销明细：收款单与应收单的多对多分摊
//
// 两条硬口径（与模块 07 同源）：
//   ① 已收金额永远由核销明细 SUM 算出，不累加（否则作废一笔就对不上）；
//   ② 核销生效点 = 收款单确认，不是登记明细的时候（草稿上的核销只是计划）。

const { tableExists, hasColumn, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '应收与收款核销：应收单 / 收款单 / 核销明细'

const TABLES = [
  // 应收单：由销售订单 / 订货单生成，是「谁欠我多少」的账
  //   allocated_amount 由核销明细 SUM 得出（见文件头口径 ①），status 由它推导
  `CREATE TABLE IF NOT EXISTS ar_documents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    subject_type      TEXT NOT NULL,             -- dealer / oc / store
    subject_id        INTEGER NOT NULL,
    subject_name      TEXT,
    source_type       TEXT NOT NULL,             -- SO 销售订单 / OC 订货单 / MANUAL 手工
    source_id         INTEGER,
    source_doc_no     TEXT,
    biz_date          TEXT NOT NULL,             -- 业务日期（订单日）
    due_date          TEXT,                      -- 到期日 = 业务日期 + 账期天数
    credit_days       INTEGER NOT NULL DEFAULT 0,
    amount            REAL NOT NULL DEFAULT 0,   -- 应收金额
    allocated_amount  REAL NOT NULL DEFAULT 0,   -- 已核销（由明细 SUM 维护）
    status            TEXT NOT NULL DEFAULT 'open', -- open / partial / closed / voided
    currency          TEXT NOT NULL DEFAULT 'CNY',
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ar_subject  ON ar_documents(subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ar_status   ON ar_documents(status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_ar_source   ON ar_documents(source_type, source_id)`,

  // 收款单：钱到账才生效。草稿阶段的核销明细只是「计划」，不计入已收
  `CREATE TABLE IF NOT EXISTS receipts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no        TEXT NOT NULL UNIQUE,
    subject_type  TEXT NOT NULL,
    subject_id    INTEGER NOT NULL,
    subject_name  TEXT,
    receipt_date  TEXT NOT NULL,
    method        TEXT,                          -- transfer 转账 / cash 现金 / bill 票据 / online 在线
    amount        REAL NOT NULL DEFAULT 0,       -- 收款总额
    allocated_amount REAL NOT NULL DEFAULT 0,    -- 已分摊到应收的部分（剩余为预收）
    status        TEXT NOT NULL DEFAULT 'draft', -- draft / confirmed / voided
    bank_account  TEXT,
    serial_no     TEXT,                          -- 流水号 / 票据号
    remark        TEXT,
    created_by    INTEGER,
    created_by_name TEXT,
    confirmed_by  INTEGER,
    confirmed_by_name TEXT,
    confirmed_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rc_subject ON receipts(subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rc_status  ON receipts(status, receipt_date)`,

  // 核销明细：收款单 ↔ 应收单 多对多。它是「已收多少」的唯一真相
  `CREATE TABLE IF NOT EXISTS receipt_allocations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    ar_id       INTEGER NOT NULL REFERENCES ar_documents(id) ON DELETE CASCADE,
    amount      REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (receipt_id, ar_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alloc_ar ON receipt_allocations(ar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alloc_rc ON receipt_allocations(receipt_id)`
]

// 销售订单上记一笔「生成了哪张应收单」，避免重复生成
const EXTRA_COLUMNS = [
  ['sales_orders', 'ar_id', 'INTEGER'],
  ['sales_orders', 'ar_doc_no', 'TEXT']
]

const PERMS = [
  ['finance.receipt.view', '查看应收与收款', 'finance', 'menu'],
  ['finance.receipt.edit', '登记收款与核销', 'finance', 'action'],
  ['finance.receipt.approve', '收款确认与作废', 'finance', 'action']
]

const ROLE_GRANTS = {
  admin: ['finance.receipt.view', 'finance.receipt.edit', 'finance.receipt.approve'],
  boss: ['finance.receipt.view'],
  finance: ['finance.receipt.view', 'finance.receipt.edit', 'finance.receipt.approve'],
  sales: ['finance.receipt.view', 'finance.receipt.edit'],
  warehouse: [],
  viewer: ['finance.receipt.view']
}

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)

  for (const [table, column, decl] of EXTRA_COLUMNS) {
    if (tableExists(db, table)) addColumn(db, table, column, decl)
  }

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5200)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  if (tableExists(db, 'doc_no_rules')) {
    const ins = db.prepare(
      `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark)
       VALUES (?,?, 'global','', '{PREFIX}{YYYYMMDD}{SEQ:4}','day',4,1,'模块 21')
       ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING`
    )
    ins.run('AR', '应收单编号规则')
    ins.run('RCP', '收款单编号规则')
  }

  stampDef(db, '019_ar_receipt', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['ar_documents', 'receipts', 'receipt_allocations']) {
    if (!tableExists(db, t)) return false
  }
  // 补列也要纳入自检：整库重建时表会被 schema.sql 重建回无列状态，
  // 只查表存在会误判为已迁移，结果新增列凭空消失（本轮真实踩到）
  for (const [table, column] of EXTRA_COLUMNS) {
    if (!hasColumn(db, table, column)) return false
  }
  if (!hasIndex(db, 'idx_ar_subject')) return false
  if (!hasIndex(db, 'idx_alloc_ar')) return false
  if (tableExists(db, 'permissions')) {
    const miss = PERMS.filter(([code]) => !db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code))
    if (miss.length) return false
  }
  if (defStale(db, '019_ar_receipt', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })) {
    return false
  }
  return true
}
