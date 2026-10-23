'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/066_pos_settle_permission.cjs ｜ 权限点 pos.shift.settle（交班差异结案，AA9 / ADR-0025 补充）
 * ============================================================================
 * 【为什么】`POST /api/pos/shifts/:id/settle-variance` 原来用角色名 `requireRole('admin','finance')`；改为权限点后，
 *   自定义角色也能被授予或收回该动作。为不让现有结案人失去能力，默认授予 admin、内置 `finance`（原角色名放行者）
 *   与内置 `store`（店长，路线图 v6 AA9 指定）。其余内置角色不授予。
 * 【ADR-0007 口径】授权只在权限点第一次出现时给；`verify()` 只查字典，管理员事后削减不被恢复。
 * 【编号】063~065 分配给并行工作流（AA3 等），运行器按文件名排序，缺号不影响。
 * ============================================================================
 */
const { tableExists } = require('./_helpers.cjs')

module.exports.name = '交班差异结案权限点 pos.shift.settle'

const PERM = ['pos.shift.settle', '交班差异结案（挂账差异落案）', 'pos', 'action', 5320]
const ROLES = ['admin', 'finance', 'store']

module.exports.up = (db) => {
  if (!tableExists(db, 'permissions')) return
  const existed = !!db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])
  db.prepare(
    `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
  ).run(...PERM)
  if (existed || !tableExists(db, 'role_permissions')) return
  const hasRole = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?')
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
  for (const role of ROLES) if (hasRole.get(role)) ins.run(role, PERM[0])
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'permissions')) return true
  return !!db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])
}
