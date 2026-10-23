/**
 * ============================================================================
 * 文件标识：tests/quote-scope.test.mjs ｜ 测试：报价 / MCP 销售工具 / OMS 转单按组织范围收口（ADR-0034）
 * ============================================================================
 * 【职责】守住 ADR-0034：
 *   · `/api/sales/quotes*`：列表 / 概览 / 详情 / 动作 / 复制 / 转单 / 批量过期都按仓、门店、订货客户组织归属收口，
 *     范围外详情与动作 404（零写）；建单 / 复制 / 转单的目标不在范围内 403（零写），受限范围下不许建无主报价；
 *   · MCP `sales.list_orders` / `sales.cancel_order`：用令牌 ∩ 所有者范围，与 HTTP 订单列表同一判据；
 *   · OMS `sync` / `convert` / `convert-batch`：订单归平台绑定组织（履约仓所属组织），未绑定 422，范围外 403 / 404。
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；期望值写成精确集合。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-sales-scope-'))
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


const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }

test('quotes, MCP sales tools and OMS order creation follow the org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  process.env.GML_RUNTIME_MODE = 'test'
  const { TOOLS } = await import('../server/mcp/tools.js')
  const tool = (n) => TOOLS.find((x) => x.name === n)

  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const store1 = db.prepare('SELECT id, org_id FROM stores ORDER BY id LIMIT 1').get()
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whA.org_id).parent_id
  assert.ok(![whA.org_id, whB.org_id].includes(store1.org_id))
  const dealer1 = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get().id
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
  // 订货客户：一个归 A，一个归 B
  const insCust = db.prepare("INSERT INTO oc_customers (code, name, source_type, source_id, org_id) VALUES (?,?,'dealer',?,?)")
  const custCols = db.prepare('PRAGMA table_info(oc_customers)').all().map((c) => c.name)
  assert.ok(custCols.includes('org_id'))
  let custA, custB
  try {
    custA = Number(insCust.run('XQC-A', 'XQC客户A', 880001, whA.org_id).lastInsertRowid)
    custB = Number(insCust.run('XQC-B', 'XQC客户B', 880002, whB.org_id).lastInsertRowid)
  } catch (e) {
    assert.fail(`oc_customers fixture insert failed: ${e.message}`)
  }

  const insQ = db.prepare(`INSERT INTO sales_quotes
    (doc_no, customer_type, dealer_id, customer_id, store_id, channel, warehouse_id, quote_date, valid_from, valid_to, status, goods_amount, total_amount)
    VALUES (?,?,?,?,?,?,?,date('now','localtime'),date('now','localtime'),date('now','+30 day','localtime'),?,10,10)`)
  const mkQ = (no, { type = 'dealer', dealer = null, cust = null, store = null, wh = null, status = 'draft' } = {}) =>
    Number(insQ.run(no, type, dealer, cust, store, 'dealer', wh, status).lastInsertRowid)
  const qA = mkQ('XQT-A', { dealer: dealer1, wh: whA.id })
  const qB = mkQ('XQT-B', { dealer: dealer1, wh: whB.id })
  const qS = mkQ('XQT-S', { type: 'store', store: store1.id })
  const qCA = mkQ('XQT-CA', { type: 'oc', cust: custA })
  const qCB = mkQ('XQT-CB', { type: 'oc', cust: custB })
  const qN = mkQ('XQT-N', { dealer: dealer1 })
  const qAA = mkQ('XQT-AA', { dealer: dealer1, wh: whA.id, status: 'approved' })
  const qNA = mkQ('XQT-NA', { dealer: dealer1, status: 'approved' })
  const insQI = db.prepare('INSERT INTO sales_quote_items (quote_id, line_no, sku_id, qty, list_price, price, amount) VALUES (?,1,?,1,10,10,10)')
  for (const id of [qA, qB, qS, qCA, qCB, qN, qAA, qNA]) insQI.run(id, sku)

  const accountA = await f.account('xq_sales_a', 'sales', { org_id: whA.org_id, data_scope: 'org' })
  const accountB = await f.account('xq_sales_b', 'sales', { org_id: whB.org_id, data_scope: 'org' })
  const accountS = await f.account('xq_sales_s', 'sales', { org_id: store1.org_id, data_scope: 'org' })
  const accountSub = await f.account('xq_sales_sub', 'sales', { org_id: parentOrg, data_scope: 'subtree' })
  const accountNone = await f.account('xq_sales_none', 'sales', { data_scope: 'org' })
  const accountAll = await f.account('xq_sales_all', 'sales', { data_scope: 'all' })
  const state = (table, id) => JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id))

  const quotes = async (token) => okData(await api('/api/sales/quotes?pageSize=500&keyword=XQT-', { token }))
  const nos = async (token) => (await quotes(token)).rows.map((x) => x.doc_no).sort()

  await t.test('quote lists: exact sets per org; NULL-owner quotes only for the global view', async () => {
    const all = ['XQT-A', 'XQT-AA', 'XQT-B', 'XQT-CA', 'XQT-CB', 'XQT-N', 'XQT-NA', 'XQT-S']
    for (const tk of [f.admin, accountAll.token]) assert.deepEqual(await nos(tk), all)
    assert.deepEqual(await nos(accountA.token), ['XQT-A', 'XQT-AA', 'XQT-CA'])
    assert.deepEqual(await nos(accountB.token), ['XQT-B', 'XQT-CB'])
    assert.deepEqual(await nos(accountS.token), ['XQT-S'])
    assert.deepEqual(await nos(accountSub.token), ['XQT-A', 'XQT-AA', 'XQT-B', 'XQT-CA', 'XQT-CB', 'XQT-S'])
    assert.deepEqual(await nos(accountNone.token), [])
    assert.equal((await quotes(accountA.token)).total, 3)
    assert.equal((await api('/api/sales/quotes')).status, 401)
  })

  await t.test('overview counts are scoped (approved quotes: A sees 1, none sees 0)', async () => {
    const ovA = okData(await api('/api/sales/quotes/overview', { token: accountA.token }))
    const ovN = okData(await api('/api/sales/quotes/overview', { token: accountNone.token }))
    const ovAll = okData(await api('/api/sales/quotes/overview', { token: f.admin }))
    const draftsOf = (ov) => ov.status_counts.draft.count
    const oracle = (org) => db.prepare(`SELECT COUNT(DISTINCT q.id) n FROM sales_quotes q
      LEFT JOIN warehouses w ON w.id=q.warehouse_id LEFT JOIN stores s ON s.id=q.store_id LEFT JOIN oc_customers c ON c.id=q.customer_id
      WHERE q.status='draft' AND (w.org_id=? OR s.org_id=? OR c.org_id=?)`).get(org, org, org).n
    assert.equal(draftsOf(ovA), oracle(whA.org_id))
    assert.equal(draftsOf(ovN), 0)
    assert.equal(ovN.pending_approval, 0)
    assert.ok(draftsOf(ovAll) >= draftsOf(ovA))
  })

  await t.test('detail: out-of-scope is the same 404 as nonexistent', async () => {
    assert.equal((await api(`/api/sales/quotes/${qA}`, { token: accountA.token })).status, 200)
    const out = await api(`/api/sales/quotes/${qB}`, { token: accountA.token })
    const missing = await api('/api/sales/quotes/99999999', { token: accountA.token })
    assert.equal(out.status, 404)
    assert.deepEqual(out.body, missing.body)
    assert.equal((await api(`/api/sales/quotes/${qN}`, { token: accountA.token })).status, 404)
    assert.equal((await api(`/api/sales/quotes/${qN}`, { token: f.admin })).status, 200)
    assert.equal((await api(`/api/sales/quotes/${qA}`, { token: accountNone.token })).status, 404)
  })

  await t.test('actions / copy / convert on out-of-scope quotes: 404 and zero writes', async () => {
    const before = state('sales_quotes', qB)
    const events = db.prepare('SELECT COUNT(*) c FROM doc_events').get().c
    const orders = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const quotesN = db.prepare('SELECT COUNT(*) c FROM sales_quotes').get().c
    for (const [route, body] of [
      [`/api/sales/quotes/${qB}/action`, { action: 'submit' }],
      [`/api/sales/quotes/${qB}/action`, { action: 'cancel' }],
      [`/api/sales/quotes/${qB}/copy`, {}],
      [`/api/sales/quotes/${qB}/convert`, {}]
    ]) {
      const r = await api(route, { token: accountA.token, body })
      assert.equal(r.status, 404, `${route} ${JSON.stringify(r.body)}`)
    }
    assert.equal(state('sales_quotes', qB), before)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM doc_events').get().c, events)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, orders)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_quotes').get().c, quotesN)
  })

  await t.test('in-scope actions still work (submit own quote)', async () => {
    const r = await api(`/api/sales/quotes/${qA}/action`, { token: accountA.token, body: { action: 'submit' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(db.prepare('SELECT status FROM sales_quotes WHERE id=?').get(qA).status, 'submitted')
  })

  await t.test('create: target warehouse / customer out of scope 403, no owner 403, in-scope 200; price trial gated too', async () => {
    const n0 = db.prepare('SELECT COUNT(*) c FROM sales_quotes').get().c
    const items = [{ sku_id: sku, qty: 1 }]
    const create = (token, extra) => api('/api/sales/quotes', { token, body: { customer_type: 'dealer', dealer_id: dealer1, items, ...extra } })
    assert.equal((await create(accountA.token, { warehouse_id: whB.id })).status, 403)
    assert.equal((await create(accountA.token, { customer_type: 'oc', customer_id: custB })).status, 403)
    assert.equal((await create(accountA.token, { warehouse_id: whA.id, store_id: store1.id })).status, 403, 'every party must be in scope')
    assert.equal((await create(accountA.token, {})).status, 403, 'ownerless quote refused under restricted scope')
    assert.equal((await create(accountNone.token, { warehouse_id: whA.id })).status, 403)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_quotes').get().c, n0)
    const mine = await create(accountA.token, { warehouse_id: whA.id })
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.equal((await api(`/api/sales/quotes/${mine.body.data.id}`, { token: accountA.token })).status, 200)
    assert.equal((await api(`/api/sales/quotes/${mine.body.data.id}`, { token: accountB.token })).status, 404)
    assert.equal((await create(f.admin, {})).status, 200, 'global view may still create unowned quotes')
    const price = (token, wh) => api('/api/sales/quotes/price', { token, body: { items, customer_type: 'dealer', dealer_id: dealer1, warehouse_id: wh } })
    assert.equal((await price(accountA.token, whB.id)).status, 403)
    assert.equal((await price(accountA.token, whA.id)).status, 200)
    // 改版：来源报价范围外 ⇒ 404
    assert.equal((await create(accountA.token, { warehouse_id: whA.id, source_quote_id: qB })).status, 404)
  })

  await t.test('convert: in-scope approved quote converts; NULL-owner approved quote is 403 for restricted, ok for global', async () => {
    const nullRes = await api(`/api/sales/quotes/${qNA}/convert`, { token: accountA.token, body: {} })
    assert.equal(nullRes.status, 404, 'NULL-owner quote is invisible to restricted scope')
    const ok1 = await api(`/api/sales/quotes/${qAA}/convert`, { token: accountA.token, body: {} })
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
    assert.equal(db.prepare('SELECT warehouse_id FROM sales_orders WHERE id=?').get(ok1.body.data.order.id).warehouse_id, whA.id)
    // 在范围内但另一参与方越界：仓 A + 门店 1 的已审批报价，A 账号可见但转单目标不全在范围内 ⇒ 403 且零写
    const mixed = mkQ('XQT-MIX', { type: 'store', store: store1.id, wh: whA.id, status: 'approved' })
    insQI.run(mixed, sku)
    const orders0 = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const r403 = await api(`/api/sales/quotes/${mixed}/convert`, { token: accountA.token, body: {} })
    assert.equal(r403.status, 403, JSON.stringify(r403.body))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, orders0)
    assert.equal(db.prepare('SELECT status FROM sales_quotes WHERE id=?').get(mixed).status, 'approved')
    const adminOk = await api(`/api/sales/quotes/${qNA}/convert`, { token: f.admin, body: {} })
    assert.equal(adminOk.status, 200, JSON.stringify(adminOk.body))
  })

  await t.test('convert to SO needs a warehouse / store owner; reused conversion hides an order that moved out of scope', async () => {
    // 订货客户在范围内、但没有仓 / 门店：转 SO 会造出无主订单 ⇒ 403 且零写；转 OC 不受影响
    const qOc = mkQ('XQT-OC', { type: 'oc', cust: custA, status: 'approved' })
    insQI.run(qOc, sku)
    const so0 = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const r = await api(`/api/sales/quotes/${qOc}/convert`, { token: accountA.token, body: { target: 'SO' } })
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, so0)
    assert.equal(db.prepare('SELECT status FROM sales_quotes WHERE id=?').get(qOc).status, 'approved')
    // 已转单的幂等返回：订单被改到别的组织后，原调用者拿不到单号
    const qR = mkQ('XQT-R', { dealer: dealer1, wh: whA.id, status: 'approved' })
    insQI.run(qR, sku)
    const first = await api(`/api/sales/quotes/${qR}/convert`, { token: accountA.token, body: {} })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal((await api(`/api/sales/quotes/${qR}/convert`, { token: accountA.token, body: {} })).body.data.reused, true)
    db.prepare('UPDATE sales_orders SET warehouse_id=? WHERE id=?').run(whB.id, first.body.data.order.id)
    const again = await api(`/api/sales/quotes/${qR}/convert`, { token: accountA.token, body: {} })
    assert.equal(again.status, 404, JSON.stringify(again.body))
  })

  await t.test('batch expire only touches in-scope quotes', async () => {
    const past = db.prepare("UPDATE sales_quotes SET valid_to=date('now','-3 day','localtime') WHERE id IN (?,?)")
    const qEA = mkQ('XQT-EA', { dealer: dealer1, wh: whA.id, status: 'approved' })
    const qEB = mkQ('XQT-EB', { dealer: dealer1, wh: whB.id, status: 'approved' })
    past.run(qEA, qEB)
    const r = await api('/api/sales/quotes/expire', { token: accountA.token, body: {} })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(db.prepare('SELECT status FROM sales_quotes WHERE id=?').get(qEA).status, 'expired')
    assert.equal(db.prepare('SELECT status FROM sales_quotes WHERE id=?').get(qEB).status, 'approved')
  })

  // ---------------------------------------------------------------- MCP sales tools
  const insOrder = db.prepare(`INSERT INTO sales_orders
    (doc_no, channel, dealer_id, store_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
    VALUES (?,?,?,?,date('now','localtime'),?,1,10,10,?)`)
  const mkOrder = (no, { store = null, status = 'draft', wh }) => Number(insOrder.run(no, store ? 'store' : 'dealer', store ? null : dealer1, store, status, wh).lastInsertRowid)
  const oA = mkOrder('XQM-A', { wh: whA.id })
  const oB = mkOrder('XQM-B', { wh: whB.id })
  const oS = mkOrder('XQM-S', { store: store1.id, wh: whB.id })
  const oN = mkOrder('XQM-N', { wh: null })
  const oBC = mkOrder('XQM-BC', { wh: whB.id })
  const insOI = db.prepare('INSERT INTO sales_order_items (order_id, sku_id, qty, price, amount) VALUES (?,?,1,10,10)')
  for (const id of [oA, oB, oS, oN, oBC]) insOI.run(id, sku)
  const call = (name, args, scope) => tool(name).handler({ db, args, ctx: { scope, tokenName: 'y4', orgId: null } })
  const scopeOf = (orgIds, kind = 'org') => ({ scope: kind, orgIds })

  await t.test('MCP sales.list_orders uses the HTTP predicate (exact sets, empty never widens)', async () => {
    const names = (scope) => {
      const r = call('sales.list_orders', { limit: 200 }, scope)
      return (r.data?.list ?? r.list).map((x) => x.doc_no).filter((n) => n.startsWith('XQM-')).sort()
    }
    assert.deepEqual(names({ scope: 'all', orgIds: null }), ['XQM-A', 'XQM-B', 'XQM-BC', 'XQM-N', 'XQM-S'])
    assert.deepEqual(names(scopeOf([whA.org_id])), ['XQM-A'])
    assert.deepEqual(names(scopeOf([whB.org_id])), ['XQM-B', 'XQM-BC', 'XQM-S'])
    assert.deepEqual(names(scopeOf([store1.org_id])), ['XQM-S'])
    assert.deepEqual(names(scopeOf([])), [])
    assert.deepEqual(names(scopeOf(null)), [])
    assert.deepEqual(names({ scope: 'dealer', orgIds: [whA.org_id] }), [])
    // 与 HTTP 列表同一集合
    const http = (await api('/api/sales/orders?pageSize=500&keyword=XQM-', { token: accountB.token })).body.data.list.map((x) => x.doc_no).sort()
    assert.deepEqual(http, names(scopeOf([whB.org_id])))
  })

  await t.test('MCP sales.cancel_order: out-of-scope is ORDER_NOT_FOUND 404 with no write; in-scope cancels', async () => {
    const before = state('sales_orders', oB)
    for (const scope of [scopeOf([whA.org_id]), scopeOf([]), { scope: 'dealer', orgIds: [whB.org_id] }]) {
      assert.throws(() => call('sales.cancel_order', { order_id: oB, reason: 'x' }, scope), (e) => e.code === 'ORDER_NOT_FOUND' && e.status === 404)
    }
    assert.throws(() => call('sales.cancel_order', { order_id: oN, reason: 'x' }, scopeOf([whA.org_id])), (e) => e.status === 404)
    assert.throws(() => call('sales.cancel_order', { order_id: 99999999, reason: 'x' }, scopeOf([whA.org_id])), (e) => e.code === 'ORDER_NOT_FOUND')
    assert.equal(state('sales_orders', oB), before)
    call('sales.cancel_order', { order_id: oBC, reason: 'x' }, scopeOf([whB.org_id]))
    assert.equal(db.prepare('SELECT status FROM sales_orders WHERE id=?').get(oBC).status, 'cancelled')
    call('sales.cancel_order', { order_id: oN, reason: 'x' }, { scope: 'all', orgIds: null })
    assert.equal(db.prepare('SELECT status FROM sales_orders WHERE id=?').get(oN).status, 'cancelled')
  })

  // ---------------------------------------------------------------- OMS
  await t.test('OMS sync / convert attribute orders to the platform-bound org and reject unbound or out-of-scope', async () => {
    const pfB = db.prepare('SELECT * FROM platforms WHERE warehouse_id=? ORDER BY id LIMIT 1').get(whB.id)
    const pfA = db.prepare('SELECT * FROM platforms WHERE warehouse_id=? ORDER BY id LIMIT 1').get(whA.id)
    assert.ok(pfB, 'demo seeds a platform on WH03')
    const pfUnbound = Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('XQP-NOWH','XQ无仓平台',NULL)").run().lastInsertRowid)
    const whNoOrg = Number(db.prepare("INSERT INTO warehouses (code, name, type, org_id) VALUES ('XQW-NOORG','XQ无组织仓','ecom',NULL)").run().lastInsertRowid)
    const pfNoOrg = Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('XQP-NOORG','XQ无组织平台',?)").run(whNoOrg).lastInsertRowid)

    const n0 = db.prepare('SELECT COUNT(*) c FROM oms_orders').get().c
    assert.equal((await api(`/api/oms/sync/${pfB.id}`, { token: accountA.token, body: { count: 1 } })).status, 403)
    assert.equal((await api(`/api/oms/sync/${pfB.id}`, { token: accountNone.token, body: { count: 1 } })).status, 403)
    for (const id of [pfUnbound, pfNoOrg]) {
      const r = await api(`/api/oms/sync/${id}`, { token: f.admin, body: { count: 1 } })
      assert.equal(r.status, 422, JSON.stringify(r.body))
      assert.equal(r.body.code, 'PLATFORM_ORG_UNBOUND')
    }
    assert.equal(db.prepare('SELECT COUNT(*) c FROM oms_orders').get().c, n0, 'rejected syncs write nothing')
    const okSync = await api(`/api/oms/sync/${pfB.id}`, { token: accountB.token, body: { count: 2 } })
    assert.equal(okSync.status, 200, JSON.stringify(okSync.body))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM oms_orders').get().c, n0 + 2)

    // convert：归平台履约仓，不回落到别的仓
    const ids = okSync.body.data.orders.map((o) => o.id)
    const stockedSku = db.prepare('SELECT sku_id FROM inventory_stocks WHERE warehouse_id=? ORDER BY (qty_on_hand - qty_reserved) DESC LIMIT 1').get(whB.id).sku_id
    for (const id of ids) {
      db.prepare("UPDATE oms_orders SET status='pending' WHERE id=?").run(id)
      // 同步出来的明细是随机 SKU / 数量，库存够不够不确定：换成确定的一行（WH03 里库存最多的 SKU，数量 1）
      db.prepare('DELETE FROM oms_order_items WHERE oms_order_id=?').run(id)
      db.prepare('INSERT INTO oms_order_items (oms_order_id, platform_sku_code, sku_id, title, qty, price, amount) VALUES (?,?,?,?,1,10,10)').run(id, 'XQ', stockedSku, 'x')
    }
    const so0 = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const denied = await api(`/api/oms/orders/${ids[0]}/convert`, { token: accountA.token, body: {} })
    assert.equal(denied.status, 404, JSON.stringify(denied.body))
    const batchDenied = await api('/api/oms/orders/convert-batch', { token: accountA.token, body: { ids: [ids[0]] } })
    assert.equal(batchDenied.body.data.success.length, 0)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, so0)
    assert.equal(db.prepare('SELECT sales_order_id FROM oms_orders WHERE id=?').get(ids[0]).sales_order_id, null)
    const conv = await api(`/api/oms/orders/${ids[0]}/convert`, { token: accountB.token, body: {} })
    assert.equal(conv.status, 200, JSON.stringify(conv.body))
    assert.equal(db.prepare('SELECT warehouse_id FROM sales_orders WHERE id=?').get(conv.body.data.sales_order_id).warehouse_id, whB.id)
    const batch = await api('/api/oms/orders/convert-batch', { token: accountB.token, body: { ids: [ids[1]] } })
    assert.equal(batch.body.data.success.length, 1, JSON.stringify(batch.body))
    // 平台后来被解绑 ⇒ 转单 422，且无新增销售订单
    const oUn = Number(db.prepare(`INSERT INTO oms_orders (platform_id, platform_order_no, status, goods_amount, pay_amount) VALUES (?,?, 'pending', 10, 10)`).run(pfUnbound, 'XQ-UNBOUND').lastInsertRowid)
    db.prepare('INSERT INTO oms_order_items (oms_order_id, platform_sku_code, sku_id, title, qty, price, amount) VALUES (?,?,?,?,1,10,10)').run(oUn, 'XQ', sku, 'x')
    const so1 = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const un = await api(`/api/oms/orders/${oUn}/convert`, { token: f.admin, body: {} })
    assert.equal(un.status, 422, JSON.stringify(un.body))
    assert.equal(un.body.code, 'PLATFORM_ORG_UNBOUND')
    const unb = await api('/api/oms/orders/convert-batch', { token: f.admin, body: { ids: [oUn] } })
    assert.equal(unb.body.data.success.length, 0)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, so1)
    void pfA
  })
})
