'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/030_settlement_source.cjs ｜ 迁移：结算留痕来源通道（A14：商城/POS 接入结算域的前置）
 * ============================================================================
 * 【职责】迁移：结算留痕来源通道（A14：商城/POS 接入结算域的前置）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 030 结算留痕的「来源通道」（A14 —— 重开 F 渠道闭环的前置）
//
// 背景（验收复核 A14，🔴 阻断）：
//   F 营销中心已经是一个完整模块（迁移 025 + `lib/promotion.js` / `member.js` /
//   `coupon.js` / `checkout.js`），但**真实的商城与 POS 下单根本没接进来** ——
//   `checkout.settle` 全仓只有两处调用：`routes/promo.js` 的人工端点和 `db/promo-seed.js`。
//   商城自己算「会员价 × 数量 + 199 免运」，再 `UPDATE mall_customers SET points=points+floor(实付)`
//   （**1 元 1 分**，而 `member.js` 的口径是 **10 分/元**）—— 同一件事两套算法。
//
//   把商城与 POS 接到 `checkout.settle` 之后，立刻冒出一个必须先解决的问题：
//
//     **`promotion_adjustments.order_id` / `promotion_usages.order_id` /
//       `member_points_ledger.source_id` 只存了一个整数。**
//
//   而 `oms_orders.id` 与 `pos_orders.id` 是两张**独立自增**的表 —— 都会从 1 开始。
//   于是「商城第 418 单」与「门店第 418 单」在这些表里**长得一模一样**：
//     · `revertUsage(orderId=418)` 会把两张单的优惠留痕**一起撤掉**；
//     · `persistAdjustments(orderId=418)` 会先 `DELETE ... WHERE order_id=418`，
//       把另一张单的留痕**清掉**；
//     · `releaseCoupon(orderId=418)` 会把另一张单核销掉的券**退回去**；
//     · `member_points_ledger(source_type='order', source_id=418)` 的幂等判重会
//       让「第二张 418 单送分被当成重复」而**静默不送**。
//   这四条都不会报错，只会让账对不上 —— 正是本项目反复踩到的「同一份判据缺一个维度」。
//
//   （同类事故在本项目已有先例：`purchase_settlement_items.source_id` 在
//     `receipt` 下是入库单 id、在 `invoice` 下是发票 id，当时漏了 `source_type`
//     就联出了一批不存在的关系。）
//
// 所以这一列补的不是「多存一个字段」，而是**让"这张留痕属于哪张单"在数据上成立**。
//
// 加列清单：
//   promotion_adjustments.source    —— 'oms' / 'pos' / 'so'（人工）
//   promotion_usages.source         —— 同上（`idempotency_key` 也拼上它，见 promotion.js）
//   member_points_ledger.source     —— 同上（`source_type` 仍是 'order'，`source` 才是通道）
//   coupon_instances.source         —— 同上（券核销/退回都要能定位到唯一一张单）
//   pos_order_items.{member,promo,points}_discount_cents
//                                   —— 门店单的**行级优惠三段**，与 `oms_order_items`
//                                      在 025 里加的完全对称。理由也一样：
//                                      `pos_orders.discount_amount` 只有一个整单数，
//                                      回答不了"减在哪几行"，退货时就算不出"这一行实付多少"。
//
// 存量回填：**只有一个来源**（`routes/promo.js` 的人工端点与 promo-seed 都按
// `oms_orders.id` 归属），所以一律回填 `'oms'`。
// 回填不猜：`source` 一旦写错，撤单就会撤到别人头上，而这种错在界面上看不出来。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '结算留痕来源通道（A14：商城/POS 接入结算域的前置）'

const COLUMNS = [
  ['promotion_adjustments', 'source', "TEXT NOT NULL DEFAULT 'oms'"],
  ['promotion_usages', 'source', "TEXT NOT NULL DEFAULT 'oms'"],
  ['member_points_ledger', 'source', 'TEXT'],
  ['coupon_instances', 'source', 'TEXT'],
  ['pos_order_items', 'member_discount_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['pos_order_items', 'promo_discount_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['pos_order_items', 'points_discount_cents', 'INTEGER NOT NULL DEFAULT 0'],
  // 赠送积分对应的**消费基数（分）**。撤单要把当初计入的累计消费退回去，
  // 而"当初记了多少"只有这里说得清：让调用方再算一遍的后果是
  // 含运费/手工让利的单会**悄悄差一截**（实测餐饮库差 1200 分 = 运费 12 元），
  // 而这种差不会报错，只会让客户的会员等级迟迟不掉下来。
  ['member_points_ledger', 'base_cents', 'INTEGER']
]

const INDEXES = [
  {
    name: 'idx_promotion_adj_src',
    sql: 'CREATE INDEX IF NOT EXISTS idx_promotion_adj_src ON promotion_adjustments (source, order_id)'
  },
  {
    name: 'idx_promotion_usages_src',
    sql: 'CREATE INDEX IF NOT EXISTS idx_promotion_usages_src ON promotion_usages (source, order_id)'
  },
  {
    name: 'idx_points_ledger_src',
    sql: 'CREATE INDEX IF NOT EXISTS idx_points_ledger_src ON member_points_ledger (source, source_id, kind)'
  },
  {
    name: 'idx_coupon_instances_src',
    sql: 'CREATE INDEX IF NOT EXISTS idx_coupon_instances_src ON coupon_instances (source, order_id)'
  }
]

module.exports.up = function up(db) {
  for (const t of [
    'promotion_adjustments', 'promotion_usages', 'member_points_ledger', 'coupon_instances', 'pos_order_items'
  ]) {
    if (!tableExists(db, t)) {
      throw new Error(`${t} 不存在，迁移顺序有误（应先执行 025_promo_member / 024_pos_shift_cash）`)
    }
  }
  // 存量回填 `base_cents`：只有"订单赠送积分"这一种流水有消费基数，
  // 老数据无从反推（那笔消费当时没被记下来），**留 NULL 不猜** ——
  // 撤单时读到 NULL 就退回调用方给的名义金额（见 member.reverseOrderPoints）。
  for (const [t, c, decl] of COLUMNS) addColumn(db, t, c, decl)

  // 存量回填：迁移前只有 'oms' 一个真实来源（人工端点与 promo-seed 都按 oms_orders.id 归属）
  db.prepare("UPDATE promotion_adjustments SET source='oms' WHERE source IS NULL OR source=''").run()
  db.prepare("UPDATE promotion_usages SET source='oms' WHERE source IS NULL OR source=''").run()
  db.prepare(
    "UPDATE member_points_ledger SET source='oms' WHERE source IS NULL AND source_type='order'"
  ).run()
  db.prepare(
    "UPDATE coupon_instances SET source='oms' WHERE source IS NULL AND order_id IS NOT NULL"
  ).run()

  for (const ix of INDEXES) db.exec(ix.sql)

  const def = { columns: COLUMNS, indexes: INDEXES.map((x) => x.name) }
  stampDef(db, '030_settlement_source', def)
  return { columns: COLUMNS.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  for (const t of [
    'promotion_adjustments', 'promotion_usages', 'member_points_ledger', 'coupon_instances', 'pos_order_items'
  ]) {
    if (!tableExists(db, t)) return false
  }
  for (const [t, c] of COLUMNS) if (!hasColumn(db, t, c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量：已落库的订单留痕必须能定位到唯一一张单（source 非空）
  const badAdj = db
    .prepare("SELECT COUNT(*) c FROM promotion_adjustments WHERE source IS NULL OR source=''")
    .get().c
  if (badAdj > 0) return false
  const badUsage = db
    .prepare("SELECT COUNT(*) c FROM promotion_usages WHERE source IS NULL OR source=''")
    .get().c
  if (badUsage > 0) return false
  // 订单来源的积分流水同样必须带通道
  const badPoints = db
    .prepare(
      "SELECT COUNT(*) c FROM member_points_ledger WHERE source_type='order' AND (source IS NULL OR source='')"
    )
    .get().c
  if (badPoints > 0) return false

  const def = { columns: COLUMNS, indexes: INDEXES.map((x) => x.name) }
  if (defStale(db, '030_settlement_source', def)) return false
  return true
}
