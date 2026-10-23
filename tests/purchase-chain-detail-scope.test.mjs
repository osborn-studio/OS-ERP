/**
 * ============================================================================
 * 文件标识：tests/purchase-chain-detail-scope.test.mjs ｜ 测试：采购链详情与辅助读接口范围收口（ADR-0020）
 * ============================================================================
 * 【职责】守住 ADR-0020：ADR-0017 之后仍只 requireAuth 的读接口全部过同一道门，并按单据所属组织判定：
 *     · 详情 `/requisitions|invoices|settlements|payments/:id`、`/chain/actions`、`/orders/:id/closes`：
 *       范围外的单据 404（与"不存在"不可区分），范围内 200；外部主体 / 无采购读权限 403，未登录 401；
 *     · `/catalog`、`/price`、`/price-preview`：主数据，要求采购读权限，不按组织过滤；
 *     · `/invoices-available-lines`、`/settlement-preview`、`/payment-plan`：聚合按调用者范围计算，
 *       受限账号看不到范围外组织的入库 / 发票 / 结算。
 *
 * 【夹具口径】同 purchase-chain-scope.test.mjs：test 运行时、临时数据目录、随机回环端口，单据直接写库。
 * 【改它要注意什么】断言是精确状态码与精确数值，不是"比全库少"。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-purchase-detail-scope-'))
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
const notFound = (r, m) => assert.equal(r.status, 404, `${m}: ${JSON.stringify(r.body)}`)

test('purchase chain detail and auxiliary reads share the read gate and per-document org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whs = db.prepare(`SELECT w.id, w.org_id, o.path, o.parent_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id`).all()
  const whA = whs[0]
  const whB = whs.find((w) => !w.path.startsWith(whA.path) && !whA.path.startsWith(w.path) &&
    !w.path.startsWith(db.prepare('SELECT path FROM orgs WHERE id=?').get(whA.parent_id).path))
  assert.ok(whA && whB, 'demo data must provide warehouses on two disjoint org branches')
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const id = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid)

  const prq = {
    A: id(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id) VALUES ('PRQ-D-A',?,date('now'),'submitted',100,?)`, whA.org_id, whA.id),
    B: id(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id) VALUES ('PRQ-D-B',?,date('now'),'submitted',200,?)`, whB.org_id, whB.id),
    N: id(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount) VALUES ('PRQ-D-N',NULL,date('now'),'submitted',300)`)
  }
  const inv = (no, org, amt) => id(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status) VALUES (?,?,?,date('now'),?,0,?,'verified')`, no, org, supplier, amt, amt)
  const pi = { A: inv('PI-D-A', whA.org_id, 1000), B: inv('PI-D-B', whB.org_id, 2000), N: inv('PI-D-N', null, 3000) }
  const st = (no, org, amt) => id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES (?,?,?,date('now'),?,0,0,'audited')`, no, org, supplier, amt)
  const pst = { A: st('PST-D-A', whA.org_id, 500), B: st('PST-D-B', whB.org_id, 700), N: st('PST-D-N', null, 900) }
  const pay = (no, org, amt) => id(`INSERT INTO purchase_payments (doc_no, org_id, supplier_id, pay_date, amount, settled_amount, status) VALUES (?,?,?,date('now'),?,0,'approved')`, no, org, supplier, amt)
  const pays = { A: pay('PAY-D-A', whA.org_id, 50), B: pay('PAY-D-B', whB.org_id, 60), N: pay('PAY-D-N', null, 70) }
  const [poA, poB] = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 2').all()
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whA.id, poA.id)
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whB.id, poB.id)

  const DETAIL = (k) => [
    [`/api/purchase/requisitions/${prq[k]}`], [`/api/purchase/invoices/${pi[k]}`],
    [`/api/purchase/settlements/${pst[k]}`], [`/api/purchase/payments/${pays[k]}`],
    [`/api/purchase/chain/actions?doc_type=PRQ&id=${prq[k]}`], [`/api/purchase/chain/actions?doc_type=PI&id=${pi[k]}`],
    [`/api/purchase/chain/actions?doc_type=PST&id=${pst[k]}`], [`/api/purchase/chain/actions?doc_type=PAY&id=${pays[k]}`]
  ].map((x) => x[0])
  const orderRoutes = (o) => [`/api/purchase/orders/${o}/closes`, `/api/purchase/chain/actions?doc_type=PO&id=${o}`]
  const AUX = [
    '/api/purchase/catalog', `/api/purchase/price?sku_id=1&supplier_id=${supplier}`,
    `/api/purchase/invoices-available-lines?supplier_id=${supplier}`, `/api/purchase/settlement-preview?supplier_id=${supplier}`,
    `/api/purchase/payment-plan?supplier_id=${supplier}&amount=100`
  ]
  const ALL_GET = [...DETAIL('A'), ...orderRoutes(poA.id), ...AUX]

  await t.test('external principals, roles without purchase read, and anonymous callers are rejected everywhere', async () => {
    const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('DS1','Detail store')").run().lastInsertRowid)
    const dealerId = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('DD1','Detail dealer')").run().lastInsertRowid)
    const store = await f.account('dt_store', 'store', { store_id: storeId })
    const dealer = await f.account('dt_dealer', 'dealer', { dealer_id: dealerId })
    const sales = await f.account('dt_sales', 'sales', { data_scope: 'all' })
    for (const route of ALL_GET) {
      for (const u of [store, dealer, sales]) forbidden(await api(route, { token: u.token }))
      assert.equal((await api(route)).status, 401, route)
    }
    for (const u of [store, dealer, sales]) forbidden(await api('/api/purchase/price-preview', { token: u.token, body: { lines: [{ sku_id: 1, qty: 1 }] } }))
    assert.equal((await api('/api/purchase/price-preview', { body: { lines: [{ sku_id: 1, qty: 1 }] } })).status, 401)
  })

  await t.test('admin reads every document including NULL-org ones; unknown ids are 404', async () => {
    for (const k of ['A', 'B', 'N']) for (const r of DETAIL(k)) okData(await api(r, { token: f.admin }))
    for (const o of [poA.id, poB.id]) for (const r of orderRoutes(o)) okData(await api(r, { token: f.admin }))
    notFound(await api('/api/purchase/requisitions/999999', { token: f.admin }), 'missing')
    notFound(await api('/api/purchase/chain/actions?doc_type=PI&id=999999', { token: f.admin }), 'missing')
  })

  await t.test('org-A warehouse user: A is 200, B and NULL are 404 on every detail route', async () => {
    const wh = await f.account('dt_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
    for (const r of DETAIL('A')) okData(await api(r, { token: wh.token }))
    for (const r of orderRoutes(poA.id)) okData(await api(r, { token: wh.token }))
    for (const k of ['B', 'N']) for (const r of DETAIL(k)) notFound(await api(r, { token: wh.token }), r)
    for (const r of orderRoutes(poB.id)) notFound(await api(r, { token: wh.token }), r)
    // 范围外 404 与"不存在" 404 同形（不泄漏存在性）
    const miss = await api('/api/purchase/invoices/999999', { token: wh.token })
    const hid = await api(`/api/purchase/invoices/${pi.B}`, { token: wh.token })
    assert.deepEqual(hid.body, miss.body)
    // 主数据不分组织
    okData(await api('/api/purchase/catalog', { token: wh.token }))
    okData(await api(`/api/purchase/price?sku_id=1&supplier_id=${supplier}`, { token: wh.token }))
    okData(await api('/api/purchase/price-preview', { token: wh.token, body: { lines: [{ sku_id: 1, qty: 1 }] } }))
    notFound(await api('/api/purchase/price-preview', { token: wh.token, body: { order_id: poB.id, lines: [{ sku_id: 1, qty: 1 }] } }), 'foreign order')
    // 预览 / 计划按范围聚合
    const sp = okData(await api(`/api/purchase/settlement-preview?supplier_id=${supplier}`, { token: wh.token }))
    const spAdmin = okData(await api(`/api/purchase/settlement-preview?supplier_id=${supplier}`, { token: f.admin }))
    const oracle = (where, ...a) => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM purchase_invoices WHERE supplier_id=? AND status IN ('verified','posted') AND invoice_type<>'fee' ${where}`).get(supplier, ...a).v
    assert.equal(sp.invoice_amount, oracle('AND org_id=?', whA.org_id))
    assert.ok(sp.invoice_amount >= 1000)
    assert.equal(spAdmin.invoice_amount, oracle(''))
    assert.ok(spAdmin.invoice_amount >= sp.invoice_amount + 5000, 'B and NULL invoices must be hidden from A')
    const rcOracle = db.prepare(`SELECT COALESCE(SUM(total_amount),0) v FROM purchase_receipts WHERE supplier_id=? AND status IN ('received','inspected','closed') AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)`).get(supplier, whA.org_id).v
    assert.equal(sp.receipt_amount, Math.round(rcOracle * 100) / 100)
    const plan = okData(await api(`/api/purchase/payment-plan?supplier_id=${supplier}&amount=100000`, { token: wh.token }))
    assert.deepEqual(plan.list.map((x) => x.doc_no), ['PST-D-A'])
    assert.equal(plan.open_total, 500)
    assert.deepEqual(plan.plan.map((x) => x.settle_id), [pst.A])
    const planAdmin = okData(await api(`/api/purchase/payment-plan?supplier_id=${supplier}&amount=100000`, { token: f.admin }))
    assert.ok(planAdmin.plan.some((x) => x.settle_id === pst.B) && planAdmin.plan.some((x) => x.settle_id === pst.N))
    const lines = okData(await api(`/api/purchase/invoices-available-lines?supplier_id=${supplier}`, { token: wh.token }))
    const linesAdmin = okData(await api(`/api/purchase/invoices-available-lines?supplier_id=${supplier}`, { token: f.admin }))
    const whIds = new Set(db.prepare('SELECT id FROM warehouses WHERE org_id=?').all(whA.org_id).map((w) => w.id))
    const orderWh = (oid) => db.prepare('SELECT warehouse_id w FROM purchase_orders WHERE id=?').get(oid)?.w
    assert.ok(lines.list.every((x) => whIds.has(db.prepare('SELECT warehouse_id w FROM purchase_receipts WHERE order_id=? LIMIT 1').get(x.order_id)?.w ?? orderWh(x.order_id))))
    assert.ok(lines.list.length <= linesAdmin.list.length)
  })

  await t.test('restricted FIFO keeps one-cent balances like the shared allocator', async () => {
    const cent = id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES ('PST-D-CENT',?,?,'2000-01-01',0.01,0,0,'audited')`, whA.org_id, supplier)
    const wh = await f.account('dt_wh_cent', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
    const plan = okData(await api(`/api/purchase/payment-plan?supplier_id=${supplier}&amount=0.01`, { token: wh.token }))
    assert.deepEqual(plan.plan.map((x) => [x.settle_id, x.amount]), [[cent, 0.01]])
    db.prepare("UPDATE purchase_settlements SET status='voided' WHERE id=?").run(cent)
  })

  await t.test('subtree/global/no-org accounts', async () => {
    const glob = await f.account('dt_glob', 'purchase', { data_scope: 'all' })
    for (const k of ['A', 'B', 'N']) for (const r of DETAIL(k)) okData(await api(r, { token: glob.token }))
    const none = await f.account('dt_none', 'purchase', { data_scope: 'org' })
    for (const k of ['A', 'B', 'N']) for (const r of DETAIL(k)) notFound(await api(r, { token: none.token }), r)
    const sp = okData(await api(`/api/purchase/settlement-preview?supplier_id=${supplier}`, { token: none.token }))
    assert.equal(sp.invoice_amount, 0)
    assert.equal(sp.receipt_amount, 0)
    const plan = okData(await api(`/api/purchase/payment-plan?supplier_id=${supplier}&amount=100`, { token: none.token }))
    assert.deepEqual(plan, { open_total: 0, list: [], plan: [] })
    assert.deepEqual(okData(await api(`/api/purchase/invoices-available-lines?supplier_id=${supplier}`, { token: none.token })).list, [])
  })
})
