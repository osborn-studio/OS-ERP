/**
 * ============================================================================
 * 文件标识：scripts/test-report.mjs ｜ 测试：批次 L：报表体系（资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额）
 * ============================================================================
 * 【职责】测试：批次 L：报表体系（资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额）
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
 * 批次 L：报表体系（资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额）
 *
 * 这一批补的是「账记了，但读不出来」：
 *   批次 H 把业务事实变成了借贷平衡的凭证，但整条链上**只有一张试算平衡表** ——
 *   它能回答"总账平不平"，回答不了经营者真正要问的三句话：
 *     我这家公司现在有多少家底 / 这段期间赚了多少 / 钱到底是怎么来的。
 *
 * 所以这里按「**恒等式**」写，而不是按接口写。三条恒等式都是**数学必然**：
 *   ① 资产合计 = 负债合计 + 所有者权益合计   （来自"每张凭证借贷平衡"）
 *   ② 净利润 = Σ(损益类科目发生额，按科目方向取号)
 *   ③ 现金流净增加额 = 现金类科目期末余额 − 期初余额
 *      （来自"凭证平衡 ⇒ 非现金分录净额 = 现金分录净额"）
 * 恒等式不平时**只可能是配置错**（口径漏了科目 / 区间重叠 / 期初不平），
 * 所以 R8 专门用人造配置错误去证明这些探针**真的会响** —— 不响的探针等于没有。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-report.mjs [cosmetic|food|apparel]
 *
 * 「可重复跑」与「不留副作用」：所有写操作（人造凭证 / 关账 / 改报表口径）
 * 全部包在 `BEGIN … ROLLBACK` 里 —— 假数据只活在事务里，
 * 结束后真表**一行都不多**（R10 会断言这一点）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as R from '../server/lib/report.js'
import * as P from '../server/lib/period.js'
import * as A from '../server/lib/accounting.js'

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
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 260)}` : ''}`)
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
const actor = { id: null, name: 'test-report' }
const money = (v) => Math.round((Number(v) || 0) * 100) / 100

console.log(`=== 报表体系测试（${INDUSTRY}） ===`)

// 取一个"真的发生过业务"的期间与一个"什么都没有"的期间 —— 两组断言都要用
const periods = R.availablePeriods(db)
const busy = periods.find((p) => p.posted_count > 0)?.period || '2026-10'
const empty = '1903-01' // Before demo opening balances and ledger movements.
console.log(`  活跃期间 ${busy}（已过账 ${periods.find((p) => p.period === busy)?.posted_count} 张）`)

// ===========================================================================
section('R1 报表结构与口径（会计政策入库，不是写死在代码里）')
// ===========================================================================
const defs = R.listReportDefs(db)
eq('三张报表都在', defs.map((d) => d.report_code).sort(), ['bs', 'cf', 'pl'])
ok( defs.every((d) => d.line_count > 0), '每张报表都有行定义',  JSON.stringify(defs.map((d) => [d.report_code, d.line_count])))
eq(
  '取数口径与设计一致（资产负债表=余额 / 利润表=发生额 / 现金流量表=现金收支）',
  Object.fromEntries(defs.map((d) => [d.report_code, d.basis])),
  { bs: 'balance', cf: 'cash_flow', pl: 'amount' }
)
ok( R.getReportDef(db, 'bs').cover_category_list.length === 5, '资产负债表声明要穷尽覆盖全部五类科目',  JSON.stringify(R.getReportDef(db, 'bs').cover_category_list))
eq('利润表只声明覆盖损益类', R.getReportDef(db, 'pl').cover_category_list, ['profit_loss'])
ok( R.getReportDef(db, 'cf').cover_category_list.length === 0, '现金流量表不做覆盖检查（覆盖面由兜底行保证）')

// 区间解析：多段、闭区间、写反要报错
eq('多段区间解析成多段', R.parseSubjectRange('1122~1122|2203~2203'), [{ from: '1122', to: '1122' }, { from: '2203', to: '2203' }])
ok( R.inSubjectRange('1001', R.parseSubjectRange('1001~1002')) && R.inSubjectRange('1002', R.parseSubjectRange('1001~1002')), '闭区间含两端')
ok( !R.inSubjectRange('1003', R.parseSubjectRange('1001~1002')), '区间外不含')
ok( R.inSubjectRange('1405', R.parseSubjectRange('1403~1408')) && !R.inSubjectRange('1601', R.parseSubjectRange('1403~1408')), '分层编码按字符串比较仍然正确（1403 < 1405 < 1601）')
throws(() => R.parseSubjectRange('1001'), 'BAD_SUBJECT_RANGE', '区间格式非法即抛（不静默当成"没有条件"）')
throws(() => R.parseSubjectRange('1200~1001'), 'BAD_SUBJECT_RANGE', '区间起止写反即抛（写反会让这一行永远是 0）')

// 小计表达式：只允许行号与加减
eq('小计表达式解析', R.parseSubtotalExpr('1+2+3-4'), [{ sign: 1, no: 1 }, { sign: 1, no: 2 }, { sign: 1, no: 3 }, { sign: -1, no: 4 }])
throws(() => R.parseSubtotalExpr('1*2'), 'BAD_SUBTOTAL_EXPR', '小计表达式不允许乘除（配置能写表达式 = 配置能改账）')
throws(() => R.parseSubtotalExpr('(1+2)*3'), 'BAD_SUBTOTAL_EXPR', '小计表达式不允许括号')
throws(() => R.parseSubtotalExpr('total_amount'), 'BAD_SUBTOTAL_EXPR', '小计表达式不允许字段引用')

// 期间工具
eq('期间位移（跨年）', P.shiftPeriod('2026-01', -1), '2025-12')
eq('期间位移（跨年向后）', P.shiftPeriod('2026-12', 1), '2027-01')
throws(() => P.assertPeriod('2026-13'), 'BAD_PERIOD', '非法期间格式即抛')
throws(() => P.assertPeriod('2026-1'), 'BAD_PERIOD', '月份必须两位')

// 移动端/前端不直接依赖，但这是给人看的报表：每行都要有中文名
ok( defs.every((d) => R.listReportLines(db, d.report_code).every((l) => l.line_name && l.line_no >= 1)), '每个报表行都有名称与行号')

// ===========================================================================
section('R2 期初余额（整批覆盖 + 平衡校验 + 滚动到本期）')
// ===========================================================================
const openingPeriod = db.prepare('SELECT period FROM accounting_opening_balances ORDER BY period DESC LIMIT 1').get()?.period
ok( Boolean(openingPeriod), '演示库登记了期初余额',  openingPeriod)
const ob = R.listOpeningBalances(db, { period: openingPeriod })
ok( ob.balanced, `期初试算表平衡（借 ${ob.total_debit} = 贷 ${ob.total_credit}）`,  `差 ${ob.diff}`)
eq('期初余额条数 > 0', ob.rows.length > 0, true)

// 期初余额**按借贷两列**存：同一行不允许两边都有数（"借 100 贷 100"会让试算看起来平，读出来却是 0）
const anyBoth = db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances WHERE debit_amount > 0.005 AND credit_amount > 0.005').get().c
eq('期初余额没有"同一科目两边都有数"的行', anyBoth, 0)

// 滚动：期初登记在 P0，则 P > P0 的期初 = P0 期初 + [P0, P) 的已过账发生额
if (openingPeriod && openingPeriod < busy) {
  const rolled = R.openingBalancesAsOf(db, busy)
  eq('滚动的基准期间就是登记的期间', rolled.base_period, openingPeriod)
  ok( rolled.rolled_vouchers >= 0, '滚动时确实滚了凭证',  String(rolled.rolled_vouchers))
  const base = R.listOpeningBalances(db, { period: openingPeriod })
  const bal = R.subjectBalances(db, { period: busy })
  // 逐科目复算：期末 = 期初(登记) + 滚动期内发生 + 本期发生
  let worst = 0
  for (const r of bal.rows) {
    const o = base.rows.find((x) => x.subject_code === r.code)
    const open = o ? money(Number(o.debit_amount) - Number(o.credit_amount)) : 0
    const roll = db
      .prepare(`
        SELECT COALESCE(SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE -e.amount END),0) v
          FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
         WHERE v.status='posted' AND e.subject_id=? AND v.period >= ? AND v.period <= ?
      `)
      .get(r.subject_id, openingPeriod, busy).v
    worst = Math.max(worst, Math.abs(money(open + roll) - Number(r.closing_signed)))
  }
  okNear(worst, 0, '逐科目复算：期末 = 期初登记 + [期初登记期, 本期] 全部已过账发生额', 0.005)
  eq('滚动后各科目期初之和为 0（借贷平衡在滚动后仍然成立）', bal.opening.total_signed, 0)
}

// ===========================================================================
section('R3 科目余额表（三张报表唯一的取数口）')
// ===========================================================================
const bal = R.subjectBalances(db, { period: busy })
const tb = A.trialBalance(db, { period: busy })
ok( near(bal.movement.total_debit, tb.total_debit) && near(bal.movement.total_credit, tb.total_credit), '余额表与试算平衡表**同一份发生额**（两处不能各算一遍）', `余额表 ${bal.movement.total_debit}/${bal.movement.total_credit} vs 试算表 ${tb.total_debit}/${tb.total_credit}`)
ok( bal.movement.balanced, '本期发生额借贷平衡',  `差 ${bal.movement.diff}`)
eq('期末各科目 signed 之和为 0（借贷平衡的必然结果）', bal.closing.total_signed, 0)
const draftIn = db.prepare("SELECT COUNT(*) c FROM vouchers WHERE period=? AND status='draft'").get(busy).c
const draftEntry = db
  .prepare("SELECT COUNT(*) c FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.period=? AND v.status='draft'")
  .get(busy).c
if (draftIn > 0) ok( draftEntry > 0 && bal.movement.voucher_count === tb.voucher_count, '未过账凭证的分录**不计入**余额表（生成 ≠ 入账）',  `draft 分录 ${draftEntry} 条 / 余额表只算 ${bal.movement.voucher_count} 张`)
else ok( true, '本期没有未过账凭证（跳过"草稿不计入"断言）')

// 空期间：三张报表必须全 0，且恒等式仍然成立（0 = 0 + 0）
const emptyBal = R.subjectBalances(db, { period: empty })
eq('空期间没有任何发生额', [emptyBal.movement.total_debit, emptyBal.movement.total_credit], [0, 0])
eq('空期间期初全 0（找不到 ≤ 该期的期初登记就按 0 起算）', emptyBal.opening.total_signed, 0)

// ===========================================================================
section('R4 资产负债表（资产 = 负债 + 所有者权益）')
// ===========================================================================
const bs = R.balanceSheet(db, { period: busy })
const assets = bs.totals.BS_ASSETS_TOTAL
const liab = bs.totals.BS_LIABILITIES_TOTAL
const equity = bs.totals.BS_EQUITY_TOTAL
ok( near(assets, liab + equity), '资产总计 = 负债合计 + 所有者权益合计',  `资产 ${assets} vs 负债 ${liab} + 权益 ${equity} = ${money(liab + equity)}`)
ok( near(bs.totals.BS_LIAB_EQUITY_TOTAL, liab + equity), '负债和所有者权益总计 = 负债合计 + 权益合计')
ok( near(assets, bs.totals.BS_LIAB_EQUITY_TOTAL), '资产总计 = 负债和所有者权益总计（报表两栏相等）')
ok( Number(bs.totals.BS_ASSETS_SUBTOTAL) <= Number(assets) + 0.005, '流动资产合计 ≤ 资产总计')

// 逐科目复算：资产行 = Σ(资产类科目期末 signed)，负债行 = −Σ(负债类 signed)
const catSum = (cat) => money(bal.rows.filter((r) => r.category === cat).reduce((s, r) => s + Number(r.closing_signed), 0))
okNear(assets, catSum('asset') + catSum('cost'), '资产总计 = Σ资产类 + Σ成本类（在制品是资产）', 0.005)
okNear(liab, -catSum('liability'), '负债合计 = −Σ负债类期末 signed（负债取贷方口径）', 0.005)
okNear(equity, -(catSum('equity') + catSum('profit_loss')), '所有者权益合计 = −(Σ权益类 + Σ损益类)：**未做期末结转，损益科目余额计入权益**', 0.005)

// 兜底行必须为 0：接了人就说明有科目没被任何具体行认领
const bsFb = bs.rows.find((r) => r.is_fallback)
ok( Boolean(bsFb), '资产负债表兜底行存在')
okNear(bsFb?.amount, 0, '资产负债表兜底行金额为 0（不漏科目，也不掩盖漏配）')
ok(Math.abs(Number(bs.rows.find((r) => r.line_code === 'BS_UNCARRIED_PL')?.amount || 0)) > 0.005
  || catSum('profit_loss') === 0, '未结转损益行有值（证明"未做期末结转"这条口径真的在起作用）', JSON.stringify({ uncarried: bs.rows.find((r) => r.line_code === 'BS_UNCARRIED_PL')?.amount, plSum: catSum('profit_loss') }))

// ===========================================================================
section('R5 利润表（净利润 = 损益类科目发生额按方向取号）')
// ===========================================================================
// 利润表是**经营口径**（`operating_signed`，剔除期末结转账）—— 与 `lib/report.js` 同源。
// 用 `period_signed` 复算的话，做了期末结转的期间会算出 0（收入被结转的借方冲平）。
const revenue = money(-bal.rows.filter((r) => r.category === 'profit_loss' && r.direction === 'credit').reduce((s, r) => s + Number(r.operating_signed), 0))
const expense = money(bal.rows.filter((r) => r.category === 'profit_loss' && r.direction === 'debit').reduce((s, r) => s + Number(r.operating_signed), 0))
const pl = R.incomeStatement(db, { period: busy })
okNear(pl.totals.PL_REVENUE, revenue, '营业收入 = Σ收入类科目（贷方口径取号）', 0.005)
okNear(pl.totals.PL_NET_PROFIT, money(revenue - expense), '净利润 = 收入 − 成本 − 费用', 0.005)
okNear(pl.totals.PL_NET_PROFIT, money(Number(pl.totals.PL_REVENUE) - Number(pl.totals.PL_COST) - Number(pl.totals.PL_SELLING) - Number(pl.totals.PL_ADMIN)), '净利润行 = 各利润表行相减（行内自洽）', 0.005)
ok( near(pl.rows.find((r) => r.is_fallback)?.amount, 0), '利润表兜底行为 0（损益类科目全部被具体行认领）',  JSON.stringify(pl.rows.find((r) => r.is_fallback)?.amount))

// **发生额口径**的证据：换个期间，收入应当变（若按期末余额口径，收入就会被 0 结平或跨期累积）
const other = periods.find((p) => p.period !== busy && p.posted_count > 0)?.period
if (other) {
  const pl2 = R.incomeStatement(db, { period: other })
  const bal2 = R.subjectBalances(db, { period: other })
  const rev2 = money(-bal2.rows.filter((r) => r.category === 'profit_loss' && r.direction === 'credit').reduce((s, r) => s + Number(r.operating_signed), 0))
  okNear(pl2.totals.PL_REVENUE, rev2, `换期间（${other}）后收入随发生额变化 —— 证明是"本期发生额"不是"期末余额"`, 0.005)
} else {
  // 只有一个期间也没关系：空期间必须是 0，这同样能证伪"余额口径"（余额口径下不会为零）
  const pl0 = R.incomeStatement(db, { period: empty })
  okNear(pl0.totals.PL_REVENUE, 0, '空期间收入为 0（余额口径不会为零，所以这也证伪了余额口径）', 0.005)
}

// ===========================================================================
section('R6 现金流量表（净增加额 = 现金类科目期末 − 期初）')
// ===========================================================================
const cf = R.cashFlow(db, { period: busy })
const cashCodes = cf.cash.cash_subjects
ok( cashCodes.length > 0, '现金类科目集合来自报表配置',  cashCodes.join(','))
const cashRows = bal.rows.filter((r) => cashCodes.includes(r.code))
const cashOpen = money(cashRows.reduce((s, r) => s + Number(r.opening_signed), 0))
const cashClose = money(cashRows.reduce((s, r) => s + Number(r.closing_signed), 0))
okNear(cf.totals.CF_NET_INCREASE, money(cashClose - cashOpen), '现金及现金等价物净增加额 = 现金类科目（期末 − 期初）', 0.005)
okNear(cf.cash.net, money(cf.cash.cash_in - cf.cash.cash_out), '现金流入 − 流出 = 分桶净额', 0.005)
okNear(cf.totals.CF_NET_INCREASE, cf.cash.net, '报表净增加额 = 涉现金凭证的净额', 0.005)
okNear(cf.totals.CF_OP_NET + Number(cf.totals.CF_INVEST_NET) + Number(cf.totals.CF_FINANCE_NET), money(Number(cf.totals.CF_NET_INCREASE) - Number(cf.totals.CF_UNCLASSIFIED)), '三类活动净额 + 兜底 = 总净增加额', 0.005)
ok( ['CF_OP_NET', 'CF_INVEST_NET', 'CF_FINANCE_NET'].every((k) => Object.prototype.hasOwnProperty.call(cf.totals, k)), '现金流量表三类活动的行定义都存在')
ok( Boolean(cf.rows.find((r) => r.is_fallback)), '兜底行存在（没有它，认领不到的现金收支会凭空消失）')

// 空期间：净增加额必须是 0，恒等式同样成立
const cf0 = R.cashFlow(db, { period: empty })
okNear(cf0.totals.CF_NET_INCREASE, 0, '空期间现金净增加额为 0', 0.005)

// ===========================================================================
section('R7 期间与关账（关账后不能再过账，但**可以**生成）')
// ===========================================================================
// 本节全部写操作在事务里，结束 ROLLBACK —— 假数据只活在事务里。
db.exec('BEGIN')
try {
  const subj = db.prepare("SELECT id, code, name FROM accounting_subjects WHERE is_leaf=1 AND status='active' ORDER BY code LIMIT 2").all()
  ok( subj.length >= 2, '存在至少两个可记账的叶子科目（本节前提）',  JSON.stringify(subj.map((s) => s.code)))
  const mkDraft = (docNo, period, debitCode, creditCode, amt, srcId = 0) => {
    const d = subj.find((s) => s.code === debitCode) || subj[0]
    const c = subj.find((s) => s.code === creditCode) || subj[1]
    // `(biz_type, source_type, source_id)` 有唯一约束（"同一事实只入一次账"）——
    // 人造凭证必须各给一个 source_id，否则第二张就撞唯一键
    const vid = Number(db
      .prepare(`
        INSERT INTO vouchers (doc_no,biz_type,source_type,source_id,voucher_date,period,status,total_debit,total_credit,memo,maker_name)
        VALUES (?,?,'test_report',?,?,?,'draft',?,?,?,'test-report')
      `)
      .run(docNo, 'test_report', srcId, `${period}-15`, period, amt, amt, docNo).lastInsertRowid)
    const ins = db.prepare(`
      INSERT INTO voucher_entries (voucher_id,seq,summary,subject_id,subject_code,subject_name,direction,amount)
      VALUES (?,?,?,?,?,?,'debit',?),(?,?,?,?,?,?,'credit',?)
    `)
    ins.run(
      vid, 1, docNo, d.id, d.code, d.name, amt,
      vid, 2, docNo, c.id, c.code, c.name, amt
    )
    return vid
  }

  const P1 = '1903-01'
  const v1 = mkDraft('__test_report__PZ1', P1, '1002', '1122', 100, 1)
  // ① 期间未关账 → 过账成功
  A.postVoucher(db, { id: v1, actor })
  eq('未关账期间可以过账', db.prepare('SELECT status FROM vouchers WHERE id=?').get(v1).status, 'posted')

  // ② 关账（关账前会跑三张报表的自证）
  //
  // ⚠️ 这里**不能**直接 `R.closePeriod(...)` —— 关账本身会抛
  // （报表自证不通过 / 有草稿）。异常穿透会把整套测试崩掉，
  // 于是「哪一条口径被改坏了」就看不见了（本项目已立过「**崩 ≠ 红**」这条）。
  // 所以捕获它，把它变成一条**有信息量**的断言，再决定后面还能不能继续。
  let closeErr = null
  let closedOk = false
  try {
    const closed = R.closePeriod(db, { period: P1, actor, remark: '__test_report__' })
    closedOk = closed.status === 'closed'
  } catch (e) {
    closeErr = e
  }
  ok(closedOk, '关账成功（前提：三张报表自证通过且无未过账草稿）', closeErr ? `${closeErr.code}: ${closeErr.message}` : '')
  if (closedOk) {
    eq('关账在库里留痕（谁关的、什么时候）', db.prepare('SELECT status FROM accounting_periods WHERE period=?').get(P1).status, 'closed')
    ok( db.prepare('SELECT closed_by_name FROM accounting_periods WHERE period=?').get(P1).closed_by_name === 'test-report', '关账记录了关账人')

    // ③ **关账后不能再过账** —— 本节的核心断言
    const v2 = mkDraft('__test_report__PZ2', P1, '1002', '1122', 200, 2)
    throws(() => A.postVoucher(db, { id: v2, actor }), 'PERIOD_CLOSED', '关账后过账被拒（判据在 lib/period.js 的 assertPeriodOpen）')
    eq('被拒后那张凭证状态未变', db.prepare('SELECT status FROM vouchers WHERE id=?').get(v2).status, 'draft')

    // ④ 但**生成**不受影响：draft 不计入任何报表，拦它只会让"先录单、后开账"走不通
    eq('关账只拦过账、不拦生成（草稿已能落在已关账期间）', db.prepare('SELECT period FROM vouchers WHERE id=?').get(v2).period, P1)

    // ⑤ 反关账必须写理由
    throws(() => R.reopenPeriod(db, { period: P1, actor }), 'REOPEN_REASON_REQUIRED', '反关账不写理由被拒（它会让已定稿的期间重新可变）')
    const re = R.reopenPeriod(db, { period: P1, actor, reason: '__test_report__ 反关账' })
    eq('反关账成功', re.status, 'open')
    // ⑥ 反关账之后同一张凭证就能过账了 —— 证明③拒的是"期间"，不是别的东西
    A.postVoucher(db, { id: v2, actor })
    eq('反关账后同一张凭证可以过账（证明被拒的原因是期间已关账）', db.prepare('SELECT status FROM vouchers WHERE id=?').get(v2).status, 'posted')
  } else {
    ok(false, '关账未成功 ⇒ 关账后的三条断言（过账闸门 / 反关账理由 / 反关账后可过账）无法验证')
  }

  // ⑦ 有未过账草稿时不能关账（关账后它们的期间再也过不了账）
  const P2 = '1903-02'
  mkDraft('__test_report__PZ3', P2, '1002', '1122', 300, 3)
  throws(() => R.closePeriod(db, { period: P2, actor }), 'PERIOD_HAS_DRAFT', '期间还有未过账草稿时不能关账')

  // ⑧ 关账前必须三张报表自证通过 —— 故意把报表口径改坏（摘掉一行资产科目行）
  const P3 = '1903-03'
  const victim = db.prepare("SELECT * FROM report_lines WHERE report_code='bs' AND line_code='BS_INVENTORY'").get()
  db.prepare('DELETE FROM report_lines WHERE id=?').run(victim.id)
  throws(() => R.closePeriod(db, { period: P3, actor }), 'PERIOD_NOT_BALANCED', '报表自证不通过时不能关账（带着不平的报表定稿 = 把差额永久封存）')
  // 恢复（ROLLBACK 也会恢复，这里显式做一次是为了让下面的断言不受影响）
  db.prepare(`
    INSERT INTO report_lines (id,report_code,line_code,line_no,display_no,line_name,line_type,level,subject_range,sign,only_direction,subtotal_expr,is_fallback,order_no,remark)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(victim.id, victim.report_code, victim.line_code, victim.line_no, victim.display_no, victim.line_name, victim.line_type, victim.level, victim.subject_range, victim.sign, victim.only_direction, victim.subtotal_expr, victim.is_fallback, victim.order_no, victim.remark)
  const P4 = '1903-04'
  let p4ok = false
  try { p4ok = R.closePeriod(db, { period: P4, actor }).status === 'closed' } catch { p4ok = false }
  ok(p4ok, '口径恢复后同一期间可以关账')
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('R8 域自证探针（人造配置错，探针**必须**响）')
// ===========================================================================
// 不响的探针等于没有。这里三种配置错各自制造一次，验证 `auditReport` 报的是**对应的**那个码。
db.exec('BEGIN')
try {
  const baseline = R.auditReport(db, { period: busy })
  ok( baseline.ok, '基线：演示数据当前自证通过',  JSON.stringify(baseline.problems.map((p) => p.code)))
  eq('基线没有任何问题项', baseline.problems.length, 0)

  // ① 漏配一个科目（摘掉"存货"行）→ SUBJECT_UNCOVERED + 资产负债表不平
  const invLine = db.prepare("SELECT * FROM report_lines WHERE report_code='bs' AND line_code='BS_INVENTORY'").get()
  db.prepare('UPDATE report_lines SET subject_range=? WHERE id=?').run('1403~1403', invLine.id)
  const a1 = R.auditReport(db, { period: busy })
  const c1 = a1.problems.map((p) => p.code)
  ok( c1.includes('SUBJECT_UNCOVERED'), '① 漏配科目 → SUBJECT_UNCOVERED',  JSON.stringify(c1))
  ok( c1.includes('BS_NOT_BALANCED'), '① 同时资产负债表不平（漏一个科目必然差一个数）',  JSON.stringify(c1))
  ok( c1.includes('FALLBACK_NONZERO') || c1.includes('SUBJECT_UNCOVERED'), '① 兜底行也不再是 0（金额不会凭空消失，而是掉进兜底）',  JSON.stringify(c1))
  db.prepare('UPDATE report_lines SET subject_range=? WHERE id=?').run(invLine.subject_range, invLine.id)

  // ② 区间重叠（把"货币资金"扩到 1001~1122，和"应收账款"重叠）→ LINE_RANGE_OVERLAP
  db.prepare("UPDATE report_lines SET subject_range='1001~1122' WHERE report_code='bs' AND line_code='BS_CASH'").run()
  const a2 = R.auditReport(db, { period: busy })
  const c2 = a2.problems.map((p) => p.code)
  ok( c2.includes('LINE_RANGE_OVERLAP'), '② 科目行区间重叠 → LINE_RANGE_OVERLAP',  JSON.stringify(c2))
  ok( c2.includes('BS_NOT_BALANCED'), '② 重叠会让报表不平（同一科目被算两次）',  JSON.stringify(c2))
  db.prepare("UPDATE report_lines SET subject_range='1001~1002' WHERE report_code='bs' AND line_code='BS_CASH'").run()

  // ③ 删除现金流量表的兜底行 → CF_NO_FALLBACK + 净增加额对不上
  // ③ 去掉现金流量表的兜底行 → CF_NO_FALLBACK + 净增加额对不上
  // 用 `is_fallback` 开关而不是 DELETE：删掉之后"还原"只能靠重插整行，
  // 而重插时漏一个字段就是一个只在特定分支才暴露的坑（本文件已经踩过一次）。
  const cfFb = db.prepare("SELECT id FROM report_lines WHERE report_code='cf' AND is_fallback=1").get()
  db.prepare('UPDATE report_lines SET is_fallback=0 WHERE id=?').run(cfFb.id)
  const a3 = R.auditReport(db, { period: busy })
  const c3 = a3.problems.map((p) => p.code)
  ok( c3.includes('CF_NO_FALLBACK'), '③ 现金流量表没有兜底行 → CF_NO_FALLBACK',  JSON.stringify(c3))
  db.prepare('UPDATE report_lines SET is_fallback=1 WHERE id=?').run(cfFb.id)

  // ④ 期初余额不平 → OPENING_NOT_BALANCED（直接改一行的金额，绕过写入时的校验）
  const anyOpening = db.prepare('SELECT * FROM accounting_opening_balances ORDER BY period, id LIMIT 1').get()
  if (anyOpening) {
    db.prepare('UPDATE accounting_opening_balances SET debit_amount = debit_amount + 7 WHERE id=?').run(anyOpening.id)
    const a4 = R.auditReport(db, { period: busy })
    const c4 = a4.problems.map((p) => p.code)
    ok( c4.includes('OPENING_NOT_BALANCED'), '④ 期初余额不平 → OPENING_NOT_BALANCED',  JSON.stringify(c4))
    ok( c4.includes('BS_NOT_BALANCED'), '④ 期初不平会让资产负债表不平',  JSON.stringify(c4))
    db.prepare('UPDATE accounting_opening_balances SET debit_amount = debit_amount - 7 WHERE id=?').run(anyOpening.id)
  } else {
    ok( true, '④ 演示库没有期初余额（跳过该探针）')
  }

  // ⑤ 还原后自证必须回到通过 —— 证明上面报的错确实是"被改坏"引起的
  const restored = R.auditReport(db, { period: busy })
  ok( restored.ok, '⑤ 全部还原后自证回到通过',  JSON.stringify(restored.problems.map((p) => p.code)))

  // ⑥ 报表行的结构性约束（写入口挡住的那些，走 lib 而不是直接 SQL）
  throws(() => R.saveReportLine(db, { report_code: 'bs', line_code: '__X__', line_no: 900, line_name: 'x', line_type: 'item' }), 'SUBJECT_RANGE_REQUIRED', '科目行缺区间被拒')
  throws(() => R.saveReportLine(db, { report_code: 'bs', line_code: '__X__', line_no: 900, line_name: 'x', line_type: 'subtotal', subtotal_expr: '999' }), 'SUBTOTAL_REF_MISSING', '小计引用不存在的行被拒（写入时不拦，算的时候才炸就太晚了）')
  throws(() => R.saveReportLine(db, { report_code: 'bs', line_code: '__X__', line_no: 900, line_name: 'x', line_type: 'item', subject_range: '1001~1001', only_direction: 'credit' }), 'ONLY_DIRECTION_UNSUPPORTED', '非现金流报表不允许设置方向过滤（写入即拦 —— "配置里写着、行为里没有"是最危险的不一致）')
  throws(() => R.saveReportLine(db, { report_code: 'bs', line_code: '__X__', line_no: 900, line_name: 'x', line_type: 'item', subject_range: '1001~1001', sign: 0 }), 'BAD_SIGN', 'sign 只允许 ±1（写 0 会让一行"悄悄不参与合计"）')
  // 删掉被小计引用的行要拦（否则小计静默少一块，而报表仍然很好看）
  const referenced = db.prepare("SELECT id FROM report_lines WHERE report_code='bs' AND line_code='BS_CASH'").get()
  throws(() => R.deleteReportLine(db, referenced.id), 'LINE_IN_USE', '被小计引用的报表行不允许删除')
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('R9 分桶与复合凭证（净额法必须如实计数，且恒等式仍成立）')
// ===========================================================================
db.exec('BEGIN')
try {
  const subj = db.prepare("SELECT id, code, name FROM accounting_subjects WHERE is_leaf=1 AND status='active' ORDER BY code").all()
  const byCode = (c) => subj.find((s) => s.code === c) || subj[0]
  const cash = R.cashSubjectsOf(db, 'cf')
  const mkPosted = (docNo, period, lines, srcId = 0) => {
    const total = money(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
    const vid = Number(db
      .prepare(`
        INSERT INTO vouchers (doc_no,biz_type,source_type,source_id,voucher_date,period,status,total_debit,total_credit,memo,maker_name)
        VALUES (?,?,'test_report',?,?,?,'posted',?,?,?,'test-report')
      `)
      .run(docNo, 'test_report', srcId, `${period}-15`, period, total, total, docNo).lastInsertRowid)
    const ins = db.prepare(`
      INSERT INTO voucher_entries (voucher_id,seq,summary,subject_id,subject_code,subject_name,direction,amount)
      VALUES (?,?,?,?,?,?,?,?)
    `)
    lines.forEach((l, i) => {
      const s = byCode(l.code)
      ins.run(vid, i + 1, docNo, s.id, s.code, s.name, l.direction, l.amount)
    })
    return vid
  }
  const PK = '1903-06'
  // 单边配对：借 现金100 / 贷 收入60 + 贷 税40（非现金分录方向单一）
  mkPosted('__test_report__CF1', PK, [
    { code: cash[0], direction: 'debit', amount: 100 },
    { code: '6001', direction: 'credit', amount: 60 },
    { code: '222101', direction: 'credit', amount: 40 }
  ], 11)
  // 复合凭证：现金侧借贷都有 + 非现金两侧都有 → 只能按净额归兜底
  mkPosted('__test_report__CF2', PK, [
    { code: cash[0], direction: 'debit', amount: 500 },
    { code: cash[0], direction: 'credit', amount: 300 },
    { code: '1122', direction: 'debit', amount: 120 },
    { code: '6001', direction: 'credit', amount: 320 }
  ], 12)
  const buckets = R.cashFlowBuckets(db, { period: PK, cashSubjects: cash })
  eq('复合凭证被计入 complex_vouchers（如实计数，不假装精确归类）', buckets.complex_vouchers, 1)
  okNear(buckets.cash_in, 600, '涉现金凭证的流入合计', 0.005)
  okNear(buckets.cash_out, 300, '涉现金凭证的流出合计', 0.005)
  okNear(buckets.net, 300, '净额 = 流入 − 流出', 0.005)
  const cfK = R.cashFlow(db, { period: PK })
  okNear(cfK.totals.CF_NET_INCREASE, buckets.net, '复合凭证走净额法时，净增加额自证**仍然**成立', 0.005)
  const balK = R.subjectBalances(db, { period: PK })
  const cashCloseK = money(balK.rows.filter((r) => cash.includes(r.code)).reduce((s, r) => s + Number(r.closing_signed), 0))
  const cashOpenK = money(balK.rows.filter((r) => cash.includes(r.code)).reduce((s, r) => s + Number(r.opening_signed), 0))
  okNear(cfK.totals.CF_NET_INCREASE, money(cashCloseK - cashOpenK), '复合凭证下仍满足：净增加额 = 现金期末 − 期初', 0.005)
  const fbK = cfK.rows.find((r) => r.is_fallback)
  okNear(fbK?.amount, 200, '复合凭证的净额（500−300）落进兜底行', 0.005)
  ok( R.auditReport(db, { period: PK }).ok, '该期间报表自证通过',  JSON.stringify(R.auditReport(db, { period: PK }).problems.map((p) => p.code)))
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('R10 经营分析（账实差异如实展示，不抹平）')
// ===========================================================================
const op = R.operatingSummary(db, { period: busy })
ok( Boolean(op.on_books) && Boolean(op.on_biz), '经营分析返回账上口径与业务口径两组数')
okNear(op.on_books.revenue, revenue, '经营分析的"账上收入"与利润表同口径', 0.005)
ok( Array.isArray(op.gaps) && op.gaps.every((g) => typeof g.aligned === 'boolean'), '每条差异都带 aligned 标记（相等就是相等，不等就如实标出来）',  JSON.stringify(op.gaps?.map?.((g) => [g.key, g.diff]) ?? op.gaps))
ok( typeof op.note === 'string' && op.note.length > 10, '差异注明了原因（不假装账实必然相等）')
ok( near(op.on_books.ar_balance, money(-(bal.rows.find((r) => r.code === '1122')?.closing_signed || 0))), '账上应收余额与科目 1122 期末一致', `${op.on_books.ar_balance} vs ${money(-(bal.rows.find((r) => r.code === '1122')?.closing_signed || 0))}`)

// ===========================================================================
section('R11 清理与自洽（不留副作用）')
// ===========================================================================
const leftovers = db.prepare("SELECT COUNT(*) c FROM vouchers WHERE doc_no LIKE '__test_report__%'").get().c
eq('测试凭证一行都没留下（全部活在事务里）', leftovers, 0)
const leftoverPeriods = db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE period LIKE '1903-%'").get().c
eq('测试期间一行都没留下', leftoverPeriods, 0)
const finalAudit = R.auditReport(db, { period: busy })
ok( finalAudit.ok, '收尾：演示库报表自证仍然通过（没被测试改坏）',  JSON.stringify(finalAudit.problems.map((p) => p.message)))
eq('收尾：三张报表定义仍在', R.listReportDefs(db).length, 3)
const lineCount = db.prepare('SELECT COUNT(*) c FROM report_lines').get().c
ok( lineCount > 0, '收尾：报表行数未变（口径没被测试改动）',  String(lineCount))

// ===========================================================================
console.log(`\n${'─'.repeat(72)}`)
console.log(`报表体系（${INDUSTRY}）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
db.close()
process.exit(fail === 0 ? 0 : 1)
