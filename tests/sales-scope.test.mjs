/**
 * ============================================================================
 * 文件标识：tests/sales-scope.test.mjs ｜ 测试：销售域按内部账号组织范围收口（ADR-0026）
 * ============================================================================
 * 【职责】守住 ADR-0026 的决定：`/api/sales` 的订单 / 发货单 / 退货单读接口与统计，
 *   对 `data_scope=org|subtree` 的内部账号只返回「自己组织参与」的单据：
 *     · 订单的归属由出货仓 `warehouses.org_id` 与门店 `stores.org_id` 推出，任一在范围内即可见；
 *       两者都为 NULL 对受限范围不可见、对全局范围（admin / data_scope=all）可见；
 *     · 发货单经所属订单；退货单有来源订单时经订单，无单退货用自己的仓 / 门店；
 *     · 详情 / 写动作对范围外单据与不存在同形（404），且不产生任何写；
 *     · 建单 / 改仓 / 发货改仓 / 退货的目标仓与门店必须在范围内（403）；
 *     · 经销商 / 门店绑定账号的行为不变（只看自己的主体，不受组织谓词影响）。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，
 *   单据直接写库。期望值用测试自己的 SQL（JOIN 写法，与被测的相关子查询不同）直算，不调被测 helper。
 *
 * 【改它要注意什么】断言是「精确集合 / 精确计数」，不是「比全库少」；不要为让测试通过而放宽。
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

test('sales reads and writes follow the caller org scope; dealer / store bindings are unchanged', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  // 两个互不嵌套的组织：A = 总仓 WH01 的组织，B = 电商仓 WH03 的组织（同一父组织下的兄弟）；S = 门店 1 的组织。
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const store1 = db.prepare('SELECT id, org_id FROM stores ORDER BY id LIMIT 1').get()
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whA.org_id).parent_id
  assert.equal(db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whB.org_id).parent_id, parentOrg)
  assert.ok(![whA.org_id, whB.org_id].includes(store1.org_id))
  const dealer1 = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get().id
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id

  const insOrder = db.prepare(`INSERT INTO sales_orders
    (doc_no, channel, dealer_id, store_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
    VALUES (?,?,?,?,date('now','localtime'),?,1,?,?,?)`)
  const mkOrder = (no, { channel = 'dealer', dealer = dealer1, store = null, status = 'confirmed', amount, wh }) =>
    Number(insOrder.run(no, channel, store ? null : dealer, store, status, amount, amount, wh).lastInsertRowid)
  const oA = mkOrder('XSC-A', { amount: 100, wh: whA.id })
  const oB = mkOrder('XSC-B', { amount: 200, wh: whB.id })
  const oS = mkOrder('XSC-S', { channel: 'store', store: store1.id, amount: 400, wh: whB.id })
  const oN = mkOrder('XSC-N', { amount: 800, wh: null })
  const oAD = mkOrder('XSC-AD', { amount: 1, wh: whA.id, status: 'draft' })
  const oBD = mkOrder('XSC-BD', { amount: 2, wh: whB.id, status: 'draft' })
  const oSD = mkOrder('XSC-SD', { channel: 'store', store: store1.id, amount: 3, wh: whB.id, status: 'draft' })
  const insItem = db.prepare('INSERT INTO sales_order_items (order_id, sku_id, qty, price, amount) VALUES (?,?,1,10,10)')
  for (const id of [oA, oB, oS, oN, oAD, oBD, oSD]) insItem.run(id, sku)

  const insDl = db.prepare(`INSERT INTO sales_deliveries (doc_no, order_id, warehouse_id, delivery_date, status, total_qty, total_amount)
    VALUES (?,?,?,date('now','localtime'),'shipped',1,10)`)
  // XSD-A 的发货仓故意写成 B 的仓：发货单按所属订单归属，不按自己的仓
  const dA = Number(insDl.run('XSD-A', oA, whB.id).lastInsertRowid)
  const dB = Number(insDl.run('XSD-B', oB, whB.id).lastInsertRowid)
  const dN = Number(insDl.run('XSD-N', oN, whA.id).lastInsertRowid)
  const insRt = db.prepare(`INSERT INTO sales_returns (doc_no, order_id, channel, dealer_id, store_id, warehouse_id, return_date, status, total_qty, total_amount)
    VALUES (?,?,?,?,?,?,date('now','localtime'),'confirmed',1,10)`)
  const rA = Number(insRt.run('XSR-A', oA, 'dealer', dealer1, null, whB.id).lastInsertRowid) // 有单：按订单（A），不按自己的仓（B）
  const rB = Number(insRt.run('XSR-B', oB, 'dealer', dealer1, null, whB.id).lastInsertRowid)
  const rWA = Number(insRt.run('XSR-WA', null, 'dealer', dealer1, null, whA.id).lastInsertRowid) // 无单：按自己的仓
  const rWB = Number(insRt.run('XSR-WB', null, 'dealer', dealer1, null, whB.id).lastInsertRowid)
  const rWS = Number(insRt.run('XSR-WS', null, 'store', null, store1.id, null).lastInsertRowid) // 无单：按自己的门店
  const rN = Number(insRt.run('XSR-N', null, 'dealer', dealer1, null, null).lastInsertRowid)

  db.prepare("UPDATE sales_returns SET idempotency_key='XSR-KEY-B' WHERE id=?").run(rB)
  db.prepare("UPDATE sales_returns SET idempotency_key='XSR-KEY-WA' WHERE id=?").run(rWA)

  const nos = (r, prefix) => okData(r).list.map((x) => x.doc_no).filter((n) => n.startsWith(prefix)).sort()
  const orders = (token) => api('/api/sales/orders?pageSize=500&keyword=XSC-', { token })
  const deliveries = (token) => api('/api/sales/deliveries?pageSize=500', { token })
  const returns = (token) => api('/api/sales/returns?pageSize=500', { token })
  const state = (table, id) => JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id))

  const accountA = await f.account('xs_sales_a', 'sales', { org_id: whA.org_id, data_scope: 'org' })
  const accountB = await f.account('xs_sales_b', 'sales', { org_id: whB.org_id, data_scope: 'org' })
  const accountS = await f.account('xs_sales_s', 'sales', { org_id: store1.org_id, data_scope: 'org' })
  const accountSub = await f.account('xs_sales_sub', 'sales', { org_id: parentOrg, data_scope: 'subtree' })
  const accountNone = await f.account('xs_sales_none', 'sales', { data_scope: 'org' })
  const accountAll = await f.account('xs_sales_all', 'sales', { data_scope: 'all' })

  await t.test('admin and data_scope=all keep the global view (NULL-owner rows included); anonymous is 401', async () => {
    for (const tk of [f.admin, accountAll.token]) {
      assert.deepEqual(nos(await orders(tk), 'XSC-'), ['XSC-A', 'XSC-AD', 'XSC-B', 'XSC-BD', 'XSC-N', 'XSC-S', 'XSC-SD'])
      assert.deepEqual(nos(await deliveries(tk), 'XSD-'), ['XSD-A', 'XSD-B', 'XSD-N'])
      assert.deepEqual(nos(await returns(tk), 'XSR-'), ['XSR-A', 'XSR-B', 'XSR-N', 'XSR-WA', 'XSR-WB', 'XSR-WS'])
    }
    for (const route of ['/api/sales/orders', '/api/sales/deliveries', '/api/sales/returns', '/api/sales/stats']) {
      assert.equal((await api(route)).status, 401, route)
    }
  })

  await t.test('org-A account sees only org-A documents on every list', async () => {
    const tk = accountA.token
    assert.deepEqual(nos(await orders(tk), 'XSC-'), ['XSC-A', 'XSC-AD'])
    assert.deepEqual(nos(await deliveries(tk), 'XSD-'), ['XSD-A'])
    assert.deepEqual(nos(await returns(tk), 'XSR-'), ['XSR-A', 'XSR-WA'])
  })

  await t.test('org-B account sees B orders (incl. the store order fulfilled from B) but none of A or NULL', async () => {
    const tk = accountB.token
    assert.deepEqual(nos(await orders(tk), 'XSC-'), ['XSC-B', 'XSC-BD', 'XSC-S', 'XSC-SD'])
    assert.deepEqual(nos(await deliveries(tk), 'XSD-'), ['XSD-B'])
    assert.deepEqual(nos(await returns(tk), 'XSR-'), ['XSR-B', 'XSR-WB'])
  })

  await t.test('the store org sees the store order and the walk-in return of its own store, not other orgs', async () => {
    const tk = accountS.token
    assert.deepEqual(nos(await orders(tk), 'XSC-'), ['XSC-S', 'XSC-SD'])
    assert.deepEqual(nos(await returns(tk), 'XSR-'), ['XSR-WS'])
    assert.deepEqual(nos(await deliveries(tk), 'XSD-'), [])
  })

  await t.test('subtree at the parent sees A, B and the store order, never the NULL-owner rows', async () => {
    const tk = accountSub.token
    assert.deepEqual(nos(await orders(tk), 'XSC-'), ['XSC-A', 'XSC-AD', 'XSC-B', 'XSC-BD', 'XSC-S', 'XSC-SD'])
    assert.deepEqual(nos(await deliveries(tk), 'XSD-'), ['XSD-A', 'XSD-B'])
    assert.deepEqual(nos(await returns(tk), 'XSR-'), ['XSR-A', 'XSR-B', 'XSR-WA', 'XSR-WB', 'XSR-WS'])
  })

  await t.test('an org-scoped account without an org sees nothing (empty scope never widens)', async () => {
    const tk = accountNone.token
    const o = okData(await api('/api/sales/orders?pageSize=500', { token: tk }))
    assert.equal(o.total, 0)
    assert.equal(okData(await api('/api/sales/deliveries?pageSize=500', { token: tk })).total, 0)
    assert.equal(okData(await api('/api/sales/returns?pageSize=500', { token: tk })).total, 0)
    const st = okData(await api('/api/sales/stats', { token: tk }))
    assert.equal(st.totalOrders, 0)
    assert.equal(st.totalAmount, 0)
    assert.equal(st.pendingDelivery, 0)
    assert.deepEqual([st.byChannel, st.topDealers, st.topStores, st.topProducts], [[], [], [], []])
  })

  await t.test('list totals and stats are computed over the same scoped set (independent SQL oracle)', async () => {
    const orgId = whA.org_id
    const oracle = db.prepare(`SELECT COUNT(DISTINCT so.id) n FROM sales_orders so
        LEFT JOIN warehouses w ON w.id = so.warehouse_id LEFT JOIN stores s ON s.id = so.store_id
        WHERE w.org_id = ? OR s.org_id = ?`).get(orgId, orgId).n
    assert.ok(oracle > 100, 'demo data must put many orders in org A')
    assert.equal(okData(await api('/api/sales/orders?pageSize=1', { token: accountA.token })).total, oracle)
    const dlOracle = db.prepare(`SELECT COUNT(DISTINCT sd.id) n FROM sales_deliveries sd JOIN sales_orders so ON so.id = sd.order_id
        LEFT JOIN warehouses w ON w.id = so.warehouse_id LEFT JOIN stores s ON s.id = so.store_id
        WHERE w.org_id = ? OR s.org_id = ?`).get(orgId, orgId).n
    assert.equal(okData(await api('/api/sales/deliveries?pageSize=1', { token: accountA.token })).total, dlOracle)

    const st = okData(await api('/api/sales/stats?days=3650', { token: accountA.token }))
    const o = db.prepare(`SELECT COUNT(DISTINCT so.id) c, COALESCE(SUM(so.receivable_amount),0) a FROM sales_orders so
        LEFT JOIN warehouses w ON w.id = so.warehouse_id LEFT JOIN stores s ON s.id = so.store_id
        WHERE (w.org_id = ? OR s.org_id = ?) AND so.status NOT IN ('cancelled','draft')`).get(orgId, orgId)
    assert.equal(st.totalOrders, o.c)
    assert.equal(Math.round(st.totalAmount * 100), Math.round(o.a * 100))
    assert.equal(st.byChannel.reduce((s, x) => s + x.orders, 0), o.c)
    assert.equal(st.trend.reduce((s, x) => s + x.orders, 0), o.c)
    const pend = db.prepare(`SELECT COUNT(DISTINCT so.id) c FROM sales_orders so
        LEFT JOIN warehouses w ON w.id = so.warehouse_id LEFT JOIN stores s ON s.id = so.store_id
        WHERE (w.org_id = ? OR s.org_id = ?) AND so.status = 'confirmed'`).get(orgId, orgId).c
    assert.equal(st.pendingDelivery, pend)
    // 全局口径不变
    const g = okData(await api('/api/sales/stats?days=3650', { token: f.admin }))
    assert.equal(g.totalOrders, db.prepare("SELECT COUNT(*) c FROM sales_orders WHERE status NOT IN ('cancelled','draft')").get().c)
    assert.ok(g.totalOrders > st.totalOrders)
  })

  await t.test('detail reads: out-of-scope is the same 404 as a missing id; in-scope is 200', async () => {
    const A = accountA.token
    assert.equal((await api(`/api/sales/orders/${oA}`, { token: A })).status, 200)
    assert.equal((await api(`/api/sales/deliveries/${dA}`, { token: A })).status, 200)
    const miss = await api('/api/sales/orders/99999999', { token: A })
    assert.equal(miss.status, 404)
    for (const id of [oB, oS, oN]) {
      const r = await api(`/api/sales/orders/${id}`, { token: A })
      assert.equal(r.status, 404)
      assert.deepEqual(r.body, miss.body)
    }
    const missDl = await api('/api/sales/deliveries/99999999', { token: A })
    for (const id of [dB, dN]) {
      const r = await api(`/api/sales/deliveries/${id}`, { token: A })
      assert.equal(r.status, 404)
      assert.deepEqual(r.body, missDl.body)
    }
    for (const tk of [f.admin, accountAll.token]) {
      for (const id of [oA, oB, oN]) assert.equal((await api(`/api/sales/orders/${id}`, { token: tk })).status, 200)
      assert.equal((await api(`/api/sales/deliveries/${dN}`, { token: tk })).status, 200)
    }
  })

  await t.test('write actions on out-of-scope documents are 404 and change nothing', async () => {
    const A = accountA.token
    const before = [state('sales_orders', oB), state('sales_orders', oBD), state('sales_orders', oS), state('sales_deliveries', dB), state('sales_returns', rB)]
    const counts = () => JSON.stringify([
      db.prepare('SELECT COUNT(*) c FROM doc_events').get().c,
      db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c,
      db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c
    ])
    const c0 = counts()
    const calls = [
      ['put', `/api/sales/orders/${oBD}`, { remark: 'hijack' }],
      ['post', `/api/sales/orders/${oBD}/confirm`, {}],
      ['post', `/api/sales/orders/${oB}/cancel`, { reason: 'x' }],
      ['post', `/api/sales/orders/${oB}/deliver`, {}],
      ['post', `/api/sales/orders/${oB}/complete`, {}],
      ['post', `/api/sales/orders/${oB}/payment`, { amount: 10 }],
      ['post', `/api/sales/orders/${oS}/cancel`, {}],
      ['post', `/api/sales/deliveries/${dB}/receive`, {}],
      ['post', `/api/sales/returns/${rB}/complete`, {}],
      ['post', '/api/sales/returns', { order_id: oB, items: [{ sku_id: sku, qty: 1 }] }]
    ]
    for (const [m, url, body] of calls) {
      const r = await api(url, { token: A, body, method: m.toUpperCase() })
      assert.equal(r.status, 404, `${m} ${url}: ${JSON.stringify(r.body)}`)
    }
    assert.deepEqual(
      [state('sales_orders', oB), state('sales_orders', oBD), state('sales_orders', oS), state('sales_deliveries', dB), state('sales_returns', rB)],
      before
    )
    assert.equal(counts(), c0)
  })

  await t.test('in-scope writes still work for the owning org', async () => {
    const A = accountA.token
    const put = await api(`/api/sales/orders/${oAD}`, { token: A, method: 'PUT', body: { remark: 'mine' } })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(db.prepare('SELECT remark FROM sales_orders WHERE id=?').get(oAD).remark, 'mine')
    const created = await api('/api/sales/orders', {
      token: A, body: { channel: 'dealer', dealer_id: dealer1, warehouse_id: whA.id, items: [{ sku_id: sku, qty: 1 }] }
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const recv = await api(`/api/sales/deliveries/${dA}/receive`, { token: A, body: {} })
    assert.equal(recv.status, 200, JSON.stringify(recv.body))
    const done = await api(`/api/sales/returns/${rWA}/complete`, { token: A, body: {} })
    assert.equal(done.status, 200, JSON.stringify(done.body))
  })

  await t.test('create / re-warehouse / ship / return targets outside the scope are 403 and write nothing', async () => {
    const A = accountA.token
    const nOrders = () => db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c
    const n0 = nOrders()
    const bad = await api('/api/sales/orders', { token: A, body: { channel: 'dealer', dealer_id: dealer1, warehouse_id: whB.id, items: [{ sku_id: sku, qty: 1 }] } })
    assert.equal(bad.status, 403, JSON.stringify(bad.body))
    const badStore = await api('/api/sales/orders', { token: A, body: { channel: 'store', store_id: store1.id, warehouse_id: whA.id, items: [{ sku_id: sku, qty: 1 }] } })
    assert.equal(badStore.status, 403, JSON.stringify(badStore.body))
    assert.equal(nOrders(), n0)
    const rewh = await api(`/api/sales/orders/${oAD}`, { token: A, method: 'PUT', body: { warehouse_id: whB.id } })
    assert.equal(rewh.status, 403, JSON.stringify(rewh.body))
    assert.equal(db.prepare('SELECT warehouse_id FROM sales_orders WHERE id=?').get(oAD).warehouse_id, whA.id)
    const ship = await api(`/api/sales/orders/${oA}/deliver`, { token: A, body: { warehouse_id: whB.id } })
    assert.equal(ship.status, 403, JSON.stringify(ship.body))
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sales_deliveries WHERE order_id=? AND doc_no<>'XSD-A'").get(oA).c, 0)
    const nRet = db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c
    const ret = await api('/api/sales/returns', { token: A, body: { warehouse_id: whB.id, items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(ret.status, 403, JSON.stringify(ret.body))
    const retStore = await api('/api/sales/returns', { token: A, body: { channel: 'store', store_id: store1.id, warehouse_id: whA.id, items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(retStore.status, 403, JSON.stringify(retStore.body))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c, nRet)
  })

  await t.test('shared documents: a reader whose warehouse is outside the scope cannot move that warehouse stock', async () => {
    const S = accountS.token // 门店组织：能读 B 仓发出的门店单，但 B 仓不在其范围内
    const c = await api(`/api/sales/orders/${oSD}/confirm`, { token: S, body: {} })
    assert.equal(c.status, 403, JSON.stringify(c.body))
    assert.equal(db.prepare('SELECT status FROM sales_orders WHERE id=?').get(oSD).status, 'draft')
    assert.equal(db.prepare("SELECT COUNT(*) c FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=?").get(oSD).c, 0)
    const x = await api(`/api/sales/orders/${oS}/cancel`, { token: S, body: {} })
    assert.equal(x.status, 403, JSON.stringify(x.body))
    assert.equal(db.prepare('SELECT status FROM sales_orders WHERE id=?').get(oS).status, 'confirmed')
    const d = await api(`/api/sales/orders/${oS}/deliver`, { token: S, body: {} })
    assert.equal(d.status, 403, JSON.stringify(d.body))
    // 仓所属组织的账号不被拦（后续是否成功取决于库存，但不是范围错误）
    const ok = await api(`/api/sales/orders/${oSD}/confirm`, { token: accountB.token, body: {} })
    assert.ok(![403, 404].includes(ok.status), JSON.stringify(ok.body))
  })

  await t.test('returns: restricted accounts cannot fall back to the default warehouse or replay another org return', async () => {
    const A = accountA.token
    const n0 = db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c
    const noWh = await api('/api/sales/returns', { token: A, body: { items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(noWh.status, 400, JSON.stringify(noWh.body))
    const emptyScope = await api('/api/sales/returns', { token: accountNone.token, body: { items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(emptyScope.status, 400, JSON.stringify(emptyScope.body))
    const replayB = await api('/api/sales/returns', { token: A, body: { warehouse_id: whA.id, idempotency_key: 'XSR-KEY-B', items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(replayB.status, 404, JSON.stringify(replayB.body))
    assert.ok(!JSON.stringify(replayB.body).includes('XSR-B'))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c, n0)
    // 自己组织的重放仍然是幂等重放
    const replayA = await api('/api/sales/returns', { token: A, body: { warehouse_id: whA.id, idempotency_key: 'XSR-KEY-WA', items: [{ sku_id: sku, qty: 1, price: 1 }] } })
    assert.equal(replayA.status, 200, JSON.stringify(replayA.body))
    assert.equal(replayA.body.data.replayed, true)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_returns').get().c, n0)
  })

  await t.test('dealer and store bound accounts keep their principal-only view, independent of org', async () => {
    const storeUser = await f.account('xs_store', 'store', { store_id: store1.id })
    const dealerUser = await f.account('xs_dealer', 'dealer', { dealer_id: dealer1 })
    // 门店：只看自己店的单（仓属 B 组织也照看；不受组织谓词影响）
    assert.deepEqual(nos(await orders(storeUser.token), 'XSC-'), ['XSC-S', 'XSC-SD'])
    assert.deepEqual(nos(await returns(storeUser.token), 'XSR-'), ['XSR-WS'])
    assert.equal((await api(`/api/sales/orders/${oS}`, { token: storeUser.token })).status, 200)
    const other = await api(`/api/sales/orders/${oA}`, { token: storeUser.token })
    assert.equal(other.status, 403)
    // 经销商：看自己的全部订单，含 NULL 归属与各组织仓出货的
    assert.deepEqual(nos(await orders(dealerUser.token), 'XSC-'), ['XSC-A', 'XSC-AD', 'XSC-B', 'XSC-BD', 'XSC-N'])
    assert.deepEqual(nos(await deliveries(dealerUser.token), 'XSD-'), ['XSD-A', 'XSD-B', 'XSD-N'])
    assert.equal((await api(`/api/sales/orders/${oS}`, { token: dealerUser.token })).status, 403)
    assert.equal((await api(`/api/sales/orders/${oN}`, { token: dealerUser.token })).status, 200)
    const st = okData(await api('/api/sales/stats?days=3650', { token: dealerUser.token }))
    assert.equal(st.totalOrders, db.prepare("SELECT COUNT(*) c FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft')").get(dealer1).c)
  })
})
