'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/065_audit_log_indexes.cjs ｜ 审计日志检索索引（roadmap-v6 AA6）
 * ============================================================================
 * 【职责】Z7 的审计日志查看器与 CSV 导出按 module / user_id / entity+entity_id 过滤，而 `audit_logs` 自建表起没有任何二级索引：
 *   带过滤的列表、COUNT、导出都是整表扫描。本迁移补三棵非 UNIQUE 索引；依据与前后 EXPLAIN / 计时见
 *   docs/implementation/capacity-baseline.md 的 AA6 一节，语句镜像在 scripts/explain-audit.mjs（audit.list_* / audit.export_*）。
 *
 * 【索引】
 *   · idx_audit_module_created  audit_logs(module, created_at)：module = ? [AND created_at 区间]；模块 + 日期是最常见的复核口径。
 *   · idx_audit_user_created    audit_logs(user_id, created_at)：user_id = ? [AND created_at 区间]（"某人某段时间做了什么"）。
 *   · idx_audit_entity          audit_logs(entity, entity_id)：entity = ? [AND entity_id = ?]（"这张单据的全部留痕"）。
 *
 * 【写放大（诚实边界）】audit_logs 是几乎每次业务写入都会追加一行的表，三棵索引让每次追加多维护三棵 B 树；
 *   审计行很窄（索引项 = 两列 + rowid），实测见 capacity-baseline。已执行迁移不改（ADR-0009）。
 * 【迁移安全】只加非 UNIQUE 索引、IF NOT EXISTS、表或列缺失则跳过。大库上 CREATE INDEX 持写锁，耗时见 capacity-baseline。
 * 【改它要注意什么】INDEXES 是 up 与 verify 的唯一来源；改动后同步 scripts/explain-audit.mjs 并保持 tests/audit-logs-view.test.mjs 绿。
 * ============================================================================
 */
const { tableExists, hasColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '审计日志检索索引（module/user/entity）'

const INDEXES = [
  { name: 'idx_audit_module_created', table: 'audit_logs', cols: 'module, created_at', needs: ['module', 'created_at'], serves: 'audit.list_module audit.export_module' },
  { name: 'idx_audit_user_created',   table: 'audit_logs', cols: 'user_id, created_at', needs: ['user_id', 'created_at'], serves: 'audit.list_user audit.export_user' },
  { name: 'idx_audit_entity',         table: 'audit_logs', cols: 'entity, entity_id',   needs: ['entity', 'entity_id'],   serves: 'audit.list_entity audit.export_entity' }
]
module.exports.INDEXES = INDEXES

const applicable = (db, ix) => tableExists(db, ix.table) && ix.needs.every((c) => hasColumn(db, ix.table, c))

module.exports.up = (db) => {
  for (const ix of INDEXES) {
    if (!applicable(db, ix)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.cols})`)
  }
}

module.exports.verify = (db) => INDEXES.every((ix) => !applicable(db, ix) || hasIndex(db, ix.name))
