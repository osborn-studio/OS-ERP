import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DRILL = 'scripts/upgrade-rollback-drill.mjs'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', ...extra })

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Production data dir built by the real migration runner (production boot), backed up by db-backup.mjs. */
function productionFixture(t) {
  const dir = tempDir(t, 'os-egp-upgrade-src-')
  const boot = spawnSync(process.execPath, ['--input-type=module', '-e', "const {bootAll}=await import('./server/db/production-boot.js');bootAll()"],
    { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(boot.status, 0, boot.stderr)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.exec("CREATE TABLE keep_customer_data (value TEXT); INSERT INTO keep_customer_data VALUES ('retain-me')")
  db.close()
  const backup = spawnSync(process.execPath, ['scripts/db-backup.mjs', 'cosmetic'], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 60000 })
  assert.equal(backup.status, 0, backup.stderr + backup.stdout)
  const backupDir = path.join(dir, 'backups')
  const files = readdirSync(backupDir).filter((f) => f.endsWith('.db'))
  assert.equal(files.length, 1)
  return { dir, backupDir, backupFile: path.join(backupDir, files[0]) }
}

function drill(t, fixture, { target = tempDir(t, 'os-egp-upgrade-target-'), args = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [DRILL, `--backup-dir=${fixture.backupDir}`, `--target-dir=${target}`, ...args], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: target, TMPDIR: target, ...env }, encoding: 'utf8', timeout: 180000
  })
  return { ...result, target }
}
const reportsIn = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => /^upgrade-rollback-drill-.*\.json$/.test(f)) : []
const readReport = (dir) => JSON.parse(readFileSync(path.join(dir, reportsIn(dir)[0]), 'utf8'))

test('a failing upgrade migration leaves the restored copy at the previous version, checksums intact, and the backup restores and starts', { timeout: 180000 }, (t) => {
  const fx = productionFixture(t)
  const before = sha256(fx.backupFile)
  const result = drill(t, fx)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(reportsIn(result.target).length, 1)
  const report = readReport(result.target)
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
  assert.equal(report.runtime_mode, 'production')
  assert.equal(report.restored[0].sha256_verified, true)
  assert.equal(report.baseline.migrations.status, 'ok')
  assert.equal(typeof report.baseline.applied_count, 'number')
  assert.ok(report.baseline.applied_count > 0)
  // The simulated upgrade must have failed in the right place.
  assert.equal(report.failed_upgrade.threw, true)
  assert.match(report.failed_upgrade.error, /DRILL_UPGRADE_FAILURE/)
  assert.match(report.failed_upgrade.migration_id, /^999_drill_failing_upgrade$/)
  const names = report.invariants.map((i) => i.name)
  for (const expected of ['no_partial_table', 'schema_migrations_unchanged', 'schema_objects_unchanged', 'no_failed_migration_recorded', 'checksums_intact', 'integrity_ok', 'tampered_file_rejected_before_write', 'rollback_sha256_verified', 'rollback_migrations_ok', 'rollback_server_healthy', 'rollback_data_retained']) {
    assert.ok(names.includes(expected), expected)
  }
  for (const inv of report.invariants) assert.equal(inv.passed, true, JSON.stringify(inv))
  assert.equal(typeof report.timing.total_ms, 'number')
  assert.equal(typeof report.timing.rollback_ms, 'number')
  assert.doesNotMatch(JSON.stringify(report), /password|secret|token/i)
  assert.equal(sha256(fx.backupFile), before, 'the source backup is never modified')
  // The restored copy ends at the previous version: no drill table, no 999 row, sentinel still there.
  const db = new Database(path.join(result.target, 'gml_cosmetic.db'), { readonly: true })
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='drill_upgrade_partial'").get().n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id LIKE '999_%'").get().n, 0)
  assert.equal(db.prepare('SELECT value FROM keep_customer_data').get().value, 'retain-me')
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE checksum IS NULL").get().n, 0)
  db.close()
  assert.match(result.stdout, /回退演练通过/)
})

test('a tampered backup set cannot start the drill and exits non-zero with a report', { timeout: 120000 }, (t) => {
  const fx = productionFixture(t)
  const fd = openSync(fx.backupFile, 'r+')
  writeSync(fd, Buffer.from('DRILL-TAMPER'), 0, 12, 4096 + 100)
  closeSync(fd)
  const result = drill(t, fx)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /RESTORE_SHA256_MISMATCH/)
  assert.equal(existsSync(path.join(result.target, 'gml_cosmetic.db')), false)
  const report = readReport(result.target)
  assert.equal(report.passed, false)
  assert.equal(report.restored[0].sha256_verified, false)
  assert.deepEqual(report.invariants, [])
})

test('refuses a non-empty target directory and unknown flags without touching anything', { timeout: 60000 }, (t) => {
  const fx = productionFixture(t)
  const nonEmpty = tempDir(t, 'os-egp-upgrade-nonempty-')
  writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x')
  const a = drill(t, fx, { target: nonEmpty })
  assert.equal(a.status, 2)
  assert.match(a.stderr, /DRILL_TARGET_NOT_EMPTY/)
  assert.deepEqual(readdirSync(nonEmpty), ['keep.txt'])
  const fresh = tempDir(t, 'os-egp-upgrade-target-')
  const b = drill(t, fx, { target: fresh, args: ['--no-such-flag'] })
  assert.equal(b.status, 2)
  assert.match(b.stderr, /DRILL_USAGE/)
  assert.deepEqual(readdirSync(fresh), [])
})
