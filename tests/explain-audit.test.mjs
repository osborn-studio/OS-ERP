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
