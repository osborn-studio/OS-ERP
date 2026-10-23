/**
 * ============================================================================
 * 文件标识：tests/funds-maker-checker.test.mjs ｜ 测试：收付款的证据闸与二人复核（ADR-0018）
 * ============================================================================
 * 【职责】守住 F10 的"人工资金模式"口径：
 *   ① 确认收款 / 执行付款必须带凭证号（`funds_evidence_required`）；
 *   ② 金额 ≥ 阈值且复核打开 → 只挂成待复核，应收 / 授信台账 / 结算单一分不动；
 *   ③ 发起人不能复核自己的单（`FUNDS_SELF_REVIEW`）；
 *   ④ 批准恰好生效一次（应收余额、credit_release_ledger 行数、付款单状态）；驳回不留任何资金效果；
 *   ⑤ 严格审计写不进去 → 批准整笔回滚，单据仍是待复核；
 *   ⑥ 权限：没有 `finance.funds.review` 的角色 403；阈值以下 / 复核关闭 → 直接确认（仍要求凭证）。
 *
 * 【夹具口径】前半段内存库 + schema.sql + 全部迁移，经销商 / 订单 / 发票夹具与 credit-settlement.test.mjs 同源，
 *   直接调 `lib/funds-review.js`；后半段起一个 test 运行时的隔离服务（全新临时目录 + 随机回环端口）走 HTTP，
 *   账号经 `/api/auth/users` 建。合成凭据不输出。
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
import { ensureAr, createReceipt, confirmReceipt } from '../server/lib/ar.js'
import { occupy, openAmountOf } from '../server/lib/credit.js'
import { createPayment, transitionPayment, getPayment } from '../server/lib/purchase.js'
import { writeSetting } from '../server/lib/settings.js'
import { confirmFunds, reviewFunds, assertNotPending, FUNDS_REVIEW_PERM } from '../server/lib/funds-review.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const A = { id: 101, name: 'maker-a' }
const B = { id: 202, name: 'checker-b' }

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db)
  db.prepare("INSERT INTO dealers (id,code,name) VALUES (1,'TEST-DEALER','Synthetic test dealer')").run()
  db.prepare("INSERT INTO credit_accounts (id,subject_type,subject_id,credit_limit) VALUES (1,'dealer',1,10000)").run()
  db.prepare("INSERT INTO sales_orders (id,doc_no,dealer_id,order_date,status,receivable_amount) VALUES (1,'SO-TEST-1',1,'2026-01-01','confirmed',100)").run()
  occupy(db, { account: 1, amount: 100, sourceType: 'SO', sourceId: 1, docNo: 'SO-TEST-1' })
  db.prepare(`INSERT INTO sales_invoices (id,doc_no,subject_type,subject_id,order_id,invoice_date,total_amount,status)
    VALUES (11,'SI-TEST-11','dealer',1,1,'2026-01-01',60,'confirmed')`).run()
  const ar = ensureAr(db, { subjectType: 'dealer', subjectId: 1, sourceType: 'SI', sourceId: 11, sourceDocNo: 'SI-TEST-11', amount: 60 })
  const receipt = (amount) => createReceipt(db, { subjectType: 'dealer', subjectId: 1, amount, allocations: [{ ar_id: ar.id, amount }] })
  const setting = (key, value) => writeSetting(db, { key, value, reason: 'test fixture', actor: { id: 1, name: 'test' } })
  const confirm = (id, actor, evidence) => confirmFunds(db, {
    kind: 'receipt', id, actor, evidence, apply: () => confirmReceipt(db, { id, actor })
  })
  const review = (id, actor, decision, comment) => reviewFunds(db, {
    kind: 'receipt', id, actor, decision, comment, apply: () => confirmReceipt(db, { id, actor })
  })
  const state = (id) => ({
    status: db.prepare('SELECT status FROM receipts WHERE id=?').get(id).status,
    review: db.prepare('SELECT review_status FROM receipts WHERE id=?').get(id).review_status,
    allocated: db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(ar.id).allocated_amount,
    hold: openAmountOf(db, 1, 'SO', 1),
    releaseRows: db.prepare('SELECT count(*) n FROM credit_release_ledger').get().n,
    audits: (action) => db.prepare('SELECT count(*) n FROM audit_logs WHERE action=?').get(action).n
  })
  return { db, ar, receipt, setting, confirm, review, state }
}

test('evidence is required on confirm by default and may be relaxed by setting', (t) => {
  const f = fixture(t)
  const rc = f.receipt(25)
  assert.throws(() => f.confirm(rc.id, A, {}), { code: 'FUNDS_EVIDENCE_REQUIRED', status: 400 })
  assert.throws(() => f.confirm(rc.id, A, { ref: '   ' }), { code: 'FUNDS_EVIDENCE_REQUIRED' })
  assert.deepEqual([f.state(rc.id).status, f.state(rc.id).review, f.state(rc.id).allocated], ['draft', null, 0])
  f.setting('funds_evidence_required', '0')
  const out = f.confirm(rc.id, A, {})
  assert.equal(out.applied, false, 'review still required: no evidence but pending')
  assert.equal(out.review.status, 'pending_review')
  assert.equal(out.review.evidence_ref, null)
})

test('threshold routes: at or above goes to pending_review with no money effect, below confirms directly', (t) => {
  const f = fixture(t)
  f.setting('funds_review_threshold', '30')
  const small = f.receipt(25)
  const direct = f.confirm(small.id, A, { ref: 'BANK-0001', note: 'small' })
  assert.equal(direct.applied, true)
  assert.equal(direct.review.status, null)
  assert.equal(direct.result.status, 'confirmed')
  assert.equal(direct.result.credit_released.unified, 25)
  assert.equal(f.state(small.id).status, 'confirmed')
  assert.equal(f.state(small.id).allocated, 25)
  assert.equal(f.state(small.id).audits('FUNDS_CONFIRM'), 1)
  assert.equal(db(f).prepare('SELECT evidence_ref, evidence_note FROM receipts WHERE id=?').get(small.id).evidence_ref, 'BANK-0001')

  const big = f.receipt(30)
  const pending = f.confirm(big.id, A, { ref: 'BANK-0002' })
  assert.equal(pending.applied, false)
  assert.equal(pending.review.status, 'pending_review')
  assert.equal(pending.review.maker.id, A.id)
  const s = f.state(big.id)
  assert.equal(s.status, 'draft', 'kernel status untouched while pending')
  assert.equal(s.allocated, 25, 'no additional AR allocation')
  assert.equal(s.hold, 75, 'no additional credit release')
  assert.equal(s.releaseRows, 1)
  assert.equal(s.audits('FUNDS_REVIEW_REQUEST'), 1)
  // while pending, re-confirm and other actions are rejected
  assert.throws(() => f.confirm(big.id, A, { ref: 'BANK-0002' }), { code: 'FUNDS_REVIEW_PENDING', status: 409 })
  assert.throws(() => assertNotPending(db(f), 'receipt', big.id), { code: 'FUNDS_REVIEW_PENDING' })
})

test('self-review is rejected and leaves the document pending', (t) => {
  const f = fixture(t)
  const rc = f.receipt(40)
  f.confirm(rc.id, A, { ref: 'BANK-0003' })
  assert.throws(() => f.review(rc.id, A, 'approve', 'looks fine'), { code: 'FUNDS_SELF_REVIEW', status: 409 })
  assert.throws(() => f.review(rc.id, { id: null, name: A.name }, 'reject', 'nope'), { code: 'FUNDS_SELF_REVIEW' })
  assert.equal(f.state(rc.id).review, 'pending_review')
  assert.equal(f.state(rc.id).allocated, 0)
  assert.throws(() => f.review(rc.id, B, 'maybe', 'x'), { code: 'FUNDS_BAD_DECISION', status: 400 })
  assert.throws(() => f.review(rc.id, B, 'reject', ''), { code: 'FUNDS_COMMENT_REQUIRED', status: 400 })
})

test('approve applies the real confirm exactly once; reject leaves no effect and allows re-request', (t) => {
  const f = fixture(t)
  const rc = f.receipt(40)
  f.confirm(rc.id, A, { ref: 'BANK-0004' })

  const rejected = f.review(rc.id, B, 'reject', 'voucher does not match bank statement')
  assert.equal(rejected.applied, false)
  assert.equal(rejected.review.status, 'rejected')
  assert.equal(rejected.review.checker.id, B.id)
  assert.equal(rejected.review.comment, 'voucher does not match bank statement')
  let s = f.state(rc.id)
  assert.deepEqual([s.status, s.allocated, s.hold, s.releaseRows], ['draft', 0, 100, 0])
  assert.equal(s.audits('FUNDS_REVIEW_REJECT'), 1)
  assert.throws(() => f.review(rc.id, B, 'approve'), { code: 'FUNDS_NOT_PENDING', status: 409 })

  // maker fixes evidence and asks again
  const again = f.confirm(rc.id, A, { ref: 'BANK-0004-FIXED' })
  assert.equal(again.review.status, 'pending_review')
  assert.equal(again.review.checker, null)
  const approved = f.review(rc.id, B, 'approve', 'matches statement line 12')
  assert.equal(approved.applied, true)
  assert.equal(approved.review.status, 'approved')
  assert.equal(approved.result.status, 'confirmed')
  assert.equal(approved.result.credit_released.unified, 40)
  s = f.state(rc.id)
  assert.deepEqual([s.status, s.allocated, s.hold, s.releaseRows], ['confirmed', 40, 60, 1])
  assert.equal(s.audits('FUNDS_REVIEW_APPROVE'), 1)
  assert.equal(db(f).prepare("SELECT count(*) n FROM doc_events WHERE doc_type='RCP' AND action='confirm'").get().n, 1)
  // nothing can be applied twice
  assert.throws(() => f.review(rc.id, B, 'approve'), { code: 'FUNDS_NOT_PENDING' })
  assert.throws(() => f.confirm(rc.id, A, { ref: 'x' }), { code: 'FUNDS_NOT_READY', status: 409 })
  assert.deepEqual([f.state(rc.id).allocated, f.state(rc.id).hold, f.state(rc.id).releaseRows], [40, 60, 1])
})

test('strict audit failure rolls back the approve: still pending, no AR/credit effect', (t) => {
  const f = fixture(t)
  const rc = f.receipt(40)
  f.confirm(rc.id, A, { ref: 'BANK-0005' })
  const events = db(f).prepare('SELECT count(*) n FROM doc_events').get().n
  db(f).exec("CREATE TRIGGER block_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit down'); END")
  assert.throws(() => f.review(rc.id, B, 'approve', 'ok'), { code: 'SECURITY_AUDIT_UNAVAILABLE', status: 503 })
  const s = f.state(rc.id)
  assert.deepEqual([s.status, s.review, s.allocated, s.hold, s.releaseRows], ['draft', 'pending_review', 0, 100, 0])
  assert.equal(db(f).prepare('SELECT count(*) n FROM doc_events').get().n, events)
  assert.equal(db(f).prepare('SELECT review_checker_id FROM receipts WHERE id=?').get(rc.id).review_checker_id, null)
  // direct confirm path is also strict
  f.setting('funds_review_required', '0')
  const rc2 = f.receipt(10)
  assert.throws(() => f.confirm(rc2.id, A, { ref: 'BANK-0006' }), { code: 'SECURITY_AUDIT_UNAVAILABLE' })
  assert.equal(f.state(rc2.id).status, 'draft')
  db(f).exec('DROP TRIGGER block_audit')
  assert.equal(f.confirm(rc2.id, A, { ref: 'BANK-0006' }).applied, true)
  assert.equal(f.review(rc.id, B, 'approve', 'ok').applied, true)
})

test('review disabled: confirm applies directly but evidence is still required', (t) => {
  const f = fixture(t)
  f.setting('funds_review_required', '0')
  const rc = f.receipt(50)
  assert.throws(() => f.confirm(rc.id, A, {}), { code: 'FUNDS_EVIDENCE_REQUIRED' })
  const out = f.confirm(rc.id, A, { ref: 'BANK-0007' })
  assert.equal(out.applied, true)
  assert.equal(f.state(rc.id).status, 'confirmed')
  assert.equal(f.state(rc.id).allocated, 50)
  assert.equal(f.state(rc.id).audits('FUNDS_CONFIRM'), 1)
  assert.equal(f.state(rc.id).audits('FUNDS_REVIEW_REQUEST'), 0)
})

test('purchase payment pay goes through the same gate and the pay effects happen once on approve', (t) => {
  const f = fixture(t)
  const d = db(f)
  d.prepare("INSERT INTO suppliers (id,code,name) VALUES (7,'SUP-T','Synthetic supplier')").run()
  d.prepare(`INSERT INTO purchase_settlements (id,doc_no,supplier_id,settle_date,settle_amount,status)
             VALUES (70,'PST-TEST-70',7,'2026-01-10',500,'audited')`).run()
  const pay = createPayment(d, { supplierId: 7, payDate: '2026-01-11', amount: 200, actor: A, allocations: [{ settle_id: 70, amount: 200 }] })
  transitionPayment(d, { id: pay.id, action: 'submit', actor: A })
  assert.equal(getPayment(d, pay.id).status, 'approved')
  const payApply = (actor) => () => transitionPayment(d, { id: pay.id, action: 'pay', actor })
  assert.throws(() => confirmFunds(d, { kind: 'payment', id: pay.id, actor: A, evidence: {}, apply: payApply(A) }), { code: 'FUNDS_EVIDENCE_REQUIRED' })
  const pending = confirmFunds(d, { kind: 'payment', id: pay.id, actor: A, evidence: { ref: 'WIRE-77' }, apply: payApply(A) })
  assert.equal(pending.applied, false)
  assert.equal(getPayment(d, pay.id).status, 'approved')
  assert.equal(d.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='pay'").get().n, 0)
  assert.throws(() => reviewFunds(d, { kind: 'payment', id: pay.id, actor: A, decision: 'approve', apply: payApply(A) }), { code: 'FUNDS_SELF_REVIEW' })
  const ok = reviewFunds(d, { kind: 'payment', id: pay.id, actor: B, decision: 'approve', comment: 'bank slip attached', apply: payApply(B) })
  assert.equal(ok.applied, true)
  const after = getPayment(d, pay.id)
  assert.equal(after.status, 'paid')
  assert.equal(after.evidence_ref, 'WIRE-77')
  assert.equal(after.review_status, 'approved')
  assert.equal(d.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='pay'").get().n, 1)
  assert.equal(d.prepare('SELECT paid_amount FROM purchase_settlements WHERE id=70').get().paid_amount, 200)
  assert.equal(d.prepare("SELECT count(*) n FROM audit_logs WHERE action='FUNDS_REVIEW_APPROVE' AND entity='purchase_payments'").get().n, 1)
})

const db = (f) => f.db

// ---------------------------------------------------------------------------
// HTTP：权限门与路由（隔离 test 服务）
// ---------------------------------------------------------------------------
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-funds-review-'))
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
    return { id: r.body.data.id, username, token: await login(username, password) }
  }
  return { dir, api, db, admin, account }
}

const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }
const expectCode = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body))
  if (code) assert.equal(r.body.error ?? r.body.detail?.code, code, JSON.stringify(r.body))
}

test('HTTP: receipt confirm/review routes enforce evidence, permission, self-review and settings', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const maker = await f.account('funds_maker', 'finance')
  const checker = await f.account('funds_checker', 'finance')
  const sales = await f.account('funds_sales', 'sales', { data_scope: 'all' })
  assert.ok(db.prepare("SELECT 1 FROM role_permissions WHERE role_code='finance' AND perm_code=?").get(FUNDS_REVIEW_PERM), 'migration grants finance the review permission')
  assert.ok(!db.prepare("SELECT 1 FROM role_permissions WHERE role_code='sales' AND perm_code=?").get(FUNDS_REVIEW_PERM))

  const dealer = db.prepare('SELECT id, name FROM dealers ORDER BY id LIMIT 1').get()
  assert.ok(dealer, 'demo data must provide a dealer')
  const ar = okData(await api('/api/ar/documents', { token: maker.token, body: { subject_type: 'dealer', subject_id: dealer.id, subject_name: dealer.name, source_type: 'MANUAL', amount: 300 } }))
  const mkReceipt = async (amount) => okData(await api('/api/ar/receipts', { token: maker.token, body: { subject_type: 'dealer', subject_id: dealer.id, amount, allocations: [{ ar_id: ar.id, amount }] } }))
  const confirm = (id, token, body = {}) => api(`/api/ar/receipts/${id}/confirm`, { token, body })
  const review = (id, token, body) => api(`/api/ar/receipts/${id}/review`, { token, body })
  const arAllocated = () => db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(ar.id).allocated_amount

  const rc = await mkReceipt(100)
  expectCode(await confirm(rc.id, maker.token), 400, 'FUNDS_EVIDENCE_REQUIRED')
  const pending = okData(await confirm(rc.id, maker.token, { evidence_ref: 'BANK-HTTP-1', evidence_note: 'statement line 3' }))
  assert.equal(pending.status, 'draft')
  assert.equal(pending.review.status, 'pending_review')
  assert.equal(pending.review.maker.id, maker.id)
  assert.equal(arAllocated(), 0)
  // listing / detail carry the review block
  const detail = okData(await api(`/api/ar/receipts/${rc.id}`, { token: maker.token }))
  assert.equal(detail.review.status, 'pending_review')
  assert.equal(detail.evidence_ref, 'BANK-HTTP-1')
  const list = okData(await api('/api/ar/receipts?status=draft', { token: maker.token }))
  assert.equal(list.rows.find((x) => x.id === rc.id).review_status, 'pending_review')

  expectCode(await confirm(rc.id, maker.token, { evidence_ref: 'BANK-HTTP-1' }), 409, 'FUNDS_REVIEW_PENDING')
  expectCode(await api(`/api/ar/receipts/${rc.id}/void`, { token: maker.token, body: { reason: 'x' } }), 409, 'FUNDS_REVIEW_PENDING')
  expectCode(await review(rc.id, sales.token, { decision: 'approve' }), 403)
  expectCode(await review(rc.id, maker.token, { decision: 'approve' }), 409, 'FUNDS_SELF_REVIEW')
  expectCode(await review(rc.id, checker.token, { decision: 'reject' }), 400, 'FUNDS_COMMENT_REQUIRED')
  assert.equal(arAllocated(), 0)

  const approved = okData(await review(rc.id, checker.token, { decision: 'approve', comment: 'ok' }))
  assert.equal(approved.status, 'confirmed')
  assert.equal(approved.review.status, 'approved')
  assert.equal(approved.review.checker.id, checker.id)
  assert.ok(approved.review.decided_at)
  assert.equal(arAllocated(), 100)
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='FUNDS_REVIEW_APPROVE' AND entity_id=?").get(String(rc.id)).n, 1)
  expectCode(await review(rc.id, checker.token, { decision: 'approve', comment: 'again' }), 409, 'FUNDS_NOT_PENDING')
  assert.equal(arAllocated(), 100)

  // reject path returns to draft; admin may review someone else's request
  const rc2 = await mkReceipt(50)
  okData(await confirm(rc2.id, maker.token, { evidence_ref: 'BANK-HTTP-2' }))
  const rejected = okData(await review(rc2.id, f.admin, { decision: 'reject', comment: 'wrong amount' }))
  assert.equal(rejected.status, 'draft')
  assert.equal(rejected.review.status, 'rejected')
  assert.equal(arAllocated(), 100)

  // settings off → direct confirm; evidence still required; admin changes are audited as settings
  const put = (key, value) => api('/api/meta/settings', { method: 'PUT', token: f.admin, body: { key, value, reason: 'test: switch funds review' } })
  okData(await put('funds_review_required', '0'))
  const fresh = await mkReceipt(20)
  expectCode(await confirm(fresh.id, maker.token, {}), 400, 'FUNDS_EVIDENCE_REQUIRED')
  assert.equal(okData(await confirm(fresh.id, maker.token, { evidence_ref: 'BANK-HTTP-2a' })).status, 'confirmed')
  // evidence already stored on the row from the rejected request satisfies the gate on re-confirm
  const direct = okData(await confirm(rc2.id, maker.token, { evidence_ref: 'BANK-HTTP-2b' }))
  assert.equal(direct.status, 'confirmed')
  assert.equal(direct.review.status, 'rejected', 'last review verdict is kept for the record; confirm applied directly')
  assert.equal(arAllocated(), 170)
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='FUNDS_CONFIRM' AND entity_id=?").get(String(rc2.id)).n, 1)

  // threshold: below → direct, at/above → pending
  okData(await put('funds_review_required', '1'))
  okData(await put('funds_review_threshold', '60'))
  const small = await mkReceipt(50)
  assert.equal(okData(await confirm(small.id, maker.token, { evidence_ref: 'BANK-HTTP-3' })).status, 'confirmed')
  const big = await mkReceipt(60)
  assert.equal(okData(await confirm(big.id, maker.token, { evidence_ref: 'BANK-HTTP-4' })).review.status, 'pending_review')
})

test('HTTP: payment pay is gated and the generic action route cannot bypass the review', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const checker = await f.account('pay_checker', 'finance')
  const purchaser = await f.account('pay_purchaser', 'purchase', { data_scope: 'all' })
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()
  assert.ok(supplier, 'demo data must provide a supplier')
  const settleId = Number(db.prepare(`INSERT INTO purchase_settlements (doc_no,supplier_id,settle_date,settle_amount,status)
    VALUES ('PST-FUNDS-HTTP',?,'2026-01-10',900,'audited')`).run(supplier.id).lastInsertRowid)
  const pay = okData(await api('/api/purchase/payments', { token: f.admin, body: { supplier_id: supplier.id, amount: 300, allocations: [{ settle_id: settleId, amount: 300 }] } }))
  okData(await api(`/api/purchase/payments/${pay.id}/submit`, { token: f.admin, body: {} }))
  const act = (action, token, body = {}) => api(`/api/purchase/payments/${pay.id}/${action}`, { token, body })

  expectCode(await act('pay', f.admin), 400, 'FUNDS_EVIDENCE_REQUIRED')
  const pending = okData(await act('pay', f.admin, { evidence_ref: 'WIRE-HTTP-1' }))
  assert.equal(pending.status, 'approved')
  assert.equal(pending.review.status, 'pending_review')
  assert.equal(db.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='pay' AND doc_id=?").get(pay.id).n, 0)
  // generic action route is closed while pending; review verb is not a kernel action
  expectCode(await act('pay', f.admin, { evidence_ref: 'WIRE-HTTP-1' }), 409, 'FUNDS_REVIEW_PENDING')
  expectCode(await act('void', f.admin), 409, 'FUNDS_REVIEW_PENDING')
  expectCode(await act('review', purchaser.token, { decision: 'approve' }), 403)
  expectCode(await act('review', f.admin, { decision: 'approve' }), 409, 'FUNDS_SELF_REVIEW')
  const detail = okData(await api(`/api/purchase/payments/${pay.id}`, { token: f.admin }))
  assert.equal(detail.review.status, 'pending_review')

  const done = okData(await act('review', checker.token, { decision: 'approve', comment: 'slip verified' }))
  assert.equal(done.status, 'paid')
  assert.equal(done.review.status, 'approved')
  assert.equal(db.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='pay' AND doc_id=?").get(pay.id).n, 1)
  assert.equal(db.prepare('SELECT paid_amount FROM purchase_settlements WHERE id=?').get(settleId).paid_amount, 300)
  expectCode(await act('review', checker.token, { decision: 'approve', comment: 'again' }), 409, 'FUNDS_NOT_PENDING')
})
