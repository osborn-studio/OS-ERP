/**
 * ============================================================================
 * 文件标识：server/lib/metrics-throttle.js ｜ `/api/meta/metrics` 的按来源 IP 节流（独立桶，ADR-0045 补充 / AB10）
 * ============================================================================
 * 【职责】固定窗口、按 IP 计数。桶与登录节流（`login-throttle.js`）完全分开：抓取不会挤占登录额度，登录被打也不影响抓取。
 *   沿用登录节流的口径：IP 归一化（IPv4 映射的 IPv6 与 IPv4 同桶）、桶数有上限、满了且无过期可清时 **fail closed**（拒绝），
 *   无法解析的来源地址不豁免。来源 IP 用 Express 的 `req.ip`（受 GML_TRUST_PROXY 单一策略约束，ADR-0040），不读 X-Forwarded-For。
 * 【与登录节流的差别】进程内存、不持久：指标端点是只读的，重启清零无安全后果；不碰 SQLite，所以存储故障不会连带拖垮抓取。
 * 【配置】`GML_METRICS_IP_LIMIT`（默认 120 次 / 窗口，范围 1..100000）、`GML_METRICS_IP_WINDOW_MS`（默认 60000，范围 1000..86400000）。
 *   非法值回退默认（指标端点不应因配置笔误而起不来）。默认值远高于 15–30 s 一次的抓取频率，只挡暴力猜令牌 / 误配的死循环。
 * 【计数范围】所有到达该端点的请求（含令牌错误、无凭据、JSON 形态）都计数 —— 节流在鉴权**之前**，猜令牌同样受限。
 * ============================================================================
 */
import { isIP } from 'node:net'

export const DEFAULT_METRICS_THROTTLE = Object.freeze({ limit: 120, windowMs: 60000, maxBuckets: 10000 })

export function envInt(raw, min, max, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback
}

function keyOf(ip) {
  if (typeof ip !== 'string' || ip.length > 128) return null
  if (isIP(ip) === 4) return ip // 整串校验：IPv4 带 %zone 一律不认（否则每个后缀一个新桶）
  if (isIP(ip.split('%')[0]) !== 6) return null
  const host = new URL(`http://[${ip.split('%')[0]}]/`).hostname.slice(1, -1)
  const m = host.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
  if (m) {
    const hi = Number.parseInt(m[1], 16), lo = Number.parseInt(m[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return host
}

/**
 * 有上限的桶表（AB10 抽出的通用部分，AD9 的 MCP 按令牌限流复用）：键 → 桶对象（桶必须带 `expires` 毫秒时刻）。
 * 桶数达到上限时：先看最早过期时刻（O(1)）判断有没有可清理项，有才全表清一遍；清完仍满则 **fail closed**
 * （返回 `{ full: true, until }`，调用方据此拒绝）。已有桶的键永远能取到自己的桶。
 * 调用方续期（把 `bucket.expires` 往后推）是安全的：`minExpiry` 只是下界，偏小只会多清一次。
 */
export function createBucketStore({ maxBuckets, now = Date.now }) {
  const buckets = new Map()
  let minExpiry = Infinity
  return {
    get size() { return buckets.size },
    /** → { bucket } | { full: true, until } */
    open(key, make) {
      const t = now()
      let b = buckets.get(key)
      if (b && b.expires <= t) { buckets.delete(key); b = undefined }
      if (!b) {
        if (buckets.size >= maxBuckets) {
          if (t < minExpiry) return { full: true, until: minExpiry }
          minExpiry = Infinity
          for (const [k, v] of buckets) { if (v.expires <= t) buckets.delete(k); else if (v.expires < minExpiry) minExpiry = v.expires }
          if (buckets.size >= maxBuckets) return { full: true, until: minExpiry }
        }
        b = make()
        buckets.set(key, b)
        if (b.expires < minExpiry) minExpiry = b.expires
      }
      return { bucket: b }
    }
  }
}

export function createMetricsThrottle({ env = process.env, now = Date.now, ...override } = {}) {
  const policy = {
    limit: override.limit ?? envInt(env.GML_METRICS_IP_LIMIT, 1, 100000, DEFAULT_METRICS_THROTTLE.limit),
    windowMs: override.windowMs ?? envInt(env.GML_METRICS_IP_WINDOW_MS, 1000, 86400000, DEFAULT_METRICS_THROTTLE.windowMs),
    maxBuckets: override.maxBuckets ?? DEFAULT_METRICS_THROTTLE.maxBuckets
  }
  const store = createBucketStore({ maxBuckets: policy.maxBuckets, now })
  return {
    policy,
    /** → { allowed: true } | { allowed: false, retryAfter(秒, ≥1) } */
    consume(ip) {
      const t = now()
      const key = keyOf(ip)
      const reject = (until) => ({ allowed: false, retryAfter: Math.max(1, Math.ceil((until - t) / 1000)) })
      if (key === null) return reject(t + policy.windowMs)
      const o = store.open(key, () => ({ n: 0, expires: t + policy.windowMs }))
      if (o.full) return reject(o.until)
      const b = o.bucket
      if (b.n >= policy.limit) return reject(b.expires)
      b.n += 1
      return { allowed: true }
    }
  }
}

export default { createMetricsThrottle, createBucketStore, DEFAULT_METRICS_THROTTLE }
