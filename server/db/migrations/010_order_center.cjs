'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/010_order_center.cjs ｜ 迁移：订货中心 oc_customers / oc_orders / oc_statements
 * ============================================================================
 * 【职责】迁移：订货中心 oc_customers / oc_orders / oc_statements
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 010 订货中心（B2B 订货平台）：统一承载「门店要货 + 经销商订货」
//
// 背景（用户补充轮提出的架构修正）：
//   门店要货原本挂在 requisitions.js 的「要货→发货→收货」闭环，
//   经销商订货挂在 DMS，线上商城又另起一套 ——
//   但三者里「门店要货」和「经销商订货」本质是同一件事：**下级向总部订货**。
//   放在两处做的后果：口径分叉、代码重复，加一条渠道规则要改两边。
//
// 本迁移只做「结构」，不做定义（定义归 008 单据内核，避免被 008 的 heal 抹掉）：
//   订货主体（可订货性一层，不复制档案真相）
//   收货地址
//   订货单头/行（统一下单单据）
//   审批节点（按规则触发的审批链）
//   信用占用流水（下单占用→结算转应收→回款释放）
//   对账单（B2B 最核心功能，不是附属）
//   订货策略与可见性规则
//
// 关键设计取舍：
//   1. oc_customers 不存 credit_used —— 占用额由 oc_credit_ledger 汇总，
//      否则「额度用了多少」会有两个来源，对账时必然对不上。
//   2. source_id 是多态的（指向 stores.id 或 dealers.id），因此**不加外键**；
//      档案真相仍在原表，本表只承载「能不能订、能订多少、怎么订」。
//   3. customer_name / sku_name 存快照 —— 档案改名后历史单不能跟着变脸。

const { tableExists, hasColumn } = require('./_helpers.cjs')

module.exports.name = '订货中心 oc_customers / oc_orders / oc_statements'

const TABLES = `
  -- ------------------------------------------------------------------
  -- 1. 订货主体：一个「能订货的客户」
  --    来源可以是门店（直营/加盟）也可以是经销商，甚至是经销商的下游门店。
  --    多级渠道在这里表达为 parent_customer_id。
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_customers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    code               TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    source_type        TEXT NOT NULL,              -- store / dealer
    source_id          INTEGER NOT NULL,           -- stores.id / dealers.id（多态，不加外键）
    parent_customer_id INTEGER,                    -- 上级客户（多级渠道：终端店挂在经销商下）
    level              TEXT,                       -- 客户等级 vip/gold/silver/bronze
    channel            TEXT,                       -- direct/franchise/dealer/sub_dealer
    region             TEXT,
    city               TEXT,
    contact            TEXT,
    phone              TEXT,
    address            TEXT,
    -- 供货方（我方）主体：订货单的货主与发货方
    owner_org_id       INTEGER,
    org_id             INTEGER,                    -- 客户自身组织（门店/经销商组织）
    -- 交易条件
    settle_type        TEXT NOT NULL DEFAULT 'credit',   -- credit 账期 / prepay 现结
    credit_limit       REAL,                       -- NULL = 沿用来源档案的 credit_limit
    credit_days        INTEGER,
    price_level        TEXT,
    discount_rate      REAL,
    -- 订货策略
    min_order_qty      REAL DEFAULT 0,
    min_order_amount   REAL DEFAULT 0,
    -- 是否允许缺货下单（1 允许并转待补/拆单；0 必须足量才可下单）
    allow_shortage     INTEGER NOT NULL DEFAULT 1,
    currency           TEXT NOT NULL DEFAULT 'CNY',
    -- 准入
    admit_status       TEXT NOT NULL DEFAULT 'pending',  -- pending/active/frozen
    admit_at           TEXT,
    admit_by           TEXT,
    frozen_reason      TEXT,
    salesman           TEXT,                       -- 业务员归属
    remark             TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at         TEXT,
    UNIQUE (source_type, source_id)
  );

  -- ------------------------------------------------------------------
  -- 2. 收货地址（一个客户可有多个：总部仓 / 门店 / 第三方收货点）
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_addresses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    name        TEXT NOT NULL,
    contact     TEXT,
    phone       TEXT,
    region      TEXT,
    city        TEXT,
    address     TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- ------------------------------------------------------------------
  -- 3. 订货单头（统一订货单据：门店要货与经销商订货走同一张表）
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no             TEXT UNIQUE,
    customer_id        INTEGER NOT NULL,
    -- 冗余便于旧查询兼容与数据范围过滤
    customer_type      TEXT,                        -- store / dealer
    customer_name      TEXT,                        -- 快照
    store_id           INTEGER,
    dealer_id          INTEGER,
    parent_order_id    INTEGER,                     -- 拆单来源
    order_date         TEXT NOT NULL,
    expect_date        TEXT,
    status             TEXT NOT NULL DEFAULT 'draft',
    channel            TEXT,
    region             TEXT,
    currency           TEXT NOT NULL DEFAULT 'CNY',
    total_qty          REAL NOT NULL DEFAULT 0,
    total_amount       REAL NOT NULL DEFAULT 0,
    -- 信用
    credit_hold        REAL NOT NULL DEFAULT 0,     -- 本单占用的授信额度
    credit_checked_at  TEXT,
    -- 审批
    need_approval      INTEGER NOT NULL DEFAULT 0,
    approval_reason    TEXT,
    -- 分仓
    ship_warehouse_id  INTEGER,
    ship_warehouse     TEXT,                        -- 快照名称
    allocate_note      TEXT,
    -- 来源
    source             TEXT NOT NULL DEFAULT 'web', -- web/import/repeat/mcp/seed
    source_ref         TEXT,                        -- 历史单号等外部引用
    remark             TEXT,
    org_id             INTEGER,
    creator_id         INTEGER,
    creator_name       TEXT,
    approver_id        INTEGER,
    approver_name      TEXT,
    approved_at        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at         TEXT
  );

  -- ------------------------------------------------------------------
  -- 4. 订货单行
  --    price_source / price_group 留痕「为什么是这个价」，避免事后只能看结果
  --    available_qty 是下单时点的可售量快照 —— 缺货是当时缺，不是现在缺
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES oc_orders(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL,
    sku_id        INTEGER NOT NULL,
    sku_code      TEXT,
    sku_name      TEXT,
    uom           TEXT,
    qty           REAL NOT NULL DEFAULT 0,
    price         REAL NOT NULL DEFAULT 0,
    amount        REAL NOT NULL DEFAULT 0,
    price_source  TEXT,
    price_group   TEXT,
    currency      TEXT NOT NULL DEFAULT 'CNY',
    available_qty REAL,
    tax_rate      REAL,
    remark        TEXT
  );

  -- ------------------------------------------------------------------
  -- 5. 审批链：不是「下单即成立」，而是按规则触发
  --    规则命中后把该走的节点预先展开成行，审批过程可查、可追责
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_approval_rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    scope         TEXT NOT NULL DEFAULT 'global',   -- global / channel / customer
    channel       TEXT,
    customer_id   INTEGER,
    cond_field    TEXT NOT NULL,                    -- amount / qty / credit_over / no_credit
    cond_op       TEXT NOT NULL DEFAULT '>',        -- > >= < <= == !=
    cond_value    REAL,
    seq           INTEGER NOT NULL DEFAULT 1,
    node          TEXT NOT NULL,
    approver_role TEXT NOT NULL,
    priority      INTEGER NOT NULL DEFAULT 100,
    status        TEXT NOT NULL DEFAULT 'active',
    remark        TEXT
  );

  CREATE TABLE IF NOT EXISTS oc_order_approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES oc_orders(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL DEFAULT 1,
    node          TEXT NOT NULL,
    rule_code     TEXT,
    approver_role TEXT,
    approver_id   INTEGER,
    approver_name TEXT,
    decision      TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/skipped
    reason        TEXT,
    decided_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- ------------------------------------------------------------------
  -- 6. 信用占用流水
  --    额度怎么被用掉的，必须能一笔一笔查出来。
  --    balance_after 只是留痕快照，权威值永远由 SUM(amount) 现算。
  --    变动类型只有四种，口径是「额度 = 未回款金额的上限」：
  --      occupy 下单占用(+) / release 取消或驳回释放(−) / repay 回款释放(−) / adjust 人工调额(±)
  --    收货**不**释放额度 —— 货发了钱没回，额度还在被占。
  --    （一度在收货时也释放一次，与回款释放重叠 → 同一笔钱放两次额度，已修正。）
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_credit_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL,
    order_id     INTEGER,
    doc_no       TEXT,
    change_type  TEXT NOT NULL,                     -- occupy/release/repay/adjust
    amount       REAL NOT NULL DEFAULT 0,           -- 正数占用，负数释放
    balance_after REAL,
    operator     TEXT,
    remark       TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- ------------------------------------------------------------------
  -- 7. 对账单（B2B 主功能）
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_statements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no        TEXT UNIQUE,
    customer_id   INTEGER NOT NULL,
    customer_name TEXT,
    period_start  TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'CNY',
    order_count   INTEGER NOT NULL DEFAULT 0,
    total_amount  REAL NOT NULL DEFAULT 0,
    paid_amount   REAL NOT NULL DEFAULT 0,
    diff_amount   REAL NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'draft',    -- draft/confirmed/closed
    confirmed_by  TEXT,
    confirmed_at  TEXT,
    remark        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS oc_statement_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id  INTEGER NOT NULL REFERENCES oc_statements(id) ON DELETE CASCADE,
    order_id      INTEGER,
    doc_no        TEXT,
    order_date    TEXT,
    amount        REAL NOT NULL DEFAULT 0,
    paid_amount   REAL NOT NULL DEFAULT 0,
    diff_amount   REAL NOT NULL DEFAULT 0,
    remark        TEXT
  );

  -- ------------------------------------------------------------------
  -- 8. 可见性规则：同一商品不同客户看到不同（等级/渠道控制）
  --    allowed=0 表示该维度组合下隐藏该品类
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS oc_visibility_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL DEFAULT 'level',      -- level / channel / customer
    scope_value TEXT NOT NULL,
    category_id INTEGER,
    brand_id    INTEGER,
    allowed     INTEGER NOT NULL DEFAULT 1,
    priority    INTEGER NOT NULL DEFAULT 100,
    remark      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_oc_cust_src    ON oc_customers(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_oc_cust_parent ON oc_customers(parent_customer_id);
  CREATE INDEX IF NOT EXISTS idx_oc_cust_status ON oc_customers(admit_status);
  CREATE INDEX IF NOT EXISTS idx_oc_addr_cust   ON oc_addresses(customer_id);
  CREATE INDEX IF NOT EXISTS idx_oc_ord_cust    ON oc_orders(customer_id, id);
  CREATE INDEX IF NOT EXISTS idx_oc_ord_status  ON oc_orders(status);
  CREATE INDEX IF NOT EXISTS idx_oc_ord_date    ON oc_orders(order_date);
  CREATE INDEX IF NOT EXISTS idx_oc_ord_scope   ON oc_orders(store_id, dealer_id);
  CREATE INDEX IF NOT EXISTS idx_oc_item_ord    ON oc_order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_oc_item_sku    ON oc_order_items(sku_id);
  CREATE INDEX IF NOT EXISTS idx_oc_appr_ord    ON oc_order_approvals(order_id, seq);
  CREATE INDEX IF NOT EXISTS idx_oc_credit_cust ON oc_credit_ledger(customer_id, id);
  CREATE INDEX IF NOT EXISTS idx_oc_stmt_cust   ON oc_statements(customer_id, period_end);
  CREATE INDEX IF NOT EXISTS idx_oc_stmtitem    ON oc_statement_items(statement_id);
`

module.exports.up = function up(db) {
  db.exec(TABLES)

  // ---------- 存量订货单统一视图 ----------
  // 门店要货（store_requisitions）与经销商要货（dealer_requisitions）此前是两张表、两套口径。
  // 本视图把它们按订货中心的形状并起来，只读、不改数据 ——
  // 目的是「一个入口看得见全部历史」，而不是再复制一份历史（复制会产生第二真相）。
  try {
    db.exec(`
      CREATE VIEW IF NOT EXISTS oc_orders_history AS
        SELECT 'store' AS source_type, r.id AS legacy_id, r.doc_no, r.store_id AS party_id,
               s.name AS party_name, r.req_date AS order_date, r.expect_date, r.status,
               r.total_qty, r.total_amount, r.urgency, r.remark, 'legacy-store' AS origin
          FROM store_requisitions r LEFT JOIN stores s ON s.id = r.store_id
        UNION ALL
        SELECT 'dealer', r.id, r.doc_no, r.dealer_id,
               d.name, r.req_date, r.expect_date, r.status,
               r.total_qty, r.total_amount, NULL, r.remark, 'legacy-dealer'
          FROM dealer_requisitions r LEFT JOIN dealers d ON d.id = r.dealer_id
    `)
  } catch (e) {
    // 老库若还没有这两张表，视图留到下次重跑再建（新增库不会走到这里）
    console.warn('[010] oc_orders_history 视图创建跳过：', e.message)
  }

  // 列级补强：早期库可能已建过部分表，缺列则补（幂等）
  const columns = [
    ['oc_customers', 'min_order_qty'], ['oc_customers', 'min_order_amount'],
    ['oc_customers', 'salesman'], ['oc_customers', 'frozen_reason'],
    ['oc_customers', 'allow_shortage'],
    ['oc_orders', 'credit_hold'], ['oc_orders', 'credit_checked_at'],
    ['oc_orders', 'need_approval'], ['oc_orders', 'approval_reason'],
    ['oc_orders', 'ship_warehouse_id'], ['oc_orders', 'parent_order_id'],
    ['oc_orders', 'source_ref'], ['oc_orders', 'approver_name']
  ]
  for (const [t, c] of columns) {
    if (tableExists(db, t) && !hasColumn(db, t, c)) {
      // 类型按列名给个保守默认；这些列都是历史库才可能缺，新库由上面的 CREATE 带出
      const decl =
        c === 'allow_shortage' ? 'INTEGER NOT NULL DEFAULT 1'
        : c === 'need_approval' ? 'INTEGER NOT NULL DEFAULT 0'
        : /_at$/.test(c) ? 'TEXT'
        : 'REAL'
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${decl}`)
    }
  }

  // ---------- 权限点对齐 ----------
  // 订货中心把「门店要货」与「经销商订货」合一后，门店店长也需要订货权限 ——
  // 原 order.place / order.view / order.statement.view 只给了 dealer 与 sales，
  // 店长若没有这三个点，门店侧在订货中心里会「看得到菜单、点不动下单」。
  const permTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permissions'")
    .get()
  const rolePermTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='role_permissions'")
    .get()
  let permGranted = 0
  if (permTable && rolePermTable) {
    const existsPerm = db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?')
    const insPerm = db.prepare('INSERT INTO permissions (code,name,module,sort_order) VALUES (?,?,?,?)')
    const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
    const grants = [
      ['order.place', '下单订货', 'store'],
      ['order.view', '查看订货单', 'store'],
      ['order.statement.view', '查看对账单', 'store'],
      ['order.view', '查看订货单', 'warehouse'],
      ['order.view', '查看订货单', 'finance']
    ]
    for (const [code, name, role] of grants) {
      if (!existsPerm.get(code)) {
        insPerm.run(code, name, 'order', 500)
        permGranted += 1
      }
      const r = insRole.run(role, code)
      permGranted += r.changes
    }
  }

  return {
    tables: 9,
    permGranted,
    note: '结构迁移；单据定义归 008 单据内核（OC / OCS 两个新类型）'
  }
}

// 结构自检：表在 + 关键列在。缺任一即重跑（up 幂等）
module.exports.verify = function verify(db) {
  const need = [
    'oc_customers', 'oc_addresses', 'oc_orders', 'oc_order_items',
    'oc_approval_rules', 'oc_order_approvals', 'oc_credit_ledger',
    'oc_statements', 'oc_statement_items', 'oc_visibility_rules'
  ]
  for (const t of need) if (!tableExists(db, t)) return false

  const cols = [
    ['oc_customers', 'admit_status'], ['oc_customers', 'parent_customer_id'],
    ['oc_customers', 'credit_limit'], ['oc_customers', 'min_order_amount'],
    ['oc_customers', 'allow_shortage'],
    ['oc_orders', 'customer_id'], ['oc_orders', 'status'], ['oc_orders', 'credit_hold'],
    ['oc_orders', 'need_approval'], ['oc_orders', 'ship_warehouse_id'],
    ['oc_order_items', 'available_qty'], ['oc_order_items', 'price_source'],
    ['oc_credit_ledger', 'change_type'], ['oc_statements', 'diff_amount'],
    ['oc_approval_rules', 'cond_field']
  ]
  for (const [t, c] of cols) if (!hasColumn(db, t, c)) return false

  // 存量统一视图：缺了要重建（历史单据的「一个入口」靠它）
  const view = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='oc_orders_history'").get()
  if (!view) return false
  return true
}
