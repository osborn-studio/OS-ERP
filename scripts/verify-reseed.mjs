/**
 * ============================================================================
 * 文件标识：scripts/verify-reseed.mjs ｜ 数据校验：重建可复现性验证：`reseed-all --force` 跑两次，**业务值必须完全一致**。
 * ============================================================================
 * 【职责】数据校验：重建可复现性验证：`reseed-all --force` 跑两次，**业务值必须完全一致**。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 重建可复现性验证：`reseed-all --force` 跑两次，**业务值必须完全一致**。
 *
 * 为什么这件事必须单独有一条命令（而不是"重建能成功就行"）：
 *   本项目的演示数据是**确定性**生成的（唯一随机入口 `seed.js` 的 mulberry32）。
 *   "确定性"的意思不是"大致一样"，而是**同一份代码重建出的库应当逐项相等** ——
 *   单号序列、自增 id、批次号、各表行数、取号计数器……都不该漂移。
 *   一旦漂移，凡是"按单号排序取第一条"这类断言就会**随机失败**，
 *   而失败点每轮都不同（批次 C 收尾出现过：连挂 4 轮、每轮失败点都不一样，
 *   根因是 `doc_no_counters` 没被清 —— 单号往后走了一位）。
 *
 * 判据（两次 `--force` 重建之间比对）：
 *   · 每张表的**行数**；
 *   · 每张表里**对外标识列**（`doc_no` / `code` / `key`）的**完整有序序列**（sha1）。
 *     单号与编码是"派生值"，重建后必须一模一样 —— 这是本验证的核心。
 *
 * 刻意不比对：任何**时间戳**列（`created_at` / `updated_at` / `*_at`）。
 *   灌数时钟由 `resetSeedClock()` 冻结，但它冻的是"逻辑起点"，
 *   而真实执行耗时会让不同轮次的墙上时间不同 —— 比对它们只会得到假红。
 *
 * 用法：GML_DATA_DIR=/absolute/dir node scripts/verify-reseed.mjs [cosmetic|food|apparel]
 *
 * ⚠️ 会**抹掉手工点出来的单据**（它跑的就是 `--force` 重建）—— 所以数据目录**必须显式**且不许是
 *   仓库 data/（ADR-0019）：原来 `GML_DATA_DIR || <repo>/data` 的兜底意味着漏设 env 就把开发库重建两遍。
 *   库文件路径由 `dbPathFor()` 解析，与 reseed-all 子进程（继承同一 env）同源。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { INDUSTRIES, requireExplicitDataDir, dbPathFor } from '../server/db/index.js'

try {
  requireExplicitDataDir()
} catch (e) {
  console.error(`${e.code}: ${e.message}`)
  process.exit(2)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.execPath
const target = process.argv[2]
const codes = target && INDUSTRIES[target] ? [target] : Object.keys(INDUSTRIES)

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)

/** 业务值指纹：行数 + 所有对外标识列的有序序列（按 key 组织，便于定位差异） */
function fingerprint(industry) {
  const db = new Database(dbPathFor(industry), { readonly: true })
  const m = new Map()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
  for (const t of tables) {
    m.set(`${t}#count`, String(db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c))
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)
    for (const col of cols.filter((c) => ['doc_no', 'code', 'key', 'batch_no'].includes(c))) {
      const seq = db
        .prepare(`SELECT "${col}" v FROM "${t}" WHERE "${col}" IS NOT NULL ORDER BY "${col}"`)
        .all()
        .map((r) => r.v)
        .join('|')
      m.set(`${t}.${col}`, sha1(seq))
    }
  }
  db.close()
  const hash = sha1([...m.entries()].map(([k, v]) => `${k}=${v}`).join('\n'))
  return { hash, map: m }
}

function reseed(industry) {
  const r = spawnSync(NODE, ['scripts/reseed-all.mjs', industry, '--force'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { ok: r.status === 0, out }
}

let fail = 0
console.log('=== 重建可复现性（两次 --force 逐项比对） ===')

for (const ind of codes) {
  const label = INDUSTRIES[ind].label
  const first = reseed(ind)
  if (!first.ok) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} 第 1 次重建失败：\n${first.out.split('\n').slice(-12).join('\n')}`)
    fail += 1
    continue
  }
  const a = fingerprint(ind)
  const second = reseed(ind)
  if (!second.ok) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} 第 2 次重建失败：\n${second.out.split('\n').slice(-12).join('\n')}`)
    fail += 1
    continue
  }
  const b = fingerprint(ind)

  if (a.hash === b.hash) {
    console.log(`  \x1b[32m✓\x1b[0m ${label} 两次重建业务值完全一致（${a.map.size} 项，指纹 ${a.hash}）`)
    continue
  }
  fail += 1
  const keys = new Set([...a.map.keys(), ...b.map.keys()])
  const diffs = [...keys].filter((k) => a.map.get(k) !== b.map.get(k)).sort()
  console.log(`  \x1b[31m✗\x1b[0m ${label} 两次重建**不一致**（${a.hash} ≠ ${b.hash}）—— 共 ${diffs.length} 项漂移：`)
  for (const k of diffs.slice(0, 40)) {
    console.log(`      ${k}：第 1 次 ${a.map.get(k) ?? '(缺)'} → 第 2 次 ${b.map.get(k) ?? '(缺)'}`)
  }
  if (diffs.length > 40) console.log(`      …… 还有 ${diffs.length - 40} 项`)
}

console.log(`\n通过 ${codes.length - fail} / 失败 ${fail}`)
if (fail) process.exit(1)
