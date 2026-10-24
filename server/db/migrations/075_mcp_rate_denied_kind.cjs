'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/075_mcp_rate_denied_kind.cjs ｜ mcp_rate_buckets.kind 增 'denied'（roadmap-v12 AG9，ADR-0056 补充 3）
 * ============================================================================
 * 【职责】073 的 `kind` CHECK 只有 'all' | 'write'，桶表只记**放行**的调用，管理端拿不到 429 的精确次数（AF11 只能给"触顶窗口数"）。
 *   本迁移把 CHECK 放宽为 'all' | 'write' | 'denied'：`db` 模式下被速率额度拒绝的调用记一行 denied 计数（尽力而为，
 *   在放行判定**之后**、独立短事务里写；判定读取只认 'all' / 'write'，所以 denied 行永远不影响放行）。
 * 【为什么要重建表】SQLite 不能 ALTER 一个 CHECK 约束。唯一的办法是：新建同结构的表 → 拷贝全部行 → 删旧表 → 改名 → 重建索引。
 * 【迁移安全】
 *   · 全程在一个事务里（runner 的 up 本身就在事务里；被直接调用时本文件自己开事务），失败整条回滚，旧表原样保留；
 *   · 已经是新 CHECK（sqlite_master 里的建表语句含 'denied'）⇒ 什么都不做（幂等）；表不存在 ⇒ 按新结构直接创建；
 *   · 拷贝是 `INSERT … SELECT` 逐列、不改值；拷贝后核对行数一致，不一致抛错回滚（不会静默丢桶）；
 *   · 暂存表 `mcp_rate_buckets_new` 若有遗留（手工操作留下的）先删——它是本迁移私有的名字；
 *   · 索引 `idx_mcp_rate_buckets_window` 随旧表被删，最后重建；没有外键引用本表。已执行迁移不改（ADR-0009）。
 * 【改它要注意什么】COLUMNS / PK / INDEX 是 up 与 verify 的唯一来源；verify 同时要求建表语句允许 denied。073 的 verify 不受影响（列、主键、索引不变）。
 * ============================================================================
 */
const { tableExists, hasIndex } = require('./_helpers.cjs')

module.exports.name = 'MCP 限速桶 kind 增 denied（拒绝计数，表重建）'

const TABLE = 'mcp_rate_buckets'
const SCRATCH = 'mcp_rate_buckets_new'
const INDEX = 'idx_mcp_rate_buckets_window'
const COLUMNS = ['token_key', 'window_start', 'kind', 'count']
const PK = ['token_key', 'window_start', 'kind']
module.exports.TABLE = TABLE
module.exports.INDEX = INDEX

const createSql = (name) => `
  CREATE TABLE ${name} (
    token_key    TEXT    NOT NULL,
    window_start INTEGER NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('all','write','denied')),
    count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (token_key, window_start, kind)
  )`

const allowsDenied = (db) => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
  return !!row && /'denied'/.test(row.sql)
}

function rebuild(db) {
  db.exec(`DROP TABLE IF EXISTS ${SCRATCH}`)
  db.exec(createSql(SCRATCH))
  db.exec(`INSERT INTO ${SCRATCH} (token_key, window_start, kind, count) SELECT token_key, window_start, kind, count FROM ${TABLE}`)
  const a = db.prepare(`SELECT COUNT(*) c FROM ${TABLE}`).get().c
  const b = db.prepare(`SELECT COUNT(*) c FROM ${SCRATCH}`).get().c
  if (a !== b) throw new Error(`mcp_rate_buckets 重建行数不一致（旧 ${a} / 新 ${b}），已回滚`)
  db.exec(`DROP TABLE ${TABLE}`)
  db.exec(`ALTER TABLE ${SCRATCH} RENAME TO ${TABLE}`)
}

module.exports.up = (db) => {
  const run = () => {
    if (!tableExists(db, TABLE)) db.exec(createSql(TABLE))
    else if (!allowsDenied(db)) rebuild(db)
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(window_start)`)
  }
  if (db.inTransaction) run()
  else db.transaction(run)()
}

module.exports.verify = (db) => {
  if (!tableExists(db, TABLE) || !hasIndex(db, INDEX)) return false
  if (!allowsDenied(db)) return false
  const cols = db.prepare(`PRAGMA table_info(${TABLE})`).all()
  if (COLUMNS.some((c) => !cols.some((x) => x.name === c))) return false
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  if (pk.join(',') !== PK.join(',')) return false
  const ix = db.prepare(`PRAGMA index_info(${INDEX})`).all().map((c) => c.name)
  return ix.length === 1 && ix[0] === 'window_start'
}
