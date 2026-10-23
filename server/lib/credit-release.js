/**
 * ============================================================================
 * 文件标识：server/lib/credit-release.js ｜ 收款释放授信的唯一入口 + 作废时按释放台账逐笔逆向
 * ============================================================================
 * 【职责】
 *   ① `releaseForReceipt`：确认收款与预收抵扣**共用**的释放实现 —— 把每条核销明细映射到
 *      占用所在的来源（SI → 其 SO；SO / OC / 无来源 → RCP），释放，并把**实际释放额**记进
 *      `credit_release_ledger`（哪本台账、哪个客户、哪张来源单、多少）。
 *   ② `reverseForReceipt`：作废收款时**只按台账行**逐笔恢复，不按收款总额猜；
 *      重复逆向、跨客户、超来源占用一律拒绝；全程在调用方事务里，中途失败整体回滚。
 *
 * 【为什么是一个文件】"释放"和"恢复"必须读同一份归属：确认收款、预收抵扣原来各写一遍
 *   释放（且预收只释放 OC），作废又按核销明细去猜恢复额 —— 三处口径各自演化，统一授信
 *   就是这样漏掉的（backlog「开发过程中新增确认的授信阻塞」两条 P1）。
 *   依赖方向：ar → credit-release → credit / oc-credit（本文件不得反向 import ar.js）。
 *
 * 【改它要注意什么】
 *   · 释放额以台账函数的回报（`settle().amount` / `releaseByOrder().released`）为准，
 *     不是核销明细金额 —— 两者在封顶时不同；
 *   · 逆向的上限判据在 `credit.reoccupy`（统一授信）与本文件的 OC 分支，拒绝不截平；
 *   · 迁移 052 之前确认的收款单没有台账行：OC 退回旧口径（按明细回补）并标 `legacy`，
 *     统一授信**无法恢复** —— 这是如实暴露，不是兜底猜测。
 * ============================================================================
 */
import { settle as creditSettle, reoccupy as creditReoccupy, CreditError } from './credit.js'
import { releaseByOrder as ocReleaseByOrder, reoccupyByOrder as ocReoccupyByOrder } from './oc-credit.js'
import { localNow } from './dates.js'

const money = (n) => Number((Number(n) || 0).toFixed(2))

/** 与 ar.js 同一组来源常量；这里不 import ar.js（避免循环依赖） */
const SRC_SO = 'SO'
const SRC_OC = 'OC'
const SRC_SI = 'SI'
const SRC_RCP = 'RCP'

/**
 * 应收单 → 授信占用所在的来源。
 * 发票（SI）名下的债权属于它的销售订单：占用写在 SO 名下，释放也必须找 SO。
 * 手工发票（没有 order_id）保留 SI 来源 —— 不把发票 id 当订单 id 用。
 */
export function creditSourceOfAr(db, ar) {
  if (ar.source_type === SRC_SI && ar.source_id) {
    const order = db.prepare(`SELECT so.id, so.doc_no
      FROM sales_invoices si JOIN sales_orders so ON so.id=si.order_id
      WHERE si.id=?`).get(ar.source_id)
    if (order) return { sourceType: SRC_SO, sourceId: order.id, docNo: order.doc_no }
  }
  return { sourceType: ar.source_type, sourceId: ar.source_id, docNo: ar.source_doc_no || ar.doc_no }
}

function accountOfReceipt(db, receipt) {
  return db
    .prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?')
    .get(receipt.subject_type, receipt.subject_id) || null
}

/**
 * 这张来源单据的占用是否挂在别的信用账户上。
 * 发票开给 A、订单却属于 B 时，按 A 的账户去释放 B 的占用会静默空转（openAmountOf=0）；
 * 这里把它变成显式拒绝 —— 跨客户释放不是"没释放"，是账错了。
 */
function assertSourceOwnedBy(db, account, { sourceType, sourceId }) {
  const holders = db
    .prepare(
      `SELECT account_id, SUM(amount) s FROM credit_ledger
        WHERE source_type=? AND source_id=? GROUP BY account_id HAVING s > 0.005`
    )
    .all(sourceType, sourceId)
  const foreign = holders.find((h) => Number(h.account_id) !== Number(account.id))
  if (foreign) {
    throw new CreditError(
      `${sourceType}#${sourceId} 的授信占用在另一客户账户（#${foreign.account_id}）名下，不能由本收款单释放`,
      { code: 'CREDIT_RELEASE_SUBJECT_MISMATCH', httpStatus: 409, detail: { sourceType, sourceId, holder: foreign.account_id, account: account.id } }
    )
  }
}

function record(db, row) {
  const info = db
    .prepare(
      `INSERT INTO credit_release_ledger
        (receipt_id, ar_id, trigger, ledger, account_id, customer_type, customer_id,
         source_type, source_id, doc_no, amount, ledger_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      row.receiptId, row.arId ?? null, row.trigger, row.ledger, row.accountId ?? null,
      row.customerType, row.customerId, row.sourceType, row.sourceId ?? null, row.docNo ?? null,
      money(row.amount), row.ledgerId ?? null, localNow()
    )
  return { id: Number(info.lastInsertRowid), ...row, amount: money(row.amount) }
}

/**
 * 按核销明细释放授信并记台账。
 * @param allocations [{ ar_id, amount }] —— 本次生效的核销明细（确认收款：全部；预收抵扣：本次 plan）
 * @param trigger 'confirm' | 'prepay'
 * @param unified false 时跳过统一授信（保留 `confirmReceipt({releaseCredit:false})` 的旧口径），OC 台账照常
 * @returns { entries, unified, oc }
 */
export function releaseForReceipt(db, { receipt, allocations, trigger, actor = null, unified = true }) {
  const entries = []
  const acc = unified ? accountOfReceipt(db, receipt) : null
  const base = { receiptId: receipt.id, trigger, customerType: receipt.subject_type, customerId: Number(receipt.subject_id) }
  let rcpFallback = 0
  const rcpArIds = []

  for (const a of allocations) {
    const amt = money(a.amount)
    if (!(amt > 0.005)) continue
    const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
    if (!ar) continue

    // 订货中心订单：占用在 oc_credit_ledger，与统一授信无关（统一视图只是读它）
    if (ar.source_type === SRC_OC && ar.source_id) {
      const r = ocReleaseByOrder(db, {
        orderId: ar.source_id, amount: amt, changeType: 'repay', operator: actor?.name || null,
        remark: `${trigger === 'prepay' ? '预收抵账释放' : '回款核销释放'}（${ar.source_doc_no || ar.doc_no}）`
      })
      if (r.released > 0.005) {
        const ledgerId = db.prepare('SELECT MAX(id) id FROM oc_credit_ledger WHERE order_id=?').get(ar.source_id)?.id ?? null
        entries.push(record(db, {
          ...base, arId: ar.id, ledger: 'oc', accountId: null,
          sourceType: SRC_OC, sourceId: ar.source_id, docNo: ar.source_doc_no || ar.doc_no,
          amount: r.released, ledgerId
        }))
      }
      continue
    }
    if (!acc) continue

    if (ar.source_type && ar.source_id) {
      const src = creditSourceOfAr(db, ar)
      assertSourceOwnedBy(db, acc, src)
      const r = creditSettle(db, {
        account: acc.id, amount: amt, ...src, operator: actor,
        remark: `${trigger === 'prepay' ? '预收抵账释放授信' : '收款核销释放授信'}（对应 ${ar.doc_no}）`
      })
      if (r) {
        entries.push(record(db, {
          ...base, arId: ar.id, ledger: 'credit', accountId: acc.id,
          sourceType: src.sourceType, sourceId: src.sourceId, docNo: src.docNo, amount: r.amount, ledgerId: r.id
        }))
      }
    } else {
      // 没有来源的应收（手工补账）仍按收款单本身释放，保留旧口径不误伤
      rcpFallback = money(rcpFallback + amt)
      rcpArIds.push(ar.id)
    }
  }

  if (acc && rcpFallback > 0.005) {
    const r = creditSettle(db, {
      account: acc.id, amount: rcpFallback, sourceType: SRC_RCP, sourceId: receipt.id, docNo: receipt.doc_no,
      operator: actor, remark: '收款核销释放授信（无来源应收）'
    })
    if (r) {
      entries.push(record(db, {
        ...base, arId: rcpArIds.length === 1 ? rcpArIds[0] : null, ledger: 'credit', accountId: acc.id,
        sourceType: SRC_RCP, sourceId: receipt.id, docNo: receipt.doc_no, amount: r.amount, ledgerId: r.id
      }))
    }
  }

  return summarize(entries)
}

function summarize(entries, extra = {}) {
  return {
    entries: entries.length,
    unified: money(entries.filter((e) => e.ledger === 'credit').reduce((s, e) => s + e.amount, 0)),
    oc: money(entries.filter((e) => e.ledger === 'oc').reduce((s, e) => s + e.amount, 0)),
    rows: entries,
    ...extra
  }
}

/** 某张收款单的释放台账行（含已逆向的） */
export function releasesOfReceipt(db, receiptId) {
  return db.prepare('SELECT * FROM credit_release_ledger WHERE receipt_id=? ORDER BY id').all(receiptId)
}

/**
 * 作废收款：按释放台账逐笔恢复。
 * 拒绝：已有行被逆向过（CREDIT_RELEASE_ALREADY_REVERSED）· 行的客户 ≠ 收款单客户 / 账户主体
 * （CREDIT_REVERSAL_SUBJECT_MISMATCH）· 恢复额超过来源可恢复额（CREDIT_REVERSAL_EXCEEDS_SOURCE）。
 * 没有任何行（迁移 052 之前确认的收款单）：OC 退回按核销明细回补并标 `legacy:true`，统一授信不动。
 */
export function reverseForReceipt(db, { receipt, allocations = [], actor = null, reason = null }) {
  const rows = releasesOfReceipt(db, receipt.id)
  if (!rows.length) return legacyReverse(db, { receipt, allocations, actor, reason })

  const done = rows.filter((r) => r.reversed_at)
  if (done.length) {
    throw new CreditError(
      `收款单 ${receipt.doc_no} 的授信释放已逆向过（${done.length} 笔），不能重复恢复`,
      { code: 'CREDIT_RELEASE_ALREADY_REVERSED', httpStatus: 409, detail: { receipt_id: receipt.id, reversed: done.map((r) => r.id) } }
    )
  }

  const mismatch = (row, why) => new CreditError(
    `释放台账 #${row.id} 的客户（${row.customer_type}#${row.customer_id}）与收款单往来对象不一致：${why}`,
    { code: 'CREDIT_REVERSAL_SUBJECT_MISMATCH', httpStatus: 409, detail: { ledger_id: row.id, receipt_id: receipt.id, why } }
  )
  const mark = db.prepare('UPDATE credit_release_ledger SET reversed_at=?, reversal_ref=? WHERE id=?')
  const restored = []

  for (const row of rows) {
    if (row.customer_type !== receipt.subject_type || Number(row.customer_id) !== Number(receipt.subject_id)) {
      throw mismatch(row, `收款单为 ${receipt.subject_type}#${receipt.subject_id}`)
    }
    const remark = `核销作废恢复占用（${receipt.doc_no}${reason ? '：' + reason : ''}）`
    if (row.ledger === 'credit') {
      const acc = row.account_id ? db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(row.account_id) : null
      if (!acc) throw mismatch(row, '信用账户不存在')
      if (acc.subject_type !== row.customer_type || Number(acc.subject_id) !== Number(row.customer_id)) {
        throw mismatch(row, `信用账户 #${acc.id} 属于 ${acc.subject_type}#${acc.subject_id}`)
      }
      const r = creditReoccupy(db, {
        account: acc.id, amount: row.amount, sourceType: row.source_type, sourceId: row.source_id, docNo: row.doc_no,
        operator: actor, remark
      })
      mark.run(localNow(), `credit_ledger#${r.id}`, row.id)
      restored.push({ ...row, reversal_ref: `credit_ledger#${r.id}` })
    } else {
      const order = db.prepare('SELECT id, customer_id FROM oc_orders WHERE id=?').get(row.source_id)
      if (!order) throw mismatch(row, '订货单不存在')
      if (Number(order.customer_id) !== Number(row.customer_id)) throw mismatch(row, `订货单属于客户 #${order.customer_id}`)
      const r = ocReoccupyByOrder(db, { orderId: order.id, amount: row.amount, operator: actor?.name || null, remark })
      if (money(r.occupied) + 0.005 < money(row.amount)) {
        throw new CreditError(
          `订货单 #${order.id} 可恢复占用只有 ${money(r.occupied)}，本次要恢复 ${money(row.amount)}`,
          { code: 'CREDIT_REVERSAL_EXCEEDS_SOURCE', httpStatus: 409, detail: { ledger_id: row.id, order_id: order.id, occupied: r.occupied, amount: row.amount } }
        )
      }
      const ledgerId = db.prepare('SELECT MAX(id) id FROM oc_credit_ledger WHERE order_id=?').get(order.id)?.id ?? null
      mark.run(localNow(), `oc_credit_ledger#${ledgerId}`, row.id)
      restored.push({ ...row, reversal_ref: `oc_credit_ledger#${ledgerId}` })
    }
  }
  return summarize(restored, { legacy: false })
}

/** 迁移 052 之前确认的收款单：没有释放台账，只能沿用旧口径回补 OC；统一授信如实不动 */
function legacyReverse(db, { receipt, allocations, actor, reason }) {
  let oc = 0
  for (const a of allocations) {
    const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
    if (ar?.source_type === SRC_OC && ar.source_id) {
      const r = ocReoccupyByOrder(db, {
        orderId: ar.source_id, amount: a.amount, operator: actor?.name || null,
        remark: `核销作废恢复占用（${ar.source_doc_no || ar.doc_no}${reason ? '：' + reason : ''}）`
      })
      oc = money(oc + (r.occupied || 0))
    }
  }
  return { entries: 0, unified: 0, oc, rows: [], legacy: true, receipt_id: receipt.id }
}

export default { creditSourceOfAr, releaseForReceipt, reverseForReceipt, releasesOfReceipt }
