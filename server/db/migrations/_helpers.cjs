'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/_helpers.cjs ｜ 模块 _helpers（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 _helpers（按文件名推断，待人工完善）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自文件名推断**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */


/** 表是否存在 */
function tableExists(db, table) {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table)
}

/** 列是否存在 */
function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((r) => r.name === column)
}

/** 幂等加列：缺列才加，返回是否新增（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS）
 *
 * 注意：表不存在时**必须报错**，不能静默跳过。
 * 曾经这里 return false 静默略过，导致「基础表还没建就跑迁移」时所有加列被吞掉，
 * 而迁移仍被记为已执行 —— 迁移状态与实际结构脱节，直到运行时才炸（food 库的真实事故）。
 */
function addColumn(db, table, column, decl) {
  if (!tableExists(db, table)) {
    throw new Error(
      `表 ${table} 不存在，无法添加列 ${column}；迁移顺序有误，应先执行基础建表（schema.sql）`
    )
  }
  if (hasColumn(db, table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  return true
}

/** 索引是否存在 */
function hasIndex(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name)
}

// ---------------------------------------------------------------------------
// 定义类迁移的「指纹」机制
//
// 起因：有一类迁移不建表、只灌「定义」（状态机、事务字典、库存参数、编码规则）。
// 这类迁移改定义时往往不违反任何结构不变量，于是 runner 的结构自检发现不了，
// 库里就一直是旧定义 —— 代码里加了流转边、库里没有，界面按钮就是不出现，
// 而这种错不会报错、只会「功能莫名少一个」，极难排查（本项目真实踩过）。
//
// 做法：迁移把定义序列化成 JSON 算 sha256 存进 schema_def_fingerprints；
//       自检时重新计算比对，不一致就重跑该迁移（up 幂等）。
// ---------------------------------------------------------------------------
function ensureDefTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_def_fingerprints (
      migration_id TEXT PRIMARY KEY,
      fingerprint  TEXT NOT NULL,
      stamped_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
}

/** 稳定序列化：对象键排序，保证同样内容永远算出同一个指纹 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

function defFingerprint(data) {
  // 用 Node 自带 crypto，避免额外依赖
  const crypto = require('node:crypto')
  return crypto.createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 32)
}

/** 写入/更新指纹（迁移 up 末尾调用） */
function stampDef(db, migrationId, data) {
  ensureDefTable(db)
  const fp = defFingerprint(data)
  db.prepare(
    `INSERT INTO schema_def_fingerprints (migration_id, fingerprint, stamped_at)
     VALUES (?,?,datetime('now','localtime'))
     ON CONFLICT(migration_id) DO UPDATE SET fingerprint=excluded.fingerprint, stamped_at=excluded.stamped_at`
  ).run(migrationId, fp)
  return fp
}

/** 定义是否已过期（自检用）：无记录或指纹不同即为过期 */
function defStale(db, migrationId, data) {
  ensureDefTable(db)
  const row = db.prepare('SELECT fingerprint FROM schema_def_fingerprints WHERE migration_id=?').get(migrationId)
  if (!row) return true
  return row.fingerprint !== defFingerprint(data)
}

module.exports = {
  tableExists,
  hasColumn,
  addColumn,
  hasIndex,
  ensureDefTable,
  defFingerprint,
  stampDef,
  defStale
}
