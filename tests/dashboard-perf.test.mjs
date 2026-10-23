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
import { runMigrations } from '../server/db/migrations/runner.js'
import { listBelowSafe, countBelowSafe } from '../server/lib/stock.js'
import { METRIC_BY_KEY } from '../server/lib/metrics.js'
import { TOOL_MAP } from '../server/mcp/tools.js'
import { createProfiler, profilingEnabled } from '../server/lib/profile.js'
import { cachedForDb, invalidateForDb, cacheTtlMs } from '../server/lib/db-ttl-cache.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')

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
  // 受限范围：只累计范围内仓库的库存。夹具里货主组织 = 仓库组织，所以与旧的"按货主过滤的库存行"逐行相同（有库存行、active 的 SKU）
  const only101 = call({ scope: 'org', orgIds: [101] })
  const old101 = db.prepare(OLD_MCP(' AND s.owner_org_id IN (101)')).all().filter((r) => r.sku_id !== ids.inactive)
  // 新口径还会列出"范围内没有任何库存行"的缺货 SKU（nostock、onlyW2 在 101 范围内为 0），旧查询看不到它们——文档化的差异
  const new101 = only101.filter((r) => r.sku_id !== ids.nostock && r.sku_id !== ids.onlyW2)
  const rowKey = (r) => `${r.sku_id}|${r.sku_code}|${r.sku_name}|${r.safe_stock}|${r.qty_on_hand}`
  assert.deepEqual(new Set(new101.map(rowKey)), new Set(old101.map(rowKey)), 'complete rows equal the original owner-filtered query')
  assert.equal(only101.find((r) => r.sku_id === ids.multiLow).qty_on_hand, 30, 'only the org 101 warehouse is counted')
  assert.equal(only101.find((r) => r.sku_id === ids.onlyW2).qty_on_hand, 0, 'org 202 stock is invisible to org 101 (shown as 0, not leaked)')
  // 货主与仓库组织不一致时（文档化的差异）：新口径以仓库所属组织为准，旧口径以 owner_org_id 为准
  db.pragma('foreign_keys=OFF')
  db.prepare('UPDATE inventory_stocks SET owner_org_id = 202 WHERE sku_id = ? AND warehouse_id = ?').run(ids.tieA, w1)
  db.pragma('foreign_keys=ON')
  const tieA = (rows) => rows.find((r) => r.sku_id === ids.tieA)
  assert.equal(tieA(call({ scope: 'org', orgIds: [101] })).qty_on_hand, 10, 'warehouse org 101 sees the stock regardless of owner_org_id')
  assert.equal(tieA(call({ scope: 'org', orgIds: [202] })).qty_on_hand, 0, 'org 202 owns the lot but does not hold the warehouse')
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

async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-aa5-'))
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
  const lr = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' })
  })
  const token = (await lr.json()).data.token
  const call = async (route, init = {}) => {
    const res = await fetch(`${base}${route}`, {
      ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { api: (r) => call(r), post: (r, b) => call(r, { method: 'POST', body: JSON.stringify(b) }), db, output: () => output }
}

test('GET /dashboard/summary: profile log only with GML_PROFILE=1, never in the body; AI stock_alert matches the original SQL', { timeout: 300000 }, async (t) => {
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

  assert.deepEqual(cachedForDb(a, compute(a), opts), { value: 1, hit: false })
  assert.deepEqual(cachedForDb(a, compute(a), opts), { value: 1, hit: true })
  assert.equal(calls, 1)
  // 另一个连接的缓存互不串（同表名、不同库）
  b.prepare('UPDATE t SET v=50').run()
  assert.deepEqual(cachedForDb(b, compute(b), opts), { value: 50, hit: false })
  assert.deepEqual(cachedForDb(a, compute(a), opts), { value: 1, hit: true })
  // 本连接写入 → 立即失效
  a.prepare('INSERT INTO t VALUES (2)').run()
  assert.deepEqual(cachedForDb(a, compute(a), opts), { value: 3, hit: false })
  assert.equal(cachedForDb(a, compute(a), opts).hit, true)
  // 其它连接（等价于其它进程）提交 → 立即失效
  other.prepare('INSERT INTO t VALUES (4)').run()
  assert.deepEqual(cachedForDb(a, compute(a), opts), { value: 7, hit: false })
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

test('dashboard summary is never stale: reflects writes made through another connection immediately, and repeated reads are cache hits', { timeout: 300000 }, async (t) => {
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
