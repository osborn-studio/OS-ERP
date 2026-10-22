/**
 * ============================================================================
 * 文件标识：tests/credit-reversal.test.mjs ｜ 测试：收款作废 / 预收抵扣的授信逆向恢复（按释放台账逐笔）
 * ============================================================================
 * 【职责】守住两条 P1 授信阻塞（backlog「开发过程中新增确认的授信阻塞」）：
 *   ① 作废已确认收款必须**按释放台账逐笔**恢复统一授信（不按总额猜）；
 *   ② 预收抵扣（applyPrepay）与确认收款走**同一份来源映射 + 释放台账**，
 *      释放有上限（不超过来源占用）、作废时逐笔恢复、跨客户拒绝。
 *
 * 【夹具口径】内存库 + schema.sql + 全部迁移；一个经销商两张订单（各占用 100），
 *   两张发票挂 SO-1（60/40）、一张发票挂 SO-2（100）。与 credit-settlement.test.mjs 同源。
 *
 * 【改它要注意什么】数值断言都是"回到收款前"的绝对值，不是"比之前大了"——
 *   改成相对断言就守不住"恢复过头 / 恢复不足"这两种错。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { ensureAr, createReceipt, confirmReceipt, voidReceipt, applyPrepay } from '../server/lib/ar.js'
import { occupy, openAmountOf, creditSnapshot, auditCredit } from '../server/lib/credit.js'

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db)
  db.prepare("INSERT INTO dealers (id,code,name) VALUES (1,'TEST-DEALER','Synthetic test dealer')").run()
  db.prepare("INSERT INTO credit_accounts (id,subject_type,subject_id,credit_limit) VALUES (1,'dealer',1,10000)").run()
  for (const id of [1, 2]) {
    db.prepare("INSERT INTO sales_orders (id,doc_no,dealer_id,order_date,status,receivable_amount) VALUES (?, ?,1,'2026-01-01','confirmed',100)").run(id, `SO-TEST-${id}`)
    occupy(db, { account: 1, amount: 100, sourceType: 'SO', sourceId: id, docNo: `SO-TEST-${id}`, creditDays: 30 })
  }
  function invoice(id, orderId, amount, subjectId = 1) {
    db.prepare(`INSERT INTO sales_invoices (id,doc_no,subject_type,subject_id,order_id,invoice_date,total_amount,status)
      VALUES (?,?,'dealer',?,?,'2026-01-01',?,'confirmed')`).run(id, `SI-TEST-${id}`, subjectId, orderId, amount)
    return ensureAr(db, { subjectType: 'dealer', subjectId, sourceType: 'SI', sourceId: id, sourceDocNo: `SI-TEST-${id}`, amount })
  }
  const first = invoice(11, 1, 60)
  const second = invoice(12, 1, 40)
  const other = invoice(21, 2, 100)
  function receipt(allocations, { subjectId = 1, amount = null } = {}) {
    return createReceipt(db, { subjectType: 'dealer', subjectId,
      amount: amount ?? allocations.reduce((n, a) => n + a.amount, 0), allocations })
  }
  function secondDealer() {
    db.prepare("INSERT INTO dealers (id,code,name) VALUES (2,'TEST-OTHER','Synthetic other customer')").run()
    db.prepare("INSERT INTO credit_accounts (id,subject_type,subject_id,credit_limit) VALUES (2,'dealer',2,10000)").run()
    db.prepare("INSERT INTO sales_orders (id,doc_no,dealer_id,order_date,status,receivable_amount) VALUES (99,'SO-OTHER',2,'2026-01-01','confirmed',50)").run()
    occupy(db, { account: 2, amount: 50, sourceType: 'SO', sourceId: 99, docNo: 'SO-OTHER' })
    return invoice(91, 99, 50, 2)
  }
  const ledger = (receiptId) => db.prepare('SELECT * FROM credit_release_ledger WHERE receipt_id=? ORDER BY id').all(receiptId)
  const arRow = (id) => db.prepare('SELECT allocated_amount, status FROM ar_documents WHERE id=?').get(id)
  const receiptStatus = (id) => db.prepare('SELECT status FROM receipts WHERE id=?').get(id).status
  const count = (sql) => db.prepare(sql).get().n
  return { db, first, second, other, receipt, invoice, secondDealer, ledger, arRow, receiptStatus, count }
}

const baseline = (db) => ({
  so1: openAmountOf(db, 1, 'SO', 1),
  so2: openAmountOf(db, 1, 'SO', 2),
  used: creditSnapshot(db, 1).used
})

test('void of a partial receipt restores the SO credit and AR balance to the pre-receipt state', t => {
  const { db, first, receipt, ledger, arRow, receiptStatus } = fixture(t)
  const before = baseline(db)
  assert.deepEqual(before, { so1: 100, so2: 100, used: 200 })
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 75)
  const released = ledger(rc.id)
  assert.equal(released.length, 1)
  assert.equal(released[0].source_type, 'SO')
  assert.equal(released[0].source_id, 1)
  assert.equal(released[0].customer_type, 'dealer')
  assert.equal(released[0].customer_id, 1)
  assert.equal(released[0].amount, 25)
  assert.equal(released[0].reversed_at, null)

  const out = voidReceipt(db, { id: rc.id, reason: 'test' })
  assert.equal(receiptStatus(rc.id), 'voided')
  assert.deepEqual(baseline(db), before)
  assert.deepEqual(arRow(first.id), { allocated_amount: 0, status: 'open' })
  const reversed = ledger(rc.id)
  assert.equal(reversed.length, 1)
  assert.ok(reversed[0].reversed_at)
  assert.ok(reversed[0].reversal_ref)
  assert.equal(out.credit_reversal.entries, 1)
  assert.equal(out.credit_reversal.unified, 25)
  assert.equal(auditCredit(db).ledger_balance_drift.length, 0)
  // the restore row carries the original due date so overdue tracking is not reset
  const restore = db.prepare('SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 1').get()
  assert.equal(restore.amount, 25)
  assert.equal(restore.source_type, 'SO')
  assert.equal(restore.source_id, 1)
  assert.ok(restore.due_date)
})

test('multi-invoice, multi-order receipt reverses only its own entries', t => {
  const { db, first, second, other, receipt, ledger } = fixture(t)
  const a = receipt([{ ar_id: first.id, amount: 30 }, { ar_id: other.id, amount: 20 }])
  const b = receipt([{ ar_id: second.id, amount: 15 }])
  confirmReceipt(db, { id: a.id })
  confirmReceipt(db, { id: b.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 55)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 80)

  voidReceipt(db, { id: a.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 85)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 100)
  assert.equal(creditSnapshot(db, 1).used, 185)
  assert.ok(ledger(a.id).every(r => r.reversed_at))
  assert.ok(ledger(b.id).every(r => r.reversed_at == null))
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(second.id).allocated_amount, 15)
})

test('voiding one customer receipt never touches another customer credit', t => {
  const { db, first, receipt, secondDealer } = fixture(t)
  const otherAr = secondDealer()
  const mine = receipt([{ ar_id: first.id, amount: 25 }])
  const theirs = receipt([{ ar_id: otherAr.id, amount: 10 }], { subjectId: 2 })
  confirmReceipt(db, { id: mine.id })
  confirmReceipt(db, { id: theirs.id })
  assert.equal(openAmountOf(db, 2, 'SO', 99), 40)
  voidReceipt(db, { id: mine.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(openAmountOf(db, 2, 'SO', 99), 40)
  assert.equal(creditSnapshot(db, 2).used, 40)
})

test('repeat void is rejected and does not restore twice', t => {
  const { db, first, receipt, count } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  voidReceipt(db, { id: rc.id })
  const rows = count('SELECT count(*) AS n FROM credit_ledger')
  assert.throws(() => voidReceipt(db, { id: rc.id }), { code: 'RC_ALREADY_VOID' })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(count('SELECT count(*) AS n FROM credit_ledger'), rows)
})

test('cross-customer reversal is rejected and leaves the receipt confirmed', t => {
  const { db, first, receipt, secondDealer, arRow, receiptStatus } = fixture(t)
  secondDealer()
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  db.prepare('UPDATE credit_release_ledger SET customer_id=2 WHERE receipt_id=?').run(rc.id)
  assert.throws(() => voidReceipt(db, { id: rc.id }), { code: 'CREDIT_REVERSAL_SUBJECT_MISMATCH' })
  assert.equal(receiptStatus(rc.id), 'confirmed')
  assert.equal(openAmountOf(db, 1, 'SO', 1), 75)
  assert.equal(openAmountOf(db, 2, 'SO', 99), 50)
  assert.deepEqual(arRow(first.id), { allocated_amount: 25, status: 'partial' })
})

test('a failure in the middle of the reversal rolls back receipt, AR and earlier restores', t => {
  const { db, first, other, receipt, ledger, arRow, receiptStatus, count } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }, { ar_id: other.id, amount: 15 }])
  confirmReceipt(db, { id: rc.id })
  const eventsBefore = count('SELECT count(*) AS n FROM doc_events')
  db.exec(`CREATE TRIGGER reject_second_restore BEFORE INSERT ON credit_ledger
    WHEN NEW.amount>0 AND NEW.source_id=2 BEGIN SELECT RAISE(ABORT,'test restore failure'); END`)
  assert.throws(() => voidReceipt(db, { id: rc.id }), /test restore failure/)
  assert.equal(receiptStatus(rc.id), 'confirmed')
  assert.deepEqual(arRow(first.id), { allocated_amount: 25, status: 'partial' })
  assert.deepEqual(arRow(other.id), { allocated_amount: 15, status: 'partial' })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 75)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 85)
  assert.ok(ledger(rc.id).every(r => r.reversed_at == null))
  assert.equal(count('SELECT count(*) AS n FROM doc_events'), eventsBefore)
})

test('a capped release is recorded with the released amount and restored by exactly that amount', t => {
  const { db, first, receipt, ledger } = fixture(t)
  db.prepare("UPDATE credit_ledger SET amount=10,balance_after=10 WHERE source_type='SO' AND source_id=1").run()
  db.prepare("UPDATE credit_ledger SET balance_after=110 WHERE source_type='SO' AND source_id=2").run()
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 0)
  assert.equal(ledger(rc.id)[0].amount, 10)
  voidReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 10)
  assert.equal(creditSnapshot(db, 1).used, 110)
})

test('a restore that would exceed the source occupancy is rejected', t => {
  const { db, first, receipt } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  // something else already put the whole occupancy back: a further restore has no room
  db.prepare("DELETE FROM credit_ledger WHERE change_type='settle'").run()
  assert.throws(() => voidReceipt(db, { id: rc.id }), { code: 'CREDIT_REVERSAL_EXCEEDS_SOURCE' })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id=?').get(rc.id).status, 'confirmed')
})

test('receipt confirmation refuses to release credit held by another customer', t => {
  const { db, receipt, secondDealer, invoice } = fixture(t)
  secondDealer()
  // invoice billed to dealer 1 but its order belongs to dealer 2
  const crossed = invoice(31, 99, 20, 1)
  const rc = receipt([{ ar_id: crossed.id, amount: 20 }])
  assert.throws(() => confirmReceipt(db, { id: rc.id }), { code: 'CREDIT_RELEASE_SUBJECT_MISMATCH' })
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id=?').get(rc.id).status, 'draft')
  assert.equal(openAmountOf(db, 2, 'SO', 99), 50)
  assert.equal(db.prepare('SELECT count(*) AS n FROM credit_release_ledger').get().n, 0)
})

test('prepay application releases unified credit per originating SO, bounded by the source occupancy', t => {
  const { db, first, other, receipt, ledger } = fixture(t)
  const rc = receipt([], { amount: 100 })
  confirmReceipt(db, { id: rc.id })
  assert.equal(ledger(rc.id).length, 0)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)

  const applied = applyPrepay(db, { receiptId: rc.id, arId: first.id, amount: 30 })
  assert.equal(applied.applied, 30)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 70)
  assert.equal(applied.credit_released.unified, 30)
  const rows = ledger(rc.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trigger, 'prepay')
  assert.equal(rows[0].source_type, 'SO')
  assert.equal(rows[0].source_id, 1)
  assert.equal(rows[0].amount, 30)

  // SO-2 only holds 10 of credit: applying 40 of debt releases 10, never more
  db.prepare("UPDATE credit_ledger SET amount=10,balance_after=110 WHERE source_type='SO' AND source_id=2").run()
  db.prepare("UPDATE credit_ledger SET balance_after=balance_after-90 WHERE id>(SELECT id FROM credit_ledger WHERE source_type='SO' AND source_id=2)").run()
  const second = applyPrepay(db, { receiptId: rc.id, arId: other.id, amount: 40 })
  assert.equal(second.applied, 40)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 0)
  assert.equal(ledger(rc.id)[1].amount, 10)
  assert.equal(db.prepare("SELECT SUM(amount) AS n FROM credit_ledger WHERE change_type='settle'").get().n, -40)
  assert.equal(auditCredit(db).ledger_balance_drift.length, 0)
})

test('voiding a receipt after prepay applications restores every recorded entry', t => {
  const { db, first, other, receipt, ledger, arRow } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 20 }], { amount: 100 })
  confirmReceipt(db, { id: rc.id })
  applyPrepay(db, { receiptId: rc.id, arId: other.id, amount: 30 })
  applyPrepay(db, { receiptId: rc.id, arId: first.id, amount: 10 })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 70)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 70)
  assert.equal(ledger(rc.id).length, 3)

  const out = voidReceipt(db, { id: rc.id })
  assert.equal(out.credit_reversal.entries, 3)
  assert.equal(out.credit_reversal.unified, 60)
  assert.deepEqual(baseline(db), { so1: 100, so2: 100, used: 200 })
  assert.deepEqual(arRow(first.id), { allocated_amount: 0, status: 'open' })
  assert.deepEqual(arRow(other.id), { allocated_amount: 0, status: 'open' })
  assert.ok(ledger(rc.id).every(r => r.reversed_at))
})

test('cross-customer prepay application is rejected without releasing anything', t => {
  const { db, first, receipt, secondDealer, ledger } = fixture(t)
  secondDealer()
  const rc = receipt([], { subjectId: 2, amount: 40 })
  confirmReceipt(db, { id: rc.id })
  assert.throws(() => applyPrepay(db, { receiptId: rc.id, arId: first.id, amount: 10 }), { code: 'PREPAY_SUBJECT_MISMATCH' })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(openAmountOf(db, 2, 'SO', 99), 50)
  assert.equal(ledger(rc.id).length, 0)
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(first.id).allocated_amount, 0)
})

test('confirm with releaseCredit=false records nothing, so void restores nothing', t => {
  const { db, first, receipt, ledger } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id, releaseCredit: false })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(ledger(rc.id).length, 0)
  const out = voidReceipt(db, { id: rc.id })
  assert.equal(out.credit_reversal.entries, 0)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(creditSnapshot(db, 1).used, 200)
})

function ocFixture(t) {
  const f = fixture(t)
  const { db } = f
  db.prepare("INSERT INTO oc_customers (id,code,name,source_type,source_id,credit_limit) VALUES (7,'OC-7','Synthetic oc customer','dealer',1,5000)").run()
  db.prepare("INSERT INTO oc_orders (id,doc_no,customer_id,order_date,status,total_amount,credit_hold) VALUES (70,'OC-TEST-70',7,'2026-01-01','received',300,300)").run()
  db.prepare("INSERT INTO oc_credit_ledger (customer_id,order_id,doc_no,change_type,amount,balance_after) VALUES (7,70,'OC-TEST-70','occupy',300,300)").run()
  const ocAr = ensureAr(db, { subjectType: 'oc', subjectId: 7, sourceType: 'OC', sourceId: 70, sourceDocNo: 'OC-TEST-70', amount: 300 })
  const hold = () => db.prepare('SELECT credit_hold FROM oc_orders WHERE id=70').get().credit_hold
  const ocUsed = () => db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM oc_credit_ledger WHERE customer_id=7').get().s
  return { ...f, ocAr, hold, ocUsed }
}

test('order-center receipt release is recorded and its void restores exactly the recorded OC entry', t => {
  const { db, ocAr, hold, ocUsed, ledger } = ocFixture(t)
  const rc = createReceipt(db, { subjectType: 'oc', subjectId: 7, amount: 120, allocations: [{ ar_id: ocAr.id, amount: 120 }] })
  confirmReceipt(db, { id: rc.id })
  assert.equal(hold(), 180)
  assert.equal(ocUsed(), 180)
  const rows = ledger(rc.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ledger, 'oc')
  assert.equal(rows[0].source_type, 'OC')
  assert.equal(rows[0].source_id, 70)
  assert.equal(rows[0].customer_type, 'oc')
  assert.equal(rows[0].customer_id, 7)
  assert.equal(rows[0].amount, 120)

  const out = voidReceipt(db, { id: rc.id })
  assert.equal(out.credit_reversal.oc, 120)
  assert.equal(hold(), 300)
  assert.equal(ocUsed(), 300)
  assert.ok(ledger(rc.id)[0].reversed_at)
  // the unified ledger of the merged dealer subject is untouched by an OC-only receipt
  assert.equal(creditSnapshot(db, 1).own_used, 200)
})

test('a receipt confirmed before the release ledger existed still restores OC occupancy by allocation and reports legacy', t => {
  const { db, ocAr, hold, ledger } = ocFixture(t)
  const rc = createReceipt(db, { subjectType: 'oc', subjectId: 7, amount: 120, allocations: [{ ar_id: ocAr.id, amount: 120 }] })
  confirmReceipt(db, { id: rc.id })
  db.prepare('DELETE FROM credit_release_ledger WHERE receipt_id=?').run(rc.id)
  assert.equal(ledger(rc.id).length, 0)
  const out = voidReceipt(db, { id: rc.id })
  assert.equal(out.credit_reversal.legacy, true)
  assert.equal(out.credit_reversal.entries, 0)
  assert.equal(hold(), 300)
})
