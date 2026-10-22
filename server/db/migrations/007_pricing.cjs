'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/007_pricing.cjs ｜ 迁移：价格中心（价格组/阶梯价/取价规则/调价留痕）
 * ============================================================================
 * 【职责】迁移：价格中心（价格组/阶梯价/取价规则/调价留痕）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 007 价格中心：价格组（四维自由组合）+ 阶梯价 + 取价优先级 + 调价留痕
//
// 依据：
//   第三轮 C1「价格组四维自由组合、不设主维」（渠道 × 门店类型 × 经销商等级 × 区域）
//   第三轮 C2 取价顺序：促销价 > 会员价 > 价格组价 > 标准零售价
//   第四轮补充：四维组合会爆炸 → 用「命名组合 + 优先级排序」实现
//
// 设计判断：
//   不设主维意味着不能靠固定维度树取值，必须靠**优先级 + 匹配度**打分：
//   组合越具体（匹配的维度越多）优先级越高，同分时按 priority 字段人工排序。
//   这样既能表达「华东加盟店银牌经销商」这种细组合，又不用为每个组合建一张表。

const { addColumn } = require('./_helpers.cjs')

module.exports.name = '价格中心（价格组/阶梯价/取价规则/调价留痕）'
module.exports.up = function up(db) {
  db.exec(`
    -- 价格组：四维标签可自由组合，未填的维度视为「不限」
    CREATE TABLE IF NOT EXISTS price_groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      channel      TEXT,                    -- direct直营 / franchise加盟 / dealer经销商 / online线上 / pos门店（空=不限）
      store_type   TEXT,                    -- direct / counter / franchise（空=不限）
      dealer_level TEXT,                    -- gold / silver（空=不限）
      region       TEXT,                    -- 华东 / 华南 / 香港（空=不限）
      currency     TEXT NOT NULL DEFAULT 'CNY',
      priority     INTEGER NOT NULL DEFAULT 100,  -- 同匹配度时的人工排序，越小越优先
      effect_from  TEXT,
      effect_to    TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      remark       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_pg_dims ON price_groups(channel, store_type, dealer_level, region);

    -- 价格组明细：支持阶梯价（min_qty）
    CREATE TABLE IF NOT EXISTS price_group_items (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES price_groups(id) ON DELETE CASCADE,
      sku_id   INTEGER NOT NULL REFERENCES product_skus(id),
      price    REAL NOT NULL DEFAULT 0,
      min_qty  REAL NOT NULL DEFAULT 1,
      UNIQUE (group_id, sku_id, min_qty)
    );
    CREATE INDEX IF NOT EXISTS idx_pgi_group ON price_group_items(group_id);
    CREATE INDEX IF NOT EXISTS idx_pgi_sku   ON price_group_items(sku_id);

    -- 价格组与对象的绑定：可绑到具体组织（门店/经销商），也可只靠四维标签圈定
    CREATE TABLE IF NOT EXISTS price_group_targets (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES price_groups(id) ON DELETE CASCADE,
      org_id   INTEGER REFERENCES orgs(id),
      UNIQUE (group_id, org_id)
    );

    -- 会员价：按会员等级定价（会员中心未上线前先建表，取价引擎按优先级接入）
    CREATE TABLE IF NOT EXISTS member_prices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_id       INTEGER NOT NULL REFERENCES product_skus(id),
      member_level TEXT NOT NULL DEFAULT 'normal',
      price        REAL NOT NULL DEFAULT 0,
      UNIQUE (sku_id, member_level)
    );

    -- 调价留痕：谁能改价、改了多少、为什么 —— 价格是最敏感的数据之一
    CREATE TABLE IF NOT EXISTS price_change_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity      TEXT NOT NULL,            -- product / sku / price_group / member
      entity_id   INTEGER NOT NULL,
      field       TEXT,
      old_value   REAL,
      new_value   REAL,
      currency    TEXT DEFAULT 'CNY',
      reason      TEXT,
      operator    TEXT,
      source      TEXT DEFAULT 'web',       -- web / mcp / import
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_pcl_entity ON price_change_logs(entity, entity_id);
    CREATE INDEX IF NOT EXISTS idx_pcl_time   ON price_change_logs(created_at);

    -- 取价规则（顺序可配，对应 C2 口径）
    CREATE TABLE IF NOT EXISTS price_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      seq        INTEGER NOT NULL,          -- 越小越先匹配
      enabled    INTEGER NOT NULL DEFAULT 1,
      remark     TEXT
    );
  `)

  const rules = [
    ['promotion', '促销价', 10, '活动期间的特价，优先级最高'],
    ['member', '会员价', 20, '按会员等级取价'],
    ['price_group', '价格组价', 30, '按渠道/门店类型/经销商等级/区域四维匹配'],
    ['contract', '合同价', 25, '一客一价的合同约定价'],
    ['standard', '标准零售价', 90, '兜底价，取商品/SKU 的零售价']
  ]
  const ins = db.prepare(
    'INSERT OR IGNORE INTO price_rules (code, name, seq, remark) VALUES (?,?,?,?)'
  )
  rules.forEach((r) => ins.run(r[0], r[1], r[2], r[3]))

  // 商品/SKU 补价格辅助字段
  addColumn(db, 'product_skus', 'price_cost', 'REAL DEFAULT 0')     // 参考成本价（对内）
  addColumn(db, 'product_skus', 'price_min', 'REAL DEFAULT 0')      // 最低限价（防止乱价）
  addColumn(db, 'products', 'price_min', 'REAL DEFAULT 0')
}

module.exports.verify = function verify(db) {
  const { tableExists } = require('./_helpers.cjs')
  return (
    tableExists(db, 'price_groups') &&
    tableExists(db, 'price_group_items') &&
    tableExists(db, 'price_rules') &&
    tableExists(db, 'price_change_logs') &&
    db.prepare('SELECT COUNT(*) c FROM price_rules').get().c >= 5
  )
}
