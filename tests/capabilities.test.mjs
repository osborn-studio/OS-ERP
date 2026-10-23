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
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { runtimeCapabilities, RESTRICTED_CAPABILITIES } from '../server/capabilities.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
async function server(t, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-capabilities-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  if (mode !== undefined) env.GML_RUNTIME_MODE = mode
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  child.stdout.on('data', data => { ready ||= data.toString().includes('服务已启动') })
  child.stderr.on('data', () => {})
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, `server must start in ${mode ?? 'default production'} mode`)
  const request = (route, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000)
  })
  return { request, dir, secret: env.GML_JWT_SECRET }
}

test('availability is default closed; unrelated enable flags cannot override production', () => {
  for (const env of [{}, { GML_RUNTIME_MODE: 'production' }, { GML_RUNTIME_MODE: 'production', ENABLE_MALL: 'true', ENABLE_MCP: 'true' }]) {
    assert.ok(Object.values(runtimeCapabilities(env)).every(x => x.enabled === false))
  }
  for (const mode of ['demo', 'test']) assert.ok(Object.values(runtimeCapabilities({ GML_RUNTIME_MODE: mode })).every(x => x.enabled === true))
  assert.throws(() => runtimeCapabilities({ GML_RUNTIME_MODE: 'prod' }), { code: 'RUNTIME_MODE_INVALID' })
})

test('production HTTP rejects entire restricted surfaces without data side effects', { timeout: 90000 }, async t => {
  const { request, dir } = await server(t)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const countTables = ['mall_customers', 'oms_orders', 'oms_sync_logs', 'agent_tokens', 'mcp_call_logs', 'im_sync_runs']
  const snapshot = () => Object.fromEntries(countTables.map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]))
  const before = snapshot()
  const attempts = [
    ['/api/mall/login', 'POST', { phone: '13800000000', code: '1234' }, 'public_mall'],
    ['/api/mall/home', 'GET', undefined, 'public_mall'],
    ['/api/promo/shop/promotions', 'GET', undefined, 'public_mall'],
    ['/api/promo/shop/member', 'GET', undefined, 'public_mall'],
    ['/api/promo/shop/quote', 'POST', { items: [] }, 'public_mall'],
    ['/api/promo/shop/claim', 'POST', { coupon_id: 1 }, 'public_mall'],
    ['/API/PROMO/SHOP/PROMOTIONS/', 'GET', undefined, 'public_mall'],
    ['/API/MALL/checkout/?enable=true', 'POST', {}, 'public_mall'],
    ['/api/qimen', 'POST', { method: 'taobao.qimen.inventory.query', request: {} }, 'qimen_gateway'],
    ['/api/qimen/capabilities', 'GET', undefined, 'qimen_gateway'],
    ['/api/oms/sync/1', 'POST', { count: 2 }, 'oms_simulation'],
    ['/api/oms/stock-push', 'POST', { platform_id: 1 }, 'oms_simulation'],
    ['/api/oms/orders/1/ship', 'POST', {}, 'oms_simulation'],
    ['/api/oms/orders/1/refund', 'POST', {}, 'oms_simulation'],
    ['/api/oms/qimen-message/1', 'GET', undefined, 'oms_simulation'],
    ['/api/oms/qimen-stock-message/1', 'GET', undefined, 'oms_simulation'],
    ['/api/im/sync/org', 'POST', { platform: 'dingtalk' }, 'im_connector'],
    ['/api/im/sync/approval', 'POST', { platform: 'feishu' }, 'im_connector'],
    ['/api/im/self-test', 'POST', {}, 'im_connector'],
    ['/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize' }, 'agent_access'],
    ['/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'doc.transition', arguments: {} } }, 'agent_access'],
    ['/api/mcp/tokens', 'POST', {}, 'agent_access'],
    ['/api/mcp/catalog', 'GET', undefined, 'agent_access']
  ]
  for (const [route, method, body, capability] of attempts) {
    const response = await request(route, method, body)
    assert.equal(response.status, 503, route)
    const result = await response.json()
    assert.equal(result.success, false)
    assert.equal(result.error, 'FEATURE_DISABLED')
    assert.equal(result.detail.code, 'FEATURE_DISABLED')
    assert.equal(result.detail.capability, capability)
    assert.equal(result.data, undefined)
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal((await request('/api/mall/login', method)).status, 503)
  }
  assert.deepEqual(snapshot(), before)
  const api = await request('/api')
  assert.equal(api.status, 200)
  assert.ok(Object.values((await api.json()).data.capabilities).every(x => x.enabled === false))
  assert.equal((await request('/api/meta/health')).status, 200)
  assert.equal((await request('/api/purchase/orders')).status, 401)
  assert.equal((await request('/api/mallish')).status, 404)
})

test('authenticated admin cannot cause fake platform success; mall tokens cannot bypass disabled shop routes', { timeout: 90000 }, async t => {
  const { request, dir, secret } = await server(t)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  try {
    // Hand-built fixtures only: production seed commands must never be used here.
    const password = randomBytes(24).toString('hex')
    db.prepare("INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,'admin',1)")
      .run('capability_admin', bcrypt.hashSync(password, 10), 'Capability test administrator')
    const platform = db.prepare("INSERT INTO platforms (code,name,sync_stock,status,last_sync_at) VALUES ('CAP_TEST','Capability test platform',1,'active','2000-01-01 00:00:00')").run().lastInsertRowid
    const order = db.prepare("INSERT INTO oms_orders (platform_id,platform_order_no,status) VALUES (?,'CAP_TEST_ORDER','pending')").run(platform).lastInsertRowid
    const login = await request('/api/auth/login', 'POST', { username: 'capability_admin', password, industry: 'cosmetic' })
    assert.equal(login.status, 200)
    const credentials = await login.json()
    const headers = { authorization: `Bearer ${credentials.data.token}` }
    // Prove valid credentials, not an authentication failure masking the business result.
    assert.equal((await request('/api/oms/platforms', 'GET', undefined, headers)).status, 200)
    for (const route of ['/api/promo/promotions', '/api/promo/coupons', '/api/promo/members']) {
      assert.equal((await request(route, 'GET', undefined, headers)).status, 200, `core marketing remains available: ${route}`)
    }
    const mallToken = jwt.sign({ cid: 999, phone: '13800000000', role: 'mall', industry: 'cosmetic' }, secret, { audience: 'gml-mall', expiresIn: '1h' })
    const promoSnapshot = () => Object.fromEntries(['coupon_instances', 'promotion_usages', 'member_points_ledger', 'member_balance_ledger', 'mall_customers'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const beforePromo = promoSnapshot()
    for (const [route, method, body] of [
      ['/api/promo/shop/promotions', 'GET'], ['/api/promo/shop/member', 'GET'],
      ['/API/PROMO/SHOP/MEMBER/', 'GET'], ['/api/promo/shop/quote', 'POST', { items: [] }],
      ['/api/promo/shop/claim', 'POST', { coupon_id: 1 }], ['/API/PROMO/SHOP/CLAIM/', 'POST', { coupon_id: 1 }]
    ]) {
      const response = await request(route, method, body, { 'x-mall-token': mallToken })
      assert.equal(response.status, 503, route)
      assert.equal((await response.json()).detail.capability, 'public_mall')
      assert.deepEqual(promoSnapshot(), beforePromo, route)
    }
    const snapshot = () => ({
      platform: db.prepare('SELECT * FROM platforms WHERE id=?').get(platform),
      order: db.prepare('SELECT * FROM oms_orders WHERE id=?').get(order),
      logs: db.prepare('SELECT count(*) AS n FROM oms_sync_logs').get().n,
      audit: db.prepare('SELECT count(*) AS n FROM audit_logs').get().n,
      stock: db.prepare('SELECT count(*) AS n FROM inventory_transactions').get().n
    })
    const before = snapshot()
    for (const [route, body] of [
      ['/api/oms/stock-push', { platform_id: platform }],
      ['/api/oms/stock-push', {}],
      [`/api/oms/orders/${order}/ship`, {}],
      [`/API/OMS/ORDERS/${order}/SHIP/`, { express_no: 'TEST-ONLY', express_company: 'TEST' }],
      [`/api/oms/orders/${order}/refund`, { reason: 'test refusal' }]
    ]) {
      const response = await request(route, 'POST', body, headers)
      assert.equal(response.status, 503, route)
      const result = await response.json()
      assert.equal(result.error, 'FEATURE_DISABLED')
      assert.equal(result.detail.capability, 'oms_simulation')
      assert.deepEqual(snapshot(), before, route)
    }
  } finally {
    db.close()
  }
})

for (const mode of ['demo', 'test']) {
  test(`${mode} keeps explicit demo routes and MCP handshake available`, { timeout: 90000 }, async t => {
    const { request } = await server(t, mode)
    const login = await request('/api/mall/login', 'POST', { phone: '13800000000', code: '1234' })
    assert.equal(login.status, 200)
    const mallLogin = await login.json()
    assert.equal(mallLogin.success, true)
    const mallHeaders = { 'x-mall-token': mallLogin.data.token }
    assert.equal((await request('/api/promo/shop/promotions')).status, 200)
    assert.equal((await request('/api/promo/shop/member', 'GET', undefined, mallHeaders)).status, 200)
    for (const [route, body] of [['/api/promo/shop/quote', { items: [] }], ['/api/promo/shop/claim', { coupon_id: -1 }]]) {
      const response = await request(route, 'POST', body, mallHeaders)
      assert.ok([200, 400, 404, 409, 422].includes(response.status), `${mode}: ${route} domain response ${response.status}`)
      assert.notEqual((await response.json()).error, 'FEATURE_DISABLED')
    }
    // 网关在非生产模式可用（不是 503 FEATURE_DISABLED），且自鉴权：缺 app_key / 签名 ⇒ 401（ADR-0028）
    const qimen = await request('/api/qimen', 'POST', {})
    assert.equal(qimen.status, 401)
    const qimenBody = await qimen.json()
    assert.notEqual(qimenBody.error, 'FEATURE_DISABLED')
    assert.equal(qimenBody.success, false)
    const mcp = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize' })
    assert.equal(mcp.status, 200)
    assert.ok((await mcp.json()).result.serverInfo)
    const api = await request('/api')
    const capabilities = (await api.json()).data.capabilities
    for (const { id } of RESTRICTED_CAPABILITIES) assert.equal(capabilities[id].enabled, true)
  })
}
