/**
 * ============================================================================
 * 文件标识：tests/purchase-action-scope.test.mjs ｜ 测试：采购链动作路由与 MCP 采购工具的单据范围（ADR-0031）
 * ============================================================================
 * 【职责】守住 ADR-0031：
 *     · `POST /requisitions|invoices|settlements|payments/:id/:action`、`/requisitions/:id/convert`、
 *       `/payments/:id/review`、`/orders/:id/receive-check` 取单后按组织范围判定，范围外 404（与不存在同形）且不产生写；
 *     · MCP `purchase.build_settlement` / `purchase.create_payment` 把委托生效范围传给 lib，来源选择与手工核销不越界。
 * 【夹具口径】同 purchase-chain-detail-scope.test.mjs：test 运行时、临时数据目录、随机回环端口，单据直接写库。
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
import { createToken } from '../server/mcp/tokens.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-purchase-action-scope-'))
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
  let seq = 0
  const mcp = async (name, args, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15000)
    })
    const body = await res.json()
    const text = body.result?.content?.[0]?.text
    let payload
    try { payload = JSON.parse(text) } catch { payload = text }
    return { status: res.status, rpcError: body.error?.data?.code ?? null, isError: !!body.result?.isError, payload }
  }
  return { dir, api, db, admin, login, account, mcp }
}



const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const notFound = (r, m) => assert.equal(r.status, 404, `${m}: ${JSON.stringify(r.body)}`)

test('purchase action routes and MCP purchase tools respect document org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const whs = db.prepare(`SELECT w.id, w.org_id, o.path, o.parent_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id`).all()
  const whA = whs[0]
  const whB = whs.find((w) => !w.path.startsWith(whA.path) && !whA.path.startsWith(w.path) &&
    !w.path.startsWith(db.prepare('SELECT path FROM orgs WHERE id=?').get(whA.parent_id).path))
  assert.ok(whA && whB, 'demo data must provide warehouses on two disjoint org branches')
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const id = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid)
  const rowOf = (table, i) => JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(i))
  const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c

  const prq = (no, org, wh, status = 'submitted') => id(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id, supplier_id) VALUES (?,?,date('now'),?,100,?,?)`, no, org, status, wh, supplier)
  const PRQ = { A: prq('PRQ-ACT-A', whA.org_id, whA.id), B: prq('PRQ-ACT-B', whB.org_id, whB.id), N: prq('PRQ-ACT-N', null, null) }
  const PRQ_ap = { A: prq('PRQ-ACT-AA', whA.org_id, whA.id, 'approved'), B: prq('PRQ-ACT-BA', whB.org_id, whB.id, 'approved') }
  const inv = (no, org) => id(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status) VALUES (?,?,?,date('now'),10,0,10,'draft')`, no, org, supplier)
  const PI = { A: inv('PI-ACT-A', whA.org_id), B: inv('PI-ACT-B', whB.org_id), N: inv('PI-ACT-N', null) }
  const st = (no, org) => id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES (?,?,?,date('now'),500,0,0,'draft')`, no, org, supplier)
  const PST = { A: st('PST-ACT-A', whA.org_id), B: st('PST-ACT-B', whB.org_id), N: st('PST-ACT-N', null) }
  const pay = (no, org) => id(`INSERT INTO purchase_payments (doc_no, org_id, supplier_id, pay_date, amount, settled_amount, status) VALUES (?,?,?,date('now'),50,0,'draft')`, no, org, supplier)
  const PAY = { A: pay('PAY-ACT-A', whA.org_id), B: pay('PAY-ACT-B', whB.org_id), N: pay('PAY-ACT-N', null) }
  const [poA, poB] = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 2').all()
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whA.id, poA.id)
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whB.id, poB.id)

  // 授予所有动作权限点：权限不是本测试要证明的东西，范围才是（权限不足是另一个 403，会掩盖 404）
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  const perms = ['purchase.order.view', 'purchase.order.edit', 'purchase.req.view', 'purchase.req.edit', 'purchase.req.approve',
    'purchase.invoice.view', 'purchase.invoice.edit', 'purchase.invoice.verify', 'purchase.settle.view', 'purchase.settle.edit',
    'purchase.settle.audit', 'purchase.payment.view', 'purchase.payment.edit', 'purchase.payment.approve', 'finance.funds.review']
  for (const p of perms) grant.run('purchase', p)

  const a = await f.account('act_a', 'purchase', { org_id: whA.org_id, data_scope: 'org' })

  await t.test('every action route returns 404 for out-of-scope documents and leaves the row untouched', async () => {
    const cases = [
      ['purchase_requisitions', 'requisitions', PRQ, ['approve', 'reject', 'cancel']],
      ['purchase_invoices', 'invoices', PI, ['verify', 'void']],
      ['purchase_settlements', 'settlements', PST, ['audit', 'void']],
      ['purchase_payments', 'payments', PAY, ['approve', 'void']]
    ]
    for (const [table, seg, docs, actions] of cases) {
      for (const k of ['B', 'N']) {
        for (const action of actions) {
          const before = rowOf(table, docs[k])
          notFound(await api(`/api/purchase/${seg}/${docs[k]}/${action}`, { token: a.token, body: {} }), `${seg} ${k} ${action}`)
          assert.equal(rowOf(table, docs[k]), before, `${seg} ${k} ${action} must not write`)
        }
      }
      // 与"不存在"同形
      const miss = await api(`/api/purchase/${seg}/999999/${actions[0]}`, { token: a.token, body: {} })
      const hid = await api(`/api/purchase/${seg}/${docs.B}/${actions[0]}`, { token: a.token, body: {} })
      assert.deepEqual(hid.body, miss.body, `${seg} hidden vs missing`)
    }
    notFound(await api(`/api/purchase/payments/${PAY.B}/review`, { token: a.token, body: { decision: 'approve' } }), 'review B')
    notFound(await api(`/api/purchase/payments/${PAY.N}/review`, { token: a.token, body: { decision: 'approve' } }), 'review N')
    notFound(await api(`/api/purchase/requisitions/${PRQ_ap.B}/convert`, { token: a.token, body: {} }), 'convert B')
    notFound(await api(`/api/purchase/orders/${poB.id}/receive-check`, { token: a.token, body: { lines: [] } }), 'receive-check B')
    assert.equal(db.prepare("SELECT status FROM purchase_requisitions WHERE id=?").get(PRQ_ap.B).status, 'approved')
  })

  await t.test('in-scope documents still act (200) and admin acts globally', async () => {
    okData(await api(`/api/purchase/requisitions/${PRQ.A}/approve`, { token: a.token, body: {} }))
    assert.equal(db.prepare('SELECT status FROM purchase_requisitions WHERE id=?').get(PRQ.A).status, 'approved')
    okData(await api(`/api/purchase/orders/${poA.id}/receive-check`, { token: a.token, body: { lines: [] } }))
    okData(await api(`/api/purchase/requisitions/${PRQ.B}/approve`, { token: f.admin, body: {} }))
    okData(await api(`/api/purchase/requisitions/${PRQ.N}/approve`, { token: f.admin, body: {} }))
    notFound(await api('/api/purchase/requisitions/999999/approve', { token: f.admin, body: {} }), 'admin missing')
    assert.notEqual((await api(`/api/purchase/payments/${PAY.A}/void`, { token: a.token, body: {} })).status, 404)
  })

  await t.test('convert cannot target a warehouse outside the caller scope', async () => {
    const before = count('purchase_orders')
    notFound(await api(`/api/purchase/requisitions/${PRQ_ap.A}/convert`, { token: a.token, body: { warehouse_id: whB.id } }), 'foreign warehouse')
    assert.equal(count('purchase_orders'), before)
  })

  await t.test('receive-check and review require the internal read gate', async () => {
    const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('AS1','Action store')").run().lastInsertRowid)
    const store = await f.account('act_store', 'store', { store_id: storeId })
    assert.equal((await api(`/api/purchase/orders/${poA.id}/receive-check`, { token: store.token, body: { lines: [] } })).status, 403)
    assert.equal((await api(`/api/purchase/orders/${poA.id}/receive-check`, { body: { lines: [] } })).status, 401)
    const none = await f.account('act_none', 'purchase', { data_scope: 'org' })
    notFound(await api(`/api/purchase/orders/${poA.id}/receive-check`, { token: none.token, body: { lines: [] } }), 'no-org account')
    notFound(await api(`/api/purchase/payments/${PAY.A}/review`, { token: none.token, body: { decision: 'approve' } }), 'no-org review')
  })

  await t.test('MCP build_settlement only draws sources inside the effective scope', async () => {
    const sup = Number(db.prepare("INSERT INTO suppliers (code,name) VALUES ('ACTSUP','Action supplier')").run().lastInsertRowid)
    db.prepare(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status) VALUES ('PI-ACT-SB',?,?,date('now'),2000,0,2000,'verified')`).run(whB.org_id, sup)
    const token = createToken(db, { name: 'act-a', ownerUserId: a.id, industry: 'cosmetic', scopes: 'read,write,danger' }).token
    const before = count('purchase_settlements')
    const denied = await mcp('purchase.build_settlement', { supplier_id: sup, org_id: whA.org_id, idempotency_key: 'act-pst-1' }, token)
    assert.equal(denied.isError, true, JSON.stringify(denied))
    assert.equal(denied.payload.error, 'PST_NOTHING')
    assert.equal(count('purchase_settlements'), before)
    db.prepare(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status) VALUES ('PI-ACT-SA',?,?,date('now'),700,0,700,'verified')`).run(whA.org_id, sup)
    const okRes = await mcp('purchase.build_settlement', { supplier_id: sup, org_id: whA.org_id, idempotency_key: 'act-pst-2' }, token)
    assert.equal(okRes.isError, false, JSON.stringify(okRes))
    const row = db.prepare('SELECT id, settle_amount FROM purchase_settlements WHERE id=?').get(okRes.payload.data?.id ?? okRes.payload.id)
    assert.equal(row.settle_amount, 700, 'B invoice must not be settled')
    assert.equal(db.prepare("SELECT settle_id FROM purchase_invoices WHERE doc_no='PI-ACT-SB'").get().settle_id, null)
    // 全局令牌同一供应商仍能结到 B 的票（范围来自所有者，不是工具硬编码）
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id
    const gtoken = createToken(db, { name: 'act-g', ownerUserId: adminId, industry: 'cosmetic', scopes: 'read,write,danger' }).token
    const g = await mcp('purchase.build_settlement', { supplier_id: sup, org_id: whB.org_id, idempotency_key: 'act-pst-3' }, gtoken)
    assert.equal(g.isError, false, JSON.stringify(g))
  })

  await t.test('MCP create_payment refuses manual allocation to an out-of-scope settlement and FIFO ignores it', async () => {
    const sup = Number(db.prepare("INSERT INTO suppliers (code,name) VALUES ('ACTSUP2','Action supplier 2')").run().lastInsertRowid)
    const stB = id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES ('PST-ACT-PB',?,?,'2000-01-01',900,0,0,'audited')`, whB.org_id, sup)
    const stA = id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES ('PST-ACT-PA',?,?,'2000-02-01',300,0,0,'audited')`, whA.org_id, sup)
    const token = createToken(db, { name: 'act-a2', ownerUserId: a.id, industry: 'cosmetic', scopes: 'read,write,danger' }).token
    const before = count('purchase_payments')
    const manual = await mcp('purchase.create_payment', { supplier_id: sup, org_id: whA.org_id, amount: 100, allocations: [{ settle_id: stB, amount: 100 }], idempotency_key: 'act-pay-1' }, token)
    assert.equal(manual.isError, true, JSON.stringify(manual))
    assert.equal(manual.payload.error, 'DOC_NOT_FOUND')
    assert.equal(count('purchase_payments'), before)
    const auto = await mcp('purchase.create_payment', { supplier_id: sup, org_id: whA.org_id, amount: 1000, idempotency_key: 'act-pay-2' }, token)
    assert.equal(auto.isError, false, JSON.stringify(auto))
    const items = db.prepare('SELECT settle_id, amount FROM purchase_payment_items WHERE payment_id=?').all(auto.payload.data?.id ?? auto.payload.id)
    assert.deepEqual(items, [{ settle_id: stA, amount: 300 }], 'FIFO must only touch in-scope settlements')
  })
})
