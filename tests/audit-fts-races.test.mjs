/**
 * ============================================================================
 * 文件标识：tests/audit-fts-races.test.mjs ｜ AF4 审计 FTS 开关的两个竞态窗口：在途请求的 LIKE 重试、启动自愈与维护脚本的重叠（ADR-0054 补充 2）
 * 只在新临时数据目录与随机 loopback 端口运行；服务与维护脚本都是真实子进程；暂停钩子只在 GML_RUNTIME_MODE=test 生效；合成凭据不输出。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { auditQueryPlan, ftsAvailable, keywordUsesFts, isFtsMissingError, parseFilters, exportChunks, orderOf } from '../server/lib/audit-view.js'
import { counterSnapshot, resetCounters } from '../server/lib/process-counters.js'
import { runMigrations } from '../server/db/migrations/runner.js'
import * as m067 from '../server/db/migrations/067_audit_fts.cjs'
import m071 from '../server/db/migrations/071_audit_fts_optional.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const NO_FTS5 = !m067.ftsSupported(new Database(':memory:'))
const needsFts = NO_FTS5 ? { skip: 'this SQLite build has no FTS5' } : process.env.GML_AUDIT_FTS === '0' ? { skip: 'GML_AUDIT_FTS=0: the FTS path is never planned' } : {}
const SCRIPT = 'scripts/audit-fts-maintain.mjs'

const ins = (db, r) => db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(1, r.user ?? 'alice', r.action ?? 'CREATE', 'sales', r.entity ?? 'order', '1', null, '10.0.0.1', '2026-10-01 10:00:00')
const objects = (db) => db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'audit_logs_fts%' ORDER BY name").all().map((r) => r.name)
const setting = (db) => db.prepare("SELECT value FROM settings WHERE key='audit_fts_enabled'").get()?.value ?? null
const fallbackCount = (reason) => counterSnapshot().audit_fts_fallback_total[reason]

function tmpDb(t, rows = 12) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-af4-'))
  const file = path.join(dir, 'gml_cosmetic.db')
  const db = new Database(file)
  const other = new Database(file)
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db, { mode: 'test', warn: () => {} })
  for (let i = 0; i < rows; i++) ins(db, { user: `user${i % 3}`, action: i === 5 ? 'RAREWORDONE' : 'CREATE' })
  t.after(() => { db.close(); other.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, other }
}

test('AF4 isFtsMissingError: only a SQLITE_ERROR naming audit_logs_fts counts', () => {
  assert.equal(isFtsMissingError(Object.assign(new Error('no such table: audit_logs_fts'), { code: 'SQLITE_ERROR' })), true)
  assert.equal(isFtsMissingError(Object.assign(new Error('no such table: main.audit_logs_fts'), { code: 'SQLITE_ERROR' })), true)
  assert.equal(isFtsMissingError(Object.assign(new Error('no such table: audit_logs'), { code: 'SQLITE_ERROR' })), false)
  assert.equal(isFtsMissingError(Object.assign(new Error('no such table: audit_logs_fts'), { code: 'SQLITE_BUSY' })), false)
  assert.equal(isFtsMissingError(null), false)
  assert.equal(isFtsMissingError(new Error('no such table: audit_logs_fts')), false, 'plain Error without the sqlite code is not ours')
})

test('AF4 query plan: table dropped between prepare and execute -> exactly one LIKE re-run, same rows, counter +1', needsFts, (t) => {
  resetCounters()
  const { db, other } = tmpDb(t)
  assert.equal(keywordUsesFts(db, 'RAREWORDONE'), true)
  const filters = parseFilters({ keyword: 'RAREWORDONE' })
  const plan = auditQueryPlan(db, filters)
  assert.match(plan.where, /audit_logs_fts/, 'planned on the FTS path')
  let calls = 0
  const rows = plan.run(({ where, args }) => {
    calls++
    const st = db.prepare(`SELECT id FROM audit_logs ${where} ORDER BY id DESC`) // 准备好之后……
    if (calls === 1) m071.dropFts(other) // ……另一个连接（维护脚本的位置）删掉索引
    return st.all(...args)
  })
  assert.equal(calls, 2, 'one retry, no more')
  assert.equal(rows.length, 1)
  assert.doesNotMatch(plan.where, /audit_logs_fts/, 'plan switched to LIKE for the rest of the request')
  assert.equal(fallbackCount('query'), 1)
  assert.equal(objects(db).length, 0)
})

test('AF4 query plan: LIKE-only plans, other errors and a second failure are never retried or swallowed', (t) => {
  resetCounters()
  const { db } = tmpDb(t)
  const likePlan = auditQueryPlan(db, parseFilters({ keyword: 'ab' }))
  let calls = 0
  assert.throws(() => likePlan.run(() => { calls++; throw Object.assign(new Error('no such table: audit_logs_fts'), { code: 'SQLITE_ERROR' }) }), /audit_logs_fts/)
  assert.equal(calls, 1, 'a plan that never used FTS does not retry')
  const plan = auditQueryPlan(db, parseFilters({ module: 'sales' }))
  calls = 0
  assert.throws(() => plan.run(() => { calls++; throw new Error('boom') }), /boom/)
  assert.equal(calls, 1)
  assert.equal(fallbackCount('query'), 0)
})

test('AF4 query plan: when the retry fails too, the error surfaces after exactly one retry', needsFts, (t) => {
  resetCounters()
  const { db } = tmpDb(t)
  const plan = auditQueryPlan(db, parseFilters({ keyword: 'RAREWORDONE' }))
  let calls = 0
  assert.throws(() => plan.run(() => { calls++; throw Object.assign(new Error('no such table: audit_logs_fts'), { code: 'SQLITE_ERROR' }) }), /audit_logs_fts/)
  assert.equal(calls, 2)
  assert.equal(fallbackCount('query'), 1)
})

test('AF4 export: the index vanishing between batches continues from the cursor via LIKE, every row exactly once', needsFts, (t) => {
  resetCounters()
  const { db, other } = tmpDb(t, 40)
  for (let i = 0; i < 6; i++) ins(db, { user: 'carol', action: 'RAREWORDTWO' }) // 命中稀少 → FTS 路径
  const filters = parseFilters({ keyword: 'RAREWORDTWO' })
  const plan = auditQueryPlan(db, filters)
  assert.match(plan.where, /audit_logs_fts/)
  const snapshotMax = db.prepare('SELECT MAX(id) m FROM audit_logs').get().m
  const seen = []
  let batches = 0
  for (const chunk of exportChunks(db, { plan, order: orderOf(filters), snapshotMax, exported: 6, batch: 2 })) {
    batches++
    if (batches === 1) m071.dropFts(other) // 第一批之后索引被删
    for (const line of chunk.split('\r\n').filter(Boolean)) seen.push(Number(line.split(',')[0].replace(/"/g, '')))
  }
  assert.equal(seen.length, 6)
  assert.equal(new Set(seen).size, 6, 'no duplicates')
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a), 'newest first, same order as before the switch')
  assert.equal(fallbackCount('export_batch'), 1)
})

// ---------- 真实服务进程 + 真实维护脚本：暂停钩子（仅 test 模式）----------

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function instance(t, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-af4s-'))
  const secret = randomBytes(32).toString('hex')
  const state = { dir, child: null, port: 0, stopped: null, dbs: [], out: '', metricsToken: randomBytes(24).toString('hex') }
  state.open = () => { const db = new Database(path.join(dir, 'gml_cosmetic.db')); state.dbs.push(db); return db }
  const env = (port, more) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: secret, GML_METRICS_TOKEN: state.metricsToken, ...extra, ...more })
  state.spawn = async (more = {}, { waitReady = true } = {}) => {
    state.port = await freePort()
    state.out = ''
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: env(state.port, more), stdio: ['ignore', 'pipe', 'pipe'] })
    let ready = false
    child.stdout.on('data', (d) => { state.out += d; ready ||= d.toString().includes('服务已启动') })
    child.stderr.on('data', (d) => { state.out += d })
    state.child = child
    state.stopped = once(child, 'close')
    if (waitReady) {
      for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
      assert.ok(ready, `server must start\n${state.out.slice(-800)}`)
    }
  }
  state.stop = async () => {
    const c = state.child
    if (!c) return
    if (c.exitCode === null) c.kill('SIGTERM')
    await state.stopped
    state.child = null
  }
  t.after(async () => { await state.stop(); for (const d of state.dbs) { try { d.close() } catch { /* 已关闭 */ } } rmSync(dir, { recursive: true, force: true }) })
  state.login = async (db) => {
    const password = randomBytes(24).toString('hex')
    db.prepare('INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,?,?)').run('af4_admin', bcrypt.hashSync(password, 10), 'af4_admin', 'admin', 1)
    const res = await fetch(`http://127.0.0.1:${state.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'af4_admin', password, industry: 'cosmetic' }) })
    const body = await res.json()
    assert.equal(res.status, 200, body.message)
    return { authorization: `Bearer ${body.data.token}` }
  }
  state.scriptEnv = (more = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: secret, ...more })
  state.scriptArgs = (action, tag, reason = 'AF4 race test') => {
    const out = path.join(dir, `r-${action}-${tag}.json`)
    return { out, args: [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', `--${action}`, '--out', out, '--reason', reason] }
  }
  state.script = (action, tag = String(Date.now())) => {
    const { out, args } = state.scriptArgs(action, tag)
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env: state.scriptEnv(), encoding: 'utf8', timeout: 120000 })
    let report = null
    try { report = JSON.parse(readFileSync(out, 'utf8')) } catch { /* 参数错误时没有报告 */ }
    return { status: r.status, stderr: r.stderr, report }
  }
  return state
}

async function waitFile(file, child, ms = 60000) {
  for (let i = 0; i < ms / 25 && !existsSync(file); i++) {
    if (child && child.exitCode !== null) throw new Error(`process exited before ${file}`)
    await delay(25)
  }
  assert.ok(existsSync(file), `timed out waiting for ${file}`)
}

test('AF4 pause hooks are refused outside GML_RUNTIME_MODE=test', needsFts, (t) => {
  const { dir } = tmpDb(t)
  const inst = instance(t)
  const env = inst.scriptEnv({ GML_RUNTIME_MODE: 'demo', GML_TEST_FTS_MAINTAIN_PAUSE: path.join(dir, 'pause') })
  const r = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', '--enable', '--reason', 'x', '--out', path.join(dir, 'r.json')], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stdout}${r.stderr}`, /PAUSE_HOOK_FORBIDDEN/)
  assert.equal(existsSync(path.join(dir, 'pause')), false, 'nothing was written')
})

test('AF4 in-flight request: --disable lands between "choose FTS" and "execute" -> 200 via LIKE, counter moves, identical rows (list and export)', { timeout: 180000, ...needsFts }, async (t) => {
  const inst = instance(t)
  const pauseDir = path.join(inst.dir, 'pause')
  await inst.spawn()
  const db = inst.open()
  const admin = await inst.login(db)
  for (let i = 0; i < 20; i++) ins(db, { user: `user${i % 4}` })
  ins(db, { user: 'alice', action: 'RAREWORDONE' })
  assert.equal(keywordUsesFts(db, 'RAREWORDONE'), true)
  const base = `http://127.0.0.1:${inst.port}`
  const baseline = await (await fetch(`${base}/api/meta/audit-logs?keyword=RAREWORDONE`, { headers: admin })).json()
  assert.equal(baseline.data?.total, 1, JSON.stringify(baseline).slice(0, 300))
  await inst.stop()
  await inst.spawn({ GML_TEST_AUDIT_FTS_PAUSE: pauseDir })
  const base2 = `http://127.0.0.1:${inst.port}`
  const metrics = async () => (await (await fetch(`${base2}/api/meta/metrics?format=prometheus`, { headers: { authorization: `Bearer ${inst.metricsToken}` } })).text())

  for (const [route, label] of [['/api/meta/audit-logs?keyword=RAREWORDONE', 'list'], ['/api/meta/audit-logs/export.csv?keyword=RAREWORDONE', 'export']]) {
    if (label === 'export') { // 重新开启，再对导出演练一遍
      const on = inst.script('enable', 'again')
      assert.equal(on.status, 0, on.stderr)
      rmSync(path.join(pauseDir, '.audit-fts-paused'), { force: true })
      rmSync(path.join(pauseDir, '.audit-fts-continue'), { force: true })
    }
    const pending = fetch(`${base2}${route}`, { headers: admin, signal: AbortSignal.timeout(60000) })
    await waitFile(path.join(pauseDir, '.audit-fts-paused'), inst.child)
    const off = inst.script('disable', `race-${label}`) // 请求已选定 FTS 路径、尚未执行；真实脚本此刻提交
    assert.equal(off.status, 0, off.stderr)
    assert.deepEqual(objects(db), [], 'index gone while the request is in flight')
    writeFileSync(path.join(pauseDir, '.audit-fts-continue'), '1')
    const res = await pending
    assert.equal(res.status, 200, `${label} must not 500`)
    const text = await res.text()
    if (label === 'list') assert.equal(JSON.parse(text).data.total, 1)
    else assert.match(text, /RAREWORDONE/)
  }
  const m = await metrics()
  assert.match(m, /os_erp_audit_fts_fallback_total\{reason="query"\} 2/)
})

test('AF4 overlap: server healing decided on a stale read; --enable commits first -> the server re-reads under the write lock and does nothing', { timeout: 180000, ...needsFts }, async (t) => {
  const inst = instance(t)
  await inst.spawn()
  const db = inst.open()
  for (let i = 0; i < 25; i++) ins(db, { user: `user${i % 4}` })
  await inst.stop()
  m071.dropFts(db) // 设置仍为开、对象缺失：下次启动要自愈
  assert.notEqual(setting(db), '0', 'setting is on (or default) while the objects are missing')
  const pauseDir = path.join(inst.dir, 'pause')
  await inst.spawn({ GML_TEST_MIGRATE_HEAL_PAUSE: pauseDir }, { waitReady: false })
  await waitFile(path.join(pauseDir, '.migrate-heal-paused'), inst.child) // 启动已判定要自愈，尚未取写锁
  const on = inst.script('enable', 'overlap')
  assert.equal(on.status, 0, on.stderr)
  assert.equal(on.report.status, 'ok')
  assert.equal(objects(db).includes('audit_logs_fts'), true)
  writeFileSync(path.join(pauseDir, '.migrate-heal-continue'), '1')
  for (let i = 0; i < 1200 && !inst.out.includes('服务已启动') && inst.child.exitCode === null; i++) await delay(50)
  assert.match(inst.out, /服务已启动/, `server starts despite the overlap\n${inst.out.slice(-600)}`)
  assert.doesNotMatch(inst.out, /heal 071/, 'the loser saw the converged state and healed nothing')
  assert.doesNotMatch(inst.out, /BUSY/)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs_fts').get().c, db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c)
})

test('AF4 overlap: server healing decided on a stale read; --disable commits first -> the server must not undo it', { timeout: 180000, ...needsFts }, async (t) => {
  const inst = instance(t)
  await inst.spawn()
  const db = inst.open()
  for (let i = 0; i < 10; i++) ins(db, { user: `user${i % 4}` })
  await inst.stop()
  m071.dropFts(db) // 设置为开 + 缺对象
  const pauseDir = path.join(inst.dir, 'pause')
  await inst.spawn({ GML_TEST_MIGRATE_HEAL_PAUSE: pauseDir }, { waitReady: false })
  await waitFile(path.join(pauseDir, '.migrate-heal-paused'), inst.child)
  const off = inst.script('disable', 'overlap-off')
  assert.equal(off.status, 0, off.stderr)
  assert.equal(setting(db), '0')
  writeFileSync(path.join(pauseDir, '.migrate-heal-continue'), '1')
  for (let i = 0; i < 1200 && !inst.out.includes('服务已启动') && inst.child.exitCode === null; i++) await delay(50)
  assert.match(inst.out, /服务已启动/)
  assert.deepEqual(objects(db), [], 'healing honoured the newer decision: FTS stays off')
  assert.equal(setting(db), '0')
})

test('AF4 two maintenance runs: the loser of an --enable overlap re-reads under BEGIN IMMEDIATE and reports already_in_state', { timeout: 180000, ...needsFts }, async (t) => {
  const inst = instance(t)
  await inst.spawn()
  const db = inst.open()
  for (let i = 0; i < 15; i++) ins(db, { user: `user${i % 4}` })
  await inst.stop()
  const off = inst.script('disable', 'pre')
  assert.equal(off.status, 0, off.stderr)
  const pauseDir = path.join(inst.dir, 'pause')
  const a = inst.scriptArgs('enable', 'A')
  const child = spawn(process.execPath, a.args, { cwd: ROOT, env: inst.scriptEnv({ GML_TEST_FTS_MAINTAIN_PAUSE: pauseDir }), stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  await waitFile(path.join(pauseDir, '.fts-maintain-paused'), child) // A 已读到"当前是关"，尚未开事务
  const b = inst.script('enable', 'B')
  assert.equal(b.status, 0, b.stderr)
  assert.equal(b.report.changed_objects, true)
  writeFileSync(path.join(pauseDir, '.fts-maintain-continue'), '1')
  const [code] = await closed
  assert.equal(code, 0)
  const reportA = JSON.parse(readFileSync(a.out, 'utf8'))
  assert.equal(reportA.status, 'ok')
  assert.equal(reportA.already_in_state, true, 'A re-read the state inside the write lock and did nothing')
  assert.equal(reportA.changed_objects, false)
  assert.equal(reportA.setting_changed, false)
  assert.equal(setting(db), '1')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs_fts').get().c, db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='audit_fts_enabled' AND value_after='1'").get().c >= 1, true)
})
