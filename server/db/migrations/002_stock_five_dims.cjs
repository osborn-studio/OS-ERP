'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/002_stock_five_dims.cjs ｜ 迁移：库存五维与成本层（货主/币种/批次主档/成本流水/预留明细）
 * ============================================================================
 * 【职责】迁移：库存五维与成本层（货主/币种/批次主档/成本流水/预留明细）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 002 库存五维（仓库 × SKU × 批次 × 货主 × 币种）与成本层
// 依据：第一轮「库存一盘货」「成本移动加权」；第二轮 1.2 FEFO + 批次效期；第三轮 3.1 多币种、G5 效期到小时
// 说明：原 inventory_stocks 的唯一键是 (warehouse_id, sku_id, batch_no)，无法容纳货主维度，故重建表。

const { addColumn } = require('./_helpers.cjs')

module.exports.name = '库存五维与成本层（货主/币种/批次主档/成本流水/预留明细）'
module.exports.up = function up(db) {
  // ================= 1. 重建 inventory_stocks =================
  db.exec('DROP TABLE IF EXISTS inventory_stocks_v2')
  db.exec(`
    CREATE TABLE inventory_stocks_v2 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
      owner_org_id   INTEGER REFERENCES orgs(id),          -- 货主（产权主体，≠ 物理所在）
      sku_id         INTEGER NOT NULL REFERENCES product_skus(id),
      batch_no       TEXT NOT NULL DEFAULT '',
      currency       TEXT NOT NULL DEFAULT 'CNY',
      produce_date   TEXT,
      expire_date    TEXT,                                  -- 保留（兼容旧数据）
      expire_at      TEXT,                                  -- 到期时间，精确到小时
      entry_date     TEXT,
      location       TEXT,
      qty_on_hand    REAL NOT NULL DEFAULT 0,
      qty_reserved   REAL NOT NULL DEFAULT 0,
      qty_in_transit REAL NOT NULL DEFAULT 0,
      qty_ordered    REAL NOT NULL DEFAULT 0,
      cost_price     REAL DEFAULT 0,                        -- 语义修正：移动加权单位成本
      cost_amount    REAL DEFAULT 0,                        -- 结存成本金额
      last_in_at     TEXT,
      last_out_at    TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (warehouse_id, owner_org_id, sku_id, batch_no, currency)
    )
  `)

  const cols = db.prepare('PRAGMA table_info(inventory_stocks)').all().map((r) => r.name)
  if (cols.length > 0) {
    db.exec(`
      INSERT INTO inventory_stocks_v2
        (id, warehouse_id, owner_org_id, sku_id, batch_no, currency,
         produce_date, expire_date, expire_at, entry_date, location,
         qty_on_hand, qty_reserved, qty_in_transit, qty_ordered,
         cost_price, cost_amount, updated_at)
      SELECT id, warehouse_id, NULL, sku_id, IFNULL(batch_no,''), 'CNY',
             produce_date, expire_date, NULL, entry_date, location,
             qty_on_hand, qty_reserved, qty_in_transit, qty_ordered,
             cost_price, ROUND(IFNULL(qty_on_hand,0) * IFNULL(cost_price,0), 4), updated_at
      FROM inventory_stocks
    `)
    db.exec('DROP TABLE inventory_stocks')
  }
  db.exec('ALTER TABLE inventory_stocks_v2 RENAME TO inventory_stocks')
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stock_wh_sku   ON inventory_stocks(warehouse_id, sku_id);
    CREATE INDEX IF NOT EXISTS idx_stock_owner    ON inventory_stocks(owner_org_id);
    CREATE INDEX IF NOT EXISTS idx_stock_expire   ON inventory_stocks(expire_at);
    CREATE INDEX IF NOT EXISTS idx_stock_batch    ON inventory_stocks(batch_no);
  `)

  // ================= 2. 流水表补维度 =================
  addColumn(db, 'inventory_transactions', 'owner_org_id', 'INTEGER')
  addColumn(db, 'inventory_transactions', 'currency', "TEXT NOT NULL DEFAULT 'CNY'")
  addColumn(db, 'inventory_transactions', 'fx_rate', 'REAL DEFAULT 1')
  addColumn(db, 'inventory_transactions', 'unit_cost_base', 'REAL')
  addColumn(db, 'inventory_transactions', 'amount_base', 'REAL')
  addColumn(db, 'inventory_transactions', 'cost_method', "TEXT NOT NULL DEFAULT 'moving_avg'")
  addColumn(db, 'inventory_transactions', 'txn_type', 'TEXT')
  addColumn(db, 'inventory_transactions', 'biz_time', 'TEXT')
  addColumn(db, 'inventory_transactions', 'source', "TEXT NOT NULL DEFAULT 'web'")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_txn_type   ON inventory_transactions(txn_type);
    CREATE INDEX IF NOT EXISTS idx_txn_owner  ON inventory_transactions(owner_org_id);
    CREATE INDEX IF NOT EXISTS idx_txn_source ON inventory_transactions(source);
  `)

  // ================= 3. 批次主档 =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no         TEXT NOT NULL,
      sku_id           INTEGER NOT NULL REFERENCES product_skus(id),
      supplier_id      INTEGER,
      produce_at       TEXT,
      expire_at        TEXT,
      shelf_life_hours INTEGER,
      origin_doc_type  TEXT,
      origin_doc_no    TEXT,
      qc_status        TEXT NOT NULL DEFAULT 'pending',   -- pending/qualified/rejected
      status           TEXT NOT NULL DEFAULT 'active',    -- active/frozen/expired/scrapped
      remark           TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (sku_id, batch_no)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_expire ON inventory_batches(expire_at);
    CREATE INDEX IF NOT EXISTS idx_batch_status ON inventory_batches(status);
  `)

  // ================= 4. 预留明细 =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
      owner_org_id    INTEGER,
      sku_id          INTEGER NOT NULL REFERENCES product_skus(id),
      batch_no        TEXT NOT NULL DEFAULT '',
      qty             REAL NOT NULL DEFAULT 0,
      source_doc_type TEXT NOT NULL,
      source_doc_id   INTEGER,
      source_doc_no   TEXT,
      status          TEXT NOT NULL DEFAULT 'active',   -- active/released/consumed
      expire_at       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_resv_src   ON inventory_reservations(source_doc_type, source_doc_id);
    CREATE INDEX IF NOT EXISTS idx_resv_stock ON inventory_reservations(warehouse_id, sku_id, batch_no);
    CREATE INDEX IF NOT EXISTS idx_resv_status ON inventory_reservations(status);
  `)

  // ================= 5. 成本流水 =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_cost_ledger (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      biz_date         TEXT NOT NULL,
      warehouse_id     INTEGER NOT NULL,
      owner_org_id     INTEGER,
      sku_id           INTEGER NOT NULL,
      batch_no         TEXT NOT NULL DEFAULT '',
      currency         TEXT NOT NULL DEFAULT 'CNY',
      direction        TEXT NOT NULL,
      qty              REAL NOT NULL DEFAULT 0,
      unit_cost_before REAL,
      unit_cost_after  REAL,
      amount_before    REAL,
      amount_after     REAL,
      cost_method      TEXT NOT NULL DEFAULT 'moving_avg',
      doc_type         TEXT,
      doc_no           TEXT,
      remark           TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_cost_stock ON stock_cost_ledger(warehouse_id, sku_id, batch_no);
    CREATE INDEX IF NOT EXISTS idx_cost_doc   ON stock_cost_ledger(doc_type, doc_no);
  `)
}

module.exports.verify = function verify(db) {
  const { tableExists, hasColumn } = require('./_helpers.cjs')
  return (
    tableExists(db, 'inventory_stocks') &&
    hasColumn(db, 'inventory_stocks', 'owner_org_id') &&
    hasColumn(db, 'inventory_stocks', 'currency') &&
    hasColumn(db, 'inventory_stocks', 'cost_amount') &&
    hasColumn(db, 'inventory_stocks', 'expire_at') &&
    tableExists(db, 'inventory_batches') &&
    tableExists(db, 'inventory_reservations') &&
    tableExists(db, 'stock_cost_ledger')
  )
}
