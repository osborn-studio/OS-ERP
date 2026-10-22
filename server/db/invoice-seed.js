/**
 * ============================================================================
 * 文件标识：server/db/invoice-seed.js ｜ 销售发票演示数据（模块 24）
 * ============================================================================
 * 【职责】销售发票演示数据（模块 24）
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
 * 销售发票演示数据（模块 24）
 *
 * 与报价/信用/应收同一原则：**每一条数据都能讲一个故事**，
 * 而不是把表填满。造出来的东西必须能回答界面上的三个问题：
 *   ① 哪些货发了、票还没开？（待开票队列里留一大批，这是财务每天开工第一眼看的地方）
 *   ② 开出去的票对应哪笔债权？（一批已确认票关联到订单应收，口径 SO）
 *   ③ 开错了怎么办？（一张手工票走完"确认 → 红冲"，原票 + 红字票两张都在）
 *
 * 为什么红冲演示用**手工票**而不是发货票：
 *   发货票在 SO 口径下会关联到订单已有的应收，红冲会把那张应收置为作废，
 *   从而破坏模块 21（应收）的演示数据。手工票确认时会新建一张 SI 应收，
 *   红冲只影响它自己，干净利落。
 *
 * 依赖：销售发货单（模块 24 的待开票队列来源）、经销商档案（手工票客户）。
 */
import { requireDemoDatabase } from './runtime-policy.js'
import {
  createInvoiceFromDelivery, createManualInvoice,
  submitInvoice, confirmInvoice, redChartInvoice
} from '../lib/invoice.js'
import { seedNow } from './seed-clock.js'

const dayOffset = (n) => {
  const d = new Date(seedNow())
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function seedInvoice(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) console.log(m) }
  const actor = { id: null, name: '演示数据' }

  // 幂等：已经造过发票就不再造（否则单据编号会一直往后跑）
  if (db.prepare('SELECT COUNT(*) AS c FROM sales_invoices').get().c > 0) return { skipped: true }

  const deliveries = db
    .prepare(
      `SELECT d.* FROM sales_deliveries d
       WHERE d.status IN ('shipped','received')
       ORDER BY d.delivery_date DESC, d.id DESC LIMIT 12`
    )
    .all()
  if (!deliveries.length) return { skipped: true }

  const created = { confirmed: 0, pending: 0, red: 0, linked: 0, created_ar: 0 }

  // ① 一批"已开票"：确认后参与开票关闭；SO 口径下关联订单已有的应收
  for (const d of deliveries.slice(0, 7)) {
    try {
      const inv = createInvoiceFromDelivery(db, {
        deliveryId: d.id,
        invoiceDate: d.delivery_date,
        invoiceNo: `FP${String(d.id).padStart(8, '0')}`,
        taxRate: 0.13,
        actor
      })
      submitInvoice(db, { id: inv.id, actor })
      const out = confirmInvoice(db, { id: inv.id, actor })
      created.confirmed++
      if (out.relation === 'linked') created.linked++
      else created.created_ar++
    } catch {
      /* 该发货单可能已无可开行（其它 seed 开过），跳过不影响整体 */
    }
  }

  // ② 一张"待确认"：停在 pending，界面上能演示"确认开票"这个动作
  const pendSrc = deliveries[7]
  if (pendSrc) {
    try {
      const inv = createInvoiceFromDelivery(db, {
        deliveryId: pendSrc.id,
        invoiceDate: dayOffset(-1),
        invoiceNo: null,
        taxRate: 0.13,
        actor
      })
      submitInvoice(db, { id: inv.id, actor })
      created.pending++
    } catch {
      /* 跳过 */
    }
  }

  // ③ 一张"红冲"：手工票走完 确认 → 红冲，原票留痕 + 生成红字票
  const dealer = db.prepare('SELECT id, name FROM dealers ORDER BY id LIMIT 1').get()
  if (dealer) {
    try {
      const m = createManualInvoice(db, {
        subjectType: 'dealer',
        subjectId: dealer.id,
        subjectName: dealer.name,
        invoiceDate: dayOffset(-3),
        invoiceNo: 'FP-RED-DEMO',
        taxRate: 0.13,
        items: [
          { sku_id: null, qty: 20, price: 113, tax_rate: 0.13 },
          { sku_id: null, qty: 5, price: 226, tax_rate: 0.13 }
        ],
        remark: '手工补开历史票（演示：红冲）',
        actor
      })
      submitInvoice(db, { id: m.id, actor })
      confirmInvoice(db, { id: m.id, actor })
      redChartInvoice(db, { id: m.id, reason: '开票信息有误（金额与合同不符），红冲重开', actor })
      created.red++
    } catch {
      /* 跳过 */
    }
  }

  say(`[invoice] 演示发票：已确认 ${created.confirmed}（关联既有应收 ${created.linked} / 新建应收 ${created.created_ar}）、待确认 ${created.pending}、红冲演示 ${created.red}`)
  return created
}

export default { seedInvoice }
