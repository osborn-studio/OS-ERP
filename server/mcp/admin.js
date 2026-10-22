/**
 * ============================================================================
 * 文件标识：server/mcp/admin.js ｜ Agent Token 管理（管理员）：签发 / 列表 / 吊销 / 调用审计
 * ============================================================================
 * 【职责】Agent Token 管理（管理员）：签发 / 列表 / 吊销 / 调用审计
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// Agent Token 管理（管理员）：签发 / 列表 / 吊销 / 调用审计
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap } from '../lib/http.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { createToken, revokeToken, SCOPE_LABEL } from './tokens.js'
import { TOOLS } from './tools.js'
// 「AI 能力目录」的唯一口径（单据矩阵 + 工具清单 + 安全边界都由它算，页面不自己编）
import { buildMcpCatalog } from './catalog.js'

const r = Router()

/** 工具清单（供界面勾选白名单/黑名单） */
r.get(
  '/tools',
  requireAuth,
  wrap((_req, res) =>
    ok(
      res,
      TOOLS.map((t) => ({ name: t.name, title: t.title, level: t.level, description: t.description }))
    )
  )
)

/**
 * AI 能力目录：**这个系统到底有哪些单据、AI 能读到什么、能推进到哪一步、哪些必须人工确认**。
 *
 * 数据全部由内核三张表（`doc_types` / `doc_states` / `doc_actions`）+ 工具注册表推导，
 * 页面不维护第二份名单 —— 手写的"我们支持 N 种单据"第二天就会开始撒谎，而且不报错。
 *
 * 权限用 `system.mcp.manage`（与"管理 Agent Token"同一个权限点）：
 * 这个页面能看到全部单据结构与权限点，属于**配置级信息**，不是普通业务查询。
 */
r.get(
  '/catalog',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => ok(res, buildMcpCatalog(getDb())))
)

r.get(
  '/scopes',
  requireAuth,
  wrap((_req, res) => ok(res, Object.entries(SCOPE_LABEL).map(([k, v]) => ({ code: k, name: v }))))
)

r.get(
  '/tokens',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => {
    const db = getDb()
    const rows = db
      .prepare(`
        SELECT t.id, t.name, t.token_prefix, t.org_id, o.name AS org_name, t.industry, t.scopes,
               t.allow_tools, t.deny_tools, t.rate_limit, t.expires_at, t.last_used_at, t.call_count,
               t.status, t.remark, t.created_at
        FROM agent_tokens t LEFT JOIN orgs o ON o.id=t.org_id
        ORDER BY t.id DESC`)
      .all()
    return ok(res, rows)
  })
)

r.post(
  '/tokens',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => {
    const db = getDb()
    const { name, org_id, scopes, allow_tools, deny_tools, rate_limit, expires_at, remark } = req.body || {}
    if (!name) return fail(res, '请填写 Token 名称')
    const created = createToken(db, {
      name,
      orgId: org_id ?? req.user.org_id ?? null,
      ownerUserId: req.user.uid,
      industry: req.user.industry,
      scopes: scopes || 'read',
      allowTools: allow_tools,
      denyTools: deny_tools,
      rateLimit: rate_limit || 600,
      expiresAt: expires_at || null,
      remark
    })
    // 明文 Token 仅此一次返回，之后只存哈希
    return ok(res, { ...created, warning: '该 Token 明文仅显示这一次，请立即保存' })
  })
)

r.delete(
  '/tokens/:id',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => {
    const db = getDb()
    const t = db.prepare('SELECT * FROM agent_tokens WHERE id=?').get(Number(req.params.id))
    if (!t) return fail(res, 'Token 不存在', 404)
    revokeToken(db, t.id, `由 ${req.user.name || req.user.username} 吊销`)
    return ok(res, { id: t.id, status: 'revoked' })
  })
)

/** 调用审计 */
r.get(
  '/logs',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => {
    const db = getDb()
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const where = []
    const params = []
    if (req.query.token_id) { where.push('token_id=?'); params.push(Number(req.query.token_id)) }
    if (req.query.level) { where.push('level=?'); params.push(req.query.level) }
    if (req.query.ok === '0') where.push('ok=0')
    const sql = `SELECT * FROM mcp_call_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
    return ok(res, db.prepare(sql).all(...params, limit))
  })
)

/** 人工确认列表：管理界面统一走 /api/mcp，MCP Agent 端点仍由 /mcp 暴露。 */
r.get('/confirmations', requireAuth, requirePerm('system.mcp.confirm'), wrap((_req, res) => {
  const rows = getDb().prepare(`
    SELECT c.*, t.name AS token_name FROM mcp_confirmations c
    LEFT JOIN agent_tokens t ON t.id=c.token_id
    ORDER BY c.id DESC LIMIT 100`).all()
  return ok(res, rows)
}))

r.post('/confirmations/:token/approve', requireAuth, requirePerm('system.mcp.confirm'), wrap((req, res) => {
  const db = getDb()
  const c = db.prepare('SELECT * FROM mcp_confirmations WHERE confirm_token=?').get(req.params.token)
  if (!c) return fail(res, '确认单不存在', 404)
  const owner = c.token_id ? db.prepare('SELECT owner_user_id FROM agent_tokens WHERE id=?').get(c.token_id) : null
  if (owner?.owner_user_id != null && Number(owner.owner_user_id) === Number(req.user.uid)) {
    return fail(res, '不能批准本人名下 Agent Token 发起的确认单，请由他人确认', 403)
  }
  if (c.status !== 'pending') return fail(res, `确认单状态为 ${c.status}`, 400)
  const upd = db.prepare(`UPDATE mcp_confirmations
    SET status='confirmed',confirmed_by=?,confirmed_by_id=?,confirmed_at=datetime('now','localtime')
    WHERE id=? AND status='pending'`)
    .run(req.user.name || req.user.username || `uid:${req.user.uid}`, req.user.uid ?? null, c.id)
  if (upd.changes !== 1) return fail(res, '确认单状态已被其他操作改变，请刷新后重试', 409)
  return ok(res, { confirm_token: c.confirm_token, status: 'confirmed', confirmed_by_id: req.user.uid ?? null })
}))

r.post('/confirmations/:token/reject', requireAuth, requirePerm('system.mcp.confirm'), wrap((req, res) => {
  const db = getDb()
  const c = db.prepare('SELECT * FROM mcp_confirmations WHERE confirm_token=?').get(req.params.token)
  if (!c) return fail(res, '确认单不存在', 404)
  if (c.status !== 'pending') return fail(res, `确认单状态为 ${c.status}`, 400)
  const upd = db.prepare(`UPDATE mcp_confirmations
    SET status='rejected',confirmed_by=?,confirmed_at=datetime('now','localtime')
    WHERE id=? AND status='pending'`)
    .run(req.user.name || req.user.username || `uid:${req.user.uid}`, c.id)
  if (upd.changes !== 1) return fail(res, '确认单状态已被其他操作改变，请刷新后重试', 409)
  return ok(res, { confirm_token: c.confirm_token, status: 'rejected' })
}))

/** 调用统计 */
r.get(
  '/stats',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => {
    const db = getDb()
    const byLevel = db.prepare('SELECT level, COUNT(*) c, SUM(ok) ok_count FROM mcp_call_logs GROUP BY level').all()
    const topTools = db.prepare('SELECT tool_name, COUNT(*) c FROM mcp_call_logs GROUP BY tool_name ORDER BY c DESC LIMIT 10').all()
    const recent = db.prepare("SELECT COUNT(*) c FROM mcp_call_logs WHERE created_at > datetime('now','localtime','-1 day')").get().c
    const pending = db.prepare("SELECT COUNT(*) c FROM mcp_confirmations WHERE status='pending'").get().c
    return ok(res, { by_level: byLevel, top_tools: topTools, calls_last_24h: recent, pending_confirmations: pending })
  })
)

export default r
