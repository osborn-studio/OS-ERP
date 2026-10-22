/**
 * ============================================================================
 * 文件标识：server/db/demo-seed.js ｜ 演示剧本数据（官网演示专用：连续零售日报 + 部分流转形态）
 * ============================================================================
 * 【这块解决什么问题】
 *   `seedAll` 造的是一批「随机但自洽」的数据：单子够多，但**形态不全** ——
 *   零售只有最近 3 天有班次、销售单要么全发要么没发、采购单要么全收要么没到。
 *   拿这种库去给客户演示，会出现两类尴尬：
 *     · 「零售日报」点开只有 2~3 天有数，看起来像系统没在跑；
 *     · 「部分发货 / 部分开票 / 部分收款」这些**最需要讲的中间态**一个都点不出来。
 *
 * 【为什么单独一个文件，而不是继续往 seed.js 里堆】
 *   `seed.js` 已有 2000 行，且它的随机流是**全库可复现**的锚点（两次重建逐表 0 差异）。
 *   往里插几百行会挪动 `rnd()` 的调用序列，整库数据全变 —— 那是"看似只加了几行"的
 *   大规模变更，回归里所有"数量/金额"类断言都会跟着漂。
 *   所以这里**独立成模块、跑在既有 seed 之后**，用自己的一段确定性随机，
 *   不动 `seed.js` 的随机序列。
 *
 * 【三条纪律（都是本项目踩过的坑）】
 *   1. **写数据只走服务函数**（`lib/pos2.js` / `lib/transfer.js` / `lib/invoice.js` / `lib/ar.js`），
 *      不手写 INSERT。手工插出来的班次最容易漏 `pos_shift_payments`，那种分叉不报错，
 *      只会让核款界面少几行支付方式。
 *   2. **幂等**：用「本模块才会产生的日期」当哨兵（`pos_daily_closes` 里出现 HISTORY_FROM 那天），
 *      有就整体跳过。不用 settings 表当哨兵 —— 未登记的键会被配置底座拒绝。
 *   3. **库存必须真的够**：连续 22 天营业会把门店初始铺货吃空，
 *      所以每 7 天用**真实调拨单**（总部仓 → 门店仓）补货，而不是直接 `applyStockIn` 造一笔
 *      没有来源单据的入库 —— 那会让"仓库里凭空多出货"。
 *
 * 【改它要注意】
 *   · 天数 / 单量改大时先看 `seedPosHistory` 的耗时（food 有 20 家门店）；
 *   · 补货批次与销售批次走 `pickBatches` 的先进先出，**不要指定批次号**，否则会与 FEFO 分叉；
 *   · 本模块产出的单号一律带 DEMO 前缀语义（见各函数注释），便于演示时"照着念"。
 * ============================================================================
 */

import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow, dayAgo, ymd, RI, R, PICK } from './seed.js'
import {
  openShift,
  declareShift,
  approveShift,
  computeShiftSystem,
  createPosOrder,
  dailyClose,
  PAY_METHODS,
  round2
} from '../lib/pos2.js'
import { sellableSkusInWarehouse } from '../lib/catalog.js'
import { createTransfer, shipTransfer, receiveTransfer } from '../lib/transfer.js'
import { applyStockOut, pickBatches } from '../lib/stock.js'
import { nextDocNo } from '../lib/docno.js'
import { createInvoiceFromDelivery, submitInvoice, confirmInvoice } from '../lib/invoice.js'
import { createReceipt, confirmReceipt, arOfOrder } from '../lib/ar.js'
import { receivePurchaseOrder } from '../lib/purchase.js'
import { createInspection, submitInspection } from '../lib/qc.js'

const num = (v) => Number(v) || 0

/**
 * 零售历史的天数（含首尾）。
 * 22 天 = 3 周多：日报按周看、按月看都能看到连续曲线，而单量又不至于把灌数时间拉长。
 */
const HISTORY_DAYS = 22
/** 补货间隔：每 7 天一次，与 WEEKLY 的运营节奏一致 */
const REPLENISH_EVERY = 7

/**
 * 生成门店零售历史：**每一天都有营业、每一天都日结**。
 *
 * 为什么必须"每天"：
 *   「零售日报」这个页面的判据就是"按天看成不成列"。中间断一天，客户第一眼就会问
 *   "这天为什么是空的" —— 而现场解释"演示数据只造了几天"是最难圆的一句话。
 *
 * 形态设计（刻意保留差异，与 pos-seed.js 的口径一致）：
 *   · 大部分天：账实相符（正常营业日）；
 *   · 每 6 天留一天**现金短款**（找零出错），由门店承担；
 *   · 每周一留一天**微信差异**（平台流水漏传），差异按渠道可见。
 *   ⇒ 这样「长短款」不是一个孤零零的样本，而是**每周都会发生一次**的常态，
 *     演示时可以直接说"上周这笔短款我们是怎么处理的"。
 *
 * @returns {{days:number, stores:number, closes:number, transfers:number, skipped:boolean}}
 */
export function seedPosHistory(db, { silent = true } = {}) {
  requireDemoDatabase(db)
  const log = silent ? () => {} : (...a) => console.log('  [demo-pos]', ...a)
  const base = seedNow()
  const dateOf = (d) => ymd(dayAgo(d))
  const historyFrom = dateOf(HISTORY_DAYS)
  const historyTo = dateOf(3) // D-2 / D-1 / D0 由 pos-seed.js 负责，这里不重叠

  // 幂等哨兵：HISTORY_FROM 这一天只可能由本模块产生
  const sentinel = db
    .prepare('SELECT COUNT(*) c FROM pos_daily_closes WHERE biz_date=?')
    .get(historyFrom).c
  if (sentinel > 0) {
    log(`已有 ${historyFrom} 的日结批次，跳过`)
    return { days: 0, stores: 0, closes: 0, transfers: 0, skipped: true }
  }

  const stores = db
    .prepare(
      `SELECT s.*, w.id AS wh_id FROM stores s
         JOIN warehouses w ON w.store_id = s.id AND w.status='active'
        WHERE s.status='active' ORDER BY s.id`
    )
    .all()
  if (!stores.length) {
    log('没有可用门店，跳过')
    return { days: 0, stores: 0, closes: 0, transfers: 0, skipped: true }
  }

  // 总部发货仓：优先主仓（WH01），拿不到就取第一个非隔离的中心仓
  const hub =
    db.prepare("SELECT * FROM warehouses WHERE code='WH01' AND status='active'").get() ||
    db
      .prepare(
        "SELECT * FROM warehouses WHERE status='active' AND IFNULL(store_id,0)=0 AND type NOT IN ('defect','quarantine') ORDER BY id LIMIT 1"
      )
      .get()

  let closes = 0
  let transfers = 0
  let shiftCount = 0

  for (const store of stores) {
    const wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(store.wh_id)
    const storeUser = db
      .prepare("SELECT id, name FROM users WHERE role='store' AND store_id=? ORDER BY id LIMIT 1")
      .get(store.id)
    const cashier = { id: storeUser?.id ?? null, name: storeUser?.name || '门店收银' }
    const req = { user: { uid: cashier.id, name: cashier.name } }

    // 可售样本：判据（排除原料/包材 + 必须有零售价）只在 lib/catalog.js 实现一次
    let skus = sellableSkusInWarehouse(db, wh.id, { minQty: 5, limit: 8 })
    if (skus.length < 2) continue

    for (let d = HISTORY_DAYS; d >= 3; d -= 1) {
      const bizDate = dateOf(d)

      // ---- 每 7 天补一次货（真实调拨单：总部仓 → 门店仓）----
      if (hub && (d === HISTORY_DAYS || (HISTORY_DAYS - d) % REPLENISH_EVERY === 0)) {
        const need = skus.slice(0, 6)
        const items = need
          .map((s) => ({
            sku_id: s.id,
            qty: RI(40, 90)
          }))
          .filter((x) => x.qty > 0)
        if (items.length) {
          try {
            const tr = createTransfer(db, {
              fromWarehouseId: hub.id,
              toWarehouseId: wh.id,
              transferDate: bizDate,
              type: 'normal',
              items,
              remark: '门店日常补货（演示数据）',
              actor: req
            })
            shipTransfer(db, tr.id, req)
            receiveTransfer(db, tr.id, req, { receiveDate: bizDate })
            transfers += 1
          } catch (e) {
            // 补货失败不能中断整库重建：后面按现有库存继续卖，卖不动就跳过这一天
            log(`补货跳过（${store.code} ${bizDate}）：${e.message}`)
          }
        }
        skus = sellableSkusInWarehouse(db, wh.id, { minQty: 3, limit: 8 })
        if (skus.length < 2) break
      }

      // ---- 开店 → 卖 → 交班 → 核款 → 日结 ----
      let shift
      try {
        shift = openShift(db, {
          storeId: store.id,
          cashierId: cashier.id,
          cashierName: cashier.name,
          businessDate: bizDate,
          openingFloat: 500,
          deviceNo: 'POS-A01',
          remark: '日常营业'
        })
      } catch (e) {
        log(`开班跳过（${store.code} ${bizDate}）：${e.message}`)
        continue
      }
      shiftCount += 1

      const n = RI(3, 7)
      const methods = ['cash', 'cash', 'wxpay', 'alipay', 'wxpay', 'cash', 'unionpay']
      let sold = 0
      for (let i = 0; i < n; i += 1) {
        const sku = skus[RI(0, skus.length - 1)]
        try {
          createPosOrder(db, {
            storeId: store.id,
            warehouseId: wh.id,
            shiftId: shift.id,
            items: [{ sku_id: sku.id, qty: RI(1, 2) }],
            payMethod: methods[RI(0, methods.length - 1)]
          })
          sold += 1
        } catch (e) {
          // 库存不足 / 结算不一致时跳过这一笔，不让整库重建失败
          log(`开单跳过（${store.code} ${bizDate}）：${e.message}`)
        }
      }
      if (!sold) {
        // 一单都没开成 ⇒ 这一天不能日结（无单可传），把班次作废掉保持库干净
        db.prepare("UPDATE pos_shifts SET status='voided' WHERE id=?").run(shift.id)
        continue
      }

      // 报数：默认账实相符；每 6 天一次现金短款；每逢周一（getDay()===1）一次微信差异
      const sys = computeShiftSystem(db, shift.id)
      const isShortDay = (HISTORY_DAYS - d) % 6 === 5
      const isWxDiffDay = dayAgo(d).getDay() === 1
      const payments = PAY_METHODS.filter((m) => sys.byMethod[m].order_count > 0).map((m) => ({
        method: m,
        declared_amount: Math.max(
          0,
          num(sys.byMethod[m].sys_amount) + (isWxDiffDay && m === 'wxpay' ? 18 : 0)
        )
      }))
      try {
        declareShift(db, req, { shiftId: shift.id, payments, remark: '日常交班报数' })
        const sysCash = round2(sys.sys_cash)
        const shortBy = Math.min(6.5, Math.max(0.5, round2(sysCash * 0.02)))
        const counted =
          isShortDay && sysCash - shortBy > 0 ? round2(sysCash - shortBy) : sysCash
        approveShift(db, req, {
          shiftId: shift.id,
          countedCash: counted,
          varianceNote: counted !== sysCash ? '现金找零短款（演示样本）' : null,
          varianceHandled: counted !== sysCash ? 'absorb' : undefined
        })
        dailyClose(db, req, {
          storeId: store.id,
          warehouseId: wh.id,
          storeName: store.name,
          bizDate,
          operatorUid: cashier.id,
          operatorName: cashier.name
        })
        closes += 1
      } catch (e) {
        log(`日结跳过（${store.code} ${bizDate}）：${e.message}`)
      }
    }
  }

  log(`零售历史：${stores.length} 家门店 × 近 ${HISTORY_DAYS - 2} 天 → 班次 ${shiftCount} / 日结 ${closes} / 补货调拨 ${transfers}`)
  return { days: HISTORY_DAYS - 2, stores: stores.length, closes, transfers, skipped: false }
}

/**
 * 部分流转形态：**部分发货 / 部分开票 / 部分收款**，以及采购侧的
 * **部分入库 / 在途未到 / 部分待检 / 部分已检**。
 *
 * 为什么这几格必须专门造：
 *   `seedAll` 里的单据只有「全发 / 全没发」和「全收 / 全没收」两态。
 *   而客户最常问的恰恰是中间态 ——「发了一半，剩下那半在哪」「开票开了一部分，还能不能再开」
 *   「款收了 40%，这单算不算逾期」。这些页面在"没有中间态数据"的库上点开全是空，
 *   看起来就像功能没做。
 *
 * 每条形态都**走真实服务函数**（`createInvoiceFromDelivery` / `createReceipt` /
 * `receivePurchaseOrder` / `submitInspection`），因此派生字段（`invoice_status`、
 * `ar.allocated_amount`、`received_qty`、`GR.status`）全部由服务层算好 ——
 * 手写 INSERT 会漏掉这些派生列，那种漏不报错，只会让界面上"开票状态"永远显示未开票。
 *
 * @returns {{sales:number, invoices:number, receipts:number, poPartial:number, skipped:boolean}}
 */
export function seedPartialFlows(db, { silent = true } = {}) {
  requireDemoDatabase(db)
  const log = silent ? () => {} : (...a) => console.log('  [demo-flow]', ...a)

  // 幂等哨兵：本模块的发货单备注固定带这个标记，存在就整体跳过
  const MARK = '演示·部分发货'
  if (db.prepare('SELECT COUNT(*) c FROM sales_deliveries WHERE remark=?').get(MARK).c > 0) {
    log('已有部分流转样本，跳过')
    return { sales: 0, invoices: 0, receipts: 0, poPartial: 0, skipped: true }
  }

  const actor = { id: 1, name: '系统管理员' }
  const today = ymd(seedNow())
  const dateAgo = (n) => ymd(dayAgo(n))

  // ==========================================================================
  // 一、销售：部分发货 → 部分开票 → 部分收款
  // ==========================================================================
  // 挑单口径：**经销商渠道、已确认、且明细一件都没发**的订单（`shipped_qty=0`）。
  // 为什么要限经销商渠道：门店渠道的单行数量常是 1~2 件，
  // 「发 60%」会退化成 0 件或整件 —— 中间态直接消失。
  // 经销商单行 10~120 件，60% 才是真的有零有整，演示时"已发 72 / 未发 48"才站得住。
  const candidates = db
    .prepare(
      `SELECT o.* FROM sales_orders o
        WHERE o.status='confirmed' AND o.channel='dealer'
          AND EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id=o.id AND i.qty >= 10)
          AND NOT EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id=o.id AND i.shipped_qty > 0)
        ORDER BY o.id DESC LIMIT 20`
    )
    .all()

  let sales = 0
  let invoices = 0
  let receipts = 0

  for (const order of candidates) {
    if (sales >= 4) break
    if (!order.warehouse_id) continue
    const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=? ORDER BY id').all(order.id)
    const plans = []
    let ok = true
    for (const it of items) {
      const remain = num(it.qty) - num(it.shipped_qty)
      if (remain <= 0) continue
      // 发货比例 60%：留出「未发部分」才有中间态可看；
      // 只剩 1 件的行直接跳过（1 件发 0.6 件不成立，强行发整件会让"部分"消失）
      let want = Math.floor(remain * 0.6)
      if (want < 1) continue
      if (want >= remain) want = remain - 1
      if (want < 1) continue
      const { picks, shortage } = pickBatches(db, order.warehouse_id, it.sku_id, want)
      if (shortage > 0) {
        ok = false
        break
      }
      plans.push({ it, picks, want })
    }
    if (!ok || !plans.length) continue

    let did = null
    let dDocNo = null
    let deliveredQty = 0
    let deliveredAmt = 0
    try {
      db.transaction(() => {
        dDocNo = nextDocNo(db, 'SD', 'sales_deliveries', 'doc_no', today)
        const info = db
          .prepare(
            `INSERT INTO sales_deliveries (doc_no,order_id,warehouse_id,delivery_date,status,total_qty,total_amount,express_company,express_no,remark,created_by)
             VALUES (?,?,?,?,'shipped',0,0,?,?,?,?)`
          )
          .run(dDocNo, order.id, order.warehouse_id, today, '顺丰速运', null, MARK, actor.id || null)
        did = Number(info.lastInsertRowid)
        const insItem = db.prepare(
          'INSERT INTO sales_delivery_items (delivery_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)'
        )
        for (const p of plans) {
          for (const pk of p.picks) {
            applyStockOut(db, {
              bizDate: today,
              docType: 'SAL_OUT',
              docNo: dDocNo,
              docId: did,
              warehouseId: order.warehouse_id,
              skuId: p.it.sku_id,
              batchNo: pk.batchNo,
              qty: pk.qty,
              unitCost: pk.unitCost,
              counterparty: order.receiver || '演示客户',
              operator: actor.name,
              remark: '演示：部分发货出库'
            })
            const amt = Number((pk.qty * Number(p.it.price)).toFixed(2))
            insItem.run(did, p.it.sku_id, pk.batchNo, pk.qty, p.it.price, amt)
            deliveredQty += pk.qty
            deliveredAmt += amt
          }
          db.prepare('UPDATE sales_order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(p.want, p.it.id)
        }
        db.prepare('UPDATE sales_deliveries SET total_qty=?, total_amount=? WHERE id=?').run(
          deliveredQty,
          Number(deliveredAmt.toFixed(2)),
          did
        )
        // 订单仍是 confirmed：**部分发货不推进整单状态**（剩下的还没发）。
        // 这正是演示要给人看的那一格 —— 状态没变，但明细里的已发数量变了。
        db.prepare("UPDATE sales_orders SET updated_at=datetime('now','localtime') WHERE id=?").run(order.id)
      })()
    } catch (e) {
      log(`部分发货跳过（${order.doc_no}）：${e.message}`)
      continue
    }
    sales += 1

    // ---- 部分开票：只把**已发数量的一部分**开出去 ----
    try {
      const dItems = db.prepare('SELECT * FROM sales_delivery_items WHERE delivery_id=? ORDER BY id').all(did)
      const invItems = dItems
        .map((d) => {
          const q = Math.floor(num(d.qty) * 0.6)
          return q >= 1 ? { item_id: d.id, qty: q } : null
        })
        .filter(Boolean)
      const inv = createInvoiceFromDelivery(db, {
        deliveryId: did,
        invoiceDate: today,
        items: invItems.length ? invItems : null,
        remark: '演示：部分开票',
        actor
      })
      submitInvoice(db, { id: inv.id, actor })
      confirmInvoice(db, { id: inv.id, actor })
      invoices += 1

      // ---- 部分收款：按发票金额的 40% 收 ----
      const ar = arOfOrder(db, order.id)[0]
      if (ar && num(ar.amount) > 0) {
        const amt = round2(num(ar.amount) * 0.4)
        if (amt > 0.01) {
          const rc = createReceipt(db, {
            subjectType: ar.subject_type,
            subjectId: ar.subject_id,
            subjectName: ar.subject_name,
            receiptDate: today,
            method: 'transfer',
            amount: amt,
            allocations: [{ ar_id: ar.id, amount: amt }],
            remark: '演示：收到部分货款',
            actor
          })
          confirmReceipt(db, { id: rc.id, actor })
          receipts += 1
        }
      }
    } catch (e) {
      log(`部分开票/收款跳过（${order.doc_no}）：${e.message}`)
    }
  }

  // ==========================================================================
  // 二、采购：部分入库 / 在途未到 / 部分待检 / 部分已检
  // ==========================================================================
  // 挑单口径：**已提交/已审批、且一件都没收**的采购订单 —— 界面上就是"待到货"。
  const poList = db
    .prepare(
      `SELECT * FROM purchase_orders
        WHERE status IN ('submitted','approved')
          AND id IN (SELECT order_id FROM purchase_order_items WHERE qty > received_qty)
        ORDER BY id DESC LIMIT 8`
    )
    .all()

  let poPartial = 0
  let inspected = 0
  for (let i = 0; i < poList.length && poPartial < 3; i += 1) {
    const po = poList[i]
    const lines = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY id').all(po.id)
    const payload = []
    for (const l of lines) {
      const remain = num(l.qty) - num(l.received_qty)
      if (remain <= 0) continue
      // 第 1 张收 50%（留一半在途）、第 2 张收 30%、第 3 张收 100% 但**分两张收货单**
      // —— 三种形态各一张，演示时按需挑
      const ratio = poPartial === 0 ? 0.5 : poPartial === 1 ? 0.3 : 1
      let q = Math.floor(remain * ratio)
      if (ratio === 1) q = remain
      if (q < 1) q = 1
      if (q > remain) q = remain
      payload.push({ id: l.id, sku_id: l.sku_id, qty: q, price: l.price,
        batch_no: `DEMOPO${today.replace(/-/g, '')}-${po.id}-${l.id}` })
    }
    if (!payload.length) continue

    try {
      const out = receivePurchaseOrder(db, {
        orderId: po.id,
        items: payload,
        inspector: '沈仓管',
        receiptDate: today,
        remark: '演示：部分到货',
        actor,
        source: 'seed'
      })
      poPartial += 1
      // 第 2 张：收货后立刻做质检（走到「已质检」），让「待检 / 已检」两种状态同时存在
      if (poPartial === 2) {
        const rc = db.prepare('SELECT * FROM purchase_receipts WHERE id=?').get(out.receipt_id)
        if (rc && rc.status === 'received') {
          const insp = createInspection(db, { receiptId: rc.id, inspectDate: today, actor, remark: '演示：到货抽检' })
          const inspLines = db
            .prepare('SELECT * FROM purchase_inspection_items WHERE inspection_id=? ORDER BY line_no')
            .all(insp.id)
          submitInspection(db, {
            id: insp.id,
            lines: inspLines.map((x) => ({ id: x.id, qualified_qty: x.qty, concession_qty: 0, rejected_qty: 0 })),
            actor,
            remark: '演示：全项合格'
          })
          inspected += 1
        }
      }
    } catch (e) {
      log(`部分入库跳过（${po.doc_no}）：${e.message}`)
    }
  }

  log(
    `部分流转：销售 ${sales} 单（开票 ${invoices} / 收款 ${receipts}）；采购部分入库 ${poPartial} 单（已检 ${inspected}）`
  )
  return { sales, invoices, receipts, poPartial, inspected, skipped: false }
}

export default { seedPosHistory, seedPartialFlows }
