'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/001_orgs.cjs ｜ 迁移：组织主体 orgs 与业务主体职责
 * ============================================================================
 * 【职责】迁移：组织主体 orgs 与业务主体职责
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 001 组织主体（orgs）与业务主体职责
// 依据：第一轮「组织 = 单法人 + 多业务主体」「主体决定货主」；第三轮 B1 四层主体、B2 加盟店独立主体、B3 央厨归总部、3.1 多币种地区

const { addColumn } = require('./_helpers.cjs')

module.exports.name = '组织主体 orgs 与业务主体职责'
module.exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      short_name    TEXT,
      -- group总部 / region区域 / store门店 / warehouse仓库 / kitchen中央厨房 / dealer经销商 / supplier供应商
      type          TEXT NOT NULL DEFAULT 'store',
      parent_id     INTEGER REFERENCES orgs(id),
      level         INTEGER NOT NULL DEFAULT 1,
      path          TEXT,                                  -- 层级路径，如 /1/3/12/，便于子树查询
      is_legal      INTEGER NOT NULL DEFAULT 0,            -- 是否法人主体
      owner_org_id  INTEGER REFERENCES orgs(id),           -- 货主（默认取自身；直营门店仓取总部；加盟店取自身）
      region        TEXT,                                  -- 地区（含 HK）
      currency      TEXT NOT NULL DEFAULT 'CNY',           -- 本位币
      tax_region    TEXT,                                  -- 税区（内地 / 中国香港）
      brand_id      INTEGER,                               -- 品牌（餐饮多品牌）
      store_id      INTEGER,                               -- 关联门店
      warehouse_id  INTEGER,                               -- 关联仓库
      status        TEXT NOT NULL DEFAULT 'active',
      remark        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_orgs_parent  ON orgs(parent_id);
    CREATE INDEX IF NOT EXISTS idx_orgs_type    ON orgs(type);
    CREATE INDEX IF NOT EXISTS idx_orgs_path    ON orgs(path);
    CREATE INDEX IF NOT EXISTS idx_orgs_owner   ON orgs(owner_org_id);
    CREATE INDEX IF NOT EXISTS idx_orgs_region  ON orgs(region);
    CREATE INDEX IF NOT EXISTS idx_orgs_brand   ON orgs(brand_id);

    -- 业务主体职能开关：同一组织可开不同职能
    CREATE TABLE IF NOT EXISTS org_functions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      func_code  TEXT NOT NULL,   -- purchase/sales/inventory/pos/wms/ordering/finance/production
      enabled    INTEGER NOT NULL DEFAULT 1,
      UNIQUE (org_id, func_code)
    );
  `)

  // 既有主数据挂到组织上
  addColumn(db, 'warehouses', 'org_id', 'INTEGER')
  addColumn(db, 'warehouses', 'default_owner_org_id', 'INTEGER')
  addColumn(db, 'warehouses', 'currency', "TEXT NOT NULL DEFAULT 'CNY'")
  addColumn(db, 'warehouses', 'region', 'TEXT')
  addColumn(db, 'warehouses', 'brand_id', 'INTEGER')

  addColumn(db, 'stores', 'org_id', 'INTEGER')
  addColumn(db, 'stores', 'owner_org_id', 'INTEGER')
  addColumn(db, 'stores', 'brand_id', 'INTEGER')
  addColumn(db, 'stores', 'currency', "TEXT NOT NULL DEFAULT 'CNY'")
  addColumn(db, 'stores', 'tax_region', 'TEXT')
}

// 结构自检：任一不满足即视为迁移脱节，运行器会重跑本迁移（up 幂等）
module.exports.verify = function verify(db) {
  const { tableExists, hasColumn } = require('./_helpers.cjs')
  return (
    tableExists(db, 'orgs') &&
    tableExists(db, 'org_functions') &&
    hasColumn(db, 'warehouses', 'org_id') &&
    hasColumn(db, 'warehouses', 'default_owner_org_id') &&
    hasColumn(db, 'warehouses', 'currency') &&
    hasColumn(db, 'stores', 'org_id') &&
    hasColumn(db, 'stores', 'owner_org_id')
  )
}
