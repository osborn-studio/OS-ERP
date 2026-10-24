/**
 * ============================================================================
 * 文件标识：tests/my-scope.test.mjs ｜ 测试：GET /api/auth/my-scope（Z6，只读、仅限调用者自己）
 * ============================================================================
 * 【职责】守住三件事：① 各类账号（admin / subtree / org / self / 门店 / 经销商 / 无组织）得到的有效范围、
 *   来源与说明与 `resolveOrgScope` 一致；② 响应只含调用者自己的信息 —— 不出现其他用户、其他组织、
 *   其他门店 / 经销商的名字，也没有范围外组织 id；③ 未登录 401。
 * 【夹具口径】test 运行时 + 全新临时数据目录 + 随机回环端口；账号经 `/api/auth/users` 建，组织 / 门店 / 经销商直接写库。
 * 【改它要注意什么】泄漏断言按"精确键集合 + 序列化文本里不含哨兵串"写，不是"看起来没有"。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-my-scope-'))
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
  let seq = 0
  const mcp = async (method, params, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal: AbortSignal.timeout(10000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const login = async (username, password) => {
    const r = await api('/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.data.token
  }
  const admin = await login('admin', '12345')
  const account = async (username, role, extra = {}) => {
    const password = secret()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { id: r.body.data.id, username, password, token: await login(username, password) }
  }
  return { dir, api, mcp, db, admin, login, account }
}

const KEYS = ['data_scope_effective', 'data_scope_source', 'dealer', 'explanations', 'is_admin', 'notice_code', 'notice_message', 'org', 'org_ids_in_scope', 'role', 'role_default_scope', 'role_name', 'roles_inactive', 'store', 'user_data_scope']
const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }

test('GET /api/auth/my-scope describes only the caller', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  // 组织：一个有下级的父组织、一个与之不嵌套的另一组织；打上哨兵名字用于泄漏断言。
  const parent = db.prepare("SELECT o.id, o.path FROM orgs o WHERE o.id<>0 AND EXISTS (SELECT 1 FROM orgs c WHERE c.parent_id=o.id AND c.id<>0) ORDER BY o.level DESC, o.id LIMIT 1").get()
  assert.ok(parent, 'demo data must provide an org with children')
  const childCount = db.prepare('SELECT COUNT(*) c FROM orgs WHERE path LIKE ? OR id=?').get(`${parent.path}%`, parent.id).c
  const other = db.prepare("SELECT id FROM orgs WHERE id<>0 AND path NOT LIKE ? AND id<>? ORDER BY id LIMIT 1").get(`${parent.path}%`, parent.id)
  assert.ok(other, 'demo data must provide a second, non-nested org')
  db.prepare("UPDATE orgs SET name='SENTINEL-ORG-PARENT' WHERE id=?").run(parent.id)
  db.prepare("UPDATE orgs SET name='SENTINEL-ORG-OTHER' WHERE id=?").run(other.id)
  const storeA = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('MS-A','SENTINEL-STORE-A')").run().lastInsertRowid)
  const storeB = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('MS-B','SENTINEL-STORE-B')").run().lastInsertRowid)
  const dealerA = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('MD-A','SENTINEL-DEALER-A')").run().lastInsertRowid)
  const dealerB = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('MD-B','SENTINEL-DEALER-B')").run().lastInsertRowid)

  const sub = await f.account('ms_sub', 'purchase', { org_id: parent.id, data_scope: 'subtree' })
  const org = await f.account('ms_org', 'purchase', { org_id: other.id, data_scope: 'org' })
  const self = await f.account('ms_self', 'sales', { org_id: other.id, data_scope: 'self' })
  const store = await f.account('ms_store', 'store', { store_id: storeA })
  const dealer = await f.account('ms_dealer', 'dealer', { dealer_id: dealerA })
  const noOrg = await f.account('ms_noorg', 'purchase', {})
  const get = (token) => api('/api/auth/my-scope', { token })
  const text = (d) => JSON.stringify(d)

  await t.test('requires login', async () => {
    assert.equal((await get(undefined)).status, 401)
  })

  await t.test('admin: all data, no org list', async () => {
    const d = okData(await get(f.admin))
    assert.deepEqual(Object.keys(d).sort(), KEYS)
    assert.equal(d.is_admin, true)
    assert.equal(d.role, 'admin')
    assert.equal(d.data_scope_effective, 'all')
    assert.equal(d.data_scope_source, 'admin')
    assert.equal(d.org_ids_in_scope.all, true)
    assert.equal(d.org_ids_in_scope.count, null)
    assert.deepEqual(d.org_ids_in_scope.names, [])
    assert.ok(Array.isArray(d.explanations) && d.explanations.length >= 1 && d.explanations.every((s) => typeof s === 'string'))
    // 管理员也不会收到用户清单
    assert.ok(!text(d).includes('ms_sub'))
  })

  await t.test('subtree: own org plus descendants, names capped', async () => {
    const d = okData(await get(sub.token))
    assert.deepEqual(Object.keys(d).sort(), KEYS)
    assert.equal(d.is_admin, false)
    assert.equal(d.data_scope_effective, 'subtree')
    assert.equal(d.data_scope_source, 'user')
    assert.equal(d.user_data_scope, 'subtree')
    assert.deepEqual(d.org, { id: parent.id, name: 'SENTINEL-ORG-PARENT' })
    assert.equal(d.org_ids_in_scope.all, false)
    assert.equal(d.org_ids_in_scope.count, childCount)
    assert.ok(d.org_ids_in_scope.names.length <= 20 && d.org_ids_in_scope.names.length >= 1)
    assert.equal(d.org_ids_in_scope.truncated, childCount > d.org_ids_in_scope.names.length)
    assert.ok(d.org_ids_in_scope.names.includes('SENTINEL-ORG-PARENT'))
    assert.equal(d.role_default_scope, db.prepare('SELECT data_scope FROM roles WHERE code=?').get('purchase').data_scope)
    assert.equal(d.store, null)
    assert.equal(d.dealer, null)
    for (const s of ['SENTINEL-ORG-OTHER', 'SENTINEL-STORE', 'SENTINEL-DEALER', 'ms_org', 'ms_dealer', 'ms_store']) assert.ok(!text(d).includes(s), `must not leak ${s}`)
  })

  await t.test('org: exactly one org, nothing about its neighbours', async () => {
    const d = okData(await get(org.token))
    assert.equal(d.data_scope_effective, 'org')
    assert.equal(d.org_ids_in_scope.count, 1)
    assert.deepEqual(d.org_ids_in_scope.names, ['SENTINEL-ORG-OTHER'])
    assert.equal(d.org_ids_in_scope.truncated, false)
    assert.ok(!text(d).includes('SENTINEL-ORG-PARENT'))
  })

  await t.test('self: effective scope reported honestly as the single owning org', async () => {
    const d = okData(await get(self.token))
    assert.equal(d.data_scope_effective, 'self')
    assert.equal(d.org_ids_in_scope.count, 1)
    assert.ok(d.explanations.some((s) => s.includes('仅本人')))
  })

  await t.test('store account: sees only its own store binding', async () => {
    const d = okData(await get(store.token))
    assert.deepEqual(d.store, { id: storeA, name: 'SENTINEL-STORE-A' })
    assert.equal(d.dealer, null)
    assert.ok(!text(d).includes('SENTINEL-STORE-B'))
    assert.ok(d.explanations.some((s) => s.includes('SENTINEL-STORE-A')))
  })

  await t.test('dealer account: dealer scope, own dealer only', async () => {
    const d = okData(await get(dealer.token))
    assert.equal(d.data_scope_effective, 'dealer')
    assert.deepEqual(d.dealer, { id: dealerA, name: 'SENTINEL-DEALER-A' })
    assert.equal(d.org_ids_in_scope.count, null)
    assert.equal(d.org_ids_in_scope.all, false)
    assert.ok(!text(d).includes('SENTINEL-DEALER-B'))
    assert.ok(!text(d).includes('SENTINEL-ORG'))
  })

  await t.test('dealer scope without a dealer binding is called out', async () => {
    const x = await f.account('ms_dealer_unbound', 'sales', { data_scope: 'dealer' })
    const d = okData(await get(x.token))
    assert.equal(d.data_scope_effective, 'dealer')
    assert.equal(d.dealer, null)
    assert.ok(d.explanations.some((s) => s.includes('未绑定经销商')))
  })

  await t.test('no org: none scope, empty list, explained as 200-empty not 403', async () => {
    const d = okData(await get(noOrg.token))
    assert.equal(d.data_scope_effective, 'none')
    assert.equal(d.org, null)
    assert.equal(d.org_ids_in_scope.count, 0)
    assert.deepEqual(d.org_ids_in_scope.names, [])
    assert.equal(d.data_scope_source, 'no_org')
    assert.ok(d.explanations.some((s) => s.includes('所属组织')))
  })

  await t.test('two callers never see each other', async () => {
    const a = text(okData(await get(sub.token)))
    const b = text(okData(await get(org.token)))
    assert.ok(!a.includes('ms_org') && !b.includes('ms_sub'))
    assert.ok(!b.includes('SENTINEL-ORG-PARENT') && !a.includes('SENTINEL-ORG-OTHER'))
  })
})
