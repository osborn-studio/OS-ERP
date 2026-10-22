'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/025_promo_member.cjs ｜ 迁移：商城促销与会员：活动 / 预算 / 促销 / 规则 / 方式 / 使用登记 / 优惠留痕 / 券 / 等级 / 积分储值账
 * ============================================================================
 * 【职责】迁移：商城促销与会员：活动 / 预算 / 促销 / 规则 / 方式 / 使用登记 / 优惠留痕 / 券 / 等级 / 积分储值账
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 025 商城促销与会员（模块 18）
//
// 本迁移补的是**商城侧的价格弹性**。此前商城只有「取价引擎」一条线：
// 它能回答「这件商品卖多少钱」，回答不了三件事：
//   · 这一单该减多少、为什么减、还能再减吗？
//   · 这个人是几级会员、手里那张券还能用吗？
//   · 积分是怎么来的、花到哪去了？
//
// 促销的三个真问题（也是本迁移的结构落点）：
//   ① **多个活动撞在一起谁生效** → `priority` / `stack_group` / `is_exclusive` 三列
//      （medusa 没有，本项目自研补齐）
//   ② **同一件商品会不会被两个活动各打一次折** → `promotion_adjustments`
//      （订单行优惠留痕，既是"为什么减了 130 元"的答案，也是"已优惠额"的反查依据）
//   ③ **限量券会不会超发** → `promotion_usages.idempotency_key` 唯一键
//      （防超发的关键不是"先查后写"，而是唯一键 + 条件式 UPDATE —— 判断与写入在同一条语句里）
//
// ⚠️ 采用前必须先做的一件事（已在 2026-10-15 复现）：
//    `server/lib/pricing.js` 原先用「`promotions` 表是否存在」当促销价特性开关，
//    命中后按 `price` / `sku_id` / `start_at` / `end_at` 四列查询。
//    而本迁移的 `promotions` 是 medusa 模型（优惠方式在 `promotion_methods`，
//    时间列叫 `starts_at` / `ends_at`），**没有**这四列 ⇒
//    表一建出来，取价引擎每次调用即抛 `no such column: price`，
//    `seedOrderCenter` 随之崩溃、服务起不来。
//    已改为**探测列形状**（`pragma_table_info('promotions')` 里有没有 `price`），
//    两种模型因此可以共存 —— 见 `server/lib/pricing.js` 第 1 步。
//
// 【金额口径】促销域一律用**「分」为单位的整数** —— 折扣要反复按比例摊到行、还要除回去，
//   用 REAL 累计会出现「分摊尾差导致总优惠对不上单据」的经典问题（本项目在成本域踩过）。
//   因此本域与 GML 其它表的 REAL（元）不同，是刻意的：**跨域换算只在边界做一次**。
//   会员域的储值余额与积分抵扣上限同样按分/万分比存整数，理由相同。
//
// 【来源与许可】表结构领域模型参考 medusa `packages/modules/promotion`（MIT，见 `_ref/medusa`，
//   只作阅读，未整段复制），按本项目 SQLite 方言重写；
//   `priority` / `stack_group` / `is_exclusive` / `gift_sku_id` 四列为 GML 自研补齐。
//   ⛔ 未参考 medusa 的 RBAC / SSO 相关路径（企业版需商业授权），权限设计一律参考 casbin。

const { tableExists, hasColumn, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '商城促销与会员：活动 / 预算 / 促销 / 规则 / 方式 / 使用登记 / 优惠留痕 / 券 / 等级 / 积分储值账'

// ---------------------------------------------------------------------------
// 一、促销域（7 张表，采用 reusable/promotion 的领域模型）
// ---------------------------------------------------------------------------

const PROMO_TABLES = [
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
  // 口径分开存而不是塞成一列，是因为「1000 元预算」和「1000 次使用」的扣减时机不同。
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
  //   rules        订单级适用条件（如「仅限黄金会员」「满 5000 才可用」）
  //   target_rules 作用范围（如「只对某品类打折」）
  //   buy_rules    买赠的「买」条件
  `CREATE TABLE IF NOT EXISTS promotion_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    rule_group   TEXT NOT NULL,                    -- rules / target_rules / buy_rules
    attribute    TEXT NOT NULL,                    -- sku_id / category_id / customer_level / subtotal
    operator     TEXT NOT NULL,                    -- in / not_in / eq / ne / gt / gte / lt / lte
    value        TEXT NOT NULL                     -- 逗号分隔多值，或单个字面量
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_rules ON promotion_rules(promotion_id, rule_group)`,

  // 应用方式（一张促销一个方法）
  //
  // `gift_sku_id` 是 GML 自研补齐的第四列：medusa 用「另一条 target rule」表达赠品是哪个，
  // 那套写法在界面上要反解才能显示"赠品是什么"，而买赠最要紧的就是让人一眼看到赠品。
  // 显式落一列，界面直接读，不用反解。
  `CREATE TABLE IF NOT EXISTS promotion_methods (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id           INTEGER NOT NULL UNIQUE REFERENCES promotions(id) ON DELETE CASCADE,
    type                   TEXT NOT NULL,          -- fixed / percentage
    target_type            TEXT NOT NULL,          -- items / order / shipping
    allocation             TEXT NOT NULL,          -- each / across / once
    value                  INTEGER NOT NULL,       -- percentage 时为万分比；fixed 时为「分」
    value_scale            INTEGER NOT NULL DEFAULT 0, -- 0=value 即「分」；2=value 为百分数（15 表示 15%）
    max_quantity           INTEGER,                -- 最多作用件数（allocation=once 时必须给）
    buy_rules_min_quantity INTEGER,                -- buyget：买满多少件
    apply_to_quantity      INTEGER,                -- buyget：赠多少件
    gift_sku_id            INTEGER                 -- buyget：赠品 SKU（GML 自研补充列）
  )`,

  // 使用登记：幂等键唯一。防超发的关键不是「先查后写」，而是唯一键 ——
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

// ---------------------------------------------------------------------------
// 二、券域（模板 + 实例）
//
// 为什么券要分成「模板」与「实例」两张表：
//   模板回答「活动怎么配」（面额多少、发行多少张、有效期多久）；
//   实例回答「这张券在谁手上、用了没有、什么时候过期」。
//   混成一张表的后果是：发 1000 张券要写 1000 行配置，改一次面额要动 1000 行 ——
//   而"改配置"这种事一旦变成批量写业务数据，就再也说不清哪一行才是当前口径。
// ---------------------------------------------------------------------------

const COUPON_TABLES = [
  `CREATE TABLE IF NOT EXISTS coupons (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    code           TEXT NOT NULL UNIQUE,              -- 券模板码（实例码在其后补序号）
    name           TEXT NOT NULL,
    -- 券本身不做优惠计算，优惠一律交给促销引擎 —— 券只是「一张能解锁某促销的凭证」。
    -- 这样"券门槛"与"促销规则"只有一处口径，不会出现券里能减、促销里不能减的矛盾。
    promotion_id   INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
    type           TEXT NOT NULL DEFAULT 'fixed',     -- fixed / percentage（冗余，供列表直接显示）
    value          INTEGER NOT NULL DEFAULT 0,        -- 面额（分）或折扣（万分比）
    min_subtotal   INTEGER NOT NULL DEFAULT 0,        -- 使用门槛：订单金额下限（分）
    total_qty      INTEGER,                           -- 发行总量（NULL=不限）
    issued_qty     INTEGER NOT NULL DEFAULT 0,
    per_user_limit INTEGER NOT NULL DEFAULT 1,        -- 每人最多领几张
    valid_from     TEXT,                              -- 绝对有效期起
    valid_to       TEXT,                              -- 绝对有效期止
    valid_days     INTEGER,                           -- 领券后 N 天内有效（相对有效期，与绝对期取交集）
    status         TEXT NOT NULL DEFAULT 'active',    -- active / paused / ended
    remark         TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status, valid_to)`,

  // 券实例：一张具体的券。
  // `coupon_code` 唯一 —— 「一张券只能被核销一次」这件事必须由库保证，
  // 靠应用层"查一下状态再改"在并发下必然双花。
  `CREATE TABLE IF NOT EXISTS coupon_instances (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id    INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    coupon_code  TEXT NOT NULL UNIQUE,
    customer_id  INTEGER,                          -- 定向发放时指定；自领时写入领取人
    status       TEXT NOT NULL DEFAULT 'unused',   -- unused / used / expired / void
    acquired_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    expires_at   TEXT,                             -- 本张券的实际失效时刻（绝对期与相对期取小）
    used_at      TEXT,
    order_id     INTEGER,
    used_amount  INTEGER NOT NULL DEFAULT 0,       -- 实际抵扣额（分）
    remark       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_inst_coupon ON coupon_instances(coupon_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_coupon_inst_customer ON coupon_instances(customer_id, status)`
]

// ---------------------------------------------------------------------------
// 三、会员域（等级 + 账户 + 两本流水）
//
// 会员的既有底座是 `mall_customers`（H5 商城登录即会员，主键是手机号那一侧）。
// 它已经有 `points` 一列 —— 但**没有流水**。裸计数的问题不是"不准"，而是"说不清"：
// 客户问「我的 500 分怎么来的」，账上只能回答"就是 500"。
// 所以本迁移把 `points` 保留为**展示用的余额**，另建 `member_points_ledger` 作为唯一真相，
// 并加一条可断言的不变量：**账户余额 ≡ 流水合计**（verify-seed 与单测都盯这条）。
//
// 积分与储值分两本流水、而不是一本带 `account` 判别列的表：
//   两者**单位不同**（积分 vs 分），混在一张表里每一次 SUM 都要带过滤条件，
//   而漏过滤不会报错、只会把"3 元"和"300 积分"加成 303 ——
//   这与成本域"金额与数量不能共用一个舍入函数"是同一条教训。
// ---------------------------------------------------------------------------

const MEMBER_TABLES = [
  // ⚠️ 单位全部写进列名（`_yuan` / `_cents` / `_points`）。
  //    会员域里同时存在**元、分、积分**三种量纲，靠"记得哪列是元"区分是必然出错的 ——
  //    本项目在成本域已经因为「金额与数量共用一个舍入函数」栽过一次，
  //    同一条教训在这里的形态是「把 3 元加成 300 积分」。列名带单位，读代码时看得见。
  `CREATE TABLE IF NOT EXISTS member_levels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    code                TEXT NOT NULL UNIQUE,        -- normal / silver / gold / platinum
    name                TEXT NOT NULL,
    min_points          INTEGER NOT NULL DEFAULT 0,  -- 升级门槛：累计**积分**
    min_spent_yuan      REAL NOT NULL DEFAULT 0,     -- 升级门槛：累计消费（**元**，配置档位，人读写）
    discount_pct        INTEGER NOT NULL DEFAULT 10000, -- 等级折扣（万分比，10000=无折扣）
    points_rate         INTEGER NOT NULL DEFAULT 100,   -- 积分倍率（100=1 倍，200=2 倍）
    points_deduct_limit INTEGER NOT NULL DEFAULT 0,     -- 积分抵扣上限（占订单额万分比，0=不可抵）
    benefits            TEXT,                           -- 权益说明（界面展示用，纯文本）
    sort_order          INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'active'
  )`,

  // 会员账户：一个客户一条。points / balance_cents 是**余额**，不是真相；
  // 真相在两张流水表里。points_total 只增不减，专用于等级判定 ——
  // 用「可用积分」判等级会让客户一兑换就掉级，那是产品事故不是设计。
  `CREATE TABLE IF NOT EXISTS member_accounts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id        INTEGER NOT NULL UNIQUE,          -- 指 mall_customers.id
    level_code         TEXT NOT NULL DEFAULT 'normal',
    points             INTEGER NOT NULL DEFAULT 0,       -- 当前可用**积分**
    points_total       INTEGER NOT NULL DEFAULT 0,       -- 累计获得**积分**（只增，等级判定用）
    balance_cents      INTEGER NOT NULL DEFAULT 0,       -- 储值余额（**分**）
    total_spent_cents  INTEGER NOT NULL DEFAULT 0,       -- 累计消费（**分**）
    upgraded_at        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_member_accounts_level ON member_accounts(level_code)`,

  // 积分流水（唯一真相）。`balance_after_points` 让"某一刻余额是多少"可以按行回放 ——
  // 只存 change 的话，查任意时点余额都要全表累加，且对不上时无从定位是哪一笔错的。
  `CREATE TABLE IF NOT EXISTS member_points_ledger (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id         INTEGER NOT NULL,
    kind                TEXT NOT NULL,               -- earn 获得 / redeem 兑换 / adjust 手工调整 / expire 过期 / level_up 等级变更（零变动留痕）
    change_points       INTEGER NOT NULL,            -- 变动（**积分**，正得负失）
    balance_after_points INTEGER NOT NULL,
    source_type         TEXT,                        -- order / manual / level_up ...
    source_id           INTEGER,
    doc_no              TEXT,
    remark              TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_points_ledger_cust ON member_points_ledger(customer_id, id)`,

  // 储值流水（唯一真相，单位为**分**）
  `CREATE TABLE IF NOT EXISTS member_balance_ledger (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id         INTEGER NOT NULL,
    kind                TEXT NOT NULL,               -- recharge 充值 / pay 消费 / refund 退还 / adjust 调整
    change_cents        INTEGER NOT NULL,            -- 变动（**分**，正入负出）
    balance_after_cents INTEGER NOT NULL,
    source_type         TEXT,
    source_id           INTEGER,
    doc_no              TEXT,
    remark              TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_balance_ledger_cust ON member_balance_ledger(customer_id, id)`
]

// 视图：会员总览（账户 + 等级 + 券张数一屏）。
// 口径只有一处 —— 界面与报表都从这里读，不各自 JOIN 一遍。
const VIEWS = [
  `CREATE VIEW IF NOT EXISTS v_member_overview AS
   SELECT a.id                AS account_id,
          a.customer_id,
          c.phone,
          c.name,
          a.level_code,
          l.name              AS level_name,
          l.discount_pct,
          l.points_rate,
          l.points_deduct_limit,
          l.min_points,
          l.min_spent_yuan,
          a.points,
          a.points_total,
          a.balance_cents,
          a.total_spent_cents,
          (SELECT COUNT(*) FROM coupon_instances ci WHERE ci.customer_id = a.customer_id AND ci.status = 'unused') AS coupon_unused,
          (SELECT COUNT(*) FROM coupon_instances ci WHERE ci.customer_id = a.customer_id AND ci.status = 'used')   AS coupon_used,
          a.upgraded_at,
          a.updated_at
     FROM member_accounts a
     JOIN mall_customers   c ON c.id = a.customer_id
     LEFT JOIN member_levels l ON l.code = a.level_code`
]

// `mall_customers` 扩列：等级冗余一列，列表页不必逐行 JOIN
const CUSTOMER_COLUMNS = [
  ['level_code', "TEXT NOT NULL DEFAULT 'normal'"]
]

// `oms_order_items` 扩列：**行级优惠三段**（会员 / 促销 / 积分），单位都是「分」。
//
// 为什么必须落到**行**上，而不是只在订单头记一个 `discount_amount`：
//   订单头那个折扣额回答不了「减在哪几行」，于是退货时算不出「这一行实付多少」——
//   只能按比例反推，而反推出来的数与当初实际优惠经常差几分钱，
//   差额会攒成一笔说不清的钱（本项目在成本域见过同一个形态）。
//   落行之后，退货直接读行上的三段优惠即可，不需要任何反推。
//
// 为什么是**三段而不是一段总和**：
//   三段的**退款策略不同** —— 会员折扣是客户权益（退货时应当收回额度但不退钱）、
//   促销优惠是营销费用（退货时营销预算要回退）、积分抵现是客户资产（退货时要退积分）。
//   合成一段之后这四件事全都做不了，只能看到一个数。
const ORDER_ITEM_COLUMNS = [
  ['member_discount_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['promo_discount_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['points_discount_cents', 'INTEGER NOT NULL DEFAULT 0']
]

const PERMS = [
  ['mall.promotion.view', '查看促销活动', 'mall', 'menu'],
  ['mall.promotion.edit', '新建与编辑促销', 'mall', 'action'],
  ['mall.promotion.publish', '启停与发布促销', 'mall', 'action'],
  ['mall.coupon.view', '查看优惠券', 'mall', 'menu'],
  ['mall.coupon.issue', '发放与作废优惠券', 'mall', 'action'],
  ['mall.member.view', '查看会员与积分', 'mall', 'menu'],
  ['mall.member.edit', '调整会员等级积分与储值', 'mall', 'action']
]

const ROLE_GRANTS = {
  admin: ['mall.promotion.view', 'mall.promotion.edit', 'mall.promotion.publish',
    'mall.coupon.view', 'mall.coupon.issue', 'mall.member.view', 'mall.member.edit'],
  boss: ['mall.promotion.view', 'mall.coupon.view', 'mall.member.view'],
  marketing: ['mall.promotion.view', 'mall.promotion.edit', 'mall.promotion.publish',
    'mall.coupon.view', 'mall.coupon.issue', 'mall.member.view'],
  sales: ['mall.promotion.view', 'mall.coupon.view', 'mall.member.view'],
  finance: ['mall.promotion.view', 'mall.coupon.view', 'mall.member.view'],
  warehouse: [],
  viewer: ['mall.promotion.view', 'mall.coupon.view', 'mall.member.view']
}

// 等级基线：四个等级。演示数据会按这些档位造客户，
// 所以**必须在迁移里**（而不是 seed 里）定义 —— 否则空库上来就没有等级可用。
const LEVELS = [
  ['normal', '普通会员', 0, 0, 10000, 100, 0, '注册即会员；消费 1 元得 10 积分', 10],
  ['silver', '银牌会员', 2000, 2000, 9800, 120, 2000, '全场 98 折；积分 1.2 倍；可用积分抵现（上限订单额 20%）', 20],
  ['gold', '金牌会员', 8000, 8000, 9500, 150, 3000, '全场 95 折；积分 1.5 倍；可用积分抵现（上限 30%）；生日双倍积分', 30],
  ['platinum', '铂金会员', 30000, 30000, 9200, 200, 5000, '全场 92 折；积分 2 倍；可用积分抵现（上限 50%）；专属客服', 40]
]

// 口径默认值。
// 注意 `settings` 表只有 `(key, value, updated_at)` 三列，**没有 remark 列** ——
// 别在这里写「带说明的 INSERT」，那会在建表后第一次启动就报
// `table settings has no column named remark`。说明写成本文件的注释即可。
const SETTINGS = [
  // 消费 1 元得多少积分（与等级倍率相乘）
  ['promo_points_per_yuan', '10'],
  // 多少积分抵 1 元（越大越不值钱）
  ['promo_points_per_yuan_deduct', '100'],
  // 积分抵扣上限的全局兜底（万分比，占订单金额）；等级自己的 points_deduct_limit 更低时以等级为准
  ['promo_points_deduct_max', '5000'],
  // 自动升降级开关。关掉后等级只能手工改（老客户补偿等场景）
  ['member_upgrade_auto', '1']
]

module.exports.up = function up(db) {
  for (const sql of [...PROMO_TABLES, ...COUPON_TABLES, ...MEMBER_TABLES]) db.exec(sql)

  // 视图：整库重建会先 DROP 所有视图，所以这里用 IF NOT EXISTS 幂等重建
  for (const sql of VIEWS) db.exec(sql)

  // 已存在的表扩列
  for (const [col, decl] of CUSTOMER_COLUMNS) {
    if (tableExists(db, 'mall_customers')) addColumn(db, 'mall_customers', col, decl)
  }
  // 行级优惠三段落到订单行上。`oms_order_items` 由更早的迁移建出，
  // 这里只做 addColumn；表不存在（极老的空库）就跳过，不阻断迁移。
  for (const [col, decl] of ORDER_ITEM_COLUMNS) {
    if (tableExists(db, 'oms_order_items')) addColumn(db, 'oms_order_items', col, decl)
  }

  // 权限
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

  // 会员等级基线。用 ON CONFLICT DO UPDATE 而不是 INSERT OR IGNORE：
  // 等级权益是**配置**，改了就该生效；只插入不更新会让"改了 benefits 界面没变"这类
  // 问题变成一次人工查库。（等级本身不承载余额，覆盖写是安全的。）
  const upLevel = db.prepare(`
    INSERT INTO member_levels (code,name,min_points,min_spent_yuan,discount_pct,points_rate,points_deduct_limit,benefits,sort_order,status)
    VALUES (?,?,?,?,?,?,?,?,?,'active')
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name, min_points=excluded.min_points, min_spent_yuan=excluded.min_spent_yuan,
      discount_pct=excluded.discount_pct, points_rate=excluded.points_rate,
      points_deduct_limit=excluded.points_deduct_limit, benefits=excluded.benefits,
      sort_order=excluded.sort_order
  `)
  for (const lv of LEVELS) upLevel.run(...lv)

  // 口径默认值
  if (tableExists(db, 'settings')) {
    const upSet = db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO NOTHING`
    )
    for (const [k, v] of SETTINGS) upSet.run(k, v)
  }

  stampDef(db, '025_promo_member', {
    promo: PROMO_TABLES, coupon: COUPON_TABLES, member: MEMBER_TABLES, views: VIEWS,
    customerCols: CUSTOMER_COLUMNS, orderItemCols: ORDER_ITEM_COLUMNS,
    perms: PERMS, roles: ROLE_GRANTS, levels: LEVELS, settings: SETTINGS
  })
  return {
    promo: PROMO_TABLES.length, coupon: COUPON_TABLES.length, member: MEMBER_TABLES.length,
    views: VIEWS.length, perms: PERMS.length, orderItemCols: ORDER_ITEM_COLUMNS.length
  }
}

module.exports.verify = function verify(db) {
  for (const t of [
    'promotion_campaigns', 'promotion_campaign_budgets', 'promotions', 'promotion_rules',
    'promotion_methods', 'promotion_usages', 'promotion_adjustments'
  ]) {
    if (!tableExists(db, t)) return false
  }
  for (const t of ['coupons', 'coupon_instances']) if (!tableExists(db, t)) return false
  for (const t of ['member_levels', 'member_accounts', 'member_points_ledger', 'member_balance_ledger']) {
    if (!tableExists(db, t)) return false
  }
  // 视图是口径的落点，必须一起自检 —— 整库重建会先 DROP 所有视图，
  // 只查表存在会把「视图凭空消失」误判成「已迁移」，而依赖它的查询要到运行时才炸。
  for (const v of ['v_member_overview']) {
    if (!db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='view' AND name=?").get(v)) return false
  }
  for (const [col] of CUSTOMER_COLUMNS) {
    if (tableExists(db, 'mall_customers') && !hasColumn(db, 'mall_customers', col)) return false
  }
  for (const [col] of ORDER_ITEM_COLUMNS) {
    if (tableExists(db, 'oms_order_items') && !hasColumn(db, 'oms_order_items', col)) return false
  }

  if (!hasIndex(db, 'idx_promotions_active')) return false
  if (!hasIndex(db, 'idx_promotion_usages_promo')) return false
  if (!hasIndex(db, 'idx_promotion_adj_order')) return false
  if (!hasIndex(db, 'idx_coupon_inst_coupon')) return false
  if (!hasIndex(db, 'idx_points_ledger_cust')) return false

  // 结构承载的三条硬口径 —— 靠库自己保证，不靠应用层记得：
  // ① 幂等键唯一：同一订单同一促销不可能登记两次（防超发的底座）
  const u1 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='promotion_usages'").get()
  if (!u1 || !/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(u1.sql)) return false
  // ② 券码唯一：一张券不可能被核销两次
  const u2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='coupon_instances'").get()
  if (!u2 || !/coupon_code\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(u2.sql)) return false
  // ③ 一个客户一个账户：余额不会分成两半
  const u3 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='member_accounts'").get()
  if (!u3 || !/customer_id\s+INTEGER\s+NOT NULL\s+UNIQUE/i.test(u3.sql)) return false
  // ④ 一张促销一个优惠方式：两个方式会让「减多少」变成不确定
  const u4 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='promotion_methods'").get()
  if (!u4 || !/promotion_id\s+INTEGER\s+NOT NULL\s+UNIQUE/i.test(u4.sql)) return false

  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  // 四个等级必须都在。空库上来没有等级可用，会员域等于没建。
  for (const [code] of LEVELS) {
    if (!db.prepare('SELECT 1 AS hit FROM member_levels WHERE code=?').get(code)) return false
  }
  if (tableExists(db, 'settings')) {
    for (const [k] of SETTINGS) {
      if (!db.prepare('SELECT 1 AS hit FROM settings WHERE key=?').get(k)) return false
    }
  }

  // 指纹里的字段必须与 up 的 stampDef **逐字一致**。
  // 少写一个字段的后果不是"漏检"，而是指纹永远对不上 → verify 恒为 false →
  // 每次启动都重跑一遍 up。它不会报错，只会让每次启动都慢一截。
  if (
    defStale(db, '025_promo_member', {
      promo: PROMO_TABLES, coupon: COUPON_TABLES, member: MEMBER_TABLES, views: VIEWS,
      customerCols: CUSTOMER_COLUMNS, orderItemCols: ORDER_ITEM_COLUMNS,
      perms: PERMS, roles: ROLE_GRANTS, levels: LEVELS, settings: SETTINGS
    })
  ) {
    return false
  }
  return true
}
