/**
 * ============================================================================
 * 文件标识：server/lib/period-audit.js ｜ 期间审计链（批次 Q）：把"谁在什么时候把关账/结转/年结/分配改成了什么样"落成**可重放**的日志
 * ============================================================================
 * 【职责】期间审计链（批次 Q）：把"谁在什么时候把关账/结转/年结/分配改成了什么样"落成**可重放**的日志
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 期间审计链（批次 Q）：把"谁在什么时候把关账/结转/年结/分配改成了什么样"落成**可重放**的日志
//
// ===========================================================================
// 一、只有一份「动作 ↔ 效果」定义（本文件最重要的部分）
// ===========================================================================
// 八个动作散在三个模块里（`report.js` 两个、`closing.js` 两个、`annual.js` 四个），
// 每个动作都是"改某个字段 + 写一条日志"。如果日志的内容由各个调用点自己拼，
// 那么"这个动作改了什么"就会有**两份定义**：一份在 `UPDATE` 语句里，一份在日志参数里。
// 两份定义迟早只改一处，而它的表现是**日志说改 A、实际改了 B** ——
// 两者都"看起来正常"，只有把日志重放一遍才会现形。
//
// 所以效果只在这里声明一次（`PERIOD_ACTIONS[x].effect`），调用方只报"我做了什么动作"：
//
//     logPeriodChange(db, { period, action: 'profit_carry', voucherId: v.id, ... })
//
// `effect` 的取值含义：
//   · `{ period_status: 'closed' | 'open' }` —— 把期间状态改成它；
//   · `{ x_voucher_id: 'voucher' }`         —— 把该指针指向**本行记录的凭证**；
//   · `{ x_voucher_id: null }`              —— 把该指针**清空**（撤销类动作）；
//   · `spread_year: true`                   —— 该动作对该年度**每一期**都生效（年结封整年）。
// 没有出现在 `effect` 里的字段 = **本动作不动它**（重放时保持前值）。
// 这三态（指向 / 清空 / 不动）必须能分开，否则"撤销"与"不涉及"在日志里长得一模一样。
//
// ===========================================================================
// 二、日志只追加，且必须与动作同事务
// ===========================================================================
// 本文件**只有一个 INSERT**，没有 UPDATE、没有 DELETE —— 一旦允许修改，
// "谁改过账"就退化成"谁有权限改日志"。
// 并且 `logPeriodChange` 会**当场断言自己在一个事务里**（`db.inTransaction`）：
// 这条铁律写进文档没人记得，写成断言才拦得住。反例注入时它还会先跳出来喊一声
// `AUDIT_OUTSIDE_TX`，而不是安静地把一致性交给运气。
//
// ===========================================================================
// 三、自证：重放日志必须得到期间表的现状（两条路径互证）
// ===========================================================================
// 期间表上的列是**指针**（现状），日志是**历史**。两者的关系是一条可验证的不变量：
//
//     从空状态开始，按 id 顺序应用每一条日志的效果，得到的必须是今天的样子。
//
// 这条互证之所以有分量，是因为两条路径的**出处不同**：
//   · 现状一侧来自各动作里的 `UPDATE accounting_periods ...`；
//   · 历史一侧来自 `logPeriodChange` 写下的行。
// 而它们**共享**的是"动作有哪些"（`PERIOD_ACTIONS`）—— 所以它抓得到
// "改了状态忘了写日志""日志写了状态没改"，抓不到"动作表本身写错"。
// 后者由另外两条守着：`PERIOD_AUDIT_UNKNOWN_ACTION`（动作名必须认识）
// 与下面第四节的字段级双向核对。
//
// ===========================================================================
// 四、字段级双向核对：`closed_by` 有值就必须有关账日志（反向来源是 vouchers）
// ===========================================================================
// 重放核对有一个盲区（批次 P 的教训：先问两条路径**共享**什么）：
// 如果某个动作**既**没写日志**也没**改状态，重放与现状会一致 —— 于是它不响。
// 补位的是两条**来源不同**的核对：
//   · 期间表上的**理由/指针字段**（`reopen_reason` / `closing_reverse_reason` / …）
//     是另一个落点，它们非空就意味着"那个动作确实发生过" ⇒ 必须有对应日志；
//   · **凭证表**更硬：一张 `biz_type='profit_carry'` 的凭证是**实际发生过的事**，
//     它必须能被某条日志认领（这条路径完全不读期间表）。
// 两条都是"另一条路径"，不是"再算一遍同一个东西"。
//
// ===========================================================================
// 五、基线条目：'baseline' 不是动作，是"日志开始之前的现状"
// ===========================================================================
// 迁移 037 会给"已经用过、但动作发生在日志表存在之前"的期间补一条 `baseline`。
// 它让重放不变量**从第一个期间起**就成立，而不是从"我们开始记日志那天"起才成立 ——
// 否则"让探针只查有日志的期间"会把唯一需要解释的那个状态刚好跳过
// （批次 O 的教训：探针的**前提条件**也要审，"不适用"与"通过"在输出上一样）。
import { assertPeriod, getPeriod, shiftPeriod } from './period.js'

export class PeriodAuditError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // 与 `lib/report.js` 的 `ReportError` 同一条：HTTP 层只认 `.status`
    this.status = http
    this.detail = detail
  }
}

/** 期间表上"由动作改变"的四个字段。名字与日志列**完全同名**，重放才能逐字段比对。 */
export const PERIOD_STATE_KEYS = ['period_status', 'closing_voucher_id', 'annual_voucher_id', 'dist_voucher_id']

/**
 * 八个动作 + 基线。**这是全项目唯一的「动作 ↔ 效果」定义。**
 *
 * `scope`：`period` = 作用于某一期；`year` = 作用于某一年（年结会封整年，
 *   只按期间记会让"这一期是被年结封的"这件事查不出来）。
 * `requires_reason`：撤销/反关账类动作必须写理由（与"作废已过账凭证"同一个道理）。
 * `spread_year`：动作效果扩散到该年度每一期。
 */
export const PERIOD_ACTIONS = {
  // —— 非动作：迁移回填的现状快照。放在这里是为了让"未知动作"探针有个白名单，
  //    而它的语义（整行快照）由 `replayPeriodAudit` 单独处理。
  baseline: { label: '基线（迁移时现状快照）', scope: 'period', effect: 'snapshot' },

  period_close: { label: '关账', scope: 'period', effect: { period_status: 'closed' } },
  period_reopen: { label: '反关账', scope: 'period', effect: { period_status: 'open' }, requires_reason: true },

  profit_carry: { label: '期末结转', scope: 'period', effect: { closing_voucher_id: 'voucher' } },
  carry_reverse: { label: '撤销期末结转', scope: 'period', effect: { closing_voucher_id: null }, requires_reason: true },

  annual_carry: { label: '年度结转', scope: 'year', effect: { annual_voucher_id: 'voucher', period_status: 'closed', spread_year: true } },
  annual_reverse: { label: '撤销年度结转', scope: 'year', effect: { annual_voucher_id: null }, requires_reason: true },

  profit_distribution: { label: '利润分配', scope: 'year', effect: { dist_voucher_id: 'voucher' } },
  dist_reverse: { label: '撤销利润分配', scope: 'year', effect: { dist_voucher_id: null }, requires_reason: true }
}

/** 撤销/反关账类动作（必须写理由） */
export const REASON_REQUIRED_ACTIONS = Object.entries(PERIOD_ACTIONS)
  .filter(([, v]) => v.requires_reason)
  .map(([k]) => k)

/**
 * 期间表上每个"有值就该有日志"的字段，以及哪些动作能解释它。
 * 基线条目能解释一切（它是整行快照）。
 */
export const FIELD_LEDGER = [
  { field: 'closed_by', logField: 'closed_by', actions: ['period_close', 'annual_carry'] },
  { field: 'reopen_reason', logField: 'reopen_reason', actions: ['period_reopen'] },
  { field: 'closing_voucher_id', logField: 'closing_voucher_id', actions: ['profit_carry'] },
  { field: 'closing_reverse_reason', logField: 'closing_reverse_reason', actions: ['carry_reverse'] },
  { field: 'annual_voucher_id', logField: 'annual_voucher_id', actions: ['annual_carry'] },
  { field: 'annual_reverse_reason', logField: 'annual_reverse_reason', actions: ['annual_reverse'] },
  { field: 'dist_voucher_id', logField: 'dist_voucher_id', actions: ['profit_distribution'] },
  { field: 'dist_reverse_reason', logField: 'dist_reverse_reason', actions: ['dist_reverse'] }
]

const POINTER_COLUMNS = ['closing_voucher_id', 'annual_voucher_id', 'dist_voucher_id']

/** 派生凭证：这三类的凭证是"算法/决议生成的动作凭证"，每一张都必须能被日志认领 */
export const ACTION_VOUCHER_BIZ_TYPES = ['profit_carry', 'annual_carry', 'profit_distribution']

// ---------------------------------------------------------------------------
// 一、唯一写入点
// ---------------------------------------------------------------------------
/**
 * 写一条期间审计日志。**全项目唯一**的写法（只有一个 INSERT）。
 *
 * 调用约定（三条都会被当场断言，不是文档里的建议）：
 *   ① 必须在事务里 —— 日志与产生它的动作同生共死；
 *   ② `action` 必须是 `PERIOD_ACTIONS` 里的名字 —— 否则宁可炸，也不要落一条
 *      代码事后解释不了的记录；
 *   ③ 撤销类动作必须带 `reason`。
 */
export function logPeriodChange(db, {
  period,
  action,
  scopeKey = null,
  statusBefore = null,
  statusAfter = null,
  voucherId = null,
  voucherDocNo = null,
  amount = null,
  reason = null,
  remark = null,
  actor = null,
  detail = null
} = {}) {
  const p = assertPeriod(period)
  const spec = PERIOD_ACTIONS[action]
  if (!spec) {
    throw new PeriodAuditError(
      'UNKNOWN_ACTION',
      `审计日志不认识动作「${action}」；动作名必须来自 lib/period-audit.js 的 PERIOD_ACTIONS（新增动作时在同一处登记效果）`,
      500,
      { action, period: p }
    )
  }
  if (!db.inTransaction) {
    throw new PeriodAuditError(
      'AUDIT_OUTSIDE_TX',
      `动作「${spec.label}」的审计日志必须在事务内写入（期间 ${p}）—— 否则会出现"账改了、日志没写"或反之`,
      500,
      { action, period: p }
    )
  }
  const why = String(reason ?? '').trim()
  if (spec.requires_reason && !why) {
    throw new PeriodAuditError(
      'AUDIT_REASON_REQUIRED',
      `动作「${spec.label}」必须写理由（期间 ${p}）—— 撤销一个已定稿的动作要答得出为什么`,
      400,
      { action, period: p }
    )
  }

  const eff = spec.effect && typeof spec.effect === 'object' ? spec.effect : {}
  const scopeKeyFinal = spec.scope === 'year' ? String(scopeKey ?? p.slice(0, 4)) : p
  // 只有 `effect` 里声明过的指针才被写入；其余留 NULL（= 本动作不动它）
  const ptr = {}
  for (const c of POINTER_COLUMNS) ptr[c] = eff[c] === 'voucher' ? (voucherId ?? null) : null

  const info = db
    .prepare(`
      INSERT INTO period_audit_log
        (period, action, action_label, scope, scope_key,
         status_before, status_after,
         closing_voucher_id, annual_voucher_id, dist_voucher_id,
         voucher_doc_no, amount, reason, remark,
         actor_id, actor_name, actor_source, detail)
      VALUES (?,?,?,?,?, ?,?, ?,?,?, ?,?,?,?, ?,?,?,?)
    `)
    .run(
      p, action, spec.label, spec.scope, scopeKeyFinal,
      statusBefore, statusAfter ?? eff.period_status ?? null,
      ptr.closing_voucher_id, ptr.annual_voucher_id, ptr.dist_voucher_id,
      voucherDocNo, amount, why || null, remark || null,
      actor?.id ?? null, actor?.name ?? null, actor?.source || 'web',
      detail ? JSON.stringify(detail) : null
    )
  return Number(info.lastInsertRowid)
}

// ---------------------------------------------------------------------------
// 二、重放（纯函数，可被测试注入）
// ---------------------------------------------------------------------------
/**
 * 从日志重放某一期的状态。
 *
 * `entries` 可注入（与 `auditComparison` 的 `result` 参数同一个用法）：
 * 测试要能拿一份**造出来的**日志去问"如果日志是这样，重放会不会与现状对不上"，
 * 而不必真的去改库。
 */
export function replayPeriodAudit(db, { period, entries = null }) {
  const p = assertPeriod(period)
  const y = p.slice(0, 4)
  const log = entries || db
    .prepare(`
      SELECT * FROM period_audit_log
       WHERE (scope='period' AND scope_key=?)
          OR (scope='year'   AND scope_key=?)
       ORDER BY id
    `)
    .all(p, y)

  return { period: p, entries: log, replayed: replayEntries(log, p) }
}

/** 单期的重放内核：给定一组日志与目标期间，算出状态。 */
export function replayEntries(entries, period) {
  const p = assertPeriod(period)
  const state = { period_status: 'open', closing_voucher_id: null, annual_voucher_id: null, dist_voucher_id: null }
  for (const e of entries) {
    const spec = PERIOD_ACTIONS[e.action]
    // 未知动作**跳过**（不是报错）：它由 `PERIOD_AUDIT_UNKNOWN_ACTION` 单独报，
    // 在这里再炸一次只会让同一个问题以两种面目出现。
    if (!spec) continue

    if (e.action === 'baseline') {
      // 基线是**整行快照**：它一次性给出四个字段的值（没有"之前"可言）
      state.period_status = e.status_after || 'open'
      for (const c of POINTER_COLUMNS) state[c] = e[c] ?? null
      continue
    }

    const eff = spec.effect || {}
    if (eff.period_status) state.period_status = eff.period_status
    for (const c of POINTER_COLUMNS) {
      if (!(c in eff)) continue
      // 年维度动作的凭证指针挂在**年末期间**那一行上（年结/分配的 UPDATE 都写 `WHERE period=YYYY-12`），
      // 所以它只对 12 月生效 —— 否则每个非 12 月的期间都会重放出"别人家的指针"，
      // 而那会把一条正确的日志报成不一致（假红比漏报更消耗信任）。
      if (e.scope === 'year' && p !== `${e.scope_key}-12`) continue
      state[c] = eff[c] === 'voucher' ? (e[c] ?? null) : null
    }
  }
  return state
}

/** 期间表上的现状（与重放结果逐字段同形，便于直接比对） */
export function periodStateOf(db, period) {
  const row = getPeriod(db, period)
  return {
    period_status: row?.status ?? 'open',
    closing_voucher_id: row?.closing_voucher_id ?? null,
    annual_voucher_id: row?.annual_voucher_id ?? null,
    dist_voucher_id: row?.dist_voucher_id ?? null
  }
}

// ---------------------------------------------------------------------------
// 三、自证
// ---------------------------------------------------------------------------
/**
 * 审计链的全部不变量。**全库扫描**，不是"只查我正在看的那一期" ——
 * 只在用户点某期时才跑的探针等于不跑（批次 N 的教训）。
 */
export function auditPeriodTrail(db, { log = null, periods = null } = {}) {
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  const known = Object.keys(PERIOD_ACTIONS)
  const allLog = log || db.prepare('SELECT * FROM period_audit_log ORDER BY id').all()
  const allPeriods = periods || db.prepare('SELECT * FROM accounting_periods ORDER BY period').all()

  // ① 动作名必须是代码认识的。出现陌生名字只有两种可能：有人绕过唯一写入点手写了一条，
  //    或者线上跑着一版更老的代码 —— 两种都必须当场说，而不是安静地"跳过不认得的行"。
  const unknown = [...new Set(allLog.map((r) => r.action))].filter((a) => !known.includes(a))
  if (unknown.length) {
    push('PERIOD_AUDIT_UNKNOWN_ACTION', `审计日志里出现了代码不认识的动作：${unknown.join('、')}（唯一的写入点是 lib/period-audit.js 的 logPeriodChange）`, { actions: unknown })
  }

  // ② 撤销类动作必须有理由。"谁撤销的"与"为什么撤销"是同一件事的两半。
  const noReason = allLog.filter((r) => PERIOD_ACTIONS[r.action]?.requires_reason && !String(r.reason ?? '').trim())
  if (noReason.length) {
    push('PERIOD_AUDIT_REASON_REQUIRED', `有 ${noReason.length} 条撤销类日志没有写理由（如 ${noReason[0].period} ${noReason[0].action_label}）：${noReason.slice(0, 3).map((x) => `${x.period}·${x.action}`).join('、')}`, { entries: noReason.map((x) => ({ period: x.period, action: x.action })) })
  }

  // 按期间归组（一次查库，避免 N 次）
  const byPeriod = new Map()
  for (const r of allLog) {
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, [])
    byPeriod.get(r.period).push(r)
  }
  const actionSetOf = (p) => new Set((byPeriod.get(p) || []).map((r) => r.action))

  // ③ 重放 ≠ 现状
  const desync = []
  for (const row of allPeriods) {
    const p = row.period
    const ents = byPeriod.get(p) || []
    // 年维度动作也作用于这一期（scope_key = 年份），所以要把它们并进来
    const yearEnts = allLog.filter((r) => r.scope === 'year' && r.scope_key === p.slice(0, 4))
    const merged = [...ents, ...yearEnts].sort((a, b) => a.id - b.id)
    const want = replayEntries(merged, p)
    const got = {
      period_status: row.status ?? 'open',
      closing_voucher_id: row.closing_voucher_id ?? null,
      annual_voucher_id: row.annual_voucher_id ?? null,
      dist_voucher_id: row.dist_voucher_id ?? null
    }
    for (const k of PERIOD_STATE_KEYS) {
      if (want[k] !== got[k]) desync.push(`${p} 的 ${k}：重放日志得到 ${want[k] ?? '空'}，期间表上是 ${got[k] ?? '空'}`)
    }
  }
  if (desync.length) {
    push('PERIOD_AUDIT_DESYNC', `期间表的现状无法由审计日志重放出来（${desync.length} 处）：${desync.slice(0, 3).join('；')} —— 说明有动作改了状态却没留下（或写错了）日志`, { items: desync })
  }

  // ④ 字段级双向核对：期间表上有值 ⇒ 必须有能解释它的动作日志。
  //    它补的是重放的盲区 —— "既没写日志、也没改状态"的动作重放看不出来，
  //    但理由/指针字段是**另一个落点**，它不会一起消失。
  const orphanFields = []
  for (const row of allPeriods) {
    const acts = actionSetOf(row.period)
    if (acts.has('baseline')) continue // 基线是整行快照，能解释任何字段
    for (const { field, actions } of FIELD_LEDGER) {
      const v = row[field]
      if (v === null || v === undefined || v === '' || v === 0) continue
      if (!actions.some((a) => acts.has(a))) {
        orphanFields.push(`${row.period} 的 ${field} 有值（${v}），但没有任何 ${actions.join('/')} 日志`)
      }
    }
  }
  if (orphanFields.length) {
    push('PERIOD_AUDIT_MISSING', `期间表上有留痕却没有对应的动作日志（${orphanFields.length} 处）：${orphanFields.slice(0, 3).join('；')}`, { items: orphanFields })
  }

  // ⑤ 凭证表 ↔ 日志：**这条路径完全不读期间表**。
  //    一张派生凭证是"实际发生过的事"，它必须能被某条日志认领 ——
  //    否则就是"账上多了一张票，而没人记得谁生成的"。
  const voucherOrphans = db
    .prepare(`
      SELECT v.id, v.doc_no, v.biz_type, v.period
        FROM vouchers v
       WHERE v.biz_type IN (${ACTION_VOUCHER_BIZ_TYPES.map(() => '?').join(',')})
         AND NOT EXISTS (
           SELECT 1 FROM period_audit_log l
            WHERE l.closing_voucher_id = v.id
               OR l.annual_voucher_id  = v.id
               OR l.dist_voucher_id    = v.id
         )
       ORDER BY v.id
    `)
    .all(...ACTION_VOUCHER_BIZ_TYPES)
  if (voucherOrphans.length) {
    push('PERIOD_AUDIT_VOUCHER_ORPHAN', `有 ${voucherOrphans.length} 张派生凭证（期末结转/年度结转/利润分配）在审计日志里找不到来源（如 ${voucherOrphans[0].doc_no} / ${voucherOrphans[0].period}）：账上有票，但没人记得是谁生成的`, { vouchers: voucherOrphans.map((x) => x.doc_no) })
  }

  // ⑥ 已年结的年度必须整年关账。"封整年"是年结的承诺之一，而"承诺"要被核对 ——
  //    重放只看得见"12 月有没有年结凭证"，看不见"该年 3 月是不是还开着"。
  const yearClosedGaps = []
  const yearsWithAnnual = [...new Set(allLog.filter((r) => r.action === 'annual_carry').map((r) => r.scope_key))]
  for (const y of yearsWithAnnual) {
    // 撤销之后再年结会同时留下 annual_carry 与 annual_reverse；以**最后一次**为准
    const lastAnnual = allLog.filter((r) => r.action === 'annual_carry' && r.scope_key === y).pop()
    const lastReverse = allLog.filter((r) => r.action === 'annual_reverse' && r.scope_key === y).pop()
    if (lastReverse && lastReverse.id > lastAnnual.id) continue // 已撤销：不再承诺整年关账
    for (const row of allPeriods) {
      if (row.period.slice(0, 4) !== y) continue
      if (row.status !== 'closed') yearClosedGaps.push(`${row.period} 属于已年结的 ${y} 年，却还是「${row.status}」`)
    }
  }
  if (yearClosedGaps.length) {
    push('PERIOD_AUDIT_YEAR_GAP', `年结承诺"封整年"，但该年度仍有期间未关账（${yearClosedGaps.length} 处）：${yearClosedGaps.slice(0, 3).join('；')}`, { items: yearClosedGaps })
  }

  return {
    ok: problems.length === 0,
    problems,
    periods_checked: allPeriods.length,
    entries_checked: allLog.length,
    years_checked: yearsWithAnnual.length
  }
}

// ---------------------------------------------------------------------------
// 四、查询（界面用）
// ---------------------------------------------------------------------------
export function listPeriodAudit(db, { period = null, year = null, action = null, limit = 200 } = {}) {
  const args = []
  let where = 'WHERE 1=1'
  if (period) { where += ' AND period = ?'; args.push(assertPeriod(period)) }
  // "看某一年的历史"必须**两边的都看**：年度动作（年结/分配，`scope_key=YYYY`）
  // **和**这一年的期间动作（关账/结转，`scope_key=YYYY-MM`）。
  // 只匹配 `scope_key` 的话，界面上"2024 年做过什么"只会显示一条年结 ——
  // 而那 11 次关账同样是这一年的事，漏掉它等于漏掉了大半条账为什么变成现在这样。
  if (year) { where += " AND (scope_key = ? OR (scope = 'period' AND substr(period,1,4) = ?))"; args.push(String(year), String(year)) }
  if (action) { where += ' AND action = ?'; args.push(String(action)) }
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const rows = db
    .prepare(`SELECT * FROM period_audit_log ${where} ORDER BY id DESC LIMIT ${cap}`)
    .all(...args)
  const total = db.prepare(`SELECT COUNT(*) c FROM period_audit_log ${where}`).get(...args).c
  return {
    rows: rows.map((r) => ({
      ...r,
      scope_label: r.scope === 'year' ? '年度动作' : '期间动作',
      actor_label: r.actor_source === 'migration' ? '迁移基线' : (r.actor_name || '—'),
      // 金额为 NULL = 本动作不涉及金额，与"金额是 0"是两件事（后者是"结了 0 元"）
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount)
    })),
    total,
    limit: cap,
    truncated: rows.length < total,
    actions: meta(db).actions
  }
}

/** 一次拿到某一年的年度动作（界面"这一年做过什么"用它） */
export function listYearAudit(db, { year, limit = 200 }) {
  return listPeriodAudit(db, { year: String(year), limit })
}

export function meta(db) {
  const counts = db.prepare('SELECT action, COUNT(*) c FROM period_audit_log GROUP BY action').all()
  const byAction = new Map(counts.map((r) => [r.action, r.c]))
  return {
    log_table: 'period_audit_log',
    // 动作清单：界面据此生成筛选器；`implemented` 让"登记了但还没接上"的动作看得出来，
    // 而不是安静地少一个选项
    actions: Object.entries(PERIOD_ACTIONS).map(([value, v]) => ({
      value,
      label: v.label,
      scope: v.scope,
      requires_reason: Boolean(v.requires_reason),
      spread_year: Boolean(v.effect && v.effect.spread_year),
      count: byAction.get(value) || 0
    })),
    state_keys: PERIOD_STATE_KEYS,
    voucher_biz_types: ACTION_VOUCHER_BIZ_TYPES,
    note: '审计日志**只追加**：没有修改与删除路径。期间表上的列是「现状指针」，日志是「历史事实」；'
      + '自证的方式是从空状态按序重放日志，结果必须等于期间表的现状。'
  }
}

export default {
  PERIOD_ACTIONS,
  PERIOD_STATE_KEYS,
  REASON_REQUIRED_ACTIONS,
  FIELD_LEDGER,
  ACTION_VOUCHER_BIZ_TYPES,
  PeriodAuditError,
  logPeriodChange,
  replayPeriodAudit,
  replayEntries,
  periodStateOf,
  auditPeriodTrail,
  listPeriodAudit,
  listYearAudit,
  meta
}
