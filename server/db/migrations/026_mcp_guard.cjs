'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/026_mcp_guard.cjs ｜ 迁移：MCP 安全闸加固（确认单绑定 + 幂等载荷指纹 + 确认权限点）
 * ============================================================================
 * 【职责】迁移：MCP 安全闸加固（确认单绑定 + 幂等载荷指纹 + 确认权限点）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 026 MCP 安全闸加固（确认单三元组绑定 / 幂等键带载荷指纹 / 高危确认权限点）
//
// 背景（验收复核实测出来的五条硬伤，本条迁移只补数据层缺的那部分）：
//   4a viewer 身份就能批准高危确认       —— 确认接口无权限门
//   4b A 令牌申请（price 111）→ B 令牌改参（price 999）后照样执行
//      —— 确认单只绑了 tool_name，**没绑参数、没绑令牌**
//   4c 用 x-confirm-token 头执行后确认单仍是 confirmed，可无限重放
//      —— 置 used 用的是 args.confirm_token（走 header 时是 undefined）
//   4d resources/read 完全不走工具白黑名单  —— 数据层无关，代码层修
//   4e 另一令牌 + 不同载荷复用旧幂等键会命中旧结果
//      —— `mcp_idempotency` 只有 idempotency_key 一个主键，**没有载荷指纹列**
//
// 为什么必须加列而不是"在代码里想办法"：
//   ★ 4e 的本质是「同 key 不同载荷必须能被识别为冲突」。识别冲突需要拿到
//     "首次执行时的载荷长什么样"。这张表里原本只有 key 与结果，**没有可比较的对象**，
//     所以无论代码怎么写都判不出来。指纹必须落库，这是数据层的缺口。
//   ★ used_at / used_by 同理：确认单被谁在什么时候用掉的，原来无处可记，
//     而"能回答谁批的、依据什么状态、留了什么痕"正是高危操作的最低要求。
//
// 为什么单独一个迁移而不是改 006：
//   006 已在三库执行并记入 schema_migrations；改已执行迁移的 DDL 不会重跑。
//   追加列必须走新迁移（与 012 补 paid_at 同理）。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = 'MCP 安全闸加固（确认单绑定 + 幂等载荷指纹 + 确认权限点）'

// 高危确认的独立权限点。
// 为什么不复用 system.mcp.manage：那是"签发令牌"的管理权，与"放行一次高危动作"
// 是两件事 —— 前者是运维动作，后者是业务审批。混用一个权限点，等于把
// "能建令牌的人"和"能批准付款/调价的人"绑成同一批人，而且**viewer 一旦被授予其一就两者皆得**。
const CONFIRM_PERM = 'system.mcp.confirm'
const CONFIRM_PERM_ROW = [CONFIRM_PERM, '确认 MCP 高危操作', 'system', 'action', 1310]
// 授予范围：内部角色里的管理员与各业务主管。**刻意不给 dealer / store / viewer** ——
// 外部主体与只读访客都不应是"放行高危动作"的人。
const CONFIRM_ROLES = ['admin', 'boss', 'purchase', 'sales', 'warehouse', 'finance']

const COLUMNS = [
  ['mcp_idempotency', 'args_hash', 'TEXT'],
  ['mcp_confirmations', 'used_at', 'TEXT'],
  ['mcp_confirmations', 'used_by', 'TEXT']
]

const INDEXES = [
  // 幂等查询由「仅 key」变为「key + 令牌 + 工具 + 载荷指纹」，补一个组合索引
  `CREATE INDEX IF NOT EXISTS idx_mcp_idem_key_token ON mcp_idempotency (idempotency_key, token_id)`
]

module.exports.up = function up(db) {
  if (!tableExists(db, 'mcp_idempotency') || !tableExists(db, 'mcp_confirmations')) {
    throw new Error('MCP 表不存在，迁移顺序有误：026 必须在 006 之后执行')
  }
  for (const [t, c, d] of COLUMNS) addColumn(db, t, c, d)
  for (const sql of INDEXES) db.exec(sql)

  // 权限点与授予：全部 INSERT OR IGNORE，up 幂等
  db.prepare('INSERT OR IGNORE INTO permissions (code, name, module, category, sort_order) VALUES (?,?,?,?,?)').run(
    ...CONFIRM_PERM_ROW
  )
  const insRP = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const role of CONFIRM_ROLES) insRP.run(role, CONFIRM_PERM)

  const def = { columns: COLUMNS, indexes: INDEXES, perm: CONFIRM_PERM_ROW, roles: CONFIRM_ROLES }
  stampDef(db, '026_mcp_guard', def)
  return { columns: COLUMNS.length, indexes: INDEXES.length, roles: CONFIRM_ROLES.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'mcp_idempotency') || !tableExists(db, 'mcp_confirmations')) return false
  for (const [t, c] of COLUMNS) if (!hasColumn(db, t, c)) return false
  for (const sql of INDEXES) {
    const m = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)
    if (m && !hasIndex(db, m[1])) return false
  }
  const perm = db.prepare('SELECT 1 FROM permissions WHERE code=?').get(CONFIRM_PERM)
  if (!perm) return false
  // Role assignments are administrator policy, not missing schema. Counting
  // default grants here would restore intentionally revoked permissions on restart.
  if (!tableExists(db, 'role_permissions')) return false
  const def = { columns: COLUMNS, indexes: INDEXES, perm: CONFIRM_PERM_ROW, roles: CONFIRM_ROLES }
  if (defStale(db, '026_mcp_guard', def)) return false
  return true
}
