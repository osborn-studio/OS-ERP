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
import { TOOL_MAP, listTools, toolToMcp } from './tools.js'
import { validateToolArgs } from './validate.js'
import { extractToken, verifyToken, tokenScopes, tokenAllow, tokenDeny, touchToken, SCOPE_LABEL } from './tokens.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import * as engine from '../lib/stock.js'
import { versionInfo } from '../version.js'

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
function checkToolAccess(tool, { scopes, allow, deny }) {
  if (!tool) return { code: 'TOOL_NOT_FOUND', message: '未知工具' }
  if (!scopes.includes(tool.level)) {
    return {
      code: 'SCOPE_DENIED',
      message: `该 Token 的权限范围为 [${scopes.join(',')}]，不足以调用 ${tool.level} 级工具「${tool.title}」`
    }
  }
  if (allow && !allow.includes(tool.name)) return { code: 'TOOL_NOT_ALLOWED', message: `该 Token 的白名单不含 ${tool.name}` }
  if (deny.includes(tool.name)) return { code: 'TOOL_DENIED', message: `该 Token 被禁止调用 ${tool.name}` }
  return null
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

function rpcError(res, id, code, message) {
  return res.json({ jsonrpc: '2.0', id, error: { code, message } })
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

function logCall(db, { token, tool, ok, errorCode, errorMessage, args, summary, durationMs, ip, idemKey }) {
  try {
    db.prepare(`
      INSERT INTO mcp_call_logs (token_id, token_name, tool_name, level, ok, error_code, error_message,
                                 args, result_summary, duration_ms, ip, idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      token?.id ?? null, token?.name ?? null, tool?.name ?? null, tool?.level ?? null,
      ok ? 1 : 0, errorCode ?? null, errorMessage ?? null,
      JSON.stringify(args ?? {}).slice(0, 4000), summary ? String(summary).slice(0, 500) : null,
      durationMs ?? null, ip ?? null, idemKey ?? null
    )
  } catch { /* 日志失败不影响主流程 */ }
}

function buildContext(db, row) {
  // 数据权限：Token 绑定的主体决定可见范围（A3 会话绑单一主体）
  let scope = { scope: 'all', orgIds: null, orgId: row.org_id ?? null }
  if (row.org_id) {
    const node = db.prepare('SELECT id, path FROM orgs WHERE id=?').get(row.org_id)
    if (node?.path) {
      const ids = db.prepare('SELECT id FROM orgs WHERE path LIKE ? OR id=?').all(`${node.path}%`, node.id).map((x) => x.id)
      scope = { scope: 'subtree', orgIds: ids, orgId: node.id }
    } else {
      scope = { scope: 'org', orgIds: [row.org_id], orgId: row.org_id }
    }
  }
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
  const v = verifyToken(getDb(), raw)
  if (v.error) {
    const msg = {
      missing_token: '缺少 Agent Token（Authorization: Bearer gml_xxx）',
      invalid_token: 'Agent Token 无效',
      revoked: 'Agent Token 已被吊销',
      expired: 'Agent Token 已过期',
      rate_limited: `调用超限（近 1 小时已达 ${v.used} 次）`
    }[v.error] || v.error
    return rpcError(res, id, -32001, msg)
  }
  const row = v.row

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
    const ctx = buildContext(db, row)
    const scopes = tokenScopes(row)
    const allow = tokenAllow(row)
    const deny = tokenDeny(row)

    // ---------- tools/list ----------
    if (method === 'tools/list') {
      const visible = listTools({
        levels: scopes.map((s) => s),
        allow,
        deny
      })
      return res.json({ jsonrpc: '2.0', id, result: { tools: visible.map(toolToMcp) } })
    }

    // ---------- resources ----------
    // 只列出**本令牌真的拿得到**的资源：列的出、读的到，两者用同一个判定。
    if (method === 'resources/list') {
      const gate = { scopes, allow, deny }
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
      const denied = checkToolAccess(tool, { scopes, allow, deny })
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
    if (!tool) {
      logCall(db, { token: row, tool: { name: toolName }, ok: false, errorCode: 'TOOL_NOT_FOUND', args, ip })
      return toolError(res, id, 'TOOL_NOT_FOUND', `未知工具：${toolName}`)
    }

    // 权限范围校验（与 resources/read 同一份判定）
    const access = checkToolAccess(tool, { scopes, allow, deny })
    if (access) {
      logCall(db, { token: row, tool, ok: false, errorCode: access.code, args, ip })
      return toolError(res, id, access.code, access.message)
    }

    // 入参校验（唯一实现，见 mcp/validate.js）：必填 + 类型 + 枚举 + 范围 + 未知字段。
    // 原来只有"必填"这一条，于是 `category_id: "abc"` 会一路走到 handler 里，
    // 在 SQL 或算术里变成一个静默的默认值 —— AI 以为点了、系统没收到。
    const check = validateToolArgs(tool, args)
    if (!check.ok) {
      logCall(db, { token: row, tool, ok: false, errorCode: check.code, args, ip })
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
        const data = JSON.parse(cached.result_json || '{}')
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
        ).run(String(idemKey), tool.name, row.id, JSON.stringify(out.data), argsHash)
      }
      touchToken(db, row.id)
      return out
    })

    // ---- 执行 ----
    try {
      const out = runInOneTx()
      const took = Date.now() - started
      logCall(db, { token: row, tool, ok: true, args: execArgs, summary: out.summary, durationMs: took, ip, idemKey })
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
      logCall(db, { token: row, tool, ok: false, errorCode: e.code || 'EXEC_ERROR', errorMessage: e.message, args: execArgs, durationMs: took, ip, idemKey })
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
