/**
 * ============================================================================
 * 文件标识：server/lib/audit-chain-verify.js ｜ 审计哈希链校验器：顺序走一遍 `audit_logs`，报告第一个断点（ADR-0049）
 * ============================================================================
 * 【职责】`verifyChain(db, opts)`：按 id 升序、keyset 分批（不把 100 万行读进内存）逐行检查
 *   ① `row_hash` 非空；② 按当前列值重算的哈希等于 `row_hash`（内容被改 ⇒ `content`）；
 *   ③ `prev_hash` 等于前一行的 `row_hash`（中间行被删 / 插入 / 重排 ⇒ `link`），第一行应为 64 个 0。
 *   `link` 断口若在 `audit_chain_anchors` 里有同 id、同哈希的锚点（保留清理 / 归档 / 隐私抹除登记）则视为合法。
 *   遇到第一个断点即返回，不继续（后面的行全受连累，逐条报没有信息量）。
 *
 * 【只读】不写库。`opts.maxId`（含）限定只校验一段前缀（归档用）；`opts.expectTip` 与链尾哈希比对（发现"整段尾部被截掉"，
 *   单靠链本身看不出来 —— 见 ADR-0049「限制」）。
 * 【返回】{ ok, rows, firstId, lastId, tipHash, anchorsUsed, brk }，`brk` = { id, kind: 'unchained'|'content'|'link'|'tip', expected, actual }。
 * ============================================================================
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const { GENESIS, hashRow, anchorAccepts } = createRequire(import.meta.url)('../db/migrations/_audit_chain.cjs')

const BATCH = 20000
const COLS = 'id, created_at, user_id, action, entity, entity_id, detail, prev_hash, row_hash'

export function chainColumnsPresent(db) {
  const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name)
  return cols.includes('row_hash') && cols.includes('prev_hash')
}

export function verifyChain(db, opts = {}) {
  // 锚点与所有分批读取必须看同一个快照：否则校验途中提交的合法保留清理会让"看到删除、没看到锚点"误报断点。
  // 已在调用方事务里就沿用它的快照；否则自己开一个只读事务。
  if (db.inTransaction) return walk(db, opts)
  db.exec('BEGIN')
  try {
    return walk(db, opts)
  } finally {
    db.exec('ROLLBACK')
  }
}

function walk(db, { maxId = Number.MAX_SAFE_INTEGER, expectTip } = {}) {
  const anchors = new Map()
  const hasAnchors = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_chain_anchors'").get()
  if (hasAnchors) {
    for (const a of db.prepare('SELECT at_row_id, anchor_hash, prev_id, prev_row_hash FROM audit_chain_anchors').all()) {
      if (!anchors.has(a.at_row_id)) anchors.set(a.at_row_id, [])
      anchors.get(a.at_row_id).push(a)
    }
  }
  const page = db.prepare(`SELECT ${COLS} FROM audit_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`)
  const out = { ok: true, rows: 0, firstId: null, lastId: null, tipHash: null, anchorsUsed: 0, brk: null }
  let cursor = 0
  let prev = GENESIS
  let prevId = null
  for (;;) {
    const rows = page.all(cursor, maxId, BATCH)
    if (!rows.length) break
    for (const r of rows) {
      const fail = (kind, expected, actual) => { out.ok = false; out.brk = { id: r.id, kind, expected, actual }; return out }
      if (!r.row_hash) return fail('unchained', 'sha256 hex', null)
      const recomputed = hashRow(r, r.prev_hash)
      if (recomputed !== r.row_hash) return fail('content', recomputed, r.row_hash)
      if (r.prev_hash !== prev) {
        if (anchorAccepts(anchors.get(r.id), r, prevId, prevId === null ? null : prev)) out.anchorsUsed += 1
        else return fail('link', prev, r.prev_hash)
      }
      prev = r.row_hash
      prevId = r.id
      out.rows += 1
      out.firstId ??= r.id
      out.lastId = r.id
      out.tipHash = r.row_hash
    }
    cursor = rows[rows.length - 1].id
  }
  if (out.ok && expectTip && out.tipHash !== expectTip) {
    out.ok = false
    out.brk = { id: out.lastId, kind: 'tip', expected: expectTip, actual: out.tipHash }
  }
  return out
}

/**
 * 校验归档导出的 JSONL 段（归档脚本在删除前读回刚写出的文件再验一遍）：每行内容哈希自洽、相邻行 prev_hash 衔接。
 * 第一行的 prev_hash 不做要求（它指向更早已归档或已锚定的部分），原样返回给调用方写进摘要。段内被锚点承认的断口由调用方传入 `anchorList`（导出时一并写进摘要）。
 */
export function verifyJsonlSegment(file, anchorList = []) {
  const anchors = new Map()
  for (const a of anchorList) {
    if (!anchors.has(a.at_row_id)) anchors.set(a.at_row_id, [])
    anchors.get(a.at_row_id).push(a)
  }
  const out = { ok: true, rows: 0, firstId: null, lastId: null, firstPrevHash: null, tipHash: null, brk: null }
  let prev = null
  let prevId = null
  const checkLine = (line) => {
    if (!line) return true
    let r
    try { r = JSON.parse(line) } catch { out.ok = false; out.brk = { id: null, kind: 'parse' }; return false }
    const fail = (kind) => { out.ok = false; out.brk = { id: r.id, kind }; return false }
    if (hashRow(r, r.prev_hash) !== r.row_hash) return fail('content')
    if (prev !== null && r.prev_hash !== prev && !anchorAccepts(anchors.get(r.id), r, prevId, prev)) return fail('link')
    if (prev === null) out.firstPrevHash = r.prev_hash
    prev = r.row_hash
    prevId = r.id
    out.rows += 1
    out.firstId ??= r.id
    out.lastId = r.id
    out.tipHash = r.row_hash
    return true
  }
  // 分块读、按字节找换行：内存只与块大小和最长一行有关，百万行 / 数百 MB 的导出也能验（整文件读成字符串在 Node 上超过约 512 MB 会直接抛错）
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    let carry = Buffer.alloc(0)
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      let start = 0
      const data = n === chunk.length ? chunk : chunk.subarray(0, n)
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = carry.length ? Buffer.concat([carry, data.subarray(start, nl)]) : data.subarray(start, nl)
        carry = Buffer.alloc(0)
        if (!checkLine(line.toString('utf8'))) return out
        start = nl + 1
      }
      if (start < data.length) carry = Buffer.concat([carry, data.subarray(start)])
    }
    if (carry.length && !checkLine(carry.toString('utf8'))) return out
  } finally {
    fs.closeSync(fd)
  }
  return out
}
