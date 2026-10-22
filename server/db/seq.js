/**
 * ============================================================================
 * 文件标识：server/db/seq.js ｜ 自增序列重置（seed 专用工具）。
 * ============================================================================
 * 【职责】自增序列重置（seed 专用工具）。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 自增序列重置（seed 专用工具）。
//
// 背景：SQLite 的 `sqlite_sequence` 只在 **DROP TABLE** 时自动清掉；对表做 `DELETE FROM`
// 只会删行，**序列继续往下走**。
//
// 于是同一个库重建两次，同一张表的自增 id 是 `101..200` 与 `201..300` —— 表面上不影响
// 任何业务数字，但 id 会被复制进别的表（`ar_documents.subject_id`、`doc_events.doc_id`、
// `purchase_order_items.remark = "请购行 #15973"` …），整库从此**逐表都不可复现**：
// 「同一份 seed 重建出的库应当逐字节一样」这句话就不成立了，按具体单据写断言的测试
// 也随之随机失败（批次 C 收尾的真实排查过程）。
//
// 用法：卫星 seed 在自己的 `DELETE FROM ...` 清表之后调用一次：
//   resetSequences(db, ['oc_orders', 'oc_order_items', ...])
// 主 seed（seed.js）不需要 —— 它的表是 DROP 掉的，序列随之消失。
export function resetSequences(db, tables) {
  let stmt
  try {
    // 库里一张 AUTOINCREMENT 表都没有时，sqlite_sequence 这个内部表根本不存在
    stmt = db.prepare('DELETE FROM sqlite_sequence WHERE name = ?')
  } catch {
    return 0
  }
  let n = 0
  for (const t of tables) {
    try {
      n += stmt.run(t).changes
    } catch {
      /* 非 AUTOINCREMENT 表（或表尚未建）没有序列行，跳过 */
    }
  }
  return n
}

export default { resetSequences }
