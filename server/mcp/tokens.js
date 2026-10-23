/**
 * ============================================================================
 * 文件标识：server/mcp/tokens.js ｜ Agent Token：AI 接入凭据的签发、校验、吊销
 * ============================================================================
 * 【职责】Agent Token：AI 接入凭据的签发、校验、吊销
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// Agent Token：AI 接入凭据的签发、校验、吊销
//
// 与人的 JWT 分离的原因（第三轮 A2）：
//   人用 JWT（12 小时自动过期、跟着浏览器走）；
//   Agent 用 Token（长期有效、可吊销、可限速、独立审计）。
//   混用会导致「AI 拿到了某人的全权凭据」这种无法追责的局面。

import { requireDemoDatabase } from '../db/runtime-policy.js'
import crypto from 'node:crypto'
import { assertIndustry, showValue } from '../db/index.js'
// 时间只认本地口径：本模块原来用 `new Date().toISOString()`（**UTC**）判过期，
// 而 expires_at 是本地时间串。东八区下相差 8 小时 —— 本地 00:00–08:00 之间，
// 「已过期的令牌」会被判成还有效。与 lib/dates.js 的规则一致：派生时间只有一个出处。
import { localNow } from '../lib/dates.js'

const PREFIX = 'gml'

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex')
}

export function generateToken() {
  const raw = `${PREFIX}_${crypto.randomBytes(24).toString('hex')}`
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) }
}

export const SCOPE_LABEL = {
  read: '查询（只读）',
  write: '事务（下单/出入库/调拨，强制幂等）',
  danger: '高危（调价/作废/审批通过，需人工二次确认）'
}

/** 建令牌时**字段形状**非法的稳定业务码（400）。与 `db/index.js` 的 `INDUSTRY_CODE_INVALID` 同族。 */
export const TOKEN_FIELD_INVALID = 'TOKEN_FIELD_INVALID'

/** 字段形状非法的**唯一报错构造点**：400 + 人话 + 稳定码。**保证不抛**（回显走 `showValue`）。 */
function tokenFieldError(field, value, need) {
  const shown = showValue(value)
  const e = new Error(`令牌字段「${field}」取值非法：${shown}（需 ${need}）`)
  e.status = 400
  e.code = TOKEN_FIELD_INVALID
  e.detail = { field, value: shown, need }
  return e
}

/** 签发 Token。scopes 为数组或用逗号分隔的字符串 */
export function createToken(db, {
  name, orgId = null, ownerUserId = null, industry = null,
  scopes = 'read', allowTools = null, denyTools = null,
  rateLimit = 600, expiresAt = null, remark = null
}) {
  // 行业码**在建令牌时就校验** —— 判据与 `server/db/index.js` 的 `assertIndustry` 同源，
  // 不在这里另写一份：
  //   · 缺失（`null` / `undefined` / 空串）⇒ 合法（Token 未绑定行业，用时落当前请求行业）；
  //   · 给了非法码（`'foo'` / `'Cosmetic'` / `'cosmetic '` / `'constructor'`…）⇒ **当场抛**
  //     （`400` + `INDUSTRY_CODE_INVALID`），**绝不写进库**。
  // 为什么这条闸必须立在这里（而不是只在 MCP 使用时拒）：令牌行里的 `industry` 会在
  // `mcp/server.js` 解析行业时被当真，而 `createToken` 是**独立于 HTTP 中间件**的第二条写入入口
  // —— `admin.js` 那条走 `req.user.industry`（已被中间件保证合法），这条不走。
  // 只挡住一条就是"同一件事两处实现、只改了一处"；本项目的脏数据（一张永远用不了的令牌）
  // 就是这样留下的：建得出来、用一次被拒。
  const boundIndustry = assertIndustry(industry) // null ⇒ 未绑定

  // ---- 入参**形状**校验（fail-fast：在建令牌**之前**挡住，别让它带病进库）----
  // 这些字段全部**用户可控**（`admin.js:53` 直接从 body 透传）。不校验时的**同症状**（用户可控值 ⇒
  // 500 且**无业务码**，与本线刚修的 `{toString:null}` 是一类，只是触发点不同）：
  //   · `scopes:{toString:null}` ⇒ 下面 `String(scopes)` 抛 TypeError；
  //   · `allow_tools:{a:1}` / `remark:{a:1}` / `expires_at:{a:1}` ⇒ better-sqlite3 把对象当成
  //     **具名参数包** ⇒ `RangeError: Too few parameter values were provided`。
  // （实测：这 5 个 body 形态打 `POST /api/mcp/tokens` 全部 500。）
  const scalar = (v) => v == null || typeof v === 'string' || typeof v === 'number'
  if (typeof name !== 'string' || name === '') throw tokenFieldError('name', name, '非空字符串')
  if (!scalar(orgId)) throw tokenFieldError('orgId', orgId, '数字 / null')
  if (!scalar(ownerUserId)) throw tokenFieldError('ownerUserId', ownerUserId, '数字 / null')
  if (!scalar(rateLimit)) throw tokenFieldError('rateLimit', rateLimit, '数字 / null')
  if (!scalar(expiresAt)) throw tokenFieldError('expiresAt', expiresAt, '字符串 / null')
  if (!scalar(remark)) throw tokenFieldError('remark', remark, '字符串 / null')
  /** `scopes` / `allowTools` / `denyTools`：字符串（逗号分隔）或字符串数组 */
  const asCsv = (field, v, dflt = null) => {
    if (v == null) return dflt
    if (typeof v === 'string') return v
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(',')
    throw tokenFieldError(field, v, '字符串 / 字符串数组 / null')
  }

  // 有主令牌 = 所有者的委托（ADR-0011）：所有者此刻必须存在且 active，并把其当前
  // `auth_version` 记进令牌 —— 之后所有者任何一次撤权事件（版本递增）都会让这张令牌失效。
  const owner = ownerAtIssue(db, ownerUserId)

  const { raw, hash, prefix } = generateToken()
  const scopeStr = asCsv('scopes', scopes, 'read')
  const info = db.prepare(`
    INSERT INTO agent_tokens (name, token_hash, token_prefix, owner_user_id, owner_auth_version, org_id, industry, scopes,
                              allow_tools, deny_tools, rate_limit, expires_at, remark)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    name, hash, prefix, owner?.id ?? null, owner?.auth_version ?? null, orgId, boundIndustry, scopeStr,
    asCsv('allowTools', allowTools),
    asCsv('denyTools', denyTools),
    rateLimit, expiresAt, remark
  )
  return { id: Number(info.lastInsertRowid), token: raw, prefix, name, scopes: scopeStr }
}

/**
 * 从请求提取 Agent Token 原文：**只认 `Authorization: Bearer`**（ADR-0011 / F13）。
 *
 * 原来还收 `x-agent-token` 头、`?token=` 查询串与 `body.token`。查询串会原样落进访问日志、
 * 代理日志与浏览器历史 —— 一张长期有效的写型凭据就这样被"记"在各处。
 * 不收 header 之外的任何位置，也不做兼容回退：回退就是把洞留着。
 */
export function extractToken(req) {
  const h = String(req.headers?.authorization || '')
  if (!/^Bearer\s/i.test(h)) return null
  const raw = h.slice(7).trim()
  return raw || null
}

/** 所有者相关的稳定业务码（签发侧 400；调用侧见 `delegation.js`） */
export const TOKEN_OWNER_INVALID = 'TOKEN_OWNER_INVALID'
export const TOKEN_OWNER_INACTIVE = 'TOKEN_OWNER_INACTIVE'

/**
 * 签发时对所有者的**唯一**判据：存在且 active，并取其当前 `auth_version` 记进令牌。
 * 停用账号不能再被签新令牌 —— 否则"停用联动吊销"可以被"再签一张"绕过。
 */
function ownerAtIssue(db, ownerUserId) {
  if (ownerUserId == null) return null
  const u = db.prepare('SELECT id, status, auth_version FROM users WHERE id=?').get(Number(ownerUserId))
  if (!u) {
    const e = new Error(`令牌所有者 #${showValue(ownerUserId)} 不存在`)
    e.status = 400
    e.code = TOKEN_OWNER_INVALID
    throw e
  }
  if (u.status !== 'active') {
    const e = new Error(`令牌所有者 #${u.id} 已停用，不能签发委托令牌`)
    e.status = 400
    e.code = TOKEN_OWNER_INACTIVE
    throw e
  }
  return u
}

/**
 * 吊销某所有者名下**全部**仍有效的令牌（ADR-0011）。由账号停用在同一事务里调用；
 * 返回吊销条数。不吞错：事务内抛错就让整笔账号变更一起回滚。
 */
export function revokeOwnerTokens(db, ownerUserId, remark = '所有者已停用，令牌随之吊销') {
  if (ownerUserId == null) return 0
  return db
    .prepare(`UPDATE agent_tokens SET status='revoked', remark=?, revoked_reason=?, revoked_at=datetime('now','localtime')
               WHERE owner_user_id=? AND status='active'`)
    .run(remark, REVOKE_REASON.ownerInactive, Number(ownerUserId)).changes
}

// ---------------------------------------------------------------------------
// 有效状态（ADR-0015）：列表 / 详情要如实回答"这张令牌现在能不能用"
// ---------------------------------------------------------------------------
// 判据只有一处：**调用时**以 `delegation.js` 的 `resolveDelegation` 为准（所有者存在 / active /
// 版本对照），这里只是把同一组条件翻成一个可展示的状态码，不另起一套"谁算失效"的规则，
// 也不在读路径上改库 —— 行状态是历史，`effective_status` 是现状；要让两者一致用 `sweepOwnerRevokedTokens`。

/** `agent_tokens.revoked_reason` 的稳定码 */
export const REVOKE_REASON = {
  admin: 'admin', // 管理员在界面上吊销
  ownerInactive: 'owner_inactive', // 账号停用联动吊销（ADR-0011）
  ownerAuthChanged: 'owner_auth_changed', // 清扫：所有者 auth_version 已变
  ownerMissing: 'owner_missing' // 清扫：所有者行已不存在
}

/** `effective_status` 的取值（对外契约，改名要同步 ADR-0015） */
export const EFFECTIVE_STATUS = {
  active: 'active',
  revoked: 'revoked',
  expired: 'expired',
  ownerMissing: 'owner_missing',
  ownerInactive: 'owner_inactive',
  revokedByOwnerChange: 'revoked_by_owner_change'
}

const EFFECTIVE_REASON = {
  revoked: '已吊销',
  expired: '已过期',
  owner_missing: '所有者账号已不存在，委托令牌随之失效',
  owner_inactive: '所有者账号已停用，其名下令牌不能再使用',
  revoked_by_owner_change: '所有者的账号安全状态已变化（改密 / 退出全部会话 / 角色或权限集变更），签发于此前的令牌已失效，需重新签发'
}

/**
 * 由令牌行 + 所有者行算出有效状态。纯函数（不查库、不改库）；`owner` 为 `null` 表示所有者行不存在，
 * `undefined` 表示无主令牌（不做所有者判定）。顺序与 `verifyToken` → `resolveDelegation` 一致：
 * 先看令牌自身（吊销 / 过期），再看所有者。
 */
export function effectiveTokenStatus(row, owner, now = localNow()) {
  let status = EFFECTIVE_STATUS.active
  if (row.status !== 'active') status = EFFECTIVE_STATUS.revoked
  else if (row.expires_at && String(row.expires_at) < now) status = EFFECTIVE_STATUS.expired
  else if (row.owner_user_id != null) {
    if (!owner) status = EFFECTIVE_STATUS.ownerMissing
    else if (owner.status !== 'active') status = EFFECTIVE_STATUS.ownerInactive
    else if (row.owner_auth_version == null || Number(row.owner_auth_version) !== Number(owner.auth_version)) {
      status = EFFECTIVE_STATUS.revokedByOwnerChange
    }
  }
  return { effective_status: status, effective_reason: EFFECTIVE_REASON[status] || null }
}

const TOKEN_LIST_SELECT = `
  SELECT t.id, t.name, t.token_prefix, t.org_id, o.name AS org_name, t.industry, t.scopes,
         t.allow_tools, t.deny_tools, t.rate_limit, t.expires_at, t.last_used_at, t.call_count,
         t.status, t.remark, t.created_at, t.revoked_reason, t.revoked_at,
         t.owner_user_id, t.owner_auth_version,
         u.username AS owner_username, u.name AS owner_name, u.status AS owner_status, u.auth_version AS owner_current_auth_version
    FROM agent_tokens t
    LEFT JOIN orgs o ON o.id = t.org_id
    LEFT JOIN users u ON u.id = t.owner_user_id`

function withEffective(r) {
  const owner = r.owner_user_id == null ? undefined : (r.owner_username == null && r.owner_status == null ? null : { status: r.owner_status, auth_version: r.owner_current_auth_version })
  const { owner_status, owner_current_auth_version, ...rest } = r
  return { ...rest, ...effectiveTokenStatus(r, owner) }
}

/** 管理员列表：每行带 `effective_status` / `effective_reason`（只读，不改库） */
export function listTokensWithStatus(db) {
  return db.prepare(`${TOKEN_LIST_SELECT} ORDER BY t.id DESC`).all().map(withEffective)
}

/** 单张令牌详情（同一份字段），不存在返回 null */
export function getTokenWithStatus(db, id) {
  const r = db.prepare(`${TOKEN_LIST_SELECT} WHERE t.id=?`).get(Number(id))
  return r ? withEffective(r) : null
}

/**
 * 清扫：把"行仍 active、但按所有者判定已失效"的有主令牌真正置为 `revoked` 并记原因。
 * 只处理所有者**版本变化**与**所有者行不存在**两类 —— 停用已由 `revokeOwnerTokens` 在停用事务里处理；
 * 过期令牌的 `expires_at` 本身就是事实，不改写。返回 `{ swept, ids }`。
 */
export function sweepOwnerRevokedTokens(db, { actor = null } = {}) {
  const rows = db.prepare(`${TOKEN_LIST_SELECT} WHERE t.status='active' AND t.owner_user_id IS NOT NULL`).all().map(withEffective)
  const targets = rows.filter((r) => r.effective_status === EFFECTIVE_STATUS.revokedByOwnerChange || r.effective_status === EFFECTIVE_STATUS.ownerMissing)
  const upd = db.prepare(`UPDATE agent_tokens SET status='revoked', revoked_reason=?, revoked_at=datetime('now','localtime'), remark=COALESCE(?, remark)
                           WHERE id=? AND status='active'`)
  const who = actor ? `由 ${actor} 清扫` : '系统清扫'
  const ids = []
  const run = db.transaction(() => {
    for (const r of targets) {
      const reason = r.effective_status === EFFECTIVE_STATUS.ownerMissing ? REVOKE_REASON.ownerMissing : REVOKE_REASON.ownerAuthChanged
      if (upd.run(reason, `${who}：${r.effective_reason}`, r.id).changes === 1) ids.push(r.id)
    }
  })
  run()
  return { swept: ids.length, ids }
}

/** 校验 Token，返回 { token } 或 { error } */
export function verifyToken(db, raw) {
  if (!raw) return { error: 'missing_token' }
  const row = db.prepare('SELECT * FROM agent_tokens WHERE token_hash=?').get(hashToken(raw))
  if (!row) return { error: 'invalid_token' }
  if (row.status !== 'active') return { error: 'revoked', row }
  if (row.expires_at) {
    const now = localNow()
    if (String(row.expires_at) < now) return { error: 'expired', row }
  }
  // 限速：近 1 小时调用量
  const used = db
    .prepare("SELECT COUNT(*) c FROM mcp_call_logs WHERE token_id=? AND created_at > datetime('now','localtime','-1 hour')")
    .get(row.id).c
  if (row.rate_limit > 0 && used >= row.rate_limit) return { error: 'rate_limited', row, used }
  return { row }
}

export function tokenScopes(row) {
  return String(row.scopes || 'read').split(',').map((s) => s.trim()).filter(Boolean)
}

export function tokenAllow(row) {
  const v = row.allow_tools
  return v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null
}

export function tokenDeny(row) {
  const v = row.deny_tools
  return v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []
}

export function touchToken(db, id) {
  db.prepare("UPDATE agent_tokens SET last_used_at=datetime('now','localtime'), call_count=call_count+1 WHERE id=?").run(id)
}

export function revokeToken(db, id, remark = null, reason = REVOKE_REASON.admin) {
  db.prepare(`UPDATE agent_tokens SET status='revoked', remark=COALESCE(?, remark),
                revoked_reason=COALESCE(revoked_reason, ?), revoked_at=COALESCE(revoked_at, datetime('now','localtime'))
              WHERE id=?`).run(remark, reason, id)
}

/**
 * 演示用：确保每个行业库至少有几个可用的 Agent Token（幂等，只在缺失时建）。
 *
 * **必须绑定 `ownerUserId`**（批次 K）：采购域的写型工具要能回答"是谁在办"——
 * 单据上的 `created_by` / `approved_by` 不能是空，而权限点的判定也以这个人为准
 * （无主令牌调采购写型工具一律 403 `AGENT_OWNER_REQUIRED`）。
 * 演示里把写型令牌挂到「采购主管」、全权令牌挂到「系统管理员」，
 * 因为它们各自要过的权限码正好落在这些角色上。
 */
export function ensureDemoTokens(db, { industry = 'cosmetic', orgId = null } = {}) {
  requireDemoDatabase(db)
  const exists = db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c
  if (exists > 0) return []
  const userId = (username) => db.prepare('SELECT id FROM users WHERE username=?').get(username)?.id ?? null
  const created = []
  created.push(createToken(db, {
    name: '演示·只读 Agent', orgId, ownerUserId: userId('admin'), industry, scopes: 'read', rateLimit: 1200,
    remark: '仅可查询，供演示「AI 问数」场景'
  }))
  created.push(createToken(db, {
    name: '演示·业务 Agent', orgId, ownerUserId: userId('purchase'), industry, scopes: 'read,write', rateLimit: 600,
    remark: '可下单/出入库/调拨/建采购单，写操作强制幂等键'
  }))
  created.push(createToken(db, {
    name: '演示·全权 Agent', orgId, ownerUserId: userId('admin'), industry, scopes: 'read,write,danger', rateLimit: 300,
    remark: '含高危动作，但高危动作仍需人工二次确认'
  }))
  return created
}

export default { createToken, verifyToken, revokeToken, revokeOwnerTokens, extractToken, tokenScopes, tokenAllow, tokenDeny, touchToken, ensureDemoTokens, SCOPE_LABEL, effectiveTokenStatus, listTokensWithStatus, getTokenWithStatus, sweepOwnerRevokedTokens, REVOKE_REASON, EFFECTIVE_STATUS }
