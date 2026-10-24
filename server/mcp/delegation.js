/**
 * ============================================================================
 * 文件标识：server/mcp/delegation.js ｜ 有主 Agent Token 的委托判定：所有者存在 / active / 版本未变；权限与数据范围 = 令牌声明 ∩ 所有者当前
 * ============================================================================
 * 【这块解决什么问题】F07：令牌签发之后，所有者被停用 / 降权 / 换组织，令牌照样能用 ——
 *   "界面点不动、Agent 能动"。ADR-0011 把令牌定义为**所有者的委托**：
 *   它能做的事永远是「令牌自己声明的范围」与「所有者此刻还有的权限与范围」的**交集**。
 *
 * 【为什么这样设计】与 `requireAuth`（A20）同一口径：凭据只是"谁签发过"的声明，
 *   可用性与权限一律**每次回库**。所有者的权限点走 `permContext`、数据范围走 `resolveOrgScope`
 *   —— 都是 HTTP 侧那一份判据，这里不另写。
 *
 * 【改它要注意什么】
 *   · 无主令牌（`owner_user_id IS NULL`）是**独立服务主体**：只受令牌自身范围约束，
 *     采购写型工具对它的 403 `AGENT_OWNER_REQUIRED` 仍在 `tools.js`；这里不替它放宽也不替它收紧。
 *   · `owner_auth_version` 为 NULL 的**有主**令牌一律按失效处理（fail-closed）：
 *     正常路径不会出现（053 迁移回填 + `createToken` 必填），出现即说明有人绕过签发入口。
 *   · 错误码是**对外契约**（JSON-RPC `error.data.code` / 工具 `error`），改名要同步 ADR-0011。
 * ============================================================================
 */
import { permContext, hasPerm, resolveOrgScope } from '../middleware/auth.js'

/** 所有者相关的稳定错误码（凭据层：JSON-RPC error） */
export const TOKEN_OWNER_MISSING = 'TOKEN_OWNER_MISSING'
export const TOKEN_OWNER_INACTIVE = 'TOKEN_OWNER_INACTIVE'
export const TOKEN_OWNER_REVOKED = 'TOKEN_OWNER_REVOKED'
/** 工具层：所有者当前没有该工具所需权限点（result.isError） */
export const TOKEN_OWNER_PERM_DENIED = 'TOKEN_OWNER_PERM_DENIED'

/**
 * 解析一张令牌的委托关系。
 * @returns {{ ownerless: true } | { ownerless: false, owner, permCtx, ownerScope } | { error: { code, message } }}
 */
export function resolveDelegation(db, row) {
  if (row.owner_user_id == null) return { ownerless: true, owner: null, permCtx: null, ownerScope: null }
  const u = db
    .prepare('SELECT id, username, name, role, is_super, status, org_id, data_scope, dealer_id, store_id, auth_version FROM users WHERE id=?')
    .get(Number(row.owner_user_id))
  if (!u) {
    return { error: { code: TOKEN_OWNER_MISSING, message: '令牌所有者已不存在，委托令牌随之失效' } }
  }
  if (u.status !== 'active') {
    return { error: { code: TOKEN_OWNER_INACTIVE, message: '令牌所有者已停用，其名下 Agent Token 不能再使用' } }
  }
  if (row.owner_auth_version == null || Number(row.owner_auth_version) !== Number(u.auth_version)) {
    return {
      error: {
        code: TOKEN_OWNER_REVOKED,
        message: '令牌所有者的账号安全状态已变化（改密 / 停用 / 角色或组织变更 / 权限集变更），签发于此前的 Agent Token 已失效，请重新签发'
      }
    }
  }
  const identity = { uid: u.id, role: u.role, org_id: u.org_id, dealer_id: u.dealer_id, store_id: u.store_id }
  return {
    ownerless: false,
    owner: u,
    permCtx: permContext(db, identity),
    ownerScope: resolveOrgScope(db, identity)
  }
}

/** 令牌自身绑定的组织范围（未绑组织 = 全局） */
export function tokenOrgScope(db, row) {
  if (!row.org_id) return { scope: 'all', orgIds: null, orgId: null }
  const node = db.prepare('SELECT id, path FROM orgs WHERE id=?').get(row.org_id)
  if (node?.path) {
    const ids = db.prepare('SELECT id FROM orgs WHERE path LIKE ? OR id=?').all(`${node.path}%`, node.id).map((x) => x.id)
    return { scope: 'subtree', orgIds: ids, orgId: node.id }
  }
  return { scope: 'org', orgIds: [row.org_id], orgId: row.org_id }
}

/**
 * 两个组织范围的交集。`all` 表示不受限；其余一律按 id 集合求交 ——
 * `dealer` / `none` / 没有组织归属的 `self` 在 MCP 的组织口径下**没有可见组织**，
 * 交集为空，所有读工具 `AND 1=0`、写工具 `ORG_OUT_OF_SCOPE`（宁可看不到，也不放行）。
 */
export function intersectScope(a, b) {
  const unlimited = (s) => !s || s.scope === 'all'
  const ids = (s) => (Array.isArray(s?.orgIds) ? s.orgIds.map(Number) : [])
  const orgId = a?.orgId ?? b?.orgId ?? null
  if (unlimited(a) && unlimited(b)) return { scope: 'all', orgIds: null, orgId }
  const merged = unlimited(a) ? ids(b) : unlimited(b) ? ids(a) : ids(a).filter((id) => ids(b).includes(id))
  return { scope: merged.length ? 'restricted' : 'none', orgIds: merged, orgId }
}

/** 本次调用实际生效的数据范围：无主令牌 = 令牌范围；有主令牌 = 令牌范围 ∩ 所有者当前范围 */
export function effectiveScope(db, row, delegation) {
  const mine = tokenOrgScope(db, row)
  if (!delegation || delegation.ownerless) return mine
  return intersectScope(mine, delegation.ownerScope)
}

/**
 * 工具所需权限点（`tool.perms`，任一命中即可）是否在所有者**当前**权限内。
 * 无主令牌不受此门约束（它没有"所有者"可对照）；未声明 `perms` 的工具只受范围与级别约束。
 * @returns {null | { code, message }}
 */
export function ownerToolDenied(delegation, tool) {
  if (!tool || !delegation || delegation.ownerless) return null
  const need = Array.isArray(tool.perms) ? tool.perms : []
  if (!need.length) return null
  if (need.some((code) => hasPerm(delegation.permCtx, code))) return null
  const who = delegation.owner?.name || delegation.owner?.username || `uid:${delegation.owner?.id}`
  return {
    code: TOKEN_OWNER_PERM_DENIED,
    message: `令牌所有者「${who}」当前没有调用「${tool.title || tool.name}」的权限（需 ${need.join(' 或 ')}）；委托令牌不能超过所有者本人的权限`
  }
}

/**
 * Z8：幂等缓存命中前的数据范围重验。缓存里只记得"首次执行时的有效范围"，
 * 重放时的**当前**有效范围必须覆盖它，否则回放等于用旧范围替所有者继续放行。
 *  · 当前不受限（all）⇒ 覆盖一切；
 *  · 首次范围未知（旧缓存行）或首次不受限而当前受限 ⇒ 不覆盖（fail-closed）；
 *  · 其余按组织 id 集合求包含。
 * 判的是"范围是否缩小"而不是具体目标：偏保守，调用方换新幂等键即走工具自身的精确判定。
 */
export function scopeCovers(current, snapshot) {
  const unlimited = (s) => !s || s.scope === 'all'
  if (unlimited(current)) return true
  if (!snapshot || unlimited(snapshot)) return false
  const have = new Set((current.orgIds || []).map(Number))
  return (snapshot.orgIds || []).every((id) => have.has(Number(id)))
}

/** 缓存里要保存的范围快照（只留判定所需的两个字段） */
export function scopeSnapshot(scope) {
  if (!scope || scope.scope === 'all') return { scope: 'all', orgIds: null }
  return { scope: scope.scope, orgIds: Array.isArray(scope.orgIds) ? scope.orgIds.map(Number) : [] }
}

/**
 * Z8（Codex 审计 P1）：声明了 `perms` 的工具，所有者权限点由 `ownerToolDenied` 在命中前精确重判；
 * 但 `perms: []` 的工具（如 `doc.transition`，权限点在 handler 内按"边"判）命中缓存时不会进 handler。
 * 对这类工具，缓存里同时记下首次执行时所有者的权限集合，重放时要求当前权限集合**不少于**它。
 * 无主令牌没有所有者可对照，恒放行。
 */
export function permSnapshot(delegation) {
  if (!delegation || delegation.ownerless) return null
  const c = delegation.permCtx
  if (c?.isSuper) return { super: true, perms: [] }
  return { super: false, perms: [...(c?.perms || [])].map(String).sort() }
}

export function permsCovered(delegation, snapshot) {
  if (!delegation || delegation.ownerless) return true
  const c = delegation.permCtx
  if (c?.isSuper) return true
  if (!snapshot || snapshot.super) return false
  const have = c?.perms || new Set()
  return have.has('*') || snapshot.perms.every((p) => have.has(p))
}
