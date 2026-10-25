/**
 * ============================================================================
 * 文件标识：server/middleware/security-headers.js ｜ 安全响应头：CSP（report/enforce/off）、nosniff、Referrer-Policy、Permissions-Policy、X-Frame-Options、受信 HTTPS 下的 HSTS
 * ============================================================================
 * 【职责】给每个响应加一组固定的安全头；无第三方依赖。决策与取舍见 ADR-0036。
 *
 * 【CSP 模式】`GML_CSP_MODE=report|enforce|off`；缺省 = 生产 enforce，demo/test report（只上报不拦）。
 *   非法值回落到该运行模式的默认值（不抛、也不因拼错而静默关掉保护）。
 *   策略：`default-src 'self'`，`script-src 'self'`（不含 unsafe-inline / unsafe-eval），
 *   `style-src 'self' 'unsafe-inline'`（图表库与 React 会写内联 style；样式注入的风险远低于脚本，ADR-0036 记录），
 *   `object-src 'none'`、`base-uri 'self'`、`form-action 'self'`、`frame-ancestors 'none'`。
 *   `public/*.html`（文档站、入口页）带内联 `<script>`：这些文件按内容算 sha256 加进该响应的 script-src，
 *   所以不放开 unsafe-inline；改了文件哈希自动跟着变（按 mtime 缓存）。
 *
 * 【HSTS】只在 `req.secure` 为真时发 —— 即直连 TLS，或 Express `trust proxy` 已显式信任该连接对端且其
 *   `X-Forwarded-Proto: https`。与 ADR-0005/0023 同一信任判据；客户端自己写的 X-Forwarded-Proto 不算数。
 *   不带 preload（preload 不可撤回，交给部署方决定）。
 * ============================================================================
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runtimeMode } from '../runtime.js'
import { isSecureRequest } from '../lib/trust-proxy.js'

const MODES = new Set(['report', 'enforce', 'off'])
const HSTS = 'max-age=15552000; includeSubDomains'
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'

export function cspMode(env = process.env) {
  const raw = String(env.GML_CSP_MODE ?? '').trim()
  if (MODES.has(raw)) return raw
  try { return runtimeMode(env) === 'production' ? 'enforce' : 'report' } catch { return 'enforce' }
}

export function buildCsp({ scriptHashes = [] } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` ${h}`).join('')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}

const INLINE_SCRIPT = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi
export function inlineScriptHashes(html) {
  const out = []
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    if (/(?:^|\s)src\s*=/i.test(m[1] || '')) continue
    out.push(`'sha256-${crypto.createHash('sha256').update(m[2]).digest('base64')}'`)
  }
  return [...new Set(out)]
}

/** 请求路径 → 静态根下的 .html 文件（目录请求视为 index.html）；越界 / 非 html ⇒ null */
function staticHtmlFile(root, reqPath) {
  let p
  try { p = decodeURIComponent(reqPath) } catch { return null }
  if (p.includes('\0')) return null
  if (p.endsWith('/')) p += 'index.html'
  if (!p.toLowerCase().endsWith('.html')) return null
  const file = path.resolve(root, `.${p}`)
  return file.startsWith(root + path.sep) ? file : null
}

export function securityHeaders({ env = process.env, staticRoot } = {}) {
  const mode = cspMode(env)
  const header = mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'
  const root = staticRoot ? path.resolve(staticRoot) : null
  const cache = new Map() // file -> { mtimeMs, size, hashes }
  const hashesFor = (file) => {
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) return []
      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.hashes
      const hashes = inlineScriptHashes(fs.readFileSync(file, 'utf8'))
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, hashes })
      return hashes
    } catch { return [] }
  }
  const baseline = buildCsp()
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY)
    res.setHeader('X-Frame-Options', 'DENY')
    if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', HSTS)
    if (mode !== 'off') {
      let csp = baseline
      if (root && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = staticHtmlFile(root, req.path)
        const scriptHashes = file ? hashesFor(file) : []
        if (scriptHashes.length) csp = buildCsp({ scriptHashes })
      }
      res.setHeader(header, csp)
    }
    next()
  }
}
