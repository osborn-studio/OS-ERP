'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/045_inv_txn_doc_types.cjs ｜ 迁移：库存事务类型字典补录 MR / MO / PUR_IN_REV
 * ============================================================================
 * 【职责】迁移：库存事务类型字典补录 MR / MO / PUR_IN_REV
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 045 把「已被写进 inventory_transactions.doc_type、却不在库存事务类型字典里」的单据类型码
// 补进 inv_txn_types，让这一列的值域闭合。
//
// ── 背景（审计缺口 [11]：doc_type 值域不闭合）────────────────────────────────
// 这一列有三条互不一致的「来源」：
//   · `inv_txn_types`（字典，003 声明 27 码 + 022 补 QC_RET_OUT = 28 码）；
//   · `lib/stock.js` 的 `DOC_TYPE_LABEL`（文案，28 键）；
//   · 代码**实际写出去**的值。
// 四个对不上号的码（本轮全部闭合）：
//   · `MR`         `lib/mfg.js:460` 领料出库（docType:'MR' + txnType:'PRD_OUT'）；只在 doc_types 注册表里
//   · `MO`         `lib/mfg.js:835` 完工入库（docType:'MO' + txnType:'PRD_IN'）；只在 doc_types 注册表里
//   · `PUR_IN_REV` `db/procure-seed.js:146` 回滚收货；只在 DOC_TYPE_LABEL 里
//   · `QC_RET_OUT` 022 补进了字典、却漏了 DOC_TYPE_LABEL 文案（"只补了半边"）
//
// ── 决策：登记跟代码（NOT 代码跟字典）───────────────────────────────────────
//   1. `MR` / `MO` 在基线三库里是**真实存量**（MR 8/5/7 行、MO 2/1/2 行）；
//      改写出值会让同一业务的旧行与新行取不同码，历史上「按 doc_type 对账」直接断掉。
//   2. 有反查点**硬依赖**这两个码：`lib/mfg.js:1017`（重复入库判据 `doc_type='MO'`）、
//      `lib/qc2.js:200`（取完工批次 `doc_type='MO'`）。其中 `lib/qc2.js` 属本轮**禁改**文件 ——
//      「代码跟字典」在不动它的前提下，会把模块 13 质检链的批次回查直接打断。
//
// 本迁移只做一件事：把这 3 个码 UPSERT 进字典（幂等，不新建列、不改 schema.sql、不动历史行）。
// 文案仍统一收在 `lib/stock.js` 的 `DOC_TYPE_LABEL`；「字典码 ⇄ 文案键」的双向闭合
// 由常驻守卫 `scripts/check-inv-txn-dict.mjs` 钉住 —— 以后只改一处会立刻变红。

const { stampDef, defStale, tableExists } = require('./_helpers.cjs')

// [code, name, direction, biz_category, cost_effect, sort_order]
// name 必须与 `lib/stock.js` 的 DOC_TYPE_LABEL 一致（守卫按码比对，人的眼睛按名字比对）。
// sort_order 沿用既有编号习惯：003 base 10..190、extra 210..280、022 的 QC_RET_OUT=285。
const DOC_TYPES = [
  ['MR', '生产领料出库', 'out', 'produce', 'normal', 290],
  ['MO', '生产完工入库', 'in', 'produce', 'normal', 300],
  ['PUR_IN_REV', '采购入库回滚', 'out', 'purchase', 'normal', 310]
]

module.exports.name = '库存事务类型字典补录 MR / MO / PUR_IN_REV'

module.exports.up = function up(db) {
  // 表不存在就报错而不是静默跳过：静默跳过会让迁移被记为「已执行」而码根本没进库，
  // 此后 `verify()` 一直不过、runner 每次启动都重跑（本项目 _helpers 的真实事故形状）。
  if (!tableExists(db, 'inv_txn_types')) {
    throw new Error('inv_txn_types 不存在，迁移顺序有误（应先执行 003_inv_dict）')
  }
  const ins = db.prepare(
    `INSERT INTO inv_txn_types (code,name,direction,biz_category,cost_effect,status,sort_order)
     VALUES (?,?,?,?,?, 'active', ?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, direction=excluded.direction,
       biz_category=excluded.biz_category, cost_effect=excluded.cost_effect, sort_order=excluded.sort_order`
  )
  for (const [code, name, direction, cat, effect, sort] of DOC_TYPES) {
    ins.run(code, name, direction, cat, effect, sort)
  }
  stampDef(db, '045_inv_txn_doc_types', { DOC_TYPES })
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'inv_txn_types')) return false
  for (const [code] of DOC_TYPES) {
    if (!db.prepare('SELECT 1 AS hit FROM inv_txn_types WHERE code=?').get(code)) return false
  }
  if (defStale(db, '045_inv_txn_doc_types', { DOC_TYPES })) return false
  return true
}
