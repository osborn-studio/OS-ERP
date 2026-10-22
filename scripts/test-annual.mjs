/**
 * ============================================================================
 * 文件标识：scripts/test-annual.mjs ｜ 测试：批次 O：年度结转与利润分配（4103 本年利润 → 4104 未分配利润 · 分配决议 · 封整年）
 * ============================================================================
 * 【职责】测试：批次 O：年度结转与利润分配（4103 本年利润 → 4104 未分配利润 · 分配决议 · 封整年）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 批次 O：年度结转与利润分配（4103 本年利润 → 4104 未分配利润 · 分配决议 · 封整年）
 *
 * 这一批补的是「月结做了，年结没做」—— 4103 只进不出，于是
 * "账上到底有多少可分配的利润"答不出来。
 *
 * 本文件按**链路**写，不按接口写。一条完整的年度从零到闭合：
 *
 *     记损益 → 月度结转（6xxx → 4103）→ 年度结转（4103 → 4104）→ 利润分配（4104 → 4105 / 2232）
 *     撤销必须反向：撤分配 → 撤年结 → 反关账 → 改账
 *
 * 最要紧的一条**不是**"年结算得对"，而是「**年结必须在全年都做完月度结转之后**」：
 * 漏掉一个月就做年结，那一个月的损益会永远留在 6xxx 上 —— 一笔**永久错账**，
 * 而它**不会让任何账不平**。所以 A1 专门证明这条前置真的会拦。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-annual.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：自造的是 **2024 年**（演示库的数据在 2026 年，且早于任何期初登记，
 * 所以自造年度的期初天然为 0），全部写操作包在 `BEGIN … ROLLBACK` 里，
 * A16 断言真表**一行都不多**。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as R from '../server/lib/report.js'
import * as A from '../server/lib/accounting.js'
import * as C from '../server/lib/closing.js'
import * as N from '../server/lib/annual.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'

const ROOT = path.resolve(__dirname, '..')
// ---------- 落点自证：这一跑会读写哪个数据目录 ----------
// 库路径一律从 db/index.js 的 `dbPathFor` 取，不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}
const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` / `getDbFor` 会把**未知行业码静默归一成 cosmetic**
// （`server/db/index.js:28-30`），于是一个字母打错（`fodd`）会安静地跑另一个库，
// 拿到的"绿"是假的。调用侧自己把住"错名要响"。
if (process.argv[2] && !INDUSTRIES[process.argv[2]]) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps
const okNear = (a, b, msg, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}

const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-annual' }
const money = (v) => Math.round((Number(v) || 0) * 100) / 100

console.log(`=== 年度结转与利润分配测试（${INDUSTRY}） ===`)

// 演示库的数据在 2026 年；自造年度选 **2024**，它早于任何期初登记 ⇒ 年初余额天然为 0，
// 于是"年结金额"可以手算出来核对（不像在演示年度上做，那里混着历史数据）。
const Y = '2024'
const REV = '2024-11'   // 有收入的月份
const EXP = '2024-12'   // 有费用的月份（年末）
const base = {
  vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
  periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
  subjects: db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c,
  lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c
}

let seq = 90000
/** 造一张已过账的业务凭证（自造数据，用完随事务回滚） */
function makeVoucher({ period, date, lines, label }) {
  seq += 1
  const v = A.persistVoucher(db, {
    biz_type: 'test_annual',
    source_type: 'test_annual',
    source_id: seq,
    source_doc_no: label,
    voucher_date: date,
    period,
    lines,
    label
  }, { actor })
  A.postVoucher(db, { id: v.id, actor })
  return v
}
const balOf = (period, code) => {
  const b = R.subjectBalances(db, { period })
  return money(b.rows.find((r) => r.code === code)?.closing_signed ?? 0)
}
/** 资产/负债/权益三项合计（用来证明"只在权益内部搬动"） */
function totals(period) {
  const bs = R.balanceSheet(db, { period })
  const t = bs.totals
  return {
    assets: money(t.BS_ASSETS_TOTAL),
    liabilities: money(t.BS_LIABILITIES_TOTAL),
    equity: money(t.BS_EQUITY_TOTAL),
    net_profit: money(R.incomeStatement(db, { period }).totals.PL_NET_PROFIT ?? 0)
  }
}

db.exec('BEGIN')
try {
  // =========================================================================
  // A0 前置：基线与自造年度
  // =========================================================================
  section('A0 基线：4104 存在且是权益叶子；分配目标科目规则')
  {
    const ret = N.retainedSubject(db)
    eq('未分配利润科目 = 4104', ret.code, '4104')
    ok(ret.is_leaf === 1 || ret.is_leaf === true, '4104 是叶子科目')
    eq('4104 的类别是权益', ret.category, 'equity')
    const meta = N.meta(db)
    const codes = meta.distribution_subjects.map((x) => x.code)
    ok(codes.includes('4105'), '分配目标清单含 4105 盈余公积（权益）')
    ok(codes.includes('2232'), '分配目标清单含 2232 应付股利（负债 —— 宣告分配那一刻就欠了股东钱）')
    ok(!codes.includes('4103'), '分配目标清单**不含** 4103（年结的来源）')
    ok(!codes.includes('4104'), '分配目标清单**不含** 4104（分配给它等于没分）')
    eq('自造年度开始前没有任何期间', N.yearPeriods(db, Y).length, 0)
    eq('自造年度的 4103 余额为 0（早于任何期初登记）', balOf(`${Y}-12`, '4103'), 0)
  }

  // =========================================================================
  // A1 年结最重要的前置：全年已做月度结转
  // =========================================================================
  section('A1 前置：漏一个月没结转就不许年结（否则是一笔永久错账）')
  {
    makeVoucher({
      period: REV, date: `${REV}-30`,
      lines: [
        { seq: 1, summary: '销售确认收入', direction: 'debit', amount: 11300, subject_code: '1122' },
        { seq: 2, summary: '主营业务收入', direction: 'credit', amount: 10000, subject_code: '6001' },
        { seq: 3, summary: '销项税额', direction: 'credit', amount: 1300, subject_code: '222101' }
      ],
      label: `TEST-${Y}-REV`
    })
    const pre0 = N.annualPrecheck(db, { year: Y })
    ok(!pre0.ok, '还没做月度结转时，年结前置**不通过**')
    ok(pre0.problems.some((p) => p.code === 'YEAR_NOT_CARRIED'), `未月结 → YEAR_NOT_CARRIED 响（${pre0.problems.map((x) => x.code).join(',')}）`)
    ok(
      (pre0.problems.find((p) => p.code === 'YEAR_NOT_CARRIED')?.message ?? '').includes(REV),
      '提示里点名了具体是哪个期间没结转（可执行，不是一句"不能年结"）'
    )
    throws(() => N.carryForwardAnnual(db, { year: Y, actor }), 'ANNUAL_PRECHECK_FAILED', '带着未月结的期间调年结 → 拒绝')

    // 补上 11 月的月度结转：4103 记入 +10000
    C.carryForward(db, { period: REV, actor })
    okNear(balOf(`${Y}-12`, '4103'), -10000, '11 月月结后 4103 的余额 = −10000（贷方 10000）')

    // **真正的危险场景**：一部分月份已经结转过（4103 非 0），而另有月份没结转。
    // 这时 `ANNUAL_NOTHING`（"没有需要结转的内容"）兜不住，能拦下的**只有** `YEAR_NOT_CARRIED` ——
    // 而它拦下的正是"那个月的利润会永久留在 6xxx 上"这件事。
    // 造一个**净额为 0** 的月份（收入 1000 / 费用 1000），于是后续所有金额断言都不受影响。
    makeVoucher({
      period: '2024-10', date: '2024-10-31',
      lines: [
        { seq: 1, summary: '收入', direction: 'debit', amount: 1000, subject_code: '1122' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ],
      label: 'TEST-2024-10-REV'
    })
    makeVoucher({
      period: '2024-10', date: '2024-10-31',
      lines: [
        { seq: 1, summary: '费用', direction: 'debit', amount: 1000, subject_code: '6602' },
        { seq: 2, summary: '费用', direction: 'credit', amount: 1000, subject_code: '1002' }
      ],
      label: 'TEST-2024-10-EXP'
    })
    const preA = N.annualPrecheck(db, { year: Y })
    okNear(preA.balance.profit, 10000, '此时 4103 的余额非 0（10000）⇒ ANNUAL_NOTHING 兜不住')
    ok(preA.problems.some((p) => p.code === 'YEAR_NOT_CARRIED'), '唯一拦截者是 YEAR_NOT_CARRIED')
    ok(!preA.problems.some((p) => p.code === 'ANNUAL_NOTHING'), '余额非 0 ⇒ ANNUAL_NOTHING 不响（证明它不是那条兜底的检查）')
    throws(
      () => N.carryForwardAnnual(db, { year: Y, actor }),
      'ANNUAL_PRECHECK_FAILED',
      '带着未结转的月份调年结 → 拒绝（否则那个月的利润永久留在 6xxx 上）'
    )
    C.carryForward(db, { period: '2024-10', actor })
    okNear(balOf(`${Y}-12`, '4103'), -10000, '2024-10 是净额为 0 的月份，结转后 4103 不变（−10000）')
  }

  // =========================================================================
  // A2 年末月份：费用 + 月度结转
  // =========================================================================
  section('A2 年末月份记账与月结')
  {
    makeVoucher({
      period: EXP, date: `${EXP}-31`,
      lines: [
        { seq: 1, summary: '管理费用', direction: 'debit', amount: 2000, subject_code: '6602' },
        { seq: 2, summary: '银行存款', direction: 'credit', amount: 2000, subject_code: '1002' }
      ],
      label: `TEST-${Y}-EXP`
    })
    C.carryForward(db, { period: EXP, actor })
    okNear(balOf(`${Y}-12`, '4103'), -8000, '全年月结完成后 4103 = −8000（收入 10000 − 费用 2000）')
    eq('11 月的损益科目已归零', balOf(REV, '6001'), 0)
    eq('12 月的损益科目已归零', balOf(EXP, '6602'), 0)
  }

  // =========================================================================
  // A3 前置：草稿 / 12 月已关账 / 目标科目
  // =========================================================================
  section('A3 其余前置检查各自会拦')
  {
    // ① 草稿：造一张 draft（不管它就能拦住年结）
    seq += 1
    const d = A.persistVoucher(db, {
      biz_type: 'test_annual', source_type: 'test_annual', source_id: seq, source_doc_no: 'TEST-DRAFT',
      voucher_date: `${EXP}-31`, period: EXP,
      lines: [
        { seq: 1, summary: '草稿借方', direction: 'debit', amount: 1, subject_code: '1001' },
        { seq: 2, summary: '草稿贷方', direction: 'credit', amount: 1, subject_code: '1002' }
      ],
      label: 'TEST-DRAFT'
    })
    const pre1 = N.annualPrecheck(db, { year: Y })
    ok(pre1.problems.some((p) => p.code === 'YEAR_HAS_DRAFT'), `有未过账草稿 → YEAR_HAS_DRAFT 响（${pre1.problems.map((x) => x.code).join(',')}）`)
    A.voidVoucher(db, { id: d.id, reason: '测试用草稿，作废后继续', actor })
    ok(N.annualPrecheck(db, { year: Y }).ok, '作废草稿后前置通过')

    // ② 12 月已关账 → 年结凭证没法过账。指引要求"先反关账（12 月不需要单独关账）"。
    R.closePeriod(db, { period: EXP, actor, remark: '测试：先关账再试年结' })
    const pre2 = N.annualPrecheck(db, { year: Y })
    ok(pre2.problems.some((p) => p.code === 'DECEMBER_CLOSED'), `12 月已关账 → DECEMBER_CLOSED 响（${pre2.problems.map((x) => x.code).join(',')}）`)
    ok(
      (pre2.problems.find((p) => p.code === 'DECEMBER_CLOSED')?.hint ?? '').includes('年结本身就会把全年置为'),
      '指引说清了正确流程（12 月不需要单独关账）'
    )
    R.reopenPeriod(db, { period: EXP, actor, reason: '测试：为年结让路' })
    ok(N.annualPrecheck(db, { year: Y }).ok, '反关账 12 月后前置重新通过')

    // ③ 目标科目：把它改成一个**损益类**科目，前置必须拦（而不是等到记账才炸）
    const oldRet = db.prepare("SELECT value FROM settings WHERE key='annual_retained_subject'").get().value
    db.prepare("UPDATE settings SET value='6602' WHERE key='annual_retained_subject'").run()
    const pre3 = N.annualPrecheck(db, { year: Y })
    ok(
      pre3.problems.some((p) => p.code === 'RETAINED_SUBJECT_NOT_EQUITY'),
      `目标科目不是权益类 → 前置拦（${pre3.problems.map((x) => x.code).join(',')}）`
    )
    ok(!pre3.ok, '前置不通过（`planAnnual` 与 `listAnnual` 因此不会抛错，而是把问题显示出来）')
    const plan3 = N.planAnnual(db, { year: Y })
    ok(!plan3.precheck.ok && plan3.target.code === '6602', '`planAnnual` 在目标科目不可用时**不抛错**，如实回带问题')
    db.prepare("UPDATE settings SET value=? WHERE key='annual_retained_subject'").run(oldRet)
    ok(N.annualPrecheck(db, { year: Y }).ok, '还原目标科目后前置通过')
  }

  // =========================================================================
  // A4 年结：四条恒等式
  // =========================================================================
  section('A4 年结（4103 → 4104）：四条恒等式')
  {
    const before = totals(EXP)
    const beforePL = R.computeReport(db, { reportCode: 'pl', period: EXP }).totals.PL_NET_PROFIT
    const before4104 = balOf(`${Y}-12`, '4104')

    const out = N.carryForwardAnnual(db, { year: Y, actor, remark: '测试年结' })
    ok(!out.replayed, '年结执行成功（非重放）')
    eq('年结凭证只有 2 行（4103 / 4104）', out.voucher.entries.length, 2)
    eq('年结凭证的业务类型', out.voucher.biz_type, 'annual_carry')
    eq('年结凭证的日期取年末最后一天', out.voucher.voucher_date, `${Y}-12-31`)
    eq('年结凭证落在 12 月', out.voucher.period, EXP)

    // ① 4103 归零
    eq('① 年结后 4103 归零', balOf(`${Y}-12`, '4103'), 0)
    // ② 4104 的增量 = 结转金额
    const after4104 = balOf(`${Y}-12`, '4104')
    okNear(after4104 - before4104, -8000, '② 4104 的增量 = 结转金额（贷方 8000）')
    okNear(out.plan.carry_profit, 8000, '结转金额 = 本年利润 8000')
    // ③ 资产 / 负债 / 权益三项合计完全相同（只在权益内部搬动）
    const after = totals(EXP)
    okNear(after.assets, before.assets, '③ 资产合计不变（只在权益内部搬动）')
    okNear(after.liabilities, before.liabilities, '③ 负债合计不变')
    okNear(after.equity, before.equity, '③ 所有者权益合计不变')
    // ④ 利润表净利润不变（年度结转两端都是 4xxx，本来就不进利润表）
    const afterPL = R.computeReport(db, { reportCode: 'pl', period: EXP }).totals.PL_NET_PROFIT
    okNear(afterPL, beforePL, '④ 年结前后利润表净利润完全相同')
    okNear(after.net_profit, before.net_profit, '④ 年结前后利润表净利润完全相同（同一计算入口）')

    // 封整年
    const openPeriods = db
      .prepare("SELECT period FROM accounting_periods WHERE substr(period,1,4)=? AND status<>'closed'")
      .all(Y)
    eq('年结把该年度全部期间置为「已关账」', openPeriods.length, 0)
    ok(out.closed_periods >= 2, `年结回报了被关闭的期间数（${out.closed_periods}）`)
  }

  // =========================================================================
  // A5 幂等
  // =========================================================================
  section('A5 幂等：重复年结返回首次结果')
  {
    const again = N.carryForwardAnnual(db, { year: Y, actor })
    ok(again.replayed, '重复年结 → replayed')
    eq('重放时回带的是同一张凭证', again.voucher.id, db.prepare("SELECT annual_voucher_id v FROM accounting_periods WHERE period=?").get(`${Y}-12`).v)
    eq('账上只有一张年结凭证', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='annual_carry'").get().c, 1)
  }

  // =========================================================================
  // A6 反关账闸门（年结封账后不许直接打开）
  // =========================================================================
  section('A6 反关账闸门：该年度已年结 → 必须先撤销年度结转')
  {
    throws(
      () => R.reopenPeriod(db, { period: REV, actor, reason: '测试：绕过封账' }),
      'YEAR_ANNUAL_CLOSED',
      '年结后反关账被拦（否则封账形同虚设：补一张 12 月凭证不会报错，只是 4104 再也不对了）'
    )
  }

  // =========================================================================
  // A7 分配：前置与校验
  // =========================================================================
  section('A7 利润分配：前置与五类校验')
  {
    const st = N.distributionStatus(db, { year: Y })
    ok(st.carried, '分配状态显示本年度已年结')
    ok(st.can_distribute, '可分配状态为真')
    okNear(st.distributable.available, 8000, '可分配余额 = 年末 4104 的贷方余额 8000')

    // 目标科目 = 4104（自己）
    throws(
      () => N.distributeProfit(db, { year: Y, items: [{ subject_code: '4104', amount: 100 }], actor }),
      'DIST_ITEM_SAME_SUBJECT',
      '分配到 4104 自己 → 拒（那等于没分，而账上还多了一张凭证）'
    )
    // 目标科目 = 4103（年结的来源）
    throws(
      () => N.distributeProfit(db, { year: Y, items: [{ subject_code: '4103', amount: 100 }], actor }),
      'DIST_ITEM_IS_ANNUAL_SOURCE',
      '分配到 4103 → 拒（那会破坏"年结后 4103 归零"这条恒等式）'
    )
    // 目标科目是资产类
    throws(
      () => N.distributeProfit(db, { year: Y, items: [{ subject_code: '1001', amount: 100 }], actor }),
      'DIST_ITEM_SUBJECT_BAD_CATEGORY',
      '分配到资产类科目 → 拒（报表会同时错两块，而它仍然是平的）'
    )
    // 金额不合法
    throws(
      () => N.distributeProfit(db, { year: Y, items: [{ subject_code: '4105', amount: 0 }], actor }),
      'DIST_ITEM_BAD_AMOUNT',
      '金额为 0 → 拒'
    )
    throws(
      () => N.distributeProfit(db, { year: Y, items: [], actor }),
      'DIST_ITEMS_REQUIRED',
      '空分配项 → 拒'
    )
    // 超过可分配余额
    throws(
      () => N.distributeProfit(db, { year: Y, items: [{ subject_code: '4105', amount: 8001 }], actor }),
      'DIST_EXCEEDS_AVAILABLE',
      '分配总额超过可分配余额 → 拒'
    )
    eq('以上失败尝试都没有留下凭证', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='profit_distribution'").get().c, 0)
  }

  // =========================================================================
  // A8 分配：出账
  // =========================================================================
  section('A8 利润分配（4104 → 4105 / 2232）')
  {
    const before = totals('2025-01')
    const decBefore = balOf(`${Y}-12`, '4104')
    const out = N.distributeProfit(db, {
      year: Y, actor, remark: '测试分配',
      items: [
        { subject_code: '4105', amount: 800, label: '提取法定盈余公积' },
        { subject_code: '2232', amount: 3200, label: '分配股利' }
      ]
    })
    ok(!out.replayed, '分配执行成功')
    okNear(out.total, 4000, '分配总额 4000')
    // **默认落在次年 1 月**：分红与提取盈余公积的决议通常在次年由股东会作出，账也做在次年；
    // 而年末期间已被年结封账（closed），落在那里会直接撞上"已关账不能过账"。
    eq('分配凭证落在**次年 1 月**', [out.voucher.period, out.voucher.voucher_date], ['2025-01', '2025-01-31'])
    eq('来源单号仍是年末期间 —— "这个分配属于哪一年"由它表达，不由凭证日期表达', out.voucher.source_doc_no, `${Y}-12`)
    okNear(balOf(`${Y}-12`, '4104'), decBefore, '年末 4104 不因分配而改变（分配发生在次年）')
    // 一张凭证：1 行借记 4104 + 2 行贷记目标科目
    const dr = out.voucher.entries.filter((e) => e.direction === 'debit')
    const cr = out.voucher.entries.filter((e) => e.direction === 'credit')
    eq('借方只有 1 行（4104）', dr.length, 1)
    eq('借方科目是未分配利润', dr[0].subject_code, '4104')
    eq('贷方 2 行（盈余公积 / 应付股利）', cr.map((e) => e.subject_code).sort(), ['2232', '4105'])
    okNear(dr[0].amount, 4000, '借方金额 = 分配总额')
    okNear(cr.reduce((s, e) => s + e.amount, 0), 4000, '贷方合计 = 借方合计（凭证平衡）')

    okNear(balOf('2025-01', '4104'), -4000, '次年的 4104 减少到 4000（期初 8000 − 分配 4000）')
    okNear(balOf('2025-01', '4105'), -800, '4105 盈余公积增加 800')
    okNear(balOf('2025-01', '2232'), -3200, '2232 应付股利增加 3200（负债，欠股东的钱）')

    const after = totals('2025-01')
    okNear(after.equity, before.equity - 3200, '权益合计减少 3200（分出去的那部分变成了负债）')
    okNear(after.liabilities, before.liabilities + 3200, '负债合计增加 3200')
    okNear(after.assets, before.assets, '资产合计不变（分配本身不动钱，付现是另一笔业务）')

    const st = N.distributionStatus(db, { year: Y })
    ok(st.distributed && !st.can_distribute, '分配后：已分配 → 不可再分配（一年一次）')
    ok((st.blocked_reason ?? '').includes('一年一次'), `不能分配的原因如实回带（${st.blocked_reason}）`)
    const again = N.distributeProfit(db, { year: Y, items: [{ subject_code: '4105', amount: 1 }], actor })
    ok(again.replayed, '重复分配 → replayed（不产生第二张凭证）')
    eq('账上只有一张分配凭证', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='profit_distribution'").get().c, 1)
  }

  // =========================================================================
  // A9 撤销链：顺序错了必须被拦住
  // =========================================================================
  section('A9 撤销必须反向：撤分配 → 撤年结 → 反关账')
  {
    throws(
      () => N.reverseAnnual(db, { year: Y, actor, reason: '测试：先撤年结' }),
      'REVERSE_DISTRIBUTION_FIRST',
      '还有分配时撤年结 → 拒（先撤上游会让下游的金额失去依据）'
    )
    throws(
      () => N.reverseDistribution(db, { year: Y, actor, reason: '' }),
      'DIST_REVERSE_REASON_REQUIRED',
      '撤销分配不写理由 → 拒'
    )

    // 次年有已关账期间时，撤销也要被拦住（撤销会改次年的期初余额）
    R.closePeriod(db, { period: '2025-01', actor, remark: '测试：次年关账' })
    throws(
      () => N.reverseDistribution(db, { year: Y, actor, reason: '测试：次年已关账' }),
      'NEXT_YEAR_CLOSED',
      '次年已关账时撤分配 → 拒（撤销会改变次年已定稿的报表）'
    )
    R.reopenPeriod(db, { period: '2025-01', actor, reason: '测试：让路' })

    const revD = N.reverseDistribution(db, { year: Y, actor, reason: '测试：撤销分配' })
    ok(!revD.replayed && revD.removed, '撤销分配成功（物理删除派生凭证）')
    eq('分配凭证已删除', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='profit_distribution'").get().c, 0)
    okNear(balOf('2025-01', '4104'), -8000, '撤销分配后次年的 4104 恢复到 8000（即期初值）')
    eq('撤销理由写进了期间', N.distributionStatus(db, { year: Y }).dist_reverse_reason, '测试：撤销分配')

    const revA = N.reverseAnnual(db, { year: Y, actor, reason: '测试：撤销年结' })
    ok(!revA.replayed && revA.removed, '撤销年结成功')
    eq('年结凭证已删除', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='annual_carry'").get().c, 0)
    okNear(balOf(`${Y}-12`, '4103'), -8000, '撤销年结后 4103 恢复余额（−8000）')
    okNear(balOf(`${Y}-12`, '4104'), 0, '撤销年结后 4104 回到 0')
    // ⚠️ 撤销年结**不**把全年置回 open（"打开"是一个需要理由的动作）
    const stillClosed = db
      .prepare("SELECT COUNT(*) c FROM accounting_periods WHERE substr(period,1,4)=? AND status='closed'")
      .get(Y).c
    ok(stillClosed >= 2, `撤销年结不自动重开期间（仍有 ${stillClosed} 个期间是已关账）—— "打开"需要理由`)
    ok(!N.annualPrecheck(db, { year: Y }).problems.some((p) => p.code === 'YEAR_NOT_CARRIED'), '撤销后前置重新可通过（账回到"未年结"的干净状态）')
    // 重做年结前**必须先把 12 月打开**：撤销年结不自动重开期间（"打开"是一个要理由的动作），
    // 所以重做的路径必然是「反关账（写理由）→ 年结」—— 这正是"撤销链每一步都留痕"的直接后果。
    throws(
      () => N.carryForwardAnnual(db, { year: Y, actor }),
      'ANNUAL_PRECHECK_FAILED',
      '撤销年结后 12 月仍是已关账 → 不能直接重做（必须先反关账）'
    )
    R.reopenPeriod(db, { period: EXP, actor, reason: '测试：为重做年结打开 12 月' })
    const redo = N.carryForwardAnnual(db, { year: Y, actor, remark: '重做' })
    ok(!redo.replayed, '撤销之后可以重新年结（物理删除的好处：不受唯一约束阻挡）')
    okNear(balOf(`${Y}-12`, '4104'), -8000, '重做年结后 4104 = 8000')
  }

  // =========================================================================
  // A10 探针：四条都要真的会响
  // =========================================================================
  section('A10 探针四条（注入坏数据必须响 —— 不响的探针等于没有）')
  {
    const decId = db.prepare('SELECT id FROM accounting_periods WHERE period=?').get(`${Y}-12`).id
    const clean = R.auditReport(db, { period: EXP })
    ok(
      !clean.problems.some((p) => ['ANNUAL_VOUCHER_ORPHAN', 'ANNUAL_NOT_BALANCED', 'ANNUAL_PERIODS_NOT_CLOSED', 'DISTRIBUTION_WITHOUT_ANNUAL'].includes(p.code)),
      `正常状态下探针⑧全不响（${clean.problems.map((x) => x.code).join(',') || '无'}）`
    )

    // ① 年结后 4103 不为 0。真实成因是"年结后又往那一年补了损益凭证"，
    //    而**封整年本来就该挡住它** —— 先证明这一点（这本身是一条有价值的断言）：
    //    往已年结的年度补记凭证，过账会被「已关账不能过账」拦下。
    seq += 1
    const late = A.persistVoucher(db, {
      biz_type: 'test_annual', source_type: 'test_annual', source_id: seq, source_doc_no: 'TEST-LATE',
      voucher_date: `${EXP}-31`, period: EXP,
      lines: [
        { seq: 1, summary: '补记费用', direction: 'debit', amount: 500, subject_code: '6602' },
        { seq: 2, summary: '银行存款', direction: 'credit', amount: 500, subject_code: '1002' }
      ],
      label: 'TEST-LATE'
    })
    throws(
      () => A.postVoucher(db, { id: late.id, actor }),
      'PERIOD_CLOSED',
      '往已年结的年度补记凭证 → 过账被"已关账不能过账"挡住（封整年的直接后果）'
    )
    A.voidVoucher(db, { id: late.id, reason: '测试：被拦下的补记', actor })

    //    既然补凭证这条路已被封账堵死，探针的注入就换一个**等价但不过账**的方式：
    //    直接把年结凭证里 4103 那一行的金额改小（一个纯粹的"账被改坏"状态）。
    //    代价是 `HEAD_ENTRY_MISMATCH` 会一起响（凭证头与分录合计不再相等）——
    //    这是"两把锁各守一段"的形态，不是重复。
    const annualVid = db.prepare("SELECT id FROM vouchers WHERE biz_type='annual_carry'").get().id
    const s4103 = db.prepare("SELECT id FROM accounting_subjects WHERE code='4103'").get().id
    db.prepare('UPDATE voucher_entries SET amount = amount - 1000 WHERE voucher_id=? AND subject_id=?').run(annualVid, s4103)
    const a1 = R.auditReport(db, { period: EXP })
    ok(a1.problems.some((p) => p.code === 'ANNUAL_NOT_BALANCED'), `年结后 4103 不为 0 → ANNUAL_NOT_BALANCED 响（${a1.problems.map((x) => x.code).join(',')}）`)
    db.prepare('UPDATE voucher_entries SET amount = amount + 1000 WHERE voucher_id=? AND subject_id=?').run(annualVid, s4103)

    // ② 年结后该年度仍有未关账期间（封账没做全）
    db.prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(REV)
    const a2 = R.auditReport(db, { period: EXP })
    ok(a2.problems.some((p) => p.code === 'ANNUAL_PERIODS_NOT_CLOSED'), `已年结却仍有未关账期间 → ANNUAL_PERIODS_NOT_CLOSED 响（${a2.problems.map((x) => x.code).join(',')}）`)
    db.prepare("UPDATE accounting_periods SET status='closed' WHERE period=?").run(REV)

    // ③ 期间说"未年结"，但账上已经结过了（撤了指针没删凭证）；
    //    顺带把分配指针也指回去（A9 已撤销分配），覆盖"有分配无年结"这条探针 ——
    //    分掉的钱必须有"本年利润转入"这个来源。用一个明显是人为坏状态的假 id。
    db.prepare('UPDATE accounting_periods SET annual_voucher_id=NULL WHERE id=?').run(decId)
    db.prepare('UPDATE accounting_periods SET dist_voucher_id=999999 WHERE id=?').run(decId)
    const a3 = R.auditReport(db, { period: EXP })
    ok(a3.problems.some((p) => p.code === 'ANNUAL_VOUCHER_ORPHAN'), `年结凭证成孤儿 → ANNUAL_VOUCHER_ORPHAN 响（${a3.problems.map((x) => x.code).join(',')}）`)
    ok(a3.problems.some((p) => p.code === 'DISTRIBUTION_WITHOUT_ANNUAL'), '同一状态下"有分配无年结"也响（DISTRIBUTION_WITHOUT_ANNUAL）')
    db.prepare('UPDATE accounting_periods SET annual_voucher_id=? WHERE id=?').run(annualVid, decId)
    db.prepare('UPDATE accounting_periods SET dist_voucher_id=NULL WHERE id=?').run(decId)

    const clean2 = R.auditReport(db, { period: EXP })
    ok(!clean2.problems.some((p) => p.code.startsWith('ANNUAL_') || p.code === 'DISTRIBUTION_WITHOUT_ANNUAL'), '逐条还原后探针⑧重新静默')
  }

  // =========================================================================
  // A11 期初滚动：年结之后，新年度从 4104 的余额开始
  // =========================================================================
  section('A11 跨年衔接：次年的期初 = 本年末的期末')
  {
    const dec4104 = balOf(`${Y}-12`, '4104')
    const nextOpen = money(R.subjectBalances(db, { period: '2025-01' }).rows.find((r) => r.code === '4104')?.opening_signed ?? 0)
    okNear(nextOpen, dec4104, '次年期初的 4104 = 年末 4104 的余额（期初滚动，不需要额外汇总动作）')
    const next4103 = money(R.subjectBalances(db, { period: '2025-01' }).rows.find((r) => r.code === '4103')?.opening_signed ?? 0)
    eq('次年期初的 4103 = 0（本年利润每年从零开始 —— 这就是年结存在的意义）', next4103, 0)
  }

  // =========================================================================
  // A12 listAnnual：年度的唯一回答
  // =========================================================================
  section('A12 listAnnual：每个年度的状态与"能不能年结"')
  {
    const rows = N.listAnnual(db)
    const y = rows.find((r) => r.year === Y)
    ok(!!y, `listAnnual 里有 ${Y} 年`)
    ok(y.carried, `${Y} 年显示已年结`)
    ok(!y.can_carry, '已年结 → can_carry 为假（唯一回答，界面不自己拼判断）')
    // 已年结的年度，4103 已经归零 —— 所以"将要结转的金额"现在是 0（它就是当前 4103 的余额）
    okNear(y.carry_profit, 0, '已年结 → 当前 4103 余额为 0（年结把本年利润结平了）')
    okNear(y.distributable, 8000, '显示可分配余额（年末 4104 的贷方余额，不因次年已分配而变）')
    ok(rows.every((r) => typeof r.blocked === 'object'), '每一年都回带了 blocked 代码数组')
  }
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
// A13 无副作用
// ===========================================================================
section('A13 无副作用（测试不改真表）')
{
  const after = {
    vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
    subjects: db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c,
    lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c
  }
  eq('凭证数不变', after.vouchers, base.vouchers)
  eq('分录数不变', after.entries, base.entries)
  eq('期间数不变', after.periods, base.periods)
  eq('科目数不变', after.subjects, base.subjects)
  eq('报表行数不变', after.lines, base.lines)
  eq('没有残留自造年度', db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE substr(period,1,4)='2024'").get().c, 0)
  eq('没有残留测试凭证', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type IN ('test_annual','annual_carry','profit_distribution')").get().c, 0)
  eq('目标科目配置没被改坏', db.prepare("SELECT value v FROM settings WHERE key='annual_retained_subject'").get().v, '4104')
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
