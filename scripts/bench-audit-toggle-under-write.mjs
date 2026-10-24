#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-audit-toggle-under-write.mjs ｜ 审计写入 vs FTS 开关并发压测：写入者持续经 insertAuditRow 写，同时 K 轮 --disable / --enable（roadmap-v12 AG4，ADR-0054 补充 3）
 * ============================================================================
 * 【职责】AF4 只在读路径上排了竞态；本脚本补上写路径：在**全新临时目录**建库（schema.sql + 全部迁移，FTS 与触发器在位），用 `bench-audit-logs.mjs` 的 `seed()` 预置行，
 *   然后派生一个**写入者子进程**（`scripts/lib/audit-toggle-writer.mjs`：唯一 INSERT 点 `insertAuditRow`，含哈希链，`steady` 每秒 N 行或 `burst` 突发），
 *   与此同时脚本逐轮跑真实子进程 `audit-fts-maintain.mjs --disable` → `--enable`（各自 `--busy-ms`）。结束后对账并报告：
 *   写失败（按类别：SQLITE_BUSY / no such table / trigger / 其它；分"尝试级"与"重试用尽仍失败的行"两种）、写重试数、最大写停顿（含 p50/p99）、每次开关的墙钟与
 *   维护报告（status、elapsed_ms、lock_probe）、以及（可选 `--metrics-url`）运行中服务的 `os_erp_audit_fts_fallback_total` 前后差值。
 *   对账（失败即退出 1）：已确认写入的行数 = 库里 `AG4_WRITE` 行数且序号不重；哈希链 `verifyChain` 完好；最后一次 `--enable` 之后 FTS 索引文档数 = 审计行数、`--integrity-check` 为 ok。
 * 【用法】node scripts/bench-audit-toggle-under-write.mjs [--mode steady|burst] [--rate 200] [--burst-size 50] [--burst-every-ms 1000] [--rounds 5] [--seed-rows 20000]
 *   [--settle-ms 300] [--busy-ms 5000] [--writer-busy-ms 5000] [--retries 2] [--metrics-url http://127.0.0.1:PORT/api/meta/metrics?format=prometheus] [--out result.json]
 *   · `--metrics-url` 需要的 Bearer 令牌只从环境变量 `OS_ERP_BENCH_METRICS_TOKEN` 读（不进命令行）；该服务**不是**本脚本的库的服务，除非你自己指向同一个临时目录——
 *     所以 `fallback_total` 通常只在你另起了一个读同一目录并有检索流量的服务时才有意义；缺省不采集。
 * 【诚实边界】单次运行、单机、合成数据；写入者是**一个进程一个连接**（不是多写者、不经 HTTP / `audit()` 中间件）；steady 速率落后时不补发，实际速率在报告里；
 *   维护脚本每次是新进程（启动、探针线程的开销算在 `wall_ms` 里，`elapsed_ms` 才是 BEGIN→COMMIT）。写入者的 `busy_timeout` 默认 5000 ms，与服务一致；库小（默认 2 万行）时回填很快，
 *   这里测的是**状态机切换窗口**，不是大库回填窗口（那个见 bench-audit-fts-toggle.mjs / capacity-baseline "AE4"）。临时目录结束即删；不碰仓库 data/ 与任何在用库。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { verifyChain } from '../server/lib/audit-chain-verify.js'
import { seed } from './bench-audit-logs.mjs'
import { spawnWriter, parseFallbackTotal, WRITER_ACTION } from './lib/audit-toggle-writer.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const KNOWN = ['mode', 'rate', 'burst-size', 'burst-every-ms', 'rounds', 'seed-rows', 'settle-ms', 'busy-ms', 'writer-busy-ms', 'retries', 'metrics-url', 'out']
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--') || !KNOWN.includes(argv[i].slice(2))) { console.error(`未知参数 ${argv[i]}（可用：${KNOWN.map((k) => `--${k}`).join(' ')}）`); process.exit(2) }
  i++
}
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i < 0) return dflt; if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(`--${name} 缺少值`); process.exit(2) } return argv[i + 1] }
const int = (name, dflt, lo, hi) => { const v = Number(opt(name, String(dflt))); if (!Number.isInteger(v) || v < lo || v > hi) { console.error(`--${name} 必须是 ${lo}..${hi} 的整数`); process.exit(2) } return v }
const mode = opt('mode', 'steady')
if (!['steady', 'burst'].includes(mode)) { console.error('--mode 必须是 steady 或 burst'); process.exit(2) }
const cfg = {
  mode, rate: int('rate', 200, 1, 100000), burstSize: int('burst-size', 50, 1, 100000), burstEveryMs: int('burst-every-ms', 1000, 0, 60000), rounds: int('rounds', 5, 1, 1000),
  seedRows: int('seed-rows', 20000, 0, 2000000), settleMs: int('settle-ms', 300, 0, 60000), busyMs: int('busy-ms', 5000, 0, 300000), writerBusyMs: int('writer-busy-ms', 5000, 0, 300000), retries: int('retries', 2, 0, 20)
}
const metricsUrl = opt('metrics-url', null)
if (metricsUrl && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(metricsUrl)) { console.error('--metrics-url 只接受 loopback 的 http 地址'); process.exit(2) }
const out = opt('out', null)
if (out && !path.isAbsolute(out)) { console.error('--out 必须是绝对路径'); process.exit(2) }

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ag4-bench-'))
const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DB: '', GML_JWT_SECRET: 'b'.repeat(48) }
const dbFile = path.join(dir, 'gml_cosmetic.db')
let step = 0
function maint(action) {
  const file = path.join(dir, `report-${++step}-${action}.json`)
  const args = ['scripts/audit-fts-maintain.mjs', '--data-dir', dir, '--industry', 'cosmetic', `--${action}`, '--out', file, '--busy-ms', String(cfg.busyMs), ...(action === 'enable' || action === 'disable' ? ['--reason', 'AG4 bench'] : [])]
  const t0 = performance.now()
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => {
      let rep = null
      try { rep = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 参数错误等没有报告 */ }
      const lp = rep?.lock_probe
      resolve({ step: `--${action}`, exit: code, status: rep?.status ?? 'no-report', already_in_state: rep?.already_in_state ?? null, wall_ms: Math.round(performance.now() - t0), elapsed_ms: rep?.elapsed_ms ?? null,
        blocked_ms_lower: lp?.max_busy_span_ms ?? null, blocked_ms_upper: lp?.max_blocked_ms ?? null, error: rep?.error ?? (code ? err.slice(0, 200) : null) })
    })
  })
}
const fetchFallback = async () => {
  const r = await fetch(metricsUrl, { headers: process.env.OS_ERP_BENCH_METRICS_TOKEN ? { authorization: `Bearer ${process.env.OS_ERP_BENCH_METRICS_TOKEN}` } : {} })
  if (!r.ok) throw new Error(`metrics HTTP ${r.status}`)
  return parseFallbackTotal(await r.text())
}

const result = { config: cfg, host: { platform: process.platform, node: process.version, load1: Number(os.loadavg()[0].toFixed(1)) }, seed_ms: null, rounds: [], writer: null, fallback_total: null, verify: null, ok: false }
let writer = null
try {
  let db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
  runMigrations(db, { mode: 'test', warn: () => {} })
  result.seed_ms = Math.round(seed(db, cfg.seedRows, mulberry32(20261024)))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  const fb0 = metricsUrl ? await fetchFallback().catch((e) => ({ error: e.message })) : null

  writer = spawnWriter({ dataDir: dir, mode: cfg.mode, rate: cfg.rate, burstSize: cfg.burstSize, burstEveryMs: cfg.burstEveryMs, retries: cfg.retries, busyMs: cfg.writerBusyMs })
  await writer.ready
  await delay(cfg.settleMs)
  for (let r = 1; r <= cfg.rounds; r++) {
    const disable = await maint('disable')
    await delay(cfg.settleMs)
    const enable = await maint('enable')
    await delay(cfg.settleMs)
    result.rounds.push({ round: r, disable, enable })
  }
  result.writer = await writer.stop()
  writer = null

  const fb1 = metricsUrl ? await fetchFallback().catch((e) => ({ error: e.message })) : null
  if (metricsUrl) result.fallback_total = typeof fb0 === 'number' && typeof fb1 === 'number' ? { before: fb0, after: fb1, delta: fb1 - fb0 } : { error: fb0?.error ?? fb1?.error }

  // 对账：最后一轮以 --enable 结束；再跑一次 integrity-check
  const finalCheck = await maint('integrity-check')
  db = new Database(dbFile, { readonly: true })
  const w = result.writer
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  const mine = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT entity_id) d FROM audit_logs WHERE action=?').get(WRITER_ACTION)
  const chain = verifyChain(db)
  let ftsDocs = null
  try { ftsDocs = db.prepare('SELECT COUNT(*) c FROM audit_logs_fts_docsize').get().c } catch (e) { ftsDocs = `unreadable: ${e.message}` }
  db.close()
  result.verify = {
    rows_total: total, seed_rows: cfg.seedRows, writer_acked: w.acked, writer_rows_in_db: mine.c, writer_distinct_seqs: mine.d, chain_ok: chain.ok, chain_rows: chain.rows ?? null,
    fts_indexed_docs: ftsDocs, final_integrity_status: finalCheck.status,
    last_toggle_status: result.rounds.at(-1).enable.status
  }
  const v = result.verify
  v.no_lost_rows = v.writer_rows_in_db === w.acked && v.writer_distinct_seqs === w.acked && total === cfg.seedRows + w.acked
  v.fts_matches_rows = v.fts_indexed_docs === total && v.final_integrity_status === 'ok'
  result.ok = v.no_lost_rows && v.chain_ok && v.fts_matches_rows
} finally {
  if (writer) { try { writer.child.kill('SIGTERM') } catch { /* 已退出 */ } }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`temp dir removed: ${!fs.existsSync(dir)}`)
}
console.log(JSON.stringify(result, null, 2))
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
process.exit(result.ok ? 0 : 1)
