/**
 * ============================================================================
 * 文件标识：server/lib/checkout.js ｜ 模块 18：结算接入层 —— 促销 / 会员 / 券在这里汇合
 * ============================================================================
 * 【职责】模块 18：结算接入层 —— 促销 / 会员 / 券在这里汇合
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 模块 18：结算接入层 —— 促销 / 会员 / 券在这里汇合
//
// 前三层各管一件事：`promotion.js` 回答「哪些活动生效、减多少、减在哪几行」，
// `member.js` 回答「这个客户几级、有多少积分储值」，`coupon.js` 回答「这张券能不能用」。
// 本文件回答的是**最后一个问题：这一单到底收多少钱**，以及
// 「优惠是怎么分摊到每一行上的」——后者决定了退货时能退多少。
//
// ============================================================================
// 一、算钱顺序（顺序本身就是一个口径，不能随意调）
// ============================================================================
//
//   ① 行金额        = 取价引擎单价 × 数量（分）
//   ② 会员折扣      等级折扣（`member_levels.discount_pct` 万分比）—— **先算，作用于原价**
//   ③ 促销优惠      在会员价之上再算（`promotion.js` 的叠加/优先级/地板规则）
//   ④ 积分抵扣      在优惠后金额之上抵（有上限，见 member.pointsDeductQuote）
//   ⑤ 储值支付      只影响怎么付，不影响应收金额
//   ⑥ 应付 = ②后的金额 − ③ − ④
//
//   为什么会员折扣排在促销**之前**：
//     等级折扣是「这个人的身份价」，促销是「这个活动的临时价」。
//     反过来的话，会员折扣会去折促销后的金额 —— 等于活动力度越大、会员权益越不值钱，
//     与"等级越高越划算"的承诺直接矛盾。
//
//   为什么积分抵扣排在**最后**：
//     积分是"钱"（能抵现），必须作用在**最终成交价**上。
//     放在促销之前的话，促销按原价算折扣、积分按原价抵，两者叠加可以突破应付金额。
//
// ============================================================================
// 二、分摊可回溯（这一层存在的首要理由）
// ============================================================================
//
//   促销引擎给出的 `actions` 已经带 `item_id`（按行分摊、末行兜底消尾差）。
//   本层把它**按行聚合成 `lineDiscounts`**，并断言
//     Σ(行优惠) + 整单优惠 == 促销总优惠
//   不等就抛错。为什么值得一条硬断言：退货时要按行退钱，
//   若行优惠合计与整单优惠对不上，就会出现「退完所有行，钱还没退完（或多退）」——
//   而这两种情况都不报错，只会在某一天的对账里变成一笔说不清的钱。
//
// ============================================================================
// 三、试算与落单分离
// ============================================================================
//
//   `quote()`  **纯读**：可以随便调（购物车实时试算、界面解释链），不写任何表。
//   `settle()` **写库**：落优惠留痕 + 登记使用 + 核销券 + 送积分，全部在一个事务里。
//   分开的理由：试算会被频繁调用（用户每改一次数量就叫一次），
//   若试算也写库，购物车会变成一台"随手留下使用记录"的机器 ——
//   限量券的名额会在客户还没下单时就被吃掉。
// ============================================================================

import { getDb } from '../db/index.js'
import { computePromotionActions, persistAdjustments, registerUsage } from './promotion.js'
import * as M from './member.js'
import * as C from './coupon.js'

function bad(message, code = 'BAD_REQUEST', httpStatus = 400, detail = null) {
  const e = new Error(message)
  e.status = httpStatus
  e.code = code
  e.detail = detail
  return e
}

const resolveDb = (db) => db ?? getDb()

// ---------------------------------------------------------------------------
// 一、把购物车行补全成促销引擎认识的样子
//
// 促销引擎不查库（它只认 ctx）—— 这是刻意的：**引擎不该自己决定"这件货多少钱"**，
// 那是取价引擎的职责。本层负责把两者的接口对齐，并在这一处把「元 → 分」换完。
// ---------------------------------------------------------------------------

/**
 * @param rawItems [{ sku_id, qty, unit_price_cents }] —— 单价可以不给，
 *                 不给就按 SKU 的 `price_retail` 兜底（分）
 * @param priceOf  (skuId, qty) => 单价（分）；销售/商城侧传取价引擎的封装
 */
export function buildItems(db, rawItems = [], { priceOf = null } = {}) {
  const store = resolveDb(db)
  if (!Array.isArray(rawItems) || !rawItems.length) throw bad('购物车为空', 'CART_EMPTY', 400)
  const out = []
  let seq = 0
  for (const r of rawItems) {
    const skuId = Number(r.sku_id)
    const qty = Number(r.qty)
    if (!skuId) throw bad('明细缺少 sku_id', 'BAD_ARGS', 400)
    if (!Number.isFinite(qty) || qty <= 0) throw bad(`SKU#${skuId} 数量必须大于 0`, 'BAD_ARGS', 400)
    const sku = store.prepare(`
      SELECT s.*, p.category_id, p.name AS product_name, p.status AS product_status
        FROM product_skus s LEFT JOIN products p ON p.id = s.product_id
       WHERE s.id = ?
    `).get(skuId)
    if (!sku) throw bad(`SKU#${skuId} 不存在`, 'SKU_NOT_FOUND', 404)
    if (sku.product_status && sku.product_status !== 'active') {
      throw bad(`SKU#${skuId} 所属商品已下架`, 'SKU_OFF_SHELF', 409)
    }
    const unit = Math.round(Number(r.unit_price_cents ?? (priceOf ? priceOf(skuId, qty) : null) ?? sku.price_retail * 100))
    if (!(unit > 0)) throw bad(`SKU#${skuId} 单价异常（${unit} 分）`, 'PRICE_INVALID', 400)
    seq += 1
    out.push({
      // item.id 必须在一次结算内唯一且稳定 —— 它是促销引擎 appliedMap 的键，
      // 也是分摊结果回填到行的锚点。用 sku_id 当键会在"同一 SKU 分两行"时串味。
      id: r.item_id ?? seq,
      sku_id: skuId,
      category_id: sku.category_id ?? null,
      qty,
      unit_price: unit,
      subtotal: unit * qty,
      is_discountable: r.is_discountable === 0 ? 0 : 1,
      // 地板：营销域早就维护着 price_min（最低成交价），这里第一次真正拿它挡折扣
      price_min_cents: Math.round(Number(sku.price_min ?? 0) * 100),
      name: sku.name,
      product_name: sku.product_name,
      sku_code: sku.sku_code
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 二、试算（纯读，不写库）
// ---------------------------------------------------------------------------

/**
 * @returns {
 *   items, subtotal, memberDiscount, promotionDiscount, pointsDiscount,
 *   payable, lineDiscounts, actions, appliedCodes, explanation, member, couponUsed
 * }
 */
export function quote(db, {
  items = [],
  customerId = null,
  couponCodes = [],
  autoCoupon = false,
  usePoints = 0,
  at = null
} = {}) {
  const store = resolveDb(db)
  if (!store) throw bad('数据库不可用', 'DB_UNAVAILABLE', 500)
  const now = at || new Date().toISOString().slice(0, 19).replace('T', ' ')
  const lines = items.length ? items : []
  if (!lines.length) throw bad('购物车为空', 'CART_EMPTY', 400)

  const subtotal = lines.reduce((s, it) => s + Number(it.subtotal), 0)

  // ---- ② 会员折扣 ----
  let member = null
  let memberDiscount = 0
  if (customerId != null) {
    const acc = M.ensureAccount(store, customerId)
    const lv = store.prepare('SELECT * FROM member_levels WHERE code=?').get(acc.level_code)
    // 折扣只作用于可打折的行 —— 促销域已经有 is_discountable 口径，会员折扣沿用同一口径，
    // 否则会出现"促销不打折的行被会员折扣打了折"，两条线互相矛盾
    const base = lines.filter((it) => it.is_discountable !== 0).reduce((s, it) => s + Number(it.subtotal), 0)
    const pct = Number(lv?.discount_pct ?? 10000)
    memberDiscount = pct >= 10000 ? 0 : Math.round(base * (10000 - pct) / 10000)
    member = {
      customer_id: customerId,
      level_code: acc.level_code,
      level_name: lv?.name ?? M.LEVEL_LABEL[acc.level_code] ?? acc.level_code,
      discount_pct: pct,
      points: acc.points,
      balance_cents: acc.balance_cents
    }
  }

  // ---- ③ 促销优惠 ----
  // 会员折扣先按行摊掉再交给促销引擎：促销引擎的 baseOf 读 `it.subtotal - 已优惠`，
  // 所以这里把会员折扣也写进 items 的 subtotal，让促销在**会员价**上继续打折。
  const afterMember = distribute(lines, memberDiscount)
  const promoItems = lines.map((it, i) => ({
    ...it,
    subtotal: afterMember[i]
  }))

  // 券 → 促销码：券实例码与促销码是两套编号，必须在这里换一次。
  // **只认调用方显式传的券码**（`autoCoupon: true` 才带上客户名下可用券）——
  // 见 coupon.js codesForCustomer 的注释：自动带上会让试算顺手把券全用掉。
  let couponInfo = { promotionCodes: [], accepted: [], rejected: [] }
  if (customerId != null) {
    couponInfo = C.codesForCustomer(store, {
      customerId,
      orderAmountCents: subtotal,
      couponCodes,
      auto: autoCoupon,
      at: now
    })
  }
  const promo = computePromotionActions(store, {
    items: promoItems,
    customer: member ? { id: member.customer_id, level: member.level_code, level_code: member.level_code } : {},
    subtotal: promoItems.reduce((s, it) => s + it.subtotal, 0),
    codes: couponInfo.promotionCodes,
    now
  })

  // 促销引擎返回的 actions 是「针对 promoItems 的行」；行优惠按 item_id 聚合回来
  const lineDiscounts = lines.map((it) => ({
    item_id: it.id, sku_id: it.sku_id,
    subtotal: Number(it.subtotal),
    member_discount: Number(it.subtotal) - afterMember[lines.indexOf(it)],
    promotion_discount: 0,
    points_discount: 0,
    payable: Number(it.subtotal)
  }))
  const byId = new Map(lineDiscounts.map((l) => [l.item_id, l]))
  let orderLevelDiscount = 0
  for (const a of promo.actions) {
    if (a.item_id == null) { orderLevelDiscount += Number(a.amount); continue }
    const row = byId.get(a.item_id)
    if (row) row.promotion_discount += Number(a.amount)
    else orderLevelDiscount += Number(a.amount) // 认不出的行按整单处理，不吞掉这笔钱
  }
  // 分摊自证：行优惠 + 整单优惠必须等于引擎给的总优惠
  const sumLine = lineDiscounts.reduce((s, l) => s + l.promotion_discount, 0)
  const promotionDiscount = promo.totalDiscount
  if (sumLine + orderLevelDiscount !== promotionDiscount) {
    throw bad(
      `促销分摊不平：行优惠合计 ${sumLine} + 整单 ${orderLevelDiscount} ≠ 引擎总额 ${promotionDiscount}`,
      'PROMOTION_ALLOCATION_MISMATCH', 500,
      { sumLine, orderLevelDiscount, promotionDiscount }
    )
  }

  // ---- ④ 积分抵扣 ----
  const afterPromo = subtotal - memberDiscount - promotionDiscount
  let pointsDiscount = 0
  let pointsUsed = 0
  let pointsQuote = null
  if (customerId != null) {
    pointsQuote = M.pointsDeductQuote(store, { customerId, orderAmountCents: afterPromo })
    const want = Math.max(0, Math.floor(Number(usePoints) || 0))
    if (want > 0) {
      if (want > pointsQuote.maxPoints) {
        throw bad(
          `本次想抵 ${want} 积分，超过上限 ${pointsQuote.maxPoints} 分`,
          'DEDUCT_EXCEEDS_LIMIT', 400, { want, ...pointsQuote }
        )
      }
      pointsUsed = want
      pointsDiscount = M.pointsToCents(store, want)
      // 抵扣额不能超过应付：地板之上再兜一道，防"积分把单抵成负数"
      pointsDiscount = Math.min(pointsDiscount, afterPromo)
    }
  }

  const payable = Math.max(0, afterPromo - pointsDiscount)

  // 把积分抵扣也摊到行上（按行剩余应付占比），否则退货时算不出"这行实付多少"
  if (pointsDiscount > 0) {
    const rest = lineDiscounts.map((l) => Math.max(0, l.subtotal - l.member_discount - l.promotion_discount))
    const restTotal = rest.reduce((s, v) => s + v, 0)
    let allocated = 0
    lineDiscounts.forEach((l, i) => {
      const amt = i === lineDiscounts.length - 1
        ? pointsDiscount - allocated
        : Math.round(pointsDiscount * rest[i] / (restTotal || 1))
      const capped = Math.min(Math.max(0, amt), rest[i])
      l.points_discount = capped
      allocated += capped
    })
    // 末行兜底可能留下未分配额（前面各行被 caps 截断时），补到剩余最多的一行
    let gap = pointsDiscount - lineDiscounts.reduce((s, l) => s + l.points_discount, 0)
    if (gap > 0) {
      for (const l of [...lineDiscounts].sort((a, b) =>
        (b.subtotal - b.member_discount - b.promotion_discount - b.points_discount) -
        (a.subtotal - a.member_discount - a.promotion_discount - a.points_discount))) {
        const cap = l.subtotal - l.member_discount - l.promotion_discount - l.points_discount
        const add = Math.min(gap, Math.max(0, cap))
        l.points_discount += add
        gap -= add
        if (gap <= 0) break
      }
    }
  }

  for (const l of lineDiscounts) {
    l.payable = Math.max(0, l.subtotal - l.member_discount - l.promotion_discount - l.points_discount)
  }
  // 行应付合计必须等于整单应付 —— 这是"分摊可回溯"的最后一道自证。
  // 不相等意味着退货时按行退款会退不平，而那种错不会报错。
  const sumPayable = lineDiscounts.reduce((s, l) => s + l.payable, 0)
  if (sumPayable !== payable) {
    throw bad(
      `分摊后的行应付合计 ${sumPayable} ≠ 整单应付 ${payable}（优惠分摊不平）`,
      'ALLOCATION_MISMATCH', 500, { sumPayable, payable, lineDiscounts }
    )
  }

  return {
    at: now,
    items: lines,
    subtotal,
    member_discount: memberDiscount,
    promotion_discount: promotionDiscount,
    points_discount: pointsDiscount,
    points_used: pointsUsed,
    payable,
    discount_total: memberDiscount + promotionDiscount + pointsDiscount,
    line_discounts: lineDiscounts,
    actions: promo.actions,
    applied_codes: promo.appliedCodes,
    traced: promo.traced,
    member,
    coupon: {
      promotion_codes: couponInfo.promotionCodes,
      accepted: couponInfo.accepted,
      rejected: couponInfo.rejected,
      // 客户可用券（**只读展示**，不代表本单会用它）—— 界面上的「可用券」列表读这里。
      // 与 `accepted` 的区别是：accepted 只含本单真正参与计算的券。
      available: customerId != null
        ? C.availableCoupons(store, { customerId, orderAmountCents: subtotal, at: now })
        : { usable: [], blocked: [] }
    },
    points_quote: pointsQuote
  }
}

/**
 * 把一个总额按行占比摊回各行（末行兜底消尾差）。
 * 会员折扣与后面的积分抵扣都走这个函数 —— 两处各自实现过一次，
 * 结果两处的尾差处理不一致（一处兜底、一处没兜），已统一到这一处。
 */
export function distribute(lines, total) {
  const t = Math.round(Number(total) || 0)
  const out = lines.map((it) => Number(it.subtotal))
  if (!t) return out
  const baseTotal = out.reduce((s, v) => s + v, 0)
  if (baseTotal <= 0) return out
  let allocated = 0
  const res = []
  lines.forEach((it, i) => {
    const base = Number(it.subtotal)
    const amt = i === lines.length - 1
      ? t - allocated
      : Math.round(t * base / baseTotal)
    const capped = Math.min(Math.max(0, amt), base)
    res.push(base - capped)
    allocated += capped
  })
  // 前面被 cap 截断时，末行会多担；把它按"剩余可摊额"补回去，保证 Σ(减项) === t
  let gap = t - res.reduce((s, v, i) => s + (Number(lines[i].subtotal) - v), 0)
  if (gap !== 0) {
    for (const i of res.map((_, idx) => idx).reverse()) {
      const base = Number(lines[i].subtotal)
      const cut = base - res[i]
      const room = gap > 0 ? cut : (base - cut) // gap>0 表示还差要减的额度
      const move = Math.min(Math.abs(gap), Math.max(0, room))
      res[i] += gap > 0 ? -move : move
      gap += gap > 0 ? move : -move
      if (gap === 0) break
    }
  }
  return res
}

// ---------------------------------------------------------------------------
// 三、落单（写库，一个事务里做完五件事）
// ---------------------------------------------------------------------------

/**
 * 落单：优惠留痕 → 使用登记 → 核销券 → 送积分 → 返回最终金额。
 *
 * **不做**：扣储值、写销售单（那是各业务域自己的事）。
 * 本层只负责"营销域该留下的痕迹"，把边界划清楚才不会出现两个模块都能改订单金额。
 */
export function settle(db, {
  source,
  orderId,
  items = [],
  customerId = null,
  couponCodes = [],
  autoCoupon = false,
  usePoints = 0,
  at = null,
  orderAmountForPoints = null
} = {}) {
  const store = resolveDb(db)
  if (orderId == null) throw bad('缺少 orderId（优惠留痕与使用登记都要按订单归属）', 'BAD_ARGS', 400)
  // `source` 必填（迁移 030）：`oms_orders.id` 与 `pos_orders.id` 独立自增会撞号，
  // 留痕/登记/券/积分流水只按数字 id 归属会**串到另一张单**上，且不报错。
  if (!source) throw bad('缺少 source（结算留痕必须能定位到唯一一张单）', 'BAD_ARGS', 400)

  const q = quote(store, { items, customerId, couponCodes, autoCoupon, usePoints, at })
  const tx = store.transaction(() => {
    const out = { ...q }

    // ① 优惠留痕（幂等：persistAdjustments 先清后写）
    persistAdjustments(store, { source, orderId, actions: q.actions })

    // ② 使用登记（唯一键 + 条件式 UPDATE 防超发）
    const reg = registerUsage(store, { source, actions: q.actions, orderId, customerId })
    out.usage = reg

    // ③ 核销券：只核销**真正生效**的那些券（券对应促销码命中了才算）
    const accepted = q.coupon.accepted.filter((a) => q.applied_codes.includes(a.promotion_code))
    const redeemed = []
    for (const a of accepted) {
      // 抵扣额按该促销在本单的优惠总额记（一张券解锁一张促销，一一对应）
      const amt = q.actions.filter((x) => x.code === a.promotion_code).reduce((s, x) => s + x.amount, 0)
      C.redeemCoupon(store, { code: a.coupon_code, source, orderId, customerId, amountCents: amt, at: q.at })
      redeemed.push({ coupon_code: a.coupon_code, amount_cents: amt })
    }
    // 提交时把没生效的券也告诉调用方 —— 界面上要能回答"我那张券为什么没减钱"
    out.coupon.not_used = q.coupon.accepted
      .filter((a) => !q.applied_codes.includes(a.promotion_code))
      .concat(q.coupon.rejected)

    // ④ 积分：先扣抵扣，再按"实付金额"送分
    if (q.points_used > 0) {
      const r = M.redeemPoints(store, {
        customerId, points: q.points_used, orderAmountCents: q.payable + q.points_discount,
        source, orderId, remark: `${source} 单 #${orderId} 积分抵现`
      })
      out.points_redeemed = r
    }
    if (customerId != null) {
      // 送分基数用**实付金额**（不是原价）：按原价送分等于"优惠越多送分越多"，
      // 会把促销预算变成积分预算，且两个口径互相放大。
      const earnBase = orderAmountForPoints ?? q.payable
      const e = M.earnPoints(store, { customerId, orderAmountCents: earnBase, source, orderId })
      out.points_earned = e
    }
    out.redeemed_coupons = redeemed
    return out
  })
  return tx.immediate()
}

/**
 * 撤单：优惠留痕删掉、使用登记回退、券退回、积分**双向**回退、累计消费回退。
 *
 * **必须成对提供**：只撤一半的后果是"券退回来了但名额还占着"，
 * 而这两种账分别在两张表里，任何单表检查都发现不了。
 *
 * 旧实现漏掉的正是 A15 记录的三件事：
 *   ① **抵现的积分没有退回**（只扣了赠送分）—— 客户撤单白丢一笔积分；
 *   ② **累计消费没有回退** —— 撤掉的单继续顶着他的会员等级；
 *   ③ **逆向没有幂等标记** —— 重复撤单会把积分退/扣两遍。
 * 三件事都下沉到 `M.reverseOrderPoints()`（那里是唯一实现），本层只负责
 * 把"这一单的通道与实付金额"传下去。
 *
 * @param orderAmountCents 该单结算时计入累计消费的金额（**分**）。
 *        调用方从单据实际金额换算 —— 撤单要知道"当初记了多少"，才谈得上退回去。
 */
export function unsettle(db, { source, orderId, reason = '订单取消', orderAmountCents = 0 } = {}) {
  const store = resolveDb(db)
  if (orderId == null) throw bad('缺少 orderId', 'BAD_ARGS', 400)
  if (!source) throw bad('缺少 source（撤单必须只撤自己这一张单）', 'BAD_ARGS', 400)
  return store.transaction(() => {
    const usage = store
      .prepare('SELECT * FROM promotion_usages WHERE source=? AND order_id=?')
      .all(source, orderId)
    // 撤回促销使用（内部会删留痕 + 减少使用计数 + 回退预算）
    const rv = revertUsageInner(store, source, orderId)
    const released = C.releaseCoupon(store, { source, orderId, remark: `${reason}退回` })
    // 积分与累计口径：唯一实现见 member.reverseOrderPoints（含幂等标记与差额上报）
    let points = null
    const earnRows = store
      .prepare(
        "SELECT customer_id FROM member_points_ledger WHERE source_type='order' AND IFNULL(source,'')=? AND source_id=? LIMIT 1"
      )
      .get(source, orderId)
    if (earnRows?.customer_id != null) {
      points = M.reverseOrderPoints(store, {
        customerId: earnRows.customer_id,
        source,
        orderId,
        orderAmountCents,
        reason
      })
    }
    return {
      source,
      order_id: orderId,
      usages: usage.length,
      ...rv,
      coupons: released,
      points_reverted: points
    }
  }).immediate()
}

// revertUsage 以 db 为第一参（对外的 API），这里已经有 store 了，包一层避免重复 resolve
function revertUsageInner(store, source, orderId) {
  const rows = store
    .prepare('SELECT * FROM promotion_usages WHERE source=? AND order_id=?')
    .all(source, orderId)
  for (const u of rows) {
    store.prepare("UPDATE promotions SET used = MAX(0, used - 1), updated_at = datetime('now','localtime') WHERE id=?").run(u.promotion_id)
    store.prepare(`
      UPDATE promotion_campaign_budgets SET used = MAX(0, used - ?)
       WHERE campaign_id = (SELECT campaign_id FROM promotions WHERE id = ?) AND type='spend'
    `).run(u.amount, u.promotion_id)
  }
  store.prepare('DELETE FROM promotion_usages WHERE source=? AND order_id=?').run(source, orderId)
  const del = store
    .prepare('DELETE FROM promotion_adjustments WHERE source=? AND order_id=?')
    .run(source, orderId)
  return { adjustments: del.changes }
}

/**
 * 读回一张单的结算留痕（对账与断言用）。
 * 存在的理由：撤单是否"成对"只有把四张表的现状摆在一起才能判断，
 * 而分散在四处手写查询，任何一处漏写都看不出来。
 */
export function settlementOf(db, { source, orderId }) {
  const store = resolveDb(db)
  const adjustments = store
    .prepare('SELECT * FROM promotion_adjustments WHERE source=? AND order_id=? ORDER BY id')
    .all(source, orderId)
  const usages = store
    .prepare('SELECT * FROM promotion_usages WHERE source=? AND order_id=? ORDER BY id')
    .all(source, orderId)
  const coupons = store
    .prepare("SELECT coupon_code, status, used_amount FROM coupon_instances WHERE source=? AND order_id=? ORDER BY id")
    .all(source, orderId)
  const points = store
    .prepare(
      "SELECT kind, change_points, source_type FROM member_points_ledger WHERE IFNULL(source,'')=? AND source_id=? ORDER BY id"
    )
    .all(source, orderId)
  return { source, order_id: orderId, adjustments, usages, coupons, points }
}

export default { buildItems, quote, distribute, settle, unsettle, settlementOf }
