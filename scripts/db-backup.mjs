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
 *   · （ADR-0022）设置 GML_BACKUP_KEY（≥32 字节）⇒ 输出 AES-256-GCM `.db.enc`，报告 sha256 为密文；明文只在 0600 临时文件里
 *     存活到加密完成后被擦除；校验失败在加密模式下直接擦除而不是隔离。三库在同一写冻结窗口内快照，
 *     报告带共享的 consistency_stamp（近似一致点，非跨库事务）。
 *
 * 【审计链清单】（ADR-0049 补充，AC7）每份通过校验的快照再对**快照内容**跑一次审计链校验，把链尾 id / row_hash / 行数与 `audit_chain_anchors` 的
 *   摘要写进报告条目 `audit_chain`，并在备份旁写 `<备份>.audit-manifest.json`（含锚点明细）；加密模式再写同内容的 `<备份>.audit-manifest.enc`
 *   （AES-256-GCM，认证）。这些是**要离机保存**的对象（docs/operations/audit-integrity.md §6），`audit-verify-chain --against-backup` 据此识别“整链重算”。
 *   链校验失败不挡备份（被篡改的库也要有备份），只在清单里 `verified:false`。清单写失败 ⇒ 该库备份失败（不留没有清单的新备份）。
 *
 * 【报告与清理的持久性】（AG6）报告写成临时文件 `.backup-report-<stamp>.json.<pid>.<rand>.tmp` → fsync → rename → 目录 fsync（下一次运行只清扫已退出的本机 PID 临时文件；存活、权限不明及旧格式文件保留供人工检查）。清理分三步：
 *   ① 算出要删的旧备份与孤儿清单，记进报告条目（`pruned` / `pruned_orphans`，`prune_state=planned`）并把 `report_phase=pre-prune` 的报告持久化；② 才删除（备份先、清单后），再 fsync 目录；
 *   ③ 写 `report_phase=final` 终版报告（`prune_state=done|failed|skipped|none`）。pre-prune 报告写不下去 ⇒ 不删任何文件（`skipped`）。注入点 `backup.after-report-write-before-rename`、`backup.after-prune-delete-before-dirsync`。
 *
 * 【写入顺序】（AD6）无密钥时快照先写 `<终名>.partial`，校验通过、fsync 后才 rename 成终名 `.db`；注入点 `backup.{after-db-copy,before-sidecar,after-sidecar}`（GML_TEST_FS_FAULT，仅 test 模式）
 *   之后的状态与恢复见 docs/operations/audit-integrity.md §5b。
 *
 * 【告警】（ADR-0029）有失败且设置 GML_ALERT_CHANNEL（已存在的通知渠道 code）⇒ 经通知发送路径发一条简短告警（只含行业码/错误码/数据目录名）；成功静默。
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
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { INDUSTRIES, DATA_DIR, dbPathFor } from '../server/db/index.js'
import { runtimeMode, requireDataDirectory } from '../server/runtime.js'
import { resolveBackupDir } from '../server/lib/backup-dir.js'
import { sendBackupAlert } from '../server/lib/backup-alert.js'
import { getChannel } from '../server/lib/notify.js'
import { loadBackupKey, encryptFile, decryptFile, shredFile, FORMAT_VERSION } from '../server/lib/backup-crypto.js'
import { faultPoint, assertFsFaultAllowed } from './lib/fs-fault.mjs'
import { summarizeAuditChain, withoutAnchorList, buildManifest } from '../server/lib/audit-anchor-manifest.js'

const SMOKE_TABLE = 'users'
const SNAPSHOT_FAILED = 'BACKUP_SNAPSHOT_FAILED'
const VERIFY_FAILED = 'BACKUP_VERIFY_FAILED'
const FREEZE_FAILED = 'BACKUP_FREEZE_FAILED'
const ENCRYPT_FAILED = 'BACKUP_ENCRYPT_FAILED'
const MANIFEST_FAILED = 'BACKUP_MANIFEST_FAILED'
const FINALIZE_FAILED = 'BACKUP_FINALIZE_FAILED'
const PRUNE_FAILED = 'BACKUP_PRUNE_FAILED'
const CONSISTENCY_NOTE = '短暂写冻结下的近似一致点：三库在同一窗口内各持有 BEGIN IMMEDIATE 保留锁后依次快照，窗口内无新提交；这不是跨库事务，窗口外的写入顺序不被保证。'

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

try { assertFsFaultAllowed() } catch (e) { usageError(`${e.code}: ${e.message}`) }

let backupKey = null
try {
  backupKey = loadBackupKey()
} catch (e) {
  usageError(`${e.code}: ${e.message}`)
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
function quarantine(file, failed = `${file}.failed`) {
  if (!fs.existsSync(file)) return null
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

// ---- 阶段 1：同一写冻结窗口 ----
// 对所有存在的库各开一个写连接并 BEGIN IMMEDIATE（持有保留锁、不写任何东西），其他写者被挡住；
// 窗口内用只读连接依次 VACUUM INTO（VACUUM 不能在事务内，所以不在持锁连接上做）。这是"短暂写冻结下的近似一致点"，
// 不是跨库分布式事务：窗口开始前已提交的写入全部可见，窗口内无新提交；窗口外不保证。
const plan = []
const locks = []
const consistencyId = randomBytes(8).toString('hex')
let freezeError = null
const freezeStart = performance.now()
const frozenAt = new Date().toISOString()
for (const code of codes) {
  const src = dbPathFor(code)
  const label = INDUSTRIES[code].label
  if (!fs.existsSync(src)) {
    plan.push({ code, label, skipped: true })
    continue
  }
  plan.push({ code, label, src })
}
try {
  for (const item of plan.filter((p) => !p.skipped)) {
    const lock = new Database(item.src, { timeout: 5000 })
    locks.push(lock)
    lock.exec('BEGIN IMMEDIATE')
  }
} catch (e) {
  freezeError = `${FREEZE_FAILED}: ${e.message}`
}

const stampOf = () => ({ id: consistencyId, frozen_at: frozenAt, released_at: null, freeze_ms: null, note: CONSISTENCY_NOTE })

if (freezeError) {
  for (const l of locks) { try { l.exec('ROLLBACK') } catch { /* ignore */ } try { l.close() } catch { /* ignore */ } }
  locks.length = 0
  dirsUsed.set(resolveBackupDir(null, DATA_DIR), 10) // 冻结失败时没读到各库设置，报告写到默认备份目录
  for (const item of plan) {
    if (item.skipped) results.push({ code: item.code, label: item.label, status: 'skipped', reason: '数据库文件不存在', pruned: [] })
    else { failed++; results.push({ code: item.code, label: item.label, status: 'failed', error: freezeError, pruned: [] }) }
  }
}

const fsyncPath = (file) => { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
const fsyncDir = (dir) => { if (process.platform !== 'win32') fsyncPath(dir) } // 目录只能只读打开；Windows 不支持
/** 逐级创建目录并 fsync 每个新目录的父目录，否则首次运行时备份目录本身的目录项断电后可能丢失 */
function mkdirDurable(dir) {
  const created = []
  for (let d = path.resolve(dir); !fs.existsSync(d); d = path.dirname(d)) created.unshift(d)
  fs.mkdirSync(dir, { recursive: true })
  for (const d of created) fsyncDir(path.dirname(d))
}
/** 新建文件（wx，0600）→ 写入 → fsync → 关闭；先登记再写，失败时调用方才能清理本次创建的文件 */
function writeFileDurable(file, text, owned, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode)
  owned.push(file)
  try { const buf = Buffer.from(text, 'utf8'); for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
// ---- 阶段 2：窗口内只做快照（明文快照；加密在窗口外） ----
const snaps = []
// 兜底：任何未捕获异常/提前退出，都在进程退出时擦除仍在登记的明文临时文件
const plainTmps = new Set()
process.on('exit', () => { for (const f of plainTmps) { try { shredFile(f) } catch { /* 尽力而为 */ } } })
if (!freezeError) {
  const prevUmask = backupKey ? process.umask(0o077) : null
  try {
    for (const item of plan) {
      if (item.skipped) { snaps.push(item); continue }
      const db = new Database(item.src, { readonly: true })
      const cfg = readSettings(db, { dir: null, keep: 10 })
      if (keepArg) cfg.keep = keepArg
      const dir = resolveBackupDir(cfg.dir, DATA_DIR)
      dirsUsed.set(dir, Math.max(dirsUsed.get(dir) || 0, cfg.keep))
      const base = path.basename(item.src, '.db')
      const entry = { code: item.code, label: item.label, status: 'failed', source: { path: item.src, ...describeSource(db) }, kept: cfg.keep, pruned: [] }
      const snap = { entry, cfg, dir, base, out: null, finalOut: null }
      try {
        mkdirDurable(dir)
        const ext = backupKey ? '.db.enc' : '.db'
        let n = 0
        const suffix = () => (n ? `_${n}` : '')
        let finalOut
        // 密文名与明文临时名同序号，冲突时一起换
        for (;;) {
          finalOut = path.join(dir, `${base}_${stamp}${suffix()}${ext}`)
          if (!fs.existsSync(finalOut) && !fs.existsSync(`${finalOut}.failed`) && !fs.existsSync(`${finalOut}.partial`) &&
              !fs.existsSync(`${finalOut}.audit-manifest.json`) && !fs.existsSync(`${finalOut}.audit-manifest.enc`)) break
          n++
        }
        snap.finalOut = finalOut
        // 有密钥时明文快照只存在于 0600 临时文件（窗口：从 VACUUM INTO 到加密完成后擦除）
        // 无密钥时先落 `<终名>.partial`，校验通过后才改成终名（AD6）：被杀在快照与校验之间时，磁盘上不会出现没验过的 `.db`（会被裁剪当成一份备份）
        snap.out = backupKey ? path.join(dir, `.${base}_${stamp}${suffix()}.${randomBytes(6).toString('hex')}.plain.tmp`) : `${finalOut}.partial`
        if (backupKey) plainTmps.add(snap.out)
        db.prepare('VACUUM INTO ?').run(snap.out)
        faultPoint('backup.after-db-copy')
      } catch (e) {
        failed++
        entry.error = `${SNAPSHOT_FAILED}: ${e.message}`
        entry.failed_file = snap.out ? (backupKey ? (shredFile(snap.out), plainTmps.delete(snap.out), null) : quarantine(snap.out, `${snap.finalOut}.failed`)) : null
        snap.dead = true
      } finally {
        db.close()
      }
      snaps.push(snap)
    }
  } finally {
    if (prevUmask !== null) process.umask(prevUmask)
    for (const l of locks) { try { l.exec('ROLLBACK') } catch { /* 无写入，回滚即释放 */ } try { l.close() } catch { /* ignore */ } }
  }
}
const releasedAt = new Date().toISOString()
const freezeMs = Math.round(performance.now() - freezeStart)
const consistency = { ...stampOf(), released_at: releasedAt, freeze_ms: freezeMs, databases: plan.filter((p) => !p.skipped).map((p) => p.code) }

// ---- 阶段 3a：窗口外 —— 注入故障、校验、（加密）、落终名 + 目录 fsync、擦除明文 ----
// AF6：**所有库**先走完 3a（明文在此阶段结束时全部擦除），再进入 3b 的清单阶段。这样 3b 的任何中止（含 abort）都不会
// 在盘上留下任何库的明文；剩下的明文窗口只有 after-db-copy 与冻结窗口本身（kill -9 / 断电）。
const pending = []
for (const snap of snaps) {
  if (snap.skipped) {
    results.push({ code: snap.code, label: snap.label, status: 'skipped', reason: '数据库文件不存在', pruned: [] })
    continue
  }
  const { entry, cfg, dir, base, out, finalOut } = snap
  entry.consistency_stamp = consistency.id
  results.push(entry)
  if (snap.dead) continue
  const discard = () => (backupKey ? (shredFile(out), plainTmps.delete(out), null) : quarantine(out, `${finalOut}.failed`)) // 加密模式绝不把明文隔离留盘

  // 仅测试模式：模拟"快照文件写坏"，证明校验失败路径真的不裁剪、非零退出
  if (fault && (!fault.only || fault.only === entry.code)) {
    const size = fs.statSync(out).size
    fs.truncateSync(out, Math.floor(size / 2))
  }

  // ---- 先校验（对明文快照），再决定要不要加密/裁剪 ----
  const verification = verifyBackup(out, entry.source)
  entry.verification = verification
  if (!verification.passed) {
    failed++
    entry.error = `${VERIFY_FAILED}: ${verification.reasons.join('；')}`
    entry.failed_file = discard()
    continue
  }

  // 审计链清单：对**明文快照**（加密前）计算；失败不拦备份，但要在报告里留下痕迹
  let chainSummary
  try {
    const sdb = new Database(out, { readonly: true })
    try { chainSummary = summarizeAuditChain(sdb) } finally { sdb.close() }
  } catch (e) {
    chainSummary = { present: false, error: e.message }
  }
  entry.audit_chain = withoutAnchorList(chainSummary)

  entry.encrypted = !!backupKey
  if (backupKey) {
    const t0 = performance.now()
    try {
      const enc = encryptFile(out, finalOut, backupKey)
      decryptFile(finalOut, null, backupKey) // 回读认证：确认落盘密文能用当前密钥解开
      fsyncDir(dir) // 密文改名的目录项先落盘，再擦除明文（AF6）
      entry.encryption = { algorithm: 'AES-256-GCM', format_version: FORMAT_VERSION, kdf: 'HKDF-SHA256(per-file salt)', ms: Math.round(performance.now() - t0) }
      entry.size = enc.size
      entry.sha256 = enc.sha256 // 密文 sha256
    } catch (e) {
      failed++
      fs.rmSync(finalOut, { force: true })
      entry.error = `${ENCRYPT_FAILED}: ${e.message}`
      shredFile(out)
      plainTmps.delete(out)
      continue
    }
    shredFile(out) // 明文临时文件在此擦除
    plainTmps.delete(out)
    entry.file = finalOut
  } else {
    // 已通过校验：fsync 后原子改成终名，再 fsync 目录项
    try {
      fsyncPath(out)
      fs.renameSync(out, finalOut)
      fsyncDir(dir)
      entry.file = finalOut
      entry.size = fs.statSync(finalOut).size
      entry.sha256 = sha256File(finalOut)
    } catch (e) {
      failed++
      fs.rmSync(finalOut, { force: true })
      fs.rmSync(out, { force: true })
      entry.error = `${FINALIZE_FAILED}: ${e.message}`
      entry.file = undefined
      continue
    }
  }
  pending.push({ snap, chainSummary })
}
// 所有库的终名都已 fsync、明文都已擦除。注入点放在这里（而不是每库一次），保证 abort 时也没有任何库的明文留盘。
if (pending.length) {
  try {
    faultPoint('backup.after-enc-rename-fsync')
  } catch (e) {
    // 已改成终名但还没有清单：与清单失败同口径，不留没有清单的新备份
    for (const { snap } of pending) {
      failed++
      fs.rmSync(snap.entry.file, { force: true })
      snap.entry.status = 'failed'
      snap.entry.error = `${FINALIZE_FAILED}: ${e.message}`
      snap.entry.file = undefined
    }
    pending.length = 0
  }
}

// ---- 阶段 3b：清单（fsync 文件 + 目录）、裁剪 ----
for (const { snap, chainSummary } of pending) {
  const { entry, cfg, dir, base } = snap
  const ownedSidecars = [] // 失败清理只删本次创建的文件，不碰别人遗留的同名文件
  try {
    faultPoint('backup.before-sidecar')
    const manifest = buildManifest({ industry: entry.code, backupFile: entry.file, backupSha256: entry.sha256, summary: chainSummary })
    const text = JSON.stringify(manifest, null, 2) + '\n'
    writeFileDurable(`${entry.file}.audit-manifest.json`, text, ownedSidecars) // 明文清单：写后 fsync（AF6）
    if (backupKey) {
      const tmpPlain = path.join(dir, `.${path.basename(entry.file)}.manifest.${randomBytes(6).toString('hex')}.plain.tmp`)
      plainTmps.add(tmpPlain)
      try {
        fs.writeFileSync(tmpPlain, text, { mode: 0o600, flag: 'wx' })
        encryptFile(tmpPlain, `${entry.file}.audit-manifest.enc`, backupKey)
        ownedSidecars.push(`${entry.file}.audit-manifest.enc`)
      } finally {
        shredFile(tmpPlain)
        plainTmps.delete(tmpPlain)
      }
    }
    fsyncDir(dir) // 清单目录项（含 .enc 清单的改名）在报告之前落盘（AF6）
    faultPoint('backup.after-manifest-fsync')
  } catch (e) {
    failed++
    for (const f of [entry.file, ...ownedSidecars]) fs.rmSync(f, { force: true })
    entry.status = 'failed'
    entry.error = `${MANIFEST_FAILED}: ${e.message}`
    entry.file = undefined
    continue
  }
  faultPoint('backup.after-sidecar')
  entry.status = 'ok'
}

// ---- 清理计划（AG6）：先**算出**要删什么（旧备份 + 备份已不在的孤儿清单），记进 entry（prune_state=planned）；
// 随后先把含该清单的报告持久化（临时文件 → fsync → rename → 目录 fsync），才真正删除。删除之后 fsync 目录，再写终版报告。
// 这样“删了但报告没写”时，盘上已有一份说明删了什么的持久报告；“报告没落地”时一个文件都没删。
const SIDECAR_SFX = ['.audit-manifest.json', '.audit-manifest.enc']
const isBackupName = (f) => f.endsWith('.db') || f.endsWith('.db.enc')
/** 目录里最新一份报告中，该行业条目上“清理未完成”（planned / failed）的备份文件名集合；读不出来 ⇒ 空集（宁可不清扫） */
function interruptedPrunes(dir, code) {
  try {
    const latest = fs.readdirSync(dir).filter((f) => /^backup-report-.*\.json$/.test(f)).sort().at(-1)
    if (!latest) return new Set()
    const rep = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'))
    const e = (rep.results || []).find((x) => x.code === code)
    return new Set(e && (e.prune_state === 'planned' || e.prune_state === 'failed') && Array.isArray(e.pruned) ? e.pruned : [])
  } catch { return new Set() }
}
for (const { snap } of pending) {
  const { entry, cfg, dir, base } = snap
  if (entry.status !== 'ok') continue
  const outName = path.basename(entry.file)
  const names = fs.readdirSync(dir)
  const others = names
    .filter((f) => f.startsWith(`${base}_`) && isBackupName(f) && f !== outName)
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  // 裁剪：只处理本脚本命名规则生成的 .db / .db.enc，新文件永远保留，其余按时间保留 keep-1 份
  entry.pruned = others.slice(Math.max(cfg.keep - 1, 0)).map((x) => x.f)
  // 孤儿清单：清单文件还在、对应备份已不在。**只清扫“上一次清理被打断”的**——即该备份名出现在本目录最新报告里 prune_state 为 planned/failed 的 pruned 清单中；
  // 其余孤儿（例如备份已被运维搬到机外、清单留作审计基线）一律不动（清单可以脱离备份被 --against-backup 使用）
  const interrupted = interruptedPrunes(dir, entry.code)
  entry.pruned_orphans = names.filter((f) => {
    if (!f.startsWith(`${base}_`)) return false
    const sfx = SIDECAR_SFX.find((s) => f.endsWith(s))
    if (!sfx) return false
    const backup = f.slice(0, -sfx.length)
    return isBackupName(backup) && !names.includes(backup) && interrupted.has(backup)
  })
  entry.prune_state = entry.pruned.length || entry.pruned_orphans.length ? 'planned' : 'none'
}

// ---- 报告：临时文件 → fsync → rename → 目录 fsync（AG6）。写到用到的每个备份目录；只有整次成功才顺带清理旧报告 ----
const reportBody = (phase) => JSON.stringify({
  script: 'scripts/db-backup.mjs',
  generated_at: new Date().toISOString(),
  stamp,
  report_phase: phase, // pre-prune：清理前已持久化的“将要删除”记录；final：终版
  runtime_mode: mode,
  data_dir: DATA_DIR,
  failed,
  encrypted: !!backupKey,
  consistency_stamp: consistency,
  results
}, null, 2) + '\n'
const sweptDirs = new Set()
const reportFiles = new Set()
// Local backup directories: only reap a temp whose recorded writer has exited.
// PID reuse, EPERM and legacy names are ambiguous, so preserve them for manual inspection.
function abandonedReportTemp(dir, name) {
  const match = /^\.backup-report-.*\.json\.([1-9][0-9]*)\.[a-f0-9]{12}\.tmp$/.exec(name)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false
  try { if (!fs.lstatSync(path.join(dir, name)).isFile()) return false } catch { return false }
  try { process.kill(Number(match[1]), 0); return false } catch (error) { return error.code === 'ESRCH' }
}
/** 写一份报告到 dir；失败（含注入的 throw）⇒ 删掉自己的临时文件、记录失败并返回 false。abort 不经过这里，临时文件会留盘，下次运行清扫 */
function writeReport(dir, phase) {
  const file = path.join(dir, `backup-report-${stamp}.json`)
  const tmpFile = path.join(dir, `.backup-report-${stamp}.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    mkdirDurable(dir)
    if (!sweptDirs.has(dir)) {
      sweptDirs.add(dir)
      for (const f of fs.readdirSync(dir)) if (abandonedReportTemp(dir, f)) fs.rmSync(path.join(dir, f), { force: true }) // 只清理已退出的本机写者遗留物
    }
    writeFileDurable(tmpFile, reportBody(phase), [], 0o666)
    faultPoint('backup.after-report-write-before-rename')
    fs.renameSync(tmpFile, file)
    fsyncDir(dir)
    reportFiles.add(file)
    return true
  } catch (e) {
    fs.rmSync(tmpFile, { force: true })
    console.error(`报告写入失败（${dir}）：${e.message}`)
    failed++
    return false
  }
}

// 1) 清理前：把含“将要删除”清单的报告落盘；落不了 ⇒ 该目录不删任何东西
for (const dir of dirsUsed.keys()) {
  const planned = results.filter((r) => r.prune_state === 'planned' && path.dirname(r.file) === dir)
  if (!planned.length) continue
  if (!writeReport(dir, 'pre-prune')) {
    for (const r of planned) { r.prune_state = 'skipped'; r.pruned = []; r.pruned_orphans = [] }
  }
}
// 2) 删除，然后 fsync 目录；被打断后 pruned 里的名字就是“已删或将删”，下一次运行按 keep 规则继续
for (const entry of results.filter((r) => r.prune_state === 'planned')) {
  const dir = path.dirname(entry.file)
  try {
    for (const f of entry.pruned) {
      fs.unlinkSync(path.join(dir, f))
      for (const sfx of SIDECAR_SFX) fs.rmSync(path.join(dir, `${f}${sfx}`), { force: true }) // 清单随备份一起裁剪
    }
    for (const f of entry.pruned_orphans) fs.rmSync(path.join(dir, f), { force: true })
    faultPoint('backup.after-prune-delete-before-dirsync')
    fsyncDir(dir)
    entry.prune_state = 'done'
  } catch (e) {
    failed++
    entry.prune_state = 'failed'
    entry.prune_error = `${PRUNE_FAILED}: ${e.message}`
  }
}
// 3) 终版报告；整次成功才清理旧报告（删除后同样 fsync 目录）
for (const [dir, keep] of dirsUsed) {
  if (!writeReport(dir, 'final')) continue
  if (!failed) {
    try {
      const old = fs.readdirSync(dir).filter((f) => /^backup-report-.*\.json$/.test(f)).sort().reverse().slice(keep)
      for (const f of old) fs.unlinkSync(path.join(dir, f))
      if (old.length) fsyncDir(dir)
    } catch (e) {
      console.error(`旧报告清理失败（${dir}）：${e.message}`)
    }
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
    `${' '.repeat(16)} 表 ${r.source.tables} / 迁移 ${r.source.migrations ?? '-'} / ${mb}MB / sha256 ${r.sha256.slice(0, 12)}…${r.encrypted ? '（密文，AES-256-GCM）' : ''} ` +
      `｜ 校验 ${r.verification.integrity}、外键 ${r.verification.foreign_key_violations} 违规、结构一致、烟雾 ${r.verification.smoke.table}=${r.verification.smoke.rows} 行 ` +
      `｜ 保留 ${r.kept} 份，清理 ${r.pruned.length} 份`
  )
}
for (const f of reportFiles) console.log(`  报告：${f}`)
console.log(failed ? `备份完成，其中 ${failed} 个失败（旧备份未裁剪）` : '备份完成')

// ---- 告警钩子（ADR-0029）：仅失败时、仅当 GML_ALERT_CHANNEL 指向已存在的通知渠道；成功静默 ----
// 经 notify.js 的发送路径（出站策略在其内部强制）。告警自身失败写 stderr，不改变退出码（失败本来就非零）。
if (failed && process.env.GML_ALERT_CHANNEL) {
  const lookup = (code) => {
    for (const c of codes) {
      const src = dbPathFor(c)
      if (!fs.existsSync(src)) continue
      let adb
      try {
        adb = new Database(src, { timeout: 5000 })
        const channel = getChannel(adb, code)
        if (channel) return { db: adb, channel, close: () => adb.close() }
      } catch (e) {
        console.error(`ALERT_LOOKUP_SKIPPED: ${c} ${e.code || 'ERROR'}`) // 该库打不开/没有 notify_channels 表：记一笔，试下一个库
      }
      try { adb?.close() } catch { /* ignore */ }
    }
    return null
  }
  const alert = await sendBackupAlert({ channelCode: process.env.GML_ALERT_CHANNEL, results, dataDir: DATA_DIR, failed, lookup })
  if (alert.status === 'sent') console.error('ALERT_SENT: 备份失败告警已发送')
  else console.error(`ALERT_NOT_SENT: ${alert.status}${alert.detail ? ` ${alert.detail}` : ''}`)
}
process.exit(failed ? 1 : 0)
