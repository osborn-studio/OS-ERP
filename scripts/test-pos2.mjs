/**
 * ============================================================================
 * 文件标识：scripts/test-pos2.mjs ｜ 测试：门店交班、核款与长短款测试（模块 17 · 024）
 * ============================================================================
 * 【职责】测试：门店交班、核款与长短款测试（模块 17 · 024）
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
 * 门店交班、核款与长短款测试（模块 17 · 024）
 *
 * 本模块最容易出的错**不是崩溃，而是「数字看起来正常、方向却是反的」**：
 *   · 长短款写成「系统 − 实点」，于是短款显示成正数、长款显示成负数，
 *     一张差异单交上去谁都看不懂；
 *   · 长短款只记一个总额，于是「现金短款」与「移动支付漏传流水」混在一起，
 *     处置方式完全不同却分不开；
 *   · 现金应收按「同门店 + 同业务日 + 同收银员」现算，同一个收银员一天两个班时
 *     两个班算出同一批订单，现金应收翻倍、长短款跟着错一倍 —— **不报错，只是错一倍**。
 *
 * 所以本测试的重心是把下面这些口径钉死，而不是「接口通不通」：
 *
 *   ① **长短款 = 实点 − 系统应收**（正长款 / 负短款），逐位核对；
 *   ② **三段钱都在**：系统应收 / 收银员报数 / 店长实点，且报数阶段现金差异恒为 0
 *      （店长还没数，此时不存在「差异」）；非现金差异在报数时立即成立；
 *   ③ **按支付方式拆分**：一个渠道长款不影响另一个渠道的短款，且互不重复累加；
 *   ④ **一个班次一种支付方式只有一行**（UNIQUE(shift_id, method)）；
 *   ⑤ **现金只能缴一次**（UNIQUE(shift_id)），取消缴款必须把班次的已缴金额退回去；
 *   ⑥ **未核款不得日结**；已核款的班次其现金三段数必须落进日结单；
 *   ⑦ **订单只属于它自己的班次**：后一个班次加订单不得改变前一个班的系统应收；
 *   ⑧ **超阈值的差异门店不能自结**，必须挂 pending 交总部结案。
 *
 * 与其它测试同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争），
 * 且必须**可重复跑** —— 本测试真的会出库（日结）、真的会入库（退货/盘盈），
 * 只删单据不还原库存，第二轮就会因为「库存不足」失败，或者更糟：悄悄把演示库越改越乱。
 * 因此这里用**快照回滚**：开跑前拍 `inventory_stocks` 全表，跑完逐行还原；
 * 按 id 边界清掉本轮新增的流水、成本台账、批次主档。
 *
 * 用法：node scripts/test-pos2.mjs [industry]
 */
import { getDbFor } from '../server/db/index.js'
import { resetSequences } from '../server/db/seq.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
// A14：门店开单接入了结算域 ⇒ 开单会落**营销留痕**（`promotion_adjustments` /
// `promotion_usages`）并把 `promotions.used` 加一。这些账**不随 `pos_orders` 级联删除**，
// 所以清理必须成对回退，否则会留下指向已删订单的孤儿
// （`verify-seed` 的「使用登记的来源通道自洽」会因此永久失败 —— 本轮真实踩到）。
import { revertUsage } from '../server/lib/promotion.js'
import {
  openShift,
  declareShift,
  rejectShift,
  approveShift,
  settleVariance,
  cancelShift,
  createCashDrop,
  receiveCashDrop,
  cancelCashDrop,
  dailyCloseGate,
  computeShiftSystem,
  cashInflight,
  shiftDetail,
  createPosOrder,
  dailyClose,
  storeReturn,
  createStoreCheck,
  submitStoreCheckItems,
  adjustStoreCheck,
  getVarianceLimit,
  VARIANCE_EPS
} from '../server/lib/pos2.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

// 本测试造的每一条数据都带这个标记 —— 清理靠它，不靠「猜哪些是测试数据」
const T = '__test_pos2__'

// 测试用一个**演示数据不用的营业日**：这样门禁、日结的「本日订单」都只涉及本测试造的单据，
// 不会被演示库里当天的班次/订单干扰（否则断言依赖的是别人的数据，改一次 seed 就挂）
const BIZ = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)

let pass = 0
let fail = 0
const fails = []
function ok(cond, msg) {
  if (cond) pass += 1
  else {
    fail += 1
    fails.push(msg)
    console.log('  ✗', msg)
  }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  ✗ ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const num = (v) => Number(v) || 0
const near = (a, b, eps = 0.005) => Math.abs(num(a) - num(b)) <= eps
const okNear = (msg, a, b, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  ✗ ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const throws = (fn, code, msg) => {
  try {
    const v = fn()
    console.log(`  ✗ ${msg}：未抛错，返回 ${JSON.stringify(v)}`)
    ok(false, msg)
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  ✗ ${msg}：抛的是 ${e.code || e.name}/${e.message}`)
    ok(hit, msg)
  }
}

const req = { user: { uid: 1, name: '测试店长' } }
const reqOther = { user: { uid: 2, name: '测试店员' } }

// ---------------------------------------------------------------------------
// 环境准备
// ---------------------------------------------------------------------------
const store = db.prepare("SELECT * FROM stores WHERE status='active' ORDER BY id LIMIT 1").get()
if (!store) {
  console.log('✗ 演示库里没有可用门店，先跑 reseed-all')
  process.exit(1)
}
const wh = db.prepare("SELECT * FROM warehouses WHERE store_id=? AND status='active' ORDER BY id LIMIT 1").get(store.id)
if (!wh) {
  console.log(`✗ 门店 ${store.code} 未绑定门店仓`)
  process.exit(1)
}
const sku = db
  .prepare(
    `SELECT s.*, p.name AS product_name FROM inventory_stocks st
       JOIN product_skus s ON s.id=st.sku_id
       JOIN products p ON p.id=s.product_id
      WHERE st.warehouse_id=? AND st.qty_on_hand >= 20
      GROUP BY s.id ORDER BY st.qty_on_hand DESC LIMIT 1`
  )
  .get(wh.id)
if (!sku) {
  console.log(`✗ 门店仓 ${wh.code} 没有可用库存样本`)
  process.exit(1)
}
console.log(`\n[${INDUSTRY}] 门店 ${store.name} / 门店仓 ${wh.code} / 样本 SKU ${sku.sku_code} 营业日 ${BIZ}\n`)

// ---------------------------------------------------------------------------
// 快照与清理
// ---------------------------------------------------------------------------
const snapStocks = db
  .prepare('SELECT id, qty_on_hand, qty_reserved, cost_price, cost_amount FROM inventory_stocks')
  .all()
const maxTxn = db.prepare('SELECT COALESCE(MAX(id),0) m FROM inventory_transactions').get().m
const maxLedger = db.prepare('SELECT COALESCE(MAX(id),0) m FROM stock_cost_ledger').get().m
const maxBatch = db.prepare('SELECT COALESCE(MAX(id),0) m FROM inventory_batches').get().m
const txnCount0 = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
const ledgerCount0 = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c

function testShiftIds() {
  return db
    .prepare("SELECT id FROM pos_shifts WHERE remark = ? OR cashier_name = ?")
    .all(T, T)
    .map((r) => r.id)
}
function testOrderIds() {
  return db
    .prepare("SELECT id FROM pos_orders WHERE remark = ? OR remark LIKE ?")
    .all(T, `门店退货退款%`)
    .map((r) => r.id)
}

function purgeTestData() {
  const shiftIds = testShiftIds()
  const orderIds = testOrderIds()
  const checkIds = db
    .prepare("SELECT id FROM stock_checks WHERE remark = ? AND scope='store'")
    .all(T)
    .map((r) => r.id)
  const retIds = db
    .prepare('SELECT id FROM sales_returns WHERE reason = ?')
    .all(T)
    .map((r) => r.id)
  // 缴款单按**前缀**匹配而不是等值：取消缴款会把 remark 覆盖成「<标记> 取消原因」，
  // 等值匹配会让这类单子永远清不掉（已踩过：残渣把 verify-seed 搞成永久失败）。
  const dropIds = db.prepare('SELECT id FROM pos_cash_drops WHERE remark LIKE ?').all(`${T}%`).map((r) => r.id)
  const closeIds = db
    .prepare('SELECT id FROM pos_daily_closes WHERE biz_date = ? AND operator = ?')
    .all(BIZ, '测试店长')
    .map((r) => r.id)
  const soIds = closeIds.length
    ? [
        ...new Set(
          db
            .prepare(`SELECT hq_sales_order_ids FROM pos_daily_closes WHERE id IN (${closeIds.join(',')})`)
            .all()
            .flatMap((r) => String(r.hq_sales_order_ids || '').split(',').filter(Boolean).map(Number))
        )
      ]
    : []

  const inIds = (ids) => (ids.length ? `(${ids.join(',')})` : '(NULL)')
  const del = (sql) => db.prepare(sql).run().changes

  let txns = 0
  if (shiftIds.length) {
    del(`DELETE FROM pos_shift_payments WHERE shift_id IN ${inIds(shiftIds)}`)
    del(`DELETE FROM pos_cash_drop_items WHERE shift_id IN ${inIds(shiftIds)}`)
    del(`DELETE FROM doc_events WHERE doc_type='PSF' AND doc_id IN ${inIds(shiftIds)}`)
  }
  if (orderIds.length) {
    // 先成对回退营销留痕（减少使用计数 + 回退预算），再删订单行 ——
    // 顺序反了也不报错，只是 `promotions.used` 永远偏高、留痕变成孤儿。
    for (const id of orderIds) {
      try { revertUsage(db, { source: 'pos', orderId: Number(id) }) } catch { /* 已撤过：幂等 */ }
    }
    del(`DELETE FROM promotion_adjustments WHERE source='pos' AND order_id IN ${inIds(orderIds)}`)
    del(`DELETE FROM promotion_usages WHERE source='pos' AND order_id IN ${inIds(orderIds)}`)
    del(`DELETE FROM member_points_ledger WHERE source='pos' AND source_id IN ${inIds(orderIds)}`)
    del(`DELETE FROM pos_order_items WHERE pos_order_id IN ${inIds(orderIds)}`)
    del(`DELETE FROM doc_events WHERE doc_type='PS' AND doc_id IN ${inIds(orderIds)}`)
  }
  // 兜底（本轮真实踩到的形态）：**已经变成孤儿**的营销留痕也要清掉。
  // 上一轮的清理顺序落后于本批功能上线时，会留下指向已删门店单的留痕；
  // 而 `testOrderIds()` 是按 `remark` 找现存订单的 —— 订单都没了，它就找不到，
  // 于是残渣**永远清不掉**，`verify-seed` 变成永久失败。
  del(`DELETE FROM promotion_adjustments WHERE source='pos' AND NOT EXISTS (SELECT 1 FROM pos_orders p WHERE p.id = promotion_adjustments.order_id)`)
  del(`DELETE FROM promotion_usages WHERE source='pos' AND NOT EXISTS (SELECT 1 FROM pos_orders p WHERE p.id = promotion_usages.order_id)`)
  // 清了留痕就要把两个计数器**按现存明细重算**（`used` 是"有效使用数"的派生值）：
  // 不重算的话，`verify-seed` 的「used 计数器 = 使用登记数」会接着失败。
  db.prepare(`
    UPDATE promotions SET used = (SELECT COUNT(*) FROM promotion_usages u WHERE u.promotion_id = promotions.id)
  `).run()
  db.prepare(`
    UPDATE promotion_campaign_budgets
       SET used = COALESCE((
             SELECT SUM(u.amount) FROM promotion_usages u
              JOIN promotions p ON p.id = u.promotion_id
             WHERE p.campaign_id = promotion_campaign_budgets.campaign_id), 0)
     WHERE type = 'spend'
  `).run()
  if (soIds.length) {
    del(`DELETE FROM sales_order_items WHERE order_id IN ${inIds(soIds)}`)
    del(`DELETE FROM sales_orders WHERE id IN ${inIds(soIds)}`)
  }
  if (checkIds.length) {
    del(`DELETE FROM stock_check_items WHERE check_id IN ${inIds(checkIds)}`)
    del(`DELETE FROM doc_events WHERE doc_type='CK' AND doc_id IN ${inIds(checkIds)}`)
  }
  if (retIds.length) {
    del(`DELETE FROM sales_return_items WHERE return_id IN ${inIds(retIds)}`)
  }
  if (dropIds.length) del(`DELETE FROM pos_cash_drops WHERE id IN ${inIds(dropIds)}`)
  if (closeIds.length) del(`DELETE FROM pos_daily_closes WHERE id IN ${inIds(closeIds)}`)
  if (orderIds.length) del(`DELETE FROM pos_orders WHERE id IN ${inIds(orderIds)}`)
  if (retIds.length) del(`DELETE FROM sales_returns WHERE id IN ${inIds(retIds)}`)
  if (checkIds.length) del(`DELETE FROM stock_checks WHERE id IN ${inIds(checkIds)}`)
  if (shiftIds.length) del(`DELETE FROM pos_shifts WHERE id IN ${inIds(shiftIds)}`)

  // 库存派生物：按 id 边界截断（本轮新增的流水/台账/批次）
  txns = del(`DELETE FROM inventory_transactions WHERE id > ${maxTxn}`)
  del(`DELETE FROM stock_cost_ledger WHERE id > ${maxLedger}`)
  del(`DELETE FROM inventory_batches WHERE id > ${maxBatch}`)
  return { txns, shifts: shiftIds.length, orders: orderIds.length, drops: dropIds.length }
}

function restoreStocks() {
  const upd = db.prepare('UPDATE inventory_stocks SET qty_on_hand=?, qty_reserved=?, cost_price=?, cost_amount=? WHERE id=?')
  const snapIds = snapStocks.map((s) => Number(s.id))
  let n = 0
  db.transaction(() => {
    for (const s of snapStocks) {
      n += upd.run(s.qty_on_hand, s.qty_reserved, s.cost_price, s.cost_amount, s.id).changes
    }
    // 本轮若新增了库存行（批次数变了），必须删掉 —— 留着会让下一轮的账面凭空多一批货。
    // 判据是**快照里的 id 集合**，不是「id 大于某个数」：SQLite 的 id 在删除后会被复用，
    // 按 id 边界判断会把新行误判成旧行（也就会把旧行误删）。
    n += db.prepare(`DELETE FROM inventory_stocks WHERE id NOT IN (${snapIds.join(',') || 'NULL'})`).run().changes
  })()
  return n
}

// 先清上一轮残渣（**必须在快照之后立刻跑**，否则会把上一轮的库存算进这一轮的快照）
const preCleaned = purgeTestData()
if (preCleaned.shifts || preCleaned.orders) {
  console.log(`  （清掉上一轮残渣：班次 ${preCleaned.shifts} / 订单 ${preCleaned.orders} / 缴款 ${preCleaned.drops}）`)
}
restoreStocks()

const qtyOf = () =>
  num(
    db
      .prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
      .get(wh.id, sku.id).q
  )
/** 门店仓全部库存数量（盘点断言用它，避免「换了个 SKU」就假失败） */
const qtyAll = () =>
  num(db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=?').get(wh.id).q)

// ---------------------------------------------------------------------------
console.log('[1] 开班与单号')
// ---------------------------------------------------------------------------
const shiftA = openShift(db, {
  storeId: store.id,
  cashierId: 1,
  cashierName: '测试收银A',
  businessDate: BIZ,
  openingFloat: 500,
  remark: T
})
ok(/^PSF\d{8}\d{4}$/.test(String(shiftA.doc_no)), `开班单号符合 PSF+日期+4 位序号（${shiftA.doc_no}）`)
eq('开班后状态为营业中', shiftA.status, 'open')
eq('开班备用金落库', num(shiftA.opening_float), 500)

throws(
  () => openShift(db, { storeId: store.id, cashierId: 1, cashierName: '测试收银A', businessDate: BIZ, remark: T }),
  'SHIFT_ALREADY_OPEN',
  '同一收银员同一天重复开班被拦'
)
// 换一个收银员可以开班（一家店可以同时有几个钱箱）
const shiftB = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银B', businessDate: BIZ, remark: T })
eq('同门店不同收银员可以开班', shiftB.status, 'open')
ok(shiftB.doc_no !== shiftA.doc_no, '两个班次的单号不同')

// ---------------------------------------------------------------------------
console.log('\n[2] 开单必须绑班次 + 系统应收按班次聚合')
// ---------------------------------------------------------------------------
const o1 = createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftA.id, items: [{ sku_id: sku.id, qty: 2 }], payMethod: 'cash', remark: T })
const o2 = createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftA.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'cash', remark: T })
const o3 = createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftA.id, items: [{ sku_id: sku.id, qty: 3 }], payMethod: 'wxpay', remark: T })
const o4 = createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftA.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'alipay', remark: T })
const nullShift = db.prepare('SELECT COUNT(*) c FROM pos_orders WHERE id IN (?,?,?,?) AND shift_id IS NULL').get(o1.id, o2.id, o3.id, o4.id).c
eq('开单全部绑定了班次（无孤儿订单）', nullShift, 0)

let sys = computeShiftSystem(db, shiftA.id)
const cashSys = num(o1.pay_amount) + num(o2.pay_amount)
const wxSys = num(o3.pay_amount)
const aliSys = num(o4.pay_amount)
okNear('系统应收现金 = 两笔现金单之和', sys.sys_cash, cashSys)
eq('系统应收覆盖三种支付方式', Object.keys(sys.byMethod).filter((m) => sys.byMethod[m].order_count > 0).sort(), ['alipay', 'cash', 'wxpay'])
eq('订单笔数汇总正确', sys.order_count, 4)

// 另一个班次的订单不得进入本班次的系统应收（这是「同一天两班不翻倍」的核心断言）
createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftB.id, items: [{ sku_id: sku.id, qty: 5 }], payMethod: 'cash', remark: T })
okNear('另一班次开单后，本班次系统应收不变（不翻倍）', computeShiftSystem(db, shiftA.id).sys_cash, cashSys)

// ---------------------------------------------------------------------------
console.log('\n[3] 门店退货：货回门店仓 + 退款冲减系统应收')
// ---------------------------------------------------------------------------
const qtyBeforeRet = qtyOf()
const ret = storeReturn(db, req, {
  storeId: store.id,
  shiftId: shiftA.id,
  items: [{ sku_id: sku.id, qty: 1 }],
  reason: T,
  returnDate: BIZ,
  refundMethod: 'cash'
})
okNear('退货入库到门店仓（+1 件）', qtyOf() - qtyBeforeRet, 1)
const retRow = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(ret.returnId)
eq('退货单渠道为门店且已确认', [retRow.channel, retRow.status], ['store', 'confirmed'])
const rOrder = db.prepare('SELECT * FROM pos_orders WHERE id=?').get(ret.refundOrderId)
ok(num(rOrder.pay_amount) < 0 && Number(rOrder.shift_id) === Number(shiftA.id), '退款登记为负数 POS 单且挂在当前班次上')
sys = computeShiftSystem(db, shiftA.id)
okNear('退款冲减系统应收现金（−退货金额）', sys.sys_cash, cashSys - num(ret.amount))
const cashSysAfterRet = sys.sys_cash

// ---------------------------------------------------------------------------
console.log('\n[4] 交班报数：三段钱与按支付方式拆分')
// ---------------------------------------------------------------------------
const declaredA = declareShift(db, req, {
  shiftId: shiftA.id,
  payments: [
    { method: 'cash', declared_amount: cashSysAfterRet },
    { method: 'wxpay', declared_amount: wxSys + 20 },
    { method: 'alipay', declared_amount: aliSys }
  ],
  remark: T
})
eq('报数后状态为已报数', declaredA.shift.status, 'declared')
okNear('班次系统现金与聚合一致', declaredA.shift.sys_cash, cashSysAfterRet)
okNear('报数阶段不产生长短款（店长还没数）', declaredA.shift.variance, 0)
const payRow = (m) => declaredA.payments.find((p) => p.method === m)
okNear('现金行实点暂为 0（待核款）', payRow('cash').counted_amount, 0)
okNear('现金行差异暂为 0（待核款）', payRow('cash').diff, 0)
okNear('微信行差异立即成立（+20 长款）', payRow('wxpay').diff, 20)
okNear('支付宝行差异为 0', payRow('alipay').diff, 0)
eq('支付方式行数 = 有金额的渠道数 + 现金', declaredA.payments.length, 3)

// UNIQUE (shift_id, method)
throws(
  () =>
    db
      .prepare('INSERT INTO pos_shift_payments (shift_id,method,sys_amount,declared_amount,counted_amount,diff,order_count) VALUES (?,?,0,0,0,0,0)')
      .run(shiftA.id, 'cash'),
  undefined,
  '同一班次同一支付方式只能有一行（UNIQUE 生效）'
)

// ---------------------------------------------------------------------------
console.log('\n[5] 核款：长短款 = 实点 − 系统应收')
// ---------------------------------------------------------------------------
const countedA = cashSysAfterRet - 5 // 现金短款 5 元
throws(
  () => approveShift(db, req, { shiftId: shiftA.id, countedCash: countedA, varianceHandled: 'absorb' }),
  'VARIANCE_NOTE_REQUIRED',
  '有长短款但未填原因被拦'
)
throws(
  () => approveShift(db, req, { shiftId: shiftA.id, countedCash: countedA, varianceNote: '找零少收款' }),
  'VARIANCE_HANDLE_REQUIRED',
  '有长短款但未填责任归属被拦'
)
throws(
  () => approveShift(db, req, { shiftId: shiftA.id }),
  'COUNTED_REQUIRED',
  '不填店长实点被拦（不允许沿用收银员报数）'
)
const closedA = approveShift(db, req, {
  shiftId: shiftA.id,
  countedCash: countedA,
  varianceNote: '现金找零短款',
  varianceHandled: 'absorb'
})
eq('核款后状态为已核款', closedA.shift.status, 'closed')
okNear('长短款 = 实点 − 系统应收（负数=短款）', closedA.shift.variance, -5)
eq('差异责任归属落库', closedA.shift.variance_handled, 'absorb')
ok(!!closedA.shift.approved_at && !!closedA.shift.approved_by_name, '核款人/时间落库')
const cashRow = closedA.payments.find((p) => p.method === 'cash')
okNear('现金行写入店长实点', cashRow.counted_amount, countedA)
okNear('现金行差异 = −5（短款）', cashRow.diff, -5)
okNear('各支付方式差异合计 = 现金 −5 + 微信 +20 = +15', closedA.shift.pay_diff_total, 15)
eq('差异笔数 = 2（现金与微信各一笔）', closedA.shift.pay_diff_count, 2)

// ---------------------------------------------------------------------------
console.log('\n[6] 退回重报：清干净，不残留半套')
// ---------------------------------------------------------------------------
const declared6 = declareShift(db, req, {
  shiftId: shiftB.id,
  payments: [{ method: 'cash', declared_amount: computeShiftSystem(db, shiftB.id).sys_cash }],
  remark: T
})
eq('B 班报数成功', declared6.shift.status, 'declared')
throws(() => rejectShift(db, req, { shiftId: shiftB.id }), 'REMARK_REQUIRED', '退回未填原因被拦')
const rejected = rejectShift(db, req, { shiftId: shiftB.id, remark: '与报表差太多，重数' })
eq('退回后回到营业中', rejected.shift.status, 'open')
eq('退回后支付方式明细被清空', rejected.payments.length, 0)
okNear('退回后班次报数金额归零', rejected.shift.declared_cash, 0)

// ---------------------------------------------------------------------------
console.log('\n[7] 超阈值差异不得门店自结 + 总部落案')
// ---------------------------------------------------------------------------
const sysB = computeShiftSystem(db, shiftB.id).sys_cash
declareShift(db, req, { shiftId: shiftB.id, payments: [{ method: 'cash', declared_amount: sysB }], remark: T })
const limit = getVarianceLimit(db)
ok(limit > 0, `长短款自结上限读取正常（${limit} 元）`)
throws(
  () => approveShift(db, req, { shiftId: shiftB.id, countedCash: sysB + limit + 100, varianceNote: '疑似收款未录入', varianceHandled: 'charge' }),
  'VARIANCE_LIMIT_EXCEEDED',
  '超过上限的差异选择「责任人承担」被拦'
)
const closedB = approveShift(db, req, {
  shiftId: shiftB.id,
  countedCash: sysB + limit + 100,
  varianceNote: '疑似收款未录入',
  varianceHandled: 'pending'
})
ok(closedB.shift.variance > limit, `大额长款落库（+${closedB.shift.variance}）`)
eq('大额差异强制挂账待查', closedB.shift.variance_handled, 'pending')
ok(closedB.can_settle, '允许总部结案')
const settled = settleVariance(db, req, { shiftId: shiftB.id, handled: 'charge', note: '总部核实为收银员漏录' })
eq('总部结案为责任人承担', settled.shift.variance_handled, 'charge')
throws(() => settleVariance(db, req, { shiftId: shiftB.id, handled: 'charge' }), 'NO_PENDING_VARIANCE', '重复结案被拦')
const evt = db
  .prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PSF' AND doc_id=? AND action='settle'")
  .get(shiftB.id).c
eq('结案留有内核留痕（doc_events）', evt, 1)

// ---------------------------------------------------------------------------
console.log('\n[8] 缴款：一次性缴清、只能缴一次、取消要回滚')
// ---------------------------------------------------------------------------
const dropA = createCashDrop(db, reqOther, {
  storeId: store.id,
  shiftIds: [shiftA.id],
  dropDate: BIZ,
  handedBy: 1,
  handedByName: '测试店长',
  remark: T
})
const shiftA2 = db.prepare('SELECT * FROM pos_shifts WHERE id=?').get(shiftA.id)
okNear('缴款金额 = 班次实点现金', dropA.amount, num(shiftA2.counted_cash))
okNear('班次已缴金额被回写', shiftA2.cash_drop_amount, dropA.amount)
throws(
  () => createCashDrop(db, reqOther, { storeId: store.id, shiftIds: [shiftA.id], dropDate: BIZ, remark: T }),
  'ALREADY_DROPPED',
  '同一班次重复缴款被拦'
)
throws(() => db.prepare('INSERT INTO pos_cash_drop_items (drop_id,shift_id,shift_no,amount) VALUES (?,?,?,0)').run(dropA.id, shiftA.id, shiftA2.doc_no), undefined, '同一班次只能出现在一张缴款明细里（UNIQUE 生效）')
// 实点现金为 0 的班次无款可缴（全部现金不见了，那是另一类问题，不是"缴款"）
const shiftH = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银H', businessDate: BIZ, remark: T })
createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftH.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'cash', remark: T })
const sysH = computeShiftSystem(db, shiftH.id).sys_cash
declareShift(db, req, { shiftId: shiftH.id, payments: [{ method: 'cash', declared_amount: sysH }], remark: T })
const closedH = approveShift(db, req, { shiftId: shiftH.id, countedCash: 0, varianceNote: '钱箱里没有现金', varianceHandled: 'pending' })
okNear('实点为 0 时长短款 = −系统应收', closedH.shift.variance, -sysH)
throws(
  () => createCashDrop(db, reqOther, { storeId: store.id, shiftIds: [shiftH.id], dropDate: BIZ, handedBy: null, remark: T }),
  'NOTHING_TO_DROP',
  '实点现金为 0 的班次不能缴款'
)
throws(() => receiveCashDrop(db, req, { dropId: dropA.id }), 'SAME_PERSON', '缴款人与接收人相同被拦')
const received = receiveCashDrop(db, reqOther, { dropId: dropA.id, referenceNo: 'BG-001' })
eq('店长接收缴款后状态为已接收', received.status, 'received')

// 资金在途：已核款未缴的金额应因这次缴款减少
const inflightBefore = num(cashInflight(db, { storeId: store.id }).to_drop)
const shiftC = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银C', businessDate: BIZ, remark: T })
createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftC.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'cash', remark: T })
const sysC = computeShiftSystem(db, shiftC.id).sys_cash
declareShift(db, req, { shiftId: shiftC.id, payments: [{ method: 'cash', declared_amount: sysC }], remark: T })
approveShift(db, req, { shiftId: shiftC.id, countedCash: sysC, varianceNote: null, varianceHandled: null })
const inflightAfter = num(cashInflight(db, { storeId: store.id }).to_drop)
okNear('已核款未缴的现金计入资金在途（to_drop）', inflightAfter - inflightBefore, sysC)

const dropC = createCashDrop(db, reqOther, { storeId: store.id, shiftIds: [shiftC.id], dropDate: BIZ, handedBy: null, handedByName: '测试店长B', remark: T })
const inflightDropped = num(cashInflight(db, { storeId: store.id }).to_drop)
okNear('缴款后在途归零', inflightAfter - inflightDropped, sysC)
// 取消原因必须**带上标记前缀**：`cancelCashDrop` 会把 remark 覆盖成取消原因，
// 一旦覆盖掉 `__test_pos2__`，purgeTestData 就再也找不到这张单子，
// 于是它作为「已取消、金额 158、明细 0 条」的残渣留在演示库里，
// 把 `verify-seed` 的「缴款单金额 = 明细合计」检查搞成永久失败。
const cancelled = cancelCashDrop(db, reqOther, { dropId: dropC.id, remark: `${T} 写错了` })
eq('取消缴款单状态为已取消', cancelled.status, 'cancelled')
const shiftC2 = db.prepare('SELECT * FROM pos_shifts WHERE id=?').get(shiftC.id)
okNear('取消缴款后班次已缴金额回滚为 0', shiftC2.cash_drop_amount, 0)
okNear('取消缴款后在途金额回到未缴状态', num(cashInflight(db, { storeId: store.id }).to_drop), inflightAfter)
// 回滚后可以重新缴款
const dropC2 = createCashDrop(db, reqOther, { storeId: store.id, shiftIds: [shiftC.id], dropDate: BIZ, handedBy: null, handedByName: '测试店长B', remark: T })
ok(dropC2.id !== dropC.id && dropC2.amount > 0, '取消后该班次可以重新缴款')

// ---------------------------------------------------------------------------
console.log('\n[9] 作废规则')
// ---------------------------------------------------------------------------
const shiftE = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银E', businessDate: BIZ, remark: T })
createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftE.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'cash', remark: T })
throws(() => cancelShift(db, req, { shiftId: shiftE.id }), 'SHIFT_HAS_ORDERS', '有订单的班次不能作废')
const voided = db.prepare("UPDATE pos_orders SET status='voided' WHERE shift_id=? AND status IN ('local','synced')").run(shiftE.id)
ok(voided.changes >= 1, '把该班次订单作废后再试')
const cancelledShift = cancelShift(db, req, { shiftId: shiftE.id, remark: '空班作废' })
eq('无有效订单的班次可以作废', cancelledShift.shift.status, 'cancelled')

// ---------------------------------------------------------------------------
console.log('\n[10] 未核款不得日结')
// ---------------------------------------------------------------------------
const shiftF = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银F', businessDate: BIZ, remark: T })
let gate = dailyCloseGate(db, { storeId: store.id, bizDate: BIZ })
ok(!gate.ok, '存在营业中班次时门禁拦下日结')
ok(gate.blocking.some((b) => Number(b.id) === Number(shiftF.id)), '拦下的班次里包含营业中的 F 班')
const shiftG = openShift(db, { storeId: store.id, cashierId: null, cashierName: '测试收银G', businessDate: BIZ, remark: T })
createPosOrder(db, { storeId: store.id, warehouseId: wh.id, shiftId: shiftG.id, items: [{ sku_id: sku.id, qty: 1 }], payMethod: 'cash', remark: T })
const sysG = computeShiftSystem(db, shiftG.id).sys_cash
declareShift(db, req, { shiftId: shiftG.id, payments: [{ method: 'cash', declared_amount: sysG }], remark: T })
gate = dailyCloseGate(db, { storeId: store.id, bizDate: BIZ })
ok(!gate.ok && gate.blocking.some((b) => Number(b.id) === Number(shiftG.id)), '已报数未核款的班次同样拦下日结')
throws(
  () => dailyClose(db, req, { storeId: store.id, warehouseId: wh.id, storeName: store.name, bizDate: BIZ, operatorUid: 1, operatorName: '测试店长' }),
  'SHIFT_NOT_REVIEWED',
  '日结被门禁拦下（未核款）'
)
approveShift(db, req, { shiftId: shiftG.id, countedCash: sysG, varianceNote: null, varianceHandled: null })
cancelShift(db, req, { shiftId: shiftF.id, remark: '空班作废' })
gate = dailyCloseGate(db, { storeId: store.id, bizDate: BIZ })
eq('全部班次核款/作废后门禁放行', gate.ok, true)

// ---------------------------------------------------------------------------
console.log('\n[11] 日结：现金三段数落单 + 出库上传')
// ---------------------------------------------------------------------------
const closedShifts = db
  .prepare("SELECT * FROM pos_shifts WHERE store_id=? AND biz_date=? AND status='closed'")
  .all(store.id, BIZ)
const expectSys = closedShifts.reduce((n, s) => n + num(s.sys_cash), 0)
const expectCounted = closedShifts.reduce((n, s) => n + num(s.counted_cash), 0)
const expectVar = closedShifts.reduce((n, s) => n + num(s.variance), 0)
const qtyBeforeClose = qtyOf()
const localCount = db
  .prepare("SELECT COUNT(*) c FROM pos_orders WHERE store_id=? AND biz_date=? AND status='local'")
  .get(store.id, BIZ).c
const close = dailyClose(db, req, {
  storeId: store.id,
  warehouseId: wh.id,
  storeName: store.name,
  bizDate: BIZ,
  operatorUid: 1,
  operatorName: '测试店长'
})
okNear('日结单系统应收现金 = 各班次之和', close.cash.sys_cash, expectSys)
okNear('日结单实点现金 = 各班次之和', close.cash.counted_cash, expectCounted)
okNear('日结单长短款 = 各班次之和', close.cash.cash_variance, expectVar)
eq('日结单登记参与核款的班次数', close.cash.closed_shift_count, closedShifts.length)
const closeRow = db.prepare('SELECT * FROM pos_daily_closes WHERE id=?').get(close.closeId)
okNear('日结批次落库的现金三段数一致', num(closeRow.cash_variance), expectVar)
eq('门店单已标记上传', db.prepare("SELECT COUNT(*) c FROM pos_orders WHERE shift_id IN (SELECT id FROM pos_shifts WHERE remark=?) AND status='local'").get(T).c, 0)
ok(close.orderCount === localCount, `日结上传单数 = 本营业日本地单数（${close.orderCount}）`)
ok(qtyBeforeClose - qtyOf() > 0, '日结真的从门店仓出了库')
eq('每个班次都回写了日结批次', db.prepare('SELECT COUNT(*) c FROM pos_shifts WHERE daily_close_id=?').get(close.closeId).c, closedShifts.length)
throws(
  () => dailyClose(db, req, { storeId: store.id, warehouseId: wh.id, storeName: store.name, bizDate: BIZ, operatorUid: 1, operatorName: '测试店长' }),
  'NO_LOCAL_ORDERS',
  '没有本地单时重复日结被拦'
)

// ---------------------------------------------------------------------------
console.log('\n[12] 门店盘点（scope=store）')
// ---------------------------------------------------------------------------
const qtyBeforeCheck = qtyAll()
const checkRes = createStoreCheck(db, req, { storeId: store.id, remark: T, checkDate: BIZ, checker: '测试店长' })
const head = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(checkRes.id)
eq('盘点单范围为门店', [head.scope, Number(head.store_id)], ['store', Number(store.id)])
eq('盘点单落在门店仓', Number(head.warehouse_id), Number(wh.id))
const items = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(head.id)
ok(items.length > 0, `盘点明细按门店仓现状生成（${items.length} 行）`)
// 挑账面数量最大的一行做盘亏 1 件：挑「第一个」会因为某行账面恰好不足 1 件而失败，
// 那时看起来是「盘点过账报库存不足」，实际只是取样没挑对。
const target = items.slice().sort((a, b) => num(b.book_qty) - num(a.book_qty))[0]
const book = num(target.book_qty)
const skuQtyOf = (skuId) =>
  num(db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').get(wh.id, skuId).q)
const targetQtyBefore = skuQtyOf(target.sku_id)
// 故意传一个错误的 book_qty：账面数必须从库里取，不能被客户端带偏
submitStoreCheckItems(db, req, {
  checkId: head.id,
  items: [{ id: target.id, book_qty: book - 1, actual_qty: book - 1, reason: '破损一件' }]
})
const afterItems = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(head.id)
const t2 = afterItems.find((i) => i.id === target.id)
okNear('盘亏差异按库里的账面数计算（−1，不受客户端 book_qty 影响）', t2.diff_qty, -1)
eq('盘点单转为盘点中', db.prepare('SELECT status FROM stock_checks WHERE id=?').get(head.id).status, 'checking')
adjustStoreCheck(db, req, { checkId: head.id })
eq('盘点单转为已调整', db.prepare('SELECT status FROM stock_checks WHERE id=?').get(head.id).status, 'adjusted')
okNear('盘亏过账后该 SKU 门店库存 −1', targetQtyBefore - skuQtyOf(target.sku_id), 1)
// 盘亏的对象是「账面数量最大的那一行」，它未必是本测试的样本 SKU，
// 所以这里比的是**门店仓总量**，不是样本 SKU 的量 —— 按样本 SKU 比会在换库换数据时假失败。
ok(qtyBeforeCheck > qtyAll(), '盘点差异真的动了门店库存')

// ---------------------------------------------------------------------------
console.log('\n[13] 明细一致性自检')
// ---------------------------------------------------------------------------
const orphanPay = db
  .prepare('SELECT COUNT(*) c FROM pos_shift_payments p WHERE NOT EXISTS (SELECT 1 FROM pos_shifts s WHERE s.id=p.shift_id)')
  .get().c
eq('没有孤儿支付方式明细', orphanPay, 0)
const orphanOrder = db
  .prepare("SELECT COUNT(*) c FROM pos_orders o WHERE o.shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pos_shifts s WHERE s.id=o.shift_id)")
  .get().c
eq('没有指向不存在班次的订单', orphanOrder, 0)
const badVar = db
  .prepare(
    `SELECT COUNT(*) c FROM pos_shifts
      WHERE status='closed' AND ABS(COALESCE(variance,0) - (COALESCE(counted_cash,0) - COALESCE(sys_cash,0))) > 0.005`
  )
  .get().c
eq('全部已核款班次满足「长短款 = 实点 − 系统应收」', badVar, 0)
const badDiff = db
  .prepare("SELECT COUNT(*) c FROM pos_shift_payments WHERE method <> 'cash' AND ABS(diff - (counted_amount - sys_amount)) > 0.005")
  .get().c
eq('非现金渠道满足「差异 = 实点 − 系统应收」', badDiff, 0)
const doubleDrop = db
  .prepare('SELECT COUNT(*) c FROM (SELECT shift_id FROM pos_cash_drop_items GROUP BY shift_id HAVING COUNT(*) > 1)')
  .get().c
eq('没有任何班次被缴款两次', doubleDrop, 0)

// ---------------------------------------------------------------------------
console.log('\n[14] 清理与回滚')
// ---------------------------------------------------------------------------
const cleaned = purgeTestData()
const restored = restoreStocks()
const txnCount1 = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
const ledgerCount1 = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c
eq('清理后库存流水条数回到起点', txnCount1, txnCount0)
eq('清理后成本台账条数回到起点', ledgerCount1, ledgerCount0)
ok(cleaned.txns > 0, `清理掉本轮库存流水 ${cleaned.txns} 条`)
ok(restored >= 0, `还原库存行 ${restored} 行`)
eq('清理后本测试的班次归零', testShiftIds().length, 0)
eq('清理后本测试的订单归零', testOrderIds().length, 0)
eq(
  '清理后本测试的缴款单归零',
  db.prepare('SELECT COUNT(*) c FROM pos_cash_drops WHERE remark=?').get(T).c,
  0
)
eq(
  '清理后本测试的门店盘点单归零',
  db.prepare("SELECT COUNT(*) c FROM stock_checks WHERE remark=? AND scope='store'").get(T).c,
  0
)
eq(
  '清理后本测试的门店退货单归零',
  db.prepare('SELECT COUNT(*) c FROM sales_returns WHERE reason=?').get(T).c,
  0
)
eq('清理后本测试的日结批次归零', db.prepare('SELECT COUNT(*) c FROM pos_daily_closes WHERE biz_date=? AND operator=?').get(BIZ, '测试店长').c, 0)
resetSequences(db, [
  'pos_shift_payments',
  'pos_cash_drop_items',
  'pos_cash_drops',
  'pos_orders',
  'pos_order_items',
  'pos_shifts',
  'pos_daily_closes',
  'stock_checks',
  'stock_check_items',
  'sales_returns',
  'sales_return_items'
])
pruneOrphanEvents(db)
const orphanPayAfter = db
  .prepare('SELECT COUNT(*) c FROM pos_shift_payments p WHERE NOT EXISTS (SELECT 1 FROM pos_shifts s WHERE s.id=p.shift_id)')
  .get().c
eq('清理后没有孤儿支付方式明细', orphanPayAfter, 0)
eq('VARIANCE_EPS 为半分钱', VARIANCE_EPS, 0.005)

// ---------------------------------------------------------------------------
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
if (fail) {
  console.log('失败项：')
  for (const f of fails) console.log('  -', f)
  process.exit(1)
}
