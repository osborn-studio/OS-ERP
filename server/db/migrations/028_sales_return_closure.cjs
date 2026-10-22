'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/028_sales_return_closure.cjs ｜ 迁移：销售退货闭环（来源行绑定 / 退量上限 / 成本追溯 / 应收冲减 / 幂等键）
 * ============================================================================
 * 【职责】迁移：销售退货闭环（来源行绑定 / 退量上限 / 成本追溯 / 应收冲减 / 幂等键）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 028 销售退货闭环：来源行绑定 / 退量上限 / 成本追溯 / 应收冲减 / 幂等键
//
// 背景（验收复核 D1，🔴 阻断）：
//   `POST /api/sales/returns` 只把 `order_id` 存进表头，明细**不绑销售订单行**，
//   也不查"该行已发多少、已退多少" —— 除了 `qty <= 0` 之外没有任何校验。
//   实测：已发 94 件，一次退 189 件（= 94×2+1）→ **200 / code 0 / success true**。
//   另外两处更隐蔽：
//     · 退货入库成本直接取客户端传的 `price`（实测 9999 被写进库存成本层，
//       污染后续出库成本与三层残差）；
//     · 函数体内没有任何 `ar_documents` 逻辑 —— 退货后原应收金额**分毫未动**。
//
// 为什么这一条必须动数据层：
//   "退量上限"的判据是「**Σ本次退量 + Σ历史已退量 ≤ 已发量**」。
//   而"历史已退量"要按**来源行**聚合 —— 明细上根本没有来源行，这个数就算不出来。
//   所以先要有一列 `order_item_id` 把退货明细绑回 `sales_order_items`。
//
// 加列清单（每一列都在回答一个此前答不出的问题）：
//   sales_returns.source_type        —— 这张退货单是"有单退货"还是"无单退货"（walkin）
//   sales_returns.idempotency_key    —— 同一次退货请求重放不得重复冲减（可选，非空时唯一）
//   sales_returns.ar_id              —— 冲减的是哪张应收（可追溯）
//   sales_returns.ar_offset_amount   —— 冲减了多少（"退货后应收按退货额变动"的证据）
//   sales_returns.refund_due         —— 应收未结余额不够冲的那部分 = 待退款额（如实登记，不静默）
//   sales_return_items.order_item_id —— **来源行绑定**，退量上限判据的唯一依据
//
// 存量数据回填（迁移不只是改结构，还要把老数据带过去）：
//   ① `source_type`：`order_id` 为空 ⇒ `walkin`，否则 `order`；
//   ② `order_item_id`：按 (退货单的 order_id, sku_id) 唯一匹配回填。
//      匹配不上的保持 NULL —— **不猜**：猜错会让"历史已退量"算到别的行头上，
//      而那种错在界面上完全看不出来（退量上限从此对不上，且没有任何报错）。
//
// 判据只留一处：`lib/returns.js` 的 `planReturn()`。
// 路由与门店退货（POS）共用它 —— 验收侧明确要求"销售退货与门店退货两处都要有上限"。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '销售退货闭环（来源行绑定 / 退量上限 / 成本追溯 / 应收冲减 / 幂等键）'

const COLUMNS = [
  ['sales_returns', 'source_type', "TEXT NOT NULL DEFAULT 'order'"],
  ['sales_returns', 'idempotency_key', 'TEXT'],
  ['sales_returns', 'ar_id', 'INTEGER'],
  ['sales_returns', 'ar_offset_amount', 'REAL NOT NULL DEFAULT 0'],
  ['sales_returns', 'refund_due', 'REAL NOT NULL DEFAULT 0'],
  ['sales_return_items', 'order_item_id', 'INTEGER']
]

const INDEXES = [
  {
    name: 'idx_sales_returns_idem',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_returns_idem ON sales_returns (idempotency_key) WHERE idempotency_key IS NOT NULL"
  },
  {
    name: 'idx_sales_return_items_src',
    sql: 'CREATE INDEX IF NOT EXISTS idx_sales_return_items_src ON sales_return_items (order_item_id)'
  }
]

module.exports.up = function up(db) {
  if (!tableExists(db, 'sales_returns') || !tableExists(db, 'sales_return_items')) {
    throw new Error('sales_returns / sales_return_items 不存在，迁移顺序有误')
  }
  for (const [t, c, decl] of COLUMNS) addColumn(db, t, c, decl)

  // ① 存量 source_type 回填：没有关联订单的就是"无单退货"
  db.prepare(
    "UPDATE sales_returns SET source_type = CASE WHEN order_id IS NULL THEN 'walkin' ELSE 'order' END WHERE source_type IS NULL OR source_type=''"
  ).run()

  // ② 存量来源行回填：按 (订单, SKU) 唯一匹配 —— 匹配不上就留 NULL（不猜）
  db.prepare(`
    UPDATE sales_return_items
       SET order_item_id = (
         SELECT i.id FROM sales_order_items i
          JOIN sales_returns r ON r.id = sales_return_items.return_id
         WHERE i.order_id = r.order_id AND i.sku_id = sales_return_items.sku_id
         ORDER BY i.id LIMIT 1
       )
     WHERE order_item_id IS NULL
       AND EXISTS (
         SELECT 1 FROM sales_returns r
          WHERE r.id = sales_return_items.return_id AND r.order_id IS NOT NULL
       )
  `).run()

  for (const ix of INDEXES) db.exec(ix.sql)

  const def = { columns: COLUMNS, indexes: INDEXES.map((x) => x.name) }
  stampDef(db, '028_sales_return_closure', def)
  return { columns: COLUMNS.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'sales_returns') || !tableExists(db, 'sales_return_items')) return false
  for (const [t, c] of COLUMNS) if (!hasColumn(db, t, c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false
  // 不变量：有 order_id 的退货单不该被标成 walkin（回填写错会在这里被抓到）
  const bad = db
    .prepare("SELECT COUNT(*) c FROM sales_returns WHERE order_id IS NOT NULL AND source_type='walkin'")
    .get().c
  if (bad > 0) return false
  const def = { columns: COLUMNS, indexes: INDEXES.map((x) => x.name) }
  if (defStale(db, '028_sales_return_closure', def)) return false
  return true
}
