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
import { getDb, getCurrentIndustry } from '../db/index.js'
import { ok, fail, wrap } from '../lib/http.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { createToken, revokeToken, SCOPE_LABEL, listTokensWithStatus, getTokenWithStatus, sweepOwnerRevokedTokens } from './tokens.js'
import { TOOLS } from './tools.js'
// 「AI 能力目录」的唯一口径（单据矩阵 + 工具清单 + 安全边界都由它算，页面不自己编）
import { buildMcpCatalog } from './catalog.js'
import { mcpRatePolicy, dailyQuotaConfigured, recentLimitedByToken, dailyQuotaPage, decodeQuotaCursor, QUOTA_PAGE_DEFAULT, QUOTA_PAGE_MAX } from '../lib/mcp-rate-limit.js'
import { mcpCodeTotal } from '../lib/process-counters.js'

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

/**
 * 限速读数（AE11，只读）：每分钟总额度 / 写额度、日配额（0 = 关闭）、本进程自启动以来被限流（429）的累计次数。
 * 与 `/catalog`、`/tokens` 同权限（system.mcp.manage）：额度数字能帮攻击者掐准节奏，不对普通账号披露。
 * 只含数字，不含令牌 id / 前缀 / 名称；429 计数是进程内计数器（重启归零、多进程各自计数），不是持久统计。
 */
r.get(
  '/limits',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => {
    const p = mcpRatePolicy()
    return ok(res, {
      rpm: p.rpm,
      write_rpm: p.writeRpm,
      window_seconds: Math.round(p.windowMs / 1000),
      daily_quota: dailyQuotaConfigured(getDb()),
      rate_limited_total: mcpCodeTotal('MCP_RATE_LIMITED'),
      counter_scope: 'process'
    })
  })
)

/**
 * 每令牌近期限流（AF11，AG9 改精确，只读，仅 system.mcp.manage）：`db` 模式下 `rate_limited_recent` = 该令牌在「当前 + 上一窗口」里被速率额度
 * 拒绝（429）的次数，来自迁移 075 的 `denied` 行（拒绝时尽力记一行，不参与放行判定；写失败的那一次不会被数到，见 `denied_write_failed` 计数）。`memory` 模式返回空列表。
 * 只含令牌 id / 名称与计数，不含前缀、哈希、明文；与 `/limits` 同权限，因为逐令牌的触顶情况会暴露调用方的活动节奏。
 */
r.get(
  '/limits/tokens',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => {
    const p = mcpRatePolicy()
    const base = { store: p.store, window_seconds: Math.round(p.windowMs / 1000) }
    if (p.store !== 'db') return ok(res, { ...base, truncated: false, tokens: [] })
    const db = getDb()
    const hits = recentLimitedByToken(db, { scope: getCurrentIndustry() ?? '', policy: p })
    const CAP = 500
    // 先按资格筛再限量：触顶的令牌（含已吊销的）一定在内，其余取在用令牌；超出上限时 truncated=true，页面据此提示
    const hitIds = [...hits.keys()]
    const hitRows = hitIds.length ? db.prepare(`SELECT id, name FROM agent_tokens WHERE id IN (${hitIds.map(() => '?').join(',')})`).all(...hitIds) : []
    const active = db.prepare("SELECT id, name FROM agent_tokens WHERE status='active' ORDER BY id LIMIT ?").all(CAP + 1)
    const seen = new Set(hitRows.map((t) => t.id))
    const merged = [...hitRows, ...active.filter((t) => !seen.has(t.id))]
    const truncated = merged.length > CAP
    const tokens = merged
      .slice(0, CAP)
      .map((t) => ({ id: t.id, name: t.name, rate_limited_recent: hits.get(t.id) ?? 0 }))
      .sort((a, b) => b.rate_limited_recent - a.rate_limited_recent || a.id - b.id)
    return ok(res, { ...base, truncated, tokens })
  })
)

/**
 * 每令牌今日日配额用量（AG9，只读，仅 system.mcp.manage）：`daily_quota`（0 = 关闭）与「在用（active）令牌」今日已用 / 剩余。
 * 用量与 `dailyQuotaState` 同口径（本地日历日的 `mcp_call_logs` 行数）；配额关闭时 `tokens` 为空（没有可剩余的额度，不披露调用节奏）。
 * 只含令牌 id / 名称与数字，不含前缀、哈希、明文；在用 = active 且未过期。
 * 游标分页（AH9）：`limit`（1..500，默认 100，超过 500 取 500；非整数 / <1 ⇒ 400）+ `cursor`（上一页返回的 `next_cursor`，不合规 ⇒ 400）；
 * 次序固定 `used DESC, id ASC`；游标绑定生成时的本地日期，跨过本地午夜即作废（400）；`next_cursor` 为 null 表示没有更多页；`truncated` 保留旧字段，含义改为「还有后续页」（= next_cursor 非空）。
 * 审计表读不到时 `usage_unavailable=true`、`tokens` 为空（不报「剩余全部额度」，因为限流此时 fail closed）。
 */
const singleParam = (v) => (Array.isArray(v) ? undefined : v)
r.get(
  '/limits/quota',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => {
    const rawLimit = singleParam(req.query.limit)
    let limit = QUOTA_PAGE_DEFAULT
    if (req.query.limit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^[0-9]{1,9}$/.test(rawLimit) || Number(rawLimit) < 1) return fail(res, 'limit 必须是 1..500 的整数', 400, 400)
      limit = Math.min(Number(rawLimit), QUOTA_PAGE_MAX)
    }
    let after = null
    if (req.query.cursor !== undefined) {
      after = decodeQuotaCursor(singleParam(req.query.cursor))
      if (!after) return fail(res, 'cursor 无效（请使用上一页返回的 next_cursor）', 400, 400)
    }
    const db = getDb()
    const quota = dailyQuotaConfigured(db)
    if (!(quota > 0)) return ok(res, { daily_quota: 0, enabled: false, usage_unavailable: false, truncated: false, next_cursor: null, tokens: [] })
    const page = dailyQuotaPage(db, { limit, after })
    if (page?.expired) return fail(res, 'cursor 已过期（已跨过本地午夜，用量已归零），请从第一页重新开始', 400, 400)
    // 审计表读不到：限流此时 fail closed，所以不能报"还剩全部额度"——如实标 usage_unavailable
    if (!page) return ok(res, { daily_quota: quota, enabled: true, usage_unavailable: true, truncated: false, next_cursor: null, tokens: [] })
    const tokens = page.rows.map((t) => ({ id: t.id, name: t.name, used: t.used, remaining: Math.max(0, quota - t.used) }))
    return ok(res, { daily_quota: quota, enabled: true, usage_unavailable: false, truncated: page.next !== null, next_cursor: page.next, tokens })
  })
)

r.get(
  '/scopes',
  requireAuth,
  wrap((_req, res) => ok(res, Object.entries(SCOPE_LABEL).map(([k, v]) => ({ code: k, name: v }))))
)

/**
 * 令牌列表 / 详情（ADR-0015）：每行带 `effective_status` / `effective_reason` ——
 * 行状态 `status` 是历史（谁签的、有没有被吊销），`effective_status` 是现状
 * （所有者改密 / 停用 / 行不存在 / 过期时它不再是 `active`）。读路径不改库；
 * 要让行状态追上现状用下面的 `POST /tokens/sweep`。调用时仍以 `delegation.js` 为准。
 */
r.get(
  '/tokens',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((_req, res) => ok(res, listTokensWithStatus(getDb())))
)

/** 清扫：把所有者版本已变 / 所有者已不存在、但行仍 active 的令牌置为 revoked 并记原因（幂等） */
r.post(
  '/tokens/sweep',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => ok(res, sweepOwnerRevokedTokens(getDb(), { actor: req.user.name || req.user.username })))
)

r.get(
  '/tokens/:id',
  requireAuth,
  requirePerm('system.mcp.manage'),
  wrap((req, res) => {
    const t = getTokenWithStatus(getDb(), Number(req.params.id))
    if (!t) return fail(res, 'Token 不存在', 404)
    return ok(res, t)
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
