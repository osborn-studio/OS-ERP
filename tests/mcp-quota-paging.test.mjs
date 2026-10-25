// AH9（ADR-0056 补充 4）：denied 行进入清理周期并导出 gauge、/api/mcp/limits/quota 游标分页、指标标签基数守卫。
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
import { createMcpRateLimiter, dailyQuotaPage, encodeQuotaCursor, decodeQuotaCursor, deniedRowCount } from '../server/lib/mcp-rate-limit.js'
import { renderPrometheus } from '../server/lib/metrics-export.js'
import { counterSnapshot, histogramSnapshot, resetCounters } from '../server/lib/process-counters.js'

const require = createRequire(import.meta.url)
const M073 = require('../server/db/migrations/073_mcp_rate_buckets.cjs')
const M075 = require('../server/db/migrations/075_mcp_rate_denied_kind.cjs')
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const W = 60_000
const T0 = 2_000_000_000 - (2_000_000_000 % W) + 10_000
const DB_ENV = { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '2', GML_MCP_WRITE_RPM: '1' }
const OPS = { last_backup: { at: null, result: 'none', age_seconds: null }, migration_checksums: { mismatched: 0, adopted: 0 }, login_throttle: 'ok', disk_free_bytes: 1, db_sizes: {} }

function rateDb() { const db = new Database(':memory:'); M073.up(db); M075.up(db); return db }
function quotaDb(n, usedOf) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE agent_tokens (id INTEGER PRIMARY KEY, name TEXT, status TEXT, expires_at TEXT);
           CREATE TABLE mcp_call_logs (id INTEGER PRIMARY KEY, token_id INTEGER, created_at TEXT)`)
  const tok = db.prepare('INSERT INTO agent_tokens (id, name, status, expires_at) VALUES (?,?,?,NULL)')
  const log = db.prepare("INSERT INTO mcp_call_logs (token_id, created_at) VALUES (?, datetime('now','localtime'))")
  for (let i = 1; i <= n; i++) { tok.run(i, `t${i}`, 'active'); for (let k = 0; k < usedOf(i); k++) log.run(i) }
  return db
}

// ------------------------------------------------------------ (1) denied rows: cleanup cycle + gauge
test('purge: denied rows older than the cleanup line are deleted with the other kinds; fresh denied rows survive', () => {
  const db = rateDb()
  let t = T0
  const l = createMcpRateLimiter({ env: DB_ENV, now: () => t })
  const put = db.prepare('INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,?)')
  const ws = T0 - (T0 % W)
  put.run('cosmetic|1', ws - 3 * W, 'denied', 9)
  put.run('cosmetic|1', ws - 3 * W, 'all', 9)
  put.run('cosmetic|2', ws - 2 * W, 'denied', 4) // 正好在清理线上：保留
  put.run('cosmetic|3', ws, 'denied', 1)
  assert.equal(deniedRowCount(db), 3)
  assert.deepEqual(l.purge(db), { deleted: 2 })
  assert.equal(deniedRowCount(db), 2)
  t += 5 * W
  assert.deepEqual(l.purge(db), { deleted: 2 })
  assert.equal(deniedRowCount(db), 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mcp_rate_buckets').get().c, 0)
  db.close()
})

test('deniedRowCount: counts only kind=denied rows; -1 when the table cannot be read; never throws', () => {
  const db = rateDb()
  assert.equal(deniedRowCount(db), 0)
  const put = db.prepare('INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,?)')
  put.run('cosmetic|1', T0, 'denied', 50) // 行数而不是 count 之和：gauge 衡量表的体量
  put.run('cosmetic|2', T0, 'denied', 1)
  put.run('cosmetic|2', T0, 'all', 7)
  assert.equal(deniedRowCount(db), 2)
  assert.equal(deniedRowCount(new Database(':memory:')), -1)
  assert.equal(deniedRowCount(null), -1)
  db.close()
})

test('renderPrometheus: os_erp_mcp_rate_denied_rows is a single unlabeled gauge; unknown renders -1; scope is declared in HELP', () => {
  const base = { ops: OPS, retry: {}, counters: {}, histograms: {}, version: 'x' }
  const text = renderPrometheus({ ...base, mcpDeniedRows: 12 })
  assert.match(text, /^# HELP os_erp_mcp_rate_denied_rows .*(per-process|serving industry database)/m)
  assert.match(text, /^# TYPE os_erp_mcp_rate_denied_rows gauge$/m)
  assert.match(text, /^os_erp_mcp_rate_denied_rows 12$/m)
  assert.match(renderPrometheus({ ...base, mcpDeniedRows: -1 }), /^os_erp_mcp_rate_denied_rows -1$/m)
  assert.match(renderPrometheus(base), /^os_erp_mcp_rate_denied_rows -1$/m, 'caller did not supply it => unknown, not 0')
})

// ------------------------------------------------------------ (3) label cardinality guard
const LABEL_SETS = { // 导出的每个指标族允许出现的 label 名集合；新增指标必须在这里显式登记（常量，不是从输出里推出来的）
  login_throttle_rejections_total: ['reason'], audit_strict_write_failures_total: ['reason'], dashboard_cache_total: ['result'],
  mcp_rate_store_failures_total: ['reason'], audit_fts_fallback_total: ['reason'], mcp_tool_calls_total: ['code', 'tool'], build_info: ['version']
}
const labelNamesByFamily = (text) => {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^os_erp_([a-z0-9_]+?)(?:_bucket|_sum|_count)?(?:\{([^}]*)\})? [-0-9.e+]+$/.exec(line)
    if (!m) continue
    const names = m[2] ? [...m[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="/g)].map((x) => x[1]).filter((n) => n !== 'le').sort() : []
    const key = m[1]
    out[key] = [...new Set([...(out[key] ?? []), ...names])].sort()
  }
  return out
}

test('cardinality guard: exporter label NAMES are a closed constant set; no family labels by token id', () => {
  resetCounters()
  const text = renderPrometheus({ ops: OPS, retry: {}, counters: counterSnapshot(), histograms: histogramSnapshot(), version: 'v', mcpDeniedRows: 3 })
  const seen = labelNamesByFamily(text)
  for (const [family, names] of Object.entries(seen)) {
    assert.deepEqual(names, LABEL_SETS[family] ?? [], `family ${family} has an unregistered label set ${JSON.stringify(names)}`)
  }
  for (const names of Object.values(seen)) for (const n of names) assert.ok(!/token|^id$|key|user|ip|path/i.test(n), `label name ${n} looks like unbounded identity`)
  assert.ok(Object.keys(seen).includes('mcp_rate_denied_rows') && Object.keys(seen).includes('mcp_rate_store_wait_seconds'))
})

test('cardinality guard: 300 distinct tokens being refused and counted change neither the series set nor any label value', () => {
  resetCounters()
  const render = (denied) => renderPrometheus({ ops: OPS, retry: {}, counters: counterSnapshot(), histograms: histogramSnapshot(), version: 'v', mcpDeniedRows: denied })
  const seriesOf = (text) => text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.slice(0, l.lastIndexOf(' ')))
  const before = seriesOf(render(0))
  const db = rateDb()
  const l = createMcpRateLimiter({ env: DB_ENV, now: () => T0 })
  const ids = []
  for (let i = 0; i < 300; i++) { const id = 910_000 + i; ids.push(id); for (let k = 0; k < 4; k++) l.consume(id, 'read', 'cosmetic', db) }
  const after = render(deniedRowCount(db))
  assert.equal(deniedRowCount(db), 300)
  assert.deepEqual(seriesOf(after), before, 'series names and label values are identical regardless of how many tokens were refused')
  for (const id of ids.slice(0, 5)) assert.ok(!after.includes(String(id)), 'a token id leaked into the exposition')
  assert.ok(!/cosmetic\|/.test(after), 'bucket keys leaked into the exposition')
  db.close()
})

test('cardinality guard (static): metrics-export.js interpolates labels only from registered defs, never from token / bucket variables', () => {
  const src = readFileSync(path.join(ROOT, 'server/lib/metrics-export.js'), 'utf8')
  const labelInterpolations = [...src.matchAll(/\$\{[^}]*\}="\$\{([^}]*)\}"/g), ...src.matchAll(/[{,](\w+)="\$\{([^}]*)\}"/g)].map((m) => m[0])
  for (const s of labelInterpolations) assert.ok(!/token|bucket|key_?id/i.test(s), `label interpolation ${s} references token-ish data`)
  assert.ok(labelInterpolations.length >= 3, 'the scan really found the label interpolations')
  assert.ok(!/token_id|tokenId|token_key/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'exporter code does not touch token ids')
})

// ------------------------------------------------------------ (2) pagination (unit)
test('cursor codec: round-trips, opaque, and rejects anything that is not exactly <used>.<id>', () => {
  const c = encodeQuotaCursor({ used: 17, id: 5 })
  assert.match(c, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeQuotaCursor(c), { used: 17, id: 5 })
  assert.deepEqual(decodeQuotaCursor(encodeQuotaCursor({ used: 0, id: 1 })), { used: 0, id: 1 })
  const b64 = (s) => Buffer.from(s).toString('base64url')
  for (const bad of ['', 'x', '!!!', b64('1'), b64('1.'), b64('.1'), b64('-1.2'), b64('1.-2'), b64('1.2.3'), b64('1.2 OR 1=1'), b64("1.2'; DROP TABLE agent_tokens;--"), b64('1.0'), b64('01.2'), b64('1e3.2'), b64('9007199254740993.1'), b64(`1.${'9'.repeat(30)}`), 'a'.repeat(500), null, undefined, 42, {}]) {
    assert.equal(decodeQuotaCursor(bad), null, `cursor ${String(bad).slice(0, 30)} must be rejected`)
  }
})

test('dailyQuotaPage: used desc then id asc; pages tile the full list exactly once; next only when more remain', () => {
  const db = quotaDb(23, (i) => [0, 5, 5, 2, 9][i % 5]) // 大量并列，逼出 id 次序
  const full = dailyQuotaPage(db, { limit: 500 })
  assert.equal(full.rows.length, 23)
  assert.equal(full.next, null)
  const sorted = [...full.rows].sort((a, b) => b.used - a.used || a.id - b.id)
  assert.deepEqual(full.rows, sorted)
  for (const limit of [1, 2, 5, 7, 22, 23, 24]) {
    const got = []
    let after = null
    for (let i = 0; i < 50; i++) {
      const p = dailyQuotaPage(db, { limit, after })
      assert.ok(p.rows.length <= limit)
      got.push(...p.rows)
      if (!p.next) break
      assert.equal(p.rows.length, limit, 'a non-final page is full')
      after = decodeQuotaCursor(p.next)
    }
    assert.deepEqual(got, full.rows, `limit=${limit} tiles the list with no gap or duplicate`)
  }
  assert.equal(dailyQuotaPage(db, { limit: 23 }).next, null, 'exactly one full page: no phantom next')
  assert.deepEqual(dailyQuotaPage(db, { limit: 5, after: { used: 0, id: 99999 } }).rows, [], 'cursor past the end => empty, no next')
  db.close()
})

test('dailyQuotaPage: a row whose usage grows between pages cannot be duplicated (it only moves earlier); the cursor is a position, not a snapshot', () => {
  const db = quotaDb(6, (i) => 10 - i)
  const p1 = dailyQuotaPage(db, { limit: 3 })
  assert.deepEqual(p1.rows.map((r) => r.id), [1, 2, 3])
  const log = db.prepare("INSERT INTO mcp_call_logs (token_id, created_at) VALUES (?, datetime('now','localtime'))")
  for (let k = 0; k < 20; k++) log.run(5) // token 5 现在比所有人都多
  const p2 = dailyQuotaPage(db, { limit: 3, after: decodeQuotaCursor(p1.next) })
  const all = [...p1.rows, ...p2.rows].map((r) => r.id)
  assert.equal(new Set(all).size, all.length, 'no duplicates even though the ranking changed')
  assert.deepEqual(p2.rows.map((r) => r.id), [4, 6])
  db.close()
})

test('dailyQuotaPage: injection-shaped inputs are bound as numbers; unreadable tables => null', () => {
  const db = quotaDb(3, () => 1)
  assert.equal(dailyQuotaPage(db, { limit: '3; DROP TABLE agent_tokens' }).rows.length, 3, 'a non-numeric limit falls back to the default instead of reaching SQL')
  assert.equal(dailyQuotaPage(db, { limit: 1, after: { used: '1 OR 1=1', id: 0 } }).rows.length, 1, 'bad cursor object degrades to first page')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c, 3)
  assert.equal(dailyQuotaPage(new Database(':memory:'), { limit: 5 }), null)
  db.close()
})

// ------------------------------------------------------------ (2) pagination + gauge (live server)
async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ah9-'))
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
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 文本指标 */ }
    return { status: r.status, body, text }
  }
  const login = async (username, password) => (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, industry: 'cosmetic' })
  }).then((x) => x.json())).data.token
  const mcpCall = async (token) => (await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'org.tree', arguments: {} } }), signal: AbortSignal.timeout(15000)
  })).status
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { get, login, mcpCall, db }
}
const setQuota = (db, n) => db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('mcp_token_daily_quota',?,datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n))

test('live: /limits/quota paginates by cursor (default 100, max 500), keeps the old fields, rejects malformed cursor/limit with 400', { timeout: 180000 }, async (t) => {
  const f = await server(t)
  const admin = await f.login('admin', '12345')
  setQuota(f.db, 1000)
  const ids = []
  for (let i = 0; i < 7; i++) ids.push(createToken(f.db, { name: `tok-${i}`, scopes: 'read' }))
  const log = f.db.prepare("INSERT INTO mcp_call_logs (token_id, tool_name, level, ok, created_at) VALUES (?, 'org.tree', 'read', 1, datetime('now','localtime'))")
  const cols = f.db.prepare('PRAGMA table_info(mcp_call_logs)').all().map((c) => c.name)
  assert.ok(['token_id', 'tool_name', 'level', 'ok', 'created_at'].every((c) => cols.includes(c)), `mcp_call_logs columns: ${cols}`)
  const uses = [3, 0, 3, 8, 1, 0, 3]
  ids.forEach((tok, i) => { for (let k = 0; k < uses[i]; k++) log.run(tok.id) })

  const tokenCount = f.db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c
  const first = await f.get('/api/mcp/limits/quota', admin)
  assert.equal(first.status, 200)
  const d = first.body.data
  assert.deepEqual(Object.keys(d).sort(), ['daily_quota', 'enabled', 'next_cursor', 'tokens', 'truncated', 'usage_unavailable'])
  assert.equal(d.next_cursor, null, 'all active tokens fit in the default page of 100')
  assert.equal(d.truncated, false)
  const expected = d.tokens.map((x) => x.id)
  assert.deepEqual(d.tokens.filter((x) => x.name.startsWith('tok-')).map((x) => x.used), [8, 3, 3, 3, 1, 0, 0])

  const walked = []
  let cursor = null
  for (let i = 0; i < 10; i++) {
    const r = await f.get(`/api/mcp/limits/quota?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, admin)
    assert.equal(r.status, 200)
    assert.ok(r.body.data.tokens.length <= 3)
    walked.push(...r.body.data.tokens.map((x) => x.id))
    assert.equal(r.body.data.truncated, r.body.data.next_cursor !== null, 'truncated mirrors "more pages exist"')
    cursor = r.body.data.next_cursor
    if (!cursor) break
  }
  assert.deepEqual(walked, expected)

  assert.equal((await f.get('/api/mcp/limits/quota?limit=100000', admin)).status, 200, 'over-max limit is clamped')
  for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'cursor=%27%3BDROP', 'cursor=AAAA', `cursor=${'a'.repeat(400)}`, 'limit=2&limit=3']) {
    const r = await f.get(`/api/mcp/limits/quota?${q}`, admin)
    assert.equal(r.status, 400, `${q} => 400`)
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c, tokenCount, 'tables intact')
  // 配额关闭：形状不变，next_cursor=null，且不校验游标也不读审计表
  setQuota(f.db, 0)
  const off = await f.get('/api/mcp/limits/quota', admin)
  assert.deepEqual(off.body.data, { daily_quota: 0, enabled: false, usage_unavailable: false, truncated: false, next_cursor: null, tokens: [] })
  assert.equal((await f.get('/api/mcp/limits/quota')).status, 401)
})

test('live: os_erp_mcp_rate_denied_rows is exported, counts denied rows, and the background purge removes them', { timeout: 180000 }, async (t) => {
  const f = await server(t, { ...DB_ENV, GML_TEST_MCP_RATE_WINDOW_MS: '500', GML_TEST_MCP_RATE_PURGE_MS: '500' })
  const admin = await f.login('admin', '12345')
  const tok = createToken(f.db, { name: 'tok-deny', scopes: 'read' })
  const gauge = async () => {
    const r = await f.get('/api/meta/metrics?format=prometheus', admin)
    assert.equal(r.status, 200)
    return Number(/^os_erp_mcp_rate_denied_rows (-?\d+)$/m.exec(r.text)?.[1])
  }
  assert.equal(await gauge(), 0)
  for (let i = 0; i < 6; i++) await f.mcpCall(tok.token)
  assert.ok((await gauge()) >= 1, 'a refusal wrote a denied row')
  let n = 1
  for (let i = 0; i < 60 && n !== 0; i++) { await delay(250); n = await gauge() }
  assert.equal(n, 0, 'the purge cycle removed the expired denied rows')
})

test('docs: ADR-0056 supplement 4 and the gauge row in monitoring.md', () => {
  const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
  assert.match(read('docs/implementation/ADR-0056-mcp-rate-limit-quota.md'), /## 补充 4（AH9/)
  assert.match(read('docs/operations/monitoring.md'), /os_erp_mcp_rate_denied_rows/)
})
