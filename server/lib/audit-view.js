/**
 * ============================================================================
 * 文件标识：server/lib/audit-view.js ｜ 审计日志查看器的查询与 CSV 编码（Z7 / roadmap-v5 Z7）
 * ============================================================================
 * 【职责】把 `GET /api/meta/audit-logs` 与导出共用的过滤条件、读取侧二次脱敏、CSV 单元格编码放在一处。
 * 【口径】
 *   · 过滤只有一份实现（`buildWhere`），列表与导出不会各自漂移；
 *   · `detail` 读出时再过一遍 `redact.js`（写入侧已脱敏，但旧行 / 直接写库的行不保证）；
 *   · CSV 每个单元格都加引号；以 `= + - @ Tab CR`（含全角形态，允许前导空白）开头的值前置 `'`，防电子表格公式注入；
 *   · 导出有行数上限（`AUDIT_EXPORT_MAX_ROWS`），超出截断并在审计里记 truncated。
 * ============================================================================
 */
import { redactValue, redactText } from './redact.js'

export const AUDIT_EXPORT_MAX_ROWS = 50000
export const AUDIT_PAGE_MAX = 200
const DETAIL_MAX = 8000
const CSV_CELL_MAX = 32000

export class AuditViewError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'AUDIT_VIEW_BAD_FILTER' }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
const one = (v) => (Array.isArray(v) ? v[0] : v)
const str = (v, max = 200) => {
  const s = one(v)
  if (s === undefined || s === null) return ''
  return String(s).trim().slice(0, max)
}
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** query → 归一过滤对象（审计留痕里记的就是它） */
export function parseFilters(query = {}) {
  const f = {}
  for (const k of ['module', 'action', 'entity', 'entity_id', 'user', 'keyword']) {
    const v = str(query[k])
    if (v) f[k] = v
  }
  for (const k of ['from', 'to']) {
    const v = str(query[k], 10)
    if (!v) continue
    if (!validDate(v)) throw new AuditViewError(`${k} 必须是 YYYY-MM-DD 日期`)
    f[k] = v
  }
  if (f.from && f.to && f.from > f.to) throw new AuditViewError('from 不能晚于 to')
  return f
}

/** 过滤 → { where, args }（列表与导出共用） */
export function buildWhere(f) {
  const c = []
  const a = []
  if (f.module) { c.push('module = ?'); a.push(f.module) }
  if (f.action) { c.push('action = ?'); a.push(f.action) }
  if (f.entity) { c.push('entity = ?'); a.push(f.entity) }
  if (f.entity_id) { c.push('entity_id = ?'); a.push(f.entity_id) }
  if (f.user) {
    if (/^\d{1,12}$/.test(f.user)) { c.push('(user_id = ? OR user_name = ?)'); a.push(Number(f.user), f.user) }
    else { c.push("user_name LIKE ? ESCAPE '\\'"); a.push(`%${likeEsc(f.user)}%`) }
  }
  if (f.from) { c.push('created_at >= ?'); a.push(`${f.from} 00:00:00`) }
  if (f.to) { c.push('created_at <= ?'); a.push(`${f.to} 23:59:59`) }
  if (f.keyword) {
    const p = `%${likeEsc(f.keyword)}%`
    // 不搜 detail：旧行的明细可能带明文，按原文匹配会成为读取侧脱敏之外的"侧信道"（Codex 复核 P1）
    c.push("(action LIKE ? ESCAPE '\\' OR module LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR entity_id LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')")
    a.push(p, p, p, p, p)
  }
  return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', args: a }
}

const FREE_SECRET = /((?:password|passwd|secret|token|authorization|cookie|jwt|api[_-]?key)\s*[:：=]\s*)(?:Bearer\s+)?[^\s,;"'}&]+/gi
const FREE_PHONE = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g
/** 字符串叶子的补充脱敏：自由文本里的 `password: x` 与 11 位手机号（redact.js 只管键名与 k=v） */
const scrub = (t) => t.replace(FREE_SECRET, '$1[REDACTED]').replace(FREE_PHONE, '$1****$2')
function scrubDeep(v, depth = 0) {
  if (typeof v === 'string') return scrub(v)
  if (depth > 8 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, depth + 1)]))
}

/** 读取侧脱敏：JSON 走结构脱敏，其余走文本脱敏；超长截断 */
export function redactDetail(detail) {
  if (detail === null || detail === undefined) return null
  let out
  try {
    const parsed = JSON.parse(detail)
    out = parsed !== null && typeof parsed === 'object' ? JSON.stringify(scrubDeep(redactValue(parsed))) : scrub(redactText(String(detail)))
  } catch {
    out = scrub(redactText(String(detail)))
  }
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX)}…[truncated]` : out
}

export function viewRow(r) {
  return { id: r.id, user_id: r.user_id, user_name: r.user_name, action: r.action, module: r.module, entity: r.entity, entity_id: r.entity_id, detail: redactDetail(r.detail), ip: r.ip, created_at: r.created_at }
}

const FORMULA_LEAD = /^(?:[\t\r\n]|[\s\u0000-\u001f]*[=+\-@＝＋－＠])/

/** 单元格：恒加引号，公式前缀前置 `'`，内部引号加倍 */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v)
  if (s.length > CSV_CELL_MAX) s = `${s.slice(0, CSV_CELL_MAX)}…`
  if (FORMULA_LEAD.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export const CSV_HEADER = ['id', 'created_at', 'user_id', 'user_name', 'module', 'action', 'entity', 'entity_id', 'detail', 'ip']
export const csvLine = (r) => `${CSV_HEADER.map((k) => csvCell(r[k])).join(',')}\r\n`
