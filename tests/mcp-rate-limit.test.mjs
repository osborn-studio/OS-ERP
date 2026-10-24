// ADR-0056 / AD9：MCP 按令牌速率限制与日配额。
// 单元部分用注入时钟；集成部分在全新临时数据目录 + 随机回环端口上起服务（GML_RUNTIME_MODE=test）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createToken } from '../server/mcp/tokens.js'
import { createMcpRateLimiter, DEFAULT_MCP_RATE, dailyQuotaState } from '../server/lib/mcp-rate-limit.js'
import { createBucketStore } from '../server/lib/metrics-throttle.js'
import { SETTING_RULES } from '../server/lib/settings.js'
import { MCP_RESULT_CODES } from '../server/lib/process-counters.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// ---- 单元：限流器 -------------------------------------------------------------
test('defaults: 600 all calls / 60 writes per minute; invalid env falls back to defaults', () => {
  assert.equal(DEFAULT_MCP_RATE.rpm, 600)
  assert.equal(DEFAULT_MCP_RATE.writeRpm, 60)
  const l = createMcpRateLimiter({ env: {} })
  assert.equal(l.policy.rpm, 600)
  assert.equal(l.policy.writeRpm, 60)
  for (const bad of ['0', '-1', 'abc', '1.5', '', '99999999999', ' 5']) {
    const p = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: bad, GML_MCP_WRITE_RPM: bad } }).policy
    assert.equal(p.rpm, 600, bad)
    assert.equal(p.writeRpm, 60, bad)
  }
  const ok = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '5', GML_MCP_WRITE_RPM: '2' } }).policy
  assert.equal(ok.rpm, 5)
  assert.equal(ok.writeRpm, 2)
})

test('under the limit passes, over the limit is refused with retryAfter >= 1, window slides', () => {
  let t = 1_000_000_000
  const l = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '3', GML_MCP_WRITE_RPM: '3' }, now: () => t })
  for (let i = 0; i < 3; i++) assert.equal(l.consume(7, 'read').allowed, true)
  const r = l.consume(7, 'read')
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'rpm')
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60)
  assert.equal(l.consume(8, 'read').allowed, true, 'another token has its own budget')
  t += 61_000 // 完整一个窗口之后再多一点：额度恢复
  assert.equal(l.consume(7, 'read').allowed, true)
  // 滑动：刚跨窗口时上一窗口的计数仍按比例计入，不会出现"整点翻倍"
  t = 2_000_000_000 - (2_000_000_000 % 60_000) + 59_000
  const l2 = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '3' }, now: () => t })
  for (let i = 0; i < 3; i++) assert.equal(l2.consume(1, 'read').allowed, true)
  t += 2_000 // 已进入下一固定窗口，但距上次仅 2 秒
  assert.equal(l2.consume(1, 'read').allowed, false, 'burst across the boundary must not double the budget')
})

test('write limit is independent of the read limit and a write refusal consumes no read budget', () => {
  const t = 5_000_000
  const l = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '10', GML_MCP_WRITE_RPM: '2' }, now: () => t })
  assert.equal(l.consume(1, 'write').allowed, true)
  assert.equal(l.consume(1, 'write').allowed, true)
  const w = l.consume(1, 'write')
  assert.equal(w.allowed, false)
  assert.equal(w.reason, 'write_rpm')
  // 读调用还剩 10 - 2 = 8 次；被拒的写没有占用读额度
  for (let i = 0; i < 8; i++) assert.equal(l.consume(1, 'read').allowed, true, `read ${i}`)
  assert.equal(l.consume(1, 'read').allowed, false)
  // 反方向：读额度耗尽不影响"写额度本身"，但写调用同样计入总额度，所以此时写也被总额度拒
  assert.equal(l.consume(2, 'read').allowed, true)
})

test('write calls also count against the all-calls budget (rpm is a hard ceiling)', () => {
  const l = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '3', GML_MCP_WRITE_RPM: '3' }, now: () => 1 })
  assert.equal(l.consume(1, 'read').allowed, true)
  assert.equal(l.consume(1, 'write').allowed, true)
  assert.equal(l.consume(1, 'write').allowed, true)
  const r = l.consume(1, 'write')
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'rpm')
})

test('fail closed: unusable token ids and a full bucket store are refused; expired buckets are reclaimed', () => {
  let t = 10_000
  const l = createMcpRateLimiter({ env: {}, now: () => t, maxBuckets: 3 })
  for (const bad of [undefined, null, 'abc', -1, 1.5, NaN, {}, '1; DROP']) assert.equal(l.consume(bad, 'read').allowed, false, String(bad))
  for (const id of [1, 2, 3]) assert.equal(l.consume(id, 'read').allowed, true)
  const full = l.consume(4, 'read')
  assert.equal(full.allowed, false, 'a 4th distinct token cannot get a bucket while all 3 are live')
  assert.equal(full.reason, 'unavailable')
  assert.equal(l.consume(1, 'read').allowed, true, 'tokens that already own a bucket keep working')
  t += 130_000 // 全部过期
  assert.equal(l.consume(4, 'read').allowed, true, 'expired buckets are swept to make room')
})

test('generic bucket store: cap, expiry sweep, fail closed', () => {
  let t = 0
  const s = createBucketStore({ maxBuckets: 2, now: () => t })
  const a = s.open('a', () => ({ expires: 100 }))
  const b = s.open('b', () => ({ expires: 200 }))
  assert.ok(a.bucket && b.bucket)
  assert.equal(s.open('a', () => ({ expires: 999 })).bucket, a.bucket, 'existing key returns the same bucket')
  const c = s.open('c', () => ({ expires: 300 }))
  assert.equal(c.bucket, undefined)
  assert.equal(c.full, true)
  assert.ok(c.until >= 100)
  t = 150
  assert.ok(s.open('c', () => ({ expires: 400 })).bucket, 'a expired -> room')
})

// ---- 设置键与结果码 -----------------------------------------------------------
test('mcp_token_daily_quota is a dangerous int setting, default off (0)', () => {
  const d = SETTING_RULES.mcp_token_daily_quota
  assert.ok(d)
  assert.equal(d.type, 'int')
  assert.equal(d.default, '0')
  assert.equal(d.is_danger, true)
  assert.equal(d.wired, true)
  assert.ok(d.min === 0 && d.max > 0)
})

test('MCP_RATE_LIMITED is a registered result code', () => {
  assert.ok(MCP_RESULT_CODES.includes('MCP_RATE_LIMITED'))
})

// ---- 集成 --------------------------------------------------------------------
async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-rl-'))
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
  assert.ok(output.includes('服务已启动'), `test-mode server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  let seq = 0
  const call = async (name, args, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, headers: res.headers, body: await res.json() }
  }
  const metrics = async () => {
    // 进程内计数器通过管理员 JWT 读取
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' })
    }).then((r) => r.json())
    const r = await fetch(`${base}/api/meta/metrics?format=prometheus`, { headers: { authorization: `Bearer ${login.data.token}` } })
    return r.text()
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { call, metrics, db, dir }
}

const errCode = (r) => {
  const text = r.body?.result?.content?.[0]?.text
  if (!r.body?.result?.isError || !text) return null
  try { return JSON.parse(text).error } catch { return null }
}

function fixtures(db) {
  const wh = db.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get()
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get()
  assert.ok(wh && sku)
  return { wh: wh.id, sku: sku.id }
}
const rows = (db) => ({
  tx: db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c,
  idem: db.prepare('SELECT COUNT(*) c FROM mcp_idempotency').get().c
})
const stockIn = (fx, n) => ({ warehouse_id: fx.wh, sku_id: fx.sku, qty: 1, unit_cost: 1, idempotency_key: `rl-${n}-${randomBytes(4).toString('hex')}` })

test('integration: read limit -> 429 MCP_RATE_LIMITED, JSON-RPC envelope kept, counter incremented, no leak to other tokens', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '5', GML_MCP_WRITE_RPM: '2' })
  const a = createToken(f.db, { name: 'rl-a', scopes: 'read,write' }).token
  const b = createToken(f.db, { name: 'rl-b', scopes: 'read,write' }).token
  for (let i = 0; i < 5; i++) {
    const r = await f.call('org.tree', {}, a)
    assert.equal(r.status, 200, `call ${i}`)
    assert.equal(errCode(r), null)
  }
  const over = await f.call('org.tree', {}, a)
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers.get('retry-after')) >= 1)
  assert.equal(over.body.jsonrpc, '2.0')
  assert.equal(over.body.success, false)
  assert.equal('error' in over.body, false, 'JSON-RPC: result and error are mutually exclusive, so no top-level error member')
  assert.equal(over.body.detail.code, 'MCP_RATE_LIMITED')
  assert.equal(over.body.result?.isError, true, 'tool-style envelope so MCP clients surface it to the model')
  assert.equal(errCode(over), 'MCP_RATE_LIMITED')
  assert.equal((await f.call('org.tree', {}, b)).status, 200, 'token b is unaffected by token a')
  const m = await f.metrics()
  assert.match(m, /os_erp_mcp_tool_calls_total\{tool="org\.tree",code="MCP_RATE_LIMITED"\} 1\b/)
})

test('integration: write limit refuses with zero writes, read budget unaffected, idempotent replay still counts', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '20', GML_MCP_WRITE_RPM: '2' })
  const fx = fixtures(f.db)
  const tok = createToken(f.db, { name: 'rl-w', scopes: 'read,write' }).token
  const before = rows(f.db)
  assert.equal(errCode(await f.call('inventory.stock_in', stockIn(fx, 1), tok)), null)
  assert.equal(errCode(await f.call('inventory.stock_in', stockIn(fx, 2), tok)), null)
  const mid = rows(f.db)
  assert.equal(mid.idem, before.idem + 2)
  const over = await f.call('inventory.stock_in', stockIn(fx, 3), tok)
  assert.equal(over.status, 429)
  assert.equal(over.body.detail.code, 'MCP_RATE_LIMITED')
  assert.deepEqual(rows(f.db), mid, 'a refused write changes no business row and no idempotency row')
  // 读不受写限额影响
  const read = await f.call('org.tree', {}, tok)
  assert.equal(read.status, 200)
  assert.equal(errCode(read), null)
})

test('integration: rate limit is keyed by the verified token, not by anything the caller controls', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '3' })
  const a = createToken(f.db, { name: 'rl-s', scopes: 'read' }).token
  for (let i = 0; i < 3; i++) assert.equal((await f.call('org.tree', {}, a)).status, 200)
  // 限流键是验签后的令牌 id，请求体里的 id / 工具名 / 自带头都不参与
  const over = await f.call('org.tree', {}, a)
  assert.equal(over.status, 429)
  // 无效令牌不进入限流桶（不会占用桶，也不会 429）
  const bad = await f.call('org.tree', {}, 'gml_' + 'f'.repeat(40))
  assert.notEqual(bad.status, 429)
  assert.equal(bad.body?.error?.data?.code, 'TOKEN_INVALID')
})

test('integration: daily quota (off by default), per token, rollover by local day', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '1000' })
  const a = createToken(f.db, { name: 'q-a', scopes: 'read' }).token
  const b = createToken(f.db, { name: 'q-b', scopes: 'read' }).token
  for (let i = 0; i < 4; i++) assert.equal((await f.call('org.tree', {}, a)).status, 200, 'quota off by default')
  // 开启配额 = 3：a 今天已有 4 行审计，下一次即被拒；b 尚无调用不受影响
  f.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('mcp_token_daily_quota','3',datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value='3'").run()
  const over = await f.call('org.tree', {}, a)
  assert.equal(over.status, 429)
  assert.equal(over.body.detail.code, 'MCP_RATE_LIMITED')
  assert.equal(over.body.detail?.reason, 'daily_quota')
  assert.ok(Number(over.headers.get('retry-after')) >= 1)
  assert.equal((await f.call('org.tree', {}, b)).status, 200)
  // 次日滚动：把 a 的所有审计行挪到昨天，额度恢复
  f.db.prepare("UPDATE mcp_call_logs SET created_at = datetime(created_at,'-1 day')").run()
  assert.equal((await f.call('org.tree', {}, a)).status, 200)
})

// ---- 单元：配额状态 ------------------------------------------------------------
test('dailyQuotaState: off when 0, counts only today for the token, fails closed on db errors', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
           CREATE TABLE mcp_call_logs (id INTEGER PRIMARY KEY, token_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`)
  assert.equal(dailyQuotaState(db, 1).allowed, true, 'no setting row -> default 0 -> off')
  db.prepare("INSERT INTO settings (key,value) VALUES ('mcp_token_daily_quota','2')").run()
  db.prepare('INSERT INTO mcp_call_logs (token_id) VALUES (1),(1),(2)').run()
  db.prepare("INSERT INTO mcp_call_logs (token_id, created_at) VALUES (1, datetime('now','localtime','-1 day'))").run()
  const s = dailyQuotaState(db, 1)
  assert.equal(s.allowed, false)
  assert.equal(s.used, 2)
  assert.equal(s.quota, 2)
  assert.ok(s.retryAfter >= 1 && s.retryAfter <= 86400)
  assert.equal(dailyQuotaState(db, 2).allowed, true)
  db.exec('DROP TABLE mcp_call_logs')
  const broken = dailyQuotaState(db, 1)
  assert.equal(broken.allowed, false)
  assert.equal(broken.reason, 'unavailable')
  db.close()
})

test('buckets are namespaced by industry database: same numeric token id in two industries does not share a budget', () => {
  const l = createMcpRateLimiter({ env: { GML_MCP_TOKEN_RPM: '2' }, now: () => 1 })
  assert.equal(l.consume(1, 'read', 'cosmetic').allowed, true)
  assert.equal(l.consume(1, 'read', 'cosmetic').allowed, true)
  assert.equal(l.consume(1, 'read', 'cosmetic').allowed, false)
  assert.equal(l.consume(1, 'read', 'food').allowed, true)
})

test('dailyQuotaState fails closed when the settings read itself fails (readSetting would swallow it and turn the quota off)', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE mcp_call_logs (id INTEGER PRIMARY KEY, token_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime(\'now\',\'localtime\')))')
  const s = dailyQuotaState(db, 1) // 没有 settings 表
  assert.equal(s.allowed, false)
  assert.equal(s.reason, 'unavailable')
  db.close()
})

test('limiter.daily keeps a process-local shadow count so a quota still holds when audit rows cannot be written', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
           CREATE TABLE mcp_call_logs (id INTEGER PRIMARY KEY, token_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
           INSERT INTO settings (key,value) VALUES ('mcp_token_daily_quota','2')`)
  const l = createMcpRateLimiter({ env: {} })
  assert.equal(l.daily(db, 1, 'cosmetic').allowed, true)
  assert.equal(l.daily(db, 1, 'cosmetic').allowed, true)
  const third = l.daily(db, 1, 'cosmetic') // 审计表始终为空（模拟审计写失败）
  assert.equal(third.allowed, false)
  assert.equal(third.reason, 'daily_quota')
  assert.equal(l.daily(db, 2, 'cosmetic').allowed, true, 'other tokens keep their own shadow')
  db.close()
})
