/**
 * ============================================================================
 * 文件标识：tests/hq-roles.test.mjs ｜ 测试：总部角色名单单点与 docflow 严格门店绑定（ADR-0051）
 * ============================================================================
 * 【职责】守住 ADR-0051：
 *   ① `server/lib/hq-roles.js` 是总部角色名单唯一来源：并集 = 原 pos.js 与 requisitions.js 两份名单之并，
 *      POS 与门店要货各自的路由闸名单与改动前逐项相同（行为不变），pos.js / requisitions.js 不再自带字面量名单；
 *   ② `/api/docflow/*` 默认严格：未绑门店、非总部角色、data_scope=all 的内部账号读不到 RC / YQ / SH 单据与留痕；
 *      总部角色 / admin / is_super 豁免；绑了门店者仍只限本店；
 *   ③ 危险设置键 `docflow_strict_store_binding`：默认开，关则恢复改动前行为（两态都测）。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录 + 随机回环端口；账号经 `/api/auth/users` 建，单据 / 事件直接写库。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { HQ_ROLES, POS_HQ_ROLES, REQUISITION_HQ_ROLES, isHqRole } from '../server/lib/hq-roles.js'
import { SETTING_RULES } from '../server/lib/settings.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

test('hq-roles: union of the two historical lists, per-surface lists unchanged', () => {
  const OLD_POS = ['admin', 'sales', 'finance', 'warehouse']
  const OLD_REQ = ['purchase', 'warehouse', 'sales', 'scm', 'admin', 'finance']
  // AD2 (ADR-0051 supplement): `boss` joins the union only (general-manager view), the two per-surface route gates stay as they were
  assert.deepEqual([...HQ_ROLES].sort(), [...new Set([...OLD_POS, ...OLD_REQ, 'boss'])].sort())
  assert.equal(POS_HQ_ROLES.includes('boss'), false)
  assert.equal(REQUISITION_HQ_ROLES.includes('boss'), false)
  assert.deepEqual([...POS_HQ_ROLES].sort(), [...OLD_POS].sort())
  assert.deepEqual([...REQUISITION_HQ_ROLES].sort(), [...OLD_REQ].sort())
  for (const r of HQ_ROLES) assert.ok(isHqRole(r), r)
  for (const r of ['viewer', 'store', 'dealer', 'x', undefined, null]) assert.equal(isHqRole(r), false, String(r))
  assert.ok(Object.isFrozen(HQ_ROLES) && Object.isFrozen(POS_HQ_ROLES) && Object.isFrozen(REQUISITION_HQ_ROLES))
})

test('pos.js / requisitions.js take their lists from hq-roles.js (no literal role lists)', () => {
  const pos = readFileSync(path.join(ROOT, 'server/routes/pos.js'), 'utf8')
  const req = readFileSync(path.join(ROOT, 'server/routes/requisitions.js'), 'utf8')
  assert.match(pos, /from '\.\.\/lib\/hq-roles\.js'/)
  assert.match(req, /from '\.\.\/lib\/hq-roles\.js'/)
  assert.doesNotMatch(pos, /HQ_ROLES\s*=\s*\[/)
  assert.doesNotMatch(req, /\bHQ\s*=\s*\[/)
})

test('docflow_strict_store_binding is a registered danger setting defaulting to on', () => {
  const rule = SETTING_RULES.docflow_strict_store_binding
  assert.ok(rule)
  assert.equal(rule.type, 'bool')
  assert.equal(rule.default, '1')
  assert.equal(rule.is_danger, true)
})

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-hq-roles-'))
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
  return { api, db, admin, account }
}

test('docflow strict store binding: both switch states, HQ exemption, bound accounts', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()
  const mkClose = db.prepare('INSERT INTO pos_daily_closes (batch_no, store_id, warehouse_id, biz_date) VALUES (?,?,?,?)')
  const rc1 = Number(mkClose.run('RBJ-AC2-1', 1, wh.id, '2026-10-01').lastInsertRowid)
  const rc2 = Number(mkClose.run('RBJ-AC2-2', 2, wh.id, '2026-10-01').lastInsertRowid)
  const insEv = db.prepare(`INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,to_state,source,created_at)
    VALUES (?,?,?,'ac2test','ac2test','x','api',datetime('now','localtime'))`)
  const ev = (type, id, no) => Number(insEv.run(type, id, no).lastInsertRowid)
  const E = { rc1: ev('RC', rc1, 'RBJ-AC2-1'), rc2: ev('RC', rc2, 'RBJ-AC2-2') }
  const [po] = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 1').all()
  E.po = ev('PO', po.id, 'AC2-PO')
  const mine = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.list.filter((x) => x.action === 'ac2test').map((x) => x.id).sort((a, b) => a - b) }
  const events = (tk) => api('/api/docflow/events?action=ac2test&pageSize=500', { token: tk })
  const sorted = (...k) => k.map((x) => E[x]).sort((a, b) => a - b)
  const setSwitch = (v) => { db.prepare("INSERT INTO settings (key,value) VALUES ('docflow_strict_store_binding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v) }

  const boss = await f.account('ac2_boss', 'boss', { data_scope: 'all' })
  const viewer = await f.account('ac2_viewer', 'viewer', { data_scope: 'all' })
  const finance = await f.account('ac2_fin', 'finance', { data_scope: 'all' })
  const purchase = await f.account('ac2_pur', 'purchase', { data_scope: 'all' })
  const scm = await f.account('ac2_scm', 'scm', { data_scope: 'all' })
  const boundBoss = await f.account('ac2_bboss', 'boss', { data_scope: 'all', store_id: 1 })
  const superBoss = await f.account('ac2_super', 'boss', { data_scope: 'all' })
  db.prepare('UPDATE users SET is_super=1 WHERE id=?').run(superBoss.id)

  await t.test('default (switch absent = on): unbound non-HQ (viewer) all-scope sees no RC but still sees non-store types', async () => {
    for (const who of [viewer]) assert.deepEqual(mine(await events(who.token)), sorted('po'), who.username)
    const hist = await api(`/api/docflow/history/RC/${rc1}`, { token: viewer.token })
    assert.equal(hist.status, 404)
    const trace = await api('/api/docflow/trace?doc_no=RBJ-AC2-1', { token: viewer.token })
    assert.equal(trace.status, 200)
    assert.ok(Array.isArray(trace.body.data), 'trace returns an array')
    assert.equal(trace.body.data.length, 0)
  })

  await t.test('default: HQ roles, admin and is_super are exempt and still see everything', async () => {
    for (const who of [finance, purchase, scm, boss, superBoss]) assert.deepEqual(mine(await events(who.token)), sorted('rc1', 'rc2', 'po'), who.username)
    assert.deepEqual(mine(await events(f.admin)), sorted('rc1', 'rc2', 'po'))
    assert.equal((await api(`/api/docflow/history/RC/${rc1}`, { token: finance.token })).status, 200)
  })

  await t.test('POST /transition does not reveal RC documents to unbound non-HQ accounts (same 404 as missing)', async () => {
    const probe = (tk, id) => api('/api/docflow/transition', { token: tk, body: { doc_type: 'RC', id, action: 'probe' } })
    const hidden = await probe(viewer.token, rc1)
    const missing = await probe(viewer.token, 999999)
    assert.equal(hidden.status, 404)
    assert.deepEqual(hidden.body, missing.body)
    assert.notEqual((await probe(finance.token, rc1)).status, 404, 'HQ role is not blocked by the binding gate')
  })

  await t.test('default: store-bound account is still limited to its own store', async () => {
    assert.deepEqual(mine(await events(boundBoss.token)), sorted('rc1', 'po'))
  })

  await t.test('switch off restores the previous behaviour (unbound non-HQ all-scope sees everything)', async () => {
    setSwitch('0')
    for (const who of [boss, viewer, finance]) assert.deepEqual(mine(await events(who.token)), sorted('rc1', 'rc2', 'po'), who.username)
    assert.equal((await api(`/api/docflow/history/RC/${rc2}`, { token: boss.token })).status, 200)
    assert.deepEqual(mine(await events(boundBoss.token)), sorted('rc1', 'po'), 'bound accounts stay narrowed')
  })

  await t.test('switch back on (explicit 1) strict again; garbage value falls back to default on', async () => {
    setSwitch('1')
    assert.deepEqual(mine(await events(viewer.token)), sorted('po'))
    setSwitch('garbage')
    assert.deepEqual(mine(await events(viewer.token)), sorted('po'))
  })

  await t.test('overview distribution hides RC from unbound non-HQ and keeps it for HQ', async () => {
    setSwitch('1')
    const dist = (r) => r.body.data.distribution.map((d) => d.docType)
    assert.ok(!dist(await api('/api/docflow/overview', { token: viewer.token })).includes('RC'))
    assert.ok(dist(await api('/api/docflow/overview', { token: finance.token })).includes('RC'))
    assert.ok(dist(await api('/api/docflow/overview', { token: boss.token })).includes('RC'), 'boss is HQ since AD2')
  })
})
