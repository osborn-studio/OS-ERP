/**
 * ============================================================================
 * 文件标识：server/routes/qc2.js ｜ 质量检验路由（模块 13）
 * ============================================================================
 * 【职责】质量检验路由（模块 13）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 质量检验路由（模块 13）
//
// 挂载点：/api/qc（独立前缀）
//
// 为什么独立成前缀而不并进 /api/purchase：质检的来源已经不止采购 ——
// 生产完工、在库复检都进来了。挂在一个叫 purchase 的前缀下，权限与路由都会越用越别扭。
//
// 端点分工（读「队列」、写「一张单」）：
//   GET  /meta                            —— 字典：来源 / 结论 / 处置方式 / 缺陷代码
//   GET  /overview                        —— 质量总览（待检、合格率、四路处置量）
//   GET  /audit                           —— 自洽审计（数字与结论一致 / 头行一致 / 库存后果齐备）
//   GET  /sample-plan                     —— 抽样方案试算（建单前给前端预览 n/Ac/Re）
//   GET  /pending                         —— 待检来源（采购到货 + 生产完工）
//   GET  /pending/detail                  —— 某来源的行级装填（query: source_type/source_id）
//   GET  /requests                        —— 报检单列表（分页）
//   POST /requests                        —— 建报检单（草稿）
//   GET  /requests/:id                    —— 报检单详情
//   POST /requests/:id/submit             —— 提交报检（同时生成一对一检验单草稿）
//   POST /requests/:id/close | /cancel    —— 归档 / 作废
//   GET  /inspections                     —— 检验单列表
//   GET  /inspections/:id                 —— 检验单详情（含行、处置单、留痕）
//   POST /inspections/:id/submit          —— **提交检验结论**（唯一有后果的检验动作）
//   POST /inspections/:id/close | /cancel —— 归档 / 作废
//   GET  /handlings                       —— 不良品处理单列表
//   POST /handlings                       —— 建处理单（草稿）
//   GET  /handlings/:id                   —— 处理单详情
//   POST /handlings/:id/confirm           —— **执行处理**（唯一产生库存后果的动作）
//   POST /handlings/:id/cancel            —— 取消处理
//
// 路径顺序：所有静态段（/meta、/overview、/audit、/sample-plan、/pending…）必须注册在
// `/:id` 之前，否则会被当成 id 匹配 —— 本项目踩过两次，这里一律先静态后动态。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser, attachOrgScope } from '../middleware/auth.js'
import { assertStockDocInScope, assertWarehouseInScope, warehouseInScope } from '../lib/stock.js'
import { audit } from '../middleware/audit.js'
import {
  QC2Error, SOURCE_LABEL, RESULT_LABEL, MODE_LABEL, DISPOSITION_LABEL, DEFECT_CODES,
  SAMPLE_TABLE, samplingPlan, pendingSources, sourceDetail,
  createRequest, submitRequest, getRequest, listRequests, transitionRequest,
  getInspection, listInspections, submitInspection, transitionInspection,
  createHandling, confirmHandling, cancelHandling, getHandling, listHandlings,
  qcOverview, auditQc
} from '../lib/qc2.js'

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
      if (e instanceof QC2Error) return bizFail(res, e)
      // 内核与库存引擎抛的错（DocFlowError / INSUFFICIENT_STOCK）也带 status + code，
      // 一并按业务错误返回 —— 否则用户看到的是 500「服务器错误」，
      // 而真实原因（库存不足 / 状态已变）本来是可以直接告诉他的。
      if (e && e.code && e.status) return bizFail(res, e)
      throw e
    }
  })
}
// ADR-0038 补充（AA4）：质检单据随仓库的组织范围；范围外与不存在同形 404（`DOC_NOT_FOUND`），先于任何状态推进。
const inScope = (table, req, id, notFound) => assertStockDocInScope(getDb(), table, Number(id), req.orgScope, { notFound })
const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))

const P_VIEW = 'quality.qc.view'
const P_REQUEST = 'quality.request.create'
const P_INSPECT = 'quality.inspect'
const P_HANDLE = 'quality.handle.approve'

// ===========================================================================
// 元数据 / 概览 / 审计
// ===========================================================================

r.get('/meta', requireAuth, wrap((_req, res) =>
  ok(res, {
    source_types: dict(SOURCE_LABEL),
    results: dict(RESULT_LABEL),
    handle_modes: dict(MODE_LABEL),
    dispositions: dict(DISPOSITION_LABEL),
    defect_codes: DEFECT_CODES,
    inspect_levels: [
      { value: 'normal', label: '正常检验' },
      { value: 'tightened', label: '加严检验' },
      { value: 'reduced', label: '放宽检验' }
    ],
    aql_default: 2.5,
    sample_table: SAMPLE_TABLE.filter((x) => Number.isFinite(x.max)).map((x) => ({
      max: x.max, code: x.code, n: x.n, ac: x.ac, re: x.re
    })),
    // 口径写在 meta 里，前端不用猜：这三条与后端校验完全对应
    rules: [
      { code: 'verdict_derived', text: '判定由数字推导：不良数 ≤ Ac 判合格，> Ac 判不合格，不允许手工选结论' },
      { code: 'closure', text: '抽样量 ≤ 报检数量，不良数 ≤ 抽样量；写库前强校验' },
      {
        code: 'consequence',
        text: '四种处置都会真的动库存：退货/报废直接出库；让步接收自动调拨入不合格品仓、返工自动调拨入待检品仓（出库与入库都真的发生），全部要留理由'
      }
    ]
  })
))

r.get('/overview', requireAuth, requirePerm(P_VIEW), wrap((_req, res) => ok(res, qcOverview(getDb()))))

r.get('/audit', requireAuth, requirePerm(P_VIEW), wrap((_req, res) => ok(res, auditQc(getDb()))))

r.get('/sample-plan', requireAuth, wrap((req, res) => {
  const qty = Number(req.query.qty || 0)
  const level = String(req.query.level || 'normal')
  ok(res, { qty, ...samplingPlan(qty, level) })
}))

// ===========================================================================
// 待检来源
// ===========================================================================

r.get('/pending', requireAuth, requirePerm(P_VIEW), attachOrgScope, wrap((req, res) => {
  const rows = pendingSources(getDb(), {
    sourceType: req.query.source_type || null,
    keyword: req.query.keyword || null,
    warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    limit: req.query.limit || 200,
    orgScope: req.orgScope
  })
  ok(res, { list: rows, total: rows.length })
}))

r.get('/pending/detail', requireAuth, requirePerm(P_VIEW), attachOrgScope, guard((req, res) => {
  const db = getDb()
  const data = sourceDetail(db, req.query.source_type, req.query.source_id ? Number(req.query.source_id) : null)
  if (!data || !warehouseInScope(db, data.warehouse_id, req.orgScope)) return fail(res, '来源单据不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 报检单（QCR）
// ===========================================================================

r.get('/requests', requireAuth, requirePerm(P_VIEW), attachOrgScope, wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = listRequests(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    sourceType: req.query.source_type || null,
    keyword: req.query.keyword || null,
    orgScope: req.orgScope
  })
  return paged(res, out)
}))

r.post('/requests', requireAuth, requirePerm(P_REQUEST), attachOrgScope, guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  // 报检的来源单据 / 指定仓必须在范围内（来源范围外 404 同形，显式仓越界 403）
  if (b.warehouse_id != null) assertWarehouseInScope(db, Number(b.warehouse_id), req.orgScope)
  if (b.source_id != null) {
    const sd = sourceDetail(db, b.source_type, Number(b.source_id))
    if (sd && !warehouseInScope(db, sd.warehouse_id, req.orgScope)) return fail(res, '来源单据不存在', 404)
  }
  const out = createRequest(db, {
    sourceType: b.source_type,
    sourceId: b.source_id != null ? Number(b.source_id) : null,
    requestDate: b.request_date || null,
    aql: b.aql != null ? Number(b.aql) : 2.5,
    level: b.level || 'normal',
    items: b.items || null,
    warehouseId: b.warehouse_id != null ? Number(b.warehouse_id) : null,
    remark: b.remark || null,
    actor: actorOf(req)
  })
  audit(req, { action: 'CREATE', module: 'quality', entity: 'qc_requests', entityId: out.id })
  return ok(res, out)
}))

r.post('/requests/:id/submit', requireAuth, requirePerm(P_REQUEST), attachOrgScope, guard((req, res) => {
  inScope('qc_requests', req, req.params.id, '报检单不存在')
  const out = submitRequest(getDb(), { id: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null })
  audit(req, { action: 'SUBMIT', module: 'quality', entity: 'qc_requests', entityId: out.request.id })
  return ok(res, out)
}))

r.post('/requests/:id/close', requireAuth, requirePerm(P_VIEW), attachOrgScope, guard((req, res) => {
  const db = getDb()
  inScope('qc_requests', req, req.params.id, '报检单不存在')
  transitionRequest(db, { id: Number(req.params.id), action: 'close', actor: actorOf(req), remark: req.body?.remark || null })
  return ok(res, getRequest(db, Number(req.params.id)))
}))

r.post('/requests/:id/cancel', requireAuth, requirePerm(P_REQUEST), attachOrgScope, guard((req, res) => {
  const db = getDb()
  inScope('qc_requests', req, req.params.id, '报检单不存在')
  transitionRequest(db, { id: Number(req.params.id), action: 'cancel', actor: actorOf(req), remark: req.body?.remark || null })
  return ok(res, getRequest(db, Number(req.params.id)))
}))

r.get('/requests/:id', requireAuth, requirePerm(P_VIEW), attachOrgScope, guard((req, res) => {
  inScope('qc_requests', req, req.params.id, '报检单不存在')
  const data = getRequest(getDb(), Number(req.params.id))
  if (!data) return fail(res, '报检单不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 检验单（QCI）
// ===========================================================================

r.get('/inspections', requireAuth, requirePerm(P_VIEW), attachOrgScope, wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = listInspections(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    result: req.query.result || null,
    keyword: req.query.keyword || null,
    orgScope: req.orgScope
  })
  return paged(res, out)
}))

r.post('/inspections/:id/submit', requireAuth, requirePerm(P_INSPECT), attachOrgScope, guard((req, res) => {
  const db = getDb()
  // 提交结论会改写 sku+批次级的 qc_status（跨仓可售结论）：检验单所在仓必须在范围内
  inScope('qc_inspections', req, req.params.id, '检验单不存在')
  const out = submitInspection(db, {
    id: Number(req.params.id),
    lines: req.body?.lines || null,
    actor: actorOf(req),
    remark: req.body?.remark || null
  })
  audit(req, {
    action: 'QC_INSPECT', module: 'quality', entity: 'qc_inspections', entityId: out.id,
    detail: { result: out.result, defect_qty: out.defect_qty, sample_qty: out.sample_qty }
  })
  return ok(res, out)
}))

r.post('/inspections/:id/close', requireAuth, requirePerm(P_INSPECT), attachOrgScope, guard((req, res) => {
  const db = getDb()
  inScope('qc_inspections', req, req.params.id, '检验单不存在')
  transitionInspection(db, { id: Number(req.params.id), action: 'close', actor: actorOf(req) })
  return ok(res, getInspection(db, Number(req.params.id)))
}))

r.post('/inspections/:id/cancel', requireAuth, requirePerm(P_INSPECT), attachOrgScope, guard((req, res) => {
  const db = getDb()
  inScope('qc_inspections', req, req.params.id, '检验单不存在')
  transitionInspection(db, { id: Number(req.params.id), action: 'cancel', actor: actorOf(req), remark: req.body?.remark || null })
  return ok(res, getInspection(db, Number(req.params.id)))
}))

r.get('/inspections/:id', requireAuth, requirePerm(P_VIEW), attachOrgScope, guard((req, res) => {
  const data = getInspection(getDb(), Number(req.params.id), req.orgScope)
  if (!data) return fail(res, '检验单不存在', 404)
  return ok(res, data)
}))

// ===========================================================================
// 不良品处理（DH）
// ===========================================================================

r.get('/handlings', requireAuth, requirePerm(P_VIEW), attachOrgScope, wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = listHandlings(getDb(), {
    page, pageSize,
    status: req.query.status || null,
    mode: req.query.mode || null,
    inspectionId: req.query.inspection_id ? Number(req.query.inspection_id) : null,
    keyword: req.query.keyword || null,
    orgScope: req.orgScope
  })
  return paged(res, out)
}))

r.post('/handlings', requireAuth, requirePerm(P_HANDLE), attachOrgScope, guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const out = createHandling(db, {
    inspectionId: b.inspection_id != null ? Number(b.inspection_id) : null,
    skuId: b.sku_id != null ? Number(b.sku_id) : null,
    batchNo: b.batch_no || '',
    qty: b.qty,
    mode: b.mode,
    reason: b.reason || null,
    defectCode: b.defect_code || null,
    remark: b.remark || null,
    actor: actorOf(req),
    orgScope: req.orgScope
  })
  audit(req, { action: 'CREATE', module: 'quality', entity: 'qc_defect_handlings', entityId: out.id })
  return ok(res, out)
}))

r.post('/handlings/:id/confirm', requireAuth, requirePerm(P_HANDLE), attachOrgScope, guard((req, res) => {
  const out = confirmHandling(getDb(), { id: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null, orgScope: req.orgScope })
  audit(req, {
    action: 'QC_HANDLE_CONFIRM', module: 'quality', entity: 'qc_defect_handlings', entityId: out.id,
    detail: { mode: out.mode, qty: out.qty, out_doc_no: out.out_doc_no }
  })
  return ok(res, out)
}))

r.post('/handlings/:id/cancel', requireAuth, requirePerm(P_HANDLE), attachOrgScope, guard((req, res) => {
  const out = cancelHandling(getDb(), { id: Number(req.params.id), reason: req.body?.reason || null, actor: actorOf(req), orgScope: req.orgScope })
  return ok(res, out)
}))

r.get('/handlings/:id', requireAuth, requirePerm(P_VIEW), attachOrgScope, guard((req, res) => {
  const data = getHandling(getDb(), Number(req.params.id), req.orgScope)
  if (!data) return fail(res, '不良品处理单不存在', 404)
  return ok(res, data)
}))

export default r
