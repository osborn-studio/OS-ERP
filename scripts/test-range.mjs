/**
 * ============================================================================
 * 文件标识：scripts/test-range.mjs ｜ 测试：批次 P：报表体系纵深之三（本年累计 · 自定义对比期 · 列定义唯一化）
 * ============================================================================
 * 【职责】测试：批次 P：报表体系纵深之三（本年累计 · 自定义对比期 · 列定义唯一化）
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
 * 批次 P：报表体系纵深之三（本年累计 · 自定义对比期 · 列定义唯一化）
 *
 * 这一批补的是「报表只能看"这一期"和"上一期"」：
 *   · **本年累计**：标准利润表的第二列（"本期金额 / 本年累计金额"），
 *     以及"从年初到现在到底做了多少"这个唯一有意义的年度口径；
 *   · **自定义对比期**：环比只能比上一个月、同比只能比去年同月，
 *     而"3 月改了一次促销，我想拿 10 月和 2 月比"这类问题两者都答不了；
 *   · **列定义唯一化**：此前 CSV 的列名写在服务端、表头写在 TSX ——
 *     两处定义，迟早只改一处（而"文件和屏幕的列名不一样"没有人会去核对）。
 *
 * 本文件按**判据**写，不按接口写。四条判据：
 *   ① 累计的区间**只由 `resolveRange` 算**，起点必须是本年 1 月、终点必须就是本期；
 *   ② 累计列必须**逐行等于"本年 1 月至本期逐月各算一次再相加"** ——
 *      两条独立路径互证（一个按区间筛凭证、一个按月筛），这是本批最硬的一条；
 *   ③ 本期列**不受累计影响**（加一列不该改动原来那一列）；
 *   ④ 列只有**一个出处**：CSV 的表头与页面的表头都来自 `result.columns`。
 *
 * 第五条判据是"不许让同一件事出现第二个真值"的延续：
 *   自定义基期必须早于本期（拿未来的期间当基期，差额符号与"增长"的直觉相反）；
 *   时点口径（资产负债表）**没有**累计这回事，显式 409 而不是静默当成单期。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-range.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：自造的凭证在 **2024 年**（演示数据在 2026 年，
 * 且 2024 早于任何期初登记，所以自造年度天然从 0 起算，累计可以手算核对），
 * 全部写操作包在 `BEGIN … ROLLBACK` 里；R9 断言真表**一行都不多**。
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
const actor = { id: null, name: 'test-range' }
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

console.log(`=== 报表纵深之三测试（本年累计 / 自定义对比期 / 列定义唯一）（${INDUSTRY}） ===`)

const periods = R.availablePeriods(db)
const busy = periods.find((p) => p.posted_count > 0)
if (!busy) {
  console.log('  \x1b[31m✗\x1b[0m 演示库没有任何已过账凭证，无法测试（先跑 reseed）')
  process.exit(1)
}
const P = busy.period

const before = {
  vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
  periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
  lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
  opening: db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances').get().c
}

// ===========================================================================
// R1 区间的起止**只由 `resolveRange` 算**
// ===========================================================================
section('R1 区间解析（起点必须是本年 1 月，终点必须就是本期）')
{
  const y = P.slice(0, 4)
  const r = R.resolveRange(db, { period: P, range: 'ytd' })
  eq(`ytd 起点 = 本期所在年度的 1 月`, r.from, `${y}-01`)
  eq('ytd 终点 = 本期', r.to, P)
  eq('ytd 的 is_range 为真', r.is_range, true)
  eq('会计年度取期间前 4 位（与年结同一口径）', r.year, Number(y))

  const jan = R.resolveRange(db, { period: `${y}-01`, range: 'ytd' })
  eq(`${y}-01 的累计区间是"单月"（起点 = 终点）`, [jan.from, jan.to], [`${y}-01`, `${y}-01`])

  // 跨年：2027-03 的"本年"是 2027，**不往回跨**
  const cross = R.resolveRange(db, { period: '2027-03', range: 'ytd' })
  eq('跨年时起点是新年度的 1 月（不退到上年 12 月）', [cross.from, cross.to], ['2027-01', '2027-03'])

  eq('不指定区间时窗口 = 本期（from = to）', [R.resolveRange(db, { period: P }).from, R.resolveRange(db, { period: P }).is_range], [P, false])
  eq('不指定区间时 mode 为空', R.resolveRange(db, { period: P }).mode, null)
  throws(() => R.resolveRange(db, { period: P, range: 'last3' }), 'BAD_RANGE_MODE', '非法区间模式抛 BAD_RANGE_MODE（不静默退回单期）')
  throws(() => R.resolveRange(db, { period: '2026-13', range: 'ytd' }), 'BAD_PERIOD', '非法期间抛 BAD_PERIOD')
  eq('区间模式可由 meta 读出（界面据此渲染开关）', R.meta(db).range_modes.map((x) => x.value), ['', 'ytd'])
}

// ===========================================================================
// R2 时点口径**没有**累计这回事（显式拦掉，不静默当成单期）
// ===========================================================================
section('R2 时点口径闸门（资产负债表 + 本年累计 = 409）')
{
  throws(() => R.computeReport(db, { reportCode: 'bs', period: P, range: 'ytd' }), 'RANGE_NOT_APPLICABLE', '资产负债表 + ytd → RANGE_NOT_APPLICABLE')
  try {
    R.computeReport(db, { reportCode: 'bs', period: P, range: 'ytd' })
  } catch (e) {
    eq('闸门的 HTTP 码是 409（不是 500）', e.http, 409)
    eq('错误里带着口径与期间，便于直接定位', [e.detail.report_code, e.detail.basis], ['bs', 'balance'])
  }
  ok(!!R.computeReport(db, { reportCode: 'bs', period: P }).rows.length, '不带 ytd 的资产负债表仍然正常')
  ok(!!R.computeReport(db, { reportCode: 'pl', period: P, range: 'ytd' }).rows.length, '利润表 + ytd 正常')
  ok(!!R.computeReport(db, { reportCode: 'cf', period: P, range: 'ytd' }).rows.length, '现金流量表 + ytd 正常')
  eq('「哪些口径支持累计」写在 meta 里（界面据此禁用开关）',
    R.meta(db).range_modes.find((x) => x.value === 'ytd').applicable_basis, ['amount', 'cash_flow'])

  // 「时点口径没有累计」的**机械原因**：区间取数对象里压根没有"余额"这两个字段
  // （是 `null` 而不是 0）。若闸门被摘掉，`computeReport` 会把 `null` 当 0 加起来，
  // 得到一张**全 0 的资产负债表** —— 而它资产 = 负债 + 权益，**平得完美无缺**，
  // 现有任何一条探针都不会响。所以这件事只能靠闸门拦，不能靠"看起来不对"。
  const rv = R.subjectRangeMovements(db, { from: `${P.slice(0, 4)}-01`, to: P })
  ok(rv.rows.every((r) => r.closing_signed === null), '区间取数里每个科目的 closing_signed 都是 null（区间没有"期末余额"这件事）')
  ok(rv.rows.every((r) => r.opening_signed === null), '区间取数里每个科目的 opening_signed 也都是 null')
  eq('区间结果的 opening / closing 都是 null（不是 0 —— 0 会让误用安静地算出一份"看起来对"的表）', [rv.opening, rv.closing], [null, null])
  ok(!rv.rows.some((r) => 'total_signed' in r), '区间结果的科目行里没有"余额"型字段')
}

// ===========================================================================
// R3 累计 = 本年逐月相加（**两条独立路径互证**）
// ===========================================================================
section('R3 累计 = 逐月各算一次再相加（对三张表里能累计的两张都验）')
{
  const y = P.slice(0, 4)
  let checkedRows = 0
  for (const code of ['pl', 'cf']) {
    const got = R.computeReport(db, { reportCode: code, period: P, range: 'ytd' })
    const sums = new Map()
    const months = []
    for (let m = `${y}-01`; m <= P; m = shift(m)) {
      months.push(m)
      for (const r of R.computeReport(db, { reportCode: code, period: m }).rows) {
        sums.set(r.line_code, money((sums.get(r.line_code) || 0) + money(r.amount)))
      }
    }
    const bad = got.rows.filter((r) => !near(r.ytd_amount, sums.get(r.line_code) ?? 0))
    ok(bad.length === 0, `${code}：累计逐行 = ${months.length} 个月逐月相加（不符 ${bad.length} 行）`,
      bad.slice(0, 3).map((x) => `${x.line_name}: 累计 ${x.ytd_amount} ≠ 逐月 ${sums.get(x.line_code)}`))
    checkedRows += got.rows.length

    // 本期列**不受累计影响** —— 加一列不该改动原来那一列
    const solo = R.computeReport(db, { reportCode: code, period: P })
    const soloBy = new Map(solo.rows.map((r) => [r.line_code, money(r.amount)]))
    const drift = got.rows.filter((r) => !near(r.amount, soloBy.get(r.line_code)))
    ok(drift.length === 0, `${code}：加了累计列之后本期列一个数都没变（不符 ${drift.length} 行）`, drift.slice(0, 3).map((x) => x.line_name))
  }
  ok(checkedRows > 0, `两张表共核对 ${checkedRows} 个行次的累计`)

  // 1 月的累计必须等于 1 月的本期（起点 = 终点时，累计就是这一期）
  const janPl = R.computeReport(db, { reportCode: 'pl', period: `${y}-01`, range: 'ytd' })
  const janSolo = R.computeReport(db, { reportCode: 'pl', period: `${y}-01` })
  const janBad = janPl.rows.filter((r) => !near(r.ytd_amount, janSolo.rows.find((x) => x.line_code === r.line_code).amount))
  ok(janBad.length === 0, `${y}-01 的累计 = 该月的本期（单月窗口，累计退化成同一列）`, janBad.slice(0, 3).map((x) => x.line_name))
}

/** 期间 +1 个月（测试**自己**算，不走被测代码 —— 否则"区间算错"会一起把对照也算错） */
function shift(p) {
  const [yy, mm] = p.split('-').map(Number)
  const t = yy * 12 + (mm - 1) + 1
  return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`
}

// ===========================================================================
// R4 自定义对比期
// ===========================================================================
section('R4 自定义对比期（基期必须给、必须早于本期）')
{
  const y = Number(P.slice(0, 4))
  const target = `${y}-02` // 一个"不是上期、也不是去年同月"的基期
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'custom' }), 'COMPARE_BASE_REQUIRED', 'custom 不给基期 → COMPARE_BASE_REQUIRED')
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'custom', basePeriod: shift(P) }), 'COMPARE_BASE_AFTER_CURRENT', '基期晚于本期 → COMPARE_BASE_AFTER_CURRENT')
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'custom', basePeriod: P }), 'COMPARE_BASE_AFTER_CURRENT', '基期等于本期 → 同样拒（差值恒为 0，没有比较的意义）')

  const c = R.compareReport(db, { reportCode: 'pl', period: P, mode: 'custom', basePeriod: target })
  eq('自定义基期被如实回报', c.base_period, target)
  eq('模式仍是 custom（不是被偷偷当成环比）', c.mode, 'custom')

  // 自定义基期**不是**一条新的取数路径：基期列必须等于"单独打开基期"
  const soloBase = R.computeReport(db, { reportCode: 'pl', period: target })
  const baseBy = new Map(soloBase.rows.map((r) => [r.line_code, money(r.amount)]))
  const badBase = c.rows.filter((r) => !near(r.base_amount, baseBy.get(r.line_code)))
  ok(badBase.length === 0, '自定义基期的列 = 单独打开该期（同一个实现）', badBase.slice(0, 3).map((x) => x.line_name))
  const badDiff = c.rows.filter((r) => !near(r.diff, r.amount - r.base_amount))
  ok(badDiff.length === 0, '差额仍然只由两列相减得出', badDiff.slice(0, 3).map((x) => x.line_name))

  // **同一条判据的两种问法必须得到同一个答案**：
  // custom(basePeriod = 上期) 与 previous 应当完全一致 —— 否则"比较模式"有了两个真值。
  const prev = R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous' })
  const asCustom = R.compareReport(db, { reportCode: 'pl', period: P, mode: 'custom', basePeriod: prev.base_period })
  eq('custom(上期) 与 previous 的基期一致', asCustom.base_period, prev.base_period)
  eq('custom(上期) 与 previous 的逐行金额一致',
    asCustom.rows.map((r) => [r.line_no, r.amount, r.base_amount, r.diff]),
    prev.rows.map((r) => [r.line_no, r.amount, r.base_amount, r.diff]))

  // 累计 + 比较：**明确不做**，而不是静默忽略
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous', range: 'ytd' }), 'RANGE_COMPARE_UNSUPPORTED', '累计 + 比较 → RANGE_COMPARE_UNSUPPORTED（不静默忽略）')
}

// ===========================================================================
// R5 列**只有一个出处**
// ===========================================================================
section('R5 列定义唯一化（CSV 与页面都来自 result.columns）')
{
  const cases = [
    { name: '单期', r: R.computeReport(db, { reportCode: 'pl', period: P }), keys: ['line_no', 'line_name', 'amount'] },
    { name: '累计', r: R.computeReport(db, { reportCode: 'pl', period: P, range: 'ytd' }), keys: ['line_no', 'line_name', 'amount', 'ytd_amount'] },
    { name: '比较', r: R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous' }), keys: ['line_no', 'line_name', 'amount', 'base_amount', 'diff', 'ratio'] }
  ]
  for (const c of cases) {
    eq(`${c.name}的列键与顺序`, (c.r.columns || []).map((x) => x.key), c.keys)
    ok((c.r.columns || []).every((x) => x.label && x.kind), `${c.name}的每一列都有中文名与 kind（界面不猜格式）`)
    // 结果里的 columns 必须**逐字**等于 `columnsOf` 在同样参数下的输出 ——
    // 否则"唯一出处"就只是口号（结果自己又维护了一份）
    const args = c.keys.includes('ytd_amount')
      ? { withRange: true, period: P, rangeFrom: R.resolveRange(db, { period: P, range: 'ytd' }).from, rangeTo: P }
      : c.keys.includes('base_amount')
        ? { withCompare: true, period: P, basePeriod: R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous' }).base_period }
        : { period: P }
    eq(`${c.name}的 columns 逐字等于 columnsOf()`, c.r.columns, R.columnsOf(args))
  }
  ok(!R.columnsOf({ period: P }).some((x) => x.key === 'ytd_amount'), '不请求累计就不出现累计列')
  eq('列的中文名里带期间（"本期金额"必须说清是哪一期）', R.columnsOf({ period: P })[2].label, `本期金额(${P})`)
  eq('percent 列的格式由 kind 决定', R.columnValue({ ratio: 12.3456 }, { key: 'ratio', kind: 'percent' }), '12.35')
  eq('percent 为 null 时留空（不写 NaN）', R.columnValue({ ratio: null }, { key: 'ratio', kind: 'percent' }), '')
  eq('money 列为 undefined 时留空（不写 NaN）', R.columnValue({ amount: undefined }, { key: 'amount', kind: 'money' }), '')
}

// ===========================================================================
// R6 导出即视图（含累计列）
// ===========================================================================
section('R6 导出即视图（逐行逐列 = 结果对象；含累计列时列名带区间）')
{
  const y = P.slice(0, 4)
  const cases = [
    { name: '单期', r: R.computeReport(db, { reportCode: 'pl', period: P }), out: R.exportReport(db, { reportCode: 'pl', period: P }) },
    { name: '累计', r: R.computeReport(db, { reportCode: 'cf', period: P, range: 'ytd' }), out: R.exportReport(db, { reportCode: 'cf', period: P, range: 'ytd' }) },
    { name: '比较', r: R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous' }), out: R.exportReport(db, { reportCode: 'pl', period: P, mode: 'previous' }) }
  ]
  for (const c of cases) {
    const rows = parseCSV(c.out.content)
    eq(`${c.name}导出的表头逐字 = columns 的中文名`, rows[0], c.r.columns.map((x) => x.label))
    const dataRows = rows.slice(1).filter((x) => x.length > 1) // 去掉末尾空行
    eq(`${c.name}导出的数据行数 = 报表行数`, dataRows.length, c.r.rows.length)
    let bad = null
    for (let i = 0; i < c.r.rows.length; i += 1) {
      const want = c.r.columns.map((col) => R.columnValue(c.r.rows[i], col))
      const got = dataRows[i]
      if (JSON.stringify(want) !== JSON.stringify(got)) bad = `第 ${i + 1} 行：期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`
    }
    ok(bad === null, `${c.name}：每一个单元格都等于结果对象按列取值`, bad)
    ok(c.out.content.startsWith('\uFEFF'), `${c.name}：导出带 BOM（否则 Excel 打开中文全乱）`)
    ok(!/NaN|Infinity|undefined/.test(c.out.content), `${c.name}：内容里不出现 NaN / Infinity / undefined`)
  }
  const ytdCsv = R.exportReport(db, { reportCode: 'cf', period: P, range: 'ytd' })
  ok(ytdCsv.content.includes(`本年累计(${y}-01~${P})`), '累计导出的列名里带区间（拿去开会也能看出是哪一段）')
  eq('累计导出的 ASCII 文件名带 _ytd', ytdCsv.filename, `cf_${P}_ytd.csv`)
  eq('累计导出回报了区间端点', [ytdCsv.range_from, ytdCsv.range_to], [`${y}-01`, P])
  eq('报表口径是时点时不报区间（导出被 409 拦住）',
    (() => { try { R.exportReport(db, { reportCode: 'bs', period: P, range: 'ytd' }); return 'no-throw' } catch (e) { return e.code } })(),
    'RANGE_NOT_APPLICABLE')
}

// ===========================================================================
// R7 区间自证：四条探针**各抓一种失效方式**（互不重叠）
// ===========================================================================
section('R7 区间自证（起点 / 终点 / 累计值 / 本期列 —— 四条探针各守一处）')
{
  const y = P.slice(0, 4)
  const good = R.computeReport(db, { reportCode: 'pl', period: P, range: 'ytd' })
  const a0 = R.auditRange(db, { reportCode: 'pl', period: P, range: 'ytd' })
  ok(a0.ok, `干净数据上区间自证通过（核对 ${a0.months_checked} 个月 × ${a0.rows_checked} 行）`, a0.problems.map((x) => x.code))
  eq('区间自证回报了它实际核对的窗口', [a0.from, a0.to], [`${y}-01`, P])

  // ① 起点不是本年 1 月
  const badFrom = { ...good, range_meta: { ...good.range_meta, from: `${y}-02` } }
  const a1 = R.auditRange(db, { reportCode: 'pl', period: P, range: 'ytd', result: badFrom })
  eq('① 起点不是 1 月 → 只响 RANGE_FROM_NOT_JAN', a1.problems.map((x) => x.code), ['RANGE_FROM_NOT_JAN'])

  // ② 终点不是本期
  const badTo = { ...good, range_meta: { ...good.range_meta, to: `${y}-09` } }
  const a2 = R.auditRange(db, { reportCode: 'pl', period: P, range: 'ytd', result: badTo })
  eq('② 终点不是本期 → 只响 RANGE_TO_NE_PERIOD', a2.problems.map((x) => x.code), ['RANGE_TO_NE_PERIOD'])

  // ③ 累计值不对（注入 1234.56 —— **与被测偏差不同量级**，免得两个偏差互相抵消、
  //    变成"探针正确地没响而断言假红"，那是批次 N 踩过的坑）
  const badSum = { ...good, rows: good.rows.map((r) => ({ ...r, ytd_amount: money((r.ytd_amount || 0) + 1234.56) })) }
  const a3 = R.auditRange(db, { reportCode: 'pl', period: P, range: 'ytd', result: badSum })
  eq('③ 累计值被算错 → 只响 RANGE_NE_SUM_OF_MONTHS', a3.problems.map((x) => x.code), ['RANGE_NE_SUM_OF_MONTHS'])
  ok(a3.problems[0].message.includes('逐月相加'), '③ 的错误信息点明"与逐月相加对不上"（而不是泛泛的"不一致"）')

  // ④ 加累计列时把**本期列**也改了
  const badCur = { ...good, rows: good.rows.map((r) => ({ ...r, amount: money(Number(r.amount) + 7.77) })) }
  const a4 = R.auditRange(db, { reportCode: 'pl', period: P, range: 'ytd', result: badCur })
  eq('④ 本期列被顺手改掉 → 只响 RANGE_CURRENT_MISMATCH', a4.problems.map((x) => x.code), ['RANGE_CURRENT_MISMATCH'])

  // ⑤ 时点口径不该有区间
  const a5 = R.auditRange(db, { reportCode: 'bs', period: P, range: 'ytd' })
  eq('⑤ 时点口径 → RANGE_BASIS_NOT_APPLICABLE', a5.problems.map((x) => x.code), ['RANGE_BASIS_NOT_APPLICABLE'])

  // 四条探针**互不重叠**：这四条 eq 已各自断言"只有一条响" ——
  // 换句话说，任意一条探针单独失效（被摘掉）都会留下一个**没有别人能补**的洞。

  // 报表域的整体自证必须把它带上 —— 一个只在用户点"累计"时才跑的探针等于不跑的探针
  const au = R.auditReport(db, { period: P })
  ok(au.range_checked > 0, `auditReport 每次都自动核对本年累计（本次核对 ${au.range_checked} 组）`)
  ok(!au.problems.some((p) => p.code === 'YTD_NOT_SOUND'), '干净数据上不响 YTD_NOT_SOUND', au.problems.map((x) => x.code))
}

// ===========================================================================
// R8 在**自造数据**上手算核对累计（不借演示数据做实验）
// ===========================================================================
section('R8 自造 2024 年手算核对：累计确实是从"1 月起"加总')
{
  const p2024Before = db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE substr(period,1,4)='2024'").get().c
  inTx('R8', () => {
    let seq = 91000
    const mk = (period, date, lines, label) => {
      seq += 1
      const v = A.persistVoucher(db, {
        biz_type: 'test_range', source_type: 'test_range', source_id: seq, source_doc_no: label,
        voucher_date: date, period, lines, label
      }, { actor })
      A.postVoucher(db, { id: v.id, actor })
    }
    // 2024-03 收入 1000 / 2024-04 收入 250 / 2024-05 冲回 100
    mk('2024-03', '2024-03-15', [
      { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
      { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
    ], 'TR-03')
    mk('2024-04', '2024-04-15', [
      { seq: 1, summary: '收现', direction: 'debit', amount: 250, subject_code: '1002' },
      { seq: 2, summary: '收入', direction: 'credit', amount: 250, subject_code: '6001' }
    ], 'TR-04')
    mk('2024-05', '2024-05-15', [
      { seq: 1, summary: '退回', direction: 'debit', amount: 100, subject_code: '6001' },
      { seq: 2, summary: '付款', direction: 'credit', amount: 100, subject_code: '1002' }
    ], 'TR-05')

    const revAt = (p, range) => {
      const rep = R.computeReport(db, { reportCode: 'pl', period: p, range })
      const row = rep.rows.find((x) => x.line_code === 'PL_REVENUE')
      return range ? row.ytd_amount : row.amount
    }
    okNear(revAt('2024-03'), 1000, '2024-03 本期收入 1000')
    okNear(revAt('2024-04'), 250, '2024-04 本期收入 250')
    okNear(revAt('2024-05'), -100, '2024-05 本期收入 −100（红冲）')
    okNear(revAt('2024-03', 'ytd'), 1000, '累计到 03 = 1000（1、2 月没有发生额）')
    okNear(revAt('2024-04', 'ytd'), 1250, '累计到 04 = 1000 + 250 = 1250')
    okNear(revAt('2024-05', 'ytd'), 1150, '累计到 05 = 1000 + 250 − 100 = 1150')
    // **反面**：如果累计被写成"本期 × 月数"或"从任意一个月起"，这几个数都会不同
    ok(revAt('2024-05', 'ytd') !== revAt('2024-05'), '累计与本期是两个不同的数（不是把本期原样搬过来）')
    ok(revAt('2024-05', 'ytd') !== revAt('2024-04', 'ytd'), '累计随月份推进（不是把某一期复制过来）')
    okNear(revAt('2024-01', 'ytd'), 0, '累计到 2024-01 = 0（当年 1 月之前没有发生额）')

    const a = R.auditRange(db, { reportCode: 'pl', period: '2024-05', range: 'ytd' })
    ok(a.ok, '自造数据上区间自证通过', a.problems.map((x) => x.code))

    // ---- 反面教材：一张**未过账**（draft）凭证 ----
    // "只有 posted 计入"是本项目的一条基本口径（draft 是"生成出来了但还没进账"）。
    // 这里必须**直接断言这条性质**，不能只靠"累计 = 逐月相加"：
    // 那条探针的两条路径**读的是同一份取数 SQL**，所以取数条件错时它们会**同步**错、
    // 仍然一致 —— 探针于是不响（批次 P 反例 F 实测）。
    // 换句话说：**"两条路径互证"只能覆盖"聚合逻辑错"，覆盖不了"取数条件错"。**
    //
    // ⚠️ 断言的**作用域必须与造数的范围一致**：这里只断言"加了草稿之后，
    //    自造期间上的数一个都没变"，**不**去断言整个 `auditReport` 通过 ——
    //    自造凭证早于演示库的期初登记（2026-05），于是它会被随后的期间一并滚进来，
    //    让那些期间自身的状态（例如"已关账但没结转"）跟着现形。
    //    那是**演示库自己的事**，不是本批要测的东西（food 库上实测到过这一点）。
    const beforeDraft = {
      period: R.computeReport(db, { reportCode: 'pl', period: '2024-06' }).rows.map((r) => money(r.amount)),
      ytd: R.computeReport(db, { reportCode: 'pl', period: '2024-06', range: 'ytd' }).rows.map((r) => money(r.ytd_amount)),
      mv: R.subjectBalances(db, { period: '2024-06' }).movement.total_debit,
      rng: R.subjectRangeMovements(db, { from: '2024-01', to: '2024-06' }).movement.total_debit
    }
    seq += 1
    const draft = A.persistVoucher(db, {
      biz_type: 'test_range', source_type: 'test_range', source_id: seq, source_doc_no: 'TR-DRAFT',
      voucher_date: '2024-06-15', period: '2024-06',
      lines: [
        { seq: 1, summary: '草稿', direction: 'debit', amount: 5000, subject_code: '1002' },
        { seq: 2, summary: '草稿', direction: 'credit', amount: 5000, subject_code: '6001' }
      ],
      label: 'TR-DRAFT'
    }, { actor })
    eq('草稿凭证的状态确实是 draft（否则下面几条是假过）',
      db.prepare('SELECT status FROM vouchers WHERE id=?').get(draft.id).status, 'draft')
    eq('加一张 5000 的草稿后，本期的任何一个数都没变',
      R.computeReport(db, { reportCode: 'pl', period: '2024-06' }).rows.map((r) => money(r.amount)), beforeDraft.period)
    eq('加草稿后，累计的任何一个数也没变（累计不是"把草稿也算上"）',
      R.computeReport(db, { reportCode: 'pl', period: '2024-06', range: 'ytd' }).rows.map((r) => money(r.ytd_amount)), beforeDraft.ytd)
    okNear(R.subjectBalances(db, { period: '2024-06' }).movement.total_debit, beforeDraft.mv, '科目余额表的本期发生额不受草稿影响')
    okNear(R.subjectRangeMovements(db, { from: '2024-01', to: '2024-06' }).movement.total_debit, beforeDraft.rng, '区间发生额不受草稿影响')
    // 手算的独立期望（不依赖"变没变"这种相对断言）
    okNear(R.subjectRangeMovements(db, { from: '2024-01', to: '2024-06' }).movement.total_debit, 1350, '区间发生额手算 = 1000 + 250 + 100（草稿的 5000 不算）')
    okNear(revAt('2024-06'), 0, '未过账凭证不进本期报表（draft 是"生成出来了但还没进账"）')
    okNear(revAt('2024-06', 'ytd'), 1150, '未过账凭证同样不进累计')
    A.voidVoucher(db, { id: draft.id, reason: '测试：清理草稿', actor })

    // 同一份数据下"本年累计"也不该越界到别的年度
    okNear(revAt('2024-05', 'ytd'), 1150, '累计不会把 2026 年（演示年度）的发生额算进来')
    const y2026 = R.computeReport(db, { reportCode: 'pl', period: P, range: 'ytd' })
    eq('2026 年的累计窗口与 2024 年互不相干', y2026.range_meta.from, `${P.slice(0, 4)}-01`)
  })
  // 事务回滚的真实证据（不是 `ok(true, ...)` —— 恒真的断言等于没有）
  eq('自造凭证一张都没留下',
    db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='test_range'").get().c, 0)
  eq('自造的 2024 期间登记也已回滚',
    db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE substr(period,1,4)='2024'").get().c, p2024Before)
}

// ===========================================================================
// R9 无副作用
// ===========================================================================
section('R9 无副作用（真表一行都不多）')
{
  const after = {
    vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
    lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
    opening: db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances').get().c
  }
  eq('凭证表行数不变', after.vouchers, before.vouchers)
  eq('分录表行数不变', after.entries, before.entries)
  eq('期间表行数不变', after.periods, before.periods)
  eq('报表行定义不变', after.lines, before.lines)
  eq('期初登记不变', after.opening, before.opening)
  eq('自造凭证一张都没留下', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='test_range'").get().c, 0)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
