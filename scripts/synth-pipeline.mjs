#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/synth-pipeline.mjs ｜ 大库规模演练流水线：生成合成库 → 备份(明文/加密) → 恢复演练 → 索引审计 → 接口压测，输出一份计时 JSON（roadmap-v4 Y10）
 * ============================================================================
 * 【职责】把 Y10 的"演练"变成一条可重复的命令，计时只来自各脚本自己的真实运行，本脚本只负责串联和记录：
 *   ① `synth-data.mjs` 在 `<dir>/data` 生成生产分类合成库；
 *   ② `db-backup.mjs`（明文）与带 `GML_BACKUP_KEY` 的加密备份，各一次；
 *   ③ `db-restore-drill.mjs` 对明文备份和加密备份各演练一次（空目录恢复 → 生产迁移 → 真实服务登录 → 探针比对）；
 *   ④ `explain-audit.mjs` 对生成的库（只读）；
 *   ⑤ `bench-api.mjs`：它只接受 demo/test 分类的库，所以把库**复制**到 `<dir>/bench-copy` 后，仅在**副本**上把 `os_egp_runtime.mode`
 *      改成 `test`（这是整条流水线唯一一次对分类标记的直接写入，对象是一次性副本；原库与备份仍是 production）。
 *      bench-api 起的 test 模式服务启动时会跑 db/boot.js 的演示种子（对该库叠加少量演示数据、另建 food/apparel 演示库），
 *      所以压测前先在副本上预热一遍同一入口并单独计时（`bench_prewarm`）。压测库因此 = 合成数据 + 少量演示叠加，报告里如实标注。
 *   ⑥ 索引审计违规（explain-audit 退出码 1）是演练要找的"发现"，记在报告里，不算流水线失败。
 *
 * 【诚实边界】计时是运行它的这台机器、当时负载下的单次墙钟，不是目标主机（dmserver）结果、不是容量承诺；
 *   报告里记录 loadavg 与主机信息，读数字必须连同这些一起读。合成数据的分布（均匀随机、单行业、单管理员）不代表真实业务。
 *
 * 【安全判据】`--dir` 必须是绝对路径且不存在或为空，且不在仓库 data/ 内；子进程环境白名单（不继承调用方 GML_*），
 *   密钥/密码在内存里随机生成，只经子进程环境或 stdin 传递，不写入报告、不打印。全程不监听公网地址（bench/drill 自己起的服务只绑 127.0.0.1 随机端口）。
 *
 * 【用法】node scripts/synth-pipeline.mjs --dir /abs/new-dir [--skus N --txns N --docs N --seed N] [--iterations 100 --concurrency 4] [--keep]
 *        [--profile large-ci] [--time-budget MINUTES] [--batch-txns N] [--min-free-mb N]   (AB11：large-ci = 10 万 SKU / 100 万流水，分 20 万一批 VACUUM，到时/磁盘不足 → 报告 partial:true 并退出 0)
 *   报告：`<dir>/pipeline-report.json`；退出码：0 全部步骤成功；1 某步骤失败（报告仍写出）；2 用法/安全拒绝。
 *   默认完成后删除 `<dir>`（保留报告到 --out）；加 --keep 保留整个目录以便复查。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { isWithin, writeExclusive } from './lib/safe-path.mjs'
import { verifyInvariants } from './synth-data.mjs'
import { sourceIdentity } from './lib/source-identity.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** AB11：托管 runner（ubuntu，约 14 GB 可用磁盘、6 h 作业上限）的 roadmap 规模。显式 --skus/--txns/--docs 等永远覆盖这里。 */
export const LARGE_CI = { skus: '100000', txns: '1000000', docs: '100000', 'batch-txns': '200000', 'min-free-mb': '3072' }
const PROFILES = { 'large-ci': LARGE_CI }
const usage = (m) => Object.assign(new Error(m), { exitCode: 2 })
const withinRepoData = (p) => isWithin(path.resolve(ROOT, 'data'), p)

export function parseArgs(argv) {
  const o = { dir: null, out: null, keep: false, scale: {}, iterations: 100, concurrency: 4, profile: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') { o.keep = true; continue }
    if (['--dir', '--out', '--skus', '--txns', '--docs', '--seed', '--iterations', '--concurrency', '--profile', '--time-budget', '--batch-txns', '--min-free-mb'].includes(a)) {
      if (argv[i + 1] === undefined) throw usage(`参数 ${a} 缺值`)
      const v = argv[++i]
      if (a === '--dir') o.dir = v
      else if (a === '--out') o.out = v
      else if (a === '--profile') o.profile = v
      else if (a === '--iterations' || a === '--concurrency') o[a.slice(2)] = Number(v)
      else o.scale[a.slice(2)] = v
      continue
    }
    throw usage(`未知参数 ${a}`)
  }
  if (o.profile !== null && !PROFILES[o.profile]) throw usage(`未知 --profile ${o.profile}（可用：${Object.keys(PROFILES).join(', ')}）`)
  if (o.profile) o.scale = { ...PROFILES[o.profile], ...o.scale }
  if (!o.dir || !path.isAbsolute(o.dir)) throw usage('必须给绝对路径 --dir（全新目录）')
  if (withinRepoData(o.dir)) throw usage('--dir 不得位于仓库 data/ 内')
  if (fs.existsSync(o.dir) && fs.readdirSync(o.dir).length) throw usage('--dir 非空')
  // 报告路径在跑任何步骤之前就校验（跑完才发现不能写，等于白跑一小时）
  const reportFile = path.resolve(o.out || path.join(o.dir, 'pipeline-report.json'))
  if (withinRepoData(path.dirname(reportFile)) || withinRepoData(reportFile)) throw usage('报告路径不得位于仓库 data/ 内')
  let exists = true
  try { fs.lstatSync(reportFile) } catch { exists = false }
  if (exists) throw usage('--out 必须是尚不存在的新文件（不覆盖、不跟随符号链接）')
  if (o.out) { try { if (!fs.statSync(path.dirname(reportFile)).isDirectory()) throw new Error('x') } catch { throw usage('--out 的父目录必须已存在') } }
  if (isWithin(o.dir, path.dirname(reportFile)) && o.out) throw usage('--out 不得位于 --dir 之内（--dir 默认会被清理）')
  for (const k of ['iterations', 'concurrency']) if (!Number.isInteger(o[k]) || o[k] < 1) throw usage(`${k} 必须是正整数`)
  return o
}

const cleanEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), TMPDIR: process.env.TMPDIR || os.tmpdir(), ...extra })

function step(name, args, { env, input = undefined, timeout = 3600000 } = {}) {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: cleanEnv(env), input, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 })
  const wall_ms = Math.round(performance.now() - t0)
  process.stderr.write(`[pipeline] ${name}: exit ${r.status} in ${(wall_ms / 1000).toFixed(1)}s\n`)
  return { name, status: r.status, wall_ms, stdout: r.stdout || '', stderr: r.stderr || '' }
}
const newest = (dir, re) => fs.readdirSync(dir).filter((f) => re.test(f)).sort().at(-1)

export async function runPipeline(o) {
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 })
  const dataDir = path.join(o.dir, 'data')
  // Z10: 夜间工作流需要用同一个管理员密码再对压测副本跑写档，所以允许调用方经环境变量提供（≥16 字符）；未提供则随机，行为不变。
  const adminPassword = process.env.GML_PIPELINE_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url')
  if (adminPassword.length < 16) throw usage('GML_PIPELINE_ADMIN_PASSWORD 至少 16 字符')
  const backupKey = crypto.randomBytes(32).toString('base64')
  const prod = { GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dataDir, GML_DB: '', TZ: 'UTC' }
  const report = {
    schema_version: 1,
    scope_notice: 'Local development host / synthetic data / single wall-clock run under whatever load the machine had (see host.loadavg_*). NOT a target-host (dmserver) result and NOT a capacity commitment.',
    source: sourceIdentity(),
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, total_mem_mb: Math.round(os.totalmem() / 1048576), node: process.version, loadavg_start: os.loadavg().map((n) => Math.round(n * 100) / 100) },
    steps: {}, ok: true
  }
  const fail = (name, s) => { report.ok = false; report.steps[name] = { ok: false, status: s.status, wall_ms: s.wall_ms, stderr_tail: s.stderr.slice(-800) } }

  // ① 生成
  const gArgs = ['scripts/synth-data.mjs', '--quiet', '--out', path.join(o.dir, 'synth-summary.json')]
  for (const [k, v] of Object.entries(o.scale)) gArgs.push(`--${k}`, v)
  // 生成步骤的进程超时：给了 --time-budget 就按「预算 + 30 分钟」（VACUUM / 校验收尾），否则默认 1 h；large-ci 无预算时放宽到 5.5 h
  const budget = Number(o.scale['time-budget'] || 0)
  const genTimeout = budget > 0 ? Math.ceil((budget + 30) * 60000) : (o.profile ? 19800000 : 3600000)
  const g = step('generate', gArgs, { env: { ...prod, GML_SYNTH_ADMIN_PASSWORD: adminPassword }, timeout: genTimeout })
  if (g.status !== 0) { fail('generate', g); return report }
  const synth = JSON.parse(fs.readFileSync(path.join(o.dir, 'synth-summary.json'), 'utf8'))
  // AB11：partial = 生成因时间预算 / 磁盘余量提前停止。流水线仍照常对「已达到的规模」跑完后续步骤并以 0 退出，但报告如实标 partial 与 reached。
  report.profile = o.profile
  report.partial = synth.partial === true
  report.partial_reason = synth.partial_reason ?? null
  report.reached = synth.reached ?? null
  report.batching = synth.batching ?? null
  report.dataset = { config: synth.config, plan: synth.plan, counts: synth.counts, table_counts: synth.table_counts, db_bytes: synth.db_bytes, digest: synth.digest, invariants_ok: synth.invariants?.ok ?? null }
  report.steps.generate = { ok: true, wall_ms: g.wall_ms, phase_ms: synth.phase_ms }

  // ② 备份：明文 + 加密
  const backupDir = path.join(dataDir, 'backups')
  const runBackup = (name, extra) => {
    const s = step(name, ['scripts/db-backup.mjs', 'cosmetic'], { env: { ...prod, ...extra } })
    if (s.status !== 0) { fail(name, s); return null }
    const rf = newest(backupDir, /^backup-report-.*\.json$/)
    const rep = JSON.parse(fs.readFileSync(path.join(backupDir, rf), 'utf8'))
    const res = rep.results[0]
    report.steps[name] = { ok: true, wall_ms: s.wall_ms, stamp: rep.stamp, encrypted: rep.encrypted, freeze_ms: rep.consistency_stamp?.freeze_ms ?? null, bytes: res.size ?? res.verification?.size ?? null, status: res.status }
    return rep.stamp
  }
  const plainStamp = runBackup('backup_plain', {})
  if (!plainStamp) return report
  // 备份报告文件名只精确到秒，同秒会互相覆盖：等到下一秒再做加密备份
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const encStamp = runBackup('backup_encrypted', { GML_BACKUP_KEY: backupKey })
  if (!encStamp) return report

  // ③ 恢复演练：明文 / 加密各一次
  const runDrill = (name, stamp, extra) => {
    const target = path.join(o.dir, name)
    const s = step(name, ['scripts/db-restore-drill.mjs', `--backup-dir=${backupDir}`, `--target-dir=${target}`, '--drill-username=synthadmin', '--industry=cosmetic', `--stamp=${stamp}`],
      { env: { ...extra }, input: adminPassword + '\n' })
    const rf = fs.existsSync(target) ? newest(target, /^restore-drill-.*\.json$/) : null
    const rep = rf ? JSON.parse(fs.readFileSync(path.join(target, rf), 'utf8')) : null
    // large-ci：磁盘只有约 14 GB，演练完立刻删掉恢复出来的整库副本
    const cleanup = () => { if (o.profile) fs.rmSync(target, { recursive: true, force: true }) }
    if (s.status !== 0 || !rep?.passed) { fail(name, s); if (rep) report.steps[name].failures = rep.failures; cleanup(); return false }
    report.steps[name] = { ok: true, wall_ms: s.wall_ms, timing_ms: rep.timing, probes: rep.probes.map((p) => ({ name: p.name, expected: p.expected, actual: p.actual, match: p.match })) }
    cleanup()
    return true
  }
  if (!runDrill('restore_drill_plain', plainStamp, {})) return report
  if (!runDrill('restore_drill_encrypted', encStamp, { GML_BACKUP_KEY: backupKey })) return report

  if (o.profile) fs.rmSync(backupDir, { recursive: true, force: true }) // 两次演练都用完备份了；large-ci 释放磁盘

  // ④ 索引审计（只读打开生成的库）
  const ea = step('explain_audit', ['scripts/explain-audit.mjs', '--out', path.join(o.dir, 'explain.json')], { env: { GML_DATA_DIR: dataDir } })
  if (fs.existsSync(path.join(o.dir, 'explain.json'))) {
    const e = JSON.parse(fs.readFileSync(path.join(o.dir, 'explain.json'), 'utf8'))
    // 退出码 1 = 审计发现了违规：这是演练要找的"发现"，记录在报告里，不算流水线失败（2 = 用法/安全拒绝才算）
    report.steps.explain_audit = { ok: ea.status === 0 || ea.status === 1, exit: ea.status, findings: ea.status === 1, wall_ms: ea.wall_ms, statements: e.statements_checked, violations: e.violations.length, unused_allow: e.unused_allow?.length ?? e.unused_allow ?? null, violation_list: e.violations.map((v) => `${v.statement}: ${v.detail} (${v.table}${v.rows != null ? `, ${v.rows} 行` : ''})`) }
    if (ea.status !== 0 && ea.status !== 1) report.ok = false
  } else fail('explain_audit', ea)

  // ⑤ 压测：对一次性副本改分类标记（见文件头）
  const benchDir = path.join(o.dir, 'bench-copy')
  fs.mkdirSync(benchDir, { mode: 0o700 })
  fs.copyFileSync(path.join(dataDir, 'gml_cosmetic.db'), path.join(benchDir, 'gml_cosmetic.db'))
  const bdb = new Database(path.join(benchDir, 'gml_cosmetic.db'))
  bdb.prepare("UPDATE os_egp_runtime SET mode='test' WHERE id=1").run()
  bdb.close()
  // bench-api 起的是 test 模式的 server/index.js，启动时会走 db/boot.js 的 bootAll：对库补跑幂等的演示种子、
  // 并为 food/apparel 另建两份演示库。大库上这要几十秒~两分钟，会撞 bench-api 的 60 s 启动等待；
  // 所以先在副本上单独跑一遍同一个 bootAll 并计时（预热），之后 bench 自己的启动只是空转校验。
  // 副作用必须说清：压测的 cosmetic 库 = 合成数据 + 演示种子的小量叠加（几十个演示经销商/订单量级，相对合成量 <1%）。
  const pre = step('bench_prewarm', ['--input-type=module', '-e', "const { bootAll } = await import('./server/db/boot.js'); bootAll()"],
    { env: { GML_RUNTIME_MODE: 'test', GML_DATA_DIR: benchDir, GML_DB: '' } })
  if (pre.status !== 0) { fail('bench_prewarm', pre); return report }
  // 压测库的真实组成与自洽性单独记录（它 ≠ 上面的合成库：多了演示种子叠加）
  const bdbRead = new Database(path.join(benchDir, 'gml_cosmetic.db'), { readonly: true })
  let benchDataset
  try {
    const tc = {}
    for (const t of ['products', 'product_skus', 'inventory_stocks', 'inventory_transactions', 'purchase_orders', 'sales_orders', 'sales_deliveries', 'dealers', 'credit_ledger', 'doc_events']) tc[t] = bdbRead.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    const v = await verifyInvariants(bdbRead)
    benchDataset = { table_counts: tc, db_bytes: fs.statSync(path.join(benchDir, 'gml_cosmetic.db')).size, invariants_ok: v.ok, failed_checks: v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
      note: 'bench copy = synthetic data + demo-seed overlay applied by the test-mode server boot; classification flipped to test on the copy only' }
  } finally { bdbRead.close() }
  report.steps.bench_prewarm = { ok: true, wall_ms: pre.wall_ms }
  report.bench_dataset = benchDataset
  const benchOut = path.join(o.dir, 'bench.json')
  const b = step('bench_api', ['scripts/bench-api.mjs', '--concurrency', String(o.concurrency), '--iterations', String(o.iterations), '--out', benchOut],
    { env: { GML_RUNTIME_MODE: 'test', GML_DATA_DIR: benchDir, GML_BENCH_USER: 'synthadmin', GML_BENCH_PASSWORD: adminPassword } })
  if (fs.existsSync(benchOut)) {
    const j = JSON.parse(fs.readFileSync(benchOut, 'utf8'))
    report.steps.bench_api = { ok: b.status === 0, exit: b.status, wall_ms: b.wall_ms, config: j.config, totals: j.totals, sqlite_busy_count: j.sqlite_busy_count,
      endpoints: j.endpoints.map((e) => ({ name: e.name, route: e.route, requests: e.requests, errors: e.errors, p50: e.latency_ms.p50, p95: e.latency_ms.p95, p99: e.latency_ms.p99 })) }
    if (b.status !== 0) report.ok = false
  } else fail('bench_api', b)
  report.host.loadavg_end = os.loadavg().map((n) => Math.round(n * 100) / 100)
  return report
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv)
  const report = await runPipeline(o)
  const file = path.resolve(o.out || path.join(o.dir, 'pipeline-report.json'))
  writeExclusive(file, JSON.stringify(report, null, 2) + '\n')
  console.log(`synth-pipeline: ${report.ok ? 'OK' : 'FAILED'} -> ${file}`)
  if (!o.keep && o.out) fs.rmSync(o.dir, { recursive: true, force: true })
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(`synth-pipeline: ${e.message}`); if (!e.exitCode) console.error(e.stack); process.exit(e.exitCode ?? 1) })
}
