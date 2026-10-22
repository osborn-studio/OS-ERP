/**
 * ============================================================================
 * 文件标识：server/lib/account-security.js ｜ 账号变更、会话撤销及严格安全审计的原子边界
 * 密码计算在事务外；提交前同时核对目标快照和操作人当前版本，防止并发覆盖/撤权竞态。
 * ============================================================================
 */
import bcrypt from 'bcryptjs'
import { validateNewPassword } from './password-policy.js'
// ADR-0011：停用账号时在同一事务里吊销其名下全部 Agent Token（委托随所有者一起失效）。
import { revokeOwnerTokens } from '../mcp/tokens.js'

const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const SECURITY_FIELDS = new Set(['role', 'is_super', 'status', 'org_id', 'data_scope', 'dealer_id', 'store_id'])
const PROFILE_FIELDS = new Set(['name', 'dept', 'phone'])
const MAX_VERSION = Number.MAX_SAFE_INTEGER
function text(value, label, max, nullable = false) {
  if (nullable && (value === null || value === '')) return null
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw error('ACCOUNT_INPUT_INVALID', `${label}格式无效`)
  return value.trim()
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_VERSION) throw error('ACCOUNT_VERSION_INVALID', '账号版本无效，无法进行安全变更', 409)
  return value
}
function actorInTransaction(db, actor, admin = false) {
  const current = db.prepare('SELECT * FROM users WHERE id=?').get(actor?.uid)
  if (!current || current.status !== 'active' || current.auth_version !== actor.auth_version) throw error('ACCOUNT_CHANGED', '账号状态已变化，请重新登录后重试', 409)
  version(current.auth_version)
  if (admin && current.role !== 'admin') throw error('ACCOUNT_ADMIN_REQUIRED', '需要管理员权限', 403)
  return current
}
function auditStrict(db, actor, action, entity, entityId, detail, ip) {
  try {
    const inserted = db.prepare(`INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail,ip)
      VALUES (?, ?, ?, 'auth', ?, ?, ?, ?)`).run(actor.id, actor.name, action, entity, String(entityId), JSON.stringify(detail), ip || null)
    if (inserted.changes !== 1) throw new Error('Security audit insert did not create a row')
  } catch {
    throw error('SECURITY_AUDIT_UNAVAILABLE', '安全审计暂不可用，变更未提交', 503)
  }
}
function atomic(db, fn) {
  try { return db.transaction(fn).immediate() } catch (e) {
    if (e.code && e.status) throw e
    throw error('ACCOUNT_UPDATE_FAILED', '账号变更未提交，请稍后重试', 503)
  }
}
function assertRole(db, role) {
  if (typeof role !== 'string' || !db.prepare("SELECT 1 FROM roles WHERE code=? AND status='active'").get(role)) throw error('ACCOUNT_ROLE_INVALID', '请选择有效角色')
}
function normalizePatch(db, input, before) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('ACCOUNT_INPUT_INVALID', '账号资料格式无效')
  const patch = {}
  for (const field of PROFILE_FIELDS) if (Object.hasOwn(input, field)) patch[field] = text(input[field], field, field === 'name' ? 80 : 128, field !== 'name')
  if (Object.hasOwn(input, 'role')) { assertRole(db, input.role); patch.role = input.role }
  if (Object.hasOwn(input, 'status')) {
    if (!['active', 'inactive'].includes(input.status)) throw error('ACCOUNT_INPUT_INVALID', '账号状态无效')
    patch.status = input.status
  }
  if (Object.hasOwn(input, 'is_super')) {
    if (![0, 1].includes(input.is_super)) throw error('ACCOUNT_INPUT_INVALID', '超级管理员标记无效')
    patch.is_super = input.is_super
  }
  if (patch.role !== undefined && patch.role !== before.role) patch.is_super = patch.role === 'admin' ? 1 : 0
  if (Object.hasOwn(input, 'data_scope')) {
    if (!['', 'all', 'subtree', 'org', 'self', 'dealer'].includes(input.data_scope)) throw error('ACCOUNT_INPUT_INVALID', '数据范围无效')
    patch.data_scope = input.data_scope
  }
  for (const [field, table] of [['org_id', 'orgs'], ['dealer_id', 'dealers'], ['store_id', 'stores']]) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (value === null || value === '') { patch[field] = null; continue }
    if (!Number.isSafeInteger(value) || value <= 0 || !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND status='active'`).get(value)) throw error('ACCOUNT_SUBJECT_INVALID', '请选择有效组织或业务主体')
    patch[field] = value
  }
  return patch
}

export async function createAccount(db, actor, input, { ip } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('ACCOUNT_INPUT_INVALID', '账号资料格式无效')
  const username = text(input.username, '账号', 64)
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{2,63}$/.test(username)) throw error('ACCOUNT_INPUT_INVALID', '账号需以字母开头，包含3至64个字母、数字、点、下划线或连字符')
  const name = text(input.name, '姓名', 80)
  const primaryRole = input.role || 'viewer'; assertRole(db, primaryRole)
  const patch = normalizePatch(db, { ...input, role: primaryRole, name }, { role: null })
  const passwordHash = await bcrypt.hash(validateNewPassword(input.password), 12)
  return atomic(db, () => {
    const currentActor = actorInTransaction(db, actor, true)
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw error('ACCOUNT_EXISTS', '账号已存在', 409)
    assertRole(db, primaryRole)
    normalizePatch(db, { ...input, role: primaryRole, name }, { role: null })
    const id = Number(db.prepare(`INSERT INTO users
      (username,password_hash,name,role,dept,phone,dealer_id,store_id,org_id,data_scope,status,is_super)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(username, passwordHash, name, primaryRole, patch.dept ?? null, patch.phone ?? null,
      patch.dealer_id ?? null, patch.store_id ?? null, patch.org_id ?? null, patch.data_scope ?? '', patch.status ?? 'active', primaryRole === 'admin' ? 1 : 0).lastInsertRowid)
    db.prepare('INSERT INTO user_roles (user_id,role_code) VALUES (?,?)').run(id, primaryRole)
    if (patch.org_id) db.prepare("INSERT INTO user_orgs (user_id,org_id,relation) VALUES (?,?,'member')").run(id, patch.org_id)
    auditStrict(db, currentActor, 'ACCOUNT_CREATE', 'user', id, { role: primaryRole }, ip)
    return { id }
  })
}

export async function updateAccount(db, actor, id, input, { ip } = {}) {
  if (!Number.isSafeInteger(id) || id <= 0) throw error('ACCOUNT_INPUT_INVALID', '用户编号无效')
  const before = db.prepare('SELECT * FROM users WHERE id=?').get(id)
  if (!before) throw error('ACCOUNT_NOT_FOUND', '用户不存在', 404)
  version(before.auth_version)
  const patch = normalizePatch(db, input, before)
  const hasPassword = Object.hasOwn(input, 'password') && input.password !== '' && input.password !== undefined
  const passwordHash = hasPassword ? await bcrypt.hash(validateNewPassword(input.password), 12) : null
  const changed = Object.keys(patch).filter(key => patch[key] !== before[key])
  const revoke = hasPassword || changed.some(key => SECURITY_FIELDS.has(key))
  return atomic(db, () => {
    const currentActor = actorInTransaction(db, actor, true)
    const current = db.prepare('SELECT auth_version,password_hash FROM users WHERE id=?').get(id)
    if (!current || current.auth_version !== before.auth_version || current.password_hash !== before.password_hash) throw error('ACCOUNT_CHANGED', '账号已被其他操作更新，请刷新后重试', 409)
    // Revalidate references after asynchronous hashing, before writing.
    normalizePatch(db, input, before)
    const keys = [...changed]
    const params = changed.map(key => patch[key])
    if (passwordHash) { keys.push('password_hash'); params.push(passwordHash) }
    if (revoke) { keys.push('auth_version'); params.push(before.auth_version + 1) }
    if (keys.length && db.prepare(`UPDATE users SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=? AND auth_version=?`).run(...params, id, before.auth_version).changes !== 1) {
      throw error('ACCOUNT_CHANGED', '账号已被其他操作更新，请刷新后重试', 409)
    }
    if (changed.includes('role')) {
      db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_code=?').run(id, before.role)
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id,role_code) VALUES (?,?)').run(id, patch.role)
    }
    if (changed.includes('org_id')) {
      db.prepare('DELETE FROM user_orgs WHERE user_id=?').run(id)
      if (patch.org_id) db.prepare("INSERT INTO user_orgs (user_id,org_id,relation) VALUES (?,?,'member')").run(id, patch.org_id)
    }
    const agentTokensRevoked = changed.includes('status') && patch.status === 'inactive' ? revokeOwnerTokens(db, id) : 0
    auditStrict(db, currentActor, 'ACCOUNT_UPDATE', 'user', id, { changed, passwordChanged: hasPassword, sessionsRevoked: revoke, agentTokensRevoked }, ip)
    return { id, sessionsRevoked: revoke, agentTokensRevoked }
  })
}

export async function changePassword(db, actor, oldPassword, newPassword, { ip } = {}) {
  if (typeof oldPassword !== 'string' || Buffer.byteLength(oldPassword, 'utf8') > 1024) throw error('PASSWORD_CURRENT_INVALID', '原密码不正确')
  validateNewPassword(newPassword)
  const before = db.prepare('SELECT * FROM users WHERE id=?').get(actor.uid)
  if (!before || !await bcrypt.compare(oldPassword, before.password_hash)) throw error('PASSWORD_CURRENT_INVALID', '原密码不正确')
  const passwordHash = await bcrypt.hash(newPassword, 12)
  return atomic(db, () => {
    const currentActor = actorInTransaction(db, actor)
    if (currentActor.auth_version !== before.auth_version || currentActor.password_hash !== before.password_hash) throw error('ACCOUNT_CHANGED', '密码已被其他操作更新，请重新登录', 409)
    db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?').run(passwordHash, actor.uid)
    auditStrict(db, currentActor, 'PASSWORD_CHANGE', 'user', actor.uid, { sessionsRevoked: true }, ip)
    return { changed: true, reauthenticate: true }
  })
}

export function logoutAll(db, actor, { ip } = {}) {
  return atomic(db, () => {
    const currentActor = actorInTransaction(db, actor)
    db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(actor.uid)
    auditStrict(db, currentActor, 'SESSION_REVOKE_ALL', 'user', actor.uid, { sessionsRevoked: true }, ip)
    return { revoked: true }
  })
}

export function replaceRolePermissions(db, actor, role, permissions, { ip } = {}) {
  assertRole(db, role)
  if (!Array.isArray(permissions) || permissions.length > 2000 || permissions.some(p => typeof p !== 'string')) throw error('ACCOUNT_INPUT_INVALID', 'permissions需为权限码数组')
  const wanted = [...new Set(permissions)].sort()
  return atomic(db, () => {
    const currentActor = actorInTransaction(db, actor, true)
    for (const permission of wanted) if (!db.prepare('SELECT 1 FROM permissions WHERE code=?').get(permission)) throw error('ACCOUNT_PERMISSION_INVALID', '权限码无效')
    const existing = db.prepare('SELECT perm_code FROM role_permissions WHERE role_code=? ORDER BY perm_code').all(role).map(r => r.perm_code)
    let revoked = 0
    if (JSON.stringify(existing) !== JSON.stringify(wanted)) {
      const affected = db.prepare('SELECT id,auth_version FROM users WHERE role=? OR id IN (SELECT user_id FROM user_roles WHERE role_code=?)').all(role, role)
      for (const user of affected) version(user.auth_version)
      db.prepare('DELETE FROM role_permissions WHERE role_code=?').run(role)
      const add = db.prepare('INSERT INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const permission of wanted) add.run(role, permission)
      const revoke = db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?')
      for (const user of affected) revoke.run(user.id)
      revoked = affected.length
    }
    auditStrict(db, currentActor, 'ROLE_PERM_UPDATE', 'role', role, { permissionCount: wanted.length, revokedUsers: revoked }, ip)
    return { role, permissions: wanted.length, revokedUsers: revoked }
  })
}
