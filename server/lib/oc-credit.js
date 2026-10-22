/**
 * ============================================================================
 * 文件标识：server/lib/oc-credit.js ｜ 订货中心授信台账（oc_credit_ledger）的唯一写入口。
 * ============================================================================
 * 【职责】订货中心授信台账（oc_credit_ledger）的唯一写入口。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 订货中心授信台账（oc_credit_ledger）的唯一写入口。
 *
 * 为什么要单独抽一个文件：
 *   这本台账原来只有一个写入口 —— 订货中心（lib/order-center.js 的 writeCredit）。
 *   模块 21 的收款核销也要往里写（回款释放占用），如果直接 import order-center.js 会形成
 *   循环依赖：order-center → ar.js（生成应收）→ order-center（释放授信）。
 *   所以把「往台账写一笔 + 维护 oc_orders.credit_hold」下沉到本文件，
 *   两边都只依赖它，依赖关系变成单向：order-center → oc-credit ← ar。
 *
 * 一条口径（与 12A 完全一致，不可另立）：
 *   **已用额度 = SUM(oc_credit_ledger.amount)，永远不读缓存列**。
 *   oc_orders.credit_hold 只是「这张订单还占着多少」的展示缓存，可随时由台账重算。
 *
 * change_type 约定（与 12A 既有口径一致，不另立新词）：
 *   occupy  订货占用（正数）
 *   release 取消 / 驳回释放（负数）
 *   repay   回款核销释放（负数）—— 对账单结清与收款核销都走这个
 *   adjust  人工调整（正负皆可）
 */

const money = (n) => Number((Number(n) || 0).toFixed(2))

/** 台账某个客户的已用额度（唯一真相） */
export function ocCreditUsed(db, customerId) {
  return money(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger WHERE customer_id=?').get(customerId).s)
}

/**
 * 写一笔台账并返回写入后的余额。
 * 所有对 oc_credit_ledger 的写入都必须经过这里 —— 直接 INSERT 会绕过 balance_after 一致性。
 */
export function writeOcCredit(db, {
  customerId, orderId = null, docNo = null, changeType, amount,
  operator = null, remark = null
}) {
  const before = ocCreditUsed(db, customerId)
  const after = money(before + money(amount))
  db.prepare(
    `INSERT INTO oc_credit_ledger (customer_id,order_id,doc_no,change_type,amount,balance_after,operator,remark,created_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))`
  ).run(customerId, orderId, docNo, changeType, money(amount), after, operator, remark)
  return after
}

/**
 * 按订单释放占用：先看台账上该订单的净占用，再决定实际能释放多少。
 * 为什么不能直接减 credit_hold：credit_hold 是缓存，可能因为历史数据与台账不一致；
 * 以台账净占用为准，缓存只跟着走，避免「释放出一个负数占用」。
 */
export function releaseByOrder(db, { orderId, amount = null, changeType = 'repay', operator = null, remark = null }) {
  const order = db.prepare('SELECT id, doc_no, customer_id, credit_hold FROM oc_orders WHERE id=?').get(orderId)
  if (!order) return { released: 0, skipped: 'order_not_found' }

  // 台账上该订单的净占用（occupy 正、release/settle 负）
  const ledgerNet = money(
    db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger WHERE order_id=?').get(orderId).s
  )
  const hold = money(order.credit_hold)
  const cap = Math.max(0, Math.min(ledgerNet, hold))
  const want = amount == null ? cap : money(Math.min(Math.abs(money(amount)), cap))
  if (want <= 0.005) return { released: 0, skipped: 'nothing_to_release', ledgerNet, hold }

  const after = writeOcCredit(db, {
    customerId: order.customer_id,
    orderId: order.id,
    docNo: order.doc_no,
    changeType,
    amount: -want,
    operator,
    remark: remark || `${changeType === 'repay' ? '回款核销' : '释放'}（${order.doc_no}）`
  })
  db.prepare('UPDATE oc_orders SET credit_hold = ROUND(credit_hold - ?, 2), updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
    .run(want, order.id)
  return { released: want, balance_after: after, ledgerNet, hold }
}

/** 按订单重新占用（作废收款时把释放掉的额度占回来） */
export function reoccupyByOrder(db, { orderId, amount, operator = null, remark = null }) {
  const order = db.prepare('SELECT id, doc_no, customer_id, credit_hold, total_amount FROM oc_orders WHERE id=?').get(orderId)
  if (!order) return { occupied: 0, skipped: 'order_not_found' }
  const want = money(amount)
  if (want <= 0.005) return { occupied: 0, skipped: 'zero_amount' }
  // 占回的上限是订单总额，超过说明账已经乱了，不静默写进去
  const ceiling = money(Number(order.total_amount) - Number(order.credit_hold))
  const real = money(Math.min(want, Math.max(0, ceiling)))
  if (real <= 0.005) return { occupied: 0, skipped: 'hold_full' }
  const after = writeOcCredit(db, {
    customerId: order.customer_id,
    orderId: order.id,
    docNo: order.doc_no,
    changeType: 'occupy',
    amount: real,
    operator,
    remark: remark || `核销作废恢复占用（${order.doc_no}）`
  })
  db.prepare('UPDATE oc_orders SET credit_hold = ROUND(credit_hold + ?, 2), updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
    .run(real, order.id)
  return { occupied: real, balance_after: after }
}

export default { ocCreditUsed, writeOcCredit, releaseByOrder, reoccupyByOrder }
