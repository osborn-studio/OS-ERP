/**
 * ============================================================================
 * 文件标识：server/routes/costing.js ｜ 存货核算与成本路由（模块 09）
 * ============================================================================
 * 【职责】存货核算与成本路由（模块 09）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 存货核算与成本路由（模块 09）
//
// 挂载点：/api/costing
//
// 端点分工：
//   GET  /overview          —— 本期三层 + 待调整差异 + 成本自洽状态（一屏看懂）
//   GET  /layers            —— 三层成本明细（支持按仓库/SKU/批次下钻）
//   GET  /periods           —— 成本期间列表
//   POST /periods/close     —— **期末结转**（把本期锁定，禁止再补单）
//   GET  /variances         —— 暂估差异台账（来自采购结算）；?only=adjustable 只回「能回写到批次」的
//   GET  /adjustments       —— 成本调整单列表
//   GET  /adjustments/:id   —— 调整单详情（含行级前后单价与金额）
//   POST /adjustments       —— 从结算单开成本调整单（草稿）
//   POST /adjustments/:id/adjust  —— **确认调整**，唯一有后果的动作
//   POST /adjustments/:id/cancel  —— 取消草稿
//   GET  /audit             —— 成本自洽审计（流水累计 vs 结存金额）
//
// 路径顺序：静态段（/overview、/layers、/periods、/variances、/audit）必须注册在
// `/adjustments/:id` **之前**，否则会被当成 id 匹配走详情分支，报一个莫名其妙的 404。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  CostError, COST_METHODS,
  threeLayers, listPeriods, closePeriod, periodOf, periodRange,
  estimateVariances, createAdjustment, adjustCost, transitionAdjustment,
  getAdjustment, listAdjustments, ADJ_STATUS,
  auditCostIntegrity, recompute, costingOverview
} from '../lib/costing.js'

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
      if (e instanceof CostError) {
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
  '/meta',
  requireAuth,
  wrap((_req, res) =>
    ok(res, {
      results: Object.entries(ADJ_STATUS).map(([value, label]) => ({ value, label })),
      cost_methods: Object.entries(COST_METHODS).map(([value, label]) => ({ value, label })),
      adjust_types: [
        { value: 'estimate_variance', label: '暂估差异回写' },
        { value: 'manual', label: '手工成本调整' }
      ]
    })
  )
)

r.get(
  '/overview',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) => ok(res, costingOverview(getDb(), { period: req.query.period || null })))
)

// 三层成本明细。period 缺省取当前自然月。
r.get(
  '/layers',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) => {
    const db = getDb()
    const period = req.query.period || periodOf(new Date())
    const out = threeLayers(db, {
      period,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      skuId: req.query.sku_id ? Number(req.query.sku_id) : null,
      batchNo: req.query.batch_no || null,
      ownerOrgId: req.query.owner_org_id ? Number(req.query.owner_org_id) : null,
      currency: req.query.currency || null
    })
    return ok(res, { ...out, range: periodRange(period) })
  })
)

// 成本自洽审计：把流水累计与结存金额对一遍
r.get(
  '/audit',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) => {
    const db = getDb()
    const q = req.query
    if (q.warehouse_id && q.sku_id) {
      return ok(res, {
        single: recompute(db, {
          warehouseId: Number(q.warehouse_id),
          skuId: Number(q.sku_id),
          batchNo: q.batch_no || ''
        })
      })
    }
    return ok(res, auditCostIntegrity(db, { limit: Math.min(Number(req.query.limit) || 20, 200) }))
  })
)

// ===========================================================================
// 期间
// ===========================================================================

r.get(
  '/periods',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) =>
    ok(res, {
      list: listPeriods(getDb(), { limit: Math.min(Number(req.query.limit) || 36, 120) }),
      current: periodOf(new Date())
    })
  )
)

/**
 * 期末结转。**这是把本期锁死的动作** —— 结转之后不允许再往这个期间写流水
 * （闸门在 stock.js 的出入库入口）。reopen=true 才允许重结，且会先删掉该期快照。
 */
r.post(
  '/periods/close',
  requireAuth,
  requirePerm('cost.adjust'),
  guard((req, res) => {
    const db = getDb()
    const { period, reopen, remark } = req.body || {}
    const out = closePeriod(db, {
      period: period || periodOf(new Date()),
      reopen: !!reopen,
      remark: remark || null,
      actor: actorOf(req)
    })
    audit(req, {
      action: reopen ? 'COST_PERIOD_REOPEN' : 'COST_PERIOD_CLOSE',
      module: 'inventory', entity: 'cost_periods', entityId: out.period,
      detail: { lines: out.lines, closing_amount: out.layers.closing.amount, balanced: out.balanced }
    })
    return ok(res, out)
  })
)

// ===========================================================================
// 暂估差异与成本调整
// ===========================================================================

r.get(
  '/variances',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) =>
    ok(res, {
      list: estimateVariances(getDb(), {
        limit: Math.min(Number(req.query.limit) || 200, 500),
        status: req.query.status || null,
        // only=adjustable 只回「能回写到批次」的那些 —— 待办列表用这个，
        // 否则会把「还没开票」的发票口径差额也列成待办（那是做不掉的）
        onlyAdjustable: ['adjustable', '1', 'true'].includes(String(req.query.only || ''))
      })
    })
  )
)

r.get(
  '/adjustments',
  requireAuth,
  requirePerm('cost.view'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize } = pageParams(req)
    const out = listAdjustments(db, {
      page, pageSize,
      status: req.query.status || null,
      period: req.query.period || null,
      settleId: req.query.settle_id ? Number(req.query.settle_id) : null
    })
    return paged(res, out)
  })
)

// 从结算单开成本调整单（草稿）。默认本期；建单不改成本，提交才有后果。
r.post(
  '/adjustments',
  requireAuth,
  requirePerm('cost.adjust'),
  guard((req, res) => {
    const db = getDb()
    const { settle_id, adjust_date, remark } = req.body || {}
    const adj = createAdjustment(db, {
      settleId: Number(settle_id),
      adjustDate: adjust_date || null,
      remark: remark || null,
      actor: actorOf(req),
      source: 'api'
    })
    audit(req, {
      action: 'CREATE', module: 'inventory', entity: 'cost_adjustments', entityId: adj.id,
      detail: { settle_no: adj.settle_no, diff_amount: adj.diff_amount }
    })
    return ok(res, adj)
  })
)

r.get(
  '/adjustments/:id',
  requireAuth,
  requirePerm('cost.view'),
  guard((req, res) => {
    const data = getAdjustment(getDb(), Number(req.params.id))
    if (!data) return fail(res, '成本调整单不存在', 404)
    return ok(res, data)
  })
)

r.post(
  '/adjustments/:id/adjust',
  requireAuth,
  requirePerm('cost.adjust'),
  guard((req, res) => {
    const db = getDb()
    const out = adjustCost(db, {
      id: Number(req.params.id),
      actor: actorOf(req),
      remark: req.body?.remark || null,
      source: 'api'
    })
    audit(req, {
      action: 'COST_ADJUST', module: 'inventory', entity: 'cost_adjustments', entityId: out.id,
      detail: { adjusted_amount: out.adjusted_amount, sold_amount: out.sold_amount }
    })
    return ok(res, out)
  })
)

r.post(
  '/adjustments/:id/cancel',
  requireAuth,
  requirePerm('cost.adjust'),
  guard((req, res) => {
    const db = getDb()
    transitionAdjustment(db, {
      id: Number(req.params.id), action: 'cancel',
      actor: actorOf(req), remark: req.body?.remark || null, source: 'api'
    })
    audit(req, { action: 'CANCEL', module: 'inventory', entity: 'cost_adjustments', entityId: Number(req.params.id) })
    return ok(res, getAdjustment(db, Number(req.params.id)))
  })
)

export default r
