/**
 * ============================================================================
 * 文件标识：tests/role-matrix.test.mjs ｜ 测试：GET /api/meta/role-matrix（AD11，只读、requireAuth）
 * ============================================================================
 * 【职责】守住四件事：① 未登录 401；② 矩阵保真——每个角色 x 单据类型的可见度与库里 role_permissions + DOC_VIEW_PERMS +
 *   DOC_SCOPE_RESOLVERS + hq-roles 的独立推演一致（外部角色看不到内部域、全局类单据标 global_only、门店绑定类对非总部角色标 bound）；
 *   ③ 不泄漏——响应不含权限点码、不含用户名 / 组织 / 门店 / 经销商名；④ `me` 只描述调用者自己。
 * 【夹具口径】test 运行时 + 全新临时数据目录 + 随机回环端口；账号经 `/api/auth/users` 建，档案直接写库。
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
import { DOC_VIEW_PERMS } from '../server/mcp/doc-perms.js'
import { DOC_SCOPE_RESOLVERS } from '../server/lib/docflow.js'
import { HQ_ROLES } from '../server/lib/hq-roles.js'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-role-matrix-'))
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
  const api = async (route, { token, body } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
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
    return r.body.data.token
  }
  const admin = await login('admin', '12345')
  const account = async (username, role, extra = {}) => {
    const password = secret()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { username, token: await login(username, password) }
  }
  return { api, db, admin, account }
}

/** 独立推演（不引用 server/lib/role-matrix.js）：某角色在某类型上的可见度 */
function expected(db, role, code) {
  if (role === 'admin') return 'full'
  const perms = new Set(db.prepare('SELECT perm_code FROM role_permissions WHERE role_code=?').all(role).map((r) => r.perm_code))
  const need = DOC_VIEW_PERMS[code].perms
  if (!(perms.has('*') || need.some((p) => perms.has(p)))) return 'none'
  const mod = db.prepare('SELECT module FROM doc_types WHERE code=?').get(code).module
  const external = role === 'store' || role === 'dealer'
  const spec = DOC_SCOPE_RESOLVERS[code]
  if (external && ['purchase', 'inventory', 'produce', 'outsource', 'quality', 'finance', 'oms', 'dealer'].includes(mod)) return 'none'
  if (spec?.binding === 'hq' && external) return 'none'
  if (spec?.builder === 'global') return 'global_only'
  if (spec?.binding === 'store' || spec?.binding === 'dealer') return HQ_ROLES.includes(role) ? 'scoped' : 'bound'
  if (spec?.binding === 'subject') return external ? 'bound' : 'scoped'
  return 'scoped'
}

const ACCESS = new Set(['full', 'scoped', 'bound', 'global_only', 'none'])

test('GET /api/meta/role-matrix', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const storeA = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('RM-A','SENTINEL-STORE-RM')").run().lastInsertRowid)
  const warehouse = await f.account('rm_wh', 'warehouse')
  const store = await f.account('rm_store', 'store', { store_id: storeA })
  const get = (token) => api('/api/meta/role-matrix', { token })
  const text = (d) => JSON.stringify(d)

  await t.test('requires login', async () => {
    assert.equal((await get(undefined)).status, 401)
  })

  await t.test('matrix fidelity: every role x doc type matches an independent derivation', async () => {
    const r = await get(f.admin)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const d = r.body.data
    assert.deepEqual(Object.keys(d).sort(), ['cells', 'doc_types', 'me', 'multi_role', 'my_union', 'restricted', 'roles', 'scope_overrides'])
    const codes = d.doc_types.map((x) => x.code)
    assert.deepEqual([...codes].sort(), Object.keys(DOC_VIEW_PERMS).filter((c) => db.prepare('SELECT 1 FROM doc_types WHERE code=?').get(c)).sort())
    const roleCodes = d.roles.map((x) => x.code)
    assert.deepEqual([...roleCodes].sort(), db.prepare("SELECT code FROM roles WHERE status='active'").all().map((x) => x.code).sort())
    for (const role of roleCodes) {
      for (const code of codes) {
        const got = d.cells[role][code]
        assert.ok(ACCESS.has(got), `${role}/${code}: ${got}`)
        assert.equal(got, expected(db, role, code), `${role}/${code}`)
      }
    }
    // 抽样事实：外部角色看不到内部域；财务总账类对非管理员是 global_only
    assert.equal(d.cells.store.PO, 'none')
    assert.equal(d.cells.admin.VOUCHER, 'full')
    assert.ok(Object.values(d.cells.finance).includes('global_only'))
  })

  await t.test('non-admin callers only get their own role column (no cross-role permission inference)', async () => {
    for (const [acct, role] of [[warehouse, 'warehouse'], [store, 'store']]) {
      const d = (await get(acct.token)).body.data
      assert.equal(d.restricted, true)
      assert.deepEqual(d.roles.map((r) => r.code), [role])
      assert.deepEqual(Object.keys(d.cells), [role])
      const full = (await get(f.admin)).body.data
      assert.equal(full.restricted, false)
      assert.deepEqual(d.cells[role], full.cells[role], 'the single column equals the admin view of that role')
    }
  })

  await t.test('no permission codes or other principals leak', async () => {
    const d = (await get(store.token)).body.data
    const s = text(d)
    for (const p of Object.values(DOC_VIEW_PERMS).flatMap((e) => e.perms)) assert.ok(!s.includes(p), `leaked perm code ${p}`)
    for (const needle of ['SENTINEL-STORE-RM', 'rm_wh', 'rm_store', 'admin_hash', 'password']) assert.ok(!s.includes(needle), needle)
    for (const row of d.doc_types) assert.deepEqual(Object.keys(row).sort(), ['binding', 'code', 'global_only', 'module', 'name'])
    for (const row of d.roles) assert.deepEqual(Object.keys(row).sort(), ['builtin', 'code', 'name'])
    assert.ok(!('scope_overrides' in d) && !('multi_role' in d), 'aggregate distributions are admin-only')
  })

  await t.test('me describes only the caller', async () => {
    const me = (await get(store.token)).body.data.me
    assert.deepEqual(Object.keys(me).sort(), ['data_scope_effective', 'dealer_bound', 'is_admin', 'role', 'role_name', 'store_bound'])
    assert.equal(me.role, 'store')
    assert.equal(me.is_admin, false)
    assert.equal(me.store_bound, true)
    assert.equal(me.dealer_bound, false)
    const wh = (await get(warehouse.token)).body.data.me
    assert.equal(wh.role, 'warehouse')
    assert.equal(wh.store_bound, false)
    const adm = (await get(f.admin)).body.data.me
    assert.equal(adm.is_admin, true)
    assert.equal(adm.data_scope_effective, 'all')
  })
})

// ---- AE2（ADR-0051 补充 2）：自定义角色 / 账号数据范围覆盖分布 / 多角色并集 / 生成器与接口同一份计算 ----
const rank = { full: 5, scoped: 4, global_only: 3, bound: 2, none: 1 }
const best = (list) => list.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'none')

test('AE2: custom roles, scope-override distribution (counts only), multi-role union, generator parity', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const perm = (code) => db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?, ?)')
  const mkRole = (code, name, scope, perms, status = 'active') => {
    db.prepare("INSERT INTO roles (code, name, is_builtin, data_scope, sort_order, status) VALUES (?, ?, 0, ?, 900, ?)").run(code, name, scope, status)
    for (const p of perms) perm().run(code, p)
  }
  mkRole('cust_sales', '自定义销售', 'org', ['sales.order.view'])
  mkRole('cust_fin', '自定义财务', 'subtree', ['finance.voucher.view'])
  mkRole('cust_off', '已停用角色', 'self', ['sales.order.view'], 'inactive')
  const finVoucherPerm = DOC_VIEW_PERMS.VOUCHER.perms[0]
  db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?, ?)').run('cust_fin', finVoucherPerm)
  const mk = (username, role, { scope = '', extra = [], status = 'active' } = {}) => {
    const id = Number(db.prepare("INSERT INTO users (username, password_hash, name, role, data_scope, status) VALUES (?, 'x', ?, ?, ?, ?)").run(username, username, role, scope, status).lastInsertRowid)
    for (const r of [role, ...extra]) db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?, ?)').run(id, r)
    return id
  }
  mk('ae2_s1', 'cust_sales', { scope: 'all' })
  mk('ae2_s2', 'cust_sales', { scope: 'all' })
  mk('ae2_s3', 'cust_sales', { scope: 'self' })
  mk('ae2_s4', 'cust_sales')
  mk('ae2_s5', 'cust_sales', { scope: 'all', status: 'disabled' }) // 停用账号不计
  mk('ae2_w1', 'warehouse', { scope: 'bogus-scope' }) // 非法取值归入 other，原值不外露
  mk('ae2_m1', 'cust_sales', { extra: ['cust_fin'] })
  mk('ae2_m2', 'cust_sales', { extra: ['cust_fin'] })
  mk('ae2_m3', 'warehouse', { extra: ['purchase'] })
  const mine = await f.account('ae2_me', 'cust_sales')
  const mineMulti = await f.account('ae2_multi', 'warehouse')
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES ((SELECT id FROM users WHERE username=?), ?)').run('ae2_multi', 'purchase')
  const get = (token) => api('/api/meta/role-matrix', { token })

  const admin = (await get(f.admin)).body.data
  await t.test('admin: custom active roles are columns with builtin=false, inactive ones are not', () => {
    const byCode = Object.fromEntries(admin.roles.map((r) => [r.code, r]))
    assert.equal(byCode.cust_sales.builtin, false)
    assert.equal(byCode.cust_fin.builtin, false)
    assert.equal(byCode.warehouse.builtin, true)
    assert.ok(!byCode.cust_off)
    for (const code of ['cust_sales', 'cust_fin']) {
      for (const d of admin.doc_types) assert.equal(admin.cells[code][d.code], expected(db, code, d.code), `${code}/${d.code}`)
    }
    assert.equal(admin.cells.cust_sales.SO, 'scoped')
    assert.equal(admin.cells.cust_sales.VOUCHER, 'none')
    assert.equal(admin.cells.cust_fin.VOUCHER, 'global_only')
  })

  await t.test('admin: scope override distribution is counts only, active accounts, unknown values bucketed', () => {
    const so = admin.scope_overrides
    assert.deepEqual(Object.keys(so.cust_sales).sort(), ['by_scope', 'default_scope', 'overridden', 'total'])
    assert.equal(so.cust_sales.default_scope, 'org')
    // cust_sales 主角色账号：s1 s2 s3 s4 m1 m2 + ae2_me（5 个停用账号不计）
    assert.equal(so.cust_sales.total, 7)
    assert.equal(so.cust_sales.overridden, 3)
    assert.deepEqual(so.cust_sales.by_scope, { all: 2, subtree: 0, org: 0, self: 1, dealer: 0, other: 0 })
    assert.equal(so.warehouse.by_scope.other, 1)
    assert.equal(so.warehouse.overridden, 1)
    assert.ok(!JSON.stringify(admin).includes('bogus-scope'))
    assert.ok(!JSON.stringify(admin).includes('ae2_'), 'no account identifiers')
  })

  await t.test('admin: multi-role combos carry counts and a union labelled 并集示例', () => {
    const mr = admin.multi_role
    assert.equal(mr.label, '并集示例')
    const combo = (codes) => mr.combos.find((c) => JSON.stringify(c.roles) === JSON.stringify(codes))
    const sf = combo(['cust_fin', 'cust_sales'])
    assert.equal(sf.accounts, 2)
    assert.deepEqual(Object.keys(sf).sort(), ['accounts', 'cells', 'roles'])
    for (const d of admin.doc_types) assert.equal(sf.cells[d.code], best([admin.cells.cust_sales[d.code], admin.cells.cust_fin[d.code]]), d.code)
    assert.equal(sf.cells.VOUCHER, 'global_only')
    assert.equal(sf.cells.SO, 'scoped')
    const wp = combo(['purchase', 'warehouse'])
    assert.equal(wp.accounts, 2) // ae2_m3 + ae2_multi
    assert.ok(!combo(['cust_sales']), 'single-role accounts are not combos')
    assert.ok(mr.accounts >= 4)
    assert.ok(!JSON.stringify(mr).includes('ae2_'))
  })

  await t.test('non-admin: single column kept; aggregates absent; my_union only for multi-role callers', async () => {
    const d = (await get(mine.token)).body.data
    assert.deepEqual(d.roles.map((r) => r.code), ['cust_sales'])
    assert.equal(d.roles[0].builtin, false)
    assert.deepEqual(Object.keys(d.cells), ['cust_sales'])
    assert.equal(d.my_union, null)
    assert.ok(!('scope_overrides' in d) && !('multi_role' in d))
    const m = (await get(mineMulti.token)).body.data
    assert.deepEqual(m.roles.map((r) => r.code), ['warehouse'])
    assert.deepEqual(m.my_union.roles.map((r) => r.code), ['purchase', 'warehouse'])
    for (const dt of admin.doc_types) assert.equal(m.my_union.cells[dt.code], best([admin.cells.purchase[dt.code], admin.cells.warehouse[dt.code]]), dt.code)
    assert.ok(!('scope_overrides' in m) && !('multi_role' in m))
    assert.ok(!JSON.stringify(m).includes('cust_'), 'other roles not inferable')
  })

  await t.test('generator --json --db reads the same computation (custom roles appear there only)', () => {
    const run = (args) => execFileSync(process.execPath, ['scripts/gen-role-matrix.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
    const plain = JSON.parse(run(['--json']).toString())
    assert.ok(plain.matrix.roles.every((r) => r.builtin === true), 'default output is built-in only')
    assert.ok(!plain.matrix.roles.some((r) => r.code.startsWith('cust_')))
    const tenant = JSON.parse(run(['--json', `--db=${path.join(db.name)}`]).toString()).tenant
    assert.deepEqual(tenant.roles, admin.roles)
    assert.deepEqual(tenant.cells, admin.cells)
    assert.deepEqual(tenant.scope_overrides, admin.scope_overrides)
    assert.deepEqual(tenant.multi_role, admin.multi_role)
    assert.ok(tenant.roles.some((r) => r.code === 'cust_sales'))
    for (const [code, row] of Object.entries(plain.matrix.cells)) assert.deepEqual(admin.cells[code], row, `built-in ${code} column equals endpoint`)
    for (const bad of [['--check', '--db=/x'], ['--db=relative.db', '--json'], ['--db=/nonexistent-ae2.db', '--json'], ['--db=/x']]) {
      assert.throws(() => run(bad), (e) => e.status === 2, bad.join(' '))
    }
  })
})
