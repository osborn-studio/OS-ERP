/**
 * ============================================================================
 * 文件标识：server/db/runtime-policy.js ｜ 持久化数据库运行模式，拒绝误用及未分类旧库
 * 修改前先运行 tests/runtime-isolation.test.mjs 并检查旧库保护。
 * ============================================================================
 */
/** Persisted database classification: changing an environment variable cannot reclassify a database. */
import { runtimeMode, requireDemoRuntime } from '../runtime.js'

export const RUNTIME_TABLE = 'os_egp_runtime'

/** Guard even direct seed calls holding a connection created before an env change. */
export function requireDemoDatabase(db) {
  const mode = requireDemoRuntime()
  assertDatabaseMode(db, mode)
}

export function assertDatabaseMode(db, mode = runtimeMode()) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(RUNTIME_TABLE)
  if (!exists) throw Object.assign(new Error('Database has no OS EGP runtime classification; explicit migration is required'), { code: 'DATABASE_UNCLASSIFIED' })
  const row = db.prepare(`SELECT mode FROM ${RUNTIME_TABLE} WHERE id=1`).get()
  if (row?.mode !== mode) {
    throw Object.assign(new Error('Database runtime classification does not match the requested mode'), { code: 'DATABASE_MODE_MISMATCH' })
  }
}

export function classifyEmptyDatabase(db, mode = runtimeMode()) {
  db.transaction(() => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
    if (tables.length) return assertDatabaseMode(db, mode)
    db.exec(`CREATE TABLE ${RUNTIME_TABLE} (
      id INTEGER PRIMARY KEY CHECK(id=1),
      mode TEXT NOT NULL CHECK(mode IN ('production','demo','test'))
    )`)
    db.prepare(`INSERT INTO ${RUNTIME_TABLE} (id, mode) VALUES (1, ?)`).run(mode)
  }).immediate()
}
