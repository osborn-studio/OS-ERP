'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/006_mcp.cjs ｜ 迁移：MCP 能力层（Agent Token / 调用日志 / 幂等键 / 高危二次确认）
 * ============================================================================
 * 【职责】迁移：MCP 能力层（Agent Token / 调用日志 / 幂等键 / 高危二次确认）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 006 MCP 能力层数据表
//
// 依据：第二轮第 0 条「系统从一开始就原生提供 MCP，取代通过外挂方式接 AI 的传统 ERP」
//
// 设计要点（对应第三轮 A 组口径）：
//   A1 开放程度分三级：read 查询全开 / write 事务类（强制幂等键）/ danger 高危（人工二次确认）
//   A2 鉴权：独立 Agent Token（绑主体 + 权限范围 + 有效期，可吊销），与人的 JWT 分离
//   A3 会话绑定单一主体（org_id），跨主体需签多个 Token
//
// 为什么 Token 单独建表而不复用 users：
//   Agent 不是人。它有独立的生命周期（可吊销、可限速、可设有效期），
//   而且必须能独立审计「哪一次 AI 调用改了什么」，混在用户表里做不到。

const { addColumn } = require('./_helpers.cjs')

module.exports.name = 'MCP 能力层（Agent Token / 调用日志 / 幂等键 / 高危二次确认）'
module.exports.up = function up(db) {
  db.exec(`
    -- Agent 接入凭据：绑定主体与权限范围
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,      -- 只存哈希，明文仅在签发时返回一次
      token_prefix  TEXT,                      -- 前 8 位，便于在界面上辨认是哪个 Token
      owner_user_id INTEGER REFERENCES users(id),
      org_id        INTEGER REFERENCES orgs(id),   -- 绑定主体（A3 会话绑单一主体）
      industry      TEXT,
      scopes        TEXT NOT NULL DEFAULT 'read',  -- read / write / danger，逗号分隔
      allow_tools   TEXT,                      -- 工具白名单（逗号分隔，空=不限制）
      deny_tools    TEXT,                      -- 工具黑名单
      rate_limit    INTEGER NOT NULL DEFAULT 600,  -- 每小时调用上限
      expires_at    TEXT,
      last_used_at  TEXT,
      call_count    INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active', -- active / revoked
      remark        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_token_hash ON agent_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_token_org  ON agent_tokens(org_id);

    -- MCP 调用审计：每一次工具调用都留痕，AI 的动作可回溯
    CREATE TABLE IF NOT EXISTS mcp_call_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id      INTEGER,
      token_name    TEXT,
      tool_name     TEXT NOT NULL,
      level         TEXT,                      -- read / write / danger
      ok            INTEGER NOT NULL DEFAULT 1,
      error_code    TEXT,
      error_message TEXT,
      args          TEXT,
      result_summary TEXT,
      duration_ms   INTEGER,
      ip            TEXT,
      idempotency_key TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_log_tool  ON mcp_call_logs(tool_name);
    CREATE INDEX IF NOT EXISTS idx_mcp_log_time  ON mcp_call_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_mcp_log_token ON mcp_call_logs(token_id);

    -- 幂等键：事务类工具（下单/出入库/调拨）必须带，重复调用返回首次结果
    CREATE TABLE IF NOT EXISTS mcp_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      tool_name       TEXT NOT NULL,
      token_id        INTEGER,
      result_json     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 高危动作二次确认（付款/调价/作废/审批通过）
    CREATE TABLE IF NOT EXISTS mcp_confirmations (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      confirm_token      TEXT NOT NULL UNIQUE,
      tool_name          TEXT NOT NULL,
      args_json          TEXT NOT NULL,
      token_id           INTEGER,
      requested_by       TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',  -- pending / confirmed / rejected / expired / used
      reason             TEXT,
      expires_at         TEXT NOT NULL,
      confirmed_by       TEXT,
      confirmed_at       TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_confirm_status ON mcp_confirmations(status);
  `)

  // 与人的权限体系统一：Agent 也可绑角色
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_token_roles (
      token_id  INTEGER NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
      role_code TEXT NOT NULL,
      PRIMARY KEY (token_id, role_code)
    );
  `)

  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_idem_tool ON mcp_idempotency(tool_name)')
}

module.exports.verify = function verify(db) {
  const { tableExists } = require('./_helpers.cjs')
  return (
    tableExists(db, 'agent_tokens') &&
    tableExists(db, 'mcp_call_logs') &&
    tableExists(db, 'mcp_idempotency') &&
    tableExists(db, 'mcp_confirmations')
  )
}
