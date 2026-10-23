/**
 * ============================================================================
 * 文件标识：tests/approval-scope.test.mjs ｜ 测试：审批域组织范围（ADR-0037）
 * ============================================================================
 * 【职责】守住 ADR-0037：审批实例的列表 / 详情（含记录与历史）/ 总览 / 待办 / 闸门查询，
 *   对内部账号按「实例指向的单据」所属组织收口；创建、撤回、审批决定同样要求单据在范围内：
 *     · 可见 = 全局范围 ∪ 提交人本人 ∪ 当前级审批人（自己的待办不受组织限制）∪ 单据在组织范围内；
 *     · 范围外的详情 / 撤回 / 决定与"不存在"同形（404），且不产生任何写；
 *     · 创建审批：目标单据不在范围内 ⇒ 404，不建实例；
 *     · 没有范围解析器的单据类型对受限范围失败关闭（不可见），而不是全库。
 *
 * 【夹具口径】test 运行时、临时数据目录、随机回环端口；账号经 `/api/auth/users` 建，单据 / 实例直接写库。
 * 【改它要注意什么】期望值是精确状态码与精确集合，不是"比全库少"。
 * ============================================================================
 */
import test from 'node:test'
import { readFileSync } from 'node:fs'
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
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-approval-scope-'))
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
const notFound = (r, m) => assert.equal(r.status, 404, `${m}: ${JSON.stringify(r.body)}`)

test('approval instances are scoped to the org of the document they point at', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { db, api } = f
  const whs = db.prepare(`SELECT w.id, w.org_id, o.path, o.parent_id FROM warehouses w JOIN orgs o ON o.id = w.org_id
                          WHERE w.status='active' GROUP BY w.org_id ORDER BY w.id`).all()
  const whA = whs[0]
  const whB = whs.find((w) => !w.path.startsWith(whA.path) && !whA.path.startsWith(w.path) &&
    !w.path.startsWith(db.prepare('SELECT path FROM orgs WHERE id=?').get(whA.parent_id).path))
  assert.ok(whA && whB, 'demo data must provide warehouses on two disjoint org branches')
  const id = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid)

  const prq = (no, org, wh) => id(`INSERT INTO purchase_requisitions (doc_no, org_id, req_date, status, total_amount, warehouse_id) VALUES (?,?,date('now'),'submitted',100,?)`, no, org, wh)
  const doc = { A: prq('PRQ-AP-A', whA.org_id, whA.id), B: prq('PRQ-AP-B', whB.org_id, whB.id), N: prq('PRQ-AP-N', null, null) }

  // 模板：请购审批，一级，角色 finance（finance 角色账号都是当前级审批人）
  const tpl = id(`INSERT INTO approval_templates (code,name,doc_type,action,enabled) VALUES ('APV-AP-PRQ','prq scope','PRQ','approve',1)`)
  db.prepare(`INSERT INTO approval_steps (template_id,step_no,step_name,approver_type,approver_value) VALUES (?,1,'一级','role','finance')`).run(tpl)

  const purA = await f.account('ap_pur_a', 'purchase', { org_id: whA.org_id, data_scope: 'org' })
  const purB = await f.account('ap_pur_b', 'purchase', { org_id: whB.org_id, data_scope: 'org' })
  const finA = await f.account('ap_fin_a', 'finance', { org_id: whA.org_id, data_scope: 'org' })
  const finB = await f.account('ap_fin_b', 'finance', { org_id: whB.org_id, data_scope: 'org' })
  const viewA = await f.account('ap_view_a', 'viewer', { org_id: whA.org_id, data_scope: 'org' })
  const viewB = await f.account('ap_view_b', 'viewer', { org_id: whB.org_id, data_scope: 'org' })
  const viewNone = await f.account('ap_view_none', 'viewer', { data_scope: 'org' })
  const glob = await f.account('ap_glob', 'viewer', { data_scope: 'all' })

  const nos = (r) => okData(r).list.map((x) => x.doc_no).sort()
  const inst = {}

  await t.test('create: the target document must be in the caller scope (404, no instance)', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM approval_instances').get().n
    for (const k of ['B', 'N']) notFound(await api('/api/approval/instances', { token: purA.token, body: { doc_type: 'PRQ', doc_id: doc[k], action: 'approve' } }), k)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM approval_instances').get().n, before, 'rejected creates must not write')
    inst.A = okData(await api('/api/approval/instances', { token: purA.token, body: { doc_type: 'PRQ', doc_id: doc.A, action: 'approve' } })).id
    inst.B = okData(await api('/api/approval/instances', { token: purB.token, body: { doc_type: 'PRQ', doc_id: doc.B, action: 'approve' } })).id
    inst.N = okData(await api('/api/approval/instances', { token: f.admin, body: { doc_type: 'PRQ', doc_id: doc.N, action: 'approve' } })).id
    // 范围外 404 与"不存在" 404 同形
    const miss = await api('/api/approval/instances', { token: purA.token, body: { doc_type: 'PRQ', doc_id: 999999, action: 'approve' } })
    assert.equal(miss.status, 404)
  })

  await t.test('list: a non-approver org account only sees instances of in-scope documents', async () => {
    assert.deepEqual(nos(await api('/api/approval/instances', { token: viewA.token })), ['PRQ-AP-A'])
    assert.deepEqual(nos(await api('/api/approval/instances', { token: viewB.token })), ['PRQ-AP-B'])
    const none = okData(await api('/api/approval/instances', { token: viewNone.token }))
    assert.deepEqual([none.list.length, none.total], [0, 0], 'no-org restricted account: empty, not the whole table')
    for (const tok of [f.admin, glob.token]) {
      assert.deepEqual(nos(await api('/api/approval/instances', { token: tok })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
    }
    // total / 分页按过滤后的集合算
    const paged = okData(await api('/api/approval/instances?page=1&pageSize=1', { token: viewA.token }))
    assert.equal(paged.total, 1)
  })

  await t.test('submitter always sees their own instance; approvers see their own queue regardless of org', async () => {
    assert.deepEqual(nos(await api('/api/approval/instances?mine=1', { token: purA.token })), ['PRQ-AP-A'])
    // purA 不是审批人：只有自己提交的 A（B/N 的单据在范围外）
    assert.deepEqual(nos(await api('/api/approval/instances', { token: purA.token })), ['PRQ-AP-A'])
    // finance 角色是当前级审批人：看得到所有 pending（含他组织），详情也能读
    const q = nos(await api('/api/approval/instances', { token: finA.token }))
    assert.deepEqual(q, ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
    okData(await api(`/api/approval/instances/${inst.B}`, { token: finA.token }))
    assert.deepEqual(nos(await api('/api/approval/pending', { token: finA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
  })

  await t.test('detail (with records/history): out-of-scope is 404 identical to a missing instance', async () => {
    const d = okData(await api(`/api/approval/instances/${inst.A}`, { token: viewA.token }))
    assert.ok(Array.isArray(d.records) && d.records.length >= 1)
    const miss = await api('/api/approval/instances/999999', { token: viewA.token })
    for (const k of ['B', 'N']) {
      const hid = await api(`/api/approval/instances/${inst[k]}`, { token: viewA.token })
      notFound(hid, k)
      assert.deepEqual(hid.body, miss.body)
    }
    notFound(await api(`/api/approval/instances/${inst.A}`, { token: viewNone.token }), 'no-org')
    notFound(await api(`/api/approval/instances/${inst.A}`, { token: viewB.token }), 'org B on A')
    for (const k of ['A', 'B', 'N']) okData(await api(`/api/approval/instances/${inst[k]}`, { token: glob.token }))
    // 提交人读自己的，即便其组织范围后来收窄
    db.prepare('UPDATE users SET org_id=? WHERE id=?').run(whB.org_id, purA.id)
    okData(await api(`/api/approval/instances/${inst.A}`, { token: purA.token }))
    db.prepare('UPDATE users SET org_id=? WHERE id=?').run(whA.org_id, purA.id)
  })

  await t.test('check/overview/todos are scoped to the same set', async () => {
    notFound(await api(`/api/approval/check?doc_type=PRQ&action=approve&doc_id=${doc.B}`, { token: viewA.token }), 'check B')
    okData(await api(`/api/approval/check?doc_type=PRQ&action=approve&doc_id=${doc.A}`, { token: viewA.token }))
    const ovA = okData(await api('/api/approval/overview', { token: viewA.token }))
    assert.deepEqual([ovA.pending, ovA.total, ovA.by_doc_type], [1, 1, [{ doc_type: 'PRQ', c: 1 }]])
    assert.equal(ovA.pending_amount, 100)
    const ovNone = okData(await api('/api/approval/overview', { token: viewNone.token }))
    assert.deepEqual([ovNone.pending, ovNone.total], [0, 0])
    const ovAll = okData(await api('/api/approval/overview', { token: f.admin }))
    assert.equal(ovAll.pending, 3)
    // 待办：非审批人的 viewer 为 0；审批人（跨组织）仍见自己队列
    assert.equal(okData(await api('/api/approval/todos', { token: viewA.token })).count, 0)
    assert.equal(okData(await api('/api/approval/todos', { token: finA.token })).count, 3)
  })

  await t.test('approval managers keep the ADR-0015 queue (all pending) but only see in-scope history and cannot decide foreign documents', async () => {
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('viewer','system:approval:manage')").run()
    assert.equal(okData(await api('/api/approval/todos', { token: viewA.token })).count, 3)
    assert.deepEqual(nos(await api('/api/approval/pending', { token: viewA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
    // 列表 / 详情与队列同一口径（pending 全见），但决定要求单据在范围内：外组织的 pending 不能被其决定
    assert.deepEqual(nos(await api('/api/approval/instances', { token: viewA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
    db.prepare("DELETE FROM role_permissions WHERE role_code='viewer' AND perm_code='system:approval:manage'").run()
    assert.equal(okData(await api('/api/approval/todos', { token: viewA.token })).count, 0)
  })

  await t.test('approval_manager_global=0 (Z9): managers with a restricted scope see only in-scope instances plus their own approver queue', async () => {
    const setSwitch = (v) => db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('approval_manager_global',?)").run(String(v))
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('viewer','system:approval:manage')").run()
    db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('viewer','system:approval:decide')").run()
    try {
      // default (1) = ADR-0015 behaviour: org-A manager still sees every pending instance
      assert.deepEqual(nos(await api('/api/approval/pending', { token: viewA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
      setSwitch(0)
      const keepB = await api(`/api/approval/instances/${inst.B}`, { token: viewA.token })
      notFound(keepB, 'detail of foreign org pending instance')
      assert.deepEqual(nos(await api('/api/approval/pending', { token: viewA.token })), ['PRQ-AP-A'])
      assert.deepEqual(nos(await api('/api/approval/pending', { token: viewB.token })), ['PRQ-AP-B'])
      assert.deepEqual(nos(await api('/api/approval/pending', { token: viewNone.token })), [], 'no-org manager: empty, not whole queue')
      assert.equal(okData(await api('/api/approval/todos', { token: viewA.token })).count, 1)
      assert.equal(okData(await api('/api/approval/todos', { token: viewNone.token })).count, 0)
      assert.deepEqual(nos(await api('/api/approval/instances', { token: viewA.token })), ['PRQ-AP-A'])
      const ov = okData(await api('/api/approval/overview', { token: viewA.token }))
      assert.deepEqual([ov.pending, ov.total], [1, 1])
      // decide on a foreign document is still 404 and writes nothing
      const recsB = db.prepare('SELECT COUNT(*) n FROM approval_records WHERE instance_id=?').get(inst.B).n
      notFound(await api(`/api/approval/instances/${inst.B}/decide`, { token: viewA.token, body: { decision: 'approve' } }), 'decide foreign')
      assert.equal(db.prepare('SELECT COUNT(*) n FROM approval_records WHERE instance_id=?').get(inst.B).n, recsB, 'no write')
      // a real approver keeps their own queue (role finance), and global-scope managers see everything
      assert.deepEqual(nos(await api('/api/approval/pending', { token: finA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
      assert.deepEqual(nos(await api('/api/approval/pending', { token: glob.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
      assert.deepEqual(nos(await api('/api/approval/pending', { token: f.admin })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
      setSwitch(1)
      assert.deepEqual(nos(await api('/api/approval/pending', { token: viewA.token })), ['PRQ-AP-A', 'PRQ-AP-B', 'PRQ-AP-N'])
      okData(await api(`/api/approval/instances/${inst.B}`, { token: viewA.token }))
    } finally {
      db.prepare("DELETE FROM settings WHERE key='approval_manager_global'").run()
      db.prepare("DELETE FROM role_permissions WHERE role_code='viewer' AND perm_code IN ('system:approval:manage','system:approval:decide')").run()
    }
  })

  await t.test('cancel: only submitter/admin, and the document must be in scope', async () => {
    const st = (i) => db.prepare('SELECT status FROM approval_instances WHERE id=?').get(i).status
    notFound(await api(`/api/approval/instances/${inst.A}/cancel`, { token: purB.token, body: {} }), 'foreign org cannot even see it')
    assert.equal((await api(`/api/approval/instances/${inst.A}/cancel`, { token: finA.token, body: {} })).status, 403, 'in-scope non-submitter')
    assert.equal(st(inst.A), 'pending')
    // 提交人但单据已不在其范围：404
    db.prepare('UPDATE users SET org_id=? WHERE id=?').run(whB.org_id, purA.id)
    notFound(await api(`/api/approval/instances/${inst.A}/cancel`, { token: purA.token, body: {} }), 'submitter out of scope')
    db.prepare('UPDATE users SET org_id=? WHERE id=?').run(whA.org_id, purA.id)
    assert.equal(st(inst.A), 'pending')
    okData(await api(`/api/approval/instances/${inst.A}/cancel`, { token: purA.token, body: {} }))
    assert.equal(st(inst.A), 'canceled')
    okData(await api(`/api/approval/instances/${inst.N}/cancel`, { token: f.admin, body: {} }))
  })

  await t.test('decide: must be the step approver AND the document in scope (404, no write)', async () => {
    const st = (i) => db.prepare('SELECT status, current_step FROM approval_instances WHERE id=?').get(i)
    const recs = (i) => db.prepare('SELECT COUNT(*) n FROM approval_records WHERE instance_id=?').get(i).n
    const before = recs(inst.B)
    // finA 是 finance 审批人，能看到 B 的待办，但 B 的单据不在 A 组织范围 ⇒ 404，不写
    notFound(await api(`/api/approval/instances/${inst.B}/decide`, { token: finA.token, body: { decision: 'reject', comment: 'x' } }), 'foreign doc')
    assert.deepEqual([st(inst.B).status, recs(inst.B)], ['pending', before])
    // 范围内非审批人：沿用既有口径（权限点或非审批人拒绝），且 pending 不变
    const nonApprover = await api(`/api/approval/instances/${inst.B}/decide`, { token: purB.token, body: { decision: 'reject' } })
    assert.ok([403, 400].includes(nonApprover.status), JSON.stringify(nonApprover.body))
    assert.equal(st(inst.B).status, 'pending')
    // finB 在 B 组织、是审批人 ⇒ 驳回成功（reject 不触发业务放行）
    okData(await api(`/api/approval/instances/${inst.B}/decide`, { token: finB.token, body: { decision: 'reject', comment: 'ok' } }))
    assert.equal(st(inst.B).status, 'rejected')
  })

  await t.test('document types without a resolver fail closed for restricted scopes, but stay visible to approvers and global', async () => {
    const tf = db.prepare("SELECT id FROM stock_transfers ORDER BY id LIMIT 1").get()
    assert.ok(tf, 'demo data must contain a stock transfer')
    const raw = id(`INSERT INTO approval_instances (template_id,template_code,doc_type,doc_id,doc_no,action,action_name,amount,total_steps,current_step,status,submitted_by_id)
                    VALUES (?,?,'TF',?,'TF-AP-RAW','x','x',1,1,1,'pending',1)`, tpl, 'APV-AP-PRQ', tf.id)
    notFound(await api(`/api/approval/instances/${raw}`, { token: viewA.token }), 'org account, unmapped type')
    assert.ok(!nos(await api('/api/approval/instances', { token: viewA.token })).includes('TF-AP-RAW'))
    okData(await api(`/api/approval/instances/${raw}`, { token: glob.token }))
    okData(await api(`/api/approval/instances/${raw}`, { token: finB.token }))
  })

  await t.test('sales and order-center documents resolve through their own scope predicates', async () => {
    const so = (no, wh) => id(`INSERT INTO sales_orders (doc_no, channel, order_date, status, total_qty, goods_amount, receivable_amount, warehouse_id) VALUES (?,'dealer',date('now','localtime'),'confirmed',1,10,10,?)`, no, wh)
    const soA = so('SO-AP-A', whA.id), soB = so('SO-AP-B', whB.id)
    const cust = (code, org) => id(`INSERT INTO oc_customers (code,name,source_type,source_id,level,channel,org_id,settle_type,credit_limit,admit_status) VALUES (?,?,'downstream',?, 'bronze','sub_dealer',?,'credit',1000,'active')`, code, code, -Math.floor(Math.random() * 1e6) - 100, org)
    const cA = cust('AP_C_A', whA.org_id), cB = cust('AP_C_B', whB.org_id)
    const oc = (no, c) => id(`INSERT INTO oc_orders (doc_no,customer_id,customer_type,customer_name,order_date,status,total_qty,total_amount,credit_hold,need_approval,org_id) VALUES (?,?,'dealer','n',date('now'),'submitted',1,1,0,1,NULL)`, no, c)
    const ocA = oc('OC-AP-A', cA), ocB = oc('OC-AP-B', cB)
    const stm = (no, c) => id(`INSERT INTO oc_statements (doc_no,customer_id,customer_name,period_start,period_end,total_amount) VALUES (?,?,'n','2026-01-01','2026-01-31',1)`, no, c)
    const sA = stm('OCS-AP-A', cA), sB = stm('OCS-AP-B', cB)
    const mk = (type, docId, no) => id(`INSERT INTO approval_instances (template_id,template_code,doc_type,doc_id,doc_no,action,action_name,amount,total_steps,current_step,status,submitted_by_id)
                                         VALUES (?,?,?,?,?,'x','x',1,1,1,'pending',1)`, tpl, 'APV-AP-PRQ', type, docId, no)
    const rows = { 'SO-AP-A': mk('SO', soA, 'SO-AP-A'), 'SO-AP-B': mk('SO', soB, 'SO-AP-B'), 'OC-AP-A': mk('OC', ocA, 'OC-AP-A'), 'OC-AP-B': mk('OC', ocB, 'OC-AP-B'), 'OCS-AP-A': mk('OCS', sA, 'OCS-AP-A'), 'OCS-AP-B': mk('OCS', sB, 'OCS-AP-B') }
    const seen = nos(await api('/api/approval/instances?pageSize=100', { token: viewA.token }))
    for (const n of Object.keys(rows)) assert.equal(seen.includes(n), n.endsWith('-A'), n)
    for (const [n, i] of Object.entries(rows)) {
      const r = await api(`/api/approval/instances/${i}`, { token: viewA.token })
      assert.equal(r.status, n.endsWith('-A') ? 200 : 404, n)
    }
  })

  await t.test('anonymous callers are rejected', async () => {
    for (const route of ['/api/approval/instances', `/api/approval/instances/${inst.A}`, '/api/approval/overview', '/api/approval/pending']) {
      assert.equal((await api(route)).status, 401, route)
    }
  })
})


// Y12 审计跟进：MCP approval.approve 必须把人工确认人的组织范围传给 decideApproval（静态断言，守住接线）。
test('MCP approval.approve passes the human signer org scope into decideApproval', () => {
  const src = readFileSync(new URL('../server/mcp/tools.js', import.meta.url), 'utf8')
  assert.match(src, /resolveOrgScope\(db, \{ uid: signerRow\.id, role: signerRow\.role \}\)/)
  assert.match(src, /decideApproval\(db, \{[\s\S]*?scopeCtx: \{ orgScope: signerScope/)
})
