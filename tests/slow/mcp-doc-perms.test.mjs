// slow: 93 s: per-document-type MCP token scope matrix over a real server (scripts/test-timings.mjs, threshold 60 s)
// X5（ADR-0011 补充）：通用单据读工具 doc.query / doc.get / doc.list_types 按「单据类型」校验令牌所有者当前的查看权限点。
//   · 映射表覆盖全部在用单据类型，且权限点真实存在；采购链与 HTTP 的 PO_READ_PERMS 同源；
//   · 所有者缺该类型的查看权限 → TOKEN_OWNER_PERM_DENIED（query/get），list_types 不列出该类型；
//   · 未映射类型一律拒绝（DOC_TYPE_UNMAPPED），并且不出现在 list_types；
//   · 无主令牌（独立服务主体）读已映射类型不受影响。
// 只在全新临时数据目录 + 随机回环端口上跑（GML_RUNTIME_MODE=test 才开放 MCP）。
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
import { createToken } from '../../server/mcp/tokens.js'
import { DOC_VIEW_PERMS, viewPermsOf, bindingOf } from '../../server/mcp/doc-perms.js'
import { PO_READ_PERMS } from '../../server/lib/purchase.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-docperms-'))
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
  const api = async (route, { token, body } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    })
    return { status: res.status, body: await res.json() }
  }
  let seq = 0
  const mcp = async (method, params, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal: AbortSignal.timeout(10000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { dir, api, mcp, db }
}

const toolText = (r) => {
  const text = r.body?.result?.content?.[0]?.text
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return text }
}
const toolErr = (r) => (r.body?.result?.isError ? toolText(r)?.error : null)
const okTool = (r) => !r.body?.error && r.body?.result?.isError !== true

test('doc view permission map covers every active doc type with real permission codes', async (t) => {
  const { db } = await server(t)
  const types = db.prepare("SELECT code FROM doc_types WHERE status='active'").all().map((r) => r.code)
  assert.ok(types.length >= 30, `expected the full doc type set, got ${types.length}`)
  const unmapped = types.filter((c) => !viewPermsOf(c))
  assert.deepEqual(unmapped, [], 'every active doc type must declare a view permission')
  const known = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code))
  for (const [code, e] of Object.entries(DOC_VIEW_PERMS)) {
    assert.ok(e.perms.length > 0, `${code}: empty perms list means nobody may view`)
    for (const p of e.perms) assert.ok(known.has(p), `${code}: unknown permission code ${p}`)
  }
  assert.deepEqual(DOC_VIEW_PERMS.PO.perms, PO_READ_PERMS, 'PO must share the HTTP read permission set')
  // purchase-chain.js 的 readGate 对 PRQ/PO/GR/PRT/PI/PST/PAY 全部读路由一视同仁
  for (const c of ['GR', 'PRT', 'PRQ', 'PI', 'PST', 'PAY']) assert.deepEqual(DOC_VIEW_PERMS[c].perms, PO_READ_PERMS, c)
  // Codex 审计指出的三处与 HTTP 不一致（qc2.js / manufacture.js）
  assert.deepEqual(DOC_VIEW_PERMS.QCI.perms, ['quality.qc.view'])
  assert.deepEqual(DOC_VIEW_PERMS.DH.perms, ['quality.qc.view'])
  assert.deepEqual(DOC_VIEW_PERMS.MO.perms, ['produce.bom.view'])
  assert.deepEqual(DOC_VIEW_PERMS.MR.perms, ['produce.bom.view'])
  assert.deepEqual(DOC_VIEW_PERMS.VOUCHER.perms, ['finance.voucher.view'])
  const stale = Object.keys(DOC_VIEW_PERMS).filter((c) => !types.includes(c))
  assert.deepEqual(stale, [], 'mapping must not carry types that no longer exist')
})

test('doc.query / doc.get / doc.list_types honour the owner view permission per doc type', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  assert.ok(admin, 'demo admin must log in')
  const owner = (await api('/api/auth/users', { token: admin, body: { username: 'docperm_owner', name: 'Doc perm owner', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
  assert.equal(owner.success, true, JSON.stringify(owner))
  const ownerId = owner.data.id
  const token = createToken(db, { name: 'docperm', ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read' }).token
  const free = createToken(db, { name: 'docperm-free', industry: 'cosmetic', scopes: 'read' }).token

  const setPerms = (codes) => {
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse'").run()
    const ins = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?,?)')
    for (const c of codes) ins.run('warehouse', c)
  }
  const call = (name, args, tk = token) => mcp('tools/call', { name, arguments: args }, tk)
  const listedCodes = async (tk = token) => {
    const r = await call('doc.list_types', {}, tk)
    return okTool(r) ? toolText(r).doc_types.map((x) => x.code) : null
  }
  const doc = (code) => {
    const t2 = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(code)
    return db.prepare(`SELECT * FROM ${t2.table_name} ORDER BY id LIMIT 1`).get()
  }
  const po = doc('PO')
  const voucher = doc('VOUCHER')
  assert.ok(po && voucher, 'demo data must have a purchase order and a voucher')

  await t.test('owner with only purchase.order.view reads PO but not VOUCHER', async () => {
    setPerms(['purchase.order.view'])
    assert.ok(okTool(await call('doc.get', { doc_type: 'PO', id: po.id })))
    assert.ok(okTool(await call('doc.query', { doc_type: 'PO' })))
    assert.ok(okTool(await call('doc.query', { doc_type: 'GR' })), 'GR shares the PO read permission set')
    const g = await call('doc.get', { doc_type: 'VOUCHER', id: voucher.id })
    assert.equal(toolErr(g), 'TOKEN_OWNER_PERM_DENIED', JSON.stringify(g.body).slice(0, 300))
    const q = await call('doc.query', { doc_type: 'VOUCHER' })
    assert.equal(toolErr(q), 'TOKEN_OWNER_PERM_DENIED')
    const codes = await listedCodes()
    assert.ok(codes.includes('PO') && codes.includes('GR') && codes.includes('PRT'))
    assert.ok(!codes.includes('VOUCHER') && !codes.includes('RCP') && !codes.includes('SO'))
  })

  await t.test('the denial does not depend on whether the document exists (no existence oracle)', async () => {
    setPerms(['purchase.order.view'])
    const real = await call('doc.get', { doc_type: 'VOUCHER', id: voucher.id })
    const fake = await call('doc.get', { doc_type: 'VOUCHER', id: 99999999 })
    assert.equal(toolErr(real), 'TOKEN_OWNER_PERM_DENIED')
    assert.equal(toolErr(fake), 'TOKEN_OWNER_PERM_DENIED')
    const byNo = await call('doc.get', { doc_type: 'VOUCHER', doc_no: 'nope' })
    assert.equal(toolErr(byNo), 'TOKEN_OWNER_PERM_DENIED')
  })

  await t.test('permission is re-read on every call; granting a type permission opens exactly that type', async () => {
    setPerms(['purchase.order.view'])
    assert.equal(toolErr(await call('doc.query', { doc_type: 'VOUCHER' })), 'TOKEN_OWNER_PERM_DENIED')
    setPerms(['purchase.order.view', 'finance.voucher.view'])
    assert.ok(okTool(await call('doc.query', { doc_type: 'VOUCHER' })))
    assert.ok(okTool(await call('doc.get', { doc_type: 'VOUCHER', id: voucher.id })))
    assert.equal(toolErr(await call('doc.query', { doc_type: 'RCP' })), 'TOKEN_OWNER_PERM_DENIED')
    assert.ok((await listedCodes()).includes('VOUCHER'))
  })

  await t.test('any-of semantics: purchase.inbound alone is enough for the PO family (same as HTTP)', async () => {
    setPerms(['purchase.inbound'])
    assert.ok(okTool(await call('doc.query', { doc_type: 'PO' })))
    // 采购链全部读路由共用 PO_READ_PERMS：PI 同样放行；财务凭证仍拒绝
    assert.ok(okTool(await call('doc.query', { doc_type: 'PI' })))
    assert.equal(toolErr(await call('doc.query', { doc_type: 'VOUCHER' })), 'TOKEN_OWNER_PERM_DENIED')
  })

  await t.test('HTTP parity: per-document view codes that HTTP does not accept are not accepted by MCP either', async () => {
    setPerms(['purchase.invoice.view', 'purchase.req.view', 'purchase.settle.view', 'purchase.payment.view'])
    for (const c of ['PI', 'PRQ', 'PST', 'PAY']) assert.equal(toolErr(await call('doc.query', { doc_type: c })), 'TOKEN_OWNER_PERM_DENIED', c)
    setPerms(['quality.inspect.view', 'produce.order.view'])
    for (const c of ['QCI', 'DH', 'MO', 'MR']) assert.equal(toolErr(await call('doc.query', { doc_type: c })), 'TOKEN_OWNER_PERM_DENIED', c)
    assert.ok(okTool(await call('doc.query', { doc_type: 'INS' })), 'INS is served by qc.js with quality.inspect.view')
    setPerms(['quality.qc.view', 'produce.bom.view'])
    for (const c of ['QCI', 'DH', 'MO', 'MR']) assert.ok(okTool(await call('doc.query', { doc_type: c })), c)
  })

  await t.test('external owners (store / dealer) cannot read HQ-internal types even with the permission code', async () => {
    const ext = (await api('/api/auth/users', { token: admin, body: { username: 'docperm_store', name: 'Doc perm store', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
    assert.equal(ext.success, true, JSON.stringify(ext))
    db.prepare("UPDATE users SET role='store' WHERE id=?").run(ext.data.id)
    const extToken = createToken(db, { name: 'docperm-store', ownerUserId: ext.data.id, industry: 'cosmetic', scopes: 'read' }).token
    db.prepare("DELETE FROM role_permissions WHERE role_code='store'").run()
    for (const c of ['purchase.order.view', 'oms.order.view', 'dms.dealer.view', 'finance.voucher.view']) db.prepare("INSERT INTO role_permissions (role_code, perm_code) VALUES ('store',?)").run(c)
    for (const c of ['PO', 'OM', 'DS', 'VOUCHER']) assert.equal(toolErr(await call('doc.query', { doc_type: c }, extToken)), 'TOKEN_OWNER_PERM_DENIED', c)
    const r = await call('doc.list_types', {}, extToken)
    const listed = okTool(r) ? toolText(r).doc_types.map((x) => x.code) : []
    for (const c of ['PO', 'OM', 'DS', 'VOUCHER']) assert.ok(!listed.includes(c), `${c} must not be listed for an external owner`)
  })

  await t.test('owner with no view permission at all: query/get denied, list_types denied', async () => {
    setPerms([])
    assert.equal(toolErr(await call('doc.query', { doc_type: 'PO' })), 'TOKEN_OWNER_PERM_DENIED')
    assert.equal(toolErr(await call('doc.get', { doc_type: 'PO', id: po.id })), 'TOKEN_OWNER_PERM_DENIED')
    assert.equal(toolErr(await call('doc.list_types', {})), 'TOKEN_OWNER_PERM_DENIED')
  })

  await t.test('unknown type keeps its own error; unmapped type is denied and hidden from list_types', async () => {
    setPerms(['purchase.order.view'])
    assert.equal(toolErr(await call('doc.query', { doc_type: 'NOPE' })), 'BAD_DOC_TYPE')
    db.prepare("INSERT INTO doc_types (code,name,module,table_name) VALUES ('X5P','X5 probe','probe','purchase_orders')").run()
    try {
      assert.equal(toolErr(await call('doc.query', { doc_type: 'X5P' })), 'DOC_TYPE_UNMAPPED')
      assert.equal(toolErr(await call('doc.get', { doc_type: 'X5P', id: po.id })), 'DOC_TYPE_UNMAPPED')
      assert.ok(!(await listedCodes()).includes('X5P'))
      // 无主令牌对未映射类型同样拒绝（fail-closed）
      assert.equal(toolErr(await call('doc.query', { doc_type: 'X5P' }, free)), 'DOC_TYPE_UNMAPPED')
      assert.ok(!(await listedCodes(free)).includes('X5P'))
    } finally {
      db.prepare("DELETE FROM doc_types WHERE code='X5P'").run()
    }
  })

  await t.test('ownerless token keeps reading mapped types (no owner to compare against)', async () => {
    setPerms([])
    assert.ok(okTool(await call('doc.query', { doc_type: 'VOUCHER' }, free)))
    assert.ok(okTool(await call('doc.get', { doc_type: 'PO', id: po.id }, free)))
    const codes = await listedCodes(free)
    assert.ok(codes.includes('VOUCHER') && codes.includes('PO'))
  })
})

// Y6（ADR-0011 补充）：HTTP 侧按门店 / 经销商 / 订货主体绑定的单据类型，MCP 同样要求所有者有绑定、且单据属于该绑定对象。
// 绑定表（与 HTTP 逐一核对，见 ADR）：PS/PSF/RC/YQ/SH → store_id；DR → dealer_id；OC/OCS → 订货主体（customer_id）。
// DS/RB 的 HTTP（dealers.js / dms.js）整体 requireInternal 的总部读，无绑定自视图，故不声明绑定。
const BOUND = {
  PS: ['store', 'store_id'], PSF: ['store', 'store_id'], RC: ['store', 'store_id'], YQ: ['store', 'store_id'], SH: ['store', 'store_id'],
  DR: ['dealer', 'dealer_id'], OC: ['subject', 'customer_id'], OCS: ['subject', 'customer_id']
}

test('Y6 binding table is declared exactly once, in doc-perms, and its columns exist', async (t) => {
  const { db } = await server(t)
  for (const [code, [binding, col]] of Object.entries(BOUND)) {
    assert.deepEqual(bindingOf(code), { binding, col }, code)
    const tn = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(code).table_name
    assert.ok(db.prepare(`PRAGMA table_info(${tn})`).all().some((c) => c.name === col), `${code}: ${tn}.${col} must exist`)
  }
  for (const c of Object.keys(DOC_VIEW_PERMS)) if (!BOUND[c]) assert.equal(bindingOf(c), null, `${c} must not carry a binding`)
  assert.equal(bindingOf('DS'), null, 'DS/RB are HQ-only on HTTP (requireInternal), no self view to bind')
  assert.equal(bindingOf('RB'), null)
})

test('Y6 bound doc types: owner without binding is denied; with binding sees only its own store/dealer/subject', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  const mk = async (username, role) => {
    const r = (await api('/api/auth/users', { token: admin, body: { username, name: username, role, password: secret(), data_scope: 'all' } })).body
    assert.equal(r.success, true, JSON.stringify(r))
    return r.data.id
  }
  const ownerId = await mk('y6_owner', 'warehouse')
  const token = createToken(db, { name: 'y6', ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read' }).token
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id
  const adminTok = createToken(db, { name: 'y6-admin', ownerUserId: adminId, industry: 'cosmetic', scopes: 'read' }).token
  const free = createToken(db, { name: 'y6-free', industry: 'cosmetic', scopes: 'read' }).token
  const call = (name, args, tk = token) => mcp('tools/call', { name, arguments: args }, tk)
  const grant = (role, codes) => {
    db.prepare('DELETE FROM role_permissions WHERE role_code=?').run(role)
    const ins = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?,?)')
    for (const c of new Set(codes)) ins.run(role, c)
  }
  const allBoundPerms = Object.keys(BOUND).flatMap((c) => DOC_VIEW_PERMS[c].perms)
  grant('warehouse', allBoundPerms)
  const tableOf = (c) => db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(c).table_name
  const ids = (r) => toolText(r).rows.map((x) => x.id)
  const rowsOf = (c, id) => db.prepare(`SELECT * FROM ${tableOf(c)} WHERE id=?`).get(id)
  const setBind = (id, { store = null, dealer = null }) => db.prepare('UPDATE users SET store_id=?, dealer_id=? WHERE id=?').run(store, dealer, id)

  await t.test('no binding: query/get denied with TOKEN_OWNER_BINDING_REQUIRED and hidden from list_types; unbound types unaffected', async () => {
    setBind(ownerId, {})
    // OC/OCS 是订货主体绑定：内部账号 HTTP 口径是组织范围，不要求绑定（下面单独的子测试覆盖外部主体）
    const hard = Object.keys(BOUND).filter((c) => BOUND[c][0] !== 'subject')
    for (const c of hard) {
      const any = db.prepare(`SELECT id FROM ${tableOf(c)} ORDER BY id LIMIT 1`).get()
      assert.ok(any, `${c}: demo data must have a row`)
      assert.equal(toolErr(await call('doc.query', { doc_type: c })), 'TOKEN_OWNER_BINDING_REQUIRED', `query ${c}`)
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: any.id })), 'TOKEN_OWNER_BINDING_REQUIRED', `get ${c}`)
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: 99999999 })), 'TOKEN_OWNER_BINDING_REQUIRED', `get fake ${c} (no existence oracle)`)
    }
    grant('warehouse', [...allBoundPerms, 'purchase.order.view'])
    const r = await call('doc.list_types', {})
    const codes = toolText(r).doc_types.map((x) => x.code)
    for (const c of hard) assert.ok(!codes.includes(c), `${c} must be hidden for an unbound owner`)
    assert.ok(codes.includes('PO'), 'unbound types keep working')
    assert.ok(okTool(await call('doc.query', { doc_type: 'PO' })))
    grant('warehouse', allBoundPerms)
  })

  await t.test('store binding: only own-store rows, other store is NOT_FOUND, binding is re-read each call', async () => {
    for (const c of ['PS', 'PSF', 'RC', 'YQ', 'SH']) {
      const tn = tableOf(c)
      const stores = db.prepare(`SELECT store_id, COUNT(*) n FROM ${tn} GROUP BY store_id HAVING store_id IS NOT NULL ORDER BY n DESC`).all()
      assert.ok(stores.length >= 2, `${c}: demo data needs two stores with documents`)
      const [mine, other] = stores
      setBind(ownerId, { store: mine.store_id })
      const q = await call('doc.query', { doc_type: c, limit: 100 })
      assert.ok(okTool(q), `${c} ${JSON.stringify(q.body).slice(0, 200)}`)
      const got = ids(q)
      assert.ok(got.length > 0, `${c}: own store has rows`)
      assert.ok(got.every((id) => rowsOf(c, id).store_id === mine.store_id), `${c}: every row belongs to store ${mine.store_id}`)
      assert.equal(got.length, Math.min(mine.n, 100), `${c}: filter is pushed into SQL, not applied after a 3x over-fetch`)
      const own = db.prepare(`SELECT id FROM ${tn} WHERE store_id=? ORDER BY id LIMIT 1`).get(mine.store_id)
      const foreign = db.prepare(`SELECT id, ${db.prepare('SELECT doc_no_field f FROM doc_types WHERE code=?').get(c).f || 'doc_no'} AS dn FROM ${tn} WHERE store_id=? ORDER BY id LIMIT 1`).get(other.store_id)
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: own.id })), `${c} own get`)
      const g = await call('doc.get', { doc_type: c, id: foreign.id })
      assert.equal(toolErr(g), 'NOT_FOUND', `${c}: other store's document reads as not found`)
      assert.equal(toolErr(await call('doc.get', { doc_type: c, doc_no: foreign.dn })), 'NOT_FOUND', `${c} by doc_no`)
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: 99999999 })), 'NOT_FOUND', `${c}: same code as a real foreign doc`)
      // 换成另一家门店 → 立即换范围；撤掉绑定 → 立即拒绝
      setBind(ownerId, { store: other.store_id })
      assert.ok(ids(await call('doc.query', { doc_type: c, limit: 100 })).every((id) => rowsOf(c, id).store_id === other.store_id))
      setBind(ownerId, {})
      assert.equal(toolErr(await call('doc.query', { doc_type: c })), 'TOKEN_OWNER_BINDING_REQUIRED')
    }
    setBind(ownerId, { store: 1 })
    const listed = toolText(await call('doc.list_types', {})).doc_types.map((x) => x.code)
    for (const c of ['PS', 'PSF', 'RC', 'YQ', 'SH']) assert.ok(listed.includes(c), `${c} listed once the owner is bound`)
    assert.ok(!listed.includes('DR'), 'a store binding does not unlock a dealer-bound type')
    assert.equal(toolErr(await call('doc.query', { doc_type: 'DR' })), 'TOKEN_OWNER_BINDING_REQUIRED')
  })

  await t.test('dealer binding: DR rows limited to the owner dealer; a store binding does not help', async () => {
    const dealers = db.prepare('SELECT dealer_id, COUNT(*) n FROM dealer_requisitions GROUP BY dealer_id ORDER BY n DESC').all()
    assert.ok(dealers.length >= 2, 'demo data needs two dealers with requisitions')
    const [mine, other] = dealers
    setBind(ownerId, { dealer: mine.dealer_id })
    const got = ids(await call('doc.query', { doc_type: 'DR', limit: 100 }))
    assert.ok(got.length > 0 && got.every((id) => rowsOf('DR', id).dealer_id === mine.dealer_id))
    const foreign = db.prepare('SELECT id FROM dealer_requisitions WHERE dealer_id=? LIMIT 1').get(other.dealer_id)
    assert.equal(toolErr(await call('doc.get', { doc_type: 'DR', id: foreign.id })), 'NOT_FOUND')
    assert.equal(toolErr(await call('doc.query', { doc_type: 'PS' })), 'TOKEN_OWNER_BINDING_REQUIRED', 'a dealer binding does not unlock a store-bound type')
    // DS / RB: HTTP is HQ-only, no binding required for an internal owner holding the permission
    grant('warehouse', [...allBoundPerms, 'dms.dealer.view'])
    setBind(ownerId, {})
    assert.ok(okTool(await call('doc.query', { doc_type: 'DS' })))
    assert.ok(okTool(await call('doc.query', { doc_type: 'RB' })))
    grant('warehouse', allBoundPerms)
  })

  await t.test('order-center subject binding: external dealer/store owners see only their own customer; internal owners unchanged', async () => {
    const dealerOwner = await mk('y6_dealer', 'dealer')
    grant('dealer', ['order.view', 'order.statement.view'])
    const dTok = createToken(db, { name: 'y6d', ownerUserId: dealerOwner, industry: 'cosmetic', scopes: 'read' }).token
    setBind(dealerOwner, {})
    assert.equal(toolErr(await call('doc.query', { doc_type: 'OC' }, dTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
    assert.equal(toolErr(await call('doc.query', { doc_type: 'OCS' }, dTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
    // 未绑定的外部主体：订货中心类型不列出；它没有任何别的可读类型 ⇒ list_types 明确拒绝
    assert.equal(toolErr(await call('doc.list_types', {}, dTok)), 'TOKEN_OWNER_PERM_DENIED')
    const custs = db.prepare("SELECT c.id, c.source_id, (SELECT COUNT(*) FROM oc_orders o WHERE o.customer_id=c.id) n FROM oc_customers c WHERE c.source_type='dealer' ORDER BY n DESC").all()
    const [mine, other] = custs
    assert.ok(mine.n > 0 && other.n > 0, 'demo data needs two dealer customers with orders')
    setBind(dealerOwner, { dealer: mine.source_id })
    // 外部主体的 data_scope 为 all 才不被组织范围收窄，凸显绑定本身的作用
    const got = ids(await call('doc.query', { doc_type: 'OC', limit: 100 }, dTok))
    assert.ok(got.length > 0 && got.every((id) => rowsOf('OC', id).customer_id === mine.id), 'only the bound dealer customer')
    const foreign = db.prepare('SELECT id FROM oc_orders WHERE customer_id=? LIMIT 1').get(other.id)
    assert.equal(toolErr(await call('doc.get', { doc_type: 'OC', id: foreign.id }, dTok)), 'NOT_FOUND')
    const st = db.prepare('SELECT id, customer_id FROM oc_statements').all()
    const gotSt = ids(await call('doc.query', { doc_type: 'OCS', limit: 100 }, dTok))
    assert.ok(gotSt.every((id) => st.find((x) => x.id === id).customer_id === mine.id))
    for (const s2 of st.filter((x) => x.customer_id !== mine.id)) assert.equal(toolErr(await call('doc.get', { doc_type: 'OCS', id: s2.id }, dTok)), 'NOT_FOUND')
    assert.ok(toolText(await call('doc.list_types', {}, dTok)).doc_types.some((x) => x.code === 'OC'), 'listed once bound')
    // 门店主体同理：绑定门店 → 只看本店档案的订货单
    const storeOwner = await mk('y6_storeowner', 'store')
    grant('store', ['order.view'])
    const sTok = createToken(db, { name: 'y6s', ownerUserId: storeOwner, industry: 'cosmetic', scopes: 'read' }).token
    assert.equal(toolErr(await call('doc.query', { doc_type: 'OC' }, sTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
    const sc = db.prepare("SELECT c.id, c.source_id FROM oc_customers c WHERE c.source_type='store' AND EXISTS (SELECT 1 FROM oc_orders o WHERE o.customer_id=c.id)").get()
    if (sc) {
      setBind(storeOwner, { store: sc.source_id })
      const gs = ids(await call('doc.query', { doc_type: 'OC', limit: 100 }, sTok))
      assert.ok(gs.length > 0 && gs.every((id) => rowsOf('OC', id).customer_id === sc.id))
    }
    // 内部账号（warehouse）无绑定：HTTP 口径是组织范围，不要求绑定 → 不被 BINDING_REQUIRED 拦
    setBind(ownerId, {})
    const r = await call('doc.query', { doc_type: 'OC' })
    assert.notEqual(toolErr(r), 'TOKEN_OWNER_BINDING_REQUIRED')
  })

  await t.test('admin owner and ownerless tokens are exempt and see every store', async () => {
    for (const tk of [adminTok, free]) {
      for (const c of ['PS', 'RC', 'YQ', 'DR']) {
        const r = await call('doc.query', { doc_type: c, limit: 100 }, tk)
        assert.ok(okTool(r), `${c} ${JSON.stringify(r.body).slice(0, 200)}`)
        const col = BOUND[c][1]
        // 豁免调用者看到的就是表里最新的 100 行，不按门店/经销商裁剪（与种子数据里最新 100 行恰好属于几家门店无关：
        // ubuntu 上曾因种子日期按本地时区生成而使最新 100 张交班单同属一店，"distinct > 1" 的断言随机红）
        const newest = db.prepare(`SELECT id FROM ${tableOf(c)} ORDER BY id DESC LIMIT 100`).all().map((x) => x.id)
        assert.deepEqual(ids(r), newest, `${c}: exempt callers see exactly the newest rows regardless of ${col}`)
        const distinctAll = db.prepare(`SELECT COUNT(DISTINCT ${col}) n FROM ${tableOf(c)}`).get().n
        assert.ok(distinctAll > 1, `${c}: fixture has rows from more than one ${col}`)
      }
      const codes = toolText(await call('doc.list_types', {}, tk)).doc_types.map((x) => x.code)
      for (const c of Object.keys(BOUND)) assert.ok(codes.includes(c), `${c} listed for exempt caller`)
    }
  })

  await t.test('the binding is an extra gate: without the view permission it is still TOKEN_OWNER_PERM_DENIED', async () => {
    setBind(ownerId, { store: 1 })
    grant('warehouse', ['purchase.order.view'])
    assert.equal(toolErr(await call('doc.query', { doc_type: 'PS' })), 'TOKEN_OWNER_PERM_DENIED')
    grant('warehouse', allBoundPerms)
  })
})

// AA1（ADR-0041）：doc.query / order.trace_document 的归属判定走 DOC_SCOPE_RESOLVERS（与 doc.get / HTTP 同一份），
// 不再按 dealer_id 等列名推断；doc.query 把范围谓词下推进 SQL（limit 准确）；越界单据当作不存在。
test('AA1 doc.query and order.trace_document use the resolver table with owner scope and binding', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  const r = (await api('/api/auth/users', { token: admin, body: { username: 'aa1_owner', name: 'aa1', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
  assert.equal(r.success, true, JSON.stringify(r))
  const ownerId = r.data.id
  const token = createToken(db, { name: 'aa1', ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read' }).token
  const free = createToken(db, { name: 'aa1-free', industry: 'cosmetic', scopes: 'read' }).token
  const call = (name, args, tk = token) => mcp('tools/call', { name, arguments: args }, tk)
  const setPerms = (codes) => {
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse'").run()
    const ins = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?,?)')
    for (const c of codes) ins.run('warehouse', c)
  }
  setPerms(['sales.order.view', 'purchase.order.view', 'inventory.stock.view'])

  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE status='active' AND org_id IS NOT NULL ORDER BY id LIMIT 1").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE status='active' AND org_id IS NOT NULL AND org_id<>? ORDER BY id LIMIT 1").get(whA.org_id)
  assert.ok(whA && whB, 'fixture: warehouses in two different orgs')
  const dealer = Number(db.prepare("INSERT INTO dealers (code, name, org_id) VALUES ('AA1-D','AA1经销商',?)").run(whA.org_id).lastInsertRowid)
  const insSO = db.prepare(`INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
    VALUES (?,'dealer',?,date('now','localtime'),'draft',1,10,10,?)`)
  const soOwn1 = Number(insSO.run('AA1-SO-OWN1', dealer, whA.id).lastInsertRowid)
  const soOwn2 = Number(insSO.run('AA1-SO-OWN2', dealer, whA.id).lastInsertRowid)
  // 经销商属本组织、出货仓属他组织：旧的 dealer_id 推断会放行
  const soOther = Number(insSO.run('AA1-SO-OTHER', dealer, whB.id).lastInsertRowid)
  // 再塞一批更新的越界单据，让「取 limit×3 再过滤」的旧实现取不满
  for (let i = 0; i < 9; i++) insSO.run(`AA1-SO-NOISE${i}`, dealer, whB.id)
  const insTxn = db.prepare(`INSERT INTO inventory_transactions (biz_date,doc_type,doc_no,warehouse_id,owner_org_id,sku_id,batch_no,direction,qty,unit_cost,amount,source)
    VALUES (date('now','localtime'),'SAL_OUT',?,?,?,(SELECT id FROM product_skus ORDER BY id LIMIT 1),'','out',1,1,1,'test')`)
  insTxn.run('AA1-SO-OTHER', whB.id, whA.org_id) // 流水货主在所有者组织，但单据属他组织
  db.prepare('UPDATE users SET org_id=?, data_scope=? WHERE id=?').run(whA.org_id, 'org', ownerId)

  const notFound = (res) => toolErr(res) === 'NOT_FOUND'

  await t.test('doc.query SO returns exactly the resolver-visible rows and limit stays accurate', async () => {
    const res = await call('doc.query', { doc_type: 'SO', limit: 2, keyword: 'AA1-SO' })
    assert.ok(okTool(res), JSON.stringify(res.body).slice(0, 300))
    const nos = toolText(res).rows.map((x) => x.doc_no).sort()
    assert.deepEqual(nos, ['AA1-SO-OWN1', 'AA1-SO-OWN2'], 'limit 2 must be filled with in-scope rows even when newer rows are out of scope')
    const all = toolText(await call('doc.query', { doc_type: 'SO', limit: 100, keyword: 'AA1-SO' })).rows.map((x) => x.doc_no)
    assert.ok(!all.includes('AA1-SO-OTHER') && !all.some((n) => n.includes('NOISE')), 'out-of-scope SO must not appear')
  })

  await t.test('doc.query on a global-only type is empty for a restricted scope but not for the unowned all-scope token', async () => {
    setPerms(['finance.voucher.view'])
    const res = await call('doc.query', { doc_type: 'VOUCHER' })
    assert.ok(okTool(res))
    assert.equal(toolText(res).rows.length, 0, 'VOUCHER has no org ownership: invisible to a restricted scope')
    const free2 = await call('doc.query', { doc_type: 'VOUCHER' }, free)
    assert.ok(okTool(free2))
    setPerms(['sales.order.view', 'purchase.order.view', 'inventory.stock.view'])
  })

  await t.test('order.trace_document: out-of-scope doc is NOT_FOUND (even with in-scope-owner ledger lines); in-scope doc is found', async () => {
    const out = await call('order.trace_document', { doc_no: 'AA1-SO-OTHER' })
    assert.ok(notFound(out), JSON.stringify(out.body).slice(0, 300))
    const none = await call('order.trace_document', { doc_no: 'AA1-NO-SUCH' })
    assert.ok(notFound(none))
    assert.equal(JSON.stringify(toolText(out)), JSON.stringify(toolText(none)).replace('AA1-NO-SUCH', 'AA1-SO-OTHER'), 'same shape as nonexistent')
    const own = await call('order.trace_document', { doc_no: 'AA1-SO-OWN1' })
    assert.ok(okTool(own))
    assert.equal(toolText(own).documents.length, 1)
  })

  await t.test('order.trace_document honours the owner per-type view permission (binding / permission rules of doc-perms)', async () => {
    setPerms(['purchase.order.view'])
    const res = await call('order.trace_document', { doc_no: 'AA1-SO-OWN1' })
    assert.ok(notFound(res), 'owner without sales.order.view must not trace a sales order')
    setPerms(['sales.order.view', 'purchase.order.view', 'inventory.stock.view'])
  })

  await t.test('order.trace_document does not leak a doc of an unlisted type (store shipment SH) through its ledger lines (Codex AA1 P1)', async () => {
    const storeB = db.prepare('SELECT id FROM stores WHERE org_id IS NOT NULL AND org_id<>? ORDER BY id LIMIT 1').get(whA.org_id)
    assert.ok(storeB, 'fixture: a store in the other org')
    db.prepare(`INSERT INTO store_shipments (doc_no, store_id, from_warehouse_id, to_warehouse_id, ship_date, status)
      VALUES ('AA1-SH-OTHER', ?, ?, ?, date('now','localtime'), 'shipped')`).run(storeB.id, whB.id, whB.id)
    insTxn.run('AA1-SH-OTHER', whB.id, whA.org_id) // 流水货主在所有者组织
    const res = await call('order.trace_document', { doc_no: 'AA1-SH-OTHER' })
    assert.ok(notFound(res), JSON.stringify(res.body).slice(0, 300))
    assert.ok(okTool(await call('order.trace_document', { doc_no: 'AA1-SH-OTHER' }, free)), 'unowned all-scope token still resolves it')
  })

  await t.test('order.trace_document: inactive type and shared doc numbers do not unlock ledger lines of a hidden doc (Codex AA1 P1 x2)', async () => {
    // 停用类型：SH 置为停用后，越界单据仍须被探测到
    db.prepare("UPDATE doc_types SET status='inactive' WHERE code='SH'").run()
    try {
      assert.ok(notFound(await call('order.trace_document', { doc_no: 'AA1-SH-OTHER' })), 'inactive type must still be probed')
    } finally {
      db.prepare("UPDATE doc_types SET status='active' WHERE code='SH'").run()
    }
    // 同号：可见的 SO 与越界的 SH 共用单号，流水不得借可见单据放出
    const storeB = db.prepare('SELECT id FROM stores WHERE org_id IS NOT NULL AND org_id<>? ORDER BY id LIMIT 1').get(whA.org_id)
    db.prepare(`INSERT INTO store_shipments (doc_no, store_id, from_warehouse_id, to_warehouse_id, ship_date, status)
      VALUES ('AA1-SO-OWN2', ?, ?, ?, date('now','localtime'), 'shipped')`).run(storeB.id, whB.id, whB.id)
    insTxn.run('AA1-SO-OWN2', whB.id, whA.org_id)
    const res = await call('order.trace_document', { doc_no: 'AA1-SO-OWN2' })
    assert.ok(okTool(res))
    assert.equal(toolText(res).documents.length, 1, 'only the visible SO is returned')
    assert.equal(toolText(res).inventory_transactions.length, 0, 'ledger lines cannot be attributed to the visible doc, so none are returned')
  })

  await t.test('unowned all-scope token still sees everything (unchanged)', async () => {
    assert.ok(okTool(await call('order.trace_document', { doc_no: 'AA1-SO-OTHER' }, free)))
    const q = await call('doc.query', { doc_type: 'SO', keyword: 'AA1-SO-OTHER' }, free)
    assert.equal(toolText(q).rows.length, 1)
  })
})

// AB7（ADR-0011 补充）：RC / YQ / SH 的门店绑定规则进入 DOC_SCOPE_RESOLVERS（binding: 'store'），
// 与 HTTP 同一个绑定判据（server/lib/store-binding.js）。doc.get / doc.query / order.trace_document 因此自动生效；
// 注册表本身也不再对「绑了门店的非 admin 账号 + data_scope=all」放行别家门店的单据。
// 矩阵：三种类型 × 绑定 / 未绑定 / 绑他店 / admin 豁免 / 无主令牌，只读，零写。
const AB7_TYPES = ['RC', 'YQ', 'SH']
test('AB7 RC/YQ/SH binding rules live in DOC_SCOPE_RESOLVERS and use the shared store-binding predicate', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const { DOC_SCOPE_RESOLVERS, docInScope, docScopeOf } = await import('../../server/lib/docflow.js')
  await import('../../server/lib/purchase.js')
  const sb = await import('../../server/lib/store-binding.js')
  for (const c of AB7_TYPES) assert.equal(DOC_SCOPE_RESOLVERS[c].binding, 'store', `${c} declares its binding in the resolver table`)
  assert.equal(sb.boundStoreId({ store_id: '3' }), 3)
  assert.equal(sb.boundStoreId({ store_id: null }), null)
  assert.equal(sb.boundStoreId(null), null)
  assert.equal(sb.storeBindingExempt({ role: 'admin' }), true)
  assert.equal(sb.storeBindingExempt({ role: 'finance' }), false)
  assert.equal(sb.storeBindingExempt({ role: 'finance', is_super: 1 }), true, 'is_super matches the doc-perms isSuper exemption')

  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  const r = (await api('/api/auth/users', { token: admin, body: { username: 'ab7_owner', name: 'ab7', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
  assert.equal(r.success, true, JSON.stringify(r))
  const ownerId = r.data.id
  const token = createToken(db, { name: 'ab7', ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read' }).token
  const free = createToken(db, { name: 'ab7-free', industry: 'cosmetic', scopes: 'read' }).token
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id
  const adminTok = createToken(db, { name: 'ab7-admin', ownerUserId: adminId, industry: 'cosmetic', scopes: 'read' }).token
  const call = (name, args, tk = token) => mcp('tools/call', { name, arguments: args }, tk)
  db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse'").run()
  const ins = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of new Set([...AB7_TYPES.flatMap((c) => DOC_VIEW_PERMS[c].perms), 'sales.order.view', 'purchase.order.view', 'inventory.stock.view'])) ins.run('warehouse', p)
  const setStore = (id) => db.prepare('UPDATE users SET store_id=? WHERE id=?').run(id, ownerId)
  const tableOf = (c) => DOC_SCOPE_RESOLVERS[c].table
  const noField = (c) => db.prepare('SELECT doc_no_field f FROM doc_types WHERE code=?').get(c).f || 'doc_no'
  const pick = (c) => {
    const stores = db.prepare(`SELECT store_id, COUNT(*) n FROM ${tableOf(c)} WHERE store_id IS NOT NULL GROUP BY store_id ORDER BY n DESC, store_id`).all()
    assert.ok(stores.length >= 2, `${c}: fixture needs two stores with documents`)
    const row = (sid) => db.prepare(`SELECT id, ${noField(c)} AS dn FROM ${tableOf(c)} WHERE store_id=? ORDER BY id LIMIT 1`).get(sid)
    return { mine: stores[0], other: stores[1], own: row(stores[0].store_id), foreign: row(stores[1].store_id) }
  }
  const WRITE_TABLES = ['audit_logs', 'doc_events', 'mcp_idempotency', 'mcp_confirmations', ...AB7_TYPES.map(tableOf)]
  const snap = () => WRITE_TABLES.map((tn) => { try { return `${tn}=${db.prepare(`SELECT COUNT(*) c FROM ${tn}`).get().c}` } catch { return `${tn}=n/a` } }).join(',')
  const before = snap()
  const notFound = (res) => toolErr(res) === 'NOT_FOUND'

  await t.test('registry: a bound non-admin sees only the own store even with data_scope=all (same predicate as the POS / requisition routes)', () => {
    for (const c of AB7_TYPES) {
      const p = pick(c)
      const ctxOf = (user, extra = {}) => ({ db, user, orgScope: { scope: 'all', orgIds: null }, ...extra })
      const bound = { id: ownerId, role: 'warehouse', store_id: p.mine.store_id }
      assert.equal(docInScope(ctxOf(bound), c, p.own.id), true, `${c} own`)
      assert.equal(docInScope(ctxOf(bound), c, p.foreign.id), false, `${c} foreign`)
      // admin 豁免（HTTP requireStore 对 admin 放行），无主上下文（user=null）豁免
      assert.equal(docInScope(ctxOf({ ...bound, role: 'admin' }), c, p.foreign.id), true, `${c} admin`)
      assert.equal(docInScope(ctxOf(null), c, p.foreign.id), true, `${c} unowned`)
      // 未绑门店：HTTP 路由按角色名放行总部角色（保持），MCP 严格模式一律不可见（fail-closed，ADR-0011 Y6）
      const unbound = { id: ownerId, role: 'warehouse', store_id: null }
      assert.equal(docInScope(ctxOf(unbound), c, p.foreign.id), true, `${c} unbound non-strict keeps HTTP role-name semantics`)
      assert.equal(docInScope(ctxOf(unbound, { strictBinding: true }), c, p.own.id), false, `${c} unbound strict`)
      assert.equal(docScopeOf(ctxOf(unbound, { strictBinding: true }), c), null, `${c} unbound strict: type invisible`)
      assert.equal(docInScope(ctxOf({ ...unbound, role: 'admin' }, { strictBinding: true }), c, p.own.id), true, `${c} admin strict`)
      assert.equal(docInScope(ctxOf({ ...unbound, is_super: 1 }, { strictBinding: true }), c, p.own.id), true, `${c} is_super strict`)
    }
  })

  for (const c of AB7_TYPES) {
    await t.test(`${c}: unbound owner -> nothing readable (query rejected, get / trace not found) and hidden`, async () => {
      const p = pick(c)
      setStore(null)
      assert.equal(toolErr(await call('doc.query', { doc_type: c })), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: p.own.id })), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.ok(notFound(await call('order.trace_document', { doc_no: String(p.own.dn) })), 'trace of an existing doc number is not found for an unbound owner')
      assert.ok(!toolText(await call('doc.list_types', {})).doc_types.map((x) => x.code).includes(c))
    })
    await t.test(`${c}: bound owner reads own store, other store is NOT_FOUND / absent from query / trace`, async () => {
      const p = pick(c)
      setStore(p.mine.store_id)
      const q = await call('doc.query', { doc_type: c, limit: 100 })
      assert.ok(okTool(q), JSON.stringify(q.body).slice(0, 200))
      const rows = toolText(q).rows
      assert.ok(rows.length > 0 && rows.every((x) => db.prepare(`SELECT store_id FROM ${tableOf(c)} WHERE id=?`).get(x.id).store_id === p.mine.store_id), 'only own store rows')
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: p.own.id })))
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: p.foreign.id })))
      assert.ok(okTool(await call('order.trace_document', { doc_no: String(p.own.dn) })), 'own doc is traceable')
      assert.ok(notFound(await call('order.trace_document', { doc_no: String(p.foreign.dn) })), 'foreign doc is not traceable')
      setStore(p.other.store_id)
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: p.own.id })), 're-bound to the other store: former own doc is hidden at once')
    })
    await t.test(`${c}: admin owner and unowned token keep the cross-store read`, async () => {
      const p = pick(c)
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: p.foreign.id }, adminTok)))
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: p.foreign.id }, free)))
    })
  }

  await t.test('the matrix performed zero writes', () => {
    setStore(null)
    // 工具调用自身的审计行（mcp_call_logs）不在被监视集合内；业务表与留痕 / 幂等 / 确认表必须不变
    assert.equal(snap(), before)
  })
})

// AC3（ADR-0011 补充 2）：DOC_VIEW_PERMS 里剩余的绑定类型都在 DOC_SCOPE_RESOLVERS 里有 `binding` 规则，
// 且 `scope=all` 不再绕过：PS / PSF（store）、DR（dealer）、OC / OCS（subject）、DS / RB（hq：总部专属、无自视图）。
// 注册表层（docScopeOf / docInScope / docEventScope）与 MCP 读工具（doc.get / doc.query / order.trace_document）各测一遍，
// 每类型 × {绑定本方、绑定他方、未绑定、admin}，全程零写。
const AC3_EXPECT = { PS: 'store', PSF: 'store', RC: 'store', YQ: 'store', SH: 'store', DR: 'dealer', OC: 'subject', OCS: 'subject', DS: 'hq', RB: 'hq' }
test('AC3 registry: every bound DOC_VIEW_PERMS type has a resolver binding rule, scope=all no longer bypasses it', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db } = f
  const { DOC_SCOPE_RESOLVERS, docInScope, docScopeOf, docEventScope } = await import('../../server/lib/docflow.js')
  await import('../../server/lib/purchase.js')
  await import('../../server/lib/order-center.js')
  const sb = await import('../../server/lib/store-binding.js')
  for (const [c, b] of Object.entries(AC3_EXPECT)) assert.equal(DOC_SCOPE_RESOLVERS[c].binding, b, `${c} declares binding ${b}`)
  for (const [c, e] of Object.entries(DOC_VIEW_PERMS)) {
    if (e.binding) assert.equal(DOC_SCOPE_RESOLVERS[c]?.binding, e.binding, `${c}: resolver binding mirrors DOC_VIEW_PERMS`)
  }
  assert.equal(sb.boundDealerId({ dealer_id: '4' }), 4)
  assert.equal(sb.boundDealerId({ dealer_id: 0 }), null)
  assert.equal(sb.boundDealerId(null), null)
  assert.equal(sb.isExternalSubject({ role: 'dealer' }), true)
  assert.equal(sb.isExternalSubject({ role: 'store' }), true)
  assert.equal(sb.isExternalSubject({ role: 'warehouse' }), false)

  const countOf = (tn) => db.prepare(`SELECT COUNT(*) c FROM ${tn}`).get().c
  const before = ['oc_customers', 'oc_orders', 'oc_statements', 'doc_events', 'audit_logs'].map(countOf)
  const ctxOf = (user, extra = {}) => ({ db, user, orgScope: { scope: 'all', orgIds: null }, ...extra })
  const strict = { strictBinding: true }

  // PS / PSF（store）
  for (const c of ['PS', 'PSF']) {
    const tn = DOC_SCOPE_RESOLVERS[c].table
    const stores = db.prepare(`SELECT store_id FROM ${tn} WHERE store_id IS NOT NULL GROUP BY store_id ORDER BY COUNT(*) DESC, store_id LIMIT 2`).all()
    assert.equal(stores.length, 2, `${c}: fixture needs two stores`)
    const own = db.prepare(`SELECT id FROM ${tn} WHERE store_id=? LIMIT 1`).get(stores[0].store_id).id
    const foreign = db.prepare(`SELECT id FROM ${tn} WHERE store_id=? LIMIT 1`).get(stores[1].store_id).id
    const bound = { id: 9001, role: 'warehouse', store_id: stores[0].store_id }
    assert.equal(docInScope(ctxOf(bound), c, own), true, `${c} own under scope=all`)
    assert.equal(docInScope(ctxOf(bound), c, foreign), false, `${c} foreign under scope=all`)
    assert.equal(docInScope(ctxOf({ ...bound, role: 'admin' }), c, foreign), true, `${c} admin`)
    assert.equal(docInScope(ctxOf(null), c, foreign), true, `${c} unowned`)
    const unbound = { id: 9001, role: 'warehouse', store_id: null }
    assert.equal(docInScope(ctxOf(unbound), c, foreign), true, `${c} unbound non-strict keeps HTTP role-name semantics`)
    assert.equal(docScopeOf(ctxOf(unbound, strict), c), null, `${c} unbound strict`)
  }

  // DR（dealer）
  {
    const dealers = db.prepare('SELECT dealer_id FROM dealer_requisitions GROUP BY dealer_id ORDER BY COUNT(*) DESC, dealer_id LIMIT 2').all()
    assert.equal(dealers.length, 2)
    const own = db.prepare('SELECT id FROM dealer_requisitions WHERE dealer_id=? LIMIT 1').get(dealers[0].dealer_id).id
    const foreign = db.prepare('SELECT id FROM dealer_requisitions WHERE dealer_id=? LIMIT 1').get(dealers[1].dealer_id).id
    const bound = { id: 9002, role: 'warehouse', dealer_id: dealers[0].dealer_id }
    assert.equal(docInScope(ctxOf(bound), 'DR', own), true)
    assert.equal(docInScope(ctxOf(bound), 'DR', foreign), false, 'DR foreign under scope=all')
    assert.equal(docInScope(ctxOf({ ...bound, role: 'admin' }), 'DR', foreign), true)
    assert.equal(docInScope(ctxOf(null), 'DR', foreign), true)
    const unbound = { id: 9002, role: 'warehouse', dealer_id: null }
    assert.equal(docInScope(ctxOf(unbound), 'DR', foreign), true, 'DR unbound non-strict')
    assert.equal(docScopeOf(ctxOf(unbound, strict), 'DR'), null, 'DR unbound strict')
    // 受限范围里的绑定同样收窄到本经销商（再叠加组织）
    const orgs = db.prepare('SELECT org_id FROM dealers WHERE id=?').get(dealers[0].dealer_id)
    const restricted = { db, user: bound, orgScope: { scope: 'org', orgIds: [orgs.org_id] } }
    assert.equal(docInScope(restricted, 'DR', foreign), false)
  }

  // OC / OCS（subject）
  {
    const custs = db.prepare("SELECT c.id, c.source_id FROM oc_customers c WHERE c.source_type='dealer' AND EXISTS (SELECT 1 FROM oc_orders o WHERE o.customer_id=c.id) ORDER BY c.id LIMIT 2").all()
    assert.equal(custs.length, 2, 'fixture needs two dealer customers with orders')
    const ordOf = (cid) => db.prepare('SELECT id FROM oc_orders WHERE customer_id=? LIMIT 1').get(cid).id
    const dealerA = { id: 9003, role: 'dealer', dealer_id: custs[0].source_id }
    assert.equal(docInScope(ctxOf(dealerA), 'OC', ordOf(custs[0].id)), true, 'OC own under scope=all')
    assert.equal(docInScope(ctxOf(dealerA), 'OC', ordOf(custs[1].id)), false, 'OC foreign under scope=all')
    const stOther = db.prepare('SELECT id FROM oc_statements WHERE customer_id<>? LIMIT 1').get(custs[0].id)
    if (stOther) assert.equal(docInScope(ctxOf(dealerA), 'OCS', stOther.id), false, 'OCS foreign under scope=all')
    assert.equal(docScopeOf(ctxOf({ id: 9004, role: 'dealer', dealer_id: null }), 'OC'), null, 'unbound external subject sees nothing, even non-strict')
    assert.equal(docScopeOf(ctxOf({ id: 9005, role: 'store', store_id: null }), 'OCS'), null)
    assert.deepEqual(docScopeOf(ctxOf({ id: 9006, role: 'warehouse' }), 'OC'), { all: true }, 'internal accounts keep the org scope')
    assert.deepEqual(docScopeOf(ctxOf(null), 'OCS'), { all: true })
    const es = docEventScope(ctxOf(dealerA), 'e')
    assert.equal(es.all, false, 'events under scope=all are narrowed for an external subject')
    const leak = db.prepare(`SELECT COUNT(*) c FROM doc_events e WHERE e.doc_type='OC' AND e.doc_id IN (SELECT id FROM oc_orders WHERE customer_id<>?) AND ${es.sql}`).get(custs[0].id, ...es.params)
    assert.equal(leak.c, 0)
  }

  // DS / RB（hq：任何门店 / 经销商绑定的账号整类不可见）
  for (const c of ['DS', 'RB']) {
    const tn = DOC_SCOPE_RESOLVERS[c].table
    const did = db.prepare(`SELECT dealer_id FROM ${tn} LIMIT 1`).get().dealer_id
    for (const u of [{ role: 'warehouse', dealer_id: did }, { role: 'finance', store_id: 1 }, { role: 'dealer', dealer_id: did }, { role: 'store', store_id: 1 }]) {
      assert.equal(docScopeOf(ctxOf({ id: 9007, ...u }), c), null, `${c} hidden from ${JSON.stringify(u)} even under scope=all`)
      assert.equal(docScopeOf(ctxOf({ id: 9007, ...u }, strict), c), null)
    }
    assert.deepEqual(docScopeOf(ctxOf({ id: 9008, role: 'finance' }), c), { all: true }, `${c}: unbound internal keeps the scope`)
    assert.deepEqual(docScopeOf(ctxOf({ id: 9008, role: 'admin', dealer_id: did }), c), { all: true }, `${c}: admin exempt`)
    assert.deepEqual(docScopeOf(ctxOf(null), c), { all: true })
  }
  assert.deepEqual(['oc_customers', 'oc_orders', 'oc_statements', 'doc_events', 'audit_logs'].map(countOf), before, 'registry reads wrote nothing (no ensureCustomer)')
})

test('AC3 MCP matrix: PS PSF DR OC OCS DS RB x {bound-own, bound-other, unbound, admin} through doc.get / doc.query / order.trace_document, zero writes', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const { DOC_SCOPE_RESOLVERS } = await import('../../server/lib/docflow.js')
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  const mk = async (username, role) => {
    const r = (await api('/api/auth/users', { token: admin, body: { username, name: username, role, password: secret(), data_scope: 'all' } })).body
    assert.equal(r.success, true, JSON.stringify(r))
    return r.data.id
  }
  const internal = await mk('ac3_internal', 'warehouse')
  const dealerOwner = await mk('ac3_dealer', 'dealer')
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id
  const tok = (uid, name) => createToken(db, { name, ownerUserId: uid, industry: 'cosmetic', scopes: 'read' }).token
  const iTok = tok(internal, 'ac3-i')
  const dTok = tok(dealerOwner, 'ac3-d')
  const aTok = tok(adminId, 'ac3-a')
  const call = (name, args, tk) => mcp('tools/call', { name, arguments: args }, tk)
  const grant = (role, codes) => {
    db.prepare('DELETE FROM role_permissions WHERE role_code=?').run(role)
    const ins = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?,?)')
    for (const c of new Set(codes)) ins.run(role, c)
  }
  const types = ['PS', 'PSF', 'DR', 'OC', 'OCS', 'DS', 'RB']
  grant('warehouse', [...types.flatMap((c) => DOC_VIEW_PERMS[c].perms), 'sales.order.view', 'purchase.order.view', 'inventory.stock.view'])
  grant('dealer', ['order.view', 'order.statement.view', 'sales.order.view', 'purchase.order.view', 'inventory.stock.view'])
  const tableOf = (c) => DOC_SCOPE_RESOLVERS[c].table
  const noField = (c) => db.prepare('SELECT doc_no_field f FROM doc_types WHERE code=?').get(c).f || 'doc_no'
  const bind = (uid, { store = null, dealer = null }) => db.prepare('UPDATE users SET store_id=?, dealer_id=? WHERE id=?').run(store, dealer, uid)
  const idsOf = (r) => toolText(r).rows.map((x) => x.id)
  const WATCH = ['audit_logs', 'doc_events', 'mcp_idempotency', 'mcp_confirmations', 'oc_customers', ...types.map(tableOf)]
  const snap = () => WATCH.map((tn) => `${tn}=${db.prepare(`SELECT COUNT(*) c FROM ${tn}`).get().c}`).join(',')
  const before = snap()
  const notFound = (res) => toolErr(res) === 'NOT_FOUND'
  // RB（dealer_rebates）没有单据号列：dn 为 null，order.trace_document 无从按单号探测它（只测 doc.get / doc.query）
  const hasNo = (c) => db.prepare(`PRAGMA table_info(${tableOf(c)})`).all().some((x) => x.name === noField(c))
  const rowOf = (c, where, ...args) => db.prepare(`SELECT id, ${hasNo(c) ? noField(c) : 'NULL'} AS dn FROM ${tableOf(c)} WHERE ${where} ORDER BY id LIMIT 1`).get(...args)
  const traceable = async (c, row, tk) => row.dn == null || okTool(await call('order.trace_document', { doc_no: String(row.dn) }, tk))
  const hidden = async (c, row, tk) => row.dn == null || notFound(await call('order.trace_document', { doc_no: String(row.dn) }, tk))

  for (const c of ['PS', 'PSF', 'DR']) {
    const kind = c === 'DR' ? 'dealer' : 'store'
    const col = kind === 'dealer' ? 'dealer_id' : 'store_id'
    await t.test(`${c}: ${kind}-bound owner`, async () => {
      const groups = db.prepare(`SELECT ${col} k FROM ${tableOf(c)} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY COUNT(*) DESC, ${col} LIMIT 2`).all()
      assert.equal(groups.length, 2, `${c}: fixture needs two ${kind}s`)
      const [mine, other] = groups.map((g) => g.k)
      const own = rowOf(c, `${col}=?`, mine)
      const foreign = rowOf(c, `${col}=?`, other)
      const set = (k) => bind(internal, kind === 'dealer' ? { dealer: k } : { store: k })
      set(mine)
      const q = await call('doc.query', { doc_type: c, limit: 100 }, iTok)
      assert.ok(okTool(q))
      assert.ok(idsOf(q).length > 0 && idsOf(q).every((id) => db.prepare(`SELECT ${col} k FROM ${tableOf(c)} WHERE id=?`).get(id).k === mine), `${c} bound-own query`)
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: own.id }, iTok)))
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: foreign.id }, iTok)), `${c} bound-other get`)
      assert.ok(await traceable(c, own, iTok))
      assert.ok(await hidden(c, foreign, iTok), `${c} bound-other trace`)
      set(other)
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: own.id }, iTok)), 're-bound: former own doc hidden at once')
      assert.ok(await hidden(c, own, iTok))
      set(null)
      assert.equal(toolErr(await call('doc.query', { doc_type: c }, iTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: own.id }, iTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.ok(await hidden(c, own, iTok), `${c} unbound trace`)
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: foreign.id }, aTok)), 'admin reads cross-binding')
      assert.ok(await traceable(c, foreign, aTok))
      assert.equal(idsOf(await call('doc.query', { doc_type: c, limit: 100 }, aTok)).length, Math.min(100, db.prepare(`SELECT COUNT(*) c FROM ${tableOf(c)}`).get().c))
    })
  }

  for (const c of ['OC', 'OCS']) {
    await t.test(`${c}: subject-bound external owner`, async () => {
      const custs = db.prepare(`SELECT c.id, c.source_id FROM oc_customers c WHERE c.source_type='dealer' AND EXISTS (SELECT 1 FROM ${tableOf(c)} o WHERE o.customer_id=c.id) ORDER BY c.id LIMIT 2`).all()
      assert.equal(custs.length, 2, `${c}: fixture needs two dealer customers with documents`)
      const [mine, other] = custs
      const own = rowOf(c, 'customer_id=?', mine.id)
      const foreign = rowOf(c, 'customer_id=?', other.id)
      bind(dealerOwner, { dealer: mine.source_id })
      const q = await call('doc.query', { doc_type: c, limit: 100 }, dTok)
      assert.ok(okTool(q))
      assert.ok(idsOf(q).length > 0 && idsOf(q).every((id) => db.prepare(`SELECT customer_id k FROM ${tableOf(c)} WHERE id=?`).get(id).k === mine.id))
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: own.id }, dTok)))
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: foreign.id }, dTok)), `${c} bound-other get`)
      assert.ok(await traceable(c, own, dTok))
      assert.ok(await hidden(c, foreign, dTok), `${c} bound-other trace`)
      bind(dealerOwner, { dealer: other.source_id })
      assert.ok(notFound(await call('doc.get', { doc_type: c, id: own.id }, dTok)))
      assert.ok(await hidden(c, own, dTok))
      bind(dealerOwner, {})
      assert.equal(toolErr(await call('doc.query', { doc_type: c }, dTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.equal(toolErr(await call('doc.get', { doc_type: c, id: own.id }, dTok)), 'TOKEN_OWNER_BINDING_REQUIRED')
      assert.ok(await hidden(c, own, dTok), `${c} unbound trace`)
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: foreign.id }, aTok)))
      assert.ok(await traceable(c, foreign, aTok))
      // 内部账号（未绑定）保持组织范围口径（data_scope=all ⇒ 全部可见）
      bind(internal, {})
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: foreign.id }, iTok)), 'internal owner keeps the org-scope read')
    })
  }

  for (const c of ['DS', 'RB']) {
    await t.test(`${c}: HQ-only, bound owners see nothing`, async () => {
      const row = rowOf(c, '1=1')
      const did = db.prepare(`SELECT dealer_id k FROM ${tableOf(c)} WHERE id=?`).get(row.id).k
      bind(internal, {})
      assert.ok(idsOf(await call('doc.query', { doc_type: c, limit: 100 }, iTok)).length > 0, 'unbound internal owner reads')
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: row.id }, iTok)))
      assert.ok(await traceable(c, row, iTok))
      for (const b of [{ dealer: did }, { store: 1 }, { dealer: did + 1000 }]) {
        bind(internal, b)
        assert.equal(idsOf(await call('doc.query', { doc_type: c, limit: 100 }, iTok)).length, 0, `${c} bound ${JSON.stringify(b)}: query is empty`)
        assert.ok(notFound(await call('doc.get', { doc_type: c, id: row.id }, iTok)), `${c} bound get`)
        assert.ok(await hidden(c, row, iTok), `${c} bound trace`)
      }
      bind(internal, {})
      assert.ok(okTool(await call('doc.get', { doc_type: c, id: row.id }, aTok)), 'admin')
      assert.ok(await traceable(c, row, aTok))
    })
  }

  await t.test('the matrix performed zero writes', () => {
    bind(internal, {})
    bind(dealerOwner, {})
    assert.equal(snap(), before)
  })
})
