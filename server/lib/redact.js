/**
 * ============================================================================
 * 文件标识：server/lib/redact.js ｜ 日志 / 审计明细 / 错误响应的**唯一脱敏实现**：凭据键整体遮盖、URL 里的 token= 值剥掉、手机号部分遮盖
 * ============================================================================
 * 【职责】把"将要写进日志、审计表或 5xx 响应"的东西过一遍，去掉凭据和明显的个人信息。
 *
 * 【设计】三条口径，全部在这里，调用点不自己再写一遍正则：
 *   ① `SENSITIVE_KEY`：键名命中 /password|secret|token|authorization|cookie|jwt|key/i 的值**整体**换成 `[REDACTED]`。
 *      `key` 故意偏宽（会命中 `keyword` / `setting key` 之类）—— 这里宁可多遮一个无害字段，
 *      也不漏一个 `api_key`。需要保留这类名字的调用点请改用别的字段名（如审计里的 `setting`）。
 *   ② `redactText` / `redactUrl`：字符串里 `token=xxx` 一类"键=值"的值剥掉（URL 查询串、
 *      人手拼的日志句子都适用）；键名判据与 ① 同一个。
 *   ③ `PII_KEY`：手机号类字段**部分**遮盖（保留前 3 后 4），审计仍能对上"是哪个号"，但整段不落库。
 *
 * 【注意】返回**新对象**，不改入参；循环引用 / 过深对象用标记代替，保证脱敏后能 `JSON.stringify`。
 *   MCP 的审计路径（server/mcp/*）由另一条线接入本助手，不在这里改。
 * ============================================================================
 */

export const MASK = '[REDACTED]'
export const SENSITIVE_KEY = /password|secret|token|authorization|cookie|jwt|key/i
export const PII_KEY = /^(?:phone|mobile|tel|telephone|mobile_phone|contact_phone)$/i
const MAX_DEPTH = 8

// `token=abc`、`access_token=...`、`api_key=...`：键名含敏感词、后面跟 `=` 的值。
// 键的起点限定在串首或分隔符之后，`?`/`&`/`#`/空白/`;`/`,` 都算分隔符，所以 URL 与一句话里都能命中。
const PARAM_VALUE = /((?:^|[?&#;,\s])[^=&#\s]*(?:password|secret|token|authorization|cookie|jwt|key)[^=&#\s]*=)[^&#\s]*/gi

/** 字符串里 `敏感键=值` 的值剥掉（URL 查询串 / 日志句子） */
export function redactText(text) {
  if (text === null || text === undefined) return text
  return String(text).replace(PARAM_VALUE, `$1${MASK}`)
}

/** `req.originalUrl` 之类：只剥查询值，路径与其它参数原样 */
export function redactUrl(url) {
  return redactText(url)
}

function maskPhone(value) {
  const s = String(value)
  const digits = s.replace(/\D/g, '')
  if (digits.length < 8) return MASK
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/**
 * 深度脱敏：对象 / 数组递归，字符串走 `redactText`，标量原样。
 * 空值（null / undefined / ''）即使键名敏感也原样返回 —— "没填"本身是有用信息，遮成 `[REDACTED]` 反而像填了。
 */
export function redactValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen))
  if (value instanceof Date) return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const empty = v === null || v === undefined || v === ''
    if (empty) out[k] = v
    else if (SENSITIVE_KEY.test(k)) out[k] = MASK
    else if (PII_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = maskPhone(v)
    else out[k] = redactValue(v, depth + 1, seen)
  }
  return out
}
