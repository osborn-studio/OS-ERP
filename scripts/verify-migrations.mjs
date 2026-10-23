/**
 * ============================================================================
 * 文件标识：scripts/verify-migrations.mjs ｜ 数据校验：迁移结果自检：node scripts/verify-migrations.mjs
 * ============================================================================
 * 【职责】数据校验：迁移结果自检：node scripts/verify-migrations.mjs
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 迁移结果自检：node scripts/verify-migrations.mjs
// 除了结构打印，还核对 schema_migrations 登记的迁移文件校验和（ADR-0009）：
// 任一库出现 mismatched 即以退出码 1 结束；unrecorded 只提示（下次启动会自动收养）。
import { getDbFor } from '../server/db/index.js'
import { checkMigrationChecksums } from '../server/db/migrations/runner.js'

let checksumFailures = 0

const NEW_TABLES = [
  'orgs',
  'org_functions',
  'inventory_batches',
  'inventory_reservations',
  'stock_cost_ledger',
  'inv_txn_types',
  'inv_params'
]

for (const code of ['cosmetic', 'food', 'apparel']) {
  const db = getDbFor(code)
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name)

  console.log(`\n===== [${code}] =====`)
  console.log(
    '新表: ' + NEW_TABLES.map((t) => `${t}${tables.includes(t) ? ' OK' : ' MISSING'}`).join('  ')
  )

  const stockCols = db.prepare('PRAGMA table_info(inventory_stocks)').all().map((r) => r.name)
  console.log('stocks 列: ' + stockCols.join(', '))

  const ddl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory_stocks'`)
    .get()?.sql || ''
  const uq = ddl.match(/UNIQUE \([^)]*\)/)
  console.log('stocks 唯一键: ' + (uq ? uq[0] : '无'))

  const cnt = (t) => {
    try {
      return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    } catch {
      return 'N/A'
    }
  }
  console.log(
    `stocks 行数=${cnt('inventory_stocks')}  txn行数=${cnt('inventory_transactions')}  ` +
      `事务类型=${cnt('inv_txn_types')}  参数=${cnt('inv_params')}  orgs=${cnt('orgs')}`
  )

  const whCols = db.prepare('PRAGMA table_info(warehouses)').all().map((r) => r.name)
  console.log('warehouses 新增列: ' + whCols.filter((c) => ['org_id', 'default_owner_org_id', 'currency', 'region', 'brand_id'].includes(c)).join(', '))

  const stCols = db.prepare('PRAGMA table_info(stores)').all().map((r) => r.name)
  console.log('stores 新增列: ' + stCols.filter((c) => ['org_id', 'owner_org_id', 'brand_id', 'currency', 'tax_region'].includes(c)).join(', '))

  const txnCols = db.prepare('PRAGMA table_info(inventory_transactions)').all().map((r) => r.name)
  console.log('txn 新增列: ' + txnCols.filter((c) => ['owner_org_id', 'currency', 'fx_rate', 'cost_method', 'txn_type', 'biz_time', 'source'].includes(c)).join(', '))

  const sums = checkMigrationChecksums(db)
  console.log(
    `迁移校验和: 一致 ${sums.verified}  未登记 ${sums.unrecorded.length}  不一致 ${sums.mismatched.length}  文件缺失 ${sums.missing.length}` +
      (sums.mismatched.length ? `  MISMATCH → ${sums.mismatched.join(', ')}` : '') +
      (sums.missing.length ? `  缺失 → ${sums.missing.join(', ')}` : '')
  )
  if (sums.mismatched.length) checksumFailures += 1
}

if (checksumFailures) {
  console.error(`\n[verify-migrations] MIGRATION_CHECKSUM_MISMATCH：${checksumFailures} 个库的已执行迁移文件与登记校验和不一致`)
  process.exitCode = 1
}
