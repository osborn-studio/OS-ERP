'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/047_inv_txn_types_master.cjs ｜ 迁移：出入库单据类型主数据化：saleable_only / ledger_subject_code
 * ============================================================================
 * 【职责】迁移：出入库单据类型主数据化：saleable_only / ledger_subject_code
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 047 出入库单据类型升级为「客户可维护的主数据」
//
// 客户口径（原话）：
//   「能不能卖由客户来决定，一般都是做一种类型的出库，然后这种出库对于一种类型的财务核算，
//     所以你也一定要地方设供应链参数，比如出入库单据类型有哪些，是不是允许负库存，能以哪些
//     仓库。简单来讲，仓库是可以客户自己新建的，出入库单据类型也是客户新建的，以应对多种情况。」
//
// 这句话落成两列（都在 `inv_txn_types` 上，因为"类型"本来就已经是这张表的行）：
//
//   ① `saleable_only` —— **这条类型是否受「可售性闸门」约束**。
//      在此之前这份名单是 `server/lib/stock.js` 里的一行硬编码
//      （`SALEABLE_ONLY_OUT = new Set(['SAL_OUT','SHP_OUT','MR','WWS_OUT'])`）。
//      改成一列之后，客户可以自己决定"哪种出库要把货当可售货消耗"，闸门与文案都跟着它走。
//
//      ⚠️ **回填必须逐条等于改列之前的行为**：改列之前受约束的是那 4 个码，
//      因此只有它们回填 1，其余一律 0。少回填一个 = **静默开漏**（那个出库不再被拦），
//      多回填一个 = **静默拦死**（本来能走的出库被拦住）。两侧都是不会报错的失败，
//      所以这里把名单写成常量，并让 `scripts/check-inv-txn-dict.mjs` 与
//      `stock.js` 的回落默认值共用同一份口径（见下）。
//
//   ② `ledger_subject_code` —— **这条类型的财务核算口径**（科目编码，可空）。
//      引用既有科目主数据 `accounting_subjects.code`（**不新造第二套科目**）。
//      为什么落成"科目"而不是"凭证场景"：本项目的凭证生成器 `lib/accounting.js`
//      是按**来源单据**驱动的（`BIZ_TYPES` 的 6 个场景，`source_type` 分别指向
//      `purchase_receipts` / `sales_deliveries` / `receipts` / `purchase_payments` / `refunds`），
//      **没有任何"按库存流水生成凭证"的入口** —— 把库存异动硬接进去要新造一条触发链，
//      那是另一个决定（见交付报告的"未做"栏）。所以这里只落**最细、可空、可校验**的那一格：
//      "这种出库，核算上归到哪个科目"。空值 = 未指定 = 沿用现状（不产生任何行为变化）。
//
//      ⚠️ **为什么本轮明确"不接进凭证生成"（这是硬伤级的理由，不是没时间做）**：
//      现有凭证是**由"来源单据"驱动**的（`BIZ_TYPES` 六个场景的 `source_type` 全是单据表）。
//      再挂一条"库存异动 → 凭证"的触发链，**同一笔业务会被记两遍账** ——
//      发货单生成一次、库存流水又生成一次。而**重复记账比漏记更危险**：
//      漏记能查出来（借贷不平、或单据找不到对应凭证）；
//      **重复记账会让两套报表各自自洽地错**，两边都能对上，谁也发现不了。
//      ⇒ 要接必须先定"**谁负责记这笔、另一侧不记**"（例如：凭证一律由来源单据驱动，
//      本列只作为"取科目时的口径"参与单据驱动的分录）。那是**另一个决定**，不是补一行。
//      客户要的粒度是"**一套凭证模板**"（第 0 层 §7.2），模板实体（`voucher_templates` +
//      `voucher_template_entries`）已存在可复用 —— 但同样卡在上面那条"触发链"上。
//
//      ⇒ **本列当前是 `[未接线 · 依赖"出库类型 → 凭证模板"映射落地]`**
//      （team-lead **最终裁定**，2026-10-16，方案 A）：**列保留、界面只读并明示、
//      接口拒写（`INV_TYPE_LEDGER_RESERVED`）、不参与任何逻辑**。
//      为什么选 A 而不是"保留可填 + 明示"（B）：**A 严格包含 B 的全部优点**（明示没丢），
//      并**多消掉一条"写了没效果"的写路径** —— 与铁律 17（「无意义的动作」必须由闸门
//      明确拒绝 + 一句人话）一致；同时少一份死代码。
//      ⚠️ 死列/占位列必须**明确标注**，不能靠人猜（对照本项目旧账 `qty_in_transit`）。
//      等"出库类型 → 凭证模板"落地时，它（或它的后继列）改为**指向模板**。
//
// 不加 CHECK 约束（与全库口径一致：schema.sql 从不写 CHECK），取值域由三处共同守住：
//   写入接口只认 0/1（`routes/inv-txn-types.js`）、本迁移的 up() 归一路、verify() 的断言。

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '出入库单据类型主数据化：saleable_only / ledger_subject_code'

// 加列：默认 0 / NULL ⇒ 对存量行"零行为变化"，再由下面的回填把**改列之前的闸门名单**装回去。
const NEW_COLUMNS = [
  ['inv_txn_types', 'saleable_only', 'INTEGER NOT NULL DEFAULT 0'],
  // ⚠️ 预留列（team-lead 裁定）：**当前不参与任何逻辑，界面也不暴露**。
  //    将来改为指向"出库类型 → 凭证模板"的映射（见文件头与 §7.2）。
  ['inv_txn_types', 'ledger_subject_code', 'TEXT']
]

// **改列之前**受「可售性闸门」约束的码（= 当时 `stock.js` 的 SALEABLE_ONLY_OUT 逐字）
// 这份名单的用途只有两个：① 新加列时回填；② 非法值归位时的方向。
// 客户之后自行改动这一列不受影响（见 up() 的 `newlyAdded` 判断）。
const BACKFILL_SALEABLE_ONLY = ['SAL_OUT', 'SHP_OUT', 'MR', 'WWS_OUT']

module.exports.up = function up(db) {
  const newlyAdded = []
  for (const [t, c, decl] of NEW_COLUMNS) {
    if (addColumn(db, t, c, decl)) newlyAdded.push(`${t}.${c}`)
  }

  let backfilled = 0
  // 只在**本次刚加上列**时回填。列已存在时绝不动它 ——
  // 否则"客户把 SAL_OUT 改成不受约束"会在下一次启动（或一次 heal 重跑）里被悄悄改回去。
  if (newlyAdded.includes('inv_txn_types.saleable_only')) {
    const ins = db.prepare('UPDATE inv_txn_types SET saleable_only=? WHERE code=?')
    for (const code of BACKFILL_SALEABLE_ONLY) backfilled += ins.run(1, code).changes
  }

  // 取值域归一到 0/1。脏值只可能来自直写库（接口写入已被强制 0/1）。
  // 归位方向**按本迁移的历史口径**、而不是一律 0：一律 0 会让"某个本该受约束的类型"
  // 静默失去闸门 —— 那是开漏。这条判断让 verify() 有"可被 up() 修好"的收敛路径。
  const dirty = db
    .prepare('SELECT code FROM inv_txn_types WHERE saleable_only IS NULL OR saleable_only NOT IN (0,1)')
    .all()
  const fix = db.prepare('UPDATE inv_txn_types SET saleable_only=? WHERE code=?')
  let normalized = 0
  for (const r of dirty) {
    fix.run(BACKFILL_SALEABLE_ONLY.includes(r.code) ? 1 : 0, r.code)
    normalized += 1
  }

  stampDef(db, '047_inv_txn_types_master', {
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    backfill: BACKFILL_SALEABLE_ONLY
  })
  return { newlyAdded, backfilled, normalized }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'inv_txn_types')) return false
  for (const [t, c] of NEW_COLUMNS) if (!hasColumn(db, t, c)) return false
  // 取值域：saleable_only 只允许 0/1（理由同 042：脏值不会报错，只会让"要不要拦"没有确定答案）
  const bad = db
    .prepare('SELECT COUNT(*) c FROM inv_txn_types WHERE saleable_only IS NULL OR saleable_only NOT IN (0,1)')
    .get().c
  if (bad > 0) return false
  if (
    defStale(db, '047_inv_txn_types_master', {
      columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
      backfill: BACKFILL_SALEABLE_ONLY
    })
  ) {
    return false
  }
  return true
}
