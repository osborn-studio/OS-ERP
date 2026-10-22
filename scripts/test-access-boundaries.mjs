/**
 * ============================================================================
 * 文件标识：scripts/test-access-boundaries.mjs | 权限边界回归
 * 【职责】隔离启动服务，验证外部账号不能读取总部数据、缺失归属不能扩大权限。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { stopAndReport } from './lib/reap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.GML_DATA_DIR = mkdtempSync('/tmp/gml-access-boundaries-')
const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
srv.stdout.on('data', b => { output += b })
srv.stderr.on('data', b => { output += b })
let passed = 0
let failed = 0
function verify(name, condition) {
  if (condition) passed++
  else { failed++; console.log(`  FAIL ${name}`) }
}
async function request(url, token, body, method) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  return { status: res.status, body: await res.json() }
}
try {
  for (let i = 0; i < 450 && !output.includes('服务已启动') && srv.exitCode === null; i++) await delay(100)
  assert(output.includes('服务已启动'), output.slice(-2000))
  const { getDbFor } = await import('../server/db/index.js')
  const { scopeFilter, assertCanRead } = await import('../server/middleware/auth.js')
  const oc = await import('../server/lib/order-center.js')
  const { TOOL_MAP } = await import('../server/mcp/tools.js')
  const engine = await import('../server/lib/stock.js')
  const endpoints = [
    '/api/dashboard/summary', '/api/dashboard/todos', '/api/dashboard/recent',
    '/api/oms/orders', '/api/oms/platforms', '/api/dealers/overview',
    '/api/dms/agreements', '/api/dms/rebates', '/api/inventory/stocks', '/api/inventory/transactions',
    '/api/outsourcing/orders', '/api/demand/production/orders',
    '/api/master/products', '/api/master/options', '/api/pricing/groups',
    '/api/docflow/overview', '/api/docflow/events', '/api/approval/overview', '/api/approval/instances',
    '/api/notify/channels'
  ]
  for (const industry of ['cosmetic', 'food']) {
    const db = getDbFor(industry)
    const sample = db.prepare('SELECT * FROM inventory_stocks WHERE owner_org_id IS NOT NULL AND qty_on_hand>0 LIMIT 1').get()
    const otherOrg = db.prepare('SELECT id FROM orgs WHERE id<>? AND id>0 ORDER BY id LIMIT 1').get(sample.owner_org_id)
    assert(sample && otherOrg)
    db.exec('BEGIN')
    try {
      const batchNo = `ACCESS-SCOPE-${industry}`
      for (const [ownerOrgId, qty] of [[sample.owner_org_id, 2], [otherOrg.id, 7]]) {
        engine.applyStockIn(db, { warehouseId: sample.warehouse_id, ownerOrgId, skuId: sample.sku_id,
          batchNo, qty, unitCost: 10, expireAt: '2099-01-01 00:00:00',
          docType: 'ADJ_IN', docNo: `${batchNo}-${ownerOrgId}` })
      }
      const ctx = { orgId: sample.owner_org_id, scope: { scope: 'org', orgIds: [sample.owner_org_id] }, engine }
      const invoke = (name, args = {}) => TOOL_MAP.get(name).handler({ db, args, ctx }).data
      const batches = invoke('inventory.list_batches', { sku_id: sample.sku_id, days: 40000, limit: 500 })
      const ownBatch = batches.list.find(row => row.batch_no === batchNo)
      verify(`${industry} MCP batch scope has own data`, !!ownBatch)
      verify(`${industry} MCP batch quantity excludes other owners`, ownBatch?.qty_on_hand === 2)
      verify(`${industry} MCP batches do not leak other-owner metadata`, batches.list.every(row =>
        !!db.prepare('SELECT id FROM inventory_stocks WHERE sku_id=? AND batch_no=? AND owner_org_id=? LIMIT 1').get(row.sku_id, row.batch_no, sample.owner_org_id)))
      const product = invoke('master.get_product_360', { sku_id: sample.sku_id })
      verify(`${industry} product 360 includes own transactions`, product.recent_transactions.some(row => row.doc_no === `${batchNo}-${sample.owner_org_id}`))
      verify(`${industry} product 360 filters transaction owners`, product.recent_transactions.every(row => row.owner_org_id === sample.owner_org_id))
      for (const kind of ['store', 'dealer']) {
        verify(`${industry} MCP ${kind} partners scoped`, invoke('master.list_partners', { kind, limit: 200 }).list.every(row => row.org_id === sample.owner_org_id))
      }
      const ids = table => new Set(db.prepare(`SELECT id FROM ${table} WHERE org_id=?`).all(sample.owner_org_id).map(row => row.id))
      const warehouses = ids('warehouses'), stores = ids('stores'), dealers = ids('dealers')
      const expectedShip = db.prepare("SELECT * FROM sales_orders WHERE status IN ('confirmed','pending','approved')").all()
        .filter(row => warehouses.has(row.warehouse_id) || stores.has(row.store_id) || dealers.has(row.dealer_id)).length
      const expectedPurchase = db.prepare("SELECT * FROM purchase_orders WHERE status IN ('approved','partial')").all()
        .filter(row => warehouses.has(row.warehouse_id) || stores.has(row.target_store_id)).length
      const kpi = invoke('report.dashboard_kpi')
      verify(`${industry} MCP shipment KPI scoped`, kpi.pending_shipment_orders === expectedShip)
      verify(`${industry} MCP purchase KPI scoped`, kpi.purchase_in_transit === expectedPurchase)
    } finally { db.exec('ROLLBACK') }
    const supplyLogin = await request('/api/auth/login', null, { username: 'scm', password: '123456', industry })
    assert.equal(supplyLogin.status, 200)
    const supplyToken = supplyLogin.body.data.token
    const supplier = db.prepare("SELECT id FROM suppliers WHERE status='active' LIMIT 1").get()
    const warehouse = db.prepare("SELECT id FROM warehouses WHERE type='central' AND status='active' LIMIT 1").get()
    const sku = db.prepare("SELECT s.id FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.status='active' AND p.status='active' AND p.require_qc=0 LIMIT 1").get()
    const po = await request('/api/purchase/orders', supplyToken, {
      supplier_id: supplier.id, warehouse_id: warehouse.id, items: [{ sku_id: sku.id, qty: 2, price: 10 }], remark: '供应链角色回归'
    })
    assert.equal(po.status, 200, JSON.stringify(po.body))
    verify(`${industry} supply role creates purchase order`, po.body.data.id > 0)
    for (const action of ['submit', 'approve']) {
      const out = await request(`/api/purchase/orders/${po.body.data.id}/status`, supplyToken, { action })
      verify(`${industry} supply role ${action} purchase order`, out.status === 200)
    }
    const receipt = await request(`/api/purchase/orders/${po.body.data.id}/receive`, supplyToken, {
      items: [{ sku_id: sku.id, qty: 2, batch_no: `ACCESS-RECEIPT-${industry}` }]
    })
    verify(`${industry} supply role receives purchase order`, receipt.status === 200)
    verify(`${industry} supply receipt really increases stock`, db.prepare('SELECT SUM(qty_on_hand) qty FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
      .get(warehouse.id, sku.id, `ACCESS-RECEIPT-${industry}`).qty === 2)
    const adjusted = await request('/api/inventory/adjust', supplyToken, {
      warehouse_id: warehouse.id, sku_id: sku.id, batch_no: `ACCESS-RECEIPT-${industry}`, qty: 1, direction: 'in', reason: '供应链盘盈测试'
    })
    verify(`${industry} supply role inventory adjustment`, adjusted.status === 200)
    for (const endpoint of ['/api/requisitions/store/board', '/api/demand/production/orders']) {
      verify(`${industry} supply role can read ${endpoint}`, (await request(endpoint, supplyToken)).status === 200)
    }
    verify(`${industry} supply role cannot write sales`, (await request('/api/sales/orders', supplyToken, {})).status === 403)
    verify(`${industry} supply role cannot post vouchers`, (await request('/api/accounting/vouchers/generate', supplyToken, {})).status === 403)
    for (const username of ['admin', 'store01', 'dealer01']) {
      const login = await request('/api/auth/login', null, { username, password: username === 'admin' ? '12345' : '123456', industry })
      assert.equal(login.status, 200)
      const token = login.body.data.token
      for (const endpoint of endpoints) {
        verify(`${industry}/${username} ${endpoint}`, (await request(endpoint, token)).status === (username === 'admin' ? 200 : 403))
      }
      if (username === 'admin') {
        const probeName = `access-admin-${industry}`
        const probePassword = 'Audit-only-test-pass-2026!'
        const created = await request('/api/auth/users', token, { username: probeName, password: probePassword, name: '权限回归账号', role: 'admin' })
        verify(`${industry} admin creation succeeds`, created.status === 200)
        const uid = created.body.data.id
        const logged = await request('/api/auth/login', null, { username: probeName, password: probePassword, industry })
        assert.equal(logged.status, 200)
        const oldToken = logged.body.data.token
        verify(`${industry} new admin token can manage MCP`, (await request('/api/mcp/tokens', oldToken)).status === 200)
        verify(`${industry} role downgrade succeeds`, (await request(`/api/auth/users/${uid}`, token, { role: 'viewer' }, 'PUT')).status === 200)
        verify(`${industry} downgrade clears super flag`, db.prepare('SELECT is_super FROM users WHERE id=?').get(uid).is_super === 0)
        verify(`${industry} downgrade removes primary admin permission link`, !db.prepare("SELECT 1 FROM user_roles WHERE user_id=? AND role_code='admin'").get(uid))
        const revoked = await request('/api/mcp/tokens', oldToken)
        verify(`${industry} old admin session is revoked immediately`, revoked.status === 401 && (revoked.body?.error || revoked.body?.detail?.code) === 'SESSION_REVOKED')
        const forbiddenUser = { username: 'forbidden', password: probePassword, name: 'x' }
        verify(`${industry} old admin session cannot write`, (await request('/api/auth/users', oldToken, forbiddenUser)).status === 401)
        const relogged = await request('/api/auth/login', null, { username: probeName, password: probePassword, industry })
        assert.equal(relogged.status, 200)
        const viewerToken = relogged.body.data.token
        verify(`${industry} downgraded account can read after re-login`, (await request('/api/sales/orders', viewerToken)).status === 200)
        verify(`${industry} re-login cannot restore MCP management`, (await request('/api/mcp/tokens', viewerToken)).status === 403)
        verify(`${industry} re-login cannot restore user creation`, (await request('/api/auth/users', viewerToken, forbiddenUser)).status === 403)
        verify(`${industry} invalid role rejected`, (await request(`/api/auth/users/${uid}`, token, { role: 'not-a-role' }, 'PUT')).status === 400)
        continue
      }
      verify(`${industry}/${username} can read own sales orders`, (await request('/api/sales/orders', token)).status === 200)
      if (username === 'store01') verify(`${industry} store POS still usable`, (await request('/api/pos/context', token)).status === 200)
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username)
      const self = oc.selfCustomerId(db, user)
      const other = db.prepare('SELECT * FROM oc_customers WHERE id<>? ORDER BY id LIMIT 1').get(self)
      const otherOrder = db.prepare('SELECT * FROM oc_orders WHERE customer_id<>? ORDER BY id LIMIT 1').get(self)
      assert(other && otherOrder, 'Seed must contain another customer and order')
      const statement = Number(db.prepare(`INSERT INTO oc_statements (doc_no,customer_id,customer_name,period_start,period_end)
        VALUES (?,?,?,'2026-01-01','2026-01-31')`).run(`ACCESS-${industry}-${username}`, other.id, other.name).lastInsertRowid)
      const ownStatement = Number(db.prepare(`INSERT INTO oc_statements (doc_no,customer_id,period_start,period_end)
        VALUES (?,?,'2026-01-01','2026-01-31')`).run(`OWN-${industry}-${username}`, self).lastInsertRowid)
      for (const endpoint of [
        `/api/order-center/customers/${other.id}`, `/api/order-center/credit/${other.id}`,
        `/api/order-center/customers/tree?root=${other.id}`,
        `/api/order-center/catalog?customer_id=${other.id}`,
        `/api/order-center/orders/${otherOrder.id}`, `/api/order-center/orders/${otherOrder.id}/repeat`,
        `/api/order-center/orders/${otherOrder.id}/actions`, `/api/order-center/statements/${statement}`
      ]) verify(`${industry}/${username} rejects cross-customer ${endpoint}`, (await request(endpoint, token)).status === 403)
      for (const [endpoint, body] of [
        ['/api/order-center/quote', { customer_id: other.id, items: [] }],
        ['/api/order-center/orders', { customer_id: other.id, items: [] }],
        ['/api/order-center/statements', { customer_id: other.id, period_start: '2026-01-01', period_end: '2026-01-31' }],
        [`/api/order-center/statements/${statement}/confirm`, {}],
        [`/api/order-center/statements/${statement}/void`, { reason: 'access regression' }]
      ]) verify(`${industry}/${username} rejects cross-customer write ${endpoint}`, (await request(endpoint, token, body)).status === 403)
      verify(`${industry}/${username} other statement remains draft`, db.prepare('SELECT status FROM oc_statements WHERE id=?').get(statement).status === 'draft')
      verify(`${industry}/${username} own customer detail remains usable`, (await request(`/api/order-center/customers/${self}`, token)).status === 200)
      verify(`${industry}/${username} own catalog remains usable`, (await request('/api/order-center/catalog', token)).status === 200)
      verify(`${industry}/${username} own statement confirmation remains usable`, (await request(`/api/order-center/statements/${ownStatement}/confirm`, token, {})).status === 200)
      const tree = await request('/api/order-center/customers/tree', token)
      verify(`${industry}/${username} tree only exposes self`, tree.status === 200 && tree.body.data.id === self && tree.body.data.children.length === 0)
      const ov = await request('/api/order-center/overview', token)
      verify(`${industry}/${username} overview customer count scoped`, ov.status === 200 && ov.body.data.customers.total === 1)
      verify(`${industry}/${username} overview credit risk scoped`, ov.body.data.creditRisk.every(row => row.id === self))
      verify(`${industry}/${username} empty scope returns no customers`, oc.overview(db, { customerIds: [] }).customers.total === 0)
      const field = user.role === 'dealer' ? 'dealer_id' : 'store_id'
      const otherField = user.role === 'dealer' ? 'store_id' : 'dealer_id'
      const unbound = { user: { role: user.role, [field]: null } }
      const filtered = scopeFilter(unbound, 't')
      verify(`${industry}/${username} empty binding keeps SQL restriction`, filtered.sql.length > 0)
      verify(`${industry}/${username} empty binding rejects detail`, !assertCanRead(unbound, { [field]: user[field] }).ok)
      verify(`${industry}/${username} empty binding rejects NULL-owned detail`, !assertCanRead(unbound, { [field]: null }).ok)
      verify(`${industry}/${username} bound detail allowed`, assertCanRead({ user }, { [field]: user[field] }).ok)
      try {
        db.prepare(`UPDATE users SET ${field}=NULL, ${otherField}=NULL WHERE id=?`).run(user.id)
        verify(`${industry}/${username} removed binding invalidates old session`, (await request('/api/sales/orders', token)).status === 403)
      } finally {
        db.prepare('UPDATE users SET dealer_id=?,store_id=? WHERE id=?').run(user.dealer_id, user.store_id, user.id)
      }
    }
  }
  console.log(`通过 ${passed} / 失败 ${failed}`)
  process.exitCode = failed ? 1 : 0
} finally {
  await stopAndReport(srv)
}
