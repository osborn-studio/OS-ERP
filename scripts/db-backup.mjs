/**
 * ============================================================================
 * 文件标识：scripts/db-backup.mjs ｜ 数据库备份：VACUUM INTO 快照 → 强制校验 + 烟雾恢复 → 通过后才裁剪 → JSON 报告
 * ============================================================================
 * 【职责】为每个行业库生成一份经过校验的单文件快照，并按保留份数清理旧快照。
 *
 * 【判据】（ADR-0009，对应审阅报告 F12）
 *   · 新快照必须通过：integrity_check = ok、foreign_key_check 为空、表/视图数与源库一致、
 *     schema_migrations 行数与源库一致、只读打开后能在已知表（users）上 COUNT —— 这是
 *     "烟雾恢复"，不是完整恢复演练。
 *   · 校验失败：快照改名为 `*.db.failed`、不裁剪、计入失败、退出码非零。任一库失败整次非零。
 *   · 裁剪只在新快照通过之后进行，且永远不会把新文件裁掉、不会少于 keep 份。
 *   · 报告 backup-report-<stamp>.json 写在备份目录：每库结果、大小、sha256、校验结论。不含秘密。
 *   · 必须显式 GML_DATA_DIR（ADR-0001）；相对 backup_dir 解析到数据目录，不写仓库 data/。
 *
 * 【改它要注意什么】tests/db-backup.test.mjs 用真实子进程跑本脚本；`GML_BACKUP_FAULT`
 *   只在 GML_RUNTIME_MODE=test 下允许，其他模式直接拒绝运行。
 * ============================================================================
 */

// 用法：
//   node scripts/db-backup.mjs              # 三库各备一份并校验，按 settings.backup_keep 裁剪
//   node scripts/db-backup.mjs food         # 只备餐饮库
//   node scripts/db-backup.mjs --keep=3     # 临时改保留份数（含本次新文件）
//   node scripts/db-backup.mjs --verify     # 兼容旧用法：校验现在总是执行，此开关无额外作用
// 退出码：0 全部通过；1 任一库快照或校验失败；2 参数/环境错误（未知参数、缺少 GML_DATA_DIR、非法故障注入）。
//
// 口径：
//   · 备份目录与保留份数从各库 settings 表读（backup_dir / backup_keep），没有该键时用默认值；
//   · 文件名带时间戳（yyyyMMdd-HHmmss），同秒冲突加序号后缀；
//   · 裁剪只删本脚本自己生成的 `<库名>_*.db`，不动 `.failed`、报告和用户手工放的文件。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { INDUSTRIES, DATA_DIR, dbPathFor } from '../server/db/index.js'
import { runtimeMode, requireDataDirectory } from '../server/runtime.js'
import { resolveBackupDir } from '../server/lib/backup-dir.js'

const SMOKE_TABLE = 'users'
const SNAPSHOT_FAILED = 'BACKUP_SNAPSHOT_FAILED'
const VERIFY_FAILED = 'BACKUP_VERIFY_FAILED'

function usageError(message) {
  console.error(message)
  process.exit(2)
}

// ---- 参数 ----
const args = process.argv.slice(2)
const KNOWN_FLAGS = new Set(['--verify'])
let keepArg = null
for (const a of args.filter((x) => x.startsWith('--'))) {
  if (a.startsWith('--keep=')) {
    const n = Number(a.slice('--keep='.length))
    if (!Number.isInteger(n) || n < 1) usageError(`--keep 必须是不小于 1 的整数：${a}`)
    keepArg = n
  } else if (!KNOWN_FLAGS.has(a)) {
    usageError(`未知参数：${a}（可用：--keep=N、--verify）`)
  }
}
const target = args.find((a) => !a.startsWith('--'))
if (target && !Object.hasOwn(INDUSTRIES, target)) {
  usageError(`未知行业：${target}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
}
const codes = target ? [target] : Object.keys(INDUSTRIES)

// ---- 环境：显式数据目录（ADR-0001）与仅限测试的故障注入 ----
let mode
try {
  requireDataDirectory()
  mode = runtimeMode()
} catch (e) {
  usageError(`${e.code}: ${e.message}`)
}
const faultSpec = process.env.GML_BACKUP_FAULT || ''
let fault = null
if (faultSpec) {
  if (mode !== 'test') usageError(`BACKUP_FAULT_FORBIDDEN: GML_BACKUP_FAULT 只允许在 GML_RUNTIME_MODE=test 下使用（当前 ${mode}）`)
  const [kind, only] = faultSpec.split(':')
  if (kind !== 'truncate') usageError(`BACKUP_FAULT_INVALID: 不支持的故障类型 ${kind}`)
  fault = { kind, only: only || null }
}

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()

/** 从库里读运维参数；表缺失或键缺失时回落到默认值 */
function readSettings(db, fallback) {
  let dir = fallback.dir
  let keep = fallback.keep
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('backup_dir','backup_keep')").all()
    for (const r of rows) {
      if (r.key === 'backup_dir' && r.value) dir = r.value
      if (r.key === 'backup_keep' && Number.isInteger(Number(r.value)) && Number(r.value) > 0) keep = Number(r.value)
    }
  } catch {
    /* settings 表可能还没迁移出来，用默认值 */
  }
  return { dir, keep }
}

const countObjects = (db) => db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").get().c
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM "${table.replace(/"/g, '""')}"`).get().c

/** 源库快照口径：供校验比对 */
function describeSource(db) {
  return {
    tables: countObjects(db),
    migrations: hasTable(db, 'schema_migrations') ? countRows(db, 'schema_migrations') : null,
    smoke_table: hasTable(db, SMOKE_TABLE) ? SMOKE_TABLE : null
  }
}

/**
 * 校验新快照：只读打开，完整性 / 外键 / 结构数 / 迁移数 / 烟雾查询。
 * 任一项不满足或任何异常 ⇒ passed=false，reasons 列出原因。绝不抛出。
 */
function verifyBackup(file, source) {
  const v = { passed: false, integrity: null, foreign_key_violations: null, backup_tables: null, tables_match: false, backup_migrations: null, migrations_match: false, smoke: null, reasons: [] }
  let bk
  try {
    bk = new Database(file, { readonly: true })
    v.integrity = bk.pragma('integrity_check', { simple: true })
    if (v.integrity !== 'ok') v.reasons.push(`integrity_check=${v.integrity}`)
    v.foreign_key_violations = bk.pragma('foreign_key_check').length
    if (v.foreign_key_violations !== 0) v.reasons.push(`foreign_key_check 有 ${v.foreign_key_violations} 条违规`)
    v.backup_tables = countObjects(bk)
    v.tables_match = v.backup_tables === source.tables
    if (!v.tables_match) v.reasons.push(`表/视图数 ${v.backup_tables} ≠ 源库 ${source.tables}`)
    v.backup_migrations = hasTable(bk, 'schema_migrations') ? countRows(bk, 'schema_migrations') : null
    v.migrations_match = v.backup_migrations === source.migrations
    if (!v.migrations_match) v.reasons.push(`schema_migrations 行数 ${v.backup_migrations} ≠ 源库 ${source.migrations}`)
    if (source.smoke_table) {
      // 烟雾恢复：证明快照能被独立打开并查询已知表；这不是完整恢复演练
      v.smoke = { table: source.smoke_table, rows: countRows(bk, source.smoke_table) }
    } else {
      v.reasons.push(`源库没有 ${SMOKE_TABLE} 表，无法做烟雾恢复`)
    }
  } catch (e) {
    v.reasons.push(`打开/查询快照异常：${e.message}`)
  } finally {
    try { bk?.close() } catch { /* 已经失败，关闭异常不再覆盖原因 */ }
  }
  v.passed = v.reasons.length === 0
  return v
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 失败的快照改名为 *.failed：保留证据，但不会被当成可用备份（裁剪与恢复都只认 .db） */
function quarantine(file) {
  if (!fs.existsSync(file)) return null
  const failed = `${file}.failed`
  try {
    fs.renameSync(file, failed)
    return failed
  } catch {
    fs.rmSync(file, { force: true })
    return null
  }
}

const results = []
const dirsUsed = new Map() // dir → max keep
let failed = 0

for (const code of codes) {
  const src = dbPathFor(code)
  const label = INDUSTRIES[code].label
  if (!fs.existsSync(src)) {
    results.push({ code, label, status: 'skipped', reason: '数据库文件不存在', pruned: [] })
    continue
  }

  // 只读打开源库：VACUUM INTO 只需要读一致性，不动源文件
  const db = new Database(src, { readonly: true })
  const cfg = readSettings(db, { dir: null, keep: 10 })
  if (keepArg) cfg.keep = keepArg
  const dir = resolveBackupDir(cfg.dir, DATA_DIR)
  dirsUsed.set(dir, Math.max(dirsUsed.get(dir) || 0, cfg.keep))

  const base = path.basename(src, '.db')
  const entry = { code, label, status: 'failed', source: { path: src, ...describeSource(db) }, kept: cfg.keep, pruned: [] }

  let out = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    out = path.join(dir, `${base}_${stamp}.db`)
    let n = 1
    while (fs.existsSync(out) || fs.existsSync(`${out}.failed`)) out = path.join(dir, `${base}_${stamp}_${n++}.db`)
    // VACUUM INTO 产出的文件是紧凑、无 WAL 残留的完整库
    db.prepare('VACUUM INTO ?').run(out)
  } catch (e) {
    db.close()
    failed++
    entry.error = `${SNAPSHOT_FAILED}: ${e.message}`
    entry.failed_file = out ? quarantine(out) : null
    results.push(entry)
    continue
  }
  db.close()

  // 仅测试模式：模拟"快照文件写坏"，证明校验失败路径真的不裁剪、非零退出
  if (fault && (!fault.only || fault.only === code)) {
    const size = fs.statSync(out).size
    fs.truncateSync(out, Math.floor(size / 2))
  }

  // ---- 先校验，再决定要不要裁剪 ----
  const verification = verifyBackup(out, entry.source)
  entry.verification = verification
  if (!verification.passed) {
    failed++
    entry.error = `${VERIFY_FAILED}: ${verification.reasons.join('；')}`
    entry.failed_file = quarantine(out)
    results.push(entry)
    continue
  }

  entry.status = 'ok'
  entry.file = out
  entry.size = fs.statSync(out).size
  entry.sha256 = sha256File(out)

  // 裁剪：只处理本脚本命名规则生成的 .db，新文件永远保留，其余按时间保留 keep-1 份
  const outName = path.basename(out)
  const others = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}_`) && f.endsWith('.db') && f !== outName)
    .map((f) => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const item of others.slice(Math.max(cfg.keep - 1, 0))) {
    fs.unlinkSync(item.p)
    entry.pruned.push(item.f)
  }
  results.push(entry)
}

// ---- 报告：写到用到的每个备份目录；只有整次成功才顺带清理旧报告 ----
const report = {
  script: 'scripts/db-backup.mjs',
  generated_at: new Date().toISOString(),
  stamp,
  runtime_mode: mode,
  data_dir: DATA_DIR,
  failed,
  results
}
const reportFiles = []
for (const [dir, keep] of dirsUsed) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `backup-report-${stamp}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
    reportFiles.push(file)
    if (!failed) {
      const old = fs.readdirSync(dir).filter((f) => /^backup-report-.*\.json$/.test(f)).sort().reverse().slice(keep)
      for (const f of old) fs.unlinkSync(path.join(dir, f))
    }
  } catch (e) {
    console.error(`报告写入失败（${dir}）：${e.message}`)
    failed++
  }
}

for (const r of results) {
  const head = `  ${String(r.label).padEnd(14)}`
  if (r.status === 'skipped') {
    console.log(`${head} 跳过（${r.reason}）`)
    continue
  }
  if (r.status === 'failed') {
    console.log(`${head} 失败：${r.error}${r.failed_file ? `（已隔离为 ${path.basename(r.failed_file)}）` : ''}`)
    continue
  }
  const mb = (r.size / 1024 / 1024).toFixed(1)
  console.log(`${head} ${r.file}`)
  console.log(
    `${' '.repeat(16)} 表 ${r.source.tables} / 迁移 ${r.source.migrations ?? '-'} / ${mb}MB / sha256 ${r.sha256.slice(0, 12)}… ` +
      `｜ 校验 ${r.verification.integrity}、外键 ${r.verification.foreign_key_violations} 违规、结构一致、烟雾 ${r.verification.smoke.table}=${r.verification.smoke.rows} 行 ` +
      `｜ 保留 ${r.kept} 份，清理 ${r.pruned.length} 份`
  )
}
for (const f of reportFiles) console.log(`  报告：${f}`)
console.log(failed ? `备份完成，其中 ${failed} 个失败（旧备份未裁剪）` : '备份完成')
process.exit(failed ? 1 : 0)
