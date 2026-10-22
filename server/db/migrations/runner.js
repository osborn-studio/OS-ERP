/**
 * ============================================================================
 * 文件标识：server/db/migrations/runner.js ｜ GML 数据库迁移运行器
 * ============================================================================
 * 【职责】GML 数据库迁移运行器
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// GML 数据库迁移运行器
// 约定：迁移文件放在本目录，命名为 `NNN_名称.cjs`（CommonJS，导出 { name, up(db) } 或 function up(db)）
// 运行顺序按文件名排序；已执行的记录在 schema_migrations，重复执行幂等。
//
// 为什么用 .cjs：迁移文件需要被同步 require（better-sqlite3 的事务是同步 API），
// 而本项目是 ESM，只能用 createRequire 加载 CommonJS。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export const MIGRATIONS_DIR = __dirname

const FILE_RE = /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/

function listMigrationFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => FILE_RE.test(f))
    .sort()
}

function ensureVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
}

/** 执行所有未执行的迁移；并对已执行的迁移做结构自检，脱节者自动重跑
 *  返回 { applied: 本次新执行, healed: 自愈重跑 } */
export function runMigrations(db, { log } = {}) {
  ensureVersionTable(db)
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id))
  const applied = []
  const healed = []

  for (const file of listMigrationFiles()) {
    const id = file.replace(/\.cjs$/, '')
    const mod = require(path.join(__dirname, file))
    const up = typeof mod === 'function' ? mod : mod.up
    const verify = typeof mod === 'object' && typeof mod.verify === 'function' ? mod.verify : null
    if (typeof up !== 'function') {
      throw new Error(`[migrate] ${file} 未导出 up(db)`)
    }
    const name = mod.name || id

    // ---- 已执行过的迁移：跑结构自检，发现脱节就重跑（up 全部幂等）----
    if (done.has(id)) {
      if (!verify) continue
      let ok = true
      try { ok = verify(db) === true } catch { ok = false }
      if (ok) continue
      const tx = db.transaction(() => {
        up(db)
        db.prepare('INSERT OR REPLACE INTO schema_migrations (id, name) VALUES (?,?)').run(id, name)
      })
      tx()
      healed.push(id)
      if (log) log(`[migrate] heal ${id}  ${name}（结构缺失，已重跑修复）`)
      continue
    }

    // 单个迁移一个事务：失败即整条回滚，不会留下半截结构
    const tx = db.transaction(() => {
      up(db)
      db.prepare('INSERT OR REPLACE INTO schema_migrations (id, name) VALUES (?,?)').run(id, name)
    })
    tx()

    applied.push(id)
    if (log) log(`[migrate] ok ${id}  ${name}`)
  }
  return { applied, healed }
}

/** 查看迁移状态：已执行 / 待执行 */
export function migrationStatus(db) {
  ensureVersionTable(db)
  const applied = db
    .prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id')
    .all()
  const appliedIds = new Set(applied.map((r) => r.id))
  const pending = listMigrationFiles()
    .map((f) => f.replace(/\.cjs$/, ''))
    .filter((id) => !appliedIds.has(id))
  return { applied, pending }
}

export default { runMigrations, migrationStatus, MIGRATIONS_DIR }
