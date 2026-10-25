/**
 * ============================================================================
 * 文件标识：tests/explain-plan-large.test.mjs ｜ 大数据量查询计划快照 / 两份快照互查 / 启动期 PRAGMA optimize 开关的测试（roadmap-v13 AH3，ADR-0044 补充 7）
 * ============================================================================
 * 覆盖：两份快照的互查（差异必须逐条登记且写明理由，过期 / 错绑 / 语句集不同均红）；统计语句源码扫描的"按规则 + 次数"精确豁免
 * （只放行 server/db/index.js 的那一处，多一处或少一处都红）；GML_SQLITE_OPTIMIZE_ON_BOOT 的校验与启动行为（默认关、开则只跑一次并只记一行日志、
 * 非法值启动失败）；大库辅助（OMS 灌数、目录判据）；CLI（--scale large 取快照 / 比较、--compare-large、--cross-check、违规时不写）；
 * 已提交的 explain-plans.large.json 与小库快照一致；ci.yml 的 AG3 步骤与夜间工作流的大库比较步骤的文本守卫。
 * 临时目录 / 内存库，随机无端口，不碰 data/。
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
import { STATEMENTS } from '../scripts/explain-audit.mjs'
import { crossCheckSnapshots, diffSnapshots, buildSnapshot } from '../scripts/lib/explain-plan-guard.mjs'
import { scanTree, ANALYZE_ALLOW } from '../scripts/lib/analyze-scan.mjs'
import { fillOms, resolveLargeDir, LARGE_PROFILE } from '../scripts/lib/explain-large.mjs'
import { sqliteOptimizeOnBoot } from '../server/db/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const tmp = (t, p = 'os-ah3-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const LONG = 'the large database picks this plan because of a real size effect'

const fp = (hash, lines = ['SCAN t']) => ({ hash, lines })
const snap = (fps, extra = {}) => buildSnapshot({ fingerprints: fps, latestMigration: 'm1', sqliteVersion: '3.0.0', generator: 'g', ...extra })

// ---- two-snapshot cross check ----

test('identical statement sets and hashes: cross check is green with no differences', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') })
  const b = { ...snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') }), differences: [] }
  const r = crossCheckSnapshots(a, b)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.differing, [])
})

test('an undocumented difference between the two snapshots is red and names the statement and both hashes', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa') })
  const b = { ...snap({ x: fp('cccccccccccccccc') }), differences: [] }
  const r = crossCheckSnapshots(a, b)
  assert.equal(r.ok, false)
  assert.deepEqual(r.differing, ['x'])
  assert.match(r.problems.join('\n'), /x.*aaaaaaaaaaaaaaaa.*cccccccccccccccc/s)
})

test('a documented difference needs the exact pair of hashes and an explanation of at least 20 characters', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa') })
  const mk = (d) => ({ ...snap({ x: fp('cccccccccccccccc') }), differences: [d] })
  const good = { statement: 'x', small_hash: 'aaaaaaaaaaaaaaaa', large_hash: 'cccccccccccccccc', explanation: LONG }
  assert.equal(crossCheckSnapshots(a, mk(good)).ok, true)
  assert.equal(crossCheckSnapshots(a, mk({ ...good, explanation: 'too short' })).ok, false)
  assert.equal(crossCheckSnapshots(a, mk({ ...good, small_hash: 'dddddddddddddddd' })).ok, false, 'bound to the small hash')
  assert.equal(crossCheckSnapshots(a, mk({ ...good, large_hash: 'dddddddddddddddd' })).ok, false, 'bound to the large hash')
})

test('a documented difference whose plans no longer differ is stale and red; duplicates and unknown ids are red', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') })
  const same = snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') })
  const d = { statement: 'x', small_hash: 'aaaaaaaaaaaaaaaa', large_hash: 'cccccccccccccccc', explanation: LONG }
  assert.equal(crossCheckSnapshots(a, { ...same, differences: [d] }).ok, false, 'stale')
  const diff = snap({ x: fp('cccccccccccccccc'), y: fp('bbbbbbbbbbbbbbbb') })
  assert.equal(crossCheckSnapshots(a, { ...diff, differences: [d, d] }).ok, false, 'duplicate')
  assert.equal(crossCheckSnapshots(a, { ...diff, differences: [d, { ...d, statement: 'nope' }] }).ok, false, 'unknown id')
})

test('the two snapshots must register the same statement ids', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') })
  const b = { ...snap({ x: fp('aaaaaaaaaaaaaaaa') }), differences: [] }
  const r = crossCheckSnapshots(a, b)
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /y/)
})

test('diffSnapshots lists differing ids and keeps an earlier explanation only for the same hash pair', () => {
  const a = snap({ x: fp('aaaaaaaaaaaaaaaa'), y: fp('bbbbbbbbbbbbbbbb') })
  const large = snap({ x: fp('cccccccccccccccc'), y: fp('bbbbbbbbbbbbbbbb') })
  const prev = [{ statement: 'x', small_hash: 'aaaaaaaaaaaaaaaa', large_hash: 'cccccccccccccccc', explanation: LONG }]
  assert.deepEqual(diffSnapshots(a, large, prev), prev)
  const fresh = diffSnapshots(a, large, [{ ...prev[0], large_hash: 'eeeeeeeeeeeeeeee' }])
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].explanation, '', 'a changed plan needs a fresh explanation')
  assert.equal(crossCheckSnapshots(a, { ...large, differences: fresh }).ok, false, 'empty explanation is red')
})

// ---- exact source-scan allowance ----

test('scanTree: an allow entry with rule and count excuses exactly that many hits of that rule in that file', (t) => {
  const root = tmp(t)
  fs.mkdirSync(path.join(root, 'server'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  const a = path.join(root, 'server/a.js')
  const reason = 'boot-time optimize hook allowed by the AH3 opt-in switch'
  const entry = { file: 'server/a.js', rule: 'pragma-optimize', count: 1, reason }
  fs.writeFileSync(a, "db.pragma('optimize')\n")
  assert.equal(scanTree(root, { allow: [entry] }).ok, true)
  fs.writeFileSync(a, "db.pragma('optimize')\ndb.pragma('optimize')\n")
  const two = scanTree(root, { allow: [entry] })
  assert.equal(two.ok, false, 'a second call in the same file is not excused')
  assert.equal(two.hits.length, 1)
  fs.writeFileSync(a, "db.exec('ANALYZE')\ndb.pragma('optimize')\n")
  const other = scanTree(root, { allow: [entry] })
  assert.equal(other.ok, false, 'a different rule in the same file is not excused')
  assert.equal(other.hits[0].rule, 'stats')
  fs.writeFileSync(a, 'const x = 1\n')
  const stale = scanTree(root, { allow: [entry] })
  assert.equal(stale.ok, false)
  assert.equal(stale.staleAllow.length, 1, 'fewer hits than the allowed count is stale')
  assert.throws(() => scanTree(root, { allow: [{ ...entry, reason: 'short' }] }), /理由/)
  assert.throws(() => scanTree(root, { allow: [{ ...entry, count: 0 }] }), /count/)
})

test('this repository allows PRAGMA optimize in exactly one place: the opt-in boot hook in server/db/index.js', () => {
  assert.equal(ANALYZE_ALLOW.length, 1)
  assert.equal(ANALYZE_ALLOW[0].file, 'server/db/index.js')
  assert.equal(ANALYZE_ALLOW[0].rule, 'pragma-optimize')
  assert.equal(ANALYZE_ALLOW[0].count, 1)
  const r = scanTree(ROOT)
  assert.deepEqual(r.hits, [])
  assert.deepEqual(r.staleAllow, [])
  assert.equal(r.allowedHits.length, 1)
  assert.equal(r.allowedHits[0].file, 'server/db/index.js')
})

// ---- GML_SQLITE_OPTIMIZE_ON_BOOT ----

test('GML_SQLITE_OPTIMIZE_ON_BOOT: default off; 1/true on; 0/false off; anything else is rejected at startup', () => {
  assert.equal(sqliteOptimizeOnBoot({}), false)
  assert.equal(sqliteOptimizeOnBoot({ GML_SQLITE_OPTIMIZE_ON_BOOT: '' }), false)
  for (const v of ['0', 'false']) assert.equal(sqliteOptimizeOnBoot({ GML_SQLITE_OPTIMIZE_ON_BOOT: v }), false, v)
  for (const v of ['1', 'true']) assert.equal(sqliteOptimizeOnBoot({ GML_SQLITE_OPTIMIZE_ON_BOOT: v }), true, v)
  for (const bad of ['yes', 'on', 'TRUE', '2', ' 1', 'optimize', '1;DROP TABLE x', '-1']) {
    assert.throws(() => sqliteOptimizeOnBoot({ GML_SQLITE_OPTIMIZE_ON_BOOT: bad }), (e) => e.code === 'SQLITE_OPTIMIZE_ON_BOOT_INVALID', bad)
  }
})

function bootChild(dir, env) {
  const code = `
    const m = await import(${JSON.stringify(path.join(ROOT, 'server/db/index.js'))})
    const db = m.initSchemaFor('cosmetic', { log: () => {} })
    m.getDbFor('cosmetic'); m.getDbFor('cosmetic')
    const stat = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get()
    console.log('RESULT ' + JSON.stringify({ stat1: !!stat }))
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', ...env }
  })
}

test('boot hook: off by default (no log line); on logs exactly one line and survives repeated getDbFor; invalid value aborts', (t) => {
  const off = bootChild(tmp(t), {})
  assert.equal(off.status, 0, off.stderr + off.stdout)
  assert.doesNotMatch(off.stdout + off.stderr, /optimize/i)
  const dir = tmp(t)
  const on = bootChild(dir, { GML_SQLITE_OPTIMIZE_ON_BOOT: '1' })
  assert.equal(on.status, 0, on.stderr + on.stdout)
  const lines = (on.stdout + on.stderr).split('\n').filter((l) => /sqlite-optimize-on-boot/.test(l))
  assert.equal(lines.length, 1, `expected one log line, got: ${lines.join(' | ')}`)
  assert.match(lines[0], /cosmetic/)
  const bad = bootChild(tmp(t), { GML_SQLITE_OPTIMIZE_ON_BOOT: 'maybe' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /SQLITE_OPTIMIZE_ON_BOOT_INVALID/)
})

// ---- large-database helpers ----

function migratedFile(dir, name = 'gml_cosmetic.db') {
  const file = path.join(dir, name)
  const db = new Database(file)
  db.pragma('foreign_keys=ON'); db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.close()
  return file
}

test('fillOms is deterministic, creates platforms, orders inside the dense window and one item per order, and never runs statistics', (t) => {
  const dir = tmp(t)
  const file = migratedFile(dir)
  const r1 = fillOms(file, { rows: 500, spanDays: 60, seed: 7, anchor: '2026-10-01' })
  assert.equal(r1.orders, 500)
  const db = new Database(file, { readonly: true })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM oms_orders').get().c, 500)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM oms_order_items').get().c, 500)
  assert.ok(db.prepare('SELECT COUNT(*) c FROM platforms').get().c >= 5)
  assert.deepEqual(db.prepare('SELECT w.org_id o, COUNT(*) n FROM platforms p JOIN warehouses w ON w.id=p.warehouse_id GROUP BY w.org_id ORDER BY 1').all(), [{ o: 1, n: 2 }, { o: 2, n: 3 }], 'platforms are bound to two organisations so scoped statements are measurable')
  const { lo, hi } = db.prepare('SELECT MIN(order_time) lo, MAX(order_time) hi FROM oms_orders').get()
  assert.ok(lo >= '2026-07-30' && hi <= '2026-10-02', `${lo}..${hi}`)
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(), undefined)
  const digest = db.prepare('SELECT group_concat(platform_order_no || order_time || pay_amount) d FROM (SELECT * FROM oms_orders ORDER BY id)').get().d
  db.close()
  const dir2 = tmp(t)
  const file2 = migratedFile(dir2)
  fillOms(file2, { rows: 500, spanDays: 60, seed: 7, anchor: '2026-10-01' })
  const db2 = new Database(file2, { readonly: true })
  assert.equal(db2.prepare('SELECT group_concat(platform_order_no || order_time || pay_amount) d FROM (SELECT * FROM oms_orders ORDER BY id)').get().d, digest)
  db2.close()
})

test('resolveLargeDir accepts an absolute directory holding the industry database and refuses repo data/, relative paths, symlinks and missing files', (t) => {
  const dir = tmp(t)
  const file = migratedFile(dir)
  assert.equal(resolveLargeDir(dir, 'cosmetic'), file)
  assert.throws(() => resolveLargeDir('relative/dir', 'cosmetic'), /绝对路径/)
  assert.throws(() => resolveLargeDir(path.resolve(ROOT, 'data'), 'cosmetic'), /data\//)
  assert.throws(() => resolveLargeDir(tmp(t), 'cosmetic'), /找不到/)
  const link = path.join(tmp(t), 'link')
  fs.symlinkSync(dir, link)
  const dbLinkDir = tmp(t)
  fs.symlinkSync(file, path.join(dbLinkDir, 'gml_cosmetic.db'))
  assert.throws(() => resolveLargeDir(dbLinkDir, 'cosmetic'), /符号链接/)
  assert.ok(LARGE_PROFILE.skus >= 20000 && LARGE_PROFILE.oms_orders >= 100000)
})

// ---- CLI ----

const AUDIT = path.join(ROOT, 'scripts/explain-audit.mjs')
const MINI = ['--large-min', 'oms_orders=100,inventory_transactions=0,product_skus=0']
const MINI0 = ['--large-min', 'oms_orders=0,inventory_transactions=0,product_skus=0']
const runAudit = (args, env = {}) => spawnSync(process.execPath, [AUDIT, ...args], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, encoding: 'utf8', timeout: 120000 })

test('CLI: --scale large on a reused database writes a large snapshot (scale, dataset row counts, differences) and --compare --scale large is green on it', (t) => {
  const dir = tmp(t)
  const file = migratedFile(dir)
  fillOms(file, { rows: 300, spanDays: 60, seed: 3, anchor: '2026-10-01' })
  const out = path.join(tmp(t), 'large.json')
  const small = path.join(tmp(t), 'small.json')
  const smallDir = tmp(t); migratedFile(smallDir)
  assert.equal(runAudit(['--snapshot', small], { GML_DATA_DIR: smallDir }).status, 0)
  const a = runAudit(['--snapshot', out, '--scale', 'large', '--large-dir', dir, '--small-snapshot', small, ...MINI])
  assert.equal(a.status, 0, a.stderr + a.stdout)
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(parsed.scale, 'large')
  assert.equal(parsed.statement_count, STATEMENTS.length)
  assert.equal(parsed.dataset.table_rows.oms_orders, 300)
  assert.deepEqual(parsed.differences, [])
  const ok = runAudit(['--compare', out, '--scale', 'large', '--large-dir', dir, ...MINI])
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  // a small snapshot is refused as the large baseline and vice versa
  const mismatch = runAudit(['--compare', small, '--scale', 'large', '--large-dir', dir, ...MINI])
  assert.equal(mismatch.status, 2, mismatch.stderr)
  assert.match(mismatch.stderr, /scale/)
})

test('CLI: --compare with --compare-large checks both snapshot files; --cross-check needs no large database; undocumented differences are red', (t) => {
  const smallDir = tmp(t); migratedFile(smallDir)
  const largeDir = tmp(t); const lf = migratedFile(largeDir); fillOms(lf, { rows: 300, spanDays: 60, seed: 3, anchor: '2026-10-01' })
  const work = tmp(t)
  const small = path.join(work, 'small.json'), large = path.join(work, 'large.json')
  assert.equal(runAudit(['--snapshot', small], { GML_DATA_DIR: smallDir }).status, 0)
  assert.equal(runAudit(['--snapshot', large, '--scale', 'large', '--large-dir', largeDir, '--small-snapshot', small, ...MINI]).status, 0)
  const both = runAudit(['--compare', small, '--compare-large', large, '--large-dir', largeDir, ...MINI], { GML_DATA_DIR: smallDir })
  assert.equal(both.status, 0, both.stderr + both.stdout)
  assert.match(both.stdout, /大库/)
  const cross = runAudit(['--compare', small, '--cross-check', large], { GML_DATA_DIR: smallDir })
  assert.equal(cross.status, 0, cross.stderr + cross.stdout)
  // tamper with the large baseline: the large database no longer matches AND the files disagree
  const t1 = JSON.parse(fs.readFileSync(large, 'utf8'))
  t1.statements['sales.items'].hash = 'deadbeefdeadbeef'; t1.statements['sales.items'].plan = ['SCAN x']
  const tampered = path.join(work, 'tampered.json'); fs.writeFileSync(tampered, JSON.stringify(t1))
  const redCross = runAudit(['--compare', small, '--cross-check', tampered], { GML_DATA_DIR: smallDir })
  assert.equal(redCross.status, 1)
  assert.match(redCross.stderr, /sales\.items/)
  const redLarge = runAudit(['--compare', small, '--compare-large', tampered, '--large-dir', largeDir, ...MINI], { GML_DATA_DIR: smallDir })
  assert.equal(redLarge.status, 1)
  assert.match(redLarge.stderr, /计划漂移 sales\.items/)
  // dropping an index from the large database is caught on the large side even though the small database is intact
  const d = new Database(lf); d.exec('DROP INDEX idx_oms_order_time'); d.close()
  const noIdx = runAudit(['--compare', small, '--compare-large', large, '--large-dir', largeDir, ...MINI], { GML_DATA_DIR: smallDir })
  assert.equal(noIdx.status, 1)
  assert.match(noIdx.stderr, /dash\.trend_online/)
  // --snapshot --scale large refuses to bake a violating database into the baseline
  const refused = runAudit(['--snapshot', path.join(work, 'x.json'), '--scale', 'large', '--large-dir', largeDir, '--small-snapshot', small, ...MINI])
  assert.equal(refused.status, 1)
  assert.equal(fs.existsSync(path.join(work, 'x.json')), false)
})

test('CLI: --scale large refuses a database that is not large (empty OMS table), and --fill-oms tops up an isolated copy without touching the original', (t) => {
  const dir = tmp(t); const file = migratedFile(dir)
  const small = path.join(tmp(t), 'small.json'); const smallDir = tmp(t); migratedFile(smallDir)
  assert.equal(runAudit(['--snapshot', small], { GML_DATA_DIR: smallDir }).status, 0)
  const large = path.join(tmp(t), 'large.json')
  assert.equal(runAudit(['--snapshot', large, '--scale', 'large', '--large-dir', dir, '--small-snapshot', small, ...MINI0]).status, 0)
  const empty = runAudit(['--compare', large, '--scale', 'large', '--large-dir', dir])
  assert.equal(empty.status, 2, empty.stderr + empty.stdout)
  assert.match(empty.stderr, /不够"大"/)
  assert.match(empty.stderr, /oms_orders/)
  assert.equal(runAudit(['--snapshot', path.join(tmp(t), 'x.json'), '--scale', 'large', '--large-dir', dir, '--small-snapshot', small]).status, 2, 'a snapshot of a small database is refused too')
  const before = fs.statSync(file).mtimeMs
  const filled = runAudit(['--compare', large, '--scale', 'large', '--large-dir', dir, '--fill-oms', '500', ...MINI])
  assert.equal(filled.status, 0, filled.stderr + filled.stdout)
  assert.equal(fs.statSync(file).mtimeMs, before, 'the original database is untouched')
  const check = new Database(file, { readonly: true })
  assert.equal(check.prepare('SELECT COUNT(*) c FROM oms_orders').get().c, 0)
  check.close()
  assert.equal(runAudit(['--compare', large, '--scale', 'large', '--fill-oms', '500']).status, 2, '--fill-oms needs --large-dir')
  assert.equal(runAudit(['--compare', large, '--scale', 'large', '--large-dir', dir, '--large-min', 'bogus=1']).status, 2)
})

test('CLI: a large database that has sqlite_stat1 is refused, not compared', (t) => {
  const largeDir = tmp(t); const lf = migratedFile(largeDir)
  const small = path.join(tmp(t), 'small.json'); const smallDir = tmp(t); migratedFile(smallDir)
  assert.equal(runAudit(['--snapshot', small], { GML_DATA_DIR: smallDir }).status, 0)
  const large = path.join(tmp(t), 'large.json')
  assert.equal(runAudit(['--snapshot', large, '--scale', 'large', '--large-dir', largeDir, '--small-snapshot', small, ...MINI0]).status, 0)
  const d = new Database(lf); d.exec('ANALYZE'); d.close()
  const r = runAudit(['--compare', large, '--scale', 'large', '--large-dir', largeDir, ...MINI0])
  assert.equal(r.status, 2, r.stderr + r.stdout)
  assert.match(r.stderr, /sqlite_stat1/)
})

// ---- dense-window latency script ----

test('bench-oms-dense-window: reads a reused database read-only and reports p50/p95 for the OMS /stats statements over the dense window', (t) => {
  const dir = tmp(t)
  const file = migratedFile(dir)
  fillOms(file, { rows: 600, spanDays: 60, seed: 5, anchor: '2026-10-01' })
  const before = fs.statSync(file).mtimeMs
  const out = path.join(tmp(t), 'dense.json')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/bench-oms-dense-window.mjs'), '--dir', dir, '--repeat', '3', '--out', out], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const res = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(res.oms_orders, 600)
  assert.equal(res.has_stat1, false)
  const keys = Object.keys(res.statements)
  assert.ok(keys.includes('stats_top_skus.global.90d') && keys.includes('stats_by_platform.org1.30d') && keys.includes('ai_platform.global.30d'))
  for (const k of keys) { const x = res.statements[k]; assert.ok(x.p50 >= 0 && x.p95 >= x.p50, k); assert.ok(x.window_rows_all >= 0) }
  assert.ok(res.statements['stats_total.global.90d'].window_rows_all > 0, 'the dense window must contain orders')
  assert.ok(res.statements['stats_trend.org1.90d'].rows_returned >= 1, 'the scoped (org 1) statements must see orders')
  assert.equal(fs.statSync(file).mtimeMs, before, 'the database file is untouched')
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts/bench-oms-dense-window.mjs'), '--dir', 'relative'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
})

// ---- committed artefacts ----

test('the committed explain-plans.large.json is a large-scale snapshot of the same statements and agrees with the small one except for documented differences', () => {
  const small = JSON.parse(read('docs/implementation/explain-plans.json'))
  const large = JSON.parse(read('docs/implementation/explain-plans.large.json'))
  assert.equal(large.scale, 'large')
  assert.equal(large.statement_count, STATEMENTS.length)
  assert.equal(large.latest_migration, small.latest_migration)
  assert.ok(large.dataset.table_rows.oms_orders >= 100000, 'OMS table must be large')
  assert.ok(large.dataset.table_rows.inventory_transactions >= 100000)
  const r = crossCheckSnapshots(small, large)
  assert.deepEqual(r.problems, [])
  assert.equal(r.ok, true)
})

test('query-planner.md documents the small-vs-large differences: every listed statement appears with its explanation, or the doc states there are none', () => {
  const large = JSON.parse(read('docs/implementation/explain-plans.large.json'))
  const doc = read('docs/operations/query-planner.md')
  const i = doc.indexOf('## 2e.')
  assert.ok(i >= 0, 'section 2e missing')
  const section = doc.slice(i)
  assert.match(section, /explain-plans\.large\.json/)
  assert.match(section, /GML_SQLITE_OPTIMIZE_ON_BOOT/)
  if (large.differences.length === 0) assert.match(section, /没有任何语句|无差异|零差异/)
  for (const d of large.differences) {
    assert.ok(section.includes(`\`${d.statement}\``), `${d.statement} not documented`)
    assert.ok(section.includes(d.explanation), `explanation for ${d.statement} not copied into the doc`)
  }
})

test('ci.yml: only the AG3 step changed in shape; it compares both snapshot files without building the large database on the runner', () => {
  const ci = read('.github/workflows/ci.yml')
  const m = /- name: Query plan snapshot[^\n]*\n([\s\S]*?)(?=\n      - name:)/.exec(ci)
  assert.ok(m, 'AG3 step missing')
  assert.match(m[1], /explain-audit\.mjs --compare docs\/implementation\/explain-plans\.json/)
  assert.match(m[1], /--cross-check docs\/implementation\/explain-plans\.large\.json/)
  assert.doesNotMatch(m[1], /--scale large|--compare-large|large-ci/, 'the large database is nightly-only')
})

test('nightly-capacity.yml compares the large snapshot against the pipeline database with output redirected to a log', () => {
  const nightly = read('.github/workflows/nightly-capacity.yml')
  assert.match(nightly, /explain-audit\.mjs --scale large --compare docs\/implementation\/explain-plans\.large\.json --large-dir "\$CAP_RUN\/data" --fill-oms 200000 > "\$CAP_REPORTS\/explain-large\.log" 2>&1/)
  const step = /- name: Large-database plan snapshot[\s\S]*?(?=\n      - name:|\n      - uses:)/.exec(nightly)?.[0] ?? ''
  assert.match(step, /continue-on-error: true/)
  assert.match(step, /if: inputs\.scale != 'large-ci' && steps\.pipeline\.outcome == 'success'/)
  assert.doesNotMatch(step, /cat "\$CAP_REPORTS|tail /)
})

test('capacity-baseline records the AH3 large-database OMS dense-window measurement labelled Mac mini / not the target host', () => {
  const doc = read('docs/implementation/capacity-baseline.md')
  const i = doc.indexOf('## AH3 ')
  assert.ok(i >= 0, 'AH3 section missing')
  const section = doc.slice(i, i + 6000)
  assert.match(section, /Mac mini/)
  assert.match(section, /非目标主机|不是 `dmserver`/)
  assert.match(section, /p95/)
})
