/**
 * ============================================================================
 * 文件标识：tests/authz-followups.test.mjs ｜ 测试：待办接口按权限与范围收口（ADR-0015）+ Agent Token 有效状态
 * ============================================================================
 * 【职责】守住 ADR-0015 的两条决定：
 *   ① `/api/purchase/chain/todos` 与 `/api/approval/todos` 不再"只要登录就全库可见"：
 *      外部主体 / 无权限账号 403；受限账号只拿到自己范围内（组织 / 当前级审批人）的待办；
 *      管理员口径不变。
 *   ② 所有者 `auth_version` 变化后的有主 Agent Token：列表与详情报 `effective_status`
 *      （`revoked_by_owner_change`），每次调用仍以 `delegation.js` 为准（`TOKEN_OWNER_REVOKED`），
 *      管理员清扫后行状态落为 `revoked` 并带原因；重新签发照常可用。
 *
 *   ③ AD2（ADR-0051 补充）：`docs/operations/role-matrix.md` 的角色 × 单据类型格子与真实 `/api/docflow/events` 行为一致
 *      （抽样 10 格，期望字面值写死），生成器 `--check` 对漂移 / 缺文件 / 手改 / 换行改写都红。
 *
 * 【夹具口径】test 运行时 + 全新临时数据目录（演示种子）+ 随机回环端口；账号经 `/api/auth/users` 建，
 *   单据 / 审批实例直接写库（只为摆出"谁该看到什么"的局面，不验业务流转）。
 *
 * 【改它要注意什么】断言都是"精确集合"（看得到 A、看不到 B），不是"比之前少了"——
 *   相对断言守不住"过滤看起来生效、实际仍是全库"。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-authz-followups-'))
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
  return { dir, api, mcp, db, admin, login, account }
}

const forbidden = (r) => assert.equal(r.status, 403, JSON.stringify(r.body))
const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const rpcCode = (r) => r.body?.error?.data?.code ?? null

// ---------------------------------------------------------------------------
// ① 待办接口：权限门 + 范围
// ---------------------------------------------------------------------------

test('purchase chain todos require an internal purchase-reading role and are scoped to the caller', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  // 两个互不包含的组织（各挂一个仓），演示库里取两个不同 org 的仓库即可。
  const whs = db.prepare(`SELECT w.id, w.org_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id LIMIT 2`).all()
  assert.equal(whs.length, 2, 'demo data must provide warehouses in two different orgs')
  const [whA, whB] = whs
  const pathOf = (id) => db.prepare('SELECT path FROM orgs WHERE id=?').get(id)?.path || ''
  assert.ok(!pathOf(whA.org_id).startsWith(pathOf(whB.org_id)) && !pathOf(whB.org_id).startsWith(pathOf(whA.org_id)), 'orgs must not nest')

  // 摆局面：A 组织一张待审请购单 + 一张待审采购订单（仓在 A）；B 组织一张待审请购单。
  const insPrq = db.prepare(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id)
                             VALUES (?,?,date('now'),'submitted',?,?)`)
  insPrq.run('PRQ-SCOPE-A', whA.org_id, 100, whA.id)
  insPrq.run('PRQ-SCOPE-B', whB.org_id, 200, whB.id)
  insPrq.run('PRQ-SCOPE-NULL', null, 300, null)
  const po = db.prepare('SELECT id, doc_no FROM purchase_orders ORDER BY id LIMIT 1').get()
  assert.ok(po, 'demo data must provide a purchase order')
  db.prepare("UPDATE purchase_orders SET status='submitted', warehouse_id=? WHERE id=?").run(whA.id, po.id)

  const docNos = (r) => okData(r).list.map((x) => x.doc_no)

  await t.test('admin keeps the global list', async () => {
    const r = await api('/api/purchase/chain/todos', { token: f.admin })
    const nos = docNos(r)
    for (const n of ['PRQ-SCOPE-A', 'PRQ-SCOPE-B', 'PRQ-SCOPE-NULL', po.doc_no]) assert.ok(nos.includes(n), `admin must see ${n}`)
  })

  await t.test('external principals and roles without a purchase read permission get 403', async () => {
    const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('TS1','Todo store')").run().lastInsertRowid)
    const dealerId = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('TD1','Todo dealer')").run().lastInsertRowid)
    const store = await f.account('todo_store', 'store', { store_id: storeId })
    const dealer = await f.account('todo_dealer', 'dealer', { dealer_id: dealerId })
    const sales = await f.account('todo_sales', 'sales', { data_scope: 'all' })
    for (const u of [store, dealer, sales]) forbidden(await api('/api/purchase/chain/todos', { token: u.token }))
    assert.equal((await api('/api/purchase/chain/todos')).status, 401)
  })

  await t.test('org-restricted purchase users only see their own org (orders via warehouse org, NULL org hidden)', async () => {
    const a = await f.account('todo_purchase_a', 'purchase', { org_id: whA.org_id, data_scope: 'org' })
    const b = await f.account('todo_purchase_b', 'purchase', { org_id: whB.org_id, data_scope: 'org' })
    const nosA = docNos(await api('/api/purchase/chain/todos', { token: a.token }))
    assert.ok(nosA.includes('PRQ-SCOPE-A') && nosA.includes(po.doc_no), JSON.stringify(nosA))
    assert.ok(!nosA.includes('PRQ-SCOPE-B') && !nosA.includes('PRQ-SCOPE-NULL'), JSON.stringify(nosA))
    const nosB = docNos(await api('/api/purchase/chain/todos', { token: b.token }))
    assert.ok(nosB.includes('PRQ-SCOPE-B'), JSON.stringify(nosB))
    assert.ok(!nosB.includes('PRQ-SCOPE-A') && !nosB.includes(po.doc_no) && !nosB.includes('PRQ-SCOPE-NULL'), JSON.stringify(nosB))
    // 没有组织归属的受限账号：范围为空 ⇒ 空列表（不是 403，也不是全库）
    const none = await f.account('todo_purchase_none', 'purchase', { data_scope: 'org' })
    assert.deepEqual(okData(await api('/api/purchase/chain/todos', { token: none.token })).list, [])
  })

  await t.test('items are also filtered by the action permission the todo needs', async () => {
    // viewer：有 purchase.order.view（能进门），但没有任何采购动作权限 ⇒ 200 + 空列表
    const viewer = await f.account('todo_viewer', 'viewer')
    assert.deepEqual(okData(await api('/api/purchase/chain/todos', { token: viewer.token })).list, [])
    // warehouse（全局范围）：只有 purchase.inbound ⇒ 只看到「待到货」类待办
    const wh = await f.account('todo_wh', 'warehouse', { data_scope: 'all' })
    const list = okData(await api('/api/purchase/chain/todos', { token: wh.token })).list
    assert.ok(list.length > 0 || db.prepare("SELECT COUNT(*) n FROM purchase_orders WHERE status='approved' AND close_arrival=0").get().n === 0)
    assert.ok(list.every((x) => x.kind === 'po_receive'), JSON.stringify(list.map((x) => x.kind)))
  })
})

test('approval todos require an approval permission and only count instances the caller can act on', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f

  const approverA = await f.account('apv_a', 'purchase', { data_scope: 'all' })
  const approverB = await f.account('apv_b', 'finance', { data_scope: 'all' })
  const tpl = (code, userId) => {
    const id = Number(db.prepare(`INSERT INTO approval_templates (code,name,doc_type,action,enabled) VALUES (?,?,'PO','approve',1)`).run(code, code).lastInsertRowid)
    db.prepare(`INSERT INTO approval_steps (template_id,step_no,step_name,approver_type,approver_value) VALUES (?,1,'一级','user',?)`).run(id, String(userId))
    return id
  }
  const tplA = tpl('TPL_A', approverA.id)
  const tplB = tpl('TPL_B', approverB.id)
  const inst = (templateId, docNo, status = 'pending', amount = 10) => db.prepare(
    `INSERT INTO approval_instances (template_id,template_code,doc_type,doc_id,doc_no,action,action_name,amount,total_steps,current_step,status,submitted_by_id)
     VALUES (?,?,'PO',1,?,'approve','审批',?,1,1,?,?)`).run(templateId, `T${templateId}`, docNo, amount, status, 1)
  inst(tplA, 'APV-A1'); inst(tplA, 'APV-A2'); inst(tplB, 'APV-B1'); inst(tplB, 'APV-B2', 'approved')

  const count = async (token) => okData(await api('/api/approval/todos', { token })).count

  await t.test('admin sees every pending instance', async () => {
    assert.equal(await count(f.admin), 3)
  })
  await t.test('an approver only sees the pending instances whose current step points at them', async () => {
    assert.equal(await count(approverA.token), 2)
    assert.equal(await count(approverB.token), 1)
  })
  await t.test('approval-admin permission (system:approval:manage) sees everything', async () => {
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('sales','system:approval:manage')").run()
    const mgr = await f.account('apv_mgr', 'sales')
    assert.equal(await count(mgr.token), 3)
  })
  await t.test('approval_manager_global=0 narrows a scope-restricted manager to in-scope documents, leaving approver queues and global scope untouched (Z9)', async () => {
    const mgr = await f.account('apv_mgr0', 'sales', { data_scope: 'org' })
    const globalMgr = await f.account('apv_mgr_all', 'sales', { data_scope: 'all' })
    assert.equal(await count(mgr.token), 3, 'switch default (1): manager sees every pending instance')
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('approval_manager_global','0')").run()
    try {
      assert.equal(await count(mgr.token), 0, 'switch 0: restricted manager with no in-scope documents sees none')
      assert.deepEqual(okData(await api('/api/approval/pending', { token: mgr.token })).list, [])
      assert.equal(await count(globalMgr.token), 3, 'global-scope manager unaffected')
      assert.equal(await count(approverA.token), 2, 'own approver queue unaffected')
      assert.equal(await count(f.admin), 3)
    } finally {
      db.prepare("DELETE FROM settings WHERE key='approval_manager_global'").run()
    }
    assert.equal(await count(mgr.token), 3, 'switch back to default (1)')
  })
  await t.test('view-only internal user gets an empty, scoped todo; external and no-permission roles get 403', async () => {
    const wh = await f.account('apv_wh', 'warehouse')
    assert.equal(await count(wh.token), 0)
    const storeId = Number(db.prepare("INSERT INTO stores (code,name) VALUES ('AS1','Apv store')").run().lastInsertRowid)
    const dealerId = Number(db.prepare("INSERT INTO dealers (code,name) VALUES ('AD1','Apv dealer')").run().lastInsertRowid)
    const store = await f.account('apv_store', 'store', { store_id: storeId })
    const dealer = await f.account('apv_dealer', 'dealer', { dealer_id: dealerId })
    for (const u of [store, dealer]) forbidden(await api('/api/approval/todos', { token: u.token }))
    // viewer 自带 system:approval:view（014）⇒ 进得了门但不是任何实例的审批人 ⇒ 空待办；
    // 把这个权限点拿掉后 ⇒ 403（门是权限点，不是角色名）。
    const viewer = await f.account('apv_viewer', 'viewer')
    assert.equal(await count(viewer.token), 0)
    db.prepare("DELETE FROM role_permissions WHERE role_code='viewer' AND perm_code LIKE 'system:approval:%'").run()
    forbidden(await api('/api/approval/todos', { token: viewer.token }))
    assert.equal((await api('/api/approval/todos')).status, 401)
  })
})

// ---------------------------------------------------------------------------
// ② Agent Token 有效状态：所有者版本变化 ⇒ 列表 / 详情如实报告；清扫落库；重签可用
// ---------------------------------------------------------------------------

test('agent token list reports an effective status after the owner auth_version changes, and a sweep persists it', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api, mcp } = f
  const owner = await f.account('tok_owner', 'warehouse', { data_scope: 'all' })
  const issue = (name) => createToken(db, { name, ownerUserId: owner.id, industry: 'cosmetic', scopes: 'read' })
  const t1 = issue('status-1')
  const ping = (raw) => mcp('tools/call', { name: 'inventory.query_stock', arguments: { limit: 1 } }, raw)
  const listed = async (id) => okData(await api('/api/mcp/tokens', { token: f.admin })).find((x) => x.id === id)
  const detail = async (id) => okData(await api(`/api/mcp/tokens/${id}`, { token: f.admin }))

  await t.test('fresh token: active in list and detail, call succeeds', async () => {
    const row = await listed(t1.id)
    assert.equal(row.status, 'active')
    assert.equal(row.effective_status, 'active')
    assert.equal(row.owner_user_id, owner.id)
    assert.equal((await detail(t1.id)).effective_status, 'active')
    const r = await ping(t1.token)
    assert.ok(!r.body.error && r.body.result?.isError !== true, JSON.stringify(r.body).slice(0, 300))
  })

  await t.test('owner password change: history untouched, effective status revoked_by_owner_change, call rejected', async () => {
    const newPassword = secret()
    okData(await api('/api/auth/change-password', { token: owner.token, body: { oldPassword: owner.password, newPassword } }))
    owner.password = newPassword
    owner.token = await f.login(owner.username, newPassword)
    const row = await listed(t1.id)
    assert.equal(row.status, 'active', 'stored status is history, not rewritten by a read')
    assert.equal(row.effective_status, 'revoked_by_owner_change')
    assert.ok(row.effective_reason, 'reason text must be present')
    assert.equal((await detail(t1.id)).effective_status, 'revoked_by_owner_change')
    assert.equal(rpcCode(await ping(t1.token)), 'TOKEN_OWNER_REVOKED')
  })

  await t.test('sweep marks such tokens revoked with a reason; the per-call check then reports TOKEN_REVOKED', async () => {
    const out = okData(await api('/api/mcp/tokens/sweep', { token: f.admin, body: {} }))
    assert.equal(out.swept, 1)
    const row = await listed(t1.id)
    assert.equal(row.status, 'revoked')
    assert.equal(row.effective_status, 'revoked')
    assert.equal(row.revoked_reason, 'owner_auth_changed')
    assert.ok(row.revoked_at)
    assert.equal(rpcCode(await ping(t1.token)), 'TOKEN_REVOKED')
    assert.equal(okData(await api('/api/mcp/tokens/sweep', { token: f.admin, body: {} })).swept, 0, 'sweep is idempotent')
  })

  await t.test('re-issue works and an admin revoke records its own reason', async () => {
    const t2 = issue('status-2')
    assert.equal((await listed(t2.id)).effective_status, 'active')
    const r = await ping(t2.token)
    assert.ok(!r.body.error && r.body.result?.isError !== true, JSON.stringify(r.body).slice(0, 300))
    okData(await api(`/api/mcp/tokens/${t2.id}`, { token: f.admin, method: 'DELETE' }))
    const row = await listed(t2.id)
    assert.equal(row.status, 'revoked')
    assert.equal(row.revoked_reason, 'admin')
    assert.equal(row.effective_status, 'revoked')
  })

  await t.test('expired and owner-inactive tokens are reported too, and the sweep is admin-only', async () => {
    const t3 = issue('status-3')
    db.prepare("UPDATE agent_tokens SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(t3.id)
    assert.equal((await listed(t3.id)).effective_status, 'expired')
    const t4 = issue('status-4')
    db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(owner.id) // 绕过 API（API 停用会直接吊销）
    assert.equal((await listed(t4.id)).effective_status, 'owner_inactive')
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(owner.id)
    forbidden(await api('/api/mcp/tokens/sweep', { token: owner.token, body: {} }))
    forbidden(await api('/api/mcp/tokens', { token: owner.token }))
  })
})

// ---------------------------------------------------------------------------
// ③ AD2：角色矩阵（docs/operations/role-matrix.md）与真实 docflow 路由行为一致（抽样 10 格）
// ---------------------------------------------------------------------------

test('role matrix cells match real /api/docflow/events behaviour (10 sampled role x type cells)', { timeout: 300000 }, async (t) => {
  // 期望值写死在这里：生成器若画错，光靠"矩阵 = 路由"的自证循环抓不到；这里同时钉住字面结论
  const SAMPLES = [
    ['boss', 'RC', 'G'], // AD2：老板是总部角色，未绑门店也看全部门店日结
    ['boss', 'DR', 'G'], // 同一豁免也覆盖经销商要货单的未绑定闸
    ['viewer', 'RC', 'B'], // 非总部：未绑定看不到，绑了只看本店
    ['finance', 'VOUCHER', 'G'],
    ['purchase', 'AR', '-'], // 子树范围看不到无组织归属的总账类单据
    ['warehouse', 'TF', 'O'],
    ['sales', 'SO', 'O'],
    ['scm', 'PO', 'G'],
    ['store', 'PS', '-'], // 外部主体：docflow 读接口整体 403
    ['dealer', 'OC', '-']
  ]
  const model = JSON.parse(
    execFileSync(process.execPath, ['scripts/gen-role-matrix.mjs', '--json'], { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).toString()
  )
  const md = readFileSync(path.join(ROOT, 'docs/operations/role-matrix.md'), 'utf8')
  const mdRoles = md.split('\n').find((l) => l.startsWith('| 单据 |')).split('|').map((x) => x.trim().replace(/`/g, '')).slice(2, -1)
  const mdCell = (role, type) => {
    const row = md.split('\n').find((l) => l.startsWith(`| \`${type}\` `))
    return row.split('|').map((x) => x.trim())[2 + mdRoles.indexOf(role)]
  }
  for (const [role, type, want] of SAMPLES) {
    assert.equal(model.docflow[role][type], want, `generator ${role} x ${type}`)
    assert.equal(mdCell(role, type), want, `committed role-matrix.md ${role} x ${type}`)
  }

  const f = await server(t)
  const { db, api } = f
  const orgId = 3 // 演示库：22 张调拨单的来源仓属于组织 3
  assert.ok(db.prepare('SELECT 1 FROM orgs WHERE id=?').get(orgId), 'demo org 3 must exist')
  const store = db.prepare("SELECT id FROM stores WHERE status='active' ORDER BY id LIMIT 1").get()
  const dealer = db.prepare("SELECT id FROM dealers WHERE status='active' ORDER BY id LIMIT 1").get()
  const insEv = db.prepare(`INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,to_state,source,created_at)
    VALUES (?,?,?,'ad2matrix','ad2matrix','x','api',datetime('now','localtime'))`)
  const seeded = {}
  for (const type of new Set(SAMPLES.map((x) => x[1]))) {
    const table = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(type).table_name
    const ids = db.prepare(`SELECT id FROM ${table} ORDER BY id LIMIT 80`).all().map((r) => r.id)
    assert.ok(ids.length > 0, `demo data must have ${type} rows (${table})`)
    for (const id of ids) insEv.run(type, id, `AD2-${type}-${id}`)
    seeded[type] = { table, ids }
  }
  const extra = (role) => (role === 'store' ? { store_id: store.id } : role === 'dealer' ? { dealer_id: dealer.id } : { org_id: orgId })
  const events = (tk, type) => api(`/api/docflow/events?doc_type=${type}&action=ad2matrix&pageSize=500`, { token: tk })
  const seen = (r) => r.body.data.list.map((x) => x.doc_id).sort((a, b) => a - b)

  for (const [role, type, want] of SAMPLES) {
    await t.test(`${role} x ${type} = ${want}`, async () => {
      const who = await f.account(`ad2_${role}_${type.toLowerCase()}`, role, extra(role))
      const r = await events(who.token, type)
      const all = seeded[type].ids
      if (role === 'store' || role === 'dealer') return forbidden(r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const got = seen(r)
      if (want === 'G') assert.deepEqual(got, all)
      else if (want === 'O') {
        assert.ok(got.length < all.length, 'org scope must be a strict subset')
        for (const id of got) assert.ok(all.includes(id))
        if (type === 'TF') {
          const sub = db.prepare('SELECT id FROM orgs WHERE path LIKE ? OR id=?').all(`${db.prepare('SELECT path FROM orgs WHERE id=?').get(orgId).path}%`, orgId).map((x) => x.id)
          const ph = sub.map(() => '?').join(',')
          const exp = db.prepare(`SELECT id FROM stock_transfers WHERE from_warehouse_id IN (SELECT id FROM warehouses WHERE org_id IN (${ph}))
            OR to_warehouse_id IN (SELECT id FROM warehouses WHERE org_id IN (${ph})) ORDER BY id`).all(...sub, ...sub).map((x) => x.id).filter((id) => all.includes(id))
          assert.ok(exp.length > 0)
          assert.deepEqual(got, exp)
        }
      } else assert.deepEqual(got, [], 'hidden cell must expose no rows')
    })
  }

  await t.test('bound-only cell: the same viewer role bound to a store sees exactly that store', async () => {
    const bound = await f.account('ad2_viewer_bound', 'viewer', { store_id: store.id })
    const exp = db.prepare('SELECT id FROM pos_daily_closes WHERE store_id=? ORDER BY id').all(store.id).map((x) => x.id).filter((id) => seeded.RC.ids.includes(id))
    assert.ok(exp.length > 0 && exp.length < seeded.RC.ids.length, 'store must own some but not all demo day-closes')
    assert.deepEqual(seen(await events(bound.token, 'RC')), exp)
  })
})

test('role matrix generator: committed file is current and --check fails on drift', { timeout: 300000 }, () => {
  const run = (args, env = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['scripts/gen-role-matrix.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, timeout: 120000 }).toString() }
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }
    }
  }
  assert.equal(run(['--check']).code, 0)
  assert.equal(run(['--bogus']).code, 2)
  assert.equal(run(['--check', '--json']).code, 2, '--json must not be able to switch the drift check off')
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-role-matrix-drift-'))
  try {
    // 继承来的 GML_DB 不能把迁移 / 夹具写进别人的库
    const foreign = path.join(dir, 'foreign.db')
    assert.equal(run(['--check'], { GML_DB: foreign }).code, 0)
    assert.equal(existsSync(foreign), false, 'GML_DB must be ignored by the generator')
    const good = readFileSync(path.join(ROOT, 'docs/operations/role-matrix.md'), 'utf8')
    const file = path.join(dir, 'm.md')
    assert.equal(run(['--check', `--file=${file}`]).code, 1, 'missing file is drift')
    writeFileSync(file, good)
    assert.equal(run(['--check', `--file=${file}`]).code, 0)
    writeFileSync(file, good.replace('| `RC` 门店日结单 | G | G', '| `RC` 门店日结单 | G | -'))
    assert.equal(run(['--check', `--file=${file}`]).code, 1, 'a hand-edited cell is drift')
    writeFileSync(file, `${good}\n`)
    assert.equal(run(['--check', `--file=${file}`]).code, 1, 'trailing bytes are drift')
    writeFileSync(file, good.replace(/\n/g, '\r\n'))
    assert.equal(run(['--check', `--file=${file}`]).code, 1, 'CRLF rewrite is drift')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
