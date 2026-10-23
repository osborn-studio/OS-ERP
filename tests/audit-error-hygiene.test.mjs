/**
 * ============================================================================
 * 文件标识：tests/audit-error-hygiene.test.mjs ｜ F13 审计与错误卫生：URL 凭据拒绝、5xx 脱敏、审计明细脱敏、严格审计回滚
 * 只在新临时数据目录与随机 loopback 端口运行；合成凭据不输出。见 ADR-0010。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { redactValue, redactUrl, MASK } from '../server/lib/redact.js'
import { insertAuditRow, auditStrictRow } from '../server/lib/audit-trail.js'
import { bizFail } from '../server/lib/http.js'
import { errorHandler } from '../server/middleware/audit.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const INCIDENT = /^[0-9a-f]{16}$/

/** 隔离服务：临时数据目录 + 随机 loopback 端口；stderr 收进内存供断言（事件号必须落在服务端日志里）。 */
async function server(t, mode = 'production') {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-hygiene-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
    GML_RUNTIME_MODE: mode, GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  let stderr = ''
  child.stdout.on('data', data => { ready ||= data.toString().includes('服务已启动') })
  child.stderr.on('data', data => { stderr += data.toString() })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, `server must start in ${mode} mode`)
  const request = async (route, method = 'GET', body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  // 手工夹具：不使用任何生产灌数命令。
  const password = randomBytes(24).toString('hex')
  db.prepare("INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,'admin',1)")
    .run('hygiene_admin', bcrypt.hashSync(password, 10), 'Hygiene administrator')
  const login = await request('/api/auth/login', 'POST', { username: 'hygiene_admin', password, industry: 'cosmetic' })
  assert.equal(login.status, 200, login.body.message)
  const token = login.body.data.token
  const auth = { authorization: `Bearer ${token}` }
  return { request, db, token, auth, stderr: () => stderr }
}

function fakeRes() {
  return { statusCode: 0, body: null, status(s) { this.statusCode = s; return this }, json(b) { this.body = b; return this } }
}
function captureErrors(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => { lines.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ')) }
  try { return { result: fn(), lines } } finally { console.error = original }
}
function withMode(mode, fn) {
  const previous = process.env.GML_RUNTIME_MODE
  process.env.GML_RUNTIME_MODE = mode
  try { return fn() } finally {
    if (previous === undefined) delete process.env.GML_RUNTIME_MODE
    else process.env.GML_RUNTIME_MODE = previous
  }
}
function memoryAuditDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
    module TEXT, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`)
  return db
}

// ---------------------------------------------------------------------------
// 1. 凭据只从受控头取
// ---------------------------------------------------------------------------
test('H01 query-string JWT is rejected with 401 while the Authorization header works', { timeout: 90000 }, async t => {
  const f = await server(t)
  assert.equal((await f.request('/api/auth/me', 'GET', undefined, f.auth)).status, 200)
  const viaQuery = await f.request(`/api/auth/me?token=${encodeURIComponent(f.token)}`)
  assert.equal(viaQuery.status, 401)
  assert.equal(viaQuery.body.success, false)
  // 同一个令牌放在头里仍然有效：被拒的是“放在 URL 里”这件事，不是令牌本身
  assert.equal((await f.request(`/api/auth/me?token=${encodeURIComponent(f.token)}`, 'GET', undefined, f.auth)).status, 200)
  assert.equal((await f.request(`/api/auth/users?token=${encodeURIComponent(f.token)}`)).status, 401)
})

// ---------------------------------------------------------------------------
// 2. 脱敏助手
// ---------------------------------------------------------------------------
test('H02 redact helper masks credential keys deeply and strips token-like query values', () => {
  const input = {
    username: 'alice', password: 'p@ss', Authorization: 'Bearer abc', nested: { api_token: 'tok', jwt: 'j', cookie: 'c', secretKey: 's', keep: 'v' },
    list: [{ secret: 's1' }, 'token=abc&x=1'], phone: '13812345678', empty: '', nothing: null, n: 7
  }
  const out = redactValue(input)
  assert.equal(out.username, 'alice')
  assert.equal(out.password, MASK)
  assert.equal(out.Authorization, MASK)
  assert.deepEqual(out.nested, { api_token: MASK, jwt: MASK, cookie: MASK, secretKey: MASK, keep: 'v' })
  assert.deepEqual(out.list, [{ secret: MASK }, `token=${MASK}&x=1`])
  assert.equal(out.phone, '138****5678')
  assert.equal(out.empty, '')
  assert.equal(out.nothing, null)
  assert.equal(out.n, 7)
  assert.deepEqual(input.nested, { api_token: 'tok', jwt: 'j', cookie: 'c', secretKey: 's', keep: 'v' }, 'input must not be mutated')
  const circular = { a: 1 }
  circular.self = circular
  assert.doesNotThrow(() => JSON.stringify(redactValue(circular)))
  assert.equal(redactUrl('/api/x?token=abc&access_token=def&page=2&api_key=k#f'), `/api/x?token=${MASK}&access_token=${MASK}&page=2&api_key=${MASK}#f`)
  assert.equal(redactUrl('/api/x?page=2'), '/api/x?page=2')
  assert.equal(redactUrl('/api/x'), '/api/x')
})

// ---------------------------------------------------------------------------
// 3. 5xx 响应：生产隐藏内部信息并给事件号；demo/test 保留明细
// ---------------------------------------------------------------------------
test('H03 bizFail/errorHandler hide internals for uncoded 5xx in production, keep them in demo/test, and log by incident id', () => {
  const internal = () => Object.assign(new Error('SQLITE_ERROR: no such table: secret_ledger'), { detail: { sql: 'SELECT 1', password: 'leak' } })
  const req = { method: 'GET', originalUrl: '/api/report?token=abc123&page=1' }

  const prod = withMode('production', () => captureErrors(() => { const r = fakeRes(); errorHandler(internal(), req, r, () => {}); return r }))
  assert.equal(prod.result.statusCode, 500)
  assert.equal(prod.result.body.code, 500)
  assert.equal(prod.result.body.success, false)
  assert.match(prod.result.body.incident_id, INCIDENT)
  assert.ok(!prod.result.body.message.includes('no such table'), 'production message must not echo internals')
  assert.ok(prod.result.body.message.includes(prod.result.body.incident_id), 'production message carries the incident id')
  assert.equal(prod.result.body.detail, undefined)
  assert.ok(!Object.hasOwn(prod.result.body, 'error'))
  const log = prod.lines.join('\n')
  assert.ok(log.includes(prod.result.body.incident_id), 'server log keyed by incident id')
  assert.ok(log.includes('no such table: secret_ledger'), 'server log keeps the full error')
  assert.ok(log.includes(`token=${MASK}`) && !log.includes('abc123'), 'logged URL is redacted')

  for (const mode of ['demo', 'test']) {
    const dev = withMode(mode, () => captureErrors(() => { const r = fakeRes(); errorHandler(internal(), req, r, () => {}); return r }))
    assert.equal(dev.result.statusCode, 500)
    assert.equal(dev.result.body.message, 'SQLITE_ERROR: no such table: secret_ledger')
    assert.match(dev.result.body.incident_id, INCIDENT)
    assert.deepEqual(dev.result.body.detail, { sql: 'SELECT 1', password: MASK }, `${mode}: detail kept but redacted`)
    assert.ok(dev.lines.join('\n').includes(dev.result.body.incident_id))
  }

  // bizFail 被直接调用（没有 errorHandler 先打日志）时也必须自己留日志，否则事件号指向空处
  const direct = withMode('production', () => captureErrors(() => { const r = fakeRes(); bizFail(r, internal()); return r }))
  assert.match(direct.result.body.incident_id, INCIDENT)
  assert.ok(direct.lines.join('\n').includes(direct.result.body.incident_id))

  // 带业务码的失败（含 5xx）保持原契约：message / error / detail.code 不变，detail 的凭据键被脱敏
  const coded = withMode('production', () => captureErrors(() => {
    const r = fakeRes(); bizFail(r, { code: 'SECURITY_AUDIT_UNAVAILABLE', message: '安全审计暂不可用，变更未提交', status: 503, detail: { token: 't', a: 1 } }); return r
  }))
  assert.equal(coded.result.statusCode, 503)
  assert.deepEqual(coded.result.body, { code: 1, success: false, message: '安全审计暂不可用，变更未提交', error: 'SECURITY_AUDIT_UNAVAILABLE', detail: { token: MASK, a: 1, code: 'SECURITY_AUDIT_UNAVAILABLE' } })
  const client = withMode('production', () => { const r = fakeRes(); bizFail(r, { message: '参数不对', status: 400, detail: { key: 'promo' } }); return r })
  assert.deepEqual(client.body, { code: 400, success: false, message: '参数不对', detail: { key: 'promo' } }, '4xx detail stays verbatim')
  // 运行时错误自带 `code` 但没有 HTTP 状态（better-sqlite3 `SQLITE_ERROR`、Node `ENOENT`）：不是业务码，不能回显
  const sqlite = withMode('production', () => captureErrors(() => { const r = fakeRes(); bizFail(r, Object.assign(new Error('no such table: users'), { code: 'SQLITE_ERROR' })); return r }))
  assert.equal(sqlite.result.statusCode, 500)
  assert.equal(sqlite.result.body.code, 500)
  assert.ok(!Object.hasOwn(sqlite.result.body, 'error') && !Object.hasOwn(sqlite.result.body, 'detail'))
  assert.ok(!sqlite.result.body.message.includes('no such table'))
  assert.match(sqlite.result.body.incident_id, INCIDENT)
})

test('H04 HTTP 5xx in production returns a generic message with an incident id that appears in the server log', { timeout: 90000 }, async t => {
  const f = await server(t)
  f.db.exec('ALTER TABLE audit_logs RENAME TO audit_logs_offline')
  try {
    const res = await f.request('/api/auth/audit-logs', 'GET', undefined, f.auth)
    assert.equal(res.status, 500)
    assert.equal(res.body.success, false)
    assert.match(res.body.incident_id, INCIDENT)
    assert.ok(!/no such table|audit_logs|SQLITE/i.test(res.body.message), `message leaked internals: ${res.body.message}`)
    assert.equal(res.body.detail, undefined)
    await delay(100)
    const log = f.stderr()
    assert.ok(log.includes(res.body.incident_id), 'incident id must be in the server log')
    assert.ok(log.includes('no such table'), 'full error must be in the server log')
  } finally {
    f.db.exec('ALTER TABLE audit_logs_offline RENAME TO audit_logs')
  }
})

// ---------------------------------------------------------------------------
// 4. 审计明细脱敏 + 严格审计
// ---------------------------------------------------------------------------
test('H05 audit rows persist detail redacted; strict insert refuses to run outside a transaction', () => {
  const db = memoryAuditDb()
  insertAuditRow(db, { userId: 1, userName: 'a', action: 'X', module: 'm', entity: 'e', entityId: 9, ip: '127.0.0.1',
    detail: { phone: '13812345678', password: 'p', body: { token: 't', note: 'ok', url: '/x?jwt=abc' } } })
  insertAuditRow(db, { action: 'Y', detail: 'reset token=abc for 13812345678' })
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  assert.equal(rows.length, 2)
  assert.deepEqual(JSON.parse(rows[0].detail), { phone: '138****5678', password: MASK, body: { token: MASK, note: 'ok', url: `/x?jwt=${MASK}` } })
  assert.equal(rows[0].entity_id, '9')
  assert.equal(rows[1].detail, `reset token=${MASK} for 13812345678`)
  assert.equal(rows[1].user_name, 'anonymous')
  assert.throws(() => auditStrictRow(db, { action: 'Z' }), { code: 'AUDIT_OUTSIDE_TX' })
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 2)
  db.transaction(() => auditStrictRow(db, { action: 'Z', detail: { secret: 's' } }))()
  assert.equal(JSON.parse(db.prepare('SELECT detail FROM audit_logs WHERE action=?').get('Z').detail).secret, MASK)
  db.exec("CREATE TRIGGER block BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'down'); END")
  assert.throws(() => db.transaction(() => auditStrictRow(db, { action: 'W' }))(), { code: 'SECURITY_AUDIT_UNAVAILABLE', status: 503 })
  db.exec("DROP TRIGGER block; CREATE TRIGGER ignore BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(IGNORE); END")
  assert.throws(() => db.transaction(() => auditStrictRow(db, { action: 'W' }))(), { code: 'SECURITY_AUDIT_UNAVAILABLE' })
})

test('H06 strict audit fault injection: when the audit insert fails, the business row is not written', { timeout: 120000 }, async t => {
  const f = await server(t)
  const dealerId = Number(f.db.prepare("INSERT INTO dealers (code,name,credit_limit,status) VALUES ('HYG01','Hygiene dealer',1000,'active')").run().lastInsertRowid)
  const rebateId = Number(f.db.prepare("INSERT INTO dealer_rebates (dealer_id,period,net_amount,rebate_rate,rebate_amount,status) VALUES (?,'2026-09',1000,5,50,'pending')").run(dealerId).lastInsertRowid)
  const probe = await f.request('/api/meta/settings', 'GET', undefined, f.auth)
  assert.equal(probe.status, 200)
  // 让配置偏离默认值（直接改库，不走接口），这样 set 与 reset 都是"真变更"，被拦下才有意义
  f.db.prepare("UPDATE settings SET value='12' WHERE key='promo_points_per_yuan'").run()
  const settingsBefore = f.db.prepare('SELECT value FROM settings WHERE key=?').get('promo_points_per_yuan').value
  assert.equal(settingsBefore, '12')

  f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
  const expectBlocked = async (route, method, body) => {
    const res = await f.request(route, method, body, f.auth)
    assert.equal(res.status, 503, `${route}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error, 'SECURITY_AUDIT_UNAVAILABLE')
    assert.equal(res.body.detail.code, 'SECURITY_AUDIT_UNAVAILABLE')
  }
  await expectBlocked('/api/meta/settings', 'PUT', { key: 'promo_points_per_yuan', value: '15', reason: 'rotate token=abc' })
  await expectBlocked('/api/meta/settings/reset', 'POST', { key: 'promo_points_per_yuan', reason: 'back' })
  await expectBlocked(`/api/dealers/${dealerId}/credit`, 'POST', { credit_limit: 99999, status: 'inactive' })
  await expectBlocked(`/api/dealers/rebates/${rebateId}`, 'PUT', { status: 'confirmed' })
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('promo_points_per_yuan')?.value ?? null, settingsBefore, 'setting unchanged')
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM setting_audit_log WHERE key='promo_points_per_yuan' AND action IN ('set','reset')").get().n, 0, 'setting trail unchanged')
  assert.deepEqual(f.db.prepare('SELECT credit_limit,status FROM dealers WHERE id=?').get(dealerId), { credit_limit: 1000, status: 'active' })
  assert.equal(f.db.prepare('SELECT status FROM dealer_rebates WHERE id=?').get(rebateId).status, 'pending')
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM doc_events WHERE doc_type='RB'").get().n, 0)
  f.db.exec('DROP TRIGGER reject_audit')

  const set = await f.request('/api/meta/settings', 'PUT', { key: 'promo_points_per_yuan', value: '15', reason: 'rotate token=abc' }, f.auth)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  assert.equal(set.body.data.changed, true)
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('promo_points_per_yuan').value, '15')
  const row = f.db.prepare("SELECT * FROM audit_logs WHERE action='SETTING_SET' ORDER BY id DESC").get()
  assert.ok(row, 'strict audit row written with the business change')
  assert.equal(row.entity_id, 'promo_points_per_yuan')
  assert.equal(row.user_name, 'Hygiene administrator')
  const detail = JSON.parse(row.detail)
  assert.equal(detail.setting, 'promo_points_per_yuan')
  assert.equal(detail.value_before, '12')
  assert.equal(detail.value_after, '15')
  assert.equal(detail.reason, `rotate token=${MASK}`)
  const credit = await f.request(`/api/dealers/${dealerId}/credit`, 'POST', { credit_limit: 99999 }, f.auth)
  assert.equal(credit.status, 200, JSON.stringify(credit.body))
  assert.equal(f.db.prepare('SELECT credit_limit FROM dealers WHERE id=?').get(dealerId).credit_limit, 99999)
  assert.ok(f.db.prepare("SELECT 1 FROM audit_logs WHERE action='DEALER_CREDIT_UPDATE' AND entity_id=?").get(String(dealerId)))
  const rebate = await f.request(`/api/dealers/rebates/${rebateId}`, 'PUT', { status: 'confirmed' }, f.auth)
  assert.equal(rebate.status, 200, JSON.stringify(rebate.body))
  assert.ok(f.db.prepare("SELECT 1 FROM audit_logs WHERE action='UPDATE' AND entity='dealer_rebates' AND entity_id=?").get(String(rebateId)))
  const reset = await f.request('/api/meta/settings/reset', 'POST', { key: 'promo_points_per_yuan', reason: 'back' }, f.auth)
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('promo_points_per_yuan').value, '10')
  assert.ok(f.db.prepare("SELECT 1 FROM audit_logs WHERE action='SETTING_RESET' AND entity_id='promo_points_per_yuan'").get())
})
