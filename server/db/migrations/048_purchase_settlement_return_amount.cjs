'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/048_purchase_settlement_return_amount.cjs ｜ 迁移：采购结算单补退货抵减额（purchase_settlements.return_amount）
 * ============================================================================
 * 【职责】迁移：采购结算单补退货抵减额（purchase_settlements.return_amount）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 048 采购结算单补一列 `return_amount`（退货抵减额）—— 只补列，不建新表
//
// ===========================================================================
// 一、为什么这一列必须有（而不是"明细里有负数行就够了"）
// ===========================================================================
// 客户口径（原话）：「退货是否递减这种你都可以做到供应链设置里，客户选择是，就递减，
// 不设就不抵，这个供应链设置可以全局覆盖。」
//
// 于是退货抵减变成**可配置行为**（`settings.purchase_return_offset`，默认关）。一旦打开，
// `purchase_settlements.settle_amount` 会**小于**入库/发票金额，差多少？
// 如果没有这一列，读者只能去明细里把 `source_type='return'` 的负数行加起来倒推 ——
// 那是"让人拿计算器读报表"，而这张单的第一诉求就是"这票该付多少、为什么"。
// ⇒ 抵减额必须**落在单头上**，与 `settle_amount` 并排，一眼可核。
//
// 命名与既有列同族：`order_amount` / `receipt_amount` / `invoice_amount` / `fee_amount`
// 都是"某一类来源的金额"，本列即"退货这一类来源的金额"（**存正数**，
// 方向由"它是抵减项"这件事在 `settle_amount` 的算法里体现；明细行才存负数）。
// 存正数的理由：同一列里正负混存会让"抵了多少"变成"看符号"，而符号是最容易被
// `SUM()`/前端格式化悄悄吃掉的东西。
//
// ===========================================================================
// 二、默认值必须是 0（= 上线前的实际行为）
// ===========================================================================
// 配置底座的铁律：**默认值 = 上线前的实际行为**。本批之前退货完全不参与结算 ⇒
// 所有既有结算单的抵减额都是 0。回填 0 之后，老数据在新代码下的解释与改之前**逐字相同**
// （`settle_amount` 本来就没减过），不存在"改完账变了"。
//
// ⚠️ 反过来才危险：若默认写成一个非 0 的历史值、或回填时按当前退货额补算，
// 会把**已经审过、已经付过款**的结算单的抵减额凭空改成非 0 —— 账面上多出一笔
// "退过但没记账"的钱，而两边都不报错。这正是本批拒绝"追溯"的原因：
// **抵减只对新建的结算单生效**，已生成的结算单不动（见 `buildSettlement` 的注释）。
//
// ===========================================================================
// 三、为什么不加索引、不加外键
// ===========================================================================
// · 索引：这一列只出现在"读单头"的场景（按 id / 按供应商期间），既有索引已覆盖；
//   没有"按 return_amount 查单"的诉求，加了是白付写入代价。
// · 外键：它是个**汇总数**（一张结算单可能抵多张退货），不是指向某一张退货的引用；
//   真正的引用在 `purchase_settlement_items.source_id`（`source_type='return'`）。
//   给汇总数加外键是无意义的（本项目的"一个事实一个存储"在这里体现为：
//   引用关系交给明细，单头只放数）。
const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '采购结算单补退货抵减额（purchase_settlements.return_amount）'

const TABLE = 'purchase_settlements'
const COLUMN = 'return_amount'
const DECL = 'REAL NOT NULL DEFAULT 0'
const DEF = { table: TABLE, column: COLUMN, decl: DECL }

module.exports.up = function up(db) {
  // 表不存在时**必须报错**，不能静默跳过：跳过会让本迁移被记为已执行、
  // 而结构其实没变，直到运行时才炸（food 库的真实事故，见 _helpers.cjs 注释）。
  if (!tableExists(db, TABLE)) {
    throw new Error(`${TABLE} 不存在，迁移顺序有误（应先执行基础建表 schema.sql）`)
  }
  // addColumn 自带幂等（缺列才加），所以整库重建后重跑本迁移能收敛。
  const added = addColumn(db, TABLE, COLUMN, DECL)
  // 脏值归一：历史上这一列不存在，不可能有脏值；但若有人手工加过同名列却没有默认值，
  // 会出现 NULL —— 而 NULL 会让 `settle_amount` 的加减法悄悄变成 NULL。
  const fixed = db.prepare(`UPDATE ${TABLE} SET ${COLUMN}=0 WHERE ${COLUMN} IS NULL`).run().changes
  stampDef(db, '048_purchase_settlement_return_amount', DEF)
  return { added, fixed }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, TABLE)) return false
  // 列缺失 → 重跑 up()。整库重建会把表按 schema.sql 重造回"无本列"的状态，
  // 只查表存在会误判为已迁移，新增列凭空消失。
  if (!hasColumn(db, TABLE, COLUMN)) return false
  // 取值域：抵减额**不允许为负**（存正数，方向由算法体现）。负值说明有人把明细行的符号
  // 搬到了单头 —— 那样 `settle_amount` 会被"减负数"变成加法，账更难对，且不报错。
  const bad = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE ${COLUMN} IS NULL OR ${COLUMN} < 0`).get().c
  if (bad > 0) return false
  // 定义指纹：列清单改了也能被发现。新增列却忘了写进 DEF 时这里恒假，下次启动重跑 up() 补齐。
  if (defStale(db, '048_purchase_settlement_return_amount', DEF)) return false
  return true
}
