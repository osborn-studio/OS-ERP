/**
 * ============================================================================
 * 文件标识：tests/authz-misc.test.mjs ｜ 测试：杂项授权缺口收口（ADR-0028）
 * ============================================================================
 * 【职责】守住 ADR-0028 的四处收口：
 *     · `POST /api/docflow/no-issue`：非干跑要求该单据类型的创建权限；映射表缺项 ⇒ 403 DOC_TYPE_PERM_UNMAPPED；
 *       干跑豁免；映射表覆盖全部 doc_types，且每个权限码真实存在；
 *     · `GET /api/auth/orgs`：admin 全量，其余账号按 resolveOrgScope 裁剪；
 *     · `POST /api/qimen`：缺 app_key / 未知 app_key / 缺签名 / 错签名一律 401，正确签名（ADR-0033 平台密钥 HMAC）才放行；
 *     · `POST /api/purchase/payments`、`/settlements`：自动核销与结算来源选择按调用者组织范围，
 *       手工核销指向范围外结算单 ⇒ 404（与不存在同形）。
 *
 * 【夹具口径】同 purchase-chain-detail-scope.test.mjs：test 运行时、临时数据目录、随机回环端口，单据直接写库。
 * 【改它要注意什么】断言是精确状态码与精确数值，不是"比全库少"。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-authz-misc-'))
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



const forbidden = (r, m = '') => assert.equal(r.status, 403, `${m} ${JSON.stringify(r.body)}`)
const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

test('doc type to create-permission mapping is total and points at real permissions', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { DOC_CREATE_PERMS, createPermOf } = await import('../server/lib/docflow.js')
  const types = f.db.prepare('SELECT code FROM doc_types').all().map((x) => x.code)
  const perms = new Set(f.db.prepare('SELECT code FROM permissions').all().map((x) => x.code))
  assert.ok(types.length >= 30)
  for (const code of types) {
    assert.ok(DOC_CREATE_PERMS[code], `doc type ${code} must have a create permission`)
    assert.ok(perms.has(createPermOf(code)), `${code} -> ${DOC_CREATE_PERMS[code]} must be a real permission code`)
  }
  for (const code of Object.keys(DOC_CREATE_PERMS)) assert.ok(types.includes(code), `stale mapping entry ${code}`)
  assert.equal(DOC_CREATE_PERMS.SH, 'sales.outbound')
  assert.equal(createPermOf('NOPE'), null)
  assert.equal(createPermOf('toString'), null)
})

test('no-issue requires the create permission of the doc type; dry runs are exempt', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const issue = (token, body) => api('/api/docflow/no-issue', { token, body })
  const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('NI1','NI store')").run().lastInsertRowid)
  const dealerId = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('ND1','NI dealer')").run().lastInsertRowid)
  const store = await f.account('ni_store', 'store', { store_id: storeId })
  const dealer = await f.account('ni_dealer', 'dealer', { dealer_id: dealerId })
  const sales = await f.account('ni_sales', 'sales', { data_scope: 'all' })
  const purchase = await f.account('ni_purchase', 'purchase', { data_scope: 'all' })
  const hasPerm = (role, code) => !!db.prepare('SELECT 1 FROM role_permissions WHERE role_code=? AND perm_code=?').get(role, code)
  assert.ok(hasPerm('purchase', 'purchase.order.edit') && !hasPerm('purchase', 'sales.order.edit'))
  assert.ok(hasPerm('sales', 'sales.order.edit') && !hasPerm('sales', 'purchase.order.edit'))

  assert.equal((await api('/api/docflow/no-issue', { body: { doc_type: 'PO' } })).status, 401)
  const seqBefore = () => db.prepare('SELECT COALESCE(SUM(current_value),0) s FROM doc_no_counters').get().s
  for (const u of [store, dealer, sales]) {
    const before = seqBefore()
    forbidden(await issue(u.token, { doc_type: 'PO' }), `PO by ${u.username}`)
    assert.equal(seqBefore(), before, 'a rejected call must not consume a number')
  }
  const po = okData(await issue(purchase.token, { doc_type: 'PO' }))
  assert.match(po.docNo, /^PO/)
  forbidden(await issue(purchase.token, { doc_type: 'SO' }), 'purchase must not issue SO numbers')
  const so = okData(await issue(sales.token, { doc_type: 'SO' }))
  assert.match(so.docNo, /^SO/)
  okData(await issue(f.admin, { doc_type: 'PAY' }))

  // 受限范围不得替范围外的组织 / 仓取号
  const whs = db.prepare('SELECT w.id, w.org_id, o.path FROM warehouses w JOIN orgs o ON o.id = w.org_id WHERE w.status=\'active\' GROUP BY w.org_id').all()
  const wA = whs[0]
  const wB = whs.find((w) => !w.path.startsWith(wA.path) && !wA.path.startsWith(w.path))
  const scoped = await f.account('ni_scoped', 'purchase', { org_id: wA.org_id, data_scope: 'org' })
  const before0 = seqBefore()
  forbidden(await issue(scoped.token, { doc_type: 'PO', org_id: wB.org_id }), 'foreign org')
  forbidden(await issue(scoped.token, { doc_type: 'PO', warehouse_id: wB.id }), 'foreign warehouse')
  assert.equal(seqBefore(), before0)
  okData(await issue(scoped.token, { doc_type: 'PO', org_id: wA.org_id, warehouse_id: wA.id }))
  okData(await issue(scoped.token, { doc_type: 'PO' }))
  okData(await issue(f.admin, { doc_type: 'PO', org_id: wB.org_id }))

  // 一次取号只消耗一个序号
  const one = seqBefore()
  okData(await issue(f.admin, { doc_type: 'PAY' }))
  assert.equal(seqBefore(), one + 1)

  // 干跑豁免：只读预览，不消耗序号
  for (const u of [store, dealer, sales, purchase]) {
    const before = seqBefore()
    assert.equal(okData(await issue(u.token, { doc_type: 'SO', dry: true })).dry, true)
    assert.equal(seqBefore(), before)
  }

  // 未映射 / 未注册类型：一律 403 DOC_TYPE_PERM_UNMAPPED（含管理员），且不取号
  db.prepare("INSERT INTO doc_types (code,name,module,table_name,doc_no_prefix) VALUES ('ZZ','Unmapped','test','purchase_orders','ZZ')").run()
  for (const token of [f.admin, purchase.token]) {
    for (const doc_type of ['ZZ', 'NO_SUCH_TYPE']) {
      const before = seqBefore()
      const r = await issue(token, { doc_type })
      forbidden(r, doc_type)
      assert.equal(r.body.detail?.code ?? r.body.error ?? r.body.code, 'DOC_TYPE_PERM_UNMAPPED', JSON.stringify(r.body))
      assert.equal(seqBefore(), before)
    }
  }
})

test('auth orgs list is trimmed by org scope for non-admin accounts', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const all = db.prepare('SELECT id, path FROM orgs WHERE id<>0').all()
  const whs = db.prepare(`SELECT w.org_id, o.path FROM warehouses w JOIN orgs o ON o.id = w.org_id WHERE w.status='active' GROUP BY w.org_id`).all()
  const orgA = whs[0]
  const adminList = okData(await api('/api/auth/orgs', { token: f.admin }))
  assert.equal(adminList.length, all.length)

  const idsOf = (list) => list.map((o) => o.id).sort((a, b) => a - b)
  const own = await f.account('og_org', 'warehouse', { org_id: orgA.org_id, data_scope: 'org' })
  assert.deepEqual(idsOf(okData(await api('/api/auth/orgs', { token: own.token }))), [orgA.org_id])
  const filtered = okData(await api('/api/auth/orgs?keyword=a', { token: own.token }))
  assert.ok(filtered.every((o) => o.id === orgA.org_id))

  const sub = await f.account('og_sub', 'purchase', { org_id: orgA.org_id, data_scope: 'subtree' })
  const subIds = db.prepare('SELECT id FROM orgs WHERE (path LIKE ? OR id=?) AND id<>0').all(`${orgA.path}%`, orgA.org_id).map((r) => r.id)
  assert.deepEqual(idsOf(okData(await api('/api/auth/orgs', { token: sub.token }))), subIds.sort((a, b) => a - b))

  const glob = await f.account('og_glob', 'finance', { data_scope: 'all' })
  assert.equal(okData(await api('/api/auth/orgs', { token: glob.token })).length, all.length)

  const none = await f.account('og_none', 'purchase', { data_scope: 'org' })
  assert.deepEqual(okData(await api('/api/auth/orgs', { token: none.token })), [])

  const dealerId = Number(db.prepare('INSERT INTO dealers (code,name,org_id) VALUES (?,?,?)').run('OGD1', 'Org dealer', orgA.org_id).lastInsertRowid)
  const dealer = await f.account('og_dealer', 'dealer', { dealer_id: dealerId })
  assert.deepEqual(idsOf(okData(await api('/api/auth/orgs', { token: dealer.token }))), [orgA.org_id])
  assert.equal((await api('/api/auth/orgs')).status, 401)
})

test('qimen gateway never passes through unauthenticated or badly signed calls', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const pf = db.prepare("SELECT id, app_key FROM platforms WHERE app_key IS NOT NULL AND app_key<>'' AND status='active' LIMIT 1").get()
  const issued = await api(`/api/qimen/platforms/${pf.id}/secret`, { token: f.admin, body: {} })
  assert.equal(issued.status, 200, JSON.stringify(issued.body))
  const platformSecret = issued.body.data.secret
  const method = 'taobao.qimen.itemmapping.query'
  // ADR-0033：HMAC-SHA256(平台密钥, app_key\nmethod\ntimestamp\nnonce\nsha256(排序 JSON(request)))
  const signed = (m, request = {}, over = {}) => {
    const timestamp = String(Date.now())
    const nonce = randomBytes(12).toString('hex')
    const digest = createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex')
    const sign = createHmac('sha256', platformSecret).update([pf.app_key, m, timestamp, nonce, digest].join('\n')).digest('hex').toUpperCase()
    return { method: m, request, app_key: pf.app_key, timestamp, nonce, sign, ...over }
  }
  const unauthorized = async (body, why) => {
    const r = await api('/api/qimen', { body })
    assert.equal(r.status, 401, `${why}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.success, false)
    assert.ok(r.body.code, why)
    assert.equal(r.body.mappings, undefined, why)
  }
  await unauthorized({}, 'empty body')
  await unauthorized({ method, request: {} }, 'missing app_key')
  await unauthorized({ method, request: {}, app_key: '' }, 'empty app_key')
  await unauthorized({ method, request: {}, app_key: 'no-such-key' }, 'unknown app_key')
  await unauthorized({ ...signed(method), sign: undefined }, 'missing sign')
  await unauthorized({ ...signed(method), sign: 'DEADBEEF' }, 'bad sign')
  await unauthorized({ ...signed('other.method'), method }, 'sign for another method')
  await unauthorized({ method, request: {}, app_key: { toString: 'x' }, sign: 'x' }, 'non-string app_key')
  await unauthorized({ method: 'bogus.method', request: {} }, 'unknown method without credentials')
  await unauthorized({ method, request: {}, app_key: pf.app_key, sign: md5(`${pf.app_key}${method}GML-DEMO-SECRET`) }, 'legacy demo-constant signature')

  const good = await api('/api/qimen', { body: signed(method) })
  assert.equal(good.status, 200, JSON.stringify(good.body))
  assert.equal(good.body.success, true)
  // 已鉴权但方法未知：仍是协议内的 200 错误码
  const unknown = await api('/api/qimen', { body: signed('bogus.method') })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.code, '1002')
  // 平台绑定发货仓：只能查自己的仓；他仓 / 未知仓编码 / 缺省都不能退化成全仓汇总
  const whRows = db.prepare('SELECT id, code FROM warehouses ORDER BY id LIMIT 2').all()
  db.prepare('UPDATE platforms SET warehouse_id=? WHERE app_key=?').run(whRows[0].id, pf.app_key)
  const invMethod = 'taobao.qimen.inventory.query'
  const inv = async (request) => (await api('/api/qimen', { body: signed(invMethod, request) })).body
  assert.deepEqual((await inv({ warehouseCode: whRows[1].code })).items, [])
  assert.deepEqual((await inv({ warehouseCode: 'NO-SUCH-WH' })).items, [])
  const own = await inv({})
  assert.equal(own.warehouseCode, whRows[0].code)
  const ownSum = db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand<>0').get(whRows[0].id).q
  assert.ok(own.items.length <= 100)
  // 浮点求和顺序因平台/SQLite 版本而异（ubuntu 上出现 22357.892099999997 vs 22357.8921），按容差比较
  if (own.items.length < 100) assert.ok(Math.abs(own.items.reduce((a, x) => a + x.quantity, 0) - ownSum) < 1e-6, `qimen inventory sum ${ownSum}`)
  assert.equal((await inv({ warehouseCode: whRows[0].code })).warehouseCode, whRows[0].code)
  // 停用平台不再通过
  db.prepare("UPDATE platforms SET status='disabled' WHERE app_key=?").run(pf.app_key)
  await unauthorized(signed(method), 'disabled platform')
})

test('payment auto-allocation and settlement source selection follow the caller org scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const whs = db.prepare(`SELECT w.id, w.org_id, o.path, o.parent_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id`).all()
  const whA = whs[0]
  const whB = whs.find((w) => !w.path.startsWith(whA.path) && !whA.path.startsWith(w.path) &&
    !w.path.startsWith(db.prepare('SELECT path FROM orgs WHERE id=?').get(whA.parent_id).path))
  assert.ok(whA && whB)
  const id = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid)
  const supplier = id("INSERT INTO suppliers (code,name) VALUES ('SX4','X4 supplier')")
  const receipt = (no, wh, amt) => {
    const rid = id(`INSERT INTO purchase_receipts (doc_no, supplier_id, warehouse_id, receipt_date, status, total_qty, total_amount) VALUES (?,?,?,date('now'),'received',1,?)`, no, supplier, wh.id, amt)
    id('INSERT INTO purchase_receipt_items (receipt_id, sku_id, qty, price, amount) VALUES (?,1,1,?,?)', rid, amt, amt)
    return rid
  }
  const rc = { A: receipt('GR-X4-A', whA, 100), B: receipt('GR-X4-B', whB, 200) }
  const inv = (no, org, amt) => id(`INSERT INTO purchase_invoices (doc_no, org_id, supplier_id, invoice_date, amount, tax_amount, total_amount, status) VALUES (?,?,?,date('now'),?,0,?,'verified')`, no, org, supplier, amt, amt)
  const pi = { A: inv('PI-X4-A', whA.org_id, 1000), B: inv('PI-X4-B', whB.org_id, 2000), N: inv('PI-X4-N', null, 4000) }
  const st = (no, org, amt, date) => id(`INSERT INTO purchase_settlements (doc_no, org_id, supplier_id, settle_date, settle_amount, paid_amount, diff_amount, status) VALUES (?,?,?,?,?,0,0,'audited')`, no, org, supplier, date, amt)
  const pst = { B: st('PST-X4-B', whB.org_id, 700, '2000-01-01'), N: st('PST-X4-N', null, 900, '2000-01-02'), A: st('PST-X4-A', whA.org_id, 500, '2000-01-03') }

  const wh = await f.account('x4_wh_a', 'purchase', { org_id: whA.org_id, data_scope: 'org' })
  const none = await f.account('x4_none', 'purchase', { data_scope: 'org' })
  const glob = await f.account('x4_glob', 'purchase', { data_scope: 'all' })

  await t.test('payment auto-allocation skips out-of-scope settlements', async () => {
    const p = okData(await api('/api/purchase/payments', { token: wh.token, body: { supplier_id: supplier, amount: 5000 } }))
    assert.deepEqual(p.items.map((x) => [x.settle_id, x.amount]), [[pst.A, 500]])
    assert.equal(p.settled_amount, 500)
    const n = okData(await api('/api/purchase/payments', { token: none.token, body: { supplier_id: supplier, amount: 5000 } }))
    assert.deepEqual(n.items, [])
    // 全局范围保持 FIFO：B、N 在前，A 在后
    const g = okData(await api('/api/purchase/payments', { token: glob.token, body: { supplier_id: supplier, amount: 1700 } }))
    assert.deepEqual(g.items.map((x) => [x.settle_id, x.amount]), [[pst.B, 700], [pst.N, 900], [pst.A, 100]])
    const a = okData(await api('/api/purchase/payments', { token: f.admin, body: { supplier_id: supplier, amount: 100 } }))
    assert.deepEqual(a.items.map((x) => x.settle_id), [pst.B])
  })

  await t.test('manual allocation to an out-of-scope settlement is 404 and writes nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM purchase_payments').get().c
    for (const target of [pst.B, pst.N]) {
      const r = await api('/api/purchase/payments', { token: wh.token, body: { supplier_id: supplier, amount: 50, allocations: [{ settle_id: target, amount: 50 }] } })
      assert.equal(r.status, 404, JSON.stringify(r.body))
    }
    assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_payments').get().c, before)
    const own = okData(await api('/api/purchase/payments', { token: wh.token, body: { supplier_id: supplier, amount: 50, allocations: [{ settle_id: pst.A, amount: 50 }] } }))
    assert.deepEqual(own.items.map((x) => x.settle_id), [pst.A])
    const gl = okData(await api('/api/purchase/payments', { token: glob.token, body: { supplier_id: supplier, amount: 50, allocations: [{ settle_id: pst.B, amount: 50 }] } }))
    assert.deepEqual(gl.items.map((x) => x.settle_id), [pst.B])
  })

  await t.test('settlement source selection only takes in-scope receipts and invoices', async () => {
    const empty = await api('/api/purchase/settlements', { token: none.token, body: { supplier_id: supplier } })
    assert.equal(empty.status, 409, JSON.stringify(empty.body))
    const s = okData(await api('/api/purchase/settlements', { token: wh.token, body: { supplier_id: supplier } }))
    const items = db.prepare('SELECT source_type, source_id FROM purchase_settlement_items WHERE settle_id=? ORDER BY id').all(s.id)
    assert.ok(items.length > 0)
    assert.ok(items.every((x) => x.source_type !== 'receipt' || x.source_id === rc.A), JSON.stringify(items))
    const head = db.prepare('SELECT receipt_amount, invoice_amount, settle_amount FROM purchase_settlements WHERE id=?').get(s.id)
    assert.equal(head.receipt_amount, 100)
    assert.equal(head.invoice_amount, 1000)
    assert.equal(head.settle_amount, 1000)
    const link = (k) => db.prepare('SELECT settle_id FROM purchase_invoices WHERE id=?').get(pi[k]).settle_id
    assert.equal(link('A'), s.id)
    assert.equal(link('B'), null)
    assert.equal(link('N'), null)

    // 全局范围拿到剩下的（B 的入库 + B、N 的发票），A 已被引用不重复
    const g = okData(await api('/api/purchase/settlements', { token: glob.token, body: { supplier_id: supplier } }))
    const gh = db.prepare('SELECT receipt_amount, invoice_amount FROM purchase_settlements WHERE id=?').get(g.id)
    assert.equal(gh.receipt_amount, 200)
    assert.equal(gh.invoice_amount, 6000)
  })
})
