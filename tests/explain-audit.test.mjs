import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { auditStatements, STATEMENTS, ALLOW } from '../scripts/explain-audit.mjs'
import * as m059 from '../server/db/migrations/059_indexes.cjs'

const SCHEMA = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')

function migrated(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  return db
}

test('guard goes red on an injected un-indexed query over a large table', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE big_t (id INTEGER PRIMARY KEY, ref TEXT, note TEXT)')
  const ins = db.prepare('INSERT INTO big_t (ref, note) VALUES (?, ?)')
  db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(`r${i}`, 'x') })()
  const bad = [{ id: 'inject', mirrors: 'test', sql: 'SELECT * FROM big_t WHERE ref = ?', params: ['r7'] }]
  const red = auditStatements(db, bad, { threshold: 200, allow: [] })
  assert.equal(red.ok, false)
  assert.equal(red.violations.length, 1)
  assert.equal(red.violations[0].table, 'big_t')
  // Add the index: the same statement turns green.
  db.exec('CREATE INDEX idx_big_ref ON big_t(ref)')
  const green = auditStatements(db, bad, { threshold: 200, allow: [] })
  assert.equal(green.ok, true)
})

test('a SCAN on a table below the row threshold is not a violation', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE small_t (id INTEGER PRIMARY KEY, ref TEXT)')
  db.exec("INSERT INTO small_t (ref) VALUES ('a'),('b')")
  const r = auditStatements(db, [{ id: 's', mirrors: 'test', sql: 'SELECT * FROM small_t WHERE ref = ?', params: ['a'] }], { threshold: 200, allow: [] })
  assert.equal(r.ok, true)
  assert.equal(r.statements[0].scans[0].status, 'below_threshold')
})

test('an allowlist entry needs a reason and only excuses its own statement and table', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE big_t (id INTEGER PRIMARY KEY, ref TEXT)')
  const ins = db.prepare('INSERT INTO big_t (ref) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 300; i++) ins.run(`r${i}`) })()
  const stmts = [{ id: 'a', mirrors: 't', sql: 'SELECT * FROM big_t WHERE ref = ?', params: ['x'] }, { id: 'b', mirrors: 't', sql: 'SELECT * FROM big_t WHERE ref = ?', params: ['y'] }]
  const r = auditStatements(db, stmts, { threshold: 200, allow: [{ statement: 'a', table: 'big_t', reason: 'test' }] })
  assert.deepEqual(r.violations.map(v => v.statement), ['b'])
  assert.throws(() => auditStatements(db, stmts, { threshold: 200, allow: [{ statement: 'a', table: 'big_t' }] }), /reason/)
  assert.throws(() => auditStatements(db, stmts, { threshold: 200, allow: [{ statement: 'zzz', table: 'big_t', reason: 'stale' }] }), /未知语句/)
})

test('every declared statement prepares against the current schema and names the lib function it mirrors', (t) => {
  const db = migrated(t)
  const ids = new Set()
  for (const s of STATEMENTS) {
    assert.ok(s.id && !ids.has(s.id), `duplicate or missing id ${s.id}`)
    ids.add(s.id)
    assert.ok(s.mirrors && /\.js|route|bench/i.test(s.mirrors), `${s.id} must cite what it mirrors`)
    assert.doesNotThrow(() => db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...(s.params || [])), s.id)
  }
  for (const a of ALLOW) assert.ok(a.reason && a.reason.length > 10, `allow ${a.statement}/${a.table} needs a reason`)
})

test('migration 059 applies idempotently, verifies, and adds only non-UNIQUE indexes', (t) => {
  const db = migrated(t)
  assert.equal(m059.verify(db), true)
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all()
  m059.up(db)
  m059.up(db)
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all()
  assert.deepEqual(after, before)
  assert.equal(m059.verify(db), true)
  // 059 only adds plain (non UNIQUE) indexes: semantics of existing data are unchanged.
  for (const name of m059.INDEXES.map(i => i.name)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)
    assert.ok(row, name)
    assert.doesNotMatch(row.sql, /UNIQUE/i, name)
  }
})

test('migration 059 is recorded with a checksum and a re-run of the runner changes nothing', (t) => {
  const db = migrated(t)
  const rows = db.prepare("SELECT id, checksum FROM schema_migrations WHERE id LIKE '059_%'").all()
  assert.equal(rows.length, 1)
  assert.match(rows[0].checksum, /^[0-9a-f]{64}$/)
  const res = runMigrations(db, { mode: 'production', warn: () => {} })
  assert.deepEqual(res.applied, [])
  assert.deepEqual(res.mismatched, [])
})

test('the declared statements are clean on the fully migrated schema, and the same guard is red without migration 059', (t) => {
  const withIx = migrated(t)
  const green = auditStatements(withIx, STATEMENTS)
  assert.deepEqual(green.violations, [])
  assert.deepEqual(green.unusedAllow, [])

  // Same schema, migrations 001..057 only: the guard must find what 059 fixes.
  const dir = mkdtempSync(path.join(tmpdir(), 'os-x10-mig-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  rmSync(path.join(dir, '059_indexes.cjs'))
  const old = new Database(':memory:')
  t.after(() => old.close())
  old.pragma('foreign_keys=ON')
  old.exec(SCHEMA)
  runMigrations(old, { mode: 'test', warn: () => {}, migrationsDir: dir })
  const red = auditStatements(old, STATEMENTS)
  assert.equal(red.ok, false)
  const hit = new Set(red.violations.map(v => v.statement))
  for (const id of ['sales.items', 'po.detail_items', 'stock.txn_by_doc', 'dash.sales_month']) assert.ok(hit.has(id), `${id} should be flagged without 059`)
})

test('SQLite automatic indexes count as violations, and a stale allowlist entry fails the audit', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE a_t (id INTEGER PRIMARY KEY); CREATE TABLE b_t (id INTEGER PRIMARY KEY, a_id INTEGER)')
  const ins = db.prepare('INSERT INTO b_t (a_id) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 300; i++) ins.run(i % 7) })()
  db.exec('INSERT INTO a_t (id) VALUES (1),(2),(3)')
  const stmt = { id: 'auto', mirrors: 'test', sql: 'SELECT a.id FROM a_t a LEFT JOIN b_t b ON b.a_id = a.id' }
  const r = auditStatements(db, [stmt], { threshold: 200, allow: [] })
  assert.ok(r.violations.some(v => /AUTOMATIC/.test(v.detail)), JSON.stringify(r.statements[0].plan))
  db.exec('CREATE INDEX idx_b_a ON b_t(a_id)')
  const stale = auditStatements(db, [stmt], { threshold: 200, allow: [{ statement: 'auto', table: 'b_t', reason: 'was needed before the index' }] })
  assert.equal(stale.ok, false)
  assert.equal(stale.unusedAllow.length, 1)
})

test('growth tables are flagged even when the fixture has fewer rows than the threshold', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE sales_order_items (id INTEGER PRIMARY KEY, order_id INTEGER); INSERT INTO sales_order_items (order_id) VALUES (1)')
  const r = auditStatements(db, [{ id: 'g', mirrors: 'test', sql: 'SELECT * FROM sales_order_items WHERE order_id = ?', params: [1] }], { threshold: 200, allow: [] })
  assert.equal(r.ok, false)
})

test('automatic PARTIAL indexes are caught as well', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER, flag INTEGER); INSERT INTO a VALUES (1),(2),(3)')
  const ins = db.prepare('INSERT INTO b (a_id, flag) VALUES (?, ?)')
  db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(i % 7, i % 2) })()
  const r = auditStatements(db, [{ id: 'p', mirrors: 'test', sql: 'SELECT a.id FROM a LEFT JOIN b ON b.a_id = a.id AND b.flag = 1' }], { threshold: 200, allow: [] })
  assert.ok(r.violations.some(v => /AUTOMATIC/.test(v.detail)), JSON.stringify(r.statements[0].plan))
})

test('AF3 an automatic index on a MATERIALIZEd derived table is not a missing real index, while the base-table scan feeding it is still judged', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec("CREATE TABLE dim_t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO dim_t (id, name) VALUES (1,'a'),(2,'b'),(3,'c')")
  db.exec('CREATE TABLE fact_t (id INTEGER PRIMARY KEY, dim_id INTEGER, ts TEXT, amt REAL)')
  const ins = db.prepare('INSERT INTO fact_t (dim_id, ts, amt) VALUES (?,?,?)')
  db.transaction(() => { for (let i = 0; i < 400; i++) ins.run(1 + (i % 3), `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, i) })()
  const sql = 'SELECT d.name, COALESCE(w.s,0) s FROM dim_t d LEFT JOIN (SELECT dim_id, SUM(amt) s FROM fact_t WHERE ts >= ? GROUP BY +dim_id) w ON w.dim_id = d.id ORDER BY d.id'
  const stmt = { id: 'derived', mirrors: 'test', sql, params: ['2026-01-10'] }
  // 没有 ts 索引：派生表内部对 fact_t 的整表 SCAN 照样违规（派生表豁免只针对"在派生表结果上自建的自动索引"）
  const red = auditStatements(db, [stmt], { threshold: 200, allow: [] })
  assert.ok(red.violations.some((v) => v.table === 'fact_t'), JSON.stringify(red.violations))
  assert.ok(!red.violations.some((v) => /AUTOMATIC/.test(v.detail)), 'derived-table automatic index is not reported')
  db.exec('CREATE INDEX idx_fact_ts ON fact_t(ts, dim_id, amt)')
  const green = auditStatements(db, [{ ...stmt, expectIndex: 'idx_fact_ts', expectSearch: true }], { threshold: 200, allow: [] })
  assert.deepEqual(green.violations, [], JSON.stringify(green.statements[0].plan))
  // 变异：同样的自动索引出现在真实表上仍然违规（上面既有用例）；这里确认派生表名不会误吞真实表名
  const real = auditStatements(db, [{ id: 'real', mirrors: 'test', sql: 'SELECT d.id FROM dim_t d LEFT JOIN fact_t f ON f.amt = d.id' }], { threshold: 200, allow: [] })
  assert.ok(real.violations.some((v) => /AUTOMATIC/.test(v.detail) && v.table === 'fact_t'), JSON.stringify(real.statements[0].plan))
})

test('AF3 (Codex) derived-table exemption is per alias: a same-named real-table alias in another UNION branch is still flagged', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE dim (id INTEGER PRIMARY KEY); CREATE TABLE source (id INTEGER PRIMARY KEY); CREATE TABLE fact (id INTEGER PRIMARY KEY, dim_id INTEGER)')
  db.exec('INSERT INTO dim (id) VALUES (1),(2),(3)')
  const ins = db.prepare('INSERT INTO fact (dim_id) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 400; i++) ins.run(i % 3) })()
  const sql = 'SELECT d.id FROM dim d LEFT JOIN (SELECT id FROM source GROUP BY id) w ON w.id = d.id UNION ALL SELECT d.id FROM dim d LEFT JOIN fact w ON w.dim_id = d.id'
  const r = auditStatements(db, [{ id: 'collide', mirrors: 'test', sql }], { threshold: 200, allow: [] })
  assert.ok(r.violations.some((v) => /AUTOMATIC/.test(v.detail) && v.table === 'fact'), JSON.stringify(r.statements[0].plan))
})

test('AF3 (Codex) expectSearch: an unrelated constrained SEARCH of the same index does not excuse a full scan of that index elsewhere in the statement', (t) => {
  const db = migrated(t)
  const sql = "SELECT SUM(main.pay_amount), (SELECT COUNT(*) FROM oms_orders probe WHERE probe.order_time >= ?) FROM oms_orders main WHERE date(main.order_time) >= ?"
  const r = auditStatements(db, [{ id: 'probe', mirrors: 'test', sql, params: ['2026-01-01', '2026-01-01'], expectIndex: 'idx_oms_order_time', expectSearch: true }], { threshold: 1, allow: [] })
  assert.equal(r.ok, false, JSON.stringify(r.statements[0].plan))
  assert.ok(r.violations.some((v) => /整条索引扫描|索引全扫|不是带约束/.test(v.reason || '')), JSON.stringify(r.violations))
})
