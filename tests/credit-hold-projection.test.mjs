/**
 * ============================================================================
 * 文件标识：tests/credit-hold-projection.test.mjs ｜ 测试：sales_orders.credit_hold 是台账的派生投影，只有一个写入者
 * ============================================================================
 * 【职责】守住 ADR-0014：`sales_orders.credit_hold`（单据视角的"本单还占着多少"）
 *   必须在**每一次**台账变动的同一事务里由 `credit.js` 自己重算 ——
 *   占用（订单确认 / seed 补历史占用）、释放（取消订单）、核销（确认收款 / 预收抵扣）、
 *   恢复（作废收款）四条路径都不许由调用方另写一遍 `UPDATE sales_orders SET credit_hold=…`。
 *   `reconcileOrderHolds` 是唯一的对账判据：每一步之后差异必须为空。
 *
 * 【夹具口径】与 credit-reversal.test.mjs 同源：一个经销商两张订单（各占用 100），
 *   两张发票挂 SO-1（60/40）、一张发票挂 SO-2（100）。夹具**不**手写 credit_hold —— 它由 occupy 投影出来。
 *
 * 【改它要注意什么】断言都是"回到收款前 / 等于台账净占用"的绝对值；
 *   故障注入用 SQLite 触发器打断台账或投影其中一侧，另一侧必须跟着回滚。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { ensureAr, createReceipt, confirmReceipt, voidReceipt, applyPrepay } from '../server/lib/ar.js'
import { occupy, release, openAmountOf, auditCredit, reconcileOrderHolds } from '../server/lib/credit.js'
import { cancelOrder } from '../server/lib/sales-order.js'

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
  function invoice(id, orderId, amount) {
    db.prepare(`INSERT INTO sales_invoices (id,doc_no,subject_type,subject_id,order_id,invoice_date,total_amount,status)
      VALUES (?,?,'dealer',1,?,'2026-01-01',?,'confirmed')`).run(id, `SI-TEST-${id}`, orderId, amount)
    return ensureAr(db, { subjectType: 'dealer', subjectId: 1, sourceType: 'SI', sourceId: id, sourceDocNo: `SI-TEST-${id}`, amount })
  }
  const first = invoice(11, 1, 60)
  const second = invoice(12, 1, 40)
  const other = invoice(21, 2, 100)
  const receipt = (allocations, { amount = null } = {}) =>
    createReceipt(db, { subjectType: 'dealer', subjectId: 1,
      amount: amount ?? allocations.reduce((n, a) => n + a.amount, 0), allocations })
  const hold = (id) => db.prepare('SELECT credit_hold FROM sales_orders WHERE id=?').get(id).credit_hold
  const holds = () => ({ so1: hold(1), so2: hold(2) })
  const ledgers = () => ({ so1: openAmountOf(db, 1, 'SO', 1), so2: openAmountOf(db, 1, 'SO', 2) })
  const clean = () => {
    assert.deepEqual(reconcileOrderHolds(db), [])
    assert.deepEqual(holds(), ledgers())
    assert.equal(auditCredit(db).order_hold_diff.length, 0)
  }
  return { db, first, second, other, receipt, hold, holds, clean }
}

test('occupy projects the hold onto the order without the caller writing credit_hold', t => {
  const { holds, clean } = fixture(t)
  assert.deepEqual(holds(), { so1: 100, so2: 100 })
  clean()
})

test('receipt confirmation lowers the hold of exactly the originating order', t => {
  const { db, first, receipt, holds, clean } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.deepEqual(holds(), { so1: 75, so2: 100 })
  clean()
})

test('prepay application lowers the hold per source like a confirmation', t => {
  const { db, first, other, receipt, holds, clean } = fixture(t)
  const rc = receipt([], { amount: 100 })
  confirmReceipt(db, { id: rc.id })
  assert.deepEqual(holds(), { so1: 100, so2: 100 })
  applyPrepay(db, { receiptId: rc.id, arId: first.id, amount: 30 })
  assert.deepEqual(holds(), { so1: 70, so2: 100 })
  clean()
  applyPrepay(db, { receiptId: rc.id, arId: other.id, amount: 40 })
  assert.deepEqual(holds(), { so1: 70, so2: 60 })
  clean()
})

test('void restores the hold to the pre-receipt value', t => {
  const { db, first, receipt, holds, clean } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.deepEqual(holds(), { so1: 75, so2: 100 })
  voidReceipt(db, { id: rc.id, reason: 'test' })
  assert.deepEqual(holds(), { so1: 100, so2: 100 })
  clean()
})

test('partial, multi-invoice, multi-order receipts keep every order projection in step', t => {
  const { db, first, second, other, receipt, holds, clean } = fixture(t)
  const a = receipt([{ ar_id: first.id, amount: 30 }, { ar_id: other.id, amount: 20 }])
  const b = receipt([{ ar_id: second.id, amount: 15 }])
  confirmReceipt(db, { id: a.id })
  assert.deepEqual(holds(), { so1: 70, so2: 80 })
  clean()
  confirmReceipt(db, { id: b.id })
  assert.deepEqual(holds(), { so1: 55, so2: 80 })
  clean()
  voidReceipt(db, { id: a.id })
  assert.deepEqual(holds(), { so1: 85, so2: 100 })
  clean()
  // a capped release (SO-2 only holds 10) projects the capped amount, not the allocation
  db.prepare("UPDATE credit_ledger SET amount=10,balance_after=10 WHERE change_type='occupy' AND source_id=2 AND id=2").run()
  db.prepare("UPDATE credit_ledger SET balance_after=balance_after-90 WHERE id>2").run()
  db.prepare('UPDATE sales_orders SET credit_hold=10 WHERE id=2').run()
  const c = receipt([{ ar_id: other.id, amount: 40 }])
  confirmReceipt(db, { id: c.id })
  assert.deepEqual(holds(), { so1: 85, so2: 0 })
  clean()
})

test('release on cancel and a manual release both zero the projection', t => {
  const { db, holds, clean } = fixture(t)
  release(db, { account: 1, sourceType: 'SO', sourceId: 2, docNo: 'SO-TEST-2' })
  assert.deepEqual(holds(), { so1: 100, so2: 0 })
  clean()
  cancelOrder(db, { id: 1, reason: 'test', actor: { id: 1, name: 'tester' } })
  assert.deepEqual(holds(), { so1: 0, so2: 0 })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 0)
  clean()
})

test('reconciliation reports drift when the projection is edited behind the ledger', t => {
  const { db, clean } = fixture(t)
  clean()
  db.prepare('UPDATE sales_orders SET credit_hold=42 WHERE id=1').run()
  const diffs = reconcileOrderHolds(db)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].order_id, 1)
  assert.equal(diffs[0].hold, 42)
  assert.equal(diffs[0].ledger, 100)
  assert.equal(diffs[0].diff, -58)
  assert.equal(auditCredit(db).balanced, false)
  // a zero hold hiding a live occupancy is drift too, not a clean order
  db.prepare('UPDATE sales_orders SET credit_hold=0 WHERE id=1').run()
  assert.equal(reconcileOrderHolds(db).length, 1)
})

test('a projection write failure rolls back the ledger row and the receipt', t => {
  const { db, first, receipt, holds, clean } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  const rows = db.prepare('SELECT count(*) AS n FROM credit_ledger').get().n
  db.exec(`CREATE TRIGGER reject_hold_update BEFORE UPDATE OF credit_hold ON sales_orders
    WHEN NEW.id=1 BEGIN SELECT RAISE(ABORT,'test projection failure'); END`)
  assert.throws(() => confirmReceipt(db, { id: rc.id }), /test projection failure/)
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id=?').get(rc.id).status, 'draft')
  assert.equal(db.prepare('SELECT count(*) AS n FROM credit_ledger').get().n, rows)
  assert.equal(db.prepare('SELECT count(*) AS n FROM credit_release_ledger').get().n, 0)
  assert.deepEqual(holds(), { so1: 100, so2: 100 })
  db.exec('DROP TRIGGER reject_hold_update')
  clean()
})

test('a ledger write failure leaves the projection untouched', t => {
  const { db, first, other, receipt, holds, clean } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }, { ar_id: other.id, amount: 15 }])
  db.exec(`CREATE TRIGGER reject_second_credit BEFORE INSERT ON credit_ledger
    WHEN NEW.change_type='settle' AND NEW.source_id=2 BEGIN SELECT RAISE(ABORT,'test credit failure'); END`)
  assert.throws(() => confirmReceipt(db, { id: rc.id }), /test credit failure/)
  assert.deepEqual(holds(), { so1: 100, so2: 100 })
  db.exec('DROP TRIGGER reject_second_credit')
  clean()
})
