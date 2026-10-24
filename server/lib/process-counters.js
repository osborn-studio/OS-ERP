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
  security_audit_unavailable_total: {
    help: 'Times a business change was refused with 503 SECURITY_AUDIT_UNAVAILABLE because its security audit row could not be written.',
    labelName: null, values: []
  }
})

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
  return out
}

/** 仅供测试 */
export function resetCounters() { resetAll() }

export default { COUNTER_DEFS, incCounter, counterSnapshot, resetCounters }
