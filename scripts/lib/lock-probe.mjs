/**
 * ============================================================================
 * 文件标识：scripts/lib/lock-probe.mjs ｜ SQLite 写锁等待探针：在 worker 线程里反复尝试 BEGIN IMMEDIATE，量出"别的写入者被挡住多久"
 * ============================================================================
 * 【职责】升级演练（AA11，scripts/upgrade-rehearsal.mjs）要回答"一个迁移持有写锁多久"。better-sqlite3 是同步 API，
 *   迁移跑在主线程里会冻住主线程事件循环，所以探针必须在**另一个线程**（worker_threads）里用**自己的连接**探：
 *   每约 1 ms 对同一个库文件执行 `BEGIN IMMEDIATE; COMMIT`（`busy_timeout=0`，拿不到锁立刻 SQLITE_BUSY）。
 *   · `max_blocked_ms`：两次成功拿到写锁之间、期间至少失败过一次的最长间隔 —— 即另一个写入者最坏被挡多久（含 ≤1 ms 的探测间隔误差）。
 *   · 停止时仍处于被挡状态，则把"停止时刻"当作窗口终点，并在 `still_blocked_at_stop` 标明。
 * 【诚实边界】
 *   · 这是**写入者**视角。WAL 模式下读者不会被写锁挡住，本探针不量读者；非 WAL（回滚日志）库里读者也会被挡，此处同样不量。
 *   · 精度约 1–2 ms：短于探测间隔的锁持有可能一次都没被撞上（`busy_attempts=0` 不等于"没持锁"，只表示没撞上）。
 *     所以报告里同时给迁移事务的**总耗时**（迁移期间持有写事务的上界）；锁时间的上界看耗时，下界看这里。
 *   · 探针自己每次 `BEGIN IMMEDIATE; COMMIT` 是空事务，不写任何页，不改库内容。
 * 【改它要注意什么】tests/upgrade-rehearsal.test.mjs 用一个持锁的连接证明探针能量到被挡窗口。
 * ============================================================================
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'

const SELF = fileURLToPath(import.meta.url)
const INTERVAL_MS = 1
const isBusy = (e) => e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED' || /database is locked|SQLITE_BUSY/.test(String(e.message)))

if (!isMainThread && workerData?.lockProbe) {
  const { dbPath, flagBuffer } = workerData
  const flag = new Int32Array(flagBuffer)
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let db = null
  const out = { ok_attempts: 0, busy_attempts: 0, other_errors: 0, max_blocked_ms: 0, blocked_windows: 0, still_blocked_at_stop: false, first_error: null }
  try {
    db = new Database(dbPath, { fileMustExist: true })
    db.pragma('busy_timeout = 0')
    let lastOk = performance.now()
    let blocked = false
    parentPort.postMessage({ ready: true })
    while (Atomics.load(flag, 0) === 0) {
      try {
        db.exec('BEGIN IMMEDIATE')
        db.exec('COMMIT')
        const now = performance.now()
        out.ok_attempts++
        if (blocked) {
          out.blocked_windows++
          out.max_blocked_ms = Math.max(out.max_blocked_ms, now - lastOk)
          blocked = false
        }
        lastOk = now
      } catch (e) {
        if (isBusy(e)) { out.busy_attempts++; blocked = true } else { out.other_errors++; out.first_error ||= String(e.message).slice(0, 200) }
        try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ }
      }
      Atomics.wait(sleeper, 0, 0, INTERVAL_MS)
    }
    if (blocked) {
      out.still_blocked_at_stop = true
      out.blocked_windows++
      out.max_blocked_ms = Math.max(out.max_blocked_ms, performance.now() - lastOk)
    }
  } catch (e) {
    out.other_errors++
    out.first_error ||= String(e.message).slice(0, 200)
    parentPort.postMessage({ ready: true })
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
  out.max_blocked_ms = Math.round(out.max_blocked_ms * 10) / 10
  parentPort.postMessage({ result: out })
}

/** 开始探测；返回 { stop(): Promise<result> }。必须 await 返回值（等 worker 的连接就绪后才返回）。 */
export async function startLockProbe(dbPath) {
  const flagBuffer = new SharedArrayBuffer(4)
  const flag = new Int32Array(flagBuffer)
  const worker = new Worker(SELF, { workerData: { lockProbe: true, dbPath, flagBuffer } })
  let resolveResult
  const resultP = new Promise((resolve, reject) => { resolveResult = resolve; worker.once('error', reject) })
  const ready = new Promise((resolve, reject) => { worker.once('error', reject); worker.on('message', (m) => { if (m.ready) resolve(); if (m.result) resolveResult(m.result) }) })
  await ready
  return {
    async stop() {
      // 给 worker 几个探测周期，让它观察到锁已释放；否则刚释放就停会把窗口多算到停止时刻
      await delay(6)
      Atomics.store(flag, 0, 1)
      const result = await resultP
      await worker.terminate()
      return { ...result, probe_interval_ms: INTERVAL_MS }
    }
  }
}
