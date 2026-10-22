/**
 * ============================================================================
 * 文件标识：server/routes/dms.js ｜ 渠道管理（DMS · 批次 G）：协议价档案 + 返利计提 / 试算 / 核销
 * ============================================================================
 * 【职责】渠道管理（DMS · 批次 G）：协议价档案 + 返利计提 / 试算 / 核销
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 渠道管理（DMS · 批次 G）：协议价档案 + 返利计提 / 试算 / 核销
//
// 独立成文件而不是塞进 `routes/dealers.js`：经销商档案是**主数据**，
// 协议价与返利是**政策与结算** —— 两者的授权粒度不同（前者看档案、后者看财务），
// 混在一起会让"能改客户电话的人"顺手能核销返利。
//
// 本文件只做三件事：**取参数、调 lib、翻译错误**。所有判据在
// `lib/agreement.js`（协议价命中与裁决）与 `lib/rebate.js`（返利计算与核销）。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { requireAuth, requireRole, requireInternal } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { resolvePrice, explainPrice } from '../lib/pricing.js'
import * as A from '../lib/agreement.js'
import * as R from '../lib/rebate.js'

const r = Router()
r.use(requireAuth, requireInternal('总部渠道协议与返利；经销商请使用订货中心'))
// 改价与核销都是"动钱"的动作：只给销售 / 财务 / 管理员。
// 查看放开到全部后台角色（渠道价与返利是销售看板的常规信息）。
const W = ['sales', 'finance', 'admin']

/** 业务错误 → 响应：与商城/促销/门店共用同一份翻译（`lib/http.js` 的 `failFromError`） */
function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
  })
}

const POLICY_TYPES = Object.keys(R.POLICY_TYPE_LABEL)

const actorOf = (req) => ({
  id: req.user?.uid ?? null,
  name: req.user?.name || req.user?.username || null,
  source: 'web'
})

// ===========================================================================
// 一、字典
// ===========================================================================

r.get('/meta', requireAuth, guard((_req, res) => ok(res, {
  ...A.meta(),
  policy_types: Object.entries(R.POLICY_TYPE_LABEL).map(([value, label]) => ({ value, label })),
  rebate_statuses: Object.entries(R.REBATE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
  settlement_statuses: Object.entries(R.SETTLEMENT_STATUS_LABEL).map(([value, label]) => ({ value, label })),
  policy_type_hints: {
    tiered: '按净销售 / 毛销售 / 回款额落在哪个阶梯区间取费率',
    fixed_per_unit: '按进货件数 × 每件定额',
    growth: '与上一期销售额对比，只对**增量**部分计返',
    payback: '回款率达到门槛后，对计返基数计返',
    category: '只对指定品类的销售额计返',
    seasonal: '档期任务达标后，对计返基数计返'
  }
})))

// ===========================================================================
// 二、协议价档案
// ===========================================================================

r.get('/agreements', requireAuth, guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = A.listAgreements(getDb(), {
    dealerId: req.query.dealer_id ? Number(req.query.dealer_id) : null,
    status: req.query.status || null,
    keyword: req.query.keyword || null,
    page, pageSize
  })
  return paged(res, { rows: out.list, total: out.total, page: out.page, pageSize: out.pageSize })
}))

/**
 * **协议价接入取价链的证据接口**。
 *
 * 存在的理由：验收侧要能回答"协议价到底有没有覆盖默认取价"。
 * 直接调 `resolvePrice`（**与销售开单同一条路径**）并返回 `rule` + `trace`，
 * 界面与测试都用它 —— 不做第二套"预览取价"，否则预览说命中、开单又不命中。
 *
 * ⚠️ **注册顺序是功能的一部分**：Express 按注册先后匹配，字面段 `explain` 必须排在
 * `/agreements/:id` **之前** —— 排在后面时 `explain` 会被当成 `id` 吃掉
 * （`Number('explain')` → NaN → 查不到 → 404「协议不存在」），
 * 而这个接口从写下那天起就一直 404。**字面段路由一律先于同前缀的参数路由注册。**
 */
r.get('/agreements/explain', requireAuth, guard((req, res) => {
  const db = getDb()
  const skuId = Number(req.query.sku_id)
  if (!skuId) return fail(res, '请指定 sku_id', 400)
  const q = {
    skuId,
    dealerId: req.query.dealer_id ? Number(req.query.dealer_id) : null,
    dealerLevel: req.query.dealer_level || null,
    channel: req.query.channel || null,
    storeType: req.query.store_type || null,
    region: req.query.region || null,
    qty: Number(req.query.qty || 1)
  }
  const out = explainPrice(db, q)
  // 同一条链上"不带经销商的价"作为对照：能直接看出协议价把它压下去了多少
  const base = req.query.dealer_id ? resolvePrice(db, { ...q, dealerId: null }) : null
  return ok(res, {
    ...out,
    rule: out.rule,
    base_without_agreement: base ? { price: base.price, source: base.source } : null,
    saved: base ? Number((base.price - out.price).toFixed(4)) : 0
  })
}))

r.get('/agreements/:id', requireAuth, guard((req, res) => {
  const row = A.getAgreement(getDb(), Number(req.params.id))
  if (!row) return fail(res, '协议不存在', 404)
  return ok(res, row)
}))

r.post('/agreements', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.createAgreement(getDb(), req.body || {}, actorOf(req))
  audit(req, { action: 'CREATE', module: 'dms', entity: 'price_agreements', entityId: out.id, detail: out.code })
  return ok(res, out)
}))

r.put('/agreements/:id', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.updateAgreement(getDb(), Number(req.params.id), req.body || {}, actorOf(req))
  audit(req, { action: 'UPDATE', module: 'dms', entity: 'price_agreements', entityId: out.id, detail: out.code })
  return ok(res, out)
}))

r.post('/agreements/:id/status', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.setAgreementStatus(getDb(), Number(req.params.id), String(req.body?.status || ''), actorOf(req))
  audit(req, { action: 'STATUS', module: 'dms', entity: 'price_agreements', entityId: out.id, detail: `${out.code} → ${out.status}` })
  return ok(res, out)
}))

// ===========================================================================
// 三、返利
// ===========================================================================

r.get('/policies', requireAuth, guard((req, res) => {
  const db = getDb()
  const { page, pageSize, offset } = pageParams(req)
  const conds = []
  const params = []
  if (req.query.type) { conds.push('type = ?'); params.push(req.query.type) }
  if (req.query.status) { conds.push('status = ?'); params.push(req.query.status) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM rebate_policies ${where}`).get(...params).c
  const rows = db
    .prepare(`SELECT * FROM rebate_policies ${where} ORDER BY priority, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
  return paged(res, {
    rows: rows.map((p) => ({ ...p, type_label: R.POLICY_TYPE_LABEL[p.type] || p.type })),
    total, page, pageSize
  })
}))

r.post('/policies', requireAuth, requireRole(...W), guard((req, res) => {
  const db = getDb()
  const {
    code, name, type = 'tiered', dealer_level = 'all', channel_type = 'all', period,
    basis = 'net', rules, rebate_cap = 0, priority = 100, status = 'active', remark
  } = req.body || {}
  const pCode = String(code || '').trim()
  if (!pCode || !name) return fail(res, '政策编码与名称必填', 400)
  if (!POLICY_TYPES.includes(type)) return fail(res, `政策类型无效：${type}`, 400)
  if (db.prepare('SELECT id FROM rebate_policies WHERE code=?').get(pCode)) {
    return fail(res, '政策编码已存在', 409, 409)
  }
  const info = db
    .prepare(
      `INSERT INTO rebate_policies (code,name,type,dealer_level,channel_type,period,basis,rules,rebate_cap,priority,status,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(pCode, name, type, dealer_level, channel_type, period || null, basis,
      typeof rules === 'string' ? rules : JSON.stringify(rules || {}),
      Number(rebate_cap || 0), Number(priority || 100), status, remark || null)
  audit(req, { action: 'CREATE', module: 'dms', entity: 'rebate_policies', entityId: Number(info.lastInsertRowid), detail: pCode })
  return ok(res, db.prepare('SELECT * FROM rebate_policies WHERE id=?').get(Number(info.lastInsertRowid)))
}))

r.get('/rebates', requireAuth, guard((req, res) => {
  const db = getDb()
  const { page, pageSize, offset } = pageParams(req)
  const conds = []
  const params = []
  for (const [k, col] of [['dealer_id', 'rb.dealer_id'], ['period', 'rb.period'], ['status', 'rb.status']]) {
    if (req.query[k] !== undefined && req.query[k] !== '') { conds.push(`${col} = ?`); params.push(k === 'period' || k === 'status' ? req.query[k] : Number(req.query[k])) }
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const FROM = 'dealer_rebates rb JOIN dealers d ON d.id=rb.dealer_id'
  const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
  const rows = db
    .prepare(`SELECT rb.*, d.name AS dealer_name, d.code AS dealer_code, d.level
                FROM ${FROM} ${where} ORDER BY rb.period DESC, rb.rebate_amount DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
  const sum = db.prepare(`SELECT COALESCE(SUM(rb.rebate_amount),0) amount FROM ${FROM} ${where}`).get(...params)
  return paged(res, {
    rows: rows.map((x) => ({ ...x, status_label: R.REBATE_STATUS_LABEL[x.status] || x.status })),
    total, page, pageSize, summary: sum
  })
}))

/** 试算（纯读）：这一期该返多少、为什么 */
r.post('/rebates/plan', requireAuth, guard((req, res) => {
  const { dealer_id: dealerId, period, policy_id: policyId } = req.body || {}
  if (!dealerId || !period) return fail(res, '请指定 dealer_id 与 period', 400)
  const out = R.planRebate(getDb(), { dealerId: Number(dealerId), period, policyId: policyId ? Number(policyId) : null })
  return ok(res, out)
}))

/** 计提：把试算落成待核算记录（幂等；已确认/已核销的一律不覆盖） */
r.post('/rebates/accrue', requireAuth, requireRole(...W), guard((req, res) => {
  const { dealer_id: dealerId, period, policy_id: policyId } = req.body || {}
  if (!dealerId || !period) return fail(res, '请指定 dealer_id 与 period', 400)
  const out = R.accrueRebates(getDb(), {
    dealerId: Number(dealerId), period,
    policyId: policyId ? Number(policyId) : null,
    actor: actorOf(req)
  })
  audit(req, {
    action: 'ACCRUE', module: 'dms', entity: 'dealer_rebates', entityId: Number(dealerId),
    detail: `${period} 新建 ${out.created} / 更新 ${out.updated}`
  })
  return ok(res, out)
}))

r.post('/rebates/:id/confirm', requireAuth, requireRole(...W), guard((req, res) => {
  const out = R.confirmRebate(getDb(), {
    id: Number(req.params.id), actor: actorOf(req), remark: req.body?.remark || null
  })
  audit(req, { action: 'CONFIRM', module: 'dms', entity: 'dealer_rebates', entityId: out.id })
  return ok(res, out)
}))

/** 核销：把某期已确认的返利汇成一张核销单并**冲减应收** */
r.post('/rebates/settle', requireAuth, requireRole(...W), guard((req, res) => {
  const { dealer_id: dealerId, period, idempotency_key: idem, remark } = req.body || {}
  if (!dealerId || !period) return fail(res, '请指定 dealer_id 与 period', 400)
  const out = R.settleRebates(getDb(), {
    dealerId: Number(dealerId), period,
    idempotencyKey: idem || null, remark: remark || null, actor: actorOf(req)
  })
  audit(req, {
    action: 'SETTLE', module: 'dms', entity: 'rebate_settlements', entityId: out.id,
    detail: `${out.doc_no} 核销 ${out.total_amount} / 冲应收 ${out.ar_offset_amount}`
  })
  return ok(res, out)
}))

r.get('/settlements', requireAuth, guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = R.listSettlements(getDb(), {
    dealerId: req.query.dealer_id ? Number(req.query.dealer_id) : null,
    period: req.query.period || null,
    status: req.query.status || null,
    page, pageSize
  })
  return paged(res, { rows: out.list, total: out.total, page: out.page, pageSize: out.pageSize })
}))

r.get('/settlements/:id', requireAuth, guard((req, res) => {
  const row = R.getSettlement(getDb(), Number(req.params.id))
  if (!row) return fail(res, '核销单不存在', 404)
  return ok(res, row)
}))

/** 返利域自证（不变量）—— 供界面巡检与 `verify-seed` 使用 */
r.get('/rebate-audit', requireAuth, guard((_req, res) => ok(res, R.auditRebate(getDb()))))

export default r
