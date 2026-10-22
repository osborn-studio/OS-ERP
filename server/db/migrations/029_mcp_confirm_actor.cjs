'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/029_mcp_confirm_actor.cjs ｜ 迁移：MCP 确认单签字人（D5：确认人 = 审批签字人）
 * ============================================================================
 * 【职责】迁移：MCP 确认单签字人（D5：确认人 = 审批签字人）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 029 MCP 确认单的签字人（D5）
//
// 背景：`approval.approve` 是一个 danger 工具，描述写的是"**等同于代表人签字**"。
// 但它原来执行的是裸 `UPDATE approval_instances SET status='approved', finished_at=…` ——
// ① `finished_at` 这一列根本不存在（只有 `decided_at`），干净库上必然报错；
// ② 它绕开了状态机：不写 `approval_records`、不判"这一级该不该你批"、不进级、
//    **审批通过后也不执行对应的业务流转** —— 单据"批了"但什么都没发生。
//
// 正确修法是改调 `lib/approval.js` 的 `decideApproval()`。而它要求
// `actor.id` 是一个**真实用户**（`canApproveStep` 拿它去查 users 表）。
// 于是必须先回答一个设计问题：
//
//   **Agent 凭什么代替人签字？**
//
// 答案：**它不代替，它转呈。** MCP 的 danger 工具本来就必须经人工二次确认 ——
// 那就把"点确认的那个人"作为签字人。原来确认单只存了 `confirmed_by`（名字字符串），
// 名字不能用来查权限、也不能落 `approval_records.approver_id`。
// 所以这一列补的不是"多存一个字段"，而是**让"谁签的字"在数据上成立**。
//
// 与"禁止自批"（第 1 批）是同一件事的两面：那一条保证"确认人不是申请人"，
// 这一条保证"审批的签字人就是确认人"。

const { tableExists, hasColumn, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = 'MCP 确认单签字人（D5：确认人 = 审批签字人）'

const COLUMNS = [['mcp_confirmations', 'confirmed_by_id', 'INTEGER']]

module.exports.up = function up(db) {
  if (!tableExists(db, 'mcp_confirmations')) {
    throw new Error('mcp_confirmations 不存在，迁移顺序有误（应先执行 006_mcp）')
  }
  for (const [t, c, decl] of COLUMNS) addColumn(db, t, c, decl)
  const def = { columns: COLUMNS }
  stampDef(db, '029_mcp_confirm_actor', def)
  return { columns: COLUMNS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'mcp_confirmations')) return false
  for (const [t, c] of COLUMNS) if (!hasColumn(db, t, c)) return false
  if (defStale(db, '029_mcp_confirm_actor', { columns: COLUMNS })) return false
  return true
}
