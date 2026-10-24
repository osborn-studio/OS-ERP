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
import { DOC_VIEW_PERMS } from '../server/mcp/doc-perms.js'

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
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex'),
    GML_MCP_TOKEN_RPM: '100000', GML_MCP_WRITE_RPM: '100000' // 本矩阵是穷举压测（AD9 默认写 60/分会误伤），限流行为见 mcp-rate-limit.test.mjs
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
const DOC_READ_TOOLS = new Set(['doc.list_types', 'doc.query', 'doc.get'])
const PERM_DENY_CODES = new Set(['TOKEN_OWNER_PERM_DENIED', 'PERM_DENIED'])
// 这两个读工具在 HTTP 侧（dashboard / 组织树）同样只要登录、没有功能权限点，MCP 与之同口径；
// 它们的"权限状态"格子记为 NO_PERM_POINT（不是漏判），范围与停用两格仍照常断言。
// X5：doc.list_types / doc.query / doc.get 已按单据类型校验所有者的查看权限（server/mcp/doc-perms.js），
// 不再属于此列表——权限移除状态下它们必须是 DENIED（TOKEN_OWNER_PERM_DENIED）。
const PERM_FREE_READS = new Set(['report.dashboard_kpi', 'org.tree'])
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
      // 高危且无 perms 的采购推进类：执行人是确认单上的签字人。这里让一个**仍有全部权限**的人（超管 admin）签字，
      // 证明拒绝来自"所有者此刻没有这条边 / 权限点"，而不是签字人没权限（Codex 审计指出：不能用被撤权的所有者自签来证明）。
      const r = await invoke(tool, baseline[tool.name].args, { confirmer: adminId })
      const changed = diff(before, snapshot())
      let result
      if (needs.length) result = PERM_DENY_CODES.has(r.final.code) && r.final.kind === 'tool_error' ? 'DENIED' : 'LEAK'
      else if (PERM_FREE_READS.has(tool.name)) result = r.final.kind === 'ok' ? 'NO_PERM_POINT' : 'LEAK'
      else result = r.final.kind === 'tool_error' && PERM_DENY_CODES.has(r.final.code) ? 'DENIED' : 'LEAK'
      // X5：通用单据读工具必须是精确的 TOKEN_OWNER_PERM_DENIED，不是别的 403/404
      if (DOC_READ_TOOLS.has(tool.name) && !(result === 'DENIED' && r.final.code === 'TOKEN_OWNER_PERM_DENIED')) result = 'LEAK'
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

  // ---- 状态 5（Z8）：写型工具先成功一次（幂等缓存落下），所有者随后失权 / 缩范围，再用同一幂等键重放 ----
  // 重放必须得到**当前**错误（权限点 / 数据范围），而不是缓存里的旧结果；业务表行数不变；
  // 失权恢复之后同一键才回放缓存（_idempotent_replay），且仍不新增任何业务行。
  matrix.replay_state = { state: 'replay_after_permission_loss', tools: {} }
  {
    const replayFailures = []
    for (const tool of tools.filter((x) => x.level === 'write')) {
      const needs = tool.perms || []
      const key = `matrix-replay-${tool.name}-${Date.now()}-${++seq}`
      const args = { ...baseline[tool.name].args, idempotency_key: key }
      const first = await mcp('tools/call', { name: tool.name, arguments: args }, token)
      if (outcome(first).kind !== 'ok') {
        matrix.replay_state.tools[tool.name] = { result: 'NO_CACHE', first: outcome(first).code }
        continue
      }
      const cell = {}
      // ① 权限点被撤
      dropPerms(needs.length ? needs : fullRolePerms)
      try {
        const before = snapshot()
        const r = await mcp('tools/call', { name: tool.name, arguments: args }, token)
        const o = outcome(r)
        const changed = diff(before, snapshot())
        cell.permission_removed = { code: o.code, replayed: r.body?.result?._idempotent_replay === true, rows_changed: changed }
        if (!(o.kind === 'tool_error' && PERM_DENY_CODES.has(o.code)) && !(o.kind === 'tool_error' && SCOPE_DENY_CODES.has(o.code)) || cell.permission_removed.replayed || changed.length) {
          replayFailures.push(`replay permission_removed ${tool.name}: ${o.kind}/${o.code} replayed=${cell.permission_removed.replayed} ${changed.join(';')}`)
        }
      } finally {
        restorePerms()
      }
      // ② 数据范围被缩到无关组织
      db.prepare("UPDATE users SET org_id=?, data_scope='org' WHERE id=?").run(outsideOrg.id, ownerId)
      try {
        const before = snapshot()
        const r = await mcp('tools/call', { name: tool.name, arguments: args }, token)
        const o = outcome(r)
        const changed = diff(before, snapshot())
        cell.scope_excluded = { code: o.code, replayed: r.body?.result?._idempotent_replay === true, rows_changed: changed }
        if (!(o.kind === 'tool_error' && SCOPE_DENY_CODES.has(o.code)) || cell.scope_excluded.replayed || changed.length) {
          replayFailures.push(`replay scope_excluded ${tool.name}: ${o.kind}/${o.code} replayed=${cell.scope_excluded.replayed} ${changed.join(';')}`)
        }
      } finally {
        db.prepare('UPDATE users SET org_id=NULL, data_scope=? WHERE id=?').run('all', ownerId)
      }
      // ③ 全部恢复：同一键回放缓存，不再动业务行
      {
        const before = snapshot()
        const r = await mcp('tools/call', { name: tool.name, arguments: args }, token)
        const changed = diff(before, snapshot())
        cell.restored = { replayed: r.body?.result?._idempotent_replay === true, rows_changed: changed }
        if (!cell.restored.replayed || changed.length) replayFailures.push(`replay restored ${tool.name}: replayed=${cell.restored.replayed} ${changed.join(';')}`)
      }
      cell.result = replayFailures.some((x) => x.includes(` ${tool.name}:`)) ? 'LEAK' : 'DENIED'
      matrix.replay_state.tools[tool.name] = cell
    }
    failures.push(...replayFailures)
    const covered = Object.values(matrix.replay_state.tools).filter((x) => x.result === 'DENIED').length
    assert.ok(covered >= 4, `expected several write tools to exercise the replay state, got ${covered}`)
  }

  // ---- 状态 4（Y6）：所有者缺门店 / 经销商绑定 ----
  // 通用单据读工具对「HTTP 侧按门店 / 经销商绑定」的类型，在所有者拥有查看权限点但没有绑定时必须拒绝
  // （TOKEN_OWNER_BINDING_REQUIRED），list_types 不列出；有绑定后只放行绑定对象自己的单据。
  // 订货中心（OC/OCS）的 subject 绑定只约束外部主体（dealer/store 角色），由 mcp-doc-perms.test.mjs 覆盖。
  matrix.binding_state = { state: 'owner_lacks_binding', types: {} }
  {
    const hard = Object.entries(DOC_VIEW_PERMS).filter(([, e]) => e.binding === 'store' || e.binding === 'dealer')
    assert.ok(hard.length >= 6, 'expected store/dealer bound doc types')
    for (const [, e] of hard) for (const p of e.perms) grant.run('warehouse', p)
    db.prepare('UPDATE users SET store_id=NULL, dealer_id=NULL WHERE id=?').run(ownerId)
    try {
      const lt = await mcp('tools/call', { name: 'doc.list_types', arguments: {} }, token)
      const listedCodes = payload(lt)?.doc_types?.map((x) => x.code) || []
      for (const [code, e] of hard) {
        const any = db.prepare(`SELECT id FROM ${db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(code).table_name} ORDER BY id LIMIT 1`).get()
        const before = snapshot()
        const q = outcome(await mcp('tools/call', { name: 'doc.query', arguments: { doc_type: code } }, token))
        const g = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: any.id } }, token))
        const changed = diff(before, snapshot())
        const ok = q.code === 'TOKEN_OWNER_BINDING_REQUIRED' && g.code === 'TOKEN_OWNER_BINDING_REQUIRED' && !listedCodes.includes(code) && changed.length === 0
        matrix.binding_state.types[code] = { binding: e.binding, result: ok ? 'DENIED' : 'LEAK', query: q.code, get: g.code, listed: listedCodes.includes(code) }
        if (!ok) failures.push(`owner_lacks_binding ${code}: query=${q.kind}/${q.code} get=${g.kind}/${g.code} listed=${listedCodes.includes(code)} ${changed.join(';')}`)
      }
    } finally {
      restorePerms()
    }
  }

  // ---- 状态 4b（AB7）：RC / YQ / SH 的门店绑定在 DOC_SCOPE_RESOLVERS 里声明 ----
  // 三类 × {所有者绑定本店、未绑定}：绑定 ⇒ 本店单据可读、他店 NOT_FOUND（doc.get / order.trace_document）；
  // 未绑定 ⇒ 全部拒绝；全程零写。
  matrix.registry_binding_state = { state: 'registry_store_binding', types: {} }
  {
    const types = ['PS', 'PSF', 'RC', 'YQ', 'SH']
    for (const code of types) for (const p of DOC_VIEW_PERMS[code].perms) grant.run('warehouse', p)
    for (const p of ['sales.order.view', 'purchase.order.view', 'inventory.stock.view']) grant.run('warehouse', p)
    try {
      for (const code of types) {
        const { table_name: tn, doc_no_field: nf } = db.prepare('SELECT table_name, doc_no_field FROM doc_types WHERE code=?').get(code)
        const noCol = nf || 'doc_no'
        const stores = db.prepare(`SELECT store_id FROM ${tn} WHERE store_id IS NOT NULL GROUP BY store_id ORDER BY COUNT(*) DESC, store_id LIMIT 2`).all()
        assert.equal(stores.length, 2, `${code}: fixture needs two stores with documents`)
        const rowOf = (sid) => db.prepare(`SELECT id, ${noCol} AS dn FROM ${tn} WHERE store_id=? ORDER BY id LIMIT 1`).get(sid)
        const own = rowOf(stores[0].store_id)
        const foreign = rowOf(stores[1].store_id)
        const cell = {}
        const before = snapshot()
        db.prepare('UPDATE users SET store_id=? WHERE id=?').run(stores[0].store_id, ownerId)
        cell.bound_own = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: own.id } }, token)).kind
        cell.bound_foreign = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: foreign.id } }, token)).code
        cell.trace_foreign = outcome(await mcp('tools/call', { name: 'order.trace_document', arguments: { doc_no: String(foreign.dn) } }, token)).code
        db.prepare('UPDATE users SET store_id=NULL WHERE id=?').run(ownerId)
        cell.unbound_get = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: own.id } }, token)).code
        cell.unbound_trace = outcome(await mcp('tools/call', { name: 'order.trace_document', arguments: { doc_no: String(own.dn) } }, token)).code
        const changed = diff(before, snapshot())
        const good = cell.bound_foreign === 'NOT_FOUND' && cell.trace_foreign === 'NOT_FOUND' && cell.unbound_get === 'TOKEN_OWNER_BINDING_REQUIRED' && cell.unbound_trace === 'NOT_FOUND' && changed.length === 0
        matrix.registry_binding_state.types[code] = { ...cell, result: good ? 'DENIED' : 'LEAK' }
        if (!good) failures.push(`registry_store_binding ${code}: ${JSON.stringify(cell)} ${changed.join(';')}`)
      }
    } finally {
      restorePerms()
    }
  }

  // ---- 状态 4c（AC3）：DR（dealer 绑定）与 DS / RB（hq：无自视图）在 DOC_SCOPE_RESOLVERS 里声明 ----
  // DR：绑他家经销商 ⇒ 本家单据可读、他家 NOT_FOUND，未绑定 ⇒ BINDING_REQUIRED；DS / RB：任何经销商 / 门店绑定的账号读不到，全程零写。
  matrix.registry_ac3_state = { state: 'registry_dealer_hq_binding', types: {} }
  {
    const types = ['DR', 'DS', 'RB']
    for (const code of types) for (const p of DOC_VIEW_PERMS[code].perms) grant.run('warehouse', p)
    try {
      for (const code of types) {
        const tn = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(code).table_name
        const dealers = db.prepare(`SELECT dealer_id FROM ${tn} WHERE dealer_id IS NOT NULL GROUP BY dealer_id ORDER BY COUNT(*) DESC, dealer_id LIMIT 2`).all()
        assert.equal(dealers.length, 2, `${code}: fixture needs two dealers with documents`)
        const rowOf = (did) => db.prepare(`SELECT id FROM ${tn} WHERE dealer_id=? ORDER BY id LIMIT 1`).get(did)
        const own = rowOf(dealers[0].dealer_id)
        const foreign = rowOf(dealers[1].dealer_id)
        const cell = {}
        const before = snapshot()
        db.prepare('UPDATE users SET dealer_id=? WHERE id=?').run(dealers[0].dealer_id, ownerId)
        cell.bound_own = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: own.id } }, token)).kind
        cell.bound_foreign = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: foreign.id } }, token)).code
        db.prepare('UPDATE users SET dealer_id=NULL WHERE id=?').run(ownerId)
        cell.unbound_get = outcome(await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: code, id: own.id } }, token)).code
        const changed = diff(before, snapshot())
        const good = code === 'DR'
          ? cell.bound_own === 'ok' && cell.bound_foreign === 'NOT_FOUND' && cell.unbound_get === 'TOKEN_OWNER_BINDING_REQUIRED'
          : cell.bound_own !== 'ok' && cell.bound_foreign === 'NOT_FOUND' && cell.unbound_get == null
        matrix.registry_ac3_state.types[code] = { ...cell, result: good && changed.length === 0 ? 'DENIED' : 'LEAK' }
        if (!good || changed.length) failures.push(`registry_ac3 ${code}: ${JSON.stringify(cell)} ${changed.join(';')}`)
      }
    } finally {
      restorePerms()
    }
  }

  // ---- 状态 5（Z2）：单据历史工具（doc.get）按 DOC_SCOPE_RESOLVERS 判范围 ----
  // 经销商属于所有者组织、但出货仓归他组织的销售订单：旧的列名推断（dealer_id）会放行并连同留痕一起吐出；
  // 现在与 HTTP 的 salesScopeSql 同判据，必须 NOT_FOUND 且零写。无组织归属的全局类型（OM）同样 NOT_FOUND。
  matrix.history_scope_state = { state: 'owner_scope_org_with_dealer_inferred_doc', tool: 'doc.get', cases: {} }
  {
    for (const p of ['sales.order.view', 'oms.order.view']) grant.run('warehouse', p)
    const ownerOrg = wh.org_id
    const dealerOwn = Number(db.prepare("INSERT INTO dealers (code, name, org_id) VALUES ('MX-Z2-D','MX经销商',?)").run(ownerOrg).lastInsertRowid)
    const soOther = Number(db.prepare(`INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
      VALUES ('MX-Z2-SO','dealer',?,date('now','localtime'),'draft',1,10,10,?)`).run(dealerOwn, wh2.id).lastInsertRowid)
    const soOwn = Number(db.prepare(`INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
      VALUES ('MX-Z2-SO-OWN','dealer',?,date('now','localtime'),'draft',1,10,10,?)`).run(dealerOwn, wh.id).lastInsertRowid)
    const omId = db.prepare('SELECT id FROM oms_orders ORDER BY id LIMIT 1').get()?.id
    const insEv = db.prepare("INSERT INTO doc_events (doc_type, doc_id, doc_no, action, from_state, to_state, actor_name) VALUES (?,?,?,'z2matrix','a','b','z2')")
    insEv.run('SO', soOther, 'MX-Z2-SO'); insEv.run('SO', soOwn, 'MX-Z2-SO-OWN')
    assert.notEqual(wh2.org_id, ownerOrg, 'fixture: two warehouses in different orgs')
    db.prepare('UPDATE users SET org_id=?, data_scope=? WHERE id=?').run(ownerOrg, 'org', ownerId)
    try {
      const cases = [
        ['SO dealer-inferred, warehouse in another org', 'SO', soOther, 'NOT_FOUND'],
        ['SO in owner warehouse org', 'SO', soOwn, null],
        ...(omId ? [['OM (global-only type)', 'OM', omId, 'NOT_FOUND']] : [])
      ]
      for (const [label, docType, id, want] of cases) {
        const before = snapshot()
        const r = await mcp('tools/call', { name: 'doc.get', arguments: { doc_type: docType, id } }, token)
        const o = outcome(r)
        const changed = diff(before, snapshot())
        const events = payload(r)?.events || []
        const ok = want ? o.kind === 'tool_error' && o.code === want && events.length === 0 && changed.length === 0 : o.kind === 'ok' && events.some((e) => e.action === 'z2matrix')
        matrix.history_scope_state.cases[label] = { result: ok ? (want ? 'DENIED' : 'ALLOWED') : 'LEAK', code: o.code, events: events.length }
        if (!ok) failures.push(`history_scope ${label}: ${o.kind}/${o.code} events=${events.length} ${changed.join(';')}`)
      }
    } finally {
      db.prepare('UPDATE users SET org_id=NULL, data_scope=? WHERE id=?').run('all', ownerId)
      restorePerms()
    }
  }

  // ---- 状态 6（AA1）：order.trace_document / doc.query 按 DOC_SCOPE_RESOLVERS 判范围 ----
  // 与状态 5 同夹具思路：经销商属所有者组织、出货仓属他组织的 SO（旧的 dealer_id 推断会放行）；
  // 另加一条货主在所有者组织的库存流水（单据越界时流水也不得泄露）。覆盖：范围外 / 范围内 / 缺类型级查看权限 / 全局类型。
  matrix.trace_query_scope_state = { state: 'owner_scope_org_with_dealer_inferred_doc', tools: ['order.trace_document', 'doc.query'], cases: {} }
  {
    for (const p of ['sales.order.view', 'inventory.stock.view', 'purchase.order.view', 'finance.voucher.view']) grant.run('warehouse', p)
    const ownerOrg = wh.org_id
    const dealerOwn = Number(db.prepare("INSERT INTO dealers (code, name, org_id) VALUES ('MX-AA1-D','MXAA1经销商',?)").run(ownerOrg).lastInsertRowid)
    const insSo = db.prepare(`INSERT INTO sales_orders (doc_no, channel, dealer_id, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id)
      VALUES (?,'dealer',?,date('now','localtime'),'draft',1,10,10,?)`)
    insSo.run('MX-AA1-SO', dealerOwn, wh2.id)
    insSo.run('MX-AA1-SO-OWN', dealerOwn, wh.id)
    db.prepare(`INSERT INTO inventory_transactions (biz_date,doc_type,doc_no,warehouse_id,owner_org_id,sku_id,batch_no,direction,qty,unit_cost,amount,source)
      VALUES (date('now','localtime'),'SAL_OUT','MX-AA1-SO',?,?,?, '', 'out',1,1,1,'test')`).run(wh2.id, ownerOrg, sku.id)
    assert.notEqual(wh2.org_id, ownerOrg, 'fixture: two warehouses in different orgs')
    db.prepare('UPDATE users SET org_id=?, data_scope=? WHERE id=?').run(ownerOrg, 'org', ownerId)
    const traceNo = (r) => payload(r)?.documents?.map((d) => d.row.doc_no) || []
    const queryNos = (r) => payload(r)?.rows?.map((d) => d.doc_no) || []
    try {
      const cases = [
        ['trace: SO out of scope (dealer-inferred)', 'order.trace_document', { doc_no: 'MX-AA1-SO' }, (o, r) => o.kind === 'tool_error' && o.code === 'NOT_FOUND' && traceNo(r).length === 0 && !(payload(r)?.inventory_transactions?.length), true],
        ['trace: SO in owner org', 'order.trace_document', { doc_no: 'MX-AA1-SO-OWN' }, (o, r) => o.kind === 'ok' && traceNo(r).includes('MX-AA1-SO-OWN'), false],
        ['query: SO excludes out-of-scope, keeps in-scope', 'doc.query', { doc_type: 'SO', keyword: 'MX-AA1-SO' }, (o, r) => o.kind === 'ok' && !queryNos(r).includes('MX-AA1-SO') && queryNos(r).includes('MX-AA1-SO-OWN'), true],
        ['query: VOUCHER (global-only type) empty', 'doc.query', { doc_type: 'VOUCHER' }, (o, r) => o.kind === 'ok' && queryNos(r).length === 0, true]
      ]
      for (const [label, name, a, check, denied] of cases) {
        const before = snapshot()
        const r = await mcp('tools/call', { name, arguments: a }, token)
        const o = outcome(r)
        const changed = diff(before, snapshot())
        const ok = check(o, r) && changed.length === 0
        matrix.trace_query_scope_state.cases[label] = { tool: name, result: ok ? (denied ? 'DENIED' : 'ALLOWED') : 'LEAK', code: o.code }
        if (!ok) failures.push(`trace_query_scope ${label}: ${o.kind}/${o.code} ${changed.join(';')}`)
      }
      // 缺类型级查看权限（只剩采购权限）：同一张在范围内的 SO，trace 当作不存在，query 报 TOKEN_OWNER_PERM_DENIED
      dropPerms(['sales.order.view'])
      for (const [label, name, a, code] of [
        ['trace: in-scope SO without sales.order.view', 'order.trace_document', { doc_no: 'MX-AA1-SO-OWN' }, 'NOT_FOUND'],
        ['query: SO without sales.order.view', 'doc.query', { doc_type: 'SO' }, 'TOKEN_OWNER_PERM_DENIED']
      ]) {
        const o = outcome(await mcp('tools/call', { name, arguments: a }, token))
        const ok = o.kind === 'tool_error' && o.code === code
        matrix.trace_query_scope_state.cases[label] = { tool: name, result: ok ? 'DENIED' : 'LEAK', code: o.code }
        if (!ok) failures.push(`trace_query_scope ${label}: ${o.kind}/${o.code}`)
      }
    } finally {
      db.prepare('UPDATE users SET org_id=NULL, data_scope=? WHERE id=?').run('all', ownerId)
      restorePerms()
    }
  }

  // ---- 状态 7（AA2）：库存工具按所有者的**仓库组织**范围收口 ----
  // 所有者范围 = 仓库 A 所在组织（范围内非空，区别于状态 3 的"无关组织"）：
  //   · 读工具：货主是本组织、货却放在他组织仓 / 无组织仓里，必须不可见；本组织仓里的货可见；
  //   · 写工具：目标（任一端）是他组织仓或无组织仓 ⇒ ORG_OUT_OF_SCOPE，且业务表零写；
  // 与 HTTP `/api/inventory/*`（stock.js `stockScopeSql` / `assertWarehouseInScope`）同一判据。
  matrix.inventory_scope_state = { state: 'owner_scope_org_with_foreign_and_orgless_warehouses', tools: {} }
  {
    const engine = await import('../server/lib/stock.js')
    const ownerOrg = wh.org_id
    assert.notEqual(wh2.org_id, ownerOrg, 'fixture: two warehouses in different orgs')
    const whNull = Number(db.prepare("INSERT INTO warehouses (code, name, type, status, org_id, default_owner_org_id) VALUES ('MX-AA2-N','MX无组织仓','normal','active',NULL,?)").run(ownerOrg).lastInsertRowid)
    const putStock = (warehouseId, batch) => engine.applyStockIn(db, { bizDate: new Date().toISOString().slice(0, 10), docType: 'ADJ_IN', docNo: `MX-AA2-${batch}`, warehouseId, ownerOrgId: ownerOrg, skuId: sku.id, batchNo: batch, qty: 5, unitCost: 2, expireAt: '2099-01-01 00:00:00', source: 'test', operator: 'matrix' })
    putStock(wh.id, 'MX-AA2-OWN'); putStock(wh2.id, 'MX-AA2-FOREIGN'); putStock(whNull, 'MX-AA2-NOORG')
    db.prepare('UPDATE users SET org_id=?, data_scope=? WHERE id=?').run(ownerOrg, 'org', ownerId)
    try {
      const batchesSeen = async (name, args) => {
        const r = await mcp('tools/call', { name, arguments: args }, token)
        return { out: outcome(r), text: JSON.stringify(payload(r) ?? '') }
      }
      for (const [name, args] of [
        ['inventory.query_stock', { sku_id: sku.id, limit: 500 }],
        ['inventory.list_transactions', { sku_id: sku.id, limit: 500 }],
        ['inventory.list_batches', { sku_id: sku.id, days: 36500 }],
        ['inventory.stock_alert', { expiring_days: 36500 }]
      ]) {
        const before = snapshot()
        const { out, text } = await batchesSeen(name, args)
        const changed = diff(before, snapshot())
        const hides = !text.includes('MX-AA2-FOREIGN') && !text.includes('MX-AA2-NOORG')
        const sees = text.includes('MX-AA2-OWN') || name === 'inventory.list_transactions' || name === 'inventory.stock_alert'
        const ok = out.kind === 'ok' && hides && sees && changed.length === 0
        matrix.inventory_scope_state.tools[name] = { result: ok ? 'SCOPED' : 'LEAK', code: out.code }
        if (!ok) failures.push(`inventory_scope ${name}: ${out.kind}/${out.code} hides=${hides} sees=${sees} ${changed.join(';')}`)
      }
      for (const [name, args] of [
        ['inventory.get_cost', { sku_id: sku.id, warehouse_id: wh2.id, owner_org_id: ownerOrg }],
        ['inventory.get_cost', { sku_id: sku.id, warehouse_id: whNull, owner_org_id: ownerOrg }],
        ['inventory.pick_suggestion', { sku_id: sku.id, warehouse_id: whNull, qty: 1, owner_org_id: ownerOrg }],
        ['inventory.stock_in', { warehouse_id: whNull, sku_id: sku.id, qty: 1, unit_cost: 1, owner_org_id: ownerOrg }],
        ['inventory.stock_in', { warehouse_id: wh2.id, sku_id: sku.id, qty: 1, unit_cost: 1, owner_org_id: ownerOrg }],
        ['inventory.stock_out', { warehouse_id: whNull, sku_id: sku.id, qty: 1, owner_org_id: ownerOrg }],
        ['inventory.adjust', { warehouse_id: whNull, sku_id: sku.id, delta: 1, reason: 'matrix' }],
        ['inventory.transfer', { from_warehouse_id: wh.id, to_warehouse_id: whNull, sku_id: sku.id, qty: 1 }],
        ['inventory.transfer', { from_warehouse_id: whNull, to_warehouse_id: wh.id, sku_id: sku.id, qty: 1 }],
        ['inventory.ownership_transfer', { from_warehouse_id: wh.id, from_owner_org_id: ownerOrg, to_warehouse_id: whNull, to_owner_org_id: ownerOrg, sku_id: sku.id, qty: 1 }]
      ]) {
        const tool = TOOLS.find((x) => x.name === name)
        const before = snapshot()
        const r = await invoke(tool, args)
        const changed = diff(before, snapshot())
        const ok = r.final.kind === 'tool_error' && r.final.code === 'ORG_OUT_OF_SCOPE' && changed.length === 0
        const key = `${name}#${JSON.stringify(Object.entries(args).filter(([k]) => k.includes('warehouse')).map(([, v]) => v))}`
        matrix.inventory_scope_state.tools[key] = { result: ok ? 'DENIED' : 'LEAK', code: r.final.code, rows_changed: changed }
        if (!ok) failures.push(`inventory_scope ${key}: ${r.final.kind}/${r.final.code} ${changed.join(';')}`)
      }
    } finally {
      db.prepare('UPDATE users SET org_id=NULL, data_scope=? WHERE id=?').run('all', ownerId)
    }
  }

  // ---- 产出矩阵并断言覆盖 ----
  const file = path.join(f.dir, 'mcp-tool-matrix.json')
  writeFileSync(file, JSON.stringify(matrix, null, 2))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const covered = Object.values(saved.tools).filter((x) => saved.states.every((s) => x.states[s])).length
  if (process.env.MCP_MATRIX_PRINT) console.log(JSON.stringify(saved, null, 1))
  assert.equal(covered, TOOLS.length, 'matrix must cover every tool in every state')
  assert.equal(saved.tool_count, TOOLS.length)
  assert.ok(Object.keys(saved.binding_state.types).length >= 6 && Object.values(saved.binding_state.types).every((x) => x.result === 'DENIED'), 'every store/dealer bound type is denied to an unbound owner')
  assert.deepEqual(Object.keys(saved.registry_binding_state.types).sort(), ['PS', 'PSF', 'RC', 'SH', 'YQ'], 'AB7 / AC3: registry store binding is exercised for PS / PSF / RC / YQ / SH')
  assert.deepEqual(Object.keys(saved.registry_ac3_state.types).sort(), ['DR', 'DS', 'RB'], 'AC3: dealer and hq registry bindings')
  assert.ok(Object.values(saved.registry_ac3_state.types).every((x) => x.result === 'DENIED'), 'AC3: bound-to-other-dealer / bound owners read nothing from DR / DS / RB')
  assert.ok(Object.values(saved.registry_binding_state.types).every((x) => x.result === 'DENIED'), 'AB7: bound-to-other-store and unbound owners read nothing')
  assert.ok(Object.keys(saved.history_scope_state.cases).length >= 2 && Object.values(saved.history_scope_state.cases).every((x) => x.result !== 'LEAK'), 'history tool honors the owner scope')
  assert.ok(Object.keys(saved.trace_query_scope_state.cases).length >= 6 && Object.values(saved.trace_query_scope_state.cases).every((x) => x.result !== 'LEAK'), 'order.trace_document and doc.query honor the owner scope and view permission')
  assert.ok(Object.keys(saved.inventory_scope_state.tools).length >= 14 && Object.values(saved.inventory_scope_state.tools).every((x) => x.result !== 'LEAK'), 'inventory tools honor the owner warehouse-org scope')
  assert.ok(Object.values(saved.replay_state.tools).every((x) => x.result !== 'LEAK'), 'no write tool replays a cached result after owner permission / scope loss')
  assert.deepEqual(failures, [], `tools that slipped through:\n${failures.join('\n')}`)
  assert.ok(Object.values(saved.tools).every((x) => Object.values(x.states).every((c) => c.result !== 'LEAK')))
})

// AC1（ADR-0050）：采购订单在 MCP 读工具里的可见范围与 HTTP 完全一致 —— 只按入库仓的组织，目标门店不放行。
test('AC1: purchase.list_orders / report.dashboard_kpi admit a purchase order by warehouse org only, like HTTP', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const admin = (await api('/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body.data
  const whA = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH01'").get()
  const whB = db.prepare("SELECT id, org_id FROM warehouses WHERE code='WH03'").get()
  assert.notEqual(whA.org_id, whB.org_id)
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const storeA = Number(db.prepare("INSERT INTO stores (code, name, status, org_id) VALUES ('AC1-MX-S','AC1 matrix store','active',?)").run(whA.org_id).lastInsertRowid)
  const ins = db.prepare("INSERT INTO purchase_orders (doc_no, supplier_id, warehouse_id, target_store_id, order_date, status) VALUES (?,?,?,?,date('now','localtime'),'approved')")
  ins.run('AC1-MX-WH-A', supplier, whA.id, null)
  ins.run('AC1-MX-WH-B-STORE-A', supplier, whB.id, storeA)
  ins.run('AC1-MX-WH-B', supplier, whB.id, null)
  for (const p of ['purchase.order.view']) db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)').run('warehouse', p)
  const mk = async (username, extra) => {
    const r = (await api('/api/auth/users', { token: admin.token, body: { username, name: username, role: 'warehouse', password: secret(), ...extra } })).body
    assert.equal(r.success, true, JSON.stringify(r))
    return createToken(db, { name: username, ownerUserId: r.data.id, industry: 'cosmetic', scopes: 'read' }).token
  }
  const tokA = await mk('ac1_mx_a', { org_id: whA.org_id, data_scope: 'org' })
  const tokAll = await mk('ac1_mx_all', { data_scope: 'all' })
  const docs = async (token) => payload(await mcp('tools/call', { name: 'purchase.list_orders', arguments: { limit: 200 } }, token)).list.map((x) => x.doc_no).filter((x) => x.startsWith('AC1-MX-')).sort()
  assert.deepEqual(await docs(tokA), ['AC1-MX-WH-A'], 'target store in scope must not admit an order stored in another org warehouse')
  assert.equal((await docs(tokAll)).length, 3, 'global scope unchanged')
  const kpi = async (token) => payload(await mcp('tools/call', { name: 'report.dashboard_kpi', arguments: {} }, token)).purchase_in_transit
  const expectA = db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('approved','partial') AND warehouse_id IN (SELECT id FROM warehouses WHERE org_id=?)").get(whA.org_id).c
  assert.equal(await kpi(tokA), expectA)
  assert.equal(await kpi(tokAll), db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('approved','partial')").get().c)
  assert.ok(expectA < await kpi(tokAll))
})
