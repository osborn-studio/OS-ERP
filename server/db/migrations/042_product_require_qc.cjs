'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/042_product_require_qc.cjs ｜ 迁移：成品「启用质检」开关（products.require_qc）
 * ============================================================================
 * 【职责】迁移：成品「启用质检」开关（products.require_qc）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 042 成品「启用质检」开关（products.require_qc）
//
// 客户口径（原话）：
//   「检验成品默认不可售，但客户可以选择成品是否开启质检：成品属性里开启质检，
//     就这批货必须走质检流程才能出售；不开启，这个成品可售。」
//
// 这句话要落成一个**开在商品主数据上的开关**，而不是又一个全局参数：
//   · 检不检是**按商品**定的（同一个仓里，A 品必须检验合格才能卖、B 品不用），
//     全局参数（`inv_params.block_pending_qc`）只能表达"全行业一刀切"，
//     用它来表达"这个成品要不要检"注定要在别的表上再挂一份例外，然后两份口径分叉；
//   · 开与关是**人的业务选择**，所以它必须落在可以被界面读到、被接口写回的地方。
//
// 取值语义（判据的唯一落点见 `server/lib/stock.js` 的 `qcPolicy`）：
//   require_qc = 1 ⇒ 该商品的批次**必须** `qc_status='qualified'` 才允许被当可售货消耗；
//                    `pending`（待检）与 `rejected`（不合格）都拒，且拒因文案不同。
//   require_qc = 0 ⇒ **完全沿用加这一列之前的行为**（只看全局 `block_pending_qc` /
//                    `block_rejected_qc`）。
//
// ⚠️ 默认值取 0 是有意义的：存量商品一律 0 ⇒ 新列对既有库是**纯增列、零行为变化**，
//    既有的「待检默认放行」演示链路一步都不会因此走不动。开启质检是显式的业务动作。
//
// 为什么不改 `schema.sql`：本项目的建表脚本与迁移是两条路（结构自检靠迁移的 verify），
// 追加列必须走迁移才能落到**已经建好的三套库**上；只改 schema.sql 对存量库是无声无息的。
// `addColumn` 自带幂等（缺列才加），`verify()` 让 runner 在结构脱节时自动重跑本迁移（up 幂等），
// 于是"下次启动收敛"这句话成立 —— 库里没有这一列时，下次启动会被补回来。

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '成品「启用质检」开关（products.require_qc）'

// 加列（不是加表）：**存量行一律 0** —— 0 = 不启用 = 沿用旧行为。
const NEW_COLUMNS = [
  ['products', 'require_qc', 'INTEGER NOT NULL DEFAULT 0']
]

module.exports.up = function up(db) {
  for (const [t, c, decl] of NEW_COLUMNS) addColumn(db, t, c, decl)

  // 取值域收敛：`require_qc` 只认 0 / 1（见 verify 的说明）。脏值不可能来自界面的选择
  // （接口写入时已被强制转成 0/1，见 `server/routes/master.js`），只可能来自直写库，
  // 而它按闸门的 `Number(...) === 1` 会被静默当成"不启用"。这里**归一到 0（不启用 = 沿用旧行为）**
  // —— 之所以敢覆盖：0/1 之外的值不构成一个业务选择，"保留一个非法值"没有意义。
  // 归一放在 up() 里，是为了让 verify() 这条不变量**可被 up() 修好**：
  // 只判不修的 verify 会让 runner 每次启动都重跑一遍却永远收敛不了。
  const fixed = db
    .prepare('UPDATE products SET require_qc=0 WHERE require_qc IS NULL OR require_qc NOT IN (0,1)')
    .run().changes

  // 定义指纹：本迁移的「定义」就是这一列的落点与语义。
  stampDef(db, '042_product_require_qc', {
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`)
  })
  return { columns: NEW_COLUMNS.length, normalized: fixed }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'products')) return false
  for (const [t, c] of NEW_COLUMNS) if (!hasColumn(db, t, c)) return false
  // 取值域：这一列只允许 0 / 1。写成别的值不会报错，但"要不要检"从此没有确定答案，
  // 而闸门按 `Number(...) === 1` 判 ⇒ 脏值会被静默当成"不启用"，正是最坏的那种失败。
  const bad = db
    .prepare('SELECT COUNT(*) c FROM products WHERE require_qc IS NULL OR require_qc NOT IN (0,1)')
    .get().c
  if (bad > 0) return false
  if (defStale(db, '042_product_require_qc', { columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`) })) return false
  return true
}
