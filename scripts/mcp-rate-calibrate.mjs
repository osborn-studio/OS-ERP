#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/mcp-rate-calibrate.mjs ｜ 按生产流量校准 OsErpMcpRateStoreWaitHigh 的阈值（AH9，ADR-0056 补充 4）
 * ============================================================================
 * 【职责】读一份 Prometheus 文本导出（`GET /api/meta/metrics?format=prometheus` 的内容，文件或**回环**地址的 URL），
 *   取出 `os_erp_mcp_rate_store_wait_seconds` 直方图，按 `docs/operations/monitoring.md`「阈值怎么来的」的同一条规则算出建议阈值并打印推导。
 *   规则（常量见下方 RULE）：样本 < 1000 ⇒ 不给建议；p99.9 落进 +Inf 桶 ⇒ 先处置（`investigate`），不用调阈值掩盖；
 *   p99.9 ≤ 20 ms ⇒ 保持 100 ms；否则取 max(50 ms, 4 × p99.9)，高于 100 ms 才算「建议调高」，不高于 100 ms 说明现值已经够用。本脚本只会建议调高或保持，不会建议调低（调低是运维的判断）。
 * 【为什么这样设计】
 *   · 只读：不写文件、不改告警规则 / 环境变量 / 设置，不起子进程；输入只是文本，输出只是打印。
 *   · URL 只接受回环（localhost / 127.0.0.0/8 / [::1]）、http(s)、无 userinfo、不跟随重定向、10 s 超时、5 MB 上限；
 *     抓取令牌只从环境变量 `GML_METRICS_TOKEN` 取、只发给这个回环地址、永不打印。远程主机请先把导出存成文件再喂进来。
 *   · 解析严格：桶值不是有限非负数、桶不单调 ⇒ 直接报错退出，不猜。
 * 【诚实边界】直方图是进程启动以来的**累计**分布，且分位数由桶边界线性插值得到（与 PromQL histogram_quantile 同法），分辨率就是桶宽；
 *   单次导出看不到流量速率（告警条件里的「> 0.1 次/秒」），也看不到「持续 15 分钟」——这两项仍要在 Prometheus 里按周复核（见 monitoring.md）。
 *   在刚重启的进程上跑，样本不足会如实说明。
 * 【用法】node scripts/mcp-rate-calibrate.mjs <导出文件 | http://127.0.0.1:端口/api/meta/metrics?format=prometheus> [--json]
 *   退出码：0 已给出结论（含样本不足 / 需处置）；2 用法错误、拒绝（非回环地址）、读取或解析失败。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const FAMILY = 'os_erp_mcp_rate_store_wait_seconds'
export const RULE = Object.freeze({ minSamples: 1000, healthyP999Ms: 20, currentMs: 100, floorMs: 50, factor: 4 })
const MAX_BYTES = 5_000_000
const FETCH_TIMEOUT_MS = 10_000

const fail = (message) => Object.assign(new Error(message), { usage: true })

/** 取出直方图。→ { buckets:[{le,count}]（有限桶，累计）, inf（落在最大有限桶之上的样本数）, count, sum } | null（导出里没有这个指标族）。 */
export function parseWaitHistogram(text) {
  const bucket = new Map()
  let sum = 0
  let found = false
  const value = (raw) => {
    const n = Number(raw)
    if (!/^[0-9.eE+-]+$/.test(raw) || !Number.isFinite(n) || n < 0) throw fail(`直方图数值无效（invalid）：「${String(raw).slice(0, 32)}」`)
    return n
  }
  for (const line of String(text).split('\n')) {
    let m = new RegExp(`^${FAMILY}_bucket\\{le="([^"]+)"\\} (\\S+)\\s*$`).exec(line)
    if (m) {
      found = true
      const le = m[1] === '+Inf' ? Infinity : Number(m[1])
      if (Number.isNaN(le) || le <= 0) throw fail(`桶边界无效（invalid）：「${m[1].slice(0, 32)}」`)
      if (bucket.has(le)) throw fail(`桶边界重复：le=${m[1]}（导出里混入了多个实例？请逐实例分别校准）`)
      bucket.set(le, value(m[2]))
      continue
    }
    m = new RegExp(`^${FAMILY}_sum (\\S+)\\s*$`).exec(line)
    if (m) { found = true; sum = value(m[1]) }
  }
  if (!found) return null
  const les = [...bucket.keys()].sort((a, b) => a - b)
  if (!bucket.has(Infinity)) throw fail('缺少 le="+Inf" 桶，不是完整的直方图')
  let prev = 0
  for (const le of les) {
    const c = bucket.get(le)
    if (c < prev) throw fail(`桶计数不单调（monotonic）：le=${le} 的 ${c} 小于前一个桶的 ${prev}`)
    prev = c
  }
  const finite = les.filter((le) => le !== Infinity).map((le) => ({ le, count: bucket.get(le) }))
  const count = bucket.get(Infinity)
  return { buckets: finite, inf: count - (finite.at(-1)?.count ?? 0), count, sum }
}

/** 分位数（秒），桶内线性插值（与 histogram_quantile 同法）。无样本 ⇒ NaN；落在 +Inf 桶 ⇒ Infinity。 */
export function quantile(h, q) {
  if (!(h.count > 0)) return NaN
  const rank = q * h.count
  let lower = 0
  let prev = 0
  for (const b of h.buckets) {
    if (b.count >= rank) {
      if (b.count === prev) return b.le
      return lower + (b.le - lower) * ((rank - prev) / (b.count - prev))
    }
    lower = b.le
    prev = b.count
  }
  return Infinity
}

const ms = (s) => (Number.isFinite(s) ? s * 1000 : s)
const fmt = (v) => (v === Infinity ? '+Inf' : Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(3)) : 'n/a')

/** 建议。→ { verdict:'insufficient_samples'|'investigate'|'keep'|'raise', suggested_ms, count, p50_ms, p95_ms, p99_ms, p999_ms, derivation:[string] } */
export function suggestThreshold(h) {
  const q = { p50_ms: ms(quantile(h, 0.5)), p95_ms: ms(quantile(h, 0.95)), p99_ms: ms(quantile(h, 0.99)), p999_ms: ms(quantile(h, 0.999)) }
  const out = { count: h.count, ...q, current_ms: RULE.currentMs }
  const d = [`样本数 ${h.count}，p50 ${fmt(q.p50_ms)} ms，p95 ${fmt(q.p95_ms)} ms，p99 ${fmt(q.p99_ms)} ms，p99.9 ${fmt(q.p999_ms)} ms（桶内线性插值，分辨率受桶宽限制）`]
  if (h.count < RULE.minSamples) {
    d.push(`样本不足 ${RULE.minSamples}：p99.9 由个位数样本决定，不给建议；让实例跑够一周再导出`)
    return { ...out, verdict: 'insufficient_samples', suggested_ms: null, derivation: d }
  }
  if (q.p999_ms === Infinity) {
    d.push(`p99.9 落在最大桶之外（+Inf）：已接近 busy_timeout 的量级，应先处置（看 os_erp_write_retries_total 与业务写入速率，必要时改回 memory 模式），不要靠调阈值掩盖`)
    return { ...out, verdict: 'investigate', suggested_ms: null, derivation: d }
  }
  if (q.p999_ms <= RULE.healthyP999Ms) {
    d.push(`p99.9 ${fmt(q.p999_ms)} ms ≤ ${RULE.healthyP999Ms} ms：基准没有低估这台主机，保持 ${RULE.currentMs} ms`)
    return { ...out, verdict: 'keep', suggested_ms: RULE.currentMs, derivation: d }
  }
  const need = Math.max(RULE.floorMs, Math.round(q.p999_ms * RULE.factor))
  d.push(`p99.9 ${fmt(q.p999_ms)} ms > ${RULE.healthyP999Ms} ms：基准低估了这台主机；阈值取 max(${RULE.floorMs} ms, ${RULE.factor} × p99.9) = ${need} ms`)
  if (need <= RULE.currentMs) {
    d.push(`${need} ms 不高于现值 ${RULE.currentMs} ms：现值已经够用，保持（本脚本不建议调低）`)
    return { ...out, verdict: 'keep', suggested_ms: RULE.currentMs, derivation: d }
  }
  d.push(`${need} ms 高于现值 ${RULE.currentMs} ms：建议把 OsErpMcpRateStoreWaitHigh 的 p95 阈值调到 ${(need / 1000).toString()} 秒`)
  return { ...out, verdict: 'raise', suggested_ms: need, derivation: d }
}

/** 只放行回环地址的 http(s) URL。不合规抛带 usage 标记的错误。 */
export function assertLoopbackUrl(raw) {
  let u
  try { u = new URL(raw) } catch { throw fail(`不是有效的 URL：「${String(raw).slice(0, 64)}」`) }
  const loop = u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname)
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !loop) {
    throw fail('只接受回环地址（localhost / 127.0.0.0/8 / [::1]）的 http(s) URL，且不带用户信息；远程主机请先把导出存成文件再传入（loopback only）')
  }
  return u
}

async function load(input) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) && !/^[a-zA-Z]:[\\/]/.test(input)) {
    const u = assertLoopbackUrl(input)
    const token = process.env.GML_METRICS_TOKEN
    let res
    try {
      res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: token ? { authorization: `Bearer ${token}` } : {} })
    } catch (e) {
      throw fail(`读取失败（${e?.name === 'TimeoutError' ? '超时' : e?.cause?.code ?? e?.name ?? '网络错误'}；重定向一律不跟随）`)
    }
    if (!res.ok) throw fail(`读取失败：HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > MAX_BYTES) throw fail('导出超过 5 MB，拒绝')
    return text
  }
  try { return readFileSync(input, 'utf8') } catch (e) { throw fail(`读取文件失败：${e.code ?? e.message}`) }
}

function render(r) {
  const lines = [`OsErpMcpRateStoreWaitHigh 阈值校准（${FAMILY}）`, '']
  for (const x of r.derivation) lines.push(`  · ${x}`)
  lines.push('')
  if (r.suggested_ms === null) lines.push(`建议阈值：无（${r.verdict === 'investigate' ? '先处置，见上' : '样本不足'}）`)
  else lines.push(`建议阈值：${r.suggested_ms} ms（p95，${r.verdict === 'raise' ? '建议调高' : '保持现值'}）`)
  lines.push('单次导出看不到流量速率（> 0.1 次/秒）与持续时间（for: 15m），这两项请在 Prometheus 里按周复核；本脚本不修改任何配置，也不改告警规则文件。')
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')
  if (rest.length !== 1 || rest[0].startsWith('--')) {
    console.error('用法：node scripts/mcp-rate-calibrate.mjs <导出文件 | 回环 URL> [--json]')
    process.exitCode = 2
    return
  }
  try {
    const h = parseWaitHistogram(await load(rest[0]))
    if (!h) throw fail(`导出里没有 ${FAMILY}（该直方图只在 GML_MCP_RATE_STORE=db 时有观测值；也请确认抓取的是 format=prometheus）`)
    const r = suggestThreshold(h)
    process.stdout.write(json ? `${JSON.stringify(r, (_k, v) => (v === Infinity ? null : Number.isNaN(v) ? null : v), 2)}\n` : render(r))
  } catch (e) {
    console.error(`mcp-rate-calibrate: ${e.usage ? e.message : '内部错误'}`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) await main()
