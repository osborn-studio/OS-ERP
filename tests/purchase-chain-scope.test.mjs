/**
 * ============================================================================
 * 文件标识：tests/purchase-chain-scope.test.mjs ｜ 测试：采购链读接口按权限与组织范围收口（ADR-0017）
 * ============================================================================
 * 【职责】守住 ADR-0017 的决定：`/api/purchase/chain/overview`、`/chain/flow`、后段四张单的列表
 *   （requisitions / invoices / settlements / payments）与 `/payables` 跟 `/chain/todos`（ADR-0015）
 *   **同一道门、同一份范围判据**：
 *     · 外部主体（store / dealer）与没有采购读权限的角色（sales）403，未登录 401；
 *     · 受限范围账号只看到自己组织的单据（请购 / 发票 / 结算 / 付款按 `org_id`，
 *       采购订单经 `warehouses.org_id`），总览的计数 / 金额按**同一个集合**算；
 *     · 归属为 NULL 的单据对 `org` / `subtree` 范围不可见，对全局范围（admin）可见；
 *     · admin 口径不变。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，
 *   单据直接写库（只为摆出"谁该看到什么"的局面）。演示种子里后段四张单的 `org_id` **全为 NULL**，
 *   这正好把"NULL 对受限不可见"变成可断言的事实，而不是碰巧为空。
 *
 * 【改它要注意什么】断言是"精确集合 / 精确计数"（看得到 A、看不到 B、总览 total 等于 SQL 直数），
 *   不是"比全库少"。总览的期望值用测试自己的 SQL 直算，不调被测的 helper。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-purchase-chain-scope-'))
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
  return { dir, api, db, admin, login, account }
}

const forbidden = (r) => assert.equal(r.status, 403, JSON.stringify(r.body))
const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }

/** 本 ADR 收口的全部读接口（与 ADR-0015 的 todos 同一道门） */
const READ_ROUTES = [
  '/api/purchase/chain/overview',
  '/api/purchase/chain/flow',
  '/api/purchase/requisitions',
  '/api/purchase/invoices',
  '/api/purchase/settlements',
  '/api/purchase/payments',
  '/api/purchase/payables'
]
const LIST_ROUTES = ['/api/purchase/requisitions', '/api/purchase/invoices', '/api/purchase/settlements', '/api/purchase/payments']

test('purchase chain read routes share the todos gate and org scope; overview totals follow the scoped set', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  // 两个互不嵌套的组织：A = 第一个仓的组织，B = 另一棵子树上的仓的组织；P = A 的父组织（subtree 用）。
  const whs = db.prepare(`SELECT w.id, w.org_id, o.path, o.parent_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id`).all()
  const whA = whs[0]
  const whB = whs.find((w) => !w.path.startsWith(whA.path) && !whA.path.startsWith(w.path) &&
    !w.path.startsWith(db.prepare('SELECT path FROM orgs WHERE id=?').get(whA.parent_id).path))
  assert.ok(whA && whB, 'demo data must provide warehouses on two disjoint org branches')
  const parentA = whA.parent_id
  assert.ok(parentA, 'org A must have a parent (subtree fixture)')
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id

  // 摆局面：每张单 A / B / NULL 各一张；采购订单两张改仓到 A / B，其余演示订单保持原仓。
  db.prepare(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id)
              VALUES (?,?,date('now'),'submitted',?,?)`).run('PRQ-SC-A', whA.org_id, 100, whA.id)
  db.prepare(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id)
              VALUES (?,?,date('now'),'submitted',?,?)`).run('PRQ-SC-B', whB.org_id, 200, whB.id)
  db.prepare(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id)
              VALUES (?,?,date('now'),'submitted',?,?)`).run('PRQ-SC-NULL', null, 300, null)
  const insInv = db.prepare(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status)
                             VALUES (?,?,?,date('now'),?,?,?,'submitted')`)
  insInv.run('PI-SC-A', whA.org_id, supplier, 1000, 130, 1130)
  insInv.run('PI-SC-B', whB.org_id, supplier, 2000, 260, 2260)
  insInv.run('PI-SC-NULL', null, supplier, 3000, 390, 3390)
  const insSt = db.prepare(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status)
                            VALUES (?,?,?,date('now'),?,?,?,'audited')`)
  insSt.run('PST-SC-A', whA.org_id, supplier, 500, 100, 5)
  insSt.run('PST-SC-B', whB.org_id, supplier, 700, 200, 7)
  insSt.run('PST-SC-NULL', null, supplier, 900, 300, 9)
  const insPay = db.prepare(`INSERT INTO purchase_payments (doc_no, org_id, supplier_id, pay_date, amount, settled_amount, status)
                             VALUES (?,?,?,date('now'),?,?,'approved')`)
  insPay.run('PAY-SC-A', whA.org_id, supplier, 50, 10)
  insPay.run('PAY-SC-B', whB.org_id, supplier, 60, 20)
  insPay.run('PAY-SC-NULL', null, supplier, 70, 30)
  const [poA, poB] = db.prepare('SELECT id, doc_no FROM purchase_orders ORDER BY id LIMIT 2').all()
  assert.ok(poA && poB, 'demo data must provide two purchase orders')
  db.prepare("UPDATE purchase_orders SET status='submitted', warehouse_id=? WHERE id=?").run(whA.id, poA.id)
  db.prepare("UPDATE purchase_orders SET status='submitted', warehouse_id=? WHERE id=?").run(whB.id, poB.id)

  const docNos = (r) => okData(r).list.map((x) => x.doc_no)
  const scopedNos = async (token) => {
    const out = {}
    for (const route of LIST_ROUTES) out[route] = docNos(await api(route, { token }))
    return out
  }
  const expectExact = (nos, visible, hidden) => {
    for (const n of visible) assert.ok(nos.includes(n), `must see ${n}: ${JSON.stringify(nos)}`)
    for (const n of hidden) assert.ok(!nos.includes(n), `must not see ${n}: ${JSON.stringify(nos)}`)
  }

  await t.test('external principals, roles without a purchase read permission and anonymous callers are rejected on every route', async () => {
    const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('SC1','Scope store')").run().lastInsertRowid)
    const dealerId = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('SD1','Scope dealer')").run().lastInsertRowid)
    const store = await f.account('sc_store', 'store', { store_id: storeId })
    const dealer = await f.account('sc_dealer', 'dealer', { dealer_id: dealerId })
    const sales = await f.account('sc_sales', 'sales', { data_scope: 'all' })
    for (const route of READ_ROUTES) {
      for (const u of [store, dealer, sales]) forbidden(await api(route, { token: u.token }))
      assert.equal((await api(route)).status, 401, route)
    }
  })

  await t.test('admin keeps the global lists and overview (NULL-org rows included)', async () => {
    const nos = await scopedNos(f.admin)
    expectExact(nos['/api/purchase/requisitions'], ['PRQ-SC-A', 'PRQ-SC-B', 'PRQ-SC-NULL'], [])
    expectExact(nos['/api/purchase/invoices'], ['PI-SC-A', 'PI-SC-B', 'PI-SC-NULL'], [])
    expectExact(nos['/api/purchase/settlements'], ['PST-SC-A', 'PST-SC-B', 'PST-SC-NULL'], [])
    expectExact(nos['/api/purchase/payments'], ['PAY-SC-A', 'PAY-SC-B', 'PAY-SC-NULL'], [])
    const ov = okData(await api('/api/purchase/chain/overview', { token: f.admin }))
    assert.equal(ov.requisition.total, db.prepare('SELECT COUNT(*) n FROM purchase_requisitions').get().n)
    assert.equal(ov.order.total, db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n)
    assert.equal(ov.invoice.total, db.prepare("SELECT COUNT(*) n FROM purchase_invoices WHERE status<>'voided'").get().n)
    assert.equal(ov.settlement.total, db.prepare("SELECT COUNT(*) n FROM purchase_settlements WHERE status<>'voided'").get().n)
    assert.equal(ov.payment.total, db.prepare("SELECT COUNT(*) n FROM purchase_payments WHERE status<>'voided'").get().n)
    assert.ok(Array.isArray(okData(await api('/api/purchase/chain/flow', { token: f.admin })).steps))
    assert.ok(okData(await api('/api/purchase/payables', { token: f.admin })).list.length >= 1)
  })

  await t.test('warehouse user restricted to org A sees only A rows, and the overview is computed over that same set', async () => {
    const wh = await f.account('sc_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
    const nos = await scopedNos(wh.token)
    expectExact(nos['/api/purchase/requisitions'], ['PRQ-SC-A'], ['PRQ-SC-B', 'PRQ-SC-NULL'])
    expectExact(nos['/api/purchase/invoices'], ['PI-SC-A'], ['PI-SC-B', 'PI-SC-NULL'])
    expectExact(nos['/api/purchase/settlements'], ['PST-SC-A'], ['PST-SC-B', 'PST-SC-NULL'])
    expectExact(nos['/api/purchase/payments'], ['PAY-SC-A'], ['PAY-SC-B', 'PAY-SC-NULL'])
    // 列表页的 summary 也要跟着集合走（不是"列表少了、合计还是全库"）
    const inv = okData(await api('/api/purchase/invoices', { token: wh.token }))
    assert.equal(inv.summary.total, 1130)
    const st = okData(await api('/api/purchase/settlements', { token: wh.token }))
    assert.equal(st.summary.settle, 500)
    const pay = okData(await api('/api/purchase/payments', { token: wh.token }))
    assert.equal(pay.summary.amount, 50)
    // 总览：每一块都等于"按 A 组织直数"的结果
    const ov = okData(await api('/api/purchase/chain/overview', { token: wh.token }))
    assert.deepEqual(
      { total: ov.requisition.total, submitted: ov.requisition.submitted },
      { total: 1, submitted: 1 }
    )
    const poOracle = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(total_amount),0) amount,
                                        SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) pending_approve
                                   FROM purchase_orders WHERE warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)`).get(whA.org_id)
    assert.ok(poOracle.total >= 1)
    assert.equal(ov.order.total, poOracle.total)
    assert.equal(Math.round(ov.order.amount * 100), Math.round(poOracle.amount * 100))
    assert.equal(ov.order.pending_approve, poOracle.pending_approve)
    assert.deepEqual({ total: ov.invoice.total, amount: ov.invoice.amount }, { total: 1, amount: 1130 })
    assert.deepEqual({ total: ov.settlement.total, amount: ov.settlement.amount, paid: ov.settlement.paid, open: ov.settlement.open }, { total: 1, amount: 500, paid: 100, open: 400 })
    assert.deepEqual({ total: ov.payment.total, amount: ov.payment.amount }, { total: 1, amount: 50 })
    // 供应商榜 / 应付榜 / 趋势也按同一集合
    const topTotal = ov.top_suppliers.reduce((s, x) => s + Number(x.order_count), 0)
    assert.equal(topTotal, db.prepare(`SELECT COUNT(*) n FROM purchase_orders WHERE status<>'cancelled'
                                        AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)`).get(whA.org_id).n)
    assert.equal(ov.payable.reduce((s, x) => s + Number(x.open_amount), 0), 400)
    assert.equal(ov.trend.reduce((s, x) => s + Number(x.amount), 0), 500)
    // 应付台账同口径
    const payables = okData(await api('/api/purchase/payables', { token: wh.token }))
    assert.equal(payables.total.settle_amount, 500)
    assert.equal(payables.total.open_amount, 400)
    // 业务流定义本身不含单据，只需进门即可
    assert.ok(Array.isArray(okData(await api('/api/purchase/chain/flow', { token: wh.token })).steps))
  })

  await t.test('subtree scope at the parent of A sees A (and its siblings) but never NULL-org rows; global scope sees them', async () => {
    const sub = await f.account('sc_sub', 'purchase', { org_id: parentA, data_scope: 'subtree' })
    const nos = await scopedNos(sub.token)
    expectExact(nos['/api/purchase/requisitions'], ['PRQ-SC-A'], ['PRQ-SC-B', 'PRQ-SC-NULL'])
    expectExact(nos['/api/purchase/invoices'], ['PI-SC-A'], ['PI-SC-B', 'PI-SC-NULL'])
    expectExact(nos['/api/purchase/settlements'], ['PST-SC-A'], ['PST-SC-B', 'PST-SC-NULL'])
    expectExact(nos['/api/purchase/payments'], ['PAY-SC-A'], ['PAY-SC-B', 'PAY-SC-NULL'])
    const ov = okData(await api('/api/purchase/chain/overview', { token: sub.token }))
    assert.equal(ov.requisition.total, 1)
    assert.equal(ov.payment.total, 1)
    // 同角色、全局范围 ⇒ NULL 行可见
    const glob = await f.account('sc_glob', 'purchase', { data_scope: 'all' })
    const nosG = await scopedNos(glob.token)
    expectExact(nosG['/api/purchase/requisitions'], ['PRQ-SC-A', 'PRQ-SC-B', 'PRQ-SC-NULL'], [])
    expectExact(nosG['/api/purchase/payments'], ['PAY-SC-A', 'PAY-SC-B', 'PAY-SC-NULL'], [])
    // 没有组织归属的受限账号：空范围 ⇒ 空列表与零总览（200，不是 403，也不是全库）
    const none = await f.account('sc_none', 'purchase', { data_scope: 'org' })
    for (const route of LIST_ROUTES) assert.deepEqual(okData(await api(route, { token: none.token })).list, [], route)
    const ovNone = okData(await api('/api/purchase/chain/overview', { token: none.token }))
    assert.equal(ovNone.requisition.total, 0)
    assert.equal(ovNone.order.total, 0)
    assert.deepEqual(ovNone.top_suppliers, [])
    assert.deepEqual(okData(await api('/api/purchase/payables', { token: none.token })).list, [])
  })
})
