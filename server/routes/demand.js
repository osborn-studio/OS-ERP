/**
 * ============================================================================
 * 文件标识：server/routes/demand.js ｜ 需求路由：门店要货、经销商要货与计划、净需求汇总
 * ============================================================================
 * 【职责】需求路由：门店要货、经销商要货与计划、净需求汇总
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
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requireRole, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { nextDocNo } from '../lib/docno.js'
import { advanceStatus, tryTransition, nowText, logEvent, allowedActions } from '../lib/docflow.js'

// ==================================================================
// 经销商要货申请与要货计划
//   经销商提交申请 / 填报滚动月度计划 → 总部按时间段汇总 → 对比仓库实际库存
//   → 形成净需求 → 分流生成 采购订单 / 生产订单 / 委外订单
// ==================================================================
const r = Router()
const HQ = ['sales', 'purchase', 'warehouse', 'scm', 'admin', 'finance']
const DR_STATUS = { submitted: '待受理', approved: '已确认', converted: '已转单', rejected: '已驳回', cancelled: '已取消' }
const PROCURE_LABEL = { buy: '外购', self: '自制生产', outsource: '委外加工' }

function dealerCtx(req) {
  const db = getDb()
  const u = req.user || {}
  if (!u.dealer_id) throw Object.assign(new Error('当前账号未绑定经销商'), { status: 403 })
  const dealer = db.prepare('SELECT * FROM dealers WHERE id=?').get(u.dealer_id)
  if (!dealer) throw Object.assign(new Error('经销商不存在'), { status: 404 })
  return { db, dealer, u }
}

function requireDealer() {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next()
    if (req.user.role !== 'dealer') return fail(res, '仅经销商账号可提交要货申请', 403, 403)
    if (!req.user.dealer_id) return fail(res, '当前账号未绑定经销商', 403, 403)
    next()
  }
}

function defaultCentralWarehouse(db) {
  return db
    .prepare("SELECT * FROM warehouses WHERE type IN ('central','region') AND status='active' ORDER BY CASE type WHEN 'central' THEN 0 ELSE 1 END, id LIMIT 1")
    .get()
}

function monthsBetween(start, end) {
  const out = []
  const s = new Date(`${start}T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  const cur = new Date(s.getFullYear(), s.getMonth(), 1)
  while (cur <= e && out.length < 36) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  return out
}

function loadRequisition(db, id) {
  const head = db
    .prepare(
      `SELECT dr.*, d.name AS dealer_name, d.code AS dealer_code, d.level, d.region, d.city
       FROM dealer_requisitions dr JOIN dealers d ON d.id=dr.dealer_id WHERE dr.id=?`
    )
    .get(id)
  if (!head) return null
  head.status_name = DR_STATUS[head.status] || head.status
  head.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, p.unit
       FROM dealer_requisition_items i
       JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
       WHERE i.requisition_id=? ORDER BY i.id`
    )
    .all(id)
  return head
}

// ===================== 经销商端 =====================

// 提交要货申请
r.post(
  '/dealer/requisitions',
  requireAuth,
  requireDealer(),
  wrap((req, res) => {
    const { db, dealer, u } = dealerCtx(req)
    const { items = [], expect_date, remark } = req.body || {}
    if (!Array.isArray(items) || !items.length) return fail(res, '请至少添加一行要货商品')
    const lines = []
    let tq = 0
    let ta = 0
    for (const it of items) {
      const sku = db
        .prepare('SELECT s.*, p.name AS product_name, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
        .get(Number(it.sku_id))
      if (!sku) return fail(res, `SKU#${it.sku_id} 不存在`)
      const qty = Number(it.qty)
      if (!(qty > 0)) return fail(res, '要货数量必须大于 0')
      const price = Number(it.price ?? sku.price_dealer ?? 0)
      tq += qty
      ta += qty * price
      lines.push({ sku_id: sku.id, qty, price })
    }
    const today = localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'DR', 'dealer_requisitions', 'doc_no', today)
      const info = db
        .prepare(
          `INSERT INTO dealer_requisitions (doc_no,dealer_id,req_date,expect_date,applicant,status,total_qty,total_amount,remark,created_by)
           VALUES (?,?,?,?,?, 'submitted',?,?,?,?)`
        )
        .run(docNo, dealer.id, today, expect_date || null, u.name || dealer.contact || null, tq, Number(ta.toFixed(2)), remark || null, u.uid || null)
      const rid = info.lastInsertRowid
      const ins = db.prepare('INSERT INTO dealer_requisition_items (requisition_id,sku_id,qty,price,amount) VALUES (?,?,?,?,?)')
      for (const l of lines) ins.run(rid, l.sku_id, l.qty, l.price, Number((l.qty * l.price).toFixed(2)))
      return { id: rid, docNo }
    })()
    audit(req, { action: 'CREATE', module: 'demand', entity: 'dealer_requisitions', entityId: result.id, detail: result.docNo })
    return ok(res, { id: result.id, doc_no: result.docNo })
  })
)

// 我的要货申请
r.get(
  '/dealer/requisitions/mine',
  requireAuth,
  wrap((req, res) => {
    const { db, dealer } = dealerCtx(req)
    const rows = db
      .prepare(
        `SELECT dr.*, (SELECT COUNT(*) FROM dealer_requisition_items i WHERE i.requisition_id=dr.id) AS item_count
         FROM dealer_requisitions dr WHERE dr.dealer_id=? ORDER BY dr.id DESC LIMIT 100`
      )
      .all(dealer.id)
      .map((x) => ({ ...x, status_name: DR_STATUS[x.status] || x.status }))
    return ok(res, rows)
  })
)

// 我的要货计划
r.get(
  '/dealer/plans/mine',
  requireAuth,
  wrap((req, res) => {
    const { db, dealer } = dealerCtx(req)
    const period = req.query.period
    const conds = ['pl.dealer_id=?']
    const params = [dealer.id]
    if (period) {
      conds.push('pl.period=?')
      params.push(period)
    }
    const rows = db
      .prepare(
        `SELECT pl.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name, p.unit
         FROM dealer_requisition_plans pl
         JOIN product_skus sk ON sk.id=pl.sku_id JOIN products p ON p.id=sk.product_id
         WHERE ${conds.join(' AND ')} ORDER BY pl.period DESC, pl.id LIMIT 500`
      )
      .all(...params)
    return ok(res, rows)
  })
)

// 提交/更新要货计划（按 期间+SKU upsert）
r.post(
  '/dealer/plans',
  requireAuth,
  requireDealer(),
  wrap((req, res) => {
    const { db, dealer } = dealerCtx(req)
    const { period, items = [] } = req.body || {}
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return fail(res, '计划期间格式应为 YYYY-MM')
    if (!Array.isArray(items) || !items.length) return fail(res, '请至少填写一行计划')
    const result = db.transaction(() => {
      const up = db.prepare(
        `INSERT INTO dealer_requisition_plans (dealer_id,period,sku_id,plan_qty,plan_amount,status)
         VALUES (?,?,?,?,?, 'forecast')
         ON CONFLICT(dealer_id,period,sku_id) DO UPDATE SET plan_qty=excluded.plan_qty, plan_amount=excluded.plan_amount`
      )
      let n = 0
      for (const it of items) {
        const qty = Number(it.plan_qty)
        if (!(qty > 0)) continue
        const sku = db.prepare('SELECT s.*, p.name AS product_name FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(Number(it.sku_id))
        if (!sku) continue
        const price = Number(it.price ?? sku.price_dealer ?? 0)
        up.run(dealer.id, period, sku.id, qty, Number((qty * price).toFixed(2)))
        n++
      }
      return n
    })()
    audit(req, { action: 'PLAN_SUBMIT', module: 'demand', entity: 'dealer_requisition_plans', detail: `${period} × ${result}` })
    return ok(res, { period, saved: result })
  })
)

// ===================== 总部端 =====================

// 要货申请列表
r.get(
  '/dealer/requisitions',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.status) {
      conds.push('dr.status=?')
      params.push(req.query.status)
    }
    if (req.query.dealer_id) {
      conds.push('dr.dealer_id=?')
      params.push(Number(req.query.dealer_id))
    }
    if (req.query.startDate) {
      conds.push('dr.req_date>=?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('dr.req_date<=?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(dr.doc_no LIKE ? OR d.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'dealer_requisitions dr JOIN dealers d ON d.id=dr.dealer_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT dr.*, d.name AS dealer_name, d.code AS dealer_code, d.level, d.region,
                (SELECT COUNT(*) FROM dealer_requisition_items i WHERE i.requisition_id=dr.id) AS item_count
         FROM ${FROM} ${where} ORDER BY dr.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
      .map((x) => ({ ...x, status_name: DR_STATUS[x.status] || x.status }))
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/dealer/requisitions/:id',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const head = loadRequisition(db, Number(req.params.id))
    if (!head) return fail(res, '要货申请不存在', 404)
    return ok(res, head)
  })
)

r.post(
  '/dealer/requisitions/:id/status',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM dealer_requisitions WHERE id=?').get(id)
    if (!head) return fail(res, '要货申请不存在', 404)
    const status = req.body?.status
    if (!status) return fail(res, '请指定要推进到的状态 status')
    // 允许集**从内核派生**（唯一出处：内核 `doc_actions`，经 `allowedActions('DR', 当前状态)`）。
    // 本文件不再手写状态清单 —— 那份手写集与内核**漂移过一次**：它多出 `cancelled`，
    // 而内核里当时根本没有这个状态，于是这条分支只能裸 UPDATE，写出一张**内核看不见的单**
    // （`allowedActions('DR','cancelled')` 返回空、不进任何按内核状态的统计）。
    // ⇒ 判据要写"这个状态能不能做这个动作"，而不是"允许哪些状态值"。
    //   `cancelled` 现已在内核登记（`STATES.DR` + `cancel` 边），所以下面走的是同一条内核入口。
    const acts = allowedActions(db, 'DR', head.status)
    const edge = acts.find((a) => a.to === status)
    if (!edge) {
      return fail(
        res,
        acts.length
          ? `当前状态「${head.status}」不能推进到「${status}」；可推进到：${acts.map((a) => `${a.to}（${a.actionName}）`).join(' / ')}`
          : `当前状态「${head.status}」是终态，不能继续流转`,
        409
      )
    }
    // 走内核：**边校验 + 状态更新 + 留痕在同一个事务里**（原来对 `cancelled` 是裸 UPDATE + 手工 logEvent ——
    // 两条各自成事务的语句，`logEvent` 失败时状态已改而痕丢了：与"留痕须与改动同生共死"只满足了一半）。
    advanceStatus(db, req, {
      docType: 'DR',
      id,
      action: edge.action,
      set: { updated_at: nowText() },
      remark: req.body?.reason || null
    })
    audit(req, { action: 'STATUS', module: 'demand', entity: 'dealer_requisitions', entityId: id, detail: status })
    return ok(res, loadRequisition(db, id))
  })
)

// 要货计划汇总（总部，按期间）
r.get(
  '/dealer/plans',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const conds = []
    const params = []
    if (req.query.period) {
      conds.push('pl.period=?')
      params.push(req.query.period)
    }
    if (req.query.dealer_id) {
      conds.push('pl.dealer_id=?')
      params.push(Number(req.query.dealer_id))
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const byDealer = db
      .prepare(
        `SELECT d.id AS dealer_id, d.name AS dealer_name, d.region, pl.period,
                COUNT(pl.id) sku_lines, COALESCE(SUM(pl.plan_qty),0) plan_qty, COALESCE(SUM(pl.plan_amount),0) plan_amount
         FROM dealer_requisition_plans pl JOIN dealers d ON d.id=pl.dealer_id ${where}
         GROUP BY pl.dealer_id, pl.period ORDER BY pl.period DESC, plan_amount DESC`
      )
      .all(...params)
    const rows = db
      .prepare(
        `SELECT pl.*, d.name AS dealer_name, sk.sku_code, sk.name AS sku_name, p.name AS product_name
         FROM dealer_requisition_plans pl
         JOIN dealers d ON d.id=pl.dealer_id
         JOIN product_skus sk ON sk.id=pl.sku_id JOIN products p ON p.id=sk.product_id
         ${where} ORDER BY pl.period DESC, pl.plan_qty DESC LIMIT 500`
      )
      .all(...params)
    const periods = db.prepare('SELECT DISTINCT period FROM dealer_requisition_plans ORDER BY period DESC').all().map((x) => x.period)
    return ok(res, { byDealer, rows, periods })
  })
)

// ---------- 时间段汇总 → 净需求分析（不落库） ----------
r.post(
  '/dealer/summary',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const startDate = req.body?.startDate
    const endDate = req.body?.endDate
    if (!startDate || !endDate) return fail(res, '请选择汇总时间段（开始/结束日期）')
    const wh = req.body?.warehouse_id
      ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(req.body.warehouse_id))
      : defaultCentralWarehouse(db)
    const includePlans = req.body?.include_plans !== false
    const includeRequests = req.body?.include_requests !== false
    const months = monthsBetween(startDate, endDate)

    // 需求来源一：期间内的要货申请
    const reqRows = includeRequests
      ? db
          .prepare(
            `SELECT i.sku_id, SUM(i.qty) qty, SUM(i.amount) amount, COUNT(DISTINCT dr.dealer_id) dealers
             FROM dealer_requisition_items i JOIN dealer_requisitions dr ON dr.id=i.requisition_id
             WHERE dr.req_date BETWEEN ? AND ? AND dr.status IN ('submitted','approved')
             GROUP BY i.sku_id`
          )
          .all(startDate, endDate)
      : []
    // 需求来源二：期间覆盖月份的要货计划
    const planRows = includePlans && months.length
      ? db
          .prepare(
            `SELECT sku_id, SUM(plan_qty) qty, SUM(plan_amount) amount, COUNT(DISTINCT dealer_id) dealers
             FROM dealer_requisition_plans WHERE period IN (${months.map(() => '?').join(',')})
             GROUP BY sku_id`
          )
          .all(...months)
      : []

    const map = new Map()
    const put = (row, kind) => {
      const cur = map.get(row.sku_id) || { sku_id: row.sku_id, req_qty: 0, plan_qty: 0, amount: 0, dealers: 0 }
      if (kind === 'req') cur.req_qty += Number(row.qty || 0)
      else cur.plan_qty += Number(row.qty || 0)
      cur.amount += Number(row.amount || 0)
      cur.dealers = Math.max(cur.dealers, Number(row.dealers || 0))
      map.set(row.sku_id, cur)
    }
    reqRows.forEach((x) => put(x, 'req'))
    planRows.forEach((x) => put(x, 'plan'))

    const skuIds = [...map.keys()]
    const bySku = []
    if (skuIds.length) {
      const skus = db
        .prepare(
          `SELECT s.id, s.sku_code, s.name AS sku_name, s.spec, s.safe_stock, s.min_stock, s.price_dealer,
                  p.name AS product_name, p.unit, p.procurement_type, p.cost_std
           FROM product_skus s JOIN products p ON p.id=s.product_id
           WHERE s.id IN (${skuIds.map(() => '?').join(',')})`
        )
        .all(...skuIds)
      for (const sku of skus) {
        const d = map.get(sku.id)
        const demand = Number((d.req_qty + d.plan_qty).toFixed(2))
        const stock = wh
          ? db
              .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
              .get(wh.id, sku.id).a
          : 0
        const inTransit = db
          .prepare(
            `SELECT COALESCE(SUM(i.qty - i.received_qty),0) q
             FROM purchase_order_items i JOIN purchase_orders o ON o.id=i.order_id
             WHERE i.sku_id=? AND o.status IN ('submitted','approved') AND o.fulfill_type='hq'`
          )
          .get(sku.id).q
        const net = Math.max(0, Number((demand - stock - inTransit).toFixed(2)))
        bySku.push({
          sku_id: sku.id,
          sku_code: sku.sku_code,
          sku_name: sku.sku_name,
          product_name: sku.product_name,
          spec: sku.spec,
          unit: sku.unit,
          req_qty: Number(d.req_qty.toFixed(2)),
          plan_qty: Number(d.plan_qty.toFixed(2)),
          demand_qty: demand,
          stock_available: stock,
          in_transit: inTransit,
          net_requirement: net,
          dealer_count: d.dealers,
          amount: Number(d.amount.toFixed(2)),
          procurement_type: sku.procurement_type || 'buy',
          procurement_label: PROCURE_LABEL[sku.procurement_type] || '外购',
          suggest_route: sku.procurement_type === 'self' ? 'production' : sku.procurement_type === 'outsource' ? 'outsourcing' : 'purchase'
        })
      }
      bySku.sort((a, b) => b.net_requirement - a.net_requirement)
    }

    // 按经销商汇总
    const byDealer = includeRequests
      ? db
          .prepare(
            `SELECT d.id AS dealer_id, d.name AS dealer_name, d.region, d.level,
                    COUNT(DISTINCT dr.id) req_count, COALESCE(SUM(dr.total_qty),0) req_qty, COALESCE(SUM(dr.total_amount),0) req_amount
             FROM dealer_requisitions dr JOIN dealers d ON d.id=dr.dealer_id
             WHERE dr.req_date BETWEEN ? AND ? AND dr.status IN ('submitted','approved')
             GROUP BY d.id ORDER BY req_amount DESC`
          )
          .all(startDate, endDate)
      : []

    const totals = bySku.reduce(
      (a, x) => {
        a.demand_qty += x.demand_qty
        a.net_requirement += x.net_requirement
        return a
      },
      { demand_qty: 0, net_requirement: 0 }
    )
    return ok(res, {
      startDate,
      endDate,
      months,
      warehouse: wh ? { id: wh.id, name: wh.name } : null,
      bySku,
      byDealer,
      totals: {
        sku_count: bySku.length,
        demand_qty: Number(totals.demand_qty.toFixed(2)),
        net_requirement: Number(totals.net_requirement.toFixed(2))
      }
    })
  })
)

// ---------- 净需求 → 生成 采购 / 生产 / 委外 订单 ----------
r.post(
  '/dealer/summary/to-orders',
  requireAuth,
  requireRole('purchase', 'warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { period_start, period_end, warehouse_id, lines = [] } = req.body || {}
    if (!period_start || !period_end) return fail(res, '缺少汇总期间')
    if (!Array.isArray(lines) || !lines.length) return fail(res, '请勾选要生成的净需求行')
    const hqWh = warehouse_id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(warehouse_id)) : defaultCentralWarehouse(db)
    if (!hqWh) return fail(res, '未找到入库仓库')
    const today = localDate()

    const summary = { purchase: [], production: [], outsourcing: [] }
    const skipped = []

    const tx = db.transaction(() => {
      // 1) 外购 → 采购订单（按供应商分组）
      const buyLines = lines.filter((l) => (l.route || 'purchase') === 'purchase' && Number(l.qty) > 0)
      const bySupplier = new Map()
      for (const l of buyLines) {
        const sid = Number(l.supplier_id || 0)
        if (!sid) {
          skipped.push({ sku_id: l.sku_id, reason: '外购行未指定供应商' })
          continue
        }
        if (!bySupplier.has(sid)) bySupplier.set(sid, [])
        bySupplier.get(sid).push(l)
      }
      for (const [sid, ls] of bySupplier) {
        const docNo = nextDocNo(db, 'PO', 'purchase_orders', 'doc_no', today)
        const poInfo = db
          .prepare(
            `INSERT INTO purchase_orders (doc_no,supplier_id,warehouse_id,order_date,buyer,status,total_qty,total_amount,tax_amount,fulfill_type,source_type,remark,created_by)
             VALUES (?,?,?,?,?, 'draft',0,0,0,'hq','dealer_summary',?,?)`
          )
          .run(docNo, sid, hqWh.id, today, u.name || null, `经销商要货净需求汇总 ${period_start}~${period_end}`, u.uid || null)
        const poId = poInfo.lastInsertRowid
        const insItem = db.prepare('INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount) VALUES (?,?,?,?,13,?)')
        let tq = 0
        let ta = 0
        for (const l of ls) {
          const sku = db.prepare('SELECT s.*, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(Number(l.sku_id))
          const price = Number(l.price ?? sku?.cost_std ?? sku?.p_cost ?? 0)
          insItem.run(poId, l.sku_id, Number(l.qty), price, Number((Number(l.qty) * price).toFixed(2)))
          tq += Number(l.qty)
          ta += Number(l.qty) * price
        }
        const tax = db.prepare('SELECT COALESCE(SUM(amount*tax_rate/100.0),0) t FROM purchase_order_items WHERE order_id=?').get(poId).t
        db.prepare('UPDATE purchase_orders SET total_qty=?, total_amount=?, tax_amount=? WHERE id=?').run(tq, Number(ta.toFixed(2)), Number(tax.toFixed(2)), poId)
        summary.purchase.push({ id: poId, doc_no: docNo, supplier_id: sid, lines: ls.length })
      }

      // 2) 自制 → 生产订单（每个成品一张）
      const selfLines = lines.filter((l) => l.route === 'production' && Number(l.qty) > 0)
      for (const l of selfLines) {
        const docNo = nextDocNo(db, 'MO', 'production_orders', 'doc_no', today)
        const sku = db.prepare('SELECT s.*, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(Number(l.sku_id))
        const unitCost = Number(l.price ?? sku?.cost_std ?? sku?.p_cost ?? 0)
        const qty = Number(l.qty)
        const info = db
          .prepare(
            `INSERT INTO production_orders (doc_no,product_sku_id,warehouse_id,plan_date,status,qty,unit_cost,material_cost,total_cost,source_type,remark,created_by)
             VALUES (?,?,?,?, 'draft',?,?,?,?,'plan',?,?)`
          )
          .run(docNo, l.sku_id, hqWh.id, today, qty, unitCost, Number((qty * unitCost * 0.6).toFixed(2)), Number((qty * unitCost).toFixed(2)),
            `经销商要货净需求汇总 ${period_start}~${period_end}`, u.uid || null)
        const moId = info.lastInsertRowid
        db.prepare("INSERT INTO production_order_items (order_id,role,sku_id,qty,unit_cost,amount) VALUES (?, 'product',?,?,?,?)")
          .run(moId, l.sku_id, qty, unitCost, Number((qty * unitCost).toFixed(2)))
        summary.production.push({ id: moId, doc_no: docNo, sku_id: l.sku_id, qty })
      }

      // 3) 委外 → 委外订单（合并为一张，指定加工商时有效）
      const outLines = lines.filter((l) => l.route === 'outsourcing' && Number(l.qty) > 0)
      if (outLines.length) {
        const supplierId = Number(req.body?.outsource_supplier_id || outLines[0].supplier_id || 0)
        if (!supplierId) {
          outLines.forEach((l) => skipped.push({ sku_id: l.sku_id, reason: '委外行未指定加工商' }))
        } else {
          const docNo = nextDocNo(db, 'WW', 'outsourcing_orders', 'doc_no', today)
          const info = db
            .prepare(
              `INSERT INTO outsourcing_orders (doc_no,supplier_id,warehouse_id,material_warehouse_id,order_date,buyer,status,out_type,process_fee,source_type,remark,created_by)
               VALUES (?,?,?,?,?,?, 'draft','normal',0,'plan',?,?)`
            )
            .run(docNo, supplierId, hqWh.id, hqWh.id, today, u.name || null, `经销商要货净需求汇总 ${period_start}~${period_end}`, u.uid || null)
          const oid = info.lastInsertRowid
          const insItem = db.prepare('INSERT INTO outsourcing_order_items (order_id,role,sku_id,qty,price,amount) VALUES (?,?,?,?,?,?)')
          let pq = 0
          let pa = 0
          for (const l of outLines) {
            const sku = db.prepare('SELECT s.*, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(Number(l.sku_id))
            const price = Number(l.price ?? sku?.cost_std ?? sku?.p_cost ?? 0)
            insItem.run(oid, 'product', l.sku_id, Number(l.qty), price, Number((Number(l.qty) * price).toFixed(2)))
            pq += Number(l.qty)
            pa += Number(l.qty) * price
          }
          db.prepare('UPDATE outsourcing_orders SET product_qty=?, product_amount=?, total_amount=? WHERE id=?').run(pq, Number(pa.toFixed(2)), Number(pa.toFixed(2)), oid)
          summary.outsourcing.push({ id: oid, doc_no: docNo, supplier_id: supplierId, lines: outLines.length })
        }
      }

      // 记录汇总运行
      const runNo = nextDocNo(db, 'DP', 'demand_plan_runs', 'doc_no', today)
      db.prepare(
        `INSERT INTO demand_plan_runs (doc_no,period_start,period_end,warehouse_id,rule,total_sku,total_demand,total_shortage,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        runNo, period_start, period_end, hqWh.id,
        JSON.stringify({ purchase: summary.purchase.length, production: summary.production.length, outsourcing: summary.outsourcing.length }),
        lines.length,
        Number(lines.reduce((s, l) => s + Number(l.qty || 0), 0).toFixed(2)),
        Number(lines.reduce((s, l) => s + Number(l.qty || 0), 0).toFixed(2)),
        u.uid || null
      )
      // 标记相关要货申请为已转单
      const drIds = db
        .prepare("SELECT DISTINCT id FROM dealer_requisitions WHERE req_date BETWEEN ? AND ? AND status IN ('submitted','approved')")
        .all(period_start, period_end)
      for (const row of drIds) {
        const nos = [...summary.purchase, ...summary.production, ...summary.outsourcing].map((x) => x.doc_no).join(',')
        advanceStatus(db, req, { docType: 'DR', id: row.id, action: 'convert', set: { linked_order_nos: nos }, remark: '净需求汇总后转单' })
      }
      return { runNo }
    })

    const out = tx()
    audit(req, { action: 'DEMAND_TO_ORDERS', module: 'demand', entity: 'demand_plan_runs', detail: out.runNo })
    return ok(res, { doc_no: out.runNo, summary, skipped })
  })
)

// 汇总运行记录
r.get(
  '/dealer/summary/runs',
  requireAuth,
  requireRole(...HQ),
  wrap((_req, res) => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM demand_plan_runs ORDER BY id DESC LIMIT 50').all()
    return ok(res, rows)
  })
)

// ===================== 生产订单 =====================
r.get(
  '/production/orders',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.status) {
      conds.push('po.status=?')
      params.push(req.query.status)
    }
    if (req.query.keyword) {
      conds.push('(po.doc_no LIKE ? OR sk.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `production_orders po JOIN product_skus sk ON sk.id=po.product_sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN warehouses w ON w.id=po.warehouse_id`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT po.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name
         FROM ${FROM} ${where} ORDER BY po.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/production/orders/:id',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const head = db
      .prepare(
        `SELECT po.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name
         FROM production_orders po JOIN product_skus sk ON sk.id=po.product_sku_id
         JOIN products p ON p.id=sk.product_id LEFT JOIN warehouses w ON w.id=po.warehouse_id WHERE po.id=?`
      )
      .get(Number(req.params.id))
    if (!head) return fail(res, '生产订单不存在', 404)
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name FROM production_order_items i JOIN product_skus sk ON sk.id=i.sku_id WHERE i.order_id=? ORDER BY i.id`
      )
      .all(head.id)
    return ok(res, head)
  })
)

r.post(
  '/production/orders',
  requireAuth,
  requireRole('purchase', 'warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { product_sku_id, warehouse_id, plan_date, expect_date, qty, unit_cost = 0, items = [], remark } = req.body || {}
    if (!product_sku_id || !warehouse_id) return fail(res, '请选择生产成品与入库仓')
    if (!(Number(qty) > 0)) return fail(res, '生产数量必须大于 0')
    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'MO', 'production_orders', 'doc_no', plan_date)
      const totalCost = Number((Number(qty) * Number(unit_cost)).toFixed(2))
      const info = db
        .prepare(
          `INSERT INTO production_orders (doc_no,product_sku_id,warehouse_id,plan_date,expect_date,status,qty,unit_cost,material_cost,total_cost,source_type,remark,created_by)
           VALUES (?,?,?,?,?, 'draft',?,?,?,?, 'manual',?,?)`
        )
        .run(docNo, product_sku_id, warehouse_id, plan_date, expect_date || null, Number(qty), Number(unit_cost), Number((totalCost * 0.6).toFixed(2)), totalCost, remark || null, u.uid || null)
      const oid = info.lastInsertRowid
      const ins = db.prepare('INSERT INTO production_order_items (order_id,role,sku_id,qty,unit_cost,amount) VALUES (?,?,?,?,?,?)')
      ins.run(oid, 'product', product_sku_id, Number(qty), Number(unit_cost), totalCost)
      for (const it of items) {
        if (!it.sku_id || !(Number(it.qty) > 0)) continue
        ins.run(oid, it.role || 'material', it.sku_id, Number(it.qty), Number(it.unit_cost || 0), Number((Number(it.qty) * Number(it.unit_cost || 0)).toFixed(2)))
      }
      return oid
    })
    const id = tx()
    audit(req, { action: 'CREATE', module: 'demand', entity: 'production_orders', entityId: id })
    return ok(res, { id })
  })
)

r.post(
  '/production/orders/:id/status',
  requireAuth,
  requireRole('purchase', 'warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const mo = db.prepare('SELECT * FROM production_orders WHERE id=?').get(id)
    if (!mo) return fail(res, '生产订单不存在', 404)
    // 流转规则已迁到单据内核（doc_actions），这里不再维护 flow 映射表
    const t = tryTransition({
      db,
      docType: 'MO',
      id,
      action: req.body?.action,
      remark: req.body?.remark,
      actor: { id: req.user.uid, name: req.user.name || req.user.username },
      source: 'api'
    })
    if (!t.ok) return bizFail(res, t.error)
    audit(req, { action: t.data.action.toUpperCase(), module: 'demand', entity: 'production_orders', entityId: id })
    return ok(res, { id, status: t.data.to })
  })
)

export default r
