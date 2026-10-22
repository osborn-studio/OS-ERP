'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/017_costing.cjs ｜ 迁移：存货核算与成本：期间 / 期末快照 / 成本调整单
 * ============================================================================
 * 【职责】迁移：存货核算与成本：期间 / 期末快照 / 成本调整单
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 017 存货核算与成本（模块 09）：成本期间 + 期末结存快照 + 成本调整单
//
// 背景：成本层此前只有「实时结存」这一层 ——
//   stock.js 已经做了移动加权平均（入库加权、出库按均价、结存金额可回溯），
//   采购域也已经把暂估差异算出来并落进 purchase_settlements.diff_amount。
//   **但差异只是被记下来，没有人把它回写到存货成本** ——
//   于是「发票来了，实际价比暂估价高 8%」这件事，在库存金额上完全看不出来。
//
// 本迁移补三样东西，对应存货核算的三条硬口径：
//
//   ① **三层成本要能闭合** —— 期初 + 本期入库 − 本期出库 = 期末（数量与金额都要对）。
//      所以需要「期间」这个概念：没有期间，就只能算「截止今天的累计」，
//      而累计数是永远闭合的（误差会一直被下一笔吃掉，看不出问题）。
//      表：cost_periods（期间）+ cost_period_balances（期末快照，即下期期初）
//
//   ② **结转要有约束力** —— 期间一旦结转，就不允许再往里写流水。
//      否则「结转」只是一张随时会被后续单据推翻的快照，等于没结。
//      这条约束由 stock.js 的出入库入口执行（错误码 PERIOD_CLOSED）。
//
//   ③ **暂估差异必须回写，且不能追溯已售出部分** —— 表：cost_adjustments + items。
//      只调「仍在该批次库存里的数量」，已出库那部分单列 sold_amount 计入本期损益。
//      理由与模块 07「宁可少算，绝不重复算」同源：已售出部分对应的收入
//      已经按旧成本算过毛利，追溯会让历史毛利变化，而且无法可靠分摊到客户。
//
// 另：成本调整单**不设作废**（口径写在 ACTIONS 里）—— 调整已经改了结存金额，
// 「作废」要么得整单反算、要么留一个说不清的状态；要纠正就再开一张反向调整单，
// 每张都留痕、可追溯。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '存货核算与成本：期间 / 期末快照 / 成本调整单'

// ---------------------------------------------------------------------------
// 一、表结构
// ---------------------------------------------------------------------------
const TABLES = [
  // 成本期间：一个自然月一期。open=可写，closed=已结转（禁止再写该期间流水）
  `CREATE TABLE IF NOT EXISTS cost_periods (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    period       TEXT NOT NULL UNIQUE,                 -- YYYY-MM
    start_date   TEXT NOT NULL,
    end_date     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',         -- open / closed
    -- 结转时的三层快照（结转那一刻算出并落库，之后不再变，作为「当时算出来的是多少」的证据）
    opening_qty        REAL NOT NULL DEFAULT 0,
    opening_amount     REAL NOT NULL DEFAULT 0,
    in_qty             REAL NOT NULL DEFAULT 0,
    in_amount          REAL NOT NULL DEFAULT 0,
    out_qty            REAL NOT NULL DEFAULT 0,
    out_amount         REAL NOT NULL DEFAULT 0,
    closing_qty        REAL NOT NULL DEFAULT 0,
    closing_amount     REAL NOT NULL DEFAULT 0,
    -- 闭合校验的残差（金额、数量）。正常为 0；不为 0 要能在界面上看见，而不是被四舍五入吞掉
    residual_qty       REAL NOT NULL DEFAULT 0,
    residual_amount    REAL NOT NULL DEFAULT 0,
    line_count    INTEGER NOT NULL DEFAULT 0,          -- 本期结存行数
    closed_by     INTEGER,
    closed_by_name TEXT,
    closed_at     TEXT,
    remark        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_period_status ON cost_periods(status, period)`,

  // 期末结存快照：结转时把 inventory_stocks 逐行落一份，作为下期的期初。
  // 为什么要落快照而不是每次现算上一期期末：现算依赖「现在的流水」，
  // 而流水一旦被后续补单影响，上一期的期末就会跟着变 —— 结转就没有意义了。
  `CREATE TABLE IF NOT EXISTS cost_period_balances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    period        TEXT NOT NULL,
    warehouse_id  INTEGER NOT NULL,
    owner_org_id  INTEGER,
    sku_id        INTEGER NOT NULL,
    batch_no      TEXT NOT NULL DEFAULT '',
    currency      TEXT NOT NULL DEFAULT 'CNY',
    qty           REAL NOT NULL DEFAULT 0,
    unit_cost     REAL NOT NULL DEFAULT 0,
    amount        REAL NOT NULL DEFAULT 0,
    snapshot_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_bal_period ON cost_period_balances(period, warehouse_id, sku_id, batch_no)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_bal_stock  ON cost_period_balances(warehouse_id, sku_id, batch_no)`,

  // 成本调整单：把暂估与实际的差异回写存货成本。
  // 一笔调整对应一张**结算单**（差异的来源），逐行落到批次。
  `CREATE TABLE IF NOT EXISTS cost_adjustments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,
    adjust_date       TEXT NOT NULL,
    adjust_type       TEXT NOT NULL DEFAULT 'estimate_variance',
                       -- estimate_variance 暂估差异回写 / manual 手工成本调整
    period            TEXT NOT NULL,                  -- 归属期间（禁止调整已结转期间）
    settle_id         INTEGER,
    settle_no         TEXT,
    supplier_id       INTEGER,
    est_amount        REAL NOT NULL DEFAULT 0,        -- 入库暂估金额（收货单价口径）
    act_amount        REAL NOT NULL DEFAULT 0,        -- 实际金额（结算后的最终成本口径）
    diff_amount       REAL NOT NULL DEFAULT 0,        -- 差异 = 实际 − 暂估（正数=要补计成本）
    adjusted_amount   REAL NOT NULL DEFAULT 0,        -- 实际回写的金额（只针对仍在库部分）
    sold_qty          REAL NOT NULL DEFAULT 0,        -- 已出库、不可追溯的数量
    sold_amount       REAL NOT NULL DEFAULT 0,        -- 已出库部分对应的差异（计入本期损益，不进库存）
    line_count        INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'draft',  -- draft / adjusted / cancelled
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_adj_settle ON cost_adjustments(settle_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_adj_period ON cost_adjustments(period, status)`,

  `CREATE TABLE IF NOT EXISTS cost_adjustment_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_id  INTEGER NOT NULL REFERENCES cost_adjustments(id) ON DELETE CASCADE,
    line_no        INTEGER NOT NULL DEFAULT 1,
    warehouse_id   INTEGER,
    sku_id         INTEGER,
    batch_no       TEXT NOT NULL DEFAULT '',
    receipt_no     TEXT,
    qty_total      REAL NOT NULL DEFAULT 0,           -- 本行涉及的入库总量
    qty_on_hand    REAL NOT NULL DEFAULT 0,           -- 其中仍在库（可调整）的数量
    qty_sold       REAL NOT NULL DEFAULT 0,           -- 其中已出库（不可追溯）的数量
    price_est      REAL NOT NULL DEFAULT 0,           -- 暂估单价
    price_act      REAL NOT NULL DEFAULT 0,           -- 实际单价
    amount_est     REAL NOT NULL DEFAULT 0,
    amount_act     REAL NOT NULL DEFAULT 0,
    adj_amount     REAL NOT NULL DEFAULT 0,           -- 回写金额（= 仍在库数量 × (实际单价 − 暂估单价)）
    unit_before    REAL NOT NULL DEFAULT 0,
    unit_after     REAL NOT NULL DEFAULT 0,
    amount_before  REAL NOT NULL DEFAULT 0,
    amount_after   REAL NOT NULL DEFAULT 0,
    remark         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_adj_item ON cost_adjustment_items(adjustment_id)`
]

const INDEXES = []   // 索引已随建表语句一起给出（与 016 同一写法）

// ---------------------------------------------------------------------------
// 二、权限点
// ---------------------------------------------------------------------------
// 与质检那一轮同样的坑：成本权限此前只存在于契约文字里，权限清单里没有 ——
// 于是除 admin（is_super 短路）之外没有任何角色能获得成本权。
const PERMS = [
  ['cost.view', '查看存货核算', 'inventory', 'menu'],
  ['cost.adjust', '成本调整与期末结转', 'inventory', 'action']
]

const ROLE_GRANTS = {
  admin: ['cost.view', 'cost.adjust'],
  boss: ['cost.view'],
  finance: ['cost.view', 'cost.adjust'],
  warehouse: ['cost.view'],
  viewer: ['cost.view']
}

// ---------------------------------------------------------------------------
// 三、迁移主体
// ---------------------------------------------------------------------------
module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 4500)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue      // finance 角色在部分库里可能还没建，跳过而不是报错
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  stampDef(db, '017_costing', { tables: TABLES, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'cost_periods')) return false
  if (!tableExists(db, 'cost_period_balances')) return false
  if (!tableExists(db, 'cost_adjustments')) return false
  if (!tableExists(db, 'cost_adjustment_items')) return false
  if (!hasIndex(db, 'idx_cost_bal_period')) return false
  if (!hasIndex(db, 'idx_cost_adj_item')) return false
  // 权限点缺了不算结构缺失，但它是「配了权限也没用」的根因 —— 一并纳入自愈检查
  if (tableExists(db, 'permissions')) {
    const miss = PERMS.filter(([code]) => !db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code))
    if (miss.length) return false
  }
  if (defStale(db, '017_costing', { tables: TABLES, perms: PERMS, roles: ROLE_GRANTS })) return false
  return true
}
