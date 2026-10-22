/**
 * ============================================================================
 * 文件标识：server/routes/outsourcing.js ｜ 委外管理路由：委外订单、发料出库、收货入库、收货质检（WR.inspect）、委外结算
 * ============================================================================
 * 【职责】委外管理路由：委外订单、发料出库、收货入库、收货质检（WR.inspect）、委外结算
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
import { localDate, addDays } from '../lib/dates.js'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requireRole, requireInternal, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { nextDocNo, nextBatchNo } from '../lib/docno.js'
import { advanceStatus, tryTransition, applyTransition, nowText } from '../lib/docflow.js'
import { applyStockIn, applyStockOut, pickBatches } from '../lib/stock.js'

// ==================================================================
// 委外管理（参照用友委外标准业务）
//   委外订单（成品 + 应发材料 + 加工费）→ 委外发料（材料出库）→ 委外收货（成品入库）→ 委外结算
// ==================================================================
const r = Router()
r.use(requireAuth, requireInternal('总部委外业务'))
const W = ['purchase', 'warehouse', 'scm', 'admin']

/**
 * M9：payload 里**匹配不上 / 数量不为正**的行一律报错，不再 `continue` 静默吞掉。
 *
 * 为什么必须报错而不是"跳过就算了"：
 *   `/receive` 的旧实现遇到 `{id:null, qty:4}`（匹配不到任何明细行）会静默跳过，
 *   于是收货单的 `total_qty=0`，而**订单状态照样被推进**到 `part_received` ——
 *   结果是"一张 0 数量的收货单 + 一次不存在的事实"。这类单不报错、也不留痕，
 *   等对账时才发现"这张单说收过货，可仓库里没有这笔入库"。
 *   调用方把 id 传错、把行删了再传，都是真实会发生的；把原因原样回给他是唯一诚实的做法。
 */
function badLines(kind, lines) {
  const detail = lines.map((l) => `${l.id ?? '—'}（${l.reason}）`).join('、')
  const err = new Error(`${kind}明细有 ${lines.length} 行无法处理：${detail}`)
  err.status = 400
  err.code = 'OUTSOURCING_LINES_INVALID'
  err.detail = lines
  return err
}

const OS_STATUS = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已审批',
  issued: '已发料',
  part_received: '部分收货',
  received: '已收货',
  closed: '已关闭',
  cancelled: '已取消'
}

function loadOrder(db, id) {
  const head = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, s.code AS supplier_code, s.settle_type AS supplier_settle,
              w.name AS warehouse_name, mw.name AS material_warehouse_name,
              (SELECT COUNT(*) FROM outsourcing_order_items i WHERE i.order_id=o.id) AS item_count
       FROM outsourcing_orders o
       LEFT JOIN suppliers s ON s.id=o.supplier_id
       LEFT JOIN warehouses w ON w.id=o.warehouse_id
       LEFT JOIN warehouses mw ON mw.id=o.material_warehouse_id
       WHERE o.id=?`
    )
    .get(id)
  if (!head) return null
  head.status_name = OS_STATUS[head.status] || head.status
  head.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, p.name AS product_name, p.unit, p.shelf_life_months
       FROM outsourcing_order_items i
       JOIN product_skus sk ON sk.id=i.sku_id
       JOIN products p ON p.id=sk.product_id
       WHERE i.order_id=? ORDER BY CASE i.role WHEN 'product' THEN 0 ELSE 1 END, i.id`
    )
    .all(id)
  head.issues = db.prepare('SELECT * FROM outsourcing_materials WHERE order_id=? ORDER BY id').all(id)
  head.receipts = db.prepare('SELECT * FROM outsourcing_receipts WHERE order_id=? ORDER BY id').all(id)
  return head
}

function recalcOrder(db, id) {
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN role='product' THEN qty ELSE 0 END),0) product_qty,
         COALESCE(SUM(CASE WHEN role='product' THEN amount ELSE 0 END),0) product_amount,
         COALESCE(SUM(CASE WHEN role='material' THEN qty ELSE 0 END),0) material_qty,
         COALESCE(SUM(CASE WHEN role='material' THEN amount ELSE 0 END),0) material_amount
       FROM outsourcing_order_items WHERE order_id=?`
    )
    .get(id)
  const fee = db.prepare('SELECT COALESCE(process_fee,0) f FROM outsourcing_orders WHERE id=?').get(id).f
  db.prepare(
    `UPDATE outsourcing_orders SET product_qty=?, product_amount=?, material_qty=?, material_amount=?,
       total_amount=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    agg.product_qty,
    Number(agg.product_amount.toFixed(2)),
    agg.material_qty,
    Number(agg.material_amount.toFixed(2)),
    Number((Number(fee) + agg.material_amount).toFixed(2)),
    id
  )
}

// ---------- 委外订单 ----------
r.get(
  '/orders',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.status) {
      conds.push('o.status=?')
      params.push(req.query.status)
    }
    if (req.query.supplier_id) {
      conds.push('o.supplier_id=?')
      params.push(Number(req.query.supplier_id))
    }
    if (req.query.startDate) {
      conds.push('o.order_date>=?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('o.order_date<=?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(o.doc_no LIKE ? OR s.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'outsourcing_orders o LEFT JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN warehouses w ON w.id=o.warehouse_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT o.*, s.name AS supplier_name, w.name AS warehouse_name,
                (SELECT COUNT(*) FROM outsourcing_order_items i WHERE i.order_id=o.id) AS item_count
         FROM ${FROM} ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
      .map((x) => ({ ...x, status_name: OS_STATUS[x.status] || x.status }))
    const summary = db
      .prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN o.status IN ('submitted','approved','issued','part_received') THEN 1 ELSE 0 END) in_process,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled') THEN o.process_fee ELSE 0 END),0) process_fee
         FROM ${FROM} ${where}`
      )
      .get(...params)
    return paged(res, { rows, total, page, pageSize, summary, statusLabels: OS_STATUS })
  })
)

r.get(
  '/orders/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const head = loadOrder(db, Number(req.params.id))
    if (!head) return fail(res, '委外订单不存在', 404)
    return ok(res, head)
  })
)

r.post(
  '/orders',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const {
      supplier_id, warehouse_id, material_warehouse_id, order_date, expect_date,
      out_type = 'normal', process_fee = 0, settle_type, remark, items = []
    } = req.body || {}
    if (!supplier_id || !warehouse_id) return fail(res, '请选择委外加工商与成品入库仓')
    if (!Array.isArray(items) || !items.length) return fail(res, '请至少添加一行明细（成品或材料）')
    const products = items.filter((x) => x.role === 'product')
    if (!products.length) return fail(res, '委外订单至少需要一行成品')
    for (const it of items) {
      if (!it.sku_id || !(Number(it.qty) > 0)) return fail(res, '每一行都必须有商品和大于 0 的数量')
      if (!['product', 'material'].includes(it.role)) return fail(res, '明细角色只能是成品或材料')
    }
    // 单据日期兜底，避免未传日期时触发 NOT NULL 约束错误
    const odDate = String(order_date || '').trim() || localDate()
    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'WW', 'outsourcing_orders', 'doc_no', odDate)
      const info = db
        .prepare(
          `INSERT INTO outsourcing_orders
             (doc_no,supplier_id,warehouse_id,material_warehouse_id,order_date,expect_date,buyer,status,out_type,process_fee,settle_type,remark,created_by)
           VALUES (?,?,?,?,?,?,?, 'draft',?,?,?,?,?)`
        )
        .run(
          docNo, supplier_id, warehouse_id, material_warehouse_id || null, odDate, expect_date || null,
          u.name || null, out_type, Number(process_fee || 0), settle_type || null, remark || null, u.uid || null
        )
      const oid = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO outsourcing_order_items (order_id,role,sku_id,qty,price,amount,remark) VALUES (?,?,?,?,?,?,?)'
      )
      for (const it of items) {
        const qty = Number(it.qty)
        const price = Number(it.price || 0)
        insItem.run(oid, it.role, it.sku_id, qty, price, Number((qty * price).toFixed(2)), it.remark || null)
      }
      recalcOrder(db, oid)
      return oid
    })
    const id = tx()
    audit(req, { action: 'CREATE', module: 'outsourcing', entity: 'outsourcing_orders', entityId: id })
    return ok(res, loadOrder(db, id))
  })
)

r.put(
  '/orders/:id',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM outsourcing_orders WHERE id=?').get(id)
    if (!order) return fail(res, '委外订单不存在', 404)
    if (order.status !== 'draft') return fail(res, '只有草稿状态的委外订单可以修改')
    const { supplier_id, warehouse_id, material_warehouse_id, order_date, expect_date, out_type, process_fee, settle_type, remark, items } = req.body || {}
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE outsourcing_orders SET supplier_id=?, warehouse_id=?, material_warehouse_id=?, order_date=?, expect_date=?,
           out_type=?, process_fee=?, settle_type=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(
        supplier_id ?? order.supplier_id,
        warehouse_id ?? order.warehouse_id,
        material_warehouse_id ?? order.material_warehouse_id,
        order_date ?? order.order_date,
        expect_date ?? order.expect_date,
        out_type ?? order.out_type,
        process_fee ?? order.process_fee,
        settle_type ?? order.settle_type,
        remark ?? order.remark,
        id
      )
      if (Array.isArray(items)) {
        db.prepare('DELETE FROM outsourcing_order_items WHERE order_id=?').run(id)
        const insItem = db.prepare(
          'INSERT INTO outsourcing_order_items (order_id,role,sku_id,qty,price,amount,remark) VALUES (?,?,?,?,?,?,?)'
        )
        for (const it of items) {
          const qty = Number(it.qty)
          const price = Number(it.price || 0)
          insItem.run(id, it.role, it.sku_id, qty, price, Number((qty * price).toFixed(2)), it.remark || null)
        }
      }
      recalcOrder(db, id)
    })
    tx()
    return ok(res, loadOrder(db, id))
  })
)

r.post(
  '/orders/:id/status',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM outsourcing_orders WHERE id=?').get(id)
    if (!order) return fail(res, '委外订单不存在', 404)
    const t = tryTransition({
      db,
      docType: 'WW',
      id,
      action: req.body?.action,
      remark: req.body?.remark,
      actor: { id: req.user.uid, name: req.user.name || req.user.username },
      source: 'api'
    })
    if (!t.ok) return bizFail(res, t.error)
    audit(req, { action: t.data.action.toUpperCase(), module: 'outsourcing', entity: 'outsourcing_orders', entityId: id })
    return ok(res, loadOrder(db, id))
  })
)

// ---------- 委外发料（材料出库到加工商）----------
r.post(
  '/orders/:id/issue',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM outsourcing_orders WHERE id=?').get(id)
    if (!order) return fail(res, '委外订单不存在', 404)
    if (!['approved', 'issued', 'part_received'].includes(order.status)) return fail(res, '只有已审批的委外订单可以发料')
    const whId = order.material_warehouse_id || order.warehouse_id
    const materials = db
      .prepare("SELECT * FROM outsourcing_order_items WHERE order_id=? AND role='material' AND qty - issued_qty > 0")
      .all(id)
    if (!materials.length) return fail(res, '没有待发材料（或已全部发料）')
    const payload = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items : materials.map((m) => ({ id: m.id, qty: m.qty - m.issued_qty }))
    const issueDate = req.body?.issue_date || localDate()
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'WWF', 'outsourcing_materials', 'doc_no', issueDate)
      const info = db
        .prepare(
          `INSERT INTO outsourcing_materials (doc_no,order_id,supplier_id,warehouse_id,issue_date,status,total_qty,total_amount,operator,remark,created_by)
           VALUES (?,?,?,?,?, 'issued',0,0,?,?,?)`
        )
        .run(docNo, id, order.supplier_id, whId, issueDate, u.name || null, req.body?.remark || `委外发料 ${order.doc_no}`, u.uid || null)
      const issueId = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO outsourcing_material_items (issue_id,sku_id,batch_no,qty,cost_price,amount) VALUES (?,?,?,?,?,?)'
      )
      let tq = 0
      let ta = 0
      const skipped = []
      for (const ln of payload) {
        const src = materials.find((m) => m.id === Number(ln.id ?? ln.item_id))
        if (!src) {
          skipped.push({ id: ln.id ?? ln.item_id ?? null, reason: '匹配不到本单待发明细行' })
          continue
        }
        // `??` 而不是 `||`：显式传 `qty:0` 不能被当成"没传"而回落到整行余量（那是两种完全不同的意图）
        const qty = ln.qty == null || ln.qty === '' ? src.qty - src.issued_qty : Number(ln.qty)
        if (!(qty > 0)) {
          skipped.push({ id: src.id, reason: `发料数量必须大于 0（收到 ${ln.qty}）` })
          continue
        }
        const { picks, shortage } = pickBatches(db, whId, src.sku_id, qty)
        if (shortage > 0) {
          const err = new Error(`材料库存不足，无法发料：SKU#${src.sku_id} 缺 ${shortage}`)
          err.status = 400
          throw err
        }
        for (const b of picks) {
          insItem.run(issueId, src.sku_id, b.batchNo, b.qty, b.unitCost || 0, Number((b.qty * (b.unitCost || 0)).toFixed(2)))
          applyStockOut(db, {
            warehouseId: whId, skuId: src.sku_id, qty: b.qty, batchNo: b.batchNo, bizDate: issueDate,
            docType: 'WWS_OUT', docNo, docId: issueId, counterparty: `委外加工 ${order.doc_no}`, operator: u.name,
            remark: '委外发料出库'
          })
          tq += b.qty
          ta += b.qty * (b.unitCost || 0)
        }
        db.prepare('UPDATE outsourcing_order_items SET issued_qty = issued_qty + ? WHERE id=?').run(qty, src.id)
      }
      // M9：先把"这次到底发了什么"定下来，再决定要不要留一张单 —— 一张 0 数量的发料单
      // 会让"料已发出"这件事变成假的（状态照样推进），而它不报错、只在对账时才露出来。
      if (skipped.length) throw badLines('发料', skipped)
      if (!(tq > 0)) {
        const err = new Error('本次没有可发料的数量，未生成发料单')
        err.status = 400
        throw err
      }
      db.prepare('UPDATE outsourcing_materials SET total_qty=?, total_amount=? WHERE id=?').run(tq, Number(ta.toFixed(2)), issueId)
      // M7/G3：状态推进**走内核**（原来是裸 `UPDATE ... SET status='issued'`）。
      // 三条边都在 STATES/ACTIONS.WW 里注册过：approved→issued 是真推进，
      // issued→issued / part_received→part_received 是"继续发料"的自环（只为留痕，不改状态）。
      // 不走内核的后果是 doc_events 里永远没有这张单的发料记录（A5「单据一生是空的」）。
      const actor = { id: u.uid || null, name: u.name || null }
      applyTransition({
        db, docType: 'WW', id, action: 'issue', actor, source: 'api',
        remark: `发料单 ${docNo}，本次 ${tq} 件`
      })
      recalcOrder(db, id)
      return { issueId, docNo }
    })()
    audit(req, { action: 'ISSUE', module: 'outsourcing', entity: 'outsourcing_materials', entityId: result.issueId, detail: result.docNo })
    return ok(res, { issue_id: result.issueId, doc_no: result.docNo, order: loadOrder(db, id) })
  })
)

// ---------- 委外收货（成品入库，计加工费）----------
r.post(
  '/orders/:id/receive',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM outsourcing_orders WHERE id=?').get(id)
    if (!order) return fail(res, '委外订单不存在', 404)
    if (!['issued', 'part_received', 'approved'].includes(order.status)) return fail(res, '请先发料或审批后再收货')
    const products = db
      .prepare("SELECT * FROM outsourcing_order_items WHERE order_id=? AND role='product' AND qty - received_qty > 0")
      .all(id)
    if (!products.length) return fail(res, '没有待收货的成品（或已全部收货）')
    const receiptDate = req.body?.receipt_date || localDate()
    const payload = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items : products.map((p) => ({ id: p.id, qty: p.qty - p.received_qty, price: p.price }))
    const result = db.transaction(() => {
      const docNo = nextDocNo(db, 'WWS', 'outsourcing_receipts', 'doc_no', receiptDate)
      const info = db
        .prepare(
          `INSERT INTO outsourcing_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,process_fee,total_amount,inspector,remark,created_by)
           VALUES (?,?,?,?,?, 'received',0,0,0,?,?,?)`
        )
        .run(docNo, id, order.supplier_id, order.warehouse_id, receiptDate, req.body?.inspector || u.name || null, req.body?.remark || `委外收货 ${order.doc_no}`, u.uid || null)
      const rid = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO outsourcing_receipt_items (receipt_id,sku_id,batch_no,produce_date,expire_date,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
      )
      let tq = 0
      let tFee = 0
      let tAmt = 0
      const skipped = []
      for (const ln of payload) {
        const src = products.find((p) => p.id === Number(ln.id ?? ln.item_id))
        if (!src) {
          skipped.push({ id: ln.id ?? ln.item_id ?? null, reason: '匹配不到本单待收成品行' })
          continue
        }
        const qty = ln.qty == null || ln.qty === '' ? src.qty - src.received_qty : Number(ln.qty)
        if (!(qty > 0)) {
          skipped.push({ id: src.id, reason: `收货数量必须大于 0（收到 ${ln.qty}）` })
          continue
        }
        const fee = Number(ln.price ?? src.price ?? 0)      // 单位加工费
        const sku = db.prepare('SELECT s.*, p.shelf_life_months FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?').get(src.sku_id)
        const batchNo = ln.batch_no || nextBatchNo(sku.sku_code, receiptDate)
        const expire = sku.shelf_life_months
          ? addDays(localDate(), sku.shelf_life_months * 30)
          : null
        insItem.run(rid, src.sku_id, batchNo, receiptDate, expire, qty, fee, Number((qty * fee).toFixed(2)))
        // 入库单位成本 = 材料成本分摊 + 加工费（用友口径：委外入库成本含料含工）
        const materialShare = Number(order.product_qty) > 0 ? Number(order.material_amount) / Number(order.product_qty) : 0
        const unitCost = Number((materialShare + fee).toFixed(2))
        applyStockIn(db, {
          bizDate: receiptDate, docType: 'WWS_IN', docNo, docId: rid,
          warehouseId: order.warehouse_id, skuId: src.sku_id, batchNo,
          produceDate: receiptDate, expireDate: expire, qty, unitCost,
          counterparty: `委外加工 ${order.doc_no}`, operator: u.name, remark: '委外收货入库'
        })
        db.prepare('UPDATE outsourcing_order_items SET received_qty = received_qty + ? WHERE id=?').run(qty, src.id)
        tq += qty
        tFee += qty * fee
        tAmt += qty * unitCost
      }
      // M9：匹配不上的行 / 数量为 0 的行**必须报错**，不许静默跳过 ——
      // 否则会留下"一张 0 数量收货单 + 订单状态已推进"这种不报错的错账。
      if (skipped.length) throw badLines('收货', skipped)
      if (!(tq > 0)) {
        const err = new Error('本次没有可收货的数量，未生成收货单')
        err.status = 400
        throw err
      }
      db.prepare('UPDATE outsourcing_receipts SET total_qty=?, process_fee=?, total_amount=? WHERE id=?').run(
        tq, Number(tFee.toFixed(2)), Number(tAmt.toFixed(2)), rid
      )
      // M7/G3：状态推进走内核（原来是一句裸 `UPDATE outsourcing_orders SET status=?`）。
      // 收满 → `receive`（→received）；还有欠交 → `partial`（→part_received）。
      // 两种目标状态不能共用同一个 (action, from_state)：`doc_actions` 上有
      // `UNIQUE (doc_type, action, from_state)`，所以这里按"是否收满"选动作码，
      // 而不是把目标状态算出来直接 UPDATE（那正是这段代码原来绕开内核的方式）。
      // 状态**只在本次确实收了货时才推进** —— 上面已经用 `tq > 0` 挡住空推进。
      const pend = db.prepare("SELECT COALESCE(SUM(qty-received_qty),0) p FROM outsourcing_order_items WHERE order_id=? AND role='product'").get(id).p
      applyTransition({
        db, docType: 'WW', id, action: pend <= 0.0001 ? 'receive' : 'partial',
        actor: { id: u.uid || null, name: u.name || null }, source: 'api',
        remark: `收货单 ${docNo}，本次 ${tq} 件`
      })
      return { rid, docNo, tq, tFee }
    })()
    audit(req, { action: 'RECEIVE', module: 'outsourcing', entity: 'outsourcing_receipts', entityId: result.rid, detail: result.docNo })
    return ok(res, { receipt_id: result.rid, doc_no: result.docNo, order: loadOrder(db, id) })
  })
)

// ---------- 发料单 / 收货单 列表 ----------
r.get(
  '/materials',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = 'outsourcing_materials m LEFT JOIN suppliers s ON s.id=m.supplier_id LEFT JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN outsourcing_orders o ON o.id=m.order_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM}`).get().c
    const rows = db
      .prepare(
        `SELECT m.*, s.name AS supplier_name, w.name AS warehouse_name, o.doc_no AS order_no,
                (SELECT COUNT(*) FROM outsourcing_material_items i WHERE i.issue_id=m.id) AS item_count
         FROM ${FROM} ORDER BY m.id DESC LIMIT ? OFFSET ?`
      )
      .all(pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/receipts',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = 'outsourcing_receipts rc LEFT JOIN suppliers s ON s.id=rc.supplier_id LEFT JOIN warehouses w ON w.id=rc.warehouse_id LEFT JOIN outsourcing_orders o ON o.id=rc.order_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM}`).get().c
    const rows = db
      .prepare(
        `SELECT rc.*, s.name AS supplier_name, w.name AS warehouse_name, o.doc_no AS order_no,
                (SELECT COUNT(*) FROM outsourcing_receipt_items i WHERE i.receipt_id=rc.id) AS item_count
         FROM ${FROM} ORDER BY rc.id DESC LIMIT ? OFFSET ?`
      )
      .all(pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

// ---------- 委外收货单质检（WR.inspect：received → inspected） ----------
// 内核 `008_doc_kernel.cjs` 的 `ACTIONS.WR` 里**早就登记了这条边**（`inspect`，`quality.inspect`，非危险），
// 但后端从来没有对应路由 ⇒ 库里停在 `received` 的委外收货单**永远走不到 `inspected`**，
// 界面上也没有任何入口（实测三库：cosmetic 2 张 / apparel 2 张 / food 0 张停在 received）。
// 本端点只做两件事：**把状态推过去 + 留下真实痕迹**。
// ⚠️ **不动库存**：入库那一步（`POST /orders/:id/receive`）已经 `applyStockIn` 过一次，
//    质检再入一次就是把同一批货记两遍 —— 所以这里不许有任何库存副作用。
r.post(
  '/receipts/:id/inspect',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = db.prepare('SELECT id, doc_no, status FROM outsourcing_receipts WHERE id=?').get(id)
    if (!head) return fail(res, '委外收货单不存在', 404)
    // 可选 `{ inspector, remark }`：传了就用，没传就取当前用户；两者只进留痕的 payload，不落新列。
    const inspector = String(req.body?.inspector || '').trim() || u.name || u.username || null
    const remark = String(req.body?.remark || '').trim() || null
    // 非法来源态**不在这里判** —— 内核 `findAction` 会抛带 `httpStatus` 的 `DocFlowError`，
    // `wrap` 转交全局中间件后按 409 返回。两份判据必然分叉，这是本项目铁律。
    advanceStatus(db, req, {
      docType: 'WR',
      id,
      action: 'inspect',
      remark: remark || `委外收货单质检 ${head.doc_no || id}`,
      payload: { inspector, remark }
    })
    audit(req, { action: 'INSPECT', module: 'outsourcing', entity: 'outsourcing_receipts', entityId: id, detail: head.doc_no })
    return ok(res, { id, status: 'inspected' })
  })
)

// ---------- 委外结算（按供应商 × 期间汇总加工费，用友委外核销口径） ----------
r.get(
  '/settlements',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const start = req.query.startDate || localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
    const end = req.query.endDate || localDate()
    const rows = db
      .prepare(
        `SELECT s.id AS supplier_id, s.name AS supplier_name,
                COUNT(DISTINCT o.id) order_count,
                COALESCE(SUM(rc.total_qty),0) received_qty,
                COALESCE(SUM(rc.process_fee),0) process_fee,
                COALESCE(SUM(rc.total_amount),0) inbound_amount
         FROM outsourcing_receipts rc
         JOIN outsourcing_orders o ON o.id=rc.order_id
         JOIN suppliers s ON s.id=rc.supplier_id
         WHERE rc.receipt_date BETWEEN ? AND ?
         GROUP BY s.id ORDER BY process_fee DESC`
      )
      .all(start, end)
    const totals = rows.reduce(
      (a, x) => {
        a.received_qty += Number(x.received_qty || 0)
        a.process_fee += Number(x.process_fee || 0)
        a.inbound_amount += Number(x.inbound_amount || 0)
        return a
      },
      { received_qty: 0, process_fee: 0, inbound_amount: 0 }
    )
    return ok(res, { start, end, rows, totals })
  })
)

// ---------- 统计 ----------
r.get(
  '/stats',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const byStatus = db.prepare('SELECT status, COUNT(*) cnt, COALESCE(SUM(process_fee),0) fee FROM outsourcing_orders GROUP BY status').all()
    const topSuppliers = db
      .prepare(
        `SELECT s.name, COUNT(o.id) orders, COALESCE(SUM(o.process_fee),0) fee
         FROM outsourcing_orders o JOIN suppliers s ON s.id=o.supplier_id
         GROUP BY s.id ORDER BY fee DESC LIMIT 8`
      )
      .all()
    const pending = db
      .prepare("SELECT COUNT(*) c FROM outsourcing_orders WHERE status IN ('submitted','approved','issued','part_received')")
      .get().c
    return ok(res, { byStatus, topSuppliers, pending })
  })
)

export default r
