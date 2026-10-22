/**
 * ============================================================================
 * 文件标识：server/lib/catalog.js ｜ 「可售商品」的判据 —— **只在这里实现一次**。
 * ============================================================================
 * 【职责】「可售商品」的判据 —— **只在这里实现一次**。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 「可售商品」的判据 —— **只在这里实现一次**。
 *
 * 背景（收尾批次实测）：演示造数里有三处「挑几个商品当样本」的筛选
 * （POS 收银样本 / 渠道协议价样本 / 订货中心样本），其中两处漏了"排除原料"这一条。
 * 后果不是"数据少了一点"，而是**整库重建直接崩**：
 *   · 门店仓堆了 >= 5 件原料 ⇒ 原料按库存量排进 POS 候选 ⇒
 *     `posQuote` 以「SKU#40 单价异常」抛错（原料零售价为 0），seed 挂掉；
 *   · 协议价样本按 id 取前 40 个 SKU ⇒ 取到原料 ⇒ `round2(0 * 0.82) = 0` ⇒
 *     `createAgreement` 以「定价型协议必须给协议单价」拒绝。
 * 两处报错点离真正的原因（取样没排除非卖品）都隔着好几层调用栈，
 * 而且**只在"某个仓恰好堆了原料"时复现** —— 换个库、换次重建都可能不复现。
 *
 * 判据两条，缺一不可：
 *   · `products.item_type = 'material'`（原料 / 包材）—— 分类上的排除；
 *   · `price_retail > 0` —— **"能零售"的可操作定义是"有零售价"**。
 *     这是比 item_type 更本质的一条：分类可能没人维护，售价是事实。
 */
export const SELLABLE_JOIN = 'JOIN products p ON p.id = s.product_id'
export const SELLABLE_COND = "IFNULL(p.item_type,'') <> 'material' AND s.price_retail > 0"

/** 某仓库里**可售且有货**的样品（按库存量降序 —— 顺序确定，可复现） */
export function sellableSkusInWarehouse(db, warehouseId, { minQty = 5, limit = 8 } = {}) {
  return db
    .prepare(
      // `ORDER BY SUM(...)` 而不是 bare column：
      // `GROUP BY` 之后写 `ORDER BY st.qty_on_hand` 取的是"组内任意一行"的值（SQLite 允许），
      // 于是**同一份数据每次重建可能排出不同顺序** —— 演示样本会换人，
      // 依赖样本的断言与截图就随机漂移。聚合列必须显式写出来。
      `SELECT s.id, s.sku_code, s.price_retail, s.price_member, SUM(st.qty_on_hand) AS qty_on_hand
         FROM inventory_stocks st
         JOIN product_skus s ON s.id = st.sku_id
         ${SELLABLE_JOIN}
        WHERE st.warehouse_id = ? AND st.qty_on_hand >= ?
          AND ${SELLABLE_COND}
        GROUP BY s.id
        ORDER BY qty_on_hand DESC, s.sku_code
        LIMIT ?`
    )
    .all(warehouseId, minQty, limit)
}

/** 全局可售样品（按 id 升序）。额外带出 `product_item_type`，让调用方能自己复述判据 */
export function sellableSkus(db, { limit = 40 } = {}) {
  return db
    .prepare(
      `SELECT s.*, p.item_type AS product_item_type FROM product_skus s
         ${SELLABLE_JOIN}
        WHERE s.status='active' AND ${SELLABLE_COND}
        ORDER BY s.id LIMIT ?`
    )
    .all(limit)
}

/**
 * 单条判定 —— 给"手上已经有一行 SKU（可能还带着 products 的列）"的场景用。
 * 与上面两段 SQL **同一份判据**（改一处必须改另一处，所以这里刻意把两条规则
 * 并列写出而不是复用字符串拼接：SQL 片段拼出来的表达式在 JS 里读不出语义）。
 */
export function isSellable({ item_type: itemType, price_retail: priceRetail } = {}) {
  return String(itemType ?? '') !== 'material' && Number(priceRetail) > 0
}

export default { SELLABLE_JOIN, SELLABLE_COND, sellableSkusInWarehouse, sellableSkus, isSellable }
