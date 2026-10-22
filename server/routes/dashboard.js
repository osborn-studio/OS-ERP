/**
 * ============================================================================
 * 文件标识：server/routes/dashboard.js ｜ 经营看板路由：KPI 汇总、趋势、排行、预警（只读聚合，不产生业务数据）
 * ============================================================================
 * 【职责】经营看板路由：KPI 汇总、趋势、排行、预警（只读聚合，不产生业务数据）
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
import { getDb } from '../db/index.js'
import { ok, wrap } from '../lib/http.js'
import { requireAuth, requireInternal, requireGlobalData } from '../middleware/auth.js'

const r = Router()
r.use(requireAuth, requireInternal('总部经营看板'), requireGlobalData('总部经营看板'))

r.get(
  '/summary',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const one = (sql, ...p) => db.prepare(sql).get(...p)

    const today = one(
      `SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND order_date = date('now','localtime')`
    )
    const month = one(
      `SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(total_qty),0) qty FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')`
    )
    const lastMonth = one(
      `SELECT COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime','-1 month')`
    )
    const purchaseMonth = one(
      `SELECT COUNT(*) orders, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
       WHERE status NOT IN ('cancelled') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')`
    )
    const omsMonth = one(
      `SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending
       FROM oms_orders WHERE substr(order_time,1,7) = strftime('%Y-%m','now','localtime')`
    )
    const inventory = one(
      'SELECT COALESCE(SUM(qty_on_hand),0) qty, COALESCE(SUM(qty_on_hand*cost_price),0) amount, COUNT(DISTINCT sku_id) skus FROM inventory_stocks'
    )
    const receivable = one(
      `SELECT COALESCE(SUM(receivable_amount - paid_amount),0) unpaid FROM sales_orders WHERE status NOT IN ('cancelled','draft')`
    )
    const payable = one(`SELECT COALESCE(SUM(total_amount),0) amount FROM purchase_orders WHERE status IN ('submitted','approved','received')`)
    const alerts = one(
      `SELECT
        (SELECT COUNT(*) FROM sales_orders WHERE status='confirmed') AS pending_delivery,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('submitted','approved')) AS pending_receipt,
        (SELECT COUNT(*) FROM oms_orders WHERE status='pending') AS oms_pending,
        (SELECT COUNT(*) FROM product_skus sk WHERE sk.status='active' AND sk.safe_stock>0
           AND COALESCE((SELECT SUM(qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=sk.id),0) < sk.safe_stock) AS below_safe,
        (SELECT COUNT(*) FROM inventory_stocks st WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date <> ''
           AND st.expire_date <= date('now','localtime','+90 day')) AS expiring,
        (SELECT COUNT(*) FROM dealers WHERE status='active' AND credit_limit>0 AND credit_used*1.0/credit_limit>=0.8) AS credit_alert`
    )
    const growth = lastMonth.amount > 0 ? Number((((month.amount - lastMonth.amount) / lastMonth.amount) * 100).toFixed(1)) : null

    return ok(res, { today, month, lastMonth, purchaseMonth, omsMonth, inventory, receivable, payable, alerts, growth })
  })
)

r.get(
  '/trend',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 30)
    const from = `date('now','localtime','-${days} day')`
    const sales = db
      .prepare(
        `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
         WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from} GROUP BY order_date ORDER BY date`
      )
      .all()
    const purchase = db
      .prepare(
        `SELECT order_date AS date, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
         WHERE status <> 'cancelled' AND order_date >= ${from} GROUP BY order_date ORDER BY date`
      )
      .all()
    const online = db
      .prepare(
        `SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders
         WHERE date(order_time) >= ${from} GROUP BY date(order_time) ORDER BY date`
      )
      .all()
    const map = new Map()
    const touch = (d) => {
      if (!map.has(d)) map.set(d, { date: d, offline: 0, online: 0, purchase: 0, orders: 0 })
      return map.get(d)
    }
    sales.forEach((x) => {
      const t = touch(x.date)
      t.offline = Number(x.amount.toFixed(2))
      t.orders = x.orders
    })
    online.forEach((x) => {
      touch(x.date).online = Number(x.amount.toFixed(2))
    })
    purchase.forEach((x) => {
      touch(x.date).purchase = Number(x.amount.toFixed(2))
    })
    const list = [...map.values()].sort((a, b) => (a.date > b.date ? 1 : -1))
    list.forEach((x) => {
      x.total = Number((x.offline + x.online).toFixed(2))
    })
    return ok(res, list)
  })
)

r.get(
  '/channel',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 90)
    const from = `date('now','localtime','-${days} day')`
    const offline = db
      .prepare(
        `SELECT channel, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
         WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from} AND channel <> 'platform' GROUP BY channel`
      )
      .all()
    const online = db
      .prepare(
        `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount
         FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id
         WHERE date(o.order_time) >= ${from} AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`
      )
      .all()
    const labels = { dealer: '经销商分销', store: '门店零售', online: '自营商城', platform: '平台电商', live: '直播电商' }
    return ok(res, {
      offline: offline.map((x) => ({ name: labels[x.channel] || x.channel, ...x })),
      online
    })
  })
)

r.get(
  '/todos',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const pendingDelivery = db
      .prepare(
        `SELECT so.id, so.doc_no, so.order_date, so.channel, so.receivable_amount,
                COALESCE(d.name, s.name, so.receiver, '线上买家') AS customer_name
         FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id
         WHERE so.status='confirmed' ORDER BY so.order_date LIMIT 10`
      )
      .all()
    const pendingReceipt = db
      .prepare(
        `SELECT po.id, po.doc_no, po.order_date, po.total_amount, sup.name AS supplier_name, w.name AS warehouse_name
         FROM purchase_orders po JOIN suppliers sup ON sup.id=po.supplier_id JOIN warehouses w ON w.id=po.warehouse_id
         WHERE po.status IN ('submitted','approved') ORDER BY po.order_date LIMIT 10`
      )
      .all()
    const omsPending = db
      .prepare(
        `SELECT o.id, o.platform_order_no, o.order_time, o.pay_amount, o.status, pf.name AS platform_name, o.sales_order_id
         FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id WHERE o.status='pending' ORDER BY o.order_time LIMIT 10`
      )
      .all()
    const stockAlerts = db
      .prepare(
        `SELECT sk.id AS sku_id, sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock,
                COALESCE(SUM(st.qty_on_hand),0) qty_on_hand
         FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN inventory_stocks st ON st.sku_id=sk.id
         WHERE sk.status='active' AND sk.safe_stock>0
         GROUP BY sk.id HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock
         ORDER BY (sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0)) DESC LIMIT 10`
      )
      .all()
    const expiring = db
      .prepare(
        `SELECT st.id, st.batch_no, st.expire_date, st.qty_on_hand, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name,
                CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id
         WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date<>'' AND st.expire_date <= date('now','localtime','+90 day')
         ORDER BY st.expire_date LIMIT 10`
      )
      .all()
    return ok(res, { pendingDelivery, pendingReceipt, omsPending, stockAlerts, expiring })
  })
)

r.get(
  '/top',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 30)
    const from = `date('now','localtime','-${days} day')`
    const products = db
      .prepare(
        `SELECT p.name AS product_name, b.name AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
         GROUP BY p.id ORDER BY amount DESC LIMIT 10`
      )
      .all()
    const brands = db
      .prepare(
        `SELECT COALESCE(b.name,'未标品牌') AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
         GROUP BY b.id ORDER BY amount DESC LIMIT 10`
      )
      .all()
    const dealers = db
      .prepare(
        `SELECT d.name, d.level, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
         FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
         GROUP BY d.id ORDER BY amount DESC LIMIT 10`
      )
      .all()
    const stores = db
      .prepare(
        `SELECT s.name, s.region, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
         FROM sales_orders so JOIN stores s ON s.id=so.store_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
         GROUP BY s.id ORDER BY amount DESC LIMIT 10`
      )
      .all()
    return ok(res, { products, brands, dealers, stores })
  })
)

r.get(
  '/recent',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const salesOrders = db
      .prepare(
        `SELECT so.doc_no, so.order_date, so.channel, so.status, so.receivable_amount,
                COALESCE(d.name, s.name, so.receiver, '线上买家') AS customer_name
         FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id
         ORDER BY so.id DESC LIMIT 8`
      )
      .all()
    const purchaseOrders = db
      .prepare(
        `SELECT po.doc_no, po.order_date, po.status, po.total_amount, sup.name AS supplier_name
         FROM purchase_orders po JOIN suppliers sup ON sup.id=po.supplier_id ORDER BY po.id DESC LIMIT 8`
      )
      .all()
    const omsOrders = db
      .prepare(
        `SELECT o.platform_order_no, o.order_time, o.status, o.pay_amount, pf.name AS platform_name, o.buyer_nick
         FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id ORDER BY o.id DESC LIMIT 8`
      )
      .all()
    const transactions = db
      .prepare(
        `SELECT t.biz_date, t.doc_type, t.doc_no, t.direction, t.qty, sk.name AS sku_name, w.name AS warehouse_name
         FROM inventory_transactions t JOIN product_skus sk ON sk.id=t.sku_id JOIN warehouses w ON w.id=t.warehouse_id
         ORDER BY t.id DESC LIMIT 8`
      )
      .all()
    return ok(res, { salesOrders, purchaseOrders, omsOrders, transactions })
  })
)

r.get(
  '/inventory-dist',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const byWarehouse = db
      .prepare(
        `SELECT w.name AS warehouse_name, w.type, COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM warehouses w LEFT JOIN inventory_stocks st ON st.warehouse_id=w.id GROUP BY w.id ORDER BY amount DESC`
      )
      .all()
    const byCategory = db
      .prepare(
        `SELECT COALESCE(c.name,'未分类') AS category_name, COALESCE(SUM(st.qty_on_hand),0) qty, COALESCE(SUM(st.qty_on_hand*st.cost_price),0) amount
         FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN categories c ON c.id=p.category_id GROUP BY c.id ORDER BY amount DESC`
      )
      .all()
    return ok(res, { byWarehouse, byCategory })
  })
)

export default r
