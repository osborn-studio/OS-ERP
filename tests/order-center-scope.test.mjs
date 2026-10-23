/**
 * ============================================================================
 * 文件标识：tests/order-center-scope.test.mjs ｜ 测试：订货中心按客户归属组织收口（ADR-0027）
 * ============================================================================
 * 【职责】守住 ADR-0027 的决定：订货中心总览、客户列表 / 客户树 / 客户详情、订货单列表 / 详情 / 流转、
 *   授信、对账单列表 / 详情 / 动作，对**内部账号**按「客户归属组织」收口（同一份谓词 `ocScope`）：
 *     · org / subtree 范围只看到自己组织（及下级）的客户及其订单、授信、对账单；
 *     · 归属 NULL 的客户（下游客户先继承上级客户的组织）对受限范围不可见，对全局范围可见；
 *     · 无组织归属的受限账号：200 + 空 / 零，不是 403，也不是全库；
 *     · 范围外的详情 / 动作与不存在同形（404），且不产生任何写；
 *     · 外部主体（经销商 / 门店）自视图不变：只看自己，别人的 ID 仍是 403。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，
 *   客户 / 订单 / 对账单直接写库，只为摆出"谁该看到什么"。订单的 `org_id`（货主列）故意留 NULL 或 HQ，
 *   证明范围不再取决于货主列。
 *
 * 【改它要注意什么】期望值用测试自己的 SQL 直算；不调被测的 helper。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-oc-scope-'))
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
    return r.body.data.token
  }
  const admin = await login('admin', '12345')
  const account = async (username, role, extra = {}) => {
    const password = secret()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { id: r.body.data.id, username, password, token: await login(username, password) }
  }
  return { api, db, admin, account }
}

const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const flatten = (nodes) => (Array.isArray(nodes) ? nodes : [nodes]).flatMap((n) => [n.id, ...flatten(n.children || [])])

test('order center: internal org/subtree scope follows the customer owning org; external self-views unchanged', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  // 摆局面：A / B 两家门店（同一父组织下的两个兄弟组织），D 一家经销商（另一条分支），
  // 下游客户 DS（组织 NULL，上级 = D），NUL（组织 NULL、无上级）。
  const custOf = (orgId) => db.prepare('SELECT * FROM oc_customers WHERE org_id=? ORDER BY id LIMIT 1').get(orgId)
  const A = custOf(5)
  const B = custOf(7)
  const D = custOf(19)
  assert.ok(A && B && D && A.source_type === 'store' && D.source_type === 'dealer', 'demo data must provide customers on orgs 5 / 7 / 19')
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=5').get().parent_id
  assert.equal(db.prepare('SELECT parent_id FROM orgs WHERE id=7').get().parent_id, parentOrg)
  const insCust = db.prepare(`INSERT INTO oc_customers (code,name,source_type,source_id,parent_customer_id,level,channel,org_id,settle_type,credit_limit,admit_status)
                              VALUES (?,?,?,?,?,'bronze','sub_dealer',NULL,'credit',1000,'active')`)
  const DS = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(Number(insCust.run('SC_DS', 'scope downstream', 'downstream', -9001, D.id).lastInsertRowid))
  const NUL = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(Number(insCust.run('SC_NUL', 'scope null-org', 'downstream', -9002, null).lastInsertRowid))
  const insOrd = db.prepare(`INSERT INTO oc_orders (doc_no,customer_id,customer_type,customer_name,order_date,status,total_qty,total_amount,credit_hold,need_approval,org_id)
                             VALUES (?,?,?,?,date('now'),'submitted',1,?,0,1,?)`)
  const insStm = db.prepare(`INSERT INTO oc_statements (doc_no,customer_id,customer_name,period_start,period_end,total_amount) VALUES (?,?,?,'2026-01-01','2026-01-31',?)`)
  const fx = {}
  let n = 0
  for (const [key, c] of Object.entries({ A, B, D, DS, NUL })) {
    n += 1
    const orderId = Number(insOrd.run(`OC-SC-${key}`, c.id, c.source_type, c.name, 100 * n, key === 'A' ? 1 : null).lastInsertRowid)
    const stmId = Number(insStm.run(`OCS-SC-${key}`, c.id, c.name, 100 * n).lastInsertRowid)
    db.prepare("INSERT INTO oc_credit_ledger (customer_id,order_id,doc_no,change_type,amount,remark) VALUES (?,?,?,'occupy',?,'scope-fixture')").run(c.id, orderId, `OC-SC-${key}`, 10 * n)
    fx[key] = { cust: c, orderId, stmId }
  }
  const ids = (sql, ...args) => db.prepare(sql).all(...args).map((r) => r.id).sort((a, b) => a - b)
  const sorted = (xs) => [...xs].sort((a, b) => a - b)
  // 期望集合：按客户归属组织（下游继承上级）直算
  const customersOf = (orgIds) => ids(
    `SELECT c.id FROM oc_customers c WHERE COALESCE(c.org_id,(SELECT p.org_id FROM oc_customers p WHERE p.id=c.parent_customer_id)) IN (${orgIds.map(() => '?').join(',')})`, ...orgIds)

  const orgA = await f.account('ocs_org_a', 'warehouse', { org_id: 5, data_scope: 'org' })
  const sub = await f.account('ocs_sub', 'warehouse', { org_id: parentOrg, data_scope: 'subtree' })
  const dealerOrg = await f.account('ocs_org_d', 'warehouse', { org_id: 19, data_scope: 'org' })
  const none = await f.account('ocs_none', 'warehouse', { data_scope: 'org' })
  const glob = await f.account('ocs_glob', 'warehouse', { data_scope: 'all' })

  const listIds = async (route, token, key = 'id') => {
    const r = await api(`${route}${route.includes('?') ? '&' : '?'}pageSize=500`, { token })
    return sorted(okData(r).list.map((x) => x[key]))
  }
  const fixtureOrders = (rows) => rows.filter((r) => String(r.doc_no).startsWith('OC-SC-')).map((r) => r.doc_no).sort()
  const fixtureStatements = (rows) => rows.filter((r) => String(r.doc_no).startsWith('OCS-SC-')).map((r) => r.doc_no).sort()
  const allOrders = async (token) => okData(await api('/api/order-center/orders?pageSize=500', { token })).list
  const allStatements = async (token) => okData(await api('/api/order-center/statements?pageSize=500', { token })).list

  await t.test('org-A internal user sees only customers owned by org A across lists, overview, tree, orders and statements', async () => {
    const want = customersOf([5])
    assert.deepEqual(want, [A.id])
    assert.deepEqual(await listIds('/api/order-center/customers', orgA.token), want)
    const ov = okData(await api('/api/order-center/overview', { token: orgA.token }))
    assert.equal(ov.customers.total, want.length)
    assert.ok(ov.creditRisk.every((x) => want.includes(x.id)))
    assert.ok(ov.blockedCustomers.every((x) => want.includes(x.id)))
    assert.ok(ov.pendingApproval.every((x) => String(x.doc_no).startsWith('OC-SC-A')), JSON.stringify(ov.pendingApproval))
    const orderOracle = db.prepare(`SELECT COUNT(*) c, ROUND(COALESCE(SUM(total_amount),0),2) amt FROM oc_orders WHERE customer_id IN (${want.join(',')}) AND status NOT IN ('cancelled','rejected')`).get()
    assert.equal(ov.totals.orders, orderOracle.c)
    assert.equal(ov.totals.amount, orderOracle.amt)
    assert.deepEqual(sorted(flatten(okData(await api('/api/order-center/customers/tree', { token: orgA.token })))), want)
    const orders = await allOrders(orgA.token)
    assert.ok(orders.length >= 1 && orders.every((o) => want.includes(o.customer_id)), 'orders limited to org A customers')
    assert.deepEqual(fixtureOrders(orders), ['OC-SC-A'])
    const byStatusTotal = okData(await api('/api/order-center/orders', { token: orgA.token })).byStatus.reduce((s, x) => s + x.c, 0)
    assert.equal(byStatusTotal, db.prepare(`SELECT COUNT(*) c FROM oc_orders WHERE customer_id IN (${want.join(',')})`).get().c)
    assert.deepEqual(fixtureStatements(await allStatements(orgA.token)), ['OCS-SC-A'])
    assert.ok((await allStatements(orgA.token)).every((s) => want.includes(s.customer_id)))
  })

  await t.test('subtree at the parent org sees A and B, never D / downstream / NULL-org customers', async () => {
    const want = customersOf(db.prepare('SELECT id FROM orgs WHERE path LIKE (SELECT path FROM orgs WHERE id=?) || \'%\'').all(parentOrg).map((r) => r.id))
    assert.ok(want.includes(A.id) && want.includes(B.id) && !want.includes(D.id) && !want.includes(DS.id) && !want.includes(NUL.id))
    assert.deepEqual(await listIds('/api/order-center/customers', sub.token), want)
    assert.equal(okData(await api('/api/order-center/overview', { token: sub.token })).customers.total, want.length)
    assert.deepEqual(sorted(flatten(okData(await api('/api/order-center/customers/tree', { token: sub.token })))), want)
    assert.deepEqual(fixtureOrders(await allOrders(sub.token)), ['OC-SC-A', 'OC-SC-B'])
    assert.deepEqual(fixtureStatements(await allStatements(sub.token)), ['OCS-SC-A', 'OCS-SC-B'])
  })

  await t.test('downstream customers inherit the parent customer org; NULL-org customers are invisible to restricted scopes', async () => {
    const want = customersOf([19])
    assert.ok(want.includes(D.id) && want.includes(DS.id) && !want.includes(NUL.id))
    assert.deepEqual(await listIds('/api/order-center/customers', dealerOrg.token), want)
    assert.deepEqual(fixtureOrders(await allOrders(dealerOrg.token)), ['OC-SC-D', 'OC-SC-DS'])
    const tree = okData(await api('/api/order-center/customers/tree', { token: dealerOrg.token }))
    assert.ok(flatten(tree).includes(DS.id))
    for (const tok of [orgA.token, sub.token, dealerOrg.token]) {
      assert.ok(!(await listIds('/api/order-center/customers', tok)).includes(NUL.id))
      assert.ok(!fixtureOrders(await allOrders(tok)).includes('OC-SC-NUL'))
    }
  })

  await t.test('global scope sees everything including NULL-org customers; admin unchanged', async () => {
    const total = db.prepare('SELECT COUNT(*) c FROM oc_customers').get().c
    for (const tok of [f.admin, glob.token]) {
      assert.equal(okData(await api('/api/order-center/overview', { token: tok })).customers.total, total)
      assert.ok((await listIds('/api/order-center/customers', tok)).includes(NUL.id))
      assert.deepEqual(fixtureOrders(await allOrders(tok)), ['OC-SC-A', 'OC-SC-B', 'OC-SC-D', 'OC-SC-DS', 'OC-SC-NUL'])
      assert.deepEqual(fixtureStatements(await allStatements(tok)), ['OCS-SC-A', 'OCS-SC-B', 'OCS-SC-D', 'OCS-SC-DS', 'OCS-SC-NUL'])
      assert.equal(okData(await api(`/api/order-center/credit/${NUL.id}`, { token: tok })).customer.id, NUL.id)
    }
  })

  await t.test('restricted account without an org gets an empty scope: 200 + zeros, not 403 and not the whole library', async () => {
    assert.deepEqual(await listIds('/api/order-center/customers', none.token), [])
    const ov = okData(await api('/api/order-center/overview', { token: none.token }))
    assert.equal(ov.customers.total, 0)
    assert.equal(ov.totals.orders, 0)
    assert.deepEqual(ov.creditRisk, [])
    assert.deepEqual(ov.pendingApproval, [])
    assert.deepEqual(okData(await api('/api/order-center/customers/tree', { token: none.token })), [])
    assert.deepEqual(await allOrders(none.token), [])
    assert.deepEqual(await allStatements(none.token), [])
  })

  await t.test('out-of-scope details and actions are 404 (same shape as missing) and write nothing', async () => {
    const missing = await api('/api/order-center/customers/99999999', { token: orgA.token })
    assert.equal(missing.status, 404)
    const before = db.prepare('SELECT status FROM oc_orders WHERE id=?').get(fx.B.orderId).status
    const stmBefore = db.prepare('SELECT status FROM oc_statements WHERE id=?').get(fx.B.stmId).status
    const creditBefore = db.prepare('SELECT COUNT(*) c FROM oc_credit_ledger').get().c
    const probes = [
      [`/api/order-center/customers/${B.id}`], [`/api/order-center/credit/${B.id}`],
      [`/api/order-center/customers/tree?root=${B.id}`], [`/api/order-center/catalog?customer_id=${B.id}`],
      [`/api/order-center/orders/${fx.B.orderId}`], [`/api/order-center/orders/${fx.B.orderId}/repeat`],
      [`/api/order-center/orders/${fx.B.orderId}/actions`], [`/api/order-center/statements/${fx.B.stmId}`],
      [`/api/order-center/orders?customer_id=${B.id}`],
      [`/api/order-center/orders/${fx.B.orderId}/cancel`, { body: {} }],
      [`/api/order-center/statements/${fx.B.stmId}/confirm`, { body: {} }],
      [`/api/order-center/statements/${fx.B.stmId}/void`, { body: { reason: 'x' } }],
      [`/api/order-center/customers/${B.id}/admit`, { body: { decision: 'freeze' } }],
      ['/api/order-center/quote', { body: { customer_id: B.id, items: [] } }],
      ['/api/order-center/orders', { body: { customer_id: B.id, items: [] } }],
      ['/api/order-center/statements', { body: { customer_id: B.id, period_start: '2026-01-01', period_end: '2026-01-31' } }]
    ]
    for (const [route, opts = {}] of probes) {
      const r = await api(route, { token: orgA.token, ...opts })
      assert.equal(r.status, 404, `${route} => ${r.status} ${JSON.stringify(r.body)}`)
    }
    // 范围内的同类请求仍可用
    assert.equal((await api(`/api/order-center/customers/${A.id}`, { token: orgA.token })).status, 200)
    assert.equal((await api(`/api/order-center/credit/${A.id}`, { token: orgA.token })).status, 200)
    assert.equal((await api(`/api/order-center/orders/${fx.A.orderId}`, { token: orgA.token })).status, 200)
    assert.equal((await api(`/api/order-center/statements/${fx.A.stmId}`, { token: orgA.token })).status, 200)
    assert.equal((await api(`/api/order-center/customers/tree?root=${A.id}`, { token: orgA.token })).status, 200)
    assert.equal(db.prepare('SELECT status FROM oc_orders WHERE id=?').get(fx.B.orderId).status, before)
    assert.equal(db.prepare('SELECT status FROM oc_statements WHERE id=?').get(fx.B.stmId).status, stmBefore)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM oc_credit_ledger').get().c, creditBefore)
    assert.equal(db.prepare('SELECT admit_status FROM oc_customers WHERE id=?').get(B.id).admit_status, 'active')
  })

  await t.test('customer detail and parent_name do not reveal out-of-scope relatives', async () => {
    const detail = okData(await api(`/api/order-center/customers/${D.id}`, { token: dealerOrg.token }))
    assert.ok(detail.children.some((c) => c.id === DS.id))
    // DS 继承 D 的组织，A 的账号看不到 D，也就看不到 D 的下级
    const sub19 = await f.account('ocs_org_d2', 'warehouse', { org_id: 19, data_scope: 'org' })
    const listed = okData(await api('/api/order-center/customers?pageSize=500', { token: sub19.token })).list
    const ds = listed.find((x) => x.id === DS.id)
    assert.equal(ds.parent_name, D.name)
    // 把 DS 挪到别的组织：D 账号的详情 children 不再包含它
    db.prepare('UPDATE oc_customers SET org_id=7 WHERE id=?').run(DS.id)
    const detail2 = okData(await api(`/api/order-center/customers/${D.id}`, { token: dealerOrg.token }))
    assert.ok(!detail2.children.some((c) => c.id === DS.id), 'children outside scope hidden')
    const listedB = okData(await api('/api/order-center/customers?pageSize=500', { token: sub.token })).list
    assert.equal(listedB.find((x) => x.id === DS.id).parent_name, null, 'parent outside scope is not named')
    db.prepare('UPDATE oc_customers SET org_id=NULL WHERE id=?').run(DS.id)
  })

  await t.test('dealer and store self-views are unchanged: only self, foreign ids stay 403', async () => {
    const dealerRow = db.prepare('SELECT id FROM dealers WHERE id=?').get(D.source_id)
    const storeRow = db.prepare('SELECT id FROM stores WHERE id=?').get(A.source_id)
    const dealer = await f.account('ocs_dealer', 'dealer', { dealer_id: dealerRow.id })
    const store = await f.account('ocs_store', 'store', { store_id: storeRow.id })
    for (const [u, self, other, ownKey] of [[dealer, D, B, 'D'], [store, A, D, 'A']]) {
      assert.deepEqual(await listIds('/api/order-center/customers', u.token), [self.id])
      const ov = okData(await api('/api/order-center/overview', { token: u.token }))
      assert.equal(ov.customers.total, 1)
      assert.ok(ov.creditRisk.every((x) => x.id === self.id))
      const tree = okData(await api('/api/order-center/customers/tree', { token: u.token }))
      assert.equal(tree.id, self.id)
      assert.deepEqual(tree.children, [])
      assert.ok((await allOrders(u.token)).every((o) => o.customer_id === self.id))
      assert.ok(fixtureOrders(await allOrders(u.token)).includes(`OC-SC-${ownKey}`))
      assert.ok((await allStatements(u.token)).every((s) => s.customer_id === self.id))
      assert.equal((await api(`/api/order-center/customers/${self.id}`, { token: u.token })).status, 200)
      for (const route of [
        `/api/order-center/customers/${other.id}`, `/api/order-center/credit/${other.id}`,
        `/api/order-center/customers/tree?root=${other.id}`, `/api/order-center/catalog?customer_id=${other.id}`,
        `/api/order-center/orders/${fx[other === B ? 'B' : 'D'].orderId}`, `/api/order-center/statements/${fx[other === B ? 'B' : 'D'].stmId}`
      ]) assert.equal((await api(route, { token: u.token })).status, 403, route)
    }
  })
})
