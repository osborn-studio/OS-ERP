'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/072_audit_anchor_intents.cjs ｜ 审计锚点操作意图表（roadmap-v10 AE5，ADR-0055 补充）
 * ============================================================================
 * 【职责】建 `audit_anchor_intents`：保留清理 / 归档 / 隐私抹除每次**新增**审计锚点时，在同一事务里留一条“我为什么新增这些锚点”的意图行。
 *   `audit-verify-chain --offbox` 据此把“合法操作产生的锚点”与“伪造的桥锚点”分开（ADR-0055 补充）。
 *   · operation ∈ retention | archive | erase（CHECK）；range_desc = 操作范围的文字描述；operator_user_id / operator_name = 操作者。
 *   · anchors_json = 本次新增锚点的规范化列表 [[kind, at_row_id, anchor_hash, prev_id, prev_row_hash], …]；
 *     intent_hash = sha256(规范化(格式标识, operation, range_desc, 操作者, created_at, anchors))，规范化只有一份实现：`server/lib/audit-anchor-intent.js`。
 *   · key_id / signature：配置了 `GML_ANCHOR_INTENT_KEY`（或 `GML_RELEASE_SIGN_KEY`）时对 intent_hash 的 Ed25519 签名，可空。
 *   · audit_row_id：印证这条意图的操作审计行（RETENTION_PURGE / AUDIT_ARCHIVE / PRIVACY_ERASE）的 id，不进哈希（审计行的明细里带意图 id 与哈希，双向互指）。
 *   不对 audit_logs 建外键（归档会把旧审计行搬出库），也不在 audit_logs 上建索引。
 * 【幂等与自愈】up 缺表才建、缺列才补（列都带默认值，可 ALTER ADD）；`verify()` = 表在且全部列在。已有的旧锚点没有意图行——这是设计：
 *   校验只要求**离机锚点之后**在已锚定范围内新增的锚点有意图。
 * 【改它要注意什么】已执行迁移不改（ADR-0009）；意图哈希的格式改动 = 新格式标识 + 新迁移。
 * ============================================================================
 */
const { tableExists, hasColumn, addColumn } = require('./_helpers.cjs')

module.exports.name = '审计锚点操作意图表（audit_anchor_intents）'

const COLUMNS = [
  ['created_at', "TEXT NOT NULL DEFAULT (datetime('now','localtime'))"],
  ['operation', "TEXT NOT NULL DEFAULT 'retention'"],
  ['range_desc', "TEXT NOT NULL DEFAULT ''"],
  ['operator_user_id', 'INTEGER'],
  ['operator_name', "TEXT NOT NULL DEFAULT ''"],
  ['anchors_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['intent_hash', "TEXT NOT NULL DEFAULT ''"],
  ['key_id', 'TEXT'],
  ['signature', 'TEXT'],
  ['audit_row_id', 'INTEGER']
]

module.exports.up = (db) => {
  if (!tableExists(db, 'audit_logs')) return
  db.exec(`CREATE TABLE IF NOT EXISTS audit_anchor_intents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    operation        TEXT NOT NULL CHECK (operation IN ('retention','archive','erase')),
    range_desc       TEXT NOT NULL,
    operator_user_id INTEGER,
    operator_name    TEXT NOT NULL,
    anchors_json     TEXT NOT NULL,
    intent_hash      TEXT NOT NULL,
    key_id           TEXT,
    signature        TEXT,
    audit_row_id     INTEGER
  )`)
  for (const [col, decl] of COLUMNS) addColumn(db, 'audit_anchor_intents', col, decl)
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'audit_logs')) return true
  return COLUMNS.every(([col]) => hasColumn(db, 'audit_anchor_intents', col))
}
