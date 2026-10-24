/**
 * ============================================================================
 * 文件标识：server/lib/oms-sql.js ｜ OMS /stats 与 AI 平台分析的 SQL 唯一来源（AE3，ADR-0044 补充 4；AF3 补充 5）
 * ============================================================================
 * 【职责】把 `server/routes/oms.js` GET /stats 的四条语句与 `server/routes/ai.js` `channel_compare` 的线上平台分析 SQL 放在一处：
 *   路由从这里取、`scripts/explain-audit.mjs` 也从这里取，索引审计审的就是路由真正执行的语句。
 *   旧写法 `date(order_time) >= date('now','localtime','-N day')` 对列套函数，用不上 `idx_oms_order_time`（迁移 070）；
 *   这里沿用 AD3 的做法：`order_time >= :lo AND date(order_time) >= :since`——前者走索引缩小范围，后者是旧谓词原样复核，所以对应用自身写入的格式（`YYYY-MM-DD HH:MM:SS`）结果与旧 SQL 逐行相同；
 *   与 AD3 相同的已知残余（Codex 审计）：文本序低于 `lo`、但 SQLite `date()` 能解析的非规范值（儒略日数字串 `'2.4613375e6'`、`2026-02-31` 之类溢出日期）会被区间谓词挡掉，旧 SQL 会计入（ADR-0044 补充 3、4）。
 * 【边界】只产生 `{ sql, params }`，不碰数据库。窗口日期**不重复实现**，一律取 `dashboard-sql.js` 的 `onlineWindow()`（含非法 / 超范围窗口 → 绑定 NULL → 结果为空）。
 *   范围谓词（`omsPlatformScopeSql` / `omsOrderScopeSql` 的输出）由调用方传入、原样拼进 WHERE，参数紧跟在窗口两个参数之后，范围语义不变。
 * 【改它要注意】窗口参数 `[lo, since]` 永远排在 params 最前（SQL 里 `?` 的出现顺序决定绑定顺序：byPlatform 的窗口在 FROM 里的子查询中，先于外层 WHERE 的范围谓词）。
 *   改 SQL 就是改审计对象：先跑 `node scripts/explain-audit.mjs`（`oms.stats_*` / `ai.platform_analysis` 声明了 expectIndex + expectSearch）。
 *   AF3（ADR-0044 补充 5）：九条语句（含受限范围形态）现在都声明 expectIndex + expectSearch、没有 ALLOW 豁免——byPlatform 改写成"窗口子查询先聚合再并入平台"，
 *   受限范围谓词包 `likely()`（语义恒等，只改规划器的选择），topSkus 靠迁移 074 的 `idx_oms_items_order(oms_order_id)` 改成订单窗口驱动。
 *   代价：浮点列的累加顺序随计划变化（整数 / 文本 / 行序不变），与旧 SQL 的浮点差异 <= 1e-9 相对误差，测试按此口径比较，见 ADR-0044 补充 5。
 * ============================================================================
 */
import { onlineWindow } from './dashboard-sql.js'

/** 范围谓词 `{ sql, params }`（omsPlatformScopeSql / omsOrderScopeSql 的返回值）；缺省为全局 */
const GLOBAL = Object.freeze({ sql: '1=1', params: Object.freeze([]) })

/**
 * 范围谓词包一层 `likely()`（AF3）：语义恒等（原样返回参数），只是告诉规划器"这个条件多数行都满足"，
 * 于是受限范围的 `platform_id IN (子查询)` 不再被当成比 order_time 区间更有选择性的等值前缀（否则规划器改走 (platform_id, platform_order_no) 自动索引，
 * 读该范围内全部历史订单、窗口谓词只做过滤）。全局范围 `1=1` 套了也无影响。计划由 explain-audit 的 expectIndex / expectSearch 守卫。
 */
const scoped = (sql) => `likely(${sql})`

/**
 * /stats：各平台订单 / GMV / 待处理 / 退款。AF3 起"窗口先行"：子查询 `w` 先按 order_time 区间取窗口内订单并按平台聚合（覆盖索引 idx_oms_order_time 的范围 SEARCH），
 * 再左连 platforms 套范围谓词——平台是个位数，连接代价可忽略；无订单的平台仍出一行（COALESCE 成 0）。
 * 子查询里 `GROUP BY +platform_id` 的一元加号是刻意的：裸 `platform_id` 会让规划器改用 (platform_id, platform_order_no) 自动索引按平台顺序整表扫描，放弃时间索引。
 * 行序：旧写法 `GROUP BY pf.id ORDER BY gmv DESC`，同 gmv 的行按 pf.id 升序出现；这里把 pf.id 写进 ORDER BY 成为显式契约。
 * 浮点求和的累加顺序由"平台自动索引顺序"变为"order_time 索引顺序"，浮点列可能差最后一位（整数列、行序不变），见 ADR-0044 补充 5。
 */
export function omsStatsByPlatformStmt(days, ps = GLOBAL, now) {
  return {
    sql: `SELECT pf.name AS platform_name, pf.code, COALESCE(w.w_orders,0) orders,
                COALESCE(w.w_gmv,0) gmv, COALESCE(w.w_pending,0) pending, COALESCE(w.w_refund,0) refund_amount
         FROM platforms pf LEFT JOIN (
           SELECT platform_id, COUNT(*) w_orders,
                  SUM(CASE WHEN status NOT IN ('refunded','closed') THEN pay_amount ELSE 0 END) w_gmv,
                  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) w_pending,
                  SUM(CASE WHEN status='refunded' THEN pay_amount ELSE 0 END) w_refund
           FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? GROUP BY +platform_id) w ON w.platform_id=pf.id
         WHERE ${ps.sql} ORDER BY gmv DESC, pf.id`,
    params: [...onlineWindow(days, now), ...ps.params]
  }
}

/** /stats：按日趋势（os0 = omsOrderScopeSql(scope, 'oms_orders')） */
export function omsStatsTrendStmt(days, os0 = GLOBAL, now) {
  return {
    sql: `SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${scoped(os0.sql)} GROUP BY date(order_time) ORDER BY date`,
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
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${scoped(os0.sql)}`,
    params: [...onlineWindow(days, now), ...os0.params]
  }
}

/** /stats：热销标题 Top10（os = omsOrderScopeSql(scope, 'o')） */
export function omsStatsTopSkusStmt(days, os = GLOBAL, now) {
  return {
    sql: `SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE o.order_time >= ? AND date(o.order_time) >= ? AND ${scoped(os.sql)}
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
