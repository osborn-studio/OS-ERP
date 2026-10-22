/**
 * ============================================================================
 * 文件标识：server/routes/promo.js ｜ 营销路由（模块 18：促销与会员）
 * ============================================================================
 * 【职责】营销路由（模块 18：促销与会员）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 营销路由（模块 18：促销与会员）
//
// 挂载点：/api/promo
//
// 为什么独立前缀而不并进 /api/mall：/api/mall 是**面向 C 端顾客**的免登录通道
// （手机号即身份）；而活动配置、发券、调积分是**面向内部员工**的、要按权限管控。
// 两类调用者、两种信任级别塞进一个前缀，权限就没法按路由粒度收口。
// C 端要用的那几个端点单独放在本文件的 `/shop/*` 分组里，一眼能看出它们的信任级别不同。
//
// 端点分工：
//   GET  /meta                        —— 字典：促销类型 / 分配方式 / 作用目标 / 券类型 / 券状态
//   GET  /overview                    —— 营销总览（活动 / 促销 / 券 / 会员 / 积分储值余额）
//   GET  /audit                       —— 自洽审计（账户余额=流水合计、券状态、用量登记）
//   GET  /levels                      —— 会员等级与权益
//   PUT  /levels/:code                —— 编辑等级权益（折扣率 / 积分倍率 / 抵扣上限）
//   GET  /campaigns                   —— 活动列表
//   POST /campaigns                   —— 新建活动
//   POST /campaigns/:id/status        —— 启停活动
//   GET  /promotions                  —— 促销列表（分页 / 关键字 / 状态）
//   POST /promotions                  —— 新建促销（含优惠方式与规则）
//   POST /promotions/validate         —— **只校验不落库**（建单前的预检）
//   GET  /promotions/:id              —— 促销详情（含方式、三组规则、使用汇总）
//   PUT  /promotions/:id              —— 编辑促销（未传的字段保留原值）
//   POST /promotions/:id/status       —— 启停促销
//   DELETE /promotions/:id            —— 删除促销（有使用记录 / 被券引用则拒绝）
//   POST /targets/preview             —— 目标规则试算（给一份购物车看能命中哪些行）
//   POST /quote                       —— **试算**：给一份购物车返回命中链与逐行分摊（纯读）
//   POST /explain                     —— 试算并生成人类可读的解释链
//   POST /settle                      —— 落单：写优惠留痕 + 登记使用 + 核销券 + 送积分
//   POST /unsettle                    —— 撤单：成对回退上面四件事
//   GET  /coupons                     —— 券模板列表
//   POST /coupons                     —— 新建券模板
//   GET  /coupons/:id                 —— 券模板详情
//   PUT  /coupons/:id                 —— 编辑券模板
//   POST /coupons/:id/status          —— 启停券模板
//   POST /coupons/:id/issue           —— 批量发券（给某个客户发 N 张）
//   POST /coupons/expire              —— 把已到期券批量落库为 expired
//   GET  /coupon-instances            —— 券实例列表（可按客户 / 模板 / 状态筛）
//   POST /coupon-instances/:id/void   —— 作废一张券
//   GET  /members                     —— 会员列表（按积分 / 等级 / 关键字）
//   GET  /members/:customerId         —— 会员详情（账户 + 券统计 + 最近流水）
//   GET  /members/:customerId/ledger  —— 积分 / 储值流水（query: kind=points|balance）
//   POST /members/:customerId/points  —— **手工调整积分**（必须填理由）
//   POST /members/:customerId/balance —— 储值充值 / 调整（必须填理由）
//   POST /members/:customerId/level   —— **人工指定等级**（必须填理由）
//   POST /members/:customerId/sync    —— 按规则重判等级
//   POST /members/:customerId/coupons —— 给该客户发券（券模板 id 或券码）
//   --- C 端（免登录，手机号即身份）---
//   GET  /shop/member                 —— 会员中心（等级 / 积分 / 储值 / 券包）
//   GET  /shop/promotions             —— 当前可参与的活动墙
//   POST /shop/quote                  —— 下单前试算
//   POST /shop/claim                  —— 领券
//
// 路径顺序：**所有静态段必须注册在 `/:id` 之前**（/promotions/validate 会被
// /promotions/:id 吃掉）。本项目已在别的模块踩过两次，这里一律先静态后动态。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import * as P from '../lib/promotion.js'
import * as M from '../lib/member.js'
import * as C from '../lib/coupon.js'
import * as K from '../lib/checkout.js'
// C 端会话**只有一份实现**（`middleware/mall-session.js`）——
// `routes/mall.js` 也用它，两边不各维护一套身份口径
import { requireMall, mallCustomer } from '../middleware/mall-session.js'

const r = Router()

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u?.uid || u?.id || null, name: u?.name || u?.username || null }
}

/**
 * 统一错误出口：把各 lib 抛出的业务错误（带 `code` + `status`）翻译成响应。
 * 不这么做的后果是用户看到 500「服务器错误」，而真实原因（券已用过 / 积分不足 /
 * 折扣率超范围）本来是可以直接告诉他的。
 */
function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      // `PromotionError` 用的是 `http` 字段放状态码，先归一成 `status` 再走统一翻译
      if (e instanceof P.PromotionError && e.status == null) e.status = e.http || 400
      if (failFromError(res, e)) return undefined
      throw e
    }
  })
}

const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))
const num = (v) => (v == null || v === '' ? null : Number(v))

/**
 * 分页出参：各 List 函数返回的是 `{list,total,page,pageSize}`，
 * 而 `paged()` 取的是 `rows` —— 名字对不上时它会静默发出 `list: undefined`，
 * 前端拿到空列表却不报错。统一在这里换名，不指望每个调用点都记得。
 */
const pagedList = (res, out, extra = {}) =>
  paged(res, { rows: out.list, total: out.total, page: out.page, pageSize: out.pageSize, ...extra })

const P_PROMO_VIEW = 'mall.promotion.view'
const P_PROMO_EDIT = 'mall.promotion.edit'
const P_PROMO_PUBLISH = 'mall.promotion.publish'
const P_COUPON_VIEW = 'mall.coupon.view'
const P_COUPON_ISSUE = 'mall.coupon.issue'
const P_MEMBER_VIEW = 'mall.member.view'
const P_MEMBER_EDIT = 'mall.member.edit'

// ===========================================================================
// 一、字典与总览
// ===========================================================================

r.get('/meta', requireAuth, requirePerm(P_PROMO_VIEW, P_MEMBER_VIEW), guard((_req, res) => {
  const db = getDb()
  return ok(res, {
    promo_types: dict(P.PROMO_TYPE_LABEL),
    allocations: dict(P.ALLOCATION_LABEL),
    targets: dict(P.TARGET_LABEL),
    promo_statuses: dict(P.PROMO_STATUS_LABEL),
    coupon_statuses: dict(C.TEMPLATE_STATUS_LABEL),
    instance_statuses: dict(C.INSTANCE_STATUS_LABEL),
    points_kinds: dict(M.POINTS_KIND_LABEL),
    balance_kinds: dict(M.BALANCE_KIND_LABEL),
    levels: M.listLevels(db),
    // 编辑器要用的规则属性白名单 —— 前端不该自己维护一份（会漂移）
    rule_attributes: [
      { value: 'subtotal', label: '商品金额（分）', scope: 'order' },
      { value: 'shipping_fee', label: '运费（分）', scope: 'order' },
      { value: 'level_code', label: '会员等级', scope: 'order' },
      { value: 'sku_id', label: 'SKU', scope: 'item' },
      { value: 'category_id', label: '商品分类', scope: 'item' },
      { value: 'qty', label: '数量', scope: 'item' },
      { value: 'unit_price', label: '单价（分）', scope: 'item' }
    ],
    rule_operators: ['in', 'not_in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
    settings: db.prepare("SELECT key, value FROM settings WHERE key LIKE 'promo_%' OR key LIKE 'member_%'").all()
  })
}))

r.get('/overview', requireAuth, requirePerm(P_PROMO_VIEW, P_MEMBER_VIEW), guard((_req, res) => {
  const db = getDb()
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  // 空表时 SUM() 返回 NULL（不是 0）。前端拿到 null 会显示成 "-"，
  // 而这一栏的业务含义是"零个活动生效"，两者不是一回事 —— 一律 COALESCE 成 0。
  const promos = one(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active,
           COALESCE(SUM(CASE WHEN is_automatic=1 THEN 1 ELSE 0 END),0) AS automatic,
           COALESCE(SUM(CASE WHEN is_exclusive=1 THEN 1 ELSE 0 END),0) AS exclusive
      FROM promotions`)
  const coupons = one('SELECT COUNT(*) AS templates FROM coupons')
  const issued = one(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status='unused'  THEN 1 ELSE 0 END),0) AS unused,
           COALESCE(SUM(CASE WHEN status='used'    THEN 1 ELSE 0 END),0) AS used,
           COALESCE(SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END),0) AS expired,
           COALESCE(SUM(CASE WHEN status='void'    THEN 1 ELSE 0 END),0) AS voided,
           COALESCE(SUM(used_amount),0) AS used_amount
      FROM coupon_instances`)
  const members = one(`
    SELECT COUNT(*) AS accounts,
           COALESCE(SUM(points),0) AS points_balance,
           COALESCE(SUM(balance_cents),0) AS balance_cents,
           COALESCE(SUM(total_spent_cents),0) AS total_spent_cents
      FROM member_accounts`)
  // ⚠️ `.all()` 不能漏。漏了以后 `by_level` 不是数组而是 better-sqlite3 的 Statement 对象，
  // 而 `JSON.stringify` 会把它序列化成 `{busy, reader, readonly, source, database, …}` ——
  // HTTP 200、字段名也在，前端拿到却是个对象，`by_level.map` 直接抛异常把整页打崩。
  // 「会员等级分布」这一栏是"每个等级是否都有样本"的唯一可视证据，它坏了整个演示就没了。
  const byLevel = db.prepare(`
    SELECT a.level_code, COALESCE(l.name,a.level_code) AS level_name, COUNT(*) AS c
      FROM member_accounts a LEFT JOIN member_levels l ON l.code=a.level_code
     GROUP BY a.level_code ORDER BY l.sort_order`).all()
  const discountUsed = one(`
    SELECT COALESCE(SUM(amount),0) AS promotion_discount,
           COUNT(DISTINCT order_id) AS orders_hit
      FROM promotion_usages`)
  return ok(res, {
    promotions: promos,
    coupons: { ...coupons, ...issued },
    members: { ...members, by_level: byLevel },
    usage: discountUsed
  })
}))

r.get('/audit', requireAuth, requirePerm(P_PROMO_VIEW, P_MEMBER_VIEW), guard((_req, res) => {
  const db = getDb()
  const member = M.auditMember(db)

  // 券状态与实例自洽：已核销的必须有核销时间；未使用的不能有核销时间
  const badUsed = db.prepare(
    "SELECT COUNT(*) AS c FROM coupon_instances WHERE status='used' AND used_at IS NULL").get().c
  const badUnused = db.prepare(
    "SELECT COUNT(*) AS c FROM coupon_instances WHERE status='unused' AND used_at IS NOT NULL").get().c
  // 券模板发出去的张数必须等于实例数（超发检查的兜底）
  const overIssued = db.prepare(`
    SELECT COUNT(*) AS c FROM coupons t
     WHERE t.issued_qty <> (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id = t.id)`).get().c
  // 促销的 used 计数器必须等于使用登记条数 —— 两者不一致会让"限量券还剩几张"变成玄学
  const counterDrift = db.prepare(`
    SELECT COUNT(*) AS c FROM promotions p
     WHERE p.used <> (SELECT COUNT(*) FROM promotion_usages u WHERE u.promotion_id = p.id)`).get().c
  // 优惠留痕必须都指得到一张促销（删了促销就解释不了那笔钱）
  const orphanAdjust = db.prepare(`
    SELECT COUNT(*) AS c FROM promotion_adjustments a
     WHERE NOT EXISTS (SELECT 1 FROM promotions p WHERE p.id = a.promotion_id)`).get().c
  // 会员账户的冗余展示列与账户表必须一致
  const levelDrift = db.prepare(`
    SELECT COUNT(*) AS c FROM member_accounts a JOIN mall_customers c ON c.id = a.customer_id
     WHERE COALESCE(c.level_code,'normal') <> a.level_code`).get().c

  return ok(res, {
    member,
    coupon: { bad_used: badUsed, bad_unused: badUnused, over_issued: overIssued },
    promotion: { counter_drift: counterDrift, orphan_adjustment: orphanAdjust },
    customer_level_drift: levelDrift,
    ok: member.balanced && badUsed === 0 && badUnused === 0 && overIssued === 0
      && counterDrift === 0 && orphanAdjust === 0 && levelDrift === 0
  })
}))

// ===========================================================================
// 二、会员等级
// ===========================================================================

r.get('/levels', requireAuth, requirePerm(P_MEMBER_VIEW, P_PROMO_VIEW), guard((_req, res) => ok(res, M.listLevels(getDb()))))

r.put('/levels/:code', requireAuth, requirePerm(P_MEMBER_EDIT), guard((req, res) => {
  const db = getDb()
  const out = M.updateLevel(db, req.params.code, req.body || {})
  audit(req, { action: 'UPDATE', module: 'marketing', entity: 'member_levels', entityId: req.params.code })
  return ok(res, out)
}))

// ===========================================================================
// 三、活动
// ===========================================================================

r.get('/campaigns', requireAuth, requirePerm(P_PROMO_VIEW), guard((req, res) => {
  const db = getDb()
  return ok(res, P.listCampaigns(db, { status: req.query.status || null, keyword: req.query.keyword || null }))
}))

r.post('/campaigns', requireAuth, requirePerm(P_PROMO_EDIT), guard((req, res) => {
  const b = req.body || {}
  const out = P.createCampaign(getDb(), {
    code: b.code, name: b.name, description: b.description,
    starts_at: b.starts_at || null, ends_at: b.ends_at || null, status: b.status
  })
  audit(req, { action: 'CREATE', module: 'marketing', entity: 'promotion_campaigns', entityId: out.id })
  return ok(res, out)
}))

r.post('/campaigns/:id/status', requireAuth, requirePerm(P_PROMO_PUBLISH), guard((req, res) => {
  const out = P.setCampaignStatus(getDb(), req.params.id, req.body?.status)
  audit(req, { action: 'STATUS', module: 'marketing', entity: 'promotion_campaigns', entityId: out.id })
  return ok(res, out)
}))

// ===========================================================================
// 四、促销
// ===========================================================================

r.get('/promotions', requireAuth, requirePerm(P_PROMO_VIEW), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = P.listPromotions(getDb(), {
    status: req.query.status || null,
    keyword: req.query.keyword || null,
    page, pageSize
  })
  return pagedList(res, out)
}))

// 预检：只校验不落库。界面上的「保存」按钮据此提前报错，
// 而不是让用户点了保存再看到一条错误弹窗（那时他已经离开编辑区了）。
r.post('/promotions/validate', requireAuth, requirePerm(P_PROMO_VIEW, P_PROMO_EDIT), guard((req, res) => {
  return ok(res, { ok: true, normalized: P.validatePromotionDraft(getDb(), req.body || {}) })
}))

r.post('/promotions', requireAuth, requirePerm(P_PROMO_EDIT), guard((req, res) => {
  const out = P.createPromotion(getDb(), req.body || {})
  audit(req, { action: 'CREATE', module: 'marketing', entity: 'promotions', entityId: out.id })
  return ok(res, out)
}))

r.get('/promotions/:id', requireAuth, requirePerm(P_PROMO_VIEW), guard((req, res) => {
  const id = Number(req.params.id)
  return ok(res, P.getPromotionDetail(getDb(), Number.isNaN(id) ? req.params.id : id))
}))

r.put('/promotions/:id', requireAuth, requirePerm(P_PROMO_EDIT), guard((req, res) => {
  const id = Number(req.params.id)
  const out = P.updatePromotion(getDb(), Number.isNaN(id) ? req.params.id : id, req.body || {})
  audit(req, { action: 'UPDATE', module: 'marketing', entity: 'promotions', entityId: out.id })
  return ok(res, out)
}))

r.post('/promotions/:id/status', requireAuth, requirePerm(P_PROMO_PUBLISH), guard((req, res) => {
  const id = Number(req.params.id)
  const out = P.setPromotionStatus(getDb(), Number.isNaN(id) ? req.params.id : id, req.body?.status)
  audit(req, { action: 'STATUS', module: 'marketing', entity: 'promotions', entityId: out.id })
  return ok(res, out)
}))

r.delete('/promotions/:id', requireAuth, requirePerm(P_PROMO_PUBLISH), guard((req, res) => {
  const id = Number(req.params.id)
  const out = P.deletePromotion(getDb(), Number.isNaN(id) ? req.params.id : id)
  audit(req, { action: 'DELETE', module: 'marketing', entity: 'promotions', entityId: out.id })
  return ok(res, out)
}))

// ===========================================================================
// 五、试算与结算
// ===========================================================================

/**
 * 把前端传来的购物车行补齐成促销引擎认识的样子。
 * `buildItems` 只要求 `{sku_id, qty}`，单价缺省时按 SKU 的零售价兜底；
 * 销售/商城侧已经用取价引擎算过单价时，把 `unit_price_cents` 一起传进来即可。
 */
const cartOf = (db, body = {}) => K.buildItems(db, body.items || [])

r.post('/quote', requireAuth, requirePerm(P_PROMO_VIEW, P_COUPON_VIEW), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const lines = cartOf(db, b)
  const out = K.quote(db, {
    items: lines,
    customerId: num(b.customer_id),
    couponCodes: b.coupon_codes || [],
    autoCoupon: !!b.auto_coupon,
    usePoints: Number(b.use_points) || 0,
    at: b.at || null
  })
  return ok(res, out)
}))

r.post('/explain', requireAuth, requirePerm(P_PROMO_VIEW), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const lines = cartOf(db, b)
  const q = K.quote(db, {
    items: lines,
    customerId: num(b.customer_id),
    couponCodes: b.coupon_codes || [],
    autoCoupon: !!b.auto_coupon,
    usePoints: Number(b.use_points) || 0,
    at: b.at || null
  })
  const ex = P.explainPromotion(db, {
    items: lines,
    customer: q.member ? { id: q.member.customer_id, level: q.member.level_code, level_code: q.member.level_code } : {},
    subtotal: q.subtotal,
    codes: q.coupon.promotion_codes,
    now: q.at
  })
  return ok(res, { quote: q, explain: ex })
}))

r.post('/settle', requireAuth, requirePerm(P_PROMO_EDIT, P_COUPON_ISSUE), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  if (b.order_id == null) return fail(res, '缺少 order_id（优惠留痕与使用登记要按订单归属）', 400)
  const out = K.settle(db, {
    // 人工端点的默认通道是 `oms`（它按 `oms_orders.id` 归属）——
    // 显式写出来，不靠函数默认值：`settle` 已经把 `source` 定为必填（迁移 030）。
    source: b.source || 'oms',
    orderId: Number(b.order_id),
    items: K.buildItems(db, b.items || []),
    customerId: num(b.customer_id),
    couponCodes: b.coupon_codes || [],
    autoCoupon: !!b.auto_coupon,
    usePoints: Number(b.use_points) || 0,
    at: b.at || null,
    orderAmountForPoints: b.order_amount_for_points != null ? Number(b.order_amount_for_points) : null
  })
  audit(req, { action: 'SETTLE', module: 'marketing', entity: 'oms_orders', entityId: Number(b.order_id) })
  return ok(res, out)
}))

r.post('/unsettle', requireAuth, requirePerm(P_PROMO_EDIT, P_COUPON_ISSUE), guard((req, res) => {
  const b = req.body || {}
  if (b.order_id == null) return fail(res, '缺少 order_id', 400)
  const out = K.unsettle(getDb(), {
    source: b.source || 'oms',
    orderId: Number(b.order_id),
    reason: b.reason || '订单取消',
    // 累计消费回退要知道"当初记了多少"。不给就只做留痕/券/积分回退，不回退累计口径。
    orderAmountCents: b.order_amount_cents != null ? Number(b.order_amount_cents) : 0
  })
  audit(req, { action: 'UNSETTLE', module: 'marketing', entity: 'oms_orders', entityId: Number(b.order_id) })
  return ok(res, out)
}))

// ===========================================================================
// 六、券
// ===========================================================================

r.get('/coupons', requireAuth, requirePerm(P_COUPON_VIEW), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = C.listCoupons(getDb(), { status: req.query.status || null, keyword: req.query.keyword || null, page, pageSize })
  return pagedList(res, out)
}))

r.post('/coupons', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const out = C.createCoupon(getDb(), req.body || {})
  audit(req, { action: 'CREATE', module: 'marketing', entity: 'coupons', entityId: out.id })
  return ok(res, out)
}))

// 到期券批量落库。放在 /coupons/:id 之前 —— 否则 "expire" 会被当成 id。
r.post('/coupons/expire', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const out = C.expireCoupons(getDb(), { at: req.body?.at || null })
  audit(req, { action: 'EXPIRE', module: 'marketing', entity: 'coupon_instances', entityId: null })
  return ok(res, out)
}))

r.get('/coupons/:id', requireAuth, requirePerm(P_COUPON_VIEW), guard((req, res) => {
  const out = C.getCouponDetail(getDb(), Number(req.params.id))
  if (!out) return fail(res, '券模板不存在', 404)
  return ok(res, out)
}))

r.put('/coupons/:id', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const out = C.updateCoupon(getDb(), Number(req.params.id), req.body || {})
  audit(req, { action: 'UPDATE', module: 'marketing', entity: 'coupons', entityId: out.id })
  return ok(res, out)
}))

r.post('/coupons/:id/status', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const out = C.setCouponStatus(getDb(), Number(req.params.id), req.body?.status)
  audit(req, { action: 'STATUS', module: 'marketing', entity: 'coupons', entityId: out.id })
  return ok(res, out)
}))

r.post('/coupons/:id/issue', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const b = req.body || {}
  const out = C.issueCoupons(getDb(), {
    couponId: Number(req.params.id),
    customerId: num(b.customer_id),
    qty: Number(b.qty) || 1,
    remark: b.remark || null
  })
  audit(req, { action: 'ISSUE', module: 'marketing', entity: 'coupon_instances', entityId: Number(req.params.id) })
  return ok(res, out)
}))

r.get('/coupon-instances', requireAuth, requirePerm(P_COUPON_VIEW), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = C.listInstances(getDb(), {
    customerId: num(req.query.customer_id),
    couponId: num(req.query.coupon_id),
    status: req.query.status || null,
    page, pageSize
  })
  return pagedList(res, out)
}))

r.post('/coupon-instances/:id/void', requireAuth, requirePerm(P_COUPON_ISSUE), guard((req, res) => {
  const out = C.voidInstance(getDb(), { instanceId: Number(req.params.id), remark: req.body?.remark })
  audit(req, { action: 'VOID', module: 'marketing', entity: 'coupon_instances', entityId: Number(req.params.id) })
  return ok(res, out)
}))

// ===========================================================================
// 七、会员
// ===========================================================================

r.get('/members', requireAuth, requirePerm(P_MEMBER_VIEW), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = M.listAccounts(getDb(), {
    keyword: req.query.keyword || null,
    levelCode: req.query.level_code || null,
    page, pageSize
  })
  return pagedList(res, out)
}))

r.get('/members/:customerId', requireAuth, requirePerm(P_MEMBER_VIEW), guard((req, res) => {
  const db = getDb()
  const cid = Number(req.params.customerId)
  const out = M.getMemberDetail(db, cid)
  if (!out) return fail(res, '会员不存在', 404)
  return ok(res, { ...out, coupon_stat: M.couponStat(db, cid) })
}))

r.get('/members/:customerId/ledger', requireAuth, requirePerm(P_MEMBER_VIEW), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const db = getDb()
  const cid = Number(req.params.customerId)
  const kind = req.query.kind === 'balance' ? 'balance' : 'points'
  const out = kind === 'balance'
    ? M.listBalanceLedger(db, { customerId: cid, page, pageSize })
    : M.listPointsLedger(db, { customerId: cid, page, pageSize })
  return pagedList(res, out, { kind })
}))

r.post('/members/:customerId/points', requireAuth, requirePerm(P_MEMBER_EDIT), guard((req, res) => {
  const b = req.body || {}
  const out = M.adjustPoints(getDb(), {
    customerId: Number(req.params.customerId),
    change: Number(b.change),
    remark: b.remark,
    actor: actorOf(req)
  })
  audit(req, { action: 'ADJUST_POINTS', module: 'marketing', entity: 'member_accounts', entityId: Number(req.params.customerId) })
  return ok(res, out)
}))

r.post('/members/:customerId/balance', requireAuth, requirePerm(P_MEMBER_EDIT), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const cid = Number(req.params.customerId)
  // 充值（正数）与调整（正负）分开：充值要记 doc_no 走财务，
  // 调整是纠错，必须留理由。混在一个接口里会让"钱怎么进来的"查不清。
  const out = b.kind === 'recharge'
    ? M.rechargeBalance(db, {
      customerId: cid,
      amountCents: Math.round(Number(b.amount_cents) || 0),
      docNo: b.doc_no || null,
      remark: b.remark || null
    })
    : M.adjustBalance(db, {
      customerId: cid,
      changeCents: Math.round(Number(b.change_cents) || 0),
      remark: b.remark,
      actor: actorOf(req)
    })
  audit(req, { action: b.kind === 'recharge' ? 'RECHARGE' : 'ADJUST_BALANCE', module: 'marketing', entity: 'member_accounts', entityId: cid })
  return ok(res, out)
}))

r.post('/members/:customerId/level', requireAuth, requirePerm(P_MEMBER_EDIT), guard((req, res) => {
  const b = req.body || {}
  const out = M.setMemberLevel(getDb(), {
    customerId: Number(req.params.customerId),
    levelCode: b.level_code,
    remark: b.remark,
    actor: actorOf(req)
  })
  audit(req, { action: 'SET_LEVEL', module: 'marketing', entity: 'member_accounts', entityId: Number(req.params.customerId) })
  return ok(res, out)
}))

r.post('/members/:customerId/sync', requireAuth, requirePerm(P_MEMBER_EDIT), guard((req, res) => {
  const out = M.syncLevel(getDb(), Number(req.params.customerId), { force: !!req.body?.force })
  return ok(res, out)
}))

r.post('/members/:customerId/coupons', requireAuth, requirePerm(P_COUPON_ISSUE, P_MEMBER_EDIT), guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const cid = Number(req.params.customerId)
  if (b.coupon_code) {
    // 定向发一张指定券（客服补发场景）
    const out = C.claimCoupon(db, { couponCode: b.coupon_code, customerId: cid })
    audit(req, { action: 'CLAIM', module: 'marketing', entity: 'coupon_instances', entityId: cid })
    return ok(res, out)
  }
  const out = C.issueCoupons(db, { couponId: Number(b.coupon_id), customerId: cid, qty: Number(b.qty) || 1, remark: b.remark || null })
  audit(req, { action: 'ISSUE', module: 'marketing', entity: 'coupon_instances', entityId: cid })
  return ok(res, out)
}))

// ===========================================================================
// 八、C 端（商城 H5）
//
// 这三个端点与上面的区别只有一个：**信任级别**。它们不写任何"面向全站"的数据
// （不建活动、不发券给他人），只做「查我自己」和「领我自己的券」。
// 放在同一个路由文件里是为了让"营销域的全部入口"一眼可见。
//
// ⚠️ **身份一律取 C 端会话（`x-mall-token`），不再"手机号即身份"。**
// 这一段原来写的是「免登录，手机号即身份」：`req.query.phone` / `req.body.phone` 直接当主键。
// 手机号是**公开标识**（印在快递单上），不是凭据 —— 知道一个手机号就能读他的
// 会员等级、积分、储值、券包，还能替他领券。A16 收口时只改了 `routes/mall.js`，
// 这三个端点是**漏网的那一个入口**（详见 `middleware/mall-session.js` 的文件头）。
// ===========================================================================

r.get('/shop/member', requireMall, guard((req, res) => {
  const db = getDb()
  const c = mallCustomer(db, req.mall)
  // 没有档案 = 这个会话还没消费过，返回"空会员"而不是报错：
  // 刚注册就打开"我的"页面是正常路径，报错会让前端只能显示一个红条。
  if (!c) return ok(res, { customer: null, points: 0, balance_cents: 0, coupons: { usable: [], blocked: [] } })
  const detail = M.getMemberDetail(db, c.id)
  return ok(res, {
    ...detail,
    coupon_stat: M.couponStat(db, c.id),
    coupons: C.availableCoupons(db, { customerId: c.id, orderAmountCents: 0 })
  })
}))

r.get('/shop/promotions', guard((_req, res) => {
  const db = getDb()
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  // 只展示「任何人都能参与」的自动促销（要券的那些属于券包，不挂在活动墙上）
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.type, p.priority, p.starts_at, p.ends_at, p.remark,
           m.type AS method_type, m.target_type, m.allocation, m.value, m.max_quantity,
           (SELECT COUNT(*) FROM promotion_rules r WHERE r.promotion_id=p.id AND r.rule_group='rules') AS rule_count
      FROM promotions p LEFT JOIN promotion_methods m ON m.promotion_id = p.id
     WHERE p.status='active' AND p.is_automatic=1
       AND (p.starts_at IS NULL OR p.starts_at <= ?)
       AND (p.ends_at   IS NULL OR p.ends_at   >= ?)
     ORDER BY p.priority, p.id
  `).all(now, now)
  return ok(res, rows.map((x) => ({
    ...x,
    // `value` 是**减免率**的万分比：500 = 减 5% → 实付 95% → 9.5 折。
    // 曾经写成 `value / 1000`（把 500 显示成"0.5 折"）—— 方向反了，且不报错。
    method_label: x.method_type === 'percentage'
      ? `${((10000 - (x.value ?? 0)) / 1000).toFixed(1)} 折`
      : `减 ${((x.value ?? 0) / 100).toFixed(2)} 元`
  })))
}))

r.post('/shop/quote', requireMall, guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const c = mallCustomer(db, req.mall)
  const out = K.quote(db, {
    items: K.buildItems(db, b.items || []),
    customerId: c?.id ?? null,
    couponCodes: b.coupon_codes || [],
    autoCoupon: !!b.auto_coupon,
    usePoints: Number(b.use_points) || 0
  })
  // C 端不暴露成本口径与内部轨迹，只给"能不能用 / 减多少"
  return ok(res, {
    subtotal: out.subtotal,
    member_discount: out.member_discount,
    promotion_discount: out.promotion_discount,
    points_discount: out.points_discount,
    points_used: out.points_used,
    payable: out.payable,
    discount_total: out.discount_total,
    line_discounts: out.line_discounts,
    applied_codes: out.applied_codes,
    member: out.member,
    coupon: out.coupon,
    points_quote: out.points_quote
  })
}))

r.post('/shop/claim', requireMall, guard((req, res) => {
  const db = getDb()
  const b = req.body || {}
  const c = mallCustomer(db, req.mall)
  if (!c) return fail(res, '请先在商城下过单再领券', 400)
  const couponId = Number(b.coupon_id)
  // 领券：按模板发一张给本人。`claimCoupon` 走的是券码路径，
  // 这里先发再回传券码，语义与"领取"一致（本人一张、受实名限领约束）。
  const out = C.issueCoupons(db, { couponId, customerId: c.id, qty: 1, remark: 'C 端自助领取' })
  return ok(res, out)
}))

export default r
