/**
 * ============================================================================
 * 文件标识：server/routes/quote.js ｜ 销售报价单路由（模块 08A）
 * ============================================================================
 * 【职责】销售报价单路由（模块 08A）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售报价单路由（模块 08A）
//
// 挂载点：/api/sales（与销售订单同源前缀，报价属于销售域）
//
// 端点分工：
//   GET  /quotes/meta       —— 状态、客户类型、审批阈值等字典
//   GET  /quotes/overview   —— 报价概览（待审批 / 即将到期 / 已转单金额）
//   POST /quotes/price      —— **取价试算**（不落库，新增报价前先看价）
//   GET  /quotes            —— 列表（状态 / 客户 / 关键字 / 仅看有效）
//   GET  /quotes/:id        —— 详情（含行级「价从哪来」）
//   POST /quotes            —— 新建报价（草稿）
//   POST /quotes/:id/action —— 提交 / 审批 / 驳回 / 再提交 / 取消
//   POST /quotes/:id/convert—— **转单**（唯一有后果的动作：生成销售订单或订货单）
//   POST /quotes/:id/copy   —— 复制改版（version +1）
//   POST /quotes/expire     —— 批量将过期报价置为「已过期」（系统动作）
//
// 路径顺序：/quotes/meta、/quotes/overview、/quotes/price、/quotes/expire
// 必须注册在 /quotes/:id 之前，否则会被当成 id 匹配走详情分支。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  QuoteError, QUOTE_STATUS, CUSTOMER_TYPE,
  priceQuote, createQuote, getQuote, listQuotes,
  transitionQuote, expireQuotes, convertQuote, copyQuote, quoteOverview
} from '../lib/quote.js'

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
      if (e instanceof QuoteError) {
        return bizFail(res, e)
      }
      throw e
    }
  })
}

const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))

r.get(
  '/quotes/meta',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const ov = quoteOverview(db)
    ok(res, {
      statuses: dict(QUOTE_STATUS),
      customer_types: dict(CUSTOMER_TYPE),
      channels: [
        { value: 'dealer', label: '经销商分销' },
        { value: 'store', label: '门店零售' },
        { value: 'online', label: '自营商城' },
        { value: 'platform', label: '平台电商' },
        { value: 'live', label: '直播电商' }
      ],
      convert_targets: [
        { value: 'SO', label: '销售订单' },
        { value: 'OC', label: '订货单（仅订货客户）' }
      ],
      approval_amount_threshold: ov.approval_amount_threshold,
      valid_days_default: ov.valid_days_default
    })
  })
)

r.get(
  '/quotes/overview',
  requireAuth,
  requirePerm('sales.quote.view'),
  wrap((_req, res) => ok(res, quoteOverview(getDb())))
)

// 取价试算：不落库，可反复调用（界面「新增报价」先看价再保存）
r.post(
  '/quotes/price',
  requireAuth,
  requirePerm('sales.quote.view'),
  guard((req, res) => {
    const b = req.body || {}
    return ok(
      res,
      priceQuote(getDb(), {
        items: b.items || [],
        customerType: b.customer_type || 'dealer',
        dealerId: b.dealer_id || null,
        customerId: b.customer_id || null,
        storeId: b.store_id || null,
        channel: b.channel || null,
        warehouseId: b.warehouse_id || null,
        freight: Number(b.freight || 0),
        taxRate: Number(b.tax_rate || 0)
      })
    )
  })
)

r.get(
  '/quotes',
  requireAuth,
  requirePerm('sales.quote.view'),
  wrap((req, res) => {
    const { page, pageSize } = pageParams(req)
    const out = listQuotes(getDb(), {
      status: req.query.status || null,
      customerType: req.query.customer_type || null,
      dealerId: req.query.dealer_id ? Number(req.query.dealer_id) : null,
      customerId: req.query.customer_id ? Number(req.query.customer_id) : null,
      keyword: req.query.keyword || null,
      validOnly: String(req.query.valid_only || '') === '1',
      page,
      pageSize
    })
    return ok(res, out)
  })
)

r.get(
  '/quotes/:id',
  requireAuth,
  requirePerm('sales.quote.view'),
  wrap((req, res) => {
    const q = getQuote(getDb(), Number(req.params.id))
    if (!q) return fail(res, '报价单不存在', 404)
    return ok(res, q)
  })
)

r.post(
  '/quotes',
  requireAuth,
  requirePerm('sales.quote.edit'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const q = createQuote(db, {
      customerType: b.customer_type || 'dealer',
      dealerId: b.dealer_id || null,
      customerId: b.customer_id || null,
      storeId: b.store_id || null,
      channel: b.channel || null,
      warehouseId: b.warehouse_id || null,
      currency: b.currency || 'CNY',
      quoteDate: b.quote_date || null,
      validFrom: b.valid_from || null,
      validTo: b.valid_to || null,
      validDays: b.valid_days || null,
      items: b.items || [],
      freight: Number(b.freight || 0),
      taxRate: Number(b.tax_rate || 0),
      remark: b.remark || null,
      sourceQuoteId: b.source_quote_id || null,
      actor: actorOf(req)
    })
    audit(req, { action: 'CREATE', module: 'sales', entity: 'sales_quotes', entityId: q.id, detail: q.doc_no })
    return ok(res, q)
  })
)

const ACTION_PERM = {
  submit: 'sales.quote.edit',
  resubmit: 'sales.quote.edit',
  cancel: 'sales.quote.edit',
  approve: 'sales.quote.approve',
  reject: 'sales.quote.approve'
}

r.post(
  '/quotes/:id/action',
  requireAuth,
  guard((req, res, next) => {
    const action = String(req.body?.action || '')
    const perm = ACTION_PERM[action]
    if (!perm) return fail(res, `不支持的动作：${action}`, 400)
    return requirePerm(perm)(req, res, () => {
      try {
        const out = transitionQuote(getDb(), {
          id: Number(req.params.id),
          action,
          actor: actorOf(req),
          remark: req.body?.remark || null
        })
        audit(req, { action: action.toUpperCase(), module: 'sales', entity: 'sales_quotes', entityId: out.quote.id, detail: req.body?.remark || null })
        return ok(res, out.quote)
      } catch (e) {
        if (e instanceof QuoteError) return bizFail(res, e)
        throw e
      }
    })
  })
)

// 转单：唯一有后果的动作。超信默认拦住，带 force + reason 才是特批放行
r.post(
  '/quotes/:id/convert',
  requireAuth,
  requirePerm('sales.quote.convert'),
  guard((req, res) => {
    const db = getDb()
    const out = convertQuote(db, {
      id: Number(req.params.id),
      target: req.body?.target || 'SO',
      actor: actorOf(req),
      force: !!req.body?.force,
      reason: req.body?.reason || null,
      orderDate: req.body?.order_date || null,
      remark: req.body?.remark || null
    })
    audit(req, {
      action: 'CONVERT', module: 'sales', entity: 'sales_quotes', entityId: out.quote.id,
      detail: `${out.converted_type || ''} ${out.order?.doc_no || ''}${out.credit?.result === 'force' ? '（超信特批）' : ''}`
    })
    return ok(res, out, { reused: out.reused })
  })
)

r.post(
  '/quotes/:id/copy',
  requireAuth,
  requirePerm('sales.quote.edit'),
  guard((req, res) => {
    const q = copyQuote(getDb(), {
      id: Number(req.params.id),
      actor: actorOf(req),
      validDays: req.body?.valid_days || null,
      remark: req.body?.remark || null
    })
    return ok(res, q)
  })
)

// 批量过期：系统动作（定时任务/界面按钮都能调），不是单据状态机里的按钮
r.post(
  '/quotes/expire',
  requireAuth,
  requirePerm('sales.quote.edit'),
  guard((req, res) => {
    const out = expireQuotes(getDb(), { at: req.body?.at || null, actor: actorOf(req) })
    return ok(res, out)
  })
)

export default r
