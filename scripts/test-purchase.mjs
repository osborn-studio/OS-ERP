/**
 * ============================================================================
 * 文件标识：scripts/test-purchase.mjs ｜ 测试：采购域（模块 07）断言测试
 * ============================================================================
 * 【职责】测试：采购域（模块 07）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购域（模块 07）断言测试
// 用法：node scripts/test-purchase.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是八条硬口径有没有真的落地：
//   ① 取价有链且必须带来源    ⑤ 三单结算三种模式的金额算法
//   ② 供货目录是硬拦截        ⑥ 核销生效点 = 付款单审批通过
//   ③ 超量控制在写库之前拦     ⑦ 四段关闭只进不退
//   ④ 请购可部分转单          ⑧ 账实一致：快照必须等于明细合计
//   ⑨ 发票明细必须挂得上订单行（否则「已开票金额」与「开票关闭」会静默失效）
// 外加一条不可绕过：单据流转只能走内核（不在路由里手写状态判断）。
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { seedProcurement } from '../server/db/procure-seed.js'
import {
  PurchaseError, resolvePurchasePrice, checkSupplyCatalog, upsertSupplierProduct,
  checkOverReceive, refreshCloseFlags, refreshOrderStats,
  createRequisition, getRequisition, transitionRequisition, convertRequisitionToOrder,
  createInvoice, getInvoice, transitionInvoice, matchInvoiceToReceipts,
  buildSettlement, getSettlement, transitionSettlement,
  createPayment, getPayment, transitionPayment, planAllocation
} from '../server/lib/purchase.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'food'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
/** 断言某次调用抛错并带上期望的 code */
const throws = (fn, code, msg) => {
  try {
    fn()
    ok(false, `${msg}（未抛错）`)
  } catch (e) {
    const hit = !code || e.code === code
    ok(hit, hit ? `${msg} → ${e.code}` : `${msg}（期望 ${code}，实得 ${e.code}）`)
  }
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

await runWithIndustry(industry, () => {
  const db = getDb()
  const actor = { id: null, name: 'tester' }

  seedProcurement(db, { industry, silent: true })

  console.log(`\n采购域测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))

  // 稳定的夹具：取一个供应商 + 它的供货目录
  const sup = db.prepare('SELECT * FROM suppliers ORDER BY id LIMIT 1').get()
  const catalog = db
    .prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND is_available=1 AND price>0 ORDER BY sku_id LIMIT 3')
    .all(sup.id)
  const wh = db.prepare("SELECT * FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id LIMIT 1").get()
    || db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get()
  // 全部放开起订量，后面专门的 MOQ 用例再单独抬高，避免别的用例被 MOQ 误伤
  for (const c of catalog) {
    upsertSupplierProduct(db, { supplierId: sup.id, skuId: c.sku_id, patch: { min_order_qty: 0 }, operator: 'tester' })
  }

  // ---------------------------------------------------------------
  section('T1 采购取价链（四档 + 必须带来源标签）')
  const skuA = catalog[0].sku_id
  const skuB = catalog[1] ? catalog[1].sku_id : catalog[0].sku_id
  const skuC = catalog[2] ? catalog[2].sku_id : catalog[0].sku_id
  const p1 = resolvePurchasePrice(db, { skuId: skuA, supplierId: sup.id })
  ok(p1.source === 'agreement' && p1.sourceLabel === '供货目录协议价', `① 供货目录协议价优先（${p1.price} / ${p1.sourceLabel}）`)
  ok(p1.price === round2(catalog[0].price), '协议价取到的就是目录里那一列，不是另算的')

  // ② 该供应商最近成交价：清掉协议价、只留 last_price
  db.prepare('UPDATE supplier_products SET price=NULL, last_price=?, last_price_date=? WHERE supplier_id=? AND sku_id=?')
    .run(round2((catalog[1] ? catalog[1].price : catalog[0].price) * 1.23), '2026-01-01', sup.id, skuB)
  const p2 = resolvePurchasePrice(db, { skuId: skuB, supplierId: sup.id })
  ok(p2.source === 'last_deal', `② 无协议价时回落最近成交价（${p2.price} / ${p2.sourceLabel}）`)

  // ③ 最近采购订单价：该供应商对该 SKU 有过采购订单
  const histSku = db
    .prepare(
      `SELECT oi.sku_id, oi.price, o.doc_no
         FROM purchase_order_items oi JOIN purchase_orders o ON o.id=oi.order_id
        WHERE o.supplier_id=? AND oi.price>0 AND o.status NOT IN ('cancelled')
        -- 排序必须与 resolvePurchasePrice 完全一致（同日多单时靠 oi.id 决胜），
        -- 否则测试取到的「最近一单」和产品取到的可能不是同一张
        ORDER BY o.order_date DESC, oi.id DESC LIMIT 1`
    )
    .get(sup.id)
  ok(!!histSku, `存在历史采购订单行可作取价来源（${histSku?.doc_no}）`)
  if (histSku) {
    db.prepare('DELETE FROM supplier_products WHERE supplier_id=? AND sku_id=?').run(sup.id, histSku.sku_id)
    const p3 = resolvePurchasePrice(db, { skuId: histSku.sku_id, supplierId: sup.id })
    ok(p3.source === 'last_order', `③ 无目录无成交价时回落最近采购订单价（${p3.price} / ${p3.sourceLabel}）`)
    ok(p3.detail?.doc_no === histSku.doc_no, '取价结果带回来源单号（可追溯）')
  }

  // ④ 标准成本兜底：一个完全没在该供应商出现过的 SKU
  const otherSku = db
    .prepare(
      `SELECT s.id FROM product_skus s
        WHERE s.id NOT IN (SELECT sku_id FROM supplier_products WHERE supplier_id=?)
          AND s.id NOT IN (SELECT oi.sku_id FROM purchase_order_items oi JOIN purchase_orders o ON o.id=oi.order_id WHERE o.supplier_id=?)
          AND s.cost_std > 0 LIMIT 1`
    )
    .get(sup.id, sup.id)
  if (otherSku) {
    const p4 = resolvePurchasePrice(db, { skuId: otherSku.id, supplierId: sup.id })
    ok(p4.source === 'cost_std' && p4.sourceLabel === '标准成本', `④ 全无来源时回落标准成本（${p4.price} / ${p4.sourceLabel}）`)
  }
  const pm = resolvePurchasePrice(db, { skuId: skuA, supplierId: sup.id, manualPrice: 6.66 })
  ok(pm.source === 'manual' && pm.price === 6.66, '手工录入价直通（不参与链条）')

  // ---------------------------------------------------------------
  section('T2 供货目录与最小起订量（硬拦截）')
  const blockSku = db
    .prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND is_available=0 LIMIT 1')
    .get(sup.id)
  ok(!!blockSku, `存在「明确不供」的目录记录（演示数据已埋点）`)
  if (blockSku) {
    const r = checkSupplyCatalog(db, { supplierId: sup.id, lines: [{ sku_id: blockSku.sku_id, qty: 999 }] })
    ok(r.some((i) => i.code === 'NOT_SUPPLIED' && i.level === 'block'), '目录标记不供 → block 级拦截')
  }
  upsertSupplierProduct(db, { supplierId: sup.id, skuId: skuA, patch: { min_order_qty: 50 }, operator: 'tester' })
  const rMoq = checkSupplyCatalog(db, { supplierId: sup.id, lines: [{ sku_id: skuA, qty: 20 }] })
  ok(rMoq.some((i) => i.code === 'BELOW_MOQ' && i.level === 'block'), '低于起订量 → block 级拦截')
  ok(checkSupplyCatalog(db, { supplierId: sup.id, lines: [{ sku_id: skuA, qty: 50 }] }).length === 0, '达到起订量即放行')
  const notReg = db
    .prepare('SELECT id FROM product_skus WHERE id NOT IN (SELECT sku_id FROM supplier_products WHERE supplier_id=?) LIMIT 1')
    .get(sup.id)
  ok(
    notReg ? checkSupplyCatalog(db, { supplierId: sup.id, lines: [{ sku_id: notReg.id, qty: 1 }] }).length === 0 : true,
    '未维护目录 → 不拦（「没登记」与「登记为不供」不是一回事）'
  )
  upsertSupplierProduct(db, { supplierId: sup.id, skuId: skuA, patch: { min_order_qty: 0 }, operator: 'tester' })

  // ---------------------------------------------------------------
  section('T3 请购单全链路（draft → submitted → approved → converted → closed）')
  const mkReq = (qty = 10, sku = skuA) =>
    createRequisition(db, {
      warehouseId: wh.id, supplierId: sup.id, reqDate: '2026-10-10',
      applicantType: 'org', applicantName: '测试部门', department: '供应链中心', purpose: '补货',
      actor, lines: [{ sku_id: sku, qty, price: resolvePurchasePrice(db, { skuId: sku, supplierId: sup.id }).price }]
    })
  const req1 = mkReq(12)
  ok(req1.status === 'draft', `新建请购单为草稿（${req1.doc_no}）`)
  ok(req1.total_amount > 0, `请购金额已汇总（${req1.total_amount}）`)
  throws(() => transitionRequisition(db, { id: req1.id, action: 'approve', actor }), 'TRANSITION_NOT_ALLOWED',
    '草稿不能直接审批（跳跃流转被内核拒）')
  transitionRequisition(db, { id: req1.id, action: 'submit', actor })
  ok(getRequisition(db, req1.id).status === 'submitted', '提交 → 待审批')
  transitionRequisition(db, { id: req1.id, action: 'approve', actor })
  const approved = getRequisition(db, req1.id)
  ok(approved.status === 'approved', '审批 → 已审批')
  ok(!!approved.approved_by_name && !!approved.approved_at, '审批人与审批时间已留痕')
  const out1 = convertRequisitionToOrder(db, { reqId: req1.id, actor, remark: '全量转单' })
  ok(out1.order_id > 0 && out1.remaining_lines === 0, `转采购订单成功（${out1.order_no}），无剩余可转行`)
  ok(getRequisition(db, req1.id).status === 'converted', '转单后 → 已转采购')
  const po1 = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(out1.order_id)
  ok(po1.source_type === 'requisition' && po1.source_req_id === req1.id, '采购订单带回请购来源（可反查）')
  ok(round2(po1.total_amount) === round2(approved.total_amount), '订单金额 = 请购金额（转单不悄悄改价）')
  transitionRequisition(db, { id: req1.id, action: 'close', actor })
  ok(getRequisition(db, req1.id).status === 'closed', '关闭 → 已关闭（终态）')

  // ---------------------------------------------------------------
  section('T4 请购部分转单（converted 不是终态）')
  const req2 = mkReq(10)
  transitionRequisition(db, { id: req2.id, action: 'submit', actor })
  transitionRequisition(db, { id: req2.id, action: 'approve', actor })
  const part = convertRequisitionToOrder(db, { reqId: req2.id, lines: [{ sku_id: skuA, qty: 4 }], actor, remark: '先转 4' })
  ok(part.converted_lines === 1 && part.remaining_lines === 1, '先转 4 件后仍有剩余可转行')
  ok(getRequisition(db, req2.id).status === 'converted', '部分转单后状态为已转采购（非终态）')
  const part2 = convertRequisitionToOrder(db, { reqId: req2.id, actor, remark: '补转剩余' })
  ok(part2.remaining_lines === 0, '补转后无剩余')
  const evs = db
    .prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PRQ' AND doc_id=? AND action='convert'")
    .get(req2.id).c
  ok(evs >= 2, `两次转单都在流转日志里留痕（${evs} 条），而不是只改状态`)
  throws(() => convertRequisitionToOrder(db, { reqId: req2.id, actor }), 'PRQ_NOTHING_TO_CONVERT',
    '全部转完后再次转单被拒')

  // ---------------------------------------------------------------
  section('T5 超量控制在写库之前拦（不是事后回滚）')
  const somePo = db
    .prepare(
      `SELECT o.id, o.over_receive_ratio, oi.sku_id, oi.qty, oi.received_qty
         FROM purchase_orders o JOIN purchase_order_items oi ON oi.order_id=o.id
        WHERE o.status NOT IN ('cancelled') AND oi.qty > 0 AND oi.received_qty + 1e-6 < oi.qty
        ORDER BY o.id LIMIT 1`
    )
    .get()
  ok(!!somePo, '存在可继续收货的采购订单行')
  if (somePo) {
    const ratio = Number(somePo.over_receive_ratio ?? 0.1)
    const allowed = Number(somePo.qty) * (1 + ratio)
    const overQty = allowed - Number(somePo.received_qty) + 1
    const issues = checkOverReceive(db, { orderId: somePo.id, lines: [{ sku_id: somePo.sku_id, qty: overQty }] })
    ok(issues.some((i) => i.code === 'OVER_RECEIVE' && i.level === 'block'),
      `超量被拦（订单 ${somePo.qty} × 上限 ${(ratio * 100).toFixed(0)}% → 允许 ${allowed.toFixed(2)}）`)
    const fine = checkOverReceive(db, { orderId: somePo.id, lines: [{ sku_id: somePo.sku_id, qty: Number(somePo.qty) - Number(somePo.received_qty) }] })
    ok(fine.length === 0, '未超上限的正常收货量放行')
    const notIn = checkOverReceive(db, { orderId: somePo.id, lines: [{ sku_id: -1, qty: 1 }] })
    ok(notIn.some((i) => i.code === 'NOT_IN_ORDER'), '订单外商品不能收货')
  }

  // ---------------------------------------------------------------
  section('T6 采购发票与三单匹配（发票量不得超入库量）')
  // 选一条**还有开票额度**的入库行。
  // 匹配是「供应商 + SKU」级累计口径（matchInvoiceToReceipts 把该供应商该 SKU 的全部入库
  // 与全部未作废已提交发票相加），所以不能随便取第一行 —— 种子数据可能已经把某个 SKU
  // 的入库量开满了（服装库就出现过），那样取到的行开票必然被正当拦下，
  // 测试会以一个「产品没错」的失败收场。这里显式挑「本次入库量 ≤ 剩余可开额度」的行。
  //
  // 并且**在全库范围内挑，而不是固定某一个供应商**：固定供应商时，只要该供应商的 SKU
  // 恰好都被开满，T6 整段就会被跳过（断言数骤降，看起来像测试自己坏了）。
  // 改成「按剩余额度从宽到窄」挑，额度最宽的那条最不容易被后续口径变化挤成 0。
  const rcLine = db
    .prepare(
      `SELECT * FROM (
         SELECT ri.sku_id, ri.qty, ri.price, r.supplier_id, r.id AS receipt_id,
                oi.id AS order_item_id, oi.order_id,
                (COALESCE((SELECT SUM(ri2.qty) FROM purchase_receipt_items ri2
                             JOIN purchase_receipts r2 ON r2.id=ri2.receipt_id
                            WHERE r2.supplier_id=r.supplier_id AND ri2.sku_id=ri.sku_id),0)
                 - COALESCE((SELECT SUM(ii2.qty) FROM purchase_invoice_items ii2
                               JOIN purchase_invoices i2 ON i2.id=ii2.invoice_id
                              WHERE i2.supplier_id=r.supplier_id AND ii2.sku_id=ri.sku_id
                                AND i2.status NOT IN ('voided','draft')),0)) AS room
           FROM purchase_receipt_items ri
           JOIN purchase_receipts r ON r.id=ri.receipt_id
           LEFT JOIN purchase_order_items oi ON oi.order_id=r.order_id AND oi.sku_id=ri.sku_id
          WHERE ri.qty > 0
       ) WHERE qty <= room
       ORDER BY room DESC, receipt_id LIMIT 1`
    )
    .get()
  ok(!!rcLine, `存在可开票的入库行（剩余可开额度 ${rcLine?.room ?? 0}）`)
  if (rcLine) {
    const inv = createInvoice(db, {
      invoiceNo: `TEST${Date.now()}`, invoiceType: 'vat_special', supplierId: rcLine.supplier_id,
      orderId: rcLine.order_id, taxRate: 13, actor,
      lines: [{ sku_id: rcLine.sku_id, qty: rcLine.qty, price: rcLine.price, order_item_id: rcLine.order_item_id }]
    })
    ok(inv.status === 'draft' && inv.total_amount > 0, `发票建单成功（${inv.doc_no}，含税 ${inv.total_amount}）`)
    transitionInvoice(db, { id: inv.id, action: 'submit', actor })
    transitionInvoice(db, { id: inv.id, action: 'verify', actor })
    const verified = getInvoice(db, inv.id)
    ok(verified.status === 'verified', '发票校验通过 → 已认证')
    ok((verified.remark || '').includes('三单匹配'), '校验时写入三单匹配结论（留痕）')
    transitionInvoice(db, { id: inv.id, action: 'post', actor })
    ok(getInvoice(db, inv.id).status === 'posted', '入账 → 已入账')

    // 超量开票必须被拦
    const bad = createInvoice(db, {
      invoiceNo: `BAD${Date.now()}`, invoiceType: 'vat_special', supplierId: rcLine.supplier_id,
      taxRate: 13, actor, lines: [{ sku_id: rcLine.sku_id, qty: 9999999, price: rcLine.price }]
    })
    transitionInvoice(db, { id: bad.id, action: 'submit', actor })
    throws(() => transitionInvoice(db, { id: bad.id, action: 'verify', actor }), 'PI_MATCH_FAILED',
      '开票数量超过已入库数量 → 校验被拒')
    const m = matchInvoiceToReceipts(db, bad.id)
    ok(m.blocking.length > 0 && m.lines[0].received >= 0, '匹配结果逐行给出「本票 / 已开 / 已入库」三个数')
    transitionInvoice(db, { id: bad.id, action: 'void', actor })
    ok(getInvoice(db, bad.id).status === 'voided', '作废掉测试用的错票（不留脏数据）')
  }

  // ---------------------------------------------------------------
  section('T7 三单结算：三种模式的金额算法与差异显性')
  // 「未被未作废结算单引用过」的入库单才算可结算 —— 与 buildSettlement 同一口径
  const OPEN_RC = `r.status IN ('received','inspected','closed') AND r.id NOT IN (
      SELECT si.source_id FROM purchase_settlement_items si
        JOIN purchase_settlements st ON st.id = si.settle_id
       WHERE si.source_type='receipt' AND st.status <> 'voided')`
  const openSup = db
    .prepare(`SELECT r.supplier_id sid, COUNT(*) c FROM purchase_receipts r WHERE ${OPEN_RC} GROUP BY r.supplier_id ORDER BY c DESC`)
    .all()
  // 有票（verified/posted 且未被结算占用）的供应商优先用于 auto / fee 模式
  const invCountOf = (sid) =>
    db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_invoices i
          WHERE i.supplier_id=? AND i.invoice_type<>'fee' AND i.status IN ('verified','posted')
            AND (i.settle_id IS NULL OR i.settle_id IN (SELECT id FROM purchase_settlements WHERE status='voided'))`
      )
      .get(sid).c
  const supA = openSup.find((x) => invCountOf(x.sid) > 0)
  const supFee = openSup.find((x) => x.sid !== supA?.sid)
  const supM = openSup.find((x) => x.sid !== supA?.sid && x.sid !== supFee?.sid)
  ok(!!supA, '存在「有未结算入库 + 有未结算发票」的供应商（auto 模式可测）')
  ok(!!supFee, '存在另一个有未结算入库的供应商（fee 模式可测）')
  ok(!!supM, '存在第三个有未结算入库的供应商（manual 模式可测）')
  if (supA && supFee && supM) {
    // ---- auto：有票按票，暂估差异必须显性落库 ----
    const auto = buildSettlement(db, {
      supplierId: supA.sid, periodStart: '2020-01-01', periodEnd: '2030-12-31', settleMode: 'auto', actor
    })
    ok(auto.invoice_count > 0, `auto 模式取到了已认证发票（${auto.invoice_count} 张）`)
    ok(round2(auto.settle_amount) === round2(auto.invoice_amount),
      `auto 有票按票结算（票 ${auto.invoice_amount} = 结算 ${auto.settle_amount}）`)
    ok(round2(auto.diff_amount) === round2(auto.receipt_amount - auto.invoice_amount),
      `暂估差异显性落库 diff_amount=${auto.diff_amount}（入库 ${auto.receipt_amount} − 票 ${auto.invoice_amount}，不隐藏）`)
    ok(auto.order_count > 0, `结算单带回涉及订单数（${auto.order_count}）`)

    // ---- fee：结算金额 = 普通发票 + 费用发票，且费用摊进入库成本 ----
    const feeInv = createInvoice(db, {
      invoiceNo: `FEE${Date.now()}`, invoiceType: 'fee', supplierId: supFee.sid,
      taxRate: 9, actor, lines: [{ qty: 1, price: 888, fee_type: '运费', tax_rate: 9 }]
    })
    transitionInvoice(db, { id: feeInv.id, action: 'submit', actor })
    transitionInvoice(db, { id: feeInv.id, action: 'verify', actor })
    const fee = buildSettlement(db, {
      supplierId: supFee.sid, periodStart: '2020-01-01', periodEnd: '2030-12-31', settleMode: 'fee', actor
    })
    ok(round2(fee.fee_amount) > 0, `fee 模式取到了费用发票（费用合计 ${fee.fee_amount}）`)
    ok(round2(fee.settle_amount) === round2(fee.invoice_amount + fee.fee_amount),
      `fee 模式结算 = 普通发票 + 费用发票（${fee.invoice_amount} + ${fee.fee_amount} = ${fee.settle_amount}）`)
    const feeItem = fee.items.find((x) => x.fee_amount > 0)
    ok(!!feeItem && feeItem.final_cost > 0,
      `费用已按金额占比摊进入库成本 final_cost（行 #${feeItem?.line_no}，摊 ${feeItem?.fee_amount}）`)
    // 发票可作废（verified → voided）：票开错了必须能撤
    transitionSettlement(db, { id: fee.id, action: 'void', actor })
    transitionInvoice(db, { id: feeInv.id, action: 'void', actor })
    ok(getInvoice(db, feeInv.id).status === 'voided', '已认证但未入账的发票可作废（verified → voided）')
    ok(getSettlement(db, fee.id).status === 'voided', '结算单可作废（作废后其占用的入库单与发票释放）')

    // ---- 一单一结：已被结算引用的入库单/发票不会重复进下一张结算单 ----
    const again = (() => {
      try {
        return buildSettlement(db, {
          supplierId: supA.sid, periodStart: '2020-01-01', periodEnd: '2030-12-31', settleMode: 'auto', actor
        })
      } catch (e) {
        return { thrown: e.code }
      }
    })()
    const reused = again.thrown
      ? again.thrown === 'PST_NOTHING'
      : again.items.every((x) => !x.source_id || true) && again.receipt_amount === 0
    ok(reused, `已结算过的入库单/发票不再进新结算单（不重复算应付），实测：${
      again.thrown ? again.thrown : `新单入库金额 ${again.receipt_amount}`
    }`)

    // ---- manual + 流转：draft → submitted → audited ----
    const manual = buildSettlement(db, {
      supplierId: supM.sid, periodStart: '2020-01-01', periodEnd: '2030-12-31', settleMode: 'manual', actor
    })
    ok(round2(manual.settle_amount) === round2(manual.receipt_amount),
      `manual 按入库暂估金额结算（${manual.settle_amount} = 入库 ${manual.receipt_amount}）`)

    const src = getSettlement(db, manual.id)
    throws(() => transitionSettlement(db, { id: src.id, action: 'audit', actor }), 'TRANSITION_NOT_ALLOWED',
      '草稿结算单不能直接审核')
    transitionSettlement(db, { id: src.id, action: 'submit', actor })
    transitionSettlement(db, { id: src.id, action: 'audit', actor })
    const audited = getSettlement(db, src.id)
    ok(audited.status === 'audited' && !!audited.audited_at, '提交 → 审核，审核人与时间留痕')
    ok(audited.open_amount === round2(audited.settle_amount - audited.paid_amount), '未结清金额口径 = 结算金额 − 已付金额')
    ok(audited.items.some((x) => x.source_type === 'receipt'), '结算明细保留入库来源（可反查是哪批货）')

    // ---------------------------------------------------------------
    section('T8 核销生效点 = 付款单审批通过（草稿不算已付）')
    const payAmount = round2(audited.open_amount * 0.4)
    const pay = createPayment(db, {
      supplierId: audited.supplier_id, payDate: '2026-10-14', payType: 'transfer', amount: payAmount,
      remark: '测试部分付款', actor, allocations: [{ settle_id: audited.id, amount: payAmount }]
    })
    ok(pay.status === 'draft', `付款单建单为草稿（${pay.doc_no}，核销明细已录）`)
    ok(pay.items.length === 1 && round2(pay.settled_amount) === payAmount, '核销明细已写入，付款单金额自洽')
    let st = getSettlement(db, audited.id)
    ok(round2(st.paid_amount) === round2(audited.paid_amount), '草稿付款单**不计入**结算单已付金额（钱还没付）')
    ok(round2(st.pending_amount) === payAmount, `未生效核销计划单独报出 pending_amount=${st.pending_amount}`)

    transitionPayment(db, { id: pay.id, action: 'submit', actor })
    st = getSettlement(db, audited.id)
    ok(round2(st.paid_amount) === round2(audited.paid_amount + payAmount),
      `提交审批 → 核销立即生效，已付金额 ${audited.paid_amount} → ${st.paid_amount}`)
    ok(st.status === 'audited', '未付足 → 结算单仍是已审核（不会提前结清）')

    // 作废 → 已付金额必须回退，否则会出现「付款单作废了、钱还算已付」
    transitionPayment(db, { id: pay.id, action: 'void', actor })
    st = getSettlement(db, audited.id)
    ok(round2(st.paid_amount) === round2(audited.paid_amount),
      `作废付款单 → 已付金额回退（${st.paid_amount}），不留幽灵核销`)

    // ---------------------------------------------------------------
    section('T9 作废保护：不能让已结清的结算单失血')
    const settled = db.prepare("SELECT * FROM purchase_settlements WHERE status='settled' ORDER BY id LIMIT 1").get()
    ok(!!settled, '存在已结清的结算单样本')
    if (settled) {
      const its = db
        .prepare(
          `SELECT it.settle_id, it.amount, p.id AS payment_id
             FROM purchase_payment_items it JOIN purchase_payments p ON p.id=it.payment_id
            WHERE it.settle_id=? AND p.status IN ('approved','paid') ORDER BY it.amount DESC LIMIT 1`
        )
        .get(settled.id)
      ok(!!its, '该结算单有生效中的核销明细')
      if (its) {
        throws(
          () => transitionPayment(db, { id: its.payment_id, action: 'void', actor }),
          'PAY_VOID_BREAKS_SETTLEMENT',
          '作废会让已结清结算单金额不足 → 被拦（提示先作废结算单）'
        )
      }
      const after = db.prepare('SELECT paid_amount, status FROM purchase_settlements WHERE id=?').get(settled.id)
      ok(after.status === 'settled' && round2(after.paid_amount) === round2(settled.paid_amount),
        '被拦之后结算单金额与状态都没被改动（拒绝是干净的）')
    }

    // 执行付款：核销 + 状态前进必须一起发生
    const pay2 = createPayment(db, {
      supplierId: audited.supplier_id, payDate: '2026-10-14', payType: 'transfer',
      amount: round2(getSettlement(db, audited.id).open_amount), remark: '测试全额付款', actor,
      allocations: [{ settle_id: audited.id, amount: round2(getSettlement(db, audited.id).open_amount) }]
    })
    transitionPayment(db, { id: pay2.id, action: 'submit', actor })
    transitionPayment(db, { id: pay2.id, action: 'pay', actor })
    const paidPay = getPayment(db, pay2.id)
    ok(paidPay.status === 'paid', `执行付款后付款单状态推进到「已付款」（不是停在已审批）`)
    ok(!!paidPay.paid_at, '实际付款时间已记录 paid_at（财务对账要答「钱哪天出的」）')
    const settledNow = getSettlement(db, audited.id)
    ok(settledNow.status === 'settled' && round2(settledNow.open_amount) === 0,
      '付足 → 结算单自动结清（open_amount=0）')
    // 只取**入库来源**的行去联采购订单。
    // 必须显式带 `si.source_type='receipt'`：结算明细按来源分两类，
    // `source_type='invoice'` 的行里 `source_id` 是**发票 id**，含义完全不同。
    // 少了这个条件，发票 id 会撞上同号的入库单 id，凭空联出一批「根本不在本结算单里」的订单，
    // 这些订单当然不会回写 paid_amount —— 断言就报出一个不存在的缺陷。
    // （产品侧 ordersOfSettlement / refreshOrderStats 都带了该条件，是这里漏了。）
    const poIds = db
      .prepare(
        `SELECT DISTINCT rc.order_id oid FROM purchase_settlement_items si
           JOIN purchase_receipts rc ON rc.id=si.source_id
          WHERE si.settle_id=? AND si.source_type='receipt' AND rc.order_id IS NOT NULL`
      )
      .all(audited.id)
      .map((r) => r.oid)
    ok(poIds.length > 0, `结算单能联到入库来源的采购订单（${poIds.length} 张）`)
    ok(poIds.every((id) => {
      const o = db.prepare('SELECT paid_amount FROM purchase_orders WHERE id=?').get(id)
      return Number(o.paid_amount) > 0
    }), `结算结清后采购订单已付金额同步回写（${poIds.length} 张订单）`)
  }

  // ---------------------------------------------------------------
  section('T10 四段关闭只进不退')
  const closedPo = db.prepare('SELECT * FROM purchase_orders WHERE close_arrival=1 ORDER BY id LIMIT 1').get()
  ok(!!closedPo, '存在「到货关闭」的采购订单')
  if (closedPo) {
    const before = closedPo.close_arrival
    // 强行制造一个「看起来不该关闭」的状态：把收货量清零再刷新
    db.prepare('UPDATE purchase_order_items SET received_qty=0 WHERE order_id=?').run(closedPo.id)
    refreshCloseFlags(db, closedPo.id)
    const after = db.prepare('SELECT close_arrival FROM purchase_orders WHERE id=?').get(closedPo.id)
    ok(after.close_arrival === before, '条件不再满足时关闭旗标也不会自动打开（单向）')
    ok(closedPo.close_inbound === 0 || closedPo.close_inbound === 1, '入库关闭旗标存在且为 0/1')
  }
  const anyPo = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 1').get()
  const flags = refreshCloseFlags(db, anyPo.id)
  ok(flags && ['close_arrival', 'close_inbound', 'close_invoice', 'close_payment'].every((k) => k in flags),
    '刷新返回四段关闭的完整结果（供界面展示）')

  // ---------------------------------------------------------------
  section('T11 账实一致：快照必须等于明细合计')
  const snapDiff = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_settlements s
        WHERE ABS(IFNULL(s.paid_amount,0) - IFNULL((
          SELECT SUM(it.amount) FROM purchase_payment_items it
            JOIN purchase_payments p ON p.id=it.payment_id
           WHERE it.settle_id=s.id AND p.status IN ('approved','paid')),0)) > 0.01`
    )
    .get().c
  ok(snapDiff === 0, `结算单 paid_amount 与生效核销明细逐单一致（差异 ${snapDiff} 条，应为 0）`)

  const payDiff = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_payments p
        WHERE ABS(IFNULL(p.settled_amount,0) - IFNULL((
          SELECT SUM(it.amount) FROM purchase_payment_items it WHERE it.payment_id=p.id),0)) > 0.01`
    )
    .get().c
  ok(payDiff === 0, `付款单 settled_amount 与自身核销明细一致（差异 ${payDiff} 条，应为 0）`)

  const overPay = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_settlements
        WHERE IFNULL(paid_amount,0) - IFNULL(settle_amount,0) > 0.01`
    )
    .get().c
  ok(overPay === 0, `没有「已付超过结算金额」的单据（${overPay} 条，应为 0）`)

  const badStatus = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_settlements
        WHERE status='settled' AND IFNULL(paid_amount,0) + 0.01 < IFNULL(settle_amount,0)`
    )
    .get().c
  ok(badStatus === 0, `没有「已结清但金额不足」的结算单（${badStatus} 条，应为 0）`)

  const draftPayEffect = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_payment_items it
         JOIN purchase_payments p ON p.id=it.payment_id
        WHERE p.status='draft'`
    )
    .get().c
  ok(draftPayEffect > 0, `草稿付款单上的核销计划确实存在（${draftPayEffect} 条）—— 且未被计入已付，见上一组断言`)

  // 付款计划 FIFO：按结算日期先后填
  const fifo = planAllocation(db, sup.id, 1000)
  const sortedOk = fifo.every((x, i) => {
    if (i === 0) return true
    const a = db.prepare('SELECT settle_date FROM purchase_settlements WHERE id=?').get(fifo[i - 1].settle_id)
    const b = db.prepare('SELECT settle_date FROM purchase_settlements WHERE id=?').get(x.settle_id)
    return a.settle_date <= b.settle_date
  })
  ok(fifo.length === 0 || sortedOk, 'FIFO 核销计划按结算日期先后排序（先老后新）')

  // ---------------------------------------------------------------
  section('T12 单据定义完整性（内核里真的有这些类型）')
  const t = db
    .prepare("SELECT code, name FROM doc_types WHERE code IN ('PRQ','PI','PST','PAY') ORDER BY code")
    .all()
  ok(t.length === 4, `请购/发票/结算/付款四个类型已注册（${t.map((x) => x.code).join(' / ')}）`)
  for (const [code, label] of [['PRQ', '请购单'], ['PI', '采购发票'], ['PST', '采购结算单'], ['PAY', '付款单']]) {
    const n = db.prepare('SELECT COUNT(*) c FROM doc_states WHERE doc_type=?').get(code).c
    const e = db.prepare('SELECT COUNT(*) c FROM doc_actions WHERE doc_type=?').get(code).c
    ok(n > 0 && e > 0, `${label}（${code}）有 ${n} 状态 / ${e} 条流转边`)
  }
  const flow = db.prepare("SELECT * FROM biz_flows WHERE code='FLOW_PURCHASE'").get()
  const steps = db.prepare('SELECT COUNT(*) c FROM biz_flow_steps WHERE flow_code=?').get('FLOW_PURCHASE').c
  // 环节数 9 → 10：模块 07 把「到货」与「质检」拆成两张单之后，
  // 主流程里多出一个质量检验环节，位置在「到货收货」与「库存过账」之间。
  ok(steps === 10, `采购业务流 10 环节（实测 ${steps}）`)
  const kinds = db
    .prepare('SELECT node_type, COUNT(*) c FROM biz_flow_steps WHERE flow_code=? GROUP BY node_type')
    .all('FLOW_PURCHASE')
  ok(kinds.length >= 1 && new Set(kinds.map((k) => k.node_type)).size >= 1,
    `环节节点带类型（${kinds.map((k) => `${k.node_type}×${k.c}`).join(' ')}）`)
  ok((flow.remark || '').includes('请购'), '业务流的说明与十环节口径一致（含请购起点）')
  // 质检环节必须在流里，且排在到货之后、过账之前 —— 这是「两单分开」的承重墙。
  const inspectStep = db
    .prepare("SELECT seq, node_type, doc_type FROM biz_flow_steps WHERE flow_code='FLOW_PURCHASE' AND node_type='inspect'")
    .get()
  const recvStep = db
    .prepare("SELECT seq FROM biz_flow_steps WHERE flow_code='FLOW_PURCHASE' AND node_type='receipt'")
    .get()
  const inboundStep = db
    .prepare("SELECT seq FROM biz_flow_steps WHERE flow_code='FLOW_PURCHASE' AND node_type='inbound'")
    .get()
  ok(inspectStep && inspectStep.doc_type === 'INS',
    `质检环节挂在质检单（INS）上（${inspectStep ? inspectStep.doc_type : '缺失'}）`)
  ok(inspectStep && recvStep && inboundStep && recvStep.seq < inspectStep.seq && inspectStep.seq < inboundStep.seq,
    '质检环节压在到货之后、过账之前')
  const permNames = db
    .prepare("SELECT COUNT(*) c FROM permissions WHERE code LIKE 'purchase.%' AND name LIKE '%' AND name <> code")
    .get().c
  ok(permNames >= 13, `采购权限点有中文名而不是裸露 code（${permNames} 个）`)

  // ---------------------------------------------------------------
  section('T13 发票明细必须挂得上订单行')
  // 明细行的 order_item_id 是发票与采购订单之间**唯一**的关联。
  // 曾经 seed 造发票时不带它：发票本身一切正常，但订单上的「已开票金额」恒为 0、
  // 「开票关闭」永远不成立 —— 界面上完全看不出哪里错了，只是这个功能悄悄死掉。
  const invLines = db.prepare('SELECT COUNT(*) c, COUNT(order_item_id) w FROM purchase_invoice_items').get()
  ok(invLines.w > 0, `开票明细带订单行关联（${invLines.w} / ${invLines.c} 行）`)

  const orphan = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_invoices i
        WHERE i.invoice_type <> 'fee' AND i.status NOT IN ('draft','voided')
          AND NOT EXISTS (SELECT 1 FROM purchase_invoice_items ii
                           WHERE ii.invoice_id=i.id AND ii.order_item_id IS NOT NULL)`
    )
    .get().c
  ok(orphan === 0, `无「已提交/已审核却没挂订单行」的发票（${orphan} 张）`)

  const invoiced = db
    .prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status<>'cancelled' AND invoice_amount > 0.01")
    .get().c
  ok(invoiced >= 1, `至少有一张订单回写到「已开票金额」（${invoiced} 张）`)

  const closeInvoice = db
    .prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status<>'cancelled' AND close_invoice=1")
    .get().c
  ok(closeInvoice >= 1, `至少有一张订单走到「开票关闭」（${closeInvoice} 张）`)

  const closeInbound = db
    .prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status<>'cancelled' AND close_inbound=1")
    .get().c
  ok(closeInbound >= 1, `至少有一张订单走到「入库关闭」（收货单质检 + 关闭）（${closeInbound} 张）`)

  const fullyClosed = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_orders WHERE status<>'cancelled'
        AND close_arrival=1 AND close_inbound=1 AND close_invoice=1 AND close_payment=1`
    )
    .get().c
  ok(fullyClosed >= 1, `至少有一张订单四段全关（否则「四段闭环率」恒为 0，指标形同没有）（${fullyClosed} 张）`)

  // 关闭标记与推导依据不得互相矛盾：close_invoice=1 就必须真的开满了票。
  // 「只进不退」的单向性有个前提 —— 上游证据不能在上游被清空时被偷偷抹掉，
  // 否则标记会指着一个已经不存在的依据说「关过了」。这是四段关闭最容易烂掉的地方。
  const flagLie = db
    .prepare(
      `SELECT COUNT(*) c FROM purchase_orders
        WHERE status <> 'cancelled'
          AND ((close_invoice=1 AND invoice_amount + 0.01 < total_amount)
            OR (close_payment=1 AND (settle_amount <= 0 OR paid_amount + 0.01 < settle_amount)))`
    )
    .get().c
  ok(flagLie === 0, `没有「标记说关过了、金额说没关」的自相矛盾订单（${flagLie} 张）`)
})

console.log('\n' + '─'.repeat(64))
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail === 0) console.log('全部通过')
process.exit(fail === 0 ? 0 : 1)
