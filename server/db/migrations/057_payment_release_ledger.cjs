'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/057_payment_release_ledger.cjs ｜ 付款释放台账：付款生效逐笔记应付冲减，作废逐笔逆向（ADR-0024）
 * ============================================================================
 * 【职责】新建 `payment_release_ledger`：付款单生效（submit，用友口径"审核即核销"）时，
 *   对每张结算单冲减了多少应付，记一行 —— 付款单、供应商、结算单、冲减额、冲减前后已付额。
 *   作废付款单时**只按这些行**逆向，并与重算口径互相校验，不一致整体回滚。
 *
 * 【为什么单独一张表】已付额原本只靠 `SUM(明细)` 重算，没有"生效那一刻冲了多少"的记录：
 *   作废只能靠重算掩盖漂移，无法发现"恢复多于释放"，也无法拒绝跨供应商的错位行。
 *
 * 【改它要注意什么】行的写入与逆向只在 `server/lib/purchase.js` 的付款函数；
 *   `reversed_at` 非空即已逆向。迁移之前已生效的付款单没有行：作废退回重算口径并标 legacy。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '付款释放台账（付款生效逐笔冲减应付，作废逐笔逆向）'

module.exports.up = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_release_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id    INTEGER NOT NULL REFERENCES purchase_payments(id) ON DELETE CASCADE,
      item_id       INTEGER,                                  -- purchase_payment_items.id（溯源）
      supplier_id   INTEGER NOT NULL,
      settle_id     INTEGER NOT NULL,
      amount        REAL NOT NULL CHECK (amount > 0),         -- 本次生效冲减的应付额
      paid_before   REAL NOT NULL,                            -- 冲减前结算单已付额
      paid_after    REAL NOT NULL,                            -- 冲减后结算单已付额
      reversed_at   TEXT,                                     -- 非空 = 已逆向
      reversal_ref  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_payment_release_payment ON payment_release_ledger(payment_id, reversed_at);
    CREATE INDEX IF NOT EXISTS idx_payment_release_settle  ON payment_release_ledger(settle_id);
  `)
}

module.exports.verify = (db) =>
  tableExists(db, 'payment_release_ledger') &&
  hasColumn(db, 'payment_release_ledger', 'reversed_at') &&
  hasColumn(db, 'payment_release_ledger', 'paid_after') &&
  hasIndex(db, 'idx_payment_release_payment')
