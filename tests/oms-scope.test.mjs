/**
 * ============================================================================
 * 文件标识：tests/oms-scope.test.mjs ｜ 测试：OMS 读接口与 MCP 单据历史工具按组织范围收口（ADR-0039）
 * ============================================================================
 * 【职责】守住 ADR-0039：
 *   · `/api/oms` 的读接口（platforms / orders / orders/:id / sync-logs / stats / qimen-message / qimen-stock-message）
 *     按平台绑定组织（履约仓所属组织）过滤，范围外详情与不存在同形 404；未绑定平台只对全局范围可见；外部角色仍 403；
 *   · MCP `doc.get`（单据详情 + 流转留痕）用 docflow 的 `DOC_SCOPE_RESOLVERS` 判范围：
 *     经销商推断归属不再放大可见性，无组织归属的全局类型（OM 等）对受限令牌 404，绑定类型仍叠加 Y6 绑定判定。
 *   · ADR-0042：OMS 写路由（ship / complete / refund / stock-push）同判据：范围外 404、销售订单仓越界 403、库存推送只含范围内平台与仓。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-oms-scope-'))
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

test('OMS read routes and MCP doc history follow the org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  process.env.GML_RUNTIME_MODE = 'test'
  const { TOOLS } = await import('../server/mcp/tools.js')
  const docGet = (args, scope, extra = {}) => TOOLS.find((x) => x.name === 'doc.get').handler({ db, args, ctx: { scope, tokenName: 'z2', orgId: null, ...extra } })

  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whA.org_id).parent_id
  const pfAId = Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('Z2P-A','Z2平台A',?)").run(whA.id).lastInsertRowid)
  const pfA = db.prepare('SELECT * FROM platforms WHERE id=?').get(pfAId)
  const pfB = db.prepare('SELECT * FROM platforms WHERE warehouse_id=? ORDER BY id LIMIT 1').get(whB.id)
  assert.ok(pfA && pfB && pfA.id !== pfB.id, 'platforms on WH01 and WH03')
  const pfUnbound = Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('Z2P-NOWH','Z2无仓平台',NULL)").run().lastInsertRowid)
  const whNoOrg = Number(db.prepare("INSERT INTO warehouses (code, name, type, org_id) VALUES ('Z2W-NOORG','Z2无组织仓','ecom',NULL)").run().lastInsertRowid)
  const pfNoOrg = Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('Z2P-NOORG','Z2无组织平台',?)").run(whNoOrg).lastInsertRowid)

  const insO = db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, status, goods_amount, pay_amount, order_time, receiver) VALUES (?,?, 'pending', 10, 10, datetime('now','localtime'), ?)")
  const mkO = (pf, no) => Number(insO.run(pf, no, `收件人-${no}`).lastInsertRowid)
  const oA = mkO(pfA.id, 'Z2-A')
  const oB = mkO(pfB.id, 'Z2-B')
  const oU = mkO(pfUnbound, 'Z2-U')
  const oN = mkO(pfNoOrg, 'Z2-N')
  const insI = db.prepare('INSERT INTO oms_order_items (oms_order_id, platform_sku_code, title, qty, price, amount) VALUES (?,?,?,1,10,10)')
  for (const id of [oA, oB, oU, oN]) insI.run(id, 'Z2', 'z2')
  const insL = db.prepare("INSERT INTO oms_sync_logs (platform_id, sync_type, status, message) VALUES (?, 'z2sync', 'success', ?)")
  const logCols = db.prepare('PRAGMA table_info(oms_sync_logs)').all().map((c) => c.name)
  for (const c of ['platform_id', 'sync_type', 'status', 'message']) assert.ok(logCols.includes(c), `oms_sync_logs.${c}`)
  for (const pf of [pfA.id, pfB.id, pfUnbound, pfNoOrg]) insL.run(pf, `z2-${pf}`)

  const accountA = await f.account('z2_oms_a', 'sales', { org_id: whA.org_id, data_scope: 'org' })
  const accountB = await f.account('z2_oms_b', 'sales', { org_id: whB.org_id, data_scope: 'org' })
  const accountSub = await f.account('z2_oms_sub', 'sales', { org_id: parentOrg, data_scope: 'subtree' })
  const accountNone = await f.account('z2_oms_none', 'sales', { data_scope: 'org' })
  const accountAll = await f.account('z2_oms_all', 'sales', { data_scope: 'all' })

  const list = async (token, qs = '') => okData(await api(`/api/oms/orders?pageSize=500&keyword=Z2-${qs}`, { token }))
  const nos = async (token) => (await list(token)).list.map((x) => x.platform_order_no).sort()

  await t.test('GET /orders: exact sets per org; unbound platforms only for the global view; summary and total agree', async () => {
    for (const tk of [f.admin, accountAll.token]) assert.deepEqual(await nos(tk), ['Z2-A', 'Z2-B', 'Z2-N', 'Z2-U'])
    assert.deepEqual(await nos(accountA.token), ['Z2-A'])
    assert.deepEqual(await nos(accountB.token), ['Z2-B'])
    assert.deepEqual(await nos(accountNone.token), [])
    const sub = await nos(accountSub.token)
    assert.ok(sub.includes('Z2-A') && !sub.includes('Z2-U') && !sub.includes('Z2-N'), `subtree: ${sub}`)
    const a = await list(accountA.token)
    assert.equal(a.total, 1)
    assert.equal(a.summary.count, 1)
    assert.equal(a.summary.amount, 10)
    // 平台过滤参数不能越过范围
    const cross = okData(await api(`/api/oms/orders?pageSize=500&platform_id=${pfB.id}`, { token: accountA.token }))
    assert.equal(cross.total, 0)
    assert.equal(cross.list.length, 0)
  })

  await t.test('GET /orders/:id: out-of-scope is byte-identical to not-found', async () => {
    assert.equal(okData(await api(`/api/oms/orders/${oA}`, { token: accountA.token })).platform_order_no, 'Z2-A')
    const missing = await api('/api/oms/orders/99999999', { token: accountA.token })
    assert.equal(missing.status, 404)
    for (const id of [oB, oU, oN]) {
      const r = await api(`/api/oms/orders/${id}`, { token: accountA.token })
      assert.equal(r.status, 404, `order ${id}`)
      assert.deepEqual(r.body, missing.body)
    }
    assert.equal((await api(`/api/oms/orders/${oA}`, { token: accountNone.token })).status, 404)
    for (const id of [oA, oB, oU, oN]) assert.equal((await api(`/api/oms/orders/${id}`, { token: f.admin })).status, 200)
  })

  await t.test('GET /platforms, /sync-logs, /stats only cover in-scope platforms', async () => {
    const ids = async (token) => okData(await api('/api/oms/platforms', { token })).map((p) => p.id).sort((x, y) => x - y)
    const everyone = db.prepare('SELECT id FROM platforms ORDER BY id').all().map((x) => x.id)
    assert.deepEqual(await ids(f.admin), everyone)
    const inA = db.prepare('SELECT p.id FROM platforms p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=? ORDER BY p.id').all(whA.org_id).map((x) => x.id)
    assert.deepEqual(await ids(accountA.token), inA)
    assert.deepEqual(await ids(accountNone.token), [])
    const logs = async (token) => okData(await api('/api/oms/sync-logs?pageSize=500&sync_type=z2sync', { token }))
    assert.equal((await logs(f.admin)).total, 4)
    assert.deepEqual((await logs(accountA.token)).list.map((x) => x.platform_id), [pfA.id])
    assert.equal((await logs(accountNone.token)).total, 0)
    const stats = async (token) => okData(await api('/api/oms/stats?days=30', { token }))
    const sa = await stats(accountA.token)
    const wantA = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) g FROM oms_orders o JOIN platforms p ON p.id=o.platform_id JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=? AND date(o.order_time) >= date('now','localtime','-30 day')").get(whA.org_id)
    assert.equal(sa.total.orders, wantA.c)
    assert.equal(sa.total.gmv, wantA.g)
    assert.ok(sa.byPlatform.every((p) => inA.includes(db.prepare('SELECT id FROM platforms WHERE code=?').get(p.code).id)))
    assert.equal((await stats(accountNone.token)).total.orders, 0)
    const sAll = await stats(f.admin)
    assert.ok(sAll.total.orders >= wantA.c + 3)
  })

  await t.test('GET /qimen-message and /qimen-stock-message hide out-of-scope orders and platforms', async () => {
    assert.equal((await api(`/api/oms/qimen-message/${oA}`, { token: accountA.token })).status, 200)
    const missing = await api('/api/oms/qimen-message/99999999', { token: accountA.token })
    for (const id of [oB, oU, oN]) {
      const r = await api(`/api/oms/qimen-message/${id}`, { token: accountA.token })
      assert.equal(r.status, 404)
      assert.deepEqual(r.body, missing.body)
    }
    assert.equal((await api(`/api/oms/qimen-message/${oB}`, { token: f.admin })).status, 200)
    assert.equal((await api(`/api/oms/qimen-stock-message/${pfA.id}`, { token: accountA.token })).status, 200)
    const missingPf = await api('/api/oms/qimen-stock-message/99999999', { token: accountA.token })
    for (const id of [pfB.id, pfUnbound, pfNoOrg]) {
      const r = await api(`/api/oms/qimen-stock-message/${id}`, { token: accountA.token })
      assert.equal(r.status, 404)
      assert.deepEqual(r.body, missingPf.body)
    }
    assert.equal((await api(`/api/oms/qimen-stock-message/${pfB.id}`, { token: f.admin })).status, 200)
  })

  await t.test('external roles stay rejected on OMS reads', async () => {
    const dealerId = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get().id
    const ext = await f.account('z2_oms_dealer', 'dealer', { dealer_id: dealerId })
    for (const route of ['/api/oms/orders', `/api/oms/orders/${oA}`, '/api/oms/platforms', '/api/oms/stats', '/api/oms/sync-logs']) {
      assert.equal((await api(route, { token: ext.token })).status, 403, route)
    }
  })

  // ---------------------------------------------------------------- MCP doc.get (history)
  const scopeOf = (orgIds, kind = 'org') => ({ scope: kind, orgIds })
  const code = (fn) => { try { fn(); return null } catch (e) { return e.code } }
  const insEv = db.prepare("INSERT INTO doc_events (doc_type, doc_id, doc_no, action, from_state, to_state, actor_name, remark) VALUES (?,?,?,'z2event','a','b','z2','z2 history')")
  const dealerA = Number(db.prepare("INSERT INTO dealers (code, name, org_id) VALUES ('Z2D-A','Z2经销商A',?)").run(whA.org_id).lastInsertRowid)

  await t.test('doc.get on SO: dealer-inferred ownership no longer widens visibility (events included)', async () => {
    const insSo = db.prepare(`INSERT INTO sales_orders (doc_no, channel, dealer_id, store_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
      VALUES (?, 'dealer', ?, NULL, date('now','localtime'), 'draft', 1, 10, 10, ?)`)
    const soInA = Number(insSo.run('Z2-SO-A', dealerA, whA.id).lastInsertRowid)
    // 经销商属于 A 组织，但出货仓归 B：HTTP 的 salesScopeSql 对 A 不可见，MCP 不得因 dealer_id 推断而放行
    const soDealerOnly = Number(insSo.run('Z2-SO-D', dealerA, whB.id).lastInsertRowid)
    for (const id of [soInA, soDealerOnly]) insEv.run('SO', id, `Z2-SO-${id}`)
    const hit = docGet({ doc_type: 'SO', id: soInA }, scopeOf([whA.org_id]))
    assert.ok((hit.data?.events ?? hit.events).some((e) => e.action === 'z2event'))
    assert.equal(code(() => docGet({ doc_type: 'SO', id: soDealerOnly }, scopeOf([whA.org_id]))), 'NOT_FOUND')
    assert.equal(code(() => docGet({ doc_type: 'SO', id: soDealerOnly }, scopeOf([whB.org_id]))), null)
    assert.equal(code(() => docGet({ doc_type: 'SO', id: soDealerOnly }, { scope: 'all', orgIds: null })), null)
    assert.equal(code(() => docGet({ doc_type: 'SO', id: soInA }, scopeOf([]))), 'NOT_FOUND')
    assert.equal(code(() => docGet({ doc_type: 'SO', id: soInA }, { scope: 'dealer', orgIds: [whA.org_id] })), 'NOT_FOUND')
    assert.equal(code(() => docGet({ doc_type: 'SO', id: 99999999 }, scopeOf([whA.org_id]))), 'NOT_FOUND')
    // 与 HTTP 同判据
    assert.equal((await api(`/api/sales/orders/${soDealerOnly}`, { token: accountA.token })).status, 404)
  })

  await t.test('doc.get on global-only types (OM) is invisible to restricted scopes', async () => {
    insEv.run('OM', oA, 'Z2-A')
    assert.equal(code(() => docGet({ doc_type: 'OM', id: oA }, scopeOf([whA.org_id]))), 'NOT_FOUND')
    assert.equal(code(() => docGet({ doc_type: 'OM', id: oA }, { scope: 'all', orgIds: null })), null)
  })

  await t.test('doc.get on warehouse-owned types follows the warehouse org (PO)', async () => {
    const poA = db.prepare('SELECT p.id FROM purchase_orders p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=? ORDER BY p.id LIMIT 1').get(whA.org_id)
    const poOther = db.prepare('SELECT p.id FROM purchase_orders p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id<>? ORDER BY p.id LIMIT 1').get(whA.org_id)
    assert.ok(poA && poOther, 'demo has POs in two orgs')
    assert.equal(code(() => docGet({ doc_type: 'PO', id: poA.id }, scopeOf([whA.org_id]))), null)
    assert.equal(code(() => docGet({ doc_type: 'PO', id: poOther.id }, scopeOf([whA.org_id]))), 'NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------------------------
// ADR-0042：OMS 写路由（ship / complete / refund / stock-push）按平台绑定组织收口
// ---------------------------------------------------------------------------------------------
test('OMS write routes follow the platform-bound org scope (ADR-0042)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const mkPf = (code, wh) => Number(db.prepare("INSERT INTO platforms (code, name, warehouse_id, sync_stock, status) VALUES (?,?,?,1,'active')").run(code, code, wh).lastInsertRowid)
  const pfA = mkPf('AA2P-A', whA.id)
  const pfB = mkPf('AA2P-B', whB.id)
  const pfU = mkPf('AA2P-U', null)
  const insO = db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, status, goods_amount, pay_amount, order_time, receiver, sales_order_id) VALUES (?,?,?,10,10,datetime('now','localtime'),'r',?)")
  const mkO = (pf, no, status = 'pending', so = null) => Number(insO.run(pf, no, status, so).lastInsertRowid)
  const insSo = db.prepare(`INSERT INTO sales_orders (doc_no, channel, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
    VALUES (?, 'platform', date('now','localtime'), 'confirmed', 1, 10, 10, ?)`)
  const soInB = Number(insSo.run('AA2-SO-B', whB.id).lastInsertRowid) // 平台在 A，但销售订单的仓在 B
  const oA = mkO(pfA, 'AA2-A')
  const oAcomplete = mkO(pfA, 'AA2-A2', 'shipped')
  const oArefund = mkO(pfA, 'AA2-A3')
  const oB = mkO(pfB, 'AA2-B')
  const oBshipped = mkO(pfB, 'AA2-B2', 'shipped')
  const oU = mkO(pfU, 'AA2-U')
  const oTarget = mkO(pfA, 'AA2-T', 'pending', soInB)
  const oTargetRefund = mkO(pfA, 'AA2-T2', 'pending', soInB)
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whA.org_id).parent_id

  const accountA = await f.account('aa2_oms_a', 'sales', { org_id: whA.org_id, data_scope: 'org' })
  const accountNone = await f.account('aa2_oms_none', 'sales', { data_scope: 'org' })
  const accountAll = await f.account('aa2_oms_all', 'sales', { data_scope: 'all' })
  const status = (id) => db.prepare('SELECT status FROM oms_orders WHERE id=?').get(id).status
  const logCount = () => db.prepare('SELECT COUNT(*) c FROM oms_sync_logs').get().c

  await t.test('ship/complete/refund on an out-of-scope or missing order: identical 404, nothing changes', async () => {
    for (const verb of ['ship', 'complete', 'refund']) {
      const missing = await api(`/api/oms/orders/99999999/${verb}`, { token: accountA.token, body: {} })
      assert.equal(missing.status, 404, verb)
      const logs0 = logCount()
      for (const id of [oB, oBshipped, oU]) {
        const r = await api(`/api/oms/orders/${id}/${verb}`, { token: accountA.token, body: {} })
        assert.equal(r.status, 404, `${verb} ${id}: ${JSON.stringify(r.body)}`)
        assert.deepEqual(r.body, missing.body, `${verb} ${id} must look like not-found`)
      }
      const none = await api(`/api/oms/orders/${oA}/${verb}`, { token: accountNone.token, body: {} })
      assert.equal(none.status, 404, `${verb} with no org`)
      assert.equal(logCount(), logs0, `${verb} wrote a sync log`)
    }
    assert.equal(status(oB), 'pending')
    assert.equal(status(oBshipped), 'shipped')
    assert.equal(status(oU), 'pending')
    assert.equal(status(oA), 'pending')
  })

  await t.test('linked sales order whose warehouse is out of scope: 403 and no write', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM sales_deliveries').get().c
    for (const verb of ['ship', 'refund']) {
      const id = verb === 'ship' ? oTarget : oTargetRefund
      const r = await api(`/api/oms/orders/${id}/${verb}`, { token: accountA.token, body: {} })
      assert.equal(r.status, 403, `${verb}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error, 'TARGET_OUT_OF_SCOPE')
      assert.equal(status(id), 'pending')
    }
    assert.equal(db.prepare("SELECT status FROM sales_orders WHERE id=?").get(soInB).status, 'confirmed')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_deliveries').get().c, before)
  })

  await t.test('in-scope orders still work; global scope reaches every platform', async () => {
    assert.equal((await api(`/api/oms/orders/${oA}/ship`, { token: accountA.token, body: { express_no: 'AA2X1' } })).status, 200)
    assert.equal(status(oA), 'shipped')
    assert.equal((await api(`/api/oms/orders/${oAcomplete}/complete`, { token: accountA.token, body: {} })).status, 200)
    assert.equal(status(oAcomplete), 'completed')
    assert.equal((await api(`/api/oms/orders/${oArefund}/refund`, { token: accountA.token, body: { reason: 'x' } })).status, 200)
    assert.equal(status(oArefund), 'refunded')
    assert.equal((await api(`/api/oms/orders/${oB}/ship`, { token: accountAll.token, body: {} })).status, 200)
    assert.equal((await api(`/api/oms/orders/${oBshipped}/complete`, { token: f.admin, body: {} })).status, 200)
    assert.equal((await api(`/api/oms/orders/${oU}/ship`, { token: f.admin, body: {} })).status, 200)
  })

  await t.test('stock-push: only in-scope platforms; out-of-scope platform id is 404; totals cover in-scope warehouses only', async () => {
    const pushLogs = (pf) => db.prepare("SELECT COUNT(*) c FROM oms_sync_logs WHERE platform_id=? AND sync_type='stock'").get(pf).c
    const missing = await api('/api/oms/stock-push', { token: accountA.token, body: { platform_id: 99999999 } })
    assert.equal(missing.status, 404)
    for (const pf of [pfB, pfU]) {
      const r = await api('/api/oms/stock-push', { token: accountA.token, body: { platform_id: pf } })
      assert.equal(r.status, 404, `platform ${pf}`)
      assert.deepEqual(r.body, missing.body)
      assert.equal(pushLogs(pf), 0)
    }
    const all = await api('/api/oms/stock-push', { token: accountA.token, body: {} })
    assert.equal(all.status, 200, JSON.stringify(all.body))
    const inScopePlatforms = db.prepare("SELECT p.name FROM platforms p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=? AND p.sync_stock=1 AND p.status='active' ORDER BY p.name").all(whA.org_id).map((x) => x.name)
    assert.deepEqual(all.body.data.pushed.map((x) => x.platform).sort(), inScopePlatforms)
    assert.equal(pushLogs(pfB), 0)
    assert.equal(pushLogs(pfU), 0)
    const want = db.prepare(`SELECT COALESCE(SUM(st.qty_on_hand - st.qty_reserved),0) q FROM inventory_stocks st JOIN product_skus s ON s.id=st.sku_id
      WHERE s.status='active' AND st.warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)`).get(whA.org_id).q
    for (const row of all.body.data.pushed) assert.equal(row.total_available, want)
    const none = await api('/api/oms/stock-push', { token: accountNone.token, body: {} })
    assert.equal(none.status, 400)
    // 全局范围：全部平台，库存合计为全库
    const adminAll = await api('/api/oms/stock-push', { token: f.admin, body: {} })
    assert.equal(adminAll.status, 200)
    const wantAll = db.prepare("SELECT COALESCE(SUM(st.qty_on_hand - st.qty_reserved),0) q FROM inventory_stocks st JOIN product_skus s ON s.id=st.sku_id WHERE s.status='active'").get().q
    assert.ok(adminAll.body.data.pushed.every((x) => x.total_available === wantAll))
    assert.ok(adminAll.body.data.pushed.some((x) => x.platform === 'AA2P-B') && adminAll.body.data.pushed.some((x) => x.platform === 'AA2P-U'))
    assert.ok(parentOrg !== undefined)
  })
})
