/**
 * ============================================================================
 * 文件标识：scripts/test-multi-year.mjs ｜ 测试：批次 U 之四 · ④：跨年度报表（同期多年对比）
 * ============================================================================
 * 【职责】测试：批次 U 之四 · ④：跨年度报表（同期多年对比）
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
 * 批次 U 之四 · ④：跨年度报表（同期多年对比）
 *
 * 「同期多年对比」= 同一张表并排 N 列，第 k 列 = 本期往前 12k 个月的数（k=0 本期 / 1 去年同月 …）。
 * 两条硬口径：
 *   ① 每一列都必须是**对那一期单独调同一个计算入口**的结果（不另写取数路径）；
 *   ② 期间序列**只由 `shiftPeriod` 推**（12 个月的整数倍），不许手写年份减法。
 * 另外明写**不做**的三件事（本脚本最后也会断言它们确实没被偷偷做掉）：
 *   任意跨年窗口（如"上年 12 月 ~ 本年 3 月"）· 利润分配跨年还原 · 年度报表同比列。
 *
 * 只读跑（`readonly: true`）—— 这一切都是纯计算。
 * 用法：node scripts/test-multi-year.mjs
 * 收尾打印「通过 N / 失败 M」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as R from '../server/lib/report.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor } from '../server/db/index.js'

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
const INDUSTRIES = ['cosmetic', 'food', 'apparel']

let pass = 0
let fail = 0
const failures = []
// 实际跑过的库：**计数行由它派生**，不写死"三库"（只跑一个库却写着三库会误导读计数行的人）。
// 必须在模块作用域（收尾的计数行在循环之外）。
const ran = []
function ok(cond, msg, detail) {
  // 自保（铁律 27 第二次撞车后立的规矩）：参数写反时**当场崩**，而不是「永远绿」。
  // 本文件的形参顺序是 (cond, msg, detail)；搬别的文件的写法过来时这一行会立刻逮住它。
  if (typeof cond !== 'boolean') throw new Error(`ok() 的条件必须是布尔值，收到 ${typeof cond}（参数顺序写反了？）`)
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
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return e
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
  return null
}

console.log(`=== 同期多年对比（跨年度报表）测试（三库：${INDUSTRIES.join(' / ')}） ===`)

for (const ind of INDUSTRIES) {
  const file = dbPathFor(ind)
  if (!fs.existsSync(file)) continue
  ran.push(ind) // 这一库真的开跑了 —— 计数行的库标签由它派生，不写死"三库"
  const db = new Database(file, { readonly: true, fileMustExist: true })
  const P = R.availablePeriods(db).find((x) => x.posted_count > 0)?.period || '2026-10'
  console.log(`\n${'─'.repeat(72)}\n【${ind}】本期 ${P}`)

  // =========================================================================
  section(`M1 期间序列 = 本期往前 12 个月的整数倍（${ind}）`)
  // =========================================================================
  const expect = (n) => {
    const out = []
    for (let k = 0; k < n; k += 1) out.push(R.shiftPeriod(P, -12 * k))
    return out
  }
  for (const n of [2, 3, 4, 5]) {
    eq(`years=${n} 的期间序列（字面算出的期望值）`, R.multiYearReport(db, { reportCode: 'pl', period: P, years: n }).periods, expect(n))
  }
  eq('默认 years=3', R.multiYearReport(db, { reportCode: 'pl', period: P }).periods, expect(3))
  eq('multiYearPeriods 与结果一致（列期间只有一处推导）', R.multiYearPeriods(P, 4).map((x) => x.period), expect(4))

  // =========================================================================
  section(`M2 每一列 == 单独打开那一期（逐行逐期）（${ind}）`)
  // =========================================================================
  const m = R.multiYearReport(db, { reportCode: 'pl', period: P, years: 4 })
  // **防空跑**：演示库的利润表在某几期是全 0（那一期就是没有损益发生额），
  // 拿它做"逐行相等"只能得到"0 == 0"。所以这一节换成**真的有数的那张表与那一期**
  // （现金流量表在演示数据里有真实发生额），并在多个候选期间里挑一个非空的。
  const candidates = R.availablePeriods(db).filter((x) => x.posted_count > 0).map((x) => x.period)
  const activeP = candidates.find((per) => R.computeReport(db, { reportCode: 'cf', period: per }).rows.some((r) => Math.abs(Number(r.amount)) > 0.005)) || P
  const mc = R.multiYearReport(db, { reportCode: 'cf', period: activeP, years: 4 })
  const expectA = []
  for (let k = 0; k < 4; k += 1) expectA.push(R.shiftPeriod(activeP, -12 * k))
  let bad = 0
  let nonZero = 0
  for (let k = 0; k < 4; k += 1) {
    const solo = R.computeReport(db, { reportCode: 'cf', period: expectA[k] })
    const byCode = new Map(solo.rows.map((r) => [r.line_code, r.amount]))
    const key = k === 0 ? 'amount' : `amount_lag${k}`
    for (const r of mc.rows) {
      if (!near(r[key], byCode.get(r.line_code))) bad += 1
    }
  }
  eq('四个年度列逐行等于"单独打开那一期"（现金流量表 · ' + activeP + '）', bad, 0)
  for (const r of mc.rows) for (let k = 0; k < 4; k += 1) if (Math.abs(Number(r[k === 0 ? 'amount' : `amount_lag${k}`])) > 0.005) nonZero += 1
  ok(nonZero > 0, `至少有一个单元格非 0（共 ${nonZero} 个）—— 否则上一条是"0 == 0"的空跑`)

  // =========================================================================
  section(`M3 列定义：列数 = 期数 + 2，标签带期间（${ind}）`)
  // =========================================================================
  eq('列键与顺序', m.columns.map((c) => c.key), ['line_no', 'line_name', 'amount', 'amount_lag1', 'amount_lag2', 'amount_lag3'])
  eq('列标签带期间', m.columns.map((c) => c.label), [
    '行次', '项目', `本期金额(${P})`, `金额(${expect(4)[1]})`, `金额(${expect(4)[2]})`, `金额(${expect(4)[3]})`
  ])
  eq('逐期合计按期间给出', Object.keys(m.totals_by_period), expect(4))
  eq('期间元信息逐期给出（已关账的是定稿数）', m.period_meta.map((x) => x.period), expect(4))
  ok(m.columns.length === m.years + 2 && m.rows.length === m.lines.length, '列数 = years + 2，行数 = 口径行数')

  // =========================================================================
  section(`M4 值域：只接受 2~5 的整数（${ind}）`)
  // =========================================================================
  for (const y of [1, 6, 0, -2, 'x', 2.5]) {
    throws(() => R.multiYearReport(db, { reportCode: 'pl', period: P, years: y }), 'MULTI_YEAR_COUNT', `years=${y} 被拒（MULTI_YEAR_COUNT）`)
  }
  const e = throws(() => R.multiYearReport(db, { reportCode: 'pl', period: P, years: 9 }), 'MULTI_YEAR_COUNT', '越界给封闭错误码')
  ok(!e || (e.http ?? e.status) === 400, '越界是 400（不是 500）')

  // =========================================================================
  section(`M5 自证会响：列被改 / 期间被挪（${ind}）`)
  // =========================================================================
  ok(R.auditMultiYear(db, { reportCode: 'pl', period: P, years: 4 }).ok, '常规自证通过')
  const huaiCol = { ...m, rows: m.rows.map((r, i) => (i === 0 ? { ...r, amount_lag1: Number(r.amount_lag1) + 999 } : r)) }
  ok(R.auditMultiYear(db, { reportCode: 'pl', period: P, years: 4, result: huaiCol }).problems.some((p) => p.code === 'MULTI_YEAR_COLUMN_MISMATCH'), '某一列被改 → MULTI_YEAR_COLUMN_MISMATCH')
  const huaiPer = { ...m, periods: [P, R.shiftPeriod(P, -11), R.shiftPeriod(P, -24), R.shiftPeriod(P, -36)] }
  ok(R.auditMultiYear(db, { reportCode: 'pl', period: P, years: 4, result: huaiPer }).problems.some((p) => p.code === 'MULTI_YEAR_PERIODS_BAD'), '期间被挪一个月 → MULTI_YEAR_PERIODS_BAD')
  ok(R.auditMultiYear(db, { reportCode: 'pl', period: P, years: 4 }).ok, '不注入时回到通过')

  // MULTI_YEAR_LINE_MISSING（`multiYearReport` 里那条 500："某一期缺了第 N 行"）
  // 独立复核问"这条有没有断言覆盖 / 能不能造出来"。答案要写成**可执行的东西**，不能只写注释
  // （注释不会红，也不会在别人改坏时出声）：
  //   每一期的行集合都由**同一份** `report_lines` 定义推出 —— `computeReport` 对定义里的每一行
  //   都必给一个 row（没有发生额就记 0，不是缺行），而这份定义**与期间无关**
  //   ⇒ 各期的 `line_code` 集合恒等 ⇒ 那条分支在当前结构下**没有构造路径**。
  // 这条断言就是"为什么不可达"的证明，同时也是**未来它的守卫**：一旦有人让行集合随期间变化
  // （那正是这条 500 想拦的场景），它会变红，而 MULTI_YEAR_LINE_MISSING 也就变得可达了。
  // 结论：**无可构造路径 ⇒ 无断言覆盖**（此句已同步给复核；设计稿由另一位 worker 持有，未擅改）。
  {
    const sets = R.multiYearPeriods(P, 4).map((c) => R.computeReport(db, { reportCode: 'pl', period: c.period }).rows.map((r) => r.line_code).sort().join(','))
    ok(new Set(sets).size === 1,
      '各期行集合恒等（⇒ MULTI_YEAR_LINE_MISSING 无构造路径：行定义与期间无关，没有发生额记 0 而不是缺行）',
      `4 期里出现了 ${new Set(sets).size} 种行集合`)
  }

  // =========================================================================
  section(`M6 导出：CSV 与 XLSX 都能并列多年，且与 mode / range 互斥（${ind}）`)
  // =========================================================================
  const csv = R.exportReport(db, { reportCode: 'pl', period: P, years: 3, generatedAt: 'FIXED' })
  const lines = String(csv.content).replace(/^\uFEFF/, '').split('\r\n')
  eq('表头 == columns 的 label', lines[0].split(',').join('|'), m.columns.slice(0, 5).map((c) => c.label).join('|').replace(/\|amount_lag.*/, ''))
  ok(lines.some((l) => l.startsWith('# 同期多年并列：')), '末尾元信息里写清并列了哪几期')
  eq('文件名带 _multi3', csv.filename, `pl_${P}_multi3.csv`)
  eq('导出结果自报 years / periods', [csv.years, csv.periods], [3, expect(3)])
  const xl = R.exportReport(db, { reportCode: 'pl', period: P, years: 3, format: 'xlsx', generatedAt: 'FIXED' })
  ok(Buffer.isBuffer(xl.content) && xl.content.length > 100, 'xlsx 也能导（同一份 result / 同一份列定义）')
  throws(() => R.exportReport(db, { reportCode: 'pl', period: P, years: 3, mode: 'previous' }), 'BAD_EXPORT_OPTIONS', 'years 与 mode 同时给 → 明确拒绝（不静默选一个）')
  throws(() => R.exportReport(db, { reportCode: 'pl', period: P, years: 3, range: 'ytd' }), 'BAD_EXPORT_OPTIONS', 'years 与 range 同时给 → 明确拒绝')

  // =========================================================================
  section(`M7 明写"没做"的三件事（${ind}）`)
  // =========================================================================
  // ① 任意跨年窗口：没有这个入口（改了也不可能"顺手"生效）——期间序列永远是 12 的整数倍
  ok(R.multiYearPeriods(P, 3).every((x) => Number(x.period.slice(0, 4)) === Number(P.slice(0, 4)) - x.k), '① 期间序列永远是"往前整年"，没有任意窗口的入口')
  // ② 利润分配跨年还原：不在这条路径上（本函数连 annual 模块都不 import）
  ok(!/annual/.test(fs.readFileSync(path.join(ROOT, 'server/lib/report.js'), 'utf8').split('六之二之二')[1]?.split('六之三')[0] || ''), '② 同期多年对比的实现里不碰年结/分配')
  // ③ 年度报表同比列：列只有"各期金额"，没有同比/环比列
  ok(!m.columns.some((c) => /同比|环比|diff|ratio/.test(c.key)), '③ 列里没有同比/环比列（那是比较功能的活，本批不重复做）')

  db.close()
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`同期多年对比（实跑 ${ran.length ? ran.join('/') : '没有库跑到'}）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
process.exit(fail === 0 ? 0 : 1)
