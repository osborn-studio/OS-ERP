import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { validateBootstrapInput } from '../server/lib/admin-bootstrap.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const args = ['scripts/bootstrap-admin.mjs', '--industry=cosmetic', '--company-code=TESTCO', '--company-name=测试企业', '--username=owner', '--name=管理员']
const secret = () => randomBytes(24).toString('base64url')
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', ...extra })
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-bootstrap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function cli(dir, password, extra = {}, argv = args) {
  return spawnSync(process.execPath, argv, { cwd: ROOT, env: envFor(dir, extra), input: password + '\n', encoding: 'utf8', timeout: 30000 })
}
function js(dir, source, extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 30000 })
}
function success(result) { assert.equal(result.status, 0, result.stderr) }
function rejection(result, code) { assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stderr).code, code) }
const open = dir => new Database(path.join(dir, 'gml_cosmetic.db'))
const initialize = dir => success(js(dir, "const {initSchema}=await import('./server/db/index.js');initSchema()"))

test('fresh CLI creates usable admin, corporate organization, membership and audit without demo records or secret output', t => {
  const dir = fixture(t), password = secret()
  const result = cli(dir, password)
  success(result)
  assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password))
  assert.doesNotMatch(result.stdout + result.stderr, /\$2[aby]\$/)
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'gml_cosmetic.db')).mode & 0o077, 0)
  const db = open(dir)
  const user = db.prepare('SELECT * FROM users').get()
  assert.equal(user.username, 'owner'); assert.equal(user.role, 'admin'); assert.equal(user.is_super, 1)
  assert.ok(bcrypt.compareSync(password, user.password_hash))
  const org = db.prepare('SELECT * FROM orgs WHERE id=?').get(user.org_id)
  assert.equal(org.code, 'TESTCO'); assert.equal(org.path, `/${org.id}/`); assert.equal(org.owner_org_id, org.id)
  assert.equal(db.prepare('SELECT role_code FROM user_roles WHERE user_id=?').get(user.id).role_code, 'admin')
  assert.equal(db.prepare('SELECT relation FROM user_orgs WHERE user_id=?').get(user.id).relation, 'manager')
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='BOOTSTRAP_ADMIN'").get().n, 1)
  for (const table of ['products', 'sales_orders', 'purchase_orders', 'agent_tokens']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
  db.close()
})

test('repeat bootstrap never changes password or corporate data; marker survives account removal', t => {
  const dir = fixture(t), password = secret()
  success(cli(dir, password))
  rejection(cli(dir, secret()), 'BOOTSTRAP_ALREADY_COMPLETED')
  const db = open(dir)
  assert.ok(bcrypt.compareSync(password, db.prepare('SELECT password_hash FROM users').get().password_hash))
  db.exec('DELETE FROM user_roles; DELETE FROM user_orgs; DELETE FROM users; DELETE FROM org_functions; DELETE FROM orgs WHERE id<>0')
  db.close()
  rejection(cli(dir, secret()), 'BOOTSTRAP_ALREADY_COMPLETED')
})

test('requires explicit production mode and refuses classified demo data', t => {
  const dir = fixture(t)
  for (const mode of ['', 'demo', 'test']) rejection(cli(dir, secret(), { GML_RUNTIME_MODE: mode }), 'BOOTSTRAP_PRODUCTION_REQUIRED')
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
  success(js(dir, "const {initSchema}=await import('./server/db/index.js');initSchema()", { GML_RUNTIME_MODE: 'demo' }))
  rejection(cli(dir, secret()), 'BOOTSTRAP_FAILED')
  const db = open(dir)
  assert.equal(db.prepare('SELECT mode FROM os_egp_runtime').get().mode, 'demo')
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
  db.close()
})

test('weak, overlong and invalid metadata fail before creating a database; unknown arguments never echo a password', t => {
  const dir = fixture(t)
  for (const password of ['short', 'a'.repeat(20), '密'.repeat(25), secret() + '\nsecond-line']) rejection(cli(dir, password), 'BOOTSTRAP_PASSWORD_INVALID')
  rejection(cli(dir, secret(), {}, args.map(a => a === '--username=owner' ? '--username=../owner' : a)), 'BOOTSTRAP_INPUT_INVALID')
  const accidentalSecret = secret()
  const result = cli(dir, secret(), {}, [...args, '--password=' + accidentalSecret])
  rejection(result, 'BOOTSTRAP_FAILED')
  assert.ok(!result.stderr.includes(accidentalSecret))
  rejection(spawnSync(process.execPath, args, { cwd: ROOT, env: envFor(dir), input: Buffer.from([0xff, 0xfe, 0x0a]), encoding: 'utf8', timeout: 30000 }), 'BOOTSTRAP_FAILED')
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
  const valid = { username: 'owner', name: '管理员', companyCode: 'TESTCO', companyName: '测试企业', password: secret() }
  assert.throws(() => validateBootstrapInput({ ...valid, name: '\u0000bad' }), { code: 'BOOTSTRAP_INPUT_INVALID' })
})

test('preexisting users or corporate organization are never adopted', t => {
  const dir = fixture(t)
  initialize(dir)
  const db = open(dir)
  db.prepare("INSERT INTO users (username,password_hash,name,role) VALUES ('existing','unusable-test-hash','Existing','viewer')").run()
  rejection(cli(dir, secret()), 'BOOTSTRAP_NOT_EMPTY')
  assert.equal(db.prepare('SELECT username FROM users').get().username, 'existing')
  db.exec("DELETE FROM users; INSERT INTO orgs (code,name,type) VALUES ('EXISTING','Existing','group')")
  rejection(cli(dir, secret()), 'BOOTSTRAP_NOT_EMPTY')
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='os_egp_admin_bootstrap'").get().n, 0)
  db.close()
})

test('audit failure rolls back organization, account, roles and one-time marker', t => {
  const dir = fixture(t)
  initialize(dir)
  const db = open(dir)
  db.exec("CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
  rejection(cli(dir, secret()), 'BOOTSTRAP_FAILED')
  for (const table of ['users', 'user_roles', 'user_orgs', 'org_functions']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM orgs WHERE id<>0').get().n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='os_egp_admin_bootstrap'").get().n, 0)
  db.exec('DROP TRIGGER reject_bootstrap_audit')
  db.close()
  success(cli(dir, secret()))
})

test('two concurrent bootstrap processes yield exactly one administrator and one successful result', async t => {
  const dir = fixture(t)
  initialize(dir)
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: envFor(dir), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', d => { stderr += d })
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(secret() + '\n')
  })
  const results = await Promise.all([launch(), launch()])
  assert.equal(results.filter(r => r.status === 0).length, 1)
  rejection(results.find(r => r.status !== 0), 'BOOTSTRAP_ALREADY_COMPLETED')
  const db = open(dir)
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM os_egp_admin_bootstrap').get().n, 1)
  db.close()
})

test('two concurrent CLI initializations of a completely fresh directory leave one complete administrator', async t => {
  const dir = fixture(t)
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: envFor(dir), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', d => { stderr += d })
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(secret() + '\n')
  })
  const results = await Promise.all([launch(), launch()])
  assert.equal(results.filter(r => r.status === 0).length, 1)
  const failure = JSON.parse(results.find(r => r.status !== 0).stderr)
  assert.equal(failure.success, false)
  // A competitor may fail during schema initialization or lose the administrator transaction.
  assert.ok(['BOOTSTRAP_ALREADY_COMPLETED', 'BOOTSTRAP_FAILED'].includes(failure.code))
  const db = open(dir)
  for (const table of ['users', 'user_roles', 'user_orgs', 'os_egp_admin_bootstrap']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1, table)
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM orgs WHERE id<>0').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM org_functions').get().n, 4)
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='BOOTSTRAP_ADMIN'").get().n, 1)
  const marker = db.prepare('SELECT * FROM os_egp_admin_bootstrap').get()
  assert.equal(db.prepare('SELECT org_id FROM users WHERE id=?').get(marker.user_id).org_id, marker.org_id)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})

test('bootstrapped account logs into actual production API and accesses authenticated admin routes', { timeout: 30000 }, async t => {
  const dir = fixture(t), password = secret()
  success(cli(dir, password))
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT,
    env: envFor(dir, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), GML_JWT_SECRET: secret() }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', () => {})
  const stopped = once(child, 'close')
  try {
    for (let i = 0; i < 200 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
    assert.ok(output.includes('服务已启动'), 'production server becomes ready')
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password, industry: 'cosmetic' }), signal: AbortSignal.timeout(3000) })
    assert.equal(login.status, 200)
    const { data } = await login.json()
    assert.equal(data.user.role, 'admin'); assert.equal(typeof data.token, 'string')
    for (const route of ['me', 'users', 'roles-permissions']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/${route}`, { headers: { Authorization: `Bearer ${data.token}` }, signal: AbortSignal.timeout(3000) })
      assert.equal(res.status, 200, route)
    }
    assert.ok(!output.includes(password))
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
  }
})
