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
 *          [--profile=read|write] [--concurrency 4] [--iterations 30] [--login-iterations 10] [--out file.json] [--max-error-rate 0.05]
 *          写档专用：[--contender-hold-ms 30] [--contender-gap-ms 20]（0 = 不起外部写者）[--busy-ms N] [--retry-max N]
 * 退出码：0 完成且错误率不超阈值；1 运行失败或错误率超阈值（写档：或完整性校验失败）；2 用法/安全拒绝。
 *
 * 【写档 `--profile=write`】（ADR-0035）并发创建采购单 / 确认收款（带凭证、复核已在隔离副本的设置里关闭）/ 库存调拨(autoShip)，
 *   每个请求带唯一键（写进 remark/serial_no）。注意：**没有幂等键的 HTTP 路由**，脚本也**不会重发失败请求**——
 *   唯一键只用来在结束后核对"成功数 = 库里的行数、没有重复行"。单个 Node 进程的 SQLite 写是同步的，自己不会 BUSY；
 *   所以默认再起一个 worker 线程当"外部写者"周期性占锁（模拟 CLI/备份进程），BUSY 才会出现。报告里分开列出：
 *   服务日志里的 BUSY 行、`write_retry` 行、`write_retry_exhausted` 行、各接口 HTTP 状态分布、完整性核对。
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
import { Worker } from 'node:worker_threads'
import { requireExplicitDataDir, INDUSTRIES } from '../server/db/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_VERSION = 1
const BUSY_RE = /SQLITE_BUSY|database is locked/i
const RETRY_RE = /\bwrite_retry\b/
const EXHAUSTED_RE = /\bwrite_retry_exhausted\b/

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
  const requests = samples.length // 每次尝试都有一个耗时样本（含超时/网络错误的实际等待时间）
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
  const o = {
    concurrency: 4, iterations: 30, loginIterations: 10, out: null, maxErrorRate: 0.05,
    profile: 'read', contenderHoldMs: 30, contenderGapMs: 20, busyMs: null, retryMax: null
  }
  const map = {
    '--concurrency': 'concurrency', '--iterations': 'iterations', '--login-iterations': 'loginIterations', '--max-error-rate': 'maxErrorRate', '--out': 'out',
    '--profile': 'profile', '--contender-hold-ms': 'contenderHoldMs', '--contender-gap-ms': 'contenderGapMs', '--busy-ms': 'busyMs', '--retry-max': 'retryMax'
  }
  const text = new Set(['out', 'profile'])
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]
    let inline
    const eq = flag.indexOf('=')
    if (flag.startsWith('--') && eq > 0) { inline = flag.slice(eq + 1); flag = flag.slice(0, eq) }
    const key = map[flag]
    if (!key || (inline === undefined && argv[i + 1] === undefined)) throw Object.assign(new Error(`未知或缺值参数 ${argv[i]}`), { usage: true })
    const v = inline !== undefined ? inline : argv[++i]
    o[key] = text.has(key) ? v : Number(v)
  }
  if (!['read', 'write'].includes(o.profile)) throw Object.assign(new Error('profile 只能是 read 或 write'), { usage: true })
  for (const k of ['contenderHoldMs', 'contenderGapMs']) {
    if (!Number.isInteger(o[k]) || o[k] < 0 || o[k] > 5000) throw Object.assign(new Error(`${k} 必须是 0..5000 的整数毫秒`), { usage: true })
  }
  if (o.busyMs !== null && (!Number.isInteger(o.busyMs) || o.busyMs < 0 || o.busyMs > 300000)) throw Object.assign(new Error('busy-ms 必须是 0..300000 的整数'), { usage: true })
  if (o.retryMax !== null && (!Number.isInteger(o.retryMax) || o.retryMax < 1 || o.retryMax > 10)) throw Object.assign(new Error('retry-max 必须是 1..10 的整数'), { usage: true })
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

const phys = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
function withinRepoData(p) {
  const rel = path.relative(phys(path.resolve(ROOT, 'data')), phys(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
/** 输出路径：本体或其父目录解析后不得落在仓库 data/ 内，且目标已存在时不得是符号链接（防 writeFileSync 跟随链接截断库文件） */
function unsafeOutput(file) {
  const abs = path.resolve(file)
  if (withinRepoData(path.dirname(abs)) || withinRepoData(abs)) return true
  try { return fs.lstatSync(abs).isSymbolicLink() } catch { return false }
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
  if (unsafeOutput(outFile)) refuse('输出文件不得位于仓库 data/ 内，也不得是符号链接')
  if (withinRepoData(dataDir)) refuse('GML_DATA_DIR 位于仓库 data/ 之内；请使用 /tmp 下的独立副本')
  for (const f of fs.readdirSync(dataDir)) {
    if (/\.db(-wal|-shm)?$/.test(f) && (fs.lstatSync(path.join(dataDir, f)).isSymbolicLink() || withinRepoData(path.join(dataDir, f)))) refuse(`库文件 ${f} 是符号链接或解析到仓库 data/；请使用真实副本`)
  }

  const port = await freePort()
  const childEnv = {
    PATH: env.PATH, HOME: env.HOME || os.tmpdir(), HOST: '127.0.0.1', PORT: String(port),
    GML_DATA_DIR: dataDir, GML_DB: '', GML_RUNTIME_MODE: mode,
    GML_JWT_SECRET: randomBytes(32).toString('hex'),
    GML_LOGIN_IP_LIMIT: '10000', GML_LOGIN_ACCOUNT_LIMIT: '10000',
    ...(opts.busyMs !== null ? { GML_SQLITE_BUSY_MS: String(opts.busyMs) } : {}),
    ...(opts.retryMax !== null ? { GML_WRITE_RETRY_MAX: String(opts.retryMax) } : {})
  }
  const writePlan = opts.profile === 'write' ? await prepareWrite({ dataDir, industry: env.GML_BENCH_INDUSTRY || 'cosmetic', n: opts.iterations }) : null
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false; let busy = 0; let tail = ''
  const logCounts = { retry: 0, exhausted: 0 }
  // 按流缓冲到完整行再计数：一行被拆在两个 data 块里时不能漏记或误分类
  const partial = { out: '', err: '' }
  const countLine = (line) => {
    if (BUSY_RE.test(line)) busy++
    if (RETRY_RE.test(line)) logCounts.retry++
    if (EXHAUSTED_RE.test(line)) logCounts.exhausted++
  }
  const scanStream = (name) => (d) => {
    const s = d.toString(); tail = (tail + s).slice(-4000)
    const parts = (partial[name] + s).split('\n')
    partial[name] = parts.pop()
    for (const line of parts) countLine(line)
  }
  const flushPartial = () => { for (const k of Object.keys(partial)) { if (partial[k]) countLine(partial[k]); partial[k] = '' } }
  const scanOut = scanStream('out')
  child.stdout.on('data', d => { if (d.toString().includes('服务已启动')) ready = true; scanOut(d) })
  child.stderr.on('data', scanStream('err'))
  const closed = once(child, 'close')
  const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed }
  try {
    for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50))
    if (!ready) refuse(`服务未能启动：${tail.slice(-400)}`, 1)
    const base = `http://127.0.0.1:${port}`
    const call = async (method, route, token, body) => {
      if (child.exitCode !== null) throw Object.assign(new Error('服务子进程已退出，停止发送请求'), { fatal: true })
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
    if (writePlan) {
      const out = await runWriteProfile({ opts, call, token, writePlan, logCounts, getBusy: () => busy, stop: async () => { await stop(); flushPartial() }, mode, creds, outFile })
      return out
    }
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
        const tStart = performance.now()
        try {
          const r = await call(ep.method, ep.route, ep.auth === false ? null : token, ep.body)
          samples.push(r.ms); statuses.push(r.status)
        } catch (e) { if (e.fatal) throw e; samples.push(performance.now() - tStart); errors.network++ }
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
    if (totalErr / Math.max(1, total) > opts.maxErrorRate) refuse(`错误率 ${report.totals.error_rate} 超过阈值 ${opts.maxErrorRate}`, 1)
    return { report, outFile }
  } finally {
    await stop().catch(() => {})
  }
}


// ---------------------------------------------------------------------------
// 写档（ADR-0035）
// ---------------------------------------------------------------------------

/** 服务启动前，在隔离副本上准备夹具：关闭资金复核（证据仍由请求带上）、预建 N 张草稿收款单，选定采购/调拨用的主数据 */
async function prepareWrite({ dataDir, industry, n }) {
  if (!INDUSTRIES[industry]) refuse(`未知行业 ${industry}`)
  const { default: Database } = await import('better-sqlite3')
  const { writeSetting } = await import('../server/lib/settings.js')
  const { createReceipt } = await import('../server/lib/ar.js')
  const dbFile = path.join(dataDir, INDUSTRIES[industry].db)
  if (!fs.existsSync(dbFile)) refuse(`找不到 ${INDUSTRIES[industry].db}`)
  const runId = `bw${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  const db = new Database(dbFile)
  try {
    db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000')
    writeSetting(db, { key: 'funds_review_required', value: '0', reason: 'bench-api write profile (isolated copy)', actor: { id: null, name: 'bench-api' } })
    writeSetting(db, { key: 'funds_evidence_required', value: '1', reason: 'bench-api write profile (isolated copy)', actor: { id: null, name: 'bench-api' } })
    const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()
    const poWh = db.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get()
    const poSku = db.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get()
    const src = db.prepare('SELECT warehouse_id, sku_id, SUM(qty_on_hand) q FROM inventory_stocks GROUP BY 1,2 ORDER BY q DESC LIMIT 1').get()
    const dealer = db.prepare('SELECT id, name FROM dealers ORDER BY id LIMIT 1').get()
    if (!supplier || !poWh || !poSku || !src || !dealer) refuse('种子库缺少供应商/仓库/SKU/库存/经销商，无法跑写档')
    if (src.q < n + 10) refuse(`源仓库存 ${src.q} 不足以做 ${n} 次调拨`)
    const toWh = db.prepare("SELECT id FROM warehouses WHERE status='active' AND id<>? ORDER BY id LIMIT 1").get(src.warehouse_id)
    if (!toWh) refuse('找不到第二个启用仓库')
    const receiptIds = []
    for (let i = 0; i < n; i++) {
      // allocations: [] = 预收款（不挂应收），保证 N 张并发确认互不依赖同一张应收
      const r = createReceipt(db, {
        subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name, amount: 1, allocations: [],
        serialNo: `${runId}-rc-${i}`, remark: `${runId}-rc-${i}`, actor: { id: null, name: 'bench-api' }
      })
      receiptIds.push(r.id)
    }
    const stockBefore = db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').get(src.warehouse_id, src.sku_id).q
    return {
      dbFile, runId, receiptIds, stockBefore,
      supplierId: supplier.id, poWarehouseId: poWh.id, poSkuId: poSku.id,
      fromWarehouseId: src.warehouse_id, toWarehouseId: toWh.id, trSkuId: src.sku_id
    }
  } finally { db.close() }
}

/** Wait at most 10s for the first lock; stop drains the bounded hold/gap and collects final counters. */
export async function startContender({ dbFile, holdMs, gapMs }) {
  if (holdMs === 0) return null
  const stopFlag = new SharedArrayBuffer(4)
  const worker = new Worker(new URL('./lib/bench-contender.mjs', import.meta.url), { workerData: { dbPath: dbFile, holdMs, gapMs, stopFlag } })
  let stats; let failure; let timer
  const exited = new Promise(resolve => worker.once('exit', resolve))
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('bench contender startup timed out')), 10000)
    worker.on('message', message => {
      if (message.ready === true) resolve()
      else stats = message
    })
    worker.on('error', error => { failure = error; reject(error) })
    worker.once('exit', () => reject(new Error('bench contender exited before ready')))
  })
  try { await ready } catch (error) { await worker.terminate(); throw error }
  finally { clearTimeout(timer) }
  return {
    async stop() {
      Atomics.store(new Int32Array(stopFlag), 0, 1)
      const code = await exited
      if (failure) throw failure
      if (code !== 0 || !stats) throw new Error('bench contender exited without statistics')
      return stats
    }
  }
}

async function runWriteProfile({ opts, call, token, writePlan: W, logCounts, getBusy, stop, mode, creds, outFile }) {
  const n = opts.iterations
  const ops = [
    { name: 'purchase_order_create', method: 'POST', route: '/api/purchase/orders', key: (i) => `${W.runId}-po-${i}`,
      body: (k) => ({ supplier_id: W.supplierId, warehouse_id: W.poWarehouseId, items: [{ sku_id: W.poSkuId, qty: 1, price: 10 }], remark: k }) },
    { name: 'receipt_confirm', method: 'POST', route: (i) => `/api/ar/receipts/${W.receiptIds[i]}/confirm`, routeLabel: '/api/ar/receipts/:id/confirm', key: (i) => `${W.runId}-rc-${i}`,
      body: (k) => ({ evidence_ref: k, evidence_note: 'bench-api write profile' }) },
    { name: 'stock_transfer', method: 'POST', route: '/api/inventory/transfers', key: (i) => `${W.runId}-tr-${i}`,
      body: (k) => ({ from_warehouse_id: W.fromWarehouseId, to_warehouse_id: W.toWarehouseId, items: [{ sku_id: W.trSkuId, qty: 1 }], remark: k, autoShip: true }) }
  ]
  const contender = await startContender({ dbFile: W.dbFile, holdMs: opts.contenderHoldMs, gapMs: opts.contenderGapMs })
  const results = []
  const okKeys = { purchase_order_create: [], receipt_confirm: [], stock_transfer: [] }
  const t0 = performance.now()
  let contenderStats = null
  try {
    for (const op of ops) {
      const samples = []; const statuses = []; const errors = { network: 0 }
      await pool(n, opts.concurrency, async (i) => {
        const k = op.key(i)
        const tStart = performance.now()
        try {
          const r = await call(op.method, typeof op.route === 'function' ? op.route(i) : op.route, token, op.body(k))
          samples.push(r.ms); statuses.push(r.status)
          if (r.status < 400) okKeys[op.name].push(k)
        } catch (e) { if (e.fatal) throw e; samples.push(performance.now() - tStart); errors.network++ }
      })
      const sum = summarize(op.name, op.method, op.routeLabel || op.route, samples, statuses, errors)
      results.push(sum)
    }
  } finally {
    if (contender) contenderStats = await contender.stop()
  }
  const wall = (performance.now() - t0) / 1000
  await stop()
  const busyLines = getBusy()

  const integrity = await verifyWrites({ W, okKeys, n })
  const total = results.reduce((a, r) => a + r.requests, 0)
  const totalErr = results.reduce((a, r) => a + r.errors, 0)
  const report = {
    schema_version: SCHEMA_VERSION,
    profile: 'write',
    generated_at: new Date().toISOString(),
    scope_notice: 'Local-host measurement on a demo/test database copy. NOT a target-host (dmserver) result and NOT a capacity commitment. Single server process plus (optionally) one in-process worker thread holding the write lock; real multi-process contention is only approximated.',
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, total_mem_mb: Math.round(os.totalmem() / 1048576), node: process.version },
    config: {
      runtime_mode: mode, concurrency: opts.concurrency, ops_per_type: n, industry: creds.industry,
      contender_hold_ms: opts.contenderHoldMs, contender_gap_ms: opts.contenderGapMs,
      sqlite_busy_ms: opts.busyMs ?? 'server default', write_retry_max: opts.retryMax ?? 'server default'
    },
    operations: results.map(r => ({ ...r, ok: r.requests - r.errors })),
    contention: {
      contender_cycles: contenderStats?.cycles ?? 0,
      contender_begin_failures: contenderStats?.begin_failures ?? 0,
      server_busy_log_lines: busyLines,
      write_retry_log_lines: logCounts.retry,
      write_retry_exhausted_log_lines: logCounts.exhausted
    },
    integrity,
    totals: { requests: total, errors: totalErr, error_rate: total ? r3(totalErr / total) : 0, wall_seconds: r3(wall), throughput_rps: wall ? r3(total / wall) : 0 }
  }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
  console.log(`bench-api[write]: ${total} 请求, 错误 ${totalErr}, BUSY日志行 ${busyLines}, 重试 ${logCounts.retry}, 用尽 ${logCounts.exhausted}, 完整性 ${integrity.ok ? 'OK' : 'FAIL'}, ${report.totals.wall_seconds}s -> ${outFile}`)
  if (!integrity.ok) refuse(`写入完整性核对失败：${JSON.stringify(integrity)}`, 1)
  if (totalErr / Math.max(1, total) > opts.maxErrorRate) refuse(`错误率 ${report.totals.error_rate} 超过阈值 ${opts.maxErrorRate}`, 1)
  return { report, outFile }
}

/** 服务停止后只读核对：成功数 = 库里的行数；唯一键不重复；调拨每张恰好一条 TR_OUT；库存恰好少成功调拨数 */
async function verifyWrites({ W, okKeys, n }) {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(W.dbFile, { readonly: true })
  try {
    const like = (col, table, tag) => db.prepare(`SELECT ${col} AS k FROM ${table} WHERE ${col} LIKE ?`).all(`${W.runId}-${tag}-%`).map(r => r.k)
    const check = (keys, okList) => {
      const counts = new Map(); for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1)
      const okSet = new Set(okList)
      return {
        attempted: n, succeeded: okSet.size, rows: keys.length,
        duplicate_rows: [...counts.values()].filter(c => c > 1).length,
        succeeded_without_row: [...okSet].filter(k => !counts.has(k)).length,
        // 库里有行但客户端没拿到成功：写入已提交而响应是错误/网络失败——违反"失败不留行"，计入完整性失败
        rows_without_success: [...counts.keys()].filter(k => !okSet.has(k)).length
      }
    }
    const po = check(like('remark', 'purchase_orders', 'po'), okKeys.purchase_order_create)
    const trKeys = like('remark', 'stock_transfers', 'tr')
    const tr = check(trKeys, okKeys.stock_transfer)
    const trIds = db.prepare('SELECT id FROM stock_transfers WHERE remark LIKE ?').all(`${W.runId}-tr-%`).map(r => r.id)
    const outs = trIds.length ? db.prepare(`SELECT doc_id, COUNT(*) c FROM inventory_transactions WHERE doc_type='TR_OUT' AND doc_id IN (${trIds.map(() => '?').join(',')}) GROUP BY doc_id`).all(...trIds) : []
    tr.tr_out_per_transfer_exactly_one = outs.length === trIds.length && outs.every(o => o.c === 1)
    const stockNow = db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').get(W.fromWarehouseId, W.trSkuId).q
    tr.stock_delta = Math.round((W.stockBefore - stockNow) * 1e6) / 1e6
    tr.stock_delta_matches_rows = tr.stock_delta === trIds.length
    const rcConfirmed = db.prepare(`SELECT COUNT(*) c FROM receipts WHERE serial_no LIKE ? AND status='confirmed'`).get(`${W.runId}-rc-%`).c
    const rc = { attempted: n, succeeded: new Set(okKeys.receipt_confirm).size, confirmed_rows: rcConfirmed, confirmed_matches_succeeded: rcConfirmed === new Set(okKeys.receipt_confirm).size }
    // rows_without_success 也必须为 0：失败的请求（500/超时）不得留下已提交的行，否则"成功数 = 行数"不成立
    const ok = po.duplicate_rows === 0 && po.succeeded_without_row === 0 && po.rows_without_success === 0 &&
      tr.duplicate_rows === 0 && tr.succeeded_without_row === 0 && tr.rows_without_success === 0 && tr.tr_out_per_transfer_exactly_one && tr.stock_delta_matches_rows &&
      rc.confirmed_matches_succeeded
    return { ok, run_id: W.runId, purchase_order_create: po, receipt_confirm: rc, stock_transfer: tr }
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBench().then(() => process.exit(0), (e) => { if (!e.exitCode) console.error(e); process.exit(e.exitCode ?? 1) })
}
