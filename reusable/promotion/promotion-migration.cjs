'use strict'
// =====================================================================
// ✅ **已于 2026-10-15 被采用**为 `server/db/migrations/025_promo_member.cjs`
//   （批次 F）。本文件保留为**来源存档**，不再参与迁移扫描。
//   采用时做的三处改动（都在 025 里）：
//     ① `stampDef` / `defStale` 的 key 由 `020_promotion` 改为 `025_promo_member`；
//     ② `promotion_methods` 增加 `gift_sku_id`（买赠的赠品 SKU，GML 自研补充列）；
//     ③ 与会员域（`member_levels` / `member_accounts` / 两张流水）、
//        券域（`coupons` / `coupon_instances`）、视图 `v_member_overview`
//        合并进同一个迁移 —— 它们共用一套权限与等级基线，拆成两个迁移会互相引用。
//   若后续要改促销表结构，**改 025，不要改本文件**。
//
// ⛔ 采用前必须先做的一件事（**已完成**）：改 `server/lib/pricing.js` 的促销探测。
//   该处原先用「`promotions` 表是否存在」当促销价特性开关，命中后按
//   `price` / `sku_id` / `start_at` / `end_at` 四列查询；而本脚本用的是 medusa 模型
//   （价格在 promotion_methods，时间列叫 starts_at / ends_at）。
//   实测后果：表一建出来，取价引擎每次调用即抛 `no such column: price`，
//   `seedOrderCenter` 随之崩溃、服务起不来（2026-10-15 已复现一次）。
//   已改为**探测列形状**（`pragma_table_info('promotions')` 里有没有 `price`），
//   两种模型因此可以共存；`scripts/test-pricing.mjs` 的 T8 节把这条锁死。
// =====================================================================
//
// 商城促销引擎（P1 · 促销域第一阶段）—— 表结构部分
//
// 为什么现在补这块：商城侧的价格只有「取价引擎」（模块 16 价格组）一条线，
// 能回答「这件商品卖多少钱」，回答不了「这一单该减多少、为什么减、还能再减吗」。
// 促销的三个真问题是：
//   ① 多个活动撞在一起谁生效？（叠加规则与优先级 —— medusa 也没有，得自己定）
//   ② 同一件商品会不会被两个活动各打一次折？（防重复打折）
//   ③ 限量券会不会超发？（并发登记时的上限裁决）
//
// 【来源与许可】表结构领域模型参考 medusa `packages/modules/promotion`（MIT，见 _ref/medusa，
// 只作阅读，未整段复制），按本项目 SQLite 方言重写；priority / stack_group / is_exclusive
// 三列为 GML 自研补齐（medusa 无此三列）。
// ⛔ 未参考 medusa 的 RBAC/SSO 相关路径（企业版需商业授权），权限设计一律参考 casbin。
//
// 【金额口径】促销域一律用「分」为单位的整数 —— 折扣要反复按比例摊到行、还要除回去，
// 用 REAL 累计会出现「分摊尾差导致总优惠对不上单据」的经典问题（本项目在成本域踩过）。
// 因此本域与 GML 其它表的 REAL（元）不同，是刻意的：**跨域换算只在边界做一次**。

// 依赖路径写成「从仓库根算」的形式：`../../` 从本文件当前所在的
// `reusable/promotion/` 往上两级是仓库根；将来整份移回 `server/db/migrations/`
// 时往上两级同样是仓库根 —— 一个路径两处通用，不用改来改去。
const { tableExists, hasIndex, stampDef, defStale } = require('../../server/db/migrations/_helpers.cjs')

module.exports.name = '商城促销：活动 / 预算 / 促销 / 规则 / 应用方式 / 使用登记 / 优惠留痕'

const TABLES = [
  // 活动（campaign）：促销的归属容器，承载预算。促销可以没有活动（散券）
  `CREATE TABLE IF NOT EXISTS promotion_campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    starts_at   TEXT,
    ends_at     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',   -- active / paused / ended
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 预算：三种口径（花费额度 / 使用次数 / 按属性使用次数）。
  // 口径分开存而不是塞成一列，是因为「1000 元预算」和「1000 次使用」的扣减时机不同
  `CREATE TABLE IF NOT EXISTS promotion_campaign_budgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,                    -- spend / usage / use_by_attribute
    limit_amt   INTEGER,                          -- spend：预算上限（分）
    limit_qty   INTEGER,                          -- usage：次数上限
    used        INTEGER NOT NULL DEFAULT 0,
    attribute   TEXT                              -- use_by_attribute：属性名（如 customer_id）
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promo_budget_campaign ON promotion_campaign_budgets(campaign_id)`,

  // 促销主表
  `CREATE TABLE IF NOT EXISTS promotions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT 'standard', -- standard / buyget
    status           TEXT NOT NULL DEFAULT 'active',   -- active / inactive / expired
    campaign_id      INTEGER REFERENCES promotion_campaigns(id) ON DELETE SET NULL,
    is_automatic     INTEGER NOT NULL DEFAULT 0,   -- 1=无需券码自动生效
    is_tax_inclusive INTEGER NOT NULL DEFAULT 0,   -- 1=折扣作用于含税价
    -- ↓↓↓ GML 自研补齐（medusa 没有这三列）—— 就是「叠加规则与优先级」的落点 ↓↓↓
    priority         INTEGER NOT NULL DEFAULT 100, -- 数值越小越先计算
    stack_group      TEXT,                         -- 同组互斥：同组内只取最优一个
    is_exclusive     INTEGER NOT NULL DEFAULT 0,   -- 1=独占，命中后终止后续所有促销
    -- ↑↑↑
    usage_limit      INTEGER,                      -- 总使用次数上限（NULL=不限）
    used             INTEGER NOT NULL DEFAULT 0,
    starts_at        TEXT,
    ends_at          TEXT,
    remark           TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(status, ends_at)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_campaign ON promotions(campaign_id)`,

  // 规则表：三组用途分开存，避免语义混淆
  //   rules        订单级适用条件（如「仅限黄金会员」）
  //   target_rules 作用范围（如「只对某品类打折」）
  //   buy_rules    买赠的「买」条件
  `CREATE TABLE IF NOT EXISTS promotion_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    rule_group   TEXT NOT NULL,                    -- rules / target_rules / buy_rules
    attribute    TEXT NOT NULL,                    -- sku_id / category_id / customer_level / subtotal
    operator     TEXT NOT NULL,                    -- in / not_in / eq / gt / gte / lt / lte
    value        TEXT NOT NULL                     -- 逗号分隔多值，或单个字面量
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_rules ON promotion_rules(promotion_id, rule_group)`,

  // 应用方式（一张促销一个方法）
  `CREATE TABLE IF NOT EXISTS promotion_methods (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id           INTEGER NOT NULL UNIQUE REFERENCES promotions(id) ON DELETE CASCADE,
    type                   TEXT NOT NULL,          -- fixed / percentage
    target_type            TEXT NOT NULL,          -- items / order / shipping
    allocation             TEXT NOT NULL,          -- each / across / once
    value                  INTEGER NOT NULL,       -- percentage 时为单位数（万分比）或百分数；fixed 时为「分」
    value_scale            INTEGER NOT NULL DEFAULT 0, -- 0=value 即「分」；2=value 为百分比（15 表示 15%）
    max_quantity           INTEGER,                -- 最多作用件数（allocation=once 时必须给）
    buy_rules_min_quantity INTEGER,                -- buyget：买满多少件
    apply_to_quantity      INTEGER                 -- buyget：赠多少件
  )`,

  // 使用登记：幂等键唯一。防超发的关键不是「先查后写」，而是唯一键——
  // 并发下两个请求同时查到「还有名额」，唯一键会把后一个挡在数据库层
  `CREATE TABLE IF NOT EXISTS promotion_usages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id    INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    order_id        INTEGER,
    customer_id     INTEGER,
    amount          INTEGER NOT NULL DEFAULT 0,    -- 本次优惠额（分）
    idempotency_key TEXT NOT NULL UNIQUE,          -- 如 order:123:promo:SUMMER
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_usages_promo ON promotion_usages(promotion_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_usages_order ON promotion_usages(order_id)`,

  // 订单行优惠留痕：回答「这一单为什么减了 130 元」，
  // 也是「已优惠额」反查的依据（避免同一件商品被两个活动各打一次折）
  `CREATE TABLE IF NOT EXISTS promotion_adjustments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL,
    item_id      INTEGER,                          -- target_type=order / shipping 时为 NULL
    promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    code         TEXT NOT NULL,
    amount       INTEGER NOT NULL,                 -- 优惠额（分，正数）
    action       TEXT,                             -- add_item_adjustment / add_order_adjustment
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_adj_order ON promotion_adjustments(order_id)`
]

const PERMS = [
  ['mall.promotion.view', '查看促销活动', 'mall', 'menu'],
  ['mall.promotion.edit', '新建与编辑促销', 'mall', 'action'],
  ['mall.promotion.publish', '启停与发布促销', 'mall', 'action']
]

const ROLE_GRANTS = {
  admin: ['mall.promotion.view', 'mall.promotion.edit', 'mall.promotion.publish'],
  boss: ['mall.promotion.view'],
  marketing: ['mall.promotion.view', 'mall.promotion.edit', 'mall.promotion.publish'],
  sales: ['mall.promotion.view'],
  finance: ['mall.promotion.view'],
  warehouse: [],
  viewer: ['mall.promotion.view']
}

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5400)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  stampDef(db, '020_promotion', { tables: TABLES, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of [
    'promotion_campaigns',
    'promotion_campaign_budgets',
    'promotions',
    'promotion_rules',
    'promotion_methods',
    'promotion_usages',
    'promotion_adjustments'
  ]) {
    if (!tableExists(db, t)) return false
  }
  if (!hasIndex(db, 'idx_promotions_active')) return false
  if (!hasIndex(db, 'idx_promotion_usages_promo')) return false
  if (!hasIndex(db, 'idx_promotion_adj_order')) return false
  if (tableExists(db, 'permissions')) {
    const miss = PERMS.filter(([code]) => !db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code))
    if (miss.length) return false
  }
  if (defStale(db, '020_promotion', { tables: TABLES, perms: PERMS, roles: ROLE_GRANTS })) {
    return false
  }
  return true
}
