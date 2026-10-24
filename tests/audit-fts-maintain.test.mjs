/**
 * ============================================================================
 * 文件标识：tests/audit-fts-maintain.test.mjs ｜ AC5 审计 FTS 维护脚本（scripts/audit-fts-maintain.mjs）：拒绝仓库 data/、三种操作、报告与持锁探针
 * 全部在系统临时目录里建库；子进程只用 --data-dir 指向临时目录，不监听端口，绝不打开仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = 'scripts/audit-fts-maintain.mjs'
const SCHEMA = readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const env = (dir) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: 'a'.repeat(48) })
const run = (args, dir) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: env(dir), encoding: 'utf8', timeout: 120000 })

function fixture(t, rows = 50) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-ac5-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  const ins = db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (?,?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(1, `user${i % 7}`, i % 2 ? 'UPDATE' : 'CREATE', 'sales', `ent${i % 5}`, String(i)) })()
  return { dir, db }
}
const reportOf = (dir, out) => JSON.parse(readFileSync(out ?? path.join(dir, readdirSync(dir).find((f) => /^audit-fts-maintain-.*\.json$/.test(f))), 'utf8'))

test('refuses the repository data/ directory, relative paths, missing arguments and ambiguous modes (nothing is opened)', (t) => {
  const { dir, db } = fixture(t, 3)
  db.close()
  const repo = run(['--data-dir', path.join(ROOT, 'data'), '--industry', 'cosmetic', '--integrity-check'], dir)
  assert.equal(repo.status, 2); assert.match(repo.stderr, /DATA_DIRECTORY_IS_REPOSITORY/)
  const rel = run(['--data-dir', 'relative/dir', '--industry', 'cosmetic', '--rebuild'], dir)
  assert.equal(rel.status, 2); assert.match(rel.stderr, /绝对路径/)
  assert.equal(run(['--industry', 'cosmetic', '--rebuild'], dir).status, 2, 'no data dir')
  assert.equal(run(['--data-dir', dir, '--rebuild'], dir).status, 2, 'industry is required')
  assert.equal(run(['--data-dir', dir, '--industry', 'nope', '--rebuild'], dir).status, 2)
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 2, 'one mode is required')
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--rebuild', '--optimize'], dir).status, 2, 'exactly one mode')
  assert.equal(run(['--data-dir', dir, '--industry', 'food', '--rebuild'], dir).status, 2, 'a missing industry database is not created')
  assert.equal(existsSync(path.join(dir, 'gml_food.db')), false)
  const viaEnv = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', '--integrity-check'], { cwd: ROOT, env: { ...env(dir), GML_DB: path.join(ROOT, 'data', 'gml_cosmetic.db') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(viaEnv.status, 0, 'GML_DB from the environment is ignored; the explicit data dir wins')
  assert.equal(reportOf(dir).data_file, 'gml_cosmetic.db')
})

test('--integrity-check: healthy index passes; an index that missed a row is reported and exits 1; --rebuild repairs it', (t) => {
  const { dir, db } = fixture(t)
  const ok = run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'r1.json')], dir)
  assert.equal(ok.status, 0, ok.stderr)
  const r1 = reportOf(dir, path.join(dir, 'r1.json'))
  assert.equal(r1.action, 'integrity-check'); assert.equal(r1.ok, true); assert.equal(r1.status, 'ok')
  assert.equal(r1.rows, 50); assert.equal(r1.industry, 'cosmetic')
  // 绕过触发器写一行：索引漏项
  db.exec('DROP TRIGGER audit_logs_fts_ai')
  db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,'ghost','GHOSTACT','sales','e','1')").run()
  const bad = run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'r2.json')], dir)
  assert.equal(bad.status, 1)
  const r2 = reportOf(dir, path.join(dir, 'r2.json'))
  assert.equal(r2.ok, false); assert.equal(r2.status, 'corrupt'); assert.ok(r2.error)
  assert.equal(r2.triggers_present.audit_logs_fts_ai, false)
  const fix = run(['--data-dir', dir, '--industry', 'cosmetic', '--rebuild', '--out', path.join(dir, 'r3.json')], dir)
  assert.equal(fix.status, 0, fix.stderr)
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'r4.json')], dir).status, 0, 'index consistent again')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH '\"GHOSTACT\"'").get().c, 1)
})

test('--rebuild and --optimize: report carries elapsed time and a lock-probe result; default report lands in the data dir', (t) => {
  const { dir, db } = fixture(t, 2000)
  db.close()
  for (const mode of ['rebuild', 'optimize']) {
    const r = run(['--data-dir', dir, '--industry', 'cosmetic', `--${mode}`], dir)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`audit-fts-maintain ${mode} ok`))
  }
  const files = readdirSync(dir).filter((f) => /^audit-fts-maintain-.*\.json$/.test(f))
  assert.equal(files.length, 2)
  for (const f of files) {
    const rep = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    assert.equal(rep.ok, true); assert.equal(rep.rows, 2000)
    assert.ok(rep.elapsed_ms >= 0 && Number.isFinite(rep.elapsed_ms))
    for (const k of ['max_blocked_ms', 'max_busy_span_ms', 'ok_attempts', 'busy_attempts', 'blocked_windows', 'probe_interval_ms']) assert.equal(typeof rep.lock_probe[k], 'number', k)
    assert.equal(rep.lock_probe.other_errors, 0)
    assert.ok(rep.lock_probe.ok_attempts > 0, 'the probe ran')
    assert.equal(rep.data_file, 'gml_cosmetic.db')
    assert.ok(!JSON.stringify(rep).includes(dir), 'report holds no absolute paths')
  }
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'x.json')], dir).status, 0)
})

test('database without audit_logs_fts: integrity-check reports absent (exit 0); rebuild and optimize refuse (exit 1)', (t) => {
  const { dir, db } = fixture(t, 5)
  db.exec('DROP TRIGGER audit_logs_fts_ai; DROP TRIGGER audit_logs_fts_ad; DROP TRIGGER audit_logs_fts_au; DROP TABLE audit_logs_fts')
  db.close()
  const c = run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'a.json')], dir)
  assert.equal(c.status, 0); assert.equal(reportOf(dir, path.join(dir, 'a.json')).status, 'absent')
  for (const mode of ['rebuild', 'optimize']) {
    const r = run(['--data-dir', dir, '--industry', 'cosmetic', `--${mode}`, '--out', path.join(dir, `${mode}.json`)], dir)
    assert.equal(r.status, 1, mode)
    assert.equal(reportOf(dir, path.join(dir, `${mode}.json`)).status, 'absent')
  }
})

test('rebuild while another connection holds the write lock: waits (busy_timeout) rather than corrupting, and the probe sees the block', (t) => {
  const { dir, db } = fixture(t, 100)
  db.close()
  const holder = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => { try { holder.close() } catch { /* closed */ } })
  holder.exec('BEGIN IMMEDIATE')
  const r = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', '--rebuild', '--busy-ms', '200', '--out', path.join(dir, 'b.json')], { cwd: ROOT, env: env(dir), encoding: 'utf8', timeout: 60000 })
  holder.exec('ROLLBACK')
  assert.equal(r.status, 1, 'cannot take the write lock: fails cleanly')
  const rep = reportOf(dir, path.join(dir, 'b.json'))
  assert.equal(rep.ok, false); assert.equal(rep.status, 'busy')
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'c.json')], dir).status, 0, 'index untouched and consistent')
})
