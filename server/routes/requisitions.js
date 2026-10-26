/**
 * ============================================================================
 * 文件标识：server/routes/requisitions.js ｜ 请购与要货路由（补充层）：把门店/经销商的需求转成采购或生产
 * ============================================================================
 * 【职责】请购与要货路由（补充层）：把门店/经销商的需求转成采购或生产
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
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole, currentUser } from '../middleware/auth.js'
import { boundStoreId } from '../lib/store-binding.js'
import { audit } from '../middleware/audit.js'
import { nextDocNo } from '../lib/docno.js'
import { advanceStatus, tryTransition, nowText, logEvent, allowedActions } from '../lib/docflow.js'
import { applyStockIn, applyStockOut, pickBatches } from '../lib/stock.js'

const r = Router()
const HQ = ['purchase', 'warehouse', 'sales', 'scm', 'admin', 'finance']

const REQ_STATUS = {
  submitted: '待受理',
  processing: '处理中',
  shipped: '已发货',
  partial: '部分收货',
  received: '已收货',
  transferred: '已转采购',
  allocated: '已配货',
  completed: '已完成',
  rejected: '已驳回',
  cancelled: '已取消'
}

// 门店发货单状态
const SHIP_STATUS = {
  draft: '待发货',
  shipped: '已发货',
  partial: '部分收货',
  received: '已收货',
  closed: '已关闭',
  cancelled: '已取消'
}

// ---------- 工具 ----------
function storeCtx(req) {
  const db = getDb()
  const u = req.user || {}
  const storeId = boundStoreId(u)
  if (storeId == null) throw Object.assign(new Error('当前账号未绑定门店'), { status: 403 })
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId)
  if (!store) throw Object.assign(new Error('门店不存在'), { status: 404 })
  const wh = db
    .prepare("SELECT * FROM warehouses WHERE store_id=? AND status='active' ORDER BY id LIMIT 1")
    .get(store.id)
  return { db, store, wh, u }
}

function requireStore() {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next()
    if (req.user.role !== 'store') return fail(res, '仅门店账号可提交要货申请', 403, 403)
    if (!req.user.store_id) return fail(res, '当前账号未绑定门店', 403, 403)
    next()
  }
}

function defaultCentralWarehouse(db) {
  return db
    .prepare("SELECT * FROM warehouses WHERE type IN ('central','region') AND status='active' ORDER BY CASE type WHEN 'central' THEN 0 ELSE 1 END, id LIMIT 1")
    .get()
}

function storeWarehouse(db, storeId) {
  return db.prepare("SELECT * FROM warehouses WHERE store_id=? AND status='active' ORDER BY id LIMIT 1").get(storeId)
}

function loadRequisition(db, id) {
  const head = db
    .prepare(
      `SELECT sr.*, s.name AS store_name, s.code AS store_code, s.city AS store_city, w.name AS warehouse_name
       FROM store_requisitions sr
       JOIN stores s ON s.id=sr.store_id
       LEFT JOIN warehouses w ON w.id=sr.store_warehouse_id
       WHERE sr.id=?`
    )
    .get(id)
  if (!head) return null
  head.status_name = REQ_STATUS[head.status] || head.status
  head.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, p.name AS product_name, p.unit, b.name AS brand_name
       FROM store_requisition_items i
       JOIN product_skus sk ON sk.id=i.sku_id
       JOIN products p ON p.id=sk.product_id
       LEFT JOIN brands b ON b.id=p.brand_id
       WHERE i.requisition_id=? ORDER BY i.id`
    )
    .all(id)
  // 总部可用库存（中心仓可用量）与门店现存量
  const hqWh = defaultCentralWarehouse(db)
  for (const it of head.items) {
    it.hq_available = hqWh
      ? db
          .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
          .get(hqWh.id, it.sku_id).a
      : 0
    it.store_stock_now = head.store_warehouse_id
      ? db
          .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
          .get(head.store_warehouse_id, it.sku_id).a
      : 0
    // 已发货数量（未取消的发货单）与剩余可发数量，供总部分批发货
    it.shipped_qty = db
      .prepare(
        `SELECT COALESCE(SUM(i.ship_qty),0) q
         FROM store_shipment_items i JOIN store_shipments ss ON ss.id=i.shipment_id
         WHERE i.requisition_item_id=? AND ss.status<>'cancelled'`
      )
      .get(it.id).q
    it.remain_qty = Math.max(0, Number(it.qty) - Number(it.shipped_qty))
  }
  head.hq_warehouse = hqWh || null
  return head
}

// 发货单明细重算（发货量 / 实收量 / 差异 / 金额）
function recalcShipment(db, id) {
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(ship_qty),0) sq,
              COALESCE(SUM(COALESCE(recv_qty,0)),0) rq,
              COALESCE(SUM(COALESCE(diff_qty,0)),0) dq,
              COALESCE(SUM(amount),0) amt
       FROM store_shipment_items WHERE shipment_id=?`
    )
    .get(id)
  db.prepare('UPDATE store_shipments SET total_qty=?, received_qty=?, diff_qty=?, total_amount=? WHERE id=?').run(
    agg.sq,
    agg.rq,
    agg.dq,
    Number(agg.amt.toFixed(2)),
    id
  )
}

function loadShipment(db, id) {
  const head = db
    .prepare(
      `SELECT ss.*, s.name AS store_name, s.code AS store_code, s.city AS store_city,
              fw.name AS from_warehouse_name, tw.name AS to_warehouse_name,
              sr.doc_no AS requisition_doc_no
       FROM store_shipments ss
       JOIN stores s ON s.id=ss.store_id
       JOIN warehouses fw ON fw.id=ss.from_warehouse_id
       JOIN warehouses tw ON tw.id=ss.to_warehouse_id
       LEFT JOIN store_requisitions sr ON sr.id=ss.requisition_id
       WHERE ss.id=?`
    )
    .get(id)
  if (!head) return null
  head.status_name = SHIP_STATUS[head.status] || head.status
  head.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, p.unit, b.name AS brand_name
       FROM store_shipment_items i
       JOIN product_skus sk ON sk.id=i.sku_id
       JOIN products p ON p.id=sk.product_id
       LEFT JOIN brands b ON b.id=p.brand_id
       WHERE i.shipment_id=? ORDER BY i.id`
    )
    .all(id)
  for (const it of head.items) {
    try {
      it.batch_list = it.batches ? JSON.parse(it.batches) : []
    } catch {
      it.batch_list = []
    }
    it.pending = it.recv_qty == null
  }
  return head
}

// ================= 门店端 =================

// 门店提交要货申请
r.post(
  '/store',
  requireAuth,
  requireStore(),
  wrap((req, res) => {
    const { db, store, wh, u } = storeCtx(req)
    const { items = [], expect_date, urgency = 'normal', remark } = req.body || {}
    if (!Array.isArray(items) || !items.length) return fail(res, '请至少添加一行要货商品')
    const skus = []
    let totalQty = 0
    let totalAmount = 0
    for (const it of items) {
      const sku = db
        .prepare('SELECT s.*, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
        .get(Number(it.sku_id))
      if (!sku) return fail(res, `SKU#${it.sku_id} 不存在`)
      const qty = Number(it.qty)
      if (!(qty > 0)) return fail(res, '要货数量必须大于 0')
      const stock = wh
        ? db
            .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
            .get(wh.id, sku.id).a
        : 0
      const price = Number(sku.cost_std || sku.p_cost || 0)
      totalQty += qty
      totalAmount += qty * price
      skus.push({ sku, qty, price, stock })
    }
    const today = localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'SQ', 'store_requisitions', 'doc_no', today)
      const info = db
        .prepare(
          `INSERT INTO store_requisitions (doc_no,store_id,store_warehouse_id,req_date,expect_date,applicant,urgency,status,source,total_qty,total_amount,remark,created_by)
           VALUES (?,?,?,?,?,?,?,'submitted','pos',?,?,?,?)`
        )
        .run(docNo, store.id, wh ? wh.id : null, today, expect_date || null, u.name || null, urgency, totalQty, Number(totalAmount.toFixed(2)), remark || null, u.uid || null)
      const rid = info.lastInsertRowid
      const ins = db.prepare(
        'INSERT INTO store_requisition_items (requisition_id,sku_id,qty,approved_qty,store_stock,price,status) VALUES (?,?,?,0,?,?,?)'
      )
      for (const { sku, qty, price, stock } of skus) ins.run(rid, sku.id, qty, stock, price, 'pending')
      return { id: rid, docNo }
    })()
    audit(req, { action: 'CREATE', module: 'requisition', entity: 'store_requisitions', entityId: result.id, detail: result.docNo })
    return ok(res, { id: result.id, doc_no: result.docNo })
  })
)

// 门店查看自己的要货单
r.get(
  '/store/mine',
  requireAuth,
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const rows = db
      .prepare(
        `SELECT sr.*, (SELECT COUNT(*) FROM store_requisition_items i WHERE i.requisition_id=sr.id) AS item_count
         FROM store_requisitions sr WHERE sr.store_id=? ORDER BY sr.id DESC LIMIT 100`
      )
      .all(store.id)
      .map((x) => ({ ...x, status_name: REQ_STATUS[x.status] || x.status }))
    return ok(res, rows)
  })
)

// 门店待收货发货单（含历史）
r.get(
  '/store/shipments/mine',
  requireAuth,
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const decorate = (x) => ({ ...x, status_name: SHIP_STATUS[x.status] || x.status })
    const pending = db
      .prepare(
        `SELECT ss.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name, sr.doc_no AS requisition_doc_no,
                (SELECT COUNT(*) FROM store_shipment_items i WHERE i.shipment_id=ss.id) AS item_count,
                (SELECT COUNT(*) FROM store_shipment_items i WHERE i.shipment_id=ss.id AND i.recv_qty IS NULL) AS pending_count
         FROM store_shipments ss
         JOIN warehouses fw ON fw.id=ss.from_warehouse_id
         JOIN warehouses tw ON tw.id=ss.to_warehouse_id
         LEFT JOIN store_requisitions sr ON sr.id=ss.requisition_id
         WHERE ss.store_id=? AND ss.status IN ('shipped','partial')
         ORDER BY CASE ss.status WHEN 'shipped' THEN 0 ELSE 1 END, ss.id DESC LIMIT 100`
      )
      .all(store.id)
      .map(decorate)
    const history = db
      .prepare(
        `SELECT ss.*, fw.name AS from_warehouse_name, sr.doc_no AS requisition_doc_no,
                (SELECT COUNT(*) FROM store_shipment_items i WHERE i.shipment_id=ss.id) AS item_count
         FROM store_shipments ss
         LEFT JOIN warehouses fw ON fw.id=ss.from_warehouse_id
         LEFT JOIN store_requisitions sr ON sr.id=ss.requisition_id
         WHERE ss.store_id=? AND ss.status IN ('received','closed')
         ORDER BY ss.id DESC LIMIT 30`
      )
      .all(store.id)
      .map(decorate)
    return ok(res, { pending, history })
  })
)

// 门店查看发货单明细（仅本门店）
r.get(
  '/store/shipments/:id',
  requireAuth,
  wrap((req, res) => {
    const { db, store } = storeCtx(req)
    const head = loadShipment(db, Number(req.params.id))
    if (!head) return fail(res, '发货单不存在', 404)
    if (head.store_id !== store.id) return fail(res, '无权查看该发货单', 403, 403)
    return ok(res, head)
  })
)

// 门店选择性收货：可只收部分行 / 部分数量，差异自动登记
r.post(
  '/store/shipments/:id/receive',
  requireAuth,
  wrap((req, res) => {
    const { db, store, wh, u } = storeCtx(req)
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_shipments WHERE id=?').get(id)
    if (!head) return fail(res, '发货单不存在', 404)
    if (head.store_id !== store.id) return fail(res, '无权操作该发货单', 403, 403)
    if (!['shipped', 'partial'].includes(head.status)) return fail(res, '该发货单当前状态不可收货')
    const toWh = wh || db.prepare('SELECT * FROM warehouses WHERE id=?').get(head.to_warehouse_id)
    if (!toWh) return fail(res, '门店收货仓不存在，请联系总部维护')

    const { lines = [], receiver, remark } = req.body || {}
    const items = db.prepare('SELECT * FROM store_shipment_items WHERE shipment_id=?').all(id)
    if (!items.length) return fail(res, '发货单没有明细')

    // 收货范围：显式传 lines 则按行收；不传则全部未收行按发货数量收
    const recvMap = new Map()
    if (Array.isArray(lines) && lines.length) {
      for (const ln of lines) {
        const it = items.find((x) => x.id === Number(ln.item_id || ln.id))
        if (!it) continue
        if (it.recv_qty != null) continue // 已收过的行跳过
        const q = ln.recv_qty != null && ln.recv_qty !== '' ? Number(ln.recv_qty) : Number(ln.qty)
        if (!Number.isFinite(q) || q < 0) return fail(res, '实收数量不合法')
        if (q > Number(it.ship_qty)) return fail(res, `实收数量不能大于发货数量（本行最多 ${it.ship_qty}）`)
        recvMap.set(it.id, q)
      }
    } else {
      for (const it of items) if (it.recv_qty == null) recvMap.set(it.id, Number(it.ship_qty))
    }
    if (!recvMap.size) return fail(res, '请勾选需要收货的明细行')

    const today = localDate()
    const result = db.transaction(() => {
      for (const it of items) {
        if (!recvMap.has(it.id)) continue
        const recvQty = recvMap.get(it.id)
        let batchList = []
        try {
          batchList = it.batches ? JSON.parse(it.batches) : []
        } catch {
          batchList = []
        }
        if (!batchList.length) batchList = [{ batchNo: '', qty: Number(it.ship_qty), unitCost: Number(it.price || 0) }]
        // 按原发货批次顺序分摊入库，保持批次与成本可追溯
        let remain = recvQty
        for (const b of batchList) {
          if (remain <= 0) break
          const take = Math.min(Number(b.qty) || 0, remain)
          if (take <= 0) continue
          applyStockIn(db, {
            bizDate: today,
            docType: 'SHP_IN',
            docNo: head.doc_no,
            docId: id,
            warehouseId: toWh.id,
            skuId: it.sku_id,
            batchNo: b.batchNo || '',
            qty: take,
            unitCost: Number(b.unitCost || it.price || 0),
            operator: u.name || null,
            remark: `门店收货 ${head.doc_no}`
          })
          remain -= take
        }
        if (remain > 0) {
          applyStockIn(db, {
            bizDate: today,
            docType: 'SHP_IN',
            docNo: head.doc_no,
            docId: id,
            warehouseId: toWh.id,
            skuId: it.sku_id,
            batchNo: '',
            qty: remain,
            unitCost: Number(it.price || 0),
            operator: u.name || null,
            remark: `门店收货 ${head.doc_no}`
          })
        }
        const diff = Number((recvQty - Number(it.ship_qty)).toFixed(2))
        db.prepare('UPDATE store_shipment_items SET recv_qty=?, diff_qty=? WHERE id=?').run(recvQty, diff, it.id)
      }
      recalcShipment(db, id)
      const pendingCount = db
        .prepare('SELECT COUNT(*) c FROM store_shipment_items WHERE shipment_id=? AND recv_qty IS NULL')
        .get(id).c
      const newStatus = pendingCount > 0 ? 'partial' : 'received'
      db.prepare(
        `UPDATE store_shipments SET status=?, receiver=COALESCE(?,receiver), remark=COALESCE(?,remark),
           received_at=datetime('now','localtime') WHERE id=?`
      ).run(newStatus, receiver || null, remark || null, id)
      // 留痕（与改动**同一个事务**）：`SH` 这张单原来**一条痕都没有**（三库实测 SH 的 doc_events 长期为 0）。
      // ⚠️ 下面那两条 `logEvent` 是 **YQ**（要货单）的 —— 别把"邻近有痕"当成本单的痕：
      //    SH 的痕必须自己写，且 `action` 从内核派生（`shipped/partial → partial/received` 在对内核是两条不同边）。
      if (head.status !== newStatus) {
        const shEdge = allowedActions(db, 'SH', head.status).find((a) => a.to === newStatus)
        if (shEdge) {
          logEvent({
            db,
            docType: 'SH',
            id,
            docNo: head.doc_no,
            action: shEdge.action,
            actionName: shEdge.actionName,
            from: head.status,
            to: newStatus,
            actor: { id: u?.uid ?? null, name: u?.name || u?.username || null },
            source: 'api',
            remark: `门店发货单${newStatus === 'partial' ? '部分收货' : '确认收货'} ${head.doc_no}`,
            payload: { store_id: head.store_id ?? null, requisition_id: head.requisition_id ?? null, pending_count: pendingCount }
          })
        }
      }
      // 反写要货单：全部收完 → 已收货，否则仍为已发货；状态变化必须留痕（收尾：legacy 要货单接入单据内核）
      if (head.requisition_id) {
        const rq = db.prepare('SELECT status, doc_no FROM store_requisitions WHERE id=?').get(head.requisition_id)
        const toStatus = pendingCount > 0 ? 'shipped' : 'received'
        db.prepare('UPDATE store_requisitions SET status=? WHERE id=?').run(toStatus, head.requisition_id)
        if (rq && rq.status !== toStatus) {
          logEvent({
            db, docType: 'YQ', id: head.requisition_id, docNo: rq.doc_no,
            action: pendingCount > 0 ? 'partial_receive' : 'receive',
            actionName: pendingCount > 0 ? '部分收货' : '收货',
            from: rq.status, to: toStatus,
            actor: { id: u?.uid ?? null, name: u?.name || u?.username || null },
            source: 'api', remark: `发货单 ${head.doc_no} 收货联动`
          })
        }
      }
      return { newStatus, pendingCount }
    })()
    audit(req, { action: 'RECEIVE', module: 'requisition', entity: 'store_shipments', entityId: id, detail: head.doc_no })
    return ok(res, { ...loadShipment(db, id), pending_count: result.pendingCount })
  })
)

// ================= 总部端 =================

// 总部要货看板：按门店/状态聚合 + 待办提示
r.get(
  '/store/board',
  requireAuth,
  requireRole(...HQ),
  wrap((_req, res) => {
    const db = getDb()
    const byStore = db
      .prepare(
        `SELECT s.id, s.name AS store_name, s.city,
                COUNT(sr.id) req_count,
                SUM(CASE WHEN sr.status='submitted' THEN 1 ELSE 0 END) pending,
                COALESCE(SUM(sr.total_qty),0) total_qty
         FROM stores s LEFT JOIN store_requisitions sr ON sr.store_id=s.id
         WHERE s.status='active' GROUP BY s.id ORDER BY pending DESC, s.id`
      )
      .all()
    const recent = db
      .prepare(
        `SELECT sr.doc_no, sr.req_date, sr.urgency, sr.status, sr.total_qty, s.name AS store_name
         FROM store_requisitions sr JOIN stores s ON s.id=sr.store_id
         ORDER BY sr.id DESC LIMIT 10`
      )
      .all()
      .map((x) => ({ ...x, status_name: REQ_STATUS[x.status] || x.status }))
    return ok(res, { byStore, recent })
  })
)

// 要货单列表（总部）
r.get(
  '/store',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.status) {
      conds.push('sr.status=?')
      params.push(req.query.status)
    }
    if (req.query.store_id) {
      conds.push('sr.store_id=?')
      params.push(Number(req.query.store_id))
    }
    if (req.query.startDate) {
      conds.push('sr.req_date>=?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('sr.req_date<=?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(sr.doc_no LIKE ? OR s.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'store_requisitions sr JOIN stores s ON s.id=sr.store_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT sr.*, s.name AS store_name, s.city AS store_city,
                (SELECT COUNT(*) FROM store_requisition_items i WHERE i.requisition_id=sr.id) AS item_count
         FROM ${FROM} ${where} ORDER BY CASE sr.urgency WHEN 'urgent' THEN 0 ELSE 1 END, sr.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
      .map((x) => ({ ...x, status_name: REQ_STATUS[x.status] || x.status }))
    const summary = db
      .prepare(
        `SELECT
           SUM(CASE WHEN sr.status='submitted' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sr.status='transferred' THEN 1 ELSE 0 END) AS transferred,
           SUM(CASE WHEN sr.status='allocated' THEN 1 ELSE 0 END) AS allocated,
           COUNT(*) AS total
         FROM ${FROM} ${where}`
      )
      .get(...params)
    return paged(res, { rows, total, page, pageSize, summary, statusLabels: REQ_STATUS })
  })
)

// 要货单明细（总部）
r.get(
  '/store/:id',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const head = loadRequisition(db, Number(req.params.id))
    if (!head) return fail(res, '要货单不存在', 404)
    return ok(res, head)
  })
)

// 受理 / 驳回
r.post(
  '/store/:id/status',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_requisitions WHERE id=?').get(id)
    if (!head) return fail(res, '要货单不存在', 404)
    const action = req.body?.action
    if (action === 'accept') {
      if (head.status !== 'submitted') return fail(res, '只有待受理的要货单可以受理')
      advanceStatus(db, req, { docType: 'YQ', id, action: 'process', remark: '总部受理要货' })
    } else if (action === 'reject') {
      if (['transferred', 'allocated', 'completed'].includes(head.status)) return fail(res, '该要货单已处理，不能驳回')
      advanceStatus(db, req, { docType: 'YQ', id, action: 'reject', set: { remark: req.body?.reason || head.remark }, remark: '驳回要货申请' })
    } else if (action === 'complete') {
      advanceStatus(db, req, { docType: 'YQ', id, action: 'complete', remark: '要货单完成' })
    } else {
      return fail(res, '不支持的操作')
    }
    audit(req, { action: action.toUpperCase(), module: 'requisition', entity: 'store_requisitions', entityId: id })
    return ok(res, loadRequisition(db, id))
  })
)

// 要货单 → 采购订单（勾选行；可选总部入库 / 直运门店仓）
r.post(
  '/store/:id/to-purchase',
  requireAuth,
  requireRole('purchase', 'warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_requisitions WHERE id=?').get(id)
    if (!head) return fail(res, '要货单不存在', 404)
    if (['completed', 'rejected', 'cancelled'].includes(head.status)) return fail(res, '该要货单已结束，不能再转采购')
    const { supplier_id, lines = [], fulfill_type = 'hq', warehouse_id, target_warehouse_id, expect_date, remark } = req.body || {}
    if (!supplier_id) return fail(res, '请选择供应商')
    if (!Array.isArray(lines) || !lines.length) return fail(res, '请勾选要转采购的明细行')
    if (!['hq', 'direct'].includes(fulfill_type)) return fail(res, '履约方式不合法')

    const reqItems = db.prepare('SELECT * FROM store_requisition_items WHERE requisition_id=?').all(id)
    const payload = []
    for (const ln of lines) {
      const src = reqItems.find((x) => x.id === Number(ln.item_id || ln.id))
      if (!src) continue
      const qty = Number(ln.qty || src.qty - (src.approved_qty || 0) || src.qty)
      if (!(qty > 0)) continue
      const sku = db.prepare('SELECT s.*, p.cost_std AS p_cost FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(src.sku_id)
      payload.push({ src, sku, qty, price: Number(sku?.cost_std || sku?.p_cost || src.price || 0) })
    }
    if (!payload.length) return fail(res, '没有有效的采购明细')

    // 履约方式决定入库仓：直运 → 门店仓；总部入库 → 指定/默认中心仓
    const hqWh = warehouse_id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(warehouse_id)) : defaultCentralWarehouse(db)
    const storeWh = target_warehouse_id
      ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(target_warehouse_id))
      : storeWarehouse(db, head.store_id)
    const inboundWh = fulfill_type === 'direct' ? storeWh : hqWh
    if (!inboundWh) return fail(res, fulfill_type === 'direct' ? '该门店未绑定门店仓，无法直运' : '未找到入库仓库')

    const today = localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'PO', 'purchase_orders', 'doc_no', today)
      const info = db
        .prepare(
          `INSERT INTO purchase_orders
             (doc_no,supplier_id,warehouse_id,order_date,expect_date,buyer,status,total_qty,total_amount,tax_amount,settle_type,
              fulfill_type,target_store_id,target_warehouse_id,source_requisition_id,source_type,remark,created_by)
           VALUES (?,?,?,?,?,?, 'draft',0,0,0,? ,?,?,?,?, 'requisition',?,?)`
        )
        .run(
          docNo, Number(supplier_id), inboundWh.id, today, expect_date || head.expect_date || null, u.name || null,
          null, fulfill_type, head.store_id, fulfill_type === 'direct' ? inboundWh.id : null, id,
          remark || `门店要货转采购 ${head.doc_no}`, u.uid || null
        )
      const poId = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount,remark) VALUES (?,?,?,?,13,?,?)'
      )
      let tq = 0
      let ta = 0
      for (const p of payload) {
        insItem.run(poId, p.src.sku_id, p.qty, p.price, Number((p.qty * p.price).toFixed(2)), `要货行#${p.src.id}`)
        tq += p.qty
        ta += p.qty * p.price
        db.prepare('UPDATE store_requisition_items SET approved_qty=?, status=? WHERE id=?').run(p.qty, 'approved', p.src.id)
      }
      const tax = db.prepare('SELECT COALESCE(SUM(amount*tax_rate/100.0),0) t FROM purchase_order_items WHERE order_id=?').get(poId).t
      db.prepare('UPDATE purchase_orders SET total_qty=?, total_amount=?, tax_amount=? WHERE id=?').run(tq, Number(ta.toFixed(2)), Number(tax.toFixed(2)), poId)
      const prev = head.linked_po_ids ? `${head.linked_po_ids},` : ''
      advanceStatus(db, req, { docType: 'YQ', id, action: 'transfer', set: { linked_po_ids: `${prev}${poId}` }, remark: `转采购订单 ${docNo}` })
      return { poId, docNo }
    })()
    audit(req, { action: 'TO_PURCHASE', module: 'requisition', entity: 'store_requisitions', entityId: id, detail: result.docNo })
    return ok(res, { id: result.poId, doc_no: result.docNo, requisition: loadRequisition(db, id) })
  })
)

// 要货单 → 总部配货调拨（从中心仓调到门店仓；库存充足时优先配货，不必采购）
r.post(
  '/store/:id/to-transfer',
  requireAuth,
  requireRole('warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_requisitions WHERE id=?').get(id)
    if (!head) return fail(res, '要货单不存在', 404)
    const { lines = [], from_warehouse_id } = req.body || {}
    const fromWh = from_warehouse_id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(from_warehouse_id)) : defaultCentralWarehouse(db)
    const toWh = storeWarehouse(db, head.store_id)
    if (!fromWh || !toWh) return fail(res, '调出/调入仓库不完整')

    const reqItems = db.prepare('SELECT * FROM store_requisition_items WHERE requisition_id=?').all(id)
    const chosen = lines.length ? lines : reqItems.map((x) => ({ item_id: x.id, qty: x.qty }))
    const picks = []
    for (const ln of chosen) {
      const src = reqItems.find((x) => x.id === Number(ln.item_id || ln.id))
      if (!src) continue
      const qty = Number(ln.qty || src.qty)
      if (!(qty > 0)) continue
      picks.push({ src, qty })
    }
    if (!picks.length) return fail(res, '没有可配货的明细')

    const today = localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'DB', 'stock_transfers', 'doc_no', today)
      const info = db
        .prepare(
          `INSERT INTO stock_transfers (doc_no,from_warehouse_id,to_warehouse_id,transfer_date,type,status,total_qty,total_amount,applicant,remark,created_by)
           VALUES (?,?,?,?, 'allocation','draft',0,0,?,?,?)`
        )
        .run(docNo, fromWh.id, toWh.id, today, u.name || null, `门店要货配货 ${head.doc_no}`, u.uid || null)
      const trId = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO stock_transfer_items (transfer_id,sku_id,batch_no,qty,cost_price,amount) VALUES (?,?,?,?,?,?)'
      )
      let tq = 0
      let ta = 0
      for (const p of picks) {
        const { picks: batches, shortage } = pickBatches(db, fromWh.id, p.src.sku_id, p.qty)
        if (shortage > 0) {
          const err = new Error(`中心仓库存不足，无法配货：SKU#${p.src.sku_id} 缺 ${shortage}。请改走采购或调整数量。`)
          err.status = 400
          throw err
        }
        for (const b of batches) {
          insItem.run(trId, p.src.sku_id, b.batchNo, b.qty, b.unitCost || 0, Number((b.qty * (b.unitCost || 0)).toFixed(2)))
          tq += b.qty
          ta += b.qty * (b.unitCost || 0)
        }
        db.prepare("UPDATE store_requisition_items SET approved_qty=?, status='approved' WHERE id=?").run(p.qty, p.src.id)
      }
      db.prepare('UPDATE stock_transfers SET total_qty=?, total_amount=? WHERE id=?').run(tq, Number(ta.toFixed(2)), trId)
      advanceStatus(db, req, { docType: 'YQ', id, action: 'allocate', set: { linked_transfer_id: trId }, remark: `转调拨单 ${docNo}` })
      return { trId, docNo }
    })()
    audit(req, { action: 'TO_TRANSFER', module: 'requisition', entity: 'store_requisitions', entityId: id, detail: result.docNo })
    return ok(res, { id: result.trId, doc_no: result.docNo, requisition: loadRequisition(db, id) })
  })
)

// ================= 总部发货 =================

// 发货单列表
r.get(
  '/shipments',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.status) {
      conds.push('ss.status=?')
      params.push(req.query.status)
    }
    if (req.query.store_id) {
      conds.push('ss.store_id=?')
      params.push(Number(req.query.store_id))
    }
    if (req.query.startDate) {
      conds.push('ss.ship_date>=?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('ss.ship_date<=?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(ss.doc_no LIKE ? OR s.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `store_shipments ss JOIN stores s ON s.id=ss.store_id
                  LEFT JOIN warehouses fw ON fw.id=ss.from_warehouse_id
                  LEFT JOIN store_requisitions sr ON sr.id=ss.requisition_id`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT ss.*, s.name AS store_name, s.city AS store_city,
                fw.name AS from_warehouse_name, sr.doc_no AS requisition_doc_no,
                (SELECT COUNT(*) FROM store_shipment_items i WHERE i.shipment_id=ss.id) AS item_count,
                (SELECT COUNT(*) FROM store_shipment_items i WHERE i.shipment_id=ss.id AND i.recv_qty IS NULL) AS pending_count
         FROM ${FROM} ${where} ORDER BY ss.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
      .map((x) => ({ ...x, status_name: SHIP_STATUS[x.status] || x.status }))
    const summary = db
      .prepare(
        `SELECT SUM(CASE WHEN ss.status='draft' THEN 1 ELSE 0 END) draft,
                SUM(CASE WHEN ss.status='shipped' THEN 1 ELSE 0 END) shipped,
                SUM(CASE WHEN ss.status='partial' THEN 1 ELSE 0 END) partial,
                SUM(CASE WHEN ss.status='received' THEN 1 ELSE 0 END) received,
                COUNT(*) total
         FROM ${FROM} ${where}`
      )
      .get(...params)
    return paged(res, { rows, total, page, pageSize, summary, statusLabels: SHIP_STATUS })
  })
)

// 发货单明细
r.get(
  '/shipments/:id',
  requireAuth,
  requireRole(...HQ),
  wrap((req, res) => {
    const db = getDb()
    const head = loadShipment(db, Number(req.params.id))
    if (!head) return fail(res, '发货单不存在', 404)
    return ok(res, head)
  })
)

// 参考要货单生成发货单（勾选行 + 可改发货数量）
r.post(
  '/shipments',
  requireAuth,
  requireRole('warehouse', 'sales', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { requisition_id, lines = [], from_warehouse_id, ship_date, carrier, express_no, remark } = req.body || {}
    if (!requisition_id) return fail(res, '请指定要货单')
    const head = db.prepare('SELECT * FROM store_requisitions WHERE id=?').get(Number(requisition_id))
    if (!head) return fail(res, '要货单不存在', 404)
    if (['completed', 'rejected', 'cancelled'].includes(head.status)) return fail(res, '该要货单已结束，不能再发货')

    const fromWh = from_warehouse_id
      ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(from_warehouse_id))
      : defaultCentralWarehouse(db)
    const toWh = storeWarehouse(db, head.store_id) ||
      (head.store_warehouse_id ? db.prepare('SELECT * FROM warehouses WHERE id=?').get(head.store_warehouse_id) : null)
    if (!fromWh) return fail(res, '未找到发货仓（中心仓）')
    if (!toWh) return fail(res, '该门店未绑定门店仓，无法发货')

    const reqItems = db.prepare('SELECT * FROM store_requisition_items WHERE requisition_id=?').all(head.id)
    // 已发出数量（同一要货单下未取消的发货单）
    const shippedMap = new Map()
    const prev = db
      .prepare(
        `SELECT i.requisition_item_id, i.ship_qty FROM store_shipment_items i
         JOIN store_shipments ss ON ss.id=i.shipment_id
         WHERE ss.requisition_id=? AND ss.status<>'cancelled'`
      )
      .all(head.id)
    for (const p of prev) {
      if (!p.requisition_item_id) continue
      shippedMap.set(p.requisition_item_id, (shippedMap.get(p.requisition_item_id) || 0) + Number(p.ship_qty))
    }

    const chosen = Array.isArray(lines) && lines.length ? lines : reqItems.map((x) => ({ item_id: x.id }))
    const picks = []
    for (const ln of chosen) {
      const src = reqItems.find((x) => x.id === Number(ln.item_id || ln.id))
      if (!src) continue
      const remain = Number(src.qty) - (shippedMap.get(src.id) || 0)
      if (remain <= 0) continue
      const qty = ln.ship_qty != null && ln.ship_qty !== '' ? Number(ln.ship_qty) : remain
      if (!(qty > 0)) continue
      if (qty > remain) return fail(res, `发货数量不能超过未发数量（最多 ${remain}）`)
      picks.push({ src, qty })
    }
    if (!picks.length) return fail(res, '没有可发货的明细行（可能已全部发完）')

    // 发货前校验发货仓可用量，避免确认发货时才失败
    for (const p of picks) {
      const avail = db
        .prepare('SELECT COALESCE(SUM(qty_on_hand-qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
        .get(fromWh.id, p.src.sku_id).a
      if (avail < p.qty) {
        return fail(res, `发货仓库存不足：SKU#${p.src.sku_id} 可用 ${avail}，需要 ${p.qty}。请先采购入库、中心仓配货或减少发货数量。`)
      }
    }

    const today = ship_date || localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'FH', 'store_shipments', 'doc_no', today)
      const info = db
        .prepare(
          `INSERT INTO store_shipments
             (doc_no,requisition_id,store_id,from_warehouse_id,to_warehouse_id,ship_date,status,carrier,express_no,remark,created_by)
           VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`
        )
        .run(
          docNo, head.id, head.store_id, fromWh.id, toWh.id, today,
          carrier || null, express_no || null, remark || `参考要货单 ${head.doc_no} 发货`, u.uid || null
        )
      const sid = info.lastInsertRowid
      const ins = db.prepare(
        `INSERT INTO store_shipment_items (shipment_id,requisition_item_id,sku_id,req_qty,ship_qty,price,amount,remark)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      let tq = 0
      let ta = 0
      for (const p of picks) {
        const price = Number(p.src.price || 0)
        ins.run(sid, p.src.id, p.src.sku_id, Number(p.src.qty), p.qty, price, Number((p.qty * price).toFixed(2)), null)
        tq += p.qty
        ta += p.qty * price
      }
      recalcShipment(db, sid)
      // 要货单进入处理中，并登记发货单；状态变化必须留痕
      const linked = head.linked_shipment_ids ? `${head.linked_shipment_ids},` : ''
      const newStatus = ['transferred', 'allocated'].includes(head.status) ? head.status : 'processing'
      db.prepare('UPDATE store_requisitions SET status=?, linked_shipment_ids=? WHERE id=?').run(newStatus, `${linked}${sid}`, head.id)
      if (head.status !== newStatus) {
        logEvent({
          db, docType: 'YQ', id: head.id, docNo: head.doc_no,
          action: 'process', actionName: '受理并登记发货单',
          from: head.status, to: newStatus,
          actor: { id: u?.uid ?? null, name: u?.name || u?.username || null },
          source: 'api', remark: `登记发货单 ${docNo}`
        })
      }
      return { sid, docNo }
    })()
    audit(req, { action: 'CREATE', module: 'requisition', entity: 'store_shipments', entityId: result.sid, detail: result.docNo })
    return ok(res, { id: result.sid, doc_no: result.docNo, shipment: loadShipment(db, result.sid) })
  })
)

// 确认发货：发货仓 FIFO 出库
r.post(
  '/shipments/:id/ship',
  requireAuth,
  requireRole('warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_shipments WHERE id=?').get(id)
    if (!head) return fail(res, '发货单不存在', 404)
    if (head.status !== 'draft') return fail(res, '只有待发货的单据可以确认发货')
    const items = db.prepare('SELECT * FROM store_shipment_items WHERE shipment_id=?').all(id)
    if (!items.length) return fail(res, '发货单没有明细')
    const today = localDate()
    db.transaction(() => {
      for (const it of items) {
        const { picks, shortage } = pickBatches(db, head.from_warehouse_id, it.sku_id, Number(it.ship_qty))
        if (shortage > 0) {
          const err = new Error(`发货仓库存不足：SKU#${it.sku_id} 缺 ${shortage}，请先入库或调整发货数量`)
          err.status = 400
          throw err
        }
        const batchList = []
        for (const b of picks) {
          applyStockOut(db, {
            bizDate: today,
            docType: 'SHP_OUT',
            docNo: head.doc_no,
            docId: id,
            warehouseId: head.from_warehouse_id,
            skuId: it.sku_id,
            batchNo: b.batchNo,
            qty: b.qty,
            unitCost: b.unitCost,
            operator: u.name || null,
            remark: `门店发货 ${head.doc_no}`
          })
          batchList.push({ batchNo: b.batchNo, qty: b.qty, unitCost: Number(b.unitCost || 0), expireDate: b.expireDate || null })
        }
        const amt = Number(batchList.reduce((s, b) => s + b.qty * (b.unitCost || 0), 0).toFixed(2))
        const avgCost = Number(it.ship_qty) > 0 ? Number((amt / Number(it.ship_qty)).toFixed(4)) : Number(it.price || 0)
        db.prepare('UPDATE store_shipment_items SET batches=?, price=?, amount=? WHERE id=?').run(
          JSON.stringify(batchList), avgCost, amt, it.id
        )
      }
      recalcShipment(db, id)
      db.prepare("UPDATE store_shipments SET status='shipped', shipped_at=datetime('now','localtime') WHERE id=?").run(id)
      // 留痕（同一事务）：`draft → shipped` 是内核注册过的边（`SH` 的 `ship`）。
      // 原来这里没有 SH 的痕（下面那条 `logEvent` 是 YQ 的联动痕，docType 不同）。
      if (head.status !== 'shipped') {
        const shEdge = allowedActions(db, 'SH', head.status).find((a) => a.to === 'shipped')
        if (shEdge) {
          logEvent({
            db,
            docType: 'SH',
            id,
            docNo: head.doc_no,
            action: shEdge.action,
            actionName: shEdge.actionName,
            from: head.status,
            to: 'shipped',
            actor: { id: u?.uid ?? null, name: u?.name || u?.username || null },
            source: 'api',
            remark: `门店发货单发货 ${head.doc_no}`,
            payload: { store_id: head.store_id ?? null, requisition_id: head.requisition_id ?? null }
          })
        }
      }
      if (head.requisition_id) {
        const rq = db.prepare('SELECT status, doc_no FROM store_requisitions WHERE id=?').get(head.requisition_id)
        db.prepare("UPDATE store_requisitions SET status='shipped' WHERE id=?").run(head.requisition_id)
        if (rq && rq.status !== 'shipped') {
          logEvent({
            db, docType: 'YQ', id: head.requisition_id, docNo: rq.doc_no,
            action: 'ship', actionName: '发货',
            from: rq.status, to: 'shipped',
            actor: { id: u?.uid ?? null, name: u?.name || u?.username || null },
            source: 'api', remark: `发货单 ${head.doc_no} 确认发货联动`
          })
        }
      }
    })()
    audit(req, { action: 'SHIP', module: 'requisition', entity: 'store_shipments', entityId: id, detail: head.doc_no })
    return ok(res, loadShipment(db, id))
  })
)

// 取消发货单（仅待发货）
r.post(
  '/shipments/:id/cancel',
  requireAuth,
  requireRole('warehouse', 'scm', 'admin'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = db.prepare('SELECT * FROM store_shipments WHERE id=?').get(id)
    if (!head) return fail(res, '发货单不存在', 404)
    if (head.status !== 'draft') return fail(res, '只有待发货的单据可以取消')
    const reason = req.body?.reason || null
    // 状态推进仍是**裸 UPDATE**（不是 applyTransition）：改成走内核会引入边校验，
    // 可能把现在能跑的流程变成 409（记入技术债）。但**痕迹必须补**，且与改动**同一个事务** ——
    // 这条路由原来是"既不留痕、也不在事务里"（`SH` 的 `doc_events` 三库一直是 0 条）。
    // `from: head.status`（上面刚校验过必为 `draft`）→ `cancelled` 是内核注册过的边
    // （`SH` 的 `cancel: draft→cancelled`），不是手写的自由值。
    const exec = db.transaction(() => {
      db.prepare("UPDATE store_shipments SET status='cancelled', remark=COALESCE(?,remark) WHERE id=?").run(reason, id)
      logEvent({
        db,
        docType: 'SH',
        id,
        docNo: head.doc_no,
        action: 'cancel',
        actionName: '取消',
        from: head.status,
        to: 'cancelled',
        actor: { id: req.user?.uid ?? null, name: req.user?.name || req.user?.username || null },
        source: 'api',
        remark: reason || `门店发货单取消 ${head.doc_no}`,
        payload: { store_id: head.store_id ?? null, requisition_id: head.requisition_id ?? null }
      })
    })
    exec()
    audit(req, { action: 'CANCEL', module: 'requisition', entity: 'store_shipments', entityId: id, detail: head.doc_no })
    return ok(res, loadShipment(db, id))
  })
)

export default r
