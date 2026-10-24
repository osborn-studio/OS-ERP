'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/062_audit_view_permission.cjs ｜ 权限点 system:audit:view（审计日志查看与导出，Z7 / roadmap-v5 Z7）
 * ============================================================================
 * 【为什么】`GET /api/meta/audit-logs` 与 CSV 导出需要一个独立权限点；旧字典里只有 005 的点号风格 `system.audit.view`
 *   （从未被任何路由使用，且 005 把整个 system 模块都授给了 boss）。沿用它会让 boss 悄悄获得审计导出，
 *   所以新增冒号风格的 `system:audit:view`（与 `system:approval:*` 同风格），只授 admin；旧点不动、不复用。
 * 【ADR-0007 口径】授权只在权限点第一次出现时给 admin；`verify()` 只查字典，不查角色授权集合。
 * 【迁移安全】纯加法：一条权限 upsert。
 * ============================================================================
 */
const { tableExists } = require('./_helpers.cjs')

module.exports.name = '审计日志查看权限点 system:audit:view'

const PERM = ['system:audit:view', '查看与导出审计日志', 'system', 'read', 4130]

module.exports.up = (db) => {
  if (!tableExists(db, 'permissions')) return
  const existed = !!db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])
  db.prepare(
    `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
  ).run(...PERM)
  if (existed || !tableExists(db, 'role_permissions')) return
  const hasRole = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get('admin')
  if (hasRole) db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)').run('admin', PERM[0])
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'permissions')) return true
  return !!db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])
}
