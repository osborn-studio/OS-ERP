-- =====================================================================
-- GML 促销引擎 · 表结构草案（模块：商城促销）
-- 来源：领域模型抄 medusa promotion（MIT，_ref/medusa），
--       补齐 medusa 缺失的 priority / stack_group / is_exclusive 三列
--       存储改为 SQLite 方言，金额一律用「分」整数，杜绝浮点误差
-- 许可：仅参考设计，代码为 GML 自研重写
-- =====================================================================

-- 活动（campaign）：促销的归属容器，承载预算
CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  starts_at     TEXT,
  ends_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active / paused / ended
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 预算：三种口径（花费额度 / 使用次数 / 按属性使用次数）
CREATE TABLE IF NOT EXISTS promotion_campaign_budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                      -- spend / usage / use_by_attribute
  limit_amt   INTEGER,                            -- spend 口径：预算上限（分）
  limit_qty   INTEGER,                            -- usage 口径：次数上限
  used        INTEGER NOT NULL DEFAULT 0,
  attribute   TEXT                                -- use_by_attribute：属性名（如 customer_id）
);

-- 促销主表
-- 说明：medusa 的 promotion 没有 priority / stack_group / is_exclusive，
--       而 GML 明确需要「叠加规则与优先级」，故在此三列补齐。
CREATE TABLE IF NOT EXISTS promotions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'standard', -- standard / buyget
  status            TEXT NOT NULL DEFAULT 'active',    -- active / inactive / expired
  campaign_id       INTEGER REFERENCES promotion_campaigns(id) ON DELETE SET NULL,
  is_automatic      INTEGER NOT NULL DEFAULT 0,   -- 1=无需券码自动生效
  is_tax_inclusive  INTEGER NOT NULL DEFAULT 0,   -- 1=折扣作用于含税价
  -- ↓↓↓ 以下三列为 GML 自研补齐（medusa 没有）↓↓↓
  priority          INTEGER NOT NULL DEFAULT 100, -- 数值越小越先计算
  stack_group       TEXT,                         -- 同组互斥：同一 stack_group 内只取最优一个
  is_exclusive      INTEGER NOT NULL DEFAULT 0,   -- 1=独占，命中后终止后续所有促销
  -- ↑↑↑
  usage_limit       INTEGER,                      -- 总使用次数上限（NULL=不限）
  used              INTEGER NOT NULL DEFAULT 0,
  starts_at         TEXT,
  ends_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(status, ends_at);

-- 规则表：三组用途分开存，避免语义混淆
--   rule_group: rules=适用条件（订单级）/ target_rules=作用范围（商品级）/ buy_rules=买赠的“买”条件
CREATE TABLE IF NOT EXISTS promotion_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  rule_group   TEXT NOT NULL,                     -- rules / target_rules / buy_rules
  attribute    TEXT NOT NULL,                     -- 如 sku_id / category_id / customer_level / subtotal
  operator     TEXT NOT NULL,                     -- in / not_in / eq / gt / gte / lt / lte
  value        TEXT NOT NULL                      -- 逗号分隔多值，或单个字面量
);
CREATE INDEX IF NOT EXISTS idx_promotion_rules ON promotion_rules(promotion_id, rule_group);

-- 应用方式（一张促销一个方法）
CREATE TABLE IF NOT EXISTS promotion_methods (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id            INTEGER NOT NULL UNIQUE REFERENCES promotions(id) ON DELETE CASCADE,
  type                    TEXT NOT NULL,          -- fixed / percentage
  target_type             TEXT NOT NULL,          -- items / order / shipping
  allocation              TEXT NOT NULL,          -- each / across / once
  value                   INTEGER NOT NULL,       -- percentage 时为单位数(万分之一)或百分数；fixed 时为“分”
  value_scale             INTEGER NOT NULL DEFAULT 0, -- 0=value 即“分”；2=value 为百分比(如 15 表示 15%)
  max_quantity            INTEGER,                -- 最多作用件数（allocation=once 时必填）
  buy_rules_min_quantity  INTEGER,                -- buyget：买满多少件
  apply_to_quantity       INTEGER                 -- buyget：赠多少件
);

-- 使用登记：幂等键唯一，防重复登记
CREATE TABLE IF NOT EXISTS promotion_usages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id     INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  order_id         INTEGER,
  customer_id      INTEGER,
  amount           INTEGER NOT NULL DEFAULT 0,    -- 本次优惠额（分）
  idempotency_key  TEXT NOT NULL UNIQUE,          -- 如 `order:123:promo:SUMMER`
  created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_promotion_usages_promo ON promotion_usages(promotion_id);

-- 订单行优惠留痕（供对账与“已优惠额”反查，避免重复打折）
CREATE TABLE IF NOT EXISTS promotion_adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL,
  item_id      INTEGER,                           -- target_type=order 时为 NULL
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  amount       INTEGER NOT NULL,                  -- 优惠额（分，正数）
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_promotion_adj_order ON promotion_adjustments(order_id);
