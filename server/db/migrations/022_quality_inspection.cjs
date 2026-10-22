'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/022_quality_inspection.cjs ｜ 迁移：质量检验：报检 / 检验 / 不良品处理 三单独立成链
 * ============================================================================
 * 【职责】迁移：质量检验：报检 / 检验 / 不良品处理 三单独立成链
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 022 质量检验独立成单（模块 13）
//
// 模块 07 已经有质检单（INS），但它是**绑死在到货单上**的：一张到货单一条记录、
// 只认采购这一个入口、抽样与检验写在同一个动作里。到了「生产完工要检验」「在库复检」
// 就无处安放，只能复制一套 —— 复制出来的第二套迟早与第一套口径分叉。
//
// 本迁移把质检从「采购的附属动作」提升为**独立的三段链**：
//   报检（QCR）谁来检、按什么抽样方案 —— 由仓库/生产发起，记的是「请人来判」；
//   检验（QCI）判的结果 —— 由质检岗完成，记的是**判断**；
//   不良品处理（DH）不良品怎么处置 —— 由品质/生产决策，是**有库存后果**的一步。
//
// 为什么三段必须分开，而不是一张单走到底：
//   ① 三者**责任人与时间都不同** —— 仓管报检、质检员判定、品质主管决定处置，
//      合成一张单就只能共用一个状态，谁卡住了都看不出来；
//   ② 处置方式（让步/退货/报废/返工）是**多个维度**的决策，一张单只能有一个状态，
//      而一次检验里不同 SKU 的处置可以不同 —— 必须让处置独立成单、按行决策；
//   ③ 抽样是**行业惯例**：判断不该建立在「全检」的假设上。抽样方案（n/Ac/Re）
//      必须落库，否则「为什么判合格」半年后没人说得清。
//
// 三条口径：
//   ① **判定由数字推导，不由人选** —— 实测不良数 ≤ Ac 判合格，≥ Re 判不合格。
//      让人手选结论，就会出现「不良 5 个但点了合格」而系统毫无察觉。
//   ② **抽样量 ≤ 报检数量、不良数 ≤ 抽样量**，写库前强校验。不成立说明有人填反了。
//   ③ **处置必须有库存后果**，否则它只是一张纸：
//      退货 → 生成采购退货单（采购来源）或质检退料出库（其它来源）；
//      报废 → 报废出库；让步 / 返工 → 不动库存（货留着，但记录理由与缺陷）。
//
//      ⚠️ 已过期（批次 QC-DISP）：让步 / 返工自本批起**真实出入库** —— 自动生成一张
//      `type='qc_disposition'` 的调拨单，把货从当前仓挪进**隔离仓**（让步→不合格品仓 /
//      返工→待检品仓），出库（TR_OUT）与入库（TR_IN）都真的发生。
//      历史正文保留不改（它是当时的决策留痕）；**当前口径以 `server/lib/qc2.js` 的
//      `DISPOSITION_TARGET` 与 `confirmHandling` 为准**。
//
// 与模块 07 的关系（写清楚，避免两套并存却没人说得清）：
//   模块 07 的 `purchase_inspections`（INS）**保留不动**，供存量与「轻量到货判定」继续使用；
//   本模块是**通用链**，新单一律走 QCR → QCI → DH。
//   为避免同一张到货单被两条链各检一次，待检清单（视图 `v_qc_pending_source`）
//   会同时排除「已有 INS 的到货单」与「已有 QCR 的到货单」。

const { tableExists, hasColumn, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '质量检验：报检 / 检验 / 不良品处理 三单独立成链'

const TABLES = [
  // ---------- QCR 报检单头 ----------
  // 抽样方案落库（aql + inspect_level + 行级 n/Ac/Re），而不是「检验时现算」：
  // 现算意味着同一批货今天算和明天算可能不一样（参数被改了），判过的案子就再也复现不了。
  `CREATE TABLE IF NOT EXISTS qc_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    source_type       TEXT NOT NULL,                    -- purchase_receipt / production_order / inventory
    source_id         INTEGER,
    source_doc_no     TEXT,
    org_id            INTEGER,
    warehouse_id      INTEGER,
    supplier_id       INTEGER,                          -- 采购来源才有
    subject_name      TEXT,                             -- 供应商 / 车间 / 库位（展示用，来自来源单据）
    request_date      TEXT NOT NULL,
    request_by        INTEGER,
    request_by_name   TEXT,
    aql               REAL NOT NULL DEFAULT 2.5,        -- 接收质量限
    inspect_level     TEXT NOT NULL DEFAULT 'normal',   -- normal / tightened / reduced
    total_qty         REAL NOT NULL DEFAULT 0,          -- 报检数量合计
    total_sample_qty  REAL NOT NULL DEFAULT 0,          -- 抽样量合计
    item_count        INTEGER NOT NULL DEFAULT 0,
    inspection_id     INTEGER,                          -- 一对一生成的检验单
    inspection_no     TEXT,
    status            TEXT NOT NULL DEFAULT 'draft',    -- draft / submitted / closed / cancelled
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    submitted_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qcr_status ON qc_requests(status, request_date)`,
  `CREATE INDEX IF NOT EXISTS idx_qcr_source ON qc_requests(source_type, source_id)`,

  // ---------- QCR 报检行：抽样方案与检验结果都挂在这里 ----------
  // 为什么不另开一张 qc_inspection_items：报检行与检验行**天然一一对应**
  // （同一行货，先填「报检多少、抽多少」，后填「不良多少、判什么」）。
  // 另开一张表会引入一个只在中间态存在的 join，而两张表的口径还得人工同步。
  // 这里把「判断字段」与「事实字段」放在同一行，靠 `result='pending'` 区分是否已判：
  // 事实字段（qty/sample_qty/ac/re）在报检时写死，判断字段在检验时才有值。
  `CREATE TABLE IF NOT EXISTS qc_request_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    INTEGER NOT NULL REFERENCES qc_requests(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL,
    sku_id        INTEGER,
    sku_code      TEXT,
    sku_name      TEXT,
    spec          TEXT,
    batch_no      TEXT NOT NULL DEFAULT '',
    qty           REAL NOT NULL DEFAULT 0,              -- 报检数量（批量）
    sample_qty    REAL NOT NULL DEFAULT 0,              -- 抽样量 n
    ac            INTEGER NOT NULL DEFAULT 0,           -- 接收数
    re            INTEGER NOT NULL DEFAULT 1,           -- 拒收数
    defect_qty    REAL NOT NULL DEFAULT 0,              -- 实测不良数（检验时回写）
    result        TEXT NOT NULL DEFAULT 'pending',       -- pending / qualified / unqualified
    defect_code   TEXT,
    defect_reason TEXT,
    remark        TEXT,
    UNIQUE (request_id, line_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qcri_request ON qc_request_items(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qcri_sku ON qc_request_items(sku_id)`,

  // ---------- QCI 检验单头（与报检单一对一） ----------
  // disposition 是**决策记录**而非纯派生：一次检验可能有多张处置单（不同 SKU 不同方式），
  // 此时记为 mixed。它是「这批货最后怎么处理了」的唯一落点，不该靠 join 现算 ——
  // 处置单可以被再开，结论一旦下了就该冻住。
  `CREATE TABLE IF NOT EXISTS qc_inspections (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    request_id        INTEGER NOT NULL,
    request_no        TEXT,
    source_type       TEXT,
    source_id         INTEGER,
    source_doc_no     TEXT,
    warehouse_id      INTEGER,
    supplier_id       INTEGER,
    inspect_date      TEXT NOT NULL,
    inspector_id      INTEGER,
    inspector_name    TEXT,
    aql               REAL NOT NULL DEFAULT 2.5,
    inspect_level     TEXT NOT NULL DEFAULT 'normal',
    total_qty         REAL NOT NULL DEFAULT 0,
    sample_qty        REAL NOT NULL DEFAULT 0,
    defect_qty        REAL NOT NULL DEFAULT 0,
    defect_rate       REAL NOT NULL DEFAULT 0,          -- 不良率（按抽样量算，%）
    result            TEXT NOT NULL DEFAULT 'pending',   -- pending / qualified / unqualified
    disposition       TEXT NOT NULL DEFAULT 'none',      -- none / concession / return / scrap / rework / mixed
    handling_count    INTEGER NOT NULL DEFAULT 0,
    return_id         INTEGER,                           -- 若产生退货，指回退货单
    return_no         TEXT,
    status            TEXT NOT NULL DEFAULT 'draft',     -- draft / inspected / closed / cancelled
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_qci_request ON qc_inspections(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qci_status ON qc_inspections(status, inspect_date)`,
  `CREATE INDEX IF NOT EXISTS idx_qci_result ON qc_inspections(result)`,

  // ---------- DH 不良品处理单（行级：一张一种 SKU+批次+处置方式） ----------
  // 不做「头 + 行」两层，是因为**处置的库存后果是按 SKU×批次发生的**：
  // 一个出库动作对应一个 SKU 一个批次，做成单行单能让「单据 ↔ 库存流水」一一对应，
  // 追溯时不用再拆数量。不同 SKU 处置方式不同时，就开多张处置单 ——
  // 这比一张单里塞多行、每行各自出库要清楚得多。
  `CREATE TABLE IF NOT EXISTS qc_defect_handlings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    inspection_id     INTEGER NOT NULL,
    inspection_no     TEXT,
    request_id        INTEGER,
    source_type       TEXT,
    source_id         INTEGER,
    warehouse_id      INTEGER,
    supplier_id       INTEGER,
    sku_id            INTEGER,
    sku_code          TEXT,
    sku_name          TEXT,
    batch_no          TEXT NOT NULL DEFAULT '',
    qty               REAL NOT NULL DEFAULT 0,          -- 不良数量（本单处置的数量）
    mode              TEXT NOT NULL,                     -- concession 让步接收 / return 退货 / scrap 报废 / rework 返工
    defect_code       TEXT,
    reason            TEXT,                              -- 处置理由（让步必须有，见提交校验）
    stock_direction   TEXT NOT NULL DEFAULT 'none',      -- in / out / none
    out_doc_type      TEXT,                              -- 生成的出库/退货单据类型（PRT / SCRAP_OUT / QC_RET_OUT）
    out_doc_id        INTEGER,
    out_doc_no        TEXT,
    status            TEXT NOT NULL DEFAULT 'draft',      -- draft / confirmed / cancelled
    approved_by       INTEGER,
    approved_by_name  TEXT,
    approved_at       TEXT,
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qcdh_inspection ON qc_defect_handlings(inspection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qcdh_status ON qc_defect_handlings(status, mode)`,
  `CREATE INDEX IF NOT EXISTS idx_qcdh_sku ON qc_defect_handlings(sku_id, batch_no)`
]

// 盘点专用视图：把「谁在等检」这件事下沉到库里。
// 采购到货与生产完工是两种来源、两张表、字段名都不同；写在 JS 里意味着每个调用点
// 都得各自写一遍 union，而只要有一个人漏掉「排除已报检」，同一批货就会被检两次。
const VIEWS = [
  `CREATE VIEW IF NOT EXISTS v_qc_pending_source AS
     SELECT 'purchase_receipt' AS source_type, rc.id AS source_id, rc.doc_no AS source_doc_no,
            rc.warehouse_id, w.name AS warehouse_name,
            rc.supplier_id, s.name AS subject_name,
            rc.receipt_date AS biz_date, rc.total_qty AS qty,
            NULL AS sku_id, rc.status AS source_status, rc.order_id AS ref_id, rc.created_at
       FROM purchase_receipts rc
       LEFT JOIN warehouses w ON w.id = rc.warehouse_id
       LEFT JOIN suppliers s ON s.id = rc.supplier_id
      WHERE rc.status = 'received'
        AND NOT EXISTS (SELECT 1 FROM qc_requests q
                         WHERE q.source_type = 'purchase_receipt' AND q.source_id = rc.id
                           AND q.status <> 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM purchase_inspections i
                         WHERE i.receipt_id = rc.id AND i.status NOT IN ('cancelled','draft'))
     UNION ALL
     SELECT 'production_order', po.id, po.doc_no,
            po.warehouse_id, w.name,
            NULL, '生产车间',
            COALESCE(po.updated_at, po.created_at), COALESCE(po.completed_qty, po.qty),
            po.product_sku_id, po.status, NULL, po.created_at
       FROM production_orders po
       LEFT JOIN warehouses w ON w.id = po.warehouse_id
      WHERE po.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM qc_requests q
                         WHERE q.source_type = 'production_order' AND q.source_id = po.id
                           AND q.status <> 'cancelled')`
]

const PERMS = [
  ['quality.qc.view', '查看质量检验', 'quality', 'menu'],
  ['quality.request.create', '提交报检单', 'quality', 'action'],
  ['quality.handle.approve', '不良品处理批准', 'quality', 'action']
]

const ROLE_GRANTS = {
  admin: ['quality.qc.view', 'quality.request.create', 'quality.handle.approve'],
  boss: ['quality.qc.view'],
  sales: [],
  finance: [],
  warehouse: ['quality.qc.view', 'quality.request.create'],
  viewer: ['quality.qc.view']
}

// 质检退货出库：非采购来源（生产 / 库存复检）判退时要出库，但没有「退给谁」的供应商。
// 复用 SCRAP_OUT 会与报废混在一起、统计时分不开，所以单列一个事务类型。
const TXN_TYPES = [
  ['QC_RET_OUT', '质检退料出库', 'out', 'quality', 'normal', 285]
]

const NO_RULES = [
  ['QCR', '报检单编号规则'],
  ['QCI', '检验单编号规则'],
  ['DH', '不良品处理单编号规则']
]

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of VIEWS) db.exec(sql)

  // 库存事务类型字典：新增的 QC_RET_OUT 要能被库存流水与报表认得
  if (tableExists(db, 'inv_txn_types')) {
    const upTxn = db.prepare(
      `INSERT INTO inv_txn_types (code,name,direction,biz_category,cost_effect,status,sort_order)
       VALUES (?,?,?,?,?, 'active', ?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, direction=excluded.direction,
         biz_category=excluded.biz_category, cost_effect=excluded.cost_effect`
    )
    for (const [code, name, direction, cat, effect, sort] of TXN_TYPES) {
      upTxn.run(code, name, direction, cat, effect, sort)
    }
  }

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5500)

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
       VALUES (?,?, 'global','', '{PREFIX}{YYYYMMDD}{SEQ:4}','day',4,1,'模块 13')
       ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING`
    )
    for (const [docType, name] of NO_RULES) insRule.run(docType, name)
  }

  stampDef(db, '022_quality_inspection', { tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS, txn: TXN_TYPES })
  return { tables: TABLES.length, views: VIEWS.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['qc_requests', 'qc_request_items', 'qc_inspections', 'qc_defect_handlings']) {
    if (!tableExists(db, t)) return false
  }
  // 视图是口径的落点，必须一起自检 —— 整库重建会先 DROP 所有视图，
  // 只查表存在会误判为已迁移，视图凭空消失，而依赖它的查询会在运行时才炸。
  const v = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='view' AND name='v_qc_pending_source'").get()
  if (!v) return false
  for (const name of ['idx_qcr_status', 'idx_qcri_request', 'uq_qci_request', 'idx_qcdh_status']) {
    if (!hasIndex(db, name)) return false
  }
  if (tableExists(db, 'inv_txn_types')) {
    if (!db.prepare("SELECT 1 AS hit FROM inv_txn_types WHERE code='QC_RET_OUT'").get()) return false
  }
  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  if (defStale(db, '022_quality_inspection', { tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS, txn: TXN_TYPES })) {
    return false
  }
  return true
}
