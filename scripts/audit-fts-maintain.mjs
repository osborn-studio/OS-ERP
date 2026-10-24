#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-fts-maintain.mjs ｜ 审计日志 FTS5 索引维护：optimize / rebuild / integrity-check，报告持写锁时间（roadmap-v8 AC5）
 * ============================================================================
 * 【职责】迁移 067 的 `audit_logs_fts`（FTS5 外部内容表，trigram）是影子索引：触发器漏维护（裸 SQL 写入、触发器被删）、
 *   崩溃或升级后可能与 `audit_logs` 不一致。本脚本提供三个运维动作，都在**一个显式写事务**里完成，并用 `scripts/lib/lock-probe.mjs`
 *   （另一个线程、自己的连接，反复 `BEGIN IMMEDIATE`）量出"别的写入者被挡住多久"：
 *   · `--integrity-check`：FTS5 `integrity-check`（rank=1，同时与 audit_logs 内容表对账）。不一致 → status=corrupt，退出 1；表不存在 → status=absent，退出 0（无 FTS5 的构建上本来就没有）。
 *   · `--optimize`：合并索引段（`optimize`），不改变内容。
 *   · `--rebuild`：从 audit_logs 重建整个倒排索引（`rebuild`）。**单次写事务，持写锁到结束**；大库上耗时见 capacity-baseline "AC5"。
 *   `optimize` / `rebuild` 在表不存在时退出 1（没有东西可维护；建表是迁移 067 的事，不在这里）。
 *
 * 【用法】node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--integrity-check) [--out <报告.json>] [--busy-ms <n>]
 *   · 必须显式 `--data-dir`（走 `requireExplicitDataDir()`，拒绝仓库 data/，symlink 也认）与 `--industry`；环境里的 `GML_DB` 被忽略。
 *   · 报告（JSON，0600）默认写到 `<data-dir>/audit-fts-maintain-<行业>-<动作>-<时间戳>.json`；`--out` 必须在仓库 data/ 之外。不含绝对路径。
 *   · 退出码：0 成功；1 操作失败（corrupt / busy / absent+写操作 / 其它错误）；2 参数 / 环境错误。
 *   · `--busy-ms`（默认 5000，0..300000）：等写锁的上限；拿不到则 status=busy、退出 1，索引不被改动（事务未开始）。
 *
 * 【诚实边界】持锁探针是**写入者**视角（WAL 下读者不被挡）；`max_blocked_ms` 近似上界、`max_busy_span_ms` 下界，见 lock-probe.mjs。
 *   `elapsed_ms` 是本进程从 BEGIN 到 COMMIT 的墙钟，是持写锁时间的粗上界。脚本不创建缺失的库、不跑迁移、不碰 `GML_AUDIT_FTS` 开关
 *   （该开关只影响查询路径，不影响本脚本；维护索引与是否使用索引是两件事）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'
import { startLockProbe } from './lib/lock-probe.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FTS = 'audit_logs_fts'
const TRIGGERS = ['audit_logs_fts_ai', 'audit_logs_fts_ad', 'audit_logs_fts_au']
const MODES = ['optimize', 'rebuild', 'integrity-check']
const SQL = {
  optimize: `INSERT INTO ${FTS}(${FTS}) VALUES ('optimize')`,
  rebuild: `INSERT INTO ${FTS}(${FTS}) VALUES ('rebuild')`,
  'integrity-check': `INSERT INTO ${FTS}(${FTS}, rank) VALUES ('integrity-check', 1)`
}
const physical = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--out', '--busy-ms'], flags: MODES.map((m) => `--${m}`) })
const chosen = MODES.filter((m) => args[m])
if (chosen.length !== 1) die('USAGE', '用法：audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--integrity-check) [--out <报告.json>] [--busy-ms <n>]（三个动作必须且只能选一个）')
const action = chosen[0]
if (!args['data-dir']) die('USAGE', '--data-dir <绝对路径> 必填')
if (!args.industry) die('USAGE', '--industry <行业> 必填')
let busyMs = 5000
if (args['busy-ms'] !== undefined) {
  if (!/^\d+$/.test(args['busy-ms']) || Number(args['busy-ms']) > 300000) die('USAGE', '--busy-ms 必须是 0..300000 的整数毫秒')
  busyMs = Number(args['busy-ms'])
}
// 环境里的 GML_DB 会让 dbPathFor() 绕过显式数据目录：本脚本只认 --data-dir
delete process.env.GML_DB
const { targets } = await locateDatabases(args)
if (!targets.length) die('DB_ABSENT', `行业库 ${args.industry} 在 --data-dir 下不存在（本脚本不创建库）`)
const file = targets[0].file

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const outFile = args.out ? path.resolve(args.out) : path.join(path.dirname(file), `audit-fts-maintain-${args.industry}-${action}-${stamp}.json`)
if (args.out && !path.isAbsolute(args.out)) die('USAGE', '--out 必须是绝对路径')
{
  const repoData = physical(path.join(ROOT, 'data'))
  const outDir = physical(path.dirname(outFile))
  if (outDir === repoData || outDir.startsWith(repoData + path.sep)) die('DATA_DIRECTORY_IS_REPOSITORY', '--out 不能写进仓库 data/')
}

const exists = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name)
const sizeOf = (f) => ['', '-wal'].reduce((n, s) => { try { return n + fs.statSync(f + s).size } catch { return n } }, 0)
const isBusy = (e) => e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED' || /database is locked/.test(String(e.message)))

const report = {
  schema_version: 1, action, industry: args.industry, data_file: path.basename(file), started_at: new Date().toISOString(),
  ok: false, status: 'error', error: null, rows: null, fts_present: null, triggers_present: null, busy_timeout_ms: busyMs,
  bytes_before: sizeOf(file), bytes_after: null, elapsed_ms: null, lock_probe: null
}

let db
let probe
try {
  db = new Database(file, { fileMustExist: true })
  db.pragma(`busy_timeout = ${busyMs}`)
  report.fts_present = exists(db, 'table', FTS)
  report.triggers_present = Object.fromEntries(TRIGGERS.map((n) => [n, exists(db, 'trigger', n)]))
  report.rows = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  if (!report.fts_present) {
    report.status = 'absent'
    report.ok = action === 'integrity-check'
    report.error = report.ok ? null : `${FTS} 不存在（无 FTS5 的构建，或迁移 067 未执行）：没有可维护的索引`
  } else {
    probe = await startLockProbe(file)
    const t0 = performance.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      try { db.exec(SQL[action]); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ } throw e }
      report.ok = true
      report.status = 'ok'
    } catch (e) {
      report.status = isBusy(e) ? 'busy' : /CORRUPT|malformed|integrity/i.test(`${e.code} ${e.message}`) ? 'corrupt' : 'error'
      report.error = String(e.message).slice(0, 300)
    } finally {
      report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
      report.lock_probe = await probe.stop()
    }
    report.bytes_after = sizeOf(file)
  }
} catch (e) {
  report.status = isBusy(e) ? 'busy' : 'error'
  report.error = String(e.message).slice(0, 300)
} finally {
  try { db?.close() } catch { /* ignore */ }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
const tmp = `${outFile}.${process.pid}.tmp`
fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
fs.renameSync(tmp, outFile)
const lp = report.lock_probe
console.log(`audit-fts-maintain ${action} ${report.ok ? 'ok' : 'FAILED'} status=${report.status} industry=${report.industry} rows=${report.rows} elapsed_ms=${report.elapsed_ms ?? '-'}` +
  (lp ? ` lock_blocked_ms<=${lp.max_blocked_ms} lock_busy_span_ms>=${lp.max_busy_span_ms}` : '') + (report.error ? ` error=${report.error}` : ''))
process.exit(report.ok ? 0 : 1)
