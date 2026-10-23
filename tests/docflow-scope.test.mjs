/**
 * ============================================================================
 * 文件标识：tests/docflow-scope.test.mjs ｜ 测试：单据流读接口按账号数据范围过滤（ADR-0032）
 * ============================================================================
 * 【职责】守住 ADR-0032：`/api/docflow` 的 `/events`、`/overview`、`/history/:docType/:id`、`/trace`
 *   读的是跨所有单据类型的流转留痕，对 `data_scope=org|subtree` 的内部账号只返回「自己范围内单据」的事件：
 *     · 每个已注册 doc_types.code 在 `DOC_SCOPE_RESOLVERS` 有一行，表名一致、无陈旧项（守卫：缺项 ⇒ 对受限范围不可见）；
 *     · 采购 / 销售 / 订货中心 / POS 门店 / 仓库归属各取一型，期望集合用测试自己的 JOIN SQL 直算；
 *     · 全局类型（AR / RCP / VOUCHER / RFD / CA / OM）与未登记类型对受限范围不可见，admin / data_scope=all 可见；
 *     · `/overview` 的 events 计数、recent、distribution 都只统计范围内；
 *     · `/history` 范围外与不存在同形 404；`/trace` 不能经 payload 关联读到范围外事件；
 *     · 绑了门店的内部账号在 POS 类型上只限本店。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，
 *   事件直接写库（action='y2test'，便于隔离）。
 *
 * 【改它要注意什么】断言是「精确集合」，不是「比全库少」；新增 doc_types 而忘了登记，这里会红。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-docflow-scope-'))
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

test('DOC_SCOPE_RESOLVERS covers every registered doc type exactly (guard)', { timeout: 120000 }, async (t) => {
  const f = await server(t)
  {
    const { DOC_SCOPE_RESOLVERS, unmappedScopeDocTypes } = await import('../server/lib/docflow.js')
    await import('../server/lib/purchase.js')
    await import('../server/lib/sales-order.js')
    await import('../server/lib/order-center.js')
    const { registeredDocScopeBuilders } = await import('../server/lib/doc-scope-registry.js')
    const types = f.db.prepare('SELECT code, table_name FROM doc_types').all()
    assert.deepEqual(unmappedScopeDocTypes(f.db), [], 'every doc_types.code must have a DOC_SCOPE_RESOLVERS row')
    assert.deepEqual(Object.keys(DOC_SCOPE_RESOLVERS).filter((c) => !types.some((x) => x.code === c)), [], 'no stale resolver rows')
    assert.deepEqual(types.filter((x) => DOC_SCOPE_RESOLVERS[x.code].table !== x.table_name).map((x) => x.code), [], 'table names match doc_types')
    const generic = new Set(['org', 'warehouse', 'store', 'dealer', 'global'])
    const needed = [...new Set(Object.values(DOC_SCOPE_RESOLVERS).map((s) => s.builder))].filter((b) => !generic.has(b)).sort()
    assert.deepEqual(needed, ['order-center', 'purchase', 'sales'])
    for (const b of needed) assert.ok(registeredDocScopeBuilders().includes(b), `builder ${b} must be registered`)
    assert.ok(Object.isFrozen(DOC_SCOPE_RESOLVERS))
    // 每行的归属列真实存在于主表（谓词写错列名会在受限账号第一次读时 500，这里提前红）
    for (const [code, spec] of Object.entries(DOC_SCOPE_RESOLVERS)) {
      const cols = new Set(f.db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name))
      for (const c of spec.cols || []) assert.ok(cols.has(c), `${code}: column ${c} missing on ${spec.table}`)
      if (spec.builder === 'sales') assert.ok(spec.kind === 'delivery' ? cols.has('order_id') : cols.has('warehouse_id') && cols.has('store_id'), `${code}: sales columns for ${spec.kind}`)
      if (spec.builder === 'purchase') assert.ok(cols.has(spec.via === 'org' ? 'org_id' : 'warehouse_id'), `${code}: purchase ${spec.via} column`)
      if (spec.builder === 'order-center') assert.ok(cols.has('customer_id'), `${code}: customer_id`)
    }
  }
})

test('docflow reads are filtered by the caller data scope', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  const parentOrg = db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whA.org_id).parent_id
  assert.equal(db.prepare('SELECT parent_id FROM orgs WHERE id=?').get(whB.org_id).parent_id, parentOrg)
  // 门店：1 号店归属组织 S（不是 A / B）；2 号店归 B；3 号店也归 S（用来验证"绑了门店只限本店"）
  const store1 = db.prepare('SELECT id, org_id FROM stores WHERE id=1').get()
  assert.ok(![whA.org_id, whB.org_id].includes(store1.org_id))
  db.prepare('UPDATE stores SET org_id=? WHERE id=2').run(whB.org_id)
  db.prepare('UPDATE stores SET org_id=? WHERE id=3').run(store1.org_id)
  // 订货客户：1 号归 A，2 号归 B，3 号归 S
  db.prepare('UPDATE oc_customers SET org_id=? WHERE id=1').run(whA.org_id)
  db.prepare('UPDATE oc_customers SET org_id=? WHERE id=2').run(whB.org_id)
  db.prepare('UPDATE oc_customers SET org_id=? WHERE id=3').run(store1.org_id)

  const ids = (sql, ...a) => db.prepare(sql).all(...a).map((r) => r.id)
  const [po1, po2, po3, po4] = ids('SELECT id FROM purchase_orders ORDER BY id LIMIT 4')
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whA.id, po1)
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whB.id, po2)
  const whO = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH02'").get() // 另一个不在 parent 子树里的组织
  assert.ok(!db.prepare('SELECT id FROM orgs WHERE path LIKE (SELECT path||\'%\' FROM orgs WHERE id=?) OR id=?').all(parentOrg, parentOrg).some((r) => r.id === whO.org_id))
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whO.id, po3)
  db.prepare('UPDATE purchase_orders SET warehouse_id=? WHERE id=?').run(whA.id, po4)
  const [prq1, prq2, prq3] = ids('SELECT id FROM purchase_requisitions ORDER BY id LIMIT 3')
  db.prepare('UPDATE purchase_requisitions SET org_id=? WHERE id=?').run(whA.org_id, prq1)
  db.prepare('UPDATE purchase_requisitions SET org_id=? WHERE id=?').run(whB.org_id, prq2)
  db.prepare('UPDATE purchase_requisitions SET org_id=NULL WHERE id=?').run(prq3)
  const [so1, so2, so3] = ids('SELECT id FROM sales_orders ORDER BY id LIMIT 3')
  db.prepare('UPDATE sales_orders SET warehouse_id=?, store_id=NULL WHERE id=?').run(whA.id, so1)
  db.prepare('UPDATE sales_orders SET warehouse_id=?, store_id=NULL WHERE id=?').run(whB.id, so2)
  db.prepare('UPDATE sales_orders SET warehouse_id=NULL, store_id=1 WHERE id=?').run(so3) // 仅门店归属（S）
  const [oc1, oc2, oc3] = ids('SELECT id FROM oc_orders ORDER BY id LIMIT 3')
  db.prepare('UPDATE oc_orders SET customer_id=1 WHERE id=?').run(oc1)
  db.prepare('UPDATE oc_orders SET customer_id=2 WHERE id=?').run(oc2)
  db.prepare('UPDATE oc_orders SET customer_id=3 WHERE id=?').run(oc3)
  const ps = (store) => ids('SELECT id FROM pos_orders WHERE store_id=? ORDER BY id LIMIT 1', store)[0]
  const [ps1, ps2, ps3] = [ps(1), ps(2), ps(3)]
  const [tf] = ids('SELECT id FROM stock_transfers ORDER BY id LIMIT 1')
  db.prepare('UPDATE stock_transfers SET from_warehouse_id=?, to_warehouse_id=? WHERE id=?').run(whA.id, whB.id, tf)
  const [ar] = ids('SELECT id FROM ar_documents ORDER BY id LIMIT 1')

  const insEv = db.prepare(`INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,to_state,source,payload_json,created_at)
    VALUES (?,?,?,'y2test','y2test','x','api',?,datetime('now','localtime'))`)
  const ev = (type, id, no, payload = null) => Number(insEv.run(type, id, no, payload).lastInsertRowid)
  const E = {}
  E.poA = ev('PO', po1, 'Y2-PO-A')
  E.poB = ev('PO', po2, 'Y2-PO-B')
  E.poO = ev('PO', po3, 'Y2-PO-O')
  E.poA2 = ev('PO', po4, 'Y2-PO-A2')
  E.prqA = ev('PRQ', prq1, 'Y2-PRQ-A')
  E.prqB = ev('PRQ', prq2, 'Y2-PRQ-B')
  E.prqN = ev('PRQ', prq3, 'Y2-PRQ-N')
  E.soA = ev('SO', so1, 'Y2-SO-A')
  E.soB = ev('SO', so2, 'Y2-SO-B')
  E.soS = ev('SO', so3, 'Y2-SO-S')
  E.ocA = ev('OC', oc1, 'Y2-OC-A')
  E.ocB = ev('OC', oc2, 'Y2-OC-B')
  E.ocS = ev('OC', oc3, 'Y2-OC-S')
  E.ps1 = ev('PS', ps1, 'Y2-PS-1')
  E.ps2 = ev('PS', ps2, 'Y2-PS-2')
  E.ps3 = ev('PS', ps3, 'Y2-PS-3')
  E.tf = ev('TF', tf, 'Y2-TF')
  E.ar = ev('AR', ar, 'Y2-AR')
  for (const g of ['RCP', 'VOUCHER', 'RFD', 'CA', 'OM']) E[`g${g}`] = ev(g, 1, `Y2-${g}`)
  E.zz = ev('ZZ', 1, 'Y2-ZZ') // 未登记类型
  E.nullDoc = ev('PO', null, 'Y2-NULLDOC')
  E.orphan = ev('PO', 99999, 'Y2-ORPHAN')
  // 交叉引用：B 的订单事件在 payload 里提到 A 的单号（联查泄漏向量）
  E.leak = ev('PO', po2, 'Y2-PO-B', JSON.stringify({ related: 'Y2-PO-A', note: 'see Y2-PO-A' }))
  E.leakA = ev('PO', po1, 'Y2-PO-A', JSON.stringify({ related: 'Y2-PO-B' }))

  const mine = (r) => okData(r).list.filter((x) => x.action === 'y2test').map((x) => x.id).sort((a, b) => a - b)
  const events = (tk, q = '') => api(`/api/docflow/events?action=y2test&pageSize=500${q}`, { token: tk })
  const want = (...keys) => keys.flatMap((k) => (Array.isArray(E[k]) ? E[k] : [E[k]])).sort((a, b) => a - b)
  const all = Object.values(E).sort((a, b) => a - b)

  const accountA = await f.account('y2_a', 'sales', { org_id: whA.org_id, data_scope: 'org' })
  const accountB = await f.account('y2_b', 'sales', { org_id: whB.org_id, data_scope: 'org' })
  const accountS = await f.account('y2_s', 'sales', { org_id: store1.org_id, data_scope: 'org' })
  const accountSub = await f.account('y2_sub', 'sales', { org_id: parentOrg, data_scope: 'subtree' })
  const accountNone = await f.account('y2_none', 'sales', { data_scope: 'org' })
  const accountAll = await f.account('y2_all', 'sales', { data_scope: 'all' })
  const accountBound = await f.account('y2_bound', 'sales', { org_id: store1.org_id, data_scope: 'org', store_id: 1 })

  await t.test('admin and data_scope=all see every event, including global, unmapped and orphan rows; anonymous is 401', async () => {
    for (const tk of [f.admin, accountAll.token]) assert.deepEqual(mine(await events(tk)), all)
    for (const route of ['/api/docflow/events', '/api/docflow/overview', '/api/docflow/history/PO/1', '/api/docflow/trace?doc_no=x']) {
      assert.equal((await api(route)).status, 401, route)
    }
  })

  await t.test('org-A account: purchase / sales / order-center / warehouse-owned events of org A only', async () => {
    // A 的两张 PO（po1 / po4）、PRQ-A、SO-A、OC-A、调拨（A 仓出）、联查泄漏向量里属于 A 的那条
    assert.deepEqual(mine(await events(accountA.token)), want('poA', 'poA2', 'prqA', 'soA', 'ocA', 'tf', 'leakA'))
  })

  await t.test('org-B account: B documents; the transfer is visible to both ends; NULL owners never', async () => {
    assert.deepEqual(mine(await events(accountB.token)), want('poB', 'prqB', 'soB', 'ocB', 'ps2', 'tf', 'leak'))
  })

  await t.test('store-org account: its own store orders, store-owned sales order, store customer; both its stores', async () => {
    assert.deepEqual(mine(await events(accountS.token)), want('soS', 'ocS', 'ps1', 'ps3'))
  })

  await t.test('a store-bound internal account is limited to its own store on POS types', async () => {
    assert.deepEqual(mine(await events(accountBound.token)), want('soS', 'ocS', 'ps1'))
  })

  await t.test('subtree at the parent sees A + B + S documents, never NULL-owner, global, unmapped, orphan or null-doc rows', async () => {
    const got = mine(await events(accountSub.token))
    assert.deepEqual(got, want('poA', 'poA2', 'poB', 'prqA', 'prqB', 'soA', 'soB', 'soS', 'ocA', 'ocB', 'ocS', 'ps1', 'ps2', 'ps3', 'tf', 'leak', 'leakA'))
    for (const k of ['poO', 'prqN', 'ar', 'gRCP', 'gVOUCHER', 'gRFD', 'gCA', 'gOM', 'zz', 'nullDoc', 'orphan']) assert.ok(!got.includes(E[k]), k)
  })

  await t.test('an org-scoped account without an org sees nothing (empty scope never widens)', async () => {
    assert.deepEqual(mine(await events(accountNone.token)), [])
    const r = okData(await api('/api/docflow/events?pageSize=500', { token: accountNone.token }))
    assert.equal(r.total, 0)
  })

  await t.test('filters compose with the scope (doc_type / source / action cannot widen it)', async () => {
    assert.deepEqual(mine(await events(accountA.token, '&doc_type=PO')), want('poA', 'poA2', 'leakA'))
    assert.deepEqual(mine(await events(accountA.token, '&doc_type=AR')), [])
    assert.deepEqual(mine(await events(accountA.token, '&doc_type=ZZ')), [])
    assert.equal(okData(await api('/api/docflow/events?doc_type=AR&pageSize=500', { token: accountA.token })).total, 0)
  })

  await t.test('total / paging use the scoped set', async () => {
    const oracle = db.prepare(`SELECT COUNT(*) c FROM doc_events e
      WHERE (e.doc_type='PO' AND e.doc_id IN (SELECT p.id FROM purchase_orders p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=?))`).get(whA.org_id).c
    const r = okData(await api('/api/docflow/events?doc_type=PO&pageSize=3', { token: accountA.token }))
    assert.equal(r.total, oracle)
    assert.ok(r.list.length <= 3)
  })

  await t.test('overview: events / recent / distribution cover the scoped set only', async () => {
    const adminOv = okData(await api('/api/docflow/overview', { token: f.admin }))
    assert.equal(adminOv.events, db.prepare('SELECT COUNT(*) c FROM doc_events').get().c)
    const dist = (ov, code) => ov.distribution.find((d) => d.docType === code)
    assert.equal(dist(adminOv, 'AR').total, db.prepare('SELECT COUNT(*) c FROM ar_documents').get().c)

    const ov = okData(await api('/api/docflow/overview', { token: accountA.token }))
    // 期望值：测试自己的"类型 → JOIN 写法"表（与被测的相关子查询 / 分发表是两份独立表述）
    const orgId = whA.org_id
    const sets = []
    const viaOrg = (type, table, col = 'org_id') => sets.push([type, `SELECT id FROM ${table} WHERE ${col}=?`, [orgId]])
    const viaJoin = (type, table, cols, join) => sets.push([type, cols.map((c) => `SELECT t.id FROM ${table} t JOIN ${join} j ON j.id=t.${c} WHERE j.org_id=?`).join(' UNION '), cols.map(() => orgId)])
    for (const [ty, tb] of [['PRQ', 'purchase_requisitions'], ['PI', 'purchase_invoices'], ['PST', 'purchase_settlements'], ['PAY', 'purchase_payments'], ['SI', 'sales_invoices'], ['QCR', 'qc_requests']]) viaOrg(ty, tb)
    for (const [ty, tb, cols] of [['PO', 'purchase_orders', ['warehouse_id']], ['GR', 'purchase_receipts', ['warehouse_id']], ['PRT', 'purchase_returns', ['warehouse_id']],
      ['INS', 'purchase_inspections', ['warehouse_id']], ['TF', 'stock_transfers', ['from_warehouse_id', 'to_warehouse_id']], ['CK', 'stock_checks', ['warehouse_id']],
      ['AS', 'assembly_orders', ['warehouse_id']], ['MO', 'production_orders', ['warehouse_id']], ['MR', 'material_issues', ['warehouse_id']], ['WW', 'outsourcing_orders', ['warehouse_id']],
      ['WM', 'outsourcing_materials', ['warehouse_id']], ['WR', 'outsourcing_receipts', ['warehouse_id']], ['QCI', 'qc_inspections', ['warehouse_id']], ['DH', 'qc_defect_handlings', ['warehouse_id']]]) viaJoin(ty, tb, cols, 'warehouses')
    for (const [ty, tb] of [['PS', 'pos_orders'], ['PSF', 'pos_shifts'], ['RC', 'pos_daily_closes'], ['YQ', 'store_requisitions'], ['SH', 'store_shipments']]) viaJoin(ty, tb, ['store_id'], 'stores')
    for (const [ty, tb] of [['DR', 'dealer_requisitions'], ['DS', 'dealer_statements'], ['RB', 'dealer_rebates']]) viaJoin(ty, tb, ['dealer_id'], 'dealers')
    const partyIn = `(SELECT o.id FROM sales_orders o LEFT JOIN warehouses w ON w.id=o.warehouse_id LEFT JOIN stores s ON s.id=o.store_id WHERE w.org_id=? OR s.org_id=?)`
    sets.push(['SO', `SELECT o.id FROM sales_orders o LEFT JOIN warehouses w ON w.id=o.warehouse_id LEFT JOIN stores s ON s.id=o.store_id WHERE w.org_id=? OR s.org_id=?`, [orgId, orgId]])
    sets.push(['QT', `SELECT q.id FROM sales_quotes q LEFT JOIN warehouses w ON w.id=q.warehouse_id LEFT JOIN stores s ON s.id=q.store_id WHERE w.org_id=? OR s.org_id=?`, [orgId, orgId]])
    sets.push(['DL', `SELECT d.id FROM sales_deliveries d WHERE d.order_id IN ${partyIn}`, [orgId, orgId]])
    sets.push(['SR', `SELECT r.id FROM sales_returns r LEFT JOIN warehouses w ON w.id=r.warehouse_id LEFT JOIN stores s ON s.id=r.store_id
      WHERE CASE WHEN r.order_id IS NOT NULL THEN r.order_id IN ${partyIn} ELSE (w.org_id=? OR s.org_id=?) END`, [orgId, orgId, orgId, orgId]])
    sets.push(['OC', `SELECT o.id FROM oc_orders o JOIN oc_customers c ON c.id=o.customer_id LEFT JOIN oc_customers p ON p.id=c.parent_customer_id WHERE COALESCE(c.org_id,p.org_id)=?`, [orgId]])
    sets.push(['OCS', `SELECT o.id FROM oc_statements o JOIN oc_customers c ON c.id=o.customer_id LEFT JOIN oc_customers p ON p.id=c.parent_customer_id WHERE COALESCE(c.org_id,p.org_id)=?`, [orgId]])
    let evOracle = 0
    for (const [type, sql, args] of sets) {
      evOracle += db.prepare(`SELECT COUNT(*) c FROM doc_events WHERE doc_type=? AND doc_id IN (${sql})`).get(type, ...args).c
    }
    assert.ok(evOracle > 0)
    assert.equal(ov.events, evOracle)
    assert.ok(ov.events < adminOv.events)
    assert.ok(ov.recent.length <= 12)
    assert.ok(ov.recent.every((r) => !['AR', 'RCP', 'VOUCHER', 'RFD', 'CA', 'OM', 'ZZ'].includes(r.doc_type)))
    // distribution：全局类型整类不出现；受限类型的 total 等于范围内行数
    for (const g of ['AR', 'RCP', 'VOUCHER', 'RFD', 'CA', 'OM']) assert.equal(dist(ov, g), undefined, g)
    const poOracle = db.prepare('SELECT COUNT(*) c FROM purchase_orders p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.org_id=?').get(whA.org_id).c
    assert.equal(dist(ov, 'PO').total, poOracle)
    const ocOracle = db.prepare(`SELECT COUNT(*) c FROM oc_orders o JOIN oc_customers c ON c.id=o.customer_id
      LEFT JOIN oc_customers p ON p.id=c.parent_customer_id WHERE COALESCE(c.org_id,p.org_id)=?`).get(whA.org_id).c
    assert.equal(dist(ov, 'OC').total, ocOracle)
    // 无范围账号：计数为 0、分布为空、recent 为空
    const none = okData(await api('/api/docflow/overview', { token: accountNone.token }))
    assert.equal(none.events, 0)
    assert.deepEqual(none.recent, [])
    assert.deepEqual(none.distribution, [])
  })

  await t.test('history: out-of-scope and nonexistent documents are the same 404; in-scope returns its events', async () => {
    const own = okData(await api(`/api/docflow/history/PO/${po1}`, { token: accountA.token }))
    assert.deepEqual(own.filter((x) => x.action === 'y2test').map((x) => x.id).sort((a, b) => a - b), want('poA', 'leakA'))
    const other = await api(`/api/docflow/history/PO/${po2}`, { token: accountA.token })
    const missing = await api('/api/docflow/history/PO/987654', { token: accountA.token })
    const nullOwner = await api(`/api/docflow/history/PO/${po3}`, { token: accountA.token })
    const global = await api(`/api/docflow/history/AR/${ar}`, { token: accountA.token })
    const unknownType = await api('/api/docflow/history/NOPE/1', { token: accountA.token })
    for (const r of [other, missing, nullOwner, global]) assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual(other.body, missing.body, 'out-of-scope must look exactly like nonexistent')
    assert.equal(unknownType.status, 404)
    assert.equal((await api(`/api/docflow/history/PO/${po3}`, { token: f.admin })).status, 200) // 全局范围：NULL 归属可见
    assert.equal((await api(`/api/docflow/history/AR/${ar}`, { token: f.admin })).status, 200)
    assert.equal((await api(`/api/docflow/history/PO/${po2}`, { token: accountNone.token })).status, 404)
    assert.equal((await api(`/api/docflow/history/PO/${po2}`, { token: accountB.token })).status, 200)
  })

  await t.test('trace: scoped on both the doc_no hit and the payload-related hit', async () => {
    const ids = (r) => okData(r).filter((x) => x.action === 'y2test').map((x) => x.id).sort((a, b) => a - b)
    // A 联查自己的单号：B 的事件 leak 在 payload 里提到 Y2-PO-A，但它属于 B ⇒ 不得出现
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-PO-A', { token: accountA.token })), want('poA', 'leakA'))
    // A 联查 B 的单号：命中事件属于 B；payload 关联里 leakA 属于 A（可见）
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-PO-B', { token: accountA.token })), want('leakA'))
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-PO-A', { token: accountB.token })), want('leak'))
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-AR', { token: accountA.token })), [])
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-ZZ', { token: accountSub.token })), [])
    assert.deepEqual(ids(await api('/api/docflow/trace?doc_no=Y2-PO-A', { token: f.admin })), want('poA', 'leak', 'leakA'))
    assert.equal((await api('/api/docflow/trace', { token: accountA.token })).status, 400)
  })

  await t.test('external principals stay blocked by requireInternal (dealer / store roles)', async () => {
    const dealer = await f.account('y2_dealer', 'dealer', { dealer_id: 1 })
    const store = await f.account('y2_store', 'store', { store_id: 1 })
    for (const who of [dealer, store]) {
      for (const route of ['/api/docflow/events', '/api/docflow/overview', '/api/docflow/history/PO/1', '/api/docflow/trace?doc_no=x']) {
        assert.equal((await api(route, { token: who.token })).status, 403, `${who.username} ${route}`)
      }
    }
  })
})
