/**
 * ============================================================================
 * 文件标识：server/routes/purchase-chain.js ｜ 采购域后段路由（模块 07）
 * ============================================================================
 * 【职责】采购域后段路由（模块 07）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 采购域后段路由（模块 07）
//
// 与既有 server/routes/purchase.js 的分工：
//   purchase.js         —— 采购订单 / 收货单 / 退货单（原有三张单，保持不动）
//   本文件               —— 请购单 / 供应商供货目录与取价 / 采购发票 / 采购结算 / 付款单
// 两者都挂 /api/purchase：Express 先匹配 purchase.js，未命中的路径落到这里。
// 之所以不合并进 purchase.js，是为了让「已跑通的订单收货链路」零风险 —— 模块 12A 用过同样的做法。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { requireAuth, requirePerm, requireInternal, attachOrgScope, currentUser, permContext } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  PurchaseError, DocFlowError,
  createRequisition, getRequisition, listRequisitions, transitionRequisition,
  convertRequisitionToOrder,
  resolvePurchasePrice, resolvePurchasePrices, checkSupplyCatalog, checkOverReceive,
  upsertSupplierProduct, touchSupplierLastPrice,
  createInvoice, getInvoice, transitionInvoice, matchInvoiceToReceipts,
  buildSettlement, getSettlement, transitionSettlement,
  createPayment, getPayment, transitionPayment, planAllocation,
  refreshOrderStats, refreshCloseFlags,
  purchaseOverview, purchaseTodos, purchaseActions, PO_READ_PERMS
} from '../lib/purchase.js'
import { explainLifecycle, assertEdgePermitted, getDocType } from '../lib/docflow.js'
// 付款执行的证据闸 + 二人复核（ADR-0018）。`pay` 是采购域唯一真正动钱的动作，与收款确认走同一份判据。
import { FundsError, confirmFunds, reviewFunds, assertNotPending, reviewOf, FUNDS_REVIEW_PERM } from '../lib/funds-review.js'

const r = Router()

/**
 * 路由层的异常统一翻译：业务错 → 约定的 `detail.code`；其余交给全局中间件。
 *
 * **`DocFlowError` 也要一起翻**（本批补）：分支动作路由的权限闸门（`assertActionPermitted`）
 * 抛的是 `DocFlowError`，而原来这里只认 `PurchaseError` —— 于是同一个业务码
 * 在"数据校验不过"时落在 `detail.code`、在"权限不足"时落在顶层 `error`，
 * 前端和测试要按两种形状去读。同一个模块里同一件事两种形状，正是"以后只会改一处"的形状。
 * 与 `routes/purchase.js` 新增的 `guard()` 保持同一份实现。
 */
function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof PurchaseError || e instanceof DocFlowError || e instanceof FundsError) {
        // `failFromError` 返回 false = "这不是一个能翻译的业务错误"（它只认 `code && status`）。
        // 这里必须显式 `throw e` 交给全局中间件：**漏了这一步就一个响应都不发、请求挂住** ——
        // 挂住的报障表现是"接口转圈"，跟真实原因（这个错缺 code）完全对不上号。
        // 与 routes/purchase.js 的 guard() 以及另外 13 处保持同一份形状。
        if (failFromError(res, e)) return
        throw e
      }
      throw e
    }
  })
}

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.id || u.uid || null, name: u.name || u.username || null, ip: req.ip || null }
}

/**
 * 分支动作路由（`/:id/:action`）的功能权限门。
 *
 * 为什么门要在这里、不能挂在路由中间件上：`requirePerm('a.b.c')` 是**静态**的，
 * 而这里的权限点随 `:action` 变化 —— 写成 `requirePerm('purchase.settle.audit','purchase.settle.settle',…)`
 * 就成了"有其中任一个就能做全部动作"，等于把好几个权限点揉成一个。
 * 所以先拿到单据当前状态 → 定位这条边 → 按 `edge.perm_code` 判定。
 *
 * 判据**不在本文件里**：用的是 lib/docflow.js 的 assertEdgePermitted，
 * 与通用流转入口 `POST /api/docflow/transition` 是同一份 —— 两条路不会各判一套。
 */
function assertActionPermitted(req, db, docType, id) {
  const type = getDocType(db, docType)
  const row = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(id)
  if (!row) throw new PurchaseError('单据不存在', { code: 'DOC_NOT_FOUND', httpStatus: 404 })
  return assertEdgePermitted({
    db,
    docType: type.code,
    fromState: row[type.status_field || 'status'],
    action: String(req.params.action),
    permCtx: permContext(db, req.user),
    entry: `${req.baseUrl}${req.path}`
  })
}

// ===========================================================================
// 一、看板与业务流
// ===========================================================================

r.get(
  '/chain/overview',
  requireAuth,
  guard((req, res) => ok(res, purchaseOverview(getDb())))
)

/**
 * 采购待办（ADR-0015）：与采购订单读接口**同一道门**（内部主体 + `PO_READ_PERMS` 任一），
 * 再按调用者的组织范围与动作权限收窄 —— 原来只有 `requireAuth`，经销商 / 门店账号一个 GET
 * 就能把全库待审单号与金额拉走。范围为空的受限账号拿到的是**空列表**（200），
 * 不是 403：工作台页面对"没有待办"与"没资格进门"要分得开。
 */
r.get(
  '/chain/todos',
  requireAuth,
  requireInternal('采购待办'),
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    return ok(res, { list: purchaseTodos(db, { orgScope: req.orgScope, permCtx: permContext(db, req.user) }) })
  })
)

r.get(
  '/chain/flow',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const flow = db.prepare("SELECT * FROM biz_flows WHERE code='FLOW_PURCHASE'").get()
    const steps = db
      .prepare('SELECT seq,node_type,node_name,doc_type,perm_code,is_required FROM biz_flow_steps WHERE flow_code=? ORDER BY seq')
      .all('FLOW_PURCHASE')
    const types = db
      .prepare("SELECT code,name FROM doc_types WHERE module='purchase' ORDER BY sort_order")
      .all()
    const machines = types.map((t) => ({
      code: t.code,
      name: t.name,
      lifecycle: explainLifecycle(db, t.code)
    }))
    return ok(res, { flow, steps, types, machines })
  })
)

/** 采购授权链路：把「谁在什么权限下能把单子推到哪」直接列出来，供前端做按钮可用性 */
r.get(
  '/chain/actions',
  requireAuth,
  guard((req, res) => {
    const { doc_type: docType, id } = req.query
    if (!docType || !id) return fail(res, '需要 doc_type 与 id', 400)
    return ok(res, { list: purchaseActions(getDb(), String(docType), Number(id)) })
  })
)

// ===========================================================================
// 二、供货目录与采购取价
// ===========================================================================

r.get(
  '/catalog',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const cond = ['1=1']
    const args = []
    if (req.query.supplier_id) { cond.push('sp.supplier_id=?'); args.push(Number(req.query.supplier_id)) }
    if (req.query.keyword) {
      cond.push('(s.sku_code LIKE ? OR s.name LIKE ? OR p.name LIKE ?)')
      const k = `%${req.query.keyword}%`
      args.push(k, k, k)
    }
    const rows = db
      .prepare(
        `SELECT sp.*, s.sku_code, s.name AS sku_name, p.name AS product_name, p.unit,
                sup.code AS supplier_code, sup.name AS supplier_name
           FROM supplier_products sp
           LEFT JOIN product_skus s ON s.id = sp.sku_id
           LEFT JOIN products p ON p.id = s.product_id
           LEFT JOIN suppliers sup ON sup.id = sp.supplier_id
          WHERE ${cond.join(' AND ')}
          ORDER BY sp.id DESC LIMIT ?`
      )
      .all(...args, Number(req.query.limit || 200))
    return ok(res, { list: rows })
  })
)

r.post(
  '/catalog',
  requireAuth,
  requirePerm('purchase.catalog.edit'),
  guard((req, res) => {
    const db = getDb()
    const { supplier_id: supplierId, sku_id: skuId, ...patch } = req.body || {}
    const row = upsertSupplierProduct(db, {
      supplierId: Number(supplierId),
      skuId: Number(skuId),
      patch,
      operator: actorOf(req).name
    })
    return ok(res, row)
  })
)

/** 单行取价试算：必须带来源（界面上回答「为什么是这个价」） */
r.get(
  '/price',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const skuId = Number(req.query.sku_id)
    const supplierId = req.query.supplier_id ? Number(req.query.supplier_id) : null
    const r0 = resolvePurchasePrice(db, {
      skuId,
      supplierId,
      qty: Number(req.query.qty || 1),
      at: req.query.at || null
    })
    const issues = checkSupplyCatalog(db, { supplierId, lines: [{ sku_id: skuId, qty: Number(req.query.qty || 1) }] })
    return ok(res, { ...r0, issues })
  })
)

/** 批量取价：新建请购/订单时整单试算，避免前端逐行请求 */
r.post(
  '/price-preview',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const { supplier_id: supplierId = null, lines = [], manual = null, at = null } = req.body || {}
    if (!Array.isArray(lines) || !lines.length) return fail(res, '需要 lines', 400)
    const priced = resolvePurchasePrices(db, { lines, supplierId, at, manual })
    const issues = checkSupplyCatalog(db, { supplierId, lines })
    const orderId = req.body.order_id ? Number(req.body.order_id) : null
    const over = orderId ? checkOverReceive(db, { orderId, lines }) : []
    const total = priced.reduce((s, x) => s + Number(x.amount || 0), 0)
    const qty = priced.reduce((s, x) => s + Number(x.qty || 0), 0)
    return ok(res, {
      lines: priced,
      issues,
      over_receive_issues: over,
      total_qty: Math.round(qty * 100) / 100,
      total_amount: Math.round(total * 100) / 100,
      trace: priced.map((x) => ({
        sku_id: x.sku_id,
        price: x.price,
        source: x.price_source,
        sourceLabel: x.price_source_label,
        detail: x.price_detail
      }))
    })
  })
)

// ===========================================================================
// 三、请购单
// ===========================================================================

r.get(
  '/requisitions',
  requireAuth,
  guard((req, res) => {
    const rows = listRequisitions(getDb(), {
      status: req.query.status || null,
      applicant_type: req.query.applicant_type || null,
      applicant_id: req.query.applicant_id ? Number(req.query.applicant_id) : null,
      keyword: req.query.keyword || null,
      limit: Number(req.query.limit || 200)
    })
    return ok(res, { list: rows })
  })
)

r.get(
  '/requisitions/:id',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const row = getRequisition(db, Number(req.params.id))
    if (!row) return fail(res, '请购单不存在', 404)
    row.actions = purchaseActions(db, 'PRQ', row.id)
    return ok(res, row)
  })
)

r.post(
  '/requisitions',
  requireAuth,
  requirePerm('purchase.req.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const actor = actorOf(req)
    const lines = (b.lines || []).map((l) => ({
      sku_id: Number(l.sku_id),
      qty: Number(l.qty || 0),
      price: l.price != null ? Number(l.price) : undefined,
      need_date: l.need_date || null,
      purpose: l.purpose || null,
      remark: l.remark || null
    }))
    // 未给价的行先走取价链，而不是留 0 —— 留 0 会让请购金额凭空少一块
    const priced = resolvePurchasePrices(db, {
      lines,
      supplierId: b.supplier_id ? Number(b.supplier_id) : null,
      at: b.req_date || null
    })
    const row = createRequisition(db, {
      orgId: b.org_id || null,
      warehouseId: b.warehouse_id ? Number(b.warehouse_id) : null,
      supplierId: b.supplier_id ? Number(b.supplier_id) : null,
      reqDate: b.req_date || undefined,
      expectDate: b.expect_date || null,
      applicantType: b.applicant_type || 'org',
      applicantId: b.applicant_id ? Number(b.applicant_id) : null,
      applicantName: b.applicant_name || actor.name,
      department: b.department || null,
      purpose: b.purpose || null,
      urgency: b.urgency || 'normal',
      tradeType: b.trade_type || 'normal',
      budgetAmount: b.budget_amount != null ? Number(b.budget_amount) : null,
      source: b.source || 'manual',
      sourceRef: b.source_ref || null,
      remark: b.remark || null,
      actor,
      lines: priced.map((p) => ({
        sku_id: p.sku_id,
        qty: p.qty,
        price: p.price,
        need_date: p.need_date,
        purpose: p.purpose,
        remark: p.remark
      }))
    })
    audit(req, { action: 'create', module: 'purchase', entity: 'purchase_requisitions', entityId: row.id, detail: { doc_no: row.doc_no } })
    return ok(res, { ...row, price_trace: priced.map((p) => ({ sku_id: p.sku_id, source: p.price_source, price: p.price })) })
  })
)

// ⚠️ 注册顺序敏感：`/requisitions/:id/convert` **必须**排在
// `/requisitions/:id/:action` 之前。`:action` 是通配段，先注册就会把
// `.../convert` 吃成 action='convert'，真正的转单端点永远匹配不到
// —— 表现出来是 400「请用 POST /requisitions/:id/convert」，而那个接口
// 谁都到不了。这类错不报错、只报「路径不对」，很难查（本项目真实踩过）。
r.post(
  '/requisitions/:id/convert',
  requireAuth,
  requirePerm('purchase.order.edit'),
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const out = convertRequisitionToOrder(db, {
      reqId: id,
      lines: req.body?.lines || null,
      supplierId: req.body?.supplier_id ? Number(req.body.supplier_id) : null,
      warehouseId: req.body?.warehouse_id ? Number(req.body.warehouse_id) : null,
      actor: actorOf(req),
      remark: req.body?.remark || null
    })
    audit(req, { action: 'convert', module: 'purchase', entity: 'purchase_requisitions', entityId: id, detail: out })
    return ok(res, out)
  })
)

r.post(
  '/requisitions/:id/:action',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const action = String(req.params.action)
    assertActionPermitted(req, db, 'PRQ', id)
    const row = transitionRequisition(db, {
      id,
      action,
      actor: actorOf(req),
      set: req.body?.set || {},
      remark: req.body?.remark || null
    })
    audit(req, { action, module: 'purchase', entity: 'purchase_requisitions', entityId: id, detail: { to: row.to_state } })
    return ok(res, row)
  })
)

// ===========================================================================
// 四、采购发票
// ===========================================================================

r.get(
  '/invoices',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const cond = ["i.status<>'voided'"]
    const args = []
    if (req.query.status) { cond.push('i.status=?'); args.push(req.query.status) }
    if (req.query.supplier_id) { cond.push('i.supplier_id=?'); args.push(Number(req.query.supplier_id)) }
    if (req.query.invoice_type) { cond.push('i.invoice_type=?'); args.push(req.query.invoice_type) }
    if (req.query.keyword) {
      cond.push('(i.doc_no LIKE ? OR i.invoice_no LIKE ?)')
      const k = `%${req.query.keyword}%`
      args.push(k, k)
    }
    const rows = db
      .prepare(
        `SELECT i.*, s.code AS supplier_code, s.name AS supplier_name,
                (SELECT COUNT(*) FROM purchase_invoice_items x WHERE x.invoice_id=i.id) AS line_count
           FROM purchase_invoices i LEFT JOIN suppliers s ON s.id=i.supplier_id
          WHERE ${cond.join(' AND ')} ORDER BY i.id DESC LIMIT ?`
      )
      .all(...args, Number(req.query.limit || 200))
    const sum = db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(tax_amount),0) tax, COALESCE(SUM(total_amount),0) total
           FROM purchase_invoices i WHERE ${cond.join(' AND ')}`
      )
      .get(...args)
    return ok(res, { list: rows, summary: sum })
  })
)

r.get(
  '/invoices/:id',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const row = getInvoice(db, Number(req.params.id))
    if (!row) return fail(res, '采购发票不存在', 404)
    row.actions = purchaseActions(db, 'PI', row.id)
    row.match = matchInvoiceToReceipts(db, row.id)
    return ok(res, row)
  })
)

r.post(
  '/invoices',
  requireAuth,
  requirePerm('purchase.invoice.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const row = createInvoice(db, {
      // 归属组织随单写入（合同批 K）：这三张表没有仓库/门店列，
      // `org_id` 就是它们唯一的归属列 —— 不写的话"令牌绑了组织就动不了自己的票"
      orgId: req.user?.org_id ?? null,
      invoiceNo: b.invoice_no || null,
      invoiceType: b.invoice_type || 'vat_special',
      supplierId: Number(b.supplier_id),
      orderId: b.order_id ? Number(b.order_id) : null,
      receiptId: b.receipt_id ? Number(b.receipt_id) : null,
      invoiceDate: b.invoice_date || undefined,
      currency: b.currency || 'CNY',
      taxRate: b.tax_rate != null ? Number(b.tax_rate) : 13,
      remark: b.remark || null,
      actor: actorOf(req),
      lines: b.lines || []
    })
    if (row.order_id) {
      refreshOrderStats(db, row.order_id)
      refreshCloseFlags(db, row.order_id)
    }
    audit(req, { action: 'create', module: 'purchase', entity: 'purchase_invoices', entityId: row.id, detail: { doc_no: row.doc_no } })
    return ok(res, row)
  })
)

r.post(
  '/invoices/:id/:action',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    assertActionPermitted(req, db, 'PI', id)
    const row = transitionInvoice(db, {
      id, action: String(req.params.action), actor: actorOf(req), remark: req.body?.remark || null
    })
    audit(req, { action: req.params.action, module: 'purchase', entity: 'purchase_invoices', entityId: id })
    return ok(res, row)
  })
)

/** 发票来源建议：本供应商已入库但未开票的行，供财务一键带出 */
r.get(
  '/invoices-available-lines',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const supplierId = Number(req.query.supplier_id)
    if (!supplierId) return fail(res, '需要 supplier_id', 400)
    // ⚠️ 必须**按订单行**归集（GROUP BY rc.order_id, ri.sku_id），不能按 sku_id 汇总。
    //
    // 按 sku 汇总时 `recv_qty` 是"该供应商该商品在**所有订单**上的入库合计"，
    // 而 `order_item_id` 只能挂到其中一张订单上 ⇒ 这个接口自己就在造
    // "挂 A 单、却用 A+B 两单的入库量"的发票行。财务从这里一键带出后提交，
    // 会被 `matchInvoiceToReceipts`（`lib/purchase.js`，已按订单行核对）正当拦下 ——
    // 那就是"前端能点、后端说不行"。**同一份口径只能有一处**：
    // 入库量、已开票量、挂在哪个订单行，三者都必须落在同一张订单上。
    //
    // 与 `db/procure-seed.js` 造发票行、`lib/purchase.js:matchInvoiceToReceipts`
    // 三处同形，改一处就要三处一起看。
    const rows = db
      .prepare(
        `SELECT ri.sku_id, rc.order_id, s.sku_code, s.name AS sku_name,
                SUM(ri.qty) recv_qty, SUM(ri.amount) recv_amount,
                COALESCE((SELECT SUM(ii.qty) FROM purchase_invoice_items ii
                            JOIN purchase_invoices i ON i.id=ii.invoice_id
                            JOIN purchase_order_items oi2 ON oi2.id=ii.order_item_id
                           WHERE oi2.order_id=rc.order_id AND ii.sku_id=ri.sku_id
                             AND i.status NOT IN ('voided','draft')),0) invoiced_qty,
                (SELECT oi.id FROM purchase_order_items oi
                  WHERE oi.order_id=rc.order_id AND oi.sku_id=ri.sku_id LIMIT 1) order_item_id
           FROM purchase_receipt_items ri
           JOIN purchase_receipts rc ON rc.id=ri.receipt_id
           LEFT JOIN product_skus s ON s.id=ri.sku_id
          WHERE rc.supplier_id=?
          GROUP BY rc.order_id, ri.sku_id
          ORDER BY s.sku_code, rc.order_id`
      )
      .all(supplierId)
    const list = rows
      .map((x) => ({
        ...x,
        open_qty: Math.round((Number(x.recv_qty || 0) - Number(x.invoiced_qty || 0)) * 100) / 100,
        unit_price: x.recv_qty > 0 ? Math.round((Number(x.recv_amount) / Number(x.recv_qty)) * 100) / 100 : 0
      }))
      .filter((x) => x.open_qty > 0.0001)
    return ok(res, { list })
  })
)

// ===========================================================================
// 五、采购结算
// ===========================================================================

r.get(
  '/settlements',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const cond = ["st.status<>'voided'"]
    const args = []
    if (req.query.status) { cond.push('st.status=?'); args.push(req.query.status) }
    if (req.query.supplier_id) { cond.push('st.supplier_id=?'); args.push(Number(req.query.supplier_id)) }
    const rows = db
      .prepare(
        `SELECT st.*, s.code AS supplier_code, s.name AS supplier_name,
                (st.settle_amount - st.paid_amount) AS open_amount
           FROM purchase_settlements st LEFT JOIN suppliers s ON s.id=st.supplier_id
          WHERE ${cond.join(' AND ')} ORDER BY st.id DESC LIMIT ?`
      )
      .all(...args, Number(req.query.limit || 200))
    const sum = db
      .prepare(
        `SELECT COALESCE(SUM(settle_amount),0) settle, COALESCE(SUM(paid_amount),0) paid,
                COALESCE(SUM(settle_amount-paid_amount),0) open, COALESCE(SUM(diff_amount),0) diff
           FROM purchase_settlements st WHERE ${cond.join(' AND ')}`
      )
      .get(...args)
    return ok(res, { list: rows, summary: sum })
  })
)

r.get(
  '/settlements/:id',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const row = getSettlement(db, Number(req.params.id))
    if (!row) return fail(res, '采购结算单不存在', 404)
    row.actions = purchaseActions(db, 'PST', row.id)
    return ok(res, row)
  })
)

/** 结算试算：先看会结出什么，再决定要不要落单（避免建了又作废） */
r.get(
  '/settlement-preview',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const supplierId = Number(req.query.supplier_id)
    if (!supplierId) return fail(res, '需要 supplier_id', 400)
    const ps = req.query.period_start || null
    const pe = req.query.period_end || null
    const rc = db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(total_amount),0) amt FROM purchase_receipts
          WHERE supplier_id=? AND status IN ('received','inspected','closed')
            ${ps ? 'AND receipt_date>=?' : ''} ${pe ? 'AND receipt_date<=?' : ''}`
      )
      .get(...[supplierId, ...(ps ? [ps] : []), ...(pe ? [pe] : [])])
    const inv = db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt,
                COALESCE(SUM(CASE WHEN invoice_type='fee' THEN amount ELSE 0 END),0) fee
           FROM purchase_invoices
          WHERE supplier_id=? AND status IN ('verified','posted')
            ${ps ? 'AND invoice_date>=?' : ''} ${pe ? 'AND invoice_date<=?' : ''}`
      )
      .get(...[supplierId, ...(ps ? [ps] : []), ...(pe ? [pe] : [])])
    return ok(res, {
      supplier_id: supplierId,
      receipt_count: rc.c,
      receipt_amount: Math.round(Number(rc.amt) * 100) / 100,
      invoice_count: inv.c,
      invoice_amount: Math.round((Number(inv.amt) - Number(inv.fee)) * 100) / 100,
      fee_amount: Math.round(Number(inv.fee) * 100) / 100,
      hint: rc.c === 0 && inv.c === 0 ? '该期间无可结算单据' : null
    })
  })
)

r.post(
  '/settlements',
  requireAuth,
  requirePerm('purchase.settle.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const row = buildSettlement(db, {
      orgId: req.user?.org_id ?? null,
      supplierId: Number(b.supplier_id),
      settleDate: b.settle_date || undefined,
      periodStart: b.period_start || null,
      periodEnd: b.period_end || null,
      settleMode: b.settle_mode || 'auto',
      remark: b.remark || null,
      actor: actorOf(req)
    })
    audit(req, { action: 'create', module: 'purchase', entity: 'purchase_settlements', entityId: row.id, detail: { doc_no: row.doc_no } })
    return ok(res, row)
  })
)

r.post(
  '/settlements/:id/:action',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    assertActionPermitted(req, db, 'PST', id)
    const row = transitionSettlement(db, {
      id, action: String(req.params.action), actor: actorOf(req), remark: req.body?.remark || null
    })
    audit(req, { action: req.params.action, module: 'purchase', entity: 'purchase_settlements', entityId: id })
    return ok(res, row)
  })
)

// ===========================================================================
// 六、付款单
// ===========================================================================

r.get(
  '/payments',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const cond = ["p.status<>'voided'"]
    const args = []
    if (req.query.status) { cond.push('p.status=?'); args.push(req.query.status) }
    if (req.query.supplier_id) { cond.push('p.supplier_id=?'); args.push(Number(req.query.supplier_id)) }
    const rows = db
      .prepare(
        `SELECT p.*, s.code AS supplier_code, s.name AS supplier_name,
                (p.amount - p.settled_amount) AS unallocated
           FROM purchase_payments p LEFT JOIN suppliers s ON s.id=p.supplier_id
          WHERE ${cond.join(' AND ')} ORDER BY p.id DESC LIMIT ?`
      )
      .all(...args, Number(req.query.limit || 200))
    const sum = db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) amount, COALESCE(SUM(settled_amount),0) settled
           FROM purchase_payments p WHERE ${cond.join(' AND ')}`
      )
      .get(...args)
    return ok(res, { list: rows, summary: sum })
  })
)

r.get(
  '/payments/:id',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const row = getPayment(db, Number(req.params.id))
    if (!row) return fail(res, '付款单不存在', 404)
    row.actions = purchaseActions(db, 'PAY', row.id)
    row.review = reviewOf(row)
    return ok(res, row)
  })
)

/** 付款前置：这张供应商还欠多少、FIFO 会核销到哪几张单 */
r.get(
  '/payment-plan',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const supplierId = Number(req.query.supplier_id)
    const amount = Number(req.query.amount || 0)
    if (!supplierId) return fail(res, '需要 supplier_id', 400)
    const open = db
      .prepare(
        `SELECT st.id, st.doc_no, st.settle_date, st.settle_amount, st.paid_amount,
                (st.settle_amount - st.paid_amount) open_amount
           FROM purchase_settlements st
          WHERE st.supplier_id=? AND st.status IN ('audited','settled')
            AND st.settle_amount - st.paid_amount > 0.01
          ORDER BY st.settle_date, st.id`
      )
      .all(supplierId)
    const plan = amount > 0 ? planAllocation(db, supplierId, amount) : []
    return ok(res, {
      open_total: Math.round(open.reduce((s, x) => s + Number(x.open_amount || 0), 0) * 100) / 100,
      list: open,
      plan
    })
  })
)

r.post(
  '/payments',
  requireAuth,
  requirePerm('purchase.payment.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const row = createPayment(db, {
      orgId: req.user?.org_id ?? null,
      supplierId: Number(b.supplier_id),
      payDate: b.pay_date || undefined,
      payType: b.pay_type || 'transfer',
      currency: b.currency || 'CNY',
      amount: Number(b.amount || 0),
      bankAccount: b.bank_account || null,
      voucherNo: b.voucher_no || null,
      remark: b.remark || null,
      allocations: b.allocations || null,
      actor: actorOf(req)
    })
    audit(req, { action: 'create', module: 'purchase', entity: 'purchase_payments', entityId: row.id, detail: { doc_no: row.doc_no } })
    return ok(res, row)
  })
)

// 复核（第二人，ADR-0018）：必须排在 `/:action` 之前，`review` 不是内核动作。
// approve = 在同一事务里执行 `pay`（核销 + 已付）+ 严格审计；reject = 退回已审批并记原因。
r.post(
  '/payments/:id/review',
  requireAuth,
  requirePerm(FUNDS_REVIEW_PERM),
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const actor = actorOf(req)
    const b = req.body || {}
    const out = reviewFunds(db, {
      kind: 'payment', id, actor, decision: b.decision, comment: b.comment ?? null,
      apply: () => transitionPayment(db, { id, action: 'pay', actor, remark: b.remark || null })
    })
    if (out.applied) audit(req, { action: 'pay', module: 'purchase', entity: 'purchase_payments', entityId: id })
    const row = getPayment(db, id)
    return ok(res, { ...row, review: out.review })
  })
)

r.post(
  '/payments/:id/:action',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const action = String(req.params.action)
    assertActionPermitted(req, db, 'PAY', id)
    // 待复核期间任何动作（再次 pay / void）一律拒绝：先由复核人批准或驳回
    assertNotPending(db, 'payment', id)
    if (action === 'pay') {
      const actor = actorOf(req)
      const b = req.body || {}
      const out = confirmFunds(db, {
        kind: 'payment', id, actor,
        evidence: { ref: b.evidence_ref, note: b.evidence_note },
        apply: () => transitionPayment(db, { id, action, actor, remark: b.remark || null })
      })
      if (out.applied) audit(req, { action: 'pay', module: 'purchase', entity: 'purchase_payments', entityId: id })
      const row = getPayment(db, id)
      return ok(res, { ...row, review: out.review })
    }
    const row = transitionPayment(db, { id, action, actor: actorOf(req), remark: req.body?.remark || null })
    audit(req, { action, module: 'purchase', entity: 'purchase_payments', entityId: id })
    return ok(res, row)
  })
)

// ===========================================================================
// 七、应付与采购订单后段补角
// ===========================================================================

/** 应付账款台账：按供应商看已结算 / 已付 / 未付与暂估差异 */
r.get(
  '/payables',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name, s.settle_type,
                COUNT(st.id) settle_count,
                COALESCE(SUM(st.settle_amount),0) settle_amount,
                COALESCE(SUM(st.paid_amount),0) paid_amount,
                COALESCE(SUM(st.settle_amount-st.paid_amount),0) open_amount,
                COALESCE(SUM(st.diff_amount),0) diff_amount
           FROM purchase_settlements st JOIN suppliers s ON s.id=st.supplier_id
          WHERE st.status<>'voided'
          GROUP BY s.id ORDER BY open_amount DESC`
      )
      .all()
    const total = rows.reduce(
      (a, x) => ({
        settle_amount: a.settle_amount + Number(x.settle_amount || 0),
        paid_amount: a.paid_amount + Number(x.paid_amount || 0),
        open_amount: a.open_amount + Number(x.open_amount || 0),
        diff_amount: a.diff_amount + Number(x.diff_amount || 0)
      }),
      { settle_amount: 0, paid_amount: 0, open_amount: 0, diff_amount: 0 }
    )
    for (const k of Object.keys(total)) total[k] = Math.round(total[k] * 100) / 100
    // ---- 退货披露（**只披露，不参与上面的口径**）----
    //
    // 为什么单列一块而不是并进 `settle_amount`：结算单的金额是「按入库单/发票**一单一结**」
    // 算出来的（见 `buildSettlement`），退货要怎么抵减是一个**业务规则**（按单抵还是按期间抵？
    // 已审结算单要不要追溯？退货对应的是本期还是上期的货？），**不是实现细节** ——
    // 悄悄把退货从 settle_amount 里减掉，会让"三单匹配"的结果从此说不清。
    //
    // 但**必须让它看得见**：本批之前，退货既不生成凭证（现已补 `purchase_return` 模板）、
    // 也不进结算，于是这张台账上的"未付"是**含退货的虚高值**，而且没有任何一处会提示。
    // ⇒ 披露出来，让人一眼看到"其中有多少是已退还没抵的"，再由人来决定怎么抵。
    const returnsBySupplier = db
      .prepare(
        `SELECT s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
                COUNT(pr.id) return_count,
                COALESCE(SUM(pr.total_amount),0) return_amount
           FROM purchase_returns pr JOIN suppliers s ON s.id=pr.supplier_id
          WHERE pr.status IN ('confirmed','completed')
          GROUP BY s.id ORDER BY return_amount DESC`
      )
      .all()
    const returnTotal = Math.round(returnsBySupplier.reduce((a, x) => a + Number(x.return_amount || 0), 0) * 100) / 100
    return ok(res, {
      list: rows,
      total,
      returns: {
        note: '采购退货披露：`confirmed` / `completed` 的退货金额，**不参与上面的 settle/paid/open 口径**（结算怎么抵减是业务规则，待定）',
        total_amount: returnTotal,
        by_supplier: returnsBySupplier
      }
    })
  })
)

/** 采购订单的四段关闭状态 + 后段金额 */
r.get(
  '/orders/:id/closes',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
    if (!order) return fail(res, '采购订单不存在', 404)
    const flags = refreshCloseFlags(db, id)
    const stats = refreshOrderStats(db, id)
    return ok(res, { order_id: id, doc_no: order.doc_no, ...flags, ...stats })
  })
)

/** 收货前的超量校验：前端可以先问一次，不必等提交才被拒 */
r.post(
  '/orders/:id/receive-check',
  requireAuth,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const lines = req.body?.lines || []
    const issues = checkOverReceive(db, { orderId: id, lines })
    const blocking = issues.filter((i) => i.level === 'block')
    return ok(res, { ok: blocking.length === 0, issues })
  })
)

/** 收货时回写供应商最近成交价（供后续「最新采购价」取价使用） */
r.post(
  '/supplier-last-price',
  requireAuth,
  requirePerm('purchase.order.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const out = touchSupplierLastPrice(db, {
      supplierId: Number(b.supplier_id),
      skuId: Number(b.sku_id),
      price: Number(b.price),
      docNo: b.doc_no || null,
      operator: actorOf(req).name
    })
    return ok(res, out)
  })
)

export default r
