// ADR-0056 补充 / AE9：GML_MCP_RATE_STORE=db —— 限速计数落 SQLite（迁移 073），跨进程共享、重启不清零。
// 单元部分用内存库 + 注入时钟；两进程部分在同一临时数据目录上起两台服务（随机回环端口，GML_RUNTIME_MODE=test）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createToken } from '../server/mcp/tokens.js'
import { createMcpRateLimiter } from '../server/lib/mcp-rate-limit.js'
import { COUNTER_DEFS } from '../server/lib/process-counters.js'
import { TABLES } from '../server/db/seed.js'

const require = createRequire(import.meta.url)
const M073 = require('../server/db/migrations/073_mcp_rate_buckets.cjs')
const ROOT = fileURLToPath(new URL('../', import.meta.url))

function memDb() {
  const db = new Database(':memory:')
  M073.up(db)
  return db
}
const W = 60_000

test('migration 073: up is idempotent, verify matches up, drift is detected', () => {
  const db = new Database(':memory:')
  assert.equal(M073.verify(db), false, 'no table yet')
  M073.up(db)
  M073.up(db)
  assert.equal(M073.verify(db), true)
  db.exec('DROP INDEX idx_mcp_rate_buckets_window')
  assert.equal(M073.verify(db), false)
  M073.up(db)
  assert.equal(M073.verify(db), true)
  assert.throws(() => db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'bogus',1)").run(), /CHECK/)
  assert.throws(() => db.prepare("INSERT INTO mcp_rate_buckets VALUES ('x',0,'all',-1)").run(), /CHECK/)
  db.close()
})

test('seed registry declares mcp_rate_buckets; counter is registered', () => {
  assert.ok(TABLES.includes('mcp_rate_buckets'))
  assert.ok(COUNTER_DEFS.mcp_rate_store_failures_total)
  assert.ok(COUNTER_DEFS.mcp_rate_store_failures_total.values.includes('write_failed'))
})

test('GML_MCP_RATE_STORE: default memory, db accepted, anything else throws', () => {
  assert.equal(createMcpRateLimiter({ env: {} }).policy.store, 'memory')
  assert.equal(createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'memory' } }).policy.store, 'memory')
  assert.equal(createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' } }).policy.store, 'db')
  for (const bad of ['DB', 'redis', ' db', 'true', '0']) {
    assert.throws(() => createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: bad } }), (e) => e.code === 'MCP_RATE_STORE_INVALID', bad)
  }
})

test('db mode: same semantics as memory (limit, write limit, sliding window, retryAfter)', () => {
  const db = memDb()
  let t = 2_000_000_000 - (2_000_000_000 % W) + 10_000
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '3', GML_MCP_WRITE_RPM: '2' }, now: () => t })
  for (let i = 0; i < 2; i++) assert.equal(l.consume(1, 'write', 'cosmetic', db).allowed, true)
  const w = l.consume(1, 'write', 'cosmetic', db)
  assert.deepEqual([w.allowed, w.reason], [false, 'write_rpm'])
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true, 'refused write took no read budget')
  const r = l.consume(1, 'read', 'cosmetic', db)
  assert.deepEqual([r.allowed, r.reason], [false, 'rpm'])
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60)
  assert.equal(l.consume(2, 'read', 'cosmetic', db).allowed, true, 'other token has its own budget')
  assert.equal(l.consume(1, 'read', 'other', db).allowed, true, 'scope isolates')
  // refused calls write nothing
  const row = db.prepare("SELECT count FROM mcp_rate_buckets WHERE token_key='cosmetic|1' AND kind='all'").get()
  assert.equal(row.count, 3)
  t += W + 1_000
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, false, 'sliding: previous window still weighs in right after the boundary')
  t += W
  assert.equal(l.consume(1, 'read', 'cosmetic', db).allowed, true, 'budget returns after two windows')
  db.close()
})

test('db mode: burst across the window boundary does not double the budget', () => {
  const db = memDb()
  let t = 3_000_000_000 - (3_000_000_000 % W) + 59_000
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '3' }, now: () => t })
  for (let i = 0; i < 3; i++) assert.equal(l.consume(1, 'read', '', db).allowed, true)
  t += 2_000
  assert.equal(l.consume(1, 'read', '', db).allowed, false)
  db.close()
})

test('db mode: counts survive a "restart" (new limiter, same db) and are shared by two limiters on one file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-rate-db-'))
  try {
    const file = path.join(dir, 'x.db')
    const a = new Database(file); const b = new Database(file)
    for (const d of [a, b]) { d.pragma('journal_mode=WAL'); d.pragma('busy_timeout=5000'); M073.up(d) }
    const t = 4_000_000_000 - (4_000_000_000 % W) + 1_000
    const env = { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '4' }
    const l1 = createMcpRateLimiter({ env, now: () => t })
    const l2 = createMcpRateLimiter({ env, now: () => t })
    assert.equal(l1.consume(9, 'read', 's', a).allowed, true)
    assert.equal(l2.consume(9, 'read', 's', b).allowed, true)
    assert.equal(l1.consume(9, 'read', 's', a).allowed, true)
    const l3 = createMcpRateLimiter({ env, now: () => t }) // 重启后的新实例
    assert.equal(l3.consume(9, 'read', 's', b).allowed, true)
    assert.equal(l3.consume(9, 'read', 's', b).allowed, false)
    assert.equal(l1.consume(9, 'read', 's', a).allowed, false)
    a.close(); b.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('db mode: write failure fails closed with store_unavailable and increments the counter; invalid token/scope/db also refused', async () => {
  const { counterSnapshot } = await import('../server/lib/process-counters.js')
  const before = JSON.stringify(counterSnapshot())
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' }, now: () => 5_000_000 })
  const noTable = new Database(':memory:')
  const r = l.consume(1, 'read', '', noTable)
  assert.deepEqual([r.allowed, r.reason], [false, 'store_unavailable'])
  assert.ok(r.retryAfter >= 1)
  assert.notEqual(JSON.stringify(counterSnapshot()), before, 'counter moved')
  assert.equal(l.consume(1, 'read', '', undefined).reason, 'store_unavailable', 'missing db handle')
  const ok = memDb()
  assert.equal(l.consume(0, 'read', '', ok).reason, 'unavailable')
  assert.equal(l.consume(1.5, 'read', '', ok).reason, 'unavailable')
  assert.equal(ok.prepare('SELECT COUNT(*) c FROM mcp_rate_buckets').get().c, 0)
  noTable.close(); ok.close()
})

test('db mode: a write failure on the write kind rolls the whole call back (no half-recorded all-count)', () => {
  const db = memDb()
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' }, now: () => 6_000_000 })
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON mcp_rate_buckets WHEN NEW.kind='write' BEGIN SELECT RAISE(ABORT,'boom'); END")
  const r = l.consume(1, 'write', '', db)
  assert.equal(r.reason, 'store_unavailable')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mcp_rate_buckets').get().c, 0, 'transaction rolled back')
  db.close()
})

test('purge: removes only buckets older than the previous window (with margin), never the live ones; never throws', () => {
  const db = memDb()
  const now = 7_000_000_000
  const ws = now - (now % W)
  const ins = db.prepare('INSERT INTO mcp_rate_buckets VALUES (?,?,?,1)')
  ins.run('a', ws, 'all'); ins.run('a', ws - W, 'all'); ins.run('a', ws - 2 * W, 'all'); ins.run('a', ws - 3 * W, 'all'); ins.run('b', ws - 10 * W, 'write')
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' }, now: () => now })
  const out = l.purge(db)
  assert.equal(out.deleted, 2)
  const left = db.prepare('SELECT window_start w FROM mcp_rate_buckets ORDER BY w').all().map((r) => r.w)
  assert.deepEqual(left, [ws - 2 * W, ws - W, ws])
  db.close()
  const bad = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' }, now: () => now })
  assert.doesNotThrow(() => bad.purge(new Database(':memory:')))
  assert.equal(bad.purge(new Database(':memory:')).failed, true)
  assert.deepEqual(createMcpRateLimiter({ env: {}, now: () => now }).purge(memDb()), { deleted: 0, skipped: true })
})

// ---- 两进程 --------------------------------------------------------------
async function startServer(t, dir, extraEnv = {}) {
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
  const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped }
  t.after(stop)
  for (let i = 0; i < 2400 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `server must become ready:\n${output.slice(-2000)}`)
  let seq = 0
  const call = async (token, name = 'org.tree') => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: {} } }),
      signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, headers: res.headers, body: await res.json() }
  }
  const metrics = async () => {
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' })
    }).then((r) => r.json())
    return (await fetch(`http://127.0.0.1:${port}/api/meta/metrics?format=prometheus`, { headers: { authorization: `Bearer ${login.data.token}` } })).text()
  }
  return { call, metrics, stop }
}

test('two server processes on one data dir share the limit; it survives restart; store failure fails closed', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-rs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '6', GML_MCP_WRITE_RPM: '6' }
  const a = await startServer(t, dir, env)
  const b = await startServer(t, dir, env)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.pragma('busy_timeout=5000')
  t.after(() => db.close())
  const token = createToken(db, { name: 'rate-db', scopes: 'read,write' }).token
  assert.ok(token, 'token created')
  // 3 次走 A，3 次走 B：合计 6 = 额度；第 7 次无论走哪台都 429
  for (let i = 0; i < 3; i++) assert.equal((await a.call(token)).status, 200, `a ${i}`)
  for (let i = 0; i < 3; i++) assert.equal((await b.call(token)).status, 200, `b ${i}`)
  const ra = await a.call(token)
  const rb = await b.call(token)
  assert.equal(ra.status, 429); assert.equal(rb.status, 429)
  assert.ok(Number(ra.headers.get('retry-after')) >= 1)
  assert.equal(JSON.parse(ra.body.result.content[0].text).detail.reason, 'rpm')
  // 重启 A：额度仍用完
  await a.stop()
  const a2 = await startServer(t, dir, env)
  assert.equal((await a2.call(token)).status, 429, 'limit survives restart')
  // 破坏存储：fail closed + 计数
  db.exec('ALTER TABLE mcp_rate_buckets RENAME TO mcp_rate_buckets_x')
  const bad = await b.call(token)
  assert.equal(bad.status, 429)
  const detail = JSON.parse(bad.body.result.content[0].text).detail
  assert.equal(detail.reason, 'store_unavailable')
  assert.match(await b.metrics(), /os_erp_mcp_rate_store_failures_total\{reason="write_failed"\} [1-9]/)
  db.exec('ALTER TABLE mcp_rate_buckets_x RENAME TO mcp_rate_buckets')
})

test('atomicity: 4 processes hammering one db file never admit more than the limit (exactly rpm allowed)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-rate-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'race.db')
  const init = new Database(file); init.pragma('journal_mode=WAL'); M073.up(init); init.close()
  const limiterUrl = new URL('../server/lib/mcp-rate-limit.js', import.meta.url).href
  const worker = `
    import Database from 'better-sqlite3'
    import { createMcpRateLimiter } from ${JSON.stringify(limiterUrl)}
    const db = new Database(${JSON.stringify(file)}); db.pragma('busy_timeout=10000')
    const t0 = 8_000_000_000 - (8_000_000_000 % 60000) + 1000
    const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '100' }, now: () => t0 })
    let ok = 0
    for (let i = 0; i < 50; i++) if (l.consume(1, 'read', 's', db).allowed) ok++
    process.stdout.write(String(ok))`
  const outs = await Promise.all([0, 1, 2, 3].map(async () => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', worker], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''; let e = ''
    c.stdout.on('data', (d) => { o += d }); c.stderr.on('data', (d) => { e += d })
    const [code] = await once(c, 'close')
    assert.equal(code, 0, e.slice(-500))
    return Number(o)
  }))
  assert.equal(outs.reduce((a, b) => a + b, 0), 100)
})

test('purge timer is registered only for db mode, unref()ed, and outside the request path', async () => {
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  assert.match(idx, /if \(mcpRateStore === 'db'\) \{[\s\S]*setInterval[\s\S]*purgeMcpRateBuckets[\s\S]*unref\(\)/)
  const srv = readFileSync(path.join(ROOT, 'server/mcp/server.js'), 'utf8')
  assert.equal((srv.match(/\.purge\(/g) || []).length, 1, 'only the exported wrapper references purge; no call on the request path')
})

test('Codex high: time/window are read inside the write lock on every attempt (a window rollover while waiting for the lock cannot over-admit)', () => {
  const db = memDb()
  let t = 60_000 - 1 // 窗口 0 的最后一毫秒
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '1' }, now: () => t })
  const real = db.transaction.bind(db)
  db.transaction = (fn) => {
    const tx = real(fn)
    // 模拟"等写锁期间跨过了分钟边界，且别的进程已把新窗口记满"
    return { immediate: () => { t = 60_001; db.prepare("INSERT INTO mcp_rate_buckets VALUES ('s|1',60000,'all',1)").run(); return tx.immediate() } }
  }
  const r = l.consume(1, 'read', 's', db)
  assert.deepEqual([r.allowed, r.reason], [false, 'rpm'])
  assert.deepEqual(db.prepare('SELECT window_start w, count c FROM mcp_rate_buckets').all(), [{ w: 60000, c: 1 }], 'nothing recorded against the stale window')
  db.close()
})

test('Codex medium: purge never waits long for a held write lock, restores busy_timeout, and takes no lock when nothing is expired', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-rate-purge-'))
  try {
    const file = path.join(dir, 'p.db')
    const a = new Database(file); const b = new Database(file)
    for (const d of [a, b]) { d.pragma('journal_mode=WAL'); d.pragma('busy_timeout=5000') }
    M073.up(a)
    const now = 9_000_000_000
    const ws = now - (now % W)
    const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db' }, now: () => now })
    a.prepare('INSERT INTO mcp_rate_buckets VALUES (?,?,?,1)').run('k', ws, 'all')
    b.exec('BEGIN IMMEDIATE') // 另一连接占着写锁
    const t0 = Date.now()
    assert.deepEqual(l.purge(a), { deleted: 0 }, 'nothing expired: no write lock needed even while another connection holds it')
    b.exec('ROLLBACK')
    a.prepare('INSERT INTO mcp_rate_buckets VALUES (?,?,?,1)').run('old', ws - 9 * W, 'all')
    b.exec('BEGIN IMMEDIATE')
    const r = l.purge(a)
    assert.equal(r.failed, true)
    assert.ok(Date.now() - t0 < 2500, `gave up fast (took ${Date.now() - t0} ms)`)
    assert.equal(a.pragma('busy_timeout', { simple: true }), 5000, 'busy_timeout restored')
    b.exec('ROLLBACK')
    assert.deepEqual(l.purge(a), { deleted: 1 }, 'next tick succeeds')
    a.close(); b.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
