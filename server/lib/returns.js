/**
 * ============================================================================
 * 文件标识：server/lib/returns.js ｜ 销售退货闭环（D1）
 * ============================================================================
 * 【职责】销售退货闭环（D1）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售退货闭环（D1）
//
// 这一段的形状是「**退货只有动作，没有依据**」：
//   · 说退多少就退多少 —— 不看这张单实际发了多少、之前退过多少（实测退量 = 已发量×2+1，200 通过）；
//   · 入库成本取客户端传的单价 —— 传 9999 就把 9999 写进库存成本层，污染后续出库成本与三层残差；
//   · 应收完全没动 —— 货退回来了、钱还挂在客户账上。
//
// 三段修复各自对应一个"依据"：
//   ① **来源行绑定**（`order_item_id`）—— 退货必须说得清"退的是哪一行"，退量上限才有可能算；
//   ② **成本追溯原出库批次** —— 退回来的货按它当初出库的成本回库，不采信调用方；
//   ③ **应收冲减** —— 退货额冲掉这笔应收的未结余额；冲不完的部分登记为**待退款**，不静默丢弃。
//
// 判据只有这一处（`planReturn`）：路由与门店退货（POS）共用它 ——
// 验收侧明确要求"销售退货与门店退货两处都要有上限"，两处各写一套必然会分叉。
//
// 关于"无单退货"：没有来源行的退货是真实存在的（顾客没带小票、老单据缺失）。
// 处理方式不是禁止，而是**显式标注**（`source_type='walkin'`）：
// 它不参与来源追溯、不占用任何订单行的退量上限，成本取仓库当前加权成本。
// **不允许**一张"有单退货"里混进没有来源行的明细 —— 那等于给上限开一扇后门。

import { applyStockIn } from './stock.js'
// 冲减应收的**唯一实现**（返利核销也用它）—— 本文件不再自带一份'
import { offsetAr, arOfOrder } from './ar.js'
import { advanceStatus, logEvent } from './docflow.js'
import { nextDocNo } from './docno.js'
import { localNow } from './dates.js'

const money = (n) => Number((Number(n) || 0).toFixed(2))
const num = (n) => {
  const x = Number(n)
  return Number.isFinite(x) ? x : 0
}
const EPS = 0.0001

export class ReturnError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** 仓库当前加权成本（退化到标准成本）—— 只在"追溯不到来源批次"时使用 */
function currentCost(db, warehouseId, skuId, sku = null) {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(cost_amount),0) a, COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?'
    )
    .get(warehouseId, skuId)
  if (num(row?.q) > 0) return Number((num(row.a) / num(row.q)).toFixed(4))
  const std = sku || db.prepare('SELECT * FROM product_skus WHERE id=?').get(skuId)
  return num(std?.cost_std)
}

/**
 * 该订单该 SKU 的**原出库批次**（按出库先后），含每批的加权出库成本。
 *
 * 追溯**先结构化、后退化到文本**：
 *
 *   ① **结构化**（首选）：出库流水的 `doc_id` 在**销售发货路径**上指向 `sales_deliveries.id`
 *      （`routes/sales.js` 传 `docId: did`）⇒ 按「本订单的发货单 id」匹配。
 *      并加一道守卫：该发货单**确实有同 SKU 的行** —— `sales_orders.id` 与
 *      `sales_deliveries.id` 是两个独立自增序列，仅按 id 相等匹配会把别人的批次算进来。
 *   ② **文本**（兜底）：`counterparty = 订单号` —— 只有 API 发货路径写得出这个值。
 *   ③ 两条都不成立 ⇒ **返回空并如实标注 `via: null`**（不再假装"成本就是这样"）。
 *
 * 为什么必须改掉"只看文本"：实测三库 `doc_type='SAL_OUT'` 的 `counterparty`
 * 等于订单号的分别只有 **0 / 0 / 0** 条（`门店零售`、经销商名、门店名、平台单号才是常态），
 * 而 `doc_id` 能对上本订单发货单、且有同 SKU 行的分别有 **243 / 102 / 82** 条。
 * 也就是说：只看文本 ⇒ 这条判据在真实数据上**近乎全失效**，退货成本静默退化到当前成本，
 * 而单子上看不出任何异常。
 */
function outLotsOf(db, order, skuId) {
  const shape = (rows) => rows.map((r) => ({ batch_no: r.batch_no || '', qty: num(r.qty), unit_cost: num(r.unit_cost) }))
  const docLots = db
    .prepare(
      `SELECT IFNULL(t.batch_no,'') AS batch_no,
              ROUND(COALESCE(SUM(t.qty),0),4) AS qty,
              ROUND(COALESCE(SUM(t.amount),0) / NULLIF(COALESCE(SUM(t.qty),0),0),4) AS unit_cost
         FROM inventory_transactions t
        WHERE t.doc_type='SAL_OUT' AND t.sku_id=?
          AND t.doc_id IN (SELECT id FROM sales_deliveries WHERE order_id=?)
          AND EXISTS (SELECT 1 FROM sales_delivery_items i WHERE i.delivery_id=t.doc_id AND i.sku_id=t.sku_id)
        GROUP BY IFNULL(t.batch_no,'')
        ORDER BY MIN(t.id)`
    )
    .all(skuId, order.id)
  if (docLots.length) return { lots: shape(docLots), via: 'delivery' }

  const txtLots = db
    .prepare(
      `SELECT IFNULL(batch_no,'') AS batch_no,
              ROUND(COALESCE(SUM(qty),0),4) AS qty,
              ROUND(COALESCE(SUM(amount),0) / NULLIF(COALESCE(SUM(qty),0),0),4) AS unit_cost
         FROM inventory_transactions
        WHERE doc_type='SAL_OUT' AND counterparty=? AND sku_id=?
        GROUP BY IFNULL(batch_no,'')
        ORDER BY MIN(id)`
    )
    .all(order.doc_no, skuId)
  if (txtLots.length) return { lots: shape(txtLots), via: 'counterparty' }

  return { lots: [], via: null }
}

/** 该订单该 SKU 已按批次退过多少（用于扣减可退批次余量） */
function returnedByBatch(db, orderId, skuId) {
  const rows = db
    .prepare(
      `SELECT IFNULL(i.batch_no,'') AS batch_no, COALESCE(SUM(i.qty),0) AS qty
         FROM sales_return_items i
         JOIN sales_returns r ON r.id = i.return_id
        WHERE r.order_id = ? AND i.sku_id = ?
        GROUP BY IFNULL(i.batch_no,'')`
    )
    .all(orderId, skuId)
  const m = new Map()
  for (const r of rows) m.set(r.batch_no, num(r.qty))
  return m
}

/** 某个订单行累计已退（**明细是唯一真相**，不维护冗余累计列） */
export function returnedQtyOfItem(db, orderItemId) {
  return money(
    db
      .prepare(
        `SELECT COALESCE(SUM(i.qty),0) q
           FROM sales_return_items i JOIN sales_returns r ON r.id=i.return_id
          WHERE i.order_item_id = ?`
      )
      .get(orderItemId).q
  )
}

/**
 * 退货计划：把请求明细解析成「来源行 + 批次 + 成本」，并完成全部校验。
 * 返回的行**就是要落库的行**（调用方不再二次解析请求体）。
 */
export function planReturn(db, { orderId = null, sourceType = 'order', items = [], warehouseId = null } = {}) {
  const type = sourceType === 'walkin' ? 'walkin' : 'order'
  if (!Array.isArray(items) || !items.length) throw new ReturnError('NO_ITEMS', '请添加退货明细')

  let order = null
  if (orderId) order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(Number(orderId))
  if (type === 'order' && !order) throw new ReturnError('ORDER_NOT_FOUND', `销售订单 #${orderId} 不存在`, 404)

  const lines = []
  let qtySum = 0
  let amountSum = 0
  const push = (l) => {
    lines.push(l)
    qtySum += l.qty
    amountSum += l.amount
  }

  // ---------- 无单退货 ----------
  if (type === 'walkin') {
    for (const it of items) {
      const qty = num(it.qty)
      if (!(qty > 0)) throw new ReturnError('QTY_INVALID', '退货数量必须大于 0')
      if (it.order_item_id) {
        throw new ReturnError('SOURCE_NOT_ALLOWED', '无单退货不得绑定来源行；如需按订单退，请改用有单退货')
      }
      const sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(Number(it.sku_id))
      if (!sku) throw new ReturnError('SKU_NOT_FOUND', `SKU#${it.sku_id} 不存在`, 404)
      const price = money(it.price ?? 0)
      if (price < 0) throw new ReturnError('PRICE_INVALID', '退货单价不能为负')
      push({
        order_item_id: null,
        sku_id: sku.id,
        batch_no: String(it.batch_no || ''),
        qty: money(qty),
        price,
        amount: money(qty * price),
        unit_cost: currentCost(db, warehouseId, sku.id, sku),
        cost_source: 'current'
      })
    }
    return {
      sourceType: type,
      order,
      lines,
      qtySum: money(qtySum),
      amountSum: money(amountSum),
      // 无单退货（walkin）没有订单，也就没有"原出库批次"可追溯 —— 口径上不适用，
      // 但仍返回同一形状，调用方不必为两种来源写两个分支。
      costTrace: costTraceOf(lines)
    }
  }

  // ---------- 有单退货：按来源行聚合 ----------
  const byItem = new Map()
  for (const it of items) {
    const qty = num(it.qty)
    if (!(qty > 0)) throw new ReturnError('QTY_INVALID', '退货数量必须大于 0')
    const oid = Number(it.order_item_id || 0)
    if (!oid) {
      throw new ReturnError(
        'SOURCE_REQUIRED',
        '有单退货的每一行都必须绑定来源订单行（order_item_id）——否则退量上限无从计算'
      )
    }
    byItem.set(oid, (byItem.get(oid) || 0) + qty)
  }

  for (const [oid, qty] of byItem) {
    const oi = db.prepare('SELECT * FROM sales_order_items WHERE id=?').get(oid)
    if (!oi) throw new ReturnError('ORDER_ITEM_NOT_FOUND', `订单行 #${oid} 不存在`, 404)
    if (Number(oi.order_id) !== Number(order.id)) {
      throw new ReturnError('ORDER_ITEM_MISMATCH', `订单行 #${oid} 不属于订单 #${order.id}`)
    }
    const shipped = num(oi.shipped_qty)
    const already = returnedQtyOfItem(db, oid)
    const returnable = money(shipped - already)
    if (qty > returnable + EPS) {
      throw new ReturnError(
        'RETURN_EXCEEDS_SHIPPED',
        `订单行 #${oid} 最多可退 ${returnable}（已发 ${money(shipped)}、已退 ${already}），本次要求退 ${money(qty)}`,
        409,
        { order_item_id: oid, shipped_qty: money(shipped), returned_qty: already, returnable, requested: money(qty) }
      )
    }
    // 应收口径单价 = 订单行净单价（= 行金额 / 行数量，已含行折扣）
    const netPrice = num(oi.qty) > 0 ? money(num(oi.amount) / num(oi.qty)) : money(oi.price)

    // 成本追溯：先按**原出库批次**分配，批次余量不足的部分才退化到当前成本（并显式标注）。
    // 追溯本身失败（`via === null`，既无结构化来源也无 counterparty 匹配）时，
    // **不再伪装成"正常退化"**：cost_source 记为 `lot_trace_failed`，plan 里带出可读原因。
    const used = returnedByBatch(db, order.id, oi.sku_id)
    const trace = outLotsOf(db, order, oi.sku_id)
    let remain = qty
    for (const lot of trace.lots) {
      if (remain <= EPS) break
      const avail = money(lot.qty - (used.get(lot.batch_no) || 0))
      if (avail <= EPS) continue
      const take = Math.min(avail, remain)
      push({
        order_item_id: oid,
        sku_id: oi.sku_id,
        batch_no: lot.batch_no,
        qty: money(take),
        price: netPrice,
        amount: money(take * netPrice),
        unit_cost: lot.unit_cost,
        cost_source: 'source_out',
        cost_via: trace.via
      })
      remain = money(remain - take)
    }
    if (remain > EPS) {
      push({
        order_item_id: oid,
        sku_id: oi.sku_id,
        batch_no: '',
        qty: money(remain),
        price: netPrice,
        amount: money(remain * netPrice),
        unit_cost: currentCost(db, warehouseId, oi.sku_id),
        // 追溯不到原批次 ⇒ lot_trace_failed（**不是**普通的余量不足）
        cost_source: trace.via ? 'current_fallback' : 'lot_trace_failed',
        cost_via: trace.via
      })
    }
  }

  return { sourceType: type, order, lines, qtySum: money(qtySum), amountSum: money(amountSum), costTrace: costTraceOf(lines) }
}

/**
 * 成本追溯结果的**可读小结**。判据要求"退化必须可见"：
 *   · traced  —— 按原出库批次计价的量与来源（delivery / counterparty）；
 *   · failed  —— **完全追溯不到**（`lot_trace_failed`）的量，必须出现在单据与流水的可见字段里；
 *   · fallback—— 追溯到了批次、但批次余量不足（重复退货）的部分。
 */
function costTraceOf(lines) {
  const r2 = (n) => Number((Number(n) || 0).toFixed(2))
  const pick = (src) => lines.filter((l) => l.cost_source === src)
  const failed = pick('lot_trace_failed')
  const fallback = pick('current_fallback')
  const traced = pick('source_out')
  const via = traced[0]?.cost_via || null
  const warning = failed.length
    ? `成本未按原出库批次追溯（${r2(failed.reduce((s, l) => s + l.qty, 0))} 件）：` +
      '这张订单的出库流水既没有指向本订单发货单的 doc_id，也没有 counterparty=订单号 的记录，' +
      '退回成本已按仓库当前加权成本计价'
    : fallback.length
      ? `部分退货量（${r2(fallback.reduce((s, l) => s + l.qty, 0))} 件）已无可退批次余量（此前已按批次退过），按当前加权成本计价`
      : null
  return {
    via,
    traced_qty: r2(traced.reduce((s, l) => s + l.qty, 0)),
    failed_qty: r2(failed.reduce((s, l) => s + l.qty, 0)),
    fallback_qty: r2(fallback.reduce((s, l) => s + l.qty, 0)),
    warning
  }
}

/**
 * 退货的应收后果：按**来源订单**冲减应收（退货专用）。
 *
 * 口径：**只在未核销余额内冲减**，且 `refund_due` 只统计**真正收到过的钱**。
 *   · 退货额 ≤ 未结余额 → 全额冲减，应收金额变小，应退 0；
 *   · 退货额 > 未结余额 → 冲减到未结余额为 0，差额若确实已收款则登记为 `refund_due`（待退款），
 *     否则（这张单根本没有应收 / 没收到钱）一律为 0。
 * 不生成负数应收单：账龄/汇总用的是 `amount - allocated_amount`，
 * 负数金额会让"逐笔账龄"与"按客户汇总"口径分叉（一处跳过负余额、一处照算）。
 * 那一分叉正是本项目反复吃过的坑，所以宁可用"冲减 + 待退款登记"。
 *
 * **口径：`refund_due` 只能等于「这张单实际已经收到的钱」减去已登记待退的部分。**
 * 没收到钱 ⇒ 应退 **0**（退的是"额"，不是"款"：只在已收款范围内退款）。
 *
 * 病灶（S-1）：原来先按 `source_type='SO'` 找**一张**应收，找不到（或那张已作废）时
 * 直接 `return { offset: 0, refundDue: money(amount) }` —— 把
 * **「这张单没有应收」**与**「应收已作废/已结清」**当成同一种情形，两者都返回"应退全额"。
 * 而 `:248` 只认 `SO`，SO 口径下"开票"建的却是 `SI` ⇒ 只要走开票这条路就找不到应收 ⇒
 * 退货单上写着"应退 500"、原应收一分不冲，退款确认之后**钱真的出账**。
 * 实测两条路：① 开票未回款退 2 件 ⇒ `refund_due: 500` 且应收仍 open；
 * ② 该单根本没有应收 ⇒ 退货照样 `refund_due: 600`。
 *
 * 现在：按订单聚合**所有来源**的应收（`SO` / `SI`，见 `arOfOrder`），按来源逐笔冲减；
 * 已收金额 = 这些应收单的 `allocated_amount` 之和（核销明细是唯一真相，见 ar.js `recalcAr`）。
 * 无任何应收 ⇒ 可冲 0、已收 0 ⇒ `refund_due = 0`。
 */
function offsetArForOrder(db, { order, amount }) {
  if (!(amount > 0)) return { arId: null, offset: 0, refundDue: 0 }
  const ars = arOfOrder(db, order.id)
  // 「实际已经收到的钱」：这张订单名下所有应收单的已核销金额（作废单不计）
  const paid = money(
    ars.reduce((s, a) => s + (a.status === 'voided' ? 0 : Number(a.allocated_amount || 0)), 0)
  )
  // 本单（本订单）此前已登记过的待退款合计 —— 防止多次部分退货把同一笔已收款退两遍。
  // 当前这张退货单此刻还没写 `refund_due`（默认 0），所以不必排除它自己。
  const alreadyRefunded = money(
    db.prepare('SELECT COALESCE(SUM(refund_due),0) q FROM sales_returns WHERE order_id=?').get(order.id).q
  )

  let left = money(amount)
  let offset = 0
  let arId = null
  for (const ar of ars) {
    if (!(left > 0)) break
    if (ar.status === 'voided') continue
    const r = offsetAr(db, { arId: ar.id, amount: left, reason: `销售退货冲减（订单 #${order.id}）` })
    if (!(r.offset > 0)) continue
    if (arId == null) arId = ar.id
    offset = money(offset + r.offset)
    left = money(left - r.offset)
  }
  // 可退 = 这一份退货里"已经收过钱"的那部分，再受「已收 − 已登记待退」封顶
  const refundDue = money(Math.max(0, Math.min(money(amount - offset), money(paid - alreadyRefunded))))
  return { arId, offset, refundDue }
}

/**
 * 建销售退货单（一个事务：建单 → 回库 → 冲应收 → 推订单状态）。
 *
 * 幂等：传了 `idempotencyKey` 时，同键重复提交**返回首次那张单**，不重复回库、不重复冲减。
 * 唯一性由 `idx_sales_returns_idem` 兜住并发（先查后插之间仍可能撞车）。
 */
export function createSalesReturn(
  db,
  req,
  {
    orderId = null,
    sourceType = 'order',
    items = [],
    warehouseId = null,
    returnDate = null,
    reason = null,
    channel = 'dealer',
    dealerId = null,
    storeId = null,
    idempotencyKey = null,
    actor = null
  } = {}
) {
  const key = idempotencyKey ? String(idempotencyKey) : null
  if (key) {
    const hit = db.prepare('SELECT * FROM sales_returns WHERE idempotency_key=?').get(key)
    if (hit) return { id: hit.id, doc_no: hit.doc_no, replayed: true, qty: hit.total_qty, amount: hit.total_amount }
  }

  const tx = db.transaction(() => {
    const order = orderId ? db.prepare('SELECT * FROM sales_orders WHERE id=?').get(Number(orderId)) : null
    const date = String(returnDate || '').trim() || localNow().slice(0, 10)
    let whId = warehouseId || (order ? order.warehouse_id : null)
    if (!whId) whId = db.prepare("SELECT id FROM warehouses WHERE type='central' LIMIT 1").get()?.id
    if (!whId) throw new ReturnError('WAREHOUSE_REQUIRED', '请指定退货入库仓库')

    const plan = planReturn(db, {
      orderId,
      sourceType,
      items,
      warehouseId: whId
    })

    const docNo = nextDocNo(db, 'SRT', 'sales_returns', 'doc_no', date)
    const info = db
      .prepare(
        `INSERT INTO sales_returns (doc_no,order_id,source_type,channel,dealer_id,store_id,warehouse_id,
                                    return_date,reason,status,total_qty,total_amount,created_by,idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,'confirmed',0,0,?,?)`
      )
      .run(
        docNo,
        orderId || null,
        plan.sourceType,
        channel,
        dealerId || (order ? order.dealer_id : null),
        storeId || (order ? order.store_id : null),
        whId,
        date,
        reason || null,
        actor?.id || null,
        key
      )
    const rid = Number(info.lastInsertRowid)

    const insItem = db.prepare(
      'INSERT INTO sales_return_items (return_id,order_item_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?,?)'
    )
    for (const l of plan.lines) {
      insItem.run(rid, l.order_item_id, l.sku_id, l.batch_no || '', l.qty, l.price, l.amount)
      applyStockIn(db, {
        bizDate: date,
        docType: 'SAL_RET',
        docNo,
        docId: rid,
        warehouseId: whId,
        skuId: l.sku_id,
        batchNo: l.batch_no || '',
        qty: l.qty,
        // **成本来自计划，不来自请求体** —— 这是"不得采信客户端价"的落点
        unitCost: l.unit_cost,
        operator: actor?.name || null,
        // 追溯失败**必须留在看得见的地方**：库里没有"成本来源"列（本批不加表），
        // 所以把原因写进出库/入库流水的备注 —— 查库存流水就能看见这一笔为什么没用原批次成本。
        remark:
          l.cost_source === 'lot_trace_failed'
            ? `销售退货入库 ${docNo}（成本未按原出库批次追溯：出库流水无本单发货单 doc_id、也无 counterparty=订单号，按当前加权成本计价）`
            : `销售退货入库 ${docNo}`
      })
    }
    db.prepare('UPDATE sales_returns SET total_qty=?, total_amount=? WHERE id=?').run(plan.qtySum, plan.amountSum, rid)

    // 应收后果
    const ar = plan.order ? offsetArForOrder(db, { order: plan.order, amount: plan.amountSum }) : { arId: null, offset: 0, refundDue: plan.amountSum }
    db.prepare('UPDATE sales_returns SET ar_id=?, ar_offset_amount=?, refund_due=? WHERE id=?').run(
      ar.arId,
      ar.offset,
      ar.refundDue,
      rid
    )

    // 建单留痕（铁律：留痕须与改动同生共死、**写在改动旁边**，且在同一个事务里 ——
    // 回滚时这张单和它的留痕一起消失，不会留下一张"有出生记录却不存在"的痕）。
    //
    // 为什么建单也要留痕：退货单是**建出来就是 `confirmed`** 的 —— 上面那几行在同一个事务里
    // 已经把货回库（applyStockIn）、把应收冲掉了，所以**不存在**一次 `SR.confirm` 的流转可记。
    // 不在这里记，这张单的「一生」在 `doc_events` 里就是空白的：事后问「谁建的、什么时候建的、
    // 依据哪张订单、退了几件、冲了多少应收」四个问题一个都答不出来。
    // （实测形状：修前三库 `doc_events` 里 SR 只有本轮新加的 `complete`，没有任何建单痕迹；
    //  而**走门店退货**建的单由 `lib/pos2.js` 另写 INSERT，同样无痕 —— 已单独报出，未在本轮改。）
    //
    // `action='create'` 而**不是** `'confirm'`：`confirm` 是内核里 draft→confirmed 那条**边**的动作码，
    // 而这里根本没有走过那条边（这张单从没处于 draft），冒用它等于在时间线上伪造一次没发生过的流转。
    // `from_state` 留空、`to_state='confirmed'` —— 如实说"它被建出来时就在 confirmed"。
    logEvent({
      db,
      docType: 'SR',
      id: rid,
      docNo,
      action: 'create',
      actionName: '建单',
      to: 'confirmed',
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
      // `req` 为 null 的调用方只有 `db/refund-seed.js`（造演示数据），据实记 seed；
      // 路由（`POST /api/sales/returns`）始终带 req。与 `doc_events.source` 的取值域 api/mcp/seed/system 对齐。
      source: req ? 'api' : 'seed',
      remark:
        plan.sourceType === 'walkin'
          ? '无单退货建单（不参与来源追溯、不占用订单行退量）'
          : `有单退货建单（来源订单 ${plan.order?.doc_no || '#' + orderId}）`,
      payload: {
        source_type: plan.sourceType,
        order_id: orderId || null,
        order_no: plan.order?.doc_no || null,
        channel,
        warehouse_id: whId,
        qty: plan.qtySum,
        amount: plan.amountSum,
        ar_id: ar.arId,
        ar_offset_amount: ar.offset,
        refund_due: ar.refundDue,
        // 成本追溯口径：哪几行走了原批次、哪几行退化了（与返回体同一份结论）
        cost_via: plan.costTrace?.via ?? null,
        cost_trace_failed_qty: plan.costTrace?.failed_qty ?? 0
      }
    })

    // 订单状态：**用内核的定义判断这条边存不存在**，不存在就跳过（多次部分退货不该在第二次整体失败）。
    //
    // S-4：**只有"已发量全退完"时才推 `returned`**。
    // `returned` 在内核里是终态（`008:537-540` `is_final=1`，且无出边），
    // 原来无条件用它 ⇒ 多行订单只退了第 1 行一件，整单就被钉死：
    // 之后「完成」409（期望 from_state=shipped）、「发货」400，
    // **第 2 行一件没退，而订单再也动不了**。
    // 实测：两行订单只退 1 件 ⇒ 状态 returned ⇒ `/complete` 返回
    // 「状态已变化：期望 shipped，实际 returned」。
    let statusMoved = false
    if (plan.order) {
      const shippedQty = num(
        db.prepare('SELECT COALESCE(SUM(shipped_qty),0) q FROM sales_order_items WHERE order_id=?').get(plan.order.id).q
      )
      const returnedQty = num(
        db
          .prepare(
            `SELECT COALESCE(SUM(i.qty),0) q FROM sales_return_items i
               JOIN sales_returns r ON r.id=i.return_id WHERE r.order_id=?`
          )
          .get(plan.order.id).q
      )
      const allReturned = shippedQty > EPS && returnedQty >= shippedQty - EPS
      const edge = allReturned
        ? db
            .prepare("SELECT 1 FROM doc_actions WHERE doc_type='SO' AND action='return' AND from_state=? LIMIT 1")
            .get(plan.order.status)
        : null
      if (edge) {
        advanceStatus(db, req, { docType: 'SO', id: plan.order.id, action: 'return', remark: `退货单 ${docNo}` })
        statusMoved = true
      }
    }

    return {
      id: rid,
      doc_no: docNo,
      qty: plan.qtySum,
      amount: plan.amountSum,
      source_type: plan.sourceType,
      ar_id: ar.arId,
      ar_offset_amount: ar.offset,
      refund_due: ar.refundDue,
      lines: plan.lines.length,
      cost_sources: plan.lines.map((l) => l.cost_source),
      // 成本追溯的可见结论（口径见 `costTraceOf`）：调用方/界面据此提示"这笔退货的成本不是原批次成本"
      cost_trace: plan.costTrace,
      cost_trace_warning: plan.costTrace?.warning || null,
      status_moved: statusMoved,
      replayed: false
    }
  })

  try {
    return tx()
  } catch (e) {
    // 并发撞唯一键 ⇒ 另一条请求已建单，把那张单返回回去（幂等的正常路径，不是错误）
    if (key && /UNIQUE|constraint/i.test(String(e?.message))) {
      const hit = db.prepare('SELECT * FROM sales_returns WHERE idempotency_key=?').get(key)
      if (hit) return { id: hit.id, doc_no: hit.doc_no, replayed: true, qty: hit.total_qty, amount: hit.total_amount }
    }
    throw e
  }
}

export default { ReturnError, planReturn, createSalesReturn, returnedQtyOfItem }
