/**
 * ============================================================================
 * 文件标识：server/lib/audit-trail.js ｜ `audit_logs` 的**唯一 INSERT 点**：明细归一与脱敏、普通写入、以及事务内"写不进就抛"的严格写入
 * ============================================================================
 * 【职责】
 *   · `insertAuditRow(db,row)`：一条 INSERT。明细在这里统一序列化并脱敏（凭据键遮盖、手机号部分遮盖）。
 *   · `auditStrictRow(db,row)`：**必须在事务内**调用；写不进（抛错 / RAISE(IGNORE) 导致 0 行）即抛
 *     `SECURITY_AUDIT_UNAVAILABLE`（503），让包着它的业务事务一起回滚。
 *
 * 【哈希链（ADR-0049，迁移 068）】`audit_logs` 有 `prev_hash` / `row_hash` 两列时，`insertAuditRow` 在**同一条 INSERT** 里写入
 *   `row_hash = sha256(规范化(id, created_at, user_id, action, entity, entity_id, detail, prev_hash))`（见 db/migrations/_audit_chain.cjs），
 *   `prev_hash` 取前一行的 `row_hash`（库里没有前驱行 ⇒ 64 个 0）。并发：见 `chainedInsert` 的注释（写锁内读尾、读后立刻写）。
 *   本文件另给两个**受控改链**入口：`deleteAuditRowsAnchored`（保留清理 / 归档删行，登记锚点）与 `rehashAuditRow`（隐私抹除改 detail 后重算）。
 *
 * 【为什么单独成文件】`middleware/audit.js`（请求级 `audit` / `auditStrict`）与 `lib/account-security.js`
 *   （账号安全变更）原来各写一份 INSERT，脱敏与"0 行也算失败"的判据只能在一处 —— 就是这里。
 *   本文件不 import 数据库上下文，纯函数接 `db`，便于直接用内存库测试。
 *
 * 【注意】`auditStrictRow` 不在事务里会抛 `AUDIT_OUTSIDE_TX`（500）：这是编码错误，不是运行时不可用，
 *   与 `lib/settings.js` 的 `logSettingChange` 同一条口径。普通 `insertAuditRow` 不要求事务。
 * ============================================================================
 */

import { createRequire } from 'node:module'
import { redactValue } from './redact.js'
import { incCounter } from './process-counters.js'

const { GENESIS, hashRow, adoptOrphans } = createRequire(import.meta.url)('../db/migrations/_audit_chain.cjs')
export { GENESIS }

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

const hasChainColumns = (() => {
  const known = new WeakSet() // 只缓存"有"：迁移 068 之前的库（单测里的最小表）每次重查，迁移后即转为缓存命中
  return (db) => {
    if (known.has(db)) return true
    const cols = db.prepare('PRAGMA table_info(audit_logs)').all()
    const ok = cols.some((c) => c.name === 'row_hash') && cols.some((c) => c.name === 'prev_hash')
    if (ok) known.add(db)
    return ok
  }
})()

const NEXT_SLOT = `SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_logs'),0) + 1 AS id,
                          datetime('now','localtime') AS created_at,
                          (SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1) AS tail_id,
                          (SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1) AS tail_hash`
const INSERT_CHAINED = `INSERT INTO audit_logs (id, user_id, user_name, action, module, entity, entity_id, detail, ip, created_at, prev_hash, row_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
const READ_BACK = 'SELECT id, created_at, user_id, action, entity, entity_id, detail FROM audit_logs WHERE id=?'

/**
 * 链式写入。并发口径（ADR-0049 §2）：
 *   · 不在事务里 ⇒ 自己开 `BEGIN IMMEDIATE`：先拿写锁，再读"下一个 id / 时间 / 尾哈希"，再写，读与写之间没有别的写者能插进来。
 *   · 已在调用方事务里 ⇒ 不再嵌套，沿用外层事务的锁语义（单条 INSERT 本身原子）：外层若是 IMMEDIATE（`withWriteRetry`），读已在写锁内；
 *     外层若是 DEFERRED，则读尾哈希时可能已取得过读快照，别的连接在此之后提交了新审计行，则这里的 INSERT 升级写锁会得到
 *     `SQLITE_BUSY_SNAPSHOT` ——**写失败而不是链分叉**（宁可失败，不留一条 prev_hash 指向过期尾部的行）。
 *   · id 与 created_at 由本函数在写锁内定好再一起 INSERT（id = sqlite_sequence.seq + 1，与 AUTOINCREMENT 自己会分的值一致），
 *     所以不需要"先 INSERT 再 UPDATE 填哈希"：没有半截状态，也不会触发 audit_logs 上任何 AFTER UPDATE 触发器。
 *   · BEFORE INSERT 触发器用 RAISE(IGNORE) 吞掉写入（0 行）⇒ 原样返回 changes=0，由 `auditStrictRow` 判失败。
 */
const stmtCache = new WeakMap() // db → 预编译语句：每次写审计都重新 prepare 是写路径上最大的开销
function stmts(db) {
  let c = stmtCache.get(db)
  if (!c) {
    c = { slot: db.prepare(NEXT_SLOT), insert: db.prepare(INSERT_CHAINED), back: db.prepare(READ_BACK), fix: db.prepare('UPDATE audit_logs SET row_hash=? WHERE id=?') }
    stmtCache.set(db, c)
  }
  return c
}

function chainedInsert(db, row, options) {
  const { slot: slotStmt, insert, back, fix } = stmts(db)
  const run = () => {
    let slot = slotStmt.get()
    // 表尾有绕过本函数的裸 INSERT（row_hash 为空）：先把尾部孤儿接上链再追加，否则新行的 prev_hash 无处可指（审计 AB6）
    if (slot.tail_id !== null && slot.tail_hash === null) { adoptOrphans(db); slot = slotStmt.get() }
    const v = bind(row, options)
    const stored = {
      id: slot.id, created_at: slot.created_at, user_id: v[0], action: v[2], entity: v[4], entity_id: v[5], detail: v[6]
    }
    const prev = slot.tail_hash ?? GENESIS
    const rowHash = hashRow(stored, prev)
    const info = insert.run(slot.id, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], slot.created_at, prev, rowHash)
    if (info.changes === 1) {
      // 列亲和性会改写存入值（'005' → 5 之类）：以**读回的存储值**为准，与校验器同一口径；绝大多数行读回后哈希不变，这里不写
      const exact = hashRow(back.get(slot.id), prev)
      if (exact !== rowHash) fix.run(exact, slot.id)
    }
    return info
  }
  // 已在事务里：整个函数只有一条 INSERT 会写库，语句本身是原子的（失败不留半截），不需要再开 SAVEPOINT。
  if (db.inTransaction) return run()
  db.exec('BEGIN IMMEDIATE')
  try {
    const info = run()
    db.exec('COMMIT')
    return info
  } catch (e) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw e
  }
}

/** 普通写入：返回 better-sqlite3 的 run 结果；失败直接抛给调用方决定（`audit()` 会重试一次去掉明细） */
export function insertAuditRow(db, row, options) {
  if (hasChainColumns(db)) return chainedInsert(db, row, options)
  return db.prepare(INSERT).run(...bind(row, options))
}

/**
 * 受控删行（保留清理 / 归档）：删除 `WHERE ${where}` 命中的行，并给"紧跟在被删区间之后的存活行"登记锚点
 * （`audit_chain_anchors`：at_row_id = 该行 id，anchor_hash = 该行的 prev_hash），校验器据此承认这处合法断口。
 * 必须在调用方事务内。返回删除行数。库没有哈希链列（068 之前）⇒ 退化为普通 DELETE。
 */
export function deleteAuditRowsAnchored(db, where, params, { kind, reason } = {}) {
  if (!db.inTransaction) throw fault(AUDIT_OUTSIDE_TX, '受控删除审计行必须在事务内（锚点与删除要一起提交）', 500)
  if (!hasChainColumns(db)) return db.prepare(`DELETE FROM audit_logs WHERE ${where}`).run(...params).changes
  // better-sqlite3 在 iterate() 期间不许执行别的语句：先收集锚点（数量 = 被删区间数，很小），遍历完再写
  const found = []
  let prevDeleted = false
  let survivor = null // 最近一条存活行 = 下一个锚点要绑定的前驱
  for (const r of db.prepare(`SELECT id, prev_hash, row_hash, (${where}) AS del FROM audit_logs ORDER BY id`).iterate(...params)) {
    if (r.del) { prevDeleted = true; continue }
    if (prevDeleted && r.prev_hash) found.push([r.id, r.prev_hash, survivor?.id ?? null, survivor?.row_hash ?? null])
    prevDeleted = false
    survivor = r
  }
  const anchor = db.prepare('INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES (?,?,?,?,?,?)')
  for (const [id, hash, pid, phash] of found) anchor.run(kind || 'delete', id, hash, pid, phash, reason ?? null)
  return db.prepare(`DELETE FROM audit_logs WHERE ${where}`).run(...params).changes
}

/**
 * 受控改行（隐私抹除改写 detail 之后）：按当前列值重算该行 row_hash，并给下一行登记锚点（它的 prev_hash 仍指向旧哈希）。
 * 必须在调用方事务内。返回是否改动。
 */
export function rehashAuditRow(db, id, { kind = 'rewrite', reason } = {}) {
  if (!db.inTransaction) throw fault(AUDIT_OUTSIDE_TX, '受控改写审计行必须在事务内', 500)
  if (!hasChainColumns(db)) return false
  const r = db.prepare('SELECT id, created_at, user_id, action, entity, entity_id, detail, prev_hash, row_hash FROM audit_logs WHERE id=?').get(id)
  if (!r?.row_hash) return false
  const next = hashRow(r, r.prev_hash)
  if (next === r.row_hash) return false
  db.prepare('UPDATE audit_logs SET row_hash=? WHERE id=?').run(next, id)
  // 下一行的 prev_hash 仍指向旧哈希：给它登记锚点，绑定"前驱 = 本行（新哈希）"。同一行被改写多次时每次追加一条（旧锚点绑的是旧哈希，不再匹配）
  const following = db.prepare('SELECT id, prev_hash FROM audit_logs WHERE id > ? ORDER BY id LIMIT 1').get(id)
  if (following && following.prev_hash !== next) {
    const dup = db.prepare('SELECT 1 FROM audit_chain_anchors WHERE at_row_id=? AND anchor_hash=? AND prev_id=? AND prev_row_hash=?').get(following.id, following.prev_hash, id, next)
    if (!dup) {
      db.prepare('INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES (?,?,?,?,?,?)')
        .run(kind, following.id, following.prev_hash, id, next, reason ?? null)
    }
  }
  return true
}

/**
 * 严格写入：事务内调用；任何失败（抛错或 0 行）都抛 503 `SECURITY_AUDIT_UNAVAILABLE`，
 * 由外层 `db.transaction` 回滚业务写入。不做"去掉明细再试"：安全相关动作的明细本身就是证据。
 */
export function auditStrictRow(db, row) {
  if (!db.inTransaction) {
    incCounter('audit_strict_write_failures_total', 'outside_tx')
    throw fault(AUDIT_OUTSIDE_TX, `严格审计「${row?.action}」必须在事务内写入，否则审计失败不能回滚业务变更`, 500)
  }
  let changes = 0
  try {
    changes = insertAuditRow(db, row).changes
  } catch {
    incCounter('audit_strict_write_failures_total', 'insert_error')
    incCounter('security_audit_unavailable_total')
    throw fault(SECURITY_AUDIT_UNAVAILABLE, '安全审计暂不可用，变更未提交', 503)
  }
  if (changes !== 1) {
    incCounter('audit_strict_write_failures_total', 'no_row')
    incCounter('security_audit_unavailable_total')
    throw fault(SECURITY_AUDIT_UNAVAILABLE, '安全审计暂不可用，变更未提交', 503)
  }
  return changes
}
