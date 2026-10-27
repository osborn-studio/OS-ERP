// AG9（ADR-0056 补充 3）：迁移 075（kind 增 denied，表重建）、db 模式拒绝行的精确 429 计数、GET /api/mcp/limits/quota、告警阈值推导文档。
// 单元部分用内存库 + 注入时钟；集成部分在全新临时数据目录 + 随机回环端口上起服务（GML_RUNTIME_MODE=test）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createToken } from '../server/mcp/tokens.js'
import { createMcpRateLimiter, recentLimitedByToken, mcpRatePolicy, dailyQuotaUsage } from '../server/lib/mcp-rate-limit.js'
import { COUNTER_DEFS, counterSnapshot } from '../server/lib/process-counters.js'

const require = createRequire(import.meta.url)
const M073 = require('../server/db/migrations/073_mcp_rate_buckets.cjs')
const M075 = require('../server/db/migrations/075_mcp_rate_denied_kind.cjs')
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const W = 60_000
const T0 = 2_000_000_000 - (2_000_000_000 % W) + 10_000
const DB_ENV = { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '2', GML_MCP_WRITE_RPM: '1' }

function newDb() { const db = new Database(':memory:'); M073.up(db); M075.up(db); return db }
const deniedRows = (db, key = 'cosmetic|1') => db.prepare("SELECT window_start ws, count FROM mcp_rate_buckets WHERE token_key=? AND kind='denied' ORDER BY ws").all(key)

test('migration 075: fresh up allows denied; idempotent; verify matches up; 073 table with old CHECK needs the rebuild', () => {
  const db = new Database(':memory:')
  assert.equal(M075.verify(db), false, 'no table yet')
  M073.up(db)
  assert.equal(M075.verify(db), false, 'old CHECK rejects denied')
  assert.throws(() => db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'denied',1)").run(), /CHECK/)
  M075.up(db)
  M075.up(db)
  assert.equal(M075.verify(db), true)
  db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'denied',1)").run()
  assert.throws(() => db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'bogus',1)").run(), /CHECK/)
  assert.throws(() => db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'all',-1)").run(), /CHECK/)
  assert.equal(M073.verify(db), true, '073 verify still holds after the rebuild (columns, PK, index)')
  db.exec('DROP INDEX idx_mcp_rate_buckets_window')
  assert.equal(M075.verify(db), false, 'index drift detected')
  M075.up(db)
  assert.equal(M075.verify(db), true)
  db.close()
})

test('migration 075: rebuild keeps every pre-existing row, the PK, the index and leaves no scratch table', () => {
  const db = new Database(':memory:')
  M073.up(db)
  const put = db.prepare('INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,?)')
  const rows = []
  for (let i = 1; i <= 50; i++) { for (const kind of ['all', 'write']) { put.run(`cosmetic|${i}`, T0, kind, i); rows.push([`cosmetic|${i}`, T0, kind, i]) } }
  const before = db.prepare('SELECT * FROM mcp_rate_buckets ORDER BY token_key, window_start, kind').all()
  M075.up(db)
  const after = db.prepare('SELECT * FROM mcp_rate_buckets ORDER BY token_key, window_start, kind').all()
  assert.deepEqual(after, before)
  assert.equal(after.length, 100)
  assert.throws(() => put.run('cosmetic|1', T0, 'all', 1), /UNIQUE|PRIMARY/, 'PK survived')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_rate_buckets%'").all().length, 1, 'no scratch table left')
  assert.equal(M075.verify(db), true)
  db.close()
})

test('migration 075: DDL is transactional - a failure after up rolls the table back to the old, intact shape', () => {
  const db = new Database(':memory:')
  M073.up(db)
  db.prepare("INSERT INTO mcp_rate_buckets VALUES ('cosmetic|1',?, 'all', 4)").run(T0)
  assert.throws(() => db.transaction(() => { M075.up(db); throw new Error('boom') })(), /boom/)
  assert.equal(M075.verify(db), false)
  assert.equal(db.prepare('SELECT count FROM mcp_rate_buckets').get().count, 4)
  assert.equal(M073.verify(db), true)
  // a leftover scratch table from some earlier manual attempt does not break the rebuild
  db.exec('CREATE TABLE mcp_rate_buckets_new (junk INTEGER)')
  M075.up(db)
  assert.equal(M075.verify(db), true)
  assert.equal(db.prepare('SELECT count FROM mcp_rate_buckets').get().count, 4)
  db.close()
})

test('db mode: a refused call records one denied row increment per refusal; allowed calls record none; admission is unchanged', () => {
  const db = newDb()
  let t = T0
  const l = createMcpRateLimiter({ env: DB_ENV, now: () => t })
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true)
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true)
  assert.deepEqual(deniedRows(db), [])
  for (let i = 1; i <= 5; i++) {
    const d = l.consume(1, 'read', 'cosmetic', db)
    assert.deepEqual([d.allowed, d.reason], [false, 'rpm'])
    assert.deepEqual(deniedRows(db), [{ ws: T0 - (T0 % W), count: i }])
  }
  // write-limit refusal is a denial too, and counts under the same kind
  const l2 = createMcpRateLimiter({ env: { ...DB_ENV, GML_MCP_TOKEN_RPM: '50' }, now: () => t })
  assert.equal(l2.consume(2, 'write', 'cosmetic', db).allowed, true)
  assert.equal(l2.consume(2, 'write', 'cosmetic', db).reason, 'write_rpm')
  assert.deepEqual(deniedRows(db, 'cosmetic|2'), [{ ws: T0 - (T0 % W), count: 1 }])
  // denied rows never count against the budget: the all/write counts are still exactly the admitted calls
  assert.equal(db.prepare("SELECT count FROM mcp_rate_buckets WHERE token_key='cosmetic|1' AND kind='all'").get().count, 2)
  assert.equal(db.prepare("SELECT count FROM mcp_rate_buckets WHERE token_key='cosmetic|1' AND kind='write'").get(), undefined)
  // next window: admission reads only all/write rows (a denied row must not break or inflate the sliding estimate)
  t += 2 * W + 1_000
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true)
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true)
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, false)
  // store_unavailable (no table) records nothing and does not throw
  const bare = new Database(':memory:')
  const d = l.consume(1, 'read', 'cosmetic', bare)
  assert.equal(d.reason, 'store_unavailable')
  db.close(); bare.close()
})

test('db mode: a denied-row write failure never changes the 429 (reason stays rpm), is counted, and the next call is still decided normally', () => {
  assert.ok(COUNTER_DEFS.mcp_rate_store_failures_total.values.includes('denied_write_failed'))
  const db = newDb()
  const t = T0
  const l = createMcpRateLimiter({ env: DB_ENV, now: () => t })
  l.consume(1, 'read', 'cosmetic', db); l.consume(1, 'read', 'cosmetic', db)
  db.exec("CREATE TRIGGER no_denied BEFORE INSERT ON mcp_rate_buckets WHEN NEW.kind='denied' BEGIN SELECT RAISE(ABORT,'denied write blocked'); END")
  const snap = () => JSON.stringify(counterSnapshot())
  const before = snap()
  const d = l.consume(1, 'read', 'cosmetic', db)
  assert.deepEqual([d.allowed, d.reason], [false, 'rpm'], 'still the rate-limit refusal, not store_unavailable')
  assert.ok(d.retryAfter >= 1 && d.retryAfter <= 60)
  assert.notEqual(snap(), before, 'failure counter moved')
  assert.deepEqual(deniedRows(db), [])
  // the blocked insert did not poison the connection: it is not left in a transaction
  assert.equal(db.inTransaction, false)
  db.exec('DROP TRIGGER no_denied')
  assert.equal(l.consume(1, 'read', 'cosmetic', db).reason, 'rpm')
  assert.deepEqual(deniedRows(db), [{ ws: T0 - (T0 % W), count: 1 }])
  // a table that still has the old CHECK (migration 075 not applied) behaves the same: refusal intact, no row
  const old = new Database(':memory:'); M073.up(old)
  const l3 = createMcpRateLimiter({ env: DB_ENV, now: () => t })
  l3.consume(1, 'read', 'cosmetic', old); l3.consume(1, 'read', 'cosmetic', old)
  assert.equal(l3.consume(1, 'read', 'cosmetic', old).reason, 'rpm')
  db.close(); old.close()
})

test('db mode: the denied write restores busy_timeout and returns quickly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ag9-lock-'))
  try {
    const a = new Database(path.join(dir, 'x.db')); a.pragma('journal_mode = WAL'); M073.up(a); M075.up(a)
    const l = createMcpRateLimiter({ env: DB_ENV, now: () => T0 })
    l.consume(1, 'read', 'cosmetic', a); l.consume(1, 'read', 'cosmetic', a)
    const busyBefore = a.pragma('busy_timeout', { simple: true })
    const t0 = Date.now()
    assert.equal(l.consume(1, 'read', 'cosmetic', a).reason, 'rpm')
    assert.equal(a.pragma('busy_timeout', { simple: true }), busyBefore)
    assert.ok(Date.now() - t0 < 2500)
    a.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recentLimitedByToken: exact denied counts over current + previous window, per token, scoped, never older, ceiling rows no longer count', () => {
  const db = newDb()
  const ws = T0 - (T0 % W)
  const p = mcpRatePolicy({ GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '3', GML_MCP_WRITE_RPM: '2' })
  const put = db.prepare('INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,?)')
  put.run('cosmetic|1', ws, 'denied', 5)
  put.run('cosmetic|1', ws - W, 'denied', 3)
  put.run('cosmetic|1', ws - 2 * W, 'denied', 99) // 太旧
  put.run('cosmetic|2', ws, 'all', 3) // 触顶但没有拒绝行：不再算
  put.run('cosmetic|3', ws, 'denied', 1)
  put.run('other|4', ws, 'denied', 99) // 别的库
  const m = recentLimitedByToken(db, { scope: 'cosmetic', policy: p, now: () => T0 })
  assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [[1, 8], [3, 1]])
  db.close()
})

test('dailyQuotaUsage: today counts per active token like dailyQuotaState; ranks before capping; excludes revoked/expired; null on read failure', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE agent_tokens (id INTEGER PRIMARY KEY, name TEXT, status TEXT, expires_at TEXT);
           CREATE TABLE mcp_call_logs (id INTEGER PRIMARY KEY, token_id INTEGER, created_at TEXT)`)
  const tok = db.prepare('INSERT INTO agent_tokens (id, name, status, expires_at) VALUES (?,?,?,?)')
  for (let i = 1; i <= 5; i++) tok.run(i, `t${i}`, 'active', null)
  tok.run(6, 't6', 'revoked', null)
  tok.run(7, 't7', 'active', '2000-01-01 00:00:00')
  tok.run(8, 't8', 'active', '2999-01-01 00:00:00')
  const ins = db.prepare('INSERT INTO mcp_call_logs (token_id, created_at) VALUES (?, ?)')
  const today = db.prepare("SELECT datetime('now','localtime') v").get().v
  const yesterday = db.prepare("SELECT datetime('now','localtime','-1 day') v").get().v
  ins.run(1, today); ins.run(1, today); ins.run(2, today); ins.run(1, yesterday); ins.run(6, today); ins.run(7, today)
  for (let i = 0; i < 4; i++) ins.run(5, today) // 最大 id 但用量最多
  const all = dailyQuotaUsage(db)
  assert.deepEqual(all.rows.map((r) => [r.id, r.used]), [[5, 4], [1, 2], [2, 1], [3, 0], [4, 0], [8, 0]])
  assert.equal(all.truncated, false)
  const cut = dailyQuotaUsage(db, { cap: 2 })
  assert.deepEqual(cut.rows.map((r) => r.id), [5, 1], 'busiest survive the cap even with the largest id')
  assert.equal(cut.truncated, true)
  assert.equal(dailyQuotaUsage(new Database(':memory:')), null, 'missing tables => null, never throws')
  db.close()
})

async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ag9-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex'), ...extraEnv
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 2400 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  const get = async (p, token) => {
    const r = await fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) })
    return { status: r.status, body: await r.json() }
  }
  const login = async (username, password) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, industry: 'cosmetic' })
    }).then((x) => x.json())
    return r.data.token
  }
  const mcpCall = async (token) => (await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'org.tree', arguments: {} } }),
    signal: AbortSignal.timeout(15000)
  })).status
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { get, login, mcpCall, db, base }
}
const setQuota = (db, n) => db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('mcp_token_daily_quota',?,datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n))

test('live server: migration 075 applied; 429s are counted exactly in /limits/tokens', { timeout: 120000 }, async (t) => {
  const f = await server(t, DB_ENV)
  const admin = await f.login('admin', '12345')
  assert.equal(M075.verify(f.db), true)
  assert.ok(f.db.prepare("SELECT 1 FROM schema_migrations WHERE id='075_mcp_rate_denied_kind'").get())
  const busy = createToken(f.db, { name: 'tok-busy', scopes: 'read' })
  const quiet = createToken(f.db, { name: 'tok-quiet', scopes: 'read' })
  assert.equal(await f.mcpCall(busy.token), 200)
  assert.equal(await f.mcpCall(busy.token), 200)
  for (let i = 0; i < 5; i++) assert.equal(await f.mcpCall(busy.token), 429)
  assert.equal(await f.mcpCall(quiet.token), 200)
  const r = await f.get('/api/mcp/limits/tokens', admin)
  const byName = Object.fromEntries(r.body.data.tokens.map((x) => [x.name, x]))
  assert.equal(byName['tok-busy'].rate_limited_recent, 5, 'exact, not a window count capped at 2')
  assert.equal(byName['tok-quiet'].rate_limited_recent, 0)
})

test('GET /api/mcp/limits/quota: empty when quota is off; per active token used/remaining when on; admin only; no token material', { timeout: 120000 }, async (t) => {
  const f = await server(t)
  const admin = await f.login('admin', '12345')
  const a = createToken(f.db, { name: 'tok-a', scopes: 'read' })
  const b = createToken(f.db, { name: 'tok-b', scopes: 'read' })
  const dead = createToken(f.db, { name: 'tok-dead', scopes: 'read' })
  f.db.prepare("UPDATE agent_tokens SET status='revoked' WHERE id=?").run(dead.id)
  let r = await f.get('/api/mcp/limits/quota', admin)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data, { daily_quota: 0, enabled: false, usage_unavailable: false, truncated: false, next_cursor: null, tokens: [] })
  setQuota(f.db, 5)
  assert.equal(await f.mcpCall(a.token), 200)
  assert.equal(await f.mcpCall(a.token), 200)
  assert.equal(await f.mcpCall(b.token), 200)
  r = await f.get('/api/mcp/limits/quota', admin)
  const d = r.body.data
  assert.deepEqual(Object.keys(d).sort(), ['daily_quota', 'enabled', 'next_cursor', 'tokens', 'truncated', 'usage_unavailable'])
  assert.equal(d.daily_quota, 5)
  assert.equal(d.enabled, true)
  const by = Object.fromEntries(d.tokens.map((x) => [x.name, x]))
  assert.deepEqual(Object.keys(by['tok-a']).sort(), ['id', 'name', 'remaining', 'used'])
  assert.deepEqual([by['tok-a'].used, by['tok-a'].remaining], [2, 3])
  assert.deepEqual([by['tok-b'].used, by['tok-b'].remaining], [1, 4])
  assert.ok(!by['tok-dead'], 'revoked tokens are not listed')
  assert.equal(d.tokens[0].name, 'tok-a', 'most used first')
  const raw = JSON.stringify(r.body)
  assert.ok(!raw.includes(a.token) && !raw.includes(b.token) && !/token_hash|token_prefix/.test(raw))
  // exhaust: remaining floors at 0
  for (let i = 0; i < 3; i++) await f.mcpCall(a.token)
  assert.equal(await f.mcpCall(a.token), 429)
  r = await f.get('/api/mcp/limits/quota', admin)
  const a2 = r.body.data.tokens.find((x) => x.name === 'tok-a')
  assert.equal(a2.remaining, 0)
  assert.ok(a2.used >= 5)
  // audit table unreadable => honest 'unavailable', never "all quota remaining"
  f.db.exec('ALTER TABLE mcp_call_logs RENAME TO mcp_call_logs_gone')
  r = await f.get('/api/mcp/limits/quota', admin)
  f.db.exec('ALTER TABLE mcp_call_logs_gone RENAME TO mcp_call_logs')
  assert.deepEqual([r.body.data.usage_unavailable, r.body.data.tokens.length], [true, 0])
  // authz
  const pw = randomBytes(24).toString('base64url')
  const created = await fetch(`${f.base}/api/auth/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ username: 'quota_plain', name: 'quota_plain', role: 'purchase', password: pw })
  })
  assert.equal(created.status, 200)
  assert.equal((await f.get('/api/mcp/limits/quota', await f.login('quota_plain', pw))).status, 403)
  assert.equal((await f.get('/api/mcp/limits/quota')).status, 401)
})

test('docs: ADR supplement 3, monitoring threshold derivation, openapi route', () => {
  const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
  const mon = read('docs/operations/monitoring.md')
  assert.match(mon, /OsErpMcpRateStoreWaitHigh[\s\S]*阈值怎么来的（AG9/)
  assert.match(mon, /\/api\/mcp\/limits\/quota/)
  const api = read('server/openapi.js')
  assert.match(api, /'\/api\/mcp\/limits\/quota'/)
  assert.ok(!/不是 429 精确次数|不是 429 的精确次数/.test(api), 'proxy wording removed')
  const adr = read('docs/implementation/ADR-0056-mcp-rate-limit-quota.md')
  assert.match(adr, /## 补充 3（AG9/)
})
