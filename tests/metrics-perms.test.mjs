/**
 * ============================================================================
 * 文件标识：tests/metrics-perms.test.mjs ｜ 测试：指标按业务查看权限与受限角色口径过滤（ADR-0057 / AE1）
 * ============================================================================
 * 【职责】守住 ADR-0057：
 *     · 字典里每条指标都登记 `perms`（该指标揭示的业务查看权限，任一命中即可）；
 *     · `/api/metrics`、`/values`、`/catalog` 只返回调用者持有对应权限的指标（缺权限 = 指标缺席，不是 403），
 *       仍需 `system:metrics:view` 才能到达端点；响应带 `hidden_count`；
 *     · 危险设置键 `metrics_global_for_restricted`：`hide`（默认）受限范围调用者不返回无范围语义的指标；`label` 还原 ADR-0053 行为。
 * 【夹具口径】test 运行时、临时数据目录、随机回环端口。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { METRICS, METRIC_BY_KEY, metricScopedFlags, isScopeAware } from '../server/lib/metrics.js'
import { classifyMetrics } from '../scripts/check-metrics-scope.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-metrics-perms-'))
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
const ALL = METRICS.map((m) => m.key).join(',')
const SCOPE_AWARE = METRICS.filter((m) => m.scopeAware).map((m) => m.key)
const GLOBAL_ONLY = METRICS.filter((m) => !m.scopeAware).map((m) => m.key)

test('AE1: every metric registers a non-empty perms list of known permission codes', async (t) => {
  const f = await server(t)
  const known = new Set(f.db.prepare('SELECT code FROM permissions').all().map((r) => r.code))
  for (const m of METRICS) {
    assert.ok(Array.isArray(m.perms) && m.perms.length > 0, `${m.key} must declare perms`)
    for (const p of m.perms) assert.ok(known.has(p), `${m.key}: unknown permission ${p}`)
  }
})

test('AE1: metrics are filtered by business view permission (absent, not 403)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  const revoke = (role, ...perms) => perms.forEach((p) => db.prepare('DELETE FROM role_permissions WHERE role_code=? AND perm_code=?').run(role, p))
  // finance: 全局范围（data_scope=all 由角色默认或用户级设定）；显式给足 metrics 查看权限后撤掉销售 / 采购 / 库存成本
  grant.run('finance', 'system:metrics:view')
  const F = await f.account('ae1_fin', 'finance', { data_scope: 'all' })
  const g0 = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: F.token }))
  assert.equal(g0.hidden_count >= 0, true)

  await t.test('missing sales/procurement permissions hide exactly those metrics on values / catalog / dictionary', async () => {
    const salesPerms = ['sales.order.view', 'finance.receivable.view']
    const poPerms = ['purchase.order.view', 'purchase.inbound', 'purchase.return']
    revoke('finance', ...salesPerms, ...poPerms)
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: F.token }))
    for (const k of ['sales_amount', 'sales_qty', 'sales_order_count', 'avg_order_value', 'attach_rate', 'return_rate', 'unpaid', 'purchase_amount', 'purchase_amount_effective', 'closed_order_ratio']) {
      assert.ok(!(k in v.values), `${k} must be absent`)
      assert.ok(!(k in v.scoped), `${k} must be absent from scoped`)
      assert.ok(!v.unknown.includes(k), `${k} is known, not unknown`)
    }
    assert.ok('stock_qty' in v.values, 'unrelated metrics stay')
    assert.equal(v.hidden_count, 10 + (g0.hidden_count))
    const cat = okData(await api('/api/metrics/catalog', { token: F.token }))
    assert.ok(!cat.items.some((x) => x.key === 'sales_amount'))
    assert.equal(cat.hidden_count, v.hidden_count)
    const dict = okData(await api('/api/metrics?days=30', { token: F.token }))
    const keys = dict.groups.flatMap((g) => g.items.map((x) => x.key))
    assert.ok(!keys.includes('purchase_amount') && keys.includes('stock_qty'))
    assert.equal(dict.total, keys.length)
    assert.equal(dict.hidden_count, v.hidden_count)
    assert.deepEqual([...new Set(dict.groups.map((g) => g.module))].sort(), [...dict.modules].sort())
  })

  await t.test('any one permission of the list is enough (purchase.inbound alone reveals purchase metrics)', async () => {
    grant.run('finance', 'purchase.inbound')
    const v = okData(await api('/api/metrics/values?keys=purchase_amount,sales_amount', { token: F.token }))
    assert.ok('purchase_amount' in v.values)
    assert.ok(!('sales_amount' in v.values))
    assert.equal(v.hidden_count, 1)
  })

  await t.test('system:metrics:view is still required to reach the endpoints (403)', async () => {
    revoke('finance', 'system:metrics:view')
    for (const p of ['/api/metrics', '/api/metrics/values', '/api/metrics/catalog']) {
      const r = await api(p, { token: (await f.login(F.username, F.password)) })
      assert.equal(r.status, 403, p)
    }
  })

  await t.test('admin (global) sees every metric, hidden_count 0', async () => {
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: f.admin }))
    assert.equal(Object.keys(v.values).length, METRICS.length)
    assert.equal(v.hidden_count, 0)
    assert.equal(okData(await api('/api/metrics/catalog', { token: f.admin })).items.length, METRICS.length)
    assert.equal(okData(await api('/api/metrics', { token: f.admin })).hidden_count, 0)
  })
})

test('AE1: metrics_global_for_restricted hides scope-less metrics from restricted callers by default; label restores ADR-0053 behaviour', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  // 给受限角色（仓管）足够的业务权限，使可见性只取决于范围口径
  const every = new Set(METRICS.flatMap((m) => m.perms))
  for (const p of every) grant.run('warehouse', p)
  grant.run('warehouse', 'system:metrics:view')
  const A = await f.account('ae1_wh', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const setMode = async (value) => okData(await api('/api/meta/settings', { token: f.admin, body: { key: 'metrics_global_for_restricted', value, reason: 'ae1 test' }, method: 'PUT' }))

  await t.test('setting is registered: danger, enum hide|label, default hide', async () => {
    const list = okData(await api('/api/meta/settings', { token: f.admin }))
    const item = list.items.find((x) => x.key === 'metrics_global_for_restricted')
    assert.ok(item, 'registered')
    assert.equal(item.is_danger, true)
    assert.equal(item.value, 'hide')
    assert.deepEqual(item.enum.map((e) => e.value), ['hide', 'label'])
    const bad = await api('/api/meta/settings', { token: f.admin, method: 'PUT', body: { key: 'metrics_global_for_restricted', value: 'show', reason: 'x' } })
    assert.equal(bad.status, 400)
  })

  await t.test('default hide: restricted caller gets scope-aware metrics only, hidden_count counts the rest', async () => {
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: A.token }))
    assert.deepEqual(Object.keys(v.values).sort(), [...SCOPE_AWARE].sort())
    assert.ok(Object.values(v.scoped).every((x) => x === true))
    assert.equal(v.hidden_count, GLOBAL_ONLY.length)
    // AF2：销售 / OMS / 订货中心 / POS 不再被 hide 摘掉
    for (const k of ['sales_amount', 'gmv', 'oc_order_amount', 'pos_sales']) assert.ok(k in v.values, `${k} is scope-aware now`)
    for (const k of ['approval_pending', 'credit_usage', 'over_credit_dealers']) assert.ok(!(k in v.values), `${k} stays hidden`)
    assert.ok('payable_open' in v.values, 'AG2: payable_open is scope-aware now')
    const cat = okData(await api('/api/metrics/catalog', { token: A.token }))
    assert.deepEqual(cat.items.map((x) => x.key).sort(), [...SCOPE_AWARE].sort())
    assert.equal(cat.hidden_count, GLOBAL_ONLY.length)
    const dict = okData(await api('/api/metrics', { token: A.token }))
    assert.equal(dict.total, SCOPE_AWARE.length)
    assert.equal(dict.hidden_count, GLOBAL_ONLY.length)
  })

  await t.test('label: scope-less metrics return with scoped:false (ADR-0053 behaviour)', async () => {
    await setMode('label')
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: A.token }))
    assert.equal(Object.keys(v.values).length, METRICS.length)
    for (const k of GLOBAL_ONLY) assert.equal(v.scoped[k], false, k)
    assert.equal(v.hidden_count, 0)
    assert.equal(okData(await api('/api/metrics/catalog', { token: A.token })).items.length, METRICS.length)
  })

  await t.test('back to hide; global caller is unaffected by either mode', async () => {
    await setMode('hide')
    assert.equal(Object.keys(okData(await api(`/api/metrics/values?keys=${ALL}`, { token: A.token })).values).length, SCOPE_AWARE.length)
    const g = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: f.admin }))
    assert.equal(Object.keys(g.values).length, METRICS.length)
    assert.equal(g.hidden_count, 0)
  })

  await t.test('empty scope (no org) is restricted too: only scope-aware metrics, all zero', async () => {
    const N = await f.account('ae1_none', 'warehouse', { data_scope: 'org' })
    db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(N.id)
    const tok = await f.login(N.username, N.password)
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: tok }))
    assert.deepEqual(Object.keys(v.values).sort(), [...SCOPE_AWARE].sort())
    assert.ok(Object.values(v.values).every((x) => x === 0))
  })

  await t.test('subject-bound accounts (store / dealer binding) are restricted even with data_scope=all (Codex AE1 high)', async () => {
    const store = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get()
    const B = await f.account('ae1_bound_store', 'warehouse', { data_scope: 'all' })
    db.prepare('UPDATE users SET data_scope=?, store_id=? WHERE id=?').run('all', store.id, B.id)
    const tok = await f.login(B.username, B.password)
    const v = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: tok }))
    // AF2：绑定主体账号对销售 / OMS / 订货中心 / 存货 / 采购订单指标 fail-closed（不是内部组织口径）；门店绑定账号另得本店 POS
    // Codex AF2 高项：存货 / 采购订单类也对绑定主体失败关闭（此前 data_scope=all 的绑定账号拿全局库存 / 采购数）
    const legacyAware = SCOPE_AWARE.filter((k) => !METRIC_BY_KEY[k].bound)
    assert.deepEqual(legacyAware, [], 'every scope-aware metric declares how bound subjects are handled')
    for (const k of ['stock_qty', 'stock_amount', 'purchase_amount']) assert.ok(!(k in v.values), `${k} must not reach a bound subject`)
    assert.deepEqual(Object.keys(v.values).sort(), [...legacyAware, 'pos_sales'].sort())
    assert.equal(v.hidden_count, METRICS.length - legacyAware.length - 1)
    const D = await f.account('ae1_bound_dealer', 'warehouse', { data_scope: 'all' })
    const dealer = db.prepare('SELECT id FROM dealers ORDER BY id LIMIT 1').get()
    db.prepare('UPDATE users SET data_scope=?, dealer_id=? WHERE id=?').run('all', dealer.id, D.id)
    const dv = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: await f.login(D.username, D.password) }))
    assert.deepEqual(Object.keys(dv.values).sort(), [...legacyAware].sort())
    // 同一个无绑定的 data_scope=all 账号不受影响
    const U = await f.account('ae1_unbound', 'warehouse', { data_scope: 'all' })
    const uv = okData(await api(`/api/metrics/values?keys=${ALL}`, { token: await f.login(U.username, U.password) }))
    assert.equal(Object.keys(uv.values).length, METRICS.length)
  })
})

// ---------------------------------------------------------------------------
// AF2（ADR-0057 补充）：销售 / OMS / 订货中心 / POS 指标按范围计算
// ---------------------------------------------------------------------------
const AF2_GROUPS = {
  sales: ['sales_amount', 'sales_qty', 'sales_order_count', 'avg_order_value', 'attach_rate', 'return_rate', 'unpaid'],
  oms: ['gmv', 'oms_order_count'],
  oc: ['oc_order_amount', 'oc_fill_rate'],
  pos: ['pos_sales']
}
const AF2_SCOPELESS = ['approval_pending', 'credit_usage', 'over_credit_dealers'] // AG2: payable_open moved to scope-aware

test('AF2: sales / OMS / order-centre / POS metrics are scope-aware; credit / payable / approval stay scope-less', () => {
  for (const k of Object.values(AF2_GROUPS).flat()) assert.equal(METRIC_BY_KEY[k].scopeAware, true, k)
  for (const k of AF2_SCOPELESS) assert.notEqual(METRIC_BY_KEY[k].scopeAware, true, k)
  for (const k of [...AF2_GROUPS.sales, ...AF2_GROUPS.oms]) assert.equal(METRIC_BY_KEY[k].bound, 'deny', k)
  for (const k of AF2_GROUPS.oc) assert.equal(METRIC_BY_KEY[k].bound, 'self-customer', k)
  assert.equal(METRIC_BY_KEY.pos_sales.bound, 'own-store')
})

test('AF2: restricted callers get values computed over their scope (sales / OMS / order centre / POS), hide no longer removes them', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const stores = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 3').all()
  assert.ok(stores.length >= 2)
  const [stA, stB] = stores
  db.prepare('UPDATE stores SET org_id=? WHERE id=?').run(whA.org_id, stA.id)
  db.prepare('UPDATE stores SET org_id=? WHERE id=?').run(whB.org_id, stB.id)
  const today = "date('now','localtime')"
  // 为了让"范围内 = 我们插入的行 + 种子里同组织的行"可由独立 SQL 算出，下面的期望值全部直接对库求和
  const so = db.prepare(`INSERT INTO sales_orders (doc_no, channel, order_date, status, total_qty, receivable_amount, paid_amount, warehouse_id) VALUES (?, 'dealer', ${today}, ?, ?, ?, ?, ?)`)
  so.run('AF2-S-A', 'confirmed', 2, 100, 30, whA.id)
  so.run('AF2-S-A2', 'draft', 9, 9999, 0, whA.id)
  so.run('AF2-S-B', 'confirmed', 5, 1000, 100, whB.id)
  const soA = db.prepare("SELECT id FROM sales_orders WHERE doc_no='AF2-S-A'").get().id
  const soB = db.prepare("SELECT id FROM sales_orders WHERE doc_no='AF2-S-B'").get().id
  const sr = db.prepare(`INSERT INTO sales_returns (doc_no, order_id, warehouse_id, return_date, status, total_amount) VALUES (?,?,?,${today},'confirmed',?)`)
  sr.run('AF2-R-A', soA, whA.id, 10)
  sr.run('AF2-R-B', soB, whB.id, 200)
  const pf = db.prepare("INSERT INTO platforms (code, name, warehouse_id, status) VALUES (?,?,?, 'active')")
  const pfA = Number(pf.run('AF2-PF-A', 'af2 platform a', whA.id).lastInsertRowid)
  const pfB = Number(pf.run('AF2-PF-B', 'af2 platform b', whB.id).lastInsertRowid)
  const pfN = Number(pf.run('AF2-PF-N', 'af2 platform none', null).lastInsertRowid)
  const om = db.prepare("INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?,?,datetime('now','localtime'),?,?)")
  om.run(pfA, 'AF2-O-A', 'pending', 50)
  om.run(pfB, 'AF2-O-B', 'pending', 500)
  om.run(pfN, 'AF2-O-N', 'pending', 5000)
  const po = db.prepare(`INSERT INTO pos_orders (doc_no, store_id, warehouse_id, biz_date, pay_amount, status) VALUES (?,?,?,${today},?, 'local')`)
  po.run('AF2-P-A', stA.id, whA.id, 7)
  po.run('AF2-P-B', stB.id, whB.id, 70)
  const cust = db.prepare("INSERT INTO oc_customers (code, name, source_type, source_id, org_id, admit_status) VALUES (?,?,?,?,?, 'active')")
  // 种子里可能已有这两家门店的订货档案：有就改归属组织，没有就新建（唯一键 source_type+source_id）
  const custFor = (code, st, orgId) => {
    const ex = db.prepare("SELECT id FROM oc_customers WHERE source_type='store' AND source_id=?").get(st.id)
    if (ex) { db.prepare('UPDATE oc_customers SET org_id=? WHERE id=?').run(orgId, ex.id); return ex.id }
    return Number(cust.run(code, `af2 ${code}`, 'store', st.id, orgId).lastInsertRowid)
  }
  const cA = custFor('AF2-C-A', stA, whA.org_id)
  const cB = custFor('AF2-C-B', stB, whB.org_id)
  const oc = db.prepare(`INSERT INTO oc_orders (doc_no, customer_id, order_date, status, total_amount) VALUES (?,?,${today},?,?)`)
  oc.run('AF2-OC-A1', cA, 'completed', 11)
  oc.run('AF2-OC-A2', cA, 'submitted', 13)
  oc.run('AF2-OC-B1', cB, 'completed', 1100)

  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of new Set(METRICS.flatMap((m) => m.perms))) { grant.run('warehouse', p); grant.run('store', p) }
  grant.run('warehouse', 'system:metrics:view'); grant.run('store', 'system:metrics:view')
  const A = await f.account('af2_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const vals = async (token) => okData(await api(`/api/metrics/values?keys=${ALL}`, { token }))
  const one = (sql, ...a) => db.prepare(sql).get(...a).v
  const r2 = (n) => Math.round(n * 100) / 100
  const wA = `(SELECT id FROM warehouses WHERE org_id=${whA.org_id})`
  const g = await vals(f.admin)
  const a = await vals(A.token)

  await t.test('sales group equals the in-scope SQL (warehouse/store party rule) and differs from global', () => {
    const inS = `status NOT IN ('draft','cancelled') AND (warehouse_id IN ${wA} OR store_id IN (SELECT id FROM stores WHERE org_id=${whA.org_id}))`
    const amount = one(`SELECT COALESCE(SUM(receivable_amount),0) v FROM sales_orders WHERE ${inS}`)
    const qty = one(`SELECT COALESCE(SUM(total_qty),0) v FROM sales_orders WHERE ${inS}`)
    const n = one(`SELECT COUNT(*) v FROM sales_orders WHERE ${inS}`)
    const unpaid = one(`SELECT COALESCE(SUM(receivable_amount-paid_amount),0) v FROM sales_orders WHERE ${inS}`)
    const ret = one(`SELECT COALESCE(SUM(r.total_amount),0) v FROM sales_returns r WHERE r.status<>'cancelled' AND EXISTS (SELECT 1 FROM sales_orders s WHERE s.id=r.order_id AND (s.warehouse_id IN ${wA} OR s.store_id IN (SELECT id FROM stores WHERE org_id=${whA.org_id})))`)
    assert.equal(a.values.sales_amount, r2(amount))
    assert.equal(a.values.sales_qty, qty)
    assert.equal(a.values.sales_order_count, n)
    assert.equal(a.values.unpaid, r2(unpaid))
    assert.equal(a.values.avg_order_value, n > 0 ? r2(amount / n) : 0)
    assert.equal(a.values.attach_rate, n > 0 ? r2(qty / n) : 0)
    assert.equal(a.values.return_rate, amount > 0 ? r2((ret / amount) * 100) : 0)
    assert.ok(a.values.sales_amount >= 100 && a.values.sales_amount < g.values.sales_amount)
    assert.ok(g.values.sales_amount >= 1100, 'global includes org B')
    for (const k of AF2_GROUPS.sales) assert.equal(a.scoped[k], true, k)
  })

  await t.test('OMS group equals the platform-fulfilment-warehouse scope; platform without warehouse is invisible', () => {
    const inP = `platform_id IN (SELECT id FROM platforms WHERE warehouse_id IN ${wA})`
    assert.equal(a.values.gmv, r2(one(`SELECT COALESCE(SUM(pay_amount),0) v FROM oms_orders WHERE status<>'refunded' AND ${inP}`)))
    assert.equal(a.values.oms_order_count, one(`SELECT COUNT(*) v FROM oms_orders WHERE status<>'refunded' AND ${inP}`))
    assert.ok(a.values.gmv >= 50 && a.values.gmv < g.values.gmv)
    assert.ok(g.values.gmv >= 5550)
    assert.ok(a.values.gmv < 5000, 'the warehouse-less platform (5000) never leaks')
  })

  await t.test('order-centre group follows ocScope (customer-owning organisation)', () => {
    const inC = `customer_id IN (SELECT id FROM oc_customers WHERE COALESCE(org_id,(SELECT p.org_id FROM oc_customers p WHERE p.id=oc_customers.parent_customer_id))=${whA.org_id})`
    assert.equal(a.values.oc_order_amount, r2(one(`SELECT COALESCE(SUM(total_amount),0) v FROM oc_orders WHERE status<>'cancelled' AND ${inC}`)))
    const all = one(`SELECT COUNT(*) v FROM oc_orders WHERE status<>'cancelled' AND ${inC}`)
    const done = one(`SELECT COUNT(*) v FROM oc_orders WHERE status='completed' AND ${inC}`)
    assert.equal(a.values.oc_fill_rate, all > 0 ? r2((done / all) * 100) : 0)
    assert.ok(a.values.oc_order_amount >= 24 && a.values.oc_order_amount < g.values.oc_order_amount)
  })

  await t.test('POS (unbound, org-restricted) = stores of the caller organisation', () => {
    assert.equal(a.values.pos_sales, r2(one(`SELECT COALESCE(SUM(pay_amount),0) v FROM pos_orders WHERE store_id IN (SELECT id FROM stores WHERE org_id=${whA.org_id})`)))
    assert.ok(a.values.pos_sales >= 7 && a.values.pos_sales < g.values.pos_sales)
  })

  await t.test('hide mode keeps them; label mode gives the same numbers; credit / payable / approval stay scope-less', async () => {
    for (const k of Object.values(AF2_GROUPS).flat()) assert.ok(k in a.values, `${k} present under hide`)
    for (const k of AF2_SCOPELESS) assert.ok(!(k in a.values), `${k} hidden under hide`)
    const set = (value) => api('/api/meta/settings', { token: f.admin, method: 'PUT', body: { key: 'metrics_global_for_restricted', value, reason: 'af2 test' } })
    okData(await set('label'))
    const l = await vals(A.token)
    for (const k of Object.values(AF2_GROUPS).flat()) assert.equal(l.values[k], a.values[k], `${k} label == hide`)
    for (const k of AF2_SCOPELESS) assert.equal(l.scoped[k], false, k)
    okData(await set('hide'))
  })

  await t.test('empty scope fails closed to 0 (never the global number)', async () => {
    const N = await f.account('af2_none', 'warehouse', { data_scope: 'org' })
    db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(N.id)
    const n = await vals(await f.login(N.username, N.password))
    for (const k of Object.values(AF2_GROUPS).flat()) assert.equal(n.values[k], 0, k)
  })

  await t.test('global caller (admin, unbound data_scope=all) is unchanged', async () => {
    assert.equal(g.values.sales_amount, r2(one("SELECT COALESCE(SUM(receivable_amount),0) v FROM sales_orders WHERE status NOT IN ('draft','cancelled')")))
    assert.equal(g.values.gmv, r2(one("SELECT COALESCE(SUM(pay_amount),0) v FROM oms_orders WHERE status<>'refunded'")))
    assert.equal(g.values.oc_order_amount, r2(one("SELECT COALESCE(SUM(total_amount),0) v FROM oc_orders WHERE status<>'cancelled'")))
    assert.equal(g.values.pos_sales, r2(one('SELECT COALESCE(SUM(pay_amount),0) v FROM pos_orders')))
    const U = await f.account('af2_unbound', 'warehouse', { data_scope: 'all' })
    const u = await vals(await f.login(U.username, U.password))
    assert.equal(u.values.sales_amount, g.values.sales_amount)
    assert.equal(u.values.pos_sales, g.values.pos_sales)
  })

  await t.test('subject-bound accounts never get global numbers under data_scope=all (store = own store + own customer only)', async () => {
    const S = await f.account('af2_store', 'warehouse', { data_scope: 'all' })
    db.prepare("UPDATE users SET role='store', data_scope='all', store_id=?, org_id=NULL WHERE id=?").run(stA.id, S.id)
    const s = await vals(await f.login(S.username, S.password))
    for (const k of [...AF2_GROUPS.sales, ...AF2_GROUPS.oms]) assert.ok(!(k in s.values), `${k} denied for bound subject`)
    assert.equal(s.values.pos_sales, r2(one('SELECT COALESCE(SUM(pay_amount),0) v FROM pos_orders WHERE store_id=?', stA.id)), 'own store only')
    assert.equal(s.values.oc_order_amount, r2(one("SELECT COALESCE(SUM(total_amount),0) v FROM oc_orders WHERE status<>'cancelled' AND customer_id=?", cA)))
    assert.ok(s.values.pos_sales < g.values.pos_sales)
    // 绑了门店但不是外部订货主体（role!=store|dealer）：订货中心 fail-closed（隐藏）
    const W = await f.account('af2_wh_store', 'warehouse', { data_scope: 'all' })
    db.prepare('UPDATE users SET data_scope=?, store_id=? WHERE id=?').run('all', stA.id, W.id)
    const w = await vals(await f.login(W.username, W.password))
    assert.ok(!('oc_order_amount' in w.values) && 'pos_sales' in w.values)
  })

  await t.test('order-centre read path never creates a customer profile; a bound subject without one reads 0', async () => {
    const free = db.prepare("SELECT id FROM stores WHERE id NOT IN (SELECT source_id FROM oc_customers WHERE source_type='store') ORDER BY id LIMIT 1").get()
    // 种子里每家门店都可能已有档案：删掉一家的订货档案以构造"有门店绑定、无订货档案"（该门店此前没有订货单）
    const target = free || db.prepare("SELECT s.id FROM stores s JOIN oc_customers c ON c.source_type='store' AND c.source_id=s.id WHERE NOT EXISTS (SELECT 1 FROM oc_orders o WHERE o.customer_id=c.id) AND s.id NOT IN (?,?) ORDER BY s.id LIMIT 1").get(stA.id, stB.id)
    assert.ok(target, 'fixture: a store without order-centre profile / orders')
    db.prepare("DELETE FROM oc_addresses WHERE customer_id IN (SELECT id FROM oc_customers WHERE source_type='store' AND source_id=?)").run(target.id)
    db.prepare("DELETE FROM oc_customers WHERE source_type='store' AND source_id=?").run(target.id)
    const X = await f.account('af2_store_noprofile', 'warehouse', { data_scope: 'all' })
    db.prepare("UPDATE users SET role='store', data_scope='all', store_id=?, org_id=NULL WHERE id=?").run(target.id, X.id)
    const before = one('SELECT COUNT(*) v FROM oc_customers')
    const x = await vals(await f.login(X.username, X.password))
    assert.equal(x.values.oc_order_amount, 0)
    assert.equal(x.values.oc_fill_rate, 0)
    assert.equal(one('SELECT COUNT(*) v FROM oc_customers'), before, 'a metrics read must not provision a customer')
  })
})

// ---------------------------------------------------------------------------
// AG2（ADR-0057 补充 2）：范围声明覆盖率守卫 + 应付未结按范围计算
// ---------------------------------------------------------------------------
test('AG2: every metric declares scopeAware:true xor scopeless:<reason>; remaining scope-less ones carry a written reason', () => {
  assert.deepEqual(classifyMetrics(METRICS).problems, [])
  const scopeless = METRICS.filter((m) => !isScopeAware(m)).map((m) => m.key).sort()
  assert.deepEqual(scopeless, ['approval_pending', 'credit_usage', 'over_credit_dealers'])
  for (const k of scopeless) assert.ok(String(METRIC_BY_KEY[k].scopeless).length >= 20, k)
  assert.equal(METRIC_BY_KEY.payable_open.scopeAware, true)
  assert.equal(METRIC_BY_KEY.payable_open.bound, 'deny')
  assert.equal(METRIC_BY_KEY.payable_open.scopeless, undefined)
})

test('AG2: classifyMetrics rejects undeclared, short-reason, double-declared and non-true scopeAware', () => {
  const base = { key: 'x', perms: ['a'] }
  const bad = (m) => classifyMetrics([{ ...base, ...m }]).problems.map((x) => x.key)
  assert.deepEqual(bad({}), ['x'], 'undeclared')
  assert.deepEqual(bad({ scopeless: 'too short' }), ['x'], 'reason < 20 chars')
  assert.deepEqual(bad({ scopeless: '   ' + 'x'.repeat(10) }), ['x'], 'trimmed length counts')
  assert.deepEqual(bad({ scopeAware: true, scopeless: 'a long enough written reason' }), ['x'], 'both')
  assert.deepEqual(bad({ scopeAware: 'yes' }), ['x'], 'truthy is not true')
  assert.deepEqual(bad({ scopeAware: false }), ['x'], 'false is not a declaration')
  assert.deepEqual(bad({ scopeAware: true }), [])
  assert.deepEqual(bad({ scopeless: 'a long enough written reason' }), [])
})

test('AG2: the guard script exits 0, --list agrees with the runtime visibility flag', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/check-metrics-scope.mjs', ...args], { cwd: ROOT, encoding: 'utf8' })
  const ok = run()
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const list = run('--list')
  assert.equal(list.status, 0)
  const flags = metricScopedFlags({ scope: 'org', orgIds: [1] })
  const rows = Object.fromEntries(list.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => METRIC_BY_KEY[c[0]]).map((c) => [c[0], c[1]]))
  assert.equal(Object.keys(rows).length, METRICS.length, 'every metric listed')
  for (const m of METRICS) assert.equal(rows[m.key], flags[m.key] ? 'scopeAware' : 'scopeless', `${m.key} guard == runtime`)
})

test('AG2: payable_open follows the purchase-settlement org predicate for restricted callers', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const sup = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const ins = db.prepare("INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, status) VALUES (?,?,?,date('now','localtime'),?,?,?)")
  ins.run('AG2-ST-A', whA.org_id, sup, 100, 30, 'audited')
  ins.run('AG2-ST-A-V', whA.org_id, sup, 9999, 0, 'voided')
  ins.run('AG2-ST-B', whB.org_id, sup, 1000, 0, 'audited')
  ins.run('AG2-ST-N', null, sup, 50000, 0, 'audited')
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of METRIC_BY_KEY.payable_open.perms) grant.run('warehouse', p)
  grant.run('warehouse', 'system:metrics:view')
  const vals = async (token) => okData(await api('/api/metrics/values?keys=payable_open', { token }))
  const one = (sql, ...a) => db.prepare(sql).get(...a).v
  const A = await f.account('ag2_wh_a', 'warehouse', { org_id: whA.org_id, data_scope: 'org' })
  const a = await vals(A.token)
  const g = await vals(f.admin)
  const expect = Math.round(one("SELECT COALESCE(SUM(settle_amount-paid_amount),0) v FROM purchase_settlements WHERE status<>'voided' AND org_id=?", whA.org_id) * 100) / 100
  assert.equal(a.values.payable_open, expect)
  assert.ok(a.values.payable_open >= 70)
  assert.equal(a.scoped.payable_open, true)
  assert.ok(g.values.payable_open >= 51070 && g.values.payable_open > a.values.payable_open, 'org B and NULL-org rows only in the global number')
  // 空范围失败关闭
  const N = await f.account('ag2_none', 'warehouse', { data_scope: 'org' })
  db.prepare('UPDATE users SET org_id=NULL WHERE id=?').run(N.id)
  assert.equal((await vals(await f.login(N.username, N.password))).values.payable_open, 0)
  // 绑定门店账号（data_scope=all）：bound:deny，不可见
  const store = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get()
  const B = await f.account('ag2_bound', 'warehouse', { data_scope: 'all' })
  db.prepare('UPDATE users SET data_scope=?, store_id=? WHERE id=?').run('all', store.id, B.id)
  assert.ok(!('payable_open' in (await vals(await f.login(B.username, B.password))).values))
})
