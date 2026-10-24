/**
 * ============================================================================
 * 文件标识：server/lib/role-matrix.js ｜ 角色 x 单据类型可见度矩阵（AD11；AD2 的生成脚本可复用）
 * ============================================================================
 * 【职责】从既有判据来源推演"某个角色在某个单据类型上大致能看到什么"，不另立判据：
 *   · 权限点：`role_permissions`（库）x `DOC_VIEW_PERMS`（server/mcp/doc-perms.js，单据类型 -> 查看权限点）；
 *   · 绑定 / 全局类：`DOC_SCOPE_RESOLVERS`（server/lib/docflow.js）的 `binding` 与 `builder: 'global'`；
 *   · 总部豁免：`hq-roles.js`（HQ_ROLES 对门店 / 经销商绑定类单据按数据范围放行）；
 *   · 外部主体（role=store|dealer）看不到内部域：`HQ_ONLY_MODULES`（INTERNAL_MODULES + oms / dealer）。
 * 可见度取值（`ACCESS`）：
 *   full         管理员 / 超管：不受权限点、绑定与数据范围限制；
 *   scoped       有查看权限点；可见行由账号的数据范围（组织 / 门店归属）决定；
 *   bound        有查看权限点，但须账号绑定了门店 / 经销商（订货主体）才看得到，且只看自己绑定的那部分；
 *   global_only  有查看权限点，但该类单据没有组织归属，只有全局数据范围（admin / data_scope=all）可见；
 *   none         没有查看权限点，或外部主体访问仅限总部的类型。
 * 【边界】矩阵按"单一角色"推演；账号被授予多个角色（user_roles）时取权限点并集，页面上不展开。
 *   它是说明性视图，不是授权判据——真正的判据在各路由的 requirePerm / docScopeOf，与本文件无关。
 * 【不返回】权限点码、用户 / 组织 / 门店 / 经销商名称——调用者只拿到角色名、单据类型名与五档可见度，
 *   以及自己的角色 / 数据范围 / 是否绑定门店或经销商。
 * ============================================================================
 */
import { permContext, resolveOrgScope } from '../middleware/auth.js'
import { DOC_VIEW_PERMS, HQ_ONLY_MODULES } from '../mcp/doc-perms.js'
import { DOC_SCOPE_RESOLVERS } from './docflow.js'
import { isHqRole } from './hq-roles.js'

export const ACCESS = Object.freeze(['full', 'scoped', 'bound', 'global_only', 'none'])

const isExternalRole = (role) => role === 'store' || role === 'dealer'

/** 单元格：某角色（及其权限点集合）在某单据类型上的可见度 */
export function accessOf(role, rolePerms, docType) {
  if (role === 'admin') return 'full'
  const need = DOC_VIEW_PERMS[docType.code]?.perms || []
  if (!(rolePerms.has('*') || need.some((p) => rolePerms.has(p)))) return 'none'
  const external = isExternalRole(role)
  const spec = DOC_SCOPE_RESOLVERS[docType.code]
  if (external && HQ_ONLY_MODULES.has(docType.module)) return 'none'
  if (external && spec?.binding === 'hq') return 'none'
  if (spec?.builder === 'global') return 'global_only'
  if (spec?.binding === 'store' || spec?.binding === 'dealer') return isHqRole(role) ? 'scoped' : 'bound'
  if (spec?.binding === 'subject') return external ? 'bound' : 'scoped'
  return 'scoped'
}

/** 整张矩阵：roles x doc_types。只含已登记查看权限点且在 doc_types 中存在的类型。 */
export function buildRoleMatrix(db) {
  const roles = db.prepare("SELECT code, name FROM roles WHERE status='active' ORDER BY sort_order, code").all()
  const docTypes = db
    .prepare("SELECT code, name, module FROM doc_types WHERE status='active' ORDER BY sort_order, code")
    .all()
    .filter((t) => Object.prototype.hasOwnProperty.call(DOC_VIEW_PERMS, t.code))
  const permsByRole = new Map()
  for (const { role_code, perm_code } of db.prepare('SELECT role_code, perm_code FROM role_permissions').all()) {
    if (!permsByRole.has(role_code)) permsByRole.set(role_code, new Set())
    permsByRole.get(role_code).add(perm_code)
  }
  const cells = {}
  for (const r of roles) {
    const perms = permsByRole.get(r.code) || new Set()
    cells[r.code] = Object.fromEntries(docTypes.map((t) => [t.code, accessOf(r.code, perms, t)]))
  }
  return {
    roles: roles.map((r) => ({ code: r.code, name: r.name })),
    doc_types: docTypes.map((t) => {
      const spec = DOC_SCOPE_RESOLVERS[t.code]
      return { code: t.code, name: t.name, module: t.module, binding: spec?.binding || null, global_only: spec?.builder === 'global' }
    }),
    cells
  }
}

/** 调用者自己的范围摘要（布尔绑定，不带门店 / 经销商名；名称走 /auth/my-scope） */
export function describeCaller(db, user) {
  const row = db.prepare('SELECT role, store_id, dealer_id FROM users WHERE id=?').get(user.uid)
  const role = row?.role || user.role
  const eff = resolveOrgScope(db, user)
  const name = db.prepare('SELECT name FROM roles WHERE code=?').get(role)?.name || role
  return {
    role,
    role_name: name,
    is_admin: permContext(db, user).isSuper,
    data_scope_effective: eff.scope,
    store_bound: row?.store_id != null && row.store_id !== '',
    dealer_bound: (eff.dealerId ?? row?.dealer_id ?? null) != null
  }
}

export function roleMatrixFor(db, user) {
  return { ...buildRoleMatrix(db), me: describeCaller(db, user) }
}
