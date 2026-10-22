'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/020_ar_extend.cjs ｜ 迁移：应收域扩展与数据库加固：逐笔账龄视图 / 订货中心待并入视图 / 派生索引 / 运维参数
 * ============================================================================
 * 【职责】迁移：应收域扩展与数据库加固：逐笔账龄视图 / 订货中心待并入视图 / 派生索引 / 运维参数
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 020 应收域扩展 + 数据库加固（模块 21 第二阶段）
//
// 019 把应收的「三张表」立住了：应收单 / 收款单 / 核销明细。
// 但它回答不了三件事，本迁移补上：
//   · 逐笔账龄 —— 019 的账龄只有按桶汇总（b0/b1/b2/b3），看不到「哪一笔逾期几天」；
//   · 订货中心并入 —— 门店与经销商的订货单（模块 12A）走的是另一套台账 oc_credit_ledger，
//     它的「欠款」没有进应收账，于是同一个客户在订货中心和财务部看到两个数字；
//   · 预收 —— 收款单里没抵完的余额（amount − 核销明细）就是预收，但没有任何地方
//     把它当成「客户存在我这儿的钱」显式列出来，也没法主动拿它去抵新账。
//
// 三条口径（在本迁移落成视图，保证「界面显示」与「库里可算」永远同源）：
//   ① 逐笔账龄的余额 = amount − allocated_amount，用 SUM 重算，不读缓存列；
//   ② 订货中心待并入 = oc_orders 已收/已发货 且 ar_documents 里没有 source_type='OC' 的记录；
//   ③ 预收余额 = 该主体 confirmed 收款单 amount 之和 − 其核销明细 amount 之和。
//
// 本迁移不建业务表（结构在 019 已定），只加视图、派生索引、运维参数与权限点。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '应收域扩展与数据库加固：逐笔账龄视图 / 订货中心待并入视图 / 派生索引 / 运维参数'

// ---------------------------------------------------------------------------
// 视图：把「界面要展示的口径」下沉到库里，避免前端各写一遍 SQL
// ---------------------------------------------------------------------------

// 逐笔账龄：一行 = 一张应收单，带余额、逾期天数、账龄分桶（桶名与 lib/ar.js 的 aging 一致）
const viewAgingDetail = `CREATE VIEW IF NOT EXISTS v_ar_aging_detail AS
SELECT d.id, d.doc_no, d.subject_type, d.subject_id, IFNULL(d.subject_name,'') AS subject_name,
       d.source_type, IFNULL(d.source_doc_no,'') AS source_doc_no,
       d.biz_date, IFNULL(d.due_date,'') AS due_date, d.credit_days,
       d.amount, d.allocated_amount,
       ROUND(d.amount - d.allocated_amount, 2) AS open_amount,
       d.status,
       CASE
         WHEN d.status NOT IN ('open','partial') THEN 0
         WHEN d.due_date IS NULL OR d.due_date >= date('now','localtime') THEN 0
         ELSE CAST(julianday(date('now','localtime')) - julianday(d.due_date) AS INTEGER)
       END AS overdue_days,
       CASE
         WHEN d.status NOT IN ('open','partial') THEN 'settled'
         WHEN d.due_date IS NULL OR d.due_date >= date('now','localtime') THEN 'b0'
         WHEN julianday(date('now','localtime')) - julianday(d.due_date) <= 30 THEN 'b1'
         WHEN julianday(date('now','localtime')) - julianday(d.due_date) <= 60 THEN 'b2'
         ELSE 'b3'
       END AS bucket
FROM ar_documents d`

// 订货中心待并入：已收/已发货/已配货 但还没生成应收单的订货单（口径 ②）
const viewOcPending = `CREATE VIEW IF NOT EXISTS v_oc_ar_pending AS
SELECT o.id, o.doc_no, o.customer_id, IFNULL(o.customer_name,'') AS customer_name,
       o.order_date, o.total_amount, o.status, o.ship_warehouse_id
FROM oc_orders o
WHERE o.status IN ('allocated','shipped','received','completed')
  AND NOT EXISTS (
    SELECT 1 FROM ar_documents d WHERE d.source_type = 'OC' AND d.source_id = o.id
  )`

// 预收余额：按主体汇总「已收 − 已核销」（口径 ③）
const viewPrepay = `CREATE VIEW IF NOT EXISTS v_ar_prepay AS
SELECT r.subject_type, r.subject_id, IFNULL(r.subject_name,'') AS subject_name,
       ROUND(SUM(r.amount), 2) AS received_amount,
       ROUND(SUM(IFNULL(a.alloc, 0)), 2) AS allocated_amount,
       ROUND(SUM(r.amount) - SUM(IFNULL(a.alloc, 0)), 2) AS prepay_balance
FROM receipts r
LEFT JOIN (
  SELECT receipt_id, SUM(amount) AS alloc FROM receipt_allocations GROUP BY receipt_id
) a ON a.receipt_id = r.id
WHERE r.status = 'confirmed'
GROUP BY r.subject_type, r.subject_id
HAVING prepay_balance > 0.005`

const VIEWS = [viewAgingDetail, viewOcPending, viewPrepay]

// ---------------------------------------------------------------------------
// 派生索引：只建被真实查询用到的列（账龄报表 / 预收清单）
// ---------------------------------------------------------------------------
const INDEXES = [
  // 账龄：按状态 + 到期日扫描未结应收，是最高频的查询
  `CREATE INDEX IF NOT EXISTS idx_ar_open_due ON ar_documents(status, due_date, subject_type)`,
  // 预收：按主体 + 状态取确认收款单
  `CREATE INDEX IF NOT EXISTS idx_rc_subject_status ON receipts(subject_type, subject_id, status, receipt_date)`
]

// ---------------------------------------------------------------------------
// 运维参数：口径要显式落库，不能只活在某段代码的注释里
// ---------------------------------------------------------------------------
const SETTINGS = [
  ['backup_dir', 'data/backups', '备份输出目录（相对项目根）'],
  ['backup_keep', '10', '每库保留的备份份数，超出按时间清理最旧的'],
  ['ar_source_of_truth', 'SO', '应收生成口径：SO=销售订单确认即生成 / SI=开票后生成'],
  ['ar_oc_enabled', '1', '订货中心订单是否自动并入应收（1 开 / 0 关）'],
  ['ar_prepay_auto', '0', '预收是否自动抵新应收（1 自动核销 / 0 需人工确认）']
]

const PERMS = [
  ['finance.ar.aging', '查看逐笔账龄', 'finance', 'action'],
  ['finance.ar.prepay', '预收管理与转应收', 'finance', 'action']
]

const ROLE_GRANTS = {
  admin: ['finance.ar.aging', 'finance.ar.prepay'],
  boss: ['finance.ar.aging'],
  finance: ['finance.ar.aging', 'finance.ar.prepay'],
  sales: ['finance.ar.aging'],
  warehouse: [],
  viewer: []
}

module.exports.up = function up(db) {
  for (const sql of VIEWS) db.exec(sql)
  for (const sql of INDEXES) db.exec(sql)

  if (tableExists(db, 'settings')) {
    const ins = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO NOTHING`
    )
    for (const [key, value] of SETTINGS) ins.run(key, value)
  }

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5300)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  stampDef(db, '020_ar_extend', { views: VIEWS, indexes: INDEXES, settings: SETTINGS, perms: PERMS })
  return { views: VIEWS.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  // 视图：整库重建时视图会随 schema.sql 一起消失，必须逐条自检
  for (const name of ['v_ar_aging_detail', 'v_oc_ar_pending', 'v_ar_prepay']) {
    if (!db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type='view' AND name=?`).get(name)) return false
  }
  for (const name of ['idx_ar_open_due', 'idx_rc_subject_status']) {
    if (!hasIndex(db, name)) return false
  }
  if (tableExists(db, 'settings')) {
    for (const [key] of SETTINGS) {
      if (!db.prepare('SELECT 1 AS hit FROM settings WHERE key=?').get(key)) return false
    }
  }
  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  if (defStale(db, '020_ar_extend', { views: VIEWS, indexes: INDEXES, settings: SETTINGS, perms: PERMS })) {
    return false
  }
  return true
}
