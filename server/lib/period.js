/**
 * ============================================================================
 * 文件标识：server/lib/period.js ｜ 会计期间（批次 L）：期间格式、状态、以及**过账闸门**
 * ============================================================================
 * 【职责】会计期间（批次 L）：期间格式、状态、以及**过账闸门**
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 会计期间（批次 L）：期间格式、状态、以及**过账闸门**
//
// ===========================================================================
// 为什么单独一个文件
// ===========================================================================
// 「关账之后不能再过账」这条判据有**两个调用方**：
//   · `lib/accounting.js` 的 `postVoucher`（动账时拦）
//   · `lib/report.js` 的 `closePeriod`（关账时确认没有漏网的草稿）
// 按本项目「同一份判据不允许有两个实现」，它们必须调同一个函数。
// 而如果把它写在 `report.js` 里，`accounting.js` 就要 import 报表模块 ——
// 凭证模块依赖报表模块，方向是反的，而且 `report.js` 的关账校验还要回调
// `auditReport`，一绕就成环。所以把**纯期间工具**下沉到这一层，
// 报表与凭证都只依赖它，依赖图是一条直线。
//
// ===========================================================================
// 一条刻意的宽口径
// ===========================================================================
// **不存在的期间视为"未关账"**。
// 建库时不可能把每个期间都预先登记（2026-01 到 2036-12？），
// 而"没登记"与"关过账"是两件不同的事；混为一谈的后果是
// 第一批凭证**全部过不了账**，且错误信息会说"期间已关账"（一个从没关过的期间）。
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export class PeriodError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // 见 `lib/report.js` 里 `ReportError` 的注释：HTTP 层只认 `.status`
    this.status = http
    this.detail = detail
  }
}

export const PERIOD_STATUS_LABEL = { open: '未关账', closed: '已关账' }

/**
 * 期末结转凭证的业务类型（批次 M）。
 *
 * 为什么这个常量放在 `period.js` 而不是 `lib/closing.js`：
 * **三个模块都要用它，而它们之间不能互相依赖** ——
 *   · `lib/report.js` 的 `subjectBalances` 要把它**从发生额里排除**
 *     （含它，利润表会算出 0；判据见迁移 035 的注释三）；
 *   · `lib/closing.js` 生成它；
 *   · `period.js` 的关账前置要检查"本期有没有这张凭证"。
 * 而 `closing.js` 依赖 `report.js`、`report.js` 依赖 `period.js` ——
 * 常量放在依赖图的最底层（`period.js`），不会成环。
 * 它也表示"期间的定稿动作"，与期间概念同源。
 */
export const CARRY_BIZ_TYPE = 'profit_carry'

export function assertPeriod(period) {
  const p = String(period ?? '').trim()
  if (!PERIOD_RE.test(p)) throw new PeriodError('BAD_PERIOD', `期间格式必须是 YYYY-MM，收到「${period}」`, 400)
  return p
}

/** 期间位移（用于"上期""去年同期"这类比较）。**按月份算，不靠 `Date` 的时区**。 */
export function shiftPeriod(period, delta) {
  const p = assertPeriod(period)
  const [y, m] = p.split('-').map(Number)
  const total = y * 12 + (m - 1) + Number(delta)
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`
}

export function listPeriods(db, { from = null, to = null } = {}) {
  const args = []
  let where = 'WHERE 1=1'
  if (from) { where += ' AND period >= ?'; args.push(assertPeriod(from)) }
  if (to) { where += ' AND period <= ?'; args.push(assertPeriod(to)) }
  return db
    .prepare(`SELECT * FROM accounting_periods ${where} ORDER BY period DESC`)
    .all(...args)
    .map((r) => ({
      ...r,
      status_label: PERIOD_STATUS_LABEL[r.status] || r.status,
      // 结转状态与关账状态**分开显示**：一个期间可能"已结转未关账"
      // （结转完检查一遍再关账，这是正常节奏），也可能"未结转已关账"
      // （035 之前的历史数据）。合成一个字段的话这两种状态就分不出来了。
      carried: !!r.closing_voucher_id,
      closing_label: r.closing_voucher_id ? '已结转' : '未结转'
    }))
}

export function getPeriod(db, period) {
  return db.prepare('SELECT * FROM accounting_periods WHERE period=?').get(assertPeriod(period)) || null
}

export function isPeriodClosed(db, period) {
  return getPeriod(db, period)?.status === 'closed'
}

/**
 * 本期是否已结转（有结转凭证挂在期间上）。
 *
 * 判据只认 `closing_voucher_id` 非空 —— **不去查凭证表**。
 * 理由：撤销结转与关账是两个动作，若这里再查一次凭证，
 * "凭证被删了但期间列没清"这种状态会得出两种答案，
 * 而"结转了没有"必须有唯一答案。结构一致性由迁移 035 的 verify 保证。
 */
export function isPeriodCarried(db, period) {
  return !!getPeriod(db, period)?.closing_voucher_id
}

export function ensurePeriod(db, period, { remark = null } = {}) {
  const p = assertPeriod(period)
  db.prepare('INSERT OR IGNORE INTO accounting_periods (period,status,remark) VALUES (?,?,?)').run(p, 'open', remark)
  return getPeriod(db, p)
}

/**
 * **过账闸门**（唯一实现）。
 * `lib/accounting.js` 的 `postVoucher` 与本模块的 `closePeriod` 都调它。
 */
export function assertPeriodOpen(db, period) {
  const p = assertPeriod(period)
  if (isPeriodClosed(db, p)) {
    throw new PeriodError(
      'PERIOD_CLOSED',
      `会计期间 ${p} 已关账，不能再过账（如需修改请先反关账并填写理由）`,
      409,
      { period: p }
    )
  }
  return true
}

export default {
  assertPeriod, shiftPeriod, assertPeriodOpen, isPeriodClosed, isPeriodCarried,
  listPeriods, getPeriod, ensurePeriod, PERIOD_STATUS_LABEL, CARRY_BIZ_TYPE
}
