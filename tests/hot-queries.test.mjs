/**
 * ============================================================================
 * 文件标识：tests/hot-queries.test.mjs ｜ 测试：大库热点查询改造（迁移 061、低库存预警改写、库存列表游标分页）（roadmap-v5 Z3）
 * ============================================================================
 * 【职责】守住 Z3 的四个决定：
 *   ① 迁移 061 只加非 UNIQUE 索引、可重复执行、记校验和；
 *   ② explain-audit 的三处规模下才暴露的全表扫描（dash.todo_counts 的 dealers、dash.below_safe_count、stock.below_safe）
 *      在没有 061 时报红、有 061 时为零违规（表灌到阈值以上才有意义，所以测试里批量补行）；
 *   ③ `countBelowSafe` / `listBelowSafe` 与改写前的 SQL 在同一份数据上返回相同的行（含无库存、多仓、非活动、安全库存为 0、并列缺口）；
 *   ④ `GET /api/inventory/stocks`：默认 50、上限 500、after_id 游标走完恰好覆盖全集且不重复，
 *      total/summary 只在首页，翻页中途并发插入不让已翻过的行重复或漏掉，非法 after_id 返回 400。
 * 【夹具口径】① ② ③ 用内存库；④ 用 test 运行时 + 全新临时数据目录 + 随机回环端口。期望值用测试自己的 SQL 直算。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { auditStatements, STATEMENTS, ALLOW } from '../scripts/explain-audit.mjs'
import * as m061 from '../server/db/migrations/061_hot_query_indexes.cjs'
import { countBelowSafe, listBelowSafe } from '../server/lib/stock.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')

function migrated(t, opts = {}) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {}, ...opts })
  return db
}

// 灌到行数阈值（200）以上：夹具库的 SKU / 经销商太少，不灌则 SCAN 落在 below_threshold，看不出差别
function pad(db, n = 400) {
  db.pragma('foreign_keys=OFF')
  db.transaction(() => {
    db.prepare(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?)
      INSERT INTO products (spu_code, name) SELECT 'PAD-P'||i, 'pad'||i FROM s`).run(n)
    db.prepare(`INSERT INTO product_skus (product_id, sku_code, name, safe_stock, status)
      SELECT id, 'PAD-K'||id, 'pad sku'||id, 10, 'active' FROM products WHERE spu_code LIKE 'PAD-P%'`).run()
    db.prepare(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?)
      INSERT INTO dealers (code, name, credit_limit, credit_used, status) SELECT 'PAD-D'||i, 'pad dealer'||i, 1000, (i%10)*100, 'active' FROM s`).run(n)
  })()
  db.pragma('foreign_keys=ON')
}

const TARGETS = ['dash.todo_counts', 'dash.below_safe_count', 'dash.stock_alerts', 'stock.below_safe']

test('migration 061 applies idempotently, verifies, adds only non-UNIQUE indexes and is checksummed', (t) => {
  const db = migrated(t)
  assert.equal(m061.verify(db), true)
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all()
  m061.up(db)
  m061.up(db)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all(), before)
  for (const name of m061.INDEXES.map((i) => i.name)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)
    assert.ok(row, name)
    assert.doesNotMatch(row.sql, /UNIQUE/i, name)
  }
  const rows = db.prepare("SELECT checksum FROM schema_migrations WHERE id LIKE '061_%'").all()
  assert.equal(rows.length, 1)
  assert.match(rows[0].checksum, /^[0-9a-f]{64}$/)
  assert.deepEqual(runMigrations(db, { mode: 'production', warn: () => {} }).applied, [])
})

test('the three scale-only scans are violations without migration 061 and clean with it', (t) => {
  const targets = STATEMENTS.filter((s) => TARGETS.includes(s.id))
  assert.equal(targets.length, TARGETS.length)

  const withIx = migrated(t)
  pad(withIx)
  const green = auditStatements(withIx, targets, { allow: ALLOW.filter((a) => TARGETS.includes(a.statement)) })
  assert.deepEqual(green.violations, [], JSON.stringify(green.violations))

  const dir = mkdtempSync(path.join(tmpdir(), 'os-z3-mig-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  rmSync(path.join(dir, '061_hot_query_indexes.cjs'))
  const old = migrated(t, { migrationsDir: dir })
  pad(old)
  const red = auditStatements(old, targets, { allow: [] })
  const hit = new Set(red.violations.map((v) => `${v.statement}:${v.table}`))
  assert.ok(hit.has('dash.todo_counts:dealers'), [...hit].join())
  assert.ok(hit.has('dash.below_safe_count:product_skus'), [...hit].join())
  assert.ok(hit.has('stock.below_safe:product_skus'), [...hit].join())
})

test('rewritten below-safe queries return the same rows as the original SQL', (t) => {
  const db = migrated(t)
  db.pragma('foreign_keys=OFF')
  const prod = db.prepare("INSERT INTO products (spu_code, name) VALUES (?, ?)")
  const sku = db.prepare('INSERT INTO product_skus (product_id, sku_code, name, safe_stock, status) VALUES (?,?,?,?,?)')
  const stock = db.prepare('INSERT INTO inventory_stocks (warehouse_id, sku_id, batch_no, qty_on_hand) VALUES (?,?,?,?)')
  const mk = (code, safe, status, lots) => {
    const p = Number(prod.run(`Z3-${code}`, `p-${code}`).lastInsertRowid)
    const id = Number(sku.run(p, `Z3-K-${code}`, `s-${code}`, safe, status).lastInsertRowid)
    lots.forEach(([wh, batch, q]) => stock.run(wh, id, batch, q))
    return id
  }
  mk('nostock', 20, 'active', [])                                     // 无库存行 → 合计 0，低于
  mk('multi-low', 100, 'active', [[1, 'a', 30], [2, 'b', 20]])        // 跨仓合计 50 < 100（逐仓比较会算错的场景）
  mk('multi-ok', 100, 'active', [[1, 'a', 60], [2, 'b', 60]])         // 120 ≥ 100
  mk('equal', 10, 'active', [[1, 'a', 10]])                            // 恰等于安全库存 → 不算低
  mk('zero-safe', 0, 'active', [])                                    // 安全库存 0 不参与
  mk('inactive', 50, 'disabled', [])                                  // 非 active 不参与
  mk('neg', 5, 'active', [[1, 'a', -3], [2, 'b', 2]])                  // 合计 -1，低于
  mk('tie-a', 40, 'active', [[1, 'a', 10]])                            // 与 tie-b 缺口相同（30）
  mk('tie-b', 40, 'active', [[1, 'a', 10]])
  db.pragma('foreign_keys=ON')

  const oldCount = () => db.prepare(`SELECT COUNT(*) c FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0
    AND COALESCE((SELECT SUM(qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=sk.id),0) < sk.safe_stock`).get().c
  const oldList = (limit) => db.prepare(`SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock,
      COALESCE(SUM(st.qty_on_hand),0) qty_on_hand, sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0) shortage
    FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN inventory_stocks st ON st.sku_id=sk.id
    WHERE sk.status='active' AND sk.safe_stock > 0 GROUP BY sk.id HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock
    ORDER BY shortage DESC, sk.id LIMIT ?`).all(limit)   // 原写法没有并列次序；这里补 sk.id 以便逐行比较

  assert.equal(countBelowSafe(db), oldCount())
  const expectCodes = ['Z3-K-nostock', 'Z3-K-multi-low', 'Z3-K-neg', 'Z3-K-tie-a', 'Z3-K-tie-b']
  const all = listBelowSafe(db, 100)
  for (const c of expectCodes) assert.ok(all.some((r) => r.sku_code === c), c)
  assert.ok(!all.some((r) => /multi-ok|equal|zero-safe|inactive/.test(r.sku_code)))
  assert.deepEqual(all, oldList(100))
  assert.deepEqual(listBelowSafe(db, 3), oldList(3))
  assert.deepEqual(all.map((r) => r.shortage), [...all.map((r) => r.shortage)].sort((a, b) => b - a))
})

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-z3-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
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
  const api = async (route, token) => {
    const res = await fetch(`${base}${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) })
    return { status: res.status, body: await res.json() }
  }
  const lr = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' })
  })
  const token = (await lr.json()).data.token
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { api: (r) => api(r, token), db }
}

test('GET /inventory/stocks: default 50, max 500, keyset cursor covers the set exactly once, total only on page one', { timeout: 300000 }, async (t) => {
  const { api, db } = await server(t)
  const ids = (list) => list.map((r) => r.id)
  // 补到 130 行有库存（>2 页的 50），再加 3 行零库存（应被过滤）
  const skus = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 10').all().map((r) => r.id)
  const whs = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 5').all().map((r) => r.id)
  const ins = db.prepare('INSERT INTO inventory_stocks (warehouse_id, sku_id, batch_no, qty_on_hand, cost_price) VALUES (?,?,?,?,2)')
  db.transaction(() => {
    for (let i = 0; i < 130; i++) ins.run(whs[i % whs.length], skus[i % skus.length], `Z3B${i}`, 1 + (i % 7))
    for (let i = 0; i < 3; i++) ins.run(whs[0], skus[0], `Z3ZERO${i}`, 0)
  })()
  const expected = db.prepare('SELECT id FROM inventory_stocks WHERE qty_on_hand <> 0 ORDER BY id').all().map((r) => r.id)
  assert.ok(expected.length > 130)

  const first = await api('/api/inventory/stocks')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const d = first.body.data
  assert.equal(d.pageSize, 50)
  assert.equal(d.list.length, 50)
  assert.equal(d.total, expected.length)
  assert.equal(d.has_more, true)
  assert.equal(d.next_after_id, d.list[49].id)
  const sum = db.prepare('SELECT SUM(qty_on_hand) q, SUM(qty_on_hand*cost_price) a FROM inventory_stocks WHERE qty_on_hand <> 0').get()
  assert.equal(d.summary.qty, sum.q)
  assert.equal(d.summary.amount, sum.a)

  // 走完所有页：覆盖全集、无重复、升序；后续页没有 total/summary
  const seen = [...ids(d.list)]
  let cursor = d.next_after_id
  let pages = 1
  while (cursor !== null) {
    const r = await api(`/api/inventory/stocks?after_id=${cursor}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.data.total, undefined)
    assert.equal(r.body.data.summary, undefined)
    seen.push(...ids(r.body.data.list))
    cursor = r.body.data.next_after_id
    pages++
  }
  assert.deepEqual(seen, expected)
  assert.equal(pages, Math.ceil(expected.length / 50))

  // pageSize 上限 500，下限 1；非数字回默认
  assert.equal((await api('/api/inventory/stocks?pageSize=100000')).body.data.pageSize, 500)
  assert.equal((await api('/api/inventory/stocks?pageSize=0')).body.data.pageSize, 50)
  assert.equal((await api('/api/inventory/stocks?pageSize=abc')).body.data.pageSize, 50)
  assert.equal((await api('/api/inventory/stocks?pageSize=500')).body.data.list.length, Math.min(500, expected.length))

  // 过滤条件与游标、total 同时成立
  const w = whs[1]
  const expW = db.prepare('SELECT id FROM inventory_stocks WHERE qty_on_hand <> 0 AND warehouse_id=? ORDER BY id').all(w).map((r) => r.id)
  const fw = await api(`/api/inventory/stocks?warehouse_id=${w}&pageSize=10`)
  assert.equal(fw.body.data.total, expW.length)
  assert.deepEqual(ids(fw.body.data.list), expW.slice(0, 10))
  const kw = await api('/api/inventory/stocks?keyword=Z3B1&pageSize=500')
  assert.equal(kw.body.data.total, db.prepare(`SELECT COUNT(*) c FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id
    WHERE st.qty_on_hand<>0 AND (sk.sku_code LIKE '%Z3B1%' OR sk.name LIKE '%Z3B1%' OR p.name LIKE '%Z3B1%' OR st.batch_no LIKE '%Z3B1%')`).get().c)

  // 非法游标
  for (const bad of ['-1', 'abc', '1.5', '1e999']) assert.equal((await api(`/api/inventory/stocks?after_id=${bad}`)).status, 400, bad)

  // 翻页中途并发插入：新行 id 更大，只出现在末尾；已翻过的页不重复、不丢
  const p1 = await api('/api/inventory/stocks?pageSize=40')
  db.transaction(() => { for (let i = 0; i < 5; i++) ins.run(whs[0], skus[1], `Z3NEW${i}`, 3) })()
  const rest = []
  let c2 = p1.body.data.next_after_id
  while (c2 !== null) {
    const r = await api(`/api/inventory/stocks?pageSize=40&after_id=${c2}`)
    rest.push(...ids(r.body.data.list))
    c2 = r.body.data.next_after_id
  }
  const walked = [...ids(p1.body.data.list), ...rest]
  assert.equal(new Set(walked).size, walked.length, 'no duplicates')
  assert.deepEqual(walked.slice(0, expected.length), expected, 'rows already paged over are unchanged and complete')
  assert.equal(walked.length, expected.length + 5)

  // 预警接口：与测试自己的 SQL 同集合
  const alerts = await api('/api/inventory/alerts')
  assert.equal(alerts.status, 200)
  const want = db.prepare(`SELECT sk.id FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0
    AND COALESCE((SELECT SUM(qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=sk.id),0) < sk.safe_stock`).all().map((r) => r.id)
  const got = alerts.body.data.belowSafe?.map((r) => r.sku_id) ?? alerts.body.data.below_safe?.map((r) => r.sku_id)
  assert.ok(got, JSON.stringify(Object.keys(alerts.body.data)))
  assert.ok(want.length <= 50, 'demo fixture has fewer than 50 low-stock SKUs')
  assert.deepEqual([...got].sort((a, b) => a - b), [...want].sort((a, b) => a - b))
  const dash = await api('/api/dashboard/summary')
  assert.equal(dash.body.data.alerts.below_safe, want.length)
  assert.deepEqual(Object.keys(dash.body.data.alerts), ['pending_delivery', 'pending_receipt', 'oms_pending', 'below_safe', 'expiring', 'credit_alert'])
})
