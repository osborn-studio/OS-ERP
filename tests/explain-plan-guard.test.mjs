/**
 * ============================================================================
 * 文件标识：tests/explain-plan-guard.test.mjs ｜ 查询计划指纹快照 / 漂移守卫 / ANALYZE 源码扫描的测试（roadmap-v12 AG3，ADR-0044 补充 6）
 * ============================================================================
 * 覆盖：指纹归一化的确定性（去字面量、去编号、保留层级）、快照形状、漂移检测（删索引 → 红）、白名单（必须绑定被接受的新指纹 + 理由，
 * 过期 / 错绑 / 无理由均不放行）、sqlite_stat1 存在时拒绝比较、已提交快照与当前代码一致、ANALYZE / PRAGMA optimize 源码扫描
 * （注释不算、字符串与 pragma() 调用算、白名单必须写理由且不得过期）、真实仓库当前干净、CLI 端到端（--snapshot / --compare 退出码）。
 * 临时目录 / 内存库，不碰 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { auditStatements, STATEMENTS } from '../scripts/explain-audit.mjs'
import { normalisePlanDetail, fingerprintsFromAudit, buildSnapshot, compareSnapshot, SNAPSHOT_VERSION } from '../scripts/lib/explain-plan-guard.mjs'
import { scanSource, scanTree, ANALYZE_ALLOW } from '../scripts/lib/analyze-scan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const tmp = (t, p = 'os-ag3-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }

function migrated(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  return db
}
const stmts = [
  { id: 'q.by_ref', mirrors: 'test', sql: 'SELECT * FROM big_t WHERE ref = ?', params: ['r7'] },
  { id: 'q.by_note', mirrors: 'test', sql: "SELECT * FROM big_t WHERE note = 'x' AND ref IN (SELECT ref FROM big_t WHERE id > 5)", params: [] }
]
function tinyDb(t, { index = true } = {}) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE big_t (id INTEGER PRIMARY KEY, ref TEXT, note TEXT)')
  if (index) db.exec('CREATE INDEX idx_big_ref ON big_t(ref)')
  return db
}
const take = (db, list = stmts) => fingerprintsFromAudit(auditStatements(db, list, { threshold: 1000000, allow: [] }).statements)
const snapOf = (db, extra = {}) => buildSnapshot({ fingerprints: take(db), latestMigration: 'm1', sqliteVersion: '3.0.0', generator: 'g', ...extra })
const cur = (db, extra = {}) => ({ fingerprints: take(db), latestMigration: 'm1', sqliteVersion: '3.0.0', hasStat1: false, ...extra })

test('normalisation strips literals, parameter markers and numeric ids but keeps tables, indexes and structure', () => {
  assert.equal(normalisePlanDetail("SEARCH t USING INDEX idx_a (a=? AND b>?)"), 'SEARCH t USING INDEX idx_a (a=? AND b>?)')
  assert.equal(normalisePlanDetail("SEARCH t USING INDEX idx_a (a='foo bar')"), 'SEARCH t USING INDEX idx_a (a=?)')
  assert.equal(normalisePlanDetail('SEARCH t USING INDEX idx_a (a=?12 AND b=:name AND c=@x)'), 'SEARCH t USING INDEX idx_a (a=? AND b=? AND c=?)')
  assert.equal(normalisePlanDetail('SCAN t   USING  INDEX idx_a '), 'SCAN t USING INDEX idx_a')
  // numbered sub-plans differ across SQLite versions; names containing digits must survive
  assert.equal(normalisePlanDetail('CORRELATED SCALAR SUBQUERY 7'), 'CORRELATED SCALAR SUBQUERY #')
  assert.equal(normalisePlanDetail('MATERIALIZE 3'), 'MATERIALIZE #')
  assert.equal(normalisePlanDetail('SEARCH t2 USING INDEX idx_t2_v3 (a=42)'), 'SEARCH t2 USING INDEX idx_t2_v3 (a=?)')
  // virtual-table strategy numbers are part of the plan (FTS ascending vs descending), not noise
  assert.notEqual(normalisePlanDetail('SCAN ft VIRTUAL TABLE INDEX 64:M1'), normalisePlanDetail('SCAN ft VIRTUAL TABLE INDEX 192:M1'))
})

test('fingerprints are deterministic, keep nesting depth, and ignore bound parameter values', (t) => {
  const db = tinyDb(t)
  const a = take(db)
  const b = take(db)
  assert.deepEqual(a, b)
  const other = take(db, [{ ...stmts[0], params: ['zzz'] }, stmts[1]])
  assert.deepEqual(other['q.by_ref'], a['q.by_ref'])
  assert.match(a['q.by_ref'].hash, /^[0-9a-f]{16}$/)
  assert.ok(a['q.by_note'].lines.some(l => l.startsWith('  ')), 'sub-plan rows keep their indentation')
  // same plan on a populated table: no statistics, so the heuristic plan (and fingerprint) is unchanged
  const ins = db.prepare('INSERT INTO big_t (ref, note) VALUES (?, ?)')
  db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(`r${i}`, 'x') })()
  assert.deepEqual(take(db), a)
})

test('snapshot shape: version, migration, sqlite version, generator, per-statement fingerprint and an empty whitelist', (t) => {
  const s = snapOf(tinyDb(t))
  assert.equal(s.snapshot_version, SNAPSHOT_VERSION)
  assert.equal(s.latest_migration, 'm1')
  assert.equal(s.sqlite_version, '3.0.0')
  assert.equal(s.generator, 'g')
  assert.deepEqual(Object.keys(s.statements).sort(), ['q.by_note', 'q.by_ref'])
  assert.ok(Array.isArray(s.statements['q.by_ref'].plan) && s.statements['q.by_ref'].hash)
  assert.deepEqual(s.whitelist, [])
})

test('compare is green on identical plans and red when an index is dropped', (t) => {
  const withIx = tinyDb(t)
  const snap = snapOf(withIx)
  assert.equal(compareSnapshot(snap, cur(withIx)).ok, true)
  const noIx = tinyDb(t, { index: false })
  const r = compareSnapshot(snap, cur(noIx))
  assert.equal(r.ok, false)
  assert.deepEqual(r.drifts.map(d => d.statement).sort(), ['q.by_note', 'q.by_ref'])
  const d = r.drifts.find(x => x.statement === 'q.by_ref')
  assert.equal(d.kind, 'changed')
  assert.equal(d.whitelisted, false)
  assert.ok(d.before.some(l => l.includes('idx_big_ref')) && d.after.every(l => !l.includes('idx_big_ref')))
})

test('added and removed statements are drift too', (t) => {
  const db = tinyDb(t)
  const snap = snapOf(db)
  const fewer = { 'q.by_ref': take(db)['q.by_ref'] }
  const removed = compareSnapshot(snap, { ...cur(db), fingerprints: fewer })
  assert.deepEqual(removed.drifts.map(d => [d.statement, d.kind]), [['q.by_note', 'removed']])
  const more = { ...take(db), 'q.new': take(db)['q.by_ref'] }
  const added = compareSnapshot(snap, { ...cur(db), fingerprints: more })
  assert.deepEqual(added.drifts.map(d => [d.statement, d.kind]), [['q.new', 'added']])
})

test('a whitelist entry excuses exactly the drift it names (hash-bound, with a reason), nothing else', (t) => {
  const withIx = tinyDb(t)
  const noIx = tinyDb(t, { index: false })
  const newHash = take(noIx)['q.by_ref'].hash
  const reason = 'accepted: index replaced by covering index in follow-up migration'
  const snap = snapOf(withIx)
  snap.whitelist = [{ statement: 'q.by_ref', accepted_hash: newHash, reason }]
  const r = compareSnapshot(snap, cur(noIx))
  assert.equal(r.drifts.find(d => d.statement === 'q.by_ref').whitelisted, true)
  assert.equal(r.ok, false, 'q.by_note still drifted and is not whitelisted')
  snap.whitelist.push({ statement: 'q.by_note', accepted_hash: take(noIx)['q.by_note'].hash, reason })
  assert.equal(compareSnapshot(snap, cur(noIx)).ok, true)
  // a LATER, different plan for the same statement is not excused by the old entry
  const third = tinyDb(t, { index: false }); third.exec('CREATE INDEX idx_big_note ON big_t(note)')
  const later = compareSnapshot(snap, cur(third))
  assert.equal(later.ok, false)
  assert.ok(later.drifts.some(d => d.statement === 'q.by_ref' && !d.whitelisted) || later.drifts.some(d => d.statement === 'q.by_note' && !d.whitelisted))
})

test('invalid, unknown and stale whitelist entries fail instead of silently passing', (t) => {
  const db = tinyDb(t)
  const mk = (w) => { const s = snapOf(db); s.whitelist = [w]; return s }
  const h = take(db)['q.by_ref'].hash
  assert.throws(() => compareSnapshot(mk({ statement: 'q.by_ref', accepted_hash: h }), cur(db)), /reason/)
  assert.throws(() => compareSnapshot(mk({ statement: 'q.by_ref', accepted_hash: h, reason: 'too short' }), cur(db)), /reason/)
  assert.throws(() => compareSnapshot(mk({ statement: 'q.by_ref', accepted_hash: 'nothex', reason: 'long enough reason text here' }), cur(db)), /accepted_hash/)
  assert.throws(() => compareSnapshot(mk({ statement: 'nope', accepted_hash: h, reason: 'long enough reason text here' }), cur(db)), /unknown|未知/)
  assert.throws(() => { const s = snapOf(db); s.whitelist = [{ statement: 'q.by_ref', accepted_hash: h, reason: 'long enough reason text here' }, { statement: 'q.by_ref', accepted_hash: 'ffffffffffffffff', reason: 'long enough reason text here' }]; compareSnapshot(s, cur(db)) }, /重复|duplicate/)
  // statement did not drift -> the entry is stale and the run is red
  const stale = compareSnapshot(mk({ statement: 'q.by_ref', accepted_hash: h, reason: 'long enough reason text here' }), cur(db))
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.staleWhitelist.map(w => w.statement), ['q.by_ref'])
})

test('a database with sqlite_stat1 (ANALYZE has run) is refused rather than compared', (t) => {
  const db = tinyDb(t)
  const snap = snapOf(db)
  assert.throws(() => compareSnapshot(snap, cur(db, { hasStat1: true })), /sqlite_stat1/)
})

test('a different SQLite version or migration is reported as a note, not a failure by itself', (t) => {
  const db = tinyDb(t)
  const r = compareSnapshot(snapOf(db), cur(db, { latestMigration: 'm2', sqliteVersion: '3.9.9' }))
  assert.equal(r.ok, true)
  assert.ok(r.notes.some(n => /migration/i.test(n)) && r.notes.some(n => /sqlite/i.test(n)))
})

test('the committed docs/implementation/explain-plans.json matches the current statements on a freshly migrated database', (t) => {
  const file = path.join(ROOT, 'docs/implementation/explain-plans.json')
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  const db = migrated(t)
  const result = auditStatements(db, STATEMENTS)
  const latest = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get().id
  const r = compareSnapshot(snap, { fingerprints: fingerprintsFromAudit(result.statements), latestMigration: latest, sqliteVersion: db.prepare('select sqlite_version() v').get().v, hasStat1: false })
  assert.deepEqual(r.drifts.filter(d => !d.whitelisted).map(d => d.statement), [])
  assert.equal(r.ok, true)
  assert.match(snap.generator, /synth-data/)
  assert.equal(snap.latest_migration, latest)
})

// ---- ANALYZE / PRAGMA optimize source scan ----

test('scan flags ANALYZE and PRAGMA optimize in string and template literals and pragma() calls', () => {
  const hits = (src, file = 'server/x.js') => scanSource(src, file).map(h => h.rule)
  assert.deepEqual(hits("db.exec('ANALYZE')"), ['stats'])
  assert.deepEqual(hits('db.exec(`analyze sqlite_master`)'), ['stats'])
  assert.deepEqual(hits("db.exec('PRAGMA optimize')"), ['pragma-optimize'])
  assert.deepEqual(hits("db.exec(\"pragma   optimize=0x10002\")"), ['pragma-optimize'])
  assert.deepEqual(hits("db.pragma('optimize')"), ['pragma-optimize'])
  assert.deepEqual(hits("db.pragma( `optimize` )"), ['pragma-optimize'])
  assert.deepEqual(hits('const q = `x ${a} ANALYZE ${b}`'), ['stats'])
  assert.deepEqual(hits('const q = `x ${ db.exec("ANALYZE") }`'), ['stats'])
})

test('scan ignores comments, identifiers and unrelated strings, and survives quotes inside comments and regex literals', () => {
  const hits = (src) => scanSource(src, 'server/x.js').map(h => h.rule)
  assert.deepEqual(hits('// never run ANALYZE here\nconst a = 1'), [])
  assert.deepEqual(hits("/* PRAGMA optimize\n ANALYZE */ const a = 1"), [])
  assert.deepEqual(hits('function analyze(x) { return analyzeOrders(x) }'), [])
  assert.deepEqual(hits("const mode = 'optimize'"), [])
  assert.deepEqual(hits("import { scan } from './lib/analyze-scan.mjs'"), [])
  assert.deepEqual(hits("const u = 'http://x.test/a' // ANALYZE?\nconst b = 2"), [])
  assert.deepEqual(hits("const re = /it's/; const s = 1 // ANALYZE"), [])
  // SQL comments and schema qualifiers inside the string do not hide the statement (Codex AG3)
  assert.deepEqual(hits("db.exec('ANALYZE/* maintenance */')"), ['stats'])
  assert.deepEqual(hits("db.exec('PRAGMA main.optimize')"), ['pragma-optimize'])
  assert.deepEqual(hits("db.exec('PRAGMA/* m */optimize')"), ['pragma-optimize'])
  assert.deepEqual(hits("db.pragma('main.optimize')"), ['pragma-optimize'])
  assert.deepEqual(hits("db.exec('ANALYZE -- later')"), ['stats'])
  // a regex literal right after a control-flow condition is not a division
  assert.deepEqual(hits("if (ok) /it's/.test(s); db.exec('ANALYZE');"), ['stats'])
  assert.deepEqual(hits("while (x) /it's/.test(s); db.exec('PRAGMA optimize');"), ['pragma-optimize'])
  assert.deepEqual(hits("const d = (a + b) / 2; db.exec('ANALYZE')"), ['stats'])
  // a real one after an apostrophe in a comment is still found
  assert.deepEqual(hits("// don't\ndb.exec('ANALYZE')"), ['stats'])
  assert.deepEqual(hits("const re = /it's/\ndb.exec('ANALYZE')"), ['stats'])
})

test('scan reports file and line, and handles .sql files (-- and /* */ comments)', () => {
  const h = scanSource("const a = 1\n\ndb.exec('ANALYZE')", 'server/db/x.js')
  assert.deepEqual(h.map(x => [x.file, x.line, x.rule]), [['server/db/x.js', 3, 'stats']])
  assert.deepEqual(scanSource('-- ANALYZE later\nSELECT 1; /* PRAGMA optimize */', 'server/db/a.sql'), [])
  assert.deepEqual(scanSource('SELECT 1;\nANALYZE;\n', 'server/db/a.sql').map(x => [x.line, x.rule]), [[2, 'stats']])
  assert.deepEqual(scanSource('PRAGMA optimize;', 'server/db/a.sql').map(x => x.rule), ['pragma-optimize'])
})

test('scanTree skips tests, node_modules and non-source files; allow entries need a reason and may not be stale', (t) => {
  const root = tmp(t)
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c) }
  w('server/ok.js', "export const a = 'fine'\n")
  w('server/bad.js', "db.exec('ANALYZE')\n")
  w('scripts/bad.mjs', "db.pragma('optimize')\n")
  w('server/x.test.js', "db.exec('ANALYZE')\n")
  w('tests/t.test.mjs', "db.exec('ANALYZE')\n")
  w('node_modules/m/i.js', "db.exec('ANALYZE')\n")
  w('server/notes.md', 'ANALYZE\n')
  const r = scanTree(root, { dirs: ['server', 'scripts'], allow: [] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.hits.map(h => h.file).sort(), ['scripts/bad.mjs', 'server/bad.js'])
  const allowed = scanTree(root, { dirs: ['server', 'scripts'], allow: [{ file: 'server/bad.js', reason: 'maintenance CLI the operator runs by hand' }, { file: 'scripts/bad.mjs', reason: 'bench copy only, never the app db' }] })
  assert.equal(allowed.ok, true)
  assert.throws(() => scanTree(root, { dirs: ['server'], allow: [{ file: 'server/bad.js' }] }), /reason/)
  const stale = scanTree(root, { dirs: ['server'], allow: [{ file: 'server/ok.js', reason: 'no longer needed at all here' }, { file: 'server/bad.js', reason: 'maintenance CLI the operator runs by hand' }] })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.staleAllow.map(a => a.file), ['server/ok.js'])
})

test('this repository has no ANALYZE / PRAGMA optimize in server or scripts (allowlist reasons present)', () => {
  const r = scanTree(ROOT)
  assert.deepEqual(r.hits, [])
  assert.deepEqual(r.staleAllow, [])
  assert.ok(r.filesScanned > 100, `scanned ${r.filesScanned} files`)
  for (const a of ANALYZE_ALLOW) assert.ok(a.reason && a.reason.length >= 20)
})

// ---- CLI ----

test('CLI: --snapshot writes a file, --compare is green on it and red (exit 1) after an index is dropped from a copy', (t) => {
  const dir = tmp(t)
  const dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir)
  const file = path.join(dataDir, 'gml_cosmetic.db')
  const db = new Database(file)
  db.pragma('foreign_keys=ON'); db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.close()
  const snap = path.join(dir, 'plans.json')
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/explain-audit.mjs'), ...args], { env: { ...process.env, GML_DATA_DIR: dataDir, ...env }, encoding: 'utf8' })
  const a = run(['--snapshot', snap])
  assert.equal(a.status, 0, a.stderr + a.stdout)
  const parsed = JSON.parse(fs.readFileSync(snap, 'utf8'))
  assert.equal(Object.keys(parsed.statements).length, STATEMENTS.length)
  const ok = run(['--compare', snap])
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  // a drifted fingerprint (baseline edited to differ from the code) is red and names the statement; a hash-bound whitelist entry turns it green
  const real = parsed.statements['sales.items'].hash
  const drifted = structuredClone(parsed); drifted.statements['sales.items'].hash = 'deadbeefdeadbeef'; drifted.statements['sales.items'].plan = ['SCAN x']
  const dsnap = path.join(dir, 'drifted.json'); fs.writeFileSync(dsnap, JSON.stringify(drifted))
  const red = run(['--compare', dsnap])
  assert.equal(red.status, 1)
  assert.match(red.stderr, /计划漂移 sales\.items/)
  drifted.whitelist = [{ statement: 'sales.items', accepted_hash: real, reason: 'accepted in this test: baseline intentionally differs' }]
  fs.writeFileSync(dsnap, JSON.stringify(drifted))
  const wl = run(['--compare', dsnap])
  assert.equal(wl.status, 0, wl.stderr + wl.stdout)
  // dropping an index also fails the index guard itself
  const d2 = new Database(file); d2.exec('DROP INDEX idx_oms_order_time'); d2.close()
  const bad = run(['--compare', snap])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /dash\.trend_online/)
  // --snapshot refuses to bake a violating state into the baseline
  const refused = run(['--snapshot', path.join(dir, 'p2.json')])
  assert.equal(refused.status, 1)
  assert.equal(fs.existsSync(path.join(dir, 'p2.json')), false)
})
