/**
 * ============================================================================
 * 文件标识：scripts/seed-orgs.mjs ｜ 初始化/补建组织主体（幂等，可对老库单独执行，不影响既有业务数据）
 * ============================================================================
 * 【职责】初始化/补建组织主体（幂等，可对老库单独执行，不影响既有业务数据）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 初始化/补建组织主体（幂等，可对老库单独执行，不影响既有业务数据）
//   node scripts/seed-orgs.mjs            # 所有行业
//   node scripts/seed-orgs.mjs cosmetic   # 指定行业
import { initSchemaFor, INDUSTRIES, getDbFor } from '../server/db/index.js'
import { seedOrgs } from '../server/db/org-seed.js'

import { requireDemoRuntime } from '../server/runtime.js'
requireDemoRuntime()

const args = process.argv.slice(2)
const codes = args.length ? args : Object.keys(INDUSTRIES)

for (const code of codes) {
  if (!INDUSTRIES[code]) {
    console.error(`未知行业：${code}`)
    continue
  }
  console.log(`\n[${code}] ${INDUSTRIES[code].label}`)
  const db = initSchemaFor(code, { log: (m) => console.log('  ' + m) })
  seedOrgs(db, { industry: code })

  // 结果自检
  const byType = db.prepare('SELECT type, COUNT(*) c FROM orgs GROUP BY type ORDER BY c DESC').all()
  console.log('  组织类型分布：' + byType.map((r) => `${r.type}=${r.c}`).join(' '))
  const owners = db.prepare('SELECT COUNT(*) c FROM inventory_stocks WHERE IFNULL(owner_org_id,0)=0').get().c
  console.log(`  库存行仍为默认货主(0)的：${owners} 行`)
  const sample = db.prepare(`
    SELECT s.warehouse_id, w.name AS wh, s.owner_org_id, o.name AS owner, o.type, s.currency, COUNT(*) c
    FROM inventory_stocks s
    LEFT JOIN warehouses w ON w.id=s.warehouse_id
    LEFT JOIN orgs o ON o.id=s.owner_org_id
    GROUP BY s.warehouse_id, s.owner_org_id LIMIT 6`).all()
  for (const r of sample) console.log(`    · ${r.wh} → 货主「${r.owner || '?'}」(${r.type}) ${r.currency} · ${r.c} 行`)
}
