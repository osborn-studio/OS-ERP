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
import { createToken } from '../server/mcp/tokens.js'
import { DOC_VIEW_PERMS, viewPermsOf } from '../server/mcp/doc-perms.js'
import { PO_READ_PERMS } from '../server/lib/purchase.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
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
  assert.deepEqual(DOC_VIEW_PERMS.GR.perms, PO_READ_PERMS)
  assert.deepEqual(DOC_VIEW_PERMS.PRT.perms, PO_READ_PERMS)
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
    assert.equal(toolErr(await call('doc.query', { doc_type: 'PI' })), 'TOKEN_OWNER_PERM_DENIED')
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
