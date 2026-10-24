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
 * 【AD4 开关】`--disable` / `--enable`（必须带 `--reason`）：在**同一个写事务**里改设置 `audit_fts_enabled`（危险键，留痕到 setting_audit_log）并删除 / 重建 FTS 表与触发器
 *   （重建 = 迁移 067 的 up：建表、触发器、回填存量行，大库上持写锁到结束）。幂等；构建不支持 FTS5 时 `--enable` 报 status=unsupported、退出 1 且设置不改。ADR-0054。
 * 【用法】node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--integrity-check|--disable|--enable) [--reason <理由>] [--out <报告.json>] [--busy-ms <n>]
 *   · 必须显式 `--data-dir`（走 `requireExplicitDataDir()`，拒绝仓库 data/，symlink 也认）与 `--industry`；环境里的 `GML_DB` 被忽略。
 *   · 报告（JSON，0600）默认写到 `<data-dir>/audit-fts-maintain-<行业>-<动作>-<时间戳>.json`；`--out` 必须是绝对路径，物理位置（解开符号链接，含尚不存在的子目录）在仓库 data/ 之外，不能是库文件或其 -wal / -shm / -journal，且不覆盖已有文件（退出 2）。行业库文件本身是符号链接则拒绝（退出 2）。报告不含绝对路径。
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
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'
import { startLockProbe } from './lib/lock-probe.mjs'
import { ensureSettings, writeSetting } from '../server/lib/settings.js'

const m071 = createRequire(import.meta.url)('../server/db/migrations/071_audit_fts_optional.cjs')
const m067 = createRequire(import.meta.url)('../server/db/migrations/067_audit_fts.cjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FTS = 'audit_logs_fts'
const TRIGGERS = ['audit_logs_fts_ai', 'audit_logs_fts_ad', 'audit_logs_fts_au']
const MODES = ['optimize', 'rebuild', 'integrity-check', 'disable', 'enable']
const TOGGLES = ['disable', 'enable'] // AD4：同事务改设置 audit_fts_enabled 并删除/重建 FTS 表与触发器
const SQL = {
  optimize: `INSERT INTO ${FTS}(${FTS}) VALUES ('optimize')`,
  rebuild: `INSERT INTO ${FTS}(${FTS}) VALUES ('rebuild')`,
  'integrity-check': `INSERT INTO ${FTS}(${FTS}, rank) VALUES ('integrity-check', 1)`
}
/** 物理路径（解开符号链接）。路径不存在时：解析最近的已存在祖先，再接上缺失的尾部，所以"符号链接 + 尚不存在的子目录"也认得出来 */
function canonical(p, depth = 0) {
  if (depth > 32) throw Object.assign(new Error('符号链接层数过多'), { code: 'ELOOP' })
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()) } catch (e) {
      if (e.code === 'EACCES') throw e
      let target = null
      try { target = fs.readlinkSync(cur) } catch { /* 不是（悬空的）符号链接 */ }
      if (target !== null) return canonical(path.join(path.resolve(path.dirname(cur), target), ...tail.reverse()), depth + 1) // 悬空链接：跟着目标走
      const up = path.dirname(cur)
      if (up === cur) throw e
      tail.push(path.basename(cur))
      cur = up
    }
  }
}
const within = (dir, p) => p === dir || p.startsWith(dir + path.sep)

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--out', '--busy-ms', '--reason'], flags: MODES.map((m) => `--${m}`) })
const chosen = MODES.filter((m) => args[m])
if (chosen.length !== 1) die('USAGE', '用法：audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--integrity-check|--disable|--enable) [--reason <理由>] [--out <报告.json>] [--busy-ms <n>]（动作必须且只能选一个；--disable/--enable 必须带 --reason）')
const action = chosen[0]
if (TOGGLES.includes(action) && !String(args.reason || '').trim()) die('USAGE', `--${action} 改的是危险设置 audit_fts_enabled，必须带 --reason <理由>`)
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

// 库文件本身不许是符号链接（它可能指回仓库 data/）；在打开任何连接之前拒绝
if (fs.lstatSync(file).isSymbolicLink()) die('DB_IS_SYMLINK', '行业库文件是符号链接；请把真实库复制到隔离目录后再维护')
const repoData = canonical(path.join(ROOT, 'data'))
if (within(repoData, canonical(file))) die('DATA_DIRECTORY_IS_REPOSITORY', '行业库的物理路径在仓库 data/ 下')

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
if (args.out && !path.isAbsolute(args.out)) die('USAGE', '--out 必须是绝对路径')
const outFile = args.out ? path.resolve(args.out) : path.join(path.dirname(file), `audit-fts-maintain-${args.industry}-${action}-${stamp}.json`)
{
  const outReal = canonical(outFile)
  if (within(repoData, outReal)) die('DATA_DIRECTORY_IS_REPOSITORY', '--out 不能写进仓库 data/（含经符号链接）')
  const dbReal = canonical(file)
  if ([dbReal, `${dbReal}-wal`, `${dbReal}-shm`, `${dbReal}-journal`].includes(outReal)) die('OUT_IS_DATABASE', '--out 不能是库文件或它的 -wal / -shm / -journal')
  if (fs.existsSync(outFile)) die('OUT_EXISTS', '--out 已存在；本脚本不覆盖已有文件')
}

const exists = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name)
const sizeOf = (f) => ['', '-wal'].reduce((n, s) => { try { return n + fs.statSync(f + s).size } catch { return n } }, 0)
const isBusy = (e) => e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED' || /database is locked/.test(String(e.message)))

const readStoredSetting = (db) => db.prepare("SELECT value FROM settings WHERE key='audit_fts_enabled'").get()?.value ?? null
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
  if (TOGGLES.includes(action)) {
    // AD4：设置值与对象在同一个写事务里一起改——要么都改要么都不改。禁用 = 删表 + 触发器；启用 = 067 的 up（建表、触发器、回填）。
    report.setting_before = readStoredSetting(db)
    if (action === 'enable' && !m067.ftsSupported(db)) {
      report.status = 'unsupported'
      report.error = '本构建没有 FTS5 / trigram：无法建索引，设置未改动'
    } else {
      ensureSettings(db, { actor: { id: null, name: 'audit-fts-maintain', source: 'script' } })
      probe = await startLockProbe(file)
      const t0 = performance.now()
      try {
        db.exec('BEGIN IMMEDIATE')
        try {
          if (action === 'disable') report.changed_objects = m071.dropFts(db)
          else { const had = exists(db, 'table', FTS); m071.enableFts(db); report.changed_objects = !had }
          const w = writeSetting(db, { key: 'audit_fts_enabled', value: action === 'enable' ? '1' : '0', reason: args.reason.trim(), actor: { id: null, name: 'audit-fts-maintain', source: 'script' }, source: 'script' })
          report.setting_changed = w.changed
          db.exec('COMMIT')
        } catch (e) { try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ } throw e }
        report.status = 'ok'
      } catch (e) {
        report.status = isBusy(e) ? 'busy' : 'error'
        report.error = String(e.message).slice(0, 300)
      } finally {
        report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
        report.lock_probe = await probe.stop()
      }
      report.setting_after = readStoredSetting(db)
      report.fts_present = exists(db, 'table', FTS)
      report.triggers_present = Object.fromEntries(TRIGGERS.map((n) => [n, exists(db, 'trigger', n)]))
      report.bytes_after = sizeOf(file)
    }
    report.ok = report.status === 'ok'
  } else if (!report.fts_present) {
    report.status = 'absent'
    report.ok = action === 'integrity-check'
    report.error = report.ok ? null : `${FTS} 不存在（无 FTS5 的构建，或迁移 067 未执行）：没有可维护的索引`
  } else {
    probe = await startLockProbe(file)
    const t0 = performance.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      try { db.exec(SQL[action]); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ } throw e }
      report.status = 'ok'
    } catch (e) {
      report.status = isBusy(e) ? 'busy' : /CORRUPT|malformed|integrity/i.test(`${e.code} ${e.message}`) ? 'corrupt' : 'error'
      report.error = String(e.message).slice(0, 300)
    } finally {
      report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
      report.lock_probe = await probe.stop()
    }
    report.ok = report.status === 'ok' // 只在探针也正常收尾之后才算成功（探针 stop 抛错 → 外层 catch → ok 保持 false）
    report.bytes_after = sizeOf(file)
  }
} catch (e) {
  report.ok = false
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
