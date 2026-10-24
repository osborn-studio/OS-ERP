'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/063_approval_template_perm.cjs ｜ 权限点 system:approval:template（审批模板维护，AA3 / ADR-0037 补充）
 * ============================================================================
 * 【为什么】模板写路由此前只要 `system:approval:manage`（同时是"审批管理员全见"的权限点）。受限范围的管理员可把自己写成
 *   现有模板的审批人，使他组织的待审实例变成"自己的队列"（Z9 审计 P1）。把"维护模板"拆成独立权限点，并在路由上再叠加
 *   全局数据范围要求；该点只授 admin，不随 manage 自动获得。
 * 【ADR-0007 口径】授权只在权限点第一次出现时给 admin；`verify()` 只查字典，不查角色授权集合。
 * 【迁移安全】纯加法：一条权限 upsert。
 * ============================================================================
 */
const { tableExists } = require('./_helpers.cjs')

module.exports.name = '审批模板维护权限点 system:approval:template'

const PERM = ['system:approval:template', '维护审批模板与审批人', 'system', 'write', 4140]

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
