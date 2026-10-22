'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/032_voucher.cjs ｜ 迁移：业财一体凭证（会计科目 / 凭证模板 / 凭证与分录 / 试算平衡）
 * ============================================================================
 * 【职责】迁移：业财一体凭证（会计科目 / 凭证模板 / 凭证与分录 / 试算平衡）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 032 业财一体凭证（批次 H · 模块 27）
//
// ===========================================================================
// 一、这一批要解决的是「业务做了、账没记」
// ===========================================================================
// 系统里有货、有钱、有单据，但从头到尾**没有一张会计凭证**：
//   采购入库之后存货科目没有增加；销售出库之后收入与成本没有确认；
//   收到了钱、付了款，也只是改了单据状态。
// 于是"这批货值多少钱、这个月赚了多少"在系统里**答不出来** ——
// 而每个单据看起来都是正常的、状态都对。
//
// 本批落的是最小闭环：**科目表 → 凭证模板 → 凭证生成 → 试算平衡**。
//
// ===========================================================================
// 二、三条硬口径（都在下面的表结构与 verify() 里体现）
// ===========================================================================
// ① **凭证只能由已发生的业务事实生成，不能人工编**。
//    生成器从来源单据取数，`source_type + source_id + biz_type` 唯一 ——
//    同一件事不能入两次账，也不能编一张"没有来源"的凭证去凑报表。
// ② **不平即拒绝入账**。生成时逐条算完借贷合计，不等就抛 `VOUCHER_NOT_BALANCED`
//    且**整张不落库**（不是落库了再报错 —— 半张凭证比没有凭证更糟）。
// ③ **方向不给人选**。分录的借贷方向由模板决定，人只填模板；
//    分录金额一律 > 0，"负数金额"报 `VOUCHER_NEGATIVE_AMOUNT`，
//    要冲减就换方向 —— 允许负数金额的账，任何汇总都可以被"负负得正"地做平。
//
// ===========================================================================
// 三、为什么模板里存的是「取数键」而不是「表达式字符串」
// ===========================================================================
// 计划书写的是"支持取数表达式"。实现上**刻意改成受控取值键**（`amount_key`）：
//   表达式求值器意味着**模板即代码** —— 而模板是可被界面编辑的配置。
//   一旦模板能被写成任意表达式，就等于"配置能改账"，而改账的错不会报错，
//   只会让某一张凭证的金额悄悄变成另一个数。
// 取值键的字典只有一处（`lib/accounting.js` 的 `FACT_KEYS`），
// 每个键回答"这个数从哪来、被谁算过"；模板只能说"我取哪一个"。
//
// ===========================================================================
// 四、与现有单据内核的关系
// ===========================================================================
// VOUCHER 是第 39 种单据类型（`008_doc_kernel.cjs`）：
//   draft（已生成未过账）→ posted（已过账）→ voided（已作废）。
// **只有 `posted` 计入试算平衡**。作废一张已过账凭证会改变当期发生额，
// 因此 `void` 在内核里登记为高危动作（`高风险=1`），且必须写 `void_reason`。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '业财一体凭证（会计科目 / 凭证模板 / 凭证与分录 / 试算平衡）'

// ---------------------------------------------------------------------------
// 会计科目树
//
// 为什么要有 `is_leaf`：记账只能挂**叶子科目**。
//   挂父科目不算错、也不会报错 —— 它只会让"父科目 = 子科目之和"这条
//   最基本的账表恒等式悄悄不成立，而报表仍然显示得很好看。
// 为什么要有 `direction`：科目有默认借贷方向，它是"这个科目大了是好是坏"的唯一出处。
//   余额方向靠它判，不靠"借方减贷方"正负去猜（负债类刚好相反）。
// ---------------------------------------------------------------------------
const SUBJECT_SQL = `
  CREATE TABLE IF NOT EXISTS accounting_subjects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,                 -- 科目编码（1001 / 222101）
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES accounting_subjects(id),
    category    TEXT NOT NULL,                        -- asset/liability/equity/cost/profit_loss
    direction   TEXT NOT NULL DEFAULT 'debit',        -- 余额方向 debit/credit
    level       INTEGER NOT NULL DEFAULT 1,
    is_leaf     INTEGER NOT NULL DEFAULT 1,           -- 只有叶子科目可记账
    aux_type    TEXT,                                 -- 辅助核算：customer/supplier/none
    status      TEXT NOT NULL DEFAULT 'active',
    remark      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`

// ---------------------------------------------------------------------------
// 凭证模板（头 + 分录模板）
// ---------------------------------------------------------------------------
const TEMPLATE_SQL = `
  CREATE TABLE IF NOT EXISTS voucher_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    biz_type    TEXT NOT NULL UNIQUE,                 -- 业务场景（决定"哪来的凭证"）
    doc_type    TEXT,                                 -- 关联的单据类型（PO/DL/RCP…）
    status      TEXT NOT NULL DEFAULT 'active',
    remark      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`

const TEMPLATE_ENTRY_SQL = `
  CREATE TABLE IF NOT EXISTS voucher_template_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id  INTEGER NOT NULL REFERENCES voucher_templates(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    direction    TEXT NOT NULL,                       -- debit / credit
    subject_code TEXT NOT NULL,                       -- 指向 accounting_subjects.code（不存 id：模板要能跨环境导入）
    amount_key   TEXT NOT NULL,                       -- 受控取数键（见 lib/accounting.js FACT_KEYS）
    aux_key      TEXT,                                -- 辅助核算取值键（customer/supplier 名称）
    UNIQUE (template_id, seq)
  )`

// ---------------------------------------------------------------------------
// 凭证与分录
// ---------------------------------------------------------------------------
const VOUCHER_SQL = `
  CREATE TABLE IF NOT EXISTS vouchers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no         TEXT NOT NULL UNIQUE,
    biz_type       TEXT NOT NULL,                     -- 业务场景
    source_type    TEXT NOT NULL,                     -- 来源单据类型（如 purchase_receipts）
    source_id      INTEGER NOT NULL,                  -- 来源单据 id
    source_doc_no  TEXT,                              -- 来源单号（冗余，便于反查与展示）
    voucher_date   TEXT NOT NULL,                     -- 记账日期（业务日）
    period         TEXT NOT NULL,                     -- 会计期间 = substr(voucher_date,1,7)
    status         TEXT NOT NULL DEFAULT 'draft',     -- draft / posted / voided
    total_debit    REAL NOT NULL DEFAULT 0,
    total_credit   REAL NOT NULL DEFAULT 0,
    memo           TEXT,
    maker_name     TEXT,
    posted_by      TEXT,
    posted_at      TEXT,
    voided_by      TEXT,
    voided_at      TEXT,
    void_reason    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (biz_type, source_type, source_id)
  )`

const VOUCHER_ENTRY_SQL = `
  CREATE TABLE IF NOT EXISTS voucher_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id   INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    subject_id   INTEGER NOT NULL REFERENCES accounting_subjects(id),
    subject_code TEXT NOT NULL,                       -- 冗余：科目改名/迁移后，历史凭证仍然读得出当时挂的是哪个科目
    subject_name TEXT NOT NULL,
    direction    TEXT NOT NULL,                       -- debit / credit
    amount       REAL NOT NULL,                       -- 恒 > 0
    aux_type     TEXT,
    aux_name     TEXT,
    UNIQUE (voucher_id, seq)
  )`

const TABLES = [
  { name: 'accounting_subjects', sql: SUBJECT_SQL },
  { name: 'voucher_templates', sql: TEMPLATE_SQL },
  { name: 'voucher_template_entries', sql: TEMPLATE_ENTRY_SQL },
  { name: 'vouchers', sql: VOUCHER_SQL },
  { name: 'voucher_entries', sql: VOUCHER_ENTRY_SQL }
]

const INDEXES = [
  { name: 'idx_subject_parent', sql: 'CREATE INDEX IF NOT EXISTS idx_subject_parent ON accounting_subjects (parent_id)' },
  { name: 'idx_subject_leaf', sql: 'CREATE INDEX IF NOT EXISTS idx_subject_leaf ON accounting_subjects (is_leaf, status)' },
  { name: 'idx_vt_entry', sql: 'CREATE INDEX IF NOT EXISTS idx_vt_entry ON voucher_template_entries (template_id, seq)' },
  { name: 'idx_voucher_period', sql: 'CREATE INDEX IF NOT EXISTS idx_voucher_period ON vouchers (period, status)' },
  // 来源唯一性由表上的 UNIQUE (biz_type, source_type, source_id) 兜住；
  // 这条索引只是让"这张单生成过凭证吗"这类反查走索引。
  { name: 'idx_voucher_source', sql: 'CREATE INDEX IF NOT EXISTS idx_voucher_source ON vouchers (source_type, source_id)' },
  { name: 'idx_voucher_entry', sql: 'CREATE INDEX IF NOT EXISTS idx_voucher_entry ON voucher_entries (voucher_id, seq)' },
  { name: 'idx_voucher_entry_subject', sql: 'CREATE INDEX IF NOT EXISTS idx_voucher_entry_subject ON voucher_entries (subject_id)' }
]

const NEW_COLUMNS = []

// 权限点：科目维护与凭证过账/作废分开。过账与作废**必须分开授权** ——
// 能记账的人不应该同时能把记好的账作废掉，否则"谁都不是一个人做完"这条内控就没有落点。
const PERMS = [
  ['finance.subject.view', '查看会计科目', 'finance', '查看'],
  ['finance.subject.edit', '维护会计科目', 'finance', '编辑'],
  ['finance.voucher.view', '查看记账凭证', 'finance', '查看'],
  ['finance.voucher.gen', '生成记账凭证', 'finance', '编辑'],
  ['finance.voucher.post', '凭证过账', 'finance', '审核'],
  ['finance.voucher.void', '凭证作废', 'finance', '审核']
]

const ROLE_GRANTS = {
  admin: ['finance.subject.view', 'finance.subject.edit', 'finance.voucher.view', 'finance.voucher.gen', 'finance.voucher.post', 'finance.voucher.void'],
  boss: ['finance.subject.view', 'finance.voucher.view'],
  finance: ['finance.subject.view', 'finance.subject.edit', 'finance.voucher.view', 'finance.voucher.gen', 'finance.voucher.post'],
  sales: ['finance.voucher.view'],
  purchase: ['finance.voucher.view'],
  viewer: ['finance.voucher.view']
}

module.exports.up = function up(db) {
  for (const t of TABLES) db.exec(t.sql)
  for (const [t, c, decl] of NEW_COLUMNS) addColumn(db, t, c, decl)
  for (const ix of INDEXES) db.exec(ix.sql)

  // 权限
  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5800)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  // 默认税率（税率不是"每处各写一个 13"，它必须有一个出处）
  if (tableExists(db, 'settings')) {
    const cols = db.prepare('PRAGMA table_info(settings)').all().map((r) => r.name)
    const keyCol = cols.includes('key') ? 'key' : cols.includes('name') ? 'name' : null
    if (keyCol) {
      db.prepare(
        `INSERT INTO settings (${keyCol}, value) VALUES ('voucher_default_tax_rate', '13')
         ON CONFLICT(${keyCol}) DO NOTHING`
      ).run()
    }
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS,
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  }
  stampDef(db, '032_voucher', def)
  return { tables: TABLES.length, columns: NEW_COLUMNS.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量一：分录金额必须为正（允许负数金额的账，任何汇总都能被"负负得正"地做平）
  if (tableExists(db, 'voucher_entries')) {
    const neg = db.prepare('SELECT COUNT(*) c FROM voucher_entries WHERE amount <= 0').get().c
    if (neg > 0) return false
    // 不变量二：方向只有两种取值
    const badDir = db.prepare("SELECT COUNT(*) c FROM voucher_entries WHERE direction NOT IN ('debit','credit')").get().c
    if (badDir > 0) return false
  }
  // 不变量三：**已过账凭证必须借贷平衡**
  if (tableExists(db, 'vouchers')) {
    const unbalanced = db
      .prepare(`
        SELECT COUNT(*) c FROM vouchers v
         WHERE v.status IN ('draft','posted')
           AND ABS(v.total_debit - v.total_credit) > 0.005
      `)
      .get().c
    if (unbalanced > 0) return false
    // 不变量四：期间必须等于记账日期的前 7 位（期间写错不会报错，只会让本期账"凭空多/少一块"）
    const badPeriod = db
      .prepare("SELECT COUNT(*) c FROM vouchers WHERE period <> substr(voucher_date,1,7)")
      .get().c
    if (badPeriod > 0) return false
  }
  // 不变量五：模板分录的取数键非空、方向合法
  if (tableExists(db, 'voucher_template_entries')) {
    const badTpl = db
      .prepare(`
        SELECT COUNT(*) c FROM voucher_template_entries
         WHERE direction NOT IN ('debit','credit') OR amount_key IS NULL OR amount_key = ''
      `)
      .get().c
    if (badTpl > 0) return false
  }
  // 不变量六：科目 parent_id 不能自指（自指的科目树会让"上级科目"永远算不出来）
  if (tableExists(db, 'accounting_subjects')) {
    const selfRef = db.prepare('SELECT COUNT(*) c FROM accounting_subjects WHERE parent_id = id').get().c
    if (selfRef > 0) return false
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS,
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  }
  if (defStale(db, '032_voucher', def)) return false
  return true
}
