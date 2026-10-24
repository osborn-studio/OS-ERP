/**
 * ============================================================================
 * 文件标识：scripts/lib/lock-probe.mjs ｜ SQLite 写锁等待探针：在 worker 线程里反复尝试 BEGIN IMMEDIATE，量出"别的写入者被挡住多久"
 * ============================================================================
 * 【职责】升级演练（AA11，scripts/upgrade-rehearsal.mjs）要回答"一个迁移持有写锁多久"。better-sqlite3 是同步 API，
 *   迁移跑在主线程里会冻住主线程事件循环，所以探针必须在**另一个线程**（worker_threads）里用**自己的连接**探：
 *   每约 1 ms 对同一个库文件执行 `BEGIN IMMEDIATE; COMMIT`（`busy_timeout=0`，拿不到锁立刻 SQLITE_BUSY）。
 *   · 每个"被挡窗口"（一串连续失败）记两个数，**真实持锁时长落在两者之间**（外加线程调度噪声）：
 *     - `max_busy_span_ms`：窗口内**第一次失败到最后一次失败**的间隔 —— 这段时间锁一定被别人持有，所以是持锁时长的**下界**（至多少算两个探测间隔）；
 *     - `max_blocked_ms`：**上一次成功到下一次成功**的间隔 —— 覆盖了整个持锁期，所以是**近似上界**（多算锁前、锁后各一个探测间隔，
 *       高负载下 worker 被调度走时会多得多；被调度走期间的空档也会被算进来）。
 *   · 停止时仍处于被挡状态，则把"停止时刻"当作窗口终点，并在 `still_blocked_at_stop` 标明。
 * 【诚实边界】
 *   · 这是**写入者**视角。WAL 模式下读者不会被写锁挡住，本探针不量读者；非 WAL（回滚日志）库里读者也会被挡，此处同样不量。
 *   · 探测间隔约 1 ms，但 BEGIN/COMMIT 与线程调度会让实际周期更长（机器负载高时可达数 ms 以上）；短于一个探测周期的持锁可能一次都没被撞上
 *     （`busy_attempts=0` 不等于"没持锁"，只表示没撞上）。所以报告里同时给迁移的**总耗时**（迁移期间持有写事务的粗上界）。
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
  const out = { ok_attempts: 0, busy_attempts: 0, other_errors: 0, max_blocked_ms: 0, max_busy_span_ms: 0, blocked_windows: 0, still_blocked_at_stop: false, first_error: null }
  try {
    db = new Database(dbPath, { fileMustExist: true })
    db.pragma('busy_timeout = 0')
    let lastOk = performance.now()
    let blocked = false
    let firstFail = 0
    let lastFail = 0
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
          out.max_busy_span_ms = Math.max(out.max_busy_span_ms, lastFail - firstFail)
          blocked = false
        }
        lastOk = now
      } catch (e) {
        if (isBusy(e)) { const now = performance.now(); out.busy_attempts++; if (!blocked) firstFail = now; lastFail = now; blocked = true } else { out.other_errors++; out.first_error ||= String(e.message).slice(0, 200) }
        try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ }
      }
      Atomics.wait(sleeper, 0, 0, INTERVAL_MS)
    }
    if (blocked) {
      out.still_blocked_at_stop = true
      out.blocked_windows++
      out.max_blocked_ms = Math.max(out.max_blocked_ms, performance.now() - lastOk)
      out.max_busy_span_ms = Math.max(out.max_busy_span_ms, lastFail - firstFail)
    }
  } catch (e) {
    out.other_errors++
    out.first_error ||= String(e.message).slice(0, 200)
    parentPort.postMessage({ ready: true })
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
  out.max_blocked_ms = Math.round(out.max_blocked_ms * 10) / 10
  out.max_busy_span_ms = Math.round(out.max_busy_span_ms * 10) / 10
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
