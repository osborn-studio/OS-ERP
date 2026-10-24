/**
 * ============================================================================
 * 文件标识：tests/inventory-scope.test.mjs ｜ 测试：库存域与采购订单状态/收货路由按组织范围收口（ADR-0038）
 * ============================================================================
 * 【职责】守住 ADR-0038：
 *     · `POST /api/purchase/orders/:id/status|receive` 取单后按仓归属判范围，范围外 404 且不写；
 *     · `/api/inventory/*` 的库存查询 / 流水 / 台账 / 预警 / 统计 / 序列号 / 调拨 / 盘点 / 组装按 `warehouses.org_id` 过滤；
 *       调拨读：任一端在范围内可见；写：两端都必须在范围内（建单目标越界 403，既有单一端越界 403，两端皆外 404）；
 *     · 写目标仓（调整 / 盘点 / 组装 / 调拨）越界 403 且不产生库存或单据；admin 全局、外部角色 403 不变。
 *     · ADR-0042：MCP 库存工具（读 / 写 / get_cost / pick_suggestion）按所有者的仓库组织范围收口，无组织仓对受限范围不可达。
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
    // 追溯事件按仓范围过滤：序列号指向 B 仓的入库单号时，A 看不到 B 仓的流水
    db.prepare('UPDATE serial_numbers SET entry_doc_no=? WHERE serial_no=?').run(adjIn.B, 'Z1SN-A')
    assert.equal(okData(await api('/api/inventory/serials/trace/Z1SN-A', { token: A.token })).events.length, 0)
    db.prepare('UPDATE serial_numbers SET entry_doc_no=? WHERE serial_no=?').run(adjIn.A, 'Z1SN-A')
    assert.equal(okData(await api('/api/inventory/serials/trace/Z1SN-A', { token: A.token })).events.length, 1)
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
    // Codex 审计补：改单 / 建单 / 直运目标仓也受范围约束
    const draftB = (set.run(whB.id, 'draft', poB.id), row(poB.id))
    expectStatus(await api(`/api/purchase/orders/${poB.id}`, { token: P.token, method: 'PUT', body: { warehouse_id: whA.id } }), 404, 'PUT foreign')
    assert.equal(row(poB.id), draftB)
    set.run(whA.id, 'draft', poA.id)
    expectStatus(await api(`/api/purchase/orders/${poA.id}`, { token: P.token, method: 'PUT', body: { warehouse_id: whB.id } }), 403, 'PUT move out')
    assert.equal(db.prepare('SELECT warehouse_id FROM purchase_orders WHERE id=?').get(poA.id).warehouse_id, whA.id)
    const poCount = count('purchase_orders')
    const supplierId = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
    const line = { sku_id: sku, qty: 1, price: 1 }
    expectStatus(await api('/api/purchase/orders', { token: P.token, body: { supplier_id: supplierId, warehouse_id: whB.id, items: [line] } }), 403, 'create B')
    expectStatus(await api('/api/purchase/orders', { token: P.token, body: { supplier_id: supplierId, warehouse_id: whA.id, fulfill_type: 'direct', target_warehouse_id: whB.id, items: [line] } }), 403, 'create direct B')
    assert.equal(count('purchase_orders'), poCount)
    db.prepare("UPDATE purchase_orders SET warehouse_id=?, status='submitted', fulfill_type='direct', target_warehouse_id=? WHERE id=?").run(whA.id, whB.id, poA.id)
    const s1 = stockSnap(); const rc1 = count('purchase_receipts')
    expectStatus(await api(`/api/purchase/orders/${poA.id}/receive`, { token: P.token, body: { items: [] } }), 403, 'direct receive')
    assert.equal(stockSnap(), s1); assert.equal(count('purchase_receipts'), rc1)
    db.prepare("UPDATE purchase_orders SET fulfill_type='hq', target_warehouse_id=NULL WHERE id=?").run(poA.id)
    // admin 全局
    okData(await api(`/api/purchase/orders/${poB.id}/status`, { token: f.admin, body: { action: 'submit' } }))
    okData(await api(`/api/purchase/orders/${poN.id}/receive`, { token: f.admin, body: { items: [] } }))
  })
})

// ---------------------------------------------------------------------------------------------
// ADR-0042：MCP 库存工具按所有者的仓库组织范围收口（与 HTTP `/api/inventory/*` 同一份 stock.js 判据）
// ---------------------------------------------------------------------------------------------
test('MCP inventory tools follow the owner warehouse-org scope (ADR-0042)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  process.env.GML_RUNTIME_MODE = 'test'
  const { TOOLS } = await import('../server/mcp/tools.js')
  const engine = await import('../server/lib/stock.js')
  const tool = (name) => TOOLS.find((x) => x.name === name)
  const call = (name, args, scope, extra = {}) => tool(name).handler({ db, args, ctx: { scope, tokenName: 'aa2', orgId: null, engine, ...extra } })
  const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code ?? `ERR:${e.message}` } }

  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const mkWh = (code, org) => Number(db.prepare("INSERT INTO warehouses (code, name, type, status, org_id) VALUES (?,?, 'normal','active',?)").run(code, code, org).lastInsertRowid)
  const whA2 = mkWh('AA2A2', whA.org_id)
  const whN = mkWh('AA2N', null)
  // 同组织两仓货主一致（内部调拨的前提）
  db.prepare('UPDATE warehouses SET default_owner_org_id=? WHERE id=?').run(engine.resolveOwnerOrg(db, whA.id), whA2)
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
  const today = new Date().toISOString().slice(0, 10)
  // 货主是 A 组织的货放在 B 组织 / 无组织的仓里：旧的货主过滤会放行，仓库组织口径必须隐藏
  const putStock = (wh, owner, batch) => engine.applyStockIn(db, { bizDate: today, docType: 'ADJ_IN', docNo: `AA2-${batch}`, warehouseId: wh, ownerOrgId: owner, skuId: sku, batchNo: batch, qty: 7, unitCost: 3, expireAt: '2099-01-01 00:00:00', source: 'test', operator: 'aa2' })
  putStock(whA.id, whA.org_id, 'AA2-A')
  putStock(whA2, whA.org_id, 'AA2-A2')
  putStock(whB.id, whA.org_id, 'AA2-B-OWNEDBYA')
  putStock(whN, whA.org_id, 'AA2-N-OWNEDBYA')
  const orgOf = (id) => db.prepare('SELECT org_id FROM warehouses WHERE id=?').get(id)?.org_id
  // 范围含 A 组织及 A 仓 / 无组织仓的默认货主组织（拒绝必须来自「仓库不在范围」，而不是默认货主不在范围）
  const scopeIds = [...new Set([whA.org_id, engine.resolveOwnerOrg(db, whA.id), engine.resolveOwnerOrg(db, whA2), engine.resolveOwnerOrg(db, whN)])]
  assert.ok(!scopeIds.includes(whB.org_id), 'fixture: warehouse B org must stay outside the scope')
  const scopeA = { scope: 'restricted', orgIds: scopeIds }
  const scopeNone = { scope: 'none', orgIds: [] }
  const scopeAll = { scope: 'all', orgIds: null }
  const txCount = () => db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
  const stockSum = () => db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q, COUNT(*) c FROM inventory_stocks').get()

  await t.test('read tools only return rows from in-scope warehouses, even when the goods are owned by the scoped org', () => {
    const q = call('inventory.query_stock', { sku_id: sku, limit: 500 }, scopeA).data.list
    assert.ok(q.length > 0 && q.every((r) => orgOf(r.warehouse_id) === whA.org_id), `query_stock leaked: ${q.map((r) => r.warehouse_id)}`)
    assert.ok(q.some((r) => r.batch_no === 'AA2-A') && !q.some((r) => r.batch_no === 'AA2-B-OWNEDBYA' || r.batch_no === 'AA2-N-OWNEDBYA'))
    assert.ok(call('inventory.query_stock', { sku_id: sku, limit: 500 }, scopeAll).data.list.some((r) => r.batch_no === 'AA2-N-OWNEDBYA'))
    assert.equal(call('inventory.query_stock', { sku_id: sku, warehouse_id: whB.id }, scopeA).data.count, 0)
    assert.equal(call('inventory.query_stock', { sku_id: sku }, scopeNone).data.count, 0)

    const tx = call('inventory.list_transactions', { sku_id: sku, limit: 500 }, scopeA).data.list
    assert.ok(tx.length > 0 && tx.every((r) => orgOf(r.warehouse_id) === whA.org_id), 'list_transactions leaked')
    assert.equal(call('inventory.list_transactions', { sku_id: sku, warehouse_id: whN }, scopeA).data.count, 0)

    const batches = call('inventory.list_batches', { sku_id: sku, days: 36500 }, scopeA).data.list
    const seen = new Set(batches.map((b) => b.batch_no))
    assert.ok(seen.has('AA2-A') && !seen.has('AA2-B-OWNEDBYA') && !seen.has('AA2-N-OWNEDBYA'), `list_batches: ${[...seen]}`)
    const aBatch = batches.find((b) => b.batch_no === 'AA2-A')
    assert.equal(aBatch.qty_on_hand, 7)

    const alert = call('inventory.stock_alert', { expiring_days: 36500 }, scopeA).data
    assert.ok(alert.expiring.every((r) => orgOf(r.warehouse_id) === whA.org_id), 'stock_alert.expiring leaked')
    assert.ok(alert.expiring.some((r) => r.batch_no === 'AA2-A'))
    assert.equal(call('inventory.stock_alert', { expiring_days: 36500 }, scopeNone).data.expiring.length, 0)
  })

  await t.test('get_cost and pick_suggestion refuse out-of-scope and unowned-org warehouses (403), allow in-scope ones', () => {
    for (const wh of [whB.id, whN]) {
      assert.equal(codeOf(() => call('inventory.get_cost', { sku_id: sku, warehouse_id: wh, owner_org_id: whA.org_id, batch_no: wh === whB.id ? 'AA2-B-OWNEDBYA' : 'AA2-N-OWNEDBYA' }, scopeA)), 'ORG_OUT_OF_SCOPE', `get_cost ${wh}`)
      assert.equal(codeOf(() => call('inventory.pick_suggestion', { sku_id: sku, warehouse_id: wh, qty: 1, owner_org_id: whA.org_id }, scopeA)), 'ORG_OUT_OF_SCOPE', `pick ${wh}`)
    }
    assert.equal(codeOf(() => call('inventory.get_cost', { sku_id: sku, warehouse_id: whA.id, owner_org_id: whA.org_id, batch_no: 'AA2-A' }, scopeA)), null)
    assert.equal(codeOf(() => call('inventory.pick_suggestion', { sku_id: sku, warehouse_id: whA.id, qty: 1, owner_org_id: whA.org_id }, scopeA)), null)
    assert.equal(codeOf(() => call('inventory.pick_suggestion', { sku_id: sku, warehouse_id: whN, qty: 1, owner_org_id: whA.org_id }, scopeAll)), null)
    assert.equal(codeOf(() => call('inventory.get_cost', { sku_id: sku, warehouse_id: whA.id }, scopeNone)), 'ORG_OUT_OF_SCOPE')
  })

  await t.test('write tools refuse out-of-scope or org-less warehouses on either end and change nothing', () => {
    const base = { sku_id: sku, qty: 1, idempotency_key: 'k' }
    const attempts = [
      ['inventory.stock_in', { ...base, unit_cost: 1, owner_org_id: whA.org_id }, (wh) => ({ warehouse_id: wh })],
      ['inventory.stock_out', { ...base, owner_org_id: whA.org_id }, (wh) => ({ warehouse_id: wh })],
      ['inventory.adjust', { sku_id: sku, delta: 1, reason: 'aa2' }, (wh) => ({ warehouse_id: wh })],
      ['inventory.transfer', base, (wh, side) => (side === 'to' ? { from_warehouse_id: whA.id, to_warehouse_id: wh } : { from_warehouse_id: wh, to_warehouse_id: whA2 })],
      ['inventory.ownership_transfer', { ...base, from_owner_org_id: whA.org_id, to_owner_org_id: whA.org_id }, (wh, side) => (side === 'to' ? { from_warehouse_id: whA.id, to_warehouse_id: wh } : { from_warehouse_id: wh, to_warehouse_id: whA2 })]
    ]
    for (const [name, fixed, place] of attempts) {
      for (const wh of [whB.id, whN]) {
        for (const side of ['from', 'to']) {
          const before = [txCount(), JSON.stringify(stockSum())]
          const args = { ...fixed, ...place(wh, side) }
          assert.equal(codeOf(() => call(name, args, scopeA)), 'ORG_OUT_OF_SCOPE', `${name} wh=${wh} ${side}`)
          assert.deepEqual([txCount(), JSON.stringify(stockSum())], before, `${name} wrote`)
        }
      }
      assert.equal(codeOf(() => call(name, { ...fixed, ...place(whA.id, 'to') }, scopeNone)), 'ORG_OUT_OF_SCOPE', `${name} with empty scope`)
    }
    // 不存在的仓保持 404 语义
    assert.equal(codeOf(() => call('inventory.adjust', { warehouse_id: 99999999, sku_id: sku, delta: 1, reason: 'aa2' }, scopeA)), 'WAREHOUSE_NOT_FOUND')
  })

  await t.test('in-scope warehouses still work; global scope reaches org-less warehouses', () => {
    const t0 = txCount()
    call('inventory.stock_in', { warehouse_id: whA.id, sku_id: sku, qty: 2, unit_cost: 1, owner_org_id: engine.resolveOwnerOrg(db, whA.id), batch_no: 'AA2-T', idempotency_key: 'k1' }, scopeA)
    call('inventory.transfer', { from_warehouse_id: whA.id, to_warehouse_id: whA2, sku_id: sku, qty: 1, batch_no: 'AA2-T', idempotency_key: 'k2' }, scopeA)
    call('inventory.adjust', { warehouse_id: whA2, sku_id: sku, batch_no: 'AA2-T', delta: 1, reason: 'aa2' }, scopeA)
    assert.ok(txCount() > t0)
    const t1 = txCount()
    call('inventory.stock_in', { warehouse_id: whN, sku_id: sku, qty: 1, unit_cost: 1, owner_org_id: whA.org_id, batch_no: 'AA2-G', idempotency_key: 'k3' }, scopeAll)
    call('inventory.adjust', { warehouse_id: whB.id, sku_id: sku, batch_no: 'AA2-G2', delta: 1, reason: 'aa2' }, scopeAll)
    assert.equal(txCount(), t1 + 2)
  })
})

// ---------------------------------------------------------------------------
// AA4（ADR-0038 补充）：质检处置调拨 / 仓库主数据 / 收货单与退货单 / POS 门店库存
// ---------------------------------------------------------------------------
test('AA4: QC disposition, warehouse master, purchase receipts/returns and POS store stock stay inside the scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const mkWh = (code, org, type = 'normal', storeId = null) =>
    Number(db.prepare("INSERT INTO warehouses (code, name, type, status, org_id, store_id) VALUES (?,?,?,'active',?,?)").run(code, code, type, org, storeId).lastInsertRowid)
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
  const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
  const supplierId = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id

  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of ['quality.qc.view', 'quality.handle.approve', 'quality.inspect', 'quality.inspect.view', 'quality.inspect.edit', 'purchase.order.view', 'purchase.inbound', 'purchase.return', 'pos.view', 'pos.store.stock']) {
    grant.run('warehouse', p); grant.run('store', p)
  }
  const A = await f.account('aa4_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const NONE = await f.account('aa4_wh_none', 'warehouse', { data_scope: 'org' })
  db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(NONE.id)
  const NONEtoken = await f.login(NONE.username, NONE.password)

  const adjust = async (wh, batch, qty = 20) => okData(await api('/api/inventory/adjust', { token: f.admin, body: { warehouse_id: wh, sku_id: sku, batch_no: batch, qty, direction: 'in', reason: 'aa4' } }))
  const whA2 = mkWh('AA4A2', whA.org_id)
  await adjust(whA.id, 'AA4'); await adjust(whB.id, 'AA4'); await adjust(whA.id, 'AA4Q')

  await t.test('QC disposition: source warehouse out of scope is 404, quarantine target out of scope is 403, in-scope target is chosen', async () => {
    // 先把种子里的隔离仓都归到 B 组织：A 的范围内没有任何隔离仓
    db.prepare("UPDATE warehouses SET org_id=? WHERE type IN ('defect','quarantine')").run(whB.org_id)
    const insReq = db.prepare("INSERT INTO qc_requests (doc_no, source_type, request_date, warehouse_id, status) VALUES (?,?,date('now','localtime'),?, 'submitted')")
    const insIns = db.prepare("INSERT INTO qc_inspections (doc_no, request_id, warehouse_id, inspect_date, result, status) VALUES (?,?,?,date('now','localtime'),'unqualified','inspected')")
    const insItem = db.prepare("INSERT INTO qc_request_items (request_id, line_no, sku_id, batch_no, qty) VALUES (?,1,?,?,5)")
    const insDh = db.prepare(`INSERT INTO qc_defect_handlings (doc_no, inspection_id, inspection_no, request_id, warehouse_id, sku_id, batch_no, qty, mode, reason, stock_direction, status)
      VALUES (?,?,?,?,?,?, ?, 1, ?, 'aa4', 'out', 'draft')`)
    let n = 0
    const dh = (wh, mode, batch = 'AA4Q') => {
      n++
      const rq = Number(insReq.run(`AA4-QR-${n}`, 'inventory', wh).lastInsertRowid)
      const ci = Number(insIns.run(`AA4-QI-${n}`, rq, wh).lastInsertRowid)
      insItem.run(rq, sku, batch)
      return Number(insDh.run(`AA4-DH-${n}`, ci, `AA4-QI-${n}`, rq, wh, sku, batch, mode).lastInsertRowid)
    }
    const stockQty = (wh) => db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').get(wh, sku).q
    const snap = (id) => JSON.stringify(db.prepare('SELECT status,out_doc_id FROM qc_defect_handlings WHERE id=?').get(id))
    const dB = dh(whB.id, 'scrap', 'AA4'); const dBc = dh(whB.id, 'concession', 'AA4')
    const dAc = dh(whA.id, 'concession'); const dAs = dh(whA.id, 'scrap')
    const dAshared = dh(whA.id, 'concession', 'AA4') // 同一批次在 B 仓也有库存

    // 源仓在范围外 ⇒ 与不存在同形 404，且不动库存、不动单据
    const txBefore = count('inventory_transactions'); const bQty = stockQty(whB.id)
    for (const id of [dB, dBc]) {
      const b = snap(id)
      expectStatus(await api(`/api/qc/handlings/${id}/confirm`, { token: A.token, body: {} }), 404, `confirm ${id}`)
      expectStatus(await api(`/api/qc/handlings/${id}/cancel`, { token: A.token, body: {} }), 404, `cancel ${id}`)
      expectStatus(await api(`/api/qc/handlings/${id}`, { token: A.token }), 404, `get ${id}`)
      assert.equal(snap(id), b)
    }
    const hid = await api(`/api/qc/handlings/${dB}/confirm`, { token: A.token, body: {} })
    const mis = await api('/api/qc/handlings/999999/confirm', { token: A.token, body: {} })
    assert.deepEqual(hid.body, mis.body)
    assert.equal(stockQty(whB.id), bQty); assert.equal(count('inventory_transactions'), txBefore)
    const names = okData(await api('/api/qc/handlings?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((x) => x.startsWith('AA4-'))
    assert.deepEqual(names.sort(), ['AA4-DH-3', 'AA4-DH-4', 'AA4-DH-5'])
    // 检验单读（内嵌处置单）同一道门：B 仓检验单 404，列表不含，A 仓的可见
    const ciOf = (no) => db.prepare('SELECT id FROM qc_inspections WHERE doc_no=?').get(no).id
    expectStatus(await api(`/api/qc/inspections/${ciOf('AA4-QI-1')}`, { token: A.token }), 404, 'inspection B')
    assert.equal((await api(`/api/qc/inspections/${ciOf('AA4-QI-3')}`, { token: A.token })).status, 200)
    assert.equal((await api(`/api/qc/inspections/${ciOf('AA4-QI-1')}`, { token: f.admin })).status, 200)
    const insNames = okData(await api('/api/qc/inspections?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((x) => x.startsWith('AA4-'))
    assert.deepEqual(insNames.sort(), ['AA4-QI-3', 'AA4-QI-4', 'AA4-QI-5'])
    assert.equal(okData(await api('/api/qc/handlings?pageSize=500', { token: NONEtoken })).list.length, 0)

    // 检验单 / 报检单 / 待检来源的其余入口同一道门：提交结论会改写批次级可售状态
    const qiB = ciOf('AA4-QI-1'); const rqB = db.prepare('SELECT request_id r FROM qc_inspections WHERE id=?').get(qiB).r
    const ciSnap = () => JSON.stringify([db.prepare('SELECT * FROM qc_inspections WHERE id=?').get(qiB), db.prepare('SELECT * FROM qc_requests WHERE id=?').get(rqB)])
    const c0 = ciSnap()
    for (const act of ['submit', 'close', 'cancel']) expectStatus(await api(`/api/qc/inspections/${qiB}/${act}`, { token: A.token, body: {} }), 404, `inspection ${act}`)
    for (const act of ['submit', 'close', 'cancel']) expectStatus(await api(`/api/qc/requests/${rqB}/${act}`, { token: A.token, body: {} }), 404, `request ${act}`)
    expectStatus(await api(`/api/qc/requests/${rqB}`, { token: A.token }), 404, 'request get')
    assert.equal(ciSnap(), c0)
    const rqNames = okData(await api('/api/qc/requests?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((x) => x.startsWith('AA4-'))
    assert.deepEqual(rqNames.sort(), ['AA4-QR-3', 'AA4-QR-4', 'AA4-QR-5'])
    const insGrQ = db.prepare("INSERT INTO purchase_receipts (doc_no, supplier_id, warehouse_id, receipt_date, status) VALUES (?,?,?,date('now','localtime'),'received')")
    const grQB = Number(insGrQ.run('ZQ-QGR-B', supplierId, whB.id).lastInsertRowid)
    expectStatus(await api(`/api/qc/pending/detail?source_type=purchase_receipt&source_id=${grQB}`, { token: A.token }), 404, 'pending detail B')
    assert.equal((await api(`/api/qc/pending/detail?source_type=purchase_receipt&source_id=${grQB}`, { token: f.admin })).status, 200)
    assert.ok(!okData(await api('/api/qc/pending', { token: A.token })).list.some((r) => r.source_id === grQB))
    assert.ok(okData(await api('/api/qc/pending', { token: f.admin })).list.some((r) => r.source_id === grQB))
    expectStatus(await api('/api/qc/requests', { token: A.token, body: { source_type: 'purchase_receipt', source_id: grQB } }), 404, 'request from foreign receipt')

    // 目标隔离仓不在范围内 ⇒ 403，不出库不建调拨单
    const tfBefore = count('stock_transfers'); const aQty = stockQty(whA.id)
    const b1 = snap(dAc)
    expectStatus(await api(`/api/qc/handlings/${dAc}/confirm`, { token: A.token, body: {} }), 403, 'concession target out of scope')
    assert.equal(snap(dAc), b1); assert.equal(count('stock_transfers'), tfBefore); assert.equal(stockQty(whA.id), aQty)
    // 同一批次在范围外仓仍有库存 ⇒ 让步 / 返工会改变别组织货的可售结论，403 且不动
    const qcStatus = () => JSON.stringify(db.prepare("SELECT warehouse_id FROM inventory_stocks WHERE sku_id=? AND batch_no='AA4' ORDER BY id").all(sku))
    const bq0 = db.prepare("SELECT qc_status FROM inventory_batches WHERE sku_id=? AND batch_no='AA4'").all(sku)
    expectStatus(await api(`/api/qc/handlings/${dAshared}/confirm`, { token: A.token, body: {} }), 403, 'shared batch')
    assert.deepEqual(db.prepare("SELECT qc_status FROM inventory_batches WHERE sku_id=? AND batch_no='AA4'").all(sku), bq0)
    assert.equal(count('stock_transfers'), tfBefore); assert.ok(qcStatus())
    // 报废只需要源仓在范围内
    okData(await api(`/api/qc/handlings/${dAs}/confirm`, { token: A.token, body: {} }))
    assert.equal(stockQty(whA.id), aQty - 1)

    // A 组织自己的隔离仓（id 比 B 的大）⇒ 优先选范围内的仓
    const defA = mkWh('AA4DEF', whA.org_id, 'defect')
    const defId = db.prepare("SELECT MIN(id) m FROM warehouses WHERE type='defect'").get().m
    assert.notEqual(defId, defA, 'a lower-id defect warehouse (other org) exists')
    okData(await api(`/api/qc/handlings/${dAc}/confirm`, { token: A.token, body: {} }))
    assert.equal(db.prepare('SELECT to_warehouse_id w FROM stock_transfers WHERE id=(SELECT MAX(id) FROM stock_transfers)').get().w, defA)
    // admin 全局：照旧选最小 id 的隔离仓，可处置 B 仓单据
    okData(await api(`/api/qc/handlings/${dB}/confirm`, { token: f.admin, body: {} }))
    okData(await api(`/api/qc/handlings/${dBc}/confirm`, { token: f.admin, body: {} }))
    assert.equal(db.prepare('SELECT to_warehouse_id w FROM stock_transfers WHERE id=(SELECT MAX(id) FROM stock_transfers)').get().w, defId)
  })

  await t.test('warehouse master: reads trimmed to scope, writes need global scope', async () => {
    const list = okData(await api('/api/master/warehouses?all=1', { token: A.token }))
    assert.ok(list.length > 0)
    for (const w of list) assert.equal(w.org_id, whA.org_id, `leaked warehouse ${w.code}`)
    const paged = okData(await api('/api/master/warehouses?pageSize=500', { token: A.token }))
    assert.equal(paged.total, paged.list.length)
    assert.ok(paged.list.every((w) => w.org_id === whA.org_id))
    assert.ok(okData(await api('/api/master/warehouses?all=1', { token: f.admin })).some((w) => w.org_id !== whA.org_id), 'admin stays global')
    expectStatus(await api(`/api/master/warehouses/${whA.id}`, { token: A.token }), 200, 'detail in scope')
    const hid = await api(`/api/master/warehouses/${whB.id}`, { token: A.token })
    const mis = await api('/api/master/warehouses/999999', { token: A.token })
    expectStatus(hid, 404, 'detail out of scope'); assert.equal(hid.body.detail.code, mis.body.detail.code)
    assert.equal(okData(await api('/api/master/warehouses?all=1', { token: NONEtoken })).length, 0)
    // 写入：受限范围一律 403，库不变
    const snap = () => JSON.stringify(db.prepare('SELECT * FROM warehouses ORDER BY id').all())
    const s0 = snap()
    expectStatus(await api('/api/master/warehouses', { token: A.token, body: { code: 'AA4NEW', name: 'x' } }), 403, 'create')
    expectStatus(await api(`/api/master/warehouses/${whA.id}`, { token: A.token, method: 'PUT', body: { name: 'hijack' } }), 403, 'put in scope')
    expectStatus(await api(`/api/master/warehouses/${whB.id}`, { token: A.token, method: 'PUT', body: { status: 'inactive' } }), 403, 'put out of scope')
    expectStatus(await api(`/api/master/warehouses/${whB.id}`, { token: A.token, method: 'DELETE' }), 403, 'delete')
    assert.equal(snap(), s0)
    okData(await api('/api/master/warehouses', { token: f.admin, body: { code: 'AA4NEW', name: 'x' } }))
    okData(await api(`/api/master/warehouses/${whB.id}`, { token: f.admin, method: 'PUT', body: { name: 'WH03-renamed' } }))
    // 货位：读按范围裁剪，写入目标仓需在范围内
    db.prepare("INSERT INTO warehouse_locations (warehouse_id, code, name, type) VALUES (?, 'AA4-LA', 'la', 'storage')").run(whA.id)
    db.prepare("INSERT INTO warehouse_locations (warehouse_id, code, name, type) VALUES (?, 'AA4-LB', 'lb', 'storage')").run(whB.id)
    const locs = okData(await api('/api/master/locations', { token: A.token })).map((l) => l.code)
    assert.ok(locs.includes('AA4-LA') && !locs.includes('AA4-LB'))
    assert.ok(okData(await api('/api/master/locations', { token: f.admin })).some((l) => l.code === 'AA4-LB'))
    const lc = count('warehouse_locations')
    expectStatus(await api('/api/master/locations', { token: A.token, body: { warehouse_id: whB.id, code: 'AA4-LX' } }), 403, 'location create out of scope')
    assert.equal(count('warehouse_locations'), lc)
  })

  await t.test('purchase receipts and returns: document scope 404, target warehouse 403', async () => {
    const insGr = db.prepare("INSERT INTO purchase_receipts (doc_no, supplier_id, warehouse_id, receipt_date, status) VALUES (?,?,?,date('now','localtime'),'received')")
    const insPrt = db.prepare("INSERT INTO purchase_returns (doc_no, supplier_id, warehouse_id, return_date, status) VALUES (?,?,?,date('now','localtime'),?)")
    const GR = { A: Number(insGr.run('AA4-GR-A', supplierId, whA.id).lastInsertRowid), B: Number(insGr.run('AA4-GR-B', supplierId, whB.id).lastInsertRowid) }
    const PRT = {
      A: Number(insPrt.run('AA4-PRT-A', supplierId, whA.id, 'draft').lastInsertRowid),
      B: Number(insPrt.run('AA4-PRT-B', supplierId, whB.id, 'draft').lastInsertRowid),
      Bc: Number(insPrt.run('AA4-PRT-BC', supplierId, whB.id, 'confirmed').lastInsertRowid)
    }
    const row = (table, id) => JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id))
    const grNos = (r) => okData(r).list.map((x) => x.doc_no).filter((x) => x.startsWith('AA4-'))
    assert.deepEqual(grNos(await api('/api/purchase/receipts?pageSize=500', { token: A.token })), ['AA4-GR-A'])
    assert.equal(grNos(await api('/api/purchase/receipts?pageSize=500', { token: f.admin })).length, 2)
    assert.deepEqual(grNos(await api('/api/purchase/returns?pageSize=500', { token: A.token })), ['AA4-PRT-A'])
    assert.equal(grNos(await api('/api/purchase/returns?pageSize=500', { token: f.admin })).length, 3)
    assert.equal(okData(await api('/api/purchase/receipts?pageSize=500', { token: NONEtoken })).total, 0)
    assert.equal((await api(`/api/purchase/receipts/${GR.A}`, { token: A.token })).status, 200)
    const hid = await api(`/api/purchase/receipts/${GR.B}`, { token: A.token })
    expectStatus(hid, 404, 'receipt detail B')
    assert.deepEqual(hid.body, (await api('/api/purchase/receipts/999999', { token: A.token })).body)
    assert.equal((await api(`/api/purchase/receipts/${GR.B}`, { token: f.admin })).status, 200)
    // 关闭到货单 / 作废 / 完成退货单：范围外 404 且行不变
    const g0 = row('purchase_receipts', GR.B)
    expectStatus(await api(`/api/purchase/receipts/${GR.B}/close`, { token: A.token, body: {} }), 404, 'close B')
    assert.equal(row('purchase_receipts', GR.B), g0)
    for (const [k, act] of [['B', 'cancel'], ['Bc', 'complete']]) {
      const p0 = row('purchase_returns', PRT[k])
      expectStatus(await api(`/api/purchase/returns/${PRT[k]}/${act}`, { token: A.token, body: {} }), 404, `${act} ${k}`)
      assert.equal(row('purchase_returns', PRT[k]), p0)
    }
    okData(await api(`/api/purchase/returns/${PRT.A}/cancel`, { token: A.token, body: {} }))
    // 建退货单：目标仓不在范围内 403，且不出库
    const stockSnap = () => JSON.stringify(db.prepare('SELECT * FROM inventory_stocks ORDER BY id').all())
    const s0 = stockSnap(); const r0 = count('purchase_returns')
    for (const wh of [whB.id, 999999]) {
      expectStatus(await api('/api/purchase/returns', { token: A.token, body: { supplier_id: supplierId, warehouse_id: wh, items: [{ sku_id: sku, batch_no: 'AA4', qty: 1 }] } }), 403, `return wh ${wh}`)
    }
    assert.equal(stockSnap(), s0); assert.equal(count('purchase_returns'), r0)
    okData(await api('/api/purchase/returns', { token: A.token, body: { supplier_id: supplierId, warehouse_id: whA.id, items: [{ sku_id: sku, batch_no: 'AA4', qty: 1 }] } }))
    okData(await api('/api/purchase/returns', { token: f.admin, body: { supplier_id: supplierId, warehouse_id: whB.id, items: [{ sku_id: sku, batch_no: 'AA4', qty: 1 }] } }))
    okData(await api(`/api/purchase/returns/${PRT.B}/cancel`, { token: f.admin, body: {} }))
    okData(await api(`/api/purchase/receipts/${GR.B}/close`, { token: f.admin, body: {} }).then((r) => (r.status === 409 ? { status: 200, body: { data: {} } } : r)))
    // 收货建议：订单范围外 404
    const [poA, poB] = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 2').all()
    db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whA.id, poA.id)
    db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whB.id, poB.id)
    assert.equal((await api(`/api/purchase/orders/${poA.id}/receive-suggest`, { token: A.token })).status, 200)
    expectStatus(await api(`/api/purchase/orders/${poB.id}/receive-suggest`, { token: A.token }), 404, 'suggest B')
  })

  await t.test('legacy QC (module 07): inspections follow the receipt warehouse scope and cannot return foreign stock', async () => {
    const insGr = db.prepare("INSERT INTO purchase_receipts (doc_no, supplier_id, warehouse_id, receipt_date, status) VALUES (?,?,?,date('now','localtime'),'received')")
    const insQi = db.prepare("INSERT INTO purchase_inspections (doc_no, receipt_id, supplier_id, warehouse_id, inspect_date, status) VALUES (?,?,?,?,date('now','localtime'),'draft')")
    const gB = Number(insGr.run('AA4-LGR-B', supplierId, whB.id).lastInsertRowid)
    const gA = Number(insGr.run('AA4-LGR-A', supplierId, whA.id).lastInsertRowid)
    const qB = Number(insQi.run('AA4-LQ-B', gB, supplierId, whB.id).lastInsertRowid)
    const qA = Number(insQi.run('AA4-LQ-A', gA, supplierId, whA.id).lastInsertRowid)
    const prtBefore = count('purchase_returns'); const stockSnap = JSON.stringify(db.prepare('SELECT * FROM inventory_stocks ORDER BY id').all())
    const snap = () => JSON.stringify(db.prepare('SELECT * FROM purchase_inspections WHERE id=?').get(qB))
    const s0 = snap()
    expectStatus(await api(`/api/purchase/inspections/${qB}`, { token: A.token }), 404, 'legacy get')
    for (const act of ['submit', 'close', 'cancel']) expectStatus(await api(`/api/purchase/inspections/${qB}/${act}`, { token: A.token, body: { lines: [] } }), 404, act)
    expectStatus(await api('/api/purchase/inspections', { token: A.token, body: { receipt_id: gB } }), 404, 'create from foreign receipt')
    expectStatus(await api(`/api/purchase/inspections/receipt/${gB}`, { token: A.token }), 404, 'receipt fill')
    assert.equal(snap(), s0); assert.equal(count('purchase_returns'), prtBefore)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM inventory_stocks ORDER BY id').all()), stockSnap)
    const nos = okData(await api('/api/purchase/inspections?pageSize=500', { token: A.token })).list.map((r) => r.doc_no).filter((x) => x.startsWith('AA4-'))
    assert.deepEqual(nos, ['AA4-LQ-A'])
    assert.equal((await api(`/api/purchase/inspections/${qA}`, { token: A.token })).status, 200)
    const pend = okData(await api('/api/purchase/inspections/pending', { token: A.token })).list.map((r) => r.doc_no)
    assert.ok(!pend.includes('AA4-LGR-B'))
    assert.equal((await api(`/api/purchase/inspections/${qB}`, { token: f.admin })).status, 200)
  })

  await t.test('POS store stock covers all active warehouses of the bound store and nothing else', async () => {
    const stores = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 2').all()
    const [s1, s2] = stores.map((s) => s.id)
    db.prepare("UPDATE warehouses SET store_id=NULL WHERE store_id IN (?,?)").run(s1, s2)
    const w1a = mkWh('AA4S1A', whA.org_id, 'store', s1)
    const w1b = mkWh('AA4S1B', whA.org_id, 'store', s1)
    const w2 = mkWh('AA4S2', whB.org_id, 'store', s2)
    const w1off = mkWh('AA4S1OFF', whA.org_id, 'store', s1)
    db.prepare("UPDATE warehouses SET status='inactive' WHERE id=?").run(w1off)
    for (const [wh, b] of [[w1a, 'S1A'], [w1b, 'S1B'], [w2, 'S2'], [w1off, 'S1OFF']]) await adjust(wh, b, 7)
    const st1 = await f.account('aa4_store1', 'store', { store_id: s1 })
    const st2 = await f.account('aa4_store2', 'store', { store_id: s2 })
    const batches = async (acct) => okData(await api('/api/pos/stocks', { token: acct.token })).map((r) => r.batch_no).sort()
    assert.deepEqual(await batches(st1), ['S1A', 'S1B'])
    assert.deepEqual(await batches(st2), ['S2'])
    // 商品列表的 store_stock 也只汇总本店启用仓
    const prod = okData(await api(`/api/pos/products?kw=`, { token: st1.token })).find((p) => p.sku_id === sku)
    assert.equal(Number(prod.store_stock), 14)
    const prod2 = okData(await api(`/api/pos/products?kw=`, { token: st2.token })).find((p) => p.sku_id === sku)
    assert.equal(Number(prod2.store_stock), 7)
    // 门店绑定 + 组织范围冲突：带 A 组织的门店账号，门店下挂了 B 组织的仓 ⇒ 读不到 B 仓库存
    const w1x = mkWh('AA4S1X', whB.org_id, 'store', s1)
    await adjust(w1x, 'S1X', 7)
    const stOrg = await f.account('aa4_store_orgA', 'store', { store_id: s1, org_id: whA.org_id, data_scope: 'org' })
    assert.deepEqual(await batches(stOrg), ['S1A', 'S1B'])
    assert.deepEqual(await batches(st1), ['S1A', 'S1B', 'S1X'], 'store binding alone stays authoritative for accounts without an org')
    // 未绑定门店的非 admin 账号读不到任何库存
    const unbound = await f.account('aa4_store_none', 'store')
    expectStatus(await api('/api/pos/stocks', { token: unbound.token }), 403, 'unbound')
  })
})

test('AB1: master options warehouses, purchase order list/detail and QC overview/audit follow the warehouse-org scope (ADR-0046)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const supplierId = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of ['quality.qc.view', 'quality.inspect.view', 'purchase.order.view']) grant.run('warehouse', p)
  const A = await f.account('ab1_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const NONE = await f.account('ab1_wh_none', 'warehouse', { data_scope: 'org' })
  db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(NONE.id)
  const NONEtoken = await f.login(NONE.username, NONE.password)

  await t.test('master/options: warehouse items trimmed to scope, other lists and global scope unchanged', async () => {
    const whOf = (o) => o.warehouses_all.map((w) => w.value)
    const ids = (rows) => rows.map((w) => w.value)
    const adminOpt = okData(await api('/api/master/options', { token: f.admin }))
    assert.ok(ids(adminOpt.warehouses_all).includes(whA.id) && ids(adminOpt.warehouses_all).includes(whB.id), 'admin stays global')
    const opt = okData(await api('/api/master/options', { token: A.token }))
    const inOrg = db.prepare("SELECT id FROM warehouses WHERE status='active' AND org_id=?").all(whA.org_id).map((w) => w.id)
    assert.deepEqual(whOf(opt).sort((a, b) => a - b), inOrg.sort((a, b) => a - b))
    assert.ok(!ids(opt.warehouses).includes(whB.id) && !ids(opt.warehouses_all).includes(whB.id))
    assert.ok(ids(opt.warehouses).every((id) => inOrg.includes(id)))
    assert.deepEqual(opt.suppliers, adminOpt.suppliers, 'non-warehouse items unchanged')
    const none = okData(await api('/api/master/options', { token: NONEtoken }))
    assert.deepEqual([none.warehouses, none.warehouses_all], [[], []])
  })

  await t.test('purchase orders list and detail go through the document scope', async () => {
    const ins = db.prepare("INSERT INTO purchase_orders (doc_no, supplier_id, warehouse_id, order_date, status) VALUES (?,?,?,date('now','localtime'),'draft')")
    const poA = Number(ins.run('AB1-PO-A', supplierId, whA.id).lastInsertRowid)
    const poB = Number(ins.run('AB1-PO-B', supplierId, whB.id).lastInsertRowid)
    const names = (r) => okData(r).list.map((x) => x.doc_no).filter((x) => x.startsWith('AB1-'))
    assert.deepEqual(names(await api('/api/purchase/orders?pageSize=500', { token: A.token })), ['AB1-PO-A'])
    assert.equal(names(await api('/api/purchase/orders?pageSize=500', { token: f.admin })).length, 2)
    const pg = okData(await api('/api/purchase/orders?pageSize=500', { token: A.token }))
    assert.equal(pg.total, pg.list.length, 'total uses the same predicate')
    assert.equal(okData(await api('/api/purchase/orders?pageSize=500', { token: NONEtoken })).total, 0)
    assert.equal((await api(`/api/purchase/orders/${poA}`, { token: A.token })).status, 200)
    const hid = await api(`/api/purchase/orders/${poB}`, { token: A.token })
    expectStatus(hid, 404, 'detail out of scope')
    assert.deepEqual(hid.body, (await api('/api/purchase/orders/999999', { token: A.token })).body, 'same shape as missing')
    assert.equal((await api(`/api/purchase/orders/${poB}`, { token: f.admin })).status, 200)
    expectStatus(await api(`/api/purchase/orders/${poA}`, { token: NONEtoken }), 404, 'no-org detail')
  })

  await t.test('QC overview and audit aggregate only in-scope warehouses', async () => {
    const insReq = db.prepare("INSERT INTO qc_requests (doc_no, source_type, request_date, warehouse_id, status, total_qty) VALUES (?,?,date('now','localtime'),?, 'submitted', 5)")
    const insItem = db.prepare('INSERT INTO qc_request_items (request_id, line_no, sku_id, batch_no, qty, sample_qty, defect_qty, ac, re, result) VALUES (?,1,?,?,?,?,?,0,1,?)')
    const rqA = Number(insReq.run('AB1-QR-A', 'inventory', whA.id).lastInsertRowid)
    insItem.run(rqA, sku, 'AB1', 5, 2, 0, 'qualified')
    const base = okData(await api('/api/qc/overview', { token: f.admin }))
    const baseAudit = okData(await api('/api/qc/audit', { token: f.admin }))
    // B 仓一张自洽性破损的报检单（抽样 > 报检、判定与数字相反）
    const rqB = Number(insReq.run('AB1-QR-B', 'inventory', whB.id).lastInsertRowid)
    insItem.run(rqB, sku, 'AB1B', 5, 9, 4, 'qualified')
    const adminOv = okData(await api('/api/qc/overview', { token: f.admin }))
    assert.equal(adminOv.requests, base.requests + 1, 'admin sees the foreign request')
    assert.ok(okData(await api('/api/qc/audit', { token: f.admin })).badLineQty.length > baseAudit.badLineQty.length)
    const ovA = okData(await api('/api/qc/overview', { token: A.token }))
    const inA = db.prepare('SELECT COUNT(*) c FROM qc_requests WHERE warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)').get(whA.org_id).c
    assert.equal(ovA.requests, inA)
    assert.ok(ovA.requests < adminOv.requests)
    assert.equal(ovA.requests_submitted, db.prepare("SELECT COUNT(*) c FROM qc_requests WHERE status='submitted' AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)").get(whA.org_id).c)
    const auA = okData(await api('/api/qc/audit', { token: A.token }))
    assert.ok(!JSON.stringify(auA).includes(`"request_id":${rqB}`), 'foreign broken lines not reported')
    assert.equal(auA.badLineQty.length, 0); assert.equal(auA.badVerdict.length, 0)
    const ovN = okData(await api('/api/qc/overview', { token: NONEtoken }))
    assert.equal(ovN.requests, 0); assert.equal(ovN.inspections, 0); assert.equal(ovN.handlings, 0)
    assert.deepEqual(okData(await api('/api/qc/audit', { token: NONEtoken })).badLineQty, [])
  })

  await t.test('purchase inspection overview (qc.js) is scoped by receipt warehouse', async () => {
    const insGr = db.prepare("INSERT INTO purchase_receipts (doc_no, supplier_id, warehouse_id, receipt_date, status) VALUES (?,?,?,date('now','localtime'),'received')")
    const grA = Number(insGr.run('AB1-GR-A', supplierId, whA.id).lastInsertRowid)
    const grB = Number(insGr.run('AB1-GR-B', supplierId, whB.id).lastInsertRowid)
    const insI = db.prepare("INSERT INTO purchase_inspections (doc_no, receipt_id, supplier_id, warehouse_id, inspect_date, total_qty, rejected_qty, status) VALUES (?,?,?,?,date('now','localtime'),10,?,'inspected')")
    insI.run('AB1-QC-A', grA, supplierId, whA.id, 1)
    insI.run('AB1-QC-B', grB, supplierId, whB.id, 4)
    const a = okData(await api('/api/purchase/inspections/overview', { token: A.token }))
    const admin = okData(await api('/api/purchase/inspections/overview', { token: f.admin }))
    assert.equal(a.inspected, db.prepare("SELECT COUNT(*) c FROM purchase_inspections WHERE status='inspected' AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)").get(whA.org_id).c)
    assert.equal(admin.inspected, db.prepare("SELECT COUNT(*) c FROM purchase_inspections WHERE status='inspected'").get().c)
    assert.ok(admin.inspected > a.inspected, 'admin also sees the foreign inspection')
    assert.equal(a.rejected_qty, 1)
    assert.equal(okData(await api('/api/purchase/inspections/overview', { token: NONEtoken })).total, 0)
  })
})
