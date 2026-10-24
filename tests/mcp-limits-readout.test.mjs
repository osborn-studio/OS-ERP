// AE11：MCP 令牌页的限速读数（GET /api/mcp/limits，仅 system.mcp.manage）与审计列表的 FTS 状态字段（fts）。
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
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createToken } from '../server/mcp/tokens.js'
import { mcpRatePolicy, DEFAULT_MCP_RATE } from '../server/lib/mcp-rate-limit.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

test('mcpRatePolicy mirrors the limiter policy: defaults, valid env, invalid env falls back', () => {
  assert.deepEqual({ rpm: mcpRatePolicy({}).rpm, writeRpm: mcpRatePolicy({}).writeRpm }, { rpm: DEFAULT_MCP_RATE.rpm, writeRpm: DEFAULT_MCP_RATE.writeRpm })
  const p = mcpRatePolicy({ GML_MCP_TOKEN_RPM: '7', GML_MCP_WRITE_RPM: '3' })
  assert.equal(p.rpm, 7)
  assert.equal(p.writeRpm, 3)
  assert.equal(mcpRatePolicy({ GML_MCP_TOKEN_RPM: 'abc' }).rpm, 600)
})

async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-lim-'))
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
  const get = async (p, token) => {
    const r = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
    return { status: r.status, body: await r.json() }
  }
  const login = async (username, password) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, industry: 'cosmetic' })
    }).then((x) => x.json())
    return r.data.token
  }
  const mcpCall = async (name, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
      signal: AbortSignal.timeout(15000)
    })
    return res.status
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { get, login, mcpCall, db, base }
}

test('GET /api/mcp/limits: admin sees the configured limits, quota and the 429 counter; others get 403; no token material leaks', { timeout: 120000 }, async (t) => {
  const f = await server(t, { GML_MCP_TOKEN_RPM: '2', GML_MCP_WRITE_RPM: '1' })
  const admin = await f.login('admin', '12345')
  const first = await f.get('/api/mcp/limits', admin)
  assert.equal(first.status, 200)
  const d = first.body.data
  assert.equal(d.rpm, 2)
  assert.equal(d.write_rpm, 1)
  assert.equal(d.window_seconds, 60)
  assert.equal(d.daily_quota, 0)
  assert.equal(d.rate_limited_total, 0)
  assert.equal(d.counter_scope, 'process')
  assert.deepEqual(Object.keys(d).sort(), ['counter_scope', 'daily_quota', 'rate_limited_total', 'rpm', 'window_seconds', 'write_rpm'])

  f.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('mcp_token_daily_quota','50',datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value='50'").run()
  const tok = createToken(f.db, { name: 'lim-a', scopes: 'read' }).token
  assert.equal(await f.mcpCall('org.tree', tok), 200)
  assert.equal(await f.mcpCall('org.tree', tok), 200)
  assert.equal(await f.mcpCall('org.tree', tok), 429)
  const after = (await f.get('/api/mcp/limits', admin)).body.data
  assert.equal(after.rate_limited_total, 1)
  assert.equal(after.daily_quota, 50)
  assert.ok(!JSON.stringify(after).includes(tok))

  const plainPw = randomBytes(24).toString('base64url')
  const who = await fetch(`${f.base}/api/auth/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ username: 'lim_plain', name: 'lim_plain', role: 'purchase', password: plainPw })
  })
  assert.equal(who.status, 200)
  const plain = await f.login('lim_plain', plainPw)
  assert.equal((await f.get('/api/mcp/limits', plain)).status, 403)
  assert.equal((await fetch(`${f.base}/api/mcp/limits`)).status, 401)
})

test('GET /api/meta/audit-logs carries fts state: setting, index presence and the effective verdict', { timeout: 120000 }, async (t) => {
  const f = await server(t)
  const admin = await f.login('admin', '12345')
  const on = (await f.get('/api/meta/audit-logs?page=1&pageSize=1', admin)).body.data.fts
  assert.deepEqual(Object.keys(on).sort(), ['active', 'env_disabled', 'index_present', 'setting_enabled'])
  assert.equal(on.setting_enabled, true)
  assert.equal(on.env_disabled, false)
  assert.equal(on.active, on.index_present && !on.env_disabled, 'active follows the query predicate (index present, no env switch)')
  f.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('audit_fts_enabled','0',datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value='0'").run()
  const off = (await f.get('/api/meta/audit-logs?page=1&pageSize=1', admin)).body.data.fts
  assert.equal(off.setting_enabled, false)
  assert.equal(off.active, off.index_present, 'changing the setting alone does not touch the index, so queries can still use it until maintenance converges')
})
