/**
 * ============================================================================
 * 文件标识：scripts/test-compare.mjs ｜ 测试：批次 N：报表体系纵深之二（跨期比较 / 报表导出 / 试算平衡表逐行展开）
 * ============================================================================
 * 【职责】测试：批次 N：报表体系纵深之二（跨期比较 / 报表导出 / 试算平衡表逐行展开）
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
 * 批次 N：报表体系纵深之二（跨期比较 / 报表导出 / 试算平衡表逐行展开）
 *
 * 这一批补的是「三张报表有了，但只能一期一期看」：
 *   · **跨期比较**：环比（上期）与同比（去年同期）—— "这期利润 12 万"不是结论，
 *     "这期 12 万、上期 30 万"才是；
 *   · **报表导出**：导出即视图（页面上是什么，文件里就是什么）；
 *   · **试算平衡表逐行展开**：从"某科目本期借 8 万"下钻到"这 8 万是哪些凭证来的"。
 *
 * 本批的核心不是"多了一个比较列"，而是**不许让同一件事出现第二个真值**：
 *   ① 比较的两列必须等于"单独打开那一期"（`COMPARE_BASE_MISMATCH` / `COMPARE_CURRENT_MISMATCH`）；
 *   ② 差额必须是两列相减，不许"再算一遍"（`COMPARE_DIFF_MISMATCH`）；
 *   ③ 基期只由模式决定，不由结果自己声称（`COMPARE_BASE_PERIOD_BAD`）；
 *   ④ 导出的每一行必须等于报表的每一行（本文件按 CSV 解析回来逐行比）；
 *   ⑤ 展开的借贷合计必须等于汇总行（同一批凭证、同一个 where）。
 * 前四条由 `auditComparison` 守，第五条由 `trialBalanceDetail` 的 `summary_row` 守 ——
 * 都是**可执行断言**，不是"看起来对"。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-compare.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：所有写操作（改行名 / 挪期初登记 / 改报表口径）都包在
 * `BEGIN … ROLLBACK` 里；结束时真表**一行都不多**（N9 断言这一点）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as R from '../server/lib/report.js'
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
const money = (v) => Math.round((Number(v) || 0) * 100) / 100

/** 写操作统一走事务并回滚：假数据只活在这一段里 */
function inTx(label, fn) {
  db.exec('BEGIN')
  try {
    fn()
  } finally {
    db.exec('ROLLBACK')
  }
}

/** 最小 CSV 解析（**独立于 `csvCell` 的实现**，所以它能验出转义写错） */
function parseCSV(text) {
  const s = String(text).replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1 } else q = false
      } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch === '\r') { /* CRLF：忽略 CR */ }
    else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

console.log(`=== 报表纵深之二测试（跨期比较 / 导出 / 逐行展开）（${INDUSTRY}） ===`)

// 取一个"真的发生过业务"的期间 —— 比较与展开都要有数才看得出问题
const periods = R.availablePeriods(db)
const busy = periods.find((p) => p.posted_count > 0)
if (!busy) {
  console.log('  \x1b[31m✗\x1b[0m 演示库没有任何已过账凭证，无法测试（先跑 reseed）')
  process.exit(1)
}
const P = busy.period
const REPORTS = ['bs', 'pl', 'cf']
const before = {
  vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
  lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
  opening: db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances').get().c
}

// ===========================================================================
// N1 比较模式：基期只由模式决定
// ===========================================================================
section('N1 比较模式与基期推导（基期只由模式决定）')
eq('环比：基期 = 上一个月', R.resolveCompareMode(db, { period: '2026-10', mode: 'previous' }).base_period, '2026-09')
eq('同比：基期 = 去年同月', R.resolveCompareMode(db, { period: '2026-10', mode: 'yoy' }).base_period, '2025-10')
eq('跨年环比：2026-01 的上期是 2025-12（不是 2026-00）', R.resolveCompareMode(db, { period: '2026-01', mode: 'previous' }).base_period, '2025-12')
eq('跨年同比：2026-01 的去年同期是 2025-01', R.resolveCompareMode(db, { period: '2026-01', mode: 'yoy' }).base_period, '2025-01')
eq('不指定模式时不推导基期', R.resolveCompareMode(db, { period: '2026-10', mode: '' }).base_period, null)
throws(() => R.resolveCompareMode(db, { period: '2026-10', mode: 'lastYear' }), 'BAD_COMPARE_MODE', '非法比较模式抛 BAD_COMPARE_MODE（不静默退回环比）')
throws(() => R.resolveCompareMode(db, { period: '2026-13', mode: 'previous' }), 'BAD_PERIOD', '非法期间抛 BAD_PERIOD')

// ===========================================================================
// N2 两列必须等于"单独打开那一期" + 差额 = 两列相减
// ===========================================================================
section('N2 比较列的唯一实现（等于单期报表）与差额口径')
for (const code of REPORTS) {
  const soloCur = R.computeReport(db, { reportCode: code, period: P })
  const soloPrev = R.computeReport(db, { reportCode: code, period: R.shiftPeriod(P, -1) })
  const cmp = R.compareReport(db, { reportCode: code, period: P, mode: 'previous' })
  const curBy = new Map(soloCur.rows.map((r) => [r.line_code, money(r.amount)]))
  const prevBy = new Map(soloPrev.rows.map((r) => [r.line_code, money(r.amount)]))

  eq(`${code} 比较行数与报表行数一致`, cmp.rows.length, soloCur.rows.length)
  const badCur = cmp.rows.filter((r) => !near(r.amount, curBy.get(r.line_code)))
  const badBase = cmp.rows.filter((r) => !near(r.base_amount, prevBy.get(r.line_code)))
  const badDiff = cmp.rows.filter((r) => !near(r.diff, money(r.amount - r.base_amount)))
  ok(badCur.length === 0, `${code} 本期列逐行 = 单独打开本期（不符 ${badCur.length} 行）`, badCur.slice(0, 2).map((x) => `${x.line_name}:${x.amount}≠${curBy.get(x.line_code)}`))
  ok(badBase.length === 0, `${code} 基期列逐行 = 单独打开基期（不符 ${badBase.length} 行）`, badBase.slice(0, 2).map((x) => `${x.line_name}:${x.base_amount}≠${prevBy.get(x.line_code)}`))
  ok(badDiff.length === 0, `${code} 差额 = 本期 − 基期（不符 ${badDiff.length} 行）`)
  ok(cmp.mode === 'previous' && cmp.base_period === R.shiftPeriod(P, -1), `${code} 比较结果标明的基期正确（${cmp.base_period}）`)

  const audit = R.auditComparison(db, { reportCode: code, period: P, mode: 'previous' })
  ok(audit.ok, `${code} 比较自证通过（problems=${JSON.stringify((audit.problems || []).map((x) => x.code))}）`)
}

// ===========================================================================
// N3 变动率口径：分母取绝对值；基期为 0 时留空
// ===========================================================================
section('N3 变动率口径（基期 0 → 留空，不用 ∞ / 不写 0）')
{
  const cmp = R.compareReport(db, { reportCode: 'bs', period: P, mode: 'previous' })
  const zeroRows = cmp.rows.filter((r) => Math.abs(Number(r.base_amount)) <= 0.005)
  ok(zeroRows.length > 0, `本年/本期存在基期为 0 的行（${zeroRows.length} 行）—— 变动率口径才测得到`, zeroRows.length)
  ok(zeroRows.every((r) => r.ratio === null), '基期为 0 的行变动率为 null（不是 0、不是 Infinity）', zeroRows.slice(0, 3).map((x) => `${x.line_name}:${x.ratio}`))
  const nonZero = cmp.rows.filter((r) => Math.abs(Number(r.base_amount)) > 0.005)
  ok(nonZero.every((r) => r.ratio !== null && Number.isFinite(r.ratio)), '基期非 0 的行变动率有值且为有限数')
  // 负数基期的变动率必须是"幅度的相对量"：分母不带符号，否则好转会被读成恶化
  const neg = nonZero.find((r) => Number(r.base_amount) < 0)
  if (neg) {
    const expect = money((money(neg.diff) / Math.abs(Number(neg.base_amount))) * 100)
    okNear(neg.ratio, Number(expect.toFixed(2)), `负数基期（${neg.line_name} ${neg.base_amount}）的变动率按 |基期| 作分母`, 0.05)
  } else {
    ok(true, '本库没有负数基期的行（该项不适用）')
  }
}

// ===========================================================================
// N4 可比性：基期没数据时如实标注（不拒绝比较，也不假装是增长）
// ===========================================================================
section('N4 基期可比性（没数据 ≠ 全是零）')
{
  const comparablePeriods = periods.filter((p) => p.posted_count > 0)
  const hasBase = db.prepare('SELECT 1 x FROM accounting_opening_balances WHERE period <= ? LIMIT 1')
  const anyComparable = comparablePeriods.some((p) => {
    const b = R.shiftPeriod(p.period, -1)
    const posted = db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='posted' AND period=?").get(b).c
    return posted > 0 || !!hasBase.get(b)
  })
  ok(anyComparable, '存在至少一个"基期有数据"的期间（否则本节的另一条分支测不到）')

  // 把期初登记临时挪到很远的将来 → 任何早期期间的基期都"没有可滚动的期初"，
  // 于是可比性判据只剩"基期有没有已过账凭证"这一半
  inTx('opening', () => {
    db.prepare("UPDATE accounting_opening_balances SET period='2099-12'").run()
    const early = periods[periods.length - 1].period
    const cmp = R.compareReport(db, { reportCode: 'pl', period: early, mode: 'previous' })
    eq(`基期（${cmp.base_period}）无凭证、也无可滚动期初 → comparable=false`, cmp.base_meta.comparable, false)
    eq('不可比期间的基期凭证数为 0', cmp.base_meta.posted_vouchers, 0)
    ok(cmp.rows.every((r) => Number(r.base_amount) === 0), '不可比时基期列全为 0（差额等于本期全额，界面必须提示）')
  })
}

// ===========================================================================
// N5 比较自证：注入坏结果，四种探针必须各自响
// ===========================================================================
section('N5 比较自证探针（注入坏结果必须响 —— 不响的探针等于没有）')
{
  const good = R.compareReport(db, { reportCode: 'bs', period: P, mode: 'previous' })
  ok(R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: good }).ok, '自证对"好结果"通过')

  // ① 基期列被篡改
  const badBase = { ...good, rows: good.rows.map((r, i) => (i === 0 ? { ...r, base_amount: money(r.base_amount + 1), diff: money(r.amount - (r.base_amount + 1)) } : r)) }
  const a1 = R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: badBase })
  ok(a1.problems.some((p) => p.code === 'COMPARE_BASE_MISMATCH'), '篡改基期列 → COMPARE_BASE_MISMATCH 响', a1.problems.map((x) => x.code))

  // ② 本期列被篡改
  const badCur = { ...good, rows: good.rows.map((r, i) => (i === 0 ? { ...r, amount: money(r.amount + 1), diff: money(r.amount + 1 - r.base_amount) } : r)) }
  const a2 = R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: badCur })
  ok(a2.problems.some((p) => p.code === 'COMPARE_CURRENT_MISMATCH'), '篡改本期列 → COMPARE_CURRENT_MISMATCH 响', a2.problems.map((x) => x.code))

  // ③ 差额"再算了一遍"（与两列相减差 **1 元**）。
  //    ⚠️ 偏差量必须选得**不会与被测实现的偏差互相抵消**：本批实测用 +0.01 时，
  //    若被测实现恰好写成 −0.01，两者相加抵消，探针反而哑掉、这条断言变成假红
  //    （反例 C 现场抓到）。所以注入量用一个量级明显不同的值。
  const badDiff = { ...good, rows: good.rows.map((r) => ({ ...r, diff: money(Number(r.amount) - Number(r.base_amount) + 1) })) }
  const a3 = R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: badDiff })
  ok(a3.problems.some((p) => p.code === 'COMPARE_DIFF_MISMATCH'), '差额被独立计算 → COMPARE_DIFF_MISMATCH 响', a3.problems.map((x) => x.code))

  // ④ 基期期间算错了（"上期"却是上上期）
  const badPeriod = { ...good, base_period: R.shiftPeriod(P, -2) }
  const a4 = R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: badPeriod })
  ok(a4.problems.some((p) => p.code === 'COMPARE_BASE_PERIOD_BAD'), '基期期间算错 → COMPARE_BASE_PERIOD_BAD 响', a4.problems.map((x) => x.code))

  // ⑤ 变动率与"基期是否为 0"不一致（把 null 写成 0，看起来像"没变化"）
  const zero = good.rows.find((r) => Math.abs(Number(r.base_amount)) <= 0.005)
  if (zero) {
    const badRatio = { ...good, rows: good.rows.map((r) => (r.line_code === zero.line_code ? { ...r, ratio: 0 } : r)) }
    const a5 = R.auditComparison(db, { reportCode: 'bs', period: P, mode: 'previous', result: badRatio })
    ok(a5.problems.some((p) => p.code === 'COMPARE_RATIO_BAD'), '基期为 0 却给出变动率 → COMPARE_RATIO_BAD 响', a5.problems.map((x) => x.code))
  } else {
    ok(true, '（本库没有基期为 0 的行，变动率探针不适用）')
  }
}

// ===========================================================================
// N6 导出：导出即视图（按 CSV 解析回来逐行比）
// ===========================================================================
section('N6 报表导出（CSV）：导出即视图')
for (const code of REPORTS) {
  const rep = R.computeReport(db, { reportCode: code, period: P })
  const out = R.exportReport(db, { reportCode: code, period: P })
  const rows = parseCSV(out.content)
  ok(out.content.startsWith('\uFEFF'), `${code} 导出带 BOM（Excel 才认 UTF-8，否则中文全乱）`)
  // 行数**不写死**：注释行数会随内容变化（本批加了"口径 / 区间 / 生成时间"三行）。
  // 写死的数字一旦失效，通常被"顺手改大一点"糊过去 —— 所以改成结构断言：
  // 数据行 = 表头 + 报表行，其余非空行必须以 `#` 开头（是注释而不是数据）。
  const dataRows = rows.filter((x) => x.length > 1)
  eq(`${code} 导出的数据行数 = 表头 + 报表行数`, dataRows.length, rep.rows.length + 1)
  // 表头**不写死**：列的唯一出处是 `columns`（本批把 CSV 与页面收敛到同一份定义）
  eq(`${code} 表头逐字 = columns 的中文名`, rows[0], out.columns.map((c) => c.label))
  const iNo = out.columns.findIndex((c) => c.key === 'line_no')
  const iName = out.columns.findIndex((c) => c.key === 'line_name')
  const iAmt = out.columns.findIndex((c) => c.key === 'amount')
  let badLine = null
  for (let i = 0; i < rep.rows.length; i += 1) {
    const r = rep.rows[i]
    const c = rows[i + 1]
    if (Number(c[iNo]) !== Number(r.line_no) || c[iName] !== r.line_name || !near(Number(c[iAmt]), money(r.amount))) badLine = `${c.join('|')} ≠ ${r.line_no}/${r.line_name}/${r.amount}`
  }
  ok(badLine === null, `${code} 导出每一行 = 报表每一行（逐行逐列）`, badLine)
  ok(out.filename.startsWith(code) && out.filename.endsWith('.csv'), `${code} ASCII 文件名可用于老浏览器（${out.filename}）`)
  ok(/[\u4e00-\u9fa5]/.test(out.filename_utf8), `${code} 提供中文文件名（filename*，用户看到的是它）`)
}

section('N6b 比较导出的列与转义')
{
  const cmpOut = R.exportReport(db, { reportCode: 'pl', period: P, mode: 'previous' })
  const rows = parseCSV(cmpOut.content)
  eq('比较导出的列数 = 它的 columns 数（不写死 6）', rows[0].length, cmpOut.columns.length)
  const iBase = cmpOut.columns.findIndex((c) => c.key === 'base_amount')
  eq('比较导出表头含基期期间（从 columns 取，不另写一份）', rows[0][iBase], cmpOut.columns[iBase].label)
  ok(rows[0][iBase].includes(R.shiftPeriod(P, -1)), '基期列的中文名里带着基期期间')

  // 行名里塞一个**半角逗号** —— 转义写错的话列数会裂开
  inTx('comma', () => {
    db.prepare("UPDATE report_lines SET line_name='一、营业收入,含逗号' WHERE report_code='pl' AND line_no=1").run()
    const out2 = R.exportReport(db, { reportCode: 'pl', period: P, mode: 'previous' })
    const rows2 = parseCSV(out2.content)
    eq('含逗号的行名被正确转义（列数不变）', rows2[1].length, cmpOut.columns.length)
    eq('含逗号的行名内容完整', rows2[1][1], '一、营业收入,含逗号')
  })

  // 基期不是 0 的行，变动率必须写成数字；是 0 的行必须留空（不能写 "null"）
  const rep = R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous' })
  const rows3 = parseCSV(R.exportReport(db, { reportCode: 'pl', period: P, mode: 'previous' }).content)
  const iRatio = cmpOut.columns.findIndex((c) => c.key === 'ratio')
  const zeroIdx = rep.rows.findIndex((r) => r.ratio === null)
  if (zeroIdx >= 0) eq('变动率为空时导出单元格为空（不写 null / NaN）', rows3[zeroIdx + 1][iRatio], '')
  ok(!/NaN|Infinity|null/.test(R.exportReport(db, { reportCode: 'cf', period: P, mode: 'yoy' }).content), '导出内容里不出现 NaN / Infinity / null 字样')
}

// ===========================================================================
// N7 试算平衡表逐行展开：明细合计 = 汇总行
// ===========================================================================
section('N7 试算平衡表逐行展开（展开的合计必须等于汇总行）')
{
  const tb = A.trialBalance(db, { period: P })
  ok(tb.rows.length > 0, `期间 ${P} 的试算平衡表有科目行（${tb.rows.length} 行）`)
  let checked = 0
  const mismatch = []
  for (const r of tb.rows) {
    const d = A.trialBalanceDetail(db, { period: P, subjectCode: r.code })
    // 三条必须同时成立：借贷两侧一致、余额一致、回带的汇总行就是列表里那一行
    if (!near(d.total_debit, r.debit)) mismatch.push(`${r.code} 明细借方 ${d.total_debit} ≠ 汇总 ${r.debit}`)
    if (!near(d.total_credit, r.credit)) mismatch.push(`${r.code} 明细贷方 ${d.total_credit} ≠ 汇总 ${r.credit}`)
    if (!near(d.balance.net, r.balance)) mismatch.push(`${r.code} 明细余额 ${d.balance.net} ≠ 汇总 ${r.balance}`)
    if (!d.summary_row || !near(d.summary_row.debit, r.debit)) mismatch.push(`${r.code} 未回带汇总行 / 回带的不一致`)
    checked += 1
  }
  ok(mismatch.length === 0, `全部 ${tb.rows.length} 个科目行的"展开 = 汇总"逐项核对通过`, mismatch.slice(0, 3))
  ok(checked === tb.rows.length, `核对覆盖了全部科目行（${checked}/${tb.rows.length}）`)

  // 逐笔余额：最后一笔的累计余额必须等于该科目余额（同一个方向判定）
  const withEntries = tb.rows.find((r) => r.debit > 0 || r.credit > 0)
  const d = A.trialBalanceDetail(db, { period: P, subjectCode: withEntries.code })
  ok(d.rows.length > 0, `科目 ${withEntries.code} 展开了 ${d.rows.length} 笔分录`)
  ok(d.rows.every((e) => e.running_side === 'debit' || e.running_side === 'credit'), '每一笔都带余额方向（借/贷）')
  okNear(d.rows[d.rows.length - 1].running_balance, d.balance.net, '最后一笔的逐笔余额 = 该科目余额（同一口径）')
  eq('展开的借贷两侧与汇总一致', [d.total_debit, d.total_credit], [withEntries.debit, withEntries.credit])

  // 分页与控制：limit 截断必须如实标注
  const big = tb.rows.find((r) => r.debit > 0 || r.credit > 0)
  const one = A.trialBalanceDetail(db, { period: P, subjectCode: big.code, limit: 1 })
  eq('limit=1 时只回 1 笔', one.rows.length, 1)
  eq('limit=1 时 truncated=true', one.truncated, one.total_count > 1)
  ok(one.total_count >= one.rows.length, 'total_count 是真实条数（不是被截断后的条数）')

  throws(() => A.trialBalanceDetail(db, { period: P }), 'DETAIL_SUBJECT_REQUIRED', '不指定科目时拒绝（展开是某一行的下钻，不是"全部分录"）')
  throws(() => A.trialBalanceDetail(db, { period: P, subjectCode: '999999' }), 'DETAIL_SUBJECT_REQUIRED', '科目不存在时报错（而不是回空表）')
}

// ===========================================================================
// N8 探针⑦：本期期初 = 上期期末（逐科目）
// ===========================================================================
section('N8 探针⑦：本期期初 = 上期期末（且它必须真的在跑）')
{
  // 遍历**所有**期间，而不是只看一个：演示库里忙碌期常常是"孤立的"
  // （2026-05/07/10 有凭证，前后月份都是空的），只看一个期间时，
  // "少滚一期"这类偏差会因为那一期恰好没有发生额而**测不出来** —— 探针就成了摆设。
  let checked = 0
  const gaps = []
  for (const pp of periods.map((x) => x.period)) {
    const prev = R.shiftPeriod(pp, -1)
    const hasOwn = !!db.prepare('SELECT 1 x FROM accounting_opening_balances WHERE period=?').get(pp)
    const hasAny = !!db.prepare('SELECT 1 x FROM accounting_opening_balances WHERE period <= ? LIMIT 1').get(prev)
    if (!(hasAny && !hasOwn)) continue // 前提不满足的期间（自身登记过期初）不适用这条恒等式
    const cur = R.subjectBalances(db, { period: pp })
    const base = R.subjectBalances(db, { period: prev })
    const prevClose = new Map(base.rows.map((r) => [r.subject_id, money(r.closing_signed)]))
    for (const r of cur.rows) {
      if (!near(r.opening_signed, prevClose.get(r.subject_id) ?? 0)) {
        gaps.push(`${pp} 的 ${r.code}：期初 ${r.opening_signed} ≠ ${prev} 期末 ${prevClose.get(r.subject_id)}`)
      }
    }
    checked += 1
  }
  ok(checked >= 2, `探针⑦覆盖了 ${checked} 个期间（≥2 才算真的在跑，覆盖 1 个等于没测）`)
  ok(gaps.length === 0, `每一期的期初 = 上一期的期末（逐科目，不符 ${gaps.length} 处）`, gaps.slice(0, 3))

  const au = R.auditReport(db, { period: P })
  ok(!au.problems.some((p) => p.code === 'OPENING_NE_BASE_CLOSE'), '`auditReport` 不含 OPENING_NE_BASE_CLOSE', (au.problems || []).map((x) => x.code))
  ok(au.ok, `期间 ${P} 的报表域自证整体通过`, (au.problems || []).map((x) => x.code))
  // 这一条在"滚动少算一期"的反例里**仍然应当通过** —— 它证明探针⑦独立于三条恒等式：
  // 少滚的那一期借贷本就平衡（Σsigned = 0），所以资产负债表**依然是平的**，
  // 净利润与现金流也各算各的。只有"期初接不上"这一个证据。
  ok(
    !au.problems.some((p) => ['BS_NOT_BALANCED', 'PL_MISMATCH', 'CF_MISMATCH'].includes(p.code)),
    '三条恒等式（资产=负债+权益 / 净利润 / 现金流净增加额）同样通过 —— 探针⑦不是它们的重复'
  )
}

// ===========================================================================
// N9 无副作用：真表一行都不多
// ===========================================================================
section('N9 无副作用（测试不改真表）')
{
  const after = {
    vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
    opening: db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances').get().c
  }
  eq('凭证数不变', after.vouchers, before.vouchers)
  eq('分录数不变', after.entries, before.entries)
  eq('报表行数不变', after.lines, before.lines)
  eq('期初登记数不变', after.opening, before.opening)
  eq('行名没有被改坏（事务已回滚）', db.prepare("SELECT COUNT(*) c FROM report_lines WHERE line_name LIKE '%,含逗号%'").get().c, 0)
  eq('期初登记的期间没被挪走', db.prepare("SELECT COUNT(*) c FROM accounting_opening_balances WHERE period='2099-12'").get().c, 0)
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
