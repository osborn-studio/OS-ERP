/**
 * ============================================================================
 * 文件标识：tests/pos-authz.test.mjs ｜ 测试：门店 POS 路由的权限点、跨店 404 与交班核款自审拒绝（ADR-0025）
 * ============================================================================
 * 【职责】守住 X1 的四条验收：
 *   ① 迁移 058 把 POS 权限点写进字典并按 ADR-0007 只在首次授予内置角色（管理员削减后不被恢复）；
 *   ② 每条 /api/pos 门店路由都按动作要求权限点：撤掉对应权限的门店账号 403，恢复后不再是 403；
 *   ③ 门店账号碰别家门店的班次 / 缴款单 → 404（按"不存在"处理），且单据状态一分不动；
 *   ④ 交班核款 / 退回：开班人或报数人不能自己批 → 409 `POS_SELF_APPROVE`；另一人批准正常；admin 绑门店后正常。
 *
 * 【夹具口径】内存库 + schema.sql + 全部迁移验证字典与授权；HTTP 部分起 test 运行时的隔离服务
 *   （全新临时目录 + 随机回环端口），账号经 `/api/auth/users` 建（随机合成口令，不输出），班次 / 缴款单直接写库造数。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

/** 058 新增的权限点（其余 POS 权限点沿用 005 / 024 已有的字典项） */
const NEW_PERMS = ['pos.view', 'pos.cashdrop.receive']
/** 门店日常权限：内置 store 角色必须全部持有 */
const STORE_DAILY = [
  'pos.view', 'pos.cashier', 'pos.refund', 'pos.shift', 'pos.shift.review', 'pos.cashdrop',
  'pos.cashdrop.receive', 'pos.dailyclose', 'pos.store.stock', 'pos.store.check'
]

test('migration 058 registers the POS permission points and grants built-in roles once (ADR-0007)', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
    runMigrations(db)
    for (const code of NEW_PERMS) {
      const row = db.prepare('SELECT module, category FROM permissions WHERE code=?').get(code)
      assert.ok(row, `${code} must be in the permission dictionary`)
      assert.equal(row.module, 'pos')
    }
    const grants = (role) => db.prepare('SELECT perm_code FROM role_permissions WHERE role_code=?').all(role).map((r) => r.perm_code)
    for (const code of STORE_DAILY) assert.ok(grants('store').includes(code), `store role holds ${code}`)
    for (const code of NEW_PERMS) assert.ok(grants('admin').includes(code), `admin role holds ${code}`)
    for (const role of ['viewer', 'sales', 'purchase', 'dealer']) {
      for (const code of NEW_PERMS) assert.ok(!grants(role).includes(code), `${role} must not hold ${code}`)
    }
    // ADR-0007：管理员削减授权是策略，正常重启（重跑迁移检查）不得把它恢复
    db.prepare("DELETE FROM role_permissions WHERE role_code='store' AND perm_code='pos.cashdrop.receive'").run()
    runMigrations(db)
    runMigrations(db)
    assert.ok(!grants('store').includes('pos.cashdrop.receive'), 'trimmed grant stays trimmed after migration re-check')
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-pos-authz-'))
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
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.pragma('busy_timeout=5000')
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
    return { id: r.body.data.id, username, token: await login(username, password) }
  }
  return { api, db, admin, account }
}

let seq = 0
/** 直接写库造一张班次（含"开班"事件，模拟真实开班留痕）与可选的"报数"事件 */
function makeShift(db, { storeId, openerId, openerName, status = 'declared', declarerId = null, declarerName = null }) {
  seq += 1
  const docNo = `PSF-T${Date.now()}-${seq}`
  const info = db.prepare(
    `INSERT INTO pos_shifts (doc_no,store_id,cashier_id,cashier_name,biz_date,opened_at,status,opening_float,declared_cash,sys_cash,counted_cash,variance)
     VALUES (?,?,?,?,?,?,?,0,100,100,0,0)`
  ).run(docNo, storeId, openerId, openerName, '2026-10-23', '2026-10-23 09:00:00', status)
  const id = Number(info.lastInsertRowid)
  const ev = db.prepare(
    `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,to_state,actor_id,actor_name,source) VALUES ('PSF',?,?,?,?,?,?,?,'api')`
  )
  ev.run(id, docNo, 'open', '开班', 'open', openerId, openerName)
  if (status === 'declared') ev.run(id, docNo, 'declare', '交班报数', 'declared', declarerId ?? openerId, declarerName ?? openerName)
  return { id, docNo }
}

function makeDrop(db, { storeId, handedBy }) {
  seq += 1
  const info = db.prepare(
    `INSERT INTO pos_cash_drops (doc_no,store_id,drop_date,amount,handed_by,handed_by_name,status) VALUES (?,?,?,?,?,?, 'pending')`
  ).run(`JKD-T${Date.now()}-${seq}`, storeId, '2026-10-23', 50, handedBy, 'maker')
  return Number(info.lastInsertRowid)
}

const shiftRow = (db, id) => db.prepare('SELECT status, approved_by FROM pos_shifts WHERE id=?').get(id)

test('HTTP: every POS store route requires its permission point', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const clerk = await f.account('pos_perm_user', 'store', { store_id: 1 })
  const shift = makeShift(db, { storeId: 1, openerId: 9, openerName: 'someone-else' })
  const drop = makeDrop(db, { storeId: 1, handedBy: 9 })

  // [权限点, 方法, 路径, 请求体]
  const routes = [
    ['pos.view', 'GET', '/api/pos/context'],
    ['pos.view', 'GET', '/api/pos/products'],
    ['pos.view', 'GET', '/api/pos/orders'],
    ['pos.view', 'GET', '/api/pos/orders/1'],
    ['pos.view', 'GET', '/api/pos/shifts'],
    ['pos.view', 'GET', '/api/pos/shifts/open'],
    ['pos.view', 'GET', `/api/pos/shifts/${shift.id}`],
    ['pos.view', 'GET', '/api/pos/cash-drops'],
    ['pos.view', 'GET', '/api/pos/cash-drops/pending-shifts'],
    ['pos.view', 'GET', '/api/pos/daily-closes'],
    ['pos.view', 'GET', '/api/pos/returns'],
    ['pos.view', 'GET', '/api/pos/stock-checks'],
    ['pos.view', 'GET', '/api/pos/stock-checks/1'],
    ['pos.store.stock', 'GET', '/api/pos/stocks'],
    ['pos.cashier', 'POST', '/api/pos/orders', {}],
    ['pos.cashier', 'POST', '/api/pos/quote', {}],
    ['pos.refund', 'POST', '/api/pos/orders/1/void', {}],
    ['pos.refund', 'POST', '/api/pos/returns', {}],
    ['pos.shift', 'POST', '/api/pos/shifts/open', {}],
    ['pos.shift', 'POST', `/api/pos/shifts/${shift.id}/declare`, {}],
    ['pos.shift', 'POST', '/api/pos/shifts/close', {}],
    ['pos.shift', 'POST', `/api/pos/shifts/${shift.id}/cancel`, {}],
    ['pos.shift.review', 'POST', `/api/pos/shifts/${shift.id}/reject`, { remark: 'x' }],
    ['pos.shift.review', 'POST', `/api/pos/shifts/${shift.id}/approve`, {}],
    ['pos.cashdrop', 'POST', '/api/pos/cash-drops', {}],
    ['pos.cashdrop', 'POST', `/api/pos/cash-drops/${drop}/cancel`, {}],
    ['pos.cashdrop.receive', 'POST', `/api/pos/cash-drops/${drop}/receive`, {}],
    ['pos.dailyclose', 'POST', '/api/pos/daily-close', {}],
    ['pos.store.check', 'POST', '/api/pos/stock-checks', {}],
    ['pos.store.check', 'PUT', '/api/pos/stock-checks/1/items', { items: [] }],
    ['pos.store.check', 'POST', '/api/pos/stock-checks/1/adjust', {}]
  ]
  const call = ([, method, route, body]) => api(route, { token: clerk.token, method, ...(body === undefined ? {} : { body }) })
  const codes = [...new Set(routes.map((r) => r[0]))]
  for (const code of codes) {
    const own = routes.filter((r) => r[0] === code)
    // 每条路由在整个遍历里只可能被"撤权"触发一次，所以先撤权测 403，再恢复测"不是 403"
    db.prepare("DELETE FROM role_permissions WHERE role_code='store' AND perm_code=?").run(code)
    for (const r of own) assert.equal((await call(r)).status, 403, `${r[1]} ${r[2]} must be 403 without ${code}`)
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES ('store',?)").run(code)
    for (const r of own) {
      const { status } = await call(r)
      // 过了权限闸：只会是业务结果（2xx / 400 / 404 / 409），不是 401 / 403 / 5xx
      assert.ok(status < 500 && status !== 401 && status !== 403, `${r[1]} ${r[2]} must pass the permission gate with ${code}, got ${status}`)
    }
  }
  // 反过来：只拿对一个权限点不能顺带放行别的动作（approve 需要 review，不是 shift）
  const fresh = makeShift(db, { storeId: 1, openerId: 9, openerName: 'someone-else' })
  db.prepare("DELETE FROM role_permissions WHERE role_code='store' AND perm_code='pos.shift.review'").run()
  assert.equal((await api(`/api/pos/shifts/${fresh.id}/approve`, { token: clerk.token, body: { counted_cash: 100 } })).status, 403)
  assert.equal(shiftRow(db, fresh.id).status, 'declared', 'forbidden approve changed nothing')
  // 取消已报数班次还要 review 权限（Codex 审计 P2）：只有 pos.shift 不够
  const declaredFresh = makeShift(db, { storeId: 1, openerId: 9, openerName: 'someone-else' })
  assert.equal((await api(`/api/pos/shifts/${declaredFresh.id}/cancel`, { token: clerk.token, body: {} })).status, 403)
  assert.equal(shiftRow(db, declaredFresh.id).status, 'declared')
  db.prepare("INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES ('store','pos.shift.review')").run()
  assert.equal((await api(`/api/pos/shifts/${declaredFresh.id}/cancel`, { token: clerk.token, body: {} })).status, 200)
  // 非门店且无门店绑定的角色不能碰 POS 门店路由
  const sales = await f.account('pos_sales_user', 'sales', { data_scope: 'all' })
  assert.equal((await api('/api/pos/context', { token: sales.token })).status, 403)
  assert.equal((await api(`/api/pos/shifts/${fresh.id}/approve`, { token: sales.token, body: {} })).status, 403)
})

test('HTTP: store accounts cannot touch another store\'s shifts or cash drops (404, no state change)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const storeA = await f.account('pos_store_a', 'store', { store_id: 1 })
  const storeB = await f.account('pos_store_b', 'store', { store_id: 2 })
  const declared = makeShift(db, { storeId: 1, openerId: 9, openerName: 'cashier-x' })
  const open = makeShift(db, { storeId: 1, openerId: 10, openerName: 'cashier-y', status: 'open' })
  const drop = makeDrop(db, { storeId: 1, handedBy: 9 })

  for (const [route, body] of [
    [`/api/pos/shifts/${declared.id}/approve`, { counted_cash: 100 }],
    [`/api/pos/shifts/${declared.id}/reject`, { remark: 'recount' }],
    [`/api/pos/shifts/${declared.id}/cancel`, {}],
    [`/api/pos/shifts/${open.id}/declare`, {}],
    [`/api/pos/cash-drops/${drop}/receive`, {}],
    [`/api/pos/cash-drops/${drop}/cancel`, {}]
  ]) {
    const r = await api(route, { token: storeB.token, body })
    assert.equal(r.status, 404, `${route} must be 404 for another store: ${JSON.stringify(r.body)}`)
  }
  assert.equal((await api(`/api/pos/shifts/${declared.id}`, { token: storeB.token })).status, 404)
  assert.equal((await api(`/api/pos/shifts/${declared.id}`, { token: storeA.token })).status, 200)
  assert.equal(shiftRow(db, declared.id).status, 'declared')
  assert.equal(shiftRow(db, open.id).status, 'open')
  assert.equal(db.prepare('SELECT status FROM pos_cash_drops WHERE id=?').get(drop).status, 'pending')
  // 同店账号仍能处理（班次开班人是别人，不触发自审）
  const ok = await api(`/api/pos/shifts/${declared.id}/approve`, { token: storeA.token, body: { counted_cash: 100 } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(shiftRow(db, declared.id).status, 'closed')
})

test('HTTP: shift approve / reject refuse the person who opened or declared it (POS_SELF_APPROVE)', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const cashier = await f.account('pos_cashier', 'store', { store_id: 1 })
  const manager = await f.account('pos_manager', 'store', { store_id: 1 })
  const declarer = await f.account('pos_declarer', 'store', { store_id: 1 })

  const own = makeShift(db, { storeId: 1, openerId: cashier.id, openerName: 'pos_cashier' })
  for (const [action, body] of [['approve', { counted_cash: 100 }], ['reject', { remark: 'recount' }]]) {
    const r = await api(`/api/pos/shifts/${own.id}/${action}`, { token: cashier.token, body })
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.match(JSON.stringify(r.body), /POS_SELF_APPROVE/)
  }
  assert.equal(shiftRow(db, own.id).status, 'declared', 'self approve / reject changed nothing')
  const approved = await api(`/api/pos/shifts/${own.id}/approve`, { token: manager.token, body: { counted_cash: 100 } })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(shiftRow(db, own.id).status, 'closed')
  assert.equal(shiftRow(db, own.id).approved_by, manager.id)

  // 开班的是 A、替他报数的是 declarer：报数人同样不能自己核款，开班人 A 也不行
  const proxy = makeShift(db, { storeId: 1, openerId: cashier.id, openerName: 'pos_cashier', declarerId: declarer.id, declarerName: 'pos_declarer' })
  for (const who of [declarer, cashier]) {
    const r = await api(`/api/pos/shifts/${proxy.id}/approve`, { token: who.token, body: { counted_cash: 100 } })
    assert.equal(r.status, 409, `${who.username}: ${JSON.stringify(r.body)}`)
  }
  const rej = await api(`/api/pos/shifts/${proxy.id}/reject`, { token: manager.token, body: { remark: 'recount' } })
  assert.equal(rej.status, 200, JSON.stringify(rej.body))

  // 历史班次只有名字没有 id（cashier_id 为空）：按名字兜底
  const legacy = makeShift(db, { storeId: 1, openerId: null, openerName: 'pos_manager' })
  db.prepare("UPDATE doc_events SET actor_id=NULL WHERE doc_id=? AND doc_type='PSF'").run(legacy.id)
  const byName = await api(`/api/pos/shifts/${legacy.id}/approve`, { token: manager.token, body: { counted_cash: 100 } })
  assert.equal(byName.status, 409, JSON.stringify(byName.body))
})

test('HTTP: admin bound to a store passes the gates and can check a shift opened by someone else', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const boundAdmin = await f.account('pos_admin_bound', 'admin', { store_id: 1 })
  assert.equal(db.prepare('SELECT store_id FROM users WHERE id=?').get(boundAdmin.id).store_id, 1, 'fixture: admin account bound to store 1')
  assert.equal((await api('/api/pos/context', { token: boundAdmin.token })).status, 200)
  const shift = makeShift(db, { storeId: 1, openerId: 9, openerName: 'someone-else' })
  const r = await api(`/api/pos/shifts/${shift.id}/approve`, { token: boundAdmin.token, body: { counted_cash: 100 } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(shiftRow(db, shift.id).status, 'closed')
  // 总部侧只读监控不受影响
  assert.equal((await api('/api/pos/hq/overview', { token: f.admin })).status, 200)
  // 但 admin 开班人也不能自批
  const mine = makeShift(db, { storeId: 1, openerId: boundAdmin.id, openerName: 'pos_admin_bound' })
  const self = await api(`/api/pos/shifts/${mine.id}/approve`, { token: boundAdmin.token, body: { counted_cash: 100 } })
  assert.equal(self.status, 409, JSON.stringify(self.body))
})
