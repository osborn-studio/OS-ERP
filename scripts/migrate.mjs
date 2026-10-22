/**
 * ============================================================================
 * 文件标识：scripts/migrate.mjs ｜ 手动执行数据库迁移
 * ============================================================================
 * 【职责】手动执行数据库迁移
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 手动执行数据库迁移
//   node scripts/migrate.mjs            # 所有行业（先建基础结构，再跑增量迁移）
//   node scripts/migrate.mjs cosmetic   # 指定行业
//   node scripts/migrate.mjs --status   # 只看状态，不执行
import { getDbFor, initSchemaFor, INDUSTRIES } from '../server/db/index.js'
import { migrationStatus } from '../server/db/migrations/runner.js'

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const targets = args.filter((a) => !a.startsWith('--'))
const codes = targets.length ? targets : Object.keys(INDUSTRIES)

let failed = 0
for (const code of codes) {
  if (!INDUSTRIES[code]) {
    console.error(`[migrate] 未知行业：${code}，可选 ${Object.keys(INDUSTRIES).join(' / ')}`)
    failed++
    continue
  }
  console.log(`\n[${code}] ${INDUSTRIES[code].label}`)
  try {
    // initSchemaFor = 基础建表(schema.sql，全部 IF NOT EXISTS) + 增量迁移
    // 新行业库第一次迁移时必须先建基础表，否则增量迁移会因缺表失败
    const db = statusOnly
      ? getDbFor(code)
      : initSchemaFor(code, { log: (m) => console.log('  ' + m) })
    const st = migrationStatus(db)
    console.log(
      `  → 已执行 ${st.applied.length} 个 / 待执行 ${st.pending.length} 个` +
        (st.pending.length ? ` → ${st.pending.join(', ')}` : '')
    )
  } catch (e) {
    console.error(`  ✗ 失败：${e.message}`)
    failed++
  }
}
if (failed) {
  console.error(`\n[migrate] 有 ${failed} 个库失败`)
  process.exitCode = 1
}
