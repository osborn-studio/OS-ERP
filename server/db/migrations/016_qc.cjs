'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/016_qc.cjs ｜ 迁移：采购质检单：到货单与质检单拆分
 * ============================================================================
 * 【职责】迁移：采购质检单：到货单与质检单拆分
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 016 采购质检单（INS）：到货单与质检单拆分
//
// 为什么必须拆成两张单：
//   到货单（GR）记的是**事实** —— 送来了什么、多少件、什么批次、什么效期。
//   质检单（INS）记的是**判断** —— 收不收、收多少合格、多少让步接收、多少判退、为什么。
//   两者混在一张单上的后果不是「不够优雅」，而是：
//     · 质检结论无处可落，只能塞进到货单的备注里，于是「判退了多少」既算不出也追不到责；
//     · 判退的货没有单据承接，退货单不会被生成，劣品只能靠人去记；
//     · 到货单要同时承担「已收货」与「已质检」两种语义，状态机说不清话。
//
// 结构：
//   purchase_inspections      质检单头（挂到货单，一票一单）
//   purchase_inspection_items 质检单行（挂到货单行，一票一行，拆合格/让步/判退三个数）
//
// 一条口径：**三数闭合** qualified_qty + concession_qty + rejected_qty = qty（到货数）。
//   不闭合说明录入漏了 —— 漏掉的货既没算合格也没算退货，会凭空消失。
//   写入前由服务层强校验，不留「以后再补」的口子。
//
// 定义（doc_types / doc_states / doc_actions / biz_flows）归 008 单据内核 ——
// 写在这里会被 008 的自愈重跑抹掉。

const { tableExists, hasColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '采购质检单：到货单与质检单拆分'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS purchase_inspections (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     doc_no         TEXT NOT NULL UNIQUE,
     receipt_id     INTEGER NOT NULL,               -- 到货单（purchase_receipts.id）
     receipt_no     TEXT,                           -- 快照：到货单号（单据改名不影响历史）
     order_id       INTEGER,                        -- 冗余自到货单，便于按订单联查
     supplier_id    INTEGER NOT NULL,
     warehouse_id   INTEGER NOT NULL,
     inspect_date   TEXT NOT NULL,
     -- 检验员：id 用于权限与追责，name 存快照（人走了名字还得留着）
     inspect_by     INTEGER,
     inspect_by_name TEXT,
     -- 结论：全部合格 / 让步接收 / 部分判退 / 全部判退
     result         TEXT NOT NULL DEFAULT 'pending',
     -- 四个数：到货 / 合格 / 让步接收 / 判退
     total_qty      REAL NOT NULL DEFAULT 0,
     qualified_qty  REAL NOT NULL DEFAULT 0,
     concession_qty REAL NOT NULL DEFAULT 0,
     rejected_qty   REAL NOT NULL DEFAULT 0,
     return_id      INTEGER,                        -- 判退生成的采购退货单（PRT）
     return_no      TEXT,
     status         TEXT NOT NULL DEFAULT 'draft',
     remark         TEXT,
     created_by     INTEGER,
     created_by_name TEXT,
     created_at     TEXT,
     updated_at     TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_inspection_items (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     inspection_id   INTEGER NOT NULL REFERENCES purchase_inspections(id) ON DELETE CASCADE,
     line_no         INTEGER NOT NULL,
     receipt_item_id INTEGER,                       -- 到货单行（关联到批次）
     sku_id          INTEGER,
     batch_no        TEXT,
     qty             REAL NOT NULL DEFAULT 0,       -- 到货数量（事实，来自到货单行）
     qualified_qty   REAL NOT NULL DEFAULT 0,       -- 合格（入库）
     concession_qty  REAL NOT NULL DEFAULT 0,       -- 让步接收（入库，但要留痕）
     rejected_qty    REAL NOT NULL DEFAULT 0,       -- 判退（不进正品库存）
     defect_code     TEXT,                          -- 不合格原因码
     defect_reason   TEXT,                          -- 不合格说明
     remark          TEXT
   )`
]

const INDEXES = [
  // 一票一单：同一张到货单不允许有两张有效质检单（否则「这批货到底判了没有」会有两个答案）
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_inspection_receipt ON purchase_inspections (receipt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_status ON purchase_inspections (status, inspect_date)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_supplier ON purchase_inspections (supplier_id, inspect_date)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_items ON purchase_inspection_items (inspection_id, line_no)`
]

// 一个**从来没被声明过的权限点**：008 里 GR 的质检边与 WR 的质检环节都写着 quality.inspect，
// 但 005 的权限清单里没有它 —— 于是除了 admin（走 is_super 短路），没有任何角色能获得质检权。
// 这类缺口不会报错，只会表现为「这个按钮点了没反应 / 质检岗配了权限也没用」。
const PERMS = [
  ['quality.inspect.view', '查看质检单', 'quality', 'menu'],
  ['quality.inspect', '质检判定与提交', 'quality', 'action'],
  ['quality.inspect.edit', '新建与修改质检单', 'quality', 'action']
]

const ROLE_GRANTS = {
  admin: ['quality.inspect.view', 'quality.inspect', 'quality.inspect.edit'],
  boss: ['quality.inspect.view'],
  purchase: ['quality.inspect.view', 'quality.inspect', 'quality.inspect.edit'],
  warehouse: ['quality.inspect.view', 'quality.inspect', 'quality.inspect.edit'],
  viewer: ['quality.inspect.view']
}

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of INDEXES) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 4400)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  stampDef(db, '016_qc', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, indexes: INDEXES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'purchase_inspections')) return false
  if (!tableExists(db, 'purchase_inspection_items')) return false
  for (const col of ['qualified_qty', 'concession_qty', 'rejected_qty', 'return_id', 'result']) {
    if (!hasColumn(db, 'purchase_inspections', col)) return false
  }
  for (const idx of ['uq_inspection_receipt', 'idx_inspection_status', 'idx_inspection_items']) {
    if (!hasIndex(db, idx)) return false
  }
  // 权限点缺了不算结构缺失，但它是「质检岗配了权限也没用」的根因 —— 一并纳入自愈检查
  if (tableExists(db, 'permissions')) {
    const miss = PERMS.filter(([code]) => !db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code))
    if (miss.length) return false
  }
  if (defStale(db, '016_qc', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })) return false
  return true
}
