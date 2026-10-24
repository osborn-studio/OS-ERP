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
import { METRICS } from '../server/lib/metrics.js'

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
})
