// slow: 97 s: multi-session password change and reset flows over a real server with password hashing (scripts/test-timings.mjs, threshold 60 s)
import test from 'node:test'
import { SLOW_WAIT } from '../lib/load-tolerance.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createAccount, changePassword, updateAccount } from '../../server/lib/account-security.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const secret = () => randomBytes(24).toString('base64url')
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-session-'))
  const password = secret(), jwtSecret = secret()
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', NODE_ENV: 'production',
    GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: jwtSecret, ...overrides }
  const bootstrap = spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs', '--industry=cosmetic', '--company-code=SESSION',
    '--company-name=会话测试', '--username=owner', '--name=Owner'], { cwd: ROOT, env, input: password + '\n', encoding: 'utf8', timeout: SLOW_WAIT.bootstrapMs })
  assert.equal(bootstrap.status, 0, bootstrap.stderr)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  let child, stopped, port
  const stop = async () => { if (child && child.exitCode === null) child.kill('SIGTERM'); if (stopped) await stopped; child = null }
  t.after(async () => { await stop(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  const start = async () => {
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
    port = listener.address().port; await new Promise(resolve => listener.close(resolve))
    child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', () => {})
    stopped = once(child, 'close')
    for (let i = 0; i < SLOW_WAIT.productionReadyAttempts && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(40)
    assert.ok(output.includes('服务已启动'), 'isolated production server must become ready')
  }
  const call = async (route, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(SLOW_WAIT.httpShortMs) })
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') }
  }
  const login = (username = 'owner', pass = password) => call('/login', { body: { username, password: pass, industry: 'cosmetic' } })
  await start()
  return { dir, db, env, jwtSecret, password, call, login, stop, start }
}
function successful(result) { assert.equal(result.status, 200, result.body.message); return result.body.data }
function revoked(result) { assert.equal(result.status, 401); assert.equal(result.body.detail?.code, 'SESSION_REVOKED') }
async function account(f, adminToken, username, role = 'viewer') {
  const password = secret()
  const { id } = successful(await f.call('/users', { token: adminToken, body: { username, name: username, role, password } }))
  return { id, username, password, token: successful(await f.login(username, password)).token }
}
const actorFor = (db, id) => { const row = db.prepare('SELECT id,auth_version FROM users WHERE id=?').get(id); return { uid: row.id, auth_version: row.auth_version } }

test('A01 password change revokes both sessions; only the new password authenticates', async t => {
  const f = await fixture(t), first = successful(await f.login()).token, second = successful(await f.login()).token, next = secret()
  assert.deepEqual(successful(await f.call('/change-password', { token: first, body: { oldPassword: f.password, newPassword: next } })), { changed: true, reauthenticate: true })
  revoked(await f.call('/me', { token: first })); revoked(await f.call('/me', { token: second }))
  assert.equal((await f.login('owner', f.password)).status, 401)
  assert.equal((await f.login('owner', next)).status, 200)
})

test('A02 admin resets target without revoking self, then self reset revokes own session', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token, user = await account(f, admin, 'target')
  successful(await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { password: secret() } }))
  revoked(await f.call('/me', { token: user.token })); assert.equal((await f.call('/me', { token: admin })).status, 200)
  successful(await f.call('/users/1', { token: admin, method: 'PUT', body: { password: secret() } }))
  revoked(await f.call('/me', { token: admin }))
})

test('A03 disable and re-enable never resurrect an old JWT', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token, user = await account(f, admin, 'disabled_user')
  for (const status of ['inactive', 'active']) {
    successful(await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { status } }))
    revoked(await f.call('/me', { token: user.token }))
  }
  assert.equal((await f.login(user.username, user.password)).status, 200)
})

test('A04 role, organization and scope changes revoke sessions; profile-only updates preserve them', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token, user = await account(f, admin, 'scoped_user', 'sales')
  successful(await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { name: 'Renamed' } }))
  assert.equal((await f.call('/me', { token: user.token })).status, 200)
  successful(await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { role: 'viewer' } }))
  revoked(await f.call('/me', { token: user.token }))
  const viewer = successful(await f.login(user.username, user.password)).token
  assert.equal(successful(await f.call('/me', { token: viewer })).role, 'viewer')
  assert.equal((await f.call('/users', { token: viewer, body: {} })).status, 403)
  const orgId = Number(f.db.prepare("INSERT INTO orgs(code,name,type,path) VALUES ('NEWORG','New organization','group','/999/')").run().lastInsertRowid)
  successful(await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { org_id: orgId, data_scope: 'org' } }))
  revoked(await f.call('/me', { token: viewer }))
  const fresh = successful(await f.login(user.username, user.password)).token
  const me = successful(await f.call('/me', { token: fresh }))
  assert.equal(me.org.id, orgId); assert.equal(me.orgScope.scope, 'org')
  assert.equal((await f.call(`/users/${user.id}`, { token: admin, method: 'PUT', body: { org_id: -1, data_scope: 'anything' } })).status, 400)
})

test('A05 role permission changes revoke primary and secondary members but not unrelated users', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token
  const primary = await account(f, admin, 'primary'), secondary = await account(f, admin, 'secondary', 'purchase'), other = await account(f, admin, 'unrelated', 'sales')
  f.db.prepare("INSERT INTO user_roles(user_id,role_code) VALUES (?,'viewer')").run(secondary.id)
  const result = successful(await f.call('/roles/viewer/permissions', { token: admin, method: 'PUT', body: { permissions: [] } }))
  assert.equal(result.revokedUsers, 2)
  revoked(await f.call('/me', { token: primary.token })); revoked(await f.call('/me', { token: secondary.token }))
  assert.equal((await f.call('/me', { token: other.token })).status, 200)
  const version = f.db.prepare('SELECT auth_version FROM users WHERE id=?').get(primary.id).auth_version
  successful(await f.call('/roles/viewer/permissions', { token: admin, method: 'PUT', body: { permissions: [] } }))
  assert.equal(f.db.prepare('SELECT auth_version FROM users WHERE id=?').get(primary.id).auth_version, version)
  await f.stop(); await f.start()
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='viewer'").get().n, 0)
  revoked(await f.call('/me', { token: primary.token }))
})

test('A05 reducing built-in SCM permissions survives a normal server restart', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token, scm = await account(f, admin, 'supply_chain', 'scm')
  successful(await f.call('/roles/scm/permissions', { token: admin, method: 'PUT', body: { permissions: [] } }))
  revoked(await f.call('/me', { token: scm.token }))
  await f.stop(); await f.start()
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='scm'").get().n, 0)
  const fresh = successful(await f.login(scm.username, scm.password)).token
  assert.deepEqual(successful(await f.call('/me', { token: fresh })).permissions, [])
})

test('A06 concurrent changes and admin reset use compare-and-swap instead of overwriting newer credentials', async t => {
  const f = await fixture(t), actor = actorFor(f.db, 1), first = secret(), second = secret()
  const results = await Promise.allSettled([changePassword(f.db, actor, f.password, first), changePassword(f.db, actor, f.password, second)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'ACCOUNT_CHANGED')
  const finalHash = f.db.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash
  const winner = results[0].status === 'fulfilled' ? first : second
  assert.ok(bcrypt.compareSync(winner, finalHash))
  const currentActor = actorFor(f.db, 1), nextA = secret(), nextB = secret()
  const resets = await Promise.allSettled([changePassword(f.db, currentActor, winner, nextA), updateAccount(f.db, currentActor, 1, { password: nextB })])
  assert.equal(resets.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(resets.find(r => r.status === 'rejected').reason.code, 'ACCOUNT_CHANGED')
  assert.ok(bcrypt.compareSync(resets[0].status === 'fulfilled' ? nextA : nextB, f.db.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash))
})

test('A07 security audit failure rolls back password, version, status and role permission changes', async t => {
  const f = await fixture(t), admin = successful(await f.login()).token
  const before = f.db.prepare('SELECT password_hash,auth_version,status FROM users WHERE id=1').get()
  f.db.exec("CREATE TRIGGER reject_security_audit BEFORE INSERT ON audit_logs WHEN NEW.action IN ('PASSWORD_CHANGE','ACCOUNT_UPDATE','ROLE_PERM_UPDATE') BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
  for (const [route, method, body] of [['/change-password','POST',{ oldPassword: f.password, newPassword: secret() }], ['/users/1','PUT',{ status: 'inactive' }], ['/roles/viewer/permissions','PUT',{ permissions: [] }]]) {
    const result = await f.call(route, { token: admin, method, body })
    assert.equal(result.status, 503); assert.equal(result.body.detail.code, 'SECURITY_AUDIT_UNAVAILABLE')
  }
  assert.deepEqual(f.db.prepare('SELECT password_hash,auth_version,status FROM users WHERE id=1').get(), before)
  assert.ok(f.db.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='viewer'").get().n > 0)
  f.db.exec('DROP TRIGGER reject_security_audit')
  f.db.exec("CREATE TRIGGER ignore_security_audit BEFORE INSERT ON audit_logs WHEN NEW.action='SESSION_REVOKE_ALL' BEGIN SELECT RAISE(IGNORE); END")
  const ignored = await f.call('/logout-all', { token: admin, method: 'POST' })
  assert.equal(ignored.status, 503); assert.equal(ignored.body.detail.code, 'SECURITY_AUDIT_UNAVAILABLE')
  assert.equal(f.db.prepare('SELECT auth_version FROM users WHERE id=1').get().auth_version, before.auth_version)
  f.db.exec('DROP TRIGGER ignore_security_audit')
  assert.equal((await f.login()).status, 200)
})

test('account creation rechecks subject status after asynchronous password hashing', async t => {
  const f = await fixture(t)
  const orgId = Number(f.db.prepare("INSERT INTO orgs(code,name,type) VALUES ('CONCURRENT','Concurrent subject','group')").run().lastInsertRowid)
  const pending = createAccount(f.db, actorFor(f.db, 1), { username: 'racing_subject', name: 'Race', password: secret(), role: 'viewer', org_id: orgId })
  f.db.prepare("UPDATE orgs SET status='inactive' WHERE id=?").run(orgId)
  await assert.rejects(pending, { code: 'ACCOUNT_SUBJECT_INVALID' })
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM users WHERE username='racing_subject'").get().n, 0)
})

test('A08 login errors are identical and account limits apply before password work', async t => {
  const f = await fixture(t)
  const absent = await f.login('missing_user', secret()), wrong = await f.login('owner', secret())
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run()
  const inactive = await f.login()
  assert.equal(absent.status, 401); assert.deepEqual(wrong.body, absent.body); assert.deepEqual(inactive.body, absent.body)
  for (let i = 0; i < 8; i++) assert.equal((await f.login('owner', secret())).status, 401)
  const limited = await f.login('owner', secret())
  assert.equal(limited.status, 429); assert.ok(Number(limited.retryAfter) >= 1)
  assert.equal((await f.call('/login', { body: { username: {}, password: 'x' } })).status, 400)
})

test('X7 successful logins never lock; success clears failures; failures still lock', async t => {
  const f = await fixture(t, { GML_LOGIN_ACCOUNT_LIMIT: '3', GML_LOGIN_IP_LIMIT: '100' })
  for (let i = 0; i < 6; i++) assert.equal((await f.login()).status, 200)
  assert.equal((await f.login('owner', secret())).status, 401); assert.equal((await f.login('owner', secret())).status, 401)
  assert.equal((await f.login()).status, 200) // success wipes the 2 failures
  assert.equal((await f.login('owner', secret())).status, 401); assert.equal((await f.login('owner', secret())).status, 401)
  assert.equal((await f.login('owner', secret())).status, 401)
  const locked = await f.login() // correct password is refused once 3 failures are recorded
  assert.equal(locked.status, 429); assert.ok(Number(locked.retryAfter) >= 1)
})

test('X7 the IP bucket still counts successful logins', async t => {
  const f = await fixture(t, { GML_LOGIN_IP_LIMIT: '3', GML_LOGIN_ACCOUNT_LIMIT: '50' })
  for (let i = 0; i < 3; i++) assert.equal((await f.login()).status, 200)
  assert.equal((await f.login()).status, 429)
})

test('A10 logout-all revokes every issued token', async t => {
  const f = await fixture(t), first = successful(await f.login()).token, second = successful(await f.login()).token
  assert.deepEqual(successful(await f.call('/logout-all', { token: first, method: 'POST' })), { revoked: true })
  revoked(await f.call('/me', { token: first })); revoked(await f.call('/me', { token: second }))
  assert.equal((await f.login()).status, 200)
})

test('A08/A09 parallel login attempts share an atomic account budget', async t => {
  const f = await fixture(t, { GML_LOGIN_ACCOUNT_LIMIT: '3' })
  const results = await Promise.all(Array.from({ length: 6 }, () => f.login('unknown_parallel', secret())))
  assert.equal(results.filter(r => r.status === 401).length, 3)
  assert.equal(results.filter(r => r.status === 429).length, 3)
})

test('A09 spoofed proxy headers cannot bypass IP limits; restart preserves active budget', async t => {
  const f = await fixture(t, { GML_LOGIN_IP_LIMIT: '3', GML_LOGIN_ACCOUNT_LIMIT: '50' })
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.call('/login', { body: { username: `missing_${i}`, password: secret() }, headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` } })).status, 401)
  }
  assert.equal((await f.call('/login', { body: { username: 'different_name', password: secret() }, headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 429)
  await f.stop(); await f.start()
  assert.equal((await f.login('another_name', secret())).status, 429)
})

test('A11 rejects legacy/version/algorithm/industry tampering and preserves signed-industry precedence', async t => {
  const f = await fixture(t), token = successful(await f.login()).token
  const payload = { uid: 1, industry: 'cosmetic', auth_version: 0 }
  for (const p of [{ uid: 1, industry: 'cosmetic' }, { ...payload, auth_version: '0' }, { ...payload, auth_version: -1 }, { ...payload, industry: undefined }]) {
    const forged = jwt.sign(p, f.jwtSecret, { algorithm: 'HS256', audience: 'gml-erp' })
    assert.equal((await f.call('/me', { token: forged })).status, 401)
  }
  const wrongAlgorithm = jwt.sign(payload, f.jwtSecret, { algorithm: 'HS384', audience: 'gml-erp' })
  assert.equal((await f.call('/me', { token: wrongAlgorithm })).status, 401)
  const pieces = token.split('.'); pieces[1] = Buffer.from(JSON.stringify({ ...payload, industry: 'food' })).toString('base64url')
  assert.equal((await f.call('/me', { token: pieces.join('.') })).status, 401)
  assert.equal(successful(await f.call('/me', { token, headers: { 'x-industry': 'food' } })).username, 'owner')
  const invalidIndustry = jwt.sign({ ...payload, industry: 'not-valid' }, f.jwtSecret, { audience: 'gml-erp' })
  assert.equal((await f.call('/me', { token: invalidIndustry })).status, 400)
})

test('A11 migration and repeated server startup never reset a nonzero auth_version', async t => {
  const f = await fixture(t), migration = require('../../server/db/migrations/050_user_auth_version.cjs')
  f.db.prepare('UPDATE users SET auth_version=27 WHERE id=1').run()
  migration.up(f.db); assert.equal(migration.verify(f.db), true)
  await f.stop(); await f.start()
  assert.equal(f.db.prepare('SELECT auth_version FROM users WHERE id=1').get().auth_version, 27)
  const old = new Database(':memory:')
  old.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users(id) VALUES (1)')
  assert.equal(migration.verify(old), false); migration.up(old)
  assert.equal(old.prepare('SELECT auth_version FROM users').get().auth_version, 0)
  old.exec('UPDATE users SET auth_version=9'); migration.up(old)
  assert.equal(old.prepare('SELECT auth_version FROM users').get().auth_version, 9); old.close()
})
