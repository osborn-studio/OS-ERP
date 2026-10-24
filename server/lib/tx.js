/**
 * ============================================================================
 * 文件标识：server/lib/tx.js ｜ 写事务的唯一重试实现：`withWriteRetry`（仅 SQLITE_BUSY/LOCKED，原子，带上限与抖动）
 * ============================================================================
 * 【职责】多个进程（HTTP 服务、CLI 脚本、备份、MCP 子进程）写同一个 SQLite 文件时，写锁争用会让语句抛
 *   `SQLITE_BUSY`（等满 `busy_timeout` 仍拿不到锁，或 WAL 下读事务升级为写事务时快照已过期 `SQLITE_BUSY_SNAPSHOT`——
 *   后者**不会**等待 busy_timeout，立刻失败）。本模块给热点写路径一个统一、可证明安全的重试外壳。
 *
 * 【重试契约】（ADR-0035，改它之前先读）
 *   ① 只重试 better-sqlite3 的 `SqliteError` 且 `code` 属于 SQLITE_BUSY* / SQLITE_LOCKED*。其它一切错误（业务错误、
 *      约束冲突、TypeError、code 字符串碰巧相同但不是 SqliteError 的对象）**一次都不重试**，原样抛出。
 *   ② 原子：每次尝试都在 `db.transaction(fn).immediate()` 里跑——`BEGIN IMMEDIATE` 先拿写锁，fn 里的读写都在锁内，
 *      任何异常（含 COMMIT 阶段的 BUSY）都由 better-sqlite3 ROLLBACK 整个事务后再抛。所以**重试之前，上一次尝试
 *      的所有写入一定已经撤销**；而一旦 COMMIT 成功就立刻 return，**不存在"提交之后再重试"的路径**。
 *      重试因此不会重复施加写入。fn 内部再开的 `db.transaction` 会变成 SAVEPOINT 嵌套，随外层一起回滚。
 *   ③ fn 必须只含数据库操作（可被反复执行）。**不得**在 fn 里做外部副作用（发请求、写文件、发通知、审计之外的
 *      进程内状态），这些放到 withWriteRetry 返回之后。fn 必须同步：async 函数在执行前即被拒绝；返回 Promise 的普通函数
 *      会在返回后被拒绝并回滚（已在事务内的分支同样检查，但此时由外层事务决定是否回滚）。
 *   ④ 已经处在事务里（`db.inTransaction`）时不重试、不嵌套：直接执行 fn 一次，由外层调用方负责原子性与重试。
 *   ⑤ 次数用尽抛出**最后一次的原始错误**，调用方看到的错误与没有包装时一致（只是多等了几轮）。
 *   ⑥ 退避：`min(maxDelayMs, baseDelayMs·2^(attempt-1))`，再乘以 [0.5, 1] 的抖动；等待是同步阻塞
 *      （`Atomics.wait`），与 busy_timeout 本身的阻塞行为一致，不引入异步重入。
 *
 * 【幂等说明】HTTP 路由本身没有幂等键（只有 MCP 工具有 `mcp_idempotency`）。重试的安全性来自上面的②（回滚后才重试），
 *   不依赖幂等键；客户端自己重发请求仍可能产生两张单，这是既有行为，不由本模块改变。
 *
 * 【可观测】每次重试写一行 `write_retry`（warn），用尽写一行 `write_retry_exhausted`；进程内计数见 `writeRetryStats()`。
 * ============================================================================
 */
import Database from 'better-sqlite3'
import { logger } from './logger.js'

const BUSY_CODE = /^SQLITE_(BUSY|LOCKED)(_[A-Z]+)?$/
export const WRITE_RETRY_DEFAULT_MAX = 4
const DEFAULTS = { baseDelayMs: 25, maxDelayMs: 400 }

const stats = { calls: 0, retries: 0, exhausted: 0, non_retryable: 0 }
export function writeRetryStats() { return { ...stats } }
export function resetWriteRetryStats() { for (const k of Object.keys(stats)) stats[k] = 0 }

function optionsError(message) {
  return Object.assign(new Error(message), { code: 'WRITE_RETRY_OPTIONS_INVALID' })
}

/** `GML_WRITE_RETRY_MAX`：总尝试次数（含第一次），1 = 关闭重试；默认 4；非法值抛 `WRITE_RETRY_MAX_INVALID` */
export function writeRetryMaxFromEnv(env = process.env) {
  const raw = env.GML_WRITE_RETRY_MAX
  if (raw === undefined || raw === '') return WRITE_RETRY_DEFAULT_MAX
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10) {
    throw Object.assign(new Error(`GML_WRITE_RETRY_MAX 必须是 1..10 的整数，收到「${String(raw).slice(0, 32)}」`), { code: 'WRITE_RETRY_MAX_INVALID' })
  }
  return Number(raw)
}

/** 唯一的"是并发冲突"判据：必须是 better-sqlite3 的 SqliteError，code 为 BUSY/LOCKED 族 */
export function isBusyError(err) {
  return err instanceof Database.SqliteError && typeof err.code === 'string' && BUSY_CODE.test(err.code)
}

/** 第 attempt 次失败后的等待毫秒（attempt 从 1 起）；random 返回 [0,1) */
export function backoffMs(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceil = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.round(ceil * (0.5 + 0.5 * random()))
}

function blockingSleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 在一个 IMMEDIATE 事务里执行同步的 fn(db)，遇 SQLITE_BUSY/LOCKED 回滚后有上限地重试。契约见文件头。
 * @param {import('better-sqlite3').Database} db
 * @param {(db:object)=>any} fn 只含数据库操作的同步函数（会被整体重跑）
 * @param {{maxAttempts?:number, baseDelayMs?:number, maxDelayMs?:number, label?:string, sleep?:(ms:number)=>void, random?:()=>number}} [opts]
 */
export function withWriteRetry(db, fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? writeRetryMaxFromEnv()
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw optionsError('maxAttempts 必须是 1..10 的整数')
  if (!(baseDelayMs >= 0 && maxDelayMs >= baseDelayMs)) throw optionsError('baseDelayMs/maxDelayMs 不合法')
  const sleep = opts.sleep ?? blockingSleep
  const label = opts.label ?? 'write'
  stats.calls++

  // fn 必须同步：声明为 async 的在执行前就拒绝（否则 await 之后的续体会在事务外自动提交）。
  // 返回 Promise 的普通函数无法事先识别，执行后在下面补一道检查并回滚（此时 await 之前同步部分的写入随事务撤销）。
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('withWriteRetry: fn 必须是同步函数（不能是 async）')
  const sync = (out) => {
    if (out && typeof out.then === 'function') throw new TypeError('withWriteRetry: fn 必须是同步函数（返回了 Promise）')
    return out
  }
  if (db.inTransaction) return sync(fn(db)) // ④

  const atomic = db.transaction(() => sync(fn(db)))
  for (let attempt = 1; ; attempt++) {
    try {
      return atomic.immediate()
    } catch (err) {
      if (db.inTransaction) throw err // 防御：事务状态不干净时绝不重试（better-sqlite3 正常会已回滚）
      if (!isBusyError(err)) { stats.non_retryable++; throw err }
      if (attempt >= maxAttempts) {
        stats.exhausted++
        logger.warn('write_retry_exhausted', { label, attempts: attempt, sqlite_code: err.code })
        throw err
      }
      const delay = backoffMs(attempt, { baseDelayMs, maxDelayMs }, opts.random)
      stats.retries++
      logger.warn('write_retry', { label, attempt, max_attempts: maxAttempts, sqlite_code: err.code, delay_ms: delay })
      sleep(delay)
    }
  }
}

export default { withWriteRetry, isBusyError, backoffMs, writeRetryStats, resetWriteRetryStats, writeRetryMaxFromEnv }
