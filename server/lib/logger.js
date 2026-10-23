/**
 * ============================================================================
 * 文件标识：server/lib/logger.js ｜ 结构化日志（每事件一行 JSON）+ 请求号（x-request-id）中间件
 * ============================================================================
 * 【职责】服务端日志的唯一出口：`{ts, level, msg, req_id, user_id, industry, route, status, duration_ms, incident_id, ...}`。
 *   每个字段都过 `lib/redact.js`（凭据键遮盖 / token= 剥离 / 手机号部分遮盖），调用点不自己脱敏。
 *
 * 【设计】
 *   · 格式 `GML_LOG_FORMAT=json|text`：生产默认 json；demo / test 默认 text（`[level] msg k=v`，
 *     保持既有按字符串匹配日志的测试与人读习惯）。非法值回落默认，不抛（日志不能把进程打挂）。
 *   · 级别 `GML_LOG_LEVEL=debug|info|warn|error`，默认 info。error→console.error，warn→console.warn，其余→console.log；
 *     每次调用时才取 console 方法，所以测试 / 守卫脚本替换 console.error 仍能观测到。
 *   · 请求号：入站 `x-request-id` 只在 Express `trust proxy` 已显式信任该连接对端时采纳（与登录节流同一策略：
 *     默认不信任任何转发头）；否则忽略并自己生成。格式不合（非 [A-Za-z0-9._-]{8,64}）也重新生成，防日志注入。
 *   · 请求号放进 AsyncLocalStorage，audit / MCP 审计失败等深层调用点无需传参就带上 req_id。
 *
 * 【注意】本文件只做**记录**，不改变任何响应或业务行为。msg 应是固定短句，变量放字段里。
 * ============================================================================
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { runtimeMode } from '../runtime.js'
import { redactValue, redactText, redactUrl } from './redact.js'

const als = new AsyncLocalStorage()
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const RESERVED = new Set(['ts', 'level', 'msg'])
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

export function logFormat(env = process.env) {
  const v = env.GML_LOG_FORMAT
  if (v === 'json' || v === 'text') return v
  let mode = 'production'
  try { mode = runtimeMode(env) } catch { /* 非法模式由别处报错，这里按最严格默认 */ }
  return mode === 'production' ? 'json' : 'text'
}

function minLevel(env = process.env) {
  return LEVELS[env.GML_LOG_LEVEL] ?? LEVELS.info
}

function plainError(err) {
  return { name: err.name, code: err.code, message: err.message, stack: err.stack }
}

function normalize(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields || {})) {
    if (RESERVED.has(k) || v === undefined) continue
    out[k] = v instanceof Error ? plainError(v) : v
  }
  return redactValue(out)
}

function textValue(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v)
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function emit(level, msg, fields) {
  if (LEVELS[level] < minLevel()) return
  const ctx = als.getStore()
  const merged = { ...(ctx?.req_id ? { req_id: ctx.req_id } : {}), ...(fields || {}) }
  const safe = normalize(merged)
  const text = redactText(msg)
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (logFormat() === 'json') {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg: text, ...safe }))
    return
  }
  const { err, ...rest } = safe
  const kv = Object.entries(rest).map(([k, v]) => `${k}=${textValue(v)}`).join(' ')
  const line = `[${level}] ${text}${kv ? ' ' + kv : ''}`
  if (err) sink(line, err.stack || err.message || textValue(err))
  else sink(line)
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields)
}

/** 入站请求号是否可采纳：连接对端被 `trust proxy` 显式信任 + 格式合法 */
function inboundRequestId(req) {
  const raw = req.headers['x-request-id']
  if (typeof raw !== 'string' || !REQUEST_ID.test(raw)) return null
  const trusts = req.app?.get?.('trust proxy fn')
  return typeof trusts === 'function' && trusts(req.socket?.remoteAddress, 0) ? raw : null
}

function routeOf(req) {
  if (req.route?.path !== undefined) return `${req.baseUrl || ''}${req.route.path}`
  return redactUrl(String(req.originalUrl || req.url || '').split('?')[0])
}

/** 最先挂载：分配 / 透传请求号、回写响应头、结束时记一行访问日志（健康检查降为 debug） */
export function requestLogger(req, res, next) {
  const reqId = inboundRequestId(req) || randomUUID()
  req.id = reqId
  res.setHeader('x-request-id', reqId)
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const health = String(req.originalUrl || '').split('?')[0] === '/api/meta/health'
    als.run({ req_id: reqId }, () => {
      emit(health ? 'debug' : 'info', 'request', {
        method: req.method,
        route: routeOf(req),
        status: res.statusCode,
        duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        user_id: req.user?.uid ?? null,
        industry: res.locals?.industry ?? null,
        ...(res.locals?.incident_id ? { incident_id: res.locals.incident_id } : {})
      })
    })
  })
  als.run({ req_id: reqId }, next)
}
