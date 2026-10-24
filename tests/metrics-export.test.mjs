// ADR-0045：Prometheus 文本指标导出、进程级计数器、令牌鉴权
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import jwt from 'jsonwebtoken'
import { incCounter, counterSnapshot, resetCounters, incMcpToolCall, registerMcpTools, MCP_RESULT_CODES, observeHistogram, histogramSnapshot } from '../server/lib/process-counters.js'
import { createMetricsThrottle } from '../server/lib/metrics-throttle.js'
import { cachedForDb } from '../server/lib/db-ttl-cache.js'
import { insertAuditRow } from '../server/lib/audit-trail.js'
import { renderPrometheus, metricsTokenOk, METRICS_TOKEN_MIN_LENGTH, shutdownSnapshotLine } from '../server/lib/metrics-export.js'
import { createToken } from '../server/mcp/tokens.js'
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
      assert.ok(['counter', 'gauge', 'histogram'].includes(kind))
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
  return { dir, port, get, post, tokenFor, output: () => output }
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

// ------------------------------------------------------------ AB10 supplement
test('AB10 token rotation: GML_METRICS_TOKEN and GML_METRICS_TOKEN_NEXT both accepted; NEXT alone works; short NEXT ignored', () => {
  const a = randomBytes(24).toString('hex')
  const b = randomBytes(24).toString('hex')
  const env = { GML_METRICS_TOKEN: a, GML_METRICS_TOKEN_NEXT: b }
  assert.equal(metricsTokenOk(a, env), true)
  assert.equal(metricsTokenOk(b, env), true)
  assert.equal(metricsTokenOk(a + 'x', env), false)
  assert.equal(metricsTokenOk(b, { GML_METRICS_TOKEN_NEXT: b }), true, 'NEXT works while the old one is already unset')
  assert.equal(metricsTokenOk('short', { GML_METRICS_TOKEN: a, GML_METRICS_TOKEN_NEXT: 'short' }), false)
  assert.equal(metricsTokenOk(b, { GML_METRICS_TOKEN: a, GML_METRICS_TOKEN_NEXT: '' }), false)
  const src = readFileSync(path.join(ROOT, 'server/lib/metrics-export.js'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.ok(!/\bsome\(|\.includes\(presented|===\s*presented/.test(src), 'both candidates are always compared (no early exit on the secret)')
})

test('AB10 dashboard cache hit/miss counters', () => {
  resetCounters()
  const db = new Database(':memory:')
  cachedForDb(db, () => 1, { ttlMs: 1000 })
  cachedForDb(db, () => 1, { ttlMs: 1000 })
  cachedForDb(db, () => 1, { ttlMs: 1000 })
  let s = counterSnapshot().dashboard_cache_total
  assert.deepEqual(s, { hit: 2, miss: 1 })
  cachedForDb(db, () => 1, { ttlMs: 0 }) // 关闭缓存：不计
  s = counterSnapshot().dashboard_cache_total
  assert.deepEqual(s, { hit: 2, miss: 1 })
  db.close()
})

test('AB10 MCP tool call counter: registered tools and codes only, everything else folded (bounded cardinality, no injection)', () => {
  resetCounters()
  registerMcpTools(['stock_query', 'doc_create'])
  assert.equal(counterSnapshot().mcp_tool_calls_total.stock_query.AUDIT_UNAVAILABLE, 0, 'critical series start at 0 so increase() sees the first event')
  incMcpToolCall('stock_query', null)
  incMcpToolCall('stock_query', 'PERM_DENIED')
  incMcpToolCall('doc_create', 'SOME_NEW_CODE')
  incMcpToolCall('evil"}\n# HELP x', 'ok')
  incMcpToolCall('stock_query', 'x"y')
  const m = counterSnapshot().mcp_tool_calls_total
  assert.equal(m.stock_query.ok, 1)
  assert.equal(m.stock_query.PERM_DENIED, 1)
  assert.equal(m.doc_create.other, 1)
  assert.equal(m.unknown.ok, 1)
  assert.equal(m.stock_query.other, 1)
  const text = renderPrometheus({ ops: OPS, retry: {}, counters: counterSnapshot(), version: 'x' })
  assert.equal(valueOf(text, 'os_erp_mcp_tool_calls_total{tool="stock_query",code="PERM_DENIED"}'), 1)
  assert.equal(valueOf(text, 'os_erp_mcp_tool_calls_total{tool="unknown",code="ok"}'), 1)
  assert.ok(!text.includes('evil'))
  assert.match(text, /^# TYPE os_erp_mcp_tool_calls_total counter$/m)
})

test('AB10 audit write latency histogram: fixed buckets, cumulative, +Inf == count; insertAuditRow observes', () => {
  resetCounters()
  observeHistogram('audit_write_duration_seconds', 0.0004)
  observeHistogram('audit_write_duration_seconds', 0.02)
  observeHistogram('audit_write_duration_seconds', 99)
  observeHistogram('nope', 1)
  observeHistogram('audit_write_duration_seconds', Number.NaN)
  const h = histogramSnapshot().audit_write_duration_seconds
  assert.equal(h.count, 3)
  const text = renderPrometheus({ ops: OPS, retry: {}, counters: counterSnapshot(), histograms: histogramSnapshot(), version: 'x' })
  assert.match(text, /^# TYPE os_erp_audit_write_duration_seconds histogram$/m)
  assert.equal(valueOf(text, 'os_erp_audit_write_duration_seconds_bucket{le="0.0005"}'), 1)
  assert.equal(valueOf(text, 'os_erp_audit_write_duration_seconds_bucket{le="0.025"}'), 2)
  assert.equal(valueOf(text, 'os_erp_audit_write_duration_seconds_bucket{le="+Inf"}'), 3)
  assert.equal(valueOf(text, 'os_erp_audit_write_duration_seconds_count'), 3)
  assert.ok(valueOf(text, 'os_erp_audit_write_duration_seconds_sum') > 99)
  resetCounters()
  const db = new Database(':memory:')
  db.exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id, user_name, action, module, entity, entity_id, detail, ip)')
  insertAuditRow(db, { userName: 'u', action: 'X' })
  assert.equal(histogramSnapshot().audit_write_duration_seconds.count, 1)
  db.exec('DROP TABLE audit_logs')
  assert.throws(() => insertAuditRow(db, { userName: 'u', action: 'X' }))
  assert.equal(histogramSnapshot().audit_write_duration_seconds.count, 2, 'failed writes are timed too')
  db.close()
})

test('AB10 metrics throttle: per-IP fixed window, separate buckets, capacity fails closed, bad config falls back', () => {
  let now = 1000
  const th = createMetricsThrottle({ limit: 3, windowMs: 60000, maxBuckets: 2, now: () => now })
  for (let i = 0; i < 3; i++) assert.equal(th.consume('10.0.0.1').allowed, true)
  const blocked = th.consume('10.0.0.1')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60)
  assert.equal(th.consume('10.0.0.2').allowed, true, 'another IP has its own bucket')
  assert.equal(th.consume('10.0.0.3').allowed, false, 'bucket table full of live entries: fail closed')
  now += 60001
  assert.equal(th.consume('10.0.0.1').allowed, true, 'window expired')
  assert.equal(th.consume('::ffff:10.0.0.1').allowed, true, 'v4-mapped shares the v4 bucket')
  const bad = createMetricsThrottle({ env: { GML_METRICS_IP_LIMIT: '0', GML_METRICS_IP_WINDOW_MS: 'x' } })
  assert.equal(bad.policy.limit, 120)
  assert.equal(bad.policy.windowMs, 60000)
  assert.equal(createMetricsThrottle({ env: { GML_METRICS_IP_LIMIT: '7' } }).policy.limit, 7)
  assert.equal(th.consume(undefined).allowed, false, 'unparseable source address is not exempt')
  const z = createMetricsThrottle({ limit: 1, now: () => 1000 })
  assert.equal(z.consume('192.0.2.1%a').allowed, false, 'IPv4 with a zone suffix is not a valid source')
  assert.equal(z.consume('192.0.2.1%b').allowed, false)
})

test('AB10 HTTP: metrics throttled per IP (429 + bizcode + Retry-After), bad tokens count, accepted rotation tokens, new series present', { timeout: 180000 }, async (t) => {
  const a = randomBytes(24).toString('hex')
  const b = randomBytes(24).toString('hex')
  const s = await server(t, { GML_METRICS_TOKEN: a, GML_METRICS_TOKEN_NEXT: b, GML_METRICS_IP_LIMIT: '5', GML_METRICS_IP_WINDOW_MS: '60000' })
  const r1 = await s.get(PROM, a)
  assert.equal(r1.status, 200)
  const text = await r1.text()
  assert.match(text, /^# TYPE os_erp_dashboard_cache_total counter$/m)
  assert.match(text, /^# TYPE os_erp_audit_write_duration_seconds histogram$/m)
  assert.match(text, /^# TYPE os_erp_mcp_tool_calls_total counter$/m)
  assert.equal((await s.get(PROM, b)).status, 200)
  assert.equal((await s.get(PROM, 'wrong')).status, 401)
  assert.equal((await s.get(PROM)).status, 401)
  assert.equal((await s.get(PROM, a)).status, 200)
  const res = await s.get(PROM, a)
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'METRICS_RATE_LIMITED')
  assert.equal(body.detail.code, 'METRICS_RATE_LIMITED')
  assert.ok(Number(res.headers.get('retry-after')) >= 1)
  assert.equal((await s.get('/api/meta/metrics', s.tokenFor('admin'))).status, 429, 'JSON form and admin JWT share the same per-IP bucket')
  assert.ok(!s.output().includes(a) && !s.output().includes(b))
})

// ------------------------------------------------------------ AC9
test('AC9 HTTP: a real MCP tools/call increments os_erp_mcp_tool_calls_total{tool,code} as scraped from /metrics', { timeout: 180000 }, async (t) => {
  const s = await server(t)
  const admin = s.tokenFor('admin')
  const series = (tool, code) => `os_erp_mcp_tool_calls_total{tool="${tool}",code="${code}"}`
  const scrape = async () => valueOf(await (await s.get(PROM, admin)).text(), series('org.tree', 'ok'))
  assert.equal(await scrape(), 0, 'preseeded zero series exists before any call')
  const db = new Database(path.join(s.dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const owner = db.prepare("SELECT id FROM users WHERE username='admin'").get().id
  const { token } = createToken(db, { name: 'ac9-e2e', ownerUserId: owner, industry: 'cosmetic', scopes: 'read' })
  const call = async (name, args = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15000)
    })
    return res.json()
  }
  const r1 = await call('org.tree')
  assert.ok(!r1.error && !r1.result?.isError, JSON.stringify(r1).slice(0, 300))
  assert.equal(await scrape(), 1)
  await call('org.tree')
  assert.equal(await scrape(), 2)
  // 未知工具名折成 tool="unknown"，不会为用户可控字符串造新序列
  await call('no.such_tool_ac9')
  const text = await (await s.get(PROM, admin)).text()
  assert.ok(!text.includes('no.such_tool_ac9'))
  assert.equal(valueOf(text, series('org.tree', 'ok')), 2)
})

test('AC9 shutdownSnapshotLine: one JSON line with counters and histograms, no ops/paths, never throws', () => {
  resetCounters()
  registerMcpTools(['org.tree'])
  incMcpToolCall('org.tree', null)
  const line = shutdownSnapshotLine({ counters: counterSnapshot(), histograms: histogramSnapshot(), retry: { calls: 1, retries: 0, exhausted: 0, non_retryable: 0 }, now: () => new Date('2026-10-24T00:00:00.000Z') })
  assert.ok(!line.includes('\n'))
  const o = JSON.parse(line)
  assert.equal(o.msg, 'metrics_snapshot')
  assert.equal(o.event, 'shutdown')
  assert.equal(o.ts, '2026-10-24T00:00:00.000Z')
  assert.equal(o.counters.mcp_tool_calls_total['org.tree'].ok, 1)
  assert.ok(o.histograms.audit_write_duration_seconds)
  assert.equal(o.retry.calls, 1)
  const bad = JSON.parse(shutdownSnapshotLine({ counters: { get x() { throw new Error('boom') } }, now: () => new Date(0) }))
  assert.equal(bad.msg, 'metrics_snapshot_failed')
  resetCounters()
})

test('AC9 SIGTERM: a server we spawn writes a one-line JSON metrics snapshot to the log and exits cleanly', { timeout: 180000 }, async (t) => {
  const dir = tmp(t, 'os-erp-mx-term-')
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise((r) => probe.close(r))
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex') }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const closed = once(child, 'close')
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  for (let i = 0; i < 1200 && !out.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(out.includes('服务已启动'), out)
  assert.ok(!out.includes('"msg":"metrics_snapshot"'), 'no snapshot before shutdown')
  child.kill('SIGTERM')
  const [code, signal] = await closed
  assert.equal(signal, null, 'handler exits on its own instead of dying from the signal')
  assert.equal(code, 0)
  const lines = out.split('\n').filter((l) => l.includes('"msg":"metrics_snapshot"'))
  assert.equal(lines.length, 1)
  const o = JSON.parse(lines[0])
  assert.equal(o.event, 'shutdown')
  assert.equal(typeof o.counters.dashboard_cache_total.hit, 'number')
  assert.ok(Array.isArray(o.histograms.audit_write_duration_seconds.buckets))
  assert.ok(!lines[0].includes(dir), 'no filesystem paths in the snapshot')
})

test('AC9 alert rule files: docs/operations/alerts/*.yml exist, monitoring.md points at them, every referenced series is exported', () => {
  const dir = path.join(ROOT, 'docs/operations/alerts')
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()
  assert.ok(files.length >= 2, files.join())
  const doc = readFileSync(path.join(ROOT, 'docs/operations/monitoring.md'), 'utf8')
  assert.ok(!/^\s*- alert: /m.test(doc), 'rules live in alerts/*.yml, not inline in monitoring.md')
  for (const f of files) assert.ok(doc.includes(`alerts/${f}`), `monitoring.md must reference ${f}`)
  resetCounters()
  registerMcpTools(['org.tree'])
  const exported = renderPrometheus({ ops: OPS, retry: { calls: 0, retries: 0, exhausted: 0, non_retryable: 0 }, counters: counterSnapshot(), histograms: histogramSnapshot(), version: '1.0.0' })
  const names = new Set([...exported.matchAll(/^# TYPE (os_erp_[a-z0-9_]+) /gm)].map((m) => m[1]))
  const alerts = []
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8')
    assert.match(text, /^groups:\s*$/m, `${f}: groups`)
    for (const m of text.matchAll(/^\s*- alert: (\w+)\s*$/gm)) alerts.push(m[1])
    // 每条规则都有 expr 与 severity 标签
    const nAlert = [...text.matchAll(/^\s*- alert: /gm)].length
    assert.equal([...text.matchAll(/^\s*expr: /gm)].length, nAlert, `${f}: one expr per alert`)
    assert.equal([...text.matchAll(/severity: (critical|warning|info)/g)].length, nAlert, `${f}: one severity per alert`)
    const expr = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    for (const m of expr.matchAll(/\bos_erp_[a-z0-9_]+/g)) {
      const base = m[0].replace(/_(bucket|sum|count)$/, '')
      assert.ok(names.has(m[0]) || names.has(base), `${f}: ${m[0]} is not an exported series`)
    }
  }
  assert.equal(new Set(alerts).size, alerts.length, 'alert names unique')
  assert.equal(alerts.length, 13) // 6 + AB10 的 4 + AD9 的 1 + AE9 的 1 + AF9 的 1
  // 引用 label 值必须是登记的封闭集合成员
  const all = files.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n')
  for (const m of all.matchAll(/os_erp_mcp_tool_calls_total\{code(=~?)"([^"]+)"\}/g)) {
    for (const c of m[2].split('|')) assert.ok(MCP_RESULT_CODES.includes(c), `unknown MCP code ${c}`)
  }
  resetCounters()
})
