// AF11：GET /api/mcp/limits/tokens（仅 system.mcp.manage）与 db 模式桶表的近期触顶统计 recentLimitedByToken。
// AG9：`rate_limited_recent` = 当前+上一窗口里该令牌被速率额度拒绝（429）的精确次数，来自迁移 075 的 denied 行（精确值的专项用例在 mcp-quota-denied.test.mjs）。
// 集成部分在全新临时数据目录 + 随机回环端口上起服务（GML_RUNTIME_MODE=test）。
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
import { recentLimitedByToken, mcpRatePolicy } from '../server/lib/mcp-rate-limit.js'

const require = createRequire(import.meta.url)
const M073 = require('../server/db/migrations/073_mcp_rate_buckets.cjs')
const M075 = require('../server/db/migrations/075_mcp_rate_denied_kind.cjs')
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const W = 60_000

test('recentLimitedByToken: counts current+previous windows at the ceiling, per token, scoped, never older', () => {
  const db = new Database(':memory:')
  M073.up(db); M075.up(db)
  const t = 2_000_000_000 - (2_000_000_000 % W) + 5_000
  const ws = t - (t % W)
  const p = mcpRatePolicy({ GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '3', GML_MCP_WRITE_RPM: '2' })
  const put = db.prepare('INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,?)')
  put.run('cosmetic|1', ws, 'denied', 3) // 当前窗口 3 次被拒
  put.run('cosmetic|1', ws - W, 'denied', 2) // 上一窗口 2 次
  put.run('cosmetic|2', ws, 'all', 2) // 只有放行行：不算
  put.run('cosmetic|3', ws - 2 * W, 'denied', 99) // 太旧
  put.run('other|4', ws, 'denied', 99) // 别的库
  const m = recentLimitedByToken(db, { scope: 'cosmetic', policy: p, now: () => t })
  assert.deepEqual([...m.entries()], [[1, 5]])
  db.close()
})

test('recentLimitedByToken: memory mode and a missing table yield an empty map, never throw', () => {
  const db = new Database(':memory:')
  assert.equal(recentLimitedByToken(db, { scope: 'x', policy: mcpRatePolicy({}), now: Date.now }).size, 0)
  assert.equal(recentLimitedByToken(db, { scope: 'x', policy: mcpRatePolicy({ GML_MCP_RATE_STORE: 'db' }), now: Date.now }).size, 0)
  db.close()
})

async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-tok-'))
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

test('GET /api/mcp/limits/tokens: db mode lists per-token recent ceiling hits to admins only; no token material', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '2', GML_MCP_WRITE_RPM: '1' })
  const admin = await f.login('admin', '12345')
  const busy = createToken(f.db, { name: 'tok-busy', scopes: 'read' })
  const quiet = createToken(f.db, { name: 'tok-quiet', scopes: 'read' })
  assert.equal(await f.mcpCall(busy.token), 200)
  assert.equal(await f.mcpCall(busy.token), 200)
  assert.equal(await f.mcpCall(busy.token), 429)
  assert.equal(await f.mcpCall(quiet.token), 200)
  const r = await f.get('/api/mcp/limits/tokens', admin)
  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.store, 'db')
  assert.equal(d.window_seconds, 60)
  assert.deepEqual(Object.keys(d).sort(), ['store', 'tokens', 'truncated', 'window_seconds'])
  const byName = Object.fromEntries(d.tokens.map((x) => [x.name, x]))
  assert.deepEqual(Object.keys(byName['tok-busy']).sort(), ['id', 'name', 'rate_limited_recent'])
  assert.equal(byName['tok-busy'].rate_limited_recent, 1)
  assert.equal(byName['tok-quiet'].rate_limited_recent, 0)
  const raw = JSON.stringify(r.body)
  assert.ok(!raw.includes(busy.token) && !raw.includes(quiet.token), 'no token plaintext')
  assert.ok(!/token_hash|token_prefix/.test(raw))

  const pw = randomBytes(24).toString('base64url')
  const created = await fetch(`${f.base}/api/auth/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ username: 'lim_plain2', name: 'lim_plain2', role: 'purchase', password: pw })
  })
  assert.equal(created.status, 200)
  assert.equal((await f.get('/api/mcp/limits/tokens', await f.login('lim_plain2', pw))).status, 403)
  assert.equal((await f.get('/api/mcp/limits/tokens')).status, 401)
})

test('GET /api/mcp/limits/tokens: memory mode (default) returns an empty list', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '2' })
  const admin = await f.login('admin', '12345')
  const tok = createToken(f.db, { name: 'tok-mem', scopes: 'read' })
  for (let i = 0; i < 3; i++) await f.mcpCall(tok.token)
  const r = await f.get('/api/mcp/limits/tokens', admin)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data, { store: 'memory', window_seconds: 60, truncated: false, tokens: [] })
})
