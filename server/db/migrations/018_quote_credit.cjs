'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/018_quote_credit.cjs ｜ 迁移：销售报价与信用控制：报价单 / 信用账户 / 信用台账 / 校验留痕
 * ============================================================================
 * 【职责】迁移：销售报价与信用控制：报价单 / 信用账户 / 信用台账 / 校验留痕
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 018 销售报价与信用控制（模块 08A）
//
// 两块内容，各自解决一个「现在做不到」的问题：
//
// ── ① 报价单（QT）───────────────────────────────────────────────
//   现状：销售只有订单，报价靠 Excel/微信发，于是三件事说不清：
//     · 报出去的价是不是按价格政策算的？（手改一个数没人看得出来）
//     · 这个价报给谁、管到哪天？（有效期只存在于邮件正文里）
//     · 报完怎么变成订单？（重新录一遍，录入即失真）
//   所以要有一张单：取价走价格中心、带有效期、低于最低限价要审批、
//   审批通过才能**转单**，且一张报价只能转一次单（转完就锁死）。
//
// ── ② 信用控制 ─────────────────────────────────────────────────
//   现状：dealers 表有 credit_limit / credit_days / credit_used 三列，
//   但 credit_used 是**缓存列** —— 只有销售订单收款时顺手减一下
//   （routes/sales.js 里 UPDATE dealers SET credit_used = MAX(credit_used - ?, 0)），
//   没有任何一处做「下单前够不够额度」的判断，超信照样能发货。
//   更麻烦的是订货中心（模块 12A）另有一套 oc_credit_ledger，
//   同一个经销商在两条线各有一本账，两边都不知道对方占了多少。
//
//   本迁移建统一信用主体（credit_accounts）+ 统一台账（credit_ledger）：
//     · 额度只有一个真相：credit_accounts（含临时额度），不读缓存列；
//     · 已用 = 统一台账求和 + 订货中心同主体未回款占用（跨渠道归并，只读不改 OC）；
//     · 每次校验都留痕（credit_check_logs）—— 「超信是谁放行的」必须能查到。
//
//   为什么不动订货中心自己的口径：OC 的授信已经跑通且有 208 项断言守着，
//   改它要连带改测试与 seed；统一层是**加法**：OC 的占用作为同主体占用并入，
//   OC 自身所见不受影响。两套口径只对同一主体共享额度这一件事握手。

const { tableExists, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '销售报价与信用控制：报价单 / 信用账户 / 信用台账 / 校验留痕'

// ---------------------------------------------------------------------------
// 一、表结构
// ---------------------------------------------------------------------------
const TABLES = [
  // 销售报价单：报出去的价是一张单，不是一条消息
  `CREATE TABLE IF NOT EXISTS sales_quotes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no           TEXT NOT NULL UNIQUE,
    source_quote_id  INTEGER,                       -- 改版来源（复制旧报价生成新版本）
    version          INTEGER NOT NULL DEFAULT 1,
    customer_type    TEXT NOT NULL DEFAULT 'dealer', -- dealer 经销商 / oc 订货客户 / store 门店
    dealer_id        INTEGER,
    customer_id      INTEGER,                       -- oc_customers.id
    store_id         INTEGER,
    channel          TEXT NOT NULL DEFAULT 'dealer',
    warehouse_id     INTEGER,
    currency         TEXT NOT NULL DEFAULT 'CNY',
    quote_date       TEXT NOT NULL,
    valid_from       TEXT NOT NULL,                 -- 有效期起
    valid_to         TEXT NOT NULL,                 -- 有效期止（过期不可转单）
    status           TEXT NOT NULL DEFAULT 'draft', -- draft/submitted/approved/rejected/converted/expired/cancelled
    goods_amount     REAL NOT NULL DEFAULT 0,
    discount_amount  REAL NOT NULL DEFAULT 0,
    freight          REAL NOT NULL DEFAULT 0,
    tax_rate         REAL NOT NULL DEFAULT 0,
    tax_amount       REAL NOT NULL DEFAULT 0,
    total_amount     REAL NOT NULL DEFAULT 0,
    gross_rate       REAL NOT NULL DEFAULT 100,     -- 整单折扣率（%）：成交 ÷ 挂牌
    below_min_count  INTEGER NOT NULL DEFAULT 0,    -- 低于最低限价的行数（>0 必审批）
    need_approval    INTEGER NOT NULL DEFAULT 0,
    approval_reason  TEXT,
    approved_by      INTEGER,
    approved_by_name TEXT,
    approved_at      TEXT,
    converted_type   TEXT,                          -- SO 销售订单 / OC 订货单
    converted_order_id INTEGER,
    converted_doc_no TEXT,
    converted_at     TEXT,
    credit_hold      REAL NOT NULL DEFAULT 0,       -- 转单时占用的授信（预留，转单即生效）
    credit_checked_at TEXT,
    remark           TEXT,
    created_by       INTEGER,
    created_by_name  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_squote_status ON sales_quotes(status, quote_date)`,
  `CREATE INDEX IF NOT EXISTS idx_squote_cust   ON sales_quotes(customer_type, dealer_id, customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_squote_valid  ON sales_quotes(valid_to, status)`,

  // 报价行：每行都带「价从哪来」
  //   list_price 挂牌价（标准零售价，做折扣分母）；price 成交价（价格中心算出）
  //   price_source / price_rule 解释「为什么是这个价」，界面上要能答得出来
  //   min_price 是**报价那一刻**的最低限价快照 —— 主数据后来改了价，
  //   也不能拿新限价去追溯审一张老报价单
  `CREATE TABLE IF NOT EXISTS sales_quote_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id      INTEGER NOT NULL REFERENCES sales_quotes(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL DEFAULT 1,
    sku_id        INTEGER NOT NULL,
    qty           REAL NOT NULL DEFAULT 0,
    list_price    REAL NOT NULL DEFAULT 0,
    price         REAL NOT NULL DEFAULT 0,
    price_source  TEXT,
    price_rule    TEXT,
    price_group_id INTEGER,
    discount_rate REAL NOT NULL DEFAULT 100,
    amount        REAL NOT NULL DEFAULT 0,
    min_price     REAL NOT NULL DEFAULT 0,
    below_min     INTEGER NOT NULL DEFAULT 0,
    available_qty REAL,                             -- 报价时的可用量（供界面提示，不做拦截）
    remark        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_squote_item ON sales_quote_items(quote_id, line_no)`,

  // 信用账户：一个主体一行，额度与账期的唯一真相
  //   subject_type=dealer 时与订货中心的客户身份归并（同一经销商共享额度）
  `CREATE TABLE IF NOT EXISTS credit_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type   TEXT NOT NULL,                   -- dealer / oc / store
    subject_id     INTEGER NOT NULL,
    code           TEXT,
    name           TEXT,
    credit_limit   REAL NOT NULL DEFAULT 0,         -- 信用额度（0 = 未授信，按现结处理）
    credit_days    INTEGER NOT NULL DEFAULT 0,      -- 账期天数（0 = 现结）
    temp_limit     REAL NOT NULL DEFAULT 0,         -- 临时额度
    temp_expire_at TEXT,                            -- 临时额度到期日（过期即失效，不再计入可用）
    settle_type    TEXT,
    status         TEXT NOT NULL DEFAULT 'active',  -- active / frozen 冻结
    frozen_reason  TEXT,
    remark         TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (subject_type, subject_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_acc_status ON credit_accounts(status, subject_type)`,

  // 信用台账：占用 / 释放 / 核销一律走这里，余额由求和得出，不存缓存列
  //   amount 正=占用，负=释放或核销
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    INTEGER NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
    change_type   TEXT NOT NULL,                    -- occupy 占用 / release 释放 / settle 回款核销 / adjust 人工调整
    source_type   TEXT NOT NULL,                    -- SO 销售订单 / QT 报价单 / MANUAL 手工
    source_id     INTEGER,
    doc_no        TEXT,
    amount        REAL NOT NULL DEFAULT 0,
    balance_after REAL NOT NULL DEFAULT 0,          -- 写这一笔之后的已用额（对账用，不是权威值但必须自洽）
    due_date      TEXT,                             -- 该笔占用的应收到期日（按账期推）
    operator_id   INTEGER,
    operator      TEXT,
    remark        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_ledger_acc ON credit_ledger(account_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_credit_ledger_src ON credit_ledger(source_type, source_id)`,

  // 信用校验留痕：每次「能不能下单」都记一笔，超信放行必须写清谁、为什么
  `CREATE TABLE IF NOT EXISTS credit_check_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER,
    scene        TEXT NOT NULL,                     -- order.confirm / quote.convert / api
    source_type  TEXT,
    source_id    INTEGER,
    doc_no       TEXT,
    amount       REAL NOT NULL DEFAULT 0,
    available    REAL NOT NULL DEFAULT 0,
    over_amount  REAL NOT NULL DEFAULT 0,
    overdue_days INTEGER NOT NULL DEFAULT 0,
    result       TEXT NOT NULL,                     -- pass / warn / block / force
    reason       TEXT,
    operator_id  INTEGER,
    operator     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_check_acc ON credit_check_logs(account_id, id)`
]

// 销售订单上落一个占用列：对账时能直接比「单据认为占了多少」与「台账实际占了多少」
// quote_id / quote_no 是「这张订单从哪张报价来的」—— 转单不是重新报价，来源必须可追
const EXTRA_COLUMNS = [
  ['sales_orders', 'credit_hold', 'REAL NOT NULL DEFAULT 0'],
  ['sales_orders', 'credit_checked_at', 'TEXT'],
  ['sales_orders', 'quote_id', 'INTEGER'],
  ['sales_orders', 'quote_no', 'TEXT'],
  // 最低限价：报价审批的触发线。它属于**主数据**（价目表的一部分），
  // 但报价行会把它快照下来 —— 「当时按哪个限价审的」必须能追溯
  ['product_skus', 'price_min', 'REAL NOT NULL DEFAULT 0']
]

// ---------------------------------------------------------------------------
// 二、权限点
// ---------------------------------------------------------------------------
const PERMS = [
  ['sales.quote.view', '查看销售报价', 'sales', 'menu'],
  ['sales.quote.edit', '编制与提交报价', 'sales', 'action'],
  ['sales.quote.approve', '报价审批（超折扣/低于限价）', 'sales', 'action'],
  ['sales.quote.convert', '报价转订单', 'sales', 'action'],
  ['credit.view', '查看信用额度与台账', 'sales', 'menu'],
  ['credit.manage', '授信维护与超信放行', 'sales', 'action']
]

const ROLE_GRANTS = {
  admin: ['sales.quote.view', 'sales.quote.edit', 'sales.quote.approve', 'sales.quote.convert', 'credit.view', 'credit.manage'],
  boss: ['sales.quote.view', 'sales.quote.approve', 'credit.view'],
  sales: ['sales.quote.view', 'sales.quote.edit', 'sales.quote.convert', 'credit.view'],
  finance: ['sales.quote.view', 'credit.view', 'credit.manage'],
  warehouse: ['sales.quote.view'],
  viewer: ['sales.quote.view', 'credit.view']
}

// ---------------------------------------------------------------------------
// 三、迁移主体
// ---------------------------------------------------------------------------
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
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 4600)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  // 报价单的取号规则：009 的自检会为新增单据类型自动补，这里显式补一次，
  // 避免「规则还没补就先发单」时落到旧逻辑（格式一致，但计数器不通用）
  if (tableExists(db, 'doc_no_rules')) {
    db.prepare(
      `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark)
       VALUES ('QT','销售报价单编号规则','global','','{PREFIX}{YYYYMMDD}{SEQ:4}','day',4,1,'模块 08A')
       ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING`
    ).run()
  }

  stampDef(db, '018_quote_credit', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['sales_quotes', 'sales_quote_items', 'credit_accounts', 'credit_ledger', 'credit_check_logs']) {
    if (!tableExists(db, t)) return false
  }
  if (!hasIndex(db, 'idx_credit_ledger_acc')) return false
  if (!hasIndex(db, 'idx_squote_valid')) return false
  if (tableExists(db, 'permissions')) {
    const miss = PERMS.filter(([code]) => !db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code))
    if (miss.length) return false
  }
  if (defStale(db, '018_quote_credit', { tables: TABLES, columns: EXTRA_COLUMNS, perms: PERMS, roles: ROLE_GRANTS })) {
    return false
  }
  return true
}
