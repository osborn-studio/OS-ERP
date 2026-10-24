/**
 * ============================================================================
 * 文件标识：server/lib/process-counters.js ｜ 进程级事件计数器（只增不减，进程重启归零）（ADR-0045）
 * ============================================================================
 * 【职责】给 `GET /api/meta/metrics?format=prometheus` 提供"事件发生过多少次"的计数：登录节流拒绝、严格审计写失败、
 *   安全审计不可用。真正的发生点（login-throttle / audit-trail / mcp 审计）调用 `incCounter`，本模块不依赖任何业务模块。
 *
 * 【为什么是注册表】名字与 label 值都必须事先登记（`COUNTER_DEFS`），未登记的一律**忽略**：
 *   label 值永远不来自用户输入（账号名、IP、路径），Prometheus 的时间序列基数因此固定；调用点写错名字也不会抛错打断业务。
 *
 * 【注意】进程内、非持久：多进程部署各自计数，抓取端用 `sum`/`increase` 聚合；重启后 `increase()` 自动处理计数器重置。
 *   写重试计数不在这里（`tx.js` 自有 `writeRetryStats()`，抓取时直接读）。
 * ============================================================================
 */

/** 计数器登记：labelName=null 表示无 label；values 为允许的 label 值全集 */
export const COUNTER_DEFS = Object.freeze({
  login_throttle_rejections_total: {
    help: 'Login attempts rejected by the persistent login throttle, by reason (rate_limited: 429; unavailable: store failure, fail closed 503).',
    labelName: 'reason', values: ['rate_limited', 'unavailable']
  },
  audit_strict_write_failures_total: {
    help: 'Strict (in-transaction, roll-back-on-failure) audit writes that failed, by reason (insert_error, no_row, outside_tx = coding error, mcp_call_log).',
    labelName: 'reason', values: ['insert_error', 'no_row', 'outside_tx', 'mcp_call_log']
  },
  dashboard_cache_total: {
    help: 'Dashboard summary TTL cache lookups by result (hit: served from cache; miss: recomputed). Not counted when the cache is disabled (GML_DASHBOARD_CACHE_MS=0).',
    labelName: 'result', values: ['hit', 'miss']
  },
  mcp_rate_store_failures_total: {
    help: 'MCP rate-limit db store failures by reason (write_failed: a call was refused fail-closed with store_unavailable; purge_failed: background purge of expired buckets failed). Only moves when GML_MCP_RATE_STORE=db.',
    labelName: 'reason', values: ['write_failed', 'purge_failed']
  },
  security_audit_unavailable_total: {
    help: 'Times a business change was refused with 503 SECURITY_AUDIT_UNAVAILABLE because its security audit row could not be written.',
    labelName: null, values: []
  }
})

/**
 * MCP 工具调用计数（AB10）：两个 label（tool, code），都是**封闭集合**。
 *   · tool：只接受 `registerMcpTools` 登记过的工具名（来自代码内的工具目录），其余折成 `unknown`；
 *   · code：`ok` 或下面登记的结果码，其余折成 `other`。用户可控字符串（工具名、参数）因此无法制造新序列或注入 label。
 */
export const MCP_RESULT_CODES = Object.freeze([
  'ok', 'other', 'TOOL_NOT_FOUND', 'TOOL_NOT_ALLOWED', 'TOOL_DENIED', 'SCOPE_DENIED', 'PERM_DENIED', 'TOKEN_OWNER_PERM_DENIED',
  'ORG_OUT_OF_SCOPE', 'BAD_ARGS', 'MISSING_ARGS', 'ARG_TYPE', 'ARG_ENUM', 'ARG_UNKNOWN', 'NOT_FOUND', 'DOC_NOT_FOUND',
  'TARGET_NOT_FOUND', 'WAREHOUSE_NOT_FOUND', 'BAD_DOC_TYPE', 'INSUFFICIENT_STOCK', 'TRANSITION_NOT_ALLOWED',
  'IDEMPOTENCY_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'CONFIRMATION_REQUIRED', 'CONFIRM_ARGS_MISMATCH', 'CONFIRM_ALREADY_USED',
  'EDGE_REQUIRES_HUMAN', 'APPROVAL_ACTOR_REQUIRED', 'APPROVAL_NOT_FOUND', 'OWNER_MISMATCH', 'AUDIT_UNAVAILABLE', 'EXEC_ERROR', 'MCP_RATE_LIMITED'
])
const mcpCodes = new Set(MCP_RESULT_CODES)
const mcpTools = new Set()
const mcpCalls = new Map() // tool -> Map(code -> n)
// 预置零值序列：`increase()` 无法还原"首次出现即为 1"的序列，所以关键结果码（成功、审计不可用）对每个已登记工具先输出 0。
const MCP_PRESEEDED = ['ok', 'AUDIT_UNAVAILABLE']
function seedMcp(tool) {
  const m = mcpCalls.get(tool) ?? new Map()
  mcpCalls.set(tool, m)
  for (const c of MCP_PRESEEDED) if (!m.has(c)) m.set(c, 0)
}
export function registerMcpTools(names) {
  for (const n of names) if (typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(n)) { mcpTools.add(n); seedMcp(n) }
}
/** MCP 工具调用 +1；`code` 为空/假值 = 成功。永不抛错。 */
export function incMcpToolCall(tool, code) {
  const t = mcpTools.has(tool) ? tool : 'unknown'
  const c = !code ? 'ok' : mcpCodes.has(code) && typeof code === 'string' ? code : 'other'
  let m = mcpCalls.get(t)
  if (!m) { m = new Map(); mcpCalls.set(t, m) }
  m.set(c, (m.get(c) || 0) + 1)
}

/** 某结果码在所有工具上的累计次数（进程内、重启归零）；只读，供管理端展示 */
export function mcpCodeTotal(code) {
  let n = 0
  for (const m of mcpCalls.values()) n += m.get(code) || 0
  return n
}

/** 直方图登记：桶边界固定（秒），不由输入决定 */
export const HISTOGRAM_DEFS = Object.freeze({
  audit_write_duration_seconds: {
    help: 'Duration of audit_logs INSERT statements in seconds (includes failed attempts).',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
  },
  mcp_rate_store_wait_seconds: {
    help: 'Wall-clock seconds of one MCP rate-limit db consume (write-lock wait + busy retries + the short transaction), including refused and failed calls. Only observed when GML_MCP_RATE_STORE=db.',
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  }
})
const hists = new Map()
const resetHists = () => {
  for (const [name, def] of Object.entries(HISTOGRAM_DEFS)) hists.set(name, { counts: def.buckets.map(() => 0), inf: 0, sum: 0, count: 0 })
}
resetHists()
/** 观测一个耗时（秒）；未登记名 / 非有限非负数被忽略。 */
export function observeHistogram(name, seconds) {
  const h = hists.get(name)
  if (!h || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return false
  const i = HISTOGRAM_DEFS[name].buckets.findIndex((b) => seconds <= b)
  if (i < 0) h.inf += 1
  else h.counts[i] += 1
  h.sum += seconds
  h.count += 1
  return true
}
/** 快照：{ 名: { buckets: [{le, count(累计)}], sum, count } }，count 即 +Inf 桶 */
export function histogramSnapshot() {
  const out = {}
  for (const [name, h] of hists) {
    let acc = 0
    out[name] = {
      buckets: HISTOGRAM_DEFS[name].buckets.map((le, i) => ({ le, count: (acc += h.counts[i]) })),
      sum: h.sum, count: h.count
    }
  }
  return out
}

const NO_LABEL = ''
const counts = new Map()
const resetAll = () => {
  for (const [name, def] of Object.entries(COUNTER_DEFS)) {
    counts.set(name, new Map((def.labelName ? def.values : [NO_LABEL]).map((v) => [v, 0])))
  }
}
resetAll()

/** 计数 +1。未登记的名字 / label 值被忽略（返回 false），永不抛错。 */
export function incCounter(name, labelValue = NO_LABEL) {
  const series = counts.get(name)
  if (!series || !series.has(labelValue)) return false
  series.set(labelValue, series.get(labelValue) + 1)
  return true
}

/** 快照：无 label 的计数器 → number；有 label 的 → { 值: number } */
export function counterSnapshot() {
  const out = {}
  for (const [name, series] of counts) {
    out[name] = COUNTER_DEFS[name].labelName ? Object.fromEntries(series) : series.get(NO_LABEL)
  }
  out.mcp_tool_calls_total = Object.fromEntries([...mcpCalls].map(([t, m]) => [t, Object.fromEntries(m)]))
  return out
}

/** 仅供测试 */
export function resetCounters() { resetAll(); resetHists(); mcpCalls.clear(); for (const t of mcpTools) seedMcp(t) }

export default { COUNTER_DEFS, incCounter, counterSnapshot, resetCounters, incMcpToolCall, registerMcpTools, observeHistogram, histogramSnapshot }
