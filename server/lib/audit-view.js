/**
 * ============================================================================
 * 文件标识：server/lib/audit-view.js ｜ 审计日志查看器的查询与 CSV 编码（Z7 / roadmap-v5 Z7）
 * ============================================================================
 * 【职责】把 `GET /api/meta/audit-logs` 与导出共用的过滤条件、读取侧二次脱敏、CSV 单元格编码放在一处。
 * 【口径】
 *   · 过滤只有一份实现（`buildWhere`），列表与导出不会各自漂移；
 *   · `detail` 读出时再过一遍 `redact.js`（写入侧已脱敏，但旧行 / 直接写库的行不保证）；
 *   · CSV 每个单元格都加引号；以 `= + - @ Tab CR`（含全角形态，允许前导空白）开头的值前置 `'`，防电子表格公式注入；
 *   · 导出有行数上限（`AUDIT_EXPORT_MAX_ROWS`），超出截断并在审计里记 truncated；
 *   · （AA6）列表总数是"最多 10,001"的封顶估算（`countCapped`）+ `has_more`，不再对百万行做整表 COUNT；翻页深度同样封顶；
 *   · （AA6）关键词只搜 action / entity / user_name 且至少 2 个有效字符（`assertKeyword`，buildWhere 内也强制，绕不过）；
 *   · （AB3）迁移 067 的 FTS5 外部内容表 `audit_logs_fts`（trigram）可用、关键词 ≥3 字符且命中稀少（≤ FTS_RARE_MAX）时关键词走 FTS，否则（无 FTS5 构建 / 2 字关键词 / 命中很多）走 LIKE；
 *     仅按 action 过滤必须带 module（`AUDIT_ACTION_NEEDS_MODULE`，400）。
 *   · （AA6）排序随过滤选择：命中 module / user_id 索引（末列 created_at）时按 `created_at DESC, id DESC`，索引直接给出顺序、无排序临时表；
 *     其余按 `id DESC`（rowid 倒扫）。导出的游标与列表排序同一份（`orderOf` / `exportChunks`）。
 * ============================================================================
 */
import { redactValue, redactText } from './redact.js'
import { readSetting } from './settings.js'

export const AUDIT_EXPORT_MAX_ROWS = 50000
export const AUDIT_PAGE_MAX = 200
/** 列表总数封顶：数到 CAP+1 即停（COUNT 的上界是 10,001 行，与表大小无关）；翻页深度也不超过 CAP */
export const AUDIT_COUNT_CAP = 10000
export const KEYWORD_MIN_CHARS = 2
const DETAIL_MAX = 8000
const CSV_CELL_MAX = 32000

export class AuditViewError extends Error {
  constructor(message, code = 'AUDIT_VIEW_BAD_FILTER') { super(message); this.status = 400; this.code = code }
}
/** 仅按 action 过滤（不带 module）既无可用索引、命中面又大：必须同时给 module（走 (module, created_at)） */
export const AUDIT_ACTION_NEEDS_MODULE = 'AUDIT_ACTION_NEEDS_MODULE'

/** FTS5 关键词检索的最小字符数（trigram 分词器的下限）；更短的关键词（2 字）走 LIKE */
export const KEYWORD_FTS_MIN_CHARS = 3
export const FTS_TABLE = 'audit_logs_fts'
let ftsOverride = null
/** 测试钩子：false = 模拟没有 FTS5 的构建（强制 LIKE 回退）；null = 按库里是否有 audit_logs_fts 判断 */
export function setFtsOverride(v) { ftsOverride = v }
/**
 * 环境开关（AC5）：`GML_AUDIT_FTS=0`（恰好是字符串 "0"）强制所有关键词检索走 LIKE，`keywordUsesFts` 恒为 false。
 * 每次调用时读 `process.env`（不缓存），所以测试可以按用例设置；其它取值（未设、空串、"1"、"false"）都**不**关闭 FTS，避免拼写错误悄悄改变行为。
 * 只影响查询路径：迁移 067 照常建表与触发器，`scripts/audit-fts-maintain.mjs` 照常维护索引。用途是在带 FTS5 的构建上真实演练无 FTS 回退（CI 以此再跑一遍视图测试）。
 */
export const ftsEnvDisabled = () => process.env.GML_AUDIT_FTS === '0'
/** 这个库能不能走 FTS：迁移 067 建了 `audit_logs_fts`（没有 FTS5 的构建上迁移是空操作，表不存在 → 回退 LIKE） */
export function ftsAvailable(db) {
  if (ftsOverride === false || ftsEnvDisabled()) return false
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(FTS_TABLE) } catch { return false }
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

/** 有效字符数：去掉空白 / 控制符 / 零宽等格式符后的码点数（防 "a" + 零宽字符 凑够 2 个） */
const effectiveLen = (s) => [...s.replace(/[\s\p{Cc}\p{Cf}]/gu, '')].length

/** 关键词至少 KEYWORD_MIN_CHARS 个有效字符（太短的 LIKE '%x%' 命中面过大，且是整表扫描） */
export function assertKeyword(keyword) {
  // 控制符（尤其 NUL）直接拒绝：SQLite 的 LIKE 模式遇到 NUL 会被截断，'%\0ab%' 退化成 '%' = 匹配全部（Codex 复核）
  if (/\p{Cc}/u.test(String(keyword))) throw new AuditViewError('keyword 不能包含控制字符')
  if (effectiveLen(String(keyword)) < KEYWORD_MIN_CHARS) throw new AuditViewError(`keyword 至少需要 ${KEYWORD_MIN_CHARS} 个字符`)
}

/** query → 归一过滤对象（审计留痕里记的就是它） */
export function parseFilters(query = {}) {
  const f = {}
  for (const k of ['module', 'action', 'entity', 'entity_id', 'user', 'keyword']) {
    const v = str(query[k])
    if (v) f[k] = v
  }
  if (f.keyword !== undefined) assertKeyword(f.keyword)
  if (f.action && !f.module) throw new AuditViewError('按动作过滤必须同时指定模块（module）', AUDIT_ACTION_NEEDS_MODULE)
  for (const k of ['from', 'to']) {
    const v = str(query[k], 10)
    if (!v) continue
    if (!validDate(v)) throw new AuditViewError(`${k} 必须是 YYYY-MM-DD 日期`)
    f[k] = v
  }
  if (f.from && f.to && f.from > f.to) throw new AuditViewError('from 不能晚于 to')
  return f
}

/**
 * FTS 状态读数（AE11，只读）：设置值 `audit_fts_enabled`、库里索引表是否存在、环境开关是否强制关闭，以及"关键词查询实际可不可能走索引"。
 * `active` 与查询路径同一判据（`ftsAvailable`：有索引表且未被环境开关 / 测试钩子关掉），**不看设置值**：改设置本身不动索引，
 * 设置关而索引表还在 = 查询仍会走索引，直到维护脚本或重启收敛——这种不一致由前端据 setting_enabled 与 index_present 如实呈现。
 * `active` 为真也只表示**能**走索引；是否真走还取决于关键词长度与命中数（见 `keywordUsesFts`）。
 */
export function ftsState(db) {
  let setting = true
  try { setting = Boolean(readSetting(db, 'audit_fts_enabled')) } catch { /* 读不到按默认开启展示 */ }
  let present = false
  try { present = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(FTS_TABLE) } catch { /* 无表 */ }
  const envOff = ftsEnvDisabled()
  return { setting_enabled: setting, index_present: present, env_disabled: envOff, active: present && !envOff && ftsOverride !== false }
}

/**
 * 本次关键词要不要走 FTS：库里有 audit_logs_fts、关键词 ≥3 字符，且命中**稀少**（探测最多读 FTS_RARE_MAX+1 个命中）。
 * 命中很多时 FTS 反而慢（要物化全部命中 rowid 再去探 audit_logs；1M 行实测常见词 0.2 ms → 22 ms，与 module 组合时 0.09 → 144 ms），
 * 而 LIKE 沿索引/rowid 倒扫很快凑够一页；命中稀少时 FTS 把整表扫描（190–240 ms）变成亚毫秒。两条路径结果完全相同，只是读量不同。
 */
export const FTS_RARE_MAX = 2000
export function keywordUsesFts(db, keyword) {
  if (keyword === undefined || [...String(keyword)].length < KEYWORD_FTS_MIN_CHARS || !ftsAvailable(db)) return false
  try {
    return db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? LIMIT ?)`).get(ftsPhrase(keyword), FTS_RARE_MAX + 1).c <= FTS_RARE_MAX
  } catch { return false } // 索引损坏 / 不可用：回退 LIKE，结果不变
}

/** FTS5 短语：整个关键词当作一个带引号的短语（内部 `"` 加倍），AND / OR / NEAR / 通配星号 / 列过滤等语法一律成为字面文本 */
export const ftsPhrase = (kw) => `"${String(kw).replace(/"/g, '""')}"`
export const useFtsFor = (keyword, fts) => !!fts && [...String(keyword)].length >= KEYWORD_FTS_MIN_CHARS

/** 过滤 → { where, args }（列表与导出共用）。opts.fts（由 keywordUsesFts 决定）：true 且关键词 ≥3 字符时走 FTS，否则 LIKE */
export function buildWhere(f, { fts = false } = {}) {
  const c = []
  const a = []
  if (f.action && !f.module) throw new AuditViewError('按动作过滤必须同时指定模块（module）', AUDIT_ACTION_NEEDS_MODULE)
  if (f.module) { c.push('module = ?'); a.push(f.module) }
  if (f.action) { c.push('action = ?'); a.push(f.action) }
  // 仅按 entity（无 entity_id）时用 `+entity` 屏蔽 idx_audit_entity：entity 类型只有几十种、每种命中很多行，
  // 走索引要对全部命中行临时排序（Codex 复核实测 100k 行 0.15 ms → 48 ms）；不走索引则沿 rowid 倒扫，凑够一页即停。带 entity_id 时选择性高，走索引。
  if (f.entity) { c.push(f.entity_id ? 'entity = ?' : '+entity = ?'); a.push(f.entity) }
  if (f.entity_id) { c.push('entity_id = ?'); a.push(f.entity_id) }
  if (f.user) {
    // 纯数字 = 用户 ID（走 idx_audit_user_created）；不再 OR user_name（OR 会让该索引失效、退化为整表扫描）
    if (/^\d{1,12}$/.test(f.user)) { c.push('user_id = ?'); a.push(Number(f.user)) }
    else { c.push("user_name LIKE ? ESCAPE '\\'"); a.push(`%${likeEsc(f.user)}%`) }
  }
  if (f.from) { c.push('created_at >= ?'); a.push(`${f.from} 00:00:00`) }
  if (f.to) { c.push('created_at <= ?'); a.push(`${f.to} 23:59:59`) }
  if (f.keyword !== undefined) {
    assertKeyword(f.keyword)
    // 只搜 action / entity / user_name。不搜 detail：旧行的明细可能带明文，按原文匹配会成为读取侧脱敏之外的"侧信道"（Codex 复核 P1）；
    // 也不搜 module / entity_id（它们有精确过滤项，子串匹配只会扩大扫描面）
    if (useFtsFor(f.keyword, fts)) {
      // FTS 外部内容表只索引这三列（detail 不在其中，侧信道结论同上）；trigram 的子串语义与 LIKE 一致
      // FTS 只负责缩小候选集：trigram 是 Unicode 大小写不敏感，而 LIKE 只折叠 ASCII（Ä/ä 在 LIKE 下不相等），
      // 所以候选行再过一遍同一个 LIKE 谓词，保证两条路径的结果逐行相同（候选集 ⊇ LIKE 命中集，不会漏）
      const p = `%${likeEsc(f.keyword)}%`
      c.push(`id IN (SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?)`)
      c.push("(action LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')")
      a.push(ftsPhrase(f.keyword), p, p, p)
    } else {
      const p = `%${likeEsc(f.keyword)}%`
      c.push("(action LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')")
      a.push(p, p, p)
    }
  }
  return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', args: a }
}

/** 排序：module / user_id 过滤（索引末列 created_at）→ created_at DESC, id DESC；有 entity+entity_id 时让位给 idx_audit_entity（rowid 序）；其余 id DESC */
export function orderOf(f) {
  const userIsId = f.user && /^\d{1,12}$/.test(f.user)
  const byTime = !!(f.module || userIsId) && !(f.entity && f.entity_id)
  return { byTime, sql: byTime ? 'created_at DESC, id DESC' : 'id DESC' }
}

export const countSql = (where) => `SELECT COUNT(*) c FROM (SELECT 1 FROM audit_logs ${where} LIMIT ?)`

/** 封顶计数：最多数到 CAP+1 行。返回 { total (≤CAP+1), has_more (total>CAP) }；has_more 时 total 只是下界 */
export function countCapped(db, where, args) {
  const total = db.prepare(countSql(where)).get(...args, AUDIT_COUNT_CAP + 1).c
  return { total, has_more: total > AUDIT_COUNT_CAP }
}

/** 导出分批的两条语句（首批 / 带游标的后续批）；scripts/explain-audit.mjs 用同一份文本审计计划 */
export function exportSql(where, order) {
  const base = where ? `${where} AND id <= ?` : 'WHERE id <= ?'
  return {
    first: `SELECT * FROM audit_logs ${base} ORDER BY ${order.sql} LIMIT ?`,
    next: `SELECT * FROM audit_logs ${base} AND ${order.byTime ? '(created_at, id) < (?, ?)' : 'id < ?'} ORDER BY ${order.sql} LIMIT ?`
  }
}

/** 导出分批（游标与 orderOf 同序；snapshotMax 之后的新行不进文件）。同步生成器：每批 ≤ batch 行的 CSV 文本 */
export function* exportChunks(db, { where, args, order, snapshotMax, exported, batch = 1000 }) {
  const sql = exportSql(where, order)
  const first = db.prepare(sql.first)
  const next = db.prepare(sql.next)
  let last = null
  let sent = 0
  while (sent < exported) {
    const n = Math.min(batch, exported - sent)
    const rows = last === null
      ? first.all(...args, snapshotMax, n)
      : next.all(...args, snapshotMax, ...(order.byTime ? [last.created_at, last.id] : [last.id]), n)
    if (!rows.length) return
    let chunk = ''
    for (const row of rows) chunk += csvLine(viewRow(row))
    last = rows[rows.length - 1]
    sent += rows.length
    yield chunk
  }
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
