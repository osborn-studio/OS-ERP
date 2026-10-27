/**
 * ============================================================================
 * 文件标识：server/lib/metrics-export.js ｜ Prometheus 文本指标渲染 + 抓取令牌校验（ADR-0045）
 * ============================================================================
 * 【职责】
 *   · `renderPrometheus({ ops, retry, counters, version })`：把 ops-status 的 gauge、`tx.js` 的写重试统计、
 *     `process-counters.js` 的事件计数渲染成 text exposition 0.0.4（每个指标族一行 HELP + 一行 TYPE，前缀 `os_erp_`）。
 *   · `metricsTokenOk(presented, env)`：`GML_METRICS_TOKEN` 的校验。令牌只来自环境变量。
 *
 * 【令牌口径】
 *   · 未设置 / 短于 32 字符 ⇒ 令牌路径整体关闭（短令牌不能靠"设了就生效"变成弱口令）。
 *   · 比较：双方各取 SHA-256（定长 32 字节）再 `timingSafeEqual` —— 不泄露长度，也不因前缀相同而提前返回。
 *   · 令牌永不进日志、响应、审计：本模块不写任何输出，调用方也只传入、不回显。
 *
 * 【输出边界】只有数字与固定 label 值（reason / version）。不含路径、账号名、IP、备份文件名；
 *   未知值（取不到备份年龄、磁盘等）输出 -1，与 ADR-0029 的 JSON 计数器同一约定。
 * ============================================================================
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { opsCounters } from './ops-status.js'
import { COUNTER_DEFS, HISTOGRAM_DEFS } from './process-counters.js'

export const METRICS_TOKEN_MIN_LENGTH = 32
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

const digest = (s) => createHash('sha256').update(s, 'utf8').digest()

/** 令牌是否匹配。`presented` 非字符串 / 空、或服务端未配置有效令牌 ⇒ false。 */
export function metricsTokenOk(presented, env = process.env) {
  // AB10 轮换：GML_METRICS_TOKEN（当前）与 GML_METRICS_TOKEN_NEXT（下一把）同时有效。
  // 两把**都**比较、不提前返回，耗时不泄露命中的是哪一把。
  const configured = [env.GML_METRICS_TOKEN, env.GML_METRICS_TOKEN_NEXT]
    .filter((c) => typeof c === 'string' && c.length >= METRICS_TOKEN_MIN_LENGTH)
  if (configured.length === 0) return false
  if (typeof presented !== 'string' || presented.length === 0) return false
  const p = digest(presented)
  let matched = false
  for (const c of configured) matched = timingSafeEqual(p, digest(c)) || matched
  return matched
}

const escLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 渲染。ops 来自 computeOpsStatus；retry 来自 writeRetryStats()；counters 来自 counterSnapshot()。 */
export function renderPrometheus({ ops, retry, counters, histograms = {}, version, mcpDeniedRows }) {
  const lines = []
  const family = (name, type, help, samples) => {
    lines.push(`# HELP os_erp_${name} ${help}`, `# TYPE os_erp_${name} ${type}`)
    for (const [labels, value] of samples) lines.push(`os_erp_${name}${labels} ${num(value)}`)
  }
  const gauge = (name, help, value) => family(name, 'gauge', help, [['', value]])
  const g = opsCounters(ops)

  gauge('backup_age_seconds', 'Seconds since the newest backup report was generated; -1 when unknown or no report.', g.backup_age_seconds)
  gauge('backup_last_failed', '1 when the newest backup report recorded a failure, else 0.', g.backup_last_failed)
  gauge('backup_missing', '1 when no backup report exists in the backup directory, else 0.', g.backup_missing)
  gauge('migration_checksum_mismatches', 'Applied migrations whose file content no longer matches the recorded checksum; -1 when unknown.', g.migration_checksum_mismatches)
  gauge('migration_checksum_adopted', 'Migrations registered through explicit checksum adoption; -1 when unknown.', g.migration_checksum_adopted)
  gauge('login_throttle_unavailable', '1 when the login throttle store fails its read-only probe (logins fail closed), else 0.', g.login_throttle_unavailable)
  gauge('disk_free_bytes', 'Free bytes on the volume holding the data directory; -1 when unknown.', g.disk_free_bytes)

  // AH9：限速桶表里 denied 行的行数（无 label）。范围语义：运维 / 进程级 gauge，不属于业务指标字典（`server/lib/metrics.js` 的 METRICS，那里每条都要声明 scopeAware/scopeless），
  // 数的是"本次抓取所服务的行业库"里的行数，不按调用者的数据范围收窄，也不含任何令牌信息。未提供 ⇒ -1（未知）。
  gauge('mcp_rate_denied_rows', 'Rows of kind=denied in mcp_rate_buckets of the industry database serving this scrape (per-process ops gauge, not caller-scoped); -1 when unknown. Cleaned by the periodic purge, so sustained growth means the purge is not running.', Number.isFinite(mcpDeniedRows) ? mcpDeniedRows : -1)

  for (const [name, def] of Object.entries(COUNTER_DEFS)) {
    const value = counters?.[name]
    const samples = def.labelName
      ? def.values.map((v) => [`{${def.labelName}="${escLabel(v)}"}`, value?.[v]])
      : [['', value]]
    family(name, 'counter', def.help, samples)
  }

  // AB10：MCP 工具调用（tool/code 两个 label，值域在 process-counters 内封闭）
  family('mcp_tool_calls_total', 'counter', 'MCP tool calls whose call-log row was written, by tool and result code (ok or a registered error code; unregistered values fold into unknown/other).',
    Object.entries(counters?.mcp_tool_calls_total ?? {}).flatMap(([tool, codes]) =>
      Object.entries(codes).map(([code, n]) => [`{tool="${escLabel(tool)}",code="${escLabel(code)}"}`, n])))

  for (const [name, def] of Object.entries(HISTOGRAM_DEFS)) {
    const h = histograms?.[name]
    lines.push(`# HELP os_erp_${name} ${def.help}`, `# TYPE os_erp_${name} histogram`)
    for (const b of h?.buckets ?? def.buckets.map((le) => ({ le, count: 0 }))) lines.push(`os_erp_${name}_bucket{le="${b.le}"} ${num(b.count)}`)
    lines.push(`os_erp_${name}_bucket{le="+Inf"} ${num(h?.count)}`, `os_erp_${name}_sum ${num(h?.sum).toFixed(6)}`, `os_erp_${name}_count ${num(h?.count)}`)
  }

  family('write_calls_total', 'counter', 'withWriteRetry invocations (since process start).', [['', retry?.calls]])
  family('write_retries_total', 'counter', 'Write transactions retried after SQLITE_BUSY/LOCKED (since process start).', [['', retry?.retries]])
  family('write_retry_exhausted_total', 'counter', 'Write transactions that still failed with SQLITE_BUSY/LOCKED after the last attempt.', [['', retry?.exhausted]])
  family('write_non_retryable_errors_total', 'counter', 'Write transactions that failed with a non-busy error (not retried).', [['', retry?.non_retryable]])

  // ADR-0036：CSP 目前只有 Report-Only 头、没有报告接收端点（无 report-uri/report-to），服务端收不到任何违规报告。
  // 恒为 0 不代表"没有违规"——只代表"没有采集"；HELP 写明，且文档的告警规则不引用它。
  family('csp_violation_reports_total', 'counter', 'CSP violation reports received. Always 0: no report endpoint exists (ADR-0036 report-only mode), so violations are not collected.', [['', 0]])

  family('build_info', 'gauge', 'Build information; value is always 1.', [[`{version="${escLabel(version)}"}`, 1]])
  return `${lines.join('\n')}\n`
}

/**
 * AC9：SIGTERM 时写进日志的一行 JSON 快照（重启前后对账用）。只含进程内计数器 / 直方图 / 写重试，
 * 不含 ops（不读库、不碰文件系统）、不含路径与账号；任何异常都折成一行 `metrics_snapshot_failed`，永不抛错。
 */
export function shutdownSnapshotLine({ counters, histograms = {}, retry = {}, now = () => new Date() }) {
  const ts = (() => { try { return now().toISOString() } catch { return null } })()
  try {
    return JSON.stringify({ ts, level: 'info', msg: 'metrics_snapshot', event: 'shutdown', counters, histograms, retry })
  } catch {
    return JSON.stringify({ ts, level: 'warn', msg: 'metrics_snapshot_failed', event: 'shutdown' })
  }
}

export default { shutdownSnapshotLine, renderPrometheus, metricsTokenOk, METRICS_TOKEN_MIN_LENGTH, PROMETHEUS_CONTENT_TYPE }
