/**
 * ============================================================================
 * 文件标识：tests/fixtures/write-contention-worker.mjs ｜ 测试夹具：写并发的独立写进程（ADR-0035）
 * ============================================================================
 * 【职责】被 tests/write-contention.test.mjs 以子进程方式启动：对同一个隔离库文件开自己的连接，
 *   在 `withWriteRetry` 里反复建采购单与调拨单（autoShip），把成功数、失败明细和本进程重试统计以一行 JSON 回报。
 * 【协议】argv[2] = JSON 配置；ready → stdin go → 首次真实 BUSY 后同步回报 busy，等父进程提交并写 releaseFile 后重试。
 * 【注意】只写调用方传入的隔离库；不读仓库 data/。
 * ============================================================================
 */
import Database from 'better-sqlite3'
import readline from 'node:readline'
import { existsSync, writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { sqliteBusyMs } from '../../server/db/index.js'
import { withWriteRetry, writeRetryStats } from '../../server/lib/tx.js'
import { createPurchaseOrder } from '../../server/lib/purchase.js'
import { createTransfer } from '../../server/lib/transfer.js'

const cfg = JSON.parse(process.argv[2])
const db = new Database(cfg.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma(`busy_timeout = ${sqliteBusyMs(process.env)}`)

const failures = []
let okPo = 0
let okTr = 0
let firstBusy = true
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retryOpts = {
  maxAttempts: cfg.maxAttempts, baseDelayMs: cfg.baseDelayMs, maxDelayMs: cfg.maxDelayMs,
  sleep(ms) {
    if (firstBusy) {
      firstBusy = false
      // Synchronous output: the parent must see BUSY while this process waits at the barrier.
      writeSync(1, 'busy\n')
      const deadline = performance.now() + 30000
      while (!existsSync(cfg.releaseFile)) {
        if (performance.now() >= deadline) throw new Error('contention release barrier timed out')
        pause(10)
      }
    }
    pause(ms)
  }
}

function run() {
  for (let i = 0; i < cfg.iterations; i++) {
    const key = `${cfg.runId}-w${cfg.worker}-${i}`
    try {
      withWriteRetry(db, () => createPurchaseOrder(db, {
        supplierId: cfg.supplierId, warehouseId: cfg.poWarehouseId,
        items: [{ sku_id: cfg.poSkuId, qty: 1, price: 10 }],
        remark: `po:${key}`, actor: { id: 1, name: 'contention-test' }
      }), { ...retryOpts, label: 'po.create' })
      okPo++
    } catch (e) { failures.push({ op: 'po', code: e.code ?? null, message: String(e.message).slice(0, 200) }) }
    try {
      withWriteRetry(db, () => createTransfer(db, {
        fromWarehouseId: cfg.fromWarehouseId, toWarehouseId: cfg.toWarehouseId,
        items: [{ sku_id: cfg.trSkuId, qty: 1 }], remark: `tr:${key}`, autoShip: true,
        actor: { id: 1, name: 'contention-test' }
      }), { ...retryOpts, label: 'transfer.create' })
      okTr++
    } catch (e) { failures.push({ op: 'transfer', code: e.code ?? null, message: String(e.message).slice(0, 200) }) }
  }
  db.close()
  // 父进程保持着我们的 stdin 管道，不显式退出就不会结束；等输出刷出再退
  process.stdout.write(JSON.stringify({ result: { worker: cfg.worker, okPo, okTr, failures, stats: writeRetryStats() } }) + '\n', () => process.exit(0))
}

const rl = readline.createInterface({ input: process.stdin })
rl.once('line', (line) => { rl.close(); if (line.trim() === 'go') setTimeout(run, cfg.startDelayMs || 0); else process.exit(3) })
process.stdout.write('ready\n')
