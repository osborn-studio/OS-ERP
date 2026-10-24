/**
 * ============================================================================
 * 文件标识：server/lib/trust-proxy.js ｜ 受信反向代理的唯一判据（ADR-0040）
 * ============================================================================
 * 【职责】`GML_TRUST_PROXY` 的解析与"这个连接对端是不是我们自己的代理"的唯一裁决：
 *   · `off`（默认 / 未设 / 空串）：不信任任何对端；`X-Forwarded-*` 一律忽略，`req.ip` = socket 对端，`req.secure` = 直连 TLS。
 *   · `loopback`：只信任 127.0.0.0/8 与 ::1（同机 nginx / caddy / 容器内 sidecar）。
 *   · `<CIDR 列表>`：逗号分隔的 IPv4 / IPv6 CIDR（裸地址视为单主机）。
 *   其它任何值（`true`、`1`、`*`、跳数、含 zone id、/0 全网、超长列表……）⇒ 启动即抛 `TRUST_PROXY_INVALID`，不猜。
 *
 * 【谁消费】server/index.js 把 `trustProxyFn` 交给 `app.set('trust proxy', fn)`；Express 据此派生
 *   `req.ip`（登录节流 / 审计 / MCP 日志的来源 IP）、`req.protocol` / `req.secure`（HSTS、Cookie Secure 的依据）。
 *   请求号（logger）通过 `isTrustedPeer(req)` 读同一个函数。**任何模块都不得再自备信任判断**。
 *
 * 【匹配规则】对端地址先规范化：IPv4-mapped IPv6（::ffff:a.b.c.d 或十六进制形态）折成 IPv4 再匹配，
 *   使 `10.0.0.0/8` 同样命中双栈 socket 报告的 `::ffff:10.1.2.3`；含 zone id（`%`）、非 IP 字符串、
 *   超长输入一律 **不受信**（XFF 链上的垃圾项不会被当成可信跳）。配置里的 mapped CIDR（::ffff:x/n）按同样规则折叠，
 *   前缀 < 96 的 mapped 写法含义含混 ⇒ 拒绝。
 * ============================================================================
 */
import net from 'node:net'

const MAX_ENTRIES = 64
const MAX_ADDR_LEN = 64

function invalid(reason) {
  return Object.assign(new Error(`GML_TRUST_PROXY invalid: ${reason}. Use off | loopback | comma-separated IPv4/IPv6 CIDRs.`), { code: 'TRUST_PROXY_INVALID' })
}

/** IPv6 → 8×16bit 组；失败返回 null。借 WHATWG URL 做规范化（压缩、点分尾缀均被处理） */
function v6Groups(text) {
  let host
  try { host = new URL(`http://[${text}]/`).hostname.slice(1, -1) } catch { return null }
  const [head, tail = null] = host.split('::')
  const h = head ? head.split(':') : []
  const t = tail === null ? [] : (tail ? tail.split(':') : [])
  if (tail === null ? h.length !== 8 : h.length + t.length > 7) return null
  const groups = [...h, ...Array(tail === null ? 0 : 8 - h.length - t.length).fill('0'), ...t].map(g => Number.parseInt(g, 16))
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** 规范化为 { family: 4|6, bytes: number[] }；非法 / 含 zone / 超长 ⇒ null。mapped IPv6 折成 IPv4 */
function canon(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ADDR_LEN || value.includes('%')) return null
  const family = net.isIP(value)
  if (family === 4) return { family: 4, bytes: value.split('.').map(Number) }
  if (family !== 6) return null
  const g = v6Groups(value)
  if (!g) return null
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return { family: 4, mapped: true, bytes: [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255] }
  return { family: 6, bytes: g.flatMap(x => [x >> 8, x & 255]) }
}

function matches(addr, rule) {
  if (addr.family !== rule.family) return false
  let bits = rule.prefix
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if ((addr.bytes[i] & mask) !== (rule.bytes[i] & mask)) return false
  }
  return true
}

function parseEntry(raw) {
  const entry = raw.trim()
  if (!entry) throw invalid('empty list entry')
  const slash = entry.indexOf('/')
  const addrText = slash === -1 ? entry : entry.slice(0, slash)
  const prefixText = slash === -1 ? null : entry.slice(slash + 1)
  if (addrText.includes('%')) throw invalid(`zone id not allowed in "${entry}"`)
  const addr = canon(addrText)
  if (!addr) throw invalid(`"${entry}" is not an IP/CIDR`)
  const max = addr.family === 4 ? 32 : 128
  let prefix = max
  if (prefixText !== null) {
    if (!/^\d{1,3}$/.test(prefixText)) throw invalid(`bad prefix in "${entry}"`)
    prefix = Number(prefixText)
    // 配置写成 mapped IPv6：折叠成 IPv4 后前缀要相应扣除 96 位；<96 的含义含混，拒绝
    if (addr.mapped) {
      if (prefix < 96 || prefix > 128) throw invalid(`ambiguous IPv4-mapped prefix in "${entry}"`)
      prefix -= 96
    } else if (prefix > max) throw invalid(`prefix out of range in "${entry}"`)
  }
  if (prefix === 0) throw invalid(`"${entry}" would trust every address`)
  return { family: addr.family, bytes: addr.bytes, prefix }
}

const LOOPBACK = [{ family: 4, bytes: [127, 0, 0, 0], prefix: 8 }, { family: 6, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], prefix: 128 }]

/** 解析 GML_TRUST_PROXY；返回 { mode, rules, fn }。非法 ⇒ 抛 TRUST_PROXY_INVALID */
export function parseTrustProxy(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw invalid('must be a string')
  const text = (value ?? '').trim()
  const lower = text.toLowerCase()
  let mode, rules
  if (text === '' || lower === 'off') { mode = 'off'; rules = [] }
  else if (lower === 'loopback') { mode = 'loopback'; rules = LOOPBACK }
  else {
    const parts = text.split(',')
    if (parts.length > MAX_ENTRIES) throw invalid(`more than ${MAX_ENTRIES} entries`)
    mode = 'cidr'
    rules = parts.map(parseEntry)
  }
  const fn = (ip) => {
    if (!rules.length) return false
    const addr = canon(ip)
    return addr !== null && rules.some(rule => matches(addr, rule))
  }
  return { mode, rules, fn }
}

let cached
function current(env = process.env) {
  const raw = env.GML_TRUST_PROXY
  if (!cached || cached.raw !== raw) cached = { raw, parsed: parseTrustProxy(raw) }
  return cached.parsed
}

/** 启动闸门：非法配置当场抛（server/index.js 在装配 Express 之前调用） */
export function assertTrustProxyConfig(env = process.env) { return current(env).mode }

/** Express `trust proxy` 函数：`(ip, hopIndex) => boolean`；读当前 GML_TRUST_PROXY */
export function trustProxyFn(ip) { return current().fn(ip) }

/** 该请求的 **直接连接对端** 是否为受信代理（只看 socket，不看任何请求头）。读应用上已装配的同一函数 */
export function isTrustedPeer(req) {
  const fn = req?.app?.get?.('trust proxy fn')
  return typeof fn === 'function' && fn(req.socket?.remoteAddress, 0) === true
}

/** 请求是否经 HTTPS 到达：直连 TLS，或受信代理报告 X-Forwarded-Proto（Express 已按同一函数派生） */
export function isSecureRequest(req) { return req?.secure === true }
