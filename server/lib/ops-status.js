/**
 * ============================================================================
 * 文件标识：server/lib/ops-status.js ｜ 运维健康快照：最近备份 / 迁移校验和 / 登录节流存储 / 磁盘 / 库体积（ADR-0029）
 * ============================================================================
 * 【职责】只读地汇总"运维现在该看什么"，给 `GET /api/meta/health`（仅 admin 可见）与 `GET /api/meta/metrics` 用。
 *
 * 【为什么这样设计】
 *   · 备份状态**只读备份目录里最新的 backup-report-*.json**（目录由 `backup-dir.js` 解析，与 db-backup 同一规则）：
 *     不另存一份状态，避免"报告说成功、状态说失败"的两个真相。报告内容不原样透出，只取
 *     at / result / encrypted / age_seconds 四个字段 —— 路径、sha256、库名都留在报告里。
 *   · 每一项独立 try/catch：一项读不出来只让这一项变 null / unavailable，不拖垮其余项，也不抛 500。
 *   · 不写任何东西（login-throttle 只做只读探测；迁移校验和只读 schema_migrations 与迁移文件）。
 *
 * 【改它要注意什么】这里的内容**绝不能**进匿名响应（路由层 `meta.js` 只对 admin 返回）。
 *   新增字段先问：匿名者知道它有什么用？有用就不该加。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { INDUSTRIES } from '../db/index.js'
import { resolveBackupDir } from './backup-dir.js'
import { checkMigrationChecksums } from '../db/migrations/runner.js'

const REPORT_RE = /^backup-report-.*\.json$/

/** 最近一份备份报告 → { at, result, encrypted, age_seconds }；没有报告 result='none'，读不出 result='unreadable' */
export function lastBackupStatus({ db, dataDir, now = Date.now() }) {
  const none = { at: null, result: 'none', encrypted: null, age_seconds: null }
  try {
    let configured = null
    try {
      configured = db.prepare("SELECT value FROM settings WHERE key='backup_dir'").get()?.value || null
    } catch { /* settings 表缺失：用缺省目录 */ }
    const dir = resolveBackupDir(configured, dataDir)
    if (!fs.existsSync(dir)) return none
    const latest = fs.readdirSync(dir).filter((f) => REPORT_RE.test(f)).sort().at(-1)
    if (!latest) return none
    let report
    try {
      report = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'))
    } catch {
      return { ...none, result: 'unreadable' }
    }
    const at = typeof report.generated_at === 'string' ? report.generated_at : null
    const ms = at ? Date.parse(at) : NaN
    return {
      at,
      result: Number(report.failed) === 0 ? 'ok' : 'failed',
      encrypted: report.encrypted === true,
      age_seconds: Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null
    }
  } catch {
    return { ...none, result: 'unreadable' }
  }
}

/** 迁移校验和：mismatched = 内容与登记不符的条数；adopted = 经显式收养登记的条数（需要评审过） */
export function migrationChecksumStatus(db) {
  try {
    const status = checkMigrationChecksums(db)
    const adopted = db.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE checksum_origin='adopted'").get().c
    return { mismatched: status.mismatched.length, adopted }
  } catch {
    return { mismatched: null, adopted: null }
  }
}

/** 登录节流存储是否可用：只读探测，不创建、不写。文件还没生成（尚无人登录）时看目录是否可写。 */
export function loginThrottleStatus({ dataDir }) {
  try {
    const file = path.join(dataDir, 'login-throttle.sqlite')
    if (!fs.existsSync(file)) {
      fs.accessSync(dataDir, fs.constants.W_OK)
      return 'ok'
    }
    const probe = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 })
    try {
      const meta = probe.prepare('SELECT schema_version FROM login_throttle_meta WHERE id=1').get()
      return meta?.schema_version === 1 ? 'ok' : 'unavailable'
    } finally {
      probe.close()
    }
  } catch {
    return 'unavailable'
  }
}

/** 数据目录所在卷的可用字节数；取不到 ⇒ null */
export function diskFreeBytes(dataDir, statfs = fs.statfsSync) {
  try {
    const s = statfs(dataDir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** 各行业库主文件大小（字节），键为行业码；文件不存在 ⇒ null。不含路径。 */
export function dbSizes(dataDir) {
  const out = {}
  for (const [code, info] of Object.entries(INDUSTRIES)) {
    try {
      out[code] = fs.statSync(path.join(dataDir, info.db)).size
    } catch {
      out[code] = null
    }
  }
  return out
}

/** 汇总。`probes` 仅供测试注入（覆盖单项实现）。 */
export function computeOpsStatus({ db, dataDir, now = Date.now(), probes = {} } = {}) {
  return {
    last_backup: (probes.lastBackup || lastBackupStatus)({ db, dataDir, now }),
    migration_checksums: (probes.migrationChecksums || migrationChecksumStatus)(db),
    login_throttle: (probes.loginThrottle || loginThrottleStatus)({ dataDir }),
    disk_free_bytes: (probes.diskFree || diskFreeBytes)(dataDir),
    db_sizes: (probes.dbSizes || dbSizes)(dataDir)
  }
}

/** 给 /api/meta/metrics 的计数器（数值，未知用 -1，便于告警规则统一写 `> x`） */
export function opsCounters(ops) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : -1)
  return {
    backup_age_seconds: n(ops.last_backup.age_seconds),
    backup_last_failed: ops.last_backup.result === 'failed' ? 1 : 0,
    backup_missing: ops.last_backup.result === 'none' ? 1 : 0,
    migration_checksum_mismatches: n(ops.migration_checksums.mismatched),
    migration_checksum_adopted: n(ops.migration_checksums.adopted),
    login_throttle_unavailable: ops.login_throttle === 'ok' ? 0 : 1,
    disk_free_bytes: n(ops.disk_free_bytes)
  }
}

export default { computeOpsStatus, opsCounters, lastBackupStatus, migrationChecksumStatus, loginThrottleStatus, diskFreeBytes, dbSizes }
