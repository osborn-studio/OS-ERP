/**
 * ============================================================================
 * 文件标识：scripts/lib/audit-toggle-writer.mjs ｜ 审计写入者子进程与统计辅助：经唯一 INSERT 点 `insertAuditRow` 持续写行，供"开关 vs 写入"压测使用（roadmap-v12 AG4）
 * ============================================================================
 * 【职责】
 *   · 子进程模式（`spawnWriter()` 派生，IPC 通信）：打开 `--data-dir` 下行业库（WAL、`busy_timeout` 与服务一致），按 `steady`（每秒 N 行，等间隔）或
 *     `burst`（每 `burstEveryMs` 一次、每次连写 `burstSize` 行；`burstEveryMs=0` 即不停顿）写 `action=AG4_WRITE` 的行，`entity_id` 为单调序号（用于事后核对"每个确认写入的行都在"）。
 *     单行写失败按 `retries` 重试（每次间隔 10 ms × 次数），**每次失败尝试**都按错误类别计数（`attempt_errors`），重试用尽仍失败的行另计（`lost_rows`，按类别）——这些行**没有**写入，不算丢失已确认数据。
 *     收到 IPC `{type:'stop'}` 后写完当前行，回报 `summary` 并退出。
 *   · 导出辅助：`classifyError`（把错误归成 `SQLITE_BUSY` / `no such table` / `trigger` / 其它码）、`parseFallbackTotal`（从 Prometheus 文本里加总 `os_erp_audit_fts_fallback_total`）、`percentile`。
 * 【诚实边界】写入者是**单个进程、单个连接**，同步 API：一次写等锁期间它整个被冻住，所以"最大写停顿"= 一次 `insertAuditRow`（含重试与退避）的墙钟最大值，包含了等待 `busy_timeout` 的时间。
 *   steady 模式落后于计划时不"补发"积压，只是不再睡眠；实际速率在 summary 里给出。这不是多写者并发，也不是服务内请求路径（没有 HTTP、没有 `audit()` 中间件的"去掉明细重试一次"）。
 * 【改它要注意什么】只在 `GML_RUNTIME_MODE` 不限的任意临时数据目录使用；子进程不读 `GML_DB`、不碰仓库 data/（调用方负责传临时目录）。
 * ============================================================================
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const SELF = fileURLToPath(import.meta.url)
export const WRITER_ACTION = 'AG4_WRITE'

/** 错误 → 类别：`no such table` / `trigger`（消息里有 trigger）优先于 SQLite 错误码，其余用错误码，再无则 `OTHER` */
export function classifyError(e) {
  const msg = String(e?.message ?? '')
  if (/no such table/i.test(msg)) return 'no such table'
  if (/trigger/i.test(msg)) return 'trigger'
  if (/^SQLITE_BUSY/.test(String(e?.code)) || /database is locked/i.test(msg)) return 'SQLITE_BUSY'
  return e?.code ? String(e.code) : 'OTHER'
}

/** Prometheus 文本里 `os_erp_audit_fts_fallback_total{...}` 各序列求和；没有该指标返回 0 */
export function parseFallbackTotal(text) {
  let sum = 0
  for (const line of String(text).split('\n')) {
    const m = /^os_erp_audit_fts_fallback_total(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/.exec(line.trim())
    if (m) sum += Number(m[1])
  }
  return sum
}

export function percentile(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

/** 派生写入者子进程；返回 { ready, stop(): Promise<summary>, child } */
export function spawnWriter({ dataDir, industry = 'cosmetic', mode = 'steady', rate = 100, burstSize = 50, burstEveryMs = 1000, retries = 2, busyMs = 5000, maxRows = 0, env = {} }) {
  const args = [SELF, '--child', '--data-dir', dataDir, '--industry', industry, '--mode', mode, '--rate', String(rate), '--burst-size', String(burstSize),
    '--burst-every-ms', String(burstEveryMs), '--retries', String(retries), '--busy-ms', String(busyMs), '--max-rows', String(maxRows)]
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: dataDir, TMPDIR: dataDir, GML_DB: '', GML_RUNTIME_MODE: 'test', GML_JWT_SECRET: 'w'.repeat(48), ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  let readyRes; let readyRej; let sumRes
  const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej })
  const summary = new Promise((res) => { sumRes = res })
  child.on('message', (m) => { if (m?.type === 'ready') readyRes(); else if (m?.type === 'summary') sumRes(m.summary) })
  child.on('exit', (code, sig) => { readyRej(new Error(`writer exited before ready (code=${code} signal=${sig})`)); sumRes(null) })
  return {
    child, ready,
    async stop() {
      if (child.exitCode === null && child.connected) child.send({ type: 'stop' })
      const s = await summary
      if (child.exitCode === null) await new Promise((res) => child.once('exit', res))
      return s
    }
  }
}

async function childMain() {
  const argv = process.argv.slice(2)
  const get = (n) => argv[argv.indexOf(`--${n}`) + 1]
  const mode = get('mode'); const rate = Number(get('rate')); const burstSize = Number(get('burst-size')); const burstEveryMs = Number(get('burst-every-ms'))
  const retries = Number(get('retries')); const busyMs = Number(get('busy-ms')); const maxRows = Number(get('max-rows'))
  const { default: Database } = await import('better-sqlite3')
  const { insertAuditRow } = await import('../../server/lib/audit-trail.js')
  const file = path.join(get('data-dir'), `gml_${get('industry')}.db`)
  const db = new Database(file, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${busyMs}`)
  let stopping = false
  process.on('message', (m) => { if (m?.type === 'stop') stopping = true })

  const s = { mode, rate, burst_size: burstSize, burst_every_ms: burstEveryMs, retries, busy_timeout_ms: busyMs, attempted: 0, acked: 0, acked_first_seq: null, acked_last_seq: null, retried_rows: 0, retry_attempts: 0,
    attempt_errors: {}, lost_rows: {}, lost_seqs: [], max_write_ms: 0, p50_write_ms: null, p99_write_ms: null, elapsed_ms: 0, achieved_rows_per_s: 0 }
  const durations = []
  let seq = 0
  const t0 = performance.now()
  const writeOne = async () => {
    const mySeq = ++seq
    s.attempted++
    const started = performance.now()
    let ok = false
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const info = insertAuditRow(db, { userId: 1, userName: 'ag4-writer', action: WRITER_ACTION, module: 'audit', entity: 'ag4', entityId: mySeq, detail: { seq: mySeq }, ip: '127.0.0.1' })
        if (info.changes !== 1) throw Object.assign(new Error('insert changed 0 rows'), { code: 'ZERO_ROWS' })
        ok = true
        if (attempt > 0) { s.retried_rows++; s.retry_attempts += attempt }
        break
      } catch (e) {
        const k = classifyError(e)
        s.attempt_errors[k] = (s.attempt_errors[k] ?? 0) + 1
        if (attempt === retries) { s.lost_rows[k] = (s.lost_rows[k] ?? 0) + 1; if (s.lost_seqs.length < 50) s.lost_seqs.push(mySeq); s.retry_attempts += attempt } else await delay(10 * (attempt + 1))
      }
    }
    const ms = performance.now() - started
    durations.push(ms)
    if (ms > s.max_write_ms) s.max_write_ms = ms
    if (ok) { s.acked++; s.acked_first_seq ??= mySeq; s.acked_last_seq = mySeq }
  }
  process.send({ type: 'ready' })
  if (mode === 'steady') {
    const gap = 1000 / rate
    for (let i = 0; !stopping && (!maxRows || i < maxRows); i++) {
      const due = t0 + i * gap
      const wait = due - performance.now()
      await (wait > 1 ? delay(wait) : new Promise((r) => setImmediate(r)))
      if (stopping) break
      await writeOne()
    }
  } else {
    for (let sent = 0; !stopping && (!maxRows || sent < maxRows);) {
      const tb = performance.now()
      for (let i = 0; i < burstSize && !stopping && (!maxRows || sent < maxRows); i++, sent++) { await writeOne(); if (i % 20 === 19) await new Promise((r) => setImmediate(r)) }
      if (burstEveryMs > 0) await delay(Math.max(1, burstEveryMs - (performance.now() - tb)))
      else await new Promise((r) => setImmediate(r))
    }
  }
  s.elapsed_ms = Math.round(performance.now() - t0)
  s.achieved_rows_per_s = Math.round((s.acked / Math.max(1, s.elapsed_ms)) * 1000 * 10) / 10
  s.max_write_ms = Math.round(s.max_write_ms * 10) / 10
  s.p50_write_ms = Math.round(percentile(durations, 50) * 100) / 100
  s.p99_write_ms = Math.round(percentile(durations, 99) * 100) / 100
  db.close()
  process.send({ type: 'summary', summary: s }, () => process.exit(0))
}

if (process.argv[2] === '--child' && process.send) await childMain()
