/**
 * ============================================================================
 * 文件标识：server/lib/admin-bootstrap.js ｜ 空生产库的一次性企业管理员初始化
 * 仅供本机 CLI；组织、用户、角色、审计与一次性标记在同一 immediate 事务提交。
 * ============================================================================
 */
import bcrypt from 'bcryptjs'
import { requireDataDirectory } from '../runtime.js'
import { assertDatabaseMode } from '../db/runtime-policy.js'
import { validateNewPassword } from './password-policy.js'
import { insertAuditRow } from './audit-trail.js'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const hasControls = value => /[\u0000-\u001f\u007f]/u.test(value)

export function validateBootstrapInput(input = {}) {
  const { username, name, companyCode, companyName, password } = input
  if (typeof username !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{2,63}$/.test(username)) {
    fail('BOOTSTRAP_INPUT_INVALID', 'Username must contain 3–64 ASCII letters, digits, dot, underscore or hyphen and start with a letter')
  }
  if (typeof companyCode !== 'string' || !/^[A-Z][A-Z0-9_-]{2,39}$/.test(companyCode) || companyCode === 'SYS_DEFAULT') {
    fail('BOOTSTRAP_INPUT_INVALID', 'Company code must contain 3–40 uppercase ASCII letters, digits, underscore or hyphen; SYS_DEFAULT is reserved')
  }
  for (const [value, limit, label] of [[name, 80, 'Name'], [companyName, 120, 'Company name']]) {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > limit || hasControls(value)) {
      fail('BOOTSTRAP_INPUT_INVALID', `${label} is empty, too long, contains control characters or has leading/trailing whitespace`)
    }
  }
  try { validateNewPassword(password) } catch { fail('BOOTSTRAP_PASSWORD_INVALID', 'Password must contain at least 16 characters, at most 72 UTF-8 bytes and at least 6 distinct characters, with no control characters') }
  return { username, name, companyCode, companyName, password }
}

export function bootstrapAdmin(db, input) {
  if (process.env.GML_RUNTIME_MODE !== 'production') {
    fail('BOOTSTRAP_PRODUCTION_REQUIRED', 'Explicit GML_RUNTIME_MODE=production is required')
  }
  requireDataDirectory()
  assertDatabaseMode(db, 'production')
  const { username, name, companyCode, companyName, password } = validateBootstrapInput(input)
  const passwordHash = bcrypt.hashSync(password, 12)
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS os_egp_admin_bootstrap (
      id INTEGER PRIMARY KEY CHECK(id=1),
      user_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    if (db.prepare('SELECT 1 FROM os_egp_admin_bootstrap WHERE id=1').get()) {
      fail('BOOTSTRAP_ALREADY_COMPLETED', 'Administrator bootstrap was already completed; use normal account administration')
    }
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get() || db.prepare('SELECT 1 FROM orgs WHERE id<>0 LIMIT 1').get()) {
      fail('BOOTSTRAP_NOT_EMPTY', 'Bootstrap requires an empty user table and no existing business organization')
    }
    if (!db.prepare("SELECT 1 FROM roles WHERE code='admin' AND status='active'").get()) {
      fail('BOOTSTRAP_SCHEMA_INCOMPLETE', 'An active built-in admin role is required')
    }
    const orgId = Number(db.prepare(`INSERT INTO orgs
      (code,name,short_name,type,parent_id,level,path,is_legal,currency,status)
      VALUES (?,?,?,'group',NULL,0,'',1,'CNY','active')`).run(companyCode, companyName, companyName).lastInsertRowid)
    db.prepare('UPDATE orgs SET path=?, owner_org_id=? WHERE id=?').run(`/${orgId}/`, orgId, orgId)
    const userId = Number(db.prepare(`INSERT INTO users
      (username,password_hash,name,role,status,org_id,data_scope,is_super)
      VALUES (?,?,?,'admin','active',?,'all',1)`).run(username, passwordHash, name, orgId).lastInsertRowid)
    db.prepare("INSERT INTO user_roles (user_id,role_code) VALUES (?,'admin')").run(userId)
    db.prepare("INSERT INTO user_orgs (user_id,org_id,relation) VALUES (?,?,'manager')").run(userId, orgId)
    const addFunction = db.prepare('INSERT INTO org_functions (org_id,func_code,enabled) VALUES (?,?,1)')
    for (const code of ['purchase', 'sales', 'inventory', 'finance']) addFunction.run(orgId, code)
    // 唯一 INSERT 点：同一事务内入哈希链（ADR-0049）
    insertAuditRow(db, { userId, userName: name, action: 'BOOTSTRAP_ADMIN', module: 'system', entity: 'user', entityId: userId, detail: { companyCode, source: 'local-cli' } })
    db.prepare('INSERT INTO os_egp_admin_bootstrap (id,user_id,org_id) VALUES (1,?,?)').run(userId, orgId)
    return { userId, username, orgId, companyCode }
  }).immediate()
}
