/**
 * ============================================================================
 * 文件标识：server/lib/dates.js ｜ 业务日期的**唯一来源**。
 * ============================================================================
 * 【职责】业务日期的**唯一来源**。
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 业务日期的**唯一来源**。
//
// 为什么必须集中在一处：
//
// `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日期**。东八区在
// **本地 00:00–08:00** 之间，UTC 还没跨日，于是它比本地日期**早一天**。
// 这不是"偶尔差一天"，而是每天都会发生的八小时窗口。
//
// 一旦同一个系统里出现两个"今天"，就会出现下面这种谁也不报错的错误：
//   · JS 侧按 UTC 算「今天」→ 一张恰好昨天（本地）到期的应收单算作**未逾期**；
//   · SQL 侧 `date('now','localtime')` 算「今天」→ 视图里它**已逾期**；
//   · 两个口径都返回 200、字段名都在、行数也一样，**只是合计差一笔**。
//   实测（模块 18 收尾）：test-ar [food] 稳定失败，差值 82.32 元就是那一笔。
//
// 所以定死一条规则：**凡是从「现在」派生「日期」的地方一律用 localDate()**，
// 不要用 toISOString()。包括：业务日、账期到期日、逾期天数、账龄分桶、
// 单号里的日期段、按日汇总的起止日。
// 需要「日期 + 时分秒」的写库时间戳用 localNow()。
//
// 依赖方向：本模块只依赖 Date，不依赖 db / seed-clock，任何层都可以引。
const pad = (n) => String(n).padStart(2, '0')

const asDate = (d) => (d instanceof Date ? d : new Date(d))

/** 本地日期 YYYY-MM-DD —— 业务日只此一个出处 */
export function localDate(d = new Date()) {
  const x = asDate(d)
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}

/** 本地日期时间 YYYY-MM-DD HH:mm:ss —— 与 SQLite 的 `datetime('now','localtime')` 同形 */
export function localNow(d = new Date()) {
  const x = asDate(d)
  return `${localDate(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`
}

/**
 * 日期字符串加天数。
 * 用「年/月/日 三个整数」算，**不经过 toISOString()** ——
 * 后者会把本地零点解释成前一天 16:00Z，于是「1/1 + 30 天」算成 12/31：
 * 数字有、不报错、就是每个月都短一天。贷期、有效期、账期全走这里。
 */
export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return String(dateStr).slice(0, 10)
  const base = new Date(y, m - 1, d)
  base.setDate(base.getDate() + Math.trunc(Number(n) || 0))
  return localDate(base)
}

/**
 * 会计期间（'YYYY-MM'）的**末日**，如 `'2026-02'` → `'2026-02-28'`。
 *
 * 为什么必须算而不是写 `-31`：2 月有 28/29 天，小月 30 天。
 * 写死 `-31` 会让二月的期末结转凭证**落在一个不存在的日期上**，
 * 而 SQLite 不校验日期合法性 —— 它会安静地存下 `'2026-02-31'`，
 * 于是这张凭证既不属于 2 月（月末对账扫不到）也不属于 3 月（早于 3 月 1 日）。
 * `new Date(y, m, 0)` 取"下个月的第 0 天"，正好是本月最后一天。
 */
export function monthEnd(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? '').trim())
  if (!m) return ''
  return localDate(new Date(Number(m[1]), Number(m[2]), 0))
}

/** 两个日期（YYYY-MM-DD）之间相差的整天数，b - a */
export function diffDays(a, b) {
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00`)
  const db2 = new Date(`${String(b).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(da.getTime()) || Number.isNaN(db2.getTime())) return 0
  return Math.round((db2.getTime() - da.getTime()) / 86400000)
}

export default { localDate, localNow, addDays, diffDays, monthEnd }
