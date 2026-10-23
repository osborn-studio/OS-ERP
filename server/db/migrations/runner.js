/**
 * ============================================================================
 * 文件标识：server/db/migrations/runner.js ｜ GML 数据库迁移运行器：顺序执行、结构自检、迁移文件校验和
 * ============================================================================
 * 【职责】按文件名顺序执行 `NNN_名称.cjs` 迁移，记录到 `schema_migrations`；
 *   对已执行迁移做 verify() 结构自检并自愈；记录并核对每个迁移文件的 sha256。
 *
 * 【为什么这样设计】
 *   · 校验和（ADR-0009）：已执行迁移的文件内容若与登记值不同，生产模式启动
 *     **拒绝**（`MIGRATION_CHECKSUM_MISMATCH`），在任何 up()/heal 之前整体检查，
 *     不会把库迁一半；demo/test 只告警——这两类数据按 ADR-0001 可丢弃，开发时
 *     会就地改迁移文件。
 *   · 旧库没有校验和列：首次升级后在 ensureVersionTable 里幂等加列，NULL 行按
 *     当前文件"收养"（origin=adopted），不失败。这是启动基础设施，不占迁移编号。
 *   · verify() 失败才 heal；ADR-0007：正常重检不得清空或重跑已执行的版本。
 *
 * 【改它要注意什么】
 *   改已执行过的迁移文件 = 生产启动失败；要么新开迁移编号，要么经评审后
 *   `node scripts/migrate.mjs --adopt-checksums` 显式收养。保持
 *   tests/migration-permission-policy.test.mjs 与 tests/migration-checksum.test.mjs 绿。
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
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runtimeMode } from '../../runtime.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export const MIGRATIONS_DIR = __dirname
export const MIGRATION_CHECKSUM_MISMATCH = 'MIGRATION_CHECKSUM_MISMATCH'

const FILE_RE = /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
}

const idOf = (file) => file.replace(/\.cjs$/, '')
const checksumOf = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function ensureVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `)
  // 校验和列：旧库幂等补列（启动基础设施，不占迁移编号；见 ADR-0009）
  const cols = new Set(db.prepare('PRAGMA table_info(schema_migrations)').all().map((c) => c.name))
  if (!cols.has('checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT')
  if (!cols.has('checksum_origin')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum_origin TEXT')
}

/** 已登记行 → Map<id, { id, checksum, checksum_origin }> */
function recordedRows(db) {
  const map = new Map()
  for (const r of db.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations').all()) map.set(r.id, r)
  return map
}

/**
 * 核对已登记迁移与当前文件的校验和（只读，除了幂等补列）。
 * 返回 { verified, unrecorded: 无校验和的旧行, mismatched: 内容已变, missing: 登记了但文件已不存在 }
 */
export function checkMigrationChecksums(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  ensureVersionTable(db)
  const recorded = recordedRows(db)
  const files = listMigrationFiles(migrationsDir)
  const present = new Set(files.map(idOf))
  const result = { verified: 0, unrecorded: [], mismatched: [], missing: [] }
  for (const file of files) {
    const row = recorded.get(idOf(file))
    if (!row) continue
    if (!row.checksum) result.unrecorded.push(idOf(file))
    else if (row.checksum !== checksumOf(path.join(migrationsDir, file))) result.mismatched.push(idOf(file))
    else result.verified += 1
  }
  for (const id of recorded.keys()) if (!present.has(id)) result.missing.push(id)
  return result
}

/**
 * 显式收养：把"无校验和"与"校验和不一致"的已登记迁移改记为当前文件内容（origin=adopted）。
 * 这是评审后的运维动作（`scripts/migrate.mjs --adopt-checksums`），不是启动时的自动行为——
 * 启动只收养 NULL 行，不收养不一致行。返回被收养的 id 列表。
 */
export function adoptMigrationChecksums(db, { migrationsDir = MIGRATIONS_DIR, log } = {}) {
  const status = checkMigrationChecksums(db, { migrationsDir })
  const ids = [...status.unrecorded, ...status.mismatched].sort()
  const update = db.prepare("UPDATE schema_migrations SET checksum=?, checksum_origin='adopted' WHERE id=?")
  db.transaction(() => {
    for (const id of ids) update.run(checksumOf(path.join(migrationsDir, `${id}.cjs`)), id)
  })()
  for (const id of ids) log?.(`[migrate] adopt ${id}（校验和已按当前文件登记）`)
  return ids
}

/** 执行所有未执行的迁移；并对已执行的迁移做结构自检，脱节者自动重跑
 *  返回 { applied: 本次新执行, healed: 自愈重跑, adopted: 补登校验和的旧行, mismatched: 校验和不一致（仅 demo/test 会返回） }
 *  选项：migrationsDir（测试用，默认本目录）、mode（默认 GML_RUNTIME_MODE）、log、warn */
export function runMigrations(db, { log, warn = (m) => console.warn(m), migrationsDir = MIGRATIONS_DIR, mode = runtimeMode() } = {}) {
  ensureVersionTable(db)
  const recorded = recordedRows(db)
  const files = listMigrationFiles(migrationsDir)
  const applied = []
  const healed = []
  const adopted = []
  const mismatched = []

  // ---- 第一遍：只读核对校验和。生产模式任何不一致都在动库之前整体拒绝 ----
  const checksums = new Map()
  for (const file of files) {
    const id = idOf(file)
    const sum = checksumOf(path.join(migrationsDir, file))
    checksums.set(id, sum)
    const row = recorded.get(id)
    if (row && row.checksum && row.checksum !== sum) mismatched.push(id)
  }
  if (mismatched.length) {
    const message = `[migrate] ${MIGRATION_CHECKSUM_MISMATCH}: 已执行迁移的文件内容与登记校验和不一致：${mismatched.join(', ')}（${mode} 模式）`
    if (mode === 'production') {
      throw Object.assign(new Error(message), { code: MIGRATION_CHECKSUM_MISMATCH, mismatched: [...mismatched] })
    }
    warn(message)
  }

  const record = db.prepare('INSERT OR REPLACE INTO schema_migrations (id, name, checksum, checksum_origin) VALUES (?,?,?,?)')
  const adopt = db.prepare("UPDATE schema_migrations SET checksum=?, checksum_origin='adopted' WHERE id=? AND checksum IS NULL")

  for (const file of files) {
    const id = idOf(file)
    const mod = require(path.join(migrationsDir, file))
    const up = typeof mod === 'function' ? mod : mod.up
    const verify = typeof mod === 'object' && typeof mod.verify === 'function' ? mod.verify : null
    if (typeof up !== 'function') {
      throw new Error(`[migrate] ${file} 未导出 up(db)`)
    }
    const name = mod.name || id
    const sum = checksums.get(id)

    // ---- 已执行过的迁移：跑结构自检，发现脱节就重跑（up 全部幂等）----
    if (recorded.has(id)) {
      // 升级前登记的旧行没有校验和：按当前文件收养，不失败（ADR-0009）
      if (!recorded.get(id).checksum) {
        adopt.run(sum, id)
        adopted.push(id)
        if (log) log(`[migrate] adopt ${id}  ${name}（补登校验和）`)
      }
      if (!verify) continue
      let ok = true
      try { ok = verify(db) === true } catch { ok = false }
      if (ok) continue
      const tx = db.transaction(() => {
        up(db)
        record.run(id, name, sum, 'healed')
      })
      tx()
      healed.push(id)
      if (log) log(`[migrate] heal ${id}  ${name}（结构缺失，已重跑修复）`)
      continue
    }

    // 单个迁移一个事务：失败即整条回滚，不会留下半截结构
    const tx = db.transaction(() => {
      up(db)
      record.run(id, name, sum, 'applied')
    })
    tx()

    applied.push(id)
    if (log) log(`[migrate] ok ${id}  ${name}`)
  }
  return { applied, healed, adopted, mismatched }
}

/** 查看迁移状态：已执行 / 待执行 */
export function migrationStatus(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  ensureVersionTable(db)
  const applied = db
    .prepare('SELECT id, name, applied_at, checksum, checksum_origin FROM schema_migrations ORDER BY id')
    .all()
  const appliedIds = new Set(applied.map((r) => r.id))
  const pending = listMigrationFiles(migrationsDir)
    .map(idOf)
    .filter((id) => !appliedIds.has(id))
  return { applied, pending }
}

export default { runMigrations, migrationStatus, checkMigrationChecksums, adoptMigrationChecksums, MIGRATIONS_DIR }
