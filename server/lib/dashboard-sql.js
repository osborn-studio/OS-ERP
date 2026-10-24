/**
 * ============================================================================
 * 文件标识：server/lib/dashboard-sql.js ｜ 看板接口 /trend /top /inventory-dist /channel /recent 的 SQL 文本唯一来源（AC4 / AD3，ADR-0044 补充 2、3）
 * ============================================================================
 * 【职责】把 `server/routes/dashboard.js` 里这几个接口的 SQL **文本**放在一处：路由从这里取、`scripts/explain-audit.mjs` 也从这里取，
 *   所以索引审计审的就是路由真正执行的语句，不是人工抄一份（抄的会漂移——summary 那几条登记仍是镜像，见审计脚本里的注释；AD3 起 trend 也在这里）。
 * 【边界】只产生 SQL 字符串，不碰数据库、不含缓存 / 剖析逻辑。窗口参数 `days` 由调用方先 `Number()` 规范化再传入（与路由一致），
 *   这里不对它做校验：非有限数字会让 `date(…,'-NaN day')` 为 NULL，结果为空，与改动前行为一致。
 * 【改它要注意】改 SQL 就是改审计对象：先跑 `node scripts/explain-audit.mjs`（`dash.top_*` 声明了 `expectIndex`，`/top` 的 `CROSS JOIN`
 *   写法是为固定"先按 idx_so_order_date 取窗口内订单、再按 idx_soi_order 取明细"，换回普通 JOIN 会让计划退回先扫明细表）。
 * ============================================================================
 */

const since = (days) => `date('now','localtime','-${days} day')`

/**
 * AD3：JS 侧复刻 `date('now','localtime','-N day')`，供 oms_orders 的区间谓词绑定。
 * 与 SQLite 同口径：先转本地时间、再在"本地钟面"上减 N 天（不做夏令时修正）；N 非有限数字、为负数（旧模板拼出 '--N day'，SQLite 返回 NULL）
 * 或结果超出 SQLite 的儒略日范围 → null（绑定 NULL，谓词为 NULL，结果为空，与旧行为一致）。极远的过去按 SQLite 的 `-0712-11-25` 形式输出。
 * `now` 仅供测试注入。
 */
export function sinceDate(days, now = new Date()) {
  const n = Number(days)
  if (!Number.isFinite(n) || String(n).startsWith('-')) return null
  // SQLite 把 'N day' 修饰符按毫秒取整：iJD += (int64)(r*86400000 + 0.5·sign(r))，对 r=-N 即从当前毫秒中减去 trunc(N*86400000 + 0.5)
  const t = now.getTime() - now.getTimezoneOffset() * 60000 - Math.trunc(n * 86400000 + 0.5)
  const jd = t / 86400000 + 2440587.5
  if (!(jd >= 0 && jd < 5373484.5)) return null
  const m = /^([+-]?)(\d{4,6})-(\d{2})-(\d{2})T/.exec(new Date(t).toISOString())
  if (!m) return null
  return `${m[1] === '-' ? '-' : ''}${String(Number(m[2])).padStart(4, '0')}-${m[3]}-${m[4]}`
}

/**
 * AD3：oms_orders 线上分支的两个绑定参数 `[lo, since]`，对应 `order_time >= ? AND date(order_time) >= ?`。
 * `since` 是旧谓词的右端；`lo` = since 前一天，仅用来让索引缩小范围——比 since 宽一天，是为了不漏掉带时区后缀的值
 * （'2026-10-23T20:00:00-08:00' 的 date() 是 10-24，但文本小于 '2026-10-24'）。第二个谓词保留旧的 `date(order_time) >= since`，
 * 所以结果与旧 SQL 逐行相同；对文本顺序与日期前缀一致的存量值（`YYYY-MM-DD[ T]…`，含前导字母的脏值），索引只影响读取量、不影响结果。
 */
export function onlineWindow(days, now = new Date()) {
  const since = sinceDate(days, now)
  if (since === null) return [null, null]
  const lo = sinceDate(Number(days) + 1, now)
  return [lo === null ? '' : lo, since]
}

// ---- /top（AB2：CROSS JOIN 固定连接顺序；dealers / stores 未改）----
export const topProductsSql = (days) =>
  `SELECT p.name AS product_name, b.name AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
       FROM sales_orders so CROSS JOIN sales_order_items i ON i.order_id=so.id
       JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
       WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${since(days)}
       GROUP BY p.id ORDER BY amount DESC LIMIT 10`

export const topBrandsSql = (days) =>
  `SELECT COALESCE(b.name,'未标品牌') AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
       FROM sales_orders so CROSS JOIN sales_order_items i ON i.order_id=so.id
       JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id LEFT JOIN brands b ON b.id=p.brand_id
       WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${since(days)}
       GROUP BY b.id ORDER BY amount DESC LIMIT 10`

export const topDealersSql = (days) =>
  `SELECT d.name, d.level, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
       FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id
       WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${since(days)}
       GROUP BY d.id ORDER BY amount DESC LIMIT 10`

export const topStoresSql = (days) =>
  `SELECT s.name, s.region, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
       FROM sales_orders so JOIN stores s ON s.id=so.store_id
       WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${since(days)}
       GROUP BY s.id ORDER BY amount DESC LIMIT 10`

// ---- /inventory-dist（AB2：库存宽表一遍扫描按 (仓库, 品类) 聚合）----
export const INVENTORY_DIST_AGG_SQL =
  `SELECT st.warehouse_id AS wid, p.category_id AS cid, (p.id IS NOT NULL) AS matched,
              SUM(st.qty_on_hand) AS qty, SUM(st.qty_on_hand*st.cost_price) AS amount
       FROM inventory_stocks st LEFT JOIN product_skus sk ON sk.id=st.sku_id LEFT JOIN products p ON p.id=sk.product_id
       GROUP BY st.warehouse_id, p.category_id, (p.id IS NOT NULL)`

// ---- /trend（AD3：从处理器搬出；sales / purchase 文本未改写，online 改成可用 idx_oms_order_time 的区间谓词）----
export const trendSalesSql = (days) =>
  `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
       WHERE status NOT IN ('cancelled','draft') AND order_date >= ${since(days)} GROUP BY order_date ORDER BY date`

export const trendPurchaseSql = (days) =>
  `SELECT order_date AS date, COALESCE(SUM(total_amount),0) amount FROM purchase_orders
       WHERE status <> 'cancelled' AND order_date >= ${since(days)} GROUP BY order_date ORDER BY date`

/** 绑定参数：`onlineWindow(days)` = [lo, since]。旧写法 `date(order_time) >= date('now','localtime','-N day')`；先按 `order_time >= lo` 走索引，再用原谓词复核（ADR-0044 补充 3）。 */
export const trendOnlineSql = () =>
  `SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders
       WHERE order_time >= ? AND date(order_time) >= ? GROUP BY date(order_time) ORDER BY date`

// ---- /channel（AC4：文本从处理器搬出，未改写）----
export const channelOfflineSql = (days) =>
  `SELECT channel, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
         WHERE status NOT IN ('cancelled','draft') AND order_date >= ${since(days)} AND channel <> 'platform' GROUP BY channel`

// AD3：线上分支加一个可走 idx_oms_order_time（迁移 070）的区间谓词，原 date() 谓词保留作复核（绑定参数 onlineWindow(days)）
export const channelOnlineSql = () =>
  `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount
         FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id
         WHERE o.order_time >= ? AND date(o.order_time) >= ? AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`

// ---- /recent（AC4：文本从处理器搬出，未改写；四条都是"按主键倒序取最新 8 条"）----
export const RECENT_SQL = Object.freeze({
  salesOrders: `SELECT so.doc_no, so.order_date, so.channel, so.status, so.receivable_amount,
                COALESCE(d.name, s.name, so.receiver, '线上买家') AS customer_name
         FROM sales_orders so LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id
         ORDER BY so.id DESC LIMIT 8`,
  purchaseOrders: `SELECT po.doc_no, po.order_date, po.status, po.total_amount, sup.name AS supplier_name
         FROM purchase_orders po JOIN suppliers sup ON sup.id=po.supplier_id ORDER BY po.id DESC LIMIT 8`,
  omsOrders: `SELECT o.platform_order_no, o.order_time, o.status, o.pay_amount, pf.name AS platform_name, o.buyer_nick
         FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id ORDER BY o.id DESC LIMIT 8`,
  transactions: `SELECT t.biz_date, t.doc_type, t.doc_no, t.direction, t.qty, sk.name AS sku_name, w.name AS warehouse_name
         FROM inventory_transactions t JOIN product_skus sk ON sk.id=t.sku_id JOIN warehouses w ON w.id=t.warehouse_id
         ORDER BY t.id DESC LIMIT 8`
})
