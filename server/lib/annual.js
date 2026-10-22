/**
 * ============================================================================
 * 文件标识：server/lib/annual.js ｜ 年度结转与利润分配（批次 O · 模块 28 的续之三）：让 4103 也有出路
 * ============================================================================
 * 【职责】年度结转与利润分配（批次 O · 模块 28 的续之三）：让 4103 也有出路
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 年度结转与利润分配（批次 O · 模块 28 的续之三）：让 4103 也有出路
//
// ===========================================================================
// 一、这一批补的是「月结做了，年结没做」
// ===========================================================================
// 批次 M 让每个期末把损益类科目（6xxx）转到 4103 本年利润。但 4103 从此**只进不出**：
// 它一年一年地累积，"账上到底有多少可分配的利润"这个问题**答不出来** ——
// 4103 的余额混了多个年度，而只有把每个年度**结清**到 4104，新年度才能从零累计。
//
//     月度结转：6xxx  ──▶ 4103        （每期一次，让损益科目归零）
//     年度结转：4103 ──▶ 4104        （每年一次，让"本年利润"归零、利润沉淀为"未分配利润"）
//     利润分配：4104 ──▶ 4105 / 4106…（**决议**：提盈余公积、分配股利）
//
// ⚠️ 4103 是**两个结转的接点**：月度结转的**目标**、年度结转的**来源**。
// 这个位置决定了本文件最要紧的那条前置检查（见第三节）。
//
// ===========================================================================
// 二、年度结转**不必**从发生额口径里剔除（与月度结转的关键差别）
// ===========================================================================
// 批次 M 花大力气把 `profit_carry` 从 `operating_*` 里剔除，否则结转 6001 的那一笔
// 会把营业收入冲成 0（贷 − 借 = 收入 − 收入 = 0）。
//
// 年度结转没有这个问题，因为它的两端**都是权益类科目**（4103 → 4104）：
//   · 利润表只看**损益类**科目的 `operating_signed`，年结一个损益科目都不碰；
//   · 试算平衡表的恒等式「期初 + 本期借 − 本期贷 = 期末」本就要求包含全部凭证，
//     剔掉它反而不成立。
// 所以 `subjectBalances` 的分流规则**一个字都不用改**。
// 这不是运气好，而是"只搬权益内部"这个性质带来的 —— 写下来，
// 免得下一个人照着月度结转的样子去加一处没有必要的剔除。
//
// ===========================================================================
// 三、年结必须在「全年都做完月度结转」之后（本文件最重要的一条判断）
// ===========================================================================
// 假设 2026 年只有 7 月做了月度结转、10 月没做。此时做年结会发生什么？
//   · 年结把 4103（只含 7 月的利润）转到 4104，并把 4103 归零；
//   · 10 月的损益**仍然挂在 6xxx 上**；
//   · 到 2027 年，4103 从 0 重新开始，而 2026-10 那些 6xxx 余额**永远**留在损益科目里
//     —— 它们已经错过了 2026 年的年结窗口，而年结一年只做一次。
//
// 这不是"少转一笔"，而是**一笔永久错账**，而且它**不会让任何账不平**：
// 资产仍然等于负债加权益，试算仍然平。所以它只能被前置检查拦住。
// 判据用**同一份实现** `uncarriedProfitSubjects`（月度结转同用它），不在这里再写一遍。
//
// ===========================================================================
// 四、年结 = 封整年；撤销必须反向解锁
// ===========================================================================
// 关账封的是**一期**，年结封的是**一年**：年结之后该年度所有期间一律置 `closed` ——
// 否则"9 月还没关账"会让年结后仍能往 2026 年塞凭证，而 4104 的金额就再也不对了。
//
// 于是形成一条真实的依赖链：**改账 → 关账 → 年结 → 利润分配**，
// 撤销必须反向：**撤分配 → 撤年结 → 反关账 → 改账**。
// 本批在 `reopenPeriod` 上补了一环：该期间所属年度已年结时，必须先撤销年度结转 ——
// 少了它，反关账就成了"绕过封账往旧年度塞凭证"的路。
//
// ⚠️ 撤销年结**不**把全年自动置回 `open`。"打开"是一个需要理由的动作，
// 而撤销年结只回答"这一年不再算结清了"，不回答"哪一期可以改"。
// 保持 `closed` 让每一步都有理由留痕。
//
// ===========================================================================
// 五、利润分配是**决议**，不是算法
// ===========================================================================
// 两个结转的金额都由余额决定（没有可选项），而分配回答的是
// 「**从 4104 里拿多少去提公积、分多少股利**」—— 那是股东会的决定，
// 没有任何东西能推导出它。所以金额**必须由人输入**，系统只做三件事：校验、记账、留痕。
//
// 校验里有一条特别要紧：目标科目**不能是 4103**（年结的来源）、**不能是 4104 自身**
// （那等于没分，而账还多了一张凭证）。也**不做"分配科目配置表"** ——
// 科目由决议决定，做成配置就变成"配置能改账"。
import * as A from './accounting.js'
import * as R from './report.js'
import { assertPeriod, ensurePeriod, getPeriod, shiftPeriod } from './period.js'
import { monthEnd } from './dates.js'
// 期间审计日志（批次 Q）。年结/分配既是"年度动作"也是"期间动作"：
// 日志的 `period` 记在**年末期间**（指针挂在这一行上），`scope_key` 记年份 ——
// 只按期间记会让"这一期是被年结顺手封的"这件事查不出来。
import { logPeriodChange } from './period-audit.js'
import { readSetting } from './settings.js'

// 「本期还有哪些损益科目没结转」的判据只此一处 —— 在 `lib/report.js` 里，
// 与关账前置、`verify-seed` 第 19 节、以及月度结转共用**同一个实现**。
// 本文件不重写一遍：年结最重要的一条前置就是"全年已做月度结转"，
// 而"已结转"的定义如果在这里再判一次，两处迟早只改一处。
const uncarriedProfitSubjects = R.uncarriedProfitSubjects

const money2 = (n) => Number(Number(n || 0).toFixed(2))

export class AnnualError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message)
    this.name = 'AnnualError'
    this.code = code
    // 同时写 `.status` 与 `.http`：HTTP 层的统一翻译器只认 `.status`（批次 L 的缺陷一百三十一）
    this.status = status
    this.http = status
    this.detail = detail
  }
}

/** 年结凭证的业务类型 */
export const ANNUAL_BIZ_TYPE = 'annual_carry'
/** 利润分配凭证的业务类型 */
export const DIST_BIZ_TYPE = 'profit_distribution'
/** 两者的来源表（与期间 id 一起构成幂等三元组） */
export const ANNUAL_SOURCE_TYPE = 'accounting_periods'

// ---------------------------------------------------------------------------
// 一、年度与期间
// ---------------------------------------------------------------------------
const YEAR_RE = /^\d{4}$/

export function assertYear(year) {
  const y = String(year ?? '').trim()
  if (!YEAR_RE.test(y)) {
    throw new AnnualError('BAD_YEAR', `年度格式必须是 YYYY，收到「${year}」`, 400)
  }
  return y
}

/**
 * 期间 → 年度。**年度是派生量**，所以不为它建表。
 *
 * 算术的**唯一出处是 `report.js` 的 `fiscalYearOf`**（批次 U 之四 / ③-c 把"年初"
 * 变成可配置的之后，这里不再自己 `slice(0,4)`）。
 * 传 `1` 是因为**年结只在"会计年度 = 自然年"时允许**（`assertNaturalFiscalYear` 守着，
 * 起点非 1 月时这条链上的每个入口都会被拒），所以这里的年度就是自然年 ——
 * 这个 `1` 是**被闸门保证过的常量**，不是"顺手写死"。
 */
export function yearOf(period) {
  return String(R.fiscalYearOf(assertPeriod(period), 1).fiscal_year)
}

/** 该年度的"年末期间"。年结与分配的留痕都挂在这一期上 —— 一年只有一个 12 月。 */
export function decemberPeriod(year) {
  return `${assertYear(year)}-12`
}

/**
 * 该年度**需要纳入年结**的期间集合（升序）。
 * 三个来源取并集：已登记的期间 / 有已过账凭证的期间 / 登记过期初的期间。
 * 少取一个来源的后果是"某个月被漏在年结之外"，而那种错**不会让账不平**。
 */
export function yearPeriods(db, year) {
  const y = assertYear(year)
  // 窗口的两端同样取自 `fiscalYearOf`（起止都在同一个地方算）。
  // 起点非 1 月时这条链根本走不到这里（`assertNaturalFiscalYear` 会先拒），
  // 所以 `1` 与 `yearOf` 里的那个是同一个常量。
  const fy = R.fiscalYearOf(`${y}-01`, 1)
  return db
    .prepare(`
      SELECT DISTINCT period FROM (
        SELECT period FROM accounting_periods
        UNION SELECT period FROM vouchers WHERE status = 'posted'
        UNION SELECT period FROM accounting_opening_balances
      ) WHERE period >= ? AND period <= ? ORDER BY period
    `)
    .all(fy.from, fy.to)
    .map((r) => String(r.period))
}

// ---------------------------------------------------------------------------
// 二、年结目标科目（会计政策，唯一出处是 settings）
// ---------------------------------------------------------------------------
export function retainedSubjectCode(db) {
  return readSetting(db, 'annual_retained_subject')
}

/**
 * 目标科目本身。四条校验都是刻意的（与月度结转的目标科目校验同源）：
 * 必须存在 / 必须 active / 必须是**叶子**（挂父科目不会报错，只会让"父 = 子之和"悄悄不成立）/
 * 必须是**权益类**（结转到资产或负债科目上，账还能平 —— 但资产负债表会同时错两块，而它仍然是平的）。
 */
export function retainedSubject(db) {
  const code = retainedSubjectCode(db)
  const s = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
  if (!s) throw new AnnualError('RETAINED_SUBJECT_NOT_FOUND', `未分配利润科目 ${code} 不存在（配置项 settings.annual_retained_subject）`, 409)
  if (s.status !== 'active') throw new AnnualError('RETAINED_SUBJECT_INACTIVE', `未分配利润科目 ${s.code} ${s.name} 已停用`, 409)
  if (!s.is_leaf) throw new AnnualError('RETAINED_SUBJECT_NOT_LEAF', `未分配利润科目 ${s.code} ${s.name} 不是叶子科目`, 409)
  if (s.category !== 'equity') {
    throw new AnnualError(
      'RETAINED_SUBJECT_NOT_EQUITY',
      `未分配利润科目 ${s.code} ${s.name} 的类别是「${s.category}」，年度结转只能在权益类科目之间进行（否则报表会同时错两块，而它仍然是平的）`,
      409
    )
  }
  return s
}

/** 月度结转的目标科目（4103 本年利润）—— 年结的来源，也是分配**禁止**指向的科目 */
function annualProfitSubjectCode(db) {
  return readSetting(db, 'closing_profit_subject')
}

// ---------------------------------------------------------------------------
// 三、试算（只算不写）：界面的"预览"与真正的"年结"走同一个函数
// ---------------------------------------------------------------------------
/**
 * 某年度 4103 的期末余额（= 将要结转的金额）。
 *
 * 取 12 月的**期末余额**而不是"全年各期发生额之和"：
 *   · 期末余额天然就是"本年度累计结转到 4103 的净额"（前提是年初 4103 为 0）；
 *   · 而它与"各期之和"只在**上年未年结**时才不同 —— 那时余额里含往年的利润，
 *     而那正是要被结转掉的东西（4103 本来就该是"累计尚未转入 4104 的利润"）。
 * 12 月期间不存在也能算：`subjectBalances` 的 `opening` 会滚动到该时点、本期发生为 0。
 */
export function profitCarryBalance(db, { year }) {
  const y = assertYear(year)
  const code = annualProfitSubjectCode(db)
  const balances = R.subjectBalances(db, { period: decemberPeriod(y) })
  const row = balances.rows.find((r) => r.code === code)
  return {
    subject_code: code,
    subject_name: row?.name ?? null,
    /** 借 − 贷 口径：**负数 = 贷方余额 = 盈利** */
    signed: money2(row?.closing_signed ?? 0),
    /** 人读口径：正数 = 本年度累计盈利 */
    profit: money2(-(row?.closing_signed ?? 0))
  }
}

/** 该年度的利润表净利润合计（来自同一个 `computeReport`，**不在这里重算**） */
export function yearNetProfit(db, year) {
  const y = assertYear(year)
  let total = 0
  for (const p of yearPeriods(db, y)) {
    total = money2(total + (R.incomeStatement(db, { period: p }).totals.PL_NET_PROFIT ?? 0))
  }
  return money2(total)
}

/**
 * 年结的前置检查（**唯一实现**：`planAnnual` 与 `carryForwardAnnual` 都调它）。
 * 每一条都在 `problems` 里给出**可执行的指引**，而不是一句"不能年结"。
 */
export function annualPrecheck(db, { year }) {
  const y = assertYear(year)
  const dec = decemberPeriod(y)
  const periods = yearPeriods(db, y)
  const problems = []

  if (!periods.length) {
    problems.push({
      code: 'YEAR_EMPTY',
      message: `${y} 年没有任何期间（既无凭证也无期初登记），没有可年结的账`,
      hint: '年结回答的是"这一年的利润去哪了"；一个没有账的年度不需要这个回答。'
    })
  }

  // ① 全年无未过账草稿：草稿一转正，年结金额就变了，而年结一年只做一次
  const drafts = db
    .prepare("SELECT period, COUNT(*) c FROM vouchers WHERE status='draft' AND substr(period,1,4)=? GROUP BY period ORDER BY period")
    .all(y)
  if (drafts.length) {
    problems.push({
      code: 'YEAR_HAS_DRAFT',
      message: `${y} 年有未过账凭证（${drafts.map((d) => `${d.period}:${d.c} 张`).join('、')}）`,
      hint: '草稿一转过账，本年利润就变了，而年结一年只做一次。请先过账或作废它们。'
    })
  }

  // ② **全年已做月度结转** —— 本文件最重要的前置（见文件头第三节）
  const pending = periods
    .map((p) => ({ period: p, subjects: uncarriedProfitSubjects(db, { period: p }) }))
    .filter((x) => x.subjects.length > 0)
  if (pending.length) {
    problems.push({
      code: 'YEAR_NOT_CARRIED',
      message: `${y} 年有 ${pending.length} 个期间还没做期末结转（${pending.map((x) => x.period).join('、')}）`,
      hint:
        '这是**一笔会永久消失的利润**：年结会把 4103 转到 4104 并把它归零，'
        + '而未结转过的那几个月，损益仍然挂在 6xxx 上 —— 它们已经错过本年度唯一的年结窗口，'
        + '而账**仍然是平的**，所以只有这条检查能拦住它。请先逐期做期末结转。'
    })
  }

  // ③ 12 月必须可过账（年结凭证要过账）
  const decRow = getPeriod(db, dec)
  if (decRow?.status === 'closed') {
    problems.push({
      code: 'DECEMBER_CLOSED',
      message: `${y}-12 已关账，年结凭证无法过账`,
      hint:
        '正常流程里 **12 月不需要单独关账** —— 年结本身就会把全年置为「已关账」。'
        + '请先反关账 12 月（反关账要写理由），做完年结即可。'
    })
  }

  // ④ 年结的目标科目必须可用。**作为 problem 报出来，而不是抛** ——
  //    `planAnnual` 与 `listAnnual` 都会调本函数，抛错会让界面什么都看不到；
  //    而"为什么不能年结"（科目没建 / 不是叶子 / 不是权益类）比一个 500 有用得多。
  try {
    retainedSubject(db)
  } catch (e) {
    problems.push({
      code: e.code || 'RETAINED_SUBJECT_INVALID',
      message: e.message,
      hint: '请在「会计科目」里建好这个科目（必须是**权益类的叶子科目**），或改 settings.annual_retained_subject 指向别的科目。'
    })
  }

  // ⑤ 会计年度起点非 1 月时，年结这条路**整体不可用**（批次 U 之四 / ③-c）。
  //    同样作为 problem 报出来而不是抛：`planAnnual` / `listAnnual` 都要能把
  //    "为什么这里不能年结"显示出来，界面才好把入口禁掉并说明。
  const fiscalStart = R.fiscalStartMonth(db)
  if (fiscalStart !== 1) {
    problems.push({
      code: 'FISCAL_YEAR_UNSUPPORTED',
      message: `当前会计年度起始月是 ${fiscalStart} 月，**跨自然年的年结未实现**`,
      hint:
        '本系统只支持"会计年度 = 自然年"时做年结（年结链建在"年度 = 期间前 4 位"这个结构上）。'
        + '报表侧的累计与同比累计已经支持非 1 月起点；要把年结也改成按会计年度，需要另立一个批次。'
    })
  }

  const bal = profitCarryBalance(db, { year: y })
  if (!problems.length && Math.abs(bal.signed) <= 0.005) {
    problems.push({
      code: 'ANNUAL_NOTHING',
      message: `${y} 年末 ${bal.subject_code} 的余额为 0，没有需要结转的内容`,
      hint: '余额为 0 说明本年利润已结清（或全年没有损益），此年度不需要年结。'
    })
  }

  return {
    year: y,
    periods,
    december_period: dec,
    december_exists: !!decRow,
    december_status: decRow?.status ?? 'open',
    drafts_total: drafts.reduce((s, d) => s + Number(d.c), 0),
    uncarried_periods: pending.map((x) => x.period),
    balance: bal,
    ok: problems.length === 0,
    problems
  }
}

/** 年结预览（只算不写）。界面靠它回答"还要做什么才能年结"。 */
export function planAnnual(db, { year }) {
  const y = assertYear(year)
  const pre = annualPrecheck(db, { year: y })
  // 目标科目不可用时**不抛**：预览要能把"科目没建"这条问题连同其它前置一起显示出来，
  // 而不是只回一个 409。真正的抛错留给 `carryForwardAnnual`（那里才是"要记账了"）。
  let target = null
  try {
    target = retainedSubject(db)
  } catch {
    target = { id: null, code: retainedSubjectCode(db), name: null }
  }
  const targetLabel = target.name ? `${target.code} ${target.name}` : target.code
  const bal = pre.balance

  const lines = []
  if (Math.abs(bal.signed) > 0.005) {
    // 与其余额方向**相反**记一笔，把它冲平：
    //   贷方余额（盈利，signed < 0）→ 借 4103 / 贷 4104
    //   借方余额（亏损，signed > 0）→ 贷 4103 / 借 4104
    const liabilityDirection = bal.signed < 0 ? 'debit' : 'credit'
    const profitDirection = bal.signed < 0 ? 'credit' : 'debit'
    lines.push({
      seq: 1, summary: `年度结转 ${bal.subject_code} ${bal.subject_name ?? ''}`.trim(),
      direction: liabilityDirection, amount: Math.abs(bal.signed), subject_code: bal.subject_code
    })
    lines.push({
      seq: 2, summary: `${y} 年度损益转入 ${targetLabel}`,
      direction: profitDirection, amount: Math.abs(bal.signed), subject_code: target.code
    })
  }

  const row = getPeriod(db, pre.december_period)
  const yearProfit = yearNetProfit(db, y)
  return {
    year: y,
    december_period: pre.december_period,
    target: { id: target.id, code: target.code, name: target.name },
    /** 将要结转的金额（正数，人读口径 = 盈利） */
    carry_profit: bal.profit,
    carry_signed: bal.signed,
    /** 本年度利润表的净利润合计。与 `carry_profit` **不是同一个数**，这是刻意的：
     *  上年未年结时 4103 余额含往年利润，两者不等恰好说明"历史上没按期年结"。 */
    year_net_profit: yearProfit,
    lines,
    total_debit: money2(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0)),
    total_credit: money2(lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0)),
    periods: pre.periods,
    carried: !!row?.annual_voucher_id,
    annual_voucher_id: row?.annual_voucher_id ?? null,
    distributed: !!row?.dist_voucher_id,
    dist_voucher_id: row?.dist_voucher_id ?? null,
    precheck: pre
  }
}

// ---------------------------------------------------------------------------
// 四、年度结转（生成 → 过账 → 封整年）
// ---------------------------------------------------------------------------
/**
 * 年度结转（4103 → 4104）。**生成并立刻过账**，与月度结转同一个理由：
 * 一张没过账的结转凭证不改变任何报表数字，却会让界面显示"已年结"。
 *
 * 幂等**以凭证表为准**（不是以期间列为准），与月度结转同源：
 * 唯一约束是 `(biz_type, source_type, source_id)`，只看期间列会撞约束。
 */
export function carryForwardAnnual(db, { year, actor = null, remark = null }) {
  const y = assertYear(year)
  // 会计年度起点非 1 月时**明确拒绝**（批次 U 之四 / ③-c 的范围界）。
  // 这条闸门必须在最前面：`decemberPeriod(y)` 的假设就是"年度 = 自然年"，
  // 往下走每一步都建立在它之上。判据的唯一实现在 `report.js` 的 `assertNaturalFiscalYear`。
  R.assertNaturalFiscalYear(db)
  const dec = decemberPeriod(y)
  const row = ensurePeriod(db, dec)

  const exist = db
    .prepare('SELECT * FROM vouchers WHERE biz_type=? AND source_type=? AND source_id=?')
    .get(ANNUAL_BIZ_TYPE, ANNUAL_SOURCE_TYPE, row.id)
  if (exist && exist.status === 'posted') {
    return {
      year: y,
      replayed: true,
      reason: row.annual_voucher_id ? '本年度已年结' : '本年度已年结（期间指针缺失，已按凭证表为准）',
      pointer_missing: !row.annual_voucher_id,
      voucher: A.getVoucher(db, exist.id),
      plan: planAnnual(db, { year: y })
    }
  }
  if (exist) {
    throw new AnnualError(
      'ANNUAL_VOUCHER_NOT_POSTED',
      `${y} 年的年结凭证 ${exist.doc_no} 当前状态为「${exist.status}」，不能当作已年结；请先撤销年结记录后重试`,
      409,
      { year: y, voucher_id: exist.id, doc_no: exist.doc_no, voucher_status: exist.status }
    )
  }
  if (row.annual_voucher_id) {
    throw new AnnualError(
      'ANNUAL_VOUCHER_MISSING',
      `${y} 年记录的结转凭证 #${row.annual_voucher_id} 不存在；请先撤销年结记录再重试`,
      409,
      { year: y, annual_voucher_id: row.annual_voucher_id }
    )
  }

  // 前置检查在这里**再跑一次**（`planAnnual` 里已经跑过）：
  // 预览与执行之间可能隔了几分钟，而"那几分钟里有人补了一张 10 月的凭证"
  // 正好会让年结少转一笔 —— 所以执行路径必须自己判，不能信预览的结论。
  const pre = annualPrecheck(db, { year: y })
  if (!pre.ok) {
    throw new AnnualError(
      'ANNUAL_PRECHECK_FAILED',
      `年度 ${y} 还不能年结：${pre.problems.map((x) => x.message).slice(0, 2).join('；')}`,
      409,
      { year: y, problems: pre.problems }
    )
  }

  const plan = planAnnual(db, { year: y })
  const exec = db.transaction(() => {
    const v = A.persistVoucher(
      db,
      {
        biz_type: ANNUAL_BIZ_TYPE,
        source_type: ANNUAL_SOURCE_TYPE,
        // 来源就是**年末期间**：一年只有一个 12 月 ⇒ 一年只能年结一次，幂等由唯一约束兜底
        source_id: row.id,
        source_doc_no: dec,
        // 年结日期取**年末最后一天**（不是"今天"、也不写死 -31 —— 与月度结转同一条铁律）
        voucher_date: monthEnd(dec) || `${dec}-31`,
        period: dec,
        lines: plan.lines,
        label: `${y} 年度结转`
      },
      {
        actor,
        memo: remark || `${y} 年度结转：本年利润 ${plan.carry_profit} → ${plan.target.code} ${plan.target.name}`
      }
    )
    A.postVoucher(db, { id: v.id, actor })
    db.prepare(`
      UPDATE accounting_periods
         SET annual_voucher_id=?, annual_by=?, annual_by_name=?, annual_at=datetime('now','localtime'),
             annual_reverse_reason=NULL
       WHERE period=?
    `).run(v.id, actor?.id ?? null, actor?.name ?? null, dec)

    // **封整年**：该年度所有期间一律置 closed（含新建的 12 月）。
    // 不这么做的话，"9 月还没关账"会让年结后仍能往这一年塞凭证，而 4104 的金额就再也不对了。
    const closed = db
      .prepare("UPDATE accounting_periods SET status='closed', closed_by=COALESCE(closed_by,?), closed_by_name=COALESCE(closed_by_name,?), closed_at=COALESCE(closed_at, datetime('now','localtime')) WHERE substr(period,1,4)=? AND status<>'closed'")
      .run(actor?.id ?? null, actor?.name ?? null, y)
    // 一条年结日志同时表达两件事：指针落在 12 月、以及**整年被封**
    // （`effect` 里的 `spread_year` 让重放对这一年的每一期都得到 closed）。
    // 只在关账循环之后写一次，不按期间写 N 条 —— 那是同一个动作的 N 份记录。
    logPeriodChange(db, {
      period: dec,
      action: 'annual_carry',
      scopeKey: y,
      statusBefore: row.status,
      voucherId: v.id,
      voucherDocNo: v.doc_no,
      amount: plan.carry_profit,
      remark,
      actor,
      detail: { target_subject: plan.target.code, closed_periods: closed.changes }
    })
    return { voucherId: v.id, closedPeriods: closed.changes }
  })
  const out = exec()
  return {
    year: y,
    replayed: false,
    voucher: A.getVoucher(db, out.voucherId),
    closed_periods: out.closedPeriods,
    plan
  }
}

/**
 * 撤销年度结转。三道锁（少一条它就会变成一把"谁都能删凭证"的钥匙）：
 *   ① 必须写理由；
 *   ② **必须先撤销利润分配** —— 分配是年结的下游，先撤上游会让下游的金额失去依据；
 *   ③ **次年不能有已关账的期间** —— 撤销会改变次年的期初（滚动而来），
 *      而"已关账"承诺了那些报表不再变；
 *   ④ 只删 `biz_type='annual_carry'` 的凭证。
 *
 * ⚠️ 撤销**不**把全年置回 `open`（见文件头第四节）。
 */
export function reverseAnnual(db, { year, actor = null, reason = null }) {
  const y = assertYear(year)
  const dec = decemberPeriod(y)
  const row = getPeriod(db, dec)
  if (!row || !row.annual_voucher_id) {
    return { year: y, replayed: true, reason: '本年度未年结', removed: null }
  }
  if (!String(reason || '').trim()) {
    throw new AnnualError('ANNUAL_REVERSE_REASON_REQUIRED', `撤销 ${y} 年度结转必须填写理由`, 400, { year: y })
  }
  if (row.dist_voucher_id) {
    throw new AnnualError(
      'REVERSE_DISTRIBUTION_FIRST',
      `${y} 年已有利润分配凭证 #${row.dist_voucher_id}；撤销年结会让分配的金额失去依据 —— 请先撤销利润分配（撤销本身也要写理由）`,
      409,
      { year: y, dist_voucher_id: row.dist_voucher_id }
    )
  }
  const nextYear = String(Number(y) + 1)
  const nextClosed = db
    .prepare("SELECT period FROM accounting_periods WHERE status='closed' AND substr(period,1,4)=? ORDER BY period")
    .all(nextYear)
  if (nextClosed.length) {
    throw new AnnualError(
      'NEXT_YEAR_CLOSED',
      `${nextYear} 年已有 ${nextClosed.length} 个期间关账（${nextClosed.slice(0, 3).map((x) => x.period).join('、')}${nextClosed.length > 3 ? ' 等' : ''}）；撤销年结会改变次年的期初余额，而"已关账"承诺了那些报表不再变 —— 请先反关账次年相关期间`,
      409,
      { year: y, next_year: nextYear, closed: nextClosed.map((x) => x.period) }
    )
  }

  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(row.annual_voucher_id)
  if (v && v.biz_type !== ANNUAL_BIZ_TYPE) {
    throw new AnnualError(
      'NOT_AN_ANNUAL_VOUCHER',
      `${y} 年记录的凭证 ${v.doc_no} 不是年度结转凭证（biz_type=${v.biz_type}），拒绝撤销`,
      409,
      { year: y, voucher_id: v.id, biz_type: v.biz_type }
    )
  }
  const removed = v ? { id: v.id, doc_no: v.doc_no, status: v.status, total_debit: v.total_debit, voucher_date: v.voucher_date, memo: v.memo } : null
  const exec = db.transaction(() => {
    if (v) {
      db.prepare('DELETE FROM voucher_entries WHERE voucher_id=?').run(v.id)
      db.prepare('DELETE FROM vouchers WHERE id=?').run(v.id)
    }
    db.prepare(`
      UPDATE accounting_periods
         SET annual_voucher_id=NULL, annual_by=NULL, annual_by_name=NULL, annual_at=NULL,
             annual_reverse_reason=?
       WHERE period=?
    `).run(String(reason).trim(), dec)
    // ⚠️ 撤销年结**不**把整年置回 open（见文件头第四节）——日志里也只清指针、不动状态，
    // 重放才会与期间表一致。把"未重开"这件事写进日志，比写进注释更靠得住。
    logPeriodChange(db, {
      period: dec,
      action: 'annual_reverse',
      scopeKey: y,
      voucherDocNo: removed?.doc_no ?? null,
      amount: removed?.total_debit ?? null,
      reason: String(reason).trim(),
      actor,
      detail: { reopened_year: false }
    })
  })
  exec()
  return { year: y, replayed: false, removed, reason: String(reason).trim(), operator: actor?.name ?? null }
}

// ---------------------------------------------------------------------------
// 五、利润分配（决议 → 凭证）
// ---------------------------------------------------------------------------
/**
 * 分配的可分配上限 = 年末 4104 的**贷方余额**（未分配利润）。
 * 4104 的借方余额（累计亏损）意味着**没有可分配的利润** —— 返回 0，而不是负数。
 */
export function distributableAmount(db, { year }) {
  const y = assertYear(year)
  const code = retainedSubjectCode(db)
  const balances = R.subjectBalances(db, { period: decemberPeriod(y) })
  const row = balances.rows.find((r) => r.code === code)
  const signed = money2(row?.closing_signed ?? 0)
  return {
    subject_code: code,
    subject_name: row?.name ?? null,
    signed,
    /** 人读口径：正数 = 可分配 */
    available: money2(Math.max(0, -signed)),
    /** 有累计亏损时为真 —— 界面必须显示"无可分配利润"，而不是显示 0 元可供分配 */
    deficit: signed > 0.005
  }
}

/**
 * 分配可选的目标科目（**界面提示用**，不是配置表）：权益类 + 负债类的叶子科目，
 * 但**排除**年结的来源（4103）与未分配利润自己（4104）——
 * 它们会被校验拒掉，摆在清单里只会让人选一次错一次。
 * 校验只认"叶子 + 权益或负债 + 不是这两个"，**不认这里列出的清单** ——
 * 清单短一个科目不该让人没法分配，但类别规则必须硬（那才是会让报表错两块的地方）。
 */
export function distributionSubjects(db) {
  return db
    .prepare(`
      SELECT id, code, name, category, direction FROM accounting_subjects
       WHERE category IN ('equity','liability') AND status='active' AND is_leaf=1
         AND code <> ? AND code <> ?
       ORDER BY code
    `)
    .all(annualProfitSubjectCode(db), retainedSubjectCode(db))
}

/** 分配的状态（只读，界面与"能不能撤销"共用一份回答） */
export function distributionStatus(db, { year }) {
  const y = assertYear(year)
  const dec = decemberPeriod(y)
  const row = getPeriod(db, dec)
  const avail = distributableAmount(db, { year: y })
  const carried = !!row?.annual_voucher_id
  const voucher = row?.dist_voucher_id ? db.prepare('SELECT * FROM vouchers WHERE id=?').get(row.dist_voucher_id) : null
  const entries = row?.dist_voucher_id
    ? db
        .prepare(`
          SELECT e.seq, e.summary, e.direction, e.amount, s.code AS subject_code, s.name AS subject_name
            FROM voucher_entries e JOIN accounting_subjects s ON s.id = e.subject_id
           WHERE e.voucher_id=? ORDER BY e.seq
        `)
        .all(row.dist_voucher_id)
    : []
  return {
    year: y,
    carried,
    annual_voucher_id: row?.annual_voucher_id ?? null,
    distributed: !!row?.dist_voucher_id,
    dist_voucher_id: row?.dist_voucher_id ?? null,
    dist_by_name: row?.dist_by_name ?? null,
    dist_at: row?.dist_at ?? null,
    dist_reverse_reason: row?.dist_reverse_reason ?? null,
    voucher: voucher ? { id: voucher.id, doc_no: voucher.doc_no, voucher_date: voucher.voucher_date, total_debit: voucher.total_debit, memo: voucher.memo } : null,
    entries,
    distributable: avail,
    // 分配可选的科目清单（界面提示用；校验只认"叶子 + 权益或负债 + 不是 4103/4104"）
    subjects: distributionSubjects(db),
    // **能不能分配**的唯一回答（界面不再自己拼判断）
    can_distribute: carried && !row?.dist_voucher_id && avail.available > 0.005,
    blocked_reason: !carried
      ? '本年度还没有做年度结转 —— 不年结就分不清"分的是哪一年的利润"'
      : (row?.dist_voucher_id ? '本年度已做过利润分配（一年一次）' : (avail.deficit ? `年末 ${avail.subject_code} 是借方余额（累计亏损），没有可分配的利润` : null))
  }
}

/**
 * 利润分配：把 4104 的一部分转到决议指定的科目（4105 盈余公积 / 2232 应付股利…）。
 *
 * `items` = `[{ subject_code, amount, label }]` —— **金额必须由人给**（见文件头第五节）。
 * 一次调用生成**一张**凭证：借 4104（总额）/ 贷 各目标科目。
 * 因此"一年一次分配"由数据形状保证（一期一凭证），要多分几项就写在一张凭证里。
 *
 * ⚠️ **分配凭证默认落在「次年 1 月」，不是年末期间**（`period` 可显式指定）。
 * 这不是随手的选择，两条理由：
 *   ① **会计实务**：分红与提取盈余公积的决议通常在**次年**由股东会作出，
 *      凭证也就做在次年的账上；"这个分配属于哪一年"由期间记录（`annual_voucher_id`
 *      所在的年末期）表达，**不由凭证日期表达**；
 *   ② **年结已经封了整年**（12 月是 `closed`），而分配也是要过账的凭证 ——
 *      落在 12 月会直接撞上"已关账期间不能过账"，而绕过它只能靠"自动反关账"，
 *      那等于让一个动作悄悄推翻另一个动作的结论。
 */
export function distributeProfit(db, { year, period = null, items = [], actor = null, remark = null }) {
  const y = assertYear(year)
  // 与年结同一条闸门（分配是年结的下游，年结不做，分配的期间推算也没有落点）
  R.assertNaturalFiscalYear(db)
  const dec = decemberPeriod(y)
  const row = getPeriod(db, dec)
  if (!row || !row.annual_voucher_id) {
    throw new AnnualError(
      'DISTRIBUTION_REQUIRES_ANNUAL',
      `${y} 年还没有做年度结转，不能做利润分配 —— 不做年结就无法回答"分的是哪一年的利润"`,
      409,
      { year: y }
    )
  }
  // 记账期间：默认次年 1 月；允许显式指定，但**不得早于年末期间**
  // （分配不能发生在它所分配的利润被算出来之前）。
  const targetPeriod = period ? assertPeriod(period) : shiftPeriod(dec, 1)
  if (targetPeriod < dec) {
    throw new AnnualError(
      'DIST_PERIOD_BEFORE_YEAR_END',
      `分配凭证的记账期间 ${targetPeriod} 早于 ${dec} —— 分配不能发生在它所分配的利润被算出来之前`,
      400,
      { year: y, period: targetPeriod, december_period: dec }
    )
  }
  const tp = getPeriod(db, targetPeriod)
  if (tp?.status === 'closed') {
    throw new AnnualError(
      'DIST_PERIOD_CLOSED',
      `记账期间 ${targetPeriod} 已关账，分配凭证无法过账；请改指一个未关账的期间（默认落在次年 1 月）`,
      409,
      { year: y, period: targetPeriod }
    )
  }
  const exist = db
    .prepare('SELECT * FROM vouchers WHERE biz_type=? AND source_type=? AND source_id=?')
    .get(DIST_BIZ_TYPE, ANNUAL_SOURCE_TYPE, row.id)
  if (exist && exist.status === 'posted') {
    return {
      year: y,
      replayed: true,
      reason: row.dist_voucher_id ? '本年度已做过利润分配（一年一次）' : '本年度已做过利润分配（期间指针缺失，已按凭证表为准）',
      voucher: A.getVoucher(db, exist.id),
      status: distributionStatus(db, { year: y })
    }
  }
  if (exist) {
    throw new AnnualError(
      'DIST_VOUCHER_NOT_POSTED',
      `${y} 年的利润分配凭证 ${exist.doc_no} 当前状态为「${exist.status}」，不能当作已分配；请先撤销分配记录后重试`,
      409,
      { year: y, voucher_id: exist.id, doc_no: exist.doc_no, voucher_status: exist.status }
    )
  }
  if (row.dist_voucher_id) {
    throw new AnnualError(
      'DIST_VOUCHER_MISSING',
      `${y} 年记录的分配凭证 #${row.dist_voucher_id} 不存在；请先撤销分配记录再重试`,
      409,
      { year: y, dist_voucher_id: row.dist_voucher_id }
    )
  }

  const retained = retainedSubject(db)
  const forProfitCode = annualProfitSubjectCode(db)
  const clean = []
  for (const [i, it] of (items || []).entries()) {
    const code = String(it?.subject_code ?? '').trim()
    const amount = money2(it?.amount)
    if (!code) throw new AnnualError('DIST_ITEM_NO_SUBJECT', `第 ${i + 1} 个分配项没有指定目标科目`, 400, { index: i })
    if (!(amount > 0)) {
      throw new AnnualError('DIST_ITEM_BAD_AMOUNT', `第 ${i + 1} 个分配项的金额必须是正数（收到 ${it?.amount}）`, 400, { index: i, amount: it?.amount })
    }
    if (code === retained.code) {
      throw new AnnualError('DIST_ITEM_SAME_SUBJECT', `第 ${i + 1} 个分配项的目标科目就是未分配利润 ${code} 自己 —— 那等于没分配，而账上还多了一张凭证`, 400, { index: i })
    }
    if (code === forProfitCode) {
      throw new AnnualError(
        'DIST_ITEM_IS_ANNUAL_SOURCE',
        `第 ${i + 1} 个分配项指向了 ${code}（本年利润）—— 那是年结的来源科目，分配记到它头上会破坏"年结后 4103 归零"这条恒等式`,
        400,
        { index: i }
      )
    }
    const s = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
    if (!s) throw new AnnualError('DIST_ITEM_SUBJECT_NOT_FOUND', `第 ${i + 1} 个分配项的目标科目 ${code} 不存在`, 400, { index: i })
    if (s.status !== 'active') throw new AnnualError('DIST_ITEM_SUBJECT_INACTIVE', `分配目标科目 ${s.code} ${s.name} 已停用`, 409, { index: i })
    if (!s.is_leaf) throw new AnnualError('DIST_ITEM_SUBJECT_NOT_LEAF', `分配目标科目 ${s.code} ${s.name} 不是叶子科目`, 409, { index: i })
    // 目标科目只能是**权益类**或**负债类**：
    //   · 权益（4105 盈余公积 / 增资）= 钱**留在公司**；
    //   · 负债（2232 应付股利）= 钱**欠出去了** —— 宣告分配那一刻公司就欠了股东一笔钱，
    //     所以"应付股利"落在负债侧是会计上正确的处理，**不是例外**。
    // 资产 / 损益类则无意义：它会让报表同时错两块，而资产负债表**仍然是平的**。
    if (s.category !== 'equity' && s.category !== 'liability') {
      throw new AnnualError(
        'DIST_ITEM_SUBJECT_BAD_CATEGORY',
        `分配目标科目 ${s.code} ${s.name} 的类别是「${s.category}」；利润分配只能落到**权益类**（钱留在公司，如盈余公积）或**负债类**（钱欠出去了，如应付股利），落到资产或损益科目上会让报表同时错两块而仍然平`,
        409,
        { index: i }
      )
    }
    clean.push({ subject_code: s.code, subject_name: s.name, amount, label: String(it?.label ?? '').trim() || `利润分配 ${s.code}` })
  }
  if (!clean.length) throw new AnnualError('DIST_ITEMS_REQUIRED', '利润分配至少需要一个分配项（科目 + 金额）', 400, { year: y })

  const total = money2(clean.reduce((s, x) => s + x.amount, 0))
  const avail = distributableAmount(db, { year: y })
  if (avail.deficit) {
    throw new AnnualError(
      'DIST_NO_PROFIT',
      `${y} 年末 ${avail.subject_code} 是借方余额（累计亏损 ${money2(-avail.signed)}），没有可分配的利润`,
      409,
      { year: y, available: avail.available }
    )
  }
  if (total > avail.available + 0.005) {
    throw new AnnualError(
      'DIST_EXCEEDS_AVAILABLE',
      `分配总额 ${total} 超过年末 ${avail.subject_code} 的可分配余额 ${avail.available}（超 ${money2(total - avail.available)}）`,
      409,
      { year: y, total, available: avail.available }
    )
  }

  // 借 4104（总额）/**贷各目标科目**。
  // 贷方各行**用减法兜住末行**：把总额拆成几份时最后一份必须用减法，
  // 否则四舍五入的尾差会让整张凭证差 0.01 —— 而那个差额不会报错（批次 H 立下的口径）。
  const lines = clean.map((x, i) => ({
    seq: i + 1,
    summary: x.label,
    direction: 'credit',
    amount: i === clean.length - 1 ? money2(total - clean.slice(0, -1).reduce((s, y2) => s + y2.amount, 0)) : x.amount,
    subject_code: x.subject_code
  }))
  lines.unshift({
    seq: 0,
    summary: `${y} 年度利润分配`,
    direction: 'debit',
    amount: total,
    subject_code: retained.code
  })
  const withSeq = lines.map((l, i) => ({ ...l, seq: i + 1 }))

  ensurePeriod(db, targetPeriod)
  const exec = db.transaction(() => {
    const v = A.persistVoucher(
      db,
      {
        biz_type: DIST_BIZ_TYPE,
        source_type: ANNUAL_SOURCE_TYPE,
        source_id: row.id,
        // 来源单号写**年末期间**：分配凭证落在次年，但"它属于哪一年"由来源表达
        source_doc_no: dec,
        voucher_date: monthEnd(targetPeriod) || `${targetPeriod}-31`,
        period: targetPeriod,
        lines: withSeq,
        label: `${y} 年度利润分配`
      },
      { actor, memo: remark || `${y} 年度利润分配 ${total}（${clean.map((x) => `${x.subject_code} ${x.amount}`).join('、')}）` }
    )
    A.postVoucher(db, { id: v.id, actor })
    db.prepare(`
      UPDATE accounting_periods
         SET dist_voucher_id=?, dist_by=?, dist_by_name=?, dist_at=datetime('now','localtime'),
             dist_reverse_reason=NULL
       WHERE period=?
    `).run(v.id, actor?.id ?? null, actor?.name ?? null, dec)
    // 指针挂在**年末期间**，凭证落在**次年** —— 日志里两者都记：
    // `period`/`scope_key` 说明"这属于哪一年"，`voucher_doc_no` 指向真实的凭证。
    // 只记其中一个，事后都要靠推理才能把两件事接上。
    logPeriodChange(db, {
      period: dec,
      action: 'profit_distribution',
      scopeKey: y,
      statusBefore: row?.status ?? null,
      voucherId: v.id,
      voucherDocNo: v.doc_no,
      amount: total,
      remark,
      actor,
      detail: { voucher_period: targetPeriod, items: clean }
    })
    return v.id
  })
  const vid = exec()
  return {
    year: y,
    replayed: false,
    voucher: A.getVoucher(db, vid),
    period: targetPeriod,
    total,
    items: clean,
    status: distributionStatus(db, { year: y })
  }
}

/**
 * 撤销利润分配。四道锁与撤销年结同源：
 *   ① 写理由；② 次年不能有已关账期间（分配同样会改变次年期初）；
 *   ③ 只删 `biz_type='profit_distribution'` 的凭证；④ 不自动改期间状态。
 */
export function reverseDistribution(db, { year, actor = null, reason = null }) {
  const y = assertYear(year)
  const dec = decemberPeriod(y)
  const row = getPeriod(db, dec)
  if (!row || !row.dist_voucher_id) {
    return { year: y, replayed: true, reason: '本年度未做利润分配', removed: null }
  }
  if (!String(reason || '').trim()) {
    throw new AnnualError('DIST_REVERSE_REASON_REQUIRED', `撤销 ${y} 的利润分配必须填写理由`, 400, { year: y })
  }
  const nextYear = String(Number(y) + 1)
  const nextClosed = db
    .prepare("SELECT period FROM accounting_periods WHERE status='closed' AND substr(period,1,4)=? ORDER BY period")
    .all(nextYear)
  if (nextClosed.length) {
    throw new AnnualError(
      'NEXT_YEAR_CLOSED',
      `${nextYear} 年已有 ${nextClosed.length} 个期间关账（${nextClosed.slice(0, 3).map((x) => x.period).join('、')}${nextClosed.length > 3 ? ' 等' : ''}）；撤销分配会改变次年的期初余额，而"已关账"承诺了那些报表不再变 —— 请先反关账次年相关期间`,
      409,
      { year: y, next_year: nextYear, closed: nextClosed.map((x) => x.period) }
    )
  }
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(row.dist_voucher_id)
  if (v && v.biz_type !== DIST_BIZ_TYPE) {
    throw new AnnualError(
      'NOT_A_DIST_VOUCHER',
      `${y} 年记录的凭证 ${v.doc_no} 不是利润分配凭证（biz_type=${v.biz_type}），拒绝撤销`,
      409,
      { year: y, voucher_id: v.id, biz_type: v.biz_type }
    )
  }
  const removed = v ? { id: v.id, doc_no: v.doc_no, status: v.status, total_debit: v.total_debit, voucher_date: v.voucher_date, memo: v.memo } : null
  const exec = db.transaction(() => {
    if (v) {
      db.prepare('DELETE FROM voucher_entries WHERE voucher_id=?').run(v.id)
      db.prepare('DELETE FROM vouchers WHERE id=?').run(v.id)
    }
    db.prepare(`
      UPDATE accounting_periods
         SET dist_voucher_id=NULL, dist_by=NULL, dist_by_name=NULL, dist_at=NULL,
             dist_reverse_reason=?
       WHERE period=?
    `).run(String(reason).trim(), dec)
    logPeriodChange(db, {
      period: dec,
      action: 'dist_reverse',
      scopeKey: y,
      voucherDocNo: removed?.doc_no ?? null,
      amount: removed?.total_debit ?? null,
      reason: String(reason).trim(),
      actor
    })
  })
  exec()
  return { year: y, replayed: false, removed, reason: String(reason).trim(), operator: actor?.name ?? null }
}

// ---------------------------------------------------------------------------
// 六、年度概览（界面与自证共用一份回答）
// ---------------------------------------------------------------------------
export function listAnnual(db) {
  const years = db
    .prepare(`
      SELECT DISTINCT substr(period,1,4) AS year FROM (
        SELECT period FROM accounting_periods
        UNION SELECT period FROM vouchers
        UNION SELECT period FROM accounting_opening_balances
      ) WHERE period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' ORDER BY year DESC
    `)
    .all()
    .map((r) => String(r.year))

  return years.map((y) => {
    const pre = annualPrecheck(db, { year: y })
    const row = getPeriod(db, decemberPeriod(y))
    const avail = distributableAmount(db, { year: y })
    const periods = yearPeriods(db, y)
    const closedCount = periods.filter((p) => getPeriod(db, p)?.status === 'closed').length
    const uncarried = yearPeriods(db, y).filter((p) => uncarriedProfitSubjects(db, { period: p }).length > 0)
    return {
      year: y,
      periods: periods.length,
      closed_periods: closedCount,
      uncarried_periods: uncarried,
      carried: !!row?.annual_voucher_id,
      annual_voucher_id: row?.annual_voucher_id ?? null,
      annual_by_name: row?.annual_by_name ?? null,
      annual_at: row?.annual_at ?? null,
      annual_reverse_reason: row?.annual_reverse_reason ?? null,
      distributed: !!row?.dist_voucher_id,
      dist_voucher_id: row?.dist_voucher_id ?? null,
      dist_by_name: row?.dist_by_name ?? null,
      dist_at: row?.dist_at ?? null,
      /** 将要年结的金额（正数 = 盈利） */
      carry_profit: pre.balance.profit,
      /** 可分配余额 */
      distributable: avail.available,
      deficit: avail.deficit,
      can_carry: pre.ok,
      blocked: pre.problems.map((x) => x.code),
      blocked_message: pre.problems[0]?.message ?? null
    }
  })
}

export function meta(db) {
  const retained = retainedSubject(db)
  const forProfit = annualProfitSubjectCode(db)
  return {
    annual_biz_type: ANNUAL_BIZ_TYPE,
    dist_biz_type: DIST_BIZ_TYPE,
    source_type: ANNUAL_SOURCE_TYPE,
    retained_subject: { id: retained.id, code: retained.code, name: retained.name },
    annual_profit_subject: forProfit,
    // 分配可选的目标科目（界面提示用；唯一实现在 `distributionSubjects`）
    distribution_subjects: distributionSubjects(db),
    note:
      '年度结转把「本年利润」（默认 4103）结转到「未分配利润」（默认 4104），'
      + '并把该年度所有期间置为已关账；利润分配是**决议**，金额必须由人输入。'
      + '撤销顺序必须反向：撤分配 → 撤年结 → 反关账 → 改账。'
  }
}

export default {
  assertYear, yearOf, decemberPeriod, yearPeriods,
  retainedSubjectCode, retainedSubject, profitCarryBalance, yearNetProfit,
  annualPrecheck, planAnnual, carryForwardAnnual, reverseAnnual,
  distributableAmount, distributionSubjects, distributionStatus, distributeProfit, reverseDistribution,
  listAnnual, meta, AnnualError,
  ANNUAL_BIZ_TYPE, DIST_BIZ_TYPE, ANNUAL_SOURCE_TYPE
}
