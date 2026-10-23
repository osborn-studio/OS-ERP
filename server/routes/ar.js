/**
 * ============================================================================
 * 文件标识：server/routes/ar.js ｜ 应收与收款核销路由（模块 21 · 第一阶段）
 * ============================================================================
 * 【职责】应收与收款核销路由（模块 21 · 第一阶段）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 应收与收款核销路由（模块 21 · 第一阶段）
//
// 挂载点：/api/ar
//
// 端点分工：
//   GET  /meta         —— 状态 / 收款方式字典与账龄分桶口径
//   GET  /overview     —— 应收总览（应收/已收/未结/逾期/账龄）
//   GET  /documents    —— 应收单列表
//   GET  /documents/:id —— 应收单详情（含核销明细）
//   POST /documents    —— 手工建应收单（补账用；正常由订单自动生成）
//   POST /documents/generate —— 按来源单据批量生成应收（幂等）
//   GET  /receipts     —— 收款单列表
//   GET  /receipts/:id —— 收款单详情（含核销明细）
//   POST /receipts     —— 登记收款单（草稿 + 计划核销）
//   POST /receipts/:id/confirm —— 确认收款（核销生效 + 释放授信）
//   POST /receipts/:id/void    —— 作废收款（核销失效并重算）
//   GET  /aging        —— 账龄（总览 / 按客户）
//   GET  /statement    —— 客户对账单
//   GET  /audit        —— 自洽审计（明细 SUM 与单据金额是否一致）
//
// 路径顺序：/meta、/overview、/aging、/statement、/audit、/receipts 必须注册在
// /documents/:id 之前，否则会被当成 id 匹配走详情分支。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
// 证据闸 + 二人复核（ADR-0018）：确认收款不再直接落地，先过 `confirmFunds`；复核走 `reviewFunds`。
// 判据（证据必填 / 阈值 / 自审拒绝）只在 lib/funds-review.js 一处。
import { confirmFunds, reviewFunds, assertNotPending, reviewOf, FUNDS_REVIEW_PERM, FUNDS_REVIEW_LABEL } from '../lib/funds-review.js'
import {
  ArError, ensureAr, recalcAr, recalcArBySubject, listAr, getAr,
  createReceipt, confirmReceipt, voidReceipt, getReceipt, listReceipts,
  aging, agingBySubject, statement, arOverview, auditAr,
  // 第二阶段：逐笔账龄 / 预收 / 订货中心并入
  agingDetail, agingDetailBySubject, prepayList, prepayDetail, applyPrepay,
  pendingOcAr, syncOcAr,
  AR_STATUS_LABEL, RC_STATUS_LABEL, PAY_METHOD_LABEL, AGING_BUCKET_LABEL
} from '../lib/ar.js'
// 业务日只能来自 dates.js 的 localDate()（**不是** UTC 的 toISOString）——
// 否则本地 00:00–08:00 建出来的应收/收款单业务日会落到"昨天"，
// 账期到期日跟着提前一天。详见 server/lib/dates.js 的模块注释。
import { localDate } from '../lib/dates.js'

const r = Router()
const actorOf = (req) => {
  const u = currentUser(req)
  // `ip` 只给严格审计用（funds-review 的审计行），流转留痕不用它
  return { id: u.uid || u.id || null, name: u.name || u.username || null, ip: req.ip || null }
}

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof ArError) return bizFail(res, e)
      if (e && e.code && e.status) return bizFail(res, e)
      throw e
    }
  })
}
const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))
const V = ['admin', 'boss', 'finance']
const W = ['admin', 'finance']

r.get('/meta', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  ok(res, {
    ar_status: dict(AR_STATUS_LABEL),
    rc_status: dict(RC_STATUS_LABEL),
    funds_review_status: dict(FUNDS_REVIEW_LABEL),
    funds_review_perm: FUNDS_REVIEW_PERM,
    pay_methods: dict(PAY_METHOD_LABEL),
    aging_buckets: Object.entries(AGING_BUCKET_LABEL).map(([value, label]) => ({ value, label })),
    rules: [
      '已收金额永远由核销明细 SUM 算出，不做累加',
      '核销生效点 = 收款单确认；草稿上的核销只是计划',
      '到期日 = 业务日期 + 账期天数；账期 0 视为现结',
      '作废收款不会自动回收已释放的授信，需显式补一笔占用',
      '订货单在「确认收货」时并入应收（收款权成立），开关见 settings.ar_oc_enabled',
      '预收余额 = 已确认收款单金额 − 其核销明细之和，可随时转入应收'
    ]
  })
}))

r.get('/overview', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const db = getDb()
  ok(res, { ...arOverview(db), top_overdue: agingBySubject(db).slice(0, 10) })
}))

r.get('/aging', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const db = getDb()
  const bySubject = req.query.by_subject === '1'
  ok(res, bySubject ? { rows: agingBySubject(db) } : { ...aging(db), rows: agingBySubject(db) })
}))

// ---------- 逐笔账龄（第二阶段）----------
// 与 /aging 的区别：/aging 给的是「桶汇总」（未到期多少、逾期 30 天多少），
// /aging/detail 给的是「一行一张单」—— 催收要看的是具体哪几张单、各逾期几天。
r.get('/aging/detail', requireAuth, requirePerm('finance.ar.aging'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, agingDetail(getDb(), {
    subjectType: q.subject_type || null,
    subjectId: q.subject_id ? Number(q.subject_id) : null,
    bucket: q.bucket || 'all',
    sourceType: q.source_type || null,
    keyword: q.keyword || null,
    includeSettled: q.include_settled === '1'
  }))
}))

r.get('/aging/subjects', requireAuth, requirePerm('finance.ar.aging'), wrap((req, res) => {
  ok(res, { rows: agingDetailBySubject(getDb()) })
}))

// ---------- 预收（第二阶段）----------
// 预收不是「多收的钱」这么简单：它是客户存在我方的余额，抵哪张账由业务决定，
// 所以读接口给全（谁有预收、明细到收款单），写接口只给一个明确动作：转应收。
r.get('/prepay', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, prepayList(getDb(), {
    subjectType: q.subject_type || null,
    subjectId: q.subject_id ? Number(q.subject_id) : null,
    keyword: q.keyword || null
  }))
}))

r.get('/prepay/detail', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const q = req.query || {}
  if (!q.subject_type || !q.subject_id) return fail(res, '缺少 subject_type / subject_id')
  ok(res, prepayDetail(getDb(), { subjectType: q.subject_type, subjectId: Number(q.subject_id) }))
}))

r.post('/prepay/apply', requireAuth, requirePerm('finance.ar.prepay'), guard((req, res) => {
  const b = req.body || {}
  const r = applyPrepay(getDb(), {
    receiptId: Number(b.receipt_id),
    arId: b.ar_id ? Number(b.ar_id) : null,
    amount: b.amount == null ? null : Number(b.amount),
    auto: b.auto === true || b.auto === '1',
    actor: actorOf(req)
  })
  audit(req, {
    action: 'AR_PREPAY_APPLY', module: 'finance', entity: 'receipts', entityId: r.receipt.id,
    detail: `${r.receipt.doc_no} 抵扣 ${r.applied}，剩余预收 ${r.remaining}`
  })
  ok(res, r)
}))

// ---------- 订货中心并入（第二阶段）----------
// 十二 A 的订货单在确认收货时会自动生成应收；这里给两条兜底：
// 一是看「还有哪些没并进来」（历史数据、或并入开关关过一段时间），
// 二是一键补齐（幂等，可重复跑）。
r.get('/oc/pending', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, pendingOcAr(getDb(), {
    customerId: q.customer_id ? Number(q.customer_id) : null,
    keyword: q.keyword || null
  }))
}))

r.post('/oc/sync', requireAuth, requirePerm('finance.ar.prepay'), guard((req, res) => {
  const b = req.body || {}
  const r = syncOcAr(getDb(), {
    actor: actorOf(req),
    limit: Number(b.limit) || 500,
    customerId: b.customer_id ? Number(b.customer_id) : null
  })
  audit(req, { action: 'AR_OC_SYNC', module: 'finance', entity: 'ar_documents', detail: `并入 ${r.count} 张订货单，合计 ${r.total_amount}` })
  ok(res, r)
}))

r.get('/statement', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const db = getDb()
  const q = req.query || {}
  if (!q.subject_type || !q.subject_id) return fail(res, '缺少 subject_type / subject_id')
  ok(res, statement(db, { subjectType: q.subject_type, subjectId: Number(q.subject_id), from: q.from || null, to: q.to || null }))
}))

r.get('/audit', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  ok(res, auditAr(getDb()))
}))

// ---------- 应收单 ----------
r.get('/documents', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, listAr(getDb(), {
    subjectType: q.subject_type, subjectId: q.subject_id ? Number(q.subject_id) : null,
    status: q.status, openOnly: q.open_only === '1', overdueOnly: q.overdue_only === '1',
    keyword: q.keyword, page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20
  }))
}))

r.get('/documents/:id', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const row = getAr(getDb(), Number(req.params.id))
  if (!row) return fail(res, '应收单不存在', 404)
  ok(res, row)
}))

r.post('/documents', requireAuth, requirePerm('finance.receipt.edit'), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const row = ensureAr(db, {
    subjectType: b.subject_type,
    subjectId: Number(b.subject_id),
    subjectName: b.subject_name || null,
    sourceType: b.source_type || 'MANUAL',
    sourceId: b.source_id ?? null,
    sourceDocNo: b.source_doc_no || null,
    bizDate: b.biz_date || localDate(),
    amount: b.amount,
    creditDays: Number(b.credit_days) || 0,
    remark: b.remark || (b.source_type === 'MANUAL' ? '手工补录应收' : null),
    actor: actorOf(req)
  })
  audit(req, { action: 'AR_CREATE', module: 'finance', entity: 'ar_documents', entityId: row.id, detail: row.doc_no })
  ok(res, row)
}))

r.post('/documents/generate', requireAuth, requirePerm('finance.receipt.edit'), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const sourceType = b.source_type || 'SO'
  const created = []
  const skipped = []
  const list = Array.isArray(b.items) && b.items.length
    ? b.items
    : db
        .prepare(
          `SELECT id, doc_no, dealer_id, store_id, order_date, receivable_amount, paid_amount
           FROM sales_orders
           WHERE status IN ('confirmed','shipped','completed') AND receivable_amount > 0 AND ar_id IS NULL
             AND IFNULL(paid_amount,0) < receivable_amount - 0.005
           ORDER BY id DESC LIMIT ?`
        )
        .all(Number(b.limit) || 50)
  for (const item of list) {
    const order = item.dealer_id !== undefined
      ? item
      : db.prepare('SELECT * FROM sales_orders WHERE id=?').get(item.id)
    if (!order) continue
    // S-5 的另一半：**已收满的单不得被补成欠款**。
    // `paid_amount` 在 :225 就被 SELECT 出来了却从未参与判据（"取了但不用"）——
    // 后果是实打实的钱：三库有 511 张 `paid_amount == receivable_amount` 的门店单
    // （cosmetic 110 / food 317 / apparel 84），一跑就把约 51 万「已收款」变成「欠款」，
    // 账龄与对账同时虚增。判据必须落在这里而不只是 WHERE ——
    // **显式传 `items` 的调用会绕过 WHERE**（实测那 4 张就是被显式指定补出来的）。
    if (Number(order.receivable_amount || 0) - Number(order.paid_amount || 0) < 0.005) {
      skipped.push({
        id: order.id,
        doc_no: order.doc_no,
        reason: 'already_paid',
        receivable_amount: Number(order.receivable_amount || 0),
        paid_amount: Number(order.paid_amount || 0)
      })
      continue
    }
    const acc = db
      .prepare('SELECT credit_days FROM credit_accounts WHERE subject_type=? AND subject_id=?')
      .get('dealer', order.dealer_id)
    const subjectType = order.dealer_id ? 'dealer' : 'store'
    const subjectId = order.dealer_id || order.store_id
    // S-5：`dealers` / `stores` 两表都只有 `name` 列（PRAGMA 实测），
    // 原来查 `dealer_name` / `store_name` ⇒ 必然 `no such column` ⇒ 整个
    // `/api/ar/documents/generate`（**唯一"批量补应收"入口**）恒定 500。
    const nameRow = subjectType === 'dealer'
      ? db.prepare('SELECT name AS n FROM dealers WHERE id=?').get(subjectId)
      : db.prepare('SELECT name AS n FROM stores WHERE id=?').get(subjectId)
    const exist = db.prepare('SELECT id FROM ar_documents WHERE source_type=? AND source_id=?').get('SO', order.id)
    if (exist) {
      skipped.push({ id: order.id, doc_no: order.doc_no, ar_id: exist.id })
      continue
    }
    const ar = ensureAr(db, {
      subjectType,
      subjectId,
      subjectName: nameRow?.n || null,
      sourceType: 'SO',
      sourceId: order.id,
      sourceDocNo: order.doc_no,
      bizDate: order.order_date || localDate(),
      amount: order.receivable_amount || 0,
      creditDays: acc?.credit_days || 0,
      remark: '由销售订单生成',
      actor: actorOf(req)
    })
    db.prepare('UPDATE sales_orders SET ar_id=?, ar_doc_no=? WHERE id=?').run(ar.id, ar.doc_no, order.id)
    created.push({ id: ar.id, doc_no: ar.doc_no, source_doc_no: order.doc_no, amount: ar.amount })
  }
  ok(res, { created, skipped, source_type: sourceType })
}))

// ---------- 收款单 ----------
r.get('/receipts', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, listReceipts(getDb(), {
    subjectType: q.subject_type, subjectId: q.subject_id ? Number(q.subject_id) : null,
    status: q.status, keyword: q.keyword, page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20
  }))
}))

r.get('/receipts/:id', requireAuth, requirePerm('finance.receipt.view'), wrap((req, res) => {
  const row = getReceipt(getDb(), Number(req.params.id))
  if (!row) return fail(res, '收款单不存在', 404)
  ok(res, { ...row, review: reviewOf(row) })
}))

r.post('/receipts', requireAuth, requirePerm('finance.receipt.edit'), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const out = createReceipt(db, {
    subjectType: b.subject_type,
    subjectId: Number(b.subject_id),
    subjectName: b.subject_name || null,
    receiptDate: b.receipt_date || localDate(),
    method: b.method || 'transfer',
    amount: b.amount,
    bankAccount: b.bank_account || null,
    serialNo: b.serial_no || null,
    remark: b.remark || null,
    allocations: b.allocations || null,
    actor: actorOf(req)
  })
  audit(req, { action: 'RC_CREATE', module: 'finance', entity: 'receipts', entityId: out.id, detail: out.doc_no })
  ok(res, out)
}))

// 确认收款（ADR-0018）：先过证据闸；达到复核阈值只挂「待复核」（内核状态仍是 draft，应收 / 授信不动），
// 否则在同一事务里执行 `confirmReceipt` + 严格审计。响应统一带 `review` 块。
r.post('/receipts/:id/confirm', requireAuth, requirePerm('finance.receipt.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const actor = actorOf(req)
  const b = req.body || {}
  const out = confirmFunds(db, {
    kind: 'receipt', id, actor,
    evidence: { ref: b.evidence_ref, note: b.evidence_note },
    apply: () => confirmReceipt(db, { id, actor, releaseCredit: b.release_credit !== false })
  })
  if (out.applied) audit(req, { action: 'RC_CONFIRM', module: 'finance', entity: 'receipts', entityId: id, detail: out.row.doc_no })
  ok(res, { ...(out.result || out.row), review: out.review, allocations: getReceipt(db, id)?.allocations || [] })
}))

// 复核（第二人）：approve = 在同一事务里执行原确认逻辑；reject = 退回草稿并记原因。自审 409 FUNDS_SELF_REVIEW。
r.post('/receipts/:id/review', requireAuth, requirePerm(FUNDS_REVIEW_PERM), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const actor = actorOf(req)
  const b = req.body || {}
  const out = reviewFunds(db, {
    kind: 'receipt', id, actor, decision: b.decision, comment: b.comment ?? null,
    apply: () => confirmReceipt(db, { id, actor, releaseCredit: b.release_credit !== false })
  })
  if (out.applied) audit(req, { action: 'RC_CONFIRM', module: 'finance', entity: 'receipts', entityId: id, detail: out.row.doc_no })
  ok(res, { ...(out.result || out.row), review: out.review, allocations: getReceipt(db, id)?.allocations || [] })
}))

r.post('/receipts/:id/void', requireAuth, requirePerm('finance.receipt.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  // 待复核期间不能作废：先让复核人驳回，再作废（否则"挂起的确认"会凭空消失）
  assertNotPending(db, 'receipt', id)
  const row = voidReceipt(db, { id, actor: actorOf(req), reason: req.body?.reason || null })
  audit(req, { action: 'RC_VOID', module: 'finance', entity: 'receipts', entityId: id, detail: req.body?.reason || row.doc_no })
  ok(res, row)
}))

r.post('/recalc', requireAuth, requirePerm(...W), wrap((req, res) => {
  const db = getDb()
  const n = recalcArBySubject(db, { subjectType: req.body?.subject_type, subjectId: req.body?.subject_id })
  ok(res, { recalculated: n })
}))

export default r
