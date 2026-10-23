// MCP 委托令牌（F07 / F13 / F09 的 MCP 部分）：Agent Token 是**所有者的委托**，不是独立服务主体。
//   · 每次调用都回库核对所有者：存在 / active / auth_version 未变；权限与数据范围取
//     「令牌声明范围 ∩ 所有者当前权限与范围」；
//   · 停用所有者在同一事务里吊销其全部令牌；auth_version 一旦变化，旧令牌永久失效；
//   · Agent Token 只认 Authorization: Bearer；
//   · 写型工具的调用审计与业务过账同一事务，审计写不进去就回滚。
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

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-delegation-'))
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
  let seq = 0
  const mcp = async (method, params, token, { query = null, headers = {} } = {}) => {
    const res = await fetch(`${base}/mcp${query ? `?token=${encodeURIComponent(query)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal: AbortSignal.timeout(10000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { dir, api, mcp, db }
}

const rpcCode = (r) => r.body?.error?.data?.code ?? null
const toolText = (r) => {
  const text = r.body?.result?.content?.[0]?.text
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return text }
}
const toolErr = (r) => (r.body?.result?.isError ? toolText(r)?.error : null)
const okTool = (r) => !r.body?.error && r.body?.result?.isError !== true
const toolNames = (r) => (r.body?.result?.tools || []).map((x) => x.name)

test('MCP tokens are delegations of their human owner', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data.token
  assert.ok(admin, 'demo admin must log in')

  const owner = (await api('/api/auth/users', { token: admin, body: { username: 'mcp_owner', name: 'MCP owner', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
  assert.equal(owner.success, true, JSON.stringify(owner))
  const ownerId = owner.data.id
  const issue = (name, extra = {}) => createToken(db, { name, ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read,write', ...extra }).token

  const wh = db.prepare("SELECT w.id, w.org_id FROM warehouses w WHERE w.status='active' AND w.org_id IS NOT NULL ORDER BY w.id LIMIT 1").get()
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get()
  assert.ok(wh && sku, 'demo data must provide a warehouse and a SKU')
  const txnCount = () => db.prepare('SELECT COUNT(*) AS n FROM inventory_transactions').get().n
  const tokenStatus = (raw) => db.prepare('SELECT status FROM agent_tokens WHERE token_prefix=?').get(raw.slice(0, 12)).status
  let keySeq = 0
  const stockIn = (token, extra = {}) => {
    const key = `delegation-${Date.now()}-${++keySeq}`
    return mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: wh.id, sku_id: sku.id, qty: 1, unit_cost: 10, idempotency_key: key, ...extra } }, token).then((r) => ({ ...r, key }))
  }
  const queryStock = (token) => mcp('tools/call', { name: 'inventory.query_stock', arguments: { limit: 5 } }, token)
  const whPerm = "SELECT COUNT(*) AS n FROM role_permissions WHERE role_code='warehouse' AND perm_code='purchase.inbound'"

  const t1 = issue('delegation-1')

  await t.test('token is accepted only from the Authorization header', async () => {
    assert.equal(rpcCode(await mcp('tools/list', {}, null, { query: t1 })), 'TOKEN_MISSING')
    assert.equal(rpcCode(await mcp('tools/list', {}, null, { headers: { 'x-agent-token': t1 } })), 'TOKEN_MISSING')
    assert.equal(rpcCode(await mcp('tools/list', {}, 'gml_not_a_token')), 'TOKEN_INVALID')
    const listed = await mcp('tools/list', {}, t1)
    assert.ok(toolNames(listed).includes('inventory.stock_in'), JSON.stringify(listed.body).slice(0, 300))
  })

  await t.test('baseline: owner in good standing can read and write; audit args are redacted', async () => {
    const read = await queryStock(t1)
    assert.ok(okTool(read), JSON.stringify(read.body).slice(0, 300))
    const before = txnCount()
    const write = await stockIn(t1)
    assert.ok(okTool(write), JSON.stringify(write.body).slice(0, 300))
    assert.equal(txnCount(), before + 1)
    const log = db.prepare('SELECT args, idempotency_key, ok FROM mcp_call_logs WHERE idempotency_key=? AND tool_name=?').get(write.key, 'inventory.stock_in')
    assert.ok(log, 'write call must be audited')
    assert.equal(log.ok, 1)
    assert.equal(JSON.parse(log.args).idempotency_key, '***')
    assert.equal(JSON.parse(log.args).qty, 1)
    assert.equal(log.idempotency_key, write.key)
  })

  await t.test('owner permission is re-read on every call: removal denies the write, reads still work', async () => {
    assert.equal(db.prepare(whPerm).get().n, 1)
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code='purchase.inbound'").run()
    try {
      const before = txnCount()
      const denied = await stockIn(t1)
      assert.equal(toolErr(denied), 'TOKEN_OWNER_PERM_DENIED', JSON.stringify(denied.body).slice(0, 300))
      assert.equal(txnCount(), before)
      assert.ok(!toolNames(await mcp('tools/list', {}, t1)).includes('inventory.stock_in'))
      assert.ok(toolNames(await mcp('tools/list', {}, t1)).includes('inventory.query_stock'))
      assert.ok(okTool(await queryStock(t1)))
    } finally {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse','purchase.inbound')").run()
    }
    assert.ok(okTool(await stockIn(t1)), 'restored permission is honoured without re-issuing the token')
  })

  await t.test('owner auth_version bump (role permission change via API) kills tokens issued before it', async () => {
    const perms = db.prepare("SELECT perm_code FROM role_permissions WHERE role_code='warehouse'").all().map((r) => r.perm_code)
    const reduced = perms.filter((p) => p !== 'purchase.inbound')
    const r1 = await api('/api/auth/roles/warehouse/permissions', { token: admin, method: 'PUT', body: { permissions: reduced } })
    assert.equal(r1.status, 200, JSON.stringify(r1.body))
    assert.equal(rpcCode(await mcp('tools/list', {}, t1)), 'TOKEN_OWNER_REVOKED')
    assert.equal(rpcCode(await queryStock(t1)), 'TOKEN_OWNER_REVOKED')
    const t2 = issue('delegation-2')
    const denied = await stockIn(t2)
    assert.equal(toolErr(denied), 'TOKEN_OWNER_PERM_DENIED')
    assert.ok(okTool(await queryStock(t2)))
    const r2 = await api('/api/auth/roles/warehouse/permissions', { token: admin, method: 'PUT', body: { permissions: perms } })
    assert.equal(r2.status, 200)
    assert.equal(rpcCode(await queryStock(t2)), 'TOKEN_OWNER_REVOKED')
  })

  await t.test('effective data scope is token scope ∩ owner scope', async () => {
    const other = db.prepare('SELECT id FROM orgs WHERE id<>0 AND id<>? AND id NOT IN (SELECT org_id FROM warehouses WHERE org_id IS NOT NULL) ORDER BY id LIMIT 1').get(wh.org_id)
    assert.ok(other, 'demo data must provide an organization without warehouses')
    const r = await api(`/api/auth/users/${ownerId}`, { token: admin, method: 'PUT', body: { org_id: other.id, data_scope: 'org' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const t3 = issue('delegation-3')
    const before = txnCount()
    const out = await stockIn(t3)
    assert.equal(toolErr(out), 'ORG_OUT_OF_SCOPE', JSON.stringify(out.body).slice(0, 300))
    assert.equal(txnCount(), before)
    const rows = toolText(await queryStock(t3))?.list ?? toolText(await queryStock(t3))?.data?.list ?? []
    assert.ok(rows.every((row) => Number(row.owner_org_id) === other.id), 'reads outside the owner scope must not leak')
    // token bound to the warehouse org, owner bound elsewhere: the intersection is empty → fail closed
    const t4 = issue('delegation-4', { orgId: wh.org_id })
    assert.equal(toolErr(await stockIn(t4)), 'ORG_OUT_OF_SCOPE')
    const reset = await api(`/api/auth/users/${ownerId}`, { token: admin, method: 'PUT', body: { org_id: null, data_scope: 'all' } })
    assert.equal(reset.status, 200, JSON.stringify(reset.body))
  })

  await t.test('deactivating the owner revokes every active token in the same transaction; re-activation does not resurrect them', async () => {
    const t5 = issue('delegation-5')
    const t6 = issue('delegation-6', { scopes: 'read' })
    assert.ok(okTool(await queryStock(t5)))
    const off = await api(`/api/auth/users/${ownerId}`, { token: admin, method: 'PUT', body: { status: 'inactive' } })
    assert.equal(off.status, 200, JSON.stringify(off.body))
    assert.equal(tokenStatus(t5), 'revoked')
    assert.equal(tokenStatus(t6), 'revoked')
    const before = txnCount()
    for (const token of [t5, t6]) {
      assert.equal(rpcCode(await mcp('tools/list', {}, token)), 'TOKEN_REVOKED')
      assert.equal(rpcCode(await queryStock(token)), 'TOKEN_REVOKED')
      assert.equal(rpcCode(await stockIn(token)), 'TOKEN_REVOKED')
    }
    assert.equal(txnCount(), before)
    assert.throws(() => issue('delegation-dead'), { code: 'TOKEN_OWNER_INACTIVE' })
    const on = await api(`/api/auth/users/${ownerId}`, { token: admin, method: 'PUT', body: { status: 'active' } })
    assert.equal(on.status, 200)
    assert.equal(rpcCode(await queryStock(t5)), 'TOKEN_REVOKED')
    assert.equal(rpcCode(await queryStock(t6)), 'TOKEN_REVOKED')
    assert.ok(okTool(await queryStock(issue('delegation-7'))), 'a freshly issued token works after re-activation')
  })

  await t.test('owner status is re-read per call even when the revocation hook is bypassed', async () => {
    const t8 = issue('delegation-8')
    db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(ownerId)
    try {
      const before = txnCount()
      assert.equal(rpcCode(await mcp('tools/list', {}, t8)), 'TOKEN_OWNER_INACTIVE')
      assert.equal(rpcCode(await queryStock(t8)), 'TOKEN_OWNER_INACTIVE')
      assert.equal(rpcCode(await stockIn(t8)), 'TOKEN_OWNER_INACTIVE')
      assert.equal(rpcCode(await mcp('resources/read', { uri: 'gml://dashboard/kpi' }, t8)), 'TOKEN_OWNER_INACTIVE')
      assert.equal(txnCount(), before)
    } finally {
      db.prepare("UPDATE users SET status='active' WHERE id=?").run(ownerId)
    }
    db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(ownerId)
    assert.equal(rpcCode(await queryStock(t8)), 'TOKEN_OWNER_REVOKED')
  })

  await t.test('audit insert failure rolls back the write; reads stay best-effort', async () => {
    const t9 = issue('delegation-9')
    const before = txnCount()
    db.exec("CREATE TRIGGER mcp_audit_down BEFORE INSERT ON mcp_call_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END")
    let failed
    try {
      failed = await stockIn(t9)
      assert.equal(toolErr(failed), 'AUDIT_UNAVAILABLE', JSON.stringify(failed.body).slice(0, 300))
      assert.equal(txnCount(), before, 'business rows must roll back with the audit failure')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_idempotency WHERE idempotency_key=?').get(failed.key).n, 0)
      assert.ok(okTool(await queryStock(t9)), 'read tools keep working while audit is down')
    } finally {
      db.exec('DROP TRIGGER IF EXISTS mcp_audit_down')
    }
    const retry = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: wh.id, sku_id: sku.id, qty: 1, unit_cost: 10, idempotency_key: failed.key } }, t9)
    assert.ok(okTool(retry), 'the same idempotency key can be retried after the audit outage')
    assert.equal(retry.body.result._idempotent_replay, undefined)
    assert.equal(txnCount(), before + 1)
  })

  // ---- Z8：幂等缓存 / 二次确认命中前重验（ADR-0011 Z8 补充）----
  const cacheDenied = (key) => db.prepare("SELECT ok, error_code, result_summary FROM mcp_call_logs WHERE idempotency_key=? AND result_summary LIKE 'cache_denied%' ORDER BY id DESC").get(key)
  const replay = (token, key) => mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: wh.id, sku_id: sku.id, qty: 1, unit_cost: 10, idempotency_key: key } }, token)
  const otherOrg = () => db.prepare('SELECT id FROM orgs WHERE id<>0 AND id<>? AND id NOT IN (SELECT org_id FROM warehouses WHERE org_id IS NOT NULL) ORDER BY id LIMIT 1').get(wh.org_id)

  await t.test('Z8: replay after owner permission loss returns the current error, audits cache_denied, and never re-executes', async () => {
    const tz = issue('z8-perm')
    const first = await stockIn(tz)
    assert.ok(okTool(first), JSON.stringify(first.body).slice(0, 300))
    const rows = txnCount()
    const idemRows = db.prepare('SELECT COUNT(*) AS n FROM mcp_idempotency').get().n
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code='purchase.inbound'").run()
    try {
      const denied = await replay(tz, first.key)
      assert.equal(toolErr(denied), 'TOKEN_OWNER_PERM_DENIED', JSON.stringify(denied.body).slice(0, 300))
      assert.equal(denied.body.result._idempotent_replay, undefined, 'a denied replay must not carry cached data')
      const a = cacheDenied(first.key)
      assert.ok(a, 'denied replay must be audited with cache_denied')
      assert.equal(a.ok, 0)
      assert.equal(a.error_code, 'TOKEN_OWNER_PERM_DENIED')
      assert.equal(txnCount(), rows)
    } finally {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse','purchase.inbound')").run()
    }
    const served = await replay(tz, first.key)
    assert.ok(okTool(served))
    assert.equal(served.body.result._idempotent_replay, true, 'with permission restored the cache is served unchanged')
    assert.equal(txnCount(), rows, 'cache hit must not execute the handler again')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_idempotency').get().n, idemRows)
  })

  await t.test('Z8: replay after the owner data scope shrank is denied (domain scope), restored scope serves the cache', async () => {
    const tz = issue('z8-scope')
    const first = await stockIn(tz)
    assert.ok(okTool(first), JSON.stringify(first.body).slice(0, 300))
    const snap = JSON.parse(db.prepare('SELECT result_json FROM mcp_idempotency WHERE idempotency_key=?').get(first.key).result_json)
    assert.ok(snap && typeof snap === 'object', 'cache row is stored')
    const rows = txnCount()
    const other = otherOrg()
    assert.ok(other, 'demo data must provide an organization without warehouses')
    db.prepare("UPDATE users SET org_id=?, data_scope='org' WHERE id=?").run(other.id, ownerId)
    try {
      const denied = await replay(tz, first.key)
      assert.equal(toolErr(denied), 'ORG_OUT_OF_SCOPE', JSON.stringify(denied.body).slice(0, 300))
      assert.equal(denied.body.result._idempotent_replay, undefined)
      const a = cacheDenied(first.key)
      assert.ok(a && a.ok === 0 && a.error_code === 'ORG_OUT_OF_SCOPE', JSON.stringify(a))
      assert.equal(txnCount(), rows)
      // a brand-new key under the shrunken scope is refused by the handler as before
      assert.equal(toolErr(await stockIn(tz)), 'ORG_OUT_OF_SCOPE')
    } finally {
      db.prepare("UPDATE users SET org_id=NULL, data_scope='all' WHERE id=?").run(ownerId)
    }
    const served = await replay(tz, first.key)
    assert.equal(served.body.result._idempotent_replay, true)
    assert.equal(txnCount(), rows)
  })

  await t.test('Z8: a cache row written before the scope snapshot existed is served only when the current scope is unrestricted', async () => {
    const tz = issue('z8-legacy')
    const first = await stockIn(tz)
    assert.ok(okTool(first))
    const cached = JSON.parse(db.prepare('SELECT result_json FROM mcp_idempotency WHERE idempotency_key=?').get(first.key).result_json)
    const plain = cached && typeof cached === 'object' && 'data' in cached && '__replay' in cached ? cached.data : cached
    db.prepare('UPDATE mcp_idempotency SET result_json=? WHERE idempotency_key=?').run(JSON.stringify(plain), first.key)
    const rows = txnCount()
    const served = await replay(tz, first.key)
    assert.equal(served.body.result._idempotent_replay, true, 'legacy row served under unrestricted scope')
    const other = otherOrg()
    db.prepare("UPDATE users SET org_id=?, data_scope='org' WHERE id=?").run(other.id, ownerId)
    try {
      assert.equal(toolErr(await replay(tz, first.key)), 'ORG_OUT_OF_SCOPE', 'unknown original scope fails closed')
    } finally {
      db.prepare("UPDATE users SET org_id=NULL, data_scope='all' WHERE id=?").run(ownerId)
    }
    assert.equal(txnCount(), rows)
  })

  await t.test('Z8: perm-less write tool (doc.transition, edge permission checked inside the handler) is not replayed after the owner loses the edge permission', async () => {
    const tz = issue('z8-edge')
    const edges = db.prepare("SELECT a.doc_type, a.action, a.from_state, a.perm_code, d.table_name, d.status_field FROM doc_actions a JOIN doc_types d ON d.code=a.doc_type WHERE a.is_danger=0 AND a.perm_code IS NOT NULL AND a.perm_code<>''").all()
    let hit = null
    for (const e of edges) {
      let row
      try { row = db.prepare(`SELECT id FROM ${e.table_name} WHERE ${e.status_field}=? ORDER BY id LIMIT 1`).get(e.from_state) } catch { continue }
      if (!row) continue
      const held = !!db.prepare("SELECT 1 AS x FROM role_permissions WHERE role_code='warehouse' AND perm_code=?").get(e.perm_code)
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse',?)").run(e.perm_code)
      const key = `z8-edge-${Date.now()}-${++keySeq}`
      const args = { doc_type: e.doc_type, id: row.id, action: e.action, idempotency_key: key }
      const r = await mcp('tools/call', { name: 'doc.transition', arguments: args }, tz)
      if (okTool(r)) { hit = { e, args, key, held }; break }
      if (!held) db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code=?").run(e.perm_code)
    }
    assert.ok(hit, 'demo data must provide one doc edge the warehouse owner can drive through doc.transition')
    const call = () => mcp('tools/call', { name: 'doc.transition', arguments: hit.args }, tz)
    const had = db.prepare("SELECT 1 AS x FROM role_permissions WHERE role_code='warehouse' AND perm_code=?").get(hit.e.perm_code)
    assert.ok(had)
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code=?").run(hit.e.perm_code)
    try {
      const denied = await call()
      assert.equal(toolErr(denied), 'TOKEN_OWNER_PERM_DENIED', JSON.stringify(denied.body).slice(0, 300))
      assert.equal(denied.body.result._idempotent_replay, undefined)
      assert.ok(cacheDenied(hit.key))
    } finally {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse',?)").run(hit.e.perm_code)
    }
    assert.equal((await call()).body.result._idempotent_replay, true)
    if (!hit.held) db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code=?").run(hit.e.perm_code)
  })

  await t.test('Z8: a token that is not the original caller still gets IDEMPOTENCY_CONFLICT, never the cache', async () => {
    const a = issue('z8-a')
    const b = issue('z8-b')
    const first = await stockIn(a)
    assert.ok(okTool(first))
    const r = await replay(b, first.key)
    assert.equal(toolErr(r), 'IDEMPOTENCY_CONFLICT')
  })

  await t.test('Z8: confirmed confirmation is rechecked at use; a lost permission or scope leaves it unconsumed, a used one never re-executes', async () => {
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse','inventory.adjust')").run()
    const tz = issue('z8-confirm', { scopes: 'read,write,danger' })
    const args = { warehouse_id: wh.id, sku_id: sku.id, delta: 1, reason: 'z8 recheck' }
    const call = (extra = {}) => mcp('tools/call', { name: 'inventory.adjust', arguments: { ...args, ...extra } }, tz)
    const req = await call()
    const ct = toolText(req).confirm_token
    assert.ok(ct, JSON.stringify(req.body).slice(0, 300))
    db.prepare("UPDATE mcp_confirmations SET status='confirmed', confirmed_by='z8', confirmed_by_id=?, expires_at='2999-01-01 00:00:00' WHERE confirm_token=?").run(ownerId, ct)
    const status = () => db.prepare('SELECT status FROM mcp_confirmations WHERE confirm_token=?').get(ct).status
    const rows = txnCount()
    // permission loss
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code='inventory.adjust'").run()
    try {
      const denied = await call({ confirm_token: ct })
      assert.equal(toolErr(denied), 'TOKEN_OWNER_PERM_DENIED', JSON.stringify(denied.body).slice(0, 300))
      assert.equal(status(), 'confirmed', 'denied use must not consume the confirmation')
      assert.equal(txnCount(), rows)
      const a = db.prepare("SELECT error_code, result_summary FROM mcp_call_logs WHERE tool_name='inventory.adjust' AND ok=0 AND result_summary LIKE 'cache_denied%' ORDER BY id DESC").get()
      assert.equal(a?.error_code, 'TOKEN_OWNER_PERM_DENIED', 'confirm-cache denial is audited with cache_denied')
    } finally {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('warehouse','inventory.adjust')").run()
    }
    // scope loss
    const other = otherOrg()
    db.prepare("UPDATE users SET org_id=?, data_scope='org' WHERE id=?").run(other.id, ownerId)
    try {
      assert.equal(toolErr(await call({ confirm_token: ct })), 'ORG_OUT_OF_SCOPE')
      assert.equal(status(), 'confirmed')
      assert.equal(txnCount(), rows)
    } finally {
      db.prepare("UPDATE users SET org_id=NULL, data_scope='all' WHERE id=?").run(ownerId)
    }
    // restored: executes exactly once
    const done = await call({ confirm_token: ct })
    assert.ok(okTool(done), JSON.stringify(done.body).slice(0, 300))
    assert.equal(status(), 'used')
    const after = txnCount()
    assert.ok(after > rows)
    const again = await call({ confirm_token: ct })
    assert.equal(toolErr(again), 'CONFIRM_NOT_APPROVED')
    assert.equal(txnCount(), after, 'a used confirmation is never replayed')
    db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code='inventory.adjust'").run()
  })

  await t.test('ownerless tokens stay independent principals limited to their declared scope', async () => {
    const t10 = createToken(db, { name: 'delegation-ownerless', industry: 'cosmetic', scopes: 'read' }).token
    assert.ok(okTool(await queryStock(t10)))
    assert.equal(toolErr(await stockIn(t10)), 'SCOPE_DENIED')
  })
})
