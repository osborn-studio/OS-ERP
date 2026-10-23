/**
 * ============================================================================
 * 文件标识：server/lib/qc2.js ｜ 质量检验服务层（模块 13 · 报检 / 检验 / 不良品处理）
 * ============================================================================
 * 【职责】质量检验服务层（模块 13 · 报检 / 检验 / 不良品处理）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 质量检验服务层（模块 13 · 报检 / 检验 / 不良品处理）
//
// 一句话说清这条链在解决什么：**把「判断」从「事实」里摘出来，并且让它有后果。**
//
//   事实：货来了多少、完工了多少 —— 在采购到货单 / 生产订单上，不是本模块的事。
//   判断：收不收、收多少、不合格的怎么办 —— 本模块三段：
//     QCR 报检 —— 谁来检、按什么抽样方案（发起权在仓库/生产）
//     QCI 检验 —— 判的结果（执行权在质检岗）
//     DH  不良品处理 —— 让步 / 退货 / 报废 / 返工（决策权在品质/生产，**有库存后果**）
//
// 三条口径（写死在代码里，不靠人自觉）：
//   ① **判定由数字推导，不由人选。** 不良数 ≤ Ac 判合格，> Ac 判不合格。
//      让人手选结论，就会出现「不良 5 个却点了合格」，而系统毫无察觉 —— 这是质检最怕的失效。
//   ② **抽样量 ≤ 报检数量、不良数 ≤ 抽样量**。不成立说明填反了，写库前拦住。
//   ③ **处置必须有后果**：四种处置**都会真的动库存** —— 退货 / 报废直接出库；
//      让步 / 返工自动生成一张调拨单把货挪进隔离仓（不合格仓 / 待检仓），出库与入库都真的发生。
//      一张只改状态的处理单等于没处理 —— 它是质检存在的意义所在。
//
// 一处**刻意的简化**（写清楚比含糊过去好）：
//   抽样表用的是 AQL 2.5 · 一般检验水平 II 的**通行单次抽样数字**（n / Ac / Re），
//   不含宽严转换的完整规则。`inspect_level` 只做一档线性调整（加严 Ac-1 / 放宽 Ac+1），
//   目的是让「方案可追溯、可复现」，而不是宣称符合某版国标的全部条款。
//   真要对接客户的抽样标准，改 `SAMPLE_TABLE` 一处即可，口径已经收在这一个函数里。

import { applyTransition } from './docflow.js'
import { nextDocNoAuto } from './docno.js'
import { applyStockOut, stockScopeSql, warehouseInScope } from './stock.js'
import { createPurchaseReturn } from './purchase.js'
// 处置即调拨：让步 / 返工要**自动生成一张真实的调拨单**（原仓出库 + 隔离仓入库）。
// 出入库与成本回写的实现只有一份（`lib/transfer.js`，库存页面开调拨单走的是同一份）。
import { createTransfer, receiveTransfer, shipTransfer, assertTransferTargetsInScope } from './transfer.js'

// ---------------------------------------------------------------------------
// 基础工具：一律用**本地时间**。
// 用 toISOString() 会在东八区晚上 8 点之后把日期算成「明天」（UTC 已跨日），
// 报检日期、检验日期都是业务日，差一天就会让「今天的报检」落到昨天，账龄类口径全错。
// ---------------------------------------------------------------------------
// 本地日期/时间统一来自 dates.js（本项目只留一处实现，见该文件模块注释）。
// 保留 re-export：本模块对外（含默认导出）一直暴露 localDate / localNow。
export { localDate, localNow } from './dates.js'
import { localDate, localNow } from './dates.js'
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000
const num = (v) => Number(v) || 0

// `actor = {}` 这种参数默认值**只在实参是 undefined 时生效**：调用方显式传 null
// （脚本、内部调用、路由没带用户时很常见）会原样穿到底，然后在 `actor.id` 上炸成
// TypeError —— 报出的错跟真实原因毫无关系。所以每个公开入口都过一道这个收敛，
// 出处只有这一处，别再各写各的 `actor.id || null`。
const actorOf = (a) => (a && typeof a === 'object' ? a : {})

export class QC2Error extends Error {
  constructor(message, { code = 'QC2_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'QC2Error'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

export const SOURCE_LABEL = {
  purchase_receipt: '采购到货',
  production_order: '生产完工',
  inventory: '在库复检'
}

export const RESULT_LABEL = { pending: '待检', qualified: '合格', unqualified: '不合格' }

export const MODE_LABEL = {
  concession: '让步接收',
  return: '退货',
  scrap: '报废',
  rework: '返工'
}

export const DISPOSITION_LABEL = {
  none: '未处置',
  concession: '让步接收',
  return: '退货',
  scrap: '报废',
  rework: '返工',
  mixed: '混合处置'
}

export const DEFECT_CODES = [
  { value: 'appearance', label: '外观不良' },
  { value: 'spec', label: '规格不符' },
  { value: 'packaging', label: '包装破损' },
  { value: 'expiry', label: '效期不足' },
  { value: 'batch', label: '批次错误' },
  { value: 'quality', label: '性能不达标' },
  { value: 'hygiene', label: '卫生指标' },
  { value: 'other', label: '其它' }
]

// ---------------------------------------------------------------------------
// 一、抽样方案
// ---------------------------------------------------------------------------
// 表按「批量区间」查：区间下界升序，取第一个满足 `lot <= max` 的行。
// Ac 是接收数、Re 是拒收数；判定只看「不良数 > Ac 即不合格」，
// 因为表里 Re = Ac + 1，两者等价 —— 但 Re 仍要存下来，它是给**审阅单据的人**看的。
export const SAMPLE_TABLE = [
  { max: 8, n: 2, ac: 0, re: 1, code: 'A' },
  { max: 15, n: 3, ac: 0, re: 1, code: 'B' },
  { max: 25, n: 5, ac: 0, re: 1, code: 'C' },
  { max: 50, n: 8, ac: 0, re: 1, code: 'D' },
  { max: 90, n: 13, ac: 1, re: 2, code: 'E' },
  { max: 150, n: 20, ac: 1, re: 2, code: 'F' },
  { max: 280, n: 32, ac: 2, re: 3, code: 'G' },
  { max: 500, n: 50, ac: 3, re: 4, code: 'H' },
  { max: 1200, n: 80, ac: 5, re: 6, code: 'J' },
  { max: 3200, n: 125, ac: 7, re: 8, code: 'K' },
  { max: 10000, n: 200, ac: 10, re: 11, code: 'L' },
  { max: 35000, n: 315, ac: 14, re: 15, code: 'M' },
  { max: 150000, n: 500, ac: 21, re: 22, code: 'N' },
  { max: 500000, n: 800, ac: 21, re: 22, code: 'P' },
  { max: Infinity, n: 1250, ac: 21, re: 22, code: 'Q' }
]

/**
 * 抽样方案：给定批量与检验水平，返回 { sample_qty, ac, re, code, level }。
 *
 * 三条规则要写清楚，否则不同人算出来不一样：
 *   ① 抽样量不超过批量（小批量的货不可能抽得比它自己还多）→ 全检；
 *   ② 样本量向下取整到整数（件数只能是整数）；
 *   ③ 加严 / 放宽只调 Ac，不调 n —— 调 n 会让「同一批货」在两次检验里
 *      用不同样本量，复现不了；调 Ac 是标准里也在做的事。
 */
export function samplingPlan(lotQty, level = 'normal') {
  const lot = Math.max(0, Math.ceil(num(lotQty)))
  const row = SAMPLE_TABLE.find((r) => lot <= r.max) || SAMPLE_TABLE[SAMPLE_TABLE.length - 1]
  let n = Math.min(row.n, Math.max(lot, 1))
  n = Math.max(1, Math.floor(n))
  let ac = row.ac
  if (level === 'tightened') ac = Math.max(0, ac - 1)
  else if (level === 'reduced') ac = ac + 1
  return { sample_qty: n, ac, re: ac + 1, code: row.code, level }
}

/** 判定：**只看数字**。不良数 ≤ Ac 合格，否则不合格。 */
function judge(defectQty, ac) {
  return num(defectQty) <= num(ac) ? 'qualified' : 'unqualified'
}

// ---------------------------------------------------------------------------
// 二、待检来源
// ---------------------------------------------------------------------------

/**
 * 待检来源清单。直接读视图 `v_qc_pending_source`，不在 JS 里拼 union ——
 * 采购到货与生产完工是两张表、字段名都不同，写在 JS 里就意味着「排除已报检」
 * 这条判据要在每个调用点各写一遍，只要有人漏一处，同一批货就会被检两次。
 */
export function pendingSources(db, q = {}) {
  const where = []
  const args = []
  if (q.sourceType) {
    where.push('source_type = ?')
    args.push(q.sourceType)
  }
  if (q.keyword) {
    where.push('(source_doc_no LIKE ? OR subject_name LIKE ?)')
    args.push(`%${q.keyword}%`, `%${q.keyword}%`)
  }
  if (q.warehouseId) {
    where.push('warehouse_id = ?')
    args.push(q.warehouseId)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000)
  return db
    .prepare(
      `SELECT source_type, source_id, source_doc_no, warehouse_id, warehouse_name,
              supplier_id, subject_name, biz_date, qty, sku_id, source_status, ref_id
         FROM v_qc_pending_source ${w}
        ORDER BY biz_date DESC, source_id DESC
        LIMIT ?`
    )
    .all(...args, limit)
    .map((r) => ({ ...r, source_label: SOURCE_LABEL[r.source_type] || r.source_type }))
}

/**
 * 生产完工来源的成品批次号。
 *
 * 完工入库时批次由 `lib/mfg.js` 的 `completeOrder` 生成并写在 `work_reports.batch_no`
 * （同时落进 `inventory_batches` 与入库流水）。回检这条链过去完全不读它，
 * 于是报检行的批次恒为空串 —— 一个空批次会同时打坏两件事：
 *   · 检验结论写不回批次 ⇒ 判不合格的成品仍可拣选（M4）；
 *   · 报废/退料处置拿着空批次出库 ⇒ 库存引擎按拣选规则**跨批次**扣货，扣的是别人的批次（M15）。
 * 兜底顺序：完工汇报 → 该 MO 的入库流水。都取不到才返回空串（由调用方决定拒绝还是放行）。
 */
function productionBatchNo(db, orderId) {
  const r = db
    .prepare(
      "SELECT batch_no FROM work_reports WHERE order_id=? AND batch_no IS NOT NULL AND batch_no<>'' ORDER BY id DESC LIMIT 1"
    )
    .get(orderId)
  if (r?.batch_no) return r.batch_no
  const t = db
    .prepare(
      "SELECT batch_no FROM inventory_transactions WHERE doc_type='MO' AND doc_id=? AND direction='in' AND batch_no IS NOT NULL AND batch_no<>'' ORDER BY id DESC LIMIT 1"
    )
    .get(orderId)
  return t?.batch_no || ''
}

/** 装填：来源单据的行（前端一屏填完，不用先建后改） */
export function sourceDetail(db, sourceType, sourceId) {
  if (!sourceType || !sourceId) return null
  if (sourceType === 'purchase_receipt') {
    const head = db
      .prepare(
        `SELECT rc.*, s.name AS supplier_name, w.name AS warehouse_name, o.doc_no AS order_no
           FROM purchase_receipts rc
           LEFT JOIN suppliers s ON s.id = rc.supplier_id
           LEFT JOIN warehouses w ON w.id = rc.warehouse_id
           LEFT JOIN purchase_orders o ON o.id = rc.order_id
          WHERE rc.id = ?`
      )
      .get(sourceId)
    if (!head) return null
    const items = db
      .prepare(
        `SELECT ri.id AS source_item_id, ri.sku_id, ri.batch_no, ri.qty, ri.price,
                sk.name AS sku_name, sk.sku_code, sk.spec
           FROM purchase_receipt_items ri
           LEFT JOIN product_skus sk ON sk.id = ri.sku_id
          WHERE ri.receipt_id = ? ORDER BY ri.id`
      )
      .all(sourceId)
    return {
      source_type: sourceType,
      source_label: SOURCE_LABEL[sourceType],
      source_id: head.id,
      source_doc_no: head.doc_no,
      source_status: head.status,
      warehouse_id: head.warehouse_id,
      warehouse_name: head.warehouse_name,
      supplier_id: head.supplier_id,
      subject_name: head.supplier_name,
      biz_date: head.receipt_date,
      ref_no: head.order_no,
      items
    }
  }
  if (sourceType === 'production_order') {
    const head = db
      .prepare(
        `SELECT po.*, sk.name AS product_name, sk.sku_code AS product_code, w.name AS warehouse_name
           FROM production_orders po
           LEFT JOIN product_skus sk ON sk.id = po.product_sku_id
           LEFT JOIN warehouses w ON w.id = po.warehouse_id
          WHERE po.id = ?`
      )
      .get(sourceId)
    if (!head) return null
    const qty = num(head.completed_qty) > 0 ? num(head.completed_qty) : num(head.qty)
    return {
      source_type: sourceType,
      source_label: SOURCE_LABEL[sourceType],
      source_id: head.id,
      source_doc_no: head.doc_no,
      source_status: head.status,
      warehouse_id: head.warehouse_id,
      warehouse_name: head.warehouse_name,
      supplier_id: null,
      subject_name: '生产车间',
      biz_date: localDate(head.updated_at || head.created_at),
      ref_no: null,
      items: [
        {
          source_item_id: null,
          sku_id: head.product_sku_id,
          // 生产来源原来恒为空串：检验结论就永远写不回批次（见 submitInspection 的
          // `if (bn && it.sku_id)`），不合格成品照样能被拣选；报废处置也会拿着空批次
          // 触发跨批次拣选、扣掉别人的批次。所以这里必须把该 MO 的**已入库批次**带上。
          batch_no: productionBatchNo(db, head.id),
          qty,
          price: num(head.unit_cost),
          sku_name: head.product_name,
          sku_code: head.product_code,
          spec: null
        }
      ]
    }
  }
  // 在库复检：没有来源单据的行，由调用方提供 items
  return {
    source_type: sourceType, source_label: SOURCE_LABEL[sourceType] || sourceType,
    source_id: sourceId, source_doc_no: null, source_status: null,
    warehouse_id: null, warehouse_name: null, supplier_id: null, subject_name: '在库复检',
    biz_date: localDate(), ref_no: null, items: []
  }
}

// ---------------------------------------------------------------------------
// 三、报检（QCR）
// ---------------------------------------------------------------------------

/**
 * 建报检单（草稿）。
 *
 * 建单时**就把抽样方案算好写进行里**，而不是检验时现算：
 * 现算意味着「今天算和明天算可能不一样」（参数被改了），判过的案子再也复现不了。
 */
export function createRequest(db, p = {}) {
  const { sourceType, sourceId, requestDate = null, aql = 2.5, level = 'normal', items = null, remark = null, actor: actorRaw = null } = p
  const actor = actorOf(actorRaw)
  if (!sourceType) throw new QC2Error('缺少报检来源类型', { code: 'QC2_NO_SOURCE' })
  if (!SOURCE_LABEL[sourceType]) {
    throw new QC2Error(`不认识的报检来源：${sourceType}`, { code: 'QC2_BAD_SOURCE' })
  }

  const date = localDate(requestDate || new Date())
  let head = null
  let lines = []

  if (sourceType === 'inventory') {
    // 在库复检：没有来源单据，必须由调用方给出「检哪些 SKU、多少数量」
    if (!Array.isArray(items) || !items.length) {
      throw new QC2Error('在库复检必须在建单时指定报检明细', { code: 'QC2_NO_ITEMS' })
    }
    lines = items.map((it, i) => ({
      source_item_id: null,
      sku_id: it.sku_id || null,
      batch_no: it.batch_no || '',
      qty: num(it.qty),
      price: num(it.price),
      sku_name: it.sku_name || null,
      sku_code: it.sku_code || null,
      spec: it.spec || null
    }))
    if (!p.warehouseId) throw new QC2Error('在库复检必须指定仓库', { code: 'QC2_NO_WAREHOUSE' })
    head = { warehouse_id: p.warehouseId, supplier_id: null, subject_name: '在库复检', source_doc_no: null }
  } else {
    if (!sourceId) throw new QC2Error('缺少来源单据 id', { code: 'QC2_NO_SOURCE_ID' })
    // 幂等与防重：有未作废的报检单就拒绝，报出单号让人去改那张
    const exist = db
      .prepare("SELECT id, doc_no, status FROM qc_requests WHERE source_type=? AND source_id=? AND status<>'cancelled'")
      .get(sourceType, sourceId)
    if (exist) {
      throw new QC2Error(`该来源已有报检单 ${exist.doc_no}（${exist.status}）`, {
        code: 'QC2_DUPLICATE', httpStatus: 409, detail: { request_id: exist.id, doc_no: exist.doc_no }
      })
    }
    const detail = sourceDetail(db, sourceType, sourceId)
    if (!detail) throw new QC2Error('来源单据不存在', { code: 'QC2_SOURCE_NOT_FOUND', httpStatus: 404 })
    if (sourceType === 'purchase_receipt' && detail.source_status !== 'received') {
      throw new QC2Error(`到货单当前为「${detail.source_status}」，只有「已收货」才能报检`, {
        code: 'QC2_SOURCE_NOT_READY', httpStatus: 409
      })
    }
    if (sourceType === 'production_order' && detail.source_status !== 'completed') {
      throw new QC2Error(`生产订单当前为「${detail.source_status}」，只有「已完工」才能报检`, {
        code: 'QC2_SOURCE_NOT_READY', httpStatus: 409
      })
    }
    // 行级 override：允许只报检其中一部分行 / 部分数量
    const override = Array.isArray(items) ? items : []
    lines = detail.items
      .map((it) => {
        const o = override.find((x) => Number(x.source_item_id) === Number(it.source_item_id) && it.source_item_id != null)
          || override.find((x) => Number(x.sku_id) === Number(it.sku_id) && x.batch_no === it.batch_no)
          || (override.length ? null : {})
        if (!o) return null
        const qty = o.qty != null ? num(o.qty) : num(it.qty)
        if (qty <= 0) return null
        return { ...it, qty }
      })
      .filter(Boolean)
    if (!lines.length) throw new QC2Error('报检明细为空（来源单据没有行，或全部数量为 0）', { code: 'QC2_NO_ITEMS' })
    head = detail
  }

  for (const l of lines) {
    if (l.qty <= 0) throw new QC2Error(`SKU#${l.sku_id} 的报检数量必须大于 0`, { code: 'QC2_QTY_INVALID' })
  }

  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'QCR', bizDate: date, table: 'qc_requests' })
    const info = db
      .prepare(
        `INSERT INTO qc_requests
           (doc_no,source_type,source_id,source_doc_no,warehouse_id,supplier_id,subject_name,
            request_date,request_by,request_by_name,aql,inspect_level,total_qty,total_sample_qty,
            item_count,status,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,'draft',?,?,?,?,?)`
      )
      .run(
        docNo, sourceType, sourceId || null, head.source_doc_no || null, head.warehouse_id || null,
        head.supplier_id || null, head.subject_name || null,
        date, actor.id || null, actor.name || null, num(aql), level,
        lines.length, remark || null, actor.id || null, actor.name || null, localNow(), localNow()
      )
    const rid = info.lastInsertRowid

    const insItem = db.prepare(
      `INSERT INTO qc_request_items
         (request_id,line_no,sku_id,sku_code,sku_name,spec,batch_no,qty,sample_qty,ac,re,result,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`
    )
    let totalQty = 0
    let totalSample = 0
    lines.forEach((l, i) => {
      const plan = samplingPlan(l.qty, level)
      insItem.run(
        rid, i + 1, l.sku_id || null, l.sku_code || null, l.sku_name || null, l.spec || null,
        l.batch_no || '', round2(l.qty), plan.sample_qty, plan.ac, plan.re, null
      )
      totalQty += round2(l.qty)
      totalSample += plan.sample_qty
    })
    db.prepare('UPDATE qc_requests SET total_qty=?, total_sample_qty=? WHERE id=?')
      .run(round2(totalQty), totalSample, rid)
    return rid
  })

  return getRequest(db, tx())
}

/** 提交报检：同时生成一对一的检验单草稿 —— 「待检」这个工作台由检验单承载 */
export function submitRequest(db, { id, actor = {}, source = 'api', remark = null }) {
  actor = actorOf(actor)
  const head = db.prepare('SELECT * FROM qc_requests WHERE id=?').get(id)
  if (!head) throw new QC2Error('报检单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  if (head.status !== 'draft') {
    throw new QC2Error(`报检单当前为「${head.status}」，只有草稿能提交`, { code: 'QC2_STATE_INVALID', httpStatus: 409 })
  }

  const tx = db.transaction(() => {
    // 检验单草稿：与报检单一对一，唯一索引 uq_qci_request 兜底防重
    const exist = db.prepare('SELECT id FROM qc_inspections WHERE request_id=?').get(id)
    let iid = exist?.id
    if (!iid) {
      const docNo = nextDocNoAuto(db, { docType: 'QCI', bizDate: head.request_date, table: 'qc_inspections' })
      const info = db
        .prepare(
          `INSERT INTO qc_inspections
             (doc_no,request_id,request_no,source_type,source_id,source_doc_no,warehouse_id,supplier_id,
              inspect_date,aql,inspect_level,total_qty,sample_qty,defect_qty,defect_rate,
              result,disposition,handling_count,status,created_by,created_by_name,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'pending','none',0,'draft',?,?,?,?)`
        )
        .run(
          docNo, id, head.doc_no, head.source_type, head.source_id, head.source_doc_no,
          head.warehouse_id, head.supplier_id, head.request_date, head.aql, head.inspect_level,
          head.total_qty, head.total_sample_qty, actor.id || null, actor.name || null, localNow(), localNow()
        )
      iid = info.lastInsertRowid
    }
    db.prepare('UPDATE qc_requests SET inspection_id=?, inspection_no=(SELECT doc_no FROM qc_inspections WHERE id=?) WHERE id=?')
      .run(iid, iid, id)

    applyTransition({
      db, docType: 'QCR', id, action: 'submit',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: remark || '提交报检', source,
      set: { submitted_at: localNow(), updated_at: localNow() }
    })
    return iid
  })

  const iid = tx()
  return { request: getRequest(db, id), inspection: getInspection(db, iid) }
}

export function getRequest(db, id) {
  const head = db
    .prepare(
      `SELECT rq.*, w.name AS warehouse_name, s.name AS supplier_name
         FROM qc_requests rq
         LEFT JOIN warehouses w ON w.id = rq.warehouse_id
         LEFT JOIN suppliers s ON s.id = rq.supplier_id
        WHERE rq.id = ?`
    )
    .get(id)
  if (!head) return null
  const items = db
    .prepare('SELECT * FROM qc_request_items WHERE request_id=? ORDER BY line_no')
    .all(id)
  const events = db
    .prepare(
      `SELECT action, action_name, from_state, to_state, actor_name, remark, created_at
         FROM doc_events WHERE doc_type='QCR' AND doc_id=? ORDER BY id`
    )
    .all(id)
  return { ...head, source_label: SOURCE_LABEL[head.source_type] || head.source_type, items, events }
}

export function listRequests(db, q = {}) {
  const { page = 1, pageSize = 20, status = null, sourceType = null, keyword = null } = q
  const where = []
  const args = []
  if (status) { where.push('rq.status = ?'); args.push(status) }
  if (sourceType) { where.push('rq.source_type = ?'); args.push(sourceType) }
  if (keyword) {
    where.push('(rq.doc_no LIKE ? OR rq.source_doc_no LIKE ? OR rq.subject_name LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM qc_requests rq ${w}`).get(...args).c
  const offset = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT rq.*, w.name AS warehouse_name, s.name AS supplier_name,
              (SELECT COUNT(*) FROM qc_request_items i WHERE i.request_id=rq.id AND i.result='unqualified') AS unqualified_lines
         FROM qc_requests rq
         LEFT JOIN warehouses w ON w.id = rq.warehouse_id
         LEFT JOIN suppliers s ON s.id = rq.supplier_id
         ${w}
        ORDER BY rq.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
  return {
    rows: rows.map((r) => ({ ...r, source_label: SOURCE_LABEL[r.source_type] || r.source_type })),
    total, page: Math.max(1, page), pageSize
  }
}

// ---------------------------------------------------------------------------
// 四、检验（QCI）
// ---------------------------------------------------------------------------

export function getInspection(db, id) {
  const head = db
    .prepare(
      `SELECT ci.*, w.name AS warehouse_name, s.name AS supplier_name
         FROM qc_inspections ci
         LEFT JOIN warehouses w ON w.id = ci.warehouse_id
         LEFT JOIN suppliers s ON s.id = ci.supplier_id
        WHERE ci.id = ?`
    )
    .get(id)
  if (!head) return null
  const items = db
    .prepare('SELECT * FROM qc_request_items WHERE request_id=? ORDER BY line_no')
    .all(head.request_id)
  const handlings = db
    .prepare(
      `SELECT dh.*, u.name AS approved_by_real_name
         FROM qc_defect_handlings dh
         LEFT JOIN users u ON u.id = dh.approved_by
        WHERE dh.inspection_id=? ORDER BY dh.id`
    )
    .all(id)
  const events = db
    .prepare(
      `SELECT action, action_name, from_state, to_state, actor_name, remark, created_at
         FROM doc_events WHERE doc_type='QCI' AND doc_id=? ORDER BY id`
    )
    .all(id)
  const handledQty = handlings
    .filter((h) => h.status !== 'cancelled')
    .reduce((s, h) => s + num(h.qty), 0)
  const handledMap = new Map()
  for (const h of handlings) {
    if (h.status === 'cancelled') continue
    const k = `${h.sku_id ?? ''}|${h.batch_no || ''}`
    handledMap.set(k, (handledMap.get(k) || 0) + num(h.qty))
  }
  return {
    ...head,
    result_label: RESULT_LABEL[head.result] || head.result,
    disposition_label: DISPOSITION_LABEL[head.disposition] || head.disposition,
    source_label: SOURCE_LABEL[head.source_type] || head.source_type,
    items: items.map((it) => {
      const handled = handledMap.get(`${it.sku_id ?? ''}|${it.batch_no || ''}`) || 0
      return {
        ...it,
        result_label: RESULT_LABEL[it.result] || it.result,
        handled_qty: round2(handled),
        // 每行还能处置多少：报检数量 − 已开的处理单数量。前端据此限制输入，
        // 服务端在 createHandling 里再校验一次（前端限制只是体验，不是防线）
        remain_handle_qty: round2(num(it.qty) - handled)
      }
    }),
    handlings: handlings.map((h) => ({
      ...h,
      mode_label: MODE_LABEL[h.mode] || h.mode,
      source_label: SOURCE_LABEL[h.source_type] || h.source_type
    })),
    handled_qty: round2(handledQty),
    events
  }
}

export function listInspections(db, q = {}) {
  const { page = 1, pageSize = 20, status = null, result = null, keyword = null } = q
  const where = []
  const args = []
  if (status) { where.push('ci.status = ?'); args.push(status) }
  if (result) { where.push('ci.result = ?'); args.push(result) }
  if (keyword) {
    where.push('(ci.doc_no LIKE ? OR ci.request_no LIKE ? OR ci.source_doc_no LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM qc_inspections ci ${w}`).get(...args).c
  const offset = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT ci.*, w2.name AS warehouse_name,
              (SELECT COUNT(*) FROM qc_defect_handlings dh WHERE dh.inspection_id=ci.id AND dh.status='draft') AS draft_handlings
         FROM qc_inspections ci
         LEFT JOIN warehouses w2 ON w2.id = ci.warehouse_id
         ${w}
        ORDER BY ci.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
  return {
    rows: rows.map((r) => ({
      ...r,
      result_label: RESULT_LABEL[r.result] || r.result,
      disposition_label: DISPOSITION_LABEL[r.disposition] || r.disposition,
      source_label: SOURCE_LABEL[r.source_type] || r.source_type
    })),
    total, page: Math.max(1, page), pageSize
  }
}

/**
 * 提交检验结论（draft → inspected）。**这是检验唯一有后果的动作。**
 *
 * 顺序固定：
 *   ① 用传入的实测不良数覆盖行（并强校验 不良数 ≤ 抽样量 ≤ 报检数量）
 *   ② 逐行判定（不良数 vs Ac/Re）→ 回写报检行
 *   ③ 汇总到检验单头 + 走内核推进 QCI
 *   ④ 全部合格则自动关闭报检单（不用人工再点一次）；有不合格则等处置完再关
 *
 * 没有「跳过检验直接判合格」的入口 —— 结论必须由数字推出来。
 */
export function submitInspection(db, { id, lines = null, actor = {}, remark = null, source = 'api' }) {
  actor = actorOf(actor)
  const head = db.prepare('SELECT * FROM qc_inspections WHERE id=?').get(id)
  if (!head) throw new QC2Error('检验单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  if (head.status !== 'draft') {
    throw new QC2Error(`检验单当前为「${head.status}」，只有待检状态能提交结论`, {
      code: 'QC2_STATE_INVALID', httpStatus: 409
    })
  }

  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM qc_request_items WHERE request_id=? ORDER BY line_no').all(head.request_id)
    if (!items.length) throw new QC2Error('报检单没有明细行', { code: 'QC2_NO_ITEMS' })

    const upd = db.prepare(
      `UPDATE qc_request_items SET defect_qty=?, result=?, defect_code=?, defect_reason=?, remark=? WHERE id=?`
    )
    let totalQty = 0
    let totalSample = 0
    let totalDefect = 0
    let anyUnqualified = false

    for (const it of items) {
      const o = Array.isArray(lines) ? lines.find((x) => Number(x.id) === it.id) : null
      const defectQty = o && o.defect_qty != null ? round2(num(o.defect_qty)) : round2(num(it.defect_qty))
      if (defectQty < 0) throw new QC2Error(`SKU#${it.sku_id} 的不良数不能为负`, { code: 'QC2_QTY_INVALID' })
      if (defectQty - num(it.sample_qty) > 1e-6) {
        throw new QC2Error(
          `SKU#${it.sku_id} 的不良数 ${defectQty} 超过抽样量 ${it.sample_qty} —— 抽了 ${it.sample_qty} 个不可能有 ${defectQty} 个不良`,
          { code: 'QC2_DEFECT_OVER_SAMPLE', detail: { sku_id: it.sku_id, defect_qty: defectQty, sample_qty: it.sample_qty } }
        )
      }
      if (num(it.sample_qty) - num(it.qty) > 1e-6) {
        throw new QC2Error(
          `SKU#${it.sku_id} 的抽样量 ${it.sample_qty} 超过报检数量 ${it.qty}`,
          { code: 'QC2_SAMPLE_OVER_QTY', detail: { sku_id: it.sku_id, sample_qty: it.sample_qty, qty: it.qty } }
        )
      }
      const result = judge(defectQty, it.ac)
      if (result === 'unqualified') anyUnqualified = true
      upd.run(
        defectQty, result,
        o?.defect_code ?? it.defect_code ?? null,
        o?.defect_reason ?? it.defect_reason ?? null,
        o?.remark ?? it.remark ?? null,
        it.id
      )
      // ---------------------------------------------------------------------
      // 把检验结论**写回批次**（A13）。
      //
      // 为什么必须写：`inventory_batches.qc_status` 从建表那天起就是默认值 `pending`，
      // **没有任何代码写过它**。于是：
      //   · "不合格批次仍可拣选"这句话的根因不是"少判了一个 if"，而是这个字段是死的；
      //   · 库存引擎即使在拣选里判 `qc_status`，也永远看不到 `rejected`。
      // 结论落在单据上只解决了"这张单判过没"，解决不了"这批货还能不能卖" ——
      // 后者才是拣选、出库、销售真正要问的问题。两处都要有，且**以批次为准**。
      //
      // 报检行上没有批次号时不写（那批货还没定位到批次，属"在途"状态）。
      // ---------------------------------------------------------------------
      const bn = it.batch_no || null
      if (bn && it.sku_id) {
        const b = db.prepare('SELECT id, status FROM inventory_batches WHERE sku_id=? AND batch_no=?').get(it.sku_id, bn)
        if (b && b.status !== 'scrapped') {
          db.prepare("UPDATE inventory_batches SET qc_status=? WHERE id=?").run(
            result === 'unqualified' ? 'rejected' : 'qualified',
            b.id
          )
        }
      }
      totalQty += round2(num(it.qty))
      totalSample += num(it.sample_qty)
      totalDefect += defectQty
    }

    const result = anyUnqualified ? 'unqualified' : 'qualified'
    const defectRate = totalSample > 0 ? round4((totalDefect / totalSample) * 100) : 0
    db.prepare(
      `UPDATE qc_inspections
          SET total_qty=?, sample_qty=?, defect_qty=?, defect_rate=?, result=?,
              inspector_id=?, inspector_name=?, updated_at=?
        WHERE id=?`
    ).run(
      round2(totalQty), totalSample, round2(totalDefect), defectRate, result,
      actor.id || null, actor.name || null, localNow(), id
    )

    applyTransition({
      db, docType: 'QCI', id, action: 'inspect',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: remark || `检验完成：抽样 ${totalSample}，不良 ${round2(totalDefect)}，判定 ${RESULT_LABEL[result]}`,
      source, set: { updated_at: localNow() }
    })

    // 全部合格 → 报检单直接关；有不合格要等处置单全部执行完（见 refreshRequestClose）
    if (result === 'qualified') closeRequestIfDone(db, head.request_id, actor, source)

    return { result, totalQty, totalSample, totalDefect }
  })

  const out = tx()
  return { ...getInspection(db, id), summary: out }
}

/** 处置单全部执行完（且结论已下）→ 关闭报检单 */
function closeRequestIfDone(db, requestId, actor = {}, source = 'api') {
  actor = actorOf(actor)
  const rq = db.prepare('SELECT id, status, doc_no FROM qc_requests WHERE id=?').get(requestId)
  if (!rq || rq.status !== 'submitted') return false
  const ci = db.prepare('SELECT id, status, result FROM qc_inspections WHERE request_id=?').get(requestId)
  if (!ci || ci.status === 'draft') return false
  const open = db
    .prepare("SELECT COUNT(*) c FROM qc_defect_handlings WHERE inspection_id=? AND status='draft'")
    .get(ci.id).c
  // 每一行不合格都必须**处置完**，而不是「有处置单就行」。
  // 只看「有没有单」会漏掉「同一批不良品只处置了一部分」：那时报检单被关掉、
  // 剩下的不良品再也没人管 —— 而且这是**静默**的，界面上单子看起来一切正常。
  // 所以这里比的是数量：该行非作废处置单的数量合计要盖住报检数量。
  const unhandled = db
    .prepare(
      `SELECT COUNT(*) c FROM qc_request_items it
        WHERE it.request_id=? AND it.result='unqualified'
          AND IFNULL((SELECT SUM(dh.qty) FROM qc_defect_handlings dh
                       WHERE dh.inspection_id=? AND dh.sku_id IS it.sku_id
                         AND IFNULL(dh.batch_no,'')=IFNULL(it.batch_no,'')
                         AND dh.status<>'cancelled'), 0) + 0.005 < it.qty`
    )
    .get(requestId, ci.id).c
  if (open > 0 || unhandled > 0) return false

  applyTransition({
    db, docType: 'QCR', id: requestId, action: 'close',
    actor: { id: actor.id || null, name: actor.name || null },
    remark: '检验与处置完成，自动关闭', source, set: { updated_at: localNow() }
  })
  // 检验单跟着归档：同样走内核，别手写 status 与留痕 ——
  // 手写 doc_events 的那一版曾经漏了 doc_no，页面上会出现一条没有单号的流转记录。
  if (ci.status === 'inspected') {
    applyTransition({
      db, docType: 'QCI', id: ci.id, action: 'close',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: '随报检单关闭', source, set: { updated_at: localNow() }
    })
  }
  return true
}

/** 关闭 / 取消检验单（纯归档动作） */
export function transitionInspection(db, { id, action, actor = {}, remark = null, source = 'api' }) {
  actor = actorOf(actor)
  const head = db.prepare('SELECT * FROM qc_inspections WHERE id=?').get(id)
  if (!head) throw new QC2Error('检验单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  return applyTransition({
    db, docType: 'QCI', id, action,
    actor: { id: actor.id || null, name: actor.name || null },
    remark, source, set: { updated_at: localNow() }
  })
}

export function transitionRequest(db, { id, action, actor = {}, remark = null, source = 'api' }) {
  actor = actorOf(actor)
  const head = db.prepare('SELECT * FROM qc_requests WHERE id=?').get(id)
  if (!head) throw new QC2Error('报检单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  return applyTransition({
    db, docType: 'QCR', id, action,
    actor: { id: actor.id || null, name: actor.name || null },
    remark, source, set: { updated_at: localNow() }
  })
}

// ---------------------------------------------------------------------------
// 五、不良品处理（DH）
// ---------------------------------------------------------------------------

/**
 * 处置方式 → **目标隔离仓的仓库类型**。
 *
 * ⚠️ 这是「哪个处置 → 哪个目标仓」的**唯一出处**（客户口径落成一行常量）：
 *   让步接收 → 不合格品仓；返工 → 待检品仓。
 * 口径要调整（例如让步也进待检仓、或再加一档「降级仓」）时，只改这张表 ——
 * 目标仓按 `warehouses.type` 查，所以**不需要**按行业/按仓库编码再配一遍
 * （三套行业库各有一个 `defect` 仓与一个 `quarantine` 仓，见 db/datasets.js）。
 */
export const DISPOSITION_TARGET = {
  concession: 'defect',   // 让步接收 → 不合格品仓
  rework: 'quarantine'    // 返工 → 待检品仓
}

/** 目标隔离仓的界面文案（与 routes/meta.js 的 warehouse_types 同一口径） */
export const DISPOSITION_TARGET_LABEL = {
  defect: '不合格品仓',
  quarantine: '待检品仓'
}

/**
 * 处置方式 → 库存方向。
 *
 * 四种处置**都会**产生真实的库存移动，所以这里不再有 `'none'`：
 *   scrap / return      → 直接出库（货离开本仓，不再回来）；
 *   concession / rework → 自动生成调拨单（原仓出库 + 隔离仓入库）。
 * 返回 `'out'` 是因为从**当前仓**看，这一步的结果就是「结存真的减少了」——
 * 这个值驱动界面上「库存方向」那一列（以及"这一步到底有没有库存动作"的判断），
 * 写成 `'none'` 会让用户以为货还留在原地。
 */
export function directionOf(mode) {
  if (mode === 'scrap' || mode === 'return' || mode === 'concession' || mode === 'rework') return 'out'
  return 'none'
}

/**
 * 取某个类型的隔离仓（不合格品仓 / 待检品仓）。
 * 取不到就**拒绝执行**而不是静默跳过 —— 静默跳过的后果是「处置单显示已执行、
 * 货却还在可售仓里」，这正是本次要修掉的那类静默失效。
 */
function quarantineWarehouse(db, targetType, orgScope = null) {
  const rows = db
    .prepare("SELECT id, code, name FROM warehouses WHERE type=? AND status='active' ORDER BY id")
    .all(targetType)
  // ADR-0038 补充（AA4）：受限范围优先选范围内的隔离仓；没有任何范围内的仓 ⇒ 不退回全局仓，交给调用方的目标仓校验 403。
  const row = (!orgScope || orgScope.scope === 'all')
    ? rows[0]
    : rows.find((w) => warehouseInScope(db, w.id, orgScope)) || rows[0]
  if (!row) {
    throw new QC2Error(
      `没有找到「${DISPOSITION_TARGET_LABEL[targetType] || targetType}」（warehouses.type='${targetType}'），` +
        '无法把不良品调拨出去。请先建这个隔离仓再执行处置。',
      { code: 'QC2_NO_QUARANTINE_WH', httpStatus: 409, detail: { target_type: targetType } }
    )
  }
  return row
}

/**
 * 处置单的源仓是否在范围内（ADR-0038 补充）。`orgScope` 不传 = 全局（lib 内部 / 种子 / MCP 口径不变）；
 * 范围外与不存在同形 404（`QC2_NOT_FOUND`），不泄漏存在性。
 */
function assertHandlingInScope(db, dh, orgScope) {
  if (!orgScope || orgScope.scope === 'all') return
  if (!warehouseInScope(db, dh.warehouse_id, orgScope)) {
    throw new QC2Error('不良品处理单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  }
}

/**
 * 判退单价：从**该检验单关联的到货行**取票面价（退的就是那批货，按那批的价退）。
 * 与模块 07（`routes/qc.js` 的 `receiptItemPrice`）统一口径。
 * 取不到票面价时返回 `null` —— 交给库存引擎回落到**结存均价**，绝不静默写 0。
 */
function returnUnitPrice(db, dh) {
  if (dh.source_type !== 'purchase_receipt' || !dh.source_id) return null
  const row = db
    .prepare(
      `SELECT price FROM purchase_receipt_items
        WHERE receipt_id=? AND sku_id=? AND IFNULL(batch_no,'')=IFNULL(?,'')
        ORDER BY id LIMIT 1`
    )
    .get(dh.source_id, dh.sku_id, dh.batch_no || '')
  const p = num(row?.price)
  return p > 0 ? p : null
}

/**
 * 建不良品处理单（草稿）。
 *
 * 三条前置校验，缺一不可：
 *   ① 检验结论必须是「不合格」—— 合格品没有「不良品处理」可言；
 *   ② 让步接收**必须有理由** —— 让步是「明知不合格仍收下」的风险决策，
 *      不写理由的话，半年后没人知道当初凭什么收的；
 *   ③ 处理数量不能超过该行还没处置的量 —— 否则同一批不良品会被处置两次（退两次货）。
 */
export function createHandling(db, p = {}) {
  const { inspectionId, skuId, batchNo = '', qty, mode, reason = null, defectCode = null, remark = null, actor: actorRaw = null, orgScope = null } = p
  const actor = actorOf(actorRaw)
  if (!inspectionId) throw new QC2Error('缺少检验单', { code: 'QC2_NO_INSPECTION' })
  if (!MODE_LABEL[mode]) throw new QC2Error(`不认识的处置方式：${mode}`, { code: 'QC2_BAD_MODE' })
  const ci = db.prepare('SELECT * FROM qc_inspections WHERE id=?').get(inspectionId)
  if (!ci) throw new QC2Error('检验单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  // ADR-0038 补充：检验单所在仓在范围外 ⇒ 与不存在同形 404（先于任何状态 / 数量校验，避免用错误文案探测）
  if (orgScope && orgScope.scope !== 'all' && !warehouseInScope(db, ci.warehouse_id, orgScope)) {
    throw new QC2Error('检验单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  }
  if (ci.status === 'draft') throw new QC2Error('请先提交检验结论，再决定不良品怎么处理', { code: 'QC2_NOT_INSPECTED', httpStatus: 409 })
  if (ci.status === 'cancelled') throw new QC2Error('检验单已取消', { code: 'QC2_STATE_INVALID', httpStatus: 409 })
  if (ci.result !== 'unqualified') {
    throw new QC2Error('检验结论为合格，没有需要处理的不良品', { code: 'QC2_NO_DEFECT', httpStatus: 409 })
  }

  const item = db
    .prepare('SELECT * FROM qc_request_items WHERE request_id=? AND sku_id IS ? AND IFNULL(batch_no,\'\')=IFNULL(?,\'\')')
    .get(ci.request_id, skuId ?? null, batchNo || '')
    || db.prepare('SELECT * FROM qc_request_items WHERE request_id=? AND sku_id IS ?').get(ci.request_id, skuId ?? null)
  if (!item) throw new QC2Error('该 SKU 不在本次报检明细里', { code: 'QC2_ITEM_NOT_FOUND', httpStatus: 404 })

  const handled = db
    .prepare(
      `SELECT IFNULL(SUM(qty),0) q FROM qc_defect_handlings
        WHERE inspection_id=? AND sku_id IS ? AND IFNULL(batch_no,'')=IFNULL(?,'') AND status<>'cancelled'`
    )
    .get(inspectionId, skuId ?? null, batchNo || '').q
  const remain = round2(num(item.qty) - num(handled))
  const q = round2(num(qty))
  if (q <= 0) throw new QC2Error('处理数量必须大于 0', { code: 'QC2_QTY_INVALID' })
  if (q - remain > 1e-6) {
    throw new QC2Error(
      `处理数量 ${q} 超过该行可处置数量 ${remain}（报检 ${item.qty}，已处置 ${round2(num(handled))}）`,
      { code: 'QC2_QTY_OVER', detail: { sku_id: skuId, qty: q, remain } }
    )
  }
  if (mode === 'concession' && !String(reason || '').trim()) {
    throw new QC2Error('让步接收必须填写理由（明知不合格仍收下，是风险决策）', { code: 'QC2_REASON_REQUIRED' })
  }
  if (mode === 'return' && ci.source_type === 'purchase_receipt' && !ci.supplier_id) {
    throw new QC2Error('采购来源判退需要供应商，检验单上没有供应商信息', { code: 'QC2_NO_SUPPLIER' })
  }
  if (!ci.warehouse_id) throw new QC2Error('检验单没有仓库，无法产生库存后果', { code: 'QC2_NO_WAREHOUSE' })

  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'DH', bizDate: localDate(), table: 'qc_defect_handlings' })
    const info = db
      .prepare(
        `INSERT INTO qc_defect_handlings
           (doc_no,inspection_id,inspection_no,request_id,source_type,source_id,warehouse_id,supplier_id,
            sku_id,sku_code,sku_name,batch_no,qty,mode,defect_code,reason,stock_direction,
            status,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?,?,?,?)`
      )
      .run(
        docNo, inspectionId, ci.doc_no, ci.request_id, ci.source_type, ci.source_id,
        ci.warehouse_id, ci.supplier_id, skuId ?? null, item.sku_code || null, item.sku_name || null,
        batchNo || '', q, mode, defectCode || item.defect_code || null, reason || null,
        directionOf(mode), remark || null, actor.id || null, actor.name || null, localNow(), localNow()
      )
    const hid = info.lastInsertRowid
    recalcHandlingCount(db, inspectionId)
    return hid
  })

  return getHandling(db, tx())
}

function recalcHandlingCount(db, inspectionId) {
  db.prepare(
    `UPDATE qc_inspections SET handling_count=(SELECT COUNT(*) FROM qc_defect_handlings WHERE inspection_id=? AND status<>'cancelled'), updated_at=? WHERE id=?`
  ).run(inspectionId, localNow(), inspectionId)
}

/**
 * 执行处置（draft → confirmed）。**本模块唯一产生库存后果的动作。**
 *
 * 四种处置的后果（客户口径：「一定要都真实扣减库存的，并形成真实的出入库」）：
 *   scrap    报废 → 报废出库（SCRAP_OUT），货真的没了
 *   return   退货 → 采购来源生成采购退货单（PRT，含出库）；其它来源走质检退料出库（QC_RET_OUT）
 *   concession 让步 → **自动生成调拨单**：当前仓 → 不合格品仓（真实出库 + 真实入库）
 *   rework   返工 → **自动生成调拨单**：当前仓 → 待检品仓（真实出库 + 真实入库）
 *
 * 「哪个处置去哪个仓」写在 `DISPOSITION_TARGET` 一处，改口径只改那里。
 *
 * 为什么让步 / 返工也要走「执行」这一步：它们是**决策**，需要有人批准、需要留痕；
 * 而且现在它们都真的动库存，不执行就没有任何库存后果。
 */
export function confirmHandling(db, { id, actor = {}, remark = null, source = 'api', orgScope = null }) {
  actor = actorOf(actor)
  const dh = db.prepare('SELECT * FROM qc_defect_handlings WHERE id=?').get(id)
  if (!dh) throw new QC2Error('不良品处理单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  assertHandlingInScope(db, dh, orgScope)
  if (dh.status !== 'draft') {
    throw new QC2Error(`处理单当前为「${dh.status}」，只有待处理能执行`, { code: 'QC2_STATE_INVALID', httpStatus: 409 })
  }
  const ci = db.prepare('SELECT * FROM qc_inspections WHERE id=?').get(dh.inspection_id)
  if (!ci) throw new QC2Error('检验单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  // 批次是出库/调拨的身份证。**四种处置现在全部按批次动库存**
  // （让步 → 调拨入不合格仓、返工 → 调拨入待检仓），空批次会让库存引擎按拣选规则
  // **跨批次**扣货 —— 实测生产来源 FQC 报废 1 件，实扣的是别人批次（单价 130.73），
  // 而本次生产的批次原封不动。宁可拒绝，也不扣错：扣错不报错、账也平，
  // 只有盘点时才看得出来。（原来让步 / 返工免检这一条，是因为它们不动库存。）
  if (!String(dh.batch_no || '').trim()) {
    throw new QC2Error(
      `处理单 ${dh.doc_no} 没有批次号，无法确定要挪哪一批货，拒绝执行「${MODE_LABEL[dh.mode] || dh.mode}」。` +
        '请先在报检/检验明细上补上批次号再执行。',
      { code: 'QC2_HANDLE_NO_BATCH', httpStatus: 409, detail: { handling_id: dh.id, mode: dh.mode } }
    )
  }

  const tx = db.transaction(() => {
    let outDocType = null
    let outDocId = null
    let outDocNo = null

    if (dh.mode === 'scrap') {
      applyStockOut(db, {
        warehouseId: dh.warehouse_id, skuId: dh.sku_id, batchNo: dh.batch_no, qty: num(dh.qty),
        docType: 'SCRAP_OUT', docNo: dh.doc_no, docId: dh.id,
        bizDate: localDate(), operator: actor.name || null,
        remark: `质检报废（${dh.inspection_no}）${dh.reason ? '：' + dh.reason : ''}`,
        source
      })
      // 报废后把批次标掉（A13）：这批货在任何仓都没有结存了，就不该再被拣选。
      // 只标"全仓都没了"的情形 —— 部分报废（同一批次别处还有货）不能整批作废，
      // 否则会把还在仓里、可以正常卖的部分一起冻掉。
      const left = db
        .prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=? AND IFNULL(batch_no,\'\')=?')
        .get(dh.sku_id, dh.batch_no || '').q
      if (Number(left) <= 0.0001) {
        db.prepare('UPDATE inventory_batches SET status=\'scrapped\' WHERE sku_id=? AND batch_no=?')
          .run(dh.sku_id, dh.batch_no || '')
      }
      outDocType = 'SCRAP_OUT'
      outDocId = dh.id
      outDocNo = dh.doc_no
    } else if (dh.mode === 'return') {
      if (dh.source_type === 'purchase_receipt' && dh.supplier_id) {
        // 采购来源：生成采购退货单。createPurchaseReturn 内部**已经出库**，
        // 所以这里拿到的是一张「已出库的退货单」，不用再补一次库存动作。
        //
        // 判退单价：**取票面价**（这一批货从供应商买进来多少钱，就按多少退），
        // 与模块 07 的 `routes/qc.js`（从到货行取 `price`）统一口径。
        // 原来看写死 `price: 0` —— 0 会被库存引擎当成"零成本"：出库金额为 0、
        // 结存金额不冲减、均价被抬高。取不到票面价时传 null，由引擎回落到结存均价，
        // **绝不静默写 0**。
        outDocId = createPurchaseReturn(db, {
          supplierId: dh.supplier_id,
          warehouseId: dh.warehouse_id,
          returnDate: localDate(),
          reason: `质检判退（${dh.inspection_no}）${dh.reason ? '：' + dh.reason : ''}`,
          items: [
            {
              sku_id: dh.sku_id,
              batch_no: dh.batch_no,
              qty: num(dh.qty),
              price: returnUnitPrice(db, dh),
              receipt_id: dh.source_id
            }
          ],
          actor, source
        })
        outDocType = 'PRT'
        outDocNo = db.prepare('SELECT doc_no FROM purchase_returns WHERE id=?').get(outDocId)?.doc_no || null
      } else {
        // 生产 / 在库复检来源：没有「退给谁」，直接出到废品/退料区
        applyStockOut(db, {
          warehouseId: dh.warehouse_id, skuId: dh.sku_id, batchNo: dh.batch_no, qty: num(dh.qty),
          docType: 'QC_RET_OUT', docNo: dh.doc_no, docId: dh.id,
          bizDate: localDate(), operator: actor.name || null,
          remark: `质检退料（${dh.inspection_no}）${dh.reason ? '：' + dh.reason : ''}`,
          source
        })
        outDocType = 'QC_RET_OUT'
        outDocId = dh.id
        outDocNo = dh.doc_no
      }
    } else if (dh.mode === 'concession' || dh.mode === 'rework') {
      // 让步 / 返工 = **自动生成一张调拨单**把货挪进隔离仓。
      //
      // 客户原话：「可以把不合格的产品调拨入不合格仓，单子可以是客户选择后自动生成，
      // 其实就是调拨单」「可以选择返工，进待检仓」「一定要都真实扣减库存的，
      // 并形成真实的出入库」。所以这里不叫人再去调拨页面手工开一张：
      //   ① 建调拨单（建单即出库 autoShip）→ 原仓结存 −qty，留下 TR_OUT 流水；
      //   ② 立刻收货 → 目标仓结存 +qty，留下 TR_IN 流水。
      // 两步都在本事务内，任一步失败整笔回滚 —— 不会出现「出库了但没入库」的半截账。
      // 这张单在库存 → 调拨页面里能查到、能反查流水，与人工开的调拨单完全同构。
      const targetType = DISPOSITION_TARGET[dh.mode]
      const targetWh = quarantineWarehouse(db, targetType, orgScope)
      // ADR-0038 补充：调拨两端（源仓 + 隔离仓）都必须在操作者范围内，先于建单；越界 403 且整笔不动
      assertTransferTargetsInScope(db, dh.warehouse_id, targetWh.id, orgScope)
      // 流水的备注要把**来源**写清（客户口径：出入库单上的类型要能看出这是什么单）——
      // 出/入两条流水的 remark 都带上质检单号 + 处置单号 + 处置方式。
      const src = `质检${MODE_LABEL[dh.mode]}（${dh.inspection_no}）处置单 ${dh.doc_no}`
      const tr = createTransfer(db, {
        fromWarehouseId: dh.warehouse_id,
        toWarehouseId: targetWh.id,
        transferDate: localDate(),
        // 类型必须是**用户能一眼看出来的那一档**（客户口径：「出库单一定会有多种类型的，
        // 所以你的出入库单上一定要加一个类型」）。用 `qc_disposition` 而不是默认的 `normal`，
        // 这样"这张调拨单是质检让步/返工自动生成的"在**类型列**上就分得出来（不是只靠备注）。
        // 取值登记在 `lib/transfer.js` 的 TRANSFER_TYPES（与 normal/allocation 同域）。
        type: 'qc_disposition',
        // 单号要能反查：处置单号 + 检验单号都写进备注，库存页面一眼能看出这张调拨单是怎么来的。
        remark: `${src} → ${targetWh.name}`,
        actor,
        items: [{ sku_id: dh.sku_id, batch_no: dh.batch_no, qty: num(dh.qty) }]
      })
      // 出库 → 入库两步都在本事务内，任一步失败整笔回滚（不会出"出库了没入库"的半截账）。
      //
      // 出入库流水的类型分两层落（客户问的就是这两层）：
      //   ① `doc_type` 保持**调拨语义**：TR_OUT / TR_IN（与页面开的调拨单同码 ——
      //      "调拨"不会分裂成两种类型，也不会冒出未在 inv_txn_types 登记的码）；
      //   ② "这是质检让步/返工调拨"这层信息由**四处**承载，任何一处单独看都够：
      //      · 调拨单 `stock_transfers.type = 'qc_disposition'`（可枚举、可筛选）
      //      · 单头 `remark`（质检单号 + 处置单号 + 目的仓）
      //      · 两条流水各自的 `remark`（同上 + 出/入方向）
      //      · `doc_id` 指向**调拨单** id（与"来源单据结构化"同方向）
      //      ⇒ 想只按流水查出"哪些出库是质检处置产生的"，一条 JOIN 就够：
      //        SELECT t.* FROM inventory_transactions t
      //          JOIN stock_transfers s ON s.id = t.doc_id
      //         WHERE t.doc_type IN ('TR_OUT','TR_IN') AND s.type='qc_disposition'
      shipTransfer(db, tr.id, actor, { remark: `${src}：调拨出库 → ${targetWh.name}` })
      receiveTransfer(db, tr.id, actor, { remark: `${src}：调拨入库（${targetWh.name}）` })
      outDocType = 'TF'
      outDocId = tr.id
      outDocNo = tr.docNo
    }
    // 让步 / 返工执行完，要**顺带定性这批货的可用性结论**（批次级 qc_status）。
    //
    // ⚠️ 这里的取值与旧实现**相反**，是本次刻意改的口径：
    //   让步接收（concession）→ 保持 **rejected（不合格）**，**不再**置 qualified；
    //   返工（rework）        → **pending（待检）**。
    //
    // 为什么让步不能置 qualified：`qc_status` 是**批次级**（sku + batch_no），
    // 不是仓级。同一批次很可能只有一部分被判不合格、另一部分还好端端留在原仓
    // （本模块按行部分处置，`createHandling` 只要求处置量 ≤ 该行可处置量）。
    // 一旦置成 qualified，**整批**货在任何仓都会被库存引擎当成可售 ——
    // 包括还留在原仓的那部分，以及刚被"隔离"进不合格仓的这一部分。
    // 结果就是"挪进了不合格仓却照样能卖"，与客户口径直接冲突，而且不报错、账也平。
    // 货挪仓解决的是"货在哪"，可用性结论解决的是"这批能不能卖"——两件事，不能互相顶替。
    if ((dh.mode === 'concession' || dh.mode === 'rework') && dh.batch_no) {
      db.prepare("UPDATE inventory_batches SET qc_status=? WHERE sku_id=? AND batch_no=? AND status<>'scrapped'").run(
        dh.mode === 'rework' ? 'pending' : 'rejected',
        dh.sku_id, dh.batch_no
      )
    }

    // 状态由内核推进（applyTransition），这里**不直接写 status** ——
    // 先 UPDATE status 再走内核会让内核读到「已是终态」而拒绝流转，
    // 报出一个与真实原因无关的「状态已执行已是终态」错。附加字段一并交给内核写。
    applyTransition({
      db, docType: 'DH', id, action: 'confirm',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: remark || `${MODE_LABEL[dh.mode]} ${dh.qty}${outDocNo ? `（${outDocNo}）` : ''}`,
      source,
      // 留痕里带上「这一步生成了哪张单」的机器可读版本：界面看 remark（含单号），
      // 自查 / 对账看 payload —— 只看 remark 的话，文案一改就对不上了。
      payload: outDocNo ? { out_doc_type: outDocType, out_doc_id: outDocId, out_doc_no: outDocNo } : null,
      set: {
        out_doc_type: outDocType,
        out_doc_id: outDocId,
        out_doc_no: outDocNo,
        approved_by: actor.id || null,
        approved_by_name: actor.name || null,
        approved_at: localNow(),
        updated_at: localNow()
      }
    })

    recalcHandlingCount(db, dh.inspection_id)
    recalcDisposition(db, dh.inspection_id)
    closeRequestIfDone(db, ci.request_id, actor, source)
    return { outDocType, outDocId, outDocNo }
  })

  const out = tx()
  return { ...getHandling(db, id), stock_effect: out }
}

export function cancelHandling(db, { id, reason = null, actor = {}, source = 'api', orgScope = null }) {
  actor = actorOf(actor)
  const dh = db.prepare('SELECT * FROM qc_defect_handlings WHERE id=?').get(id)
  if (!dh) throw new QC2Error('不良品处理单不存在', { code: 'QC2_NOT_FOUND', httpStatus: 404 })
  assertHandlingInScope(db, dh, orgScope)
  const tx = db.transaction(() => {
    applyTransition({
      db, docType: 'DH', id, action: 'cancel',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: reason || '取消处理', source, set: { updated_at: localNow() }
    })
    recalcHandlingCount(db, dh.inspection_id)
    recalcDisposition(db, dh.inspection_id)
    closeRequestIfDone(db, db.prepare('SELECT request_id FROM qc_inspections WHERE id=?').get(dh.inspection_id)?.request_id, actor, source)
    return true
  })
  tx()
  return getHandling(db, id)
}

/** 处置汇总：一张检验单下已执行的处置方式 → none / concession / return / scrap / rework / mixed */
export function recalcDisposition(db, inspectionId) {
  const rows = db
    .prepare("SELECT DISTINCT mode FROM qc_defect_handlings WHERE inspection_id=? AND status='confirmed'")
    .all(inspectionId)
    .map((r) => r.mode)
  const disposition = rows.length === 0 ? 'none' : rows.length === 1 ? rows[0] : 'mixed'
  db.prepare('UPDATE qc_inspections SET disposition=?, updated_at=? WHERE id=?')
    .run(disposition, localNow(), inspectionId)
  return disposition
}

export function getHandling(db, id, orgScope = null) {
  const row = db
    .prepare(
      `SELECT dh.*, w.name AS warehouse_name, s.name AS supplier_name
         FROM qc_defect_handlings dh
         LEFT JOIN warehouses w ON w.id = dh.warehouse_id
         LEFT JOIN suppliers s ON s.id = dh.supplier_id
        WHERE dh.id = ?`
    )
    .get(id)
  if (!row) return null
  if (orgScope && orgScope.scope !== 'all' && !warehouseInScope(db, row.warehouse_id, orgScope)) return null
  const events = db
    .prepare(
      `SELECT action, action_name, from_state, to_state, actor_name, remark, created_at
         FROM doc_events WHERE doc_type='DH' AND doc_id=? ORDER BY id`
    )
    .all(id)
  return {
    ...row,
    mode_label: MODE_LABEL[row.mode] || row.mode,
    source_label: SOURCE_LABEL[row.source_type] || row.source_type,
    events
  }
}

export function listHandlings(db, q = {}) {
  const { page = 1, pageSize = 20, status = null, mode = null, inspectionId = null, keyword = null, orgScope = null } = q
  const where = []
  const args = []
  const scope = stockScopeSql(orgScope, 'dh')
  where.push(scope.sql); args.push(...scope.params)
  if (status) { where.push('dh.status = ?'); args.push(status) }
  if (mode) { where.push('dh.mode = ?'); args.push(mode) }
  if (inspectionId) { where.push('dh.inspection_id = ?'); args.push(inspectionId) }
  if (keyword) {
    where.push('(dh.doc_no LIKE ? OR dh.inspection_no LIKE ? OR dh.sku_name LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM qc_defect_handlings dh ${w}`).get(...args).c
  const offset = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT dh.*, w2.name AS warehouse_name FROM qc_defect_handlings dh
         LEFT JOIN warehouses w2 ON w2.id = dh.warehouse_id
         ${w} ORDER BY dh.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
  return {
    rows: rows.map((r) => ({
      ...r,
      mode_label: MODE_LABEL[r.mode] || r.mode,
      // 台账上要显示「这单是从哪来的」—— 不带上就和检验单详情里的口径不一致，
      // 列表里那一列会永远空着（这一类"少一个字段"的坑很难从报错里看出来）
      source_label: SOURCE_LABEL[r.source_type] || r.source_type
    })),
    total, page: Math.max(1, page), pageSize
  }
}

// ---------------------------------------------------------------------------
// 六、概览与自洽审计
// ---------------------------------------------------------------------------

export function qcOverview(db) {
  const one = (sql, ...a) => num(db.prepare(sql).get(...a)?.v)
  const bySource = db
    .prepare('SELECT source_type, COUNT(*) c FROM qc_requests GROUP BY source_type ORDER BY c DESC')
    .all()
    .map((r) => ({ ...r, label: SOURCE_LABEL[r.source_type] || r.source_type }))
  const byMode = db
    .prepare("SELECT mode, COUNT(*) c, IFNULL(SUM(qty),0) qty FROM qc_defect_handlings WHERE status<>'cancelled' GROUP BY mode")
    .all()
    .map((r) => ({ ...r, label: MODE_LABEL[r.mode] || r.mode }))
  const sampleTotal = one('SELECT IFNULL(SUM(sample_qty),0) v FROM qc_inspections')
  const defectTotal = one('SELECT IFNULL(SUM(defect_qty),0) v FROM qc_inspections')
  return {
    pending_source: num(pendingSources(db, { limit: 999 }).length),
    requests: one('SELECT COUNT(*) v FROM qc_requests'),
    requests_draft: one("SELECT COUNT(*) v FROM qc_requests WHERE status='draft'"),
    requests_submitted: one("SELECT COUNT(*) v FROM qc_requests WHERE status='submitted'"),
    requests_closed: one("SELECT COUNT(*) v FROM qc_requests WHERE status='closed'"),
    inspections: one('SELECT COUNT(*) v FROM qc_inspections'),
    waiting_inspect: one("SELECT COUNT(*) v FROM qc_inspections WHERE status='draft'"),
    qualified: one("SELECT COUNT(*) v FROM qc_inspections WHERE result='qualified'"),
    unqualified: one("SELECT COUNT(*) v FROM qc_inspections WHERE result='unqualified'"),
    handlings: one('SELECT COUNT(*) v FROM qc_defect_handlings'),
    handlings_draft: one("SELECT COUNT(*) v FROM qc_defect_handlings WHERE status='draft'"),
    handlings_confirmed: one("SELECT COUNT(*) v FROM qc_defect_handlings WHERE status='confirmed'"),
    scrap_qty: one("SELECT IFNULL(SUM(qty),0) v FROM qc_defect_handlings WHERE mode='scrap' AND status='confirmed'"),
    return_qty: one("SELECT IFNULL(SUM(qty),0) v FROM qc_defect_handlings WHERE mode='return' AND status='confirmed'"),
    concession_qty: one("SELECT IFNULL(SUM(qty),0) v FROM qc_defect_handlings WHERE mode='concession' AND status='confirmed'"),
    rework_qty: one("SELECT IFNULL(SUM(qty),0) v FROM qc_defect_handlings WHERE mode='rework' AND status='confirmed'"),
    defect_rate: sampleTotal > 0 ? round4((defectTotal / sampleTotal) * 100) : 0,
    by_source: bySource,
    by_mode: byMode
  }
}

/**
 * 自洽审计（十项）。
 *
 * 质检最容易出的错不是崩溃，而是**结论与数字对不上**：界面显示合格、行里不良数是 3，
 * 或者一张单被判退两次。这些错不会报错，只会让人不再相信系统。
 * 所以把「能算出来的一致性」全部写成断言，让它们可以被一条命令验证。
 */
export function auditQc(db) {
  const out = { ok: true }

  // 查一：行级数字关系（抽样 ≤ 报检、不良 ≤ 抽样、Ac < Re）
  out.badLineQty = db
    .prepare(
      `SELECT it.id, it.request_id, it.sku_id, it.qty, it.sample_qty, it.defect_qty
         FROM qc_request_items it
        WHERE it.sample_qty - it.qty > 0.005 OR it.defect_qty - it.sample_qty > 0.005
           OR it.defect_qty < 0 OR it.ac >= it.re`
    )
    .all()

  // 查二：判定与数字一致 —— 「判合格但不良数 > Ac」是质检最要命的静默错误
  out.badVerdict = db
    .prepare(
      `SELECT it.id, it.request_id, it.sku_id, it.defect_qty, it.ac, it.result
         FROM qc_request_items it
        WHERE it.result <> 'pending'
          AND ((it.result='qualified' AND it.defect_qty > it.ac)
            OR (it.result='unqualified' AND it.defect_qty <= it.ac))`
    )
    .all()

  // 查三：报检单 / 检验单头的汇总与行合计一致
  out.headDrift = db
    .prepare(
      `SELECT rq.id, rq.doc_no, rq.total_qty, rq.total_sample_qty,
              IFNULL(SUM(it.qty),0) line_qty, IFNULL(SUM(it.sample_qty),0) line_sample
         FROM qc_requests rq
         LEFT JOIN qc_request_items it ON it.request_id = rq.id
        GROUP BY rq.id
       HAVING ABS(rq.total_qty - IFNULL(SUM(it.qty),0)) > 0.005
           OR ABS(rq.total_sample_qty - IFNULL(SUM(it.sample_qty),0)) > 0.005`
    )
    .all()

  out.inspDrift = db
    .prepare(
      `SELECT ci.id, ci.doc_no, ci.result,
              IFNULL((SELECT SUM(it.defect_qty) FROM qc_request_items it WHERE it.request_id=ci.request_id),0) line_defect
         FROM qc_inspections ci
        WHERE ci.result <> 'pending'
          AND ABS(ci.defect_qty - IFNULL((SELECT SUM(it.defect_qty) FROM qc_request_items it WHERE it.request_id=ci.request_id),0)) > 0.005`
    )
    .all()

  // 查四：处置数量不超报检数量（同一批不良品不能被退两次）
  out.overHandle = db
    .prepare(
      `SELECT dh.inspection_id, dh.sku_id, dh.batch_no,
              SUM(dh.qty) handled,
              (SELECT it.qty FROM qc_request_items it
                JOIN qc_inspections ci2 ON ci2.request_id = it.request_id
               WHERE ci2.id = dh.inspection_id AND it.sku_id IS dh.sku_id LIMIT 1) reported
         FROM qc_defect_handlings dh
        WHERE dh.status <> 'cancelled'
        GROUP BY dh.inspection_id, dh.sku_id, dh.batch_no
       HAVING reported IS NOT NULL AND SUM(dh.qty) - reported > 0.005`
    )
    .all()

  // 查五：状态一致 —— 结论合格却挂着未处置的处理单；已关闭的报检单却还有草稿处理单
  out.staleHandle = db
    .prepare(
      `SELECT dh.id, dh.doc_no, ci.doc_no AS inspection_no, ci.result
         FROM qc_defect_handlings dh
         JOIN qc_inspections ci ON ci.id = dh.inspection_id
        WHERE dh.status <> 'cancelled' AND ci.result = 'qualified'`
    )
    .all()

  out.closedWithDraft = db
    .prepare(
      `SELECT rq.id, rq.doc_no FROM qc_requests rq
        WHERE rq.status = 'closed'
          AND EXISTS (SELECT 1 FROM qc_defect_handlings dh
                       JOIN qc_inspections ci ON ci.id = dh.inspection_id
                      WHERE ci.request_id = rq.id AND dh.status = 'draft')`
    )
    .all()

  // 查五之二：已关闭的报检单里，不合格行必须**处置满**（数量覆盖），
  // 否则就是「单子关了、货还没人管」—— 关单判据写错时唯一能查出来的地方
  out.shortHandle = db
    .prepare(
      `SELECT rq.id, rq.doc_no, it.sku_id, it.batch_no, it.qty AS reported,
              IFNULL((SELECT SUM(dh.qty) FROM qc_defect_handlings dh
                       WHERE dh.inspection_id = ci.id AND dh.sku_id IS it.sku_id
                         AND IFNULL(dh.batch_no,'') = IFNULL(it.batch_no,'')
                         AND dh.status <> 'cancelled'), 0) AS handled
         FROM qc_requests rq
         JOIN qc_inspections ci ON ci.request_id = rq.id
         JOIN qc_request_items it ON it.request_id = rq.id
        WHERE rq.status = 'closed' AND it.result = 'unqualified'
          AND IFNULL((SELECT SUM(dh.qty) FROM qc_defect_handlings dh
                       WHERE dh.inspection_id = ci.id AND dh.sku_id IS it.sku_id
                         AND IFNULL(dh.batch_no,'') = IFNULL(it.batch_no,'')
                         AND dh.status <> 'cancelled'), 0) + 0.005 < it.qty`
    )
    .all()

  // 查六：孤儿引用（检验单指向不存在的报检单、处理单指向不存在的检验单）
  out.orphan = db
    .prepare(
      `SELECT 'QCI' AS kind, ci.id FROM qc_inspections ci
        WHERE NOT EXISTS (SELECT 1 FROM qc_requests rq WHERE rq.id = ci.request_id)
       UNION ALL
       SELECT 'DH', dh.id FROM qc_defect_handlings dh
        WHERE NOT EXISTS (SELECT 1 FROM qc_inspections ci WHERE ci.id = dh.inspection_id)`
    )
    .all()

  // 查七：库存后果自洽 —— 已执行的处理单**四种处置都必须有 out_doc_no**
  // （原来只查 return / scrap；让步与返工在客户口径下同样"必须有单据、必须真出库"）
  out.missingStockEffect = db
    .prepare(
      `SELECT dh.id, dh.doc_no, dh.mode FROM qc_defect_handlings dh
        WHERE dh.status='confirmed' AND dh.mode IN ('return','scrap','concession','rework')
          AND (dh.out_doc_no IS NULL OR dh.out_doc_no='')`
    )
    .all()

  // 查八：调拨类处置（让步 / 返工）**必须真的过账**，不是只挂一个单号。
  // 三条一起判：调拨单存在 → 状态已入库 → TR_OUT 与 TR_IN 两条库存流水都在。
  // 少了任何一条，后果都是「处置单显示已执行，而货的去向对不上」：
  // 只改状态不过账 = 货没动；只出库不入库 = 货在半路上、原仓已经扣掉，账还平。
  out.transferNotPosted = db
    .prepare(
      `SELECT dh.id, dh.doc_no, dh.mode, dh.out_doc_no,
              t.id AS transfer_id, t.status AS transfer_status,
              (SELECT COUNT(*) FROM inventory_transactions x WHERE x.doc_type='TR_OUT' AND x.doc_id=t.id) AS out_txn,
              (SELECT COUNT(*) FROM inventory_transactions x WHERE x.doc_type='TR_IN'  AND x.doc_id=t.id) AS in_txn
         FROM qc_defect_handlings dh
         LEFT JOIN stock_transfers t ON dh.out_doc_type='TF' AND t.id = dh.out_doc_id
        WHERE dh.status='confirmed' AND dh.mode IN ('concession','rework')
          AND (t.id IS NULL OR t.status <> 'received'
               OR (SELECT COUNT(*) FROM inventory_transactions x WHERE x.doc_type='TR_OUT' AND x.doc_id=t.id) = 0
               OR (SELECT COUNT(*) FROM inventory_transactions x WHERE x.doc_type='TR_IN'  AND x.doc_id=t.id) = 0)`
    )
    .all()

  const keys = ['badLineQty', 'badVerdict', 'headDrift', 'inspDrift', 'overHandle', 'staleHandle', 'closedWithDraft', 'shortHandle', 'orphan', 'missingStockEffect', 'transferNotPosted']
  out.ok = keys.every((k) => !out[k] || out[k].length === 0)
  out.checked = keys
  return out
}

export default {
  QC2Error, SOURCE_LABEL, RESULT_LABEL, MODE_LABEL, DISPOSITION_LABEL, DEFECT_CODES,
  DISPOSITION_TARGET, DISPOSITION_TARGET_LABEL,
  SAMPLE_TABLE, samplingPlan, localDate, localNow,
  pendingSources, sourceDetail,
  createRequest, submitRequest, getRequest, listRequests, transitionRequest,
  getInspection, listInspections, submitInspection, transitionInspection,
  createHandling, confirmHandling, cancelHandling, getHandling, listHandlings, directionOf,
  qcOverview, auditQc
}
