'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/052_credit_release_ledger.cjs ｜ 授信释放台账：收款/预收释放了谁的额度、逆向时逐笔恢复
 * ============================================================================
 * 【职责】新建 `credit_release_ledger`：每一次由收款单（确认核销 / 预收抵扣）触发的授信释放
 *   都记一行 —— 释放的是哪本台账（统一授信 credit_ledger / 订货中心 oc_credit_ledger）、
 *   哪个客户、哪张来源单据（SO / SI / OC / RCP）、实际释放了多少。
 *   作废收款时**只按这些行逆向**（逐笔恢复），不按收款总额去猜。
 *
 * 【为什么要单独一张表】credit_ledger 的 settle 行不带收款单 id，一张收款单核销多张应收、
 *   多张应收又映射到同一张 SO 时，事后无法从 settle 行反推"这张收款单释放了多少"；
 *   oc_credit_ledger 的 repay 行同理。把归属记在释放发生的那一刻，是唯一不猜的办法。
 *
 * 【改它要注意什么】行的写入与逆向都只在 `server/lib/credit-release.js`；
 *   `reversed_at` 非空即"已逆向"，重复逆向必须拒绝（判据在 lib，不在 SQL）。
 *   迁移之前已确认的收款单没有行：作废时统一授信**无法恢复**（见 ADR-0013）。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '授信释放台账（收款/预收释放逐笔归属，作废逐笔恢复）'

module.exports.up = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_release_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id    INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      ar_id         INTEGER,                                  -- 被核销的应收单（溯源用，不参与判据）
      trigger       TEXT NOT NULL CHECK (trigger IN ('confirm','prepay')),
      ledger        TEXT NOT NULL CHECK (ledger IN ('credit','oc')),   -- credit 统一授信 / oc 订货中心台账
      account_id    INTEGER,                                  -- credit_accounts.id（ledger='credit' 时必填）
      customer_type TEXT NOT NULL,                            -- 收款单往来对象（dealer / store / oc）
      customer_id   INTEGER NOT NULL,
      source_type   TEXT NOT NULL,                            -- SO / SI / OC / RCP（占用在谁名下，就记谁）
      source_id     INTEGER,
      doc_no        TEXT,
      amount        REAL NOT NULL CHECK (amount > 0),         -- 实际释放额（已按来源剩余占用封顶）
      ledger_id     INTEGER,                                  -- 释放行在对应台账里的 id
      reversed_at   TEXT,                                     -- 非空 = 已逆向恢复
      reversal_ref  TEXT,                                     -- 恢复行的引用（credit_ledger#id / oc_credit_ledger#id）
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_credit_release_receipt ON credit_release_ledger(receipt_id, reversed_at);
    CREATE INDEX IF NOT EXISTS idx_credit_release_source  ON credit_release_ledger(source_type, source_id);
  `)
}

module.exports.verify = (db) =>
  tableExists(db, 'credit_release_ledger') &&
  hasColumn(db, 'credit_release_ledger', 'reversed_at') &&
  hasColumn(db, 'credit_release_ledger', 'reversal_ref') &&
  hasIndex(db, 'idx_credit_release_receipt')
