/**
 * ============================================================================
 * 文件标识：server/db/qc-seed.js ｜ 质量检验演示数据（模块 13）
 * ============================================================================
 * 【职责】质量检验演示数据（模块 13）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 质量检验演示数据（模块 13）
 *
 * 与其它 seed 同一原则：**每一条数据都能讲一个故事**，而不是把表填满。
 * 造出来的东西必须能回答界面上的四个问题：
 *   ① 谁在等检？（待检来源清单要有一批 —— 采购到货 + 生产完工都有）
 *   ② 判定是怎么来的？（要有合格、也要有不合格，且不合格的数字能复现 Ac/Re 规则）
 *   ③ 四种处置都长什么样？（让步接收有理由、退货生成退货单、报废出库、返工自动调拨入待检仓）
 *   ④ 中间态看得见吗？（留一张已报检未出结论的单、一张草稿单，否则工作台全是"已完成"）
 *
 * 依赖：采购到货单（模块 07 已收货且未被质检覆盖）、生产订单（已完成）、库存（在库复检）。
 * 全程 try/catch：库存可能已被下游消耗，单条失败不该让整库 seed 崩掉。
 *
 * ⚠️ 处置现在是**真的动库存**的（让步 → 调拨入不合格仓、返工 → 调拨入待检仓，客户口径），
 *    所以报检数量必须压在**现货以内**（见下方 `cappedItems`）——否则处置执行会因为
 *    "库存不足"失败、被 try/catch 吞掉，演示库里就会少掉一整种处置。
 */
import { requireDemoDatabase } from './runtime-policy.js'
import {
  createRequest, submitRequest, submitInspection,
  createHandling, confirmHandling, samplingPlan, sourceDetail
} from '../lib/qc2.js'
import { seedNow } from './seed-clock.js'

const dayOffset = (n) => {
  const d = new Date(seedNow())
  d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 造不良数：让结论稳定为某个方向（合格 / 不合格），而不是靠随机 */
function defectsFor(items, wantUnqualified) {
  return items.map((it) => ({
    id: it.id,
    defect_qty: wantUnqualified
      ? Math.min(it.sample_qty, Math.max(it.ac + 1, Math.ceil(it.sample_qty * 0.08)))
      : Math.min(it.sample_qty, it.ac),
    defect_code: 'spec',
    defect_reason: wantUnqualified ? '规格偏差超出允差' : null
  }))
}

/** 某批次在某仓的净可用量（qty_on_hand − qty_reserved） */
const availOf = (db, warehouseId, skuId, batchNo) =>
  Number(
    db
      .prepare(
        `SELECT IFNULL(SUM(qty_on_hand - qty_reserved),0) q FROM inventory_stocks
          WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,'')=IFNULL(?,'')`
      )
      .get(warehouseId, skuId, batchNo || '').q
  )

/**
 * 把报检明细的**数量压到现货以内**（向下取到分，绝不四舍五入超过现货）。
 *
 * 为什么必须做：四种处置全部会真的动库存了 —— 报废/退货直接出库，让步/返工自动
 * 生成调拨单（原仓先出库）。报检数量一旦超过该批次的净可用量，处置执行到一半就会
 * 抛"库存不足"，而 seed 外层的 try/catch 会**静默吞掉整块演示数据**：
 * 界面上表现为"少了一种处置"，没有任何红字提示，只有对着数据集才看得出来。
 * 只报现货以内的量不是"缩水"，而是"这批货真实能处置多少"。
 */
const cappedItems = (db, warehouseId, sourceItems) =>
  (sourceItems || [])
    .map((it) => ({
      source_item_id: it.source_item_id ?? null,
      sku_id: it.sku_id,
      batch_no: it.batch_no || '',
      // Math.floor(...) 而不是 round2：四舍五入可能把 584.878 变成 584.88 > 现货，
      // 于是又回到"处置执行到一半库存不足"的老问题上。
      qty: Math.min(Number(it.qty), Math.floor(availOf(db, warehouseId, it.sku_id, it.batch_no) * 100) / 100)
    }))
    .filter((x) => x.qty > 0)

export function seedQc(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) console.log(m) }
  const actor = { id: null, name: '演示数据' }

  // 幂等：已经造过报检单就不再造（否则单号一直往后跑，演示数据越堆越多）
  if (db.prepare('SELECT COUNT(*) AS c FROM qc_requests').get().c > 0) return { skipped: true }

  const out = {
    requests: 0, qualified: 0, unqualified: 0,
    concession: 0, returned: 0, scrap: 0, rework: 0,
    pending_inspect: 0, draft: 0, draft_handlings: 0
  }

  const receipts = db
    .prepare(
      `SELECT rc.* FROM purchase_receipts rc
        WHERE rc.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM qc_requests q WHERE q.source_type='purchase_receipt' AND q.source_id=rc.id AND q.status<>'cancelled')
          AND NOT EXISTS (SELECT 1 FROM purchase_inspections i WHERE i.receipt_id=rc.id AND i.status NOT IN ('cancelled','draft'))
        ORDER BY rc.receipt_date DESC, rc.id DESC`
    )
    .all()
  const productions = db
    .prepare(
      `SELECT po.* FROM production_orders po
        WHERE po.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM qc_requests q WHERE q.source_type='production_order' AND q.source_id=po.id AND q.status<>'cancelled')
        ORDER BY po.id DESC`
    )
    .all()

  // -------------------------------------------------------------------------
  // ① 采购到货 → 全合格（自动关闭报检单，界面上看到"没有处置"是正常的）
  // -------------------------------------------------------------------------
  if (receipts[0]) {
    try {
      const req = createRequest(db, { sourceType: 'purchase_receipt', sourceId: receipts[0].id, requestDate: dayOffset(-6), remark: '【演示】到货抽检：全合格', actor })
      const sub = submitRequest(db, { id: req.id, actor })
      // 不良数取「恰好等于 Ac」—— 覆盖判定边界（≤ Ac 判合格），这是最容易写错的一格
      const lines = sub.inspection.items.map((it) => ({ id: it.id, defect_qty: Math.min(it.sample_qty, it.ac), defect_code: 'appearance' }))
      const insp = submitInspection(db, { id: sub.inspection.id, lines, actor })
      out.requests++
      if (insp.result === 'qualified') out.qualified++
      // 全部合格 → 报检单应已自动关闭（这里不做断言，测试脚本会验证）
    } catch { /* 库存或状态不符，跳过 */ }
  }

  // -------------------------------------------------------------------------
  // ② 采购到货 → 让步接收 + 退货（同一行拆两种处置 → 汇总为「混合处置」）
  //    这是最能说明问题的一张：同一批里，一部分降级收下（调拨入不合格仓）、一部分退回供应商。
  //    两种处置挂**同一行**、数量合计盖住报检数量，报检单才会自动关闭 ——
  //    「只处置一部分就关单」正是要避免的失效（剩下的不良品会没人管）。
  //    报检数量先压到现货以内：两种处置现在都要真的出库。
  // -------------------------------------------------------------------------
  if (receipts[1]) {
    try {
      const rec = sourceDetail(db, 'purchase_receipt', receipts[1].id)
      const items = cappedItems(db, rec.warehouse_id, rec.items)
      if (!items.length) throw new Error('该到货单现货不足，跳过')
      const req = createRequest(db, { sourceType: 'purchase_receipt', sourceId: receipts[1].id, items, requestDate: dayOffset(-4), remark: '【演示】抽检不合格：让步 + 退货', actor })
      const sub = submitRequest(db, { id: req.id, actor })
      const insp = submitInspection(db, { id: sub.inspection.id, lines: defectsFor(sub.inspection.items, true), actor })
      out.requests++
      if (insp.result === 'unqualified') out.unqualified++
      const unq = insp.items.filter((x) => x.result === 'unqualified')
      const line = unq[0]
      if (line) {
        const total = Number(line.qty)
        // 报检量已 ≤ 现货，故 retQty + conQty = total 一定能被现货盖住
        const stock = availOf(db, insp.warehouse_id, line.sku_id, line.batch_no)
        let retQty = Math.min(stock, Math.max(1, Math.round(total * 0.3 * 100) / 100))
        if (retQty >= total) retQty = Math.round(total * 0.5 * 100) / 100
        if (!(retQty > 0)) retQty = 0
        const conQty = Math.round((total - retQty) * 100) / 100
        if (retQty > 0) {
          const h = createHandling(db, {
            inspectionId: insp.id, skuId: line.sku_id, batchNo: line.batch_no,
            qty: retQty, mode: 'return',
            reason: '规格不符，退回供应商换货', defectCode: line.defect_code, actor
          })
          confirmHandling(db, { id: h.id, actor })
          out.returned++
        }
        if (conQty > 0) {
          const h = createHandling(db, {
            inspectionId: insp.id, skuId: line.sku_id, batchNo: line.batch_no,
            qty: conQty, mode: 'concession',
            reason: '客户交期紧急且外观瑕疵不影响使用，经品质与销售会签后降级接收',
            defectCode: line.defect_code, actor
          })
          confirmHandling(db, { id: h.id, actor })
          out.concession++
        }
        // 其余不合格行一律降级接收（调拨入不合格仓）：报检量已逐行压到现货以内，
        // 所以每一行都挪得动。目的是让整单**处置满** —— 只要还有一行没处置完，
        // 报检单就不会关闭，演示数据里就看不到一张「混合处置已完成」的完整单子。
        for (const other of unq.slice(1)) {
          const h = createHandling(db, {
            inspectionId: insp.id, skuId: other.sku_id, batchNo: other.batch_no,
            qty: Number(other.qty), mode: 'concession',
            reason: '其余不良为轻微外观问题，经品质确认降级接收', defectCode: other.defect_code, actor
          })
          confirmHandling(db, { id: h.id, actor })
          out.concession++
        }
      }
    } catch { /* 跳过 */ }
  }

  // -------------------------------------------------------------------------
  // ③ 采购到货 → 报废（执行时真的出库）
  // -------------------------------------------------------------------------
  if (receipts[2]) {
    try {
      const rec = sourceDetail(db, 'purchase_receipt', receipts[2].id)
      const items = cappedItems(db, rec.warehouse_id, rec.items)
      if (!items.length) throw new Error('该到货单现货不足，跳过')
      const req = createRequest(db, { sourceType: 'purchase_receipt', sourceId: receipts[2].id, items, requestDate: dayOffset(-3), remark: '【演示】抽检不合格：报废', actor })
      const sub = submitRequest(db, { id: req.id, actor })
      const insp = submitInspection(db, { id: sub.inspection.id, lines: defectsFor(sub.inspection.items, true), actor })
      out.requests++
      if (insp.result === 'unqualified') out.unqualified++
      const it = insp.items.find((x) => x.result === 'unqualified')
      if (it) {
        const h = createHandling(db, {
          inspectionId: insp.id, skuId: it.sku_id, batchNo: it.batch_no,
          qty: Math.min(Number(it.qty), 6), mode: 'scrap',
          reason: '包装破损且内容物受污染，不具备使用条件', defectCode: 'packaging', actor
        })
        confirmHandling(db, { id: h.id, actor })
        out.scrap++
        // 刻意留一条**没执行**的处置草稿：不留中间态，界面上就看不到「执行」这个动作，
        // 也看不到「报检单因为还有处置没执行而保持打开」这条规则在起作用。
        // 挂在这里（同一行还有剩余可处置量）是为了让它**每个行业都必有一条** ——
        // 依赖「来源单至少有三行」的写法会时有时无，演示数据不该看运气。
        const remain = Number(it.qty) - Math.min(Number(it.qty), 6)
        if (remain > 0.005) {
          createHandling(db, {
            inspectionId: insp.id, skuId: it.sku_id, batchNo: it.batch_no,
            qty: Math.min(remain, 4), mode: 'rework',
            reason: '待品质主管确认返工方案（留一条未执行的处置，演示执行动作）', defectCode: 'quality', actor
          })
          out.draft_handlings++
        }
      }
    } catch { /* 跳过 */ }
  }

  // -------------------------------------------------------------------------
  // ④ 生产完工 → 返工（自动调拨入待检仓，货从成品仓挪到待检区）
  //    生产来源的质检是模块 07 完全没有的能力 —— 以前完工入库就是终点，没人判过。
  // -------------------------------------------------------------------------
  if (productions[0]) {
    try {
      const pod = sourceDetail(db, 'production_order', productions[0].id)
      const pItems = cappedItems(db, pod.warehouse_id, pod.items)
      if (!pItems.length) throw new Error('该生产订单完工货已无现货，跳过')
      const req = createRequest(db, { sourceType: 'production_order', sourceId: productions[0].id, items: pItems, requestDate: dayOffset(-2), remark: '【演示】完工检验：返工', actor })
      const sub = submitRequest(db, { id: req.id, actor })
      const insp = submitInspection(db, { id: sub.inspection.id, lines: defectsFor(sub.inspection.items, true), actor })
      out.requests++
      if (insp.result === 'unqualified') out.unqualified++
      const it = insp.items.find((x) => x.result === 'unqualified')
      if (it) {
        const h = createHandling(db, {
          inspectionId: insp.id, skuId: it.sku_id, batchNo: it.batch_no,
          // 返工现在会真的把货调拨进待检仓，所以数量不能超过该批现货；
          // 报检量已按现货封顶，这里直接盖住整行即可（处置满，报检单才会自动关闭）。
          qty: Number(it.qty), mode: 'rework',
          reason: '外观可返修，退回待检仓抛光后重新报检', defectCode: 'appearance', actor
        })
        confirmHandling(db, { id: h.id, actor })
        out.rework++
      }
    } catch { /* 跳过 */ }
  }

  // -------------------------------------------------------------------------
  // ⑤ 在库复检 → 已报检、**未出结论**（让「待检」工作台有内容）
  //    留一个中间态是刻意的：只有"已完成"的工作台，看不出流程是怎么走的。
  // -------------------------------------------------------------------------
  try {
    const stockRow = db
      .prepare(
        `SELECT s.warehouse_id, s.sku_id, IFNULL(s.batch_no,'') AS batch_no, s.qty_on_hand
           FROM inventory_stocks s
          WHERE s.qty_on_hand > 20
          ORDER BY s.qty_on_hand DESC LIMIT 1`
      )
      .get()
    if (stockRow) {
      const req = createRequest(db, {
        sourceType: 'inventory', sourceId: 0, requestDate: dayOffset(-1),
        warehouseId: stockRow.warehouse_id,
        items: [{ sku_id: stockRow.sku_id, batch_no: stockRow.batch_no, qty: Math.min(Number(stockRow.qty_on_hand), 60) }],
        remark: '【演示】在库复检：效期临近，抽样送检（待出结论）', actor
      })
      submitRequest(db, { id: req.id, actor })
      out.requests++
      out.pending_inspect++
    }
  } catch { /* 跳过 */ }

  // -------------------------------------------------------------------------
  // ⑥ 草稿报检单（还没提交 —— 界面上能演示「提交报检」这个动作）
  // -------------------------------------------------------------------------
  if (receipts[3]) {
    try {
      createRequest(db, { sourceType: 'purchase_receipt', sourceId: receipts[3].id, requestDate: dayOffset(-1), level: 'tightened', remark: '【演示】新供应商首批，加严检验（草稿，未提交）', actor })
      out.requests++
      out.draft++
    } catch { /* 跳过 */ }
  }

  say(
    `[qc] 演示质检：报检单 ${out.requests}（草稿 ${out.draft} / 待出结论 ${out.pending_inspect}）｜` +
      `结论 合格 ${out.qualified} / 不合格 ${out.unqualified}｜处置 让步 ${out.concession} 退货 ${out.returned} 报废 ${out.scrap} 返工 ${out.rework}（另留未执行 ${out.draft_handlings}）`
  )
  return out
}

/** 供其它 seed / 测试复用的抽样参数（口径只此一处） */
export { samplingPlan }

export default { seedQc }
