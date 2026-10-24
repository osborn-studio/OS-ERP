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
 * 【不持久】速率桶在进程内存，重启清零（限流不是账务；日配额读审计表，是持久的）。多进程部署各自计数。
 * ============================================================================
 */
import { createBucketStore, envInt } from './metrics-throttle.js'
import { SETTING_RULES, normalizeSettingValue, castSettingValue, readSetting } from './settings.js'

export const DEFAULT_MCP_RATE = Object.freeze({ rpm: 600, writeRpm: 60, windowMs: 60000, maxBuckets: 10000 })
const MAX_RATE = 1_000_000

function makeWindow(limit, now, maxBuckets) {
  const W = DEFAULT_MCP_RATE.windowMs
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

/** 速率策略（环境变量 + 默认值）。限流器与管理端只读展示共用这一处，页面显示的数字就是限流器实际用的数字。 */
export function mcpRatePolicy(env = process.env, override = {}) {
  return {
    rpm: override.rpm ?? envInt(env.GML_MCP_TOKEN_RPM, 1, MAX_RATE, DEFAULT_MCP_RATE.rpm),
    writeRpm: override.writeRpm ?? envInt(env.GML_MCP_WRITE_RPM, 1, MAX_RATE, DEFAULT_MCP_RATE.writeRpm),
    windowMs: DEFAULT_MCP_RATE.windowMs,
    maxBuckets: override.maxBuckets ?? DEFAULT_MCP_RATE.maxBuckets
  }
}

export function createMcpRateLimiter({ env = process.env, now = Date.now, ...override } = {}) {
  const policy = mcpRatePolicy(env, override)
  const all = makeWindow(policy.rpm, now, policy.maxBuckets)
  const writes = makeWindow(policy.writeRpm, now, policy.maxBuckets)
  const shadow = createBucketStore({ maxBuckets: policy.maxBuckets, now })
  const deny = (reason, win) => ({ allowed: false, reason, retryAfter: win.retryAfter() })
  return {
    policy,
    /** 一次工具调用的额度申请。→ { allowed: true } | { allowed: false, reason: 'rpm'|'write_rpm'|'unavailable', retryAfter } */
    consume(tokenId, level, scope = '') {
      if (!Number.isSafeInteger(tokenId) || tokenId <= 0 || typeof scope !== 'string' || scope.length > 64) return deny('unavailable', all)
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

export default { createMcpRateLimiter, mcpRatePolicy, dailyQuotaConfigured, dailyQuotaState, DEFAULT_MCP_RATE }
