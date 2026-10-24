'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/071_audit_fts_optional.cjs ｜ 审计 FTS5 索引可选化：设置键 audit_fts_enabled（roadmap-v9 AD4，ADR-0054）
 * ============================================================================
 * 【职责】设置键 `audit_fts_enabled`（危险键，默认开，登记在 `lib/settings.js`）决定迁移 067 的 `audit_logs_fts`（表 + 三触发器）是否存在：
 *   · 开（缺省 / 非 "0"）：与 067 一致——对象齐全，缺了由自愈调 067 的 `up` 重建并回填。
 *   · 关（恰为 "0"）：表与触发器被删除；`audit-view.js` 查不到表就走 LIKE，与"无 FTS5 的构建"完全同一条路径。
 * 【谁来动对象】只有三处：`scripts/audit-fts-maintain.mjs --disable|--enable`（同事务改设置 + 删/建，运维入口）、本迁移的 `up`（启动自愈，
 *   **只在设置这样说时**）、`dropFts` / `enableFts`（二者共用的函数）。改设置本身（界面 / API）不立即动索引，下次启动时收敛。
 * 【接管 067 的自检】067 的 `verify()` 会把"表缺失"当作结构脱节而重建——设置为关时这会在每次启动重建整张索引。已执行迁移不能改（ADR-0009），
 *   所以本迁移声明 `supersedesVerifyOf = ['067_audit_fts']`，运行器此后不再单独自检 067，改由本迁移的 `verify()` 按设置判断（开 = 067 的判据，关 = 对象都不在）。
 * 【无 FTS5 的构建】`ftsSupported` 为 false 时 `up` 什么都不做、`verify` 为 true（库里若留有 FTS5 构建建的表，这里删不了——虚拟表模块不在，见 ADR-0054）。
 * 【067 不在磁盘上】（旧目录 / 测试副本）：延迟 require，缺失则整个迁移是空操作。
 * 【改它要注意什么】恢复（再开启）= 重建 + 回填存量行，大库上持写锁到结束（见 capacity-baseline "AC5"/"AB3"）；已执行迁移不改（ADR-0009）。
 * ============================================================================
 */
module.exports.name = '审计日志 FTS5 索引可选化（设置 audit_fts_enabled）'
module.exports.supersedesVerifyOf = ['067_audit_fts']

const SETTING_KEY = 'audit_fts_enabled'
module.exports.SETTING_KEY = SETTING_KEY

function load067() {
  try { return require('./067_audit_fts.cjs') } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /067_audit_fts/.test(String(e.message))) return null
    throw e
  }
}

const has = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name)

/** 设置是否允许 FTS：只有库里存的值恰为 "0" 才算关；没有 settings 表 / 没有这一行 / 其它值都按默认（开） */
function settingEnabled(db) {
  try {
    if (!has(db, 'table', 'settings')) return true
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING_KEY)
    return !(row && String(row.value).trim() === '0')
  } catch { return true }
}
module.exports.settingEnabled = settingEnabled

/** 删除 FTS 表与三个触发器（幂等；调用方负责事务）。返回是否真的删了东西 */
function dropFts(db) {
  const m = load067()
  if (!m) return false
  let dropped = false
  for (const t of m.TRIGGERS) if (has(db, 'trigger', t)) { db.exec(`DROP TRIGGER ${t}`); dropped = true }
  if (has(db, 'table', m.FTS_TABLE)) { db.exec(`DROP TABLE ${m.FTS_TABLE}`); dropped = true }
  return dropped
}
module.exports.dropFts = dropFts

/** 建表 + 触发器并回填（即 067 的 up，幂等）。构建不支持 FTS5 / trigram 时返回 false 且什么都不做 */
function enableFts(db) {
  const m = load067()
  if (!m || !m.ftsSupported(db)) return false
  m.up(db)
  return true
}
module.exports.enableFts = enableFts

module.exports.up = (db) => {
  const m = load067()
  if (!m || !m.ftsSupported(db)) return
  if (settingEnabled(db)) m.up(db)
  else dropFts(db)
}

module.exports.verify = (db) => {
  const m = load067()
  if (!m || !m.ftsSupported(db)) return true
  if (settingEnabled(db)) return m.verify(db)
  return !has(db, 'table', m.FTS_TABLE) && m.TRIGGERS.every((t) => !has(db, 'trigger', t))
}
