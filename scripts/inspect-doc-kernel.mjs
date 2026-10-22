/**
 * ============================================================================
 * 文件标识：scripts/inspect-doc-kernel.mjs ｜ 单据内核实地勘察：列出所有「带 status 列」的表的真实取值分布与关键字段
 * ============================================================================
 * 【职责】单据内核实地勘察：列出所有「带 status 列」的表的真实取值分布与关键字段
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 单据内核实地勘察：列出所有「带 status 列」的表的真实取值分布与关键字段
// 用途：模块 04 单据内核的状态机定义必须来自实测，而不是照抄代码里的分支
import D from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DB = process.argv[2] || path.join(ROOT, 'data', 'gml_cosmetic.db')

const db = new D(DB, { readonly: true })
const tabs = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)

console.log(`数据库：${path.basename(DB)}\n`)
const statusTables = []
for (const t of tabs) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  if (!cols.includes('status')) continue
  const total = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  if (total === 0) continue
  const vs = db.prepare(`SELECT status, COUNT(*) c FROM ${t} GROUP BY status ORDER BY c DESC`).all()
  statusTables.push({ t, total, vs, cols })
}

for (const { t, total, vs, cols } of statusTables) {
  const extra = ['doc_no', 'biz_date', 'order_date', 'org_id', 'warehouse_id', 'store_id', 'dealer_id']
    .filter((c) => cols.includes(c))
  console.log(`${t}  (${total} 行)`)
  console.log(`   状态: ${vs.map((v) => `${v.status}×${v.c}`).join('  ')}`)
  console.log(`   字段: ${extra.join(', ') || '-'}`)
}

console.log('\n=== 所有 status 取值去重汇总 ===')
const set = new Set()
for (const { vs } of statusTables) for (const v of vs) set.add(`${v.status}`)
console.log([...set].sort().join('  '))
console.log(`共 ${set.size} 种取值，分布在 ${statusTables.length} 张表`)
db.close()
