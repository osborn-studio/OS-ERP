/**
 * ============================================================================
 * 文件标识：server/lib/purchase.js ｜ 采购域服务层（模块 07）
 * ============================================================================
 * 【职责】采购域服务层（模块 07）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 采购域服务层（模块 07）
//
// 现状与缺口：
//   改造前采购只做到「收货」——订单、到货、退货三张单，货到了就结束了。
//   但采购真正的问题在后面半段：**这票货到底该付多少钱、付了没有**。
//   本模块补齐前段（请购）与后段（发票 → 结算 → 付款），让主链路闭合成 9 个环节。
//
// 三条口径，写在最前面，后面所有函数都服从它：
//   ① 取价有链、不能拍脑袋 —— 协议价 → 该供应商最近成交价 → 历史订单价 → 标准成本，
//      并且**每一档都要说明来源**（界面上要能回答「为什么是这个价」）。
//   ② 结算以票为准、差异显性 —— settle_amount 按发票算，diff_amount = 入库暂估 − 发票，
//      差异不隐藏、不自动抹平，交存货核算（模块 09）处理。
//   ③ 付款以核销明细为准 —— paid_amount 只是快照，权威值是 SUM(purchase_payment_items.amount)。
//      同订货中心的授信口径：**单头上的汇总数永远是可以被明细推翻的缓存**。

import { nextDocNoByRule, nextDocNoAuto, nextBatchNo } from './docno.js'
import { applyTransition, allowedActions, logEvent, DocFlowError, claimTransitionEffect, assertEdgePermitted } from './docflow.js'
import { applyStockIn, applyStockOut } from './stock.js'
import { localDate, localNow } from './dates.js'
// 金额/数量的**唯一校验器**（与 HTTP 入口、MCP 入口同一个）。
// 为什么服务层要 import 中间件：这两个校验器住在 `middleware/auth.js`，
// 而"同一份判据只有一个实现"是铁律 —— 与其在 lib 里再写一遍下界/小数位，
// 不如让 lib 直接用那一份（依赖方向 lib → middleware 无环：auth.js 只依赖 db 与 lib/http）。
import { numQty, numAmount, numField, hasPerm } from '../middleware/auth.js'
// 「这个仓还能不能用」+「这类单据允许用哪些仓」的**唯一判据**（`lib/warehouse.js`）。
// 为什么拦在服务层而不是 HTTP 路由：采购单有**两个建单入口**（后台路由 + MCP 工具
// `purchase.create_order`），它们都调 `createPurchaseOrder`。判据写两份的下场是本项目
// 踩过的老账 —— "漏了一个入口"。拦在服务层 ⇒ 两个入口同时生效。
// 为什么必须拦：仓库现在可以**停用**（见 `routes/warehouses.js`）。停用意味着
// "这个仓不再收新单"，而它原来只体现在界面下拉里 —— 直接打接口照样建得出来。
// 第二条（允许仓库白名单）是最高层设计 §7.1 的口径：默认 `*` = 不限，与上线前逐条一致。
import { assertWarehouseUsable, assertWarehouseAllowedForDoc } from './warehouse.js'
// 配置的唯一出处（`SETTING_RULES`）。本模块只读一个键：`purchase_return_offset`
// （采购退货是否抵减结算）。为什么不把默认值抄一份到这里：抄一份 = 两个默认值，
// 改配置中心不生效、改代码不生效，而它管的是**应付金额**。
// 读未登记的键会抛 `SETTING_UNKNOWN`（宁可炸，也不要安静地用某个默认值）——
// 这正是三个"幽灵配置"的成因。
import { readSetting } from './settings.js'

const nowStr = () => localNow()
// 业务日一律走 dates.js 的本地口径。原来是 `toISOString()` 截取 —— UTC 日期，
// 东八区本地 00:00–08:00 之间会把「今天」的采购单 / 入库单 / 发票 / 付款单记成昨天，
// 单号里的日期段也跟着错一天（不报错，只是账期与对账周期整体偏移）。
const ymd = (d = new Date()) => localDate(d)
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000

export class PurchaseError extends Error {
  constructor(message, { code = 'PURCHASE_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'PurchaseError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 一、取价：三种用友口径（价格表 / 最新采购价 / 手工录入）
// ---------------------------------------------------------------------------

/**
 * 采购取价链。返回 { price, source, sourceLabel, detail } —— 必须带来源，
 * 否则界面上出现一个数字没人知道它从哪来，出问题只能靠猜。
 *
 * @param {object} p { skuId, supplierId, qty, at, manualPrice }
 *   manualPrice 传了就直通（用友的「手工录入」取价方式）
 */
export function resolvePurchasePrice(db, p = {}) {
  const { skuId, supplierId, manualPrice } = p
  if (manualPrice != null && Number(manualPrice) > 0) {
    return { price: round2(manualPrice), source: 'manual', sourceLabel: '手工录入', detail: null }
  }
  if (!skuId) throw new PurchaseError('取价缺少 skuId', { code: 'PRICE_NO_SKU' })
  const at = p.at ? ymd(p.at) : ymd(new Date())

  // ① 供货目录协议价（价格表；带有效期校验）
  if (supplierId) {
    const sp = db
      .prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND sku_id=?')
      .get(supplierId, skuId)
    if (sp && sp.price != null && Number(sp.price) > 0) {
      const fromOk = !sp.valid_from || sp.valid_from <= at
      const toOk = !sp.valid_to || sp.valid_to >= at
      if (fromOk && toOk) {
        return {
          price: round2(sp.price),
          source: 'agreement',
          sourceLabel: '供货目录协议价',
          detail: { supplier_id: supplierId, valid_from: sp.valid_from, valid_to: sp.valid_to }
        }
      }
    }
    // ② 该供应商对该 SKU 的最近成交价（收货时回写）
    if (sp && sp.last_price != null && Number(sp.last_price) > 0) {
      return {
        price: round2(sp.last_price),
        source: 'last_deal',
        sourceLabel: '该供应商最近成交价',
        detail: { supplier_id: supplierId, last_price_date: sp.last_price_date }
      }
    }
    // ③ 历史采购订单里最近一次该供应商 + 该 SKU 的价
    const hist = db
      .prepare(
        `SELECT oi.price, o.order_date, o.doc_no
           FROM purchase_order_items oi
           JOIN purchase_orders o ON o.id = oi.order_id
          WHERE o.supplier_id=? AND oi.sku_id=? AND oi.price > 0
            AND o.status NOT IN ('cancelled')
          ORDER BY o.order_date DESC, oi.id DESC LIMIT 1`
      )
      .get(supplierId, skuId)
    if (hist) {
      return {
        price: round2(hist.price),
        source: 'last_order',
        sourceLabel: '最近采购订单价',
        detail: { doc_no: hist.doc_no, order_date: hist.order_date }
      }
    }
  }

  // ④ 标准成本兜底
  const sku = db.prepare('SELECT sku_code, cost_std, product_id FROM product_skus WHERE id=?').get(skuId)
  const prod = sku?.product_id
    ? db.prepare('SELECT cost_std FROM products WHERE id=?').get(sku.product_id)
    : null
  const fallback = Number(sku?.cost_std || prod?.cost_std || 0)
  return {
    price: round2(fallback),
    source: 'cost_std',
    sourceLabel: '标准成本',
    detail: { sku_code: sku?.sku_code || null }
  }
}

/** 批量取价：一次查完供货目录，避免逐行 N+1 */
export function resolvePurchasePrices(db, { lines = [], supplierId, at, manual }) {
  const atDate = at ? ymd(at) : ymd(new Date())
  const cat = new Map()
  if (supplierId) {
    const rows = db
      .prepare(
        `SELECT sp.* FROM supplier_products sp
          JOIN product_skus s ON s.id = sp.sku_id
         WHERE sp.supplier_id=?`
      )
      .all(supplierId)
    for (const r of rows) cat.set(r.sku_id, r)
  }
  return lines.map((ln) => {
    const m = manual && manual[ln.sku_id]
    const r = resolvePurchasePrice(db, {
      skuId: ln.sku_id,
      supplierId,
      qty: ln.qty,
      at: atDate,
      manualPrice: m != null ? m : ln.price
    })
    const sp = cat.get(ln.sku_id)
    const moq = sp ? Number(sp.min_order_qty || 0) : 0
    return {
      ...ln,
      price: r.price,
      amount: round2(r.price * (Number(ln.qty) || 0)),
      price_source: r.source,
      price_source_label: r.sourceLabel,
      price_detail: r.detail,
      catalog: sp
        ? { registered: true, available: !!sp.is_available, min_order_qty: moq, lead_time_days: sp.lead_time_days || 0 }
        : { registered: false, available: true, min_order_qty: 0, lead_time_days: 0 }
    }
  })
}

/** 供货目录校验：明确不可供 / 低于最小起订量 */
export function checkSupplyCatalog(db, { supplierId, lines = [] }) {
  if (!supplierId) return []
  const issues = []
  const get = db.prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND sku_id=?')
  for (const ln of lines) {
    const sp = get.get(supplierId, ln.sku_id)
    if (!sp) continue // 未维护目录不拦（见 011 建表注释）
    if (!sp.is_available) {
      issues.push({
        sku_id: ln.sku_id,
        code: 'NOT_SUPPLIED',
        level: 'block',
        message: '该供应商供货目录标记为不供此商品'
      })
    }
    const moq = Number(sp.min_order_qty || 0)
    if (moq > 0 && Number(ln.qty || 0) < moq) {
      issues.push({
        sku_id: ln.sku_id,
        code: 'BELOW_MOQ',
        level: 'block',
        message: `低于最小起订量 ${moq}`,
        detail: { moq, qty: ln.qty }
      })
    }
  }
  return issues
}

/** 收货回写最近成交价（用友「最新采购价」的数据来源） */
export function touchSupplierLastPrice(db, { supplierId, skuId, price, docNo, operator }) {
  if (!supplierId || !skuId || !(Number(price) > 0)) return null
  const exist = db.prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND sku_id=?').get(supplierId, skuId)
  const today = ymd(new Date())
  if (!exist) {
    db.prepare(
      `INSERT INTO supplier_products (supplier_id, sku_id, price, last_price, last_price_date, remark)
       VALUES (?,?,NULL,?,?, '收货自动建立')`
    ).run(supplierId, skuId, round2(price), today)
    return { created: true }
  }
  const old = exist.last_price
  db.prepare(
    'UPDATE supplier_products SET last_price=?, last_price_date=?, updated_at=? WHERE id=?'
  ).run(round2(price), today, nowStr(), exist.id)
  // 协议价不变，只动 last_price —— 不动 price 是有意的：
  // 协议价是谈出来的，不能被一次收货悄悄改掉
  return { created: false, old, now: round2(price) }
}

/** 人工维护供货目录/协议价：写价改日志（对齐模块 05A 的调价留痕） */
export function upsertSupplierProduct(db, { supplierId, skuId, patch = {}, operator }) {
  if (!supplierId || !skuId) {
    throw new PurchaseError('供货目录缺少供应商或商品', { code: 'CATALOG_KEY_MISSING' })
  }
  const exist = db.prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND sku_id=?').get(supplierId, skuId)
  const fields = ['is_available', 'price', 'currency', 'min_order_qty', 'lead_time_days', 'valid_from', 'valid_to', 'remark']
  const cols = fields.filter((f) => patch[f] !== undefined)
  if (!exist) {
    const ins = [
      supplierId,
      skuId,
      patch.is_available === undefined ? 1 : patch.is_available ? 1 : 0,
      patch.price ?? null,
      patch.currency || 'CNY',
      patch.min_order_qty || 0,
      patch.lead_time_days || 0,
      patch.valid_from || null,
      patch.valid_to || null,
      patch.remark || null
    ]
    db.prepare(
      `INSERT INTO supplier_products
         (supplier_id,sku_id,is_available,price,currency,min_order_qty,lead_time_days,valid_from,valid_to,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(...ins)
  } else if (cols.length) {
    db.prepare(
      `UPDATE supplier_products SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`
    ).run(...cols.map((c) => patch[c]), nowStr(), exist.id)
  }
  if (patch.price !== undefined && Number(patch.price) !== Number(exist?.price ?? NaN)) {
    db.prepare(
      `INSERT INTO supplier_price_logs (supplier_id,sku_id,old_price,new_price,source,operator,remark)
       VALUES (?,?,?,?,'manual',?,?)`
    ).run(supplierId, skuId, exist?.price ?? null, patch.price, operator || null, patch.remark || null)
  }
  return db.prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND sku_id=?').get(supplierId, skuId)
}

// ---------------------------------------------------------------------------
// 二、超量控制与四段关闭
// ---------------------------------------------------------------------------

/**
 * 超量校验。用友口径：超量控制 + 超上限比例。
 * 允许收货量 = 订单量 × (1 + over_receive_ratio)，比例 0 即不允许超收。
 *
 * **按明细行判，不按 SKU 判**。原来 `SELECT ... WHERE order_id=? AND sku_id=?` 取到的
 * 是同一 SKU 的**第一行**：一张订单若有两行同 SKU（不同交期 / 不同价），
 * 收第二批货时会拿第一行的 `qty/received_qty` 去判 —— 明明还剩额度却被判「超收」，
 * 或者反过来，第一行收满了就给第二行放行。同一个 SKU 的额度必须按**行**各算各的。
 *
 * 行的定位优先级：`id` / `order_item_id`（明确指到某一行） > 只有 sku_id。
 * 只给 sku_id 且该 SKU 在订单里只有一行时行为与从前完全一致；
 * 有多行时**按这些行的合计**判（"没说要哪一行"就只能当整体），不再取第一行。
 */
export function checkOverReceive(db, { orderId, lines = [] }) {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(orderId)
  if (!order) throw new PurchaseError('采购订单不存在', { code: 'PO_NOT_FOUND', httpStatus: 404 })
  const ratio = Number(order.over_receive_ratio ?? 0.1)
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY id').all(orderId)
  const byId = new Map(items.map((i) => [Number(i.id), i]))
  const bySku = new Map()
  for (const i of items) {
    const k = Number(i.sku_id)
    if (!bySku.has(k)) bySku.set(k, [])
    bySku.get(k).push(i)
  }

  const issues = []
  // 同一次请求里同一行（或同一 SKU）分多条传入时，要先归集再判 ——
  // 否则两条各 6 的量会被各自当成"只收 6"，合起来超了却看不出来。
  const buckets = new Map()
  for (const ln of lines) {
    const lineId = ln.id != null ? Number(ln.id) : ln.order_item_id != null ? Number(ln.order_item_id) : null
    let it = null
    let key = null
    if (lineId != null) {
      it = byId.get(lineId) || null
      key = `id:${lineId}`
    } else {
      const grp = bySku.get(Number(ln.sku_id)) || []
      if (grp.length === 1) {
        it = grp[0]
        key = `id:${it.id}`
      } else if (grp.length > 1) {
        // 同 SKU 多行且未指明行号：按这些行的合计口径判（取某一行是 bug）
        it = {
          id: null,
          sku_id: ln.sku_id,
          qty: grp.reduce((s, x) => s + Number(x.qty || 0), 0),
          received_qty: grp.reduce((s, x) => s + Number(x.received_qty || 0), 0),
          aggregated: true
        }
        key = `sku:${ln.sku_id}`
      }
    }
    if (!it) {
      issues.push({
        sku_id: ln.sku_id,
        code: 'NOT_IN_ORDER',
        level: 'block',
        message: '该商品不在本采购订单内，不能收货'
      })
      continue
    }
    const b = buckets.get(key) || { it, qty: 0 }
    b.qty += Number(ln.qty || 0)
    buckets.set(key, b)
  }

  for (const { it, qty } of buckets.values()) {
    const allowed = Number(it.qty || 0) * (1 + ratio)
    const after = Number(it.received_qty || 0) + qty
    if (after > allowed + 1e-6) {
      issues.push({
        sku_id: it.sku_id,
        code: 'OVER_RECEIVE',
        level: 'block',
        message: `超出可收货上限（订单行 ${it.qty}，上限比例 ${(ratio * 100).toFixed(0)}%，本次收货后 ${after.toFixed(2)}）`,
        detail: { order_item_id: it.id, ordered: it.qty, ratio, already: it.received_qty, this_time: qty, allowed }
      })
    }
  }
  return issues
}

/**
 * 刷新四段关闭。用友口径：到货关闭 / 入库关闭 / 开票关闭 / 付款关闭。
 * 这里做**自动推导**：条件满足即置 1，且**只进不退**（关闭是单向动作，
 * 一旦关了不能因为后来改了单据又自动打开 —— 那会让已经停止的业务重新流动）。
 */
export function refreshCloseFlags(db, orderId) {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(orderId)
  if (!order) return null
  const items = db.prepare('SELECT qty, received_qty FROM purchase_order_items WHERE order_id=?').all(orderId)
  const orderedQty = items.reduce((s, i) => s + Number(i.qty || 0), 0)
  const receivedQty = items.reduce((s, i) => s + Number(i.received_qty || 0), 0)
  const allReceived = orderedQty > 0 && items.every((i) => Number(i.received_qty || 0) + 1e-6 >= Number(i.qty || 0))

  const rcCount = db.prepare('SELECT COUNT(*) c FROM purchase_receipts WHERE order_id=?').get(orderId).c
  const closedRc = db
    .prepare("SELECT COUNT(*) c FROM purchase_receipts WHERE order_id=? AND status='closed'")
    .get(orderId).c

  const invoiceAmount = Number(order.invoice_amount || 0)
  const totalAmount = Number(order.total_amount || 0)
  const settleAmount = Number(order.settle_amount || 0)
  const paidAmount = Number(order.paid_amount || 0)

  const next = {
    close_arrival: order.close_arrival || (allReceived ? 1 : 0),
    close_inbound: order.close_inbound || (rcCount > 0 && closedRc === rcCount ? 1 : 0),
    close_invoice: order.close_invoice || (totalAmount > 0 && invoiceAmount + 1e-6 >= totalAmount ? 1 : 0),
    close_payment: order.close_payment || (settleAmount > 0 && paidAmount + 1e-6 >= settleAmount ? 1 : 0)
  }
  const changed =
    next.close_arrival !== order.close_arrival ||
    next.close_inbound !== order.close_inbound ||
    next.close_invoice !== order.close_invoice ||
    next.close_payment !== order.close_payment
  if (changed) {
    db.prepare(
      `UPDATE purchase_orders
          SET close_arrival=?, close_inbound=?, close_invoice=?, close_payment=?, updated_at=?
        WHERE id=?`
    ).run(
      next.close_arrival,
      next.close_inbound,
      next.close_invoice,
      next.close_payment,
      nowStr(),
      orderId
    )
  }
  return { ...next, ordered_qty: orderedQty, received_qty: receivedQty, all_received: allReceived, receipts: rcCount }
}

/**
 * 回写采购订单的三个金额快照：已开票 / 已结算 / 已付款。
 * 已付款按「该订单在某结算单中的入库金额占比」分摊 —— 这是**分摊口径**，
 * 不是逐票对应；订单与付款之间没有直接外键，只能按金额占比推。
 */
export function refreshOrderStats(db, orderId) {
  const invoiceAmount = db
    .prepare(
      `SELECT COALESCE(SUM(ii.amount),0) s
         FROM purchase_invoice_items ii
         JOIN purchase_invoices i ON i.id = ii.invoice_id
         JOIN purchase_order_items oi ON oi.id = ii.order_item_id
        WHERE oi.order_id=? AND i.status NOT IN ('voided')`
    )
    .get(orderId).s

  const settleAmount = db
    .prepare(
      `SELECT COALESCE(SUM(si.amount),0) s
         FROM purchase_settlement_items si
         JOIN purchase_settlements st ON st.id = si.settle_id
         JOIN purchase_receipts rc ON rc.id = si.source_id
        WHERE si.source_type='receipt' AND rc.order_id=? AND st.status NOT IN ('voided')`
    )
    .get(orderId).s

  // 已付款：遍历涉及本订单的结算单，按入库金额占比分摊
  const settles = db
    .prepare(
      `SELECT DISTINCT st.id, st.doc_no, st.receipt_amount, st.paid_amount
         FROM purchase_settlements st
         JOIN purchase_settlement_items si ON si.settle_id = st.id AND si.source_type='receipt'
         JOIN purchase_receipts rc ON rc.id = si.source_id
        WHERE rc.order_id=? AND st.status NOT IN ('voided')`
    )
    .all(orderId)
  let paidAmount = 0
  for (const s of settles) {
    const mine = db
      .prepare(
        `SELECT COALESCE(SUM(si.amount),0) s
           FROM purchase_settlement_items si
           JOIN purchase_receipts rc ON rc.id = si.source_id
          WHERE si.settle_id=? AND si.source_type='receipt' AND rc.order_id=?`
      )
      .get(s.id, orderId).s
    const base = Number(s.receipt_amount || 0)
    if (base > 0) paidAmount += (Number(s.paid_amount || 0) * Number(mine)) / base
  }

  db.prepare(
    'UPDATE purchase_orders SET invoice_amount=?, settle_amount=?, paid_amount=?, updated_at=? WHERE id=?'
  ).run(round2(invoiceAmount), round2(settleAmount), round2(paidAmount), nowStr(), orderId)
  return { invoice_amount: round2(invoiceAmount), settle_amount: round2(settleAmount), paid_amount: round2(paidAmount) }
}

// ---------------------------------------------------------------------------
// 三、请购单
// ---------------------------------------------------------------------------

function docNo(db, docType, bizDate) {
  return nextDocNoByRule(db, { docType, bizDate: bizDate ? ymd(bizDate) : ymd(new Date()) })
}

/** 建请购单（草稿）。lines: [{ sku_id, qty, price?, need_date?, purpose? }] */
export function createRequisition(db, req = {}) {
  const {
    orgId = null, warehouseId = null, supplierId = null,
    reqDate = ymd(new Date()), expectDate = null,
    applicantType = 'org', applicantId = null, applicantName = null,
    department = null, purpose = null, urgency = 'normal', tradeType = 'normal',
    budgetAmount = null, source = 'manual', sourceRef = null, remark = null,
    actor = {}, lines = []
  } = req
  if (!lines.length) throw new PurchaseError('请购单至少需要一行明细', { code: 'PRQ_NO_LINES' })

  const no = docNo(db, 'PRQ', reqDate)
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO purchase_requisitions
           (doc_no,org_id,trade_type,req_date,expect_date,warehouse_id,supplier_id,
            applicant_type,applicant_id,applicant_name,department,purpose,urgency,status,
            total_qty,total_amount,budget_amount,source,source_ref,remark,
            created_by,created_by_name,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',0,0,?,?,?,?,?,?,?)`
      )
      .run(
        no, orgId, tradeType, ymd(reqDate), expectDate ? ymd(expectDate) : null,
        warehouseId, supplierId, applicantType, applicantId, applicantName,
        department, purpose, urgency, budgetAmount, source, sourceRef, remark,
        actor.id || null, actor.name || null, nowStr()
      )
    const rid = res.lastInsertRowid
    const insItem = db.prepare(
      `INSERT INTO purchase_requisition_items (req_id,line_no,sku_id,qty,price,amount,need_date,purpose,remark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    let qty = 0
    let amount = 0
    lines.forEach((ln, i) => {
      const price = Number(ln.price || 0)
      const q = Number(ln.qty || 0)
      qty += q
      amount += price * q
      insItem.run(
        rid, i + 1, ln.sku_id, q, price, round2(price * q),
        ln.need_date ? ymd(ln.need_date) : null, ln.purpose || null, ln.remark || null
      )
    })
    db.prepare('UPDATE purchase_requisitions SET total_qty=?, total_amount=? WHERE id=?').run(
      round2(qty), round2(amount), rid
    )
    return rid
  })
  const id = tx()
  return getRequisition(db, id)
}

export function getRequisition(db, id) {
  const head = db.prepare('SELECT * FROM purchase_requisitions WHERE id=?').get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT ri.*, s.sku_code, s.name AS sku_name, p.name AS product_name, p.unit
         FROM purchase_requisition_items ri
         LEFT JOIN product_skus s ON s.id = ri.sku_id
         LEFT JOIN products p ON p.id = s.product_id
        WHERE ri.req_id=? ORDER BY ri.line_no`
    )
    .all(id)
  return { ...head, items }
}

/** 请购单列表；`q.orgScope` 走 `purchaseScopeSql`（ADR-0017），不传 ⇒ 全库（lib 内部 / 脚本口径）。 */
export function listRequisitions(db, q = {}) {
  const scope = purchaseScopeSql(q.orgScope || null, 'r')
  const cond = [scope.org]
  const args = [...scope.params]
  if (q.status) { cond.push('r.status=?'); args.push(q.status) }
  if (q.applicant_type) { cond.push('r.applicant_type=?'); args.push(q.applicant_type) }
  if (q.applicant_id) { cond.push('r.applicant_id=?'); args.push(q.applicant_id) }
  if (q.keyword) {
    cond.push('(r.doc_no LIKE ? OR r.applicant_name LIKE ? OR r.department LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k, k)
  }
  const where = `WHERE ${cond.join(' AND ')}`
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM purchase_requisition_items i WHERE i.req_id=r.id) AS line_count
         FROM purchase_requisitions r ${where}
        ORDER BY r.id DESC LIMIT ?`
    )
    .all(...args, q.limit || 200)
}

/**
 * 请购单流转。走内核 applyTransition —— 不在路由里手写状态判断。
 */
export function transitionRequisition(db, { id, action, actor = {}, set = {}, remark = null, source = 'api' }) {
  const head = db.prepare('SELECT * FROM purchase_requisitions WHERE id=?').get(id)
  if (!head) throw new PurchaseError('请购单不存在', { code: 'PRQ_NOT_FOUND', httpStatus: 404 })
  // `convert` **只能走带参数的正门**：转单必须知道"转到哪张订单、转哪些行、哪个供应商/仓"，
  // 而 `convertRequisitionToOrder` 会强制校验这三个前提。只带 (doc_type,id,action) 的
  // 简化入口把状态改成 `converted` 却一张 PO 都不生成 —— 典型「状态对了、账不对」
  // （验收侧 §23.3 实测残留：请购单显示已转单，`purchase_orders` 里查不到）。
  //
  // 判据**只有一份**：`assertNotParamOnly`（本文件，见「九、采购订单与收货」之前的定义）。
  // HTTP（本文件）、MCP（`mcp/tools.js`）、通用流转入口三条路都调它 ——
  // 于是同一个动作在哪条路上被拒，**码与文案逐字相同**。
  assertNotParamOnly('PRQ', action)
  const extra = { ...set }
  if (action === 'approve') {
    extra.approved_by = actor.id || null
    extra.approved_by_name = actor.name || null
    extra.approved_at = nowStr()
  }
  if (action === 'reject') extra.reason = remark || null
  return applyTransition({
    db, docType: 'PRQ', id, action, actor: { id: actor.id, name: actor.name },
    set: extra, remark, source
  })
}

/**
 * 请购单转采购订单。
 * 支持**部分转单**：请求里给 lines 就只转这些行（每条数量），
 * 全部转完后请购单才可以 close —— 这是 PRQ.converted 不标终态的原因。
 */
export function convertRequisitionToOrder(db, { reqId, lines = null, supplierId = null, warehouseId = null, actor = {}, remark = null }) {
  const req = getRequisition(db, reqId)
  if (!req) throw new PurchaseError('请购单不存在', { code: 'PRQ_NOT_FOUND', httpStatus: 404 })
  if (!['approved', 'converted'].includes(req.status)) {
    throw new PurchaseError(`状态「${req.status}」不能转采购订单，请先审批`, {
      code: 'PRQ_NOT_APPROVED', httpStatus: 409
    })
  }
  const sup = supplierId || req.supplier_id
  if (!sup) throw new PurchaseError('转采购订单需要指定供应商', { code: 'PO_SUPPLIER_REQUIRED', httpStatus: 400 })
  const wh = warehouseId || req.warehouse_id
  if (!wh) throw new PurchaseError('转采购订单需要指定入库仓', { code: 'PO_WAREHOUSE_REQUIRED', httpStatus: 400 })
  const whRow = assertWarehouseUsable(db, wh, { role: '入库仓', required: true })
  assertWarehouseAllowedForDoc(db, { docType: 'PUR_IN', warehouse: whRow, role: '入库仓' })

  // 可转数量按**明细行**归集。
  //
  // 为什么不能按 sku_id 归集（原来就是这么写的，是个真 bug）：
  //   一张请购单里同一个 SKU 出现两行（不同交期 / 不同用途）是常态。按 SKU 建 Map 时，
  //   两行共用一个键，转 10 件会被**每一行都套一遍** —— 实际生成 20 件的采购订单，
  //   而界面上看到的是"我明明只转 10"。多出来的 10 件没有任何地方会报错。
  //   所以：一行对一行，`lines` 里可指名 `id` / `req_item_id` / `order_item_id`；
  //   只给 `sku_id` 时按该 SKU 的行顺序依次摊分（与从前"按 SKU 需求转"的语义一致，
  //   只是分配到了具体的行上）。
  const leftByItem = new Map(req.items.map((it) => [Number(it.id), Number(it.qty || 0) - Number(it.converted_qty || 0)]))
  const byItemId = new Map(req.items.map((it) => [Number(it.id), it]))
  const itemsBySku = new Map()
  for (const it of req.items) {
    const k = Number(it.sku_id)
    if (!itemsBySku.has(k)) itemsBySku.set(k, [])
    itemsBySku.get(k).push(it)
  }
  const pickedByItem = new Map()
  const takeFrom = (it, want) => {
    const left = leftByItem.get(Number(it.id)) || 0
    const q = Math.min(want, left)
    if (q > 1e-9) {
      leftByItem.set(Number(it.id), left - q)
      const prev = pickedByItem.get(Number(it.id))
      if (prev) prev.qty = round4(prev.qty + q)
      else pickedByItem.set(Number(it.id), { req_item_id: it.id, sku_id: it.sku_id, qty: round4(q), price: it.price })
    }
    return want - q
  }
  if (lines && lines.length) {
    for (const l of lines) {
      let want = Number(l.qty || 0)
      if (!(want > 0)) continue
      const lineId = l.id != null ? Number(l.id) : l.req_item_id != null ? Number(l.req_item_id) : l.order_item_id != null ? Number(l.order_item_id) : null
      if (lineId != null) {
        const it = byItemId.get(lineId)
        if (!it) throw new PurchaseError(`请购明细行 #${lineId} 不属于本请购单`, { code: 'PRQ_LINE_NOT_FOUND', httpStatus: 404 })
        takeFrom(it, want)
      } else {
        // 只给 SKU：按该 SKU 的行顺序依次摊分，每行只吃到自己的剩余量
        const grp = itemsBySku.get(Number(l.sku_id)) || []
        for (const it of grp) {
          if (want <= 1e-9) break
          want = takeFrom(it, want)
        }
      }
    }
  } else {
    for (const it of req.items) takeFrom(it, Number.POSITIVE_INFINITY)
  }
  const picked = [...pickedByItem.values()].filter((p) => p.qty > 0)
  if (!picked.length) {
    throw new PurchaseError('没有可转的明细行（可能已全部转单）', { code: 'PRQ_NOTHING_TO_CONVERT', httpStatus: 409 })
  }

  const check = checkSupplyCatalog(db, { supplierId: sup, lines: picked })
  const blocking = check.filter((i) => i.level === 'block')
  if (blocking.length) {
    throw new PurchaseError(blocking[0].message, {
      code: 'SUPPLY_CATALOG_BLOCKED', httpStatus: 409, detail: blocking
    })
  }

  const orderDate = ymd(new Date())
  const poNo = docNo(db, 'PO', orderDate)
  const expect = req.expect_date || (req.items.find((i) => i.need_date)?.need_date ?? null)
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO purchase_orders
           (doc_no,supplier_id,warehouse_id,order_date,expect_date,buyer,status,
            total_qty,total_amount,tax_amount,settle_type,fulfill_type,
            source_type,source_req_id,source_req_no,req_id,trade_type,remark,created_by,created_at)
         VALUES (?,?,?,?,?,?,'draft',0,0,0,?,?, 'requisition',?,?,?,?,?,?,?)`
      )
      .run(
        poNo, sup, wh, orderDate, expect, actor.name || null,
        null, 'hq', req.id, req.doc_no, req.id, req.trade_type === 'store' ? 'normal' : 'normal',
        `由请购单 ${req.doc_no} 转入${remark ? ' · ' + remark : ''}`, actor.id || null, nowStr()
      )
    const poId = res.lastInsertRowid
    const insItem = db.prepare(
      `INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount,received_qty,remark)
       VALUES (?,?,?,?,13,?,0,?)`
    )
    let qty = 0
    let amount = 0
    for (const p of picked) {
      qty += p.qty
      amount += p.qty * Number(p.price || 0)
      insItem.run(poId, p.sku_id, p.qty, Number(p.price || 0), round2(p.qty * Number(p.price || 0)),
        `请购行 #${p.req_item_id}`)
      db.prepare(
        'UPDATE purchase_requisition_items SET converted_qty = converted_qty + ? WHERE id=?'
      ).run(p.qty, p.req_item_id)
    }
    db.prepare('UPDATE purchase_orders SET total_qty=?, total_amount=? WHERE id=?').run(
      round2(qty), round2(amount), poId
    )
    return poId
  })
  const poId = tx()

  // 转单留痕 + 状态推进（已转单）
  const remaining = db
    .prepare('SELECT COUNT(*) c FROM purchase_requisition_items WHERE req_id=? AND converted_qty + 1e-6 < qty')
    .get(req.id).c
  if (req.status === 'approved') {
    applyTransition({
      db, docType: 'PRQ', id: req.id, action: 'convert',
      actor: { id: actor.id, name: actor.name },
      set: { converted_order_id: poId, converted_order_no: poNo, converted_at: nowStr() },
      remark: `转采购订单 ${poNo}`, source: 'api',
      payload: { order_id: poId, order_no: poNo, lines: picked.length }
    })
  } else {
    // 已转过一次，这次**只补留痕**（状态停在 converted，不发生流转）
    db.prepare(
      'UPDATE purchase_requisitions SET converted_order_id=?, converted_order_no=?, converted_at=?, updated_at=? WHERE id=?'
    ).run(poId, poNo, nowStr(), nowStr(), req.id)
    logEvent({
      db,
      docType: 'PRQ',
      id: req.id,
      docNo: req.doc_no,
      action: 'convert',
      actionName: '再次转采购订单',
      // ⚠️ `from: null` —— **这里没有发生过一次流转**：状态本来就停在 `converted`（幂等重放：
      //    同一张请购单又点了一次"转采购订单"，本次只新建了一张 PO 并补登记）。
      //    原来写的是 `from: 'converted'` / `to: 'converted'`，那是个**自环**，而 `ACTIONS.PRQ`
      //    里没有这条边（只有 `approved→converted` / `submitted→converted`）⇒ 痕迹在**说谎**：
      //    时间线上看起来"发生了一次流转"，而内核根本没有这条边。
      //    口径与 `lib/ar.js` 的 `traceRecalc` 一致：**"是谁触发了这次重放"记进 payload，`from` 留空**
      //    （不给内核补自环边 —— 那是为了让一句假话成立而去改定义）。
      //    判据：`scripts/check-doc-events-edges.mjs`（from 非空 ⇒ (from,to) 必须是内核注册过的边）。
      from: null,
      to: 'converted',
      actor: { id: actor.id, name: actor.name },
      source: 'api',
      remark: `再次转采购订单 ${poNo}（幂等重放：状态仍为已转单，未发生流转）`,
      payload: { order_id: poId, order_no: poNo, replay: true, already_converted: true, status_unchanged: 'converted' }
    })
  }
  return { order_id: poId, order_no: poNo, remaining_lines: remaining, converted_lines: picked.length }
}

// ---------------------------------------------------------------------------
// 四、采购发票
// ---------------------------------------------------------------------------

export function createInvoice(db, inv = {}) {
  const {
    invoiceNo = null, invoiceType = 'vat_special', supplierId, orgId = null,
    orderId = null, receiptId = null, invoiceDate = ymd(new Date()),
    currency = 'CNY', taxRate = 13, remark = null, actor = {}, lines = []
  } = inv
  if (!supplierId) throw new PurchaseError('发票缺少供应商', { code: 'PI_NO_SUPPLIER' })
  if (!lines.length) throw new PurchaseError('发票至少需要一行明细', { code: 'PI_NO_LINES' })
  if (invoiceNo) {
    const dup = db
      .prepare("SELECT doc_no FROM purchase_invoices WHERE supplier_id=? AND invoice_no=? AND status<>'voided'")
      .get(supplierId, invoiceNo)
    if (dup) {
      throw new PurchaseError(`票号 ${invoiceNo} 在本供应商下已存在（${dup.doc_no}）`, {
        code: 'PI_DUPLICATE', httpStatus: 409
      })
    }
  }
  const no = docNo(db, 'PI', invoiceDate)
  // 表头 order_id 的推导：调用方没传时，从明细行的 order_item_id 反推。
  // 只有当全部明细行都指向**同一张订单**时才写表头 —— 一票多单时写哪一张都是错的，
  // 宁可为空也不给一个会误导人的关联。
  // （订单上的「已开票金额」走的是**明细行**关联，见 refreshOrderStats，不依赖表头。）
  let effOrderId = orderId || null
  if (!effOrderId) {
    const itemIds = [...new Set(lines.map((l) => l.order_item_id).filter(Boolean))]
    if (itemIds.length) {
      const ords = db
        .prepare(`SELECT DISTINCT order_id FROM purchase_order_items WHERE id IN (${itemIds.map(() => '?').join(',')})`)
        .all(...itemIds)
        .map((r) => r.order_id)
        .filter(Boolean)
      if (ords.length === 1) effOrderId = ords[0]
    }
  }
  const order = effOrderId ? db.prepare('SELECT doc_no FROM purchase_orders WHERE id=?').get(effOrderId) : null
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO purchase_invoices
           (doc_no,invoice_no,invoice_type,supplier_id,org_id,order_id,order_no,receipt_id,invoice_date,period,
            currency,amount,tax_rate,tax_amount,total_amount,status,remark,created_by,created_by_name,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,0,0,'draft',?,?,?,?)`
      )
      .run(
        no, invoiceNo, invoiceType, supplierId, orgId, effOrderId, order?.doc_no || null, receiptId,
        ymd(invoiceDate), ymd(invoiceDate).slice(0, 7), currency, taxRate, remark,
        actor.id || null, actor.name || null, nowStr()
      )
    const invId = res.lastInsertRowid
    const insItem = db.prepare(
      `INSERT INTO purchase_invoice_items
         (invoice_id,line_no,sku_id,order_item_id,receipt_id,qty,price,amount,tax_rate,tax_amount,total_amount,fee_type,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    let amount = 0
    let tax = 0
    lines.forEach((ln, i) => {
      const rate = Number(ln.tax_rate ?? taxRate)
      const amt = ln.amount != null ? Number(ln.amount) : round2(Number(ln.qty || 0) * Number(ln.price || 0))
      const t = round2((amt * rate) / 100)
      amount += amt
      tax += t
      insItem.run(
        invId, i + 1, ln.sku_id || null, ln.order_item_id || null, ln.receipt_id || null,
        Number(ln.qty || 0), Number(ln.price || 0), round2(amt), rate, t, round2(amt + t),
        ln.fee_type || null, ln.remark || null
      )
    })
    db.prepare(
      'UPDATE purchase_invoices SET amount=?, tax_amount=?, total_amount=? WHERE id=?'
    ).run(round2(amount), round2(tax), round2(amount + tax), invId)
    return invId
  })
  const id = tx()
  // 新票一旦落库就该立刻把涉及的订单「已开票金额」重算 ——
  // 否则订单上的 close_invoice 要等到下一次别的动作才被动更新，
  // 中间这段时间界面上会显示「已开票 0」与发票列表互相矛盾。
  for (const oid of invoiceOrderIds(db, id)) {
    refreshOrderStats(db, oid)
    refreshCloseFlags(db, oid)
  }
  return getInvoice(db, id)
}

/**
 * 一张发票牵涉到的全部采购订单 id。
 * 两个来源都要取：表头 order_id（调用方显式指定）+ 明细行 order_item_id 反推。
 * 一票多单时表头只能记一张，明细行的关联才是完整的 —— 只读表头会漏单。
 */
export function invoiceOrderIds(db, invoiceId) {
  const ids = new Set()
  const head = db.prepare('SELECT order_id FROM purchase_invoices WHERE id=?').get(invoiceId)
  if (head?.order_id) ids.add(head.order_id)
  const rows = db
    .prepare(
      `SELECT DISTINCT oi.order_id AS oid
         FROM purchase_invoice_items ii
         JOIN purchase_order_items oi ON oi.id = ii.order_item_id
        WHERE ii.invoice_id=?`
    )
    .all(invoiceId)
  for (const r of rows) if (r.oid) ids.add(r.oid)
  return [...ids]
}

export function getInvoice(db, id) {
  const head = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT ii.*, s.sku_code, s.name AS sku_name
         FROM purchase_invoice_items ii
         LEFT JOIN product_skus s ON s.id = ii.sku_id
        WHERE ii.invoice_id=? ORDER BY ii.line_no`
    )
    .all(id)
  const supplier = db.prepare('SELECT code,name FROM suppliers WHERE id=?').get(head.supplier_id)
  return { ...head, items, supplier }
}

export function transitionInvoice(db, { id, action, actor = {}, set = {}, remark = null, source = 'api' }) {
  const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(id)
  if (!inv) throw new PurchaseError('采购发票不存在', { code: 'PI_NOT_FOUND', httpStatus: 404 })
  const extra = { ...set }
  if (action === 'verify') {
    extra.verify_by = actor.id || null
    extra.verify_by_name = actor.name || null
    extra.verify_at = nowStr()
    // 校验发票行与入库行是否对得上（三单匹配的第一道闸）
    const mismatch = matchInvoiceToReceipts(db, id)
    if (mismatch.blocking.length) {
      throw new PurchaseError(mismatch.blocking[0].message, {
        code: 'PI_MATCH_FAILED', httpStatus: 409, detail: mismatch.blocking
      })
    }
    extra.remark = [inv.remark, mismatch.note].filter(Boolean).join(' | ') || null
  }
  const r = applyTransition({
    db, docType: 'PI', id, action, actor: { id: actor.id, name: actor.name },
    set: extra, remark, source
  })
  // 发票状态一变（提交 / 审核 / 入账 / 作废），涉及订单的「已开票金额」与「开票关闭」都要跟着重算。
  // 走 invoiceOrderIds（含明细行关联）而不是只看表头 order_id —— 一票多单时表头记不全。
  for (const oid of invoiceOrderIds(db, id)) {
    refreshOrderStats(db, oid)
    refreshCloseFlags(db, oid)
  }
  return r
}

/**
 * 发票与入库的三单匹配校验。
 * 口径：**发票数量不得超过已入库数量**（超开票需要人工特批），金额差异不拦、只记录。
 * 差异不拦是有意的 —— 发票与入库金额不一致是常态（运费、返利、价格调整），
 * 硬拦会让财务根本没法录票；差异的归宿是结算单的 diff_amount。
 *
 * **按订单行核对，不按 (供应商, SKU) 汇总**。原来的口径是"该供应商该 SKU 的**全部**入库
 * 减**全部**已开票"：同一供应商同一商品只要在别的订单上还有入库量，就能拿来给本单超开。
 * 实测：A 单入 100，A 的发票却能开 200（差额来自 B 单的入库量）。三单匹配的意义正是
 * "票对得上这一单的货"，按供应商汇总等于没有对上任何一单。
 *
 * 行的定位：发票行的 `order_item_id` → 所属订单。有它就把入库量与已开票量都**限定在这张订单**；
 * 没有它（票面没写订单行）才退回 (供应商, SKU) 的老口径 —— 那种票本来就无从核对到单。
 */
export function matchInvoiceToReceipts(db, invoiceId) {
  const inv = getInvoice(db, invoiceId)
  if (!inv) return { blocking: [], note: null, lines: [] }
  const blocking = []
  const lines = []
  for (const it of inv.items) {
    if (!it.sku_id) continue
    const oi = it.order_item_id
      ? db.prepare('SELECT id, order_id FROM purchase_order_items WHERE id=?').get(it.order_item_id)
      : null
    const orderId = oi?.order_id ?? null
    const recv = orderId
      ? db
        .prepare(
          `SELECT COALESCE(SUM(ri.qty),0) q, COALESCE(SUM(ri.amount),0) a
             FROM purchase_receipt_items ri
             JOIN purchase_receipts r ON r.id = ri.receipt_id
            WHERE r.order_id=? AND ri.sku_id=?`
        )
        .get(orderId, it.sku_id)
      : db
        .prepare(
          `SELECT COALESCE(SUM(ri.qty),0) q, COALESCE(SUM(ri.amount),0) a
             FROM purchase_receipt_items ri
             JOIN purchase_receipts r ON r.id = ri.receipt_id
            WHERE r.supplier_id=? AND ri.sku_id=?`
        )
        .get(inv.supplier_id, it.sku_id)
    const otherInvoiced = orderId
      ? db
        .prepare(
          `SELECT COALESCE(SUM(ii2.qty),0) q
             FROM purchase_invoice_items ii2
             JOIN purchase_invoices i2 ON i2.id = ii2.invoice_id
             JOIN purchase_order_items oi2 ON oi2.id = ii2.order_item_id
            WHERE oi2.order_id=? AND ii2.sku_id=? AND i2.id<>? AND i2.status NOT IN ('voided','draft')`
        )
        .get(orderId, it.sku_id, inv.id)
      : db
        .prepare(
          `SELECT COALESCE(SUM(ii2.qty),0) q
             FROM purchase_invoice_items ii2
             JOIN purchase_invoices i2 ON i2.id = ii2.invoice_id
            WHERE i2.supplier_id=? AND ii2.sku_id=? AND i2.id<>? AND i2.status NOT IN ('voided','draft')`
        )
        .get(inv.supplier_id, it.sku_id, inv.id)
    const over = Number(otherInvoiced.q || 0) + Number(it.qty || 0) - Number(recv.q || 0)
    lines.push({
      sku_id: it.sku_id,
      order_item_id: it.order_item_id || null,
      order_id: orderId,
      scope: orderId ? 'order' : 'supplier_sku',
      invoiced: it.qty,
      received: recv.q,
      already_invoiced: otherInvoiced.q
    })
    if (over > 1e-6) {
      blocking.push({
        sku_id: it.sku_id,
        code: 'INVOICE_OVER_RECEIPT',
        message:
          `开票数量超过已入库数量（本票 ${it.qty}，已开 ${otherInvoiced.q}，` +
          (orderId ? `本订单 ${orderId} 已入库 ${recv.q}）` : `本供应商该商品已入库 ${recv.q}）`),
        detail: {
          order_item_id: it.order_item_id || null,
          order_id: orderId,
          invoiced: it.qty,
          already_invoiced: otherInvoiced.q,
          received: recv.q
        }
      })
    }
  }
  return {
    blocking,
    lines,
    note: blocking.length ? null : '三单匹配：发票数量未超入库量'
  }
}

// ---------------------------------------------------------------------------
// 五、采购结算（三单匹配）
// ---------------------------------------------------------------------------

/**
 * 生成采购结算单。settle_mode:
 *   auto  自动 —— 按已认证发票金额结算
 *   manual 手工 —— 按入库暂估金额结算（无票先结）
 *   fee   费用折扣 —— 入库金额 + 费用发票金额（三单：入库单 + 采购发票 + 费用发票）
 */
export function buildSettlement(db, q = {}) {
  const {
    supplierId, orgId = null, settleDate = ymd(new Date()),
    periodStart = null, periodEnd = null, settleMode = 'auto', actor = {}, remark = null
  } = q
  if (!supplierId) throw new PurchaseError('结算需要指定供应商', { code: 'PST_NO_SUPPLIER' })

  const cond = ["r.supplier_id=?"]
  const args = [supplierId]
  if (periodStart) { cond.push('r.receipt_date>=?'); args.push(ymd(periodStart)) }
  if (periodEnd) { cond.push('r.receipt_date<=?'); args.push(ymd(periodEnd)) }
  cond.push("r.status IN ('received','inspected','closed')")
  // 已被未作废结算单引用过的入库单不再进新结算单 —— 否则同一批货被结两次，应付翻倍。
  // 用友里「暂估结算后再按票冲回」是允许的，但那需要暂估标识与冲回分录；
  // 本模块选择**一单一结**（宁可少算、可人工再结，绝不重复算），暂估冲回列入待确认。
  cond.push(
    `r.id NOT IN (
       SELECT si.source_id FROM purchase_settlement_items si
         JOIN purchase_settlements st ON st.id = si.settle_id
        WHERE si.source_type='receipt' AND st.status <> 'voided'
     )`
  )
  const receipts = db
    .prepare(`SELECT r.* FROM purchase_receipts r WHERE ${cond.join(' AND ')} ORDER BY r.receipt_date`)
    .all(...args)

  const invCond = ["i.supplier_id=?", "i.status IN ('verified','posted')"]
  const invArgs = [supplierId]
  if (periodStart) { invCond.push('i.invoice_date>=?'); invArgs.push(ymd(periodStart)) }
  if (periodEnd) { invCond.push('i.invoice_date<=?'); invArgs.push(ymd(periodEnd)) }
  // 同理：一张发票只能被一张未作废结算单引用（已挂在作废结算单上的可以重用）
  invCond.push(
    `(i.settle_id IS NULL OR i.settle_id IN (SELECT id FROM purchase_settlements WHERE status='voided'))`
  )
  const invoices = db
    .prepare(`SELECT i.* FROM purchase_invoices i WHERE ${invCond.join(' AND ')} ORDER BY i.invoice_date`)
    .all(...invArgs)

  if (!receipts.length && !invoices.length) {
    throw new PurchaseError('该期间内没有可结算的入库单或发票', {
      code: 'PST_NOTHING', httpStatus: 409
    })
  }

  // 费用发票：把费用按金额占比摊到入库行上
  const feeInvoices = invoices.filter((i) => i.invoice_type === 'fee')
  const normalInvoices = invoices.filter((i) => i.invoice_type !== 'fee')
  const feeTotal = feeInvoices.reduce((s, i) => s + Number(i.amount || 0), 0)

  const receiptItems = []
  for (const r of receipts) {
    const items = db
      .prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=? ORDER BY id')
      .all(r.id)
    for (const it of items) receiptItems.push({ receipt: r, item: it })
  }
  const receiptAmount = receiptItems.reduce((s, x) => s + Number(x.item.amount || 0), 0)
  const orderIds = [...new Set(receipts.map((r) => r.order_id).filter(Boolean))]
  const orderAmount = orderIds.length
    ? db
        .prepare(`SELECT COALESCE(SUM(total_amount),0) s FROM purchase_orders WHERE id IN (${orderIds.map(() => '?').join(',')})`)
        .get(...orderIds).s
    : 0
  const invoiceAmount = normalInvoices.reduce((s, i) => s + Number(i.amount || 0), 0)

  let settleAmount
  if (settleMode === 'manual') settleAmount = receiptAmount
  else if (settleMode === 'fee') settleAmount = round2(invoiceAmount + feeTotal)
  else settleAmount = round2(normalInvoices.length ? invoiceAmount : receiptAmount)

  const diffAmount = round2(receiptAmount - (normalInvoices.length ? invoiceAmount : receiptAmount))

  // ---- 采购退货抵减（**配置驱动**，默认关 = 上线前的实际行为）----
  //
  // 客户口径：「退货是否递减这种你都可以做到供应链设置里，客户选择是，就递减，不设就不抵。」
  // ⇒ 开关是 `settings.purchase_return_offset`，判据只在这里读一次（不在路由、不在前端）。
  //
  // 三条必须写下来的边界：
  //   ① **一单一结**：一张退货单只能被一张**未作废**的结算单引用（与入库单同一条规则）。
  //      否则"关掉再打开""反复生成"都会把同一张退货抵两次 —— 而抵两次不会报错，
  //      只会让应付比实际少一截。
  //   ② **不追溯**：只对**新建**的结算单生效。已生成（含已审/已付）的结算单一律不碰 ——
  //      给已付过款的单补一笔抵减，账上会多出一笔"退过但没记账"的钱，两边都不报错。
  //   ③ **不允许抵成负数**：算出来是负数就**拒绝建单**（`PST_RETURN_OVERFLOW`），
  //      不静默截成 0。"退得比进的多"是一条真实的业务信号，截掉等于把它藏起来。
  const offsetEnabled = readSetting(db, 'purchase_return_offset')
  let returnRows = []
  let returnAmount = 0
  if (offsetEnabled) {
    const rCond = ['pr.supplier_id=?']
    const rArgs = [supplierId]
    if (periodStart) {
      rCond.push('pr.return_date>=?')
      rArgs.push(ymd(periodStart))
    }
    if (periodEnd) {
      rCond.push('pr.return_date<=?')
      rArgs.push(ymd(periodEnd))
    }
    // `completed` 也收：结案不改变"货退回去了"这个事实（与凭证生成同一份口径）
    rCond.push("pr.status IN ('confirmed','completed')")
    rCond.push(
      `pr.id NOT IN (
         SELECT si.source_id FROM purchase_settlement_items si
           JOIN purchase_settlements st ON st.id = si.settle_id
          WHERE si.source_type='return' AND st.status <> 'voided'
       )`
    )
    returnRows = db
      .prepare(`SELECT pr.* FROM purchase_returns pr WHERE ${rCond.join(' AND ')} ORDER BY pr.return_date, pr.id`)
      .all(...rArgs)
    returnAmount = round2(returnRows.reduce((s, r) => s + Number(r.total_amount || 0), 0))
  }
  const netSettleAmount = round2(settleAmount - returnAmount)
  if (netSettleAmount < 0) {
    throw new PurchaseError(
      `该期间退货合计 ${returnAmount} 已超过应结金额 ${settleAmount}（结出来会是负数）。`
        + '这通常意味着期间选错了、或退货对应的入库单还没进结算 —— 请调整期间或先结那批入库，'
        + '本单不会生成。',
      { code: 'PST_RETURN_OVERFLOW', httpStatus: 409 }
    )
  }

  const no = docNo(db, 'PST', settleDate)
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO purchase_settlements
           (doc_no,supplier_id,org_id,settle_date,period_start,period_end,settle_mode,
            order_count,invoice_count,order_amount,receipt_amount,invoice_amount,fee_amount,return_amount,
            settle_amount,paid_amount,diff_amount,status,remark,created_by,created_by_name,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'draft',?,?,?,?)`
      )
      .run(
        no, supplierId, orgId, ymd(settleDate), periodStart ? ymd(periodStart) : null,
        periodEnd ? ymd(periodEnd) : null, settleMode,
        orderIds.length, invoices.length, round2(orderAmount), round2(receiptAmount),
        round2(invoiceAmount), round2(feeTotal), returnAmount, netSettleAmount, diffAmount,
        remark, actor.id || null, actor.name || null, nowStr()
      )
    const sid = res.lastInsertRowid
    const insItem = db.prepare(
      `INSERT INTO purchase_settlement_items
         (settle_id,line_no,source_type,source_id,source_doc_no,sku_id,qty,price,amount,tax_amount,fee_amount,final_cost,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    let n = 0
    for (const x of receiptItems) {
      const share = receiptAmount > 0 ? (Number(x.item.amount || 0) / receiptAmount) * feeTotal : 0
      const q = Number(x.item.qty || 0)
      const finalCost = q > 0 ? round2((Number(x.item.amount || 0) + share) / q) : 0
      n += 1
      insItem.run(
        sid, n, 'receipt', x.receipt.id, x.receipt.doc_no, x.item.sku_id,
        q, Number(x.item.price || 0), Number(x.item.amount || 0), 0, round2(share), finalCost,
        share > 0 ? `摊费用 ${round2(share)}` : null
      )
    }
    for (const i of invoices) {
      const items = db.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').all(i.id)
      for (const it of items) {
        n += 1
        insItem.run(
          sid, n, i.invoice_type === 'fee' ? 'fee' : 'invoice', i.id, i.doc_no, it.sku_id,
          Number(it.qty || 0), Number(it.price || 0), Number(it.amount || 0),
          Number(it.tax_amount || 0), 0, 0, it.fee_type || null
        )
      }
      db.prepare('UPDATE purchase_invoices SET settle_id=? WHERE id=?').run(sid, i.id)
    }
    // 退货抵减的明细行：**金额存负数**（与单头 `return_amount` 存正数配对：头 = −Σ明细）。
    // 按 `purchase_return_items` 逐行落，而不是一张退货一行汇总 —— 结算明细的读者要能回答
    // "抵的是哪些货"；只给一个汇总数等于让人回去翻原单。
    // 单头的数**以 `purchase_returns.total_amount` 为准**（它是这张退货单的权威金额），
    // 明细只负责"抵的是哪些货"；退货单没有明细行时补一行汇总，保证头行对得上。
    for (const r of returnRows) {
      const rItems = db.prepare('SELECT * FROM purchase_return_items WHERE return_id=? ORDER BY id').all(r.id)
      if (!rItems.length) {
        n += 1
        insItem.run(
          sid, n, 'return', r.id, r.doc_no, null,
          0, 0, -Number(r.total_amount || 0), 0, 0, 0, `退货抵减 ${r.doc_no}（原单无明细）`
        )
        continue
      }
      for (const it of rItems) {
        n += 1
        insItem.run(
          sid, n, 'return', r.id, r.doc_no, it.sku_id,
          -Number(it.qty || 0), Number(it.price || 0), -Number(it.amount || 0),
          0, 0, Number(it.price || 0), `退货抵减 ${r.doc_no}`
        )
      }
    }
    return sid
  })
  const id = tx()
  for (const oid of orderIds) {
    refreshOrderStats(db, oid)
    refreshCloseFlags(db, oid)
  }
  return getSettlement(db, id)
}

export function getSettlement(db, id) {
  const head = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT si.*, s.sku_code, s.name AS sku_name
         FROM purchase_settlement_items si
         LEFT JOIN product_skus s ON s.id = si.sku_id
        WHERE si.settle_id=? ORDER BY si.line_no`
    )
    .all(id)
  const supplier = db.prepare('SELECT code,name FROM suppliers WHERE id=?').get(head.supplier_id)
  const payments = db
    .prepare(
      `SELECT pi.*, p.doc_no AS payment_doc_no, p.pay_date, p.pay_type, p.status AS payment_status
         FROM purchase_payment_items pi
         LEFT JOIN purchase_payments p ON p.id = pi.payment_id
        WHERE pi.settle_id=? ORDER BY pi.id`
    )
    .all(id)
  // 明细里既有「已生效核销」也有「还挂在草稿付款单上的核销计划」，必须分开报：
  // 前端如果只显示一个合计，就会把「钱还没付」看成「已付」。
  const effective = payments.filter((x) => x.payment_status === 'approved' || x.payment_status === 'paid')
  const pending = payments.filter((x) => !x.payment_status || x.payment_status === 'draft')
  const sum = (arr) => round2(arr.reduce((s, x) => s + Number(x.amount || 0), 0))
  return {
    ...head,
    items,
    supplier,
    payments,
    /** 已生效核销金额（应与 paid_amount 一致） */
    settled_amount: sum(effective),
    /** 未生效核销计划金额（付款单还没提交审批） */
    pending_amount: sum(pending),
    /** 未结清金额 */
    open_amount: round2(Number(head.settle_amount || 0) - Number(head.paid_amount || 0))
  }
}

export function transitionSettlement(db, { id, action, actor = {}, set = {}, remark = null, source = 'api' }) {
  const st = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(id)
  if (!st) throw new PurchaseError('采购结算单不存在', { code: 'PST_NOT_FOUND', httpStatus: 404 })
  const extra = { ...set }
  if (action === 'audit') {
    extra.audited_by = actor.id || null
    extra.audited_by_name = actor.name || null
    extra.audited_at = nowStr()
  }
  if (action === 'settle') extra.settled_at = nowStr()
  return applyTransition({
    db, docType: 'PST', id, action, actor: { id: actor.id, name: actor.name },
    set: extra, remark, source
  })
}

// ---------------------------------------------------------------------------
// 六、付款单与核销
// ---------------------------------------------------------------------------

// 核销**生效点**：付款单「已审批」即形成应付冲减（用友口径 —— 付款单审核后即核销），
// 单据上的 `paid`（已付款）只表示出纳已把钱付出去，**不改变金额口径**。
// 所以草稿状态的付款单虽然已录好核销明细，却不计入结算单的已付金额 ——
// 否则「钱还没付，结算单已经显示收齐了」。
const PAID_EFFECTIVE_STATUSES = "('approved','paid')"

/**
 * 按核销明细细表**重算**结算单的已付金额（唯一算钱的地方）。
 * paid_amount 永远是 SUM(明细) 算出来的，不是累加出来的 —— 累加会产生漂移。
 */
export function syncSettlePaid(db, settleId, { actor = {}, source = 'api' } = {}) {
  const st = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(settleId)
  if (!st || st.status === 'voided') return null
  const paid = db
    .prepare(
      `SELECT COALESCE(SUM(it.amount),0) s
         FROM purchase_payment_items it
         JOIN purchase_payments p ON p.id = it.payment_id
        WHERE it.settle_id=? AND p.status IN ${PAID_EFFECTIVE_STATUSES}`
    )
    .get(settleId).s
  db.prepare('UPDATE purchase_settlements SET paid_amount=?, updated_at=? WHERE id=?').run(
    round2(paid), nowStr(), settleId
  )
  if (Number(paid) + 1e-6 >= Number(st.settle_amount || 0) && st.status === 'audited') {
    applyTransition({
      db, docType: 'PST', id: settleId, action: 'settle',
      actor: { id: actor.id || null, name: actor.name || null },
      set: { settled_at: nowStr() }, remark: '核销足额，自动结清', source
    })
  }
  return round2(paid)
}

/** 结算单涉及的采购订单 id（结算明细 → 入库单 → 订单） */
function ordersOfSettlement(db, settleId) {
  return db
    .prepare(
      `SELECT DISTINCT rc.order_id oid
         FROM purchase_settlement_items si
         JOIN purchase_receipts rc ON rc.id = si.source_id
        WHERE si.settle_id=? AND si.source_type='receipt' AND rc.order_id IS NOT NULL`
    )
    .all(settleId)
    .map((r) => r.oid)
}

export function createPayment(db, pay = {}) {
  const {
    supplierId, orgId = null, payDate = ymd(new Date()), payType = 'transfer', currency = 'CNY',
    amount = 0, bankAccount = null, voucherNo = null, remark = null, actor = {},
    allocations = null // [{ settle_id, amount }]，不传则按 FIFO 自动核销
  } = pay
  if (!supplierId) throw new PurchaseError('付款单缺少供应商', { code: 'PAY_NO_SUPPLIER' })
  if (!(Number(amount) > 0)) throw new PurchaseError('付款金额必须大于 0', { code: 'PAY_BAD_AMOUNT' })
  // 币种不是自由文本：一个填错的币种会跟着这张单进入凭证、账龄与对账
  if (!SUPPORTED_CURRENCIES.includes(String(currency))) {
    throw new PurchaseError(`不支持的币种「${currency}」，可用：${SUPPORTED_CURRENCIES.join(' / ')}`, {
      code: 'PAY_BAD_CURRENCY', httpStatus: 400
    })
  }
  const no = docNo(db, 'PAY', payDate)
  const plan = allocations && allocations.length ? allocations : planAllocation(db, supplierId, Number(amount))
  // 手工指定核销目标时必须逐条过闸（自动 FIFO 自己也只会在"未付余额"范围内挑，
  // 但两条路都走同一个校验，避免"自动的能过、手工的绕过"）
  assertPaymentAllocations(db, { supplierId, allocations: plan })
  const allocated = plan.reduce((s, x) => s + Number(x.amount || 0), 0)
  if (allocated - Number(amount) > 1e-6) {
    throw new PurchaseError('核销金额超过付款金额', { code: 'PAY_OVER_ALLOCATE', httpStatus: 409 })
  }
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO purchase_payments
           (doc_no,supplier_id,org_id,pay_date,pay_type,currency,amount,settled_amount,settle_count,status,
            bank_account,voucher_no,remark,created_by,created_by_name,created_at)
         VALUES (?,?,?,?,?,?,?,0,0,'draft',?,?,?,?,?,?)`
      )
      .run(no, supplierId, orgId, ymd(payDate), payType, currency, round2(amount), bankAccount, voucherNo,
        remark, actor.id || null, actor.name || null, nowStr())
    const pid = res.lastInsertRowid
    const insItem = db.prepare(
      'INSERT INTO purchase_payment_items (payment_id,settle_id,settle_doc_no,amount,remark) VALUES (?,?,?,?,?)'
    )
    for (const a of plan) {
      const st = db.prepare('SELECT doc_no FROM purchase_settlements WHERE id=?').get(a.settle_id)
      insItem.run(pid, a.settle_id, st?.doc_no || null, round2(a.amount), a.remark || null)
    }
    db.prepare('UPDATE purchase_payments SET settled_amount=?, settle_count=? WHERE id=?').run(
      round2(allocated), plan.length, pid
    )
    return pid
  })
  const id = tx()
  return getPayment(db, id)
}

/** FIFO 核销计划：按结算日期先后，把付款金额填到未结清的结算单上 */
/**
 * 付款核销的准入闸门（A18）。
 *
 * 手工核销**不是"填几个数"**：每一条明细都在把一笔钱指定到某张结算单上，
 * 一旦落库就有账务后果。所以四道闸缺一不可：
 *   ① 主体一致 —— 给 A 供应商付款、抵 B 的结算单，等于替别人还了债；
 *   ② 状态可核销 —— 草稿 / 已作废的结算单不该收到钱；
 *   ③ 金额为正 —— 负分摊会**反向增加**那张结算单的未付额；
 *   ④ 不超未付余额 —— 且必须按**结算单**累计（同一张在多条明细里重复出现时也要管）。
 * 旧实现只验「核销总额 ≤ 付款额」，于是上面四条全是敞口：
 * 跨供应商能过、作废单能过、负数能过、两张草稿可以计划同一笔余额。
 */
const SUPPORTED_CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR']
const SETTLE_WRITABLE_STATUSES = ['audited', 'settled']
/** 已生效（计入结算单已付金额）的付款单状态 —— 与 syncSettlePaid 的 SQL 同一口径 */
const PAID_EFFECTIVE = ['approved', 'paid']

/**
 * @param selfPaymentId 重验时传本单 id。
 *   **本单已生效的额度必须加回来**，否则"我核销之后，我自己不合法了"：
 *   付款单的 `submit` 已经让本单计入结算单的 `paid_amount`，到 `pay`（出纳执行）
 *   这一步再校验时，`未付余额` 里已经包含了本单自己占的那份 ——
 *   不扣掉就会拿"本单 + 本单"去比 `settle_amount`，必然超额。
 *   未生效时（draft）**不能**加：那等于给"超余额"开了后门。
 */
function assertPaymentAllocations(db, { supplierId, allocations, selfPaymentId = null }) {
  const selfEffective = new Map()
  if (selfPaymentId) {
    const self = db.prepare('SELECT status FROM purchase_payments WHERE id=?').get(selfPaymentId)
    if (self && PAID_EFFECTIVE.includes(self.status)) {
      for (const it of db
        .prepare('SELECT settle_id, amount FROM purchase_payment_items WHERE payment_id=?')
        .all(selfPaymentId)) {
        if (!it.settle_id) continue
        const k = Number(it.settle_id)
        selfEffective.set(k, round2((selfEffective.get(k) || 0) + Number(it.amount)))
      }
    }
  }
  const planned = new Map()
  for (let i = 0; i < allocations.length; i += 1) {
    const a = allocations[i] || {}
    const at = `第 ${i + 1} 条核销明细`
    const sid = Number(a.settle_id)
    if (!sid) throw new PurchaseError(`${at}缺少结算单`, { code: 'PAY_ALLOC_NO_SETTLE', httpStatus: 400 })
    const amt = Number(a.amount || 0)
    if (!(amt > 0)) {
      throw new PurchaseError(`${at}的核销金额必须大于 0（收到 ${a.amount}）`, {
        code: 'PAY_ALLOC_BAD_AMOUNT', httpStatus: 400
      })
    }
    const st = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(sid)
    if (!st) {
      throw new PurchaseError(`${at}指向的结算单 #${sid} 不存在`, { code: 'PAY_SETTLE_NOT_FOUND', httpStatus: 404 })
    }
    if (Number(st.supplier_id) !== Number(supplierId)) {
      throw new PurchaseError(
        `${at}的结算单 ${st.doc_no} 属于供应商 #${st.supplier_id}，与付款单的供应商 #${supplierId} 不一致`,
        {
          code: 'PAY_ALLOC_SUPPLIER_MISMATCH', httpStatus: 409,
          detail: { settle_id: sid, settle_supplier: st.supplier_id, payment_supplier: supplierId }
        }
      )
    }
    if (!SETTLE_WRITABLE_STATUSES.includes(st.status)) {
      throw new PurchaseError(`${at}的结算单 ${st.doc_no} 状态「${st.status}」不可核销`, {
        code: 'PAY_ALLOC_SETTLE_STATUS', httpStatus: 409, detail: { settle_id: sid, status: st.status }
      })
    }
    // 可用额 = 未付余额 + 本单已生效部分（见函数头注释）
    const open = round2(Number(st.settle_amount || 0) - Number(st.paid_amount || 0))
    const available = round2(open + (selfEffective.get(sid) || 0))
    const used = planned.get(sid) || 0
    if (used + amt - available > 1e-6) {
      throw new PurchaseError(
        `${at}超过结算单 ${st.doc_no} 的未付余额（未付 ${open}，本单已计划 ${used}，本条 ${amt}）`,
        { code: 'PAY_ALLOC_OVER_OPEN', httpStatus: 409, detail: { settle_id: sid, open, planned: used, amount: amt } }
      )
    }
    planned.set(sid, round2(used + amt))
  }
  return planned
}

/**
 * 生效 / 执行付款前的**重验**（A18）：
 * 建单时有效不等于生效时还有效 —— 结算单可能已被作废、已被别人核销完、或金额被改小。
 * 只在建单时校验，等于给"先建单、再作废结算单、最后批准"留了一条把钱付出去的路。
 * 别人已生效的核销额本身就在 `paid_amount` 里（`syncSettlePaid` 是重算不是累加），
 * 所以这里只需要把**本单自己**的额度加回来。
 */
function assertPaymentSettlements(db, { paymentId, supplierId }) {
  const items = db
    .prepare('SELECT settle_id, amount FROM purchase_payment_items WHERE payment_id=? ORDER BY id')
    .all(paymentId)
    .filter((it) => it.settle_id)
  if (!items.length) return
  assertPaymentAllocations(db, { supplierId, allocations: items, selfPaymentId: paymentId })
}

export function planAllocation(db, supplierId, amount) {
  const rows = db
    .prepare(
      `SELECT id, doc_no, settle_amount, paid_amount
         FROM purchase_settlements
        WHERE supplier_id=? AND status IN ('audited','settled')
        ORDER BY settle_date, id`
    )
    .all(supplierId)
  let left = Number(amount)
  const plan = []
  for (const r of rows) {
    if (left <= 1e-6) break
    const open = Number(r.settle_amount || 0) - Number(r.paid_amount || 0)
    if (open <= 1e-6) continue
    const take = Math.min(left, open)
    plan.push({ settle_id: r.id, amount: round2(take), remark: 'FIFO 自动核销' })
    left -= take
  }
  return plan
}

export function getPayment(db, id) {
  const head = db.prepare('SELECT * FROM purchase_payments WHERE id=?').get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT pi.*, st.settle_amount, st.paid_amount, st.status AS settle_status, st.settle_date
         FROM purchase_payment_items pi
         LEFT JOIN purchase_settlements st ON st.id = pi.settle_id
        WHERE pi.payment_id=? ORDER BY pi.id`
    )
    .all(id)
  const supplier = db.prepare('SELECT code,name FROM suppliers WHERE id=?').get(head.supplier_id)
  return { ...head, items, supplier }
}

/**
 * 执行付款核销。**这是本模块唯一会改动结算单金额的动作**，所以单独一个函数：
 * 按核销明细重算结算单 paid_amount → 足额即转 settled → 回写采购订单 paid_amount。
 * paid_amount 永远是 SUM(明细) 算出来的，不是累加出来的（累加会产生漂移），
 * 且只统计**已生效**（已审批/已付款）的付款单 —— 草稿付款单上的核销只是计划。
 *
 * 注意：本函数**只核销、不推状态**。「执行付款」= 核销 + 状态前进（由 transitionPayment 负责），
 * 两者必须一起发生，否则会出现「钱已经核销掉了，付款单还挂在已审批」——
 * 那是账实不符，不是显示问题。
 */
export function writeOffPayment(db, { paymentId, actor = {}, remark = null, source = 'api' }) {
  const pay = getPayment(db, paymentId)
  if (!pay) throw new PurchaseError('付款单不存在', { code: 'PAY_NOT_FOUND', httpStatus: 404 })
  if (pay.status !== 'approved') {
    throw new PurchaseError(`付款单状态「${pay.status}」不能核销，请先提交审批`, {
      code: 'PAY_NOT_APPROVED', httpStatus: 409
    })
  }
  const touchedOrders = new Set()
  const tx = db.transaction(() => {
    for (const it of pay.items) {
      if (!it.settle_id) continue
      // 核销明细已由 createPayment 写好；这里只负责**重算**结算单已付金额
      const paid = syncSettlePaid(db, it.settle_id, { actor, source })
      if (paid === null) continue
      for (const oid of ordersOfSettlement(db, it.settle_id)) touchedOrders.add(oid)
    }
  })
  tx()
  db.prepare('UPDATE purchase_payments SET updated_at=? WHERE id=?').run(nowStr(), paymentId)
  for (const oid of touchedOrders) {
    refreshOrderStats(db, oid)
    refreshCloseFlags(db, oid)
  }
  return getPayment(db, paymentId)
}

export function transitionPayment(db, { id, action, actor = {}, set = {}, remark = null, source = 'api' }) {
  const pay = db.prepare('SELECT * FROM purchase_payments WHERE id=?').get(id)
  if (!pay) throw new PurchaseError('付款单不存在', { code: 'PAY_NOT_FOUND', httpStatus: 404 })

  // A18：生效（submit）与执行付款（pay）两个时点都**重验**核销目标。
  // 只在建单时校验，等于给「先建单 → 再作废结算单 → 最后批准」留了一条把钱付出去的路。
  // `void` 不走这一步：作废正是把"已经发生的核销"收回去。
  if (action === 'submit' || action === 'pay') {
    assertPaymentSettlements(db, { paymentId: id, supplierId: pay.supplier_id })
  }

  if (action === 'pay') {
    // 「执行付款」= 核销 + 状态前进，两件事必须一起发生：
    // 只核销不推状态 → 付款单永远停在已审批（账实不符）；
    // 只推状态不核销 → 结算单永远收不到钱。
    writeOffPayment(db, { paymentId: id, actor, remark, source })
    return applyTransition({
      db, docType: 'PAY', id, action: 'pay',
      actor: { id: actor.id, name: actor.name },
      set: { ...set, paid_at: nowStr() }, remark, source
    })
  }

  // 作废前先挡住「会让已结清结算单失血」的操作：
  // 结算单结清是单向的（状态机没有 settled → audited 的边），
  // 一旦作废导致已付金额掉下来，结算单会停在 settled 却金额不足 —— 账实不符。
  if (action === 'void') {
    for (const it of db.prepare('SELECT settle_id FROM purchase_payment_items WHERE payment_id=?').all(id)) {
      if (!it.settle_id) continue
      const st = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(it.settle_id)
      if (!st || st.status !== 'settled') continue
      const rest = db
        .prepare(
          `SELECT COALESCE(SUM(it2.amount),0) s
             FROM purchase_payment_items it2
             JOIN purchase_payments p2 ON p2.id = it2.payment_id
            WHERE it2.settle_id=? AND it2.payment_id<>? AND p2.status IN ${PAID_EFFECTIVE_STATUSES}`
        )
        .get(it.settle_id, id).s
      if (Number(rest) + 1e-6 < Number(st.settle_amount || 0)) {
        throw new PurchaseError(
          `结算单 ${st.doc_no} 已结清，作废本付款单会使其金额不足；请先作废该结算单`,
          {
            code: 'PAY_VOID_BREAKS_SETTLEMENT', httpStatus: 409,
            detail: { settle_id: it.settle_id, doc_no: st.doc_no }
          }
        )
      }
    }
  }

  const extra = { ...set }
  if (action === 'submit') {
    extra.approved_by = actor.id || null
    extra.approved_by_name = actor.name || null
    extra.approved_at = nowStr()
  }
  const out = applyTransition({
    db, docType: 'PAY', id, action, actor: { id: actor.id, name: actor.name },
    set: extra, remark, source
  })

  // 状态一变，核销是否生效就跟着变（draft ↔ approved 正好横跨生效线）→ 重算涉及的结算单
  const touched = new Set()
  for (const it of db.prepare('SELECT settle_id FROM purchase_payment_items WHERE payment_id=?').all(id)) {
    if (!it.settle_id) continue
    syncSettlePaid(db, it.settle_id, { actor, source })
    for (const oid of ordersOfSettlement(db, it.settle_id)) touched.add(oid)
  }
  for (const oid of touched) {
    refreshOrderStats(db, oid)
    refreshCloseFlags(db, oid)
  }
  return out
}

// ---------------------------------------------------------------------------
// 七、采购退货单
// ---------------------------------------------------------------------------

/**
 * 定位「这张退货属于哪张上游单」——按**字段**找，不靠备注文本。
 *
 * 退货的两张表（`purchase_returns` / `purchase_return_items`）里都没有
 * `order_id` / `receipt_id` / `source_type` 三个列（PRAGMA 实测），本项目又不允许改表结构，
 * 所以分两步：
 *   · **定位**用字段：退货行的 `(sku_id, batch_no)` + 供应商/仓 → 到货明细行 → 收货单 → 采购订单/订单行。
 *     批次号是这一批货的身份证，比 `reason LIKE '质检判退%'` 这种文本匹配可靠得多
 *     （原来只能那样找，而且只在质检那一个入口成立）。
 *   · **落地**用已有字段：写进退货单 confirm 流转的 `doc_events.payload_json`
 *     （`purchase_returns` 本身没有可用的 source_* 列）。读回见 `purchaseReturnSource()`。
 */
function resolveReturnSource(db, { supplierId = null, warehouseId = null, skuId, batchNo, receiptId = null, orderId = null, orderItemId = null }) {
  const orderItemProbe = `(SELECT oi.id FROM purchase_order_items oi
                             WHERE oi.order_id = rc.order_id AND oi.sku_id = ri.sku_id AND oi.received_qty > 0.0001
                             ORDER BY oi.id LIMIT 1) AS order_item_id`
  if (orderItemId) {
    const r = db
      .prepare(
        `SELECT oi.id AS order_item_id, oi.order_id, NULL AS receipt_item_id, NULL AS receipt_id, NULL AS receipt_price
           FROM purchase_order_items oi WHERE oi.id=?`
      )
      .get(orderItemId)
    if (r) return r
  }
  if (receiptId) {
    const r = db
      .prepare(
        `SELECT ri.id AS receipt_item_id, ri.receipt_id, ri.price AS receipt_price, rc.order_id, ${orderItemProbe}
           FROM purchase_receipt_items ri JOIN purchase_receipts rc ON rc.id = ri.receipt_id
          WHERE ri.receipt_id=? AND ri.sku_id=? AND IFNULL(ri.batch_no,'')=IFNULL(?,'')
          ORDER BY ri.id LIMIT 1`
      )
      .get(receiptId, skuId, batchNo || '')
    if (r) return r
  }
  return (
    db
      .prepare(
        `SELECT ri.id AS receipt_item_id, ri.receipt_id, ri.price AS receipt_price, rc.order_id, ${orderItemProbe}
           FROM purchase_receipt_items ri JOIN purchase_receipts rc ON rc.id = ri.receipt_id
          WHERE ri.sku_id=? AND IFNULL(ri.batch_no,'')=IFNULL(?,'')
            AND (? IS NULL OR rc.supplier_id=?)
            AND (? IS NULL OR rc.warehouse_id=?)
            AND (? IS NULL OR rc.order_id=?)
          ORDER BY rc.id DESC, ri.id DESC LIMIT 1`
      )
      .get(
        skuId, batchNo || '',
        supplierId ?? null, supplierId ?? null,
        warehouseId ?? null, warehouseId ?? null,
        orderId ?? null, orderId ?? null
      ) || null
  )
}

/** 读回退货单的上游来源（退货单 confirm 留痕的 payload_json）。查不到返回 null。 */
export function purchaseReturnSource(db, returnId) {
  const ev = db
    .prepare("SELECT payload_json FROM doc_events WHERE doc_type='PRT' AND doc_id=? AND action='confirm' ORDER BY id DESC LIMIT 1")
    .get(returnId)
  if (!ev?.payload_json) return null
  try {
    const p = JSON.parse(ev.payload_json)
    return p && Array.isArray(p.sources) ? p : null
  } catch {
    return null
  }
}

/**
 * 建采购退货单（草稿 → 已确认），并把货退出去。
 *
 * **这是退货单唯一的创建入口**：手工退货（`POST /purchase/returns`）与质检判退
 * （`lib/qc.js` / `lib/qc2.js`）都走这里。原先退货逻辑只长在路由里，质检要判退就只能复制一份 ——
 * 于是「退货单是怎么生成的、要不要出库、出到哪个仓」会有两种实现，迟早分家。
 *
 * 出库在这一步完成：退回的货离开正品库存，现存 / 批次 / 流水三者一起回退。
 * 顺序不能反 —— 先建单再出库，出库失败时留一张「说退了但货还在」的假单；
 * 反过来先出库再建单，建单失败就变成账实不符。
 *
 * @param items [{ sku_id, batch_no, qty, price, receipt_id?, order_id?, order_item_id? }]
 */
export function createPurchaseReturn(db, ret = {}) {
  const {
    supplierId, warehouseId, returnDate = null, reason = null,
    items = [], actor = {}, source = 'api', docNoOverride = null
  } = ret
  if (!supplierId) throw new PurchaseError('退货单缺少供应商', { code: 'PRT_NO_SUPPLIER' })
  if (!warehouseId) throw new PurchaseError('退货单缺少退货仓库', { code: 'PRT_NO_WAREHOUSE' })
  const retWh = assertWarehouseUsable(db, warehouseId, { role: '退货仓库', required: true })
  // 采购退货是**出库**（`PUR_RET`），所以它按出库类型配的许可集判 —— 与入库是两个用例。
  assertWarehouseAllowedForDoc(db, { docType: 'PUR_RET', warehouse: retWh, role: '退货仓库' })
  // 数量必须过与建单**同一份**校验器（numQty：>0 且最多 4 位小数）。
  // 原来直接 `Number(it.qty)`：`qty=1.23456789` 会被原样出库并落库，而同一判据
  // 在采购订单建单那侧是拦的（normalizePurchaseOrderLines 用 numQty）——
  // 「建单拦得住、收货/退货拦不住」正是同一件事两套判据的典型。
  const usable = []
  items.forEach((it, i) => {
    const n = numQty(it.qty, `第 ${i + 1} 行退货数量`)
    if (!n.ok) throw new PurchaseError(n.message, { code: 'PRT_BAD_QTY' })
    if (n.value > 0) usable.push({ ...it, qty: n.value })
  })
  if (!usable.length) throw new PurchaseError('退货单至少需要一行明细', { code: 'PRT_NO_LINES' })

  const date = ymd(returnDate || new Date())
  const tx = db.transaction(() => {
    const no = docNoOverride || docNo(db, 'PRT', date)
    const info = db
      .prepare(
        `INSERT INTO purchase_returns (doc_no,supplier_id,warehouse_id,return_date,reason,status,total_qty,total_amount,created_by)
         VALUES (?,?,?,?,?,'draft',0,0,?)`
      )
      .run(no, supplierId, warehouseId, date, reason || null, actor.id || null)
    const rid = info.lastInsertRowid
    const insItem = db.prepare(
      'INSERT INTO purchase_return_items (return_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)'
    )
    const sources = []
    const touchedOrders = new Set()
    let q = 0
    let a = 0
    for (const it of usable) {
      const qty = Number(it.qty)
      const src = resolveReturnSource(db, {
        supplierId, warehouseId, skuId: it.sku_id, batchNo: it.batch_no,
        receiptId: it.receipt_id || null, orderId: it.order_id || null, orderItemId: it.order_item_id || null
      })
      // 没填价 ≠ 零成本。传 0 会让库存引擎当成「这批货就是 0 元」：
      // 出库流水金额为 0、结存金额不冲减、均价被抬高（G4）。
      // 传 undefined 让引擎回落到**结存均价**，再拿引擎实际用的单价回填明细与汇总。
      const rawPrice = it.price === '' || it.price == null ? null : Number(it.price)
      const out = applyStockOut(db, {
        bizDate: date, docType: 'PUR_RET', docNo: no, docId: rid,
        warehouseId, skuId: it.sku_id, batchNo: it.batch_no || '', qty,
        unitCost: rawPrice == null ? undefined : rawPrice,
        operator: actor.name || null, remark: '采购退货出库'
      })
      const unitPrice = rawPrice == null ? Number(out?.unitCost || 0) : rawPrice
      insItem.run(rid, it.sku_id || null, it.batch_no || '', qty, unitPrice, round2(qty * unitPrice))
      // ① 回退上游「已收量」：收 100 退 60，订单就该显示收 60。
      //    原来一分不回退 —— 订单显示已收满、`close_arrival=1`，而货已经出仓，
      //    接着还能按这 100 去开票 / 结算，超收的量在系统里凭空存在。
      let rolled = 0
      if (src?.order_item_id) {
        const cur = Number(
          db.prepare('SELECT received_qty FROM purchase_order_items WHERE id=?').get(src.order_item_id)?.received_qty || 0
        )
        const back = Math.min(cur, qty) // 退得比收得多时不把已收量退成负数
        if (back > 0) {
          db.prepare('UPDATE purchase_order_items SET received_qty = MAX(0, received_qty - ?) WHERE id=?')
            .run(back, src.order_item_id)
          rolled = back
        }
      }
      if (src?.order_id) touchedOrders.add(src.order_id)
      sources.push({
        sku_id: it.sku_id, batch_no: it.batch_no || '',
        receipt_id: src?.receipt_id ?? null, receipt_item_id: src?.receipt_item_id ?? null,
        order_id: src?.order_id ?? null, order_item_id: src?.order_item_id ?? null,
        qty, rolled_back_qty: rolled
      })
      q += qty
      a += qty * unitPrice
    }
    db.prepare('UPDATE purchase_returns SET total_qty=?, total_amount=? WHERE id=?').run(round4(q), round2(a), rid)
    // ② 已收量变了，派生标记要跟着变。「到货关闭」原来只进不退 ——
    //    退货让「已收满」不再成立时必须退回，否则标记说"收齐了"而货已经退走。
    for (const oid of touchedOrders) {
      const derived = refreshCloseFlags(db, oid)
      if (derived && !derived.all_received && derived.close_arrival) {
        db.prepare('UPDATE purchase_orders SET close_arrival=0, updated_at=? WHERE id=?').run(nowStr(), oid)
      }
    }
    // 走内核（draft → confirmed），让 PRT 的状态机真正被使用而不是只当字段。
    // 上游来源随留痕落进 payload_json（退货表没有 source_* 列）—— 下一张单靠字段找回原单。
    applyTransition({
      db, docType: 'PRT', id: rid, action: 'confirm',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: reason || '采购退货确认', source,
      payload: { source_type: 'purchase_receipt', order_ids: [...touchedOrders], sources }
    })
    return rid
  })
  return tx()
}

export function getPurchaseReturn(db, id) {
  const head = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT ri.*, s.sku_code, s.name AS sku_name
         FROM purchase_return_items ri
         LEFT JOIN product_skus s ON s.id = ri.sku_id
        WHERE ri.return_id=? ORDER BY ri.id`
    )
    .all(id)
  const supplier = db.prepare('SELECT code,name FROM suppliers WHERE id=?').get(head.supplier_id)
  return { ...head, items, supplier }
}

// ---------------------------------------------------------------------------
// 八、看板
// ---------------------------------------------------------------------------

/**
 * 采购看板。`orgScope`（`resolveOrgScope` 的结果）不传或 `all` ⇒ 全库；受限范围下**每一块**
 * （五张单的计数 / 金额、供应商榜、应付榜、趋势）都按 `purchaseScopeSql` 的同一个集合算 ——
 * "列表按范围、合计按全库"是最隐蔽的泄漏形状（ADR-0017）。
 */
export function purchaseOverview(db, { orgScope = null } = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const plain = purchaseScopeSql(orgScope)
  const req = one(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft,
           SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
           SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) converted
      FROM purchase_requisitions WHERE ${plain.org}`, ...plain.params)
  const po = one(`
    SELECT COUNT(*) total,
           COALESCE(SUM(total_amount),0) amount,
           SUM(CASE WHEN status IN ('submitted') THEN 1 ELSE 0 END) pending_approve,
           SUM(CASE WHEN status IN ('approved') AND close_arrival=0 THEN 1 ELSE 0 END) pending_arrival,
           SUM(CASE WHEN close_invoice=0 AND status NOT IN ('cancelled','draft') THEN 1 ELSE 0 END) pending_invoice,
           SUM(CASE WHEN close_payment=0 AND status NOT IN ('cancelled','draft') THEN 1 ELSE 0 END) pending_payment
      FROM purchase_orders WHERE ${plain.wh}`, ...plain.params)
  const inv = one(`
    SELECT COUNT(*) total, COALESCE(SUM(total_amount),0) amount,
           SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft,
           SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
           SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) verified,
           SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) posted
      FROM purchase_invoices WHERE status<>'voided' AND ${plain.org}`, ...plain.params)
  const st = one(`
    SELECT COUNT(*) total, COALESCE(SUM(settle_amount),0) amount,
           COALESCE(SUM(paid_amount),0) paid,
           COALESCE(SUM(settle_amount-paid_amount),0) open,
           COALESCE(SUM(diff_amount),0) diff,
           SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft,
           SUM(CASE WHEN status='audited' THEN 1 ELSE 0 END) audited,
           SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) settled
      FROM purchase_settlements WHERE status<>'voided' AND ${plain.org}`, ...plain.params)
  const pay = one(`
    SELECT COUNT(*) total, COALESCE(SUM(amount),0) amount,
           SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft,
           SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid
      FROM purchase_payments WHERE status<>'voided' AND ${plain.org}`, ...plain.params)
  const o = purchaseScopeSql(orgScope, 'o')
  const topSuppliers = db
    .prepare(
      `SELECT s.id, s.code, s.name, COUNT(o.id) order_count, COALESCE(SUM(o.total_amount),0) amount
         FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id
        WHERE o.status NOT IN ('cancelled') AND ${o.wh}
        GROUP BY s.id ORDER BY amount DESC LIMIT 8`
    )
    .all(...o.params)
  const stc = purchaseScopeSql(orgScope, 'st')
  const payable = db
    .prepare(
      `SELECT s.id, s.code, s.name,
              COALESCE(SUM(st.settle_amount),0) settle_amount,
              COALESCE(SUM(st.paid_amount),0) paid_amount,
              COALESCE(SUM(st.settle_amount-st.paid_amount),0) open_amount
         FROM purchase_settlements st JOIN suppliers s ON s.id=st.supplier_id
        WHERE st.status<>'voided' AND ${stc.org}
        GROUP BY s.id HAVING open_amount > 0.01 ORDER BY open_amount DESC LIMIT 10`
    )
    .all(...stc.params)
  const days = db
    .prepare(
      `SELECT substr(settle_date,1,10) d, COALESCE(SUM(settle_amount),0) amount
         FROM purchase_settlements WHERE status<>'voided' AND ${plain.org}
          AND settle_date >= date('now','localtime','-30 day')
        GROUP BY d ORDER BY d`
    )
    .all(...plain.params)
  return {
    requisition: req,
    order: po,
    invoice: inv,
    settlement: st,
    payment: pay,
    top_suppliers: topSuppliers,
    payable,
    trend: days
  }
}

/**
 * 把组织范围翻成采购单据查询的 SQL 谓词 —— 采购链**所有**读接口的唯一范围判据
 * （待办 / 看板 / 四张单列表 / 应付台账，ADR-0015 + ADR-0017）。
 *
 * 判据与 `middleware/auth.js` 的 `orgScopeFilter` 同源：
 *   · 不传或 `all` ⇒ `1=1`（全库）；
 *   · `dealer` / `none` / 空集合 ⇒ `1=0` 并置 `empty: true`（空范围不许变成全库；调用方可据此直接给空结果）；
 *   · 其余 ⇒ 请购 / 发票 / 结算 / 付款用自身 `org_id`（`org`），采购订单 / 退货没有组织列、
 *     经 `warehouses.org_id` 取仓的归属组织（`wh`）。两段谓词共用同一份 `params`。
 *   · 归属列为 NULL 的单据对受限范围不可见（`IN` 对 NULL 为假 —— 宁可看不到，也不放行）。
 *
 * 返回的是**完整谓词**（不带前导 AND），调用方写 `WHERE … AND ${scope.org}` 或 `cond.push(scope.org)`；
 * `alias` 给带表别名的查询用（`'i'` ⇒ `i.org_id`）。
 */
export function purchaseScopeSql(orgScope, alias = '') {
  const col = (c) => (alias ? `${alias}.${c}` : c)
  if (!orgScope || orgScope.scope === 'all') return { org: '1=1', wh: '1=1', params: [], empty: false }
  const ids = Array.isArray(orgScope.orgIds) ? orgScope.orgIds.map(Number).filter(Number.isFinite) : []
  if (orgScope.scope === 'dealer' || orgScope.scope === 'none' || !ids.length) {
    return { org: '1=0', wh: '1=0', params: [], empty: true }
  }
  const ph = ids.map(() => '?').join(',')
  return {
    org: `${col('org_id')} IN (${ph})`,
    wh: `${col('warehouse_id')} IN (SELECT id FROM warehouses WHERE org_id IN (${ph}))`,
    params: ids,
    empty: false
  }
}

/**
 * 采购单据「读」权限点（任一命中即可进门）。**唯一出处**：
 * `routes/purchase.js` 的订单 / 收货 / 退货读接口与 `routes/purchase-chain.js` 的待办接口共用，
 * 两处各抄一份的后果是"列表页进得去、工作台进不去"这种不报错的不一致。
 * dealer / store 两个外部主体在权限表里一个采购权限点都没有 —— 读接口同样要过功能权限门。
 */
export const PO_READ_PERMS = ['purchase.order.view', 'purchase.inbound', 'purchase.return']

/**
 * 待办清单：把「下一步该谁做什么」直接算出来，而不是让用户自己翻列表。
 *
 * 范围（ADR-0015）：
 *   · `orgScope`（`resolveOrgScope` 的结果）不传或 `all` ⇒ 全库（通知摘要 013 与管理员口径）；
 *     受限范围按单据归属列过滤 —— 请购 / 发票 / 结算 / 付款用自身 `org_id`，
 *     采购订单没有组织列，用 `warehouses.org_id`（仓的归属组织）；
 *     `dealer` / `none` / 空集合 ⇒ **空列表**（与 `orgScopeFilter` 同一口径：空范围不许变成全库）。
 *     归属列为 NULL 的单据对受限账号不可见（宁可看不到，也不放行）。
 *   · `permCtx`（`permContext` 的结果）传入时，只保留调用者拥有该待办 `perm` 的项 ——
 *     工作台上"能看到却点不动"的待办不是待办。
 */
export function purchaseTodos(db, { orgScope = null, permCtx = null } = {}) {
  const todos = []
  const scope = purchaseScopeSql(orgScope)
  if (scope.empty) return todos
  for (const r of db
    .prepare(`SELECT doc_no,id,total_amount FROM purchase_requisitions WHERE status='submitted' AND ${scope.org} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'req_approve', doc_type: 'PRQ', doc_id: r.id, doc_no: r.doc_no, label: '请购单待审批', amount: r.total_amount, perm: 'purchase.req.approve' })
  }
  for (const r of db
    .prepare(`SELECT doc_no,id,total_amount FROM purchase_requisitions WHERE status='approved' AND ${scope.org} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'req_convert', doc_type: 'PRQ', doc_id: r.id, doc_no: r.doc_no, label: '请购单待转采购订单', amount: r.total_amount, perm: 'purchase.order.edit' })
  }
  for (const r of db
    .prepare(`SELECT doc_no,id,total_amount FROM purchase_orders WHERE status='submitted' AND ${scope.wh} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'po_approve', doc_type: 'PO', doc_id: r.id, doc_no: r.doc_no, label: '采购订单待审批', amount: r.total_amount, perm: 'purchase.order.approve' })
  }
  for (const r of db
    .prepare(
      `SELECT doc_no,id,total_amount FROM purchase_orders
        WHERE status IN ('approved') AND close_arrival=0 AND ${scope.wh} ORDER BY id DESC LIMIT 20`
    )
    .all(...scope.params)) {
    todos.push({ kind: 'po_receive', doc_type: 'PO', doc_id: r.id, doc_no: r.doc_no, label: '采购订单待到货', amount: r.total_amount, perm: 'purchase.inbound' })
  }
  for (const r of db
    .prepare(`SELECT doc_no,id,total_amount FROM purchase_invoices WHERE status='submitted' AND ${scope.org} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'invoice_verify', doc_type: 'PI', doc_id: r.id, doc_no: r.doc_no, label: '采购发票待校验', amount: r.total_amount, perm: 'purchase.invoice.verify' })
  }
  for (const r of db
    .prepare(`SELECT doc_no,id,settle_amount AS total_amount FROM purchase_settlements WHERE status='submitted' AND ${scope.org} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'settle_audit', doc_type: 'PST', doc_id: r.id, doc_no: r.doc_no, label: '采购结算待审核', amount: r.total_amount, perm: 'purchase.settle.audit' })
  }
  for (const r of db
    .prepare(`SELECT doc_no,id,amount AS total_amount FROM purchase_payments WHERE status='approved' AND ${scope.org} ORDER BY id DESC LIMIT 20`)
    .all(...scope.params)) {
    todos.push({ kind: 'payment_pay', doc_type: 'PAY', doc_id: r.id, doc_no: r.doc_no, label: '付款单待执行', amount: r.total_amount, perm: 'purchase.payment.approve' })
  }
  if (!permCtx) return todos
  return todos.filter((x) => hasPerm(permCtx, x.perm))
}

/** 单据当前可执行动作（把状态机出边翻译成带中文名的按钮） */
export function purchaseActions(db, docType, id, perms = null) {
  const map = {
    PRQ: 'purchase_requisitions',
    PI: 'purchase_invoices',
    PST: 'purchase_settlements',
    PAY: 'purchase_payments',
    PO: 'purchase_orders',
    GR: 'purchase_receipts'
  }
  const table = map[docType]
  if (!table) throw new PurchaseError(`不支持的单据类型 ${docType}`, { code: 'BAD_DOC_TYPE' })
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
  if (!row) throw new PurchaseError('单据不存在', { code: 'DOC_NOT_FOUND', httpStatus: 404 })
  return allowedActions(db, docType, row.status, { perms })
}

export { DocFlowError }

// ---------------------------------------------------------------------------
// 九、采购订单与收货（HTTP 路由与 MCP 工具共用同一份实现）
//
// 为什么把这段从 `routes/purchase.js` 搬下来（批次 K · D5 收口）：
//   采购订单的建单 / 收货 / 状态推进原来**只存在于路由文件里**（内联 SQL + 内联事务）。
//   于是 MCP 想暴露「建采购订单」只有两条路：抄一遍（=同一件事两个实现），
//   或者不做（=能力缺口）。D5 的结论是第三条：**抽成领域服务，两个入口都调它**。
//   「入口可以有两个，实现只能有一份」—— 抄一遍那一刻是对的，之后只会改一处。
// ---------------------------------------------------------------------------

const PO_SELECT = `
  po.*, s.name AS supplier_name, s.code AS supplier_code, s.settle_type AS supplier_settle,
  w.name AS warehouse_name, (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = po.id) AS item_count
`
const PO_FROM =
  'purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN warehouses w ON w.id=po.warehouse_id'

/**
 * 采购订单的投影与 FROM 子句（**导出**，给列表查询与详情共用）。
 *
 * 为什么不再只是本文件的私有常量：列表页 `GET /api/purchase/orders` 也要用它们，
 * 而"列表一份列清单、详情另一份"正是**同一个东西两处定义**的老形状。
 * 本批把 `loadOrder` 下沉到 lib 时忘了同步这两个常量，列表接口当场 500
 * （`ReferenceError: PO_SELECT is not defined`）—— 被 `smoke-api` 与 `test-guards` 同时抓到。
 * 教训：**搬代码的时候，要连它引用的常量一起搬**，而不是只搬函数体。
 */
export const PURCHASE_ORDER_SELECT = PO_SELECT
export const PURCHASE_ORDER_FROM = PO_FROM

/** 采购订单详情（含明细与收货单），与界面看到的是同一份 */
export function getPurchaseOrder(db, id) {
  const order = db.prepare(`SELECT ${PO_SELECT} FROM ${PO_FROM} WHERE po.id=?`).get(id)
  if (!order) return null
  order.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, p.name AS product_name, p.spec AS product_spec, b.name AS brand_name
       FROM purchase_order_items i
       JOIN product_skus sk ON sk.id=i.sku_id
       JOIN products p ON p.id=sk.product_id
       LEFT JOIN brands b ON b.id=p.brand_id
       WHERE i.order_id=? ORDER BY i.id`
    )
    .all(id)
  order.receipts = db.prepare('SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id').all(id)
  return order
}

/**
 * 采购订单单头汇总重算（唯一实现）。
 * 落库前的总额非负断言留在这里：行级单价已校验非负，这里是"万一"——
 * 一张 total_amount = -5 的采购单会一路污染账龄、成本与报表，而没有任何一处会报错。
 */
export function recalcOrder(db, id) {
  const agg = db
    .prepare('SELECT COALESCE(SUM(qty),0) qty, COALESCE(SUM(amount),0) amt FROM purchase_order_items WHERE order_id=?')
    .get(id)
  const tax = db
    .prepare('SELECT COALESCE(SUM(amount * tax_rate / 100.0),0) t FROM purchase_order_items WHERE order_id=?')
    .get(id)
  if (Number(agg.amt) < -0.001) {
    const err = new Error(`采购订单金额为负（${agg.amt}），请检查明细单价`)
    err.status = 400
    throw err
  }
  db.prepare(
    "UPDATE purchase_orders SET total_qty=?, total_amount=?, tax_amount=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(agg.qty, Number(agg.amt.toFixed(2)), Number(tax.t.toFixed(2)), id)
}

/** 采购订单行级校验（唯一实现）：建单与改单共用 —— 「只在 create 上拦」等于没拦 */
export function normalizePurchaseOrderLines(db, items = []) {
  const lines = []
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    const at = `第 ${i + 1} 行`
    if (!it.sku_id) throw new PurchaseError(`${at}：请选择采购商品`, { code: 'PO_LINE_NO_SKU' })
    if (!db.prepare('SELECT id FROM product_skus WHERE id=?').get(Number(it.sku_id))) {
      throw new PurchaseError(`${at}：商品 SKU#${it.sku_id} 不存在，请重新选择`, { code: 'PO_LINE_SKU_NOT_FOUND' })
    }
    const q = numQty(it.qty, `${at}采购数量`)
    if (!q.ok) throw new PurchaseError(q.message, { code: 'PO_LINE_BAD_QTY' })
    const p = numAmount(it.price, `${at}采购单价`)
    if (!p.ok) throw new PurchaseError(p.message, { code: 'PO_LINE_BAD_PRICE' })
    const tax = numField(it.tax_rate, { name: `${at}税率`, min: 0, max: 100, decimals: 2 })
    if (!tax.ok) throw new PurchaseError(tax.message, { code: 'PO_LINE_BAD_TAX' })
    lines.push({
      sku_id: Number(it.sku_id),
      qty: q.value,
      price: p.value ?? 0,
      tax_rate: tax.value ?? 13,
      remark: it.remark || null
    })
  }
  return lines
}

/** 建采购订单（草稿）。返回完整订单对象。 */
export function createPurchaseOrder(db, p = {}) {
  const {
    supplierId, warehouseId, orderDate = null, expectDate = null, items = [], remark = null,
    settleType = null, fulfillType = 'hq', targetStoreId = null, targetWarehouseId = null,
    sourceType = 'manual', actor = {}
  } = p
  if (!supplierId) throw new PurchaseError('请选择供应商', { code: 'PO_NO_SUPPLIER' })
  if (!['hq', 'direct'].includes(fulfillType)) throw new PurchaseError('履约方式不合法', { code: 'PO_BAD_FULFILL' })
  // 直运门店仓时收货仓取门店仓，否则取总部入库仓
  const inboundWhId = fulfillType === 'direct' ? targetWarehouseId || warehouseId : warehouseId
  if (!inboundWhId) {
    throw new PurchaseError(fulfillType === 'direct' ? '请选择直运门店仓' : '请选择收货仓库', {
      code: 'PO_NO_WAREHOUSE'
    })
  }
  const inboundRole = fulfillType === 'direct' ? '直运门店仓' : '收货仓库'
  const inboundWh = assertWarehouseUsable(db, inboundWhId, { role: inboundRole, required: true })
  // 单据类型 → 允许仓库（默认 `*` = 不限）。采购订单的入库走 PUR_IN。
  assertWarehouseAllowedForDoc(db, { docType: 'PUR_IN', warehouse: inboundWh, role: inboundRole })
  if (!Array.isArray(items) || !items.length) {
    throw new PurchaseError('请至少添加一行采购商品', { code: 'PO_NO_LINES' })
  }
  const lines = normalizePurchaseOrderLines(db, items)
  // 单据日期兜底，避免未传日期时触发 NOT NULL 约束错误
  const poDate = String(orderDate || '').trim() || localDate()
  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'PO', bizDate: poDate, warehouseId: inboundWhId })
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (doc_no,supplier_id,warehouse_id,order_date,expect_date,buyer,status,total_qty,total_amount,tax_amount,settle_type,
                                      fulfill_type,target_store_id,target_warehouse_id,source_type,remark,created_by)
         VALUES (?,?,?,?,?,?, 'draft',0,0,0,?,?,?,?,?,?,?)`
      )
      .run(
        docNo, Number(supplierId), inboundWhId, poDate, expectDate || null, actor.name || null, settleType,
        fulfillType, targetStoreId || null, fulfillType === 'direct' ? inboundWhId : null, sourceType,
        remark || null, actor.id || null
      )
    const oid = info.lastInsertRowid
    const insItem = db.prepare(
      'INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount,remark) VALUES (?,?,?,?,?,?,?)'
    )
    for (const it of lines) {
      insItem.run(oid, it.sku_id, it.qty, it.price, it.tax_rate, Number((it.qty * it.price).toFixed(2)), it.remark)
    }
    recalcOrder(db, oid)
    return oid
  })
  const id = tx()
  return getPurchaseOrder(db, id)
}

/**
 * 「这一步只能走带参数的业务入口」——状态改得动、账却不动的动作，一律在这里拦下。
 *
 * 为什么需要它：单据内核里的**边是"状态之间"的事**，而有些动作的**全部意义在参数上**。
 *   · PRQ.`convert`：转单要"转到哪张订单、转哪些行、哪个供应商/仓"——简化入口只有三个字段，
 *     只改状态会造出「请购单显示已转单、`purchase_orders` 里查不到」；
 *   · PO.`receive` / `partial`：收货的后果是**库存与成本**（批次、成本流水、最近成交价），
 *     只翻状态就是「订单显示已收货、仓库里没这批货」。
 *
 * **判据必须只有一份，且必须在"两个入口都会经过的那一层"。** 这条原来只写在 MCP 那一层
 * （`mcp/tools.js` 的 `PARAM_ONLY_ACTION` + `assertNotParamOnly`，注释自认"判据放在 MCP 这一层"），
 * 于是 HTTP 入口 `POST /api/purchase/orders/:id/status {"action":"receive"}` 一路 200、
 * 订单变「已收货」而 `received_qty=0`、没有收货单也没有库存 —— 状态对了、账不对。
 * 现在这一份定义在领域层，HTTP / MCP / 通用流转入口三条路都调它，
 * 同一个动作在哪条路上被拒，**码与文案逐字相同**（这就是"同一份实现"的可观测证据）。
 */
const PARAM_ONLY_ACTION = {
  'PRQ:convert': 'purchase.convert_requisition',
  'PO:receive': 'purchase.receive_order',
  'PO:partial': 'purchase.receive_order'
}

/** 见上。`docType:action` 命中即拒绝，并指路该走哪个业务入口。 */
export function assertNotParamOnly(docType, action) {
  const tool = PARAM_ONLY_ACTION[`${docType}:${action}`]
  if (!tool) return
  throw new DocFlowError(
    `「${action}」的后果不在状态上（转单要指定行与供应商/仓；收货要写库存与成本），` +
      `简化入口做不了。请调用 ${tool}。`,
    {
      code: 'EFFECT_REQUIRES_BUSINESS_API',
      httpStatus: 409,
      detail: { docType, action, entry: tool }
    }
  )
}

/**
 * 采购订单状态推进（唯一实现）。合法边来自内核 doc_actions，不在路由里写 if。
 *
 * @param permCtx 功能权限上下文（`permContext(db, req.user)`）。
 *   **边权限检查挂在这里而不是某个入口**：HTTP 与 MCP 都调用本函数，
 *   MCP 入口在调用前另有一道 `gatePurchaseEdge`（同一个 `assertEdgePermitted`），
 *   HTTP 入口原来**一道都没有** —— 实测 warehouse 角色能 approve 采购订单，
 *   而同一角色在请购单上会 403（请购那条线在 `routes/purchase-chain.js` 判了）。
 *   不传 permCtx（内部调用）即不判，行为与从前一致。
 */
export function transitionPurchaseOrder(db, { id, action, actor = {}, set = {}, remark = null, source = 'api', permCtx = null }) {
  const head = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!head) throw new PurchaseError('采购订单不存在', { code: 'PO_NOT_FOUND', httpStatus: 404 })
  // ① 有后果的动作必须走带参数的业务入口（收货要写库存与成本，只翻状态做不了）
  assertNotParamOnly('PO', action)
  // ② 边权限：与请购单/通用入口用的是**同一个** assertEdgePermitted
  if (permCtx) {
    assertEdgePermitted({
      db,
      docType: 'PO',
      fromState: head.status,
      action: String(action),
      permCtx,
      entry: 'POST /api/purchase/orders/:id/status'
    })
  }
  const r = applyTransition({
    db, docType: 'PO', id, action, actor: { id: actor.id, name: actor.name },
    set: { ...set }, remark, source
  })
  return { ...r, order: getPurchaseOrder(db, id) }
}

/**
 * 采购收货入库（唯一实现）。
 *
 * 三件事在同一条链上：生成收货单 → 批次入库（成本流水）→ 推进订单状态。
 * 原来这三件事只写在路由里，MCP 想"收货"就只能抄 —— 而收货会写库存与成本，
 * 抄错的代价是账实不符，而不是报错。
 *
 * @param items [{ id?, sku_id, qty, price?, batch_no?, produce_date?, expire_date? }]
 */
export function receivePurchaseOrder(db, p = {}) {
  const {
    orderId, items = [], inspector = null, remark = null, receiptDate = null,
    actor = {}, source = 'api'
  } = p
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(orderId)
  if (!order) throw new PurchaseError('采购订单不存在', { code: 'PO_NOT_FOUND', httpStatus: 404 })
  if (!['submitted', 'approved'].includes(order.status)) {
    throw new PurchaseError('只有已提交/已审批的订单可以收货', { code: 'PO_NOT_RECEIVABLE', httpStatus: 409 })
  }
  // 收货日期缺省取今天。以前直接拿 req.body.receipt_date 插库，
  // 调用方不传就撞 NOT NULL 约束报 500 —— 缺一个可选字段不该是服务端错误。
  const date = ymd(receiptDate || new Date())
  const detail = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name FROM purchase_order_items i
       JOIN product_skus sk ON sk.id=i.sku_id WHERE i.order_id=?`
    )
    .all(orderId)
  if (!detail.length) throw new PurchaseError('订单没有明细，无法收货', { code: 'PO_NO_DETAIL' })

  const payload = items && items.length
    ? items
    : detail.map((d) => ({ id: d.id, sku_id: d.sku_id, qty: d.qty - d.received_qty, price: d.price }))
  // 收货数量必须过与建单**同一份**校验器（numQty：>0 且最多 4 位小数）。
  // 原来 HTTP 入口把 req.body.items 原样传下来，`qty=1.23456789` 能收 200 件并落库 ——
  // 而同一判据在采购订单建单那侧（normalizePurchaseOrderLines）是拦的。
  // 空/0 行不算错（默认"全额收货"时，已收满的行就是 0），负数是错。
  const checked = []
  payload.forEach((l, i) => {
    const raw = l.qty
    if (raw === 0 || raw == null || raw === '') {
      checked.push({ ...l, qty: 0 })
      return
    }
    const n = numQty(raw, `第 ${i + 1} 行收货数量`)
    if (!n.ok) throw new PurchaseError(n.message, { code: 'PO_BAD_RECEIVE_QTY' })
    checked.push({ ...l, qty: n.value })
  })
  // 超量控制（用友口径：超量控制 + 超上限比例）——
  // 在**写库之前**拦，而不是事后回滚：多收的货已经入过库再撤销，库存流水会多出一进一出两条。
  // 带着行号一起判：同 SKU 多行的订单必须按**行**算额度（见 checkOverReceive）。
  const overIssues = checkOverReceive(db, {
    orderId,
    lines: checked.map((l) => ({ id: l.id, order_item_id: l.order_item_id, sku_id: l.sku_id, qty: Number(l.qty || 0) }))
  }).filter((i) => i.level === 'block')
  if (overIssues.length) {
    throw new PurchaseError(overIssues[0].message, { code: 'PO_OVER_RECEIVE', httpStatus: 409, detail: overIssues })
  }
  // 直运门店仓：收货直接入门店仓；总部入库：入订单指定仓
  const inboundWhId =
    order.fulfill_type === 'direct' && order.target_warehouse_id ? order.target_warehouse_id : order.warehouse_id
  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'GR', bizDate: date, warehouseId: inboundWhId })
    const info = db
      .prepare(
        `INSERT INTO purchase_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,inspector,remark,created_by,req_id)
         VALUES (?,?,?,?,?,'draft',0,0,?,?,?,?)`
      )
      .run(
        docNo, orderId, order.supplier_id, inboundWhId, date, inspector || null, remark || null,
        actor.id || null, order.req_id || null
      )
    const rid = info.lastInsertRowid
    const insItem = db.prepare(
      'INSERT INTO purchase_receipt_items (receipt_id,sku_id,batch_no,produce_date,expire_date,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
    )
    let totalQty = 0
    let totalAmt = 0
    for (const line of checked) {
      const qty = Number(line.qty || 0)
      if (qty <= 0) continue
      const src = detail.find((d) => d.id === line.id) || detail.find((d) => d.sku_id === line.sku_id)
      if (!src) continue
      const price = Number(line.price ?? src.price ?? 0)
      const batchNo = line.batch_no || nextBatchNo(src.sku_code, date)
      insItem.run(rid, src.sku_id, batchNo, line.produce_date || null, line.expire_date || null, qty, price, Number((qty * price).toFixed(2)))
      applyStockIn(db, {
        bizDate: date,
        docType: 'PUR_IN',
        docNo,
        docId: rid,
        warehouseId: inboundWhId,
        skuId: src.sku_id,
        batchNo,
        produceDate: line.produce_date,
        expireDate: line.expire_date,
        qty,
        unitCost: price,
        counterparty: order.doc_no,
        operator: actor.name || null,
        remark: '采购收货入库',
        // 供应商要落到批次上：批次主档没有供应商，追溯批次就回答不了「这批是从谁买的」
        supplierId: order.supplier_id
      })
      // 回写「该供应商对该商品的最近成交价」，供后续取价链的第二档使用
      touchSupplierLastPrice(db, {
        supplierId: order.supplier_id, skuId: src.sku_id, price, docNo, operator: actor.name || null
      })
      db.prepare('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id=?').run(qty, src.id)
      totalQty += qty
      totalAmt += qty * price
    }
    db.prepare('UPDATE purchase_receipts SET total_qty=?, total_amount=? WHERE id=?').run(totalQty, Number(totalAmt.toFixed(2)), rid)
    // 收货单走单据内核：draft → received。
    // 以前是直接以 status='received' 插库，GR 的状态机成了「死定义」——
    // 有状态机但没有任何流转，等于这张单没有留痕。
    applyTransition({
      db, docType: 'GR', id: rid, action: 'confirm',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: `由采购订单 ${order.doc_no} 收货`, source
    })
    const pend = db
      .prepare('SELECT COALESCE(SUM(qty - received_qty),0) p FROM purchase_order_items WHERE order_id=?')
      .get(orderId).p
    // 收货推进采购单状态：全部收满 → 已收货；仍有欠交 → 部分收货（停留原状态但留痕）
    applyTransition({
      db, docType: 'PO', id: orderId, action: pend <= 0.0001 ? 'receive' : 'partial',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: `收货单 ${docNo}，本次 ${totalQty} 件`, source
    })
    recalcOrder(db, orderId)
    // 四段关闭里的「到货关闭」：全部收满即自动关闭该环节
    refreshCloseFlags(db, orderId)
    refreshOrderStats(db, orderId)
    return rid
  })
  const receiptId = tx()
  return { receipt_id: receiptId, order: getPurchaseOrder(db, orderId) }
}

// ---------------------------------------------------------------------------
// 流转效果归属登记（027 / A01）
//
// 采购域这四张单的流转有业务后果（生成订单、形成应付、重算已付金额），
// 通用流转入口 `POST /api/docflow/transition` 不能只改状态就算完。
// 登记之后两个入口走**同一段代码** —— 不是"在通用入口里再抄一遍副作用"。
//
// 登记放在模块加载时（而不是启动流程里）：只要这个模块被 import 过就一定生效，
// 不会出现「忘了调注册函数」这种静默失效。
// ---------------------------------------------------------------------------
claimTransitionEffect(
  'PRQ',
  (db, p) =>
    transitionRequisition(db, {
      id: p.id, action: p.action, actor: p.actor, set: p.set,
      remark: p.remark, source: p.source, expectFrom: p.expectFrom
    }),
  { entry: 'POST /api/purchase/requisitions/:id/:action' }
)
claimTransitionEffect(
  'PI',
  (db, p) =>
    transitionInvoice(db, {
      id: p.id, action: p.action, actor: p.actor, set: p.set, remark: p.remark, source: p.source
    }),
  { entry: 'POST /api/purchase/invoices/:id/:action' }
)
claimTransitionEffect(
  'PST',
  (db, p) =>
    transitionSettlement(db, {
      id: p.id, action: p.action, actor: p.actor, set: p.set, remark: p.remark, source: p.source
    }),
  { entry: 'POST /api/purchase/settlements/:id/:action' }
)
claimTransitionEffect(
  'PAY',
  (db, p) =>
    transitionPayment(db, {
      id: p.id, action: p.action, actor: p.actor, set: p.set, remark: p.remark, source: p.source
    }),
  { entry: 'POST /api/purchase/payments/:id/:action' }
)
