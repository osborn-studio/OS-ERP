/**
 * ============================================================================
 * 文件标识：server/lib/mcp-rate-limit.js ｜ MCP 按令牌的速率限制与日配额（ADR-0056 / AD9）
 * ============================================================================
 * 【职责】两层限制，都按**验签通过的令牌 id** 计：
 *   ① 滑动窗口速率（60 s）：`GML_MCP_TOKEN_RPM`（全部工具调用，默认 600）与 `GML_MCP_WRITE_RPM`（`level: 'write'` 工具，默认 60）。
 *      写调用同时计入两个额度；被写额度拒绝的调用不占用总额度（先检查、后记账）。
 *   ② 可选日配额：设置键 `mcp_token_daily_quota`（危险键，默认 0 = 关闭），按本地日历日、按令牌统计 `mcp_call_logs` 行数，
 *      过了本地午夜自然归零（无状态，重启不丢）。
 *
 * 【为什么这样设计】
 *   · 键只来自验签后的令牌行（整数 id），不读请求体 / 头 / IP：调用方无法靠换工具名、换 JSON-RPC id、伪造头来换额度；
 *     无效令牌在验签处就被拒，根本到不了这里，因此桶数 ≤ 令牌数。
 *   · 桶表有上限（`createBucketStore`，与 AB10 指标节流同一实现）：满了且无过期可清时 **fail closed**（拒绝新桶，已有桶不受影响）；
 *     令牌 id 不是正整数同样拒绝。
 *   · 滑动窗口用"当前窗口 + 上一窗口按比例折算"的计数器近似：每个桶 O(1) 内存，窗口边界处不会出现 2 倍突发。
 *   · 日配额读库失败 ⇒ fail closed（拒绝并标 `unavailable`），不会因为库出问题而静默放开。
 * 【不持久（memory 模式，默认）】速率桶在进程内存，重启清零（限流不是账务；日配额读审计表，是持久的）。多进程部署各自计数。
 * 【db 模式观测（AF9）】`os_erp_mcp_rate_store_wait_seconds` 直方图记录 db 模式每次 `consume` 的 `withWriteRetry` 墙钟耗时（含等锁与退避重试）；memory 模式不观测。
 *   测试专用旋钮 `GML_TEST_MCP_RATE_WINDOW_MS` / `GML_TEST_MCP_RATE_PURGE_MS` 只在 `GML_RUNTIME_MODE=test` 生效，其它模式设置即启动失败。
 * 【db 模式（AE9，`GML_MCP_RATE_STORE=db`）】桶落在表 `mcp_rate_buckets`（迁移 073），多进程共享、重启不清零：
 *   · 一次放行 = 一个 `withWriteRetry` 的 IMMEDIATE 事务：先读当前 / 上一窗口计数、做与内存模式**同一个**滑动窗口判定，
 *     通过才 `INSERT … ON CONFLICT DO UPDATE SET count=count+1`（总额度与写额度同事务，要么都记要么都不记）。写锁串行化各进程，所以不会超发。
 *   · 被拒绝的调用在判定事务里只读不写；判定**之后**另用一个尽力而为的短事务记一行 `kind='denied'`（AG9，迁移 075；失败只计 `denied_write_failed`，不改 429，见 `recordDenied`）。写失败（锁用尽、表缺失、磁盘错误……）⇒ **fail closed**：拒绝并标 `store_unavailable`，
 *     计数器 `mcp_rate_store_failures_total{reason="write_failed"}` +1，绝不因存储故障放开限流。
 *   · 过期桶由后台定时器调用 `purge(db)` 清理（`server/index.js` 注册），**请求路径从不删除**。清理线是「当前窗口起点 − 2 个窗口」，
 *     比上一窗口还早一整个窗口，所以进程间时钟有 ±1 窗口偏差也不会误删仍在用的桶。
 *   · 取值只认 `memory` / `db`，其它值启动即抛 `MCP_RATE_STORE_INVALID`（拼错的配置不能悄悄退回"各进程各算各的"）。
 *   · 日配额不受影响（本来就读审计表）；进程内的"影子计数"仍是每进程一份，只在审计写失败时兜底。
 * ============================================================================
 */
import { createBucketStore, envInt } from './metrics-throttle.js'
import { withWriteRetry } from './tx.js'
import { incCounter, observeHistogram } from './process-counters.js'
import { logger } from './logger.js'
import { SETTING_RULES, normalizeSettingValue, castSettingValue, readSetting } from './settings.js'

export const DEFAULT_MCP_RATE = Object.freeze({ rpm: 600, writeRpm: 60, windowMs: 60000, maxBuckets: 10000 })
const MAX_RATE = 1_000_000

function makeWindow(limit, now, maxBuckets, W = DEFAULT_MCP_RATE.windowMs) {
  const store = createBucketStore({ maxBuckets, now })
  const roll = (b, t) => {
    const ws = t - (t % W)
    if (b.ws !== ws) {
      b.prev = b.ws === ws - W ? b.cur : 0
      b.cur = 0
      b.ws = ws
    }
    b.expires = ws + 2 * W
  }
  return {
    /** → { bucket } | { full: true } */
    open(key) {
      const t = now()
      const o = store.open(key, () => ({ ws: -1, cur: 0, prev: 0, expires: t + 2 * W }))
      if (o.bucket) roll(o.bucket, t)
      return o
    },
    exceeded(b) {
      const t = now()
      const f = (t % W) / W
      return b.prev * (1 - f) + b.cur + 1 > limit
    },
    record(b) { b.cur += 1 },
    retryAfter() { const t = now(); return Math.min(60, Math.max(1, Math.ceil((W - (t % W)) / 1000))) }
  }
}

/**
 * AF9：仅测试用的旋钮（ADR-0056 补充 2）。`GML_TEST_MCP_RATE_WINDOW_MS`（500..60000）缩短滑动窗口，`GML_TEST_MCP_RATE_PURGE_MS`（100..3600000）缩短清理周期，
 * 让"真实定时器清理"能在几秒内被活的服务进程观测到。只在 `GML_RUNTIME_MODE === 'test'`（精确匹配）时生效；
 * 其它模式（含缺省 = production）只要设置了非空值就**启动即抛** `MCP_RATE_TEST_KNOB_FORBIDDEN`——不静默忽略，免得有人误以为生产里缩短了窗口。
 * 空串视为未设置。取值非法抛 `MCP_RATE_TEST_KNOB_INVALID`（不回退默认，测试里拼错应当立刻暴露）。
 */
const TEST_KNOBS = {
  GML_TEST_MCP_RATE_WINDOW_MS: { min: 500, max: DEFAULT_MCP_RATE.windowMs },
  GML_TEST_MCP_RATE_PURGE_MS: { min: 100, max: 3_600_000 }
}
function testKnob(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (env.GML_RUNTIME_MODE !== 'test') {
    throw Object.assign(new Error(`${name} 只允许在 GML_RUNTIME_MODE=test 下设置（生产/演示模式拒绝）`), { code: 'MCP_RATE_TEST_KNOB_FORBIDDEN' })
  }
  const { min, max } = TEST_KNOBS[name]
  const n = /^[0-9]{1,9}$/.test(String(raw)) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} 必须是 ${min}..${max} 的整数毫秒，收到「${String(raw).slice(0, 32)}」`), { code: 'MCP_RATE_TEST_KNOB_INVALID' })
  }
  return n
}

const STORE_MODES = ['memory', 'db']
export function rateStoreFromEnv(env = process.env) {
  const raw = env.GML_MCP_RATE_STORE
  if (raw === undefined || raw === '') return 'memory'
  if (!STORE_MODES.includes(raw)) {
    throw Object.assign(new Error(`GML_MCP_RATE_STORE 只能是 memory 或 db，收到「${String(raw).slice(0, 32)}」`), { code: 'MCP_RATE_STORE_INVALID' })
  }
  return raw
}

const PURGE_CHUNK = 5000
const PURGE_MAX_CHUNKS = 20
const PURGE_BUSY_MS = 250 // 后台清理最多等这么久的写锁
const DENIED_BUSY_MS = 25 // 拒绝行的尽力写最多等这么久的写锁（拒绝本身已决定，不值得让事件循环久等；Codex 审计 medium：250 ms 太长）
const stmts = new WeakMap() // db → 预编译语句（连接关闭后随连接回收）
function dbStatements(db) {
  let s = stmts.get(db)
  if (!s) {
    s = {
      sel: db.prepare('SELECT window_start AS ws, kind, count FROM mcp_rate_buckets WHERE token_key=? AND window_start IN (?,?) AND kind IN (\'all\',\'write\')'),
      up: db.prepare(`INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,?,1)
                      ON CONFLICT(token_key, window_start, kind) DO UPDATE SET count=count+1`),
      denied: db.prepare(`INSERT INTO mcp_rate_buckets (token_key, window_start, kind, count) VALUES (?,?,'denied',1)
                      ON CONFLICT(token_key, window_start, kind) DO UPDATE SET count=count+1`),
      expired: db.prepare('SELECT 1 FROM mcp_rate_buckets WHERE window_start < ? LIMIT 1'),
      purge: db.prepare(`DELETE FROM mcp_rate_buckets WHERE rowid IN (SELECT rowid FROM mcp_rate_buckets WHERE window_start < ? LIMIT ${PURGE_CHUNK})`)
    }
    stmts.set(db, s)
  }
  return s
}

/** 速率策略（环境变量 + 默认值）。限流器与管理端只读展示（AE11 `/api/mcp/limits`）共用这一处，页面显示的数字就是限流器实际用的数字。 */
export function mcpRatePolicy(env = process.env, override = {}) {
  return {
    store: override.store ?? rateStoreFromEnv(env),
    rpm: override.rpm ?? envInt(env.GML_MCP_TOKEN_RPM, 1, MAX_RATE, DEFAULT_MCP_RATE.rpm),
    writeRpm: override.writeRpm ?? envInt(env.GML_MCP_WRITE_RPM, 1, MAX_RATE, DEFAULT_MCP_RATE.writeRpm),
    windowMs: testKnob(env, 'GML_TEST_MCP_RATE_WINDOW_MS', DEFAULT_MCP_RATE.windowMs),
    purgeMs: testKnob(env, 'GML_TEST_MCP_RATE_PURGE_MS', 60_000),
    maxBuckets: override.maxBuckets ?? DEFAULT_MCP_RATE.maxBuckets
  }
}

export function createMcpRateLimiter({ env = process.env, now = Date.now, ...override } = {}) {
  const policy = mcpRatePolicy(env, override)
  const all = makeWindow(policy.rpm, now, policy.maxBuckets, policy.windowMs)
  const writes = makeWindow(policy.writeRpm, now, policy.maxBuckets, policy.windowMs)
  const shadow = createBucketStore({ maxBuckets: policy.maxBuckets, now })
  const deny = (reason, win) => ({ allowed: false, reason, retryAfter: win.retryAfter() })
  const W = policy.windowMs

  /**
   * 拒绝计数（AG9）：放行判定**已经做完**之后，在独立的短事务里给 kind='denied' 记一行增量。尽力而为——
   * 任何失败（锁忙、旧 CHECK 未迁移、表问题）都只计 `denied_write_failed` 并吞掉，调用方照常返回原来的 429（reason 不变）。
   * 只在 busy_timeout 临时降到 25 ms、不重试：拒绝路径不该因为数一下而在事件循环上久等。判定读取只认 all/write，denied 行永远不参与放行。
   */
  function recordDenied(db, s, key, ws) {
    let prevBusy = null
    try {
      prevBusy = db.pragma('busy_timeout', { simple: true })
      db.pragma(`busy_timeout = ${DENIED_BUSY_MS}`)
      withWriteRetry(db, () => { s.denied.run(key, ws) }, { label: 'mcp_rate_denied', maxAttempts: 1 })
    } catch (e) {
      try { incCounter('mcp_rate_store_failures_total', 'denied_write_failed') } catch { /* 计数器不可用也不影响拒绝 */ }
      try { logger.warn('mcp rate denied-row write failed (best effort; refusal unchanged)', { component: 'mcp', err_code: e?.code ?? '-', err_message: e?.message }) } catch { /* 日志不可用 */ }
    } finally {
      if (prevBusy !== null) { try { db.pragma(`busy_timeout = ${Number(prevBusy) || 0}`) } catch { /* 连接已不可用 */ } }
    }
  }

  /** db 模式的一次额度申请（见文件头）。→ 与内存模式同形；存储失败 ⇒ reason 'store_unavailable' */
  function consumeDb(tokenId, level, scope, db) {
    const key = `${scope}|${tokenId}`
    const t0 = process.hrtime.bigint()
    try {
      if (!db || typeof db.prepare !== 'function') throw new Error('no database handle')
      const s = dbStatements(db)
      // 时刻与窗口必须在拿到写锁**之后**、每次尝试里重新取（Codex 审计 high）：若在事务外取一次并跨重试沿用，
      // 争用跨过分钟边界时会按旧窗口判定与记账，无视新窗口已满，造成超发。
      const { out, retryAfter, ws } = withWriteRetry(db, () => {
        const t = now()
        const ws = t - (t % W)
        const f = (t % W) / W
        const retryAfter = Math.min(60, Math.max(1, Math.ceil((W - (t % W)) / 1000)))
        const cnt = { all: { cur: 0, prev: 0 }, write: { cur: 0, prev: 0 } }
        for (const r of s.sel.all(key, ws, ws - W)) cnt[r.kind][r.ws === ws ? 'cur' : 'prev'] = r.count
        const over = (c, limit) => c.prev * (1 - f) + c.cur + 1 > limit
        const isWrite = level === 'write'
        if (over(cnt.all, policy.rpm)) return { out: 'rpm', retryAfter, ws }
        if (isWrite && over(cnt.write, policy.writeRpm)) return { out: 'write_rpm', retryAfter, ws }
        s.up.run(key, ws, 'all')
        if (isWrite) s.up.run(key, ws, 'write')
        return { out: null, retryAfter, ws }
      }, { label: 'mcp_rate' })
      if (out) {
        recordDenied(db, s, key, ws)
        return { allowed: false, reason: out, retryAfter }
      }
      return { allowed: true }
    } catch (e) {
      incCounter('mcp_rate_store_failures_total', 'write_failed')
      logger.error('mcp rate store write failed; refusing call (fail closed)', { component: 'mcp', outcome: 'store_unavailable', err_code: e?.code ?? '-', err_message: e?.message })
      return { allowed: false, reason: 'store_unavailable', retryAfter: 5 }
    } finally {
      // AF9：整个 withWriteRetry（等写锁 + 退避重试 + 事务体）的墙钟耗时；成功、拒绝、失败都计入。无 label ⇒ 基数固定。
      observeHistogram('mcp_rate_store_wait_seconds', Number(process.hrtime.bigint() - t0) / 1e9)
    }
  }

  return {
    policy,
    /**
     * db 模式清理过期桶（定时器调用；请求路径不调用）。→ { deleted } | { deleted: 0, failed: true } | { deleted: 0, skipped: true }（memory 模式）。永不抛。
     * 删除线 = 当前窗口起点 − 2 个窗口：比"上一窗口"还早一整个窗口，进程间时钟偏差不会让仍在用的桶被误删。分块删除，每块一个短事务。
     */
    purge(db) {
      if (policy.store !== 'db') return { deleted: 0, skipped: true }
      const t = now()
      const cutoff = t - (t % W) - 2 * W
      let deleted = 0
      let prevBusy = null
      try {
        const s = dbStatements(db)
        // 没有过期行就不拿写锁（只读探测，WAL 下不阻塞也不被阻塞）
        if (!s.expired.get(cutoff)) return { deleted: 0 }
        // 清理跑在事件循环上（同步 better-sqlite3）：只等短暂的 busy_timeout、不重试，锁被占着就放弃本轮、下一分钟再来（Codex 审计 medium）。
        prevBusy = db.pragma('busy_timeout', { simple: true })
        db.pragma(`busy_timeout = ${PURGE_BUSY_MS}`)
        for (let i = 0; i < PURGE_MAX_CHUNKS; i++) {
          const n = withWriteRetry(db, () => s.purge.run(cutoff).changes, { label: 'mcp_rate_purge', maxAttempts: 1 })
          deleted += n
          if (n < PURGE_CHUNK) break
        }
        return { deleted }
      } catch (e) {
        incCounter('mcp_rate_store_failures_total', 'purge_failed')
        logger.error('mcp rate bucket purge failed', { component: 'mcp', err_code: e?.code ?? '-', err_message: e?.message })
        return { deleted, failed: true }
      } finally {
        if (prevBusy !== null) { try { db.pragma(`busy_timeout = ${Number(prevBusy) || 0}`) } catch { /* 连接已不可用 */ } }
      }
    },
    /** 一次工具调用的额度申请。→ { allowed: true } | { allowed: false, reason: 'rpm'|'write_rpm'|'unavailable'|'store_unavailable', retryAfter } */
    consume(tokenId, level, scope = '', db = undefined) {
      if (!Number.isSafeInteger(tokenId) || tokenId <= 0 || typeof scope !== 'string' || scope.length > 64) return deny('unavailable', all)
      if (policy.store === 'db') return consumeDb(tokenId, level, scope, db)
      const key = `${scope}|${tokenId}` // 令牌 id 在各行业库里各自从 1 起编，必须带库标识，否则不同行业的同号令牌共用一个桶
      const a = all.open(key)
      if (a.full) return deny('unavailable', all)
      const isWrite = level === 'write'
      const w = isWrite ? writes.open(key) : null
      if (w?.full) return deny('unavailable', writes)
      if (all.exceeded(a.bucket)) return deny('rpm', all)
      if (w && writes.exceeded(w.bucket)) return deny('write_rpm', writes)
      all.record(a.bucket)
      if (w) writes.record(w.bucket)
      return { allowed: true }
    },
    /**
     * 日配额判定（含进程内影子计数）。审计行是权威计数，但"尽力写"的读路径审计写失败时不会推进它——
     * 影子计数记录本进程**已放行**的次数，取两者较大值，审计写失败时配额仍然生效。影子按本地日滚动，桶表同样有上限、满则拒。
     */
    daily(db, tokenId, scope = '') {
      const q = dailyQuotaState(db, tokenId)
      if (!q.allowed || !(q.quota > 0)) return q
      const t = now()
      const d = new Date(t)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const o = shadow.open(`${scope}|${tokenId}`, () => ({ n: 0, expires: midnight }))
      if (o.full) return { allowed: false, reason: 'unavailable', quota: q.quota, used: q.used, retryAfter: 60 }
      const used = Math.max(q.used ?? 0, o.bucket.n)
      if (used >= q.quota) return { allowed: false, reason: 'daily_quota', quota: q.quota, used, retryAfter: secondsToLocalMidnight(d) }
      o.bucket.n = used + 1
      return { ...q, used }
    }
  }
}

/**
 * db 模式下每令牌"近期被限流（429）"的**精确**次数（AF11 引入、AG9 改精确，管理端只读展示用）。→ Map<令牌 id, 次数>。
 * 来源是 `kind='denied'` 行（迁移 075；每次被速率额度拒绝记一次增量），数「当前 + 上一窗口」两个窗口的合计。
 * 仍是尽力而为：拒绝行写失败（锁忙等，见 `recordDenied`）时那一次不会被数到——所以是"精确（除非写失败，失败有 `denied_write_failed` 计数）"。
 * 不含日配额拒绝（那是日历日口径，见 `dailyQuotaByToken`）与 `store_unavailable`（写不进表）。
 * memory 模式、表缺失、读失败 ⇒ 空 Map（展示用，永不抛、不影响限流）。
 */
export function recentLimitedByToken(db, { scope = '', policy = mcpRatePolicy(), now = Date.now } = {}) {
  const out = new Map()
  if (policy.store !== 'db') return out
  try {
    const W = policy.windowMs
    const t = now()
    const ws = t - (t % W)
    const rows = db.prepare("SELECT token_key, SUM(count) n FROM mcp_rate_buckets WHERE kind='denied' AND window_start IN (?,?) GROUP BY token_key").all(ws, ws - W)
    for (const r of rows) {
      if (!r.token_key.startsWith(`${scope}|`)) continue
      const id = Number(r.token_key.slice(scope.length + 1))
      if (!Number.isSafeInteger(id) || id <= 0 || r.token_key !== `${scope}|${id}`) continue
      if (r.n > 0) out.set(id, r.n)
    }
  } catch { /* 展示用统计，读失败按空处理 */ }
  return out
}

/**
 * 在用令牌**今日**日配额用量，按用量降序（AG9，管理端只读展示用）。→ `{ rows:[{id,name,used}], truncated }` | `null`（读失败）。
 * 口径与 `dailyQuotaState` 完全一致（本地日历日、`mcp_call_logs.token_id` 分组、同一个 `created_at >= date('now','localtime')` 谓词）。
 * 「在用」= 行状态 active 且未过期；所有者变更导致的失效（`effective_status`）不在此判（那是令牌列表的事）。
 * **先排序后截断**：用量多的令牌不会因为 id 大而被上限挤掉（Codex 审计）。读失败返回 null 而不是空 / 0——限流在同样的读失败时是 fail closed 的，
 * 展示层若给出"还剩全部额度"会误导运维。注意：限流器还有进程内"影子计数"兜底审计写失败，这里看不到，展示值是审计表口径。
 */
export function dailyQuotaUsage(db, { cap = 500 } = {}) {
  try {
    const rows = db.prepare(`
      SELECT t.id AS id, t.name AS name, COUNT(l.id) AS used
        FROM agent_tokens t
        LEFT JOIN mcp_call_logs l ON l.token_id = t.id AND l.created_at >= date('now','localtime')
       WHERE t.status = 'active' AND (t.expires_at IS NULL OR t.expires_at = '' OR t.expires_at >= datetime('now','localtime'))
       GROUP BY t.id
       ORDER BY used DESC, t.id
       LIMIT ?`).all(cap + 1)
    return { rows: rows.slice(0, cap), truncated: rows.length > cap }
  } catch { return null }
}

/** 已配置的日配额（0 = 关闭）。只读展示用：读失败按 0 显示不影响限流（限流自己走 `dailyQuotaState`，读失败 fail closed）。 */
export function dailyQuotaConfigured(db) {
  const n = Number(readSetting(db, 'mcp_token_daily_quota'))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** 本地午夜距现在的秒数（≥1） */
function secondsToLocalMidnight(d = new Date()) {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return Math.max(1, Math.ceil((next - d) / 1000))
}

/**
 * 日配额判定。→ { allowed: true, quota } | { allowed: false, reason: 'daily_quota'|'unavailable', quota, used, retryAfter }
 * 配额为 0 = 关闭（不查审计表）。统计口径：`mcp_call_logs` 中该令牌**本地今日**的行数（被速率限制直接拒绝的调用不写审计行，不占配额）。
 */
export function dailyQuotaState(db, tokenId, { now = () => new Date() } = {}) {
  // 严格读设置：库出错 ⇒ fail closed（`readSetting` 会吞错回落默认值 0，等于把已开启的配额静默关掉）
  let quota = 0
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('mcp_token_daily_quota')
    const def = SETTING_RULES.mcp_token_daily_quota
    quota = Number(castSettingValue(def, normalizeSettingValue(def, row ? row.value : def.default)))
    if (!Number.isFinite(quota) || quota < 0) throw new Error('bad quota')
  } catch {
    return { allowed: false, reason: 'unavailable', quota: null, used: null, retryAfter: 60 }
  }
  if (quota <= 0) return { allowed: true, quota: 0 }
  try {
    const used = db.prepare("SELECT COUNT(*) c FROM mcp_call_logs WHERE token_id=? AND created_at >= date('now','localtime')").get(tokenId).c
    if (used >= quota) return { allowed: false, reason: 'daily_quota', quota, used, retryAfter: secondsToLocalMidnight(now()) }
    return { allowed: true, quota, used }
  } catch {
    return { allowed: false, reason: 'unavailable', quota, used: null, retryAfter: 60 }
  }
}

export default { createMcpRateLimiter, recentLimitedByToken, dailyQuotaUsage, rateStoreFromEnv, dailyQuotaState, DEFAULT_MCP_RATE, mcpRatePolicy, dailyQuotaConfigured }
