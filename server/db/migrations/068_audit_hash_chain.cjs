'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/068_audit_hash_chain.cjs ｜ 审计日志防篡改哈希链（roadmap-v7 AB6，ADR-0049）
 * ============================================================================
 * 【职责】给 `audit_logs` 加 `prev_hash` / `row_hash` 两列，建 `audit_chain_anchors` 锚点表，并把已有行按 id 升序回填成一条链：
 *     row_hash = sha256(规范化(id, created_at, user_id, action, entity, entity_id, detail, prev_hash))，第一行 prev_hash = 64 个 0。
 *   规范化与哈希只有一份实现：`server/lib/audit-chain.cjs`（运行时写入、校验脚本与本迁移共用）。
 *
 * 【新建对象】
 *   · audit_logs.prev_hash / row_hash（TEXT，可空：已有行靠本迁移回填；之后的新行由 `insertAuditRow` 随 INSERT 一起写）。
 *   · audit_chain_anchors(id, kind, at_row_id, anchor_hash, reason, created_at)：受控删行（保留清理 / 归档）与受控改行（隐私抹除）
 *     留下的合法断口登记；校验器遇到 `prev_hash` 对不上、但 (at_row_id, anchor_hash) 在表里时放行。
 *   · idx_audit_unchained（部分索引，只含 row_hash IS NULL 的行）：`verify()` 判"是否还有未入链的行"不必扫全表；链健康时它是空的，
 *     不给每次追加增加写放大。
 *
 * 【幂等与自愈】up 可重复执行：加列 / 建表 / 建索引都是缺才建；回填只从**第一条 row_hash 为空的行**起向后重算到表尾
 *   （正常情况下是整表，自愈场景下是"孤儿行及其之后"）。`verify()` = 两列在、锚点表在、索引在、且没有 row_hash 为空的行；
 *   所以有人用裸 SQL 往 audit_logs 塞了未入链的行，下次启动会被自愈接上（并且校验脚本在那之前会如实报 `unchained`）。
 * 【大库耗时】回填 = 每行一次 SHA-256 + 一次 UPDATE，在迁移事务内按 20000 行一批走主键 keyset；100 万行实测见 capacity-baseline "AB6"。
 *   迁移持写锁直到完成。若 AB3 的 FTS 影子表触发器（迁移 067）已存在，回填的 UPDATE 会触发它们的 AFTER UPDATE（如有），只是更慢，不影响正确性。
 * 【改它要注意什么】已执行迁移不改（ADR-0009）；哈希格式改动 = 新迁移 + 重算全链。
 * ============================================================================
 */
const { tableExists, hasColumn, addColumn, hasIndex } = require('./_helpers.cjs')
const { GENESIS, hashRow } = require('../../lib/audit-chain.cjs')

module.exports.name = '审计日志哈希链（prev_hash/row_hash + 锚点表）'

const BATCH = 20000

function ensureObjects(db) {
  addColumn(db, 'audit_logs', 'prev_hash', 'TEXT')
  addColumn(db, 'audit_logs', 'row_hash', 'TEXT')
  db.exec(`CREATE TABLE IF NOT EXISTS audit_chain_anchors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    at_row_id   INTEGER NOT NULL,
    anchor_hash TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_anchor_row ON audit_chain_anchors(at_row_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_unchained ON audit_logs(id) WHERE row_hash IS NULL')
}

/** 从第一条未入链的行起，按 id 升序把到表尾的所有行重算一遍；返回处理行数 */
function backfill(db) {
  const first = db.prepare('SELECT MIN(id) AS id FROM audit_logs WHERE row_hash IS NULL').get().id
  if (first === null || first === undefined) return 0
  const before = db.prepare('SELECT row_hash FROM audit_logs WHERE id < ? ORDER BY id DESC LIMIT 1').get(first)
  let prev = before?.row_hash || GENESIS
  const page = db.prepare('SELECT id, created_at, user_id, action, entity, entity_id, detail FROM audit_logs WHERE id >= ? ORDER BY id LIMIT ?')
  const update = db.prepare('UPDATE audit_logs SET prev_hash=?, row_hash=? WHERE id=?')
  let cursor = first
  let n = 0
  for (;;) {
    const rows = page.all(cursor, BATCH)
    if (!rows.length) break
    for (const r of rows) {
      const h = hashRow(r, prev)
      update.run(prev, h, r.id)
      prev = h
      n += 1
    }
    cursor = rows[rows.length - 1].id + 1
  }
  return n
}

module.exports.up = (db) => {
  if (!tableExists(db, 'audit_logs')) return
  ensureObjects(db)
  backfill(db)
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'audit_logs')) return true
  return hasColumn(db, 'audit_logs', 'prev_hash') && hasColumn(db, 'audit_logs', 'row_hash') &&
    tableExists(db, 'audit_chain_anchors') && hasIndex(db, 'idx_audit_unchained') &&
    !db.prepare('SELECT 1 FROM audit_logs WHERE row_hash IS NULL LIMIT 1').get()
}
