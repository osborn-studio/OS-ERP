-- =====================================================================
-- GML 业财一体 · 复式记账内核表结构（模块：总账 / 业财一体）
-- 来源：数据结构抄 medici（MIT，_ref/medici，原实现基于 MongoDB/mongoose）
-- 适配说明：
--   1) medici 用 account_path: string[]；SQLite 无数组，改用 ':' 分隔文本，
--      余额聚合靠 LIKE '前缀%' 或 account_path GLOB 实现。
--   2) medici 的 _journal / _original_journal 是 ObjectId 引用；此处用 INTEGER 外键。
--   3) medici 的 void（作废）是「写反向凭证 + 原凭证标 voided」，不物理删除，
--      这个设计直接保留 —— 审计链不能断。
--   4) 金额一律 INTEGER（分）；借贷同表双列（credit / debit），与 medici 一致。
-- =====================================================================

-- 凭证头
CREATE TABLE IF NOT EXISTS acct_journals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  book              TEXT NOT NULL DEFAULT 'main',   -- 账套（对应多行业多库可省略）
  biz_date          TEXT NOT NULL,                  -- 业务日期 YYYY-MM-DD
  doc_type          TEXT NOT NULL,                  -- 来源单据类型（如 SALE_INVOICE / PURCHASE_IN）
  doc_id            INTEGER,                        -- 来源单据 ID
  doc_no            TEXT,                           -- 来源单据号（冗余，便于联查）
  memo              TEXT,
  period            TEXT,                           -- 会计期间 YYYY-MM，冗余便于结账
  voided            INTEGER NOT NULL DEFAULT 0,
  void_reason       TEXT,
  orig_journal_id   INTEGER REFERENCES acct_journals(id), -- 红冲本凭证的那张凭证
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_acct_journals_doc   ON acct_journals(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_acct_journals_date  ON acct_journals(biz_date);
CREATE INDEX IF NOT EXISTS idx_acct_journals_period ON acct_journals(period);

-- 凭证明细（借贷双列）
CREATE TABLE IF NOT EXISTS acct_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id     INTEGER NOT NULL REFERENCES acct_journals(id) ON DELETE CASCADE,
  account_path   TEXT NOT NULL,     -- 形如 '1122:客户:华东' 或 '1405:库存商品'
  account        TEXT NOT NULL,     -- 末级科目（= account_path 最后一段）
  debit          INTEGER NOT NULL DEFAULT 0,  -- 借方（分）
  credit         INTEGER NOT NULL DEFAULT 0,  -- 贷方（分）
  currency       TEXT NOT NULL DEFAULT 'CNY',
  qty            INTEGER,                     -- 数量辅助核算（可选）
  meta           TEXT,                        -- JSON：客户/供应商/仓库/批次等业务维度
  voided         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acct_entries_journal ON acct_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_acct_entries_account ON acct_entries(account_path);

-- 期间状态（medici 没有，GML 自研：期末结转必须有闸门）
CREATE TABLE IF NOT EXISTS acct_periods (
  period      TEXT PRIMARY KEY,                -- YYYY-MM
  status      TEXT NOT NULL DEFAULT 'open',    -- open / closing / closed
  closed_by   TEXT,
  closed_at   TEXT
);

-- 幂等键：同一业务单据只允许生成一张有效凭证
CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_journal_doc
  ON acct_journals(doc_type, doc_id) WHERE voided = 0;
