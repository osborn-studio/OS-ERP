/**
 * ============================================================================
 * 文件标识：scripts/test-promo.mjs ｜ 测试：促销与会员测试（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
 * ============================================================================
 * 【职责】测试：促销与会员测试（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 促销与会员测试（模块 18 · 活动 / 促销 / 券 / 等级 / 积分 / 储值）
 *
 * 本域的危险不在"算不出来"，而在**算错了但一切正常**：
 * 券静默被用掉、优惠方向写反、余额与流水悄悄分叉、撤单只撤了一半。
 * 所以本测试的重心是把三条硬口径 + 四条防事故约束一条条钉死：
 *
 *   ① **算钱顺序固定**：会员折扣（作用于原价）→ 促销（在会员价上叠加）
 *      → 积分抵扣（只作用于最终成交价）。顺序错一位不会报错，只会算少/算多；
 *   ② **优惠必须摊到行**：行优惠合计恒等于整单优惠，不平即抛 ALLOCATION_MISMATCH；
 *   ③ **余额不是真相，流水才是**：每次变动写流水并带 `balance_after`，账户余额 = 流水合计；
 *   ④ 券**默认不自动使用**（要显式传码或显式声明 autoCoupon）；
 *   ⑤ 优惠有**最低价地板**（`product_skus.price_min`），闸住 0 元单；
 *   ⑥ 撤单退分**按余额封顶**并把差额报成 `shortfall`，不许因为分不够就整笔失败；
 *   ⑦ 券的优惠额**只由促销引擎算**（券表的 type/value 仅展示）。
 *
 * 与定价 / 成本 / 发票 / 质检测试同一规矩：**串行跑**
 * （并行写同一个 SQLite 会 WAL 竞争）。用法：node scripts/test-promo.mjs [industry]
 *
 * 关于「可重复跑」：
 *   本轮会真的建促销、建券、发券、落单、送分、核销 —— 全部带标记（见下），
 *   开跑前先按标记把自己上一轮的残留删干净（子表在前、父表在后）。
 *   标记：促销 `TP-` / 券 `TC-` / 活动 `TCMP-` / 客户手机号 `199%` / 订单 remark `【TEST-PROMO】`。
 *   另外：为了让断言只受**被测促销**影响，全程把库里其它促销临时停用，
 *   跑完按开跑时的状态快照**逐一还原**（而不是笼统地全设 active，那会改坏别人手工停用的促销）。
 */
import { getDbFor } from '../server/db/index.js'
import {
  PROMO_TYPE, createPromotion, updatePromotion, listPromotions, validatePromotionDraft,
  setPromotionStatus, createCampaign, listCampaigns, computePromotionActions, explainPromotion
} from '../server/lib/promotion.js'
import * as M from '../server/lib/member.js'
import * as C from '../server/lib/coupon.js'
import * as K from '../server/lib/checkout.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

// 业务时刻：促销窗口刻意开得很宽，券则是由 `issueCoupons` 按**真实时钟**打领取时刻的
// —— 所以这里不能用"过去的固定时刻"当 `at`，否则券会一律被判 `not_started`（还没发就想用）。
// 取"真实时钟 + 5 秒"：既保证券已生效，又不依赖具体是哪一天（断言都是相对口径）。
const AT = new Date(Date.now() + 5000).toISOString().slice(0, 19).replace('T', ' ')
const W_FROM = '2026-01-01 00:00:00'
const W_TO = '2030-01-01 00:00:00'

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg) {
  if (cond) pass++
  else { fail++; failures.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg) }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const num = (v) => Number(v) || 0
const okNear = (a, b, msg, eps = 0.005) => {
  if (!(Math.abs(num(a) - num(b)) <= eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(Math.abs(num(a) - num(b)) <= eps, msg)
}
const throwsCode = (fn, code, msg) => {
  try { fn() } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：抛的是 ${e.code || e.name}/${e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}
const noThrow = (fn, msg) => {
  try { fn(); ok(true, msg) } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${msg}：意外抛错 ${e.code || e.name}/${e.message}`)
    ok(false, msg)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

console.log(`\n=== 促销与会员（模块 18 · ${INDUSTRY}） ===`)

// ---------------------------------------------------------------------------
// -1. 残留自愈 + 促销状态快照
// ---------------------------------------------------------------------------
const PH = (n) => Array.from({ length: n }, () => '?').join(',')
function clean() {
  db.transaction(() => {
    const ordIds = db.prepare("SELECT id FROM oms_orders WHERE remark LIKE '%【TEST-PROMO】%'").all().map((r) => r.id)
    if (ordIds.length) {
      const ph = PH(ordIds.length)
      db.prepare(`DELETE FROM promotion_adjustments WHERE order_id IN (${ph})`).run(...ordIds)
      db.prepare(`DELETE FROM promotion_usages WHERE order_id IN (${ph})`).run(...ordIds)
      db.prepare(`DELETE FROM coupon_instances WHERE order_id IN (${ph})`).run(...ordIds)
      db.prepare(`DELETE FROM oms_order_items WHERE oms_order_id IN (${ph})`).run(...ordIds)
      db.prepare(`DELETE FROM oms_orders WHERE id IN (${ph})`).run(...ordIds)
    }
    const custIds = db.prepare("SELECT id FROM mall_customers WHERE phone LIKE '199%'").all().map((r) => r.id)
    if (custIds.length) {
      const ph = PH(custIds.length)
      db.prepare(`DELETE FROM coupon_instances WHERE customer_id IN (${ph})`).run(...custIds)
      db.prepare(`DELETE FROM member_points_ledger WHERE customer_id IN (${ph})`).run(...custIds)
      db.prepare(`DELETE FROM member_balance_ledger WHERE customer_id IN (${ph})`).run(...custIds)
      db.prepare(`DELETE FROM member_accounts WHERE customer_id IN (${ph})`).run(...custIds)
      db.prepare(`DELETE FROM mall_customers WHERE id IN (${ph})`).run(...custIds)
    }
    const cpnIds = db.prepare("SELECT id FROM coupons WHERE code LIKE 'TC-%'").all().map((r) => r.id)
    if (cpnIds.length) {
      const ph = PH(cpnIds.length)
      db.prepare(`DELETE FROM coupon_instances WHERE coupon_id IN (${ph})`).run(...cpnIds)
      db.prepare(`DELETE FROM coupons WHERE id IN (${ph})`).run(...cpnIds)
    }
    const prmIds = db.prepare("SELECT id FROM promotions WHERE code LIKE 'TP-%'").all().map((r) => r.id)
    if (prmIds.length) {
      const ph = PH(prmIds.length)
      db.prepare(`DELETE FROM promotion_adjustments WHERE promotion_id IN (${ph})`).run(...prmIds)
      db.prepare(`DELETE FROM promotion_usages WHERE promotion_id IN (${ph})`).run(...prmIds)
      db.prepare(`DELETE FROM promotion_methods WHERE promotion_id IN (${ph})`).run(...prmIds)
      db.prepare(`DELETE FROM promotion_rules WHERE promotion_id IN (${ph})`).run(...prmIds)
      db.prepare(`DELETE FROM promotions WHERE id IN (${ph})`).run(...prmIds)
    }
    db.prepare(`DELETE FROM promotion_campaign_budgets WHERE campaign_id IN
      (SELECT id FROM promotion_campaigns WHERE code LIKE 'TCMP-%')`).run()
    db.prepare("DELETE FROM promotion_campaigns WHERE code LIKE 'TCMP-%'").run()
  })()
}
clean()

// 开跑时快照所有已存在促销的状态，跑完逐一还原
const statusSnapshot = db.prepare('SELECT id,status FROM promotions').all().map((r) => [r.id, r.status])
const restoreStatus = () => {
  for (const [id, st] of statusSnapshot) {
    db.prepare('UPDATE promotions SET status=? WHERE id=? AND status<>?').run(st, id, st)
  }
  // 本轮新建的促销直接删掉即可（clean() 里已按 TP- 前缀处理），无需还原状态
}
const deactivateAll = () => {
  for (const r of db.prepare("SELECT id FROM promotions WHERE status='active'").all()) setPromotionStatus(db, r.id, 'inactive')
}
const activate = (code) => {
  const r = db.prepare('SELECT id FROM promotions WHERE code=?').get(code)
  if (r) setPromotionStatus(db, r.id, 'active')
}
// 崩溃兜底：本测试会临时停用库里的促销，若中途抛错就直接退出，
// 下一轮快照到的就是"全被停用"的坏状态（实测踩到：一次崩溃把 10 张演示促销
// 永久留成 inactive，之后每轮都把这个坏状态当基线还原）。
// 所以收尾必须挂在 exit 上，正常路径也照常调用（幂等，重复执行无害）。
process.on('exit', () => {
  try { restoreStatus(); clean() } catch { /* 收尾失败不掩盖原错误 */ }
})

// 客户与 SKU（两个客户：第二个专门用来验「券不属于当前客户」这条路）
const phone = '19900000001'
const phone2 = '19900000002'
db.prepare('INSERT INTO mall_customers (phone,name) VALUES (?,?)').run(phone, '【TEST-PROMO】测试会员')
db.prepare('INSERT INTO mall_customers (phone,name) VALUES (?,?)').run(phone2, '【TEST-PROMO】测试会员B')
const CUST = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone)
const CUST_B = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone2)
const platform = db.prepare("SELECT * FROM platforms WHERE code='H5'").get()
  ?? db.prepare('SELECT * FROM platforms ORDER BY id LIMIT 1').get()
// 地板为 0 的 SKU：绝大多数算钱断言要排除地板干扰；另取一个带 price_min 的验地板
const freeSkus = db.prepare(`
  SELECT s.* FROM product_skus s LEFT JOIN products p ON p.id=s.product_id
   WHERE s.status='active' AND COALESCE(s.price_min,0)=0 AND (p.status IS NULL OR p.status='active')
   ORDER BY s.id LIMIT 4`).all()
const floorSku = db.prepare(`
  SELECT s.* FROM product_skus s LEFT JOIN products p ON p.id=s.product_id
   WHERE s.status='active' AND s.price_min > 0 AND (p.status IS NULL OR p.status='active')
   ORDER BY s.id LIMIT 1`).get()
ok(freeSkus.length >= 3, `取到 ≥3 个零地板 SKU（实取 ${freeSkus.length}）`)
ok(!!floorSku, '取到 1 个带最低成交价的 SKU')

let orderSeq = 0
/** 造一张测试订单并落库（拿到真实行 id，好让留痕指向真实行） */
function makeOrder(items, { remark = '' } = {}) {
  orderSeq += 1
  const goods = items.reduce((s, it) => s + it.unit_price_cents * it.qty, 0) / 100
  const orderNo = `TPTEST${String(orderSeq).padStart(6, '0')}`
  const info = db.prepare(`
    INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,
      goods_amount,freight,discount_amount,pay_amount,receiver,receiver_phone,receiver_address,sync_at,remark)
    VALUES (?,?,?,?,?,'completed',?,0,0,?,?,?,?,?,?)
  `).run(platform.id, orderNo, '测试买家', AT, AT, goods, goods, CUST.name, CUST.phone, '测试地址', AT,
    `【TEST-PROMO】${remark}`)
  const oid = Number(info.lastInsertRowid)
  const insItem = db.prepare(
    'INSERT INTO oms_order_items (oms_order_id,platform_sku_code,sku_id,title,spec,price,qty,amount) VALUES (?,?,?,?,?,?,?,?)'
  )
  const withIds = items.map((it, i) => {
    const r = insItem.run(oid, `TEST${i}`, it.sku_id, `测试品 ${i}`, null,
      it.unit_price_cents / 100, it.qty, (it.unit_price_cents * it.qty) / 100)
    return { item_id: Number(r.lastInsertRowid), ...it }
  })
  return { oid, items: withIds }
}

// ===========================================================================
// T1 促销 CRUD 与草稿校验
// ===========================================================================
section('T1 促销 CRUD 与草稿校验')
const basePromo = {
  code: 'TP-BASE', name: '测试·整单满减', is_automatic: true, priority: 100,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 1000 },
  rules: {}
}
const pBase = createPromotion(db, basePromo)
ok(pBase.id > 0 && pBase.code === 'TP-BASE', 'createPromotion 建单成功并返回详情')
ok(!!pBase.method, '详情带 method 段')
ok(!!pBase.rules, '详情带 rules 段')
eq('新建 used 归零', num(pBase.used), 0)

throwsCode(() => validatePromotionDraft(db, { ...basePromo, code: '' }), 'BAD_ARGS', '缺 code 被拦')
throwsCode(() => validatePromotionDraft(db, { ...basePromo, name: '' }), 'BAD_ARGS', '缺 name 被拦')
throwsCode(() => validatePromotionDraft(db, { ...basePromo, starts_at: W_TO, ends_at: W_FROM }),
  'BAD_WINDOW', '起止时间写反被拦（否则永远不命中却显示进行中）')
throwsCode(() => validatePromotionDraft(db, {
  ...basePromo, method: { type: 'fixed', target_type: 'items', allocation: 'once', value: 100 }
}), 'BAD_ALLOCATION', 'allocation=once 缺 max_quantity 被拦')
throwsCode(() => validatePromotionDraft(db, {
  ...basePromo, rules: { rules: [{ attribute: 'drop_table', operator: 'gte', value: '1' }] }
}), 'BAD_RULE_ATTR', '规则属性白名单外的字段被拦')
throwsCode(() => validatePromotionDraft(db, {
  ...basePromo, method: { type: 'percentage', target_type: 'order', allocation: 'across', value: 10001 }
}), 'BAD_METHOD_VALUE', 'percentage > 10000 被拦（否则是免费单）')
throwsCode(() => validatePromotionDraft(db, {
  ...basePromo, is_exclusive: true, stack_group: 'X'
}), 'BAD_ARGS', '独占 + 同组（语义冲突）被拦')
throwsCode(() => validatePromotionDraft(db, {
  ...basePromo, code: 'TP-BUYGET-BAD', type: 'buyget',
  method: { type: 'fixed', target_type: 'items', allocation: 'once', value: 0, apply_to_quantity: 1 }
}), 'BAD_BUYGET', '买赠缺门槛（buy_rules_min_quantity）被拦')
throwsCode(() => createPromotion(db, basePromo), 'DUPLICATE_CODE', '重复编码被拦')

const pUpd = updatePromotion(db, 'TP-BASE', { name: '测试·整单满减（改）', priority: 90 })
eq('updatePromotion 只改一个字段即可', pUpd.name, '测试·整单满减（改）')
eq('updatePromotion 未传的 method 不被清空', num(pUpd.method.value), 1000)
eq('updatePromotion 应用了 priority', num(pUpd.priority), 90)

const camp = createCampaign(db, { code: 'TCMP-1', name: '测试活动', starts_at: W_FROM, ends_at: W_TO })
ok(camp.id > 0, 'createCampaign 建活动成功')
ok(listCampaigns(db).some((c) => c.code === 'TCMP-1'), 'listCampaigns 能查到')
ok(listPromotions(db, { keyword: 'TP-BASE' }).list.length >= 1, 'listPromotions 关键字过滤命中')

// ===========================================================================
// T2 算钱顺序固定（会员 → 促销 → 积分）
// ===========================================================================
section('T2 算钱顺序：会员折扣（原价）→ 促销（会员价）→ 积分（最终价）')
deactivateAll()
M.setMemberLevel(db, { customerId: CUST.id, levelCode: 'gold', remark: '测试：置为金牌' })
const goldLv = db.prepare("SELECT * FROM member_levels WHERE code='gold'").get()

const pPct = createPromotion(db, {
  code: 'TP-PCT10', name: '测试·逐行减 10%', is_automatic: true, priority: 50,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'percentage', target_type: 'items', allocation: 'each', value: 1000 },
  rules: {}
})
const S = 100000 // 一行 1000.00 元
const single = K.buildItems(db, [{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: S, item_id: 1 }])
const md = Math.round(S * (10000 - num(goldLv.discount_pct)) / 10000)
const q2 = K.quote(db, { items: single, customerId: CUST.id, at: AT })
okNear(q2.member_discount, md, `会员折扣作用于原价：${S} 分 × ${10000 - goldLv.discount_pct}/10000 = ${md}`)
const afterMember = S - md
okNear(q2.promotion_discount, Math.round(afterMember * 1000 / 10000),
  `促销在会员价上叠加：round(${afterMember} × 10%) = ${Math.round(afterMember * 1000 / 10000)}`)
ok(q2.promotion_discount !== Math.round(S * 1000 / 10000),
  '促销基数确实是会员价而非原价（两者不同，排除"顺序反了也恰好相等"）')
eq('无积分时应付 = 原价 − 会员折扣 − 促销优惠', num(q2.payable), S - md - q2.promotion_discount)
okNear(q2.discount_total, num(q2.member_discount) + num(q2.promotion_discount), '总优惠 = 会员段 + 促销段')

// 攒积分，验"积分只作用于最终成交价"
const warm = makeOrder([{ sku_id: freeSkus[1].id, qty: 1, unit_price_cents: 500000 }], { remark: '攒分' })
M.earnPoints(db, { customerId: CUST.id, orderAmountCents: 500000, source: 'oms', orderId: warm.oid })
const accNow = db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(CUST.id)
ok(num(accNow.points) > 0, `测试会员已有可用积分（${accNow.points}）`)
const q2p = K.quote(db, { items: single, customerId: CUST.id, usePoints: 1, at: AT })
const afterPromo = S - md - q2p.promotion_discount
ok(num(q2p.points_quote.maxCents) <= afterPromo,
  `积分抵扣上限按**优惠后金额**推导（${q2p.points_quote.maxCents} ≤ ${afterPromo}）`)
ok(num(q2p.points_discount) <= afterPromo, '积分抵扣额不超过优惠后金额')
ok(num(q2p.payable) >= 0, '应付不为负')

// ===========================================================================
// T3 优惠必须摊到行
// ===========================================================================
section('T3 优惠必须摊到行（行优惠合计恒等于整单优惠）')
const three = K.buildItems(db, [
  { sku_id: freeSkus[0].id, qty: 1, unit_price_cents: 30000, item_id: 1 },
  { sku_id: freeSkus[1].id, qty: 2, unit_price_cents: 20000, item_id: 2 },
  { sku_id: freeSkus[2].id, qty: 1, unit_price_cents: 5000, item_id: 3 }
])
const q3 = K.quote(db, { items: three, customerId: CUST.id, at: AT })
const sumPromoLine = q3.line_discounts.reduce((s, l) => s + num(l.promotion_discount), 0)
eq('行促销优惠合计 = 整单促销优惠', sumPromoLine, num(q3.promotion_discount))
const sumPayable = q3.line_discounts.reduce((s, l) => s + num(l.payable), 0)
eq('行应付合计 = 整单应付（退货按行退款才退得平）', sumPayable, num(q3.payable))
ok(q3.line_discounts.every((l) => num(l.payable) >= 0), '每行应付都非负')

// ===========================================================================
// T4 percentage 的口径是「减免率」而不是「折数」
// ===========================================================================
section('T4 percentage = 减免率（9000 = 减 90%，不是"9 折"）')
deactivateAll()
activate('TP-PCT10')
const q10 = K.quote(db, { items: single, at: AT })
eq('value=1000 → 减 10%（1000 元减 100 元）', num(q10.promotion_discount), Math.round(S * 1000 / 10000))
deactivateAll()
const pPct90 = createPromotion(db, {
  code: 'TP-PCT90', name: '测试·减 90%（方向探针）', is_automatic: true, priority: 51,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'percentage', target_type: 'items', allocation: 'each', value: 9000 },
  rules: {}
})
const q90 = K.quote(db, { items: single, at: AT })
eq('value=9000 单独生效 → 减 90%（实付 10%）', num(q90.promotion_discount), Math.round(S * 9000 / 10000))
ok(num(q90.promotion_discount) !== Math.round(S * 1000 / 10000),
  'value=9000 不是"9 折"（方向若反了，这里会差十倍）')

// ===========================================================================
// T5 买赠：买 3 送 1，从最低单价件开始免
// ===========================================================================
section('T5 买赠（buyget）：触发按件数、免件从最低单价起')
deactivateAll()
const pBuy = createPromotion(db, {
  code: 'TP-BUYGET', name: '测试·买 3 送 1', type: PROMO_TYPE.BUYGET, is_automatic: true, priority: 10,
  starts_at: W_FROM, ends_at: W_TO,
  method: {
    type: 'fixed', target_type: 'items', allocation: 'once', value: 0,
    max_quantity: 3, buy_rules_min_quantity: 3, apply_to_quantity: 1, gift_sku_id: freeSkus[3].id
  },
  rules: { buy_rules: [{ attribute: 'qty', operator: 'gte', value: '3' }] }
})
activate('TP-BUYGET')
const bgItems = (qtyA, qtyB) => K.buildItems(db, [
  { sku_id: freeSkus[0].id, qty: qtyA, unit_price_cents: 30000, item_id: 1 },
  { sku_id: freeSkus[1].id, qty: qtyB, unit_price_cents: 10000, item_id: 2 }
])
const qBuy2 = K.quote(db, { items: bgItems(1, 1), at: AT })
eq('买 2 件不生效（未达门槛）', num(qBuy2.promotion_discount), 0)
ok(qBuy2.traced.some((t) => t.code === 'TP-BUYGET' && t.skipped === 'buy_rules'),
  '买不够时解释链给出 buy_rules 跳过（而不是静默无声）')
const qBuy3 = K.quote(db, { items: bgItems(2, 1), at: AT })
okNear(qBuy3.promotion_discount, 10000, `买 3 件送 1 件：免掉**最低单价**那件（100 元），实减 ${qBuy3.promotion_discount}`)
const qBuy6 = K.quote(db, { items: bgItems(4, 2), at: AT })
okNear(qBuy6.promotion_discount, 20000, '买 6 件触发 2 次，免 2 件最低价（2 × 100 元）')
ok(qBuy3.applied_codes.includes('TP-BUYGET'), '买赠计入 applied_codes（否则结算不登记、used 永远 0）')

// ===========================================================================
// T6 券：默认不自动使用（历史缺陷 A 的回归）
// ===========================================================================
section('T6 券默认不自动使用 —— 只有显式传码 / 显式声明 autoCoupon 才生效')
deactivateAll()
const pCoupon = createPromotion(db, {
  code: 'TP-CPFULL', name: '测试·券专享满减', is_automatic: false, priority: 30, usage_limit: 50,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 5000 },
  rules: { rules: [{ attribute: 'subtotal', operator: 'gte', value: '10000' }] }
})
// 券模板用**驼峰**写，验双写法兼容层（历史缺陷 C）
const tpl = C.createCoupon(db, {
  code: 'TC-FULL', name: '测试满减券', promotionId: pCoupon.id,
  type: 'fixed', value: 5000, minSubtotalCents: 10000,
  perUserLimit: 3, validDays: 30, totalQty: 5
})
eq('createCoupon 认驼峰 promotionId', num(tpl.promotion_id), pCoupon.id)
eq('createCoupon 认驼峰 minSubtotalCents', num(tpl.min_subtotal), 10000)
eq('createCoupon 认驼峰 totalQty（不是落 null → 限量失效）', num(tpl.total_qty), 5)
eq('createCoupon 认驼峰 perUserLimit', num(tpl.per_user_limit), 3)
const issued = C.issueCoupons(db, { couponId: tpl.id, customerId: CUST.id, qty: 2, remark: '测试发券' })
eq('issueCoupons 发 2 张', issued.issued, 2)
const myCode = issued.codes[0]

activate('TP-CPFULL')
const S6 = 50000
const items6 = K.buildItems(db, [{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: S6, item_id: 1 }])
const qNoCode = K.quote(db, { items: items6, customerId: CUST.id, at: AT })
ok(!qNoCode.applied_codes.includes('TP-CPFULL'),
  '不传券码 → 券促销**不生效**（否则试算顺手把券全用掉，且不报错）')
ok(qNoCode.coupon.available.usable.some((u) => u.coupon_code === myCode),
  '但券包的"可用券"列表照常展示（只读，不代表本单会用它）')
const qWithCode = K.quote(db, { items: items6, customerId: CUST.id, couponCodes: [myCode], at: AT })
ok(qWithCode.applied_codes.includes('TP-CPFULL'), '显式传券码 → 券促销生效')
const qAuto = K.quote(db, { items: items6, customerId: CUST.id, autoCoupon: true, at: AT })
ok(qAuto.applied_codes.includes('TP-CPFULL'), 'autoCoupon:true（显式声明）→ 自动选券生效')

// ===========================================================================
// T7 最低价地板
// ===========================================================================
section('T7 最低价地板（product_skus.price_min）闸住 0 元单')
deactivateAll()
const pFloor = createPromotion(db, {
  code: 'TP-FLOOR', name: '测试·超额直降（探地板）', is_automatic: true, priority: 1,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'items', allocation: 'each', value: 999999999 },
  rules: {}
})
activate('TP-FLOOR')
const floorQty = 2
const floorItems = K.buildItems(db, [{
  sku_id: floorSku.id, qty: floorQty, unit_price_cents: Math.round(floorSku.price_retail * 100), item_id: 1
}])
const qFloor = K.quote(db, { items: floorItems, at: AT })
const floorLine = qFloor.line_discounts[0]
okNear(floorLine.payable, Math.round(num(floorSku.price_min) * 100) * floorQty,
  `行应付被地板兜住 = price_min × ${floorQty}（实付 ${floorLine.payable} 分）`)
ok(num(floorLine.payable) > 0, '地板之上仍有实付，不是 0 元单')

// ===========================================================================
// T8 独占与同组互斥
// ===========================================================================
section('T8 独占（is_exclusive）与同组互斥（stack_group）')
deactivateAll()
const pGA = createPromotion(db, {
  code: 'TP-GRP-A', name: '测试·同组 A', is_automatic: true, priority: 10, stack_group: 'TG-TEST',
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 2000 }, rules: {}
})
const pGB = createPromotion(db, {
  code: 'TP-GRP-B', name: '测试·同组 B', is_automatic: true, priority: 20, stack_group: 'TG-TEST',
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 9000 }, rules: {}
})
activate('TP-GRP-A'); activate('TP-GRP-B')
const qGrp = K.quote(db, { items: items6, at: AT })
ok(qGrp.applied_codes.includes('TP-GRP-A'), '同组里 priority 小的先算并生效')
ok(!qGrp.applied_codes.includes('TP-GRP-B'), '同组另一张被跳过（同组只取一张）')
ok(qGrp.traced.some((t) => t.code === 'TP-GRP-B' && t.skipped === 'stack_group'), '解释链给出 stack_group 跳过原因')
const pEx = createPromotion(db, {
  code: 'TP-EXCL', name: '测试·独占', is_automatic: true, priority: 1, is_exclusive: true,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 3000 }, rules: {}
})
activate('TP-EXCL')
const qEx = K.quote(db, { items: items6, at: AT })
ok(qEx.applied_codes.includes('TP-EXCL'), '独占促销生效')
ok(!qEx.applied_codes.includes('TP-GRP-A'), '独占生效后其它促销全部不参与')
ok(!qEx.applied_codes.includes('TP-GRP-B'), '独占生效后同组另一张也不参与')

// ===========================================================================
// T9 限量（usage_limit）防超发
// ===========================================================================
section('T9 限量促销：使用次数打满后不再登记')
deactivateAll()
const pLim = createPromotion(db, {
  code: 'TP-LIMIT', name: '测试·限量 1 单', is_automatic: true, priority: 5, usage_limit: 1,
  starts_at: W_FROM, ends_at: W_TO,
  method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 1000 }, rules: {}
})
activate('TP-LIMIT')
const o1 = makeOrder([{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: 30000 }], { remark: '限量单1' })
K.settle(db, { source: 'oms', orderId: o1.oid, items: K.buildItems(db, o1.items), customerId: CUST.id, at: AT })
eq('第 1 单登记成功，used=1', num(db.prepare("SELECT used FROM promotions WHERE code='TP-LIMIT'").get().used), 1)
const o2 = makeOrder([{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: 30000 }], { remark: '限量单2' })
K.settle(db, { source: 'oms', orderId: o2.oid, items: K.buildItems(db, o2.items), customerId: CUST.id, at: AT })
eq('第 2 单被拦，used 仍为 1（防超发）', num(db.prepare("SELECT used FROM promotions WHERE code='TP-LIMIT'").get().used), 1)
eq('第 2 单没有留下使用登记', db.prepare('SELECT COUNT(*) c FROM promotion_usages WHERE order_id=?').get(o2.oid).c, 0)

// ===========================================================================
// T10 会员等级
// ===========================================================================
section('T10 会员等级：门槛是与关系、人工改级要理由且抬门槛')
eq('积分够但没花钱 → 不算达标', M.levelOf(db, { pointsTotal: 999999, totalSpentCents: 0 })?.code, 'normal')
eq('花钱够但积分不够 → 不算达标', M.levelOf(db, { pointsTotal: 0, totalSpentCents: 99999999 })?.code, 'normal')
eq('两者都够 → 取最高档', M.levelOf(db, { pointsTotal: 40000, totalSpentCents: 4000000 })?.code, 'platinum')
throwsCode(() => M.setMemberLevel(db, { customerId: CUST.id, levelCode: 'silver' }),
  'REASON_REQUIRED', '人工改等级不写理由被拦')
throwsCode(() => M.setMemberLevel(db, { customerId: CUST.id, levelCode: 'no_such', remark: 'x' }),
  'LEVEL_NOT_FOUND', '改到不存在的等级被拦')
const beforeAcc = db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(CUST.id)
M.setMemberLevel(db, { customerId: CUST.id, levelCode: 'gold', remark: '测试：人工置金牌' })
const afterAcc = db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(CUST.id)
ok(num(afterAcc.total_spent_cents) >= num(beforeAcc.total_spent_cents),
  '人工改级把累计消费抬到达标线（否则下一单送分会被自动判定冲回去）')
eq('人工改级后等级为 gold', afterAcc.level_code, 'gold')
throwsCode(() => M.updateLevel(db, 'gold', { discount_pct: 0 }), 'BAD_DISCOUNT', '等级折扣 0（全场 0 元）被拦')
throwsCode(() => M.updateLevel(db, 'gold', { discount_pct: 10001 }), 'BAD_DISCOUNT', '等级折扣 > 10000（倒贴）被拦')
throwsCode(() => M.updateLevel(db, 'gold', { points_rate: -1 }), 'BAD_RATE', '负积分倍率被拦')

// ===========================================================================
// T11 积分 / 储值：余额 = 流水合计
// ===========================================================================
section('T11 积分与储值：余额不是真相，流水才是')
const c2 = CUST_B // 第二个客户：与 CUST 分开，才能验"不是持有人"与独立的积分/储值账
M.earnPoints(db, { customerId: c2.id, orderAmountCents: 123400, orderId: null })
M.adjustPoints(db, { customerId: c2.id, change: 500, remark: '测试：补偿' })
M.adjustPoints(db, { customerId: c2.id, change: -200, remark: '测试：回收' })
throwsCode(() => M.adjustPoints(db, { customerId: c2.id, change: -99999999, remark: '测试：超额' }),
  'POINTS_NOT_ENOUGH', '积分扣成负数被拦')
M.rechargeBalance(db, { customerId: c2.id, amountCents: 100000, docNo: 'TEST-RC-1' })
M.payByBalance(db, { customerId: c2.id, amountCents: 30000, remark: '测试：储值消费' })
throwsCode(() => M.payByBalance(db, { customerId: c2.id, amountCents: 99999999 }),
  'BALANCE_NOT_ENOUGH', '储值余额不足被拦')
const acc2 = db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(c2.id)
const ptsSum = num(db.prepare('SELECT SUM(change_points) s FROM member_points_ledger WHERE customer_id=?').get(c2.id).s)
const balSum = num(db.prepare('SELECT SUM(change_cents) s FROM member_balance_ledger WHERE customer_id=?').get(c2.id).s)
eq('积分余额 = 积分流水合计', num(acc2.points), ptsSum)
eq('储值余额 = 储值流水合计', num(acc2.balance_cents), balSum)
const runBad = num(db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT balance_after_points, SUM(change_points) OVER (PARTITION BY customer_id ORDER BY id) run
      FROM member_points_ledger WHERE customer_id=?) WHERE balance_after_points <> run`).get(c2.id).c)
eq('每一行流水的 balance_after 都能复算', runBad, 0)
const audit = M.auditMember(db)
ok(audit.balanced, `全库会员对账通过（账户 ${audit.accounts} 个，不一致 ${audit.mismatch.length}）`)

// ===========================================================================
// T12 券生命周期
// ===========================================================================
section('T12 券生命周期：发放 → 校验 → 核销 → 退回 → 作废 / 防超发 / 限领')
deactivateAll()
activate('TP-CPFULL') // 券的校验会连带检查它绑的促销是否可用 —— 先把被测促销置回可用
const tplL = C.createCoupon(db, {
  code: 'TC-LIMITED', name: '测试限量券', promotion_id: pCoupon.id,
  type: 'fixed', value: 5000, min_subtotal: 10000, total_qty: 1, per_user_limit: 1, valid_days: 30
})
throwsCode(() => C.issueCoupons(db, { couponId: tplL.id, customerId: CUST.id, qty: 2 }),
  'PER_USER_LIMIT', '超过每人限领被拦（重复点发放绕不过去）')
const li = C.issueCoupons(db, { couponId: tplL.id, customerId: CUST.id, qty: 1 })
throwsCode(() => C.issueCoupons(db, { couponId: tplL.id, customerId: c2.id, qty: 1 }),
  'COUPON_EXHAUSTED', '发行量用尽后发放被拦（条件式更新防超发）')

// 可用券里给出的门槛必须是**分**、且等于模板上的值 —— 不是 ×100。
// 曾经写成 `min_subtotal * 100`（`min_subtotal` 本来就是分），
// 界面于是把 ¥100 的门槛显示成 ¥10,000：接口 200、字段名也在、**不报错**，
// 只是差了 100 倍，看起来像"这张券门槛高得离谱"。
const avList = C.availableCoupons(db, { customerId: CUST.id, orderAmountCents: 50000, at: AT })
const avHit = (avList.usable || []).find((u) => u.coupon_code === li.codes[0])
ok(Boolean(avHit), '刚发出的券出现在该客户的可用券列表里')
eq('可用券门槛单位是「分」且与模板一致（不是 ×100）', Number(avHit?.min_subtotal_cents), 10000)

const vOk = C.validateCoupon(db, { code: myCode, customerId: CUST.id, orderAmountCents: 50000, at: AT })
ok(vOk.ok, '满足全部条件时 validateCoupon 通过')
eq('未达券门槛被拒且给出 below_min',
  C.validateCoupon(db, { code: myCode, customerId: CUST.id, orderAmountCents: 1, at: AT }).reason, 'below_min')
eq('不是持有人被拒',
  C.validateCoupon(db, { code: myCode, customerId: c2.id, orderAmountCents: 50000, at: AT }).reason, 'not_owner')
const vBeg = C.validateCoupon(db, { code: myCode, customerId: CUST.id, orderAmountCents: 50000, at: '2020-01-01 00:00:00' })
ok(['not_started', 'expired'].includes(vBeg.reason), `券在生效前/过期后被拒（reason=${vBeg.reason}）`)

// 核销 → 重复核销被拦 → 退回
const relOrder = makeOrder([{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: 40000 }], { remark: '券退回' })
C.redeemCoupon(db, { code: myCode, source: 'oms', orderId: relOrder.oid, customerId: CUST.id, amountCents: 5000, at: AT })
eq('核销后状态 = used', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(myCode).status, 'used')
// 重复核销有两道防线，错误码分两层（都不算错，都属于"被拦住"）：
//   · 前置 `validateCoupon` → COUPON_NOT_USABLE + reason='used'（正常路径走这条）；
//   · 条件式 UPDATE 的 `changes===0` → COUPON_ALREADY_USED（并发下的兜底，正常路径到不了）。
let dupCode = null
let dupReason = null
try { C.redeemCoupon(db, { code: myCode, customerId: CUST.id, at: AT }) } catch (e) { dupCode = e.code; dupReason = e.detail?.reason }
ok(dupCode === 'COUPON_ALREADY_USED' || (dupCode === 'COUPON_NOT_USABLE' && dupReason === 'used'),
  `重复核销被拦（code=${dupCode} reason=${dupReason}）`)
eq('重复核销后状态仍为 used', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(myCode).status, 'used')
const rel = C.releaseCoupon(db, { source: 'oms', orderId: relOrder.oid, remark: '测试退回' })
eq('退回 1 张', num(rel.released), 1)
eq('退回后状态 = unused', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(myCode).status, 'unused')
eq('退回后不再挂订单', db.prepare('SELECT order_id FROM coupon_instances WHERE coupon_code=?').get(myCode).order_id, null)

// 作废
C.voidInstance(db, { instanceId: db.prepare('SELECT id FROM coupon_instances WHERE coupon_code=?').get(myCode).id, remark: '测试作废' })
eq('作废后状态 = void', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(myCode).status, 'void')
eq('作废后再校验被拒',
  C.validateCoupon(db, { code: myCode, customerId: CUST.id, orderAmountCents: 50000, at: AT }).reason, 'void')
eq('券模板绑定了促销（券表的 type/value 只作展示）', num(C.getCouponDetail(db, tpl.id).promotion_id), pCoupon.id)

// ===========================================================================
// T13 结算端到端 + 撤单（含余额封顶回归）
// ===========================================================================
section('T13 结算端到端：留痕 / 登记 / 核销 / 送分，撤单成对回退')
const tplW = C.createCoupon(db, {
  code: 'TC-VOID', name: '测试券（端到端用）', promotion_id: pCoupon.id,
  type: 'fixed', value: 5000, min_subtotal: 10000, per_user_limit: 2, valid_days: 30
})
const issE = C.issueCoupons(db, { couponId: tplW.id, customerId: c2.id, qty: 1, remark: '端到端用券' })
const useCode = issE.codes[0]
deactivateAll()
activate('TP-CPFULL')
const e2e = makeOrder([{ sku_id: freeSkus[0].id, qty: 1, unit_price_cents: 40000 }], { remark: '端到端' })
const settled = K.settle(db, {
  source: 'oms',
  orderId: e2e.oid, items: K.buildItems(db, e2e.items), customerId: c2.id, couponCodes: [useCode], at: AT
})
ok(settled.applied_codes.includes('TP-CPFULL'), '端到端：券解锁的促销生效')
const adjRows = db.prepare('SELECT * FROM promotion_adjustments WHERE order_id=?').all(e2e.oid)
ok(adjRows.length > 0, '端到端：产生优惠留痕')
const usgRows = db.prepare('SELECT * FROM promotion_usages WHERE order_id=?').all(e2e.oid)
ok(usgRows.length > 0, '端到端：产生使用登记')
eq('端到端：留痕合计金额 = 使用登记金额合计',
  adjRows.reduce((s, r) => s + num(r.amount), 0), usgRows.reduce((s, r) => s + num(r.amount), 0))
eq('端到端：券被核销', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(useCode).status, 'used')
eq('端到端：核销记录指向本单',
  num(db.prepare('SELECT order_id FROM coupon_instances WHERE coupon_code=?').get(useCode).order_id), e2e.oid)
const earnRow = db.prepare("SELECT * FROM member_points_ledger WHERE source_type='order' AND source_id=? AND kind='earn'").get(e2e.oid)
ok(!!earnRow && num(earnRow.change_points) > 0, '端到端：按实付金额送出积分')

// 把客户的积分花光后再撤单：必须按余额封顶、不抛错、如实报 shortfall
const accE = db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(c2.id)
M.adjustPoints(db, { customerId: c2.id, change: -num(accE.points), remark: '测试：把分花光' })
let uns = null
noThrow(() => { uns = K.unsettle(db, { source: 'oms', orderId: e2e.oid, reason: '测试撤单' }) }, '积分已被花掉时撤单**不抛错**（按余额封顶）')
if (uns) {
  eq('撤单后优惠留痕清空', db.prepare('SELECT COUNT(*) c FROM promotion_adjustments WHERE order_id=?').get(e2e.oid).c, 0)
  eq('撤单后使用登记清空', db.prepare('SELECT COUNT(*) c FROM promotion_usages WHERE order_id=?').get(e2e.oid).c, 0)
  eq('撤单后券退回未使用', db.prepare('SELECT status FROM coupon_instances WHERE coupon_code=?').get(useCode).status, 'unused')
  ok(uns.points_reverted && num(uns.points_reverted.shortfall) >= 0,
    `撤单如实报出扣不回来的分（clawed=${uns.points_reverted?.points_clawed} shortfall=${uns.points_reverted?.points_shortfall}）`)
}
ok(M.auditMember(db).balanced, '撤单之后会员账仍然平衡')

// ===========================================================================
// T14 解释链与列表
// ===========================================================================
section('T14 解释链与列表口径')
const ex = explainPromotion(db, { items: items6, subtotal: S6, customer: {}, codes: [], now: AT })
ok(Array.isArray(ex.lines) && ex.lines.length > 0, 'explainPromotion 返回逐条解释行')
ok(String(ex.explanation).length > 0, '解释链有可读结论头')
ok(ex.explanation.includes('TP-'), '解释链里逐条列出了促销编码')
const list = listPromotions(db, { page: 1, pageSize: 5 })
ok(list.list.length <= 5 && list.list.length > 0, '列表按 pageSize 返回')
ok(typeof list.total === 'number' && list.total >= 1, '列表返回总数')

// ===========================================================================
// 收尾
// ===========================================================================
restoreStatus()
clean()

// 收尾自检：本轮删干净了、也没弄坏别人的促销状态
const leftover = db.prepare("SELECT COUNT(*) c FROM promotions WHERE code LIKE 'TP-%'").get().c
ok(leftover === 0, `收尾清理干净（残留测试促销 ${leftover} 个）`)
const drift = statusSnapshot.filter(([id, st]) =>
  db.prepare('SELECT status FROM promotions WHERE id=?').get(id)?.status !== st)
ok(drift.length === 0, `收尾还原了全部既有促销状态（漂移 ${drift.length} 个）`)

console.log(`\n${'─'.repeat(60)}`)
if (fail === 0) console.log(`\x1b[32m通过 ${pass} / 失败 0\x1b[0m（${INDUSTRY}）`)
else {
  console.log(`\x1b[31m通过 ${pass} / 失败 ${fail}\x1b[0m（${INDUSTRY}）`)
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
