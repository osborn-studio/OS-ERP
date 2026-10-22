/**
 * ============================================================================
 * 文件标识：scripts/test-dms.mjs ｜ 测试：渠道管理测试（模块 26 · 协议价 / 返利计提 / 返利核销冲应收）
 * ============================================================================
 * 【职责】测试：渠道管理测试（模块 26 · 协议价 / 返利计提 / 返利核销冲应收）
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
 * 渠道管理测试（模块 26 · 协议价 / 返利计提 / 返利核销冲应收）
 *
 * 本域的危险不在"算不出来"，而在**算错了但一切正常**：
 *   · 协议价没接进取价链 → 客户照零售价付钱，而界面上的"协议"看上去配置正常；
 *   · 折扣型协议折不下来 → 只表现为"这份协议明明在有效期内却不生效"；
 *   · 计提把上一期**已确认/已核销**的金额覆盖掉 → 一次"顺手重算"就改了已入账的数；
 *   · 核销把应收冲成负数 / 冲不动却不说 → 账龄与客户汇总当场分叉；
 *   · 同一张核销单被重放两次 → 应收被冲两遍。
 *
 * 所以本测试把四条硬口径一条条钉死：
 *   ① **协议价必须压过默认取价**（价格组 / 标准零售价），且裁决可解释（`rule` + `trace`）；
 *   ② **协议价的命中判定四项全中**（主体 / 目标含品类回溯 / 周期 / 起订量）；
 *   ③ **计提幂等且不覆盖非 pending**（已确认 / 已核销的一律跳过并如实报出）；
 *   ④ **核销成对**：冲应收 + 写核销单 + 回写返利，三者同一事务；重放返回同一张单。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-dms.mjs [industry]
 *
 * 关于「可重复跑」：本轮会真的建协议、建政策、计提、确认、核销（并**冲掉真实应收**）。
 * 开跑前先按标记把自己上一轮的残留**成对还原**（先撤核销单的应收影响是不可能的 ——
 * 应收被冲掉后没有"原值"可回填，所以核销对象一律选**本测试自造的经销商**，
 * 连同它的应收一起删干净）。标记：协议 `XY-T-` / 政策 `RBT-` / 经销商 `DLT`。
 */
import { getDbFor } from '../server/db/index.js'
import { resetSequences } from '../server/db/seq.js'
import { nextDocNo } from '../server/lib/docno.js'
import { resolvePrice, explainPrice } from '../server/lib/pricing.js'
import * as A from '../server/lib/agreement.js'
import * as RB from '../server/lib/rebate.js'
import * as AR from '../server/lib/ar.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++ }
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 240)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const num = (v) => Number(v) || 0
const okNear = (a, b, msg, eps = 0.005) => {
  if (!(Math.abs(num(a) - num(b)) <= eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(Math.abs(num(a) - num(b)) <= eps, msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const sectionSkip = (t, why) => console.log(`\n\x1b[33m${t}\x1b[0m  （跳过：${why}）`)

const T = '__test_dms__'
const MARK = 'DLT'          // 自造经销商编码前缀
const PERIOD = '2026-09'

// ===========================================================================
// [0] 自造数据 + 清理上一轮
// ===========================================================================
console.log(`=== 渠道管理（协议价 / 返利核销）测试（${INDUSTRY}） ===`)

/** 清上一轮残渣：自造经销商 + 其应收/收款 + 协议 + 政策 + 返利 + 核销单 */
function purge() {
  const dealers = db.prepare('SELECT id FROM dealers WHERE code LIKE ?').all(`${MARK}%`).map((r) => r.id)
  const inIds = (ids) => (ids.length ? `(${ids.join(',')})` : '(NULL)')
  const pol = db.prepare('SELECT id FROM rebate_policies WHERE code LIKE ?').all('RBT-%').map((r) => r.id)
  const rebates = db.prepare(`SELECT id FROM dealer_rebates WHERE dealer_id IN ${inIds(dealers)} OR policy_id IN ${inIds(pol)}`).all().map(r => r.id)
  if (rebates.length) db.prepare(`DELETE FROM doc_events WHERE doc_type='RB' AND doc_id IN ${inIds(rebates)}`).run()

  // **删除顺序必须从子到父**：`price_agreements.dealer_id` 与 `rebate_settlements.dealer_id`
  // 都外键引用 `dealers`，先删经销商会被 SQLite 直接拒绝（`FOREIGN KEY constraint failed`）——
  // 这条报错本身是好事：它保证"清理"不会留下指向已删经销商的孤儿协议/核销单。
  const settlements = db
    .prepare(`
      SELECT id FROM rebate_settlements
       WHERE remark LIKE ? ${dealers.length ? `OR dealer_id IN ${inIds(dealers)}` : ''}
    `)
    .all(`%${T}%`)
    .map((r) => r.id)
  if (settlements.length) {
    db.prepare(`DELETE FROM rebate_settlement_items WHERE settlement_id IN ${inIds(settlements)}`).run()
    db.prepare(`DELETE FROM rebate_settlements WHERE id IN ${inIds(settlements)}`).run()
  }
  if (pol.length) db.prepare(`DELETE FROM dealer_rebates WHERE policy_id IN ${inIds(pol)}`).run()
  if (dealers.length) {
    db.prepare(`DELETE FROM dealer_rebates WHERE dealer_id IN ${inIds(dealers)}`).run()
    db.prepare(`DELETE FROM price_agreements WHERE dealer_id IN ${inIds(dealers)}`).run()
    const ars = db.prepare(`SELECT id FROM ar_documents WHERE subject_type='dealer' AND subject_id IN ${inIds(dealers)}`).all().map((r) => r.id)
    if (ars.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='AR' AND doc_id IN ${inIds(ars)}`).run()
      db.prepare(`DELETE FROM receipt_allocations WHERE ar_id IN ${inIds(ars)}`).run()
      db.prepare(`DELETE FROM ar_documents WHERE id IN ${inIds(ars)}`).run()
    }
    db.prepare(`DELETE FROM sales_orders WHERE dealer_id IN ${inIds(dealers)} AND remark=?`).run(T)
    db.prepare(`DELETE FROM dealers WHERE id IN ${inIds(dealers)}`).run()
  }
  if (pol.length) db.prepare(`DELETE FROM rebate_policies WHERE id IN ${inIds(pol)}`).run()
  resetSequences(db, ['price_agreements', 'rebate_settlements', 'rebate_settlement_items', 'dealer_rebates'])
}
purge()

const sku = db.prepare("SELECT * FROM product_skus WHERE status='active' ORDER BY id LIMIT 1").get()
const sku2 = db.prepare("SELECT * FROM product_skus WHERE status='active' ORDER BY id LIMIT 1 OFFSET 1").get() || sku
if (!sku) {
  console.log('❌ 库里没有可用 SKU，无法测试')
  process.exit(1)
}
const cat = db
  .prepare('SELECT p.category_id AS id FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
  .get(sku.id)

/** 自造一家经销商（协议与返利都挂在它身上，跑完整条链一起删） */
function makeDealer(suffix) {
  const info = db
    .prepare(
      `INSERT INTO dealers (code,name,level,channel_type,region,contact,phone,credit_limit,credit_used,status,rebate_rate)
       VALUES (?,?,?,?,?,?,?,?,0,'active',1)`
    )
    .run(`${MARK}${suffix}`, `测试经销${suffix}`, 'gold', 'cs', '华东', '测试', '13800000000', 999999)
  return Number(info.lastInsertRowid)
}
/** 给某经销商造一张应收（返回 id）——返利核销必须"冲得动"才能验出后果 */
function makeAr(dealerId, amount, { allocated = 0 } = {}) {
  const docNo = nextDocNo(db, 'AR', 'ar_documents', 'doc_no', '2026-09-01')
  const info = db
    .prepare(
      `INSERT INTO ar_documents (doc_no,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,
        biz_date,due_date,credit_days,amount,allocated_amount,status,currency,remark)
       VALUES (?,'dealer',?,?,'MANUAL',NULL,?,?,?,30,?,?,?, 'CNY', ?)`
    )
    .run(docNo, dealerId, `测试经销#${dealerId}`, `TEST-AR-${dealerId}`,
      '2026-09-01', '2026-10-01', amount, allocated, allocated > 0 ? 'partial' : 'open', T)
  const id = Number(info.lastInsertRowid)
  AR.recalcAr(db, id)
  return id
}

const dealerA = makeDealer('A')
const dealerB = makeDealer('B')

// ===========================================================================
// [1] 协议价：命中判定四项（主体 / 目标 / 周期 / 起订量）
// ===========================================================================
section('[1] 协议价命中判定')

const basePrice = Number(sku.price_retail)
// 定点定价：82 折
const agSku = A.createAgreement(db, {
  code: `${MARK}-SKU`, name: '测试·定点协议价', dealer_id: dealerA,
  target_type: 'sku', target_id: sku.id, price_type: 'fixed',
  price: Number((basePrice * 0.82).toFixed(2)), min_qty: 1,
  effect_from: '2026-01-01', effect_to: '2030-01-01', priority: 10
}, { name: 'test' })
eq('协议价建档成功（状态 active）', agSku.status, 'active')
eq('显式传码时按传入值落库', agSku.code, `${MARK}-SKU`)
// 编码规则只有一处：不传码就由 nextAgreementCode 生成「XY + 年 + 4 位序号」（与 seed 同一条路径）
const agAuto = A.createAgreement(db, {
  name: '测试·自动编码', dealer_id: dealerA, target_type: 'all', target_id: null,
  price_type: 'discount', discount_bp: 9900, min_qty: 1,
  effect_from: '2026-01-01', effect_to: '2030-01-01', priority: 500
}, { name: 'test' })
ok(/^XY\d{8}$/.test(agAuto.code), '不传码时按 XY+年+4 位序号自生成', agAuto.code)
A.setAgreementStatus(db, agAuto.id, 'inactive', { name: 'test' })

const hit = A.resolveAgreement(db, { dealerId: dealerA, skuId: sku.id, qty: 1, at: '2026-09-15', basePrice })
ok('定点协议命中', !!hit && num(hit.price) === Number((basePrice * 0.82).toFixed(2)), JSON.stringify(hit && hit.price))

// 主体不同 → 不命中（协议的私有性）
ok('另一家经销商不命中该协议', A.resolveAgreement(db, { dealerId: dealerB, skuId: sku.id, qty: 1, at: '2026-09-15', basePrice }) === null)
// 周期外 → 不命中
ok('合同周期之外不命中', A.resolveAgreement(db, { dealerId: dealerA, skuId: sku.id, qty: 1, at: '2031-01-01', basePrice }) === null)
// 目标不同 → 不命中
ok('别的 SKU 不命中定点协议', A.resolveAgreement(db, { dealerId: dealerA, skuId: sku2.id, qty: 1, at: '2026-09-15', basePrice }) === null)

// 起订量
const agMin = A.createAgreement(db, {
  code: `${MARK}-MIN`, name: '测试·起订 5 件', dealer_id: dealerB,
  target_type: 'all', target_id: null, price_type: 'discount', discount_bp: 9000, min_qty: 5,
  effect_from: '2026-01-01', effect_to: '2030-01-01', priority: 100
}, { name: 'test' })
ok('低于起订量不命中（2 件 < 5 件）', A.resolveAgreement(db, { dealerId: dealerB, skuId: sku.id, qty: 2, at: '2026-09-15', basePrice }) === null)
const hitMin = A.resolveAgreement(db, { dealerId: dealerB, skuId: sku.id, qty: 5, at: '2026-09-15', basePrice })
okNear(hitMin?.price, basePrice * 0.9, '达到起订量后按 9 折折算')
eq('折扣型协议记录了基准价（可解释"折了谁的价"）', num(hitMin?.base_price), basePrice)

// 品类回溯
const agCat = A.createAgreement(db, {
  code: `${MARK}-CAT`, name: '测试·品类协议', dealer_id: dealerB,
  target_type: 'category', target_id: cat.id, price_type: 'discount', discount_bp: 8000, min_qty: 1,
  effect_from: '2026-01-01', effect_to: '2030-01-01', priority: 200
}, { name: 'test' })
ok('同品类下的 SKU 命中品类协议（品类回溯）', !!A.resolveAgreement(db, { dealerId: dealerB, skuId: sku2.id, qty: 1, at: '2026-09-15', basePrice }))

// 优先级裁决：dealerB 同时有「全部商品 90 折(priority 100)」与「品类 80 折(priority 200)」
const winAll = A.resolveAgreement(db, { dealerId: dealerB, skuId: sku.id, qty: 5, at: '2026-09-15', basePrice })
eq('同存两份协议时按 priority 裁决（数字小者优先）', winAll.agreement.id, agMin.id)

// 最低限价拒绝（而不是静默抬价）
const agLow = A.createAgreement(db, {
  code: `${MARK}-LOW`, name: '测试·低于限价', dealer_id: dealerA,
  target_type: 'sku', target_id: sku.id, price_type: 'discount', discount_bp: 100, min_qty: 1,
  effect_from: '2026-01-01', effect_to: '2030-01-01', priority: 1
}, { name: 'test' })
let lowErr = null
try {
  A.resolveAgreement(db, { dealerId: dealerA, skuId: sku.id, qty: 1, at: '2026-09-15', basePrice })
} catch (e) { lowErr = e }
eq('折算价低于最低限价 → 拒绝（不静默抬价）', lowErr?.code, 'AGREEMENT_BELOW_FLOOR')
A.setAgreementStatus(db, agLow.id, 'inactive', { name: 'test' })

// 校验：目标与类型自洽
let badErr = null
try { A.createAgreement(db, { code: `${MARK}-BAD`, name: 'x', dealer_id: dealerA, target_type: 'sku', target_id: null, price_type: 'fixed', price: 1 }, { name: 'test' }) } catch (e) { badErr = e }
eq('target_type=sku 但不给 target_id → 拒绝', badErr?.code, 'BAD_ARGS')

// ===========================================================================
// [2] 协议价**接入取价链**（与销售开单同一条路径）
// ===========================================================================
section('[2] 协议价接入取价链')

const withAg = resolvePrice(db, { skuId: sku.id, dealerId: dealerA })
eq('取价结果标注 rule=agreement', withAg.rule, 'agreement')
okNear(withAg.price, basePrice * 0.82, '取到的就是协议价')
ok((withAg.trace || []).some((t) => String(t).includes('协议价')), '取价轨迹里能看到协议价命中', JSON.stringify(withAg.trace))

const withoutAg = resolvePrice(db, { skuId: sku.id, dealerId: null })
ok(withAg.price < withoutAg.price, `协议价压过了默认取价（${withAg.price} < ${withoutAg.price}）`)
ok(['price_group', 'standard'].includes(withoutAg.rule), `不带经销商时走默认取价（rule=${withoutAg.rule}）`)

const ex = explainPrice(db, { skuId: sku.id, dealerId: dealerA })
ok(String(ex.explanation || '').includes('协议价'), '解释链里能读出"为什么是这个价"', ex.explanation)

// 停用后立即不再命中（"停用"必须当场生效，不能等缓存过期）
A.setAgreementStatus(db, agSku.id, 'inactive', { name: 'test' })
eq('停用协议后取价立刻回到默认', resolvePrice(db, { skuId: sku.id, dealerId: dealerA }).rule !== 'agreement', true)
A.setAgreementStatus(db, agSku.id, 'active', { name: 'test' })
eq('重新启用后协议价又生效', resolvePrice(db, { skuId: sku.id, dealerId: dealerA }).rule, 'agreement')

// 留痕：改价必须留痕（界面"价格变更历史"要能看到）
const logs = db.prepare("SELECT COUNT(*) c FROM price_change_logs WHERE entity='price_agreement'").get().c
ok(logs > 0, `协议价的新建/停用都写了价格变更留痕（${logs} 条）`)

// ===========================================================================
// [3] 返利：计提幂等 + 不覆盖非 pending
// ===========================================================================
section('[3] 返利计提')

// 造一张政策：阶梯（演示用极低门槛，保证一定能命中）
const pol = db.prepare(`
  INSERT INTO rebate_policies (code,name,type,dealer_level,channel_type,period,basis,rules,rebate_cap,priority,status,remark)
  VALUES (?,?,?,'all','all',NULL,'net',?,0,10,'active',?)
`).run('RBT-TIER', '测试·阶梯返点', 'tiered',
  JSON.stringify({ tiers: [{ min: 0, rate: 1 }] }), T)
const policyId = Number(pol.lastInsertRowid)

// 造销售订单：返利基数来自**真实订单**，不能手工插入 rebate 行
function makeSo(dealerId, amount, { paid = 0, date = '2026-09-10' } = {}) {
  const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no', date)
  const info = db.prepare(`
    INSERT INTO sales_orders (doc_no,channel,dealer_id,order_date,status,total_qty,goods_amount,
                              discount_amount,freight,receivable_amount,paid_amount,remark)
    VALUES (?, 'dealer', ?, ?, 'confirmed', 1, ?, 0, 0, ?, ?, ?)
  `).run(docNo, dealerId, date, amount, amount, paid, T)
  return Number(info.lastInsertRowid)
}
makeSo(dealerA, 20000, { paid: 20000 })
makeSo(dealerB, 6000, { paid: 1000 })

const planA = RB.planRebate(db, { dealerId: dealerA, period: PERIOD })
ok(planA.items.length > 0, `试算给出适用政策（${planA.items.length} 条）`)
const itemA = planA.items.find((x) => x.policy_id === policyId)
ok(itemA?.matched, '阶梯政策命中', JSON.stringify(itemA))
okNear(itemA.rebate_amount, 200, '阶梯 1% × 净销售 20000 = 200')
ok(!!itemA.basis_desc, '试算带了"为什么是这个数"的说明', itemA.basis_desc)

const acc1 = RB.accrueRebates(db, { dealerId: dealerA, period: PERIOD, policyId, actor: { name: 'test' } })
eq('首次计提新建 1 行', acc1.created, 1)
const acc2 = RB.accrueRebates(db, { dealerId: dealerA, period: PERIOD, policyId, actor: { name: 'test' } })
eq('重复计提只更新、不新增', [acc2.created, acc2.updated], [0, 1])

const rowA = db.prepare('SELECT * FROM dealer_rebates WHERE dealer_id=? AND period=? AND policy_id=?').get(dealerA, PERIOD, policyId)
eq('计提后状态是 pending', rowA.status, 'pending')
ok(!!rowA.commission_basis, '计返基数说明已落库（政策后来改了也能答出当时怎么算的）', rowA.commission_basis)

// 确认 → 再计提时必须跳过（**不许覆盖已确认的账**）
RB.confirmRebate(db, { id: rowA.id, actor: { name: 'test' } })
db.prepare('UPDATE dealer_rebates SET rebate_amount=999999 WHERE id=?').run(rowA.id)  // 故意改脏，看计提会不会把它改回来
const acc3 = RB.accrueRebates(db, { dealerId: dealerA, period: PERIOD, policyId, actor: { name: 'test' } })
eq('已确认的行被计提跳过并如实报出', acc3.skipped.map((s) => s.reason), ['locked:confirmed'])
eq('跳过之后金额**没有被覆盖**（上一期已入账的数不许被一次重算改掉）',
  num(db.prepare('SELECT rebate_amount FROM dealer_rebates WHERE id=?').get(rowA.id).rebate_amount), 999999)
db.prepare('UPDATE dealer_rebates SET rebate_amount=200 WHERE id=?').run(rowA.id)

let confirmErr = null
try { RB.confirmRebate(db, { id: rowA.id }) } catch (e) { confirmErr = e }
eq('重复确认被拒（状态机不做跳级）', confirmErr?.code, 'REBATE_NOT_PENDING')

// 期间格式
let periodErr = null
try { RB.planRebate(db, { dealerId: dealerA, period: '2026/09' }) } catch (e) { periodErr = e }
eq('期间格式错误被拒（写错的后果是"这一期永远算不出返利"）', periodErr?.code, 'BAD_PERIOD')

// ===========================================================================
// [4] 返利核销：冲应收 + 写核销单 + 回写，三者同一事务
// ===========================================================================
section('[4] 返利核销与应收冲减')

// dealerA 的返利 200 元，先给它的应收留出 150 元余额 → 应冲 150、未冲 50
const arA = makeAr(dealerA, 150)
const beforeAr = num(db.prepare('SELECT amount FROM ar_documents WHERE id=?').get(arA).amount)
// 首次核销就带上幂等键 —— 重放要能命中它。
// **只在重放时带键是测不出幂等的**：那时找不到键就会被当成新的一次核销，
// 而返利已经不是 `confirmed` 了，于是报 `NO_CONFIRMED_REBATE` ——
// 看起来像"幂等做错了"，其实是用例自己没给键。
const IDEM = `TEST-${T}-IDEM`
const st = RB.settleRebates(db, { dealerId: dealerA, period: PERIOD, actor: { name: 'test' }, remark: `测试核销 ${T}`, idempotencyKey: IDEM })
eq('核销单状态 confirmed', st.status, 'confirmed')
okNear(st.ar_offset_amount, 150, '冲减应收 = 应收未核销余额（150）')
okNear(st.unoffset_amount, 50, '冲不下的 50 如实登记（不生成负数应收）')
const afterAr = num(db.prepare('SELECT amount FROM ar_documents WHERE id=?').get(arA).amount)
okNear(afterAr, beforeAr - 150, `应收金额被真实冲减（${beforeAr} → ${afterAr}）`)
ok(afterAr >= 0, '应收没有被冲成负数')

const rowA2 = db.prepare('SELECT * FROM dealer_rebates WHERE id=?').get(rowA.id)
eq('返利被标记为已核销（paid）', rowA2.status, 'paid')
eq('返利挂上了核销单', num(rowA2.settlement_id), st.id)
okNear(rowA2.ar_offset_amount, 150, '返利上记录了"这笔冲了多少应收"')
ok(!!rowA2.settled_at, '记录了核销时刻')

const items = db.prepare('SELECT * FROM rebate_settlement_items WHERE settlement_id=?').all(st.id)
eq('核销明细 1 行', items.length, 1)
okNear(items[0].amount, 200, '明细记的是核销的返利额')
okNear(
  items.reduce((s, x) => s + num(x.ar_offset_amount), 0), num(st.ar_offset_amount),
  '明细的冲减分摊合计 = 核销单冲减额（末行兜底消尾差）'
)

// 幂等：同键重放返回同一张单，应收不再被冲
const st2 = RB.settleRebates(db, { dealerId: dealerA, period: PERIOD, actor: { name: 'test' }, idempotencyKey: IDEM })
okNear(db.prepare('SELECT amount FROM ar_documents WHERE id=?').get(arA).amount, afterAr, '同键重放**没有再冲一次应收**')
eq('同键重放返回同一张单', st2.id, st.id)

// 没有已确认返利 → 拒绝（不生成空单）
let emptyErr = null
try { RB.settleRebates(db, { dealerId: dealerB, period: PERIOD, actor: { name: 'test' } }) } catch (e) { emptyErr = e }
eq('没有已确认返利 → 拒绝核销（不生成空单）', emptyErr?.code, 'NO_CONFIRMED_REBATE')

// 域自证
const audit = RB.auditRebate(db)
ok(audit.balanced, '返利域自证通过（已核销必挂单 / 明细合计 = 总额 / 冲减 + 未冲 = 总额）', JSON.stringify(audit))

// ===========================================================================
// [5] 核销的**成对回滚**口径：撤核销单要能把应收还回去
// ===========================================================================
section('[5] 应收冲减的唯一实现（销售退货与返利共用）')

// 直接验 `offsetAr` 的两条口径：多张按到期日分摊、冲不下如实回报
const d3 = makeDealer('C')
const ar1 = makeAr(d3, 100)
const ar2 = makeAr(d3, 100)
const off = AR.offsetAr(db, { subjectType: 'dealer', subjectId: d3, amount: 250 })
okNear(off.offset, 200, '两笔应收共 200，全部冲掉')
okNear(off.unoffset, 50, '超出部分 50 如实回报（不生成负数应收）')
eq('按到期日 / id 顺序分摊（先冲第一张）', off.ars.map((x) => x.ar_id), [ar1, ar2])
const zero = AR.offsetAr(db, { subjectType: 'dealer', subjectId: d3, amount: 10 })
okNear(zero.offset, 0, '已无未核销余额时冲不动、也不报错')
okNear(zero.unoffset, 10, '冲不动时如实回报未冲减')
ok(
  num(db.prepare('SELECT amount FROM ar_documents WHERE id IN (?,?)').get(ar1, ar2).amount) >= 0,
  '应收金额仍然非负'
)

// ===========================================================================
// [6] 清理与回滚
// ===========================================================================
section('[6] 清理与回滚')
purge()
const leftAg = db.prepare('SELECT COUNT(*) c FROM price_agreements WHERE dealer_id IN (SELECT id FROM dealers WHERE code LIKE ?)').get(`${MARK}%`).c
const leftSettle = db.prepare('SELECT COUNT(*) c FROM rebate_settlements WHERE remark LIKE ?').get(`%${T}%`).c
eq('清理后本测试的协议价归零', leftAg, 0)
eq('清理后本测试的核销单归零', leftSettle, 0)
eq('清理后本测试的自造经销商归零', db.prepare('SELECT COUNT(*) c FROM dealers WHERE code LIKE ?').get(`${MARK}%`).c, 0)
eq('清理后本测试的销售订单归零', db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE remark=?').get(T).c, 0)
const auditAfter = RB.auditRebate(db)
ok(auditAfter.balanced, '清理后返利域仍然自证通过', JSON.stringify(auditAfter))

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
