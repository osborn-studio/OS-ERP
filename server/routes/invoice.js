/**
 * ============================================================================
 * 文件标识：server/routes/invoice.js ｜ 销售发票路由（模块 24）
 * ============================================================================
 * 【职责】销售发票路由（模块 24）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售发票路由（模块 24）
//
// 挂载点：/api/invoices
//
// 端点分工（读的是"队列"，写的是"一张票"）：
//   GET  /meta                    —— 状态字典与开票口径（应收来源 SO/SI）
//   GET  /overview                —— 发票总览（已开票额 / 税额 / 待确认 / 待开票发货单）
//   GET  /pending                 —— 待开票队列（已发货且未开完票的发货单）
//   GET  /pending/:deliveryId     —— 某张发货单还剩多少没开，逐行
//   GET  /list                    —— 发票列表（分页）
//   GET  /audit                   —— 自洽审计（头行一致 / 超开 / 缺应收关联 / 关闭状态漂移）
//   POST /from-delivery           —— 由发货单开票（支持分批：传 items 指定行与数量）
//   POST /manual                  —— 手工开票（无来源单据，补开历史票）
//   POST /refresh-close           —— 重推开票关闭状态（运维兜底）
//   GET  /:id                     —— 发票详情（含行、应收关联、红字票、原票）
//   POST /:id/submit              —— 提交（draft → pending）
//   POST /:id/confirm             —— 确认开票（生成/关联应收 + 回写开票关闭）
//   POST /:id/red-chart           —— 红冲（原票留痕 + 关联应收作废 + 生成红字票）
//   POST /:id/void                —— 作废（仅草稿/待确认）
//
// 路径顺序：/meta、/overview、/pending、/list、/audit、/refresh-close 必须注册在
// /:id 之前，否则会被当成 id 匹配走详情分支（本项目真实踩过）。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { readSetting } from '../lib/settings.js'
import {
  InvoiceError,
  createInvoiceFromDelivery, createManualInvoice,
  submitInvoice, confirmInvoice, redChartInvoice, voidInvoice,
  refreshCloseStatus, pendingLinesOfDelivery, pendingDeliveries,
  listInvoices, getInvoice, invoiceOverview, auditInvoice,
  SI_STATUS_LABEL, INVOICE_STATUS_LABEL
} from '../lib/invoice.js'

const r = Router()
const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.uid || u.id || null, name: u.name || u.username || null }
}

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof InvoiceError) return bizFail(res, e)
      if (e && e.code && e.status) return bizFail(res, e)
      throw e
    }
  })
}
const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))
const W = ['admin', 'finance']

r.get('/meta', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  const db = getDb()
  // 唯一读取点：`readSetting` 对非法值回落默认 'SO'（与原来"不是 SI 就当 SO"等价）
  const arMode = readSetting(db, 'ar_source_of_truth')
  ok(res, {
    si_status: dict(SI_STATUS_LABEL),
    invoice_status: dict(INVOICE_STATUS_LABEL),
    ar_source_of_truth: arMode,
    rules: [
      '开票不产生库存变化 —— 它只产生债权；库存的唯一入口是库存引擎',
      '开票关闭是可推导的：由「已确认蓝字发票的行数量 SUM」与发货/订单数量比对得出，不靠人工点关闭',
      '草稿票不参与开票关闭，可重复生成再删除（没生效的动作不产生后果）',
      '确认开票才生成/关联应收；应收口径由 settings.ar_source_of_truth 决定（SO 关联订单既有应收 / SI 新建）',
      '红冲不删原票：原票置「已红冲」、关联应收置作废、生成一张负数红字票指回原票',
      '已收过款的发票不能直接红冲，需先作废对应收款单',
      arMode === 'SO'
        ? '当前口径 SO：应收在订单确认时已生成，开票时关联该订单的应收，不重复造一笔'
        : '当前口径 SI：应收在开票时才生成（债权成立于开票）'
    ]
  })
}))

r.get('/overview', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  ok(res, invoiceOverview(getDb()))
}))

// 待开票队列：财务每天开工第一眼看的就是这里 —— 哪些货发了、票还没开
r.get('/pending', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  const q = req.query || {}
  const rows = pendingDeliveries(getDb(), {
    orderId: q.order_id ? Number(q.order_id) : null,
    onlyNone: q.only_none === '1',
    includeInvoiced: q.include_invoiced === '1',
    keyword: q.keyword || null
  })
  ok(res, { rows, total: rows.length })
}))

r.get('/pending/:deliveryId', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  const id = Number(req.params.deliveryId)
  const db = getDb()
  const d = db.prepare('SELECT id, doc_no, order_id, delivery_date, status, invoice_status FROM sales_deliveries WHERE id=?').get(id)
  if (!d) return fail(res, '发货单不存在', 404)
  const lines = pendingLinesOfDelivery(db, id)
  ok(res, { delivery: d, lines, remain_total: lines.reduce((s, l) => s + Number(l.remain_qty), 0) })
}))

r.get('/list', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  const q = req.query || {}
  ok(res, listInvoices(getDb(), {
    status: q.status || null,
    subjectType: q.subject_type || null,
    subjectId: q.subject_id ? Number(q.subject_id) : null,
    orderId: q.order_id ? Number(q.order_id) : null,
    invoiceType: q.invoice_type || null,
    from: q.from || null,
    to: q.to || null,
    keyword: q.keyword || null,
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 20
  }))
}))

r.get('/audit', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  ok(res, auditInvoice(getDb()))
}))

// 运维兜底：整库重建/历史数据导入后，一次性把发货单与订单的开票关闭状态推平
r.post('/refresh-close', requireAuth, requirePerm('sales.invoice.approve'), guard((req, res) => {
  const r0 = refreshCloseStatus(getDb(), {})
  audit(req, { action: 'SI_REFRESH_CLOSE', module: 'sales', entity: 'sales_invoices', detail: `重推 ${r0.deliveries} 张发货单 / ${r0.orders} 张订单` })
  ok(res, r0)
}))

r.get('/:id', requireAuth, requirePerm('sales.invoice.view'), wrap((req, res) => {
  const row = getInvoice(getDb(), Number(req.params.id))
  if (!row) return fail(res, '发票不存在', 404)
  ok(res, row)
}))

// ---------- 开票（草稿）----------
// 两种入口：由发货单开（有来源，参与待开票队列计算）与手工开（无来源，补历史票）。
r.post('/from-delivery', requireAuth, requirePerm('sales.invoice.edit'), guard((req, res) => {
  const b = req.body || {}
  const row = createInvoiceFromDelivery(getDb(), {
    deliveryId: Number(b.delivery_id),
    invoiceDate: b.invoice_date || null,
    invoiceNo: b.invoice_no || null,
    taxRate: b.tax_rate == null ? 0.13 : Number(b.tax_rate),
    items: b.items || null,
    remark: b.remark || null,
    actor: actorOf(req)
  })
  audit(req, { action: 'SI_CREATE_FROM_DELIVERY', module: 'sales', entity: 'sales_invoices', entityId: row.id, detail: `${row.doc_no} ← 发货单 ${b.delivery_id}，价税合计 ${row.total_amount}` })
  ok(res, row)
}))

r.post('/manual', requireAuth, requirePerm('sales.invoice.edit'), guard((req, res) => {
  const b = req.body || {}
  const row = createManualInvoice(getDb(), {
    subjectType: b.subject_type,
    subjectId: Number(b.subject_id),
    subjectName: b.subject_name || null,
    invoiceDate: b.invoice_date || null,
    invoiceNo: b.invoice_no || null,
    taxRate: b.tax_rate == null ? 0.13 : Number(b.tax_rate),
    items: b.items || [],
    remark: b.remark || null,
    actor: actorOf(req)
  })
  audit(req, { action: 'SI_CREATE_MANUAL', module: 'sales', entity: 'sales_invoices', entityId: row.id, detail: `${row.doc_no}，价税合计 ${row.total_amount}` })
  ok(res, row)
}))

r.post('/:id/submit', requireAuth, requirePerm('sales.invoice.edit'), guard((req, res) => {
  const id = Number(req.params.id)
  submitInvoice(getDb(), { id, actor: actorOf(req) })
  const row = getInvoice(getDb(), id)
  audit(req, { action: 'SI_SUBMIT', module: 'sales', entity: 'sales_invoices', entityId: id, detail: row?.doc_no })
  ok(res, row)
}))

// 确认开票是唯一有后果的动作：债权成立、参与开票关闭
r.post('/:id/confirm', requireAuth, requirePerm('sales.invoice.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const out = confirmInvoice(db, {
    id,
    actor: actorOf(req),
    creditDays: req.body?.credit_days == null ? null : Number(req.body.credit_days)
  })
  audit(req, {
    action: 'SI_CONFIRM', module: 'sales', entity: 'sales_invoices', entityId: id,
    detail: `${out.invoice.doc_no}，应收 ${out.ar.doc_no}（${out.relation === 'linked' ? '关联既有' : '新建'}，口径 ${out.ar_mode}）`
  })
  ok(res, { ...out, invoice: getInvoice(db, id) })
}))

r.post('/:id/red-chart', requireAuth, requirePerm('sales.invoice.approve'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const reason = req.body?.reason || null
  const out = redChartInvoice(db, { id, reason, actor: actorOf(req) })
  audit(req, { action: 'SI_RED_CHART', module: 'sales', entity: 'sales_invoices', entityId: id, detail: `红冲 ${out.invoice.doc_no} → ${out.red.doc_no}：${reason}` })
  ok(res, { invoice: getInvoice(db, id), red: getInvoice(db, out.red.id) })
}))

r.post('/:id/void', requireAuth, requirePerm('sales.invoice.edit'), guard((req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const row = voidInvoice(db, { id, reason: req.body?.reason || null, actor: actorOf(req) })
  audit(req, { action: 'SI_VOID', module: 'sales', entity: 'sales_invoices', entityId: id, detail: req.body?.reason || row.doc_no })
  ok(res, getInvoice(db, id))
}))

export default r
export { W }
