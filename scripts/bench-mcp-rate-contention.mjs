#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-mcp-rate-contention.mjs ｜ MCP 限速 db 模式在并发业务写入下的尾延迟与写锁等待基准（AF9，ADR-0056 补充 2）
 * ============================================================================
 * 【职责】在临时目录的 WAL 库里建迁移 073 的表和一张"类 inventory_transactions"的业务表，然后：
 *   · 起 1 个**写者子进程**（合成风格的插入：多行一个事务、带两个索引；可配每事务行数与事务间隔）；
 *   · 同时起 4 个**调用者子进程**，各自在同一个库文件上连续 `consume`（db 模式、额度开到最大、读写交替），持续 `--seconds` 秒（`--pace-ms` > 0 时每次调用后睡这么久，模拟有节奏的调用方；默认 0 = 紧循环最坏情况）；
 *   · 汇总每次 `consume` 的墙钟延迟 p50 / p95 / p99 / max、放行数、`store_unavailable`（fail closed）数、`withWriteRetry` 的重试 / 用尽数，
 *     以及写者的事务数、行数、最长一次事务耗时。
 *   场景：baseline（无写者）/ oltp（1 行一事务、间隔 2 ms）/ bulk（200 行一事务、间隔 20 ms）/ saturating（200 行一事务、不留间隔）。
 * 【用法】node scripts/bench-mcp-rate-contention.mjs [--seconds=8] [--callers=4] [--pace-ms=0] [--scenarios=baseline,oltp,bulk,saturating]
 * 【边界】数字只代表运行它的这台机器与当时的整机负载（输出里带 `loadavg`）；写者是"合成风格"（不是 scripts/synth-data.mjs 的领域函数全流程，
 *   那条路径单位事务更大更慢），不含 HTTP / 鉴权；`synchronous` 取库默认（输出里打印实际值）；不是 dmserver 结果。全部在临时目录，结束即删。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, loadavg, cpus } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const require = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] ?? d
const SCENARIOS = {
  baseline: null,
  oltp: { batch: 1, gapMs: 2 },
  bulk: { batch: 200, gapMs: 20 },
  saturating: { batch: 200, gapMs: 0 }
}

function openDb(file) {
  const db = new Database(file)
  db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=5000')
  return db
}

async function roleWriter(file, seconds, { batch, gapMs }) {
  const db = openDb(file)
  const ins = db.prepare('INSERT INTO bench_inv_tx (sku_id, warehouse_id, qty, doc_no, created_at) VALUES (?,?,?,?,?)')
  const deadline = Date.now() + seconds * 1000
  let txns = 0; let rows = 0; let maxMs = 0; let busy = 0
  while (Date.now() < deadline) {
    const t0 = process.hrtime.bigint()
    try {
      db.transaction(() => { for (let i = 0; i < batch; i++) ins.run(1 + (rows + i) % 500, 1 + (rows + i) % 5, (i % 7) - 3, `SYN-${rows + i}`, '2026-10-01 00:00:00') }).immediate()
      rows += batch; txns++
    } catch { busy++ }
    maxMs = Math.max(maxMs, Number(process.hrtime.bigint() - t0) / 1e6)
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
  }
  db.close()
  process.stdout.write(JSON.stringify({ txns, rows, rows_per_s: +(rows / seconds).toFixed(0), max_txn_ms: +maxMs.toFixed(1), busy_errors: busy }))
}

async function roleCaller(file, seconds, idx, paceMs) {
  const { createMcpRateLimiter } = await import('../server/lib/mcp-rate-limit.js')
  const { writeRetryStats } = await import('../server/lib/tx.js')
  const { histogramSnapshot } = await import('../server/lib/process-counters.js')
  const db = openDb(file)
  const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: 'db', GML_MCP_TOKEN_RPM: '1000000', GML_MCP_WRITE_RPM: '1000000' } })
  const lat = []
  let ok = 0; let closed = 0
  const deadline = Date.now() + seconds * 1000
  for (let i = 0; Date.now() < deadline; i++) {
    const t0 = process.hrtime.bigint()
    const r = l.consume(1 + ((i + idx) % 20), i % 2 ? 'write' : 'read', 'cosmetic', db)
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6)
    if (r.allowed) ok++; else if (r.reason === 'store_unavailable') closed++
    if (paceMs > 0) await new Promise((res) => setTimeout(res, paceMs))
  }
  const sync = db.pragma('synchronous', { simple: true })
  db.close()
  const h = histogramSnapshot().mcp_rate_store_wait_seconds
  process.stdout.write(JSON.stringify({ lat, ok, closed, retry: writeRetryStats(), hist_count: h.count, hist_sum_s: h.sum, synchronous: sync }))
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
function child(role, file, seconds, extra = []) {
  const c = spawn(process.execPath, [SELF, `--role=${role}`, `--file=${file}`, `--seconds=${seconds}`, ...extra], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  c.stdout.on('data', (d) => { out += d })
  return once(c, 'close').then(([code]) => { if (code !== 0) throw new Error(`${role} exited ${code}`); return JSON.parse(out) })
}

async function main() {
  const seconds = Number(arg('seconds', 8))
  const callers = Number(arg('callers', 4))
  const pace = Number(arg('pace-ms', 0))
  const names = arg('scenarios', Object.keys(SCENARIOS).join(',')).split(',')
  const load0 = loadavg()
  const rows = []
  let sync = null
  for (const name of names) {
    if (!(name in SCENARIOS)) throw new Error(`unknown scenario ${name}`)
    const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-bench-rate-cont-'))
    try {
      const file = path.join(dir, 'b.db')
      const db = openDb(file)
      require('../server/db/migrations/073_mcp_rate_buckets.cjs').up(db)
      db.exec(`CREATE TABLE bench_inv_tx (id INTEGER PRIMARY KEY, sku_id INT, warehouse_id INT, qty INT, doc_no TEXT, created_at TEXT);
               CREATE INDEX idx_bench_inv_sku ON bench_inv_tx(sku_id, warehouse_id); CREATE INDEX idx_bench_inv_doc ON bench_inv_tx(doc_no);`)
      db.close()
      const sc = SCENARIOS[name]
      const jobs = Array.from({ length: callers }, (_, i) => child('caller', file, seconds, [`--idx=${i}`, `--pace=${pace}`]))
      const writer = sc ? child('writer', file, seconds + 1, [`--batch=${sc.batch}`, `--gap=${sc.gapMs}`]) : null
      const res = await Promise.all(jobs)
      const w = writer ? await writer : null
      const lat = res.flatMap((r) => r.lat).sort((a, b) => a - b)
      sync = res[0].synchronous
      rows.push({
        scenario: name, callers, pace_ms: pace, seconds, consumes: lat.length, allowed: res.reduce((a, r) => a + r.ok, 0), fail_closed: res.reduce((a, r) => a + r.closed, 0),
        consumes_per_s: +(lat.length / seconds).toFixed(0),
        p50_ms: +pct(lat, 0.5).toFixed(3), p95_ms: +pct(lat, 0.95).toFixed(3), p99_ms: +pct(lat, 0.99).toFixed(3), max_ms: +lat[lat.length - 1].toFixed(1),
        retries: res.reduce((a, r) => a + r.retry.retries, 0), exhausted: res.reduce((a, r) => a + r.retry.exhausted, 0),
        mean_wait_ms: +((res.reduce((a, r) => a + r.hist_sum_s, 0) / Math.max(1, res.reduce((a, r) => a + r.hist_count, 0))) * 1000).toFixed(3),
        writer: w
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  console.table(rows.map(({ writer, ...r }) => ({ ...r, writer_rows_per_s: writer?.rows_per_s ?? '-', writer_max_txn_ms: writer?.max_txn_ms ?? '-' })))
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, cpus: cpus().length, loadavg_start: load0.map((x) => +x.toFixed(1)), loadavg_end: loadavg().map((x) => +x.toFixed(1)), synchronous_pragma: sync, results: rows }))
}

const role = arg('role', '')
if (role === 'writer') await roleWriter(arg('file'), Number(arg('seconds')), { batch: Number(arg('batch', 1)), gapMs: Number(arg('gap', 0)) })
else if (role === 'caller') await roleCaller(arg('file'), Number(arg('seconds')), Number(arg('idx', 0)), Number(arg('pace', 0)))
else await main()
