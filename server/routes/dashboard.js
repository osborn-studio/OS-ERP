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
 * 【AC11】五个缓存接口的响应顶层带 `cached_at` / `cache_ttl_ms`，响应头带 `X-Dashboard-Cache`（见 okCached）。
 *
 * 【AB2（ADR-0044 补充）】summary / trend / top / todos / inventory-dist 都经 `cachedRead`：`GML_PROFILE=1` 分块计时 + 30 s 进程内缓存
 *   （键 = 接口名 + 规范化后的 days；任何写入、跨零点、TTL 到期都失效，见 lib/db-ttl-cache.js）。
 *
 * 【AC4（ADR-0044 补充 2）】channel 同样经 `cachedRead`（键 `channel:<days>`）；recent 只剖析不缓存（四条查询合计 < 0.2 ms，理由见处理器注释）。
 *   /top、/inventory-dist、/channel、/recent 的 SQL 文本在 `lib/dashboard-sql.js`（路由与 `scripts/explain-audit.mjs` 共用同一份）。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, wrap } from '../lib/http.js'
import { requireAuth, requireInternal, requireGlobalData } from '../middleware/auth.js'
import { countBelowSafe, listBelowSafe } from '../lib/stock.js'
import { createProfiler } from '../lib/profile.js'
import { cachedForDb, cacheTtlMs } from '../lib/db-ttl-cache.js'
import { topProductsSql, topBrandsSql, topDealersSql, topStoresSql, INVENTORY_DIST_AGG_SQL, channelOfflineSql, channelOnlineSql, RECENT_SQL } from '../lib/dashboard-sql.js'

const r = Router()
r.use(requireAuth, requireInternal('总部经营看板'), requireGlobalData('总部经营看板'))

/**
 * AB2：只读聚合接口的统一入口——剖析（GML_PROFILE=1 才记录）+ 30 s 进程内缓存。
 * 为什么直接缓存是范围安全的：本文件第一行的 `r.use(requireAuth, requireInternal, requireGlobalData)` 保证能走到这里的调用者
 * 都是全局数据范围，响应与调用者无关；受限账号在进入处理器之前就被 403，不会读到也不会预热缓存。
 * 缓存键只含接口名与规范化后的 `days`（数值），不含用户 / 组织。若将来给某个接口加入范围相关的字段，必须把范围放进键或不缓存。
 */
function cachedRead(label, key, compute) {
  const db = getDb()
  const prof = createProfiler(label)
  const r = prof.time('cache_or_compute', () => cachedForDb(db, () => compute(db, prof), { key }))
  prof.done({ cache: r.hit ? 'hit' : 'miss' })
  return r
}

/**
 * AC11：缓存接口的响应带“这份数据是什么时候算的”——顶层 `cached_at`（ISO，命中时是当初计算的时刻）、`cache_ttl_ms`（0 = 缓存关闭，每次现算），
 * 命中与否放在响应头 `X-Dashboard-Cache`（不进响应体：缓存命中与现算的响应体必须逐字相同，见 tests/dashboard-perf.test.mjs）。
 * 加在 `data` 之外的顶层字段，数组形态的 `data`（trend）不受影响；旧前端忽略这两个字段。
 */
function okCached(res, { value, hit, at }) {
  res.set('X-Dashboard-Cache', hit ? 'hit' : 'miss')
  return ok(res, value, { cached_at: new Date(at).toISOString(), cache_ttl_ms: cacheTtlMs() })
}

r.get(
  '/summary',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const prof = createProfiler('dashboard.summary') // GML_PROFILE=1 才记录；只写日志，不进响应
    // AA5：汇总只由库内容与当前日期决定（本路由要求全局数据范围，与调用者无关）→ 30 s 内且库无任何写入时直接复用（见 lib/db-ttl-cache.js）
    const r = prof.time('cache_or_compute', () => cachedForDb(db, () => computeSummary(db, prof)))
    prof.done({ cache: r.hit ? 'hit' : 'miss' })
    return okCached(res, r)
  })
)

function computeSummary(db, prof) {
  const one = (name, sql, ...p) => prof.time(name, () => db.prepare(sql).get(...p))

  const today = one('today',
    `SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
     WHERE status NOT IN ('cancelled','draft') AND order_date = date('now','localtime')`
  )
  const month = one('month',
    `SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(total_qty),0) qty FROM sales_orders
     WHERE status NOT IN ('cancelled','draft') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')`
  )
  const lastMonth = one('lastMonth',
    `SELECT COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
     WHERE status NOT IN ('cancelled','draft') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime','-1 month')`
  )
  const purchaseMonth = one('purchaseMonth',
    `SELECT COUNT(*) orders, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
     WHERE status NOT IN ('cancelled') AND substr(order_date,1,7) = strftime('%Y-%m','now','localtime')`
  )
  const omsMonth = one('omsMonth',
    `SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending
     FROM oms_orders WHERE substr(order_time,1,7) = strftime('%Y-%m','now','localtime')`
  )
  // 原写法 `…, COUNT(DISTINCT sku_id) FROM inventory_stocks` 会为 DISTINCT 建临时 B 树并扫整张宽表；
  // 拆成"整表求和"+"idx_stock_sku 覆盖索引上的去重计数"，结果相同（sku_id NOT NULL），medium 库约 142 ms → 39 ms
  const inventory = prof.time('inventory', () => {
    const sums = db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) qty, COALESCE(SUM(qty_on_hand*cost_price),0) amount FROM inventory_stocks').get()
    const { skus } = db.prepare('SELECT COUNT(*) skus FROM (SELECT DISTINCT sku_id FROM inventory_stocks WHERE sku_id IS NOT NULL)').get()
    return { qty: sums.qty, amount: sums.amount, skus }
  })
  const receivable = one('receivable',
    `SELECT COALESCE(SUM(receivable_amount - paid_amount),0) unpaid FROM sales_orders WHERE status NOT IN ('cancelled','draft')`
  )
  const payable = one('payable',`SELECT COALESCE(SUM(total_amount),0) amount FROM purchase_orders WHERE status IN ('submitted','approved','received')`)
  const alertsRow = one('alertsRow',
    `SELECT
      (SELECT COUNT(*) FROM sales_orders WHERE status='confirmed') AS pending_delivery,
      (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('submitted','approved')) AS pending_receipt,
      (SELECT COUNT(*) FROM oms_orders WHERE status='pending') AS oms_pending,
      (SELECT COUNT(*) FROM inventory_stocks st WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date <> ''
         AND st.expire_date <= date('now','localtime','+90 day')) AS expiring,
      (SELECT COUNT(*) FROM dealers WHERE status='active' AND credit_limit>0 AND credit_used*1.0/credit_limit>=0.8) AS credit_alert`
  )
  // below_safe 走 lib/stock.js 的预聚合口径（Z3）；对象键顺序保持与改写前一致
  const { pending_delivery, pending_receipt, oms_pending, expiring, credit_alert } = alertsRow
  const alerts = { pending_delivery, pending_receipt, oms_pending, below_safe: prof.time('below_safe', () => countBelowSafe(db)), expiring, credit_alert }
  const growth = lastMonth.amount > 0 ? Number((((month.amount - lastMonth.amount) / lastMonth.amount) * 100).toFixed(1)) : null

  return { today, month, lastMonth, purchaseMonth, omsMonth, inventory, receivable, payable, alerts, growth }
}

r.get(
  '/trend',
  requireAuth,
  wrap((req, res) => {
    const days = Number(req.query.days || 30)
    return okCached(res, cachedRead('dashboard.trend', `trend:${days}`, (db, prof) => computeTrend(db, prof, days)))
  })
)

function computeTrend(db, prof, days) {
  const from = `date('now','localtime','-${days} day')`
  const sales = prof.time('sales', () => db
    .prepare(
      `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from} GROUP BY order_date ORDER BY date`
    )
    .all())
  const purchase = prof.time('purchase', () => db
    .prepare(
      `SELECT order_date AS date, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
       WHERE status <> 'cancelled' AND order_date >= ${from} GROUP BY order_date ORDER BY date`
    )
    .all())
  const online = prof.time('online', () => db
    .prepare(
      `SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders
       WHERE date(order_time) >= ${from} GROUP BY date(order_time) ORDER BY date`
    )
    .all())
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
  return list
}

r.get(
  '/channel',
  requireAuth,
  wrap((req, res) => {
    const days = Number(req.query.days || 90)
    return okCached(res, cachedRead('dashboard.channel', `channel:${days}`, (db, prof) => computeChannel(db, prof, days)))
  })
)

// AC4：与 trend / top 同形——响应只由库内容、当前日期与规范化后的 days 决定（路由器第一行已要求全局数据范围），键 = channel:<days>。
// 剖析（合成 medium 库，2 万 OMS 单）：offline ≈ 4 ms（idx_so_order_date）、online ≈ 12 ms（`date(order_time)` 无法用索引，随 OMS 订单量线性增长）→ 都 < 50 ms，
// 但 online 是 explain-audit 里登记的已知整表扫描，缓存把它挪出重复请求路径。
function computeChannel(db, prof, days) {
  const offline = prof.time('offline', () => db.prepare(channelOfflineSql(days)).all())
  const online = prof.time('online', () => db.prepare(channelOnlineSql(days)).all())
  const labels = { dealer: '经销商分销', store: '门店零售', online: '自营商城', platform: '平台电商', live: '直播电商' }
  return {
    offline: offline.map((x) => ({ name: labels[x.channel] || x.channel, ...x })),
    online
  }
}

r.get(
  '/todos',
  requireAuth,
  wrap((_req, res) => okCached(res, cachedRead('dashboard.todos', 'todos', computeTodos)))
)

function computeTodos(db, prof) {
  const pendingDelivery = prof.time('pendingDelivery', () => db
    .prepare(
      `SELECT so.id, so.doc_no, so.order_date, so.channel, so.receivable_amount,
              COALESCE(d.name, s.name, so.receiver, '线上买家') AS customer_name
       FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id
       WHERE so.status='confirmed' ORDER BY so.order_date LIMIT 10`
    )
    .all())
  const pendingReceipt = prof.time('pendingReceipt', () => db
    .prepare(
      `SELECT po.id, po.doc_no, po.order_date, po.total_amount, sup.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po JOIN suppliers sup ON sup.id=po.supplier_id JOIN warehouses w ON w.id=po.warehouse_id
       WHERE po.status IN ('submitted','approved') ORDER BY po.order_date LIMIT 10`
    )
    .all())
  const omsPending = prof.time('omsPending', () => db
    .prepare(
      `SELECT o.id, o.platform_order_no, o.order_time, o.pay_amount, o.status, pf.name AS platform_name, o.sales_order_id
       FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id WHERE o.status='pending' ORDER BY o.order_time LIMIT 10`
    )
    .all())
  // 与预警页同一口径（lib/stock.js），看板只取前 10 且不带 shortage 字段
  const stockAlerts = prof.time('stockAlerts', () => listBelowSafe(db, 10).map(({ shortage, ...row }) => row))
  const expiring = prof.time('expiring', () => db
    .prepare(
      `SELECT st.id, st.batch_no, st.expire_date, st.qty_on_hand, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name,
              CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left
       FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id
       WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date<>'' AND st.expire_date <= date('now','localtime','+90 day')
       ORDER BY st.expire_date LIMIT 10`
    )
    .all())
  return { pendingDelivery, pendingReceipt, omsPending, stockAlerts, expiring }
}


r.get(
  '/top',
  requireAuth,
  wrap((req, res) => {
    const days = Number(req.query.days || 30)
    return okCached(res, cachedRead('dashboard.top', `top:${days}`, (db, prof) => computeTop(db, prof, days)))
  })
)

// AB2：原写法 `FROM sales_order_items i JOIN sales_orders so …` 让 SQLite 先全表扫明细（5 万行）再按主键回查订单、最后才过滤日期；
// 显式 CROSS 连接（SQL 见 lib/dashboard-sql.js）固定连接顺序为"先按 idx_so_order_date 取窗口内订单，再按 idx_soi_order 取其明细"。结果集相同（tests/dashboard-perf.test.mjs 逐行比对），
// 合成 medium 库上 products 约 55 → 21 ms、brands 约 29 → 12 ms（同进程同时测，负载下中位数）。
function computeTop(db, prof, days) {
  const products = prof.time('products', () => db.prepare(topProductsSql(days)).all())
  const brands = prof.time('brands', () => db.prepare(topBrandsSql(days)).all())
  const dealers = prof.time('dealers', () => db.prepare(topDealersSql(days)).all())
  const stores = prof.time('stores', () => db.prepare(topStoresSql(days)).all())
  return { products, brands, dealers, stores }
}


r.get(
  '/recent',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const prof = createProfiler('dashboard.recent')
    // AC4：四条"按主键倒序取最新 8 条"，合成 medium 库上合计 < 0.2 ms（见 capacity-baseline AC4）——不缓存：
    // 缓存的收益（省 < 0.2 ms）小于每次读取 `total_changes()` + `data_version` 的版本校验成本，且这是"最新动态"，任何写入都会使缓存失效，命中率天然低。
    // 仍接入剖析（cache=off），以便生产数据量下回看；若块耗时 ≥ 50 ms 再按 cachedRead 推广。
    const out = {}
    for (const [k, sql] of Object.entries(RECENT_SQL)) out[k] = prof.time(k, () => db.prepare(sql).all())
    prof.done({ cache: 'off' })
    return ok(res, out)
  })
)

r.get(
  '/inventory-dist',
  requireAuth,
  wrap((_req, res) => okCached(res, cachedRead('dashboard.inventory-dist', 'inventory-dist', computeInventoryDist)))
)

// AB2：原写法对库存宽表（medium 库 8.5 万行）整表扫两遍——byWarehouse 对每个仓 LEFT JOIN 回表，byCategory 每行再三次主键回查。
// 改成**一遍**扫描按 (仓库, 品类) 聚合，再在内存里折成两张表（分组数 = 仓库数 × 品类数，很小）。语义保持：
//   · 仓库合计含所有库存行；无库存的仓库仍列出且为 0；并列金额按仓库 id（原先并列顺序未定义）；
//   · 品类合计只含 SKU / 商品能匹配上的行（原写法是内连接），品类缺失或指向不存在的品类 → '未分类'。
// 浮点求和顺序与原写法不同（先分组再相加），最后一位可能不同；tests/dashboard-perf.test.mjs 逐行比对（4 位小数）。
function computeInventoryDist(db, prof) {
  const groups = prof.time('stockAgg', () => db.prepare(INVENTORY_DIST_AGG_SQL).all())
  return prof.time('assemble', () => {
    const byWh = new Map()
    const byCat = new Map()
    for (const g of groups) {
      const w = byWh.get(g.wid) || { qty: 0, amount: 0 }
      w.qty += g.qty ?? 0
      w.amount += g.amount ?? 0
      byWh.set(g.wid, w)
      if (g.matched) {
        const c = byCat.get(g.cid) || { qty: 0, amount: 0 }
        c.qty += g.qty ?? 0
        c.amount += g.amount ?? 0
        byCat.set(g.cid, c)
      }
    }
    const byWarehouse = db
      .prepare('SELECT id, name, type FROM warehouses ORDER BY id')
      .all()
      .map((w) => ({ warehouse_name: w.name, type: w.type, qty: byWh.get(w.id)?.qty ?? 0, amount: byWh.get(w.id)?.amount ?? 0 }))
      .sort((a, b) => b.amount - a.amount) // Array#sort 稳定：并列保持仓库 id 升序
    const catNames = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]))
    const merged = new Map() // 品类缺失 / 指向不存在的品类 → 同一个 '未分类'（key null）
    for (const [cid, v] of byCat) {
      const key = catNames.has(cid) ? cid : null
      const m = merged.get(key) || { qty: 0, amount: 0 }
      m.qty += v.qty
      m.amount += v.amount
      merged.set(key, m)
    }
    const byCategory = [...merged]
      .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a - b)) // 原写法按品类 id 分组（NULL 在前）
      .map(([cid, v]) => ({ category_name: cid === null ? '未分类' : catNames.get(cid) ?? '未分类', qty: v.qty, amount: v.amount }))
      .sort((a, b) => b.amount - a.amount)
    return { byWarehouse, byCategory }
  })
}

export default r
