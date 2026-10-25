/**
 * ============================================================================
 * 文件标识：server/routes/pos.js ｜ 门店 POS 路由：零售单与作废、班次报数/核款、日结上传与总部确认（RC.confirm）
 * ============================================================================
 * 【职责】门店 POS 路由：零售单与作废、班次报数/核款、日结上传与总部确认（RC.confirm）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自人工补充**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { localDate } from '../lib/dates.js'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, failFromError } from '../lib/http.js'
import { requireAuth, requireRole, requirePerm, permContext, hasPerm, resolveOrgScope } from '../middleware/auth.js'
import { warehouseInScope } from '../lib/stock.js'
import { audit } from '../middleware/audit.js'
import { advanceStatus } from '../lib/docflow.js'
import {
  PAY_METHODS,
  PAY_METHOD_LABEL,
  CASH_METHOD,
  HANDLE_TYPES,
  openShift,
  declareShift,
  rejectShift,
  approveShift,
  settleVariance,
  cancelShift,
  createCashDrop,
  receiveCashDrop,
  cancelCashDrop,
  dailyCloseGate,
  computeShiftSystem,
  cashInflight,
  shiftDetail,
  listShifts,
  storeReturn,
  createStoreCheck,
  submitStoreCheckItems,
  adjustStoreCheck,
  getVarianceLimit,
  posQuote,
  createPosOrder,
  voidPosOrder,
  dailyClose
} from '../lib/pos2.js'

const r = Router()

// ---------- 工具 ----------
function storeCtx(req) {
  const db = getDb()
  const u = req.user
  if (!u.store_id) throw Object.assign(new Error('当前账号未绑定门店'), { status: 403 })
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(u.store_id)
  if (!store) throw Object.assign(new Error('门店不存在'), { status: 404 })
  // ADR-0038 补充（AA4）：库存读取覆盖**本店全部启用仓**（`whs`）；
  // `wh`（范围内首个启用仓）是写路径（收银出库 / 日结 / 盘点等）的默认仓。
  // 账号另带组织范围（org / subtree + 具体组织）时再叠加仓库归属组织：门店绑定不能把别组织的仓挂进来读。
  // 没有组织（none / self / all 等）时门店绑定仍是唯一依据（ADR-0025，门店账号通常不带组织）。
  const os = resolveOrgScope(db, u)
  const orgRestricted = (os.scope === 'org' || os.scope === 'subtree') && os.orgIds?.length
  const whs = db
    .prepare("SELECT * FROM warehouses WHERE store_id=? AND status='active' ORDER BY id")
    .all(store.id)
    .filter((w) => !orgRestricted || warehouseInScope(db, w.id, os))
  // 写路径默认仓（收银 / 日结 / 盘点出库）同样只取范围内的首个启用仓；无组织限制时与原来的首个启用仓一致
  return { db, store, wh: whs[0] || null, whs, u }
}

function requireStore() {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next() // 总部可代门店操作（演示）
    // 绑了门店的账号才进得来；能做什么由紧随其后的 requirePerm 决定（ADR-0025）。
    // 这样"只带日常权限的自定义角色"也能用 POS，而不是被硬编码的 role==='store' 挡在门外。
    if (!req.user.store_id) return fail(res, '当前账号未绑定门店，请联系总部', 403, 403)
    next()
  }
}

/** 总部侧只读查询用：允许 admin/财务/仓储/销售看，不允许门店账号看别家 */
const HQ_ROLES = ['admin', 'sales', 'finance', 'warehouse']

function today() {
  return localDate()
}

// ===========================================================================
// 一、门店上下文与商品
// ===========================================================================

r.get(
  '/context',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store, wh, u } = storeCtx(req)
    const bizDate = today()
    // 当前收银员本日未结清的班次（营业中或待核款）。**以收银员为键**，
    // 因为一家店可以同时有几个收银员各管一个钱箱。
    const shift = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM pos_shift_payments p WHERE p.shift_id=s.id) AS pay_method_count
           FROM pos_shifts s
          WHERE s.store_id=? AND s.biz_date=? AND s.status IN ('open','declared')
            AND (s.cashier_id IS ? OR COALESCE(s.cashier_name,'')=?)
          ORDER BY s.id DESC LIMIT 1`
      )
      .get(store.id, bizDate, u.uid ?? null, u.name || '')
    const localOrders = db
      .prepare("SELECT COUNT(*) c FROM pos_orders WHERE store_id=? AND status='local'")
      .get(store.id).c
    const todayAgg = db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) amount FROM pos_orders
         WHERE store_id=? AND biz_date=? AND status IN ('local','synced')`
      )
      .get(store.id, bizDate)
    const sys = shift ? computeShiftSystem(db, shift.id) : null
    const gate = dailyCloseGate(db, { storeId: store.id, bizDate })
    return ok(res, {
      store,
      warehouse: wh,
      cashier: { id: u.uid, name: u.name, role: u.role },
      shift,
      shift_system: sys,
      local_orders: localOrders,
      today: { orders: todayAgg.c, amount: todayAgg.amount, date: bizDate },
      daily_close_gate: gate,
      pay_methods: PAY_METHODS.map((m) => ({ code: m, label: PAY_METHOD_LABEL[m] }))
    })
  })
)

r.get(
  '/products',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, whs } = storeCtx(req)
    const kw = (req.query.kw || '').trim()
    let where = "s.status='active' AND p.item_type='product'"
    const params = []
    if (kw) {
      where += ` AND (s.sku_code LIKE ? OR s.name LIKE ? OR s.barcode LIKE ? OR p.name LIKE ?)`
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`)
    }
    const rows = db
      .prepare(
        `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec, s.barcode, s.price_retail, s.price_member,
                p.id AS product_id, p.name AS product_name, p.unit, p.spu_code,
                b.name AS brand_name, c.name AS category_name
         FROM product_skus s
         JOIN products p ON p.id=s.product_id
         LEFT JOIN brands b ON b.id=p.brand_id
         LEFT JOIN categories c ON c.id=p.category_id
         WHERE ${where}
         ORDER BY p.category_id, s.sku_code
         LIMIT 200`
      )
      .all(...params)
    const whIds = whs.map((w) => w.id)
    const whIn = whIds.map(() => '?').join(',')
    for (const row of rows) {
      const st = whIds.length
        ? db
            .prepare(
              `SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id IN (${whIn}) AND sku_id=?`
            )
            .get(...whIds, row.sku_id)
        : { a: 0 }
      row.store_stock = st.a
    }
    return ok(res, rows)
  })
)

// ===========================================================================
// 二、收银开单
// ===========================================================================

/**
 * 开单收银（本地单：不扣库存、不写总部，日结时统一上传）。
 *
 * **必须挂在营业中的班次上**。此前靠「同门店 + 同业务日 + 同收银员」在核款时现算归属，
 * 于是同一收银员一天开两个班（午班/晚班）时，两个班会算出同一批订单，
 * 现金应收直接翻倍、长短款跟着错一倍，而界面上完全看不出来。
 * 开单时就把 `shift_id` 写下来，这个错误在结构上就不可能发生。
 */
r.post(
  '/orders',
  requireAuth,
  requireStore(),
  requirePerm('pos.cashier'),
  wrap((req, res) => {
    const { db, store, wh, u } = storeCtx(req)
    const shift = db
      .prepare("SELECT id FROM pos_shifts WHERE store_id=? AND biz_date=? AND status='open' AND (cashier_id IS ? OR COALESCE(cashier_name,'')=?) ORDER BY id DESC LIMIT 1")
      .get(store.id, req.body?.biz_date || today(), u.uid ?? null, u.name || '')
    if (!shift) return fail(res, '请先开班（交班核款所需的现金口径挂在班次上）', 409, 409)
    // 营销参数（券 / 积分抵现 / 自动选券）由收银台透传 —— 与商城走同一个 `checkout.settle`
    let result
    try {
      result = createPosOrder(db, {
        storeId: store.id,
        warehouseId: wh ? wh.id : null,
        shiftId: shift.id,
        cashierId: u.uid ?? null,
        cashierName: u.name || null,
        items: req.body?.items || [],
        memberPhone: req.body?.member_phone || '',
        payMethod: req.body?.pay_method || CASH_METHOD,
        discountAmount: req.body?.discount_amount || 0,
        remark: req.body?.remark || null,
        couponCodes: req.body?.coupon_codes || [],
        usePoints: req.body?.use_points || 0,
        autoCoupon: !!req.body?.auto_coupon
      })
    } catch (e) {
      // 券不可用 / 积分超上限 / 该等级不可抵现…… 都是收银员能当场处理的业务原因，
      // 不能变成一个 500「服务器错误」让他去猜。
      if (failFromError(res, e)) return undefined
      throw e
    }
    audit(req, { action: 'CREATE', module: 'pos', entity: 'pos_orders', entityId: result.id, detail: result.doc_no })
    return ok(res, result)
  })
)

/**
 * 收银台试算（不写任何表）。
 *
 * 存在的理由：收款前必须能回答"这一单到底收多少钱、为什么"。
 * 与落单共用 `pos2.posQuote` —— **同一份算钱判据**，所以界面上显示的应收
 * 与提交后实际落库的 `pay_amount` 不会分叉。
 */
r.post(
  '/quote',
  requireAuth,
  requireStore(),
  requirePerm('pos.cashier'),
  wrap((req, res) => {
    const { db } = storeCtx(req)
    const b = req.body || {}
    let out
    try {
      out = posQuote(db, {
        items: b.items || [],
        memberPhone: b.member_phone || '',
        couponCodes: b.coupon_codes || [],
        usePoints: b.use_points || 0,
        autoCoupon: !!b.auto_coupon,
        discountAmount: b.discount_amount || 0
      })
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
    // 收银台需要的是"收多少钱、减在哪几段"，不需要促销内部轨迹与成本口径
    return ok(res, {
      goods_amount: out.totalAmount,
      total_qty: out.totalQty,
      manual_discount: out.manualDiscount,
      member_discount: Number((out.quote.member_discount / 100).toFixed(2)),
      promotion_discount: Number((out.quote.promotion_discount / 100).toFixed(2)),
      points_discount: Number((out.quote.points_discount / 100).toFixed(2)),
      points_used: out.quote.points_used,
      discount_amount: out.discount,
      pay_amount: out.payAmount,
      applied_codes: out.quote.applied_codes,
      member: out.quote.member,
      points_quote: out.quote.points_quote,
      coupon: out.quote.coupon,
      over_discounted: out.overDiscounted
    })
  })
)

r.get(
  '/orders',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const status = req.query.status
    const where = ['po.store_id=?']
    const params = [store.id]
    if (status) {
      where.push('po.status=?')
      params.push(status)
    }
    // `shift_id` 一并带出：出问题时第一件事就是看「这笔钱记在哪个班次上」
    const rows = db
      .prepare(
        `SELECT po.*, sh.doc_no AS shift_no,
                (SELECT COUNT(*) FROM pos_order_items i WHERE i.pos_order_id=po.id) AS item_count
         FROM pos_orders po LEFT JOIN pos_shifts sh ON sh.id=po.shift_id
         WHERE ${where.join(' AND ')} ORDER BY po.id DESC LIMIT 100`
      )
      .all(...params)
    return ok(res, rows)
  })
)

r.get(
  '/orders/:id',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const o = db.prepare('SELECT * FROM pos_orders WHERE id=? AND store_id=?').get(Number(req.params.id), store.id)
    if (!o) return fail(res, '单据不存在', 404)
    const items = db.prepare('SELECT * FROM pos_order_items WHERE pos_order_id=?').all(o.id)
    const shift = o.shift_id ? db.prepare('SELECT id,doc_no,status FROM pos_shifts WHERE id=?').get(o.shift_id) : null
    return ok(res, { order: o, items, shift })
  })
)

// 作废（仅本地单）。状态流转与**营销优惠回退**必须同一事务 ——
// 见 `pos2.voidPosOrder`：只废单不退优惠的后果是"名额被废单占着、积分白扣"且不报错。
r.post(
  '/orders/:id/void',
  requireAuth,
  requireStore(),
  requirePerm('pos.refund'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const id = Number(req.params.id)
    let out
    try {
      out = voidPosOrder(db, {
        id,
        storeId: store.id,
        remark: req.body?.remark || '门店作废本机订单',
        actor: { id: u.uid ?? null, name: u.name || null }
      })
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
    audit(req, { action: 'VOID', module: 'pos', entity: 'pos_orders', entityId: id, detail: out.doc_no })
    return ok(res, out)
  })
)

// ===========================================================================
// 三、本店库存
// ===========================================================================

r.get(
  '/stocks',
  requireAuth,
  requireStore(),
  requirePerm('pos.store.stock'),
  wrap((req, res) => {
    const { db, whs } = storeCtx(req)
    if (!whs.length) return ok(res, [])
    const rows = db
      .prepare(
        `SELECT st.sku_id, st.batch_no, st.expire_date, st.qty_on_hand, st.qty_reserved,
                (st.qty_on_hand - st.qty_reserved) AS qty_available, st.cost_price,
                sk.sku_code, sk.name AS sku_name, sk.barcode, p.name AS product_name, p.unit
         FROM inventory_stocks st
         JOIN product_skus sk ON sk.id=st.sku_id
         JOIN products p ON p.id=sk.product_id
         WHERE st.warehouse_id IN (${whs.map(() => '?').join(',')}) AND st.qty_on_hand > 0
         ORDER BY p.category_id, sk.sku_code, st.warehouse_id`
      )
      .all(...whs.map((w) => w.id))
    return ok(res, rows)
  })
)

// ===========================================================================
// 四、班次：开班 → 报数 → 核款 → （挂账结案 / 作废）
// ===========================================================================

r.get(
  '/shifts',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    return ok(
      res,
      listShifts(db, {
        storeId: req.query.all === '1' && HQ_ROLES.includes(req.user.role) ? req.query.store_id || null : store.id,
        bizDate: req.query.biz_date || null,
        status: req.query.status || null,
        limit: Number(req.query.limit || 100)
      })
    )
  })
)

r.get(
  '/shifts/open',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT * FROM pos_shifts
          WHERE store_id=? AND status IN ('open','declared')
            AND (cashier_id IS ? OR COALESCE(cashier_name,'')=?)
          ORDER BY biz_date DESC, id DESC`
      )
      .all(store.id, u.uid ?? null, u.name || '')
    return ok(res, rows)
  })
)

r.get(
  '/shifts/:id',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    // 总部管理员可跨店只读；门店账号看别家的班次一律按"不存在"处理（404），不泄露存在性
    if (req.user.role !== 'admin') assertShiftOfStore(db, id, store.id)
    return ok(res, shiftDetail(db, id))
  })
)

r.post(
  '/shifts/open',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const shift = openShift(db, {
      storeId: store.id,
      cashierId: u.uid ?? null,
      cashierName: u.name || null,
      businessDate: req.body?.biz_date || today(),
      openingFloat: req.body?.opening_float || 0,
      deviceNo: req.body?.device_no || null,
      remark: req.body?.remark || null
    })
    audit(req, { action: 'OPEN', module: 'pos', entity: 'pos_shifts', entityId: shift.id, detail: shift.doc_no })
    return ok(res, { id: shift.id, doc_no: shift.doc_no, biz_date: shift.biz_date, opening_float: shift.opening_float })
  })
)

/** 交班报数（原 `/shifts/close` 的语义被拆成「报数」+「核款」两步，旧端点保留为别名） */
r.post(
  '/shifts/:id/declare',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    assertShiftOfStore(db, id, store.id)
    const detail = declareShift(db, req, {
      shiftId: id,
      payments: req.body?.payments || [],
      remark: req.body?.remark || null
    })
    audit(req, { action: 'DECLARE', module: 'pos', entity: 'pos_shifts', entityId: id, detail: detail.shift.doc_no })
    return ok(res, detail)
  })
)

r.post(
  '/shifts/:id/reject',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift.review'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    assertShiftOfStore(db, id, store.id)
    const detail = rejectShift(db, req, { shiftId: id, remark: req.body?.remark, separateChecker: true })
    audit(req, { action: 'REJECT', module: 'pos', entity: 'pos_shifts', entityId: id, detail: detail.shift.doc_no })
    return ok(res, detail)
  })
)

r.post(
  '/shifts/:id/approve',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift.review'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    assertShiftOfStore(db, id, store.id)
    const detail = approveShift(db, req, {
      shiftId: id,
      separateChecker: true,
      countedCash: req.body?.counted_cash,
      varianceNote: req.body?.variance_note ?? null,
      varianceHandled: req.body?.variance_handled ?? null,
      floatReturned: req.body?.float_returned !== false,
      remark: req.body?.remark ?? null
    })
    audit(req, {
      action: 'APPROVE',
      module: 'pos',
      entity: 'pos_shifts',
      entityId: id,
      detail: `${detail.shift.doc_no} 长短款 ${detail.shift.variance}`
    })
    return ok(res, detail)
  })
)

/**
 * 落案挂账差异（`pending` → charge / absorb）。这一步不是状态流转，见 lib/pos2.js 说明。
 * AA9：闸是权限点 `pos.shift.settle`（不再看角色名）；绑了门店的非 admin 账号只能结本店班次，别家 404。
 * 无门店绑定的总部角色账号（HQ_ROLES，如 finance）持权限即可结任意门店；未绑门店的非总部账号 403。
 */
r.post(
  '/shifts/:id/settle-variance',
  requireAuth,
  requirePerm('pos.shift.settle'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    if (req.user.role !== 'admin') {
      // 绑了门店 → 只能结本店；没绑门店 → 只有总部角色（HQ_ROLES）可跨店，未绑门店的 store 账号 403（Codex 审计 P1）
      if (req.user.store_id) assertShiftOfStore(db, id, req.user.store_id)
      else if (!HQ_ROLES.includes(req.user.role)) return fail(res, '当前账号未绑定门店，请联系总部', 403, 403)
    }
    const detail = settleVariance(db, req, { shiftId: id, handled: req.body?.handled, note: req.body?.note ?? null })
    audit(req, { action: 'SETTLE_VARIANCE', module: 'pos', entity: 'pos_shifts', entityId: id, detail: req.body?.handled })
    return ok(res, detail)
  })
)

r.post(
  '/shifts/:id/cancel',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    const shift = assertShiftOfStore(db, id, store.id)
    // 已报数的班次作废等于推翻收银员报数，状态机要求核款权限（advanceStatus 不校验边权限，这里补上）
    if (shift.status === 'declared' && !hasPerm(permContext(db, req.user), 'pos.shift.review')) {
      return fail(res, '作废已报数的班次需要 pos.shift.review 权限', 403, 403)
    }
    const detail = cancelShift(db, req, { shiftId: id, remark: req.body?.remark || null })
    audit(req, { action: 'CANCEL', module: 'pos', entity: 'pos_shifts', entityId: id, detail: detail.shift.doc_no })
    return ok(res, detail)
  })
)

/** 兼容旧前端：`/shifts/close` 语义等同「交班报数」 */
r.post(
  '/shifts/close',
  requireAuth,
  requireStore(),
  requirePerm('pos.shift'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const rows = db
      .prepare("SELECT id FROM pos_shifts WHERE store_id=? AND status='open' AND (cashier_id IS ? OR COALESCE(cashier_name,'')=?) ORDER BY id")
      .all(store.id, u.uid ?? null, u.name || '')
    if (!rows.length) return fail(res, '没有营业中的班次')
    const details = rows.map((s) =>
      declareShift(db, req, { shiftId: s.id, payments: req.body?.payments || [], remark: req.body?.remark || '收银交班' })
    )
    return ok(res, { declared: rows.length, shifts: details.map((d) => d.shift) })
  })
)

function assertShiftOfStore(db, shiftId, storeId) {
  const s = db.prepare('SELECT * FROM pos_shifts WHERE id=?').get(Number(shiftId))
  if (!s) {
    const e = new Error(`班次 #${shiftId} 不存在`)
    e.status = 404
    e.code = 'SHIFT_NOT_FOUND'
    throw e
  }
  if (Number(s.store_id) !== Number(storeId)) {
    // 别家门店的班次对本店账号等同于不存在（ADR-0025）：状态码与文案都不能区分"没有"和"不是你的"
    const e = new Error(`班次 #${shiftId} 不存在`)
    e.status = 404
    e.code = 'SHIFT_NOT_FOUND'
    throw e
  }
  return s
}

/** 缴款单必须属于本店；别家门店的缴款单按不存在处理（404），不改任何状态 */
function assertDropOfStore(db, dropId, storeId) {
  const d = db.prepare('SELECT id, store_id FROM pos_cash_drops WHERE id=?').get(Number(dropId))
  if (!d || Number(d.store_id) !== Number(storeId)) {
    const e = new Error(`缴款单 #${dropId} 不存在`)
    e.status = 404
    e.code = 'DROP_NOT_FOUND'
    throw e
  }
  return d
}

// ===========================================================================
// 五、缴款单
// ===========================================================================

const dropSelect = `SELECT d.*, s.name AS store_name,
                           (SELECT COUNT(*) FROM pos_cash_drop_items i WHERE i.drop_id=d.id) AS shift_count
                      FROM pos_cash_drops d LEFT JOIN stores s ON s.id=d.store_id`

r.get(
  '/cash-drops',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const where = ['d.store_id=?']
    const params = [store.id]
    if (req.query.status) {
      where.push('d.status=?')
      params.push(req.query.status)
    }
    const rows = db
      .prepare(`${dropSelect} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 100`)
      .all(...params)
    for (const d of rows) d.items = db.prepare('SELECT * FROM pos_cash_drop_items WHERE drop_id=?').all(d.id)
    return ok(res, rows)
  })
)

/** 待缴款的班次（已核款、实点现金 > 0、还没缴过） */
r.get(
  '/cash-drops/pending-shifts',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT s.id, s.doc_no, s.biz_date, s.cashier_name, s.counted_cash, s.variance, s.cash_drop_amount, s.approved_at
           FROM pos_shifts s
          WHERE s.store_id=? AND s.status='closed' AND COALESCE(s.counted_cash,0) > 0
            AND COALESCE(s.cash_drop_amount,0) + 0.005 < COALESCE(s.counted_cash,0)
            AND NOT EXISTS (SELECT 1 FROM pos_cash_drop_items i WHERE i.shift_id = s.id)
          ORDER BY s.biz_date, s.id`
      )
      .all(store.id)
    return ok(res, rows)
  })
)

r.post(
  '/cash-drops',
  requireAuth,
  requireStore(),
  requirePerm('pos.cashdrop'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const result = createCashDrop(db, req, {
      storeId: store.id,
      shiftIds: req.body?.shift_ids || [],
      dropDate: req.body?.drop_date || today(),
      handedBy: u.uid ?? null,
      handedByName: u.name || null,
      referenceNo: req.body?.reference_no || null,
      remark: req.body?.remark || null
    })
    audit(req, { action: 'CREATE', module: 'pos', entity: 'pos_cash_drops', entityId: result.id, detail: result.doc_no })
    return ok(res, result)
  })
)

r.post(
  '/cash-drops/:id/receive',
  requireAuth,
  requireStore(),
  requirePerm('pos.cashdrop.receive'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    assertDropOfStore(db, Number(req.params.id), store.id)
    const d = receiveCashDrop(db, req, {
      dropId: Number(req.params.id),
      referenceNo: req.body?.reference_no || null,
      remark: req.body?.remark || null
    })
    audit(req, { action: 'RECEIVE', module: 'pos', entity: 'pos_cash_drops', entityId: d.id, detail: d.doc_no })
    return ok(res, d)
  })
)

r.post(
  '/cash-drops/:id/cancel',
  requireAuth,
  requireStore(),
  requirePerm('pos.cashdrop'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    assertDropOfStore(db, Number(req.params.id), store.id)
    const d = cancelCashDrop(db, req, { dropId: Number(req.params.id), remark: req.body?.remark || null })
    audit(req, { action: 'CANCEL', module: 'pos', entity: 'pos_cash_drops', entityId: d.id, detail: d.doc_no })
    return ok(res, d)
  })
)

// ===========================================================================
// 六、日结（含核款门禁与现金口径）
// ===========================================================================

// 实现全部在 `lib/pos2.js` 的 `dailyClose`：路由只负责上下文与留痕，
// 这样 seed 与测试走的是同一条代码路径 —— 「日结的现金口径」只有一处定义。
r.post(
  '/daily-close',
  requireAuth,
  requireStore(),
  requirePerm('pos.dailyclose'),
  wrap((req, res) => {
    const { db, store, wh, u } = storeCtx(req)
    if (!wh) return fail(res, '该门店未绑定门店仓库，无法日结上传', 400)
    const result = dailyClose(db, req, {
      storeId: store.id,
      warehouseId: wh.id,
      storeName: store.name,
      bizDate: req.body?.biz_date || today(),
      operatorUid: u.uid ?? null,
      operatorName: u.name || null
    })
    audit(req, { action: 'DAILY_CLOSE', module: 'pos', entity: 'pos_daily_closes', entityId: result.closeId, detail: result.batchNo })
    return ok(res, result)
  })
)

r.get(
  '/daily-closes',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT dc.*, s.name AS store_name, w.name AS warehouse_name
         FROM pos_daily_closes dc
         JOIN stores s ON s.id=dc.store_id
         LEFT JOIN warehouses w ON w.id=dc.warehouse_id
         WHERE dc.store_id=? ORDER BY dc.id DESC LIMIT 50`
      )
      .all(store.id)
    return ok(res, rows)
  })
)

// ===========================================================================
// 七、门店退货
// ===========================================================================

r.post(
  '/returns',
  requireAuth,
  requireStore(),
  requirePerm('pos.refund'),
  wrap((req, res) => {
    const { db, store, u } = storeCtx(req)
    const result = storeReturn(db, req, {
      storeId: store.id,
      shiftId: req.body?.shift_id,
      items: req.body?.items || [],
      reason: req.body?.reason || null,
      returnDate: req.body?.return_date || null,
      refundMethod: req.body?.refund_method || CASH_METHOD,
      orderId: req.body?.order_id || null
    })
    audit(req, { action: 'CREATE', module: 'pos', entity: 'sales_returns', entityId: result.returnId, detail: result.docNo })
    return ok(res, { ...result, operator: u.name })
  })
)

r.get(
  '/returns',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM sales_return_items i WHERE i.return_id=t.id) AS item_count
           FROM sales_returns t WHERE t.store_id=? AND t.channel='store' ORDER BY t.id DESC LIMIT 100`
      )
      .all(store.id)
    return ok(res, rows)
  })
)

// ===========================================================================
// 八、门店盘点（复用 stock_checks，scope='store'）
// ===========================================================================

r.get(
  '/stock-checks',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT c.*, w.name AS warehouse_name,
                (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id=c.id) AS item_count,
                (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id=c.id AND ABS(i.diff_qty) > 0.0001) AS diff_count
           FROM stock_checks c LEFT JOIN warehouses w ON w.id=c.warehouse_id
          WHERE c.scope='store' AND c.store_id=? ORDER BY c.id DESC LIMIT 50`
      )
      .all(store.id)
    return ok(res, rows)
  })
)

r.get(
  '/stock-checks/:id',
  requireAuth,
  requireStore(),
  requirePerm('pos.view'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const head = db.prepare("SELECT * FROM stock_checks WHERE id=? AND scope='store' AND store_id=?").get(Number(req.params.id), store.id)
    if (!head) return fail(res, '盘点单不存在', 404)
    const items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.barcode, p.name AS product_name, p.unit
           FROM stock_check_items i
           JOIN product_skus sk ON sk.id=i.sku_id
           JOIN products p ON p.id=sk.product_id
          WHERE i.check_id=? ORDER BY i.id`
      )
      .all(head.id)
    return ok(res, { check: head, items })
  })
)

r.post(
  '/stock-checks',
  requireAuth,
  requireStore(),
  requirePerm('pos.store.check'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const result = createStoreCheck(db, req, {
      storeId: store.id,
      skuIds: req.body?.sku_ids || null,
      checker: req.body?.checker || null,
      remark: req.body?.remark || null,
      checkDate: req.body?.check_date || null
    })
    audit(req, { action: 'CREATE', module: 'pos', entity: 'stock_checks', entityId: result.id })
    return ok(res, result)
  })
)

r.put(
  '/stock-checks/:id/items',
  requireAuth,
  requireStore(),
  requirePerm('pos.store.check'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    const head = db.prepare("SELECT * FROM stock_checks WHERE id=? AND scope='store' AND store_id=?").get(id, store.id)
    if (!head) return fail(res, '盘点单不存在', 404)
    const result = submitStoreCheckItems(db, req, { checkId: id, items: req.body?.items || [] })
    return ok(res, result)
  })
)

r.post(
  '/stock-checks/:id/adjust',
  requireAuth,
  requireStore(),
  requirePerm('pos.store.check'),
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const id = Number(req.params.id)
    const head = db.prepare("SELECT * FROM stock_checks WHERE id=? AND scope='store' AND store_id=?").get(id, store.id)
    if (!head) return fail(res, '盘点单不存在', 404)
    const result = adjustStoreCheck(db, req, { checkId: id })
    audit(req, { action: 'ADJUST', module: 'pos', entity: 'stock_checks', entityId: id })
    return ok(res, result)
  })
)

// ===========================================================================
// 九、总部侧：门店 POS 运营监控 + 资金在途
// ===========================================================================

r.get(
  '/hq/overview',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    const stores = db
      .prepare(
        `SELECT s.*, w.id AS warehouse_id, w.name AS warehouse_name
         FROM stores s LEFT JOIN warehouses w ON w.store_id=s.id
         WHERE s.status='active' ORDER BY s.id`
      )
      .all()
    const bizDate = today()
    const list = stores.map((s) => {
      const local = db
        .prepare("SELECT COUNT(*) c FROM pos_orders WHERE store_id=? AND status='local'")
        .get(s.id).c
      const agg = db
        .prepare(
          `SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) amount FROM pos_orders
           WHERE store_id=? AND biz_date=? AND status IN ('local','synced')`
        )
        .get(s.id, bizDate)
      const lastClose = db
        .prepare(
          'SELECT batch_no, biz_date, net_amount, uploaded_orders, cash_variance, counted_cash, created_at FROM pos_daily_closes WHERE store_id=? ORDER BY id DESC LIMIT 1'
        )
        .get(s.id)
      const stockSkus = s.warehouse_id
        ? db
            .prepare('SELECT COUNT(DISTINCT sku_id) c FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand>0')
            .get(s.warehouse_id).c
        : 0
      const stockValue = s.warehouse_id
        ? db
            .prepare('SELECT COALESCE(SUM(qty_on_hand*cost_price),0) v FROM inventory_stocks WHERE warehouse_id=?')
            .get(s.warehouse_id).v
        : 0
      // 资金在途：已核款没缴的（to_drop）+ 已缴没收的（to_receive）+ 待核款班次数
      const inflight = cashInflight(db, { storeId: s.id })
      const toReceive = db
        .prepare(
          `SELECT COALESCE(SUM(d.amount),0) v, COUNT(*) c FROM pos_cash_drops d WHERE d.store_id=? AND d.status='pending'`
        )
        .get(s.id)
      const gate = dailyCloseGate(db, { storeId: s.id, bizDate })
      return {
        ...s,
        pos_local_orders: local,
        pos_today_orders: agg.c,
        pos_today_amount: agg.amount,
        last_close: lastClose,
        stock_skus: stockSkus,
        stock_value: stockValue,
        cash_to_drop: inflight.to_drop || 0,
        cash_variance_total: inflight.variance_total || 0,
        cash_pending_review: inflight.pending_review_count || 0,
        cash_open_shifts: inflight.open_count || 0,
        cash_to_receive: toReceive.v,
        cash_to_receive_count: toReceive.c,
        daily_close_blocked: !gate.ok,
        daily_close_block_reason: gate.ok ? null : gate.message
      }
    })
    const totals = list.reduce(
      (a, s) => {
        a.today_amount += Number(s.pos_today_amount || 0)
        a.today_orders += Number(s.pos_today_orders || 0)
        a.local_orders += Number(s.pos_local_orders || 0)
        a.cash_to_drop += Number(s.cash_to_drop || 0)
        a.cash_to_receive += Number(s.cash_to_receive || 0)
        a.cash_variance_total += Number(s.cash_variance_total || 0)
        return a
      },
      { today_amount: 0, today_orders: 0, local_orders: 0, cash_to_drop: 0, cash_to_receive: 0, cash_variance_total: 0 }
    )
    return ok(res, { stores: list, totals })
  })
)

/** 总部：资金在途汇总（视图口径，与门店看到的是同一个数） */
r.get(
  '/hq/cash-inflight',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    const rows = cashInflight(db, {})
    const drops = db
      .prepare(
        `SELECT d.*, s.name AS store_name,
                (SELECT COUNT(*) FROM pos_cash_drop_items i WHERE i.drop_id=d.id) AS shift_count
           FROM pos_cash_drops d LEFT JOIN stores s ON s.id=d.store_id
          WHERE d.status='pending' ORDER BY d.drop_date, d.id`
      )
      .all()
    const pendingVariance = db
      .prepare(
        `SELECT s.id, s.doc_no, s.store_id, st.name AS store_name, s.biz_date, s.cashier_name,
                s.variance, s.variance_note, s.counted_cash, s.approved_by_name, s.approved_at
           FROM pos_shifts s LEFT JOIN stores st ON st.id=s.store_id
          WHERE s.status='closed' AND s.variance_handled='pending'
          ORDER BY s.biz_date, s.id`
      )
      .all()
    return ok(res, {
      inflight: rows,
      pending_drops: drops,
      pending_variances: pendingVariance,
      variance_limit: getVarianceLimit(db),
      handle_types: HANDLE_TYPES
    })
  })
)

r.get(
  '/hq/daily-closes',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT dc.*, s.name AS store_name, s.city AS store_city, w.name AS warehouse_name
         FROM pos_daily_closes dc
         JOIN stores s ON s.id=dc.store_id
         LEFT JOIN warehouses w ON w.id=dc.warehouse_id
         ORDER BY dc.id DESC LIMIT 100`
      )
      .all()
    return ok(res, rows)
  })
)

// 总部确认日结（RC.confirm：uploaded → confirmed）
// 内核 `008_doc_kernel.cjs` 的 `ACTIONS.RC` 里**早就登记了这条边**（`confirm`，`pos.dailyclose`，非危险），
// 但后端从来没有对应路由 —— 门店侧 `POST /daily-close` 建单即 `uploaded`，总部只能看
// （`GET /hq/daily-closes`），**确认这一步没有入口** ⇒ 三库 10 / 40 / 10 张日结单全部停在 `uploaded`（实测）。
// 纯状态推进 + 留痕：谁确认的由内核写进 `doc_events.actor_id / actor_name`（不另造权限点、不动金额）。
r.post(
  '/daily-closes/:id/confirm',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = db.prepare('SELECT id, batch_no, status FROM pos_daily_closes WHERE id=?').get(id)
    if (!head) return fail(res, '日结单不存在', 404)
    // 非法来源态（含"确认过的再确认一次"）交给内核抛 `DocFlowError` ⇒ 409，不在这里再写一份判据。
    advanceStatus(db, req, {
      docType: 'RC',
      id,
      action: 'confirm',
      remark: `总部确认日结 ${head.batch_no || head.id}`
    })
    audit(req, { action: 'CONFIRM', module: 'pos', entity: 'pos_daily_closes', entityId: id, detail: head.batch_no })
    return ok(res, { id, status: 'confirmed' })
  })
)

r.get(
  '/hq/orders',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    const storeId = Number(req.query.store_id || 0)
    const where = storeId ? 'po.store_id=?' : '1=1'
    const rows = db
      .prepare(
        `SELECT po.*, s.name AS store_name, sh.doc_no AS shift_no
         FROM pos_orders po
         JOIN stores s ON s.id=po.store_id
         LEFT JOIN pos_shifts sh ON sh.id=po.shift_id
         WHERE ${where} ORDER BY po.id DESC LIMIT 100`
      )
      .all(...(storeId ? [storeId] : []))
    const closeStmt = db.prepare('SELECT hq_sales_order_ids FROM pos_daily_closes WHERE batch_no=?')
    for (const po of rows) {
      po.hq_sales_order_ids = null
      if (po.sync_batch) {
        const c = closeStmt.get(po.sync_batch)
        if (c) po.hq_sales_order_ids = c.hq_sales_order_ids
      }
    }
    return ok(res, rows)
  })
)

/** 总部：全部班次（核款 / 长短款查看） */
r.get(
  '/hq/shifts',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    return ok(
      res,
      listShifts(db, {
        storeId: req.query.store_id || null,
        bizDate: req.query.biz_date || null,
        status: req.query.status || null,
        from: req.query.from || null,
        to: req.query.to || null,
        limit: Number(req.query.limit || 200)
      })
    )
  })
)

/** 总部：单班次详情（含支付方式差异明细，用于核款复核） */
r.get(
  '/hq/shifts/:id',
  requireAuth,
  requireRole(...HQ_ROLES),
  wrap((req, res) => {
    const db = getDb()
    return ok(res, shiftDetail(db, Number(req.params.id)))
  })
)

export default r
