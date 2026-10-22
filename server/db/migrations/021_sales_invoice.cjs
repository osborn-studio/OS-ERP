'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/021_sales_invoice.cjs ｜ 迁移：销售发票：发票头 / 发票行 / 发票-应收关联 + 开票关闭列
 * ============================================================================
 * 【职责】迁移：销售发票：发票头 / 发票行 / 发票-应收关联 + 开票关闭列
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 021 销售发票（模块 24）
//
// 到此为止，销售链缺的最后一环是「票」：
//   订单（要卖什么）→ 发货单（货走了）→ 出库（库存减了）→ **发票（债权成立了）** → 收款（钱回来了）
// 以前这条链断在发货之后：`sales_orders.ar_id` 让应收直接挂在订单上，
// 于是三个问题都答不了：
//   · 这批货到底开没开票？（发货与开票是两件事，常常错期：月结开票、汇总开票）
//   · 开错票怎么改？（没有红冲的载体，只能删单重开，历史就断了）
//   · 哪些发货还没开票？（没有「待开票队列」，靠人记）
//
// 本迁移建三张表 + 给订单/发货单挂开票状态列：
//   sales_invoices      发票头：开给谁、对应哪个订单/发货单、金额与税额、开票日期与票号
//   sales_invoice_items 发票行：开票数量、单价、税率与税额（可与发货行一一对应）
//   invoice_ar_links    发票 ↔ 应收 ↔ 发货单 的关联：一张发票可对应多张应收（分批开票），
//                       一张应收也可由多张发票构成（补开发票）
//
// 三条口径（与既有模块保持一致，不另立）：
//   ① **开票不产生库存变化** —— 它只产生债权。库存的唯一入口永远是库存引擎；
//   ② **开票关闭是可推导的**：`invoice_status` 由发票行 SUM 与发货/订单数量比对得出，
//      不靠人工点「关闭」按钮（人工状态迟早和事实对不上）；
//   ③ **红冲不删原票**：红字发票单独一张，`red_chart_of_id` 指回原票，两张都在，
//      账才追得回来。

const { tableExists, hasColumn, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '销售发票：发票头 / 发票行 / 发票-应收关联 + 开票关闭列'

const TABLES = [
  // 发票头。金额拆成三列（不含税 / 税额 / 价税合计）而不是只存一个合计 ——
  // 财务要按不含税做收入、按税额做进销项，一个合计数没法拆回来。
  `CREATE TABLE IF NOT EXISTS sales_invoices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,       -- 系统单号 SI...
    org_id            INTEGER,
    subject_type      TEXT NOT NULL,              -- dealer / store / oc
    subject_id        INTEGER NOT NULL,
    subject_name      TEXT,
    source_type       TEXT NOT NULL DEFAULT 'DL', -- DL 发货单 / SO 订单 / MANUAL 手工
    source_id         INTEGER,
    source_doc_no     TEXT,
    order_id          INTEGER,                    -- 便于开票关闭回写订单
    order_no          TEXT,
    invoice_date      TEXT NOT NULL,
    invoice_no        TEXT,                       -- 税务发票号（纸质/电子票面号）
    invoice_type      TEXT NOT NULL DEFAULT 'normal', -- normal 蓝字 / red 红字
    tax_rate          REAL NOT NULL DEFAULT 0.13,
    amount            REAL NOT NULL DEFAULT 0,    -- 不含税金额
    tax_amount        REAL NOT NULL DEFAULT 0,    -- 税额
    total_amount      REAL NOT NULL DEFAULT 0,    -- 价税合计
    currency          TEXT NOT NULL DEFAULT 'CNY',
    status            TEXT NOT NULL DEFAULT 'draft', -- draft / pending / confirmed / red_charted / voided
    ar_id             INTEGER,                    -- 由本票生成或关联的应收单
    ar_doc_no         TEXT,
    red_chart_of_id   INTEGER,                    -- 红字票指向的原票
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    confirmed_by      INTEGER,
    confirmed_by_name TEXT,
    confirmed_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_si_status  ON sales_invoices(status, invoice_date)`,
  `CREATE INDEX IF NOT EXISTS idx_si_subject ON sales_invoices(subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS idx_si_source  ON sales_invoices(source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_si_order   ON sales_invoices(order_id)`,

  // 发票行。带 source_line_no 是为了回答「这张票开的是哪几行货」——
  // 分批开票时靠它把发票行与发货行对上，不用再靠数量猜。
  `CREATE TABLE IF NOT EXISTS sales_invoice_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id         INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
    line_no            INTEGER NOT NULL,
    sku_id             INTEGER,
    sku_code           TEXT,
    sku_name           TEXT,
    spec               TEXT,
    qty                REAL NOT NULL DEFAULT 0,
    price              REAL NOT NULL DEFAULT 0,
    amount             REAL NOT NULL DEFAULT 0,   -- 不含税行金额
    tax_rate           REAL NOT NULL DEFAULT 0.13,
    tax_amount         REAL NOT NULL DEFAULT 0,
    total_amount       REAL NOT NULL DEFAULT 0,
    source_delivery_id INTEGER,
    source_delivery_no TEXT,
    source_line_no     INTEGER,
    UNIQUE (invoice_id, line_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sii_invoice ON sales_invoice_items(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sii_sku     ON sales_invoice_items(sku_id)`,

  // 发票 ↔ 应收关联。单独一张表而不是在发票上放一个 ar_id：
  // 分批开票时一张发票会对应多张应收，一张应收也可能由多张发票凑成。
  `CREATE TABLE IF NOT EXISTS invoice_ar_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id  INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
    ar_id       INTEGER NOT NULL REFERENCES ar_documents(id) ON DELETE CASCADE,
    delivery_id INTEGER,
    amount      REAL NOT NULL DEFAULT 0,
    relation    TEXT NOT NULL DEFAULT 'created',  -- created 由本票生成应收 / linked 关联既有应收
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (invoice_id, ar_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ial_ar      ON invoice_ar_links(ar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ial_invoice ON invoice_ar_links(invoice_id)`
]

// 订单 / 发货单挂开票状态。三列足够表达「开票关闭」：
//   invoice_status：none 未开票 / partial 部分开票 / invoiced 已开完
//   invoice_qty_sum：累计已开票数量（由发票行 SUM 回写，用于与发货数量比对）
//   invoice_id/no：最近一张发票，便于从订单直接跳到票
const EXTRA_COLUMNS = [
  ['sales_orders', 'invoice_status', "TEXT NOT NULL DEFAULT 'none'"],
  ['sales_orders', 'invoice_qty_sum', 'REAL NOT NULL DEFAULT 0'],
  ['sales_orders', 'invoice_id', 'INTEGER'],
  ['sales_orders', 'invoice_no', 'TEXT'],
  ['sales_deliveries', 'invoice_status', "TEXT NOT NULL DEFAULT 'none'"],
  ['sales_deliveries', 'invoice_qty_sum', 'REAL NOT NULL DEFAULT 0'],
  ['sales_deliveries', 'invoice_id', 'INTEGER'],
  ['sales_deliveries', 'invoice_no', 'TEXT']
]

const PERMS = [
  ['sales.invoice.view', '查看销售发票', 'sales', 'menu'],
  ['sales.invoice.edit', '开具与作废销售发票', 'sales', 'action'],
  ['sales.invoice.approve', '确认开票与红冲', 'sales', 'action']
]

const ROLE_GRANTS = {
  admin: ['sales.invoice.view', 'sales.invoice.edit', 'sales.invoice.approve'],
  boss: ['sales.invoice.view'],
  sales: ['sales.invoice.view', 'sales.invoice.edit'],
  finance: ['sales.invoice.view', 'sales.invoice.edit', 'sales.invoice.approve'],
  warehouse: [],
  viewer: ['sales.invoice.view']
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
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5400)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  if (tableExists(db, 'doc_no_rules')) {
    db.prepare(
      `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark)
       VALUES (?,?, 'global','', '{PREFIX}{YYYYMMDD}{SEQ:4}','day',4,1,'模块 24')
       ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING`
    ).run('SI', '销售发票编号规则')
  }

  stampDef(db, '021_sales_invoice', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['sales_invoices', 'sales_invoice_items', 'invoice_ar_links']) {
    if (!tableExists(db, t)) return false
  }
  // 补列必须纳入自检：整库重建时表会被 schema.sql 重建回无列状态，
  // 只查表存在会误判为已迁移，新增列会凭空消失（本项目真实踩过）
  for (const [table, column] of EXTRA_COLUMNS) {
    if (!hasColumn(db, table, column)) return false
  }
  for (const name of ['idx_si_status', 'idx_sii_invoice', 'idx_ial_ar']) {
    if (!hasIndex(db, name)) return false
  }
  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  if (defStale(db, '021_sales_invoice', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })) {
    return false
  }
  return true
}
