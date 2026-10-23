/**
 * ============================================================================
 * 文件标识：server/routes/auth.js ｜ 认证与组织路由：登录（含行业选择）、行业清单、用户/角色/权限点、组织树、操作审计日志
 * ============================================================================
 * 【职责】认证与组织路由：登录（含行业选择）、行业清单、用户/角色/权限点、组织树、操作审计日志
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自人工补充**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { getDb, getDbFor, INDUSTRIES, DEFAULT_INDUSTRY, normalizeIndustry } from '../db/index.js'
import { ok, fail, bizFail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { signToken, requireAuth, requireRole, ROLES, userPermissions, resolveOrgScope } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { createAccount, updateAccount, changePassword, logoutAll, replaceRolePermissions } from '../lib/account-security.js'
import { consumeLoginAttempt } from '../lib/login-throttle.js'

const r = Router()
// Public dummy verifier, never attached to an account; avoids the no-user fast path.
const DUMMY_PASSWORD_HASH = '$2a$12$Xue8lAEQUVLpH1eO2tZGU.4I/1wDNa4HP3PDE.pPntUqsau1FikYq'
const loginFailed = res => bizFail(res, { status: 401, code: 'AUTH_INVALID_CREDENTIALS', message: '账号或密码无效' })

r.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password, industry } = req.body || {}
    if (typeof username !== 'string' || !username.trim() || username.length > 64 || /[\u0000-\u001f\u007f]/u.test(username) ||
        typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 1024) return fail(res, '账号与密码格式无效', 400, 'AUTH_INPUT_INVALID')
    // 行业码的判定**只有一处实现**（db/index.js 的 normalizeIndustry）：
    // 缺失 ⇒ 默认行业；给了非法码 ⇒ 抛（400 + INDUSTRY_CODE_INVALID，登录时选错行业就当场告诉他）。
    // 原来这里自己又抄了一遍 `INDUSTRIES[industry] ? industry : DEFAULT_INDUSTRY`
    // —— 同一个判据两份实现，以后只会改一处。
    const code = normalizeIndustry(industry)
    const normalizedUsername = username.trim()
    let attempt
    try { attempt = consumeLoginAttempt({ industry: code, username: normalizedUsername, ip: req.ip }) } catch (e) {
      if (e.code === 'LOGIN_RATE_LIMITED') res.set('Retry-After', String(e.retryAfter))
      if (failFromError(res, e)) return
      throw e
    }
    // 预占（含账号桶 pending）已在上面原子完成；下面任何非成功出口都按失败定案（pending 转实），
    // 抛错也不例外（未定案的预占继续计数，fail closed）。成功才清账号桶里已定案的失败。
    let succeeded = false
    try {
      const db = getDbFor(code) // 按所选行业登录对应的库
      const before = db.prepare('SELECT * FROM users WHERE username=?').get(normalizedUsername)
      const matches = await bcrypt.compare(password, before?.password_hash || DUMMY_PASSWORD_HASH)
      const user = before ? db.prepare('SELECT * FROM users WHERE id=?').get(before.id) : null
      if (!matches || !user || user.status !== 'active' || user.password_hash !== before.password_hash || user.auth_version !== before.auth_version) return loginFailed(res)
      db.prepare("UPDATE users SET last_login_at=datetime('now','localtime') WHERE id=?").run(user.id)
      const token = signToken(user, code)
      audit({ user: { uid: user.id, name: user.name }, ip: req.ip }, { action: 'LOGIN', module: 'auth', entity: 'user', entityId: user.id, detail: code })
      succeeded = true
      return ok(res, {
        token,
        industry: code,
        industryName: INDUSTRIES[code].name,
        industryLabel: INDUSTRIES[code].label,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          roleName: ROLES[user.role] || user.role,
          dept: user.dept,
          dealer_id: user.dealer_id,
          store_id: user.store_id,
          industry: code,
          industryName: INDUSTRIES[code].name
        },
        expiresIn: '12h'
      })
    } finally { attempt.settle(succeeded) }
  })
)

// 可选行业列表（登录页用，公开）
// `visible` 一起下发：前端按它决定"展示哪几个行业卡"。
// **不过滤**是故意的 —— 过滤会让"后台还留着服装版"这件事在接口上消失，
// 而客户要的正是"后台留着、页面不显示"。展示由前端决定，可用性由后端决定，两者分开。
r.get('/industries', (_req, res) =>
  ok(res, Object.values(INDUSTRIES).map((x) => ({ code: x.code, name: x.name, label: x.label, visible: x.visible !== false })))
)

r.get(
  '/me',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const u = db
      .prepare('SELECT id, username, name, role, dept, phone, dealer_id, store_id, org_id, data_scope, last_login_at FROM users WHERE id=?')
      .get(req.user.uid)
    if (!u) return fail(res, '用户不存在', 404)
    const org = u.org_id
      ? db.prepare('SELECT id, code, name, short_name, type, level, path, currency, region FROM orgs WHERE id=?').get(u.org_id)
      : null
    const scope = resolveOrgScope(db, { uid: u.id, role: u.role })
    return ok(res, {
      ...u,
      roleName: ROLES[u.role] || u.role,
      org,
      permissions: userPermissions(db, u.id, u.role),
      orgScope: {
        scope: scope.scope,
        orgId: scope.orgId,
        orgCount: scope.orgIds ? scope.orgIds.length : null,
        dealerId: scope.dealerId ?? null
      },
      // ⚠️ 索引前先确认是**字符串**：`INDUSTRIES[value]` 会对非字符串值做 ToPropertyKey 强制转换，
      // 而 `{toString:null}` 这类**令牌载荷**会让这次转换**抛 TypeError** ——
      // 即"在错误路径上又抛一次"（本线刚修的那类形态；实测：对象令牌打到 `/api/auth/me` ⇒ 500）。
      // 令牌里的行业已在 `server/index.js` 的中间件校验过（非法即 400）⇒ 这里是**纵深防御**，
      // 免得将来某条新路径又把它带到这行。
      industry: typeof req.user.industry === 'string' ? req.user.industry : DEFAULT_INDUSTRY,
      industryName:
        (typeof req.user.industry === 'string' && INDUSTRIES[req.user.industry]?.name) ||
        INDUSTRIES[DEFAULT_INDUSTRY].name
    })
  })
)

r.get(
  '/roles',
  requireAuth,
  wrap((_req, res) => ok(res, Object.entries(ROLES).map(([k, v]) => ({ code: k, name: v }))))
)

r.get(
  '/users',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const kw = req.query.keyword ? `%${req.query.keyword}%` : null
    const where = kw ? 'WHERE (u.username LIKE ? OR u.name LIKE ?)' : ''
    const params = kw ? [kw, kw] : []
    const total = db.prepare(`SELECT COUNT(*) c FROM users u ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT u.id,u.username,u.name,u.role,u.dept,u.phone,u.dealer_id,u.store_id,u.status,u.last_login_at,u.created_at,
                d.name AS dealer_name, s.name AS store_name
         FROM users u LEFT JOIN dealers d ON d.id=u.dealer_id LEFT JOIN stores s ON s.id=u.store_id
         ${where}
         ORDER BY u.id LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.post(
  '/users',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => ok(res, await createAccount(getDb(), req.user, req.body, { ip: req.ip })))
)

r.put(
  '/users/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => ok(res, await updateAccount(getDb(), req.user, Number(req.params.id), req.body, { ip: req.ip })))
)

r.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => ok(res, await changePassword(getDb(), req.user, req.body?.oldPassword, req.body?.newPassword, { ip: req.ip })))
)

r.post(
  '/logout-all',
  requireAuth,
  wrap((req, res) => ok(res, logoutAll(getDb(), req.user, { ip: req.ip })))
)

r.get(
  '/audit-logs',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const total = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

// ============================================================
// 模块 05：组织与权限
// ============================================================

/** 组织树（按当前用户的数据范围裁剪，并保留祖先让树连贯） */
r.get(
  '/org-tree',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const scope = resolveOrgScope(db, req.user)
    const rows = db
      .prepare(
        "SELECT id,code,name,short_name,type,parent_id,level,path,is_legal,owner_org_id,currency,region,tax_region,brand_id FROM orgs WHERE id<>0 AND status='active' ORDER BY path"
      )
      .all()

    let allowIds = null
    if (scope.scope !== 'all') {
      allowIds = new Set(scope.orgIds || [])
      if (scope.scope === 'dealer' && scope.dealerId) {
        const d = db.prepare('SELECT org_id FROM dealers WHERE id=?').get(scope.dealerId)
        if (d?.org_id) allowIds.add(d.org_id)
      }
      // 补齐祖先节点，否则前端拼不出完整层级
      for (const o of rows) {
        if (!allowIds.has(o.id)) continue
        for (const seg of String(o.path || '').split('/').filter(Boolean)) allowIds.add(Number(seg))
      }
    }

    const kept = allowIds ? rows.filter((o) => allowIds.has(o.id)) : rows
    const byId = new Map(kept.map((o) => [o.id, { ...o, is_legal: !!o.is_legal, children: [] }]))
    const tree = []
    for (const o of byId.values()) {
      if (o.parent_id != null && byId.has(o.parent_id)) byId.get(o.parent_id).children.push(o)
      else tree.push(o)
    }
    return ok(res, {
      tree,
      total: kept.length,
      scope: { scope: scope.scope, orgId: scope.orgId, orgCount: scope.orgIds ? scope.orgIds.length : null }
    })
  })
)

/** 权限点字典 */
r.get(
  '/permissions',
  requireAuth,
  wrap((_req, res) => {
    const rows = getDb().prepare('SELECT code,name,module,category FROM permissions ORDER BY sort_order').all()
    const byModule = {}
    for (const p of rows) (byModule[p.module] ||= []).push(p)
    return ok(res, { list: rows, byModule })
  })
)

/** 当前用户的有效权限（前端据此渲染菜单与按钮） */
r.get(
  '/my-permissions',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const perms = userPermissions(db, req.user.uid, req.user.role)
    return ok(res, { permissions: perms, orgScope: resolveOrgScope(db, req.user) })
  })
)

/** 角色及其权限（管理员） */
r.get(
  '/roles-permissions',
  requireAuth,
  requireRole('admin'),
  wrap((_req, res) => {
    const db = getDb()
    const roles = db.prepare('SELECT * FROM roles ORDER BY sort_order').all()
    const map = {}
    for (const rp of db.prepare('SELECT role_code, perm_code FROM role_permissions').all()) {
      ;(map[rp.role_code] ||= []).push(rp.perm_code)
    }
    return ok(res, roles.map((r) => ({ ...r, permissions: map[r.code] || [] })))
  })
)

/** 编辑角色权限（管理员） */
r.put(
  '/roles/:code/permissions',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => ok(res, replaceRolePermissions(getDb(), req.user, req.params.code, req.body?.permissions, { ip: req.ip })))
)

/**
 * 组织档案（平铺全表）。
 * ADR-0028：admin / 全局范围账号拿全量；其余账号只拿 `resolveOrgScope` 圈定的组织（经销商加上自己的挂靠组织），
 * 空范围 ⇒ 空列表（空范围不许变成全库）。与 `/org-tree` 不同：这里不补祖先节点——平铺档案不需要拼层级，
 * 补祖先等于把范围外的上级组织档案（负责人 / 路径）也交出去。
 */
r.get(
  '/orgs',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { type, keyword } = req.query
    const scope = resolveOrgScope(db, req.user)
    let sql = 'SELECT * FROM orgs WHERE id<>0'
    const params = []
    if (scope.scope !== 'all') {
      const ids = new Set((scope.orgIds || []).map(Number).filter(Number.isFinite))
      if (scope.scope === 'dealer' && scope.dealerId) {
        const d = db.prepare('SELECT org_id FROM dealers WHERE id=?').get(scope.dealerId)
        if (d?.org_id) ids.add(Number(d.org_id))
      }
      if (!ids.size) return ok(res, [])
      sql += ` AND id IN (${[...ids].map(() => '?').join(',')})`
      params.push(...ids)
    }
    if (type) { sql += ' AND type=?'; params.push(type) }
    if (keyword) { sql += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    sql += ' ORDER BY path'
    return ok(res, db.prepare(sql).all(...params))
  })
)

export default r
