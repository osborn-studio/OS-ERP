/**
 * ============================================================================
 * 文件标识：server/lib/invoice.js ｜ 销售发票（模块 24）
 * ============================================================================
 * 【职责】销售发票（模块 24）
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
 * 销售发票（模块 24）
 *
 * 这一层回答三个问题：
 *   ① 这批货开票了没有？（待开票队列 / 开票关闭状态）
 *   ② 开出去的票对应哪笔债权？（发票 ↔ 应收关联，两种口径）
 *   ③ 开错了怎么办？（红冲：原票留痕 + 关联应收作废 + 生成红字票）
 *
 * 三条口径：
 *   ① **开票不动库存**。它只产生债权。库存的唯一入口是库存引擎（lib/stock.js），
 *      任何试图在开票里改库存的写法都是错的。
 *   ② **开票关闭是可推导的**，不是人工点的：`invoice_status` 由「已确认发票的行数量 SUM」
 *      与「发货数量」比对得出。人工状态迟早和事实对不上。
 *   ③ **红冲不删原票**：原票置 red_charted、生成一张红字票（负数、invoice_type='red'、
 *      指回原票），两张都在。账要能追回来，靠的不是"删干净"，而是"留全"。
 *
 * 与应收的两种口径（`settings.ar_source_of_truth`）：
 *   - `SO`（默认）：应收在订单确认时已生成 → 开票时**关联**该订单的应收，不重复造一笔；
 *   - `SI`：应收在开票时才生成（债权成立于开票）→ 开票时新建 source_type='SI' 的应收。
 *   口径落库而不是写在代码里，切换不需要改代码。
 */
import { nextDocNoAuto } from './docno.js'
// S-10：应收被红冲作废时必须留痕，与流转同一套 `logEvent`。
import { applyTransition, logEvent } from './docflow.js'
import { ensureAr, arOfOrder, AR_SOURCE_SI } from './ar.js'
import { localDate, localNow } from './dates.js'
import { readSetting } from './settings.js'

export class InvoiceError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = http
    this.detail = detail
  }
}

const nowText = () => localNow()
const money = (n) => Number((Number(n) || 0).toFixed(2))
// 业务日一律本地口径（dates.js）。三种入参都要照顾到：
// 空 → 今天；Date → 转本地日期；字符串 → 原样截取前 10 位。
// 老写法是 `String(v || 今天的UTC日期).slice(0,10)`，对 Date 入参会得到
// 「Fri Oct 1」这种垃圾，只是恰好没人这么传。
const ymd = (v) => {
  if (v instanceof Date) return localDate(v)
  const s = String(v ?? '').trim()
  return s ? s.slice(0, 10) : localDate()
}

export const SI_STATUS_LABEL = {
  draft: '草稿',
  pending: '待确认',
  confirmed: '已开票',
  red_charted: '已红冲',
  voided: '已作废'
}
export const INVOICE_STATUS_LABEL = { none: '未开票', partial: '部分开票', invoiced: '已开票' }

/** 读应收生成口径。唯一出处 `SETTING_RULES.ar_source_of_truth`（`enum` 值域 SO / SI，
 *  写入点拒绝其它值、读取点对非法值回落 `SO`）—— 与原来那句"不是 SI 就当 SO"等价。 */
function arSourceOfTruth(db) {
  return readSetting(db, 'ar_source_of_truth')
}

/** 价税拆分：以含税金额为基准反推不含税与税额（销售价通常按含税谈） */
function splitTax(totalIncl, taxRate) {
  const rate = Number(taxRate)
  const total = money(totalIncl)
  if (!(rate > 0)) return { amount: total, tax: 0, total }
  const ex = money(total / (1 + rate))
  return { amount: ex, tax: money(total - ex), total }
}

/**
 * 某张发货单「还剩多少没开票」，逐行给出。
 * 判断依据是**已确认蓝字发票**的行 SUM（草稿票不算已开票 —— 与核销口径同源：
 * 没生效的动作不产生后果）。
 *
 * S-3：这里原来**漏了 `si.invoice_type='normal'`** —— 红字票的行数量是负数，
 * 被算进"已开票量"后 `remain_qty = 2 − (−2) = 4`，于是红冲之后能**超开发票**
 * （实测真开出了 4 件的新票）。同一件事在同文件 `refreshCloseStatus` 里是带
 * `invoice_type='normal'` 的 —— 两份判据分叉正是本项目反复吃过的坑，这两处必须同源。
 */
export function pendingLinesOfDelivery(db, deliveryId) {
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.sku_id, i.batch_no, i.qty, i.price, i.amount,
              IFNULL((
                SELECT SUM(sii.qty) FROM sales_invoice_items sii
                JOIN sales_invoices si ON si.id = sii.invoice_id
                WHERE sii.source_delivery_id = i.delivery_id
                  AND sii.source_line_no = i.id
                  AND si.status = 'confirmed'
                  AND si.invoice_type = 'normal'
              ), 0) AS invoiced_qty
       FROM sales_delivery_items i
       WHERE i.delivery_id = ?
       ORDER BY i.id`
    )
    .all(deliveryId)
  return rows
    .map((r) => ({ ...r, remain_qty: money(Number(r.qty) - Number(r.invoiced_qty)) }))
    .filter((r) => r.remain_qty > 0.005)
}

/**
 * 待开票队列：已发货/已签收、且还有未开票数量的发货单。
 *
 * 默认排除「已开完票」的（invoice_status='invoiced'）—— 队列的语义是「还有活要干」，
 * 一张已经开完票的发货单留在这里只会让人以为漏开了。要看全量传 includeInvoiced。
 */
export function pendingDeliveries(db, q = {}) {
  const where = ["d.status IN ('shipped','received')"]
  const args = []
  if (!q.includeInvoiced) where.push("IFNULL(d.invoice_status,'none') <> 'invoiced'")
  if (q.orderId) {
    where.push('d.order_id = ?')
    args.push(q.orderId)
  }
  if (q.onlyNone) where.push("IFNULL(d.invoice_status,'none') = 'none'")
  if (q.keyword) {
    where.push('(d.doc_no LIKE ? OR so.doc_no LIKE ?)')
    args.push(`%${q.keyword}%`, `%${q.keyword}%`)
  }
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_no, d.order_id, so.doc_no AS order_no, d.delivery_date, d.status,
              d.total_qty, d.total_amount, IFNULL(d.invoice_status,'none') AS invoice_status,
              IFNULL(d.invoice_qty_sum,0) AS invoice_qty_sum,
              CASE WHEN so.dealer_id IS NOT NULL THEN 'dealer' ELSE 'store' END AS subject_type,
              CASE WHEN so.dealer_id IS NOT NULL THEN so.dealer_id ELSE so.store_id END AS subject_id
       FROM sales_deliveries d
       LEFT JOIN sales_orders so ON so.id = d.order_id
       WHERE ${where.join(' AND ')}
       ORDER BY d.delivery_date DESC, d.id DESC`
    )
    .all(...args)
  return rows.map((r) => ({ ...r, remain_qty: money(Number(r.total_qty) - Number(r.invoice_qty_sum)) }))
}

/** 客户信息（从订单取，订单没有则空） */
function subjectOfOrder(db, orderId) {
  if (!orderId) return { subjectType: 'dealer', subjectId: null, subjectName: null, creditDays: 0 }
  const o = db
    .prepare(
      `SELECT o.dealer_id, o.store_id, d.name AS dealer_name, d.credit_days AS dealer_credit_days,
              s.name AS store_name
       FROM sales_orders o
       LEFT JOIN dealers d ON d.id = o.dealer_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.id = ?`
    )
    .get(orderId)
  if (!o) return { subjectType: 'dealer', subjectId: null, subjectName: null, creditDays: 0 }
  if (o.dealer_id) {
    return { subjectType: 'dealer', subjectId: o.dealer_id, subjectName: o.dealer_name, creditDays: Number(o.dealer_credit_days) || 0 }
  }
  return { subjectType: 'store', subjectId: o.store_id, subjectName: o.store_name, creditDays: 0 }
}

/**
 * 由发货单开票（幂等性由调用方控制：草稿不参与开票关闭，可重复开草稿再删）。
 * items 不传 = 把该发货单所有未开票行一次开完；传了就按指定数量开（支持分批开票）。
 */
export function createInvoiceFromDelivery(db, {
  deliveryId, invoiceDate = null, invoiceNo = null, taxRate = 0.13,
  items = null, remark = null, actor = null
} = {}) {
  const d = db.prepare('SELECT * FROM sales_deliveries WHERE id=?').get(deliveryId)
  if (!d) throw new InvoiceError('SI_DELIVERY_NOT_FOUND', '发货单不存在', 404)
  if (d.status === 'cancelled') throw new InvoiceError('SI_DELIVERY_CANCELLED', '已取消的发货单不能开票', 409)

  const pending = pendingLinesOfDelivery(db, deliveryId)
  if (!pending.length) throw new InvoiceError('SI_NOTHING_TO_INVOICE', '该发货单已全部开票，没有可开数量', 409)

  // 按传入 items 取数量，未传则整行开完
  const wanted = new Map()
  if (Array.isArray(items) && items.length) {
    for (const it of items) {
      const lineId = Number(it.item_id ?? it.source_line_no)
      const q = Number(it.qty)
      if (!lineId || !(q > 0)) continue
      wanted.set(lineId, q)
    }
  }
  // S-3：**超出剩余可开量就直接拒绝**，不再靠 `Math.min` 悄悄截平。
  // 截平的后果：用户要开 4 件（红冲后被算成 4）、系统"照办"开出去，
  // 事后只有 `auditInvoice` 能发现 —— 那时票已经开出、应收已经多记。
  // 注意：行已开满时这里**不报错**（让它落到下面 `lines` 为空的 `SI_NOTHING_TO_INVOICE`），
  // 保持"已开满的行不能再开票"这条既有契约的错误码不变。
  for (const [lineId, q] of wanted) {
    const p = pending.find((x) => Number(x.item_id) === lineId)
    if (!p) continue
    if (q > Number(p.remain_qty) + 0.005) {
      throw new InvoiceError(
        'SI_QTY_EXCEEDS_REMAIN',
        `发货行 #${lineId} 剩余可开数量只有 ${p.remain_qty}，本次要开 ${q}`,
        409,
        { item_id: lineId, remain_qty: p.remain_qty, requested: q }
      )
    }
  }
  const lines = []
  for (const p of pending) {
    const q = wanted.size ? Math.min(wanted.get(p.item_id) ?? 0, p.remain_qty) : p.remain_qty
    if (!(q > 0)) continue
    const unitIncl = Number(p.qty) > 0 ? Number(p.amount) / Number(p.qty) : Number(p.price) || 0
    const t = splitTax(unitIncl * q, taxRate)
    lines.push({
      sku_id: p.sku_id,
      qty: money(q),
      price: money(unitIncl / (1 + Number(taxRate || 0))),
      ...t,
      source_line_no: p.item_id
    })
  }
  if (!lines.length) throw new InvoiceError('SI_NOTHING_TO_INVOICE', '指定的开票数量为空', 409)

  const subj = subjectOfOrder(db, d.order_id)
  if (!subj.subjectId) throw new InvoiceError('SI_SUBJECT_MISSING', '发货单对应的订单没有客户信息，无法开票', 409)

  const header = lines.reduce(
    (acc, l) => ({
      amount: money(acc.amount + l.amount),
      tax: money(acc.tax + l.tax),
      total: money(acc.total + l.total)
    }),
    { amount: 0, tax: 0, total: 0 }
  )

  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'SI', table: 'sales_invoices', field: 'doc_no', bizDate: ymd(invoiceDate) })
    const info = db
      .prepare(
        `INSERT INTO sales_invoices
         (doc_no,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,order_id,order_no,
          invoice_date,invoice_no,invoice_type,tax_rate,amount,tax_amount,total_amount,currency,status,remark,
          created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,'DL',?,?,?,?,?,?,'normal',?,?,?,?,'CNY','draft',?,?,?,?,?)`
      )
      .run(
        docNo,
        subj.subjectType,
        subj.subjectId,
        subj.subjectName,
        d.id,
        d.doc_no,
        d.order_id,
        db.prepare('SELECT doc_no FROM sales_orders WHERE id=?').get(d.order_id)?.doc_no || null,
        ymd(invoiceDate),
        invoiceNo,
        Number(taxRate) || 0,
        header.amount,
        header.tax,
        header.total,
        remark,
        actor?.id || null,
        actor?.name || null,
        nowText(),
        nowText()
      )
    const invoiceId = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      `INSERT INTO sales_invoice_items
       (invoice_id,line_no,sku_id,sku_code,sku_name,spec,qty,price,amount,tax_rate,tax_amount,total_amount,
        source_delivery_id,source_delivery_no,source_line_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    lines.forEach((l, idx) => {
      const sku = db.prepare('SELECT sku_code AS code, name FROM product_skus WHERE id=?').get(l.sku_id)
      insItem.run(
        invoiceId, idx + 1, l.sku_id, sku?.code || null, sku?.name || null, null,
        l.qty, l.price, l.amount, Number(taxRate) || 0, l.tax, l.total,
        d.id, d.doc_no, l.source_line_no
      )
    })
    return db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(invoiceId)
  })
  return tx()
}

/** 手工开票（无来源单据，用于补开历史票 / 特殊业务） */
export function createManualInvoice(db, {
  subjectType, subjectId, subjectName = null, invoiceDate = null, invoiceNo = null,
  taxRate = 0.13, items = [], remark = null, actor = null
} = {}) {
  if (!subjectType || !subjectId) throw new InvoiceError('SI_SUBJECT_REQUIRED', '必须指定开票客户', 400)
  if (!Array.isArray(items) || !items.length) throw new InvoiceError('SI_ITEMS_REQUIRED', '必须至少一行开票明细', 400)

  const lines = items.map((it) => {
    const total = money(it.total_amount ?? money(Number(it.qty) * Number(it.price)))
    const t = splitTax(total, it.tax_rate ?? taxRate)
    return { sku_id: it.sku_id || null, qty: money(it.qty), price: money(it.price), ...t, source_line_no: null }
  })
  const header = lines.reduce(
    (acc, l) => ({ amount: money(acc.amount + l.amount), tax: money(acc.tax + l.tax), total: money(acc.total + l.total) }),
    { amount: 0, tax: 0, total: 0 }
  )

  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'SI', table: 'sales_invoices', field: 'doc_no', bizDate: ymd(invoiceDate) })
    const info = db
      .prepare(
        `INSERT INTO sales_invoices
         (doc_no,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,invoice_date,invoice_no,
          invoice_type,tax_rate,amount,tax_amount,total_amount,currency,status,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,'MANUAL',NULL,NULL,?,?,'normal',?,?,?,?,'CNY','draft',?,?,?,?,?)`
      )
      .run(
        docNo, subjectType, subjectId, subjectName, ymd(invoiceDate), invoiceNo,
        Number(taxRate) || 0, header.amount, header.tax, header.total, remark,
        actor?.id || null, actor?.name || null, nowText(), nowText()
      )
    const invoiceId = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      `INSERT INTO sales_invoice_items
       (invoice_id,line_no,sku_id,sku_code,sku_name,spec,qty,price,amount,tax_rate,tax_amount,total_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    lines.forEach((l, idx) => {
      const sku = l.sku_id ? db.prepare('SELECT sku_code AS code, name FROM product_skus WHERE id=?').get(l.sku_id) : null
      insItem.run(invoiceId, idx + 1, l.sku_id, sku?.code || null, sku?.name || null, null,
        l.qty, l.price, l.amount, Number(taxRate) || 0, l.tax, l.total)
    })
    return db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(invoiceId)
  })
  return tx()
}

/** 提交（draft → pending）。提交后才可确认，避免"手一滑就开出去一张票" */
export function submitInvoice(db, { id, actor = null } = {}) {
  return applyTransition({ db, docType: 'SI', id, action: 'submit', actor, source: 'api', remark: '提交开票' })
}

/**
 * 确认开票（唯一有后果的动作）：
 *   内核流转留痕 → 生成本票的应收（或关联订单已有的应收）→ 回写开票关闭状态。
 * 应收口径由 settings.ar_source_of_truth 决定（SO 关联 / SI 新建）。
 */
export function confirmInvoice(db, { id, actor = null, creditDays = null } = {}) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id)
  if (!inv) throw new InvoiceError('SI_NOT_FOUND', '发票不存在', 404)
  if (inv.status !== 'pending') {
    throw new InvoiceError('SI_NOT_PENDING', `当前状态「${inv.status}」不能确认开票`, 409)
  }

  const mode = arSourceOfTruth(db)
  const tx = db.transaction(() => {
    applyTransition({ db, docType: 'SI', id, action: 'confirm', actor, source: 'api', remark: '确认开票（债权成立）' })
    db.prepare(
      `UPDATE sales_invoices SET status='confirmed', confirmed_by=?, confirmed_by_name=?, confirmed_at=?, updated_at=? WHERE id=?`
    ).run(actor?.id || null, actor?.name || null, nowText(), nowText(), id)

    // ① 找/建应收
    // 零金额发票（赠品 / 全额折让后为 0）不开应收 —— 债权为 0 时没有"账"可记，
    // 硬要 ensureAr 会被金额校验拒掉，从而把一张合法的票挡在门外。
    // 这类票仍然要留痕、仍然参与开票关闭（它确实把货开完了票）。
    let ar = null
    let relation = null
    if (mode === 'SO' && inv.order_id) {
      // S-2：找的是**这张订单的应收**（按订单聚合、不分来源，见 ar.js `arOfOrder`）。
      // 原来只认 `source_type='SO'`：订单已经挂着 `SI` 应收时它看不见，
      // 于是又建一张 `SI` 应收 ⇒ 同一订单两笔债权（实测 200 → 开票 200 + 回款 200 = 400）。
      ar = arOfOrder(db, inv.order_id)[0] || null
      if (ar) relation = 'linked'
    }
    const hasDebt = money(inv.total_amount) > 0.005
    if (!ar && hasDebt) {
      const days = creditDays != null ? Number(creditDays) : subjectOfOrder(db, inv.order_id).creditDays
      ar = ensureAr(db, {
        subjectType: inv.subject_type,
        subjectId: inv.subject_id,
        subjectName: inv.subject_name,
        sourceType: AR_SOURCE_SI,
        sourceId: inv.id,
        sourceDocNo: inv.doc_no,
        bizDate: inv.invoice_date,
        amount: inv.total_amount,
        creditDays: days,
        remark: `销售发票 ${inv.doc_no} 生成`,
        actor
      })
      relation = 'created'
    }
    if (ar) {
      db.prepare('UPDATE sales_invoices SET ar_id=?, ar_doc_no=?, updated_at=? WHERE id=?')
        .run(ar.id, ar.doc_no, nowText(), id)
      db.prepare(
        `INSERT INTO invoice_ar_links (invoice_id, ar_id, delivery_id, amount, relation)
         VALUES (?,?,?,?,?)
         ON CONFLICT(invoice_id, ar_id) DO UPDATE SET amount=excluded.amount, relation=excluded.relation`
      ).run(id, ar.id, inv.source_id || null, inv.total_amount, relation)
    }

    refreshCloseStatus(db, { deliveryId: inv.source_id || null, orderId: inv.order_id || null })
    return { invoice: db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id), ar, relation, ar_mode: mode, zero_amount: !hasDebt }
  })
  return tx()
}

/**
 * 红冲：原票留痕 + 关联应收**按口径处理** + 生成红字票。已收过款的票必须先处理收款。
 *
 * **一张发票不等于一笔债权**（A10 修）：
 *   · `relation='created'`（SI 口径）—— 这张应收就是本票开出来的，红冲即整张作废；
 *   · `relation='linked'`（SO 口径）—— 应收是**订单级**的，被同一订单的多张发票共享，
 *     红冲一张票只等于"这笔开票动作撤销"，**不动那张共享应收**。
 *     债权的作废属于**订单**的生命周期（取消 / 退货），不由此处代劳。
 *   旧实现不区分 `linked`/`created`，一律 `voided` ⇒
 *   「订单应收 1000、分票 400 / 600，红冲 400」会把 600 那张票的债权一起抹掉。
 */
export function redChartInvoice(db, { id, reason = null, actor = null } = {}) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id)
  if (!inv) throw new InvoiceError('SI_NOT_FOUND', '发票不存在', 404)
  if (inv.status !== 'confirmed') throw new InvoiceError('SI_NOT_CONFIRMED', `当前状态「${inv.status}」不能红冲`, 409)
  if (!reason) throw new InvoiceError('SI_REASON_REQUIRED', '红冲必须填写原因', 400)

  const links = db.prepare('SELECT * FROM invoice_ar_links WHERE invoice_id=?').all(id)
  for (const l of links) {
    // 只有"这张票自己开出来的应收"才需要先处理收款：共享应收（订单级）的红冲不碰到它，
    // 因此订单收过款也不该成为"红冲不了任何一张票"的理由（那会让换票永远做不了）。
    if (l.relation === 'linked') continue
    const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(l.ar_id)
    if (ar && Number(ar.allocated_amount) > 0.005) {
      throw new InvoiceError(
        'SI_AR_ALLOCATED',
        `该发票关联的应收单 ${ar.doc_no} 已有收款记录，请先作废对应收款单再红冲`,
        409,
        { ar_id: ar.id, ar_doc_no: ar.doc_no, allocated: ar.allocated_amount }
      )
    }
  }

  const tx = db.transaction(() => {
    applyTransition({ db, docType: 'SI', id, action: 'red_chart', actor, source: 'api', remark: reason })
    db.prepare("UPDATE sales_invoices SET status='red_charted', updated_at=? WHERE id=?").run(nowText(), id)

    // 关联应收按口径处理（A10）：
    //   created —— 应收就是本票的，红冲即整张作废（不是删记录，是标作废并留痕）；
    //   linked  —— 应收是订单级的、被多张票共享，**一张票红冲不了整笔债权**，不动它。
    for (const l of links) {
      if (l.relation === 'linked') continue
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(l.ar_id)
      if (ar && ar.status !== 'voided' && ar.status !== 'closed') {
        db.prepare("UPDATE ar_documents SET status='voided', updated_at=? WHERE id=?").run(nowText(), ar.id)
        // S-10：作废一笔应收必须留痕。原来是一条裸 UPDATE ——
        // 红冲之后债权被作废，而 `doc_events` 里查不到任何痕迹（G3 共因之一）。
        logEvent({
          db,
          docType: 'AR',
          id: ar.id,
          docNo: ar.doc_no,
          action: 'void',
          actionName: '红冲作废应收',
          from: ar.status,
          to: 'voided',
          source: 'api',
          remark: `发票 ${inv.doc_no} 红冲：${reason}`,
          payload: { invoice_id: inv.id, invoice_no: inv.doc_no, amount: money(ar.amount) }
        })
      }
    }

    // 红字票：负数金额、指回原票，作为账务凭证留在列表里
    const redNo = nextDocNoAuto(db, { docType: 'SI', table: 'sales_invoices', field: 'doc_no', bizDate: ymd(inv.invoice_date) })
    const redInfo = db
      .prepare(
        `INSERT INTO sales_invoices
         (doc_no,org_id,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,order_id,order_no,
          invoice_date,invoice_no,invoice_type,tax_rate,amount,tax_amount,total_amount,currency,status,
          red_chart_of_id,remark,created_by,created_by_name,confirmed_by,confirmed_by_name,confirmed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,'DL',?,?,?,?,?,?,'red',?,?,?,?,'CNY','confirmed',?,?,?,?,?,?,?,?,?)`
      )
      .run(
        redNo, inv.org_id || null, inv.subject_type, inv.subject_id, inv.subject_name,
        inv.source_id, inv.source_doc_no, inv.order_id, inv.order_no,
        inv.invoice_date, inv.invoice_no, inv.tax_rate,
        -money(inv.amount), -money(inv.tax_amount), -money(inv.total_amount),
        inv.id, `红冲 ${inv.doc_no}：${reason}`,
        actor?.id || null, actor?.name || null, actor?.id || null, actor?.name || null, nowText(), nowText(), nowText()
      )
    const redId = Number(redInfo.lastInsertRowid)
    const srcItems = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id=? ORDER BY line_no').all(id)
    const insItem = db.prepare(
      `INSERT INTO sales_invoice_items
       (invoice_id,line_no,sku_id,sku_code,sku_name,spec,qty,price,amount,tax_rate,tax_amount,total_amount,
        source_delivery_id,source_delivery_no,source_line_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    srcItems.forEach((it, idx) => {
      insItem.run(redId, idx + 1, it.sku_id, it.sku_code, it.sku_name, it.spec,
        -Number(it.qty), it.price, -Number(it.amount), it.tax_rate, -Number(it.tax_amount), -Number(it.total_amount),
        it.source_delivery_id, it.source_delivery_no, it.source_line_no)
    })

    refreshCloseStatus(db, { deliveryId: inv.source_id || null, orderId: inv.order_id || null })
    return { invoice: db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id), red: db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(redId) }
  })
  return tx()
}

export function voidInvoice(db, { id, reason = null, actor = null } = {}) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id)
  if (!inv) throw new InvoiceError('SI_NOT_FOUND', '发票不存在', 404)
  if (inv.status === 'confirmed') throw new InvoiceError('SI_CONFIRMED_CANNOT_VOID', '已开票的发票只能红冲，不能直接作废', 409)
  const tx = db.transaction(() => {
    applyTransition({ db, docType: 'SI', id, action: 'void', actor, source: 'api', remark: reason || '作废发票' })
    db.prepare("UPDATE sales_invoices SET status='voided', updated_at=? WHERE id=?").run(nowText(), id)
    return db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id)
  })
  return tx()
}

/**
 * 重推开票关闭状态。
 * 口径：已开票数量 = 该发货单下**已确认蓝字发票**的行数量 SUM（红字票与红冲票都不计）。
 */
export function refreshCloseStatus(db, { deliveryId = null, orderId = null } = {}) {
  const invoicedQtyOfDelivery = (id) =>
    Number(
      db
        .prepare(
          `SELECT IFNULL(SUM(sii.qty),0) q FROM sales_invoice_items sii
           JOIN sales_invoices si ON si.id = sii.invoice_id
           WHERE sii.source_delivery_id = ? AND si.status='confirmed' AND si.invoice_type='normal'`
        )
        .get(id).q
    )

  const touchedDeliveries = deliveryId
    ? [deliveryId]
    : db.prepare('SELECT id FROM sales_deliveries WHERE id IN (SELECT DISTINCT source_id FROM sales_invoices WHERE source_type=\'DL\' AND source_id IS NOT NULL)').all().map((r) => r.id)

  for (const id of touchedDeliveries) {
    const total = Number(db.prepare('SELECT IFNULL(SUM(qty),0) q FROM sales_delivery_items WHERE delivery_id=?').get(id).q)
    const inv = money(invoicedQtyOfDelivery(id))
    const status = inv <= 0.005 ? 'none' : total > 0 && inv >= total - 0.005 ? 'invoiced' : 'partial'
    const last = db
      .prepare(
        `SELECT id, doc_no FROM sales_invoices
         WHERE source_type='DL' AND source_id=? AND status='confirmed' AND invoice_type='normal'
         ORDER BY id DESC LIMIT 1`
      )
      .get(id)
    db.prepare('UPDATE sales_deliveries SET invoice_status=?, invoice_qty_sum=?, invoice_id=?, invoice_no=? WHERE id=?')
      .run(status, inv, last?.id || null, last?.doc_no || null, id)
  }

  // 订单层：把订单下所有发货单的开票量汇总，与订单数量比对
  const orderIds = orderId
    ? [orderId]
    : db.prepare("SELECT DISTINCT order_id FROM sales_deliveries WHERE order_id IS NOT NULL").all().map((r) => r.order_id)
  const ids = orderId ? orderIds : orderIds.filter((v) => v != null)
  for (const oid of ids) {
    const ordered = Number(db.prepare('SELECT IFNULL(SUM(qty),0) q FROM sales_order_items WHERE order_id=?').get(oid).q)
    const inv = money(
      Number(
        db
          .prepare(
            `SELECT IFNULL(SUM(sii.qty),0) q FROM sales_invoice_items sii
             JOIN sales_invoices si ON si.id = sii.invoice_id
             WHERE si.order_id = ? AND si.status='confirmed' AND si.invoice_type='normal'`
          )
          .get(oid).q
      )
    )
    const status = inv <= 0.005 ? 'none' : ordered > 0 && inv >= ordered - 0.005 ? 'invoiced' : 'partial'
    const last = db
      .prepare(
        `SELECT id, doc_no FROM sales_invoices
         WHERE order_id=? AND status='confirmed' AND invoice_type='normal' ORDER BY id DESC LIMIT 1`
      )
      .get(oid)
    db.prepare('UPDATE sales_orders SET invoice_status=?, invoice_qty_sum=?, invoice_id=?, invoice_no=? WHERE id=?')
      .run(status, inv, last?.id || null, last?.doc_no || null, oid)
  }
  return { deliveries: touchedDeliveries.length, orders: ids.length }
}

export function listInvoices(db, q = {}) {
  const where = []
  const args = []
  if (q.status) {
    where.push('status=?')
    args.push(q.status)
  }
  if (q.subjectType && q.subjectId) {
    where.push('subject_type=? AND subject_id=?')
    args.push(q.subjectType, q.subjectId)
  }
  if (q.orderId) {
    where.push('order_id=?')
    args.push(q.orderId)
  }
  if (q.invoiceType) {
    where.push('invoice_type=?')
    args.push(q.invoiceType)
  }
  if (q.from) {
    where.push('invoice_date >= ?')
    args.push(q.from)
  }
  if (q.to) {
    where.push('invoice_date <= ?')
    args.push(q.to)
  }
  if (q.keyword) {
    where.push('(doc_no LIKE ? OR IFNULL(invoice_no,\'\') LIKE ? OR IFNULL(subject_name,\'\') LIKE ? OR IFNULL(order_no,\'\') LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k, k, k)
  }
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const pageSize = Number(q.pageSize) || 20
  const page = Number(q.page) || 1
  const rows = db
    .prepare(`SELECT * FROM sales_invoices ${cond} ORDER BY invoice_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize)
  const total = db.prepare(`SELECT COUNT(*) c FROM sales_invoices ${cond}`).get(...args).c
  return { rows, total, page, pageSize }
}

export function getInvoice(db, id) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(id)
  if (!inv) return null
  const items = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id=? ORDER BY line_no').all(id)
  const links = db
    .prepare(
      `SELECT l.*, d.doc_no AS ar_no, d.status AS ar_status, d.amount AS ar_amount, d.allocated_amount AS ar_allocated
       FROM invoice_ar_links l JOIN ar_documents d ON d.id = l.ar_id
       WHERE l.invoice_id=? ORDER BY l.id`
    )
    .all(id)
  const red = db.prepare('SELECT id, doc_no, total_amount, status FROM sales_invoices WHERE red_chart_of_id=?').all(id)
  const origin = inv.red_chart_of_id
    ? db.prepare('SELECT id, doc_no, status, total_amount FROM sales_invoices WHERE id=?').get(inv.red_chart_of_id)
    : null
  return { ...inv, items, links, red_invoices: red, origin_invoice: origin }
}

export function invoiceOverview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const total = one(
    `SELECT COUNT(*) c, IFNULL(SUM(total_amount),0) t, IFNULL(SUM(tax_amount),0) tax
     FROM sales_invoices WHERE status='confirmed'`
  )
  const draft = one(`SELECT COUNT(*) c FROM sales_invoices WHERE status IN ('draft','pending')`)
  const red = one(`SELECT COUNT(*) c, IFNULL(SUM(total_amount),0) t FROM sales_invoices WHERE invoice_type='red'`)
  const pending = db.prepare('SELECT COUNT(*) c FROM sales_deliveries WHERE status IN (\'shipped\',\'received\') AND IFNULL(invoice_status,\'none\') <> \'invoiced\'').get()
  const byStatus = db.prepare('SELECT status, COUNT(*) c, IFNULL(SUM(total_amount),0) amt FROM sales_invoices GROUP BY status').all()
  return {
    confirmed_count: total?.c || 0,
    confirmed_amount: money(total?.t || 0),
    tax_amount: money(total?.tax || 0),
    pending_confirm: draft?.c || 0,
    red_count: red?.c || 0,
    red_amount: money(red?.t || 0),
    pending_deliveries: pending?.c || 0,
    by_status: byStatus.map((r) => ({ ...r, amt: money(r.amt) }))
  }
}

/** 自洽审计：头金额 = 行 SUM；开票数量不超发货数量；已确认票必须有应收关联 */
export function auditInvoice(db) {
  const headDrift = db
    .prepare(
      `SELECT v.id, v.doc_no, v.amount, v.tax_amount, v.total_amount,
              IFNULL(SUM(i.amount),0) AS line_amount,
              IFNULL(SUM(i.tax_amount),0) AS line_tax,
              IFNULL(SUM(i.total_amount),0) AS line_total
       FROM sales_invoices v LEFT JOIN sales_invoice_items i ON i.invoice_id = v.id
       GROUP BY v.id`
    )
    .all()
    .filter(
      (r) =>
        Math.abs(money(r.line_amount) - money(r.amount)) > 0.01 ||
        Math.abs(money(r.line_tax) - money(r.tax_amount)) > 0.01 ||
        Math.abs(money(r.line_total) - money(r.total_amount)) > 0.01
    )
  const overQty = db
    .prepare(
      `SELECT sii.source_delivery_id, sii.source_line_no,
              SUM(sii.qty) AS invoiced,
              (SELECT qty FROM sales_delivery_items WHERE id = sii.source_line_no) AS delivered
       FROM sales_invoice_items sii
       JOIN sales_invoices si ON si.id = sii.invoice_id
       WHERE si.status='confirmed' AND si.invoice_type='normal' AND sii.source_line_no IS NOT NULL
       GROUP BY sii.source_delivery_id, sii.source_line_no
       HAVING invoiced > delivered + 0.005`
    )
    .all()
  // 已确认的**有金额**蓝字票必须能找到应收落点；零金额票（赠品/全额折让）本就不产生债权，
  // 不纳入这条检查，否则会把合法的赠品开票误判成缺陷。
  const missingAr = db
    .prepare(
      `SELECT v.id, v.doc_no FROM sales_invoices v
       WHERE v.status='confirmed' AND v.invoice_type='normal' AND v.total_amount > 0.005
         AND NOT EXISTS (SELECT 1 FROM invoice_ar_links l WHERE l.invoice_id = v.id)`
    )
    .all()
  const orphanLinks = db
    .prepare(
      `SELECT l.id FROM invoice_ar_links l
       LEFT JOIN sales_invoices v ON v.id = l.invoice_id
       LEFT JOIN ar_documents d ON d.id = l.ar_id
       WHERE v.id IS NULL OR d.id IS NULL`
    )
    .all()
  const badClose = db
    .prepare(
      `SELECT d.id, d.doc_no, d.invoice_status, d.invoice_qty_sum,
              IFNULL((SELECT SUM(sii.qty) FROM sales_invoice_items sii
                      JOIN sales_invoices si ON si.id=sii.invoice_id
                      WHERE sii.source_delivery_id=d.id AND si.status='confirmed' AND si.invoice_type='normal'),0) AS real_qty
       FROM sales_deliveries d`
    )
    .all()
    .filter((r) => Math.abs(money(r.real_qty) - money(r.invoice_qty_sum)) > 0.01)
  return {
    headDrift,
    overQty,
    missingAr,
    orphanLinks,
    badClose,
    ok: !headDrift.length && !overQty.length && !missingAr.length && !orphanLinks.length && !badClose.length
  }
}

export default {
  InvoiceError,
  createInvoiceFromDelivery,
  createManualInvoice,
  submitInvoice,
  confirmInvoice,
  redChartInvoice,
  voidInvoice,
  refreshCloseStatus,
  pendingLinesOfDelivery,
  pendingDeliveries,
  listInvoices,
  getInvoice,
  invoiceOverview,
  auditInvoice,
  SI_STATUS_LABEL,
  INVOICE_STATUS_LABEL
}
