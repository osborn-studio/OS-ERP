/**
 * ============================================================================
 * 文件标识：tests/role-deactivate-preview.test.mjs ｜ 测试：角色停用的影响预告、二次确认与恢复指引（AH10，ADR-0051 补充 5）
 * ============================================================================
 * 【职责】守住 AH10 的五条决定：
 *   ① `GET /api/auth/roles/:code/deactivation-impact`（仅管理员）给出受影响账号数 N 与其中主角色为此角色的 M；
 *   ② `POST /api/auth/roles/:code/deactivate` 必须带 `confirm_affected`，与事务内现算的 N 不符 ⇒ 409 `ROLE_IMPACT_CHANGED`
 *      （预告与停用之间有人被加进来 / 移出去，管理员看到的数字就过期了），缺失 ⇒ 400 `ROLE_CONFIRM_REQUIRED`；
 *   ③ 停用 / 启用都写严格审计，明细带受影响人数；
 *   ④ 主角色被停用的账号，登录 / me / my-scope 带 `primary_role_inactive` 与"联系管理员 / 重新指派主角色"文案；
 *   ⑤ 用户列表带 `role_status`，管理员据此在用户编辑器里重新指派主角色（不新建编辑器）。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，附加角色直接写库。
 * 【改它要注意什么】数字断言都是精确值，不是"大于 0"；并发 / 过期确认用例必须真的在预告与停用之间改了成员。
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

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-role-deact-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 2400 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `test-mode server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  const api = async (route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const login = async (username, password) => {
    const r = await api('/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.data
  }
  const admin = (await login('admin', '12345')).token
  const account = async (username, role, extra = {}) => {
    const password = secret()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const session = await login(username, password)
    return { id: r.body.data.id, username, password, token: session.token, login: session }
  }
  return { api, db, admin, login, account }
}

const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const impactOf = (f, code, token) => f.api(`/api/auth/roles/${code}/deactivation-impact`, { token: token ?? f.admin })
const deactivate = (f, code, body, token) => f.api(`/api/auth/roles/${code}/deactivate`, { token: token ?? f.admin, method: 'POST', body })
const activate = (f, code, token) => f.api(`/api/auth/roles/${code}/activate`, { token: token ?? f.admin, method: 'POST', body: {} })
const addRole = (db, id, code) => db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?, ?)').run(id, code)
const mkRole = (db, code, name = code) => db.prepare("INSERT INTO roles (code, name, data_scope, status) VALUES (?, ?, 'self', 'active')").run(code, name)
const statusOf = (db, code) => db.prepare('SELECT status FROM roles WHERE code=?').get(code)?.status
const auditRows = (db, action) => db.prepare('SELECT user_name, entity, entity_id, detail FROM audit_logs WHERE action=? ORDER BY id').all(action)

test('AH10: impact preview counts active non-admin holders exactly (primary vs additional), admin-only', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  mkRole(db, 'ah10_role', 'AH10角色'); mkRole(db, 'ah10_empty')
  const p1 = await f.account('ah10_p1', 'ah10_role')
  const p2 = await f.account('ah10_p2', 'ah10_role')
  const s1 = await f.account('ah10_s1', 'sales')
  addRole(db, s1.id, 'ah10_role') // additional holder
  await f.account('ah10_other', 'sales') // unrelated
  const off = await f.account('ah10_off', 'ah10_role')
  db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(off.id) // disabled account: cannot log in, not counted
  const adm = await f.account('ah10_adm2', 'admin')
  addRole(db, adm.id, 'ah10_role') // admins are unaffected by role status

  await t.test('exact numbers N=3 (two primary + one additional), M=2', async () => {
    const d = okData(await impactOf(f, 'ah10_role'))
    assert.equal(d.role, 'ah10_role')
    assert.equal(d.status, 'active')
    assert.equal(d.affected_users, 3)
    assert.equal(d.primary_users, 2)
    assert.deepEqual([...d.primary_user_ids].sort((a, b) => a - b), [p1.id, p2.id].sort((a, b) => a - b))
    assert.ok(!JSON.stringify(d).includes('ah10_p'), 'no usernames in the preview')
  })

  await t.test('a role with no holders previews zero', async () => {
    const d = okData(await impactOf(f, 'ah10_empty'))
    assert.equal(d.primary_users, 0)
    assert.equal(d.affected_users, db.prepare("SELECT COUNT(DISTINCT u.id) n FROM users u WHERE u.status='active' AND u.role<>'admin' AND u.is_super=0 AND (u.role='ah10_empty' OR u.id IN (SELECT user_id FROM user_roles WHERE role_code='ah10_empty'))").get().n)
  })

  await t.test('non-admin and anonymous callers are refused; unknown role is 404 with a business code', async () => {
    assert.equal((await impactOf(f, 'ah10_role', p1.token)).status, 403)
    assert.equal((await impactOf(f, 'ah10_role', s1.token)).status, 403)
    assert.equal((await f.api('/api/auth/roles/purchase/deactivation-impact')).status, 401)
    const miss = await impactOf(f, 'no_such_role')
    assert.equal(miss.status, 404)
    assert.equal(miss.body.error, 'ROLE_NOT_FOUND')
  })
})

test('AH10: deactivate needs a matching confirm_affected (TOCTOU between preview and deactivate), audits counts, enable restores', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  mkRole(db, 'ah10_role', 'AH10角色'); mkRole(db, 'ah10_empty')
  const p1 = await f.account('ah10_c1', 'ah10_role')
  const s1 = await f.account('ah10_c2', 'sales')
  addRole(db, s1.id, 'ah10_role')
  const before = db.prepare('SELECT id, auth_version FROM users ORDER BY id').all()

  await t.test('missing / malformed confirm_affected: 400 ROLE_CONFIRM_REQUIRED, role untouched', async () => {
    for (const body of [{}, { confirm_affected: '2' }, { confirm_affected: -1 }, { confirm_affected: 1.5 }, { confirm_affected: null }]) {
      const r = await deactivate(f, 'ah10_role', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.body.error, 'ROLE_CONFIRM_REQUIRED')
    }
    assert.equal(statusOf(db, 'ah10_role'), 'active')
    assert.equal(auditRows(db, 'ROLE_DEACTIVATE').length, 0)
  })

  await t.test('stale confirmation after a member was added between preview and deactivate: 409, then the fresh number works', async () => {
    const preview = okData(await impactOf(f, 'ah10_role'))
    assert.equal(preview.affected_users, 2)
    const late = await f.account('ah10_late', 'ah10_role') // someone joins after the admin looked
    const stale = await deactivate(f, 'ah10_role', { confirm_affected: preview.affected_users })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'ROLE_IMPACT_CHANGED')
    assert.equal(stale.body.detail.affected_users, 3, 'the refusal carries the current count so the dialog can re-confirm')
    assert.equal(statusOf(db, 'ah10_role'), 'active', 'a refused request changes nothing')
    assert.equal(auditRows(db, 'ROLE_DEACTIVATE').length, 0)
    // also stale in the other direction: a member leaves
    db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_code=?').run(s1.id, 'ah10_role')
    const fresh = okData(await impactOf(f, 'ah10_role'))
    assert.equal(fresh.affected_users, 2)
    assert.equal((await deactivate(f, 'ah10_role', { confirm_affected: 3 })).status, 409)
    addRole(db, s1.id, 'ah10_role')
    assert.equal(late.id > 0, true)
  })

  await t.test('matching confirmation deactivates, audits the counts, and does NOT revoke sessions', async () => {
    const preview = okData(await impactOf(f, 'ah10_role'))
    const r = await deactivate(f, 'ah10_role', { confirm_affected: preview.affected_users })
    const d = okData(r)
    assert.equal(d.status, 'inactive')
    assert.equal(d.affected_users, 3)
    assert.equal(d.primary_users, 2)
    assert.equal(statusOf(db, 'ah10_role'), 'inactive')
    const rows = auditRows(db, 'ROLE_DEACTIVATE')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].entity, 'role')
    assert.equal(rows[0].entity_id, 'ah10_role')
    const detail = JSON.parse(rows[0].detail)
    assert.equal(detail.affectedUsers, 3)
    assert.equal(detail.primaryUsers, 2)
    assert.deepEqual(db.prepare('SELECT id, auth_version FROM users ORDER BY id').all().filter((u) => before.some((b) => b.id === u.id)), before, 'enforcement is per request; no auth_version bump is needed')
    assert.equal((await f.api('/api/auth/me', { token: p1.token })).status, 200, 'old token still logs in (notice, not lockout)')
  })

  await t.test('deactivating again is refused (409 ROLE_ALREADY_INACTIVE), no second audit row', async () => {
    const r = await deactivate(f, 'ah10_role', { confirm_affected: 3 })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'ROLE_ALREADY_INACTIVE')
    assert.equal(auditRows(db, 'ROLE_DEACTIVATE').length, 1)
  })

  await t.test('enable restores, audits the counts; enabling an active role is refused', async () => {
    const d = okData(await activate(f, 'ah10_role'))
    assert.equal(d.status, 'active')
    assert.equal(statusOf(db, 'ah10_role'), 'active')
    const rows = auditRows(db, 'ROLE_ACTIVATE')
    assert.equal(rows.length, 1)
    const detail = JSON.parse(rows[0].detail)
    assert.equal(detail.affectedUsers, 3)
    assert.equal(detail.primaryUsers, 2)
    const again = await activate(f, 'ah10_role')
    assert.equal(again.status, 409)
    assert.equal(again.body.error, 'ROLE_ALREADY_ACTIVE')
    assert.equal(auditRows(db, 'ROLE_ACTIVATE').length, 1)
  })
})

test('AH10: a changed primary-user count with an unchanged total is stale too; a failed audit write rolls the change back', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  mkRole(db, 'ah10_mix', 'AH10混合')
  const a = await f.account('ah10_m1', 'ah10_mix')
  const b = await f.account('ah10_m2', 'sales')
  addRole(db, b.id, 'ah10_mix') // N=2, M=1
  const preview = okData(await impactOf(f, 'ah10_mix'))
  assert.deepEqual([preview.affected_users, preview.primary_users], [2, 1])
  // 总数不变，但 b 的主角色改成了此角色：M 变成 2（改主角色会把 b 的数据范围默认也换成此角色的）
  db.prepare("UPDATE users SET role='ah10_mix' WHERE id=?").run(b.id)

  await t.test('confirm_primary mismatch -> 409 ROLE_IMPACT_CHANGED with the current numbers, nothing changed', async () => {
    const r = await deactivate(f, 'ah10_mix', { confirm_affected: preview.affected_users, confirm_primary: preview.primary_users })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'ROLE_IMPACT_CHANGED')
    assert.deepEqual([r.body.detail.affected_users, r.body.detail.primary_users], [2, 2])
    assert.equal(statusOf(db, 'ah10_mix'), 'active')
    assert.equal(auditRows(db, 'ROLE_DEACTIVATE').length, 0)
  })

  await t.test('malformed confirm_primary is rejected before anything is read', async () => {
    for (const confirm_primary of ['2', -1, 1.5, null]) {
      const r = await deactivate(f, 'ah10_mix', { confirm_affected: 2, confirm_primary })
      assert.equal(r.status, 400, JSON.stringify(confirm_primary))
      assert.equal(r.body.error, 'ROLE_CONFIRM_REQUIRED')
    }
  })

  await t.test('audit write failure rolls back both transitions (503, role status unchanged)', async () => {
    db.exec("CREATE TRIGGER ah10_audit_fail BEFORE INSERT ON audit_logs WHEN NEW.action IN ('ROLE_DEACTIVATE','ROLE_ACTIVATE') BEGIN SELECT RAISE(ABORT, 'ah10 injected audit failure'); END")
    try {
      const d = await deactivate(f, 'ah10_mix', { confirm_affected: 2, confirm_primary: 2 })
      assert.equal(d.status, 503, JSON.stringify(d.body))
      assert.equal(statusOf(db, 'ah10_mix'), 'active', 'the deactivation must not survive a failed audit write')
    } finally { db.exec('DROP TRIGGER IF EXISTS ah10_audit_fail') }
    okData(await deactivate(f, 'ah10_mix', { confirm_affected: 2, confirm_primary: 2 }))
    db.exec("CREATE TRIGGER ah10_audit_fail BEFORE INSERT ON audit_logs WHEN NEW.action IN ('ROLE_DEACTIVATE','ROLE_ACTIVATE') BEGIN SELECT RAISE(ABORT, 'ah10 injected audit failure'); END")
    try {
      const e = await activate(f, 'ah10_mix')
      assert.equal(e.status, 503, JSON.stringify(e.body))
      assert.equal(statusOf(db, 'ah10_mix'), 'inactive', 'the activation must not survive a failed audit write')
    } finally { db.exec('DROP TRIGGER IF EXISTS ah10_audit_fail') }
    assert.equal(auditRows(db, 'ROLE_ACTIVATE').length, 0)
    assert.equal(a.id > 0, true)
  })
})

test('AH10: only administrators may deactivate or enable; the admin role is protected; unknown role is 404', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  const s = await f.account('ah10_nonadmin', 'sales')
  assert.equal((await deactivate(f, 'viewer', { confirm_affected: 0 }, s.token)).status, 403)
  assert.equal((await activate(f, 'viewer', s.token)).status, 403)
  assert.equal(statusOf(db, 'viewer'), 'active')
  const protectedRole = await deactivate(f, 'admin', { confirm_affected: 0 })
  assert.equal(protectedRole.status, 409)
  assert.equal(protectedRole.body.error, 'ROLE_ADMIN_PROTECTED')
  assert.equal(statusOf(db, 'admin'), 'active')
  assert.equal((await deactivate(f, 'no_such_role', { confirm_affected: 0 })).status, 404)
  assert.equal(auditRows(db, 'ROLE_DEACTIVATE').length, 0)
})

test('AH10: primary-role holders get contact-an-administrator wording; additional-role holders do not; users list exposes role_status', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  const prim = await f.account('ah10_prim', 'purchase')
  const extra = await f.account('ah10_extra', 'sales')
  addRole(db, extra.id, 'purchase')
  const preview = okData(await impactOf(f, 'purchase'))
  okData(await deactivate(f, 'purchase', { confirm_affected: preview.affected_users }))

  const meOf = async (token) => okData(await f.api('/api/auth/me', { token }))
  const scopeOf = async (token) => okData(await f.api('/api/auth/my-scope', { token }))

  await t.test('primary holder: flag on login (fresh), me and my-scope; message tells them to contact an administrator to reassign', async () => {
    const lg = (await f.login(prim.username, prim.password)).user
    const fresh = (await f.api('/api/auth/login', { body: { username: prim.username, password: prim.password, industry: 'cosmetic' } })).body.data
    for (const d of [fresh, await meOf(prim.token), await scopeOf(prim.token)]) {
      assert.equal(d.primary_role_inactive, true)
      assert.equal(d.notice_code, 'ROLE_INACTIVE_NOTICE')
      assert.match(d.notice_message, /联系管理员/)
      assert.match(d.notice_message, /重新指派主角色/)
      assert.match(d.notice_message, /采购/, 'names the primary role the caller already holds')
    }
    assert.ok(lg)
  })

  await t.test('additional-role holder: generic notice only, no primary flag, no reassign wording', async () => {
    for (const d of [await meOf(extra.token), await scopeOf(extra.token)]) {
      assert.equal(d.primary_role_inactive, false)
      assert.equal(d.notice_code, 'ROLE_INACTIVE_NOTICE')
      assert.doesNotMatch(d.notice_message, /重新指派主角色/)
    }
  })

  await t.test('a caller with no inactive role sees no flag and no notice; admin is unaffected', async () => {
    const plain = await f.account('ah10_plain', 'viewer')
    const me = await meOf(plain.token)
    assert.equal(me.primary_role_inactive, false)
    assert.equal(me.notice_code, null)
    assert.equal((await meOf(f.admin)).primary_role_inactive, false)
  })

  await t.test('admin users list carries role_status so the user editor entry can be shown', async () => {
    const list = okData(await f.api('/api/auth/users?pageSize=200', { token: f.admin }))
    const rows = list.list || list.rows || list
    const byName = Object.fromEntries(rows.map((u) => [u.username, u]))
    assert.equal(byName.ah10_prim.role_status, 'inactive')
    assert.equal(byName.ah10_extra.role_status, 'active', 'role_status is about the primary role only')
    assert.equal(byName.admin.role_status, 'active')
  })

  await t.test('reassigning the primary role through the existing user editor clears the flag', async () => {
    okData(await f.api(`/api/auth/users/${prim.id}`, { token: f.admin, method: 'PUT', body: { role: 'viewer' } }))
    const session = await f.login(prim.username, prim.password)
    const me = await meOf(session.token)
    assert.equal(me.primary_role_inactive, false)
    assert.equal(me.notice_code, null)
  })
})
