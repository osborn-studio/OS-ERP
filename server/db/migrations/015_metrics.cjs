'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/015_metrics.cjs ｜ 迁移：数据口径字典：指标定义
 * ============================================================================
 * 【职责】迁移：数据口径字典：指标定义
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 015 数据口径字典：metric_defs
//
// 为什么口径要进库，而不是只写在代码注释里：
//   ① 口径要能被 **SQL 直查** —— 报表想确认「这个数怎么来的」时，能 join 到定义；
//   ② 口径要能被 **AI 读懂** —— /api/ai/schema 暴露表结构时，AI 才知道
//      「销售额」不该等于 SUM(所有订单)；
//   ③ 口径变更要**留痕可比对** —— 有表才有 updated_at，才知道哪天动过。
//
// 但**代码是唯一源**（server/lib/metrics.js 里的 METRICS）：
//   定义与 compute 函数必须写在一起，否则「文档写的」和「代码算的」必然分家。
//   本表只是投影，由 `syncMetricDefs()` 在启动/迁移后幂等覆盖。
//   表里多出来的旧指标会被删除 —— 只增不减会让字典越读越糊涂。
//
// 因此本迁移只建结构，**不灌数据**：灌数据需要 METRICS，而迁移是 .cjs（同步 require），
// 拿不到 ESM 定义。灌数交给 syncMetricDefs，测试负责保证两者一致。

const { tableExists, hasColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '数据口径字典：指标定义'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS metric_defs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     key         TEXT NOT NULL UNIQUE,               -- 指标键（如 sales_amount）
     name        TEXT NOT NULL,                      -- 中文名
     module      TEXT NOT NULL,                      -- 归属模块（分组展示用）
     category    TEXT,                               -- 分类：规模 / 效率 / 资金 / 风险 / 流程
     unit        TEXT,                               -- 单位：CNY / 件 / % / 天 / 个
     formula     TEXT NOT NULL,                      -- 计算口径（人能照着复现）
     exclusions  TEXT,                               -- **不含什么**（比包含项更容易出错）
     source      TEXT,                               -- 来源表
     note        TEXT,                               -- 踩坑提示 / 为什么这么定
     updated_at  TEXT
   )`
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_metric_defs_module ON metric_defs (module, key)`
]

// 查看与重投影**分开授权**：能看口径的人远多于该改口径投影的人。
// 重投影是一次「以代码覆盖表」的写动作，一旦放开给所有能看的角色，
// 任何人在任何时刻都能改掉别人正在查的定义 —— 与通知中心「看配置 ≠ 能推送」同一取舍。
const PERMS = [
  ['system:metrics:view', '查看数据口径字典', 'system', 'read', 4200],
  ['system:metrics:sync', '重投影数据口径字典', 'system', 'write', 4201]
]

const ROLE_GRANTS = {
  admin: ['system:metrics:view', 'system:metrics:sync'],
  boss: ['system:metrics:view'],
  finance: ['system:metrics:view'],
  purchase: ['system:metrics:view'],
  sales: ['system:metrics:view'],
  warehouse: ['system:metrics:view'],
  dealer: ['system:metrics:view'],
  store: ['system:metrics:view'],
  viewer: ['system:metrics:view']
}

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of INDEXES) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category, sortOrder] of PERMS) upPerm.run(code, name, module, category, sortOrder)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  stampDef(db, '015_metrics', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, indexes: INDEXES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'metric_defs')) return false
  for (const sql of INDEXES) {
    const m = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)
    if (m && !hasIndex(db, m[1])) return false
  }
  for (const col of ['formula', 'exclusions', 'source', 'note', 'unit']) {
    if (!hasColumn(db, 'metric_defs', col)) return false
  }
  if (defStale(db, '015_metrics', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })) return false
  return true
}
