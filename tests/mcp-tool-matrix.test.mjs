// ADR-0011 矩阵验收（W5）：tools/list 枚举出的**每一个** MCP 工具 × 三种所有者状态
//   ① 所有者停用  ② 所有者角色失去该工具所需权限  ③ 所有者数据范围排除了目标
// 都必须被稳定拒绝（或在"读工具"上只返回空集），且任何业务表行数不变。
// 矩阵写成 JSON 放在测试临时目录，并断言覆盖数 == 工具数；新增工具而没有进矩阵会让本测试变红。
// 只在全新临时数据目录 + 随机回环端口上跑（GML_RUNTIME_MODE=test）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createToken } from '../server/mcp/tokens.js'
import { TOOLS } from '../server/mcp/tools.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-mcp-matrix-'))
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
      signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, body: await res.json() }
  }
  let seq = 0
  const mcp = async (method, params, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  return { dir, api, mcp, db }
}

// ---- 结果解析 ----------------------------------------------------------------
const rpcCode = (r) => r.body?.error?.data?.code ?? null
const payload = (r) => {
  const text = r.body?.result?.content?.[0]?.text
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return text }
}
const toolErr = (r) => (r.body?.result?.isError ? payload(r)?.error ?? 'UNKNOWN_TOOL_ERROR' : null)
/** 归一成 {kind, code}：rpc = 凭据层拒绝；tool_error = 工具级拒绝；confirmation = 高危工具只发了确认单；ok = 执行了 */
function outcome(r) {
  if (r.body?.error) return { kind: 'rpc', code: rpcCode(r) ?? `RPC${r.body.error.code}` }
  const e = toolErr(r)
  if (e) return { kind: 'tool_error', code: e }
  if (payload(r)?.status === 'confirmation_required') return { kind: 'confirmation', code: 'CONFIRMATION_REQUIRED', confirm_token: payload(r).confirm_token }
  return { kind: 'ok', code: null }
}

// 允许的"范围外"拒绝码：ORG_OUT_OF_SCOPE 是约定码；单据类工具按"越界当作不存在"报 404 类码（不泄露存在性）
const SCOPE_DENY_CODES = new Set(['ORG_OUT_OF_SCOPE', 'NOT_FOUND', 'TARGET_NOT_FOUND', 'DOC_NOT_FOUND', 'REQUISITION_NOT_FOUND', 'ORDER_NOT_FOUND', 'WAREHOUSE_NOT_FOUND', 'APPROVAL_NOT_FOUND'])
const PERM_DENY_CODES = new Set(['TOKEN_OWNER_PERM_DENIED', 'PERM_DENIED'])
// 这几个读工具在 HTTP 侧（dashboard / docflow / 组织树）同样只要登录、没有功能权限点，MCP 与之同口径；
// 它们的"权限状态"格子记为 NO_PERM_POINT（不是漏判），范围与停用两格仍照常断言。
const PERM_FREE_READS = new Set(['report.dashboard_kpi', 'org.tree', 'doc.list_types', 'doc.query', 'doc.get'])
// 读工具在范围外的期望：'empty' = 列表必须为空；'global' = 主数据 / 字典 / 无组织归属，不按组织过滤（与 HTTP 同口径）
const READ_SCOPE_EXPECT = {
  'master.search_products': 'global', 'master.get_product_360': 'global', 'master.list_partners': 'global',
  'inventory.get_cost': 'global', 'doc.list_types': 'global',
  // 组织树按范围收窄：只能看到范围内组织及其祖先
  'org.tree': 'org_tree'
}
// 价格是全局主数据，HTTP 的 `master.price.edit` 也只验权限点、不按组织收窄；MCP 与之同口径。
// 范围外状态下它仍会执行，但只允许碰价格表本身（改价 + 改价留痕），其余任何业务表行数变化都算泄露。
const SCOPE_GLOBAL_WRITES = { 'pricing.update_price': /^(products|product_skus|price_[a-z_]*|audit_logs)$/ }

/** 把一个 JSON Schema 属性实例化成最小合法值；`*_id` 之类走夹具表 */
function sample(key, p, fx) {
  if (key in fx) return fx[key]
  if (p.enum) return p.enum[0]
  switch (p.type) {
    case 'integer': return Math.max(1, Math.floor((p.exclusiveMinimum ?? p.minimum ?? 0) + 1))
    case 'number': return (p.exclusiveMinimum != null ? p.exclusiveMinimum + 1 : (p.minimum ?? 0) + 1)
    case 'boolean': return false
    case 'array': return [Object.fromEntries(Object.entries(p.items?.properties || {}).filter(([k]) => (p.items.required || []).includes(k)).map(([k, v]) => [k, sample(k, v, fx)]))]
    default: return 'x'
  }
}

test('MCP delegation matrix: every tool x {owner inactive, permission removed, scope excluded}', { timeout: 600000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data
  assert.ok(admin?.token, 'demo admin must log in')
  const adminId = admin.user?.id ?? db.prepare("SELECT id FROM users WHERE username='admin'").get().id

  const owner = (await api('/api/auth/users', { token: admin.token, body: { username: 'matrix_owner', name: 'Matrix owner', role: 'warehouse', password: secret(), data_scope: 'all' } })).body
  assert.equal(owner.success, true, JSON.stringify(owner))
  const ownerId = owner.data.id

  // 所有者角色：授予全部工具声明的权限点 + 请购/订单等边权限（直接写库，不递增 auth_version，令牌保持有效）
  const toolPerms = [...new Set(TOOLS.flatMap((x) => x.perms || []))]
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const p of toolPerms) grant.run('warehouse', p)
  const rolePerms = () => db.prepare("SELECT perm_code FROM role_permissions WHERE role_code='warehouse'").all().map((x) => x.perm_code)
  const fullRolePerms = rolePerms()
  const restorePerms = () => { db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse'").run(); for (const p of fullRolePerms) grant.run('warehouse', p) }
  const dropPerms = (codes) => { const del = db.prepare("DELETE FROM role_permissions WHERE role_code='warehouse' AND perm_code=?"); for (const c of codes) del.run(c) }

  const token = createToken(db, { name: 'matrix', ownerUserId: ownerId, industry: 'cosmetic', scopes: 'read,write,danger' }).token

  // ---- 夹具 ----
  const wh = db.prepare("SELECT id, org_id FROM warehouses WHERE status='active' AND org_id IS NOT NULL ORDER BY id LIMIT 1").get()
  const wh2 = db.prepare("SELECT id, org_id FROM warehouses WHERE status='active' AND org_id IS NOT NULL AND id<>? ORDER BY id LIMIT 1").get(wh.id)
  const sku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get()
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()
  const one = (table, where = '1=1') => db.prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`).get()?.id ?? 1
  // 数据范围"排除"用的组织：一个**全新的、没有任何业务数据**的组织，
  // 否则"范围内仍有数据"会被误判成泄露（演示库里每个组织都被某处引用）。
  const bareId = db.prepare("INSERT INTO orgs (code, name, type, level) VALUES ('MATRIX-BARE', 'Matrix bare org', 'region', 1)").run().lastInsertRowid
  db.prepare('UPDATE orgs SET path=? WHERE id=?').run(`/${bareId}/`, bareId)
  const outsideOrg = { id: Number(bareId) }
  assert.ok(wh && wh2 && sku && supplier && outsideOrg, 'demo data must provide warehouses, a SKU, a supplier and a bare organization')
  const doc = db.prepare('SELECT doc_no FROM purchase_orders ORDER BY id LIMIT 1').get()
  /** 找一张"当前状态下确有一条（可限定）流转边"的单据，让权限 / 范围判定先于"状态不允许"被触达 */
  const edgeDoc = (docType, { actions = null, safeOnly = false } = {}) => {
    const t = db.prepare('SELECT table_name, status_field FROM doc_types WHERE code=?').get(docType)
    const sf = t.status_field || 'status'
    for (const row of db.prepare(`SELECT id, ${sf} AS st FROM ${t.table_name} ORDER BY id DESC`).all()) {
      const e = db.prepare('SELECT action FROM doc_actions WHERE doc_type=? AND from_state=?' + (safeOnly ? ' AND is_danger=0' : '')).all(docType, row.st)
        .find((x) => !actions || actions.includes(x.action))
      if (e) return { id: row.id, action: e.action }
    }
    throw new Error(`fixture: no actionable ${docType} document in demo data`)
  }
  const prq = edgeDoc('PRQ', { actions: ['submit', 'approve', 'reject', 'close', 'cancel'] })
  const po = edgeDoc('PO', { actions: ['submit', 'approve', 'receive', 'partial', 'close', 'cancel'] })
  const pi = edgeDoc('PI', { actions: ['submit', 'verify', 'post', 'void'] })
  const pst = edgeDoc('PST', { actions: ['submit', 'audit', 'settle', 'void'] })
  const pay = edgeDoc('PAY', { actions: ['submit', 'pay', 'void'] })
  const dt = edgeDoc('PO', { safeOnly: true })
  const approvedPo = one('purchase_orders', "status='approved'")
  const cancellableOrder = one('sales_orders', "status='confirmed'")
  // 一张待审批实例（真实挂在一张采购订单上），让 approval.approve 在范围外也有"目标"可被拒
  const inst = db.prepare("INSERT INTO approval_instances (doc_type, doc_id, doc_no, action, status) VALUES ('PO', ?, ?, 'submit', 'pending')").run(po.id, doc?.doc_no ?? 'x').lastInsertRowid

  // 显式参数覆盖表：schema 自动生成不够的工具（单据 id、嵌套行、业务关联）在这里维护
  const FX = {
    warehouse_id: wh.id, from_warehouse_id: wh.id, to_warehouse_id: wh2.id, target_warehouse_id: wh2.id,
    sku_id: sku.id, supplier_id: supplier.id, from_owner_org_id: wh.org_id, to_owner_org_id: wh2.org_id,
    order_id: cancellableOrder, requisition_id: one('purchase_requisitions', "status='approved'"),
    invoice_id: pi.id, settlement_id: pst.id, payment_id: pay.id,
    doc_no: doc?.doc_no ?? 'x', doc_type: 'PO', id: dt.id, action: 'submit', amount: 1, qty: 1, unit_cost: 10, delta: 1, reason: 'matrix'
  }
  const OVERRIDES = {
    'purchase.create_requisition': { lines: [{ sku_id: sku.id, qty: 1 }] },
    'purchase.create_invoice': { lines: [{ sku_id: sku.id, qty: 1, price: 1 }] },
    'purchase.create_order': { items: [{ sku_id: sku.id, qty: 1, price: 1 }] },
    'purchase.create_return': { items: [{ sku_id: sku.id, qty: 1, price: 1 }] },
    'approval.approve': { instance_id: inst },
    'purchase.advance_requisition': { requisition_id: prq.id, action: prq.action },
    'purchase.convert_requisition': { requisition_id: one('purchase_requisitions', "status='approved'") },
    'purchase.advance_order': { order_id: po.id, action: po.action },
    'purchase.receive_order': { order_id: approvedPo },
    'purchase.advance_invoice': { invoice_id: pi.id, action: pi.action },
    'purchase.advance_settlement': { settlement_id: pst.id, action: pst.action },
    'purchase.advance_payment': { payment_id: pay.id, action: pay.action },
    'sales.cancel_order': { order_id: cancellableOrder, reason: 'matrix' },
    'pricing.update_price': { sku_id: sku.id, price_retail: 99, reason: 'matrix' },
    'master.get_product_360': { sku_id: sku.id },
    'doc.transition': { doc_type: 'PO', id: dt.id, action: dt.action },
    'doc.get': { doc_type: 'PO', id: po.id }
  }
  let seq = 0
  const argsFor = (tool) => {
    const s = tool.inputSchema || {}
    const out = {}
    for (const k of s.required || []) out[k] = sample(k, s.properties?.[k] || {}, FX)
    Object.assign(out, OVERRIDES[tool.name] || {})
    if (tool.level === 'write') out.idempotency_key = `matrix-${tool.name}-${Date.now()}-${++seq}`
    return out
  }

  // ---- 业务表行数快照（排除 MCP 自身的审计 / 幂等 / 确认单 / 令牌与会话类表）----
  const EXCLUDE = /^(mcp_|agent_tokens$|sqlite_|login_|auth_sessions$|user_sessions$|sessions$)/
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name).filter((n) => !EXCLUDE.test(n))
  const counters = tables.map((n) => [n, db.prepare(`SELECT COUNT(*) AS c FROM "${n}"`)])
  const snapshot = () => Object.fromEntries(counters.map(([n, st]) => [n, st.get().c]))
  const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`)

  /** 调工具；高危工具先申请确认单，再由 `confirmer` 签字后带 confirm_token 重放。 */
  async function invoke(tool, args, { confirmer = adminId, execute = true } = {}) {
    // 每次调用换新幂等键：同键重放会命中首次结果缓存（ADR-0011 矩阵验收节记录），那不是在测所有者状态
    if (tool.level === 'write') args = { ...args, idempotency_key: `matrix-${tool.name}-${Date.now()}-${++seq}` }
    const first = await mcp('tools/call', { name: tool.name, arguments: args }, token)
    const o1 = outcome(first)
    if (tool.level !== 'danger' || o1.kind !== 'confirmation' || !execute) return { first: o1, final: o1 }
    db.prepare("UPDATE mcp_confirmations SET status='confirmed', confirmed_by=?, confirmed_by_id=?, expires_at='2999-01-01 00:00:00' WHERE confirm_token=?").run('matrix confirmer', confirmer, o1.confirm_token)
    const second = await mcp('tools/call', { name: tool.name, arguments: { ...args, confirm_token: o1.confirm_token } }, token)
    return { first: o1, final: outcome(second) }
  }

  // ---- 基线：列出全部工具 ----
  const listed = await mcp('tools/list', {}, token)
  const names = (listed.body.result?.tools || []).map((x) => x.name)
  assert.equal(names.length, TOOLS.length, 'owner in good standing with full scopes must see every tool')
  assert.deepEqual([...names].sort(), TOOLS.map((x) => x.name).sort())
  const tools = names.map((n) => TOOLS.find((x) => x.name === n))

  const matrix = { generated_for: 'ADR-0011 matrix acceptance', tool_count: tools.length, states: ['owner_inactive', 'permission_removed', 'scope_excluded'], tools: {} }
  const failures = []
  const record = (tool, state, cell) => { (matrix.tools[tool.name] ||= { level: tool.level, perms: tool.perms || [], states: {} }).states[state] = cell }

  // 基线探测：参数必须合法（不被入参校验挡掉），否则后面三态的拒绝可能只是"参数不对"造成的假阳性
  const VALIDATION = /^(INVALID_ARGS|INVALID_ARGUMENT|VALIDATION|MISSING_REQUIRED|MISSING_ARGS|INVALID_PARAMS?)/i
  const baseline = {}
  for (const tool of tools) {
    const args = argsFor(tool)
    const r = await invoke(tool, args, { execute: false })
    baseline[tool.name] = { args, outcome: r.final.kind === 'confirmation' ? r.first : r.final }
    const code = r.final.code || ''
    if (r.final.kind === 'rpc' || r.final.kind === 'tool_error' && tool.level !== 'read' && false || VALIDATION.test(code) || code === 'TOOL_NOT_FOUND' || code === 'IDEMPOTENCY_REQUIRED') failures.push(`baseline ${tool.name}: ${r.final.kind}/${code}`)
    matrix.tools[tool.name] = { level: tool.level, perms: tool.perms || [], baseline: { kind: r.final.kind, code: r.final.code }, states: {} }
  }

  // ---- 状态 1：所有者停用（绕过吊销钩子，直接改库 → 逐调用复读）----
  db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(ownerId)
  try {
    const list = await mcp('tools/list', {}, token)
    if (rpcCode(list) !== 'TOKEN_OWNER_INACTIVE') failures.push(`inactive tools/list: ${JSON.stringify(list.body).slice(0, 200)}`)
    for (const tool of tools) {
      const before = snapshot()
      const r = await invoke(tool, baseline[tool.name].args)
      const changed = diff(before, snapshot())
      const ok = r.final.kind === 'rpc' && r.final.code === 'TOKEN_OWNER_INACTIVE' && changed.length === 0
      record(tool, 'owner_inactive', { result: ok ? 'DENIED' : 'LEAK', code: r.final.code, rows_changed: changed })
      if (!ok) failures.push(`owner_inactive ${tool.name}: ${r.final.kind}/${r.final.code} ${changed.join(';')}`)
    }
  } finally {
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(ownerId)
  }

  // ---- 状态 2：所有者角色失去该工具所需权限 ----
  for (const tool of tools) {
    const needs = tool.perms || []
    const permFree = needs.length === 0
    // 声明了 perms 的工具：只撤它自己要的权限点（精确证明"这一个权限点"在起作用）；
    // 无 perms 的工具（边权限 / 无权限点）：撤掉角色的全部权限，看它是否仍然动得了东西。
    dropPerms(permFree ? fullRolePerms : needs)
    try {
      const before = snapshot()
      // 高危且无 perms 的采购推进类：执行人是确认单上的签字人 → 用"被撤权的所有者"做签字人，证明边权限是实时判的
      const r = await invoke(tool, baseline[tool.name].args, { confirmer: ownerId })
      const changed = diff(before, snapshot())
      let result
      if (needs.length) result = PERM_DENY_CODES.has(r.final.code) && r.final.kind === 'tool_error' ? 'DENIED' : 'LEAK'
      else if (PERM_FREE_READS.has(tool.name)) result = r.final.kind === 'ok' ? 'NO_PERM_POINT' : 'LEAK'
      else result = r.final.kind === 'tool_error' && PERM_DENY_CODES.has(r.final.code) ? 'DENIED' : 'LEAK'
      if (changed.length) result = 'LEAK'
      record(tool, 'permission_removed', { result, code: r.final.code, removed: permFree ? 'ALL_ROLE_PERMS' : needs, rows_changed: changed })
      if (result === 'LEAK') failures.push(`permission_removed ${tool.name}: ${r.final.kind}/${r.final.code} ${changed.join(';')}`)
      // 工具列表也必须同步（列得出的才调得到）
      if (needs.length) {
        const nowListed = (await mcp('tools/list', {}, token)).body.result?.tools?.map((x) => x.name) || []
        if (nowListed.includes(tool.name)) failures.push(`permission_removed ${tool.name}: still listed in tools/list`)
      }
    } finally {
      restorePerms()
    }
  }

  // ---- 状态 3：所有者数据范围改为一个不含任何目标的组织 ----
  db.prepare("UPDATE users SET org_id=?, data_scope='org' WHERE id=?").run(outsideOrg.id, ownerId)
  try {
    const countRows = (v) => {
      if (Array.isArray(v)) return v.length + v.reduce((s, x) => s + countRows(x), 0)
      if (v && typeof v === 'object') return Object.values(v).reduce((s, x) => s + countRows(x), 0)
      return 0
    }
    for (const tool of tools) {
      const before = snapshot()
      const args = baseline[tool.name].args
      const r = await invoke(tool, args)
      const changed = diff(before, snapshot())
      let result
      if (tool.level === 'read') {
        const expect = READ_SCOPE_EXPECT[tool.name] || 'empty'
        const res = await mcp('tools/call', { name: tool.name, arguments: args }, token)
        const data = payload(res)
        const rows = countRows(data)
        if (expect === 'global') result = r.final.kind === 'ok' ? 'GLOBAL_OK' : 'LEAK'
        else if (expect === 'org_tree') result = r.final.kind === 'ok' && (data.list || []).every((o) => o.id === outsideOrg.id) ? 'SCOPED' : 'LEAK'
        else result = r.final.kind === 'tool_error' && SCOPE_DENY_CODES.has(r.final.code) ? 'DENIED' : (r.final.kind === 'ok' && rows === 0 ? 'EMPTY' : 'LEAK')
        record(tool, 'scope_excluded', { result, code: r.final.code, rows_visible: r.final.kind === 'ok' ? rows : null, rows_changed: changed })
      } else if (SCOPE_GLOBAL_WRITES[tool.name]) {
        const tablesChanged = changed.map((x) => x.split(':')[0])
        result = r.final.kind === 'ok' && tablesChanged.every((n) => SCOPE_GLOBAL_WRITES[tool.name].test(n)) ? 'GLOBAL_PARITY' : 'LEAK'
        record(tool, 'scope_excluded', { result, code: r.final.code, rows_changed: changed, note: 'global master data; same gate as HTTP master.price.edit' })
        matrix.tools[tool.name].states.scope_excluded.result = result
        if (result === 'LEAK') failures.push(`scope_excluded ${tool.name}: ${r.final.kind}/${r.final.code} ${changed.join(';')}`)
        continue
      } else {
        result = r.final.kind === 'tool_error' && SCOPE_DENY_CODES.has(r.final.code) ? 'DENIED' : 'LEAK'
        record(tool, 'scope_excluded', { result, code: r.final.code, rows_changed: changed })
      }
      if (changed.length) result = 'LEAK'
      matrix.tools[tool.name].states.scope_excluded.result = result
      if (result === 'LEAK') failures.push(`scope_excluded ${tool.name}: ${r.final.kind}/${r.final.code} ${changed.join(';')}`)
    }
  } finally {
    db.prepare('UPDATE users SET org_id=NULL, data_scope=? WHERE id=?').run('all', ownerId)
  }

  // ---- 产出矩阵并断言覆盖 ----
  const file = path.join(f.dir, 'mcp-tool-matrix.json')
  writeFileSync(file, JSON.stringify(matrix, null, 2))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const covered = Object.values(saved.tools).filter((x) => saved.states.every((s) => x.states[s])).length
  if (process.env.MCP_MATRIX_PRINT) console.log(JSON.stringify(saved, null, 1))
  assert.equal(covered, TOOLS.length, 'matrix must cover every tool in every state')
  assert.equal(saved.tool_count, TOOLS.length)
  assert.deepEqual(failures, [], `tools that slipped through:\n${failures.join('\n')}`)
  assert.ok(Object.values(saved.tools).every((x) => Object.values(x.states).every((c) => c.result !== 'LEAK')))
})
