/**
 * ============================================================================
 * 文件标识：src/api/client.ts ｜ 同源 API、后台/商城凭据隔离及统一失效处理
 * JSON、下载与原始协议请求共享认证快照；旧请求不能清除后登录的会话。
 * ============================================================================
 */
const TOKEN_KEY = 'gml_token'
const USER_KEY = 'gml_user'
const INDUSTRY_KEY = 'gml_industry'
const GENERATION_KEY = 'os_egp_session_generation'
const NOTICE_KEY = 'os_egp_session_notice'
const MALL_TOKEN_KEY = 'gml_mall_token'
const MALL_GENERATION_KEY = 'os_egp_mall_generation'
export const AUTH_CHANGED_EVENT = 'os-egp:auth-changed'
export const FEATURE_DISABLED_EVENT = 'os-egp:feature-disabled'
/** Cookie transport (ADR-0036): the JWT lives only in an HttpOnly cookie; localStorage keeps this non-secret marker so tab sync and 401 handling work unchanged. */
export const COOKIE_SESSION_MARKER = '__os_erp_cookie_session__'
const CSRF_COOKIE = 'gml_csrf'
export type AuthSnapshot = { token: string; generation: string }

const changed = () => window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT))
const generation = () => [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join('')
export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const getIndustry = () => localStorage.getItem(INDUSTRY_KEY) || ''
export const getSessionNotice = () => localStorage.getItem(NOTICE_KEY) || ''
export const getAuthSnapshot = (): AuthSnapshot => ({ token: getToken(), generation: localStorage.getItem(GENERATION_KEY) || '' })
export const isCurrentSession = (snapshot: AuthSnapshot) => snapshot.token === getToken() && snapshot.generation === (localStorage.getItem(GENERATION_KEY) || '')
export function dismissSessionNotice() { localStorage.removeItem(NOTICE_KEY); changed() }
export function noticeWhenLoggedOut(message: string) {
  if (!getToken()) { localStorage.setItem(NOTICE_KEY, message); changed() }
}
export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { return null }
}
/** One notification after all fields are ready. Never broadcast credentials in event payloads. */
export function setSession(token: string, user: any, industry: string) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  if (industry) localStorage.setItem(INDUSTRY_KEY, industry)
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(GENERATION_KEY, generation())
  localStorage.removeItem(NOTICE_KEY)
  changed()
}
export function setCookieSession(user: any, industry: string) { setSession(COOKIE_SESSION_MARKER, user, industry) }
function csrfToken() {
  const pair = (typeof document === 'undefined' ? '' : document.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${CSRF_COOKIE}=`))
  if (!pair) return ''
  try { return decodeURIComponent(pair.slice(CSRF_COOKIE.length + 1)) } catch { return '' }
}
export function setToken(token: string) {
  localStorage.removeItem(USER_KEY)
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(GENERATION_KEY, generation())
  changed()
}
export function setUser(user: any, expected?: AuthSnapshot) {
  if (expected && !isCurrentSession(expected)) return false
  localStorage.setItem(USER_KEY, JSON.stringify(user)); changed(); return true
}
export function setIndustry(code: string) {
  if (code) { localStorage.setItem(INDUSTRY_KEY, code); changed() }
}
export function clearToken(expected?: AuthSnapshot, notice = '') {
  if (expected && !isCurrentSession(expected)) return false
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.setItem(GENERATION_KEY, generation())
  if (notice) localStorage.setItem(NOTICE_KEY, notice)
  else localStorage.removeItem(NOTICE_KEY)
  changed()
  return true
}
export function subscribeAuth(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return
    if (event.key === null || [TOKEN_KEY, USER_KEY, INDUSTRY_KEY, GENERATION_KEY, NOTICE_KEY].includes(event.key)) listener()
  }
  window.addEventListener(AUTH_CHANGED_EVENT, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(AUTH_CHANGED_EVENT, listener); window.removeEventListener('storage', storage) }
}
export const getMallToken = () => localStorage.getItem(MALL_TOKEN_KEY) || ''
export function setMallToken(token: string) {
  if (token) localStorage.setItem(MALL_TOKEN_KEY, token)
  else localStorage.removeItem(MALL_TOKEN_KEY)
  localStorage.setItem(MALL_GENERATION_KEY, generation())
}

export class ApiError extends Error {
  code?: string
  constructor(message: string, public status: number, public detail?: any) { super(message); this.code = detail?.code }
}

/** Only API-relative paths are accepted; redirects cannot forward a mall header to another origin. */
function apiUrl(path: string) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || path.startsWith('//') || /[\\#\r\n]/.test(path)) {
    throw new ApiError('只允许本站 API 相对路径', 0)
  }
  const url = new URL(`/api${path}`, window.location.origin)
  if (url.origin !== window.location.origin || (url.pathname !== '/api' && !url.pathname.startsWith('/api/'))) {
    throw new ApiError('API 路径超出本站接口范围', 0)
  }
  return url
}
function prepare(path: string, options: RequestInit = {}, json = true) {
  const url = apiUrl(path)
  const isMall = /^\/api\/mall(?:\/|$)/i.test(url.pathname)
  const isLogin = /^\/api\/(?:auth|mall)\/login\/?$/i.test(url.pathname)
  const snapshot = getAuthSnapshot()
  const mall = { token: getMallToken(), generation: localStorage.getItem(MALL_GENERATION_KEY) || '' }
  const headers = new Headers(options.headers)
  headers.delete('Authorization'); headers.delete('x-mall-token'); headers.delete('x-industry'); headers.delete('x-csrf-token')
  if (json) headers.set('Content-Type', 'application/json')
  if (!isLogin) {
    if (isMall && mall.token) headers.set('x-mall-token', mall.token)
    else if (!isMall && snapshot.token === COOKIE_SESSION_MARKER) {
      // Cookie transport: the browser attaches the session cookie; unsafe methods must echo the CSRF cookie (double submit).
      if (!/^(?:GET|HEAD|OPTIONS)$/i.test(options.method || 'GET')) { const csrf = csrfToken(); if (csrf) headers.set('x-csrf-token', csrf) }
    } else if (!isMall && snapshot.token) headers.set('Authorization', `Bearer ${snapshot.token}`)
  }
  const industry = getIndustry()
  if (industry) headers.set('x-industry', industry)
  return { url, isMall, isLogin, snapshot, mall, options: { ...options, headers, redirect: 'error' as const, credentials: 'same-origin' as const } }
}
type RequestContext = ReturnType<typeof prepare>
const businessCode = (data: any) => data?.detail?.code || (typeof data?.code === 'string' ? data.code : data?.error)
function responseEffects(context: RequestContext, res: Response, data: any) {
  const code = businessCode(data)
  if (code === 'FEATURE_DISABLED') {
    window.dispatchEvent(new CustomEvent(FEATURE_DISABLED_EVENT, { detail: {
      capability: typeof data?.detail?.capability === 'string' ? data.detail.capability : undefined
    } }))
  }
  if (res.status !== 401 || context.isLogin) return
  if (context.isMall) {
    if (context.mall.token && context.mall.token === getMallToken() && context.mall.generation === (localStorage.getItem(MALL_GENERATION_KEY) || '')) setMallToken('')
  } else if (context.snapshot.token) {
    clearToken(context.snapshot, code === 'SESSION_REVOKED' ? '后台会话已被撤销，请重新登录。' : '后台登录已失效，请重新登录。')
  }
}
async function jsonResponse(context: RequestContext, res: Response, raw = false) {
  let text: string
  try { text = await res.text() } catch {
    responseEffects(context, res, null)
    throw new ApiError(`响应读取失败 (${res.status})`, res.status)
  }
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch {
    responseEffects(context, res, null)
    throw new ApiError(res.ok ? '返回数据格式异常' : `请求失败 (${res.status})`, res.status)
  }
  responseEffects(context, res, data)
  const code = businessCode(data)
  if (!res.ok || (!raw && data?.success === false) || code === 'FEATURE_DISABLED') {
    const detail = typeof code === 'string' ? { ...data?.detail, code } : data?.detail
    throw new ApiError(data?.message || `请求失败 (${res.status})`, res.status, detail)
  }
  return data
}
async function request(path: string, options: RequestInit = {}, raw = false) {
  const context = prepare(path, options)
  return jsonResponse(context, await fetch(context.url.href, context.options), raw)
}
function queryOf(params?: Record<string, any>) {
  if (!params) return ''
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  return qs ? `?${qs}` : ''
}
async function download(path: string, params?: Record<string, any>, fallbackName = 'download') {
  const context = prepare(`${path}${queryOf(params)}`, {}, false)
  const res = await fetch(context.url.href, context.options)
  if (!res.ok) return jsonResponse(context, res)
  if ((res.headers.get('content-type') || '').includes('application/json')) await jsonResponse(context, res.clone())
  const cd = res.headers.get('content-disposition') || ''
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  let name = plain ? plain[1].trim() : fallbackName
  if (star) { try { name = decodeURIComponent(star[1].trim()) } catch { /* malformed server filename: use fallback */ } }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  try {
    a.href = url; a.download = name; document.body.appendChild(a); a.click()
  } finally { a.remove(); URL.revokeObjectURL(url) }
  return { filename: name, size: blob.size }
}
export const api = {
  get: (path: string, params?: Record<string, any>) => request(`${path}${queryOf(params)}`),
  download,
  post: (path: string, body?: any, options: RequestInit = {}) => request(path, { ...options, method: 'POST', body: JSON.stringify(body || {}) }),
  /** Preserve protocol-level 200 bodies; transport/authentication failures still use the common policy. */
  rawPost: (path: string, body?: any) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }, true),
  put: (path: string, body?: any) => request(path, { method: 'PUT', body: JSON.stringify(body || {}) }),
  del: (path: string, body?: any) => request(path, { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
export const unwrap = (res: any) => res?.data
export default api
