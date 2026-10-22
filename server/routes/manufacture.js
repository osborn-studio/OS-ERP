/**
 * ============================================================================
 * 文件标识：server/routes/manufacture.js ｜ 生产制造路由（模块 10B · BOM / 领料 / 完工）
 * ============================================================================
 * 【职责】生产制造路由（模块 10B · BOM / 领料 / 完工）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 生产制造路由（模块 10B · BOM / 领料 / 完工）
//
// 挂载点：/api/manufacture（独立前缀）
//
// 为什么不并进 /api/demand：`demand` 管的是**净需求与计划**（算「要做什么」），
// 本模块管的是**执行**（「照什么做、领什么料、入什么库」）。
// 两者的授权粒度也不同 —— 计划岗能看净需求汇总，但发料与完工是仓管与车间的权限。
//
// 端点分工：
//   GET  /meta                                  —— 字典：用途 / 状态 / 领料类型
//   GET  /overview                              —— 制造总览（在制、领料额、不良率、代入库）
//   GET  /audit                                 —— 自洽审计（出库无流水 / 头行不平 / 完工数与汇报不符）
//   --- BOM ---
//   GET  /boms                                  —— BOM 列表（分页）
//   POST /boms                                  —— 建 BOM（草稿）
//   GET  /boms/by-sku                           —— 按 SKU 取**生效** BOM（唯一取用口径）
//   GET  /boms/:id                              —— BOM 详情（含组件行）
//   PUT  /boms/:id                              —— 改 BOM（已审批不可改）
//   POST /boms/:id/audit | /obsolete            —— 审批 / 作废
//   DELETE /boms/:id                            —— 删草稿
//   POST /boms/:id/expand                       —— 试算展开（不改数据）
//   --- 生产订单（读 + 开工 + 完工入库） ---
//   GET  /orders                                —— 生产订单列表（含领料/完工进度）
//   GET  /orders/:id                            —— 详情（BOM / 领料单 / 汇报 全在一屏）
//   GET  /orders/:id/requirement                —— 还需领用的物料清单
//   POST /orders/:id/start                      —— 开工（进「生产中」）
//   GET  /orders/:id/complete-preview           —— 完工入库金额试算
//   POST /orders/:id/complete                   —— **完工入库**（唯一有库存后果的完工动作）
//   --- 领料单（MR） ---
//   GET  /issues                                —— 列表
//   POST /issues                                —— 建单（不传明细则按 BOM 自动装填）
//   GET  /issues/:id                            —— 详情（含行、留痕）
//   POST /issues/:id/submit | /approve | /cancel —— 提交 / 审批 / 取消
//   POST /issues/:id/issue                      —— **确认出库**（唯一扣库存的动作）
//   --- 完工汇报 ---
//   GET  /reports                               —— 列表
//   POST /reports                               —— 登记汇报（不推进状态，见 023 文件头）
//   GET  /reports/:id                           —— 详情
//   PUT  /reports/:id | DELETE /reports/:id     —— 改 / 删（仅未入库）
//
// 路径顺序：所有静态段（/meta、/overview、/audit、/boms/by-sku…）必须注册在
// `/:id` 之前，否则会被当成 id 匹配 —— 本项目踩过两次，这里一律先静态后动态。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  BomError, USAGE_LABEL, BOM_STATUS_LABEL,
  listBoms, getBom, createBom, updateBom, auditBom, obsoleteBom, deleteBom,
  resolveBom, bomUsagesOf, expandBom, bomOverview
} from '../lib/bom.js'
import {
  MfgError, ISSUE_STATUS_LABEL, ISSUE_TYPE_LABEL, ORDER_STATUS_LABEL,
  listProductionOrders, getProductionOrder, startOrder, planRequirement,
  listIssues, getIssue, createIssue, transitionIssue,
  listWorkReports, getWorkReport, createWorkReport, updateWorkReport, deleteWorkReport,
  completeOrder, previewCompletion, mfgOverview, auditMfg
} from '../lib/mfg.js'

const r = Router()
const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.uid || u.id || null, name: u.name || u.username || null }
}

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof BomError || e instanceof MfgError) {
        return bizFail(res, e)
      }
      // 内核与库存引擎抛的错（DocFlowError / INSUFFICIENT_STOCK）也带 status + code，
      // 一并按业务错误返回 —— 否则用户看到 500「服务器错误」，
      // 而真实原因（库存不足 / 状态已变）本来可以直接告诉他。
      if (e && e.code && e.status) return bizFail(res, e)
      throw e
    }
  })
}
const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))

const P_VIEW = 'produce.bom.view'
const P_BOM = 'produce.bom.edit'
const P_ISSUE = 'produce.issue'
const P_RECEIPT = 'produce.receipt'

// ===========================================================================
// 元数据 / 概览 / 审计
// ===========================================================================

r.get('/meta', requireAuth, wrap((_req, res) =>
  ok(res, {
    usages: dict(USAGE_LABEL),
    bom_statuses: dict(BOM_STATUS_LABEL),
    issue_statuses: dict(ISSUE_STATUS_LABEL),
    issue_types: dict(ISSUE_TYPE_LABEL),
    order_statuses: dict(ORDER_STATUS_LABEL),
    produce_ways: [
      { value: 'self_made', label: '自制' },
      { value: 'outsourced', label: '委外' }
    ],
    // 口径写在 meta 里，前端不用猜：这几条与后端校验完全对应
    rules: [
      { code: 'one_bom', text: '一个母件 + 一个用途只能有一个 BOM；换版请作废旧版再新建' },
      { code: 'expand_loss', text: '展开用量 = 单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量（已含损耗）' },
      { code: 'substitute', text: '替代料同组内互为替代：优先取库存够的，其次取优先级高的；未选中主料时给出原因' },
      { code: 'issue_final', text: '领料单一经出库即为终态；退料请另开单据' },
      // 这条与审计第 ⑦ 项是**同一件事的两个层次**，措辞必须同宽：
      // 限额单在建单与出库时**硬拦**（assertNoOverIssue）；按 BOM 领料 / 补料两类
      // 没有建单闸门（补料本就是显式超领、必须留痕而不是拦住），靠审计按
      //「累计已出库 − 补料 − BOM 需求」逐 (订单, SKU) 告警兜。
      { code: 'over_issue', text: '累计领用不得超过 BOM 需求；确需多领请改用「补料」并填原因（补料单可以解释超出量）' },
      // 本数组的 code 是**语义 id**，不是响应码。
      // no_issued_material / over_complete 确有对应异常码 MFG_NO_ISSUED_MATERIAL（lib/mfg.js:774，completeOrder 抛）
      // 与 MFG_OVER_COMPLETE（:403，assertNotOverComplete 抛）—— 改回语义 id 是**取值域统一**的决定，不是"它们没有码"。
      // 若将来要把卡片接到真实码上，须整张表一起决议、逐条指定命名空间（审计项码 vs 异常码），不要逐条改。
      { code: 'no_issued_material', text: '没有已出库领料不能完工入库；确实无料可领（无生效 BOM）时才放行' },
      { code: 'over_complete', text: '累计良品不得超过订单数量（登记/修改汇报与完工入库三处共用同一判据）' },
      { code: 'cost_alloc', text: '材料成本按订单数量分摊：单位材料 = 已出库领料总额 ÷ 订单数量' },
      { code: 'no_work_report', text: '按第三轮口径 G4「生产不报工」：完工汇报不推进单据状态，只作为完工入库的依据' }
    ]
  })
))

r.get('/overview', requireAuth, requirePerm(P_VIEW), wrap((_req, res) =>
  ok(res, { ...mfgOverview(getDb()), bom: bomOverview(getDb()) })
))

r.get('/audit', requireAuth, requirePerm(P_VIEW), wrap((_req, res) => ok(res, auditMfg(getDb()))))

// ===========================================================================
// BOM
// ===========================================================================

r.get('/boms', requireAuth, requirePerm(P_VIEW), wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  return paged(res, listBoms(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    usage: req.query.usage || null,
    keyword: req.query.keyword || null
  }))
}))

r.get('/boms/by-sku', requireAuth, requirePerm(P_VIEW), wrap((req, res) => {
  const skuId = Number(req.query.sku_id || 0)
  if (!skuId) return fail(res, '需要 sku_id', 400)
  const usage = req.query.usage || 'self_made'
  const bom = resolveBom(getDb(), { skuId, usage, date: req.query.date || null })
  return ok(res, { bom, usages: bomUsagesOf(getDb(), skuId) })
}))

r.post('/boms', requireAuth, requirePerm(P_BOM), guard((req, res) => {
  const out = createBom(getDb(), { ...(req.body || {}), actor: actorOf(req) })
  audit(req, { action: 'CREATE', module: 'manufacture', entity: 'boms', entityId: out.id })
  return ok(res, out)
}))

r.put('/boms/:id', requireAuth, requirePerm(P_BOM), guard((req, res) => {
  const out = updateBom(getDb(), { ...(req.body || {}), id: Number(req.params.id) })
  audit(req, { action: 'UPDATE', module: 'manufacture', entity: 'boms', entityId: out.id })
  return ok(res, out)
}))

r.post('/boms/:id/audit', requireAuth, requirePerm(P_BOM), guard((req, res) => {
  const out = auditBom(getDb(), { id: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'AUDIT', module: 'manufacture', entity: 'boms', entityId: out.id })
  return ok(res, out)
}))

r.post('/boms/:id/obsolete', requireAuth, requirePerm(P_BOM), guard((req, res) => {
  const out = obsoleteBom(getDb(), { id: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'OBSOLETE', module: 'manufacture', entity: 'boms', entityId: out.id })
  return ok(res, out)
}))

r.delete('/boms/:id', requireAuth, requirePerm(P_BOM), guard((req, res) => {
  const out = deleteBom(getDb(), { id: Number(req.params.id) })
  audit(req, { action: 'DELETE', module: 'manufacture', entity: 'boms', entityId: out.id })
  return ok(res, out)
}))

r.post('/boms/:id/expand', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const b = req.body || {}
  const out = expandBom(getDb(), {
    bomId: Number(req.params.id),
    qty: Number(b.qty ?? req.query.qty ?? 0),
    warehouseId: b.warehouse_id != null ? Number(b.warehouse_id) : req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    allowSubstitute: b.allow_substitute !== false
  })
  return ok(res, out)
}))

r.get('/boms/:id', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const data = getBom(getDb(), Number(req.params.id))
  if (!data) return fail(res, 'BOM 不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 生产订单（读 + 开工 + 完工入库）
// ===========================================================================

r.get('/orders', requireAuth, requirePerm(P_VIEW), wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  return paged(res, listProductionOrders(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    keyword: req.query.keyword || null
  }))
}))

r.get('/orders/:id/requirement', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const out = planRequirement(getDb(), {
    orderId: Number(req.params.id),
    warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    includeIssued: req.query.include_issued === '1'
  })
  return ok(res, out)
}))

r.get('/orders/:id/complete-preview', requireAuth, requirePerm(P_RECEIPT), guard((req, res) => {
  const out = previewCompletion(getDb(), {
    orderId: Number(req.params.id),
    reportId: req.query.report_id ? Number(req.query.report_id) : null
  })
  return ok(res, out)
}))

r.post('/orders/:id/start', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = startOrder(getDb(), { orderId: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'START', module: 'manufacture', entity: 'production_orders', entityId: out.id })
  return ok(res, out)
}))

r.post('/orders/:id/complete', requireAuth, requirePerm(P_RECEIPT), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const out = completeOrder(db, {
    orderId: Number(req.params.id),
    reportId: b.report_id != null ? Number(b.report_id) : null,
    batchNo: b.batch_no || null,
    warehouseId: b.warehouse_id != null ? Number(b.warehouse_id) : null,
    actor: actorOf(req),
    remark: b.remark || null
  })
  audit(req, {
    action: 'COMPLETE_IN', module: 'manufacture', entity: 'production_orders', entityId: out.order.id,
    detail: { stock_in_qty: out.stock_in_qty, material_cost: out.material_cost, conversion_cost: out.conversion_cost }
  })
  return ok(res, out)
}))

r.get('/orders/:id', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const data = getProductionOrder(getDb(), Number(req.params.id))
  if (!data) return fail(res, '生产订单不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 领料单（MR）
// ===========================================================================

r.get('/issues', requireAuth, requirePerm(P_VIEW), wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  return paged(res, listIssues(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    issueType: req.query.issue_type || null,
    orderId: req.query.order_id ? Number(req.query.order_id) : null,
    keyword: req.query.keyword || null
  }))
}))

r.post('/issues', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const b = req.body || {}
  const out = createIssue(getDb(), {
    orderId: b.order_id != null ? Number(b.order_id) : null,
    warehouseId: b.warehouse_id != null ? Number(b.warehouse_id) : null,
    issueDate: b.issue_date || null,
    issueType: b.issue_type || 'by_bom',
    items: b.items || null,
    remark: b.remark || null,
    actor: actorOf(req)
  })
  audit(req, { action: 'CREATE', module: 'manufacture', entity: 'material_issues', entityId: out.id })
  return ok(res, out)
}))

r.post('/issues/:id/submit', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = transitionIssue(getDb(), { id: Number(req.params.id), action: 'submit', actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'SUBMIT', module: 'manufacture', entity: 'material_issues', entityId: out.id })
  return ok(res, out)
}))

r.post('/issues/:id/approve', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = transitionIssue(getDb(), { id: Number(req.params.id), action: 'approve', actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'APPROVE', module: 'manufacture', entity: 'material_issues', entityId: out.id })
  return ok(res, out)
}))

r.post('/issues/:id/issue', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = transitionIssue(getDb(), { id: Number(req.params.id), action: 'issue', actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, {
    action: 'ISSUE_OUT', module: 'manufacture', entity: 'material_issues', entityId: out.id,
    detail: { total_qty: out.total_qty, total_amount: out.total_amount }
  })
  return ok(res, out)
}))

r.post('/issues/:id/cancel', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = transitionIssue(getDb(), { id: Number(req.params.id), action: 'cancel', actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'CANCEL', module: 'manufacture', entity: 'material_issues', entityId: out.id })
  return ok(res, out)
}))

r.get('/issues/:id', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const data = getIssue(getDb(), Number(req.params.id))
  if (!data) return fail(res, '领料单不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 完工汇报
// ===========================================================================

r.get('/reports', requireAuth, requirePerm(P_VIEW), wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  return paged(res, listWorkReports(getDb(), {
    page, pageSize,
    orderId: req.query.order_id ? Number(req.query.order_id) : null,
    stockDone: req.query.stock_done != null ? Number(req.query.stock_done) : null,
    keyword: req.query.keyword || null
  }))
}))

r.post('/reports', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const b = req.body || {}
  const out = createWorkReport(getDb(), {
    orderId: b.order_id != null ? Number(b.order_id) : null,
    issueId: b.issue_id != null ? Number(b.issue_id) : null,
    reportDate: b.report_date || null,
    processName: b.process_name || null,
    goodQty: b.good_qty,
    defectQty: b.defect_qty,
    workHours: b.work_hours,
    laborRate: b.labor_rate,
    overheadCost: b.overhead_cost,
    batchNo: b.batch_no || '',
    remark: b.remark || null,
    actor: actorOf(req)
  })
  audit(req, {
    action: 'WORK_REPORT', module: 'manufacture', entity: 'work_reports', entityId: out.id,
    detail: { good_qty: out.good_qty, defect_qty: out.defect_qty, work_hours: out.work_hours }
  })
  return ok(res, out)
}))

r.put('/reports/:id', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = updateWorkReport(getDb(), { ...(req.body || {}), id: Number(req.params.id) })
  return ok(res, out)
}))

r.delete('/reports/:id', requireAuth, requirePerm(P_ISSUE), guard((req, res) => {
  const out = deleteWorkReport(getDb(), { id: Number(req.params.id) })
  return ok(res, out)
}))

r.get('/reports/:id', requireAuth, requirePerm(P_VIEW), guard((req, res) => {
  const data = getWorkReport(getDb(), Number(req.params.id))
  if (!data) return fail(res, '完工汇报不存在', 404)
  return ok(res, data)
}))

export default r
