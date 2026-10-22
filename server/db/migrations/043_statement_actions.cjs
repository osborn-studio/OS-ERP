'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/043_statement_actions.cjs ｜ 迁移：对账单终局动作：结清 / 作废（dealer_statements 终局列）
 * ============================================================================
 * 【职责】迁移：对账单终局动作：结清 / 作废（dealer_statements 终局列）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 043 对账单的两个终局动作：结清（close）/ 作废（void）—— 只补列，不建新表
//
// ===========================================================================
// 一、为什么"对账单"要的是终局状态，而不是复用既有的 status
// ===========================================================================
// 客户要的两件事是明确的：
//   · **结清**：这一期的账双方对完、钱也收齐了，这份对账单可以封存；
//   · **作废**：这份对账单作废（录错了 / 开重复了 / 客户不认）。
// 它们与既有的 `draft / confirmed / sent` **不是同一层**：
//   `draft → confirmed → sent` 描述的是「这份对账单的**出具过程**」；
//   `closed / voided` 描述的是「这份对账单的**终局结论**」。
// 终局必须**不可逆**（内核状态机里 `closed` 与 `voided` 都是终态、无出边），
// 否则"结清过的账又被悄悄改回未结"，对账结论就没有意义了。
//
// ⚠️ 本迁移**不新造名词**（例如 `issued`）。内核 `008_doc_kernel.cjs` 的 DS 状态机
// 已经用 `draft / confirmed` 表达"已确认出具"，另造一个 `issued` 只会出现
// "同一件事两个词、两处判据"——本项目最贵的一类缺陷。作废所需的 `voided`
// 由 008 一并补进内核（与 OCS 的 `voided` 对齐）。
//
// ===========================================================================
// 二、列的选择：动作的「人 / 时间 / 理由」要落在**单上**，而不只在留痕里
// ===========================================================================
// 留痕（`doc_events`）回答"这次流转是谁、何时、从哪到哪"——它是**事件流**。
// 但打开一张对账单时，第一眼要看的是"这份账什么时候结清的、谁结的、为什么"，
// 那是**单据的当前属性**，不该让人去事件流里翻最后一条。
// 所以（与 038 的留痕表分工同源）：
//   · `doc_events` = 事件流（内核 `applyTransition()` 自动写，**本迁移不碰**）；
//   · 本迁移补的列 = 单据上的终局快照（`closed_*` / `voided_*`）。
//   **两处都写、且在同一事务里**。只写一处的话，要么打开单据看不出结论，
//   要么事件流断了——两种都让"对账结论"变成不可追溯的说法。
//
// ===========================================================================
// 三、`close_reason` 为什么必须存在（而不只是 doc_events.remark）
// ===========================================================================
// 结清有两条路：
//   ① 钱真的收齐了（**自动判据**，见 `lib/dealer-statement.js` 的 assertSettled）；
//   ② 业务判断手动结清（`force`，例如坏账核销、或以返利/预收抵扣后仍有尾差）。
// ② 是**越权**动作：它让一张"账上还挂着钱"的对账单变成已结清。
// 所以它必须留理由，且理由要落在**单据上**（`close_reason`）而不只是事件流的 remark——
// 后者会随事件流滚动，前者是被结清的那张单**永久带着**的说明。
// 字段名刻意与 `void_reason` 对称：两个终局动作都要能回答"为什么"。
//
// ===========================================================================
// 四、为什么只补 `dealer_statements`，不给 `oc_statements` 补列
// ===========================================================================
// `oc_statements`（订货对账单）在内核里**已经有** `draft/confirmed/closed/voided`
// 四个状态与 `close` / `void` 两条边（见 `008_doc_kernel.cjs` 的 STATES.OCS / ACTIONS.OCS），
// 它的缺口是**业务入口实现**（`lib/order-center.js` 目前只有
// buildStatement / getStatement / settleStatement / confirmStatement），
// **不是表结构**——补列对它没有任何意义，它的 `status` 列本来就在。
// 这一条写在这里，是为了让下一个读到"对账单动作"的人知道：另一个对账单载体
// **还没做**（状态机已备、入口待补），而不是"漏了"。

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '对账单终局动作：结清 / 作废（dealer_statements 终局列）'

// 对账单载体。用常量而不是散落的字面量：将来若要给别的对账单表补同样的列，
// 改这里一处即可（up / verify 天然一致，不会出现"加了列但自检没查"）。
const STATEMENT_TABLE = 'dealer_statements'

// 终局列清单。顺序即"读单据时的列顺序"，与动作分组对应（先 close 后 void）。
const COLUMNS = [
  ['closed_at', 'TEXT'],
  ['closed_by', 'INTEGER'],
  ['closed_by_name', 'TEXT'],
  ['close_reason', 'TEXT'], // 越权结清（force）或自动结清的说明；自动结清可为 NULL
  ['voided_at', 'TEXT'],
  ['voided_by', 'INTEGER'],
  ['voided_by_name', 'TEXT'],
  ['void_reason', 'TEXT'] // 作废理由（服务端强制非空，见 lib/dealer-statement.js）
]

// 定义指纹的数据形状：**只登记列名**，不登记 decl。
// 理由：decl 变化（如 TEXT→INTEGER）在 SQLite 里 ADD COLUMN 是做不到的，
// 登记它只会让指纹在"改了一个改不动的字面量"时恒假、每次启动白跑一次自愈。
const DEF = { table: STATEMENT_TABLE, columns: COLUMNS.map(([c]) => c) }

module.exports.up = function up(db) {
  // 表不存在时**必须报错**，不能静默跳过：跳过会让本迁移被记为已执行、
  // 而结构其实没变，直到运行时才炸（food 库的真实事故，见 _helpers.cjs 注释）。
  if (!tableExists(db, STATEMENT_TABLE)) {
    throw new Error(`${STATEMENT_TABLE} 不存在，迁移顺序有误（应先执行基础建表 schema.sql）`)
  }
  // addColumn 自带幂等（缺列才加），所以整库重建后重跑本迁移能收敛。
  let added = 0
  for (const [col, decl] of COLUMNS) if (addColumn(db, STATEMENT_TABLE, col, decl)) added++
  stampDef(db, '043_statement_actions', DEF)
  return { columns: COLUMNS.length, added }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, STATEMENT_TABLE)) return false
  // 列缺失 → 重跑 up()。整库重建会把表按 schema.sql 重造回"无终局列"的状态，
  // 只查表存在会误判为已迁移，新增列凭空消失。
  for (const [col] of COLUMNS) if (!hasColumn(db, STATEMENT_TABLE, col)) return false
  // 定义指纹：列清单改了也能被发现。新增列却忘了写进 COLUMNS 时这里恒假，
  // 下次启动就会重跑 up() 补齐——这正是要的（而不是让列永远缺席）。
  if (defStale(db, '043_statement_actions', DEF)) return false
  return true
}
