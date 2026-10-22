/**
 * ============================================================================
 * 文件标识：server/db/procure-seed.js ｜ 采购域演示数据（模块 07）
 * ============================================================================
 * 【职责】采购域演示数据（模块 07）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 采购域演示数据（模块 07）
//
// 放在 seedAll 之后独立跑，原因与 oc-seed 相同：
//   ① 依赖已经在库里的采购订单与收货单（由 seed.js 造），必须在它们之后；
//   ② 单独一份文件方便按行业调整数量，而不用改动 1700 行的主 seed。
//
// 行业无关写法：三个行业的供应商数量、SKU 规模、单价量级都不同，
// 所以这里**一律按「取前 N 个」「按目标金额倒推数量」来造**，不写死具体编码与数字。
// —— oc-seed 踩过这个坑：写死某个行业的编码，另外两个行业一个下游都建不出来。

import { requireDemoDatabase } from './runtime-policy.js'
import {
  createRequisition, convertRequisitionToOrder, transitionRequisition,
  createInvoice, transitionInvoice,
  buildSettlement, transitionSettlement,
  createPayment, transitionPayment,
  refreshOrderStats, refreshCloseFlags, upsertSupplierProduct
} from '../lib/purchase.js'
import { applyStockOut } from '../lib/stock.js'
import { applyTransition, pruneOrphanEvents } from '../lib/docflow.js'
import { createInspection, submitInspection, getInspection } from '../lib/qc.js'
import { format } from 'node:util'
import { seedNow } from './seed-clock.js'
import { resetSequences } from './seq.js'

// ---------------------------------------------------------------------------
// 行业参数：只声明「数量与量级」，不声明具体编码
// ---------------------------------------------------------------------------
export const PROFILES = {
  // 餐饮：生鲜短保、供应商多、请购频繁（门店零星自采的典型场景）
  food: {
    label: '连锁餐饮版',
    catalogSuppliers: 8,        // 维护供货目录的供应商数
    catalogSkusPer: 14,         // 每个供应商维护几个商品
    requisitions: 16,
    invoiceSuppliers: 6,        // 从这几个供应商的入库造发票
    settleSuppliers: 5,
    payments: 4,
    targetOrderAmount: [20000, 60000]   // 请购单目标金额区间（餐饮单价低）
  },
  // 美妆：单价高、经销商渠道为主，请购量少但金额大
  cosmetic: {
    label: '美妆连锁版',
    catalogSuppliers: 8,
    catalogSkusPer: 12,
    requisitions: 12,
    invoiceSuppliers: 6,
    settleSuppliers: 5,
    payments: 4,
    targetOrderAmount: [40000, 120000]
  },
  // 服装：SKU 多、季节性强
  apparel: {
    label: '服装行业（暂缓）',
    catalogSuppliers: 8,
    catalogSkusPer: 12,
    requisitions: 12,
    invoiceSuppliers: 6,
    settleSuppliers: 5,
    payments: 4,
    targetOrderAmount: [30000, 90000]
  }
}

// 确定性伪随机：演示数据必须**每次重建都一样**，否则测试断言与截图会对不上
function makeRng(seed = 20261015) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10)
const dayAgo = (n) => ymd(new Date(seedNow().getTime() - n * 86400000))
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export function seedProcurement(db, { industry = 'food', silent = false, log } = {}) {
  requireDemoDatabase(db)
  const P = PROFILES[industry] || PROFILES.food
  const say = silent
    ? () => {}
    : log || ((fmt, ...a) => console.log(`[procure:${industry}] ${format(fmt, ...a)}`))
  const rng = makeRng(20261015 + industry.length * 7919)
  const pick = (arr, n) => {
    const copy = [...arr]
    const out = []
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0])
    return out
  }
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1))

  const tx = db.transaction(() => {
    // ---------- 0. 幂等清空 ----------
    // 先清子表再清主表（外键顺序），否则 migrate 建的 ON DELETE CASCADE 也会先报约束错
    const ownedTables = [
      'purchase_payment_items', 'purchase_payments',
      'purchase_settlement_items', 'purchase_settlements',
      'purchase_invoice_items', 'purchase_invoices',
      'purchase_requisition_items', 'purchase_requisitions',
      'supplier_price_logs', 'supplier_products'
    ]
    for (const t of ownedTables) {
      db.exec(`DELETE FROM ${t}`)
    }
    // DELETE 不重置自增序列：采购请购行的 id 会一轮一轮往上长，而它被写进
    // purchase_order_items.remark（"请购行 #15973"），整库因此不可复现。清完表重置序列。
    resetSequences(db, ownedTables)

    // 上游（发票 / 结算 / 付款）刚被清空，可订单上的三个金额快照与「开票关闭 / 付款关闭」标记
    // 全都是**从它们推导**出来的。只清上游、不重置派生字段，就会留下
    // 「close_invoice=1 但已开票金额=0」这种自相矛盾；而且因为关闭标记是「只进不退」，
    // 这个矛盾会被永久保留 —— 越跑越脏，且界面上完全看不出哪里错了。
    // 结论：派生字段必须跟着它的推导依据一起归零。
    //
    // 到货 / 入库两段不动：它们推导自订单行的已收量与收货单状态，这两样第 0 步没清。
    db.exec(
      `UPDATE purchase_orders
          SET invoice_amount=0, settle_amount=0, paid_amount=0,
              close_invoice=0, close_payment=0, updated_at=datetime('now','localtime')
        WHERE status <> 'cancelled'`
    )
    // 请购转单会产生新采购订单，重跑时会累积 —— 先删掉上一次由请购单转出来的。
    //
    // 但**不能直接删**：这些订单上可能已经收过货（冒烟测试、人工点过就会），
    // 而收货已经把货记进库存了。只删单据会让库存凭空多一批、第二次启动还会撞外键
    // （purchase_receipts.order_id → purchase_orders.id）。所以先按批次反向出库，
    // 把现存量 / 批次 / 流水三者一起退回去，再删单据 —— 顺序错了就是账实不符。
    const reqOrders = db
      .prepare("SELECT id FROM purchase_orders WHERE source_type='requisition' AND source_req_id IS NOT NULL")
      .all()
      .map((r) => r.id)
    if (reqOrders.length) {
      const ids = reqOrders.join(',')
      const receipts = db.prepare(`SELECT * FROM purchase_receipts WHERE order_id IN (${ids})`).all()
      let rolledBack = 0
      for (const rc of receipts) {
        const items = db.prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=?').all(rc.id)
        for (const it of items) {
          if (!(Number(it.qty) > 0)) continue
          try {
            applyStockOut(db, {
              warehouseId: rc.warehouse_id,
              skuId: it.sku_id,
              batchNo: it.batch_no || '',
              qty: Number(it.qty),
              unitCost: Number(it.price || 0),
              docType: 'PUR_IN_REV',
              docNo: rc.doc_no,
              remark: '演示数据重建：回滚请购转单产生的收货'
            })
            rolledBack += 1
          } catch (e) {
            // 货可能已被下游消耗掉（演示环境共用库存），此时退不回去。
            // 种子数据宁可少退也不要中断整个灌数 —— 但要留下痕迹，不要静默吞掉。
            say('回滚收货失败（跳过）：%s %s', rc.doc_no, e.message)
          }
        }
      }
      if (rolledBack) say('回滚请购转单收货 %d 行（含库存）', rolledBack)
      db.prepare(
        `DELETE FROM purchase_receipt_items WHERE receipt_id IN (SELECT id FROM purchase_receipts WHERE order_id IN (${ids}))`
      ).run()
      db.prepare(`DELETE FROM purchase_receipts WHERE order_id IN (${ids})`).run()
      db.prepare(`DELETE FROM purchase_order_items WHERE order_id IN (${ids})`).run()
      db.prepare(`DELETE FROM purchase_orders WHERE id IN (${ids})`).run()
    }

    // 质检单引用到货单 id，而整库重建时到货单是被 DROP 后重建的（id 会被**复用**），
    // 于是上一轮的质检单看起来仍然「指向一张存在的到货单」，单靠 receipt_id 查不出问题。
    // 所以判据是**快照单号**：质检单落库时把到货单号存进了 receipt_no，
    // 现在到货单号对不上，就说明这张质检单记的不是这票货 —— 它是上一轮的历史。
    //
    // 必须清掉的原因：
    //   · 留着会撞 uq_inspection_receipt（「一张到货单只有一张质检单」），
    //     新到货单永远建不出质检单，而错误只在带 try/catch 的调用处被吞掉；
    //   · 它引用的那批货早已不在库里，结论本身也没有意义。
    //
    // 关键：**只清对不上的**。快照单号一致的质检单一律保留 ——
    // 保留下来的质检单是下面「跳过重检」的依据；如果无差别清空，
    // 每跑一次 seed 就会重新判退一次，退货出库会一次次叠加着扣库存。
    const orphanQc = db
      .prepare(
        `DELETE FROM purchase_inspections
          WHERE NOT EXISTS (
            SELECT 1 FROM purchase_receipts rc
             WHERE rc.id = purchase_inspections.receipt_id
               AND purchase_inspections.receipt_no IS NOT NULL
               AND purchase_inspections.receipt_no = rc.doc_no
          )`
      )
      .run().changes
    if (orphanQc) say('清理失效质检单 %d 张（到货单已重建或已不存在）', orphanQc)

    // 成本调整单引用结算单 id，而本函数上面刚把结算单整表清空（第 0 步）——
    // 于是上一轮的调整单看起来仍然「指向一张存在的结算单」，按 settle_id 查不出孤儿。
    // 留着它的后果是：暂估差异那一栏永远显示「已调整」，而这一期的差异其实还没处理，
    // 界面上没有任何地方会报错，只是差异被静默丢掉了。
    // 判据用**快照单号**（settle_no），与质检单同一思路；手工调整单（settle_id 为空）一律保留。
    try {
      // 删单之前必须先把「确认调整」已经造成的成本后果退回去，否则会留下无源差异：
      //   结存金额被改过（+回写金额）、成本台账多了 adj 行、留痕还在 ——
      //   而单没了。三层恒等式从此永远差一块（实测 +1504.9），结转被残差挡死。
      // 退法：按 id **倒序**（同一批次被连续调整时，最新的 amount_before 就是上一张的
      // amount_after，倒序退最终回到最初值）；只退「确认调整后没再被动过」的行
      // （当前金额 ≈ amount_after），被动过的留着 —— 台账与审计会把差异亮出来，不静默。
      const orphanHeads = db
        .prepare(
          `SELECT a.id, a.doc_no FROM cost_adjustments a
            WHERE a.settle_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM purchase_settlements s
                 WHERE s.id = a.settle_id AND a.settle_no IS NOT NULL AND a.settle_no = s.doc_no
              )
            ORDER BY a.id DESC`
        )
        .all()
      let revertedRows = 0
      for (const h of orphanHeads) {
        for (const it of db.prepare('SELECT * FROM cost_adjustment_items WHERE adjustment_id=?').all(h.id)) {
          const changed = db
            .prepare(
              `UPDATE inventory_stocks SET cost_amount=?, cost_price=?, updated_at=datetime('now','localtime')
                WHERE warehouse_id=? AND sku_id=? AND batch_no=?
                  AND ABS(COALESCE(cost_amount,0) - ?) <= 0.05`
            )
            .run(it.amount_before ?? 0, it.unit_before ?? 0, it.warehouse_id, it.sku_id, it.batch_no || '', it.amount_after ?? 0)
          revertedRows += changed.changes
        }
        db.prepare("DELETE FROM stock_cost_ledger WHERE doc_type='CA' AND doc_no=?").run(h.doc_no)
        db.prepare("DELETE FROM doc_events WHERE doc_type='CA' AND doc_id=?").run(h.id)
      }
      const orphanAdj = db
        .prepare(
          `DELETE FROM cost_adjustment_items
            WHERE adjustment_id IN (
              SELECT a.id FROM cost_adjustments a
               WHERE a.settle_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM purchase_settlements s
                    WHERE s.id = a.settle_id
                      AND a.settle_no IS NOT NULL
                      AND a.settle_no = s.doc_no
                 )
            )`
        )
        .run().changes
      const orphanAdjHead = db
        .prepare(
          `DELETE FROM cost_adjustments
            WHERE settle_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM purchase_settlements s
                 WHERE s.id = cost_adjustments.settle_id
                   AND cost_adjustments.settle_no IS NOT NULL
                   AND cost_adjustments.settle_no = s.doc_no
              )`
        )
        .run().changes
      if (orphanAdjHead) say('清理失效成本调整单 %d 张（连带 %d 行，回退 %d 行结存金额与台账）', orphanAdjHead, orphanAdj, revertedRows)
    } catch (e) {
      // 017 迁移尚未执行时表还不存在 —— 跳过而不是让整个采购灌数失败
      if (!/no such table/i.test(e.message)) throw e
    }

    // ---------- 0b. 留痕对账 ----------
    // 上面清了一批单据（整表清空的 请购/发票/结算/付款，以及按需求单删掉的采购订单与到货单），
    // 它们的流转留痕还留在 doc_events 里。doc_events 是跨表的旁支表，行按 (doc_type, doc_id)
    // 指向各自的主表，而主表自增 id 会被**复用** —— 留着旧留痕，下面新建出来的单据就会
    // 「继承」上一张单的历史（时间线里凭空多出「已审批」「已结算」）。
    //
    // 必须**在这里**对账，不能等到全流程跑完：本函数是幂等的、每次服务启动都会跑，
    // 等结尾再清就来不及了 —— 新单已经复用了旧 id，留痕已经被它「认领」，届时按 id 查不出孤儿。
    const pruned = pruneOrphanEvents(db).removed
    if (pruned) say('清理孤儿流转留痕 %d 条（主表已重建，留痕还指着旧 id）', pruned)

    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY id').all()
    const skus = db
      .prepare(
        `SELECT s.id, s.sku_code, s.name, s.cost_std, p.cost_std AS p_cost_std, p.unit, p.name AS product_name
           FROM product_skus s JOIN products p ON p.id = s.product_id
          WHERE s.status IS NULL OR s.status='active'
          ORDER BY s.id`
      )
      .all()
    if (!suppliers.length || !skus.length) {
      say('缺少供应商或商品，跳过')
      return { skipped: true }
    }

    // ---------- 1. 供货目录 + 协议价 ----------
    // 协议价 = 标准成本 × (0.88 ~ 1.06)：不写死数字，跟着商品的成本走
    let catalog = 0
    const catalogSuppliers = pick(suppliers, Math.min(P.catalogSuppliers, suppliers.length))
    catalogSuppliers.forEach((sup, si) => {
      const start = (si * 7) % Math.max(1, skus.length - P.catalogSkusPer)
      const slice = skus.slice(start, start + P.catalogSkusPer)
      slice.forEach((sk) => {
        const base = Number(sk.cost_std || sk.p_cost_std || 10) || 10
        const factor = 0.88 + (si % 5) * 0.045
        upsertSupplierProduct(db, {
          supplierId: sup.id,
          skuId: sk.id,
          patch: {
            is_available: 1,
            price: round2(base * factor),
            currency: 'CNY',
            min_order_qty: [0, 5, 10, 20][si % 4],
            lead_time_days: [1, 2, 3, 5][si % 4],
            valid_from: dayAgo(90),
            valid_to: null,
            remark: `协议价（${P.label}·演示）`
          },
          operator: '演示数据'
        })
        catalog += 1
      })
      // 每个供应商再登记一条「明确不供」的商品：验证供货目录的拦截分支真的会被触发
      const blocked = skus[(si * 13 + 5) % skus.length]
      if (blocked) {
        upsertSupplierProduct(db, {
          supplierId: sup.id,
          skuId: blocked.id,
          patch: { is_available: 0, remark: '目录外商品（演示：不供此料）' },
          operator: '演示数据'
        })
        catalog += 1
      }
    })
    say('供货目录 %d 条（%d 个供应商）', catalog, catalogSuppliers.length)

    // ---------- 2. 请购单 ----------
    const warehouses = db.prepare("SELECT * FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id").all()
    const mainWh = warehouses[0] || db.prepare('SELECT * FROM warehouses ORDER BY id').get()
    const stores = db.prepare('SELECT * FROM stores ORDER BY id').all()
    const applicants = [
      { type: 'org', id: null, name: '采购部', dept: '供应链中心', purpose: '补货' },
      { type: 'org', id: null, name: '生产计划部', dept: '制造中心', purpose: '生产备料' },
      { type: 'org', id: null, name: '市场部', dept: '市场中心', purpose: '新品' },
      { type: 'org', id: null, name: '行政部', dept: '综合管理', purpose: '工程' }
    ]
    const storeApplicants = stores.slice(0, Math.min(4, stores.length)).map((s) => ({
      type: 'store', id: s.id, name: s.name, dept: s.region || null, purpose: '门店自采'
    }))
    const allApplicants = [...applicants, ...storeApplicants]

    // 状态分布：让 7 个状态都有样本，界面上的每个 Tab 都不空
    const STATUS_PLAN = [
      'draft', 'draft',
      'submitted', 'submitted', 'submitted',
      'approved', 'approved',
      'converted', 'converted', 'converted',
      'closed',
      'rejected',
      'cancelled', 'cancelled',
      'submitted', 'approved', 'draft', 'converted'
    ]

    let requisitions = 0
    const convertedReqs = []
    for (let i = 0; i < P.requisitions; i++) {
      const want = STATUS_PLAN[i % STATUS_PLAN.length]
      const ap = allApplicants[i % allApplicants.length]
      const sup = catalogSuppliers[i % catalogSuppliers.length]
      const coreSkus = skus.filter((s) => {
        const row = db
          .prepare('SELECT is_available, price FROM supplier_products WHERE supplier_id=? AND sku_id=?')
          .get(sup.id, s.id)
        return row && row.is_available
      })
      if (!coreSkus.length) continue
      const lineCount = ri(2, 5)
      const chosen = pick(coreSkus, Math.min(lineCount, coreSkus.length))
      const target = ri(P.targetOrderAmount[0], P.targetOrderAmount[1])
      const perLine = target / chosen.length
      const lines = chosen.map((sk) => {
        const sp = db
          .prepare('SELECT price, min_order_qty FROM supplier_products WHERE supplier_id=? AND sku_id=?')
          .get(sup.id, sk.id)
        const price = Number(sp?.price || sk.cost_std || 10)
        // 按目标金额倒推数量：三个行业的单价差一个量级，写死数量会让金额失真。
        // 但**不得低于起订量** —— 转单时 MOQ 是硬拦截（block 级），
        // 演示数据若造出 10 件而协议起订 20 件，转单会被正当地挡回来。
        const moq = Number(sp?.min_order_qty || 1) || 1
        const qty = Math.max(moq, Math.max(1, Math.round(perLine / price)))
        return { sku_id: sk.id, qty, price }
      })
      const reqDate = dayAgo(ri(3, 45))
      const rec = createRequisition(db, {
        orgId: ap.type === 'store' ? null : null,
        warehouseId: mainWh.id,
        supplierId: sup.id,
        reqDate,
        expectDate: dayAgo(ri(-10, -1)),
        applicantType: ap.type,
        applicantId: ap.id,
        applicantName: ap.name,
        department: ap.dept,
        purpose: ap.purpose,
        urgency: ['normal', 'normal', 'high', 'low'][i % 4],
        tradeType: ap.type === 'store' ? 'store' : 'normal',
        source: ap.type === 'store' ? 'pos' : 'manual',
        sourceRef: ap.type === 'store' ? `${ap.name}·盘点缺口` : null,
        remark: `演示请购单 ${i + 1}`,
        actor: { id: null, name: ap.name },
        lines
      })
      requisitions += 1

      // 推进到目标状态（严格按状态机的边推，不直接改 status）
      const step = (id, action, extra = {}) =>
        transitionRequisition(db, { id, action, actor: { name: extra.by || '演示数据' }, remark: extra.remark || null, source: 'seed' })

      if (want === 'draft') continue
      step(rec.id, 'submit')
      if (want === 'submitted') continue
      if (want === 'rejected') {
        step(rec.id, 'reject', { remark: '预算不足，暂缓采购' })
        continue
      }
      if (want === 'cancelled') {
        step(rec.id, 'cancel', { remark: '需求取消' })
        continue
      }
      step(rec.id, 'approve')
      if (want === 'approved') continue
      // converted / closed：真的转出采购订单，而不是只把状态改掉
      const out = convertRequisitionToOrder(db, {
        reqId: rec.id,
        supplierId: sup.id,
        warehouseId: mainWh.id,
        actor: { name: '采购员' },
        remark: '演示自动转单'
      })
      convertedReqs.push({ req_id: rec.id, order_id: out.order_id, order_no: out.order_no })
      if (want === 'closed') {
        step(rec.id, 'close', { remark: '已全部转单并关闭' })
      }
    }
    say('请购单 %d 张（其中转单 %d 张）', requisitions, convertedReqs.length)

    // ---------- 3. 采购发票（从已入库但未开票的行生成） ----------
    let invoices = 0
    const invSuppliers = pick(suppliers, Math.min(P.invoiceSuppliers, suppliers.length))
    const INV_STATUS_PLAN = ['posted', 'verified', 'submitted', 'posted', 'draft', 'verified', 'posted', 'submitted']
    invSuppliers.forEach((sup, si) => {
      // 该供应商已入库、未开票的行（与路由 /invoices-available-lines 同一口径）
      //
      // order_item_id 必须取 —— 这是发票明细与采购订单行**唯一**的关联。
      // 少了它，订单上的「已开票金额」恒为 0、四段关闭里的「开票关闭」永远不成立，
      // 而界面上又看不出哪里错了（发票本身一切正常，只是挂不上订单）。
      //
      // ⚠️ 必须**按订单行**归集（GROUP BY rc.order_id, ri.sku_id），不能按 sku_id 汇总：
      //   按 sku 汇总时 recv_qty 是"该供应商该商品的全部入库"，而 order_item_id 又只能挂到
      //   其中一张订单上 —— 于是发票行变成"挂 A 单、用 A+B 两单的入库量"。
      //   这正是采购发票三单匹配要修的那个缺陷（P1-5：A 单入 100 却能为 A 开 200 的票），
      //   种子数据不能自己先造出反例。
      const rows = db
        .prepare(
          `SELECT ri.sku_id, rc.order_id, SUM(ri.qty) recv_qty, SUM(ri.amount) recv_amount,
                  (SELECT oi.id FROM purchase_order_items oi
                     WHERE oi.order_id=rc.order_id AND oi.sku_id=ri.sku_id LIMIT 1) order_item_id
             FROM purchase_receipt_items ri
             JOIN purchase_receipts rc ON rc.id=ri.receipt_id
             LEFT JOIN product_skus s ON s.id=ri.sku_id
            WHERE rc.supplier_id=?
            GROUP BY rc.order_id, ri.sku_id
            ORDER BY s.sku_code, rc.order_id`
        )
        .all(sup.id)
      if (!rows.length) return
      const want = INV_STATUS_PLAN[si % INV_STATUS_PLAN.length]
      const take = rows.slice(0, ri(2, 5))
      const lines = take.map((x) => ({
        sku_id: x.sku_id,
        qty: round2(x.recv_qty),
        price: Number(x.recv_qty) > 0 ? round2(Number(x.recv_amount) / Number(x.recv_qty)) : 0,
        tax_rate: 13,
        order_item_id: x.order_item_id || null
      }))
      const inv = createInvoice(db, {
        invoiceNo: `INV${ymd(seedNow()).replace(/-/g, '')}${String(si + 1).padStart(3, '0')}`,
        invoiceType: 'vat_special',
        supplierId: sup.id,
        invoiceDate: dayAgo(ri(2, 30)),
        taxRate: 13,
        remark: `演示采购发票（${sup.name}）`,
        actor: { name: '采购员' },
        lines
      })
      invoices += 1
      if (want === 'draft') return
      transitionInvoice(db, { id: inv.id, action: 'submit', actor: { name: '采购员' }, source: 'seed' })
      if (want === 'submitted') return
      transitionInvoice(db, { id: inv.id, action: 'verify', actor: { name: '财务·审核' }, source: 'seed' })
      if (want === 'posted') {
        transitionInvoice(db, { id: inv.id, action: 'post', actor: { name: '财务·入账' }, source: 'seed' })
      }
    })
    say('采购发票 %d 张', invoices)

    // ---------- 4. 费用发票 + 5. 采购结算 ----------
    // 费用发票（三单结算里的「费用折扣」那一单）与「费用结算」绑定同一个供应商：
    // final_cost 把运费摊进入库成本，这条链路必须每个行业都有得演示 ——
    // 之前写死「第一个可结算供应商」，餐饮版的第一个供应商恰好无可结算单据，
    // 于是整条「暂估差异回写」链路在餐饮库里是空的（界面上待办为 0，模块等于没做）。
    // 改为：逐个供应商试，**第一个结算成功的**用费用模式（发票也只给这家开）。
    let settlements = 0
    let feeDone = false
    let feeInvoices = 0
    const settleTargets = invSuppliers.slice(0, P.settleSuppliers)
    const SETTLE_PLAN = ['audited', 'audited', 'audited', 'audited', 'submitted']
    for (let i = 0; i < settleTargets.length; i++) {
      const sup = settleTargets[i]
      const mode = !feeDone ? 'fee' : i === 1 ? 'auto' : 'manual'
      if (mode === 'fee') {
        const fee = createInvoice(db, {
          invoiceNo: `FEE${ymd(seedNow()).replace(/-/g, '')}${String(feeInvoices + 1).padStart(3, '0')}`,
          invoiceType: 'fee',
          supplierId: sup.id,
          invoiceDate: dayAgo(ri(2, 20)),
          taxRate: 9,
          remark: '费用发票（运费 · 演示）',
          actor: { name: '财务' },
          lines: [
            { qty: 1, price: 1200, fee_type: '运费', tax_rate: 9 },
            { qty: 1, price: 360, fee_type: '卸货费', tax_rate: 9 }
          ]
        })
        transitionInvoice(db, { id: fee.id, action: 'submit', actor: { name: '财务' }, source: 'seed' })
        transitionInvoice(db, { id: fee.id, action: 'verify', actor: { name: '财务' }, source: 'seed' })
        feeInvoices += 1
        invoices += 1
      }
      let st
      try {
        st = buildSettlement(db, {
          supplierId: sup.id,
          settleDate: dayAgo(ri(1, 20)),
          periodStart: dayAgo(120),
          periodEnd: ymd(seedNow()),
          settleMode: mode,
          remark: `演示结算（${mode === 'fee' ? '费用折扣' : mode === 'auto' ? '自动' : '手工'}）`,
          actor: { name: '财务' }
        })
      } catch {
        // 该供应商无可结算单据，跳过（不同行业入库分布不同）。
        // 费用模式没成的话下一家继续试 —— 费用发票留在库里不影响其它结算
        continue
      }
      if (mode === 'fee') feeDone = true
      settlements += 1
      const want = SETTLE_PLAN[i % SETTLE_PLAN.length]
      if (want === 'draft') continue
      transitionSettlement(db, { id: st.id, action: 'submit', actor: { name: '财务' }, source: 'seed' })
      if (want === 'submitted') continue
      transitionSettlement(db, { id: st.id, action: 'audit', actor: { name: '财务主管' }, source: 'seed' })
      if (want === 'audited') continue
      // settled 通过付款核销达成，见下一步
    }
    say('采购结算 %d 张（含费用折扣 %d 张）', settlements, feeDone ? 1 : 0)

    // ---------- 6. 付款单 ----------
    // 四种状态各造一张，把「核销生效线」画清楚：
    //   paid     = 已审批 + 出纳已执行 → 核销生效
    //   approved = 已审批但钱还没出   → 核销已生效（用友口径：审核即核销）
    //   draft    = 核销明细已录但未提交 → **不计入**已付金额
    //   voided   = 作废 → 已付金额自动回退
    let payments = 0
    const PAY_PLAN = [
      { ratio: 1, exec: 'paid', payType: 'transfer', note: '全额付款并核销（结算单结清）' },
      { ratio: 0.4, exec: 'approved', payType: 'accept', note: '部分付款，已审批待出纳执行' },
      { ratio: 0.3, exec: 'draft', payType: 'transfer', note: '草稿：核销计划已录，尚未生效' },
      { ratio: 0.2, exec: 'voided', payType: 'transfer', note: '作废：验证已付金额自动回退' }
    ]
    for (let i = 0; i < PAY_PLAN.length && payments < P.payments; i++) {
      // 每次重新取「最早期仍未结清的已审核结算单」：
      // 上一张全额付款可能已把它结清（settled 不在 open 里），必须重新挑。
      const st = db
        .prepare(
          `SELECT * FROM purchase_settlements
            WHERE status='audited' AND settle_amount - paid_amount > 0.01
            ORDER BY settle_date, id`
        )
        .get()
      if (!st) break
      const plan = PAY_PLAN[i]
      const amount = round2((Number(st.settle_amount || 0) - Number(st.paid_amount || 0)) * plan.ratio)
      if (!(amount > 0)) continue
      const pay = createPayment(db, {
        supplierId: st.supplier_id,
        payDate: dayAgo(ri(1, 10)),
        payType: plan.payType,
        amount,
        bankAccount: '演示账户 ****8821',
        remark: `演示付款（对应结算单 ${st.doc_no}）· ${plan.note}`,
        actor: { name: '出纳' },
        allocations: [{ settle_id: st.id, amount }]
      })
      payments += 1
      if (plan.exec === 'draft') continue
      transitionPayment(db, { id: pay.id, action: 'submit', actor: { name: '财务主管' }, source: 'seed' })
      if (plan.exec === 'approved') continue
      if (plan.exec === 'voided') {
        transitionPayment(db, { id: pay.id, action: 'void', actor: { name: '财务主管' }, source: 'seed' })
        continue
      }
      // paid：执行付款 → 触发结算单 settle → 采购订单付款关闭
      transitionPayment(db, { id: pay.id, action: 'pay', actor: { name: '出纳' }, source: 'seed' })
    }
    say('付款单 %d 张', payments)

    // ---------- 7. 收口：刷新所有采购订单的后段金额与四段关闭 ----------
    const orders = db.prepare("SELECT id FROM purchase_orders WHERE status NOT IN ('cancelled')").all()
    for (const o of orders) {
      refreshOrderStats(db, o.id)
      refreshCloseFlags(db, o.id)
    }
    say('刷新采购订单后段金额与四段关闭 %d 张', orders.length)

    // ---------- 8. 走完最后一段：让「四段关闭」真正可达 ----------
    // 前面只把流程推到「已收货 / 已开票 / 已付款」，收货单停在 received、订单停在 received，
    // 于是 close_inbound 恒为 0，依赖它的「采购订单关闭率」这个指标就**结构性恒等于 0**。
    // 指标恒为 0 比没有指标更糟 —— 它看起来像「真的一张都没关完」，而不是「这条链没走通」。
    //
    // 这里挑「到货已关 + 付款已关」的订单，把缺的那两段补齐（开票缺口 + 收货单质检关闭），
    // 四段齐了才推进订单状态。**只做到四段全关才关单**：关闭标记与状态机必须一致，
    // 否则又会出现「状态说关了、标记说没关」的自相矛盾。
    const closable = db
      .prepare(
        `SELECT id, status FROM purchase_orders
          WHERE status IN ('received','closed')
            AND close_arrival=1 AND close_payment=1
            AND NOT (close_inbound=1 AND close_invoice=1)
          ORDER BY id LIMIT ?`
      )
      .all(Math.max(2, Math.round(orders.length * 0.15)))
    let closedOrders = 0
    let supplement = 0
    // 质检链路里的失败必须**计数并回传**：这些调用被包在 try/catch 里（一票失败不该中断整库灌数），
    // 但 seedProcurement 平时以 silent 方式运行，日志没人看 —— 于是「唯一约束冲突导致
    // 质检单一张也建不出来」这种事可以一直藏着，界面上只表现为「点了没反应」。
    // 计数进 summary，任何一次灌数结束都能一眼看到有没有没走通的地方。
    const qcIssues = []
    // 收尾的三个动作抽成函数：8 与 8b 都要用（8b 只在「一张都没关」时才触发）。
    // 直接复制一份会让两处的口径迟早分叉 —— 而这里的口径（缺口怎么算、质检怎么走、
    // 付款怎么核销）恰恰是最不能分叉的地方。

    // ① 补齐开票缺口。按「已收数 − 已开票数」算缺口，与路由 /invoices-available-lines 同一口径；
    //    缺多少补多少，不做超额开票 —— 超额会让「开票关闭」变成恒真，这一段的业务含义就没了。
    //    返回补开的张数（0 = 无缺口）。
    const fillInvoiceGap = (id) => {
      const rows = db
        .prepare(
          `SELECT ri.sku_id, SUM(ri.qty) recv_qty, SUM(ri.amount) recv_amount,
                  (SELECT oi.id FROM purchase_order_items oi
                     WHERE oi.order_id=? AND oi.sku_id=ri.sku_id LIMIT 1) order_item_id,
                  COALESCE((SELECT SUM(ii.qty) FROM purchase_invoice_items ii
                              JOIN purchase_invoices i ON i.id=ii.invoice_id
                             WHERE ii.sku_id=ri.sku_id AND i.status NOT IN ('voided')
                               AND ii.order_item_id IN (SELECT id FROM purchase_order_items WHERE order_id=?)),0) invoiced_qty
             FROM purchase_receipt_items ri
             JOIN purchase_receipts rc ON rc.id=ri.receipt_id
            WHERE rc.order_id=?
            GROUP BY ri.sku_id`
        )
        .all(id, id, id)
      const lines = rows
        .map((r) => {
          const open = round2(Number(r.recv_qty || 0) - Number(r.invoiced_qty || 0))
          if (!(open > 0.0001)) return null
          const price = Number(r.recv_qty) > 0 ? round2(Number(r.recv_amount) / Number(r.recv_qty)) : 0
          return { sku_id: r.sku_id, qty: open, price, tax_rate: 13, order_item_id: r.order_item_id || null }
        })
        .filter(Boolean)
      if (!lines.length) return 0
      const rc0 = db.prepare('SELECT supplier_id FROM purchase_receipts WHERE order_id=? LIMIT 1').get(id)
      const po = db.prepare('SELECT doc_no FROM purchase_orders WHERE id=?').get(id)
      const inv = createInvoice(db, {
        invoiceNo: `CLS${ymd(seedNow()).replace(/-/g, '')}${String(id).padStart(4, '0')}`,
        invoiceType: 'vat_special',
        supplierId: rc0.supplier_id,
        orderId: id,
        invoiceDate: dayAgo(ri(1, 12)),
        taxRate: 13,
        remark: `收尾补开：订单 ${po.doc_no} 到货未开票部分`,
        actor: { name: '采购员' },
        lines
      })
      transitionInvoice(db, { id: inv.id, action: 'submit', actor: { name: '采购员' }, source: 'seed' })
      transitionInvoice(db, { id: inv.id, action: 'verify', actor: { name: '财务·审核' }, source: 'seed' })
      transitionInvoice(db, { id: inv.id, action: 'post', actor: { name: '财务·入账' }, source: 'seed' })
      return 1
    }

    // ② 收货单质检并关闭（GR：received → inspected → closed）
    //   质检这一步**走质检单（INS）**，不再直接把 GR 推到 inspected。
    //   直接推状态的后果：到货单显示「已质检」，全库却找不到任何一张质检单 ——
    //   状态机与单据对不上，判退率、判退金额、退货追溯全部无从算起。
    const closeReceipts = (id) => {
      const rcs = db.prepare('SELECT id FROM purchase_receipts WHERE order_id=?').all(id)
      for (const rc of rcs) {
        try {
          let st = db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(rc.id)?.status
          if (st === 'received') {
            // 已出结论（inspected/closed）→ 只补状态边，不重复建单；
            // 只有草稿 → 提交那张草稿；两者都没有 → 建新单再提交。
            // 判据必须与 pendingReceipts 一致：草稿**不算**「已经检过了」。
            const submitted = db
              .prepare("SELECT 1 AS hit FROM purchase_inspections WHERE receipt_id=? AND status NOT IN ('cancelled','draft')")
              .get(rc.id)
            const draft = db
              .prepare("SELECT id FROM purchase_inspections WHERE receipt_id=? AND status='draft'")
              .get(rc.id)
            if (submitted) {
              applyTransition({ db, docType: 'GR', id: rc.id, action: 'inspect', actor: { name: '质检员' }, source: 'seed' })
            } else {
              const insId = draft
                ? draft.id
                : createInspection(db, { receiptId: rc.id, actor: { name: '质检员' }, source: 'seed' }).id
              submitInspection(db, { id: insId, actor: { name: '质检员' }, remark: '收货抽检全部合格', source: 'seed' })
            }
            st = db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(rc.id)?.status
          }
          if (st === 'inspected') {
            applyTransition({ db, docType: 'GR', id: rc.id, action: 'close', actor: { name: '质检员' }, source: 'seed' })
          }
        } catch (e) {
          qcIssues.push(`GR#${rc.id} ${e.message}`)
          say('收货单 %d 质检/关闭跳过：%s', rc.id, e.message)
        }
      }
    }

    // ③ 付清本订单涉及的结算单（结算单审核 → 付款单 → 核销生效 → 订单付款关闭）。
    //    「核销生效点 = 付款单审批通过」是模块 07 的硬口径，这里必须走同一条路，
    //    不能直接把 paid_amount 改掉 —— 否则演示数据里会出现「没付过款却已付清」。
    const payOffOrder = (id) => {
      const settles = db
        .prepare(
          `SELECT DISTINCT st.id, st.doc_no, st.status, st.supplier_id
             FROM purchase_settlements st
             JOIN purchase_settlement_items si ON si.settle_id=st.id AND si.source_type='receipt'
             JOIN purchase_receipts rc ON rc.id=si.source_id
            WHERE rc.order_id=? AND st.status IN ('submitted','audited')`
        )
        .all(id)
      let n = 0
      for (const st of settles) {
        if (st.status === 'submitted') {
          transitionSettlement(db, { id: st.id, action: 'audit', actor: { name: '财务主管' }, source: 'seed' })
        }
        const fresh = db
          .prepare('SELECT settle_amount, paid_amount FROM purchase_settlements WHERE id=?')
          .get(st.id)
        const amount = round2(Number(fresh.settle_amount || 0) - Number(fresh.paid_amount || 0))
        if (!(amount > 0)) continue
        const pay = createPayment(db, {
          supplierId: st.supplier_id,
          payDate: dayAgo(ri(1, 15)),
          payType: 'transfer',
          amount,
          bankAccount: '演示账户 ****8821',
          remark: `演示付款（结清结算单 ${st.doc_no}）· 四段闭环兜底`,
          actor: { name: '出纳' },
          allocations: [{ settle_id: st.id, amount }]
        })
        transitionPayment(db, { id: pay.id, action: 'submit', actor: { name: '财务主管' }, source: 'seed' })
        transitionPayment(db, { id: pay.id, action: 'pay', actor: { name: '出纳' }, source: 'seed' })
        n += 1
      }
      return n
    }

    for (const { id, status: poStatus } of closable) {
      try {
        const made = fillInvoiceGap(id)
        supplement += made
        invoices += made
      } catch {
        // 补开失败不阻断收尾的其它判断：这一段没走完，下面关单那步自然就过不了
      }

      // ② 收货单质检并关闭
      try {
        closeReceipts(id)
      } catch {
        // 订单不在可质检状态 —— 跳过
      }

      // ③ 四段全关才推进订单状态
      try {
        refreshOrderStats(db, id)
        refreshCloseFlags(db, id)
        const f = db
          .prepare('SELECT close_arrival,close_inbound,close_invoice,close_payment FROM purchase_orders WHERE id=?')
          .get(id)
        if (f.close_arrival && f.close_inbound && f.close_invoice && f.close_payment) {
          // 已经是 closed 的不再重复流转（内核会拒绝 received→closed 之外的同名动作）
          if (poStatus === 'received') {
            applyTransition({ db, docType: 'PO', id, action: 'close', actor: { name: '采购主管' }, source: 'seed' })
          }
          closedOrders += 1
        }
      } catch {
        // 还有段没走完 —— 留给真实业务去关，不强行改状态
      }
    }
    say('收尾补开发票 %d 张，四段全关并关闭的采购订单 %d 张', supplement, closedOrders)

    // ---------- 8b. 兜底：保证演示库至少有一张「四段全关」的采购订单 ----------
    // 8 的候选集要求 close_payment=1，而付款是从「最早仍未结清的已审核结算单」挑的，
    // 它的覆盖面由该行业自己的随机序列决定 —— 有的行业（如餐饮）会落到
    // **没有任何一张订单被付清**：close_payment 恒为 0 → close_inbound 连带进不了候选，
    // 于是「采购四段闭环率」这个指标结构性恒等于 0，界面上的指标卡永远显示 0%。
    // 那不是「数据不好看」，是一个**恒为 0 的指标**看起来像功能没做。
    //
    // 这里做一次确定性兜底：只在「一张都没有」时触发 —— 已经有关闭样本的行业数据保持原样。
    // 补的方式与 8 完全相同（补开票 → 质检关闭收货单 → 付款核销 → 四段齐了才关单），
    // 一步都不绕过业务：不走内核动作就直接改 status 的话，正好制造出本模块最怕的
    // 「状态说关了、留痕里查无此事」。
    const countFullyClosed = () =>
      db
        .prepare(
          `SELECT COUNT(*) c FROM purchase_orders
            WHERE status <> 'cancelled'
              AND close_arrival=1 AND close_inbound=1 AND close_invoice=1 AND close_payment=1`
        )
        .get().c
    let forcedClosed = 0
    let forcedId = null
    if (countFullyClosed() === 0) {
      // 候选：已到货齐 → 有收货单（能质检关闭）→ 有结算明细挂在收货单上（能付款结清）。
      // 排序按「已满足的段数」降序，同分按 id 升序 —— 与集合大小无关，重跑结果一致。
      const cand = db
        .prepare(
          `SELECT id FROM purchase_orders
            WHERE status <> 'cancelled' AND close_arrival=1
              AND EXISTS (SELECT 1 FROM purchase_receipts rc WHERE rc.order_id = purchase_orders.id)
              AND EXISTS (SELECT 1 FROM purchase_settlement_items si
                            JOIN purchase_receipts rc2 ON rc2.id = si.source_id
                           WHERE si.source_type='receipt' AND rc2.order_id = purchase_orders.id)
            ORDER BY (close_inbound + close_invoice + close_payment) DESC, id
            LIMIT 1`
        )
        .get()
      if (cand) {
        const id = cand.id
        const poStatus = db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(id)?.status
        try {
          const made = fillInvoiceGap(id)
          supplement += made
          invoices += made
        } catch {
          // 见 8① 说明
        }
        try {
          closeReceipts(id)
        } catch {
          // 见 8② 说明
        }
        try {
          payOffOrder(id)
        } catch {
          // 付款没走通就停在这一段，留给真实业务去收尾
        }
        try {
          refreshOrderStats(db, id)
          refreshCloseFlags(db, id)
          const f = db
            .prepare('SELECT close_arrival,close_inbound,close_invoice,close_payment FROM purchase_orders WHERE id=?')
            .get(id)
          if (f.close_arrival && f.close_inbound && f.close_invoice && f.close_payment) {
            if (poStatus === 'received') {
              applyTransition({ db, docType: 'PO', id, action: 'close', actor: { name: '采购主管' }, source: 'seed' })
            }
            forcedClosed = 1
            forcedId = id
            closedOrders += 1
          }
        } catch {
          // 仍有一段过不了 —— 不强行改状态
        }
      }
    }
    if (forcedClosed) say('四段闭环兜底：订单 %d 补齐到四段全关', forcedId)

    // ---------- 9. 质检样本：让步接收与判退 ----------
    // 上一步把「能关的」收货单都关了，走的全是**全部合格**这一条路径。
    // 但质检存在的意义恰恰是**不合格**那部分 —— 没有判退，质检就只是一张纸：
    // 判退率为 0、判退金额为 0、退货单一张也没有，这一整个模块在演示里看不出在干什么。
    //
    // 这里再挑一部分仍在「已收货」的到货单，造出让步接收与部分判退的样本，
    // 其中判退会真实生成采购退货单并反向出库（判退必须有后果）。
    //
    // 两条克制的口径：
    //   ① 只处理 **rc.id % 3 <> 0** 的到货单，剩下每三张留一张不动 ——
    //      质检岗的工作台上得有活可干；队列恒为 0 的演示看起来像这个岗位不存在。
    //   ② 选取条件必须是**绝对谓词**（写在 SQL 里、与集合大小无关），不能写成
    //      「取候选的前一半」—— 候选集合会因为上一次已经质检过而缩小，
    //      按位置取就会每次挑到新的一批，二次运行再多造一批质检单、退货单叠加出库。
    //      用 id % 3 这类只与单据自身有关的条件，重跑才是真正的空操作。
    //   ③ 已经有**出过结论**的质检单的到货单由 NOT EXISTS 直接排除：重复判退会让
    //      退货出库一次次叠加，库存越跑越少，而界面上完全看不出是种子数据干的。
    //      注意只排除「非草稿」的：草稿是上一次提交没成功的残留（多为判退时库存不足），
    //      它必须被重新走到，否则这张到货单会永远停在草稿上。
    const toInspect = db
      .prepare(
        `SELECT rc.id, rc.doc_no, rc.receipt_date
           FROM purchase_receipts rc
          WHERE rc.status = 'received'
            AND rc.id % 3 <> 0
            AND NOT EXISTS (SELECT 1 FROM purchase_inspections i
                             WHERE i.receipt_id = rc.id AND i.status NOT IN ('cancelled','draft'))
            AND EXISTS (SELECT 1 FROM purchase_receipt_items it WHERE it.receipt_id = rc.id AND it.qty > 0)
          ORDER BY rc.id`
      )
      .all()
    let qcDone = 0
    let qcConcession = 0
    let qcRejected = 0
    let qcReturns = 0
    let qcDowngrade = 0
    for (const rc of toInspect) {
      try {
        // 残留草稿就复用，不重建（重建会撞「一张到货单一张质检单」的唯一约束）
        const draft = db
          .prepare("SELECT id FROM purchase_inspections WHERE receipt_id=? AND status='draft'")
          .get(rc.id)
        const ins = draft
          ? getInspection(db, draft.id)
          : createInspection(db, {
              receiptId: rc.id, inspectDate: rc.receipt_date,
              actor: { name: '质检员·抽样' }, source: 'seed'
            })
        const items = ins.items || []
        const first = items[0]
        let lines = null
        // 计数先记在局部，**提交成功后**才计入汇总：提交失败会整单回滚，
        // 提前计入会让 summary 报一批并不存在的让步 / 判退。
        let addConcession = 0
        let addRejected = 0
        const roll = rng()
        if (first && roll < 0.22) {
          // 让步接收：整单收下，但留一笔「明知不合格、按让步收」的记录。
          // 让步不影响入库数量，却是最容易被和「合格」混起来的一项。
          const q = round2(Number(first.qty) || 0)
          const c = round2(Math.max(1, Math.floor(q * 0.03)))
          if (q - c > 0) {
            lines = [{
              id: first.id, qualified_qty: round2(q - c), concession_qty: c, rejected_qty: 0,
              defect_code: 'appearance', defect_reason: '外包装轻微压损，不影响使用，申请让步接收'
            }]
            addConcession = c
          }
        } else if (first && roll < 0.36) {
          // 部分判退：这批货必须有后果 —— 生成退货单并反向出库。
          // 判退量刻意取小（不超过到货量的 8%，且不超过 8 件）：判退要出库，
          // 而这批货可能已经被下游（POS / 销售）用掉一部分，量取大了会因库存不足整单失败。
          const q = round2(Number(first.qty) || 0)
          const r = round2(Math.min(Math.max(1, Math.floor(q * 0.15)), 20))
          if (q - r > 0) {
            lines = [{
              id: first.id, qualified_qty: round2(q - r), concession_qty: 0, rejected_qty: r,
              defect_code: 'spec', defect_reason: '抽检规格与订单不符（批次混装），判退该部分'
            }]
            addRejected = r
          }
        }
        let out
        try {
          out = submitInspection(db, {
            id: ins.id, lines,
            actor: { name: '质检员·抽样' },
            remark: lines ? null : '抽样检查合格',
            source: 'seed'
          })
        } catch (e) {
          // 判退失败（多为库存不足）时**降级为全合格**，而不是把草稿留在库里：
          //   留草稿的后果是这张到货单既不在「待质检」也不在「已质检」——
          //   而每次灌数都会新留一张，越积越多且完全静默。
          // 降级要记账（qc_downgraded），不是悄悄把数字改小。
          if (!lines) throw e
          qcDowngrade += 1
          qcIssues.push(`${rc.doc_no} 判退降级为全合格：${e.message}`)
          say('质检样本判退失败，降级为全合格 %s：%s', rc.doc_no, e.message)
          addRejected = 0
          addConcession = 0
          lines = lines.map((x) => ({
            ...x, qualified_qty: round2(Number(x.qualified_qty) + Number(x.rejected_qty)), rejected_qty: 0
          }))
          out = submitInspection(db, { id: ins.id, lines, actor: { name: '质检员·抽样' }, remark: '抽样检查合格', source: 'seed' })
        }
        qcConcession += addConcession
        qcRejected += addRejected
        if (out.return_created) qcReturns += 1
        qcDone += 1
      } catch (e) {
        qcIssues.push(`${rc.doc_no} ${e.message}`)
        say('质检样本跳过 %s：%s', rc.doc_no, e.message)
      }
    }
    say(
      '质检样本：提交质检单 %d 张（让步 %s / 判退 %s，生成退货单 %d 张，降级 %d），待质检队列保留 %d 张',
      qcDone, round2(qcConcession), round2(qcRejected), qcReturns, qcDowngrade,
      db.prepare("SELECT COUNT(*) c FROM purchase_receipts rc WHERE rc.status='received' AND NOT EXISTS (SELECT 1 FROM purchase_inspections i WHERE i.receipt_id=rc.id AND i.status NOT IN ('cancelled','draft'))").get().c
    )

    return {
      catalog, requisitions, converted: convertedReqs.length,
      invoices, fee_invoices: feeInvoices, settlements, payments,
      supplement_invoices: supplement, closed_orders: closedOrders,
      inspections: qcDone, qc_concession_qty: round2(qcConcession),
      qc_rejected_qty: round2(qcRejected), qc_returns: qcReturns,
      qc_downgraded: qcDowngrade,
      qc_issues: qcIssues.length,
      qc_issue_list: qcIssues,
      ...(process.env.GML_DEBUG_QC ? { qc_issue_detail: qcIssues } : {})
    }
  })

  const summary = tx()
  if (!silent) say('完成：%s', JSON.stringify(summary))
  return summary
}

export default { seedProcurement, PROFILES }
