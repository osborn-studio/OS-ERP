'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/067_audit_fts.cjs ｜ 审计日志关键词检索：FTS5 外部内容表 + 触发器（roadmap-v7 AB3）
 * ============================================================================
 * 【职责】AA6 的关键词检索是 `LIKE '%x%'` 子串匹配（action / entity / user_name），命中稀少时读全表。本迁移建
 *   `audit_logs_fts`：FTS5 **外部内容**虚拟表（content='audit_logs'，不复制正文，只存倒排索引），tokenizer = trigram
 *   （子串语义与 LIKE 一致，含中文；查询词至少 3 个字符，2 个字符的关键词由 `audit-view.js` 走 LIKE）。
 *   由 `audit_logs` 上的三个触发器维护：AFTER INSERT / AFTER DELETE / AFTER UPDATE OF (id, action, entity, user_name)。
 *
 * 【没有 FTS5 的构建】`PRAGMA compile_options` 不含 ENABLE_FTS5（或 trigram 分词器不可用）时，本迁移**什么都不建**，
 *   照常被登记为已执行；`verify()` 同样返回 true（否则 runner 每次启动都会"自愈重跑"）。`audit-view.js` 查不到
 *   `audit_logs_fts` 就走原 LIKE 路径；`scripts/explain-audit.mjs` 为该回退路径登记了带理由的豁免。
 *
 * 【触发器与其他列】触发器只引用 id / action / entity / user_name，且 UPDATE 触发器限定 `OF id, action, entity, user_name`（id 是外部内容的 rowid，改 id 也要重建该行的索引项）：
 *   AB6（迁移 068）给 audit_logs 增 prev_hash / row_hash 后，对这些列的写入不会触发 FTS 维护，也不会让触发器失效。
 *   `audit_logs` 的 INSERT 点仍只有 `insertAuditRow`；触发器在同一事务内同步更新索引。
 *
 * 【迁移安全】全部 IF NOT EXISTS；表缺失则跳过；首次建表（或发现触发器缺失）时 `rebuild` 回填存量行——大库上持写锁，
 *   耗时见 capacity-baseline。已执行迁移不改（ADR-0009）；`verify()` 查表与三触发器都在，缺了由 runner 重跑 `up`。
 * 【注意】库在带 FTS5 的构建上迁移后，不要拿到不带 FTS5 的 SQLite 上写入：触发器引用的虚拟表打不开会让 INSERT 失败。
 * ============================================================================
 */
const { tableExists } = require('./_helpers.cjs')

module.exports.name = '审计日志关键词检索（FTS5 外部内容表 + 触发器）'

const FTS = 'audit_logs_fts'
const TRIGGERS = {
  audit_logs_fts_ai: `CREATE TRIGGER IF NOT EXISTS audit_logs_fts_ai AFTER INSERT ON audit_logs BEGIN
    INSERT INTO ${FTS}(rowid, action, entity, user_name) VALUES (new.id, new.action, new.entity, new.user_name);
  END`,
  audit_logs_fts_ad: `CREATE TRIGGER IF NOT EXISTS audit_logs_fts_ad AFTER DELETE ON audit_logs BEGIN
    INSERT INTO ${FTS}(${FTS}, rowid, action, entity, user_name) VALUES ('delete', old.id, old.action, old.entity, old.user_name);
  END`,
  audit_logs_fts_au: `CREATE TRIGGER IF NOT EXISTS audit_logs_fts_au AFTER UPDATE OF id, action, entity, user_name ON audit_logs BEGIN
    INSERT INTO ${FTS}(${FTS}, rowid, action, entity, user_name) VALUES ('delete', old.id, old.action, old.entity, old.user_name);
    INSERT INTO ${FTS}(rowid, action, entity, user_name) VALUES (new.id, new.action, new.entity, new.user_name);
  END`
}
module.exports.TRIGGERS = Object.keys(TRIGGERS)
module.exports.FTS_TABLE = FTS

/** 本构建能否建 FTS5 + trigram：编译选项含 ENABLE_FTS5，且真能建一张临时 trigram 表（SQLite < 3.34 没有 trigram） */
function ftsSupported(db) {
  let opts
  try { opts = db.pragma('compile_options').map((r) => r.compile_options) } catch { return false }
  if (!opts.includes('ENABLE_FTS5')) return false
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__audit_fts_probe USING fts5(x, tokenize='trigram')")
    db.exec('DROP TABLE temp.__audit_fts_probe')
    return true
  } catch { return false }
}
module.exports.ftsSupported = ftsSupported

const exists = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name)

module.exports.up = (db) => {
  if (!ftsSupported(db)) return
  if (!tableExists(db, 'audit_logs')) return
  let rebuild = false
  if (!exists(db, 'table', FTS)) {
    db.exec(`CREATE VIRTUAL TABLE ${FTS} USING fts5(action, entity, user_name, content='audit_logs', content_rowid='id', tokenize='trigram')`)
    rebuild = true
  }
  for (const [name, sql] of Object.entries(TRIGGERS)) {
    if (!exists(db, 'trigger', name)) { db.exec(sql); rebuild = true }
  }
  // 回填存量行（或触发器缺失期间漏掉的行）：外部内容表的 rebuild 从 audit_logs 重新读出全部行
  if (rebuild) db.exec(`INSERT INTO ${FTS}(${FTS}) VALUES ('rebuild')`)
}

module.exports.verify = (db) => {
  if (!ftsSupported(db) || !tableExists(db, 'audit_logs')) return true
  return exists(db, 'table', FTS) && Object.keys(TRIGGERS).every((n) => exists(db, 'trigger', n))
}
