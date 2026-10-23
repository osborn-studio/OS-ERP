/**
 * ============================================================================
 * 文件标识：server/routes/inventory.js ｜ 存货路由：库存与批次、收发存台账、成本、序列号、调拨、盘点、组装拆卸、预警、库龄/ABC
 * ============================================================================
 * 【职责】存货路由：库存与批次、收发存台账、成本、序列号、调拨、盘点、组装拆卸、预警、库龄/ABC
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
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole, requireInternal, attachOrgScope, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { withWriteRetry } from '../lib/tx.js'
import { nextDocNo } from '../lib/docno.js'
// findAction / applyTransition 曾用于调拨的原地实现，现已收进 `lib/transfer.js`，这里不再直接用。
import { advanceStatus, tryTransition, nowText } from '../lib/docflow.js'
import {
  applyStockIn, applyStockOut, applyStockGain, pickBatches, getStockRow, DOC_TYPE_LABEL,
  stockScopeSql, warehouseInScope, assertWarehouseInScope, assertStockDocInScope
} from '../lib/stock.js'
// 调拨单的建单 / 出库 / 入库只有一份实现（`lib/transfer.js`）——
// 质检的不良品处置（让步→不合格仓、返工→待检仓）也要产生调拨单，
// 服务层不能反向依赖路由，两份实现必然在「成本回写」上分叉。这里只负责权限、审计与 HTTP 外壳。
import {
  createTransfer, shipTransfer, receiveTransfer,
  transferScopeSql, assertTransferTargetsInScope, assertTransferInScope
} from '../lib/transfer.js'

const r = Router()
// ADR-0038：库存按仓库所属组织（warehouses.org_id）收口；req.orgScope 由 attachOrgScope 解析，下面每条路由都用 stockScopeSql 落地。
r.use(requireAuth, requireInternal('总部库存明细；门店库存请使用门店POS'), attachOrgScope)
const W = ['warehouse', 'scm', 'admin']

const STOCK_SELECT = `
  st.id, st.warehouse_id, st.sku_id, st.batch_no, st.produce_date, st.expire_date, st.entry_date, st.location,
  st.qty_on_hand, st.qty_reserved, (st.qty_on_hand - st.qty_reserved) AS qty_available,
  st.cost_price, (st.qty_on_hand * st.cost_price) AS amount, st.updated_at,
  sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, sk.safe_stock, sk.serial_managed,
  p.name AS product_name, p.spu_code, p.unit,
  b.name AS brand_name, c.name AS category_name,
  w.name AS warehouse_name, w.type AS warehouse_type
`
const STOCK_FROM = `
  inventory_stocks st
  JOIN product_skus sk ON sk.id = st.sku_id
  JOIN products p ON p.id = sk.product_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
  JOIN warehouses w ON w.id = st.warehouse_id
`

// ---------- 库存查询 ----------
r.get(
  '/stocks',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = ['st.qty_on_hand <> 0']
    const params = []
    const sc = stockScopeSql(req.orgScope, 'st')
    conds.push(sc.sql)
    params.push(...sc.params)
    if (req.query.warehouse_id) {
      conds.push('st.warehouse_id = ?')
      params.push(Number(req.query.warehouse_id))
    }
    if (req.query.brand_id) {
      conds.push('p.brand_id = ?')
      params.push(Number(req.query.brand_id))
    }
    if (req.query.category_id) {
      conds.push('p.category_id = ?')
      params.push(Number(req.query.category_id))
    }
    if (req.query.sku_id) {
      conds.push('st.sku_id = ?')
      params.push(Number(req.query.sku_id))
    }
    if (req.query.batch_no) {
      conds.push('st.batch_no LIKE ?')
      params.push(`%${req.query.batch_no}%`)
    }
    if (req.query.keyword) {
      conds.push('(sk.sku_code LIKE ? OR sk.name LIKE ? OR p.name LIKE ? OR st.batch_no LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    if (req.query.onlyAvailable === '1') conds.push('(st.qty_on_hand - st.qty_reserved) > 0')
    if (req.query.expiring) {
      const days = Number(req.query.expiring)
      conds.push(`st.expire_date IS NOT NULL AND st.expire_date <> '' AND st.expire_date <= date('now','localtime','+${days} day')`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM ${STOCK_FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${STOCK_SELECT} FROM ${STOCK_FROM} ${where} ORDER BY w.id, sk.sku_code, st.expire_date LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    const sum = db
      .prepare(
        `SELECT COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount FROM ${STOCK_FROM} ${where}`
      )
      .get(...params)
    return paged(res, { rows, total, page, pageSize, summary: sum })
  })
)

// 按商品汇总（跨仓库）
r.get(
  '/stocks/by-sku',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.keyword) {
      conds.push('(sk.sku_code LIKE ? OR sk.name LIKE ? OR p.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw)
    }
    if (req.query.category_id) {
      conds.push('p.category_id = ?')
      params.push(Number(req.query.category_id))
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    // 范围谓词放在 JOIN 的 ON 里（不是 WHERE）：范围外的仓不计入汇总，但商品行本身仍在（库存为 0）。
    const sc = stockScopeSql(req.orgScope, 'st')
    const base = `FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN inventory_stocks st ON st.sku_id=sk.id AND ${sc.sql}`
    const total = db.prepare(`SELECT COUNT(DISTINCT sk.id) c ${base} ${where}`).get(...sc.params, ...params).c
    const rows = db
      .prepare(
        `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, sk.spec, sk.safe_stock, sk.price_retail, sk.price_dealer, sk.cost_std,
                p.name AS product_name, b.name AS brand_name, c.name AS category_name,
                COALESCE(SUM(st.qty_on_hand),0) qty_on_hand,
                COALESCE(SUM(st.qty_reserved),0) qty_reserved,
                COALESCE(SUM(st.qty_on_hand - st.qty_reserved),0) qty_available,
                COALESCE(SUM(st.qty_on_hand * st.cost_price),0) amount,
                COUNT(DISTINCT CASE WHEN st.qty_on_hand <> 0 THEN st.warehouse_id END) warehouse_count,
                CASE WHEN COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock THEN 1 ELSE 0 END AS below_safe
         ${base} ${where}
         GROUP BY sk.id ORDER BY sk.sku_code LIMIT ? OFFSET ?`
      )
      .all(...sc.params, ...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

// ---------- 库存流水 / 台账 ----------
r.get(
  '/transactions',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    const sc = stockScopeSql(req.orgScope, 't')
    conds.push(sc.sql)
    params.push(...sc.params)
    for (const [k, col] of [
      ['sku_id', 't.sku_id'],
      ['warehouse_id', 't.warehouse_id'],
      ['doc_type', 't.doc_type'],
      ['doc_no', 't.doc_no']
    ]) {
      if (req.query[k]) {
        conds.push(`${col} = ?`)
        params.push(k === 'sku_id' || k === 'warehouse_id' ? Number(req.query[k]) : req.query[k])
      }
    }
    if (req.query.startDate) {
      conds.push('t.biz_date >= ?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('t.biz_date <= ?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(sk.sku_code LIKE ? OR sk.name LIKE ? OR p.name LIKE ? OR t.doc_no LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `inventory_transactions t JOIN product_skus sk ON sk.id=t.sku_id JOIN products p ON p.id=sk.product_id
      LEFT JOIN warehouses w ON w.id=t.warehouse_id`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT t.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name
         FROM ${FROM} ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, {
      rows: rows.map((x) => ({ ...x, doc_type_name: DOC_TYPE_LABEL[x.doc_type] || x.doc_type })),
      total,
      page,
      pageSize
    })
  })
)

// 收发存台账（某 SKU 某期间的期初/入库/出库/期末）
r.get(
  '/ledger',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const skuId = Number(req.query.sku_id)
    if (!skuId) return fail(res, '请指定 sku_id')
    const start = req.query.startDate || addDays(localDate(), -30)
    const end = req.query.endDate || localDate()
    const sc = stockScopeSql(req.orgScope)
    const whCond = (req.query.warehouse_id ? ' AND warehouse_id = ?' : '') + ` AND ${sc.sql}`
    const whParams = [...(req.query.warehouse_id ? [Number(req.query.warehouse_id)] : []), ...sc.params]
    const opening = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN qty ELSE -qty END),0) q
         FROM inventory_transactions WHERE sku_id=? AND biz_date < ?${whCond}`
      )
      .get(skuId, start, ...whParams).q
    const rows = db
      .prepare(
        `SELECT biz_date, doc_type, doc_no, direction, qty, unit_cost, amount, balance_qty, warehouse_id, counterparty
         FROM inventory_transactions WHERE sku_id=? AND biz_date BETWEEN ? AND ?${whCond}
         ORDER BY biz_date, id`
      )
      .all(skuId, start, end, ...whParams)
    const inQty = rows.filter((x) => x.direction === 'in').reduce((s, x) => s + x.qty, 0)
    const outQty = rows.filter((x) => x.direction === 'out').reduce((s, x) => s + x.qty, 0)
    const sku = db
      .prepare('SELECT sk.*, p.name AS product_name, p.unit FROM product_skus sk JOIN products p ON p.id=sk.product_id WHERE sk.id=?')
      .get(skuId)
    return ok(res, {
      sku,
      period: { start, end },
      opening: Number(opening.toFixed(2)),
      inQty: Number(inQty.toFixed(2)),
      outQty: Number(outQty.toFixed(2)),
      closing: Number((opening + inQty - outQty).toFixed(2)),
      detail: rows.map((x) => ({ ...x, doc_type_name: DOC_TYPE_LABEL[x.doc_type] || x.doc_type }))
    })
  })
)

// ---------- 预警 ----------
r.get(
  '/alerts',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const sc = stockScopeSql(req.orgScope, 'st')
    const belowSafe = db
      .prepare(
        `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock,
                COALESCE(SUM(st.qty_on_hand),0) qty_on_hand, sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0) shortage
         FROM product_skus sk JOIN products p ON p.id=sk.product_id
         LEFT JOIN inventory_stocks st ON st.sku_id=sk.id AND ${sc.sql}
         WHERE sk.status='active' AND sk.safe_stock > 0
         GROUP BY sk.id HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock
         ORDER BY shortage DESC LIMIT 50`
      )
      .all(...sc.params)
    const expiring = db
      .prepare(
        `SELECT st.id, st.batch_no, st.expire_date, st.qty_on_hand, st.warehouse_id, sk.sku_code, sk.name AS sku_name,
                w.name AS warehouse_name,
                CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id
         WHERE st.qty_on_hand > 0 AND st.expire_date IS NOT NULL AND st.expire_date <> ''
           AND st.expire_date <= date('now','localtime','+180 day') AND ${sc.sql}
         ORDER BY st.expire_date LIMIT 100`
      )
      .all(...sc.params)
    const zeroStock = db
      .prepare(
        `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name FROM product_skus sk
         WHERE sk.status='active' AND NOT EXISTS (SELECT 1 FROM inventory_stocks st WHERE st.sku_id=sk.id AND st.qty_on_hand>0 AND ${sc.sql})
         LIMIT 50`
      )
      .all(...sc.params)
    const frozen = db
      .prepare(
        `SELECT st.id, st.batch_no, st.qty_on_hand, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name,
                CAST(julianday('now','localtime') - julianday(st.updated_at) AS INTEGER) AS idle_days
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id
         WHERE st.qty_on_hand > 0 AND st.updated_at <= datetime('now','localtime','-90 day') AND ${sc.sql} ORDER BY idle_days DESC LIMIT 50`
      )
      .all(...sc.params)
    return ok(res, {
      belowSafe,
      expiring: expiring.map((x) => ({ ...x, level: x.days_left < 0 ? 'expired' : x.days_left <= 30 ? 'danger' : x.days_left <= 90 ? 'warning' : 'notice' })),
      zeroStock,
      frozen
    })
  })
)

// ---------- 库存调整 ----------
r.post(
  '/adjust',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { warehouse_id, sku_id, batch_no = '', qty, direction, reason, biz_date } = req.body || {}
    if (!warehouse_id || !sku_id) return fail(res, '请选择仓库与商品')
    // ADR-0038：写目标仓必须在调用者组织范围内（范围外 / 不存在 / 无归属一律 403，先于任何查询与写）
    assertWarehouseInScope(db, warehouse_id, req.orgScope)
    // 出入库工具函数统一使用 batchNo 命名
    const batchNo = batch_no || ''
    if (!db.prepare('SELECT id FROM warehouses WHERE id=?').get(Number(warehouse_id))) return fail(res, '仓库不存在')
    if (!db.prepare('SELECT id FROM product_skus WHERE id=?').get(Number(sku_id))) return fail(res, '商品 SKU 不存在')
    const n = Math.abs(Number(qty || 0))
    if (!(n > 0)) return fail(res, '调整数量必须大于 0')
    const dir = direction || 'in'
    const docNo = `ADJ${Date.now().toString().slice(-10)}`
    const tx = db.transaction(() => {
      if (dir === 'in') {
        // [06] 调整入库（盘盈）按该 (仓, SKU, 批次, 货主, 币种) 的**当前结存均价**入库：
        // 数量增加、金额等比例增加，均价不变。原来一律按 0 成本入，会把账做歪且不报错 ——
        // 实测 10 件 @100 ⇒ 盘盈 +10 ⇒ 20 件仍记 1000（均价被摊成 50）⇒ 再盘亏 −10（按均价）
        // ⇒ 只剩 10 件 500 元：数量回到原值，金额却少了 500。
        // 行的定位与 applyStockIn 内部完全同一套口径（getStockRow 的货主/币种解析），
        // 所以「取不到行」= 引擎确实会新建一行，此时保持 0 成本，但**在返回体里明说**（不静默）。
        const gained = applyStockGain(db, {
          bizDate: biz_date || localDate(), docType: 'ADJ_IN', docNo,
          warehouseId: warehouse_id, skuId: sku_id, batchNo, qty: n, operator: u.name, remark: reason || '手工调整入库'
        })
        return { unitCost: gained.gainUnitCost, costSource: gained.costSource }
      }
      applyStockOut(db, {
        bizDate: biz_date || localDate(), docType: 'ADJ_OUT', docNo,
        warehouseId: warehouse_id, skuId: sku_id, batchNo, qty: n, operator: u.name, remark: reason || '手工调整出库'
      })
      return null
    })
    const info = tx()
    audit(req, { action: 'ADJUST', module: 'inventory', entity: 'inventory_stocks', entityId: sku_id, detail: `${dir}:${n}` })
    return ok(res, info
      ? { doc_no: docNo, unit_cost: info.unitCost, cost_source: info.costSource }
      : { doc_no: docNo })
  })
)

// ---------- 调拨 ----------
r.get(
  '/transfers',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = `stock_transfers t LEFT JOIN warehouses fw ON fw.id=t.from_warehouse_id LEFT JOIN warehouses tw ON tw.id=t.to_warehouse_id`
    // ADR-0038：读 —— 调出 / 调入任一端在范围内即可见
    const sc = transferScopeSql(req.orgScope, 't')
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} WHERE ${sc.sql}`).get(...sc.params).c
    const rows = db
      .prepare(
        `SELECT t.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name,
                (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id=t.id) AS item_count
         FROM ${FROM} WHERE ${sc.sql} ORDER BY t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...sc.params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/transfers/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    assertTransferInScope(db, Number(req.params.id), req.orgScope)
    const head = db
      .prepare(
        `SELECT t.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name FROM stock_transfers t
         LEFT JOIN warehouses fw ON fw.id=t.from_warehouse_id LEFT JOIN warehouses tw ON tw.id=t.to_warehouse_id WHERE t.id=?`
      )
      .get(Number(req.params.id))
    if (!head) return fail(res, '调拨单不存在', 404)
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM stock_transfer_items i
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id WHERE i.transfer_id=?`
      )
      .all(head.id)
    return ok(res, head)
  })
)

r.post(
  '/transfers',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { from_warehouse_id, to_warehouse_id, transfer_date, items = [], remark, type = 'normal', autoShip } = req.body || {}
    if (!from_warehouse_id || !to_warehouse_id) return fail(res, '请选择调出与调入仓库')
    if (Number(from_warehouse_id) === Number(to_warehouse_id)) return fail(res, '调出与调入仓库不能相同')
    if (!items.length) return fail(res, '请添加调拨明细')
    // ADR-0038：写 —— 调出 / 调入两端都必须在范围内（403，先于建单与任何库存动作）
    assertTransferTargetsInScope(db, from_warehouse_id, to_warehouse_id, req.orgScope)
    // 建单 / 出库的全部口径都在 `lib/transfer.js`（含单据日期兜底、G4 的 null 单价、
    // autoShip 后的成本回写）。这里只做 HTTP 层的校验与审计。
    const { id: tid } = withWriteRetry(db, () => createTransfer(db, {
      fromWarehouseId: from_warehouse_id,
      toWarehouseId: to_warehouse_id,
      // 单据日期兜底，避免未传日期时触发 NOT NULL 约束错误
      transferDate: String(transfer_date || '').trim() || localDate(),
      type,
      remark,
      actor: u,
      items,
      autoShip
    }), { label: 'transfer.create' })
    audit(req, { action: 'CREATE', module: 'inventory', entity: 'stock_transfers', entityId: tid })
    return ok(res, { id: tid })
  })
)

r.post(
  '/transfers/:id/ship',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    assertTransferInScope(db, id, req.orgScope, { write: true })
    withWriteRetry(db, () => shipTransfer(db, id, u), { label: 'transfer.ship' })
    audit(req, { action: 'SHIP', module: 'inventory', entity: 'stock_transfers', entityId: id })
    return ok(res, { id })
  })
)

r.post(
  '/transfers/:id/receive',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = assertTransferInScope(db, id, req.orgScope, { write: true })
    if (head.status !== 'shipped') return fail(res, '只有已出库的调拨单可以收货')
    // 入库口径在 `lib/transfer.js`（逐行 TR_IN + 内核流转），这里不做第二遍。
    withWriteRetry(db, () => receiveTransfer(db, id, u, { receiveDate: req.body?.receive_date || null }), { label: 'transfer.receive' })
    audit(req, { action: 'RECEIVE', module: 'inventory', entity: 'stock_transfers', entityId: id })
    return ok(res, { id })
  })
)

// 提交调拨单：**纯状态流转，不动库存**（出库仍在 /ship、入库在 /receive）。
// 边 `TF.submit`（draft→submitted）在内核里早已登记（`008_doc_kernel.cjs` 的 ACTIONS.TF），
// 但此前没有对应的后端路由 ⇒ 系统认为这一步合法，却没有任何人能触发它。
r.post(
  '/transfers/:id/submit',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = assertTransferInScope(db, id, req.orgScope, { write: true })
    // 状态推进的**唯一入口**是内核。这里**不写状态白名单** ——
    // 非法来源态由 advanceStatus 抛 DocFlowError（带 httpStatus），全局错误中间件转成 409/403/404。
    // 路由里再判一遍就是第二份判据，两份必然分叉。
    advanceStatus(db, req, { docType: 'TF', id, action: 'submit', remark: `提交调拨单 ${head.doc_no}` })
    audit(req, { action: 'SUBMIT', module: 'inventory', entity: 'stock_transfers', entityId: id })
    return ok(res, { id, status: 'submitted' })
  })
)

// 作废调拨单：出库前可用（draft / submitted 都能作废；已出库的单要去 /receive 或反向调拨）。
// ⚠️ 内核里 `TF.cancel` 是**两条边**（draft→cancelled 与 submitted→cancelled），action 都叫 `cancel`
// ⇒ 这里**只写一个路由**，让 advanceStatus 按当前状态自动选边。
// **不要**在路由里自己判断当前状态再分派：那是第二份判据，必然与内核分叉。
r.post(
  '/transfers/:id/cancel',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = assertTransferInScope(db, id, req.orgScope, { write: true })
    advanceStatus(db, req, { docType: 'TF', id, action: 'cancel', remark: `取消调拨单 ${head.doc_no}` })
    audit(req, { action: 'CANCEL', module: 'inventory', entity: 'stock_transfers', entityId: id })
    return ok(res, { id, status: 'cancelled' })
  })
)

// ---------- 盘点 ----------
r.get(
  '/checks',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = 'stock_checks c LEFT JOIN warehouses w ON w.id=c.warehouse_id'
    const sc = stockScopeSql(req.orgScope, 'c')
    const total = db.prepare(`SELECT COUNT(*) x FROM ${FROM} WHERE ${sc.sql}`).get(...sc.params).x
    const rows = db
      .prepare(`SELECT c.*, w.name AS warehouse_name FROM ${FROM} WHERE ${sc.sql} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
      .all(...sc.params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/checks/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    assertStockDocInScope(db, 'stock_checks', req.params.id, req.orgScope, { notFound: '盘点单不存在' })
    const head = db
      .prepare('SELECT c.*, w.name AS warehouse_name FROM stock_checks c LEFT JOIN warehouses w ON w.id=c.warehouse_id WHERE c.id=?')
      .get(Number(req.params.id))
    if (!head) return fail(res, '盘点单不存在', 404)
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM stock_check_items i
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id WHERE i.check_id=? ORDER BY i.id`
      )
      .all(head.id)
    return ok(res, head)
  })
)

// 生成盘点单：按仓库当前库存拉取账面数
r.post(
  '/checks',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { warehouse_id, check_date, sku_ids, checker, remark } = req.body || {}
    if (!warehouse_id) return fail(res, '请选择盘点仓库')
    assertWarehouseInScope(db, warehouse_id, req.orgScope)
    let stocks = db
      .prepare(
        `SELECT st.sku_id, st.batch_no, st.qty_on_hand FROM inventory_stocks st WHERE st.warehouse_id=? AND st.qty_on_hand <> 0`
      )
      .all(warehouse_id)
    if (Array.isArray(sku_ids) && sku_ids.length) {
      stocks = stocks.filter((s) => sku_ids.map(Number).includes(s.sku_id))
    }
    if (!stocks.length) return fail(res, '该仓库没有可盘点的库存')
    // 单据日期兜底，避免未传日期时触发 NOT NULL 约束错误
    const ckDate = String(check_date || '').trim() || localDate()
    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'SC', 'stock_checks', 'doc_no', ckDate)
      const info = db
        .prepare(
          `INSERT INTO stock_checks (doc_no,warehouse_id,check_date,status,checker,remark,created_by) VALUES (?,?,?,'draft',?,?,?)`
        )
        .run(docNo, warehouse_id, ckDate, checker || u.name || null, remark || null, u.uid || null)
      const cid = info.lastInsertRowid
      const ins = db.prepare(
        'INSERT INTO stock_check_items (check_id,sku_id,batch_no,book_qty,actual_qty,diff_qty) VALUES (?,?,?,?,?,0)'
      )
      for (const s of stocks) ins.run(cid, s.sku_id, s.batch_no || '', s.qty_on_hand, s.qty_on_hand)
      return cid
    })
    const cid = tx()
    audit(req, { action: 'CREATE', module: 'inventory', entity: 'stock_checks', entityId: cid })
    return ok(res, { id: cid })
  })
)

// 提交实盘数量
r.put(
  '/checks/:id/items',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = assertStockDocInScope(db, 'stock_checks', id, req.orgScope, { notFound: '盘点单不存在' })
    if (head.status === 'adjusted') return fail(res, '已调整的盘点单不能修改')
    const items = req.body?.items || []
    db.transaction(() => {
      for (const it of items) {
        const itemId = Number(it.id)
        // [02] 两条口径都按门店盘点（lib/pos2.js:1211-1223）对齐：
        //   ① **账面数一律从库里取**，不信客户端传来的 book_qty。
        //      信它的后果不是"算错一次"：客户端只要把 book_qty 报成 actual_qty，差异就恒为 0 ——
        //      盘点单上看不出任何异常，货却已经对不上了（实测 10 万件盘盈被静默吞掉）。
        //   ② UPDATE 必须带 `AND check_id=?`。只按 id 更新时，拿盘点单 B 的 URL
        //      就能改盘点单 A 的行（实测复现）。
        const row = db.prepare('SELECT book_qty FROM stock_check_items WHERE id=? AND check_id=?').get(itemId, id)
        if (!row) continue
        const actual = Number(it.actual_qty || 0)
        db.prepare('UPDATE stock_check_items SET actual_qty=?, diff_qty=?, reason=? WHERE id=? AND check_id=?').run(
          actual, Number((actual - Number(row.book_qty)).toFixed(2)), it.reason || null, itemId, id
        )
      }
      const diff = db.prepare('SELECT COALESCE(SUM(diff_qty),0) d FROM stock_check_items WHERE check_id=?').get(id).d
      advanceStatus(db, req, { docType: 'CK', id, action: 'start', set: { total_diff_qty: Number(diff.toFixed(2)) }, remark: '录入实盘数量' })
    })()
    return ok(res, { id })
  })
)

// 差异过账：生成盘盈/盘亏
r.post(
  '/checks/:id/adjust',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = assertStockDocInScope(db, 'stock_checks', id, req.orgScope, { notFound: '盘点单不存在' })
    if (head.status === 'adjusted') return fail(res, '该盘点单已经调整过')
    const items = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(id)
    // 全新行（库存行不存在）只能按 0 成本入账 —— 这不是错误，但必须**露出来**（不静默）
    const zeroCostLines = []
    db.transaction(() => {
      for (const it of items) {
        if (Math.abs(it.diff_qty) < 0.0001) continue
        if (it.diff_qty > 0) {
          // [06] 盘盈按该 (仓, SKU, 批次, 货主, 币种) 的**当前结存均价**入库：数量增加、
          // 金额等比例增加、均价不变。一律按 0 成本入的后果见 /adjust 里的说明（一盈一亏少 500 元）。
          const gained = applyStockGain(db, {
            bizDate: head.check_date, docType: 'ADJ_IN', docNo: head.doc_no, docId: id,
            warehouseId: head.warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: it.diff_qty,
            operator: u.name, remark: `盘盈 ${it.reason || ''}`
          })
          if (gained.costSource === 'new_row_zero_cost') zeroCostLines.push({ sku_id: it.sku_id, batch_no: it.batch_no || '', qty: it.diff_qty })
        } else {
          applyStockOut(db, {
            bizDate: head.check_date, docType: 'ADJ_OUT', docNo: head.doc_no, docId: id,
            warehouseId: head.warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: Math.abs(it.diff_qty),
            operator: u.name, remark: `盘亏 ${it.reason || ''}`
          })
        }
      }
      advanceStatus(db, req, { docType: 'CK', id, action: 'adjust', remark: '盘点差异调整入账' })
    })()
    audit(req, { action: 'ADJUST', module: 'inventory', entity: 'stock_checks', entityId: id })
    return ok(res, { id, zero_cost_lines: zeroCostLines })
  })
)

// 作废盘点单：草稿（还没录实盘数量）时可用 —— 这时候差异还没入账，作废不该动任何库存。
// 边 `CK.cancel`（draft→cancelled）在内核里早已登记，此前没有后端路由。
r.post(
  '/checks/:id/cancel',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = assertStockDocInScope(db, 'stock_checks', id, req.orgScope, { notFound: '盘点单不存在' })
    // 状态推进走内核（非法来源态抛 DocFlowError → 409），见 /transfers/:id/cancel 的说明。
    advanceStatus(db, req, { docType: 'CK', id, action: 'cancel', remark: `取消盘点单 ${head.doc_no}` })
    audit(req, { action: 'CANCEL', module: 'inventory', entity: 'stock_checks', entityId: id })
    return ok(res, { id, status: 'cancelled' })
  })
)

// ---------- 库存总览 ----------
r.get(
  '/stats',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const scW = stockScopeSql(req.orgScope, 'w', 'id') // 仓库表自身
    const scS = stockScopeSql(req.orgScope, 'st') // 库存行
    const scT = stockScopeSql(req.orgScope) // 流水（无别名）
    const byWarehouse = db
      .prepare(
        `SELECT w.name AS warehouse_name, w.type, COUNT(DISTINCT st.sku_id) sku_count,
                COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM warehouses w LEFT JOIN inventory_stocks st ON st.warehouse_id=w.id
         WHERE ${scW.sql}
         GROUP BY w.id ORDER BY amount DESC`
      )
      .all(...scW.params)
    const byCategory = db
      .prepare(
        `SELECT COALESCE(c.name,'未分类') AS category_name, COALESCE(SUM(st.qty_on_hand),0) qty,
                COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN categories c ON c.id=p.category_id WHERE ${scS.sql} GROUP BY c.id ORDER BY amount DESC`
      )
      .all(...scS.params)
    const total = db
      .prepare(`SELECT COALESCE(SUM(qty_on_hand),0) qty, COALESCE(SUM(qty_on_hand*cost_price),0) amount, COUNT(DISTINCT sku_id) skus FROM inventory_stocks WHERE ${scT.sql}`)
      .get(...scT.params)
    const turnover = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction='out' AND doc_type IN ('SAL_OUT') THEN qty ELSE 0 END),0) out_qty
         FROM inventory_transactions WHERE biz_date >= date('now','localtime','-30 day') AND ${scT.sql}`
      )
      .get(...scT.params).out_qty
    const txTrend = db
      .prepare(
        `SELECT biz_date AS date,
                COALESCE(SUM(CASE WHEN direction='in' THEN qty ELSE 0 END),0) in_qty,
                COALESCE(SUM(CASE WHEN direction='out' THEN qty ELSE 0 END),0) out_qty
         FROM inventory_transactions WHERE biz_date >= date('now','localtime','-30 day') AND ${scT.sql}
         GROUP BY biz_date ORDER BY biz_date`
      )
      .all(...scT.params)
    return ok(res, { byWarehouse, byCategory, total, outQty30: turnover, txTrend })
  })
)

// ---------- 序列号台账 ----------
r.get(
  '/serials',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    const sc = stockScopeSql(req.orgScope, 'sn') // 序列号在库仓；无仓（已出库离仓）对受限范围不可见
    conds.push(sc.sql)
    params.push(...sc.params)
    if (req.query.keyword) {
      conds.push('(sn.serial_no LIKE ? OR sn.barcode LIKE ? OR sk.sku_code LIKE ? OR sk.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    for (const [k, col] of [
      ['sku_id', 'sn.sku_id'],
      ['warehouse_id', 'sn.warehouse_id']
    ]) {
      if (req.query[k]) {
        conds.push(`${col} = ?`)
        params.push(Number(req.query[k]))
      }
    }
    if (req.query.status) {
      conds.push('sn.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `serial_numbers sn JOIN product_skus sk ON sk.id=sn.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN warehouses w ON w.id=sn.warehouse_id`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT sn.*, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, p.spu_code, w.name AS warehouse_name
         FROM ${FROM} ${where} ORDER BY sn.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    const sum = db
      .prepare(
        `SELECT COUNT(*) total,
          SUM(CASE WHEN sn.status='in_stock' THEN 1 ELSE 0 END) in_stock,
          SUM(CASE WHEN sn.status='shipped' THEN 1 ELSE 0 END) shipped
         FROM ${FROM} ${where}`
      )
      .get(...params)
    return paged(res, { rows, total, page, pageSize, summary: sum })
  })
)

// 序列号全链路追溯
r.get(
  '/serials/trace/:serialNo',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const sn = db
      .prepare(
        `SELECT sn.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name,
                w.name AS warehouse_name, sup.name AS supplier_name
         FROM serial_numbers sn JOIN product_skus sk ON sk.id=sn.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN warehouses w ON w.id=sn.warehouse_id LEFT JOIN suppliers sup ON sup.id=sn.supplier_id
         WHERE sn.serial_no=?`
      )
      .get(req.params.serialNo)
    if (sn && !warehouseInScope(db, sn.warehouse_id, req.orgScope)) {
      return fail(res, '序列号不存在', 404)
    }
    if (!sn) return fail(res, '序列号不存在', 404)
    const events = []
    // 追溯事件同样按仓范围过滤：同单号 / SKU 的流水可能落在别的组织的仓（ADR-0038）
    const tsc = stockScopeSql(req.orgScope, 't')
    if (sn.entry_doc_no) {
      const entry = db
        .prepare(
          `SELECT t.biz_date, t.doc_type, t.doc_no, t.qty, t.unit_cost, t.counterparty, t.operator, t.remark, w.name AS warehouse_name
           FROM inventory_transactions t LEFT JOIN warehouses w ON w.id=t.warehouse_id WHERE t.doc_no=? AND t.sku_id=? AND t.direction='in' AND ${tsc.sql}`
        )
        .all(sn.entry_doc_no, sn.sku_id, ...tsc.params)
      for (const e of entry) events.push({ ...e, doc_type_name: DOC_TYPE_LABEL[e.doc_type] || e.doc_type, stage: '入库' })
    }
    if (sn.exit_doc_no) {
      const exit = db
        .prepare(
          `SELECT t.biz_date, t.doc_type, t.doc_no, t.qty, t.unit_cost, t.counterparty, t.operator, t.remark, w.name AS warehouse_name
           FROM inventory_transactions t LEFT JOIN warehouses w ON w.id=t.warehouse_id WHERE t.doc_no=? AND t.sku_id=? AND t.direction='out' AND ${tsc.sql}`
        )
        .all(sn.exit_doc_no, sn.sku_id, ...tsc.params)
      for (const e of exit) events.push({ ...e, doc_type_name: DOC_TYPE_LABEL[e.doc_type] || e.doc_type, stage: '出库' })
    }
    return ok(res, { serial: sn, events })
  })
)

// ---------- 可用量报表（用友口径：可用量 = 现存量 − 冻结量 + 预计入库量 − 预计出库量）----------
r.get(
  '/availability',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = ['st.qty_on_hand <> 0']
    const params = []
    const sc = stockScopeSql(req.orgScope, 'st')
    conds.push(sc.sql)
    params.push(...sc.params)
    if (req.query.warehouse_id) {
      conds.push('st.warehouse_id = ?')
      params.push(Number(req.query.warehouse_id))
    }
    if (req.query.keyword) {
      conds.push('(sk.sku_code LIKE ? OR sk.name LIKE ? OR p.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw)
    }
    const where = `WHERE ${conds.join(' AND ')}`
    const TRANSIT = `(SELECT COALESCE(SUM(ti.qty),0) FROM stock_transfer_items ti JOIN stock_transfers t2 ON t2.id=ti.transfer_id
       WHERE t2.status='shipped' AND t2.to_warehouse_id=st.warehouse_id AND ti.sku_id=st.sku_id)`
    const BACKORDER = `(SELECT COALESCE(SUM(i.qty - i.shipped_qty),0) FROM sales_order_items i JOIN sales_orders s2 ON s2.id=i.order_id
       WHERE s2.status='confirmed' AND s2.warehouse_id=st.warehouse_id AND i.sku_id=st.sku_id)`
    const SELECT = `st.warehouse_id, st.sku_id, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name,
        w.name AS warehouse_name,
        SUM(st.qty_on_hand) qty_on_hand, SUM(st.qty_reserved) qty_reserved,
        ${TRANSIT} qty_in_transit, ${BACKORDER} qty_backorder,
        SUM(st.qty_on_hand - st.qty_reserved) + ${TRANSIT} - ${BACKORDER} qty_available`
    const FROM = `inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id JOIN warehouses w ON w.id=st.warehouse_id`
    const total = db.prepare(`SELECT COUNT(DISTINCT st.sku_id || '-' || st.warehouse_id) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${SELECT} FROM ${FROM} ${where} GROUP BY st.sku_id, st.warehouse_id ORDER BY w.id, sk.sku_code LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, {
      rows: rows.map((x) => ({
        ...x,
        qty_on_hand: Number(x.qty_on_hand), qty_reserved: Number(x.qty_reserved),
        qty_in_transit: Number(x.qty_in_transit), qty_backorder: Number(x.qty_backorder), qty_available: Number(x.qty_available)
      })),
      total, page, pageSize,
      formula: '可用量 = 现存量 − 冻结量 + 预计入库量（在途调拨）− 预计出库量（已确认未发货）'
    })
  })
)

// ---------- 库龄分析 ----------
r.get(
  '/aging',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = ["st.qty_on_hand > 0", "COALESCE(st.entry_date, st.produce_date, '') <> ''"]
    const params = []
    const sc = stockScopeSql(req.orgScope, 'st')
    conds.push(sc.sql)
    params.push(...sc.params)
    if (req.query.warehouse_id) {
      conds.push('st.warehouse_id = ?')
      params.push(Number(req.query.warehouse_id))
    }
    if (req.query.keyword) {
      conds.push('(sk.sku_code LIKE ? OR p.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw)
    }
    const where = `WHERE ${conds.join(' AND ')}`
    const FROM = `inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id JOIN warehouses w ON w.id=st.warehouse_id`
    const SELECT = `st.*, COALESCE(st.entry_date, st.produce_date) AS base_date,
        CAST(julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) AS INTEGER) AS age_days,
        sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name,
        (st.qty_on_hand * st.cost_price) AS amount`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT ${SELECT}, CASE
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 30 THEN 'b0'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 90 THEN 'b1'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 180 THEN 'b2'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 365 THEN 'b3'
           ELSE 'b4' END AS bucket
         FROM ${FROM} ${where} ORDER BY age_days DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    const buckets = db
      .prepare(
        `SELECT CASE
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 30 THEN 'b0'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 90 THEN 'b1'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 180 THEN 'b2'
           WHEN julianday('now','localtime') - julianday(COALESCE(st.entry_date, st.produce_date)) <= 365 THEN 'b3'
           ELSE 'b4' END AS bucket,
           COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount, COUNT(*) rows
         FROM ${FROM} ${where} GROUP BY bucket`
      )
      .all(...params)
    const BUCKET_LABEL = { b0: '0-30 天', b1: '31-90 天', b2: '91-180 天', b3: '181-365 天', b4: '365 天以上' }
    return paged(res, {
      rows, total, page, pageSize,
      buckets: buckets.map((b) => ({ ...b, label: BUCKET_LABEL[b.bucket] })),
      bucketLabel: BUCKET_LABEL
    })
  })
)

// ---------- 呆滞分析 ----------
r.get(
  '/sluggish',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 90)
    const sc = stockScopeSql(req.orgScope, 'st')
    const FROM = `inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id JOIN warehouses w ON w.id=st.warehouse_id`
    const rows = db
      .prepare(
        `SELECT st.sku_id, st.warehouse_id, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, w.name AS warehouse_name,
                SUM(st.qty_on_hand) qty_on_hand, SUM(st.qty_on_hand*st.cost_price) amount,
                (SELECT MAX(t.biz_date) FROM inventory_transactions t WHERE t.sku_id=st.sku_id AND t.warehouse_id=st.warehouse_id AND t.direction='out') AS last_out_date,
                CAST(julianday('now','localtime') - COALESCE(julianday((SELECT MAX(t.biz_date) FROM inventory_transactions t WHERE t.sku_id=st.sku_id AND t.warehouse_id=st.warehouse_id AND t.direction='out')), julianday('2000-01-01')) AS INTEGER) AS idle_days
         FROM ${FROM}
         WHERE st.qty_on_hand > 0 AND ${sc.sql}
         GROUP BY st.sku_id, st.warehouse_id
         HAVING idle_days >= ?
         ORDER BY idle_days DESC LIMIT 200`
      )
      .all(...sc.params, days)
    const summary = {
      threshold: days,
      sluggish_90: rows.filter((x) => x.idle_days >= 90 && x.idle_days < 180).length,
      dead_180: rows.filter((x) => x.idle_days >= 180).length,
      amount: Number(rows.reduce((s, x) => s + x.amount, 0).toFixed(2))
    }
    return ok(res, { rows: rows.map((x) => ({ ...x, level: x.idle_days >= 180 ? 'dead' : 'sluggish' })), summary })
  })
)

// ---------- ABC 分类（按库存金额帕累托）----------
r.get(
  '/abc',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const sc = stockScopeSql(req.orgScope, 'st')
    const rows = db
      .prepare(
        `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, p.name AS product_name, c.name AS category_name,
                COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM product_skus sk JOIN products p ON p.id=sk.product_id
         LEFT JOIN categories c ON c.id=p.category_id
         LEFT JOIN inventory_stocks st ON st.sku_id=sk.id AND ${sc.sql}
         GROUP BY sk.id HAVING amount > 0 ORDER BY amount DESC`
      )
      .all(...sc.params)
    const totalAmount = rows.reduce((s, x) => s + x.amount, 0)
    let cum = 0
    const marked = rows.map((x) => {
      cum += x.amount
      const pct = totalAmount > 0 ? (cum / totalAmount) * 100 : 0
      const prevPct = totalAmount > 0 ? ((cum - x.amount) / totalAmount) * 100 : 0
      const cls = prevPct < 80 ? 'A' : prevPct < 95 ? 'B' : 'C'
      return { ...x, cum_pct: Number(pct.toFixed(1)), class: cls }
    })
    const summary = ['A', 'B', 'C'].map((c) => {
      const items = marked.filter((x) => x.class === c)
      return {
        class: c,
        count: items.length,
        qty: Number(items.reduce((s, x) => s + x.qty, 0)),
        amount: Number(items.reduce((s, x) => s + x.amount, 0).toFixed(2)),
        amount_pct: totalAmount > 0 ? Number(((items.reduce((s, x) => s + x.amount, 0) / totalAmount) * 100).toFixed(1)) : 0
      }
    })
    return ok(res, { rows: marked, summary, totalAmount: Number(totalAmount.toFixed(2)) })
  })
)

// ---------- 组装 / 拆卸（组合包装）----------
r.get(
  '/assembly',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    const sc = stockScopeSql(req.orgScope, 'a')
    conds.push(sc.sql)
    params.push(...sc.params)
    if (req.query.type) {
      conds.push('a.type = ?')
      params.push(req.query.type)
    }
    if (req.query.warehouse_id) {
      conds.push('a.warehouse_id = ?')
      params.push(Number(req.query.warehouse_id))
    }
    if (req.query.status) {
      conds.push('a.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `assembly_orders a JOIN bundles b ON b.id=a.bundle_id JOIN warehouses w ON w.id=a.warehouse_id`
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT a.*, b.code AS bundle_code, b.name AS bundle_name, b.type AS bundle_type, w.name AS warehouse_name
         FROM ${FROM} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/assembly/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    assertStockDocInScope(db, 'assembly_orders', req.params.id, req.orgScope, { notFound: '组装单不存在' })
    const head = db
      .prepare(
        `SELECT a.*, b.code AS bundle_code, b.name AS bundle_name, b.type AS bundle_type, w.name AS warehouse_name
         FROM assembly_orders a JOIN bundles b ON b.id=a.bundle_id JOIN warehouses w ON w.id=a.warehouse_id WHERE a.id=?`
      )
      .get(Number(req.params.id))
    if (!head) return fail(res, '组装单不存在', 404)
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM assembly_order_items i
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id WHERE i.order_id=? ORDER BY i.role DESC, i.id`
      )
      .all(head.id)
    return ok(res, head)
  })
)

// 创建组装/拆卸单（明细按组合装 BOM 自动展开）
r.post(
  '/assembly',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { type = 'assemble', bundle_id, warehouse_id, biz_date, qty, remark } = req.body || {}
    if (!bundle_id || !warehouse_id) return fail(res, '请选择组合装与仓库')
    assertWarehouseInScope(db, warehouse_id, req.orgScope)
    const n = Number(qty || 0)
    if (!(n > 0)) return fail(res, '数量必须大于 0')
    const bundle = db.prepare('SELECT * FROM bundles WHERE id=?').get(Number(bundle_id))
    if (!bundle) return fail(res, '组合装不存在', 404)
    if (type === 'assemble' && !bundle.parent_sku_id) return fail(res, '该组合装没有成品 SKU，无法组装入库，请先在组合装档案中关联成品')
    if (type === 'disassemble' && !bundle.parent_sku_id) return fail(res, '拆卸需要组合装存在成品 SKU 库存')
    const components = db
      .prepare(
        `SELECT bc.*, sk.sku_code, sk.name AS sku_name, sk.cost_std FROM bundle_components bc
         JOIN product_skus sk ON sk.id=bc.component_sku_id WHERE bc.bundle_id=?`
      )
      .all(bundle.id)
    if (!components.length) return fail(res, '该组合装没有配置组件 BOM')
    const run = db.transaction(() => {
      // 取号前缀用**该单据类型在内核里注册的那个前缀**（`doc_types` 里组装拆卸单 = `AS`）。
      // 原来拆卸用 `DS`，而 `DS` 是**经销商对账单**（`dealer_statements`）的注册前缀 ⇒
      // 「由前缀认单据类型」这条约定在这两个域上失效：库里真实同时存在
      // `DS202610150001`（组装拆卸单）与 `DS202608300001…`（经销商对账单）。
      // 组装/拆卸同型不同前缀，下游按前缀分派就永远对不上，所以两处统一 `AS`。
      const docNo = nextDocNo(db, 'AS', 'assembly_orders', 'doc_no', biz_date)
      const info = db
        .prepare(
          `INSERT INTO assembly_orders (doc_no,type,bundle_id,warehouse_id,biz_date,status,qty,total_cost,operator,remark,created_by)
           VALUES (?,?,?,?,?,'draft',?,0,?,?,?)`
        )
        .run(docNo, type, bundle.id, warehouse_id, biz_date || localDate(), n, u.name || null, remark || null, u.uid || null)
      const aid = info.lastInsertRowid
      const ins = db.prepare('INSERT INTO assembly_order_items (order_id,role,sku_id,batch_no,qty,unit_cost,amount) VALUES (?,?,?,?,?,?,?)')
      let cost = 0
      if (type === 'assemble') {
        const parent = db.prepare('SELECT * FROM product_skus WHERE id=?').get(bundle.parent_sku_id)
        cost = components.reduce((s, c) => s + c.qty * n * (c.cost_std || 0), 0)
        ins.run(aid, 'parent', bundle.parent_sku_id, '', n, Number((cost / n).toFixed(4)), Number(cost.toFixed(2)))
        for (const c of components) {
          const amt = c.qty * n * (c.cost_std || 0)
          ins.run(aid, 'component', c.component_sku_id, '', c.qty * n, c.cost_std || 0, Number(amt.toFixed(2)))
        }
      } else {
        const parent = db.prepare('SELECT * FROM product_skus WHERE id=?').get(bundle.parent_sku_id)
        cost = (parent?.cost_std || 0) * n
        ins.run(aid, 'parent', bundle.parent_sku_id, '', n, parent?.cost_std || 0, Number(cost.toFixed(2)))
        for (const c of components) {
          const amt = c.qty * n * (c.cost_std || 0)
          ins.run(aid, 'component', c.component_sku_id, '', c.qty * n, c.cost_std || 0, Number(amt.toFixed(2)))
        }
      }
      db.prepare('UPDATE assembly_orders SET total_cost=? WHERE id=?').run(Number(cost.toFixed(2)), aid)
      return { id: aid, docNo }
    })
    const out = run()
    audit(req, { action: 'CREATE', module: 'inventory', entity: 'assembly_orders', entityId: out.id, detail: out.docNo })
    return ok(res, out)
  })
)

// 组装/拆卸过账（执行库存移动）
r.post(
  '/assembly/:id/confirm',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const head = assertStockDocInScope(db, 'assembly_orders', id, req.orgScope, { notFound: '组装单不存在' })
    if (head.status !== 'draft') return fail(res, '该单据已过账')
    const bundle = db.prepare('SELECT * FROM bundles WHERE id=?').get(head.bundle_id)
    const components = db.prepare('SELECT * FROM bundle_components WHERE bundle_id=?').all(head.bundle_id)
    const parentSku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(bundle.parent_sku_id)
    const today = head.biz_date
    const run = db.transaction(() => {
      // [03] 明细行与表头**必须按实际成本统一回写**，否则单据自己跟自己对不上：
      //   组装：组件行永远停在标准成本、母件行是实际成本 ⇒「明细金额合计 = 表头 2 倍」；
      //   拆卸：成品出库按均价（412.8）、组件按标准成本入（576.4）⇒ 库存金额凭空多 163.6，
      //        而表头还停在 430。三处口径各不相同，且不报错。
      // 回写口径（明细与表头同一个数）：
      //   组装 —— 表头 = 母件行 = **组件行金额合计** = 组件实际出库成本合计；
      //   拆卸 —— 表头 = 母件行 = **子件行金额合计** = 成品实际出库成本合计（子件按 BOM 用量占比分摊）。
      const itemsAll = db.prepare('SELECT * FROM assembly_order_items WHERE order_id=? ORDER BY id').all(id)
      // 明细行与 BOM 行按**顺序一一对应**：建单时就是按 `bundle_components` 的扫描顺序逐行插入的
      // （两个查询用同一张表、同一个 WHERE，计划一致），所以这里按下标回写成本。
      // 用 sku_id 配对反而会在「同一组件在 BOM 里出现两次」时把两行写成一个数。
      const compItems = itemsAll.filter((i) => i.role === 'component')
      const parentItem = itemsAll.find((i) => i.role === 'parent') || null
      const updItem = db.prepare('UPDATE assembly_order_items SET unit_cost=?, amount=? WHERE id=?')
      if (head.type === 'assemble') {
        let cost = 0
        const compCost = []
        for (const c of components) {
          const need = c.qty * head.qty
          const { picks, shortage } = pickBatches(db, head.warehouse_id, c.component_sku_id, need)
          if (shortage > 0) {
            const e = new Error(`组件库存不足：SKU#${c.component_sku_id} 需求 ${need}，缺 ${shortage}`)
            e.status = 400
            throw e
          }
          // 金额取**引擎返回的实际出库金额**（跨批次时是各批次的加权结果），
          // 不要再自己用 `qty × 均价` 现算 —— 两处各算一遍迟早分叉。
          let amt = 0
          for (const p of picks) {
            const r = applyStockOut(db, {
              bizDate: today, docType: 'ASM_OUT', docNo: head.doc_no, docId: id,
              warehouseId: head.warehouse_id, skuId: c.component_sku_id, batchNo: p.batchNo, qty: p.qty,
              unitCost: p.unitCost, operator: u.name, remark: `组装领料 → ${bundle.name}`
            })
            amt += Number(r.outAmount || 0)
          }
          compCost.push(Number(amt.toFixed(4)))
          cost += amt
        }
        const parentBatch = `ASM${today.replace(/-/g, '')}${String(id).padStart(3, '0')}`
        const parentUnit = head.qty > 0 ? Number((cost / head.qty).toFixed(4)) : 0
        const shelf = db.prepare('SELECT shelf_life_months FROM products WHERE id=?').get(parentSku.product_id)?.shelf_life_months || 24
        const expire = new Date(today)
        expire.setMonth(expire.getMonth() + shelf)
        applyStockIn(db, {
          bizDate: today, docType: 'ASM_IN', docNo: head.doc_no, docId: id,
          warehouseId: head.warehouse_id, skuId: bundle.parent_sku_id, batchNo: parentBatch,
          produceDate: today, expireDate: localDate(expire), qty: head.qty,
          unitCost: parentUnit, operator: u.name, remark: `组装成品入库 ${bundle.name}`
        })
        // 成品启用序列号管理时，按件生成序列号
        if (parentSku.serial_managed) {
          const prefix = `SN${today.replace(/-/g, '')}`
          const insSn = db.prepare(
            `INSERT INTO serial_numbers (serial_no,sku_id,barcode,warehouse_id,batch_no,status,entry_doc_no,entry_date,remark)
             VALUES (?,?,?,?,?,'in_stock',?,?,?)`
          )
          for (let i = 1; i <= Math.floor(head.qty); i++) {
            insSn.run(`${prefix}${String(id).padStart(3, '0')}${String(i).padStart(4, '0')}`, bundle.parent_sku_id, parentSku.barcode, head.warehouse_id, parentBatch, head.doc_no, today, '组装生成')
          }
        }
        // 组件行按**实际出库成本**回写（原来这两行只回写母件行，组件行永远停在标准成本）
        for (let i = 0; i < components.length; i++) {
          const it = compItems[i]
          if (!it) continue
          const qty = Number(components[i].qty || 0) * Number(head.qty)
          updItem.run(qty > 0 ? Number((compCost[i] / qty).toFixed(4)) : 0, Number(compCost[i].toFixed(2)), it.id)
        }
        if (parentItem) {
          db.prepare('UPDATE assembly_order_items SET batch_no=?, unit_cost=?, amount=? WHERE id=?')
            .run(parentBatch, parentUnit, Number(cost.toFixed(2)), parentItem.id)
        }
        db.prepare('UPDATE assembly_orders SET total_cost=? WHERE id=?').run(Number(cost.toFixed(2)), id)
      } else {
        // 拆卸：成品出库（按实际均价），组件按 BOM 用量占比**分摊同一笔成本**入库。
        // 原来组件按 `cost_std` 入库 —— 那是另一个数，于是出/进不守恒，库存金额凭空多一截。
        const { picks, shortage } = pickBatches(db, head.warehouse_id, bundle.parent_sku_id, head.qty)
        if (shortage > 0) {
          const e = new Error(`成品库存不足：需求 ${head.qty}，缺 ${shortage}`)
          e.status = 400
          throw e
        }
        let costOut = 0
        let outQty = 0
        for (const p of picks) {
          const r = applyStockOut(db, {
            bizDate: today, docType: 'DSM_OUT', docNo: head.doc_no, docId: id,
            warehouseId: head.warehouse_id, skuId: bundle.parent_sku_id, batchNo: p.batchNo, qty: p.qty,
            unitCost: p.unitCost, operator: u.name, remark: `拆卸成品出库 ${bundle.name}`
          })
          costOut += Number(r.outAmount || 0)
          outQty += Number(p.qty || 0)
        }
        const totalPer = components.reduce((s, c) => s + Number(c.qty || 0), 0)
        const inQtyTotal = totalPer * Number(head.qty)
        const compUnit = inQtyTotal > 0 ? Number((costOut / inQtyTotal).toFixed(4)) : 0
        // 各行金额先算好，再把四舍五入的残差挂到最后一行 ——
        // 保证「子件行金额合计 = 母件行金额」逐分成立（不是"差不多"）。
        const amounts = components.map((c) => Number((Number(c.qty || 0) * Number(head.qty) * compUnit).toFixed(2)))
        const residual = Number((Number(costOut.toFixed(2)) - amounts.reduce((s, x) => s + x, 0)).toFixed(2))
        if (amounts.length) amounts[amounts.length - 1] = Number((amounts[amounts.length - 1] + residual).toFixed(2))
        for (let i = 0; i < components.length; i++) {
          const c = components[i]
          const qty = Number(c.qty || 0) * Number(head.qty)
          const newBatch = `DSM${today.replace(/-/g, '')}${String(id).padStart(3, '0')}-${c.component_sku_id}`
          applyStockIn(db, {
            bizDate: today, docType: 'DSM_IN', docNo: head.doc_no, docId: id,
            warehouseId: head.warehouse_id, skuId: c.component_sku_id, batchNo: newBatch,
            produceDate: today, qty, unitCost: compUnit, operator: u.name, remark: `拆卸组件入库 ${bundle.name}`
          })
          const it = compItems[i]
          if (it) updItem.run(compUnit, amounts[i], it.id)
        }
        const parentUnit = outQty > 0 ? Number((costOut / outQty).toFixed(4)) : 0
        if (parentItem) updItem.run(parentUnit, Number(costOut.toFixed(2)), parentItem.id)
        // 拆卸分支原来**完全不更新表头**：明细按实际成本走、表头停在建单时的标准成本口径
        db.prepare('UPDATE assembly_orders SET total_cost=? WHERE id=?').run(Number(costOut.toFixed(2)), id)
      }
      advanceStatus(db, req, { docType: 'AS', id, action: 'confirm', remark: '组装拆卸执行' })
    })
    run()
    audit(req, { action: 'CONFIRM', module: 'inventory', entity: 'assembly_orders', entityId: id })
    return ok(res, { id })
  })
)

// 作废组装/拆卸单：草稿（还没执行、还没动库存）时可用。
// 边 `AS.cancel`（draft→cancelled）在内核里早已登记，此前没有后端路由。
r.post(
  '/assembly/:id/cancel',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const head = assertStockDocInScope(db, 'assembly_orders', id, req.orgScope, { notFound: '组装单不存在' })
    // 状态推进走内核（非法来源态抛 DocFlowError → 409），见 /transfers/:id/cancel 的说明。
    advanceStatus(db, req, { docType: 'AS', id, action: 'cancel', remark: `取消组装单 ${head.doc_no}` })
    audit(req, { action: 'CANCEL', module: 'inventory', entity: 'assembly_orders', entityId: id })
    return ok(res, { id, status: 'cancelled' })
  })
)

export default r
