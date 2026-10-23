/**
 * ============================================================================
 * 文件标识：scripts/upgrade-rollback-drill.mjs ｜ 升级失败回退演练：备份恢复副本上施加必败迁移 → 证明无半截结构、校验和表完好 → 从备份回退并成功启动
 * ============================================================================
 * 【职责】ADR-0016 的第二条链路（ADR-0009"升级失败后回退到旧备份的实测记录"开放项）：
 *   1. 用备份集在空目录恢复，以生产模式跑真实迁移得到基线（版本表 + sqlite_master 快照）；
 *   2. 在一份**临时迁移目录副本**里追加 `999_drill_failing_upgrade.cjs`（先建表、再写行、然后抛错），
 *      用运行器的 `migrationsDir` 选项以生产模式执行，必须抛出 DRILL_UPGRADE_FAILURE；
 *   3. 不变量：半截表不存在、schema_migrations 行与基线逐字节相同、sqlite_master 不变、
 *      没有登记失败迁移、`checkMigrationChecksums` 无不一致、integrity_check=ok；
 *      另在第二份副本里篡改一个已执行迁移文件，证明 MIGRATION_CHECKSUM_MISMATCH 在动库之前拒绝；
 *   4. 回退：删掉副本库（含 -wal/-shm），从备份重新 sha256 核对并复制，生产迁移通过，真实服务健康检查通过，
 *      探针（users/products/purchase_orders/receipts/应收余额）与备份文件一致。
 *   任一不变量失败 ⇒ 退出码 1；报告 `upgrade-rollback-drill-<stamp>.json` 写在目标目录。
 *
 * 【判据】目标目录规则与 db-restore-drill.mjs 相同（空目录、不是线上目录，退出码 2）。源备份永不改动。
 *   失败迁移只存在于临时目录副本，**绝不**写进 server/db/migrations/。
 *
 * 【改它要注意什么】这里证明的是运行器"单个迁移一个事务"与"校验和先于任何写入"两条契约；
 *   改运行器事务边界会让 no_partial_table / schema_migrations_unchanged 变红——那是预期的红。
 *   tests/upgrade-rollback-drill.test.mjs 用真实子进程跑本脚本。
 * ============================================================================
 */

// 用法：
//   node scripts/upgrade-rollback-drill.mjs --backup-dir=/abs/os-egp-data/backups --target-dir=/abs/empty/upgrade-drill [--stamp=yyyyMMdd-HHmmss]
// 退出码：0 全部不变量成立；1 任一不变量失败或恢复/迁移/启动失败；2 参数或目标目录被拒绝。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations, checkMigrationChecksums, MIGRATIONS_DIR, MIGRATION_CHECKSUM_MISMATCH } from '../server/db/migrations/runner.js'
import {
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, DrillError,
  parseArgs, loadBackupSet, prepareTargetDir, verifyAndRestore, runtimeMarkerOf,
  migrateInProduction, startProductionServer, sqlProbes, writeReport, stampNow, backupAgeSeconds
} from './lib/drill-common.mjs'

const KNOWN = ['backup-dir', 'target-dir', 'stamp']
const FAILING_ID = '999_drill_failing_upgrade'
const FAILING_SOURCE = `// 演练专用：先改结构、再写数据、然后抛错 —— 证明运行器把整条迁移回滚，不留半截
module.exports = {
  name: 'drill failing upgrade (simulated)',
  up(db) {
    db.exec('CREATE TABLE drill_upgrade_partial (id INTEGER PRIMARY KEY, note TEXT)')
    db.prepare('INSERT INTO drill_upgrade_partial (note) VALUES (?)').run('half-applied')
    throw new Error('DRILL_UPGRADE_FAILURE: simulated failure after partial DDL+DML')
  }
}
`

const t0 = performance.now()
const since = (from) => Math.round(performance.now() - from)

const report = {
  script: 'scripts/upgrade-rollback-drill.mjs',
  generated_at: new Date().toISOString(),
  stamp: stampNow(),
  runtime_mode: 'production',
  passed: false,
  failures: [],
  backup: null,
  target_dir: null,
  restored: [],
  baseline: null,
  failed_upgrade: null,
  invariants: [],
  rollback: null,
  timing: {}
}

const invariant = (name, passed, detail, industry = null) => {
  report.invariants.push({ name, industry, passed: !!passed, detail })
  if (!passed) report.failures.push(`INVARIANT_FAILED: ${name}${industry ? `[${industry}]` : ''} — ${detail}`)
}

/** 结构快照：版本表全部行 + sqlite_master（排除 sqlite_ 内部对象） */
function snapshot(db) {
  return {
    migrations: db.prepare('SELECT id, name, checksum, checksum_origin FROM schema_migrations ORDER BY id').all(),
    objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function migrationsCopy(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  return dir
}

let target = null
let server = null
let exitCode = EXIT_FAILED
const tempDirs = []

try {
  const args = parseArgs(process.argv.slice(2), KNOWN)
  if (!args['backup-dir'] || !args['target-dir']) throw new DrillError('DRILL_USAGE', '必须同时给出 --backup-dir 与 --target-dir（绝对路径）', EXIT_USAGE)

  const set = loadBackupSet(args['backup-dir'], args.stamp || null)
  report.backup = {
    dir: set.dir,
    report: path.basename(set.reportFile),
    stamp: set.stamp,
    generated_at: set.report.generated_at ?? null,
    age_seconds: backupAgeSeconds(set.report),
    data_dir: set.report.data_dir ?? null,
    industries: set.entries.map((e) => e.code)
  }
  target = prepareTargetDir(args['target-dir'], { backupDir: set.dir, sourceDataDir: set.report.data_dir })
  report.target_dir = target
  for (const e of set.entries) {
    const marker = runtimeMarkerOf(e.file)
    if (marker !== 'production') throw new DrillError('DRILL_BACKUP_NOT_PRODUCTION', `备份 ${path.basename(e.file)} 的运行模式标记为 ${marker ?? '缺失'}，演练只接受 production 库`, EXIT_USAGE)
  }
  const codes = set.entries.map((e) => e.code)

  // ---- 1. 恢复 + 生产迁移基线 ----
  const tVerify = performance.now()
  try {
    report.restored = verifyAndRestore(set, target)
  } catch (e) {
    if (e.restored) report.restored = e.restored
    throw e
  }
  report.timing.verify_ms = since(tVerify)
  const baseline = migrateInProduction(target, codes)
  report.timing.baseline_migrate_ms = baseline.ms
  report.baseline = { migrations: { status: baseline.status === 0 ? 'ok' : 'failed', exit_code: baseline.status, ms: baseline.ms, output_tail: (baseline.stdout + baseline.stderr).slice(-2000) }, applied_count: null, per_industry: {} }
  if (baseline.status !== 0) throw new DrillError('DRILL_MIGRATION_FAILED', `基线生产迁移失败（exit ${baseline.status}）`)

  // ---- 2 + 3. 必败迁移 与 篡改文件：在每个恢复库上施加，再核不变量 ----
  const failingDir = migrationsCopy('os-egp-drill-failing-')
  tempDirs.push(failingDir)
  fs.writeFileSync(path.join(failingDir, `${FAILING_ID}.cjs`), FAILING_SOURCE)
  const tamperedDir = migrationsCopy('os-egp-drill-tampered-')
  tempDirs.push(tamperedDir)
  const firstApplied = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/.test(f)).sort()[0]
  fs.appendFileSync(path.join(tamperedDir, firstApplied), '\n// drill tamper: unreviewed in-place edit of an applied migration\n')

  const tFail = performance.now()
  report.failed_upgrade = { migration_id: FAILING_ID, threw: false, error: null, per_industry: {} }
  for (const r of report.restored) {
    const db = new Database(r.restored_as)
    db.pragma('foreign_keys = ON')
    try {
      const before = snapshot(db)
      const checksBefore = checkMigrationChecksums(db)
      report.baseline.per_industry[r.code] = { applied: before.migrations.length, objects: before.objects.length, checksums_verified: checksBefore.verified }
      report.baseline.applied_count = before.migrations.length

      let threw = null
      try {
        runMigrations(db, { migrationsDir: failingDir, mode: 'production', warn: () => {} })
      } catch (e) {
        threw = e
      }
      const failedAsExpected = !!threw && /DRILL_UPGRADE_FAILURE/.test(threw.message)
      report.failed_upgrade.threw = failedAsExpected
      report.failed_upgrade.error = threw ? threw.message : null
      report.failed_upgrade.per_industry[r.code] = { threw: failedAsExpected }
      invariant('failing_migration_threw', failedAsExpected, threw ? threw.message : '必败迁移没有抛错', r.code)

      const after = snapshot(db)
      const partial = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='drill_upgrade_partial'").get().n
      invariant('no_partial_table', partial === 0, partial === 0 ? '半截表 drill_upgrade_partial 不存在' : '半截表残留', r.code)
      invariant('schema_migrations_unchanged', same(before.migrations, after.migrations), `版本表 ${before.migrations.length} 行${same(before.migrations, after.migrations) ? '逐字段一致' : '发生变化'}`, r.code)
      invariant('schema_objects_unchanged', same(before.objects, after.objects), `sqlite_master ${before.objects.length} 个对象${same(before.objects, after.objects) ? '不变' : '发生变化'}`, r.code)
      const recordedFailing = db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE id=?').get(FAILING_ID).n
      invariant('no_failed_migration_recorded', recordedFailing === 0, recordedFailing === 0 ? `${FAILING_ID} 未登记` : `${FAILING_ID} 被登记了`, r.code)
      const checks = checkMigrationChecksums(db)
      const intact = checks.mismatched.length === 0 && checks.unrecorded.length === 0 && checks.verified === checksBefore.verified && checks.verified === after.migrations.length
      invariant('checksums_intact', intact, `verified=${checks.verified} mismatched=${checks.mismatched.length} unrecorded=${checks.unrecorded.length} missing=${checks.missing.length}`, r.code)
      const integrity = db.pragma('integrity_check', { simple: true })
      invariant('integrity_ok', integrity === 'ok', `integrity_check=${integrity}`, r.code)

      // 篡改已执行迁移：生产模式必须在任何写入之前拒绝
      let tamperErr = null
      try {
        runMigrations(db, { migrationsDir: tamperedDir, mode: 'production', warn: () => {} })
      } catch (e) {
        tamperErr = e
      }
      const afterTamper = snapshot(db)
      const rejected = tamperErr?.code === MIGRATION_CHECKSUM_MISMATCH && same(after, afterTamper)
      invariant('tampered_file_rejected_before_write', rejected, tamperErr ? `${tamperErr.code}（${(tamperErr.mismatched || []).join(', ')}）；库${same(after, afterTamper) ? '未变' : '被改动'}` : '篡改文件未被拒绝', r.code)
    } finally {
      db.close()
    }
  }
  report.timing.failed_upgrade_ms = since(tFail)

  // ---- 4. 回退：删副本库 → 从备份重新核对复制 → 生产迁移 → 真实服务健康 → 探针与备份一致 ----
  const tRollback = performance.now()
  for (const r of report.restored) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${r.restored_as}${suffix}`, { force: true })
  let rolled = []
  try {
    rolled = verifyAndRestore(set, target)
  } catch (e) {
    if (e.restored) rolled = e.restored
  }
  const shaOk = rolled.length === set.entries.length && rolled.every((x) => x.sha256_verified)
  invariant('rollback_sha256_verified', shaOk, shaOk ? `${rolled.length} 个库从备份重新复制并核对 sha256` : '回退复制时 sha256 不符')
  const rollbackMigrate = migrateInProduction(target, codes)
  invariant('rollback_migrations_ok', rollbackMigrate.status === 0, `exit ${rollbackMigrate.status}（${rollbackMigrate.ms}ms）`)
  report.rollback = { migrations: { status: rollbackMigrate.status === 0 ? 'ok' : 'failed', exit_code: rollbackMigrate.status, ms: rollbackMigrate.ms }, server: null, probes: [] }
  if (shaOk && rollbackMigrate.status === 0) {
    try {
      server = await startProductionServer(target)
      report.rollback.server = { port: server.port, ready_ms: server.readyMs, health_version: server.health.version ?? null }
      invariant('rollback_server_healthy', true, `/api/meta/health 通过（${server.readyMs}ms）`)
    } catch (e) {
      report.rollback.server = { output_tail: e.output ?? null }
      invariant('rollback_server_healthy', false, e.message)
    }
    for (const r of rolled) {
      const expected = sqlProbes(r.file)
      const actual = sqlProbes(r.restored_as)
      const match = same(expected, actual)
      report.rollback.probes.push({ industry: r.code, expected, actual, match })
      invariant('rollback_data_retained', match, match ? `探针与备份文件一致：${JSON.stringify(actual)}` : `探针不符：备份 ${JSON.stringify(expected)} / 回退后 ${JSON.stringify(actual)}`, r.code)
    }
  }
  report.timing.rollback_ms = since(tRollback)

  report.passed = report.failures.length === 0
  exitCode = report.passed ? EXIT_OK : EXIT_FAILED
} catch (e) {
  report.failures.push(e instanceof DrillError ? e.message : `DRILL_UNEXPECTED: ${e.message}`)
  exitCode = e instanceof DrillError ? e.exitCode : EXIT_FAILED
} finally {
  if (server) await server.stop()
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
}
report.timing.total_ms = since(t0)

if (exitCode === EXIT_USAGE) {
  console.error(report.failures.join('\n'))
  process.exit(EXIT_USAGE)
}

const file = writeReport(target, 'upgrade-rollback-drill', report)
for (const r of report.restored) console.log(`  ${r.code.padEnd(10)} ${path.basename(r.file)} sha256 ${r.sha256_verified ? '一致' : '不符'}`)
if (report.baseline) console.log(`  基线迁移：${report.baseline.migrations.status}（已执行 ${report.baseline.applied_count ?? '-'} 个）`)
if (report.failed_upgrade) console.log(`  必败迁移 ${report.failed_upgrade.migration_id}：${report.failed_upgrade.threw ? '按预期抛错' : '未按预期失败'}`)
for (const i of report.invariants) console.log(`  ${i.passed ? '✓' : '✗'} ${i.name}${i.industry ? `[${i.industry}]` : ''} — ${i.detail}`)
console.log(`  耗时：恢复 ${report.timing.verify_ms ?? '-'}ms / 基线迁移 ${report.timing.baseline_migrate_ms ?? '-'}ms / 失败升级 ${report.timing.failed_upgrade_ms ?? '-'}ms / 回退 ${report.timing.rollback_ms ?? '-'}ms / 总 ${report.timing.total_ms}ms`)
if (report.failures.length) console.log(`  失败：\n    ${report.failures.join('\n    ')}`)
console.log(`  报告：${file}`)
console.log(report.passed ? '回退演练通过' : '回退演练失败')
process.exit(exitCode)
