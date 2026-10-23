// ADR-0029：运维健康块、metrics 计数器、备份失败告警钩子
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import jwt from 'jsonwebtoken'
import {
  lastBackupStatus, loginThrottleStatus, diskFreeBytes, dbSizes, computeOpsStatus, opsCounters
} from '../server/lib/ops-status.js'
import { errorCodeOf, buildBackupAlert, sendBackupAlert } from '../server/lib/backup-alert.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const tmp = (t, prefix = 'os-erp-ops-') => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const writeReport = (dir, stamp, body) => {
  mkdirSync(path.join(dir, 'backups'), { recursive: true })
  writeFileSync(path.join(dir, 'backups', `backup-report-${stamp}.json`), typeof body === 'string' ? body : JSON.stringify(body))
}

// ---------------------------------------------------------------- ops-status
test('lastBackupStatus reads the newest report and exposes only at/result/encrypted/age_seconds', (t) => {
  const dir = tmp(t)
  const db = new Database(':memory:')
  assert.deepEqual(lastBackupStatus({ db, dataDir: dir, now: NOW }), { at: null, result: 'none', encrypted: null, age_seconds: null })
  writeReport(dir, '20261022-000000', { generated_at: '2026-10-22T00:00:00.000Z', failed: 1, encrypted: false, results: [{ file: '/secret/path.db', sha256: 'abc' }] })
  writeReport(dir, '20261023-110000', { generated_at: '2026-10-23T11:00:00.000Z', failed: 0, encrypted: true, results: [{ file: '/secret/path.db', sha256: 'abc' }] })
  const ok = lastBackupStatus({ db, dataDir: dir, now: NOW })
  assert.deepEqual(ok, { at: '2026-10-23T11:00:00.000Z', result: 'ok', encrypted: true, age_seconds: 3600 })
  assert.ok(!JSON.stringify(ok).includes('secret'))
  writeReport(dir, '20261023-115900', { generated_at: '2026-10-23T11:59:00.000Z', failed: 2, encrypted: false })
  assert.equal(lastBackupStatus({ db, dataDir: dir, now: NOW }).result, 'failed')
  writeReport(dir, '20261023-115959', '{not json')
  assert.equal(lastBackupStatus({ db, dataDir: dir, now: NOW }).result, 'unreadable')
})

test('lastBackupStatus honours settings.backup_dir through the backup-dir resolver', (t) => {
  const dir = tmp(t)
  const db = new Database(':memory:')
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('backup_dir','custom-bk')")
  mkdirSync(path.join(dir, 'custom-bk'))
  writeFileSync(path.join(dir, 'custom-bk', 'backup-report-20261023-100000.json'), JSON.stringify({ generated_at: '2026-10-23T10:00:00.000Z', failed: 0 }))
  const s = lastBackupStatus({ db, dataDir: dir, now: NOW })
  assert.equal(s.result, 'ok')
  assert.equal(s.encrypted, false)
})

test('loginThrottleStatus: ok before first login, unavailable for a corrupt store or missing directory', (t) => {
  const dir = tmp(t)
  assert.equal(loginThrottleStatus({ dataDir: dir }), 'ok')
  writeFileSync(path.join(dir, 'login-throttle.sqlite'), 'garbage, not a sqlite file')
  assert.equal(loginThrottleStatus({ dataDir: dir }), 'unavailable')
  assert.equal(loginThrottleStatus({ dataDir: path.join(dir, 'missing') }), 'unavailable')
})

test('disk and size probes degrade to null instead of throwing', (t) => {
  const dir = tmp(t)
  assert.ok(diskFreeBytes(dir) > 0)
  assert.equal(diskFreeBytes(dir, () => { throw new Error('x') }), null)
  const sizes = dbSizes(dir)
  assert.deepEqual(Object.keys(sizes).sort(), ['apparel', 'cosmetic', 'food'])
  assert.ok(Object.values(sizes).every((v) => v === null))
})

test('computeOpsStatus isolates probe failures per item and opsCounters maps unknowns to -1', () => {
  const ops = computeOpsStatus({
    db: null, dataDir: '/x', now: NOW,
    probes: {
      lastBackup: () => ({ at: 'a', result: 'failed', encrypted: true, age_seconds: 90000 }),
      migrationChecksums: () => ({ mismatched: 2, adopted: 1 }),
      loginThrottle: () => 'unavailable',
      diskFree: () => null,
      dbSizes: () => ({ cosmetic: 10 })
    }
  })
  assert.deepEqual(Object.keys(ops), ['last_backup', 'migration_checksums', 'login_throttle', 'disk_free_bytes', 'db_sizes'])
  assert.deepEqual(opsCounters(ops), {
    backup_age_seconds: 90000, backup_last_failed: 1, backup_missing: 0,
    migration_checksum_mismatches: 2, migration_checksum_adopted: 1,
    login_throttle_unavailable: 1, disk_free_bytes: -1
  })
})

// ---------------------------------------------------------------- alert hook (unit)
const failedResults = [
  { code: 'food', status: 'failed', error: 'BACKUP_VERIFY_FAILED: 打开/查询快照异常：/Volumes/SECRET/gml_food.db token=hunter2' },
  { code: 'cosmetic', status: 'ok', file: '/Volumes/SECRET/gml_cosmetic.db', sha256: 'deadbeef' }
]

test('alert content carries only industry code, error code and data-dir name', () => {
  assert.equal(errorCodeOf('BACKUP_FREEZE_FAILED: x'), 'BACKUP_FREEZE_FAILED')
  assert.equal(errorCodeOf('some free text: with colon'), 'BACKUP_FAILED')
  assert.equal(errorCodeOf(undefined), 'BACKUP_FAILED')
  const digest = buildBackupAlert({ results: failedResults, dataDir: '/Volumes/SECRET/os-erp-data', now: new Date('2026-10-23T00:00:00Z') })
  const text = JSON.stringify(digest)
  assert.match(text, /food: BACKUP_VERIFY_FAILED/)
  assert.match(text, /os-erp-data/)
  for (const leak of ['/Volumes', 'SECRET', 'hunter2', 'deadbeef', 'gml_food.db', 'cosmetic']) assert.ok(!text.includes(leak), `leaked ${leak}`)
  assert.equal(buildBackupAlert({ results: [{ code: 'food', status: 'ok' }], dataDir: '/d' }), null)
})

test('sendBackupAlert: disabled, silent on success, missing channel, sent, failed and thrown are all reported', async () => {
  const calls = []
  const channel = { id: 1, code: 'ops' }
  const lookup = (code) => (code === 'ops' ? { db: {}, channel, close: () => calls.push('close') } : null)
  const sender = async (_db, ch, digest, opts) => { calls.push({ ch, digest, opts }); return { status: 'success' } }
  const base = { results: failedResults, dataDir: '/d/os', lookup, sender }

  assert.deepEqual(await sendBackupAlert({ ...base, channelCode: '' }), { status: 'disabled' })
  assert.deepEqual(await sendBackupAlert({ ...base, channelCode: 'ops', results: [{ code: 'food', status: 'ok' }] }), { status: 'silent' })
  assert.equal(calls.length, 0, 'success must never reach the sender')
  assert.equal((await sendBackupAlert({ ...base, channelCode: 'nope' })).status, 'channel_missing')
  assert.equal(calls.length, 0)

  assert.deepEqual(await sendBackupAlert({ ...base, channelCode: 'ops' }), { status: 'sent' })
  assert.equal(calls[0].ch, channel)
  assert.equal(calls[0].digest.groups[0].items.length, 1)
  assert.ok(calls.includes('close'))

  const bad = await sendBackupAlert({ ...base, channelCode: 'ops', sender: async () => ({ status: 'fail', error: 'OUTBOUND_ADDRESS_BLOCKED: x' }) })
  assert.equal(bad.status, 'failed'); assert.match(bad.detail, /OUTBOUND_ADDRESS_BLOCKED/)
  const boom = await sendBackupAlert({ ...base, channelCode: 'ops', sender: async () => { throw Object.assign(new Error('x'), { code: 'EBOOM' }) } })
  assert.deepEqual(boom, { status: 'error', detail: 'EBOOM' })
})

// ---------------------------------------------------------------- db-backup script (subprocess)
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', ...extra })
function initDb(dir) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const {initSchemaFor}=await import('./server/db/index.js');initSchemaFor('cosmetic')"],
    { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stderr)
}
const runBackup = (dir, extra) => spawnSync(process.execPath, ['scripts/db-backup.mjs', 'cosmetic'], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 60000 })

test('db-backup alert hook: success is silent, failure reports a missing channel and keeps exit code 1', { timeout: 180000 }, (t) => {
  const dir = tmp(t)
  initDb(dir)
  const okRun = runBackup(dir, { GML_ALERT_CHANNEL: 'ops' })
  assert.equal(okRun.status, 0, okRun.stderr)
  assert.ok(!/ALERT_/.test(okRun.stderr + okRun.stdout), 'success must not alert')
  const bad = runBackup(dir, { GML_ALERT_CHANNEL: 'ops', GML_BACKUP_FAULT: 'truncate' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /ALERT_NOT_SENT: channel_missing/)
  const noHook = runBackup(dir, { GML_BACKUP_FAULT: 'truncate' })
  assert.equal(noHook.status, 1)
  assert.ok(!/ALERT_/.test(noHook.stderr), 'no GML_ALERT_CHANNEL ⇒ no hook output')
})

test('db-backup alert hook goes through notify: a blocked/unreachable webhook is logged as a failed push, nothing leaks', { timeout: 180000 }, (t) => {
  const dir = tmp(t)
  initDb(dir)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.prepare("INSERT INTO notify_channels (code,name,provider,webhook_url,secret,event_types,enabled) VALUES ('ops','ops','generic','http://127.0.0.1:9/hook','',  '',1)").run()
  db.close()
  const bad = runBackup(dir, { GML_ALERT_CHANNEL: 'ops', GML_BACKUP_FAULT: 'truncate' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /ALERT_NOT_SENT: failed/)
  const after = new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true })
  const log = after.prepare("SELECT status, payload, error, triggered_by FROM notify_logs WHERE channel_code='ops'").get()
  after.close()
  assert.equal(log.status, 'fail')
  assert.equal(log.triggered_by, 'db-backup')
  assert.ok(!log.payload.includes(dir) && !log.payload.includes('/'), `payload must not contain paths: ${log.payload}`)
  assert.match(log.payload, /BACKUP_VERIFY_FAILED/)
})

// ---------------------------------------------------------------- HTTP contract
async function server(t) {
  const dir = tmp(t, 'os-erp-ops-http-')
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise((r) => probe.close(r))
  const secret = randomBytes(32).toString('hex')
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: secret }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false; let stderr = ''
  child.stdout.on('data', (d) => { ready ||= d.toString().includes('服务已启动') })
  child.stderr.on('data', (d) => { stderr += d })
  const stopped = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, `server must start\n${stderr}`)
  const tokenFor = (username) => {
    const db = new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true })
    const u = db.prepare('SELECT id,username,role,name,auth_version,dealer_id,store_id,org_id FROM users WHERE username=?').get(username)
    db.close()
    return jwt.sign({ uid: u.id, auth_version: u.auth_version, username: u.username, role: u.role, name: u.name, industry: 'cosmetic' }, secret, { audience: 'gml-erp', algorithm: 'HS256', expiresIn: '1h' })
  }
  const get = (route, token) => fetch(`http://127.0.0.1:${port}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) })
  return { dir, get, tokenFor }
}

test('health: anonymous gets status only (+version contract); admin gets database and ops; metrics is admin-only', { timeout: 180000 }, async (t) => {
  const s = await server(t)
  // 先造一份失败的备份报告，验证 ops.last_backup 读的是真实报告
  writeReport(s.dir, '20261023-000000', { generated_at: new Date(Date.now() - 7200_000).toISOString(), failed: 1, encrypted: true, results: [{ file: '/x/y.db' }] })

  const anon = await s.get('/api/meta/health')
  assert.equal(anon.status, 200)
  const anonData = (await anon.json()).data
  assert.equal(anonData.status, 'ok')
  assert.deepEqual(Object.keys(anonData).sort(), ['build_sha', 'service', 'status', 'time', 'version'])

  const viewer = await s.get('/api/meta/health', s.tokenFor('viewer'))
  assert.deepEqual(Object.keys((await viewer.json()).data).sort(), ['build_sha', 'service', 'status', 'time', 'version'])

  const bad = await s.get('/api/meta/health', 'not-a-jwt')
  assert.equal(bad.status, 401)

  const adminRes = await s.get('/api/meta/health', s.tokenFor('admin'))
  assert.equal(adminRes.status, 200)
  const d = (await adminRes.json()).data
  assert.equal(d.status, 'ok')
  assert.equal(typeof d.database.tables, 'number')
  assert.deepEqual(Object.keys(d.ops), ['last_backup', 'migration_checksums', 'login_throttle', 'disk_free_bytes', 'db_sizes'])
  assert.equal(d.ops.last_backup.result, 'failed')
  assert.equal(d.ops.last_backup.encrypted, true)
  assert.ok(d.ops.last_backup.age_seconds >= 7190)
  assert.equal(d.ops.migration_checksums.mismatched, 0)
  assert.equal(typeof d.ops.migration_checksums.adopted, 'number')
  assert.equal(d.ops.login_throttle, 'ok')
  assert.ok(d.ops.disk_free_bytes > 0)
  assert.ok(d.ops.db_sizes.cosmetic > 0)
  assert.ok(!JSON.stringify(d.ops).includes(s.dir), 'ops must not expose paths')

  assert.equal((await s.get('/api/meta/metrics')).status, 401)
  assert.equal((await s.get('/api/meta/metrics', s.tokenFor('viewer'))).status, 403)
  const m = await s.get('/api/meta/metrics', s.tokenFor('admin'))
  assert.equal(m.status, 200)
  const c = (await m.json()).data.counters
  assert.equal(c.backup_last_failed, 1)
  assert.ok(c.backup_age_seconds >= 7190)
  assert.equal(c.migration_checksum_mismatches, 0)
  assert.equal(c.login_throttle_unavailable, 0)
})
