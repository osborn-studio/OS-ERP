/**
 * ============================================================================
 * 文件标识：server/routes/order-center.js ｜ 订货中心（模块 12A）接口
 * ============================================================================
 * 【职责】订货中心（模块 12A）接口
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 订货中心（模块 12A）接口
//
// 统一承载门店要货与经销商订货 —— 订货方视角（下单、查单、对账）
// 与供货方视角（受理、审批、分仓、发货）都在这里，靠权限点与数据范围区分。
//
// 与 /api/requisitions（旧门店要货）的关系：
//   旧路由保留可用（存量单据与既有前端不中断），但新单一律走本路由的 oc_orders。
//   两边查的是不同的表，页面上不混显 —— 避免「同一件事两个列表，数字对不上」。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, attachOrgScope, permContext } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { DocFlowError, assertEdgePermitted } from '../lib/docflow.js'
import {
  OrderCenterError,
  getCustomer, customerTree, creditSnapshot,
  visibleSkus, quoteItems, checkOrder, decideApproval,
  createOrder, getOrder, transitionOrder,
  buildStatement, getStatement, settleStatement, confirmStatement,
  closeStatement, voidStatement,
  overview, pickWarehouse, customerWarehouseIds,
  selfCustomerId as ocSelfCustomerId, ocAccessCheck
} from '../lib/order-center.js'

const r = Router()

function handleCenterError(res, e) {
  if (e instanceof OrderCenterError || e instanceof DocFlowError) {
    return bizFail(res, e)
  }
  throw e
}

/**
 * 订货方自身绑定：经销商账号只能看到自己的单，门店店长只能看到本店的单。
 * 返回 { selfCustomerId | null }，null 表示不限（总部角色）。
 *
 * 实现已移到 `lib/order-center.js` 的 `selfCustomerId` —— 因为流转入口的越权检查
 * 也要用同一份判据，放在路由里只有路由能用，那边就会再写一遍。
 */
const selfCustomerId = (db, req) => ocSelfCustomerId(db, (req && req.user) || {})

function checkCustomerAccess(db, req, id) {
  const customer = getCustomer(db, Number(id))
  return ocAccessCheck(db, req, { customer_id: customer.id, org_id: customer.org_id })
}

// 列表、详情、试算与写入共用领域层的主体判据，避免只过滤列表却能按ID跨主体访问。
r.use(requireAuth, attachOrgScope, wrap((req, res, next) => {
  try {
    const db = getDb()
    for (const id of [req.query.customer_id, req.body?.customer_id]) {
      if (id == null || id === '') continue
      const access = checkCustomerAccess(db, req, id)
      if (!access.ok) return fail(res, access.message, access.status)
    }
    return next()
  } catch (e) { return handleCenterError(res, e) }
}))

r.param('id', (req, res, next, id) => {
  try {
    const db = getDb()
    const kind = req.route.path.split('/')[1]
    let access
    if (kind === 'customers') access = checkCustomerAccess(db, req, id)
    else if (kind === 'orders') access = ocAccessCheck(db, req, getOrder(db, Number(id)))
    else if (kind === 'statements') access = ocAccessCheck(db, req, getStatement(db, Number(id)))
    if (access && !access.ok) return fail(res, access.message, access.status)
    return next()
  } catch (e) { return handleCenterError(res, e) }
})

r.param('customerId', (req, res, next, id) => {
  try {
    const access = checkCustomerAccess(getDb(), req, id)
    return access.ok ? next() : fail(res, access.message, access.status)
  } catch (e) { return handleCenterError(res, e) }
})

/** 组织数据范围条件（订货单冗余了 org_id，可直接过滤） */
function scopeCond(db, req) {
  const self = selfCustomerId(db, req)
  if (self) return { sql: ' AND o.customer_id=? ', params: [self], self }
  const s = req.orgScope || { scope: 'all', orgIds: null }
  if (s.scope === 'all') return { sql: '', params: [], self: null }
  if (s.scope === 'none' || !s.orgIds || !s.orgIds.length) return { sql: ' AND 1=0 ', params: [], self: null }
  const ph = s.orgIds.map(() => '?').join(',')
  return { sql: ` AND (o.org_id IN (${ph}) OR o.org_id IS NULL) `, params: [...s.orgIds], self: null }
}

// ---------------------------------------------------------------------------
// 一、看板与业务流
// ---------------------------------------------------------------------------

r.get(
  '/overview',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    try {
      const db = getDb()
      const self = selfCustomerId(db, req)
      return ok(res, {
        ...overview(db, { customerIds: self ? [self] : null }),
        self: self ? getCustomer(db, self) : null,
        viewer: { role: req.user.role, name: req.user.name }
      })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.get(
  '/flow',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const flow = db.prepare('SELECT * FROM biz_flows WHERE code=?').get('FLOW_ORDER_CENTER')
    if (!flow) return fail(res, '订货中心业务流未登记', 404)
    const steps = db.prepare('SELECT * FROM biz_flow_steps WHERE flow_code=? ORDER BY seq').all('FLOW_ORDER_CENTER')
    const machine = {}
    for (const code of ['OC', 'OCS']) {
      machine[code] = {
        states: db.prepare('SELECT code,name,kind,is_initial,is_final FROM doc_states WHERE doc_type=? ORDER BY sort_order').all(code),
        edges: db.prepare('SELECT action,action_name,from_state,to_state,perm_code,is_danger FROM doc_actions WHERE doc_type=? ORDER BY sort_order').all(code)
      }
    }
    return ok(res, { flow: { ...flow, steps }, machine })
  })
)

r.get(
  '/policies',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const rules = db.prepare('SELECT * FROM oc_approval_rules ORDER BY priority, seq, id').all()
    const visibility = db.prepare('SELECT * FROM oc_visibility_rules ORDER BY priority, id').all()
    return ok(res, { approvalRules: rules, visibilityRules: visibility })
  })
)

// ---------------------------------------------------------------------------
// 二、订货主体（客户准入）
// ---------------------------------------------------------------------------

r.get(
  '/customers',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const kw = req.query.keyword ? `%${req.query.keyword}%` : null
    const conds = []
    const args = []
    if (kw) {
      conds.push('(c.name LIKE ? OR c.code LIKE ?)')
      args.push(kw, kw)
    }
    if (req.query.channel) {
      conds.push('c.channel=?')
      args.push(req.query.channel)
    }
    if (req.query.admit_status) {
      conds.push('c.admit_status=?')
      args.push(req.query.admit_status)
    }
    const self = selfCustomerId(db, req)
    if (self) {
      conds.push('c.id=?')
      args.push(self)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM oc_customers c ${where}`).get(...args).c
    const rows = db
      .prepare(
        `SELECT c.*,
                COALESCE(c.credit_limit, d.credit_limit, 0) AS limit_amount,
                COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0) AS used_amount,
                (SELECT COUNT(*) FROM oc_orders o WHERE o.customer_id=c.id) AS order_count,
                p.name AS parent_name
         FROM oc_customers c
         LEFT JOIN dealers d ON d.id=c.source_id AND c.source_type='dealer'
         LEFT JOIN oc_customers p ON p.id=c.parent_customer_id
         ${where} ORDER BY c.id LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, offset)
      .map((c) => ({
        ...c,
        credit_available: Number((Number(c.limit_amount) - Number(c.used_amount)).toFixed(2)),
        utilization: Number(c.limit_amount) > 0 ? Number((Number(c.used_amount) / Number(c.limit_amount)).toFixed(4)) : 0
      }))
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/customers/tree',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const self = selfCustomerId(db, req)
    if (self && req.query.root && Number(req.query.root) !== self) return fail(res, '无权查看其他订货方的客户树', 403)
    if (self) return ok(res, { ...getCustomer(db, self), children: [] })
    return ok(res, customerTree(db, req.query.root ? Number(req.query.root) : null))
  })
)

r.get(
  '/customers/:id',
  requireAuth,
  wrap((req, res) => {
    try {
      const db = getDb()
      const c = getCustomer(db, Number(req.params.id))
      return ok(res, {
        ...c,
        credit: creditSnapshot(db, c.id),
        addresses: db.prepare('SELECT * FROM oc_addresses WHERE customer_id=? ORDER BY is_default DESC, id').all(c.id),
        warehouses: customerWarehouseIds(db, c),
        creditLedger: db
          .prepare('SELECT * FROM oc_credit_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 50')
          .all(c.id),
        children: db.prepare('SELECT id,code,name,level,channel,admit_status FROM oc_customers WHERE parent_customer_id=?').all(c.id),
        orders: db
          .prepare('SELECT id,doc_no,order_date,status,total_amount FROM oc_orders WHERE customer_id=? ORDER BY id DESC LIMIT 20')
          .all(c.id)
      })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// 客户准入审批：pending → active，或冻结/解冻
r.post(
  '/customers/:id/admit',
  requireAuth,
  requirePerm('dms.dealer.approve'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const id = Number(req.params.id)
      const c = getCustomer(db, id)
      const { decision = 'approve', reason = null } = req.body || {}
      const map = {
        approve: { admit_status: 'active', frozen_reason: null },
        freeze: { admit_status: 'frozen', frozen_reason: reason },
        unfreeze: { admit_status: 'active', frozen_reason: null },
        reject: { admit_status: 'pending', frozen_reason: reason }
      }
      const patch = map[decision]
      if (!patch) return fail(res, 'decision 只能是 approve / freeze / unfreeze / reject')
      db.prepare(
        `UPDATE oc_customers SET admit_status=?, frozen_reason=?, admit_at=datetime('now','localtime'), admit_by=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(patch.admit_status, patch.frozen_reason, req.user.name || req.user.username, id)
      audit(req, { action: `CUSTOMER_${decision.toUpperCase()}`, module: 'order-center', entity: 'oc_customer', entityId: id, detail: c.name })
      return ok(res, getCustomer(db, id))
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// 设置交易条件（授信/账期/起订量）—— 只改订货中心侧，不动来源档案
r.put(
  '/customers/:id',
  requireAuth,
  requirePerm('master.price.edit', 'dms.dealer.edit'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const id = Number(req.params.id)
      getCustomer(db, id)
      const allow = [
        'level', 'channel', 'region', 'settle_type', 'credit_limit', 'credit_days',
        'price_level', 'discount_rate', 'min_order_qty', 'min_order_amount', 'salesman', 'parent_customer_id', 'remark'
      ]
      const sets = []
      const args = []
      for (const k of allow) {
        if (!(k in (req.body || {}))) continue
        sets.push(`${k}=?`)
        args.push(req.body[k])
      }
      if (!sets.length) return fail(res, '没有可更新的字段')
      sets.push("updated_at=datetime('now','localtime')")
      db.prepare(`UPDATE oc_customers SET ${sets.join(',')} WHERE id=?`).run(...args, id)
      audit(req, { action: 'CUSTOMER_UPDATE', module: 'order-center', entity: 'oc_customer', entityId: id, detail: Object.keys(req.body).join(',') })
      return ok(res, getCustomer(db, id))
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// ---------------------------------------------------------------------------
// 三、商品目录与试算
// ---------------------------------------------------------------------------

r.get(
  '/catalog',
  requireAuth,
  wrap((req, res) => {
    try {
      const db = getDb()
      const customerId = req.query.customer_id
        ? Number(req.query.customer_id)
        : selfCustomerId(db, req)
      if (!customerId) return fail(res, '需指定 customer_id（总部角色查看某客户视角时必须传）')
      const list = visibleSkus(db, customerId, {
        keyword: req.query.keyword || null,
        categoryId: req.query.category_id ? Number(req.query.category_id) : null,
        limit: Math.min(Number(req.query.pageSize || 50), 200),
        offset: Number(req.query.offset || 0)
      })
      return ok(res, { customer: getCustomer(db, customerId), list, total: list.length })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/quote',
  requireAuth,
  wrap((req, res) => {
    try {
      const db = getDb()
      const { customer_id, items = [], expect_date = null, evaluate = true } = req.body || {}
      const customerId = customer_id ? Number(customer_id) : selfCustomerId(db, req)
      if (!customerId) return fail(res, '需指定 customer_id')
      const quote = quoteItems(db, { customerId, items, expectDate: expect_date })
      if (!evaluate) return ok(res, quote)
      const check = checkOrder(db, { customerId, quote })
      const approval = decideApproval(db, { customerId, quote, check })
      const pick = pickWarehouse(db, { customerId, quote })
      return ok(res, { ...quote, check, approval, pick })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// ---------------------------------------------------------------------------
// 四、订货单
// ---------------------------------------------------------------------------

r.get(
  '/orders',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const s = scopeCond(db, req)
    const conds = [`1=1${s.sql}`]
    const args = [...s.params]
    if (req.query.status) {
      conds.push('o.status=?')
      args.push(req.query.status)
    }
    if (req.query.status_in) {
      const list = String(req.query.status_in).split(',').filter(Boolean)
      if (list.length) {
        conds.push(`o.status IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      }
    }
    if (req.query.keyword) {
      conds.push('(o.doc_no LIKE ? OR o.customer_name LIKE ?)')
      args.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    if (req.query.from) {
      conds.push('o.order_date>=?')
      args.push(req.query.from)
    }
    if (req.query.to) {
      conds.push('o.order_date<=?')
      args.push(req.query.to)
    }
    const where = `WHERE ${conds.join(' AND ')}`
    const total = db.prepare(`SELECT COUNT(*) c FROM oc_orders o ${where}`).get(...args).c
    const rows = db
      .prepare(
        `SELECT o.*,
                (SELECT COUNT(*) FROM oc_order_items i WHERE i.order_id=o.id) AS line_count,
                (SELECT COUNT(*) FROM oc_order_approvals a WHERE a.order_id=o.id AND a.decision='pending') AS pending_nodes
         FROM oc_orders o ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, offset)
    const byStatus = db
      .prepare(`SELECT o.status, COUNT(*) c FROM oc_orders o ${where} GROUP BY o.status`)
      .all(...args)
    return paged(res, { rows, total, page, pageSize, byStatus })
  })
)

r.get(
  '/orders/:id',
  requireAuth,
  wrap((req, res) => {
    try {
      const order = getOrder(getDb(), Number(req.params.id))
      return ok(res, order)
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/orders',
  requireAuth,
  requirePerm('order.place'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const { customer_id, items = [], expect_date = null, remark = null, source = 'web', auto_submit = true } = req.body || {}
      const customerId = customer_id ? Number(customer_id) : selfCustomerId(db, req)
      if (!customerId) return fail(res, '需指定 customer_id')
      if (!Array.isArray(items) || !items.length) return fail(res, '请至少添加一行订货商品')
      const result = createOrder(db, {
        customerId, items, expectDate: expect_date, remark, source,
        actor: { id: req.user.uid, name: req.user.name || req.user.username },
        autoSubmit: auto_submit !== false
      })
      audit(req, {
        action: 'ORDER_CREATE', module: 'order-center', entity: 'oc_order',
        entityId: result.order.id, detail: `${result.order.doc_no} ${result.order.total_amount}`
      })
      return ok(res, result)
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

/** 历史订单复制 / 常购清单：把某张历史单的行搬成购物车草稿（不落库） */
r.get(
  '/orders/:id/repeat',
  requireAuth,
  wrap((req, res) => {
    try {
      const db = getDb()
      const o = getOrder(db, Number(req.params.id))
      return ok(res, {
        customer_id: o.customer_id,
        items: o.items.map((i) => ({ sku_id: i.sku_id, qty: i.qty })),
        source_ref: o.doc_no
      })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.get(
  '/orders/:id/actions',
  requireAuth,
  wrap((req, res) => {
    try {
      const o = getOrder(getDb(), Number(req.params.id))
      return ok(res, o.actions)
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

/** 统一流转：submit / approve / reject / allocate / ship / receive / complete / cancel */
r.post(
  '/orders/:id/:action',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    try {
      const db = getDb()
      const id = Number(req.params.id)
      const action = String(req.params.action)

      // 越权与权限两道门（A01：这条路由原来只有 requireAuth）
      //   ① 单据级：这张单是不是"我的"（订货中心域自己的口径，与列表 scopeCond 同源）
      //   ② 功能权限：这一次动作的 perm_code（唯一判据 assertEdgePermitted，与通用入口共用）
      const row = db.prepare('SELECT * FROM oc_orders WHERE id=?').get(id)
      const access = ocAccessCheck(db, req, row)
      if (!access.ok) return fail(res, access.message, access.status)
      assertEdgePermitted({
        db,
        docType: 'OC',
        fromState: row.status,
        action,
        permCtx: permContext(db, req.user),
        entry: `${req.baseUrl}${req.path}`
      })

      const { remark = null, warehouse_id = null, expect_from = null } = req.body || {}
      const result = transitionOrder(db, {
        id, action,
        actor: { id: req.user.uid, name: req.user.name || req.user.username },
        remark, source: req.user.role === 'mcp' ? 'mcp' : 'api',
        warehouseId: warehouse_id ? Number(warehouse_id) : null,
        expectFrom: expect_from || null
      })
      audit(req, { action: `ORDER_${action.toUpperCase()}`, module: 'order-center', entity: 'oc_order', entityId: id, detail: remark })
      return ok(res, { transition: result, order: getOrder(db, id) })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// ---------------------------------------------------------------------------
// 五、授信
// ---------------------------------------------------------------------------

r.get(
  '/credit/:customerId',
  requireAuth,
  wrap((req, res) => {
    try {
      const db = getDb()
      const id = Number(req.params.customerId)
      return ok(res, {
        customer: getCustomer(db, id),
        credit: creditSnapshot(db, id),
        ledger: db.prepare('SELECT * FROM oc_credit_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 200').all(id),
        openOrders: db
          .prepare(
            `SELECT id,doc_no,order_date,status,total_amount,credit_hold FROM oc_orders
             WHERE customer_id=? AND status NOT IN ('cancelled','rejected','completed') ORDER BY id DESC`
          )
          .all(id)
      })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// ---------------------------------------------------------------------------
// 六、对账
// ---------------------------------------------------------------------------

r.get(
  '/statements',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const self = selfCustomerId(db, req)
    const conds = ['1=1']
    const args = []
    if (self) {
      conds.push('s.customer_id=?')
      args.push(self)
    }
    if (req.query.customer_id) {
      conds.push('s.customer_id=?')
      args.push(Number(req.query.customer_id))
    }
    if (req.query.status) {
      conds.push('s.status=?')
      args.push(req.query.status)
    }
    const where = `WHERE ${conds.join(' AND ')}`
    const total = db.prepare(`SELECT COUNT(*) c FROM oc_statements s ${where}`).get(...args).c
    const rows = db.prepare(`SELECT s.* FROM oc_statements s ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/statements/:id',
  requireAuth,
  wrap((req, res) => {
    try {
      return ok(res, getStatement(getDb(), Number(req.params.id)))
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/statements',
  requireAuth,
  requirePerm('order.statement.view'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const { customer_id, period_start, period_end, remark = null } = req.body || {}
      if (!customer_id || !period_start || !period_end) return fail(res, 'customer_id / period_start / period_end 必填')
      const s = buildStatement(db, {
        customerId: Number(customer_id), periodStart: period_start, periodEnd: period_end, remark,
        actor: { id: req.user.uid, name: req.user.name || req.user.username }
      })
      audit(req, { action: 'STATEMENT_CREATE', module: 'order-center', entity: 'oc_statement', entityId: s.id, detail: s.doc_no })
      return ok(res, s)
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/statements/:id/confirm',
  requireAuth,
  requirePerm('order.statement.view'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const r2 = confirmStatement(db, {
        id: Number(req.params.id), remark: req.body?.remark || null,
        actor: { id: req.user.uid, name: req.user.name || req.user.username }
      })
      return ok(res, { transition: r2, statement: getStatement(db, Number(req.params.id)) })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/statements/:id/settle',
  requireAuth,
  requirePerm('finance.settle.edit'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const s = settleStatement(db, {
        id: Number(req.params.id), amount: req.body?.amount,
        remark: req.body?.remark || null,
        actor: { id: req.user.uid, name: req.user.name || req.user.username }
      })
      audit(req, { action: 'STATEMENT_SETTLE', module: 'order-center', entity: 'oc_statement', entityId: s.id, detail: `回款 ${req.body?.amount}` })
      return ok(res, s)
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

// ---------- 对账单的两个终局动作：结清 / 作废 ----------
// 前端（`src/pages/order-center/OrderCenter.tsx` 的「对账」页签）**早就在渲染这两个按钮**
// —— 按钮来自 `getStatement().actions`，那是内核 `allowedActions('OCS', status)` 的动态结果，
// 而内核里 `close` / `void` 两条边本来就有 ⇒ **按钮在、后端没有路由 ⇒ 点了必然 404**。
// 这正是 `OrderCenter.tsx` 顶部注释里记着的那类真事故（"接口存在、契约里有、前端在调，
// 却永远 404"的镜像：这次是"前端有钮、后端没门"）。本组端点把那个 404 补上。
//
// ⚠️ 作废**只作废这份对账单凭证**，不动底层台账：`oc_orders` / `oc_credit_ledger` /
//    `oc_statement_items` 分毫不动。客户不认这份对账单 ≠ 客户不用还钱 ——
//    债权在订货单与授信台账上，照样在。这句话同时写在 `lib/order-center.js` 的
//    本节开头与 openapi 的 summary 里。
//
// ⚠️ `close` / `void` 是**独立字面段**，不是 `:action` 参数段：写成 `:action`
//    会被 `check-route-order.mjs` 判为"字面段被参数段吃掉"。
r.post(
  '/statements/:id/close',
  requireAuth,
  // 与内核 OCS 的 close 边 perm_code **同一个权限点**（避免"路由放行、内核拒绝"的错位）。
  requirePerm('finance.settle.edit'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const s = closeStatement(db, {
        id: Number(req.params.id),
        reason: req.body?.reason || null,
        force: req.body?.force === true || req.body?.force === '1',
        actor: { id: req.user.uid, name: req.user.name || req.user.username }
      })
      audit(req, {
        action: 'STATEMENT_CLOSE',
        module: 'order-center',
        entity: 'oc_statement',
        entityId: s.id,
        detail: `未收差额 ${s.diff_amount}${req.body?.reason ? '｜' + req.body.reason : ''}`
      })
      // 与 `/confirm` 同一返回形状：前端 `act()` 读 `r.data.statement || r.data`。
      return ok(res, { statement: s, transition: 'close' })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

r.post(
  '/statements/:id/void',
  requireAuth,
  // 与内核 OCS 的 void 边 perm_code 一致（`order.statement.view`，既有设计）。
  requirePerm('order.statement.view'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const s = voidStatement(db, {
        id: Number(req.params.id),
        reason: req.body?.reason || null,
        actor: { id: req.user.uid, name: req.user.name || req.user.username }
      })
      audit(req, { action: 'STATEMENT_VOID', module: 'order-center', entity: 'oc_statement', entityId: s.id, detail: req.body?.reason || '' })
      return ok(res, { statement: s, transition: 'void' })
    } catch (e) {
      return handleCenterError(res, e)
    }
  })
)

export default r
