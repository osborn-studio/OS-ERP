import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DRILL = 'scripts/db-restore-drill.mjs'
const secret = () => randomBytes(24).toString('base64url')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Production-classified environment: the drill only accepts production backups (ADR-0001 marker). */
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', ...extra })

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A production data dir with one bootstrapped admin and a few AR rows, backed up by the real db-backup.mjs. */
function productionFixture(t, { withAdmin = true, backupKey = null } = {}) {
  const dir = tempDir(t, 'os-egp-drill-src-')
  const password = secret()
  if (withAdmin) {
    const boot = spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs', '--industry=cosmetic', '--company-code=DRILLCO', '--company-name=演练企业', '--username=owner', '--name=管理员'],
      { cwd: ROOT, env: envFor(dir), input: password + '\n', encoding: 'utf8', timeout: 60000 })
    assert.equal(boot.status, 0, boot.stderr)
  } else {
    const boot = spawnSync(process.execPath, ['--input-type=module', '-e', "const {bootAll}=await import('./server/db/production-boot.js');bootAll()"],
      { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
    assert.equal(boot.status, 0, boot.stderr)
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.exec(`
    INSERT INTO ar_documents (doc_no, subject_type, subject_id, source_type, biz_date, amount, allocated_amount, status) VALUES
      ('AR-DRILL-1', 'dealer', 1, 'MANUAL', '2026-10-01', 100.5, 30.25, 'open'),
      ('AR-DRILL-2', 'dealer', 1, 'MANUAL', '2026-10-02', 200, 0, 'partial'),
      ('AR-DRILL-3', 'dealer', 1, 'MANUAL', '2026-10-03', 50, 50, 'closed');
    INSERT INTO receipts (doc_no, subject_type, subject_id, receipt_date, amount, status) VALUES
      ('RC-DRILL-1', 'dealer', 1, '2026-10-05', 30.25, 'confirmed'),
      ('RC-DRILL-2', 'dealer', 1, '2026-10-06', 10, 'draft');
  `)
  db.close()
  const backup = spawnSync(process.execPath, ['scripts/db-backup.mjs', 'cosmetic'], { cwd: ROOT, env: envFor(dir, backupKey ? { GML_BACKUP_KEY: backupKey } : {}), encoding: 'utf8', timeout: 60000 })
  assert.equal(backup.status, 0, backup.stderr + backup.stdout)
  const backupDir = path.join(dir, 'backups')
  const files = readdirSync(backupDir).filter((f) => f.endsWith('.db') || f.endsWith('.db.enc'))
  assert.equal(files.length, 1)
  return { dir, backupDir, backupFile: path.join(backupDir, files[0]), password }
}

function drill(t, fixture, { target = tempDir(t, 'os-egp-drill-target-'), args = [], env = {}, stdin } = {}) {
  const result = spawnSync(process.execPath, [DRILL, `--backup-dir=${fixture.backupDir}`, `--target-dir=${target}`, ...args], {
    cwd: ROOT,
    // The drill must not inherit the live GML_DATA_DIR of the test runner; it takes explicit directories.
    env: { PATH: process.env.PATH, HOME: target, TMPDIR: target, ...env },
    input: stdin === undefined ? '' : stdin,
    encoding: 'utf8',
    timeout: 180000
  })
  return { ...result, target }
}
const reportsIn = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => /^restore-drill-.*\.json$/.test(f)) : []
const readReport = (dir) => JSON.parse(readFileSync(path.join(dir, reportsIn(dir)[0]), 'utf8'))

test('restore drill verifies sha256, restores, migrates, starts production server, logs in and matches probes end to end', { timeout: 180000 }, (t) => {
  const fx = productionFixture(t)
  const backupShaBefore = sha256(fx.backupFile)
  const result = drill(t, fx, { args: ['--drill-username=owner', '--industry=cosmetic'], stdin: fx.password + '\n' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.ok(!result.stdout.includes(fx.password) && !result.stderr.includes(fx.password))
  assert.equal(reportsIn(result.target).length, 1)
  const report = readReport(result.target)
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
  assert.equal(report.runtime_mode, 'production')
  assert.equal(report.backup.dir, fx.backupDir)
  assert.equal(report.backup.data_dir, fx.dir)
  assert.equal(typeof report.backup.age_seconds, 'number')
  assert.ok(report.backup.age_seconds >= 0 && report.backup.age_seconds < 600)
  assert.equal(report.restored.length, 1)
  assert.equal(report.restored[0].code, 'cosmetic')
  assert.equal(report.restored[0].sha256_verified, true)
  assert.equal(report.restored[0].restored_as, path.join(result.target, 'gml_cosmetic.db'))
  assert.equal(report.migrations.status, 'ok')
  assert.equal(report.account.username, 'owner')
  assert.equal(report.account.created_by_drill, false)
  const names = report.probes.map((p) => p.name).sort()
  assert.deepEqual(names, ['ar_open_balance', 'products', 'purchase_orders', 'receipts', 'users'])
  for (const p of report.probes) assert.equal(p.match, true, JSON.stringify(p))
  const by = Object.fromEntries(report.probes.map((p) => [p.name, p]))
  assert.equal(by.users.expected, 1)
  assert.equal(by.users.actual, 1)
  assert.equal(by.receipts.expected, 2)
  assert.equal(by.ar_open_balance.expected, 270.25)
  assert.equal(by.ar_open_balance.actual, 270.25)
  for (const key of ['verify_ms', 'migrate_ms', 'server_ready_ms', 'probe_ms', 'total_ms']) {
    assert.equal(typeof report.timing[key], 'number', key)
    assert.ok(report.timing[key] >= 0)
  }
  assert.equal(report.timing.rto_ms, report.timing.total_ms)
  assert.doesNotMatch(JSON.stringify(report), /password|secret|token|\$2[aby]\$/i)
  assert.match(result.stdout, /RTO/)
  // Source backup must be untouched and the restored copy must be a working production database.
  assert.equal(sha256(fx.backupFile), backupShaBefore)
  const restored = new Database(path.join(result.target, 'gml_cosmetic.db'), { readonly: true })
  assert.equal(restored.prepare('SELECT mode FROM os_egp_runtime').get().mode, 'production')
  assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 1)
  restored.close()
})

test('a tampered backup file fails sha256 verification, restores nothing and exits non-zero', { timeout: 120000 }, (t) => {
  const fx = productionFixture(t)
  // Flip bytes in the page area without changing the size: the report sha256 no longer matches.
  const fd = openSync(fx.backupFile, 'r+')
  writeSync(fd, Buffer.from('DRILL-TAMPER'), 0, 12, 4096 + 100)
  closeSync(fd)
  const result = drill(t, fx, { args: ['--drill-username=owner'], stdin: fx.password + '\n' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /RESTORE_SHA256_MISMATCH/)
  assert.equal(existsSync(path.join(result.target, 'gml_cosmetic.db')), false, 'nothing is copied before verification passes')
  const report = readReport(result.target)
  assert.equal(report.passed, false)
  assert.equal(report.restored[0].sha256_verified, false)
  assert.ok(report.failures.some((f) => f.includes('RESTORE_SHA256_MISMATCH')))
  assert.equal(report.migrations, null)
  assert.equal(report.server, null)
})

test('a probe mismatch after restore is reported and exits non-zero', { timeout: 180000 }, (t) => {
  const fx = productionFixture(t)
  // Expectations come from the backup file itself, so the only honest way to force a mismatch is the
  // drill's explicit, command-line-visible fault injection; the report records it.
  const result = drill(t, fx, { args: ['--drill-username=owner', '--fault=probe-skew'], stdin: fx.password + '\n' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const report = readReport(result.target)
  assert.equal(report.passed, false)
  assert.equal(report.fault, 'probe-skew')
  assert.ok(report.probes.some((p) => p.match === false))
  assert.ok(report.failures.some((f) => f.includes('PROBE_MISMATCH')))
})

test('refuses a non-empty target, the live data directory of the backup source and the caller GML_DATA_DIR', { timeout: 120000 }, (t) => {
  const fx = productionFixture(t)
  const nonEmpty = tempDir(t, 'os-egp-drill-nonempty-')
  writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x')
  const a = drill(t, fx, { target: nonEmpty, args: ['--drill-username=owner'], stdin: fx.password + '\n' })
  assert.equal(a.status, 2)
  assert.match(a.stderr, /DRILL_TARGET_NOT_EMPTY/)
  assert.deepEqual(readdirSync(nonEmpty), ['keep.txt'])

  const before = sha256(fx.backupFile)
  const live = drill(t, fx, { target: fx.dir, args: ['--drill-username=owner'], stdin: fx.password + '\n' })
  assert.equal(live.status, 2)
  assert.match(live.stderr, /DRILL_TARGET_IS_LIVE/)
  assert.equal(sha256(fx.backupFile), before)
  assert.ok(existsSync(path.join(fx.dir, 'gml_cosmetic.db')))

  const fresh = tempDir(t, 'os-egp-drill-target-')
  const env = drill(t, fx, { target: fresh, args: ['--drill-username=owner'], stdin: fx.password + '\n', env: { GML_DATA_DIR: fresh } })
  assert.equal(env.status, 2)
  assert.match(env.stderr, /DRILL_TARGET_IS_LIVE/)
  assert.deepEqual(readdirSync(fresh), [])

  const relative = drill(t, fx, { target: 'relative/dir', args: ['--drill-username=owner'], stdin: fx.password + '\n' })
  assert.equal(relative.status, 2)
  assert.match(relative.stderr, /DRILL_USAGE/)
  assert.equal(existsSync(path.join(ROOT, 'relative')), false)
})

test('an empty production backup without accounts gets a drill admin in the restored copy only', { timeout: 180000 }, (t) => {
  const fx = productionFixture(t, { withAdmin: false })
  const before = sha256(fx.backupFile)
  const result = drill(t, fx, { args: ['--industry=cosmetic'] })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = readReport(result.target)
  assert.equal(report.passed, true)
  assert.equal(report.account.created_by_drill, true)
  assert.equal(typeof report.account.username, 'string')
  const users = report.probes.find((p) => p.name === 'users')
  assert.equal(users.backup_value, 0)
  assert.equal(users.expected, 1)
  assert.equal(users.actual, 1)
  assert.doesNotMatch(JSON.stringify(report) + result.stdout, /\$2[aby]\$/)
  assert.equal(sha256(fx.backupFile), before, 'the source backup is never modified')
  const source = new Database(path.join(fx.dir, 'gml_cosmetic.db'), { readonly: true })
  assert.equal(source.prepare('SELECT count(*) AS n FROM users').get().n, 0, 'the live source is never modified')
  source.close()
})

test('a backup whose accounts exist but no drill account is supplied is refused before starting anything', { timeout: 120000 }, (t) => {
  const fx = productionFixture(t)
  const result = drill(t, fx, { args: ['--industry=cosmetic'] })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /DRILL_ACCOUNT_REQUIRED/)
})

// ---- W6 / ADR-0022: encrypted backups ----
const BKEY = 'drill-backup-key-'.padEnd(48, 'x')

test('restore drill transparently decrypts an encrypted backup, restores, logs in and matches probes', { timeout: 180000 }, (t) => {
  const fx = productionFixture(t, { backupKey: BKEY })
  assert.ok(fx.backupFile.endsWith('.db.enc'))
  const shaBefore = sha256(fx.backupFile)
  const result = drill(t, fx, { args: ['--drill-username=owner', '--industry=cosmetic'], stdin: fx.password + '\n', env: { GML_BACKUP_KEY: BKEY } })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = readReport(result.target)
  assert.equal(report.passed, true)
  assert.equal(report.restored[0].sha256_verified, true)
  assert.equal(report.restored[0].encrypted, true)
  for (const p of report.probes) assert.equal(p.match, true, JSON.stringify(p))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(BKEY))
  assert.equal(sha256(fx.backupFile), shaBefore)
  const restored = new Database(path.join(result.target, 'gml_cosmetic.db'), { readonly: true })
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
  restored.close()
})

test('encrypted backup with the wrong key or no key fails cleanly and leaves no database or partial file in the target', { timeout: 120000 }, (t) => {
  const fx = productionFixture(t, { backupKey: BKEY })
  for (const [label, env, code] of [
    ['wrong key', { GML_BACKUP_KEY: 'w'.repeat(48) }, /DRILL_BACKUP_DECRYPT_FAILED/],
    ['no key', {}, /DRILL_BACKUP_KEY_REQUIRED/]
  ]) {
    const result = drill(t, fx, { args: ['--drill-username=owner', '--industry=cosmetic'], stdin: fx.password + '\n', env })
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`)
    assert.match(result.stdout + result.stderr, code)
    const left = readdirSync(result.target).filter((f) => !/^restore-drill-.*\.json$/.test(f))
    assert.deepEqual(left, [], `${label}: target holds only the report`)
    assert.equal(readReport(result.target).passed, false)
  }
})
