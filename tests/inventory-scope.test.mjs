/**
 * ============================================================================
 * 文件标识：tests/inventory-scope.test.mjs ｜ 测试：库存域与采购订单状态/收货路由按组织范围收口（ADR-0038）
 * ============================================================================
 * 【职责】守住 ADR-0038：
 *     · `POST /api/purchase/orders/:id/status|receive` 取单后按仓归属判范围，范围外 404 且不写；
 *     · `/api/inventory/*` 的库存查询 / 流水 / 台账 / 预警 / 统计 / 序列号 / 调拨 / 盘点 / 组装按 `warehouses.org_id` 过滤；
 *       调拨读：任一端在范围内可见；写：两端都必须在范围内（建单目标越界 403，既有单一端越界 403，两端皆外 404）；
 *     · 写目标仓（调整 / 盘点 / 组装 / 调拨）越界 403 且不产生库存或单据；admin 全局、外部角色 403 不变。
 * 【夹具口径】同 purchase-action-scope.test.mjs：test 运行时、临时数据目录、随机回环端口，单据直接写库。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-inventory-scope-'))
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
const expectStatus = (r, s, m) => assert.equal(r.status, s, `${m}: ${JSON.stringify(r.body)}`)

test('inventory domain and purchase status/receive follow warehouse org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const mkWh = (code, org) => Number(db.prepare("INSERT INTO warehouses (code, name, type, status, org_id) VALUES (?,?, 'normal','active',?)").run(code, code, org).lastInsertRowid)
  const whA2 = mkWh('Z1A2', whA.org_id)
  const whB2 = mkWh('Z1B2', whB.org_id)
  const whN = mkWh('Z1N', null)
  const skus = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 2').all()
  const sku = skus[0].id
  const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
  const orgsOf = (ids) => ids.map((id) => db.prepare('SELECT org_id FROM warehouses WHERE id=?').get(id)?.org_id)

  // 在三个范围内/外的仓各放一批货（admin 走真实调整入口）
  const adjIn = {}
  for (const [k, wh] of [['A', whA.id], ['A2', whA2], ['B', whB.id], ['B2', whB2], ['N', whN]]) {
    adjIn[k] = okData(await api('/api/inventory/adjust', { token: f.admin, body: { warehouse_id: wh, sku_id: sku, batch_no: 'Z1', qty: 10, direction: 'in', reason: 'z1' } })).doc_no
  }

  const perms = ['purchase.order.view', 'purchase.inbound', 'purchase.order.edit', 'purchase.order.approve']
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of perms) { grant.run('warehouse', p); grant.run('purchase', p) }

  const A = await f.account('z1_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const P = await f.account('z1_po_a', 'purchase', { org_id: whA.org_id, data_scope: 'org' })
  const NONE = await f.account('z1_wh_none', 'warehouse', { data_scope: 'org' })
  db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(NONE.id)
  const NONEtoken = await f.login(NONE.username, NONE.password)

  const insTf = db.prepare(`INSERT INTO stock_transfers (doc_no, from_warehouse_id, to_warehouse_id, transfer_date, type, status, total_qty, total_amount)
    VALUES (?,?,?,date('now','localtime'),'normal','draft',1,0)`)
  const insTfItem = db.prepare('INSERT INTO stock_transfer_items (transfer_id, sku_id, batch_no, qty, cost_price, amount) VALUES (?,?,?,1,NULL,NULL)')
  const tf = (no, from, to) => { const id = Number(insTf.run(no, from, to).lastInsertRowid); insTfItem.run(id, sku, 'Z1'); return id }
  const TF = { AA: tf('Z1-TF-AA', whA.id, whA2), AB: tf('Z1-TF-AB', whA.id, whB.id), BA: tf('Z1-TF-BA', whB.id, whA.id), BB: tf('Z1-TF-BB', whB.id, whB2), NN: tf('Z1-TF-NN', whN, whN) }

  const insCk = db.prepare(`INSERT INTO stock_checks (doc_no, warehouse_id, check_date, status) VALUES (?,?,date('now','localtime'),'draft')`)
  const insCkItem = db.prepare('INSERT INTO stock_check_items (check_id, sku_id, batch_no, book_qty, actual_qty, diff_qty) VALUES (?,?,?,10,10,0)')
  const ck = (no, wh) => { const id = Number(insCk.run(no, wh).lastInsertRowid); insCkItem.run(id, sku, 'Z1'); return id }
  const CK = { A: ck('Z1-CK-A', whA.id), B: ck('Z1-CK-B', whB.id), N: ck('Z1-CK-N', whN) }

  const bundle = db.prepare('SELECT id FROM bundles ORDER BY id LIMIT 1').get()
  assert.ok(bundle, 'demo data must have a bundle')
  const insAs = db.prepare(`INSERT INTO assembly_orders (doc_no, type, bundle_id, warehouse_id, biz_date, status, qty, total_cost) VALUES (?, 'assemble', ?, ?, date('now','localtime'), 'draft', 1, 0)`)
  const AS = { A: Number(insAs.run('Z1-AS-A', bundle.id, whA.id).lastInsertRowid), B: Number(insAs.run('Z1-AS-B', bundle.id, whB.id).lastInsertRowid) }

  const insSn = db.prepare("INSERT INTO serial_numbers (serial_no, sku_id, warehouse_id, status) VALUES (?,?,?,'in_stock')")
  insSn.run('Z1SN-A', sku, whA.id); insSn.run('Z1SN-B', sku, whB.id); insSn.run('Z1SN-N', sku, null)

  await t.test('stock queries, transactions, ledger and reports only cover in-scope warehouses', async () => {
    const aOrgs = new Set([whA.org_id])
    const st = okData(await api(`/api/inventory/stocks?pageSize=500`, { token: A.token }))
    assert.ok(st.list.length > 0)
    for (const r of st.list) assert.ok(aOrgs.has(orgsOf([r.warehouse_id])[0]), `stocks leaked warehouse ${r.warehouse_id}`)
    const adminSt = okData(await api(`/api/inventory/stocks?pageSize=500`, { token: f.admin }))
    assert.ok(adminSt.list.some((r) => orgsOf([r.warehouse_id])[0] !== whA.org_id), 'admin must stay global')
    // 过滤到范围外仓：空，而不是 403/泄漏
    assert.equal(okData(await api(`/api/inventory/stocks?warehouse_id=${whB.id}`, { token: A.token })).list.length, 0)
    assert.ok(okData(await api(`/api/inventory/stocks?warehouse_id=${whA.id}`, { token: A.token })).list.length > 0)

    // 按商品汇总：只汇总范围内仓
    const bySku = okData(await api(`/api/inventory/stocks/by-sku?keyword=&pageSize=500`, { token: A.token })).list.find((r) => r.sku_id === sku)
    const expectA = db.prepare(`SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=? AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)`).get(sku, whA.org_id).q
    assert.equal(Number(bySku.qty_on_hand), expectA)
    const adminBySku = okData(await api(`/api/inventory/stocks/by-sku?pageSize=500`, { token: f.admin })).list.find((r) => r.sku_id === sku)
    assert.ok(Number(adminBySku.qty_on_hand) > expectA)

    const tx = okData(await api(`/api/inventory/transactions?sku_id=${sku}&pageSize=500`, { token: A.token }))
    const docs = tx.list.map((r) => r.doc_no)
    assert.ok(docs.includes(adjIn.A) && docs.includes(adjIn.A2))
    assert.ok(![adjIn.B, adjIn.B2, adjIn.N].some((d) => docs.includes(d)), 'transactions leaked')
    assert.equal(okData(await api(`/api/inventory/transactions?doc_no=${adjIn.B}`, { token: A.token })).list.length, 0)
    assert.equal(okData(await api(`/api/inventory/transactions?doc_no=${adjIn.B}`, { token: f.admin })).list.length, 1)

    const ledA = okData(await api(`/api/inventory/ledger?sku_id=${sku}&startDate=2000-01-01`, { token: A.token }))
    assert.ok(!ledA.detail.some((d) => d.warehouse_id === whB.id || d.warehouse_id === whB2 || d.warehouse_id === whN))
    const ledB = okData(await api(`/api/inventory/ledger?sku_id=${sku}&warehouse_id=${whB.id}&startDate=2000-01-01`, { token: A.token }))
    assert.equal(ledB.detail.length, 0); assert.equal(ledB.closing, 0)

    for (const route of ['availability', 'aging', 'sluggish?days=0', 'abc']) {
      const d = okData(await api(`/api/inventory/${route}`, { token: A.token }))
      const rows = d.list || d.rows || []
      for (const r of rows) if (r.warehouse_id != null) assert.equal(orgsOf([r.warehouse_id])[0], whA.org_id, `${route} leaked`)
    }
    const abcA = okData(await api('/api/inventory/abc', { token: A.token }))
    const abcAdmin = okData(await api('/api/inventory/abc', { token: f.admin }))
    assert.ok(abcAdmin.totalAmount > abcA.totalAmount, 'abc must aggregate only in-scope warehouses')

    const stats = okData(await api('/api/inventory/stats', { token: A.token }))
    const wnames = stats.byWarehouse.map((w) => w.warehouse_name)
    assert.ok(wnames.includes('Z1A2') && !wnames.includes('Z1B2') && !wnames.includes('Z1N'))
    const adminStats = okData(await api('/api/inventory/stats', { token: f.admin }))
    assert.ok(adminStats.total.qty > stats.total.qty)

    const al = okData(await api('/api/inventory/alerts', { token: A.token }))
    for (const r of al.expiring) assert.equal(orgsOf([r.warehouse_id])[0], whA.org_id)

    const sn = okData(await api('/api/inventory/serials?keyword=Z1SN', { token: A.token }))
    assert.deepEqual(sn.list.map((r) => r.serial_no), ['Z1SN-A'])
    assert.equal((await api('/api/inventory/serials/trace/Z1SN-A', { token: A.token })).status, 200)
    expectStatus(await api('/api/inventory/serials/trace/Z1SN-B', { token: A.token }), 404, 'trace B')
    expectStatus(await api('/api/inventory/serials/trace/Z1SN-N', { token: A.token }), 404, 'trace N')
    assert.equal(okData(await api('/api/inventory/serials?keyword=Z1SN', { token: f.admin })).list.length, 3)
  })

  await t.test('transfers: read when either end is in scope; unrelated documents are 404', async () => {
    const list = okData(await api('/api/inventory/transfers?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((n) => n.startsWith('Z1-'))
    assert.deepEqual(list.sort(), ['Z1-TF-AA', 'Z1-TF-AB', 'Z1-TF-BA'])
    for (const k of ['AA', 'AB', 'BA']) assert.equal((await api(`/api/inventory/transfers/${TF[k]}`, { token: A.token })).status, 200, k)
    for (const k of ['BB', 'NN']) expectStatus(await api(`/api/inventory/transfers/${TF[k]}`, { token: A.token }), 404, k)
    expectStatus(await api('/api/inventory/transfers/999999', { token: A.token }), 404, 'missing')
    const hidden = await api(`/api/inventory/transfers/${TF.BB}`, { token: A.token })
    const missing = await api('/api/inventory/transfers/999999', { token: A.token })
    assert.deepEqual(hidden.body, missing.body)
    assert.equal(okData(await api('/api/inventory/transfers?pageSize=500', { token: f.admin })).list.filter((r) => r.doc_no.startsWith('Z1-')).length, 5)
  })

  await t.test('transfer writes: both ends must be in scope', async () => {
    const snap = (id) => JSON.stringify(db.prepare('SELECT status,total_qty FROM stock_transfers WHERE id=?').get(id))
    const txBefore = count('inventory_transactions')
    // 越界目标建单 → 403，不产生单据
    const before = count('stock_transfers')
    for (const [from, to] of [[whA.id, whB.id], [whB.id, whA.id], [whB.id, whB2], [whA.id, whN]]) {
      const r = await api('/api/inventory/transfers', { token: A.token, body: { from_warehouse_id: from, to_warehouse_id: to, items: [{ sku_id: sku, batch_no: 'Z1', qty: 1 }] } })
      expectStatus(r, 403, `create ${from}->${to}`)
    }
    assert.equal(count('stock_transfers'), before)
    // 一端在范围外的既有单：可读，不可写（403）
    for (const k of ['AB', 'BA']) {
      for (const action of ['submit', 'cancel', 'ship', 'receive']) {
        const b = snap(TF[k])
        expectStatus(await api(`/api/inventory/transfers/${TF[k]}/${action}`, { token: A.token, body: {} }), 403, `${k} ${action}`)
        assert.equal(snap(TF[k]), b)
      }
    }
    // 两端皆外：404
    for (const action of ['submit', 'cancel', 'ship', 'receive']) {
      const b = snap(TF.BB)
      expectStatus(await api(`/api/inventory/transfers/${TF.BB}/${action}`, { token: A.token, body: {} }), 404, `BB ${action}`)
      assert.equal(snap(TF.BB), b)
    }
    assert.equal(count('inventory_transactions'), txBefore, 'no stock movement from rejected writes')
    // 范围内两端：建单 + 出库 + 收货
    const created = okData(await api('/api/inventory/transfers', { token: A.token, body: { from_warehouse_id: whA.id, to_warehouse_id: whA2, items: [{ sku_id: sku, batch_no: 'Z1', qty: 2 }] } }))
    okData(await api(`/api/inventory/transfers/${created.id}/ship`, { token: A.token, body: {} }))
    okData(await api(`/api/inventory/transfers/${created.id}/receive`, { token: A.token, body: {} }))
    assert.equal(db.prepare('SELECT status FROM stock_transfers WHERE id=?').get(created.id).status, 'received')
    okData(await api(`/api/inventory/transfers/${TF.AA}/submit`, { token: A.token, body: {} }))
    // admin 全局
    okData(await api(`/api/inventory/transfers/${TF.AB}/submit`, { token: f.admin, body: {} }))
    okData(await api('/api/inventory/transfers', { token: f.admin, body: { from_warehouse_id: whA.id, to_warehouse_id: whB.id, items: [{ sku_id: sku, batch_no: 'Z1', qty: 1 }] } }))
  })

  await t.test('adjust / check / assembly write targets outside the scope are 403 and write nothing', async () => {
    const txBefore = count('inventory_transactions')
    for (const wh of [whB.id, whB2, whN]) {
      expectStatus(await api('/api/inventory/adjust', { token: A.token, body: { warehouse_id: wh, sku_id: sku, batch_no: 'Z1', qty: 1, direction: 'in' } }), 403, `adjust in ${wh}`)
      expectStatus(await api('/api/inventory/adjust', { token: A.token, body: { warehouse_id: wh, sku_id: sku, batch_no: 'Z1', qty: 1, direction: 'out' } }), 403, `adjust out ${wh}`)
    }
    expectStatus(await api('/api/inventory/adjust', { token: A.token, body: { warehouse_id: 999999, sku_id: sku, qty: 1 } }), 403, 'adjust missing wh')
    const ckBefore = count('stock_checks')
    expectStatus(await api('/api/inventory/checks', { token: A.token, body: { warehouse_id: whB.id } }), 403, 'check create B')
    assert.equal(count('stock_checks'), ckBefore)
    const asBefore = count('assembly_orders')
    expectStatus(await api('/api/inventory/assembly', { token: A.token, body: { bundle_id: bundle.id, warehouse_id: whB.id, qty: 1 } }), 403, 'assembly create B')
    assert.equal(count('assembly_orders'), asBefore)
    assert.equal(count('inventory_transactions'), txBefore)
    // 范围内可调整
    okData(await api('/api/inventory/adjust', { token: A.token, body: { warehouse_id: whA.id, sku_id: sku, batch_no: 'Z1', qty: 1, direction: 'in' } }))
    okData(await api('/api/inventory/adjust', { token: f.admin, body: { warehouse_id: whB.id, sku_id: sku, batch_no: 'Z1', qty: 1, direction: 'in' } }))
  })

  await t.test('stock check and assembly documents outside the scope are 404 and untouched', async () => {
    const snapCk = (id) => JSON.stringify([db.prepare('SELECT * FROM stock_checks WHERE id=?').get(id), db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(id)])
    const txBefore = count('inventory_transactions')
    for (const k of ['B', 'N']) {
      const b = snapCk(CK[k])
      expectStatus(await api(`/api/inventory/checks/${CK[k]}`, { token: A.token }), 404, `check ${k}`)
      expectStatus(await api(`/api/inventory/checks/${CK[k]}/items`, { token: A.token, method: 'PUT', body: { items: [] } }), 404, `items ${k}`)
      expectStatus(await api(`/api/inventory/checks/${CK[k]}/adjust`, { token: A.token, body: {} }), 404, `adjust ${k}`)
      expectStatus(await api(`/api/inventory/checks/${CK[k]}/cancel`, { token: A.token, body: {} }), 404, `cancel ${k}`)
      assert.equal(snapCk(CK[k]), b)
    }
    const names = okData(await api('/api/inventory/checks?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((n) => n.startsWith('Z1-'))
    assert.deepEqual(names, ['Z1-CK-A'])
    const snapAs = (id) => JSON.stringify(db.prepare('SELECT * FROM assembly_orders WHERE id=?').get(id))
    const b = snapAs(AS.B)
    expectStatus(await api(`/api/inventory/assembly/${AS.B}`, { token: A.token }), 404, 'as detail')
    expectStatus(await api(`/api/inventory/assembly/${AS.B}/confirm`, { token: A.token, body: {} }), 404, 'as confirm')
    expectStatus(await api(`/api/inventory/assembly/${AS.B}/cancel`, { token: A.token, body: {} }), 404, 'as cancel')
    assert.equal(snapAs(AS.B), b)
    assert.deepEqual(okData(await api('/api/inventory/assembly?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((n) => n.startsWith('Z1-')), ['Z1-AS-A'])
    assert.equal(count('inventory_transactions'), txBefore)
    // 范围内与 admin 正常
    assert.equal((await api(`/api/inventory/checks/${CK.A}`, { token: A.token })).status, 200)
    okData(await api(`/api/inventory/checks/${CK.A}/items`, { token: A.token, method: 'PUT', body: { items: [] } }))
    okData(await api(`/api/inventory/checks/${CK.A}/cancel`, { token: A.token, body: {} }).then((r) => (r.status === 409 ? { status: 200, body: { data: {} } } : r)))
    assert.equal((await api(`/api/inventory/assembly/${AS.A}`, { token: A.token })).status, 200)
    okData(await api(`/api/inventory/assembly/${AS.A}/cancel`, { token: A.token, body: {} }))
    assert.equal((await api(`/api/inventory/checks/${CK.B}`, { token: f.admin })).status, 200)
    assert.equal((await api(`/api/inventory/assembly/${AS.B}`, { token: f.admin })).status, 200)
    const made = okData(await api('/api/inventory/checks', { token: A.token, body: { warehouse_id: whA.id } }))
    assert.ok(made.id)
  })

  await t.test('accounts without an org see nothing and cannot write; external roles stay 403', async () => {
    const st = okData(await api('/api/inventory/stocks', { token: NONEtoken }))
    assert.equal(st.total, 0)
    assert.equal(okData(await api('/api/inventory/transfers', { token: NONEtoken })).total, 0)
    assert.equal(okData(await api('/api/inventory/stats', { token: NONEtoken })).total.qty, 0)
    expectStatus(await api('/api/inventory/adjust', { token: NONEtoken, body: { warehouse_id: whA.id, sku_id: sku, qty: 1 } }), 403, 'none adjust')
    const dealer = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get().id
    const D = await f.account('z1_dealer', 'dealer', { dealer_id: dealer })
    expectStatus(await api('/api/inventory/stocks', { token: D.token }), 403, 'dealer stocks')
    expectStatus(await api('/api/inventory/adjust', { token: D.token, body: { warehouse_id: whA.id, sku_id: sku, qty: 1 } }), 403, 'dealer adjust')
    expectStatus(await api('/api/inventory/stocks'), 401, 'anonymous')
  })

  await t.test('purchase order status and receive check document scope before any write', async () => {
    const [poA, poB, poN] = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 3').all()
    const set = db.prepare("UPDATE purchase_orders SET warehouse_id=?, status=? WHERE id=?")
    set.run(whA.id, 'submitted', poA.id); set.run(whB.id, 'submitted', poB.id); set.run(whN, 'submitted', poN.id)
    const row = (id) => JSON.stringify(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id))
    const stockSnap = () => JSON.stringify(db.prepare('SELECT * FROM inventory_stocks ORDER BY id').all())
    const s0 = stockSnap(); const rc0 = count('purchase_receipts')
    for (const po of [poB, poN]) {
      const b = row(po.id)
      expectStatus(await api(`/api/purchase/orders/${po.id}/status`, { token: P.token, body: { action: 'approve' } }), 404, 'status')
      expectStatus(await api(`/api/purchase/orders/${po.id}/receive`, { token: P.token, body: { items: [] } }), 404, 'receive')
      assert.equal(row(po.id), b)
    }
    assert.equal(count('purchase_receipts'), rc0); assert.equal(stockSnap(), s0)
    const hid = await api(`/api/purchase/orders/${poB.id}/status`, { token: P.token, body: { action: 'approve' } })
    const mis = await api('/api/purchase/orders/999999/status', { token: P.token, body: { action: 'approve' } })
    assert.deepEqual(hid.body, mis.body)
    // 范围内：不被范围闸挡住
    okData(await api(`/api/purchase/orders/${poA.id}/status`, { token: P.token, body: { action: 'approve' } }))
    assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(poA.id).status, 'approved')
    okData(await api(`/api/purchase/orders/${poA.id}/receive`, { token: P.token, body: { items: [] } }))
    assert.equal(count('purchase_receipts'), rc0 + 1)
    // admin 全局
    okData(await api(`/api/purchase/orders/${poB.id}/status`, { token: f.admin, body: { action: 'approve' } }))
    okData(await api(`/api/purchase/orders/${poN.id}/receive`, { token: f.admin, body: { items: [] } }))
  })
})
