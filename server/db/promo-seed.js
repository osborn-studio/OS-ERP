/**
 * ============================================================================
 * 文件标识：server/db/promo-seed.js ｜ 商城促销与会员演示数据（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
 * ============================================================================
 * 【职责】商城促销与会员演示数据（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 商城促销与会员演示数据（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
//
// ============================================================================
// 一、为什么必须专门造数
// ============================================================================
// 促销与会员这两个域有一个共同特征：**空的时候和"没做好"的时候长得一模一样**。
// 促销列表空着，看不出是"没有活动"还是"活动没生效"；会员详情里全是 0，
// 看不出是"新客户"还是"等级判定没跑"。所以这里必须刻意造出每一种形态，
// 让每个非退化指标都至少有一个非零样本：
//
//   | 要看见的东西 | 样本 |
//   | --- | --- |
//   | 自动促销（无需券） | 满减 / 折扣各一张，任意订单都会命中 |
//   | 券促销（需券码） | 两张，只能靠券解锁 —— 用来演示"为什么我的券没减钱" |
//   | 独占促销 | 一生效其它全不参与（优先级的极端形态） |
//   | 同组互斥 | 同组两张不同力度，只取先命中的那张 |
//   | 买赠 | 买 N 件送一件（`buy_rules_min_quantity` + `gift_sku_id`） |
//   | 限量 | 一张使用次数很小的促销，**被打满**，界面上能看到"已用完" |
//   | 会员多等级 | 普通 / 银牌 / 金牌 / 铂金各至少一个 |
//   | 积分流水正负 | 获得（earn）、兑换抵扣（redeem）、人工调整（adjust）都有 |
//   | 储值 | 有充值、有消费，余额非零 |
//   | 券的四态 | 未使用 / 已核销 / 已过期 / 已作废 各有样本 |
//
// ============================================================================
// 二、两条造数纪律（本项目踩过的坑，写在这里防止回退）
// ============================================================================
//
// 1) **一律走服务函数，不手工 INSERT 业务行。**
//    促销用 `promotion.createPromotion`、券用 `coupon.createCoupon`、
//    订单结算用 `checkout.settle` —— 与界面点击完全同一条代码路径。
//    手工 INSERT 最容易漏掉派生列（比如 `promotions.used` 计数器、
//    `coupon_instances.issued_qty`），而漏掉的表现是"限量券明明没人用却显示已用满"
//    这类完全看不出原因的现象。
//
// 2) **金额不写死，从等级门槛与真实售价推导（行业比例化）。**
//    三个库的客单价差一个数量级：美妆均价约 400 元、餐饮约 28 元、服饰约 994 元。
//    写死"充值 5000 元 / 买 3 件"这种绝对值，到餐饮库就会变成一个荒谬的订单，
//    到服饰库又小到撑不起等级。所以：
//      · 订单金额目标 = 从 `member_levels.min_spent_yuan` **读出来**再乘一点余量；
//      · 数量 = 目标金额 ÷ 实际售价（向上取整），不写件数；
//      · 储值金额 = 该行业客单价 × 一个比例。
//
// ============================================================================
// 三、数据形态
// ============================================================================
//   · 2 个活动：一个进行中、一个已结束；
//   · 10 张促销：已结束样本 + 自动满减 / 自动折扣 / 独占 / 同组互斥 ×2 / 买赠 / 券促销 ×2 / 限量；
//   · 3 张券模板：满减券（发 3 张，分别未使用 / 已核销 / 已过期）、
//                 限量券（发行量发满）、新人券（含 1 张已作废）；
//   · 4 个会员：普通 / 银牌 / 金牌 / 铂金，各由若干张真实 H5 订单累积出来；
//   · 每张订单都真的过了一遍结算（留痕 + 使用登记 + 核销券 + 送积分）。

import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow, ymd, RI, R } from './seed.js'
import * as P from '../lib/promotion.js'
import * as M from '../lib/member.js'
import * as C from '../lib/coupon.js'
import * as K from '../lib/checkout.js'

const ymdhms = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const shift = (d, days, hours = 0) => new Date(d.getTime() + days * 86400000 + hours * 3600000)

export function seedPromo(db, { silent = true } = {}) {
  requireDemoDatabase(db)
  const log = silent ? () => {} : (...a) => console.log('  [promo]', ...a)

  // 幂等：库里已经有促销就整段跳过。
  // satellite 每次服务启动都会跑一遍，而演示现场真点出来的活动必须留住。
  if (db.prepare('SELECT COUNT(*) AS c FROM promotions').get().c > 0) {
    log('已存在促销数据，跳过')
    return { skipped: true }
  }

  const base = seedNow()
  const customers = db.prepare('SELECT * FROM mall_customers ORDER BY id').all()
  const platform = db.prepare("SELECT * FROM platforms WHERE code='H5'").get()
  if (!customers.length || !platform) {
    log('没有商城客户或 H5 平台，跳过')
    return { skipped: true, reason: 'no_customer_or_platform' }
  }
  const skus = db.prepare(
    "SELECT s.*, p.name AS product_name, p.category_id FROM product_skus s LEFT JOIN products p ON p.id=s.product_id" +
    " WHERE s.status='active' ORDER BY s.id"
  ).all()
  if (skus.length < 3) {
    log('可用 SKU 不足，跳过')
    return { skipped: true, reason: 'not_enough_sku' }
  }

  // 行业客单价基线：用零售均价当尺子，后面所有金额都按它缩放
  const avgPrice = Math.max(1, Number(db.prepare(
    "SELECT AVG(price_retail) AS p FROM product_skus WHERE status='active'"
  ).get().p) || 1)
  const yuan = (n) => Math.max(1, Math.round(n))

  // ---------- 1. 活动 ----------
  const campLive = P.createCampaign(db, {
    code: 'CMP_AUTUMN', name: '秋季焕新季',
    description: '秋季主推档期：满减与折扣叠加，会员另有专属券',
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20))
  })
  const campEnded = P.createCampaign(db, {
    code: 'CMP_SUMMER', name: '夏季清仓（已结束）',
    description: '留作历史样本：活动已结束，其下促销不应再命中',
    starts_at: ymdhms(shift(base, -90)), ends_at: ymdhms(shift(base, -50)), status: 'ended'
  })
  // 已结束活动下挂一张促销，用来说明「活动结束了但促销还 active」时
  // 命中与否由**促销自己的时间窗**决定 —— 这是刻意的，不是漏洞。
  P.createPromotion(db, {
    code: 'ENDED_STOCK', name: '夏季清仓·满 300 减 60', campaign_id: campEnded.id,
    is_automatic: true, priority: 300,
    starts_at: ymdhms(shift(base, -90)), ends_at: ymdhms(shift(base, -50)),
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 2) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: String(yuan(avgPrice * 3) * 100) }] }
  })

  const thr = (mult) => String(yuan(avgPrice * mult) * 100) // 门槛一律用「分」

  // ① 自动满减（整单分摊）——最常规的一张，任何订单都可能命中
  P.createPromotion(db, {
    code: 'AUTO_FULL', name: `满 ${yuan(avgPrice * 3)} 减 ${yuan(avgPrice * 0.6)}`, campaign_id: campLive.id,
    is_automatic: true, priority: 10,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '档期主推：整单满减，优惠按行占比分摊，退货时能按行退准',
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 0.6) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(3) }] }
  })

  // ② 自动折扣（逐行）——用来演示"每行各自打折"与整单分摊的差别
  P.createPromotion(db, {
    code: 'AUTO_PCT95', name: '会员日 95 折', campaign_id: campLive.id,
    is_automatic: true, priority: 40,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '逐行 95 折：每行独立计算，不与行内已优惠额重复打折',
    // value 是**减免率**万分比：95 折 = 减 5% = 500。写 9500 会被当成"减 95%"（实付 5%），
    // 而且不会报错 —— 这正是本项目反复强调"方向错了不报错"的那类缺陷。
    method: { type: 'percentage', target_type: 'items', allocation: 'each', value: 500 },
    rules: {}
  })

  // ③ 独占促销 —— 一生效其它全不参与。优先级设得很靠前，用来演示"独占"的极端形态
  P.createPromotion(db, {
    code: 'AUTO_EXCLUSIVE', name: '爆款直降（独占）', campaign_id: campLive.id,
    is_automatic: true, priority: 1, is_exclusive: true,
    starts_at: ymdhms(shift(base, -3)), ends_at: ymdhms(shift(base, 3)),
    remark: '独占：命中后其它活动一律不参与。用来演示"为什么别的活动没生效"',
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 0.2) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(10) }] }
  })

  // ④ 同组互斥：两张同组、力度不同 —— 只取先命中的那张（界面要能解释"另一张为什么没用"）
  P.createPromotion(db, {
    code: 'GRP_FULL_A', name: `同组券 A·满 ${yuan(avgPrice * 5)} 减 ${yuan(avgPrice * 1.2)}`, campaign_id: campLive.id,
    is_automatic: true, priority: 60, stack_group: 'STACK_SEASON',
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '与同组 B 互斥：一组只取最先命中的那张。优先级数值小者先算',
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 1.2) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(5) }] }
  })
  P.createPromotion(db, {
    code: 'GRP_PCT_B', name: '同组券 B·9 折', campaign_id: campLive.id,
    is_automatic: true, priority: 70, stack_group: 'STACK_SEASON',
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '与同组 A 互斥。谁的 priority 数值小谁先算，后者被记为 stack_group 跳过',
    // 9 折 = 减 10% = 1000。同 AUTO_PCT95，绝不是 9000。
    method: { type: 'percentage', target_type: 'order', allocation: 'across', value: 1000 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(5) }] }
  })

  // ⑤ 买赠 —— 买 N 件送一件（赠品是真实 SKU）
  const giftSku = skus[skus.length - 1]
  P.createPromotion(db, {
    code: 'BUYGET_3G1', name: `买 3 件送 1 件（${giftSku.name}）`, campaign_id: campLive.id,
    type: 'buyget', is_automatic: true, priority: 90,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '买赠：买够件数才生效，赠品在方式里指定',
    method: {
      type: 'fixed', target_type: 'items', allocation: 'once', value: 0,
      max_quantity: 3, buy_rules_min_quantity: 3, apply_to_quantity: 1, gift_sku_id: giftSku.id
    },
    rules: { buy_rules: [{ attribute: 'qty', operator: 'gte', value: '3' }] }
  })

  // ⑥ 券促销 ×2 —— 非自动，必须有券码。这就是"券解锁促销"的接缝
  const SCALE = `满 ${yuan(avgPrice * 4)} 减 ${yuan(avgPrice * 1)}`
  const promoFullForCoupon = P.createPromotion(db, {
    code: 'COUPON_FULL', name: `券专享·${SCALE}`, campaign_id: campLive.id,
    is_automatic: false, priority: 20, usage_limit: 5,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '非自动：没有券码一律不参与。券里的减免说明只是展示，真正算钱的是这张促销',
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 1) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(4) }] }
  })
  P.createPromotion(db, {
    code: 'COUPON_NEWBIE', name: `新人专享·满 ${yuan(avgPrice)} 减 ${yuan(avgPrice * 0.3)}`,
    campaign_id: campLive.id, is_automatic: false, priority: 15, usage_limit: 5,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: '低门槛券：演示"同一单里两张券只挑能生效的那张"',
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 0.3) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(1) }] }
  })

  // ⑦ 限量促销 —— 使用次数很小，下面会被真实订单打满
  const LIMITED_LIMIT = 2
  P.createPromotion(db, {
    code: 'AUTO_LIMITED', name: '限量秒杀·前 2 单', campaign_id: campLive.id,
    is_automatic: true, priority: 2, usage_limit: LIMITED_LIMIT,
    starts_at: ymdhms(shift(base, -20)), ends_at: ymdhms(shift(base, 20)),
    remark: `总使用次数上限 ${LIMITED_LIMIT}，用满后注册表拒绝再登记（条件式 UPDATE 兜底防超发）`,
    method: { type: 'fixed', target_type: 'order', allocation: 'across', value: yuan(avgPrice * 0.15) * 100 },
    rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: thr(2) }] }
  })

  // ---------- 2. 券模板 ----------
  const tplFull = C.createCoupon(db, {
    code: 'CP_FULL', name: SCALE, promotion_id: promoFullForCoupon.id,
    type: 'fixed', value: yuan(avgPrice * 1) * 100,
    min_subtotal: yuan(avgPrice * 4) * 100,
    per_user_limit: 1, valid_days: 30,
    remark: '档期主券：绑 COUPON_FULL 促销，领取后 30 天有效'
  })
  const tplLimited = C.createCoupon(db, {
    code: 'CP_LIMITED', name: '限量新人券（发行量很小）', promotion_id: promoFullForCoupon.id,
    type: 'fixed', value: yuan(avgPrice * 0.3) * 100, min_subtotal: thr(1),
    total_qty: 2, per_user_limit: 1, valid_days: 15,
    remark: '发行量只有 2 张：用来演示"发行量已用尽"时的发放拦截'
  })
  const tplNewbie = C.createCoupon(db, {
    code: 'CP_NEWBIE', name: `新人券·减 ${yuan(avgPrice * 0.3)}`, promotion_id: P.getPromotionDetail(db, 'COUPON_NEWBIE').id,
    type: 'fixed', value: yuan(avgPrice * 0.3) * 100, min_subtotal: 0,
    per_user_limit: 2, valid_days: 7,
    remark: '0 门槛：用来演示无门槛券与门槛券在同一单里的差别'
  })

  // ---------- 3. 券的发放 —— **必须排在造单之前** ----------
  // 时序是关键：`placeOrder` 会去查客户**当前可用**的券；如果券还没发，
  // 它一张都找不到 → 订单里 `couponCodes` 为空 → 券永远停在 unused，
  // 「券核销」这条演示线整个消失，而且**不报错**（无券下单本来就是合法路径）。
  // 这正是本模块要防的那类缺陷：不是崩，是静默少了一段。
  const custA = customers[0]
  const custB = customers[1] || customers[0]
  const custC = customers[2] || customers[0]

  // ① 已核销样本：custB 领的这张，下面造单时会被显式用掉
  C.issueCoupons(db, { couponId: tplFull.id, customerId: custB.id, qty: 1, remark: '档期发券' })
  // ② 未使用样本：custA 领了放着（到期样本特意挑了别的客户，避免把这张也推到过期）
  C.issueCoupons(db, { couponId: tplFull.id, customerId: custA.id, qty: 1, remark: '档期发券' })
  // ③ 已过期样本：custC 领的这张，下面把到期时刻推到过去
  C.issueCoupons(db, { couponId: tplFull.id, customerId: custC.id, qty: 1, remark: '档期发券（演示过期）' })
  // 新人券 ×2（custB）：一张留未使用、一张作废
  C.issueCoupons(db, { couponId: tplNewbie.id, customerId: custB.id, qty: 2, remark: '新客注册礼' })
  // 限量券发满（发行量 2 张，全部发出去 → 界面上能看到"已发满"）
  C.issueCoupons(db, { couponId: tplLimited.id, customerId: custA.id, qty: 1, remark: '限量券' })
  C.issueCoupons(db, { couponId: tplLimited.id, customerId: custC.id, qty: 1, remark: '限量券' })

  // 券的「领取时刻」统一按**灌数时钟**回填，而不是用 `issueCoupons` 内部那个真实时钟。
  // 两个理由：
  //   ① 演示订单是按灌数时钟**倒推**的（最近 18 天内）；券若用真实时钟，反而"晚于"订单，
  //      `validateCoupon` 会判 `not_started`（券尚未生效）→ 券永远核销不掉，**且不报错**；
  //   ② 领取时刻参与有效期推导，是**业务值**不是审计时间戳 —— 不固定它，
  //      「同一份 seed → 同一张库」在券表上就不成立。
  // 回填天数按「必须晚于账单窗口 + 不超过模板有效期」取；有效期短的模板回填得少。
  const backdate = (couponId, customerId, days) => {
    const tpl = db.prepare('SELECT * FROM coupons WHERE id=?').get(couponId)
    const valid = Number(tpl.valid_days || 0)
    db.prepare(
      "UPDATE coupon_instances SET acquired_at=?, expires_at=? WHERE coupon_id=? AND customer_id=? AND status='unused'"
    ).run(ymdhms(shift(base, -days)), ymdhms(shift(base, -days + valid)), couponId, customerId)
  }
  backdate(tplFull.id, custA.id, 25)     // 未使用样本；30 天有效期 → 到期 base+5，覆盖账单窗口
  backdate(tplFull.id, custB.id, 25)     // 将被核销的那张（必须早于订单时刻）
  backdate(tplFull.id, custC.id, 60)     // 已过期样本：领得够久 + 30 天有效期 → 到期 base−30
  backdate(tplNewbie.id, custB.id, 3)    // 7 天有效期 → 到期 base+4，仍可用
  backdate(tplLimited.id, custA.id, 5)   // 15 天有效期 → 到期 base+10
  backdate(tplLimited.id, custC.id, 5)

  // 已作废：一张新人券被客服作废（必须写原因）
  const toVoid = db.prepare(
    "SELECT * FROM coupon_instances WHERE coupon_id=? AND customer_id=? AND status='unused' ORDER BY id DESC LIMIT 1"
  ).get(tplNewbie.id, custB.id)
  if (toVoid) C.voidInstance(db, { instanceId: toVoid.id, remark: '演示样本：客服作废（重复领取）' })

  // 跑一次过期扫描：把 expires_at 已过的那批真的置成 status='expired'。
  // 只回填 expires_at 的话，状态列仍是 unused —— 界面上靠 effectiveStatus 推导能显示"已过期"，
  // 但**直接查库**（或写入对照表）看到的是 unfinished 状态，两处对不上。
  // 扫描时刻用灌数时钟，与上面回填的口径同源。
  C.expireCoupons(db, { at: ymdhms(base) })

  // ---------- 4. 会员造数：用真实 H5 订单把客户累积到不同等级 ----------
  // 等级门槛**从库里读**（比例化的落点）：不写死"消费 8000 元"，
  // 而是读 `member_levels.min_spent_yuan`，这样三个行业各自成立。
  const levels = M.listLevels(db)
  const levelByCode = new Map(levels.map((l) => [l.code, l]))
  const targets = ['normal', 'silver', 'gold', 'platinum'].filter((c) => levelByCode.has(c))

  let orderSeq = 0
  let orders = 0
  let discounted = 0

  /**
   * 造一张真实 H5 订单并真正过一遍结算。
   * 先插 `oms_orders` / `oms_order_items`（拿到行 id），再让结算层按这些行 id 落优惠留痕 ——
   * 这样 `promotion_adjustments.item_id` 指向的是**真实订单行**，
   * 订单详情里"这一行为什么减了 30 元"才对得上。
   */
  function placeOrder({ customer, amountTarget, useCoupon = false, markPaid = true, ceilingCents = Infinity }) {
    const lines = []
    let goodsCents = 0
    let guard = 0
    while (goodsCents < amountTarget && guard < 12) {
      // 注意：`PICK(arr, n)` 返回的是**数组**（取 n 个），取单个元素要用 `R(arr)`。
      // 用错的表现是 `sku.id` 为 undefined，一路静默传到结算层才报「明细缺少 sku_id」。
      const sku = R(skus)
      if (lines.some((l) => l.sku.id === sku.id)) { guard += 1; continue }
      const unitCents = Math.max(1, Math.round(Number(sku.price_retail) * 100))
      let qty = Math.min(Math.max(1, Math.ceil((amountTarget - goodsCents) / unitCents)), 400)
      // 硬天花板：凑目标额可以超出，但**绝不允许**把这张单撑过 `ceilingCents`。
      // 为什么需要它：购物车是「凑到目标额为止」，最后一件事必然超出目标（最多一件），
      // 而"超出多少"取决于客单价 —— 服装库一件就顶几百元，于是一张目标 ¥800 的单
      // 实际能做出 ¥1400 的货。演示数据里"普通会员"这一档的约束是**上界**
      // （跨过银牌门槛这个样本就不存在了），所以必须有硬顶，不能只靠"目标值调小"。
      if (goodsCents + qty * unitCents > ceilingCents) {
        qty = Math.floor((ceilingCents - goodsCents) / unitCents)
        if (qty < 1) break
      }
      lines.push({ sku, qty, unitCents })
      goodsCents += qty * unitCents
      guard += 1
    }
    if (!lines.length) return null

    const goods = Number((goodsCents / 100).toFixed(2))
    const freight = goods >= yuan(avgPrice * 2) ? 0 : 12
    orderSeq += 1
    // 订单落在最近 18 天内：主力促销的时间窗是「灌数时刻 ±20 天」。
    // 订单早于窗口就一张都命不中，演示时看起来像「促销根本没生效」。
    const orderTime = shift(base, -RI(2, 18), -RI(0, 12))
    const orderNo = `H5${ymd(orderTime).replace(/-/g, '')}${String(orderSeq).padStart(6, '0')}`
    const info = db.prepare(`
      INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,
        goods_amount,freight,discount_amount,pay_amount,receiver,receiver_phone,receiver_address,sync_at,remark)
      VALUES (?,?,?,?,?,'completed',?,?,0,?,?,?,?,?,?)
    `).run(platform.id, orderNo, `会员${customer.phone}`, ymdhms(orderTime), ymdhms(shift(orderTime, 0, 0.01)),
      goods, freight, Number((goods + freight).toFixed(2)),
      customer.name, customer.phone, '演示收货地址', ymdhms(orderTime), '促销演示单（模块 18 seed）')
    const oid = Number(info.lastInsertRowid)

    const insItem = db.prepare(
      'INSERT INTO oms_order_items (oms_order_id,platform_sku_code,sku_id,title,spec,price,qty,amount) VALUES (?,?,?,?,?,?,?,?)'
    )
    const items = []
    for (const l of lines) {
      const r = insItem.run(oid, l.sku.sku_code || `SKU${l.sku.id}`, l.sku.id,
        `${l.sku.product_name || ''} ${l.sku.name}`.trim(), l.sku.spec || null,
        l.unitCents / 100, l.qty, (l.unitCents * l.qty) / 100)
      items.push({ item_id: Number(r.lastInsertRowid), sku_id: l.sku.id, qty: l.qty, unit_price_cents: l.unitCents })
    }

    // 券码：显式传（这里正是要演示"券要显式选"这条口径）
    let couponCodes = []
    if (useCoupon) {
      const owned = C.availableCoupons(db, { customerId: customer.id, orderAmountCents: goodsCents })
      const usable = owned.usable.filter((u) => u.coupon_code.startsWith('CP_FULL-'))
      if (usable.length) couponCodes = [usable[0].coupon_code]
    }

    const settled = K.settle(db, {
      // 通道：seed 的单挂在 `oms_orders` 上（迁移 030 起 `source` 必填）
      source: 'oms',
      orderId: oid,
      items: K.buildItems(db, items),
      customerId: customer.id,
      couponCodes,
      at: ymdhms(orderTime)
    })

    // 把结算结果回写到订单头与行上 —— 订单要能自己解释"优惠了多少钱、减在哪几行"
    const byItem = new Map(settled.line_discounts.map((l) => [l.item_id, l]))
    const updItem = db.prepare(
      'UPDATE oms_order_items SET member_discount_cents=?, promo_discount_cents=?, points_discount_cents=? WHERE id=?'
    )
    for (const [iid, l] of byItem) {
      updItem.run(l.member_discount, l.promotion_discount, l.points_discount, iid)
    }
    db.prepare('UPDATE oms_orders SET discount_amount=?, pay_amount=? WHERE id=?')
      .run(settled.discount_total / 100, Number((goods + freight - settled.discount_total / 100).toFixed(2)), oid)
    db.prepare("UPDATE oms_orders SET status=? WHERE id=?").run(markPaid ? 'completed' : 'pending', oid)

    orders += 1
    if (settled.discount_total > 0) discounted += 1
    return { oid, settled }
  }

  const spentOf = (customerId) => Number(
    db.prepare('SELECT COALESCE(total_spent_cents,0) AS s FROM member_accounts WHERE customer_id=?')
      .get(customerId)?.s ?? 0
  )

  // 每个客户一个目标等级：**按需追加订单**直到累计消费跨过门槛。
  // 为什么不是「按固定余量一次性算出总金额」：会员累计消费记的是**实付**
  // （`earnPoints` 的基数传的是 `payable`），打折越深累积越慢。写死一个余量倍数
  // （曾经是 1.35）在折扣深的行业会差一大截 —— 实测美妆库铂金客户只累到 2.3 万，
  // 离 3 万门槛还差一截，界面上就是"没有铂金会员"。
  // 所以这里改成闭环：造一批 → 看还差多少 → 再补，直到跨过门槛或触到单数上限。
  const promoUse = [false, true, false, false] // 只有 custB（银牌）那单用到券 → 造出"已核销"样本
  const targetByCustomer = customers.slice(0, targets.length)
  targetByCustomer.forEach((customer, idx) => {
    const code = targets[idx] || 'normal'
    const lv = levelByCode.get(code)
    // normal 客户刻意停在下一档门槛之下（×0.35），否则会串到银牌。
    // 光把**目标值**调小是不够的 —— 目标值是"停在哪"，而这一档真正的约束是**上界**：
    // 跨过下一档门槛，这个样本就没了。所以同时给出硬顶 `hardCap`，
    // 由 `placeOrder` 的 `ceilingCents` 保证"货值"不可能越过它
    //（服装库客单价高，"凑目标额"的最后一件事把货值顶上天，真实踩到：
    //  普通会员的累计消费到 ¥2111 ≥ 银牌 ¥2000，于是四个等级只剩三个，
    //  verify-seed 第 13 节的覆盖度断言就是这样抓到的）。
    const nextUp = levelByCode.get(targets[1] || code)
    const nextCapCents = Math.max(1, Math.round(Number(nextUp?.min_spent_yuan || 0) * 100))
    const isBase = code === 'normal'
    const hardCap = isBase ? Math.floor(nextCapCents * 0.6) : Infinity
    const needCents = isBase
      ? Math.max(1, Math.round(nextCapCents * 0.35))
      : Math.max(1, Math.round(Number(lv?.min_spent_yuan || 0) * 100))
    let couponUsed = false
    let guard = 0
    // 用券那一单必须**够得到券门槛**（`min_subtotal`），否则结算会以 `below_min` 拒掉它，
    // 券又回到 unused —— 演示里看不出"券被用过"，也不会报错。
    // 服装库最容易踩到：券门槛 = 4×均价 ≈ 3976 元，而银牌会员的目标订单额只有 2000 元。
    const couponFloor = Math.ceil(Number(tplFull.min_subtotal || 0) * 1.15)
    // 上限 12 单：一般情况下 2~5 单就跨过，余量给足但绝不留死循环的可能
    while (spentOf(customer.id) < needCents && guard < 12) {
      const spent = spentOf(customer.id)
      const gap = Math.max(1, needCents - spent)
      // 标价目标 = 剩余缺口的一半 × 余量（余量逐轮放大）。
      // 为什么是"一半 + 余量"而不是"整缺口 × 固定余量"：后者会造出单笔几万元的大单，
      // 演示里看得出来是"为了凑数而凑数"，会员时间线也只剩一两个点。
      // 一半保证至少拆成 2~3 单；余量逐轮放大保证有限轮次内跨过门槛
      //（实付约为标价的 6~8 折，按 1:1 造货会"每次差一点"、收敛到门槛之下跨不过去）。
      // 外层再套一层 `min(needCents, …)`：普通会员的目标额只有几百元，
      // 若让"每单至少 avgPrice×20"的下限生效，一单就冲到银牌去了。
      const wantPer = Math.max(Math.round(avgPrice * 20 * 100), Math.ceil(gap * (1.5 + guard * 0.15) / 2))
      const room = isBase ? hardCap - spent : Infinity
      if (room < 1) break // 已贴近硬顶：普通会员样本到此为止，宁可少造几单也不越档
      const per = Math.min(needCents, wantPer, room)
      const useCoupon = promoUse[idx] && !couponUsed
      placeOrder({
        customer,
        amountTarget: useCoupon ? Math.max(per, couponFloor) : per,
        // 用券那一单要够到券门槛，所以它的硬顶也要跟着抬（否则两件事互相打架）
        ceilingCents: useCoupon ? Math.max(hardCap, couponFloor) : hardCap,
        useCoupon
      })
      if (promoUse[idx]) couponUsed = true
      guard += 1
    }
  })

  // ---------- 5. 储值：充值 + 消费，让余额非零 ----------
  // 金额按行业客单价缩放（比例化的第二处落点）
  const rechargeYuan = yuan(avgPrice * 6)
  M.rechargeBalance(db, {
    customerId: custC.id, amountCents: rechargeYuan * 100,
    docNo: 'DEMO-RECHARGE-01', remark: '演示样本：门店储值活动充值'
  })
  // 消费一课：按客单价的 1.5 倍用掉一部分，余额仍为正
  const payYuan = yuan(avgPrice * 1.5)
  try {
    const paid = M.payByBalance(db, {
      customerId: custC.id, amountCents: payYuan * 100, remark: '演示样本：储值支付一单'
    })
    log('储值消费', paid)
  } catch (e) {
    log('储值消费跳过：', e.message)
  }

  // ---------- 6. 人工调整积分（正负各一笔，都必须带理由） ----------
  M.adjustPoints(db, {
    customerId: custB.id, change: yuan(avgPrice * 2), remark: '演示样本：周年庆补偿积分', actor: 'seed'
  })
  M.adjustPoints(db, {
    customerId: custC.id, change: -Math.max(1, Math.floor(yuan(avgPrice * 0.5))),
    remark: '演示样本：积分误发回收', actor: 'seed'
  })

  // ---------- 7. 强制一次等级重判，确保冗余列与账户一致 ----------
  for (const c of customers) {
    if (db.prepare('SELECT 1 AS h FROM member_accounts WHERE customer_id=?').get(c.id)) {
      M.syncLevel(db, c.id)
    }
  }

  const summary = {
    skipped: false,
    campaigns: db.prepare('SELECT COUNT(*) AS c FROM promotion_campaigns').get().c,
    promotions: db.prepare('SELECT COUNT(*) AS c FROM promotions').get().c,
    coupons: db.prepare('SELECT COUNT(*) AS c FROM coupons').get().c,
    instances: db.prepare('SELECT COUNT(*) AS c FROM coupon_instances').get().c,
    accounts: db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get().c,
    orders,
    discounted
  }
  log('促销', summary.promotions, '券模板', summary.coupons, '券实例', summary.instances,
    '会员账户', summary.accounts, '订单', orders, '（其中命中优惠', discounted, '）')
  return summary
}

export default { seedPromo }
