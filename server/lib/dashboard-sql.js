/**
 * ============================================================================
 * 文件标识：server/lib/dashboard-sql.js ｜ 看板接口 /top /inventory-dist /channel /recent 的 SQL 文本唯一来源（AC4，ADR-0044 补充 2）
 * ============================================================================
 * 【职责】把 `server/routes/dashboard.js` 里这几个接口的 SQL **文本**放在一处：路由从这里取、`scripts/explain-audit.mjs` 也从这里取，
 *   所以索引审计审的就是路由真正执行的语句，不是人工抄一份（抄的会漂移——summary / trend 那几条登记仍是镜像，见审计脚本里的注释）。
 * 【边界】只产生 SQL 字符串，不碰数据库、不含缓存 / 剖析逻辑。窗口参数 `days` 由调用方先 `Number()` 规范化再传入（与路由一致），
 *   这里不对它做校验：非有限数字会让 `date(…,'-NaN day')` 为 NULL，结果为空，与改动前行为一致。
 * 【改它要注意】改 SQL 就是改审计对象：先跑 `node scripts/explain-audit.mjs`（`dash.top_*` 声明了 `expectIndex`，`/top` 的 `CROSS JOIN`
 *   写法是为固定"先按 idx_so_order_date 取窗口内订单、再按 idx_soi_order 取明细"，换回普通 JOIN 会让计划退回先扫明细表）。
 * ============================================================================
 */

const since = (days) => `date('now','localtime','-${days} day')`

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

// ---- /channel（AC4：文本从处理器搬出，未改写）----
export const channelOfflineSql = (days) =>
  `SELECT channel, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
         WHERE status NOT IN ('cancelled','draft') AND order_date >= ${since(days)} AND channel <> 'platform' GROUP BY channel`

export const channelOnlineSql = (days) =>
  `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount
         FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id
         WHERE date(o.order_time) >= ${since(days)} AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`

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
