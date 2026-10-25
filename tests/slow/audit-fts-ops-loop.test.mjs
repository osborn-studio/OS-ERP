// slow: 103 s: end-to-end operator loop on a real server with restarts and FTS backfill (scripts/test-timings.mjs, threshold 60 s)
/**
 * ============================================================================
 * 文件标识：tests/audit-fts-ops-loop.test.mjs ｜ AE4 审计 FTS 运维闭环：真实服务进程上 disable → LIKE 检索 → 重启不重建 → enable（回填）→ FTS 路径（ADR-0054 补充）
 * 只在新临时数据目录与随机 loopback 端口运行；服务与维护脚本都是真实子进程；合成凭据不输出。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { ftsAvailable, keywordUsesFts } from '../../server/lib/audit-view.js'
import * as m067 from '../../server/db/migrations/067_audit_fts.cjs'
import { CASE_TIMEOUT_FAST_MS, CASE_TIMEOUT_MEDIUM_MS, FETCH_TIMEOUT_MS, READY_POLL_ATTEMPTS, READY_POLL_INTERVAL_MS, SPAWN_TIMEOUT_SHORT_MS } from '../lib/lib/load-tolerance.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NO_FTS5 = !m067.ftsSupported(new Database(':memory:'))
const SCRIPT = 'scripts/audit-fts-maintain.mjs'

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 一个数据目录，可反复启停真实服务进程（每次启动换一个随机端口） */
function instance(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-ae4-'))
  const secret = randomBytes(32).toString('hex')
  const state = { dir, child: null, port: 0, stopped: null, dbs: [] }
  state.open = () => { const db = new Database(path.join(dir, 'gml_cosmetic.db')); state.dbs.push(db); return db }
  const env = (port) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: secret })
  state.start = async () => {
    state.port = await freePort()
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: env(state.port), stdio: ['ignore', 'pipe', 'pipe'] })
    let ready = false
    child.stdout.on('data', (d) => { ready ||= d.toString().includes('服务已启动') })
    child.stderr.on('data', () => {})
    state.child = child
    state.stopped = once(child, 'close')
    for (let i = 0; i < READY_POLL_ATTEMPTS && !ready && child.exitCode === null; i++) await delay(READY_POLL_INTERVAL_MS)
    assert.ok(ready, 'server must start')
  }
  state.stop = async () => {
    const c = state.child
    if (!c) return
    if (c.exitCode === null) c.kill('SIGTERM')
    await state.stopped
    state.child = null
  }
  // 一个有序的清理：先停服务并等它退出，再关库连接，最后删目录（t.after 按注册顺序执行，分开注册会先删目录）
  t.after(async () => { await state.stop(); for (const d of state.dbs) { try { d.close() } catch { /* 已关闭 */ } } rmSync(dir, { recursive: true, force: true }) })
  state.get = async (route, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${state.port}${route}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return { status: res.status, body: await res.json() }
  }
  state.login = async (db) => {
    const password = randomBytes(24).toString('hex')
    db.prepare('INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,?,?)').run('ae4_admin', bcrypt.hashSync(password, 10), 'ae4_admin', 'admin', 1)
    const res = await fetch(`http://127.0.0.1:${state.port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ae4_admin', password, industry: 'cosmetic' })
    })
    const body = await res.json()
    assert.equal(res.status, 200, body.message)
    return { authorization: `Bearer ${body.data.token}` }
  }
  state.script = (action, reason = 'AE4 loop test') => {
    const out = path.join(dir, `r-${action}-${Date.now()}.json`)
    const args = [SCRIPT, '--data-dir', dir, '--industry', 'cosmetic', `--${action}`, '--out', out, ...(reason ? ['--reason', reason] : [])]
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: secret }, encoding: 'utf8', timeout: CASE_TIMEOUT_FAST_MS })
    let report = null
    try { report = JSON.parse(readFileSync(out, 'utf8')) } catch { /* 参数错误时没有报告 */ }
    return { status: r.status, stderr: r.stderr, report }
  }
  return state
}

const ins = (db, r) => db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(1, r.user ?? 'alice', r.action ?? 'CREATE', 'sales', r.entity ?? 'order', '1', null, '10.0.0.1', '2026-10-01 10:00:00')
const objects = (db) => db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'audit_logs_fts%' ORDER BY name").all().map((r) => r.name)
const setting = (db) => db.prepare("SELECT value FROM settings WHERE key='audit_fts_enabled'").get()?.value ?? null
const total = async (inst, admin, kw) => (await inst.get(`/api/meta/audit-logs?keyword=${encodeURIComponent(kw)}`, admin)).body.data.total

test('AE4 operator loop on a real server: disable -> LIKE answers -> restart keeps it off -> enable backfills -> FTS path again', { timeout: CASE_TIMEOUT_MEDIUM_MS, skip: NO_FTS5 ? 'this SQLite build has no FTS5' : false }, async (t) => {
  const inst = instance(t)
  await inst.start()
  const db = inst.open()
  const admin = await inst.login(db)
  db.exec('DELETE FROM audit_logs')
  for (let i = 0; i < 30; i++) ins(db, { user: `user${i % 5}`, action: 'CREATE', entity: `ent${i % 3}` })
  ins(db, { user: 'alice', action: 'RAREWORDONE' })
  assert.equal(ftsAvailable(db), true, 'fresh server migrated to 067')
  assert.equal(keywordUsesFts(db, 'RAREWORDONE'), true, 'rare 3+ char keyword uses the FTS path')
  assert.equal(await total(inst, admin, 'RAREWORDONE'), 1)

  // 1. 运维在服务运行期间关闭索引（同事务：删对象 + 写设置）
  const off = inst.script('disable')
  assert.equal(off.status, 0, off.stderr)
  assert.equal(off.report.status, 'ok'); assert.equal(off.report.setting_after, '0'); assert.equal(off.report.changed_objects, true)
  assert.deepEqual(objects(db), [], 'table and three triggers are gone')
  assert.equal(setting(db), '0')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='audit_fts_enabled'").get().c >= 1, true, 'the change is audited')
  assert.equal(keywordUsesFts(db, 'RAREWORDONE'), false)
  assert.equal(await total(inst, admin, 'RAREWORDONE'), 1, 'LIKE path still finds pre-disable rows (running server, no restart)')
  assert.equal(await total(inst, admin, 'alice'), 1)
  const repeat = inst.script('disable')
  assert.equal(repeat.status, 0); assert.equal(repeat.report.changed_objects, false); assert.equal(repeat.report.setting_changed, false, 'idempotent')

  // 2. 关闭期间的写入照常，并被 LIKE 找到
  ins(db, { user: 'bob', action: 'RAREWORDTWO' })
  assert.equal(await total(inst, admin, 'RAREWORDTWO'), 1)
  assert.deepEqual(objects(db), [], 'writes do not recreate the index')

  // 3. 重启：设置为关时不会自愈重建
  await inst.stop()
  await inst.start()
  const admin2 = admin // 同一个 JWT 密钥，令牌在重启后仍有效
  assert.deepEqual(objects(db), [], 'restart with the setting off does not rebuild the index')
  assert.equal(await total(inst, admin2, 'RAREWORDTWO'), 1)
  const integrityOff = inst.script('integrity-check', null)
  assert.equal(integrityOff.status, 0); assert.equal(integrityOff.report.status, 'absent')

  // 4. 重新开启：建表 + 触发器 + 回填关闭期间写入的行
  const on = inst.script('enable')
  assert.equal(on.status, 0, on.stderr)
  assert.equal(on.report.status, 'ok'); assert.equal(on.report.setting_after, '1'); assert.equal(on.report.changed_objects, true)
  assert.equal(objects(db).includes('audit_logs_fts'), true)
  assert.equal(objects(db).filter((n) => n.endsWith('_ai') || n.endsWith('_ad') || n.endsWith('_au')).length, 3)
  const n = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_logs_fts').get().c, n, 'every audit row, including those written while off, is indexed')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH '\"RAREWORDTWO\"'").get().c, 1)
  assert.equal(keywordUsesFts(db, 'RAREWORDTWO'), true, 'FTS path is back for a row backfilled by --enable')
  assert.equal(await total(inst, admin2, 'RAREWORDTWO'), 1)
  assert.equal(await total(inst, admin2, 'RAREWORDONE'), 1)
  const check = inst.script('integrity-check', null)
  assert.equal(check.status, 0, check.stderr); assert.equal(check.report.status, 'ok')

  // 5. 开启后的新写入由触发器维护；再重启仍然是开
  ins(db, { user: 'carol', action: 'RAREWORDTHREE' })
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH '\"RAREWORDTHREE\"'").get().c, 1)
  await inst.stop()
  await inst.start()
  assert.equal(objects(db).includes('audit_logs_fts'), true)
  assert.equal(setting(db), '1')
  assert.deepEqual(readdirSync(inst.dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind')
})

test('AE4 --disable / --enable refuse to run without --reason (nothing changes) and --enable on a no-FTS5 build reports unsupported', { timeout: CASE_TIMEOUT_FAST_MS }, async (t) => {
  const inst = instance(t)
  await inst.start()
  await inst.stop()
  const db = inst.open()
  const before = { objs: objects(db), set: setting(db) }
  for (const a of ['disable', 'enable']) {
    const r = inst.script(a, null)
    assert.equal(r.status, 2, `${a} without a reason is a usage error`)
  }
  assert.deepEqual({ objs: objects(db), set: setting(db) }, before)
  if (NO_FTS5) {
    const r = inst.script('enable')
    assert.equal(r.status, 1); assert.equal(r.report.status, 'unsupported'); assert.equal(setting(db), before.set)
  }
})

test('AE4 --enable while another connection holds the write lock: busy, the index stays absent, the setting stays off, and a retry after the lock is released backfills', { timeout: CASE_TIMEOUT_FAST_MS, skip: NO_FTS5 ? 'this SQLite build has no FTS5' : false }, async (t) => {
  const inst = instance(t)
  await inst.start()
  await inst.stop()
  const db = inst.open()
  for (let i = 0; i < 20; i++) ins(db, { user: `u${i}`, action: 'CREATE' })
  assert.equal(inst.script('disable').status, 0)
  ins(db, { user: 'late', action: 'LATEWORD' })
  db.exec('BEGIN IMMEDIATE') // 模拟另一个写入者（例如服务进程）持写锁
  const args = ['--data-dir', inst.dir, '--industry', 'cosmetic', '--enable', '--reason', 'x', '--busy-ms', '200', '--out', path.join(inst.dir, 'busy.json')]
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: inst.dir, TMPDIR: inst.dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: 'a'.repeat(48) }, encoding: 'utf8', timeout: SPAWN_TIMEOUT_SHORT_MS })
  db.exec('ROLLBACK')
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(readFileSync(path.join(inst.dir, 'busy.json'), 'utf8')).status, 'busy')
  assert.deepEqual(objects(db), []); assert.equal(setting(db), '0')
  const retry = inst.script('enable')
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs_fts WHERE audit_logs_fts MATCH '\"LATEWORD\"'").get().c, 1, 'row written while off is backfilled')
  assert.equal(setting(db), '1')
})
