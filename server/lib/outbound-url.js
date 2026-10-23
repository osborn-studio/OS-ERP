/**
 * ============================================================================
 * 文件标识：server/lib/outbound-url.js ｜ 出站 HTTP 策略：webhook 目标校验、DNS 钉住、禁重定向、总超时与响应体上限（ADR-0008 / F08）
 * ============================================================================
 * 【这块解决什么问题】
 *   通知 webhook 由有权限的后台用户配置，服务端会**主动**向它发请求。没有策略时，
 *   这条路径就是一个 SSRF 出口：可以指向 127.0.0.1、10.x、169.254.169.254（云元数据）、
 *   内网管理面；重定向可以把一个"看起来合法"的目标改写到内网；慢响应/大响应会耗尽资源。
 *
 * 【为什么这样设计】
 *   · 判据只有一处：保存渠道时与发送时都调用本模块；没有第二份"哪些地址可以连"的实现。
 *   · 生产只允许 https + 公网地址；demo/test 运行时允许 http 与回环/私网
 *     （本地假机器人与自动化测试需要），这条放宽**只**由 GML_RUNTIME_MODE 决定。
 *   · 可选 GML_WEBHOOK_ALLOWED_HOSTS（逗号分隔主机名）只会**进一步收窄**，
 *     不存在"名单里写了 127.0.0.1 就放开私网"的路径。
 *   · DNS 重绑定：先解析、逐个地址检查，再把**检查过的那个地址**钉进 socket 的 lookup，
 *     连接阶段不再做第二次解析；每次请求新建 Agent，不复用别的目标的连接。
 *   · 不跟随重定向：3xx 一律判失败（目标不该跳转，跳转就是异常）。
 *   · 一个总超时覆盖解析 + 连接 + 响应头 + 响应体；响应体有字节上限。
 *
 * 【改它要注意什么】
 *   · 新增地址段只改 V4_BLOCKED / isBlockedAddress；不要在调用方再写一份判断。
 *   · 放宽策略必须有运行时模式或显式名单依据；"因为某个机器人网关只有 http"不是理由。
 *   · 本模块不 import 数据库或业务模块，可在单元测试中直接导入。
 * ============================================================================
 */

import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import net from 'node:net'
import { runtimeMode } from '../runtime.js'

export class OutboundUrlError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.code = code
    this.httpStatus = 400
    this.status = 400
    this.detail = detail
  }
}

export const DEFAULT_TIMEOUT_MS = 8000
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024

/** 出站策略（纯函数，只看 env）。demo/test 放宽 http 与私网；名单只收窄。 */
export function outboundPolicy(env = process.env) {
  const mode = runtimeMode(env)
  const relaxed = mode !== 'production'
  const raw = String(env.GML_WEBHOOK_ALLOWED_HOSTS ?? '').trim()
  const allowedHosts = raw
    ? raw.split(',').map((s) => normalizeHost(s)).filter(Boolean)
    : null
  return { mode, allowInsecureHttp: relaxed, allowPrivateAddresses: relaxed, allowedHosts }
}

function normalizeHost(h) {
  let s = String(h ?? '').trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s.replace(/\.+$/, '')
}

// ---------------------------------------------------------------------------
// 地址分类
// ---------------------------------------------------------------------------

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this" network / unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT shared space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast（已弃用）
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + broadcast 255.255.255.255
]

function v4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

const V4_BLOCKED_INT = V4_BLOCKED.map(([ip, bits]) => [v4ToInt(ip), bits])

function v4Blocked(ip) {
  const n = v4ToInt(ip)
  if (n === null) return true
  for (const [prefix, bits] of V4_BLOCKED_INT) {
    const shift = 32 - bits
    if (Math.floor(n / 2 ** shift) === Math.floor(prefix / 2 ** shift)) return true
  }
  return false
}

/** 展开 IPv6 为 8 个 16 位整数；非法返回 null。支持 `::`、尾部内嵌 IPv4。 */
function v6Words(ip) {
  let s = String(ip)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!net.isIPv6(s)) return null
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = v4ToInt(tail)
    if (v4 === null) return null
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const words = [...head, ...Array(fill).fill('0'), ...rest].map((w) => parseInt(w, 16))
  if (words.length !== 8 || words.some((w) => !Number.isFinite(w) || w < 0 || w > 0xffff)) return null
  return words
}

const v4FromWords = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

/**
 * 该 IP 是否属于**不允许作为出站目标**的范围。无法解析的输入一律视为阻断（默认拒绝）。
 * 覆盖：IPv4 回环/私网/链路本地/CGNAT/测试网/组播/保留；IPv6 未指定/回环/ULA/链路与站点本地/
 * 组播/文档/丢弃前缀；以及 IPv4 映射（::ffff:a.b.c.d）、兼容（::a.b.c.d）、NAT64（64:ff9b::/96）、
 * 6to4（2002::/16）里内嵌的 IPv4 —— 内嵌地址按 IPv4 规则再判一次。
 */
export function isBlockedAddress(ip) {
  const s = String(ip ?? '').trim()
  if (net.isIPv4(s)) return v4Blocked(s)
  const w = v6Words(s)
  if (!w) return true
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w
  if (w.every((x) => x === 0)) return true // ::
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    if (w6 === 0 && w7 === 1) return true // ::1
    return v4Blocked(v4FromWords(w6, w7)) // ::a.b.c.d（兼容地址，已弃用）
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) return v4Blocked(v4FromWords(w6, w7)) // ::ffff:a.b.c.d
  if (w0 === 0x64 && w1 === 0xff9b) {
    if (w2 === 1) return true // 64:ff9b:1::/48 本地 NAT64
    if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return v4Blocked(v4FromWords(w6, w7)) // NAT64 well-known
  }
  if (w0 === 0x2002) return v4Blocked(v4FromWords(w1, w2)) // 6to4
  if ((w0 & 0xffc0) === 0xfe80) return true // link-local
  if ((w0 & 0xffc0) === 0xfec0) return true // site-local（已弃用）
  if ((w0 & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((w0 & 0xff00) === 0xff00) return true // multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return true // documentation
  if (w0 === 0x2001 && w1 === 0) return true // Teredo 2001::/32（内嵌的服务器/客户端 IPv4 可被攻击者控制）
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true // 100::/64 discard
  return false
}

const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

function hostLooksLocal(hostname) {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')
}

// ---------------------------------------------------------------------------
// 校验（同步，保存渠道时用）
// ---------------------------------------------------------------------------

/**
 * 同步校验一个 webhook 地址：协议、无用户信息、主机名单、本地主机名与字面 IP 的范围。
 * 不做 DNS（那是发送时 resolveOutboundTarget 的事）。
 * @returns {{ url: URL, href: string, protocol: string, hostname: string, port: number, policy: object }}
 */
export function validateOutboundUrl(input, { env = process.env } = {}) {
  const policy = outboundPolicy(env)
  let url
  try {
    url = new URL(String(input ?? '').trim())
  } catch {
    throw new OutboundUrlError('OUTBOUND_URL_INVALID', 'webhook 地址不是合法 URL')
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('OUTBOUND_URL_INVALID', 'webhook 地址不能包含用户名或密码')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowInsecureHttp)) {
    throw new OutboundUrlError(
      'OUTBOUND_SCHEME',
      policy.allowInsecureHttp ? `webhook 只允许 http/https（收到 ${url.protocol}）` : `生产环境 webhook 只允许 https（收到 ${url.protocol}）`
    )
  }
  const hostname = normalizeHost(url.hostname)
  if (!hostname) throw new OutboundUrlError('OUTBOUND_URL_INVALID', 'webhook 地址缺少主机名')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (policy.allowedHosts && !policy.allowedHosts.includes(hostname)) {
    throw new OutboundUrlError('OUTBOUND_HOST_NOT_ALLOWED', `webhook 主机 ${hostname} 不在 GML_WEBHOOK_ALLOWED_HOSTS 允许名单内`, { hostname })
  }
  if (!policy.allowPrivateAddresses) {
    if (hostLooksLocal(hostname) || (net.isIP(hostname) && isBlockedAddress(hostname))) {
      throw new OutboundUrlError('OUTBOUND_PRIVATE_ADDRESS', `webhook 目标 ${hostname} 指向本机/内网/保留地址，出站策略禁止`, { hostname })
    }
  }
  return { url, href: url.href, protocol: url.protocol, hostname, port, policy }
}

// ---------------------------------------------------------------------------
// 解析与钉住（异步，发送时用）
// ---------------------------------------------------------------------------

const defaultLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true })

/**
 * 校验 + 解析：**每一个** DNS 答案都要过地址检查，任何一个落在禁止范围就整体拒绝
 * （攻击者控制的域名可以同时返回公网与内网地址，只检查第一个等于没检查）。
 * 返回的 address 就是随后 socket 会连接的那个地址；连接阶段不再解析。
 * @param lookup 测试注入：async (hostname) => [{ address, family }]
 */
export async function resolveOutboundTarget(input, { env = process.env, lookup = defaultLookup } = {}) {
  const v = validateOutboundUrl(input, { env })
  const literal = net.isIP(v.hostname)
  let answers
  if (literal) {
    answers = [{ address: v.hostname, family: literal }]
  } else {
    try {
      answers = await lookup(v.hostname)
    } catch (e) {
      throw new OutboundUrlError('OUTBOUND_DNS', `无法解析 webhook 主机 ${v.hostname}：${e?.message || e}`, { hostname: v.hostname })
    }
    if (!Array.isArray(answers) || !answers.length) {
      throw new OutboundUrlError('OUTBOUND_DNS', `webhook 主机 ${v.hostname} 没有可用的解析结果`, { hostname: v.hostname })
    }
  }
  if (!v.policy.allowPrivateAddresses) {
    for (const a of answers) {
      if (isBlockedAddress(a?.address)) {
        throw new OutboundUrlError('OUTBOUND_PRIVATE_ADDRESS', `webhook 主机 ${v.hostname} 解析到本机/内网/保留地址 ${a?.address}，出站策略禁止`, { hostname: v.hostname, address: a?.address })
      }
    }
  }
  const pick = answers[0]
  return { ...v, address: String(pick.address), family: Number(pick.family) || net.isIP(String(pick.address)) || 4 }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 受策略约束的一次 HTTP 请求。
 * 不跟随重定向（3xx → OUTBOUND_REDIRECT）；一个总超时覆盖解析到读完响应体；响应体超限即断开。
 * @returns {Promise<{ status:number, headers:object, bodyText:string, address:string }>}
 */
export async function outboundRequest(input, {
  env = process.env, method = 'POST', headers = {}, body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, lookup = defaultLookup,
  testTrustedCa = null
} = {}) {
  // 仅测试：把一张自签证书当作唯一可信 CA，使本地 HTTPS 联调可行。只有 GML_RUNTIME_MODE=test 且显式传入才生效；
  // 其余模式（含缺省=production、demo）在任何解析/连接之前直接拒绝；不读任何环境开关，主机名校验保持默认开启。
  if (testTrustedCa != null && outboundPolicy(env).mode !== 'test') {
    throw new OutboundUrlError('OUTBOUND_TEST_CA_FORBIDDEN', 'testTrustedCa 只允许在 GML_RUNTIME_MODE=test 下使用')
  }
  const startedAt = Date.now()
  const timeoutError = () => new OutboundUrlError('OUTBOUND_TIMEOUT', `请求超时（${timeoutMs}ms，含解析与读取响应体）`)

  let timer = null
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs) })
  let target
  try {
    target = await Promise.race([resolveOutboundTarget(input, { env, lookup }), deadline])
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
  const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
  clearTimeout(timer)

  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http
    let settled = false
    let req = null
    let guard = null
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      fn(value)
    }
    const fail = (code, message) => done(reject, new OutboundUrlError(code, message))

    // 钉住：连接阶段只认已经检查过的地址（兼容 `all:true` 与单地址两种回调形状）
    const pinnedLookup = (_host, options, cb) => {
      if (typeof options === 'function') return options(null, target.address, target.family)
      if (options && options.all) return cb(null, [{ address: target.address, family: target.family }])
      return cb(null, target.address, target.family)
    }

    req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method,
      headers,
      lookup: pinnedLookup,
      ...(target.protocol === 'https:' && !net.isIP(target.hostname) ? { servername: target.hostname } : {}),
      ...(target.protocol === 'https:' && testTrustedCa != null ? { ca: testTrustedCa } : {}),
      agent: false // 每次新建连接：不复用别的目标的 keep-alive socket
    })
    guard = setTimeout(() => { fail('OUTBOUND_TIMEOUT', timeoutError().message); req.destroy() }, remaining)

    req.on('error', (e) => fail('OUTBOUND_NETWORK', String(e?.message || e)))
    req.on('response', (res) => {
      const status = Number(res.statusCode || 0)
      if (status >= 300 && status < 400) {
        fail('OUTBOUND_REDIRECT', `目标返回重定向 HTTP ${status}，出站策略不跟随重定向`)
        res.resume()
        req.destroy()
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBodyBytes) {
          fail('OUTBOUND_BODY_TOO_LARGE', `响应体超过 ${maxBodyBytes} 字节上限`)
          res.destroy()
          req.destroy()
          return
        }
        chunks.push(c)
      })
      res.on('aborted', () => fail('OUTBOUND_NETWORK', '连接在读取响应时中断'))
      res.on('error', (e) => fail('OUTBOUND_NETWORK', String(e?.message || e)))
      res.on('end', () => done(resolve, { status, headers: res.headers, bodyText: Buffer.concat(chunks).toString('utf8'), address: target.address }))
    })
    if (body != null) req.write(body)
    req.end()
  })
}

export default { OutboundUrlError, outboundPolicy, isBlockedAddress, validateOutboundUrl, resolveOutboundTarget, outboundRequest }
