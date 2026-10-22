/**
 * ============================================================================
 * 文件标识：server/lib/mfg.js ｜ 生产制造服务层（模块 10B · 领料 / 完工 / 料工费归集）
 * ============================================================================
 * 【职责】生产制造服务层（模块 10B · 领料 / 完工 / 料工费归集）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 生产制造服务层（模块 10B · 领料 / 完工 / 料工费归集）
//
// 一句话说清本模块在解决什么：**让「完工入库」真的入库，让「料工费」真的算得出来。**
//
// 此前的生产订单是个**空壳**：能开单、能改状态、能填 `material_cost` 字段，
// 但点「完工入库」库存一分不动，材料成本靠人手填且没人校验。
// 结果是一张「已完工」的生产订单，在库存账上查不到任何产出，
// 在成本账上只有一个来源不明的数字 —— 演示时看着有流程，一追问就露馅。
//
// 本模块补三件事：
//   ① **领料（MR）**：按 BOM 展开装填 → 审批 → **出库**（唯一有库存后果的动作）；
//   ② **完工汇报**：良品 / 不良 / 工时 —— 有单号、可追溯，但**不推进状态、不进审批**
//      （第三轮口径 G4 定案「生产不报工」，见 023 迁移文件头）；
//   ③ **完工入库**：按汇报的良品数入库，并把材料 + 人工 + 制造费用归集到订单上。
//
// 三条口径（写死在代码里）：
//   ① **领料的出库是终态**（`issued`）。库存已经动了，允许退回等于要给「已发出去的料
//      再收回来」造反向单据 —— 现场的做法是「退料」另开一张，不是把原单改回去。
//   ② **超额领料必须显式**。限额领料（`limit`）下累计领用不得超过 BOM 需求；
//      确实要多领，得把单据类型改成「补料」（`supplement`）——
//      超领这件事必须留下痕迹，不能被一张「正常领料」悄悄带过。
//   ③ **材料成本按订单数量分摊，不按实际领料分摊**。
//      `单位材料 = 已出库领料总额 ÷ 订单数量`，本次完工按 `× 本次良品数` 归集。
//      按实际领料分摊会让「多领了料」直接变成「单件成本变高」，
//      而真实业务里超领是**损耗异常**，应该单独暴露，不该摊进成本里被平均掉。

import { applyTransition } from './docflow.js'
import { nextDocNo, nextDocNoAuto } from './docno.js'
import { applyStockOut, applyStockIn, pickBatches } from './stock.js'
import { expandBom, resolveBom, BomError, getSkuInfo } from './bom.js'

export class MfgError extends Error {
  constructor(message, { code = 'MFG_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'MfgError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

export const ISSUE_STATUS_LABEL = {
  draft: '草稿', submitted: '已提交', approved: '已审批', issued: '已出库', cancelled: '已取消'
}
export const ISSUE_TYPE_LABEL = { by_bom: '按 BOM 领料', limit: '限额领料', supplement: '补料' }
export const ORDER_STATUS_LABEL = {
  draft: '草稿', submitted: '已提交', approved: '已审批', in_progress: '生产中',
  completed: '已完工', closed: '已关闭', cancelled: '已取消'
}

const num = (v) => Number(v) || 0
const round4 = (n) => Math.round(num(n) * 10000) / 10000
const round2 = (n) => Math.round(num(n) * 100) / 100
const actorOf = (a) => (a && typeof a === 'object' ? a : {})

// 本地日期/时间统一来自 dates.js（本项目只留一处实现，见该文件模块注释）。
// 保留 re-export：历史调用方按 `localDate` 从本模块取。
export { localDate, localNow } from './dates.js'
import { localDate, localNow } from './dates.js'
const nowText = () => localNow()

const requireOrder = (db, id) => {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(id))
  if (!po) throw new MfgError('生产订单不存在', { code: 'MO_NOT_FOUND', httpStatus: 404 })
  return po
}

// ---------------------------------------------------------------------------
// 需求展开：领料单的装填依据
// ---------------------------------------------------------------------------

/**
 * 某生产订单**还需领用**的物料清单。
 *
 * 这是领料单的默认装填值，也是「为什么少领了」的判据。
 * 返回值里 `required_qty`（BOM 展开需求）与 `issued_qty`（已出库累计）分开给，
 * 前端不用自己相减 —— 相减这件事只要有两个地方各写一遍，迟早会不一致。
 *
 * @param {object} opts
 * @param {boolean} [opts.includeIssued=false] 已领满的行是否也返回（默认只返回待领的）
 */
export function planRequirement(db, { orderId, warehouseId = null, includeIssued = false } = {}) {
  const po = requireOrder(db, orderId)
  const usage = po.produce_way === 'outsourced' ? 'outsourced' : 'self_made'
  const whId = warehouseId != null ? Number(warehouseId) : po.warehouse_id

  const bom = resolveBom(db, { skuId: po.product_sku_id, usage })
  if (!bom) {
    return {
      order: { id: po.id, doc_no: po.doc_no, qty: po.qty, product_sku_id: po.product_sku_id, warehouse_id: whId },
      bom: null,
      lines: [],
      summary: { line_count: 0, required_qty: 0, issued_qty: 0, pending_count: 0, shortage_count: 0 },
      message: `该成品尚未维护${usage === 'outsourced' ? '委外' : '自制'} BOM，无法自动展开需求，请手工添加领料行`
    }
  }

  const expanded = expandBom(db, { bomId: bom.id, qty: num(po.qty), warehouseId: whId })

  // 已出库累计：按 SKU 汇总（跨批次），口径与展开的「按 SKU 一行」对齐
  const issuedRows = db
    .prepare(
      `SELECT mii.sku_id, COALESCE(SUM(mii.issued_qty),0) AS qty
         FROM material_issue_items mii JOIN material_issues mi ON mi.id = mii.issue_id
        WHERE mi.order_id = ? AND mi.status = 'issued'
        GROUP BY mii.sku_id`
    )
    .all(po.id)
  const issuedMap = new Map(issuedRows.map((r) => [r.sku_id, num(r.qty)]))

  const lines = expanded.lines.map((l) => {
    const issued = round4(issuedMap.get(l.sku_id) || 0)
    const pending = round4(Math.max(0, l.qty - issued))
    return {
      ...l,
      issued_qty: issued,
      pending_qty: pending,
      is_done: pending <= 1e-9
    }
  })

  const out = includeIssued ? lines : lines.filter((l) => !l.is_done)
  return {
    order: {
      id: po.id, doc_no: po.doc_no, qty: po.qty, status: po.status,
      product_sku_id: po.product_sku_id, warehouse_id: whId, produce_way: po.produce_way || 'self_made'
    },
    bom: expanded.bom,
    lines: out,
    groups: expanded.groups,
    summary: {
      line_count: out.length,
      required_qty: round4(lines.reduce((n, l) => n + l.qty, 0)),
      issued_qty: round4(lines.reduce((n, l) => n + l.issued_qty, 0)),
      pending_count: lines.filter((l) => !l.is_done).length,
      shortage_count: lines.filter((l) => l.shortage != null && l.shortage > 0).length
    }
  }
}

// ---------------------------------------------------------------------------
// 生产订单：列表 / 详情
// ---------------------------------------------------------------------------

export function listProductionOrders(db, q = {}) {
  const where = []
  const args = []
  if (q.status) { where.push('po.status = ?'); args.push(q.status) }
  if (q.warehouseId) { where.push('po.warehouse_id = ?'); args.push(Number(q.warehouseId)) }
  if (q.keyword) {
    where.push('(po.doc_no LIKE ? OR sk.sku_code LIKE ? OR sk.name LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k, k)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20))
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM production_orders po LEFT JOIN product_skus sk ON sk.id=po.product_sku_id ${w}`)
    .get(...args).c
  const list = db
    .prepare(
      `SELECT po.*, sk.sku_code AS sku_code, sk.name AS sku_name, sk.spec, p.unit,
              w.name AS warehouse_name,
              v.issued_qty, v.issued_amount, v.reported_good_qty, v.reported_defect_qty,
              v.conversion_cost, v.issue_count,
              (SELECT COUNT(*) FROM work_reports wr WHERE wr.order_id=po.id) AS report_count
         FROM production_orders po
         LEFT JOIN product_skus sk ON sk.id = po.product_sku_id
         LEFT JOIN products p ON p.id = sk.product_id
         LEFT JOIN warehouses w ON w.id = po.warehouse_id
         LEFT JOIN v_production_progress v ON v.order_id = po.id
         ${w}
        ORDER BY po.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  return {
    list: list.map((r) => ({
      ...r,
      status_label: ORDER_STATUS_LABEL[r.status] || r.status,
      in_progress_qty: round4(Math.max(0, num(r.completed_qty) - num(r.reported_good_qty)))
    })),
    total, page, pageSize
  }
}

export function getProductionOrder(db, id) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(id))
  if (!po) return null
  const sku = getSkuInfo(db, po.product_sku_id)
  const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(po.warehouse_id)
  const progress = db.prepare('SELECT * FROM v_production_progress WHERE order_id=?').get(po.id)
  const items = db.prepare('SELECT * FROM production_order_items WHERE order_id=? ORDER BY id').all(po.id)
  const issues = db
    .prepare(
      `SELECT mi.*, (SELECT COUNT(*) FROM material_issue_items x WHERE x.issue_id=mi.id) AS item_count
         FROM material_issues mi WHERE mi.order_id=? ORDER BY mi.id`
    )
    .all(po.id)
  const reports = db.prepare('SELECT * FROM work_reports WHERE order_id=? ORDER BY id').all(po.id)
  const bom = resolveBom(db, { skuId: po.product_sku_id, usage: po.produce_way === 'outsourced' ? 'outsourced' : 'self_made' })
  return {
    ...po,
    status_label: ORDER_STATUS_LABEL[po.status] || po.status,
    sku_code: sku?.code || null,
    sku_name: sku?.name || null,
    spec: sku?.spec || null,
    unit: sku?.unit || null,
    warehouse_name: wh?.name || null,
    progress,
    items,
    issues: issues.map((i) => ({ ...i, status_label: ISSUE_STATUS_LABEL[i.status] || i.status })),
    reports,
    bom: bom ? { id: bom.id, code: bom.code, version: bom.version, base_qty: bom.base_qty, item_count: (bom.items || []).length } : null
  }
}

/**
 * 开工：把生产订单推进到「生产中」。
 *
 * 领料与完工入库都要求订单处于 `in_progress` —— 这不是流程洁癖：
 * 「已审批但没开工」的订单如果也能领料，就会有一批料挂在库外、既不在原料库也不算在制，
 * 而单据上看不出任何异常（状态还是「已审批」）。
 */
export function startOrder(db, { orderId, actor = {}, remark = null, source = 'api' } = {}) {
  const po = requireOrder(db, orderId)
  if (po.status === 'in_progress') return getProductionOrder(db, po.id)
  if (po.status !== 'approved') {
    throw new MfgError(
      `生产订单当前状态（${ORDER_STATUS_LABEL[po.status] || po.status}）不能开工：只有「已审批」的订单才能开工`,
      { code: 'MO_STATUS_INVALID' }
    )
  }
  applyTransition({ db, docType: 'MO', id: po.id, action: 'start', actor: actorOf(actor), remark, source })
  return getProductionOrder(db, po.id)
}

// ---------------------------------------------------------------------------
// 领料单
// ---------------------------------------------------------------------------

/**
 * 建领料单（草稿）。
 *
 * 不传 `items` 时按 BOM 展开**自动装填待领数量** —— 这是最常用的路径：
 * 「照 BOM 领一次」。传 `items` 时以传入为准（现场可能只要领一部分）。
 */
export function createIssue(db, p = {}) {
  const actor = actorOf(p.actor)
  const po = requireOrder(db, p.orderId)
  // 只有「生产中」的订单能领料：见 startOrder 的说明 ——
  // 「已审批但没开工」的订单若能领料，料就挂在库外且单据上看不出异常。
  if (po.status !== 'in_progress') {
    throw new MfgError(
      `生产订单当前状态（${ORDER_STATUS_LABEL[po.status] || po.status}）不能领料：请先「开工」`,
      { code: 'MO_NOT_STARTED', detail: { status: po.status } }
    )
  }
  const warehouseId = Number(p.warehouseId ?? po.warehouse_id)
  if (!warehouseId) throw new MfgError('必须指定领料仓库', { code: 'MFG_WAREHOUSE_REQUIRED' })
  const issueType = p.issueType || p.issue_type || 'by_bom'
  if (!ISSUE_TYPE_LABEL[issueType]) throw new MfgError(`未知领料类型 ${issueType}`, { code: 'MFG_ISSUE_TYPE_INVALID' })
  const issueDate = p.issueDate || p.issue_date || localDate()

  // 装填依据：给了 items 就用，没给就按 BOM 展开待领量
  let rows
  if (Array.isArray(p.items) && p.items.length) {
    rows = p.items.map((it, i) => ({
      line_no: i + 1,
      sku_id: Number(it.sku_id),
      batch_no: it.batch_no || '',
      plan_qty: round4(num(it.plan_qty ?? it.qty)),
      qty: round4(num(it.qty)),
      remark: it.remark || null
    }))
  } else {
    const req = planRequirement(db, { orderId: po.id, warehouseId })
    if (!req.lines.length) {
      throw new MfgError(
        req.bom ? '该订单的物料已领满，无需再领（如需补料请把类型改为补料）' : req.message,
        { code: req.bom ? 'MFG_NOTHING_TO_ISSUE' : 'MFG_BOM_MISSING' }
      )
    }
    rows = req.lines.map((l, i) => ({
      line_no: i + 1,
      sku_id: l.sku_id,
      // 自动带出建议批次：食品/美妆要看效期，让现场自己翻批次列表挑是最容易出错的环节。
      // 拣选规则由 inv_params.pick_rule 决定（FEFO/FIFO），与库存出库口径同源。
      batch_no: l.batch_no || defaultBatchOf(db, warehouseId, l.sku_id, l.pending_qty),
      plan_qty: round4(l.qty),
      qty: round4(l.pending_qty),
      remark: l.is_substitute ? `替代料（替代行 #${l.substitute_for}）` : null
    }))
  }

  rows = rows.filter((r) => num(r.qty) > 0)
  if (!rows.length) throw new MfgError('领料单没有任何数量大于 0 的行', { code: 'MFG_ISSUE_EMPTY' })

  // 口径②：限额领料不能超领；补料必须说明理由
  if (issueType === 'limit') assertNoOverIssue(db, po.id, rows)
  if (issueType === 'supplement' && !p.remark) {
    throw new MfgError('补料必须填写原因（默认是「正常领料」会把超领这件事藏起来）', { code: 'MFG_SUPPLEMENT_REASON_REQUIRED' })
  }

  const docNo = p.docNo || nextDocNoAuto(db, { docType: 'MR', warehouseId, bizDate: issueDate, table: 'material_issues' })
  const skuCache = new Map()
  const enrich = (skuId) => {
    if (!skuCache.has(skuId)) skuCache.set(skuId, getSkuInfo(db, skuId))
    return skuCache.get(skuId)
  }

  const now = nowText()
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO material_issues (doc_no,order_id,order_no,org_id,warehouse_id,issue_date,issue_type,status,
           plan_qty,total_qty,total_amount,item_count,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?, 'draft', ?,0,0,?,?,?,?,?,?)`
      )
      .run(
        docNo, po.id, po.doc_no, p.orgId ?? null, warehouseId, issueDate, issueType,
        round4(rows.reduce((n, r) => n + num(r.plan_qty), 0)),
        rows.length, p.remark || null, actor.id ?? null, actor.name ?? null, now, now
      )
    const issueId = info.lastInsertRowid
    const ins = db.prepare(
      `INSERT INTO material_issue_items (issue_id,line_no,sku_id,sku_code,sku_name,spec,unit,batch_no,
         plan_qty,qty,issued_qty,unit_cost,amount,substitute_for,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)`
    )
    for (const r of rows) {
      const sku = enrich(r.sku_id)
      if (!sku) throw new MfgError(`SKU#${r.sku_id} 不存在`, { code: 'MFG_SKU_NOT_FOUND', httpStatus: 404 })
      ins.run(
        issueId, r.line_no, r.sku_id, sku.code, sku.name, sku.spec, sku.unit,
        r.batch_no || '', r.plan_qty, r.qty, null, r.remark
      )
    }
    db.prepare('UPDATE material_issues SET total_qty=?, updated_at=? WHERE id=?').run(
      round4(rows.reduce((n, r) => n + num(r.qty), 0)), now, issueId
    )
    return issueId
  })
  const id = tx()
  return getIssue(db, id)
}

/** Only pin a batch when it satisfies the whole line; otherwise keep automatic split picking. */
function defaultBatchOf(db, warehouseId, skuId, qty) {
  try {
    const probe = pickBatches(db, warehouseId, skuId, num(qty) || 1, {})
    const first = (probe.picks || [])[0]
    return !probe.shortage && probe.picks.length === 1 && first.qty + 1e-9 >= num(qty)
      ? first.batchNo : ''
  } catch {
    return ''
  }
}

/** 限额校验：BOM 需求（含损耗）− 已出库累计 ≥ 本次申请 */
function assertNoOverIssue(db, orderId, rows) {
  const req = planRequirement(db, { orderId, includeIssued: true })
  const bySku = new Map(req.lines.map((l) => [l.sku_id, l]))
  const over = []
  for (const r of rows) {
    const line = bySku.get(Number(r.sku_id))
    if (!line) {
      over.push({ sku_id: r.sku_id, sku_code: null, reason: '不在 BOM 组件清单中', pending: 0, request: num(r.qty) })
      continue
    }
    if (num(r.qty) > num(line.pending_qty) + 1e-9) {
      over.push({
        sku_id: r.sku_id, sku_code: line.sku_code, sku_name: line.sku_name,
        reason: '超过 BOM 需求', pending: round4(line.pending_qty), request: round4(num(r.qty))
      })
    }
  }
  if (over.length) {
    throw new MfgError(
      `限额领料超出 BOM 需求 ${over.length} 行：${over.map((o) => `${o.sku_name || o.sku_code || ('SKU#' + o.sku_id)} 申请 ${o.request} > 可领 ${o.pending}`).join('；')}。确需多领请把类型改为「补料」并填写原因`,
      { code: 'MFG_OVER_ISSUE', detail: { over } }
    )
  }
}

/**
 * 超产判据：**累计良品不得超过订单数量**。
 *
 * 只留这一个实现，三个调用点共用（登记汇报 / 修改汇报 / 完工入库）——
 * 「同一件事两份实现，迟早不一致」是本项目已经吃过一次的共因（审计登记 G1）。
 *
 * 为什么闸门最终必须落在 `completeOrder`：`PUT /reports/:id` 能把已登记的良品数放大，
 * 只在「建汇报」那一步拦等于没拦（实测订单 10 能入库 9999，订单与库存两边一起错，
 * 而 `auditMfg` 第⑤项拿「已入库汇报良品合计」比对订单完工数，两边一起错就判一致 ⇒ 审计也看不见）。
 * 建单 / 改单这两处也调它，是为了让人在**输入那一刻**就看到红字，而不是等点「完工入库」才被拒。
 */
function assertNotOverComplete(po, addGood, what = '本次良品') {
  const done = num(po.completed_qty)
  const orderQty = num(po.qty)
  if (done + num(addGood) > orderQty + 1e-9) {
    throw new MfgError(
      `入库数量超出订单：已完工 ${round4(done)} + ${what} ${round4(addGood)} > 订单数量 ${round4(orderQty)}。超产请先调整订单数量`,
      { code: 'MFG_OVER_COMPLETE', detail: { completed: done, thisTime: round4(addGood), orderQty } }
    )
  }
}

export function transitionIssue(db, { id, action, actor = {}, remark = null, source = 'api' } = {}) {
  const issue = db.prepare('SELECT * FROM material_issues WHERE id=?').get(Number(id))
  if (!issue) throw new MfgError('领料单不存在', { code: 'MFG_ISSUE_NOT_FOUND', httpStatus: 404 })
  if (action === 'issue') return issueOut(db, { id: issue.id, actor, remark })
  applyTransition({ db, docType: 'MR', id: issue.id, action, actor: actorOf(actor), remark, source })
  return getIssue(db, issue.id)
}

/**
 * **实际出库** —— 本模块唯一有库存后果的动作。
 *
 * 逐行调 `applyStockOut`，把出库单价与实际成本回写到行上。
 * 出库单价不在这里算：移动加权/TEFO 的计价规则全在库存引擎里，
 * 这里只负责把结果记下来 —— 两处各算一遍必然对不上。
 */
export function issueOut(db, { id, actor = {}, remark = null, source = 'api' } = {}) {
  const a = actorOf(actor)
  const issue = db.prepare('SELECT * FROM material_issues WHERE id=?').get(Number(id))
  if (!issue) throw new MfgError('领料单不存在', { code: 'MFG_ISSUE_NOT_FOUND', httpStatus: 404 })
  if (issue.status === 'issued') return getIssue(db, issue.id)
  if (issue.status !== 'approved') {
    throw new MfgError(
      `领料单当前状态（${ISSUE_STATUS_LABEL[issue.status] || issue.status}）不能出库，需先审批`,
      { code: 'MFG_ISSUE_NOT_APPROVED' }
    )
  }
  const po = requireOrder(db, issue.order_id)
  if (po.status === 'cancelled') throw new MfgError('生产订单已取消，不能领料', { code: 'MO_STATUS_INVALID' })

  const lines = db
    .prepare('SELECT * FROM material_issue_items WHERE issue_id=? ORDER BY line_no')
    .all(issue.id)
  if (!lines.length) throw new MfgError('领料单没有明细行', { code: 'MFG_ISSUE_EMPTY' })

  // M3：限额领料的「不得超过 BOM 需求」必须在**出库这一刻**再校一次。
  // `createIssue` 只按「建单当时的待领量」判一次（`assertNoOverIssue`），而建单与出库之间
  // 隔着一个窗口：两张各自都不超领的限额单可以依次审批、依次出库 ——
  // 实测累计出库变成 2 × BOM 需求（79.17 + 33.2），单据张张合规。
  // 口径直接复用建单那一条判据（同一个 assertNoOverIssue），保证「建单拦得住的，出库也拦得住」。
  // 补料（supplement）不走这条 —— 它本来就是口径② 允许的显式超领，必须留痕而不是拦住。
  if (issue.issue_type === 'limit') {
    assertNoOverIssue(db, issue.order_id, lines.map((l) => ({ sku_id: l.sku_id, qty: l.qty })))
  }

  let totalAmount = 0
  const results = []
  const autoBatched = []

  const tx = db.transaction(() => {
    for (const l of lines) {
      const qty = num(l.qty)
      if (!(qty > 0)) continue
      const out = applyStockOut(db, {
        warehouseId: issue.warehouse_id,
        skuId: l.sku_id,
        batchNo: l.batch_no || '',
        qty,
        docType: 'MR',
        txnType: 'PRD_OUT',
        docNo: issue.doc_no,
        docId: issue.id,
        bizDate: issue.issue_date,
        operator: a.name || null,
        remark: `生产领料 ${issue.doc_no} / 订单 ${issue.order_no}`,
        source
      })
      const unitCost = num(out.unitCost)
      // 本次出库金额 = 数量 × 出库单价。**不要用 `out.costAmount`** ——
      // 库存引擎返回的 `costAmount` 是**出库之后的结存金额**（`after.amount`），
      // 不是本次出库额。拿它当出库额会让领料金额随「这个仓还剩多少钱」而变：
      // 同一个批次领两次一样多的料，第二次记的金额会和第一次不同，
      // 而两张单的单价数量完全一样 —— 这种错误在单据上看不出、只在成本账上错。
      //
      // A11：跨批次时 `out.unitCost` 必须是**各批次的加权平均**（库存引擎已按此返回），
      // 否则整行按"最后一个批次"的价算 —— 两批价差越大错得越多，而且账还平。
      // 需要逐批核对时用 `out.batches[]`（现在带 `unitCost` 与 `outAmount`），
      // 或直接用 `out.outAmount`（本次出库总额，已由各批次汇总）。
      const amount = round4(qty * unitCost)
      totalAmount += amount
      // 未指定批次时库存引擎会跨批次拣选：把实际批次回写。
      // 单批次直接写回 `batch_no`（一行 → 一行流水，可逐行核对）；
      // 跨批次则留在备注里，行上保持空 —— 凭空写一个批次会让「这行扣的是哪批」变成假话。
      if (!l.batch_no && out.batchNo) {
        // 注意 `material_issue_items` **没有 updated_at 列**（行只在出库那一刻写一次），
        // 这里别顺手带上它 —— 只有「行没指定批次」时才走到这条 UPDATE，
        // 于是它会伪装成偶发错误：同一张单换种领料方式就炸、换回去又不炸。
        db.prepare('UPDATE material_issue_items SET batch_no=? WHERE id=?').run(out.batchNo, l.id)
      } else if (!l.batch_no && out.split) {
        autoBatched.push({ line_no: l.line_no, batches: (out.batches || []).map((b) => `${b.batchNo || '-'}×${b.qty}`).join(' + ') })
      }
      db.prepare('UPDATE material_issue_items SET issued_qty=?, unit_cost=?, amount=? WHERE id=?').run(
        qty, round4(unitCost), amount, l.id
      )
      results.push({ line_no: l.line_no, sku_id: l.sku_id, batch_no: out.batchNo || l.batch_no || '', qty, unit_cost: round4(unitCost), amount })
    }
    if (autoBatched.length) {
      const note = `跨批次拣选：${autoBatched.map((x) => `行#${x.line_no} ${x.batches}`).join('；')}`
      db.prepare('UPDATE material_issues SET remark = COALESCE(remark || \' | \', \'\') || ? WHERE id=?').run(note, issue.id)
    }
    db.prepare(
      `UPDATE material_issues SET status='issued', total_amount=?, total_qty=?, issued_by=?, issued_by_name=?,
         issued_at=?, updated_at=? WHERE id=?`
    ).run(round4(totalAmount), round4(lines.reduce((n, l) => n + num(l.qty), 0)), a.id ?? null, a.name ?? null, nowText(), nowText(), issue.id)

    // 留痕：出库是**有后果**的动作，必须在内核里留一条事件（applyTransition 会写状态，
    // 但这里状态是我们手写的 —— 因为要把金额回写与出库放进同一个事务，
    // 所以补写事件，保证「单据走了哪些环节」这条线不断）。
    //
    // A6：这条 INSERT 原先在 `tx()` **之后**、还套着 `try/catch {}` ——
    // 于是「库存动了、金额写了、留痕没写」可以同时成立，而且**谁都不知道**（异常被吞）。
    // 现在它与出库写在同一个事务里：写不进去就整体回滚，不会出现「动过但无痕」。
    // 与 `lib/settings.js:logSettingChange` / `lib/im-sync.js:applyOrgSync` 同一族的当场断言 ——
    // 写成文档没人记得，写成断言才拦得住把这条 INSERT 挪出事务的下一次改动。
    if (!db.inTransaction) {
      throw new MfgError(
        '领料出库的留痕必须在事务内写入 —— 否则会出现「库存动了、留痕没写」',
        { code: 'MFG_TRACE_OUTSIDE_TX', httpStatus: 500, detail: { id: issue.id } }
      )
    }
    db.prepare(
      `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,created_at)
       VALUES ('MR',?,?, 'issue','确认出库','approved','issued',?,?,?,?,?)`
    ).run(issue.id, issue.doc_no, a.id ?? null, a.name ?? null, source, remark || `出库金额 ${round2(totalAmount)}`, nowText())
  })
  tx()

  return { ...getIssue(db, issue.id), out_lines: results, auto_batched: autoBatched }
}

export function getIssue(db, id) {
  const issue = db.prepare('SELECT * FROM material_issues WHERE id=?').get(Number(id))
  if (!issue) return null
  const items = db.prepare('SELECT * FROM material_issue_items WHERE issue_id=? ORDER BY line_no').all(issue.id)
  const order = db.prepare('SELECT id,doc_no,status,product_sku_id FROM production_orders WHERE id=?').get(issue.order_id)
  const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(issue.warehouse_id)
  const events = db
    .prepare("SELECT * FROM doc_events WHERE doc_type='MR' AND doc_id=? ORDER BY id")
    .all(issue.id)
  return {
    ...issue,
    status_label: ISSUE_STATUS_LABEL[issue.status] || issue.status,
    issue_type_label: ISSUE_TYPE_LABEL[issue.issue_type] || issue.issue_type,
    warehouse_name: wh?.name || null,
    order_no: order?.doc_no || issue.order_no,
    order,
    items,
    events
  }
}

export function listIssues(db, q = {}) {
  const where = []
  const args = []
  if (q.status) { where.push('mi.status = ?'); args.push(q.status) }
  if (q.issueType) { where.push('mi.issue_type = ?'); args.push(q.issueType) }
  if (q.orderId) { where.push('mi.order_id = ?'); args.push(Number(q.orderId)) }
  if (q.keyword) {
    where.push('(mi.doc_no LIKE ? OR mi.order_no LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20))
  const total = db.prepare(`SELECT COUNT(*) AS c FROM material_issues mi ${w}`).get(...args).c
  const list = db
    .prepare(
      `SELECT mi.*, w.name AS warehouse_name,
              (SELECT COUNT(*) FROM material_issue_items x WHERE x.issue_id=mi.id) AS item_count
         FROM material_issues mi LEFT JOIN warehouses w ON w.id = mi.warehouse_id
         ${w} ORDER BY mi.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  return {
    list: list.map((i) => ({
      ...i,
      status_label: ISSUE_STATUS_LABEL[i.status] || i.status,
      issue_type_label: ISSUE_TYPE_LABEL[i.issue_type] || i.issue_type
    })),
    total, page, pageSize
  }
}

// ---------------------------------------------------------------------------
// 完工汇报
// ---------------------------------------------------------------------------

/**
 * 记一次完工汇报。
 *
 * 第三轮口径 G4「生产不报工」的落地：**它不推进任何状态、不进审批**。
 * 之所以仍要单独取号，是因为完工入库要能反查到「这批货是哪次汇报做出来的」——
 * 没有号的话「8 件不良是什么时候发现的」只能靠时间猜。
 */
export function createWorkReport(db, p = {}) {
  const actor = actorOf(p.actor)
  const po = requireOrder(db, p.orderId)
  if (po.status !== 'in_progress') {
    throw new MfgError(
      `生产订单当前状态（${ORDER_STATUS_LABEL[po.status] || po.status}）不能登记完工汇报：只有「生产中」的订单才有完工产出`,
      { code: 'MO_NOT_STARTED', detail: { status: po.status } }
    )
  }

  const goodQty = round4(p.goodQty ?? p.good_qty)
  const defectQty = round4(p.defectQty ?? p.defect_qty)
  if (goodQty < 0 || defectQty < 0) throw new MfgError('良品数与不良数不能为负', { code: 'MFG_QTY_INVALID' })
  if (goodQty + defectQty <= 0) throw new MfgError('良品数与不良数不能同时为 0', { code: 'MFG_QTY_EMPTY' })

  // 超产校验：累计良品不得超过订单数量。
  // 不做「允许 5% 超产」这种弹性 —— 超产是计划问题，应该体现为改订单数量，
  // 而不是让完工入库悄悄多出一批没人下过单的货。
  assertNotOverComplete(po, goodQty)

  const hours = num(p.workHours ?? p.work_hours)
  const rate = num(p.laborRate ?? p.labor_rate)
  if (hours < 0 || rate < 0) throw new MfgError('工时与人工费率不能为负', { code: 'MFG_HOURS_INVALID' })

  const warehouseId = p.warehouseId != null ? Number(p.warehouseId) : po.warehouse_id
  const reportDate = p.reportDate || p.report_date || localDate()
  const docNo = p.docNo || nextDocNo(db, 'WRP', 'work_reports', 'doc_no', reportDate)
  const now = nowText()

  const info = db
    .prepare(
      `INSERT INTO work_reports (doc_no,order_id,order_no,issue_id,report_date,process_name,good_qty,defect_qty,
         work_hours,labor_rate,labor_cost,overhead_cost,material_cost,unit_cost,warehouse_id,batch_no,
         stock_done,operator_id,operator_name,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,0,?,?,?,?,?,?)`
    )
    .run(
      docNo, po.id, po.doc_no, p.issueId != null ? Number(p.issueId) : null, reportDate,
      p.processName || p.process_name || null,
      goodQty, defectQty, hours, rate, round2(hours * rate), round2(p.overheadCost ?? p.overhead_cost),
      warehouseId ?? null, p.batchNo || '', actor.id ?? null, actor.name ?? null, p.remark || null,
      actor.id ?? null, now, now
    )
  return getWorkReport(db, info.lastInsertRowid)
}

export function getWorkReport(db, id) {
  const wr = db.prepare('SELECT * FROM work_reports WHERE id=?').get(Number(id))
  if (!wr) return null
  const order = db.prepare('SELECT id,doc_no,status,qty,completed_qty,product_sku_id FROM production_orders WHERE id=?').get(wr.order_id)
  return { ...wr, order }
}

export function listWorkReports(db, q = {}) {
  const where = []
  const args = []
  if (q.orderId) { where.push('wr.order_id = ?'); args.push(Number(q.orderId)) }
  if (q.stockDone != null) { where.push('wr.stock_done = ?'); args.push(Number(q.stockDone)) }
  if (q.keyword) {
    where.push('(wr.doc_no LIKE ? OR wr.order_no LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20))
  const total = db.prepare(`SELECT COUNT(*) AS c FROM work_reports wr ${w}`).get(...args).c
  const list = db
    .prepare(
      `SELECT wr.*, sk.sku_code AS sku_code, sk.name AS sku_name, w.name AS warehouse_name
         FROM work_reports wr
         LEFT JOIN production_orders po ON po.id = wr.order_id
         LEFT JOIN product_skus sk ON sk.id = po.product_sku_id
         LEFT JOIN warehouses w ON w.id = wr.warehouse_id
         ${w} ORDER BY wr.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  return { list, total, page, pageSize }
}

export function updateWorkReport(db, p = {}) {
  const wr = db.prepare('SELECT * FROM work_reports WHERE id=?').get(Number(p.id))
  if (!wr) throw new MfgError('完工汇报不存在', { code: 'MFG_REPORT_NOT_FOUND', httpStatus: 404 })
  if (wr.stock_done) {
    throw new MfgError('已入库的完工汇报不能修改：货已经在库里了，改数量会让库存账对不上', {
      code: 'MFG_REPORT_LOCKED'
    })
  }
  const hours = p.workHours != null || p.work_hours != null ? num(p.workHours ?? p.work_hours) : num(wr.work_hours)
  const rate = p.laborRate != null || p.labor_rate != null ? num(p.laborRate ?? p.labor_rate) : num(wr.labor_rate)
  // 改汇报同样要复校超产：不然「建单时合规、改单时放大」就是一条绕过路径
  // （实测：报良品 1 → `PUT /reports/:id {good_qty:9999}` → 完工入库 9999）。
  // 这里拦一次是给人即时反馈；**真正兜底的是 completeOrder 里那次**（见 assertNotOverComplete）。
  const nextGoodQty = p.goodQty != null || p.good_qty != null ? round4(p.goodQty ?? p.good_qty) : num(wr.good_qty)
  assertNotOverComplete(requireOrder(db, wr.order_id), nextGoodQty, '修改后良品数')
  db.prepare(
    `UPDATE work_reports SET process_name=?, good_qty=?, defect_qty=?, work_hours=?, labor_rate=?, labor_cost=?,
       overhead_cost=?, report_date=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    p.processName !== undefined ? p.processName : wr.process_name,
    nextGoodQty,
    p.defectQty != null || p.defect_qty != null ? round4(p.defectQty ?? p.defect_qty) : wr.defect_qty,
    hours, rate, round2(hours * rate),
    p.overheadCost != null || p.overhead_cost != null ? round2(p.overheadCost ?? p.overhead_cost) : wr.overhead_cost,
    p.reportDate || p.report_date || wr.report_date,
    p.remark !== undefined ? p.remark : wr.remark,
    nowText(), wr.id
  )
  return getWorkReport(db, wr.id)
}

export function deleteWorkReport(db, { id } = {}) {
  const wr = db.prepare('SELECT * FROM work_reports WHERE id=?').get(Number(id))
  if (!wr) throw new MfgError('完工汇报不存在', { code: 'MFG_REPORT_NOT_FOUND', httpStatus: 404 })
  if (wr.stock_done) throw new MfgError('已入库的完工汇报不能删除', { code: 'MFG_REPORT_LOCKED' })
  db.prepare('DELETE FROM work_reports WHERE id=?').run(wr.id)
  return { id: wr.id, deleted: true }
}

// ---------------------------------------------------------------------------
// 完工入库 + 料工费归集（本模块的高潮）
// ---------------------------------------------------------------------------

/**
 * 完工入库。
 *
 * 做三件事，同一个事务：
 *   ① 按指定汇报单（或全部未入库汇报）把**良品数**入到库存；
 *   ② 按口径③ 计算材料 / 人工 / 制造费用，回写到每条汇报；
 *   ③ 汇总回写生产订单的 `completed_qty / material_cost / total_cost / unit_cost`，
 *      并在全部完工后把订单推进到 `completed`。
 *
 * @param {object} p
 * @param {number} [p.reportId]  只入库某一条汇报；不传则入库该订单所有未入库的汇报
 * @param {number} [p.batchNo]   指定入库批次；不传则自动生成（成品批次 = 母件码 + 日期）
 */
export function completeOrder(db, p = {}) {
  const actor = actorOf(p.actor)
  const po = requireOrder(db, p.orderId)
  // 完工入库同样要求「生产中」：一张没开工的订单直接完工入库，
  // 意味着库里凭空多出一批货而没有对应的料出库，成本会全部落到「无材料成本」上。
  if (po.status !== 'in_progress') {
    throw new MfgError(
      `生产订单当前状态（${ORDER_STATUS_LABEL[po.status] || po.status}）不能完工入库：请先「开工」`,
      { code: 'MO_NOT_STARTED', detail: { status: po.status } }
    )
  }

  // M1：**没有领料就不许完工入库**，否则成品以 0 材料成本入账
  // （实测：MO 10、零领料、报完工 10 ⇒ 入库成功、`material_cost=0`、`PRD_IN` 流水金额 0）。
  // 「材料成本 ÷ 订单数量」这个分母不是问题所在：领料总额本身就是 0，怎么摊都是 0 ——
  // 所以判据必须加在**入库之前**，而不是去修正成本算法。
  //
  // 判据用「已出库领料的**数量**」而不是金额：料可以是 0 成本的（赠料、无价调入），
  // 用金额会把「真的领了料但库里没成本」这类一起拦下，那是库存成本没回写（审计第①项管的）。
  //
  // 唯一的放行口：本单**确实无料可领** —— 没有生效 BOM 或 BOM 展开为空（需求量为 0）。
  // 依据：设计文档 4.2 写明「没有 BOM 时返回 `bom: null` 与一句人话提示（请手工添加领料行）」，
  // 即这条路上仍可以手工建领料单；手工建了就走上面那条判据。一张都没建，说明这笔订单
  // 没有原料组成（组合装/试产这类无料成品就是这种形态），此时「拦住不让完工」只会让
  // 订单永远完不了工，并不能补上「没维护 BOM」这个数据缺口 —— 那个缺口由
  // `mfgOverview.in_progress_without_report` 与「能生产但没 BOM」的计数单独暴露。
  if (num(po.qty) > 1e-9) {
    const issuedQty = num(
      db.prepare("SELECT COALESCE(SUM(total_qty),0) AS q FROM material_issues WHERE order_id=? AND status='issued'").get(po.id).q
    )
    if (issuedQty <= 1e-9) {
      const requiredQty = num(planRequirement(db, { orderId: po.id }).summary.required_qty)
      if (requiredQty > 1e-9) {
        throw new MfgError(
          `该订单还没有领料出库（BOM 需求 ${round4(requiredQty)}），不能完工入库：请先领料。` +
          `没有领料就完工，成品会以 0 材料成本入账 —— 账上凭空多出一批没有原料来源的货`,
          { code: 'MFG_NO_ISSUED_MATERIAL', detail: { order_id: po.id, required_qty: round4(requiredQty) } }
        )
      }
    }
  }

  const reports = p.reportId
    ? db.prepare('SELECT * FROM work_reports WHERE id=? AND order_id=? AND stock_done=0').all(Number(p.reportId), po.id)
    : db.prepare('SELECT * FROM work_reports WHERE order_id=? AND stock_done=0 ORDER BY id').all(po.id)

  if (!reports.length) {
    throw new MfgError('没有待入库的完工汇报：请先登记本次完工的良品与不良数量', { code: 'MFG_NO_PENDING_REPORT' })
  }

  // 口径③ 的分母：**订单数量**，不是「本次良品」也不是「实际领料」。
  // 用订单数量做分母，累计归集 = 领料总额 × 累计入库 / 订单数量 ≤ 领料总额，
  // 天然不会出现「完工入完库、材料成本却超过领料总额」这种怪事。
  const issuedAmount = num(
    db
      .prepare("SELECT COALESCE(SUM(total_amount),0) AS a FROM material_issues WHERE order_id=? AND status='issued'")
      .get(po.id).a
  )
  const orderQty = num(po.qty) || 1
  const unitMaterial = issuedAmount / orderQty

  const sku = getSkuInfo(db, po.product_sku_id)
  const warehouseId = p.warehouseId != null ? Number(p.warehouseId) : po.warehouse_id
  if (!warehouseId) throw new MfgError('生产订单没有指定仓库，无法入库', { code: 'MFG_WAREHOUSE_REQUIRED' })

  const detail = []
  let addedGood = 0
  let addedMaterial = 0
  let addedConversion = 0

  const tx = db.transaction(() => {
    // M2：超产判据必须在**最终落库这一步**再校一次（这就是那一步：库存加分 + 订单完工数回写）。
    // 只拦「建汇报」是不够的 —— `PUT /reports/:id` 绕过它把良品数放大即可（实测 1 → 9999）。
    // 判据同样是「累计良品 ≤ 订单数量」，与建汇报共用 assertNotOverComplete，不另写一份。
    assertNotOverComplete(po, reports.reduce((n, r) => n + (num(r.good_qty) > 0 ? num(r.good_qty) : 0), 0))

    for (const r of reports) {
      const good = num(r.good_qty)
      if (good <= 0) {
        // 坏一批、良品为 0：标记为已处理但不入库 —— 直接跳过它，
        // 否则每次完工都会反复捞到这条「永远入不了库」的汇报。
        db.prepare("UPDATE work_reports SET stock_done=1, stock_doc_no=?, unit_cost=0, updated_at=? WHERE id=?").run(
          `无入库（良品 0）`, nowText(), r.id
        )
        continue
      }
      const materialCost = round2(unitMaterial * good)
      const conversion = round2(num(r.labor_cost) + num(r.overhead_cost))
      const unitCost = round4((materialCost + conversion) / good)

      const batchNo = p.batchNo || r.batch_no || `${(sku?.code || 'MO').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase()}${localDate(r.report_date).replace(/-/g, '').slice(2)}`
      const inRes = applyStockIn(db, {
        warehouseId,
        skuId: po.product_sku_id,
        batchNo,
        qty: good,
        unitCost,
        docType: 'MO',
        txnType: 'PRD_IN',
        docNo: po.doc_no,
        docId: po.id,
        bizDate: localDate(r.report_date),
        produceDate: localDate(r.report_date),
        // 完工入库的成品**未质检**：这是模块 13 报检链的入口（v_qc_pending_source 用的是订单 completed）。
        // 直接标 qualified 等于把「没检」说成「检合格了」。
        qcStatus: 'pending',
        operator: actor.name || null,
        remark: `生产完工入库 ${po.doc_no} / 汇报 ${r.doc_no}`,
        source: p.source || 'api'
      })

      db.prepare(
        `UPDATE work_reports SET material_cost=?, unit_cost=?, warehouse_id=?, batch_no=?, stock_done=1,
           stock_doc_no=?, updated_at=? WHERE id=?`
      ).run(materialCost, unitCost, warehouseId, batchNo, `${po.doc_no}/${batchNo}`, nowText(), r.id)

      detail.push({
        report_id: r.id, report_no: r.doc_no, good_qty: good, defect_qty: num(r.defect_qty),
        batch_no: inRes.batchNo, material_cost: materialCost, labor_cost: num(r.labor_cost),
        overhead_cost: num(r.overhead_cost), unit_cost: unitCost
      })
      addedGood += good
      addedMaterial += materialCost
      addedConversion += conversion
    }

    const newCompleted = round4(num(po.completed_qty) + addedGood)
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(material_cost),0) AS m, COALESCE(SUM(labor_cost+overhead_cost),0) AS c
           FROM work_reports WHERE order_id=? AND stock_done=1`
      )
      .get(po.id)
    const totalCost = round2(num(totals.m) + num(totals.c))
    const unitTotal = newCompleted > 0 ? round4(totalCost / newCompleted) : 0

    db.prepare('UPDATE production_orders SET completed_qty=?, material_cost=?, total_cost=?, unit_cost=?, updated_at=? WHERE id=?').run(
      newCompleted, round2(num(totals.m)), totalCost, unitTotal, nowText(), po.id
    )

    // 全部完工才推进状态：只入了一部分就标 completed，会让「在制」这件事从界面上消失
    if (newCompleted + 1e-9 >= orderQty && po.status === 'in_progress') {
      applyTransition({ db, docType: 'MO', id: po.id, action: 'complete', actor, remark: `完工入库 ${addedGood}`, source: p.source || 'api' })
    }
  })
  tx()

  return {
    order: getProductionOrder(db, po.id),
    completed_this_time: round4(addedGood),
    material_cost: round2(addedMaterial),
    conversion_cost: round2(addedConversion),
    lines: detail,
    stock_in_qty: addedGood
  }
}

/** 汇总（无副作用）：不落库地预览「这次完工入库会归集多少钱」 */
export function previewCompletion(db, { orderId, reportId = null } = {}) {
  const po = requireOrder(db, orderId)
  const reports = reportId
    ? db.prepare('SELECT * FROM work_reports WHERE id=? AND order_id=? AND stock_done=0').all(Number(reportId), po.id)
    : db.prepare('SELECT * FROM work_reports WHERE order_id=? AND stock_done=0 ORDER BY id').all(po.id)
  const issuedAmount = num(
    db.prepare("SELECT COALESCE(SUM(total_amount),0) AS a FROM material_issues WHERE order_id=? AND status='issued'").get(po.id).a
  )
  const orderQty = num(po.qty) || 1
  const unitMaterial = issuedAmount / orderQty
  const good = reports.reduce((n, r) => n + num(r.good_qty), 0)
  const conversion = reports.reduce((n, r) => n + num(r.labor_cost) + num(r.overhead_cost), 0)
  const material = round2(unitMaterial * good)
  return {
    order_id: po.id, order_no: po.doc_no, order_qty: orderQty,
    pending_report_count: reports.length,
    good_qty: round4(good),
    defect_qty: round4(reports.reduce((n, r) => n + num(r.defect_qty), 0)),
    issued_amount: round2(issuedAmount),
    unit_material: round4(unitMaterial),
    material_cost: material,
    conversion_cost: round2(conversion),
    total_cost: round2(material + conversion),
    unit_cost: good > 0 ? round4((material + conversion) / good) : 0,
    will_complete_order: num(po.completed_qty) + good + 1e-9 >= orderQty
  }
}

// ---------------------------------------------------------------------------
// 总览与审计
// ---------------------------------------------------------------------------

export function mfgOverview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const orders = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status IN ('approved','in_progress') THEN 1 ELSE 0 END) AS wip,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
           COALESCE(SUM(CASE WHEN status IN ('approved','in_progress') THEN qty - COALESCE(completed_qty,0) ELSE 0 END),0) AS wip_qty
      FROM production_orders`)
  const issues = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='issued' THEN 1 ELSE 0 END) AS issued,
           COALESCE(SUM(CASE WHEN status='issued' THEN total_amount ELSE 0 END),0) AS issued_amount
      FROM material_issues`)
  const reports = one(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(good_qty),0) AS good_qty,
           COALESCE(SUM(defect_qty),0) AS defect_qty,
           COALESCE(SUM(work_hours),0) AS hours,
           COALESCE(SUM(labor_cost + overhead_cost),0) AS conversion
      FROM work_reports`)
  const pendingReport = one(`
    SELECT COUNT(*) AS c FROM work_reports WHERE stock_done=0 AND good_qty > 0`)
  const noReport = one(`
    SELECT COUNT(*) AS c FROM production_orders po
     WHERE po.status='in_progress' AND NOT EXISTS (SELECT 1 FROM work_reports wr WHERE wr.order_id=po.id)`)
  const totalGood = num(reports.good_qty)
  const totalDefect = num(reports.defect_qty)
  return {
    orders: {
      total: orders.total || 0, wip: orders.wip || 0, completed: orders.completed || 0,
      wip_qty: round4(orders.wip_qty)
    },
    issues: {
      total: issues.total || 0, issued: issues.issued || 0, issued_amount: round2(issues.issued_amount)
    },
    reports: {
      total: reports.total || 0,
      good_qty: round4(totalGood),
      defect_qty: round4(totalDefect),
      defect_rate: totalGood + totalDefect > 0 ? round2((totalDefect / (totalGood + totalDefect)) * 100) : 0,
      hours: round4(reports.hours),
      conversion_cost: round2(reports.conversion)
    },
    pending_stock_in: pendingReport.c || 0,
    in_progress_without_report: noReport.c || 0
  }
}

/**
 * 自洽审计：把「不该出现的中间态」变成可查的不变量。
 * 这些断言都是「跑起来不报错、账却是错的」那一类，只有专职检查才抓得到。
 */
export function auditMfg(db) {
  const issues = []

  // ① 已出库但金额为 0 —— 出库一定产生成本，0 金额说明流水没写成功
  for (const r of db
    .prepare("SELECT id,doc_no,total_qty,total_amount FROM material_issues WHERE status='issued' AND total_qty > 0 AND total_amount <= 0")
    .all()) {
    issues.push({ code: 'issue_no_cost', level: 'error', ref: r.doc_no, message: `领料单 ${r.doc_no} 已出库 ${r.total_qty} 但金额为 0（库存成本未回写）` })
  }

  // ② 已出库的领料单必须有库存流水 —— 状态说「出了库」而流水查不到，是本模块最严重的失效
  for (const r of db
    .prepare(
      `SELECT mi.id, mi.doc_no FROM material_issues mi
        WHERE mi.status='issued'
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.doc_type='MR' AND t.doc_id=mi.id AND t.direction='out')`
    )
    .all()) {
    issues.push({ code: 'issue_without_txn', level: 'error', ref: r.doc_no, message: `领料单 ${r.doc_no} 状态为已出库，但库存流水里找不到对应记录` })
  }

  // ③ 行级数量与出库量不一致 —— 头行结平是基本要求
  for (const r of db
    .prepare(
      `SELECT mi.doc_no, SUM(mii.qty) AS s FROM material_issues mi
         JOIN material_issue_items mii ON mii.issue_id=mi.id
        WHERE mi.status='issued' GROUP BY mi.id HAVING ABS(SUM(mii.qty) - mi.total_qty) > 0.01`
    )
    .all()) {
    issues.push({ code: 'issue_qty_mismatch', level: 'error', ref: r.doc_no, message: `领料单 ${r.doc_no} 行合计与表头数量不一致` })
  }

  // ④ 已入库的汇报必须有库存流水
  for (const r of db
    .prepare(
      `SELECT wr.id, wr.doc_no, wr.good_qty FROM work_reports wr
        WHERE wr.stock_done=1 AND wr.good_qty > 0
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.doc_type='MO' AND t.doc_id=wr.order_id AND t.direction='in' AND t.doc_no = wr.order_no)`
    )
    .all()) {
    issues.push({ code: 'report_without_stock_in', level: 'error', ref: r.doc_no, message: `完工汇报 ${r.doc_no} 已标记入库，但找不到对应的完工入库流水` })
  }

  // ⑤ 订单完工数与已入库汇报的良品数不一致 —— 两个口径必须同源
  for (const r of db
    .prepare(
      `SELECT po.id, po.doc_no, po.completed_qty, COALESCE(SUM(wr.good_qty),0) AS good
         FROM production_orders po LEFT JOIN work_reports wr ON wr.order_id=po.id AND wr.stock_done=1
        GROUP BY po.id HAVING ABS(COALESCE(po.completed_qty,0) - COALESCE(SUM(wr.good_qty),0)) > 0.01`
    )
    .all()) {
    issues.push({
      code: 'order_completed_mismatch', level: 'error', ref: r.doc_no,
      message: `生产订单 ${r.doc_no} 的完工数 ${r.completed_qty} 与已入库汇报良品合计 ${r.good} 不一致`
    })
  }

  // ⑥ 订单材料成本 ≠ 其汇报归集之和 —— 「料」这一项必须对得上。
  // 这里的条件写在 WHERE 而不是 HAVING：本查询没有 GROUP BY，
  // 用 HAVING 会被 SQLite 判为「非聚合查询上的 HAVING」直接抛错 ——
  // 而审计函数抛错会让整个审计页打不开，一处写错等于这项检查不存在。
  for (const r of db
    .prepare(
      `SELECT po.doc_no, po.material_cost,
              COALESCE((SELECT SUM(wr.material_cost) FROM work_reports wr WHERE wr.order_id=po.id),0) AS collected
         FROM production_orders po
        WHERE po.status IN ('in_progress','completed','closed')
          AND ABS(COALESCE(po.material_cost,0)
                  - COALESCE((SELECT SUM(wr.material_cost) FROM work_reports wr WHERE wr.order_id=po.id),0)) > 0.05`
    )
    .all()) {
    issues.push({
      code: 'order_material_mismatch', level: 'warn', ref: r.doc_no,
      message: `生产订单 ${r.doc_no} 材料成本 ${r.material_cost} 与汇报归集合计 ${r.collected} 不一致（可能尚未完工入库）`
    })
  }

  // ⑦ 超领：**累计已出库** 超过 BOM 需求，且超出的部分没有「补料单」解释。
  //
  // 修之前这一项有两种病（都实测出来了）：
  //   · **误报** —— 只要 `status='issued' AND issue_type='limit'` 就无条件 push warn，
  //     **根本不与 BOM 需求比对**：两张各自都不超领、合计正好等于需求的限额单被判出 2 条「存在超领记录」。
  //     误报的代价不是多一行字，是这一项从此没人看 —— 真正的超领会跟着一起被忽略。
  //   · **漏报** —— 检查范围只有 `limit`，而按 BOM 领料（`by_bom`）与补料（`supplement`）
  //     才是现场真正会超出需求的两类：领到 7 倍需求、一张补料单都没有，这项也一声不吭。
  //
  // 现在的判据：按 (订单, SKU) 汇总**全部已出库领料单**的 `issued_qty`，与 `planRequirement` 的
  // BOM 需求比对；超出的部分若不超过该 (订单, SKU) 的补料出库量，就认为已被「补料」解释 ——
  // 补料是口径② 明确允许的显式超领（必须填原因、留痕），把它判成异常就成了新的误报。
  const issuedByOrderSku = db
    .prepare(
      `SELECT mi.id, mi.doc_no, mi.order_id, mi.issue_type, mii.sku_id, mii.issued_qty
         FROM material_issues mi JOIN material_issue_items mii ON mii.issue_id = mi.id
        WHERE mi.status='issued'
        ORDER BY mi.id, mii.id`
    )
    .all()
  if (issuedByOrderSku.length) {
    const agg = new Map()
    for (const r of issuedByOrderSku) {
      const key = `${r.order_id}|${r.sku_id}`
      const a = agg.get(key) || { order_id: r.order_id, sku_id: r.sku_id, issued: 0, supplemented: 0, last_doc_no: null }
      a.issued += num(r.issued_qty)
      if (r.issue_type === 'supplement') a.supplemented += num(r.issued_qty)
      else a.last_doc_no = r.doc_no   // 非补料单里最后一张 —— 出问题时指向它，人能顺着查下去
      agg.set(key, a)
    }
    const demandCache = new Map()
    const demandOf = (orderId) => {
      if (!demandCache.has(orderId)) {
        // 审计函数**绝不能抛错**（一处抛错 = 整个审计页打不开，等于这项检查不存在）。
        // 没有生效 BOM（`bom: null`）或展开失败时返回 null，表示「没有需求口径可比」——
        // 此时不猜、不报：没有 BOM 的订单本来就不该拿 BOM 需求去判它。
        let map = null
        try {
          const req = planRequirement(db, { orderId, includeIssued: true })
          map = req.bom ? new Map(req.lines.map((l) => [l.sku_id, num(l.qty)])) : null
        } catch { map = null }
        demandCache.set(orderId, map)
      }
      return demandCache.get(orderId)
    }
    for (const a of agg.values()) {
      const demand = demandOf(a.order_id)
      if (!demand) continue
      const need = num(demand.get(a.sku_id))     // 不在 BOM 清单里的料：需求按 0 算，领多少都是超领
      const over = round4(a.issued - a.supplemented - need)
      if (over > 1e-9) {
        issues.push({
          code: 'over_issue', level: 'warn', ref: a.last_doc_no,
          message: `生产订单的 SKU#${a.sku_id} 累计已出库 ${round4(a.issued)}${a.supplemented > 0 ? `（其中补料 ${round4(a.supplemented)}）` : ''} 超过 BOM 需求 ${need}，超出 ${over} 没有补料单解释（最近一张领料单 ${a.last_doc_no}）。确需多领请改用「补料」并填原因`
        })
      }
    }
  }

  return {
    checked_at: nowText(),
    error_count: issues.filter((x) => x.level === 'error').length,
    warn_count: issues.filter((x) => x.level === 'warn').length,
    issues
  }
}

export default {
  MfgError, ISSUE_STATUS_LABEL, ISSUE_TYPE_LABEL, ORDER_STATUS_LABEL,
  planRequirement, listProductionOrders, getProductionOrder, startOrder,
  createIssue, transitionIssue, issueOut, getIssue, listIssues,
  createWorkReport, updateWorkReport, deleteWorkReport, getWorkReport, listWorkReports,
  completeOrder, previewCompletion, mfgOverview, auditMfg
}
