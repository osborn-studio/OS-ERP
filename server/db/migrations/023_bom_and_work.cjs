'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/023_bom_and_work.cjs ｜ 迁移：BOM 与报工领料：BOM 展开 / 生产领料 / 完工汇报
 * ============================================================================
 * 【职责】迁移：BOM 与报工领料：BOM 展开 / 生产领料 / 完工汇报
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 023 BOM 与报工领料（模块 10B）
//
// 本迁移补的是**「投入什么、产出什么」的账**。此前生产域只有一张 `production_orders`：
// 能开单、能改状态，但**没有任何地方记录「料是怎么出的、工是怎么算的」** ——
//   · 生产订单点「完工入库」只改状态，库存一分没动；
//   · 材料成本靠人工往 `material_cost` 字段里填，填多填少没人校验；
//   · 同一张 BOM 在采购、委外、促销、成本四处各描述一遍，改一处漏三处。
//
// 本迁移落三件事：
//   ① **一个 BOM**（`boms` + `bom_items`）—— 组合装、自制、委外三种用途**共用同一张表**，
//      靠 `usage` 区分。第二轮已定案「组合装并入统一 BOM」，不合并的话每加一处取料口径
//      就要写四遍。用量、损耗率、替代组在这里，BOM 展开只有这一个入口。
//   ② **领料有单据**（`material_issues` + `material_issue_items`，内核注册 `MR`）——
//      领料是**真的出库**，必须是一张可审批、可追溯、能反查库存流水的单。
//   ③ **完工有汇报**（`work_reports`）—— 良品/不良/工时/人工与制造费用。
//
// 关于 `WR`（报工单）—— 这里有一个**撞码**必须说清楚：
//   计划书原写「内核注册 MR（领料单）、WR（报工单）」，但 `WR` 早已被
//   **「委外收货单」**占用（见 008 的 DOC_TYPES）。按原计划注册会**静默覆盖**，
//   委外收货单会与报工单共用一个类型码 —— 这正是计划书风险表里
//   「新增类型前全库检索短码」要防的事。
//   同时第三轮口径确认 G4 已定案：**生产不报工**（只做领料 + 完工入库）。
//   两条合起来，本模块**不注册独立报工单据类型**：
//   `work_reports` 定位为**完工汇报明细** —— 有单号、可追溯，
//   但**不推进状态、不进审批**，它是「完工入库」这一动作的输入与凭证。
//   这样「不报工」的口径守住了，「料工费可归集」也不至于无处落账。
//
// 一条口径（写死在库结构里，不靠人自觉）：
//   **同一母件 + 同一用途只能有一个 BOM** —— `UNIQUE (product_sku_id, usage)`。
//   第二轮原话「母件 BOM 只有一个版本」如果只是约定，就会出现两个人都建了一版、
//   各领各的料，而系统两个都认。唯一约束让「换版」只能表现为**作废旧版 + 新建新版**，
//   取料口径永远只有一个答案。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = 'BOM 与报工领料：BOM 展开 / 生产领料 / 完工汇报'

const TABLES = [
  // ---------- BOM 主档 ----------
  // `usage` 三值：self_made 自制 / outsourced 委外 / combo 组合装。
  // 合并成一张表的核心收益是**取料只有一个入口**：`bom_items` 的展开算法
  // 不关心母件是自制还是组合，只看用量与损耗率。
  `CREATE TABLE IF NOT EXISTS boms (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    product_sku_id   INTEGER NOT NULL,
    product_sku_code TEXT,
    product_sku_name TEXT,
    version          TEXT NOT NULL DEFAULT 'V1.0',
    usage            TEXT NOT NULL DEFAULT 'self_made',   -- self_made / outsourced / combo
    base_qty         REAL NOT NULL DEFAULT 1,             -- 本次 BOM 的产出基准（产出 base_qty 件母件）
    produce_way      TEXT NOT NULL DEFAULT 'self_made',   -- 生产/委外，供生产订单带出默认值
    warehouse_id     INTEGER,                             -- 建议生产仓（央厨车间/组装间）
    status           TEXT NOT NULL DEFAULT 'draft',       -- draft / approved / obsolete
    effective_from   TEXT,                                -- 生效日期（含）
    effective_to     TEXT,                                -- 失效日期（含）
    audited_by       INTEGER,
    audited_by_name  TEXT,
    audited_at       TEXT,
    audit_remark     TEXT,
    item_count       INTEGER NOT NULL DEFAULT 0,
    remark           TEXT,
    created_by       INTEGER,
    created_by_name  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (product_sku_id, usage)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_boms_sku ON boms(product_sku_id, usage)`,
  `CREATE INDEX IF NOT EXISTS idx_boms_status ON boms(status, effective_from)`,

  // ---------- BOM 组件 ----------
  // `qty` 是**产出 base_qty 件母件的用量**，不是「每件母件的用量」——
  // 两者差一个除法，而除法在整数场景下会产生「每件 0.333 个」这种没法发料的结果。
  // 基准批量把小数收敛在 BOM 里，展开时按 `qty × 生产数量 / base_qty` 还原。
  //
  // `substitute_group` + `priority` 是**替代料**：同组内互为替代，`priority=0` 是主料。
  // 展开时同组只取一个 —— 取哪个由「库存够不够」决定（见 lib/bom.js），
  // 而**不是**按字母序或插入顺序（那种取法在演示时看着对、在生产时不可解释）。
  `CREATE TABLE IF NOT EXISTS bom_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id           INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
    line_no          INTEGER NOT NULL,
    sku_id           INTEGER NOT NULL,
    sku_code         TEXT,
    sku_name         TEXT,
    spec             TEXT,
    unit             TEXT,
    qty              REAL NOT NULL DEFAULT 0,             -- 基准用量（产出 base_qty 件所需）
    loss_rate        REAL NOT NULL DEFAULT 0,             -- 损耗率，0.05 = 5%
    substitute_group TEXT,                                -- 替代组（同组互为替代）
    priority         INTEGER NOT NULL DEFAULT 0,          -- 替代优先级，0 为主料
    issue_way        TEXT NOT NULL DEFAULT 'by_bom',      -- by_bom 按 BOM / manual 手工指定
    remark           TEXT,
    UNIQUE (bom_id, line_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bomit_bom ON bom_items(bom_id, line_no)`,
  `CREATE INDEX IF NOT EXISTS idx_bomit_sku ON bom_items(sku_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bomit_sub ON bom_items(bom_id, substitute_group, priority)`,

  // ---------- 生产领料单（内核 MR） ----------
  // `issue_type` 三值：by_bom 按 BOM 领料 / limit 限额领料 / supplement 补料。
  // 「补料」是真实需求：一批料领出来报废了几件，得再领一次。
  // 若不给它一个类型，补料就会被记成第二张「正常领料」，超领这件事就看不见了。
  `CREATE TABLE IF NOT EXISTS material_issues (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no           TEXT NOT NULL UNIQUE,
    order_id         INTEGER NOT NULL,
    order_no         TEXT,
    org_id           INTEGER,
    warehouse_id     INTEGER NOT NULL,
    issue_date       TEXT NOT NULL,
    issue_type       TEXT NOT NULL DEFAULT 'by_bom',      -- by_bom / limit / supplement
    status           TEXT NOT NULL DEFAULT 'draft',       -- draft/submitted/approved/issued/cancelled
    plan_qty         REAL NOT NULL DEFAULT 0,             -- 计划领料量合计（BOM 展开值）
    total_qty        REAL NOT NULL DEFAULT 0,             -- 实际领料量合计
    total_amount     REAL NOT NULL DEFAULT 0,             -- 材料成本合计（出库时计价）
    item_count       INTEGER NOT NULL DEFAULT 0,
    issued_by        INTEGER,
    issued_by_name   TEXT,
    issued_at        TEXT,
    remark           TEXT,
    created_by       INTEGER,
    created_by_name  TEXT,
    submitted_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mi_order ON material_issues(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mi_status ON material_issues(status, issue_date)`,
  `CREATE INDEX IF NOT EXISTS idx_mi_wh ON material_issues(warehouse_id, issue_date)`,

  // ---------- 领料单行 ----------
  // `plan_qty`（BOM 展开的需求）与 `qty`（本次实发）**都保留**：
  // 只留实发的话，「该领 100 只领了 60」这件事在完成之后就查不出来了，
  // 而这正是「为什么这批成本偏低」的答案。
  `CREATE TABLE IF NOT EXISTS material_issue_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id       INTEGER NOT NULL REFERENCES material_issues(id) ON DELETE CASCADE,
    line_no        INTEGER NOT NULL,
    sku_id         INTEGER NOT NULL,
    sku_code       TEXT,
    sku_name       TEXT,
    spec           TEXT,
    unit           TEXT,
    batch_no       TEXT NOT NULL DEFAULT '',
    plan_qty       REAL NOT NULL DEFAULT 0,
    qty            REAL NOT NULL DEFAULT 0,               -- 本次实发数量
    issued_qty     REAL NOT NULL DEFAULT 0,               -- 实际出库数量（issued 时落地）
    unit_cost      REAL NOT NULL DEFAULT 0,
    amount         REAL NOT NULL DEFAULT 0,
    substitute_for INTEGER,                               -- 若为替代料，指向被替代的行
    remark         TEXT,
    UNIQUE (issue_id, line_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mii_issue ON material_issue_items(issue_id, line_no)`,
  `CREATE INDEX IF NOT EXISTS idx_mii_sku ON material_issue_items(sku_id, batch_no)`,

  // ---------- 完工汇报（不注册内核类型，见文件头说明） ----------
  // 一张生产订单可以分多次完工（分批复检、分批入库），所以它是**多行**记录。
  // `good_qty` 是入库依据、`defect_qty` 不入库但要留痕 ——
  // 「做 100 个坏了 8 个」与「做了 92 个」是两件完全不同的事：
  // 前者要归因、要看不良率，后者只能看到一个偏低的产量。
  //
  // 成本归集落在本表的四个成本字段上，`material_cost` 由完工时按良品数分摊领料成本而来，
  // 而不是让生产订单自己去猜 —— 分摊规则只有这一处，账才对得上。
  `CREATE TABLE IF NOT EXISTS work_reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no          TEXT NOT NULL UNIQUE,
    order_id        INTEGER NOT NULL,
    order_no        TEXT,
    issue_id        INTEGER,                              -- 本次完工消耗的领料单
    report_date     TEXT NOT NULL,
    process_name    TEXT,                                 -- 工序名（可空，轻量）
    good_qty        REAL NOT NULL DEFAULT 0,
    defect_qty      REAL NOT NULL DEFAULT 0,
    work_hours      REAL NOT NULL DEFAULT 0,
    labor_rate      REAL NOT NULL DEFAULT 0,              -- 元/小时
    labor_cost      REAL NOT NULL DEFAULT 0,
    overhead_cost   REAL NOT NULL DEFAULT 0,              -- 制造费用分摊
    material_cost   REAL NOT NULL DEFAULT 0,
    unit_cost       REAL NOT NULL DEFAULT 0,              -- 本次入库单位成本
    warehouse_id    INTEGER,
    batch_no        TEXT NOT NULL DEFAULT '',
    stock_done      INTEGER NOT NULL DEFAULT 0,           -- 是否已完工入库
    stock_doc_no    TEXT,
    operator_id     INTEGER,
    operator_name   TEXT,
    remark          TEXT,
    created_by      INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wr_order ON work_reports(order_id, report_date)`,
  `CREATE INDEX IF NOT EXISTS idx_wr_date ON work_reports(report_date)`,
  `CREATE INDEX IF NOT EXISTS idx_wr_stock ON work_reports(stock_done)`
]

// 视图一：**已审批的 BOM 清单**。
// 「取哪个 BOM」这件事必须只有一处口径。写在 JS 里意味着每个调用点都要各写一遍
// `status='approved'`，漏一处就会把草稿 BOM 拿去发料 —— 而草稿的用量是还没审的。
const VIEWS = [
  `CREATE VIEW IF NOT EXISTS v_bom_effective AS
     SELECT b.id AS bom_id, b.code AS bom_code, b.product_sku_id, b.product_sku_code,
            b.usage, b.version, b.base_qty, b.produce_way, b.warehouse_id,
            b.effective_from, b.effective_to, b.status,
            (SELECT COUNT(*) FROM bom_items i WHERE i.bom_id = b.id) AS item_count,
            (SELECT COUNT(DISTINCT i.substitute_group) FROM bom_items i
              WHERE i.bom_id = b.id AND i.substitute_group IS NOT NULL) AS sub_group_count
       FROM boms b
      WHERE b.status = 'approved'`,
  // 视图二：**在制进度与料工费归集**。
  // 把「领了多少、完工多少、料工费各多少」放在一张视图里，是因为这四个数字
  // 分散在四张表（material_issues / material_issue_items / work_reports / production_orders），
  // 而任何一个界面上要看的都是它们的**对比**（领了 100、完工 80 => 还有 20 件在制）。
  // 各查各的再在前端相减，界面一改口径就不一致了。
  `CREATE VIEW IF NOT EXISTS v_production_progress AS
     SELECT po.id AS order_id, po.doc_no AS order_no, po.status, po.product_sku_id,
            po.warehouse_id, po.plan_date, po.qty AS plan_qty,
            COALESCE(po.completed_qty, 0) AS completed_qty,
            COALESCE(po.material_cost, 0) AS order_material_cost,
            COALESCE(po.total_cost, 0) AS order_total_cost,
            COALESCE((SELECT SUM(mii.issued_qty) FROM material_issue_items mii
                        JOIN material_issues mi ON mi.id = mii.issue_id
                       WHERE mi.order_id = po.id AND mi.status = 'issued'), 0) AS issued_qty,
            COALESCE((SELECT SUM(mi.total_amount) FROM material_issues mi
                       WHERE mi.order_id = po.id AND mi.status = 'issued'), 0) AS issued_amount,
            COALESCE((SELECT COUNT(*) FROM material_issues mi
                       WHERE mi.order_id = po.id AND mi.status <> 'cancelled'), 0) AS issue_count,
            COALESCE((SELECT SUM(wr.good_qty) FROM work_reports wr
                       WHERE wr.order_id = po.id), 0) AS reported_good_qty,
            COALESCE((SELECT SUM(wr.defect_qty) FROM work_reports wr
                       WHERE wr.order_id = po.id), 0) AS reported_defect_qty,
            COALESCE((SELECT SUM(wr.labor_cost + wr.overhead_cost) FROM work_reports wr
                       WHERE wr.order_id = po.id), 0) AS conversion_cost,
            COALESCE((SELECT SUM(wr.work_hours) FROM work_reports wr
                       WHERE wr.order_id = po.id), 0) AS work_hours
       FROM production_orders po`
]

const PERMS = [
  ['produce.bom.view', '查看 BOM', 'produce', 'menu'],
  ['produce.bom.edit', '维护 BOM', 'produce', 'action']
]

const ROLE_GRANTS = {
  admin: ['produce.bom.view', 'produce.bom.edit'],
  boss: ['produce.bom.view'],
  sales: [],
  finance: [],
  warehouse: ['produce.bom.view'],
  viewer: ['produce.bom.view']
}

const NO_RULES = [['MR', '生产领料单编号规则']]

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of VIEWS) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5600)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  if (tableExists(db, 'doc_no_rules')) {
    const insRule = db.prepare(
      `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark)
       VALUES (?,?, 'global','', '{PREFIX}{YYYYMMDD}{SEQ:4}','day',4,1,'模块 10B')
       ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING`
    )
    for (const [docType, name] of NO_RULES) insRule.run(docType, name)
  }

  stampDef(db, '023_bom_and_work', { tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, views: VIEWS.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['boms', 'bom_items', 'material_issues', 'material_issue_items', 'work_reports']) {
    if (!tableExists(db, t)) return false
  }
  // 视图是口径的落点，必须一起自检 —— 整库重建会先 DROP 所有视图，
  // 只查表存在会误判为已迁移，视图凭空消失，依赖它的查询要到运行时才炸。
  for (const v of ['v_bom_effective', 'v_production_progress']) {
    if (!db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='view' AND name=?").get(v)) return false
  }
  for (const name of ['idx_boms_sku', 'idx_bomit_bom', 'idx_mi_order', 'idx_mii_issue', 'idx_wr_order']) {
    if (!hasIndex(db, name)) return false
  }
  // 「一个母件一个用途只有一个 BOM」是本模块的核心约束，独立自检：
  // 它不靠应用层代码维持，靠的是库结构 —— 一旦被人删掉，本迁移必须自愈重跑。
  const uq = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='boms'")
    .get()
  if (!uq || !/UNIQUE\s*\(\s*product_sku_id\s*,\s*usage\s*\)/i.test(uq.sql)) return false
  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  if (defStale(db, '023_bom_and_work', { tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS })) {
    return false
  }
  return true
}
