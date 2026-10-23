#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-api.mjs ｜ 容量基线：对隔离 demo/test 库起服务，并发压 10 条关键只读接口，输出固定 schema 的 JSON
 * ============================================================================
 * 【职责】为"试点前要有可重复的基线"提供脚本（roadmap-v2 W11）。数字只代表**运行它的这台机器**，
 *   不是目标主机（dmserver）结果，也不是容量承诺；方法与口径见 docs/implementation/capacity-baseline.md。
 *
 * 【安全判据】
 *   ① 必须显式给绝对 `GML_DATA_DIR`，且经 `requireExplicitDataDir()` 判定不是仓库 data/；否则退出码 2，不启动任何东西。
 *   ② `GML_RUNTIME_MODE` 只接受 demo / test（生产模式拒绝）；服务只绑 127.0.0.1 的随机端口，
 *      端口先探测再释放，且只对**本脚本自己 spawn 的子进程**发请求（子进程提前退出即失败）。
 *   ③ 输出文件不得落在仓库 data/ 内。压测会写库（登录更新 last_login_at、WAL），所以用副本。
 *
 * 【用法】GML_RUNTIME_MODE=demo GML_DATA_DIR=/abs/copy node scripts/bench-api.mjs
 *          [--concurrency 4] [--iterations 30] [--login-iterations 10] [--out file.json] [--max-error-rate 0.05]
 * 退出码：0 完成且错误率不超阈值；1 运行失败或错误率超阈值；2 用法/安全拒绝。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { requireExplicitDataDir } from '../server/db/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_VERSION = 1
const BUSY_RE = /SQLITE_BUSY|database is locked/i

/** 最近秩百分位（nearest-rank）：n 个升序样本，p 分位取第 ceil(p/100*n) 个。空样本返回 null。 */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}
const r3 = (n) => (n === null ? null : Math.round(n * 1000) / 1000)

/** 把一个端点的原始样本（ms）与状态码汇总成固定字段 */
export function summarize(name, method, route, samples, statuses, errors) {
  const sorted = [...samples].sort((a, b) => a - b)
  const requests = samples.length + errors.network
  const histogram = {}
  for (const s of statuses) histogram[s] = (histogram[s] || 0) + 1
  if (errors.network) histogram.network_error = errors.network
  const bad = statuses.filter(s => s >= 400).length + errors.network
  return {
    name, method, route, requests,
    errors: bad,
    error_rate: requests ? r3(bad / requests) : 0,
    status_histogram: histogram,
    latency_ms: {
      min: r3(sorted[0] ?? null), p50: r3(percentile(sorted, 50)), p95: r3(percentile(sorted, 95)),
      p99: r3(percentile(sorted, 99)), max: r3(sorted.at(-1) ?? null),
      mean: sorted.length ? r3(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null
    }
  }
}

function parseArgs(argv) {
  const o = { concurrency: 4, iterations: 30, loginIterations: 10, out: null, maxErrorRate: 0.05 }
  const map = { '--concurrency': 'concurrency', '--iterations': 'iterations', '--login-iterations': 'loginIterations', '--max-error-rate': 'maxErrorRate', '--out': 'out' }
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]]
    if (!key || argv[i + 1] === undefined) throw Object.assign(new Error(`未知或缺值参数 ${argv[i]}`), { usage: true })
    const v = argv[++i]
    o[key] = key === 'out' ? v : Number(v)
  }
  for (const k of ['concurrency', 'iterations', 'loginIterations']) {
    if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > 100000) throw Object.assign(new Error(`${k} 必须是 1..100000 的整数`), { usage: true })
  }
  if (!(o.maxErrorRate >= 0 && o.maxErrorRate <= 1)) throw Object.assign(new Error('max-error-rate 必须在 0..1'), { usage: true })
  return o
}

function refuse(message, code = 2) {
  console.error(`bench-api: ${message}`)
  const e = new Error(message); e.exitCode = code; throw e
}

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

function insideRepoData(file) {
  const phys = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const dataDir = phys(path.resolve(ROOT, 'data'))
  const parent = phys(path.dirname(path.resolve(file)))
  const rel = path.relative(dataDir, path.join(parent, path.basename(file)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 并发池：total 个任务，最多 concurrency 个同时在飞 */
async function pool(total, concurrency, task) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) { const i = next++; await task(i) }
  }))
}

export async function runBench(argv = process.argv.slice(2), env = process.env) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { refuse(e.message) }
  let dataDir
  try {
    if (!env.GML_DATA_DIR || !path.isAbsolute(env.GML_DATA_DIR)) refuse('必须显式设置绝对路径 GML_DATA_DIR（隔离副本）')
    dataDir = requireExplicitDataDir(env)
  } catch (e) { if (e.exitCode) throw e; refuse(e.message) }
  const mode = env.GML_RUNTIME_MODE
  if (mode !== 'demo' && mode !== 'test') refuse('GML_RUNTIME_MODE 必须是 demo 或 test（压测只用 demo/test 库）')
  if (!fs.existsSync(dataDir) || !fs.readdirSync(dataDir).some(f => f.endsWith('.db'))) refuse(`GML_DATA_DIR 内没有 .db 种子库：${dataDir}`)
  const outFile = path.resolve(opts.out || path.join(os.tmpdir(), `bench-api-${Date.now()}.json`))
  if (insideRepoData(outFile)) refuse('输出文件不得位于仓库 data/ 内')

  const port = await freePort()
  const childEnv = {
    PATH: env.PATH, HOME: env.HOME || os.tmpdir(), HOST: '127.0.0.1', PORT: String(port),
    GML_DATA_DIR: dataDir, GML_DB: '', GML_RUNTIME_MODE: mode,
    GML_JWT_SECRET: randomBytes(32).toString('hex'),
    GML_LOGIN_IP_LIMIT: '10000', GML_LOGIN_ACCOUNT_LIMIT: '10000'
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false; let busy = 0; let tail = ''
  const scan = (d) => { const s = d.toString(); tail = (tail + s).slice(-4000); for (const line of s.split('\n')) if (BUSY_RE.test(line)) busy++ }
  child.stdout.on('data', d => { if (d.toString().includes('服务已启动')) ready = true; scan(d) })
  child.stderr.on('data', scan)
  const closed = once(child, 'close')
  const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed }
  try {
    for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50))
    if (!ready) refuse(`服务未能启动：${tail.slice(-400)}`, 1)
    const base = `http://127.0.0.1:${port}`
    const call = async (method, route, token, body) => {
      const t0 = performance.now()
      const res = await fetch(base + route, {
        method, signal: AbortSignal.timeout(30000),
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
      const text = await res.text()
      return { ms: performance.now() - t0, status: res.status, text }
    }
    const creds = { username: env.GML_BENCH_USER || 'admin', password: env.GML_BENCH_PASSWORD || '12345', industry: env.GML_BENCH_INDUSTRY || 'cosmetic' }
    const login = await call('POST', '/api/auth/login', null, creds)
    let token
    try { token = JSON.parse(login.text).data.token } catch { /* handled below */ }
    if (login.status !== 200 || !token) refuse(`登录失败（HTTP ${login.status}）；种子库账号需与 GML_BENCH_USER/PASSWORD 一致`, 1)
    const list = await call('GET', '/api/purchase/orders', token)
    const firstId = JSON.parse(list.text)?.data?.list?.[0]?.id
    const now = new Date()
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const endpoints = [
      { name: 'login', method: 'POST', route: '/api/auth/login', body: creds, auth: false, n: opts.loginIterations },
      { name: 'dashboard_summary', method: 'GET', route: '/api/dashboard/summary' },
      { name: 'purchase_order_list', method: 'GET', route: '/api/purchase/orders' },
      { name: 'purchase_order_detail', method: 'GET', route: `/api/purchase/orders/${firstId ?? 1}` },
      { name: 'stock_query', method: 'GET', route: '/api/inventory/stocks' },
      { name: 'receivable_receipt_list', method: 'GET', route: '/api/ar/receipts' },
      { name: 'report_operating', method: 'GET', route: `/api/reports/operating?period=${period}` },
      { name: 'meta_health', method: 'GET', route: '/api/meta/health', auth: false },
      { name: 'order_center_overview', method: 'GET', route: '/api/order-center/overview' },
      { name: 'notify_meta', method: 'GET', route: '/api/notify/meta' }
    ]
    const results = []
    const t0 = performance.now()
    for (const ep of endpoints) {
      const samples = []; const statuses = []; const errors = { network: 0 }
      await pool(ep.n || opts.iterations, opts.concurrency, async () => {
        try {
          const r = await call(ep.method, ep.route, ep.auth === false ? null : token, ep.body)
          samples.push(r.ms); statuses.push(r.status)
        } catch { errors.network++ }
      })
      results.push(summarize(ep.name, ep.method, ep.route, samples, statuses, errors))
    }
    const wall = (performance.now() - t0) / 1000
    await stop()
    const total = results.reduce((a, r) => a + r.requests, 0)
    const totalErr = results.reduce((a, r) => a + r.errors, 0)
    const report = {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      scope_notice: 'Local-host measurement on a demo/test database. NOT a target-host (dmserver) result and NOT a capacity commitment.',
      host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, total_mem_mb: Math.round(os.totalmem() / 1048576), node: process.version },
      config: { runtime_mode: mode, concurrency: opts.concurrency, iterations: opts.iterations, login_iterations: opts.loginIterations, industry: creds.industry },
      endpoints: results,
      totals: { requests: total, errors: totalErr, error_rate: total ? r3(totalErr / total) : 0, wall_seconds: r3(wall), throughput_rps: wall ? r3(total / wall) : 0 },
      sqlite_busy_count: busy
    }
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
    console.log(`bench-api: ${total} 请求, 错误率 ${report.totals.error_rate}, SQLITE_BUSY ${busy}, ${report.totals.wall_seconds}s -> ${outFile}`)
    if (report.totals.error_rate > opts.maxErrorRate) refuse(`错误率 ${report.totals.error_rate} 超过阈值 ${opts.maxErrorRate}`, 1)
    return { report, outFile }
  } finally {
    await stop().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBench().then(() => process.exit(0), (e) => { if (!e.exitCode) console.error(e); process.exit(e.exitCode ?? 1) })
}
