/**
 * ============================================================================
 * 文件标识：server/lib/audit-fts-state.js ｜ 审计 FTS 分批重建的检查点表：名字、结构、"重建中"判据（roadmap-v13 AH4，ADR-0054 补充 4）
 * ============================================================================
 * 【职责】`scripts/audit-fts-maintain.mjs --rebuild` 分批重建 `audit_logs_fts`：先清空索引、再按 id 升序每批一个写事务回填。批与批之间索引是**残缺**的，
 *   所以重建期间在库里留一张单行检查点表 `audit_fts_rebuild_state`（最后一批提交时与该批同一事务删除）：
 *   · 它记录续跑所需的一切（行业、指纹、高水位 id、已处理到的 id、剩余行数、批大小、起止时间）；
 *   · 它的存在本身就是"索引未完成"的标记：`audit-view.js` 的 `ftsAvailable()` 见到它就不走 FTS（回退 LIKE，结果相同），不会拿残缺索引回答检索。
 *   表由维护脚本在重建的第一个事务里建，不是迁移（它是瞬态运维状态，不属于 schema；ADR-0054 补充 4）。
 * 【改它要注意什么】表名被 `audit-view.js`（查询路径）与维护脚本共用；改名要同步两处与文档。
 * ============================================================================
 */
export const REBUILD_STATE_TABLE = 'audit_fts_rebuild_state'

export const REBUILD_STATE_DDL = `CREATE TABLE ${REBUILD_STATE_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  industry TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  high_water INTEGER NOT NULL,
  last_id INTEGER NOT NULL,
  total_rows INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  batch_rows INTEGER NOT NULL,
  batches INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

/** 库里有没有未完成的分批重建（检查点表在） */
export function rebuildInProgress(db) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(REBUILD_STATE_TABLE) } catch { return false }
}

/**
 * 受控删改必须在同一写事务内、任何改动/导出之前检查。写锁保证检查点不会在检查与写入之间出现；
 * DEFERRED 旧快照升级失败时也必须回滚。与查询的探测不同，状态读取失败不能当作“不在重建”。
 * 空检查点表同样拒绝；中断后先 --resume / --rebuild --restart，或 --disable 收敛状态。
 */
export function assertAuditMutationAllowed(db) {
  if (!db.inTransaction) throw Object.assign(new Error('审计删改检查必须在事务内'), { code: 'AUDIT_OUTSIDE_TX', status: 500 })
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(REBUILD_STATE_TABLE)) {
    throw Object.assign(new Error('审计 FTS 分批重建未完成，暂不能清理、归档或抹除审计行；先 --resume、--rebuild --restart 或 --disable 完成维护'), { code: 'AUDIT_FTS_REBUILD_IN_PROGRESS', status: 409 })
  }
}

export default { REBUILD_STATE_TABLE, REBUILD_STATE_DDL, rebuildInProgress, assertAuditMutationAllowed }
