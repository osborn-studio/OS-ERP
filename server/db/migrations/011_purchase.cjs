'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/011_purchase.cjs ｜ 迁移：采购域 请购/发票/结算/付款 + 供货目录
 * ============================================================================
 * 【职责】迁移：采购域 请购/发票/结算/付款 + 供货目录
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 011 采购域（模块 07）：请购 → 采购订单 → 到货单 → 入库 → 发票 → 结算 → 付款
//
// 背景（模块 07 要补的缺口）：
//   现有采购只有「订单 + 收货单 + 退货单」三张单，主链路的中段与后段是空的：
//     前段缺「请购单」——门店零星自采没有申请载体，只能直接建采购订单；
//     后段缺「发票 → 结算 → 付款」——货到了、钱没算，应付账款无处落。
//   结果是采购只做到「收货」，做不到「算清账」。
//
// 本迁移只做**结构与权限**；单据类型 / 状态机 / 业务流定义归 008 单据内核：
//   新增 4 个类型 PRQ 请购单 / PI 采购发票 / PST 采购结算单 / PAY 付款单，
//   并把 FLOW_PURCHASE 从 5 环节扩到 9 环节。
//   （定义写在 008 而不是这里，是因为 008 有定义指纹自愈，会被重跑修复；
//     写在 011 里会被 008 的自愈当成「未登记的旧定义」抹掉。模块 12A 已踩过这条。）
//
// 顺带给 purchase_orders 补上三组列：
//   trade_type 交易类型（用友口径：同一张单可有多个交易类型）
//   四段关闭 close_arrival / close_inbound / close_invoice / close_payment
//   超量控制 over_receive_ratio + 后段金额快照（invoice_amount / settle_amount / paid_amount）

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '采购域 请购/发票/结算/付款 + 供货目录'

// ---------------------------------------------------------------------------
// 一、DDL
// ---------------------------------------------------------------------------
const DDL = `
-- ================= 1. 请购单（用友口径：请购单 → 采购订单）=================
-- 请购的来源可以不是采购部：门店零星自采、生产补料、部门申购都要走这里，
-- 所以申请人用 applicant_type / applicant_id 表达主体，而不是只有一个 creator。
CREATE TABLE IF NOT EXISTS purchase_requisitions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    org_id            INTEGER,
    trade_type        TEXT NOT NULL DEFAULT 'normal',   -- normal 普通请购 / store 门店自采 / urgent 紧急请购
    req_date          TEXT NOT NULL,
    expect_date       TEXT,                             -- 期望到货日（驱动采购订单的 expect_date）
    warehouse_id      INTEGER,                          -- 拟入库仓
    supplier_id       INTEGER,                          -- 建议供应商（可空，仅作参考）
    applicant_type    TEXT NOT NULL DEFAULT 'org',      -- org 部门 / store 门店 / warehouse 仓库
    applicant_id      INTEGER,
    applicant_name    TEXT,
    department        TEXT,
    purpose           TEXT,                             -- 补货 / 新品 / 门店自采 / 工程 / 其他
    urgency           TEXT NOT NULL DEFAULT 'normal',   -- low / normal / high
    status            TEXT NOT NULL DEFAULT 'draft',
    total_qty         REAL NOT NULL DEFAULT 0,
    total_amount      REAL NOT NULL DEFAULT 0,
    budget_amount     REAL,                             -- 预算金额（超预算时可提示，不硬拦）
    source            TEXT NOT NULL DEFAULT 'manual',   -- manual / auto / demand / pos
    source_ref        TEXT,
    converted_order_id INTEGER,                         -- 转出的采购订单
    converted_order_no TEXT,
    converted_at      TEXT,
    reason            TEXT,                             -- 驳回原因
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    approved_by       INTEGER,
    approved_by_name  TEXT,
    approved_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_prq_status ON purchase_requisitions(status, req_date);
CREATE INDEX IF NOT EXISTS idx_prq_applicant ON purchase_requisitions(applicant_type, applicant_id);

CREATE TABLE IF NOT EXISTS purchase_requisition_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    req_id        INTEGER NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL DEFAULT 1,
    sku_id        INTEGER NOT NULL,
    qty           REAL NOT NULL DEFAULT 0,
    price         REAL NOT NULL DEFAULT 0,              -- 预估单价（取价链的结果，可人工改）
    amount        REAL NOT NULL DEFAULT 0,
    need_date     TEXT,
    converted_qty REAL NOT NULL DEFAULT 0,              -- 已转采购订单的数量（支持部分转单）
    purpose       TEXT,
    remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_prq_item_req ON purchase_requisition_items(req_id);

-- ================= 2. 采购发票 =================
-- 发票是「应付的起点」：有票才有账可结。费用发票（运费/关税）走同一个表，
-- 用 invoice_type='fee' 区分，行上填 fee_type —— 三单结算里的「费用折扣结算」靠它。
CREATE TABLE IF NOT EXISTS purchase_invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no         TEXT NOT NULL UNIQUE,
    invoice_no     TEXT,                                  -- 外部票号（供应商开的票）
    invoice_type   TEXT NOT NULL DEFAULT 'vat_special',   -- vat_special 专票 / vat_normal 普票 / proforma 形式发票 / fee 费用发票
    org_id         INTEGER,
    supplier_id    INTEGER NOT NULL,
    order_id       INTEGER,                               -- 关联采购订单（可空：允许无源单发票）
    order_no       TEXT,
    receipt_id     INTEGER,
    settle_id      INTEGER,                               -- 被哪张结算单纳入
    invoice_date   TEXT NOT NULL,
    period         TEXT,                                  -- 归属期 YYYY-MM
    currency       TEXT NOT NULL DEFAULT 'CNY',
    amount         REAL NOT NULL DEFAULT 0,               -- 不含税金额
    tax_rate       REAL NOT NULL DEFAULT 13,
    tax_amount     REAL NOT NULL DEFAULT 0,
    total_amount   REAL NOT NULL DEFAULT 0,               -- 价税合计
    status         TEXT NOT NULL DEFAULT 'draft',
    verify_by      INTEGER,
    verify_by_name TEXT,
    verify_at      TEXT,
    post_by        INTEGER,
    post_at        TEXT,
    voucher_no     TEXT,
    remark         TEXT,
    created_by     INTEGER,
    created_by_name TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pinv_supplier ON purchase_invoices(supplier_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_pinv_status ON purchase_invoices(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pinv_no ON purchase_invoices(supplier_id, invoice_no) WHERE invoice_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id    INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL DEFAULT 1,
    sku_id        INTEGER,
    order_item_id INTEGER,                                -- 指向 purchase_order_items.id（三单匹配的锚点）
    receipt_id    INTEGER,
    qty           REAL NOT NULL DEFAULT 0,
    price         REAL NOT NULL DEFAULT 0,
    amount        REAL NOT NULL DEFAULT 0,
    tax_rate      REAL NOT NULL DEFAULT 13,
    tax_amount    REAL NOT NULL DEFAULT 0,
    total_amount  REAL NOT NULL DEFAULT 0,
    fee_type      TEXT,                                   -- 运费 / 关税 / 加工费（费用发票行专用）
    remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pinv_item ON purchase_invoice_items(invoice_id);

-- ================= 3. 采购结算单（三单匹配）=================
-- 用友口径三种结算方式：自动结算 / 手工结算 / 费用折扣结算（三单：入库单+采购发票+费用发票）。
-- 核心输出是 settle_amount（应付金额）与 diff_amount（暂估差异 = 入库金额 − 发票金额）。
-- 入库时按订单价暂估，发票来了才对上；差异进存货核算（模块 09）。
CREATE TABLE IF NOT EXISTS purchase_settlements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no         TEXT NOT NULL UNIQUE,
    org_id         INTEGER,
    supplier_id    INTEGER NOT NULL,
    settle_date    TEXT NOT NULL,
    period_start   TEXT,
    period_end     TEXT,
    settle_mode    TEXT NOT NULL DEFAULT 'auto',          -- auto 自动 / manual 手工 / fee 费用折扣
    order_count    INTEGER NOT NULL DEFAULT 0,
    invoice_count  INTEGER NOT NULL DEFAULT 0,
    order_amount   REAL NOT NULL DEFAULT 0,               -- 订单金额
    receipt_amount REAL NOT NULL DEFAULT 0,               -- 入库金额（暂估口径）
    invoice_amount REAL NOT NULL DEFAULT 0,               -- 采购发票金额
    fee_amount     REAL NOT NULL DEFAULT 0,               -- 费用发票金额
    settle_amount  REAL NOT NULL DEFAULT 0,               -- 应付金额
    paid_amount    REAL NOT NULL DEFAULT 0,               -- 已付金额（付款核销累加）
    diff_amount    REAL NOT NULL DEFAULT 0,               -- 暂估差异
    status         TEXT NOT NULL DEFAULT 'draft',
    audited_by     INTEGER,
    audited_by_name TEXT,
    audited_at     TEXT,
    settled_at     TEXT,
    remark         TEXT,
    created_by     INTEGER,
    created_by_name TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pset_supplier ON purchase_settlements(supplier_id, settle_date);
CREATE INDEX IF NOT EXISTS idx_pset_status ON purchase_settlements(status);

CREATE TABLE IF NOT EXISTS purchase_settlement_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    settle_id     INTEGER NOT NULL REFERENCES purchase_settlements(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL DEFAULT 1,
    source_type   TEXT NOT NULL,                          -- order 采购订单 / receipt 入库单 / invoice 采购发票 / fee 费用发票
    source_id     INTEGER,
    source_doc_no TEXT,
    sku_id        INTEGER,
    qty           REAL NOT NULL DEFAULT 0,
    price         REAL NOT NULL DEFAULT 0,
    amount        REAL NOT NULL DEFAULT 0,
    tax_amount    REAL NOT NULL DEFAULT 0,
    fee_amount    REAL NOT NULL DEFAULT 0,                -- 摊到该行的费用
    final_cost    REAL NOT NULL DEFAULT 0,                -- 摊费用后的最终入库成本单价
    remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pset_item ON purchase_settlement_items(settle_id);

-- ================= 4. 付款单 =================
-- 付款单不直接改结算单的状态，而是写核销明细（purchase_payment_items）后回写 paid_amount。
-- 口径与订货中心的授信一致：**核销明细是唯一真相**，单头上的 paid_amount 只是快照。
CREATE TABLE IF NOT EXISTS purchase_payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no         TEXT NOT NULL UNIQUE,
    org_id         INTEGER,
    supplier_id    INTEGER NOT NULL,
    pay_date       TEXT NOT NULL,
    pay_type       TEXT NOT NULL DEFAULT 'transfer',      -- transfer 电汇 / accept 承兑 / cash 现金 / prepay 预付
    currency       TEXT NOT NULL DEFAULT 'CNY',
    amount         REAL NOT NULL DEFAULT 0,               -- 付款金额
    settled_amount REAL NOT NULL DEFAULT 0,               -- 已核销金额
    settle_count   INTEGER NOT NULL DEFAULT 0,            -- 核销了几张结算单
    status         TEXT NOT NULL DEFAULT 'draft',
    bank_account   TEXT,
    voucher_no     TEXT,
    remark         TEXT,
    created_by     INTEGER,
    created_by_name TEXT,
    approved_by    INTEGER,
    approved_by_name TEXT,
    approved_at    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ppay_supplier ON purchase_payments(supplier_id, pay_date);
CREATE INDEX IF NOT EXISTS idx_ppay_status ON purchase_payments(status);

CREATE TABLE IF NOT EXISTS purchase_payment_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id    INTEGER NOT NULL REFERENCES purchase_payments(id) ON DELETE CASCADE,
    settle_id     INTEGER,
    settle_doc_no TEXT,
    amount        REAL NOT NULL DEFAULT 0,
    remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ppay_item ON purchase_payment_items(payment_id);

-- ================= 5. 供货目录 + 供应商报价（用友「供货目录」与「价格表」）=================
-- 用友的两条控制参数：供货目录（限定供应商-物料对照）与最小起订量。
-- 本表同时承载三件事：是否可供 / 协议价 / 最小起订量 + 交期。
-- is_available = 0 是**显式的不可供**，与「没登记」不是一回事：
--   没登记 = 未维护目录，不拦；登记为 0 = 明确不供该料，下单时拦。
CREATE TABLE IF NOT EXISTS supplier_products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id     INTEGER NOT NULL,
    sku_id          INTEGER NOT NULL,
    is_available    INTEGER NOT NULL DEFAULT 1,
    price           REAL,                                 -- 协议价（价格表的当前生效价）
    currency        TEXT NOT NULL DEFAULT 'CNY',
    min_order_qty   REAL NOT NULL DEFAULT 0,              -- 最小起订量
    lead_time_days  INTEGER NOT NULL DEFAULT 0,           -- 交期
    last_price      REAL,                                 -- 最近一次采购价（收货时回写，供「最新采购价」取价）
    last_price_date TEXT,
    valid_from      TEXT,
    valid_to        TEXT,
    remark          TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT,
    UNIQUE (supplier_id, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_supprod_sku ON supplier_products(sku_id);

-- 取价留痕：采购价改成什么样、谁改的、依据是什么，要能回查（对齐模块 05A 的调价留痕）
CREATE TABLE IF NOT EXISTS supplier_price_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    sku_id      INTEGER NOT NULL,
    old_price   REAL,
    new_price   REAL,
    source      TEXT NOT NULL DEFAULT 'manual',           -- manual 人工维护 / receipt 收货回写 / import 导入
    doc_no      TEXT,
    operator    TEXT,
    remark      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_supprlog ON supplier_price_logs(supplier_id, sku_id, id);
`

// ---------------------------------------------------------------------------
// 二、purchase_orders 补列
// ---------------------------------------------------------------------------
const PO_COLUMNS = [
  ['trade_type', "TEXT NOT NULL DEFAULT 'normal'", '交易类型：normal 普通采购 / return 退货订单 / asset 固定资产采购 / consign 寄售'],
  ['over_receive_ratio', 'REAL NOT NULL DEFAULT 0.1', '超量控制上限比例（0 = 不允许超收）'],
  ['close_arrival', 'INTEGER NOT NULL DEFAULT 0', '到货关闭'],
  ['close_inbound', 'INTEGER NOT NULL DEFAULT 0', '入库关闭'],
  ['close_invoice', 'INTEGER NOT NULL DEFAULT 0', '开票关闭'],
  ['close_payment', 'INTEGER NOT NULL DEFAULT 0', '付款关闭'],
  ['source_req_id', 'INTEGER', '来源请购单 id'],
  ['source_req_no', 'TEXT', '来源请购单号'],
  ['invoice_amount', 'REAL NOT NULL DEFAULT 0', '已开票金额'],
  ['settle_amount', 'REAL NOT NULL DEFAULT 0', '已结算金额'],
  ['paid_amount', 'REAL NOT NULL DEFAULT 0', '已付款金额'],
  ['req_id', 'INTEGER', '来源请购单（冗余，供索引与过滤）']
]

// purchase_receipts 补列：四段关闭里的「入库关闭」+ 关联请购
const RECEIPT_COLUMNS = [
  ['req_id', 'INTEGER', '来源请购单 id（直采场景）'],
  ['invoice_status', "TEXT NOT NULL DEFAULT 'none'", '开票状态：none / partial / full']
]

// ---------------------------------------------------------------------------
// 三、权限点与角色分配
// ---------------------------------------------------------------------------
// 模块 05 里采购只有 5 个权限点（order.view/edit/approve、inbound、return），
// 后段四类单据一个点都没有 —— 功能上了会出现「菜单看得见、按钮点不动」。
const NEW_PERMS = [
  ['purchase.req.view', '查看请购单', 'purchase', 'menu'],
  ['purchase.req.edit', '提交请购单', 'purchase', 'action'],
  ['purchase.req.approve', '审批请购单', 'purchase', 'action'],
  ['purchase.invoice.view', '查看采购发票', 'purchase', 'menu'],
  ['purchase.invoice.edit', '录入采购发票', 'purchase', 'action'],
  ['purchase.invoice.verify', '采购发票校验', 'purchase', 'action'],
  ['purchase.settle.view', '查看采购结算', 'purchase', 'menu'],
  ['purchase.settle.edit', '生成采购结算', 'purchase', 'action'],
  ['purchase.settle.audit', '采购结算审核', 'purchase', 'action'],
  ['purchase.payment.view', '查看付款单', 'purchase', 'menu'],
  ['purchase.payment.edit', '编辑付款单', 'purchase', 'action'],
  ['purchase.payment.approve', '审批与执行付款', 'purchase', 'action'],
  ['purchase.catalog.edit', '维护供货目录与采购价', 'purchase', 'action']
]

// 角色 → 新增权限。admin 在模块 05 里是「全部权限」，但那是**当时**的全部；
// 新加的权限点必须显式补给它，否则管理员反而点不动新功能（这是很容易漏的一条）。
const ROLE_GRANTS = {
  admin: NEW_PERMS.map((p) => p[0]),
  boss: ['purchase.req.view', 'purchase.invoice.view', 'purchase.settle.view', 'purchase.payment.view'],
  purchase: NEW_PERMS.map((p) => p[0]),
  warehouse: ['purchase.req.view', 'purchase.req.edit', 'purchase.invoice.view'],
  finance: [
    'purchase.req.view', 'purchase.invoice.view', 'purchase.invoice.edit', 'purchase.invoice.verify',
    'purchase.settle.view', 'purchase.settle.edit', 'purchase.settle.audit',
    'purchase.payment.view', 'purchase.payment.edit', 'purchase.payment.approve'
  ],
  store: ['purchase.req.view', 'purchase.req.edit'],
  sales: ['purchase.req.view'],
  viewer: ['purchase.req.view', 'purchase.invoice.view', 'purchase.settle.view', 'purchase.payment.view']
}

module.exports.up = function up(db) {
  db.exec(DDL)

  for (const [col, decl] of PO_COLUMNS) addColumn(db, 'purchase_orders', col, decl)
  for (const [col, decl] of RECEIPT_COLUMNS) addColumn(db, 'purchase_receipts', col, decl)

  // —— 存量数据口径对齐 ——
  // 老库里的收货单允许「无源单收货」，这些单没有请购单来源，保持 NULL 即可。
  // 采购订单的已开票/已结算/已付款三个快照列初值为 0，不需要回填历史（历史没有这些单据）。

  // —— 权限点与角色分配 ——
  // 坑：008 单据内核跑在本迁移**之前**，它会把状态机里引用但注册表里没有的权限码
  // 自动补进 permissions（名字直接填 code、module 直接取前缀），保证「不出现有定义无权限点」。
  // 如果这里用 INSERT OR IGNORE，那些被 008 抢先插入的权限点就会永远保留占位名，
  // 界面上显示成「purchase.req.edit」而不是「提交请购单」。
  // 所以这里用 UPSERT 把名字与分组改回正确的。
  const hasPermTable = tableExists(db, 'permissions')
  const hasRolePermTable = tableExists(db, 'role_permissions')
  let permAdded = 0
  let roleGranted = 0
  if (hasPermTable) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         name=excluded.name, module=excluded.module, category=excluded.category`
    )
    NEW_PERMS.forEach((p, i) => {
      const r = upPerm.run(p[0], p[1], p[2], p[3], 3000 + i * 10)
      permAdded += r.changes
    })
    if (hasRolePermTable) {
      const insRole = db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)'
      )
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue
        for (const code of codes) roleGranted += insRole.run(role, code).changes
      }
    }
  }

  // 定义指纹：本迁移的「定义」是权限清单与角色分配，
  // 改了这两处不违反任何结构不变量，必须靠指纹才能被自检发现
  stampDef(db, '011_purchase', { perms: NEW_PERMS, roles: ROLE_GRANTS, poCols: PO_COLUMNS, rcCols: RECEIPT_COLUMNS })

  return {
    tables: 9,
    permAdded,
    roleGranted,
    note: '结构迁移；单据定义（PRQ/PI/PST/PAY + FLOW_PURCHASE 扩到 9 环节）归 008 单据内核'
  }
}

// 结构自检：表在 + 关键列在 + 权限点在 + 定义指纹一致
module.exports.verify = function verify(db) {
  const need = [
    'purchase_requisitions', 'purchase_requisition_items',
    'purchase_invoices', 'purchase_invoice_items',
    'purchase_settlements', 'purchase_settlement_items',
    'purchase_payments', 'purchase_payment_items',
    'supplier_products', 'supplier_price_logs'
  ]
  for (const t of need) if (!tableExists(db, t)) return false

  const cols = [
    ['purchase_requisitions', 'applicant_type'], ['purchase_requisitions', 'converted_order_id'],
    ['purchase_requisition_items', 'converted_qty'],
    ['purchase_invoices', 'invoice_type'], ['purchase_invoices', 'tax_amount'], ['purchase_invoices', 'settle_id'],
    ['purchase_settlements', 'settle_mode'], ['purchase_settlements', 'diff_amount'],
    ['purchase_settlements', 'paid_amount'],
    ['purchase_settlement_items', 'final_cost'], ['purchase_settlement_items', 'source_type'],
    ['purchase_payments', 'settled_amount'], ['purchase_payments', 'pay_type'],
    ['purchase_payment_items', 'settle_id'],
    ['supplier_products', 'is_available'], ['supplier_products', 'min_order_qty'],
    ['supplier_products', 'last_price'],
    ['purchase_orders', 'trade_type'], ['purchase_orders', 'close_invoice'],
    ['purchase_orders', 'over_receive_ratio'], ['purchase_orders', 'paid_amount'],
    ['purchase_receipts', 'invoice_status']
  ]
  for (const [t, c] of cols) if (!hasColumn(db, t, c)) return false

  // 权限点：缺了要补齐（否则新功能「看得见点不动」），名字被 008 占位也要改回来
  if (tableExists(db, 'permissions')) {
    const hit = db.prepare('SELECT name, module FROM permissions WHERE code=?')
    for (const p of NEW_PERMS) {
      const row = hit.get(p[0])
      if (!row) return false
      if (row.name !== p[1] || row.module !== p[2]) return false
    }
  }

  // 定义指纹
  if (defStale(db, '011_purchase', { perms: NEW_PERMS, roles: ROLE_GRANTS, poCols: PO_COLUMNS, rcCols: RECEIPT_COLUMNS })) {
    return false
  }
  return true
}
