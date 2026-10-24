#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-audit-fts-toggle.mjs ｜ 审计 FTS 开关耗时基准：合成 N 行库上 --enable（回填）/ --disable（删除）/ --integrity-check（roadmap-v10 AE4，ADR-0054 补充）
 * ============================================================================
 * 【职责】量出运维 `audit-fts-maintain --enable` 在大库上的真实持写锁时间：在**全新临时目录**建库（schema.sql + 全部迁移），先 `--disable`（空库，几乎瞬时），
 *   用 `bench-audit-logs.mjs` 的 `seed()`（唯一 INSERT 点 `insertAuditRow`，含 AB6 哈希链，此时没有 FTS 触发器）写入 N 行合成审计，`wal_checkpoint(TRUNCATE)`；
 *   然后依次：`--enable`（建表 + 触发器 + 回填，第 1 次）、`--integrity-check`、`--disable`（N 行时删除）、`--enable`（第 2 次）、`--integrity-check`。
 *   每步都是真实子进程调用维护脚本，读它的 JSON 报告（elapsed_ms、lock_probe、库体积），不是进程内模拟。
 * 【用法】node scripts/bench-audit-fts-toggle.mjs [--rows 1000000] [--out result.json]　临时库在系统临时目录，结束即删；不碰仓库 data/ 与任何在用库。
 * 【诚实边界】单次墙钟、单机、合成数据（detail 很短，三列文本短）；机器有负载只看量级；不是目标主机结果。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { seed } from './bench-audit-logs.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i < 0) return dflt; if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(`--${name} 缺少值`); process.exit(2) } return argv[i + 1] }
for (const a of argv) if (a.startsWith('--') && !['--rows', '--out'].includes(a)) { console.error(`未知参数 ${a}（可用：--rows --out）`); process.exit(2) }
const rows = Number(opt('rows', '1000000'))
if (!Number.isInteger(rows) || rows < 1 || rows > 5000000) { console.error('--rows 必须是 1..5000000 的整数'); process.exit(2) }
const out = opt('out', null)
if (out && !path.isAbsolute(out)) { console.error('--out 必须是绝对路径'); process.exit(2) }

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ae4-bench-'))
const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: 'b'.repeat(48) }
let step = 0
function maint(action) {
  const file = path.join(dir, `report-${++step}-${action}.json`)
  const r = spawnSync(process.execPath, ['scripts/audit-fts-maintain.mjs', '--data-dir', dir, '--industry', 'cosmetic', `--${action}`, '--out', file, ...(action === 'enable' || action === 'disable' ? ['--reason', 'AE4 bench'] : []), '--busy-ms', '300000'], { cwd: ROOT, env, encoding: 'utf8', timeout: 3600000 })
  if (r.status !== 0) throw new Error(`${action} exit ${r.status}: ${r.stderr || r.stdout}`)
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'))
  const lp = rep.lock_probe
  return { step: `--${action}`, status: rep.status, rows: rep.rows, elapsed_ms: rep.elapsed_ms, blocked_ms_lower: lp?.max_busy_span_ms ?? null, blocked_ms_upper: lp?.max_blocked_ms ?? null, mb_before: +(rep.bytes_before / 1048576).toFixed(0), mb_after: rep.bytes_after == null ? null : +(rep.bytes_after / 1048576).toFixed(0) }
}

const result = { rows, steps: [], seed_ms: null, db_mb: null }
try {
  const dbFile = path.join(dir, 'gml_cosmetic.db')
  let db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.close()
  result.steps.push(maint('disable'))
  db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  result.seed_ms = Math.round(seed(db, rows, mulberry32(20261024)))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  result.db_mb = +(fs.statSync(dbFile).size / 1048576).toFixed(0)
  for (const a of ['enable', 'integrity-check', 'disable', 'enable', 'integrity-check']) result.steps.push(maint(a))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`temp dir removed: ${!fs.existsSync(dir)}`)
}
console.log(JSON.stringify(result, null, 2))
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
