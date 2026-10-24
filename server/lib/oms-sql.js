/**
 * ============================================================================
 * 文件标识：server/lib/oms-sql.js ｜ OMS /stats 与 AI 平台分析的 SQL 唯一来源（AE3，ADR-0044 补充 4）
 * ============================================================================
 * 【职责】把 `server/routes/oms.js` GET /stats 的四条语句与 `server/routes/ai.js` `channel_compare` 的线上平台分析 SQL 放在一处：
 *   路由从这里取、`scripts/explain-audit.mjs` 也从这里取，索引审计审的就是路由真正执行的语句。
 *   旧写法 `date(order_time) >= date('now','localtime','-N day')` 对列套函数，用不上 `idx_oms_order_time`（迁移 070）；
 *   这里沿用 AD3 的做法：`order_time >= :lo AND date(order_time) >= :since`——前者走索引缩小范围，后者是旧谓词原样复核，所以结果与旧 SQL 逐行相同。
 * 【边界】只产生 `{ sql, params }`，不碰数据库。窗口日期**不重复实现**，一律取 `dashboard-sql.js` 的 `onlineWindow()`（含非法 / 超范围窗口 → 绑定 NULL → 结果为空）。
 *   范围谓词（`omsPlatformScopeSql` / `omsOrderScopeSql` 的输出）由调用方传入、原样拼进 WHERE，参数紧跟在窗口两个参数之后，范围语义不变。
 * 【改它要注意】窗口参数 `[lo, since]` 永远排在 params 最前（SQL 里 `?` 的出现顺序决定绑定顺序：byPlatform 的窗口在 ON 子句，先于 WHERE 的范围谓词）。
 *   改 SQL 就是改审计对象：先跑 `node scripts/explain-audit.mjs`（`oms.stats_*` / `ai.platform_analysis` 声明了 expectIndex + expectSearch）。
 *   `/stats` 的 topSkus（oms_order_items 连接）不声明索引期望：规划器可从明细表驱动，见 capacity-baseline AE3 一节。
 * ============================================================================
 */
import { onlineWindow } from './dashboard-sql.js'

/** 范围谓词 `{ sql, params }`（omsPlatformScopeSql / omsOrderScopeSql 的返回值）；缺省为全局 */
const GLOBAL = Object.freeze({ sql: '1=1', params: Object.freeze([]) })

/** /stats：各平台订单 / GMV / 待处理 / 退款（platforms 左连 oms_orders，窗口谓词在 ON 里，无订单的平台仍出一行） */
export function omsStatsByPlatformStmt(days, ps = GLOBAL, now) {
  return {
    sql: `SELECT pf.name AS platform_name, pf.code, COUNT(o.id) orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('refunded','closed') THEN o.pay_amount ELSE 0 END),0) gmv,
                COALESCE(SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN o.status='refunded' THEN o.pay_amount ELSE 0 END),0) refund_amount
         FROM platforms pf LEFT JOIN oms_orders o ON o.platform_id=pf.id AND o.order_time >= ? AND date(o.order_time) >= ?
         WHERE ${ps.sql} GROUP BY pf.id ORDER BY gmv DESC`,
    params: [...onlineWindow(days, now), ...ps.params]
  }
}

/** /stats：按日趋势（os0 = omsOrderScopeSql(scope, 'oms_orders')） */
export function omsStatsTrendStmt(days, os0 = GLOBAL, now) {
  return {
    sql: `SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${os0.sql} GROUP BY date(order_time) ORDER BY date`,
    params: [...onlineWindow(days, now), ...os0.params]
  }
}

/** /stats：合计 */
export function omsStatsTotalStmt(days, os0 = GLOBAL, now) {
  return {
    sql: `SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv,
                COALESCE(AVG(pay_amount),0) avg_amount,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) refunded
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${os0.sql}`,
    params: [...onlineWindow(days, now), ...os0.params]
  }
}

/** /stats：热销标题 Top10（os = omsOrderScopeSql(scope, 'o')） */
export function omsStatsTopSkusStmt(days, os = GLOBAL, now) {
  return {
    sql: `SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE o.order_time >= ? AND date(o.order_time) >= ? AND ${os.sql}
         GROUP BY i.title ORDER BY amount DESC LIMIT 10`,
    params: [...onlineWindow(days, now), ...os.params]
  }
}

/** AI `channel_compare` 的线上分支：按平台汇总（该接口要求全局数据范围，无范围谓词；与 /stats 不同，不过滤状态） */
export function aiPlatformAnalysisStmt(days, now) {
  return {
    sql: `SELECT pf.name AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount FROM oms_orders o
             JOIN platforms pf ON pf.id=o.platform_id WHERE o.order_time >= ? AND date(o.order_time) >= ? GROUP BY pf.id ORDER BY amount DESC`,
    params: [...onlineWindow(days, now)]
  }
}
