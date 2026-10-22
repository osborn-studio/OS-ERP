import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { ensureAr, createReceipt, confirmReceipt } from '../server/lib/ar.js'
import { occupy, openAmountOf } from '../server/lib/credit.js'

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
    occupy(db, { account: 1, amount: 100, sourceType: 'SO', sourceId: id, docNo: `SO-TEST-${id}` })
  }
  function invoice(id, orderId, amount) {
    db.prepare(`INSERT INTO sales_invoices (id,doc_no,subject_type,subject_id,order_id,invoice_date,total_amount,status)
      VALUES (?,?,'dealer',1,?,'2026-01-01',?,'confirmed')`).run(id, `SI-TEST-${id}`, orderId, amount)
    return ensureAr(db, { subjectType: 'dealer', subjectId: 1, sourceType: 'SI', sourceId: id, sourceDocNo: `SI-TEST-${id}`, amount })
  }
  const first = invoice(11, 1, 60)
  const second = invoice(12, 1, 40)
  const other = invoice(21, 2, 100)
  function receipt(allocations) {
    return createReceipt(db, { subjectType: 'dealer', subjectId: 1,
      amount: allocations.reduce((n, a) => n + a.amount, 0), allocations })
  }
  return { db, first, second, other, receipt, invoice }
}

test('partial receipt against one invoice releases its SO hold and no other order hold', t => {
  const { db, first, receipt } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 75)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 100)
  assert.equal(db.prepare("SELECT count(*) AS n FROM credit_ledger WHERE source_type='SI'").get().n, 0)
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(first.id).allocated_amount, 25)
  assert.throws(() => confirmReceipt(db, { id: rc.id }))
  assert.equal(openAmountOf(db, 1, 'SO', 1), 75)
})

test('multiple invoices and multiple orders release exactly their allocated portions', t => {
  const { db, first, second, other, receipt } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 30 }, { ar_id: second.id, amount: 15 }, { ar_id: other.id, amount: 20 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 55)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 80)
  assert.equal(db.prepare("SELECT SUM(amount) AS n FROM credit_ledger WHERE change_type='settle'").get().n, -65)
})

test('settlement cannot release beyond remaining SO hold', t => {
  const { db, first, receipt } = fixture(t)
  db.prepare("UPDATE credit_ledger SET amount=10,balance_after=10 WHERE source_type='SO' AND source_id=1").run()
  const rc = receipt([{ ar_id: first.id, amount: 25 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 0)
  assert.equal(db.prepare("SELECT SUM(amount) AS n FROM credit_ledger WHERE change_type='settle'").get().n, -10)
})

test('credit write failure rolls back receipt status, receivable allocations and earlier releases', t => {
  const { db, first, other, receipt } = fixture(t)
  const rc = receipt([{ ar_id: first.id, amount: 25 }, { ar_id: other.id, amount: 15 }])
  const eventsBefore = db.prepare('SELECT count(*) AS n FROM doc_events').get().n
  db.exec(`CREATE TRIGGER reject_second_credit BEFORE INSERT ON credit_ledger
    WHEN NEW.change_type='settle' AND NEW.source_id=2 BEGIN SELECT RAISE(ABORT,'test credit failure'); END`)
  assert.throws(() => confirmReceipt(db, { id: rc.id }), /test credit failure/)
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id=?').get(rc.id).status, 'draft')
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(first.id).allocated_amount, 0)
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(other.id).allocated_amount, 0)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 100)
  assert.equal(db.prepare('SELECT count(*) AS n FROM doc_events').get().n, eventsBefore)
})

test('direct SO receivable continues to release the original SO source', t => {
  const { db, receipt } = fixture(t)
  const direct = ensureAr(db, { subjectType: 'dealer', subjectId: 1, sourceType: 'SO', sourceId: 2, amount: 100 })
  const rc = receipt([{ ar_id: direct.id, amount: 5 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 2), 95)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
})

test('invoice ID colliding with another SO ID still resolves through invoice.order_id', t => {
  const { db, invoice, receipt } = fixture(t)
  const collision = invoice(2, 1, 30)
  const rc = receipt([{ ar_id: collision.id, amount: 10 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SO', 1), 90)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 100)
})

test('a second customer cannot allocate its receipt to the first customer invoice', t => {
  const { db, first } = fixture(t)
  db.prepare("INSERT INTO dealers (id,code,name) VALUES (2,'TEST-OTHER','Synthetic other customer')").run()
  db.prepare("INSERT INTO credit_accounts (id,subject_type,subject_id,credit_limit) VALUES (2,'dealer',2,10000)").run()
  occupy(db, { account: 2, amount: 50, sourceType: 'SO', sourceId: 99, docNo: 'OTHER-SO' })
  assert.throws(() => createReceipt(db, { subjectType: 'dealer', subjectId: 2, amount: 10,
    allocations: [{ ar_id: first.id, amount: 10 }] }), { code: 'RC_SUBJECT_MISMATCH' })
  assert.equal(db.prepare('SELECT count(*) AS n FROM receipts').get().n, 0)
  assert.equal(db.prepare('SELECT allocated_amount FROM ar_documents WHERE id=?').get(first.id).allocated_amount, 0)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(openAmountOf(db, 2, 'SO', 99), 50)
})

test('manual invoice without an order retains its SI credit source and never treats invoice ID as SO ID', t => {
  const { db, invoice, receipt } = fixture(t)
  const manual = invoice(1, null, 30)
  db.prepare("UPDATE sales_invoices SET source_type='MANUAL' WHERE id=1").run()
  occupy(db, { account: 1, amount: 30, sourceType: 'SI', sourceId: 1, docNo: 'SI-TEST-1' })
  const rc = receipt([{ ar_id: manual.id, amount: 5 }])
  confirmReceipt(db, { id: rc.id })
  assert.equal(openAmountOf(db, 1, 'SI', 1), 25)
  assert.equal(openAmountOf(db, 1, 'SO', 1), 100)
  assert.equal(openAmountOf(db, 1, 'SO', 2), 100)
})
