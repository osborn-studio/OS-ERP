'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/055_agent_token_revoke_reason.cjs ｜ Agent Token 吊销原因与时间（列表如实报告"为什么不能用了"）
 * ============================================================================
 * 【为什么】ADR-0011 让所有者改密 / 退出全部会话 / 角色权限变更只靠 `owner_auth_version` 对照使令牌失效，
 *   行状态仍是 `active` —— 管理员在列表里看到的是"活的"，调用时才报 `TOKEN_OWNER_REVOKED`。
 *   ADR-0015 给列表 / 详情加上**计算出来的** `effective_status`，并提供管理员清扫把这类令牌真正置为
 *   `revoked`。清扫与人工吊销 / 停用联动吊销都要能回答"谁、为什么、什么时候"，故补两列：
 *   `revoked_reason`（稳定码：admin / owner_inactive / owner_auth_changed …）与 `revoked_at`。
 *   存量 `revoked` 行原因未知，保持 NULL，不编造。
 * 【编号】054 预留给并行的授信冻结分支，本迁移用 055 避免撞号；运行器按文件名排序，不要求连续。
 * ============================================================================
 */
const { addColumn, hasColumn } = require('./_helpers.cjs')
module.exports.name = 'Agent Token 记录吊销原因与时间'
module.exports.up = (db) => {
  addColumn(db, 'agent_tokens', 'revoked_reason', 'TEXT')
  addColumn(db, 'agent_tokens', 'revoked_at', 'TEXT')
}
module.exports.verify = (db) => hasColumn(db, 'agent_tokens', 'revoked_reason') && hasColumn(db, 'agent_tokens', 'revoked_at')
