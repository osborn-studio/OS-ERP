import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR, checkMigrationChecksums, adoptMigrationChecksums } from '../server/db/migrations/runner.js'

const SCHEMA = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const migrationFiles = (dir) => readdirSync(dir).filter((f) => /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/.test(f)).sort()

function fresh(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  return db
}

/** A private, writable copy of the migrations directory so a test can tamper with one file. */
function migrationsCopy(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-migrations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  return dir
}

const rows = (db) => db.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()

test('a fresh database records the sha256 of every applied migration file', (t) => {
  const db = fresh(t)
  const result = runMigrations(db, { mode: 'production' })
  const files = migrationFiles(MIGRATIONS_DIR)
  assert.equal(result.applied.length, files.length)
  assert.deepEqual(result.mismatched, [])
  assert.deepEqual(result.adopted, [])
  const recorded = rows(db)
  assert.equal(recorded.length, files.length)
  for (const file of files) {
    const row = recorded.find((r) => r.id === file.replace(/\.cjs$/, ''))
    assert.ok(row, file)
    assert.equal(row.checksum, sha256(path.join(MIGRATIONS_DIR, file)))
    assert.equal(row.checksum_origin, 'applied')
  }
  assert.deepEqual(checkMigrationChecksums(db), { verified: files.length, unrecorded: [], mismatched: [], missing: [] })
})

test('legacy rows without a checksum are adopted on the first run and never fail startup', (t) => {
  const db = fresh(t)
  // Legacy shape: the version table predates the checksum columns.
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))")
  runMigrations(db, { mode: 'production' })
  db.prepare('UPDATE schema_migrations SET checksum=NULL, checksum_origin=NULL').run()
  const before = db.serialize()
  const status = checkMigrationChecksums(db)
  assert.equal(status.unrecorded.length, migrationFiles(MIGRATIONS_DIR).length)
  const result = runMigrations(db, { mode: 'production' })
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.healed, [], 'adoption must not re-run previous versions')
  assert.equal(result.adopted.length, migrationFiles(MIGRATIONS_DIR).length)
  for (const row of rows(db)) {
    assert.match(row.checksum, /^[0-9a-f]{64}$/)
    assert.equal(row.checksum_origin, 'adopted')
  }
  assert.deepEqual(runMigrations(db, { mode: 'production' }).adopted, [], 'adoption happens once')
  assert.notDeepEqual(db.serialize(), before, 'checksums were persisted')
})

test('a tampered applied migration fails closed in production and leaves the database untouched', (t) => {
  const db = fresh(t)
  const dir = migrationsCopy(t)
  runMigrations(db, { mode: 'production', migrationsDir: dir })
  const victim = migrationFiles(dir).at(-1)
  appendFileSync(path.join(dir, victim), '\n// tampered after application\n')
  const before = db.serialize()
  assert.throws(() => runMigrations(db, { mode: 'production', migrationsDir: dir }), (error) => {
    assert.equal(error.code, 'MIGRATION_CHECKSUM_MISMATCH')
    assert.match(error.message, new RegExp(victim.replace(/\.cjs$/, '')))
    assert.deepEqual(error.mismatched, [victim.replace(/\.cjs$/, '')])
    return true
  })
  assert.deepEqual(db.serialize(), before)
  const status = checkMigrationChecksums(db, { migrationsDir: dir })
  assert.deepEqual(status.mismatched, [victim.replace(/\.cjs$/, '')])
})

test('a tampered applied migration only warns in demo and test mode and does not re-run it', (t) => {
  for (const mode of ['demo', 'test']) {
    const db = fresh(t)
    const dir = migrationsCopy(t)
    runMigrations(db, { mode, migrationsDir: dir })
    const victim = migrationFiles(dir).at(-1).replace(/\.cjs$/, '')
    appendFileSync(path.join(dir, `${victim}.cjs`), '\n// tampered after application\n')
    const warnings = []
    const result = runMigrations(db, { mode, migrationsDir: dir, warn: (m) => warnings.push(m) })
    assert.deepEqual(result.mismatched, [victim])
    assert.deepEqual(result.healed, [])
    assert.deepEqual(result.applied, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /MIGRATION_CHECKSUM_MISMATCH/)
    // The recorded checksum is still the one that was executed, not the tampered file.
    assert.notEqual(rows(db).find((r) => r.id === victim).checksum, sha256(path.join(dir, `${victim}.cjs`)))
  }
})

test('explicit adoption re-records a mismatched checksum and lets production start again', (t) => {
  const db = fresh(t)
  const dir = migrationsCopy(t)
  runMigrations(db, { mode: 'production', migrationsDir: dir })
  const victim = migrationFiles(dir).at(0).replace(/\.cjs$/, '')
  appendFileSync(path.join(dir, `${victim}.cjs`), '\n// reviewed hotfix\n')
  assert.throws(() => runMigrations(db, { mode: 'production', migrationsDir: dir }), { code: 'MIGRATION_CHECKSUM_MISMATCH' })
  const adopted = adoptMigrationChecksums(db, { migrationsDir: dir })
  assert.deepEqual(adopted, [victim])
  const row = rows(db).find((r) => r.id === victim)
  assert.equal(row.checksum, sha256(path.join(dir, `${victim}.cjs`)))
  assert.equal(row.checksum_origin, 'adopted')
  const result = runMigrations(db, { mode: 'production', migrationsDir: dir })
  assert.deepEqual(result.mismatched, [])
  assert.deepEqual(result.healed, [])
})

test('healing a structurally broken migration records the checksum of the file that was re-run', (t) => {
  const db = fresh(t)
  runMigrations(db, { mode: 'production' })
  // 050 verifies users.auth_version; removing the column forces the documented heal path.
  db.exec('ALTER TABLE users DROP COLUMN auth_version')
  db.prepare("UPDATE schema_migrations SET checksum='0'||substr(checksum,2) WHERE id='050_user_auth_version'").run()
  const result = runMigrations(db, { mode: 'demo' })
  assert.deepEqual(result.healed, ['050_user_auth_version'])
  const row = rows(db).find((r) => r.id === '050_user_auth_version')
  assert.equal(row.checksum, sha256(path.join(MIGRATIONS_DIR, '050_user_auth_version.cjs')))
  assert.equal(row.checksum_origin, 'healed')
})

test('the default runtime mode comes from the environment and is production when unset', (t) => {
  const db = fresh(t)
  const dir = migrationsCopy(t)
  runMigrations(db, { migrationsDir: dir })
  const victim = migrationFiles(dir).at(-1)
  writeFileSync(path.join(dir, victim), readFileSync(path.join(dir, victim), 'utf8') + '\n// edited\n')
  const saved = process.env.GML_RUNTIME_MODE
  try {
    delete process.env.GML_RUNTIME_MODE
    assert.throws(() => runMigrations(db, { migrationsDir: dir }), { code: 'MIGRATION_CHECKSUM_MISMATCH' })
    process.env.GML_RUNTIME_MODE = 'test'
    assert.deepEqual(runMigrations(db, { migrationsDir: dir, warn: () => {} }).mismatched, [victim.replace(/\.cjs$/, '')])
  } finally {
    if (saved === undefined) delete process.env.GML_RUNTIME_MODE
    else process.env.GML_RUNTIME_MODE = saved
  }
})
