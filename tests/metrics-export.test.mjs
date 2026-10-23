// ADR-0045：Prometheus 文本指标导出、进程级计数器、令牌鉴权
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import jwt from 'jsonwebtoken'
import { incCounter, counterSnapshot, resetCounters } from '../server/lib/process-counters.js'
import { renderPrometheus, metricsTokenOk, METRICS_TOKEN_MIN_LENGTH } from '../server/lib/metrics-export.js'
import { auditStrictRow } from '../server/lib/audit-trail.js'
import { createLoginThrottle } from '../server/lib/login-throttle.js'
import { withWriteRetry, resetWriteRetryStats } from '../server/lib/tx.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const tmp = (t, prefix = 'os-erp-mx-') => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const OPS = {
  last_backup: { at: '2026-10-23T11:00:00.000Z', result: 'ok', encrypted: true, age_seconds: 3600 },
  migration_checksums: { mismatched: 0, adopted: 2 },
  login_throttle: 'ok',
  disk_free_bytes: 1234567,
  db_sizes: {}
}
const valueOf = (text, series) => {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `))
  return line === undefined ? undefined : Number(line.slice(series.length + 1))
}

// ------------------------------------------------------------ counters
test('process counters only accept registered names and label values', () => {
  resetCounters()
  incCounter('login_throttle_rejections_total', 'rate_limited')
  incCounter('login_throttle_rejections_total', 'rate_limited')
  incCounter('login_throttle_rejections_total', 'user=alice') // 未登记的 label 值：忽略（防基数/注入）
  incCounter('not_a_metric', 'x')
  const s = counterSnapshot()
  assert.equal(s.login_throttle_rejections_total.rate_limited, 2)
  assert.equal(s.login_throttle_rejections_total.unavailable, 0)
  assert.ok(!('not_a_metric' in s))
  assert.ok(!JSON.stringify(s).includes('alice'))
  resetCounters()
  assert.equal(counterSnapshot().login_throttle_rejections_total.rate_limited, 0)
})

// ------------------------------------------------------------ exposition
test('renderPrometheus: HELP/TYPE per family, os_erp_ prefix, gauges from ops, unknown = -1', () => {
  resetCounters()
  incCounter('audit_strict_write_failures_total', 'insert_error')
  const text = renderPrometheus({
    ops: OPS,
    retry: { calls: 10, retries: 3, exhausted: 1, non_retryable: 2 },
    counters: counterSnapshot(),
    version: '1.2.3'
  })
  assert.ok(text.endsWith('\n'))
  const lines = text.trim().split('\n')
  const families = new Set()
  for (const l of lines) {
    if (l.startsWith('# HELP ')) continue
    if (l.startsWith('# TYPE ')) {
      const [, , name, kind] = l.split(' ')
      assert.match(name, /^os_erp_[a-z0-9_]+$/)
      assert.ok(['counter', 'gauge'].includes(kind))
      families.add(name)
      continue
    }
    assert.match(l, /^os_erp_[a-z0-9_]+(\{[a-z_]+="[^"\\\n]*"(,[a-z_]+="[^"\\\n]*")*\})? -?\d+(\.\d+)?$/, l)
  }
  for (const f of families) {
    assert.ok(text.includes(`# HELP ${f} `), `HELP for ${f}`)
    assert.equal(text.split('\n').filter((l) => l.startsWith(`# TYPE ${f} `)).length, 1)
  }
  for (const name of [
    'os_erp_backup_age_seconds', 'os_erp_backup_last_failed', 'os_erp_backup_missing',
    'os_erp_migration_checksum_mismatches', 'os_erp_login_throttle_unavailable', 'os_erp_disk_free_bytes',
    'os_erp_login_throttle_rejections_total', 'os_erp_audit_strict_write_failures_total',
    'os_erp_security_audit_unavailable_total', 'os_erp_write_retries_total', 'os_erp_write_retry_exhausted_total',
    'os_erp_csp_violation_reports_total', 'os_erp_build_info'
  ]) assert.ok(families.has(name), `family ${name}`)
  assert.equal(valueOf(text, 'os_erp_backup_age_seconds'), 3600)
  assert.equal(valueOf(text, 'os_erp_write_retries_total'), 3)
  assert.equal(valueOf(text, 'os_erp_write_retry_exhausted_total'), 1)
  assert.equal(valueOf(text, 'os_erp_audit_strict_write_failures_total{reason="insert_error"}'), 1)
  assert.equal(valueOf(text, 'os_erp_login_throttle_rejections_total{reason="rate_limited"}'), 0)
  assert.equal(valueOf(text, 'os_erp_csp_violation_reports_total'), 0)
  assert.match(text, /# HELP os_erp_csp_violation_reports_total [^\n]*not collected/i)
  assert.match(text, /os_erp_build_info\{version="1\.2\.3"\} 1/)
  const unknown = renderPrometheus({
    ops: { ...OPS, last_backup: { at: null, result: 'none', encrypted: null, age_seconds: null }, disk_free_bytes: null },
    retry: { calls: 0, retries: 0, exhausted: 0, non_retryable: 0 }, counters: counterSnapshot(), version: 'x'
  })
  assert.equal(valueOf(unknown, 'os_erp_backup_age_seconds'), -1)
  assert.equal(valueOf(unknown, 'os_erp_backup_missing'), 1)
  assert.equal(valueOf(unknown, 'os_erp_disk_free_bytes'), -1)
})

test('renderPrometheus escapes label values', () => {
  const text = renderPrometheus({ ops: OPS, retry: { calls: 0, retries: 0, exhausted: 0, non_retryable: 0 }, counters: counterSnapshot(), version: 'a"b\\c\nd' })
  assert.match(text, /os_erp_build_info\{version="a\\"b\\\\c\\nd"\} 1/)
})

// ------------------------------------------------------------ token
test('metricsTokenOk: disabled unless a long enough token is configured; exact match only', () => {
  const good = randomBytes(24).toString('hex')
  assert.ok(good.length >= METRICS_TOKEN_MIN_LENGTH)
  assert.equal(metricsTokenOk(good, {}), false)
  assert.equal(metricsTokenOk(good, { GML_METRICS_TOKEN: '' }), false)
  assert.equal(metricsTokenOk('short', { GML_METRICS_TOKEN: 'short' }), false, 'too-short token never enables the endpoint')
  assert.equal(metricsTokenOk(good, { GML_METRICS_TOKEN: good }), true)
  assert.equal(metricsTokenOk(good + 'x', { GML_METRICS_TOKEN: good }), false)
  assert.equal(metricsTokenOk(good.slice(0, -1), { GML_METRICS_TOKEN: good }), false)
  assert.equal(metricsTokenOk(good.toUpperCase(), { GML_METRICS_TOKEN: good }), false)
  assert.equal(metricsTokenOk('', { GML_METRICS_TOKEN: good }), false)
  assert.equal(metricsTokenOk(undefined, { GML_METRICS_TOKEN: good }), false)
  assert.equal(metricsTokenOk(['a'], { GML_METRICS_TOKEN: good }), false)
})

test('metricsTokenOk compares fixed-length digests with timingSafeEqual (no === / Buffer.compare on the secret)', () => {
  const src = readFileSync(path.join(ROOT, 'server/lib/metrics-export.js'), 'utf8')
  assert.match(src, /timingSafeEqual/)
  assert.match(src, /createHash\('sha256'\)/)
  assert.ok(!/token\s*(===|!==)/.test(src.replace(/\/\/.*$/gm, '')), 'no direct string compare of the token')
})

// ------------------------------------------------------------ increment sites
test('auditStrictRow counts insert errors, zero-row writes; outside-tx coding errors are not counted as unavailable', () => {
  resetCounters()
  const db = new Database(':memory:')
  db.exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id, user_name, action, module, entity, entity_id, detail, ip)')
  const row = { userName: 'u', action: 'X' }
  db.transaction(() => auditStrictRow(db, row))()
  assert.equal(counterSnapshot().audit_strict_write_failures_total.insert_error, 0)

  db.exec('DROP TABLE audit_logs')
  assert.throws(() => db.transaction(() => auditStrictRow(db, row))(), { code: 'SECURITY_AUDIT_UNAVAILABLE' })
  let s = counterSnapshot()
  assert.equal(s.audit_strict_write_failures_total.insert_error, 1)
  assert.equal(s.security_audit_unavailable_total, 1)

  db.exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id, user_name, action, module, entity, entity_id, detail, ip); CREATE TRIGGER skip BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => db.transaction(() => auditStrictRow(db, row))(), { code: 'SECURITY_AUDIT_UNAVAILABLE' })
  s = counterSnapshot()
  assert.equal(s.audit_strict_write_failures_total.no_row, 1)
  assert.equal(s.security_audit_unavailable_total, 2)

  assert.throws(() => auditStrictRow(db, row), { code: 'AUDIT_OUTSIDE_TX' })
  s = counterSnapshot()
  assert.equal(s.audit_strict_write_failures_total.outside_tx, 1)
  assert.equal(s.security_audit_unavailable_total, 2)
  db.close()
})

test('login throttle rejections increment the rate_limited counter, success paths do not', (t) => {
  resetCounters()
  const dir = tmp(t)
  const limiter = createLoginThrottle({ dataDir: dir, mode: 'test', policy: { accountLimit: 2 } })
  t.after(() => limiter.close())
  const input = { ip: '127.0.0.1', industry: 'cosmetic', username: 'alice' }
  limiter.consumeLoginAttempt(input)
  limiter.consumeLoginAttempt(input)
  assert.equal(counterSnapshot().login_throttle_rejections_total.rate_limited, 0)
  assert.throws(() => limiter.consumeLoginAttempt(input), { code: 'LOGIN_RATE_LIMITED' })
  assert.throws(() => limiter.consumeLoginAttempt(input), { code: 'LOGIN_RATE_LIMITED' })
  assert.equal(counterSnapshot().login_throttle_rejections_total.rate_limited, 2)
})

test('write retries and exhaustion show up in the exposition via writeRetryStats', async () => {
  resetWriteRetryStats()
  const { writeRetryStats } = await import('../server/lib/tx.js')
  const db = new Database(':memory:')
  let n = 0
  withWriteRetry(db, () => { if (++n < 3) throw new Database.SqliteError('busy', 'SQLITE_BUSY') }, { maxAttempts: 4, sleep: () => {}, label: 'mx' })
  assert.throws(() => withWriteRetry(db, () => { throw new Database.SqliteError('busy', 'SQLITE_BUSY') }, { maxAttempts: 2, sleep: () => {}, label: 'mx' }))
  const text = renderPrometheus({ ops: OPS, retry: writeRetryStats(), counters: counterSnapshot(), version: 'x' })
  assert.equal(valueOf(text, 'os_erp_write_retries_total'), 3)
  assert.equal(valueOf(text, 'os_erp_write_retry_exhausted_total'), 1)
  db.close()
  resetWriteRetryStats()
})

// ------------------------------------------------------------ HTTP
async function server(t, extraEnv = {}) {
  const dir = tmp(t, 'os-erp-mx-http-')
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise((r) => probe.close(r))
  const secret = randomBytes(32).toString('hex')
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: secret, ...extraEnv }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false; let output = ''
  child.stdout.on('data', (d) => { output += d; ready ||= d.toString().includes('服务已启动') })
  child.stderr.on('data', (d) => { output += d })
  const stopped = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, `server must start\n${output}`)
  const tokenFor = (username) => {
    const db = new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true })
    const u = db.prepare('SELECT id,username,role,name,auth_version FROM users WHERE username=?').get(username)
    db.close()
    return jwt.sign({ uid: u.id, auth_version: u.auth_version, username: u.username, role: u.role, name: u.name, industry: 'cosmetic' }, secret, { audience: 'gml-erp', algorithm: 'HS256', expiresIn: '1h' })
  }
  const get = (route, token) => fetch(`http://127.0.0.1:${port}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) })
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
  return { dir, get, post, tokenFor, output: () => output }
}
const PROM = '/api/meta/metrics?format=prometheus'

test('GET metrics?format=prometheus: anonymous 401, viewer 403, admin 200 text exposition, JSON format unchanged', { timeout: 180000 }, async (t) => {
  const s = await server(t)
  assert.equal((await s.get(PROM)).status, 401)
  assert.equal((await s.get(PROM, 'not-a-jwt')).status, 401)
  assert.equal((await s.get(PROM, s.tokenFor('viewer'))).status, 403)
  const res = await s.get(PROM, s.tokenFor('admin'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4; charset=utf-8$/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const text = await res.text()
  assert.match(text, /^# HELP os_erp_backup_age_seconds /m)
  assert.match(text, /^# TYPE os_erp_write_retries_total counter$/m)
  assert.equal(valueOf(text, 'os_erp_backup_missing'), 1)
  assert.ok(valueOf(text, 'os_erp_disk_free_bytes') > 0)
  assert.ok(!text.includes(s.dir), 'no filesystem paths')
  assert.ok(!/admin|viewer|jwt|secret|password/i.test(text.replace(/os_erp_\w+/g, '')), 'no account names or secrets')
  // 既有 JSON 形态不变
  const j = await s.get('/api/meta/metrics', s.tokenFor('admin'))
  assert.equal(j.status, 200)
  assert.equal(typeof (await j.json()).data.counters.backup_age_seconds, 'number')
  // 未知 format 不静默回落
  assert.equal((await s.get('/api/meta/metrics?format=bogus', s.tokenFor('admin'))).status, 400)
})

test('GML_METRICS_TOKEN: Bearer token reads the prometheus format only; wrong/short/unset tokens never do; token is never logged', { timeout: 180000 }, async (t) => {
  const token = randomBytes(24).toString('hex')
  const s = await server(t, { GML_METRICS_TOKEN: token })
  const ok = await s.get(PROM, token)
  assert.equal(ok.status, 200)
  assert.match(await ok.text(), /# TYPE os_erp_backup_age_seconds gauge/)
  assert.equal((await s.get(PROM, token.slice(0, -1) + 'x')).status, 401)
  assert.equal((await s.get(PROM, `${token}x`)).status, 401)
  // 令牌不授权 JSON 形态与其它路由
  assert.equal((await s.get('/api/meta/metrics', token)).status, 401)
  assert.equal((await s.get('/api/meta/health', token)).status, 401)
  assert.equal((await s.get('/api/meta/settings', token)).status, 401)
  // admin JWT 仍可用
  assert.equal((await s.get(PROM, s.tokenFor('admin'))).status, 200)
  // 令牌作为查询参数不被接受
  assert.equal((await fetch(`${new URL(ok.url).origin}${PROM}&token=${token}`)).status, 401)
  assert.ok(!s.output().includes(token), 'token must not appear in server output')
})

test('metrics token unset or too short disables the token path', { timeout: 180000 }, async (t) => {
  const none = await server(t)
  assert.equal((await none.get(PROM, 'x'.repeat(40))).status, 401)
  const short = await server(t, { GML_METRICS_TOKEN: 'shortshort' })
  assert.equal((await short.get(PROM, 'shortshort')).status, 401)
})

test('login throttle rejections reach the scrape end to end', { timeout: 180000 }, async (t) => {
  const s = await server(t, { GML_LOGIN_ACCOUNT_LIMIT: '2' })
  const bad = { username: 'nobody', password: 'wrong-password-1', industry: 'cosmetic' }
  assert.equal((await s.post('/api/auth/login', bad)).status, 401)
  assert.equal((await s.post('/api/auth/login', bad)).status, 401)
  assert.equal((await s.post('/api/auth/login', bad)).status, 429)
  const text = await (await s.get(PROM, s.tokenFor('admin'))).text()
  assert.equal(valueOf(text, 'os_erp_login_throttle_rejections_total{reason="rate_limited"}'), 1)
  assert.ok(!text.includes('nobody'))
})
