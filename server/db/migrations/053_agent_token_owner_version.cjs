'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/053_agent_token_owner_version.cjs ｜ Agent Token 记下签发时所有者的 auth_version，所有者撤权即令牌失效
 * ============================================================================
 * 【为什么】ADR-0011：Agent Token 是所有者的**委托**。所有者改密 / 停用 / 换角色 / 换组织 /
 *   角色权限集变化时 `users.auth_version` 递增（ADR-0004），签发于递增**之前**的令牌必须失效。
 *   存量有主令牌回填为所有者**当前**版本（它们在下一次撤权事件前照常可用）；
 *   无主令牌保持 NULL（无所有者可对照）。重跑不重置已回填的值。
 * ============================================================================
 */
const { addColumn, hasColumn } = require('./_helpers.cjs')
module.exports.name = 'Agent Token 记录签发时所有者的会话版本'
module.exports.up = (db) => {
  addColumn(db, 'agent_tokens', 'owner_auth_version', 'INTEGER')
  db.prepare(`UPDATE agent_tokens SET owner_auth_version = (SELECT auth_version FROM users WHERE users.id = agent_tokens.owner_user_id)
    WHERE owner_user_id IS NOT NULL AND owner_auth_version IS NULL`).run()
}
module.exports.verify = (db) => hasColumn(db, 'agent_tokens', 'owner_auth_version')
