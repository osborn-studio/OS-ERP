/**
 * ============================================================================
 * 文件标识：scripts/db-restore-drill.mjs ｜ 恢复演练：备份文件 → sha256 核对 → 空目录恢复 → 生产迁移 → 真实服务登录 → 探针比对 → RTO/RPO 报告
 * ============================================================================
 * 【职责】把 ADR-0009 的"烟雾恢复"推进到完整链路（ADR-0016，对应审阅 F12 开放项）：
 *   在一个**空的、与线上无关的**目标目录里，用 db-backup.mjs 的备份集真正把服务拉起来并登录，
 *   再用同一套探针（users / products / purchase_orders / receipts 计数、应收未收余额）
 *   对比"直接读备份文件算出的值"与"经已认证 HTTP 接口取到的值"，量出恢复耗时（RTO）与备份年龄（RPO）。
 *
 * 【判据】
 *   · 目标目录必须为空，且不是备份来源的 data_dir、不是调用方 GML_DATA_DIR（DRILL_TARGET_*，退出码 2）；
 *   · 任一备份文件 sha256 与报告不符 ⇒ 一个字节都不复制、退出码 1（RESTORE_SHA256_MISMATCH）；
 *   · 迁移以生产模式跑真实 `scripts/migrate.mjs`（ADR-0009 校验和不一致会在这里拒绝）；
 *   · 服务以生产模式跑真实 `server/index.js`：随机 loopback 端口、随机 JWT 密钥，等 /api/meta/health；
 *   · 账号：`--drill-username` + stdin 密码；备份里没有任何账号且无 bootstrap 标记时，才用现有
 *     bootstrap-admin CLI 在**恢复副本**里建演练管理员（源备份永不改动，users 期望值 +1 并在报告里标明）；
 *   · 任一探针不符 ⇒ PROBE_MISMATCH、退出码 1。报告 `restore-drill-<stamp>.json` 写在目标目录，不含秘密。
 *
 * 【改它要注意什么】探针口径只在 `scripts/lib/drill-common.mjs` 的 PROBES 里改；`--fault=probe-skew`
 *   是唯一的故障注入入口（命令行可见、写进报告、必然失败），用于证明"不符会红"。
 *   tests/restore-drill.test.mjs 用真实子进程跑本脚本。
 * ============================================================================
 */

// 用法：
//   printf '%s\n' "$DRILL_PASSWORD" | node scripts/db-restore-drill.mjs \
//     --backup-dir=/abs/os-egp-data/backups --target-dir=/abs/empty/restore-drill \
//     --drill-username=owner [--industry=cosmetic] [--stamp=yyyyMMdd-HHmmss]
//   node scripts/db-restore-drill.mjs --backup-dir=… --target-dir=…      # 备份里没有账号：自动建演练管理员
// 退出码：0 全部通过；1 校验和/迁移/启动/登录/探针任一失败；2 参数或目标目录被拒绝。
import path from 'node:path'
import {
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, DrillError, INDUSTRY_DB,
  parseArgs, loadBackupSet, prepareTargetDir, verifyAndRestore, runtimeMarkerOf,
  migrateInProduction, startProductionServer, loginClient, sqlProbes, httpProbes,
  bootstrapDrillAdmin, drillPassword, readPasswordFromStdin, writeReport, stampNow, backupAgeSeconds
} from './lib/drill-common.mjs'

const KNOWN = ['backup-dir', 'target-dir', 'stamp', 'drill-username', 'industry', 'fault']
const FAULTS = new Set(['probe-skew'])

const t0 = performance.now()
const since = (from) => Math.round(performance.now() - from)

const report = {
  script: 'scripts/db-restore-drill.mjs',
  generated_at: new Date().toISOString(),
  stamp: stampNow(),
  runtime_mode: 'production',
  passed: false,
  failures: [],
  fault: null,
  backup: null,
  target_dir: null,
  restored: [],
  migrations: null,
  server: null,
  account: null,
  probes: [],
  timing: {}
}

let target = null
let server = null
let exitCode = EXIT_FAILED

try {
  const args = parseArgs(process.argv.slice(2), KNOWN)
  if (!args['backup-dir'] || !args['target-dir']) throw new DrillError('DRILL_USAGE', '必须同时给出 --backup-dir 与 --target-dir（绝对路径）', EXIT_USAGE)
  if (args.fault !== undefined && !FAULTS.has(args.fault)) throw new DrillError('DRILL_USAGE', `不支持的故障注入：${args.fault}`, EXIT_USAGE)
  report.fault = args.fault ?? null

  // ---- 备份集与目标目录：先把"不能动哪里"判清楚，再读密码、再动文件 ----
  const set = loadBackupSet(args['backup-dir'], args.stamp || null)
  const industry = args.industry || set.entries[0].code
  const entry = set.entries.find((e) => e.code === industry)
  if (!entry) throw new DrillError('DRILL_USAGE', `备份集中没有行业 ${industry}（有：${set.entries.map((e) => e.code).join('、')}）`, EXIT_USAGE)
  report.backup = {
    dir: set.dir,
    report: path.basename(set.reportFile),
    stamp: set.stamp,
    generated_at: set.report.generated_at ?? null,
    age_seconds: backupAgeSeconds(set.report),
    runtime_mode: set.report.runtime_mode ?? null,
    data_dir: set.report.data_dir ?? null,
    industries: set.entries.map((e) => e.code)
  }
  target = prepareTargetDir(args['target-dir'], { backupDir: set.dir, sourceDataDir: set.report.data_dir })
  report.target_dir = target

  // 备份必须是生产分类的库：演练以生产模式启动，demo/test 标记的库会被 ADR-0001 的闸门拒绝
  const marker = runtimeMarkerOf(entry.file)
  if (marker !== 'production') throw new DrillError('DRILL_BACKUP_NOT_PRODUCTION', `备份 ${path.basename(entry.file)} 的运行模式标记为 ${marker ?? '缺失'}，恢复演练只接受 production 库`, EXIT_USAGE)

  // 账号来源判定要在动任何文件之前完成：有账号就必须给 --drill-username + stdin 密码
  const backupValues = sqlProbes(entry.file)
  let username = args['drill-username'] || null
  let password = null
  let createdByDrill = false
  if (username) {
    password = await readPasswordFromStdin()
  } else if (backupValues.users === 0) {
    username = `drill_${report.stamp.replace('-', '_')}`
    password = drillPassword()
    createdByDrill = true
  } else {
    throw new DrillError('DRILL_ACCOUNT_REQUIRED', `备份里已有 ${backupValues.users} 个账号：请用 --drill-username=<账号> 并经 stdin 传入密码`, EXIT_USAGE)
  }

  // ---- 1. sha256 核对 + 复制（任一不符不复制） ----
  const tVerify = performance.now()
  try {
    report.restored = verifyAndRestore(set, target)
  } catch (e) {
    if (e.restored) report.restored = e.restored
    throw e
  }
  report.timing.verify_ms = since(tVerify)

  // ---- 2. 生产模式迁移（含校验和核对） ----
  const migrated = migrateInProduction(target, set.entries.map((e) => e.code))
  report.migrations = { status: migrated.status === 0 ? 'ok' : 'failed', exit_code: migrated.status, ms: migrated.ms, output_tail: (migrated.stdout + migrated.stderr).slice(-2000) }
  report.timing.migrate_ms = migrated.ms
  if (migrated.status !== 0) throw new DrillError('DRILL_MIGRATION_FAILED', `生产模式迁移失败（exit ${migrated.status}）`)

  // ---- 3. 演练账号（仅空账号备份）：在恢复副本里建，源备份不动 ----
  if (createdByDrill) {
    bootstrapDrillAdmin(target, { industry, username, password })
  }
  report.account = { username, industry, created_by_drill: createdByDrill }

  // ---- 4. 拉起真实生产服务，等健康检查 ----
  server = await startProductionServer(target)
  report.server = { port: server.port, ready_ms: server.readyMs, health_version: server.health.version ?? null }
  report.timing.server_ready_ms = server.readyMs

  // ---- 5. 登录 + 探针比对 ----
  const tProbe = performance.now()
  const api = await loginClient(server.baseUrl, { username, password, industry })
  password = null
  report.account.user_id = api.user.id
  report.account.role = api.user.role
  const actual = await httpProbes(api)
  report.timing.probe_ms = since(tProbe)
  for (const [name, backupValue] of Object.entries(backupValues)) {
    let expected = backupValue
    let note = null
    if (name === 'users' && createdByDrill && expected !== null) { expected += 1; note = '演练在恢复副本中创建了 1 个管理员' }
    if (report.fault === 'probe-skew' && name === 'users' && expected !== null) { expected += 1000; note = '故障注入 probe-skew：期望值被人为偏移' }
    const match = expected !== null && actual[name] === expected
    report.probes.push({ name, industry, backup_value: backupValue, expected, actual: actual[name], match, note })
    if (!match) report.failures.push(`PROBE_MISMATCH: ${name} 期望 ${expected} 实得 ${actual[name]}`)
  }

  report.passed = report.failures.length === 0
  exitCode = report.passed ? EXIT_OK : EXIT_FAILED
} catch (e) {
  report.failures.push(e instanceof DrillError ? e.message : `DRILL_UNEXPECTED: ${e.message}`)
  exitCode = e instanceof DrillError ? e.exitCode : EXIT_FAILED
  if (e.output) report.server = { ...(report.server || {}), output_tail: e.output }
} finally {
  if (server) await server.stop()
}

report.timing.total_ms = since(t0)
report.timing.rto_ms = report.timing.total_ms

if (exitCode === EXIT_USAGE) {
  // 参数/目标目录被拒绝：不在任何目录留下文件
  console.error(report.failures.join('\n'))
  process.exit(EXIT_USAGE)
}

const file = writeReport(target, 'restore-drill', report)
for (const r of report.restored) console.log(`  ${r.code.padEnd(10)} ${path.basename(r.file)} sha256 ${r.sha256_verified ? '一致' : '不符'}${r.sha256_verified ? ` → ${path.basename(r.restored_as)}` : ''}`)
if (report.migrations) console.log(`  迁移：${report.migrations.status}（${report.migrations.ms}ms）`)
if (report.server?.ready_ms !== undefined) console.log(`  服务：健康检查通过（${report.server.ready_ms}ms，端口 ${report.server.port}）`)
if (report.account) console.log(`  账号：${report.account.username}${report.account.created_by_drill ? '（演练新建于恢复副本）' : ''}`)
for (const p of report.probes) console.log(`  探针 ${p.name.padEnd(16)} 期望 ${p.expected} 实得 ${p.actual} ${p.match ? '✓' : '✗'}`)
console.log(`  RTO（本次恢复总耗时）：${report.timing.total_ms}ms ｜ RPO 指标（备份年龄）：${report.backup?.age_seconds ?? '-'}s（备份 ${report.backup?.generated_at ?? '-'}）`)
if (report.failures.length) console.log(`  失败：\n    ${report.failures.join('\n    ')}`)
console.log(`  报告：${file}`)
console.log(report.passed ? '恢复演练通过' : '恢复演练失败')
process.exit(exitCode)
