/**
 * ============================================================================
 * 文件标识：server/routes/refund.js ｜ 退款单（批次 J）：把销售退货登记下来的「待退款」兑现成一次真实出账
 * ============================================================================
 * 【职责】退款单（批次 J）：把销售退货登记下来的「待退款」兑现成一次真实出账
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 退款单（批次 J）：把销售退货登记下来的「待退款」兑现成一次真实出账
//
// 独立前缀 `/api/refunds` 而不是塞进 `/api/sales/returns` 或 `/api/ar/receipts`：
//   · 退货的授权归销售（谁能退），退款的授权归财务（谁能放钱）—— 粒度不同；
//   · 收款单（RCP）与退款单（RFD）是**方向相反**的两类资金单据，
//     挂在同一个前缀下会让"这个端点是收还是付"要靠动词去猜。
//
// 本文件只做三件事：取参数、调 `lib/refund.js`、翻译错误。所有判据在 lib 里。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, failFromError } from '../lib/http.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import * as R from '../lib/refund.js'

const r = Router()

/** 业务错误 → 响应：与商城/促销/渠道共用同一份翻译 */
function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
  })
}

const actorOf = (req) => ({
  id: req.user?.uid ?? null,
  name: req.user?.name || req.user?.username || null,
  source: 'web'
})

// ===========================================================================
// 一、字典与可退清单
// ===========================================================================

r.get('/meta', requireAuth, guard((_req, res) =>
  ok(res, {
    statuses: Object.entries(R.REFUND_STATUS_LABEL).map(([value, label]) => ({ value, label })),
    methods: Object.entries(R.REFUND_METHOD_LABEL).map(([value, label]) => ({ value, label })),
    source_types: Object.entries(R.REFUND_SOURCE_LABEL).map(([value, label]) => ({ value, label })),
    note: '退款只能兑现已登记在 sales_returns.refund_due 里的额度，上限 = 待退 − 已确认退款额'
  })
))

// ⚠️ 静态路径必须注册在 `/:id` 之前，否则 /refundables 会被当成 id 吃掉
r.get('/refundables', requireAuth, requirePerm('finance.refund.view'), wrap((req, res) =>
  ok(
    res,
    R.listRefundables(getDb(), {
      customerType: req.query.customer_type || null,
      customerId: req.query.customer_id ? Number(req.query.customer_id) : null,
      keyword: req.query.keyword || null
    })
  )
))

r.get('/audit', requireAuth, requirePerm('finance.refund.view'), wrap((req, res) => ok(res, R.auditRefund(getDb()))))

// ===========================================================================
// 二、退款单
// ===========================================================================

r.get('/', requireAuth, requirePerm('finance.refund.view'), wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  ok(
    res,
    R.listRefunds(getDb(), {
      status: req.query.status || null,
      customerType: req.query.customer_type || null,
      customerId: req.query.customer_id ? Number(req.query.customer_id) : null,
      keyword: req.query.keyword || null,
      page,
      pageSize
    })
  )
}))

r.get('/:id', requireAuth, requirePerm('finance.refund.view'), wrap((req, res) => {
  const row = R.getRefund(getDb(), Number(req.params.id))
  if (!row) return fail(res, '退款单不存在', 404)
  ok(res, row)
}))

r.post('/', requireAuth, requirePerm('finance.refund.edit'), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const out = R.createRefund(db, {
    items: b.items || [],
    refundDate: b.refund_date || null,
    method: b.method || 'bank',
    idempotencyKey: b.idempotency_key || null,
    bankAccount: b.bank_account || null,
    serialNo: b.serial_no || null,
    remark: b.remark || null,
    actor: actorOf(req)
  })
  if (!out.replayed) {
    audit(req, {
      action: 'RFD_CREATE',
      module: 'finance',
      entity: 'refunds',
      entityId: out.id,
      detail: `${out.doc_no} ${out.amount}`
    })
  }
  ok(res, out)
}))

r.post('/:id/confirm', requireAuth, requirePerm('finance.refund.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const out = R.confirmRefund(db, { id, actor: actorOf(req) })
  if (!out.replayed) {
    audit(req, { action: 'RFD_CONFIRM', module: 'finance', entity: 'refunds', entityId: id, detail: `${out.doc_no} 出账 ${out.amount}` })
  }
  ok(res, out)
}))

r.post('/:id/void', requireAuth, requirePerm('finance.refund.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const reason = req.body?.reason || null
  const out = R.voidRefund(db, { id, reason, actor: actorOf(req) })
  if (!out.replayed) {
    audit(req, { action: 'RFD_VOID', module: 'finance', entity: 'refunds', entityId: id, detail: reason || out.doc_no })
  }
  ok(res, out)
}))

export default r
