/**
 * ============================================================================
 * 文件标识：tests/audit-bench.test.mjs ｜ AA6 审计日志基准脚本的小规模自检（scripts/bench-audit-logs.mjs）
 * 只在系统临时目录建库（脚本自己建、自己删），不监听端口。百万行实测见 docs/implementation/capacity-baseline.md。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../scripts/bench-audit-logs.mjs'

test('AA6 bench script: seeds through insertAuditRow, plans flip from rowid scans to the 065 indexes, export is capped', { timeout: 120000 }, async () => {
  const log = console.log
  console.log = () => {}
  let r
  try { r = await main(['--rows', '6000', '--export', '1500', '--repeat', '1', '--writes', '300']) } finally { console.log = log }
  assert.equal(r.rows, 6000)
  const by = (arr, name) => arr.find(x => x.case === name)
  const mod = (arr) => by(arr, 'common module')
  assert.match(mod(r.before).list_plan.join(' '), /SCAN audit_logs|USE TEMP B-TREE|PRIMARY KEY/, 'before: no index to search')
  assert.doesNotMatch(mod(r.before).list_plan.join(' '), /idx_audit/)
  assert.match(mod(r.after).list_plan.join(' '), /idx_audit_module_created/)
  assert.match(by(r.after, 'rare user_id').list_plan.join(' '), /idx_audit_user_created/)
  assert.match(by(r.after, 'entity + entity_id').list_plan.join(' '), /idx_audit_entity/)
  assert.match(by(r.after, 'rare module').count_plan.join(' '), /COVERING INDEX idx_audit_module_created/)
  const all = by(r.after, 'no filter')
  assert.equal(all.export_rows, 1500, 'export stops at the requested cap')
  assert.equal(all.count_value, 6600, 'below the cap the count is exact (6000 seeded + 2 x 300 write probes)')
  for (const row of r.after) assert.ok(row.export_rows <= 1500)
  assert.ok(r.index_build_ms >= 0 && r.write_ms_per_1k_before > 0 && r.write_ms_per_1k_after > 0)
  // AB3：067（FTS5）与 created_at 单列索引的量化
  const ab3 = r.ab3
  assert.ok(ab3.fts_build_ms >= 0)
  assert.deepEqual(Object.keys(ab3.write_amplification.configs), ['065', '065+067(fts)', '065+created_at'])
  for (const c of Object.values(ab3.write_amplification.configs)) assert.ok(c.min_us_per_row > 0 && c.median_us_per_row >= c.min_us_per_row)
  for (const c of ab3.keyword_like) assert.doesNotMatch(c.list_plan.join(' '), /audit_logs_fts/, `${c.case} uses LIKE`)
  for (const c of ab3.keyword_fts) {
    // 与路由同一选择：稀少命中走 FTS、命中很多回退 LIKE
    if (c.mode === 'fts') assert.match(c.list_plan.join(' '), /audit_logs_fts VIRTUAL TABLE INDEX/, `${c.case} uses FTS`)
    else assert.doesNotMatch(c.list_plan.join(' '), /audit_logs_fts/, `${c.case} fell back to LIKE`)
  }
  assert.equal(ab3.keyword_fts.find(c => c.case.startsWith('keyword absent')).mode, 'fts')
  const hits = (arr, name) => arr.find(c => c.case.startsWith(name))
  assert.equal(hits(ab3.keyword_fts, 'keyword rare').count_value, hits(ab3.keyword_like, 'keyword rare').count_value, 'FTS and LIKE agree on the count')
  assert.equal(hits(ab3.keyword_fts, 'keyword absent').count_value, 0)
  assert.match(ab3.created_at_index.date_only_with[0].list_plan.join(' '), /idx_audit_created_probe/)
  assert.doesNotMatch(ab3.created_at_index.date_only_without[0].list_plan.join(' '), /idx_audit_created_probe/)
})
