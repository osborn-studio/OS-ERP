// =====================================================================
// GML 组织与权限 · 行级数据规则 引擎骨架（Node + better-sqlite3，ESM）
//
// 【来源与改造说明 - 必读】
// 抄 casbin（Apache-2.0，_ref/node-casbin）的三处设计：
//   1) 五元组 `sub, dom, obj, act, eft`：dom 直接映射组织/仓库，
//      这正是 GML 多行业多库 + 多组织隔离的正解
//      （_ref/node-casbin/examples/rbac_with_domains_model.conf）。
//   2) 显式拒绝：`eft = deny` 且**优先于** allow
//      （casbin 的 p2 + policy_effect 中 deny 覆盖）。
//   3) 角色继承：g 行带层级（rbac_roles.parent_id）。
//
// 【为什么不直接引入 casbin —— 三个理由】
//   ① casbin 的行级规则靠 `eval(p.sub_rule)` 求值（见其 test/enforcer.test.ts:595），
//      把表达式存在策略表里再 eval，**一旦策略表被注入就是 RCE**。
//      GML 改为「受限表达式解析 + 编译成 SQL WHERE 片段」，无 eval、无 new Function。
//   ② 列表页不能逐行 enforce（会在千行列表上炸掉）。GML 直接把规则**反向编译
//      成 SQL WHERE**，一次查询搞定，也天然支持分页。
//   ③ casbin 的 SyncedEnforcer 锁是进程内的，多进程下失效；GML 用 SQLite 事务。
//   → 结论：**抄设计、不引依赖**。若后续确需更完整的 RBAC（如 ABAC 复杂表达式、
//     REST 路径通配），可再评估引入 casbin（Apache-2.0，已过安全审计），
//     但届时需单独走一次运行时依赖审批。
//
// 【安全红线】
//   - 本文件**禁止**出现 eval / new Function / vm.runInNewContext。
//   - 策略条件只允许白名单 operator，值一律走参数化绑定，杜绝 SQL 注入。
// =====================================================================

const ALLOWED_OPS = new Set(['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'])

// 哨兵：编译时返回，调用方按常量判断，不要写字符串字面量
export const ROW_NONE = '1 = 0'   // 无任何可见行
export const ROW_ALL = '1 = 1'    // 不限行

// 占位符：把策略值里的 :user_id / :org_id 换成运行时上下文
function resolveValue (raw, ctx) {
  const v = String(raw ?? '').trim()
  if (v === ':user_id') return ctx.userId
  if (v === ':org_id') return ctx.orgId
  if (v === ':dept_id') return ctx.deptId
  return v
}

// ---------------------------------------------------------------------
// 一、功能权限判定：查命中的策略，deny 优先
// ctx = { userId, orgId, deptId, dom, resource, action }
// ---------------------------------------------------------------------
export function checkAccess (db, ctx) {
  const roles = db.prepare('SELECT role_code, dom FROM rbac_user_roles WHERE user_id = ?').all(ctx.userId)
  const roleCodes = roles.map((r) => r.role_code)
  if (!roleCodes.length) return deny(db, ctx, 'no-role')

  // 角色继承展开（casbin 的 g 层级）：向上找 parent
  const expanded = new Set(roleCodes)
  const queue = [...roleCodes]
  while (queue.length) {
    const code = queue.shift()
    const row = db.prepare('SELECT parent_id FROM rbac_roles WHERE code = ?').get(code)
    if (row?.parent_id) {
      const p = db.prepare('SELECT code FROM rbac_roles WHERE id = ?').get(row.parent_id)
      if (p && !expanded.has(p.code)) { expanded.add(p.code); queue.push(p.code) }
    }
  }

  const doms = new Set(['*', ctx.dom].filter(Boolean))
  const placeholders = [...expanded].map(() => '?').join(',')
  const domPh = [...doms].map(() => '?').join(',')

  const rows = db.prepare(`
    SELECT * FROM rbac_policies
     WHERE enabled = 1
       AND role_code IN (${placeholders})
       AND dom IN (${domPh})
       AND (resource = ? OR resource = '*')
       AND (action = ? OR action = '*')
     ORDER BY priority ASC, id ASC
  `).all(...expanded, ...doms, ctx.resource, ctx.action)

  if (!rows.length) return deny(db, ctx, 'no-match')

  // deny 优先（抄 casbin 的 policy_effect）
  const denied = rows.find((r) => r.eft === 'deny')
  if (denied) return deny(db, ctx, `deny:${describe(denied)}`)
  return allow(db, ctx, `allow:${describe(rows[0])}`, rows[0])
}

function describe (p) {
  return `${p.role_code}/${p.dom}/${p.resource}/${p.action}/${p.eft}`
}
function allow (db, ctx, reason, policy) {
  audit(db, ctx, 1, reason)
  return { allowed: true, reason, policy }
}
function deny (db, ctx, reason) {
  audit(db, ctx, 0, reason)
  return { allowed: false, reason }
}
function audit (db, ctx, allowed, hit) {
  db.prepare('INSERT INTO rbac_audit (user_id, resource, action, dom, allowed, hit_policy) VALUES (?,?,?,?,?,?)')
    .run(ctx.userId ?? null, ctx.resource, ctx.action, ctx.dom ?? null, allowed, hit)
}

// ---------------------------------------------------------------------
// 二、行级数据规则：把策略**反向编译成 SQL WHERE 片段**
// 这是列表页性能的正解 —— 绝不逐行 enforce。
// 返回 { sql, params, rules } ；sql 形如 "(warehouse_id IN (?,?)) AND (org_id = ?)"
// ---------------------------------------------------------------------
export function compileRowFilter (db, ctx) {
  const roles = db.prepare('SELECT role_code FROM rbac_user_roles WHERE user_id = ?').all(ctx.userId)
  const roleCodes = roles.map((r) => r.role_code)
  if (!roleCodes.length) return { sql: ROW_NONE, params: [], rules: [] }  // 无角色 = 看不见任何行

  const doms = new Set(['*', ctx.dom].filter(Boolean))
  const ph = roleCodes.map(() => '?').join(',')
  const domPh = [...doms].map(() => '?').join(',')

  const policies = db.prepare(`
    SELECT * FROM rbac_policies
     WHERE enabled = 1 AND eft = 'allow'
       AND role_code IN (${ph}) AND dom IN (${domPh})
       AND (resource = ? OR resource = '*')
       AND (action = ? OR action = '*')
  `).all(...roleCodes, ...doms, ctx.resource, ctx.action ?? 'read')

  const ids = policies.map((p) => p.id)
  if (!ids.length) return { sql: ROW_NONE, params: [], rules: [] }

  const rules = db.prepare(
    `SELECT * FROM rbac_row_rules WHERE policy_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids)

  // 同一策略内多条规则 AND，策略之间 OR（任一授权策略命中即可见）
  const byPolicy = new Map()
  for (const r of rules) {
    if (!ALLOWED_OPS.has(r.operator)) continue   // 白名单：非法 operator 直接忽略
    if (!byPolicy.has(r.policy_id)) byPolicy.set(r.policy_id, [])
    byPolicy.get(r.policy_id).push(r)
  }

  const orParts = []
  const params = []
  for (const [pid, rs] of byPolicy) {
    const andParts = []
    for (const r of rs) {
      const compiled = compileOne(r, ctx)
      if (!compiled) continue
      andParts.push(compiled.sql)
      params.push(...compiled.params)
    }
    if (andParts.length) orParts.push(`(${andParts.join(' AND ')})`)
  }

  if (!orParts.length) return { sql: ROW_ALL, params: [], rules }  // 有授权但无行级限制 = 全可见
  return { sql: `(${orParts.join(' OR ')})`, params, rules }
}

// 单条规则 → SQL 片段（字段与操作符均来自白名单，值一律参数化绑定）
function compileOne (rule, ctx) {
  const field = String(rule.field ?? '')
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(field)) return null   // 字段白名单，防注入
  const value = resolveValue(rule.value, ctx)
  if (value === undefined || value === null || value === '') return null

  switch (rule.operator) {
    case 'eq': return { sql: `${field} = ?`, params: [value] }
    case 'ne': return { sql: `${field} <> ?`, params: [value] }
    case 'gt': return { sql: `${field} > ?`, params: [Number(value)] }
    case 'gte': return { sql: `${field} >= ?`, params: [Number(value)] }
    case 'lt': return { sql: `${field} < ?`, params: [Number(value)] }
    case 'lte': return { sql: `${field} <= ?`, params: [Number(value)] }
    case 'in': {
      const list = String(value).split(',').map((s) => s.trim()).filter(Boolean)
      if (!list.length) return null
      return { sql: `${field} IN (${list.map(() => '?').join(',')})`, params: list }
    }
    case 'not_in': {
      const list = String(value).split(',').map((s) => s.trim()).filter(Boolean)
      if (!list.length) return null
      return { sql: `${field} NOT IN (${list.map(() => '?').join(',')})`, params: list }
    }
    default: return null
  }
}

// ---------------------------------------------------------------------
// 三、Express 中间件：功能权限 + 行级过滤一次装配
// 用法：app.use('/api/sales/orders', rbacGuard('sales_order', 'read', 't'))
// ---------------------------------------------------------------------
export function rbacGuard (resource, action, alias = 't') {
  return (req, res, next) => {
    const db = req.db
    const ctx = {
      userId: req.user?.id,
      orgId: req.user?.org_id,
      deptId: req.user?.dept_id,
      dom: req.headers['x-org'] ?? req.user?.org_code ?? '*',
      resource,
      action
    }
    const access = checkAccess(db, ctx)
    if (!access.allowed) {
      return res.status(403).json({ code: 403, success: false, message: `无权限：${access.reason}` })
    }
    // 三个哨兵要分别处理，否则 '1 = 0' 会被下面的别名替换误伤成 't.1 = 0'
    const filter = compileRowFilter(db, ctx)
    if (filter.sql === ROW_NONE) {
      req.rowFilter = { sql: ' AND 1 = 0', params: [], empty: true }   // 无任何可见行
    } else if (filter.sql === ROW_ALL) {
      req.rowFilter = { sql: '', params: [], empty: false }            // 不限行
    } else {
      const aliased = filter.sql.replace(/\b([a-z_][a-z0-9_]*)\s*(?=[=<>])/gi, `${alias}.$1`)
      req.rowFilter = { sql: ` AND ${aliased}`, params: filter.params, empty: false }
    }
    next()
  }
}

// ---------------------------------------------------------------------
// 四、策略管理（供权限配置页调用）
// ---------------------------------------------------------------------
export function grantPolicy (db, { roleCode, dom = '*', resource, action, eft = 'allow', priority = 100, rowRules = [] }) {
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO rbac_policies (role_code, dom, resource, action, eft, priority)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roleCode, dom, resource, action, eft, priority)
    const pid = info.lastInsertRowid
    const ins = db.prepare('INSERT INTO rbac_row_rules (policy_id, field, operator, value) VALUES (?,?,?,?)')
    for (const r of rowRules) {
      if (!ALLOWED_OPS.has(r.operator)) throw new Error(`不支持的操作符：${r.operator}`)
      ins.run(pid, r.field, r.operator, String(r.value))
    }
    return pid
  })
  return tx.immediate ? tx.immediate() : tx()
}

export function assignRole (db, { userId, roleCode, dom = '*' }) {
  return db.prepare(
    'INSERT OR IGNORE INTO rbac_user_roles (user_id, role_code, dom) VALUES (?,?,?)'
  ).run(userId, roleCode, dom).changes
}
