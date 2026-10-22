'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/031_dealer_agreement_rebate.cjs ｜ 迁移：DMS 渠道协议价 + 返利核销闭环（协议价档案 / 核销单 / 应收冲减）
 * ============================================================================
 * 【职责】迁移：DMS 渠道协议价 + 返利核销闭环（协议价档案 / 核销单 / 应收冲减）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 031 DMS 渠道协议价 + 返利核销闭环（批次 G）
//
// ===========================================================================
// 一、协议价：为什么不能塞进现有的「四维价格组」
// ===========================================================================
// 取价引擎（`lib/pricing.js`）现有的四维是 **渠道 × 门店类型 × 经销商等级 × 区域** ——
// 它们描述的是"这一类客户"的价。而协议价描述的是"**这一个客户**谈下来的价"：
//
//   · 主体是 `dealer_id`（具体某家），不是 `dealer_level`（金牌/银牌这一档）；
//   · 目标粒度是 `sku` 或 `category`（谈的是"这个品类全年 88 折"）；
//   · 有明确的**合同周期**与**起订量**；
//   · 同一家可能同时有多份协议（不同品类），所以必须能**按优先级裁决**。
//
// 用 `dealer_level` 去表达"某一家"，等于把合同的私有性降级成群组规则 ——
// 一旦某家要单独议价，就得给它单独造一个等级，而等级是共享维度（会影响所有同档客户）。
// 所以协议价必须**独立成表**，并在取价链上占一个明确位置。
//
// ===========================================================================
// 二、返利：已有政策与已核算，缺的是"把钱真正冲掉"
// ===========================================================================
// `rebate_policies`（政策）与 `dealer_rebates`（每期每政策一条核算结果）早已存在，
// 状态是 `pending / confirmed / paid`。但 `paid` 只是一个状态字 ——
// **它不改任何应收**：把一笔已确认的返利标记成"已发放"之后，账上分毫未动。
//
// 这一批补齐的是"核销"这一步：把若干笔**已确认**的返利汇成一张核销单，
// 冲减该客户（经销商）的未核销应收 —— 与销售退货 D1 的应收口径**完全一致**：
//
//   · 只减少 `ar_documents.amount`，**不生成负数应收**；
//   · 应收不够冲的部分登记为 `unoffset_amount`（如实登记，不静默吞掉）。
//
// 加列清单（每一列都在回答一个此前答不出的问题）：
//   dealer_rebates.settlement_id      —— 这笔返利被哪张核销单冲掉了（可反查）
//   dealer_rebates.ar_offset_amount   —— 其中真正冲了应收多少（"核销有后果"的证据）
//   dealer_rebates.settled_at         —— 什么时候冲的
//   dealer_rebates.commission_basis   —— 计返基数的**口径说明**（快照，政策后来改了也不影响历史）

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = 'DMS 渠道协议价 + 返利核销闭环（协议价档案 / 核销单 / 应收冲减）'

// ---------------------------------------------------------------------------
// 协议价档案
// ---------------------------------------------------------------------------
const AGREEMENT_SQL = `
  CREATE TABLE IF NOT EXISTS price_agreements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    dealer_id     INTEGER NOT NULL REFERENCES dealers(id),  -- 协议主体：**具体某一家**
    target_type   TEXT NOT NULL DEFAULT 'sku',             -- sku / category / all
    target_id     INTEGER,                                 -- sku_id 或 category_id；all 时为 NULL
    price_type    TEXT NOT NULL DEFAULT 'fixed',           -- fixed 定价 / discount 折扣（万分比）
    price         REAL NOT NULL DEFAULT 0,                 -- price_type=fixed：协议单价
    discount_bp   INTEGER NOT NULL DEFAULT 10000,          -- price_type=discount：10000=不减，9500=95 折
    min_qty       REAL NOT NULL DEFAULT 1,                 -- 起订量（低于它不适用本协议）
    effect_from   TEXT,                                    -- 合同周期起（含）
    effect_to     TEXT,                                    -- 合同周期止（含）
    priority      INTEGER NOT NULL DEFAULT 100,            -- 数值小者优先（同类协议可并存）
    status        TEXT NOT NULL DEFAULT 'active',          -- active / inactive
    remark        TEXT,
    created_by    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`

// ---------------------------------------------------------------------------
// 返利核销单（头 + 明细）
//
// 为什么要有"单"而不是直接改 `dealer_rebates.status`：
//   核销是一笔**有账务后果**的动作（冲应收），必须可追溯、可回滚、可幂等。
//   散着改状态的做法，事后答不出「这笔返利是什么时候、被哪一张单冲掉的」。
// ---------------------------------------------------------------------------
const SETTLEMENT_SQL = `
  CREATE TABLE IF NOT EXISTS rebate_settlements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no              TEXT NOT NULL UNIQUE,
    dealer_id           INTEGER NOT NULL REFERENCES dealers(id),
    period              TEXT NOT NULL,                 -- 核销的返利期（2026-09）
    rebate_count        INTEGER NOT NULL DEFAULT 0,    -- 本单冲了几笔返利
    total_amount        REAL NOT NULL DEFAULT 0,       -- 核销的返利总额
    ar_offset_amount    REAL NOT NULL DEFAULT 0,       -- 其中真正冲减应收的金额
    unoffset_amount     REAL NOT NULL DEFAULT 0,       -- 应收不够冲的部分（如实登记）
    status              TEXT NOT NULL DEFAULT 'draft', -- draft / confirmed / cancelled
    idempotency_key     TEXT,                          -- 同键重放返回同一张单
    operator_id         INTEGER,
    operator_name       TEXT,
    remark              TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    confirmed_at        TEXT
  )`

const SETTLEMENT_ITEM_SQL = `
  CREATE TABLE IF NOT EXISTS rebate_settlement_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id INTEGER NOT NULL REFERENCES rebate_settlements(id) ON DELETE CASCADE,
    rebate_id     INTEGER NOT NULL,                    -- dealer_rebates.id
    policy_id     INTEGER,
    amount        REAL NOT NULL DEFAULT 0,             -- 本单核销的返利额
    ar_offset_amount REAL NOT NULL DEFAULT 0           -- 其中冲了应收的（未冲部分 = amount − 本列合计）
  )`

const TABLES = [
  { name: 'price_agreements', sql: AGREEMENT_SQL },
  { name: 'rebate_settlements', sql: SETTLEMENT_SQL },
  { name: 'rebate_settlement_items', sql: SETTLEMENT_ITEM_SQL }
]

const NEW_COLUMNS = [
  ['dealer_rebates', 'settlement_id', 'INTEGER'],
  ['dealer_rebates', 'ar_offset_amount', 'REAL NOT NULL DEFAULT 0'],
  ['dealer_rebates', 'settled_at', 'TEXT'],
  ['dealer_rebates', 'commission_basis', 'TEXT']
]

const INDEXES = [
  {
    name: 'idx_price_agreement_lookup',
    sql: `CREATE INDEX IF NOT EXISTS idx_price_agreement_lookup
            ON price_agreements (dealer_id, status, target_type, target_id)`
  },
  {
    name: 'idx_rebate_settlement_dealer',
    sql: 'CREATE INDEX IF NOT EXISTS idx_rebate_settlement_dealer ON rebate_settlements (dealer_id, period, status)'
  },
  {
    // 幂等键**非空时唯一**：与 `sales_returns.idempotency_key` 同一手法，
    // 先查后插之间的并发由这条索引兜住。
    name: 'idx_rebate_settlement_idem',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_rebate_settlement_idem
            ON rebate_settlements (idempotency_key) WHERE idempotency_key IS NOT NULL`
  },
  {
    name: 'idx_rebate_settlement_item',
    sql: 'CREATE INDEX IF NOT EXISTS idx_rebate_settlement_item ON rebate_settlement_items (settlement_id)'
  },
  {
    name: 'idx_rebate_settlement_item_rebate',
    sql: 'CREATE INDEX IF NOT EXISTS idx_rebate_settlement_item_rebate ON rebate_settlement_items (rebate_id)'
  }
]

module.exports.up = function up(db) {
  if (!tableExists(db, 'dealers') || !tableExists(db, 'dealer_rebates')) {
    throw new Error('dealers / dealer_rebates 不存在，迁移顺序有误')
  }
  for (const t of TABLES) db.exec(t.sql)
  for (const [t, c, decl] of NEW_COLUMNS) addColumn(db, t, c, decl)
  for (const ix of INDEXES) db.exec(ix.sql)

  // 存量回填：把**旧语义的 `paid`** 降级为 `confirmed`。
  //
  // 旧语义里 `paid` 只是一个人工状态字（"已发放"），没有任何账务后果；
  // 新语义里 `paid` 的含义是"**已核销**"—— 必须挂在一张 `rebate_settlements` 上、
  // 且伴随真实的应收冲减（`verify()` 与 `lib/rebate.js` 的 `auditRebate` 都断言这一条）。
  // 存量行没有核销单，所以它们**只能是 `confirmed`**：当作"已确认入账、尚未核销"。
  // 不回填的后果不是报错，而是不变量永久失败，且失败信息（"有 34 笔已核销的返利没挂核销单"）
  // 完全看不出根因是**状态字换过含义**。
  // 回填不猜：只降级 `paid AND settlement_id IS NULL`，挂过核销单的一律不动。
  db.prepare("UPDATE dealer_rebates SET status='confirmed' WHERE status='paid' AND settlement_id IS NULL").run()

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS,
    indexes: INDEXES.map((x) => x.name),
    // 把回填也纳入指纹：不这么做的话，迁移已经"执行过"的库不会重跑 `up`，
    // 这条降级**永远不会落到存量数据上**（def 指纹是唯一能让 runner 重跑 up 的机制）。
    backfills: ['downgrade_legacy_paid_rebate']
  }
  stampDef(db, '031_dealer_agreement_rebate', def)
  return { tables: TABLES.length, columns: NEW_COLUMNS.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  if (!tableExists(db, 'dealer_rebates')) return false
  for (const [t, c] of NEW_COLUMNS) if (!hasColumn(db, t, c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量：已核销的返利必须指向一张真实的核销单（回填写错会在这里被抓到）
  const orphan = db
    .prepare(`
      SELECT COUNT(*) c FROM dealer_rebates r
       WHERE r.settlement_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM rebate_settlements s WHERE s.id = r.settlement_id)
    `)
    .get().c
  if (orphan > 0) return false
  // 不变量：协议价的 `target_type` 与 `target_id` 必须自洽（all 不带 id、其余必须带）
  const badTarget = db
    .prepare(`
      SELECT COUNT(*) c FROM price_agreements
       WHERE (target_type='all' AND target_id IS NOT NULL)
          OR (target_type<>'all' AND target_id IS NULL)
          OR target_type NOT IN ('sku','category','all')
    `)
    .get().c
  if (badTarget > 0) return false

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS,
    indexes: INDEXES.map((x) => x.name),
    backfills: ['downgrade_legacy_paid_rebate']
  }
  if (defStale(db, '031_dealer_agreement_rebate', def)) return false
  return true
}
