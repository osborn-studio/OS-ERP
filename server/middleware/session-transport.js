/**
 * ============================================================================
 * 文件标识：server/middleware/session-transport.js ｜ 后台会话传输方式：bearer（默认）或 HttpOnly Cookie + CSRF 双提交
 * ============================================================================
 * 【职责】`GML_SESSION_TRANSPORT=bearer|cookie`（缺省与任何非法值 = bearer）。仅本文件决定 Cookie 的名字、属性与 CSRF 校验。
 *
 * 【cookie 模式契约】
 *   · 登录：`gml_session` = 后台 JWT（HttpOnly、SameSite=Lax、Path=/、Max-Age 与 JWT 同为 12h，https 时 Secure）；
 *     `gml_csrf` = HMAC-SHA256(JWT_SECRET, 'os-erp-csrf:v1:' + JWT)（非 HttpOnly，前端读后放进 `x-csrf-token`）。
 *   · requireAuth：没有 Authorization 头时才看 `gml_session`；非 GET/HEAD/OPTIONS 必须同时满足
 *     头 `x-csrf-token` == Cookie `gml_csrf` == 由该 JWT 重算的 HMAC（三者常数时间比较）。
 *     CSRF 值绑定到会话 JWT，所以子域写入同名 Cookie（cookie tossing）也伪造不出可用的值。
 *   · Authorization 头一旦出现（哪怕无效）就不再回落到 Cookie；Bearer 不是环境凭据，不需要 CSRF。
 *   · 登出 / 改密 / Cookie 内 JWT 失效（401）时清两只 Cookie。
 * bearer 模式下本文件的函数都是空操作，且从不读取 Cookie。
 * ============================================================================
 */
import crypto from 'node:crypto'
import { isSecureRequest } from '../lib/trust-proxy.js'

export const SESSION_COOKIE = 'gml_session'
export const CSRF_COOKIE = 'gml_csrf'
export const CSRF_HEADER = 'x-csrf-token'
const MAX_AGE_MS = 12 * 60 * 60 * 1000 // 与 auth.js 的 JWT_EXPIRES='12h' 一致
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export const sessionTransport = (env = process.env) => (env.GML_SESSION_TRANSPORT === 'cookie' ? 'cookie' : 'bearer')

export function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string' || !header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const name = part.slice(0, i).trim()
    if (name in out) continue // 重名取第一个，不被后写入的覆盖
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()) } catch { /* 坏编码按不存在 */ }
  }
  return out
}

export const csrfFor = (jwt, secret) =>
  crypto.createHmac('sha256', secret).update(`os-erp-csrf:v1:${jwt}`).digest('base64url')

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** cookie 模式下请求携带的会话 JWT；bearer 模式 / 无 Cookie ⇒ null */
export function sessionCookieToken(req, env = process.env) {
  if (sessionTransport(env) !== 'cookie') return null
  const v = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  return v || null
}

export const needsCsrf = (req) => !SAFE_METHODS.has(req.method)

export function csrfValid(req, jwt, secret) {
  const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE]
  const header = req.headers[CSRF_HEADER]
  return same(header, cookie) && same(header, csrfFor(jwt, secret))
}

const secureFlag = (req, env) => env.GML_COOKIE_SECURE === 'always' || isSecureRequest(req)

/** 登录成功后下发 Cookie；返回是否已下发（bearer 模式 ⇒ false，什么也不做） */
export function issueSessionCookies(req, res, jwt, secret, env = process.env) {
  if (sessionTransport(env) !== 'cookie') return false
  const base = { sameSite: 'lax', path: '/', maxAge: MAX_AGE_MS, secure: secureFlag(req, env) }
  res.cookie(SESSION_COOKIE, jwt, { ...base, httpOnly: true })
  res.cookie(CSRF_COOKIE, csrfFor(jwt, secret), { ...base, httpOnly: false })
  return true
}

/**
 * 登录 CSRF 防护（cookie 模式）：浏览器发来的跨站请求不得设置会话 Cookie。
 * `Sec-Fetch-Site` 不是 same-origin/none ⇒ 拒绝；没有该头的旧浏览器退而比较 `Origin` 的 host 与 `Host`，不一致 ⇒ 拒绝；
 * 两个头都没有（脚本 / curl / 旧客户端）⇒ 放行——它们本来就不是“被诱导的浏览器”。
 */
export function crossSiteBrowserRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none' // 浏览器设置、页面脚本无法伪造；有它就以它为准（反向代理改写 Host 时 Origin 比较会误伤）
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try { return new URL(origin).host !== req.headers.host } catch { return true }
  }
  return false
}

export function clearSessionCookies(req, res, env = process.env) {
  if (sessionTransport(env) !== 'cookie') return false
  const base = { sameSite: 'lax', path: '/', maxAge: 0, secure: secureFlag(req, env) }
  res.cookie(SESSION_COOKIE, '', { ...base, httpOnly: true })
  res.cookie(CSRF_COOKIE, '', { ...base, httpOnly: false })
  return true
}
