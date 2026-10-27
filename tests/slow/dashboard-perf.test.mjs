// slow: 204 s: starts a second real server process and replays cache/perf fixtures over HTTP (scripts/test-timings.mjs, threshold 60 s)
/**
 * ============================================================================
 * 文件标识：tests/dashboard-perf.test.mjs ｜ 测试：低库存口径统一与看板热点块（roadmap-v6 AA5，ADR-0044）
 * ============================================================================
 * 【职责】守住 AA5 的决定：
 *   ① 指标注册表 `below_safe`、AI `stock_alert`、MCP `inventory.stock_alert` 与看板 / 预警页同一口径（lib/stock.js），
 *      在同一份夹具上与**原写法的 SQL**逐行比较；已知且文档化的口径差异（停用 SKU、无库存行、范围依据）逐条断言；
 *   ② 分段计时器默认关闭：无 `GML_PROFILE=1` 时不写任何 `profile_blocks` 日志；开启时每个块一个键，且耗时**绝不进响应体**；
 *   ③ 看板汇总缓存（若启用）：30 s 内命中、相关写入后立即失效、不同数据目录不串（见 dashboard-cache 用例）。
 * 【夹具口径】① 内存库 + 真实迁移；② ③ 用 test 运行时 + 全新临时数据目录 + 随机回环端口。
 * ============================================================================
 */
import test from 'node:test'
import { FETCH_TIMEOUT_MS, SLOW_WAIT } from '../lib/load-tolerance.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { runMigrations } from '../../server/db/migrations/runner.js'
import { listBelowSafe, countBelowSafe } from '../../server/lib/stock.js'
import { METRIC_BY_KEY } from '../../server/lib/metrics.js'
import { TOOL_MAP } from '../../server/mcp/tools.js'
import { createProfiler, profilingEnabled } from '../../server/lib/profile.js'
import { cachedForDb, invalidateForDb, cacheTtlMs, cacheKeyCount } from '../../server/lib/db-ttl-cache.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCHEMA = readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8')

const strip = ({ value, hit }) => ({ value, hit })

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.pragma('foreign_keys=OFF')
  const wh = db.prepare('INSERT INTO warehouses (code, name, org_id) VALUES (?,?,?)')
  const w1 = Number(wh.run('AA5-W1', 'w1', 101).lastInsertRowid) // 组织 101
  const w2 = Number(wh.run('AA5-W2', 'w2', 202).lastInsertRowid) // 组织 202
  const prod = db.prepare('INSERT INTO products (spu_code, name) VALUES (?, ?)')
  const sku = db.prepare('INSERT INTO product_skus (product_id, sku_code, name, safe_stock, status) VALUES (?,?,?,?,?)')
  const stock = db.prepare('INSERT INTO inventory_stocks (warehouse_id, sku_id, batch_no, qty_on_hand, owner_org_id) VALUES (?,?,?,?,?)')
  const mk = (code, safe, status, lots) => {
    const p = Number(prod.run(`AA5-${code}`, `p-${code}`).lastInsertRowid)
    const id = Number(sku.run(p, `AA5-K-${code}`, `s-${code}`, safe, status).lastInsertRowid)
    // 货主组织与仓库组织一致：这样"按货主"与"按仓库所属组织"两种范围依据在夹具上结果相同
    lots.forEach(([wid, batch, q]) => stock.run(wid, id, batch, q, wid === w1 ? 101 : 202))
    return id
  }
  const ids = {
    nostock: mk('nostock', 20, 'active', []),
    multiLow: mk('multi-low', 100, 'active', [[w1, 'a', 30], [w2, 'b', 20]]),
    multiOk: mk('multi-ok', 100, 'active', [[w1, 'a', 60], [w2, 'b', 60]]),
    equal: mk('equal', 10, 'active', [[w1, 'a', 10]]),
    zeroSafe: mk('zero-safe', 0, 'active', []),
    inactive: mk('inactive', 50, 'disabled', [[w1, 'a', 1]]),
    neg: mk('neg', 5, 'active', [[w1, 'a', -3], [w2, 'b', 2]]),
    tieA: mk('tie-a', 40, 'active', [[w1, 'a', 10]]),
    tieB: mk('tie-b', 40, 'active', [[w1, 'a', 10]]),
    onlyW2: mk('only-w2', 30, 'active', [[w2, 'a', 5]])
  }
  db.pragma('foreign_keys=ON')
  return { db, ids, w1, w2 }
}

// ---- 原写法（逐字保留，作为对照）----
const OLD_AI = `SELECT sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock,
                    COALESCE(SUM(st.qty_on_hand),0) qty_on_hand,
                    sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0) AS shortage
             FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN inventory_stocks st ON st.sku_id=sk.id
             WHERE sk.status='active' AND sk.safe_stock>0 GROUP BY sk.id
             HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock ORDER BY shortage DESC, sk.id`
const OLD_METRIC = `SELECT COUNT(*) v FROM (
           SELECT s.id, COALESCE(SUM(st.qty_on_hand),0) q, s.safe_stock
             FROM product_skus s LEFT JOIN inventory_stocks st ON st.sku_id = s.id
            WHERE COALESCE(s.safe_stock,0) > 0 GROUP BY s.id HAVING q < s.safe_stock)`
const OLD_MCP = (scopeSql) => `SELECT s.sku_id, k.sku_code, k.name AS sku_name, k.safe_stock, SUM(s.qty_on_hand) AS qty_on_hand
        FROM inventory_stocks s JOIN product_skus k ON k.id=s.sku_id
        WHERE k.safe_stock > 0 ${scopeSql}
        GROUP BY s.sku_id HAVING SUM(s.qty_on_hand) < k.safe_stock
        ORDER BY (SUM(s.qty_on_hand) - k.safe_stock) LIMIT 100`

test('AI stock_alert rows (unlimited) equal the original query, field for field', (t) => {
  const { db } = fixture(t)
  const strip = listBelowSafe(db, -1).map(({ sku_id, ...row }) => row)
  assert.deepEqual(strip, db.prepare(OLD_AI).all())
  assert.ok(strip.length >= 6)
})

test('metric below_safe: same as original except disabled SKUs are no longer counted (documented)', (t) => {
  const { db, ids } = fixture(t)
  const oldV = db.prepare(OLD_METRIC).get().v
  const newV = METRIC_BY_KEY.below_safe.compute(db)
  assert.equal(newV, countBelowSafe(db))
  assert.equal(oldV - newV, 1, 'only the disabled SKU (qty 1 < safe 50) differs')
  db.prepare("UPDATE product_skus SET status='active' WHERE id=?").run(ids.inactive)
  assert.equal(METRIC_BY_KEY.below_safe.compute(db), db.prepare(OLD_METRIC).get().v)
  assert.match(METRIC_BY_KEY.below_safe.exclusions, /active/)
})

test('MCP inventory.stock_alert: same rows as the original for active SKUs that have stock rows; scope follows the warehouse org', (t) => {
  const { db, ids, w1 } = fixture(t)
  const tool = TOOL_MAP.get('inventory.stock_alert')
  const call = (scope) => tool.handler({ db, args: {}, ctx: { scope } }).data.below_safe
  // 全局：旧查询只含有库存行的 SKU 且不看状态；新口径多了"无库存行"的缺货 SKU、少了停用 SKU
  const all = call({ scope: 'all', orgIds: null })
  const old = db.prepare(OLD_MCP('')).all()
  const stripKey = (rows) => rows.map((r) => r.sku_id)
  const expectNew = old.filter((r) => r.sku_id !== ids.inactive)
  const withStock = all.filter((r) => r.sku_id !== ids.nostock)
  assert.deepEqual(new Set(stripKey(withStock)), new Set(stripKey(expectNew)))
  assert.deepEqual(withStock.map((r) => r.qty_on_hand).sort(), expectNew.map((r) => r.qty_on_hand).sort())
  assert.ok(all.some((r) => r.sku_id === ids.nostock), 'a SKU with no stock rows at all is below safe stock')
  assert.deepEqual(Object.keys(all[0]).sort(), ['qty_on_hand', 'safe_stock', 'sku_code', 'sku_id', 'sku_name'])
  // 缺口大者在前
  const shortage = all.map((r) => r.safe_stock - r.qty_on_hand)
  assert.deepEqual(shortage, [...shortage].sort((a, b) => b - a))
  // 受限范围：只累计范围内仓库的库存，且只列范围内有库存行的 SKU。夹具里货主组织 = 仓库组织，所以与旧的"按货主过滤的库存行"逐行相同
  const only101 = call({ scope: 'org', orgIds: [101] })
  const old101 = db.prepare(OLD_MCP(' AND s.owner_org_id IN (101)')).all().filter((r) => r.sku_id !== ids.inactive)
  const rowKey = (r) => `${r.sku_id}|${r.sku_code}|${r.sku_name}|${r.safe_stock}|${r.qty_on_hand}`
  assert.deepEqual(only101.map(rowKey).sort(), old101.map(rowKey).sort(), 'complete rows equal the original owner-filtered query')
  assert.equal(only101.find((r) => r.sku_id === ids.multiLow).qty_on_hand, 30, 'only the org 101 warehouse is counted')
  assert.ok(!only101.some((r) => r.sku_id === ids.onlyW2 || r.sku_id === ids.nostock), 'SKUs with no stock row in scope are not listed (no leak of the low-stock list, no false zero)')
  // 货主与仓库组织不一致时（文档化的差异）：新口径以仓库所属组织为准，旧口径以 owner_org_id 为准
  db.pragma('foreign_keys=OFF')
  db.prepare('UPDATE inventory_stocks SET owner_org_id = 202 WHERE sku_id = ? AND warehouse_id = ?').run(ids.tieA, w1)
  db.pragma('foreign_keys=ON')
  const tieA = (rows) => rows.find((r) => r.sku_id === ids.tieA)
  assert.equal(tieA(call({ scope: 'org', orgIds: [101] })).qty_on_hand, 10, 'warehouse org 101 sees the stock regardless of owner_org_id')
  assert.equal(tieA(call({ scope: 'org', orgIds: [202] })), undefined, 'org 202 owns the lot but does not hold the warehouse: SKU not visible to it')
  assert.equal(tieA(db.prepare(OLD_MCP(' AND s.owner_org_id IN (202)')).all())?.qty_on_hand, 10, 'original filter followed owner_org_id')
  // 空范围不是全库
  assert.deepEqual(call({ scope: 'none', orgIds: [] }), [])
  assert.deepEqual(call({ scope: 'org', orgIds: [] }), [])
})

test('profiler is off unless GML_PROFILE is exactly "1" and logs nothing when off', () => {
  const logged = []
  const log = { info: (...a) => logged.push(a) }
  for (const env of [{}, { GML_PROFILE: '' }, { GML_PROFILE: '0' }, { GML_PROFILE: 'true' }]) {
    assert.equal(profilingEnabled(env), false)
    const p = createProfiler('x', env, log)
    assert.equal(p.enabled, false)
    assert.equal(p.time('a', () => 42), 42)
    p.done()
  }
  assert.equal(logged.length, 0)
  const on = createProfiler('x', { GML_PROFILE: '1' }, log)
  assert.equal(on.time('a', () => 7), 7)
  assert.throws(() => on.time('b', () => { throw new Error('boom') }), /boom/)
  on.done()
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'profile_blocks')
  assert.deepEqual(Object.keys(logged[0][1].blocks), ['a', 'b'])
})

async function server(t, extraEnv = {}, { dir: sharedDir } = {}) {
  const dir = sharedDir || mkdtempSync(path.join(tmpdir(), 'os-erp-aa5-'))
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
    if (!sharedDir) rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < SLOW_WAIT.extendedReadyAttempts && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `test-mode server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  const login = async (username, password) => {
    const lr = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, industry: 'cosmetic' })
    })
    return (await lr.json()).data.token
  }
  const token = await login('admin', '12345')
  const callAs = async (tok, route, init = {}) => {
    const res = await fetch(`${base}${route}`, {
      ...init, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    return { status: res.status, body: await res.json() }
  }
  const call = (route, init) => callAs(token, route, init)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return {
    base,
    api: (r) => call(r), post: (r, b) => call(r, { method: 'POST', body: JSON.stringify(b) }), db, output: () => output, dir,
    apiAs: (tok, r) => callAs(tok, r), token,
    /** 建一个受限（按组织）账号并登录；返回 token */
    async scopedUser(username, orgId) {
      const password = randomBytes(24).toString('base64url')
      const r = await call('/api/auth/users', { method: 'POST', body: JSON.stringify({ username, name: username, role: 'warehouse', password, org_id: orgId, data_scope: 'org' }) })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      return login(username, password)
    }
  }
}

test('GET /dashboard/summary: profile log only with GML_PROFILE=1, never in the body; AI stock_alert matches the original SQL', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const off = await server(t)
  const r0 = await off.api('/api/dashboard/summary')
  assert.equal(r0.status, 200)
  assert.ok(!off.output().includes('profile_blocks'), 'profiler must be silent by default')
  const ai0 = await off.post('/api/ai/query', { intent: 'stock_alert' })
  assert.equal(ai0.status, 200, JSON.stringify(ai0.body))
  const oldAi = off.db.prepare(OLD_AI).all()
  const aiRows = ai0.body.data.result
  assert.ok(Array.isArray(aiRows))
  assert.deepEqual(aiRows, oldAi.map((r) => ({ ...r })))

  const on = await server(t, { GML_PROFILE: '1' })
  const r1 = await on.api('/api/dashboard/summary')
  assert.equal(r1.status, 200)
  await delay(200)
  const line = on.output().split('\n').find((l) => l.includes('profile_blocks'))
  assert.ok(line, 'profile line expected')
  for (const k of ['today', 'month', 'inventory', 'alertsRow', 'below_safe']) assert.ok(line.includes(k), k)
  assert.ok(!JSON.stringify(r1.body).includes('profile'), 'no profiling data in the response')
  assert.deepEqual(Object.keys(r1.body.data), Object.keys(r0.body.data))
})

test('db-ttl-cache: hit inside TTL; invalidated by own writes, other-connection writes, TTL expiry and a new day; isolated per connection', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-aa5c-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'c.db')
  const a = new Database(file)
  const other = new Database(file)
  const b = new Database(path.join(dir, 'd.db'))
  t.after(() => { a.close(); other.close(); b.close() })
  a.pragma('journal_mode=WAL')
  for (const d of [a, b]) d.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)')
  let clock = 1000
  const opts = { ttlMs: 30000, now: () => clock }
  let calls = 0
  const compute = (d) => () => { calls++; return d.prepare('SELECT SUM(v) s FROM t').get().s }

  assert.deepEqual(strip(cachedForDb(a, compute(a), opts)), { value: 1, hit: false })
  assert.deepEqual(strip(cachedForDb(a, compute(a), opts)), { value: 1, hit: true })
  assert.equal(calls, 1)
  // 另一个连接的缓存互不串（同表名、不同库）
  b.prepare('UPDATE t SET v=50').run()
  assert.deepEqual(strip(cachedForDb(b, compute(b), opts)), { value: 50, hit: false })
  assert.deepEqual(strip(cachedForDb(a, compute(a), opts)), { value: 1, hit: true })
  // 本连接写入 → 立即失效
  a.prepare('INSERT INTO t VALUES (2)').run()
  assert.deepEqual(strip(cachedForDb(a, compute(a), opts)), { value: 3, hit: false })
  assert.equal(cachedForDb(a, compute(a), opts).hit, true)
  // 其它连接（等价于其它进程）提交 → 立即失效
  other.prepare('INSERT INTO t VALUES (4)').run()
  assert.deepEqual(strip(cachedForDb(a, compute(a), opts)), { value: 7, hit: false })
  // 回滚的写入也失效（超集，不会漏）
  a.exec('BEGIN'); a.prepare('INSERT INTO t VALUES (100)').run(); a.exec('ROLLBACK')
  assert.equal(cachedForDb(a, compute(a), opts).hit, false)
  // TTL
  assert.equal(cachedForDb(a, compute(a), opts).hit, true)
  clock += 30001
  assert.equal(cachedForDb(a, compute(a), opts).hit, false)
  // 显式失效
  assert.equal(cachedForDb(a, compute(a), opts).hit, true)
  invalidateForDb(a)
  assert.equal(cachedForDb(a, compute(a), opts).hit, false)
  // 计算抛错不缓存
  invalidateForDb(a)
  assert.throws(() => cachedForDb(a, () => { throw new Error('boom') }, { ...opts, ttlMs: 30000 }), /boom/)
  assert.equal(cachedForDb(a, compute(a), opts).hit, false, 'a failed compute leaves nothing cached')
  // ttl=0 关闭
  const n0 = calls
  cachedForDb(a, compute(a), { ttlMs: 0 }); cachedForDb(a, compute(a), { ttlMs: 0 })
  assert.equal(calls, n0 + 2)
  // 环境变量
  assert.equal(cacheTtlMs({}), 30000)
  assert.equal(cacheTtlMs({ GML_DASHBOARD_CACHE_MS: '0' }), 0)
  assert.equal(cacheTtlMs({ GML_DASHBOARD_CACHE_MS: 'abc' }), 30000)
  assert.equal(cacheTtlMs({ GML_DASHBOARD_CACHE_MS: '-5' }), 30000)
})

test('db-ttl-cache: a new local day never reuses yesterday\'s result', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE t (v INTEGER)')
  const RealDate = globalThis.Date
  let fake = new RealDate(2026, 9, 23, 23, 59, 50)
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fake.getTime()])) }
    static now() { return fake.getTime() }
  }
  globalThis.Date = FakeDate
  t.after(() => { globalThis.Date = RealDate })
  let n = 0
  const run = () => cachedForDb(db, () => ++n, { ttlMs: 60000 })
  assert.equal(run().hit, false)
  assert.equal(run().hit, true)
  fake = new RealDate(2026, 9, 24, 0, 0, 5) // 跨零点，TTL 内
  assert.equal(run().hit, false, 'must recompute after local midnight')
})

test('dashboard summary is never stale: reflects writes made through another connection immediately, and repeated reads are cache hits', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const { api, db, output } = await server(t, { GML_PROFILE: '1' })
  const a = await api('/api/dashboard/summary')
  const b = await api('/api/dashboard/summary')
  assert.equal(a.status, 200)
  assert.deepEqual(b.body.data, a.body.data)
  await delay(200)
  const lines = output().split('\n').filter((l) => l.includes('profile_blocks'))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /cache=miss/)
  assert.match(lines[1], /cache=hit/, 'second read within 30 s with no writes must hit (requests themselves must not invalidate)')
  // 其它连接改库存：看板立即反映
  const row = db.prepare('SELECT id FROM inventory_stocks ORDER BY id LIMIT 1').get()
  db.prepare('UPDATE inventory_stocks SET qty_on_hand = qty_on_hand + 5 WHERE id=?').run(row.id)
  const c = await api('/api/dashboard/summary')
  assert.equal(c.body.data.inventory.qty, a.body.data.inventory.qty + 5)
  // 新增低库存 SKU：below_safe 立即 +1
  const before = c.body.data.alerts.below_safe
  const sku = db.prepare('SELECT id FROM product_skus WHERE status=\'active\' ORDER BY id LIMIT 1').get()
  db.prepare('UPDATE product_skus SET safe_stock = 999999 WHERE id=?').run(sku.id)
  const d = await api('/api/dashboard/summary')
  assert.ok(d.body.data.alerts.below_safe >= before)
  assert.equal(d.body.data.alerts.below_safe, countBelowSafe(db))
  // 响应体永远不含缓存 / 计时字段
  assert.ok(!/cache|profile/i.test(JSON.stringify(d.body.data)))
})

// ============================ AB2：其余四个看板接口的剖析、缓存与多进程失效（ADR-0044 补充）============================

const AB2_ROUTES = {
  trend: '/api/dashboard/trend',
  top: '/api/dashboard/top',
  todos: '/api/dashboard/todos',
  'inventory-dist': '/api/dashboard/inventory-dist'
}
const profileLines = (out, label) => out().split('\n').filter((l) => l.includes('profile_blocks') && l.includes(`label=${label}`))
/** 等到某个接口的 profile 行达到 n 条（子进程 stdout 与 HTTP 响应没有先后保证），默认最多 5 s */
async function waitProfile(out, label, n) {
  for (let i = 0; i < SLOW_WAIT.profileAttempts && profileLines(out, label).length < n; i++) await delay(50)
  assert.ok(profileLines(out, label).length >= n, `expected ${n} profile lines for ${label}, got ${profileLines(out, label).length}`)
}
const profileCache = (line) => /cache=(hit|miss)/.exec(line)?.[1]

test('AB2 db-ttl-cache: keyed entries are independent, any write drops all keys, the key set is bounded', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ab2c-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'k.db')
  const a = new Database(file)
  const other = new Database(file)
  t.after(() => { a.close(); other.close() })
  a.pragma('journal_mode=WAL')
  a.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)')
  let n = 0
  const run = (key, d = a) => cachedForDb(d, () => { n++; return `${key}:${d.prepare('SELECT SUM(v) s FROM t').get().s}` }, { ttlMs: 30000, key })
  assert.deepEqual(strip(run('trend:30')), { value: 'trend:30:1', hit: false })
  assert.deepEqual(strip(run('trend:7')), { value: 'trend:7:1', hit: false }, 'a different key is its own entry')
  assert.equal(run('trend:30').hit, true)
  assert.equal(run('trend:7').hit, true)
  assert.equal(n, 2)
  // 默认键（不传 key）与命名键互不影响，且 AA5 的调用方式不变
  assert.equal(cachedForDb(a, () => 'x', { ttlMs: 30000 }).hit, false)
  assert.equal(cachedForDb(a, () => 'y', { ttlMs: 30000 }).value, 'x')
  // 其它连接写入 → 所有键一起失效
  other.prepare('INSERT INTO t VALUES (5)').run()
  assert.deepEqual(strip(run('trend:30')), { value: 'trend:30:6', hit: false })
  assert.deepEqual(strip(run('trend:7')), { value: 'trend:7:6', hit: false })
  // 显式失效清空全部键
  invalidateForDb(a)
  assert.equal(run('trend:30').hit, false)
  // 键集合有上限（调用者可控的 days 不得撑爆内存），最近用过的保留
  for (let i = 0; i < 200; i++) run(`k${i}`)
  assert.ok(cacheKeyCount(a) <= 32, `bounded, got ${cacheKeyCount(a)}`)
  assert.equal(run('k199').hit, true, 'most recent key survives eviction')
  assert.equal(run('k0').hit, false, 'oldest key was evicted')
  // 计算抛错不留下该键
  assert.throws(() => cachedForDb(a, () => { throw new Error('boom') }, { ttlMs: 30000, key: 'bad' }), /boom/)
  assert.equal(cachedForDb(a, () => 'ok', { ttlMs: 30000, key: 'bad' }).hit, false)
})

test('AB2 trend/top/todos/inventory-dist: profile line per endpoint (log only), second read hits, ?days is part of the key, responses stay identical', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const base = {}
  for (const [name, route] of Object.entries(AB2_ROUTES)) {
    const a = await f.api(route)
    assert.equal(a.status, 200, `${name} ${JSON.stringify(a.body)}`)
    const b = await f.api(route)
    assert.deepEqual(b.body, a.body, `${name}: cached body must equal the computed one`)
    base[name] = a.body
    assert.ok(!/cache|profile/i.test(JSON.stringify(a.body.data)), `${name}: no cache or profile fields in the body`)
  }
  for (const name of Object.keys(AB2_ROUTES)) await waitProfile(f.output, `dashboard.${name}`, 2)
  for (const name of Object.keys(AB2_ROUTES)) {
    const lines = profileLines(f.output, `dashboard.${name}`)
    assert.equal(lines.length, 2, `${name}: one profile line per request`)
    assert.equal(profileCache(lines[0]), 'miss', name)
    assert.equal(profileCache(lines[1]), 'hit', `${name}: reads must not invalidate`)
    assert.match(lines[0], /blocks=\{/, name)
  }
  // 每个块一个键
  const keysOf = (name) => Object.keys(JSON.parse(/blocks=(\{.*\})/.exec(profileLines(f.output, `dashboard.${name}`)[0])[1]))
  assert.ok(['sales', 'purchase', 'online'].every((k) => keysOf('trend').includes(k)))
  assert.ok(['products', 'brands', 'dealers', 'stores'].every((k) => keysOf('top').includes(k)))
  assert.ok(['pendingDelivery', 'pendingReceipt', 'omsPending', 'stockAlerts', 'expiring'].every((k) => keysOf('todos').includes(k)))
  assert.ok(['stockAgg', 'assemble'].every((k) => keysOf('inventory-dist').includes(k)))
  // ?days 进键：7 天是新条目（未命中），再读命中；默认 30 与显式 30 是同一份
  const d7 = await f.api('/api/dashboard/trend?days=7')
  const d7b = await f.api('/api/dashboard/trend?days=7')
  const d30 = await f.api('/api/dashboard/trend?days=30')
  assert.deepEqual(d7b.body, d7.body)
  assert.deepEqual(d30.body, base.trend)
  await waitProfile(f.output, 'dashboard.trend', 5)
  const tl = profileLines(f.output, 'dashboard.trend').map(profileCache)
  assert.deepEqual(tl, ['miss', 'hit', 'miss', 'hit', 'hit'])
  // top 同样按 days
  const t7 = await f.api('/api/dashboard/top?days=7')
  const t7b = await f.api('/api/dashboard/top?days=7')
  assert.deepEqual(t7b.body, t7.body)
  await waitProfile(f.output, 'dashboard.top', 4)
  assert.deepEqual(profileLines(f.output, 'dashboard.top').map(profileCache), ['miss', 'hit', 'miss', 'hit'])
})

test('AB2 profiler stays silent by default on the four endpoints', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t)
  for (const route of Object.values(AB2_ROUTES)) assert.equal((await f.api(route)).status, 200)
  assert.ok(!f.output().includes('profile_blocks'))
})

test('AB2 cache never serves a global payload to a scope-restricted caller (route gate runs before the cache), and reads do not warm for them', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const orgId = f.db.prepare("SELECT org_id FROM warehouses WHERE code='WH01'").get().org_id
  const restricted = await f.scopedUser('ab2_scoped', orgId)
  // 先让管理员把四个接口的缓存全部预热
  for (const route of Object.values(AB2_ROUTES)) { await f.api(route); assert.equal((await f.api(route)).status, 200) }
  for (const n of Object.keys(AB2_ROUTES)) await waitProfile(f.output, `dashboard.${n}`, 2)
  const before = Object.keys(AB2_ROUTES).map((n) => profileLines(f.output, `dashboard.${n}`).length)
  for (const route of Object.values(AB2_ROUTES)) {
    const denied = await f.apiAs(restricted, route)
    assert.equal(denied.status, 403, route)
    assert.equal(denied.body.code, 'GLOBAL_DATA_FORBIDDEN', route)
    assert.equal(JSON.stringify(denied.body).includes('byWarehouse'), false)
    const anon = await f.apiAs(null, route)
    assert.equal(anon.status, 401, route)
  }
  await delay(500) // 负向断言：给（不应出现的）日志留出到达时间
  const after = Object.keys(AB2_ROUTES).map((n) => profileLines(f.output, `dashboard.${n}`).length)
  assert.deepEqual(after, before, 'rejected requests never reach the handler or the cache')
})

const SQL_WRITER = `
const Database = require('better-sqlite3')
const db = new Database(process.env.AB2_DB)
const today = db.prepare("SELECT date('now','localtime') d").get().d
const dealer = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get().id
const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
const so = db.prepare("INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, receivable_amount) VALUES (?, 'dealer', ?, ?, 'confirmed', 1, 99999999)")
  .run(process.env.AB2_DOC, dealer, today).lastInsertRowid
db.prepare('INSERT INTO sales_order_items (order_id, sku_id, qty, price, amount) VALUES (?,?,1,99999999,99999999)').run(so, sku)
// 待发货清单按 order_date 升序取前 10：再补一张最早的已确认单，保证它出现在 todos 里
db.prepare("INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, receivable_amount) VALUES (?, 'dealer', ?, '1999-01-01', 'confirmed', 1, 1)")
  .run(process.env.AB2_DOC + '-OLD', dealer)
db.close()
console.log('WROTE')
`

test('AB2 two processes on one DB file: another process\'s commit drops this process\'s cache for all four endpoints (data_version)', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const A = await server(t, { GML_PROFILE: '1' })
  // 第二个 server 进程：同一数据目录（同一个库文件），另一个随机端口；先登录（登录会写 last_login_at），再预热 A，避免登录写入干扰命中判断
  const B = await server(t, {}, { dir: A.dir })
  const warm = async () => {
    const out = {}
    for (const [name, route] of Object.entries(AB2_ROUTES)) {
      await A.api(route)
      const second = await A.api(route)
      assert.equal(second.status, 200)
      out[name] = second.body.data
    }
    return out
  }
  const countHits = () => Object.keys(AB2_ROUTES).map((n) => profileLines(A.output, `dashboard.${n}`).map(profileCache))
  const w0 = await warm()
  for (const n of Object.keys(AB2_ROUTES)) await waitProfile(A.output, `dashboard.${n}`, 2)
  for (const seq of countHits()) assert.deepEqual(seq, ['miss', 'hit'])

  // ① 进程 B 经 HTTP 新建仓库 → A 的 inventory-dist（及其余三个）立即失效并反映
  const created = await B.post('/api/master/warehouses', { code: 'AB2-W', name: 'ab2 两进程仓' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const dist = await A.api('/api/dashboard/inventory-dist')
  assert.ok(dist.body.data.byWarehouse.some((w) => w.warehouse_name === 'ab2 两进程仓'), 'process A must see the warehouse committed by process B')
  assert.equal(w0['inventory-dist'].byWarehouse.some((w) => w.warehouse_name === 'ab2 两进程仓'), false)
  for (const route of [AB2_ROUTES.trend, AB2_ROUTES.top, AB2_ROUTES.todos]) await A.api(route)
  for (const n of Object.keys(AB2_ROUTES)) await waitProfile(A.output, `dashboard.${n}`, 3)
  for (const seq of countHits()) assert.equal(seq[2], 'miss', 'every cached endpoint of A recomputes after B committed')

  // ② 独立 node 进程直接写 SQL（单据 + 明细）→ trend / top / todos 的内容立即变化
  await warm()
  const w = spawn(process.execPath, ['-e', SQL_WRITER], { cwd: ROOT, env: { PATH: process.env.PATH, AB2_DB: path.join(A.dir, 'gml_cosmetic.db'), AB2_DOC: 'AB2-SO-0001' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let wout = ''
  w.stdout.on('data', (d) => { wout += d }); w.stderr.on('data', (d) => { wout += d })
  const [code] = await once(w, 'close')
  assert.equal(code, 0, wout)
  const trend = await A.api('/api/dashboard/trend')
  assert.ok(trend.body.data.some((x) => x.offline >= 99999999), 'trend reflects the order written by a separate process')
  const todos = await A.api('/api/dashboard/todos')
  assert.ok(todos.body.data.pendingDelivery.some((x) => x.doc_no === 'AB2-SO-0001-OLD'))
  const top = await A.api('/api/dashboard/top')
  assert.ok(top.body.data.products[0].amount >= 99999999)
  assert.equal(top.body.data.dealers[0].amount >= 99999999, true)
  // 写入之后重复读重新命中（说明失效来自写入，不是缓存坏了）
  assert.deepEqual((await A.api('/api/dashboard/top')).body, top.body)
  await waitProfile(A.output, 'dashboard.top', 7)
  assert.equal(profileCache(profileLines(A.output, 'dashboard.top').at(-1)), 'hit')
})

// ---- AB2：改写后的 SQL 与 batch-ten 的原写法逐行比较（原写法逐字保留作为对照）----
const FROM30 = "date('now','localtime','-30 day')"
const OLD_TOP = {
  products: `SELECT p.name AS product_name, b.name AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${FROM30}
         GROUP BY p.id ORDER BY amount DESC LIMIT 10`,
  brands: `SELECT COALESCE(b.name,'未标品牌') AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${FROM30}
         GROUP BY b.id ORDER BY amount DESC LIMIT 10`
}
const OLD_DIST = {
  byWarehouse: `SELECT w.name AS warehouse_name, w.type, COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM warehouses w LEFT JOIN inventory_stocks st ON st.warehouse_id=w.id GROUP BY w.id ORDER BY amount DESC, w.id`,
  byCategory: `SELECT COALESCE(c.name,'未分类') AS category_name, COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN categories c ON c.id=p.category_id GROUP BY c.id ORDER BY amount DESC`
}
// 浮点求和顺序可以不同（最后一位）；比较时对数值取 4 位小数
const norm = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v])))

test('AB2 /top and /inventory-dist rewrites return the same rows as the original SQL on a varied fixture', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t)
  const db = f.db
  db.pragma('foreign_keys=OFF')
  // 受控夹具：清掉演示种子的销售单，保证 LIMIT 10 的榜单里只有下面这些行（边界用例不会被种子数据挤出榜外）
  db.exec('DELETE FROM sales_order_items; DELETE FROM sales_orders')
  const today = db.prepare("SELECT date('now','localtime') d").get().d
  const old = db.prepare("SELECT date('now','localtime','-90 day') d").get().d
  const dealers = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 3').all().map((x) => x.id)
  const stores = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 2').all().map((x) => x.id)
  const brandId = Number(db.prepare("INSERT INTO brands (code, name) VALUES ('AB2-B', 'AB2品牌')").run().lastInsertRowid)
  const catId = Number(db.prepare("INSERT INTO categories (code, name) VALUES ('AB2-C', 'AB2品类')").run().lastInsertRowid)
  const mkSku = (code, brand, cat) => {
    const p = Number(db.prepare('INSERT INTO products (spu_code, name, brand_id, category_id) VALUES (?,?,?,?)').run(`AB2-${code}`, `ab2-${code}`, brand, cat).lastInsertRowid)
    return Number(db.prepare('INSERT INTO product_skus (product_id, sku_code, name, status) VALUES (?,?,?,?)').run(p, `AB2-K-${code}`, `k-${code}`, 'active').lastInsertRowid)
  }
  const skus = { branded: mkSku('b', brandId, catId), noBrand: mkSku('n', null, null), tieA: mkSku('ta', brandId, catId), tieB: mkSku('tb', brandId, catId) }
  let n = 0
  const order = (status, date, items, { dealer = null, store = null } = {}) => {
    const id = Number(db.prepare("INSERT INTO sales_orders (doc_no, channel, dealer_id, store_id, order_date, status, total_qty, receivable_amount) VALUES (?, 'dealer', ?, ?, ?, ?, 1, ?)")
      .run(`AB2-EQ-${++n}`, dealer, store, date, status, items.reduce((a, [, , amt]) => a + amt, 0)).lastInsertRowid)
    for (const [sku, qty, amt] of items) db.prepare('INSERT INTO sales_order_items (order_id, sku_id, qty, price, amount) VALUES (?,?,?,?,?)').run(id, sku, qty, amt / qty, amt)
  }
  order('confirmed', today, [[skus.branded, 3, 300.3], [skus.noBrand, 2, 200.2]], { dealer: dealers[0] })
  order('shipped', today, [[skus.tieA, 1, 100], [skus.tieB, 1, 100]], { dealer: dealers[1], store: stores[0] })
  order('cancelled', today, [[skus.branded, 99, 99999]], { dealer: dealers[0] }) // 取消不计
  order('draft', today, [[skus.noBrand, 99, 99999]], { store: stores[1] }) // 草稿不计
  order('confirmed', old, [[skus.branded, 50, 50000]], { dealer: dealers[2] }) // 窗口外不计
  const wh = db.prepare('INSERT INTO warehouses (code, name, type) VALUES (?,?,?)')
  wh.run('AB2-E1', 'ab2 空仓1', 'normal'); wh.run('AB2-E2', 'ab2 空仓2', 'normal') // 无库存 + 并列 0 金额
  const w3 = Number(wh.run('AB2-S', 'ab2 有货仓', 'normal').lastInsertRowid)
  const st = db.prepare('INSERT INTO inventory_stocks (warehouse_id, sku_id, batch_no, qty_on_hand, cost_price) VALUES (?,?,?,?,?)')
  st.run(w3, skus.branded, 'a', 10, 1.1); st.run(w3, skus.noBrand, 'a', 7, 2.35); st.run(w3, skus.tieA, 'a', -2, 4)
  const w1 = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get().id
  st.run(w1, skus.branded, 'b', 5, 1.1)
  db.pragma('foreign_keys=ON')

  const top = (await f.api('/api/dashboard/top')).body.data
  for (const k of ['products', 'brands']) {
    const want = db.prepare(OLD_TOP[k]).all()
    assert.deepEqual(norm(top[k]), norm(want), k)
  }
  assert.equal(top.products.length, 4, 'branded, unbranded and the two tied products')
  assert.deepEqual(top.brands.map((b) => b.brand_name).sort(), ['AB2品牌', '未标品牌'].sort())
  assert.ok(top.products.some((p) => p.brand_name === null), 'the unbranded product is in the ranking')
  assert.equal(top.dealers.length, 2); assert.equal(top.stores.length, 1)
  assert.ok(!top.products.some((p) => p.qty === 99), 'cancelled / draft / out-of-window rows excluded')
  const dist = (await f.api('/api/dashboard/inventory-dist')).body.data
  for (const k of ['byWarehouse', 'byCategory']) {
    const want = db.prepare(OLD_DIST[k]).all()
    assert.deepEqual(norm(dist[k]), norm(want), k)
  }
  assert.ok(dist.byWarehouse.some((w) => w.warehouse_name === 'ab2 空仓1' && w.qty === 0 && w.amount === 0), 'warehouses without stock still listed with zeros')
  const names = dist.byWarehouse.map((w) => w.warehouse_name)
  assert.ok(names.indexOf('ab2 空仓1') < names.indexOf('ab2 空仓2'), 'ties are ordered by warehouse id (deterministic)')
  assert.ok(dist.byCategory.some((c) => c.category_name === '未分类') && dist.byCategory.some((c) => c.category_name === 'AB2品类'))
})

// ============================ AC11：缓存时间戳（cached_at / cache_ttl_ms / X-Dashboard-Cache）============================

test('AC11 db-ttl-cache reports when the value was computed: a hit keeps the original stamp, a miss gets a new one', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE t (v INTEGER)')
  let clock = 5000
  const opts = { ttlMs: 30000, now: () => clock }
  const first = cachedForDb(db, () => 1, opts)
  assert.equal(first.at, 5000)
  clock = 9000
  const hit = cachedForDb(db, () => 2, opts)
  assert.equal(hit.hit, true)
  assert.equal(hit.at, 5000, 'a hit reports the compute time, not the read time')
  clock = 5000 + 30001
  const miss = cachedForDb(db, () => 3, opts)
  assert.equal(miss.hit, false)
  assert.equal(miss.at, clock)
  // 缓存关闭：每次都是现算，戳是现在
  clock = 70000
  assert.equal(cachedForDb(db, () => 4, { ttlMs: 0, now: () => clock }).at, 70000)
})

test('AC11 the five cached dashboard endpoints carry cached_at + cache_ttl_ms + X-Dashboard-Cache; recent stays unstamped; a write restamps', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t)
  const raw = async (route) => {
    const res = await fetch(new URL(route, f.base), { headers: { authorization: `Bearer ${f.token}` } })
    return { status: res.status, cache: res.headers.get('x-dashboard-cache'), body: await res.json() }
  }
  for (const route of ['summary', 'trend', 'top', 'todos', 'inventory-dist', 'channel']) { // AC4 把 /channel 也接进了 cachedRead
    const a = await raw(`/api/dashboard/${route}`)
    assert.equal(a.status, 200, route)
    assert.equal(a.cache, 'miss', route)
    assert.match(a.body.cached_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, route)
    assert.equal(a.body.cache_ttl_ms, 30000, route)
    const b = await raw(`/api/dashboard/${route}`)
    assert.equal(b.cache, 'hit', route)
    assert.equal(b.body.cached_at, a.body.cached_at, `${route}: a hit keeps the original stamp`)
  }
  for (const route of ['recent']) {
    const r = await raw(`/api/dashboard/${route}`)
    assert.equal(r.status, 200, route)
    assert.equal('cached_at' in r.body, false, `${route} is not cached, so it carries no stamp`)
    assert.equal(r.cache, null, route)
  }
  const before = (await raw('/api/dashboard/summary')).body.cached_at
  await delay(20)
  const row = f.db.prepare('SELECT id FROM inventory_stocks ORDER BY id LIMIT 1').get()
  f.db.prepare('UPDATE inventory_stocks SET qty_on_hand = qty_on_hand + 1 WHERE id=?').run(row.id)
  const after = await raw('/api/dashboard/summary')
  assert.equal(after.cache, 'miss')
  assert.ok(Date.parse(after.body.cached_at) > Date.parse(before), 'after a write the stamp moves forward')
})

test('AC11 GML_DASHBOARD_CACHE_MS=0 reports cache_ttl_ms 0 so the page can say "not cached"', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_DASHBOARD_CACHE_MS: '0' })
  const res = await fetch(new URL('/api/dashboard/summary', f.base), { headers: { authorization: `Bearer ${f.token}` } })
  const body = await res.json()
  assert.equal(body.cache_ttl_ms, 0)
  assert.match(body.cached_at, /^\d{4}-/)
})

// ============================ AC4：/channel、/recent 剖析，explain-audit 登记，缓存命中率阈值依据（ADR-0044 补充 2）============================

import * as dsql from '../../server/lib/dashboard-sql.js'
import { auditStatements, STATEMENTS, ALLOW } from '../../scripts/explain-audit.mjs'
import { counterSnapshot, resetCounters } from '../../server/lib/process-counters.js'

const AC4_ROUTES = { channel: '/api/dashboard/channel', recent: '/api/dashboard/recent' }

// 原写法（batch-eleven 的 channel 处理器内联 SQL，逐字保留作对照）
const OLD_CHANNEL = (days) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    offline: `SELECT channel, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
         WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from} AND channel <> 'platform' GROUP BY channel`,
    online: `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount
         FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id
         WHERE date(o.order_time) >= ${from} AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`
  }
}

test('AC4 explain-audit statements for dashboard come from the route-side SQL module (no hand copy), with declared indexes', () => {
  const route = readFileSync(new URL('../../server/routes/dashboard.js', import.meta.url), 'utf8')
  // 路由里不再内联这些语句：所有文本都来自 lib/dashboard-sql.js，explain-audit 引用的是同一份
  assert.match(route, /from '\.\.\/lib\/dashboard-sql\.js'/)
  for (const frag of ['CROSS JOIN', 'LEFT JOIN platforms pf ON pf.id=o.platform_id', 'FROM inventory_stocks st LEFT JOIN', 'ORDER BY so.id DESC']) assert.ok(!route.includes(frag), `route must not inline: ${frag}`)
  const byId = new Map(STATEMENTS.map((s) => [s.id, s]))
  const expect = {
    'dash.top_products': [dsql.topProductsSql(30), 'idx_so_order_date'],
    'dash.top_brands': [dsql.topBrandsSql(30), 'idx_so_order_date'],
    'dash.top_dealers': [dsql.topDealersSql(30), 'idx_so_order_date'],
    'dash.top_stores': [dsql.topStoresSql(30), 'idx_so_order_date'],
    'dash.inventory_dist_agg': [dsql.INVENTORY_DIST_AGG_SQL, undefined],
    'dash.channel_offline': [dsql.channelOfflineSql(90), 'idx_so_order_date'],
    'dash.channel_online': [dsql.channelOnlineSql(), 'idx_oms_order_time'],
    'dash.recent_sales': [dsql.RECENT_SQL.salesOrders, undefined],
    'dash.recent_purchase': [dsql.RECENT_SQL.purchaseOrders, undefined],
    'dash.recent_oms': [dsql.RECENT_SQL.omsOrders, undefined],
    'dash.recent_txn': [dsql.RECENT_SQL.transactions, undefined]
  }
  for (const [id, [sql, idx]] of Object.entries(expect)) {
    const s = byId.get(id)
    assert.ok(s, `${id} must be registered`)
    assert.equal(s.sql, sql, `${id}: SQL text must be the route module's text`)
    assert.equal(s.expectIndex, idx, `${id}: expectIndex`)
    assert.match(s.mirrors, /dashboard-sql\.js/, id)
  }
  // 登记的 /top 语句确实是 CROSS JOIN 写法（固定先取窗口内订单）
  assert.match(byId.get('dash.top_products').sql, /sales_orders so CROSS JOIN sales_order_items/)
})

test('AC4 explain-audit: the registered dashboard statements pass on a migrated schema; /top starts from idx_so_order_date then idx_soi_order; a plain JOIN would not be pinned', (t) => {
  const { db } = fixture(t)
  const ids = ['dash.top_products', 'dash.top_brands', 'dash.top_dealers', 'dash.top_stores', 'dash.inventory_dist_agg', 'dash.channel_offline', 'dash.channel_online', 'dash.recent_sales', 'dash.recent_purchase', 'dash.recent_oms', 'dash.recent_txn']
  const subset = STATEMENTS.filter((s) => ids.includes(s.id))
  assert.equal(subset.length, ids.length)
  const rep = auditStatements(db, subset, { allow: ALLOW.filter((a) => ids.includes(a.statement)) })
  assert.deepEqual(rep.violations, [])
  assert.equal(rep.unusedAllow.length, 0, 'every exemption for these statements is exercised')
  const plan = (id) => rep.statements.find((s) => s.id === id).plan
  for (const id of ['dash.top_products', 'dash.top_brands']) {
    assert.match(plan(id)[0], /SEARCH so USING INDEX idx_so_order_date/, `${id}: orders first, by the date index`)
    assert.ok(plan(id).some((d) => /SEARCH i USING INDEX idx_soi_order/.test(d)), `${id}: items by idx_soi_order`)
  }
  // 反例：把同一语句改回普通 JOIN 再声明 expectIndex，审计要么选别的计划（红），要么保持；这里只断言守卫真的会检查 expectIndex
  const bad = auditStatements(db, [{ id: 'x', mirrors: 't', sql: dsql.topBrandsSql(30), expectIndex: 'idx_does_not_exist' }], { allow: [] })
  assert.equal(bad.ok, false)
  assert.match(bad.violations.at(-1).reason, /idx_does_not_exist/)
})

test('AC4 /channel: profiled, cached per ?days, identical to the original SQL, invalidated by writes; body carries no cache/profile fields', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const db = f.db
  db.pragma('foreign_keys=OFF')
  const pf = Number(db.prepare("INSERT INTO platforms (code, name) VALUES ('AC4-P', 'AC4平台')").run().lastInsertRowid)
  const io = db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?,?,datetime('now','localtime',?),?,?)")
  io.run(pf, 'AC4-1', '-1 day', 'pending', 100.5); io.run(pf, 'AC4-2', '-40 day', 'shipped', 200); io.run(pf, 'AC4-3', '-100 day', 'shipped', 999)
  io.run(pf, 'AC4-4', '-2 day', 'refunded', 77); io.run(987654, 'AC4-5', '-3 day', 'completed', 5) // 退款不计；无平台 → 未知平台
  db.pragma('foreign_keys=ON')
  const a = await f.api(AC4_ROUTES.channel)
  assert.equal(a.status, 200, JSON.stringify(a.body))
  const b = await f.api(AC4_ROUTES.channel)
  assert.deepEqual(b.body, a.body)
  assert.ok(!/cache|profile/i.test(JSON.stringify(a.body.data)))
  assert.deepEqual(Object.keys(a.body.data), ['offline', 'online'])
  const q = OLD_CHANNEL(90)
  assert.deepEqual(a.body.data.online, db.prepare(q.online).all())
  const labels = { dealer: '经销商分销', store: '门店零售', online: '自营商城', platform: '平台电商', live: '直播电商' }
  assert.deepEqual(a.body.data.offline, db.prepare(q.offline).all().map((x) => ({ name: labels[x.channel] || x.channel, ...x })))
  assert.ok(a.body.data.online.some((x) => x.platform_name === 'AC4平台' && x.orders === 2 && x.amount === 300.5), '90-day window: -1d and -40d, not -100d, not refunded')
  assert.ok(a.body.data.online.some((x) => x.platform_name === '未知平台'))
  // ?days 进键：30 天是新条目，窗口不同 → 结果不同；默认 90 与显式 90 是同一份
  const d30 = await f.api(`${AC4_ROUTES.channel}?days=30`)
  const d30b = await f.api(`${AC4_ROUTES.channel}?days=30`)
  const d90 = await f.api(`${AC4_ROUTES.channel}?days=90`)
  assert.deepEqual(d30b.body, d30.body)
  assert.deepEqual(d90.body, a.body)
  assert.deepEqual(d30.body.data.online, db.prepare(OLD_CHANNEL(30).online).all())
  assert.notDeepEqual(d30.body.data.online, a.body.data.online)
  await waitProfile(f.output, 'dashboard.channel', 5)
  assert.deepEqual(profileLines(f.output, 'dashboard.channel').map(profileCache), ['miss', 'hit', 'miss', 'hit', 'hit'])
  const keys = Object.keys(JSON.parse(/blocks=(\{.*\})/.exec(profileLines(f.output, 'dashboard.channel')[0])[1]))
  assert.ok(['offline', 'online'].every((k) => keys.includes(k)), `per-block timings: ${keys}`)
  // 任何写入立即失效：新增一单后马上反映
  db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?, 'AC4-6', datetime('now','localtime'), 'pending', 50)").run(pf)
  const after = await f.api(AC4_ROUTES.channel)
  assert.equal(after.body.data.online.find((x) => x.platform_name === 'AC4平台').orders, 3)
  await waitProfile(f.output, 'dashboard.channel', 6)
  assert.equal(profileCache(profileLines(f.output, 'dashboard.channel').at(-1)), 'miss')
})

test('AC4 /recent: profiled but deliberately not cached (cache=off), always fresh right after a write, shape unchanged', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const a = await f.api(AC4_ROUTES.recent)
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.deepEqual(Object.keys(a.body.data), ['salesOrders', 'purchaseOrders', 'omsOrders', 'transactions'])
  assert.ok(a.body.data.salesOrders.length <= 8)
  for (const [k, sql] of Object.entries(dsql.RECENT_SQL)) assert.deepEqual(a.body.data[k], f.db.prepare(sql).all(), k)
  const n0 = a.body.data.salesOrders[0]?.doc_no
  f.db.prepare("INSERT INTO sales_orders (doc_no, channel, order_date, status, total_qty, receivable_amount) VALUES ('AC4-RECENT', 'store', date('now','localtime'), 'confirmed', 1, 1)").run()
  const b = await f.api(AC4_ROUTES.recent)
  assert.equal(b.body.data.salesOrders[0].doc_no, 'AC4-RECENT')
  assert.notEqual(n0, 'AC4-RECENT')
  await waitProfile(f.output, 'dashboard.recent', 2)
  const lines = profileLines(f.output, 'dashboard.recent')
  assert.ok(lines.every((l) => /cache=off/.test(l)), 'recent is profiled and reports cache=off')
  const keys = Object.keys(JSON.parse(/blocks=(\{.*\})/.exec(lines[0])[1]))
  assert.deepEqual(keys, ['salesOrders', 'purchaseOrders', 'omsOrders', 'transactions'])
  assert.ok(!/cache|profile/i.test(JSON.stringify(a.body.data)))
})

test('AC4 /channel and /recent: silent profiler by default; restricted callers are rejected before the handler and never warm the cache', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const quiet = await server(t)
  for (const route of Object.values(AC4_ROUTES)) assert.equal((await quiet.api(route)).status, 200)
  assert.ok(!quiet.output().includes('profile_blocks'))
  const f = await server(t, { GML_PROFILE: '1' })
  const orgId = f.db.prepare("SELECT org_id FROM warehouses WHERE code='WH01'").get().org_id
  const restricted = await f.scopedUser('ac4_scoped', orgId)
  for (const route of Object.values(AC4_ROUTES)) { await f.api(route); assert.equal((await f.api(route)).status, 200) }
  for (const n of Object.keys(AC4_ROUTES)) await waitProfile(f.output, `dashboard.${n}`, 2)
  const before = Object.keys(AC4_ROUTES).map((n) => profileLines(f.output, `dashboard.${n}`).length)
  for (const route of Object.values(AC4_ROUTES)) {
    const denied = await f.apiAs(restricted, route)
    assert.equal(denied.status, 403, route)
    assert.equal(denied.body.code, 'GLOBAL_DATA_FORBIDDEN', route)
    assert.equal((await f.apiAs(null, route)).status, 401, route)
  }
  await delay(500)
  assert.deepEqual(Object.keys(AC4_ROUTES).map((n) => profileLines(f.output, `dashboard.${n}`).length), before)
})

// ---- 缓存命中率告警阈值依据（docs/operations/monitoring.md 引用本模型）----
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 } }
/** 用真实的 cachedForDb（注入时钟）模拟：每 readEvery 秒读一次，写入间隔服从均值 writeMean 秒的指数分布；返回命中率并核对 AB10 计数器 */
function simulateHitRatio({ readEvery, writeMean, horizonS = 6 * 3600, ttlMs = 30000, seed = 7 }) {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE w(x)')
    const rnd = mulberry32(seed)
    const gap = () => -Math.log(1 - rnd()) * writeMean
    const ins = db.prepare('INSERT INTO w VALUES (1)')
    resetCounters()
    let nextW = gap(), hit = 0, miss = 0
    for (let s = readEvery; s <= horizonS; s += readEvery) {
      while (nextW <= s) { ins.run(); nextW += gap() }
      const r = cachedForDb(db, () => 1, { ttlMs, now: () => s * 1000, key: 'k' })
      if (r.hit) hit++; else miss++
    }
    const c = counterSnapshot().dashboard_cache_total
    assert.equal(c.hit, hit, 'AB10 hit counter equals observed hits')
    assert.equal(c.miss, miss, 'AB10 miss counter equals observed misses')
    return hit / (hit + miss)
  } finally { db.close() }
}

test('AC4 cache hit-ratio model (real cachedForDb, injected clock): ratio is monotone in write rate, capped by TTL/poll interval, and falls below the 20% alert line only under sustained frequent writes', () => {
  const ALERT = 0.2
  for (const readEvery of [5, 15]) {
    const ceiling = Math.floor(30 / readEvery) / (Math.floor(30 / readEvery) + 1) // 每次未命中后最多 floor(ttl/poll) 次命中
    let prev = -1
    const ratios = [900, 300, 120, 60, 30, 15, 10, 5, 2].map((w) => ({ w, r: simulateHitRatio({ readEvery, writeMean: w }) }))
    for (const { r } of ratios.slice().reverse()) { assert.ok(r >= prev - 0.02, 'monotone (allowing sampling noise)'); prev = r }
    assert.ok(ratios[0].r <= ceiling + 0.005 && ratios[0].r >= ceiling - 0.05, `quiet instance approaches the ceiling ${ceiling.toFixed(3)} (got ${ratios[0].r.toFixed(3)})`)
    // 写入平均间隔 >= 30 s：远高于告警线；平均每 2 s 一次写入：低于告警线
    assert.ok(ratios.find((x) => x.w === 30).r > 2 * ALERT, `poll ${readEvery}s, write/30s stays well above the alert line`)
    assert.ok(ratios.find((x) => x.w === 2).r < ALERT, `poll ${readEvery}s, write/2s is below the alert line`)
  }
  // 15 s 轮询时，告警线（20%）对应平均约每 10 s 一次写入
  const at10 = simulateHitRatio({ readEvery: 15, writeMean: 10 })
  assert.ok(at10 > 0.1 && at10 < 0.3, `poll 15s, write/10s ~ the alert line, got ${at10.toFixed(3)}`)
  // TTL 关闭（0）→ 不计数、命中率无从谈起；告警表达式的最小样本（> 60 次/30 分钟）因此不会误报
  const db = new Database(':memory:')
  resetCounters()
  assert.equal(cachedForDb(db, () => 1, { ttlMs: 0 }).hit, false)
  assert.deepEqual(counterSnapshot().dashboard_cache_total, { hit: 0, miss: 0 })
  db.close()
})

// ---- Codex 审计（AC4）补强 ----
test('AC4 route responses equal the results of the registered explain-audit statements (audited SQL = executed SQL, by behaviour not just text)', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t)
  const st = (id) => STATEMENTS.find((s) => s.id === id).sql
  const top = (await f.api('/api/dashboard/top')).body.data // 默认窗口 30 天，与登记一致
  assert.deepEqual(top.products, f.db.prepare(st('dash.top_products')).all())
  assert.deepEqual(top.brands, f.db.prepare(st('dash.top_brands')).all())
  assert.deepEqual(top.dealers, f.db.prepare(st('dash.top_dealers')).all())
  assert.deepEqual(top.stores, f.db.prepare(st('dash.top_stores')).all())
  assert.ok(top.products.length > 0 && top.dealers.length > 0, 'the demo seed gives the comparison something to compare')
  const ch = (await f.api('/api/dashboard/channel')).body.data // 默认窗口 90 天
  const chOn = STATEMENTS.find((x) => x.id === 'dash.channel_online')
  assert.deepEqual(ch.online, f.db.prepare(chOn.sql).all(...chOn.params))
  assert.deepEqual(ch.offline.map(({ name, ...x }) => x), f.db.prepare(st('dash.channel_offline')).all())
  const rec = (await f.api('/api/dashboard/recent')).body.data
  assert.deepEqual(rec.salesOrders, f.db.prepare(st('dash.recent_sales')).all())
  assert.deepEqual(rec.purchaseOrders, f.db.prepare(st('dash.recent_purchase')).all())
  assert.deepEqual(rec.omsOrders, f.db.prepare(st('dash.recent_oms')).all())
  assert.deepEqual(rec.transactions, f.db.prepare(st('dash.recent_txn')).all())
})

test('AC4 a rejected caller on a cold /channel key neither runs the handler nor warms the key: the first authorized read of that key is still a miss', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const orgId = f.db.prepare("SELECT org_id FROM warehouses WHERE code='WH01'").get().org_id
  const restricted = await f.scopedUser('ac4_cold', orgId)
  const cold = `${AC4_ROUTES.channel}?days=45`
  assert.equal((await f.apiAs(restricted, cold)).status, 403)
  assert.equal((await f.apiAs(null, cold)).status, 401)
  await delay(500)
  assert.equal(profileLines(f.output, 'dashboard.channel').length, 0, 'no handler run for rejected callers')
  assert.equal((await f.api(cold)).status, 200)
  await waitProfile(f.output, 'dashboard.channel', 1)
  assert.equal(profileCache(profileLines(f.output, 'dashboard.channel')[0]), 'miss')
})

test('AC4 hit ratio can be zero with no writes at all: the per-key read interval vs TTL matters, not only writes (alert description)', () => {
  const quiet = (readEvery) => simulateHitRatio({ readEvery, writeMean: 1e9, horizonS: 3600 })
  assert.ok(Math.abs(quiet(10) - 0.75) < 0.01, 'every 10 s: 3 hits per miss')
  assert.ok(Math.abs(quiet(15) - 2 / 3) < 0.01, 'every 15 s: boundary read at exactly TTL still hits')
  assert.ok(Math.abs(quiet(16) - 0.5) < 0.01, 'every 16 s: one hit per miss (floor(30/16)=1)')
  assert.equal(quiet(31), 0, 'a key read less often than the TTL never hits, even with zero writes')
  // 多个键（端点 × days）各自慢速读取：聚合计数 > 60 次 / 30 分钟（告警的样本量条件）而命中率为 0
  const db = new Database(':memory:')
  try {
    resetCounters()
    for (let s = 60; s <= 1800; s += 60) for (const key of ['summary', 'trend:30', 'top:30', 'todos', 'channel:90']) cachedForDb(db, () => 1, { ttlMs: 30000, now: () => s * 1000, key })
    const c = counterSnapshot().dashboard_cache_total
    assert.deepEqual(c, { hit: 0, miss: 150 })
  } finally { db.close() }
})

// ---- AD3：oms_orders.order_time 索引（迁移 070）与 trend / channel 线上分支的区间谓词 ----
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const requireCjs = createRequire(import.meta.url)

/** 改写前的 SQL 文本（batch-twelve 的 dashboard.js / dashboard-sql.js，逐字保留作对照） */
const OLD_ONLINE = (days) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    trend: `SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders
       WHERE date(order_time) >= ${from} GROUP BY date(order_time) ORDER BY date`,
    channel: `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount
         FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id
         WHERE date(o.order_time) >= ${from} AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`
  }
}
const OLD_TREND = (days) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    sales: `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from} GROUP BY order_date ORDER BY date`,
    purchase: `SELECT order_date AS date, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
       WHERE status <> 'cancelled' AND order_date >= ${from} GROUP BY order_date ORDER BY date`
  }
}

test('AD3 migration 070: creates idx_oms_order_time, idempotent, verify() follows up()', (t) => {
  const { db } = fixture(t)
  const mig = requireCjs('../../server/db/migrations/070_oms_order_time_index.cjs')
  const idx = () => db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_oms_order_time'").get()
  assert.match(idx().sql, /oms_orders\s*\(\s*order_time\s*,\s*status\s*,\s*platform_id\s*,\s*pay_amount\s*\)/, 'order_time-leading covering index for the two dashboard queries')
  assert.equal(mig.verify(db), true)
  db.exec('DROP INDEX idx_oms_order_time')
  assert.equal(mig.verify(db), false, 'verify detects the missing index')
  mig.up(db); mig.up(db) // 幂等
  assert.equal(mig.verify(db), true)
  assert.ok(idx())
  // Codex 审计：同名但定义不对的索引——verify 为假，up 修复
  db.exec('DROP INDEX idx_oms_order_time; CREATE INDEX idx_oms_order_time ON oms_orders(status)')
  assert.equal(mig.verify(db), false, 'verify checks the definition, not just the name')
  mig.up(db)
  assert.equal(mig.verify(db), true)
  assert.match(idx().sql, /order_time\s*,\s*status\s*,\s*platform_id\s*,\s*pay_amount/)
  db.exec('DROP INDEX idx_oms_order_time; CREATE UNIQUE INDEX idx_oms_order_time ON oms_orders(order_time, status, platform_id, pay_amount)')
  assert.equal(mig.verify(db), false, 'UNIQUE variant rejected')
  mig.up(db)
  assert.equal(mig.verify(db), true)
  db.exec("DROP INDEX idx_oms_order_time; CREATE INDEX idx_oms_order_time ON oms_orders(order_time, status, platform_id, pay_amount) WHERE status <> 'x'")
  assert.equal(mig.verify(db), false, 'partial variant rejected')
  mig.up(db)
  assert.equal(mig.verify(db), true)
  // 表或列缺失时 up 跳过、verify 视为满足（与 059/065 同约定）
  const bare = new Database(':memory:'); t.after(() => bare.close())
  mig.up(bare)
  assert.equal(mig.verify(bare), true)
  bare.exec('CREATE TABLE oms_orders (id INTEGER PRIMARY KEY)')
  mig.up(bare)
  assert.equal(mig.verify(bare), true)
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id LIKE '070%'").get(), 'recorded by the runner')
})

test('AD3 sinceDate() equals SQLite date(now,localtime,-N day) for the same instant, incl. fractional / negative / non-finite / out-of-range windows', (t) => {
  const mem = new Database(':memory:'); t.after(() => mem.close())
  const instants = ['2026-10-24T00:00:00.000Z', '2026-10-24T12:00:00.000Z', '2026-10-24T15:59:59.000Z', '2026-10-24T16:00:00.000Z', '2026-03-01T23:30:00.000Z', '2026-12-31T23:59:59.000Z', '2024-02-29T12:00:00.000Z']
  const windows = [0, 1, 7, 30, 90, 365, 1.5, 0.25, 0.500000001, 0.4999999999, 1e-7, 1e6, 2e6, 3e6, -1, -30, -1e6, 1e21, 'abc', NaN, Infinity, -Infinity, '30', '', undefined]
  for (const iso of instants) {
    const now = new Date(iso)
    // SQLite 把无时区字符串当 UTC，再 'localtime' 转本地——与 'now','localtime' 对同一瞬间的处理相同
    const stamp = iso.replace('T', ' ').replace('Z', '')
    for (const w of windows) {
      const n = Number(w) // 路由先 Number() 再拼模板 '-${days} day'；负数拼成 '--N day'，SQLite 返回 NULL（旧行为：空结果）
      const want = mem.prepare(`SELECT date(?, 'localtime', '-${n} day') d`).get(stamp).d
      assert.equal(dsql.sinceDate(n, now), want, `${iso} -${n}d (TZ=${process.env.TZ ?? 'system'})`)
    }
  }
})

test('AD3 sinceDate() matches SQLite under several process time zones (child processes, incl. DST and half-hour offsets)', () => {
  const script = `
    import Database from 'better-sqlite3'
    import { sinceDate } from './server/lib/dashboard-sql.js'
    const db = new Database(':memory:'); const bad = []
    for (const iso of ['2026-10-24T12:00:00.000Z','2026-10-24T00:00:00.001Z','2026-03-08T06:59:59.000Z','2026-03-08T07:00:01.000Z','2026-11-01T05:59:59.000Z','2026-11-01T06:00:01.000Z','2026-10-24T18:29:59.000Z','2026-10-24T18:30:01.000Z','2026-01-01T00:00:00.000Z']) {
      for (const w of [0, 1, 30, 90, 1.5, 0.500000001, 0.4999999999, 0.5, 2.0000000004]) {
        const want = db.prepare("SELECT date(?, 'localtime', '-' || ? || ' day') d").get(iso.replace('T',' ').replace('Z',''), String(w)).d
        const got = sinceDate(w, new Date(iso))
        if (got !== want) bad.push([process.env.TZ, iso, w, got, want])
      }
    }
    console.log(JSON.stringify(bad))`
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { PATH: process.env.PATH, TZ: tz }, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out.trim()), [], `TZ=${tz}`)
  }
})

/** 带边界数据的 OMS 夹具：规范格式（空格 / T 分隔 / 仅日期）、窗口边界、未来日期、NULL、空串 */
function omsFixture(t, { migrated = true } = {}) {
  const { db } = fixture(t)
  if (!migrated) db.exec('DROP INDEX idx_oms_order_time')
  db.pragma('foreign_keys=OFF')
  db.prepare("INSERT INTO platforms (code, name) VALUES ('AD3-A', 'AD3甲'), ('AD3-B', 'AD3乙')").run()
  const [pa, pb] = db.prepare("SELECT id FROM platforms WHERE code LIKE 'AD3-%' ORDER BY code").all().map((x) => x.id)
  const ins = db.prepare('INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?,?,?,?,?)')
  let n = 0
  const add = (pf, time, status = 'completed', amt = 10.25) => ins.run(pf, `AD3-${++n}`, time, status, amt)
  for (const days of [0, 1, 5, 29, 30, 31, 89, 90, 91, 200, -3]) {
    const d = db.prepare(`SELECT date('now','localtime','${days < 0 ? '+' + -days : '-' + days} day') d`).get().d
    add(pa, `${d} 00:00:00`); add(pa, `${d} 23:59:59`, 'shipped', 3.5); add(pb, `${d}T12:30:00`, 'refunded', 99); add(pb, d, 'pending', 1.1)
    add(987654, `${d} 08:00:00`, 'completed', 7)
  }
  add(pa, null); add(pb, '', 'completed', 5)
  // 非规范存储值：时区后缀（date() 按 UTC 折算，文本顺序与折算后日期差一天）、脏文本（文本序高于任何日期但 date() 为 NULL）、儒略日数字串
  const edge = (days) => db.prepare(`SELECT date('now','localtime','-${days} day') d`).get().d
  for (const days of [0, 29, 30, 31, 89, 90, 91]) {
    const d = edge(days)
    add(pa, `${d}T01:00:00+08:00`, 'completed', 4.5); add(pb, `${d}T20:00:00-08:00`, 'shipped', 6.25); add(pa, `${d}T23:30:00Z`, 'completed', 8)
    add(pb, `${d} 12:00:00.123`, 'completed', 1.5)
  }
  add(pa, 'not-a-date', 'completed', 2); add(pb, 'null 00:00:00', 'completed', 3); add(pa, '2461000.5', 'completed', 4); add(pb, 'now', 'completed', 5)
  db.pragma('foreign_keys=ON')
  return { db, pa, pb }
}

test('AD3 trend / channel online: new range SQL returns exactly the rows of the old date(order_time) SQL, for varied windows and boundary data', (t) => {
  const { db } = omsFixture(t)
  for (const days of [0, 1, 7, 29, 30, 31, 90, 365, 1.5, -1, 1e9, 'abc', NaN]) {
    const old = OLD_ONLINE(days)
    assert.deepEqual(db.prepare(dsql.trendOnlineSql()).all(...dsql.onlineWindow(days)), db.prepare(old.trend).all(), `trend days=${days}`)
    assert.deepEqual(db.prepare(dsql.channelOnlineSql()).all(...dsql.onlineWindow(days)), db.prepare(old.channel).all(), `channel days=${days}`)
  }
  const sanity = db.prepare(dsql.trendOnlineSql()).all(...dsql.onlineWindow(30))
  assert.ok(sanity.length >= 5 && sanity.every((r) => r.date), 'fixture actually exercises the window')
  // 边界：窗口起点当天 00:00:00 计入，前一天 23:59:59 不计
  const from = dsql.sinceDate(30)
  const dates = db.prepare(dsql.trendOnlineSql()).all(...dsql.onlineWindow(30)).map((r) => r.date)
  assert.equal(dates[0], from)
})

test('AD3 onlineWindow(): [lo, since] with lo = since - 1 day; NULL/empty semantics preserved for invalid windows', () => {
  const now = new Date('2026-10-24T08:00:00.000Z')
  const [lo, since] = dsql.onlineWindow(30, now)
  assert.equal(since, dsql.sinceDate(30, now))
  assert.equal(lo, dsql.sinceDate(31, now))
  assert.ok(lo < since)
  assert.deepEqual(dsql.onlineWindow('abc', now), [null, null])
  assert.deepEqual(dsql.onlineWindow(-1, now), [null, null])
  assert.deepEqual(dsql.onlineWindow(NaN, now), [null, null])
})

test('AD3 sales / purchase trend SQL moved into dashboard-sql.js is textually the old SQL and returns the same rows', (t) => {
  const { db } = fixture(t)
  for (const days of [7, 30, 90]) {
    assert.equal(dsql.trendSalesSql(days), OLD_TREND(days).sales)
    assert.equal(dsql.trendPurchaseSql(days), OLD_TREND(days).purchase)
  }
})

/** 去掉 order_time 区间谓词的 trend 线上语句（只保留 date() 复核）：SQLite 会选覆盖索引全扫 */
const trendLike = () => 'SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders INDEXED BY idx_oms_order_time WHERE date(order_time) >= date(\'now\') GROUP BY date(order_time)'

test('AD3 explain-audit: trend + channel online use idx_oms_order_time (SEARCH, no SCAN); channel_online exemption is gone; dropping the index turns the guard red', async (t) => {
  const { db } = omsFixture(t)
  // STATEMENTS captures its representative windows at import time. Simulate a long suite
  // crossing local midnight; compare against that captured instant, not the later clock.
  const statementTime = new Date(2026, 9, 26, 23, 59, 59)
  t.mock.timers.enable({ apis: ['Date'], now: statementTime })
  const { STATEMENTS: midnightStatements } = await import('../../scripts/explain-audit.mjs?dashboard-perf-midnight')
  t.mock.timers.tick(2000)
  assert.notDeepEqual(dsql.onlineWindow(30), dsql.onlineWindow(30, statementTime), 'the test crosses local midnight')
  const ids = ['dash.trend_sales', 'dash.trend_purchase', 'dash.trend_online', 'dash.channel_online']
  const byId = new Map(midnightStatements.map((s) => [s.id, s]))
  for (const id of ids) assert.ok(byId.get(id), `${id} registered`)
  assert.equal(byId.get('dash.trend_sales').sql, dsql.trendSalesSql(30))
  assert.equal(byId.get('dash.trend_purchase').sql, dsql.trendPurchaseSql(30))
  assert.equal(byId.get('dash.trend_online').sql, dsql.trendOnlineSql())
  assert.deepEqual(byId.get('dash.trend_online').params, dsql.onlineWindow(30, statementTime))
  assert.equal(byId.get('dash.trend_online').expectIndex, 'idx_oms_order_time')
  for (const id of ids) assert.equal(byId.get(id).expectSearch, true, `${id}: must be a constrained SEARCH, not an index scan`)
  assert.equal(byId.get('dash.channel_online').sql, dsql.channelOnlineSql())
  assert.deepEqual(byId.get('dash.channel_online').params, dsql.onlineWindow(90, statementTime))
  assert.equal(byId.get('dash.channel_online').expectIndex, 'idx_oms_order_time')
  assert.ok(!ALLOW.some((a) => a.statement === 'dash.channel_online'), 'no exemption left for channel_online')
  const rep = auditStatements(db, ids.map((i) => byId.get(i)), { allow: ALLOW.filter((a) => ids.includes(a.statement)), threshold: 1 })
  assert.deepEqual(rep.violations, [])
  const planOf = (id) => rep.statements.find((s) => s.id === id).plan
  for (const id of ['dash.trend_online', 'dash.channel_online']) {
    assert.ok(planOf(id).some((d) => /SEARCH \w+ USING COVERING INDEX idx_oms_order_time \(order_time>\?\)/.test(d)), `${id}: covering range search on the new index: ${planOf(id).join(' | ')}`)
    assert.ok(!planOf(id).some((d) => /^SCAN (o|oms_orders)\b/.test(d)), `${id}: no table scan of oms_orders`)
  }
  // 变异：没有迁移 070 的库（threshold 压到 1 行，夹具表很小）→ 守卫红
  // Codex 审计：去掉区间谓词（计划退化成覆盖索引全扫）也必须红——expectSearch
  const noRange = trendLike()
  const scanOnly = auditStatements(db, [{ id: 'x.online_noop', mirrors: 't', expectIndex: 'idx_oms_order_time', expectSearch: true, sql: noRange, params: [] }], { allow: [], threshold: 1000000 })
  assert.equal(scanOnly.ok, false, JSON.stringify(scanOnly.statements[0].plan))
  assert.match(scanOnly.violations.at(-1).reason, /不是带约束的 SEARCH/)
  db.exec('DROP INDEX idx_oms_order_time')
  const bad = auditStatements(db, ids.map((i) => byId.get(i)), { allow: [], threshold: 1 })
  assert.equal(bad.ok, false)
  for (const id of ['dash.trend_online', 'dash.channel_online']) assert.ok(bad.violations.some((v) => v.statement === id && /idx_oms_order_time/.test(v.reason || '') || (v.statement === id && /SCAN/.test(v.detail))), `${id} flagged without the index`)
})

test('AD3 routes: /trend and /channel (HTTP) equal the old SQL on the seeded instance; trend body unchanged in shape', { timeout: SLOW_WAIT.serverCaseMs }, async (t) => {
  const f = await server(t, { GML_PROFILE: '1' })
  const db = f.db
  db.pragma('foreign_keys=OFF')
  const pf = Number(db.prepare("INSERT INTO platforms (code, name) VALUES ('AD3-R', 'AD3路由')").run().lastInsertRowid)
  const io = db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?,?,datetime('now','localtime',?),?,?)")
  io.run(pf, 'AD3-R1', '-1 day', 'pending', 100.5); io.run(pf, 'AD3-R2', '-29 day', 'shipped', 200); io.run(pf, 'AD3-R3', '-100 day', 'shipped', 999)
  io.run(pf, 'AD3-R4', '-2 day', 'refunded', 77); io.run(pf, 'AD3-R5', '-45 day', 'completed', 5)
  db.pragma('foreign_keys=ON')
  for (const days of [30, 90, 7]) {
    const tr = (await f.api(`/api/dashboard/trend?days=${days}`)).body.data
    const old = OLD_ONLINE(days).trend
    const expectOnline = Object.fromEntries(db.prepare(old).all().map((x) => [x.date, Number(x.amount.toFixed(2))]))
    for (const row of tr) assert.equal(row.online, expectOnline[row.date] ?? 0, `${days}d ${row.date}`)
    assert.deepEqual(Object.keys(expectOnline).filter((d) => !tr.some((r) => r.date === d)), [], 'every old online date is present')
    const ch = (await f.api(`/api/dashboard/channel?days=${days}`)).body.data
    assert.deepEqual(ch.online, db.prepare(OLD_ONLINE(days).channel).all(), `channel ${days}d`)
  }
  const tr30 = (await f.api('/api/dashboard/trend?days=30')).body.data
  assert.ok(tr30.some((r) => r.online > 0))
  assert.deepEqual(Object.keys(tr30[0]), ['date', 'offline', 'online', 'purchase', 'orders', 'total'])
  const route = readFileSync(new URL('../../server/routes/dashboard.js', import.meta.url), 'utf8')
  assert.ok(!/date\(o?\.?order_time\)\s*>=/.test(route), 'route inlines no oms date() predicate')
})
