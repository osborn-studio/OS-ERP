import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = 'scripts/db-backup.mjs'

function fixture(t, industries = ['cosmetic']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const init = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {initSchemaFor}=await import('./server/db/index.js');for(const c of ${JSON.stringify(industries)}) initSchemaFor(c)`
  ], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(init.status, 0, init.stderr)
  for (const code of industries) assert.ok(existsSync(path.join(dir, `gml_${code}.db`)))
  return dir
}
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', ...extra })
function backup(dir, args = [], extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 60000 })
}
const backupDir = (dir) => path.join(dir, 'backups')
const backupsOf = (dir, code) => existsSync(backupDir(dir)) ? readdirSync(backupDir(dir)).filter((f) => f.startsWith(`gml_${code}_`) && f.endsWith('.db')).sort() : []
const failedOf = (dir, code) => existsSync(backupDir(dir)) ? readdirSync(backupDir(dir)).filter((f) => f.startsWith(`gml_${code}_`) && f.endsWith('.failed')) : []
const reports = (dir) => existsSync(backupDir(dir)) ? readdirSync(backupDir(dir)).filter((f) => /^backup-report-.*\.json$/.test(f)).sort() : []
const latestReport = (dir) => JSON.parse(readFileSync(path.join(backupDir(dir), reports(dir).at(-1)), 'utf8'))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('a successful backup is verified, smoke-restored, reported and only then pruned to keep', { timeout: 120000 }, (t) => {
  const dir = fixture(t)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES ('smoke', 'x', 'Smoke', 'admin')").run()
  db.close()
  for (let run = 1; run <= 3; run++) {
    const result = backup(dir, ['cosmetic', '--keep=2'])
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const files = backupsOf(dir, 'cosmetic')
    assert.equal(files.length, Math.min(run, 2), `run ${run} keeps at most 2 backups including the new one`)
    const report = latestReport(dir)
    const entry = report.results.find((r) => r.code === 'cosmetic')
    assert.equal(entry.status, 'ok')
    assert.equal(entry.file, path.join(backupDir(dir), files.at(-1)))
    assert.equal(entry.sha256, sha256(entry.file))
    assert.equal(entry.size, statSync(entry.file).size)
    assert.equal(entry.verification.integrity, 'ok')
    assert.equal(entry.verification.foreign_key_violations, 0)
    assert.equal(entry.verification.tables_match, true)
    assert.equal(entry.verification.migrations_match, true)
    assert.deepEqual(entry.verification.smoke, { table: 'users', rows: 1 })
    assert.equal(entry.pruned.length, run === 3 ? 1 : 0)
    assert.equal(report.failed, 0)
    assert.doesNotMatch(JSON.stringify(report), /password|secret|token/i)
    assert.match(result.stdout, /校验 ok/)
  }
  // The newest file must survive pruning and be restorable on its own.
  const restored = new Database(path.join(backupDir(dir), backupsOf(dir, 'cosmetic').at(-1)), { readonly: true })
  assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 1)
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
  restored.close()
  assert.ok(reports(dir).length >= 1)
})

test('a corrupted new backup exits non-zero, prunes nothing and is not left as a valid-looking backup', { timeout: 120000 }, (t) => {
  const dir = fixture(t)
  for (let i = 0; i < 3; i++) assert.equal(backup(dir, ['cosmetic', '--keep=5']).status, 0)
  const before = backupsOf(dir, 'cosmetic')
  assert.equal(before.length, 3)
  const result = backup(dir, ['cosmetic', '--keep=1'], { GML_BACKUP_FAULT: 'truncate' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /BACKUP_VERIFY_FAILED/)
  assert.deepEqual(backupsOf(dir, 'cosmetic'), before, 'no pruning and no new .db after a failed verification')
  assert.equal(failedOf(dir, 'cosmetic').length, 1)
  const report = latestReport(dir)
  assert.equal(report.failed, 1)
  const entry = report.results.find((r) => r.code === 'cosmetic')
  assert.equal(entry.status, 'failed')
  assert.match(entry.error, /BACKUP_VERIFY_FAILED/)
  assert.deepEqual(entry.pruned, [])
})

test('one failing library fails the whole run while the healthy library still gets a verified backup', { timeout: 180000 }, (t) => {
  const dir = fixture(t, ['cosmetic', 'food'])
  const result = backup(dir, ['--keep=3'], { GML_BACKUP_FAULT: 'truncate:food' })
  assert.notEqual(result.status, 0)
  assert.equal(backupsOf(dir, 'cosmetic').length, 1)
  assert.equal(backupsOf(dir, 'food').length, 0)
  assert.equal(failedOf(dir, 'food').length, 1)
  const report = latestReport(dir)
  assert.equal(report.failed, 1)
  assert.equal(report.results.find((r) => r.code === 'cosmetic').status, 'ok')
  assert.equal(report.results.find((r) => r.code === 'food').status, 'failed')
  assert.equal(report.results.find((r) => r.code === 'apparel').status, 'skipped')
})

test('an unwritable backup directory fails before any pruning', { timeout: 120000, skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, (t) => {
  const dir = fixture(t)
  for (let i = 0; i < 2; i++) assert.equal(backup(dir, ['cosmetic', '--keep=5']).status, 0)
  const before = backupsOf(dir, 'cosmetic')
  chmodSync(backupDir(dir), 0o500)
  let result
  try {
    result = backup(dir, ['cosmetic', '--keep=1'])
  } finally {
    chmodSync(backupDir(dir), 0o700)
  }
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /BACKUP_SNAPSHOT_FAILED/)
  assert.deepEqual(backupsOf(dir, 'cosmetic'), before)
})

test('refuses to run against repository data without an explicit absolute GML_DATA_DIR', { timeout: 60000 }, (t) => {
  const dir = fixture(t)
  const repoBackups = path.join(ROOT, 'data', 'backups')
  const snapshot = () => (existsSync(repoBackups) ? readdirSync(repoBackups).sort() : null)
  const before = snapshot()
  for (const extra of [{ GML_DATA_DIR: '' }, { GML_DATA_DIR: 'data' }]) {
    const result = backup(dir, ['cosmetic'], extra)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DATA_DIRECTORY_REQUIRED/)
  }
  assert.deepEqual(snapshot(), before, 'repository data/backups must not be created or changed')
  assert.equal(existsSync(backupDir(dir)), false)
})

test('fault injection is refused outside test mode and unknown flags are rejected', { timeout: 60000 }, (t) => {
  const dir = fixture(t)
  const result = backup(dir, ['cosmetic'], { GML_RUNTIME_MODE: 'production', GML_BACKUP_FAULT: 'truncate' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /BACKUP_FAULT_FORBIDDEN/)
  assert.equal(existsSync(backupDir(dir)), false)
  const unknown = backup(dir, ['cosmetic', '--no-verify'])
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /--no-verify/)
  assert.equal(existsSync(backupDir(dir)), false)
  // --verify stays accepted for existing operator scripts; verification is always on.
  assert.equal(backup(dir, ['cosmetic', '--verify']).status, 0)
  assert.equal(latestReport(dir).results[0].verification.integrity, 'ok')
})

test('an explicit absolute backup_dir setting is honoured and a relative one resolves inside GML_DATA_DIR', { timeout: 120000 }, (t) => {
  const dir = fixture(t)
  const target = mkdtempSync(path.join(tmpdir(), 'os-egp-backup-target-'))
  t.after(() => rmSync(target, { recursive: true, force: true }))
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.prepare("UPDATE settings SET value=? WHERE key='backup_dir'").run(target)
  db.close()
  assert.equal(backup(dir, ['cosmetic']).status, 0)
  assert.equal(readdirSync(target).filter((f) => f.endsWith('.db')).length, 1)
  const db2 = new Database(path.join(dir, 'gml_cosmetic.db'))
  db2.prepare("UPDATE settings SET value='nested/copies' WHERE key='backup_dir'").run()
  db2.close()
  assert.equal(backup(dir, ['cosmetic']).status, 0)
  assert.equal(readdirSync(path.join(dir, 'nested', 'copies')).filter((f) => f.endsWith('.db')).length, 1)
  assert.equal(existsSync(path.join(ROOT, 'nested')), false)
})
