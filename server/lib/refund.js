/**
 * ============================================================================
 * 文件标识：server/lib/refund.js ｜ 退款单领域服务（批次 J）
 * ============================================================================
 * 【职责】退款单领域服务（批次 J）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 退款单领域服务（批次 J）
//
// ===========================================================================
// 一、这一层只有一个判据：**「这张退货单还能退多少钱」**
// ===========================================================================
// D1 把退货的应收后果做到了"如实登记待退款"（`sales_returns.refund_due`）。
// 但那个数字是**静态的**——它记的是"退货那一刻算出来该退多少"，
// 一旦开始真的退款，就必然需要一个会动的量：**已退多少、还能退多少**。
//
// 这个量只能有一处实现，因为它同时被三处用到：
//   ① 登记退款单时的入参校验（超退要拒绝）；
//   ② 确认退款时的**重验**（建单时合法 ≠ 确认时还合法）；
//   ③ 界面上的"可退余额"列。
// 三处各写一遍，就会出现"界面说还能退 100、提交说超了"这类**没有赢家**的争论。
// 所以本文件把判据做成 `planRefund()` 一个函数，其余全部调它。
//
// ===========================================================================
// 二、四条不让步的口径
// ===========================================================================
// ① **上限 = `refund_due` − 已确认退款额（按退货单累计）**。
//    只算 `confirmed` 的退款单：草稿是"打算退"，不该占用额度 ——
//    否则两张草稿各占满额度，"先建单、后作废"就成了一条永远退不出去的路。
// ② **客户必须一致**。一张退款单不能同时退给两个客户 ——
//    那等于把 A 的待退款付给了 B，而两边的账各自都是对的。
// ③ **金额恒 > 0**（值域是引擎的责任，不是调用方的 —— A17b 的教训）。
// ④ **幂等键非空唯一**。动钱的动作最怕重放：同一次退款重试两次，钱不能出去两遍。
//
// ===========================================================================
// 三、`confirmed` 是终态，但"确认"必须能重放
// ===========================================================================
// 与付款单那个坑（"重验把自己判死"）同源，这里的处理是：
//   · `confirmRefund` 对已确认的单**直接返回同结果**（重放幂等，不重复出账）；
//   · 确认前的重验**排除本单**（本单此时还是 draft，本就不计入已退额，
//     所以不需要像付款单那样把自己加回来 —— 这一点是刻意的：**只算 confirmed**
//     这条口径天然免掉了"看见自己"的问题）。
// 两句话都要有测试守着，否则"改成就地累加"时会静默重复出账。
import { nextDocNoAuto } from './docno.js'
import { applyTransition } from './docflow.js'
import { localDate, localNow } from './dates.js'

export class RefundError extends Error {
  constructor(code, message, httpStatus = 400, detail = null) {
    super(message)
    this.name = 'RefundError'
    this.code = code
    this.httpStatus = httpStatus
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `httpStatus` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = httpStatus
    this.detail = detail
  }
}

const money = (v) => Math.round((Number(v) || 0) * 100) / 100
const EPS = 0.005

export const REFUND_STATUS_LABEL = { draft: '已登记', confirmed: '已退款', voided: '已作废' }
export const REFUND_METHOD_LABEL = {
  bank: '银行转账',
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  original: '原路退回'
}
export const REFUND_METHODS = Object.keys(REFUND_METHOD_LABEL)
export const REFUND_SOURCE_LABEL = { sales_return: '销售退货' }

/**
 * 退货单的往来对象。**一张退货单只能有一个客户** —— 这个函数就是那个唯一出处。
 * `channel='dealer'` 优先看经销商，其次看门店，都没有就是散客（walkin）。
 */
export function customerOfReturn(db, ret) {
  if (ret.channel === 'dealer' && ret.dealer_id) {
    const d = db.prepare('SELECT name FROM dealers WHERE id=?').get(ret.dealer_id)
    return { type: 'dealer', id: Number(ret.dealer_id), name: d?.name || null }
  }
  if (ret.store_id) {
    const s = db.prepare('SELECT name FROM stores WHERE id=?').get(ret.store_id)
    return { type: 'store', id: Number(ret.store_id), name: s?.name || null }
  }
  if (ret.dealer_id) {
    const d = db.prepare('SELECT name FROM dealers WHERE id=?').get(ret.dealer_id)
    return { type: 'dealer', id: Number(ret.dealer_id), name: d?.name || null }
  }
  return { type: 'walkin', id: null, name: null }
}

/** 这张退货单**已确认**退掉了多少钱（`excludeRefundId`：算"除了本单之外"的已退额） */
export function refundedOf(db, returnId, { excludeRefundId = null } = {}) {
  const sql = `
    SELECT COALESCE(SUM(i.amount), 0) AS s
      FROM refund_items i
      JOIN refunds r ON r.id = i.refund_id
     WHERE i.return_id = ? AND r.status = 'confirmed'
       ${excludeRefundId != null ? 'AND r.id <> ?' : ''}`
  const row = excludeRefundId != null ? db.prepare(sql).get(Number(returnId), Number(excludeRefundId)) : db.prepare(sql).get(Number(returnId))
  return money(row?.s)
}

/** 某张退货单的退款全景（界面"可退余额"列与校验都用它） */
export function refundableOf(db, returnId, opts = {}) {
  const r = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(Number(returnId))
  if (!r) return null
  const due = money(r.refund_due)
  const refunded = refundedOf(db, r.id, opts)
  return {
    return_id: r.id,
    doc_no: r.doc_no,
    return_date: r.return_date,
    status: r.status,
    refund_due: due,
    refunded,
    refundable: money(due - refunded),
    customer: customerOfReturn(db, r)
  }
}

/**
 * **退款上限判据的唯一实现。**
 *
 * 输入 `items = [{ return_id, amount }]`，返回 `{ lines, total, customer }`。
 * 任一条件不满足即抛 `RefundError`，**且不写任何数据**（调用方负责事务）。
 */
export function planRefund(db, { items = [], excludeRefundId = null } = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new RefundError('REFUND_NO_ITEMS', '退款单至少要有一条分摊明细（退哪张退货单、退多少）', 400)
  }

  const seen = new Set()
  const lines = []
  const planned = new Map()
  let total = 0
  let customer = null

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {}
    const at = `第 ${i + 1} 条分摊明细`
    const rid = Number(it.return_id)
    if (!rid) throw new RefundError('REFUND_ITEM_NO_RETURN', `${at}缺少退货单（return_id）`, 400)
    if (seen.has(rid)) {
      throw new RefundError('REFUND_ITEM_DUPLICATE', `${at}的退货单 #${rid} 在同一次退款里出现了多次，请合并为一条`, 400)
    }
    seen.add(rid)

    const amt = money(it.amount)
    // 值域不交给调用方：负数分摊会让"超过待退款"这道闸门恒为假
    if (!(amt > 0)) {
      throw new RefundError('REFUND_ITEM_BAD_AMOUNT', `${at}的退款金额必须大于 0（收到 ${it.amount}）`, 400)
    }

    const ret = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(rid)
    if (!ret) throw new RefundError('REFUND_RETURN_NOT_FOUND', `${at}指向的退货单 #${rid} 不存在`, 404)
    if (ret.status !== 'confirmed') {
      throw new RefundError(
        'REFUND_RETURN_STATUS',
        `${at}的退货单 ${ret.doc_no} 状态「${ret.status}」不能退款（退货需已确认）`,
        409,
        { return_id: rid, status: ret.status }
      )
    }

    const cust = customerOfReturn(db, ret)
    if (!customer) customer = cust
    else if (customer.type !== cust.type || Number(customer.id) !== Number(cust.id)) {
      throw new RefundError(
        'REFUND_CUSTOMER_MISMATCH',
        `${at}的退货单 ${ret.doc_no} 属于「${cust.name || cust.type}」，与本次退款对象「${customer.name || customer.type}」不一致 —— 一张退款单不能同时退给两个客户`,
        409,
        { return_id: rid, expect: customer, actual: cust }
      )
    }

    const due = money(ret.refund_due)
    const used = planned.get(rid) || 0
    const already = refundedOf(db, rid, { excludeRefundId })
    const available = money(due - already)
    if (used + amt - available > EPS) {
      throw new RefundError(
        'REFUND_OVER_DUE',
        `${at}超过退货单 ${ret.doc_no} 的待退款余额（待退 ${due}，已退 ${already}，本单已分摊 ${used}，本条 ${amt}）`,
        409,
        { return_id: rid, refund_due: due, refunded: already, planned: used, amount: amt }
      )
    }
    planned.set(rid, money(used + amt))
    lines.push({ return_id: rid, return_doc_no: ret.doc_no, amount: amt })
    total = money(total + amt)
  }

  return { lines, total, customer }
}

/** 可退清单：待退款余额 > 0 的退货单（界面"挑退货单"下拉的数据源） */
export function listRefundables(db, { customerType = null, customerId = null, keyword = null, limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT r.* FROM sales_returns r
        WHERE r.status='confirmed' AND r.refund_due > 0
        ORDER BY r.return_date, r.id`
    )
    .all()
  const out = []
  for (const r of rows) {
    const info = refundableOf(db, r.id)
    if (!(info.refundable > EPS)) continue
    if (customerType && info.customer.type !== customerType) continue
    if (customerId != null && Number(info.customer.id) !== Number(customerId)) continue
    if (keyword && !`${info.doc_no} ${info.customer.name || ''}`.toLowerCase().includes(String(keyword).toLowerCase())) continue
    out.push(info)
    if (out.length >= limit) break
  }
  return out
}

function brief(row) {
  return {
    id: row.id,
    doc_no: row.doc_no,
    source_type: row.source_type,
    source_id: row.source_id,
    customer_type: row.customer_type,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    refund_date: row.refund_date,
    method: row.method,
    amount: money(row.amount),
    status: row.status,
    status_label: REFUND_STATUS_LABEL[row.status] || row.status,
    remark: row.remark,
    replayed: false
  }
}

/**
 * 登记退款单（草稿）。**钱不动** —— 出账在 `confirmRefund`。
 *
 * 幂等：传了 `idempotencyKey` 时，同键重复提交返回首次那张单，不重复插明细。
 * 并发由 `idx_refunds_idem` 兜住（先查后插之间仍可能撞车，撞了就回查）。
 */
export function createRefund(
  db,
  {
    items = [],
    refundDate = null,
    method = 'bank',
    idempotencyKey = null,
    bankAccount = null,
    serialNo = null,
    remark = null,
    actor = null
  } = {}
) {
  const key = idempotencyKey != null && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null
  if (key) {
    const hit = db.prepare('SELECT * FROM refunds WHERE idempotency_key=?').get(key)
    if (hit) return { ...brief(hit), replayed: true }
  }

  const date = String(refundDate || '').trim() || localDate()
  if (!REFUND_METHODS.includes(method)) {
    throw new RefundError('REFUND_BAD_METHOD', `退款方式「${method}」不支持（可选 ${REFUND_METHODS.join(' / ')}）`, 400, {
      known: REFUND_METHODS
    })
  }

  const tx = db.transaction(() => {
    const plan = planRefund(db, { items })
    const docNo = nextDocNoAuto(db, { docType: 'RFD', table: 'refunds', bizDate: date })
    const now = localNow()
    const info = db
      .prepare(
        `INSERT INTO refunds
         (doc_no,source_type,source_id,customer_type,customer_id,customer_name,refund_date,method,amount,status,
          idempotency_key,bank_account,serial_no,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`
      )
      .run(
        docNo,
        'sales_return',
        plan.lines[0].return_id,
        plan.customer.type,
        plan.customer.id,
        plan.customer.name,
        date,
        method,
        plan.total,
        key,
        bankAccount,
        serialNo,
        remark,
        actor?.id || null,
        actor?.name || null,
        now,
        now
      )
    const rid = Number(info.lastInsertRowid)
    // 逐条 INSERT，同一次请求里同一张退货单出现两次由 planRefund 先拦（唯一键只是兜底）
    const insItem = db.prepare('INSERT INTO refund_items (refund_id,return_id,return_doc_no,amount) VALUES (?,?,?,?)')
    for (const l of plan.lines) insItem.run(rid, l.return_id, l.return_doc_no, l.amount)

    return {
      id: rid,
      doc_no: docNo,
      source_type: 'sales_return',
      source_id: plan.lines[0].return_id,
      customer_type: plan.customer.type,
      customer_id: plan.customer.id,
      customer_name: plan.customer.name,
      refund_date: date,
      method,
      amount: plan.total,
      status: 'draft',
      status_label: REFUND_STATUS_LABEL.draft,
      items: plan.lines.length,
      replayed: false
    }
  })

  try {
    return tx()
  } catch (e) {
    // 并发撞上唯一键：回查那张单并如实返回（"重放返回同一张"是承诺，不是尽力而为）
    if (key && /UNIQUE|constraint/i.test(String(e?.message || ''))) {
      const hit = db.prepare('SELECT * FROM refunds WHERE idempotency_key=?').get(key)
      if (hit) return { ...brief(hit), replayed: true }
    }
    throw e
  }
}

/**
 * 确认退款 —— **这一步才真的出账**（`draft` 是"打算退"，不是"退过了"）。
 *
 * 确认前**重验一次**：建单时合法不等于确认时还合法（另一张退款单可能已经把
 * 同一张退货单的待退款退掉了）。重验走的是同一个 `planRefund`，
 * 且**排除本单**（本单此刻仍是 draft、本就不计入已退额）。
 */
export function confirmRefund(db, { id, actor = null } = {}) {
  const r = db.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id))
  if (!r) throw new RefundError('REFUND_NOT_FOUND', '退款单不存在', 404)
  if (r.status === 'confirmed') return { ...brief(r), replayed: true }
  if (r.status !== 'draft') throw new RefundError('REFUND_NOT_DRAFT', `当前状态「${r.status}」不能确认退款`, 409)

  const items = db.prepare('SELECT return_id, amount FROM refund_items WHERE refund_id=? ORDER BY id').all(r.id)
  planRefund(db, { items, excludeRefundId: r.id })

  const tx = db.transaction(() => {
    applyTransition({
      db,
      docType: 'RFD',
      id: r.id,
      action: 'confirm',
      actor,
      source: 'api',
      remark: '确认退款，资金出账'
    })
    db.prepare(
      `UPDATE refunds SET status='confirmed', confirmed_by=?, confirmed_by_name=?, confirmed_at=?, updated_at=? WHERE id=?`
    ).run(actor?.id || null, actor?.name || null, localNow(), localNow(), r.id)
    return brief(db.prepare('SELECT * FROM refunds WHERE id=?').get(r.id))
  })
  return tx()
}

/** 作废。已确认的作废**必须写理由** —— 它会让一笔已经出去的钱从账上消失。 */
export function voidRefund(db, { id, reason = null, actor = null } = {}) {
  const r = db.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id))
  if (!r) throw new RefundError('REFUND_NOT_FOUND', '退款单不存在', 404)
  if (r.status === 'voided') return { ...brief(r), replayed: true }
  const rz = String(reason || '').trim()
  if (!rz) throw new RefundError('REFUND_VOID_REASON_REQUIRED', '作废退款单必须写理由', 400)

  const tx = db.transaction(() => {
    applyTransition({
      db,
      docType: 'RFD',
      id: r.id,
      action: 'void',
      actor,
      source: 'api',
      remark: rz
    })
    db.prepare("UPDATE refunds SET status='voided', void_reason=?, updated_at=? WHERE id=?").run(rz, localNow(), r.id)
    return brief(db.prepare('SELECT * FROM refunds WHERE id=?').get(r.id))
  })
  return tx()
}

export function getRefund(db, id) {
  const r = db.prepare('SELECT * FROM refunds WHERE id=?').get(Number(id))
  if (!r) return null
  const items = db
    .prepare('SELECT * FROM refund_items WHERE refund_id=? ORDER BY id')
    .all(r.id)
    .map((it) => {
      const info = refundableOf(db, it.return_id)
      return { ...it, amount: money(it.amount), refundable: info?.refundable ?? null, refund_due: info?.refund_due ?? null }
    })
  return {
    ...r,
    amount: money(r.amount),
    status_label: REFUND_STATUS_LABEL[r.status] || r.status,
    method_label: REFUND_METHOD_LABEL[r.method] || r.method,
    items
  }
}

export function listRefunds(
  db,
  { status = null, customerType = null, customerId = null, keyword = null, page = 1, pageSize = 20 } = {}
) {
  const where = []
  const args = []
  if (status) {
    where.push('r.status = ?')
    args.push(status)
  }
  if (customerType) {
    where.push('r.customer_type = ?')
    args.push(customerType)
  }
  if (customerId != null) {
    where.push('r.customer_id = ?')
    args.push(Number(customerId))
  }
  if (keyword) {
    where.push('(r.doc_no LIKE ? OR r.customer_name LIKE ? OR r.serial_no LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM refunds r ${w}`).get(...args).c
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 200)
  const p = Math.max(Number(page) || 1, 1)
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM refund_items i WHERE i.refund_id=r.id) AS item_count
         FROM refunds r ${w}
        ORDER BY r.refund_date DESC, r.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, size, (p - 1) * size)
  return {
    rows: rows.map((r) => ({
      ...r,
      amount: money(r.amount),
      status_label: REFUND_STATUS_LABEL[r.status] || r.status,
      method_label: REFUND_METHOD_LABEL[r.method] || r.method
    })),
    total,
    page: p,
    pageSize: size
  }
}

/**
 * 退款域自证。**由它自己回答"这个域是不是自洽的"**，而不是靠调用方逐条检查。
 * 五条：头行一致 / 已退款的要素齐全 / 作废有理由 / 不超待退款 / 无孤儿明细。
 */
export function auditRefund(db, { refIds = null } = {}) {
  const problems = []
  const scoped = Array.isArray(refIds) && refIds.length ? refIds.map(Number) : null
  const inScope = scoped ? `(${scoped.join(',')})` : null
  // 范围条件统一拼装：**只在有范围时加 AND**，避免空串拼出 `WHERE AND`
  const refWhere = (extra) => `${extra ? 'WHERE ' + extra + (inScope ? ` AND r.id IN ${inScope}` : '') : inScope ? `WHERE r.id IN ${inScope}` : ''}`

  // ① 头行一致
  const headRows = db
    .prepare(
      `SELECT r.id, r.doc_no, r.amount,
              COALESCE((SELECT SUM(i.amount) FROM refund_items i WHERE i.refund_id=r.id),0) AS items
         FROM refunds r ${refWhere(null)}`
    )
    .all()
  for (const m of headRows) if (Math.abs(Number(m.amount) - Number(m.items)) > 0.005) {
    problems.push(`退款单 ${m.doc_no} 头金额 ${m.amount} ≠ 明细合计 ${m.items}`)
  }

  // ② 已退款的必须有确认人/确认时间
  const noSigner = db
    .prepare(`SELECT id, doc_no FROM refunds r ${refWhere("r.status='confirmed' AND (r.confirmed_by_name IS NULL OR r.confirmed_at IS NULL)")}`)
    .all()
  for (const s of noSigner) problems.push(`退款单 ${s.doc_no} 已退款但没有确认人/确认时间`)

  // ③ 作废必须有理由
  const voidNoReason = db
    .prepare(`SELECT id, doc_no FROM refunds r ${refWhere("r.status='voided' AND (r.void_reason IS NULL OR TRIM(r.void_reason)='')")}`)
    .all()
  for (const v of voidNoReason) problems.push(`退款单 ${v.doc_no} 已作废但没有理由`)

  // ④ 无孤儿明细
  const orphan = db
    .prepare(
      `SELECT i.id, i.return_id FROM refund_items i
        WHERE NOT EXISTS (SELECT 1 FROM sales_returns s WHERE s.id=i.return_id)
          ${inScope ? `AND i.refund_id IN ${inScope}` : ''}`
    )
    .all()
  for (const o of orphan) problems.push(`退款明细 #${o.id} 指向不存在的退货单 #${o.return_id}`)

  // ⑤ 不超待退款（按退货单聚合**已确认**退款额）
  const over = db
    .prepare(
      `SELECT ret.doc_no, ret.refund_due, SUM(i.amount) AS refunded
         FROM refund_items i
         JOIN refunds rf ON rf.id = i.refund_id AND rf.status='confirmed'
         JOIN sales_returns ret ON ret.id = i.return_id
        ${inScope ? `WHERE i.refund_id IN ${inScope}` : ''}
        GROUP BY i.return_id
       HAVING SUM(i.amount) - ret.refund_due > 0.005`
    )
    .all()
  for (const o of over) problems.push(`退货单 ${o.doc_no} 已退 ${o.refunded} 超过待退款 ${o.refund_due}`)

  return {
    balanced: problems.length === 0,
    problems,
    refunds: db.prepare(`SELECT COUNT(*) c FROM refunds r ${refWhere(null)}`).get().c,
    confirmed: db.prepare(`SELECT COUNT(*) c FROM refunds r ${refWhere("r.status='confirmed'")}`).get().c
  }
}

export default {
  RefundError,
  REFUND_STATUS_LABEL,
  REFUND_METHOD_LABEL,
  REFUND_METHODS,
  REFUND_SOURCE_LABEL,
  customerOfReturn,
  refundedOf,
  refundableOf,
  planRefund,
  listRefundables,
  createRefund,
  confirmRefund,
  voidRefund,
  getRefund,
  listRefunds,
  auditRefund
}
