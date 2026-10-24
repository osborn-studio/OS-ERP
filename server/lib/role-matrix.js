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
 * 【边界】矩阵按"单一角色"推演；账号被授予多个角色（user_roles）时取权限点并集——AE2 起管理员拿到按角色组合聚合的"并集示例"，
 *   非管理员持有多角色时拿自己那几个角色的并集（`my_union`）。库内所有 active 角色（内置 + 自定义）都在矩阵里，`builtin` 区分；
 *   `users.data_scope` 覆盖只以**计数**出现（管理员出口），不含账号标识。生成脚本（scripts/gen-role-matrix.mjs）调用同一个 buildRoleMatrix。
 *   它是说明性视图，不是授权判据——真正的判据在各路由的 requirePerm / docScopeOf，与本文件无关。
 * 【不返回】权限点码、用户 / 组织 / 门店 / 经销商名称——调用者只拿到角色名、单据类型名与五档可见度，
 *   以及自己的角色 / 数据范围 / 是否绑定门店或经销商；非管理员只拿自己角色那一列（见 roleMatrixFor）。
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

/** 并集可见度的排序：同一单据类型上各角色的结果取"最宽"的一档（权限点判据本身是任一命中） */
const ACCESS_RANK = { full: 5, scoped: 4, global_only: 3, bound: 2, none: 1 }
const SCOPE_KEYS = ['all', 'subtree', 'org', 'self', 'dealer']
const COMBO_LIMIT = 10

/** 把若干角色在各单据类型上的单列合并成一列（并集示例）。外部主体闸按各角色分别算后取最宽，账号真实口径以主角色为准——故只是示例。 */
export function unionCells(cells, roleCodes, docTypes) {
  const out = {}
  for (const t of docTypes) {
    let best = 'none'
    for (const c of roleCodes) {
      const a = cells[c]?.[t.code] || 'none'
      if (ACCESS_RANK[a] > ACCESS_RANK[best]) best = a
    }
    out[t.code] = best
  }
  return out
}

/** 账号的角色集合：user_roles 并上 users.role（与 permContext 同一口径），去重排序 */
function roleSetsOfActiveUsers(db) {
  const sets = new Map() // user_id -> { role, set, scope }
  for (const u of db.prepare("SELECT id, role, data_scope, is_super FROM users WHERE status='active'").all()) {
    sets.set(u.id, { role: u.role, scope: u.data_scope || '', superUser: !!u.is_super, set: new Set(u.role ? [u.role] : []) })
  }
  for (const { user_id, role_code } of db.prepare('SELECT user_id, role_code FROM user_roles').all()) sets.get(user_id)?.set.add(role_code)
  return sets
}

/**
 * 整张矩阵：所有 active 角色（内置 + 自定义，`builtin` 区分）x doc_types。只含已登记查看权限点且在 doc_types 中存在的类型。
 * `{ aggregates: true }`（仅管理员出口使用）另给两项**只含计数**的分布，不含任何账号标识：
 *   scope_overrides  每个角色的主角色账号数、有 `users.data_scope` 覆盖的账号数及各取值计数（非法取值并入 other，原值不外露）；
 *   multi_role       持有多个角色的账号数，以及按角色组合聚合的 { roles, accounts, cells(并集示例) }（前 10 组）。
 * 停用账号不计；admin / 超管账号不计（恒全开，无信息量）。
 */
export function buildRoleMatrix(db, { aggregates = false } = {}) {
  const roles = db.prepare("SELECT code, name, is_builtin, data_scope FROM roles WHERE status='active' ORDER BY sort_order, code").all()
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
  const matrix = {
    roles: roles.map((r) => ({ code: r.code, name: r.name, builtin: r.is_builtin === 1 })),
    doc_types: docTypes.map((t) => {
      const spec = DOC_SCOPE_RESOLVERS[t.code]
      return { code: t.code, name: t.name, module: t.module, binding: spec?.binding || null, global_only: spec?.builder === 'global' }
    }),
    cells
  }
  if (!aggregates) return matrix

  const users = [...roleSetsOfActiveUsers(db).values()].filter((u) => !u.superUser && u.role !== 'admin')
  const scope_overrides = {}
  for (const r of roles) scope_overrides[r.code] = { default_scope: r.data_scope, total: 0, overridden: 0, by_scope: { ...Object.fromEntries(SCOPE_KEYS.map((k) => [k, 0])), other: 0 } }
  const combos = new Map()
  let multiAccounts = 0
  const known = new Set(roles.map((r) => r.code))
  for (const u of users) {
    const row = scope_overrides[u.role]
    if (row) {
      row.total++
      if (u.scope !== '') {
        row.overridden++
        row.by_scope[SCOPE_KEYS.includes(u.scope) ? u.scope : 'other']++
      }
    }
    const codes = [...u.set].filter((c) => known.has(c)).sort()
    if (codes.length > 1) {
      multiAccounts++
      const key = codes.join('\u0000')
      combos.set(key, { roles: codes, accounts: (combos.get(key)?.accounts || 0) + 1 })
    }
  }
  const ordered = [...combos.values()]
    .sort((a, b) => b.accounts - a.accounts || a.roles.join(',').localeCompare(b.roles.join(',')))
    .slice(0, COMBO_LIMIT)
    .map((c) => ({ ...c, cells: unionCells(cells, c.roles, matrix.doc_types) }))
  return { ...matrix, scope_overrides, multi_role: { label: '并集示例', accounts: multiAccounts, combos: ordered } }
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

/** 调用者自己持有的角色（user_roles 并上 users.role），只含 active 且在矩阵里的角色 */
function ownRoleCodes(db, user, known) {
  const row = db.prepare('SELECT role FROM users WHERE id=?').get(user.uid)
  const set = new Set([row?.role || user.role])
  for (const r of db.prepare('SELECT role_code FROM user_roles WHERE user_id=?').all(user.uid)) set.add(r.role_code)
  return [...set].filter((c) => known.has(c)).sort()
}

/**
 * 接口出口：管理员 / 超管拿全表（含自定义角色、数据范围覆盖分布、多角色并集示例；与 admin-only 的 /auth/roles-permissions 同级的信息）；
 * 其余账号只拿**自己角色**那一列——其它角色的可见度反推得出它们的权限点分配（Codex 审计 P2），不能交给任意登录者。
 * 非管理员若持有多个角色，另得 `my_union`：**自己这几个角色**的并集一列（只是自己权限的合并，不暴露其它角色）；其余情形为 null。
 * `restricted` 告诉页面当前是自视图。
 */
export function roleMatrixFor(db, user) {
  const me = describeCaller(db, user)
  if (me.is_admin) return { ...buildRoleMatrix(db, { aggregates: true }), my_union: null, restricted: false, me }
  const full = buildRoleMatrix(db)
  const own = ownRoleCodes(db, user, new Set(full.roles.map((r) => r.code)))
  const my_union = own.length > 1
    ? { roles: full.roles.filter((r) => own.includes(r.code)).map((r) => ({ code: r.code, name: r.name })), cells: unionCells(full.cells, own, full.doc_types) }
    : null
  return {
    roles: full.roles.filter((r) => r.code === me.role),
    doc_types: full.doc_types,
    cells: full.cells[me.role] ? { [me.role]: full.cells[me.role] } : {},
    my_union,
    restricted: true,
    me
  }
}
