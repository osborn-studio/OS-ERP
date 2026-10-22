/**
 * ============================================================================
 * 文件标识：server/lib/audit-trail.js ｜ `audit_logs` 的**唯一 INSERT 点**：明细归一与脱敏、普通写入、以及事务内"写不进就抛"的严格写入
 * ============================================================================
 * 【职责】
 *   · `insertAuditRow(db,row)`：一条 INSERT。明细在这里统一序列化并脱敏（凭据键遮盖、手机号部分遮盖）。
 *   · `auditStrictRow(db,row)`：**必须在事务内**调用；写不进（抛错 / RAISE(IGNORE) 导致 0 行）即抛
 *     `SECURITY_AUDIT_UNAVAILABLE`（503），让包着它的业务事务一起回滚。
 *
 * 【为什么单独成文件】`middleware/audit.js`（请求级 `audit` / `auditStrict`）与 `lib/account-security.js`
 *   （账号安全变更）原来各写一份 INSERT，脱敏与"0 行也算失败"的判据只能在一处 —— 就是这里。
 *   本文件不 import 数据库上下文，纯函数接 `db`，便于直接用内存库测试。
 *
 * 【注意】`auditStrictRow` 不在事务里会抛 `AUDIT_OUTSIDE_TX`（500）：这是编码错误，不是运行时不可用，
 *   与 `lib/settings.js` 的 `logSettingChange` 同一条口径。普通 `insertAuditRow` 不要求事务。
 * ============================================================================
 */

import { redactValue } from './redact.js'

export const SECURITY_AUDIT_UNAVAILABLE = 'SECURITY_AUDIT_UNAVAILABLE'
export const AUDIT_OUTSIDE_TX = 'AUDIT_OUTSIDE_TX'

// 序列化失败（BigInt、`toJSON` 里抛）时明细退化成标记串，但**记录照写** —— 明细可补，记录没了就永久没了。
const UNSERIALIZABLE_DETAIL = '{"__unserializable__":true}'

const fault = (code, message, status) => Object.assign(new Error(message), { code, status })

/** `detail` → TEXT 列能收的字符串（唯一一处归一化 + 脱敏） */
export function normalizeDetail(detail) {
  if (detail === null || detail === undefined) return null
  const safe = redactValue(detail)
  if (typeof safe === 'string') return safe
  try {
    return JSON.stringify(safe)
  } catch {
    return UNSERIALIZABLE_DETAIL
  }
}

const INSERT = `INSERT INTO audit_logs (user_id, user_name, action, module, entity, entity_id, detail, ip)
       VALUES (?,?,?,?,?,?,?,?)`

function bind(row, { withDetail = true } = {}) {
  return [
    row.userId ?? null,
    row.userName || 'anonymous',
    row.action,
    row.module ?? null,
    row.entity ?? null,
    row.entityId === null || row.entityId === undefined ? null : String(row.entityId),
    withDetail ? normalizeDetail(row.detail) : null,
    row.ip ?? null
  ]
}

/** 普通写入：返回 better-sqlite3 的 run 结果；失败直接抛给调用方决定（`audit()` 会重试一次去掉明细） */
export function insertAuditRow(db, row, options) {
  return db.prepare(INSERT).run(...bind(row, options))
}

/**
 * 严格写入：事务内调用；任何失败（抛错或 0 行）都抛 503 `SECURITY_AUDIT_UNAVAILABLE`，
 * 由外层 `db.transaction` 回滚业务写入。不做"去掉明细再试"：安全相关动作的明细本身就是证据。
 */
export function auditStrictRow(db, row) {
  if (!db.inTransaction) {
    throw fault(AUDIT_OUTSIDE_TX, `严格审计「${row?.action}」必须在事务内写入，否则审计失败不能回滚业务变更`, 500)
  }
  let changes = 0
  try {
    changes = insertAuditRow(db, row).changes
  } catch {
    throw fault(SECURITY_AUDIT_UNAVAILABLE, '安全审计暂不可用，变更未提交', 503)
  }
  if (changes !== 1) throw fault(SECURITY_AUDIT_UNAVAILABLE, '安全审计暂不可用，变更未提交', 503)
  return changes
}
