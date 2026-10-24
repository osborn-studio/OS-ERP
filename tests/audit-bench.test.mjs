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
})
