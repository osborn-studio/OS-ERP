/**
 * ============================================================================
 * 文件标识：tests/audit-fts-maintain.test.mjs ｜ AC5 审计 FTS 维护脚本（scripts/audit-fts-maintain.mjs）：拒绝仓库 data/、三种操作、报告与持锁探针
 * 全部在系统临时目录里建库；子进程只用 --data-dir 指向临时目录，不监听端口，绝不打开仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, symlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import * as m067 from '../server/db/migrations/067_audit_fts.cjs'
import { REBUILD_STATE_TABLE } from '../server/lib/audit-fts-state.js'
import { ftsAvailable, ftsState, auditQueryPlan, parseFilters, keywordUsesFts } from '../server/lib/audit-view.js'
import { REBUILD_STATE_DDL } from '../server/lib/audit-fts-state.js'
import { counterSnapshot, resetCounters } from '../server/lib/process-counters.js'

// AD4：CI 的 audit-no-fts5 job 在没有 FTS5 的 SQLite 构建上跑本文件：依赖索引存在的用例跳过，无 FTS5 用例真实执行
const NO_FTS5 = !m067.ftsSupported(new Database(':memory:'))
const needsFts5 = NO_FTS5 ? { skip: 'this SQLite build has no FTS5' } : {}
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

test('--integrity-check: healthy index passes; an index that missed a row is reported and exits 1; --rebuild repairs it', needsFts5, (t) => {
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

test('--rebuild and --optimize: report carries elapsed time and a lock-probe result; default report lands in the data dir', needsFts5, (t) => {
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

test('database without audit_logs_fts: integrity-check reports absent (exit 0); rebuild and optimize refuse (exit 1)', needsFts5, (t) => {
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

test('rebuild while another connection holds the write lock: fails cleanly as busy after --busy-ms, index untouched, report says busy', needsFts5, (t) => {
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

test('--out cannot overwrite the database or its sidecars, nor an existing file; a symlinked database and symlinked/nonexistent --out parents into repo data/ are refused before anything is opened', (t) => {
  const { dir, db } = fixture(t, 5)
  db.close()
  const before = statSync(path.join(dir, 'gml_cosmetic.db')).size
  const base = ['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check']
  for (const f of ['gml_cosmetic.db', 'gml_cosmetic.db-wal', 'gml_cosmetic.db-shm', 'gml_cosmetic.db-journal']) {
    const r = run([...base, '--out', path.join(dir, f)], dir)
    assert.equal(r.status, 2, f); assert.match(r.stderr, /OUT_/, f)
  }
  assert.equal(statSync(path.join(dir, 'gml_cosmetic.db')).size, before, 'database untouched')
  assert.equal(new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true }).prepare('SELECT COUNT(*) c FROM audit_logs').get().c, 5)
  writeFileSync(path.join(dir, 'exists.json'), 'keep')
  assert.equal(run([...base, '--out', path.join(dir, 'exists.json')], dir).status, 2, 'never overwrites an existing file')
  assert.equal(readFileSync(path.join(dir, 'exists.json'), 'utf8'), 'keep')
  // 经符号链接进入仓库 data/ 的 --out（父目录不存在也要认）：拒绝，且不创建任何东西
  const link = path.join(dir, 'link-to-repo-data')
  symlinkSync(path.join(ROOT, 'data'), link)
  for (const out of [path.join(link, 'r.json'), path.join(link, 'new-subdir', 'r.json')]) {
    const r = run([...base, '--out', out], dir)
    assert.equal(r.status, 2, out); assert.match(r.stderr, /DATA_DIRECTORY_IS_REPOSITORY/)
  }
  assert.equal(existsSync(path.join(ROOT, 'data', 'new-subdir')), false, 'nothing was created under the repository data/')
  // 库文件本身是符号链接（可能指向仓库 data/）：拒绝
  const { dir: dir2, db: db2 } = fixture(t, 1)
  db2.close()
  rmSync(path.join(dir2, 'gml_cosmetic.db')); rmSync(path.join(dir2, 'gml_cosmetic.db-wal'), { force: true }); rmSync(path.join(dir2, 'gml_cosmetic.db-shm'), { force: true })
  symlinkSync(path.join(ROOT, 'data', 'gml_cosmetic.db'), path.join(dir2, 'gml_cosmetic.db'))
  const sym = run(['--data-dir', dir2, '--industry', 'cosmetic', '--integrity-check'], dir2)
  assert.equal(sym.status, 2); assert.match(sym.stderr, /DB_IS_SYMLINK|DB_ABSENT/, 'dangling link: never opened')
  // 指向另一个真实库的符号链接：明确按符号链接拒绝
  const { dir: dir3, db: db3 } = fixture(t, 1)
  db3.close()
  const { dir: dir4, db: db4 } = fixture(t, 1)
  db4.close()
  for (const f of ['gml_cosmetic.db', 'gml_cosmetic.db-wal', 'gml_cosmetic.db-shm']) rmSync(path.join(dir4, f), { force: true })
  symlinkSync(path.join(dir3, 'gml_cosmetic.db'), path.join(dir4, 'gml_cosmetic.db'))
  const real = run(['--data-dir', dir4, '--industry', 'cosmetic', '--integrity-check'], dir4)
  assert.equal(real.status, 2); assert.match(real.stderr, /DB_IS_SYMLINK/)
})

// AD4（ADR-0054）：--disable / --enable 在同一事务里改设置 audit_fts_enabled 并删/重建 FTS 对象
const ftsNames = (db) => db.prepare("SELECT type,name FROM sqlite_master WHERE (type='trigger' AND name LIKE 'audit_logs_fts%') OR name='audit_logs_fts' ORDER BY name").all().map((r) => `${r.type}:${r.name}`)
const settingRow = (db) => db.prepare("SELECT value FROM settings WHERE key='audit_fts_enabled'").get()?.value

test('AD4 --disable / --enable require --reason (exit 2, nothing changed)', needsFts5, (t) => {
  const { dir, db } = fixture(t, 5)
  db.close()
  for (const m of ['disable', 'enable']) {
    const r = run(['--data-dir', dir, '--industry', 'cosmetic', `--${m}`], dir)
    assert.equal(r.status, 2, m); assert.match(r.stderr, /--reason/)
    assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', `--${m}`, '--reason', '  '], dir).status, 2, 'blank reason')
  }
  const chk = new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true })
  t.after(() => chk.close())
  assert.equal(ftsNames(chk).length, 4)
})

test('AD4 --disable drops table + triggers and records the setting with a reason; idempotent; audit writes keep working; --enable rebuilds and backfills', needsFts5, (t) => {
  const { dir, db } = fixture(t, 30)
  const off = run(['--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'disk pressure drill', '--out', path.join(dir, 'd1.json')], dir)
  assert.equal(off.status, 0, off.stderr + off.stdout)
  const r1 = reportOf(dir, path.join(dir, 'd1.json'))
  assert.equal(r1.status, 'ok'); assert.equal(r1.fts_present, false); assert.equal(r1.setting_after, '0'); assert.equal(r1.setting_changed, true)
  assert.deepEqual(ftsNames(db), [])
  assert.equal(settingRow(db), '0')
  const log = db.prepare("SELECT action,value_after,reason,actor_name,actor_source FROM setting_audit_log WHERE key='audit_fts_enabled' ORDER BY id").all()
  assert.deepEqual(log.map((l) => l.action), ['baseline', 'set'])
  assert.equal(log[1].value_after, '0'); assert.equal(log[1].reason, 'disk pressure drill'); assert.equal(log[1].actor_source, 'script')
  const again = run(['--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'again', '--out', path.join(dir, 'd2.json')], dir)
  assert.equal(again.status, 0); assert.equal(reportOf(dir, path.join(dir, 'd2.json')).setting_changed, false)
  // 没有触发器：写入照常；FTS 维护动作如实报 absent
  db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,'zed','WHILEOFF','sales','e','1')").run()
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
  assert.equal(reportOf(dir, path.join(dir, 'i.json')).status, 'absent')
  // 重新开启：重建 + 回填
  const on = run(['--data-dir', dir, '--industry', 'cosmetic', '--enable', '--reason', 'drill over', '--out', path.join(dir, 'e1.json')], dir)
  assert.equal(on.status, 0, on.stderr + on.stdout)
  const r3 = reportOf(dir, path.join(dir, 'e1.json'))
  assert.equal(r3.status, 'ok'); assert.equal(r3.fts_present, true); assert.equal(r3.setting_after, '1')
  assert.equal(ftsNames(db).length, 4)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH '\"WHILEOFF\"'").get().c, 1, 'row written while off is indexed')
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', path.join(dir, 'i2.json')], dir).status, 0)
  assert.equal(reportOf(dir, path.join(dir, 'i2.json')).status, 'ok')
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--enable', '--reason', 'noop', '--out', path.join(dir, 'e2.json')], dir).status, 0)
  assert.equal(reportOf(dir, path.join(dir, 'e2.json')).setting_changed, false)
})

test('AD4 the setting wins at startup: after --disable, runMigrations does not recreate the index; after --enable it is left alone', needsFts5, (t) => {
  const { dir, db } = fixture(t, 10)
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'x'], dir).status, 0)
  const r = runMigrations(db, { mode: 'test', warn: () => {} })
  assert.ok(!r.healed.some((h) => /audit_fts|067|071/.test(h)), r.healed.join())
  assert.deepEqual(ftsNames(db), [])
})

test('AD4 --disable on a lock-held database fails as busy and changes neither the objects nor the setting', needsFts5, (t) => {
  const { dir, db } = fixture(t, 20)
  db.close()
  const holder = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => { try { holder.close() } catch { /* closed */ } })
  // 先让 ensureSettings 能写：库已迁移但 settings 行可能缺；持锁前不预置，直接测忙
  holder.exec('BEGIN IMMEDIATE')
  const r = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'x', '--busy-ms', '200', '--out', path.join(dir, 'b.json')], { cwd: ROOT, env: env(dir), encoding: 'utf8', timeout: 60000 })
  holder.exec('ROLLBACK')
  assert.equal(r.status, 1)
  assert.equal(reportOf(dir, path.join(dir, 'b.json')).status, 'busy')
  assert.equal(ftsNames(holder).length, 4)
  assert.notEqual(settingRow(holder), '0')
})

test('AD4 on a SQLite build WITHOUT FTS5 (CI audit-no-fts5): integrity-check is absent/0, optimize/rebuild/enable exit 1, disable only records the setting', { skip: NO_FTS5 ? false : 'this SQLite build has FTS5; the audit-no-fts5 CI job runs this case' }, (t) => {
  const { dir, db } = fixture(t, 5)
  assert.deepEqual(ftsNames(db), [])
  db.close()
  const o = (n) => path.join(dir, `${n}.json`)
  assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', '--integrity-check', '--out', o('i')], dir).status, 0)
  assert.equal(reportOf(dir, o('i')).status, 'absent')
  for (const m of ['optimize', 'rebuild']) assert.equal(run(['--data-dir', dir, '--industry', 'cosmetic', `--${m}`, '--out', o(m)], dir).status, 1, m)
  const en = run(['--data-dir', dir, '--industry', 'cosmetic', '--enable', '--reason', 'x', '--out', o('en')], dir)
  assert.equal(en.status, 1); assert.equal(reportOf(dir, o('en')).status, 'unsupported')
  const dis = run(['--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'x', '--out', o('dis')], dir)
  assert.equal(dis.status, 0, dis.stderr + dis.stdout); assert.equal(reportOf(dir, o('dis')).setting_after, '0')
})

test('AD4 a failed toggle rolls back everything, including a freshly seeded setting row and its baseline', needsFts5, (t) => {
  const { dir, db } = fixture(t, 10)
  db.exec("DELETE FROM settings WHERE key='audit_fts_enabled'; DELETE FROM setting_audit_log WHERE key='audit_fts_enabled'")
  // 触发器上挂一个会失败的东西：让删除 FTS 对象之后的 writeSetting 写日志失败
  db.exec("CREATE TRIGGER ad4_fail BEFORE INSERT ON setting_audit_log WHEN new.action='set' AND new.key='audit_fts_enabled' BEGIN SELECT RAISE(ABORT,'ad4 injected'); END")
  const r = run(['--data-dir', dir, '--industry', 'cosmetic', '--disable', '--reason', 'x', '--out', path.join(dir, 'f.json')], dir)
  assert.equal(r.status, 1)
  assert.equal(reportOf(dir, path.join(dir, 'f.json')).status, 'error')
  assert.equal(ftsNames(db).length, 4, 'objects restored by the rollback')
  assert.equal(settingRow(db), undefined, 'no half-seeded setting row')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='audit_fts_enabled'").get().c, 0, 'no stray baseline')
})

// ============================================================================
// AH4（ADR-0054 补充 4）：--rebuild 分批 + 检查点 + --resume；SIGTERM / SIGINT 在批边界停止
// ============================================================================
const BASE = (dir) => ['--data-dir', dir, '--industry', 'cosmetic']
const docs = (db) => db.prepare('SELECT COUNT(*) c FROM audit_logs_fts_docsize').get().c
const stateRow = (db) => (db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(REBUILD_STATE_TABLE) ? db.prepare(`SELECT * FROM ${REBUILD_STATE_TABLE}`).get() : null)
const matchCount = (db, q) => db.prepare('SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH ?').get(`"${q}"`).c
/** 有唯一实体名的 n 行：让 MATCH 能逐行核对；绕过 fixture 的循环以便大表快速建 */
function bigFixture(t, rows) {
  const { dir, db } = fixture(t, 0)
  const ins = db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(`user${i % 7}`, i % 2 ? 'UPDATE' : 'CREATE', 'sales', `ent${i}`, String(i)) })()
  return { dir, db }
}
/** 起一个 --rebuild/--resume 子进程，在第 k 批提交之后的暂停点发信号，再放行；返回 { code, stdout, report } */
async function interrupted(dir, { mode = 'rebuild', batchRows, afterBatch, signal = 'SIGTERM', out, extra = [], whilePaused = null, inTx = false }) {
  const pdir = path.join(dir, `pause-${out}`)
  const child = spawn(process.execPath, [SCRIPT, ...BASE(dir), `--${mode}`, '--batch-rows', String(batchRows), '--out', path.join(dir, `${out}.json`), ...extra], {
    cwd: ROOT, env: { ...env(dir), GML_TEST_FTS_MAINTAIN_PAUSE: pdir, [inTx ? 'GML_TEST_FTS_REBUILD_PAUSE_IN_BATCH' : 'GML_TEST_FTS_REBUILD_PAUSE_AFTER_BATCH']: String(afterBatch) }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (d) => { stdout += d }); child.stderr.on('data', (d) => { stderr += d })
  const closed = new Promise((res) => child.on('close', (code, sig) => res({ code, sig })))
  const marker = path.join(pdir, inTx ? '.fts-rebuild-in-tx-paused' : '.fts-rebuild-batch-paused')
  for (let i = 0; i < 2400 && !existsSync(marker); i++) await sleep(25)
  assert.ok(existsSync(marker), `never reached the batch ${afterBatch} pause point: ${stdout}${stderr}`)
  if (whilePaused) await whilePaused()
  if (signal) child.kill(signal)
  if (!inTx) writeFileSync(path.join(pdir, '.fts-rebuild-batch-continue'), '1')
  const { code, sig } = await closed
  const rf = path.join(dir, `${out}.json`)
  return { code, sig, stdout, stderr, report: existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null }
}

test('AH4 --rebuild is batched: one transaction per batch, progress lines, complete index, no checkpoint left behind (50k rows)', needsFts5, (t) => {
  const { dir, db } = bigFixture(t, 50000)
  const r = run([...BASE(dir), '--rebuild', '--batch-rows', '5000', '--pause-ms', '0', '--out', path.join(dir, 'b.json')], dir)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const lines = r.stdout.split('\n').filter((l) => /^audit-fts-maintain progress /.test(l))
  assert.equal(lines.length, 10, r.stdout)
  assert.match(lines[0], /batch=1\/10 rows=5000\/50000 pct=10\.0/)
  assert.match(lines.at(-1), /batch=10\/10 rows=50000\/50000 pct=100\.0/)
  const rep = reportOf(dir, path.join(dir, 'b.json'))
  assert.equal(rep.status, 'ok'); assert.equal(rep.batches, 10); assert.equal(rep.rows_indexed, 50000); assert.equal(rep.batch_rows, 5000); assert.equal(rep.resumed, false)
  assert.ok(rep.max_batch_ms >= 0)
  assert.equal(stateRow(db), null, 'checkpoint removed together with the last batch')
  assert.equal(docs(db), 50000)
  assert.equal(matchCount(db, 'ent49999'), 1); assert.equal(matchCount(db, 'ent0'), db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE entity LIKE '%ent0%'").get().c)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 SIGTERM stops at a batch boundary with a resumable checkpoint; the partial index is not used for queries; --resume completes it and --integrity-check passes (50k rows, rows written in between)', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 50000)
  const a = await interrupted(dir, { batchRows: 5000, afterBatch: 3, out: 'a' })
  assert.equal(a.code, 3, a.stdout + a.stderr)
  assert.equal(a.report.status, 'interrupted'); assert.equal(a.report.ok, false); assert.equal(a.report.signal, 'SIGTERM')
  assert.equal(a.report.batches, 3); assert.equal(a.report.rows_indexed, 15000)
  assert.ok(!/batch=4\//.test(a.stdout), 'no batch after the signal')
  const cp = stateRow(db)
  assert.ok(cp, 'checkpoint persisted'); assert.equal(cp.last_id, 15000); assert.equal(cp.high_water, 50000); assert.equal(cp.remaining, 35000); assert.equal(cp.industry, 'cosmetic')
  assert.equal(docs(db), 15000, 'index is partial at the boundary')
  assert.equal(ftsAvailable(db), false, 'queries ignore the half-built index'); assert.equal(ftsState(db).active, false)
  const mid = run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'm.json')], dir)
  assert.equal(mid.status, 1); assert.equal(reportOf(dir, path.join(dir, 'm.json')).status, 'rebuild_in_progress')
  // 中断期间业务照常写：触发器索引新行（id 在高水位之后）
  const ins = db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,'late','LATE','sales',?,?)")
  db.transaction(() => { for (let i = 0; i < 100; i++) ins.run(`late${i}`, String(i)) })()
  const b = run([...BASE(dir), '--resume', '--batch-rows', '10000', '--pause-ms', '0', '--out', path.join(dir, 'b.json')], dir)
  assert.equal(b.status, 0, b.stderr + b.stdout)
  const rb = reportOf(dir, path.join(dir, 'b.json'))
  assert.equal(rb.status, 'ok'); assert.equal(rb.resumed, true); assert.equal(rb.rows_indexed, 35000); assert.equal(rb.batches, 4)
  assert.equal(stateRow(db), null); assert.equal(ftsAvailable(db), true)
  assert.equal(docs(db), 50100, 'every row exactly once, including the ones written while interrupted')
  assert.equal(matchCount(db, 'late99'), 1); assert.equal(matchCount(db, 'ent15000'), 1); assert.equal(matchCount(db, 'ent49999'), 1)
  const chk = run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'c.json')], dir)
  assert.equal(chk.status, 0, chk.stderr + chk.stdout); assert.equal(reportOf(dir, path.join(dir, 'c.json')).status, 'ok')
})

test('AH4 SIGINT also stops at a boundary; a second interrupt + resume still ends with a consistent index', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 4000)
  const a = await interrupted(dir, { batchRows: 500, afterBatch: 2, signal: 'SIGINT', out: 'a' })
  assert.equal(a.code, 3); assert.equal(a.report.signal, 'SIGINT'); assert.equal(stateRow(db).last_id, 1000)
  const b = await interrupted(dir, { mode: 'resume', batchRows: 500, afterBatch: 2, out: 'b' })
  assert.equal(b.code, 3, b.stdout + b.stderr); assert.equal(b.report.resumed, true); assert.equal(stateRow(db).last_id, 2000)
  const c = run([...BASE(dir), '--resume', '--pause-ms', '0', '--out', path.join(dir, 'c.json')], dir)
  assert.equal(c.status, 0, c.stderr + c.stdout)
  assert.equal(docs(db), 4000)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 refusals: --resume without a checkpoint; --rebuild over an existing checkpoint (needs --restart); bad option combinations (exit 2)', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 3000)
  const none = run([...BASE(dir), '--resume', '--out', path.join(dir, 'n.json')], dir)
  assert.equal(none.status, 1); assert.equal(reportOf(dir, path.join(dir, 'n.json')).status, 'no_checkpoint')
  assert.equal(docs(db), 3000, 'untouched')
  await interrupted(dir, { batchRows: 500, afterBatch: 2, out: 'a' })
  const again = run([...BASE(dir), '--rebuild', '--out', path.join(dir, 'r.json')], dir)
  assert.equal(again.status, 1); assert.equal(reportOf(dir, path.join(dir, 'r.json')).status, 'checkpoint_exists')
  assert.equal(stateRow(db).last_id, 1000, 'refusal leaves the checkpoint alone')
  const restart = run([...BASE(dir), '--rebuild', '--restart', '--pause-ms', '0', '--out', path.join(dir, 'rs.json')], dir)
  assert.equal(restart.status, 0, restart.stderr + restart.stdout)
  assert.equal(reportOf(dir, path.join(dir, 'rs.json')).resumed, false); assert.equal(stateRow(db), null); assert.equal(docs(db), 3000)
  for (const bad of [['--batch-rows', '0'], ['--batch-rows', 'abc'], ['--batch-rows', '1000001'], ['--pause-ms', '-1'], ['--pause-ms', '60001']]) {
    assert.equal(run([...BASE(dir), '--rebuild', ...bad], dir).status, 2, bad.join(' '))
  }
  assert.equal(run([...BASE(dir), '--optimize', '--batch-rows', '10'], dir).status, 2, '--batch-rows only with --rebuild/--resume')
  assert.equal(run([...BASE(dir), '--resume', '--restart'], dir).status, 2, '--restart is only for --rebuild')
  assert.equal(run([...BASE(dir), '--integrity-check', '--restart'], dir).status, 2)
  assert.equal(run([...BASE(dir), '--rebuild', '--resume'], dir).status, 2, 'exactly one mode')
})

test('AH4 a checkpoint copied from a different database is refused on --resume and changes nothing; --rebuild --restart clears it', needsFts5, async (t) => {
  const A = bigFixture(t, 3000)
  const B = fixture(t, 0)
  const ins = B.db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,?,?,?,?,?)')
  B.db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('other', 'DELETE', 'purchase', `zzz${i}`, String(i)) })()
  await interrupted(A.dir, { batchRows: 500, afterBatch: 2, out: 'a' })
  const ddl = A.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(REBUILD_STATE_TABLE).sql
  B.db.exec(ddl)
  const row = stateRow(A.db)
  B.db.prepare(`INSERT INTO ${REBUILD_STATE_TABLE} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row))
  const before = docs(B.db)
  const r = run([...BASE(B.dir), '--resume', '--out', path.join(B.dir, 'x.json')], B.dir)
  assert.equal(r.status, 1, r.stderr + r.stdout)
  const rep = reportOf(B.dir, path.join(B.dir, 'x.json'))
  assert.equal(rep.status, 'checkpoint_mismatch'); assert.equal(rep.rows_indexed, 0)
  assert.equal(docs(B.db), before, 'index not touched'); assert.ok(stateRow(B.db), 'checkpoint left for the operator to inspect')
  assert.equal(run([...BASE(B.dir), '--rebuild', '--restart', '--pause-ms', '0', '--out', path.join(B.dir, 'y.json')], B.dir).status, 0)
  assert.equal(stateRow(B.db), null); assert.equal(docs(B.db), 3000)
  assert.equal(run([...BASE(B.dir), '--integrity-check', '--out', path.join(B.dir, 'z.json')], B.dir).status, 0)
  // 也拒绝行业不符的检查点
  await interrupted(A.dir, { mode: 'resume', batchRows: 500, afterBatch: 1, out: 'a2' })
  A.db.prepare(`UPDATE ${REBUILD_STATE_TABLE} SET industry='food'`).run()
  const wrong = run([...BASE(A.dir), '--resume', '--out', path.join(A.dir, 'w.json')], A.dir)
  assert.equal(wrong.status, 1); assert.equal(reportOf(A.dir, path.join(A.dir, 'w.json')).status, 'checkpoint_mismatch')
})

test('AH4 rows deleted from the not-yet-indexed range while interrupted are detected at the end (status interfered, checkpoint kept); --rebuild --restart heals the index', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 3000)
  await interrupted(dir, { batchRows: 500, afterBatch: 2, out: 'a' })
  db.prepare('DELETE FROM audit_logs WHERE id IN (2500, 2501)').run() // 触发器对"尚未入索引"的行发 delete 命令：索引不再可信
  const r = run([...BASE(dir), '--resume', '--pause-ms', '0', '--out', path.join(dir, 'r.json')], dir)
  assert.equal(r.status, 1)
  const rep = reportOf(dir, path.join(dir, 'r.json'))
  assert.equal(rep.status, 'interfered'); assert.match(rep.error, /--rebuild --restart/)
  assert.ok(stateRow(db), 'checkpoint kept: the index stays out of the query path'); assert.equal(ftsAvailable(db), false)
  const fix = run([...BASE(dir), '--rebuild', '--restart', '--pause-ms', '0', '--out', path.join(dir, 'f.json')], dir)
  assert.equal(fix.status, 0, fix.stderr + fix.stdout)
  assert.equal(docs(db), 2998); assert.equal(stateRow(db), null)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 --disable then --enable discards a stale checkpoint and ends with a complete index', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 2000)
  await interrupted(dir, { batchRows: 500, afterBatch: 1, out: 'a' })
  assert.equal(run([...BASE(dir), '--disable', '--reason', 'drill', '--out', path.join(dir, 'd.json')], dir).status, 0)
  assert.equal(stateRow(db), null)
  assert.equal(run([...BASE(dir), '--enable', '--reason', 'drill over', '--out', path.join(dir, 'e.json')], dir).status, 0)
  assert.equal(docs(db), 2000); assert.equal(ftsAvailable(db), true)
  // 检查点在、索引也在时 --enable：同样收敛成完整索引并清掉检查点
  await interrupted(dir, { batchRows: 500, afterBatch: 1, out: 'b' })
  db.prepare("UPDATE settings SET value='0' WHERE key='audit_fts_enabled'").run()
  assert.equal(run([...BASE(dir), '--enable', '--reason', 'again', '--out', path.join(dir, 'e2.json')], dir).status, 0)
  assert.equal(stateRow(db), null); assert.equal(docs(db), 2000)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 an empty audit table: --rebuild finishes ok and leaves no checkpoint behind (index stays usable)', needsFts5, (t) => {
  const { dir, db } = bigFixture(t, 0)
  const r = run([...BASE(dir), '--rebuild', '--pause-ms', '0', '--out', path.join(dir, 'e.json')], dir)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(reportOf(dir, path.join(dir, 'e.json')).status, 'ok')
  assert.equal(stateRow(db), null); assert.equal(ftsAvailable(db), true)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 a missing insert trigger is repaired under the write lock (one-shot rebuild), so rows above the high-water mark cannot be silently left out', needsFts5, (t) => {
  const { dir, db } = bigFixture(t, 3000)
  db.exec('DROP TRIGGER audit_logs_fts_ai')
  const r = run([...BASE(dir), '--rebuild', '--batch-rows', '500', '--out', path.join(dir, 'r.json')], dir)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const rep = reportOf(dir, path.join(dir, 'r.json'))
  assert.deepEqual(rep.repaired_triggers, ['audit_logs_fts_ai']); assert.equal(rep.status, 'ok')
  assert.equal(ftsNames(db).length, 4, 'trigger is back')
  assert.equal(stateRow(db), null); assert.equal(docs(db), 3000)
  db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (1,'n','NEWROW','sales','newent','1')").run()
  assert.equal(matchCount(db, 'newent'), 1, 'new rows are indexed by the repaired trigger')
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 a trigger removed between batches stops the rebuild (triggers_missing, checkpoint kept); --rebuild --restart repairs and completes', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 3000)
  const a = await interrupted(dir, { batchRows: 500, afterBatch: 2, signal: null, out: 'a', whilePaused: async () => { db.exec('DROP TRIGGER audit_logs_fts_ai') } })
  assert.equal(a.code, 1, a.stdout + a.stderr); assert.equal(a.report.status, 'triggers_missing')
  assert.ok(stateRow(db)); assert.equal(ftsAvailable(db), false)
  const fix = run([...BASE(dir), '--rebuild', '--restart', '--out', path.join(dir, 'f.json')], dir)
  assert.equal(fix.status, 0, fix.stderr + fix.stdout)
  assert.equal(docs(db), 3000); assert.equal(stateRow(db), null); assert.equal(ftsNames(db).length, 4)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 SIGKILL while a batch transaction is open (rows inserted, not committed): the batch rolls back, the checkpoint still points at the last committed batch, --resume completes with every row exactly once', needsFts5, async (t) => {
  const { dir, db } = bigFixture(t, 3000)
  const k = await interrupted(dir, { batchRows: 500, afterBatch: 3, signal: 'SIGKILL', inTx: true, out: 'k' })
  assert.equal(k.sig, 'SIGKILL'); assert.equal(k.report, null, 'killed: no report written')
  const cp = stateRow(db)
  assert.ok(cp, 'checkpoint survived the kill'); assert.equal(cp.last_id, 1000, 'two batches were committed; the third was open and is gone'); assert.equal(cp.remaining, 2000)
  assert.equal(docs(db), 1000); assert.equal(matchCount(db, 'ent1000'), 0, 'rows of the uncommitted batch are not in the index'); assert.equal(matchCount(db, 'ent999'), 1)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c, 3000, 'source rows untouched')
  const r = run([...BASE(dir), '--resume', '--pause-ms', '0', '--out', path.join(dir, 'r.json')], dir)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(docs(db), 3000); assert.equal(stateRow(db), null)
  assert.equal(matchCount(db, 'ent1000'), 1); assert.equal(matchCount(db, 'ent2999'), 1)
  assert.equal(run([...BASE(dir), '--integrity-check', '--out', path.join(dir, 'i.json')], dir).status, 0)
})

test('AH4 a query plan that chose FTS before a rebuild began never answers from the emptied index: the result is discarded and re-run on LIKE (same rows, counter +1)', needsFts5, (t) => {
  resetCounters()
  const { dir, db } = bigFixture(t, 3000)
  const other = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => other.close())
  assert.equal(keywordUsesFts(db, 'ent1234'), true)
  const plan = auditQueryPlan(db, parseFilters({ keyword: 'ent1234' }))
  assert.match(plan.where, /audit_logs_fts/)
  let calls = 0
  const rows = plan.run(({ where, args }) => {
    calls++
    const st = db.prepare(`SELECT id FROM audit_logs ${where} ORDER BY id DESC`)
    if (calls === 1) { // 另一个进程此刻开始分批重建：同一事务里清空索引 + 建检查点
      other.exec('BEGIN IMMEDIATE')
      other.exec("INSERT INTO audit_logs_fts(audit_logs_fts) VALUES ('delete-all')")
      other.exec(REBUILD_STATE_DDL)
      other.prepare(`INSERT INTO ${REBUILD_STATE_TABLE} VALUES (1,'cosmetic','x',3000,0,3000,3000,500,0,'t','t')`).run()
      other.exec('COMMIT')
    }
    return st.all(...args)
  })
  assert.equal(calls, 2, 'the emptied-index answer was discarded and re-run once')
  assert.deepEqual(rows.map((r) => r.id), [1235]); assert.doesNotMatch(plan.where, /audit_logs_fts/)
  assert.equal(counterSnapshot().audit_fts_fallback_total.query, 1)
  // 检查点已在 → 之后的计划一开始就不选 FTS
  assert.equal(keywordUsesFts(db, 'ent1234'), false)
})
