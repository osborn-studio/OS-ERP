'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/046_oc_statement_actions.cjs ｜ 迁移：订货对账单终局动作：结清 / 作废（oc_statements 终局列）
 * ============================================================================
 * 【职责】迁移：订货对账单终局动作：结清 / 作废（oc_statements 终局列）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 046 订货对账单（oc_statements）的两个终局动作：结清 / 作废 —— 只补列，不建新表
//
// ===========================================================================
// 一、为什么这是**第二个**迁移（043 已经给经销商对账单补过一次同样的列）
// ===========================================================================
// 因为它们是**两张表、两个载体**，而不是同一件事的两处实现：
//   · `dealer_statements`（DS）—— 经销商对账单，路由在 `/api/dealers/statements`；
//   · `oc_statements`（OCS）—— 订货对账单，路由在 `/api/order-center/statements`。
// 一个迁移只能 ALTER 一张表，所以列要各补一次。
// 但**口径必须一致**：两个载体的"结清/作废"都要回答同样两件事
// （谁、何时、为什么；作废只动凭证不动底层台账）。两边分叉的话，客户会发现
// "经销商对账单确认过也能作废、订货对账单确认过就不能"——同一条业务两条路径两个语义。
//
// ===========================================================================
// 二、列的形状**对齐 OCS 自己的既有风格**，而不是照抄 043
// ===========================================================================
// `oc_statements` 早就有一对 `confirmed_by TEXT` / `confirmed_at TEXT`
// （见 `010_order_center.cjs`）——它把操作人存成**姓名字符串**，不是 `id + name` 两列。
// 所以这里补的是 `closed_by TEXT` / `voided_by TEXT`，与 `confirmed_by` 同形。
// 照抄 043 的 `closed_by INTEGER + closed_by_name TEXT` 会让同一张表里
// "确认人是一列、结清人是两列"——以后按这两列做统计的人必然踩一次。
//
// ===========================================================================
// 三、`close_reason` / `void_reason` 为什么必须落在单上
// ===========================================================================
// 留痕（`doc_events`）是**事件流**，打开一张对账单时不该让人去事件流里翻最后一条；
// 而终局结论（这份账什么时候结清的、谁结的、为什么作废）是**单据的当前属性**。
//   · 结清有两条路：① 钱真的收齐（自动判据，见 `lib/order-center.js`）；
//     ② 业务判断手动结清（`force`，例如坏账核销、以预收/返利抵扣后仍有尾差）。
//     ② 是**越权**动作，必须留理由。
//   · 作废是高危动作（内核对 OCS 的 void 边 `is_danger=1`），一样必须留理由。
// 两者都写：事件流有痕（谁/何时/从哪到哪）、单据上有结论（为什么）。
//
// ⚠️ 本迁移**不新增任何状态**：OCS 的 `draft/confirmed/closed/voided` 四个状态
//    与 `confirm/close/void` 三条边（本轮给 `void` 补了一条 `confirmed → voided`）
//    都在 `008_doc_kernel.cjs` 里，本来就是数据。这里只补"落结论"的列。

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '订货对账单终局动作：结清 / 作废（oc_statements 终局列）'

const STATEMENT_TABLE = 'oc_statements'

// 终局列清单（顺序与 043 对应；类型对齐本表的 `confirmed_by TEXT`）。
const COLUMNS = [
  ['closed_at', 'TEXT'],
  ['closed_by', 'TEXT'], // 与 `confirmed_by` 同形：姓名字符串
  ['close_reason', 'TEXT'],
  ['voided_at', 'TEXT'],
  ['voided_by', 'TEXT'], // 与 `confirmed_by` 同形
  ['void_reason', 'TEXT']
]

const DEF = { table: STATEMENT_TABLE, columns: COLUMNS.map(([c]) => c) }

module.exports.up = function up(db) {
  // 表不存在必须报错，不能静默跳过：跳过会让本迁移被记为已执行、而结构其实没变，
  // 直到运行时才炸（food 库的真实事故，见 _helpers.cjs 注释）。
  if (!tableExists(db, STATEMENT_TABLE)) {
    throw new Error(`${STATEMENT_TABLE} 不存在，迁移顺序有误（应先执行 010_order_center）`)
  }
  let added = 0
  for (const [col, decl] of COLUMNS) if (addColumn(db, STATEMENT_TABLE, col, decl)) added++
  stampDef(db, '046_oc_statement_actions', DEF)
  return { columns: COLUMNS.length, added }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, STATEMENT_TABLE)) return false
  for (const [col] of COLUMNS) if (!hasColumn(db, STATEMENT_TABLE, col)) return false
  if (defStale(db, '046_oc_statement_actions', DEF)) return false
  return true
}
