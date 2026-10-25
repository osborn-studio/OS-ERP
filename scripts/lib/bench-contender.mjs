/**
 * ============================================================================
 * 文件标识：scripts/lib/bench-contender.mjs ｜ 压测用的"外部写者"：周期性占住隔离库的写锁（worker_threads，ADR-0035）
 * ============================================================================
 * 【职责】单个 Node 服务进程的 better-sqlite3 是同步的，自己不会和自己争写锁；真实的 SQLITE_BUSY 来自**别的进程**
 *   （CLI 脚本、备份、另一个服务实例）。本 worker 用独立连接循环 `BEGIN IMMEDIATE` → 持有 holdMs → `COMMIT` → 间隔 gapMs，
 *   模拟这类外部写者。**不写任何业务行**（空事务只占锁），所以不会改变被测库的内容。
 * 【输入】workerData: { dbPath, holdMs, gapMs, stopFlag: SharedArrayBuffer(Int32 x1) }；stopFlag[0] 置 1 即停止。
 * 【输出】首次持锁后 postMessage({ ready: true })；结束时 postMessage({ cycles, begin_failures })。
 *   调用方等 ready 再发请求，避免压测先结束而 worker 尚未启动；begin_failures = 自己拿不到锁的次数。
 * 【注意】只对本脚本调用方传入的隔离副本使用；busy_timeout 固定 2000ms，仅用来避免与服务进程死等。
 * ============================================================================
 */
import { workerData, parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'

const { dbPath, holdMs, gapMs, stopFlag } = workerData
const stop = new Int32Array(stopFlag)
const db = new Database(dbPath)
db.pragma('busy_timeout = 2000')
const nap = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
let cycles = 0
let beginFailures = 0
while (Atomics.load(stop, 0) === 0) {
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch {
    beginFailures++
    nap(gapMs)
    continue
  }
  if (cycles === 0) parentPort.postMessage({ ready: true })
  nap(holdMs)
  db.exec('COMMIT')
  cycles++
  nap(gapMs)
}
db.close()
parentPort.postMessage({ cycles, begin_failures: beginFailures })
