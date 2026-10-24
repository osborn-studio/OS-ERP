/**
 * ============================================================================
 * 文件标识：server/mcp/server.js ｜ MCP 服务端：以标准 MCP（2026-07-28 无状态版）暴露系统业务能力
 * ============================================================================
 * 【职责】MCP 服务端：以标准 MCP（2026-07-28 无状态版）暴露系统业务能力
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// MCP 服务端：以标准 MCP（2026-07-28 无状态版）暴露系统业务能力
//
// 端点：POST /mcp        （也挂载 /api/mcp 便于浏览器端调试）
// 协议：JSON-RPC 2.0；同时兼容 Mcp-Method / Mcp-Name 请求头形式（无状态传输）
//
// 支持方法：initialize / notifications/initialized / ping / tools/list / tools/call
//           resources/list / resources/read / prompts/list / prompts/get
//
// 三级执行链（第三轮 A1）：
//   read   直接执行
//   write  必须有 idempotency_key；重复键直接返回首次结果（不重复扣减库存）
//   danger 必须带已人工确认的 confirm_token，否则返回 409 并生成待确认单

import { Router } from 'express'
import crypto from 'node:crypto'
import { getDb, runWithIndustry, getCurrentIndustry, assertIndustry, showValue } from '../db/index.js'
import { localNow } from '../lib/dates.js'
import { TOOLS, TOOL_MAP, toolToMcp } from './tools.js'
import { validateToolArgs } from './validate.js'
import { extractToken, verifyToken, tokenScopes, tokenAllow, tokenDeny, touchToken, SCOPE_LABEL } from './tokens.js'
import { resolveDelegation, effectiveScope, ownerToolDenied, scopeCovers, scopeSnapshot, permSnapshot, permsCovered } from './delegation.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import * as engine from '../lib/stock.js'
import { versionInfo } from '../version.js'
import { logger } from '../lib/logger.js'
import { incCounter, incMcpToolCall, registerMcpTools } from '../lib/process-counters.js'
import { bizFail } from '../lib/http.js'
import { createMcpRateLimiter } from '../lib/mcp-rate-limit.js'

const r = Router()

const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = {
  name: 'gml-supply-chain',
  title: 'GML 供应链协同系统',
  // 与 /api、/api/meta/health、AI manifest 同一份版本与构建 SHA
  ...versionInfo(),
  description: '原生 MCP：业务能力从系统内核直接暴露，而非外挂在传统 ERP 之上。'
}

// ============================================================
// 调用身份判定：工具与资源必须走**同一套**白/黑名单
// ============================================================
// 原来 resources/read 是一段独立的代码：直接把 URI 映射到工具名后调 handler，
// 完全不过 allow/deny（实测：工具白名单里没有、黑名单里明明禁了的
// `inventory.stock_alert`，`resources/read gml://inventory/alert` 照样把数据吐出来）。
// 「同一份数据有两个读入口，只挡了一个」——这就是漏洞的形状。
// 现在两个入口共用 checkToolAccess，资源只是一个"URI → 工具名"的别名。
// 第四道闸（ADR-0011）：有主令牌的所有者**此刻**必须持有工具声明的权限点（`tool.perms`）——
// 令牌能做的事 = 令牌声明范围 ∩ 所有者当前权限。tools/list、resources/list、resources/read、tools/call
// 全走这一个函数：列得出的就调得到，调不到的也列不出。
function checkToolAccess(tool, { scopes, allow, deny, delegation = null }) {
  if (!tool) return { code: 'TOOL_NOT_FOUND', message: '未知工具' }
  if (!scopes.includes(tool.level)) {
    return {
      code: 'SCOPE_DENIED',
      message: `该 Token 的权限范围为 [${scopes.join(',')}]，不足以调用 ${tool.level} 级工具「${tool.title}」`
    }
  }
  if (allow && !allow.includes(tool.name)) return { code: 'TOOL_NOT_ALLOWED', message: `该 Token 的白名单不含 ${tool.name}` }
  if (deny.includes(tool.name)) return { code: 'TOOL_DENIED', message: `该 Token 被禁止调用 ${tool.name}` }
  return ownerToolDenied(delegation, tool)
}

// 资源 → 工具。资源不是"另一条数据通道"，只是工具的一个别名。
const RESOURCES = [
  { uri: 'gml://dashboard/kpi', name: '经营看板 KPI', tool: 'report.dashboard_kpi' },
  { uri: 'gml://org/tree', name: '组织主体树', tool: 'org.tree' },
  { uri: 'gml://inventory/alert', name: '库存预警清单', tool: 'inventory.stock_alert' },
  { uri: 'gml://meta/params', name: '库存与成本参数', tool: 'inventory.meta_params' }
]
const RESOURCE_TOOL = Object.fromEntries(RESOURCES.map((x) => [x.uri, x.tool]))

// 没有对应业务工具的直读资源，用虚拟工具描述补齐 —— 让它**照样**过权限门，
// 而不是像原来那样在 resources/read 里绕过映射表直接查库。
const VIRTUAL_TOOLS = {
  'inventory.meta_params': {
    name: 'inventory.meta_params',
    title: '库存与成本参数',
    level: 'read',
    inputSchema: { type: 'object', properties: {} },
    handler: ({ db }) => ({ data: db.prepare('SELECT param_key, param_value, remark FROM inv_params ORDER BY id').all() })
  }
}
registerMcpTools([...TOOLS.map((t) => t.name), ...Object.keys(VIRTUAL_TOOLS)])
function resolveTool(name) {
  return TOOL_MAP.get(name) || VIRTUAL_TOOLS[name] || null
}

// ============================================================
// 参数指纹：确认单绑定与幂等冲突判定共用
// ============================================================
// 为什么确认单必须绑参数：实测「A 令牌申请（price 111）→ 人工批准 → B 令牌把参数改成
// price 999 再执行」，落库的是 999 —— 被批准的 111 只是"一张纸"。
// 确认的意义是"确认这一组参数"，所以参数必须参与比对，且执行时要用确认单里的那份。
const CONTROL_ARGS = new Set(['confirm_token', '__confirmed'])

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

function argsFingerprint(args) {
  const clean = {}
  for (const k of Object.keys(args || {}).sort()) {
    if (CONTROL_ARGS.has(k)) continue
    clean[k] = args[k]
  }
  return crypto.createHash('sha256').update(stableStringify(clean)).digest('hex')
}

// ============================================================
// 工具执行
// ============================================================

// ---- 速率限制与日配额（ADR-0056 / AD9）----
// 键 = 验签后的令牌行 id（不读请求体 / 头 / IP）。超限 ⇒ HTTP 429 + `Retry-After`，业务码 `MCP_RATE_LIMITED` 由 `bizFail` 构造（唯一构造点），
// 同时保留 JSON-RPC 外壳（jsonrpc / id）与工具级错误的 `result.isError` 形态，MCP 客户端仍能把原因交给模型。
// 被限流的调用不写审计行（否则洪泛会变成对 SQLite 的写放大），只进进程内计数器 `os_erp_mcp_tool_calls_total{code="MCP_RATE_LIMITED"}`。
const mcpLimiter = createMcpRateLimiter()
/** 后台定时器入口（server/index.js）：清理某个行业库里的过期限速桶（memory 模式为空操作） */
export function purgeMcpRateBuckets(db) { return mcpLimiter.purge(db) }
export const mcpRateStore = mcpLimiter.policy.store
/** 清理周期（毫秒）：默认 60000；仅测试模式可经 GML_TEST_MCP_RATE_PURGE_MS 缩短 */
export const mcpRatePurgeMs = mcpLimiter.policy.purgeMs
const RATE_TEXT = {
  rpm: (d) => `该 Token 每分钟调用已达上限（${mcpLimiter.policy.rpm} 次），请 ${d.retryAfter} 秒后重试`,
  write_rpm: (d) => `该 Token 每分钟写型调用已达上限（${mcpLimiter.policy.writeRpm} 次），请 ${d.retryAfter} 秒后重试`,
  daily_quota: (d) => `该 Token 今日调用已达配额（${d.quota} 次），请次日再试或联系管理员调整`,
  store_unavailable: () => '限流存储（mcp_rate_buckets）写入失败，为安全起见拒绝本次调用，请稍后重试或联系管理员',
  unavailable: () => '限流状态暂不可用，为安全起见拒绝本次调用，请稍后重试'
}

function rateLimited(res, id, tool, d) {
  incMcpToolCall(tool?.name, 'MCP_RATE_LIMITED')
  const reason = ['daily_quota', 'rpm', 'write_rpm', 'store_unavailable'].includes(d.reason) ? d.reason : 'unavailable'
  const retryAfter = Math.max(1, Math.floor(d.retryAfter || 1))
  const err = Object.assign(new Error(RATE_TEXT[reason]({ ...d, retryAfter })), {
    code: 'MCP_RATE_LIMITED', status: 429, detail: { reason, retry_after: retryAfter }
  })
  const cap = { status: 429, body: null }
  bizFail({ status(s) { cap.status = s; return this }, json(b) { cap.body = b; return this } }, err)
  res.set('Retry-After', String(retryAfter))
  // JSON-RPC 要求 `error` 与 `result` 二选一，所以这里**不带**顶层 `error` 字符串：业务码在 `detail.code`（bizFail 约定）与 result 文本里。
  const { error: _code, ...biz } = cap.body
  return res.status(cap.status).json({
    jsonrpc: '2.0',
    id,
    ...biz,
    result: { content: [{ type: 'text', text: JSON.stringify({ error: 'MCP_RATE_LIMITED', message: cap.body.message, detail: cap.body.detail }, null, 2) }], isError: true }
  })
}

/** 速率 + 日配额的一次判定；通过返回 null，否则返回拒绝详情 */
function mcpBudget(db, tokenId, level) {
  const scope = getCurrentIndustry() ?? '' // 令牌 id 在各行业库里各自编号，限流键必须带库标识
  const rate = mcpLimiter.consume(tokenId, level, scope, db)
  if (!rate.allowed) return rate
  const q = mcpLimiter.daily(db, tokenId, scope)
  return q.allowed ? null : q
}

// 凭据 / 协议层错误。`data.code` 是给客户端程序判定用的**稳定业务码**（ADR-0011），
// `message` 是给人看的；只给 message 的话客户端只能靠字符串匹配中文。
function rpcError(res, id, code, message, stableCode = null) {
  const error = { code, message }
  if (stableCode) error.data = { code: stableCode }
  return res.json({ jsonrpc: '2.0', id, error })
}

// 工具级错误：按 MCP 规范走 result.isError，而不是 JSON-RPC error。
// 区别很重要：JSON-RPC error 表示「协议/传输层出问题」（客户端应重试或换凭据），
// result.isError 表示「工具执行了但失败了」（客户端应把原因交给模型处理）。
function toolError(res, id, code, message, detail = null) {
  return res.json({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ error: code, message, detail }, null, 2) }],
      isError: true
    }
  })
}

function textResult(data, summary) {
  const payload = summary ? { summary, ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { data }) } : data
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }
}

// ---- 调用审计（F13）----
// 入库前脱敏：键名命中 /password|secret|token|authorization|key/i 的值一律打码（递归到嵌套对象 / 数组）。
// `idempotency_key` 也会被打码 —— 它有自己的专用列 `idempotency_key`，args 里不必再留一份明文。
const SENSITIVE_KEY = /password|secret|token|authorization|key/i
const MASK = '***'
export function redactArgs(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map((v) => redactArgs(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? MASK : redactArgs(v, depth + 1)
  return out
}

/** 审计写入的**唯一**语句。失败即抛 `AUDIT_UNAVAILABLE`，由调用方决定是回滚（写型）还是记错继续（只读）。 */
function insertCallLog(db, { token, tool, ok, errorCode, errorMessage, args, summary, durationMs, ip, idemKey }) {
  let inserted
  try {
    inserted = db.prepare(`
      INSERT INTO mcp_call_logs (token_id, token_name, tool_name, level, ok, error_code, error_message,
                                 args, result_summary, duration_ms, ip, idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      token?.id ?? null, token?.name ?? null, tool?.name ?? null, tool?.level ?? null,
      ok ? 1 : 0, errorCode ?? null, errorMessage ?? null,
      JSON.stringify(redactArgs(args ?? {})).slice(0, 4000), summary ? String(summary).slice(0, 500) : null,
      durationMs ?? null, ip ?? null, idemKey ?? null
    )
  } catch (e) {
    const err = new Error(`调用审计暂不可用，操作未提交：${e?.message ?? e}`)
    err.code = 'AUDIT_UNAVAILABLE'
    err.status = 503
    incCounter('audit_strict_write_failures_total', 'mcp_call_log')
    throw err
  }
  if (inserted.changes !== 1) {
    const err = new Error('调用审计未落行，操作未提交')
    err.code = 'AUDIT_UNAVAILABLE'
    err.status = 503
    incCounter('audit_strict_write_failures_total', 'mcp_call_log')
    throw err
  }
  incMcpToolCall(tool?.name, ok ? null : errorCode ?? 'other') // AB10：仅审计行落地的调用计数；label 在计数器内折成封闭集合
}

/**
 * best-effort 审计：只读工具与"已经失败"的路径用它 —— 没有业务行需要保护，
 * 但失败**必须可见**（原来是静默吞掉：审计表坏了，所有调用照常、一条记录都没有、没人知道）。
 */
function logCall(db, entry) {
  try {
    insertCallLog(db, entry)
  } catch (e) {
    logger.error('mcp call audit write failed', { component: 'mcp', tool: entry?.tool?.name ?? '-', outcome: entry?.errorCode ?? (entry?.ok ? 'ok' : 'fail'), err_message: e.message })
  }
}

/** 严格审计：写型 / 高危工具的成功路径用它，**与业务过账同一事务**，写不进去就一起回滚。 */
function auditOrThrow(db, entry) {
  insertCallLog(db, entry)
}

// ---- Z8：缓存 / 确认单命中前重验（ADR-0011 Z8 补充）----
// 闸门（凭据 → 令牌级别/白黑名单 → 所有者权限点 → 入参）在幂等缓存与确认单查询**之前**就已全部重跑；
// 它们拒绝时本来就返回"当前错误"，这里只补一件事：**让审计看得出这次拒绝挡住了一份本可回放的缓存**。
export const CACHE_DENIED = 'cache_denied'
function cacheDeniedMark(db, row, tool, args) {
  try {
    if (tool?.level === 'write' && args?.idempotency_key) {
      const hit = db
        .prepare('SELECT 1 AS x FROM mcp_idempotency WHERE idempotency_key=? AND token_id=? AND tool_name=?')
        .get(String(args.idempotency_key), row.id, tool.name)
      if (hit) return `${CACHE_DENIED}：幂等缓存未被回放`
    } else if (tool?.level === 'danger' && args?.confirm_token) {
      const hit = db
        .prepare("SELECT 1 AS x FROM mcp_confirmations WHERE confirm_token=? AND token_id=? AND tool_name=? AND status='confirmed'")
        .get(String(args.confirm_token), row.id, tool.name)
      if (hit) return `${CACHE_DENIED}：已确认的二次确认单未被消费`
    }
  } catch {
    // 标记只是审计的附加信息，查不到不影响拒绝本身
  }
  return undefined
}

/** 缓存行 = `{__replay, scope, data}`；Z8 之前写入的旧行是裸 data，范围未知（scope=null ⇒ 受限范围下不回放）。 */
function parseCachedResult(json) {
  let v
  try {
    v = JSON.parse(json || '{}')
  } catch {
    v = {}
  }
  if (v && typeof v === 'object' && v.__replay === 1 && 'data' in v) return { scope: v.scope ?? null, perms: v.perms ?? null, data: v.data }
  return { scope: null, perms: null, data: v }
}

function cacheDeniedFields(db, row, tool, args) {
  const summary = cacheDeniedMark(db, row, tool, args)
  if (!summary) return {}
  return { summary, ...(tool.level === 'write' ? { idemKey: String(args.idempotency_key) } : {}) }
}

function buildContext(db, row, delegation) {
  // 数据权限（ADR-0011）：令牌绑定主体的范围 ∩ 所有者**当前**数据范围（无主令牌 = 令牌范围）。
  // 判据在 `delegation.js`，这里只取结果。
  const scope = effectiveScope(db, row, delegation)
  return { db, orgId: row.org_id ?? null, tokenName: row.name, scope, engine, ownerUserId: row.owner_user_id ?? null }
}

// ============================================================
// 主入口
// ============================================================

r.post('/', (req, res) => {
  const body = req.body || {}
  const method = String(req.headers['mcp-method'] || body.method || '')
  const id = body.id !== undefined ? body.id : null
  const params = body.params || (req.body?.arguments ? { name: req.headers['mcp-name'], arguments: req.body.arguments } : {})

  // ---- 握手与心跳：不需要鉴权（标准 MCP 客户端先握手再带凭据）----
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: SERVER_INFO,
        instructions:
          '本服务为企业供应链系统原生 MCP。调用前需在 Authorization 头携带 Agent Token（gml_ 开头）。' +
          '工具分三级：read 查询 / write 事务（需 idempotency_key）/ danger 高危（需人工二次确认）。'
      }
    })
  }
  if (method === 'notifications/initialized') return res.status(202).end()
  if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} })

  // ---- 以下一律需要 Agent Token ----
  const raw = extractToken(req)
  const authDb = getDb()
  const v = verifyToken(authDb, raw)
  if (v.error) {
    const known = {
      missing_token: ['TOKEN_MISSING', '缺少 Agent Token（只认 Authorization: Bearer gml_xxx，不收查询串 / 其他请求头）'],
      invalid_token: ['TOKEN_INVALID', 'Agent Token 无效'],
      revoked: ['TOKEN_REVOKED', 'Agent Token 已被吊销'],
      expired: ['TOKEN_EXPIRED', 'Agent Token 已过期'],
      rate_limited: ['TOKEN_RATE_LIMITED', `调用超限（近 1 小时已达 ${v.used} 次）`]
    }[v.error] || ['TOKEN_INVALID', String(v.error)]
    return rpcError(res, id, -32001, known[1], known[0])
  }
  const row = v.row

  // 委托判定（ADR-0011）：有主令牌 = 所有者的委托。所有者不存在 / 已停用 / 安全版本已变 ⇒
  // **所有**方法（含只读工具、资源、提示）一律拒绝；判据与令牌行在同一个库里查。
  const delegation = resolveDelegation(authDb, row)
  if (delegation.error) {
    logCall(authDb, { token: row, tool: { name: method }, ok: false, errorCode: delegation.error.code, args: {}, ip: req.ip })
    return rpcError(res, id, -32001, delegation.error.message, delegation.error.code)
  }

  // 行业上下文按 Token 绑定决定。**两条判据**（与 db/index.js 同源）：
  //   · 令牌行**没登记**行业（`null` / 空）⇒ 落到当前请求行业（合法语义，Token 未绑定行业）；
  //   · 令牌行登记了一个**非法码** ⇒ **拒绝**（下面 rpcError）。
  //     旧写法对非法值落 `getCurrentIndustry()` —— 这是**不确定行为**：同一张坏令牌
  //     在任意行业头下都"能查"，且永远不报错，行业实际指向哪只由请求方当场决定。
  let industry
  try {
    industry = assertIndustry(row.industry) ?? getCurrentIndustry()
  } catch (e) {
    // `e.message` 已由 `db/index.js` 的 `showValue` 消毒（`{toString:null}` 这类值不会让回显自己抛）；
    // 但这里仍用 `showValue` 兜一层 —— 万一将来换成别的异常、或抛的不是 Error（没有 `.message`），
    // 直接把用户可控值插进模板字符串就会**在错误路径上又抛一次**（正是本线刚修的那类形态）。
    return rpcError(res, id, -32001, `Token 绑定的行业码无效，拒绝执行：${showValue(e?.message ?? e)}`)
  }

  return runWithIndustry(industry, () => {
    const db = getDb()
    const ctx = buildContext(db, row, delegation)
    const scopes = tokenScopes(row)
    const allow = tokenAllow(row)
    const deny = tokenDeny(row)
    // 工具 / 资源可见性与可调用性的**同一份**判定（级别 + 白黑名单 + 所有者当前权限）
    const gate = { scopes, allow, deny, delegation }

    // ---------- tools/list ----------
    if (method === 'tools/list') {
      const visible = TOOLS.filter((t) => !checkToolAccess(t, gate))
      return res.json({ jsonrpc: '2.0', id, result: { tools: visible.map(toolToMcp) } })
    }

    // ---------- resources ----------
    // 只列出**本令牌真的拿得到**的资源：列的出、读的到，两者用同一个判定。
    if (method === 'resources/list') {
      const visible = RESOURCES.filter((x) => !checkToolAccess(resolveTool(x.tool), gate))
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          resources: visible.map((x) => ({ uri: x.uri, name: x.name, mimeType: 'application/json' }))
        }
      })
    }
    if (method === 'resources/read') {
      const uri = String(params?.uri || '')
      const toolName = RESOURCE_TOOL[uri]
      if (!toolName) return rpcError(res, id, -32602, `未知资源：${uri}`)
      const tool = resolveTool(toolName)
      const limited = mcpBudget(db, row.id, 'read')
      if (limited) return rateLimited(res, id, tool, limited)
      const denied = checkToolAccess(tool, gate)
      if (denied) {
        logCall(db, { token: row, tool, ok: false, errorCode: denied.code, args: { uri }, ip: req.ip })
        return rpcError(res, id, -32003, denied.message)
      }
      try {
        const out = tool.handler({ db, args: {}, ctx })
        logCall(db, { token: row, tool, ok: true, args: { uri }, summary: `resources/read ${uri}`, ip: req.ip })
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(out.data, null, 2) }] }
        })
      } catch (e) {
        return rpcError(res, id, -32603, e.message)
      }
    }

    // ---------- prompts ----------
    if (method === 'prompts/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          prompts: [
            { name: 'stock_health_check', title: '库存健康检查', description: '分析库存是否健康：缺货、超储、临期、呆滞', arguments: [] },
            { name: 'sales_review', title: '销售复盘', description: '给定时间范围复盘销售表现与渠道结构', arguments: [{ name: 'period', description: '时间范围，如 本月', required: false }] },
            { name: 'purchase_suggestion', title: '补货建议', description: '结合安全库存与在途采购给出补货建议', arguments: [] },
            { name: 'order_full_trace', title: '单据全链路追溯', description: '追溯一张单据从创建到出入库的全过程', arguments: [{ name: 'doc_no', description: '单据号', required: true }] }
          ]
        }
      })
    }
    if (method === 'prompts/get') {
      const name = params?.name
      const a = params?.arguments || {}
      const TEXT = {
        stock_health_check:
          '请调用 inventory.stock_alert 与 inventory.list_batches 工具，检查当前库存健康状况，' +
          '分别列出：1) 低于安全库存的商品；2) 未来 90 天临期批次；3) 已过保批次；并给出处理优先级建议。',
        sales_review:
          `请调用 report.sales_summary（group_by 分别取 channel 与 store）复盘${a.period || '本月'}销售情况，` +
          '指出增长/下滑最明显的渠道与门店，并分析可能原因。',
        purchase_suggestion:
          '请调用 inventory.stock_alert 与 purchase.list_orders，结合安全库存、当前库存与在途采购量，' +
          '给出需要补货的商品清单与建议采购数量。',
        order_full_trace:
          `请调用 order.trace_document，doc_no=${a.doc_no || '<单据号>'}，说明该单据当前走到哪一步、涉及哪些库存流水。`
      }
      if (!TEXT[name]) return rpcError(res, id, -32602, `未知提示：${name}`)
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          description: name,
          messages: [{ role: 'user', content: { type: 'text', text: TEXT[name] } }]
        }
      })
    }

    // ---------- tools/call ----------
    if (method !== 'tools/call') return rpcError(res, id, -32601, `不支持的方法：${method}`)

    const toolName = String(req.headers['mcp-name'] || params?.name || '')
    const args = params?.arguments || {}
    const started = Date.now()
    const ip = req.ip

    const tool = TOOL_MAP.get(toolName)
    // 限流在一切工具判定之前：未知工具、无权限、参数非法的调用同样占额度（猜工具名 / 撞权限也受限）
    const limited = mcpBudget(db, row.id, tool?.level)
    if (limited) return rateLimited(res, id, tool, limited)
    if (!tool) {
      logCall(db, { token: row, tool: { name: toolName }, ok: false, errorCode: 'TOOL_NOT_FOUND', args, ip })
      return toolError(res, id, 'TOOL_NOT_FOUND', `未知工具：${toolName}`)
    }

    // 权限范围校验（与 resources/read 同一份判定；含所有者当前权限点）
    const access = checkToolAccess(tool, gate)
    if (access) {
      logCall(db, { token: row, tool, ok: false, errorCode: access.code, args, ip, ...cacheDeniedFields(db, row, tool, args) })
      return toolError(res, id, access.code, access.message)
    }

    // 入参校验（唯一实现，见 mcp/validate.js）：必填 + 类型 + 枚举 + 范围 + 未知字段。
    // 原来只有"必填"这一条，于是 `category_id: "abc"` 会一路走到 handler 里，
    // 在 SQL 或算术里变成一个静默的默认值 —— AI 以为点了、系统没收到。
    const check = validateToolArgs(tool, args)
    if (!check.ok) {
      logCall(db, { token: row, tool, ok: false, errorCode: check.code, args, ip, ...cacheDeniedFields(db, row, tool, args) })
      return toolError(res, id, check.code, check.error, check.missing ? { required: check.missing } : undefined)
    }

    // ---- write：幂等 ----
    // 幂等键的唯一性不再是「key 本身」，而是 (令牌, 工具, key, 载荷指纹)。
    // 原来只按 key 查，于是「另一个令牌 + 完全不同的参数」复用同一个 key 会**静默命中别人的结果**
    // （实测：B 令牌传一个旧 key，直接拿到 A 令牌首次执行的 batch_no）。
    // 幂等的意思必须是"同一次调用重放"，而不是"同一个字符串重放"。
    let idemKey = null
    let argsHash = null
    if (tool.level === 'write') {
      idemKey = args.idempotency_key
      if (!idemKey) {
        logCall(db, { token: row, tool, ok: false, errorCode: 'IDEMPOTENCY_REQUIRED', args, ip })
        return toolError(res, id, 'IDEMPOTENCY_REQUIRED', `${tool.title} 是事务类操作，必须提供 idempotency_key 以保证重复调用不会重复扣减`, { level: 'write' })
      }
      argsHash = argsFingerprint(args)
      const cached = db.prepare('SELECT * FROM mcp_idempotency WHERE idempotency_key=?').get(String(idemKey))
      if (cached) {
        const sameCall =
          Number(cached.token_id) === Number(row.id) && cached.tool_name === tool.name && cached.args_hash === argsHash
        if (!sameCall) {
          logCall(db, { token: row, tool, ok: false, errorCode: 'IDEMPOTENCY_CONFLICT', args, ip, idemKey })
          return toolError(
            res,
            id,
            'IDEMPOTENCY_CONFLICT',
            `幂等键「${idemKey}」已被另一次调用占用（令牌 / 工具 / 参数不一致）。` +
              '幂等只保证"同一次调用重放"返回同一结果；换一组参数必须换一个新的幂等键。',
            { level: 'write' }
          )
        }
        // Z8：命中前重验**数据范围**。凭据 / 级别 / 所有者权限点的闸门在上面已对本次调用重跑过；
        // 剩下的是工具自己在 handler 里做的领域范围判定 —— 命中缓存不会进 handler，所以改用
        // "首次执行时记下的有效范围"对照"当前有效范围"（不重跑 handler，因此不可能重复过账）。
        const stored = parseCachedResult(cached.result_json)
        if (!scopeCovers(ctx.scope, stored.scope)) {
          // 注意：首次调用已经提交。这里**不**建议"换新幂等键重试"——那会把已提交的写再执行一遍。
          const msg = '令牌所有者当前的数据范围已不覆盖该幂等键首次执行时的范围，缓存结果不再回放。该键对应的操作此前已提交，请先用查询工具核对结果，不要重复提交'
          logCall(db, { token: row, tool, ok: false, errorCode: 'ORG_OUT_OF_SCOPE', errorMessage: msg, args, ip, idemKey, summary: `${CACHE_DENIED}：数据范围缩小，幂等缓存未被回放` })
          return toolError(res, id, 'ORG_OUT_OF_SCOPE', msg, { level: 'write' })
        }
        // 无声明权限点的工具（权限在 handler 内按边判）：所有者权限集合不得少于首次执行时
        if (!(tool.perms || []).length && !permsCovered(delegation, stored.perms)) {
          const msg = '令牌所有者当前的权限已少于该幂等键首次执行时，缓存结果不再回放。该键对应的操作此前已提交，请先用查询工具核对结果，不要重复提交'
          logCall(db, { token: row, tool, ok: false, errorCode: 'TOKEN_OWNER_PERM_DENIED', errorMessage: msg, args, ip, idemKey, summary: `${CACHE_DENIED}：所有者权限减少，幂等缓存未被回放` })
          return toolError(res, id, 'TOKEN_OWNER_PERM_DENIED', msg, { level: 'write' })
        }
        const data = stored.data
        logCall(db, { token: row, tool, ok: true, args, summary: '幂等命中，返回首次结果', durationMs: Date.now() - started, ip, idemKey })
        return res.json({ jsonrpc: '2.0', id, result: { ...textResult(data, '幂等命中：该幂等键此前已执行，返回首次执行结果'), isError: false, _idempotent_replay: true } })
      }
    }

    // ---- danger：人工二次确认 ----
    // 确认单绑定**三元组**：tool_name + 参数指纹 + token_id。任一不符即拒。
    // 走 header（x-confirm-token）时 args 里没有 confirm_token —— 原来的"置 used"正是因此
    // 拿到 undefined、该行永不置 used，确认单可以无限重放。这里统一取一次变量，全程用它。
    let execArgs = args
    let claimedToken = null
    if (tool.level === 'danger') {
      const confirmToken = args.confirm_token || req.headers['x-confirm-token']
      if (!confirmToken) {
        const ct = `cfm_${crypto.randomBytes(16).toString('hex')}`
        const expires = localNow(new Date(Date.now() + 30 * 60000))
        db.prepare(`
          INSERT INTO mcp_confirmations (confirm_token, tool_name, args_json, token_id, requested_by, status, expires_at)
          VALUES (?,?,?,?,?, 'pending', ?)
        `).run(ct, tool.name, JSON.stringify(args), row.id, row.name, expires)
        logCall(db, { token: row, tool, ok: false, errorCode: 'CONFIRMATION_REQUIRED', args, ip })
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'confirmation_required',
                message: `「${tool.title}」属于高危操作，需人工在系统内确认后才会执行。`,
                confirm_token: ct,
                expires_at: expires,
                how_to_confirm: `POST /mcp/confirmations/${ct}/approve（需登录用户 JWT 且具备确认权限）`,
                args_preview: args
              }, null, 2)
            }],
            isError: false
          }
        })
      }
      const conf = db.prepare('SELECT * FROM mcp_confirmations WHERE confirm_token=?').get(String(confirmToken))
      if (!conf) return toolError(res, id, 'CONFIRM_NOT_FOUND', '确认单不存在')
      if (conf.status !== 'confirmed') {
        logCall(db, { token: row, tool, ok: false, errorCode: `CONFIRM_${String(conf.status).toUpperCase()}`, args, ip })
        return toolError(res, id, 'CONFIRM_NOT_APPROVED', `确认单状态为 ${conf.status}，不能执行（需先人工确认）`)
      }
      if (String(conf.expires_at) < localNow()) {
        db.prepare("UPDATE mcp_confirmations SET status='expired' WHERE id=?").run(conf.id)
        return toolError(res, id, 'CONFIRM_EXPIRED', '确认单已过期，请重新发起')
      }
      // ① 工具必须一致：防止「确认 A 却执行 B」
      if (conf.tool_name !== tool.name) {
        return toolError(res, id, 'CONFIRM_MISMATCH', `确认单对应的是 ${conf.tool_name}，与本次调用的 ${tool.name} 不一致`)
      }
      // ② 令牌必须一致：确认的是"某个 Agent 要做的这件事"，换个令牌执行就不是同一件事
      if (conf.token_id != null && Number(conf.token_id) !== Number(row.id)) {
        return toolError(res, id, 'CONFIRM_TOKEN_MISMATCH', '该确认单由另一个 Agent Token 申请，不能由本令牌执行')
      }
      // ③ 参数必须一致：批准的是那一组参数，不能换一组执行
      let confArgs = {}
      try {
        confArgs = JSON.parse(conf.args_json || '{}')
      } catch {
        confArgs = {}
      }
      if (argsFingerprint(confArgs) !== argsFingerprint(args)) {
        logCall(db, { token: row, tool, ok: false, errorCode: 'CONFIRM_ARGS_MISMATCH', args, ip })
        return toolError(
          res,
          id,
          'CONFIRM_ARGS_MISMATCH',
          '本次调用参数与申请确认时的参数不一致。人工确认的是那一组具体参数，换一组必须重新申请确认。'
        )
      }
      // 占用**不在这里做** —— 它和执行、结果缓存一起进同一个事务（见下方 runInOneTx）。
      // 原因是"占用"与"执行"必须同生共死：先占用再执行（中间隔着一次业务过账）的写法，
      // 一旦执行中途失败，就得靠 catch 里那段"手工退回"来补救 —— 而"记得写退回"本身就是一个坑。
      // 放进同一个事务后，失败回滚是**自然结果**，不再依赖任何一段补救代码。
      claimedToken = String(confirmToken)
      // **把"点确认的那个人"交给工具**（D5）。审批类工具需要一个真实用户当 actor，
      // 而"Agent 凭什么代替人签字"的答案是：它不代替，它**转呈** ——
      // 确认单上记的就是那个真人，审批记录里落下的也是他的名字。
      ctx.confirmedBy = { id: conf.confirmed_by_id ?? null, name: conf.confirmed_by ?? null }
      // 执行时用**确认单里存的参数**，不是本次请求的参数 —— 这是"批准了什么就执行什么"的落实
      execArgs = { ...confArgs, __confirmed: true }
    }

    // ---- 执行：业务过账 + 结果缓存 + 确认消费 = **同一个共同事务**（A04）----
    //
    // 为什么必须"共同"：验收侧独立复现了两条，都出在"三件事各写各的"上 ——
    //   ① **调拨循环中断**（目标第二批 INSERT 失败）⇒ 第一批已落库、第二批源出库未回滚：
    //      总库存 5→2、流水 2→5、幂等缓存 0 —— 库存与流水对不上，接口报错但什么都没退；
    //   ② **业务成功之后** `mcp_idempotency` 写入失败 ⇒ 接口报错，而库存 +1 / 成本 10 / 流水都在、
    //      缓存 0 行 ⇒ 调用方以为没成功，**重试会再执行一次**（这正是幂等要防的事，却被幂等自己破了）。
    // 结论：只给 handler（或只给调拨循环）加事务都不够 ——
    // **业务过账、结果缓存、确认消费必须在同一个事务边界内**：
    // 要么全部生效，要么全部回滚；故障消除后重试，因为缓存也没落下，可以干净地重跑。
    const runInOneTx = db.transaction(() => {
      if (claimedToken) {
        // 原子占用：条件更新 + 按 changes 判定（防并发双花；header 方式的重放也走这里）
        const claim = db
          .prepare("UPDATE mcp_confirmations SET status='used', used_at=?, used_by=? WHERE confirm_token=? AND status='confirmed'")
          .run(localNow(), row.name, claimedToken)
        if (claim.changes !== 1) {
          const err = new Error('确认单已被使用（或状态已变化），请重新发起确认')
          err.code = 'CONFIRM_ALREADY_USED'
          throw err
        }
      }
      const out = tool.handler({ db, args: execArgs, ctx })
      if (idemKey) {
        db.prepare(
          'INSERT OR IGNORE INTO mcp_idempotency (idempotency_key, tool_name, token_id, result_json, args_hash) VALUES (?,?,?,?,?)'
        ).run(String(idemKey), tool.name, row.id, JSON.stringify({ __replay: 1, scope: scopeSnapshot(ctx.scope), perms: permSnapshot(delegation), data: out.data }), argsHash)
      }
      touchToken(db, row.id)
      // F13：写型 / 高危工具的审计与业务过账**同生共死** —— 审计写不进去，上面的过账、幂等缓存、
      // 确认消费一起回滚，客户端拿到 `AUDIT_UNAVAILABLE`，故障消除后可用同一幂等键干净重试。
      // 只读工具没有业务行要保护，走事务外的 best-effort（失败打错误日志）。
      const entry = { token: row, tool, ok: true, args: execArgs, summary: out.summary, durationMs: Date.now() - started, ip, idemKey }
      if (tool.level === 'read') logCall(db, entry)
      else auditOrThrow(db, entry)
      return out
    })

    // ---- 执行 ----
    try {
      const out = runInOneTx()
      return res.json({ jsonrpc: '2.0', id, result: { ...textResult(out.data, out.summary), isError: false } })
    } catch (e) {
      const took = Date.now() - started
      if (e.code === 'CONFIRM_ALREADY_USED') {
        logCall(db, { token: row, tool, ok: false, errorCode: e.code, args, ip })
        return toolError(res, id, e.code, e.message)
      }
      // 这里**没有**"退回到 confirmed"的补救代码，因为不再需要：
      // 占用是同一事务里做的，执行失败 ⇒ 整个事务回滚 ⇒ 确认单自然回到 `confirmed`（可再次执行）。
      // 结果一样，但性质完全不同：一个是"回滚的自然结果"，一个是"必须记得写的补丁"。
      // 已确认的二次确认单在使用时被所有者当前权限 / 范围挡下：事务已回滚、确认单仍是 confirmed，审计标出来
      const denial = claimedToken && (e.status === 403 || e.status === 404 || String(e.code || '').startsWith('TOKEN_OWNER_'))
      logCall(db, { token: row, tool, ok: false, errorCode: e.code || 'EXEC_ERROR', errorMessage: e.message, args: execArgs, durationMs: took, ip, idemKey, summary: denial ? `${CACHE_DENIED}：已确认的二次确认单未被消费` : undefined })
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: e.code || 'EXEC_ERROR', message: e.message, detail: e.detail || null }, null, 2) }],
          isError: true
        }
      })
    }
  })
})

// 浏览器直接打开 /mcp 时给个说明页，避免看起来「坏了」
r.get('/', (_req, res) => {
  res.json({
    code: 0,
    success: true,
    data: {
      ...SERVER_INFO,
      protocolVersion: PROTOCOL_VERSION,
      transport: 'POST /mcp（JSON-RPC 2.0，无状态；兼容 Mcp-Method / Mcp-Name 头）',
      levels: SCOPE_LABEL,
      note: '需在 Authorization 头携带 Agent Token（gml_ 开头）。管理员可在 /api/mcp/tokens 签发。'
    }
  })
})

// ============================================================
// 人工确认入口（用人的 JWT，不是 Agent Token —— 这才是「人工」二次确认）
// ============================================================
// 4a 修复：原来 approve 只有 requireAuth，于是**任何登录用户**（含 viewer 访客、
// 含 dealer/store 这类外部主体）都能批准"付款 / 调价 / 作废"这种高危动作 ——
// 二次确认变成了"随便谁点一下"。现在两道闸：
//   ① 功能权限门 system.mcp.confirm（026 迁移新增，刻意不授予 viewer / dealer / store）；
//   ② 申请人本人不得批准自己名下 Agent Token 发起的确认单 ——
//      二次确认的全部意义就是"另一个人看一眼"，自批等于没有确认。
r.get('/confirmations', requireAuth, requirePerm('system.mcp.confirm'), (req, res) => {
  const db = getDb()
  const rows = db.prepare(`
    SELECT c.*, t.name AS token_name FROM mcp_confirmations c
    LEFT JOIN agent_tokens t ON t.id=c.token_id
    ORDER BY c.id DESC LIMIT 100`).all()
  res.json({ code: 0, success: true, data: rows })
})

r.post('/confirmations/:token/approve', requireAuth, requirePerm('system.mcp.confirm'), (req, res) => {
  const db = getDb()
  const c = db.prepare('SELECT * FROM mcp_confirmations WHERE confirm_token=?').get(req.params.token)
  if (!c) return res.status(404).json({ code: 1, success: false, message: '确认单不存在' })
  // 自批拦截：确认单的申请人是"发起该 Agent Token 的那个人"，不是令牌名。
  // 原来 requested_by 存的是令牌名，拿它跟登录用户名比是比不出来的 —— 要顺着 token_id 查 owner。
  //
  // 顺序说明：**资格判据排在状态判据之前**。「你有没有资格批」是身份问题，
  // 「这张单现在是不是 pending」是单据问题 —— 身份问题先答，否则同一张单
  // 换个人批被拒、本人批却得到"状态不对"，看起来像"批晚了"而不是"轮不到你批"。
  const owner = c.token_id ? db.prepare('SELECT owner_user_id FROM agent_tokens WHERE id=?').get(c.token_id) : null
  if (owner?.owner_user_id != null && Number(owner.owner_user_id) === Number(req.user.uid)) {
    return res.status(403).json({ code: 1, success: false, message: '不能批准本人名下 Agent Token 发起的确认单，请由他人确认' })
  }
  if (c.status !== 'pending') return res.status(400).json({ code: 1, success: false, message: `确认单状态为 ${c.status}` })
  // 条件更新：并发下只有一次能从 pending 翻到 confirmed
  // `confirmed_by_id` 是**签字人**（D5）：审批类工具要拿它当审批 actor ——
  // 只存名字的话，"Agent 审批"就找不到一个真实用户来落 `approval_records`。
  const upd = db
    .prepare(
      "UPDATE mcp_confirmations SET status='confirmed', confirmed_by=?, confirmed_by_id=?, confirmed_at=datetime('now','localtime') WHERE id=? AND status='pending'"
    )
    .run(req.user.name || req.user.username || `uid:${req.user.uid}`, req.user.uid ?? null, c.id)
  if (upd.changes !== 1) return res.status(409).json({ code: 1, success: false, message: '确认单状态已被其他操作改变，请刷新后重试' })
  res.json({
    code: 0,
    success: true,
    data: { confirm_token: c.confirm_token, status: 'confirmed', confirmed_by_id: req.user.uid ?? null }
  })
})

r.post('/confirmations/:token/reject', requireAuth, requirePerm('system.mcp.confirm'), (req, res) => {
  const db = getDb()
  const c = db.prepare('SELECT * FROM mcp_confirmations WHERE confirm_token=?').get(req.params.token)
  if (!c) return res.status(404).json({ code: 1, success: false, message: '确认单不存在' })
  if (c.status !== 'pending') return res.status(400).json({ code: 1, success: false, message: `确认单状态为 ${c.status}` })
  db.prepare("UPDATE mcp_confirmations SET status='rejected', confirmed_by=?, confirmed_at=datetime('now','localtime') WHERE id=?").run(
    req.user.name || req.user.username || `uid:${req.user.uid}`,
    c.id
  )
  res.json({ code: 0, success: true, data: { confirm_token: c.confirm_token, status: 'rejected' } })
})

// ============================================================
// 调用审计（管理员）
// ============================================================
r.get('/logs', requireAuth, requirePerm('system.mcp.confirm'), (req, res) => {
  const db = getDb()
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const rows = db.prepare('SELECT * FROM mcp_call_logs ORDER BY id DESC LIMIT ?').all(limit)
  res.json({ code: 0, success: true, data: rows })
})

export default r
