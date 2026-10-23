/**
 * ============================================================================
 * 文件标识：tests/payment-reversal.test.mjs ｜ 测试：供应商付款作废按付款释放台账逐笔逆向（ADR-0024）
 * ============================================================================
 * 【职责】守住：付款生效按结算单逐笔记 `payment_release_ledger`；作废只按这些行逆向，
 *   结算单已付额 / 未付余额回到付款前的**绝对值**；重复作废、跨供应商、恢复多于释放一律 409；
 *   待复核（ADR-0018）的付款不能作废；作废中途失败整体回滚。
 * 【夹具口径】内存库 + schema.sql + 全部迁移；两个供应商，供应商 7 有两张已审核结算单（500 / 300）。
 * 【改它要注意什么】数值断言是"回到付款前"的绝对值，不要改成相对断言。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { createPayment, transitionPayment, getPayment } from '../server/lib/purchase.js'

const A = { id: 1, name: 'maker' }

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db)
  for (const [id, code] of [[7, 'SUP-T7'], [8, 'SUP-T8']]) {
    db.prepare('INSERT INTO suppliers (id,code,name) VALUES (?,?,?)').run(id, code, `Synthetic supplier ${id}`)
  }
  const settle = (id, supplier, amount) => db.prepare(
    `INSERT INTO purchase_settlements (id,doc_no,supplier_id,settle_date,settle_amount,status)
     VALUES (?,?,?,'2026-01-10',?,'audited')`).run(id, `PST-TEST-${id}`, supplier, amount)
  settle(70, 7, 500)
  settle(71, 7, 300)
  settle(80, 8, 400)
  const pay = (supplierId, allocations, amount = null) => createPayment(db, {
    supplierId, payDate: '2026-01-11', actor: A, allocations,
    amount: amount ?? allocations.reduce((n, a) => n + a.amount, 0)
  })
  const submit = (id) => transitionPayment(db, { id, action: 'submit', actor: A })
  const voidIt = (id) => transitionPayment(db, { id, action: 'void', actor: A })
  const paid = (id) => db.prepare('SELECT paid_amount FROM purchase_settlements WHERE id=?').get(id).paid_amount
  const open = (id) => {
    const r = db.prepare('SELECT settle_amount, paid_amount FROM purchase_settlements WHERE id=?').get(id)
    return Math.round((r.settle_amount - r.paid_amount) * 100) / 100
  }
  const rows = (pid) => db.prepare('SELECT * FROM payment_release_ledger WHERE payment_id=? ORDER BY id').all(pid)
  const status = (pid) => db.prepare('SELECT status FROM purchase_payments WHERE id=?').get(pid).status
  return { db, pay, submit, voidIt, paid, open, rows, status }
}

test('migration 057 creates the payment release ledger', (t) => {
  const f = fixture(t)
  const cols = f.db.prepare('PRAGMA table_info(payment_release_ledger)').all().map((c) => c.name)
  for (const c of ['payment_id', 'supplier_id', 'settle_id', 'amount', 'paid_before', 'paid_after', 'reversed_at', 'reversal_ref']) {
    assert.ok(cols.includes(c), c)
  }
})

test('submit records one ledger row per settlement with exact before/after paid amounts', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }, { settle_id: 71, amount: 150 }])
  assert.equal(f.rows(p.id).length, 0, 'draft has no release')
  f.submit(p.id)
  const rows = f.rows(p.id)
  assert.deepEqual(rows.map((r) => [r.settle_id, r.supplier_id, r.amount, r.paid_before, r.paid_after, r.reversed_at]),
    [[70, 7, 200, 0, 200, null], [71, 7, 150, 0, 150, null]])
  assert.equal(f.open(70), 300)
  assert.equal(f.open(71), 150)
})

test('void restores payable balances to the exact pre-payment values and marks rows reversed', (t) => {
  const f = fixture(t)
  const other = f.pay(7, [{ settle_id: 70, amount: 100 }])
  f.submit(other.id)
  const before = [f.paid(70), f.paid(71), f.open(70), f.open(71)]
  assert.deepEqual(before, [100, 0, 400, 300])
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }, { settle_id: 71, amount: 150 }])
  f.submit(p.id)
  assert.deepEqual([f.paid(70), f.paid(71)], [300, 150])
  f.voidIt(p.id)
  assert.deepEqual([f.paid(70), f.paid(71), f.open(70), f.open(71)], before)
  assert.equal(f.status(p.id), 'voided')
  const rows = f.rows(p.id)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.reversed_at && r.reversal_ref))
  assert.equal(f.rows(other.id)[0].reversed_at, null, 'other payment untouched')
})

test('void of a draft payment has nothing to reverse and changes no balance', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.voidIt(p.id)
  assert.equal(f.status(p.id), 'voided')
  assert.equal(f.paid(70), 0)
  assert.equal(f.rows(p.id).length, 0)
})

test('repeat void is rejected and never restores twice', (t) => {
  const f = fixture(t)
  const keep = f.pay(7, [{ settle_id: 70, amount: 100 }])
  f.submit(keep.id)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.voidIt(p.id)
  assert.equal(f.paid(70), 100)
  assert.throws(() => f.voidIt(p.id), (e) => e.status === 409)
  assert.equal(f.paid(70), 100)
  // forcing the status back must still be refused by the ledger itself
  f.db.prepare("UPDATE purchase_payments SET status='approved' WHERE id=?").run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_RELEASE_ALREADY_REVERSED' && e.status === 409)
  assert.equal(f.paid(70), 100)
})

test('a ledger row attributed to another supplier is refused and nothing changes', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('UPDATE payment_release_ledger SET supplier_id=8 WHERE payment_id=?').run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_REVERSAL_SUBJECT_MISMATCH' && e.status === 409)
  assert.equal(f.status(p.id), 'approved')
  assert.equal(f.paid(70), 200)
  assert.equal(f.rows(p.id)[0].reversed_at, null)
})

test('a ledger row pointing at another supplier settlement is refused', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('UPDATE payment_release_ledger SET settle_id=80 WHERE payment_id=?').run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_REVERSAL_SUBJECT_MISMATCH')
  assert.equal(f.paid(80), 0)
  assert.equal(f.status(p.id), 'approved')
})

test('restoring more than the settlement currently has paid is refused', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('UPDATE purchase_settlements SET paid_amount=50 WHERE id=70').run()
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_REVERSAL_EXCEEDS_RELEASED' && e.status === 409)
  assert.equal(f.paid(70), 50)
  assert.equal(f.status(p.id), 'approved')
})

test('ledger that disagrees with the recomputed balance is refused as drift', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('UPDATE payment_release_ledger SET amount=150 WHERE payment_id=?').run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_REVERSAL_DRIFT' && e.status === 409)
  assert.equal(f.paid(70), 200)
  assert.equal(f.status(p.id), 'approved')
  assert.equal(f.rows(p.id)[0].reversed_at, null)
})

test('a failure part-way through void rolls everything back', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }, { settle_id: 71, amount: 150 }])
  f.submit(p.id)
  f.db.exec(`CREATE TRIGGER t_fail BEFORE UPDATE OF paid_amount ON purchase_settlements
             WHEN NEW.id=71 AND NEW.paid_amount=0 BEGIN SELECT RAISE(ABORT,'injected'); END`)
  assert.throws(() => f.voidIt(p.id), /injected/)
  assert.equal(f.status(p.id), 'approved')
  assert.deepEqual([f.paid(70), f.paid(71)], [200, 150])
  assert.ok(f.rows(p.id).every((r) => r.reversed_at === null))
  assert.equal(f.db.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='void'").get().n, 0)
  f.db.exec('DROP TRIGGER t_fail')
  f.voidIt(p.id)
  assert.deepEqual([f.paid(70), f.paid(71)], [0, 0])
})

test('a payment pending second-person review cannot be voided (ADR-0018)', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare("UPDATE purchase_payments SET review_status='pending_review' WHERE id=?").run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'FUNDS_REVIEW_PENDING' && e.status === 409)
  assert.equal(f.status(p.id), 'approved')
  assert.equal(f.paid(70), 200)
  f.db.prepare("UPDATE purchase_payments SET review_status='rejected' WHERE id=?").run(p.id)
  f.voidIt(p.id)
  assert.equal(f.paid(70), 0)
})

test('a payment effective before migration 057 (no rows) falls back to recompute and is flagged legacy', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('DELETE FROM payment_release_ledger WHERE payment_id=?').run(p.id)
  f.voidIt(p.id)
  assert.equal(f.paid(70), 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM doc_events WHERE doc_type='PAY' AND action='void' AND remark LIKE '%legacy%'").get().n, 1)
})

test('ledger row redirected to another settlement of the same supplier cannot restore more than released', (t) => {
  const f = fixture(t)
  const other = f.pay(7, [{ settle_id: 71, amount: 200 }])
  f.submit(other.id)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.prepare('UPDATE payment_release_ledger SET settle_id=71 WHERE payment_id=?').run(p.id)
  assert.throws(() => f.voidIt(p.id), (e) => e.code === 'PAY_REVERSAL_DRIFT' && e.status === 409)
  assert.deepEqual([f.paid(70), f.paid(71)], [200, 200])
  assert.equal(f.status(p.id), 'approved')
})

test('a failure in order statistics refresh rolls the void back too', (t) => {
  const f = fixture(t)
  f.db.pragma('foreign_keys=OFF')
  f.db.prepare(`INSERT INTO purchase_orders (id,doc_no,supplier_id,warehouse_id,order_date,status,paid_amount) VALUES (5,'PO-TEST-5',7,1,'2026-01-01','confirmed',0)`).run()
  f.db.prepare(`INSERT INTO purchase_receipts (id,doc_no,supplier_id,warehouse_id,order_id,receipt_date,status) VALUES (5,'RC-TEST-5',7,1,5,'2026-01-02','confirmed')`).run()
  f.db.prepare(`INSERT INTO purchase_settlement_items (settle_id,source_type,source_id) VALUES (70,'receipt',5)`).run()
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  f.db.exec(`CREATE TRIGGER t_ord BEFORE UPDATE ON purchase_orders WHEN NEW.id=5 AND EXISTS(SELECT 1 FROM purchase_payments WHERE status='voided') BEGIN SELECT RAISE(ABORT,'order-injected'); END`)
  assert.throws(() => f.voidIt(p.id), /order-injected/)
  assert.equal(f.status(p.id), 'approved')
  assert.equal(f.paid(70), 200)
  assert.ok(f.rows(p.id).every((r) => r.reversed_at === null))
})

test('pay (execute) keeps balances and does not add ledger rows', (t) => {
  const f = fixture(t)
  const p = f.pay(7, [{ settle_id: 70, amount: 200 }])
  f.submit(p.id)
  transitionPayment(db(f), { id: p.id, action: 'pay', actor: A })
  assert.equal(getPayment(f.db, p.id).status, 'paid')
  assert.equal(f.paid(70), 200)
  assert.equal(f.rows(p.id).length, 1)
})
const db = (f) => f.db
