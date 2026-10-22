/**
 * ============================================================================
 * 文件标识：server/lib/quote.js ｜ 销售报价单（模块 08A）
 * ============================================================================
 * 【职责】销售报价单（模块 08A）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售报价单（模块 08A）
//
// 四条口径，写死在文件头：
//
// ① **报价是一张单，不是一条消息。**
//   价由价格中心算（模块 05A），每行都记下「价从哪来」；手改价必须留下
//   list_price（渠道标准价）与 price（成交价）两个值，折扣率由此算出，
//   不允许只有一个「最终价」—— 只有一个数，就永远说不清是不是乱报的。
//
// ② **有效期是硬约束，不是提示。**
//   过了 valid_to 的报价不能转单（QUOTE_EXPIRED）。原料一天一个价，
//   三个月的老报价还能转成订单，等于把定价权交给了历史数据。
//
// ③ **审批是闸门，不是走过场。**
//   低于最低限价 / 折得比客户政策更狠 / 金额超阈值 → 必须审批才能转单。
//   审批结论记在单上（need_approval + approval_reason），不是记在聊天记录里。
//
// ④ **转单是唯一有后果的动作，且只能转一次。**
//   converted 是终态：一张已审批报价只能转成一张订单。报价要改价，
//   复制出新版本（source_quote_id + version），不改已经报出去的那张。

import { getDb } from '../db/index.js'
import { localDate, localNow, addDays } from './dates.js'
import { resolvePrice } from './pricing.js'
import { applyTransition } from './docflow.js'
import { nextDocNoAuto } from './docno.js'
import { checkCredit } from './credit.js'
import { readSetting } from './settings.js'
import { createOrder } from './order-center.js'

export class QuoteError extends Error {
  constructor(message, { code = 'QUOTE_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'QuoteError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

export const QUOTE_STATUS = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已审批',
  rejected: '已驳回',
  converted: '已转单',
  expired: '已过期',
  cancelled: '已取消'
}

export const CUSTOMER_TYPE = { dealer: '经销商', oc: '订货客户', store: '门店' }

// 审批金额阈值与报价有效期：`settings['quote.approval_amount']` / `settings['quote.valid_days']`。
// 这两个键在批次 R 之前同样属于"代码读、库里没有"的幽灵配置 —— 默认值不再写在这里，
// 唯一出处是 `lib/settings.js` 的 `SETTING_RULES`（含"必须大于 0"这条值域，
// 原来它是靠本文件那个私有 `setting()` 里的 `v > 0` 隐式实现的）。

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
// 「今天」与日期加法统一走 dates.js。原来 today() 取的是 UTC 日期、
// addDays 又在本地零点上加天数再用 toISOString() 取回，
// 结果「报价有效期 30 天」在东八区一律短一天，且不会有任何断言发现。
const today = () => localDate()
const nowStr = () => localNow()

// 日期加法已收敛到 dates.js 的 addDays（见文件头 import）

// ---------------------------------------------------------------------------
// 一、取价：报价行怎么算出来的
// ---------------------------------------------------------------------------

/** 客户档案 → 取价上下文（渠道 / 经销商等级 / 区域） */
function priceContext(db, { customerType, dealerId, customerId, storeId, channel }) {
  const ctx = { channel: channel || 'direct', storeType: null, dealerLevel: null, region: null, orgId: null }
  const dealer = dealerId ? db.prepare('SELECT * FROM dealers WHERE id=?').get(dealerId) : null
  if (dealer) {
    ctx.channel = channel || 'dealer'
    ctx.dealerLevel = dealer.level || null
    ctx.region = dealer.region || null
    ctx.orgId = dealer.org_id ?? null
  }
  if (storeId) {
    const s = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId)
    if (s) {
      ctx.channel = channel || (s.type === 'franchise' ? 'franchise' : 'pos')
      ctx.storeType = s.type || null
      ctx.region = s.region || s.city || null
      ctx.orgId = s.org_id ?? s.id
    }
  }
  if (customerId && !dealer) {
    const c = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(customerId)
    if (c) {
      ctx.channel = channel || c.channel || 'dealer'
      ctx.region = c.region || null
      ctx.orgId = c.org_id ?? null
      if (c.source_type === 'dealer' && c.source_id) {
        const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(c.source_id)
        if (d) {
          ctx.dealerLevel = d.level || null
          ctx.region = d.region || ctx.region
        }
      }
    }
  }
  if (customerType === 'store' && !ctx.storeType) ctx.channel = ctx.channel || 'pos'
  return ctx
}

/**
 * 挂牌价（折扣的分母）：统一取标准零售价，不按渠道取。
 *   按渠道取（经销商用经销价）会得到「成交价 ÷ 经销价」这个内部口径 ——
 *   同一张单给经销商和给门店算出两个不同的折扣率，没法横向比；
 *   而统一以零售标价作分母时，「成交价高于挂牌价」这种异常会立刻暴露成折扣率 > 100%，
 *   正是我们要在审批前看见的东西。
 */
function listPriceOf(sku) {
  return Number(sku.price_retail || sku.price_dealer || sku.price_member || 0)
}

/**
 * 逐行取价（不落库）。前端「新增报价」时先调它看价，确认后再建单。
 * @returns { lines, goods_amount, total_amount, gross_rate, below_min_count, need_approval, approval_reason }
 */
export function priceQuote(db, {
  items = [], customerType = 'dealer', dealerId = null, customerId = null,
  storeId = null, channel = null, warehouseId = null, freight = 0, taxRate = 0, at = null
} = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new QuoteError('请至少添加一行报价商品', { code: 'NO_ITEMS', httpStatus: 400 })
  }
  const ctx = priceContext(db, { customerType, dealerId, customerId, storeId, channel })
  const lines = []
  let goods = 0
  let below = 0

  items.forEach((it, i) => {
    const skuId = Number(it.sku_id || it.skuId)
    const qty = Number(it.qty || 0)
    const sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(skuId)
    if (!sku) throw new QuoteError(`SKU#${skuId} 不存在`, { code: 'SKU_NOT_FOUND', httpStatus: 404 })
    if (!(qty > 0)) throw new QuoteError(`第 ${i + 1} 行数量必须大于 0`, { code: 'BAD_QTY', httpStatus: 400 })

    const r = resolvePrice(db, { skuId, orgId: ctx.orgId, channel: ctx.channel, storeType: ctx.storeType, dealerLevel: ctx.dealerLevel, region: ctx.region, qty, at })
    const list = listPriceOf(sku)
    // 允许手工改价，但必须与系统价同时存在：改了多少、为什么，一眼能看出来
    const price = it.price != null && Number(it.price) > 0 ? round2(it.price) : round2(r.price)
    const minPrice = Number(sku.price_min || 0)
    const isBelow = minPrice > 0 && price + 1e-6 < minPrice
    if (isBelow) below += 1
    const amount = round2(price * qty)
    goods = round2(goods + amount)

    let avail = null
    if (warehouseId) {
      // 可用量口径与订货中心一致：现存量 − 冻结量 + 在途量（不减待发货量，
      // 待发货量是「已确认未发」的口径，属于已被占掉的货，这里只看物理能不能供）
      const row = db
        .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved + qty_in_transit),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
        .get(warehouseId, skuId)
      avail = round2(row?.a || 0)
    }

    lines.push({
      line_no: i + 1,
      sku_id: skuId,
      sku_code: sku.sku_code,
      sku_name: sku.name,
      spec: sku.spec,
      qty,
      list_price: list,
      price,
      price_source: r.source,
      price_rule: r.rule,
      price_group_id: r.groupId ?? null,
      price_trace: Array.isArray(r.trace) ? r.trace.join(' → ') : null,
      discount_rate: list > 0 ? Number(((price / list) * 100).toFixed(2)) : 100,
      amount,
      min_price: minPrice,
      below_min: isBelow ? 1 : 0,
      available_qty: avail,
      overridden: it.price != null && Number(it.price) > 0 && Math.abs(round2(it.price) - round2(r.price)) > 0.005
    })
  })

  const freightAmt = round2(freight)
  const taxAmount = round2((goods * Number(taxRate || 0)) / 100)
  const total = round2(goods + freightAmt + taxAmount)
  const listTotal = round2(lines.reduce((s, l) => s + l.list_price * l.qty, 0))
  const grossRate = listTotal > 0 ? Number(((goods / listTotal) * 100).toFixed(2)) : 100

  // 审批条件：低于最低限价 / 折得比客户政策更狠 / 金额超阈值
  const reasons = []
  if (below > 0) reasons.push(`有 ${below} 行低于最低限价`)
  const dealer = dealerId ? db.prepare('SELECT * FROM dealers WHERE id=?').get(dealerId) : null
  const policyRate = dealer ? Number(dealer.discount_rate || 100) : null
  if (policyRate != null && grossRate + 1e-6 < policyRate) {
    reasons.push(`整单折扣 ${grossRate}% 低于客户政策折扣 ${policyRate}%`)
  }
  const amtThreshold = readSetting(db, 'quote.approval_amount')
  if (total >= amtThreshold) reasons.push(`报价金额 ${total} 达到审批阈值 ${amtThreshold}`)

  return {
    lines,
    goods_amount: goods,
    freight: freightAmt,
    tax_rate: Number(taxRate || 0),
    tax_amount: taxAmount,
    total_amount: total,
    gross_rate: grossRate,
    below_min_count: below,
    need_approval: reasons.length ? 1 : 0,
    approval_reason: reasons.length ? reasons.join('；') : null,
    price_context: ctx
  }
}

// ---------------------------------------------------------------------------
// 二、建单 / 查询
// ---------------------------------------------------------------------------

export function createQuote(db, {
  customerType = 'dealer', dealerId = null, customerId = null, storeId = null,
  channel = null, warehouseId = null, currency = 'CNY',
  quoteDate = null, validFrom = null, validTo = null, validDays = null,
  items = [], freight = 0, taxRate = 0, remark = null,
  actor = null, source = 'api', sourceQuoteId = null
} = {}) {
  const q = priceQuote(db, { items, customerType, dealerId, customerId, storeId, channel, warehouseId, freight, taxRate })
  const d = quoteDate || today()
  const from = validFrom || d
  const to = validTo || addDays(from, validDays || readSetting(db, 'quote.valid_days'))
  if (String(to) < String(from)) {
    throw new QuoteError('有效期止不能早于有效期起', { code: 'BAD_VALID_RANGE', httpStatus: 400 })
  }

  let version = 1
  if (sourceQuoteId) {
    const src = db.prepare('SELECT * FROM sales_quotes WHERE id=?').get(sourceQuoteId)
    if (!src) throw new QuoteError(`来源报价 #${sourceQuoteId} 不存在`, { code: 'SOURCE_NOT_FOUND', httpStatus: 404 })
    version = Number(src.version || 1) + 1
  }

  const docNo = nextDocNoAuto(db, { docType: 'QT', bizDate: d })
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO sales_quotes
          (doc_no,source_quote_id,version,customer_type,dealer_id,customer_id,store_id,channel,warehouse_id,currency,
           quote_date,valid_from,valid_to,status,goods_amount,discount_amount,freight,tax_rate,tax_amount,total_amount,
           gross_rate,below_min_count,need_approval,approval_reason,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,0,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`
      )
      .run(
        docNo, sourceQuoteId, version, customerType, dealerId || null, customerId || null, storeId || null,
        channel || q.price_context.channel, warehouseId || null, currency,
        d, from, to,
        q.goods_amount, round2(freight), Number(taxRate || 0), q.tax_amount, q.total_amount,
        q.gross_rate, q.below_min_count, q.need_approval, q.approval_reason,
        remark || null, actor?.id || null, actor?.name || null
      )
    const id = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      `INSERT INTO sales_quote_items
        (quote_id,line_no,sku_id,qty,list_price,price,price_source,price_rule,price_group_id,discount_rate,amount,min_price,below_min,available_qty,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    for (const l of q.lines) {
      insItem.run(
        id, l.line_no, l.sku_id, l.qty, l.list_price, l.price, l.price_source, l.price_rule,
        l.price_group_id, l.discount_rate, l.amount, l.min_price, l.below_min, l.available_qty, null
      )
    }
    db.prepare(
      `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,payload_json,created_at)
       VALUES ('QT',?,?,'create','创建报价',NULL,'draft',?,?,?,?,?,datetime('now','localtime'))`
    ).run(
      id, docNo, actor?.id ?? null, actor?.name ?? null, source,
      q.need_approval ? `待审批：${q.approval_reason}` : '免审批',
      JSON.stringify({ total: q.total_amount, gross_rate: q.gross_rate, below_min: q.below_min_count })
    )
    return id
  })
  return getQuote(db, tx())
}

const Q_SELECT = `
  q.*, d.name AS dealer_name, d.code AS dealer_code, d.level AS dealer_level,
  s.name AS store_name, c.name AS customer_name, w.name AS warehouse_name,
  (SELECT COUNT(*) FROM sales_quote_items i WHERE i.quote_id=q.id) AS item_count
`
const Q_FROM = `
  sales_quotes q
  LEFT JOIN dealers d ON d.id=q.dealer_id
  LEFT JOIN stores s ON s.id=q.store_id
  LEFT JOIN oc_customers c ON c.id=q.customer_id
  LEFT JOIN warehouses w ON w.id=q.warehouse_id
`

export function getQuote(db, id) {
  const q = db.prepare(`SELECT ${Q_SELECT} FROM ${Q_FROM} WHERE q.id=?`).get(Number(id))
  if (!q) return null
  q.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.price_retail, sk.price_min, p.name AS product_name
       FROM sales_quote_items i
       JOIN product_skus sk ON sk.id=i.sku_id
       JOIN products p ON p.id=sk.product_id
       WHERE i.quote_id=? ORDER BY i.line_no`
    )
    .all(q.id)
  q.expired = q.valid_to < today() && !['converted', 'expired', 'cancelled'].includes(q.status)
  q.converted = !!q.converted_order_id
  return q
}

export function listQuotes(db, {
  status = null, customerType = null, dealerId = null, customerId = null,
  keyword = null, validOnly = false, page = 1, pageSize = 20
} = {}) {
  const conds = []
  const params = []
  if (status) { conds.push('q.status=?'); params.push(status) }
  if (customerType) { conds.push('q.customer_type=?'); params.push(customerType) }
  if (dealerId) { conds.push('q.dealer_id=?'); params.push(dealerId) }
  if (customerId) { conds.push('q.customer_id=?'); params.push(customerId) }
  if (validOnly) { conds.push("q.status='approved'"); conds.push('q.valid_to >= ?'); params.push(today()) }
  if (keyword) {
    conds.push('(q.doc_no LIKE ? OR d.name LIKE ? OR s.name LIKE ? OR c.name LIKE ?)')
    const kw = `%${keyword}%`
    params.push(kw, kw, kw, kw)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM ${Q_FROM} ${where}`).get(...params).c
  const rows = db
    .prepare(`SELECT ${Q_SELECT} FROM ${Q_FROM} ${where} ORDER BY q.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize))
  return {
    rows: rows.map((r) => ({ ...r, expired: r.valid_to < today() && !['converted', 'expired', 'cancelled'].includes(r.status) })),
    total,
    page: Number(page),
    pageSize: Number(pageSize)
  }
}

// ---------------------------------------------------------------------------
// 三、流转：提交 / 审批 / 驳回 / 取消 / 过期
// ---------------------------------------------------------------------------

/** 报价流转。需审批的单在 submit 时把审批结论落到单上（审批流本身走模块 22） */
export function transitionQuote(db, { id, action, actor = null, remark = null, source = 'api' }) {
  const q = db.prepare('SELECT * FROM sales_quotes WHERE id=?').get(Number(id))
  if (!q) throw new QuoteError(`报价单 #${id} 不存在`, { code: 'QUOTE_NOT_FOUND', httpStatus: 404 })

  const set = { updated_at: nowStr() }
  if (action === 'submit' && q.need_approval) {
    set.approval_reason = q.approval_reason
  }
  if (action === 'approve') {
    set.approved_by = actor?.id ?? null
    set.approved_by_name = actor?.name ?? null
    set.approved_at = nowStr()
  }
  if (action === 'convert') {
    // 转单由 convertQuote 走（要在同一事务里建订单），这里拦住直接调用
    throw new QuoteError('转单请用 convertQuote（需在同一事务内生成订单）', { code: 'USE_CONVERT', httpStatus: 400 })
  }

  const t = applyTransition({
    db, docType: 'QT', id: Number(id), action, actor, set,
    remark: remark || null, source
  })
  return { transition: t, quote: getQuote(db, id) }
}

/** 批量把过期报价置为 expired（系统动作，不是人点的按钮） */
export function expireQuotes(db, { at = null, actor = null } = {}) {
  const day = at || today()
  const rows = db
    .prepare("SELECT * FROM sales_quotes WHERE status IN ('submitted','approved') AND valid_to < ?")
    .all(day)
  let n = 0
  for (const r of rows) {
    applyTransition({
      db, docType: 'QT', id: r.id, action: 'expire', source: 'system',
      actor: actor || { id: null, name: 'system' },
      set: { updated_at: nowStr() },
      remark: `有效期至 ${r.valid_to}，已过期`
    })
    n += 1
  }
  return { expired: n }
}

// ---------------------------------------------------------------------------
// 四、转单：唯一有后果的动作
// ---------------------------------------------------------------------------

/**
 * 报价转订单。
 *   target='SO'  → 生成销售订单（沿用报价价，draft，确认时占库存与授信）
 *   target='OC'  → 生成订货单（仅订货客户；价格以订货中心当前口径重取，
 *                  因为 OC 强制按客户取价，报价单只作为意向与审批依据）
 *
 * 幂等：同一张报价已转过单就返回原单，不会转出第二张订单。
 */
export function convertQuote(db, { id, target = 'SO', actor = null, force = false, reason = null, orderDate = null, remark = null, source = 'api' }) {
  const q = getQuote(db, Number(id))
  if (!q) throw new QuoteError(`报价单 #${id} 不存在`, { code: 'QUOTE_NOT_FOUND', httpStatus: 404 })
  if (q.converted_order_id) {
    return { reused: true, quote: q, order: loadConverted(db, q), credit: null }
  }
  if (q.status !== 'approved') {
    throw new QuoteError(
      `报价单当前状态「${QUOTE_STATUS[q.status] || q.status}」，只有已审批的报价才能转单`,
      { code: 'QUOTE_NOT_APPROVED', httpStatus: 409, detail: { status: q.status } }
    )
  }
  if (String(q.valid_to) < today()) {
    throw new QuoteError(
      `报价单已于 ${q.valid_to} 过期，不能转单（可复制为新版本重新报价）`,
      { code: 'QUOTE_EXPIRED', httpStatus: 409, detail: { valid_to: q.valid_to } }
    )
  }
  if (!q.items?.length) throw new QuoteError('报价单没有明细行，无法转单', { code: 'NO_ITEMS', httpStatus: 400 })

  // 信用校验：报价阶段只做「能不能接这单」的判断，真正占用发生在订单确认
  const credit = checkCredit(db, {
    subject: { customerType: q.customer_type, dealerId: q.dealer_id, customerId: q.customer_id, storeId: q.store_id },
    amount: q.total_amount,
    scene: 'quote.convert',
    sourceType: 'QT',
    sourceId: q.id,
    docNo: q.doc_no,
    force,
    reason,
    actor
  })
  if (!credit.pass) {
    throw new QuoteError(
      `信用校验未通过：${credit.blocking.map((c) => c.message).join('；')}`,
      { code: 'CREDIT_BLOCKED', httpStatus: 409, detail: credit }
    )
  }

  const tx = db.transaction(() => {
    let order = null
    let convertedType = target
    if (target === 'OC') {
      if (q.customer_type !== 'oc' || !q.customer_id) {
        throw new QuoteError('只有订货客户（customer_type=oc）的报价才能转成订货单', { code: 'BAD_TARGET', httpStatus: 400 })
      }
      const res = createOrder(db, {
        customerId: q.customer_id,
        items: q.items.map((i) => ({ sku_id: i.sku_id, qty: i.qty })),
        remark: `由报价单 ${q.doc_no} 转单${remark ? `；${remark}` : ''}`,
        sourceRef: q.doc_no,
        source,
        actor,
        orderDate: orderDate || today()
      })
      order = { id: res.order.id, doc_no: res.order.doc_no, type: 'OC' }
    } else {
      order = buildSalesOrder(db, { q, actor, orderDate: orderDate || today(), remark, source })
      convertedType = 'SO'
    }

    applyTransition({
      db, docType: 'QT', id: q.id, action: 'convert', actor, source,
      set: {
        converted_type: convertedType,
        converted_order_id: order.id,
        converted_doc_no: order.doc_no,
        converted_at: nowStr(),
        credit_hold: 0,
        credit_checked_at: nowStr(),
        updated_at: nowStr()
      },
      remark: `转为${convertedType === 'OC' ? '订货单' : '销售订单'} ${order.doc_no}${force ? `（超信特批：${reason || ''}）` : ''}`
    })
    return { order, convertedType }
  })

  const out = tx()
  return { reused: false, quote: getQuote(db, q.id), order: out.order, credit, converted_type: out.convertedType }
}

function loadConverted(db, q) {
  if (q.converted_type === 'OC') {
    const o = db.prepare('SELECT id, doc_no FROM oc_orders WHERE id=?').get(q.converted_order_id)
    return o ? { ...o, type: 'OC' } : null
  }
  const o = db.prepare('SELECT id, doc_no FROM sales_orders WHERE id=?').get(q.converted_order_id)
  return o ? { ...o, type: 'SO' } : null
}

/** 由报价生成销售订单（草稿）：价沿用报价，不重新取价 —— 转单不是重新报价 */
function buildSalesOrder(db, { q, actor, orderDate, remark, source }) {
  const docNo = nextDocNoAuto(db, { docType: 'SO', bizDate: orderDate })
  const receivable = round2(q.total_amount)
  const info = db
    .prepare(
      `INSERT INTO sales_orders
        (doc_no,channel,dealer_id,store_id,order_date,status,total_qty,goods_amount,discount_amount,freight,
         receivable_amount,paid_amount,warehouse_id,remark,created_by,quote_id,quote_no,created_at,updated_at)
       VALUES (?,?,?,?,?,'draft',?,?,0,?,?,0,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`
    )
    .run(
      docNo,
      q.channel || 'dealer',
      q.customer_type === 'dealer' ? q.dealer_id : null,
      q.customer_type === 'store' ? q.store_id : null,
      orderDate,
      q.items.reduce((s, i) => s + Number(i.qty || 0), 0),
      q.goods_amount,
      q.freight,
      receivable,
      q.warehouse_id || null,
      `由报价单 ${q.doc_no} 转单${remark ? `；${remark}` : ''}`,
      actor?.id ?? null,
      q.id,
      q.doc_no
    )
  const orderId = Number(info.lastInsertRowid)
  const insItem = db.prepare(
    'INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,remark) VALUES (?,?,?,?,0,?,?)'
  )
  for (const i of q.items) {
    insItem.run(orderId, i.sku_id, i.qty, i.price, round2(Number(i.price) * Number(i.qty)), i.remark || null)
  }
  db.prepare(
    `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,payload_json,created_at)
     VALUES ('SO',?,?,'create','由报价转单',NULL,'draft',?,?,?,?,?,datetime('now','localtime'))`
  ).run(
    orderId, docNo, actor?.id ?? null, actor?.name ?? null, source,
    `来源报价 ${q.doc_no}`,
    JSON.stringify({ quote_id: q.id, quote_no: q.doc_no, total: q.total_amount })
  )
  return { id: orderId, doc_no: docNo, type: 'SO' }
}

/** 复制报价（改版）：生成一张新的 draft，version +1 */
export function copyQuote(db, { id, actor = null, validDays = null, remark = null }) {
  const src = getQuote(db, Number(id))
  if (!src) throw new QuoteError(`报价单 #${id} 不存在`, { code: 'QUOTE_NOT_FOUND', httpStatus: 404 })
  return createQuote(db, {
    customerType: src.customer_type,
    dealerId: src.dealer_id,
    customerId: src.customer_id,
    storeId: src.store_id,
    channel: src.channel,
    warehouseId: src.warehouse_id,
    currency: src.currency,
    items: src.items.map((i) => ({ sku_id: i.sku_id, qty: i.qty, price: i.price })),
    freight: src.freight,
    taxRate: src.tax_rate,
    validDays: validDays || readSetting(db, 'quote.valid_days'),
    remark: remark || `复制自 ${src.doc_no}（v${src.version}）`,
    actor,
    sourceQuoteId: src.source_quote_id || src.id
  })
}

// ---------------------------------------------------------------------------
// 五、概览
// ---------------------------------------------------------------------------

export function quoteOverview(db) {
  const byStatus = {}
  for (const [k, label] of Object.entries(QUOTE_STATUS)) {
    byStatus[k] = { value: k, label, count: db.prepare('SELECT COUNT(*) c FROM sales_quotes WHERE status=?').get(k).c }
  }
  const day = today()
  const expiringSoon = db
    .prepare(
      `SELECT id, doc_no, valid_to, total_amount, dealer_id, customer_id FROM sales_quotes
        WHERE status='approved' AND valid_to >= ? AND valid_to <= ? ORDER BY valid_to LIMIT 20`
    )
    .all(day, addDays(day, 7))
  const pendingApproval = db
    .prepare("SELECT COUNT(*) c FROM sales_quotes WHERE status='submitted'").get().c
  const convertedAmount = db
    .prepare("SELECT COALESCE(SUM(total_amount),0) s FROM sales_quotes WHERE status='converted'").get().s

  return {
    status_counts: byStatus,
    pending_approval: pendingApproval,
    expiring_soon: expiringSoon,
    converted_amount: round2(convertedAmount),
    approval_amount_threshold: readSetting(db, 'quote.approval_amount'),
    valid_days_default: readSetting(db, 'quote.valid_days')
  }
}

export default {
  QuoteError, QUOTE_STATUS, CUSTOMER_TYPE,
  priceQuote, createQuote, getQuote, listQuotes,
  transitionQuote, expireQuotes, convertQuote, copyQuote, quoteOverview
}
