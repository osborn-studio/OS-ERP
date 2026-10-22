/**
 * ============================================================================
 * 文件标识：server/mcp/validate.js ｜ MCP 工具入参校验（唯一实现）。
 * ============================================================================
 * 【职责】MCP 工具入参校验（唯一实现）。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * MCP 工具入参校验（唯一实现）。
 *
 * 为什么不能只验必填：
 *   MCP 是**给 AI 用的入口**，它给的参数形状比人填表单更野 ——
 *   该传整数的传了 "abc"、该传数字的传了对象、把枚举写成了别家的值。
 *   只验必填时这些都会**一路走进 handler**，然后在算术或 SQL 里变成一个静默的默认值
 *   （`Number(args.limit) || 20`）—— 结果是「AI 说点了 100 条，系统给了 20 条」，
 *   而且双方都以为成功了。
 *
 * 只做 JSON Schema 的**最小子集**：required / type / enum / minimum / maximum / exclusiveMinimum / 未知字段。
 * 刻意不做：不解析 oneOf / anyOf / $ref（工具定义里没有），不做类型强转后回写
 * （只判断"能不能当作这个类型用"，取数仍由 handler 用自己的解析器）。
 *
 * 两处刻意的宽松：
 *   · 数字可以传成字符串（`"10"`）—— 客户端普遍这么干；但 `"abc"` 与
 *     `type=integer` 下的 `3.7` 一律拒绝（"能解析"不等于"合法"）；
 *   · 框架级参数（`idempotency_key` / `confirm_token` / `__confirmed`）不算未知字段 ——
 *     它们由调用框架注入，不写在每个工具的 properties 里。
 */
const NUMERIC = new Set(['integer', 'number'])
const FRAMEWORK_ARGS = new Set(['idempotency_key', 'confirm_token', '__confirmed'])

/** 能当作数字用才返回数字，否则 null（不是 0 —— 0 是合法值，会掩盖"解析失败"） */
function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const show = (v) => JSON.stringify(v)?.slice(0, 120) ?? String(v)

function checkOne(key, schema, value) {
  const t = schema.type
  if (NUMERIC.has(t)) {
    const n = asNumber(value)
    if (n === null) return `参数 ${key} 需要是${t === 'integer' ? '整数' : '数字'}，收到 ${show(value)}`
    if (t === 'integer' && !Number.isInteger(n)) return `参数 ${key} 需要是整数，收到 ${show(value)}`
    if (schema.minimum != null && n < schema.minimum) return `参数 ${key} 不能小于 ${schema.minimum}（收到 ${n}）`
    if (schema.maximum != null && n > schema.maximum) return `参数 ${key} 不能大于 ${schema.maximum}（收到 ${n}）`
    // `exclusiveMinimum`：数量类参数要的是"**必须大于 0**"，而不是"不小于 0"。
    // 缺了它 `qty: -5` 会一路走进 handler：出入库的自动拣选收到非正需求会返回**空拣选**，
    // 于是那个 `for` 循环一次都不跑，最后返回一个"成功、但什么都没做"的结果 ——
    // 铁律 17 说的就是这种：**无意义的动作必须由闸门明确拒绝，不能安静地成功**。
    if (schema.exclusiveMinimum != null && n <= schema.exclusiveMinimum) {
      return `参数 ${key} 必须大于 ${schema.exclusiveMinimum}（收到 ${n}）`
    }
    return null
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return null
    return `参数 ${key} 需要是布尔值，收到 ${show(value)}`
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return `参数 ${key} 需要是数组，收到 ${show(value)}`
    return null
  }
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `参数 ${key} 需要是对象，收到 ${show(value)}`
    }
    return null
  }
  if (t === 'string') {
    if (typeof value === 'object' && value !== null) return `参数 ${key} 需要是字符串，收到 ${show(value)}`
    return null
  }
  return null
}

/**
 * @returns {{ok:true, value:object} | {ok:false, code:string, error:string, field?:string}}
 */
export function validateToolArgs(tool, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'ARG_TYPE', error: '工具参数必须是对象' }
  }
  const a = args
  const schema = tool?.inputSchema || {}
  const props = schema.properties || {}
  const reqd = schema.required || []

  const missing = reqd.filter((k) => a[k] === undefined || a[k] === null || a[k] === '')
  if (missing.length) {
    return { ok: false, code: 'MISSING_ARGS', error: `缺少必填参数：${missing.join(', ')}`, missing }
  }

  // 未知参数**不能静默忽略**：AI 以为传了、系统没收到，是最难查的一类偏差
  // （参数名差一个字母 / 用了旧版本的字段名，都会走到这里）
  const unknown = Object.keys(a).filter((k) => !Object.hasOwn(props, k) && !FRAMEWORK_ARGS.has(k))
  if (unknown.length) {
    return { ok: false, code: 'ARG_UNKNOWN', error: `未知参数：${unknown.join(', ')}`, unknown }
  }

  for (const [k, s] of Object.entries(props)) {
    if (a[k] === undefined || a[k] === null) continue
    if (Array.isArray(s.enum) && s.enum.length && !s.enum.includes(a[k])) {
      return { ok: false, code: 'ARG_ENUM', error: `参数 ${k} 只能是 ${s.enum.join(' / ')}，收到 ${show(a[k])}`, field: k }
    }
    const bad = checkOne(k, s, a[k])
    if (bad) return { ok: false, code: 'ARG_TYPE', error: bad, field: k }
  }
  return { ok: true, value: a }
}

export default { validateToolArgs }
