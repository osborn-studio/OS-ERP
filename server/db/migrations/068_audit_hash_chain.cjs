'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/068_audit_hash_chain.cjs ｜ 审计日志防篡改哈希链（roadmap-v7 AB6，ADR-0049）
 * ============================================================================
 * 【职责】给 `audit_logs` 加 `prev_hash` / `row_hash` 两列，建 `audit_chain_anchors` 锚点表，并把已有行按 id 升序回填成一条链：
 *     row_hash = sha256(规范化(id, created_at, user_id, action, entity, entity_id, detail, prev_hash))，第一行 prev_hash = 64 个 0。
 *   规范化与哈希只有一份实现：`server/db/migrations/_audit_chain.cjs`（运行时写入、校验脚本与本迁移共用）。
 *
 * 【新建对象】
 *   · audit_logs.prev_hash / row_hash（TEXT，可空：已有行靠本迁移回填；之后的新行由 `insertAuditRow` 随 INSERT 一起写）。
 *   · audit_chain_anchors(id, kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason, created_at)：受控删行（保留清理 / 归档）
 *     与受控改行（隐私抹除）留下的合法断口登记；校验器遇到 `prev_hash` 对不上时，仅当同一行上有锚点同时绑定该行的 prev_hash
 *     **和实际前驱行（prev_id + prev_row_hash）**才放行。
 *   · idx_audit_unchained（部分索引，只含 row_hash IS NULL 的行）：`verify()` 判"是否还有未入链的行"不必扫全表；链健康时它是空的，
 *     不给每次追加增加写放大。
 *
 * 【幂等与自愈】up 可重复执行：加列 / 建表 / 建索引都是缺才建；回填 = `adoptOrphans`：只接**最后一条已入链行之后**的行
 *   （首次迁移 = 整表；之后 = 绕过 insertAuditRow 的裸 INSERT 留在表尾的孤儿行）。**夹在已入链行中间的空 row_hash 不会被重算**——
 *   那意味着已建立的链被破坏，自愈若把它重算成合法哈希就等于替篡改洗白；它留给 `audit-verify-chain` 报 `unchained`。
 *   `verify()` = 两列在、锚点表在、索引在、且尾部没有待接链的行。
 * 【大库耗时】回填 = 每行一次 SHA-256 + 一次 UPDATE，在迁移事务内按 20000 行一批走主键 keyset；100 万行实测见 capacity-baseline "AB6"。
 *   迁移持写锁直到完成。若 AB3 的 FTS 影子表触发器（迁移 067）已存在，回填的 UPDATE 会触发它们的 AFTER UPDATE（如有），只是更慢，不影响正确性。
 * 【改它要注意什么】已执行迁移不改（ADR-0009）；哈希格式改动 = 新迁移 + 重算全链。
 * ============================================================================
 */
const { tableExists, hasColumn, addColumn, hasIndex } = require('./_helpers.cjs')
const { adoptOrphans, hasOrphanTail } = require('./_audit_chain.cjs')

module.exports.name = '审计日志哈希链（prev_hash/row_hash + 锚点表）'

function ensureObjects(db) {
  addColumn(db, 'audit_logs', 'prev_hash', 'TEXT')
  addColumn(db, 'audit_logs', 'row_hash', 'TEXT')
  db.exec(`CREATE TABLE IF NOT EXISTS audit_chain_anchors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    at_row_id     INTEGER NOT NULL,
    anchor_hash   TEXT NOT NULL,
    prev_id       INTEGER,
    prev_row_hash TEXT,
    reason        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_anchor_row ON audit_chain_anchors(at_row_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_unchained ON audit_logs(id) WHERE row_hash IS NULL')
}

module.exports.up = (db) => {
  if (!tableExists(db, 'audit_logs')) return
  ensureObjects(db)
  adoptOrphans(db)
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'audit_logs')) return true
  return hasColumn(db, 'audit_logs', 'prev_hash') && hasColumn(db, 'audit_logs', 'row_hash') &&
    tableExists(db, 'audit_chain_anchors') && hasIndex(db, 'idx_audit_unchained') && !hasOrphanTail(db)
}
