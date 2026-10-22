/**
 * ============================================================================
 * 文件标识：server/routes/qc.js ｜ 采购质检路由（模块 07 · 到货单与质检单拆分）
 * ============================================================================
 * 【职责】采购质检路由（模块 07 · 到货单与质检单拆分）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 采购质检路由（模块 07 · 到货单与质检单拆分）
//
// 挂载点：/api/purchase（与 purchase.js / purchase-chain.js 共用前缀，各自管自己的路径）
//
// 端点分工：
//   GET  /inspections/pending        —— 待质检的到货单（质检岗的工作台入口）
//   GET  /inspections/receipt/:id    —— 装填：到货单 + 行 + 已有草稿（前端一屏填完）
//   POST /inspections                —— 从到货单开质检单（默认全部合格）
//   POST /inspections/:id/submit     —— **提交质检结论**，这是唯一有后果的动作
//   POST /inspections/:id/close      —— 归档
//   POST /inspections/:id/cancel     —— 作废（作废后可重开，见 createInspection）
//
// 路径顺序有讲究：`/inspections/pending` 等静态段必须注册在 `/inspections/:id` **之前**，
// 否则 `pending` 会被当成 id 匹配走详情分支，报一个莫名其妙的 404。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  QCError, RESULT_LABEL,
  createInspection, getInspection, listInspections, submitInspection, transitionInspection,
  pendingReceipts, getReceiptForInspect, inspectionOverview
} from '../lib/qc.js'

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
      if (e instanceof QCError) {
        return bizFail(res, e)
      }
      throw e
    }
  })
}

// ===========================================================================
// 元数据与概览
// ===========================================================================

r.get(
  '/inspections/meta',
  requireAuth,
  wrap((_req, res) =>
    ok(res, {
      results: Object.entries(RESULT_LABEL).map(([value, label]) => ({ value, label })),
      defect_codes: [
        { value: 'appearance', label: '外观不良' },
        { value: 'spec', label: '规格不符' },
        { value: 'packaging', label: '包装破损' },
        { value: 'expiry', label: '效期不足' },
        { value: 'batch', label: '批次错误' },
        { value: 'quality', label: '性能不达标' },
        { value: 'other', label: '其它' }
      ]
    })
  )
)

r.get(
  '/inspections/overview',
  requireAuth,
  requirePerm('quality.inspect.view'),
  wrap((_req, res) => ok(res, inspectionOverview(getDb())))
)

// 待质检的到货单：质检岗的入口。放在 :id 之前，否则 'pending' 会被当成 id。
r.get(
  '/inspections/pending',
  requireAuth,
  requirePerm('quality.inspect.view'),
  wrap((req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
    return ok(res, { list: pendingReceipts(getDb(), { limit }) })
  })
)

// 装填：到货单事实 + 已有草稿。前端据此一屏填完，不用先建后改。
r.get(
  '/inspections/receipt/:receiptId',
  requireAuth,
  requirePerm('quality.inspect.view'),
  guard((req, res) => {
    const data = getReceiptForInspect(getDb(), Number(req.params.receiptId))
    if (!data) return fail(res, '到货单不存在', 404)
    return ok(res, data)
  })
)

// ===========================================================================
// 质检单
// ===========================================================================

r.get(
  '/inspections',
  requireAuth,
  requirePerm('quality.inspect.view'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize } = pageParams(req)
    const out = listInspections(db, {
      page, pageSize,
      status: req.query.status || null,
      result: req.query.result || null,
      supplierId: req.query.supplier_id ? Number(req.query.supplier_id) : null,
      receiptId: req.query.receipt_id ? Number(req.query.receipt_id) : null
    })
    return paged(res, out)
  })
)

r.post(
  '/inspections',
  requireAuth,
  requirePerm('quality.inspect.edit'),
  guard((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { receipt_id, inspect_date, items, remark } = req.body || {}
    // createInspection 返回的是**整张质检单**（含明细与流转留痕），不是 id。
    // 这里曾经写成 `const id = createInspection(...)` 再 `getInspection(db, id)`，
    // 结果 better-sqlite3 收到一个对象、按命名参数处理，撞上匿名 `?` 抛
    // RangeError: Too few parameter values were provided —— 一个与真实原因毫无关系的报错。
    const ins = createInspection(db, {
      receiptId: Number(receipt_id),
      inspectDate: inspect_date || null,
      items: items || null,
      remark: remark || null,
      actor: actorOf(req),
      source: 'api'
    })
    audit(req, { action: 'CREATE', module: 'purchase', entity: 'purchase_inspections', entityId: ins.id })
    return ok(res, ins)
  })
)

r.get(
  '/inspections/:id',
  requireAuth,
  requirePerm('quality.inspect.view'),
  guard((req, res) => {
    const data = getInspection(getDb(), Number(req.params.id))
    if (!data) return fail(res, '质检单不存在', 404)
    return ok(res, data)
  })
)

// 提交质检结论：判退部分会自动生成采购退货单并出库
r.post(
  '/inspections/:id/submit',
  requireAuth,
  requirePerm('quality.inspect'),
  guard((req, res) => {
    const db = getDb()
    const { lines, remark } = req.body || {}
    const out = submitInspection(db, {
      id: Number(req.params.id), lines: lines || null,
      actor: actorOf(req), remark: remark || null, source: 'api'
    })
    audit(req, {
      action: 'QC_SUBMIT', module: 'purchase', entity: 'purchase_inspections', entityId: out.id,
      detail: { result: out.result, rejected_qty: out.rejected_qty, return_no: out.return_no }
    })
    return ok(res, out)
  })
)

r.post(
  '/inspections/:id/close',
  requireAuth,
  requirePerm('quality.inspect'),
  guard((req, res) => {
    const db = getDb()
    transitionInspection(db, {
      id: Number(req.params.id), action: 'close', actor: actorOf(req), source: 'api'
    })
    audit(req, { action: 'CLOSE', module: 'purchase', entity: 'purchase_inspections', entityId: Number(req.params.id) })
    return ok(res, getInspection(db, Number(req.params.id)))
  })
)

r.post(
  '/inspections/:id/cancel',
  requireAuth,
  requirePerm('quality.inspect'),
  guard((req, res) => {
    const db = getDb()
    transitionInspection(db, {
      id: Number(req.params.id), action: 'cancel',
      actor: actorOf(req), remark: req.body?.remark || null, source: 'api'
    })
    audit(req, { action: 'CANCEL', module: 'purchase', entity: 'purchase_inspections', entityId: Number(req.params.id) })
    return ok(res, getInspection(db, Number(req.params.id)))
  })
)

export default r
